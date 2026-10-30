#Requires -Version 5.1
<#
.SYNOPSIS
  DSH 起不来时的恢复入口（不依赖 DSH，只要有 Node）。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\restore.ps1 -List
  powershell -NoProfile -ExecutionPolicy Bypass -File .\restore.ps1                 # 恢复最新快照（会确认）
  powershell -NoProfile -ExecutionPolicy Bypass -File .\restore.ps1 -Snapshot 20261026-124500-change -Yes
#>
param(
  [string]$Snapshot = 'latest',
  [string]$DshHome = '',
  [string]$Root = '',
  [switch]$List,
  [switch]$Backup,
  [switch]$Verify,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cli = Join-Path $scriptDir 'cli.mjs'
if (-not (Test-Path $cli)) { throw "找不到 cli.mjs: $cli" }

function Find-Node {
  $candidates = @()
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += $cmd.Source }
  $candidates += 'D:\DeepSeek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
  $candidates += (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
  $candidates += 'C:\Program Files\nodejs\node.exe'
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  $runtimes = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
  if (Test-Path -LiteralPath $runtimes) {
    $found = Get-ChildItem -LiteralPath $runtimes -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.FullName }
  }
  return $null
}

$node = Find-Node
if (-not $node) { throw '找不到 node.exe：请安装 Node.js，或把 DSH 自带的 node 路径传给本脚本。' }
Write-Host "node     : $node"

$argv = @($cli)
if ($List) { $argv += 'list' }
elseif ($Backup) { $argv += 'backup' }
elseif ($Verify) { $argv += 'verify'; $argv += $Snapshot }
else { $argv += 'restore'; $argv += $Snapshot; if ($Yes) { $argv += '--yes' } }
if ($DshHome) { $argv += '--home'; $argv += $DshHome }
if ($Root) { $argv += '--root'; $argv += $Root }

& $node @argv
exit $LASTEXITCODE
