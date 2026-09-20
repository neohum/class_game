// sandbox.ts — fail-closed execution boundary for model-controlled commands.
// Autonomous agents run in Docker by default. Host execution exists only as an
// explicit local-development escape hatch: HARNESS_SANDBOX_MODE=host together
// with HARNESS_ALLOW_HOST_EXEC=1.

import { resolve, relative, isAbsolute, sep, join } from "node:path";
import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const DEFAULT_IMAGE = "agent-harness:local";
const DEFAULT_WORKDIR = "/workspace";
const DEFAULT_ENV_ALLOW = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "LOOP_CARD", "FORCE_FALLBACK", "USE_FALLBACK",
];

type Env = NodeJS.ProcessEnv;

/** How a caller asks for a sandboxed spawn. All optional — the defaults are the safe ones. */
export interface SandboxOptions {
  root?: string;
  cwd?: string;
  env?: Env;
  envAllow?: string[];
  workspaceReadOnly?: boolean;
  stdio?: unknown;
  // Passed straight through to spawn by callers that need them.
  windowsHide?: boolean;
  shell?: boolean;
}

import { isUnattended, unattendedHostAllowed, UNATTENDED_HOST_ACK_ENV, GOVERNED_OPT_OUTS } from "./autonomy.ts";

function trustedSelfHostEnv(env: Env, root: string): Env {
  if (env.HARNESS_SANDBOX_MODE || !existsSync(resolve(root, ".harness-selfhost"))) return env;
  return { ...env, HARNESS_SANDBOX_MODE: "host", HARNESS_ALLOW_HOST_EXEC: "1" };
}

function mode(env = process.env) {
  if (env.HARNESS_INSIDE_SANDBOX === "1") return "inside";
  return String(env.HARNESS_SANDBOX_MODE || "docker").toLowerCase();
}

function allowedEnv(env: Env, extraNames: string[] = []): Record<string, string> {
  const names = new Set([
    ...DEFAULT_ENV_ALLOW,
    ...String(env.HARNESS_SANDBOX_ENV_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean),
    ...extraNames,
  ]);
  const out: Record<string, string> = { HARNESS_INSIDE_SANDBOX: "1" };
  for (const name of names) if (env[name] != null) out[name] = String(env[name]);
  for (const [name, value] of Object.entries(env)) {
    if (/^HEALTH_[A-Z0-9_]+$/.test(name) && value != null) out[name] = String(value);
  }
  return out;
}

function mapPath(value: unknown, root: string, workdir: string): string {
  const text = String(value);
  if (!isAbsolute(text)) return text;
  const rel = relative(root, resolve(text));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
    return rel ? `${workdir}/${rel.split(sep).join("/")}` : workdir;
  }
  return text;
}

export interface SandboxCommand {
  bin: string;
  args: string[];
  spawnOptions: SpawnOptions;
}

export function sandboxCommand(bin: string, args: string[] = [], options: SandboxOptions = {}): SandboxCommand {
  const root = resolve(options.root || options.cwd || process.cwd());
  const env = trustedSelfHostEnv(options.env || process.env, root);
  const selected = mode(env);

  // Only spawn's own options travel through. Spreading the caller's bag used to
  // hand envAllow/workspaceReadOnly/root to spawn as well — harmless in practice,
  // but it made the boundary between "how to sandbox" and "how to spawn" invisible.
  const passthrough = (): SpawnOptions => ({
    env,
    cwd: options.cwd || root,
    stdio: (options.stdio ?? "inherit") as SpawnOptions["stdio"],
    ...(options.windowsHide === undefined ? {} : { windowsHide: options.windowsHide }),
    ...(options.shell === undefined ? {} : { shell: options.shell }),
  });

  if (selected === "inside") {
    return { bin, args, spawnOptions: passthrough() };
  }

  if (selected === "host") {
    // The sandbox is the one guard whose failure is not recoverable by a later
    // gate: every other guard lets a bad diff through, this one lets the agent
    // out of the box. So the escape hatch is refused outright for an unattended
    // run rather than logged-and-honoured like the other opt-outs.
    if (isUnattended(env) && !unattendedHostAllowed(env)) {
      throw new Error(
        `host execution refused: ${GOVERNED_OPT_OUTS.sandbox.name} needs ${UNATTENDED_HOST_ACK_ENV}=1 on an `
        + "unattended run. HARNESS_ALLOW_HOST_EXEC is the local-dev switch and can be inherited from a shell "
        + "profile; leaving the 24/7 loop unsandboxed has to be said on purpose.",
      );
    }
    if (env.HARNESS_ALLOW_HOST_EXEC !== "1") {
      throw new Error("host execution refused: set HARNESS_ALLOW_HOST_EXEC=1 only for trusted local development");
    }
    return { bin, args, spawnOptions: passthrough() };
  }

  if (selected !== "docker") throw new Error(`unsupported HARNESS_SANDBOX_MODE=${selected}`);

  const workdir = env.HARNESS_SANDBOX_WORKDIR || DEFAULT_WORKDIR;
  let safeBin = resolve(bin) === resolve(process.execPath) ? "node" : mapPath(bin, root, workdir);
  // The sandbox image is Linux. A Windows launcher suffix (.cmd/.bat/.exe) on a
  // bare command name (e.g. codex.cmd, the win32 branch of invoke-*.ts) has no
  // equivalent inside the container — exec the base command name instead.
  if (!safeBin.includes("/") && !safeBin.includes(sep)) {
    safeBin = safeBin.replace(/\.(cmd|bat|exe)$/i, "");
  }
  const safeArgs = args.map((arg) => mapPath(arg, root, workdir));
  const safeEnv = allowedEnv(env, options.envAllow || []);
  const dockerArgs = [];
  const image = env.HARNESS_SANDBOX_IMAGE || DEFAULT_IMAGE;
  dockerArgs.push(
    "run", "--rm", "--init", "-i",
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",
    "--pids-limit", env.HARNESS_SANDBOX_PIDS || "256",
    "--memory", env.HARNESS_SANDBOX_MEMORY || "4g",
    "--cpus", env.HARNESS_SANDBOX_CPUS || "2",
    "--network", env.HARNESS_SANDBOX_NETWORK || "bridge",
    "-v", `${root}:${workdir}${options.workspaceReadOnly ? ":ro" : ""}`,
    "-w", workdir,
  );
  // The data plane is writable, but the harness control plane is over-mounted
  // read-only so an agent cannot rewrite a helper and have the host execute it.
  for (const rel of ["scripts/loop", "scripts/invoke-claude.ts", "scripts/invoke-codex.ts", "scripts/invoke-agy.ts", "scripts/invoke-gemini.ts", "AGENTS.md"]) {
    const hostPath = resolve(root, rel);
    if (existsSync(hostPath)) dockerArgs.push("-v", `${hostPath}:${workdir}/${rel.split(sep).join("/")}:ro`);
  }
  // Codex authenticates against the developer's account via its login state in
  // ~/.codex (auth.json OAuth tokens), not an API key. Mount that home into the
  // container so the sandboxed builder reuses the logged-in session — writable
  // so codex can refresh the access token back to the host. Opt out with
  // HARNESS_MOUNT_CODEX_HOME=0; relocate the source with HARNESS_CODEX_HOME.
  if (env.HARNESS_MOUNT_CODEX_HOME !== "0") {
    const codexHome = env.HARNESS_CODEX_HOME || join(homedir(), ".codex");
    if (existsSync(codexHome)) dockerArgs.push("-v", `${codexHome}:/root/.codex`);
  }
  for (const [name, value] of Object.entries(safeEnv)) dockerArgs.push("-e", `${name}=${value}`);
  dockerArgs.push(image, safeBin, ...safeArgs);

  return {
    bin: process.platform === "win32" ? "docker.exe" : "docker",
    args: dockerArgs,
    spawnOptions: {
      cwd: root,
      env: process.env,
      shell: false,
      stdio: (options.stdio ?? "inherit") as SpawnOptions["stdio"],
    } satisfies SpawnOptions,
  };
}

export function spawnSandboxed(bin: string, args: string[] = [], options: SandboxOptions = {}) {
  const cmd = sandboxCommand(bin, args, options);
  return spawn(cmd.bin, cmd.args, cmd.spawnOptions);
}

export function sandboxSummary(env = process.env, root = process.cwd()) {
  const effectiveEnv = trustedSelfHostEnv(env, root);
  const selected = mode(effectiveEnv);
  return {
    mode: selected,
    isolated: selected === "docker" || selected === "inside",
    target: effectiveEnv.HARNESS_SANDBOX_IMAGE || DEFAULT_IMAGE,
  };
}
