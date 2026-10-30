#Requires -Version 5.1
<#
.SYNOPSIS
  DSH 外部看门狗：弹一条 Windows 10/11 通知（WinRT ToastNotificationManager）。

.DESCRIPTION
  由 watchdog.mjs 在检测到事故时调用：
    powershell -NoProfile -ExecutionPolicy Bypass -File toast.ps1 -Title "..." -Body "..." -LogPath ...

  行为：
    1. 优先 WinRT toast（AppId 用 PowerShell 的通用 AUMID，无需注册应用）；
    2. WinRT 不可用（Server 版 / 被禁用）→ 退回 msg.exe；
    3. msg 也不可用 → 追加写日志（-LogPath），并返回 1 让看门狗记录通道失败。

  约束：不联网、不写 .dsh、不改注册表；只做“显示通知”一件事。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\toast.ps1 -Title "[DSH] 异常退出" -Body "15:32:10 检测到崩溃"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Body = '',
  [string]$LogPath = '',
  [int]$TimeoutSeconds = 0
)

$ErrorActionPreference = 'Stop'

function Write-FallbackLog([string]$reason) {
  if (-not $LogPath) { return $false }
  try {
    $dir = Split-Path -Parent $LogPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $line = '{0} [toast-fallback] {1} :: {2} :: {3}' -f ([DateTimeOffset]::Now.ToString('o')), $reason, $Title, $Body
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
    return $true
  } catch {
    return $false
  }
}

$title = ([string]$Title).Trim()
if (-not $title) { $title = 'DeepSeek Harness' }
$body = [string]$Body
if ($body.Length -gt 1200) { $body = $body.Substring(0, 1200) + '…' }

function Escape-Xml([string]$text) {
  if ($null -eq $text) { return '' }
  return [System.Security.SecurityElement]::Escape($text)
}

# ---------------------------------------------------------------- 1. WinRT toast
$toastShown = $false
$toastError = ''
try {
  # WinRT 类型在 Windows PowerShell 5.1 里必须显式加载；PowerShell 7 同样支持。
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

  $xmlText = @"
<toast duration="long">
  <visual>
    <binding template="ToastGeneric">
      <text>$([System.Security.SecurityElement]::Escape($title))</text>
      <text>$([System.Security.SecurityElement]::Escape($body))</text>
      <text placement="attribution">DeepSeek Recovery · 外部看门狗</text>
    </binding>
  </visual>
</toast>
"@

  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($xmlText)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  # PowerShell 的通用 AUMID：Win10/11 上无需注册应用即可弹 toast。
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
  $notifier.Show($toast)
  $toastShown = $true
} catch {
  $toastError = $_.Exception.GetType().Name
}

if ($toastShown) { exit 0 }

# --------------------------------------------------------------------- 2. msg.exe
$msgShown = $false
try {
  $msg = Join-Path $env:SystemRoot 'System32\msg.exe'
  if (-not (Test-Path -LiteralPath $msg)) {
    $cmd = Get-Command msg.exe -ErrorAction SilentlyContinue
    if ($cmd) { $msg = $cmd.Source }
  }
  if ($msg -and (Test-Path -LiteralPath $msg)) {
    $text = "$title`r`n$body"
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & $msg * /TIME:60 $text 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { $msgShown = $true }
    } finally {
      $ErrorActionPreference = $prev
    }
  }
} catch {
  $msgShown = $false
}

if ($msgShown) {
  [void](Write-FallbackLog 'msg')
  exit 0
}

# ------------------------------------------------------------------ 3. 写日志兜底
$logged = Write-FallbackLog ("toast-failed:$toastError")
[Console]::Error.WriteLine("toast: unavailable")
if ($logged) { exit 1 }
exit 1
