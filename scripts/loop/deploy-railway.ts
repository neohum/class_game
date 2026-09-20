// deploy-railway.ts — non-interactive environment deploy via the Railway CLI.
//
// This is the release mutation primitive. Ralph or the decision listener calls
// it only after the persona-or-human gate, once per promotion stage. It never
// decides whether a release is allowed; release-policy.ts owns stage order.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ SECURITY — USE A PROJECT-SCOPED TOKEN, NEVER AN ACCOUNT API KEY.          │
// │                                                                           │
// │ Every Railway token must be a *project/environment* token, minted from a  │
// │ single project's Settings → Tokens and bound to exactly one environment. │
// │ It must NOT be an account-wide API token.                                 │
// │                                                                           │
// │ Blast-radius reasoning: this token lives on an autonomous box where an    │
// │ agent has shell access; treat it as already-leaked when reasoning about   │
// │ worst case. An ACCOUNT token authenticates as you across EVERY project    │
// │ and environment you own — a leak lets an attacker redeploy, read vars,    │
// │ and tear down all of them. A PROJECT token can only touch the one         │
// │ project + environment it was scoped to, so a leak is contained to the     │
// │ blast radius of this single app. Scope down so the worst case is bounded. │
// └─────────────────────────────────────────────────────────────────────────┘
//
// Required env (each project/environment-scoped, never account-wide):
//   RAILWAY_STAGING_TOKEN | RAILWAY_CANARY_TOKEN | RAILWAY_TOKEN
//
// Requires the Railway CLI on PATH (`npm i -g @railway/cli`).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { log } from "./telemetry.ts";
import { realpathSync } from "node:fs";

export function tokenEnvForStage(stage = "production") {
  if (stage === "staging") return "RAILWAY_STAGING_TOKEN";
  if (stage === "canary") return "RAILWAY_CANARY_TOKEN";
  return "RAILWAY_TOKEN";
}

export function railwayArgs({ environment }: { environment?: string } = {}): string[] {
  const args = ["up", "--detach", "--ci"];
  if (environment) args.push("--environment", environment);
  return args;
}

/**
 * Trigger a detached environment deploy. Returns the railway exit code.
 * @param {{card?:string,stage?:string,environment?:string}} [opts]
 * @returns {Promise<number>} the process exit code from `railway up`
 */
export async function deploy({ card, stage = "production", environment }: { card?: string; stage?: string; environment?: string } = {}): Promise<number> {
  const tokenEnv = tokenEnvForStage(stage);
  const token = process.env[tokenEnv];
  if (!token) {
    console.error(
      [
        `missing required env: ${tokenEnv}`,
        "",
        "It MUST be a project/environment-scoped token (Railway project →",
        "Settings → Tokens), never an account-wide API key. An account key, if",
        "leaked from this autonomous box, compromises every project you own; a",
        "project token is isolated to this one project + environment.",
      ].join("\n"),
    );
    return 2;
  }

  // --detach: fire the deploy and return immediately instead of holding the
  //           build/deploy log stream open (this script is short-lived).
  // --ci:     suppress all interactive prompts so it never blocks on input.
  const args = railwayArgs({ environment });

  const code = await new Promise<number>((resolveCode) => {
    const child = spawn("railway", args, {
      stdio: "inherit",
      env: { ...process.env, RAILWAY_TOKEN: token },
      // On Windows the binary is railway.cmd; spawning via the shell lets the
      // OS resolve the .cmd shim. POSIX uses a direct exec (no shell needed).
      shell: process.platform === "win32",
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        console.error("railway CLI not found — install it with: npm i -g @railway/cli");
        resolveCode(127);
      } else {
        console.error(`failed to spawn railway: ${err.message}`);
        resolveCode(1);
      }
    });

    child.on("close", (c) => resolveCode(c ?? 0));
  });

  try {
    await log("deploy", { card, actor: "railway", detail: { card, stage, environment, code } });
  } catch { /* telemetry must never break the deploy */ }

  return code;
}

// CLI: `node scripts/loop/deploy-railway.ts [card] [--stage staging|canary|production] [--environment name]`
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

if (isMainModule) {
  const argv = process.argv.slice(2);
  const card = argv.find((arg) => !arg.startsWith("--"));
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    if (index !== -1) return argv[index + 1];
    return argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  };
  const stage = value("--stage") || "production";
  const environment = value("--environment");
  deploy({ card, stage, environment })
    .then((code) => process.exit(code))
    .catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
}
