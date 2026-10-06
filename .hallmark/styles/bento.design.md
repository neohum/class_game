# Bento Grid Design Specification (bento.design.md)

> **스타일 규약:** Bento Grid (수학적 모듈러 카드 그리드)  
> **적용 범위:** 대시보드, 통계 모듈, 과제/수업 상태 카드, 멀티 디바이스 반응형 레이아웃  
> **인코딩 & 언어:** UTF-8 no BOM, 한국어 문서 / 영어 토큰 식별자  

---

## 1. 개요 및 디자인 철학

벤토 그리드는 일본 도시락(Bento)의 구획 나눔 미학에서 유래한 모듈러 레이아웃 시스템입니다. 복잡하고 다양한 형태의 정보(텍스트, 그래프, 이미지, 액션 버튼)를 시각적 위계와 수학적 비례에 맞추어 유기적으로 배치합니다. 하네스 코어에서는 무거운 외부 번들 라이브러리를 일체 배제하고, 순수 CSS Grid와 Tailwind 유틸리티 및 기하학적 반응형 공식(Theorem 1, Theorem 2)에 따라 완벽히 제어합니다.

---

## 2. 수학적 그리드 비율 및 반응형 규칙

### 2.1 디바이스별 열(Column) 구성
- **데스크톱 (≥ 1024px, lg/xl):** 4열 (또는 정밀 분할 시 12열) 그리드
- **태블릿 (768px ~ 1023px, md):** 2열 대칭 그리드
- **모바일 (375px ~ 767px, base):** **1열 자동 폴백 (Single-Column Full Width)**

```css
/* CSS Grid 표준 컨테이너 */
.bento-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}

@media (min-width: 768px) {
  .bento-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 20px;
  }
}

@media (min-width: 1024px) {
  .bento-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 24px;
  }
}
```

### 2.2 기하학적 불변식 (Responsive Math Theorems)
- **Theorem 1 (경계 포함 - Bounding Containment):**  
  모든 카드는 부모 컨테이너의 가용 폭 $W_{\text{inner}} = W_{\text{container}} - 2 \times P$ 내에 완전히 수용되어야 하며, 자식 요소의 오른쪽 경계가 컨테이너를 $1\text{px}$도 벗어나지 않아야 합니다 (`containmentRatio = 1.0`).
- **Theorem 2 (버튼 줄바꿈 - Row Overflow Prevention):**  
  카드 하단 액션 버튼 그룹은 반드시 `flex-wrap` 및 적정 간격(`gap-2`, $8\text{px}$)을 가져야 하며, 모바일($375\text{px}$)에서 버튼 폭 합계가 카드 폭을 초과할 때 안전하게 다음 행으로 줄바꿈되어 오버플로우가 발생하지 않아야 합니다.

---

## 3. 디자인 토큰 (OKLCH Color Palette & Spacing)

하네스 표준 OKLCH 색공간을 사용하여 광도(Luminance) 일관성과 고해상도 디스플레이 대응을 보장합니다.

```css
:root {
  /* Bento Light Palette */
  --bento-bg: oklch(0.985 0.002 247.8);
  --bento-surface: oklch(1.0 0 0);
  --bento-surface-subtle: oklch(0.965 0.005 247.8);
  --bento-border: oklch(0.88 0.005 247.8);
  --bento-border-hover: oklch(0.75 0.015 247.8);
  
  --bento-text-primary: oklch(0.15 0.005 247.8);
  --bento-text-secondary: oklch(0.45 0.01 247.8);
  --bento-text-muted: oklch(0.60 0.01 247.8);
  
  --bento-accent-cobalt: oklch(0.55 0.20 250);
  --bento-accent-surface: oklch(0.95 0.04 250);
  
  /* Bounding & Shadow */
  --bento-radius: 16px;
  --bento-shadow-sm: 0 1px 3px oklch(0 0 0 / 0.05);
  --bento-shadow-md: 0 4px 12px oklch(0 0 0 / 0.06);
}

@media (prefers-color-scheme: dark) {
  :root {
    /* Bento Dark Palette */
    --bento-bg: oklch(0.12 0.005 247.8);
    --bento-surface: oklch(0.16 0.006 247.8);
    --bento-surface-subtle: oklch(0.20 0.008 247.8);
    --bento-border: oklch(0.26 0.008 247.8);
    --bento-border-hover: oklch(0.38 0.012 247.8);
    
    --bento-text-primary: oklch(0.98 0.002 247.8);
    --bento-text-secondary: oklch(0.72 0.008 247.8);
    --bento-text-muted: oklch(0.52 0.008 247.8);
    
    --bento-accent-cobalt: oklch(0.65 0.20 250);
    --bento-accent-surface: oklch(0.25 0.05 250);
    
    --bento-shadow-sm: 0 1px 3px oklch(0 0 0 / 0.25);
    --bento-shadow-md: 0 4px 12px oklch(0 0 0 / 0.35);
  }
}
```

---

## 4. 컴포넌트 규격 및 하네스 하드 룰

### 4.1 대칭 테두리 필수 (Anti-Fingernail Rule)
- 카드의 사방 모서리는 완전히 균일한 전면 대칭 테두리(`border: 1px solid var(--bento-border)`)만을 허용합니다.
- 좌측 테두리만 강조하는 `border-l-4`, `border-l-2` 등 손톱(Cuticle) 왜곡 형태는 **엄격히 금지**합니다. 상태 강조가 필요할 경우 내부 인디케이터 배지 또는 배경색 틴트를 사용합니다.

### 4.2 버튼 & 배지 완벽 중앙 정렬 (Centering Rule)
- 카드 내부의 모든 버튼, 칩, 배지는 반드시 `inline-flex items-center justify-center leading-none` 유틸리티를 적용합니다.
- 아이콘 요소 또한 `i.flex.items-center.justify-center.leading-none`을 유지해 수직 편차를 0으로 통제합니다.

### 4.3 터치 타깃 규격 (Touch Target Rule)
- 모바일 뷰포트에서 상호작용 가능한 모든 요소(버튼, 링크, 체크박스 등)는 최소 $44\text{px} \times 44\text{px}$의 클릭/터치 영역을 보장합니다.

---

## 5. 안티패턴 금지 목록 (Strict Banned Patterns)

1. **비대칭 굵은 테두리:** `border-l-4`, `border-l-2`, `border-t-4` 등 한쪽 면만 굵은 테두리 금지.
2. **모바일 가로 스크롤 유발 고정 폭:** `w-[500px]`, `w-[600px]` 등의 고정 픽셀 클래스 금지 (반드시 `w-full max-w-[...]` 사용).
3. **버튼 줄바꿈 미적용 액션 행:** `flex flex-nowrap`으로 좁은 카드에서 버튼이 밖으로 삐져나가는 배치 금지 (`flex-wrap` 필수).
4. **저대비 텍스트:** 배경 대비 명도비 4.5:1 미만의 회색조 텍스트 금지.
5. **무거운 서드파티 그리드 라이브러리:** Framer나 복잡한 외부 번들 의존 금지 (순수 CSS Grid 및 Tailwind 준수).
