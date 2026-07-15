// dashboard.mjs — the harness's local observability UI (the "studio").
//
// A zero-dependency web dashboard for watching and steering the autonomous loop,
// following the LangGraph-Studio / trace-viewer playbook, implemented on plain
// node:http against the harness's own state stores:
//
//   pipeline view   — the card state graph with the CURRENT node highlighted
//                     (live, from .harness/graph checkpoints)
//   span waterfall  — the nested execution timeline per card (trace.mjs): which
//                     node ran, which tool/CLI it invoked, duration, exit status
//   breakpoints     — click a node to arm/disarm a breakpoint; the loop pauses
//                     BEFORE that node and parks the card as 'paused'
//   state editor    — inspect and PATCH a paused card's checkpoint state, then
//                     ▶ resume (sets the card back to 'open')
//   time-travel     — rewind to any earlier step from the history trail
//   screenshots     — the .harness/shots gallery (what the agent's app looked
//                     like at approval time)
//
// Run:  node scripts/loop/dashboard.mjs            (http://127.0.0.1:4780)
// Env:  HARNESS_DASHBOARD_PORT (default 4780)
//
// Binds 127.0.0.1 only — this is a local operator console, not a public site.
// For hosted observability, set OTEL_EXPORTER_OTLP_ENDPOINT instead and read the
// same spans in Phoenix / Jaeger / LangSmith (see trace.mjs).

import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { getBacklog } from "./backlog.mjs";
import { activeCooldowns } from "./cooldown.mjs";
import { spans, recentTraces } from "./trace.mjs";
import {
  loadCheckpoint, listCheckpoints, patchCheckpointState, rewind, clearCheckpoint,
  breakpoints, setBreakpoint, clearBreakpoint,
} from "./graph.mjs";

const ROOT = resolve(process.cwd());
const STATE_DIR = resolve(process.env.HARNESS_STATE_DIR || resolve(ROOT, ".harness"));
const SHOTS_DIR = resolve(STATE_DIR, "shots");
const PORT = Number(process.env.HARNESS_DASHBOARD_PORT) || 4780;

// The card pipeline as declared in ralph-loop.mjs — kept here for rendering only;
// the live "where is it now" comes from the checkpoint, not from this list.
const PIPELINE = ["prime", "build", "strictHealth", "challenge", "review", "ship"];

function json(res, code, data) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((res, rej) => {
    let body = "";
    req.on("data", (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
    req.on("end", () => { try { res(body ? JSON.parse(body) : {}); } catch (e) { rej(e); } });
    req.on("error", rej);
  });
}

async function api(req, url) {
  const [, , verb, arg] = url.pathname.split("/"); // /api/<verb>/<arg?>
  const backlog = await getBacklog();

  if (req.method === "GET" && verb === "overview") {
    // Human prompts captured in the knowledge base but not yet triaged into
    // cards (assess-prompts.mjs runs only when the backlog empties). Optional:
    // in a repo without knowledge.mjs the import fails and the panel stays empty.
    let pendingPrompts = [];
    try {
      const { pendingPrompts: pending } = await import("./assess-prompts.mjs");
      pendingPrompts = (await pending(50)).map((e) => ({
        id: e.id,
        text: String(e.body || e.title || "").slice(0, 160),
      }));
    } catch {}
    return {
      pipeline: PIPELINE,
      cards: backlog.list(),
      pendingPrompts,
      cooldowns: activeCooldowns(),
      checkpoints: listCheckpoints(),
      breakpoints: breakpoints(),
      traces: await recentTraces(30),
    };
  }
  if (req.method === "GET" && verb === "card" && arg) {
    return {
      row: backlog.get(arg),
      checkpoint: loadCheckpoint(arg),
      spans: await spans(arg),
    };
  }
  if (req.method === "GET" && verb === "shots") {
    if (!existsSync(SHOTS_DIR)) return [];
    return readdirSync(SHOTS_DIR).filter((f) => f.endsWith(".png"))
      .map((f) => ({ name: f, mtime: statSync(join(SHOTS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime).slice(0, 24);
  }
  if (req.method === "POST" && verb === "breakpoint") {
    const { key, node, on } = await readBody(req);
    if (!key || !node) throw new Error("key and node required");
    return on ? setBreakpoint(key, node) : clearBreakpoint(key, node);
  }
  if (req.method === "POST" && verb === "state" && arg) {
    const patch = await readBody(req);
    const cp = patchCheckpointState(arg, patch);
    if (!cp) throw new Error(`no checkpoint for "${arg}"`);
    return cp;
  }
  if (req.method === "POST" && verb === "rewind" && arg) {
    const { step } = await readBody(req);
    const cp = rewind(arg, Number(step));
    if (!cp) throw new Error(`cannot rewind "${arg}" to step ${step}`);
    return cp;
  }
  if (req.method === "POST" && verb === "resume" && arg) {
    if (!backlog.get(arg)) throw new Error(`no card "${arg}"`);
    backlog.setStatus(arg, "open");
    return { card: arg, status: "open" };
  }
  if (req.method === "POST" && verb === "checkpoint-clear" && arg) {
    clearCheckpoint(arg);
    return { cleared: arg };
  }
  throw new Error(`unknown api: ${req.method} ${url.pathname}`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      json(res, 200, await api(req, url));
      return;
    }
    if (url.pathname.startsWith("/shots/")) {
      const name = url.pathname.slice("/shots/".length);
      // strict allowlist: a plain .png basename only — no separators, no traversal
      const p = /^[\w.-]+\.png$/.test(name) ? join(SHOTS_DIR, name) : null;
      if (p && existsSync(p)) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(readFileSync(p));
        return;
      }
      json(res, 404, { error: "not found" });
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 400, { error: String(e?.message ?? e) });
  }
});

// --- the single-page UI (inline, no CDN — works fully offline) --------------------

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>harness studio</title>
<style>
  :root { --bg:#0e1116; --panel:#161b22; --line:#2d333b; --fg:#c9d1d9; --dim:#768390;
          --ok:#3fb950; --err:#f85149; --run:#d29922; --acc:#539bf5; --bp:#e5534b; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; }
  header { padding:10px 16px; border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:baseline; }
  header h1 { font-size:14px; margin:0; color:var(--acc); }
  header .dim { color:var(--dim); }
  main { display:grid; grid-template-columns:270px 1fr; min-height:calc(100vh - 41px); }
  #side { border-right:1px solid var(--line); padding:12px; overflow-y:auto; }
  #main { padding:16px; overflow-x:auto; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:18px 0 8px; }
  h2:first-child { margin-top:0; }
  .card { padding:6px 8px; border:1px solid var(--line); border-radius:6px; margin-bottom:6px; cursor:pointer; display:flex; justify-content:space-between; gap:8px; }
  .card:hover, .card.sel { border-color:var(--acc); }
  .pill { font-size:11px; padding:0 7px; border-radius:9px; border:1px solid var(--line); white-space:nowrap; }
  .src { font-size:10px; color:var(--dim); border:1px solid var(--line); border-radius:4px; padding:0 4px; white-space:nowrap; }
  .src-prompt { color:var(--acc); } .src-spec { color:var(--ok); }
  .st-open { color:var(--acc); } .st-claimed { color:var(--run); } .st-review { color:var(--run); }
  .st-done { color:var(--ok); } .st-failed { color:var(--err); } .st-paused { color:var(--bp); }
  #pipe { display:flex; align-items:center; gap:0; flex-wrap:wrap; margin:8px 0 4px; }
  .node { position:relative; border:1px solid var(--line); border-radius:8px; padding:8px 14px; background:var(--panel); }
  .node.cur { border-color:var(--run); box-shadow:0 0 0 1px var(--run); color:var(--run); }
  .node.donepast { color:var(--dim); }
  .node .bp { position:absolute; top:-6px; right:-6px; width:12px; height:12px; border-radius:50%;
              border:1px solid var(--line); background:var(--bg); cursor:pointer; }
  .node .bp.on { background:var(--bp); border-color:var(--bp); }
  .arrow { color:var(--dim); padding:0 8px; }
  .muted { color:var(--dim); }
  table { border-collapse:collapse; width:100%; }
  td, th { padding:3px 8px; text-align:left; border-bottom:1px solid var(--line); vertical-align:top; }
  .bar-wrap { position:relative; background:var(--panel); height:14px; border-radius:3px; min-width:260px; }
  .bar { position:absolute; top:2px; height:10px; border-radius:2px; background:var(--acc); opacity:.85; }
  .bar.err { background:var(--err); } .bar.node-k { background:var(--run); }
  button { background:var(--panel); color:var(--fg); border:1px solid var(--line); border-radius:6px;
           padding:4px 10px; cursor:pointer; font:inherit; }
  button:hover { border-color:var(--acc); }
  button.warn { color:var(--bp); }
  textarea { width:100%; min-height:140px; background:var(--panel); color:var(--fg);
             border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; }
  #shots { display:flex; gap:10px; flex-wrap:wrap; }
  #shots img { width:180px; border:1px solid var(--line); border-radius:6px; }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .flash { color:var(--ok); }
</style>
</head>
<body>
<header>
  <h1>harness studio</h1>
  <span class="dim" id="meta">loading…</span>
  <span class="dim" style="margin-left:auto">breakpoint = red dot on a node · paused cards need ▶ resume</span>
</header>
<main>
  <div id="side">
    <h2>Backlog</h2>
    <div id="cards" class="muted">…</div>
    <h2>Prompts awaiting triage</h2>
    <div id="pending" class="muted">…</div>
    <h2>Cooldowns</h2>
    <div id="cooldowns" class="muted">…</div>
    <h2>Recent traces</h2>
    <div id="traces" class="muted">…</div>
  </div>
  <div id="main">
    <h2>Pipeline <span class="muted" id="pipecard"></span></h2>
    <div id="pipe" class="muted">select a card</div>
    <div id="ctrl" class="row"></div>
    <h2>Span waterfall</h2>
    <div id="water" class="muted">—</div>
    <h2>Checkpoint history (click a step to rewind)</h2>
    <div id="hist" class="muted">—</div>
    <h2>State editor <span class="muted">(patch merges into the checkpoint state)</span></h2>
    <textarea id="state" spellcheck="false" placeholder='{"feedback": ""}'></textarea>
    <div class="row" style="margin-top:6px">
      <button onclick="saveState()">save state patch</button>
      <span id="stateMsg"></span>
    </div>
    <h2>Screenshots (.harness/shots)</h2>
    <div id="shots" class="muted">—</div>
  </div>
</main>
<script>
var sel = null, overview = null;
function el(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
  return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]; }); }
function api(path, body) {
  var opts = body ? { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(body) } : {};
  return fetch(path, opts).then(function (r) { return r.json(); });
}

function renderOverview(o) {
  overview = o;
  el("meta").textContent = o.cards.length + " cards · " + o.checkpoints.length + " live checkpoints";
  el("cards").innerHTML = o.cards.map(function (c) {
    var src = c.source ? ' <span class="src src-' + esc(c.source) + '">' + esc(c.source) + '</span>' : '';
    return '<div class="card' + (sel === c.card ? " sel" : "") + '" onclick="pick(\\'' + esc(c.card) + '\\')">' +
      '<span>' + esc(c.card) + src + '</span><span class="pill st-' + esc(c.status) + '">' + esc(c.status) + '</span></div>';
  }).join("") || '<span class="muted">(empty)</span>';
  var pp = o.pendingPrompts || [];
  el("pending").innerHTML = pp.length ? pp.map(function (p) {
    return '<div class="card" title="kb#' + esc(p.id) + '"><span>' + esc(p.text) + '</span></div>';
  }).join("") : '<span class="muted">(none — every captured prompt is triaged)</span>';
  var cd = Object.keys(o.cooldowns || {});
  el("cooldowns").innerHTML = cd.length ? cd.map(function (a) {
    return esc(a) + ' → ' + esc(new Date(o.cooldowns[a].until).toLocaleTimeString());
  }).join("<br>") : '<span class="muted">none — all agents available</span>';
  el("traces").innerHTML = (o.traces || []).map(function (t) {
    return '<div class="card" onclick="pick(\\'' + esc(t.trace_id) + '\\')"><span>' + esc(t.trace_id) +
      '</span><span class="pill">' + t.n + ' spans</span></div>';
  }).join("") || '<span class="muted">(none yet)</span>';
}

function renderPipe(cp, bps) {
  var armed = (bps && (bps[sel] || [])).concat((bps && bps["*"]) || []);
  var cur = cp && cp.node;
  var html = overview.pipeline.map(function (n, i) {
    var cls = "node" + (n === cur ? " cur" : "");
    var bp = armed.indexOf(n) >= 0;
    return '<span class="' + cls + '">' + esc(n) +
      '<span class="bp' + (bp ? " on" : "") + '" title="toggle breakpoint" onclick="toggleBp(\\'' + esc(n) + '\\',' + !bp + ');event.stopPropagation()"></span></span>' +
      (i < overview.pipeline.length - 1 ? '<span class="arrow">──▶</span>' : "");
  }).join("");
  el("pipe").innerHTML = html;
  el("pipecard").textContent = sel ? "· " + sel + (cur ? " @ " + cur + " (step " + cp.step + ")" : " (no live checkpoint)") : "";
}

function renderWater(rows) {
  if (!rows.length) { el("water").innerHTML = '<span class="muted">no spans yet</span>'; return; }
  var t0 = Math.min.apply(null, rows.map(function (r) { return r.start_ms; }));
  var t1 = Math.max.apply(null, rows.map(function (r) { return r.end_ms || r.start_ms; }));
  var span = Math.max(1, t1 - t0);
  var depth = {};
  rows.forEach(function (r) { depth[r.span_id] = r.parent_id && depth[r.parent_id] != null ? depth[r.parent_id] + 1 : 0; });
  el("water").innerHTML = "<table>" + rows.map(function (r) {
    var l = ((r.start_ms - t0) / span) * 100, w = Math.max(0.6, (((r.end_ms || r.start_ms) - r.start_ms) / span) * 100);
    var cls = "bar" + (r.status === "error" ? " err" : r.kind === "node" ? " node-k" : "");
    var ms = r.end_ms ? (r.end_ms - r.start_ms) + "ms" : "…";
    var pad = "padding-left:" + (depth[r.span_id] * 16 + 8) + "px";
    return "<tr><td style='" + pad + ";white-space:nowrap'>" + (r.status === "error" ? "✗ " : "") + esc(r.name) +
      "</td><td class='muted'>" + esc(r.kind) + "</td><td class='muted'>" + ms +
      "</td><td><div class='bar-wrap'><div class='" + cls + "' style='left:" + l + "%;width:" + w + "%'></div></div></td></tr>";
  }).join("") + "</table>";
}

function renderHist(cp) {
  if (!cp || !cp.history || !cp.history.length) { el("hist").innerHTML = '<span class="muted">no checkpoint</span>'; return; }
  el("hist").innerHTML = "<table>" + cp.history.map(function (h) {
    return "<tr><td><button onclick=\\"doRewind(" + h.step + ")\\">⏪ " + h.step + "</button></td><td>" +
      esc(h.node) + " → " + esc(h.next) + "</td><td class='muted'>" + esc(h.at) + "</td></tr>";
  }).join("") + "</table>";
}

function renderCtrl(row, cp) {
  var b = [];
  if (row && row.status === "paused") b.push('<button onclick="doResume()">▶ resume (set open)</button>');
  if (cp) b.push('<button class="warn" onclick="doClearCp()">discard checkpoint (restart card)</button>');
  el("ctrl").innerHTML = b.join(" ");
}

function pick(card) { sel = card; refreshCard(); renderOverview(overview); }

function refreshCard() {
  if (!sel) return;
  api("/api/card/" + encodeURIComponent(sel)).then(function (d) {
    renderPipe(d.checkpoint, overview && overview.breakpoints);
    renderWater(d.spans || []);
    renderHist(d.checkpoint);
    renderCtrl(d.row, d.checkpoint);
    if (document.activeElement !== el("state")) {
      el("state").value = d.checkpoint ? JSON.stringify(d.checkpoint.state, null, 2) : "";
    }
  });
}

function toggleBp(node, on) {
  if (!sel) return;
  api("/api/breakpoint", { key: sel, node: node, on: on }).then(refreshCard);
}
function saveState() {
  var patch;
  try { patch = JSON.parse(el("state").value); } catch (e) { el("stateMsg").textContent = "invalid JSON"; return; }
  api("/api/state/" + encodeURIComponent(sel), patch).then(function () {
    el("stateMsg").innerHTML = '<span class="flash">saved</span>';
    setTimeout(function () { el("stateMsg").textContent = ""; }, 1500);
    refreshCard();
  });
}
function doRewind(step) { api("/api/rewind/" + encodeURIComponent(sel), { step: step }).then(refreshCard); }
function doResume() { api("/api/resume/" + encodeURIComponent(sel), {}).then(function () { tick(); }); }
function doClearCp() { api("/api/checkpoint-clear/" + encodeURIComponent(sel), {}).then(refreshCard); }

function renderShots(list) {
  el("shots").innerHTML = list.length ? list.map(function (s) {
    return '<a href="/shots/' + esc(s.name) + '" target="_blank"><img src="/shots/' + esc(s.name) + '" title="' + esc(s.name) + '"></a>';
  }).join("") : '<span class="muted">(none)</span>';
}

function tick() {
  api("/api/overview").then(function (o) { renderOverview(o); if (sel) refreshCard(); });
  api("/api/shots").then(renderShots);
}
tick();
setInterval(tick, 2500);
</script>
</body>
</html>`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`harness studio → http://127.0.0.1:${PORT}  (state: ${STATE_DIR})`);
  });
}

export { server, api, PORT };
