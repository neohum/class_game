---
name: memory-incident
description: 사용자 승인 후 Incident(사건+재발방지) 기록을 작성하고 MEMORY.md 인덱스에 등록. memory/05-incidents/TEMPLATE.md 양식 사용. 사용자가 "/memory-incident {주제}" 형태로 호출하거나, /memory-check 권고에 "작성해줘" 응답 시 호출.
---

# memory-incident — Incident 작성 + 재발방지 + 인덱스 동기화

> 이 스킬이 호출되었다는 것 자체가 사용자 승인입니다. 추가 확인 없이 작성합니다. 단, **작성 후 사용자가 검토할 수 있도록 핵심 내용을 응답에 요약**.

## 입력

- 인자: 주제 슬러그 (kebab-case, 영문 권장). 예: `wails-binding-cross-contamination`, `windows-file-lock-rename-fail`
- 인자가 없으면 대화 맥락에서 사건의 핵심을 추론하고 사용자에게 슬러그 후보를 제안 후 확인 받음.

## 절차

### 1. 양식 로드

`memory/05-incidents/TEMPLATE.md` 를 읽어 구조 확인:
- Severity / Status / Dates / Impact / Symptoms / Root Cause / Resolution / **Prevention ⭐** / Lessons Learned / References

### 2. 파일명 결정

- 오늘 날짜는 `# currentDate` 사용 (예: `2026-05-15`)
- 형식: `YYYY-MM-DD-{topic-slug}.md`
- 경로: `memory/05-incidents/YYYY-MM-DD-{topic-slug}.md`
- 발생 날짜가 불명확하면 `2026-05-XX-{topic}.md` 패턴도 허용 (기존 사례 있음)

### 3. 본문 채우기

대화 맥락에서 사건의 전말을 재구성. **Prevention 섹션이 핵심** — 다음에 같은 실수를 안 하도록.

- **Severity**: 영향 범위로 판단 — `Critical` (서비스 다운/데이터 유실) / `High` / `Medium` / `Low` (개발 환경 한정)
- **Status**: 현재 상태 — `Resolved` / `Mitigated (workaround)` / `Open`
- **Dates**: 발생/감지/해결 시각 (KST). 대화에서 추정. 모르면 `(불명)` 으로.
- **Impact**: 누가/무엇이/데이터 유실 여부/비즈니스 영향
- **Symptoms**: 시간 순. 에러 메시지/로그를 코드 블록으로 그대로 인용.
- **Root Cause**: 5-Why 까지 파고듦. 표면적 원인이 아니라 진짜 원인.
- **Resolution**: 시도한 것 (실패 포함) → 최종 해결. 실패한 시도도 적기 (다음에 안 헤매도록).
- **Prevention ⭐**:
  - 즉시 조치 (이미 적용한 것 체크)
  - 항구화된 규칙 (예: `01-rules/safety-rules.md` 의 X 섹션에 추가)
  - 추가 권장 (lint 룰, CI 검증 등 follow-up)
- **Lessons Learned**: 다른 영역에도 일반화될 수 있는 교훈
- **References**: 관련 PR/커밋 해시, 관련 ADR

### 4. 사건 번호 부여

기존 Incident 개수 확인 후 다음 번호:
- `Get-ChildItem memory/05-incidents/*.md | Where-Object Name -notlike "TEMPLATE*" | Measure-Object`
- 제목: `# Incident-{NNN}: [무엇이 깨졌는지 한 줄]` (3자리 zero-pad)

### 5. 파일 작성

`Write` 도구로 Incident 파일 생성.

### 6. MEMORY.md 인덱스 갱신

`memory/MEMORY.md` 의 `## 🚨 05-incidents (사건 + 재발방지 — 불변)` 섹션에 한 줄 추가:

```markdown
- [YYYY-MM-DD-{topic-slug}.md](05-incidents/YYYY-MM-DD-{topic-slug}.md) — [한 줄 요약, 증상 위주]
```

`Edit` 도구로 마지막 Incident 항목 뒤에 삽입.

### 7. safety-rules 승격 검토 (트리거 3)

Prevention 의 "항구화된 규칙" 이 일반화 가능한 형태면 사용자에게 권고:

```
🆙 safety-rules 승격 권고:
이 사건의 재발방지 규칙은 일반화 가능합니다.
memory/01-rules/safety-rules.md 에 추가할까요?
→ 추가하면 미래의 모든 AI 세션이 자동 인지합니다.
```

승인 시: `safety-rules.md` 에 한 줄 추가 + Incident 의 References 에 링크.

### 8. current-focus.md 갱신 (자동)

"최근 작업" 섹션에 `✅ Incident-{NNN} 작성 — [요약]` 추가.

### 9. 사용자에게 요약

```
✅ Incident-{NNN} 작성 완료: memory/05-incidents/YYYY-MM-DD-{topic}.md

핵심:
- Severity: [등급]
- Root Cause: [한 줄]
- Prevention: N개 조치, M개 follow-up

인덱스 갱신: MEMORY.md
safety-rules 승격: [권고함 / 해당없음]
current-focus.md 갱신: 완료

검토하고 보완할 부분이 있으면 알려주세요.
```

## 금지

- ❌ 이미 작성된 Incident 수정 (불변). 추가 정보는 새 섹션으로 append.
- ❌ Prevention 섹션 비워두기 — 이 사건 기록의 **핵심**이므로 반드시 채움. 모르면 "추가 조사 필요" 라도 적기.
- ❌ 추측으로 Root Cause 단정 — 모르면 "추정" 명시
- ❌ 인덱스 갱신 누락

## 관련

- 양식: `memory/05-incidents/TEMPLATE.md`
- 안전 규칙: `memory/01-rules/safety-rules.md`
- 인덱스: `memory/MEMORY.md`
- 트리거 규칙: `memory/01-rules/memory-update-rules.md`
- ADR 작성: `/memory-adr`
