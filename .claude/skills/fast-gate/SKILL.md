---
name: fast-gate
description: 변경된 파일에 매핑된 단위 테스트만 1초 내로 선별 실행해 TDD 루프 피드백을 극대화합니다. "빠른 테스트", "test fast", "단위 검증" 요청 시 사용.
---

# Fast Gate — TDD 초고속 단위 검증 게이트

이 스킬은 코드 구현 및 디버깅 중 40초 이상 소요되는 전체 테스트 스위트를 매 턴마다 실행하는 낭비를 막고,
`git status` 기반으로 수정된 파일에 대응하는 단위 테스트만을 <1.5초 이내에 타깃 실행하는 표준 게이트입니다.

---

## ⚡ 실행 명령

```bash
# git 수정된 파일 기반 자동 타깃 실행 (<1.5s)
npm run test:quick

# 또는 특정 파일이나 도메인 직접 지정
node scripts/loop/test-fast.ts [타깃파일]
```

---

## 🎯 사용 원칙

1. **반복 개발 중 (Red-Green-Refactor)**:
   - 전체 테스트(`npm test`)를 절대 남발하지 않고, `npm run test:quick`으로 즉각적인 피드백을 받습니다.
2. **도메인 휴리스틱 매핑**:
   - `evidence` 관련 파일 수정 시 ➔ `tests/evidence-capture.test.ts`
   - `plan-doc` 관련 파일 수정 시 ➔ `tests/plan-doc.test.ts`
   - `ship` 관련 파일 수정 시 ➔ `tests/ship.test.ts`
   - `test-fast` 관련 파일 수정 시 ➔ `tests/test-fast.test.ts`
3. **최종 릴리즈 전만 전체 실행**:
   - 전체 테스트 스위트(`npm test` / `health.ps1`)는 리뷰 요청 직전 마지막 1회에만 실행합니다.
