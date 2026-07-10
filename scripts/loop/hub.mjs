// hub.mjs — the central knowledge hub client (cross-project memory).
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
// Config (env, with template defaults baked in at scaffold time):
//   HUB_URL     base url of the hub          (default below)
//   HUB_TOKEN   bearer token                 (default below)
//   KB_PROJECT  this project's name          (default: classgame)

const HUB_URL = (process.env.HUB_URL || "https://web-production-cccec4.up.railway.app").replace(/\/$/, "");
const HUB_TOKEN = process.env.HUB_TOKEN || "f1dfe8a3a2c8351e7c6eae1de84c1c6e864679a6eab78eab";
const KB_PROJECT = process.env.KB_PROJECT || "classgame";

function configured() {
  return Boolean(HUB_URL && HUB_TOKEN);
}

async function hubFetch(path, init = {}, timeoutMs = 5000) {
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
export async function pushToHub(entry) {
  if (!configured() || !KB_PROJECT || !entry) return false;
  try {
    const res = await hubFetch("/api/knowledge/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: KB_PROJECT,
        title: entry.title,
        body: entry.body,
        tags: entry.tags,
        source: entry.source,
        card: entry.card,
      }),
    });
    if (!res.ok) { console.error(`[hub] push failed: ${res.status}`); return false; }
    return true;
  } catch (err) {
    console.error(`[hub] push error: ${err?.message ?? err}`);
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
export async function searchHub(query, { project, limit = 10, allProjects = true } = {}) {
  if (!configured() || !query) return null;
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (!allProjects && (project || KB_PROJECT)) params.set("project", project || KB_PROJECT);
  try {
    const res = await hubFetch(`/api/knowledge/search?${params.toString()}`);
    if (!res.ok) return null; // 404 until the read endpoint exists -> caller falls back to local
    const data = await res.json().catch(() => null);
    if (!data) return null;
    return Array.isArray(data) ? data : Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return null;
  }
}

// CLI: node scripts/loop/hub.mjs <search|push> ...
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "search") {
    const allProjects = !rest.includes("--mine");
    const q = rest.filter((a) => !a.startsWith("--")).join(" ");
    if (!q) { console.error('usage: hub.mjs search "<query>" [--mine]'); process.exit(2); }
    const rows = await searchHub(q, { allProjects });
    if (rows === null) console.log("(hub unreachable or no read endpoint — fall back to local knowledge.mjs)");
    else if (!rows.length) console.log("(no hub matches)");
    else for (const e of rows) console.log(`[${e.project ?? "?"}] ${e.title}${e.tags ? `  {${e.tags}}` : ""}`);
  } else if (cmd === "push") {
    const o = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--title") o.title = rest[++i];
      else if (rest[i] === "--tags") o.tags = rest[++i];
      else if (rest[i] === "--source") o.source = rest[++i];
      else if (rest[i] === "--card") o.card = rest[++i];
      else if (rest[i] === "--") { o.body = rest.slice(i + 1).join(" "); break; }
    }
    if (!o.title) { console.error('usage: hub.mjs push --title "..." [--tags a,b] [--source s] [-- body...]'); process.exit(2); }
    const ok = await pushToHub(o);
    console.log(ok ? "[hub] pushed" : "[hub] push failed");
  } else {
    console.error("usage: hub.mjs <search|push> ...");
    process.exit(2);
  }
}
