# HARNESS.md — how this multi-agent harness works

This project ships with a three-agent harness:

```
       user / Claude Code
              │
              ▼
   ┌───────── route.mjs ─────────┐
   │  heuristic task router       │
   └──────┬──────────┬───────────┘
          │          │
    ┌──────▼──┐  ┌──────▼──────┐  ┌──────────┐
    │architect│  │ researcher  │  │  typist  │
    │ (claude)│  │ antigravity │  │  (codex) │
    └─────────┘  └─────────────┘  └──────────┘
```

## Files that drive it

| File                              | Role                                             |
| --------------------------------- | ------------------------------------------------ |
| `CLAUDE.md`                       | shared conventions; loaded by Claude Code        |
| `lat.md`                          | code-graph / file-level map of the repo          |
| `DESIGN.md`                       | UI/UX system contract                            |
| `.claude/agents/*.md`             | per-agent identity & lane                        |
| `.claude/commands/*.md`           | slash commands (`/route`, `/analyze`, `/design`) |
| `.claude/settings.json`           | allowed shell commands                           |
| `.mcp.json`                       | MCP servers (filesystem, github, postgres)       |
| `scripts/route.mjs`               | picks an agent for a task                        |
| `scripts/invoke-{claude,codex,antigravity}.mjs` | thin CLI wrappers                       |

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

## Adding a new MCP server

Edit `.mcp.json`, restart Claude Code. Reference env vars with `${VAR}` — Claude Code expands them.

## Adding a new agent

1. Drop a new markdown file in `.claude/agents/` with frontmatter (`name`, `description`, `tools`).
2. Add a signal block to `scripts/route.mjs` so it can be routed automatically.
3. Optionally add `scripts/invoke-<name>.mjs` if it wraps an external CLI.
