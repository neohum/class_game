// adversarial-verify.mjs — Adversarial Multi-Agent Verification Workflow
//
// Inspired by Anthropic claude.dev best practices:
// Implements the Adversarial Verification dynamic workflow pattern.
// Deconstructs claims, plans, or code diffs into discrete testable assertions,
// dispatches parallel adversarial investigators to attempt refutation,
// filters out bikeshedding via a skeptical adjudicator, and synthesizes a hardened verdict.
//
// Usage:
//   Workflow({
//     name: 'adversarial-verify',
//     args: {
//       claim: 'Plan/code under review',
//       context: 'Architecture context or diff',
//       rules: ['Rule 1', 'Rule 2']
//     }
//   })

export const meta = {
  name: 'adversarial-verify',
  description: 'Deconstruct claims or diffs, run parallel adversarial refutations, filter objections via skeptical auditor, and synthesize hardened verdict',
  whenToUse: 'High-stakes verification of architecture plans, security changes, risk: high cards, or controversial claims before implementation. Pass { claim, context, rules } via args.',
  phases: [
    { title: 'Deconstruct', detail: 'Deconstruct target claim and context into discrete testable assertions' },
    { title: 'Adversarial Challenge', detail: 'Parallel investigators actively attempt to disprove assertions and find regressions' },
    { title: 'Skeptic Audit', detail: 'Skeptical judge filters spurious objections and verifies genuine counter-evidence' },
    { title: 'Synthesize', detail: 'Synthesize final hardened verdict, severity score, and required remediations' },
  ],
}

const inputClaim = typeof args === 'string' ? args.trim() : String(args?.claim ?? args?.spec ?? '').trim()
if (!inputClaim) {
  throw new Error('adversarial-verify: pass the target claim via args — a bare string, or { claim, context, rules }')
}
const context = (args && typeof args === 'object' && args.context) ? String(args.context) : ''
const rules = (args && typeof args === 'object' && Array.isArray(args.rules)) ? args.rules : []

const DECONSTRUCT_SCHEMA = {
  type: 'object',
  required: ['assertions', 'implicitAssumptions'],
  properties: {
    assertions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'statement', 'criticalRisk'],
        properties: {
          id: { type: 'string' },
          statement: { type: 'string' },
          criticalRisk: { enum: ['low', 'medium', 'high'] },
        },
      },
    },
    implicitAssumptions: {
      type: 'array',
      items: { type: 'string' },
    },
  },
}

const CHALLENGE_SCHEMA = {
  type: 'object',
  required: ['assertionId', 'refuted', 'counterEvidence', 'severity'],
  properties: {
    assertionId: { type: 'string' },
    refuted: { type: 'boolean', description: 'true if this assertion was successfully disproven or has critical flaws' },
    counterEvidence: { type: 'string', description: 'Concrete counterexample, reproduction scenario, or regression proof' },
    severity: { enum: ['none', 'low', 'medium', 'high', 'critical'] },
  },
}

const SKEPTIC_SCHEMA = {
  type: 'object',
  required: ['validatedVulnerabilities', 'dismissedObjections', 'verdict'],
  properties: {
    validatedVulnerabilities: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'description', 'severity', 'remediation'],
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          severity: { enum: ['low', 'medium', 'high', 'critical'] },
          remediation: { type: 'string' },
        },
      },
    },
    dismissedObjections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'reason'],
        properties: {
          id: { type: 'string' },
          reason: { type: 'string', description: 'Why this objection was dismissed (e.g. out of scope, false assumption, pedantic)' },
        },
      },
    },
    verdict: {
      enum: ['VERIFIED', 'QUALIFIED', 'REFUTED'],
      description: 'VERIFIED: robust against all refutations; QUALIFIED: passes with caveats/fixes; REFUTED: critical counterexamples found',
    },
  },
}

// --- Phase 1: Deconstruct ----------------------------------------------------
phase('Deconstruct')
log('Deconstructing claim and context into testable assertions...')

const deconstruct = await agent(
  [
    'You are the Deconstruction specialist in an Adversarial Verification team.',
    'Break down the following claim, architecture, or code spec into discrete, falsifiable assertions.',
    'Identify implicit assumptions that could fail under edge conditions.',
    rules.length > 0 ? `Must strictly adhere to these invariant rules:\n${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}` : '',
    context ? `Context:\n${context}` : '',
    `Target Claim/Spec:\n${inputClaim}`,
  ].filter(Boolean).join('\n\n'),
  { label: 'deconstruct', phase: 'Deconstruct', agentType: 'explorer', schema: DECONSTRUCT_SCHEMA },
)

if (!deconstruct || !deconstruct.assertions || deconstruct.assertions.length === 0) {
  throw new Error('adversarial-verify: failed to deconstruct claim into assertions')
}

const assertions = deconstruct.assertions.slice(0, 6) // Cap at 6 assertions to prevent unbounded fan-out
log(`Deconstructed into ${assertions.length} assertions and ${deconstruct.implicitAssumptions.length} assumptions`)

// --- Phase 2: Adversarial Challenge (Parallel Fan-out) -----------------------
phase('Adversarial Challenge')
log(`Dispatching ${assertions.length} parallel adversarial investigators...`)

const challengeTasks = assertions.map((ast) => () => agent(
  [
    `You are an adversarial red-team investigator attacking Assertion [${ast.id}].`,
    `Assertion: "${ast.statement}" (Risk rating: ${ast.criticalRisk})`,
    'Your goal is to DISPROVE this assertion. Actively find edge cases, race conditions,',
    'unhandled failures, security bypasses, performance cliffs, or contract violations.',
    context ? `Context:\n${context}` : '',
    'If you find a genuine refutation or severe flaw, set refuted=true and provide concrete counterEvidence.',
    'Do not invent fictional problems; ground your counterexample in realistic execution.',
  ].filter(Boolean).join('\n\n'),
  { label: `attack:${ast.id}`, phase: 'Adversarial Challenge', agentType: 'reviewer', schema: CHALLENGE_SCHEMA },
))

const challengeResults = await parallel(challengeTasks)

// --- Phase 3: Skeptic Audit (Filter & Adjudicate) ----------------------------
phase('Skeptic Audit')
log('Auditing adversarial findings to filter false positives and bikeshedding...')

const skepticVerdict = await agent(
  [
    'You are the Chief Skeptic and Neutral Adjudicator.',
    'Review the adversarial challenges against the original claim and context.',
    'Filter out spurious objections, pedantic bikeshedding, or theoretical issues with negligible impact.',
    'Validate genuine flaws, regression vectors, and contract violations.',
    `Original Claim:\n${inputClaim}`,
    `Assumptions:\n${deconstruct.implicitAssumptions.join('\n')}`,
    `Adversarial Challenge Reports:\n${JSON.stringify(challengeResults, null, 2)}`,
    'Assign verdict: "VERIFIED" if clean, "QUALIFIED" if minor fixes needed, "REFUTED" if critical flaws proven.',
  ].join('\n\n'),
  { label: 'skeptic-audit', phase: 'Skeptic Audit', agentType: 'reviewer', schema: SKEPTIC_SCHEMA },
)

if (!skepticVerdict) {
  throw new Error('adversarial-verify: skeptic auditor failed to deliver verdict')
}

// --- Phase 4: Synthesize ----------------------------------------------------
phase('Synthesize')
const outcome = skepticVerdict.verdict.toLowerCase()
const criticalCount = skepticVerdict.validatedVulnerabilities.filter((v) => v.severity === 'critical' || v.severity === 'high').length

log(`Adversarial verification finished: ${skepticVerdict.verdict} (${criticalCount} high/critical vulnerabilities)`)

return {
  outcome,
  verdict: skepticVerdict.verdict,
  claim: inputClaim,
  totalAssertionsChecked: assertions.length,
  validatedVulnerabilities: skepticVerdict.validatedVulnerabilities,
  dismissedObjections: skepticVerdict.dismissedObjections,
  summary: `Verified with ${assertions.length} assertions. ${skepticVerdict.validatedVulnerabilities.length} validated issues, ${skepticVerdict.dismissedObjections.length} objections dismissed.`,
}
