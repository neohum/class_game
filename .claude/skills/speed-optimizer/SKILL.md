---
name: speed-optimizer
description: "에이전트(Claude, Codex, AGY)가 작업을 수행할 때 탐색/추론 지연을 최소화하고, 사용자에게 개발 속도를 3~5배 극대화하는 스마트 스코핑, 타깃 테스트 실행 및 구조화된 프롬프트를 능동적으로 추천하는 스킬입니다. '속도 최적화', '프롬프트 추천', '빠른 개발', 'speed optimization', 'fast prompt', 'test fast' 요청 시 사용."
---

# speed-optimizer — 에이전트 속도 극대화 및 지시 추천 가이드

이 스킬은 Claude, Codex, AGY 3대 AI 에이전트가 개발 및 하네스 루프를 돌 때 **시간 지연(Latency)을 최소화하고 개발 속도를 3~10배 끌어올리는 표준 행동 지침**입니다.

---

## 🎯 4대 속도 최적화 원칙 (Speed Pillars)

1. **스마트 스코핑 (Smart Scoping / Direct File Pointers)**:
   - "어디 고칠지"를 미리 아는 작업은 전체 코드베이스 탐색(`find_by_name`, `grep_search`)을 건너뛰고 타깃 파일(`Files:`)로 직행합니다.
   - 사용자 지시가 모호할 경우, 구체적인 파일 경로와 변경 범위를 역제안합니다.

2. **타깃 테스트 우선 실행 (Targeted & Fast Test Execution)**:
   - 매 턴 전체 테스트 스위트를 돌리지 않고, `npm run test:fast` 또는 `node scripts/test-fast.ts <target>`을 통해 변경된 파일 관련 테스트만 1~2초 내에 즉시 검증합니다.

3. **모델 계층화 (Model Tiering)**:
   - 파일 탐색, 린트 수정, 테스트 실행, 보일러플레이트: **Flash / Light**
   - 아키텍처 설계, 보안/무결성 감사, 최종 승인: **High / Thinking / Pro**

4. **Wave 기반 모듈 분할 (Modular Wave Decomposition)**:
   - 거대한 기능은 한 번에 구현하지 않고, 독립된 3~4개 단계(타입 ➔ 코어 로직 ➔ UI/API ➔ 테스트)로 나누어 병렬 또는 Fail-Fast 순차 실행합니다.

---

## 💡 사용자 지시 추천 프로토콜 (Prompt Recommendation Protocol)

사용자가 광범위하거나 시간이 오래 걸릴 수 있는 요청을 입력했을 때, 에이전트는 아래와 같은 **[속도 극대화 프롬프트 템플릿]**을 사용자에게 제시하고 단계별 실행을 권고해야 합니다.

### 권장 프롬프트 포맷:
```markdown
> ⚡ **속도 극대화를 위한 추천 지시 포맷**:
> 
> "[타깃 파일 경로]에 [수정/추가할 핵심 스키마/함수]를 구현하고, 
> [관련 단위 테스트 파일/fast test]로 1차 검증한 뒤 [UI/연동 컴포넌트]에 연결해줘."
```

### 비교 예시:
* ❌ **지연 유발 (30~50 턴 소요)**: `"런처 설정 화면에 자동 업데이트 기능 넣어줘"`
* ⭕ **초고속 실행 (3~5 턴 소요)**: 
  1. `"apps/launcher/frontend/src/types/settings.ts에 UpdatePolicySettings 정의 추가"`
  2. `"apps/launcher/frontend/src/components/SettingsDiagnosticsView.tsx에 토글 UI 연결"`
  3. `"npm run test:fast로 관련 단위 검증"`
