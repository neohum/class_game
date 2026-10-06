# Neubrutalism Design Specification (neobrutalism.design.md)

> **스타일 규약:** Neubrutalism (구조적 고대비 네오 브루탈리즘)  
> **적용 범위:** edulinker 학생 성취 배지, 칭찬 도장, 스탬프 카드, 퀘스트 완료 보상 (한정 적용)  
> **인코딩 & 언어:** UTF-8 no BOM, 한국어 문서 / 영어 토큰 식별자  

---

## 1. 개요 및 디자인 철학

네오 브루탈리즘은 정형화된 플랫/미니멀 디자인에서 탈피하여 굵고 명확한 외곽선, 하드 드롭 섀도우, 선명한 비비드 컬러를 통해 높은 주목도와 위트 있는 질감을 제공하는 스타일입니다. edulinker에서는 본 스타일을 일반 텍스트나 전체 대시보드에 남용하지 않고, **학생용 게이미피케이션(배지, 스탬프 북, 레벨업 카드)**에 전략적으로 한정 적용하여 학습 동기 부여 효과를 극대화합니다.

---

## 2. 하네스 하드 룰 & 절대 불변식 (Non-Negotiable Invariants)

### 2.1 대칭 테두리 강제 (Anti-Fingernail / Cuticle Rule)
- 네오 브루탈리즘의 상징인 굵은 외곽선은 **반드시 사방 전체에 균일한 대칭 테두리(`border: 2px solid ...` 또는 `border: 2.5px solid ...`)**로만 적용되어야 합니다.
- **비대칭 굵은 테두리(`border-l-4`, `border-l-8`, `border-t-4` 등)는 어떠한 경우에도 절대 허용되지 않습니다.**
- 모서리 둥글림(`rounded-md`, `rounded-lg`)과 비대칭 굵은 테두리가 결합될 때 발생하는 **손톱(Cuticle) 왜곡 현상**은 하네스 안티-슬롭 린터에 의해 즉시 빌드 실패 처리됩니다.

### 2.2 버튼 & 배지 완벽 중앙 정렬 (Centering Rule)
- 모든 네오 브루탈 버튼, 배지, 스탬프 텍스트 및 아이콘은:
  `inline-flex items-center justify-center leading-none`
  규칙을 의무 적용합니다.
- 하드 섀도우 오프셋으로 인해 텍스트 시각적 중심축이 흔들리지 않도록 `padding`과 `box-sizing: border-box`를 엄격히 제어합니다.

### 2.3 터치 타깃 규격 (Touch Target Rule)
- 초등/중등 학생들의 터치 편의성을 위해 모든 상호작용 배지/버튼은 최소 **$44\text{px} \times 44\text{px}$** 이상의 히트박스를 유지합니다.

---

## 3. 디자인 토큰 (OKLCH Vivid Palette & Hard Shadows)

```css
:root {
  /* Neubrutal High-Contrast Palette */
  --neo-bg: oklch(0.97 0.02 95); /* Cream / Canvas */
  --neo-surface: oklch(1.0 0 0);
  
  /* Strict Symmetric Border Token */
  --neo-border-width: 2.5px;
  --neo-border-color: oklch(0.12 0.005 247.8);
  --neo-border: var(--neo-border-width) solid var(--neo-border-color);
  
  /* Hard Drop Shadows (No Blur Radius) */
  --neo-shadow-sm: 2.5px 2.5px 0px var(--neo-border-color);
  --neo-shadow-md: 4px 4px 0px var(--neo-border-color);
  --neo-shadow-lg: 6px 6px 0px var(--neo-border-color);
  --neo-shadow-active: 1px 1px 0px var(--neo-border-color);
  
  /* Gamification Vivid Accents */
  --neo-accent-yellow: oklch(0.85 0.18 90);   /* 성취 골드 배지 */
  --neo-accent-cyan: oklch(0.80 0.15 210);    /* 탐구 사이언 */
  --neo-accent-pink: oklch(0.75 0.22 350);    /* 참 잘했어요 핑크 */
  --neo-accent-green: oklch(0.82 0.20 145);   /* 정답 성공 그린 */
  --neo-accent-orange: oklch(0.78 0.19 55);   /* 연속 학습 스트릭 */
  
  --neo-radius: 8px; /* 균일 대칭 모서리 */
}

@media (prefers-color-scheme: dark) {
  :root {
    --neo-bg: oklch(0.15 0.01 247.8);
    --neo-surface: oklch(0.20 0.01 247.8);
    
    --neo-border-color: oklch(0.92 0.005 247.8);
    --neo-border: var(--neo-border-width) solid var(--neo-border-color);
    
    --neo-shadow-sm: 2.5px 2.5px 0px var(--neo-border-color);
    --neo-shadow-md: 4px 4px 0px var(--neo-border-color);
    --neo-shadow-lg: 6px 6px 0px var(--neo-border-color);
    --neo-shadow-active: 1px 1px 0px var(--neo-border-color);
  }
}
```

---

## 4. 인터랙션 물리 규약 (Tactile Press Feedback)

- **Hover:** 위치 $-2\text{px}, -2\text{px}$ 이동 및 그림자 $+2\text{px}$ 확장.
- **Active (Click / Tap):** 위치 $+3\text{px}, +3\text{px}$ 이동 및 그림자 축소 (`box-shadow: 1px 1px 0px ...`), 누름감 즉시 체감.
- **Transition:** `transition: transform 120ms cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 120ms cubic-bezier(0.2, 0.8, 0.2, 1)`.

---

## 5. 안티패턴 금지 목록 (Strict Banned Patterns)

1. **비대칭 굵은 테두리 (`border-l-4` 등):** 손톱 모서리 왜곡 유발 스타일은 절대 금지. 오직 `border: 2px` 또는 `border: 2.5px` 전면 대칭만 허용.
2. **소프트 블러 섀도우 혼용:** `box-shadow: 0 10px 15px rgba(0,0,0,0.1)`와 같이 흐릿한 그림자를 네오 브루탈 컴포넌트에 섞어 쓰는 행위 금지.
3. **일반 본문 텍스트 적용:** 긴 수업 본문, 시스템 설정창, 공지사항에 고채도 네오 브루탈리즘을 전면 적용하여 피로도를 높이는 행위 금지.
4. **터치 타깃 미달:** $44\text{px}$ 미만의 소형 스탬프 아이콘 배치 금지.
5. **텍스트 수직 오프셋 방치:** 버튼 내 `leading-none` 누락으로 인한 상하 불균형 여백 방치 금지.
