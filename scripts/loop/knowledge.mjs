// knowledge.mjs — the knowledge base for the autonomous loop.
//
// The product's core idea: every night's/day's experience — what was attempted,
// decided, what worked or failed, and what was learned — is captured here so
// future sessions can search and reuse it instead of relearning. The loop
// records entries automatically (see ralph-loop.mjs); humans/agents can also
// add and search from the CLI.
//
// Same storage convention as backlog.mjs: node:sqlite when available, JSON file
// fallback, both under .harness/ (override the dir with HARNESS_STATE_DIR).

import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { pushToHub, searchHub } from "./hub.mjs";

const ROOT = resolve(process.cwd());
const STATE_DIR = resolve(ROOT, process.env.HARNESS_STATE_DIR || ".harness");
const DB_PATH = resolve(STATE_DIR, "knowledge.db");
const JSON_PATH = resolve(STATE_DIR, "knowledge.json");

mkdirSync(STATE_DIR, { recursive: true });

function normTags(tags) {
  if (Array.isArray(tags)) return tags.join(",");
  return String(tags ?? "").trim();
}

let backend = null;

async function loadSqlite() {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        title       TEXT NOT NULL,
        body        TEXT NOT NULL DEFAULT '',
        tags        TEXT NOT NULL DEFAULT '',
        source      TEXT NOT NULL DEFAULT 'unknown',  -- night-ai | day-human | ...
        card        TEXT,
        created_at  TEXT NOT NULL
      );
    `);
    return {
      kind: "sqlite",
      add(e) {
        const now = new Date().toISOString();
        const r = db
          .prepare(
            `INSERT INTO knowledge (title, body, tags, source, card, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(e.title, e.body ?? "", normTags(e.tags), e.source ?? "unknown", e.card ?? null, now);
        return { id: Number(r.lastInsertRowid), title: e.title, body: e.body ?? "", tags: normTags(e.tags), source: e.source ?? "unknown", card: e.card ?? null, created_at: now };
      },
      search(query, limit = 20) {
        const like = `%${query}%`;
        return db
          .prepare(
            `SELECT * FROM knowledge
             WHERE title LIKE ? OR body LIKE ? OR tags LIKE ?
             ORDER BY id DESC LIMIT ?`,
          )
          .all(like, like, like, limit);
      },
      list(limit = 20) {
        return db.prepare(`SELECT * FROM knowledge ORDER BY id DESC LIMIT ?`).all(limit);
      },
      get(id) {
        return db.prepare(`SELECT * FROM knowledge WHERE id = ?`).get(Number(id)) ?? null;
      },
    };
  } catch {
    return null;
  }
}

function loadJson() {
  const read = () =>
    existsSync(JSON_PATH) ? JSON.parse(readFileSync(JSON_PATH, "utf8")) : { entries: [], seq: 0 };
  const write = (d) => writeFileSync(JSON_PATH, JSON.stringify(d, null, 2) + "\n");
  const matches = (e, q) =>
    [e.title, e.body, e.tags].some((s) => (s || "").toLowerCase().includes(q.toLowerCase()));
  return {
    kind: "json",
    add(e) {
      const d = read();
      const now = new Date().toISOString();
      const entry = {
        id: ++d.seq,
        title: e.title,
        body: e.body ?? "",
        tags: normTags(e.tags),
        source: e.source ?? "unknown",
        card: e.card ?? null,
        created_at: now,
      };
      d.entries.push(entry);
      write(d);
      return entry;
    },
    search(query, limit = 20) {
      return read().entries.filter((e) => matches(e, query)).reverse().slice(0, limit);
    },
    list(limit = 20) {
      return read().entries.slice().reverse().slice(0, limit);
    },
    get(id) {
      return read().entries.find((e) => e.id === Number(id)) ?? null;
    },
  };
}

export async function getKnowledge() {
  if (backend) return backend;
  // JSON-primary here: node:sqlite needs Node >=22.5 and isn't typed under this
  // repo's @types/node@20, and the admin-web portal (which reads this store)
  // must work regardless of Node version. JSON is plenty for task-summary volume.
  backend = loadJson();
  return backend;
}

/** Record one entry. Best-effort — never throws into the caller (the loop).
 *  Writes locally AND pushes to the central hub (hub.mjs) so the lesson is
 *  available to every other project, not just this one. */
export async function record(entry) {
  try {
    const kb = await getKnowledge();
    const saved = kb.add(entry);
    await pushToHub(saved);
    return saved;
  } catch (err) {
    console.error("[knowledge] record failed:", err?.message ?? err);
    return null;
  }
}

/** Recall prior knowledge before doing new work — the read half of the hub.
 *  Tries the central hub first (ACROSS ALL PROJECTS, the whole point of a shared
 *  hub: reuse instead of relearn), and falls back to this project's local store
 *  when the hub can't be read. Returns { source, entries }. Best-effort.
 *  @param {string} query
 *  @param {{limit?:number, localOnly?:boolean}} [opt]
 */
export async function recall(query, { limit = 10, localOnly = false } = {}) {
  try {
    if (!localOnly) {
      const hubRows = await searchHub(query, { limit, allProjects: true });
      if (hubRows && hubRows.length) return { source: "hub", entries: hubRows };
    }
    const kb = await getKnowledge();
    return { source: "local", entries: kb.search(query, limit) };
  } catch (err) {
    console.error("[knowledge] recall failed:", err?.message ?? err);
    return { source: "none", entries: [] };
  }
}

function parseFlags(args) {
  const o = { body: "" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      o.body = args.slice(i + 1).join(" ");
      break;
    } else if (a === "--title") o.title = args[++i];
    else if (a === "--tags") o.tags = args[++i];
    else if (a === "--source") o.source = args[++i];
    else if (a === "--card") o.card = args[++i];
  }
  return o;
}

function printRows(rows) {
  if (!rows.length) {
    console.log("(none)");
    return;
  }
  for (const e of rows) {
    const id = e.id != null ? `#${String(e.id).padEnd(4)} ` : "";
    const origin = e.project || e.source || "?"; // hub rows carry project; local rows carry source
    console.log(`${id}[${origin}] ${e.title}${e.tags ? `  {${e.tags}}` : ""}`);
  }
}

// CLI: node scripts/loop/knowledge.mjs <add|search|list|get> ...
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const kb = await getKnowledge();
  if (cmd === "add") {
    const o = parseFlags(rest);
    if (!o.title) {
      console.error('usage: knowledge.mjs add --title "..." [--tags a,b] [--source night-ai|day-human] [--card CARD] [-- body...]');
      process.exit(2);
    }
    const e = kb.add(o);
    await pushToHub(e);
    console.log(`[${kb.kind}] added #${e.id}: ${e.title}`);
  } else if (cmd === "search") {
    if (!rest.length) {
      console.error("usage: knowledge.mjs search <query>");
      process.exit(2);
    }
    printRows(kb.search(rest.join(" ")));
  } else if (cmd === "recall") {
    // recall = hub-first (all projects), local fallback — use this before building.
    if (!rest.length) {
      console.error("usage: knowledge.mjs recall <query>   (searches the central hub across all projects, then local)");
      process.exit(2);
    }
    const r = await recall(rest.join(" "));
    console.log(`[recall via ${r.source}]`);
    printRows(r.entries);
  } else if (cmd === "list") {
    printRows(kb.list(Number(rest[0]) || 20));
  } else if (cmd === "get") {
    const e = kb.get(rest[0]);
    if (!e) console.log("(not found)");
    else
      console.log(
        `#${e.id}  ${e.title}\nsource=${e.source}  tags=${e.tags || "-"}  card=${e.card ?? "-"}  ${e.created_at}\n\n${e.body}`,
      );
  } else {
    console.error("usage: knowledge.mjs <add|search|recall|list|get> ...");
    process.exit(2);
  }
}
