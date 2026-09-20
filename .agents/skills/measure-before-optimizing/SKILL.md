---
name: measure-before-optimizing
description: Use before any caching, memoization, query rewrite, algorithm swap, or "this seems slow" change, when a card sets a performance target, or when a performance claim has no before/after number.
---

# Measure Before Optimizing

"This seems slow" is a guess, not a problem. Optimization that starts from a guess usually adds complexity and no improvement anyone can feel. Skip this skill only when the bottleneck is obvious from the code itself, such as an accidental O(n²) on a hot path.

## Order: measure, pinpoint, fix, re-measure

1. **Reproducible measurement first.** Profiler, timing harness, benchmark, Lighthouse, real-user metrics. Not a hunch about "the problem".
2. **Pinpoint exactly one bottleneck.** An N+1 query, a cache miss, bundle size. Fix several things at once and nobody can tell what helped.
3. **Fix that one thing.**
4. **Re-measure the same way.** The improvement must beat run-to-run noise to count. If it does not, the result is "inconclusive", not "faster".

## Common traps

- Adding a cache before profiling. A cache buys a new cost: invalidation bugs.
- Bundling several optimizations into one commit.
- Keeping a change that did not help "because it is neutral". Revert it; unjustified code accumulates.
- Declaring victory with no guardrail (benchmark test, monitor) against regression.

## Is it worth it

If the measured bottleneck is negligible against the whole path, skip it. Performance is a budget: spend it only where evidence says it is felt.

Principal angle: if the hot path sits in a shared library or service, weigh the fix against its other callers' traffic, not just your call site.

## In this harness

- Pin the target and the measurement command before touching code: write the metric, workload, run count, and pass threshold (for example "p95 at least 10% lower over 5 runs") into the card or plan acceptance (`AC-*`).
- Capture raw measurement output, not summaries, into `evidence/<YYYYMMDD>-<card>/` as files: one for before, one for after, produced by the same command. Quote the numbers in the evidence notes and state whether the threshold was met.
- No measured bottleneck means no optimization card. Report the numbers back to the lead instead of building a speculative fix.
- After the change, re-run the full health gate `scripts/loop/health.sh`; a faster path that breaks a test is a regression, not a win.
- A finding that will outlive this card (a slow query pattern, a misleading benchmark) goes to `node scripts/loop/knowledge.ts add --title "<one-line lesson>" --tags "<topic>" -- "<what happened and why>"`.

Adapted from songjiun10-collab/Senior-thinking-skills@be98e588 (MIT) — see docs/senior-thinking.md.
