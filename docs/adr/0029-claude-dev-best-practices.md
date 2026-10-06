# ADR 0029: Anthropic claude.dev 핵심 엔지니어링 모범 사례 통합 (Prompt Diet, Caching, Dynamic Workflows, Blast Radius, Interactive HTML)

- **상태:** 채택 (Accepted)
- **날짜:** 2026-10-02
- **결정자:** 저장소 소유자(승인), lead(Claude), explorer/control(AGY)
- **관련:** `plans/claude-dev-best-practices.plan.md`, `docs/harness-conventions.md`, `docs/harness-loop.md`, `tests/context-budget.test.ts`, ADR-0026, ADR-0027

---

## 배경

Anthropic 공식 기술 블로그([claude.dev](https://claude.dev/))는 복합적인 에이전트 시스템을 프로덕션 환경에서
안정적이고 고성능으로 운영하기 위한 핵심 엔지니어링 모범 사례들을 공개했다.

주요 발견 사항과 과제는 다음과 같다:
1. **Prompt Overloading ("Unhobbling Claude"):** 시스템 프롬프트에 방대한 지침과 사소한 제약들을 과적재할수록 모델의 지시 추종력, 도구 선택 정확도, 추론 속도가 저하됨. 시스템 프롬프트를 80% 줄이고 간결한 핵심 계약만 남길 때 성능이 극대화된다.
2. **Prompt Caching 파괴 요인:** 프롬프트 상단에 동적 타임스탬프 배치, 미드 세션 도구 스키마/모델 임의 교체, 세션 압축 시 접두사(Prefix) 손상 등은 캐시 미스를 유발하여 비용과 지연 시간을 최대 10배 폭증시킨다.
3. **단일 에이전트 추론의 한계와 동적 워크플로우:** 복잡한 아키텍처 검토나 코드 생성 시 단일 에이전트 루프보다 적대적 검증(Adversarial Verification)이나 토너먼트(Tournament) 등 동적 다중 에이전트 워크플로우가 환각과 합의 오류를 크게 줄인다.
4. **파괴적 명령 실행 위험(Blast Radius):** `rm -rf`, 대량 삭제 등 파괴적 명령 실행 전 실제 삭제될 파일의 수와 용량을 미리 파악하지 못하면 치명적인 소스/데이터 손실이 일어날 수 있다.
5. **검증 가시성 한계:** 마크다운 텍스트 단독 보고서는 복합적인 테스트 결과나 벤치마크, 인터랙티브 디버깅에 한계가 있어, 단독 실행형 대화형 HTML 보고서가 요구된다.

---

## 결정

`create-agent-harness`의 핵심 불변식(Fail-Closed, Anti-False Consensus, Evidence Gate)을 강화하고,
Claude 3.7 / 3.5 및 다중 에이전트의 효율을 극대화하기 위해 claude.dev 5대 모범 사례를 아키텍처에 전면 채택한다.

### 1. 시스템 프롬프트 다이어트 원칙 (The 80% Rule & On-Demand Context)
- **항시 로드 컨텍스트 최소화:** `CLAUDE.md`, `rules.md`, `AGENTS.md`의 상시 로드 텍스트는 핵심 안전 불변식과 역할 경계만을 유지하며 3,600단어(템플릿은 1,800단어) 엄격 예산을 지속 강제한다 (`tests/context-budget.test.ts`).
- **도메인 절차 온디맨드화:** 세부 가이드, 체크리스트, 배포 절차는 상시 프롬프트에 넣지 않고 스킬(`skills/`)과 온디맨드 문서(`docs/harness-*.md`)로 점진적 노출(Progressive Disclosure)한다.
- **Unhobbling:** 과도한 부정형 제약 대신, 명확한 도구 스키마와 기대 결과, 실패 시 중단(Fail-Closed) 규칙을 명시하여 모델의 자율 문제 해결력을 보존한다.

### 2. 프롬프트 캐싱 불변식 (Prompt Caching Invariants)
- **정적 접두사 고정:** 시스템 프롬프트, 도구 스키마, 프로젝트 기본 규칙은 항상 컨텍스트의 최상단 고정 접두사로 유지한다.
- **세션 중 도구/모델 스왑 금지:** 실행 세션 도중에 도구 세트를 동적으로 추가/삭제하거나 모델을 교체하여 캐시 블록을 무효화하지 않는다.
- **동적 상태 후방 배치:** 현재 시간, Git 상태 diff, 동적 타임스탬프는 프롬프트 최상단이 아닌 유저 메시지 또는 프롬프트 최하단 가변 영역에 배치한다.

### 3. 동적 멀티 에이전트 워크플로우 (Dynamic Workflows)
Claude Code 공식 패턴을 수용하여 `.claude/workflows/` 디렉토리에 실행 가능한 워크플로우를 제공한다:
- **`adversarial-verify.mjs`:** 비판적 검증자 분할(Fan-out) 및 회의론자(Skeptic) 필터링 단계를 통해 안일한 승인을 차단.
- **`tournament.mjs`:** 여러 후보 코드/아키텍처 대안을 쌍별(Pairwise) 토너먼트로 맞붙여 승자를 선별.

### 4. 블라스트 반경 사전 비행 점검 가드 (`scripts/loop/blast-radius.ts`)
- `rm -rf`, `rmdir`, `del` 등 파괴적 명령 실행 전 대상 경로를 사전 분석하고 영향받는 파일 수와 바이트 수를 계산하는 CLI 도구를 제공한다.
- 위험 임계치(파일 50개 초과 또는 시스템/루트 디렉토리 근접)를 감지하여 사전 승인 없는 대규모 삭제를 차단한다.

### 5. 대화형 단독 실행 HTML 검증 산출물 권장 (Interactive HTML Artifacts)
- UI/UX 감사(`ux-audit`), 테스트 리포트, 벤치마크 등 다차원 검증 산출물은 마크다운 요약과 함께 외부 CDN 의존성이 없는 독립형 인터랙티브 HTML 문서(`docs/test-results.html` 등)로 생성하여 즉각적인 시각화와 탐색을 제공한다.

---

## 결과

- **장점:**
  - 프롬프트 캐시 히트율이 90% 이상 유지되어 토큰 비용이 70~80% 절감되고 응답 지연 시간이 획기적으로 개선된다.
  - 시스템 프롬프트 비대화가 차단되어 도구 선택 오류율 및 불필요한 추론 턴 수가 감소한다.
  - 파괴적 명령 실행 전 파일 수/용량을 사전 확인하여 데이터 안전성이 크게 강화된다.
  - 다중 에이전트 토너먼트 및 적대적 검증 워크플로우를 통해 높은 품질의 코드 합의를 도출한다.
- **안전 불변식 보존:**
  - 컨텍스트 예산(`tests/context-budget.test.ts`)의 엄격한 상한선은 그대로 유지된다.
  - 빌더와 독립된 프로바이더의 리뷰어 원칙(Anti-False Consensus)과 Fail-Closed 규칙은 변함없이 적용된다.
