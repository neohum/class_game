---
name: safe-refactor
description: Change code structure without changing behavior, in small verified steps. Use this for refactoring, renaming, extracting functions or modules, moving files, removing duplication, dependency and framework migrations, and any "clean this up" or "improve this code" request. Especially important when test coverage is thin, the codebase is unfamiliar, or the diff will exceed a couple hundred lines.
---

# Safe Refactor

A refactor that changes behavior is the worst kind of bug: invisible in review, because everyone reading the diff has been told "no behavior change" and reads accordingly. The whole discipline here is making that promise actually true, and keeping every step small enough that a mistake is trivially findable.

## Ground rules

### 1. Green before you start

Run the test suite over the target area first. If it is red, fix or flag that separately; you cannot preserve behavior you cannot observe. If coverage over the code you are about to reshape is thin, write characterization tests first: tests that pin down what the code currently does, even where the current behavior is ugly. You are photographing the building before moving the walls.

### 2. Know why it exists before you remove it (Chesterton's Fence)

Before deleting, collapsing, or "simplifying" anything you did not write (a guard that looks redundant, a branch that looks dead, an odd ordering, a wrapper that seems pointless), find out why it is there. If you cannot answer, you are not ready to touch it.

- **History:** `git log -L <start>,<end>:<file>` or `git blame` to the commit that introduced it; read that message and its PR or issue.
- **Callers:** search every caller and importer, then the invisible ones from rule 6. "Looks unused" needs outside confirmation: other services, config, production logs.
- **Tests:** is there a test that pins this behavior? If a test breaks when you remove it, the test is telling you the reason.
- **Decisions:** check `docs/adr/` for a record that explains the constraint.

Then judge whether the reason still holds today (a dropped platform, a fixed upstream bug, a constraint that is gone):

- **Reason gone:** remove it, and put the reason and why it no longer applies in the commit message, so the next reader does not rebuild the fence.
- **Reason still holds:** keep the constraint. If the code is complex, look for a simpler form that meets the same constraint; never simplify by silently dropping it.
- **Reason unknown after looking:** leave it and flag it. Unrelated dead code you notice is mentioned, not deleted; it is out of scope.

Principal angle: if the fence enforces a contract other teams or services rely on (a shared library, an API shape, a config format), removing it is not a local call; confirm who depends on it before you act, not after their build breaks.

### 3. Refactor commits contain zero behavior change

Structure changes and behavior changes go in separate commits, always. A reviewer can verify "moved code, nothing else" at a glance and "changed logic" with care, but a commit that does both gets neither kind of review. If you spot a real bug mid-refactor, note it, finish or pause the refactor, and fix the bug as its own commit.

### 4. Small mechanical steps, tests between each

One rename. Run tests. One extraction. Run tests. One file move. Run tests. This feels slow and is actually fast, because when something breaks you know it was the last step, not one of forty. Commit at each green state so any single step can be reverted alone.

### 5. Use real tooling for renames

Language-aware rename (LSP, IDE-grade tooling) over naive find-and-replace across the repo. Blind textual replace hits substrings, comments, string literals, and unrelated symbols that happen to share the name. Where only text search is available, review every single match before applying, and search for the old name afterward to confirm zero survivors.

### 6. Watch the blast radius

Anything whose signature, name, or location changes: find all callers and importers and update them in the same step. Then hunt the references tools cannot see: reflection, dynamic imports, string-built attribute access, config files, serialized data, templates, and docs that mention the old name. These are where "safe" refactors go to die.

## Definition of done

- Full suite green, and snapshot or golden-file tests show no diffs (unless an intended cosmetic diff was called out explicitly).
- No public API changes unless the user asked for them.
- Old names return zero search hits.
- The diff reads as an obvious improvement. If the result is not clearly better, simpler, or more consistent, question whether the refactor earned its risk.
- Every removed or simplified guard, branch, or workaround has its original reason and why it no longer applies recorded in the commit message.

Partly adapted from songjiun10-collab/Senior-thinking-skills@be98e588 (MIT) — see docs/senior-thinking.md.
