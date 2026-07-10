---
name: git-pull
description: 프로젝트 내 모든 git 저장소(메인 및 서브모듈)의 상태를 점검하고 최신 코드로 풀(pull)을 진행합니다. 사용자에게 아무것도 묻지 않고(no-prompt) 끝날 때까지 자동 진행합니다.
---

# git-pull — 모든 Git 저장소 일괄 자동 깃 풀 (질문 없이 진행)

> 이 스킬은 현재 프로젝트의 메인 Git 저장소 및 등록된 모든 Git 서브모듈을 자동으로 탐색하여 변경 사항을 확인하고 `git pull`을 실행합니다. 이 과정에서 사용자에게 동의나 결정을 묻지 않고(no-prompt) 완결될 때까지 일괄 처리합니다.

## 핵심 원칙
- **무조건 일괄 실행**: 이 스킬이 트리거되면 어떠한 질문이나 추가적인 확인 과정 없이 자동으로 동기화 로직을 시작하고 끝까지 진행합니다.
- **예외 자동 해결**: 분기 발산이나 로컬 변경사항 등의 예외 상태를 사전에 정의된 규칙에 따라 자율적으로 판단하여 해소합니다.

## 대상 저장소
- 메인 저장소 (현재 디렉터리)
- 프로젝트에 등록된 모든 Git 서브모듈 (동적 탐색)

## 수행 절차 및 예외 대응 규칙

### 1. 대상 디렉터리 식별
`git submodule status` 명령어를 통해 서브모듈 경로들을 동적으로 파악합니다.

### 2. 로컬 변경사항 자동 stashing
각 저장소에 uncommitted 수정사항이 존재하여 체크아웃/풀이 실패하는 경우:
- 먼저 `git stash`를 수행하여 변경 사항을 안전하게 대피시킨 후 지정된 브랜치 체크아웃 및 `git pull`을 실행합니다.
- 작업 완료 후 `git stash pop`을 실행하여 변경 사항을 다시 복구합니다.

### 3. 분기 발산(Divergence) 자동 reset
로컬 커밋과 원격 리모트 커밋이 달라 머지가 불가능한 경우:
- 로컬의 충돌 내역을 무시하고 원격 최신 코드로의 무조건 동기화를 위해 `git reset --hard origin/<branch>`를 실행하여 정렬합니다.

### 4. 일괄 실행 셸 스크립트 흐름
```bash
# 메인 저장소 루트 디렉터리 획득
ROOT_DIR=$(git rev-parse --show-toplevel)

# 1. 메인 저장소 동기화
echo "=== Processing main repository ==="
cd "$ROOT_DIR"
git status --short
git pull

# 2. 모든 서브모듈 동적 획득 및 동기화
SUBMODULE_PATHS=$(git submodule status | awk '{print $2}')

for path in $SUBMODULE_PATHS; do
    echo "========================================"
    echo "Submodule: $path"
    echo "========================================"
    cd "$ROOT_DIR/$path"
    git status --short
    
    # 로컬 변경사항 존재 여부 확인
    HAS_CHANGES=$(git status --porcelain)
    if [ ! -z "$HAS_CHANGES" ]; then
        git stash
    fi
    
    # .gitmodules에 기재된 추적 브랜치 획득 (기본값: main)
    BRANCH=$(git config -f "$ROOT_DIR/.gitmodules" "submodule.$path.branch" || echo "main")
    git checkout "$BRANCH"
    
    # Pull 시도하되, 충돌/발산 시 강제 reset으로 원격 동기화
    git pull || (git fetch origin && git reset --hard "origin/$BRANCH")
    
    # stash 했던 내역 복원
    if [ ! -z "$HAS_CHANGES" ]; then
        git stash pop
    fi
done
```

## 결과 요약 보고
전체 작업이 종료된 후, 각 디렉터리별 결과(동기화 성공 여부 및 변경된 파일 목록)를 요약하여 사용자에게 최종 보고합니다.
