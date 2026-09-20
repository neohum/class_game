# ADR 0026: Senior-thinking-skills를 흡수·선별 방식으로 배치

- **상태:** 채택 (Accepted)
- **날짜:** 2026-09-17
- **결정자:** 저장소 소유자(승인), lead(Claude)
- **관련:** `plans/senior-thinking-skills.plan.md`, `docs/senior-thinking.md`, `tests/context-budget.test.ts`, ADR-0025

---

## 배경

[songjiun10-collab/Senior-thinking-skills](https://github.com/songjiun10-collab/Senior-thinking-skills)는
코드를 쓰기 전에 생각하는 규율을 스킬 24개(라우터 1, 규율 23)로 나눈 MIT 번들이다. 기준 커밋은
`be98e588b4b5455b5ca95c11d2beacdfef4360be`다.

그대로 넣기 어려운 이유는 세 가지다.

1. **컨텍스트 비용.** 스킬 description은 매 세션 시스템 프롬프트에 올라간다. 24개 description 합계는
   약 1,600단어로, 이 하네스가 기본 배포하는 Claude 스킬 17개의 description 합계(914단어)보다 크다.
2. **중복.** 절반 가까이가 이미 있는 규율(verify-done, self-review, debug-protocol, safe-refactor,
   tdd-loop, plan-doc, validator·adversary 에이전트)과 겹친다. 같은 규칙이 두 스킬에 있으면 어느 쪽이
   발동할지 불분명하고, 한쪽만 고쳐지면 서로 어긋난다.
3. **스택.** 번들 스크립트 4개는 Python이다. 이 하네스는 Node·TS 전용에 런타임 의존성이 없고, 같은
   역할을 `knowledge.ts`, `telemetry.ts`, `plan-gate.ts`, `framein.ts risk`가 이미 맡는다.

## 결정

| 처리 | 원본 스킬 | 근거 |
|---|---|---|
| 흡수 → `verify-done` | verify-before-claiming | 같은 증거 게이트. 합리화 차단 표와 하위 에이전트 보고 재검증만 새 내용 |
| 흡수 → `self-review` | fresh-context-review, surgical-change | 같은 리뷰 단계. 스펙·품질 두 축, 변경 크기 기준, 심각도 라벨만 새 내용 |
| 흡수 → `plan-doc` | bite-sized-plan | 계획서 형식이 이미 있음. 파일 배치 먼저, 맥락 없는 빌더 기준만 새 내용 |
| 흡수 → `debug-protocol` | root-cause-discipline | 같은 디버깅 절차. "이미 해결됐나"(knowledge recall)와 3회 실패 규칙만 새 내용 |
| 흡수 → `safe-refactor` | chestertons-fence | 리팩터 전 확인 단계 하나 |
| 흡수 → `tdd-loop`, `validator` | verifiability-first | 성공 기준 선언은 AC 게이트와 같은 원리 |
| 흡수 → `validator` | clarify-the-real-problem | validator의 역할 그 자체 |
| 흡수 → `adversary` | adversarial-review | adversary 에이전트의 역할 그 자체. 개입 시점과 질문 틀만 새 내용 |
| 기본 신규 | widen-the-solution-space, weigh-tradeoffs, premortem, interface-contracts, threat-and-scale-check, honest-artifacts, search-first, measure-before-optimizing | 하네스에 해당 규율이 없음 |
| 보류 (옵트인 후보) | senior-engineer-mindset, design-for-the-next-reader, simplicity-budget, record-the-why, context-economy, delegate-to-subagents | 라우터는 `route.ts`·plan-doc Risk와 역할이 겹치고, 나머지는 기본 계약(No speculative scope, ADR 존중, Dynamic Context Pruning, harness-roles)이 부분적으로 다룸. 수요가 확인되면 별도 계획서 |
| 제외 | persistent-memory, Python 훅·CLI 4종 | knowledge hub·Claude 메모리·persona, plan-gate·telemetry와 중복. Node 전용 스택 |

추가 규칙:

- 이식한 스킬은 description을 50단어 이하로 줄이고, Distinguished·Executive 관점 문단을 빼며,
  하네스 산출물로 결과를 넘기는 "In this harness" 절과 출처 줄을 둔다.
- 기본 배포 스킬 description 합계에 상한(`.claude` 1,300단어, `.agents` 900단어)을 두는 테스트를
  추가한다. 상한을 올리는 것은 결정이지 형식이 아니다.
- 원본은 커밋 `be98e588`에 고정한다. 이후 원본 변경은 자동으로 따라가지 않는다.
- `--update`의 "기존 non-JSON 파일 보존" 동작은 바꾸지 않는다. 기존 프로젝트가 손으로 반영할 목록은
  `docs/senior-thinking.md`에 둔다.

## 결과

- 좋은 점: 매 세션 비용이 상한 테스트로 묶이고, 규율이 역할 프롬프트를 통해 실제로 호출된다.
  같은 규칙이 두 곳에 생기지 않는다.
- 나쁜 점: 원본과 문구가 달라져, 원본이 개선돼도 자동으로 받지 못한다. 이미 설치된 프로젝트는 흡수
  수정을 손으로 반영해야 한다.
- 되돌리기: 새 스킬 디렉터리를 지우고 흡수 커밋을 되돌리면 된다. 스키마·공개 API 변경은 없다.
