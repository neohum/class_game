// knowledge.ts — the knowledge base for the autonomous loop.
//
// The product's core idea: every night's/day's experience — what was attempted,
// decided, what worked or failed, and what was learned — is captured here so
// future sessions can search and reuse it instead of relearning. The loop
// records entries automatically (see ralph-loop.ts); humans/agents can also
// add and search from the CLI.
//
// Same storage convention as backlog.ts: node:sqlite when available, JSON file
// fallback, both under .harness/ (override the dir with HARNESS_STATE_DIR).

import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pushToHub, searchHub } from "./hub.ts";
import { redactValue } from "./redact.ts";

const ROOT = resolve(process.cwd());
const STATE_DIR = resolve(ROOT, process.env.HARNESS_STATE_DIR || ".harness");
const DB_PATH = resolve(STATE_DIR, "knowledge.db");
const JSON_PATH = resolve(STATE_DIR, "knowledge.json");

mkdirSync(STATE_DIR, { recursive: true });

/** One knowledge entry as stored. */
export interface Entry {
  id: number;
  title: string;
  body: string;
  tags: string;
  source: string;
  card: string | null;
  created_at: string;
  updated_at?: string;
}

/**
 * What recall hands back. A hub hit carries `project` (which repo learned it);
 * a local hit does not. Callers render both, so the union is the honest shape
 * rather than something to cast away at each call site.
 */
export type RecalledEntry = Entry & { project?: string };

/** A new or patched entry, before the store fills in ids and timestamps. */
export type EntryInput = Partial<Omit<Entry, "id" | "created_at">> & { title?: string; tags?: string | string[] };

/**
 * The store, in the shape both backends implement.
 *
 * Exported for the same reason backlog's is: a verb present on only one backend
 * turns a future switch into a runtime TypeError rather than a decision.
 */
export interface KnowledgeStore {
  kind: string;
  add(e: EntryInput): Entry;
  search(query: string, limit?: number): Entry[];
  list(limit?: number): Entry[];
  get(id: number | string): Entry | null;
  update(id: number | string, patch: EntryInput): Entry | null;
  remove(id: number | string): Entry | null;
}

function normTags(tags: unknown): string {
  if (Array.isArray(tags)) return tags.join(",");
  return String(tags ?? "").trim();
}

let backend: KnowledgeStore | null = null;

async function loadSqlite() {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(DB_PATH);
    // WAL lets readers and writers coexist, but it does NOT make a second
    // writer wait: without a busy timeout SQLite returns SQLITE_BUSY at once,
    // so a swarm worker sharing HARNESS_STATE_DIR fails its claim instead of
    // queueing behind the worker that holds the lock. Found in the field.
    try { db.exec("PRAGMA busy_timeout = 5000;"); } catch {}
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
      add(e: EntryInput): Entry {
        const now = new Date().toISOString();
        const r = db
          .prepare(
            `INSERT INTO knowledge (title, body, tags, source, card, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(e.title ?? "", e.body ?? "", normTags(e.tags), e.source ?? "unknown", e.card ?? null, now);
        return { id: Number(r.lastInsertRowid), title: e.title ?? "", body: e.body ?? "", tags: normTags(e.tags), source: e.source ?? "unknown", card: e.card ?? null, created_at: now };
      },
      search(query: string, limit = 20): Entry[] {
        const like = `%${query}%`;
        return db
          .prepare(
            `SELECT * FROM knowledge
             WHERE title LIKE ? OR body LIKE ? OR tags LIKE ?
             ORDER BY id DESC LIMIT ?`,
          )
          .all(like, like, like, limit) as unknown as Entry[];
      },
      list(limit = 20): Entry[] {
        return db.prepare(`SELECT * FROM knowledge ORDER BY id DESC LIMIT ?`).all(limit) as unknown as Entry[];
      },
      get(id: number | string): Entry | null {
        return (db.prepare(`SELECT * FROM knowledge WHERE id = ?`).get(Number(id)) as unknown as Entry | undefined) ?? null;
      },
      // Kept at parity with the JSON backend even though getKnowledge() currently
      // prefers JSON: a backend that silently lacks a verb turns a future switch
      // into a runtime TypeError instead of a decision.
      update(id: number | string, patch: EntryInput): Entry | null {
        const current = this.get(id);
        if (!current) return null;
        const next = {
          title: patch.title ?? current.title,
          body: patch.body ?? current.body,
          tags: patch.tags !== undefined ? normTags(patch.tags) : current.tags,
          source: patch.source ?? current.source,
          card: patch.card !== undefined ? patch.card : current.card,
        };
        db.prepare(`UPDATE knowledge SET title=?, body=?, tags=?, source=?, card=? WHERE id=?`)
          .run(next.title, next.body, next.tags, next.source, next.card, Number(id));
        return { ...current, ...next, updated_at: new Date().toISOString() };
      },
      remove(id: number | string): Entry | null {
        const current = this.get(id);
        if (!current) return null;
        db.prepare(`DELETE FROM knowledge WHERE id = ?`).run(Number(id));
        return current;
      },
    };
  } catch {
    return null;
  }
}

function loadJson(): KnowledgeStore {
  const read = (): { entries: Entry[]; seq: number } =>
    existsSync(JSON_PATH) ? JSON.parse(readFileSync(JSON_PATH, "utf8")) : { entries: [], seq: 0 };
  const write = (d: { entries: Entry[]; seq: number }) => writeFileSync(JSON_PATH, JSON.stringify(d, null, 2) + "\n");
  const matches = (e: Entry, q: string) =>
    [e.title, e.body, e.tags].some((s) => (s || "").toLowerCase().includes(q.toLowerCase()));
  return {
    kind: "json",
    add(e: EntryInput): Entry {
      const d = read();
      const now = new Date().toISOString();
      const entry: Entry = {
        id: ++d.seq,
        title: e.title ?? "",
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
    search(query: string, limit = 20): Entry[] {
      return read().entries.filter((e) => matches(e, query)).reverse().slice(0, limit);
    },
    list(limit = 20): Entry[] {
      return read().entries.slice().reverse().slice(0, limit);
    },
    get(id: number | string): Entry | null {
      return read().entries.find((e) => e.id === Number(id)) ?? null;
    },
    // Memory that can only grow is memory that cannot be corrected. A lesson
    // recorded from a wrong diagnosis keeps being recalled as if it were true,
    // and the loop reuses it instead of relearning — the exact failure the hub
    // exists to prevent, inverted. `created_at` is provenance and never moves;
    // `updated_at` appears the first time an entry is corrected.
    update(id: number | string, patch: EntryInput): Entry | null {
      const d = read();
      const entry = d.entries.find((e) => e.id === Number(id));
      if (!entry) return null;
      // Field-by-field so an absent key leaves the stored value alone; a
      // spread would write undefined over it.
      if (patch.title !== undefined) entry.title = patch.title;
      if (patch.body !== undefined) entry.body = patch.body;
      if (patch.source !== undefined) entry.source = patch.source;
      if (patch.card !== undefined) entry.card = patch.card;
      if (patch.tags !== undefined) entry.tags = normTags(patch.tags);
      entry.updated_at = new Date().toISOString();
      write(d);
      return entry;
    },
    remove(id: number | string): Entry | null {
      const d = read();
      const i = d.entries.findIndex((e) => e.id === Number(id));
      if (i === -1) return null;
      const [removed] = d.entries.splice(i, 1);
      write(d);
      return removed ?? null;
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
 *  Writes locally AND pushes to the central hub (hub.ts) so the lesson is
 *  available to every other project, not just this one.
 *  Pure repeats are skipped: a requeued card that fails the same way every
 *  attempt would otherwise push an identical entry each time (the
 *  `task,rejected` spam the hub once accumulated). Same title + same body
 *  carries zero new information — return the existing entry instead. */
export async function record(entry: EntryInput): Promise<Entry | null> {
  try {
    const safeEntry = redactValue(entry);
    const kb = await getKnowledge();
    const dupe = kb
      .search(safeEntry.title ?? "", 5)
      .find((e) => e.title === safeEntry.title && (e.body ?? "") === (safeEntry.body ?? ""));
    if (dupe) return dupe;
    const saved = kb.add(safeEntry);
    await pushToHub(saved);
    return saved;
  } catch (err) {
    console.error("[knowledge] record failed:", (err as Error)?.message ?? err);
    return null;
  }
}

/** Trail entries — raw agent/human prompts the invoke-* wrappers archive, tagged
 *  `prompt` — are kept for the hub's browsing/audit surfaces (/hub) and for
 *  assess-prompts.ts, but they are NOT knowledge: recall excludes them so a
 *  builder gets distilled lessons, not another project's prompt logs. */
function isTrail(e: RecalledEntry): boolean {
  return String(e?.tags ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .includes("prompt");
}

/** Recall prior knowledge before doing new work — the read half of the hub.
 *  Tries the central hub first (ACROSS ALL PROJECTS, the whole point of a shared
 *  hub: reuse instead of relearn), and falls back to this project's local store
 *  when the hub can't be read. Prompt-trail entries are filtered out unless
 *  includeTrail is set. Returns { source, entries }. Best-effort.
 *  @param {string} query
 *  @param {{limit?:number, localOnly?:boolean, includeTrail?:boolean}} [opt]
 */
export async function recall(
  query: string,
  { limit = 10, localOnly = false, includeTrail = false } = {},
): Promise<{ source: "hub" | "local" | "none"; entries: RecalledEntry[] }> {
  // Trail entries can dominate the store and filtering happens client-side, so
  // over-fetch to let `limit` real lessons survive the filter.
  const fetchLimit = includeTrail ? limit : limit * 5;
  const keep = (rows: RecalledEntry[]) => (includeTrail ? rows : rows.filter((e) => !isTrail(e))).slice(0, limit);
  try {
    if (!localOnly) {
      const hubRows = await searchHub(query, { limit: fetchLimit, allProjects: true });
      if (hubRows) {
        const entries = keep(hubRows as RecalledEntry[]);
        if (entries.length) return { source: "hub", entries };
      }
    }
    const kb = await getKnowledge();
    return { source: "local", entries: keep(kb.search(query, fetchLimit)) };
  } catch (err) {
    console.error("[knowledge] recall failed:", (err as Error)?.message ?? err);
    return { source: "none", entries: [] };
  }
}

/**
 * Flags for `update`: only the fields actually given.
 *
 * parseFlags always seeds `body: ""` because `add` needs a body either way. Reusing
 * it for a patch would blank the body of every entry updated for its title alone —
 * a silent edit that looks like a successful correction.
 */
function parsePatch(args: string[]): EntryInput {
  const patch: EntryInput = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { patch.body = args.slice(i + 1).join(" "); break; }
    else if (a === "--title") patch.title = args[++i];
    else if (a === "--tags") patch.tags = args[++i];
    else if (a === "--source") patch.source = args[++i];
    else if (a === "--card") patch.card = args[++i];
  }
  return patch;
}

function parseFlags(args: string[]): EntryInput {
  const o: EntryInput = { body: "" };
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

function printRows(rows: RecalledEntry[]): void {
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

// CLI: node scripts/loop/knowledge.ts <add|search|list|get> ...
// (argv[1] is undefined under `node -e`/REPL imports — guard so importing never crashes)
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
  const kb = await getKnowledge();
  if (cmd === "add") {
    const o = parseFlags(rest);
    if (!o.title) {
      console.error('usage: knowledge.ts add --title "..." [--tags a,b] [--source night-ai|day-human] [--card CARD] [-- body...]');
      process.exit(2);
    }
    const e = kb.add(redactValue(o));
    await pushToHub(e);
    console.log(`[${kb.kind}] added #${e.id}: ${e.title}`);
  } else if (cmd === "search") {
    if (!rest.length) {
      console.error("usage: knowledge.ts search <query>");
      process.exit(2);
    }
    printRows(kb.search(rest.join(" ")));
  } else if (cmd === "recall") {
    // recall = hub-first (all projects), local fallback — use this before building.
    if (!rest.length) {
      console.error("usage: knowledge.ts recall <query>   (searches the central hub across all projects, then local)");
      process.exit(2);
    }
    const r = await recall(rest.join(" "));
    console.log(`[recall via ${r.source}]`);
    printRows(r.entries);
  } else if (cmd === "list") {
    printRows(kb.list(Number(rest[0]) || 20));
  } else if (cmd === "get") {
    const e = kb.get(rest[0] ?? "");
    if (!e) console.log("(not found)");
    else
      console.log(
        `#${e.id}  ${e.title}\nsource=${e.source}  tags=${e.tags || "-"}  card=${e.card ?? "-"}  ${e.created_at}\n\n${e.body}`,
      );
  } else if (cmd === "update") {
    // Correcting a lesson matters more than recording one: a wrong entry keeps
    // being recalled as if it were true, and the loop reuses it instead of
    // relearning. Local-only — the hub client is push/search, so a correction
    // here does not retract what was already pushed.
    const [id, ...flagArgs] = rest;
    const patch = parsePatch(flagArgs);
    if (!id || !Object.keys(patch).length) {
      console.error('usage: knowledge.ts update <id> [--title "..."] [--tags a,b] [--source ...] [--card CARD] [-- body...]');
      process.exit(2);
    }
    const e = kb.update(id, redactValue(patch));
    if (!e) { console.error(`[${kb.kind}] no entry #${id}`); process.exit(1); }
    console.log(`[${kb.kind}] updated #${e.id}: ${e.title}`);
  } else if (cmd === "remove") {
    const id = rest[0];
    if (!id) {
      console.error("usage: knowledge.ts remove <id>");
      process.exit(2);
    }
    const e = kb.remove(id);
    if (!e) { console.error(`[${kb.kind}] no entry #${id}`); process.exit(1); }
    console.log(`[${kb.kind}] removed #${e.id}: ${e.title}`);
  } else {
    console.error("usage: knowledge.ts <add|search|recall|list|get|update|remove> ...");
    process.exit(2);
  }
}
