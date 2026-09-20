---
name: threat-and-scale-check
description: Use when code handles user input, external responses, files, or auth; when designing permissions, validation, or safeguards; when data volume could grow; when loops touch I/O; or when one safeguard is the only protection.
---

# Threat and Scale Check

## Trust boundaries

Draw the line between what you control and everything else, then check what crosses it.

- Is user input, an external API response, or file content trusted as-is? Does it reach SQL, a shell command, a file path, or HTML without validation or escaping?
- Are passwords, API keys, or tokens exposed in code, logs, error messages, or captured output?
- Does this action need a permission check? Is a client-supplied claim ("I am an admin") being believed?
- Is validation enforced at only one point (client only, or a DB constraint only)?
- Principal angle: if this boundary crosses a service or team line, a gap here is not a local bug; it is a contract others inherit and copy.

## Scale: 10x and 1000x

Working at 100 records today proves nothing.

- Does the approach hold when data grows 10x or 1000x?
- Is there a query, network call, or file read inside a loop (N+1)?
- Is everything loaded into memory at once when it could be streamed or batched?
- Is there a bound: timeouts, retry caps, page limits, maximum sizes?
- Do not optimize without measuring first. Confirm the bottleneck is here before touching it.

## Layered defense

A structure where the next layer catches a failure beats betting on one perfect defense.

- If this safeguard fails, is it an immediate incident, or is there another layer behind it? Name that second layer explicitly. If you cannot, the design is not done.
- Block unconscious mistakes, allow conscious choices, leave a trace. Block everything and people route around it; allow everything and it becomes an incident.
- Verify blocks too. Do not stop at "it was blocked": confirm why, and that the reason holds under other conditions.

## In this harness

- **Reviewer** runs this on any diff touching input parsing, file paths, auth, external calls, or loops over I/O. Report each finding with the boundary it crosses and the second layer that would catch it.
- Anything in auth or permissions, secrets, schema migrations, payments, or production deploys is **Tier 3**: a human approves, regardless of model confidence. See `docs/AUTONOMY.md`. Do not downgrade the tier because the change looks small.
- Existing layers to name rather than duplicate: `framein.ts risk` path scoring, `data-contract.ts` (fail-closed), `release-policy.ts` promotion order, and the sandbox. None of them alone is the defense.
- Scale concerns that need numbers go to `evidence/` as measurements, not assertions.

Adapted from songjiun10-collab/Senior-thinking-skills@be98e588 (MIT) — see docs/senior-thinking.md.
