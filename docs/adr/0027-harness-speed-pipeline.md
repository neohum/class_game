# ADR 0027: 하네스 전 과정 고속화를 위한 스킬화 및 초고속 파이프라인 구축

- **상태:** 채택 (Accepted)
- **날짜:** 2026-09-17
- **결정자:** 저장소 소유자(승인), lead(Claude), explorer/control(AGY)
- **관련:** `plans/harness-speed-skills.plan.md`, `docs/harness-speed.md`, `tests/context-budget.test.ts`, ADR-0026

---

## 배경

`create-agent-harness`는 엄격한 Multi-Layer Deep Verification, Plan Gate, Evidence Gate, Anti-False Consensus 등
강력한 안전 불변식을 제공한다. 그러나 실무 작업 시 에이전트와 개발자가 거치는 8대 라이프사이클 과정에서
반복적인 다단계 CLI 호출과 불필요한 전체 테스트 실행으로 인해 심각한 지연과 턴 수 낭비가 발생해 왔다.

특히:
1. **증거 수집/검증(Evidence Gate) 지연:** 카드 완료 시 `open`, `record`, `README.md` 4대 섹션 수동 작성(각 20자 이상), `verify`까지 4~8턴 소요 (최대 병목).
2. **TDD 개발 루프 지연:** 단일 파일 수정 후에도 49개 테스트를 모두 돌리는 `npm test` 남발로 턴당 30~45초 대기.
3. **계획서 승인-컴파일 지연:** `check`, `status: approved` 수동 갱신, `compile`, `waves` 확인의 4단계 분산.
4. **지식 탐색 중복:** 이미 해결된 트러블슈팅 사례가 있음에도 매번 맨땅에서 5~10턴 검색.
5. **릴리즈(Ship) 지연:** 브랜치 이동, 버전 비교, 헬스 게이트, PR 생성, 머지, 브랜치 삭제의 13단계 수동 대화형 실행.

## 결정

안전 불변식(Fail-Closed, Anti-False Consensus, Evidence Gate)을 100% 보존하면서, 전 과정을 3배~10배 가속하는
5대 초고속 파이프라인 및 스킬을 구축한다.

| 라이프사이클 단계 | 기존 방식 (Before) | 개선 방식 (After: 스킬 및 매크로) | 기대 절감 효과 |
|---|---|---|---|
| **1. 계획서 실행화** | `check` ➔ 수동 approved ➔ `compile` ➔ `waves` (5~7턴) | `plan-doc.ts ready <slug>` 단일 명령 | 5턴 ➔ 1턴 (15초) |
| **2. TDD 로컬 루프** | 전체 스위트 `npm test` (30~45초) | `test-fast.ts` / `npm run test:quick` (<1.5초) | 20배~30배 속도 향상 |
| **3. 증거 수집/검증** | 4단계 수동 파일 작성 및 수정 반복 (4~8턴) | `evidence.ts capture <card> --cmd "..."` 단일 명령 | 6턴 ➔ 1턴 (3초) |
| **4. 지식 디버깅** | 맨땅에서 웹/파일 검색 (5~10턴) | `debug-protocol` 0단계 `knowledge.ts recall` 강제 | 기해결 이슈 0턴 즉결 |
| **5. 릴리즈 & 머지** | `ship` 13개 세부 CLI 수동 대화형 실행 (10~15턴) | `scripts/loop/ship.ts` 통합 안전 매크로 | 13턴 ➔ 1~2턴 완결 |

### 컨텍스트 예산 상한 규칙 (Context Budget Guardrail)
신규 스킬은 시스템 프롬프트 비대화 방지 및 `tests/context-budget.test.ts` 상한선(.claude 1,300단어, .agents 900단어) 준수를 위해:
- 신규 스킬(`quick-evidence`, `fast-gate`)의 frontmatter `description`은 **35단어 이하**로 엄격히 제한한다.
- 무거운 실행 로직은 스크립트(`scripts/loop/*.ts`)에 은닉하고, 스킬은 발동 키워드와 단일 명령 지침만 제공한다.

## 결과

- **장점:** 에이전트의 불필요한 추론/도구 호출 턴 수가 70% 이상 감소하고, TDD 피드백 시간이 1초대로 단축되며, 증거 게이트 완결이 원클릭으로 가속된다.
- **안전 보존:** 모든 고속화 명령은 검증 실패 시 exit code 1로 fail-closed 중단되며, 증거 없는 ship이나 비독립 리뷰 머지를 허용하지 않는다.
