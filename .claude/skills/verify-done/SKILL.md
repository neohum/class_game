---
name: verify-done
description: An evidence gate that must pass before claiming any task is complete. Use this at the end of every coding task, right before saying "done", "fixed", "implemented", or "should work", and whenever tempted to assume code works without running it. Applies to features, bug fixes, refactors, config changes, and one-off scripts alike. If work is being handed back to a human, this gate comes first.
---

# Verify Done

"Should work" is the most expensive phrase in agentic coding. Every unverified claim converts the human's one review pass into a debugging session, and after two of those they stop trusting anything you say. The standard is simple: evidence or it did not happen.

## The gate

Run every check that applies to the change. Actually run them; predicting their output is exactly the failure this skill exists to prevent.

1. **It builds.** Compile, bundle, or import the changed code. A syntax error in a "completed" task is a full trust reset.
2. **Tests pass, with numbers.** Run the relevant suite and read the summary line. Report real figures ("42 passed, 0 failed, 3 skipped"), never vibes ("tests look good"). If the suite was already failing before your change, report your delta against that baseline.
3. **Lint and typecheck are clean,** or at minimum unchanged from the baseline you recorded before starting.
4. **The actual thing was exercised.** Not just its unit tests: run the script on a real input, hit the endpoint with curl, load the page, invoke the CLI command the user will invoke. Show the observed output. Unit tests prove the pieces; one real execution proves the assembly.
5. **The diff is audited.** `git status` and `git diff` show only intended changes. No stray files, no leftover debug code, no accidental formatting churn across files you never meant to touch.
6. **Docs and config kept up.** If behavior, flags, environment variables, or setup steps changed, the README or relevant doc changed with them.

## Write it to disk (증거는 파일로 남는다)

Steps 1–6 produce output that lives for as long as one transcript. For any card the
loop carries — and always for a card that came from a plan document — the evidence
must survive the session:

```sh
node scripts/loop/evidence.ts open <card>                  # creates evidence/<YYYYMMDD>-<card>/
npm test 2>&1 | tee /tmp/out.txt
node scripts/loop/evidence.ts record <card> tests.txt < /tmp/out.txt
node scripts/loop/evidence.ts verify <card>                # exit 1 until it is complete
```

Fill all four sections of that directory's `README.md` — **WHAT WAS TESTED / WHAT
WAS OBSERVED / WHY IT IS ENOUGH / WHAT WAS OMITTED** — and keep at least one file of
real captured output beside it. Redact secrets rather than pasting them, and say in
"WHAT WAS OMITTED" that you did. `verify` is a ship gate: a card in scope with no
evidence is held for the owner instead of committed. See
[`docs/PLAN_DOCS.md`](../../../docs/PLAN_DOCS.md).

## Someone else's "success" is a claim, not evidence

A subagent's summary, a tool's "completed", another agent's "all tests pass", a CI badge you did not open: each is a claim about the work, not proof of it. Before you pass it on, re-run the check yourself or read the actual output (the log, the exit code, the diff) and confirm it says what the report says. If you cannot, relay it as unverified and name its source ("the builder reports green; I have not re-run it").

## Rationalization blockers

| Excuse | Reality |
|---|---|
| "It passed earlier" | The code changed since. Run it again, fresh and in full |
| "Lint/typecheck passed" | Static checks prove the code is well-formed, not that it behaves. "Works" needs the tests or a real run |
| "The bug is fixed, the code changed" | Reproduce the original symptom and watch it pass now. For a regression test, revert the fix and confirm the test fails |
| "I checked the part that matters" | A partial run proves only that part. Say which part, or run the rest |
| "Tests pass, so the requirements are met" | Walk the requirements (the card's `AC-*` lines) one by one against what you observed |

The rule follows the meaning, not the wording: "works now", "looks good", and "ready to merge" are completion claims too.

## Reporting rules

- State what was verified and HOW: the command run and the result observed.
- State plainly what was NOT verified and why: no staging environment, needs credentials, requires hardware, whatever the truth is. An honest gap the human can check beats a confident claim they cannot.
- Never round "probably" up to "definitely". Calibrated language is a feature: "tests pass; I could not verify the OAuth flow end to end because it needs live credentials" is a senior engineer's sentence.
- If verification is genuinely impossible in this environment, say so explicitly rather than skipping the step in silence.

## When the gate fails

Then the task is not done. Go back to work; do not negotiate with the gate, do not present the failure buried in the middle of a success narrative, and do not disable the check that failed. A red gate reported honestly costs a little pride. A green lie costs the relationship.

Partly adapted from songjiun10-collab/Senior-thinking-skills@be98e588 (MIT) — see docs/senior-thinking.md.
