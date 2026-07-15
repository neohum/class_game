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

## 게임 제작 기본 원칙 (필수)

`public/games/` 아래에 게임을 새로 만들거나 수정할 때는 **반드시**
`docs/GAME_PRINCIPLES.md`를 먼저 읽고 그 원칙(오른쪽 클릭 방지, 멀티터치 즉시 반응,
1·2·4·6인 구성, 학년별 세로 배치, 플레이어 가로 분할, 좁은 컬럼 시 최대 3인 제한)을
전부 적용한다.

게임 **제작 요청을 받으면** 먼저 `docs/GAME_REQUEST_TEMPLATE.md` 양식과 대조해
빠진 필수 항목(게임 내용, 규칙, 대상 학년, 승리/종료 조건, 입력 방식)만 되묻는다.
입력 방식이 드래그/넓은 보드면 원칙 6에 따라 최대 3인으로 자동 판정하고,
공통 사항은 양식이 아니라 `docs/GAME_PRINCIPLES.md`를 따른다.
