# Tactile Micro-Interactions Design Specification (tactile-motion.design.md)

> **스타일 규약:** Tactile Motion (촉각적 마이크로 인터랙션 및 물리 엔진)  
> **적용 범위:** 스마트펜 굵기/투명도 슬라이더, 도구 전환 캡슐, 바텀시트 제스처, 버튼 햅틱  
> **인코딩 & 언어:** UTF-8 no BOM, 한국어 문서 / 영어 토큰 식별자  

---

## 1. 개요 및 디자인 철학

촉각적 인터랙션은 사용자의 물리적 입력(터치, 드래그, 펜 압력)에 대해 디지털 화면이 현실 세계의 질량과 탄성을 가진 물리적 물체처럼 반응하도록 구현하는 시스템입니다. Emil Kowalski와 현대 스프링 물리(Spring Physics) 엔진의 원리를 적용하여, 단순한 기계적 선형(Linear) 이동이 아닌 자연스러운 오버슈트(Overshoot)와 햅틱 체감을 선사합니다. 모든 모션은 **도허티 임계(<400ms)** 내에서 완결되어 사용자 조작을 방해하지 않습니다.

---

## 2. 물리 매개변수 및 스프링 토큰 (Spring Physics Tokens)

하네스 표준 물리 엔진 파라미터는 다음과 같이 수치화되어 관리됩니다:

```typescript
export const TACTILE_SPRING_PRESETS = {
  /** 버튼 탭, 도구 스위치: 즉각적이고 탄력적인 반동 */
  snappy: {
    stiffness: 400,
    damping: 28,
    mass: 0.8,
    durationMs: 220,
  },
  /** 슬라이더 썸 트래킹, 펜 두께 조절: 부드럽고 안정적인 감쇠 */
  smooth: {
    stiffness: 300,
    damping: 32,
    mass: 1.0,
    durationMs: 280,
  },
  /** 바텀시트, 패널 확장: 묵직하고 신뢰감 있는 전이 */
  gentle: {
    stiffness: 220,
    damping: 26,
    mass: 1.2,
    durationMs: 340,
  },
} as const;
```

### CSS Transition & WAAPI 매핑
```css
:root {
  /* Snappy Tactile Timing (Emil Kowalski curve approximation) */
  --tactile-ease-overshoot: cubic-bezier(0.34, 1.56, 0.64, 1);
  --tactile-ease-out-back: cubic-bezier(0.175, 0.885, 0.32, 1.275);
  --tactile-ease-smooth: cubic-bezier(0.16, 1, 0.3, 1);
  
  --tactile-duration-instant: 120ms;
  --tactile-duration-fast: 200ms;
  --tactile-duration-standard: 280ms;
  --tactile-duration-max: 380ms; /* 도허티 임계 상한선 */
}

/* Reduced Motion 접근성 강제 폴백 */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 3. 햅틱 피드백 및 제스처 상호작용 규약

### 3.1 스마트펜 굵기/투명도 슬라이더
- **슬라이더 썸(Thumb):** 사용자가 터치하여 드래그할 때 $1.15$배로 살짝 팽창(`scale: 1.15`)하며, 놓으면 `stiffness: 400, damping: 28` 물리 공식에 따라 젤리처럼 원래 크기로 복귀합니다.
- **눈금 스냅(Notch Snap):** 특정 표준 굵기(예: $1\text{px}, 3\text{px}, 5\text{px}, 10\text{px}$) 진입 시 모바일 Web Vibration API(`navigator.vibrate?.([8])`)를 트리거하여 기계적 휠을 돌리는 듯한 턱 걸림 햅틱을 제공합니다.

### 3.2 도구 전환 캡슐 버튼
- **Press State:** 터치 시 `transform: scale(0.95)` 즉각 수축 ($80\text{ms}$).
- **Release State:** 도구 활성화 배지가 스프링 탄성으로 새 도구 아이콘 위치로 부드럽게 모핑 이동.

---

## 4. 컴포넌트 규격 및 하네스 하드 룰

### 4.1 도허티 임계 시간 엄격 통제 (Doherty Threshold Rule)
- 모든 시각적 인터랙션의 총 소요 시간은 **$400\text{ms}$를 1ms도 초과할 수 없습니다** (최적 권장: $150\text{ms} \sim 280\text{ms}$).
- 사용자의 다음 조작을 블로킹하는 긴 애니메이션은 하네스 성능 게이트에서 감지되어 실패 처리됩니다.

### 4.2 대칭 테두리 필수 (Anti-Fingernail Rule)
- 애니메이션되는 모든 버튼 및 컨트롤 캡슐은 사방 대칭 테두리(`border: 1px solid ...` 또는 `border: 2px solid ...`)를 유지해야 하며, `border-l-4` 등의 비대칭 굵은 테두리는 엄격히 금지합니다.

### 4.3 버튼 & 배지 완벽 중앙 정렬 (Centering Rule)
- 모션 요소 내 텍스트/아이콘:
  `inline-flex items-center justify-center leading-none`
  규칙 준수로 스케일링 중에도 콘텐츠 중심축 왜곡이 없어야 합니다.

### 4.4 터치 타깃 규격 (Touch Target Rule)
- 슬라이더 썸 및 도구 스위치 버튼의 최소 터치 히트박스는 **$44\text{px} \times 44\text{px}$** 이상이어야 합니다 (`min-w-[44px] min-h-[44px]`).

---

## 5. 안티패턴 금지 목록 (Strict Banned Patterns)

1. **400ms 초과 지연 모션:** 사용자의 빠른 필기 및 도구 선택 흐름을 방해하는 루즈한 전환 금지.
2. **기계적 Linear 애니메이션:** 물리 질감이 없는 `transition: all 0.3s linear` 식의 무미건조한 모션 지양.
3. **`prefers-reduced-motion` 누락:** 전정기관 장애가 있는 사용자를 위한 무감속 폴백 누락 금지.
4. **비대칭 테두리 모핑:** 손톱 모서리 왜곡 테두리가 포함된 컨테이너 사용 금지.
5. **터치 타깃 미달:** $44\text{px}$ 미만으로 축소되어 오터치를 유발하는 슬라이더 핸들 금지.
