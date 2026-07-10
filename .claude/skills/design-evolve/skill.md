---
name: design-evolve
description: "스스로 트렌드·자료를 검색해 새 디자인 변형을 만들고, 렌더·비교 평가하며, 승패에서 안목을 배워 성장하는 자율 디자이너 진화 루프. '디자이너 페르소나 학습', '자율 디자인 진화', '디자인 토너먼트 돌려줘', '디자인 여러 개 만들어서 비교 평가', '스스로 성장하는 디자이너', 'design evolve/tournament' 요청 시 반드시 사용. 1회 디자인 생성(design-orchestrator)과 달리, 세대를 반복하며 designer-persona.md에 취향을 누적하는 반복 학습 루프다."
---

# Design Evolve — 스스로 성장하는 디자이너

검색 → 생성 → 렌더 → 비교 평가 → 증류를 한 세대로 삼아 반복하는 **자율 디자이너 진화 루프**. design-orchestrator가 "한 번의 좋은 디자인"을 만든다면, 이 스킬은 세대를 거듭하며 `designer-persona.md`에 안목을 쌓는다. 메커니즘은 deploy-gate 페르소나(persona-synthesize.mjs)의 **언어공간 경사하강**을 디자인 도메인으로 재사용한 것이다.

## 실행 모드: 에이전트 팀 (생성-검증 + 토너먼트)

리더 design-director 아래: trend-researcher(검색), generator 역할(geometry+aesthetic+token 조합으로 변형 생성), design-critic(객관 채점), taste-judge(주관 안목). 하이브리드 안목 신호 — 자율 토너먼트가 기본, 막상막하일 때만 인간 탭으로 보정.

## 한 세대(라운드)의 흐름

```
[검색] trend-researcher: 웹 + 레퍼런스 라이브러리 → 신선한 재료
   ↓
[생성] N개 변형 (전략 다변화: 비율·언어·팔레트) — designer-persona의 탐색 전략 + 학습된 원리를 따름
   ↓
[렌더] 각 변형 tokens.css → design-render.mjs → preview.html → capture-screenshot
   ↓
[채점] design-critic(정량: 대비·수학) + taste-judge(주관: 스크린샷 안목) → design-score.mjs 적합도
   ↓
[토너먼트] 적합도 순위 → 승자 (접근성 바닥 미달은 실격)
   ↓
[보정?] 상위 2개 차 < 5점이면 Telegram 탭 요청 (notify-telegram) → 인간 승자 선택
   ↓
[증류] design-persona-synthesize.mjs: 승패 원리를 designer-persona.md LEARNED 블록에 기록
   ↓
다음 라운드는 자라난 안목으로 시작 (= 성장)
```

## 단계별 절차

### 1. 검색 (재료 수집)
trend-researcher가 design-trend-research 스킬로 웹 트렌드 + **사용자 레퍼런스 라이브러리**(`design-refs/` 또는 `REFERENCES.md`에 모아둔 브랜드·선호 사이트) + **중앙 허브 recall**을 읽어 이번 라운드의 방향 재료를 만든다. 레퍼런스가 있으면 개인 취향을 고정하는 닻이 된다.

**크로스프로젝트 recall (재사용 > 재학습):** 라운드 시작 시 허브에서 다른 프로젝트가 이미 배운 안목 원리·승리 전략을 불러온다: `node scripts/loop/knowledge.mjs recall "<제품유형/언어 키워드>"`. designer-persona는 PERSONA_HOME에 누적되고, 허브는 라운드 결과를 프로젝트 간에 나른다 — 안목이 한 프로젝트에 갇히지 않는다. 증류(6단계) 후 승패 원리를 허브에도 기록해 다음 프로젝트가 출발점으로 쓰게 한다.

### 2. 생성 (변형 N개)
designer-persona.md의 **탐색 전략 + 학습된 원리**를 읽고, 의도적으로 서로 다른 N개(기본 3~4) 변형을 만든다:
- 각 변형은 geometry-system(비율) + aesthetic-system(언어/팔레트) + design-tokens(토큰화)를 조합해 `_workspace/variants/<id>/{tokens.json,tokens.css}` 생성.
- **다양성 강제**: 최소 1개 "안전한 베스트", 1개 "위험한 실험", 1개는 인접 언어 블렌딩. 비슷한 변형만 내면 에코챔버다.

### 3. 렌더 (눈으로 보게)
각 변형마다:
```bash
node scripts/design-render.mjs --tokens _workspace/variants/<id>/tokens.css \
  --out _workspace/variants/<id>/preview.html --label "<id>: <strategy>"
# 다크모드도 보려면 --theme dark
```
그 뒤 capture-screenshot(Playwright)로 `preview.html` → `preview.png`. 디자인은 수치가 아니라 **렌더된 결과**로 평가한다.

### 4. 채점 (객관 + 주관 + 반론)
- **design-critic**: design-critique 스킬로 대비(contrast.mjs)·수학 정합·토큰 무결성 → 변형별 `contrast{pass,total}`, `mathIntegrity`, `languageFit`.
- **taste-judge**: designer-persona.md를 로드한 뒤 `preview.png`를 **실제로 보고** 안목 점수(0~100) + 근거.
- **adversary(선택, 결승전)**: 잠정 승자에 대해 `adversary` 에이전트로 "경쟁 제품 디자인이 이 변형을 이기는 가장 강한 논거"를 만든다. taste-judge가 페르소나에 정렬되며 생기는 확증편향을 외부 시각으로 깨, 에코챔버를 막는다. 반론을 견디면 진짜 승자.
- 세 축을 합쳐 적합도:
```bash
node scripts/design-score.mjs --rank _workspace/round_<n>_metrics.json
# 출력: winner + leaderboard. AA 미달 변형은 penalty로 실격될 수 있음.
```

### 5. 보정 (하이브리드 안목 신호)
- 자율 진행이 기본. 단 **상위 2개 composite 차 < 5** 또는 taste-judge가 `persona_conflict`를 표시하면 → 막상막하/불확실. 이때만 `notify-telegram.mjs`로 두 스크린샷을 보내 인간 탭(✅ 승자 선택)을 받는다.
- 탭이 오면 그것이 ground truth. 탭이 없으면 자율 승자를 그대로 채택.
- 이 "불확실할 때만 묻는" 설계가 매 탭을 최대정보 능동학습 샘플로 만든다(deploy-gate와 동일 원리).

### 6. 증류 (성장)
승패를 데이터셋에 기록하고 페르소나를 다시 쓴다:
```bash
# 1) 결과 기록 (변형별 1행)
node scripts/design-feedback.mjs --append '{"round":<n>,"id":"<id>","strategy":"...","composite":<x>,"predictedWinner":"<judge_pick>","won":<bool>,"humanTap":<"win"|"lose"|null>,"note":"승패 근거"}'
# 2) 증류 분석 → 프롬프트 산출
node scripts/design-persona-synthesize.mjs --min 1
#    → taste-judge가 그 prompt로 학습 원리(불릿)를 작성해 rules.md에 저장
# 3) 페르소나의 LEARNED 블록에만 반영 (사람의 Prior는 불변)
node scripts/design-persona-synthesize.mjs --apply-file rules.md
```
`PERSONA_HOME`이 설정돼 있으면 페르소나는 중앙(`~/.claude/persona/designer-persona.md`)에 누적된다 — 안목이 프로젝트를 넘어 쌓인다.

## 자율 반복 (always-on)

한 번 호출로 한 세대가 돈다. 지속 성장은 두 방식:
1. **`/loop` 으로**: `design-evolve` 를 주기/자기페이스로 반복 호출 → 매 세대 persona가 자라남.
2. **ralph-loop 통합**: 백로그가 비었을 때 assess-shortcomings 대신(또는 함께) 디자인 탐색 세대를 큐잉. capture-screenshot/notify-telegram/PERSONA_HOME을 그대로 공유하므로 추가 인프라가 거의 없다. 상세: `references/evolution-loop.md`.

## 산출물
- `_workspace/variants/<id>/` — 변형별 토큰·프리뷰·스크린샷·채점
- `_workspace/round_<n>_verdict.md` — 라운드 승자 + 근거
- `designer-persona.md` (PERSONA_HOME) — **자라나는 안목** (핵심 산출물)
- `.harness/design-feedback.jsonl` — 토너먼트 학습 데이터셋

## 에러 핸들링
| 상황 | 전략 |
|---|---|
| 렌더/스크린샷 실패 | 해당 변형은 토큰+critic 점수만으로 잠정 채점, "시각 미확인" 명시 |
| 모든 변형 AA 실패 | 승자 없음 → aesthetic-designer에 명도 조정 재생성 1회 요청 |
| 변형 다양성 부족 | taste-judge가 경고 → generator에 전략 다변화 강제 |
| Telegram 탭 무응답 | 시간초과 시 자율 승자 채택, humanTap=null로 기록 |
| 증류 에이전트 무산출 | 이번 라운드 LEARNED 블록 갱신 생략(기존 유지), 다음 라운드 재시도 |

## 테스트 시나리오
### 정상
1. "이 대시보드 디자인을 스스로 진화시켜줘" → 라운드 1 시작.
2. 검색 → 4개 변형 생성 → 렌더·스크린샷 → critic+judge 채점 → design-score 순위.
3. 자율 승자 확정(차이 충분), 증류 → persona LEARNED에 원리 2개 기록.
4. 라운드 2는 그 원리를 반영해 생성 → 평균 적합도 상승.

### 에러(보정 경로)
1. 라운드 3에서 상위 2개 composite 차 3점 → 불확실.
2. notify-telegram으로 두 스크린샷 전송, 인간이 v2를 탭.
3. humanTap="win"으로 기록, judge의 예측(v4)과 불일치 → missedWinner 사례.
4. 증류가 그 사례를 우선 학습해 LEARNED 룰 수정 → 안목 자기교정.
