// graph.ts — a minimal declarative state-graph runtime for the autonomous loop.
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
//                  human can `graph.ts rewind <card> <step>` to re-run from any
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
//   node scripts/loop/graph.ts list                 # all checkpoints
//   node scripts/loop/graph.ts history <key>        # step-by-step trail
//   node scripts/loop/graph.ts show <key>           # current node + state
//   node scripts/loop/graph.ts rewind <key> <step>  # time-travel to a step
//   node scripts/loop/graph.ts clear <key>          # drop the checkpoint

import { resolve, basename } from "node:path";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, realpathSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { withSpan } from "./trace.ts";

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
// never trimmed — only what lands on disk. We keep the TAIL of each field
// (.slice(-CAP)) because failures surface at the end of a log. Raise the cap with
// HARNESS_SNAPSHOT_CAP when a resumed card needs more of its failure context
// preserved; 0 disables trimming entirely (unbounded checkpoints — use with care).
const SNAPSHOT_STRING_CAP = (() => {
  const raw = Number(process.env.HARNESS_SNAPSHOT_CAP);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 16_000;
})();

/** Graph state: an open bag the nodes merge patches into. */
export type GraphState = Record<string, any>;

/**
 * Fields the RUNTIME writes onto the caller's state — its half of the contract.
 * A caller that reads them (ralph-loop checks __breakpoint and
 * __maxStepsExceeded) should declare them; the runtime writes them through a
 * cast because the state's concrete type belongs to the caller.
 */
export interface GraphControl {
  __resumed?: { node: string; step: number };
  __halted?: { node: string; step: number };
  __breakpoint?: { node: string; step: number };
  __maxStepsExceeded?: boolean;
  outcome?: string;
}

/**
 * A node returns a patch merged into the state; edges pick the next node.
 *
 * Generic in the state so a caller can declare what its pipeline actually
 * carries. Pinning this to the open GraphState would make every typed node
 * unassignable — the runtime is state-agnostic, only the caller is not.
 */
export type GraphNode<S = GraphState> = (state: S, ctx: any) => Promise<Partial<S> | void> | Partial<S> | void;
export type GraphEdge<S = GraphState> = (state: S, ctx: any) => string;

export interface GraphDef<S = GraphState> {
  name: string;
  start: string;
  nodes: Record<string, GraphNode<S>>;
  edges: Record<string, GraphEdge<S>>;
}

/** A resumable point in a run: which node is next, and the state to hand it. */
export interface Checkpoint {
  graph?: string;
  node: string;
  step: number;
  state: GraphState;
  at?: string;
  bp?: string | null;
  history?: Array<{ step: number; node: string; next?: string; state: GraphState; at?: string }>;
  [key: string]: unknown;
}

/** key -> node names to halt before; "*" applies to every key. */
export type Breakpoints = Record<string, string[]>;

function checkpointPath(key: string): string {
  return resolve(GRAPH_DIR, `${key}.json`);
}

function trimForSnapshot(state: GraphState): GraphState {
  const out: GraphState = {};
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
export function defineGraph<S = GraphState>({ name = "graph", start, nodes = {}, edges = {} }: Partial<GraphDef<S>>): GraphDef<S> {
  if (!start || !nodes[start]) throw new Error(`graph "${name}": start node "${start}" is not defined`);
  for (const n of Object.keys(edges)) {
    if (!nodes[n]) throw new Error(`graph "${name}": edge from unknown node "${n}"`);
  }
  return { name, start: start!, nodes, edges };
}

export function loadCheckpoint(key: string): Checkpoint | null {
  const p = checkpointPath(key);
  if (!existsSync(p)) return null;
  try {
    const cp = JSON.parse(readFileSync(p, "utf8"));
    return cp && cp.node && cp.state ? cp : null;
  } catch {
    return null; // a corrupt checkpoint must never wedge the loop — start fresh
  }
}

export function saveCheckpoint(key: string, cp: Checkpoint): Checkpoint {
  mkdirSync(GRAPH_DIR, { recursive: true });
  writeFileSync(checkpointPath(key), JSON.stringify(cp, null, 2) + "\n");
  return cp;
}

export function clearCheckpoint(key: string): void {
  rmSync(checkpointPath(key), { force: true });
}

/**
 * Patch a checkpoint's STATE in place (the LangGraph-Studio "edit the state and
 * re-run" move — used by the dashboard's state editor). Returns the updated
 * checkpoint or null when the key has none.
 */
export function patchCheckpointState(key: string, patch: GraphState): Checkpoint | null {
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
// checkpoint. Inspect/edit the state (dashboard or `graph.ts show`), then the
// next run with the same key executes that node once and re-arms the breakpoint.

const BP_PATH = () => resolve(GRAPH_DIR, "breakpoints.json");

export function breakpoints(): Breakpoints {
  try { return JSON.parse(readFileSync(BP_PATH(), "utf8")) || {}; } catch { return {}; }
}
function writeBreakpoints(bps: Breakpoints): Breakpoints {
  mkdirSync(GRAPH_DIR, { recursive: true });
  writeFileSync(BP_PATH(), JSON.stringify(bps, null, 2) + "\n");
  return bps;
}
export function setBreakpoint(key: string, node: string): Breakpoints {
  const bps = breakpoints();
  const list = new Set<string>(bps[key] || []);
  list.add(node);
  bps[key] = [...list];
  return writeBreakpoints(bps);
}
export function clearBreakpoint(key: string, node: string | null = null): Breakpoints {
  const bps = breakpoints();
  if (node === null) delete bps[key];
  else {
    bps[key] = (bps[key] || []).filter((n) => n !== node);
    if (!bps[key]!.length) delete bps[key];
  }
  return writeBreakpoints(bps);
}
export function hasBreakpoint(key: string, node: string): boolean {
  const bps = breakpoints();
  return (bps[key] || []).includes(node) || (bps["*"] || []).includes(node);
}

/** A checkpoint's headline, for listings. */
export interface CheckpointSummary {
  key: unknown;
  graph?: string;
  node: string;
  step: number;
  at?: string;
}

export function listCheckpoints(): CheckpointSummary[] {
  if (!existsSync(GRAPH_DIR)) return [];
  return readdirSync(GRAPH_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f): CheckpointSummary | null => {
      const cp = loadCheckpoint(basename(f, ".json"));
      return cp ? { key: cp.key, graph: cp.graph, node: cp.node, step: cp.step, at: cp.at } : null;
    })
    .filter((r): r is CheckpointSummary => r !== null);
}

/**
 * Time-travel: rewind a checkpoint to an earlier step. The next run with this
 * key resumes at that step's node, with that step's state snapshot.
 * @returns {object|null} the rewound checkpoint, or null if key/step not found
 */
export function rewind(key: string, step: number): Checkpoint | null {
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
export async function runGraph<S extends GraphState = GraphState>(
  graph: GraphDef<S>,
  initialState: S,
  opts: {
    key?: string | null;
    ctx?: any;
    maxSteps?: number;
    resume?: boolean;
    onStep?: (info: { step: number; node: string; next: string }) => unknown;
  } = {},
): Promise<S> {
  const { key = null, ctx = {}, maxSteps = 60, resume = true, onStep } = opts;

  let node = graph.start;
  let state: S = { ...initialState };
  let step = 0;
  let history: NonNullable<Checkpoint["history"]> = [];
  let skipBpAt = null; // resume from a breakpoint runs THAT node once before re-arming

  if (key && resume) {
    const cp = loadCheckpoint(key);
    if (cp && cp.graph === graph.name && graph.nodes[cp.node]) {
      node = cp.node;
      state = { ...initialState, ...cp.state };
      step = cp.step;
      history = cp.history || [];
      (state as GraphControl).__resumed = { node, step };
      if (cp.bp === cp.node) skipBpAt = cp.node;
    }
  }

  while (node !== END) {
    if (step >= maxSteps) {
      // The infinite-loop guard: a cyclic graph is legal, an unbounded one is not.
      (state as GraphControl).__maxStepsExceeded = true;
      if (!(state as GraphControl).outcome) (state as GraphControl).outcome = "failed";
      if (key) clearCheckpoint(key);
      return state;
    }

    // Breakpoint: halt BEFORE the node runs, keep the checkpoint pointed at it.
    // Inspect/edit the state, then the next run executes this node once.
    if (key && hasBreakpoint(key, node) && skipBpAt !== node) {
      saveCheckpoint(key, { key, graph: graph.name, node, step, at: new Date().toISOString(), state: trimForSnapshot(state), history, bp: node });
      (state as GraphControl).__breakpoint = { node, step };
      return state;
    }
    skipBpAt = null;

    step += 1;

    const fn = graph.nodes[node];
    if (!fn) throw new Error(`graph "${graph.name}": node "${node}" is not defined`);
    // Every node execution is a span (kind "node") under the card's trace, so the
    // dashboard/OTel backend renders the run as a nested timeline.
    const stepNo = step;
    const nodeName = node;
    const patch = await withSpan(`node:${node}`, { traceId: key || graph.name, kind: "node", graph: graph.name, step: stepNo, node: nodeName }, async () => fn(state, ctx));
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
      (state as GraphControl).__halted = { node, step };
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
    console.error("usage: graph.ts <list | history <key> | show <key> | rewind <key> <step> | clear <key> | bp <key> <node> | bp-clear <key> [node] | bp-list>");
    process.exit(2);
  }
}
