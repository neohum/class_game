---
plan: 2026-10-14-idea-audit-and-master-roadmap
slug: 2026-10-14-idea-audit-and-master-roadmap
title: "classgame 기존 플랜 실현 여부 전수 대조 및 EIS·동적 비계·학습지 생성 마스터 로드맵"
status: done
owner: neohum
risk: medium
created: 2026-10-14
---

## Intent

`classgame` 저장소의 기존 계획서(`plans/*.plan.md`) 및 프로젝트 명세(`spec.md`)를 실제 코드베이스(`src/`, `public/games/`)와 전수 대조하여 **구현 완료 / 부분 구현 / 미구현** 여부를 판정하고, 현재 개별 아케이드 게임 위주로 구성된 22종의 미니게임 생태계에 **브루너 EIS(구체물→영상→기호) 표상 전이**, **동적 비계(Dynamic Scaffolding: 3연속 성공 시 힌트 제거·2연속 실패 시 보조선 복구)**, **메타인지 오류 찾기(Error Analysis) 문항**, **1~6학년 수학 난이도 확장(`number-catch-run`)**, **인쇄용 A4 학습지 자동 생성기**를 결합하는 마스터 개발 계획을 수립한다.

## 기존 플랜 실현 여부 대조 및 가치 평가

| 번호 | 플랜 / 명세 항목 | 판정 | 실제 코드 근거 (`src/`, `public/games/`) | 추가 가치 평가 및 우선순위 |
| --- | --- | --- | --- | --- |
| 1 | `2026-09-29-인지-발달-및-교수설계eis인지부하가네-루프-기반-교육용-게임-및-학습지-ffa7.plan.md` | **미구현 (기초 미니게임만 존재)** | `status: proposed`. `public/games/` 하위에 `100math`, `1to50`, `clock-practice`, `find-word`, `hangul-adventure`, `make-ten`, `nemonemo-logic`, `number-catch-run`, `recycle`, `sound_plane` 등 22종 게임이 존재하나, 플랜 핵심인 ① EIS 3단계 표상 전이, ② 가네 9수업사태 게임 루프, ③ 3연속 성공/2연속 실패 동적 비계 엔진, ④ 캐릭터 풀이 오류 찾기 문항, ⑤ 디지털·인쇄 복합 학습지 생성기는 미구현 상태 | **최우선 구현 (P1, High Value)** — 단순 반복 클릭 게임을 교육과정 성취기준과 인지발달 이론에 부합하는 교실 수업 도구로 격상시키는 핵심 아키텍처 |
| 2 | `spec.md` — `number-catch-run` 초등 1~6학년 전 학년 수학 과정 확장 | **미구현** | `public/games/number-catch-run/game.js`가 단일 기본 연산 수준으로만 작성되어 있으며 1~6학년 학년별 수 범위·사칙연산·분수/소수/배수 선택 모드가 없음 | **우선 구현 (P1, Quick Win)** — 교실 수요가 가장 높은 러닝형 수학 게임을 1~6학년 전 학년에서 즉시 쓸 수 있도록 확장 |
| 3 | `spec.md` — 전 학년 교과 게임 허브 필터링 및 교사용 수업 모드 | **부분 구현** | `src/data/games.ts`, `src/pages/Home.tsx`, `src/pages/GameDetail.tsx`에 게임 목록 및 상세 페이지가 구현되어 있으나, 학년별·EIS 단계별 필터와 연결된 인쇄 학습지 즉석 발급 기능이 없음 | **고부가가치 확장 (P2)** — 게임 플레이 직후 동일 개념의 A4 맞춤 학습지를 인쇄해 온·오프라인 블렌디드 수업을 완결 |

## Non-goals

- 기존 `public/games/` 하위 22개 개별 미니게임의 고유 플레이 재미나 오프라인 단독 실행 호환성을 훼손하지 않는다.
- 무거운 서버 렌더링이나 외부 PDF 변환 서버를 두지 않고 브라우저 네이티브 SVG 및 `@media print` A4 레이아웃으로 학습지를 생성한다.

## Steps

### Step 1: eis-dynamic-scaffolding-pedagogy-engine
- Goal: 브루너의 EIS 표상 단계(`enactive` 구체물 조작 → `iconic` 시각 모형 → `symbolic` 수식/기호) 전이 상태 머신과, 학생의 최근 응답 스트림을 추적해 **3회 연속 정답 시 시각 보조선을 점진 제거**하고 **2회 연속 오답 시 구체물/시각 가이드를 자동 재활성화**하는 공통 교수설계 엔진(`src/lib/pedagogyEngine.ts` 및 `public/games/shared/pedagogy-engine.js`)을 구축한다.
- Files: `src/lib/pedagogyEngine.ts`, `public/games/shared/pedagogy-engine.js`, `tests/pedagogyEngine.test.ts`
- Acceptance: AC-1: `PedagogyEngine`이 연속 정답 3회 시 비계 레벨(`scaffoldLevel`)을 1단계 낮추거나 표상 단계를 `enactive → iconic → symbolic`으로 승격시키고, 연속 오답 2회 시 즉시 시각 보조 가이드를 복구한다. AC-2: 오답 발생 시 단순 감점 대신 오개념 교정 힌트 객체(`hintType`, `visualGuideOn`, `message`)를 반환한다.
- Tests: `npx vitest run tests/pedagogyEngine.test.ts`
- Risk: low
- Complexity: medium
- Agent: codex
- Reviewer: claude

### Step 2: error-analysis-metacognition-module
- Goal: 가네의 9가지 수업 사태 루프(주의 집중 → 목표 제시 → 선수학습 회상 → 자극 제시 → 학습 안내 → 수행 유도 → 피드백 → 수행 평가 → 파지 및 전이)와, 가상 캐릭터가 먼저 틀린 풀이를 제시하고 학생이 **어느 단계에서 왜 틀렸는지 찾아 고치는 메타인지 '오류 찾기(Error Analysis)' 챌린지 모듈**을 구현한다.
- Files: `src/lib/errorAnalysisChallenge.ts`, `src/components/ErrorAnalysisModal.tsx`, `tests/errorAnalysisChallenge.test.ts`
- Acceptance: AC-1: 학년별 주요 오개념(예: 받아올림 누락, 자릿값 정렬 오류, 시계 긴바늘·짧은바늘 혼동, 받침 연음 오류) 문제 뱅크에서 캐릭터의 오류 풀이 단계와 교정 선택지를 생성한다. AC-2: 학생이 오류 원인을 정확히 지목하고 바른 답을 입력하면 메타인지 마스터리 배지와전이 보너스가 기록된다.
- Tests: `npx vitest run tests/errorAnalysisChallenge.test.ts`
- Risk: low
- Complexity: medium
- Agent: codex
- Reviewer: claude

### Step 3: number-catch-run-grades-1-to-6-expansion
- Goal: `public/games/number-catch-run` 및 대표 수학 게임(`make-ten`, `100math`)에 초등 1~6학년 학년별 교육과정 프리셋(1학년: 10 만들기/묶어 세기, 2학년: 두 자리 덧뺄셈·곱셈구구, 3~4학년: 세 자리 연산·나눗셈·분수 기초, 5~6학년: 약수와 배수·분수/소수 연산)과 Step 1의 동적 비계 가이드를 연동한다.
- Files: `src/lib/gradeMathCurriculum.ts`, `public/games/number-catch-run/game.js`, `public/games/number-catch-run/index.html`, `tests/gradeMathCurriculum.test.ts`
- Acceptance: AC-1: 1~6학년 학년 선택 시 해당 학년 성취기준에 맞는 수 범위와 연산자만 출제되며 오답 매력도가 통제된 보기가 생성된다. AC-2: 연속 2회 오답 시 수모형/수직선 시각 보조선이 화면 하단에 자동 표시되고 연속 3회 정답 시 기호 암산 모드로 전환된다.
- Tests: `npx vitest run tests/gradeMathCurriculum.test.ts`
- Risk: medium
- Complexity: medium
- Agent: codex
- Reviewer: claude

### Step 4: printable-eis-worksheet-generator
- Goal: 각 게임 상세 화면(`src/pages/GameDetail.tsx`)에서 방금 플레이한 게임의 개념·학년·EIS 단계에 맞춘 **인쇄용 A4 복합 학습지(구체물 그림 영역 + 보조선 빈칸 + 기호 수식 + 오류 찾기 1문항 + 교사용 정답지)**를 즉시 생성하고 브라우저 인쇄/SVG 저장을 지원하는 학습지 생성기를 구축한다.
- Files: `src/lib/worksheetGenerator.ts`, `src/components/PrintableWorksheetModal.tsx`, `src/pages/GameDetail.tsx`, `tests/worksheetGenerator.test.ts`
- Acceptance: AC-1: 게임 상세 페이지에서 '맞춤 학습지 인쇄' 클릭 시 선택 학년과 난이도에 맞는 A4 규격 문제지(EIS 3단계 문항 및 오류 찾기 문항 포함)와 정답지가 생성된다. AC-2: 인쇄 미리보기에서 불필요한 네비게이션 UI가 숨겨지고 한 페이지 내에 문항과 시각 도형이 잘림 없이 배치된다.
- Tests: `npx vitest run tests/worksheetGenerator.test.ts`
- Risk: low
- Complexity: medium
- Agent: codex
- Reviewer: claude

## Verification

- `npx vitest run` 전체 단위 및 통합 테스트 통과
- `npm run build` 프로덕션 빌드 성공 검증

## Reviewer topology

- Builder: `codex`
- Reviewer: `claude` (빌더와 독립된 프로바이더가 초등 1~6학년 교육과정 적합성, EIS 동적 비계 전이 로직, A4 인쇄 레이아웃 무결성을 검증)
