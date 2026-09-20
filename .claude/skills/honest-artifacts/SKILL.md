---
name: honest-artifacts
description: Use when committing constants, thresholds, or tuned parameters; when reporting a number or benchmark; when a result came from a manual one-off process; when optimizing against a metric; or when tempted to present an estimate as verified.
---

# Honest Artifacts

## Separate what you know from what you estimated

The most dangerous artifact is not a wrong one; it is one where nobody can tell how much was verified. Put a measured value next to a guess with no distinction and the next reader either trusts both or doubts both.

- Does this constant, threshold, or default have a real basis, or is it "probably close enough"?
- If there is no basis, record that fact where the value lives (`// UNVERIFIED: taken from X, not independently checked`).
- Is an estimate being presented as certain? A number quoted outside this task carries your confidence level whether you state it or not. Label it before it travels.
- Record the attempts that did not work too. Failure is data, not something to hide.
- Principal angle: once a number lands in a design doc or another team's decision, correcting it costs far more than labeling it would have.

## Reproducibility

"It works" and "it can be rebuilt" are different claims. A result from a one-off manual process becomes a black box as soon as its author is gone.

- Is there a procedure that rebuilds this result from scratch?
- Does it run as one command, or does it live in someone's head?
- Will it reproduce from the same inputs later? Pin seeds, input data, and versions.

## Metric traps

Optimize a score long enough and the score improves while the goal drifts away.

- Did the change improve the thing being measured, or just fit the way it is measured?
- Choose the metric and the pass bar before seeing results, not after.
- Is the sample big enough? If not, a conservative choice beats a complex one with a marginally better score.
- Did anything get worse while this metric improved (speed up, accuracy down)?
- "It got better" is not a result. Give the number, before and after.

## In this harness

Applies to everything under `evidence/<YYYYMMDD>-<card>/`:

- Label every number as **measured** or **estimated**. A measured number names the command that produced it and the captured output file (`node scripts/loop/evidence.ts record <card> <name>`). A model's report of what it observed is not the observation.
- A tuned constant records how it was derived: the input, the command, the result it was picked from.
- The metric and threshold come from the plan's `AC-*` lines or are written down before the run. Changing them after seeing the output is noted under WHAT WAS OMITTED, not hidden.
- Anything not measured belongs under WHAT WAS OMITTED, stated plainly.

Adapted from songjiun10-collab/Senior-thinking-skills@be98e588 (MIT) — see docs/senior-thinking.md.
