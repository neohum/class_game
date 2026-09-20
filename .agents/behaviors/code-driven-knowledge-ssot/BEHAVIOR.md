---
name: code-driven-knowledge-ssot
description: 코드를 유일한 단일 진실 공급원(SSOT)으로 삼아 2-Tier(raw 원본 이력 ➔ knowledge 최신 도메인)로 지식을 축적하고, 식별자 무결성을 유지하며, 사전/사후 영향도를 분석해 스펙 주도로 개발한다.
---

## Intent

요구사항 분석과 개발 과정에서 낡은 문서나 AI의 자의적 추론으로 빈칸(Hallucination)을 채우지 않는다.
실제 동작하는 코드(DTO, Entity, Service, Route, Config, Schema)를 단일 진실 공급원(SSOT)으로 삼아,
코드에서 비즈니스 정책을 역추출하고(raw), 이를 사람이자 AI가 공유하는 최신 도메인 지식(knowledge)으로 유지한다.

## Evidence

- **동작하는 소스 코드**: DTO, Entity 필드 및 제약, Validator/예외 분기, Service 처리 흐름, YAML/Config 한도, 노출된 API 엔드포인트와 이벤트 토픽.
- **PR 변경 이력 및 ADR**: 코드 변경분(diff)과 코드로 드러나지 않는 아키텍처 결정 배경(ADR).
- **관찰 근거 없는 추론 금지**: 소스에 명시되지 않은 정책이나 제약 조건을 임의로 생성하거나 단정하지 않는다.

## Decision

1. **2-Tier 지식 구조**:
   - **`raw/` (원본 근거 계층)**: 모듈별 baseline 스펙과 PR별 변경 스펙을 변경 이력(changelog) 형태로 누적 보존(append-only).
   - **`knowledge/` (통합 도메인 계층)**: 현시점에 유효한 최신 비즈니스 정책과 구조만 유지. 사람과 AI 모두가 읽을 수 있도록 Frontmatter, TLDR, 도메인 요약, raw 근거 링크(`sources: [...]`)를 포함.
2. **식별자 무결성 (Identifier Integrity)**:
   - API 경로, 이벤트 토픽명, DB 테이블/컬렉션명, 환경변수명, enum 값 등 시스템 간 연결 지점은 번역, 약어화, 변형 없이 원문 그대로 보존한다.
3. **스펙 주도 개발 (Spec-Driven Development)**:
   - 개발 착수 전 SSOT 기반 사전 영향도 분석(직접 수정 대상, 연관 모듈, 정책 충돌 여부) 수행.
   - PR 생성 시 사후 영향도 분석(서비스 경계 연결점 변경 추적) 및 ADR 첨부.

## Execution

1. **추출(Extract)**: 신규 모듈은 baseline 스펙을, PR 작업은 change 스펙을 raw 계층에 기록한다.
2. **반영(Ingest)**: raw의 변경분을 취합하여 knowledge 문서를 갱신하고, `index.md`, `log.md`, 검색 색인을 동기화한다.
3. **점검(Lint)**: 5대 검사(링크·정합성, 식별자 무결성, 최신성, frontmatter/TLDR 규격, index 일치)를 주기적으로 실행하여 어긋난 지식을 자동 보정한다.

## Recovery

- knowledge 문서가 raw 원본 또는 실제 코드와 어긋날 경우, raw를 함부로 변조하지 않고 코드 기반 재추출/ingest를 통해 knowledge를 재정렬한다.
- 모호한 정책이나 코드 주석으로도 확정할 수 없는 결정 배경은 추측으로 넘기지 않고 사람 검증 이슈로 에스컬레이션한다.

## Failure modes

- **추론 채우기 (Hallucination)**: 소스에 없는 정책이나 파라미터를 그럴듯하게 지어내는 행위.
- **식별자 변형 (Identifier drift)**: 엔드포인트나 토픽명을 한글로 번역하거나 임의로 축약하는 행위.
- **단일 계층 오염**: raw 변경 이력을 덮어쓰거나, knowledge에 과거 폐기된 정책을 방치하는 행위.
- **영향도 미분석**: 서비스 간 API나 스키마 변경 시 의존 모듈 파급 효과를 확인하지 않고 진행하는 행위.
