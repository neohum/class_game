#!/usr/bin/env node
// design-score.mjs — the fitness function of the design tournament.
//
// Combines the OBJECTIVE floor (design-critic: contrast, math integrity) with the
// SUBJECTIVE taste (taste-judge) into one comparable 0..100 score per variant.
// The objective part is fully deterministic; the taste part is the judge's input.
// Accessibility is a HARD floor — any WCAG-AA failure applies a penalty so a pretty
// but unreadable variant cannot win on looks alone.
//
// Usage:
//   node design-score.mjs --metrics variant.json
//   node design-score.mjs --rank round_metrics.json    (array -> sorted leaderboard)
//
// variant.json shape (all fields 0..1 except taste 0..100; missing => 0):
//   {
//     "id": "v1", "strategy": "golden+minimal",
//     "contrast": { "pass": 11, "total": 12 },   // WCAG-AA passing pairs
//     "mathIntegrity": 0.95,                       // scale/grid conformance 0..1
//     "languageFit": 0.9,                          // design-language faithfulness 0..1
//     "taste": 82,                                 // taste-judge composite 0..100
//     "weights": { "accessibility":0.25, "mathIntegrity":0.20, "languageFit":0.20, "taste":0.35 }
//   }

import { readFileSync } from "node:fs";

const DEFAULT_WEIGHTS = { accessibility: 0.25, mathIntegrity: 0.20, languageFit: 0.20, taste: 0.35 };

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

export function score(v) {
  const w = { ...DEFAULT_WEIGHTS, ...(v.weights || {}) };
  const wsum = w.accessibility + w.mathIntegrity + w.languageFit + w.taste || 1;

  const passRate = v.contrast && v.contrast.total ? v.contrast.pass / v.contrast.total : 0;
  const access = clamp01(passRate);
  const math = clamp01(v.mathIntegrity);
  const lang = clamp01(v.languageFit);
  const taste = clamp01((Number(v.taste) || 0) / 100);

  // weighted composite on 0..1, normalized by weight sum
  let composite = (w.accessibility * access + w.mathIntegrity * math + w.languageFit * lang + w.taste * taste) / wsum;

  // HARD floor: any AA failure is disqualifying-ish. Penalty scales with how many fail.
  const aaFails = v.contrast && v.contrast.total ? v.contrast.total - v.contrast.pass : 0;
  const penalty = aaFails > 0 ? Math.min(0.5, 0.15 + 0.05 * aaFails) : 0;
  composite = composite * (1 - penalty);

  return {
    id: v.id || "?",
    strategy: v.strategy || "",
    composite: Math.round(composite * 1000) / 10, // 0..100, 1 decimal
    breakdown: {
      accessibility: Math.round(access * 100),
      mathIntegrity: Math.round(math * 100),
      languageFit: Math.round(lang * 100),
      taste: Math.round(taste * 100),
    },
    aaFails,
    penaltyApplied: Math.round(penalty * 100),
    disqualified: aaFails > 0,
  };
}

const metricsPath = arg("--metrics");
const rankPath = arg("--rank");

if (rankPath) {
  const arr = JSON.parse(readFileSync(rankPath, "utf8"));
  const scored = arr.map(score).sort((a, b) => b.composite - a.composite);
  scored.forEach((s, i) => { s.rank = i + 1; });
  const winner = scored.find((s) => !s.disqualified) || scored[0];
  console.log(JSON.stringify({ winner: winner.id, leaderboard: scored }, null, 2));
} else if (metricsPath) {
  console.log(JSON.stringify(score(JSON.parse(readFileSync(metricsPath, "utf8"))), null, 2));
} else {
  console.error("Usage: node design-score.mjs --metrics variant.json | --rank round_metrics.json");
  process.exit(2);
}
