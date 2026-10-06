# Generative UI Design Specification (generative-ui.design.md)

> **스타일 규약:** Generative UI (적응형 생성형 인터페이스 런타임)  
> **적용 범위:** AI 형성평가 피드백, 수식/풀이과정 인터랙티브 시각화, AI 도우미 위젯  
> **인코딩 & 언어:** UTF-8 no BOM, 한국어 문서 / 영어 토큰 식별자  

---

## 1. 개요 및 디자인 철학

제너레이티브 UI는 LLM(대형 언어 모델)의 응답을 단순 텍스트나 마크다운으로 출력하는 대신, 사전 정의된 고품질 React 위젯을 실시간으로 조합하여 동적 인터랙티브 인터페이스를 생성하는 시스템입니다. Vercel AI SDK 표준 패턴을 기반으로 하며, 임의 스크립트 주입(XSS)을 완벽 차단하는 **위젯 화이트리스트 레지스트리**와 스트리밍 중 레이아웃 흔들림(Cumulative Layout Shift, CLS)을 방지하는 **적응형 스켈레톤 전이**를 핵심으로 합니다.

---

## 2. Vercel AI SDK 호환 JSON 스트리밍 스키마

AI 모델은 SSE(Server-Sent Events) 또는 Web Streams API를 통해 다음과 같은 구조화된 JSON 프로토콜을 스트리밍합니다:

```typescript
export type WidgetStatus = "loading" | "streaming" | "ready" | "error";

export interface GenerativeWidgetPayload<T = Record<string, unknown>> {
  /** 등록된 위젯 고유 식별자 */
  widget: string;
  /** 현재 스트리밍 수명주기 상태 */
  status: WidgetStatus;
  /** 부분적 또는 완전한 컴포넌트 데이터 페이로드 */
  data: T;
  /** 에러 발생 시 사용자 친화적 메시지 */
  error?: string;
  /** 위젯 고유 세션 ID (멱등성 보장) */
  id?: string;
}
```

### 상태 전이 머신 (Lifecycle State Machine)
1. **`loading`:** 위젯 렌더러가 식별되면 목표 컴포넌트의 높이/너비를 선점한 반응형 스켈레톤 마운트.
2. **`streaming`:** 부분 JSON 청크가 유입될 때마다 점진적으로 UI 요소 활성화 (텍스트, 단계별 힌트, 차트 데이터 포인트 점진 주입).
3. **`ready`:** 스트림 종료. 인터랙티브 기능(슬라이더, 탭, 입력 폼) 활성화.
4. **`error`:** 네트워크 장애 또는 스키마 불일치 시 안전한 폴백 UI 제공.

---

## 3. 위젯 레지스트리 보안 규약 (Safety & Whitelist)

### 3.1 원천 차단 (Zero Untrusted Execution)
- 화이트리스트에 사전 등록되지 않은 임의 위젯 이름은 렌더링을 즉시 거부하며, 텍스트 형태의 안내 메시지로 폴백합니다.
- `dangerouslySetInnerHTML` 또는 `eval()` 기반 동적 코드 주입은 전면 금지됩니다.
- 모든 위젯 파라미터는 렌더링 전 XSS 새니타이징(HTML 태그 및 `javascript:` URI 제거)을 거칩니다.

### 3.2 edulinker 기본 등록 위젯
1. **`FormulaGraphWidget`:** 학생이 작성한 2차 방정식, 함수 그래프를 실시간 렌더링하고 계수를 조절할 수 있는 인터랙티브 그래프.
2. **`HintCardWidget`:** 단계별 풀이 힌트를 아코디언 형태로 펼쳐보는 점진적 힌트 카드.
3. **`AchievementBadgeWidget`:** 학생의 개념 완성도에 따라 즉시 발급되는 게이미피케이션 스탬프/배지.

---

## 4. 디자인 토큰 및 시각적 규격

```css
:root {
  /* Generative UI Container Tokens */
  --gen-surface: oklch(0.99 0.002 247.8);
  --gen-border: oklch(0.88 0.005 247.8);
  --gen-ring-active: oklch(0.55 0.20 250);
  
  /* Skeleton Pulsing Animation */
  --gen-skeleton-base: oklch(0.92 0.005 247.8);
  --gen-skeleton-shine: oklch(0.97 0.003 247.8);
  
  /* Status Colors */
  --gen-status-ready: oklch(0.65 0.18 150);
  --gen-status-streaming: oklch(0.55 0.20 250);
  --gen-status-error: oklch(0.60 0.22 25);
  
  --gen-radius: 12px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --gen-surface: oklch(0.16 0.006 247.8);
    --gen-border: oklch(0.28 0.008 247.8);
    --gen-ring-active: oklch(0.65 0.20 250);
    
    --gen-skeleton-base: oklch(0.22 0.008 247.8);
    --gen-skeleton-shine: oklch(0.28 0.012 247.8);
    
    --gen-status-ready: oklch(0.72 0.18 150);
    --gen-status-streaming: oklch(0.65 0.20 250);
    --gen-status-error: oklch(0.65 0.22 25);
  }
}
```

---

## 5. 컴포넌트 규격 및 하네스 하드 룰

### 5.1 대칭 테두리 필수 (Anti-Fingernail Rule)
- 동적 생성되는 모든 위젯 컨테이너는 균일한 전면 대칭 테두리(`border: 1px solid var(--gen-border)`)를 의무화합니다.
- `border-l-4` 등의 비대칭 굵은 테두리는 엄격히 금지합니다.

### 5.2 버튼 & 배지 완벽 중앙 정렬 (Centering Rule)
- 위젯 내 액션 버튼(예: "다음 힌트 보기", "그래프 확대")은:
  `inline-flex items-center justify-center leading-none`
  규칙을 필수 준수합니다.

### 5.3 터치 타깃 규격 (Touch Target Rule)
- 학생/교사용 디바이스 터치 조작을 위해 모든 위젯 내 버튼, 슬라이더 썸은 최소 $44\text{px} \times 44\text{px}$ 영역을 확보합니다.

---

## 6. 안티패턴 금지 목록 (Strict Banned Patterns)

1. **미등록 위젯 임의 마운트:** 보안 검증 없이 AI가 임의로 지정한 태그나 컴포넌트를 렌더링하는 행위 금지.
2. **`dangerouslySetInnerHTML` 사용:** AI 응답 HTML을 날것으로 삽입하여 XSS 위험을 초래하는 행위 금지.
3. **레이아웃 시프트(CLS) 유발:** 스켈레톤 높이 예약 없이 컴포넌트가 갑자기 팽창해 페이지 스크롤을 튀게 만드는 행위 금지.
4. **비대칭 테두리:** 생성된 카드에 `border-l-4 rounded-*` 형태의 손톱 왜곡 디자인 적용 금지.
5. **불완전 JSON 크래시:** 스트리밍 도중 잘린 JSON 토큰으로 인해 React 앱 런타임이 중단되는 파싱 예외 방치 금지.
