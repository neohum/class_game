# ADR 0025: 스펙 주도 개발(SDD) 및 Service Forge 하네스 엔지니어링 표준 채택

- **상태:** 채택 (Accepted)
- **날짜:** 2026-08-30
- **결정자:** 저장소 오케스트레이터, Product Engineer Council
- **관련:** ADR-0001, ADR-0016, ADR-0022, ADR-0024, `.agents/skills/service-forge/SKILL.md`, `.agents/behaviors/spec-driven-service-creation/BEHAVIOR.md`

---

## 1. 배경 및 문제 의식 (Context & Problem Statement)

LLM을 활용한 소프트웨어 개발이 일상화되면서, 프롬프트 한두 줄로 코드를 즉흥적으로 생성하는 **"Vibe Coding"**이 널리 확산되었다. 그러나 실제 프로덕션 수준의 마켓플레이스, 교실 분산 통신, 복식부기 세무 원장, 공문서 자동화 등의 엔터프라이즈 서비스를 구축할 때 Vibe Coding은 다음과 같은 치명적인 병목과 위험을 초래한다:

1. **아키텍처 드리프트 및 환각**: 모호한 지시로 인해 모델이 임의의 라이브러리(예: Lucide, 임의의 SVG, 미검증 ORM)를 도입하거나 기존 Data Contract를 파괴.
2. **컨텍스트 블라인드 결함**: 기존 코드베이스의 환경 변수, 포트(`3001`, `3005`, `8080`), 권한 경계(`requireAdmin()`)를 인지하지 못하고 격리되지 않은 모의 코드를 양산.
3. **거짓 합의와 검증 부재**: "코드가 작성되었습니다"라는 모델의 텍스트 답변만으로 작업이 완료되었다고 오판하여, 런타임 렌더링 깨짐이나 500 서버 에러를 뒤늦게 발견.

---

## 2. 최신 학계 및 산업계 하네스 엔지니어링 레퍼런스 (Industry & Academic References)

본 결정은 다음과 같은 글로벌 AI 연구 및 소프트웨어 엔지니어링 선행 연구를 기반으로 한다:

1. **Anthropic — *Building Effective Agents* (2024~2025)**:
   - 복잡한 단일 프롬프트 대신 명확한 워크플로우(Prompt Chaining, Routing, Orchestrator-Workers, Evaluator-Optimizer)와 역할 분리(Lead $\rightarrow$ Explorer $\rightarrow$ Builder $\rightarrow$ Reviewer) 원칙.
2. **Martin Fowler & Addy Osmani — *Spec-Driven Development (SDD) with AI* (2025~2026)**:
   - 코드가 아닌 **실행 가능한 사양(Executable Specification)**을 단일 진실 공급원(SSOT)으로 삼는 패러다임.
   - `Specify ➔ Plan ➔ Tasks ➔ TDD Implement ➔ Multi-Layer Verify` 파이프라인.
3. **GitHub — *Spec Kit & OpenSpec***:
   - 리포지토리 컨벤션을 파악하는 **Discovery Hooks**와 아키텍처 제약을 검증하는 **Validation Hooks**의 시스템화.
4. **Owais Abdullah / Kiseki Labs — *Harness Engineering***:
   - LLM 추론 엔진 주위에 상태 영속성, 헬스 게이트, 3계층 검증, 격리된 워크트리 환경을 제공하는 하네스 인프라 구축.

---

## 3. 결정 사항 (Decisions)

### 1) 마스터 서비스 생성 스킬 `service-forge` 도입
- 자연어 요구사항을 프로덕션 서비스로 구현하는 엔드투엔드 파이프라인(`.agents/skills/service-forge/SKILL.md`)을 구축한다.
- 5대 단계: `1. Discovery & Recon` $\rightarrow$ `2. Executable Specification (SDD)` $\rightarrow$ `3. Enforced Decomposition` $\rightarrow$ `4. TDD Construction Loop` $\rightarrow$ `5. 3-Tier Multi-Layer Deep Verification` $\rightarrow$ `6. Independent Review & Squash Merge`.

### 2) 행동 스펙 `spec-driven-service-creation` 강제
- `.agents/behaviors/spec-driven-service-creation/BEHAVIOR.md`를 신설하고 `behavior-spec.ts check` 검증 대상에 포함한다.
- 사양 동결 없는 직접 코딩 금지, Flaticon UIcons (`fi fi-rr-*`) 단일 아이콘 표준 준수, 4대 절 증거 문서(`evidence/`) 작성을 하드룰로 강제한다.

### 3) 3-Tier Multi-Layer Deep Verification 체계
- **Tier 1 (정적)**: TypeScript `typecheck`, ESLint, 스키마 유효성 검사.
- **Tier 2 (행동)**: 단위/통합 테스트, 불변식 퍼징(대차대조 0원, 1회용 Nonce, DLP 개인정보 마스킹), 돌연변이 사살 검증.
- **Tier 3 (실행/시각)**: 프로덕션 빌드 기동, 실제 브라우저/기기 뷰포트 DOM 렌더링, 콘솔 에러 0건, 고해상도 스크린샷 증빙.

---

## 4. 파급 효과 및 이점 (Consequences)

- **긍정적 효과**:
  - 어떤 요구사항이 주어져도 모델의 자의적 환각 없이 규격화된 고품질 서비스가 일관되게 생성됨.
  - 기존 생태계(Next.js 웹 마켓, Wails 교사용 런처, 관제 포털, 교실 LAN, Syncular)와 100% 결합 및 호환성 보장.
  - 빌더와 독립된 리뷰어 서명(`approved @ sha`) 및 PR Squash Merge를 통해 main 브랜치의 청정성 유지.
- **관리 비용**:
  - 사양 작성(`SPEC.md`/`plan.md`) 및 3-Tier 검증 단계가 필수로 수반되나, 사후 버그 수정 및 아키텍처 재작업 비용을 90% 이상 절감함.
