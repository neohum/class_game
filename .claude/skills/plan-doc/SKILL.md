---
name: plan-doc
description: Turn a feature request into ONE approved plan document (plans/<slug>.plan.md) and run it end to end — steps compile into ordered backlog cards, independent steps run in parallel waves, and each card ships with evidence on disk. Use this whenever the work is bigger than a one-line fix: a feature, a migration, a refactor across files, or any change the user describes as "설계", "계획", "한 번에", "plan this", "build this out". Also use it when a card was blocked by the plan gate.
---

# Plan document first (계획서 우선)

A card is a request. A **plan document is a design** — approved once, then executed
without asking the human again. That is the whole point: the expensive
conversation happens on a page you can read in 60 seconds, and everything after it
is mechanical.

```
plans/<slug>.plan.md   ──compile──▶  ordered backlog cards  ──waves──▶  parallel builds
   status: approved                  (deps chained for you)             evidence/<date>-<card>/
```

## The pipeline (this is the "한 번에 완성" path)

1. **Explore before writing.** Read the real files you are about to name. A plan
   written from memory is a guess with a filename. Trace call paths, find the
   existing precedent to copy, measure the blast radius.
2. **Write the document.**
   `node scripts/loop/plan-doc.ts init <slug> "제목"` writes the skeleton to
   `plans/<slug>.plan.md`. Fill in Intent, Non-goals, and one `### Step N: <card-slug>`
   per independently verifiable unit.
3. **Validate it.** `node scripts/loop/plan-doc.ts check <slug>` — an invalid plan
   compiles NOTHING, so fix it here rather than discovering it mid-loop.
4. **Get approval.** Set `status: approved` in the frontmatter. At `risk: high`,
   `owner:` must name a human — that tier is not a model's call.
5. **Compile.** `node scripts/loop/plan-doc.ts compile` turns every step into a
   backlog card, chained by dependency, in one pass.
6. **Run.** The loop (`node scripts/loop/ralph-loop.ts`) claims only cards whose
   dependencies are done, so the order you wrote is the order that runs — and
   `node scripts/loop/plan-doc.ts waves <slug>` shows which steps run together.
7. **Prove it.** Each card fills `evidence/<YYYYMMDD>-<card>/README.md` and records
   the real captured output beside it. No evidence, no ship.

## Writing a good step

One step = one card = one reviewable commit. If a step cannot be verified on its
own, it is half a step.

```markdown
### Step 2: ratelimit-config
- Goal: 한도를 설정 파일에서 읽는다
- Files: src/config.ts, tests/ratelimit.test.ts
- Acceptance: AC-1: config의 limit을 바꾸면 429 임계값이 따라 바뀐다
- Tests: npm test -- ratelimit
- Risk: low
- Complexity: low
- Parallel: no        # yes → 앞 단계와 같은 wave에서 동시에 실행
- Depends on: ratelimit-middleware   # 생략하면 바로 앞 단계에 자동 연결
```

- **Files is mandatory.** It is the declared blast radius and it becomes the
  card's path allowlist — a builder that edits outside it fails closed.
- **Acceptance is evidence a reviewer can check**, not a feeling. `AC-1: …`.
- **Tests is a command**, not "테스트한다".
- **Parallel: yes** only when the step genuinely does not read the previous
  step's output. Wrong parallelism buys a merge conflict, not speed.

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

## Rules

1. **No plan on disk, no risky build.** The plan gate blocks any `Risk: medium|high`
   card that no approved plan declares (`gate.mode: strict` makes that every card).
   If you were blocked, the fix is to write the plan — not to switch off the gate.
   `HARNESS_PLAN_GATE=off` is interactive-only; an unattended loop refuses it.
2. **Reality wins.** When an assumption turns out wrong mid-build, edit the plan
   document and re-run `check`. A plan that quietly diverges from the code is
   worse than none, because the next agent trusts it.
3. **Non-goals are the highest-value section.** Most scope creep is an agent
   helpfully doing what nobody asked for. Write down what you will not do.
4. **One plan, one feature.** A plan with eleven unrelated steps is a backlog with
   frontmatter.

## Commands

| Command | What it does |
| --- | --- |
| `node scripts/loop/plan-doc.ts init <slug> ["title"]` | write the skeleton |
| `node scripts/loop/plan-doc.ts check [slug]` | validate (exit 1 on error) |
| `node scripts/loop/plan-doc.ts waves <slug>` | print the parallel waves |
| `node scripts/loop/plan-doc.ts compile [--dry]` | approved plans → backlog cards |
| `node scripts/loop/plan-doc.ts list` | every plan and its status |
| `node scripts/loop/plan-gate.ts <card>` | would this card be allowed to build? |
| `node scripts/loop/deps.ts` | which cards are ready, which are waiting |
| `node scripts/loop/evidence.ts verify <card>` | is the evidence complete? |

Full reference: [`docs/PLAN_DOCS.md`](../../../docs/PLAN_DOCS.md).

Partly adapted from songjiun10-collab/Senior-thinking-skills@be98e588 (MIT) — see docs/senior-thinking.md.
