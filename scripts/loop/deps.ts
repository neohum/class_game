// deps.ts — cards run in dependency order, and independent cards run together.
//
// `Dependencies:` has been part of a compiled card spec from the start, and
// nothing read it. The loop took `open[0]` — strict FIFO — so a plan whose step 2
// builds on step 1 was ordered only by luck of insertion, and a swarm worker could
// claim step 2 while step 1 was still mid-build. That is the bug this fixes.
//
// The same reading buys the speed: once "which cards are ready" is a computed set
// rather than "the first row", the ready set IS the wave, and several workers can
// take one each instead of queueing behind a card they do not depend on.
//
// One judgement call, deliberate: a dependency that names a card the backlog has
// never heard of is treated as SATISFIED, with a warning. Fail-closed reads
// better on paper, but a card may legitimately depend on work that was done by
// hand or lives in another repo, and blocking on a name nobody can resolve wedges
// the queue with no way for the loop to recover on its own. An unresolvable name
// is a plan bug; plan-doc.ts rejects it at compile time, where it is cheap.
//
// Usage:
//   node scripts/loop/deps.ts            # print ready / blocked
//   import { readyCards, nextWave } from "./deps.ts"

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getBacklog, type TaskRow } from "./backlog.ts";

const DONE = new Set(["done"]);

/** The `Dependencies:` / `Depends on:` slugs a compiled card carries. */
export function parseDependencies(spec: unknown): string[] {
  const out: string[] = [];
  for (const line of String(spec ?? "").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:Dependencies|Depends on):\s*(.*?)\s*$/i);
    if (!m) continue;
    for (const part of (m[1] ?? "").split(/[,;]/)) {
      const slug = part.trim().toLowerCase();
      if (slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) out.push(slug);
    }
  }
  return [...new Set(out)];
}

export interface DependencyStatus {
  /** Dependencies present in the backlog but not yet done. */
  blockedBy: string[];
  /** Dependencies no backlog row matches — satisfied, but worth saying out loud. */
  unknown: string[];
}

export function dependencyStatus(row: TaskRow, all: TaskRow[]): DependencyStatus {
  const byCard = new Map(all.map((r) => [r.card, r]));
  const blockedBy: string[] = [];
  const unknown: string[] = [];
  for (const dep of parseDependencies(row.spec)) {
    if (dep === row.card) continue; // a self-reference is noise, not a deadlock
    const other = byCard.get(dep);
    if (!other) { unknown.push(dep); continue; }
    if (!DONE.has(String(other.status))) blockedBy.push(dep);
  }
  return { blockedBy, unknown };
}

export function isReady(row: TaskRow, all: TaskRow[]): boolean {
  return dependencyStatus(row, all).blockedBy.length === 0;
}

/**
 * Open cards whose dependencies are all done, in backlog order.
 *
 * `all` is every row (any status) because a dependency's state is what decides
 * readiness; passing only the open rows would make every dependency look unknown.
 */
export function readyCards(all: TaskRow[]): TaskRow[] {
  return all.filter((r) => String(r.status) === "open" && isReady(r, all));
}

/** Cards a set of workers may take concurrently right now. */
export function nextWave(all: TaskRow[], limit = 1): TaskRow[] {
  return readyCards(all).slice(0, Math.max(1, limit));
}

/** This process's swarm slot, from `LOOP_WORKER=worker-<n>`. A lone loop is slot 0. */
export function workerSlot(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(String(env.LOOP_WORKER || "").match(/(\d+)/)?.[1] ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Which ready card THIS worker should attempt.
 *
 * Every swarm worker sees the same ready set, so taking `ready[0]` makes N
 * workers race for one card: one wins and N-1 back off, and the wave that could
 * have run N-wide runs one-wide. Offsetting by slot hands each worker a different
 * card when there are enough to go around. The claim protocol is still the thing
 * that guarantees exclusivity — this only stops the collision from being the
 * common case.
 */
export function pickForWorker<T>(ready: T[], env: NodeJS.ProcessEnv = process.env): T | undefined {
  if (!ready.length) return undefined;
  return ready[workerSlot(env) % ready.length];
}

/** One line per blocked card, for the loop log. */
export function blockedSummary(all: TaskRow[]): string[] {
  const out: string[] = [];
  for (const row of all) {
    if (String(row.status) !== "open") continue;
    const { blockedBy } = dependencyStatus(row, all);
    if (blockedBy.length) out.push(`${row.card} waits on ${blockedBy.join(", ")}`);
  }
  return out;
}

// CLI
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const backlog = await getBacklog();
  const all = backlog.list();
  const ready = readyCards(all);
  console.log(`ready (${ready.length}): ${ready.map((r) => r.card).join(", ") || "-"}`);
  for (const line of blockedSummary(all)) console.log(`blocked: ${line}`);
  for (const row of all) {
    const { unknown } = dependencyStatus(row, all);
    if (unknown.length) console.warn(`warn: ${row.card} names unknown dependenc(ies): ${unknown.join(", ")} — treated as satisfied`);
  }
}
