---
name: geometry-system
description: "'수학적으로 아름다운' 디자인의 골격을 수치로 설계하는 스킬. 모듈러 스케일(황금비·완전4도 등), 타이포그래피 스케일, 8pt/4pt 간격 시스템, 컬럼 그리드, 수직 리듬, border-radius·종횡비 등 비율 기반 토큰을 산출. 디자인의 그리드·비율·간격·타이포 스케일을 설계하거나, '수학적/기하학적으로 정합된' 디자인 시스템의 뼈대가 필요할 때 반드시 사용. scripts/modular-scale.mjs로 결정적 스케일 생성."
---

# Geometry System — 비율로 짜는 디자인 골격

좋은 디자인은 보이지 않는 수학적 질서 위에 앉는다. 폰트·간격·반경이 무관한 숫자로 흩어지면 무질서하고, **하나의 비율에서 유도**되면 시각적 화음이 생긴다.

## 설계 순서

1. **기준 단위 결정** — 보통 base 폰트 16px, 간격 base unit 4px 또는 8px. 8pt 그리드는 SaaS/미니멀에, 4pt는 더 촘촘한 제어가 필요할 때.
2. **비율 선택** — 디자인 언어에 맞춰 모듈러 스케일 ratio를 고른다 (아래 표). 큰 비율일수록 대비가 극적, 작은 비율일수록 차분.
3. **타이포 스케일 생성** — `scripts/modular-scale.mjs`로 단계별 폰트 크기를 결정적으로 산출한다. 손계산 금지(반올림 드리프트 원인).
4. **간격 스케일 생성** — base unit의 배수(linear) 또는 등비(geometric)/피보나치로. `--spacing` 플래그 사용.
5. **그리드·수직 리듬** — 컬럼·거터·컨테이너 폭, 라인하이트를 기준 그리드의 배수로 정렬.
6. **반경·비율 정합** — border-radius 스케일과 컴포넌트 종횡비를 같은 비율 계열로.

## 스크립트 사용

```bash
# 타이포 스케일 (황금비, base 16, 위로 5단계 아래로 2단계)
node scripts/modular-scale.mjs --ratio golden --base 16 --up 5 --down 2

# 명명 비율도 가능: minor-third major-third perfect-fourth aug-fourth perfect-fifth golden
node scripts/modular-scale.mjs --ratio perfect-fourth --base 16 --up 6

# 간격 스케일 (4px unit, 등비)
node scripts/modular-scale.mjs --spacing --unit 4 --steps 10 --mode geometric
# mode: multiples(기본,선형배수) | geometric(2배수) | fibonacci
```

출력은 JSON. px와 rem(÷16)을 함께 준다. 이 값을 token-synthesizer에 넘긴다.

## 비율 선택 가이드

| 디자인 언어 | 권장 ratio | 간격 mode | 이유 |
|---|---|---|---|
| 미니멀/스위스 | 1.25 (major-third) | multiples(8pt) | 차분하고 규칙적, 그리드 가독성 |
| 모던 SaaS | 1.2~1.25 | multiples(4pt) | 정보 밀도와 위계 균형 |
| 브루탈리즘 | 1.5~1.618 | geometric | 극적 대비, 큰 점프 |
| 수학·기하 | 1.618(golden) / 1.414(√2) | fibonacci/geometric | 비율 자체가 콘셉트 |

## 수직 리듬 규칙

- 본문 라인하이트는 기준 그리드(예: 8px 또는 base의 1.5배)의 배수로 맞춘다. 텍스트 블록이 보이지 않는 그리드 위에 앉아야 페이지가 정돈된다.
- 헤딩의 위/아래 마진도 간격 토큰에서 가져와 리듬을 유지한다.

## 반올림 규칙

모듈러 스케일은 소수를 낳는다. **rem은 소수 유지**(브라우저가 처리), **px 표기는 컴포넌트 가이드에서 0.5px 경계를 피하도록 반올림**한다. 어느 쪽을 진실로 삼을지 가이드에 명시한다 (권장: rem이 진실, px는 참고).

## 출력

`_workspace/02_geometry.md`에 표 형태로: 기준 단위, 선택 비율(+근거), 타이포 스케일 표(token/px/rem), 간격 토큰 표, 그리드 정의(컬럼·거터·브레이크포인트·컨테이너), 반경 스케일, 핵심 종횡비.

> 모듈러 스케일·그리드의 상세 이론과 추가 패턴은 `references/modular-scale.md`, `references/grid-systems.md` 참조.
