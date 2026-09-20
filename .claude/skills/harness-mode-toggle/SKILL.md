---
name: harness-mode-toggle
description: "완전 자율(autonomous/verify) 모드와 개발 협력자(collaborator) 모드를 손쉽게 상호 전환하고, 모드별 행동 지침을 실시간 동기화한다. '협업 모드로 전환', '자율 모드로 전환', '모드 변경', '모드 토글', 'switch to collaborator', 'switch to autonomous', 'toggle mode' 등의 요청 시 사용."
---

# harness-mode-toggle — 하네스 모드 전환 및 동기화

완전 자율 실행형(`autonomous` / `verify`) 모드와 조언·가이드 중심의 개발 협력자(`collaborator`) 모드를 안전하게 상호 전환하고, `AGENTS.md`와 `CLAUDE.md`의 행동 계약을 즉시 동기화합니다.

---

## 🛠️ CLI 사용법

하네스 전용 모드 전환 스크립트를 사용합니다:

```bash
# 1. 현재 모드 상태 확인
node scripts/mode.ts status

# 2. 협업 모드로 전환 (개발자가 직접 타이핑하는 조언형)
node scripts/mode.ts collaborator

# 3. 완전 자율 실행 모드로 전환 (주도적 파일 변경 및 검증형)
node scripts/mode.ts autonomous

# 4. 결과물 완결 및 재검증 모드로 전환
node scripts/mode.ts verify

# 5. 자율 ⇄ 협업 상호 토글 (가장 간단한 원클릭 방식)
node scripts/mode.ts toggle
```

---

## 💡 모드별 행동 특성

| 모드 | 식별자 | 주요 행동 원칙 |
| :--- | :--- | :--- |
| **자동 (자율 실행형)** | `autonomous` | 사용자가 맡긴 작업을 주도적으로 실행하며, 파일 수정과 테스트 검증을 에이전트가 직접 수행합니다. |
| **학습과병행 (개발 협력자형)** | `collaborator` | 설명, 선택지, 트레이드오프를 먼저 제공합니다. 파일 직접 수정을 하지 않고, 개발자가 직접 타이핑할 수 있도록 코드 위치와 내용을 안내하며 [협업 웹 가이드](http://127.0.0.1:4785)(`node scripts/collaborator-web.ts`)를 제공합니다. |
| **결과물 완결 및 재검증형** | `verify` | 작업을 끝까지 구현하고 실행한 후, 코너 케이스와 잠재적 오류를 이중 점검(Doublecheck)합니다. |
