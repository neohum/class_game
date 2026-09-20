---
name: spec-driven-service-creation
description: Vibe Coding(무계획적 코드 생성)을 금지하고, 기계 판독 가능한 사양(SPEC.md/Data Contract/AC)을 먼저 동결한 뒤 TDD 루프와 3-Tier 다층 심층 검증을 거쳐 서비스를 구축한다.
---

# 스펙 주도 서비스 생성 (Spec-Driven Service Creation)

**Intent:** LLM에게 모호한 프롬프트로 곧바로 코드를 생성하게 하는 "Vibe Coding"은
환각, 아키텍처 드리프트, 보안 취약점, 컨텍스트 블라인드 결함을 유발한다.
소프트웨어 엔지니어링에서 코드는 결과물일 뿐이며, **사양(Specification)이 단일 진실 공급원(SSOT)**이어야 한다.
이 스펙은 모든 에이전트가 서비스를 생성하거나 확장할 때 **Spec-Driven Development(SDD)** 원칙을 엄격히 준수하도록 규정한다.

**Evidence:** 구현을 시작하기 전에 **도메인 컨텍스트, 데이터 계약 및 사양 문서**를 작성하고 동결해야 한다(MUST).
- 기존 코드베이스의 포트, 인증 체계, DB 스키마, 디자인 시스템(`fi fi-rr-*`)을 먼저 탐색하여 충돌을 방지한다.
- 데이터 모델, REST/SSE 엔드포인트 규격, 에러 엔벨로프, 불변식, 검증 가능한 인수 기준(`AC-1~N`)이 명시된 `SPEC.md` 또는 `plans/<slug>.plan.md`를 준비한다.
- 사양 없이 곧바로 프로덕션 코드를 타이핑하는 행위는 거부된다.

**Decision:** 작업 분해와 역할 파이프라인을 **명시적 경계(Explicit Boundaries)**로 통제한다(MUST).
- 단계별 폭발 반경(`Files:`)과 테스트 명령(`Tests:`)을 고정하여 불필요한 파일 수정을 차단한다.
- Lead(설계/스코프) ➔ Explorer(컨텍스트 감사) ➔ Builder(TDD 구현) ➔ Reviewer(독립 감사)의 4-Role 파이프라인 원칙을 준수한다.
- 빌더와 동일한 모델이나 프롬프트 세션이 스스로를 승인할 수 없으며, 반드시 독립된 리뷰어의 승인(`approved`)을 거친다.

**Execution:** 3-Tier Multi-Layer Deep Verification을 통과한 후에만 완료로 인정한다(MUST).
- **Tier 1 (정적 검증)**: 타입스크립트 타입체크 및 린트, 스키마 유효성 검사 100% 통과.
- **Tier 2 (행동 검증)**: TDD Red-Green-Refactor 루프를 통한 단위/통합 테스트 및 엣지 케이스 불변식 검증.
- **Tier 3 (실행/시각 실측)**: 실제 서비스 기동 상태에서 DOM 렌더링, 콘솔 에러 0건, 스크린샷 수집.
- `evidence/<date>-<card>/` 디렉터리에 4대 필수 절(`WHAT WAS TESTED`, `WHAT WAS OBSERVED`, `WHY IT IS ENOUGH`, `WHAT WAS OMITTED`)을 기록한다.

**Recovery:** 검증 실패나 테스트 깨짐 발생 시 질문으로 책임을 넘기지 않고, 로그를 기반으로 자체 수정(Self-Correction)한다.
사양의 근본적 결함이 발견된 경우 사양 문서를 먼저 개정한 후 재승인을 거쳐 구현을 재개한다.

**Failure modes:**
- 사양이나 인수 기준 없이 프롬프트만으로 무작정 코드 파일부터 생성하는 행위.
- 사양과 실제 구현 코드의 스키마/엔드포인트 명칭이 불일치하는 문서 드리프트.
- 3-Tier 다층 검증을 건너뛰고 "코드가 완성되었다"고 선언하는 행위.
- 임의의 인라인 SVG, Lucide, Heroicons, 이모지를 혼용하여 단일 아이콘 표준(`fi fi-rr-*`)을 위반하는 행위.
- 독립 리뷰 절차 없이 main 브랜치에 직접 푸시하거나 머지하는 행위.
