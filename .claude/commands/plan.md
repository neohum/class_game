---
description: Turn a request into an approved plan document (plans/<slug>.plan.md) and compile it into ordered backlog cards in one pass.
argument-hint: "<what to build> [--compile]"
---

Use the `plan-doc` skill for this.

1. **Explore first.** Read the actual files this will touch — never plan from
   memory. Name the existing precedent you are copying.
2. Pick a lowercase slug and run `node scripts/loop/plan-doc.ts init <slug> "$ARGUMENTS"`.
3. Fill in the document: `## Intent`, `## Non-goals`, and one
   `### Step N: <card-slug>` per independently verifiable unit — each with `Goal`,
   `Files` (the blast radius), `Acceptance` (`AC-1: …`) and `Tests` (a real command).
   Mark a step `Parallel: yes` only when it does not read the previous step's output.
4. Run `node scripts/loop/plan-doc.ts check <slug>` and fix everything it reports.
5. Show the user the plan and the waves (`node scripts/loop/plan-doc.ts waves <slug>`),
   and ask for approval — setting `status: approved` is their call, not yours.
   At `risk: high`, `owner:` must name a human.
6. Only if the user approved (or passed `--compile`): set `status: approved` and run
   `node scripts/loop/plan-doc.ts compile`, then report the cards it queued.

Do not start implementing during this command. The deliverable is the document.
