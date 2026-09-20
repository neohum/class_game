---
name: weigh-tradeoffs
description: Use when choosing between libraries, data structures, architectures, or storage; when a decision is hard to reverse (schema, public API, data format, dependency); or when asked "which is better, A or B".
---

# Weigh Tradeoffs

## First: how heavy is this decision

Not every decision deserves the same deliberation.

- **Easily reversible** (a function's internals, file location, names) → build it, don't agonize, fix later.
- **Hard to reverse** (DB schema, public API, data format, core dependency, an interface already shipped) → take the time and take the alternatives seriously.

Confirmation follows the same tiers: reversible → just do it; irreversible → confirm first. Gate everything at the same weight and the gate itself gets ignored.

## How to compare

- Lay out 2-3 real alternatives with pros and cons in **one line each**: speed vs. complexity, flexibility vs. learning curve, easier now vs. easier later, performance vs. readability.
- Don't pick something just because it is familiar. Familiarity is a legitimate advantage, but it has to be a **stated** one.
- Price the cost of each alternative being wrong. When that cost is asymmetric (one is easy to back out of, the other isn't), it is usually the deciding factor.
- **Principal angle:** for a decision other teams will build against, add migration cost across consumers and whether this is the direction you want others defaulting to.

## Record the reason

- One or two sentences on why this option won, written where the next person will look.
- It must answer "why did we do it this way?" six months from now; if it can't, the next person rips it out.
- **Record the rejected alternatives too.** Without knowing why they lost, the next person walks the same path again.

## In this harness

- **Reversible:** the reason goes in the commit message or a code comment. Nothing more.
- **Hard to reverse:** record an ADR with `node scripts/loop/adr.ts add "<title>"` and fill in the chosen option, the rejected ones, and why. Check `docs/adr/` first; if an earlier ADR covers this, supersede it explicitly instead of contradicting it silently.
- The plan step that carries the decision gets a `Risk:` that reflects its weight; a hard-to-reverse choice is not `Risk: low`.
- **Irreversible and uncertain:** before committing, hand the chosen option to the `adversary` agent to argue against it, and address what it finds.

Adapted from songjiun10-collab/Senior-thinking-skills@be98e588 (MIT) — see docs/senior-thinking.md.
