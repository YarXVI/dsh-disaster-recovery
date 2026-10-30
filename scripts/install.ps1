#Requires -Version 5.1
<#
.SYNOPSIS
  把 dsh-disaster-recovery 装进 DSH profile，并创建开始菜单恢复入口。
.DESCRIPTION
  1. 备份 package.json
  2. 复制插件到 profiles\<profile>\plugins\dsh-disaster-recovery
  3. 建 node_modules junction，package.json 接线（dependencies + bundles）
  4. 把「不依赖 DSH」的恢复工具复制到 %LOCALAPPDATA%\DeepSeek Recovery
     （必须在 .dsh 之外 —— 否则 .dsh 被清空时连恢复入口一起没了）
  5. 在开始菜单创建「Deepseek恢复」快捷方式，图标与 DeepSeek Harness 相同
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Apply
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Apply -NoShortcut
#>
param(
  [string]$Profile = "",
  [string]$DshHome = "",
  [string]$Source = "",
  [string]$AppDir = "",
  [switch]$Apply,
  [switch]$NoShortcut
)

$ErrorActionPreference = 'Stop'

if (-not $Profile) { if ($env:DSH_PROFILE) { $Profile = $env:DSH_PROFILE } else { $Profile = "desktop" } }
if (-not $DshHome) { if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $HOME ".dsh" } }
if (-not $Source) {
  $Source = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
  if (-not (Test-Path (Join-Path $Source 'package.json'))) { $Source = (Get-Location).Path }
}
if (-not $AppDir) { $AppDir = Join-Path $env:LOCALAPPDATA 'DeepSeek Recovery' }

$pluginName = 'dsh-disaster-recovery'
$profileDir = Join-Path $DshHome "profiles\$Profile"
$target = Join-Path $profileDir "plugins\$pluginName"
$packageJson = Join-Path $profileDir 'package.json'
$link = Join-Path $profileDir "node_modules\$pluginName"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcutPath = Join-Path $startMenu 'Deepseek恢复.lnk'

Write-Host "source   : $Source"
Write-Host "profile  : $profileDir"
Write-Host "plugin   : $target"
Write-Host "app dir  : $AppDir"
Write-Host "shortcut : $shortcutPath"
Write-Host "mode     : $(if ($Apply) { 'APPLY' } else { 'DRY-RUN' })"

if (-not (Test-Path (Join-Path $Source 'package.json'))) { throw "源码目录不对（缺 package.json）: $Source" }
if (-not (Test-Path $profileDir)) { throw "profile 不存在: $profileDir" }

if (-not $Apply) {
  Write-Host ""
  Write-Host "DRY-RUN 结束。确认后加 -Apply。"
  return
}

# ---------------------------------------------------------------- 1. profile
if (Test-Path $packageJson) {
  Copy-Item $packageJson "$packageJson.bak-backup-plugin-$stamp" -Force
  Write-Host "backup   : package.json.bak-backup-plugin-$stamp"
}

New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
if (Test-Path $target) { Move-Item -LiteralPath $target -Destination "$target.bak-$stamp" -Force }
Copy-Item -LiteralPath $Source -Destination $target -Recurse -Force
Write-Host "copied   : $pluginName"

New-Item -ItemType Directory -Force (Split-Path $link) | Out-Null
if (Test-Path $link) { Remove-Item -LiteralPath $link -Force }
New-Item -ItemType Junction -Path $link -Target $target | Out-Null
Write-Host "junction : $link"

$json = Get-Content $packageJson -Raw -Encoding UTF8 | ConvertFrom-Json
$deps = [ordered]@{}
if ($json.PSObject.Properties.Name -contains 'dependencies' -and $json.dependencies) {
  foreach ($prop in $json.dependencies.PSObject.Properties) { $deps[$prop.Name] = $prop.Value }
}
$deps[$pluginName] = "link:./plugins/$pluginName"
$bundles = @()
if ($json.dsh -and $json.dsh.profile -and $json.dsh.profile.bundles) { $bundles = @($json.dsh.profile.bundles) }
if ($bundles -notcontains $pluginName) { $bundles += $pluginName }
if (-not ($json.PSObject.Properties.Name -contains 'dsh') -or -not $json.dsh) {
  $json | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force
}
if (-not ($json.dsh.PSObject.Properties.Name -contains 'profile') -or -not $json.dsh.profile) {
  $json.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force
}
$json | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]$deps) -Force
$json.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
[IO.File]::WriteAllText($packageJson, (($json | ConvertTo-Json -Depth 20) + "`n"), (New-Object Text.UTF8Encoding($false)))
Write-Host "wired    : package.json"

# ------------------------------------------------------- 2. 独立恢复工具目录
# 只放恢复必需的文件：src/ + scripts/cli.mjs + 控制台脚本。放在 .dsh 之外。
if (-not (Test-Path $AppDir)) { New-Item -ItemType Directory -Force $AppDir | Out-Null }
New-Item -ItemType Directory -Force (Join-Path $AppDir 'scripts') | Out-Null

Copy-Item (Join-Path $Source 'package.json') (Join-Path $AppDir 'package.json') -Force
Copy-Item (Join-Path $Source 'README.md') (Join-Path $AppDir 'README.md') -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $Source 'src') (Join-Path $AppDir 'src') -Recurse -Force
foreach ($name in @('cli.mjs', 'recovery-console.ps1', 'restore.ps1', 'restore.cmd', 'list.cmd')) {
  $from = Join-Path $Source "scripts\$name"
  if (Test-Path $from) { Copy-Item $from (Join-Path $AppDir "scripts\$name") -Force }
}
Write-Host "appdir   : 恢复工具已复制到 $AppDir"

# ------------------------------------------------------------------ 3. 图标
function Find-DshIcon {
  $candidates = @()
  $dshLnk = Join-Path $startMenu 'DeepSeek Harness.lnk'
  if (Test-Path -LiteralPath $dshLnk) {
    try {
      $shell = New-Object -ComObject WScript.Shell
      $targetPath = $shell.CreateShortcut($dshLnk).TargetPath
      if ($targetPath) { $candidates += $targetPath }
    } catch { }
  }
  $candidates += 'D:\DeepSeek\DeepSeek Harness.exe'
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
    if (-not $root) { continue }
    $found = Get-ChildItem -LiteralPath $root -Recurse -Depth 3 -Filter 'DeepSeek Harness.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $candidates += $found.FullName }
  }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

$dshExe = Find-DshIcon
if ($dshExe) {
  $iconLocation = "$dshExe,0"
  Write-Host "icon     : $iconLocation"
} else {
  # 退路：把 DSH 资源里的 tray.ico 复制出来当图标
  $trayIco = 'D:\DeepSeek\resources\tray.ico'
  if (Test-Path -LiteralPath $trayIco) {
    Copy-Item $trayIco (Join-Path $AppDir 'icon.ico') -Force
    $iconLocation = (Join-Path $AppDir 'icon.ico') + ',0'
    Write-Host "icon     : $iconLocation (fallback tray.ico)"
  } else {
    $iconLocation = ''
    Write-Host "icon     : 未找到 DSH 图标，使用系统默认图标" -ForegroundColor Yellow
  }
}

# -------------------------------------------------------------- 4. 开始菜单
if ($NoShortcut) {
  Write-Host "shortcut : 已按 -NoShortcut 跳过"
} else {
  $consoleScript = Join-Path $AppDir 'scripts\recovery-console.ps1'
  if (-not (Test-Path -LiteralPath $consoleScript)) { throw "恢复控制台脚本缺失: $consoleScript" }

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$consoleScript`""
  $shortcut.WorkingDirectory = $AppDir
  $shortcut.Description = 'Deepseek 恢复：从灾备快照恢复 DSH 数据'
  $shortcut.WindowStyle = 1
  if ($iconLocation) { $shortcut.IconLocation = $iconLocation }
  $shortcut.Save()

  if (Test-Path -LiteralPath $shortcutPath) {
    Write-Host "shortcut : 已创建 $shortcutPath"
  } else {
    Write-Warning "开始菜单快捷方式创建失败：$shortcutPath"
  }

  # 桌面快捷方式：Windows 11 的「所有应用」列表只在登录时重建，
  # 刚装完的开始菜单项本次登录可能看不到，桌面这条是立即可用的入口。
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ($desktop) {
    $desktopLnk = Join-Path $desktop 'Deepseek恢复.lnk'
    try {
      $desktopShortcut = $shell.CreateShortcut($desktopLnk)
      $desktopShortcut.TargetPath = $shortcut.TargetPath
      $desktopShortcut.Arguments = $shortcut.Arguments
      $desktopShortcut.WorkingDirectory = $AppDir
      $desktopShortcut.Description = 'Deepseek 恢复：从灾备快照恢复 DSH 数据'
      if ($iconLocation) { $desktopShortcut.IconLocation = $iconLocation }
      $desktopShortcut.Save()
      Write-Host "desktop  : 已创建 $desktopLnk"
    } catch {
      Write-Warning "桌面快捷方式创建失败：$($_.Exception.Message)"
    }
  }
}

Write-Host ""
Write-Host "下一步："
Write-Host "  1. 完全退出并重启 DeepSeek Harness（或等它热加载），左侧栏会出现「灾备」。"
Write-Host "  2. 首次启动会在 D:\dsh-backup 下建库并立刻做一次基线快照。"
Write-Host "  3. DSH 起不来时：双击桌面「Deepseek恢复」，或开始菜单「所有应用」里的同名条目"
Write-Host "     （Windows 11 的开始菜单列表在登录时重建，刚装完需注销/重启一次才会出现）；"
Write-Host "     也可以直接跑 $AppDir\scripts\restore.cmd"
