---
name: plan-doc
description: Write and execute a plan document (plans/<slug>.plan.md) instead of building straight from a card. Use for any change bigger than a one-line fix — features, migrations, multi-file refactors — and whenever a build was refused by the plan gate. The document compiles into ordered backlog cards, independent steps run as parallel waves, and every card ships with evidence on disk.
---

# Plan document first (계획서 우선)

Building from a one-line card means the design is invented at the same moment the
code is written, so the first reviewable artifact is the diff — after the money is
spent. A plan document moves that decision to a page a human reads in a minute.

```
plans/<slug>.plan.md  ──compile──▶  ordered cards  ──waves──▶  builds  ──▶  evidence/<date>-<card>/
```

## Steps

1. **Explore first.** Read the files you are about to name. Never plan from memory.
2. `node scripts/loop/plan-doc.ts init <slug> "title"` — writes the skeleton.
3. Fill in `## Intent`, `## Non-goals`, and one `### Step N: <card-slug>` per
   independently verifiable unit. Every step needs `Goal`, `Files`, `Acceptance`
   (`AC-1: …`) and `Tests` (a real command).
4. `node scripts/loop/plan-doc.ts check <slug>` — an invalid plan compiles nothing.
5. Set `status: approved` in the frontmatter (`owner:` is required at `risk: high`).
6. `node scripts/loop/plan-doc.ts compile` — every step becomes a backlog card,
   dependency-chained in the order written.
7. Build each card, then fill `evidence/<YYYYMMDD>-<card>/README.md` and record the
   real captured output: `node scripts/loop/evidence.ts record <card> <name> < out.txt`.

## Before the steps: sketch the layout, then hold each step to the bar

**Sketch the file layout first.** Before writing any `### Step`, list which files
are created or changed and what each one is responsible for — one line per file,
with the why. This is where decomposition is locked in, and it is expensive to
reverse, so do it on the page, not mid-build. Keep things that change together
together, split by responsibility rather than by layer, and follow the codebase's
existing patterns instead of re-architecting it inside a feature plan. The union
of the steps' `Files:` should match this sketch; a file that appears in a step but
not in the sketch is unplanned scope.

**The bar for every step:** a competent developer with zero context on this
codebase and no judgment calls to make could execute it as written. Exact paths,
what it verifies and how, a pointer to the precedent to copy, and a done-state.
Fold setup and docs into the step that needs them; split two steps only if a
reviewer could approve one and reject the other.

Warning signs of a bad step:

| Sign | Why it fails the bar |
| --- | --- |
| Vague verbs — "handle", "improve", "clean up", "support" | The builder has to invent the design; that is drift, not a plan |
| No runnable test command | Nothing proves the step is done, so nothing stops it |
| `Files:` includes paths unrelated to the Goal | Hidden scope, and a wider allowlist than the step needs |
| "I'll sort it out while coding" | Deciding while coding is exactly what the plan exists to prevent |
| Too big to verify in one run | It is several steps sharing a heading |

## Non-negotiables

- **`Files:` is the blast radius** and becomes the card's path allowlist. Editing
  outside it fails closed.
- **No approved plan → no medium/high-risk build.** That is the plan gate
  (`scripts/loop/plan-gate.ts`). Write the plan; do not disable the gate.
  `HARNESS_PLAN_GATE=off` is interactive-only and an unattended run refuses it.
- **No evidence → no ship.** Four sections, all filled, plus at least one captured
  artifact: WHAT WAS TESTED / WHAT WAS OBSERVED / WHY IT IS ENOUGH / WHAT WAS OMITTED.
- **Sequential by default.** A step waits for the one before it unless it declares
  `Parallel: yes` — use that only when it truly does not read the previous step's
  output.
- **When reality disagrees with the plan, edit the plan** and re-run `check`. A
  stale plan is worse than none: the next agent believes it.

`node scripts/loop/deps.ts` shows which cards are ready and which are waiting.
`node scripts/loop/plan-doc.ts waves <slug>` shows what can run at the same time.

Partly adapted from songjiun10-collab/Senior-thinking-skills@be98e588 (MIT) — see docs/senior-thinking.md.
