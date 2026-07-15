// graph.mjs — a minimal declarative state-graph runtime for the autonomous loop.
//
// The task pipeline used to be one long hardcoded function. This module lets the
// loop express that control flow the LangGraph way instead: a set of named NODES
// (async functions over a JSON-serializable STATE) plus EDGES (pure functions
// that look at the state and name the next node). The runtime walks the graph,
// checkpointing the state to disk after every node, which buys three things the
// hardcoded pipeline could not offer:
//
//   resume       — if the loop process dies mid-card (crash, SIGKILL, reboot),
//                  the next claim resumes at the exact node it stopped at,
//                  instead of restarting the card from scratch.
//   time-travel  — every step's state snapshot is kept in the checkpoint, so a
//                  human can `graph.mjs rewind <card> <step>` to re-run from any
//                  earlier point (e.g. re-review without rebuilding).
//   loop guard   — a hard `maxSteps` cap means a cyclic graph (build ⇄ health)
//                  can never spin forever, whatever the edges decide.
//
// Deliberately NOT a framework: no dependencies, no DSL, ~200 lines. Nodes get
// (state, ctx) where ctx carries the non-serializable handles (backlog, flags);
// only `state` is persisted, so everything in it must survive JSON round-trips.
//
// Checkpoints live under .harness/graph/<key>.json (HARNESS_STATE_DIR-aware, so
// swarm workers sharing one state dir also share graph checkpoints).
//
// CLI:
//   node scripts/loop/graph.mjs list                 # all checkpoints
//   node scripts/loop/graph.mjs history <key>        # step-by-step trail
//   node scripts/loop/graph.mjs show <key>           # current node + state
//   node scripts/loop/graph.mjs rewind <key> <step>  # time-travel to a step
//   node scripts/loop/graph.mjs clear <key>          # drop the checkpoint

import { resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync,
} from "node:fs";
import { withSpan } from "./trace.mjs";

const ROOT = resolve(process.cwd());
// Swarm workers point HARNESS_STATE_DIR at the primary repo's .harness so every
// worker sees the same backlog, cooldowns, and graph checkpoints.
const STATE_DIR = resolve(process.env.HARNESS_STATE_DIR || resolve(ROOT, ".harness"));
const GRAPH_DIR = resolve(STATE_DIR, "graph");

/** Terminal sentinel: an edge returning END finishes the run (checkpoint cleared). */
export const END = "__end__";
/** Halt sentinel: an edge returning HALT stops the run but KEEPS the checkpoint,
 *  so a later run with the same key resumes at the current node (used for
 *  graceful SIGTERM mid-card). */
export const HALT = "__halt__";

// Persisted state snapshots cap long string fields (health logs, builder output)
// so a chatty card can't grow its checkpoint without bound. In-memory state is
// never trimmed — only what lands on disk.
const SNAPSHOT_STRING_CAP = 16_000;

function checkpointPath(key) {
  return resolve(GRAPH_DIR, `${key}.json`);
}

function trimForSnapshot(state) {
  const out = {};
  for (const [k, v] of Object.entries(state)) {
    out[k] = typeof v === "string" && v.length > SNAPSHOT_STRING_CAP
      ? v.slice(-SNAPSHOT_STRING_CAP)
      : v;
  }
  return out;
}

/**
 * Declare a graph. Validates the wiring up front so a typo'd edge target fails
 * at startup, not three hours into an autonomous run.
 * @param {{name:string, start:string, nodes:Record<string,Function>, edges:Record<string,Function>}} def
 */
export function defineGraph({ name = "graph", start, nodes = {}, edges = {} }) {
  if (!start || !nodes[start]) throw new Error(`graph "${name}": start node "${start}" is not defined`);
  for (const n of Object.keys(edges)) {
    if (!nodes[n]) throw new Error(`graph "${name}": edge from unknown node "${n}"`);
  }
  return { name, start, nodes, edges };
}

export function loadCheckpoint(key) {
  const p = checkpointPath(key);
  if (!existsSync(p)) return null;
  try {
    const cp = JSON.parse(readFileSync(p, "utf8"));
    return cp && cp.node && cp.state ? cp : null;
  } catch {
    return null; // a corrupt checkpoint must never wedge the loop — start fresh
  }
}

export function saveCheckpoint(key, cp) {
  mkdirSync(GRAPH_DIR, { recursive: true });
  writeFileSync(checkpointPath(key), JSON.stringify(cp, null, 2) + "\n");
  return cp;
}

export function clearCheckpoint(key) {
  rmSync(checkpointPath(key), { force: true });
}

/**
 * Patch a checkpoint's STATE in place (the LangGraph-Studio "edit the state and
 * re-run" move — used by the dashboard's state editor). Returns the updated
 * checkpoint or null when the key has none.
 */
export function patchCheckpointState(key, patch) {
  const cp = loadCheckpoint(key);
  if (!cp) return null;
  return saveCheckpoint(key, {
    ...cp,
    state: { ...cp.state, ...patch },
    at: new Date().toISOString(),
  });
}

// --- breakpoints -----------------------------------------------------------------
//
// .harness/graph/breakpoints.json:  { "<key>": ["review"], "*": ["ship"] }
// A breakpointed node HALTS the graph BEFORE the node runs, keeping the
// checkpoint. Inspect/edit the state (dashboard or `graph.mjs show`), then the
// next run with the same key executes that node once and re-arms the breakpoint.

const BP_PATH = () => resolve(GRAPH_DIR, "breakpoints.json");

export function breakpoints() {
  try { return JSON.parse(readFileSync(BP_PATH(), "utf8")) || {}; } catch { return {}; }
}
function writeBreakpoints(bps) {
  mkdirSync(GRAPH_DIR, { recursive: true });
  writeFileSync(BP_PATH(), JSON.stringify(bps, null, 2) + "\n");
  return bps;
}
export function setBreakpoint(key, node) {
  const bps = breakpoints();
  const list = new Set(bps[key] || []);
  list.add(node);
  bps[key] = [...list];
  return writeBreakpoints(bps);
}
export function clearBreakpoint(key, node = null) {
  const bps = breakpoints();
  if (node === null) delete bps[key];
  else {
    bps[key] = (bps[key] || []).filter((n) => n !== node);
    if (!bps[key].length) delete bps[key];
  }
  return writeBreakpoints(bps);
}
export function hasBreakpoint(key, node) {
  const bps = breakpoints();
  return (bps[key] || []).includes(node) || (bps["*"] || []).includes(node);
}

export function listCheckpoints() {
  if (!existsSync(GRAPH_DIR)) return [];
  return readdirSync(GRAPH_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const cp = loadCheckpoint(basename(f, ".json"));
      return cp ? { key: cp.key, graph: cp.graph, node: cp.node, step: cp.step, at: cp.at } : null;
    })
    .filter(Boolean);
}

/**
 * Time-travel: rewind a checkpoint to an earlier step. The next run with this
 * key resumes at that step's node, with that step's state snapshot.
 * @returns {object|null} the rewound checkpoint, or null if key/step not found
 */
export function rewind(key, step) {
  const cp = loadCheckpoint(key);
  if (!cp) return null;
  const entry = (cp.history || []).find((h) => h.step === step);
  if (!entry) return null;
  return saveCheckpoint(key, {
    ...cp,
    node: entry.node,
    step: entry.step,
    state: entry.state,
    at: new Date().toISOString(),
    history: (cp.history || []).filter((h) => h.step <= step),
  });
}

/**
 * Walk the graph from `start` (or from a resumable checkpoint when `key` is
 * given), checkpointing after every node. Returns the final state.
 *
 * @param {object} graph a defineGraph() result
 * @param {object} initialState JSON-serializable seed state
 * @param {object} [opts]
 * @param {string} [opts.key] checkpoint key (no key = no persistence)
 * @param {object} [opts.ctx] non-serializable handles passed to nodes/edges
 * @param {number} [opts.maxSteps] hard cap on node executions (default 60)
 * @param {boolean} [opts.resume] resume from an existing checkpoint (default true)
 * @param {(info:{step:number,node:string,next:string})=>any} [opts.onStep]
 */
export async function runGraph(graph, initialState, opts = {}) {
  const { key = null, ctx = {}, maxSteps = 60, resume = true, onStep } = opts;

  let node = graph.start;
  let state = { ...initialState };
  let step = 0;
  let history = [];
  let skipBpAt = null; // resume from a breakpoint runs THAT node once before re-arming

  if (key && resume) {
    const cp = loadCheckpoint(key);
    if (cp && cp.graph === graph.name && graph.nodes[cp.node]) {
      node = cp.node;
      state = { ...initialState, ...cp.state };
      step = cp.step;
      history = cp.history || [];
      state.__resumed = { node, step };
      if (cp.bp === cp.node) skipBpAt = cp.node;
    }
  }

  while (node !== END) {
    if (step >= maxSteps) {
      // The infinite-loop guard: a cyclic graph is legal, an unbounded one is not.
      state.__maxStepsExceeded = true;
      if (!state.outcome) state.outcome = "failed";
      if (key) clearCheckpoint(key);
      return state;
    }

    // Breakpoint: halt BEFORE the node runs, keep the checkpoint pointed at it.
    // Inspect/edit the state, then the next run executes this node once.
    if (key && hasBreakpoint(key, node) && skipBpAt !== node) {
      saveCheckpoint(key, { key, graph: graph.name, node, step, at: new Date().toISOString(), state: trimForSnapshot(state), history, bp: node });
      state.__breakpoint = { node, step };
      return state;
    }
    skipBpAt = null;

    step += 1;

    const fn = graph.nodes[node];
    // Every node execution is a span (kind "node") under the card's trace, so the
    // dashboard/OTel backend renders the run as a nested timeline.
    const stepNo = step;
    const nodeName = node;
    const patch = await withSpan(`node:${node}`, { traceId: key || graph.name, kind: "node", graph: graph.name, step: stepNo, node: nodeName }, () => fn(state, ctx));
    if (patch && typeof patch === "object") state = { ...state, ...patch };

    const edge = graph.edges[node];
    const next = edge ? edge(state, ctx) : END;

    history.push({ step, node, next, at: new Date().toISOString(), state: trimForSnapshot(state) });

    if (next === HALT) {
      // Keep the checkpoint pointed at the CURRENT node so a later run re-enters
      // it (state already reflects this step's work — e.g. build's iter counter).
      if (key) {
        saveCheckpoint(key, { key, graph: graph.name, node, step, at: new Date().toISOString(), state: trimForSnapshot(state), history });
      }
      state.__halted = { node, step };
      return state;
    }

    if (next === END) {
      if (key) clearCheckpoint(key);
      if (onStep) await onStep({ step, node, next });
      return state;
    }

    if (!graph.nodes[next]) throw new Error(`graph "${graph.name}": node "${node}" routed to unknown node "${next}"`);

    if (key) {
      saveCheckpoint(key, { key, graph: graph.name, node: next, step, at: new Date().toISOString(), state: trimForSnapshot(state), history });
    }
    if (onStep) await onStep({ step, node, next });
    node = next;
  }
  if (key) clearCheckpoint(key);
  return state;
}

// --- CLI -----------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, key, arg] = process.argv.slice(2);
  if (cmd === "list") {
    const rows = listCheckpoints();
    if (!rows.length) console.log("(no graph checkpoints)");
    for (const r of rows) console.log(`${r.key}  graph=${r.graph}  node=${r.node}  step=${r.step}  at=${r.at}`);
  } else if (cmd === "history" && key) {
    const cp = loadCheckpoint(key);
    if (!cp) { console.error(`no checkpoint for "${key}"`); process.exit(3); }
    for (const h of cp.history || []) console.log(`#${h.step}  ${h.node} -> ${h.next}  ${h.at}`);
    console.log(`(next node: ${cp.node})`);
  } else if (cmd === "show" && key) {
    const cp = loadCheckpoint(key);
    if (!cp) { console.error(`no checkpoint for "${key}"`); process.exit(3); }
    console.log(JSON.stringify({ ...cp, history: `(${(cp.history || []).length} steps — use 'history')` }, null, 2));
  } else if (cmd === "rewind" && key && arg) {
    const cp = rewind(key, Number(arg));
    if (!cp) { console.error(`cannot rewind "${key}" to step ${arg} (missing key or step)`); process.exit(3); }
    console.log(`rewound ${key} to step ${cp.step} (next node: ${cp.node})`);
  } else if (cmd === "clear" && key) {
    clearCheckpoint(key);
    console.log(`cleared ${key}`);
  } else if (cmd === "bp" && key && arg) {
    setBreakpoint(key, arg);
    console.log(`breakpoint set: ${key} @ ${arg} (use key "*" for every card)`);
  } else if (cmd === "bp-clear" && key) {
    clearBreakpoint(key, arg || null);
    console.log(`breakpoint(s) cleared: ${key}${arg ? ` @ ${arg}` : ""}`);
  } else if (cmd === "bp-list") {
    const bps = breakpoints();
    if (!Object.keys(bps).length) console.log("(no breakpoints)");
    for (const [k, nodes] of Object.entries(bps)) console.log(`${k}: ${nodes.join(", ")}`);
  } else {
    console.error("usage: graph.mjs <list | history <key> | show <key> | rewind <key> <step> | clear <key> | bp <key> <node> | bp-clear <key> [node] | bp-list>");
    process.exit(2);
  }
}
