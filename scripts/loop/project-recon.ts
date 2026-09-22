// project-recon.ts — Project Context Exploration & Reconnaissance.
//
// Inspects a project workspace, scans available projects/workspaces in the environment,
// analyzes directory structure, package metadata, git status, existing plan docs,
// and summarizes project context for ideation and plan drafting.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, basename, dirname } from "node:path";
import { execSync } from "node:child_process";

export interface ProjectSummary {
  name: string;
  path: string;
  isCurrent: boolean;
  hasHarness: boolean;
  hasTodo: boolean;
  planCount: number;
  packageVersion?: string;
  description?: string;
}

export interface ProjectReconDetail {
  name: string;
  path: string;
  isCurrent: boolean;
  packageJson: {
    name?: string;
    version?: string;
    description?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } | null;
  git: {
    branch: string;
    head: string;
    dirtyCount: number;
    dirtyFiles: string[];
    lastCommit: string;
  };
  structure: {
    directories: string[];
    sourceFiles: string[];
    testFiles: string[];
    docFiles: string[];
  };
  plans: Array<{
    slug: string;
    title: string;
    status: string;
    risk: string;
    owner: string;
    path: string;
  }>;
  boardStats: {
    hasBoard: boolean;
    tasksCount: number;
    completedTasksCount: number;
  };
  summary: string;
}

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
  ".turbo",
  ".gemini",
  ".claude",
  ".codex",
]);

/**
 * Scans the current workspace and parent directory for candidate projects.
 */
export function scanProjects(rootPath = process.cwd()): ProjectSummary[] {
  const resolvedRoot = resolve(rootPath);
  const projects: ProjectSummary[] = [];
  const visited = new Set<string>();

  // 1. Current project
  const currentSummary = inspectProjectSummary(resolvedRoot, true);
  projects.push(currentSummary);
  visited.add(resolvedRoot.toLowerCase());

  // 2. Sibling directories in parent folder (e.g. D:\works\*)
  try {
    const parent = dirname(resolvedRoot);
    if (parent && parent !== resolvedRoot && existsSync(parent)) {
      const entries = readdirSync(parent, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subPath = resolve(parent, entry.name);
        const lower = subPath.toLowerCase();
        if (visited.has(lower)) continue;

        // Candidate check: contains package.json, .git, AGENTS.md, or plans/
        const isProject =
          existsSync(join(subPath, "package.json")) ||
          existsSync(join(subPath, ".git")) ||
          existsSync(join(subPath, "AGENTS.md")) ||
          existsSync(join(subPath, "plans"));

        if (isProject) {
          visited.add(lower);
          projects.push(inspectProjectSummary(subPath, false));
        }
      }
    }
  } catch {}

  return projects;
}

function inspectProjectSummary(projectPath: string, isCurrent: boolean): ProjectSummary {
  const name = basename(projectPath);
  let packageVersion: string | undefined;
  let description: string | undefined;

  const pkgPath = join(projectPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      packageVersion = pkg.version;
      description = pkg.description;
    } catch {}
  }

  const hasHarness =
    existsSync(join(projectPath, ".harness")) ||
    existsSync(join(projectPath, "AGENTS.md")) ||
    existsSync(join(projectPath, ".harness-version.json"));

  const hasTodo =
    existsSync(join(projectPath, "TODO.md")) ||
    existsSync(join(projectPath, "todo.md"));

  let planCount = 0;
  const plansDir = join(projectPath, "plans");
  if (existsSync(plansDir)) {
    try {
      planCount = readdirSync(plansDir).filter((f) => f.endsWith(".plan.md")).length;
    } catch {}
  }

  return {
    name,
    path: projectPath,
    isCurrent,
    hasHarness,
    hasTodo,
    planCount,
    packageVersion,
    description,
  };
}

/**
 * Performs deep reconnaissance of a specific project path.
 */
export function reconProject(projectPath = process.cwd()): ProjectReconDetail {
  const target = resolve(projectPath);
  const name = basename(target);
  const isCurrent = target.toLowerCase() === resolve(process.cwd()).toLowerCase();

  // Package JSON
  let packageJson: ProjectReconDetail["packageJson"] = null;
  const pkgPath = join(target, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, "utf8"));
      packageJson = {
        name: parsed.name,
        version: parsed.version,
        description: parsed.description,
        scripts: parsed.scripts || {},
        dependencies: parsed.dependencies || {},
        devDependencies: parsed.devDependencies || {},
      };
    } catch {}
  }

  // Git status
  const git = {
    branch: "unknown",
    head: "",
    dirtyCount: 0,
    dirtyFiles: [] as string[],
    lastCommit: "",
  };

  try {
    const branchRaw = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: target,
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    if (branchRaw) git.branch = branchRaw;

    const headRaw = execSync("git rev-parse --short HEAD", {
      cwd: target,
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    if (headRaw) git.head = headRaw;

    const statusRaw = execSync("git status --porcelain", {
      cwd: target,
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    if (statusRaw) {
      git.dirtyFiles = statusRaw
        .split("\n")
        .map((l) => l.trim().slice(3))
        .filter(Boolean)
        .slice(0, 15);
      git.dirtyCount = git.dirtyFiles.length;
    }

    const logRaw = execSync('git log -n 1 "--format=%h - %s (%cr)"', {
      cwd: target,
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    if (logRaw) git.lastCommit = logRaw;
  } catch {}

  // Structure exploration
  const directories: string[] = [];
  const sourceFiles: string[] = [];
  const testFiles: string[] = [];
  const docFiles: string[] = [];

  try {
    const entries = readdirSync(target, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !IGNORE_DIRS.has(e.name)) {
        directories.push(e.name);
      }
    }

    // Scan top-level and 1st depth source/test files
    const scanDir = (dir: string, depth = 0) => {
      if (depth > 2) return;
      try {
        const list = readdirSync(dir, { withFileTypes: true });
        for (const item of list) {
          const itemPath = join(dir, item.name);
          const rel = itemPath.slice(target.length + 1).replace(/\\/g, "/");
          if (item.isDirectory()) {
            if (!IGNORE_DIRS.has(item.name)) scanDir(itemPath, depth + 1);
          } else {
            if (rel.endsWith(".test.ts") || rel.endsWith(".test.js") || rel.endsWith(".spec.ts")) {
              if (testFiles.length < 25) testFiles.push(rel);
            } else if (rel.endsWith(".ts") || rel.endsWith(".js") || rel.endsWith(".tsx") || rel.endsWith(".jsx")) {
              if (sourceFiles.length < 35) sourceFiles.push(rel);
            } else if (rel.endsWith(".md")) {
              if (docFiles.length < 15) docFiles.push(rel);
            }
          }
        }
      } catch {}
    };

    scanDir(target);
  } catch {}

  // Plans inspection
  const plans: ProjectReconDetail["plans"] = [];
  const plansDir = join(target, "plans");
  if (existsSync(plansDir)) {
    try {
      const planFiles = readdirSync(plansDir).filter((f) => f.endsWith(".plan.md"));
      for (const pf of planFiles) {
        const fullPf = join(plansDir, pf);
        const content = readFileSync(fullPf, "utf8");
        const slug = pf.replace(/\.plan\.md$/, "");

        const statusMatch = content.match(/^status:\s*([a-z0-9_-]+)/im);
        const riskMatch = content.match(/^risk:\s*([a-z0-9_-]+)/im);
        const ownerMatch = content.match(/^owner:\s*([^\r\n]+)/im);
        const titleMatch = content.match(/^#\s+(?:Plan:\s*)?([^\r\n]+)/im);

        plans.push({
          slug,
          title: titleMatch && titleMatch[1] ? titleMatch[1].trim() : slug,
          status: statusMatch && statusMatch[1] ? statusMatch[1].trim() : "draft",
          risk: riskMatch && riskMatch[1] ? riskMatch[1].trim() : "medium",
          owner: ownerMatch && ownerMatch[1] ? ownerMatch[1].trim() : "unassigned",
          path: fullPf,
        });
      }
    } catch {}
  }

  // Tasks check (TODO.md)
  let hasBoard = false;
  let tasksCount = 0;
  let completedTasksCount = 0;

  const todoFile = join(target, "TODO.md");
  if (existsSync(todoFile)) {
    hasBoard = true;
    try {
      const text = readFileSync(todoFile, "utf8");
      const allTasks = text.match(/- \[[ xX]\]/g) || [];
      tasksCount = allTasks.length;

      const doneTasks = text.match(/- \[[xX]\]/g) || [];
      completedTasksCount = doneTasks.length;
    } catch {}
  }

  // Synthesis summary
  const summaryParts: string[] = [];
  if (packageJson?.name) {
    summaryParts.push(`프로젝트: ${packageJson.name} (v${packageJson.version || "0.0.1"})`);
  } else {
    summaryParts.push(`프로젝트: ${name}`);
  }
  if (packageJson?.description) {
    summaryParts.push(`설명: ${packageJson.description}`);
  }
  summaryParts.push(
    `디렉터리: ${directories.join(", ") || "루트"} | 브랜치: ${git.branch} (${git.head || "clean"})`
  );
  if (plans.length > 0) {
    const approved = plans.filter((p) => p.status === "approved").length;
    summaryParts.push(`계획서: 총 ${plans.length}건 (승인 ${approved}건, 초안 ${plans.length - approved}건)`);
  }
  if (hasBoard && tasksCount > 0) {
    summaryParts.push(`할일: 총 ${tasksCount}건 (완료 ${completedTasksCount}건)`);
  }

  return {
    name,
    path: target,
    isCurrent,
    packageJson,
    git,
    structure: {
      directories,
      sourceFiles,
      testFiles,
      docFiles,
    },
    plans,
    boardStats: {
      hasBoard,
      tasksCount,
      completedTasksCount,
    },
    summary: summaryParts.join(" | "),
  };
}
