---
name: competitive-council
description: Run exactly three agents as independent contenders through requirements, architecture, tests, implementation, and review; use bounded debate and test evidence to select or synthesize the winning change.
---

# Competitive Council

Use this skill when the user asks for three agents to debate, compete, compare
implementations, or run the complete development cycle as a council.

## Non-negotiable topology

- The coordinator launches **exactly three** contender agents: A, B, and C.
- Each contender gets the same frozen task, repository revision, constraints,
  acceptance IDs, and evaluation rubric.
- Keep the first proposal in every phase **sealed** until all three contenders
  submit. This prevents anchoring and imitation.
- The coordinator owns orchestration and adjudication but may not silently add
  a fourth solution.
- Use an isolated worktree and branch for each implementation. A contender must
  never write in another contender's worktree or the primary checkout.

If three independent agents or worktrees cannot be created, stop and report the
missing capability. Do not pretend that three sequential personas are three
independent contenders.

## Full competitive development cycle

Run the same four-step match in every phase:

1. **Sealed proposal:** A, B, and C independently submit a concrete artifact.
2. **Cross-examination:** each contender identifies the strongest defect in
   both competing artifacts and names evidence that would change its position.
3. **Revision:** each contender gets one response incorporating or rebutting
   the criticism. Use a maximum of two debate rounds per phase.
4. **Evidence score:** the coordinator scores the revised artifacts against the
   frozen rubric and records the winner or an explicit synthesis.

Apply the match to all phases:

### 1. Requirements

Each contender produces scope, assumptions, acceptance IDs, failure cases, and
non-goals. Freeze one requirements contract before architecture begins.

### 2. Architecture

Each contender proposes an implementation plan, affected files, interfaces,
risks, rollback path, and smallest viable diff. Freeze the selected plan and
record rejected trade-offs.

### 3. Tests

Each contender proposes tests that would fail before the change, including at
least one unhappy path. Select the strongest non-duplicative set. Run the tests
and record the expected red result before implementation.

### 4. Implementation

Create three isolated worktrees from the same base revision. A, B, and C each
implement the frozen contract and selected tests without seeing the others'
working changes. Capture each diff, commands run, and test evidence.

After sealed submission, run cross-examination on the three diffs. Contenders
may revise only their own branch. Never merge partial code during debate.

### 5. Review

Score every candidate on:

- acceptance coverage: 35%
- correctness and test evidence: 30%
- security and failure behavior: 15%
- maintainability and minimal scope: 10%
- performance and operability: 10%

The winning candidate must pass the full health gate. Run useful tests proposed
by losing contenders against the winner as mutation pressure. If none pass,
return to implementation; do not choose the least-broken candidate.

## Decision rules

- Never decide by majority vote, confidence, eloquence, provider identity, or
  shortest response. Decide from repository evidence and the published rubric.
- A synthesis is allowed only when its exact source changes are identified and
  the synthesized result is tested again from scratch.
- Preserve a decision ledger containing proposals, objections, scores, test
  evidence, winner, and rejected alternatives.
- Security or destructive-action objections are blocking until disproved.
- A tie is resolved by the smaller change only when acceptance evidence is
  equal; otherwise request a targeted experiment.

## Git and delivery

Integrate only the winner into the primary branch. Re-run the repository's full
health checks after integration, inspect the final diff, and obtain normal
commit/push approval. Do not delete contender worktrees until the winning
commit and evidence are recorded.

## Completion report

Report the three candidate summaries, decisive objections, score table,
selected or synthesized winner, exact test evidence, final diff scope, and any
unresolved risk. Do not claim “consensus” when the result was adjudicated.
