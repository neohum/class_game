---
name: code-driven-ssot
description: 코드를 기준으로 자동 최신화되는 도메인 지식 SSOT(LLM Wiki)를 구축하고, 2-Tier(raw ➔ knowledge) 추출·ingest·lint 워크플로우 및 사전/사후 영향도 분석을 수행하는 스킬입니다.
---

# Code-Driven Knowledge SSOT (LLM Wiki)

이 스킬은 [LINE/LY Corporation의 코드 기반 지식 SSOT 아키텍처](https://techblog.lycorp.co.jp/ko/llm-wiki-code-driven-knowledge-ssot)를 바탕으로,
코드를 유일한 근거로 삼아 2-Tier 지식을 유지하고, 스펙 주도 개발과 사전/사후 영향도 분석을 실행합니다.

## 1. 2-Tier 지식 구조

- **`docs/raw/<module>/`**:
  - `baseline-spec.md`: 모듈 소스 전체에서 역추출한 현재 동작 기준 스펙
  - `changes/<pr-id>-spec.md`: PR/카드 단위의 변경 이력(append-only changelog)
- **`docs/knowledge/<domain>/`**:
  - `<domain>-summary.md`: 현재 유효한 최신 비즈니스 정책, 데이터 기준, 처리 흐름
  - `index.md`: 도메인별 문서 링크와 TLDR 1줄 요약 모음
  - `log.md`: 최신 변경 이력 타임라인
  - `semantic-analysis.json`: 별칭, 검색 의도, 서비스 간 연결점 색인

## 2. 워크플로우 동사 및 사용법

```bash
# 1. 신규 모듈/서비스의 baseline 스펙 추출 (raw 생성)
node scripts/loop/knowledge-wiki.ts extract-baseline <module> <source-paths...>

# 2. PR/카드 작업 변경분 스펙 추출 (raw 누적)
node scripts/loop/knowledge-wiki.ts extract-change <module> <card-or-pr-id>

# 3. raw를 최신 knowledge 도메인 문서로 반영 및 인덱스 동기화
node scripts/loop/knowledge-wiki.ts ingest

# 4. 5대 무결성 검증 (식별자 변형, 고아 페이지, 메타데이터 누락, 최신성 점검)
node scripts/loop/knowledge-wiki.ts lint

# 5. 사전/사후 영향도 분석 (변경된 파일의 외부 연결점, 정책 충돌, ADR 필요성 파악)
node scripts/loop/knowledge-wiki.ts impact <changed-files...>
```

## 3. 핵심 규칙 (Non-negotiable Rules)

1. **식별자 무결성(Identifier Integrity)**: API 경로, Kafka 토픽명, DB 컬렉션/테이블명, enum 값, 환경변수는 절대로 번역하거나 임의 축약하지 않고 원문 그대로 보존합니다.
2. **Dual Audience Markdown**: 사람이 읽는 위키와 AI가 참조하는 컨텍스트를 동일한 Markdown 파일로 관리하며, `frontmatter`와 `::: info TLDR` 블록을 필수 작성합니다.
3. **스펙 주도 개발**: 개발 착수 전 `impact` 분석으로 직접 수정 대상과 의존 서비스를 확인하고, PR에는 ADR을 첨부합니다.
