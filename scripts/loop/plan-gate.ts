// plan-gate.ts — no approved plan, no risky build.
//
// The loop has always been able to start building from a one-line card. That is
// right for a chore and wrong for a feature: the builder invents the design at
// the same moment it writes the code, so the first artifact anyone can review is
// the diff — after the money was spent. This gate moves that decision earlier by
// requiring the artifact the design already implies: an APPROVED plan document
// (plan-doc.ts) that names this card, its files and its acceptance evidence.
//
// It is deliberately proportional, because a gate that fires on everything gets
// switched off:
//
//   mode=risk (default)  a card declaring Risk: medium|high needs a plan
//   mode=strict          every card needs one
//   mode=off             nothing does — interactive only. An unattended run may
//                        not honour it (autonomy.ts), because the 24/7 factory
//                        inherits an operator's env var for weeks.
//
// Usage:
//   node scripts/loop/plan-gate.ts <card>        # exit 0 allowed, 1 blocked
//   import { planGateDecision } from "./plan-gate.ts"

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GOVERNED_OPT_OUTS, optOutRefusal } from "./autonomy.ts";
import { planConfig, planForCard, riskRank, specRisk, validatePlanDoc, type PlanConfig, type PlanDoc } from "./plan-doc.ts";
import { getBacklog } from "./backlog.ts";

export interface PlanGateDecision {
  allow: boolean;
  /** Why — printed to the operator and fed back to the lead as card feedback. */
  reason: string;
  /** The mode actually applied, after an unattended run's opt-out was refused. */
  mode: string;
  /** Set when `mode=off` was ignored; the caller logs it as a `guard` event. */
  refusal?: string;
}

/**
 * Decide whether this card may be built.
 *
 * Pure: the plan document and the config are passed in, so the rule is testable
 * without a checkout and the caller owns the disk read.
 */
export function planGateDecision({ card, spec = "", plan = null, cfg, env = process.env }: {
  card: string;
  spec?: string;
  plan?: PlanDoc | null;
  cfg: PlanConfig;
  env?: NodeJS.ProcessEnv;
}): PlanGateDecision {
  let mode = String(cfg.gate.mode || "risk").toLowerCase();
  let refusal: string | undefined;

  if (mode === "off") {
    const denied = optOutRefusal(GOVERNED_OPT_OUTS.plan, env);
    if (denied) {
      // The guard stays ON rather than the run dying: same contract as the other
      // governed opt-outs. `risk` is the floor it falls back to, not `strict` —
      // refusing an opt-out should restore the default, not escalate past it.
      refusal = denied;
      mode = "risk";
    } else {
      return { allow: true, reason: "plan gate off (interactive run)", mode: "off" };
    }
  }

  const risk = specRisk(spec) || plan?.risk || "";
  const required = mode === "strict" || riskRank(risk) >= riskRank("medium");
  const base = { mode, ...(refusal ? { refusal } : {}) };

  if (!required) {
    return { ...base, allow: true, reason: `no plan required (mode=${mode}, risk=${risk || "low"})` };
  }
  if (!plan) {
    return {
      ...base,
      allow: false,
      reason: `no plan document declares ${card}. Write one first: `
        + `node scripts/loop/plan-doc.ts init <slug> — declare Files, Acceptance and Tests for this card, `
        + `set status: approved, then re-queue. (mode=${mode}, risk=${risk || "unset"})`,
    };
  }
  if (plan.status !== "approved") {
    return { ...base, allow: false, reason: `plan ${plan.slug} is status: ${plan.status} — an approved plan is required before building ${card}` };
  }
  const errors = validatePlanDoc(plan);
  if (errors.length) {
    return { ...base, allow: false, reason: `plan ${plan.slug} does not validate: ${errors.slice(0, 3).join("; ")}` };
  }
  if (riskRank(plan.risk || risk) >= riskRank(cfg.gate.ownerRequiredAtRisk) && !plan.owner) {
    return { ...base, allow: false, reason: `plan ${plan.slug} is ${plan.risk || risk} risk and has no \`owner:\` — a human approves this tier, not a model` };
  }
  const step = plan.steps.find((s) => s.card === card);
  return {
    ...base,
    allow: true,
    reason: `plan ${plan.slug} approved by ${plan.owner || "project"}${step?.files.length ? `; blast radius: ${step.files.join(", ")}` : ""}`,
  };
}

/** Same decision, reading the plan document from disk. */
export function checkCard(card: string, spec: string, cwd = process.cwd(), env = process.env): PlanGateDecision {
  const cfg = planConfig(cwd, env);
  return planGateDecision({ card, spec, plan: planForCard(card, cwd, cfg), cfg, env });
}

// CLI
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const card = process.argv[2];
  if (!card) { console.error("usage: plan-gate.ts <card>"); process.exit(2); }
  const backlog = await getBacklog();
  const spec = backlog.get(card)?.spec ?? "";
  const decision = checkCard(card, spec);
  if (decision.refusal) console.error(`[guard] ${decision.refusal}`);
  console.log(`${decision.allow ? "allow" : "BLOCK"} ${card}: ${decision.reason}`);
  if (!decision.allow) process.exitCode = 1;
}
