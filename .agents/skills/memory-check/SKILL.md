---
name: memory-check
description: 작업 종료/커밋 직전에 git 변경사항과 대화 맥락을 분석해서 ADR/Incident/앱문서 갱신 트리거를 감지하고 사용자에게 권고. memory/01-rules/memory-update-rules.md 의 규칙을 실행하는 진입점. 사용자가 "/memory-check" 라고 입력하거나, 큰 작업이 끝나갈 때 자발적으로 호출.
---

# memory-check — 작업 종료 시 메모리 갱신 트리거 감지

> 이 스킬은 권고만 합니다. **파일을 작성하지 않습니다.** 사용자가 승인하면 `/memory-adr` 또는 `/memory-incident` 를 별도 호출.

## 절차

### 1. 규칙 로드 (필수)

다음 파일을 읽어 트리거 조건을 확인:
- `memory/01-rules/memory-update-rules.md` — 핵심 트리거 규칙 (ADR / Incident / safety-rules 승격 / current-focus / 03-apps)

### 2. 변경사항 수집

병렬로 실행:
- `git status --short` — 현재 워킹 트리 상태
- `git diff --stat HEAD` — staged + unstaged 요약
- `git log --oneline -10` — 최근 커밋 흐름
- 필요 시 `git diff HEAD -- package.json go.mod backend/migrations` 등 핵심 영역 정밀 diff

### 3. 트리거 매칭

`memory-update-rules.md` 의 5가지 트리거를 순서대로 검토:

**ADR 트리거 (트리거 1)** — 다음 중 하나라도 해당하면 권고
- 새 라이브러리·프레임워크·외부 서비스 추가 (`package.json`, `go.mod` 의 의미있는 새 dependency)
- 아키텍처·폴더구조·모듈 경계 변경
- DB 스키마 / API 계약 변경
- 패턴 전환·트레이드오프 결정·운영 정책 변경

**Incident 트리거 (트리거 2)** — 다음 중 하나
- 대화 맥락에 30분 이상 디버깅 / 여러 시도 흔적
- 사용자가 "이상하다 / 왜 안 되지" 발언 후 해결
- 외부 환경 (Windows 잠금, 권한, 네트워크) 으로 인한 사고
- 데이터/설정 손상·회귀

**safety-rules 승격 (트리거 3)** — 이번 세션에서 Incident 가 작성됐고, 재발방지가 일반화 가능한 규칙이면 권고

**current-focus.md 갱신 (트리거 4)** — 사용자 승인 없이 자동: 작업 시작/완료, 새 알려진 문제, Stage 변경

- **03-apps/{app}.md 갱신 (트리거 5)** — 특정 앱에서 새 함정·패턴·진입점 발견
- **자동 스킬(Skill) 생성 (트리거 6)** — 세션 내 2회 이상 반복된 다단계 CLI 명령어 흐름, 수동 환경 설정 패치 절차 감지 시 권고

### 4. False positive 거르기

다음은 권고하지 않음:
- 단순 버그 수정·오타·null check
- minor / patch 의존성 업그레이드
- 기존 패턴 그대로 따르는 일반 기능 추가
- 외형만 바뀐 리팩토링
- 한 줄 추가·삭제 수준

### 5. 권고 출력

권고가 있으면 다음 형식으로 (규칙 파일의 "권고 메시지 형식" 따름):

```
## 📋 메모리 갱신 권고

### ADR 후보 (N건)
1. **[주제]** — [감지된 변경 요약]
   → `/memory-adr {kebab-topic}` 으로 작성

### Incident 후보 (N건)
1. **[주제]** — [감지된 사건 요약]
   → `/memory-incident {kebab-topic}` 으로 작성

### 03-apps 갱신 후보
- `memory/03-apps/{app}.md` 에 [새 함정/패턴] 추가 권장

### 자동 스킬(Skill) 갱신 후보
- `node scripts/generate-skill.mjs {skill-name} '{description}'`을 사용해 로컬 및 create-agent-harness 템플릿에 동기화 권장

### current-focus.md (자동 갱신 대상)
- [무엇을 갱신할지 한 줄]
```

권고가 없으면: `✅ 메모리 갱신 트리거 없음 — 이 작업은 단순 변경/리팩토링으로 판단됨.`

### 6. 사용자 응답 처리

- **"작성해줘 / 예"** → 해당 스킬 (`/memory-adr` 또는 `/memory-incident`) 호출
- **"나중에"** → `memory/06-state/current-focus.md` 의 "🚨 알려진 문제" 또는 "ADR 후보" 섹션에 한 줄 메모 추가
- **"아니야"** → 진행. 같은 작업 안에서 다시 권고 금지

## 금지

- ❌ ADR/Incident 파일 직접 작성 (별도 스킬 호출)
- ❌ 모든 변경에 권고 (false positive 누적 → 피로)
- ❌ 작업 중간 권고 (interruption)
- ❌ "이게 중요한가요?" 같은 책임 전가 표현

## 관련

- 트리거 규칙: `memory/01-rules/memory-update-rules.md`
- ADR 작성: `/memory-adr`
- Incident 작성: `/memory-incident`
