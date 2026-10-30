<#
.SYNOPSIS
  DPAPI 帮助脚本：给 Node 侧调用 Windows 数据保护接口（仅当前用户可解）。

.DESCRIPTION
  dsh-disaster-recovery 的「异地副本」需要把恢复密码/主密钥缓存到本机
  （<offsite>/key.dpapi），供无人值守导出使用。Node 没有内置 DPAPI，
  所以由本脚本做一次转换：

    -Mode Protect    stdin: base64(UTF-8 明文)     -> stdout: base64(DPAPI blob)
    -Mode Unprotect  stdin: base64(DPAPI blob)     -> stdout: base64(UTF-8 明文)

  只使用 [System.Security.Cryptography.ProtectedData] + CurrentUser scope：
  同一台机器上的其他 Windows 用户解不开；换机/重装系统后缓存必然失效，
  那时只能用恢复密码。

  安全约束：
    - 明文与 blob 只经 stdin/stdout 传递，不写任何临时文件；
    - 不打印明文、不打印长度以外的内容；错误只走 stderr 且不含明文；
    - 不联网、不加载外部模块（Add-Type 只加载系统程序集）。

.EXAMPLE
  'aGVsbG8=' | powershell -NoProfile -File scripts/dpapi.ps1 -Mode Protect
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Protect', 'Unprotect')]
  [string]$Mode
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  try { [Console]::Error.WriteLine('dpapi: ' + $Message) } catch { }
  exit 1
}

# System.Security 在 Windows PowerShell 5.1 里要显式加载；pwsh 7 里 ProtectedData
# 已随运行时提供，加载失败也不算错误。
try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch { }
try { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop } catch { }

if (-not ('System.Security.Cryptography.ProtectedData' -as [type])) {
  Fail 'ProtectedData is unavailable (Windows only)'
}

try {
  $raw = [Console]::In.ReadToEnd()
} catch {
  Fail 'could not read stdin'
}

$payload = ($raw -replace '\s', '')
if ([string]::IsNullOrEmpty($payload)) { Fail 'empty stdin' }

$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser

try {
  $bytes = [System.Convert]::FromBase64String($payload)
} catch {
  Fail 'stdin is not valid base64'
}

try {
  if ($Mode -eq 'Protect') {
    $plain = [System.Text.Encoding]::UTF8.GetString($bytes)
    $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
    # 立即清掉明文字符串引用（托管内存无法真正擦除，这里只是尽早放弃引用）
    $plain = $null
    $blob = [System.Security.Cryptography.ProtectedData]::Protect($plainBytes, $null, $scope)
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    $out = [System.Convert]::ToBase64String($blob)
    [Array]::Clear($blob, 0, $blob.Length)
  }
  else {
    $blob = $bytes
    $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, $scope)
    $out = [System.Convert]::ToBase64String($plainBytes)
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  }
  [Console]::Out.Write($out)
  exit 0
} catch {
  # 不要把异常原文往 stdout 写；DPAPI 失败原因（例如换用户）不含明文，可以给 stderr。
  Fail ('operation failed: ' + $_.Exception.Message)
}

