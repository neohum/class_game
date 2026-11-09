#!/usr/bin/env node
// scripts/security/config-supply-chain-gate.ts
// Defensive configuration & supply-chain security gate (CLI + programmatic API).
//
// The existing `security-triad` gate (anti-reverse-engineering-gate.ts) only fires
// when scripts/security, src/auth, or src/crypto change. That leaves three blind
// spots the harness is actually exposed to, which this gate closes:
//
//   1. MCP supply chain — an MCP server launched with `npx <pkg>` and no pinned
//      version pulls whatever is published at run time. A compromised or typo-
//      squatted release then executes inside the agent with the project's tokens.
//   2. Executable agent config — hook commands in .claude/settings*.json and MCP
//      server commands run on every session. A network-piped-to-shell command
//      (`curl … | sh`, `/dev/tcp`, `base64 -d | sh`) there is remote code exec.
//   3. Hardcoded secrets in config / agent / skill files — tokens pasted into
//      .mcp.json env, settings.json, SKILL.md, or agent definitions never go
//      through the narrow security-triad path, so nothing scans them today.
//
// It deliberately does NOT keyword-match prose. The harness docs legitimately
// describe dangerous commands (`--no-verify`, `core.hooksPath=/dev/null`) as
// things NOT to do; flagging those would bury real findings. This gate reads
// executable config (commands, args, env) and runs the shared secret scanner —
// both low false-positive signals.

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { scanTextForSecrets } from "./bundle-secret-scanner.ts";

export type ConfigThreatSeverity = "critical" | "high" | "medium" | "low";

export interface ConfigThreatFinding {
  ruleId: string;
  severity: ConfigThreatSeverity;
  file: string;
  line?: number;
  message: string;
  remediation: string;
}

export interface ConfigGateResult {
  passed: boolean;
  blocked: boolean;
  findings: ConfigThreatFinding[];
  counts: { critical: number; high: number; medium: number; low: number; total: number };
  scannedFiles: number;
  summary: string;
}

export interface ConfigGateOptions {
  rootDir?: string;
  // When set, also run the shared secret scanner over these additional files
  // (used by --changed to scan a diff). Paths are relative to rootDir.
  changedFiles?: string[];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const SECRET_ENV_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|_PWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|_PAT|CLIENT_SECRET)/i;

// npx-family launchers that resolve a package at run time.
const NPX_LAUNCHERS = new Set(["npx", "pnpx", "bunx", "dlx"]);

function isReference(value: string): boolean {
  // ${VAR}, $VAR, {{VAR}}, <VAR>, or empty — not a literal secret.
  return (
    value.length === 0 ||
    /^\$\{[^}]+\}$/.test(value) ||
    /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value) ||
    /^\{\{.*\}\}$/.test(value) ||
    /^<[^>]+>$/.test(value)
  );
}

// A package spec is "pinned" when it names an exact version, a local path, or a
// git/tarball URL carrying a commit SHA. Floating tags (latest, ^1, ~1, none) are not.
function isPinnedPackageSpec(spec: string): boolean {
  if (!spec) return true; // not a package arg
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("~")) return true; // local path
  if (spec.startsWith("file:") || spec.startsWith("link:")) return true;
  // git/tarball URL pinned to a 40-char or 7+-char commit SHA
  if (/^(?:git\+|https?:).*#[0-9a-f]{7,40}$/i.test(spec)) return true;
  // scoped (@scope/name@x.y.z) or bare (name@x.y.z) exact semver
  const at = spec.lastIndexOf("@");
  if (at > 0) {
    const version = spec.slice(at + 1);
    if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return true;
  }
  return false;
}

// Flags are not package specs; the first non-flag token after the launcher is.
function firstPackageArg(args: string[]): string | null {
  for (const a of args) {
    if (a === "-y" || a === "--yes" || a === "-p" || a === "--package" || a.startsWith("-")) continue;
    return a;
  }
  return null;
}

// Executable command string → remote-code-execution shape?
function networkToShellFinding(ruleBase: string, file: string, command: string): ConfigThreatFinding | null {
  const c = command.replace(/\s+/g, " ");
  if (/\b(?:curl|wget|Invoke-WebRequest|iwr)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i.test(c)) {
    return {
      ruleId: `${ruleBase}-NET-PIPE-SHELL`,
      severity: "critical",
      file,
      message: `실행형 설정이 네트워크에서 받은 내용을 셸로 바로 파이프합니다(원격 코드 실행): ${c.slice(0, 160)}`,
      remediation: "받은 스크립트를 파일로 내려 내용을 검토하고 고정 해시를 확인한 뒤 실행하세요. 설치 단계는 고정 버전 패키지로 대체하세요.",
    };
  }
  if (/\/dev\/tcp\//.test(c) || /\bnc\b[^|\n]*-e\b/.test(c) || /bash\s+-i\b.*>&/.test(c)) {
    return {
      ruleId: `${ruleBase}-REVERSE-SHELL`,
      severity: "critical",
      file,
      message: `실행형 설정에 리버스 셸/네트워크 소켓 패턴이 있습니다: ${c.slice(0, 160)}`,
      remediation: "이 명령이 왜 네트워크 소켓을 여는지 확인하세요. 의도치 않았다면 즉시 제거하세요.",
    };
  }
  if (/base64\s+(?:-d|--decode|-D)\b[^|\n]*\|\s*(?:ba|z|da|k)?sh\b/i.test(c)) {
    return {
      ruleId: `${ruleBase}-OBFUSCATED-EXEC`,
      severity: "critical",
      file,
      message: `실행형 설정이 base64 로 가린 내용을 셸로 실행합니다: ${c.slice(0, 160)}`,
      remediation: "난독화된 실행 페이로드를 제거하고, 무엇을 실행하는지 평문으로 드러내세요.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. MCP supply-chain
// ---------------------------------------------------------------------------

const MCP_CONFIG_FILES = [
  ".mcp.json",
  ".agents/mcp_config.json",
  ".claude/mcp.json",
  ".cursor/mcp.json",
  ".codex/config.toml",
];

interface McpServerDef {
  command?: string;
  args?: string[];
  env?: Record<string, unknown>;
  url?: string;
  type?: string;
  transport?: string;
}

function extractMcpServers(parsed: unknown): Record<string, McpServerDef> {
  if (!parsed || typeof parsed !== "object") return {};
  const obj = parsed as Record<string, unknown>;
  // Common shapes: { mcpServers: {...} } (Claude/Cursor), { servers: {...} },
  // { mcp: { servers: {...} } }.
  if (obj.mcpServers && typeof obj.mcpServers === "object") return obj.mcpServers as Record<string, McpServerDef>;
  if (obj.servers && typeof obj.servers === "object") return obj.servers as Record<string, McpServerDef>;
  if (obj.mcp && typeof obj.mcp === "object") {
    const mcp = obj.mcp as Record<string, unknown>;
    if (mcp.servers && typeof mcp.servers === "object") return mcp.servers as Record<string, McpServerDef>;
  }
  return {};
}

// ---- Codex config.toml MCP parsing (no TOML dependency) -------------------
// Codex keeps MCP servers in `[mcp_servers.<name>]` tables. We parse just those
// tables into the same McpServerDef shape the JSON path uses. Only full-line `#`
// comments are dropped; values are read by extracting quoted strings, so a
// `git+https://…#sha` spec inside quotes survives intact.

function tomlStrings(value: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) out.push(m[1]!.replace(/\\"/g, '"'));
  return out;
}

export function parseCodexTomlMcpServers(content: string): Record<string, McpServerDef> {
  const servers: Record<string, McpServerDef> = {};
  let cur: string | null = null;
  let inEnv = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Check the `.env` subtable first: the server-name class allows dots, so the
    // plain-table pattern would otherwise swallow `[mcp_servers.x.env]` as a
    // server literally named "x.env".
    let m = line.match(/^\[mcp_servers\.([A-Za-z0-9_.-]+)\.env\]$/);
    if (m) {
      cur = m[1]!;
      inEnv = true;
      servers[cur] ??= {};
      (servers[cur]!.env ??= {});
      continue;
    }
    m = line.match(/^\[mcp_servers\.([A-Za-z0-9_.-]+)\]$/);
    if (m) {
      cur = m[1]!;
      inEnv = false;
      servers[cur] ??= {};
      continue;
    }
    if (line.startsWith("[")) {
      cur = null;
      inEnv = false;
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1]!;
    const val = kv[2]!;
    const def = servers[cur]!;
    if (inEnv) {
      (def.env ??= {})[key] = tomlStrings(val)[0] ?? val.trim();
      continue;
    }
    if (key === "command") def.command = tomlStrings(val)[0] ?? "";
    else if (key === "url") def.url = tomlStrings(val)[0] ?? "";
    else if (key === "args") def.args = tomlStrings(val);
    else if (key === "env") {
      // inline table: env = { A = "x", B = "y" }
      def.env ??= {};
      const pairRe = /([A-Za-z0-9_-]+)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
      let p: RegExpExecArray | null;
      while ((p = pairRe.exec(val)) !== null) def.env[p[1]!] = p[2]!;
    }
  }
  return servers;
}

export function scanMcpConfigs(rootDir: string): { findings: ConfigThreatFinding[]; scanned: number } {
  const findings: ConfigThreatFinding[] = [];
  let scanned = 0;

  for (const rel of MCP_CONFIG_FILES) {
    const abs = join(rootDir, rel);
    if (!existsSync(abs)) continue;
    scanned += 1;
    let servers: Record<string, McpServerDef>;
    try {
      const raw = readFileSync(abs, "utf8");
      servers = rel.endsWith(".toml") ? parseCodexTomlMcpServers(raw) : extractMcpServers(JSON.parse(raw));
    } catch {
      continue; // malformed config is another gate's problem
    }
    for (const [name, def] of Object.entries(servers)) {
      if (!def || typeof def !== "object") continue;

      // a. unpinned npx-family package
      const cmd = (def.command ?? "").toString();
      const cmdBase = basename(cmd);
      const args = Array.isArray(def.args) ? def.args.map((x) => String(x)) : [];
      if (NPX_LAUNCHERS.has(cmdBase)) {
        const pkg = firstPackageArg(args);
        if (pkg && !isPinnedPackageSpec(pkg)) {
          findings.push({
            ruleId: "MCP-UNPINNED-PACKAGE",
            severity: "high",
            file: rel,
            message: `MCP 서버 '${name}' 가 버전 고정 없이 '${cmdBase} ${pkg}' 로 실행됩니다. 실행 시점에 올라온 패키지를 그대로 받아 에이전트 권한으로 돕니다(공급망 위험).`,
            remediation: `정확한 버전으로 고정하세요(예: ${pkg}@<x.y.z>). 또는 로컬 설치본을 직접 실행하세요.`,
          });
        }
      }

      // b. remote server over plaintext http
      const url = (def.url ?? "").toString();
      if (url && /^http:\/\//i.test(url)) {
        findings.push({
          ruleId: "MCP-PLAINTEXT-URL",
          severity: "high",
          file: rel,
          message: `MCP 서버 '${name}' 가 평문 http 로 연결됩니다(${url}). 토큰·도구 호출이 가로채기에 노출됩니다.`,
          remediation: "https 엔드포인트로 바꾸거나 로컬 stdio 서버를 쓰세요.",
        });
      }

      // c. network-piped-to-shell in the launch command
      const full = [cmd, ...args].join(" ");
      const net = networkToShellFinding("MCP", rel, full);
      if (net) findings.push({ ...net, message: `MCP 서버 '${name}': ${net.message}` });

      // d. inline secret literal in env
      const env = def.env && typeof def.env === "object" ? (def.env as Record<string, unknown>) : {};
      for (const [k, vRaw] of Object.entries(env)) {
        const v = vRaw == null ? "" : String(vRaw);
        if (isReference(v)) continue;
        if (SECRET_ENV_NAME.test(k)) {
          findings.push({
            ruleId: "MCP-INLINE-SECRET",
            severity: "high",
            file: rel,
            message: `MCP 서버 '${name}' 의 env '${k}' 에 리터럴 값이 박혀 있습니다. 시크릿이면 설정 파일에 저장됩니다.`,
            remediation: "값을 비우고 ${ENV_VAR} 참조로 바꿔, 실행 환경에서만 주입하세요.",
          });
          continue;
        }
        // Even non-secret-named env values can carry a token — run the shared scanner.
        for (const f of scanTextForSecrets(`${k}=${v}`, rel)) {
          if (f.severity === "critical" || f.severity === "high") {
            findings.push({
              ruleId: "MCP-ENV-SECRET",
              severity: f.severity,
              file: rel,
              message: `MCP 서버 '${name}' env '${k}': ${f.message}`,
              remediation: f.remediation,
            });
          }
        }
      }
    }
  }
  return { findings, scanned };
}

// ---------------------------------------------------------------------------
// 2. Executable agent config (hook commands)
// ---------------------------------------------------------------------------

const SETTINGS_FILES = [
  ".claude/settings.json",
  ".claude/settings.local.json",
];

function collectHookCommands(parsed: unknown): string[] {
  const out: string[] = [];
  if (!parsed || typeof parsed !== "object") return out;
  const hooks = (parsed as Record<string, unknown>).hooks;
  if (!hooks || typeof hooks !== "object") return out;
  for (const group of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(group)) continue;
    for (const matcher of group) {
      const inner = matcher && typeof matcher === "object" ? (matcher as Record<string, unknown>).hooks : null;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        const c = h && typeof h === "object" ? (h as Record<string, unknown>).command : null;
        if (typeof c === "string") out.push(c);
      }
    }
  }
  return out;
}

export function scanSettingsHooks(rootDir: string): { findings: ConfigThreatFinding[]; scanned: number } {
  const findings: ConfigThreatFinding[] = [];
  let scanned = 0;
  for (const rel of SETTINGS_FILES) {
    const abs = join(rootDir, rel);
    if (!existsSync(abs)) continue;
    scanned += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(abs, "utf8"));
    } catch {
      continue;
    }
    for (const command of collectHookCommands(parsed)) {
      const net = networkToShellFinding("HOOK", rel, command);
      if (net) findings.push(net);
    }
  }
  return { findings, scanned };
}

// ---------------------------------------------------------------------------
// 3. Secrets in config / agent / skill definition files
// ---------------------------------------------------------------------------

const SECRET_SCAN_ROOTS = [
  ".mcp.json",
  ".agents",
  ".claude",
  "AGENTS.md",
  "CLAUDE.md",
];

const SECRET_SCAN_EXT = new Set([".json", ".md", ".yaml", ".yml", ".toml", ".env"]);

// Directory names never worth scanning for config/agent secrets: dependency
// trees, build output, and agent scratch areas that hold whole sub-checkouts.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "worktrees",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  "evidence",
]);

function walkForSecretScan(abs: string, rootDir: string, out: Set<string>): void {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(basename(abs))) return;
    // Never descend into a nested checkout or git worktree — it contains an
    // entire project tree (CI files, docs with example keys, fixtures) that is
    // not this repo's config and only produces false positives. A worktree
    // links back via a `.git` file; a clone has a `.git` directory.
    if (abs !== rootDir && existsSync(join(abs, ".git"))) return;
    for (const entry of readdirSync(abs)) walkForSecretScan(join(abs, entry), rootDir, out);
    return;
  }
  const name = basename(abs);
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot) : "";
  if (SECRET_SCAN_EXT.has(ext) || name === ".env") out.add(abs);
}

export function scanConfigSecrets(rootDir: string, extraFiles: string[] = []): { findings: ConfigThreatFinding[]; scanned: number } {
  const findings: ConfigThreatFinding[] = [];
  const files = new Set<string>();
  for (const rel of SECRET_SCAN_ROOTS) {
    const abs = join(rootDir, rel);
    if (existsSync(abs)) walkForSecretScan(abs, rootDir, files);
  }
  for (const rel of extraFiles) {
    const abs = resolve(rootDir, rel);
    if (existsSync(abs) && statSync(abs).isFile()) files.add(abs);
  }
  let scanned = 0;
  for (const abs of files) {
    scanned += 1;
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const rel = relative(rootDir, abs).replace(/\\/g, "/");
    for (const f of scanTextForSecrets(content, rel)) {
      // Only secret/credential categories here; sourcemap exposure is the bundle gate's job.
      if (f.category === "sourcemap-exposure") continue;
      if (f.severity === "critical" || f.severity === "high") {
        findings.push({
          ruleId: `CONFIG-${f.ruleId}`,
          severity: f.severity,
          file: rel,
          line: f.line,
          message: f.message,
          remediation: f.remediation,
        });
      }
    }
  }
  return { findings, scanned };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export function runConfigSupplyChainGate(options: ConfigGateOptions = {}): ConfigGateResult {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const mcp = scanMcpConfigs(rootDir);
  const hooks = scanSettingsHooks(rootDir);
  const secrets = scanConfigSecrets(rootDir, options.changedFiles ?? []);

  const findings = dedupe([...mcp.findings, ...hooks.findings, ...secrets.findings]);
  const counts = { critical: 0, high: 0, medium: 0, low: 0, total: findings.length };
  for (const f of findings) counts[f.severity] += 1;

  const blocked = counts.critical > 0 || counts.high > 0;
  const scannedFiles = mcp.scanned + hooks.scanned + secrets.scanned;
  const summary = blocked
    ? `설정·공급망 보안 게이트 차단: critical ${counts.critical}, high ${counts.high} (검사 파일 ${scannedFiles}개)`
    : `설정·공급망 보안 게이트 통과 (검사 파일 ${scannedFiles}개, 발견 ${counts.total}건)`;

  return { passed: !blocked, blocked, findings, counts, scannedFiles, summary };
}

function dedupe(findings: ConfigThreatFinding[]): ConfigThreatFinding[] {
  const seen = new Set<string>();
  const out: ConfigThreatFinding[] = [];
  for (const f of findings) {
    const key = `${f.ruleId}|${f.file}|${f.line ?? 0}|${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function changedFilesAgainst(ref: string, rootDir: string): string[] {
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", `${ref}...HEAD`], {
      cwd: rootDir,
      encoding: "utf8",
    });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function isMain(): boolean {
  try {
    return process.argv[1] ? import.meta.url === new URL(`file://${process.argv[1]}`).href : false;
  } catch {
    return false;
  }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const rootIdx = argv.indexOf("--root");
  const rootArg = rootIdx >= 0 ? argv[rootIdx + 1] : undefined;
  const rootDir = rootArg ? resolve(rootArg) : process.cwd();
  const changedIdx = argv.indexOf("--changed");
  const asJson = argv.includes("--json");
  const changedRef = changedIdx >= 0 ? argv[changedIdx + 1] ?? "origin/main" : null;
  const changedFiles = changedRef ? changedFilesAgainst(changedRef, rootDir) : [];

  const result = runConfigSupplyChainGate({ rootDir, changedFiles });

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n🔒 설정·공급망 보안 게이트`);
    console.log(`   ${result.summary}`);
    for (const f of result.findings) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      console.log(`   [${f.severity.toUpperCase()}] ${f.ruleId}  ${loc}`);
      console.log(`      ${f.message}`);
      console.log(`      ↳ ${f.remediation}`);
    }
    if (result.passed) console.log(`   ✓ 통과`);
  }
  process.exit(result.blocked ? 1 : 0);
}
