// card-pipeline-tobe — the TO-BE card pipeline. Same graph, same gates, same
// bounds as the as-is `card-pipeline.mjs`, plus the senior playbooks wired into
// every stage and one extra read-only gate:
//
//   validate ─▶ explore ─▶ build ─▶ strictHealth ─▶ challenge ─▶ review ─▶ verify ─▶ END
//   (plan-first) (repo-recon) │ ▲  (tdd-loop /       │            │  (self-  │ (verify-
//                             └─┘   debug-protocol /  │            ▼   review) │  done)
//                          retry ≤ maxIters           │          build ◀───────┘
//                          (cap ⇒ escalate)           └─▶ END    (revise / missing
//                                               (high-risk BLOCK) evidence, same budget)
//
// Playbooks per stage (agents READ the SKILL.md before acting):
//   validate  plan-first      .claude/skills/plan-first/SKILL.md   (lead/validator lane)
//   explore   repo-recon      .agents/skills/repo-recon/SKILL.md   (explorer lane)
//   build     tdd-loop        .agents/skills/tdd-loop/SKILL.md     (builder lane)
//             debug-protocol  .agents/skills/debug-protocol/SKILL.md  (red gate)
//             safe-refactor   .agents/skills/safe-refactor/SKILL.md   (restructuring cards)
//   review    self-review     .claude/skills/self-review/SKILL.md  (reviewer lane)
//   verify    verify-done     .claude/skills/verify-done/SKILL.md  (evidence gate)
//   ship      git-hygiene     .claude/skills/git-hygiene/SKILL.md  (outside this workflow)
//
// Invoke for ONE card:  Workflow({ name: 'card-pipeline-tobe',
//                                  args: { card: 'fix-login', spec: '...' } })
// args may also be a bare spec string. Optional args.maxIters (default 6,
// matching LOOP_MAX_ITERS; hard-capped at 12).
//
// Loop-safety guarantees carried over from the as-is pipeline — do not weaken:
//   - bounded iteration: on the cap the card ESCALATES, it never loops forever;
//     the verify-done gate rejects into the SAME budget, it adds none
//   - the health gate runs after every build; the strict full gate must be
//     green before review, and a strict failure fails the card (no retry)
//   - the challenge is adversarial and independent of the builder; a high-risk
//     BLOCK ends the card before review — never shipped
//   - the reviewer and the verify-done gate are read-only and independent —
//     a builder never self-approves
//   - NO ship node: commit/push/deploy stays with ralph-loop's persona deploy
//     gate (autonomous mode) or with the human (interactive mode)

export const meta = {
  name: 'card-pipeline-tobe',
  description: 'Run one task card through the to-be pipeline: as-is order and gates + senior playbooks per stage + a verify-done evidence gate',
  whenToUse: 'Interactive single-card run with the same order, gates, and bounds as card-pipeline, but each stage works by its senior playbook (plan-first, repo-recon, tdd-loop, debug-protocol, safe-refactor, self-review) and approval is gated on verify-done evidence. Pass { card, spec } (or a bare spec string) via args. Never commits, pushes, or deploys.',
  phases: [
    { title: 'Validate', detail: 'validator sharpens the acceptance criterion by plan-first; adversary may stop the card' },
    { title: 'Explore', detail: 'read-only repo-recon map of the code the card touches' },
    { title: 'Build', detail: 'builder iterates by tdd-loop under the health gate, hard-capped; debug-protocol on red' },
    { title: 'Review', detail: 'independent adversarial challenge, then read-only self-review verdict' },
    { title: 'Verify', detail: 'verify-done evidence gate — no "ready" without build/test/run evidence' },
  ],
}

const SKILL = {
  planFirst: '.claude/skills/plan-first/SKILL.md',
  repoRecon: '.agents/skills/repo-recon/SKILL.md',
  tddLoop: '.agents/skills/tdd-loop/SKILL.md',
  debugProtocol: '.agents/skills/debug-protocol/SKILL.md',
  safeRefactor: '.agents/skills/safe-refactor/SKILL.md',
  selfReview: '.claude/skills/self-review/SKILL.md',
  verifyDone: '.claude/skills/verify-done/SKILL.md',
  gitHygiene: '.claude/skills/git-hygiene/SKILL.md',
}

const spec = typeof args === 'string' ? args.trim() : String(args?.spec ?? '').trim()
if (!spec) throw new Error('card-pipeline-tobe: pass the card spec via args — a bare string, or { card, spec, maxIters }')
const card = (args && typeof args === 'object' && args.card) ? String(args.card) : 'interactive-card'
const rawIters = Number(args && typeof args === 'object' ? args.maxIters : NaN)
// Same default as LOOP_MAX_ITERS. The cap is a safety net, not a tuning knob.
const MAX_ITERS = Number.isFinite(rawIters) && rawIters >= 1 ? Math.min(Math.floor(rawIters), 12) : 6

const HEALTH_CMD =
  'the health gate: `bash scripts/loop/health.sh` on POSIX, ' +
  '`powershell -ExecutionPolicy Bypass -File scripts/loop/health.ps1` on Windows'

const VALIDATE_SCHEMA = {
  type: 'object',
  required: ['verdict', 'acceptance'],
  properties: {
    verdict: { enum: ['go', 'sharpen', 'drop'] },
    acceptance: { type: 'string', description: 'the testable acceptance criterion the builder must satisfy' },
    plan: {
      type: 'object',
      description: 'plan-first one-pager — required when the card is big or risky',
      properties: {
        goal: { type: 'string' },
        nonGoals: { type: 'array', items: { type: 'string' } },
        steps: { type: 'array', items: { type: 'string' } },
        rollback: { type: 'string' },
      },
    },
    notes: { type: 'string' },
  },
}
const ADVERSARY_SCHEMA = {
  type: 'object',
  required: ['verdict', 'reasons'],
  properties: {
    verdict: { enum: ['proceed', 'hold'] },
    reasons: { type: 'array', items: { type: 'string' } },
  },
}
const BUILD_SCHEMA = {
  type: 'object',
  required: ['green', 'summary'],
  properties: {
    green: { type: 'boolean', description: 'true ONLY when the health gate exited 0' },
    summary: { type: 'string' },
    healthTail: { type: 'string', description: 'tail of the health gate output when red' },
  },
}
const STRICT_SCHEMA = {
  type: 'object',
  required: ['green'],
  properties: { green: { type: 'boolean' }, detail: { type: 'string' } },
}
const CHALLENGE_SCHEMA = {
  type: 'object',
  required: ['verdict', 'risk', 'brief'],
  properties: {
    verdict: { enum: ['PASS', 'CONCERN', 'BLOCK'] },
    risk: { enum: ['low', 'medium', 'high'] },
    brief: { type: 'string' },
  },
}
// Mirrors REVIEW_SCHEMA in ralph-loop.ts.
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['decision', 'rationale', 'blocking_issues'],
  properties: {
    decision: { enum: ['approve', 'revise'] },
    rationale: { type: 'string', minLength: 1 },
    blocking_issues: { type: 'array', items: { type: 'string' } },
  },
}
const VERIFY_SCHEMA = {
  type: 'object',
  required: ['verified', 'evidence'],
  properties: {
    verified: { type: 'boolean', description: 'true ONLY when every evidence item was actually observed, not assumed' },
    evidence: { type: 'string', description: 'what was run and what it showed (commands + outcomes)' },
    missing: { type: 'array', items: { type: 'string' }, description: 'evidence items that could not be produced' },
  },
}

// --- Validate (plan-first: sharpen and plan before anything is built) ---------
phase('Validate')
log(`card "${card}" — validating before building (budget: ${MAX_ITERS} iterations)`)

// Barrier on purpose: the queue decision needs BOTH gate verdicts together.
const [validation, adversary] = await parallel([
  () => agent(
    `You are the validator gate for task card "${card}".\n\n` +
    `Read the plan-first playbook at ${SKILL.planFirst} and follow it.\n\n` +
    `If the loop scripts are present, recall prior cross-project knowledge first ` +
    `(\`node scripts/loop/knowledge.ts recall "<topic>"\`) so we reuse instead of relearn.\n\n` +
    `Sharpen this intent into a testable change with an explicit acceptance criterion.\n\nSpec:\n${spec}\n\n` +
    `When the card is big or risky per the playbook (three-plus files, public APIs, schemas, auth, ` +
    `billing, CI, or genuinely ambiguous), also return the one-page \`plan\`: goal, non-goals, ` +
    `steps, rollback. The builder will treat the plan as part of the frozen contract.\n\n` +
    `Verdict "go" when buildable as specified, "sharpen" when you tightened the criterion ` +
    `(return the tightened one in \`acceptance\`), "drop" only when the card should not be built at all.`,
    { label: 'validator', phase: 'Validate', agentType: 'validator', schema: VALIDATE_SCHEMA },
  ),
  () => agent(
    `You are the adversary gate for task card "${card}" — a structured devil's advocate.\n\n` +
    `Steelman the case AGAINST building this now: irreversibility, scope creep, security exposure, ` +
    `missing prerequisites, "traction" claims without evidence.\n\nSpec:\n${spec}\n\n` +
    `A false "go" costs far more than a false "stop" — verdict "hold" for high-stakes, irreversible, ` +
    `or scope-creep-smelling work, and when uncertain. Otherwise "proceed".`,
    { label: 'adversary', phase: 'Validate', agentType: 'adversary', schema: ADVERSARY_SCHEMA },
  ),
])

if (!validation) throw new Error('card-pipeline-tobe: validator gate returned no verdict')
if (validation.verdict === 'drop') {
  return { outcome: 'dropped', card, reason: validation.notes || validation.acceptance }
}
if (adversary && adversary.verdict === 'hold') {
  return { outcome: 'held', card, reasons: adversary.reasons }
}
const acceptance = validation.acceptance
const plan = validation.plan
  ? [
      `Goal: ${validation.plan.goal || ''}`,
      (validation.plan.nonGoals || []).length ? `Non-goals:\n- ${validation.plan.nonGoals.join('\n- ')}` : '',
      (validation.plan.steps || []).length ? `Steps:\n- ${validation.plan.steps.join('\n- ')}` : '',
      validation.plan.rollback ? `Rollback: ${validation.plan.rollback}` : '',
    ].filter(Boolean).join('\n')
  : ''

// --- Explore (repo-recon: map before touching) --------------------------------
phase('Explore')
const map = await agent(
  `Read-only exploration for task card "${card}". Do NOT edit anything.\n\n` +
  `Read the repo-recon playbook at ${SKILL.repoRecon} and follow it: the repo map first ` +
  `(manifest, build/CI config, layout, install/build/test/lint commands), then the files, ` +
  `modules, and dependencies this change will touch; note the conventions to follow ` +
  `and flag risk paths (auth, secrets, migrations, billing, the AGENTS.md data contract).\n\n` +
  `Spec:\n${spec}\n\nAcceptance criterion:\n${acceptance}\n\n` +
  `Return a concise map the builder can work from, claims cited as path:line.`,
  { label: 'explorer', phase: 'Explore', agentType: 'explorer' },
)

// --- Build ⇄ health ⇄ review ⇄ verify (the bounded cycle) ---------------------
phase('Build')
let iter = 0
let feedback = ''
let outcome = null
let review = null
let challengeBrief = ''
let evidence = ''

while (!outcome) {
  // as-is giveUp: the budget is the contract — escalate, never loop forever.
  if (iter >= MAX_ITERS) { outcome = 'escalate'; break }
  iter++

  const build = await agent(
    [
      `Builder iteration ${iter}/${MAX_ITERS} for task card "${card}".`,
      `Frozen contract — implement exactly this, do not renegotiate the task:\n${spec}`,
      `Acceptance criterion:\n${acceptance}`,
      plan ? `Plan (part of the frozen contract — follow the steps, respect the non-goals):\n${plan}` : '',
      map ? `Code map from the explorer:\n${map}` : '',
      `Work by playbook: for behavior changes and bug fixes follow tdd-loop (${SKILL.tddLoop}) — ` +
      `failing test first, minimal code to green, then tidy; never weaken a test to pass it. ` +
      `For pure restructuring follow safe-refactor (${SKILL.safeRefactor}) — behavior-preserving ` +
      `steps, verified between each.`,
      feedback
        ? `[FEEDBACK] The previous attempt FAILED. Follow debug-protocol (${SKILL.debugProtocol}) — ` +
          `reproduce, form a testable hypothesis, fix the root cause, no guess-and-check. ` +
          `Fix exactly these problems:\n${feedback}`
        : '',
      `Implement the change, then run ${HEALTH_CMD}, and report honestly. ` +
      `Set green=true ONLY if the gate exited 0. Never claim green to escape the loop — ` +
      `a gate that fires is the system working, not an obstacle. Do NOT commit or push.`,
    ].filter(Boolean).join('\n\n'),
    { label: `build:${iter}`, phase: 'Build', agentType: 'builder', schema: BUILD_SCHEMA },
  )
  if (!build) { outcome = 'escalate'; break }
  if (!build.green) {
    feedback = [build.summary, build.healthTail].filter(Boolean).join('\n')
    continue
  }

  // strictHealth — iterations may run fast checks; before review the FULL gate
  // must pass. As in the loop, a strict failure fails the card (no retry).
  const strict = await agent(
    `Strict health verification for card "${card}": run the FULL gate with HEALTH_STRICT=1 ` +
    `(POSIX: \`HEALTH_STRICT=1 bash scripts/loop/health.sh\`; ` +
    `Windows: set \`$env:HEALTH_STRICT='1'\` then run scripts/loop/health.ps1). ` +
    `Do NOT edit any files. Report green=true only on exit code 0, with the failing tail in \`detail\` otherwise.`,
    { label: 'strict-health', phase: 'Build', schema: STRICT_SCHEMA },
  )
  if (!strict || !strict.green) {
    outcome = 'failed'
    review = { rationale: 'strict full health check failed before review', detail: strict?.detail || '' }
    break
  }

  // challenge — an independent second pair of eyes tries to refute the diff.
  // (The loop uses a different PROVIDER; here independence comes from a separate
  // subagent. High risk is still held at the deploy gate regardless.)
  const challenge = await agent(
    `Adversarially challenge the working-tree changes for card "${card}" against the frozen contract.\n\n` +
    `You are READ-ONLY — inspect \`git diff\`, do not edit files or mutate the repository.\n\n` +
    `Contract:\n${spec}\n\nAcceptance criterion:\n${acceptance}\n\n` +
    `Try to refute the implementation: missed requirements, hidden regressions, contract violations.\n` +
    `Score path risk "high" when the diff touches auth, secrets, migrations, billing, or the AGENTS.md ` +
    `data contract. Verdict BLOCK means this must not ship; CONCERN passes with notes; PASS is clean.`,
    { label: `challenge:${iter}`, phase: 'Review', schema: CHALLENGE_SCHEMA },
  )
  challengeBrief = challenge?.brief || ''
  if (challenge && challenge.verdict === 'BLOCK' && challenge.risk === 'high') {
    // as-is: a high-risk BLOCK ends the card before review — never shipped.
    outcome = 'blocked'
    review = { rationale: 'cross-check BLOCKED this high-risk change', brief: challengeBrief }
    break
  }

  const verdict = await agent(
    [
      `Review the working-tree changes for task card "${card}" against AGENTS.md, CLAUDE.md, the frozen intent, and the data contract.`,
      `Read the self-review playbook at ${SKILL.selfReview} and apply it: read the full diff as a skeptical senior reviewer, walk the unhappy paths, sweep the changed lines for security issues and leftover debug code.`,
      'You are READ-ONLY. Do not edit files or run commands that mutate the repository.',
      challengeBrief ? `Independent challenge brief:\n${challengeBrief}` : '',
      `Acceptance criterion:\n${acceptance}`,
      'Use decision=approve only when the implementation and tests satisfy the task. Otherwise decision=revise with concrete blocking issues.',
    ].filter(Boolean).join('\n\n'),
    { label: `review:${iter}`, phase: 'Review', agentType: 'reviewer', schema: REVIEW_SCHEMA },
  )
  if (!verdict) { outcome = 'failed'; break }
  review = verdict
  if (verdict.decision !== 'approve') {
    // as-is Dynamic Peer Review loop: back to the builder with the reviewer's
    // feedback, spending the SAME iteration budget.
    feedback = `[REVIEWER FEEDBACK]\n${(verdict.blocking_issues || []).join('\n') || verdict.rationale}`
    log(`reviewer requested revision (iteration ${iter}/${MAX_ITERS})`)
    continue
  }

  // verifyDone — the to-be addition: approval alone is not "ready". A read-only
  // evidence gate confirms the work was actually exercised. Missing evidence
  // rejects into the SAME iteration budget — the gate adds no extra loop.
  const verify = await agent(
    `Evidence gate for task card "${card}". Read the verify-done playbook at ${SKILL.verifyDone} and apply it.\n\n` +
    `You are READ-ONLY on the working tree (running builds/tests/the app is fine; editing files is not).\n\n` +
    `Acceptance criterion:\n${acceptance}\n\n` +
    `Confirm with observed evidence — never assumption: the build runs, the relevant tests pass, ` +
    `and the changed behavior was actually exercised end to end at least once. ` +
    `Report verified=true ONLY when every item was observed, with the commands and outcomes in \`evidence\`; ` +
    `otherwise verified=false with the gaps in \`missing\`.`,
    { label: `verify:${iter}`, phase: 'Verify', schema: VERIFY_SCHEMA },
  )
  if (!verify) { outcome = 'failed'; review = { ...review, rationale: 'verify-done gate returned no verdict' }; break }
  evidence = verify.evidence || ''
  if (verify.verified) {
    outcome = 'ready'
  } else {
    feedback = `[VERIFY-DONE FEEDBACK] Approval withheld — evidence missing:\n${(verify.missing || []).join('\n') || verify.evidence}`
    log(`verify-done gate rejected (iteration ${iter}/${MAX_ITERS})`)
  }
}

const NEXT = {
  ready: `Reviewer approved and the verify-done evidence gate passed. Shipping (commit/push/deploy) is deliberately outside this workflow — hand off to the loop's persona deploy gate, or commit per the git-hygiene playbook (${SKILL.gitHygiene}): one atomic commit, message says why.`,
  escalate: `Iteration budget (${MAX_ITERS}) exhausted without a verified, approved review — escalate to the lead. Do not widen the cap to force progress.`,
  blocked: 'High-risk change BLOCKED by the adversarial challenge — never ship it; fix the risk or revise the contract.',
  failed: 'The card failed a hard gate. Read the detail, fix the root cause, and re-run.',
}
log(`card "${card}" → ${outcome} after ${iter} iteration(s)`)
return { outcome, card, iterations: iter, acceptance, plan: validation.plan || null, challengeBrief, review, evidence, next: NEXT[outcome] }
