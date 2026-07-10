#!/usr/bin/env node
// design-persona-synthesize.mjs — "textual gradient descent" on designer-persona.md.
//
// Same mechanism as persona-synthesize.mjs (the deploy-gate persona), retargeted to
// design taste. designer-persona.md is the parameter theta; the loss is the gap
// between what the persona/judge PREFERRED and what actually won (or what your tap
// corrected). Each pass distills those lessons into the managed LEARNED block so the
// next generation of variants is biased toward what wins — that is the "growth."
//
// Two phases (agent-agnostic, fully testable without spawning an LLM):
//   1) analyze : node design-persona-synthesize.mjs            -> prints {lessons, prompt}
//   2) apply   : node design-persona-synthesize.mjs --apply-file rules.md
//                  (writes the rules into the LEARNED block of designer-persona.md)
//
// The calling agent (taste-judge/director) reads the phase-1 prompt, writes the
// principles, then runs phase-2 to persist them. Keeps the loop runnable by any agent.

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadDataset } from "./design-feedback.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(HERE, "..", "references", "designer-persona.template.md");

const BEGIN = "<!-- BEGIN LEARNED DESIGN PRINCIPLES (design-persona-synthesize.mjs — auto-generated; edits inside this block are overwritten) -->";
const END = "<!-- END LEARNED DESIGN PRINCIPLES -->";

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// Resolve the persona path: PERSONA_HOME first (central accumulation), then local.
function personaPath() {
  const home = process.env.PERSONA_HOME;
  if (home) return resolve(home, "designer-persona.md");
  const local = resolve(process.cwd(), ".claude", "designer-persona.md");
  return local;
}

// Self-starting: if the persona doesn't exist yet, seed it from the bundled
// template so the very first round has a θ to descend on (and a Prior to preserve).
// Returns true if it created the file.
export function bootstrapPersonaIfMissing(path = personaPath()) {
  if (existsSync(path)) return false;
  if (!existsSync(TEMPLATE)) return false;
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(TEMPLATE, path);
  return true;
}

/**
 * Extract the lessons worth learning from the tournament dataset:
 *  - missedWinner : taste-judge predicted a different variant than what won/was tapped
 *                   (the costly mistake — taste was wrong)
 *  - confirmedWin : predicted == won, no human correction (reinforces a principle)
 * Only rows with a recorded prediction AND an outcome count.
 */
export function findLessons(rows) {
  const missedWinner = [], confirmedWin = [];
  for (const r of rows) {
    const outcome = r.humanTap === "win" ? "win" : r.humanTap === "lose" ? "lose" : (r.won ? "win" : "lose");
    if (r.predictedWinner == null) continue;
    const predictedThis = r.predictedWinner === r.id || r.predictedWinner === true;
    if (outcome === "win" && !predictedThis) missedWinner.push(r);
    else if (outcome === "win" && predictedThis) confirmedWin.push(r);
  }
  return { missedWinner, confirmedWin, total: rows.length };
}

export function upsertLearnedBlock(content, rules) {
  const block = `${BEGIN}\n## Learned Design Principles (토너먼트에서 증류됨)\n${rules.trim()}\n${END}`;
  const b = content.indexOf(BEGIN);
  const e = content.indexOf(END);
  if (b !== -1 && e !== -1 && e > b) {
    return content.slice(0, b) + block + content.slice(e + END.length);
  }
  return content.replace(/\s*$/, "") + "\n\n" + block + "\n";
}

export function buildPrompt(persona, les) {
  const fmt = (r) => `- round ${r.round} | strategy: ${r.strategy || "?"} | taste-judge note: ${r.note || "(none)"} | composite ${r.composite ?? "?"}`;
  return [
    "You curate the LEARNED DESIGN PRINCIPLES of an autonomous designer's taste.",
    "Below are tournament outcomes. MISSED-WINNER cases are where the taste-judge",
    "preferred a different variant than the one that actually won (or that the human",
    "corrected to) — those are the lessons that most improve taste; fix them first.",
    "CONFIRMED-WIN cases reinforce principles that are already working.",
    "",
    "=== MISSED-WINNER (taste was wrong — learn most from these) ===",
    les.missedWinner.map(fmt).join("\n") || "(none)",
    "",
    "=== CONFIRMED-WIN (taste was right — reinforce) ===",
    les.confirmedWin.map(fmt).join("\n") || "(none)",
    "",
    "=== CURRENT designer-persona.md ===",
    persona,
    "",
    "Output ONLY a short markdown bullet list (3-8 bullets) of concrete, GENERAL design",
    "principles — each phrased as 'Prefer X when ...' or 'Avoid Y because ...'. Generalize",
    "from the cases; do not restate them. Keep what still holds, revise what was wrong.",
    "No preamble, no code fences.",
  ].join("\n");
}

const PERSONA_PATH = personaPath();

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const applyFile = arg("--apply-file");
  const seeded = bootstrapPersonaIfMissing(PERSONA_PATH);
  if (seeded) console.error(`[design-persona] seeded persona from template → ${PERSONA_PATH}`);
  if (applyFile) {
    if (!existsSync(PERSONA_PATH)) { console.error(`persona not found: ${PERSONA_PATH}`); process.exit(1); }
    const rules = readFileSync(resolve(applyFile), "utf8");
    const updated = upsertLearnedBlock(readFileSync(PERSONA_PATH, "utf8"), rules);
    writeFileSync(PERSONA_PATH, updated);
    console.log(JSON.stringify({ applied: true, persona: PERSONA_PATH }));
  } else {
    const min = Number(arg("--min", "1")) || 1;
    const les = findLessons(loadDataset());
    const n = les.missedWinner.length + les.confirmedWin.length;
    if (n < min) {
      console.log(JSON.stringify({ ready: false, reason: `only ${n} lesson(s); below ${min}`, ...counts(les) }, null, 2));
    } else if (!existsSync(PERSONA_PATH)) {
      console.log(JSON.stringify({ ready: false, reason: `persona not found: ${PERSONA_PATH}` }, null, 2));
    } else {
      const persona = readFileSync(PERSONA_PATH, "utf8");
      console.log(JSON.stringify({ ready: true, ...counts(les), prompt: buildPrompt(persona, les) }, null, 2));
    }
  }
}

function counts(les) {
  return { missedWinner: les.missedWinner.length, confirmedWin: les.confirmedWin.length, total: les.total };
}
