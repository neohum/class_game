# health.ps1 — Windows fallback for health.sh (weekend dev-box use).
#
# Mirrors health.sh: install (if deps missing) -> lint -> typecheck -> test.
# The Linux server runs health.sh; this exists so you can run the same gate on
# the Windows machine during weekend harness-tuning sessions.
#
# Override any step with an env var (set to "true" to skip):
#   HEALTH_INSTALL  HEALTH_LINT  HEALTH_TYPECHECK  HEALTH_TEST
#
# Exit: 0 = all gates pass; non-zero = first failing gate.

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")   # repo root

function Step($m) { Write-Host "`n▶ $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "✓ $m" -ForegroundColor Green }
function Die($m)  { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }

# --- detect package manager ---
$PM = if (Test-Path pnpm-lock.yaml) { "pnpm" }
      elseif (Test-Path yarn.lock)  { "yarn" }
      elseif (Test-Path bun.lockb)  { "bun" }
      else { "npm" }

function Has-Script($name) {
  if (-not (Test-Path package.json)) { return $false }
  node -e "process.exit(require('./package.json').scripts?.['$name']?0:1)" 2>$null
  return ($LASTEXITCODE -eq 0)
}

function Run($name, [scriptblock]$block) {
  Step "$name"
  & $block
  if ($LASTEXITCODE -ne 0) { Die "$name failed" }
  Ok $name
}

# --- install (only if deps missing) ---
$install = if ($env:HEALTH_INSTALL) { $env:HEALTH_INSTALL } else { "auto" }
if ($install -ne "true" -and (Test-Path package.json) -and -not (Test-Path node_modules)) {
  if ($install -eq "auto") { Run "install" { & $PM install } }
  else { Run "install" { Invoke-Expression $install } }
}

# --- lint ---
$lint = if ($env:HEALTH_LINT) { $env:HEALTH_LINT } else { "auto" }
if ($lint -eq "auto") { if (Has-Script "lint") { Run "lint" { & $PM run lint } } }
elseif ($lint -ne "true") { Run "lint" { Invoke-Expression $lint } }

# --- typecheck ---
$tc = if ($env:HEALTH_TYPECHECK) { $env:HEALTH_TYPECHECK } else { "auto" }
if ($tc -eq "auto") { if (Has-Script "typecheck") { Run "typecheck" { & $PM run typecheck } } }
elseif ($tc -ne "true") { Run "typecheck" { Invoke-Expression $tc } }

# --- test ---
$test = if ($env:HEALTH_TEST) { $env:HEALTH_TEST } else { "auto" }
if ($test -eq "auto") {
  if (Has-Script "test") { Run "test" { & $PM test } }
  else { Step "test: no test script — skipping (add one to tighten this gate)" }
} elseif ($test -ne "true") { Run "test" { Invoke-Expression $test } }

Ok "health: all gates passed"
