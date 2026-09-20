---
name: service-forge
description: 사용자의 아이디어나 요구사항을 바탕으로 스펙 주도 개발(SDD, Spec-Driven Development), 에이전트 하네스 엔지니어링, TDD 루프 및 3-Tier 다층 심층 검증을 거쳐 프로덕션 품질의 서비스를 자율 구축하는 종합 서비스 생성 스킬입니다. '서비스 생성', '신규 서비스 개발', '스펙 기반 개발', 'spec driven', 'service forge', '기능 빌드' 요청 시 사용.
---

# service-forge — Spec-Driven Autonomous Service Generator

`service-forge`는 단순 프롬프트에 의존하는 즉흥적 코딩(Vibe Coding)의 한계를 극복하고, **스펙 주도 개발(Spec-Driven Development, SDD)**과 **하네스 엔지니어링(Harness Engineering)** 원칙을 바탕으로 완전한 서비스를 자율적으로 구축하는 최상위 마스터 스킬입니다.

Anthropic의 *Building Effective Agents*, Martin Fowler & Addy Osmani의 *Spec-Driven Development*, GitHub의 *Spec Kit* 및 하네스 엔지니어링 베스트 프랙티스를 집대성하여 기획, 아키텍처 명세, 데이터 계약, TDD 구현, 3-Tier 검증, 독립 리뷰 및 배포까지 완결합니다.

---

## 🏛️ 핵심 이론 및 아키텍처 철학

```
[User Intent] (자연어 요구사항)
      │
      ▼
┌────────────────────────────────────────────────────────┐
│ 1. Discovery & Recon (기존 코드베이스 & 도메인 지식 분석)  │
└──────────────────────────┬─────────────────────────────┘
                           │
      ▼
┌────────────────────────────────────────────────────────┐
│ 2. Executable Specification (SDD / Data Contract 정의)  │
│    - SPEC.md / ARCHITECTURE.md / Schema / AC-1~N       │
└──────────────────────────┬─────────────────────────────┘
                           │
      ▼
┌────────────────────────────────────────────────────────┐
│ 3. Enforced Decomposition (의존성 그래프 & Wave 분할)     │
│    - plans/<slug>.plan.md (Files allowlist, Test Cmds) │
└──────────────────────────┬─────────────────────────────┘
                           │
      ▼
┌────────────────────────────────────────────────────────┐
│ 4. Multi-Role TDD Construction Loop                    │
│    - Red (테스트 작성) ➔ Green (구현) ➔ Refactor       │
└──────────────────────────┬─────────────────────────────┘
                           │
      ▼
┌────────────────────────────────────────────────────────┐
│ 5. 3-Tier Multi-Layer Deep Verification                │
│    - Tier 1: 정적 타입/린트/스키마 무결성 검증          │
│    - Tier 2: 단위/통합/불변식(Fuzzing/Mutation) 검증   │
│    - Tier 3: 실 브라우저 DOM/시각적 렌더링 실측         │
└──────────────────────────┬─────────────────────────────┘
                           │
      ▼
┌────────────────────────────────────────────────────────┐
│ 6. Independent Review Gate & GitHub PR Squash Merge   │
└────────────────────────────────────────────────────────┘
```

### 1. Vibe Coding에서 Spec-Driven Development(SDD)로의 전환
- **Vibe Coding의 위험**: 모호한 프롬프트로 바로 코드를 찍어내면 환각(Hallucination), 아키텍처 드리프트, 컨텍스트 블라인드 에러, 기술 부채가 급증합니다.
- **SDD의 해결책**: **"사양(Specification)이 단일 진실 공급원(SSOT)"**입니다. 코드를 작성하기 전에 데이터 스키마, 엔드포인트 계약, 불변식, 인수 기준(`AC-*`)을 기계 판독 가능한 명세로 먼저 동결(Freeze)합니다.

### 2. 하네스 엔지니어링 (Harness Engineering)
- LLM은 실행 프로그램이 아닌 추론 엔진입니다. 안정적 서비스 생성을 위해 하네스는 **상태 영속화(State Persistence), 격리된 워크트리, 3계층 품질 게이트, 롤백 기제, 독립 감사** 환경을 제공합니다.

### 3. Multi-Role 파이프라인 분리
- **Lead / Architect**: 스코프 확정, 아키텍처 및 데이터 계약 설계, 폭발 반경(Files allowlist) 통제.
- **Explorer**: 코드베이스 종속성 추적, 정적 분석 및 잠재 결함 식별.
- **Builder**: 헬스 게이트 아래 엄격한 TDD(Red-Green-Refactor) 반복 구현.
- **Reviewer**: 빌더와 독립된 신뢰 도메인에서 인수 증거 대조, 회귀 검사 및 승인.

---

## 🛠️ 6단계 실행 표준 절차

### 제1단계: Discovery & Context Grounding (환경 탐색)
새 서비스를 구축하기 전, 기존 코드베이스의 규약과 재사용 가능한 인프라를 먼저 파악합니다.
1. `repo-recon` 및 `find_by_name`, `grep_search`를 활용하여 관련 라우트, 스키마, 컴포넌트, 공통 유틸을 조사합니다.
2. 사용 중인 포트(`3001` 웹 마켓, `3005` 관제탑, `5173` 런처, `8080` 교실 LAN 등)와 환경 변수를 확인합니다.
3. 디자인 표준: Flaticon UIcons Regular Rounded (`fi fi-rr-*`) 단일 아이콘 표준과 공유 디자인 토큰을 확인합니다. (임의의 SVG, Lucide, Heroicons, 이모지 혼용 엄격 금지)

### 제2단계: Executable Specification (실행 가능한 사양 작성)
`docs/specs/<service-name>.spec.md` 또는 `plans/<service-name>.plan.md`에 사양을 작성합니다.
1. **Service Metadata**: 서비스 명칭, 목적, 대상 사용자(교사, 학생, 관리자, 개발사), 배포 타깃.
2. **Data Contract & Schema**: 테이블/컬렉션 필드, 타입, 제약조건, 필수 인덱스.
3. **API & Event Envelope**: REST 엔드포인트(Method, Path, Request, Response, Error envelope), SSE/WebSocket 이벤트 포맷.
4. **Core Invariants & Security**: 오차 0원 대차대조, 1회용 Nonce, 주민번호(RRN) DLP 필터링, 관리자 보안 경계(`requireAdmin()`).
5. **Acceptance Criteria (AC)**: 검증 가능한 인수 기준(`AC-1`, `AC-2`, ...)을 정확히 명시.

### 제3단계: Enforced Decomposition & Wave Planning (계획 수립)
1. `node scripts/loop/plan-doc.ts init <slug>` 또는 계획서 템플릿을 통해 단계별 카드로 분해합니다.
2. 각 단계는 **폭발 반경(`Files:`)**, **인수 기준(`Acceptance:`)**, **실행 테스트(`Tests:`)**를 필수로 갖춥니다.
3. 서로 의존성이 없는 독립 단계는 동일 Wave에 배치하여 병렬 실행을 지원합니다.

### 제4단계: TDD Construction Loop (테스트 주도 구현)
1. **Red**: 요구되는 동작과 엣지 케이스를 검증하는 실패하는 테스트를 먼저 작성합니다.
2. **Green**: 테스트를 통과시키는 최소한의 프로덕션 코드를 구현합니다.
3. **Refactor**: 디자인 토큰, 클린 코드, 재사용성, 성능을 개선하며 테스트 초록불을 유지합니다.
4. **Self-Correction**: 빌드나 테스트 실패 시 외부 질문 없이 에러 로그를 분석하여 스스로 원인을 해결합니다.

### 제5단계: 3-Tier Multi-Layer Deep Verification (다층 심층 검증)
1. **Tier 1 (정적 검증)**: 타입스크립트 타입체크(`pnpm typecheck`), 린트(`eslint`), 스키마 밸리데이션.
2. **Tier 2 (행동 검증)**: 단위/통합 테스트(`pnpm test`, `node --test`), 불변식 퍼징 및 돌연변이 사살 검증.
3. **Tier 3 (실행/시각 실측)**: 프로덕션 빌드 실행 및 실제 브라우저/기기 뷰포트(데스크톱, 태블릿, 모바일) 렌더링, 콘솔 에러 0건, 스크린샷 증빙 수집.

### 제6단계: Evidence, Independent Review & Squash Merge (증거 및 병합)
1. `evidence/<YYYYMMDD>-<service-slug>/` 디렉터리에 4대 필수 절(`1. WHAT WAS TESTED`, `2. WHAT WAS OBSERVED`, `3. WHY IT IS ENOUGH`, `4. WHAT WAS OMITTED`) 증거 문서를 작성합니다.
2. 독립 서브에이전트(`reviewer`)를 호출하여 무결성 감사를 수행하고 승인 서명을 획득합니다:
   ```
   독립-리뷰-판정: approved (reviewer) @ <40자리 sha>
   ```
3. GitHub CLI를 통해 PR을 생성하고 메인 브랜치로 Squash Merge를 수행합니다:
   ```bash
   gh pr create --title "feat(<scope>): <서비스명>" --body "<상세 내용>"
   gh pr comment <PR번호> --body "독립-리뷰-판정: approved (reviewer) @ <sha>"
   gh pr merge <PR번호> --squash --delete-branch --subject "#<PR번호> feat(<scope>): <서비스명>"
   ```

---

## 📋 Service Forge 체크리스트

| 점검 항목 | 기준 및 요구사항 | 확인 |
| :--- | :--- | :---: |
| **스펙 우선 (Spec-First)** | 코딩 전 `SPEC.md` / `plan.md`에 스키마, API, AC 정의 완료 여부 | [ ] |
| **단일 진실 공급원 (SSOT)** | 코드와 문서, Data Contract 블록이 100% 동기화되었는지 여부 | [ ] |
| **단일 아이콘 표준** | Flaticon Regular Rounded (`fi fi-rr-*`) 준수 및 임의 SVG/이모지 배제 | [ ] |
| **안전한 보안 경계** | 입력값 검증, DLP 개인정보 마스킹, 권한 게이트(`requireAdmin`) 적용 | [ ] |
| **3-Tier 검증 통과** | 정적 검사 + 자동화 테스트 100% PASS + 실제 DOM/화면 관측 완료 | [ ] |
| **4개 절 증거 문서** | `evidence/` 하위에 4대 영문 대문자 절과 실행 산출물 보존 여부 | [ ] |
| **독립 리뷰 & Squash** | 빌더와 분리된 리뷰어 승인 코멘트 및 `#<PR> ...` 스쿼시 머지 여부 | [ ] |

---

## 🔗 참고 문헌 및 리소스
- Anthropic: *Building Effective Agents* (Workflows, Orchestrator-Workers, Evaluator-Optimizer)
- Martin Fowler: *Spec-Driven Development with AI*
- Addy Osmani: *Software Engineering in the Age of LLMs*
- GitHub: *Spec Kit & OpenSpec Specification Framework*
- Owais Abdullah / Kiseki Labs: *Harness Engineering: Building Durable and Inspectable Coding Agents*
- All Market: [AGENTS.md](file:///Users/nm/orca/projects/all_market/AGENTS.md), [docs/behavior-specs.md](file:///Users/nm/orca/projects/all_market/docs/behavior-specs.md)
