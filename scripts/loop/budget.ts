#!/usr/bin/env node
// budget.ts — what the loop spent, and the ceiling it may not cross.
//
// cooldown.ts bounds how OFTEN a lane may run. Nothing bounded how MUCH an
// unattended run consumed, so the only brake on a 24/7 loop was the clock: a
// card that kept failing kept spending until the iteration cap, and the cap
// resets with the next card. This is the missing brake.
//
// It records what is observable and refuses to invent the rest:
//
//   always      one invocation happened, on this lane, for this card, and it
//               took this long. True of every CLI; needs no cooperation.
//   when given  token counts, parsed from a CLI that reports them (Claude's
//               `--output-format json` envelope, the OpenAI-shaped one). Absent
//               otherwise, never estimated — a fabricated spend number is worse
//               than no number, because it gets believed.
//
// So a cap on calls or wall-clock always bites, a token cap bites only as far as
// the lanes report, and `status` says which of the two you are getting instead
// of quietly printing 0 tokens for a lane that simply never told anyone.
//
// Caps (unset = no limit):
//   HARNESS_BUDGET_CALLS_PER_CARD    invocations one card may spend
//   HARNESS_BUDGET_CALLS_PER_DAY     invocations across all cards, rolling 24h
//   HARNESS_BUDGET_TOKENS_PER_DAY    reported tokens, rolling 24h
//   HARNESS_BUDGET_MINUTES_PER_DAY   agent wall-clock, rolling 24h
//
// CLI:
//   node scripts/loop/budget.ts status [--card <slug>]
//   node scripts/loop/budget.ts record --agent <a> --ms <n> [--card <c>] [--in <n>] [--out <n>]

import { resolve } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = resolve(process.cwd());
const STATE_DIR = resolve(process.env.HARNESS_STATE_DIR || resolve(ROOT, ".harness"));
const DB_PATH = resolve(STATE_DIR, "budget.db");
const JSONL_PATH = resolve(STATE_DIR, "budget.jsonl");

const DAY_MS = 24 * 60 * 60 * 1000;

/** One agent invocation, as billed. */
export interface UsageRow {
  ts: number;
  card: string | null;
  agent: string;
  ms: number;
  in_tokens: number;
  out_tokens: number;
  /** 1 when the CLI actually reported tokens; 0 when only calls/ms are real. */
  reported: number;
}

type SqliteDb = {
  prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
  exec(sql: string): void;
};
let db: SqliteDb | false | null = null;

async function sqlite(): Promise<SqliteDb | null> {
  if (db === false) return null;
  if (db) return db;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const d = new DatabaseSync(DB_PATH) as unknown as SqliteDb;
    // WAL lets readers and writers coexist, but it does NOT make a second
    // writer wait: without a busy timeout SQLite returns SQLITE_BUSY at once,
    // so a swarm worker sharing HARNESS_STATE_DIR fails its claim instead of
    // queueing behind the worker that holds the lock. Found in the field.
    try { d.exec("PRAGMA busy_timeout = 5000;"); } catch {}
    d.exec(`
      CREATE TABLE IF NOT EXISTS usage (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         INTEGER NOT NULL,
        card       TEXT,
        agent      TEXT NOT NULL,
        ms         INTEGER NOT NULL DEFAULT 0,
        in_tokens  INTEGER NOT NULL DEFAULT 0,
        out_tokens INTEGER NOT NULL DEFAULT 0,
        reported   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage (ts);
      CREATE INDEX IF NOT EXISTS idx_usage_card ON usage (card);
    `);
    db = d;
    return d;
  } catch {
    db = false;
    return null;
  }
}

function readJsonl(): UsageRow[] {
  if (!existsSync(JSONL_PATH)) return [];
  return readFileSync(JSONL_PATH, "utf8").split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line) as UsageRow; } catch { return null; } })
    .filter((r): r is UsageRow => Boolean(r));
}

/**
 * Pull token counts out of an agent CLI's stdout.
 *
 * Deliberately narrow. It reads the two envelope shapes the roster CLIs actually
 * emit when asked for JSON and nothing else — no scraping of prose like
 * "used about 12k tokens", which is how a spend chart starts lying.
 * Returns null when the lane said nothing, and the caller records calls+ms only.
 */
export function parseUsage(stdout: unknown): { in_tokens: number; out_tokens: number } | null {
  const text = String(stdout ?? "");
  if (!text.includes("usage")) return null;
  // Scan candidate JSON objects from the end: the usage envelope is the last
  // thing a --print run emits, after whatever the agent streamed before it.
  const candidates = text.match(/\{[^{}]*"usage"[\s\S]{0,400}?\}\s*\}?/g) || [];
  for (const chunk of candidates.reverse()) {
    for (const slice of [chunk, chunk.replace(/\}\s*$/, "")]) {
      try {
        const parsed = JSON.parse(slice) as Record<string, any>;
        const u = parsed?.usage ?? parsed;
        const input = Number(u?.input_tokens ?? u?.prompt_tokens);
        const output = Number(u?.output_tokens ?? u?.completion_tokens);
        if (Number.isFinite(input) || Number.isFinite(output)) {
          return {
            in_tokens: Number.isFinite(input) ? input : 0,
            out_tokens: Number.isFinite(output) ? output : 0,
          };
        }
      } catch { /* not this slice */ }
    }
  }
  return null;
}

/** Record one invocation. Never throws — accounting must not break the loop. */
export async function recordUsage({
  card = null, agent, ms = 0, in_tokens, out_tokens,
}: {
  card?: string | null;
  agent: string;
  ms?: number;
  in_tokens?: number;
  out_tokens?: number;
}): Promise<void> {
  const reported = in_tokens != null || out_tokens != null ? 1 : 0;
  const row: UsageRow = {
    ts: Date.now(),
    card: card || null,
    agent: String(agent || "unknown"),
    ms: Math.max(0, Math.round(ms) || 0),
    in_tokens: Math.max(0, Math.round(in_tokens ?? 0)),
    out_tokens: Math.max(0, Math.round(out_tokens ?? 0)),
    reported,
  };
  try {
    const d = await sqlite();
    if (d) {
      d.prepare(
        `INSERT INTO usage (ts, card, agent, ms, in_tokens, out_tokens, reported) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.ts, row.card, row.agent, row.ms, row.in_tokens, row.out_tokens, row.reported);
      return;
    }
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(JSONL_PATH, JSON.stringify(row) + "\n");
  } catch { /* accounting is never worth a crashed loop */ }
}

/** What was spent. `card` scopes to one card; `sinceMs` scopes to a window. */
export interface Spend {
  calls: number;
  ms: number;
  tokens: number;
  /** invocations whose lane actually reported tokens — the honesty denominator */
  reportedCalls: number;
}

const EMPTY: Spend = { calls: 0, ms: 0, tokens: 0, reportedCalls: 0 };

async function rowsFor({ card, sinceMs }: { card?: string; sinceMs?: number }): Promise<UsageRow[]> {
  const d = await sqlite();
  if (d) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (sinceMs != null) { where.push("ts >= ?"); args.push(sinceMs); }
    if (card) { where.push("card = ?"); args.push(card); }
    const sql = `SELECT * FROM usage${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
    return d.prepare(sql).all(...args) as UsageRow[];
  }
  return readJsonl().filter((r) =>
    (sinceMs == null || r.ts >= sinceMs) && (!card || r.card === card));
}

function tally(rows: UsageRow[]): Spend {
  return rows.reduce((acc, r) => ({
    calls: acc.calls + 1,
    ms: acc.ms + (Number(r.ms) || 0),
    tokens: acc.tokens + (Number(r.in_tokens) || 0) + (Number(r.out_tokens) || 0),
    reportedCalls: acc.reportedCalls + (Number(r.reported) ? 1 : 0),
  }), EMPTY);
}

export async function spend({ card, sinceMs }: { card?: string; sinceMs?: number } = {}): Promise<Spend> {
  try {
    return tally(await rowsFor({ card, sinceMs }));
  } catch {
    return EMPTY;
  }
}

/**
 * The same window, split by lane.
 *
 * The totals answer "how much"; this answers "by whom", which is the question
 * that decides what to move. A lane the operator is not rationing SHOULD
 * dominate this table — that is the point of routing verification to it — and a
 * metered lane climbing it is the signal to look at.
 *
 * Sorted by calls, because calls are the figure every lane reports honestly;
 * tokens are only as complete as the lanes that volunteer them.
 */
export async function spendByAgent(
  { card, sinceMs }: { card?: string; sinceMs?: number } = {},
): Promise<Array<Spend & { agent: string }>> {
  try {
    const grouped = new Map<string, UsageRow[]>();
    for (const row of await rowsFor({ card, sinceMs })) {
      const agent = String(row.agent || "unknown");
      const bucket = grouped.get(agent);
      if (bucket) bucket.push(row); else grouped.set(agent, [row]);
    }
    return [...grouped.entries()]
      .map(([agent, rows]) => ({ agent, ...tally(rows) }))
      .sort((a, b) => b.calls - a.calls || a.agent.localeCompare(b.agent));
  } catch {
    return [];
  }
}

function cap(name: string, env: NodeJS.ProcessEnv): number | null {
  const raw = env[name];
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface BudgetStatus {
  ok: boolean;
  /** human-readable reasons the ceiling was crossed; empty when ok */
  exceeded: string[];
  limits: Record<string, number | null>;
  today: Spend;
  /** the same 24h window split by lane, busiest first */
  todayByAgent: Array<Spend & { agent: string }>;
  cardSpend: Spend | null;
  /** true when a token cap is set but no lane has ever reported a count */
  tokenCapBlind: boolean;
}

/**
 * Is there room to spend? Called BEFORE an invocation, so a run that would cross
 * the ceiling never starts. Fails OPEN on a storage error — a budget module that
 * cannot read its own ledger must not become the thing that stops the factory.
 */
export async function budgetStatus(
  { card, env = process.env }: { card?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<BudgetStatus> {
  const limits = {
    callsPerCard: cap("HARNESS_BUDGET_CALLS_PER_CARD", env),
    callsPerDay: cap("HARNESS_BUDGET_CALLS_PER_DAY", env),
    tokensPerDay: cap("HARNESS_BUDGET_TOKENS_PER_DAY", env),
    minutesPerDay: cap("HARNESS_BUDGET_MINUTES_PER_DAY", env),
  };
  const since = Date.now() - DAY_MS;
  const today = await spend({ sinceMs: since });
  const todayByAgent = await spendByAgent({ sinceMs: since });
  const cardSpend = card ? await spend({ card }) : null;

  const exceeded: string[] = [];
  if (limits.callsPerCard != null && cardSpend && cardSpend.calls >= limits.callsPerCard) {
    exceeded.push(`card "${card}" used ${cardSpend.calls} agent calls (cap ${limits.callsPerCard})`);
  }
  if (limits.callsPerDay != null && today.calls >= limits.callsPerDay) {
    exceeded.push(`${today.calls} agent calls in the last 24h (cap ${limits.callsPerDay})`);
  }
  if (limits.tokensPerDay != null && today.tokens >= limits.tokensPerDay) {
    exceeded.push(`${today.tokens} reported tokens in the last 24h (cap ${limits.tokensPerDay})`);
  }
  if (limits.minutesPerDay != null && today.ms / 60_000 >= limits.minutesPerDay) {
    exceeded.push(`${Math.round(today.ms / 60_000)} agent-minutes in the last 24h (cap ${limits.minutesPerDay})`);
  }
  return {
    ok: exceeded.length === 0,
    exceeded,
    limits,
    today,
    todayByAgent,
    cardSpend,
    tokenCapBlind: limits.tokensPerDay != null && today.calls > 0 && today.reportedCalls === 0,
  };
}

function fmt(s: Spend): string {
  return `${s.calls} calls · ${Math.round(s.ms / 1000)}s · ${s.tokens} reported tokens (${s.reportedCalls}/${s.calls} lanes reporting)`;
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
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cmd = argv[0];

  if (cmd === "record") {
    const agent = flag("agent");
    if (!agent) { console.error("usage: budget.ts record --agent <a> --ms <n> [--card <c>] [--in <n>] [--out <n>]"); process.exit(2); }
    const rawIn = flag("in"), rawOut = flag("out");
    await recordUsage({
      agent,
      card: flag("card") || null,
      ms: Number(flag("ms")) || 0,
      in_tokens: rawIn == null ? undefined : Number(rawIn),
      out_tokens: rawOut == null ? undefined : Number(rawOut),
    });
    console.log("recorded");
  } else if (cmd === "status" || cmd === undefined) {
    const status = await budgetStatus({ card: flag("card") });
    console.log(`last 24h: ${fmt(status.today)}`);
    for (const lane of status.todayByAgent) {
      const share = status.today.calls ? Math.round((lane.calls / status.today.calls) * 100) : 0;
      console.log(`  ${lane.agent.padEnd(14)} ${String(lane.calls).padStart(5)} calls (${String(share).padStart(3)}%)`
        + ` · ${String(Math.round(lane.ms / 1000)).padStart(6)}s · ${lane.tokens} tokens`);
    }
    if (status.cardSpend) console.log(`card ${flag("card")}: ${fmt(status.cardSpend)}`);
    const set = Object.entries(status.limits).filter(([, v]) => v != null);
    console.log(set.length ? `caps: ${set.map(([k, v]) => `${k}=${v}`).join(", ")}` : "caps: none set (no ceiling)");
    if (status.tokenCapBlind) {
      console.log("WARNING: a token cap is set but no lane has reported token counts — that cap cannot bite.");
    }
    if (!status.ok) {
      for (const reason of status.exceeded) console.log(`OVER BUDGET: ${reason}`);
      process.exit(1);
    }
    console.log("within budget");
  } else {
    console.error("usage: budget.ts <status|record> ...");
    process.exit(2);
  }
}
