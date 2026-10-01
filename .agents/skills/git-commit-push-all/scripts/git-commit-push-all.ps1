# git-commit-push-all.ps1
# edulinker 루트 및 서브모듈을 포함하여 .git 폴더가 존재하는 모든 디렉토리를 찾아 커밋 & 푸시를 일괄 처리합니다.

$ErrorActionPreference = "Stop"
$rootDir = Resolve-Path "."

# .git 폴더가 있는 디렉토리들 찾기 (node_modules 내부 등은 제외)
Write-Host "Searching for git repositories under $($rootDir.Path)..." -ForegroundColor Cyan
$gitDirs = Get-ChildItem -Path $rootDir.Path -Directory -Hidden -Recurse -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -eq ".git" -and $_.FullName -notmatch "node_modules" -and $_.FullName -notmatch "\.antigravitycli" -and $_.FullName -notmatch "\.gemini" -and $_.FullName -notmatch "\.codex" -and $_.FullName -notmatch "\.antigravitycli" -and $_.FullName -notmatch "\.antigravity-cli"
} | ForEach-Object {
    $_.Parent.FullName
}

# 루트 디렉토리 추가 (만약 목록에 누락되어 있다면)
if ($gitDirs -notcontains $rootDir.Path) {
    $gitDirs = @($rootDir.Path) + $gitDirs
}

# 중복 제거 및 경로 정렬
$gitDirs = $gitDirs | Select-Object -Unique | Sort-Object

# 상위 저장소가 무시하는 경로는 이 저장소의 일부가 아니다 — 폴더 안에 있을 뿐인
# 남의 저장소다. 거기에 add -A/commit/push 를 돌리면 그 저장소의 리뷰 게이트를
# 건너뛰고 미검토 파일을 그쪽 원격으로 밀어 넣는다. 이름이 아니라 성질로 거른다.
$gitDirs = $gitDirs | Where-Object {
    if ($_ -eq $rootDir.Path) { return $true }
    git -C $rootDir.Path check-ignore -q $_ 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  skip (상위 저장소가 무시하는 경로): $_" -ForegroundColor DarkGray
        return $false
    }
    return $true
}

Write-Host "Found $($gitDirs.Count) git repositories:" -ForegroundColor Gray
foreach ($dir in $gitDirs) {
    Write-Host "  - $dir" -ForegroundColor Gray
}
Write-Host ""

$commitMsg = "auto: bulk update $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

foreach ($dir in $gitDirs) {
    Write-Host "========================================" -ForegroundColor Blue
    Write-Host "Processing: $dir" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Blue
    
    try {
        # status 확인
        $status = git -C $dir status --porcelain
        if ([string]::IsNullOrEmpty($status)) {
            # push하지 않은 커밋이 있는지 확인 ('@{u}' 문자열을 홑따옴표로 감싸 파워셸 파서 에러 방지)
            $unpushed = git -C $dir log '@{u}..HEAD' --oneline -n 1 2>$null
            if ($null -ne $unpushed -and $unpushed.Length -gt 0) {
                Write-Host "No working tree changes, but found unpushed commits. Pushing..." -ForegroundColor Cyan
                git -C $dir push origin HEAD
            } else {
                Write-Host "Working tree is clean. Up-to-date." -ForegroundColor Green
            }
            continue
        }
        
        Write-Host "Changes detected:" -ForegroundColor Magenta
        Write-Host $status
        
        # Add, Commit, Push
        Write-Host "Staging changes..." -ForegroundColor Gray
        git -C $dir add -A
        
        Write-Host "Committing changes..." -ForegroundColor Gray
        git -C $dir commit -m $commitMsg
        
        Write-Host "Pushing to remote..." -ForegroundColor Cyan
        git -C $dir push origin HEAD
        
        Write-Host "Successfully committed and pushed!" -ForegroundColor Green
    } catch {
        Write-Host "Skipping or error processing repository $dir : $_" -ForegroundColor Red
    }
    Write-Host ""
}

Write-Host "All repositories processed!" -ForegroundColor Green
