// decide.mjs — approve/reject a held deploy from wherever the human is.
//
// The persona gate (persona-approve.mjs) withholds anything sensitive, high
// blast-radius, or uncertain. Until now the ONLY way to release a hold was the
// Telegram inline button (telegram-listener.mjs). This module extracts those
// exact actions into one shared surface so the SAME decision can be made from
// the session prompt too:
//
//   node scripts/loop/decide.mjs pending             # cards awaiting a decision
//   node scripts/loop/decide.mjs approve <card>      # release the deploy
//   node scripts/loop/decide.mjs reject  <card>      # revert + requeue as open
//
// telegram-listener.mjs dispatches taps through these functions (actor
// "telegram"), and mcp-harness.mjs exposes them as decision_* typed tools, so
// an agent session can decide with a chat message instead of a phone tap.
//
// Held cards are tracked as .harness/pending/<card>.json markers: written by
// ralph-loop's ship node when the persona withholds a deploy, removed here on
// either decision. Both channels stay live simultaneously — whoever decides
// first wins; the second decision finds no pending marker and is refused
// unless forced.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { getBacklog } from "./backlog.mjs";
import { log } from "./telemetry.mjs";
import { recordLabel } from "./persona-feedback.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.cwd());
const STATE_DIR = resolve(process.env.HARNESS_STATE_DIR || resolve(ROOT, ".harness"));
const PENDING_DIR = resolve(STATE_DIR, "pending");
const REJECT_DIR = resolve(STATE_DIR, "reject");
const DEPLOY_SCRIPT = resolve(HERE, "deploy-railway.mjs");

function runCmd(bin, args = [], cwd = ROOT) {
  return new Promise((res) => {
    const child = spawn(bin, args, { cwd, shell: process.platform === "win32" });
    let stdout = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stdout += d.toString(); });
    child.on("exit", (code) => res({ code: code ?? 1, stdout }));
  });
}

// Fire the deploy without blocking the caller (poll loop, MCP server, CLI).
function spawnDeploy(card) {
  const child = spawn(process.execPath, [DEPLOY_SCRIPT, card], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/** ralph-loop's ship node calls this when the persona withholds a deploy. */
export function holdCard(card, reason = "") {
  mkdirSync(PENDING_DIR, { recursive: true });
  writeFileSync(
    resolve(PENDING_DIR, `${card}.json`),
    JSON.stringify({ card, reason, at: new Date().toISOString() }, null, 2) + "\n",
  );
}

/** Cards whose deploy is waiting for a human decision, oldest first. */
export function pendingCards() {
  if (!existsSync(PENDING_DIR)) return [];
  return readdirSync(PENDING_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try { return JSON.parse(readFileSync(resolve(PENDING_DIR, f), "utf8")); }
      catch { return { card: f.replace(/\.json$/, "") }; }
    })
    .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
}

function clearPending(card) {
  try { rmSync(resolve(PENDING_DIR, `${card}.json`)); return true; }
  catch { return false; }
}

/**
 * Release a held deploy. Mirrors the Telegram ✅ tap exactly: spawn the deploy,
 * record the ground-truth approve label, log to the trail, drop the marker.
 * @param {string} card
 * @param {{actor?:string, force?:boolean}} [opt] force skips the pending check
 *   (e.g. re-approving after a failed deploy attempt).
 */
export async function approveCard(card, { actor = "session", force = false } = {}) {
  const wasPending = clearPending(card);
  if (!wasPending && !force) {
    return { card, decision: null, error: `no pending decision for "${card}" (already decided? use force)` };
  }
  spawnDeploy(card);
  try { recordLabel({ card, label: "approve", source: actor }); } catch {}
  try { await log("approve", { card, actor, detail: { card } }); } catch {}
  return { card, decision: "approve", deployed: true };
}

/**
 * Reject a held (or already-deployed) card. Mirrors the Telegram ❌ tap:
 * write the reject marker (ralph-loop re-injects it on the next prime),
 * record the label, revert the loop:<card> commit if one exists, push,
 * redeploy the reverted tree, and reopen the card so the builder retries.
 */
export async function rejectCard(card, { actor = "session", force = false } = {}) {
  const wasPending = clearPending(card);
  if (!wasPending && !force) {
    return { card, decision: null, error: `no pending decision for "${card}" (already decided? use force)` };
  }

  mkdirSync(REJECT_DIR, { recursive: true });
  writeFileSync(
    resolve(REJECT_DIR, `${card}.json`),
    JSON.stringify({ card, at: new Date().toISOString() }, null, 2) + "\n",
  );
  try { recordLabel({ card, label: "reject", source: actor }); } catch {}

  const logRes = await runCmd("git", ["log", `--grep=loop:${card}`, "-n", "1", "--format=%H"]);
  const commitHash = logRes.stdout.trim();
  let rolledBack = false;
  if (commitHash) {
    const revertRes = await runCmd("git", ["revert", commitHash, "--no-edit"]);
    if (revertRes.code === 0) {
      await runCmd("git", ["push"]);
      spawnDeploy(card);
      rolledBack = true;
    }
  }

  try {
    const backlog = await getBacklog();
    backlog.setStatus(card, "open");
  } catch (err) {
    console.error("[decide] failed to reopen card:", err.message);
  }
  try { await log("reject", { card, actor, detail: { card, rolledBack } }); } catch {}
  return { card, decision: "reject", rolledBack, reopened: true };
}

// CLI: `node scripts/loop/decide.mjs <pending|approve|reject> [card] [--force]`
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const [cmd, card] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const force = process.argv.includes("--force");

  if (cmd === "pending") {
    const rows = pendingCards();
    for (const p of rows) console.log(`${p.at || "?"}  ${p.card}  ${p.reason || ""}`);
    if (!rows.length) console.log("(no deploys waiting for a decision)");
  } else if (cmd === "approve" && card) {
    const r = await approveCard(card, { force });
    console.log(r.error || `approved ${card} — deploy started`);
    if (r.error) process.exit(1);
  } else if (cmd === "reject" && card) {
    const r = await rejectCard(card, { force });
    console.log(r.error || `rejected ${card} — ${r.rolledBack ? "reverted + " : ""}reopened for the builder`);
    if (r.error) process.exit(1);
  } else {
    console.error("usage: decide.mjs pending | approve <card> [--force] | reject <card> [--force]");
    process.exit(2);
  }
}
