# Jev 판정 레이어 — 내용 기반 리스크 채점

> 계획서: [`plans/jev-decision-layer.plan.md`](../plans/jev-decision-layer.plan.md)
> 결정 기록: [`docs/adr/0028-jev-content-risk-scoring.md`](adr/0028-jev-content-risk-scoring.md)

## 왜 있는가

`framein.ts`의 `riskScore()`는 **파일 이름만** 본다. diff 본문을 한 줄도 읽지 않는다.
그래서 두 가지가 동시에 일어난다.

| 변경 | 정규식 판정 | 실제 |
| --- | --- | --- |
| `payment_utils.ts`의 오타 수정 | `high` | 무해 — 사람 탭을 불필요하게 요구 (거짓 양성) |
| `server.ts` 안에서 권한 검사 한 줄 삭제 | `low` | **위험 — 자율 배포됨 (거짓 음성)** |

거짓 양성은 성가심이다. **거짓 음성은 게이트가 뚫린 것**이다. 민감한 이름이 붙지
않은 파일 안에서 벌어지는 권한 우회·시크릿 노출·스키마 파괴는 Tier 3 게이트를
그대로 통과한다. Jev는 hunk 본문을 읽고 판정하므로 이 구멍을 겨냥한다.

## 무엇인가

[TypeSafe AI](https://typesafe.ai)의 **Jev**는 "System One" 모델이다. 텍스트를
생성하지 않고, `state`와 이름 붙은 타입 질문을 받아 **타입이 정해진 값 + 보정된
확률**을 돌려준다. 세 가지 질문 타입이 있다.

| 타입 | 반환 | 쓰임 |
| --- | --- | --- |
| `noul` | 0~1 진리값 | 예/아니오 판정 — 이 레이어가 쓰는 것 |
| `choice` | 옵션 키 + 확률 + confidence | N중 택1 |
| `score` | 2~10 레벨 위 위치 | 정도 판정 |

- 엔드포인트: `POST https://api.typesafe.ai/v1/systemone`
- 지연 70~500ms, 입력 **$0.042/MTok**, 출력 무료
- 한도: state 단독 **32k 토큰**, state+질문 합쳐 **64k**

질문을 여러 개 실어도 응답 시간이 거의 변하지 않으므로, 이 레이어는 **5개 질문을
한 요청에** 묶는다.

## 안전 모델 — 게이트를 조이기만 한다

이 레이어 전체의 안전 근거는 한 줄이다.

```
최종 리스크 = max(정규식 판정, Jev 판정)
```

`scripts/loop/jev-risk.ts`의 `maxLevel()` 한 곳에서 강제한다. 따라서:

1. **Jev는 정규식 판정을 낮출 수 없다.** 정규식이 `high`면 Jev가 확신을 갖고
   "안전"이라 해도 `high`다. 이 레이어를 켜는 것이 기존 보호를 약화시킬 수 없다.
2. **모든 실패는 정규식 결과로 되돌아간다.** 키 없음·타임아웃·비정상 응답·기능
   꺼짐 → `source: "regex"`로 기록하고 정규식 값을 그대로 쓴다. 이는 게이트를
   *여는* 것이 아니라 **Jev 도입 이전 동작**이므로 fail-closed 원칙과 충돌하지 않는다.
3. **확률 원값을 버리지 않는다.** `jev` 필드와 텔레메트리에 남는다. 임계값 튜닝은
   근거(Step 4 혼동행렬) 위에서만 한다.
4. **Tier 3(사람 탭)은 건드리지 않는다.** `persona-approve.ts`의 사람 승인 층은
   그대로고, Jev는 그 아래에서 입력을 더 정확하게 만들 뿐이다.

## 켜는 법

**기본은 꺼져 있다.** 코드 diff가 제3자 API로 나가는 일이므로 옵트인이다.

```bash
export FRAMEIN_JEV=1               # 1 | on | true 만 켬 — 이것만으로 동작한다
```

키 없이 바로 쓸 수 있다. 판정기는 **두 가지 백엔드** 중 하나를 쓴다.

| 백엔드 | 필요한 것 | 지연 | 비고 |
| --- | --- | --- | --- |
| `claude` (기본) | 이미 있는 구독 CLI | ~12초 | 추가 비용·의존성 0, **diff가 제3자에게 안 나간다** |
| `jev` | `TYPESAFE_API_KEY` | 70~500ms | 보정된 확률(RLCD), 빠름 |

`FRAMEIN_JEV_BACKEND`를 지정하지 않으면 **키가 있을 때만** `jev`를 쓰고 없으면
`claude`로 간다. 두 백엔드는 같은 `{answers:{name:{noul}}}` 모양을 돌려주므로
단조 합성·임계값·폴백은 **동일하게** 적용된다.

> **왜 자체 구현(로컬 모델)이 기본이 아닌가.** 이 저장소에서 실측했다:
> `qwen2.5:7b`는 5케이스 중 4개를 맞혔지만 확률이 전부 `0.000` 아니면 `1.000`이라
> 임계값이 의미를 갖지 못했고, 틀린 1건도 확신에 차서 틀렸다. `gemma4:12b`는
> `<|channel|>` 제어 토큰을 먼저 출력해 한 토큰 판정에 부적합했다. Jev의 실제
> 가치인 **보정된 확률**이 재현되지 않는다. 구독 CLI는 같은 케이스에서
> confidence를 0.95/0.98/1.0으로 차등해 돌려줬다.

### 키 발급·저장 (`setup-typesafe-key.ts`)

키 생성 자체는 **콘솔 전용**이다 — TypeSafe에는 키를 발급하는 엔드포인트가 없다.
그래서 이 스크립트가 콘솔 페이지를 열고, 나머지 기계적인 단계를 전부 처리한다.

```bash
node scripts/setup-typesafe-key.ts           # 페이지 열기 → 붙여넣기 → 검증 → .env
node scripts/setup-typesafe-key.ts --push    # ...그리고 Infisical까지 푸시
node scripts/setup-typesafe-key.ts --check   # 저장된 키가 아직 유효한지만 확인
echo "sk-..." | node scripts/setup-typesafe-key.ts --stdin   # 비대화형
```

설계상 지키는 것:

- **키를 argv로 받지 않는다.** 명령행 인자는 셸 히스토리와 `ps` 출력에 남는다.
  입력은 에코 없는 프롬프트(또는 stdin)로만 받는다.
- **검증 전에는 저장하지 않는다.** 실제 API를 한 번 호출해 200 + `answers`를
  확인한 뒤에만 `.env`에 쓴다. 형식 검사만으로는 **폐기된 키**를 구분할 수 없고,
  그 사실을 평가 도중에 알게 되면 케이스 파일을 절반 태운 뒤다.
- **`.env`의 다른 줄을 건드리지 않는다.** 기존 `TYPESAFE_API_KEY`는 제자리에서
  교체하고, 이름이 겹치는 다른 변수(`TYPESAFE_API_KEY_OLD` 등)는 건드리지 않는다.
- **키를 화면에 전부 찍지 않는다.** 로컬 터미널에도 `sk-abc…wxyz (29자)`로만 보인다.

| 환경변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `FRAMEIN_JEV` | *off* | `1`/`on`/`true`일 때만 판정기를 호출한다 |
| `FRAMEIN_JEV_BACKEND` | 키 있으면 `jev`, 없으면 `claude` | `jev`(TypeSafe API) 또는 `claude`(구독 CLI) |
| `TYPESAFE_API_KEY` | — | `jev` 백엔드에만 필요. 없으면 자동으로 `claude`로 간다 |
| `JEV_CLAUDE_MODEL` | `haiku` | `claude` 백엔드가 쓰는 모델 |
| `JEV_CLAUDE_TIMEOUT_MS` | `90000` | 초과 시 정규식으로 폴백 |
| `JEV_MODEL` | `jev-1.13.0` | **고정 버전.** `jev-latest`가 기본이 아닌 이유는 아래 |
| `JEV_TIMEOUT_MS` | `10000` | 초과 시 정규식으로 폴백 |
| `JEV_RISK_THRESHOLD` | `0.45` | 이 확률 이상이면 적중. 0.5 미만인 이유는 아래 |
| `JEV_REDACT_STRICT` | *off* | 스크러빙 후에도 자격증명처럼 보이면 **본문을 아예 보내지 않는다**(fail-closed) |

### 왜 모델 버전을 고정하는가
TypeSafe 문서가 명시적으로 경고한다 — 임계값을 튜닝했다면 `jev-latest`가 아니라
버전을 핀하라. 이 레이어의 모든 판정이 임계값 비교이므로 기본값을 고정 버전으로 둔다.

### 왜 임계값이 0.5 미만인가
이 채점기는 **게이트를 조이는 방향으로만** 작동한다. 거짓 양성의 대가는 사람이
한 번 더 쳐다보는 것이고, 거짓 음성의 대가는 auth 우회가 배포되는 것이다.
비용이 비대칭이므로 임계값도 비대칭이다.

## 질문은 원자적으로 쪼갠다

Jev는 **문자 그대로 읽는다**(문서 경고: 부정문·범위 한정어를 액면가로 받고, 세거나
날짜 계산을 못 한다). 그래서 `RISK_QUESTIONS`의 다섯 질문은 각각 한 가지만 묻고,
복합 판단은 코드에서 합성한다. 테스트가 이를 강제한다 — 질문에 `and`가 들어가면
실패한다.

| 키 | 묻는 것 | 매핑되는 정규식 사유 |
| --- | --- | --- |
| `auth` | 인증·인가·세션·접근제어의 수정/제거/우회 | `auth/permissions` |
| `secrets` | 자격증명·키·토큰의 추가/노출/하드코딩 | `secrets/credentials` |
| `schema` | 스키마·마이그레이션·영속 데이터 형태 파괴 | `schema/migration` |
| `billing` | 결제·청구·가격·구독 동작 | `billing/payments` |
| `destructive` | 사용자 데이터/운영 상태의 비가역 변경 | `destructive operation` |

## 두 번째 적용점: spec 텍스트 (`jev-sensitive.ts`)

`jev-risk.ts`가 **diff**를 읽는다면, 이쪽은 카드가 쓰여진 **문장**을 읽는다.
`persona-approve.ts`의 `SENSITIVE_PATTERNS`는 키워드 매칭이라, 위험한 변경을
위험한 단어 없이 서술하면 그대로 통과한다. 이 저장소에서 실측한 결과:

| spec | 정규식 | 실제 |
| --- | --- | --- |
| "remove the admin gate from the records endpoint" | (없음) | auth 우회 |
| "let anyone through without checking who they are" | (없음) | auth 우회 |
| "stop verifying the bearer before trusting it" | (없음) | auth 우회 |
| "fix a typo in the payment docs" | `billing/cost` | 무해 (과잉 발동) |

같은 단조 규칙이 적용된다 — **최종 = 정규식 ∪ 판정**. 정규식 히트는 판정기가
반대해도 절대 사라지지 않고, 모든 실패 경로는 정규식 결과를 그대로 돌려준다.
`decide()`는 순수·동기 함수로 남겨 두고(테스트 가능성이 그 함수의 핵심 가치다),
계산된 사유를 인자로 받는다.

실제 CLI 확인:
```
"let anyone through without checking who they are" → auth 1.00, 나머지 전부 0
"rename a local variable in the parser"            → 전부 0 (과잉 발동 없음)
```

## 시크릿 스크러빙 — 최선의 노력이지 보장이 아니다

`jev-state.ts`가 만드는 모든 hunk는 **두 단계**를 거친다: `redact.ts`(하네스 공용
규칙) → `scrubForEgress()`(이 경로 전용).

두 번째 단계가 필요한 이유는 측정으로 확인됐다. `redact.ts`는 스스로 밝힌 대로
"persisted/exported harness data"(로컬 파일과 신뢰된 허브)를 위한 것이고, 이름
접미사 규칙(`*_TOKEN`, `*_SECRET` …)을 쓴다. 그래서 적대적 리뷰에서 다음이 **그대로
통과**했다:

```
aws_access_key_id = AKIAIOSFODNN7EXAMPLE      JWT_SIGNING_KEY: "..."
  password: "hunter2correcthorse",            TWILIO_AUTH = "..."
"client_secret": "GOCSPX-..."                 -----BEGIN RSA PRIVATE KEY-----
```

로그 파일에는 감수할 만한 수준이지만, **되돌릴 수 없는 네트워크 유출 경로의 유일한
통제로는 부적합**하다. `scrubForEgress()`가 AWS/Google/OAuth 키, PEM 블록, JWT,
그리고 이름 아무 곳에나 credential 단어가 든 대입문을 덮는다(변수 이름은 남긴다 —
이름 자체가 Jev가 읽어야 할 신호다).

> **그래도 보장은 아니다.** 패턴 매칭이므로 새로운 형식은 빠져나갈 수 있다.
> 사내 자격증명이 트리에 있는 저장소라면 이 기능을 켜기 전에 판단이 필요하다.
> 확실히 막아야 하면 `JEV_REDACT_STRICT=1`로 **fail-closed**로 돌린다 — 스크러빙
> 후에도 자격증명처럼 보이는 본문은 전송하지 않고 파일 이름만 남긴다(정규식 바닥은
> 여전히 그 이름을 본다).

lockfile·번들·바이너리는 본문을 빼고 이름만 보내 토큰 예산을 신호 있는 hunk에 쓴다.

state가 한도에 걸려 잘리면 state 안에 그 사실을 명시한다("PARTIAL DIFF … absence of
evidence here is not evidence of absence") — 모델이 "전부 봤다"고 착각한 채
"안전하다"고 답하는 것을 막기 위해서다.

## 구성

| 파일 | 역할 |
| --- | --- |
| `scripts/loop/jev.ts` | 의존성 없는 HTTP 클라이언트(`noul`/`choice`/`score`) |
| `scripts/loop/jev-backend-claude.ts` | 구독 CLI 백엔드(키 불필요) |
| `scripts/loop/jev-sensitive.ts` | **spec 텍스트** 판정 → `persona-approve` 게이트 |
| `scripts/loop/jev-state.ts` | diff → 예산 안에 맞춘 state, redact 경유 |
| `scripts/loop/jev-risk.ts` | 단조 합성(`max`)과 폴백 |
| `scripts/loop/framein.ts` | `risk` 동사가 합성 결과를 쓴다 |
| `scripts/loop/ralph-loop.ts` | 두 판정 지점이 합성 결과를 쓴다 |

SDK(`@typesafe-ai/sdk`)는 쓰지 않는다. 이 저장소는 런타임 의존성 0개가 계약이고,
Jev는 엔드포인트 하나에 대한 POST 한 번이라 전역 `fetch`로 충분하다.

## 확인

```bash
node --test tests/jev.test.ts tests/jev-state.test.ts tests/framein-risk-fusion.test.ts
node scripts/loop/framein.ts risk <card>   # source 필드로 어느 경로였는지 확인
```
