/**
 * project-context.ts — Local project context extraction service.
 *
 * Implements ContextPort for the harness knowledge library.
 *
 * Invariants:
 * - Reads only local project documentation, manifests, card specs, and git status.
 * - Never hallucinates project goals: missing or unclear goals are marked empty/unknown.
 * - Strict size budget: reads at most 32KB per file.
 * - Strict token budget: keeps total extracted context compact (< 2,000 tokens).
 * - Security & Privacy boundary: strictly excludes secrets, .env*, credentials,
 *   private keys, and rejects symlinks pointing outside projectRoot.
 * - Deterministic caching & invalidation: keyed by HEAD / status / mtimes + cardId.
 * - Strictly local: never leaks project context to Git URL registries or R2 uploads.
 */

import {
  existsSync,
  statSync,
  lstatSync,
  realpathSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import {
  join,
  resolve,
  relative,
  basename,
  isAbsolute,
} from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  withPortTimeout,
  validateProjectContext,
  KnowledgeError,
  CancellationError,
  TimeoutError,
  type ProjectContext,
  type ContextPort,
  type PortOptions,
} from "./contracts.ts";

// ============================================================================
// Constants & Budgets
// ============================================================================

export const DEFAULT_MAX_FILE_BYTES = 32 * 1024; // 32KB per file
export const DEFAULT_MAX_TOTAL_TOKENS = 1800; // Under 2,000 tokens budget

const SENSITIVE_DIR_NAMES = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".gpg",
  ".secrets",
  ".credentials",
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "out",
  ".next",
  ".nuxt",
  ".output",
  "vendor",
  "coverage",
  ".nyc_output",
  ".cache",
  ".turbo",
  "venv",
  ".venv",
  "env",
  "__pycache__",
]);

// ============================================================================
// Security & Path Safety Guards (AC-3)
// ============================================================================

/**
 * Checks if a relative or absolute path matches sensitive files or credentials.
 * Strictly excludes:
 * - .env* (.env, .env.local, .env.production, etc.)
 * - *.pem, *.key, *.pfx, *.p12, *.crt, *.cer, *.keystore
 * - id_rsa*, id_ed25519*, id_ecdsa*, id_dsa*
 * - credentials files, auth tokens, netrc, npmrc
 * - files inside .ssh, .aws, etc.
 */
export function isSecretOrDisallowedPath(relOrAbsPath: string): boolean {
  const norm = relOrAbsPath.replace(/\\/g, "/");
  const base = basename(norm).toLowerCase();

  // 1. .env files
  if (base === ".env" || base.startsWith(".env.")) {
    return true;
  }

  // 2. Private keys, certificates, keystores
  if (
    base.endsWith(".pem") ||
    base.endsWith(".key") ||
    base.endsWith(".pfx") ||
    base.endsWith(".p12") ||
    base.endsWith(".pkcs12") ||
    base.endsWith(".crt") ||
    base.endsWith(".cer") ||
    base.endsWith(".der") ||
    base.endsWith(".keystore") ||
    base.endsWith(".jks")
  ) {
    return true;
  }

  // 3. SSH / Crypto identity keys
  if (
    base.startsWith("id_rsa") ||
    base.startsWith("id_ed25519") ||
    base.startsWith("id_ecdsa") ||
    base.startsWith("id_dsa")
  ) {
    return true;
  }

  // 4. Credentials, tokens, netrc, npmrc
  if (
    base === "credentials" ||
    base === "credentials.json" ||
    base === "credentials.yaml" ||
    base === "credentials.yml" ||
    base === "token" ||
    base === "token.json" ||
    base === "tokens.json" ||
    base === "auth.json" ||
    base === ".netrc" ||
    base === ".npmrc" ||
    base === ".pypirc" ||
    /^client_secrets?.*\.json$/i.test(base) ||
    /^credentials?(\.(json|ya?ml|xml|ini|txt))?$/i.test(base) ||
    /^secrets?(\.(json|ya?ml|xml|ini|txt))?$/i.test(base) ||
    /^tokens?(\.(json|ya?ml|xml|ini|txt))?$/i.test(base) ||
    /^auth_tokens?(\.(json|ya?ml|xml|ini|txt))?$/i.test(base)
  ) {
    return true;
  }

  // 5. Sensitive directories anywhere in the path
  const parts = norm.toLowerCase().split("/");
  for (const part of parts) {
    if (SENSITIVE_DIR_NAMES.has(part)) {
      return true;
    }
  }

  return false;
}

/**
 * Validates that targetPath exists, resolves inside rootDir, is not a secret,
 * and does not escape rootDir via symlink (symlink path traversal guard).
 */
export function isSafePath(targetPath: string, rootDir: string): boolean {
  try {
    if (!existsSync(targetPath)) return false;

    // Resolve real physical paths to prevent symlink traversal escapes
    const realRoot = realpathSync(rootDir);
    const realTarget = realpathSync(targetPath);

    const rel = relative(realRoot, realTarget);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      // Symlink points outside rootDir! REJECT!
      return false;
    }

    if (isSecretOrDisallowedPath(rel)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Reads at most maxBytes (default 32KB) from a file without buffering large files in memory.
 */
export function readFileWithinBudget(filePath: string, maxBytes = DEFAULT_MAX_FILE_BYTES): string | null {
  try {
    const stat = statSync(filePath);
    const bytesToRead = Math.min(stat.size, maxBytes);
    if (bytesToRead <= 0) return "";
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(bytesToRead);
      const bytesRead = readSync(fd, buf, 0, bytesToRead, 0);
      return buf.toString("utf8", 0, bytesRead);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Fast token estimation (~4 characters per token heuristic).
 */
export function estimateContextTokens(ctx: ProjectContext): number {
  let chars = ctx.project_name.length;
  for (const s of ctx.stack) chars += s.length + 2;
  for (const g of ctx.goals) chars += g.length + 2;
  for (const d of ctx.existing_deps) chars += d.length + 2;
  for (const f of ctx.related_files) chars += f.length + 2;
  return Math.ceil(chars / 4);
}

/**
 * Enforces compact token budget (< 2,000 tokens) by pruning items progressively if needed.
 */
export function enforceTokenBudget(ctx: ProjectContext, maxTokens = DEFAULT_MAX_TOTAL_TOKENS): ProjectContext {
  let estimated = estimateContextTokens(ctx);
  if (estimated <= maxTokens) return ctx;

  const result: ProjectContext = {
    project_name: ctx.project_name,
    stack: [...ctx.stack],
    goals: ctx.goals.map((g) => (g.length > 200 ? `${g.slice(0, 197)}...` : g)),
    existing_deps: [...ctx.existing_deps],
    related_files: [...ctx.related_files],
  };

  estimated = estimateContextTokens(result);
  if (estimated <= maxTokens) return result;

  // Trim existing_deps if excessive
  if (result.existing_deps.length > 60) {
    result.existing_deps = result.existing_deps.slice(0, 60);
    estimated = estimateContextTokens(result);
    if (estimated <= maxTokens) return result;
  }

  // Trim related_files if excessive
  if (result.related_files.length > 30) {
    result.related_files = result.related_files.slice(0, 30);
    estimated = estimateContextTokens(result);
    if (estimated <= maxTokens) return result;
  }

  // Trim goals
  if (result.goals.length > 5) {
    result.goals = result.goals.slice(0, 5);
    estimated = estimateContextTokens(result);
    if (estimated <= maxTokens) return result;
  }

  // Aggressive progressive trimming if still over budget
  while (result.existing_deps.length > 20 && estimateContextTokens(result) > maxTokens) {
    result.existing_deps = result.existing_deps.slice(0, Math.floor(result.existing_deps.length * 0.8));
  }
  while (result.related_files.length > 10 && estimateContextTokens(result) > maxTokens) {
    result.related_files = result.related_files.slice(0, Math.floor(result.related_files.length * 0.8));
  }
  while (result.goals.length > 1 && estimateContextTokens(result) > maxTokens) {
    result.goals = result.goals.slice(0, result.goals.length - 1);
  }

  return result;
}

// ============================================================================
// Context Extractors (AC-1)
// ============================================================================

/**
 * Extracts project name from manifests, README, or fallback to directory basename.
 */
export function extractProjectName(projectRoot: string): string {
  // 1. package.json
  const pkgPath = join(projectRoot, "package.json");
  if (isSafePath(pkgPath, projectRoot)) {
    const content = readFileWithinBudget(pkgPath);
    if (content) {
      try {
        const parsed = JSON.parse(content);
        if (typeof parsed.name === "string" && parsed.name.trim()) {
          return parsed.name.trim();
        }
      } catch {
        // ignore parse error
      }
    }
  }

  // 2. Cargo.toml
  const cargoPath = join(projectRoot, "Cargo.toml");
  if (isSafePath(cargoPath, projectRoot)) {
    const content = readFileWithinBudget(cargoPath);
    if (content) {
      const match = content.match(/\[package\][^\[]*?name\s*=\s*["']([^"']+)["']/s);
      if (match && match[1]?.trim()) {
        return match[1].trim();
      }
    }
  }

  // 3. pyproject.toml
  const pyprojectPath = join(projectRoot, "pyproject.toml");
  if (isSafePath(pyprojectPath, projectRoot)) {
    const content = readFileWithinBudget(pyprojectPath);
    if (content) {
      const match = content.match(/name\s*=\s*["']([^"']+)["']/);
      if (match && match[1]?.trim()) {
        return match[1].trim();
      }
    }
  }

  // 4. go.mod
  const goModPath = join(projectRoot, "go.mod");
  if (isSafePath(goModPath, projectRoot)) {
    const content = readFileWithinBudget(goModPath);
    if (content) {
      const match = content.match(/^module\s+([^\s\r\n]+)/m);
      if (match && match[1]?.trim()) {
        const modName = basename(match[1].trim());
        if (modName) return modName;
      }
    }
  }

  // 5. README.md top heading
  const readmePath = join(projectRoot, "README.md");
  if (isSafePath(readmePath, projectRoot)) {
    const content = readFileWithinBudget(readmePath);
    if (content) {
      const match = content.match(/^#\s+([^\r\n]+)/m);
      if (match && match[1]?.trim()) {
        const cleanTitle = match[1].trim().replace(/^Plan:\s*/i, "").trim();
        if (cleanTitle) return cleanTitle;
      }
    }
  }

  // 6. Basename fallback
  const base = basename(resolve(projectRoot));
  return base || "unknown";
}

/**
 * Scans manifests to detect stack languages, runtimes, and frameworks.
 */
export function extractStack(projectRoot: string): string[] {
  const stack = new Set<string>();

  // Node / JavaScript / TypeScript
  const pkgPath = join(projectRoot, "package.json");
  if (isSafePath(pkgPath, projectRoot)) {
    stack.add("node");
    stack.add("javascript");

    const tsconfigPath = join(projectRoot, "tsconfig.json");
    if (isSafePath(tsconfigPath, projectRoot)) {
      stack.add("typescript");
    }

    const content = readFileWithinBudget(pkgPath);
    if (content) {
      try {
        const parsed = JSON.parse(content);
        const allDeps = {
          ...parsed.dependencies,
          ...parsed.devDependencies,
        };

        if (allDeps.typescript) stack.add("typescript");
        if (allDeps.react || allDeps["react-dom"]) stack.add("react");
        if (allDeps.next) stack.add("next.js");
        if (allDeps.vue) stack.add("vue");
        if (allDeps.nuxt) stack.add("nuxt");
        if (allDeps["@angular/core"]) stack.add("angular");
        if (allDeps.svelte) stack.add("svelte");
        if (allDeps.express) stack.add("express");
        if (allDeps.fastify) stack.add("fastify");
        if (allDeps["@nestjs/core"] || allDeps.nest) stack.add("nestjs");
        if (allDeps.electron) stack.add("electron");
        if (allDeps.tailwindcss) stack.add("tailwind");
        if (allDeps.vite) stack.add("vite");
        if (allDeps.vitest) stack.add("vitest");
        if (allDeps.jest) stack.add("jest");
        if (allDeps.graphql) stack.add("graphql");
        if (allDeps["@prisma/client"] || allDeps.prisma) stack.add("prisma");
        if (allDeps.sqlite3 || allDeps["better-sqlite3"] || allDeps["@libsql/client"]) stack.add("sqlite");
      } catch {
        // ignore parse error
      }
    }
  }

  // Rust
  const cargoPath = join(projectRoot, "Cargo.toml");
  if (isSafePath(cargoPath, projectRoot)) {
    stack.add("rust");
    const content = readFileWithinBudget(cargoPath);
    if (content) {
      if (/tokio\s*=/i.test(content)) stack.add("tokio");
      if (/axum\s*=/i.test(content)) stack.add("axum");
      if (/actix-web\s*=/i.test(content)) stack.add("actix-web");
      if (/serde\s*=/i.test(content)) stack.add("serde");
      if (/diesel\s*=/i.test(content)) stack.add("diesel");
      if (/sqlx\s*=/i.test(content)) stack.add("sqlx");
    }
  }

  // Python
  const pyprojectPath = join(projectRoot, "pyproject.toml");
  const reqsPath = join(projectRoot, "requirements.txt");
  const pipfilePath = join(projectRoot, "Pipfile");
  const setupPyPath = join(projectRoot, "setup.py");

  const isPython =
    isSafePath(pyprojectPath, projectRoot) ||
    isSafePath(reqsPath, projectRoot) ||
    isSafePath(pipfilePath, projectRoot) ||
    isSafePath(setupPyPath, projectRoot);

  if (isPython) {
    stack.add("python");
    const pyContent =
      (isSafePath(reqsPath, projectRoot) ? (readFileWithinBudget(reqsPath) ?? "") : "") +
      (isSafePath(pyprojectPath, projectRoot) ? (readFileWithinBudget(pyprojectPath) ?? "") : "");

    if (/django/i.test(pyContent)) stack.add("django");
    if (/flask/i.test(pyContent)) stack.add("flask");
    if (/fastapi/i.test(pyContent)) stack.add("fastapi");
    if (/pytest/i.test(pyContent)) stack.add("pytest");
    if (/torch|pytorch/i.test(pyContent)) stack.add("pytorch");
    if (/numpy/i.test(pyContent)) stack.add("numpy");
    if (/pandas/i.test(pyContent)) stack.add("pandas");
  }

  // Go
  const goModPath = join(projectRoot, "go.mod");
  if (isSafePath(goModPath, projectRoot)) {
    stack.add("go");
    const content = readFileWithinBudget(goModPath);
    if (content) {
      if (/gin-gonic/i.test(content)) stack.add("gin");
      if (/labstack\/echo/i.test(content)) stack.add("echo");
      if (/gofiber\/fiber/i.test(content)) stack.add("fiber");
    }
  }

  // Java / Kotlin
  const pomPath = join(projectRoot, "pom.xml");
  const gradlePath = join(projectRoot, "build.gradle");
  const gradleKtsPath = join(projectRoot, "build.gradle.kts");

  if (
    isSafePath(pomPath, projectRoot) ||
    isSafePath(gradlePath, projectRoot) ||
    isSafePath(gradleKtsPath, projectRoot)
  ) {
    stack.add("java");
    if (isSafePath(gradleKtsPath, projectRoot)) stack.add("kotlin");
  }

  // Ruby
  const gemfilePath = join(projectRoot, "Gemfile");
  if (isSafePath(gemfilePath, projectRoot)) {
    stack.add("ruby");
    const content = readFileWithinBudget(gemfilePath);
    if (content && /rails/i.test(content)) stack.add("rails");
  }

  // PHP
  const composerPath = join(projectRoot, "composer.json");
  if (isSafePath(composerPath, projectRoot)) {
    stack.add("php");
    const content = readFileWithinBudget(composerPath);
    if (content) {
      if (/laravel/i.test(content)) stack.add("laravel");
      if (/symfony/i.test(content)) stack.add("symfony");
    }
  }

  // Docker
  const dockerPath = join(projectRoot, "Dockerfile");
  const composePath = join(projectRoot, "docker-compose.yml");
  const composeYamlPath = join(projectRoot, "compose.yaml");
  if (
    isSafePath(dockerPath, projectRoot) ||
    isSafePath(composePath, projectRoot) ||
    isSafePath(composeYamlPath, projectRoot)
  ) {
    stack.add("docker");
  }

  return Array.from(stack).sort();
}

/**
 * Extracts dependency package names from manifests.
 */
export function extractDependencies(projectRoot: string): string[] {
  const deps = new Set<string>();

  // 1. package.json
  const pkgPath = join(projectRoot, "package.json");
  if (isSafePath(pkgPath, projectRoot)) {
    const content = readFileWithinBudget(pkgPath);
    if (content) {
      try {
        const parsed = JSON.parse(content);
        const sections = [
          parsed.dependencies,
          parsed.devDependencies,
          parsed.peerDependencies,
          parsed.optionalDependencies,
        ];
        for (const sec of sections) {
          if (sec && typeof sec === "object") {
            for (const key of Object.keys(sec)) {
              if (key && typeof key === "string" && !key.startsWith(".")) {
                deps.add(key);
              }
            }
          }
        }
      } catch {
        // ignore parse error
      }
    }
  }

  // 2. Cargo.toml
  const cargoPath = join(projectRoot, "Cargo.toml");
  if (isSafePath(cargoPath, projectRoot)) {
    const content = readFileWithinBudget(cargoPath);
    if (content) {
      const lines = content.split(/\r?\n/);
      let inDeps = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
          inDeps = /^\[(workspace\.)?(dependencies|dev-dependencies|build-dependencies)\]/i.test(trimmed);
          continue;
        }
        if (inDeps && trimmed && !trimmed.startsWith("#")) {
          const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=/);
          if (match && match[1]) {
            deps.add(match[1]);
          }
        }
      }
    }
  }

  // 3. requirements.txt
  const reqsPath = join(projectRoot, "requirements.txt");
  if (isSafePath(reqsPath, projectRoot)) {
    const content = readFileWithinBudget(reqsPath);
    if (content) {
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
        const match = trimmed.match(/^([a-zA-Z0-9_\-\.]+)/);
        if (match && match[1]) {
          deps.add(match[1]);
        }
      }
    }
  }

  // 4. pyproject.toml
  const pyprojectPath = join(projectRoot, "pyproject.toml");
  if (isSafePath(pyprojectPath, projectRoot)) {
    const content = readFileWithinBudget(pyprojectPath);
    if (content) {
      // Look for dependencies array: dependencies = [ "requests>=2.0", ... ]
      const arrayMatch = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
      if (arrayMatch && arrayMatch[1]) {
        const itemMatches = arrayMatch[1].matchAll(/["']([a-zA-Z0-9_\-\.]+)/g);
        for (const m of itemMatches) {
          if (m[1]) deps.add(m[1]);
        }
      }
      // Look for [tool.poetry.dependencies]
      const poetryMatch = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(\n\[|$)/);
      if (poetryMatch && poetryMatch[1]) {
        const lines = poetryMatch[1].split(/\r?\n/);
        for (const l of lines) {
          const m = l.trim().match(/^([a-zA-Z0-9_\-\.]+)\s*=/);
          if (m && m[1] && m[1] !== "python") deps.add(m[1]);
        }
      }
    }
  }

  // 5. go.mod
  const goModPath = join(projectRoot, "go.mod");
  if (isSafePath(goModPath, projectRoot)) {
    const content = readFileWithinBudget(goModPath);
    if (content) {
      const lines = content.split(/\r?\n/);
      let inRequire = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("require (")) {
          inRequire = true;
          continue;
        }
        if (inRequire && trimmed === ")") {
          inRequire = false;
          continue;
        }
        if (inRequire && trimmed && !trimmed.startsWith("//")) {
          const parts = trimmed.split(/\s+/);
          if (parts[0]) deps.add(parts[0]);
        } else if (trimmed.startsWith("require ") && !trimmed.includes("(")) {
          const parts = trimmed.replace(/^require\s+/, "").split(/\s+/);
          if (parts[0]) deps.add(parts[0]);
        }
      }
    }
  }

  return Array.from(deps).sort();
}

/**
 * Extracts goals from active card, AGENTS.md, or README.md.
 * Invariant: Never invents or hallucinates goals. If missing or unclear, returns empty array [].
 */
export function extractGoals(projectRoot: string, cardId?: string): string[] {
  const goals: string[] = [];

  // Helper to extract bullet points or concise intent
  const extractBullets = (text: string, headingRegex: RegExp): string[] => {
    const found: string[] = [];
    const lines = text.split(/\r?\n/);
    let capturing = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) {
        if (headingRegex.test(trimmed)) {
          capturing = true;
          continue;
        } else if (capturing) {
          // Reached next section
          break;
        }
      }

      if (capturing) {
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ") || /^\d+\.\s+/.test(trimmed)) {
          const cleaned = trimmed.replace(/^([-*]|\d+\.)\s+/, "").trim();
          if (cleaned) found.push(cleaned);
        } else if (trimmed && !trimmed.startsWith("```") && found.length === 0) {
          // If paragraph right under heading, capture as goal if concise
          if (trimmed.length < 300) {
            found.push(trimmed);
          }
        }
      }
    }
    return found;
  };

  // 1. If cardId/taskId is given, look in active card files or plans
  if (cardId && cardId.trim()) {
    const cleanId = cardId.trim();

    // Check specific files: current_tasks/<cardId>.md, plans/<cardId>.plan.md, etc.
    const candidateFiles = [
      join(projectRoot, "current_tasks", `${cleanId}.md`),
      join(projectRoot, "current_tasks", `${cleanId}.plan.md`),
      join(projectRoot, "plans", `${cleanId}.plan.md`),
      join(projectRoot, "plans", `${cleanId}.md`),
    ];

    for (const file of candidateFiles) {
      if (isSafePath(file, projectRoot)) {
        const content = readFileWithinBudget(file);
        if (content) {
          // Look for Step goal: - Goal: ...
          const goalMatches = content.matchAll(/^-\s*Goal:\s*([^\r\n]+)/gim);
          for (const gm of goalMatches) {
            if (gm[1]?.trim()) goals.push(gm[1].trim());
          }

          // Look for Intent section
          const intentBullets = extractBullets(content, /^#+\s*(Intent|Goals|Objectives|요약|목표)/i);
          for (const b of intentBullets) {
            if (!goals.includes(b)) goals.push(b);
          }
        }
      }
    }

    // Also scan plans directory for a step matching cardId
    const plansDir = join(projectRoot, "plans");
    if (isSafePath(plansDir, projectRoot) && existsSync(plansDir)) {
      try {
        const planEntries = readdirSync(plansDir);
        for (const entry of planEntries) {
          if (entry.endsWith(".plan.md") || entry.endsWith(".md")) {
            const planFile = join(plansDir, entry);
            if (isSafePath(planFile, projectRoot)) {
              const content = readFileWithinBudget(planFile);
              if (content) {
                // Search for step heading: ### Step ...: <cleanId>
                const stepRegex = new RegExp(`^###\\s+Step\\s*[^:\\n]*:\\s*${cleanId.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b[^\r\n]*`, "im");
                const stepMatch = content.match(stepRegex);
                if (stepMatch) {
                  // Capture lines under this step until next heading
                  const stepIndex = content.indexOf(stepMatch[0]);
                  const rest = content.slice(stepIndex + stepMatch[0].length);
                  const goalMatch = rest.match(/^[ \t]*-[ \t]*Goal:[ \t]*([^\r\n]+)/im);
                  if (goalMatch && goalMatch[1]?.trim()) {
                    const g = goalMatch[1].trim();
                    if (!goals.includes(g)) goals.push(g);
                  }
                }
              }
            }
          }
        }
      } catch {
        // ignore scan error
      }
    }
  }

  // 2. AGENTS.md
  const agentsPath = join(projectRoot, "AGENTS.md");
  if (isSafePath(agentsPath, projectRoot)) {
    const content = readFileWithinBudget(agentsPath);
    if (content) {
      // Look for Harness mode or Intent
      const modeMatch = content.match(/^##\s+Harness mode:\s*([^\r\n]+)/m);
      if (modeMatch && modeMatch[1]?.trim()) {
        const mode = modeMatch[1].trim();
        if (!goals.includes(mode)) goals.push(mode);
      }
      const agentBullets = extractBullets(content, /^##\s*(Intent|Goals|Mission|Objectives)/i);
      for (const b of agentBullets) {
        if (!goals.includes(b)) goals.push(b);
      }
    }
  }

  // 3. README.md
  const readmePath = join(projectRoot, "README.md");
  if (isSafePath(readmePath, projectRoot)) {
    const content = readFileWithinBudget(readmePath);
    if (content) {
      const readmeBullets = extractBullets(content, /^##?\s*(Goals|Intent|Objectives|Mission|Purpose|About|Overview|목표)/i);
      for (const b of readmeBullets) {
        if (!goals.includes(b)) goals.push(b);
      }

      // If no goals found yet, check first descriptive paragraph after main title
      if (goals.length === 0) {
        const lines = content.split(/\r?\n/);
        let foundTitle = false;
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("# ")) {
            foundTitle = true;
            continue;
          }
          if (foundTitle && trimmed) {
            // Skip badges, images, code blocks, horizontal rules
            if (
              !trimmed.startsWith("[!") &&
              !trimmed.startsWith("[![") &&
              !trimmed.startsWith("![") &&
              !trimmed.startsWith("```") &&
              !trimmed.startsWith("---") &&
              trimmed.length > 10 &&
              trimmed.length < 300
            ) {
              goals.push(trimmed);
              break;
            }
          }
        }
      }
    }
  }

  return goals;
}

/**
 * Extracts related file anchors from git status or active card references.
 */
export function extractRelatedFiles(projectRoot: string, cardId?: string, signal?: AbortSignal): string[] {
  const related = new Set<string>();

  // 1. Files from active card or plan
  if (cardId && cardId.trim()) {
    const cleanId = cardId.trim();
    const candidateFiles = [
      join(projectRoot, "current_tasks", `${cleanId}.md`),
      join(projectRoot, "current_tasks", `${cleanId}.plan.md`),
      join(projectRoot, "plans", `${cleanId}.plan.md`),
      join(projectRoot, "plans", `${cleanId}.md`),
    ];

    const checkFileForLinks = (filePath: string) => {
      if (isSafePath(filePath, projectRoot)) {
        const content = readFileWithinBudget(filePath);
        if (content) {
          // Match lines like: - Files: foo/bar.ts, baz.ts
          const fileLineMatches = content.matchAll(/^[ \t]*-[ \t]*Files:\s*([^\r\n]+)/gim);
          for (const flm of fileLineMatches) {
            if (flm[1]) {
              const fileTokens = flm[1].split(/[,\s]+/).map((s) => s.trim().replace(/^`+|`+$/g, ""));
              for (const token of fileTokens) {
                if (token && !isSecretOrDisallowedPath(token)) {
                  // Normalize
                  const norm = token.replace(/\\/g, "/");
                  if (!isAbsolute(norm) && !norm.startsWith("..")) {
                    related.add(norm);
                  }
                }
              }
            }
          }

          // Match markdown links: [foo](path/to/file) or [foo](file:///path/to/file)
          const linkMatches = content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g);
          for (const lm of linkMatches) {
            let target = lm[1]?.trim() ?? "";
            if (target.startsWith("file://")) {
              target = target.replace(/^file:\/\//, "");
            }
            // Strip line hash
            target = target.split("#")[0] ?? "";
            if (target && !target.startsWith("http://") && !target.startsWith("https://")) {
              let rel = target;
              if (isAbsolute(target)) {
                rel = relative(projectRoot, target);
              }
              const norm = rel.replace(/\\/g, "/");
              if (!norm.startsWith("..") && !isSecretOrDisallowedPath(norm)) {
                related.add(norm);
              }
            }
          }
        }
      }
    };

    for (const f of candidateFiles) {
      checkFileForLinks(f);
    }

    // Also check step in plans dir
    const plansDir = join(projectRoot, "plans");
    if (isSafePath(plansDir, projectRoot) && existsSync(plansDir)) {
      try {
        const planEntries = readdirSync(plansDir);
        for (const entry of planEntries) {
          if (entry.endsWith(".plan.md") || entry.endsWith(".md")) {
            const planFile = join(plansDir, entry);
            if (isSafePath(planFile, projectRoot)) {
              const content = readFileWithinBudget(planFile);
              if (content) {
                const stepRegex = new RegExp(`^###\\s+Step\\s*[^:\\n]*:\\s*${cleanId.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b[^\r\n]*`, "im");
                const stepMatch = content.match(stepRegex);
                if (stepMatch) {
                  const stepIndex = content.indexOf(stepMatch[0]);
                  const rest = content.slice(stepIndex + stepMatch[0].length);
                  const filesMatch = rest.match(/^[ \t]*-[ \t]*Files:[ \t]*([^\r\n]+)/im);
                  if (filesMatch && filesMatch[1]) {
                    const tokens = filesMatch[1].split(/[,\s]+/).map((s) => s.trim().replace(/^`+|`+$/g, ""));
                    for (const tok of tokens) {
                      if (tok && !isSecretOrDisallowedPath(tok)) {
                        const norm = tok.replace(/\\/g, "/");
                        if (!isAbsolute(norm) && !norm.startsWith("..")) {
                          related.add(norm);
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }

  // 2. Git status (modified / untracked files)
  const gitDir = join(projectRoot, ".git");
  if (existsSync(gitDir)) {
    try {
      if (signal?.aborted) throw new CancellationError("OPERATION_CANCELLED", "Aborted before git status");

      const stdout = execFileSync("git", ["status", "--porcelain"], {
        cwd: projectRoot,
        timeout: 1500,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });

      const lines = stdout.split(/\r?\n/);
      for (const line of lines) {
        if (!line || line.length < 3) continue;
        let filePath = line.slice(3).trim();
        if (filePath.startsWith('"') && filePath.endsWith('"')) {
          filePath = filePath.slice(1, -1);
        }
        // Handle renamed files: old -> new
        if (filePath.includes(" -> ")) {
          const parts = filePath.split(" -> ");
          filePath = parts[1]?.trim() ?? filePath;
        }

        const norm = filePath.replace(/\\/g, "/");
        if (!norm.startsWith("..") && !isSecretOrDisallowedPath(norm)) {
          // Check that first segment is not ignored directory
          const firstSeg = norm.split("/")[0] ?? "";
          if (!IGNORED_DIRECTORY_NAMES.has(firstSeg)) {
            related.add(norm);
          }
        }
      }
    } catch {
      // Git not found or failed; gracefully ignore
    }
  }

  return Array.from(related).sort();
}

// ============================================================================
// Service & Caching (AC-2)
// ============================================================================

export interface ProjectContextOptions extends PortOptions {
  cardId?: string;
  taskId?: string;
  _delayMsForTesting?: number;
}

interface CacheEntry {
  key: string;
  context: ProjectContext;
}

export class ProjectContextService implements ContextPort {
  private cache = new Map<string, CacheEntry>();
  private readonly maxFileBytes: number;
  private readonly maxTokens: number;

  constructor(options?: { maxFileBytes?: number; maxTokens?: number }) {
    this.maxFileBytes = options?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOTAL_TOKENS;
  }

  /**
   * Computes an invalidation key based on HEAD / status / mtimes + cardId.
   */
  private computeCacheKey(projectRoot: string, cardId?: string): string {
    let gitHead = "no-git";
    let gitStatus = "no-status";

    const gitDir = join(projectRoot, ".git");
    if (existsSync(gitDir)) {
      try {
        gitHead = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: projectRoot,
          timeout: 1000,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        // ignore
      }

      try {
        gitStatus = execFileSync("git", ["status", "--porcelain", "-uno"], {
          cwd: projectRoot,
          timeout: 1000,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        // ignore
      }
    }

    // Inspect mtimes of key manifests and doc files
    const watchFiles = [
      "package.json",
      "tsconfig.json",
      "Cargo.toml",
      "pyproject.toml",
      "requirements.txt",
      "go.mod",
      "README.md",
      "AGENTS.md",
    ];

    if (cardId) {
      watchFiles.push(
        join("current_tasks", `${cardId}.md`),
        join("plans", `${cardId}.plan.md`),
      );
    }

    const mtimes: string[] = [];
    for (const f of watchFiles) {
      const fullPath = join(projectRoot, f);
      try {
        if (existsSync(fullPath)) {
          const s = statSync(fullPath);
          mtimes.push(`${f}:${s.mtimeMs}:${s.size}`);
        }
      } catch {
        // ignore
      }
    }

    const payload = JSON.stringify({
      projectRoot: resolve(projectRoot),
      cardId: cardId ?? "",
      gitHead,
      gitStatus,
      mtimes,
    });

    return createHash("sha256").update(payload).digest("hex");
  }

  /**
   * Extracts and returns the ProjectContext for a given projectRoot.
   * Satisfies ContextPort.
   */
  async extractProjectContext(
    projectRoot: string,
    taskOrCardIdOrOptions?: string | ProjectContextOptions,
    options?: PortOptions,
  ): Promise<ProjectContext> {
    let cardId: string | undefined;
    let portOpts: PortOptions | undefined;

    if (typeof taskOrCardIdOrOptions === "string") {
      cardId = taskOrCardIdOrOptions;
      portOpts = options;
    } else if (taskOrCardIdOrOptions && typeof taskOrCardIdOrOptions === "object") {
      cardId = taskOrCardIdOrOptions.cardId ?? taskOrCardIdOrOptions.taskId;
      portOpts = taskOrCardIdOrOptions;
    } else {
      portOpts = options;
    }

    return await withPortTimeout(async (signal) => {
      if (signal.aborted) {
        throw new CancellationError("OPERATION_CANCELLED", "Operation was cancelled before execution");
      }

      const absRoot = resolve(projectRoot);
      if (!existsSync(absRoot)) {
        throw new KnowledgeError("UNKNOWN_ERROR", `Project root does not exist: ${absRoot}`);
      }

      const rootStat = statSync(absRoot);
      if (!rootStat.isDirectory()) {
        throw new KnowledgeError("UNKNOWN_ERROR", `Project root is not a directory: ${absRoot}`);
      }

      // Check cache key (AC-2)
      const cacheKey = this.computeCacheKey(absRoot, cardId);
      const cacheSlot = `${absRoot}:${cardId ?? ""}`;
      const cached = this.cache.get(cacheSlot);

      if (cached && cached.key === cacheKey) {
        return cached.context;
      }

      if (typeof (portOpts as ProjectContextOptions)?._delayMsForTesting === "number") {
        await new Promise((resolve) => setTimeout(resolve, (portOpts as ProjectContextOptions)._delayMsForTesting));
      }

      if (signal.aborted) {
        throw new CancellationError("OPERATION_CANCELLED", "Operation cancelled during extraction");
      }

      // Extract fresh context (AC-1)
      const projectName = extractProjectName(absRoot);
      const stack = extractStack(absRoot);
      const existingDeps = extractDependencies(absRoot);
      const goals = extractGoals(absRoot, cardId);
      const relatedFiles = extractRelatedFiles(absRoot, cardId, signal);

      const rawContext: ProjectContext = {
        project_name: projectName,
        stack,
        goals,
        existing_deps: existingDeps,
        related_files: relatedFiles,
      };

      // Enforce token budget (AC-3)
      const budgetedContext = enforceTokenBudget(rawContext, this.maxTokens);

      // Validate against contract schema invariants
      const validated = validateProjectContext(budgetedContext);

      // Store in cache
      this.cache.set(cacheSlot, {
        key: cacheKey,
        context: validated,
      });

      return validated;
    }, portOpts);
  }

  /**
   * Invalidates cached entries for a project or clears entire cache.
   */
  invalidate(projectRoot?: string): void {
    if (projectRoot) {
      const abs = resolve(projectRoot);
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${abs}:`)) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheSize(): number {
    return this.cache.size;
  }
}

// Global default service instance
export const projectContextService = new ProjectContextService();

/**
 * Convenience standalone extractProjectContext function.
 */
export async function extractProjectContext(
  projectRoot: string,
  taskOrCardIdOrOptions?: string | ProjectContextOptions,
  options?: PortOptions,
): Promise<ProjectContext> {
  return projectContextService.extractProjectContext(projectRoot, taskOrCardIdOrOptions, options);
}
