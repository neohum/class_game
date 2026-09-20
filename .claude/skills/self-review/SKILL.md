---
name: self-review
description: Review the complete diff as a skeptical senior reviewer before handing work back. Use this after finishing any code change and before declaring it done, before committing a substantial diff or opening a pull request, and whenever the user says "review", "check this", or "is this ready". Includes a lightweight security sweep of the changed lines. Make this the last step of every non-trivial coding task.
---

# Self Review

The author's context is a blindfold: you know what the code is supposed to do, so that is what you see. Switching deliberately into reviewer mode catches a different class of bug than writing ever will. You wrote it fast; now read it slow.

## Process

Pull up the FULL actual diff (`git diff`, or a diff of every changed file), not your memory of what you changed. Memory is flattering. Read it top to bottom as if a stranger you slightly distrust wrote it, and fix what you find before handing anything back.

**Shed the author's context.** Read the diff cold: set aside why you wrote it that way and ask what a first-time reader would ask (when is this null? why is this condition here?). Re-derive the intent from the card or plan document, not from your memory of the task. Anything you cannot confirm from the diff itself is marked unconfirmed, not waved through. Don't pre-filter findings as "probably fine"; list them, then judge.

## Two verdicts, judged separately

Mixing both judgments into one pass misses both. Give each axis its own verdict (pass / fail with findings).

1. **Spec compliance.** Against the card's or plan's `AC-*` lines: is every criterion met, is anything missing, and did anything get built that nobody asked for?
2. **Code quality and standards.** The checklist below: correctness, error handling, security, consistency, tests.

Code that is clean but builds the wrong thing fails axis 1; code that does the right thing badly fails axis 2. Neither verdict excuses the other.

## The checklist

**Correctness.** Does each hunk do what the task asked, and only that? Walk the unhappy paths deliberately: empty input, null/None, zero, one, many, absurdly large, unicode, concurrent access. Most production bugs live in the cases the happy-path author never imagined receiving.

**Leftovers.** Debug prints and temporary logging. Commented-out code. TODOs you meant to resolve this session. Unused imports. Dead branches. Then run `git status` and scan for stray files: editor droppings, test artifacts, an unrelated file you touched while exploring.

**Error handling.** Failures should surface, not vanish. No bare catch-and-ignore. Error messages should tell the next person what went wrong and what to do, not just that something did.

**Security sweep (changed lines only).** Does any user-controlled input reach a SQL query, shell command, file path, HTML output, or deserializer without validation or escaping? Any hardcoded secret, token, key, or password? Any new dependency, and if so, is it genuinely needed and reasonably well known? Any auth or permission check that the change weakened or bypassed? This two-minute pass on the diff catches the embarrassing majority of vulnerabilities.

**Consistency.** Names, style, and patterns match the surrounding file. Code that ignores local convention reads as wrong even when it is correct, and it costs review cycles.

**Tests.** New behavior has coverage. The tests assert behavior, not implementation detail. And the tests would actually fail if the feature broke; a test that cannot fail is decoration.

**Size and scope.** Around 100 changed lines reviews in one pass; around 300 is fine only as one logical unit and is worth splitting otherwise; around 1000 must be split unless it is mechanical (a rename, generated code). Refactoring mixed into feature work is two changes. Every hunk should trace to the request; drive-by tidying goes in a note, not the diff. If the change touches a shared interface, config format, or anything other code depends on, check the callers beyond this diff too.

**No deferred cleanup.** Don't accept "I'll clean it up later" from yourself: fix it in this change, or record it as a follow-up with an owner.

## Label findings

Lead with correctness and security; don't bury one real problem under ten nits. An unlabeled finding is treated as Critical: it blocks handoff until fixed.

| Label | Meaning |
|---|---|
| **Critical:** | Blocks handoff: security hole, data loss, broken behavior |
| **Nit:** | Minor style or preference, safe to ignore |
| **Optional:** | A suggestion worth weighing, not required |
| **FYI:** | Information only, no action |

## Report honestly

After fixing findings, rerun the tests and re-check the diff. Then summarize for the human: what changed, what was deliberately NOT done, and any known limitations or assumptions. A report that admits its gaps is trusted; a report that claims perfection is audited. Never present code containing a known compromise without saying so out loud. State both verdicts (spec compliance, code quality) and any open Critical findings explicitly.

Partly adapted from songjiun10-collab/Senior-thinking-skills@be98e588 (MIT) — see docs/senior-thinking.md.
