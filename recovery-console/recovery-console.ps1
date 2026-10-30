#Requires -Version 5.1
<#
.SYNOPSIS
  「Deepseek恢复」外部一键恢复控制台入口。
  桌面 / 开始菜单的「Deepseek恢复」快捷方式指向本文件；本文件只负责找 Node、
  调同目录的 console.mjs，并把参数原样透传。

.DESCRIPTION
  .dsh 整个丢失 / DSH 起不来时用这个入口：列出快照 → 选推荐恢复点 → 输入 YES →
  调自包含 CLI 恢复 → 重建 link: 插件 junction → 写报告 → 启动 DeepSeek Harness。

  依赖：Node.js >= 20（Program Files\nodejs\node.exe 或 PATH；也接受 DSH 自带 runtime）。
  不需要管理员权限（junction 用 cmd /c mklink /J，不需要提权）。
  本文件保持 %LOCALAPPDATA%\DeepSeek Recovery\scripts\recovery-console.ps1 路径不变。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\recovery-console.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\recovery-console.ps1 -List
  powershell -NoProfile -ExecutionPolicy Bypass -File .\recovery-console.ps1 -Yes -NoStart
  powershell -NoProfile -ExecutionPolicy Bypass -File .\recovery-console.ps1 -Yes -Repo E:\offsite\repo -PasswordEnv DSH_RECOVERY_PASSWORD

.NOTES
  参数映射（PowerShell 风格 → console.mjs）：
    -List -Verify -Yes -Auto -Force -DryRun -NoStart -Dpapi
    -Home X -Store X -Root X -Host X -Snapshot X -Repo X -Plugin X -Config X -Exe X
    -PasswordEnv X -DpapiFile X -RecoveryHome X
  其余 `--xxx` 参数原样透传。`-NoPause` 让窗口结束后不暂停（自动任务用）。
#>

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$console = Join-Path $scriptDir 'console.mjs'
$noPause = ($args -contains '-NoPause')

function Pause-IfInteractive {
  if ($noPause) { return }
  if ($Host.Name -ne 'ConsoleHost') { return }
  Write-Host ''
  Write-Host '按回车退出' -ForegroundColor DarkGray
  try { [void][Console]::ReadLine() } catch { Read-Host '按回车退出' | Out-Null }
}

function Find-Node {
  $candidates = @()
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe') }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  # DSH 自带 runtime 兜底（没有单独装 Node 的机器）
  $extra = @(
    'D:\DeepSeek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe',
    (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
  )
  foreach ($candidate in $extra) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  $runtimes = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
  if (Test-Path -LiteralPath $runtimes) {
    try {
      $found = Get-ChildItem -LiteralPath $runtimes -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($found) { return $found.FullName }
    } catch { }
  }
  return $null
}

# PowerShell 5.1 的默认控制台编码不是 UTF-8，node 的中文输出会乱码。
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch { }

try { $Host.UI.RawUI.WindowTitle = 'Deepseek 恢复' } catch { }

if (-not (Test-Path -LiteralPath $console)) {
  Write-Host "找不到 console.mjs：$console" -ForegroundColor Red
  Write-Host '外部恢复目录不完整，请重新运行 scripts\install-external.ps1 -Apply（或插件面板的「安装外部看门狗」）。' -ForegroundColor Yellow
  Pause-IfInteractive
  exit 1
}

$node = Find-Node
if (-not $node) {
  Write-Host '找不到 node.exe。' -ForegroundColor Red
  Write-Host '请安装 Node.js 20 或更新版本（https://nodejs.org/），或把 DeepSeek Harness 安装好（D:\DeepSeek）。' -ForegroundColor Yellow
  Write-Host '装好后重新双击「Deepseek恢复」。' -ForegroundColor Yellow
  Pause-IfInteractive
  exit 1
}

# Node >= 20 检查（只是提示，不拦；少数老版本跑不了 ESM 顶层特性）
try {
  $versionText = (& $node '--version' 2>$null) -join ''
  if ($versionText -match 'v(\d+)\.') {
    $major = [int]$Matches[1]
    if ($major -lt 20) {
      Write-Host "警告：Node 版本 $versionText 低于 20，可能无法运行。" -ForegroundColor Yellow
    }
  }
} catch { }

# PowerShell 风格开关 → console.mjs 的 --xxx / --key value
$map = @{
  '-List' = '--list'
  '-Verify' = '--verify'
  '-Yes' = '--yes'
  '-Auto' = '--auto'
  '-Force' = '--force'
  '-DryRun' = '--dry-run'
  '-NoStart' = '--no-start'
  '-Dpapi' = '--dpapi'
  '-Home' = '--home'
  '-Root' = '--root'
  '-Store' = '--store'
  '-Host' = '--host'
  '-Snapshot' = '--snapshot'
  '-Repo' = '--repo'
  '-Plugin' = '--plugin'
  '-Config' = '--config'
  '-Exe' = '--exe'
  '-PasswordEnv' = '--password-env'
  '-DpapiFile' = '--dpapi-file'
  '-RecoveryHome' = '--recovery-home'
  '-Help' = '--help'
}

$consoleArgs = @()
foreach ($item in $args) {
  if ($null -eq $item) { continue }
  $text = [string]$item
  if ($text -eq '-NoPause' -or $text -eq '--no-pause') { continue }
  if ($map.ContainsKey($text)) {
    $consoleArgs += $map[$text]
  } else {
    $consoleArgs += $text
  }
}

Push-Location -LiteralPath $scriptDir
$code = 1
try {
  & $node $console @consoleArgs
  if ($null -ne $LASTEXITCODE) { $code = $LASTEXITCODE } else { $code = 0 }
} catch {
  Write-Host "运行 console.mjs 失败：$($_.Exception.Message)" -ForegroundColor Red
  $code = 1
} finally {
  Pop-Location
}

if ($code -ne 0) {
  Write-Host ''
  Write-Host "退出码 $code（0 成功 / 1 用法·取消 / 2 校验失败或备份库不可用 / 3 恢复部分失败）" -ForegroundColor Yellow
}
Pause-IfInteractive
exit $code
