#!/usr/bin/env node
// routing-report.ts — which model is doing what, in one place.
//
// The answer was spread across four modules that each own a different question:
// the builder roster and the audit lanes in ralph-loop, the reviewer default
// beside them, and the recurring-job table in lanes. So "who is assigned to what
// right now, and can they take it" had no single answer — you read four files and
// held the picture in your head.
//
// This composes them for reading and decides nothing. Every value still comes
// from the module that owns it.
//
// It lives in its own file rather than inside lanes.ts for a concrete reason:
// lanes.ts is imported by the six recurring jobs, and ralph-loop imports those.
// Reading the roster from lanes would close a cycle — and with a top-level await
// in it, the cycle does not merely warn, it deadlocks (Node exits 13, "unsettled
// top-level await"). Nothing imports this file, so composing here is safe.
//
// Usage: node scripts/loop/routing-report.ts [--json]

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RECURRING_JOBS, laneFor } from "./lanes.ts";

export interface RoutingReport {
  recurring: Array<{ job: string; lane: string }>;
  execution: { builders: string[]; auditors: string[]; reviewer: string } | null;
  cooldowns: Record<string, { until: number; reason?: string; at?: number }>;
}

export async function routingReport(env: NodeJS.ProcessEnv = process.env): Promise<RoutingReport> {
  const recurring = RECURRING_JOBS.map((job) => ({ job, lane: laneFor(job, env) }));

  let execution = null;
  try {
    const ralph = await import("./ralph-loop.ts");
    execution = {
      // ralph-loop is still untyped JS, so agentKeyFor widens through the
      // regex-match path. Normalize at the boundary rather than trusting it.
      builders: ralph.builderRoster(env).map((cmd) => String(ralph.agentKeyFor(cmd))),
      auditors: ralph.auditAgents(),
      reviewer: env.LOOP_REVIEWER ? "LOOP_REVIEWER (custom)" : "claude",
    };
  } catch {
    // Reading the roster is a convenience; a partial checkout must not break the report.
  }

  let cooldowns: RoutingReport["cooldowns"] = {};
  try {
    const { activeCooldowns } = await import("./cooldown.ts");
    cooldowns = activeCooldowns();
  } catch {}

  return { recurring, execution, cooldowns };
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const report = await routingReport();

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const cooling = new Set(Object.keys(report.cooldowns));
    // agy is the lane name; antigravity is the agent key cooldown records under.
    const mark = (lane: string) =>
      cooling.has(lane) || (lane === "agy" && cooling.has("antigravity")) ? "   (cooling down)" : "";

    console.log("recurring jobs — timer-driven (HARNESS_RECURRING_LANE, HARNESS_LANE_<JOB>)");
    for (const { job, lane } of report.recurring) {
      console.log(`  ${job.padEnd(12)} → ${lane}${mark(lane)}`);
    }

    if (report.execution) {
      console.log("\nexecution (LOOP_BUILDERS, LOOP_AUDITORS, LOOP_REVIEWER)");
      console.log(`  builders     → ${report.execution.builders.join(" → ")}`);
      console.log(`  auditors     → ${report.execution.auditors.join(", ")}`);
      console.log(`  reviewer     → ${report.execution.reviewer}`);
      console.log("                 a gate decision — never routed through the recurring table");
    }

    const names = Object.keys(report.cooldowns);
    console.log(`\ncooldowns: ${names.length
      ? names.map((a) => `${a} until ${new Date(report.cooldowns[a]?.until ?? 0).toLocaleTimeString()}`).join(", ")
      : "none"}`);
  }
  // ralph-loop's import graph keeps handles open (telemetry/sqlite); this is a
  // report, so end when the report ends rather than waiting them out.
  process.exit(0);
}
