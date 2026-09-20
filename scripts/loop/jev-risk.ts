// jev-risk.ts — content-aware risk scoring, fused monotonically with the regex floor.
//
// framein's riskScore() reads file NAMES. That misses the dangerous case: a
// permission check deleted inside server.ts scores "low" and ships autonomously.
// This module reads the actual hunks and can only RAISE the level.
//
// The monotonic rule is the safety argument for the whole Jev layer:
//
//     final = max(regex, jev)
//
// Jev never lowers a regex verdict, so adding it cannot weaken an existing gate.
// Every failure path — no key, timeout, bad response, feature off — returns the
// regex result unchanged, which is the harness's behaviour before Jev existed.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Risk, riskScore } from "./framein.ts";
import { type JevQuestion, type JevResponse, jevConfig, noul, noulValue, systemOne } from "./jev.ts";
import { buildDiffState } from "./jev-state.ts";
import { log } from "./telemetry.ts";

export type RiskLevel = "low" | "medium" | "high";

const LEVEL_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export interface FusedRisk extends Risk {
  /** Which scorers contributed: the regex floor alone, or the floor plus Jev. */
  source: "regex" | "regex+jev";
  /** Raw probabilities, kept for threshold tuning. Absent when Jev did not run. */
  jev?: Record<string, number | null>;
  /** Why Jev did not contribute, when it did not. */
  jevSkipped?: string;
}

/**
 * The questions. Each is atomic on purpose: the docs warn that Jev reads
 * literally, so "auth was weakened OR secrets leaked" would be unanswerable.
 * Compound judgement belongs in code, below, not in the prompt.
 *
 * Each key maps to the regex `why` it reinforces, so a Jev hit reports the same
 * vocabulary the reasons list already uses.
 */
export const RISK_QUESTIONS: Record<string, { q: string; why: string }> = {
  auth: {
    q: "This change modifies authentication, authorization, session handling, or an access-control check — including removing, weakening, or bypassing one.",
    why: "auth/permissions",
  },
  secrets: {
    q: "This change adds, exposes, logs, or hardcodes a credential, API key, token, or password.",
    why: "secrets/credentials",
  },
  schema: {
    q: "This change alters a database schema, a migration, or a persisted data shape in a way that could lose or corrupt existing data.",
    why: "schema/migration",
  },
  billing: {
    q: "This change affects payment, billing, pricing, invoicing, or subscription behaviour.",
    why: "billing/payments",
  },
  destructive: {
    q: "This change can delete, overwrite, or irreversibly mutate user data or production state.",
    why: "destructive operation",
  },
};

/**
 * Probability at or above which a noul answer counts as a hit.
 *
 * Deliberately below 0.5: this scorer only tightens gates, so a false positive
 * costs one human glance while a false negative ships an auth bypass. Tune only
 * with the Step 4 confusion matrix, and pin JEV_MODEL when you do.
 */
export const JEV_RISK_THRESHOLD = 0.45;

export function parseThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.JEV_RISK_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : JEV_RISK_THRESHOLD;
}

/** Is the Jev risk layer switched on? Opt-in: absent means off. */
export function jevRiskEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = String(env.FRAMEIN_JEV ?? "").trim().toLowerCase();
  return flag === "1" || flag === "on" || flag === "true";
}

export type JevBackend = "jev" | "claude";

/**
 * Which judge answers the questions.
 *
 * Defaults to `claude` because it needs no third-party key and sends the diff
 * nowhere new — the subscription is already in the loop. `jev` is the faster,
 * calibrated option for anyone who has a TYPESAFE_API_KEY.
 */
export function jevBackend(env: NodeJS.ProcessEnv = process.env): JevBackend {
  const raw = String(env.FRAMEIN_JEV_BACKEND ?? "").trim().toLowerCase();
  if (raw === "jev" || raw === "typesafe") return "jev";
  if (raw === "claude") return "claude";
  // No explicit choice: use Jev only when its key is actually present.
  return jevConfig(env).ready ? "jev" : "claude";
}

/** Highest level wins — the monotonic guarantee, in one place. */
export function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

/**
 * Turn Jev answers into a level plus human-readable reasons.
 * Any critical hit is "high", mirroring the regex table's `crit` semantics.
 */
export function levelFromAnswers(
  response: JevResponse | null,
  threshold: number,
): { level: RiskLevel; reasons: string[]; raw: Record<string, number | null> } {
  const raw: Record<string, number | null> = {};
  const reasons: string[] = [];
  let level: RiskLevel = "low";

  for (const [key, { why }] of Object.entries(RISK_QUESTIONS)) {
    const p = noulValue(response, key);
    raw[key] = p;
    if (p !== null && p >= threshold) {
      reasons.push(`jev: ${why} (${p.toFixed(2)})`);
      level = "high";
    }
  }
  return { level, reasons, raw };
}

/**
 * Score a change by paths (regex floor) and, when enabled, by diff content (Jev).
 *
 * Always resolves — never throws. On any Jev failure the regex result is
 * returned with `source: "regex"`, so the caller's gate behaves exactly as it
 * did before this module existed.
 */
export async function riskScoreFused(
  files: string[] = [],
  spec = "",
  {
    baseline = "HEAD",
    cwd = process.cwd(),
    env = process.env,
    fetchImpl = fetch,
    stateBuilder = buildDiffState,
    ask = systemOne,
    askClaude,
  }: {
    baseline?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    stateBuilder?: typeof buildDiffState;
    ask?: typeof systemOne;
    /** Injected for tests; defaults to the real CLI-backed judge. */
    askClaude?: (args: { state: unknown; questions: Record<string, JevQuestion>; env?: NodeJS.ProcessEnv }) => Promise<JevResponse>;
  } = {},
): Promise<FusedRisk> {
  const base = riskScore(files, spec);
  const floor: FusedRisk = { ...base, source: "regex" };

  if (!jevRiskEnabled(env)) return { ...floor, jevSkipped: "disabled" };
  const backend = jevBackend(env);
  if (backend === "jev" && !jevConfig(env).ready) return { ...floor, jevSkipped: "no api key" };
  if (files.length === 0) return { ...floor, jevSkipped: "no changed files" };

  try {
    const state = stateBuilder(files, { baseline, cwd, env });
    const questions = Object.fromEntries(
      Object.entries(RISK_QUESTIONS).map(([key, { q }]) => [key, noul(q)]),
    );
    // Both backends return the same {answers:{name:{noul}}} shape, so the
    // fusion, threshold and fallback below are identical either way.
    const response = backend === "claude"
      ? await (askClaude ?? (await import("./jev-backend-claude.ts")).systemOneViaClaude)(
          { state: { intent: spec, diff: state }, questions, env },
        )
      : await ask({ state: { intent: spec, diff: state }, questions, env, fetchImpl });
    const threshold = parseThreshold(env);
    const { level, reasons, raw } = levelFromAnswers(response, threshold);

    const fusedLevel = maxLevel(base.level as RiskLevel, level);
    const fused: FusedRisk = {
      level: fusedLevel,
      // Keep `score` consistent with `level`: framein's invariant is
      // "score >= 3 ⟺ high" and failClosedRisk uses 99 for a forced high, so
      // {level:"high", score:0} would be an incoherent object.
      score: fusedLevel === base.level ? base.score : Math.max(base.score, 3),
      reasons: [...base.reasons, ...reasons],
      source: "regex+jev",
      jev: raw,
    };

    await log("iterate", {
      actor: "jev-risk",
      detail: { backend, regex: base.level, jev: level, fused: fusedLevel, threshold, raw },
    }).catch(() => {});

    return fused;
  } catch (error) {
    // Falling back to the regex floor is not opening the gate: it is the exact
    // behaviour that shipped before Jev, so an outage cannot weaken the harness.
    await log("iterate", {
      actor: "jev-risk",
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
  const { changedFiles } = await import("./framein.ts");
  const baseline = process.argv[2] || "HEAD";
  const files = changedFiles(baseline);
  const risk = await riskScoreFused(files, "", { baseline });
  console.log(JSON.stringify(risk, null, 2));
  process.exit(risk.level === "high" ? 20 : risk.level === "medium" ? 10 : 0);
}
