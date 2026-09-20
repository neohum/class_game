// jev.ts — TypeSafe AI "System One" (Jev) client: typed decisions over HTTP.
//
// Jev does not generate text. It takes a `state` plus named typed questions and
// returns typed values with calibrated probabilities — which is exactly the shape
// the harness gates need, and why this is worth a network call at all.
//
// No SDK: @typesafe-ai/sdk exists, but this repo ships zero runtime dependencies
// and the whole API is one POST. Follows notify-resend.ts (readiness config +
// injectable fetchImpl + AbortController timeout + best-effort telemetry).
//
// Three question types, per the API:
//   noul   → truth in 0..1                        (no separate confidence field)
//   choice → one of N labelled options            (+ probabilities, confidence)
//   score  → position on 2..10 ordered levels     (+ probabilities, confidence)

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { log } from "./telemetry.ts";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

// Pinned, not "jev-latest": the docs warn that tuned thresholds must pin a
// version, and every caller here compares probabilities against a threshold.
export const JEV_DEFAULT_MODEL = "jev-1.13.0";

export const JEV_DEFAULT_TIMEOUT_MS = 10_000;

// API limits (docs): 64k tokens for state + all questions, 32k for state alone.
// Enforced in characters by jev-state.ts; recorded here as the source of truth.
export const JEV_MAX_STATE_TOKENS = 32_000;
export const JEV_MAX_TOTAL_TOKENS = 64_000;

export const JEV_MAX_CHOICE_OPTIONS = 255;
export const JEV_MIN_SCORE_LEVELS = 2;
export const JEV_MAX_SCORE_LEVELS = 10;

export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface JevAnswer {
  /** noul only: truth value in 0..1. */
  noul?: number;
  /** choice only: the selected option key. */
  choice?: string;
  /** score only: position on the level scale; may land between levels (e.g. 1.035). */
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface JevResponse {
  answers: Record<string, JevAnswer>;
  model?: string;
  usage?: Record<string, unknown>;
}

export interface JevConfig {
  apiKey?: string;
  model: string;
  timeoutMs: number;
  missing: string[];
  ready: boolean;
}

/**
 * Report configuration and what is missing, without throwing — callers gate on
 * `ready` so an absent key leaves the harness on its regex baseline instead of
 * failing a build.
 */
export function jevConfig(env: NodeJS.ProcessEnv = process.env): JevConfig {
  const apiKey = env.TYPESAFE_API_KEY;
  const missing: string[] = [];
  if (!apiKey) missing.push("TYPESAFE_API_KEY");
  const parsedTimeout = Number(env.JEV_TIMEOUT_MS);
  return {
    apiKey,
    model: env.JEV_MODEL || JEV_DEFAULT_MODEL,
    timeoutMs: Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : JEV_DEFAULT_TIMEOUT_MS,
    missing,
    ready: missing.length === 0,
  };
}

/** Yes/no question. The answer is a probability in 0..1, not a boolean. */
export function noul(instructions: string): JevQuestion {
  if (!instructions?.trim()) throw new Error("jev noul: instructions required");
  return { type: "noul", instructions };
}

/** One-of-N question. `criteria` maps an option key to what that option means. */
export function choice(instructions: string, criteria: Record<string, string>): JevQuestion {
  if (!instructions?.trim()) throw new Error("jev choice: instructions required");
  const keys = Object.keys(criteria ?? {});
  if (keys.length < 2) throw new Error("jev choice: needs at least 2 options");
  if (keys.length > JEV_MAX_CHOICE_OPTIONS) {
    throw new Error(`jev choice: at most ${JEV_MAX_CHOICE_OPTIONS} options, got ${keys.length}`);
  }
  return { type: "choice", instructions, criteria };
}

/** Ordered-spectrum question. `criteria` is 2..10 levels, lowest first. */
export function score(instructions: string, criteria: string[]): JevQuestion {
  if (!instructions?.trim()) throw new Error("jev score: instructions required");
  const levels = criteria ?? [];
  if (levels.length < JEV_MIN_SCORE_LEVELS || levels.length > JEV_MAX_SCORE_LEVELS) {
    throw new Error(`jev score: needs ${JEV_MIN_SCORE_LEVELS}-${JEV_MAX_SCORE_LEVELS} levels, got ${levels.length}`);
  }
  return { type: "score", instructions, criteria: levels };
}

/**
 * Ask Jev a batch of typed questions about one state.
 *
 * Batching matters: per the docs, extra questions barely move response time and
 * cost only their own tokens — so callers should ask everything in one call
 * rather than serialising several.
 *
 * Throws on a missing key, a non-2xx response, or a timeout. Callers that must
 * not fail (the gates) catch and fall back to their deterministic baseline.
 */
export async function systemOne({
  state,
  questions,
  env = process.env,
  fetchImpl = fetch,
  signal,
}: {
  state: unknown;
  questions: Record<string, JevQuestion>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<JevResponse> {
  const cfg = jevConfig(env);
  if (!cfg.ready) throw new Error(`missing required env: ${cfg.missing.join(", ")}`);
  if (!questions || Object.keys(questions).length === 0) {
    throw new Error("jev systemOne: at least one question required");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  // An external abort (the caller's own budget) must cancel this request too.
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  const started = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: cfg.model, state, questions }),
      signal: controller.signal,
    });
  } catch (error) {
    const reason = controller.signal.aborted ? `timed out after ${cfg.timeoutMs}ms` : (error as Error).message;
    throw new Error(`Jev request failed: ${reason}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }

  const data = (await response.json().catch(() => ({}))) as
    & { answers?: Record<string, JevAnswer>; message?: string; error?: { message?: string } }
    & Record<string, unknown>;

  if (!response.ok) {
    throw new Error(`Jev request failed: ${data.error?.message || data.message || response.status}`);
  }
  if (!data.answers || typeof data.answers !== "object") {
    throw new Error("Jev request failed: response has no answers object");
  }

  // Telemetry must never break the call.
  await log("iterate", {
    actor: "jev",
    detail: { model: cfg.model, questions: Object.keys(questions).length, ms: Date.now() - started },
  }).catch(() => {});

  return { answers: data.answers, model: data.model as string | undefined, usage: data.usage as Record<string, unknown> | undefined };
}

/**
 * Read a noul probability by question name, or `null` when the model did not
 * answer it. `null` means "no signal" and must never be coerced to 0 — at a
 * gate, 0 reads as "definitely safe".
 */
export function noulValue(response: JevResponse | null | undefined, name: string): number | null {
  const raw = response?.answers?.[name]?.noul;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

const isMain = (() => {
  try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const [stateText, ...rest] = process.argv.slice(2);
  const cfg = jevConfig();
  if (!stateText) {
    console.log("usage: node scripts/loop/jev.ts \"<state text>\" \"<yes/no question>\" [more questions...]");
    console.log(`model: ${cfg.model}  ready: ${cfg.ready}${cfg.ready ? "" : `  missing: ${cfg.missing.join(", ")}`}`);
    process.exit(cfg.ready ? 0 : 1);
  }
  const asked = rest.length > 0 ? rest : ["This text describes an urgent problem"];
  const questions = Object.fromEntries(asked.map((q, i) => [`q${i + 1}`, noul(q)]));
  systemOne({ state: stateText, questions })
    .then((r) => {
      for (const [name, q] of Object.entries(questions)) {
        console.log(`${(q as { instructions: string }).instructions} → ${noulValue(r, name)}`);
      }
    })
    .catch((error) => { console.error(error.message); process.exit(1); });
}
