# Roles, routing and clients

> Loaded on demand. This carries the authority of [`AGENTS.md`](../AGENTS.md) and
> [`CLAUDE.md`](../CLAUDE.md), which name these rules in one line each and link
> here instead of restating them — every word kept in the always-loaded chain is
> re-read by every agent on every session.
>
> Read this when you are deciding **who does the work**: picking a lane, routing a
> task to a CLI, spawning a subagent, or wiring a new client.

## The 4-role pipeline

Every task card runs through four roles, in order. Each role is backed by the CLI
that plays to its strength:

| # | Role         | Backing CLI   | Owns                                                        |
| - | ------------ | ------------- | ----------------------------------------------------------- |
| 1 | **lead**     | Claude Max    | spec.md → task cards, sequencing, developer persona alignment |
| 2 | **explorer/control** | AGY Ultra | long-context mapping, dependency analysis, independent audit/fallback |
| 3 | **builder**  | Codex Pro     | claims a card, iterates code under the health gate |
| 4 | **reviewer** | Claude Max    | verifies unit against persona, commits + pushes, gated deploys |

Each client gets the same lanes in its native format:

- **Claude Code:** `.claude/agents/{lead,explorer,builder,reviewer}.md`
- **Codex:** `.codex/agents/{lead,explorer,builder,reviewer}.toml`
- **AGY:** `.agents/agents/{lead,explorer,builder,reviewer}/agent.md`

Shared, reusable workflows live in `.agents/skills/`, which Codex and AGY both
discover natively. Claude-specific skills remain under `.claude/skills/`.

For the unattended factory, the default execution lanes are `codex` and `agy`.
Claude owns lead/final review; AGY also owns exploration, independent audit,
control, and cloud fallback. Independence is decided on a trust domain rather
than an agent name, so if two lanes ever share model weights they count as one
opinion and cannot review each other.

**Top model by default.** Every roster CLI runs its strongest model unless
explicitly overridden: `claude` pins `--model opus`, `codex` runs its flagship
with `model_reasoning_effort="high"`, `gemini`/`agy` use their own flagship
defaults. Override per run with `CLAUDE_MODEL` / `CODEX_MODEL` /
`GEMINI_MODEL` / `AGY_MODEL` — downgrade deliberately (cost, rate limits),
never as a silent default.

**Token-budget exception (owner-approved 2026-08-03).** Claude-native execution
subagents (`builder`, `explorer`, `typist`, `researcher`) deliberately pin
Sonnet; the judgment lanes (`lead`, `validator`, `adversary`, `reviewer`) remain
on Opus. In the external autonomous loop, eligible low-risk implementation uses
Codex first; exploration uses AGY/Gemini. This is an
explicit cost/rate-limit override, not a weakening of the final review gate.

The **senior engineering playbooks** ship split by the lane that consumes them:
`repo-recon`, `tdd-loop`, `debug-protocol`, `safe-refactor` in `.agents/skills/`
(explorer/builder lanes); `plan-first`, `self-review`, `verify-done`,
`git-hygiene` in `.claude/skills/` (lead/reviewer lanes). Each role's agent file
says when its playbook applies; the to-be card pipeline
(`.claude/workflows/card-pipeline-tobe.mjs`) wires them into every stage.

## Client-native behavior

- In a **Claude Code** session, use Claude's native subagents, commands,
  permissions, and `.mcp.json` configuration.
- In a **Codex** session, use Codex subagents from `.codex/agents/` and project
  settings from `.codex/config.toml`.
- In an **AGY** session, use AGY subagents from `.agents/agents/`, workspace
  skills from `.agents/skills/`, and MCP servers from `.agents/mcp_config.json`.
- Do not interpret another client's private configuration as active instructions.
  `scripts/route.ts` is the explicit cross-CLI router and runs only when invoked.

## Orca 사용 안내

이 프로젝트는 Orca(워크트리·터미널·자동화·내장 브라우저를 관리하는 에이전트
오케스트레이션 앱/CLI) 환경에서 작업될 수 있다. Orca가 설치되지 않은
머신에서는 이 섹션을 무시한다.

- **언제 Orca CLI를 쓰나.** Orca가 관리하는 상태 — 워크트리(child worktree),
  폴더 컨텍스트, 터미널, 저장소, 자동화(automations), 워크트리 코멘트, Orca 앱
  내장 브라우저 — 를 만질 때, 그리고 "다른 에이전트/워크트리에 핸드오프",
  "워크트리에 codex/claude 띄워줘" 같은 요청일 때. 이때는 raw `git worktree`,
  임의 PTY, Playwright 대신 Orca CLI가 우선이다. Orca 상태와 무관한 작업은
  일반 셸 도구를 쓴다.
- **실행 파일 결정 (세션당 1회).** ① `ORCA_CLI_COMMAND` 환경변수가 있으면 그
  값 → ② dev 체크아웃(`ORCA_DEV_REPO_ROOT` 노출)이면 `orca-dev` → ③ Linux에서
  Orca 관리 터미널 밖이면 `orca-ide` (bare `orca`는 GNOME 스크린리더로 풀릴 수
  있으니 금지) → ④ 그 외에는 `orca`. 선택한 실행 파일이 실패하면 다른 것으로
  넘어가지 말고 에러를 그대로 보고한다.
- **가이드는 바이너리가 제공한다.** Orca 명령을 실행하기 전에
  `orca skills list` / `orca skills get <name>`으로 **버전 일치 가이드**를
  로드하고, 기계가독 명령 스키마는 `orca agent-context`로 얻는다. Orca 사용법을
  이 문서나 다른 파일에 하드코딩하지 말 것 — 실제 실행될 바이너리와 문서가
  어긋나는 드리프트를 막기 위한 Orca의 설계다.

## Role boundaries & Multi-Agent Collaboration (역할 분담 및 협업 구조)

이 저장소에서는 세 에이전트가 역할을 분담하여 개발 속도를 극대화합니다. 각 에이전트의 역할 범위를 준수하세요.

### 1. 에이전트별 최적의 역할 분담 (Role Matrix)

| 에이전트 | CLI | 주 역할 (Role) | 강점 및 활용 방식 |
| :--- | :--- | :--- | :--- |
| **architect** | `claude`→`agy`→`codex`→`gemini` | 수석 아키텍트 (Lead Architect) | • 시스템 설계, 데이터 모델링, API 명세 작성<br>• 복잡한 비즈니스 로직 예외 상황 분석 및 설계 검증<br>• 코드 리뷰 및 구조적 리팩토링 방향 제시 |
| **researcher** | `agy`→`gemini`→`claude`→`codex` | 실행 및 오케스트레이터 (Orchestrator/Executor) | • 파일 시스템 제어, 빌드, 패키지 설치, 자동 테스트 수행<br>• Claude의 설계를 바탕으로 다수 파일 생성 및 백그라운드 컴파일<br>• 하위 Subagent들을 병렬로 실행하여 여러 모듈을 동시에 작업 |
| **typist** | `codex`→`gemini`→`claude`→`agy` | 실시간 타이핑 조수 (Inline Assistant) | • IDE 내에서 개발자가 직접 코드를 수정할 때 빠른 자동완성 제공<br>• 간단한 함수 구현 및 단순 반복 보일러플레이트 라인 자동 작성 |

Run `node scripts/route.ts "<task>"` to see which agent the router picks.
Override with `--agent=architect|researcher|typist`. Each role resolves to the
first CLI **installed on this machine**, in the order shown — so a box without a
local node routes mechanical work to `codex` instead of dead-ending. Pin one with
`ROUTE_<ROLE>_CLI`.

### Token budget contract

- Keep Claude/Opus for lead architecture and final independent review. Route an
  otherwise to Codex (`node scripts/agent-session.ts --agent codex "<bounded
  task>"`), and route broad read-only discovery to AGY/Gemini. Claude reviews
  their diff and evidence instead of repeating the implementation itself.
- Batch independent `Read`, search, and shell checks into one assistant turn.
  When target paths are already known, do not issue one tool call per file.
- Use `TaskCreate`/`TaskUpdate` only for three or more independently trackable
  work units. A short checklist in the working response is enough for smaller
  tasks.
- Do not reread unchanged static instructions. `CLAUDE.md`/`AGENTS.md` are
  session context; consult `lat.md`, `DESIGN.md`, ADRs, and skills only when the
  current task actually touches them. Use `context-pruner.ts` for a large rule
  surface.
- Preserve every existing health, acceptance-evidence, independent-review, and
  high-risk gate. Token savings come from routing, batching, and deduplication,
  never from skipping required evidence.

### 2. 개발 단계별 속도 개선 효과 (Speedup Analysis)

*   **① 계획 및 설계 단계 (Claude ↔ AGY)**: **시간 기준 약 40% ~ 50% 단축**
    *   Claude가 API 스펙 및 데이터베이스 설계를 작성하면, AGY가 이를 받아 Mock 서버나 초기 엔티티 클래스를 즉시 빌드해 검증하여 설계 오류를 코딩 시작 전에 차단합니다.
*   **② 보일러플레이트 및 CRUD 구현 (AGY ↔ Codex)**: **시간 기준 약 200% ~ 300% (2~3배) 단축**
    *   AGY는 독립된 Subagent들을 띄워 백엔드 API, 마이그레이션, 유닛 테스트 작성을 병렬(Parallel)로 처리합니다. 개발자는 Codex의 지원을 받아 핵심 로직만 개발합니다.
*   **③ 디버깅 및 테스트 (AGY 자동 피드백 루프)**: **시간 기준 약 50% 단축**
    *   AGY가 빌드/테스트 실패 시 오류 로그를 분석하여 자동으로 수정안을 제안하고 반영합니다.

### 3. 멀티 에이전트 협업 시의 주의점 (Bottlenecks)

1.  **컨텍스트 동기화 및 병합 충돌 (Merge Conflicts)**: 동시에 여러 에이전트가 동일 파일을 수정하면 충돌이 납니다. 모듈별/기능별 독립된 브랜치나 분리된 디렉터리를 지정하여 에이전트를 구동하세요.
2.  **휴먼 인 더 루프 (Human-in-the-Loop) 오버헤드**: 에이전트가 잘못된 컨텍스트로 환각을 일으킬 수 있으므로 **단계별 검토 프로세스(Gatekeeping)**가 핵심입니다.
