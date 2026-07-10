// persona-calibrate.mjs — makes the persona's confidence MEAN something, and
// derives the deploy threshold from cost instead of a magic number.
//
// The LLM judge in persona-approve.mjs emits a raw "confidence" q. That number is
// not P(you approve | x) — language models are systematically over/under-confident.
// Platt scaling fits a 1-D logistic map on YOUR labeled taps:
//
//        p_hat = sigmoid( a * logit(q) + b )
//
// so p_hat is a calibrated probability you can reason about. We measure the fit
// with Expected Calibration Error (ECE). The deploy threshold then comes from
// decision theory, not taste:
//
//        approve iff p_hat >= tau*,   tau* = 1 - C_ask / C_bad
//
// where C_ask is the cost of a phone tap and C_bad the cost of a wrong autonomous
// deploy (rollback + lost trust). Big C_bad -> tau* near 1 -> conservative.
//
// Everything here is pure-Node (no deps): a few hundred steps of gradient descent.

import { resolve } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { labeledRows, PERSONA_HOME } from "./persona-feedback.mjs";

// Calibration is fit on the OWNER's accumulated labels, so it lives in the same
// shared store as the dataset (see PERSONA_HOME in persona-feedback.mjs) — every
// project deploys against one calibration learned from all of them, not a
// per-repo refit that starts at the identity map.
const PARAMS_PATH = resolve(PERSONA_HOME, "persona-calibration.json");
const EPS = 1e-6;

export const sigmoid = (z) => 1 / (1 + Math.exp(-z));
export const logit = (p) => {
  const c = Math.min(1 - EPS, Math.max(EPS, p));
  return Math.log(c / (1 - c));
};

/**
 * Fit Platt scaling {a, b} on labeled rows via logistic regression on z=logit(q).
 * Identity map {a:1, b:0} is returned when there is too little data to trust a fit.
 * @param {Array<{predicted:{confidence:number}, label:string}>} rows
 * @param {{steps?:number, lr?:number, minN?:number}} [opt]
 * @returns {{a:number, b:number, n:number, fitted:boolean}}
 */
export function fit(rows, { steps = 500, lr = 0.1, minN = 8 } = {}) {
  const data = rows
    .filter((r) => r.predicted && Number.isFinite(r.predicted.confidence) && (r.label === "approve" || r.label === "reject"))
    .map((r) => ({ z: logit(r.predicted.confidence), y: r.label === "approve" ? 1 : 0 }));

  if (data.length < minN) return { a: 1, b: 0, n: data.length, fitted: false };

  let a = 1, b = 0;
  for (let s = 0; s < steps; s++) {
    let ga = 0, gb = 0;
    for (const { z, y } of data) {
      const p = sigmoid(a * z + b);
      const err = p - y;
      ga += err * z;
      gb += err;
    }
    a -= lr * ga / data.length;
    b -= lr * gb / data.length;
  }
  return { a, b, n: data.length, fitted: true };
}

/**
 * Map a raw model confidence to a calibrated probability.
 * @param {number} rawConf
 * @param {{a:number, b:number}} params
 */
export function calibrate(rawConf, params = { a: 1, b: 0 }) {
  if (!Number.isFinite(rawConf)) return 0;
  return sigmoid(params.a * logit(rawConf) + params.b);
}

/**
 * Bayes-optimal auto-approve threshold from costs. tau* = 1 - C_ask / C_bad.
 * @param {{C_ask?:number, C_bad?:number}} [costs]
 */
export function optimalThreshold({ C_ask = 1, C_bad = 20 } = {}) {
  const tau = 1 - C_ask / C_bad;
  return Math.min(1, Math.max(0, tau));
}

/**
 * Expected Calibration Error over `bins` equal-width probability bins.
 * @param {Array<{predicted:{confidence:number}, label:string}>} rows
 * @param {{a:number,b:number}} params
 * @param {number} [bins]
 */
export function ece(rows, params = { a: 1, b: 0 }, bins = 10) {
  const pts = rows
    .filter((r) => r.predicted && Number.isFinite(r.predicted.confidence) && (r.label === "approve" || r.label === "reject"))
    .map((r) => ({ p: calibrate(r.predicted.confidence, params), y: r.label === "approve" ? 1 : 0 }));
  if (!pts.length) return 0;
  let total = 0;
  for (let i = 0; i < bins; i++) {
    const lo = i / bins, hi = (i + 1) / bins;
    const bin = pts.filter((d) => d.p > lo && d.p <= hi || (i === 0 && d.p <= hi));
    if (!bin.length) continue;
    const acc = bin.reduce((s, d) => s + d.y, 0) / bin.length;
    const conf = bin.reduce((s, d) => s + d.p, 0) / bin.length;
    total += (bin.length / pts.length) * Math.abs(acc - conf);
  }
  return total;
}

export function loadParams() {
  if (!existsSync(PARAMS_PATH)) return { a: 1, b: 0, fitted: false };
  try { return JSON.parse(readFileSync(PARAMS_PATH, "utf8")); } catch { return { a: 1, b: 0, fitted: false }; }
}

export function saveParams(params) {
  mkdirSync(PERSONA_HOME, { recursive: true });
  writeFileSync(PARAMS_PATH, JSON.stringify(params, null, 2) + "\n");
}

// CLI: `node scripts/loop/persona-calibrate.mjs fit`  — refit from the dataset
//      `node scripts/loop/persona-calibrate.mjs tau [C_ask] [C_bad]`
if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "tau") {
    const [ask, bad] = rest.map(Number);
    console.log(optimalThreshold({ C_ask: ask || 1, C_bad: bad || 20 }).toFixed(4));
  } else {
    const rows = labeledRows({ requirePrediction: true });
    const before = ece(rows, { a: 1, b: 0 });
    const params = fit(rows);
    const after = ece(rows, params);
    saveParams(params);
    console.log(`fit on n=${params.n} rows (fitted=${params.fitted})`);
    console.log(`  a=${params.a.toFixed(4)} b=${params.b.toFixed(4)}`);
    console.log(`  ECE: ${before.toFixed(4)} -> ${after.toFixed(4)}`);
    console.log(`  tau* (C_ask=1,C_bad=20) = ${optimalThreshold().toFixed(4)}`);
  }
}
