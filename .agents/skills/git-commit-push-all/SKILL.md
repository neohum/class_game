---
name: git-commit-push-all
description: 프로젝트 루트 및 모든 하위 git 서브모듈의 변경 사항을 스캔하여, 일괄로 커밋(git commit)하고 원격 저장소에 푸시(git push)하는 스킬입니다.
---

# git-commit-push-all — 안전한 일괄 깃 커밋 및 푸시 스킬

이 스킬은 프로젝트 내 모든 Git 리포지토리(서브모듈 포함)의 작업 트리를 점검하고, 변경사항이 있는 경우 자동으로 일괄 스테이징, 커밋 및 푸시를 수행합니다.

## 절차

### 1. 대상 리포지토리 자동 스캔
- 지정된 루트 디렉토리 및 모든 하위 디렉토리에서 `.git` 폴더가 존재하는 리포지토리들을 탐색합니다.
- `node_modules`, `.antigravitycli`, `.gemini` 등의 빌드/캐시 디렉토리는 검색에서 제외됩니다.

### 2. 스크립트 실행
- **윈도우 환경 (PowerShell)**:
  ```powershell
  powershell -ExecutionPolicy Bypass -File E:\works\project\edulinker\.agents\skills\git-commit-push-all\scripts\git-commit-push-all.ps1
  ```
- **리눅스/macOS 환경 (Bash)**:
  ```bash
  chmod +x E:\works\project\edulinker\.agents\skills\git-commit-push-all\scripts\git-commit-push-all.sh
  bash E:\works\project\edulinker\.agents\skills\git-commit-push-all\scripts\git-commit-push-all.sh
  ```

### 3. 리포지토리별 감지 및 반영 전략
- **변경 사항이 있는 경우 (Status가 clean이 아닌 경우)**:
  - `git add -A`를 통해 모든 변경 사항(신규 추가, 수정, 삭제)을 스테이징 영역에 추가합니다.
  - `auto: bulk update YYYY-MM-DD HH:mm:ss` 형태의 커밋 메시지로 커밋을 수행합니다.
  - 현재 브랜치 기준 `git push origin HEAD`로 원격 저장소에 업로드합니다.
- **변경 사항은 없으나 로컬 커밋이 아직 푸시되지 않은 경우**:
  - `git log @{u}..HEAD`를 분석하여 로컬 커밋이 존재하면 즉시 `git push origin HEAD`로 업로드합니다.
- **이미 최신 상태인 경우**:
  - 작업 없이 건너뜁니다.
