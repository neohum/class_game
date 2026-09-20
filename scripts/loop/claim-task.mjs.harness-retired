// claim-task.mjs — two-phase task claim for race-free multi-agent work.
//
//   Task_Claim_Status = 1  iff  SQLite transaction succeeds AND git lock acquired
//                      = 0  otherwise
//
// Phase 1 (SQLite): atomically flip the row from 'open' to 'claimed'. Only one
//   writer can win because SQLite serializes writes.
// Phase 2 (git lock): create current_tasks/<card>.lock with O_EXCL so a second
//   process on another machine — sharing the same bare repo — also loses.
//
// Both must succeed. If the lock file write fails after the DB flip, we roll the
// row back to 'open' so the task is not stranded.
//
// Reuse: ralph-loop imports `claimTask`/`acquireGitLock` to claim in-process on
// its already-open backlog handle, avoiding a child process + SQLite re-open per
// task. Other machines still run this file as a standalone CLI.
//
// Usage: node scripts/loop/claim-task.mjs <card> [--who <agent-id>]
// Exit:  0 = claimed, 3 = already taken / lost the race, 2 = bad usage.

import { resolve } from "node:path";
import { openSync, closeSync, writeSync, mkdirSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import { getBacklog } from "./backlog.mjs";

const LOCK_DIR = resolve(process.cwd(), "current_tasks");

function parse(argv) {
  const out = { card: null, who: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--who") out.who = argv[++i];
    else if (!out.card) out.card = argv[i];
  }
  return out;
}

export function defaultWho() {
  return `${userInfo().username}@${hostname()}:${process.pid}`;
}

export function acquireGitLock(card, who) {
  mkdirSync(LOCK_DIR, { recursive: true });
  const lockPath = resolve(LOCK_DIR, `${card}.lock`);
  try {
    // O_EXCL: fails if the file already exists — this is the cross-machine guard.
    const fd = openSync(lockPath, "wx");
    writeSync(fd, JSON.stringify({ card, who, at: new Date().toISOString() }) + "\n");
    closeSync(fd);
    return lockPath;
  } catch (e) {
    if (e.code === "EEXIST") return null;
    throw e;
  }
}

/**
 * Both-phase claim against an already-resolved backlog handle.
 * @returns {{ ok: boolean, lockPath?: string, reason?: string }}
 */
export function claimTask(backlog, card, who = defaultWho()) {
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

async function main() {
  const { card, who: whoArg } = parse(process.argv.slice(2));
  if (!card) {
    console.error("usage: claim-task.mjs <card> [--who <agent-id>]");
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
}
