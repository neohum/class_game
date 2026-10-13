# parallel-git-sync.ps1
# Multi-repository parallel git sync wrapper for Windows PowerShell.
[CmdletBinding()]
param(
    [switch]$Scan,
    [switch]$Pull,
    [switch]$Plan,
    [switch]$AutoAll,
    [string]$SyncRepo,
    [string]$Root
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$MjsScript = Join-Path $ScriptDir 'parallel-git-sync.mjs'

$ArgsList = @()
if ($Scan) { $ArgsList += '--scan' }
if ($Pull) { $ArgsList += '--pull' }
if ($Plan) { $ArgsList += '--plan' }
if ($AutoAll) { $ArgsList += '--auto-all' }
if ($SyncRepo) { $ArgsList += @('--sync-repo', $SyncRepo) }
if ($Root) { $ArgsList += @('--root', $Root) }

if ($ArgsList.Count -eq 0) {
    $ArgsList += '--scan'
}

& node $MjsScript @ArgsList
