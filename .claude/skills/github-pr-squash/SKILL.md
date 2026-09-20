---
name: github-pr-squash
description: "GitHub origin에 작업 브랜치를 푸시하고, Pull Request(PR)를 생성한 뒤 독립 검증을 거쳐 main 브랜치로 Squash and Merge를 수행하는 표준 워크플로우 스킬입니다. '깃헙 푸시', 'PR 생성', '메인 머지', '스쿼시 머지', 'github push', 'pr merge' 요청 시 사용."
---

# github-pr-squash — GitHub PR 생성 및 Main Squash Merge 표준 절차

이 스킬은 `main` 브랜치에 직접 푸시하거나 머지하는 것을 엄격히 금지하고,
항상 전용 작업 브랜치를 통해 **GitHub Pull Request (PR)**를 생성한 뒤
**Squash and Merge (`gh pr merge --squash`)**로 안전하게 병합하는 하네스 표준 절차입니다.

---

## 🎯 핵심 원칙

1. **Main 직접 푸시 절대 금지**:
   - `main` 브랜치로의 `git push`는 `.githooks/pre-push`에 의해 사전 차단됩니다.
   - 모든 작업은 `feat/...`, `fix/...`, `lane/...` 등의 독립 브랜치에서 진행됩니다.
2. **단일 PR = 단일 원자적 스쿼시 커밋**:
   - 브랜치 안에서 여러 번 쪼개어 커밋했더라도, `main` 병합 시에는 **Squash Merge**를 통해 1개의 깔끔하고 완전한 단위 커밋으로 압축합니다.
3. **독립 검증 통과 후 병합**:
   - 빌드(`pnpm build`), 테스트(`vitest`), 린트/타입체크 검증을 100% 통과한 상태에서만 PR을 생성하고 병합합니다.

---

## 🛠️ 단계별 실행 절차

### 1단계: 작업 브랜치 확인 및 분기
작업 시작 또는 커밋 전, 현재 브랜치가 `main`이 아닌지 확인하고 작업 브랜치로 전환합니다:
```bash
# main에 위치한 경우 새 기능/수정 브랜치 생성
git switch -c feat/<작업-슬러그>
```

### 2단계: 변경사항 커밋 및 로컬 헬스 게이트 검증
```bash
# 1. 변경사항 스테이징 및 커밋 (Ad-hoc 또는 카드 태그 포함)
git add -A
git commit -m "feat(<스코프>): <작업 요약 내용>"

# 2. 필수 검증 (Fail-Closed)
pnpm test
```

### 3단계: GitHub Origin으로 작업 브랜치 푸시
```bash
git push -u origin feat/<작업-슬러그>
```

### 4단계: GitHub PR (Pull Request) 생성
GitHub CLI (`gh`)를 사용하여 PR을 생성합니다:
```bash
gh pr create \
  --title "feat(<스코프>): <작업 제목>" \
  --body "## 📌 변경 요약
- <핵심 작업 내용 1>
- <핵심 작업 내용 2>

## 🧪 검증 결과
- 단위/통합 테스트 100% PASS
- 하네스 게이트 검증 완료" \
  --base main
```

### 5단계: Squash and Merge 수행 (`#<PR_NUMBER>` 커밋 태그 포함)
PR이 생성되고 검증이 완료되면, PR 번호가 포함된 스쿼시 머지를 실행합니다:
```bash
# 1. 헬퍼 스크립트로 일괄 수행
./scripts/dev/pr-squash-merge.sh "feat(<스코프>): <작업 제목>"

# 또는 2. GitHub CLI 수동 수행 (PR 번호를 제목 맨 앞에 위치)
PR_NUM=$(gh pr view --json number -q .number)
PR_TITLE=$(gh pr view --json title -q .title)
gh pr merge --squash --delete-branch --subject "#$PR_NUM $PR_TITLE"
```

### 6단계: 로컬 `main` 동기화
병합 완료 후 로컬 `main` 브랜치를 최신 상태로 갱신합니다:
```bash
git switch main
git pull origin main
```

---

## 🚨 문제 해결 가이드

- **`gh: command not found`인 경우**:
  - GitHub CLI가 설치되지 않았거나 인증이 풀린 경우, 브랜치 푸시 후 사용자에게 GitHub 웹 PR 링크(`https://github.com/<org>/<repo>/pull/new/<branch>`)를 제공하고 웹에서 [Squash and merge] 버튼을 클릭하도록 안내합니다.
- **머지 충돌 (Conflict) 발생 시**:
  - `git switch feat/<작업-슬러그> && git merge main`을 수행하여 로컬에서 충돌을 해결하고 테스트를 통과한 뒤 다시 푸시합니다.
