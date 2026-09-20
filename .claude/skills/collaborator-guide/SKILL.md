---
name: collaborator-guide
description: "개발 협력자(collaborator) 모드에서 개발자가 직접 코드를 타이핑할 수 있도록 파일 위치, 코드 내용, 설계 이유, 대안 비교를 웹 화면에 띄우고 실시간 안내한다. '협업 웹 띄워줘', '타이핑 가이드 열기', '코드 위치 알려줘', 'collaborator web', 'typing guide', 'show code guide' 등의 요청 시 사용."
---

# collaborator-guide — 협업 모드 대화형 코드 타이핑 가이드

이 스킬은 **개발 협력자(`collaborator`) 모드**에서 에이전트가 코드를 대신 작성하지 않고, 개발자가 직접 IDE에서 코드를 타이핑하며 학습하고 점검할 수 있도록 **타이핑 대상 파일/위치, 코드 스니펫, 설계 이유 및 대안 비교**를 전용 웹 인터페이스([http://127.0.0.1:4785](http://127.0.0.1:4785))로 띄워주는 기능입니다.

---

## 🛠️ 실행 및 사용법

```bash
# 1. 협업 웹 뷰어 실행 및 브라우저 열기
node scripts/collaborator-web.ts --open

# 2. 특정 포트로 실행
node scripts/collaborator-web.ts --port=4785
```

---

## 🖥️ 웹 뷰어에서 제공하는 정보

1. **타이핑 대상 위치 (Location Banner)**:
   - 수정/추가할 대상 파일 경로 (예: `src/services/auth.ts`)
   - 코드 위치 및 라인 번호 (예: `L45-L60`)
   - 함수 또는 심볼 스코프 (예: `validateToken()`)
   - 작업 유형 (`insert`, `replace`, `create`)

2. **작성할 코드 내용 (Code Snippet & Diff)**:
   - 복사(Copy) 버튼이 포함된 다크 테마 코드 블록
   - 필요 시 Before / After diff 표시

3. **설계 이유 및 배경 (Rationale & Explanation)**:
   - 이 코드가 필요한 구체적 배경
   - 보안 및 성능 측면의 고려 사항

4. **대안 및 트레이드오프 (Alternatives Table)**:
   - 방안 A vs 방안 B 장단점 비교 표

5. **타이핑 체크리스트 & 메모 (Interactive Checklist)**:
   - 개발자가 직접 체크할 수 있는 단계별 확인 항목
   - 에이전트에게 전달할 피드백/질문 메모 입력창

6. **모드 즉시 전환 버튼**:
   - 웹 화면 상단에서 `[자율 모드로 전환]` 또는 `[협업 모드로 전환]` 원클릭 토글
