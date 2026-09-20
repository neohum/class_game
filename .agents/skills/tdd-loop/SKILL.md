---
name: tdd-loop
description: Drive implementation with a strict red-green-refactor test loop. Use this when implementing a new feature, changing behavior, or fixing a bug in any codebase that has automated tests or should have them, especially when the user says "add", "implement", "build", "fix", or "make it do X". Also use it to lock a bug fix in place with a regression test before touching the production code.
---

# TDD Loop

For an agent, a failing test is the one spec that cannot be argued with. Code that "looks correct" is a hypothesis; a green test that was red five minutes ago is evidence. The loop exists to stop "looks done" from quietly replacing "is done".

## Pin the pass bar before you see results

A bar set after the result can always be met. Before the first test or run, write down what has to be true for this to count as done, in the card, plan acceptance (`AC-*`), or the test itself:

- "Make it work" / "improve this": translate it into an observable check. If you cannot, ask; a vague bar means a check-in at every step.
- "Add validation": the invalid-input test comes first.
- "Is A better than B", benchmarks, performance or quality measurements: fix the metric, the workload, the number of runs, and the winning threshold (for example "p95 at least 10% lower over 5 runs") before running anything. Deciding the bar after the numbers guarantees a "success".
- If the difference could plausibly be noise, the honest result is "inconclusive", however good the mean looks. Report it that way and record the raw numbers in `evidence/`.
- If the bar turns out to be wrong, change it as a visible, justified step, never quietly to fit the result.

Principal angle: a threshold other teams will later cite as ground truth becomes precedent; get it agreed before the numbers exist.

## The loop

1. **Write the smallest failing test** that captures the next slice of the requirement. For a bug: write the test that reproduces it. One behavior per test.
2. **Run it and watch it fail for the right reason.** The failure must be the assertion you wrote, not an import error, a typo, or a missing fixture. If the test passes immediately, stop: either the behavior already exists or your test is not testing what you think it is. Both are worth knowing before you write code.
3. **Write the minimum code to make it pass.** Resist building the general solution for requirements that do not exist yet. Minimum code keeps the diff reviewable and the design honest.
4. **Run the test, then the surrounding suite.** Your new green means nothing if you turned three neighbors red.
5. **Refactor while everything is green,** then commit. Small green commits are your save points.
6. Repeat until the requirement is covered.

## Anti-cheating rules

These are where agents most often go wrong, so hold the line:

- Never weaken, delete, or comment out an assertion to get to green. If the assertion is wrong, say so explicitly and fix the test as its own visible step, not as a silent casualty of the implementation.
- Never mock the unit under test. Mock its expensive collaborators (network, clock, database) if needed; the thing being tested must actually run.
- Never mark a failing test as skipped "to come back later". Later does not come.
- Do not write tests that assert the implementation (called X with Y) when you can assert the behavior (returns Z, state became W). Behavior tests survive refactors; implementation tests punish them.
- If a test is painful to write, treat that as design feedback about the code, not as a reason to skip the test.

## Fit the house style

Before writing the first test, look at how this project already tests: framework, file naming, directory placement, fixture patterns, assertion style. Match it exactly. A pytest-style test dropped into a unittest codebase is a review comment waiting to happen. If the project has no tests at all, propose the lightest standard tool for the language and confirm before introducing it.

## Bug fixes specifically

Reproduction test first, always. Confirm it fails on current code, then fix, then confirm it passes. A fix without a red-then-green regression test is a fix you cannot prove, and the bug's favorite move is coming back in six months wearing a different stack trace. If you cannot write that failing reproduction yet, you do not understand the bug yet; go to debug-protocol before touching production code.

Partly adapted from songjiun10-collab/Senior-thinking-skills@be98e588 (MIT) — see docs/senior-thinking.md.
