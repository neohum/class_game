// claim-task.ts — two-phase task claim for race-free multi-agent work.
//
//   Task_Claim_Status = 1  iff  SQLite transaction succeeds AND git lock acquired
//                      = 0  otherwise
//
// Phase 1 (SQLite): atomically flip the row from 'open' to 'claimed'. Only one
//   writer can win because SQLite serializes writes.
// Phase 2 (file lock): create current_tasks/<card>.lock with O_EXCL so a second
//   contender that SHARES THIS LOCK DIRECTORY'S FILESYSTEM also loses. That covers
//   every swarm worker on one host, and multiple hosts ONLY when HARNESS_LOCK_DIR
//   points at a filesystem all of them share (e.g. a network/NFS mount). Two hosts
//   that share only the bare git repo do NOT share this lock dir — O_EXCL cannot
//   exclude them; the SQLite backlog (Phase 1), if also shared, is what serializes
//   that case. Do not read "another machine" as "always safe across machines".
//
// Both must succeed. If the lock file write fails after the DB flip, we roll the
// row back to 'open' so the task is not stranded.
//
// Reuse: ralph-loop imports `claimTask`/`acquireGitLock` to claim in-process on
// its already-open backlog handle, avoiding a child process + SQLite re-open per
// task. Other machines still run this file as a standalone CLI.
//
// Usage: node scripts/loop/claim-task.ts <card> [--who <agent-id>]
// Exit:  0 = claimed, 3 = already taken / lost the race, 2 = bad usage.

import { resolve } from "node:path";
import { openSync, closeSync, writeSync, mkdirSync, readdirSync, statSync, rmSync, existsSync, realpathSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { getBacklog } from "./backlog.ts";

// Swarm workers share one lock dir via HARNESS_LOCK_DIR so the O_EXCL race stays
// meaningful across worker checkouts on the same machine.
const LOCK_DIR = resolve(process.env.HARNESS_LOCK_DIR || resolve(process.cwd(), "current_tasks"));
const DEFAULT_LEASE_MS = 24 * 60 * 60 * 1000;

/** The slice of backlog.ts claiming needs, so callers can inject a double. */
interface BacklogLike {
  claim(card: string, who: string): boolean;
  setStatus(card: string, status: string): unknown;
  list(status?: string): Array<{ card: string; status?: string }>;
}

function parse(argv: string[]): { card: string | null; who: string | null } {
  const out: { card: string | null; who: string | null } = { card: null, who: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--who") out.who = argv[++i] ?? null;
    else if (!out.card) out.card = argv[i] ?? null;
  }
  return out;
}

export function defaultWho() {
  return `${userInfo().username}@${hostname()}:${process.pid}`;
}

export function acquireGitLock(card: string, who: string): string | null {
  mkdirSync(LOCK_DIR, { recursive: true });
  const lockPath = resolve(LOCK_DIR, `${card}.lock`);
  try {
    // O_EXCL ("wx"): fails if the file already exists — excludes any contender
    // sharing this lock dir's filesystem (same host, or a shared/network mount).
    const fd = openSync(lockPath, "wx");
    writeSync(fd, JSON.stringify({ card, who, at: new Date().toISOString() }) + "\n");
    closeSync(fd);
    return lockPath;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw e;
  }
}

/**
 * Both-phase claim against an already-resolved backlog handle.
 * @returns {{ ok: boolean, lockPath?: string, reason?: string }}
 */
export function claimTask(backlog: BacklogLike, card: string, who = defaultWho()) {
  if (!backlog.claim(card, who)) {
    return { ok: false, reason: "not claimable (already taken or not open)" };
  }
  const lockPath = acquireGitLock(card, who);
  if (!lockPath) {
    backlog.setStatus(card, "open"); // roll back the DB flip
    return { ok: false, reason: "lost the git lock race — rolled back DB claim" };
  }
  return { ok: true, lockPath };
}

// Recover claims left behind by a killed process. A normal task cannot exceed
// the command/iteration budgets by anything close to this default, so an old
// lock is treated as abandoned. This is deliberately conservative: fresh locks
// are never reclaimed automatically.
export function reclaimStaleClaims(backlog: BacklogLike, maxAgeMs: number = Number(process.env.HARNESS_CLAIM_LEASE_MS) || DEFAULT_LEASE_MS) {
  const now = Date.now();
  const recovered: string[] = [];
  for (const row of backlog.list("claimed")) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(row.card)) continue;
    const lockPath = resolve(LOCK_DIR, `${row.card}.lock`);
    let stale = !existsSync(lockPath);
    if (!stale) {
      try { stale = now - statSync(lockPath).mtimeMs > maxAgeMs; } catch { stale = false; }
    }
    if (!stale) continue;
    backlog.setStatus(row.card, "open");
    rmSync(lockPath, { force: true });
    recovered.push(row.card);
  }
  return recovered;
}

async function main() {
  const { card, who: whoArg } = parse(process.argv.slice(2));
  if (!card) {
    console.error("usage: claim-task.ts <card> [--who <agent-id>]");
    process.exit(2);
  }
  const who = whoArg || defaultWho();
  const backlog = await getBacklog();
  const r = claimTask(backlog, card, who);
  if (!r.ok) {
    console.log(`✗ ${card}: ${r.reason}`);
    process.exit(3);
  }
  console.log(`✓ ${card}: claimed by ${who}`);
  console.log(`  lock: ${r.lockPath}`);
  process.exit(0);
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

if (isMainModule) {
  main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
}
