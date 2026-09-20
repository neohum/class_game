// telemetry.ts — append-only action trail for the autonomous loop.
//
// Every meaningful event (task claimed, iteration run, health result, commit,
// deploy, approval) is logged here so that a developer who was offline can
// reconstruct *why* the agents did what they did. This is the antidote to the
// "I came back and the repo changed and I don't know why" failure mode.
//
// Primary store: SQLite (node:sqlite). Fallback: append to current.md as a
// human-readable markdown table. We ALWAYS write the markdown fallback too —
// it costs nothing and it is the thing you read on your phone.

import { resolve } from "node:path";
import { appendFileSync, mkdirSync, existsSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { redactValue } from "./redact.ts";

const ROOT = resolve(process.cwd());
// Swarm workers share one trail by pointing HARNESS_STATE_DIR at the primary
// repo's .harness; current.md then lands next to that shared state dir so the
// human still reads a single trail, not one per worker checkout.
const STATE_DIR = resolve(process.env.HARNESS_STATE_DIR || resolve(ROOT, ".harness"));
const DB_PATH = resolve(STATE_DIR, "telemetry.db");
const MD_PATH = process.env.HARNESS_STATE_DIR
  ? resolve(STATE_DIR, "..", "current.md")
  : resolve(ROOT, "current.md");

mkdirSync(STATE_DIR, { recursive: true });

/** The node:sqlite handle, or false once we know it is unavailable here. */
let db: { prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] }; exec(sql: string): void } | false | null = null;
async function sqlite() {
  if (db === false) return null;
  if (db) return db;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const d = new DatabaseSync(DB_PATH);
    // WAL lets readers and writers coexist, but it does NOT make a second
    // writer wait: without a busy timeout SQLite returns SQLITE_BUSY at once,
    // so a swarm worker sharing HARNESS_STATE_DIR fails its claim instead of
    // queueing behind the worker that holds the lock. Found in the field.
    try { d.exec("PRAGMA busy_timeout = 5000;"); } catch {}
    d.exec(`
      CREATE TABLE IF NOT EXISTS trail (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      TEXT NOT NULL,
        kind    TEXT NOT NULL,   -- claim|iterate|health|guard|commit|deploy|approve|reject|error
        card    TEXT,
        actor   TEXT,            -- which agent / role
        detail  TEXT             -- free text or JSON
      );
    `);
    db = d;
    return d;
  } catch {
    db = false;
    return null;
  }
}

function ensureMdHeader() {
  if (existsSync(MD_PATH)) return;
  writeFileSync(
    MD_PATH,
    [
      "# current.md — live action trail",
      "",
      "> Human-readable fallback for the SQLite telemetry. Newest at the bottom.",
      "",
      "| time (UTC) | kind | card | actor | detail |",
      "| ---------- | ---- | ---- | ----- | ------ |",
      "",
    ].join("\n"),
  );
}

function mdEscape(s: unknown): string {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * Record one event. Never throws — telemetry must not crash the loop.
 * @param {string} kind  claim|iterate|health|guard|commit|deploy|approve|reject|error
 * @param {{card?:string, actor?:string, detail?:any}} [meta]
 */
/** One trail event. detail is free-form: a string, or anything JSON-serializable. */
export interface TelemetryMeta {
  card?: string | null;
  actor?: string | null;
  detail?: unknown;
}

export async function log(kind: string, meta: TelemetryMeta = {}): Promise<void> {
  const safeMeta = redactValue(meta);
  const ts = new Date().toISOString();
  const card = safeMeta.card ?? null;
  const actor = safeMeta.actor ?? null;
  const detail =
    safeMeta.detail == null
      ? null
      : typeof safeMeta.detail === "string"
        ? safeMeta.detail
        : JSON.stringify(safeMeta.detail);

  try {
    const d = await sqlite();
    if (d) {
      d.prepare(
        `INSERT INTO trail (ts, kind, card, actor, detail) VALUES (?, ?, ?, ?, ?)`,
      ).run(ts, kind, card, actor, detail);
    }
  } catch { /* swallow — fallback below still runs */ }

  try {
    ensureMdHeader();
    appendFileSync(
      MD_PATH,
      `| ${ts} | ${kind} | ${mdEscape(card)} | ${mdEscape(actor)} | ${mdEscape(detail)} |\n`,
    );
  } catch { /* last resort: give up silently, do not break the loop */ }
}

/** One row of the trail as stored. */
export interface TrailEvent {
  id: number;
  ts: string;
  kind: string;
  card: string | null;
  actor: string | null;
  detail: string | null;
}

/** Recent events, newest first. Reads SQLite if available, else parses nothing. */
export async function recent(limit = 20): Promise<TrailEvent[]> {
  const d = await sqlite();
  if (!d) return [];
  return d.prepare(`SELECT * FROM trail ORDER BY id DESC LIMIT ?`).all(limit) as TrailEvent[];
}

// CLI: `node scripts/loop/telemetry.ts <kind> [--card x] [--actor y] [--detail "..."]`
//      `node scripts/loop/telemetry.ts tail [N]`
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
  if (argv[0] === "tail") {
    const rows = await recent(Number(argv[1]) || 20);
    for (const r of rows.reverse()) {
      console.log(`${r.ts}  ${r.kind.padEnd(8)} ${r.card ?? "-"}  ${r.actor ?? "-"}  ${r.detail ?? ""}`);
    }
  } else {
    const kind = argv[0];
    if (!kind) { console.error('usage: telemetry.ts <kind> [--card x] [--actor y] [--detail "..."] | tail [N]'); process.exit(2); }
    const meta: TelemetryMeta = {};
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--card") meta.card = argv[++i];
      else if (argv[i] === "--actor") meta.actor = argv[++i];
      else if (argv[i] === "--detail") meta.detail = argv[++i];
    }
    await log(kind, meta);
    console.log(`logged ${kind}`);
  }
}
