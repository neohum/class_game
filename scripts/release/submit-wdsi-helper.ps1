<#
.SYNOPSIS
    Microsoft Security Intelligence (WDSI) 무료 평판 등록 도우미
.DESCRIPTION
    새로 빌드된 런처/에디터 인스톨러(.exe)의 SHA-256 해시를 계산하고,
    Microsoft Defender SmartScreen 자연 평판(Reputation) 등록을 위한 
    WDSI 파일 제출 정보와 제출 페이지를 즉시 열어줍니다.
#>

[CmdletBinding()]
param(
    [string]$App = "launcher",
    [string]$FilePath = "",
    [switch]$OpenBrowser = $true
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = (Resolve-Path (Join-Path $scriptDir "..\..")).Path

# 인스톨러 파일 탐색
if (-not $FilePath) {
    $searchDir = Join-Path $rootDir "apps\$App\build\bin"
    if (Test-Path $searchDir) {
        $candidates = Get-ChildItem -Path $searchDir -Filter "*installer.exe" | Sort-Object LastWriteTime -Descending
        if (-not $candidates) {
            $candidates = Get-ChildItem -Path $searchDir -Filter "*.exe" | Sort-Object LastWriteTime -Descending
        }
        if ($candidates) {
            $FilePath = $candidates[0].FullName
        }
    }
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " 🛡️ Microsoft WDSI SmartScreen 평판 무료 등록 도우미" -ForegroundColor Cyan
Write-Host " (비용 0원으로 MS 클라우드에 안전한 파일로 사전 등록)" -ForegroundColor DarkGray
Write-Host "============================================================" -ForegroundColor Cyan

if (-not $FilePath -or -not (Test-Path $FilePath)) {
    Write-Host "  ⚠️ 인스톨러 파일을 찾지 못했습니다: $searchDir" -ForegroundColor Yellow
    Write-Host "  직접 파일 경로를 지정해 실행할 수 있습니다:" -ForegroundColor Gray
    Write-Host "  .\scripts\release\submit-wdsi-helper.ps1 -FilePath '경로\setup.exe'" -ForegroundColor Gray
    Write-Host ""
    $FilePath = "(빌드 후 생성되는 setup.exe 파일)"
    $sha256 = "(빌드 후 자동 계산)"
    $fileSizeMB = "N/A"
} else {
    $fileItem = Get-Item -LiteralPath $FilePath
    $fileSizeMB = [math]::Round($fileItem.Length / 1MB, 2)
    Write-Host "  📁 파일명: $($fileItem.Name)" -ForegroundColor Green
    Write-Host "  📦 크기: $fileSizeMB MB ($($fileItem.Length) bytes)" -ForegroundColor Gray
    Write-Host "  ⏳ SHA-256 해시 계산 중..." -ForegroundColor DarkGray
    $hashObj = Get-FileHash -LiteralPath $FilePath -Algorithm SHA256
    $sha256 = $hashObj.Hash
    Write-Host "  🔑 SHA-256: $sha256" -ForegroundColor Yellow
}

$submissionUrl = "https://www.microsoft.com/en-us/wdsi/filesubmission"

Write-Host ""
Write-Host "📋 Microsoft WDSI 제출 가이드 (30초 소요):" -ForegroundColor Cyan
Write-Host "  1. Microsoft 계정으로 포털에 로그인합니다." -ForegroundColor White
Write-Host "  2. [Submit a file] 클릭 후 인스톨러 파일 업로드" -ForegroundColor White
Write-Host "  3. 제출 항목 입력:" -ForegroundColor White
Write-Host "     - Category: Software Developer (False Positive / SmartScreen)" -ForegroundColor Gray
Write-Host "     - Product Name: Cloud School Launcher (구름학교 런처)" -ForegroundColor Gray
Write-Host "     - Description: 안전한 교육용 소프트웨어 런처 정식 릴리스입니다." -ForegroundColor Gray
Write-Host ""
Write-Host "🌐 제출 포털 URL: $submissionUrl" -ForegroundColor Cyan

if ($OpenBrowser) {
    Write-Host "  🚀 기본 브라우저에서 제출 포털을 엽니다..." -ForegroundColor Green
    try {
        Start-Process $submissionUrl
    } catch {
        Write-Host "  브라우저 자동 실행 실패. 위 URL로 직접 접속해 주세요." -ForegroundColor Yellow
    }
}

Write-Host "============================================================" -ForegroundColor Cyan
