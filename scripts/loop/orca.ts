#!/usr/bin/env node
/**
 * orca.ts — Unified Fast Bridge & Multi-Agent Interface for Orca.
 *
 * Provides instant access to all Orca features for Claude, Codex, AGY, and Gemini:
 *   1. Worktrees management (ps, create, remove, comments)
 *   2. Terminal automation (list, send, read, wait, kill)
 *   3. Embedded browser control & automation (navigate, screenshot, eval, click, type)
 *   4. Multi-agent orchestration (task create, dispatch, DAGs, decision gates)
 *   5. Linear integration (issue context, triage, PR/MR attach)
 *   6. Automations, artifacts sharing, and version-matched skills extraction
 *
 * Usage:
 *   node scripts/loop/orca.ts status [--json]
 *   node scripts/loop/orca.ts guide <skill-name>
 *   node scripts/loop/orca.ts context [--json]
 *   node scripts/loop/orca.ts worktree <ps|create|rm> [args...]
 *   node scripts/loop/orca.ts terminal <list|send|read|wait> [args...]
 *   node scripts/loop/orca.ts browser <navigate|screenshot|eval> [args...]
 *   node scripts/loop/orca.ts orchestrate <run|task|list|wait> [args...]
 *   node scripts/loop/orca.ts linear <issue|attach|triage> [args...]
 *   node scripts/loop/orca.ts exec <raw orca args...>
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { resolve } from "node:path";
import { log } from "./telemetry.ts";

const ROOT = resolve(process.cwd());

export interface OrcaExecResult {
  ok: boolean;
  status: number | null;
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  data?: unknown;
}

/**
 * Resolves the appropriate Orca executable for this environment.
 * Order of precedence:
 *   1. ORCA_CLI_COMMAND env var (exported by Orca in managed WSL/remote sessions)
 *   2. orca-dev in a dev checkout exposing ORCA_DEV_REPO_ROOT
 *   3. orca-ide on Linux outside Orca-managed terminal (prevents GNOME screenreader conflict)
 *   4. orca
 */
export function resolveOrcaBinary(): string {
  if (process.env.ORCA_CLI_COMMAND) {
    return process.env.ORCA_CLI_COMMAND;
  }
  if (process.env.ORCA_DEV_REPO_ROOT) {
    return "orca-dev";
  }
  if (process.platform === "linux" && !process.env.ORCA_TERMINAL_ID) {
    return "orca-ide";
  }
  return "orca";
}

/**
 * Executes an Orca CLI command with automatic binary resolution and JSON parsing.
 */
export function runOrca(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): OrcaExecResult {
  const binary = resolveOrcaBinary();
  const cwd = options.cwd || ROOT;
  const timeout = options.timeoutMs || 30_000;

  try {
    const res: SpawnSyncReturns<string> = spawnSync(binary, args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout,
      env: { ...process.env, ...options.env },
    });

    const stdout = res.stdout ? String(res.stdout).trim() : "";
    const stderr = res.stderr ? String(res.stderr).trim() : "";
    const ok = res.status === 0;

    let data: unknown = undefined;
    if (args.includes("--json") || args.includes("-j")) {
      try {
        data = JSON.parse(stdout);
      } catch {}
    }

    if (!ok && !stderr && res.error) {
      return {
        ok: false,
        status: res.status,
        command: binary,
        args,
        stdout,
        stderr: res.error.message,
      };
    }

    return {
      ok,
      status: res.status,
      command: binary,
      args,
      stdout,
      stderr,
      data,
    };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    return {
      ok: false,
      status: 1,
      command: binary,
      args,
      stdout: "",
      stderr: message,
    };
  }
}

/**
 * Checks Orca application status.
 */
export function getOrcaStatus(): OrcaExecResult {
  return runOrca(["status", "--json"]);
}

/**
 * Fetches version-matched skill guide directly from the Orca binary.
 */
export function getOrcaSkillGuide(skillName = "orca-cli"): OrcaExecResult {
  return runOrca(["skills", "get", skillName]);
}

/**
 * Dumps full machine-readable agent context & schema.
 */
export function getOrcaAgentContext(): OrcaExecResult {
  return runOrca(["agent-context"]);
}

/**
 * Manages Orca worktrees (ps, create, remove).
 */
export function orcaWorktree(subcommand: string, extraArgs: string[] = []): OrcaExecResult {
  return runOrca(["worktree", subcommand, ...extraArgs, "--json"]);
}

/**
 * Manages Orca terminals (list, send, read, wait, kill).
 */
export function orcaTerminal(subcommand: string, extraArgs: string[] = []): OrcaExecResult {
  return runOrca(["terminal", subcommand, ...extraArgs, "--json"]);
}

/**
 * Controls Orca embedded browser.
 */
export function orcaBrowser(subcommand: string, extraArgs: string[] = []): OrcaExecResult {
  return runOrca(["browser", subcommand, ...extraArgs, "--json"]);
}

/**
 * Runs multi-agent orchestration flows and DAGs.
 */
export function orcaOrchestrate(subcommand: string, extraArgs: string[] = []): OrcaExecResult {
  return runOrca(["orchestration", subcommand, ...extraArgs, "--json"]);
}

/**
 * Linear issue context and status management.
 */
export function orcaLinear(subcommand: string, extraArgs: string[] = []): OrcaExecResult {
  return runOrca(["linear", subcommand, ...extraArgs, "--json"]);
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  return process.argv[1].endsWith("orca.ts");
})();

if (isMainModule) {
  const [cmd, ...rest] = process.argv.slice(2);
  const isJson = rest.includes("--json") || rest.includes("-j");

  if (!cmd || cmd === "status") {
    const res = getOrcaStatus();
    if (res.ok) {
      if (isJson) {
        console.log(JSON.stringify(res.data ?? { status: "running", binary: res.command }, null, 2));
      } else {
        console.log(`[Orca Bridge] 상태: 정상 가동 중 (바이너리: ${res.command})`);
        console.log(res.stdout || "Orca application is running.");
      }
    } else {
      if (isJson) {
        console.log(JSON.stringify({ ok: false, error: res.stderr || "Orca is not running or binary not found", binary: res.command }, null, 2));
      } else {
        console.error(`[Orca Bridge] 실행 실패 (바이너리: ${res.command}):`);
        console.error(res.stderr || "Orca가 실행 중이 아니거나 바이너리를 찾을 수 없습니다. 'orca open'으로 실행하세요.");
      }
      process.exitCode = 1;
    }
  } else if (cmd === "guide") {
    const skill = rest[0] || "orca-cli";
    const res = getOrcaSkillGuide(skill);
    if (res.ok) {
      console.log(res.stdout);
    } else {
      console.error(`[Orca Guide] 스킬 '${skill}' 로드 실패:`, res.stderr);
      process.exitCode = 1;
    }
  } else if (cmd === "context") {
    const res = getOrcaAgentContext();
    if (res.ok) {
      console.log(res.stdout);
    } else {
      console.error(`[Orca Context] 컨텍스트 추출 실패:`, res.stderr);
      process.exitCode = 1;
    }
  } else if (cmd === "worktree") {
    const [action, ...args] = rest;
    const res = orcaWorktree(action || "ps", args);
    console.log(res.stdout || res.stderr);
    process.exitCode = res.ok ? 0 : 1;
  } else if (cmd === "terminal") {
    const [action, ...args] = rest;
    const res = orcaTerminal(action || "list", args);
    console.log(res.stdout || res.stderr);
    process.exitCode = res.ok ? 0 : 1;
  } else if (cmd === "browser") {
    const [action, ...args] = rest;
    const res = orcaBrowser(action || "status", args);
    console.log(res.stdout || res.stderr);
    process.exitCode = res.ok ? 0 : 1;
  } else if (cmd === "orchestrate") {
    const [action, ...args] = rest;
    const res = orcaOrchestrate(action || "task-list", args);
    console.log(res.stdout || res.stderr);
    process.exitCode = res.ok ? 0 : 1;
  } else if (cmd === "linear") {
    const [action, ...args] = rest;
    const res = orcaLinear(action || "issue", args);
    console.log(res.stdout || res.stderr);
    process.exitCode = res.ok ? 0 : 1;
  } else if (cmd === "exec") {
    const res = runOrca(rest);
    console.log(res.stdout || res.stderr);
    process.exitCode = res.ok ? 0 : 1;
  } else {
    console.log(`사용법: node scripts/orca.ts <status|guide|context|worktree|terminal|browser|orchestrate|linear|exec> [args...]`);
  }
}
