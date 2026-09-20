// jev-sensitive.ts — content-aware classification of a card's SPEC text.
//
// Step 5 of plans/jev-decision-layer.plan.md. The sibling of jev-risk.ts:
// that one reads the diff, this one reads the sentence the card was written
// with. persona-approve.ts's SENSITIVE_PATTERNS matches keywords, so a spec
// that describes a dangerous change without using the dangerous words walks
// straight through. Measured on this repo:
//
//   "remove the admin gate from the records endpoint"   -> regex: (none)
//   "let anyone through without checking who they are"  -> regex: (none)
//   "stop verifying the bearer before trusting it"      -> regex: (none)
//
// All three are auth bypasses. Meanwhile "fix a typo in the payment docs"
// trips "billing/cost" and holds a deploy for nothing.
//
// The same monotonic rule as jev-risk.ts applies, and for the same reason:
//
//     final reasons = regex reasons ∪ judged reasons
//
// A regex hit ALWAYS escalates. The judge can only add, never remove — so
// turning this on cannot let through anything that was held before, and every
// failure path returns the regex result unchanged.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifySensitive } from "./persona-approve.ts";
import { type JevQuestion, type JevResponse, noul, noulValue, systemOne, jevConfig } from "./jev.ts";
import { jevBackend, jevRiskEnabled, parseThreshold } from "./jev-risk.ts";
import { log } from "./telemetry.ts";

/**
 * Atomic questions, phrased about INTENT rather than code.
 *
 * Each maps to the same `why` vocabulary SENSITIVE_PATTERNS already reports, so
 * a judged hit reads identically to a regex hit in the escalation reason.
 */
export const SPEC_QUESTIONS: Record<string, { q: string; why: string }> = {
  auth: {
    q: "This task would change who can access something, or weaken, remove, or bypass a check on identity, permission, or session.",
    why: "auth/permissions",
  },
  secrets: {
    q: "This task involves a credential, API key, token, password, or other secret value.",
    why: "secrets/credentials",
  },
  schema: {
    q: "This task would change a database schema or migration, or alter the shape of already-stored data.",
    why: "database schema/migration",
  },
  bulk: {
    q: "This task would delete, overwrite, or mass-modify existing user or customer records.",
    why: "bulk data mutation",
  },
  billing: {
    q: "This task would change what a customer is actually charged, billed, or refunded.",
    why: "billing/cost",
  },
  production: {
    q: "This task would change production infrastructure, deployment configuration, or DNS.",
    why: "production infra/config",
  },
};

export interface SensitiveResult {
  /** Union of regex and judged reasons — what the gate escalates on. */
  reasons: string[];
  /** Which classifiers contributed. */
  source: "regex" | "regex+jev";
  /** Raw probabilities, kept for threshold tuning. */
  jev?: Record<string, number | null>;
  /** Why the judge did not contribute, when it did not. */
  jevSkipped?: string;
}

/** Judged reasons at or above the threshold, labelled so they are traceable. */
export function reasonsFromAnswers(
  response: JevResponse | null,
  threshold: number,
): { reasons: string[]; raw: Record<string, number | null> } {
  const raw: Record<string, number | null> = {};
  const reasons: string[] = [];
  for (const [key, { why }] of Object.entries(SPEC_QUESTIONS)) {
    const p = noulValue(response, key);
    raw[key] = p;
    if (p !== null && p >= threshold) reasons.push(`jev: ${why} (${p.toFixed(2)})`);
  }
  return { reasons, raw };
}

/**
 * Classify a spec by keywords (floor) and, when enabled, by meaning.
 *
 * Always resolves. On any failure the regex reasons are returned unchanged with
 * `source: "regex"`, which is exactly how the gate behaved before this existed.
 */
export async function classifySensitiveFused(
  spec = "",
  {
    env = process.env,
    fetchImpl = fetch,
    ask = systemOne,
    askClaude,
  }: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    ask?: typeof systemOne;
    askClaude?: (args: { state: unknown; questions: Record<string, JevQuestion>; env?: NodeJS.ProcessEnv }) => Promise<JevResponse>;
  } = {},
): Promise<SensitiveResult> {
  const regexReasons = classifySensitive(spec);
  const floor: SensitiveResult = { reasons: regexReasons, source: "regex" };

  if (!jevRiskEnabled(env)) return { ...floor, jevSkipped: "disabled" };
  if (!spec.trim()) return { ...floor, jevSkipped: "empty spec" };
  const backend = jevBackend(env);
  if (backend === "jev" && !jevConfig(env).ready) return { ...floor, jevSkipped: "no api key" };

  try {
    const questions = Object.fromEntries(
      Object.entries(SPEC_QUESTIONS).map(([key, { q }]) => [key, noul(q)]),
    );
    const state = { task: spec };
    const response = backend === "claude"
      ? await (askClaude ?? (await import("./jev-backend-claude.ts")).systemOneViaClaude)({ state, questions, env })
      : await ask({ state, questions, env, fetchImpl });

    const threshold = parseThreshold(env);
    const { reasons: judged, raw } = reasonsFromAnswers(response, threshold);

    // Union, not replacement: a regex hit must survive a judge that disagrees.
    const merged = [...regexReasons];
    for (const r of judged) if (!merged.includes(r)) merged.push(r);

    await log("iterate", {
      actor: "jev-sensitive",
      detail: { backend, regex: regexReasons.length, judged: judged.length, threshold, raw },
    }).catch(() => {});

    return { reasons: merged, source: "regex+jev", jev: raw };
  } catch (error) {
    await log("iterate", {
      actor: "jev-sensitive",
      detail: { backend, fallback: "regex", error: (error as Error).message },
    }).catch(() => {});
    return { ...floor, jevSkipped: (error as Error).message };
  }
}

const isMain = (() => {
  try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const spec = process.argv.slice(2).join(" ");
  if (!spec) {
    console.log('usage: node scripts/loop/jev-sensitive.ts "<card spec>"');
    process.exit(1);
  }
  const result = await classifySensitiveFused(spec);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.reasons.length ? 10 : 0);
}
