#!/bin/bash
# pr-squash-merge.sh — Standard GitHub PR creation and Squash Merge workflow runner.
# Enforces the mandatory policy: No direct main push; all changes merge to main via PR Squash & Merge.

set -e

CURRENT_BRANCH=$(git branch --show-current)

if [ -z "$CURRENT_BRANCH" ]; then
  echo "❌ Error: Detached HEAD 상태입니다. 유효한 브랜치에서 실행해주세요." >&2
  exit 1
fi

if [ "$CURRENT_BRANCH" = "main" ]; then
  echo "❌ Error: 'main' 브랜치에서는 직접 PR을 생성하거나 푸시할 수 없습니다." >&2
  echo "   먼저 작업 브랜치를 생성해주세요: git switch -c feat/<작업-이름>" >&2
  exit 1
fi

TITLE="${1:-}"
BODY="${2:-}"

echo "==============================================================================="
echo "🚀 [GitHub PR & Squash Merge Workflow] 브랜치: $CURRENT_BRANCH"
echo "==============================================================================="

# 1. Push current branch to origin
echo ""
echo "1️⃣ 원격 저장소(origin)로 브랜치 푸시 중..."
git push -u origin "$CURRENT_BRANCH"

# 2. Check if GitHub CLI is installed
if ! command -v gh &> /dev/null; then
  echo "⚠️ GitHub CLI ('gh')가 설치되어 있지 않습니다."
  echo "   GitHub 웹 브라우저에서 PR을 생성한 후 'Squash and merge'를 수행해주세요:"
  echo "   URL: https://github.com/$(git config --get remote.origin.url | sed -E 's/.*github.com[:\/](.+)\.git/\1/')/pull/new/$CURRENT_BRANCH"
  exit 1
fi

# 3. Create Pull Request if not already existing
echo ""
echo "2️⃣ GitHub Pull Request 확인 및 생성 중..."
PR_EXISTS=$(gh pr list --head "$CURRENT_BRANCH" --json number --jq '.[0].number' 2>/dev/null || true)

if [ -z "$PR_EXISTS" ]; then
  if [ -n "$TITLE" ]; then
    gh pr create --title "$TITLE" --body "${BODY:-Automated PR from lane/feature branch}" --base main --head "$CURRENT_BRANCH"
  else
    gh pr create --fill --base main --head "$CURRENT_BRANCH"
  fi
  echo "✅ Pull Request 생성 완료."
else
  echo "ℹ️ 기존 PR #$PR_EXISTS 이(가) 이미 열려 있습니다."
fi

# 4. Prompt / Execute Squash Merge with #<number> in commit title
echo ""
PR_NUMBER=$(gh pr view "$CURRENT_BRANCH" --json number --jq '.number' 2>/dev/null || echo "$PR_EXISTS")
PR_TITLE=$(gh pr view "$CURRENT_BRANCH" --json title --jq '.title' 2>/dev/null || echo "$TITLE")
PR_BODY_CONTENT=$(gh pr view "$CURRENT_BRANCH" --json body --jq '.body' 2>/dev/null || echo "$BODY")

echo "🔗 대상 PR: #$PR_NUMBER ($PR_TITLE)"
echo "3️⃣ Squash and Merge 수행 중 (main으로 '#$PR_NUMBER' 태그가 포함된 단일 커밋 압축 병합)..."

# Merge with explicit subject formatting "<PR Title> (#<PR_NUMBER>)"
gh pr merge "$CURRENT_BRANCH" --squash --delete-branch --subject "$PR_TITLE (#$PR_NUMBER)" --body "$PR_BODY_CONTENT" 2>/dev/null || \
gh pr merge "$CURRENT_BRANCH" --squash --delete-branch

# 5. Switch to main and sync
echo ""
echo "4️⃣ 로컬 main 브랜치 동기화 중..."
git switch main
git pull origin main

echo ""
echo "==============================================================================="
echo "🎉 [완료] PR Squash Merge 및 main 최신화가 성공적으로 끝났습니다!"
echo "==============================================================================="
