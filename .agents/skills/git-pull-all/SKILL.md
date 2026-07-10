---
name: git-pull-all
description: 프로젝트 루트 및 모든 git 서브모듈(존재할 경우)의 상태를 점검하고 로컬 변경사항을 안전하게 보존하며 일괄 깃 풀(git pull)을 수행합니다.
---

# git-pull-all — 안전한 일괄 깃 풀(git pull) 스킬

이 스킬은 프로젝트 내 모든 Git 리포지토리(루트 및 서브모듈)의 원격 최신 코드를 안전하게 가져옵니다. 로컬 변경사항이 있는 경우, 유실되지 않도록 stash 처리를 거쳐 풀합니다.

## 절차

### 1. 대상 리포지토리 목록 확인
- 루트 디렉토리
- 등록된 모든 git 서브모듈 (서브모듈이 존재할 경우 `.gitmodules` 참고)

### 2. 리포지토리 상태 확인
- `git status` 및 `git branch`를 이용하여 각 리포지토리의 현재 브랜치와 Working Tree 상태(clean 여부)를 파악합니다.
- `git -C <dir> status`를 사용하여 확인합니다. (NEVER use cd command).

### 3. 리포지토리별 풀 전략
- **Clean 상태인 경우**:
  - 주 개발 브랜치(예: `main` 또는 `master`)에 위치한 경우 바로 `git -C <dir> pull`을 수행합니다.
  - detached HEAD 등 브랜치가 어긋나 있는 경우, `git -C <dir> checkout <branch>`를 실행한 다음 `git -C <dir> pull`을 수행합니다.
- **Uncommitted 변경사항이 있는 경우**:
  - 원격의 변경사항과 충돌하지 않도록 안전하게 `git -C <dir> stash`를 실행하여 변경사항을 임시 저장합니다.
  - `git -C <dir> pull`을 실행합니다.
  - `git -C <dir> stash pop`을 실행하여 로컬 변경사항을 다시 복원시킵니다.

### 4. 사후 검증
- 모든 리포지토리가 성공적으로 업데이트되었는지 확인합니다.
- 변경 사항이 복원되었거나, 혹시 충돌(conflict)이 났는지 여부를 확인하고 충돌 시에는 사용자에게 보고합니다.
