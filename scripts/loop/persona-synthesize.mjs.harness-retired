// persona-synthesize.mjs — "textual gradient descent" on persona.md.
//
// persona.md is the parameter theta of the decision policy, expressed in language.
// The loss is its disagreement with your real taps:
//
//   false-approve  : persona said "approve",  you said "reject"   (costly!)
//   over-cautious  : persona said "escalate", you said "approve"  (annoying)
//
// Each run reads those disagreements and asks an agent to edit persona.md so the
// policy would have matched you — coordinate descent in language space, with an
// asymmetric loss that fixes the expensive false-approves first. To stay safe we
// NEVER touch your hand-written prose: edits land only inside a managed marker
// block, so the human-authored prior and the learned refinements stay separable.

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadDataset } from "./persona-feedback.mjs";
import { log } from "./telemetry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.cwd());
const PERSONA_PATH = resolve(ROOT, ".claude", "persona.md");

export const BEGIN = "<!-- BEGIN LEARNED RULES (persona-synthesize.mjs — auto-generated; edits inside this block are overwritten) -->";
export const END = "<!-- END LEARNED RULES -->";

/**
 * Split the dataset into the cases where the persona disagreed with your tap.
 * Only rows with BOTH a prediction and a label can disagree (history rows can't).
 * @param {Array<object>} rows
 * @returns {{falseApprove:Array, overCautious:Array, agree:number, total:number}}
 */
export function findDisagreements(rows) {
  const falseApprove = [], overCautious = [];
  let agree = 0, total = 0;
  for (const r of rows) {
    if (!r.predicted || !r.predicted.decision || !(r.label === "approve" || r.label === "reject")) continue;
    total++;
    const pred = r.predicted.decision;
    if (pred === "approve" && r.label === "reject") falseApprove.push(r);
    else if (pred !== "approve" && r.label === "approve") overCautious.push(r);
    else agree++;
  }
  return { falseApprove, overCautious, agree, total };
}

/**
 * Insert or replace the learned-rules block. Never disturbs text outside it.
 * @param {string} content current persona.md
 * @param {string} rules markdown body for the block
 * @returns {string}
 */
export function upsertLearnedBlock(content, rules) {
  const block = `${BEGIN}\n## Learned Rules (from your taps)\n${rules.trim()}\n${END}`;
  const b = content.indexOf(BEGIN);
  const e = content.indexOf(END);
  if (b !== -1 && e !== -1 && e > b) {
    return content.slice(0, b) + block + content.slice(e + END.length);
  }
  return content.replace(/\s*$/, "") + "\n\n" + block + "\n";
}

function buildPrompt(persona, dis) {
  const fmt = (r) => `- spec: ${r.spec || "(none)"} | persona said: ${r.predicted.decision} | you decided: ${r.label}`;
  return [
    "You maintain the owner's decision persona for an autonomous deploy gate.",
    "Below are cases where the persona's prediction DISAGREED with what the owner",
    "actually decided. Your job: write concise rules that would make the persona",
    "match the owner next time. PRIORITIZE eliminating false-approves (the persona",
    "shipped something the owner rejected) — those are the expensive mistakes.",
    "",
    "=== FALSE-APPROVES (persona approved, owner rejected — fix these first) ===",
    dis.falseApprove.map(fmt).join("\n") || "(none)",
    "",
    "=== OVER-CAUTIOUS (persona escalated, owner would have approved) ===",
    dis.overCautious.map(fmt).join("\n") || "(none)",
    "",
    "=== CURRENT persona.md ===",
    persona,
    "",
    "Output ONLY a short markdown bullet list (3-8 bullets) of concrete, general",
    "rules — each phrased as 'Escalate when ...' or 'Safe to auto-approve when ...'.",
    "Generalize from the examples; do not just restate them. No preamble, no fences.",
  ].join("\n");
}

async function askAgent(prompt) {
  const invokeScript = resolve(HERE, "..", "invoke-claude.mjs");
  const child = spawn(process.execPath, [invokeScript, prompt], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.stderr.on("data", (d) => { out += d.toString(); });
  const code = await new Promise((res) => child.on("exit", res));
  return code === 0 ? out.trim() : null;
}

/**
 * Run one synthesis pass. Returns a summary; no-op when there's nothing to learn.
 * @param {{minDisagreements?:number, dry?:boolean}} [opt]
 */
export async function synthesize({ minDisagreements = 1, dry = false } = {}) {
  const dis = findDisagreements(loadDataset());
  const n = dis.falseApprove.length + dis.overCautious.length;
  if (n < minDisagreements) {
    return { updated: false, reason: `only ${n} disagreement(s); below threshold ${minDisagreements}`, ...dis };
  }
  if (!existsSync(PERSONA_PATH)) {
    return { updated: false, reason: "persona.md not found", ...dis };
  }
  const persona = readFileSync(PERSONA_PATH, "utf8");
  const rules = dry ? null : await askAgent(buildPrompt(persona, dis));
  if (!rules) {
    return { updated: false, reason: dry ? "dry run" : "agent produced no rules", ...dis };
  }
  writeFileSync(PERSONA_PATH, upsertLearnedBlock(persona, rules));
  try { await log("iterate", { actor: "persona", detail: `synthesized ${n} disagreement(s) into persona.md` }); } catch {}
  return { updated: true, falseApprove: dis.falseApprove.length, overCautious: dis.overCautious.length, agree: dis.agree, total: dis.total };
}

// CLI: `node scripts/loop/persona-synthesize.mjs [--dry] [--min N]`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry");
  const mi = argv.indexOf("--min");
  const minDisagreements = mi !== -1 ? Number(argv[mi + 1]) || 1 : 1;
  const r = await synthesize({ dry, minDisagreements });
  console.log(JSON.stringify(r, null, 2));
}
