// tournament.mjs — Pairwise Tournament Evaluation Workflow
//
// Inspired by Anthropic claude.dev best practices:
// Implements the Tournament dynamic multi-agent workflow pattern.
// Pits competing code implementations, architectural designs, or prompts
// head-to-head in round-robin or bracketed pairwise comparisons judged by
// independent evaluators, then ranks candidates and synthesizes the optimal solution.
//
// Usage:
//   Workflow({
//     name: 'tournament',
//     args: {
//       problem: 'Task or problem statement to solve',
//       candidates: [
//         { name: 'approach-a', description: 'Approach A description or code' },
//         { name: 'approach-b', description: 'Approach B description or code' },
//         { name: 'approach-c', description: 'Approach C description or code' }
//       ],
//       criteria: ['Correctness', 'Maintainability', 'Performance', 'Simplicity']
//     }
//   })

export const meta = {
  name: 'tournament',
  description: 'Pairwise tournament evaluation: pit competing implementations head-to-head to select or synthesize the optimal solution',
  whenToUse: 'When multiple viable implementation approaches exist and objective selection via pairwise debate and scoring is needed. Pass { problem, candidates, criteria } via args.',
  phases: [
    { title: 'Matchmaking', detail: 'Deconstruct candidates and generate pairwise comparison pairings' },
    { title: 'Head-to-Head Matches', detail: 'Parallel independent judges evaluate each head-to-head matchup' },
    { title: 'Score & Rank', detail: 'Aggregate match outcomes and compute standings' },
    { title: 'Synthesis', detail: 'Synthesize optimal solution incorporating best elements from top contenders' },
  ],
}

const problem = (args && typeof args === 'object' && args.problem) ? String(args.problem).trim() : ''
const candidates = (args && typeof args === 'object' && Array.isArray(args.candidates)) ? args.candidates : []
const criteria = (args && typeof args === 'object' && Array.isArray(args.criteria))
  ? args.criteria
  : ['Correctness & Robustness', 'Simplicity & Readability', 'Performance & Efficiency', 'Ease of Testing']

if (!problem) {
  throw new Error('tournament: pass problem statement via args.problem')
}
if (!candidates || candidates.length < 2) {
  throw new Error('tournament: provide at least 2 candidates via args.candidates: [{ name, description }]')
}

const MATCH_SCHEMA = {
  type: 'object',
  required: ['winner', 'loser', 'margin', 'rationale', 'strengthsWinner', 'weaknessesLoser'],
  properties: {
    winner: { type: 'string', description: 'Candidate name that won the matchup (or "tie")' },
    loser: { type: 'string', description: 'Candidate name that lost the matchup (or "tie")' },
    margin: { enum: ['decisive', 'moderate', 'narrow', 'tie'] },
    rationale: { type: 'string', description: 'Detailed justification for the decision based on the criteria' },
    strengthsWinner: { type: 'array', items: { type: 'string' } },
    weaknessesLoser: { type: 'array', items: { type: 'string' } },
  },
}

const SYNTHESIS_SCHEMA = {
  type: 'object',
  required: ['champion', 'rankings', 'rationale', 'synthesizedRecommendation'],
  properties: {
    champion: { type: 'string', description: 'Name of the top-performing candidate' },
    rankings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['rank', 'name', 'score', 'summary'],
        properties: {
          rank: { type: 'number' },
          name: { type: 'string' },
          score: { type: 'number' },
          summary: { type: 'string' },
        },
      },
    },
    rationale: { type: 'string' },
    synthesizedRecommendation: {
      type: 'string',
      description: 'The final recommended design/code, optionally adopting the best attributes of runners-up',
    },
  },
}

// --- Phase 1: Matchmaking ----------------------------------------------------
phase('Matchmaking')
log(`Setting up tournament for ${candidates.length} candidates solving: "${problem.slice(0, 60)}..."`)

// Generate round-robin pairings: (A vs B, A vs C, B vs C, etc.)
const pairings = []
for (let i = 0; i < candidates.length; i++) {
  for (let j = i + 1; j < candidates.length; j++) {
    pairings.push([candidates[i], candidates[j]])
  }
}
log(`Generated ${pairings.length} head-to-head match(es)`)

// --- Phase 2: Head-to-Head Matches (Parallel Evaluation) --------------------
phase('Head-to-Head Matches')

const matchTasks = pairings.map(([candA, candB], idx) => () => agent(
  [
    `You are an impartial Judge in Tournament Match #${idx + 1}: [${candA.name}] VS [${candB.name}].`,
    `Problem Statement:\n${problem}`,
    `Evaluation Criteria:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
    '----------------------------------------',
    `Candidate A: [${candA.name}]\n${candA.description || candA.codeOrPlan || JSON.stringify(candA)}`,
    '----------------------------------------',
    `Candidate B: [${candB.name}]\n${candB.description || candB.codeOrPlan || JSON.stringify(candB)}`,
    '----------------------------------------',
    'Compare both approaches rigorously against each criterion.',
    'Decide which candidate is superior, or declare a tie only if indistinguishable.',
    'State concrete strengths of the winner and distinct weaknesses of the loser.',
  ].join('\n\n'),
  { label: `match:${candA.name}-vs-${candB.name}`, phase: 'Head-to-Head Matches', agentType: 'reviewer', schema: MATCH_SCHEMA },
))

const matchResults = await parallel(matchTasks)

// --- Phase 3 & 4: Score, Rank & Synthesize ----------------------------------
phase('Synthesis')
log('Tallying tournament scores and synthesizing winning solution...')

const synthesis = await agent(
  [
    'You are the Tournament Director and Chief Architect.',
    `Problem Statement:\n${problem}`,
    `Evaluation Criteria:\n${criteria.join(', ')}`,
    `All Candidates:\n${candidates.map((c) => `- ${c.name}`).join('\n')}`,
    `Match Results:\n${JSON.stringify(matchResults, null, 2)}`,
    'Tally the head-to-head scores (e.g. decisive win = 3pts, moderate = 2pts, narrow = 1pt, tie = 0.5pts).',
    'Rank all candidates from first to last.',
    'Declare the champion and synthesize a final recommendation that adopts the champion approach while borrowing any clever secondary ideas from other contenders.',
  ].join('\n\n'),
  { label: 'tournament-synthesis', phase: 'Synthesis', agentType: 'architect', schema: SYNTHESIS_SCHEMA },
)

if (!synthesis) {
  throw new Error('tournament: failed to synthesize tournament results')
}

log(`Tournament Champion: [${synthesis.champion}]`)

return {
  outcome: 'completed',
  problem,
  champion: synthesis.champion,
  rankings: synthesis.rankings,
  recommendation: synthesis.synthesizedRecommendation,
  matchesPlayed: pairings.length,
  summary: `Evaluated ${candidates.length} candidates across ${pairings.length} matches. Winner: ${synthesis.champion}.`,
}
