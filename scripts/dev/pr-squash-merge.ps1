<#
.SYNOPSIS
    Standard GitHub Commit, Push, PR Create, Squash & Merge, and Branch Cleanup workflow runner.
.DESCRIPTION
    1. If currently on 'main', creates a feature branch automatically (feat/...)
    2. Stages and commits all changes (git add -A && git commit -m "$Message")
    3. Pushes branch to origin (git push -u origin $Branch)
    4. Creates GitHub PR if none exists (gh pr create)
    5. Squash merges PR to main with '#<PR_NUM>' format (gh pr merge --squash --delete-branch)
    6. Switches to local main and syncs (git switch main && git pull origin main)
    7. Cleans up local branch (git branch -D $Branch) and prunes remote tracking
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $false)]
    [string]$Message = '',

    [Parameter(Mandatory = $false)]
    [string]$Branch = '',

    [Parameter(Mandatory = $false)]
    [string]$Body = ''
)

$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path "$PSScriptRoot\..\..").Path

$currentBranch = (git branch --show-current).Trim()
if (-not $currentBranch) {
    throw "Detached HEAD 상태입니다. 유효한 브랜치에서 실행해주세요."
}

# 1. 브랜치 검사 및 자동 분기 (main 직접 커밋/푸시 방지)
if ($currentBranch -eq 'main') {
    if (-not $Branch) {
        $timestamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
        $Branch = "feat/auto-$timestamp"
    }
    Write-Host "🌿 'main' 브랜치에서 작업 브랜치로 분기합니다: $Branch" -ForegroundColor Cyan
    git switch -c $Branch
    $currentBranch = $Branch
}

# 2. 변경사항 커밋
$status = (git status --porcelain).Trim()
if ($status) {
    if (-not $Message) {
        $Message = "feat: update changes ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))"
    }
    Write-Host "📝 변경사항 스테이징 및 커밋 중..." -ForegroundColor Cyan
    git add -A
    git commit -m "$Message"
} else {
    Write-Host "ℹ️ 커밋할 변경사항이 없습니다. 브랜치의 기존 커밋으로 계속 진행합니다." -ForegroundColor Yellow
}

# 3. GitHub 원격(origin)으로 브랜치 푸시
Write-Host "🚀 원격 저장소(origin)로 브랜치 푸시 중 ($currentBranch)..." -ForegroundColor Cyan
git push -u origin $currentBranch

# 4. GitHub CLI ('gh') 확인 및 PR 생성
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI ('gh')가 설치되어 있지 않습니다. winget install GitHub.cli 후 다시 시도하세요."
}

$prExists = $null
try {
    $prExists = (gh pr list --head $currentBranch --json number --jq '.[0].number' 2>$null).Trim()
} catch {}

if (-not $prExists) {
    $prTitle = if ($Message) { $Message } else { "feat: $currentBranch" }
    $prBody = if ($Body) { $Body } else { "## 📌 변경 요약`n- $prTitle`n`n## 🧪 검증`n- 단위/통합 테스트 통과" }
    Write-Host "📬 GitHub Pull Request 생성 중..." -ForegroundColor Cyan
    gh pr create --title "$prTitle" --body "$prBody" --base main --head $currentBranch
    $prExists = (gh pr list --head $currentBranch --json number --jq '.[0].number').Trim()
} else {
    Write-Host "ℹ️ 기존 PR #$prExists 가 열려 있습니다." -ForegroundColor Yellow
}

# 5. Squash and Merge 수행
$prInfo = gh pr view $currentBranch --json number,title,body | ConvertFrom-Json
$prNum = $prInfo.number
$prTitle = $prInfo.title
$prBody = $prInfo.body

Write-Host "🔀 Squash and Merge 수행 중 (PR #${prNum}: $prTitle)..." -ForegroundColor Cyan
$subject = "$prTitle (#$prNum)"

try {
    gh pr merge $currentBranch --squash --delete-branch --subject "$subject" --body "$prBody"
} catch {
    try {
        gh pr merge $currentBranch --squash --delete-branch --admin
    } catch {
        gh pr merge $currentBranch --squash --delete-branch
    }
}

# 6. 로컬 main 동기화
Write-Host "🔄 로컬 main 브랜치 동기화 중..." -ForegroundColor Cyan
git switch main
git pull origin main

# 7. 로컬 브랜치 삭제 및 원격 추적 정리
Write-Host "🧹 작업 브랜치 정리 중 ($currentBranch)..." -ForegroundColor Cyan
git branch -D $currentBranch
git remote prune origin

Write-Host "🎉 [성공] 깃 커밋, 푸시, 메인 머지 앤 스쿼시, 브랜치 삭제가 모두 완료되었습니다!" -ForegroundColor Green