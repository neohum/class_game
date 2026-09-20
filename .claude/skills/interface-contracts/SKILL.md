---
name: interface-contracts
description: Use when designing or changing a surface other code depends on, such as exported functions, module boundaries, CLI flags, file formats, JSON shapes, API endpoints, or script verbs that other scripts call.
---

# Interface Contracts

## Hyrum's Law

With enough consumers, every observable behavior of your system is depended on by somebody, whatever the contract says. Error message wording, output ordering, exit codes, field presence, even timing: whatever is visible becomes a de facto promise.

- Expose deliberately. Anything visible is a candidate promise; keep implementation details out of reach.
- Anything that would be painful to remove later, decide at design time whether to expose it at all.
- Passing tests is not the same as safe. A contract suite does not protect a consumer who relied on undocumented behavior.
- Principal angle: this is how blast radius crosses boundaries. A field or string never meant as a promise gets consumed elsewhere, and your "internal" change becomes someone else's incident.

## Define the interface first

The contract is the spec; the implementation only satisfies it.

- Write the call site from the caller's side before the body. Implementation-first yields an API that is easy to build; interface-first yields one that is easy to use.
- State signatures, input/output shapes, and guarantees: idempotency, partial updates, what happens on failure.
- Spell out error cases: missing resource, invalid input, partial failure, and how each is represented.
- Make misuse hard: no argument orders that invite mix-ups, invalid states unrepresentable where you can.
- Prefer deep modules: a small interface hiding a lot of behavior. If the interface is as complicated as the internals, the boundary is in the wrong place.

## One version

Never make consumers choose between versions of the same interface. Extend it compatibly (new optional field, new flag with the old default) instead of forking it. When a break is unavoidable, the migration path and deprecation window are part of the design, not cleanup afterward.

## Checklist

- Does this expose anything that could unintentionally become a promise (message wording, ordering, internal names)?
- How painful is it to change later? The more painful, the more care now.
- Is ownership and shape of data crossing the boundary clear?
- Does the change alter any behavior an existing consumer observes, documented or not? Search the callers, not just the tests.
- Did you label shortcuts (hardcoded values, temporary workarounds) so the next reader neither fears nor blindly deletes them?

## In this harness

- **Architect** applies this when designing a plan step that introduces or reshapes a surface.
- **Reviewer** applies it when a diff changes an exported or public surface: CLI flags, file formats read by other tools, JSON shapes, or `scripts/loop/*` verbs other scripts or skills invoke. Grep for every caller before signing off.
- A change to a contract others depend on raises the plan's `Risk:` level; a silent break is a review failure even when tests pass.
- If the choice is hard to reverse, record it: `node scripts/loop/adr.ts add "<title>"` writes to `docs/adr/`.

Adapted from songjiun10-collab/Senior-thinking-skills@be98e588 (MIT) — see docs/senior-thinking.md.
