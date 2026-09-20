---
name: widen-the-solution-space
description: Use before a hard-to-reverse choice (architecture, schema, data format, public API), when the first idea feels awkward, when the user asks for the best way rather than giving instructions, or after a failed attempt.
---

# Widen the Solution Space

The common failure is that the first plausible idea silently becomes the answer. It isn't bad, so nothing prompts a search for something better, and the faster you can generate code the deeper that trap gets. Skip this for routine work with one obvious answer.

## Diverge

Run through these axes quickly, one line each, mostly in your head. Don't force every axis to produce something.

1. **Obvious** — the first idea; keep it as the baseline.
2. **Industry standard** — how do people who already solved this usually do it?
3. **Embarrassingly simple** — surprisingly often right.
4. **Build nothing** — can an existing library, feature, or manual step cover it?
5. **Eliminate the problem** — change something upstream so the situation never arises.
6. **Flip the premise** — push/pull, sync/async, store/recompute, eager/lazy.
7. **Different layer** — DB instead of app, infra instead of code, build time instead of runtime.
8. **Scoped down** — the version covering 80%; is the other 20% actually needed?
9. **Adjacent domain** — does a familiar pattern from elsewhere fit?
10. **Different data model** — does representing the data differently dissolve the problem?
11. **Buy or borrow** — an external service or tool instead of building.
12. **Work backward** — from this working well a year from now, what comes first?

## Converge

- Keep only the **2-3** candidates worth evaluating. Drop the non-viable ones without justifying each.
- If a rejected candidate was a close call, say so in one line; the user may want that direction, or it becomes the lead if the project pivots.
- **Principal angle:** for a shared or externally visible choice, prefer the candidate other teams can adopt and extend; winning on your own metrics while being hard to build on sets a bad precedent.

## Output

Don't list all twelve. Show only the 2-3 survivors and why they survived; the raw idea list has no value to the reader.

## In this harness

- The architect runs this before any hard-to-reverse choice, before writing a plan document's approach.
- The 2-3 survivors are the input to `weigh-tradeoffs`, which picks one and records why.
- When the user is choosing between approaches that are expensive to judge on paper, the `competitive-council` skill is the heavier option: it races independent implementations and scores them on evidence.

Adapted from songjiun10-collab/Senior-thinking-skills@be98e588 (MIT) — see docs/senior-thinking.md.
