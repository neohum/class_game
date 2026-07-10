// validate-card.mjs — the "validate before building" gate.
//
// AI makes building nearly free, which means the loop can scale execution far
// ahead of understanding. This gathers the context a validator (human or agent)
// needs to decide whether a card is worth a build cycle — most importantly, it
// RECALLS prior cross-project knowledge from the hub so the loop reuses solutions
// instead of relearning. It does not pass judgment itself; it assembles the
// evidence and a contract template, then the validator agent decides go/sharpen/drop.
//
// Usage:
//   node scripts/loop/validate-card.mjs <card-slug> "<spec text>"
//   node scripts/loop/validate-card.mjs --card <card-slug>      (reads spec from backlog)
//   import { gatherValidationContext } from "./validate-card.mjs"

import { recall } from "./knowledge.mjs";
import { getBacklog } from "./backlog.mjs";

const STOP = new Set(["the","a","an","and","or","to","of","in","on","for","with","fix","add","make","is","it","this","that","page","app","when","from","into","your","our"]);

/** Pull the most search-worthy keywords out of a card spec. */
export function keywords(spec, max = 6) {
  const seen = new Set();
  const words = String(spec || "")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w) && !seen.has(w) && seen.add(w));
  // longer words tend to be more specific/distinctive
  return words.sort((a, b) => b.length - a.length).slice(0, max);
}

/**
 * Recall prior knowledge relevant to this card, across all projects. Because the
 * store does substring matching, we search several keywords and merge — that
 * surfaces far more than one phrase query would.
 * @param {string} spec
 * @param {number} perTerm
 * @returns {Promise<{terms:string[], hits:Array<object>, source:string}>}
 */
export async function gatherValidationContext(spec, perTerm = 5) {
  const terms = keywords(spec);
  const merged = new Map();
  let source = "none";
  for (const term of terms.length ? terms : [String(spec || "").slice(0, 40)]) {
    const r = await recall(term, { limit: perTerm });
    if (r.source !== "none") source = r.source;
    for (const e of r.entries) {
      const key = e.id != null ? `${e.project || ""}#${e.id}` : `${e.project || ""}:${e.title}`;
      if (!merged.has(key)) merged.set(key, e);
    }
  }
  return { terms, hits: [...merged.values()].slice(0, 12), source };
}

/** A printable contract the validator fills in — acceptance criteria chosen BEFORE building. */
export function contractTemplate(card, spec) {
  return [
    `## Validation contract — ${card}`,
    `- **Sharpened change**: <rewrite "${(spec || "").trim()}" as a specific, testable change: who/what/where>`,
    "- **Acceptance criteria** (chosen now, not cherry-picked later): <what evidence proves it worked>",
    "- **False positive looks like**: <it 'works' but didn't solve the real problem>",
    "- **Reuse check**: <hub hit to reuse, or 'none found'>",
    "- **Verdict**: go | sharpen | drop  (+ one-line reason)",
  ].join("\n");
}

// CLI
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  let card, spec;
  const ci = argv.indexOf("--card");
  if (ci !== -1) {
    card = argv[ci + 1];
    const b = await getBacklog();
    const row = b.list().find((t) => t.card === card);
    spec = row?.spec || "";
  } else {
    card = argv[0];
    spec = argv.slice(1).join(" ");
  }
  if (!card) { console.error('usage: validate-card.mjs <card-slug> "<spec>"  |  --card <slug>'); process.exit(2); }

  const ctx = await gatherValidationContext(spec);
  console.log(`# Validate: ${card}`);
  console.log(`\nspec: ${spec || "(none)"}`);
  console.log(`\n## Prior knowledge (recall via ${ctx.source}; terms: ${ctx.terms.join(", ") || "-"})`);
  if (!ctx.hits.length) console.log("(no prior knowledge — this is new ground, or the hub read endpoint isn't live yet)");
  else for (const e of ctx.hits) console.log(`- [${e.project || e.source || "?"}] ${e.title}${e.tags ? `  {${e.tags}}` : ""}`);
  console.log("\n" + contractTemplate(card, spec));
}
