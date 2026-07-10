# KNOWLEDGE_HUB.md — the central, cross-project memory

Every harnessed project writes what it learns to a shared **knowledge hub** so one
project's hard-won lesson becomes every project's starting context. The principle is
simple: **reuse instead of relearn.** A central hub only delivers that if it is read
as well as written — so the harness treats it as bidirectional.

## The two halves

| Direction | Who | Endpoint | Status |
| --------- | --- | -------- | ------ |
| **Write** (push) | `hub.mjs` `pushToHub` (called by `knowledge.mjs` `record`) | `POST /api/knowledge/ingest` | ✅ live |
| **Read** (recall) | `hub.mjs` `searchHub` (called by `knowledge.mjs` `recall`) | `GET /api/knowledge/search` | ✅ live |
| **Delete** (cleanup) | manual / admin (test & probe data) | `DELETE /api/knowledge/<id>`, `DELETE /api/knowledge?project=&tags=` | ✅ live |

Until the read endpoint exists, `recall` **degrades gracefully** to this project's
local `.harness/knowledge` store — and lights up across all projects automatically
the moment the hub ships the endpoint. Nothing in the loop breaks either way.

## Config (env)

```
HUB_URL     base url of the hub        (default: https://web-production-cccec4.up.railway.app)
HUB_TOKEN   bearer token               (baked default in template; override in prod)
KB_PROJECT  this project's name        (default: the project name)
```

## CLI

```bash
# write a lesson (also pushed to the hub)
node scripts/loop/knowledge.mjs add --title "Stripe webhooks need idempotency keys" \
  --tags payments,gotcha --source day-human -- "Duplicate events double-charged in test"

# RECALL before building — hub-first across ALL projects, local fallback
node scripts/loop/knowledge.mjs recall "stripe webhook idempotency"
node scripts/loop/hub.mjs search "auth session handling"        # hub only, all projects
node scripts/loop/hub.mjs search "auth session handling" --mine # hub only, this project
```

## Read endpoint the hub needs to expose

Add this one route to the hub app to turn on cross-project recall. The harness
already calls it; it just 404s until it exists.

```
GET /api/knowledge/search?q=<text>&limit=<n>&project=<optional>
Authorization: Bearer <HUB_TOKEN>

200 OK -> JSON array (or { "entries": [ ... ] }) of:
  { "id", "project", "title", "body", "tags", "source", "card", "created_at" }
```

- `q` matches title/body/tags (case-insensitive substring is fine; full-text is better).
- Omit `project` to search across **all** projects — that cross-pollination is the
  whole value of the hub, and is the harness default.
- Same bearer auth as `/api/knowledge/ingest`. Keep it read-only.

Reference implementation (mirrors `knowledge.mjs`'s local search), for a Next.js
route handler backed by the same store the ingest endpoint writes to:

```js
// GET /api/knowledge/search
export async function GET(req) {
  if (!authorized(req)) return new Response("unauthorized", { status: 401 });
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") || "").toLowerCase();
  const project = searchParams.get("project");
  const limit = Math.min(Number(searchParams.get("limit")) || 10, 50);
  let rows = await store.all(); // {id,project,title,body,tags,source,card,created_at}
  if (project) rows = rows.filter((r) => r.project === project);
  rows = rows
    .filter((r) => [r.title, r.body, r.tags].some((s) => (s || "").toLowerCase().includes(q)))
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
  return Response.json(rows);
}
```

## Where recall is used in the loop

- **Before validating/building a card** — `validate-card.mjs` recalls prior work on
  the same topic so the loop reuses solutions and avoids repeating known mistakes
  (see [`AUTONOMOUS_LOOP.md`](AUTONOMOUS_LOOP.md), "Validation gate").
- **Design harness** — `design-orchestrator` / `design-evolve` recall prior design
  decisions and accepted taste principles across projects before generating.

> The hub also serves humans at `/hub` (cross-project knowledge) and `/ops` (loop
> status). The API read endpoint above is the machine-readable counterpart so agents
> get the same recall a human gets from browsing `/hub`.
