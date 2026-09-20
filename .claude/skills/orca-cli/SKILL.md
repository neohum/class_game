---
name: orca-cli
description: >-
  Use the public `orca` CLI to operate Orca-managed worktrees, folder contexts,
  terminals, repos, automations, artifacts, skill sharing, worktree comments, and the browser
  embedded inside the Orca app. Use when the user says "$orca-cli", "use orca cli",
  "Orca worktree", "child worktree", "cardStatus", "spawn codex/claude in a worktree",
  "read/wait/send Orca terminal", "terminal send", "full handoff", "handover",
  "give this to another agent", "another worktree", "Orca browser", "orca artifacts",
  "share HTML/Markdown", "public artifact link", "share skills", or "control the browser inside
  Orca". Prefer this over raw `git worktree`, ad hoc
  PTYs, Playwright, or Computer Use when the task touches Orca-managed state.
  Use Computer Use for browser windows, webviews, or desktop UI outside Orca's
  embedded browser.
---

# Orca CLI

This file is a discovery stub, not the usage guide. The full, version-matched Orca CLI
reference is served by the `orca` binary itself — kept out of this file on purpose so it
can never drift from the binary that will actually run your commands.

Engage Orca whenever its running editor/runtime is the source of truth: Orca-managed
worktrees, folder contexts, terminals, repos, automations, worktree comments, and the
browser embedded inside the Orca app. Triggers include "$orca-cli", "Orca worktree",
"child worktree", "spawn codex/claude in a worktree", "read/wait/send Orca terminal",
"full handoff" / "handover" / "give this to another agent", and "control the browser
inside Orca". Use plain shell tools when Orca state does not matter.

## Resolve the CLI for this session

Choose the executable once and reuse it for every later command:

- If the `ORCA_CLI_COMMAND` environment variable is set, use its value. Orca exports this
  for managed WSL sessions.
- Otherwise, in a dev checkout whose session exposes `ORCA_DEV_REPO_ROOT`, use `orca-dev`.
- Otherwise, on Linux outside an Orca-managed terminal, use `orca-ide`. Never run bare
  `orca` there — outside Orca's terminals it normally resolves to the
  GNOME Orca screen reader (`/usr/bin/orca`) and starts speech on the user's machine.
- Otherwise, use `orca` (or fast bridge `node scripts/orca.ts`).

Below, `ORCA` is a placeholder for the executable you resolved. Substitute it before
running anything; do not create a shell variable or run `ORCA` literally.

## Load the full guide before running Orca commands

```text
ORCA skills get orca-cli
# 또는
node scripts/orca.ts guide orca-cli
```

That prints the complete, version-matched guide for the exact binary that will handle your
next commands — worktrees, handoffs, terminals, automations, and the built-in browser.
Read it first, then run the specific command you need.
