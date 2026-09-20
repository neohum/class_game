// assess-prompts.ts — turns the human's chat prompts into backlog cards via a
// sub-agent (Codex-first, with provider failover).
//
// The knowledge base auto-captures every human prompt (CLAUDE.md's "지식베이스
// 프롬프트 자동 저장" rule, tagged human,prompt) — but those prompts never became
// work. This module closes that gap: it hands the un-carded human prompts to a
// sub-agent, which TRIAGES them (a prompt is often a question or a meta-request,
// not a build task) and returns only the actionable ones as {card, spec} JSON.
// We then add those to the backlog.
//
// Why a sub-agent and not a regex: deciding "is this prompt actual work, and if
// so what's the acceptance criterion" is a judgment call — exactly the
// a bounded structured-classification lane. Codex handles it first; the shared
// agent-session failover roster keeps Claude as the last resort.
//
// Idempotence: processed knowledge-entry ids are recorded in
// .harness/prompt-cards-seen.json, so each prompt is triaged at most once even
// though the agent's output slugs aren't derivable from the prompt.
//
// CLI:
//   node scripts/loop/assess-prompts.ts          # triage new prompts → cards
//   node scripts/loop/assess-prompts.ts --dry     # show candidates, add nothing

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getBacklog } from "./backlog.ts";
import { getKnowledge } from "./knowledge.ts";
import { log } from "./telemetry.ts";
import { laneArgs } from "./lanes.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.cwd());
const STATE_DIR = resolve(ROOT, process.env.HARNESS_STATE_DIR || ".harness");
const SEEN_PATH = resolve(STATE_DIR, "prompt-cards-seen.json");

// A knowledge entry is a "human prompt" if its tags mark it so. The auto-save
// rule tags these human,prompt; be liberal and accept either.
/** One knowledge entry as the triage reads it. */
interface PromptEntry {
  id: number;
  title?: string;
  body?: string;
  tags?: string;
  source?: string;
}

function isHumanPrompt(e: PromptEntry): boolean {
  const tags = String(e.tags || "").toLowerCase();
  return tags.includes("prompt") && (tags.includes("human") || e.source === "day-human");
}

function loadSeen(): Set<number> {
  try {
    if (existsSync(SEEN_PATH)) return new Set(JSON.parse(readFileSync(SEEN_PATH, "utf8")).ids || []);
  } catch {}
  return new Set();
}

function saveSeen(set: Set<number>): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SEEN_PATH, JSON.stringify({ ids: [...set] }, null, 2) + "\n");
}

/** Un-carded human prompts, oldest first, that we haven't triaged before. */
export async function pendingPrompts(limit = 200) {
  const kb = await getKnowledge();
  const seen = loadSeen();
  return kb.list(limit)
    .filter(isHumanPrompt)
    .filter((e: PromptEntry) => !seen.has(e.id))
    .reverse(); // list() is newest-first; triage in chronological order
}

function buildPrompt(prompts: PromptEntry[]): string {
  const numbered = prompts
    .map((e: PromptEntry, i: number) => `${i + 1}. (kb#${e.id}) ${e.body || e.title}`)
    .join("\n");
  return [
    "You are the lead engineer triaging a user's chat prompts into a build backlog.",
    "Below are prompts the user typed this session, captured verbatim. MOST ARE NOT TASKS —",
    "many are questions, status checks, or meta-requests about the harness itself. Your job is",
    "to select ONLY the ones that describe concrete engineering work to perform on THIS codebase,",
    "and phrase each as a builder-ready task card with an explicit acceptance criterion.",
    "",
    "Rules:",
    "  - Ignore questions ('왜/무엇/how does…'), status/observability requests, and prompts about",
    "    running the loop or dashboard — those are not build work.",
    "  - Ignore anything already obviously done or purely conversational.",
    "  - Collapse duplicates: if two prompts describe the same work, emit one card.",
    "  - Prefer the user's own words for the spec; add the acceptance criterion.",
    "",
    "Prompts:",
    numbered,
    "",
    "Output ONLY a raw JSON array of task cards. Each object MUST have:",
    "  - 'card': a url-friendly lowercase hyphen slug (e.g. 'add-remember-me-checkbox')",
    "  - 'spec': the actionable instruction INCLUDING acceptance criterion (what proves it done)",
    "Do NOT wrap in markdown fences. No prose outside the array. If none are actionable, return [].",
    'Example: [{"card":"export-events-pdf","spec":"Add a PDF export button to the profile page that renders the user\'s events; accept when clicking it downloads a non-empty PDF."}]',
  ].join("\n");
}

function parseCards(stdout: string): Array<{ card?: string; spec?: string }> | null {
  try {
    const m = stdout.match(/\[\s*(?:\{[\s\S]*\}\s*)?\]/);
    const arr = JSON.parse(m ? m[0] : stdout.trim());
    return Array.isArray(arr) ? arr : [];
  } catch {
    return null;
  }
}

/**
 * Triage pending human prompts into backlog cards via the architect sub-agent.
 * @param {object} backlog backend
 * @param {{dry?:boolean}} [opt]
 * @returns {Promise<{added:string[], considered:number}>}
 */
interface BacklogLike {
  list(): Array<{ card: string }>;
  add(card: string, spec: string, source: string): Promise<unknown> | unknown;
}

export async function runPromptAssessment(backlog: BacklogLike, { dry = false } = {}) {
  const prompts = await pendingPrompts();
  if (prompts.length === 0) return { added: [], considered: 0 };

  console.log(`[Prompts] triaging ${prompts.length} un-carded human prompt(s) via sub-agent...`);
  try { await log("iterate", { actor: "lead", detail: `triaging ${prompts.length} prompt(s) into cards` }); } catch {}

  const sessionScript = resolve(HERE, "..", "agent-session.ts");
  const child = spawn(process.execPath, [sessionScript, ...laneArgs("prompts"), buildPrompt(prompts)], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const code = await new Promise((res) => child.on("exit", res));

  if (code !== 0) {
    console.error(`[Prompts] sub-agent exited ${code}`);
    console.error(stderr);
    return { added: [], considered: prompts.length };
  }

  const cards = parseCards(stdout);
  if (!cards) {
    console.error("[Prompts] could not parse sub-agent JSON. Raw output:");
    console.log(stdout);
    return { added: [], considered: prompts.length };
  }

  const existing = new Set(backlog.list().map((t) => t.card));
  const added: string[] = [];
  for (const c of cards) {
    if (!c.card || !c.spec || existing.has(c.card)) continue;
    if (dry) { added.push(c.card); continue; }
    backlog.add(c.card, c.spec, "prompt");
    added.push(c.card);
    try { await log("iterate", { card: c.card, actor: "lead", detail: `carded from prompt: ${c.spec}` }); } catch {}
  }

  // Mark every prompt we showed the agent as processed — including the ones it
  // (correctly) discarded, so we don't re-triage a question every loop.
  if (!dry) {
    const seen = loadSeen();
    for (const e of prompts) seen.add(e.id);
    saveSeen(seen);
  }

  console.log(`[Prompts] added ${added.length} card(s)${dry ? " (dry)" : ""}: ${added.join(", ") || "(none)"}`);
  return { added, considered: prompts.length };
}

// CLI
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
  const dry = process.argv.includes("--dry");
  const b = await getBacklog();
  runPromptAssessment(b, { dry }).catch((e) => { console.error(e); process.exit(1); });
}
