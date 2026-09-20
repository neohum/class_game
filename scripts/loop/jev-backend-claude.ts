// jev-backend-claude.ts — answer Jev-shaped noul questions with a subscribed CLI.
//
// Jev is a closed, API-only model. That is fine as one option, but it makes the
// content-aware risk layer depend on a third-party key AND on shipping the diff
// off-box. A subscription the repo already has can answer the same questions:
//
//   - costs nothing extra (it is the same seat the loop already uses)
//   - adds no dependency and no new egress destination
//   - returns a differentiated confidence, which a local 7B does not:
//     measured on this repo, qwen2.5:7b answered every case 0.000 or 1.000,
//     so a probability threshold could not mean anything.
//
// The trade is latency: ~12s versus Jev's 70-500ms. Acceptable here because the
// gate already runs health.sh for tens of seconds and this fires once per card,
// with all questions batched into one prompt.
//
// This module speaks the same shape as jev.ts's `systemOne`, so jev-risk.ts's
// monotonic fusion, fallback and thresholds are reused unchanged.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { JevQuestion, JevResponse } from "./jev.ts";
import { parseStructured, type Schema } from "./schema.ts";
import { spawnSandboxed } from "./sandbox.ts";

/**
 * Haiku by default: this is a bounded yes/no classification, not a reasoning
 * task, and the cheapest fast model answered every probe case correctly here.
 * Override with JEV_CLAUDE_MODEL when a run wants a stronger judge.
 */
export const DEFAULT_CLAUDE_MODEL = "haiku";

export const DEFAULT_TIMEOUT_MS = 90_000;

/** One `{answer, confidence}` per question name the caller asked about. */
export function answerSchema(names: string[]): Schema {
  return {
    type: "object",
    required: names,
    properties: Object.fromEntries(names.map((n) => [n, {
      type: "object",
      required: ["answer", "confidence"],
      properties: {
        answer: { type: "string", enum: ["yes", "no"] },
        confidence: { type: "number" },
      },
    }])),
  } as Schema;
}

/**
 * Batch every question into one prompt.
 *
 * Asking them separately would multiply a 12s call by five. It also lets the
 * judge see the whole diff once, which is how Jev is used.
 */
export function buildPrompt(state: unknown, questions: Record<string, JevQuestion>): string {
  const asked = Object.entries(questions)
    .map(([name, q], i) => `${i + 1}. "${name}": ${q.instructions}`)
    .join("\n");
  const names = Object.keys(questions);
  const shape = names.map((n) => `"${n}": {"answer": "yes"|"no", "confidence": 0.0-1.0}`).join(", ");

  return [
    "You are a code-risk classifier. Judge ONLY what the diff below shows.",
    "",
    "=== STATE ===",
    typeof state === "string" ? state : JSON.stringify(state, null, 2),
    "=== END STATE ===",
    "",
    "Answer each statement about this change:",
    asked,
    "",
    "Rules:",
    "- Judge each statement independently. Do not let one answer influence another.",
    "- Answer only from what the diff shows. If the diff is marked partial, do not",
    "  assume the unshown part is safe — say no only when the shown lines support it.",
    "- confidence is how sure you are of YOUR answer, 0.0 to 1.0.",
    "",
    `Reply with ONLY one JSON object, no prose and no code fence: {${shape}}`,
  ].join("\n");
}

/**
 * Turn `{answer, confidence}` into the `noul` probability jev-risk.ts expects.
 *
 * P(yes) is what a noul means, so a confident "no" has to become a LOW
 * probability, not a high one — reading confidence directly would inverte the
 * verdict and turn every certain "no" into a certain "yes".
 */
export function toNoul(answer: string, confidence: number): number {
  const c = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5;
  const p = answer === "yes" ? c : 1 - c;
  // Round: 1 - 0.9 is 0.09999999999999998 in binary floating point, and these
  // values are compared against a threshold and printed to two decimals.
  return Math.round(p * 1e6) / 1e6;
}

function claudeBin(): string {
  return process.platform === "win32" ? "claude.exe" : "claude";
}

/** Run the CLI and capture stdout. Rejects on non-zero exit or timeout. */
function runClaude(prompt: string, model: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnSandboxed(claudeBin(), ["-p", "--model", model, prompt], {
      cwd: process.cwd(),
      // stdin ignored: an inherited stdin makes the CLI wait for input that
      // never comes when the loop runs unattended.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude backend timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on("data", (d) => { out += d.toString(); });
    child.stderr?.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`claude backend failed to start: ${e.message}`)); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude backend exited ${code}: ${err.trim().slice(0, 200) || "no stderr"}`));
    });
  });
}

/**
 * Drop-in replacement for jev.ts's `systemOne`, backed by the Claude CLI.
 *
 * Same contract: resolves with `{answers}` or throws. jev-risk.ts treats a
 * throw as "fall back to the regex floor", so a missing CLI or a malformed
 * answer degrades to pre-Jev behaviour rather than weakening the gate.
 */
export async function systemOneViaClaude({
  state,
  questions,
  env = process.env,
  run = runClaude,
}: {
  state: unknown;
  questions: Record<string, JevQuestion>;
  env?: NodeJS.ProcessEnv;
  run?: (prompt: string, model: string, timeoutMs: number) => Promise<string>;
}): Promise<JevResponse> {
  const names = Object.keys(questions);
  if (names.length === 0) throw new Error("claude backend: at least one question required");
  if (names.some((n) => questions[n]?.type !== "noul")) {
    // choice/score would need their own prompt and parse; the risk layer only
    // asks noul, so failing loudly beats silently mis-answering.
    throw new Error("claude backend: only noul questions are supported");
  }

  const model = env.JEV_CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
  const parsedTimeout = Number(env.JEV_CLAUDE_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;

  const raw = await run(buildPrompt(state, questions), model, timeoutMs);
  const parsed = parseStructured<Record<string, { answer: string; confidence: number }>>(
    raw,
    answerSchema(names),
  );
  if (!parsed.ok || !parsed.value) {
    throw new Error(`claude backend: unusable answer (${parsed.errors?.slice(0, 3).join("; ") || "no JSON"})`);
  }

  const answers: JevResponse["answers"] = {};
  for (const name of names) {
    const a = parsed.value[name];
    if (!a) continue;
    answers[name] = { noul: toNoul(a.answer, a.confidence), confidence: a.confidence };
  }
  return { answers, model: `claude:${model}` };
}

const isMain = (() => {
  try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const [stateText, ...rest] = process.argv.slice(2);
  if (!stateText) {
    console.log('usage: node scripts/loop/jev-backend-claude.ts "<state>" "<yes/no question>" [...]');
    process.exit(1);
  }
  const { noul } = await import("./jev.ts");
  const asked = rest.length ? rest : ["This text describes an urgent problem"];
  const questions = Object.fromEntries(asked.map((q, i) => [`q${i + 1}`, noul(q)]));
  systemOneViaClaude({ state: stateText, questions })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
