// trace.mjs — span-based execution tracing for the autonomous loop.
//
// The observability playbook for a CUSTOM harness (no LangChain/LangGraph in the
// dependency tree) is: emit OpenTelemetry-style spans at every internal step and
// let a UI render them as a nested tree. This module is that layer, zero-dep:
//
//   withSpan(name, attrs, fn)  — run fn inside a span; nesting is automatic via
//                                AsyncLocalStorage, so a builder CLI call started
//                                inside a graph node becomes that node's child.
//   spans(traceId)             — read a card's spans back (for the dashboard's
//                                waterfall and the CLI tree view).
//
// One card = one trace (traceId is the card slug), so the whole claim → build ⇄
// health → review → ship journey reads as a single nested timeline: which node
// ran, which tool it invoked, how long, exit code, what failed.
//
// Storage: SQLite (.harness/trace.db) with a JSONL fallback (.harness/trace.jsonl),
// same pattern as telemetry.mjs, HARNESS_STATE_DIR-aware so swarm workers write
// to one shared trace store.
//
// OTLP export (optional): set OTEL_EXPORTER_OTLP_ENDPOINT and every finished span
// is also POSTed as OTLP/HTTP JSON to <endpoint>/v1/traces — plug the harness
// into Phoenix, Jaeger, LangSmith, or any OTel collector without code changes.
// Best-effort: an unreachable collector never slows or breaks the loop.
//
// CLI:
//   node scripts/loop/trace.mjs tree <card>     # nested span tree for a card
//   node scripts/loop/trace.mjs recent [N]      # last N traces (cards)

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

const ROOT = resolve(process.cwd());
const STATE_DIR = resolve(process.env.HARNESS_STATE_DIR || resolve(ROOT, ".harness"));
const DB_PATH = resolve(STATE_DIR, "trace.db");
const JSONL_PATH = resolve(STATE_DIR, "trace.jsonl");

const als = new AsyncLocalStorage();

let db = null;
async function sqlite() {
  if (db === false) return null;
  if (db) return db;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const d = new DatabaseSync(DB_PATH);
    d.exec(`
      CREATE TABLE IF NOT EXISTS spans (
        span_id   TEXT PRIMARY KEY,
        trace_id  TEXT NOT NULL,
        parent_id TEXT,
        name      TEXT NOT NULL,
        kind      TEXT,             -- node|tool|gate|llm|internal
        start_ms  INTEGER NOT NULL,
        end_ms    INTEGER,
        status    TEXT,             -- ok|error
        attrs     TEXT              -- JSON
      );
      CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans (trace_id, start_ms);
    `);
    db = d;
    return d;
  } catch {
    db = false;
    return null;
  }
}

const newId = () => randomBytes(8).toString("hex");

async function persist(span) {
  const row = {
    span_id: span.spanId, trace_id: span.traceId, parent_id: span.parentId,
    name: span.name, kind: span.kind || "internal",
    start_ms: span.start, end_ms: span.end, status: span.status || "ok",
    attrs: JSON.stringify(span.attrs || {}),
  };
  try {
    const d = await sqlite();
    if (d) {
      d.prepare(
        `INSERT OR REPLACE INTO spans (span_id, trace_id, parent_id, name, kind, start_ms, end_ms, status, attrs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.span_id, row.trace_id, row.parent_id, row.name, row.kind, row.start_ms, row.end_ms, row.status, row.attrs);
    } else {
      mkdirSync(STATE_DIR, { recursive: true });
      appendFileSync(JSONL_PATH, JSON.stringify(row) + "\n");
    }
  } catch { /* tracing must never break the loop */ }
  exportOtlp(span);
}

// --- OTLP/HTTP JSON export (optional, best-effort) -------------------------------

function exportOtlp(span) {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;
  // OTel ids are hex: 32 chars for traces, 16 for spans. Pad the card slug into a
  // stable trace id so all of a card's spans land in one OTel trace.
  const hexTrace = Buffer.from(String(span.traceId)).toString("hex").padEnd(32, "0").slice(0, 32);
  const body = {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "agent-harness" } }] },
      scopeSpans: [{
        scope: { name: "harness-loop" },
        spans: [{
          traceId: hexTrace,
          spanId: span.spanId,
          parentSpanId: span.parentId || undefined,
          name: span.name,
          kind: 1,
          startTimeUnixNano: String(span.start * 1e6),
          endTimeUnixNano: String((span.end ?? span.start) * 1e6),
          status: { code: span.status === "error" ? 2 : 1 },
          attributes: Object.entries(span.attrs || {}).map(([k, v]) => ({
            key: k, value: { stringValue: typeof v === "string" ? v : JSON.stringify(v) },
          })),
        }],
      }],
    }],
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3_000);
    fetch(`${endpoint.replace(/\/$/, "")}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }).catch(() => {}).finally(() => clearTimeout(timer));
  } catch { /* collector down — never the loop's problem */ }
}

// --- public API -------------------------------------------------------------------

/** The span currently in scope (or null) — parents are attached automatically. */
export function currentSpan() {
  return als.getStore() ?? null;
}

/**
 * Run `fn` inside a new span. Nesting is automatic: any withSpan call made inside
 * `fn` (however deep in the async chain) becomes a child of this span.
 *
 * @param {string} name span name (e.g. "node:build", "run:codex")
 * @param {{traceId?:string, kind?:string, [k:string]:any}} attrs traceId is
 *        inherited from the parent span when omitted
 * @param {(span:object)=>Promise<any>} fn may set span.attrs entries; a throw
 *        marks the span "error" and re-throws
 */
export async function withSpan(name, attrs, fn) {
  const parent = currentSpan();
  const { traceId, kind, ...rest } = attrs || {};
  const span = {
    traceId: traceId || parent?.traceId || "untraced",
    spanId: newId(),
    parentId: parent?.spanId || null,
    name,
    kind: kind || "internal",
    start: Date.now(),
    attrs: rest,
  };
  return als.run(span, async () => {
    try {
      const result = await fn(span);
      span.status = span.status || "ok";
      return result;
    } catch (e) {
      span.status = "error";
      span.attrs.error = String(e?.message ?? e).slice(0, 500);
      throw e;
    } finally {
      span.end = Date.now();
      await persist(span);
    }
  });
}

/** All spans of a trace (card), oldest first. */
export async function spans(traceId) {
  const d = await sqlite();
  if (d) {
    return d.prepare(`SELECT * FROM spans WHERE trace_id = ? ORDER BY start_ms, span_id`).all(traceId)
      .map((r) => ({ ...r, attrs: safeParse(r.attrs) }));
  }
  return readJsonl().filter((r) => r.trace_id === traceId)
    .sort((a, b) => a.start_ms - b.start_ms)
    .map((r) => ({ ...r, attrs: safeParse(r.attrs) }));
}

/** Distinct recent traceIds, newest first. */
export async function recentTraces(limit = 20) {
  const d = await sqlite();
  if (d) {
    return d.prepare(
      `SELECT trace_id, MAX(start_ms) AS last, COUNT(*) AS n FROM spans GROUP BY trace_id ORDER BY last DESC LIMIT ?`,
    ).all(limit);
  }
  const byTrace = new Map();
  for (const r of readJsonl()) {
    const e = byTrace.get(r.trace_id) || { trace_id: r.trace_id, last: 0, n: 0 };
    e.last = Math.max(e.last, r.start_ms);
    e.n += 1;
    byTrace.set(r.trace_id, e);
  }
  return [...byTrace.values()].sort((a, b) => b.last - a.last).slice(0, limit);
}

function safeParse(s) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}
function readJsonl() {
  if (!existsSync(JSONL_PATH)) return [];
  return readFileSync(JSONL_PATH, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/** Render a trace as an indented tree (for the CLI). */
export function renderTree(rows) {
  const children = new Map();
  for (const r of rows) {
    const key = r.parent_id || "";
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(r);
  }
  const known = new Set(rows.map((r) => r.span_id));
  const lines = [];
  const walk = (parentKey, depth) => {
    for (const r of children.get(parentKey) || []) {
      const ms = r.end_ms ? `${r.end_ms - r.start_ms}ms` : "…";
      const mark = r.status === "error" ? "✗" : "•";
      lines.push(`${"  ".repeat(depth)}${mark} ${r.name}  [${r.kind}] ${ms}`);
      walk(r.span_id, depth + 1);
    }
  };
  walk("", 0);
  // Orphans (parent span never persisted — e.g. process died mid-span) still show.
  for (const r of rows) {
    if (r.parent_id && !known.has(r.parent_id)) {
      lines.push(`• ${r.name}  [${r.kind}] (orphan)`);
    }
  }
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "tree" && arg) {
    const rows = await spans(arg);
    if (!rows.length) { console.error(`no spans for trace "${arg}"`); process.exit(3); }
    console.log(renderTree(rows));
  } else if (cmd === "recent") {
    const rows = await recentTraces(Number(arg) || 20);
    for (const r of rows) console.log(`${r.trace_id}  spans=${r.n}  last=${new Date(r.last).toISOString()}`);
    if (!rows.length) console.log("(no traces)");
  } else {
    console.error("usage: trace.mjs <tree <card> | recent [N]>");
    process.exit(2);
  }
}
