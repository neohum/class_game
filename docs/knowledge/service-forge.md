# SERVICE-FORGE 도메인 지식 명세 (Spec-Driven Service Generation SSOT)

> **상태:** Active
> **문서 버전:** v1.0.0
> **최신 갱신일:** 2026-08-30

---

## 1. 개요 (Overview)

`service-forge`는 LLM 추론 엔진과 하네스 엔지니어링(Harness Engineering)을 결합하여, 사용자의 자연어 요구사항으로부터 프로덕션 품질의 서비스를 자율 구축하는 스펙 주도 엔지니어링(SDD) 도메인입니다.

기존 Vibe Coding의 구조적 결함(환각, 아키텍처 드리프트, 컨텍스트 블라인드 에러)을 제거하고, **사양(Specification) 동결 ➔ 분해(Decomposition) ➔ TDD Loop ➔ 3-Tier Multi-Layer Deep Verification** 파이프라인을 단일 진실 공급원(SSOT)으로 강제합니다.

---

## 2. 5대 핵심 파이프라인 (Core Execution Pipeline)

```
[User Request] ➔ [1. Discovery Recon] ➔ [2. SDD Spec Freeze] ➔ [3. Wave Decomposition] ➔ [4. TDD Loop] ➔ [5. 3-Tier Deep Verification] ➔ [6. Independent Review & PR Squash Merge]
```

1. **Discovery & Context Grounding**:
   - 기존 포트(`3001` 웹 마켓, `3005` 관제탑, `5173` 런처, `8080` 교실 LAN), DB 스키마, UIcons (`fi fi-rr-*`) 단일 표준 탐색.
2. **Executable Specification (SDD)**:
   - 데이터 계약, REST/SSE 엔드포인트 규격, 에러 엔벨로프, 불변식, 인수 기준(`AC-1~N`)이 담긴 `SPEC.md` 동결.
3. **Enforced Decomposition**:
   - `plans/<slug>.plan.md`를 통해 폭발 반경(`Files:`) 및 실행 테스트(`Tests:`)를 카드 단위로 분해.
4. **TDD Construction Loop**:
   - Red(실패 테스트) ➔ Green(최소 구현) ➔ Refactor(품질 개선) 사이클을 통해 자율 구현 및 자체 오류 수정.
5. **3-Tier Multi-Layer Deep Verification**:
   - Tier 1(정적 타입/린트) ➔ Tier 2(단위/통합/불변식 퍼징) ➔ Tier 3(실 브라우저/기기 뷰포트 DOM 실측 및 콘솔 에러 0건 관측).
6. **Independent Sign-off & Release**:
   - 빌더와 분리된 독립 리뷰어 서명(`approved @ sha`) 및 GitHub PR Squash Merge.

---

## 3. 관련 참조 문서

- [스킬 정의: service-forge](file:///Users/nm/orca/projects/all_market/.agents/skills/service-forge/SKILL.md)
- [행동 스펙: spec-driven-service-creation](file:///Users/nm/orca/projects/all_market/.agents/behaviors/spec-driven-service-creation/BEHAVIOR.md)
- [ADR 0025: 스펙 주도 개발 및 Service Forge 하네스 표준](file:///Users/nm/orca/projects/all_market/docs/adr/0025-spec-driven-development-and-service-forge-harness.md)
- [마스터 하네스 계약](file:///Users/nm/orca/projects/all_market/AGENTS.md)
