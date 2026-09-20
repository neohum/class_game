// release-policy.ts — deterministic environment promotion plan.

import { completionCheck, type CompletionCheck } from "./lifecycle.ts";

export function releaseStages(env = process.env) {
  if (env.RELEASE_PIPELINE !== "staging-canary-production") {
    return [{
      name: "production",
      environment: env.RAILWAY_PRODUCTION_ENVIRONMENT || "production",
      tokenEnv: "RAILWAY_TOKEN",
      healthUrl: env.FACTORY_HEALTH_URL || "",
    }];
  }
  return [
    {
      name: "staging",
      environment: env.RAILWAY_STAGING_ENVIRONMENT || "staging",
      tokenEnv: "RAILWAY_STAGING_TOKEN",
      healthUrl: env.STAGING_HEALTH_URL || "",
    },
    {
      name: "canary",
      environment: env.RAILWAY_CANARY_ENVIRONMENT || "canary",
      tokenEnv: "RAILWAY_CANARY_TOKEN",
      healthUrl: env.CANARY_HEALTH_URL || "",
    },
    {
      name: "production",
      environment: env.RAILWAY_PRODUCTION_ENVIRONMENT || "production",
      tokenEnv: "RAILWAY_TOKEN",
      healthUrl: env.FACTORY_HEALTH_URL || "",
    },
  ];
}

/** One promotion step: deploy this environment, then verify it before the next. */
export interface ReleaseStage {
  name: string;
  environment: string;
  tokenEnv: string;
  healthUrl: string;
}

export interface StageOutcome {
  ok: boolean;
  evidence?: string;
  owner?: string;
  observedAt?: string;
  approver?: string | null;
  blockedReason?: string | null;
}

export type ReleasePhase = "deploy" | "verify" | "regression";

export interface ReleaseCheck extends CompletionCheck {
  stage: string;
  phase: ReleasePhase;
}

export interface ReleaseResult {
  ok: boolean;
  stage?: string;
  phase?: ReleasePhase | "evidence";
  stages?: string[];
  checks: ReleaseCheck[];
}

export async function runReleaseStages(
  stages: ReleaseStage[],
  { deploy, verify, regress, onCheck }: {
    deploy: (stage: ReleaseStage) => Promise<StageOutcome | undefined>;
    verify: (stage: ReleaseStage) => Promise<StageOutcome | undefined>;
    regress: (stage: ReleaseStage) => Promise<StageOutcome | undefined>;
    onCheck?: (check: ReleaseCheck) => Promise<void> | void;
  },
): Promise<ReleaseResult> {
  const checks: ReleaseCheck[] = [];
  const runGate = async (
    stage: ReleaseStage,
    phase: ReleasePhase,
    action: (stage: ReleaseStage) => Promise<StageOutcome | undefined>,
  ): Promise<{ ok: boolean; reason?: "gate" | "evidence" }> => {
    const outcome = await action(stage);
    const evidence = String(outcome?.evidence || "").trim();
    const gatePassed = outcome?.ok === true;
    const evidencePassed = evidence.length > 0;
    const item: ReleaseCheck = {
      ...completionCheck({
        id: `${stage.name}-${phase}`,
        label: `${stage.name} ${phase}`,
        status: gatePassed && evidencePassed ? "passed" : "blocked",
        owner: outcome?.owner || (phase === "deploy" ? "release" : "verification"),
        observedAt: outcome?.observedAt || new Date().toISOString(),
        evidence: evidence || "evidence:missing",
        approver: outcome?.approver || null,
        blockedReason: gatePassed && evidencePassed
          ? null
          : outcome?.blockedReason || (gatePassed ? `${phase} evidence is required` : `${phase} failed`),
      }),
      stage: stage.name,
      phase,
    };
    checks.push(item);
    await onCheck?.(item);
    return { ok: item.status === "passed", reason: gatePassed ? "evidence" : "gate" };
  };

  for (const stage of stages) {
    const deployed = await runGate(stage, "deploy", deploy);
    if (!deployed.ok) return { ok: false, stage: stage.name, phase: deployed.reason === "evidence" ? "evidence" : "deploy", checks };
    const verified = await runGate(stage, "verify", verify);
    if (!verified.ok) return { ok: false, stage: stage.name, phase: verified.reason === "evidence" ? "evidence" : "verify", checks };
    if (stage.name === "staging" || stage.name === "production") {
      const regressed = await runGate(stage, "regression", regress);
      if (!regressed.ok) return { ok: false, stage: stage.name, phase: regressed.reason === "evidence" ? "evidence" : "regression", checks };
    }
  }
  return { ok: true, stages: stages.map((stage) => stage.name), checks };
}

const HEALTH_ENV: Record<string, string> = {
  staging: "STAGING_HEALTH_URL",
  canary: "CANARY_HEALTH_URL",
  production: "FACTORY_HEALTH_URL",
};

export function validateReleaseConfig(
  stages: ReleaseStage[],
  env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const stage of stages) {
    if (!env[stage.tokenEnv]) missing.push(stage.tokenEnv);
    const healthEnv = HEALTH_ENV[stage.name];
    if (!stage.healthUrl && healthEnv && !env[healthEnv]) missing.push(healthEnv);
  }
  return { ok: missing.length === 0, missing };
}
