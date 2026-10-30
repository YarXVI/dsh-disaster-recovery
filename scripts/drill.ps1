#Requires -Version 5.1
<#
.SYNOPSIS
  在不碰真实 DSH_HOME 的前提下，跑一遍「备份 → 事故 → 恢复 → 校验」演练。
.DESCRIPTION
  建一个临时 home + 临时 store，验证：
    1. 首次备份
    2. list 不产生新快照
    3. 删文件 + 改文件后 restore latest 能还原
    4. 被覆盖的旧内容进 restore-quarantine
    5. verify 报告 0 缺失
#>
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cli = Join-Path $scriptDir 'cli.mjs'

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($candidate in @(
      'D:\DeepSeek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe',
      (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'),
      'C:\Program Files\nodejs\node.exe')) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

$node = Find-Node
if (-not $node) { throw '找不到 node.exe' }

$tmp = Join-Path $env:TEMP ('dsh-drill-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$drillHome = Join-Path $tmp 'home'
$drillRoot = Join-Path $tmp 'store'
New-Item -ItemType Directory -Force (Join-Path $drillHome 'sessions\--D-x--\s1') | Out-Null
Set-Content -LiteralPath (Join-Path $drillHome 'workspace.json') -Value '{"v":1}' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $drillHome 'sessions\--D-x--\s1\session.v4.jsonl.zstd') -Value 'body-1' -Encoding UTF8

function Run-Cli([string[]]$argsList) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $node $cli @argsList 2>$null } finally { $ErrorActionPreference = $prev }
}

Write-Host '=== 1. 首次备份 ==='
Run-Cli @('backup', '--home', $drillHome, '--root', $drillRoot)

Write-Host '=== 2. 模拟事故：删一个、改一个 ==='
Remove-Item -LiteralPath (Join-Path $drillHome 'sessions\--D-x--\s1\session.v4.jsonl.zstd') -Force
Set-Content -LiteralPath (Join-Path $drillHome 'workspace.json') -Value '{"v":999}' -Encoding UTF8

Write-Host '=== 3. list（不应产生新快照）==='
Run-Cli @('list', '--home', $drillHome, '--root', $drillRoot)

Write-Host '=== 4. restore latest ==='
Run-Cli @('restore', 'latest', '--yes', '--home', $drillHome, '--root', $drillRoot)

Write-Host '=== 5. 校验恢复结果 ==='
$ok = $true
$ws = (Get-Content -LiteralPath (Join-Path $drillHome 'workspace.json') -Raw).Trim()
$body = (Get-Content -LiteralPath (Join-Path $drillHome 'sessions\--D-x--\s1\session.v4.jsonl.zstd') -Raw).Trim()
if ($ws -ne '{"v":1}') { $ok = $false; Write-Host "FAIL workspace.json = $ws" } else { Write-Host 'PASS workspace.json 已还原' }
if ($body -ne 'body-1') { $ok = $false; Write-Host "FAIL session body = $body" } else { Write-Host 'PASS 被删的会话文件已还原' }

$quarantine = Get-ChildItem -LiteralPath $drillRoot -Recurse -Directory -Filter 'restore-quarantine' | Select-Object -First 1
if ($quarantine) {
  $files = Get-ChildItem -LiteralPath $quarantine.FullName -Recurse -File
  if ($files.Count -ge 1) { Write-Host "PASS 隔离目录有 $($files.Count) 个旧文件" }
  else { $ok = $false; Write-Host 'FAIL 隔离目录为空' }
} else { $ok = $false; Write-Host 'FAIL 没有隔离目录' }

Write-Host '=== 6. verify ==='
$verifyOut = Run-Cli @('verify', 'latest', '--home', $drillHome, '--root', $drillRoot)
$verifyOut | ForEach-Object { Write-Host $_ }
if (($verifyOut -join "`n") -notmatch 'missing blobs 0') { $ok = $false; Write-Host 'FAIL 快照有缺失内容块' }

Write-Host ''
if ($ok) { Write-Host 'DRILL PASSED' -ForegroundColor Green; exit 0 }
Write-Host 'DRILL FAILED' -ForegroundColor Red
exit 1
