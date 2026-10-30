# 把本仓库的插件文件安全地同步到已安装的 DSH profile。
#
# 默认是 dry-run：只打印 ADD / UPDATE / SAME 清单，不写任何文件。
# 加 -Apply 才真正复制；复制前会把当前已安装版本整份备份到
# D:\dsh-backup\manual\<时间戳>-dsh-disaster-recovery-<版本>\ 并写 SHA256 清单。
#
# 只做「复制」，不做任何递归删除；只允许写到 profiles\<name>\plugins\dsh-disaster-recovery。
#
#   pwsh -NoProfile -File scripts\deploy-profile.ps1            # 预览
#   pwsh -NoProfile -File scripts\deploy-profile.ps1 -Apply     # 备份 + 更新
#   scripts\deploy.cmd                                          # 双击预览
#
[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$Source = (Join-Path $PSScriptRoot '..'),
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [string]$BackupRoot = 'D:\dsh-backup\manual',
  [switch]$NoBackup
)

$ErrorActionPreference = 'Stop'

function Fail($message) {
  Write-Host "[deploy] $message" -ForegroundColor Red
  exit 1
}

$source = (Resolve-Path -LiteralPath $Source).Path
$pluginName = 'dsh-disaster-recovery'
$plugin = Join-Path $ProfileDir "plugins\$pluginName"

# ---- 安全检查：只允许操作 profile 下的这个插件目录 ----
$pluginFull = [System.IO.Path]::GetFullPath($plugin)
$expectedSuffix = "profiles\desktop\plugins\$pluginName"
if (-not $pluginFull.EndsWith($expectedSuffix, [System.StringComparison]::OrdinalIgnoreCase)) {
  Fail "目标目录不在预期位置（应形如 <profile>\plugins\$pluginName）：$pluginFull"
}
if ($pluginFull -eq [System.IO.Path]::GetPathRoot($pluginFull)) { Fail '目标解析成了盘符根目录，拒绝执行' }
if (-not (Test-Path -LiteralPath (Join-Path $pluginFull 'package.json'))) {
  Fail "没有找到已安装插件：$pluginFull（请先用 install.ps1 装一次）"
}

# ---- 需要同步的文件（与 package.json files 对齐，排除验证台 / 备份 / 临时文件） ----
$excludeDir = @('.verify', '.mockup', 'node_modules', '.git')
$excludeName = @('*.bak', '*.bak-*', '*.tmp', '*.temp', '*.log')
$files = Get-ChildItem -LiteralPath $source -Recurse -File | Where-Object {
  $rel = $_.FullName.Substring($source.Length + 1)
  $parts = $rel.Split([System.IO.Path]::DirectorySeparatorChar)
  $skip = $false
  foreach ($dir in $excludeDir) {
    if ($parts.Length -gt 1 -and $parts[0] -eq $dir) { $skip = $true }
  }
  if ($parts | Where-Object { $excludeDir -contains $_ }) { $skip = $true }
  if (-not $skip) {
    foreach ($pattern in $excludeName) { if ($_.Name -like $pattern) { $skip = $true } }
  }
  -not $skip
} | ForEach-Object {
  $rel = $_.FullName.Substring($source.Length + 1)
  $target = Join-Path $pluginFull $rel
  $srcHash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
  $dstHash = if (Test-Path -LiteralPath $target) { (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash } else { $null }
  $state = if (-not $dstHash) { 'ADD' } elseif ($srcHash -eq $dstHash) { 'SAME' } else { 'UPDATE' }
  [pscustomobject]@{ State = $state; Rel = $rel; Bytes = $_.Length; Source = $_.FullName; Target = $target }
}

$updates = @($files | Where-Object { $_.State -ne 'SAME' })
Write-Host ''
Write-Host "源目录  : $source"
Write-Host "目标目录: $pluginFull"
Write-Host ("文件    : 共 {0}，ADD {1}，UPDATE {2}，SAME {3}" -f $files.Count,
  @($files | Where-Object State -eq 'ADD').Count,
  @($files | Where-Object State -eq 'UPDATE').Count,
  @($files | Where-Object State -eq 'SAME').Count)
Write-Host ''
foreach ($f in $updates) { Write-Host ("  {0,-6} {1}" -f $f.State, $f.Rel) }
Write-Host ''

if ($updates.Count -eq 0) {
  Write-Host '[deploy] 已是最新，无需复制。' -ForegroundColor Green
  exit 0
}

if (-not $Apply) {
  Write-Host '[deploy] dry-run：没有写任何文件。确认无误后加 -Apply 执行。' -ForegroundColor Yellow
  Write-Host '[deploy] 真正的执行：pwsh -NoProfile -File scripts\deploy-profile.ps1 -Apply'
  exit 0
}

# ---- 备份当前已安装版本（整份复制，绝不删除原目录） ----
$installedVersion = 'unknown'
try {
  $installedVersion = (Get-Content -LiteralPath (Join-Path $pluginFull 'package.json') -Raw | ConvertFrom-Json).version
} catch { }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $BackupRoot "$stamp-dsh-disaster-recovery-$installedVersion"

if (-not $NoBackup) {
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  Copy-Item -Path (Join-Path $pluginFull '*') -Destination $backupDir -Recurse -Force
  $backupFiles = Get-ChildItem -LiteralPath $backupDir -Recurse -File
  $sums = $backupFiles | ForEach-Object {
    $h = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    "$h $($_.FullName.Substring($backupDir.Length + 1))"
  }
  Set-Content -LiteralPath (Join-Path $backupDir '_SHA256SUMS.txt') -Value $sums -Encoding UTF8
  Write-Host "[deploy] 已备份 $($backupFiles.Count) 个文件 -> $backupDir" -ForegroundColor Cyan
} else {
  Write-Host '[deploy] -NoBackup：跳过备份（不建议）' -ForegroundColor Yellow
}

# ---- 复制（先写 .new 再 Move-Item 覆盖，尽量避免读到半份文件） ----
foreach ($f in $updates) {
  $dir = Split-Path -Parent $f.Target
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $tmp = "$($f.Target).new"
  Copy-Item -LiteralPath $f.Source -Destination $tmp -Force
  Move-Item -LiteralPath $tmp -Destination $f.Target -Force
}

# ---- 校验 ----
$bad = @()
foreach ($f in $updates) {
  $srcHash = (Get-FileHash -LiteralPath $f.Source -Algorithm SHA256).Hash
  $dstHash = (Get-FileHash -LiteralPath $f.Target -Algorithm SHA256).Hash
  if ($srcHash -ne $dstHash) { $bad += $f.Rel }
}
if ($bad.Count -gt 0) {
  Write-Host "[deploy] 校验失败：$($bad -join ', ')" -ForegroundColor Red
  Write-Host "[deploy] 回滚：把 $backupDir 的内容复制回 $pluginFull" -ForegroundColor Yellow
  exit 2
}

Write-Host "[deploy] 已复制 $($updates.Count) 个文件，SHA256 全部校验通过。" -ForegroundColor Green
Write-Host ''
Write-Host '下一步：'
Write-Host '  1) 刷新 DSH 页面：面板 UI 立即生效（client.js 走浏览器侧）。'
Write-Host '  2) 重启一次 DeepSeek Harness：Host 侧的体检 / 恢复预演 / 空文件校验修复才生效。'
Write-Host '  3) 子机：dsh-sync 会把 plugins/dsh-disaster-recovery 同步过去，子机同样需要重启一次。'
if (-not $NoBackup) {
  Write-Host "  回滚：Copy-Item '$backupDir\*' '$pluginFull' -Recurse -Force" -ForegroundColor DarkGray
}
