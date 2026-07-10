---
name: design-orchestrator
description: "수학적·미적으로 아름답고 트렌드를 반영하는 UI/UX 디자인 시스템을 에이전트 팀으로 생성하는 오케스트레이터. '디자인 시스템 만들어줘', '디자인 토큰 설계', 'UI/UX 디자인 해줘', '컬러·타이포·그리드 시스템 구축', '아름다운 웹 디자인 만들어줘' 요청 시 반드시 사용. 트렌드 조사→기하 골격→미적 표면→토큰 종합→품질 검수의 전체 파이프라인을 팀으로 조율. 단순 색 추천이나 단일 컴포넌트 스타일링이 아닌, 일관된 디자인 시스템 산출이 목적일 때."
---

# Design Orchestrator — 디자인 시스템 생성 팀 조율

수학적으로 아름답고(비율·그리드·기하), 미적으로 아름다우며, 트렌드를 반영하는 **프레임워크 비의존 디자인 시스템**을 에이전트 팀으로 생성한다. 산출물은 `design-system/`의 `tokens.json` + `tokens.css` + `DESIGN_GUIDE.md`.

## 실행 모드: 에이전트 팀

팬아웃/팬인 + 생성-검증 복합 패턴. 트렌드·기하·미감이 병렬 협업하고, 종합 후 검수가 검증한다. director가 리더.

## 에이전트 구성

| 팀원 | 에이전트 타입 | 역할 | 스킬 | 출력 |
|------|-------------|------|------|------|
| design-director | design-director (커스텀) | 리더·브리프·언어선택·종합 | design-orchestrator | `_workspace/00_director_brief.md` |
| trend-researcher | general-purpose | 트렌드 조사·레퍼런스 | design-trend-research | `_workspace/01_trend_research.md` |
| geometry-architect | geometry-architect (커스텀) | 비율·그리드·스케일 | geometry-system | `_workspace/02_geometry.md` |
| aesthetic-designer | aesthetic-designer (커스텀) | 색·타이포·위계 | aesthetic-system | `_workspace/03_aesthetics.md` |
| token-synthesizer | token-synthesizer (커스텀) | 토큰 종합·패키징 | design-tokens | `design-system/*` |
| design-critic | general-purpose | 검수·접근성·무결성 | design-critique | `_workspace/04_critique.md` |

> 6명은 팀 크기 상한에 가깝다. director는 리더로서 팀원이자 조율자이며, 실제 병렬 작업자는 5명이다. 작업이 작으면 trend-researcher를 생략하고 director가 직접 방향을 잡아 4명으로 줄인다.

## 워크플로우

### Phase 1: 준비 (director)
1. 사용자 브리프 분석 — 제품 성격, 타깃, 무드, 제약, 선호 디자인 언어를 파악.
2. **크로스프로젝트 recall (재사용 > 재학습)** — 생성 전, 중앙 허브에서 유사 디자인 결정·축적된 안목 원리를 불러온다: `node scripts/loop/knowledge.mjs recall "<제품유형/무드 키워드>"`. 다른 프로젝트에서 이미 검증된 팔레트·스케일·언어 선택이 있으면 출발점으로 삼는다. (허브 read 엔드포인트가 켜지면 전 프로젝트에 걸쳐 작동 — `docs/KNOWLEDGE_HUB.md`.)
3. 작업 디렉토리에 `_workspace/`와 `design-system/` 생성.
4. **디자인 언어 확정** — 4축(미니멀/스위스·모던 SaaS·브루탈리즘·기하) 중 주축 선택 또는 블렌딩. 근거와 함께 `_workspace/00_director_brief.md`에 고정.
5. **방향 반론(adversary)** — 확정한 디자인 언어를 `adversary` 에이전트로 레드팀한다: "경쟁 제품의 디자인 언어가 이 브리프에 더 맞는 이유"를 만들게 해, 확증편향으로 약한 방향을 고정하는 것을 막는다. taste-judge(주관)·critic(객관)에 더해 **방향 자체**를 검증하는 축.

### Phase 2: 팀 구성 (director)
1. 팀 생성:
   ```
   TeamCreate(
     team_name: "design-system-team",
     members: [
       { name: "trend-researcher",  agent_type: "general-purpose",   model: "opus", prompt: "design-trend-research 스킬로 선택된 디자인 언어의 동시대 트렌드를 조사. _workspace/00_director_brief.md를 먼저 읽어라." },
       { name: "geometry-architect", agent_type: "geometry-architect", model: "opus", prompt: "geometry-system 스킬로 수학적 골격(스케일·간격·그리드) 설계." },
       { name: "aesthetic-designer", agent_type: "aesthetic-designer", model: "opus", prompt: "aesthetic-system 스킬로 색·타이포·위계 설계." },
       { name: "token-synthesizer",  agent_type: "token-synthesizer",  model: "opus", prompt: "design-tokens 스킬로 02/03을 토큰 3종으로 종합." },
       { name: "design-critic",      agent_type: "general-purpose",    model: "opus", prompt: "design-critique 스킬로 산출물을 정량 검수. scripts/contrast.mjs 실행." }
     ]
   )
   ```
2. 작업 등록 (의존성 명시):
   ```
   TaskCreate(tasks: [
     { title: "트렌드 조사",   assignee: "trend-researcher" },
     { title: "기하 골격 설계", assignee: "geometry-architect", depends_on: ["트렌드 조사"] },
     { title: "미적 표면 설계", assignee: "aesthetic-designer", depends_on: ["트렌드 조사"] },
     { title: "기하 부분검증",  assignee: "design-critic",      depends_on: ["기하 골격 설계"] },
     { title: "미감 부분검증",  assignee: "design-critic",      depends_on: ["미적 표면 설계"] },
     { title: "토큰 종합",     assignee: "token-synthesizer",  depends_on: ["기하 골격 설계", "미적 표면 설계"] },
     { title: "전체 검수",     assignee: "design-critic",      depends_on: ["토큰 종합"] },
     { title: "최종 종합·승인", assignee: "design-director",    depends_on: ["전체 검수"] }
   ])
   ```

### Phase 3: 병렬 설계 (팬아웃)
**실행 방식:** 팀원 자체 조율.

- trend-researcher가 먼저 조사 → 적용 힌트를 geometry·aesthetic에 **SendMessage**로 전달.
- geometry-architect와 aesthetic-designer가 **병렬**로 설계.
- 둘은 SendMessage로 상호 제약을 교환한다: geometry→aesthetic은 그리드/스케일 제약, aesthetic→geometry는 시각 균형 요청. 충돌은 director가 언어 기준으로 중재.
- critic은 각 산출 직후 **증분 검증**(스케일 정합, 색 대비).

**산출물 저장:**

| 팀원 | 출력 경로 |
|------|----------|
| trend-researcher | `_workspace/01_trend_research.md` |
| geometry-architect | `_workspace/02_geometry.md` |
| aesthetic-designer | `_workspace/03_aesthetics.md` |

### Phase 4: 종합과 검수 (팬인 + 생성-검증)
1. token-synthesizer가 02/03을 읽어 `design-system/tokens.json` + `tokens.css` + `DESIGN_GUIDE.md` 생성 (design-tokens 스킬, token-schema 표준).
2. design-critic이 전체 검수 → `_workspace/04_critique.md`. 치명/주의 결함은 token-synthesizer에 SendMessage로 수정 경로 전달.
3. **생성-검증 루프**: 결함 → 재종합 → 재검증, **최대 2회**. 2회 후에도 잔여 결함이 있으면 가이드에 명시하고 진행.
4. director가 critic 통과를 확인하고 최종 승인.

### Phase 5: 정리 (director)
1. 팀원에게 종료 요청, 팀 정리(TeamDelete).
2. `_workspace/` 보존(감사 추적). `design-system/`이 최종 산출물.
3. 사용자에게 요약 보고: 선택 언어 + 근거, 토큰 하이라이트, critic 통과 현황, 잔여 결함(있으면).

## 데이터 흐름

```
[director] 00_brief (언어확정)
     ↓ TeamCreate + TaskCreate
[trend] 01 ──SendMessage(힌트)──┐
                                 ↓
        [geometry] 02 ←SendMessage(제약)→ [aesthetic] 03
                    │  (critic 증분검증)   │
                    └────────┬────────────┘
                             ↓ Read
                  [token-synthesizer] design-system/*
                             ↓ SendMessage(검증요청)
                  [critic] 04_critique ──(결함)──┐
                             ↑                    │
                             └──── 재종합(≤2회) ──┘
                             ↓ (통과)
                  [director] 최종 승인 + 보고
```

## 에러 핸들링

| 상황 | 전략 |
|------|------|
| 팀원 1명 실패/중지 | 리더 감지 → SendMessage 확인 → 재시작. 재실패 시 해당 영역 없이 진행, 가이드에 누락 명시 |
| trend-researcher 웹 접근 실패 | director가 직접 언어 기조를 잡아 진행, 트렌드 정렬 검증은 정성 위주로 |
| geometry↔aesthetic 충돌 | 삭제 금지, 양쪽 값 병기 후 director가 언어 기준 판정 |
| critic 결함 2회 후 잔존 | 잔여 결함을 DESIGN_GUIDE.md의 "알려진 한계"에 명시하고 진행 |
| 토큰 참조/대비 치명 결함 | 종합 미승인, token-synthesizer에 재작업 지시 (루프 카운트 내) |

## 테스트 시나리오

### 정상 흐름
1. 사용자: "B2B 분석 대시보드, 신뢰감 있고 모던한 SaaS 느낌으로 디자인 시스템 만들어줘."
2. Phase 1: director가 '모던 SaaS' 언어 확정, 근거 기록.
3. Phase 2: 팀 구성(5 작업자) + 작업 등록.
4. Phase 3: trend가 Linear/Stripe류 원리 추출 → geometry가 1.25 스케일·4pt 그리드, aesthetic이 OKLCH 팔레트·다크모드 설계(병렬), critic 증분 검증.
5. Phase 4: token-synthesizer가 토큰 3종 생성, critic이 대비·무결성 검수 통과.
6. Phase 5: `design-system/` 산출 + 요약 보고.

### 에러 흐름
1. Phase 4에서 critic이 `text.muted` 대비 3.45:1(AA 미달) 보고.
2. token-synthesizer가 muted를 neutral.600으로 교체해 재종합(1회).
3. critic 재검증 통과.
4. 만약 2회 후에도 한 조합이 AA 경계면 가이드 "알려진 한계"에 명시하고 진행.
5. director가 부분 통과 사실을 사용자에게 보고.
