# Liquid Glass Design Specification (liquid-glass.design.md)

> **스타일 규약:** Liquid Glass (고대비 리퀴드 글래스모피즘)  
> **적용 범위:** 스마트펜 캔버스 플로팅 툴바, 레이어 제어 캡슐, 플로팅 HUD, 인라인 컨트롤  
> **인코딩 & 언어:** UTF-8 no BOM, 한국어 문서 / 영어 토큰 식별자  

---

## 1. 개요 및 디자인 철학

리퀴드 글래스는 캔버스 콘텐츠(판서, 수학 수식, 도면)의 가시성을 극대화하면서도, 컨트롤 인터페이스가 캔버스 위에 자연스럽게 부유(Floating)하도록 설계된 투명 계층 시스템입니다. 본 시스템은 기존 'AI-Slop' 글래스모피즘의 고질적 결함(가독성 붕괴, 저대비 흰색 텍스트, 성능 저하)을 원천 해결하며, **WCAG 2.1 AA 명도 대비(4.5:1)** 및 물리적 빛 반사 굴절율을 완벽히 충족합니다.

---

## 2. 캔버스 플로팅 규약 및 레이아웃

### 2.1 배치 원칙
- **플로팅 위치:** 캔버스 상단 중앙(Top Center) 또는 우측/좌측 측면(Docked Floating).
- **여백:** 캔버스 가장자리로부터 최소 $16\text{px}$ 이격 (`inset-x-0 mx-auto`, `fixed top-4`).
- **레이어 분리:** 캔버스의 제스처/펜 입력과 툴바의 클릭 인터랙션이 충돌하지 않도록 명확한 Z-Index 체계(`z-50`)와 이벤트 버블링 차단을 적용합니다.
- **도허티 임계(<400ms):** 툴바의 접힘/펼침 트랜지션은 $200\text{ms}$ 이하로 완결되어야 합니다.

### 2.2 고대비 가독성 보장 (WCAG 2.1 AA 4.5:1)
캔버스 배경색(칠판 녹색 `#132a13`, 흑판 `#1a1a1a`, 화이트보드 `#ffffff`, 모눈 방안지)이 동적으로 변경되더라도, 글래스 내부의 아이콘과 레이블은 항상 최소 **4.5:1** 이상의 명도 대비를 유지해야 합니다.

- **어두운 캔버스 배경 (Dark Surface):** 반투명 글래스 배경 + 고휘도 텍스트(Luminance ≥ 0.90) 적용으로 대비율 7:1 이상 확보.
- **밝은 캔버스 배경 (Light Surface):** 반투명 틴트 글래스 + 딥 코발트/차콜 텍스트(Luminance ≤ 0.20) 적용으로 대비율 6:1 이상 확보.

---

## 3. 디자인 토큰 (OKLCH Color Palette & Glass Physics)

```css
:root {
  /* Liquid Glass Core Tokens (Light/White Canvas) */
  --glass-bg: oklch(0.98 0.005 247.8 / 0.72);
  --glass-bg-subtle: oklch(0.95 0.005 247.8 / 0.50);
  --glass-blur: blur(16px);
  --glass-saturate: saturate(180%);
  
  /* Precision Symmetric Refraction Borders */
  --glass-border: 1px solid oklch(1.0 0 0 / 0.65);
  --glass-border-inner: inset 0 1px 1px 0 oklch(1.0 0 0 / 0.40);
  --glass-shadow: 0 8px 32px 0 oklch(0 0 0 / 0.08), 0 2px 8px 0 oklch(0 0 0 / 0.04);
  
  /* Text & Icons (Contrast Ratio ≥ 4.5:1 Guaranteed) */
  --glass-text-primary: oklch(0.12 0.005 247.8);
  --glass-text-secondary: oklch(0.35 0.01 247.8);
  --glass-icon-active: oklch(0.55 0.20 250);
}

@media (prefers-color-scheme: dark) {
  :root {
    /* Liquid Glass Core Tokens (Dark/Chalkboard Canvas) */
    --glass-bg: oklch(0.18 0.008 247.8 / 0.75);
    --glass-bg-subtle: oklch(0.12 0.005 247.8 / 0.55);
    --glass-blur: blur(20px);
    --glass-saturate: saturate(190%);
    
    /* Precision Symmetric Refraction Borders */
    --glass-border: 1px solid oklch(1.0 0 0 / 0.18);
    --glass-border-inner: inset 0 1px 1px 0 oklch(1.0 0 0 / 0.15);
    --glass-shadow: 0 8px 32px 0 oklch(0 0 0 / 0.35), 0 2px 8px 0 oklch(0 0 0 / 0.20);
    
    /* Text & Icons (Contrast Ratio ≥ 4.5:1 Guaranteed) */
    --glass-text-primary: oklch(0.98 0.002 247.8);
    --glass-text-secondary: oklch(0.78 0.008 247.8);
    --glass-icon-active: oklch(0.68 0.20 250);
  }
}
```

---

## 4. 컴포넌트 규격 및 하네스 하드 룰

### 4.1 대칭 테두리 필수 (Anti-Fingernail Rule)
- 글래스 컴포넌트는 빛의 반사광을 시뮬레이션하기 위해 **사방 균일 대칭 테두리**(`border: 1px solid ...`)를 의무화합니다.
- `border-l-4`, `border-t-2` 등 비대칭 두께 테두리는 물리적 굴절 모델을 왜곡하므로 엄격히 금지합니다.

### 4.2 버튼 & 배지 완벽 중앙 정렬 (Centering Rule)
- 글래스 툴바 내 펜 도구, 지우개, 색상 팔레트, 굵기 선택 버튼은 반드시:
  `inline-flex items-center justify-center leading-none`
- 아이콘 크기는 $20\text{px}$ 또는 $24\text{px}$이며, 중앙 오프셋 없이 완벽 정렬되어야 합니다.

### 4.3 터치 타깃 규격 (Touch Target Rule)
- 스마트펜 및 손가락 터치 조작 시 오터치를 방지하기 위해 각 툴 버튼의 최소 히트박스는 **$44\text{px} \times 44\text{px}$** 이상이어야 합니다 (`min-w-[44px] min-h-[44px]`).

---

## 5. 안티패턴 금지 목록 (Strict Banned Patterns)

1. **전체 페이지 배경 글래스모피즘 남용:** `body` 또는 메인 레이아웃 전체에 `backdrop-blur`를 씌우는 행위 원천 금지 (플로팅 툴바 및 모달에만 한정).
2. **저대비 흰색 텍스트 slop:** 반투명 연회색 배경 위에 흰색 텍스트(`text-white/80`)를 올려 대비율이 2:1 이하로 떨어지는 현상 금지.
3. **비대칭 테두리:** 글래스 카드에 `border-l-4` 결합 금지.
4. **터치 타깃 미달:** $32\text{px}$ 이하 소형 펜 툴바 버튼 금지 ($44\text{px}$ 미만 엄격 차단).
5. **과도한 블러 연산:** `blur(60px)` 이상의 무거운 필터로 모바일 저사양 칩셋에서 60fps 렌더링 프레임드랍을 유발하는 행위 금지.
