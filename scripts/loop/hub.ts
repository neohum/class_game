// hub.ts — the central knowledge hub client (cross-project memory).
//
// The hub is a shared store every harnessed project writes to, so that one
// project's hard-won lessons become every project's starting context. The whole
// point of a central hub is to *reuse instead of relearn* — but that only works
// if the hub is read as well as written. This module is both halves:
//
//   pushToHub(entry)              — POST one entry to /api/knowledge/ingest (write)
//   searchHub(query, opts)        — GET  /api/knowledge/search             (read)
//
// Both are best-effort with a short timeout: a slow or absent hub must never
// stall or fail the loop. searchHub returns null (not []) on any failure so the
// caller can distinguish "hub unreachable" from "hub returned nothing" and fall
// back to the local knowledge store.
//
// Config (env only — no secret is ever baked into the scaffold):
//   WIKI_URL / HUB_URL   base URL of the CtrlCV hub. WIKI_URL is preferred;
//                        an explicit empty value disables the hub.
//   WIKI_TOKEN / HUB_TOKEN bearer token. NOT defaulted: a token baked into source
//                        would ship to every scaffolded repo. Unset/empty => hub
//                        disabled (recall and push degrade to the local store).
//   KB_PROJECT  this project's name          (default: from .harness-version.json)
//
// Note: `??` (not `||`) so an explicit empty string is honored as "disabled"
// rather than falling through to the default.

import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { redactValue } from "./redact.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");

// The project name used to come from a scaffold-time substitution, which made
// this file template payload and left `./hub.ts` with no counterpart on disk for
// a typechecker to resolve. The scaffolder already records the name in the
// provenance stamp it writes and refreshes, so read it there instead: same value,
// one less generated source file.
function scaffoldedProjectName() {
  try {
    const stamp = JSON.parse(readFileSync(resolve(PROJECT_ROOT, ".harness-version.json"), "utf8"));
    if (stamp?.projectName) return String(stamp.projectName);
  } catch { /* fall through — the stamp is provenance, not a hard dependency */ }
  return basename(PROJECT_ROOT);
}

type DotenvKey = "WIKI_URL" | "WIKI_TOKEN" | "HUB_URL" | "HUB_TOKEN";

function dotenvValues(file = process.env.WIKI_ENV_FILE || resolve(process.cwd(), ".env")): Partial<Record<DotenvKey, string>> {
  if (!existsSync(file)) return {};
  const values: Partial<Record<DotenvKey, string>> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^(?:export\s+)?(WIKI_URL|WIKI_TOKEN|HUB_URL|HUB_TOKEN)\s*=\s*(.*)$/);
    if (!match) continue;
    values[match[1] as DotenvKey] = (match[2] ?? "").replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

const DOTENV = dotenvValues();
const HUB_URL = (process.env.WIKI_URL ?? process.env.HUB_URL ?? DOTENV.WIKI_URL ?? DOTENV.HUB_URL ?? "https://ctrlcv-wiki-production.up.railway.app").replace(/\/$/, "");
const HUB_TOKEN = process.env.WIKI_TOKEN ?? process.env.HUB_TOKEN ?? DOTENV.WIKI_TOKEN ?? DOTENV.HUB_TOKEN ?? "";
// Exported because searchHub takes a `project` option: a caller narrowing a
// search to "this project" needs to know what this project is called.
export const KB_PROJECT = process.env.KB_PROJECT || scaffoldedProjectName();

function configured() {
  return Boolean(HUB_URL && HUB_TOKEN);
}

async function hubFetch(path: string, init: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  if (typeof t.unref === "function") t.unref(); // don't keep the process alive / crash on exit
  try {
    return await fetch(`${HUB_URL}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${HUB_TOKEN}`, ...(init.headers || {}) },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Write one entry to the hub. Best-effort; never throws into the loop.
 * @param {{title:string, body?:string, tags?:string, source?:string, card?:string}} entry
 * @returns {Promise<boolean>} true if the hub acknowledged the write
 */
/** One knowledge entry as the hub ingests it. */
export interface HubEntry {
  title: string;
  body?: string;
  tags?: string;
  source?: string;
  card?: string | null;
}

export async function pushToHub(entry: HubEntry | null | undefined): Promise<boolean> {
  if (!configured() || !KB_PROJECT || !entry) return false;
  try {
    const safeEntry = redactValue(entry);
    const res = await hubFetch("/api/knowledge/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: KB_PROJECT,
        title: safeEntry.title,
        body: safeEntry.body,
        tags: safeEntry.tags,
        source: safeEntry.source,
        card: safeEntry.card,
      }),
    });
    if (!res.ok) { console.error(`[hub] push failed: ${res.status}`); return false; }
    return true;
  } catch (err) {
    console.error(`[hub] push error: ${(err as Error)?.message ?? err}`);
    return false;
  }
}

/**
 * Read prior knowledge from the hub. By default searches ACROSS ALL PROJECTS —
 * that cross-pollination is the entire value of a central hub. Pass a project to
 * scope it. Returns an array of entries, or null when the hub can't be read (so
 * the caller knows to fall back to the local store).
 *
 * Requires the hub to expose `GET /api/knowledge/search?q=&project=&limit=`
 * returning a JSON array (or {entries:[...]}). Until that endpoint exists the
 * call 404s and this returns null — recall then degrades to local-only, and
 * lights up automatically the moment the hub ships the read endpoint.
 *
 * @param {string} query
 * @param {{project?:string, limit?:number, allProjects?:boolean}} [opts]
 * @returns {Promise<Array<object>|null>}
 */
export async function searchHub(
  query: string,
  { project, limit = 10, allProjects = true }: { project?: string; limit?: number; allProjects?: boolean } = {},
): Promise<unknown[] | null> {
  if (!configured() || !query) return null;
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (!allProjects && (project || KB_PROJECT)) params.set("project", project || KB_PROJECT);
  try {
    const res = await hubFetch(`/api/knowledge/search?${params.toString()}`);
    if (!res.ok) return null; // 404 until the read endpoint exists -> caller falls back to local
    const data = (await res.json().catch(() => null)) as unknown[] | { entries?: unknown[] } | null;
    if (!data) return null;
    if (Array.isArray(data)) return data;
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return null;
  }
}

// CLI: node scripts/loop/hub.ts <search|push> ...
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
  if (cmd === "search") {
    const allProjects = !rest.includes("--mine");
    const q = rest.filter((a) => !a.startsWith("--")).join(" ");
    if (!q) { console.error('usage: hub.ts search "<query>" [--mine]'); process.exit(2); }
    const rows = await searchHub(q, { allProjects });
    if (rows === null) console.log("(hub unreachable or no read endpoint — fall back to local knowledge.ts)");
    else if (!rows.length) console.log("(no hub matches)");
    else for (const row of rows) {
      const e = row as { project?: string; title?: string; tags?: string };
      console.log(`[${e.project ?? "?"}] ${e.title}${e.tags ? `  {${e.tags}}` : ""}`);
    }
  } else if (cmd === "push") {
    const o: Partial<HubEntry> = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--title") o.title = rest[++i] ?? "";
      else if (rest[i] === "--tags") o.tags = rest[++i] ?? "";
      else if (rest[i] === "--source") o.source = rest[++i] ?? "";
      else if (rest[i] === "--card") o.card = rest[++i] ?? null;
      else if (rest[i] === "--") { o.body = rest.slice(i + 1).join(" "); break; }
    }
    if (!o.title) { console.error('usage: hub.ts push --title "..." [--tags a,b] [--source s] [-- body...]'); process.exit(2); }
    const ok = await pushToHub(o as HubEntry);
    console.log(ok ? "[hub] pushed" : "[hub] push failed");
  } else {
    console.error("usage: hub.ts <search|push> ...");
    process.exit(2);
  }
}
