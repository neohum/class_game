# 계획서(Plan document) — 설계 한 장이 카드 전체를 만든다

`spec.md`의 한 줄과 `plan.md`의 카드는 **요청**이다. `plans/<slug>.plan.md`는
**설계**다. 사람이 한 번 승인하면 그 뒤는 기계적으로 실행된다 — 단계가 백로그
카드로 컴파일되고, 의존성 순서대로 실행되며, 서로 무관한 단계는 같은 wave에서
병렬로 돌고, 각 카드는 디스크에 증거를 남기고서야 커밋된다.

```
plans/<slug>.plan.md ──compile──▶ 순서가 있는 카드들 ──waves──▶ 병렬 빌드 ──▶ evidence/<날짜>-<카드>/
   status: approved                (의존성 자동 연결)                          (증거 없으면 ship 없음)
```

## 왜 이게 있나

| 없을 때 | 있을 때 |
| --- | --- |
| 빌더가 코드를 쓰는 순간에 설계를 발명한다. 리뷰 가능한 첫 산출물이 diff다. | 설계는 60초에 읽히는 문서다. 승인은 싸고, 실행은 자동이다. |
| 기능 하나를 카드 다섯 장으로 손수 나눠 넣는다. | 문서 하나가 다섯 장을 순서까지 갖춰 한 번에 큐잉한다. |
| `Dependencies:`는 스펙 텍스트에만 있고 아무도 읽지 않는다. FIFO가 순서다. | 의존성이 끝난 카드만 claim된다. 독립 카드는 동시에 돈다. |
| "테스트 통과함"이라는 모델의 말이 증거다. | `evidence/<날짜>-<카드>/`에 실제 출력이 남는다. |

## 문서 형식

````markdown
---
plan: ratelimit          # 파일명과 같은 lowercase slug
status: approved         # draft | approved  (draft는 컴파일되지 않는다)
risk: medium             # low | medium | high
owner: neohum           # risk: high면 필수 — 이 층위는 모델이 승인하지 않는다
---
# Plan: 공개 API 레이트 리밋

## Intent
API 키당 100req/min을 넘는 /api/v1/* 요청에 429를 반환한다.

## Non-goals
- 엔드포인트별 개별 한도
- 과금 연동

## Steps

### Step 1: ratelimit-middleware
- Goal: Redis 토큰 버킷 미들웨어를 추가한다
- Files: src/middleware/ratelimit.ts, src/app.ts, tests/ratelimit.test.ts
- Acceptance: AC-1: 101번째 요청이 429와 스키마에 맞는 본문을 받는다
- Tests: npm test -- ratelimit
- Risk: medium
- Complexity: low

### Step 2: ratelimit-config
- Goal: 한도를 설정에서 읽는다
- Files: src/config.ts
- Acceptance: AC-1: config의 limit 변경이 임계값에 반영된다
- Tests: npm test -- ratelimit
- Parallel: no

## Verification
Tier 1 `npm run typecheck` / Tier 2 `npm test` / Tier 3 curl 루프로 429 실측

## Reviewer topology
builder=codex, reviewer=claude(독립 프로바이더), challenge=on
````

### 단계 필드

| 필드 | 필수 | 의미 |
| --- | --- | --- |
| `Goal` | ✅ | 관찰 가능한 결과 한 문장 |
| `Files` | ✅ | **선언된 폭발 반경.** 카드의 path allowlist가 되고, 벗어난 편집은 fail-closed |
| `Acceptance` | ✅ | `AC-1: …` — 리뷰어가 저장소나 테스트로 확인할 수 있는 것 |
| `Tests` | ✅ | 실제 명령. "테스트한다"는 명령이 아니다 |
| `Risk` / `Complexity` | | low\|medium\|high. 생략하면 문서의 risk를 상속 |
| `Depends on` | | 생략하면 **바로 앞 단계에 자동 연결**된다 |
| `Parallel: yes` | | 앞 단계와 같은 wave. 앞 단계의 출력을 읽지 않을 때만 |
| `Allowed builders` | | 특정 레인으로 제한 |

단계 하나 = 카드 하나 = 리뷰 가능한 커밋 하나. 혼자서 검증할 수 없는 단계는
아직 단계가 아니다.

## 명령

| 명령 | 하는 일 |
| --- | --- |
| `node scripts/loop/plan-doc.ts init <slug> ["제목"]` | 뼈대 작성 |
| `node scripts/loop/plan-doc.ts check [slug]` | 검증 (오류 시 exit 1) |
| `node scripts/loop/plan-doc.ts waves <slug>` | 병렬 wave 출력 |
| `node scripts/loop/plan-doc.ts compile [--dry]` | 승인된 문서 → 백로그 카드 |
| `node scripts/loop/plan-doc.ts list` | 문서 목록과 상태 |
| `node scripts/loop/plan-gate.ts <card>` | 이 카드는 빌드가 허용되는가 |
| `node scripts/loop/deps.ts` | 지금 실행 가능한 카드 / 대기 중인 카드 |
| `node scripts/loop/evidence.ts open\|record\|verify <card>` | 증거 디렉터리 |

루프(`ralph-loop.ts`)는 매 틱마다 승인된 문서를 스스로 컴파일하므로, 보통은
`compile`을 직접 부를 일이 없다.

## 게이트 두 개

### 1. Plan gate — 계획 없이 위험한 빌드는 시작하지 않는다

`scripts/loop/plan-gate.ts`가 빌드 **이전**(워크트리 생성 전, 토큰 지출 전)에
판단한다.

- `gate.mode: risk` (기본) — `Risk: medium|high` 카드는 승인된 계획서가 필요하다
- `gate.mode: strict` — 모든 카드가 필요하다
- `gate.mode: off` — 아무 카드도 필요 없다. **대화형 실행 전용**: 무인 실행
  (`ralph-loop`/`factory`)은 `HARNESS_PLAN_GATE=off`를 거부하고 `risk`로 되돌린
  뒤 `guard` 이벤트를 남긴다 ([`AUTONOMY.md`](AUTONOMY.md)의 불변식과 같은 규칙).

막혔다면 해법은 계획서를 쓰는 것이지 게이트를 끄는 것이 아니다.

### 2. Evidence gate — 증거 파일이 없으면 검증은 일어나지 않은 것이다

`evidence/<YYYYMMDD>-<card>/README.md`의 네 절이 모두 채워져 있고 캡처된 산출물
파일이 최소 하나 있어야 커밋된다.

```
## WHAT WAS TESTED     실행한 명령/조작, 구동한 표면, 증명하려던 동작
## WHAT WAS OBSERVED   before/after 또는 새 동작 + 실제 출력이 담긴 파일
## WHY IT IS ENOUGH    의도한 동작을 어떻게 덮는지, 남은 회귀 위험은 무엇인지
## WHAT WAS OMITTED    가린 것(시크릿·토큰·env 덤프)과 돌리지 않은 것
```

적용 범위는 `evidence.requireAtRisk`(기본 `medium`)이며, **계획서에서 나온 카드는
위험도와 무관하게 항상** 증거를 남긴다 — 계획서가 검증을 약속했으므로 검증이
산출물이다. 증거가 빠진 카드는 실패 처리되지 않고 **소유자 승인 대기**로 넘어간다:
초록불이 켜진 리뷰 완료 diff를 파일 하나 때문에 버리지는 않는다.

## 설정 — `.harness-plan.json`

```json
{
  "schema": 1,
  "planDir": "plans",
  "evidenceDir": "evidence",
  "gate": { "mode": "risk", "ownerRequiredAtRisk": "high" },
  "evidence": { "requireAtRisk": "medium" },
  "waves": { "maxParallel": 3 }
}
```

런타임 override: `HARNESS_PLAN_DIR`, `HARNESS_EVIDENCE_DIR`, `HARNESS_PLAN_GATE`,
`HARNESS_PLAN_WAVE_MAX`. 파일은 프로젝트의 선언(커밋되고 리뷰된다), 환경변수는
운영자의 1회성 override — `.harness-quality.json`과 같은 층위 구조다.

## 실행 순서와 병렬성

`deps.ts`가 `Dependencies:`를 실제로 읽는다. 그래서 두 가지가 동시에 고쳐진다.

- **정확성**: 앞 단계가 끝나지 않은 카드는 claim되지 않는다. 예전에는 FIFO라
  운이 좋아야 순서가 맞았고, swarm 워커가 step 1이 빌드 중인데 step 2를 집어갈 수
  있었다.
- **속도**: "실행 가능한 카드 집합"이 곧 wave다. 워커 N개가 같은 카드를 두고
  경쟁하는 대신 (`LOOP_WORKER=worker-<n>` 슬롯만큼 어긋나게 집어) 서로 다른 카드를
  하나씩 가져간다.

`waves.maxParallel`은 "이 프로젝트의 한 wave는 몇 장까지 동시에 도는가"이고,
`node scripts/loop/swarm.ts start`에 N을 주지 않으면 **그 값이 워커 수의 기본값**이
된다. wave보다 워커가 많으면 같은 카드를 두고 경합하고, 적으면 wave가 한 줄로 선다.

백로그에 없는 이름을 의존성으로 적으면 **충족된 것으로 간주**하고 경고만 남긴다
(다른 저장소나 수작업으로 끝난 일일 수 있고, 풀 수 없는 이름으로 큐를 영구히
막는 것이 더 나쁘다). 같은 계획서 안에서 존재하지 않는 단계를 가리키는 것은
컴파일 시점에 거부된다 — 값싼 곳에서 잡는다.

## `plan.md`와 무엇이 다른가

둘 다 살아 있고 둘 다 매 틱 컴파일된다.

- **`plan.md`** — 한 줄짜리 잡무. 설계가 필요 없는 카드.
- **`plans/<slug>.plan.md`** — 기능. 설계·비목표·파일 단위 폭발 반경·검증 계층·
  리뷰어 구성이 있고, 여러 카드로 펼쳐진다.

`Risk: medium` 이상을 `plan.md`에 적으면 plan gate가 막는다. 그 카드는 계획서가
있어야 하는 카드라는 뜻이다.
