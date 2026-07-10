# Evolution Loop — 자율 루프 통합 가이드

design-evolve를 always-on 자율 루프로 굴리는 방법. 기존 `template/scripts/loop/`(ralph-loop) 인프라와 어떻게 맞물리는지 설명한다. design-evolve 스킬 본문만으로 한 세대는 충분히 돌아가므로, 이 파일은 **지속 자율화**가 필요할 때만 읽는다.

## 목차
1. [deploy-gate 페르소나와의 대응 관계](#1-대응-관계)
2. [/loop 방식 (가벼움)](#2-loop-방식)
3. [ralph-loop 통합 (서버 상주)](#3-ralph-loop-통합)
4. [Telegram 보정 배선](#4-telegram-보정-배선)
5. [에코챔버 방지](#5-에코챔버-방지)

---

## 1. 대응 관계

design-evolve는 새 메커니즘이 아니라, 검증된 deploy-gate 페르소나 학습을 디자인 도메인으로 옮긴 것이다. 같은 부품을 재사용하니 신뢰성이 검증돼 있다.

| deploy-gate (기존) | design-evolve (신규) | 역할 |
|---|---|---|
| `persona.md` | `designer-persona.md` | 파라미터 θ (언어로 쓰인 정책/취향) |
| 승인/반려 탭 | 토너먼트 승자 탭 | ground-truth 라벨 |
| `persona-feedback.jsonl` | `design-feedback.jsonl` | 능동학습 데이터셋 |
| `persona-synthesize.mjs` | `design-persona-synthesize.mjs` | LEARNED 블록 재작성(경사하강) |
| p≈0.5일 때 escalate | 상위 2개 차<5일 때 탭 요청 | 불확실할 때만 인간에게 (최대정보 샘플) |
| `persona-bootstrap`(git 채굴) | (선택) 과거 디자인 평가 시드 | 콜드스타트 완화 |

**핵심 공유 원리:** 불확실할 때만 인간에게 묻는다. 그래서 모든 탭이 능동학습에서 가장 정보량 큰 샘플이 되고, 탭 횟수는 라운드를 거칠수록 줄어든다.

## 2. /loop 방식

가장 단순한 지속 자율화. `design-evolve`를 반복 호출한다:
- 자기페이스: `/loop /design-evolve` (interval 생략 시 모델이 페이스 결정)
- 주기: `/loop 30m /design-evolve` 식.

매 호출이 한 세대다. persona가 PERSONA_HOME에 누적되므로 세대 간 안목이 이어진다. 인간은 가끔 Telegram 탭만.

## 3. ralph-loop 통합

서버 상주 루프에 디자인 진화를 얹으려면, 백로그가 빌 때 도는 self-assessment 자리에 디자인 탐색 세대를 큐잉한다.

- `assess-shortcomings.mjs`가 코드 단점을 큐잉하듯, 디자인 탐색 카드("라운드 N 진화")를 백로그에 추가하는 얇은 트리거를 둔다.
- 한 카드 = 한 세대. 빌더 역할이 design-evolve 절차를 수행한다.
- 공유 인프라 그대로 사용: `capture-screenshot.mjs`(프리뷰 촬영), `upload-wasabi.mjs`(스크린샷 호스팅), `notify-telegram.mjs`/`telegram-listener.mjs`(탭 보정), `cooldown.mjs`(에이전트 로테이션), `telemetry.mjs`(트레일).
- 추가로 필요한 것은 design-evolve의 4개 번들 스크립트뿐. 새 서버 인프라는 사실상 없다.

> 통합 시 주의: 디자인 진화는 코드 deploy처럼 프로덕션에 즉시 영향을 주지 않는다. 따라서 deploy-railway 게이트를 타지 않고, 산출물(토큰·가이드)을 브랜치/PR로만 올려 사람이 채택 여부를 결정하게 한다.

## 4. Telegram 보정 배선

`notify-telegram.mjs`는 스크린샷 1장 + 버튼을 보낸다. 보정에서는 **상위 2개 변형 스크린샷**을 나란히 보내고 "어느 쪽?"을 묻는다.
- 메시지: 두 preview.png(또는 합성 1장) + composite 점수 + 각 전략 한 줄.
- 응답: ✅A / ✅B (telegram-listener가 수신) → `design-feedback.jsonl`의 해당 행 `humanTap` 갱신.
- 무응답 타임아웃: 자율 승자 채택, `humanTap=null`.

## 5. 에코챔버 방지

자기평가 루프의 최대 리스크는 안목이 한 방향으로 굳는 것(성장이 아니라 정체). 방어 장치:
1. **다양성 강제** — 매 세대 최소 1개 "위험한 실험" + 1개 인접 언어 블렌딩(designer-persona 탐색 전략).
2. **인간 탭 보정** — 막상막하일 때 인간이 ground truth를 주입해 judge의 편향을 교정.
3. **레퍼런스 닻** — 사용자 레퍼런스 라이브러리가 외부 기준점을 유지.
4. **judge의 자기의심** — taste-judge는 학습된 룰과 충돌하는 더 나은 디자인을 보면 `persona_conflict`를 남겨, 다음 증류가 룰 자체를 고치게 한다.
5. **다양성 경고** — 비슷한 승자가 연속되면 judge가 경고하고 탐색 폭을 넓힌다.
