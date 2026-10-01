#!/bin/bash
# git-commit-push-all.sh
# edulinker 루트 및 서브모듈을 포함하여 .git 폴더가 존재하는 모든 디렉토리를 찾아 커밋 & 푸시를 일괄 처리합니다 (Linux/macOS 용).

set -e

rootDir=$(pwd)

echo -e "\033[36mSearching for git repositories under ${rootDir}...\033[0m"
# .git 폴더가 있는 디렉토리들 찾기 (node_modules 내부 등은 제외)
gitDirs=$(find "${rootDir}" -name ".git" -type d -not -path "*/node_modules/*" -not -path "*/.antigravitycli/*" -not -path "*/.gemini/*" -not -path "*/.codex/*" -not -path "*/.antigravity-cli/*" | sed 's/\/\.git$//' | sort -u)

# 상위 저장소가 무시하는 경로는 이 저장소의 일부가 아니다 — 폴더 안에 있을 뿐인
# 남의 저장소다. 거기에 add -A/commit/push 를 돌리면 그 저장소의 리뷰 게이트를
# 건너뛰고 미검토 파일을 그쪽 원격으로 밀어 넣는다. 이름이 아니라 성질로 거른다:
# 이름을 박아 두면 다음에 생길 형제 저장소는 또 새는다.
keptDirs=""
for dir in $gitDirs; do
    if [ "$dir" != "${rootDir}" ] && git -C "${rootDir}" check-ignore -q "$dir" 2>/dev/null; then
        echo -e "\033[90m  skip (상위 저장소가 무시하는 경로): $dir\033[0m"
        continue
    fi
    keptDirs="${keptDirs}${dir}
"
done
gitDirs=$(printf '%s' "$keptDirs" | sed '/^$/d')

echo -e "\033[90mFound repositories:\033[0m"
for dir in $gitDirs; do
    echo "  - $dir"
done
echo ""

commitMsg="auto: bulk update $(date '+%Y-%m-%d %H:%M:%S')"

for dir in $gitDirs; do
    echo -e "\033[34m========================================\033[0m"
    echo -e "\033[33mProcessing: $dir\033[0m"
    echo -e "\033[34m========================================\033[0m"
    
    # status 확인
    status=$(git -C "$dir" status --porcelain)
    if [ -z "$status" ]; then
        # push하지 않은 로컬 커밋이 있는지 확인 (@{u}..HEAD)
        unpushed=$(git -C "$dir" log '@{u}..HEAD' --oneline -n 1 2>/dev/null || true)
        if [ -n "$unpushed" ]; then
            echo -e "\033[36mNo working tree changes, but found unpushed commits. Pushing...\033[0m"
            git -C "$dir" push origin HEAD
        else
            echo -e "\033[32mWorking tree is clean. Up-to-date.\033[0m"
        fi
        continue
    fi
    
    echo -e "\033[35mChanges detected:\033[0m"
    echo "$status"
    
    # Add, Commit, Push
    echo -e "\033[90mStaging changes...\033[0m"
    git -C "$dir" add -A
    
    echo -e "\033[90mCommitting changes...\033[0m"
    git -C "$dir" commit -m "$commitMsg"
    
    echo -e "\033[36mPushing to remote...\033[0m"
    git -C "$dir" push origin HEAD
    
    echo -e "\033[32mSuccessfully committed and pushed!\033[0m"
    echo ""
done

echo -e "\033[32mAll repositories processed!\033[0m"
