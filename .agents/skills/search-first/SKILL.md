---
name: search-first
description: Use before answering or coding anything that depends on how a library, SDK, API, runtime built-in module, CLI flag, config format, or framework version behaves — including code examples given only in a reply.
---

# Search First

Treat API knowledge from training data as stale. Signatures change, flags disappear, recommended patterns flip between versions. Code written from memory is the hardest kind of wrong because it looks plausible and often compiles.

## Always verify when

- Calling an external library, SDK, or HTTP API
- Using a CLI flag, config file key, or environment variable name
- Relying on behavior tied to a version ("since 3.11", "in v5")
- You think "this should work" but have never run it
- An error message disagrees with what you remember; your memory is usually the stale side
- Showing a code example in a reply, even without touching a file — a wrong example gets copied as-is

## Verification order

1. **Installed version first.** Read `package.json` and the lockfile (or `requirements.txt`, `go.mod`, `Cargo.lock`). Docs for the wrong version are wrong docs.
2. **Official docs and changelog for that exact version.** Release notes and migration guides beat blog posts and Q&A answers.
3. **Existing usage in this codebase.** If the library is already used here, that pattern is this project's answer unless the docs say it is deprecated.
4. **Run it.** One REPL line or a throwaway script is cheaper than ten lines of guessing.

## Cost sense

Verify when checking is cheaper than being wrong, which is almost always. Re-reading docs for a stable standard-library call you use daily is waste. If what you found differs from memory, write that down so the next agent does not repeat the mistake.

Principal angle: if the pick becomes a pin other services inherit (shared build, base image, org-wide version), verify it against what those consumers already run, not just "it works here".

## In this harness

- This is the working half of the contract's dependency rule (CLAUDE.md senior-engineer defaults, "Dependencies": prefer proven dependencies over hand-rolled code). Search for the maintained library before hand-rolling, and say in the evidence why you did or did not take one.
- Record every doc URL and the version it describes in the card's `evidence/<YYYYMMDD>-<card>/` notes, next to the installed version you read from the lockfile.
- Adding a new dependency is its own reviewable change. The shipped template has no automated supply-chain scanner, so do not claim one ran: record the package, version, license, maintenance signal, and install scripts in evidence, run any audit gate your project has configured, and still pass `scripts/loop/health.sh`.
- If the docs cannot be reached (offline, blocked, paywalled), say so explicitly in the card and evidence, mark the code path as unverified, and prefer an existing in-repo usage over memory. Never present memory-based code as checked.
- A surprise worth keeping (renamed flag, changed default) goes to `node scripts/loop/knowledge.ts add --title "<one-line lesson>" --tags "<topic>" -- "<what happened and why>"`.

Adapted from songjiun10-collab/Senior-thinking-skills@be98e588 (MIT) — see docs/senior-thinking.md.
