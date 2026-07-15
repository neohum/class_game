# HARNESS.md — how this multi-agent harness works

This project ships with a three-agent router and native adapters for Claude
Code, Codex, and AGY:

```
       user / native client
              │
              ▼
   ┌───────── route.mjs ─────────┐
   │  heuristic task router       │
   └──────┬──────────┬───────────┘
          │          │
    ┌──────▼──┐  ┌──────▼──────┐  ┌──────────┐
    │architect│  │ researcher  │  │  typist  │
    │ (claude)│  │    (agy)    │  │  (codex) │
    └─────────┘  └─────────────┘  └──────────┘
```

## Files that drive it

| File                              | Role                                             |
| --------------------------------- | ------------------------------------------------ |
| `AGENTS.md`                       | shared contract; loaded by Codex and AGY          |
| `CLAUDE.md`                       | Claude adapter; imports `AGENTS.md`               |
| `lat.md`                          | code-graph / file-level map of the repo          |
| `DESIGN.md`                       | UI/UX system contract                            |
| `.claude/agents/*.md`             | per-agent identity & lane                        |
| `.claude/commands/*.md`           | slash commands (`/route`, `/analyze`, `/design`) |
| `.claude/settings.json`           | allowed shell commands                           |
| `.codex/agents/*.toml`            | Codex-native custom agents                       |
| `.codex/config.toml`              | Codex-native project MCP and agent settings      |
| `.agents/agents/*/agent.md`       | AGY-native custom agents                         |
| `.agents/mcp_config.json`         | AGY-native workspace MCP servers                 |
| `.mcp.json`                       | Claude-native MCP servers                        |
| `scripts/route.mjs`               | picks an agent for a task                        |
| `scripts/invoke-{claude,codex,agy}.mjs` | thin CLI wrappers                               |

## Daily usage

```bash
# 1. see which agent handles a task
node scripts/route.mjs "rename FooBar to FooBaz across lib/"

# 2. run it
node scripts/route.mjs "rename FooBar to FooBaz across lib/" --run

# 3. force a specific agent
node scripts/route.mjs "draft a migration plan for auth" --agent=architect --run
```

In Claude Code, the same actions are available as slash commands:
`/route`, `/analyze`, `/design`.

When you work directly in Claude Code, Codex, or AGY, stay on that client's
native agent surface. The cross-CLI router is an explicit opt-in for tasks where
you intentionally want another provider to take a lane.

## Adding a new MCP server

Add the server to the native config for every client that should expose it:

- Claude Code: `.mcp.json`
- Codex: `.codex/config.toml`
- AGY: `.agents/mcp_config.json`

Keep credentials in environment variables and restart the client after changes.

## Adding a new agent

1. Add the role in each client-native location that should expose it:
   `.claude/agents/<name>.md`, `.codex/agents/<name>.toml`, and
   `.agents/agents/<name>/agent.md`.
2. Add a signal block to `scripts/route.mjs` so it can be routed automatically.
3. Optionally add `scripts/invoke-<name>.mjs` if it wraps an external CLI.
