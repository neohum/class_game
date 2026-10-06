---
name: native-page-transitions
description: "Web Animations API(WAAPI) 기반 네이티브 앱급 화면 전환(SSGOI) 및 Live DOM 보존, 도허티 임계(<400ms) 표준 가이드. '화면 전환', '페이지 트랜지션', 'page transition', 'ssgoi' 요청 시 사용."
---

# native-page-transitions: 네이티브 앱급 페이지 트랜지션 아키텍처 스킬

이 스킬은 웹 애플리케이션(React, Next.js, Vue, Svelte, Wails 등)에서 브라우저 특유의 흰 화면 깜빡임이나 끊김 없이, iOS/Android 네이티브 앱 수준의 유기적인 화면 전환 사용자 경험을 구현하는 공식 표준 아키텍처 가이드입니다.

---

## 1. 핵심 아키텍처 4대 불변식 (Invariants)

1. **Live DOM 보존 (vs View Transition API 스냅샷의 한계 극복)**:
   - 브라우저 기본 `document.startViewTransition()`은 정적 스냅샷 이미지 가상 요소(`::view-transition`)로 처리되어 동영상, 오디오, 캔버스 드로잉, WebGL 상태가 전환 도중 멈추거나 깜빡입니다.
   - 본 표준(SSGOI 패턴)은 실제 나가는 페이지(unmounting node)의 Live DOM 노드를 보존하여 `position: absolute`로 배치하고, 새 페이지와 함께 물리 애니메이션을 적용하므로 미디어 재생 및 캔버스 인터랙션이 끊기지 않습니다.

2. **도허티 임계 반응성 준수 (`DOHERTY_THRESHOLD_MS = 400ms`)**:
   - 모든 트랜지션 애니메이션 지속 시간은 **250ms ~ 300ms**(기본 권장 280ms)로 엄격히 제한됩니다.
   - 매 프레임마다 자바스크립트 계산을 수행하지 않고, 스프링 피직스(Spring Physics) 궤적을 사전에 계산해 Web Animations API(WAAPI) 키프레임으로 컴파일하여 브라우저 합성 스레드(Compositor Thread)에서 60fps로 매끄럽게 구동합니다.

3. **영속 레이아웃 분리 (Persistent Layout Isolation)**:
   - 상단 글로벌 헤더, 데스크톱 사이드바, 모바일 하단 탭 바 등 화면 전환 시 유지되어야 하는 네비게이션 요소는 반드시 트랜지션 바운더리(`<SsgoiRouteBoundary>`) **외부**에 위치시켜 불필요한 언마운트 및 CLS(Layout Shift)를 0으로 유지합니다.
   - 바운더리를 감싸는 최상단 컨테이너에는 `relative z-0 min-h-full overflow-x-clip` 클래스를 의무 적용하여 가로 스크롤바 튐을 방지하고 정확한 오프셋 기준점을 형성합니다.

4. **Zero-PII 및 보안 Fail-Closed 검증**:
   - 트랜지션 미들웨어 또는 라우트 해석기에서 URL 경로 및 쿼리 파라미터를 검사하여 주민등록번호, 전화번호, 이메일, 실명 식별자가 포함되어 있을 경우 화면 전환을 즉시 차단(Fail-closed)합니다.

---

## 2. 반응형 모션 프리셋 계층 (Preset Hierarchy)

| 환경 / 상황 | 권장 프리셋 | 우선순위 (Priority) | 공간적 의미 / 용도 |
| :--- | :--- | :---: | :--- |
| **모바일: 목록 ➔ 상세 진입** | `drill()` | `10` | 계층 깊숙이 들어가는 느낌 및 명확한 뒤로가기 동선 제공 |
| **모바일: 모달 / 설문 / 바텀시트** | `sheet()` | `5` | 원래 배경이 은은하게 어두워지며 아래에서 솟아오름 |
| **모바일: 순서형 탭 / 스텝 이동** | `slide()` | `1` | 탭 순서(`ordered: ['home', 'tab1', ...]`)에 따른 자연스러운 좌우 이동 |
| **모바일: 기본 Fallback** | `fade()` | `-100` | 기타 경로 간 부드러운 불투명도 전환 |
| **데스크톱 (마우스/키보드)** | `fade()` | `-100` | 과도한 제스처/화면 쏠림을 배제한 깔끔한 스프링 페이드 |

---

## 3. 표준 Next.js App Router 구현 패턴

### (1) 트랜지션 설정 모듈 (`lib/ssgoi-transitions.ts`)
```typescript
import { drill, sheet, slide, fade } from '@ssgoi/react/view-transitions';

export const DURATION_MS = 280;

export const transitionConfig = {
  scrollLock: true,
  transitions: ({ isMobile }: { isMobile: boolean }) =>
    isMobile
      ? [
          { on: '/**/detail/**', transition: drill({ duration: DURATION_MS }), priority: 10 },
          { on: '/**/modal/**', transition: sheet({ duration: DURATION_MS }), priority: 5 },
          { on: '/**', transition: fade({ duration: DURATION_MS }), priority: -100 },
        ]
      : [
          { on: '/**', transition: fade({ duration: DURATION_MS }), priority: -100 },
        ],
};
```

### (2) 클라이언트 프로바이더 (`components/transitions/SsgoiProvider.tsx`)
```tsx
'use client';

import { ReactNode } from 'react';
import { Ssgoi } from '@ssgoi/react';
import { transitionConfig } from '@/lib/ssgoi-transitions';

export function SsgoiProvider({ children }: { children: ReactNode }) {
  return <Ssgoi config={transitionConfig}>{children}</Ssgoi>;
}
```

### (3) 레이아웃 셸 통합 (`app/layout.tsx`)
```tsx
import { SsgoiProvider } from '@/components/transitions/SsgoiProvider';
import { SsgoiRouteBoundary } from '@ssgoi/react/nextjs';

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <SsgoiProvider>
      <Header /> {/* Persistent Layout */}
      <main className="relative z-0 min-h-dvh overflow-x-clip">
        <SsgoiRouteBoundary>
          {children}
        </SsgoiRouteBoundary>
      </main>
      <Footer /> {/* Persistent Layout */}
    </SsgoiProvider>
  );
}
```

---

## 4. 검증 체크리스트 (Verification Checklist)

- [ ] `pnpm test` 단위 테스트에서 지속시간 < 400ms(도허티 임계) 단언 통과
- [ ] URL 파라미터 및 경로 Zero-PII 감지 테스트 통과
- [ ] 브라우저 개발자 도구 렌더링 검사 시 고정 헤더/사이드바 CLS = 0 확인
- [ ] 모바일/데스크톱 뷰포트 변경 시 `isMobile` 분기 정상 트리거 확인
