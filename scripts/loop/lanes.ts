// lanes.ts — which CLI lane a RECURRING job runs on.
//
// The loop's cost is not dominated by the work a human asked for. It is dominated
// by the jobs that run on a timer whether or not anything happened: the idle
// audit, the market scan, prompt triage, pain-point scouting, the session radar,
// persona synthesis. Those ran on whichever lane each script happened to hardcode,
// with no way to move them without editing five files.
//
// This is that lever, and deliberately nothing more. It is NOT a fifth router:
// agent-session still owns failover (fallbackRoster), cooldown still owns rate
// limits, and agent-policy still owns trust domains. All this decides is which
// lane a recurring job ASKS for first.
//
// What must never come through here
// ---------------------------------
// Gate decisions. The reviewer's verdict and the persona deploy gate stay on
// their own lane on purpose: AGENTS.md requires the reviewer to be a different
// provider than the builder (Anti-False Consensus), and routing both through one
// cheap lane collapses that into a model agreeing with itself. Cheapness is not
// a reason to let a build approve itself.

/**
 * Default lane per recurring job.
 *
 * agy leads because these jobs are long-context reading — auditing a workspace,
 * summarizing a session, triaging a backlog of prompts — which is what that lane
 * is for, and because it keeps the metered lanes for work a human is waiting on.
 * A lane that is down or rate-limited is not a dead end: agent-session falls
 * through its roster from here, with Claude last.
 */
export const RECURRING_LANES = {
  assessment: "agy",   // idle shortcomings audit (~24h)
  market: "agy",       // market scan, once per factory cycle
  prompts: "agy",      // prompt → card triage
  painPoints: "agy",   // pain-point scout on idle transition
  radar: "agy",        // session-start harness radar
  persona: "agy",      // persona synthesis from accumulated verdicts
};

/**
 * The lane whose quota is not being rationed.
 *
 * Several things in this loop were optional purely because they cost a second
 * opinion: the cross-model challenge on a normal card, an architect pass in
 * front of a builder. "Is it worth another call" is a question about the
 * SUBSCRIPTION, not about the code, and the answer differs per operator — so it
 * is stated here once instead of being re-litigated at each call site.
 *
 * When the work would land on this lane, those features default ON. When it
 * would land anywhere else they stay opt-in, because then the second call is
 * really being paid for.
 *
 * What this must NEVER do is soften independence. A bulk lane may not verify its
 * own work: every caller still asks agent-policy whether the two agents are
 * distinct, and a bulk lane that authored the diff is disqualified from checking
 * it like any other author.
 */
export function bulkLane(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.HARNESS_BULK_LANE ?? "antigravity").trim().toLowerCase();
}

/** Is this the lane whose quota the operator is not rationing? */
export function isBulkLane(agent: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const lane = bulkLane(env);
  if (!lane || lane === "none") return false;
  const key = String(agent || "").toLowerCase();
  // "agy" and "antigravity" are the same subscription under two spellings.
  const alias = (a: string) => (a === "agy" ? "antigravity" : a);
  return alias(key) === alias(lane);
}

/** A timer-driven job this module assigns a lane to. */
export type RecurringJob = keyof typeof RECURRING_LANES;

/** Every job name this module knows. Exported so a test can assert the call sites match. */
export const RECURRING_JOBS = Object.keys(RECURRING_LANES) as RecurringJob[];

const envKey = (job: string) => `HARNESS_LANE_${job.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;

/**
 * The lane a recurring job should ask for.
 *
 * Overrides, most specific first:
 *   HARNESS_LANE_<JOB>       one job          (e.g. HARNESS_LANE_PAIN_POINTS=codex)
 *   HARNESS_RECURRING_LANE   all of them
 *
 * An unknown job name throws rather than defaulting: a typo that silently picks
 * a lane is exactly the kind of quiet drift this module exists to end.
 */
export function laneFor(job: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!Object.hasOwn(RECURRING_LANES, job)) {
    throw new Error(`unknown recurring job "${job}" (known: ${RECURRING_JOBS.join(", ")})`);
  }
  const specific = env[envKey(job)];
  if (specific) return specific.trim();
  const all = env.HARNESS_RECURRING_LANE;
  if (all) return all.trim();
  return RECURRING_LANES[job as RecurringJob];
}

/** The argv a recurring job passes to agent-session: `--agent <lane>`. */
export function laneArgs(job: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return ["--agent", laneFor(job, env)];
}
