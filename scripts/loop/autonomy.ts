// autonomy.ts — how much the loop may decide on its own, and what it may never
// switch off while deciding it.
//
// The harness runs at three tiers. They are not a setting; they are a
// classification of the WORK, and each one is already enforced somewhere else in
// the loop. This module exists for the one property none of those places could
// state on its own.
//
//   Tier 1 — decide alone.
//     Reversible work inside a per-card worktree, under the iteration cap, the
//     command timeout, the health gate and the spend ceiling. No human, no
//     second model. Enforced by graph.ts (maxSteps), ralph-loop (maxIters),
//     budget.ts and worktree.ts.
//
//   Tier 2 — a different provider must agree.
//     Nothing ships on one model's word. pickReviewer() returns null rather than
//     hand a card back to the agent that built it, and nodeReview yields the card
//     instead of proceeding — a builder cannot sign off its own work even when it
//     is the only agent left. Enforced by agent-policy.ts + ralph-loop.
//
//   Tier 3 — a human taps.
//     Irreversible, outward-facing, or cost-asymmetric: production deploys,
//     secrets, migrations, billing, auth. framein's path-risk score and
//     persona-approve's sensitive-area floor route these to the owner regardless
//     of model confidence.
//
// What was missing is the invariant ACROSS the tiers: several of those guards
// carry an escape hatch that is perfectly reasonable for a human at a terminal —
// `HARNESS_SANDBOX_MODE=host` to skip Docker while debugging,
// `FRAMEIN_RISK=off` to stop path scoring from nagging during a refactor. A
// human who exports one is present to watch what it does. The 24/7 factory that
// inherits it from a shell profile is not, and it will keep using it for weeks.
//
// So: an unattended run declares itself, and a declared run cannot pick up a
// safety opt-out by accident. The two are handled differently, on purpose:
//
//   FRAMEIN_RISK=off   ignored, and the refusal is logged as a `guard` event.
//                      The guard simply stays on; nothing is lost by continuing.
//   SANDBOX host       refused unless HARNESS_UNATTENDED_ALLOW_HOST=1 says so
//                      explicitly. Every other guard failing lets a bad diff
//                      through and a later gate can still catch it; this one
//                      lets the agent out of the box, and nothing catches that.
//
// Neither is ever silently downgraded — a guard that quietly turns itself back
// on is as hard to reason about as one that quietly turns off.

/** Set by the unattended entry points (ralph-loop, factory) on themselves. */
export const UNATTENDED_ENV = "HARNESS_UNATTENDED";

/**
 * The one acknowledgement that lets an unattended run leave the sandbox.
 *
 * A first attempt at this refused host execution outright and broke the loop's
 * own end-to-end tests — which was the design telling the truth: running the
 * loop on a host is legitimate (no Docker on the box, a dedicated trusted
 * machine), so "never" was wrong. What must be impossible is doing it by
 * ACCIDENT. `HARNESS_ALLOW_HOST_EXEC=1` is the documented local-dev switch and
 * plausibly lives in a shell profile forever; this variable means nothing except
 * "yes, the unattended loop runs unsandboxed", so nobody sets it by habit.
 */
export const UNATTENDED_HOST_ACK_ENV = "HARNESS_UNATTENDED_ALLOW_HOST";

export function unattendedHostAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env[UNATTENDED_HOST_ACK_ENV] ?? "") === "1";
}

type Env = NodeJS.ProcessEnv;

/**
 * Declare this process — and everything it spawns — an unattended run.
 *
 * Called from the `isMainModule` block of the long-running entry points, not
 * from a library function: "am I unattended" is a fact about how the process was
 * started, and inferring it (a TTY check, a parent-process guess) gets it wrong
 * in both directions — a human piping output is still a human, and a factory
 * with a PTY is still a factory.
 */
export function markUnattended(env: Env = process.env): void {
  env[UNATTENDED_ENV] = "1";
}

export function isUnattended(env: Env = process.env): boolean {
  return String(env[UNATTENDED_ENV] ?? "") === "1";
}

/** A safety opt-out an unattended run is not allowed to honour. */
export interface OptOut {
  /** env var the human set, e.g. "FRAMEIN_RISK" */
  name: string;
  /** what it would have disabled, for the log line */
  disables: string;
}

/**
 * Is this opt-out usable right now?
 *
 * Returns null when it may be honoured, or a human-readable refusal when it may
 * not. The caller logs the refusal and proceeds with the guard ON — the point is
 * that the guard stays on, not that the run dies.
 */
export function optOutRefusal(optOut: OptOut, env: Env = process.env): string | null {
  if (!isUnattended(env)) return null;
  return `${optOut.name} ignored: an unattended run may not disable ${optOut.disables}. `
    + `Unset ${UNATTENDED_ENV} and run it yourself if you need that.`;
}

/**
 * The opt-outs this rule governs. Adding a new one means adding it here too.
 *
 * Typed by its keys rather than as Record<string, OptOut>: an index signature
 * makes every lookup `OptOut | undefined`, and a guard that has to be
 * null-checked at each call site is one `?.` away from being skipped.
 */
export const GOVERNED_OPT_OUTS: { sandbox: OptOut; risk: OptOut; plan: OptOut } = {
  sandbox: { name: "HARNESS_SANDBOX_MODE=host", disables: "the sandbox boundary" },
  // risk is logged-and-ignored; sandbox is refused unless acknowledged. See sandbox.ts.
  risk: { name: "FRAMEIN_RISK=off", disables: "the path-based risk floor on the deploy gate" },
  // Same treatment as risk: logged and ignored, the gate stays on. A human at a
  // terminal can reasonably build a risky card straight from a card spec because
  // they are the plan; an unattended run has nobody to be it. See plan-gate.ts.
  plan: { name: "HARNESS_PLAN_GATE=off", disables: "the approved-plan requirement before a risky build" },
};
