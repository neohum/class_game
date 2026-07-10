#!/usr/bin/env node
// design-feedback.mjs — the labeled dataset of the design tournament.
//
// Mirror of persona-feedback.mjs but for design taste: each row is one variant in
// one round, with its scores, whether it won, and (when present) the human's
// Telegram tap. The taps are the active-learning signal — the loop only asks for a
// tap when the top variants are within a hair of each other (taste-judge "ambiguous"),
// so every tap is maximally informative.
//
// Row shape (append-only JSONL at .harness/design-feedback.jsonl):
//   { round, ts, id, strategy, composite, breakdown, predictedWinner, won, humanTap, screenshot, note }
//     predictedWinner : taste-judge/score's pick BEFORE any human input ("approve"-analog)
//     won             : final winner of the round
//     humanTap        : "win" | "lose" | null   (your correction, the ground truth)
//
// Usage:
//   node design-feedback.mjs --append '{"round":1,"id":"v2",...}'
//   node design-feedback.mjs --dump
//   import { loadDataset, appendRow } from "./design-feedback.mjs"

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(process.cwd());
const DATA_PATH = resolve(ROOT, ".harness", "design-feedback.jsonl");

export function loadDataset(path = DATA_PATH) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export function appendRow(row, path = DATA_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n");
  return row;
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ai = process.argv.indexOf("--append");
  if (ai !== -1 && process.argv[ai + 1]) {
    const row = JSON.parse(process.argv[ai + 1]);
    if (row.ts == null) row.ts = null; // caller stamps time; scripts avoid Date for determinism
    appendRow(row);
    console.log(JSON.stringify({ appended: true, total: loadDataset().length }));
  } else if (process.argv.includes("--dump")) {
    console.log(JSON.stringify(loadDataset(), null, 2));
  } else {
    console.error('Usage: node design-feedback.mjs --append \'{...}\' | --dump');
    process.exit(2);
  }
}
