// persona-feedback.mjs — the labeled dataset that turns the static persona into a
// learned one. This is the missing return edge that closes the loop:
//
//   persona-approve.mjs  --(prediction)-->  ┐
//   telegram-listener.mjs --(your tap)----->  this dataset  --> calibrate / synthesize
//   persona-bootstrap.mjs --(git history)-->  ┘
//
// Each row is one decision: the features of a reviewed change, what the persona
// PREDICTED, and the ground-truth LABEL (your tap, or a historical accept/revert).
// Because the loop only asks you when it is uncertain (p≈0.5), every tap you make
// is, by construction, a maximally-informative active-learning sample — we just
// have to keep it. Calibration (persona-calibrate.mjs) and persona synthesis
// (persona-synthesize.mjs) both read this file; nothing here makes a decision.
//
// Store: append-only JSONL under .harness/ (no schema migration, trivially
// readable from every other script and from your phone).

import { resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, copyFileSync } from "node:fs";

const ROOT = resolve(process.cwd());

// The persona is the OWNER's, not the project's. One human uses this harness
// across many repos, and every accept/reject they make is a sample of the SAME
// underlying preference — so the dataset ACCUMULATES in one shared store rather
// than cold-starting per project. Override the location with PERSONA_HOME; the
// default is the user's Claude config dir, so every project on this machine
// learns from the same history. (Cross-MACHINE sync is out of scope: point
// PERSONA_HOME at a synced directory, or sync ~/.claude, to share across hosts.)
export const PERSONA_HOME = process.env.PERSONA_HOME
  ? resolve(process.env.PERSONA_HOME)
  : resolve(homedir(), ".claude", "persona");
const STATE_DIR = PERSONA_HOME;
export const DATASET_PATH = resolve(STATE_DIR, "persona-feedback.jsonl");

// One-time, best-effort migration: a project created before centralizing keeps
// its labels in a per-project .harness/persona-feedback.jsonl. The first time the
// central store is touched we fold those rows in so no taps are lost. Guarded by
// the central file's absence, so it runs at most once and never on a fresh
// machine. Lazy (never at import) so merely importing this module has no fs side
// effect — keeps tests and pure-function callers from creating the central dir.
const LEGACY_PATH = resolve(ROOT, ".harness", "persona-feedback.jsonl");
let migrated = false;
function migrateLegacy() {
  if (migrated) return;
  migrated = true;
  try {
    if (!existsSync(DATASET_PATH) && existsSync(LEGACY_PATH) &&
        resolve(LEGACY_PATH) !== resolve(DATASET_PATH)) {
      mkdirSync(STATE_DIR, { recursive: true });
      copyFileSync(LEGACY_PATH, DATASET_PATH);
    }
  } catch { /* migration is best-effort; never block a read/write on it */ }
}

function ensureDir() {
  migrateLegacy();
  mkdirSync(STATE_DIR, { recursive: true });
}

/**
 * Load every dataset row, newest last. Tolerates partial/corrupt trailing lines.
 * @returns {Array<object>}
 */
export function loadDataset() {
  migrateLegacy();
  if (!existsSync(DATASET_PATH)) return [];
  const rows = [];
  for (const line of readFileSync(DATASET_PATH, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { /* skip a torn line */ }
  }
  return rows;
}

function rewrite(rows) {
  ensureDir();
  writeFileSync(DATASET_PATH, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

/**
 * Append one row. `now` is injectable so tests are deterministic.
 * @param {object} row
 * @param {string} [now] ISO timestamp
 */
export function appendRow(row, now) {
  ensureDir();
  const full = { ts: now ?? new Date().toISOString(), label: null, ...row };
  appendFileSync(DATASET_PATH, JSON.stringify(full) + "\n");
  return full;
}

/**
 * Record what the persona predicted for a card (label filled in later by a tap).
 * @param {{card:string, spec:string, features?:object, predicted:object, now?:string}} o
 */
export function recordPrediction({ card, spec, features = {}, predicted, now }) {
  return appendRow({ card, spec, features, predicted, label: null, source: "loop" }, now);
}

/**
 * Attach a ground-truth label to a card. If a pending (label===null) loop row for
 * that card exists, fill it in place — that keeps the prediction paired with the
 * outcome (the pair calibration needs). Otherwise append a label-only row.
 * @param {{card:string, label:"approve"|"reject", source?:string, now?:string}} o
 */
export function recordLabel({ card, label, source = "tap", now }) {
  const rows = loadDataset();
  // newest pending loop row for this card
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].card === card && rows[i].source === "loop" && rows[i].label == null) {
      rows[i].label = label;
      rows[i].labeled_at = now ?? new Date().toISOString();
      rows[i].label_source = source;
      rewrite(rows);
      return rows[i];
    }
  }
  return appendRow({ card, spec: "", features: {}, predicted: null, label, source }, now);
}

/**
 * Rows usable for supervised learning: a real label AND a numeric predicted
 * confidence (so calibration has both x and y). History rows have a label but no
 * prediction — included only when `requirePrediction` is false.
 * @param {{requirePrediction?:boolean}} [opts]
 */
export function labeledRows({ requirePrediction = false } = {}) {
  return loadDataset().filter(
    (r) => (r.label === "approve" || r.label === "reject") &&
      (!requirePrediction || (r.predicted && Number.isFinite(r.predicted.confidence))),
  );
}

// CLI: `node scripts/loop/persona-feedback.mjs label <card> approve|reject`
//      `node scripts/loop/persona-feedback.mjs stats`
if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "label") {
    const [card, label] = rest;
    if (!card || !["approve", "reject"].includes(label)) {
      console.error("usage: persona-feedback.mjs label <card> approve|reject");
      process.exit(2);
    }
    recordLabel({ card, label, source: "cli" });
    console.log(`labeled ${card} = ${label}`);
  } else {
    const rows = loadDataset();
    const labeled = rows.filter((r) => r.label);
    const pos = labeled.filter((r) => r.label === "approve").length;
    console.log(`rows=${rows.length} labeled=${labeled.length} approve=${pos} reject=${labeled.length - pos}`);
  }
}
