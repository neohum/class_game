// integration-doctor.ts — report optional delivery integrations without making
// the core harness depend on them.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type CommandProbe = (command: string, args: string[]) => ProbeResult;

export interface IntegrationState {
  installed: boolean;
  configured: boolean;
  requested: boolean;
  state: "disabled" | "ready" | "degraded";
  version: string | null;
  nextCommand: string;
}

export interface IntegrationReport {
  ok: true;
  integrations: {
    ghAw: IntegrationState;
    dagger: IntegrationState;
  };
}

const defaultProbe: CommandProbe = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000, windowsHide: true });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || String(result.error?.message || ""),
  };
};

function firstLine(value: string): string | null {
  const line = value.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  return line ? line.slice(0, 160) : null;
}

function oneState(input: {
  requested: boolean;
  configured: boolean;
  result: ProbeResult;
  nextCommand: string;
}): IntegrationState {
  const installed = input.result.status === 0;
  return {
    installed,
    configured: input.configured,
    requested: input.requested,
    state: !input.requested ? "disabled" : installed && input.configured ? "ready" : "degraded",
    version: installed ? firstLine(input.result.stdout || input.result.stderr) : null,
    nextCommand: input.nextCommand,
  };
}

export function integrationStatus({
  cwd = process.cwd(),
  env = process.env,
  probe = defaultProbe,
}: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  probe?: CommandProbe;
} = {}): IntegrationReport {
  const root = resolve(cwd);
  const ghAw = probe("gh", ["aw", "--version"]);
  const dagger = probe("dagger", ["version"]);
  return {
    // Optional tools can be unavailable without changing the health of Ralph,
    // the browser Studio, or the release policy.
    ok: true,
    integrations: {
      ghAw: oneState({
        requested: env.HARNESS_GH_AW === "1",
        configured: existsSync(join(root, ".github", "workflows", "harness-ci-doctor.md")),
        result: ghAw,
        nextCommand: "gh extension install github/gh-aw && gh aw compile",
      }),
      dagger: oneState({
        requested: env.HARNESS_DAGGER === "1",
        configured: existsSync(join(root, "dagger.json")) && existsSync(join(root, ".dagger", "main.go")),
        result: dagger,
        nextCommand: "install Dagger, run dagger develop, then dagger check",
      }),
    },
  };
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); }
  catch { return false; }
})();

if (isMainModule) console.log(JSON.stringify(integrationStatus(), null, 2));
