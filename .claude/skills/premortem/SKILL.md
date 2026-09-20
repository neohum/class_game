---
name: premortem
description: Use before implementing or planning work that touches I/O, user input, external services, concurrency, or persisted state; when adding error handling; or when judging whether a design is production-ready.
---

# Premortem

Ask **"when does this break"** before "does this work". Asked afterwards, defensive code gets bolted on piecemeal; asked up front, it changes the structure.

## Where it breaks

- Input empty, null, or 100x larger than expected?
- Network, file, or external API fails, or responds **slowly**? A timeout is harder to handle than an outright failure.
- The same code runs twice concurrently? A duplicate request arrives?
- The process dies mid-operation: is data left **half-written**?
- Encoding, timezone, floating point: anything that drifts silently?
- **Principal angle:** does the blast radius stay inside this codebase, or does it corrupt shared state, a downstream team's data, or a contract another service depends on? Scope the premortem to the real blast radius.

You don't have to answer every question. Pick the ones that apply, and decide for each whether to defend against it or deliberately skip it. **A skipped failure mode is written down, not silently ignored.**

## How would anyone notice

Code that fails silently is far more dangerous than code that fails loudly.

- If this fails in production, **who** finds out, and **how**?
- Are exceptions swallowed (`except: pass`, an empty catch)?
- Does the error message name **which value** was the problem?
- Is there a path that fails but looks like success: partial success, or an empty result returned as if complete?

## In this harness

- Run it before writing the steps of a plan document (`plans/<slug>.plan.md`), while the structure can still change.
- Every credible failure lands in exactly one place:
  - an `Acceptance:` line or test on the step that must defend against it,
  - a higher `Risk:` on that step when it can't be fully defended, or
  - the plan's `## Non-goals`, stated as an accepted risk.
- A failure that lands nowhere is the silent skip this skill exists to prevent.
- Paths the premortem flags as high-risk (auth, secrets, payments, migrations) are also scored on the card's actual diff by `node scripts/loop/framein.ts risk <card>`; the autonomous loop holds a `high` card for a human tap.

Adapted from songjiun10-collab/Senior-thinking-skills@be98e588 (MIT) — see docs/senior-thinking.md.
