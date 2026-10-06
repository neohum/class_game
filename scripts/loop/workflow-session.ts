// workflow-session.ts — the claim + telemetry boundary for a workflow-run card.
//
// The loop claims a card in two phases (SQLite `open → claimed`, then an
// O_EXCL lock file) so two lanes can never build the same card. A card run as a
// Claude Code Workflow skipped both: the workflow script body has no filesystem
// access at all, so it cannot take a lock, and asking an agent to implement the
// lock in bash gives up the atomicity that is the whole point.
//
// This puts the atomic part back in Node and leaves the agent with one call.
// Four red-team passes reported the same consequences of not having it:
//   - no lock, so another lane can write the same worktree mid-review (observed:
//     a probe file appeared and vanished during one review)
//   - no telemetry, so a 91-minute, 20-agent run left no trace anywhere in the
//     repo — the trail's last entry predated it by days
//
// Usage:
//   node scripts/loop/workflow-session.ts start <card> [--run <id>] [--repo <path>]
//   node scripts/loop/workflow-session.ts end   <card> [--run <id>] [--outcome <o>]
//   node scripts/loop/workflow-session.ts status <card>
//
// Exit: 0 = ok, 3 = card is already held by someone else, 2 = bad usage.
// Both subcommands print one JSON object on stdout.

import { resolve } from "node:path";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { acquireGitLock } from "./claim-task.ts";
import { log } from "./telemetry.ts";

const LOCK_DIR = resolve(process.env.HARNESS_LOCK_DIR || resolve(process.cwd(), "current_tasks"));

/**
 * A workflow run is not the loop: it is interactive and bounded, so its lock
 * should not survive a crash for a whole day the way a loop claim's 24h lease
 * does. One hour is longer than any bounded card run and short enough that an
 * abandoned lock does not block the next attempt for a working day.
 */
const DEFAULT_LEASE_MS = 60 * 60 * 1000;
const leaseMs = () => Number(process.env.HARNESS_WORKFLOW_LEASE_MS) || DEFAULT_LEASE_MS;

const lockPathFor = (card: string) => resolve(LOCK_DIR, `${card}.lock`);

interface LockBody {
  card?: string;
  who?: string;
  at?: string;
}

function readLock(path: string): LockBody | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Age of the lock file in ms, or null when it does not exist. */
function lockAgeMs(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export interface StartResult {
  ok: boolean;
  card: string;
  lockPath?: string;
  who?: string;
  reason?: string;
  heldBy?: string;
  heldSince?: string;
  reclaimed?: boolean;
}

export function start(card: string, who: string): StartResult {
  const path = lockPathFor(card);

  // Reclaim only a lock that is provably past its lease. A fresh lock always
  // wins — this must never race a live run off its own card.
  let reclaimed = false;
  const age = lockAgeMs(path);
  if (age !== null && age > leaseMs()) {
    rmSync(path, { force: true });
    reclaimed = true;
  }

  const lockPath = acquireGitLock(card, who);
  if (!lockPath) {
    const held = readLock(path);
    return {
      ok: false,
      card,
      reason: "card is already held — another lane owns this worktree",
      heldBy: held?.who,
      heldSince: held?.at,
    };
  }
  return { ok: true, card, lockPath, who, reclaimed };
}

export interface EndResult {
  ok: boolean;
  card: string;
  released: boolean;
  reason?: string;
}

/**
 * Release only a lock this run owns. Deleting someone else's lock would be
 * worse than leaking our own: it would hand the card to a third lane while the
 * real owner is still writing.
 */
export function end(card: string, who: string): EndResult {
  const path = lockPathFor(card);
  if (!existsSync(path)) return { ok: true, card, released: false, reason: "no lock present" };
  const held = readLock(path);
  if (held?.who && held.who !== who) {
    return { ok: false, card, released: false, reason: `lock is held by ${held.who}, not ${who} — refusing to release` };
  }
  rmSync(path, { force: true });
  return { ok: true, card, released: true };
}

const defaultWho = (run?: string) =>
  `workflow:${run || "adhoc"}@${userInfo().username}@${hostname()}`;

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
  const cmd = argv[0];
  const card = argv[1];
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (!cmd || !card || !["start", "end", "status"].includes(cmd)) {
    console.error('usage: workflow-session.ts <start|end|status> <card> [--run <id>] [--repo <path>] [--outcome <o>]');
    process.exit(2);
  }
  const who = defaultWho(flag("--run"));

  if (cmd === "status") {
    const path = lockPathFor(card);
    const held = existsSync(path) ? readLock(path) : null;
    console.log(JSON.stringify({ card, held: Boolean(held), ...held, ageMs: lockAgeMs(path) }));
    process.exit(0);
  }

  if (cmd === "start") {
    const result = start(card, who);
    // Telemetry is best-effort: a repo without a trail must not fail the card.
    await log(result.ok ? "claim" : "guard", {
      card,
      actor: "workflow",
      detail: result.ok
        ? `workflow claimed card${result.reclaimed ? " (reclaimed an expired lock)" : ""}${flag("--repo") ? ` in ${flag("--repo")}` : ""}`
        : `workflow claim refused: ${result.reason}`,
    }).catch(() => {});
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 3);
  }

  const result = end(card, who);
  await log("iterate", {
    card,
    actor: "workflow",
    detail: `workflow finished: ${flag("--outcome") || "unknown"}${result.released ? "" : ` (lock not released: ${result.reason})`}`,
  }).catch(() => {});
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 3);
}
