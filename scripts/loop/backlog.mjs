// backlog.mjs — SQLite-backed task backlog for the autonomous loop.
//
// One table, `tasks`, is the single source of truth for what the agent legion
// works on. The human writes intent into spec.md; the Lead agent turns each
// line into a task row here. Builders claim rows via claim-task.mjs.
//
// We use node:sqlite when available (Node >= 22.5 with --experimental-sqlite or
// >= 23 stable) and fall back to a JSON file so the loop still runs on Node 18.
// The fallback is intentionally dumb — it is a safety net, not a feature.

import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const ROOT = resolve(process.cwd());
const STATE_DIR = resolve(ROOT, ".harness");
const DB_PATH = resolve(STATE_DIR, "backlog.db");
const JSON_PATH = resolve(STATE_DIR, "backlog.json");

mkdirSync(STATE_DIR, { recursive: true });

// --- storage backend selection -------------------------------------------

let backend = null;

async function loadSqlite() {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        card        TEXT NOT NULL UNIQUE,
        spec        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open',  -- open|claimed|review|done|failed
        claimed_by  TEXT,
        attempts    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `);
    return {
      kind: "sqlite",
      add(card, spec) {
        const now = new Date().toISOString();
        db.prepare(
          `INSERT OR IGNORE INTO tasks (card, spec, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        ).run(card, spec, now, now);
      },
      list(status) {
        const q = status
          ? db.prepare(`SELECT * FROM tasks WHERE status = ? ORDER BY id`)
          : db.prepare(`SELECT * FROM tasks ORDER BY id`);
        return status ? q.all(status) : q.all();
      },
      // Atomic claim: only succeeds if the row is still 'open'. SQLite's
      // single-writer guarantee makes this the transaction half of the
      // claim protocol (the git lock file is the other half).
      claim(card, who) {
        const now = new Date().toISOString();
        const r = db
          .prepare(
            `UPDATE tasks SET status='claimed', claimed_by=?, attempts=attempts+1, updated_at=?
             WHERE card=? AND status='open'`,
          )
          .run(who, now, card);
        return r.changes === 1;
      },
      setStatus(card, status) {
        const now = new Date().toISOString();
        db.prepare(`UPDATE tasks SET status=?, updated_at=? WHERE card=?`).run(
          status,
          now,
          card,
        );
      },
      get(card) {
        return db.prepare(`SELECT * FROM tasks WHERE card=?`).get(card);
      },
    };
  } catch {
    return null;
  }
}

function loadJson() {
  const read = () => (existsSync(JSON_PATH) ? JSON.parse(readFileSync(JSON_PATH, "utf8")) : { tasks: [] });
  const write = (d) => writeFileSync(JSON_PATH, JSON.stringify(d, null, 2) + "\n");
  return {
    kind: "json",
    add(card, spec) {
      const d = read();
      if (d.tasks.some((t) => t.card === card)) return;
      const now = new Date().toISOString();
      d.tasks.push({ card, spec, status: "open", claimed_by: null, attempts: 0, created_at: now, updated_at: now });
      write(d);
    },
    list(status) {
      const d = read();
      return status ? d.tasks.filter((t) => t.status === status) : d.tasks;
    },
    claim(card, who) {
      const d = read();
      const t = d.tasks.find((x) => x.card === card);
      if (!t || t.status !== "open") return false;
      t.status = "claimed";
      t.claimed_by = who;
      t.attempts += 1;
      t.updated_at = new Date().toISOString();
      write(d);
      return true;
    },
    setStatus(card, status) {
      const d = read();
      const t = d.tasks.find((x) => x.card === card);
      if (!t) return;
      t.status = status;
      t.updated_at = new Date().toISOString();
      write(d);
    },
    get(card) {
      return read().tasks.find((t) => t.card === card) || null;
    },
  };
}

export async function getBacklog() {
  if (backend) return backend;
  backend = (await loadSqlite()) || loadJson();
  return backend;
}

// CLI: `node scripts/loop/backlog.mjs <add|list|status> ...`
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const b = await getBacklog();
  if (cmd === "add") {
    const [card, ...spec] = rest;
    if (!card) { console.error("usage: backlog.mjs add <card> <spec...>"); process.exit(2); }
    b.add(card, spec.join(" "));
    console.log(`[${b.kind}] added ${card}`);
  } else if (cmd === "list") {
    const rows = b.list(rest[0]);
    for (const t of rows) console.log(`${t.status.padEnd(8)} ${t.card}  (attempts=${t.attempts})`);
    if (!rows.length) console.log("(empty)");
  } else if (cmd === "status") {
    const [card, status] = rest;
    b.setStatus(card, status);
    console.log(`[${b.kind}] ${card} -> ${status}`);
  } else {
    console.error("usage: backlog.mjs <add|list|status> ...");
    process.exit(2);
  }
}
