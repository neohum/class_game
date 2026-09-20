#!/usr/bin/env node
// agent-session.ts — one-shot interactive task runner with cross-provider failover.
// Usage: node scripts/agent-session.ts --agent claude "task"

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WINDOWS, inCooldown, parseResetTime, setCooldown } from "./loop/cooldown.ts";
import { agyCliBin } from "./loop/agy-cli.ts";
import { sandboxSummary, spawnSandboxed } from "./loop/sandbox.ts";

export function ensureHarnessUpdated(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  if (env.HARNESS_AUTO_UPDATE === "0" || env.CAH_AUTO_UPDATE === "0") return;
  const script = resolve(cwd, "scripts", "check-updates.ts");
  if (!existsSync(script)) return;
  try {
    spawnSync(process.execPath, [script], {
      cwd,
      env: { ...env, HARNESS_AUTO_UPDATE: "1" },
      stdio: "inherit",
      timeout: 15000,
      windowsHide: true,
    });
  } catch {}
}


const AGENTS = ["claude", "codex", "agy", "gemini"];
// "usage limit" without a verb: codex says "hit your usage limit", not "reached".
const LIMIT_RE = /usage limit|limit reached|rate[_ ]?limit|exceed your account|too many requests|quota|subscription|resource exhausted|\b429\b/i;
const MAX_CONTEXT = 48_000;

function parseArgs(argv: string[]) {
  const out: { agent: string; sameProviderOnly: boolean; help?: boolean; task: string[] } =
    { agent: "claude", sameProviderOnly: false, task: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--agent") out.agent = argv[++i] ?? "";
    else if (arg.startsWith("--agent=")) out.agent = arg.slice("--agent=".length);
    else if (arg === "--same-provider-only") out.sameProviderOnly = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else out.task.push(arg);
  }
  return { ...out, task: out.task.join(" ").trim() };
}

function cooldownKey(agent: string): string {
  return agent === "agy" ? "antigravity" : agent;
}

function commandExists(name: string): boolean {
  const probe = process.platform === "win32"
    ? spawnSync("where", [name], { stdio: "ignore", windowsHide: true })
    : spawnSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", name], { stdio: "ignore" });
  return probe.status === 0;
}

export function installed(agent: string): boolean {
  if (agent === "agy") {
    const modern = process.platform === "win32" ? Boolean(agyCliBin()) : commandExists("agy");
    return modern || commandExists("antigravity");
  }
  return commandExists(agent);
}

export function isLimitOutput(output: unknown): boolean {
  return LIMIT_RE.test(String(output || ""));
}

// `platform` is injectable so the Windows argv-safety guard is testable on any host.
export function commandFor(
  agent: string,
  prompt: string,
  env: NodeJS.ProcessEnv,
  model: string | null = null,
  cwd = process.cwd(),
  platform = process.platform,
  resolveAgyBin: () => string | null = agyCliBin,
): AgentCommand {
  const speedMode = env.HARNESS_SPEED || "balanced";
  const defaultClaude = speedMode === "fast" ? "sonnet" : "opus";
  const defaultEffort = speedMode === "fast" ? "medium" : "high";
  const reasoningEffort = env.AGENT_REASONING_EFFORT || defaultEffort;

  if (agent === "claude") {
    return {
      bin: platform === "win32" ? "claude.exe" : "claude",
      args: ["-p", "--model", model || env.CLAUDE_MODEL || defaultClaude, prompt],
    };
  }
  if (agent === "codex") {
    const args = ["exec"];
    if (sandboxSummary(env, cwd).isolated) args.push("--dangerously-bypass-approvals-and-sandbox");
    if (model || env.CODEX_MODEL) args.push("-m", (model || env.CODEX_MODEL)!);
    args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
    // `-` makes codex read the prompt from stdin. On Windows the CLI is a .cmd
    // shim, which Node >=20.12 only spawns under shell:true — and cmd.exe then
    // re-parses argv, so a prompt containing & | " ^ is truncated or partly
    // EXECUTED. Passing it over stdin keeps the shell out of the prompt entirely.
    args.push("-");
    const win = platform === "win32";
    // shell:true is required for the .cmd shim and is only safe because every
    // remaining arg is a fixed literal — the untrusted prompt goes via stdin.
    return { bin: win ? "codex.cmd" : "codex", args, stdin: prompt, ...(win ? { shell: true } : {}) };
  }
  if (agent === "agy") {
    const modernBin = (resolveAgyBin as (opts?: unknown) => string | null)({ platform, env });
    const modern = Boolean(modernBin);
    const bin = modern ? modernBin! : (platform === "win32" ? "antigravity.cmd" : "antigravity");
    const args = [...(model || env.AGY_MODEL ? ["--model", (model || env.AGY_MODEL)!] : []), modern ? "--print" : "-p", prompt];
    return { bin, args };
  }
  const win = platform === "win32";
  if (win) {
    // Same .cmd + cmd.exe re-parsing hazard as codex, but gemini's parser
    // rejects an empty `-p` ("Not enough arguments following: p"), so the flag
    // is omitted entirely — a piped stdin alone puts it in headless mode.
    const args = [...(model || env.GEMINI_MODEL ? ["-m", (model || env.GEMINI_MODEL)!] : [])];
    return { bin: "gemini.cmd", args, stdin: prompt, shell: true };
  }
  const args = [...(model || env.GEMINI_MODEL ? ["-m", (model || env.GEMINI_MODEL)!] : []), "-p", prompt];
  return { bin: "gemini", args };
}

function gitContext(cwd: string): string {
  const run = (args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, windowsHide: true });
    return r.status === 0 ? (r.stdout || "").trim() : "";
  };
  const status = run(["status", "--short"]);
  const diff = run(["diff", "--no-ext-diff", "--"]);
  return [status && `Git status:\n${status}`, diff && `Working-tree diff:\n${diff}`]
    .filter(Boolean).join("\n\n").slice(-MAX_CONTEXT);
}

function handoffPrompt(originalTask: string, from: string, output: unknown, cwd: string): string {
  const failure = String(output || "").slice(-8_000);
  const repo = gitContext(cwd);
  return [
    `Continue a task handed off from ${from}, which reached its provider limit.`,
    "Inspect the repository before acting. Preserve completed work and do not repeat successful steps.",
    `Original task:\n${originalTask}`,
    failure && `Previous agent's final output:\n${failure}`,
    repo,
  ].filter(Boolean).join("\n\n");
}

export function runnerStdio(input: { isTTY?: boolean } = process.stdin) {
  return [input?.isTTY ? "inherit" : "ignore", "pipe", "pipe"];
}

/** A resolved agent command: which binary, with what argv, and how the prompt gets in. */
interface AgentCommand {
  bin: string;
  args: string[];
  stdin?: string;
  shell?: boolean;
}

interface RunnerResult {
  code: number | null;
  output: string;
}

function spawnRunner(agent: string, prompt: string, { cwd, env, model }: { cwd: string; env: NodeJS.ProcessEnv; model: string | null }): Promise<RunnerResult> {
  const cmd = commandFor(agent, prompt, env, model, cwd);
  return new Promise<RunnerResult>((resolveRun) => {
    let output = "";
    const stdio = runnerStdio();
    const child = spawnSandboxed(cmd.bin, cmd.args, {
      cwd,
      env,
      // A prompt delivered over stdin needs a writable pipe, not the inherited tty.
      stdio: cmd.stdin == null ? stdio : ["pipe", stdio[1], stdio[2]],
      windowsHide: true,
      ...(cmd.shell === undefined ? {} : { shell: cmd.shell }),
    });
    if (cmd.stdin != null) {
      child.stdin?.on("error", () => {});   // child may exit before we finish writing
      child.stdin?.end(cmd.stdin);
    }
    const pipes: Array<[NodeJS.ReadableStream | null, NodeJS.WriteStream]> = [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ];
    for (const [stream, target] of pipes) {
      stream?.on("data", (chunk: Buffer) => {
        target.write(chunk);
        output = (output + chunk.toString()).slice(-MAX_CONTEXT);
      });
    }
    child.on("error", (error: NodeJS.ErrnoException) => resolveRun({ code: error.code === "ENOENT" ? 127 : 1, output: `${output}\n${error.message}` }));
    child.on("exit", (code) => resolveRun({ code: code ?? 1, output }));
  });
}

export function providerModels(agent: string, env: NodeJS.ProcessEnv = process.env): Array<string | null> {
  const key = `${agent.toUpperCase()}_MODEL`;
  const fallbackKey = `${agent.toUpperCase()}_FALLBACK_MODELS`;
  const names = [env[key], ...(env[fallbackKey] || "").split(",")]
    .map((x) => String(x || "").trim()).filter(Boolean);
  return names.length ? [...new Set(names)] : [null];
}

function failoverPriority(agent: string, env: NodeJS.ProcessEnv): string[] {
  const override = String(env.HARNESS_AGENT_FAILOVER_ORDER || "")
    .split(",")
    .map((name) => name.trim().toLowerCase() === "antigravity" ? "agy" : name.trim().toLowerCase())
    .filter((name) => AGENTS.includes(name));
  const defaults = agent === "claude" ? ["agy", "codex", "gemini"]
    : agent === "codex" ? ["agy", "gemini", "claude"]
      : agent === "agy" ? ["codex", "gemini", "claude"]
        : ["codex", "agy", "claude"];
  return [...new Set([...override, ...defaults])].filter((name) => name !== agent);
}

export function fallbackRoster(agent: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return [agent, ...failoverPriority(agent, env)];
}

export async function runSession({
  agent = "claude",
  task,
  cwd = process.cwd(),
  env = process.env,
  runAgent = spawnRunner,
  isInstalled = installed,
  isCoolingDown = inCooldown,
  setAgentCooldown = setCooldown,
  sameProviderOnly = false,
}: {
  agent?: string;
  task?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runAgent?: typeof spawnRunner;
  isInstalled?: (agent: string) => boolean;
  isCoolingDown?: (agent: string) => boolean;
  setAgentCooldown?: typeof setCooldown;
  sameProviderOnly?: boolean;
} = {}) {
  if (!AGENTS.includes(agent)) throw new Error(`unknown agent: ${agent}`);
  if (!task?.trim()) throw new Error("task is required");

  // Keep the explicitly requested provider first (including its configured
  // model fallbacks). Cross-provider execution spends the non-Claude lanes
  // before Claude, unless Claude was the primary.
  const roster = sameProviderOnly ? [agent] : fallbackRoster(agent, env);
  const usable = roster.filter((name) => isInstalled(name) && !isCoolingDown(cooldownKey(name)));
  if (!usable.length) return { code: 75, agent: null, attempts: [], reason: "no available agent CLI" };
  const candidates = usable.flatMap((name) => providerModels(name, env).map((model) => ({ name, model })));

  let prompt = task;
  const attempts: string[] = [];
  for (let index = 0; index < candidates.length; index++) {
    const current = candidates[index]!;
    if (attempts.length) console.warn(`\n[Harness] Switching to ${current.name}${current.model ? ` (${current.model})` : ""} with handoff context...`);
    const result = await runAgent(current.name, prompt, { cwd, env, model: current.model });
    attempts.push(current.name);
    if (result.code === 0) return { code: 0, agent: current.name, attempts };
    if (!isLimitOutput(result.output)) return { code: result.code, agent: current.name, attempts, reason: "non-limit failure" };

    const nextSameAgent = candidates[index + 1]?.name === current.name;
    if (nextSameAgent) {
      prompt = handoffPrompt(task, `${current.name}${current.model ? ` (${current.model})` : ""}`, result.output, cwd);
      continue;
    }
    const key = cooldownKey(current.name);
    const windows = DEFAULT_WINDOWS as Record<string, number>;
    const until = parseResetTime(result.output) ?? (Date.now() + (windows[key] ?? windows.claude!));
    setAgentCooldown(key, until, { reason: `agent-session exit ${result.code}: limit detected` });
    console.warn(`\n[Harness] ${current.name} limit detected. Cooldown until ${new Date(until).toISOString()}.`);
    prompt = handoffPrompt(task, current.name, result.output, cwd);
  }
  return { code: 75, agent: attempts.at(-1) ?? null, attempts, reason: "all available agents reached a limit" };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/agent-session.ts [--agent claude|codex|agy|gemini] [--same-provider-only] "task"');
    return;
  }
  ensureHarnessUpdated(process.cwd());
  try {
    const result = await runSession(args);

    if (result.code !== 0) console.error(`[Harness] Session stopped: ${result.reason}.`);
    process.exitCode = result.code;
  } catch (error) {
    console.error(`[Harness] ${(error as Error)?.message}`);
    process.exitCode = 2;
  }
}

// `import.meta.url` is realpath-resolved by the loader, while `process.argv[1]` is
// the raw path the caller typed. On a symlinked path (macOS /tmp -> /private/tmp,
// /var -> /private/var, linked checkouts) the two differ and a naive comparison
// makes this CLI silently no-op with exit 0. Compare both through realpath.
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) await main();
