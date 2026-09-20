// persona-approve.ts — the persona stands in for the human at the deploy gate.
//
// The loop used to auto-deploy the moment the reviewer signed off, leaving the
// human only a post-hoc rollback tap. That is too eager for high-stakes changes
// and too slow to actually be autonomous for routine ones. This gate closes both
// gaps: it reads .claude/persona.md and decides, *as the owner would*, whether a
// reviewed change is safe to ship without a human.
//
// It is deliberately CONSERVATIVE (human-on-the-loop, not hands-off):
//   approve   — confident, low/medium blast radius, nothing sensitive  -> auto-deploy
//   escalate  — anything uncertain, high blast radius, or sensitive     -> ask the human
//   reject    — the persona judges the change below its standards        -> requeue
//
// The independent reviewer normally returns the persona recommendation in the
// same structured response as its acceptance evidence. Direct callers and old
// checkpoints fall back to a separate persona-injected Claude judge. Either path
// is run through a deterministic floor in decide(), so a sensitive spec or a
// low-confidence verdict can never slip into an autonomous deploy.
//
// Disable the gate (revert to legacy auto-deploy) with PERSONA_APPROVE=off.
// Tune the bar with PERSONA_APPROVE_THRESHOLD (default 0.8).

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./telemetry.ts";
import { recordPrediction } from "./persona-feedback.ts";
import { calibrate, loadParams, optimalThreshold } from "./persona-calibrate.ts";
import { parseStructured, retryPrompt } from "./schema.ts";
import { realpathSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.cwd());

// Specs that touch these areas are NEVER auto-approved — they go to the human no
// matter how confident the model is. Mirrors the "Always escalate" list in
// persona.md; keep the two in sync. Matched case-insensitively against the spec.
// Each entry pairs an English \b-anchored branch with a Korean branch. Hangul
// has no ASCII \b boundary, so the Korean alternatives are listed WITHOUT \b —
// otherwise a Korean spec ("결제 로직 수정", "인증 우회 삭제") would slip past the
// gate and auto-deploy. Over-triggering here is the safe direction: a held
// deploy is cheap, a wrong autonomous one is not.
export const SENSITIVE_PATTERNS = [
  { re: /\b(migrat\w+|schema change|alter table|drop (table|column)|drop database)\b|(마이그레이션|스키마\s*(변경|수정)|테이블\s*삭제|컬럼\s*삭제|디비\s*삭제)/i, why: "database schema/migration" },
  { re: /\b(delete|wipe|purge|truncate|mass[- ]?update)\b.*\b(user|customer|account|data|row)/i, why: "bulk data mutation" },
  { re: /(사용자|회원|고객|계정|데이터|레코드).{0,8}(삭제|초기화)|(대량|일괄)\s*(삭제|수정|변경|업데이트)/i, why: "bulk data mutation (ko)" },
  { re: /\b(secret|api[- ]?key|token|credential|password|\.env)\b|(시크릿|비밀번호|비밀키|자격증명|토큰|암호키|환경변수)/i, why: "secrets/credentials" },
  { re: /\b(auth\w*|login|permission|role|access control|rbac)\b|(인증|로그인|권한|접근제어|역할)/i, why: "auth/permissions" },
  { re: /\b(billing|payment|invoice|charge|subscription|pricing|stripe)\b|(결제|청구|요금|구독|환불|정산|과금)/i, why: "billing/cost" },
  { re: /\b(production|prod env|infra\w*|dns|deploy target)\b|(운영\s*환경|프로덕션|인프라|배포\s*대상)/i, why: "production infra/config" },
];

const VALID_DECISIONS = new Set(["approve", "escalate", "reject"]);
const VALID_BLAST = new Set(["low", "medium", "high"]);

// The persona verdict is structured output: schema-validated (schema.ts), with
// one format-feedback retry before the caller's decide() floor treats a still-
// invalid response as "no verdict" (→ escalate). decide() keeps its own field
// fallbacks as defense in depth.
export const VERDICT_SCHEMA = {
  type: "object",
  required: ["decision", "confidence", "blast_radius", "rationale"],
  properties: {
    decision: { enum: ["approve", "escalate", "reject"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    blast_radius: { enum: ["low", "medium", "high"] },
    rationale: { type: "string" },
  },
};

/**
 * Match a spec against the sensitive-area patterns.
 * @param {string} spec the task spec / one-line intent
 * @returns {string[]} human-readable reasons it is sensitive (empty if none)
 */
export function classifySensitive(spec = "") {
  const reasons = [];
  for (const { re, why } of SENSITIVE_PATTERNS) {
    if (re.test(spec)) reasons.push(why);
  }
  return reasons;
}

/**
 * The deterministic conservative floor. Given a (possibly null) model verdict and
 * the spec, decide what actually happens. This is pure and side-effect free so it
 * is unit-testable without invoking any CLI.
 *
 * @param {object} opts
 * @param {{decision?:string, confidence?:number, blast_radius?:string, rationale?:string}|null} opts.verdict
 * @param {string} opts.spec
 * @param {number} [opts.threshold] confidence bar for auto-approve (default 0.8)
 * @param {{level?:string, reasons?:string[]}} [opts.risk] framein path-risk score; a
 *        "high" level forces escalate (the diff touched auth/secrets/migrations/etc.)
 * @returns {{decision:"approve"|"escalate"|"reject", reason:string, confidence:number, blast_radius:string, source:string}}
 */
/** What the persona-backed agent returned about a change. */
export interface PersonaVerdict {
  decision?: string;
  confidence?: number;
  blast_radius?: string;
  rationale?: string;
}

/** framein's path-risk score for the actual diff. */
export interface RiskScore {
  level?: string;
  reasons?: string[];
}

/** The gate's answer, and which rule produced it. */
export interface Decision {
  decision: "approve" | "escalate" | "reject";
  reason: string;
  confidence: number;
  blast_radius: string;
  source: string;
}

export function decide({ verdict, spec = "", threshold = 0.8, risk = null }: {
  verdict?: PersonaVerdict | null;
  spec?: string;
  threshold?: number;
  risk?: RiskScore | null;
}): Decision {
  // 1. Sensitive areas always go to the human, whatever the model said.
  const sensitive = classifySensitive(spec);
  if (sensitive.length) {
    return {
      decision: "escalate",
      reason: `sensitive area(s): ${sensitive.join(", ")} — owner approval required`,
      confidence: verdict?.confidence ?? 0,
      blast_radius: verdict?.blast_radius ?? "high",
      source: "floor:sensitive",
    };
  }

  // 1b. Framein path-risk floor: when the actual diff touched a high-risk area
  //     (auth/, secrets, migrations, billing, the data contract), hold for the
  //     human even if the spec text looked innocuous. The spec-based sensitive
  //     check above can miss this — the file paths can't lie. Opt out with
  //     FRAMEIN_RISK=off (the loop passes risk=null in that case).
  if (risk && risk.level === "high") {
    return {
      decision: "escalate",
      reason: `high-risk diff: ${(risk.reasons || []).join(", ") || "blast radius"} — owner approval required`,
      confidence: verdict?.confidence ?? 0,
      blast_radius: "high",
      source: "floor:risk",
    };
  }

  // 2. No usable verdict (CLI absent, unparsable, dry run) -> conservative escalate.
  if (!verdict || !verdict.decision || !VALID_DECISIONS.has(verdict.decision)) {
    return {
      decision: "escalate",
      reason: "no usable persona verdict — defaulting to human approval",
      confidence: 0,
      blast_radius: "high",
      source: "floor:no-verdict",
    };
  }

  const confidence = Number.isFinite(verdict.confidence) ? verdict.confidence! : 0;
  const blast = verdict.blast_radius && VALID_BLAST.has(verdict.blast_radius) ? verdict.blast_radius : "high";

  // 3. The persona actively rejects -> back to the builder, no deploy.
  if (verdict.decision === "reject") {
    return { decision: "reject", reason: verdict.rationale || "below the owner's standards", confidence, blast_radius: blast, source: "persona" };
  }

  // 4. Auto-approve only when the persona is confident AND the blast radius is
  //    bounded. Everything else (low confidence, high blast, an explicit
  //    "escalate") is held for the human.
  if (verdict.decision === "approve" && confidence >= threshold && blast !== "high") {
    return { decision: "approve", reason: verdict.rationale || "matches intent and owner values", confidence, blast_radius: blast, source: "persona" };
  }

  return {
    decision: "escalate",
    reason: verdict.rationale
      ? `held for owner (${verdict.decision}, conf ${confidence}, blast ${blast}): ${verdict.rationale}`
      : `held for owner (conf ${confidence} < ${threshold} or blast ${blast})`,
    confidence,
    blast_radius: blast,
    source: "persona",
  };
}

// Ask the persona-backed agent for a structured verdict. Best-effort: returns
// null on any failure (missing CLI, non-zero exit, unparsable output) so the
// caller's decide() floor turns that into a safe escalate.
async function askPersona(card: string, spec: string): Promise<PersonaVerdict | null> {
  const prompt = [
    "You are the project owner, deciding whether to auto-deploy a change that a",
    "reviewer has already signed off and whose health gate is green. Decide AS the",
    "owner described in .claude/persona.md — apply their values and their escalation rules.",
    "",
    `Task that was built: ${spec}`,
    "",
    "Inspect the staged git diff and the codebase, then judge: should this ship to",
    "production right now WITHOUT waking the owner, or should it wait for a human tap?",
    "Be conservative — a held deploy is cheap; a wrong autonomous deploy is not.",
    "",
    "Output ONLY a raw JSON object (no markdown fences, no prose) with exactly these keys:",
    '  - "decision": "approve" | "escalate" | "reject"',
    "        approve  = safe to auto-deploy as me",
    "        escalate = ship-worthy but I want to see it first (tap to approve)",
    "        reject   = does not meet my standards, send back to the builder",
    '  - "confidence": a number 0..1 (how sure you are this matches my intent and values)',
    '  - "blast_radius": "low" | "medium" | "high"',
    '  - "rationale": one sentence, why',
    "",
    'Example: {"decision":"approve","confidence":0.9,"blast_radius":"low","rationale":"isolated UI copy change, matches DESIGN.md"}',
  ].join("\n");

  const first = await invokeClaude(prompt);
  if (first.code !== 0) return null;
  let parsed = parseStructured<PersonaVerdict>(first.out, VERDICT_SCHEMA);
  if (parsed.ok) return parsed.value;

  // Format-feedback retry: tell the model exactly what failed validation and ask
  // for corrected JSON, once. Most malformed verdicts fix themselves here.
  const second = await invokeClaude(retryPrompt(prompt, parsed.errors, first.out));
  if (second.code !== 0) return null;
  parsed = parseStructured<PersonaVerdict>(second.out, VERDICT_SCHEMA);
  return parsed.ok ? parsed.value : null;
}

// Drive the persona-injecting Claude wrapper once; collect stdout+stderr.
async function invokeClaude(prompt: string) {
  const invokeScript = resolve(HERE, "..", "invoke-claude.ts");
  const child = spawn(process.execPath, [invokeScript, prompt], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.stderr.on("data", (d) => { out += d.toString(); });
  const code = await new Promise((res) => child.on("exit", res));
  return { code, out };
}

/**
 * The auto-approve threshold. If costs are configured, derive it from decision
 * theory (tau* = 1 - C_ask/C_bad); otherwise use the explicit/env threshold.
 */
export function effectiveThreshold(threshold?: number): number {
  if (process.env.PERSONA_COST_BAD) {
    return optimalThreshold({
      C_ask: Number(process.env.PERSONA_COST_ASK) || 1,
      C_bad: Number(process.env.PERSONA_COST_BAD),
    });
  }
  return Number(threshold ?? process.env.PERSONA_APPROVE_THRESHOLD) || 0.8;
}

/**
 * Run the persona approval gate for a reviewed card.
 * @param {{card:string, spec:string, threshold?:number, dry?:boolean, risk?:object, reviewerVerdict?:object}} opts
 * @returns {Promise<{decision:string, reason:string, confidence:number, blast_radius:string, source:string}>}
 */
export async function personaApprove({ card, spec, threshold, dry = false, risk = null, reviewerVerdict = null }: {
  card: string;
  spec: string;
  threshold?: number;
  dry?: boolean;
  risk?: RiskScore | null;
  reviewerVerdict?: PersonaVerdict | null;
}): Promise<Decision> {
  if (process.env.PERSONA_APPROVE === "off") {
    return { decision: "approve", reason: "persona gate disabled (PERSONA_APPROVE=off)", confidence: 1, blast_radius: "low", source: "disabled" };
  }
  const bar = effectiveThreshold(threshold);
  const params = loadParams();

  // Short-circuit before spending a model call: a sensitive spec — or a diff the
  // framein risk score flagged "high" — escalates no matter what the model says.
  if (classifySensitive(spec).length || risk?.level === "high") {
    const v = decide({ verdict: null, spec, threshold: bar, risk });
    try { recordPrediction({ card, spec, features: { sensitive: classifySensitive(spec) }, predicted: { decision: v.decision, confidence: 0 } }); } catch {}
    try { await log("approve", { card, actor: "persona", detail: v }); } catch {}
    return v;
  }

  // Reuse the independent reviewer's structured owner recommendation instead of
  // opening a second full-context model session. The fallback preserves direct
  // CLI use and checkpoints created before reviewerVerdict existed.
  const raw = reviewerVerdict || (dry ? null : await askPersona(card, spec));
  // Calibrate the model's raw confidence into a real P(you approve) before the
  // decision floor sees it. The raw value is still what we PERSIST, so the
  // calibrator can refit on it later.
  const verdict = raw
    ? { ...raw, confidence: calibrate(raw.confidence ?? 0, params) }
    : null;
  const result = decide({ verdict, spec, threshold: bar, risk });

  try {
    recordPrediction({
      card, spec,
      features: { blast_radius: raw?.blast_radius, sensitive: [] },
      predicted: { decision: result.decision, confidence: raw?.confidence, calibrated: verdict?.confidence },
    });
  } catch {}
  try { await log("approve", { card, actor: "persona", detail: { ...result, threshold: bar, calibrated: params.fitted } }); } catch {}
  return result;
}

// CLI: `node scripts/loop/persona-approve.ts <card> "<spec>"`
// Prints the verdict JSON and exits 0=approve, 10=escalate, 11=reject.
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
  const [card, ...rest] = process.argv.slice(2);
  const spec = rest.join(" ").trim();
  if (!card || !spec) {
    console.error('usage: persona-approve.ts <card> "<spec>"');
    process.exit(2);
  }
  const v = await personaApprove({ card, spec });
  console.log(JSON.stringify(v, null, 2));
  process.exit(v.decision === "approve" ? 0 : v.decision === "escalate" ? 10 : 11);
}
