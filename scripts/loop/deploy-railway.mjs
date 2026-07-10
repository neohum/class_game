// deploy-railway.mjs — non-interactive production deploy via the Railway CLI.
//
// This is the LAST link in the autonomous loop and the ONLY one that mutates
// production. It is never run on a timer or by the Builder/Reviewer — it is
// spawned by telegram-listener.mjs only after a human taps "✅ 배포 승인"
// (approve). The human approval is the gate; this script just executes it.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ SECURITY — USE A PROJECT-SCOPED TOKEN, NEVER AN ACCOUNT API KEY.          │
// │                                                                           │
// │ RAILWAY_TOKEN must be a *project/environment* token, minted from a single │
// │ Railway project's Settings → Tokens and bound to one environment (e.g.    │
// │ "production"). It must NOT be an account-wide API token.                  │
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
// Required env:
//   RAILWAY_TOKEN   project/environment-scoped Railway token (NOT account key)
//
// Requires the Railway CLI on PATH (`npm i -g @railway/cli`).

import { spawn } from "node:child_process";
import { log } from "./telemetry.mjs";

/**
 * Trigger a detached production deploy. Returns the railway exit code.
 * @param {{card?:string}} [opts]  card is for telemetry/logging only
 * @returns {Promise<number>} the process exit code from `railway up`
 */
export async function deploy({ card } = {}) {
  const token = process.env.RAILWAY_TOKEN;
  if (!token) {
    console.error(
      [
        "missing required env: RAILWAY_TOKEN",
        "",
        "It MUST be a project/environment-scoped token (Railway project →",
        "Settings → Tokens), never an account-wide API key. An account key, if",
        "leaked from this autonomous box, compromises every project you own; a",
        "project token is isolated to this one project + environment.",
      ].join("\n"),
    );
    process.exit(2);
  }

  // --detach: fire the deploy and return immediately instead of holding the
  //           build/deploy log stream open (this script is short-lived).
  // --ci:     suppress all interactive prompts so it never blocks on input.
  const args = ["up", "--detach", "--ci"];

  const code = await new Promise((resolveCode) => {
    const child = spawn("railway", args, {
      stdio: "inherit",
      env: { ...process.env, RAILWAY_TOKEN: token },
      // On Windows the binary is railway.cmd; spawning via the shell lets the
      // OS resolve the .cmd shim. POSIX uses a direct exec (no shell needed).
      shell: process.platform === "win32",
    });

    child.on("error", (err) => {
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
    await log("deploy", { card, actor: "railway", detail: { card, code } });
  } catch { /* telemetry must never break the deploy */ }

  return code;
}

// CLI: `node scripts/loop/deploy-railway.mjs [card]`
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const [card] = process.argv.slice(2);
  deploy({ card })
    .then((code) => process.exit(code))
    .catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
}
