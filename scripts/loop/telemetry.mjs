// telemetry.mjs — append-only action trail for the autonomous loop.
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
import { appendFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";

const ROOT = resolve(process.cwd());
const STATE_DIR = resolve(ROOT, ".harness");
const DB_PATH = resolve(STATE_DIR, "telemetry.db");
const MD_PATH = resolve(ROOT, "current.md");

mkdirSync(STATE_DIR, { recursive: true });

let db = null;
async function sqlite() {
  if (db === false) return null;
  if (db) return db;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const d = new DatabaseSync(DB_PATH);
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

function mdEscape(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * Record one event. Never throws — telemetry must not crash the loop.
 * @param {string} kind  claim|iterate|health|guard|commit|deploy|approve|reject|error
 * @param {{card?:string, actor?:string, detail?:any}} [meta]
 */
export async function log(kind, meta = {}) {
  const ts = new Date().toISOString();
  const card = meta.card ?? null;
  const actor = meta.actor ?? null;
  const detail =
    meta.detail == null
      ? null
      : typeof meta.detail === "string"
        ? meta.detail
        : JSON.stringify(meta.detail);

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

/** Recent events, newest first. Reads SQLite if available, else parses nothing. */
export async function recent(limit = 20) {
  const d = await sqlite();
  if (!d) return [];
  return d.prepare(`SELECT * FROM trail ORDER BY id DESC LIMIT ?`).all(limit);
}

// CLI: `node scripts/loop/telemetry.mjs <kind> [--card x] [--actor y] [--detail "..."]`
//      `node scripts/loop/telemetry.mjs tail [N]`
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv[0] === "tail") {
    const rows = await recent(Number(argv[1]) || 20);
    for (const r of rows.reverse()) {
      console.log(`${r.ts}  ${r.kind.padEnd(8)} ${r.card ?? "-"}  ${r.actor ?? "-"}  ${r.detail ?? ""}`);
    }
  } else {
    const kind = argv[0];
    if (!kind) { console.error('usage: telemetry.mjs <kind> [--card x] [--actor y] [--detail "..."] | tail [N]'); process.exit(2); }
    const meta = {};
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--card") meta.card = argv[++i];
      else if (argv[i] === "--actor") meta.actor = argv[++i];
      else if (argv[i] === "--detail") meta.detail = argv[++i];
    }
    await log(kind, meta);
    console.log(`logged ${kind}`);
  }
}
