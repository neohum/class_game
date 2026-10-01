---
name: memory-adr
description: 사용자 승인 후 ADR(아키텍처 결정 기록)을 작성하고 MEMORY.md 인덱스에 등록. memory/04-decisions/TEMPLATE.md 양식 사용. 사용자가 "/memory-adr {주제}" 형태로 호출하거나, /memory-check 권고에 "작성해줘" 응답 시 호출.
---

# memory-adr — ADR 작성 + 인덱스 동기화

> 이 스킬이 호출되었다는 것 자체가 사용자 승인입니다. 추가 확인 없이 작성합니다. 단, **작성 후 사용자가 검토할 수 있도록 핵심 내용을 응답에 요약**.

## 입력

- 인자: 주제 슬러그 (kebab-case, 영문 권장). 예: `adopt-react-query`, `migrate-to-zustand`
- 인자가 없으면 대화 맥락에서 주제를 추론하고 사용자에게 슬러그 후보를 제안 후 확인 받음.

## 절차

### 1. 양식 로드

`memory/04-decisions/TEMPLATE.md` 를 읽어 구조 확인:
- Status / Date / Context / Options Considered / Decision / Rationale / Consequences / References

### 2. 파일명 결정

- 오늘 날짜는 시스템 컨텍스트의 `# currentDate` 사용 (예: `2026-05-15`)
- 형식: `YYYY-MM-DD-{topic-slug}.md`
- 경로: `memory/04-decisions/YYYY-MM-DD-{topic-slug}.md`
- 같은 날짜에 동일 슬러그가 이미 있으면 `-2`, `-3` suffix

### 3. 본문 채우기

대화 맥락 + git diff/log 를 종합해 채움. **추측하지 말고 실제 결정된 내용만** 적기. 모르는 섹션은 비워두지 말고 `(작성 필요)` placeholder.

- **Status**: 보통 `Accepted` (이미 결정한 것이므로). 토론 중이면 `Proposed`.
- **Date**: 오늘
- **Context**: 5문장 이내. 무엇이 문제였고 어떤 제약이 있었는지. 사실·제약·압박 사항.
- **Options Considered**: 검토한 옵션 2-3개. 각각 장점/단점. 트레이드오프가 핵심.
- **Decision**: 채택한 옵션을 한 단락으로.
- **Rationale**: 왜 그것을 골랐는가. 다른 옵션 배제 이유. **6개월 뒤에도 이해되도록** 작성.
- **Consequences**: 긍정적 / 부정적 / 후속 작업 체크박스
- **References**: 관련 PR/커밋 (`git log --oneline -5` 에서 해시), 관련 메모리 파일 링크

### 4. ADR 번호 부여

기존 ADR 개수 확인 후 다음 번호:
- `Get-ChildItem memory/04-decisions/*.md | Where-Object Name -notlike "TEMPLATE*" | Measure-Object` 로 카운트
- 제목: `# ADR-{NNN}: [한 줄 요약]` (3자리 zero-pad)

### 5. 파일 작성

`Write` 도구로 ADR 파일 생성.

### 6. MEMORY.md 인덱스 갱신

`memory/MEMORY.md` 의 `## 📜 04-decisions (ADR — 불변)` 섹션 끝에 한 줄 추가:

```markdown
- [YYYY-MM-DD-{topic-slug}.md](04-decisions/YYYY-MM-DD-{topic-slug}.md) — [한 줄 요약]
```

`Edit` 도구로 마지막 ADR 항목 뒤에 삽입. 200줄 초과 체크.

### 7. current-focus.md 갱신 (자동)

`memory/06-state/current-focus.md` 의 "최근 작업" 섹션에 한 줄 추가:
- `✅ ADR-{NNN} 작성 — [한 줄 요약]`
- "ADR 후보" 또는 "알려진 문제" 섹션에 동일 항목이 있었다면 제거.

### 8. 사용자에게 요약

```
✅ ADR-{NNN} 작성 완료: memory/04-decisions/YYYY-MM-DD-{topic}.md

핵심:
- Context: [한 줄]
- Decision: [한 줄]
- 후속 작업: N개

인덱스 갱신: MEMORY.md (한 줄 추가)
current-focus.md 갱신: 최근 작업 섹션

검토하고 수정할 부분이 있으면 알려주세요.
```

## 금지

- ❌ 이미 작성된 ADR 수정 (불변 원칙). 번복은 새 ADR 작성 + 이전 ADR 의 Status 를 `Superseded by ADR-NNN` 으로 변경하는 새 PR.
- ❌ 추측으로 채우기 — 모르는 건 `(작성 필요)` placeholder
- ❌ 인덱스 갱신 누락
- ❌ 한 줄 요약이 80자 초과

## 관련

- 양식: `memory/04-decisions/TEMPLATE.md`
- 인덱스: `memory/MEMORY.md`
- 트리거 규칙: `memory/01-rules/memory-update-rules.md`
- Incident 작성: `/memory-incident`
