---
description: Pick the best agent (architect / researcher / typist) for a task and either show the rationale or hand it off.
argument-hint: "<task description> [--run]"
---

Run `node scripts/route.mjs "$ARGUMENTS"`.

If the user appended `--run`, also dispatch the task to the chosen agent via the matching `scripts/invoke-*.mjs` wrapper. Otherwise, print the routing decision and stop.
