#Requires -Version 5.1
<#
.SYNOPSIS
  dsh-disaster-recovery 外部恢复区安装器 / 自愈器（默认 dry-run）。

.DESCRIPTION
  在 `%LOCALAPPDATA%\DeepSeek Recovery\`（必须在 .dsh 之外，DSH 全没了也能用）落三套东西：

    scripts\    <- recovery-console/ 全部内容（保持 scripts\recovery-console.ps1 路径，
                   现有桌面/开始菜单「Deepseek恢复」快捷方式就指向它）
    monitor\    <- watchdog/（watchdog.mjs / toast.ps1 / notify.ps1）+ dpapi.ps1 + config.json
    plugin\     <- 自包含灾备 CLI 副本（scripts\cli.mjs、scripts\recover.mjs、scripts\dpapi.ps1、
                   src\、package.json、locale\），供外部恢复控制台在 DSH 起不来时用

  然后：
    - 写/合并 monitor\config.json（保留已有阈值与通知配置，只补缺省键）；
    - 注册/修复用户级计划任务 `DSH-DisasterWatchdog`：每分钟
      `node <RECOVERY_HOME>\monitor\watchdog.mjs --once --config <...>\config.json`（无需管理员）；
    - 修复桌面/开始菜单「Deepseek恢复」快捷方式（目标 powershell.exe，
      参数指向 scripts\recovery-console.ps1，工作目录 RECOVERY_HOME）；
    - 旧的 `DSH-HomeTripwire.cmd` 启动项：先备份到 `<storeRoot>\manual\<ts>-home-tripwire-backup\`
      （含 manifest.json 与 sha256），再删除启动项；新看门狗取代它。

  安全约束：
    - 默认 dry-run，只有 -Apply 才写盘 / 装任务；-Quiet 供面板调用（stdout 只有一段 JSON）；
    - 幂等：可反复执行；不递归删除任何目录；绝不写/删 .dsh 内任何东西；
    - 不联网；不启动/重启 DSH；安装计划任务需要当前用户批准（面板会二次确认）。

.PARAMETER Apply
  真正执行复制/写配置/装任务/改快捷方式。不带就是 dry-run，只打印计划。

.PARAMETER Quiet
  不打印人类可读文本，stdout 只输出一行 JSON 摘要（面板用）。失败也输出 JSON。

.PARAMETER Source
  仓库根目录（默认本脚本上级目录）。测试可指向 fixture。

.PARAMETER RecoveryHome
  外部恢复区，默认 `%LOCALAPPDATA%\DeepSeek Recovery`（也可用 env DSH_RECOVERY_HOME）。

.PARAMETER StoreRoot
  灾备仓库根，默认 D:\dsh-backup；用于写 config.json 和 manual\ 备份目录。

.PARAMETER DshHome
  DSH 数据目录，默认 $env:DSH_HOME 或 %USERPROFILE%\.dsh（只写进配置，绝不改动）。

.PARAMETER NodePath
  node.exe 路径（默认自动探测：Get-Command node -> DSH 运行时 -> Program Files）。

.PARAMETER IntervalMinutes
  计划任务重复间隔（分钟），默认 1。

.PARAMETER NoTask / -NoShortcut / -SkipTripwire
  分别跳过计划任务 / 快捷方式 / 旧 tripwire 备份替换（测试用）。

.PARAMETER StartupDir / DesktopDir / StartMenuDir / ManualDir
  目录覆盖（测试用；默认是真实位置）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install-external.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install-external.ps1 -Apply
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install-external.ps1 -Apply -Quiet
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$Quiet,
  [string]$Source = '',
  [string]$RecoveryHome = '',
  [string]$StoreRoot = 'D:\dsh-backup',
  [string]$DshHome = '',
  [string]$NodePath = '',
  [int]$IntervalMinutes = 1,
  [string]$TaskName = 'DSH-DisasterWatchdog',
  [switch]$NoTask,
  [switch]$NoShortcut,
  [switch]$SkipTripwire,
  [switch]$SkipRecoveryConsole,
  [string]$StartupDir = '',
  [string]$DesktopDir = '',
  [string]$StartMenuDir = '',
  [string]$ManualDir = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# 面板会解析 stdout 的 JSON；Windows PowerShell 5.1 默认 OEM 编码会把中文路径写坏。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$script:mode = if ($Apply) { 'apply' } else { 'dry-run' }
$script:warnings = New-Object System.Collections.ArrayList
$script:errors = New-Object System.Collections.ArrayList

function Add-Warning([string]$Message) { [void]$script:warnings.Add($Message) }
function Add-Error([string]$Message) { [void]$script:errors.Add($Message) }

function Write-Human([string]$Message, [string]$Color = '') {
  if ($Quiet) { return }
  if ($Color) { Write-Host $Message -ForegroundColor $Color } else { Write-Host $Message }
}

function Get-UserHome {
  if ($env:USERPROFILE) { return $env:USERPROFILE }
  return [Environment]::GetFolderPath('UserProfile')
}

function Get-AppDataRoot {
  if ($env:APPDATA) { return $env:APPDATA }
  return (Join-Path (Get-UserHome) 'AppData\Roaming')
}

function Get-LocalAppDataRoot {
  if ($env:LOCALAPPDATA) { return $env:LOCALAPPDATA }
  return (Join-Path (Get-UserHome) 'AppData\Local')
}

function Resolve-FullPath([string]$PathValue, [string]$Base) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return '' }
  $expanded = [Environment]::ExpandEnvironmentVariables($PathValue)
  if ([System.IO.Path]::IsPathRooted($expanded)) { return [System.IO.Path]::GetFullPath($expanded) }
  return [System.IO.Path]::GetFullPath((Join-Path $Base $expanded))
}

function Test-IsInside([string]$Child, [string]$Parent) {
  if (-not $Child -or -not $Parent) { return $false }
  $c = [System.IO.Path]::GetFullPath($Child).TrimEnd('\', '/')
  $p = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  if ($c -ieq $p) { return $true }
  return $c.StartsWith($p + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or
    $c.StartsWith($p + '/', [System.StringComparison]::OrdinalIgnoreCase)
}

# ---------------------------------------------------------------- 路径与来源
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $Source) { $Source = Split-Path -Parent $scriptDir }
$Source = Resolve-FullPath $Source (Get-Location).Path
if (-not $RecoveryHome) {
  if ($env:DSH_RECOVERY_HOME) { $RecoveryHome = $env:DSH_RECOVERY_HOME }
  else { $RecoveryHome = Join-Path (Get-LocalAppDataRoot) 'DeepSeek Recovery' }
}
$RecoveryHome = Resolve-FullPath $RecoveryHome (Get-Location).Path
if (-not $DshHome) {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path (Get-UserHome) '.dsh' }
}
$DshHome = Resolve-FullPath $DshHome (Get-Location).Path
if (-not $StartupDir) { $StartupDir = Join-Path (Get-AppDataRoot) 'Microsoft\Windows\Start Menu\Programs\Startup' }
$StartupDir = Resolve-FullPath $StartupDir (Get-Location).Path
if (-not $DesktopDir) { $DesktopDir = [Environment]::GetFolderPath('Desktop') }
$DesktopDir = Resolve-FullPath $DesktopDir (Get-Location).Path
if (-not $StartMenuDir) { $StartMenuDir = Join-Path (Get-AppDataRoot) 'Microsoft\Windows\Start Menu\Programs' }
$StartMenuDir = Resolve-FullPath $StartMenuDir (Get-Location).Path
$StoreRoot = Resolve-FullPath $StoreRoot (Get-Location).Path
if (-not $ManualDir) { $ManualDir = Join-Path $StoreRoot 'manual' }
$ManualDir = Resolve-FullPath $ManualDir (Get-Location).Path

$recoveryConsoleDir = Join-Path $Source 'recovery-console'
$watchdogSourceDir = Join-Path $Source 'watchdog'
$scriptsTargetDir = Join-Path $RecoveryHome 'scripts'
$monitorTargetDir = Join-Path $RecoveryHome 'monitor'
$pluginTargetDir = Join-Path $RecoveryHome 'plugin'
$configPath = Join-Path $monitorTargetDir 'config.json'
$watchdogTarget = Join-Path $monitorTargetDir 'watchdog.mjs'
$consoleTarget = Join-Path $scriptsTargetDir 'recovery-console.ps1'
$statePath = Join-Path $monitorTargetDir 'install-state.json'
$versionPath = Join-Path $RecoveryHome 'version.json'
$startMenuShortcut = Join-Path $StartMenuDir 'Deepseek恢复.lnk'
$desktopShortcut = Join-Path $DesktopDir 'Deepseek恢复.lnk'
$tripwirePath = Join-Path $StartupDir 'DSH-HomeTripwire.cmd'

# ---------------------------------------------------------------- 安全护栏
if (-not (Test-Path -LiteralPath (Join-Path $Source 'package.json'))) {
  Add-Error "源码目录不对（缺 package.json）：$Source"
}
if (Test-IsInside $RecoveryHome $DshHome) {
  Add-Error "外部恢复区不能放在 .dsh 内：$RecoveryHome（这是硬性安全约束）"
}
if (Test-IsInside $Source $RecoveryHome) {
  Add-Error "源码目录不能位于外部恢复区内：$Source"
}
if ($IntervalMinutes -lt 1 -or $IntervalMinutes -gt 1440) { Add-Error "IntervalMinutes 必须在 1..1440：$IntervalMinutes" }

# ---------------------------------------------------------------- node 探测
function Find-NodePath {
  param([string]$Explicit)
  if ($Explicit -and (Test-Path -LiteralPath $Explicit)) { return [System.IO.Path]::GetFullPath($Explicit) }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  $candidates = @(
    'D:\DeepSeek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe',
    (Join-Path (Get-UserHome) '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'),
    'C:\Program Files\nodejs\node.exe',
    'C:\Program Files (x86)\nodejs\node.exe'
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

$nodeExe = Find-NodePath -Explicit $NodePath
if (-not $nodeExe) {
  Add-Warning '未找到 node.exe：计划任务会指向 "node"，请确认 PATH 里有 Node.js（或重装时用 -NodePath 指定）'
  if ($NodePath) { Add-Warning "指定的 -NodePath 不存在：$NodePath" }
}

# ---------------------------------------------------------------- 版本/图标
function Get-SourceVersion {
  try {
    $pkg = Get-Content -LiteralPath (Join-Path $Source 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($pkg.version) { return [string]$pkg.version }
  } catch { }
  return ''
}

function Get-WatchdogVersion {
  $main = Join-Path $watchdogSourceDir 'watchdog.mjs'
  if (Test-Path -LiteralPath $main) {
    $match = Select-String -LiteralPath $main -Pattern "WATCHDOG_VERSION = '([^']+)'" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($match) { return [string]$match.Matches[0].Groups[1].Value }
  }
  return ''
}

function Find-DshIconPath {
  $candidates = @()
  $startMenuRoot = Join-Path (Get-AppDataRoot) 'Microsoft\Windows\Start Menu\Programs'
  $dshLnk = Join-Path $startMenuRoot 'DeepSeek Harness.lnk'
  if (Test-Path -LiteralPath $dshLnk) {
    try {
      $shell = New-Object -ComObject WScript.Shell
      $target = $shell.CreateShortcut($dshLnk).TargetPath
      if ($target) { $candidates += $target }
    } catch { }
  }
  $candidates += 'D:\DeepSeek\DeepSeek Harness.exe'
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

$sourceVersion = Get-SourceVersion
$watchdogVersion = Get-WatchdogVersion
$dshExe = Find-DshIconPath
$iconLocation = if ($dshExe) { "$dshExe,0" } else { '' }
$hostname = ''

# ---------------------------------------------------------------- 复制计划
$copied = [ordered]@{
  scripts = New-Object System.Collections.ArrayList
  monitor = New-Object System.Collections.ArrayList
  plugin = New-Object System.Collections.ArrayList
}

function Add-Copied([string]$Key, [string]$Relative) {
  $list = $copied[$Key]
  $normalized = $Relative -replace '\\', '/'
  if ($list.Count -lt 400) { [void]$list.Add($normalized) }
}

# 不用 Get-FileHash：某些环境里 PSModulePath 被 PowerShell 7 的模块目录抢占，
# Windows PowerShell 5.1 会解析不到 Get-FileHash（CommandNotFoundException）。
# 纯 .NET 实现，不依赖任何模块。
function Get-FileSha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = $sha.ComputeHash($stream)
      return ([System.BitConverter]::ToString($bytes) -replace '-', '')
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Ensure-ParentDir([string]$FilePath) {
  $dir = Split-Path -Parent $FilePath
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}

function Copy-Tree([string]$From, [string]$To, [string]$Key, [string]$Prefix = '') {
  if (-not (Test-Path -LiteralPath $From)) { return }
  $files = @(Get-ChildItem -LiteralPath $From -Recurse -File -Force -ErrorAction SilentlyContinue)
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($From.Length).TrimStart('\', '/')
    if ($Prefix) { Add-Copied $Key ($Prefix + $relative) } else { Add-Copied $Key $relative }
    if (-not $Apply) { continue }
    $dest = Join-Path $To $relative
    Ensure-ParentDir $dest
    Copy-Item -LiteralPath $file.FullName -Destination $dest -Force
  }
}

function Copy-Single([string]$From, [string]$To, [string]$Key, [string]$Relative) {
  if (-not (Test-Path -LiteralPath $From)) {
    Add-Warning "缺少源文件：$From"
    return
  }
  Add-Copied $Key $Relative
  if (-not $Apply) { return }
  Ensure-ParentDir $To
  Copy-Item -LiteralPath $From -Destination $To -Force
}

# scripts\ <- recovery-console/（保持 recovery-console.ps1 路径）
$recoveryConsolePresent = Test-Path -LiteralPath (Join-Path $recoveryConsoleDir 'recovery-console.ps1')
if ($SkipRecoveryConsole) {
  Add-Warning '已按 -SkipRecoveryConsole 跳过 scripts\ 复制'
} elseif (-not $recoveryConsolePresent) {
  Add-Warning "recovery-console/ 未就位（缺 recovery-console.ps1）：本次不复制外部恢复控制台；等 console 队友产出后重跑 -Apply 即可自愈"
} else {
  Copy-Tree $recoveryConsoleDir $scriptsTargetDir 'scripts'
}

# monitor\ <- watchdog/ + dpapi.ps1
Copy-Tree $watchdogSourceDir $monitorTargetDir 'monitor'
Copy-Single (Join-Path $Source 'scripts\dpapi.ps1') (Join-Path $monitorTargetDir 'dpapi.ps1') 'monitor' 'dpapi.ps1'

# plugin\ <- 自包含灾备 CLI 副本
Copy-Single (Join-Path $Source 'scripts\cli.mjs') (Join-Path $pluginTargetDir 'scripts\cli.mjs') 'plugin' 'scripts/cli.mjs'
Copy-Single (Join-Path $Source 'scripts\recover.mjs') (Join-Path $pluginTargetDir 'scripts\recover.mjs') 'plugin' 'scripts/recover.mjs'
Copy-Single (Join-Path $Source 'scripts\dpapi.ps1') (Join-Path $pluginTargetDir 'scripts\dpapi.ps1') 'plugin' 'scripts/dpapi.ps1'
Copy-Single (Join-Path $Source 'package.json') (Join-Path $pluginTargetDir 'package.json') 'plugin' 'package.json'
Copy-Tree (Join-Path $Source 'src') (Join-Path $pluginTargetDir 'src') 'plugin' 'src/'
Copy-Tree (Join-Path $Source 'locale') (Join-Path $pluginTargetDir 'locale') 'plugin' 'locale/'

# ---------------------------------------------------------------- config.json
function Merge-JsonDefaults {
  param($Existing, $Defaults)
  if ($null -eq $Defaults) { return $Existing }
  if ($null -eq $Existing) { return $Defaults }
  if ($Existing -is [array]) { return $Existing }
  $defaultsIsMap = ($Defaults -is [System.Collections.IDictionary]) -or ($Defaults -is [pscustomobject])
  if (-not $defaultsIsMap) { return $Existing }
  $map = [ordered]@{}
  if ($Existing -is [System.Collections.IDictionary]) {
    foreach ($key in $Existing.Keys) { $map[[string]$key] = $Existing[$key] }
  } elseif ($Existing -is [pscustomobject]) {
    foreach ($prop in $Existing.PSObject.Properties) { $map[$prop.Name] = $prop.Value }
  } else {
    return $Existing
  }
  if ($Defaults -is [System.Collections.IDictionary]) {
    foreach ($key in $Defaults.Keys) {
      if ($map.Contains([string]$key)) { $map[[string]$key] = Merge-JsonDefaults $map[[string]$key] $Defaults[$key] }
      else { $map[[string]$key] = $Defaults[$key] }
    }
  } else {
    foreach ($prop in $Defaults.PSObject.Properties) {
      if ($map.Contains($prop.Name)) { $map[$prop.Name] = Merge-JsonDefaults $map[$prop.Name] $prop.Value }
      else { $map[$prop.Name] = $prop.Value }
    }
  }
  return $map
}

$configDefaults = [ordered]@{
  v = 1
  storeRoot = $StoreRoot
  home = $DshHome
  hostname = $env:COMPUTERNAME
  process = [ordered]@{ name = 'DeepSeek Harness.exe'; queryTimeoutMs = 8000 }
  thresholds = [ordered]@{
    heartbeatStaleMs = 120000
    hangStaleMs = 180000
    sleepGraceMs = 180000
    crashLookbackMs = 86400000
    eventLookbackMs = 86400000
    dataLossMinFiles = 50
    dataLossRatio = 0.05
    dataLossSessionsRatio = 0.25
    diskLowFreeBytes = 10737418240
    offsiteStaleMs = 172800000
    dedupeMs = 1800000
    baselineMinIntervalMs = 86400000
    retentionDays = 90
    logMaxBytes = 10485760
    lockStaleMs = 120000
    deepVerifyEveryMs = 3600000
    quickVerifySnapshots = 2
    alertMaxAgeDays = 7
  }
  notify = [ordered]@{
    panel = $true
    toast = $true
    toastTimeoutMs = 20000
    retries = 2
    outboxMaxAttempts = 12
    webhook = @()
    email = [ordered]@{ enabled = $false; host = ''; port = 587; useSsl = $true; user = ''; from = ''; to = @() }
    qq = [ordered]@{ enabled = $false; http = ''; token = ''; action = 'send_private_msg'; target = '' }
    peer = [ordered]@{ enabled = $false }
  }
  excludes = @('dsh-runtimes')
  installedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

$existingConfig = $null
$configPresent = Test-Path -LiteralPath $configPath
if ($configPresent) {
  try { $existingConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch {
    Add-Warning "现有 config.json 不是合法 JSON，将备份后重建：$configPath"
    if ($Apply) {
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      Copy-Item -LiteralPath $configPath -Destination "$configPath.bad-$stamp" -Force
      $existingConfig = $null
    }
  }
  $configAction = if ($null -eq $existingConfig) { 'rebuild' } else { 'merge' }
} else {
  $configAction = 'create'
}
$mergedConfig = Merge-JsonDefaults $existingConfig $configDefaults
# 关键路径项每次都以参数为准（保留用户对阈值/通知的修改，但路径跟随安装参数）
if ($null -eq $mergedConfig.storeRoot -or -not $mergedConfig.storeRoot) { $mergedConfig['storeRoot'] = $StoreRoot }
if ($null -eq $mergedConfig.home -or -not $mergedConfig.home) { $mergedConfig['home'] = $DshHome }
if ($null -eq $mergedConfig.hostname -or -not $mergedConfig.hostname) { $mergedConfig['hostname'] = $env:COMPUTERNAME }
if ($Apply) {
  New-Item -ItemType Directory -Force -Path $monitorTargetDir | Out-Null
  $jsonText = ($mergedConfig | ConvertTo-Json -Depth 12) + "`n"
  [System.IO.File]::WriteAllText($configPath, $jsonText, (New-Object System.Text.UTF8Encoding($false)))
}

# ---------------------------------------------------------------- 计划任务
# 用 wscript.exe 调隐藏启动器，避免每分钟弹出 node 控制台窗口。
$hiddenLauncher = Join-Path $monitorTargetDir 'run-hidden.vbs'
$wscriptExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $wscriptExe)) { $wscriptExe = 'wscript.exe' }
$taskArgument = '//nologo "{0}"' -f $hiddenLauncher
$taskExecutable = $wscriptExe
$taskPlan = [ordered]@{
  name = $TaskName
  action = 'unknown'
  execute = $taskExecutable
  arguments = $taskArgument
  workingDirectory = $monitorTargetDir
  hidden = $true
  trigger = [ordered]@{ everyMinutes = $IntervalMinutes; at = 'now+1min'; startWhenAvailable = $true }
  registered = $false
  previous = $null
  error = $null
}

function Get-ExistingTaskInfo {
  param([string]$Name)
  $info = @{ exists = $false; execute = ''; arguments = '' }
  $cmd = Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue
  if (-not $cmd) { return $info }
  try {
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction Stop
    if ($task) {
      $info.exists = $true
      if ($task.Actions -and $task.Actions.Count -gt 0) {
        $info.execute = [string]$task.Actions[0].Execute
        $info.arguments = [string]$task.Actions[0].Arguments
      }
    }
  } catch { }
  return $info
}

function Register-WatchdogTaskInternal {
  param([string]$Name, [string]$Execute, [string]$Argument, [string]$WorkingDirectory, [int]$Minutes)
  $registerError = ''
  $cmd = Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue
  if ($cmd) {
    try {
      $action = New-ScheduledTaskAction -Execute $Execute -Argument $Argument -WorkingDirectory $WorkingDirectory
      $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) `
        -RepetitionInterval (New-TimeSpan -Minutes $Minutes) -RepetitionDuration ([TimeSpan]::MaxValue)
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
      $user = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
      $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
      Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings `
        -Principal $principal -Force `
        -Description 'DSH 外部看门狗：每分钟检查崩溃/卡死/数据骤降并通知（只记录+通知，不自动重启 DSH）' | Out-Null
      return @{ ok = $true; method = 'Register-ScheduledTask'; error = '' }
    } catch {
      $registerError = $_.Exception.Message
    }
  }
  # 退路：schtasks（同样只需当前用户权限，/RL LIMITED 不提权）
  $trip = '"{0}" {1}' -f $Execute, $Argument
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $code = -1
  try {
    & schtasks.exe /Create /TN $Name /TR $trip /SC MINUTE /MO $Minutes /F /RL LIMITED 2>$null | Out-Null
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($code -eq 0) { return @{ ok = $true; method = 'schtasks'; error = '' } }
  return @{ ok = $false; method = 'none'; error = if ($registerError) { $registerError } else { "schtasks exit $code" } }
}

if ($NoTask) {
  $taskPlan.action = 'skipped'
} else {
  $existingTask = Get-ExistingTaskInfo -Name $TaskName
  if ($existingTask.exists) {
    $taskPlan.previous = [ordered]@{ execute = $existingTask.execute; arguments = $existingTask.arguments }
    $taskPlan.action = 'update'
  } else {
    $taskPlan.action = 'register'
  }
  if ($Apply) {
    $registration = Register-WatchdogTaskInternal -Name $TaskName -Execute $taskExecutable `
      -Argument $taskArgument -WorkingDirectory $monitorTargetDir -Minutes $IntervalMinutes
    $taskPlan.registered = [bool]$registration.ok
    $taskPlan.error = if ($registration.ok) { $null } else { $registration.error }
    if (-not $registration.ok) {
      Add-Error "计划任务注册失败（可能需要用户批准）：$($registration.error)"
      $taskPlan.action = 'failed'
    } else {
      $taskPlan.method = $registration.method
    }
  } else {
    $taskPlan.registered = $false
  }
}

# ---------------------------------------------------------------- 快捷方式
$shortcutPlans = New-Object System.Collections.ArrayList
if ($NoShortcut) {
  Add-Warning '已按 -NoShortcut 跳过快捷方式修复'
} else {
  $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $consoleArgument = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $consoleTarget
  # 快捷方式目标是否“会有”：已装过，或本次会从 recovery-console/ 复制过去（dry-run 也算）。
  $consolePlanned = (-not $SkipRecoveryConsole) -and $recoveryConsolePresent
  $consoleAvailable = (Test-Path -LiteralPath $consoleTarget) -or $consolePlanned
  if (-not $consoleAvailable) {
    Add-Warning "scripts\recovery-console.ps1 尚未就位，快捷方式会指向该路径（等 console 就位后重跑即可）：$consoleTarget"
  }
  foreach ($shortcutPath in @($startMenuShortcut, $desktopShortcut)) {
    if (-not $shortcutPath) { continue }
    $plan = [ordered]@{
      path = $shortcutPath
      action = if (Test-Path -LiteralPath $shortcutPath) { 'repair' } else { 'create' }
      target = $powershellExe
      arguments = $consoleArgument
      workingDirectory = $RecoveryHome
      iconLocation = $iconLocation
      error = $null
    }
    if ($Apply) {
      try {
        Ensure-ParentDir $shortcutPath
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $powershellExe
        $shortcut.Arguments = $consoleArgument
        $shortcut.WorkingDirectory = $RecoveryHome
        $shortcut.Description = 'Deepseek 恢复：从灾备快照恢复 DSH 数据（DSH 起不来时用）'
        $shortcut.WindowStyle = 1
        if ($iconLocation) { $shortcut.IconLocation = $iconLocation }
        $shortcut.Save()
      } catch {
        $plan.error = $_.Exception.Message
        Add-Warning "快捷方式写入失败：$shortcutPath（$($_.Exception.Message)）"
      }
    }
    [void]$shortcutPlans.Add($plan)
  }
}

# ---------------------------------------------------- 旧 DSH-HomeTripwire.cmd
$tripwirePlan = [ordered]@{
  found = $false
  path = $tripwirePath
  backupDir = ''
  copied = $false
  removed = $false
  sha256 = ''
  reason = ''
}
if ($SkipTripwire) {
  $tripwirePlan.reason = 'skipped-by-flag'
} elseif (Test-Path -LiteralPath $tripwirePath) {
  $tripwirePlan.found = $true
  try { $tripwirePlan.sha256 = Get-FileSha256 $tripwirePath } catch { }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $tripwirePlan.backupDir = Join-Path $ManualDir "$stamp-home-tripwire-backup"
  if ($Apply) {
    try {
      New-Item -ItemType Directory -Force -Path $tripwirePlan.backupDir | Out-Null
      $backupFile = Join-Path $tripwirePlan.backupDir 'DSH-HomeTripwire.cmd'
      Copy-Item -LiteralPath $tripwirePath -Destination $backupFile -Force
      $manifest = [ordered]@{
        v = 1
        original = $tripwirePath
        backup = $backupFile
        sha256 = $tripwirePlan.sha256
        copiedAt = [DateTimeOffset]::UtcNow.ToString('o')
        reason = '旧 tripwire 启动项路径乱码、实际未运行；由 DSH-DisasterWatchdog 看门狗取代（只记录+通知，不自动重启）'
      }
      [System.IO.File]::WriteAllText(
        (Join-Path $tripwirePlan.backupDir 'manifest.json'),
        (($manifest | ConvertTo-Json -Depth 6) + "`n"),
        (New-Object System.Text.UTF8Encoding($false))
      )
      $tripwirePlan.copied = $true
      # 只删除这一个文件（不递归），且已在备份之后
      Remove-Item -LiteralPath $tripwirePath -Force
      $tripwirePlan.removed = $true
    } catch {
      $tripwirePlan.reason = $_.Exception.Message
      Add-Warning "旧 tripwire 备份/替换失败：$($_.Exception.Message)"
    }
  }
} else {
  $tripwirePlan.reason = 'not-found'
}

# ---------------------------------------------------------------- version/state
$installedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$versionPayload = [ordered]@{
  v = 1
  packageVersion = $sourceVersion
  watchdogVersion = $watchdogVersion
  installedAt = $installedAt
  mode = $script:mode
  source = $Source
  recoveryHome = $RecoveryHome
  storeRoot = $StoreRoot
  hostname = $env:COMPUTERNAME
  taskName = $TaskName
  node = $taskExecutable
}
if ($Apply) {
  try {
    New-Item -ItemType Directory -Force -Path $RecoveryHome | Out-Null
    [System.IO.File]::WriteAllText($versionPath, (($versionPayload | ConvertTo-Json -Depth 8) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    $statePayload = [ordered]@{
      v = 1
      installedAt = $installedAt
      lastApplyAt = $installedAt
      task = $taskPlan
      config = [ordered]@{ path = $configPath; action = $configAction }
      backup = [ordered]@{ tripwire = $tripwirePlan }
      version = $versionPayload
    }
    [System.IO.File]::WriteAllText($statePath, (($statePayload | ConvertTo-Json -Depth 10) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    Add-Warning "version/state 写入失败：$($_.Exception.Message)"
  }
}

# ---------------------------------------------------------------- 摘要
$ok = ($script:errors.Count -eq 0)
$summary = [ordered]@{
  v = 1
  ok = $ok
  mode = $script:mode
  generatedAt = [DateTimeOffset]::Now.ToString('o')
  source = $Source
  recoveryHome = $RecoveryHome
  storeRoot = $StoreRoot
  dshHome = $DshHome
  hostname = $env:COMPUTERNAME
  node = $taskExecutable
  packageVersion = $sourceVersion
  watchdogVersion = $watchdogVersion
  copied = [ordered]@{
    scripts = @($copied.scripts)
    monitor = @($copied.monitor)
    plugin = @($copied.plugin)
    counts = [ordered]@{
      scripts = $copied.scripts.Count
      monitor = $copied.monitor.Count
      plugin = $copied.plugin.Count
    }
  }
  config = [ordered]@{
    path = $configPath
    action = $configAction
    present = $configPresent
    secretsPath = (Join-Path $monitorTargetDir 'secrets.dpapi')
    secretsPresent = (Test-Path -LiteralPath (Join-Path $monitorTargetDir 'secrets.dpapi'))
  }
  task = $taskPlan
  shortcuts = @($shortcutPlans)
  backup = [ordered]@{ tripwire = $tripwirePlan }
  versionFile = $versionPath
  warnings = @($script:warnings)
  errors = @($script:errors)
}

if (-not $Quiet) {
  Write-Human ''
  Write-Human '  dsh-disaster-recovery 外部恢复区安装器' 'Cyan'
  Write-Human ("  模式        : {0}" -f $script:mode)
  Write-Human ("  源码        : {0}" -f $Source)
  Write-Human ("  恢复区      : {0}" -f $RecoveryHome)
  Write-Human ("  备份仓库    : {0}" -f $StoreRoot)
  Write-Human ("  数据目录    : {0}" -f $DshHome)
  Write-Human ("  node        : {0}" -f $taskExecutable)
  Write-Human ("  复制        : scripts {0} / monitor {1} / plugin {2} 个文件" -f $copied.scripts.Count, $copied.monitor.Count, $copied.plugin.Count)
  Write-Human ("  配置        : {0} -> {1}" -f $configAction, $configPath)
  Write-Human ("  计划任务    : {0} ({1} 每分钟)" -f $taskPlan.action, $TaskName)
  Write-Human ("    命令      : `"{0}`" {1}" -f $taskPlan.execute, $taskPlan.arguments)
  Write-Human ("  快捷方式    : {0}" -f (($shortcutPlans | ForEach-Object { "$($_.action): $($_.path)" }) -join '; '))
  Write-Human ("  旧 tripwire : found={0} copied={1} removed={2} {3}" -f $tripwirePlan.found, $tripwirePlan.copied, $tripwirePlan.removed, $tripwirePlan.reason)
  if ($script:warnings.Count) { Write-Human ("  提示        : " + ($script:warnings -join ' | ')) 'Yellow' }
  if ($script:errors.Count) { Write-Human ("  错误        : " + ($script:errors -join ' | ')) 'Red' }
  if (-not $Apply) {
    Write-Human ''
    Write-Human '  DRY-RUN：没有写任何文件、没有装计划任务。确认后加 -Apply。' 'Yellow'
  }
  Write-Human ''
}

$json = $summary | ConvertTo-Json -Depth 12 -Compress
[Console]::Out.Write($json + "`n")
if (-not $ok) { exit 1 }
exit 0
