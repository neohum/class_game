<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:agent-harness-native -->
## Client-native agent harness

- **Claude Code** loads `CLAUDE.md`, `.claude/agents/`, `.claude/settings.json`,
  and `.mcp.json`.
- **Codex** loads this `AGENTS.md`, `.codex/agents/`, and
  `.codex/config.toml`.
- **AGY** loads this `AGENTS.md`, `.agents/agents/`, `.agents/skills/`, and
  `.agents/mcp_config.json`.
- Use the active client's native agents and configuration. Do not treat another
  client's private configuration as active instructions.
- `node scripts/route.mjs "<task>" --run` is the explicit cross-CLI router; it
  invokes Claude for architecture, AGY for research, and Codex for bounded edits.
<!-- END:agent-harness-native -->
