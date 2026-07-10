# Token Schema 표준

design-tokens 스킬의 출력 포맷 표준. token-synthesizer는 이 구조를 정확히 따른다. critic은 이 표준으로 검증한다.

## 목차
1. [tokens.json (W3C)](#1-tokensjson-w3c-design-tokens)
2. [tokens.css](#2-tokenscss)
3. [DESIGN_GUIDE.md](#3-design_guidemd)
4. [검증 체크리스트](#4-검증-체크리스트)

---

## 1. tokens.json (W3C Design Tokens)

W3C Design Tokens Community Group 포맷. `$value`/`$type`/`$description`, 별칭은 `{경로}` 문자열.

```json
{
  "color": {
    "neutral": {
      "0":   { "$value": "#ffffff", "$type": "color" },
      "50":  { "$value": "#f7f7f8", "$type": "color" },
      "900": { "$value": "#18181b", "$type": "color" },
      "950": { "$value": "#0a0a0b", "$type": "color" }
    },
    "brand": {
      "500": { "$value": "#4f46e5", "$type": "color", "$description": "primary brand, L≈0.52" }
    },
    "text": {
      "primary":   { "$value": "{color.neutral.900}", "$type": "color" },
      "secondary": { "$value": "{color.neutral.600}", "$type": "color" },
      "muted":     { "$value": "{color.neutral.500}", "$type": "color" }
    },
    "surface": {
      "base":   { "$value": "{color.neutral.0}",  "$type": "color" },
      "raised": { "$value": "{color.neutral.50}", "$type": "color" }
    },
    "accent": {
      "default": { "$value": "{color.brand.500}", "$type": "color" }
    }
  },
  "space": {
    "0": { "$value": "0",      "$type": "dimension" },
    "1": { "$value": "0.25rem","$type": "dimension" },
    "4": { "$value": "1rem",   "$type": "dimension" }
  },
  "font": {
    "family": {
      "body":    { "$value": "Inter, system-ui, sans-serif", "$type": "fontFamily" },
      "display": { "$value": "Inter, system-ui, sans-serif", "$type": "fontFamily" },
      "mono":    { "$value": "ui-monospace, monospace", "$type": "fontFamily" }
    },
    "size": {
      "base": { "$value": "1rem",    "$type": "dimension", "$description": "ratio 1.25 base" },
      "lg":   { "$value": "1.25rem", "$type": "dimension" },
      "xl":   { "$value": "1.563rem","$type": "dimension" }
    },
    "weight":     { "regular": { "$value": "400", "$type": "fontWeight" }, "bold": { "$value": "700", "$type": "fontWeight" } },
    "lineHeight": { "body": { "$value": "1.5", "$type": "number" }, "tight": { "$value": "1.2", "$type": "number" } }
  },
  "radius": {
    "none": { "$value": "0",       "$type": "dimension" },
    "md":   { "$value": "0.5rem",  "$type": "dimension" },
    "full": { "$value": "9999px",  "$type": "dimension" }
  },
  "shadow": {
    "raised": { "$value": "0 1px 2px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.08)", "$type": "shadow" }
  },
  "grid": {
    "columns":   { "$value": "12",     "$type": "number" },
    "gutter":    { "$value": "{space.4}", "$type": "dimension" },
    "container": { "$value": "1280px", "$type": "dimension" }
  },
  "duration": { "fast": { "$value": "150ms", "$type": "duration" } }
}
```

다크모드는 별도 키(`$themes` 또는 `color.text.primary.$extensions.dark`)로 두거나, CSS에서만 재매핑한다. 단순함을 위해 **CSS에서 의미 토큰 재매핑**을 기본으로 한다(아래).

---

## 2. tokens.css

원시는 변수로, 의미는 원시를 참조. 다크는 의미만 재정의.

```css
:root {
  /* primitives */
  --neutral-0: #ffffff;
  --neutral-50: #f7f7f8;
  --neutral-500: #71717a;
  --neutral-600: #52525b;
  --neutral-900: #18181b;
  --neutral-950: #0a0a0b;
  --brand-500: #4f46e5;

  /* spacing (4pt base) */
  --space-0: 0;
  --space-1: 0.25rem;
  --space-4: 1rem;

  /* type */
  --font-body: Inter, system-ui, sans-serif;
  --font-size-base: 1rem;
  --font-size-lg: 1.25rem;
  --line-height-body: 1.5;

  /* radius / shadow / motion */
  --radius-md: 0.5rem;
  --shadow-raised: 0 1px 2px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.08);
  --duration-fast: 150ms;

  /* semantic (light) — reference primitives */
  --color-surface-base: var(--neutral-0);
  --color-surface-raised: var(--neutral-50);
  --color-text-primary: var(--neutral-900);
  --color-text-secondary: var(--neutral-600);
  --color-text-muted: var(--neutral-500);
  --color-accent-default: var(--brand-500);
}

:root[data-theme="dark"] {
  /* semantic (dark) — same set, remapped */
  --color-surface-base: var(--neutral-950);
  --color-surface-raised: #16161a;
  --color-text-primary: var(--neutral-50);
  --color-text-secondary: #a1a1aa;
  --color-text-muted: #8a8a93;
  --color-accent-default: #6366f1; /* 채도 약간 낮춘 다크용 */
}
```

---

## 3. DESIGN_GUIDE.md

토큰 나열이 아니라 **사용 규칙**. 권장 섹션:

```markdown
# [제품명] 디자인 시스템

## 디자인 언어
선택한 언어(예: 모던 SaaS) + 한 줄 정체성 + 근거.

## 색
| 토큰 | 값 | L | 용도 | do / don't |
스와치 표. 의미 토큰 위주로(원시는 부록).
다크모드 매핑 한 줄 설명.

## 타이포그래피
스케일 표(token / rem / px / 용도). 폰트 페어링 + 폴백. 위계 규칙.

## 간격 & 그리드
간격 스케일 용법(컴포넌트 내부 vs 섹션 사이). 그리드 정의.

## 컴포넌트 예시
버튼·카드·인풋에 어떤 토큰을 쓰는지 do/don't 예시.

## 모션
duration·easing 사용 규칙.
```

---

## 4. 검증 체크리스트 (critic 사용)

- [ ] 모든 `{별칭}` 참조가 실재 토큰을 가리킨다 (끊긴 참조 0)
- [ ] tokens.json ↔ tokens.css 값 일치
- [ ] 다크 의미 토큰이 라이트와 같은 집합 커버 (누락 0)
- [ ] 모든 text/surface 조합 WCAG AA 충족 (contrast.mjs)
- [ ] 타이포 스케일이 선언 비율을 따름, 간격이 base unit 배수
- [ ] 가이드의 설명이 실제 토큰 값과 일치
- [ ] 프레임워크 특정 가정 없음 (Tailwind/MUI 클래스명 등 미포함)
