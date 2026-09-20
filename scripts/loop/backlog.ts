// backlog.ts — SQLite-backed task backlog for the autonomous loop.
//
// One table, `tasks`, is the single source of truth for what the agent legion
// works on. The human writes intent into spec.md; the Lead agent turns each
// line into a task row here. Builders claim rows via claim-task.ts.
//
// We use node:sqlite when available (Node >= 22.5 with --experimental-sqlite or
// >= 23 stable) and fall back to a JSON file so the loop still runs on Node 18.
// The fallback is intentionally dumb — it is a safety net, not a feature.

import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = resolve(process.cwd());
// Swarm workers run in isolated checkouts but share ONE backlog by pointing
// HARNESS_STATE_DIR at the primary repo's .harness (see scripts/loop/swarm.ts).
const STATE_DIR = resolve(process.env.HARNESS_STATE_DIR || resolve(ROOT, ".harness"));
const DB_PATH = resolve(STATE_DIR, "backlog.db");
const JSON_PATH = resolve(STATE_DIR, "backlog.json");

mkdirSync(STATE_DIR, { recursive: true });

// --- storage backend selection -------------------------------------------

/** One task card as stored. */
export interface TaskRow {
  id?: number;
  card: string;
  spec: string;
  status: string;
  source?: string;
  attempts?: number;
  claimed_by?: string | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/**
 * The backlog store, in the shape both backends implement.
 *
 * Exported because five other modules were each declaring their own narrow
 * "the bit of backlog I use" interface. One definition here means a change to
 * the store is a compile error at every call site instead of a surprise at
 * runtime in whichever one was not updated.
 */
export interface Backlog {
  kind: string;
  add(card: string, spec: string, source?: string): void;
  list(status?: string): TaskRow[];
  claim(card: string, who: string): boolean;
  recordEvent(card: string, eventType: string, details?: string): void;
  setStatus(card: string, status: string): void;
  get(card: string): TaskRow | undefined;
}

let backend: Backlog | null = null;

async function loadSqlite() {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(DB_PATH);
    // Enable WAL (Write-Ahead Logging) mode for high-concurrency atomic performance
    try { db.exec("PRAGMA journal_mode = WAL;"); } catch {}
    // WAL lets readers and writers coexist, but it does NOT make a second
    // writer wait: without a busy timeout SQLite returns SQLITE_BUSY at once,
    // so a swarm worker sharing HARNESS_STATE_DIR fails its claim instead of
    // queueing behind the worker that holds the lock. Found in the field.
    try { db.exec("PRAGMA busy_timeout = 5000;"); } catch {}
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        card        TEXT NOT NULL UNIQUE,
        spec        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open',  -- open|claimed|review|done|failed
        source      TEXT NOT NULL DEFAULT 'manual', -- spec|prompt|assess|market|pain-point|design|mcp|manual
        claimed_by  TEXT,
        attempts    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        card        TEXT NOT NULL,
        event_type  TEXT NOT NULL,
        details     TEXT,
        created_at  TEXT NOT NULL
      );
    `);
    // migrate pre-source databases in place
    try { db.exec(`ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`); } catch {}
    return {
      kind: "sqlite",
      add(card: string, spec: string, source = "manual") {
        const now = new Date().toISOString();
        db.prepare(
          `INSERT OR IGNORE INTO tasks (card, spec, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(card, spec, source, now, now);
      },
      list(status?: string): TaskRow[] {
        const q = status
          ? db.prepare(`SELECT * FROM tasks WHERE status = ? ORDER BY id`)
          : db.prepare(`SELECT * FROM tasks ORDER BY id`);
        return (status ? q.all(status) : q.all()) as TaskRow[];
      },
      // Atomic claim: only succeeds if the row is still 'open'. SQLite's
      // single-writer guarantee makes this the transaction half of the
      // claim protocol (the git lock file is the other half).
      claim(card: string, who: string): boolean {
        const now = new Date().toISOString();
        const r = db
          .prepare(
            `UPDATE tasks SET status='claimed', claimed_by=?, attempts=attempts+1, updated_at=?
             WHERE card=? AND status='open'`,
          )
          .run(who, now, card);
        return r.changes === 1;
      },
      recordEvent(card: string, eventType: string, details = "") {
        const now = new Date().toISOString();
        try {
          db.prepare(`INSERT INTO task_events (card, event_type, details, created_at) VALUES (?, ?, ?, ?)`).run(card, eventType, String(details), now);
        } catch {}
      },
      setStatus(card: string, status: string) {
        const now = new Date().toISOString();
        db.prepare(`UPDATE tasks SET status=?, updated_at=? WHERE card=?`).run(
          status,
          now,
          card,
        );
        this.recordEvent(card, `STATUS_${status.toUpperCase()}`);
      },
      get(card: string): TaskRow | undefined {
        return db.prepare(`SELECT * FROM tasks WHERE card=?`).get(card) as TaskRow | undefined;
      },
    };
  } catch {
    return null;
  }
}

interface JsonStore {
  tasks: TaskRow[];
  events?: Array<{ card: string; event_type: string; details: string; created_at: string }>;
}

function loadJson(): Backlog {
  const read = (): JsonStore => (existsSync(JSON_PATH) ? JSON.parse(readFileSync(JSON_PATH, "utf8")) : { tasks: [] });
  const write = (d: JsonStore) => writeFileSync(JSON_PATH, JSON.stringify(d, null, 2) + "\n");
  return {
    kind: "json",
    add(card: string, spec: string, source = "manual") {
      const d = read();
      if (d.tasks.some((t) => t.card === card)) return;
      const now = new Date().toISOString();
      d.tasks.push({ card, spec, status: "open", source, claimed_by: null, attempts: 0, created_at: now, updated_at: now });
      write(d);
    },
    list(status?: string): TaskRow[] {
      const d = read();
      return status ? d.tasks.filter((t) => t.status === status) : d.tasks;
    },
    claim(card: string, who: string): boolean {
      const d = read();
      const t = d.tasks.find((x) => x.card === card);
      if (!t || t.status !== "open") return false;
      t.status = "claimed";
      t.claimed_by = who;
      t.attempts = (t.attempts ?? 0) + 1;
      t.updated_at = new Date().toISOString();
      write(d);
      return true;
    },
    // Kept at parity with the sqlite backend. getBacklog() prefers sqlite and
    // falls back here, so a verb present on only one of them is a runtime
    // TypeError waiting for whichever host lacks node:sqlite.
    recordEvent(card: string, eventType: string, details = "") {
      const d = read();
      (d.events ??= []).push({
        card, event_type: eventType, details: String(details), created_at: new Date().toISOString(),
      });
      write(d);
    },
    setStatus(card: string, status: string) {
      const d = read();
      const t = d.tasks.find((x) => x.card === card);
      if (!t) return;
      t.status = status;
      t.updated_at = new Date().toISOString();
      write(d);
      this.recordEvent(card, `STATUS_${status.toUpperCase()}`);
    },
    get(card: string): TaskRow | undefined {
      return read().tasks.find((t) => t.card === card);
    },
  };
}

export async function getBacklog() {
  if (backend) return backend;
  backend = (await loadSqlite()) || loadJson();
  return backend;
}

// CLI: `node scripts/loop/backlog.ts <add|list|status> ...`
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
  const [cmd, ...rest] = process.argv.slice(2);
  const b = await getBacklog();
  if (cmd === "add") {
    const [card, ...spec] = rest;
    if (!card) { console.error("usage: backlog.ts add <card> <spec...>"); process.exit(2); }
    b.add(card, spec.join(" "));
    console.log(`[${b.kind}] added ${card}`);
  } else if (cmd === "list") {
    const rows = b.list(rest[0]);
    for (const t of rows) console.log(`${t.status.padEnd(8)} ${t.card}  (source=${t.source || "manual"}, attempts=${t.attempts})`);
    if (!rows.length) console.log("(empty)");
  } else if (cmd === "status") {
    const [card, status] = rest;
    if (!card || !status) {
      console.error("usage: backlog.ts status <card> <open|claimed|review|done|failed>");
      process.exit(2);
    }
    b.setStatus(card, status);
    console.log(`[${b.kind}] ${card} -> ${status}`);
  } else {
    console.error("usage: backlog.ts <add|list|status> ...");
    process.exit(2);
  }
}
