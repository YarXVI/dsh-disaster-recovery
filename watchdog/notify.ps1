#Requires -Version 5.1
<#
.SYNOPSIS
  DSH 外部看门狗的通知辅助脚本（邮件 / 通用 webhook）。

.DESCRIPTION
  参数从 stdin JSON 读取，明文密码只存在于进程内存，绝不写日志、绝不回显。

  -Mode Email   stdin:
    { "host":"smtp.example.com", "port":587, "useSsl":true,
      "user":"me@example.com", "password":"***", "from":"me@example.com",
      "to":["a@example.com"], "subject":"...", "body":"...", "timeoutMs":20000 }
    stdout 成功: {"ok":true,"mode":"email"}
    失败: stderr 只输出 `email: <CODE>`（不含任何凭据/服务器返回正文），退出码 1。
    CODE: INPUT | CONFIG | SMTP_CONNECT | SMTP_AUTH | SMTP_TIMEOUT | SMTP_TRANSIENT | SMTP_REJECT | SMTP_SEND

  -Mode Webhook stdin:
    { "url":"https://...", "token":"", "json":{...}, "timeoutMs":8000, "retries":2 }
    stdout 成功: {"ok":true,"mode":"webhook","status":200}
    失败: stderr `webhook: <CODE>`：INPUT | CONFIG | WEBHOOK_HTTP | WEBHOOK_TIMEOUT | WEBHOOK_FAILED

  约束：不联网除非调用方给了地址；不写 .dsh；命令行参数里永远不出现密码。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Email', 'Webhook')]
  [string]$Mode = 'Email'
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Code) {
  try { [Console]::Error.WriteLine(('{0}: {1}' -f $Mode.ToLowerInvariant(), $Code)) } catch { }
  exit 1
}

if (-not ('System.Net.Mail.SmtpClient' -as [type])) {
  try { Add-Type -AssemblyName System.Net.Mail -ErrorAction Stop } catch { Fail 'CONFIG' }
}

$raw = ''
try { $raw = [Console]::In.ReadToEnd() } catch { Fail 'INPUT' }
if ([string]::IsNullOrWhiteSpace($raw)) { Fail 'INPUT' }
try { $cfg = $raw | ConvertFrom-Json } catch { Fail 'INPUT' }
if ($null -eq $cfg) { Fail 'INPUT' }

if ($Mode -eq 'Email') {
  $hostName = [string]$cfg.host
  $from = [string]$cfg.from
  $to = @($cfg.to | Where-Object { $_ })
  if (-not $hostName -or -not $from -or $to.Count -eq 0) { Fail 'CONFIG' }
  $port = 587
  if ($null -ne $cfg.port) { $port = [int]$cfg.port }
  if ($port -le 0 -or $port -gt 65535) { Fail 'CONFIG' }
  $useSsl = $true
  if ($null -ne $cfg.useSsl) { $useSsl = [bool]$cfg.useSsl }
  $timeoutMs = 20000
  if ($null -ne $cfg.timeoutMs) { $timeoutMs = [int]$cfg.timeoutMs }

  $mail = $null
  $smtp = $null
  try {
    $mail = New-Object System.Net.Mail.MailMessage
    $mail.From = New-Object System.Net.Mail.MailAddress($from)
    foreach ($address in $to) { $mail.To.Add([string]$address) }
    $mail.Subject = ([string]$cfg.subject)
    $mail.Body = ([string]$cfg.body)
    $mail.SubjectEncoding = [System.Text.Encoding]::UTF8
    $mail.BodyEncoding = [System.Text.Encoding]::UTF8
    $mail.IsBodyHtml = $false
    $mail.Priority = [System.Net.Mail.MailPriority]::High

    $smtp = New-Object System.Net.Mail.SmtpClient($hostName, $port)
    $smtp.EnableSsl = $useSsl
    $smtp.Timeout = [Math]::Max(5000, $timeoutMs)
    # DeliveryFormat 用默认；凭据只在内存里，绝不出现在日志/命令行。
    if ($cfg.user) {
      $secure = New-Object System.Security.SecureString
      foreach ($ch in ([string]$cfg.password).ToCharArray()) { $secure.AppendChar($ch) }
      $smtp.Credentials = New-Object System.Net.NetworkCredential([string]$cfg.user, $secure)
      $secure.Dispose()
    } else {
      $smtp.UseDefaultCredentials = $false
    }
    $smtp.Send($mail)
    [Console]::Out.Write('{"ok":true,"mode":"email"}')
    exit 0
  } catch {
    $ex = $_.Exception
    # 先看整条异常链里的“根因类型”（SmtpException 往往只报 GeneralFailure，
    # 真正的连接/认证/超时原因在 InnerException 里），最后才按 SmtpException.StatusCode 归类。
    $typeNames = New-Object System.Collections.ArrayList
    $smtpStatus = ''
    $cursor = $ex
    for ($i = 0; $i -lt 8 -and $null -ne $cursor; $i++) {
      $typeName = $cursor.GetType().FullName
      [void]$typeNames.Add($typeName)
      if ($typeName -eq 'System.Net.Mail.SmtpException' -and -not $smtpStatus) {
        try { $smtpStatus = [string]$cursor.StatusCode } catch { $smtpStatus = '' }
      }
      $cursor = $cursor.InnerException
    }
    $code = 'SMTP_SEND'
    if ($typeNames -contains 'System.Net.Sockets.SocketException') { $code = 'SMTP_CONNECT' }
    elseif ($typeNames -contains 'System.Security.Authentication.AuthenticationException') { $code = 'SMTP_AUTH' }
    elseif ($typeNames -contains 'System.TimeoutException') { $code = 'SMTP_TIMEOUT' }
    elseif ($typeNames -contains 'System.Threading.Tasks.TaskCanceledException') { $code = 'SMTP_TIMEOUT' }
    elseif ($typeNames -contains 'System.Net.Mail.SmtpFailedRecipientsException') { $code = 'SMTP_REJECT' }
    elseif ($smtpStatus) {
      switch ($smtpStatus) {
        'MailboxUnavailable' { $code = 'SMTP_REJECT' }
        'MailboxBusy' { $code = 'SMTP_TRANSIENT' }
        'ServiceNotAvailable' { $code = 'SMTP_TRANSIENT' }
        'ClientNotPermitted' { $code = 'SMTP_AUTH' }
        'MustIssueStartTlsFirst' { $code = 'SMTP_AUTH' }
        'TransactionFailed' { $code = 'SMTP_REJECT' }
        default { $code = 'SMTP_SEND' }
      }
    }
    Fail $code
  } finally {
    if ($null -ne $mail) { try { $mail.Dispose() } catch { } }
    if ($null -ne $smtp) { try { $smtp.Dispose() } catch { } }
  }
}

if ($Mode -eq 'Webhook') {
  $url = [string]$cfg.url
  if (-not $url -or $url -notmatch '^https?://') { Fail 'CONFIG' }
  $timeoutMs = 8000
  if ($null -ne $cfg.timeoutMs) { $timeoutMs = [Math]::Max(1000, [int]$cfg.timeoutMs) }
  $retries = 0
  if ($null -ne $cfg.retries) { $retries = [Math]::Max(0, [int]$cfg.retries) }
  $payload = $cfg.json
  if ($null -eq $payload) { $payload = [pscustomobject]@{ ok = $true } }
  $headers = @{}
  if ($cfg.token) { $headers['Authorization'] = 'Bearer ' + [string]$cfg.token }
  $lastStatus = 0
  for ($attempt = 0; $attempt -le $retries; $attempt++) {
    try {
      $params = @{
        Uri         = $url
        Method      = 'Post'
        ContentType = 'application/json; charset=utf-8'
        Body        = ($payload | ConvertTo-Json -Depth 8 -Compress)
        TimeoutSec  = [Math]::Max(1, [int][Math]::Ceiling($timeoutMs / 1000))
        ErrorAction = 'Stop'
      }
      if ($headers.Count -gt 0) { $params['Headers'] = $headers }
      $response = Invoke-RestMethod @params
      [Console]::Out.Write('{"ok":true,"mode":"webhook"}')
      exit 0
    } catch {
      $ex = $_.Exception
      $status = 0
      try { $status = [int]$ex.Response.StatusCode } catch { $status = 0 }
      if ($status -gt 0) { $lastStatus = $status }
      if ($ex.GetType().FullName -match 'TimeoutException|TaskCanceledException') { $lastStatus = -1 }
      if ($attempt -lt $retries) { Start-Sleep -Milliseconds ([Math]::Min(2000, 250 * [Math]::Pow(2, $attempt))) }
    }
  }
  if ($lastStatus -eq -1) { Fail 'WEBHOOK_TIMEOUT' }
  if ($lastStatus -gt 0) { Fail 'WEBHOOK_HTTP' }
  Fail 'WEBHOOK_FAILED'
}
