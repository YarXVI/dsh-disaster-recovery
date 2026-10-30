#Requires -Version 5.1
<#
.SYNOPSIS
  「Deepseek恢复」开始菜单入口：列出快照，选一个恢复。
.DESCRIPTION
  不需要 DSH 能启动，只需要 Node。默认恢复前会二次确认；
  恢复完成后提示重启 DeepSeek Harness。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\recovery-console.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\recovery-console.ps1 -List
#>
param(
  [string]$DshHome = '',
  [string]$Root = '',
  [switch]$Yes,
  [switch]$List
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cli = Join-Path $scriptDir 'cli.mjs'
if (-not (Test-Path -LiteralPath $cli)) { throw "找不到 cli.mjs: $cli" }

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    'D:\DeepSeek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe',
    (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'),
    'C:\Program Files\nodejs\node.exe'
  )
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
if (-not $node) {
  Write-Host '找不到 node.exe：请安装 Node.js，或从 DSH 目录里找 node 路径。' -ForegroundColor Red
  if (-not $List) { Read-Host '按回车退出' | Out-Null }
  exit 1
}

function Build-Argv([string[]]$argsList) {
  $argv = @($cli) + $argsList
  if ($DshHome) { $argv += @('--home', $DshHome) }
  if ($Root) { $argv += @('--root', $Root) }
  return $argv
}

# 原生进程的 stderr 在 PowerShell 5.1 里会被当成错误；统一用 Continue + 退出码判断。
function Invoke-NodeCapture([string[]]$argsList) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $node (Build-Argv $argsList) 2>$null
    return @{ Text = ($out -join "`n"); Code = $LASTEXITCODE }
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Invoke-NodeStream([string[]]$argsList) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $node (Build-Argv $argsList)
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Format-When($ms) {
  if (-not $ms) { return '—' }
  return ([datetimeoffset]::FromUnixTimeMilliseconds([int64]$ms).LocalDateTime).ToString('yyyy-MM-dd HH:mm:ss')
}

Clear-Host
Write-Host ''
Write-Host '  Deepseek 恢复' -ForegroundColor Cyan
Write-Host '  从灾备快照恢复 DSH 数据（不需要 DSH 能启动）' -ForegroundColor DarkGray
Write-Host ''

$capture = Invoke-NodeCapture @('list', '--json')
if ($capture.Code -ne 0 -or -not $capture.Text.Trim()) {
  Write-Host '读取快照失败。' -ForegroundColor Red
  if ($capture.Text.Trim()) { Write-Host $capture.Text.Trim() }
  if (-not $List) { Read-Host '按回车退出' | Out-Null }
  exit 1
}

try {
  $data = $capture.Text | ConvertFrom-Json
} catch {
  Write-Host "快照清单解析失败：$($_.Exception.Message)" -ForegroundColor Red
  if (-not $List) { Read-Host '按回车退出' | Out-Null }
  exit 1
}

Write-Host ("  数据目录 : {0}" -f $data.home)
Write-Host ("  备份目录 : {0}" -f $data.store)
if ($data.blob) {
  Write-Host ("  占用     : {0} 个内容块 / {1:N1} MB" -f $data.blob.count, ($data.blob.bytes / 1MB))
}
Write-Host ''

$snaps = @($data.snapshots)
if (-not $snaps -or $snaps.Count -eq 0) {
  Write-Host '  还没有任何快照。' -ForegroundColor Yellow
  if (-not $List) { Read-Host '按回车退出' | Out-Null }
  exit 0
}

Write-Host '  可用快照：' -ForegroundColor Gray
$index = 0
foreach ($snap in $snaps) {
  $index += 1
  $when = Format-When $snap.at
  Write-Host ("   [{0,2}] {1}  {2,6} 个文件  {3}" -f $index, $when, $snap.files, $snap.reason)
  Write-Host ("        {0}" -f $snap.id) -ForegroundColor DarkGray
}

if ($List) { exit 0 }

Write-Host ''
Write-Host '  回车 = 恢复最新快照；输入编号 = 恢复指定快照；v = 校验最新；q = 退出' -ForegroundColor Gray
$choice = Read-Host '  请选择'

if ($choice -eq 'q' -or $choice -eq 'Q') { exit 0 }

if ($choice -eq 'v' -or $choice -eq 'V') {
  Write-Host ''
  $code = Invoke-NodeStream @('verify', 'latest')
  Read-Host '按回车退出' | Out-Null
  exit $code
}

$target = 'latest'
if ($choice -match '^\d+$') {
  $pick = [int]$choice
  if ($pick -lt 1 -or $pick -gt $snaps.Count) {
    Write-Host '  编号超出范围。' -ForegroundColor Red
    Read-Host '按回车退出' | Out-Null
    exit 1
  }
  $target = $snaps[$pick - 1].id
}

Write-Host ''
Write-Host "  即将恢复到：$($data.home)" -ForegroundColor Yellow
Write-Host '  · 当前状态会先自动做一次 pre-restore 快照'
Write-Host '  · 被覆盖的旧文件会另存到 restore-quarantine'
Write-Host '  · 恢复后需要重新启动 DeepSeek Harness'
Write-Host ''
if (-not $Yes) {
  $confirm = Read-Host '  确认恢复？(y/N)'
  if ($confirm -notmatch '^[yY]') { Write-Host '  已取消。'; Read-Host '按回车退出' | Out-Null; exit 0 }
}

Write-Host ''
Write-Host '  正在恢复…' -ForegroundColor Cyan
$code = Invoke-NodeStream @('restore', $target, '--yes')

Write-Host ''
if ($code -eq 0) {
  Write-Host '  恢复完成。请完全退出并重新启动 DeepSeek Harness。' -ForegroundColor Green
  Write-Host '  （如果 DSH 正在运行，请先退出，否则它的内存态会覆盖刚恢复的内容）' -ForegroundColor DarkGray
} else {
  Write-Host "  恢复未完全成功（退出码 $code），请查看上面的输出。" -ForegroundColor Red
}
Read-Host '按回车退出' | Out-Null
exit $code
