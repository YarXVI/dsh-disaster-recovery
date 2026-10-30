#!/usr/bin/env node
/**
 * DSH 外部看门狗（dsh-disaster-recovery / task-8）。
 *
 * 位置：装到 `%LOCALAPPDATA%\DeepSeek Recovery\monitor\watchdog.mjs`，
 * 由用户级计划任务 `DSH-DisasterWatchdog` 每分钟跑一次 `node watchdog.mjs --once`。
 *
 * 铁律（不可协商）：
 *   - **只读** DSH：绝不启动 / 重启 / 杀任何 DSH 进程；事件日志与进程检测都是只读查询。
 *   - 绝不写 `.dsh`：唯一写入区域是 `<storeRoot>\<host>\monitor\**` 与
 *     `<recoveryHome>\monitor\watchdog.lock`；自检会拒绝任何落在 home 内的写路径。
 *   - 通知饱和式、无短路：一个通道失败只记结果，绝不影响其它通道。
 *   - 单实例：`monitor\watchdog.lock`（超过 2 分钟或 pid 已死视为过期可抢占）。
 *
 * 零依赖、Node ≥ 20、ESM；可注入依赖便于测试（不联网、不杀真实进程、不装任务）。
 *
 * 用法：
 *   node watchdog.mjs --once [--config <file>] [--json]
 *   node watchdog.mjs --loop [--interval-ms 60000]      # 仅调试
 *   node watchdog.mjs --once --no-notify                # 只记录、不发通知
 *
 * 配置默认 `%LOCALAPPDATA%\DeepSeek Recovery\monitor\config.json`，
 * 也可用 `--config <file>` / 环境变量 `DSH_MONITOR_CONFIG` 指定。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const WATCHDOG_VERSION = '1.0.2'
export const TASK_NAME = 'DSH-DisasterWatchdog'
export const DEFAULT_PROCESS_NAME = 'DeepSeek Harness.exe'
export const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

const KIND_LABELS = {
  crash: 'DSH 异常退出',
  hang: 'DSH 无响应',
  'data-loss': '数据骤降',
  'mass-change': '大量变更/覆写',
  'backup-corrupt': '备份校验失败',
  'offsite-stale': '异地副本过期',
  'disk-low': '备份盘空间不足',
}

export const THRESHOLD_DEFAULTS = {
  heartbeatStaleMs: 120000, // 心跳超过 2 分钟 = 进程已不在或 host 卡死
  hangStaleMs: 180000, // 进程在、心跳停 3 分钟 = hang
  sleepGraceMs: 180000, // 睡眠/关机事件与最后一次心跳的时间邻近窗口
  crashLookbackMs: 86400000, // 超过 24h 的旧断档不再当“刚发生的崩溃”报
  eventLookbackMs: 86400000,
  dataLossMinFiles: 50,
  dataLossRatio: 0.05,
  dataLossSessionsRatio: 0.25,
  diskLowFreeBytes: 10 * 1024 * 1024 * 1024,
  offsiteStaleMs: 48 * 3600 * 1000,
  dedupeMs: 30 * 60 * 1000, // 同 kind 30 分钟内合并 timeline，不重复通知
  baselineMinIntervalMs: 24 * 3600 * 1000,
  retentionDays: 90,
  logMaxBytes: 10 * 1024 * 1024,
  lockStaleMs: 2 * 60 * 1000,
  deepVerifyEveryMs: 60 * 60 * 1000, // 全量备份校验最多每小时一次
  quickVerifySnapshots: 2,
  alertMaxAgeDays: 7,
}

export const NOTIFY_DEFAULTS = {
  panel: true,
  toast: true,
  toastTimeoutMs: 20000,
  retries: 2,
  outboxMaxAttempts: 12, // outbox 里同一通道最多补发次数（失败后置 failed，不再无限重试）
  webhook: [],
  email: {
    enabled: false,
    host: '',
    port: 587,
    useSsl: true,
    user: '',
    from: '',
    to: [],
  },
  qq: { enabled: false, http: '', token: '', action: 'send_private_msg', target: '' },
  peer: { enabled: false },
}

export const DEFAULTS = {
  v: 1,
  storeRoot: 'D:\\dsh-backup',
  home: '',
  hostname: '',
  process: { name: DEFAULT_PROCESS_NAME, queryTimeoutMs: 8000 },
  thresholds: { ...THRESHOLD_DEFAULTS },
  notify: clone(NOTIFY_DEFAULTS),
  excludes: ['dsh-runtimes'],
  installedAt: 0,
}

/* --------------------------------------------------------------- 基础工具 */

export function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

export function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

export function deepMerge(base, extra) {
  const out = clone(base)
  if (!isPlainObject(extra)) return out
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value)
    else out[key] = clone(value)
  }
  return out
}

export function asNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function sanitizeHostTag(name) {
  return String(name || 'host').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'host'
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

export function formatDateTime(ms) {
  const n = Number(ms)
  if (!n) return '—'
  const d = new Date(n)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export function formatClock(ms) {
  const n = Number(ms)
  if (!n) return '—'
  const d = new Date(n)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export function formatDuration(ms) {
  const n = Math.max(0, Number(ms) || 0)
  if (n < 60000) return `${Math.round(n / 1000)} 秒`
  if (n < 3600000) return `${Math.round(n / 60000)} 分钟`
  if (n < 86400000) return `${(n / 3600000).toFixed(1)} 小时`
  return `${(n / 86400000).toFixed(1)} 天`
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1 }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}

async function exists(p) {
  try { await fsp.access(p); return true } catch { return false }
}

async function readJsonSafe(file, fallback = null) {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/** Windows 上 rename 可能被短暂占用，退避重试。 */
export async function writeFileAtomic(abs, buf) {
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.${process.pid}.${Date.now().toString(36)}.tmp`
  await fsp.writeFile(tmp, buf)
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(tmp, abs)
      return
    } catch (error) {
      const transient = error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY')
      if (!transient || attempt >= 7) {
        try { await fsp.rm(tmp, { force: true }) } catch { /* ignore */ }
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, 20 * 2 ** attempt)))
    }
  }
}

export async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'))
}

export async function appendLog(logPath, line, maxBytes = THRESHOLD_DEFAULTS.logMaxBytes) {
  try {
    let size = 0
    try { size = (await fsp.stat(logPath)).size } catch { /* 文件不存在 */ }
    if (size > maxBytes) {
      try { await fsp.rename(logPath, `${logPath}.1`) } catch { /* 下一轮再试 */ }
    }
    await fsp.appendFile(logPath, `${line}\n`)
  } catch { /* 日志失败绝不影响主流程 */ }
}

/* ------------------------------------------------------------- 参数与配置 */

const VALUE_FLAGS = new Set([
  'config', 'recovery-home', 'store-root', 'home', 'hostname',
  'interval-ms', 'lock', 'dpapi-script', 'script-dir', 'test-notify',
])

const BOOL_FLAGS = new Set([
  'once', 'loop', 'json', 'quiet', 'help', 'version', 'no-notify', 'skip-lock',
])

export function parseArgs(argv = []) {
  const out = { _: [], unknown: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i])
    if (!arg.startsWith('--')) { out._.push(arg); continue }
    const key = arg.slice(2)
    if (VALUE_FLAGS.has(key)) {
      const next = argv[i + 1]
      if (next != null && !String(next).startsWith('--')) { out[key] = String(next); i += 1 } else out[key] = true
      continue
    }
    if (BOOL_FLAGS.has(key)) { out[key] = true; continue }
    out.unknown.push(key)
  }
  return out
}

export function resolveDefaultRecoveryHome(env = process.env) {
  const fromEnv = String(env.DSH_RECOVERY_HOME || '').trim()
  if (fromEnv) return path.resolve(fromEnv)
  const local = String(env.LOCALAPPDATA || '').trim() || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(local, 'DeepSeek Recovery')
}

export function resolveConfigPath(options = {}) {
  if (options.configPath) return path.resolve(String(options.configPath))
  const fromEnv = String(process.env.DSH_MONITOR_CONFIG || '').trim()
  if (fromEnv) return path.resolve(fromEnv)
  return path.join(resolveDefaultRecoveryHome(), 'monitor', 'config.json')
}

export function normalizeConfig(raw) {
  const warnings = []
  const merged = deepMerge(DEFAULTS, isPlainObject(raw) ? raw : {})
  if (raw != null && !isPlainObject(raw)) warnings.push('config-not-object')
  const out = {
    v: asNumber(merged.v, 1),
    storeRoot: String(merged.storeRoot || DEFAULTS.storeRoot),
    home: String(merged.home || ''),
    hostname: String(merged.hostname || ''),
    process: {
      name: String(merged.process?.name || DEFAULT_PROCESS_NAME),
      queryTimeoutMs: asNumber(merged.process?.queryTimeoutMs, 8000),
    },
    thresholds: {},
    notify: clone(NOTIFY_DEFAULTS),
    excludes: Array.isArray(merged.excludes) ? merged.excludes.map(String) : ['dsh-runtimes'],
    installedAt: asNumber(merged.installedAt, 0),
  }
  for (const key of Object.keys(THRESHOLD_DEFAULTS)) {
    const value = merged.thresholds?.[key]
    const fallback = THRESHOLD_DEFAULTS[key]
    out.thresholds[key] = typeof fallback === 'number' ? asNumber(value, fallback) : value
    if (typeof fallback === 'number' && out.thresholds[key] <= 0 && fallback > 0) {
      warnings.push(`threshold-${key}-invalid`)
      out.thresholds[key] = fallback
    }
  }
  // notify：逐键合并，webhook 支持对象/数组两种写法
  const n = isPlainObject(merged.notify) ? merged.notify : {}
  out.notify.panel = n.panel !== false
  out.notify.toast = n.toast !== false
  out.notify.toastTimeoutMs = asNumber(n.toastTimeoutMs, 20000)
  out.notify.retries = Math.max(0, asNumber(n.retries, 2))
  out.notify.outboxMaxAttempts = Math.max(1, asNumber(n.outboxMaxAttempts, 12))
  const hooks = []
  if (Array.isArray(n.webhook)) {
    for (const item of n.webhook) {
      if (isPlainObject(item) && item.url) hooks.push(normalizeWebhook(item))
      else if (typeof item === 'string' && item.trim()) hooks.push(normalizeWebhook({ url: item.trim() }))
    }
  } else if (isPlainObject(n.webhook)) {
    for (const [name, item] of Object.entries(n.webhook)) {
      if (typeof item === 'string' && item.trim()) hooks.push(normalizeWebhook({ name, url: item.trim() }))
      else if (isPlainObject(item)) hooks.push(normalizeWebhook({ name, ...item }))
    }
  } else if (Array.isArray(n.webhooks)) {
    for (const item of n.webhooks) if (isPlainObject(item) && item.url) hooks.push(normalizeWebhook(item))
  }
  out.notify.webhook = hooks
  const email = isPlainObject(n.email) ? n.email : {}
  out.notify.email = {
    enabled: email.enabled === true,
    host: String(email.host || ''),
    port: asNumber(email.port, 587),
    useSsl: email.useSsl !== false,
    user: String(email.user || ''),
    from: String(email.from || ''),
    to: Array.isArray(email.to) ? email.to.map(String).filter(Boolean) : (email.to ? [String(email.to)] : []),
    subjectPrefix: String(email.subjectPrefix || '[DSH]'),
  }
  const qq = isPlainObject(n.qq) ? n.qq : {}
  out.notify.qq = {
    enabled: qq.enabled === true,
    http: String(qq.http || ''),
    token: String(qq.token || ''),
    action: String(qq.action || 'send_private_msg'),
    target: qq.target == null ? '' : String(qq.target),
  }
  out.notify.peer = { enabled: n.peer?.enabled === true }
  return { config: out, warnings }
}

function normalizeWebhook(hook) {
  return {
    name: String(hook.name || hook.id || 'webhook'),
    url: String(hook.url || ''),
    enabled: hook.enabled !== false,
    retries: Math.max(0, asNumber(hook.retries, 2)),
    timeoutMs: asNumber(hook.timeoutMs, 8000),
    tokenSecret: String(hook.tokenSecret || ''),
  }
}

export async function loadConfig(configPath = resolveConfigPath()) {
  const warnings = []
  let raw = null
  let present = false
  try {
    raw = JSON.parse(await fsp.readFile(configPath, 'utf8'))
    present = true
  } catch (error) {
    warnings.push(`config-${error?.code === 'ENOENT' ? 'missing' : 'unreadable'}`)
  }
  const normalized = normalizeConfig(raw)
  return { config: normalized.config, warnings: [...warnings, ...normalized.warnings], path: configPath, present }
}

/* ------------------------------------------------------- 心跳 / baseline */

export function normalizeStats(raw) {
  if (!isPlainObject(raw)) {
    return {
      files: 0, bytes: 0, sessions: 0, storages: 0, profiles: 0, attachments: 0,
      credentials: false, keyFiles: null,
    }
  }
  // 插件新版本（task-13）会把关键文件存在性放进 stats.keyFiles；老心跳没有就保持 null。
  const keyFilesRaw = isPlainObject(raw.keyFiles) ? raw.keyFiles : null
  return {
    files: asNumber(raw.files, 0),
    bytes: asNumber(raw.bytes, 0),
    sessions: asNumber(raw.sessions, 0),
    storages: asNumber(raw.storages, 0),
    profiles: asNumber(raw.profiles, 0),
    attachments: asNumber(raw.attachments, 0),
    credentials: raw.credentials === true,
    keyFiles: keyFilesRaw ? {
      workspace: keyFilesRaw.workspace === true,
      profile: keyFilesRaw.profile === true,
      credentials: keyFilesRaw.credentials === true || keyFilesRaw.credential === true,
    } : null,
  }
}

export function normalizeHeartbeat(raw) {
  if (!isPlainObject(raw)) return null
  const flat = raw
  const stats = normalizeStats(isPlainObject(raw.stats) ? raw.stats : flat)
  return {
    raw,
    present: true,
    v: asNumber(raw.v, 1),
    bootId: raw.bootId ? String(raw.bootId) : null,
    pid: asNumber(raw.pid, 0),
    startedAt: asNumber(raw.startedAt, 0),
    lastSeen: asNumber(raw.lastSeen, 0),
    cleanExit: raw.cleanExit === true,
    cleanExitAt: asNumber(raw.cleanExitAt, 0),
    version: String(raw.version || ''),
    host: isPlainObject(raw.host) ? {
      name: String(raw.host.name || ''),
      home: String(raw.host.home || ''),
      root: String(raw.host.root || ''),
    } : { name: '', home: '', root: '' },
    stats,
    backup: isPlainObject(raw.backup) ? {
      snapshots: asNumber(raw.backup.snapshots, 0),
      latestId: raw.backup.latestId ? String(raw.backup.latestId) : null,
      latestAt: asNumber(raw.backup.latestAt, 0),
      lastSnapshotAt: asNumber(raw.backup.lastSnapshotAt, 0),
      lastError: raw.backup.lastError == null ? null : String(raw.backup.lastError),
    } : { snapshots: 0, latestId: null, latestAt: 0, lastSnapshotAt: 0, lastError: null },
    offsite: isPlainObject(raw.offsite) ? {
      configured: raw.offsite.configured === true,
      locked: raw.offsite.locked !== false,
      lastExportAt: asNumber(raw.offsite.lastExportAt, 0),
      lastSyncAt: asNumber(raw.offsite.lastSyncAt, 0),
      peerOnline: raw.offsite.peerOnline === true,
      archives: asNumber(raw.offsite.archives, 0),
    } : { configured: false, locked: true, lastExportAt: 0, lastSyncAt: 0, peerOnline: false, archives: 0 },
    client: isPlainObject(raw.client) ? { lastSeen: asNumber(raw.client.lastSeen, 0) } : { lastSeen: 0 },
    lastAction: isPlainObject(raw.lastAction) ? { type: String(raw.lastAction.type || ''), at: asNumber(raw.lastAction.at, 0) } : null,
  }
}

export function normalizeBaseline(raw) {
  if (!isPlainObject(raw)) return null
  const stats = normalizeStats(isPlainObject(raw.stats) ? raw.stats : raw)
  // 统计来源判定（task-12）：
  //   - 显式 statsSource（1.0.1 起 watchdog 写的）；
  //   - monitor.js 的 baseline 来自心跳 stats → heartbeat；
  //   - 1.0.0 的 watchdog baseline 来自 scanHome（无 statsSource）→ scan（兼容历史误报产物）。
  const explicit = raw.statsSource || (isPlainObject(raw.stats) ? raw.stats.statsSource : '')
  const sourceTag = String(raw.source || '')
  const statsSource = String(explicit || (sourceTag === 'watchdog' ? 'scan' : 'heartbeat'))
  return {
    raw,
    present: true,
    at: asNumber(raw.at, 0),
    host: String(raw.host || ''),
    home: String(raw.home || ''),
    source: sourceTag,
    statsSource,
    stats,
  }
}

/* ---------------------------------------------------------- 命令执行工具 */

/** 用 spawn 跑一个命令，永不抛异常；返回 {ok, code, stdout, stderr, timeout}。 */
export function createCommandRunner({ spawn = nodeSpawn, defaultTimeoutMs = 15000 } = {}) {
  return function runCommand(executable, args = [], { input = null, timeoutMs = defaultTimeoutMs, cwd } = {}) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(executable, args, {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: cwd || undefined,
        })
      } catch (error) {
        resolve({ ok: false, code: -1, stdout: '', stderr: String(error?.message || error) })
        return
      }
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* ignore */ }
        finish({ ok: false, code: -1, stdout, stderr: `${stderr}\ntimeout`, timeout: true })
      }, Math.max(1000, Number(timeoutMs) || defaultTimeoutMs))
      child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
      child.on('error', (error) => finish({ ok: false, code: -1, stdout, stderr: String(error?.message || error) }))
      child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }))
      try {
        if (input != null && child.stdin) child.stdin.end(String(input))
        else child.stdin?.end()
      } catch { /* stdin 已关 */ }
    })
  }
}

export function defaultPowerShellPath(env = process.env) {
  if (env.DSH_WATCHDOG_POWERSHELL) return String(env.DSH_WATCHDOG_POWERSHELL)
  return process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
}

export function createPowerShellRunner({ runCommand, powershell = defaultPowerShellPath(), timeoutMs = 12000 } = {}) {
  return function runPowerShell(script, options = {}) {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', String(script)]
    return runCommand(powershell, args, { timeoutMs: options.timeoutMs || timeoutMs, input: options.input, cwd: options.cwd })
  }
}

/* ------------------------------------------------------- 进程 / 事件日志 */

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

export function buildProcessQueryScript(processName) {
  const quotedName = psSingleQuote(String(processName).replace(/'/g, "''"))
  const filter = `("Name=" + ${quotedName})`
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$ErrorActionPreference = "Stop"',
    '$items = @()',
    `try { $items = @(Get-CimInstance Win32_Process -Filter ${filter} -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate) }`,
    'catch {',
    // CIM/WMI 不可用时退到 Get-Process（拿不到 CommandLine，但至少能判断存活）。
    `  $bareName = [System.IO.Path]::GetFileNameWithoutExtension(${quotedName})`,
    '  $items = @(Get-Process -Name $bareName -ErrorAction SilentlyContinue | ForEach-Object {',
    '    $started = $null',
    '    try { $started = $_.StartTime } catch { }',
    '    [pscustomobject]@{ ProcessId = $_.Id; ParentProcessId = 0; Name = ($_.ProcessName + ".exe"); CommandLine = ""; CreationDate = $started }',
    '  })',
    '}',
    '$out = @($items | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; name = [string]$_.Name; commandLine = [string]$_.CommandLine; startedAt = if ($_.CreationDate) { [int64]([datetimeoffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { [int64]0 } } })',
    'ConvertTo-Json -InputObject $out -Depth 4 -Compress',
  ].join('\n')
}

export function parseProcessOutput(stdout) {
  const text = String(stdout || '').trim()
  if (!text) return { ok: true, alive: false, count: 0, processes: [], main: null }
  let parsed
  try { parsed = JSON.parse(text) } catch { return { ok: false, alive: false, error: 'process-json-invalid' } }
  let list = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : [])
  list = list.filter((item) => isPlainObject(item) && asNumber(item.pid, 0) > 0)
  const processes = list.map((item) => ({
    pid: asNumber(item.pid, 0),
    parentPid: asNumber(item.parentPid, 0),
    name: String(item.name || ''),
    commandLine: String(item.commandLine || ''),
    startedAt: asNumber(item.startedAt, 0),
  }))
  // 主进程 = 最早启动的那个（DSH 主窗口进程通常最早；辅助进程一般后起）
  const sorted = processes.slice().sort((a, b) => (a.startedAt || Infinity) - (b.startedAt || Infinity))
  return { ok: true, alive: processes.length > 0, count: processes.length, processes, main: sorted[0] || null }
}

export async function detectProcessDefault({ processName = DEFAULT_PROCESS_NAME, runPowerShell } = {}) {
  if (typeof runPowerShell !== 'function') return { ok: false, alive: false, error: 'no-powershell' }
  const result = await runPowerShell(buildProcessQueryScript(processName), { timeoutMs: 8000 })
  if (!result.ok) return { ok: false, alive: false, error: 'process-query-failed', detail: String(result.stderr || '').slice(0, 200) }
  return parseProcessOutput(result.stdout)
}

export function buildEventQueryScript(sinceMs) {
  const since = Math.max(0, Math.floor(Number(sinceMs) || 0))
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$ErrorActionPreference = "Stop"',
    `$since = [datetimeoffset]::FromUnixTimeMilliseconds(${since}).LocalDateTime`,
    '$readErrors = @()',
    'function Read-Log([string]$log, [int[]]$ids) {',
    '  try { return @(Get-WinEvent -FilterHashtable @{ LogName = $log; Id = $ids; StartTime = $since } -MaxEvents 80 -ErrorAction Stop) }',
    '  catch {',
    '    $msg = [string]$_.Exception.Message',
    '    $id = [string]$_.FullyQualifiedErrorId',
    '    if ($id -like "NoMatchingEventsFound*" -or $msg -like "*No events were found*") { return @() }',
    '    $script:readErrors += ($log + ":" + $_.Exception.GetType().Name)',
    '    return @()',
    '  }',
    '}',
    '$app = @(Read-Log "Application" @(1000, 1001, 1002))',
    '$sys = @(Read-Log "System" @(41, 42, 107, 1074, 6008))',
    'function Convert-Events($list) {',
    '  return @($list | ForEach-Object { [pscustomobject]@{ time = [int64]([datetimeoffset]$_.TimeCreated).ToUnixTimeMilliseconds(); id = [int]$_.Id; provider = [string]$_.ProviderName; recordId = [int64]$_.RecordId; level = [string]$_.LevelDisplayName; message = [string]$_.Message } })',
    '}',
    '$out = [pscustomobject]@{ application = (Convert-Events $app); system = (Convert-Events $sys); errors = @($script:readErrors) }',
    'ConvertTo-Json -InputObject $out -Depth 6 -Compress',
  ].join('\n')
}

export function normalizeEvents(raw, { sinceMs = 0, now = Date.now() } = {}) {
  const out = { ok: false, application: [], system: [], errors: [] }
  if (!isPlainObject(raw)) { out.errors.push('events-not-object'); return out }
  out.errors = Array.isArray(raw.errors) ? raw.errors.map(String) : []
  const pick = (value) => {
    if (Array.isArray(value)) return value
    if (isPlainObject(value)) return [value]
    return []
  }
  const map = (items, log) => pick(items).filter(isPlainObject).map((item) => ({
    log,
    time: asNumber(item.time, 0),
    id: asNumber(item.id, 0),
    provider: String(item.provider || ''),
    recordId: asNumber(item.recordId, 0),
    level: String(item.level || ''),
    message: String(item.message || '').slice(0, 500),
  })).filter((item) => item.id > 0 && item.time > 0 && item.time >= sinceMs - 3600000 && item.time <= now + 300000)
  out.application = map(raw.application, 'Application')
  out.system = map(raw.system, 'System')
  out.ok = out.errors.length === 0
  return out
}

export async function queryEventsDefault({ sinceMs, now = Date.now(), runPowerShell } = {}) {
  if (typeof runPowerShell !== 'function') return { ok: false, application: [], system: [], errors: ['no-powershell'] }
  const result = await runPowerShell(buildEventQueryScript(sinceMs), { timeoutMs: 10000 })
  if (!result.ok) return { ok: false, application: [], system: [], errors: ['event-query-failed'] }
  const text = String(result.stdout || '').trim()
  if (!text) return { ok: true, application: [], system: [], errors: [] }
  let parsed
  try { parsed = JSON.parse(text) } catch { return { ok: false, application: [], system: [], errors: ['event-json-invalid'] } }
  return normalizeEvents(parsed, { sinceMs, now })
}

export function mergeRecentEvents(previous, current, { now = Date.now(), cap = 200 } = {}) {
  const map = new Map()
  const add = (list, log) => {
    for (const event of list || []) {
      const key = `${event.log || log}:${event.recordId || `${event.time}:${event.id}:${String(event.message || '').slice(0, 40)}`}`
      if (!map.has(key)) map.set(key, { ...event, log: event.log || log })
    }
  }
  add(previous, 'unknown')
  add(current?.application, 'Application')
  add(current?.system, 'System')
  const list = [...map.values()].sort((a, b) => (a.time || 0) - (b.time || 0))
  const cutoff = now - 7 * 86400000
  return list.filter((event) => (event.time || 0) >= cutoff).slice(-cap)
}

/* ------------------------------------------------------------- home 扫描 */

export function isExcluded(rel, excludes) {
  const norm = String(rel || '').replace(/\\/g, '/')
  const parts = norm.split('/')
  for (const rawEntry of excludes || []) {
    const entry = String(rawEntry || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!entry) continue
    if (entry.includes('/')) {
      if (norm === entry || norm.startsWith(`${entry}/`)) return true
      continue
    }
    if (entry.startsWith('*')) {
      if (parts.some((p) => p.endsWith(entry.slice(1)))) return true
      continue
    }
    if (parts.includes(entry)) return true
  }
  return false
}

/**
 * 与插件 `src/monitor.js` 的 `countTree` 完全一致：
 *   dirs=false 数文件（maxDepth 层内的文件），dirs=true 数目录（maxDepth 层内的目录）。
 * 这是“统计口径对齐”的关键：外部看门狗与插件必须数同一种东西，否则会互相误报。
 */
export async function countTreeDefault(dir, { dirs = false, maxDepth = 2, cap = 20000 } = {}) {
  let count = 0
  let visited = 0
  const stack = [{ dir, depth: 0 }]
  while (stack.length) {
    const item = stack.pop()
    let entries = []
    try { entries = await fsp.readdir(item.dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      visited += 1
      if (visited > cap) return count
      if (entry.isDirectory()) {
        if (dirs) count += 1
        if (item.depth + 1 < maxDepth) stack.push({ dir: path.join(item.dir, entry.name), depth: item.depth + 1 })
      } else if (!dirs && entry.isFile()) {
        count += 1
      }
    }
  }
  return count
}

/**
 * 与插件 `src/monitor.js` 的 `countSessions` 完全一致：
 * 真实布局是 `sessions/<workspace>/<session-id>/…`，数第二层目录；
 * 只有一层（旧布局/自定义）时退化为数第一层目录。
 */
export async function countSessionsDefault(dir) {
  let level1 = []
  try {
    level1 = (await fsp.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory())
  } catch {
    return 0
  }
  if (!level1.length) return 0
  let sessions = 0
  for (const workspace of level1) {
    let children = []
    try {
      children = await fsp.readdir(path.join(dir, workspace.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) if (child.isDirectory()) sessions += 1
  }
  return sessions || level1.length
}

/** 把 scanHome 结果转成与心跳 `stats` 同形状的统计（用于无心跳时兜底对比）。 */
export function scanStats(homeStats) {
  if (!homeStats || homeStats.ok !== true) return null
  return {
    files: asNumber(homeStats.files, 0),
    bytes: asNumber(homeStats.bytes, 0),
    sessions: asNumber(homeStats.sessions, 0),
    storages: asNumber(homeStats.storages, 0),
    profiles: asNumber(homeStats.profiles, 0),
    attachments: asNumber(homeStats.attachments, 0),
    credentials: homeStats.credentials === true,
    keyFiles: homeStats.keyFiles || null,
  }
}

function keyFilesLost(before, after) {
  if (!isPlainObject(before) || !isPlainObject(after)) return []
  const lost = []
  for (const key of ['workspace', 'profile', 'credentials']) {
    const had = before[key] === true || (key === 'credentials' && before.credential === true)
    const has = after[key] === true || (key === 'credentials' && after.credential === true)
    if (had && !has) lost.push(key)
  }
  return lost
}

function diffLightStats(before, after) {
  const reasons = []
  if (!isPlainObject(before) || !isPlainObject(after)) return reasons
  const sessionsDelta = Math.abs(asNumber(before.sessions, 0) - asNumber(after.sessions, 0))
  if (sessionsDelta > 2) reasons.push(`sessions ${before.sessions} vs ${after.sessions}`)
  const storagesDelta = Math.abs(asNumber(before.storages, 0) - asNumber(after.storages, 0))
  if (storagesDelta > Math.max(20, Math.ceil(asNumber(before.storages, 0) * 0.1))) reasons.push(`storages ${before.storages} vs ${after.storages}`)
  const profilesDelta = Math.abs(asNumber(before.profiles, 0) - asNumber(after.profiles, 0))
  if (profilesDelta > 0) reasons.push(`profiles ${before.profiles} vs ${after.profiles}`)
  const attachmentsDelta = Math.abs(asNumber(before.attachments, 0) - asNumber(after.attachments, 0))
  if (attachmentsDelta > Math.max(20, Math.ceil(asNumber(before.attachments, 0) * 0.1))) reasons.push(`attachments ${before.attachments} vs ${after.attachments}`)
  if ((before.credentials === true) !== (after.credentials === true)) reasons.push('credentials 存在性不一致')
  if (keyFilesLost(before.keyFiles, after.keyFiles).length) reasons.push('keyFiles 不一致')
  return reasons
}

/**
 * 选出“current stats”。
 *
 * 原则（task-12）：baseline 与 current 必须同源 —— 优先用新鲜心跳里的 stats
 * （插件 monitor.js 的 computeLightStats 口径），扫描只在 DSH 不在/心跳过期时兜底。
 * 1.0.0 的误报就是拿“扫描的工作区目录数=7”去比“心跳的会话目录数=138”。
 */
export function resolveCurrentStats({ heartbeat, homeStats, thresholds, now = Date.now(), baseline } = {}) {
  const th = thresholds || THRESHOLD_DEFAULTS
  const hbStats = heartbeat?.present ? normalizeStats(heartbeat.stats) : null
  const hbLastSeen = asNumber(heartbeat?.lastSeen, 0)
  const hbAge = hbLastSeen ? now - hbLastSeen : null
  const heartbeatFresh = Boolean(heartbeat?.present && hbAge != null && hbAge <= th.heartbeatStaleMs)
  const heartbeatValid = Boolean(heartbeatFresh && hbStats && Number.isFinite(hbStats.files) && hbStats.files >= 0)
  const scanned = scanStats(homeStats)
  const warnings = []
  if (heartbeatValid) {
    const keyFiles = hbStats.keyFiles || scanned?.keyFiles || null
    const current = { ...hbStats, keyFiles }
    if (scanned) {
      const diffs = diffLightStats(hbStats, scanned)
      if (diffs.length) warnings.push(`stats-mismatch: ${diffs.join('；')}`)
    }
    return {
      source: 'heartbeat',
      stats: current,
      heartbeatStats: hbStats,
      scannedStats: scanned,
      heartbeatFresh,
      warnings,
    }
  }
  if (scanned) {
    return {
      source: 'scan',
      stats: scanned,
      heartbeatStats: hbStats,
      scannedStats: scanned,
      heartbeatFresh,
      warnings,
    }
  }
  return {
    source: 'none',
    stats: null,
    heartbeatStats: hbStats,
    scannedStats: null,
    heartbeatFresh,
    warnings: ['stats-unavailable'],
  }
}

/**
 * 只读遍历 DSH home：
 *   - files/bytes/dirs/topLevelCount 供“无心跳时”的兜底对比；
 *   - sessions/storages/profiles/attachments/keyFiles 用与插件 computeLightStats 完全相同的口径，
 *     保证 baseline 与 current 同源（1.0.0 把 sessions 数成工作区目录数 → 138→7 误报）。
 * 绝不写入、不跟随符号链接（Windows junction 会被 isSymbolicLink 捕获）。
 */
export async function scanHomeDefault({ home, excludes = [] } = {}) {
  const root = path.resolve(String(home || '.'))
  const out = {
    ok: true,
    home: root,
    exists: false,
    files: 0,
    bytes: 0,
    dirs: 0,
    sessions: 0,
    storages: 0,
    profiles: 0,
    attachments: 0,
    credentials: false,
    keyFiles: null,
    missingTop: [],
    missingKeyFiles: [],
    topLevelCount: 0,
    errors: 0,
  }
  try {
    const stat = await fsp.stat(root)
    if (!stat.isDirectory()) { out.exists = false; out.missingTop = ['<home>']; return out }
    out.exists = true
  } catch {
    out.exists = false
    out.missingTop = ['<home>']
    return out
  }
  const stack = [{ rel: '', abs: root }]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try { entries = await fsp.readdir(current.abs, { withFileTypes: true }) } catch { out.errors += 1; continue }
    if (current.rel === '') out.topLevelCount = entries.length
    for (const entry of entries) {
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name
      if (isExcluded(rel, excludes)) continue
      if (entry.isSymbolicLink()) continue
      const abs = path.join(current.abs, entry.name)
      if (entry.isDirectory()) {
        out.dirs += 1
        stack.push({ rel, abs })
        continue
      }
      if (!entry.isFile()) continue
      out.files += 1
      try { out.bytes += (await fsp.stat(abs)).size } catch { out.errors += 1 }
    }
  }
  // 与 src/monitor.js computeLightStats 完全一致的口径
  out.sessions = await countSessionsDefault(path.join(root, 'sessions'))
  out.storages = await countTreeDefault(path.join(root, 'storages'), { dirs: false, maxDepth: 3 })
  out.profiles = await countTreeDefault(path.join(root, 'profiles'), { dirs: true, maxDepth: 1 })
  out.attachments = await countTreeDefault(path.join(root, 'attachments'), { dirs: false, maxDepth: 3 })
  out.keyFiles = {
    workspace: await exists(path.join(root, 'storages', 'workspace.json')),
    profile: await exists(path.join(root, 'profiles', 'desktop', 'package.json')),
    credentials: await exists(path.join(root, '.credentials.yaml')),
  }
  out.credentials = out.keyFiles.credentials === true
  const topDirs = new Set()
  try {
    for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) topDirs.add(entry.name)
    }
  } catch { /* ignore */ }
  for (const name of ['sessions', 'storages', 'profiles']) {
    if (!topDirs.has(name)) out.missingTop.push(name)
  }
  if (!out.credentials) out.missingTop.push('.credentials.yaml')
  out.missingKeyFiles = Object.entries(out.keyFiles)
    .filter(([, present]) => present !== true)
    .map(([name]) => name)
  return out
}

export async function diskFreeDefault({ target } = {}) {
  const dir = path.resolve(String(target || '.'))
  try {
    const stat = await fsp.statfs(dir)
    const bsize = asNumber(stat.bsize, 0)
    const bavail = asNumber(stat.bavail, 0)
    if (bsize > 0 && bavail >= 0) {
      return { ok: true, path: dir, freeBytes: bsize * bavail, totalBytes: bsize * asNumber(stat.blocks, 0), source: 'statfs' }
    }
  } catch { /* 落到 PowerShell */ }
  return { ok: false, path: dir, freeBytes: null, totalBytes: null, source: 'unavailable' }
}

/* --------------------------------------------------------------- 备份检查 */

export function chunksOf(entry) {
  if (!entry || typeof entry !== 'object') return []
  if (Array.isArray(entry.c)) return entry.c.filter((h) => typeof h === 'string' && h)
  if (typeof entry.h === 'string' && entry.h) return [entry.h]
  return []
}

export async function scanBlobNames(blobDir) {
  const set = new Set()
  let prefixes = []
  try { prefixes = await fsp.readdir(blobDir) } catch { return set }
  for (const a of prefixes) {
    let subs = []
    try { subs = await fsp.readdir(path.join(blobDir, a)) } catch { continue }
    for (const b of subs) {
      let names = []
      try { names = await fsp.readdir(path.join(blobDir, a, b)) } catch { continue }
      for (const name of names) if (/^[0-9a-f]{64}$/.test(name)) set.add(name)
    }
  }
  return set
}

/** 仓库目录里除了我们自己的 monitor/隔离区外没有别的东西 → 视为“尚未初始化”，不是损坏。 */
async function looksUninitializedStore(storeDir) {
  try {
    const entries = await fsp.readdir(storeDir)
    return entries.filter((name) => name !== 'monitor' && name !== 'restore-quarantine').length === 0
  } catch {
    return false
  }
}

/**
 * 备份仓库检查。
 * quick: 只验证最新 N 份清单（每分钟一次，成本低）；
 * deep: 验证全部清单并给出每份快照状态（事故时或每小时一次）。
 */
export async function inspectBackup({
  storeDir,
  monitorDir,
  mode = 'quick',
  limit = 2,
  suspectFrom = 0,
  suspectTo = 0,
  now = Date.now(),
} = {}) {
  const out = {
    ok: true,
    mode,
    storeDir,
    initialized: false,
    missing: false,
    writable: null,
    snapshotsTotal: 0,
    blobCount: 0,
    checked: 0,
    corruptManifests: [],
    snapshots: [],
    bad: [],
    latestId: null,
    latestAt: 0,
    errors: [],
    durationMs: 0,
  }
  const started = Date.now()
  try {
    await fsp.access(storeDir)
  } catch {
    // 仓库还不存在：新装/还没跑过备份，交给心跳里的 backup.snapshots 判断是否“仓库丢了”。
    out.initialized = false
    out.missing = true
    out.ok = true
    out.pendingInit = true
    out.durationMs = Date.now() - started
    return out
  }
  const snapDir = path.join(storeDir, 'snapshots')
  let names = []
  try {
    names = (await fsp.readdir(snapDir)).filter((name) => name.endsWith('.json'))
  } catch (error) {
    const pendingInit = await looksUninitializedStore(storeDir)
    out.errors.push(error?.code === 'ENOENT' ? 'snapshots-dir-missing' : 'snapshots-dir-unreadable')
    out.ok = pendingInit
    out.pendingInit = pendingInit
    out.durationMs = Date.now() - started
    return out
  }
  out.initialized = true
  out.snapshotsTotal = names.length
  try {
    await fsp.mkdir(monitorDir, { recursive: true })
    const probe = path.join(monitorDir, `.write-probe-${process.pid}`)
    await fsp.writeFile(probe, 'ok')
    await fsp.unlink(probe)
    out.writable = true
  } catch {
    out.writable = false
  }
  const blobSet = await scanBlobNames(path.join(storeDir, 'blobs'))
  out.blobCount = blobSet.size
  const sorted = names.slice().sort().reverse()
  const chosen = mode === 'deep' ? sorted : sorted.slice(0, Math.max(0, limit))
  for (const name of chosen) {
    const id = name.slice(0, -5)
    const file = path.join(snapDir, name)
    let manifest = null
    try {
      manifest = JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch {
      out.corruptManifests.push({ id, error: 'unreadable' })
      continue
    }
    if (!isPlainObject(manifest) || !isPlainObject(manifest.files) || String(manifest.id || '') !== id) {
      out.corruptManifests.push({ id, error: 'bad-manifest' })
      continue
    }
    const missing = []
    const maxMissing = mode === 'deep' ? 200 : 50
    for (const [rel, entry] of Object.entries(manifest.files)) {
      const chunks = chunksOf(entry)
      if (!chunks.length) {
        if (asNumber(entry?.s, -1) !== 0) missing.push(rel)
        continue
      }
      if (chunks.some((hash) => !blobSet.has(hash))) missing.push(rel)
      if (missing.length >= maxMissing) break
    }
    const at = asNumber(manifest.at, 0)
    const status = missing.length ? 'missing-blobs' : 'ok'
    const suspect = Boolean(suspectFrom && at >= suspectFrom && at <= (suspectTo || now))
    const snap = {
      id,
      at,
      files: Object.keys(manifest.files).length,
      status,
      suspect,
      missing: missing.slice(0, 20),
      missingCount: missing.length,
    }
    out.snapshots.push(snap)
    if (status !== 'ok') out.bad.push({ id, at, status, missing: snap.missing, missingCount: snap.missingCount })
    else if (suspect) out.bad.push({ id, at, status: 'suspect', missing: [], missingCount: 0 })
  }
  out.snapshots.sort((a, b) => (b.at || 0) - (a.at || 0))
  out.checked = out.snapshots.length
  out.latestId = out.snapshots[0]?.id || null
  out.latestAt = out.snapshots[0]?.at || 0
  out.ok = out.writable !== false && out.corruptManifests.length === 0 &&
    !out.snapshots.some((snap) => snap.status === 'missing-blobs')
  out.durationMs = Date.now() - started
  return out
}

export function recommendFromBackup(backup, draft) {
  const snapshots = (backup?.snapshots || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0))
  const cutoff = draft?.kind === 'backup-corrupt' ? Number.MAX_SAFE_INTEGER : (draft?.firstAt || Date.now())
  const candidates = snapshots.filter((snap) => (snap.at || 0) > 0 && (snap.at || 0) <= cutoff && snap.status === 'ok' && !snap.suspect)
  if (!candidates.length) {
    return { snapshotId: null, at: 0, reason: '没有早于事故时间且已验证完整（缺块=0）的快照', verified: false }
  }
  const best = candidates[0]
  return {
    snapshotId: best.id,
    at: best.at,
    reason: draft?.kind === 'crash' ? '崩溃前最后一份已验证快照' : '事故前最后一份已验证快照',
    verified: true,
  }
}

/** 异地仓库文件级交叉校验（不解释密，解密级校验由面板解锁后做）。 */
export async function inspectOffsite({ storeDir, heartbeat, now = Date.now() } = {}) {
  const root = path.join(storeDir, 'offsite')
  const out = {
    configured: false,
    checked: 0,
    bad: [],
    ledgerOk: true,
    archives: 0,
    repoPresent: false,
    lastExportAt: 0,
    lastSyncAt: 0,
  }
  let rootExists = false
  try { rootExists = (await fsp.stat(root)).isDirectory() } catch { rootExists = false }
  if (!rootExists) return out
  const ledger = await readJsonSafe(path.join(root, 'ledger.json'), null)
  if (ledger == null) return out
  if (!isPlainObject(ledger)) {
    out.ledgerOk = false
    out.bad.push({ reason: 'ledger-unreadable' })
    return out
  }
  const archives = Array.isArray(ledger.archives) ? ledger.archives : []
  out.archives = archives.length
  out.configured = archives.length > 0 || heartbeat?.offsite?.configured === true
  out.lastExportAt = asNumber(ledger.lastExportAt, 0)
  out.lastSyncAt = asNumber(ledger.lastSyncAt, 0)
  let manifestNames = null
  try { manifestNames = new Set(await fsp.readdir(path.join(root, 'repo', 'manifests'))) } catch { manifestNames = null }
  out.repoPresent = manifestNames != null
  for (const item of archives.slice(0, 500)) {
    out.checked += 1
    const rawName = item?.manifestName || item?.manifest || ''
    const name = rawName ? path.basename(String(rawName)) : ''
    if (name && manifestNames && !manifestNames.has(name)) {
      out.bad.push({ snapshotId: item?.snapshotId || null, reason: 'manifest-missing', at: asNumber(item?.at, 0) })
    }
  }
  if (out.bad.length) out.ledgerOk = false
  return out
}

/* --------------------------------------------------------------- 锁 */

function defaultIsPidAlive(pid) {
  const n = asNumber(pid, 0)
  if (!n || n === process.pid) return true
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 单实例锁：`monitor\watchdog.lock`。
 * 超过 staleMs（默认 2 分钟）或锁里 pid 已死 → 视为过期，抢占后重试一次。
 */
export async function acquireLock(lockPath, {
  now = Date.now(),
  staleMs = THRESHOLD_DEFAULTS.lockStaleMs,
  pid = process.pid,
  isAlive = defaultIsPidAlive,
} = {}) {
  await fsp.mkdir(path.dirname(lockPath), { recursive: true })
  const token = `${pid}-${now}-${Math.random().toString(36).slice(2, 10)}`
  const body = JSON.stringify({ v: 1, pid, token, startedAt: now, host: os.hostname() })
  const attempt = async () => {
    try {
      const handle = await fsp.open(lockPath, 'wx')
      try { await handle.writeFile(body) } finally { await handle.close() }
      return true
    } catch (error) {
      if (error?.code === 'EEXIST') return false
      throw error
    }
  }
  const makeRelease = () => async () => {
    try {
      const info = JSON.parse(await fsp.readFile(lockPath, 'utf8'))
      if (info && info.token === token) await fsp.unlink(lockPath)
    } catch { /* 不是自己的锁或已删除 */ }
  }
  if (await attempt()) return { held: true, token, path: lockPath, release: makeRelease() }

  let info = null
  let mtimeMs = 0
  try {
    const [raw, stat] = await Promise.all([fsp.readFile(lockPath, 'utf8'), fsp.stat(lockPath)])
    mtimeMs = stat.mtimeMs
    info = JSON.parse(raw)
  } catch { /* 锁刚好被释放或内容坏 */ }
  const startedAt = asNumber(info?.startedAt, 0) || mtimeMs || 0
  const age = startedAt ? now - startedAt : Number.MAX_SAFE_INTEGER
  const pidDead = info?.pid ? !isAlive(info.pid) : false
  const stale = age > staleMs || pidDead
  if (!stale) {
    return {
      held: false,
      reason: 'locked',
      path: lockPath,
      lock: info ? { pid: info.pid, startedAt: info.startedAt, ageMs: age } : null,
    }
  }
  try { await fsp.unlink(lockPath) } catch { /* 别人先删了 */ }
  if (await attempt()) return { held: true, token, path: lockPath, release: makeRelease(), stolen: true }
  return { held: false, reason: 'lock-race', path: lockPath }
}

/* --------------------------------------------------------------- 分类 */

/**
 * 纯分类：把采集到的输入映射成事故草稿。所有规则见 docs/CRASH-MONITORING.md §3。
 * 不写文件、不发通知、不杀进程。
 */
export function classifyAll({
  config,
  now = Date.now(),
  heartbeat,
  baseline,
  processInfo,
  events,
  homeStats,
  currentStats,
  backup,
  offsite,
  disk,
  state,
} = {}) {
  const th = config?.thresholds || THRESHOLD_DEFAULTS
  const drafts = []
  const suppressed = []
  const warnings = []
  const hb = heartbeat || {}
  const lastSeen = asNumber(hb.lastSeen, 0)
  const heartbeatAge = lastSeen ? now - lastSeen : null
  const appEvents = Array.isArray(events?.application) ? events.application : []
  const sysEvents = Array.isArray(events?.system) ? events.system : []
  const processOk = processInfo?.ok === true
  const processAlive = processOk && processInfo.alive === true
  const nearLastSeen = (event) => {
    if (!lastSeen) return false
    return (event.time || 0) >= lastSeen - th.sleepGraceMs && (event.time || 0) <= lastSeen + 120000
  }
  const sleepShutdown = sysEvents.filter((event) => [42, 107, 1074].includes(event.id) && nearLastSeen(event))
  const recentSleep = sysEvents.filter((event) => [42, 107].includes(event.id) && now - (event.time || 0) <= th.sleepGraceMs)
  const sleepWindow = sleepShutdown.length > 0 || recentSleep.length > 0 || asNumber(state?.suppressUntil, 0) > now
  const powerEvents = sysEvents.filter((event) => [41, 6008].includes(event.id) && nearLastSeen(event))
  const crashEvidenceEvents = [
    ...appEvents.filter((event) => [1000, 1001, 1002].includes(event.id)),
    ...powerEvents,
  ].slice(-20)
  const wasRunning = Boolean(state?.process?.alive || state?.process?.firstSeenAt || hb.pid)
  const health = {
    heartbeatFresh: Boolean(hb.present && heartbeatAge != null && heartbeatAge <= th.heartbeatStaleMs),
    processAlive,
    processQueryOk: processOk,
    homeScanOk: homeStats?.ok === true,
    sleepWindow,
    healthy: false,
  }

  /* crash */
  if (
    hb.present && lastSeen && heartbeatAge > th.heartbeatStaleMs && hb.cleanExit !== true &&
    processOk && !processAlive && wasRunning && heartbeatAge <= th.crashLookbackMs
  ) {
    if (sleepWindow) {
      suppressed.push({ kind: 'crash', reason: 'sleep-or-shutdown', events: sleepShutdown.slice(0, 5) })
    } else {
      const powerLoss = powerEvents.length > 0
      drafts.push({
        kind: 'crash',
        severity: powerLoss ? 'critical' : 'high',
        firstAt: lastSeen,
        lastAt: lastSeen + 5000,
        summary: `DSH 于 ${formatClock(lastSeen)} 异常退出：心跳断档 ${formatDuration(heartbeatAge)}，进程不存在` +
          (powerLoss ? '（事件日志显示非正常断电/关机）' : ''),
        evidence: {
          heartbeat: { lastSeen, gapMs: heartbeatAge, bootId: hb.bootId, pid: hb.pid, cleanExit: hb.cleanExit },
          process: processInfo?.main ? { pid: processInfo.main.pid, startedAt: processInfo.main.startedAt, alive: false } : { alive: false },
          processQuery: { ok: processOk, count: processInfo?.count ?? 0 },
          events: crashEvidenceEvents,
          powerLoss,
          lastAction: hb.lastAction,
        },
        timeline: [
          { at: lastSeen, type: 'last-heartbeat', detail: `最后一次心跳 ${formatDateTime(lastSeen)}` },
          { at: now, type: 'process-check', detail: `未找到运行中的 ${config?.process?.name || DEFAULT_PROCESS_NAME}` },
          ...crashEvidenceEvents.map((event) => ({
            at: event.time,
            type: 'event-log',
            detail: `${event.log} ${event.provider || ''} ${event.id} recordId=${event.recordId}`,
          })),
        ],
      })
    }
  }

  /* hang */
  if (hb.present && lastSeen && processAlive && heartbeatAge > th.hangStaleMs) {
    if (sleepWindow) {
      suppressed.push({ kind: 'hang', reason: 'sleep-or-shutdown' })
    } else {
      drafts.push({
        kind: 'hang',
        severity: 'medium',
        firstAt: lastSeen + th.heartbeatStaleMs,
        lastAt: now,
        summary: `DSH 进程仍在（pid ${processInfo.main?.pid || hb.pid}）但心跳已停 ${formatDuration(heartbeatAge)}，疑似卡死/无响应`,
        evidence: {
          heartbeat: { lastSeen, gapMs: heartbeatAge, bootId: hb.bootId, pid: hb.pid },
          process: processInfo?.main || null,
          processQuery: { ok: processOk, count: processInfo?.count ?? 0 },
          client: hb.client || null,
          events: crashEvidenceEvents,
        },
        timeline: [
          { at: lastSeen, type: 'last-heartbeat', detail: `最后一次心跳 ${formatDateTime(lastSeen)}` },
          { at: now, type: 'process-check', detail: `进程在（pid ${processInfo?.main?.pid || hb.pid}），心跳断档 ${formatDuration(heartbeatAge)}` },
        ],
      })
    }
  }

  /* data-loss */
  const baseStats = baseline?.present ? baseline.stats : null
  const currentStatsSafe = currentStats || (
    homeStats?.ok === true
      ? { source: 'scan', stats: scanStats(homeStats), scannedStats: scanStats(homeStats), heartbeatStats: hb.stats || null }
      : { source: 'none', stats: null, scannedStats: null, heartbeatStats: hb.stats || null }
  )
  const curStats = currentStatsSafe.stats
  const statsSource = currentStatsSafe.source || 'none'
  health.statsSource = statsSource
  if (baseStats && curStats) {
    const baseFiles = asNumber(baseStats.files, 0)
    const curFiles = asNumber(curStats.files, 0)
    const deltaFiles = baseFiles - curFiles
    const fileThreshold = Math.max(th.dataLossMinFiles, Math.floor(baseFiles * th.dataLossRatio))
    // baseline 与 current 必须同源才比 files：插件 baseline 来自心跳清单（已备份文件），
    // 扫描兜底来自全树文件数，两者语义不同，直接比会误报。
    const baselineSource = baseline?.statsSource || 'heartbeat'
    const filesComparable = baselineSource === statsSource
    const filesDropped = filesComparable && deltaFiles > fileThreshold
    const sessionsDrop = asNumber(baseStats.sessions, 0) - asNumber(curStats.sessions, 0)
    const sessionsDropped = asNumber(baseStats.sessions, 0) > 0 &&
      sessionsDrop >= Math.max(1, Math.ceil(asNumber(baseStats.sessions, 0) * th.dataLossSessionsRatio))
    const lostCredentials = baseStats.credentials === true && curStats.credentials === false
    const lostKeyFiles = keyFilesLost(baseStats.keyFiles, curStats.keyFiles)
    const lostProfiles = asNumber(baseStats.profiles, 0) > 0 && asNumber(curStats.profiles, 0) === 0
    const lostStorages = asNumber(baseStats.storages, 0) > 0 && asNumber(curStats.storages, 0) === 0
    const homeGone = statsSource === 'scan' && homeStats?.exists === false && baseFiles > 0
    if (filesDropped || sessionsDropped || lostCredentials || lostKeyFiles.length || lostProfiles || lostStorages || homeGone) {
      const parts = []
      if (homeGone) parts.push('DSH 数据目录不存在')
      if (filesDropped) parts.push(`文件数 ${baseFiles} → ${curFiles}（-${deltaFiles}）`)
      if (sessionsDropped) parts.push(`sessions ${asNumber(baseStats.sessions, 0)} → ${asNumber(curStats.sessions, 0)}`)
      if (lostCredentials) parts.push('.credentials.yaml 消失')
      if (lostKeyFiles.length) parts.push(`关键文件消失（${lostKeyFiles.join(', ')}）`)
      if (lostProfiles) parts.push('profiles 目录消失/清空')
      if (lostStorages) parts.push('storages 目录消失/清空')
      drafts.push({
        kind: 'data-loss',
        severity: 'critical',
        firstAt: now,
        lastAt: now,
        summary: `数据骤降：${parts.join('；')}`,
        evidence: {
          data: {
            before: baseStats,
            after: curStats,
            delta: { files: filesDropped ? -deltaFiles : 0, sessions: -sessionsDrop },
            statsSource,
            baselineStatsSource: baselineSource,
            filesComparable,
            scannedStats: currentStatsSafe.scannedStats || null,
            heartbeatStats: currentStatsSafe.heartbeatStats || null,
            missingTop: homeStats?.missingTop || [],
            missingKeyFiles: homeStats?.missingKeyFiles || [],
            baselineAt: baseline.at || 0,
            baselineSource: baseline.source || '',
          },
          // 当前进程命令行快照：只进事故文件（本地取证），绝不进通知正文。
          process: processInfo?.ok ? {
            alive: processInfo.alive === true,
            count: processInfo.count || 0,
            main: processInfo.main || null,
            processes: (processInfo.processes || []).slice(0, 10).map((item) => ({
              pid: item.pid,
              name: item.name,
              startedAt: item.startedAt,
              commandLine: item.commandLine,
            })),
          } : { ok: false },
        },
        timeline: [
          { at: baseline.at || 0, type: 'baseline', detail: `基线 ${baseFiles} 文件 / ${baseStats.sessions} sessions（${baselineSource}）` },
          { at: now, type: 'stats', detail: `当前 ${curFiles} 文件 / ${curStats.sessions} sessions（${statsSource}）` },
        ],
      })
    } else if (!filesComparable && baseFiles > 0 && deltaFiles > fileThreshold) {
      // 同源原则：源不同不比 files，只记录，不判事故。
      warnings.push(`stats-source-mismatch: baseline=${baselineSource} current=${statsSource}，跳过文件数对比`)
    }
  }

  /* backup-corrupt */
  if (backup) {
    const missingStore = backup.missing === true && asNumber(hb.backup?.snapshots, 0) > 0
    const badSnapshots = (backup.snapshots || []).filter((snap) => snap.status !== 'ok')
    const corrupt = backup.corruptManifests || []
    const notWritable = backup.writable === false
    if (missingStore || badSnapshots.length || corrupt.length || notWritable) {
      const parts = []
      if (missingStore) parts.push(`备份仓库不存在（心跳报告 ${asNumber(hb.backup?.snapshots, 0)} 份快照）`)
      if (corrupt.length) parts.push(`${corrupt.length} 份快照清单不可读（${corrupt.slice(0, 3).map((item) => item.id).join(', ')}）`)
      for (const snap of badSnapshots.slice(0, 3)) {
        parts.push(`快照 ${snap.id} 缺失 ${snap.missingCount} 个内容块（如 ${snap.missing[0] || '?'}）`)
      }
      if (notWritable) parts.push('备份仓库不可写')
      drafts.push({
        kind: 'backup-corrupt',
        severity: 'high',
        firstAt: now,
        lastAt: now,
        summary: `备份仓库异常：${parts.join('；')}`,
        evidence: {
          backup: {
            mode: backup.mode,
            checked: backup.checked,
            snapshotsTotal: backup.snapshotsTotal,
            blobCount: backup.blobCount,
            writable: backup.writable,
            bad: backup.bad || [],
            corruptManifests: corrupt,
            errors: backup.errors || [],
          },
          offsite: offsite || null,
        },
        timeline: [
          { at: now, type: 'backup-scan', detail: `检查 ${backup.checked}/${backup.snapshotsTotal} 份清单（${backup.mode}）` },
        ],
      })
    }
  }

  /* offsite-stale */
  const hbOffsite = hb.offsite
  if (hbOffsite && hbOffsite.configured) {
    let reason = null
    if (hbOffsite.archives > 0 && !hbOffsite.lastSyncAt) reason = `已导出 ${hbOffsite.archives} 份但从未同步到子机`
    else if (hbOffsite.lastExportAt && now - hbOffsite.lastExportAt > th.offsiteStaleMs) reason = `已 ${formatDuration(now - hbOffsite.lastExportAt)} 未导出`
    else if (hbOffsite.lastSyncAt && now - hbOffsite.lastSyncAt > th.offsiteStaleMs) reason = `已 ${formatDuration(now - hbOffsite.lastSyncAt)} 未同步`
    else if (offsite?.bad?.length) reason = `子机仓库清单与 ledger 不一致（${offsite.bad.length} 项）`
    if (reason) {
      drafts.push({
        kind: 'offsite-stale',
        severity: 'medium',
        firstAt: now,
        lastAt: now,
        summary: `异地副本过期：${reason}`,
        evidence: { offsite: { ...hbOffsite, local: offsite || null } },
        timeline: [{ at: now, type: 'offsite-check', detail: reason }],
      })
    }
  }

  /* disk-low */
  if (disk?.ok && disk.freeBytes != null && asNumber(disk.freeBytes, 0) < th.diskLowFreeBytes) {
    drafts.push({
      kind: 'disk-low',
      severity: 'medium',
      firstAt: now,
      lastAt: now,
      summary: `备份盘剩余 ${formatBytes(disk.freeBytes)}，低于阈值 ${formatBytes(th.diskLowFreeBytes)}`,
      evidence: { disk: { path: disk.path, freeBytes: disk.freeBytes, totalBytes: disk.totalBytes, source: disk.source } },
      timeline: [{ at: now, type: 'disk-check', detail: `${disk.path} 剩余 ${formatBytes(disk.freeBytes)}` }],
    })
  }

  const critical = drafts.some((draft) => draft.kind === 'data-loss' || draft.kind === 'backup-corrupt')
  health.healthy = Boolean(
    hb.present && health.heartbeatFresh && curStats && statsSource === 'heartbeat' &&
    backup?.ok !== false && !critical,
  )
  return { drafts, suppressed, sleepWindow, health, warnings, statsSource }
}

/* --------------------------------------------------------------- 事故 I/O */

export function makeIncidentId(nowMs, kind) {
  const d = new Date(nowMs)
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  return `${stamp}-${String(kind || 'incident').replace(/[^a-z0-9-]/gi, '')}`
}

export async function nextIncidentId(incidentsDir, nowMs, kind) {
  const base = makeIncidentId(nowMs, kind)
  let id = base
  for (let i = 2; i < 100; i += 1) {
    if (!(await exists(path.join(incidentsDir, `${id}.json`)))) return id
    id = `${base}-${i}`
  }
  return `${base}-${Date.now().toString(36)}`
}

/**
 * 读“已忽略”集合。插件 monitor.js 写 `<monitor>/alerts/ack.json`
 * （`{v:1,acked:{id:epochMs}}`）；同时兼容老的 `<monitor>/ack.json`。
 * ack 过的同 kind 事故看门狗不再重建/再通知。
 */
export async function readAcks(monitorDir) {
  const candidates = [
    path.join(monitorDir, 'alerts', 'ack.json'),
    path.join(monitorDir, 'ack.json'),
  ]
  const set = new Set()
  for (const file of candidates) {
    const raw = await readJsonSafe(file, null)
    if (!isPlainObject(raw)) continue
    if (Array.isArray(raw.acked)) {
      for (const id of raw.acked) set.add(String(id))
    } else if (isPlainObject(raw.acked)) {
      for (const [id, value] of Object.entries(raw.acked)) {
        if (value === false) continue
        set.add(String(id))
      }
    }
    for (const key of ['ackedIds', 'ignored', 'ignoredIds']) {
      if (Array.isArray(raw[key])) for (const id of raw[key]) set.add(String(id))
    }
  }
  return set
}

async function readIncidentFile(file) {
  const incident = await readJsonSafe(file, null)
  if (!isPlainObject(incident) || !incident.id || !incident.kind) return null
  return incident
}

export async function findOpenIncident({
  incidentsDir,
  kind,
  state,
  now = Date.now(),
  dedupeMs = THRESHOLD_DEFAULTS.dedupeMs,
  acked = new Set(),
  scanLimit = 30,
} = {}) {
  const within = (incident) => isPlainObject(incident) &&
    incident.kind === kind && incident.status === 'open' && !acked.has(String(incident.id)) &&
    now - asNumber(incident.lastAt || incident.detectedAt, 0) <= dedupeMs
  const referenced = state?.incidents?.[kind]?.id
  if (referenced) {
    const incident = await readIncidentFile(path.join(incidentsDir, `${referenced}.json`))
    if (incident && within(incident)) return incident
  }
  let names = []
  try { names = (await fsp.readdir(incidentsDir)).filter((name) => name.endsWith('.json')).sort().reverse().slice(0, scanLimit) } catch { return null }
  for (const name of names) {
    const incident = await readIncidentFile(path.join(incidentsDir, name))
    if (incident && within(incident)) return incident
  }
  return null
}

export async function mergeIncident(existing, draft, { now = Date.now() } = {}) {
  const incident = clone(existing)
  incident.lastAt = Math.max(asNumber(incident.lastAt, 0), asNumber(draft.lastAt, now), now)
  incident.summary = draft.summary || incident.summary
  incident.timeline = [
    ...(Array.isArray(incident.timeline) ? incident.timeline : []),
    { at: now, type: 'repeat', detail: draft.summary || '同类事故再次检测到' },
  ].slice(-50)
  if (draft.evidence) incident.evidence = { ...(incident.evidence || {}), ...draft.evidence, previous: incident.evidence || null }
  if (draft.impact) incident.impact = draft.impact
  if (draft.recommendation && !incident.recommendation?.snapshotId) incident.recommendation = draft.recommendation
  incident.updatedAt = now
  return incident
}

export async function buildIncident({
  draft,
  config,
  now = Date.now(),
  hostname,
  home,
  storeDir,
  incidentsDir,
} = {}) {
  const id = await nextIncidentId(incidentsDir, now, draft.kind)
  return {
    v: 1,
    id,
    kind: draft.kind,
    status: 'open',
    severity: draft.severity || 'high',
    source: 'watchdog',
    detectedAt: now,
    firstAt: asNumber(draft.firstAt, now),
    lastAt: asNumber(draft.lastAt, now),
    recoveredAt: 0,
    host: hostname || config?.hostname || os.hostname(),
    home: home || config?.home || '',
    storeRoot: config?.storeRoot || '',
    storeDir: storeDir || '',
    summary: draft.summary || KIND_LABELS[draft.kind] || draft.kind,
    timeline: [
      { at: now, type: 'detected', detail: draft.summary || '检测到事故' },
      ...(Array.isArray(draft.timeline) ? draft.timeline : []),
    ].slice(-60),
    evidence: draft.evidence || {},
    impact: draft.impact || {},
    recommendation: draft.recommendation || { snapshotId: null, at: 0, reason: '未评估', verified: false },
    recovery: { status: 'none', restoredAt: 0, quarantine: null, report: null },
    notify: { at: 0, channels: [] },
  }
}

export function incidentSummaryEntry(incident) {
  return {
    id: incident.id,
    kind: incident.kind,
    severity: incident.severity || 'high',
    status: incident.status || 'open',
    detectedAt: asNumber(incident.detectedAt, 0),
    firstAt: asNumber(incident.firstAt, 0),
    lastAt: asNumber(incident.lastAt, 0),
    summary: incident.summary || '',
    source: incident.source || 'watchdog',
    recommendation: incident.recommendation || null,
  }
}

/**
 * 重建 alerts/current.json：
 *   - 保留其它来源（source !== 'watchdog'）的条目与未知顶层键；
 *   - 双写 `open` 与 `incidents`，兼容插件内 monitor.js 与面板两种读法。
 */
export async function rebuildAlerts({
  monitorDir,
  incidentsDir,
  now = Date.now(),
  config,
  heartbeat,
  channels = [],
} = {}) {
  const acked = await readAcks(monitorDir)
  const maxAgeMs = asNumber(config?.thresholds?.alertMaxAgeDays, 7) * 86400000
  let names = []
  try { names = (await fsp.readdir(incidentsDir)).filter((name) => name.endsWith('.json')).sort().reverse().slice(0, 300) } catch { names = [] }
  const ours = []
  for (const name of names) {
    const incident = await readIncidentFile(path.join(incidentsDir, name))
    if (!incident) continue
    if (incident.status !== 'open') continue
    if (acked.has(String(incident.id))) continue
    if (now - asNumber(incident.lastAt || incident.detectedAt, 0) > maxAgeMs) continue
    ours.push(incidentSummaryEntry(incident))
  }
  ours.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
  const alertsFile = path.join(monitorDir, 'alerts', 'current.json')
  const existing = await readJsonSafe(alertsFile, null)
  const foreign = []
  const collectForeign = (list) => {
    if (!Array.isArray(list)) return
    for (const item of list) {
      if (!isPlainObject(item) || !item.id) continue
      if (item.source === 'watchdog') continue
      if (ours.some((entry) => entry.id === item.id)) continue
      if (!foreign.some((entry) => entry.id === item.id)) foreign.push(item)
    }
  }
  if (isPlainObject(existing)) {
    collectForeign(existing.open)
    collectForeign(existing.incidents)
  }
  const entries = [...foreign, ...ours].sort((a, b) => (b.lastAt || b.detectedAt || 0) - (a.lastAt || a.detectedAt || 0))
  const latestOverall = entries[0] || (isPlainObject(existing) ? existing.last : null) || null
  const payload = {
    ...(isPlainObject(existing) ? existing : {}),
    v: 1,
    at: now,
    updatedAt: now,
    source: 'watchdog',
    open: entries,
    incidents: entries,
    count: entries.length,
    last: latestOverall,
    watchdog: {
      lastRunAt: now,
      ok: true,
      pid: process.pid,
      version: WATCHDOG_VERSION,
      host: config?.hostname || os.hostname(),
      heartbeat: heartbeat ? { lastSeen: heartbeat.lastSeen, ageMs: heartbeat.lastSeen ? now - heartbeat.lastSeen : null } : null,
    },
    channels: Array.isArray(channels) ? channels.slice(-6) : [],
  }
  await writeJsonAtomic(alertsFile, payload)
  return { path: alertsFile, count: entries.length, ours: ours.length, foreign: foreign.length }
}

/* ------------------------------------------------------------- 通知通道 */

export function buildNotifyPayload(incident, config = {}) {
  const host = incident.host || config.hostname || os.hostname()
  const kindLabel = KIND_LABELS[incident.kind] || incident.kind
  const recommendation = incident.recommendation || {}
  const recommendationText = recommendation.snapshotId
    ? `推荐恢复点：${recommendation.snapshotId}（${formatDateTime(recommendation.at)}，已验证）`
    : '推荐恢复点：暂无（请在面板查看受影响快照）'
  const snapshotTotal = asNumber(incident.impact?.local?.total, 0) || null
  // 通知正文严格只含主机名/事故类型/时间/推荐恢复点/快照数，不含路径明细与文件内容。
  const lines = [
    `${formatDateTime(incident.detectedAt)} · ${host}`,
    `事故类型：${kindLabel}（${incident.severity || 'high'}）`,
    recommendationText,
  ]
  if (snapshotTotal) lines.push(`本地快照：${snapshotTotal} 份`)
  lines.push(`事故编号：${incident.id}`)
  const body = lines.join('\n')
  return {
    title: `[DSH] ${kindLabel}`,
    body,
    text: `${body}`,
    host,
    kind: incident.kind,
    severity: incident.severity,
    incidentId: incident.id,
    incident: {
      id: incident.id,
      kind: incident.kind,
      severity: incident.severity,
      detectedAt: incident.detectedAt,
      host,
      summary: kindLabel,
      recommendation: recommendation.snapshotId
        ? { snapshotId: recommendation.snapshotId, at: recommendation.at, verified: recommendation.verified === true }
        : null,
    },
  }
}

export async function postJsonWithRetry({
  url,
  payload,
  headers = {},
  retries = 2,
  timeoutMs = 8000,
  fetchFn = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now(),
} = {}) {
  let attempts = 0
  let lastError = null
  const total = Math.max(0, asNumber(retries, 0)) + 1
  for (let i = 0; i < total; i += 1) {
    attempts += 1
    let timer = null
    try {
      if (typeof fetchFn !== 'function') throw new Error('fetch-unavailable')
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      if (controller) timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs))
      let response
      try {
        response = await fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(payload),
          signal: controller ? controller.signal : undefined,
        })
      } finally {
        if (timer) clearTimeout(timer)
      }
      if (response && (response.ok === true || (response.status >= 200 && response.status < 300))) {
        return { ok: true, attempts, status: response.status }
      }
      lastError = `http-${response?.status ?? 'unknown'}`
    } catch (error) {
      lastError = error?.name === 'AbortError' ? 'timeout' : String(error?.message || error).slice(0, 160)
    }
    if (i < total - 1) await sleep(Math.min(2000, 250 * 2 ** i))
  }
  return { ok: false, attempts, error: lastError, at: now }
}

function channelResult(channel, extra = {}) {
  return { channel, ok: false, attempts: 0, ...extra }
}

/**
 * 饱和式 fan-out：所有已启用通道并行/顺序都发，单通道失败只记结果。
 * 返回 { results, outboxFile, payload }。
 */
export async function notifyAll({
  incident,
  config,
  secrets,
  monitorDir,
  scriptDir = MODULE_DIR,
  deps,
  now = Date.now(),
} = {}) {
  const notifyCfg = config?.notify || NOTIFY_DEFAULTS
  const payload = buildNotifyPayload(incident, config)
  const results = []
  const runCommand = deps?.runCommand
  const fetchFn = deps?.fetchFn || globalThis.fetch
  const sleep = deps?.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const notificationsEnabled = deps?.notify !== false
  const secretData = secrets?.ok ? secrets.data || {} : {}

  // panel：alerts/current.json 由 rebuildAlerts 写；这里只记通道结果。
  results.push(channelResult('panel', { ok: true, detail: 'alerts/current.json' }))

  if (!notificationsEnabled) {
    results.push(channelResult('toast', { ok: false, skipped: true, reason: 'notify-disabled' }))
    results.push(channelResult('webhook', { ok: false, skipped: true, reason: 'notify-disabled' }))
    results.push(channelResult('email', { ok: false, skipped: true, reason: 'notify-disabled' }))
    results.push(channelResult('qq', { ok: false, skipped: true, reason: 'notify-disabled' }))
    results.push(channelResult('peer', { ok: false, skipped: true, reason: 'notify-disabled' }))
    return { results, outboxFile: null, payload }
  }

  // toast（Windows 通知，失败回退 msg/日志，脚本自身处理）
  if (notifyCfg.toast !== false) {
    const script = path.join(scriptDir, 'toast.ps1')
    if (await exists(script) && typeof runCommand === 'function') {
      const result = await runCommand('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Title', payload.title, '-Body', payload.body,
        '-LogPath', path.join(monitorDir, 'toast.log'),
      ], { timeoutMs: asNumber(notifyCfg.toastTimeoutMs, 20000) })
      results.push(channelResult('toast', { ok: result.ok === true, attempts: 1, code: result.code, error: result.ok ? null : 'toast-failed' }))
    } else {
      results.push(channelResult('toast', { skipped: true, reason: 'toast-script-missing' }))
    }
  } else {
    results.push(channelResult('toast', { skipped: true, reason: 'disabled' }))
  }

  // webhook（可多个，各自带重试）
  const hooks = Array.isArray(notifyCfg.webhook) ? notifyCfg.webhook : []
  if (!hooks.length) results.push(channelResult('webhook', { skipped: true, reason: 'not-configured' }))
  for (const hook of hooks) {
    if (hook.enabled === false) {
      results.push(channelResult('webhook', { name: hook.name, skipped: true, reason: 'disabled' }))
      continue
    }
    const token = (isPlainObject(secretData.webhook) && secretData.webhook[hook.name]) ||
      (hook.tokenSecret && secretData[hook.tokenSecret]) || null
    const headers = { 'user-agent': `dsh-watchdog/${WATCHDOG_VERSION}` }
    if (token) {
      headers.authorization = `Bearer ${token}`
      headers['x-webhook-token'] = String(token)
    }
    const result = await postJsonWithRetry({
      url: hook.url,
      payload: { ...payload, source: 'dsh-watchdog', version: WATCHDOG_VERSION },
      headers,
      retries: hook.retries,
      timeoutMs: hook.timeoutMs,
      fetchFn,
      sleep,
      now,
    })
    results.push(channelResult('webhook', {
      name: hook.name, ok: result.ok, attempts: result.attempts, status: result.status || null, error: result.error || null,
    }))
  }

  // email（PowerShell System.Net.Mail.SmtpClient，密码只经 stdin 传给脚本）
  const emailCfg = notifyCfg.email || {}
  if (emailCfg.enabled) {
    const script = path.join(scriptDir, 'notify.ps1')
    const password = (isPlainObject(secretData.smtp) && secretData.smtp.password) ||
      (secretData.email && secretData.email.password) || ''
    if (!emailCfg.host || !emailCfg.from || !emailCfg.to?.length) {
      results.push(channelResult('email', { skipped: true, reason: 'config-incomplete' }))
    } else if (emailCfg.user && !password) {
      results.push(channelResult('email', { skipped: true, reason: 'secret-unavailable' }))
    } else if (!(await exists(script)) || typeof runCommand !== 'function') {
      results.push(channelResult('email', { skipped: true, reason: 'notify-script-missing' }))
    } else {
      const mail = {
        host: emailCfg.host,
        port: emailCfg.port,
        useSsl: emailCfg.useSsl,
        user: emailCfg.user,
        password,
        from: emailCfg.from,
        to: emailCfg.to,
        subject: `${emailCfg.subjectPrefix || '[DSH]'} ${payload.title} (${incident.severity || 'high'})`,
        body: payload.body,
        timeoutMs: 20000,
      }
      const result = await runCommand('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Mode', 'Email',
      ], { input: JSON.stringify(mail), timeoutMs: 30000 })
      results.push(channelResult('email', {
        ok: result.ok === true, attempts: 1,
        error: result.ok ? null : String(result.stderr || 'smtp-failed').trim().split(/\s+/).slice(-1)[0] || 'smtp-failed',
      }))
    }
  } else {
    results.push(channelResult('email', { skipped: true, reason: 'disabled' }))
  }

  // qq（OneBot HTTP 直发；未配置/失败则写 outbox 等 DSH 起来后补发）
  const qqCfg = notifyCfg.qq || {}
  let qqQueued = false
  let qqResult = null
  if (qqCfg.enabled && qqCfg.http) {
    const base = String(qqCfg.http).replace(/\/+$/, '')
    const url = `${base}/${String(qqCfg.action || 'send_private_msg').replace(/^\/+/, '')}`
    const token = qqCfg.token || (isPlainObject(secretData.qq) && secretData.qq.token) || ''
    const headers = token ? { authorization: `Bearer ${token}`, 'x-self-id': '' } : {}
    const body = qqCfg.target ? { user_id: qqCfg.target, message: payload.text } : { message: payload.text }
    const result = await postJsonWithRetry({ url, payload: body, headers, retries: notifyCfg.retries, fetchFn, sleep, now, timeoutMs: 8000 })
    qqResult = channelResult('qq', { ok: result.ok, attempts: result.attempts, error: result.error || null, queued: !result.ok })
    qqQueued = !result.ok
    results.push(qqResult)
  } else if (qqCfg.enabled) {
    // 配置了 qq 但没给 OneBot HTTP：不静默丢弃，写 outbox 等通道补全后补发。
    qqQueued = true
    qqResult = channelResult('qq', { ok: false, queued: true, reason: 'no-http' })
    results.push(qqResult)
  } else {
    results.push(channelResult('qq', { skipped: true, reason: 'disabled' }))
  }

  // peer（DSH 侧专属通道：外部进程没有 ctx.dshSync，永远只排队；由插件起来后经 dsh-sync 推子机）
  const peerEnabled = notifyCfg.peer?.enabled === true
  results.push(channelResult('peer', {
    ok: peerEnabled, queued: true, detail: 'outbox', waitingFor: 'plugin',
    ...(peerEnabled ? {} : { reason: 'disabled-queued' }),
  }))

  let outboxFile = null
  // peer 无论是否启用都写 outbox（这是 DSH 侧才能发出去的通道；插件消费后再标 sent）。
  {
    const outboxDir = path.join(monitorDir, 'outbox')
    outboxFile = path.join(outboxDir, `${incident.id}.json`)
    const entry = {
      v: 1,
      id: incident.id,
      incidentId: incident.id,
      kind: incident.kind,
      severity: incident.severity,
      detectedAt: incident.detectedAt,
      createdAt: now,
      updatedAt: now,
      status: 'pending',
      attempts: 0,
      host: payload.host,
      summary: KIND_LABELS[incident.kind] || incident.kind,
      channels: {},
      payload: {
        title: payload.title,
        body: payload.body,
        host: payload.host,
        incident: payload.incident,
      },
    }
    if (qqQueued) entry.channels.qq = { status: 'pending', attempts: qqResult?.attempts || 0, lastError: qqResult?.error || null }
    entry.channels.peer = { status: 'pending', attempts: 0, waitingFor: 'plugin' }
    await writeJsonAtomic(outboxFile, entry)
  }
  return { results, outboxFile, payload }
}

/** outbox 的 channels 既可能是对象 map，也可能是旧版数组（插件 monitor.js 早期格式）。 */
export function normalizeOutboxChannels(entry) {
  const raw = entry?.channels
  const map = {}
  const put = (name, value) => {
    const key = String(name || '').trim()
    if (!key) return
    if (isPlainObject(value)) {
      // 保留我们不认识的字段（例如插件写的 deliveredAt / lastError:{code,message}），
      // 只归一化已知字段，避免两边 read-modify-write 互相把对方的字段洗掉。
      const channel = { ...value }
      channel.status = String(channel.status || (channel.sent === true ? 'sent' : 'pending'))
      channel.attempts = asNumber(channel.attempts, 0)
      if (channel.lastError === undefined) channel.lastError = null
      if (channel.sentAt === undefined) channel.sentAt = asNumber(value.sentAt, 0)
      if (channel.lastAttemptAt === undefined) channel.lastAttemptAt = asNumber(value.lastAttemptAt, 0)
      if (channel.waitingFor) channel.waitingFor = String(channel.waitingFor)
      map[key] = channel
    } else if (typeof value === 'boolean') {
      map[key] = { status: value ? 'sent' : 'pending', attempts: 0, lastError: null, sentAt: 0, lastAttemptAt: 0 }
    } else if (typeof value === 'string') {
      map[key] = { status: value, attempts: 0, lastError: null, sentAt: 0, lastAttemptAt: 0 }
    }
  }
  if (Array.isArray(raw)) {
    for (const name of raw) put(name, name === 'panel' ? { status: 'sent' } : { status: 'pending' })
  } else if (isPlainObject(raw)) {
    for (const [name, value] of Object.entries(raw)) put(name, value)
  }
  return map
}

function outboxPendingChannels(entry, { includePeer = false } = {}) {
  const channels = isPlainObject(entry?.channels) ? entry.channels : normalizeOutboxChannels(entry)
  return Object.entries(channels).filter(([name, channel]) =>
    isPlainObject(channel) && channel.status === 'pending' && (includePeer || name !== 'peer'))
}

function outboxHasPending(entry) {
  return outboxPendingChannels(entry).length > 0
}

/**
 * 补发 outbox：把插件 monitor.js 与看门狗自己排队的通知真正送出去。
 *   - panel：alerts/current.json 已承载，标记 sent；
 *   - toast / webhook / email / qq：逐通道尝试并记录 attempts/lastError；
 *   - peer：外部看门狗无法直连 dsh-sync，保留 pending + waitingFor='plugin'，由插件消费；
 * 已 sent / failed 的条目不再降级；同一通道 attempts 超过 notify.outboxMaxAttempts 置 failed。
 */
export async function flushOutbox({
  monitorDir,
  config,
  secrets,
  deps,
  now = Date.now(),
  limit = 20,
  scriptDir = MODULE_DIR,
} = {}) {
  const outboxDir = path.join(monitorDir, 'outbox')
  let names = []
  try { names = (await fsp.readdir(outboxDir)).filter((name) => name.endsWith('.json')).sort().slice(0, limit) } catch { return [] }
  const notifyCfg = config?.notify || NOTIFY_DEFAULTS
  const fetchFn = deps?.fetchFn || globalThis.fetch
  const sleep = deps?.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const runCommand = deps?.runCommand
  const secretData = secrets?.ok ? secrets.data || {} : {}
  const maxAttempts = Math.max(1, asNumber(notifyCfg.outboxMaxAttempts, 12))
  const results = []
  const toastScript = path.join(scriptDir, 'toast.ps1')
  const notifyScript = path.join(scriptDir, 'notify.ps1')
  const hasToastScript = typeof runCommand === 'function' && (await exists(toastScript))
  const hasNotifyScript = typeof runCommand === 'function' && (await exists(notifyScript))

  for (const name of names) {
    const file = path.join(outboxDir, name)
    const entry = await readJsonSafe(file, null)
    if (!isPlainObject(entry)) continue
    if (entry.status === 'sent' || entry.status === 'failed') continue
    entry.channels = normalizeOutboxChannels(entry)
    const statusBefore = entry.status
    if (!Object.keys(entry.channels).length) {
      entry.status = 'sent'
      entry.updatedAt = now
      await writeJsonAtomic(file, entry)
      continue
    }
    const payload = isPlainObject(entry.payload) ? entry.payload : {}
    const title = String(payload.title || `[DSH] ${KIND_LABELS[entry.kind] || entry.kind || '事故'}`)
    const body = String(payload.body || entry.summary || '')
    let changed = false

    const mark = (channelName, status, extra = {}) => {
      const current = isPlainObject(entry.channels[channelName]) ? entry.channels[channelName] : { attempts: 0 }
      entry.channels[channelName] = { ...current, status, ...extra }
      changed = true
    }
    const bumpAttempt = (channelName, extra = {}) => {
      const current = isPlainObject(entry.channels[channelName]) ? entry.channels[channelName] : { attempts: 0 }
      const attempts = asNumber(current.attempts, 0) + 1
      entry.channels[channelName] = { ...current, attempts, lastAttemptAt: now, ...extra }
      changed = true
      return attempts
    }

    // panel：文件型通道，alerts/current.json 已经写过了
    if (isPlainObject(entry.channels.panel) && entry.channels.panel.status !== 'sent') {
      mark('panel', 'sent', { sentAt: now })
    }

    // toast
    const toastChannel = entry.channels.toast
    if (isPlainObject(toastChannel) && toastChannel.status === 'pending') {
      if (notifyCfg.toast === false) {
        mark('toast', 'pending', { lastError: 'disabled' })
        results.push({ file, channel: 'toast', ok: false, reason: 'disabled' })
      } else if (!hasToastScript) {
        mark('toast', 'failed', { lastError: 'script-missing' })
        results.push({ file, channel: 'toast', ok: false, reason: 'script-missing' })
      } else {
        const attempts = bumpAttempt('toast')
        const result = await runCommand('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', toastScript, '-Title', title, '-Body', body,
          '-LogPath', path.join(monitorDir, 'toast.log'),
        ], { timeoutMs: asNumber(notifyCfg.toastTimeoutMs, 20000) })
        if (result.ok === true) {
          mark('toast', 'sent', { sentAt: now, lastError: null })
        } else if (attempts >= maxAttempts) {
          mark('toast', 'failed', { lastError: 'toast-failed' })
        } else {
          mark('toast', 'pending', { lastError: 'toast-failed' })
        }
        results.push({ file, channel: 'toast', ok: result.ok === true, attempts })
      }
    }

    // webhook（对当前所有启用的 hook 都发；全部成功才算 sent）
    const webhookChannel = entry.channels.webhook
    if (isPlainObject(webhookChannel) && webhookChannel.status === 'pending') {
      const hooks = (Array.isArray(notifyCfg.webhook) ? notifyCfg.webhook : [])
        .filter((hook) => hook.enabled !== false && hook.url)
      if (!hooks.length) {
        mark('webhook', 'pending', { lastError: 'not-configured' })
        results.push({ file, channel: 'webhook', ok: false, reason: 'not-configured' })
      } else {
        const attempts = bumpAttempt('webhook')
        let allOk = true
        let lastError = null
        let totalAttempts = 0
        for (const hook of hooks) {
          const token = (isPlainObject(secretData.webhook) && secretData.webhook[hook.name]) ||
            (hook.tokenSecret && secretData[hook.tokenSecret]) || null
          const headers = { 'user-agent': `dsh-watchdog/${WATCHDOG_VERSION}` }
          if (token) {
            headers.authorization = `Bearer ${token}`
            headers['x-webhook-token'] = String(token)
          }
          const result = await postJsonWithRetry({
            url: hook.url,
            payload: {
              title,
              body,
              source: 'dsh-watchdog',
              version: WATCHDOG_VERSION,
              incidentId: entry.incidentId || entry.id || null,
              kind: entry.kind || null,
              host: entry.host || null,
            },
            headers,
            retries: hook.retries,
            timeoutMs: hook.timeoutMs,
            fetchFn,
            sleep,
            now,
          })
          totalAttempts += result.attempts
          if (!result.ok) { allOk = false; lastError = result.error || 'webhook-failed' }
        }
        entry.attempts = asNumber(entry.attempts, 0) + totalAttempts
        if (allOk) mark('webhook', 'sent', { sentAt: now, lastError: null })
        else if (attempts >= maxAttempts) mark('webhook', 'failed', { lastError })
        else mark('webhook', 'pending', { lastError })
        results.push({ file, channel: 'webhook', ok: allOk, attempts })
      }
    }

    // email
    const emailChannel = entry.channels.email
    if (isPlainObject(emailChannel) && emailChannel.status === 'pending') {
      const emailCfg = notifyCfg.email || {}
      const password = (isPlainObject(secretData.smtp) && secretData.smtp.password) ||
        (isPlainObject(secretData.email) && secretData.email.password) || ''
      if (!emailCfg.enabled || !emailCfg.host || !emailCfg.from || !emailCfg.to?.length) {
        mark('email', 'pending', { lastError: 'not-configured' })
        results.push({ file, channel: 'email', ok: false, reason: 'not-configured' })
      } else if (emailCfg.user && !password) {
        // 密钥还没就位：保持 pending 等 DPAPI 可用，不计入失败次数
        mark('email', 'pending', { lastError: 'secret-unavailable' })
        results.push({ file, channel: 'email', ok: false, reason: 'secret-unavailable' })
      } else if (!hasNotifyScript) {
        mark('email', 'failed', { lastError: 'script-missing' })
        results.push({ file, channel: 'email', ok: false, reason: 'script-missing' })
      } else {
        const attempts = bumpAttempt('email')
        const result = await runCommand('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', notifyScript, '-Mode', 'Email',
        ], {
          input: JSON.stringify({
            host: emailCfg.host,
            port: emailCfg.port,
            useSsl: emailCfg.useSsl,
            user: emailCfg.user,
            password,
            from: emailCfg.from,
            to: emailCfg.to,
            subject: `${emailCfg.subjectPrefix || '[DSH]'} ${title}`,
            body,
            timeoutMs: 20000,
          }),
          timeoutMs: 30000,
        })
        if (result.ok === true) {
          mark('email', 'sent', { sentAt: now, lastError: null })
        } else {
          const errorCode = String(result.stderr || 'email-failed').trim().split(/\s+/).slice(-1)[0] || 'email-failed'
          if (attempts >= maxAttempts) mark('email', 'failed', { lastError: errorCode })
          else mark('email', 'pending', { lastError: errorCode })
        }
        results.push({ file, channel: 'email', ok: result.ok === true, attempts })
      }
    }

    // qq
    const qqChannel = entry.channels.qq
    if (isPlainObject(qqChannel) && qqChannel.status === 'pending') {
      if (!notifyCfg.qq?.enabled) {
        mark('qq', 'pending', { lastError: 'disabled' })
        results.push({ file, channel: 'qq', ok: false, reason: 'disabled' })
      } else if (!notifyCfg.qq?.http) {
        // 已启用但还没配 OneBot HTTP：保持 pending，等配置补全后补发
        mark('qq', 'pending', { lastError: 'no-http' })
        results.push({ file, channel: 'qq', ok: false, reason: 'no-http' })
      } else {
        const base = String(notifyCfg.qq.http).replace(/\/+$/, '')
        const url = `${base}/${String(notifyCfg.qq.action || 'send_private_msg').replace(/^\/+/, '')}`
        const token = notifyCfg.qq.token || (isPlainObject(secretData.qq) && secretData.qq.token) || ''
        const headers = token ? { authorization: `Bearer ${token}` } : {}
        const attempts = bumpAttempt('qq')
        const qqBody = notifyCfg.qq.target ? { user_id: notifyCfg.qq.target, message: body } : { message: body }
        const result = await postJsonWithRetry({
          url, payload: qqBody, headers, retries: notifyCfg.retries ?? 2, fetchFn, sleep, now,
        })
        entry.attempts = asNumber(entry.attempts, 0) + result.attempts
        if (result.ok) mark('qq', 'sent', { sentAt: now, lastError: null })
        else if (attempts >= maxAttempts) mark('qq', 'failed', { lastError: result.error || 'send-failed' })
        else mark('qq', 'pending', { lastError: result.error || 'send-failed' })
        results.push({ file, channel: 'qq', ok: result.ok, attempts })
      }
    }

    // peer：外部进程没有 ctx.dshSync，永远保持 pending 交给插件 monitor.js 的 flushPeerOutbox()。
    // 这里只补 waitingFor / peerPending 两个“交接标记”，绝不动插件的 attempts/lastError/lastAttemptAt
    // （否则两边 read-modify-write 会把对方的投递账本洗掉），也绝不标 failed/skipped。
    const peerChannel = entry.channels.peer
    if (isPlainObject(peerChannel) && peerChannel.status === 'pending') {
      if (!peerChannel.waitingFor) {
        peerChannel.waitingFor = 'plugin'
        changed = true
      }
      results.push({ file, channel: 'peer', ok: true, queued: true, waitingFor: 'plugin' })
    }

    const pendingNonPeer = outboxPendingChannels(entry)
    const failedAny = Object.values(entry.channels).some((channel) => isPlainObject(channel) && channel.status === 'failed')
    const peerPending = isPlainObject(entry.channels.peer) && entry.channels.peer.status === 'pending'
    if (pendingNonPeer.length) entry.status = 'pending'
    else if (failedAny) entry.status = 'failed'
    else entry.status = 'sent'
    if (entry.status !== statusBefore) changed = true
    // 给插件一个明确的“还有 peer 待你补发”信号（不管本机通道是否都发完）。
    if (peerPending) {
      if (entry.peerPending !== true) { entry.peerPending = true; changed = true }
    } else if (entry.peerPending !== undefined) {
      delete entry.peerPending
      changed = true
    }
    if (changed || entry.status !== 'sent') {
      entry.updatedAt = now
      if (entry.status === 'sent') entry.sentAt = entry.sentAt || now
      // 写回前再读一次，保留另一写者（插件 flushPeerOutbox）可能刚更新的字段，避免互相覆盖。
      const latest = await readJsonSafe(file, null)
      if (isPlainObject(latest)) {
        const latestChannels = isPlainObject(latest.channels) ? latest.channels : {}
        const latestPeer = latestChannels.peer
        if (isPlainObject(latestPeer)) {
          const merged = { ...(entry.channels.peer || {}), ...latestPeer }
          if (latestPeer.status === 'sent') merged.status = 'sent'
          entry.channels.peer = merged
          if (merged.status !== 'pending') delete entry.peerPending
        }
        for (const [key, value] of Object.entries(latest)) {
          if (!(key in entry)) entry[key] = value
        }
      }
      await writeJsonAtomic(file, entry)
    }
  }
  return results
}

/* --------------------------------------------------------- 通知通道自检 */

export const TEST_NOTIFY_CHANNELS = ['panel', 'toast', 'webhook', 'email', 'qq', 'peer']
export const TEST_NOTIFY_TITLE = '[DSH] 通知测试'

export function buildTestNotifyMessage({ host, now = Date.now(), channel = '' } = {}) {
  const at = formatDateTime(now)
  return {
    title: TEST_NOTIFY_TITLE,
    body: [
      `${at} · ${host || os.hostname()}`,
      `这是外部看门狗的通知通道测试（${channel}）。收到说明该通道可用；`,
      '真实事故通知会包含事故类型、时间与推荐恢复点。',
    ].join('\n'),
    host: host || os.hostname(),
    channel,
    at,
  }
}

function clipText(value, max = 240) {
  const text = String(value == null ? '' : value).trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 从 notify.ps1 的 stderr 提取错误 code（脚本约定只输出 `email: CODE`）。 */
function lastErrorCode(result) {
  const stderr = String(result?.stderr || '').trim()
  if (!stderr) return 'send-failed'
  return stderr.split(/\s+/).slice(-1)[0] || 'send-failed'
}

async function queueNotifyTestOutbox({ monitorDir, channel, message, now }) {
  const outboxDir = path.join(monitorDir, 'outbox')
  const id = `notify-test-${now}-${channel}`
  const file = path.join(outboxDir, `${id}.json`)
  const entry = {
    v: 1,
    id,
    incidentId: id,
    kind: 'notify-test',
    severity: 'info',
    detectedAt: now,
    createdAt: now,
    updatedAt: now,
    status: 'pending',
    attempts: 0,
    host: message.host,
    summary: message.title,
    test: true,
    channels: {},
    payload: {
      title: message.title,
      body: message.body,
      host: message.host,
      test: true,
      channel,
      incident: { id, kind: 'notify-test', severity: 'info', detectedAt: now, summary: message.title },
    },
  }
  if (channel === 'qq') entry.channels.qq = { status: 'pending', attempts: 0, lastError: 'no-http' }
  if (channel === 'peer') {
    entry.channels.peer = { status: 'pending', attempts: 0, waitingFor: 'plugin' }
    entry.peerPending = true
  }
  await writeJsonAtomic(file, entry)
  return file
}

/**
 * 通知通道自检（面板「测试」按钮 → `watchdog.mjs --test-notify <channel>`）。
 * 只发选中的通道，只读 config.json，不写 alerts/current.json、不建事故、不改配置。
 * 返回 `{ ok, channel, version, at, host, result:{ code, ... } }`；
 * `result.code` 是稳定 code（ok / disabled / not-configured / secrets-missing /
 * script-missing / toast-failed / SMTP_* / webhook-* / qq-* / queued / bad-channel / config-missing）。
 */
export async function testNotify(options = {}) {
  const now = typeof options.now === 'function' ? Number(options.now()) : (Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now())
  const rawChannel = options.channel
  const channel = (typeof rawChannel === 'string' ? rawChannel : '').trim().toLowerCase()
  const deps = resolveDeps({ deps: options.deps })
  const report = {
    ok: false,
    channel: channel || null,
    version: WATCHDOG_VERSION,
    at: now,
    host: null,
    result: { code: 'unknown' },
  }
  if (!TEST_NOTIFY_CHANNELS.includes(channel)) {
    report.result = { code: 'bad-channel', message: `channel 必须是 ${TEST_NOTIFY_CHANNELS.join('|')}` }
    return report
  }
  const configPath = options.configPath ? path.resolve(String(options.configPath)) : resolveConfigPath(options)
  const loaded = await loadConfig(configPath)
  const config = loaded.config
  if (options.storeRoot) config.storeRoot = String(options.storeRoot)
  if (options.home) config.home = String(options.home)
  if (options.hostname) config.hostname = String(options.hostname)
  const host = config.hostname || os.hostname()
  const storeRoot = path.resolve(config.storeRoot || DEFAULTS.storeRoot)
  const storeDir = path.join(storeRoot, sanitizeHostTag(host))
  const monitorDir = path.join(storeDir, 'monitor')
  const configDir = path.dirname(configPath)
  const scriptDir = options.scriptDir ? path.resolve(String(options.scriptDir)) : MODULE_DIR
  const notifyCfg = config.notify || NOTIFY_DEFAULTS
  report.host = host
  report.configPath = configPath
  if (!loaded.present) {
    report.result = { code: 'config-missing', path: configPath }
    return report
  }
  const message = buildTestNotifyMessage({ host, now, channel })
  const fetchFn = deps.fetchFn
  const sleep = deps.sleep
  const secretsCache = { value: null }
  const getSecrets = async () => {
    if (secretsCache.value) return secretsCache.value
    secretsCache.value = await loadSecrets({
      file: path.join(configDir, 'secrets.dpapi'),
      deps: { unprotectSecrets: deps.unprotectSecrets, runCommand: deps.runCommand },
      config,
      configDir,
      scriptDir,
    })
    return secretsCache.value
  }
  const secretData = async () => {
    const secrets = await getSecrets()
    return { secrets, data: secrets.ok ? secrets.data || {} : {} }
  }

  try {
    if (channel === 'panel') {
      const alertsDir = path.join(monitorDir, 'alerts')
      await fsp.mkdir(alertsDir, { recursive: true })
      const file = path.join(alertsDir, 'notify-test.json')
      await writeJsonAtomic(file, {
        v: 1,
        at: now,
        channel: 'panel',
        source: 'watchdog-test',
        title: message.title,
        body: message.body,
        host,
      })
      report.ok = true
      report.result = { code: 'ok', path: file, detail: '面板告警目录可写（未改动 alerts/current.json）' }
      return report
    }

    if (channel === 'toast') {
      if (notifyCfg.toast === false) {
        report.result = { code: 'disabled', detail: 'config.notify.toast=false' }
        return report
      }
      const script = path.join(scriptDir, 'toast.ps1')
      if (!(await exists(script))) {
        report.result = { code: 'script-missing', path: script }
        return report
      }
      const result = await deps.runCommand('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Title', message.title, '-Body', message.body,
        '-LogPath', path.join(monitorDir, 'toast.log'),
      ], { timeoutMs: asNumber(notifyCfg.toastTimeoutMs, 20000) })
      report.ok = result.ok === true
      report.result = {
        code: result.ok ? 'ok' : 'toast-failed',
        exitCode: result.code,
        stderr: result.ok ? null : clipText(result.stderr),
      }
      return report
    }

    if (channel === 'webhook') {
      const hooks = (Array.isArray(notifyCfg.webhook) ? notifyCfg.webhook : [])
        .filter((hook) => hook.enabled !== false && hook.url)
      if (!Array.isArray(notifyCfg.webhook) || notifyCfg.webhook.length === 0) {
        report.result = { code: 'not-configured', detail: 'config.notify.webhook 为空' }
        return report
      }
      if (!hooks.length) {
        report.result = { code: 'disabled', detail: '所有 webhook 都被禁用' }
        return report
      }
      const { data } = await secretData()
      const hookResults = []
      for (const hook of hooks) {
        const token = (isPlainObject(data.webhook) && data.webhook[hook.name]) ||
          (hook.tokenSecret && data[hook.tokenSecret]) || null
        const headers = { 'user-agent': `dsh-watchdog/${WATCHDOG_VERSION}` }
        if (token) {
          headers.authorization = `Bearer ${token}`
          headers['x-webhook-token'] = String(token)
        }
        const sent = await postJsonWithRetry({
          url: hook.url,
          payload: { ...message, source: 'dsh-watchdog-test', version: WATCHDOG_VERSION, test: true },
          headers,
          retries: hook.retries,
          timeoutMs: hook.timeoutMs,
          fetchFn,
          sleep,
          now,
        })
        hookResults.push({
          name: hook.name,
          ok: sent.ok,
          attempts: sent.attempts,
          status: sent.status ?? null,
          error: sent.error ?? null,
        })
      }
      const allOk = hookResults.every((item) => item.ok)
      const firstError = hookResults.find((item) => !item.ok)
      report.ok = allOk
      report.result = {
        code: allOk ? 'ok' : (firstError?.error ? `webhook-${firstError.error}` : 'webhook-failed'),
        hooks: hookResults,
      }
      return report
    }

    if (channel === 'email') {
      const emailCfg = notifyCfg.email || {}
      if (!emailCfg.enabled) {
        report.result = { code: 'disabled', detail: 'config.notify.email.enabled=false' }
        return report
      }
      if (!emailCfg.host || !emailCfg.from || !Array.isArray(emailCfg.to) || emailCfg.to.length === 0) {
        report.result = { code: 'not-configured', detail: '需要 email.host/from/to' }
        return report
      }
      const { secrets, data } = await secretData()
      const password = (isPlainObject(data.smtp) && data.smtp.password) ||
        (isPlainObject(data.email) && data.email.password) || ''
      if (emailCfg.user && !password) {
        report.result = {
          code: secrets.ok === false ? 'secrets-missing' : 'secret-missing',
          detail: `SMTP 密码未就绪：${secrets.reason || 'not-found'}`,
          secretsReason: secrets.reason || null,
        }
        return report
      }
      const script = path.join(scriptDir, 'notify.ps1')
      if (!(await exists(script))) {
        report.result = { code: 'script-missing', path: script }
        return report
      }
      const result = await deps.runCommand('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Mode', 'Email',
      ], {
        input: JSON.stringify({
          host: emailCfg.host,
          port: emailCfg.port,
          useSsl: emailCfg.useSsl,
          user: emailCfg.user,
          password,
          from: emailCfg.from,
          to: emailCfg.to,
          subject: `${emailCfg.subjectPrefix || '[DSH]'} ${message.title}`,
          body: message.body,
          timeoutMs: 20000,
        }),
        timeoutMs: 30000,
      })
      report.ok = result.ok === true
      report.result = {
        code: result.ok ? 'ok' : lastErrorCode(result),
        exitCode: result.code,
      }
      return report
    }

    if (channel === 'qq') {
      const qqCfg = notifyCfg.qq || {}
      if (!qqCfg.enabled) {
        report.result = { code: 'disabled', detail: 'config.notify.qq.enabled=false' }
        return report
      }
      if (!qqCfg.http) {
        const outboxFile = await queueNotifyTestOutbox({ monitorDir, channel: 'qq', message, now })
        report.ok = false
        report.result = {
          code: 'not-configured',
          queued: true,
          outboxFile,
          detail: 'OneBot HTTP 未配置；已按正式事故方式写 outbox 等待配置后补发',
        }
        return report
      }
      const { data } = await secretData()
      const base = String(qqCfg.http).replace(/\/+$/, '')
      const url = `${base}/${String(qqCfg.action || 'send_private_msg').replace(/^\/+/, '')}`
      const token = qqCfg.token || (isPlainObject(data.qq) && data.qq.token) || ''
      const headers = token ? { authorization: `Bearer ${token}` } : {}
      const body = qqCfg.target ? { user_id: qqCfg.target, message: `${message.title}\n${message.body}` } : { message: `${message.title}\n${message.body}` }
      const sent = await postJsonWithRetry({
        url, payload: body, headers, retries: notifyCfg.retries ?? 2, fetchFn, sleep, now, timeoutMs: 8000,
      })
      report.ok = sent.ok
      report.result = {
        code: sent.ok ? 'ok' : (sent.error ? `qq-${sent.error}` : 'qq-failed'),
        attempts: sent.attempts,
        status: sent.status ?? null,
      }
      return report
    }

    // peer：外部进程没有 ctx.dshSync，唯一可行的是排队；是否真的发出取决于 DSH 侧 flushPeerOutbox。
    const outboxFile = await queueNotifyTestOutbox({ monitorDir, channel: 'peer', message, now })
    report.ok = true
    report.result = {
      code: 'queued',
      queued: true,
      pending: true,
      outboxFile,
      delivery: 'plugin',
      detail: '已写 outbox 等 DSH 侧 flushPeerOutbox 补发；若没有插件消费会保持 pending（90 天清理兜底）',
    }
    return report
  } catch (error) {
    report.ok = false
    report.result = { code: 'test-failed', message: clipText(error?.message || error) }
    return report
  }
}

/* --------------------------------------------------------------- secrets */

function resolveDpapiScript({ config, configDir, scriptDir }) {
  const candidates = [
    process.env.DSH_MONITOR_DPAPI,
    config?.dpapiScript,
    path.join(configDir, 'dpapi.ps1'),
    path.join(scriptDir || MODULE_DIR, 'dpapi.ps1'),
    path.join(configDir, '..', 'scripts', 'dpapi.ps1'),
    path.join(configDir, '..', 'plugin', 'scripts', 'dpapi.ps1'),
  ].filter(Boolean).map((item) => path.resolve(String(item)))
  return candidates[0] || null
}

function normalizeSecretData(raw) {
  if (!isPlainObject(raw)) return {}
  return {
    ...raw,
    smtp: isPlainObject(raw.smtp) ? raw.smtp : (isPlainObject(raw.email) ? raw.email : {}),
    webhook: isPlainObject(raw.webhook) ? raw.webhook : {},
    qq: isPlainObject(raw.qq) ? raw.qq : {},
  }
}

export async function loadSecrets({ file, deps, config, configDir, scriptDir } = {}) {
  if (!file || !(await exists(file))) return { ok: false, reason: 'missing' }
  let text = ''
  try { text = (await fsp.readFile(file, 'utf8')).trim() } catch { return { ok: false, reason: 'unreadable' } }
  if (!text) return { ok: false, reason: 'empty' }
  let blob = text
  if (text.startsWith('{')) {
    let parsed = null
    try { parsed = JSON.parse(text) } catch { return { ok: false, reason: 'bad-format' } }
    blob = parsed.blob || parsed.data || parsed.ciphertext || parsed.dpapi || ''
  }
  if (!blob) return { ok: false, reason: 'bad-format' }
  if (typeof deps?.unprotectSecrets === 'function') {
    try {
      const data = await deps.unprotectSecrets({ blob, file })
      if (isPlainObject(data)) return { ok: true, data: normalizeSecretData(data), source: 'injected' }
      return { ok: false, reason: 'bad-secret-payload' }
    } catch (error) {
      return { ok: false, reason: 'decrypt-failed', detail: String(error?.message || error).slice(0, 120) }
    }
  }
  const script = resolveDpapiScript({ config, configDir: configDir || path.dirname(file), scriptDir })
  if (!script || !(await exists(script))) return { ok: false, reason: 'dpapi-unavailable' }
  const result = await deps.runCommand(defaultPowerShellPath(), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', 'Unprotect',
  ], { input: String(blob), timeoutMs: 20000 })
  if (!result.ok) return { ok: false, reason: 'decrypt-failed' }
  try {
    const plain = Buffer.from(String(result.stdout || '').trim(), 'base64').toString('utf8')
    let data
    try { data = JSON.parse(plain) } catch { data = { smtp: { password: plain } } }
    return { ok: true, data: normalizeSecretData(data), source: 'dpapi' }
  } catch {
    return { ok: false, reason: 'bad-secret-payload' }
  }
}

function needsSecrets(config) {
  const notify = config?.notify || {}
  const hooks = Array.isArray(notify.webhook) ? notify.webhook : []
  return notify.email?.enabled === true || notify.qq?.enabled === true ||
    hooks.some((hook) => hook.enabled !== false)
}

/* --------------------------------------------------------------- state */

function emptyState() {
  return {
    v: 1,
    host: '',
    updatedAt: 0,
    lastRunAt: 0,
    lastRunOk: null,
    runs: 0,
    failures: 0,
    lastError: null,
    process: { alive: false, pid: 0, startedAt: 0, firstSeenAt: 0, lastSeenAt: 0, queryOkAt: 0 },
    heartbeat: { lastSeen: 0, pid: 0, bootId: null, ageMs: null, lastHeartbeatAt: 0 },
    events: { lastCheckAt: 0, lastOk: null, applicationCursor: 0, systemCursor: 0, recent: [] },
    baseline: { at: 0 },
    statsSource: 'none',
    stats: null,
    scannedStats: null,
    lastBaselineAt: 0,
    lastDeepVerifyAt: 0,
    lastSleepAt: 0,
    suppressUntil: 0,
    incidents: {},
    channels: {},
    outbox: { pending: 0, lastFlushAt: 0 },
  }
}

async function readState(monitorDir) {
  const raw = await readJsonSafe(path.join(monitorDir, 'watchdog-state.json'), null)
  const state = deepMerge(emptyState(), isPlainObject(raw) ? raw : {})
  if (!Array.isArray(state.events.recent)) state.events.recent = []
  if (!isPlainObject(state.incidents)) state.incidents = {}
  return state
}

/* --------------------------------------------------------------- 维护 */

export async function pruneMaintenance({ monitorDir, incidentsDir, config, now = Date.now(), state } = {}) {
  const th = config?.thresholds || THRESHOLD_DEFAULTS
  const retentionMs = Math.max(1, asNumber(th.retentionDays, 90)) * 86400000
  const out = { incidents: 0, outbox: 0 }
  const pruneDir = async (dir, key) => {
    let names = []
    try { names = (await fsp.readdir(dir)).filter((name) => name.endsWith('.json')) } catch { return }
    for (const name of names) {
      const file = path.join(dir, name)
      let stamp = 0
      try {
        const parsed = await readJsonSafe(file, null)
        stamp = asNumber(parsed?.lastAt || parsed?.detectedAt || parsed?.createdAt || parsed?.updatedAt, 0)
        if (!stamp) stamp = (await fsp.stat(file)).mtimeMs
      } catch { continue }
      if (now - stamp > retentionMs) {
        try { await fsp.unlink(file); out[key] += 1 } catch { /* 下一轮再试 */ }
      }
    }
  }
  await pruneDir(incidentsDir, 'incidents')
  await pruneDir(path.join(monitorDir, 'outbox'), 'outbox')
  // 清掉指向已不存在事故的 state 引用
  if (isPlainObject(state?.incidents)) {
    for (const kind of Object.keys(state.incidents)) {
      const id = state.incidents[kind]?.id
      if (!id || !(await exists(path.join(incidentsDir, `${id}.json`)))) delete state.incidents[kind]
    }
  }
  return out
}

async function countOutbox(monitorDir) {
  try {
    const names = (await fsp.readdir(path.join(monitorDir, 'outbox'))).filter((name) => name.endsWith('.json'))
    let pending = 0
    for (const name of names) {
      const entry = await readJsonSafe(path.join(monitorDir, 'outbox', name), null)
      if (isPlainObject(entry) && entry.status !== 'sent') pending += 1
    }
    return pending
  } catch {
    return 0
  }
}

/* --------------------------------------------------------------- runOnce */

function resolveDeps(options = {}) {
  const injected = isPlainObject(options.deps) ? options.deps : {}
  const runCommand = injected.runCommand || createCommandRunner({ spawn: injected.spawn || nodeSpawn })
  const runPowerShell = injected.runPowerShell || createPowerShellRunner({
    runCommand,
    powershell: injected.powershell || defaultPowerShellPath(),
  })
  return {
    runCommand,
    runPowerShell,
    now: injected.now || (() => Date.now()),
    detectProcess: injected.detectProcess || ((args) => detectProcessDefault({ ...args, runPowerShell })),
    queryEvents: injected.queryEvents || ((args) => queryEventsDefault({ ...args, runPowerShell })),
    scanHome: injected.scanHome || scanHomeDefault,
    diskFree: injected.diskFree || diskFreeDefault,
    unprotectSecrets: injected.unprotectSecrets || null,
    fetchFn: injected.fetchFn || globalThis.fetch,
    sleep: injected.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    isPidAlive: injected.isPidAlive || defaultIsPidAlive,
    notify: injected.notify !== false,
  }
}

function assertNotInsideHome(target, home) {
  if (!target || !home) return
  const rel = path.relative(path.resolve(home), path.resolve(target))
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`拒绝写入 DSH 数据目录：${target}`)
  }
}

/**
 * 跑一次检查。全部副作用都在注入的 deps 之外由本函数控制；测试可完全离线。
 * 返回结构化摘要；除非配置灾难性错误，否则永不抛异常（计划任务里不要天天报失败）。
 */
export async function runOnce(options = {}) {
  const startedWall = Date.now()
  const deps = resolveDeps(options)
  const now = typeof options.now === 'function' ? Number(options.now()) : (Number.isFinite(Number(options.now)) ? Number(options.now) : deps.now())
  const result = {
    ok: true,
    version: WATCHDOG_VERSION,
    mode: options.mode || 'once',
    ranAt: now,
    host: null,
    incidents: [],
    merged: [],
    suppressed: [],
    warnings: [],
    errors: [],
    channels: [],
    outbox: { pending: 0, flushed: 0 },
    baselineUpdated: false,
    lock: null,
    health: null,
    statsSource: 'none',
    durationMs: 0,
  }
  let lock = null
  let monitorDir = null
  let logPath = null
  const log = async (level, message) => {
    if (!logPath) return
    await appendLog(logPath, `${new Date(now).toISOString()} [watchdog] ${level} ${message}`)
  }
  try {
    const configPath = options.configPath ? path.resolve(String(options.configPath)) : resolveConfigPath(options)
    const loaded = await loadConfig(configPath)
    const config = loaded.config
    result.warnings.push(...loaded.warnings)
    if (options.storeRoot) config.storeRoot = String(options.storeRoot)
    if (options.home) config.home = String(options.home)
    if (options.hostname) config.hostname = String(options.hostname)
    const hostname = config.hostname || os.hostname()
    const home = path.resolve(config.home || path.join(os.homedir(), '.dsh'))
    const storeRoot = path.resolve(config.storeRoot || DEFAULTS.storeRoot)
    config.storeRoot = storeRoot
    config.home = home
    config.hostname = hostname
    const storeDir = path.join(storeRoot, sanitizeHostTag(hostname))
    monitorDir = path.join(storeDir, 'monitor')
    const configDir = path.dirname(configPath)
    const lockPath = options.lockPath ? path.resolve(String(options.lockPath)) : path.join(configDir, 'watchdog.lock')
    const scriptDir = options.scriptDir ? path.resolve(String(options.scriptDir)) : MODULE_DIR
    assertNotInsideHome(monitorDir, home)
    result.host = { name: hostname, home, storeRoot, storeDir, monitorDir, configPath, lockPath, scriptDir }

    if (!options.skipLock) {
      lock = await acquireLock(lockPath, { now, staleMs: config.thresholds.lockStaleMs, isAlive: deps.isPidAlive })
      result.lock = { held: lock.held === true, reason: lock.reason || null, path: lockPath }
      if (!lock.held) {
        result.skipped = 'locked'
        result.durationMs = Date.now() - startedWall
        return result
      }
    } else {
      result.lock = { held: false, reason: 'skipped', path: lockPath }
    }

    await fsp.mkdir(monitorDir, { recursive: true })
    const incidentsDir = path.join(monitorDir, 'incidents')
    await fsp.mkdir(incidentsDir, { recursive: true })
    logPath = path.join(monitorDir, 'watchdog.log')

    // ---------------------------------------------------------- 读输入
    const state = await readState(monitorDir)
    const acked = await readAcks(monitorDir)
    const heartbeat = normalizeHeartbeat(await readJsonSafe(path.join(monitorDir, 'heartbeat.json'), null))
    const baseline = normalizeBaseline(await readJsonSafe(path.join(monitorDir, 'baseline.json'), null))
    const secrets = needsSecrets(config)
      ? await loadSecrets({
        file: path.join(configDir, 'secrets.dpapi'),
        deps: { unprotectSecrets: deps.unprotectSecrets, runCommand: deps.runCommand },
        config,
        configDir,
        scriptDir,
      })
      : { ok: false, reason: 'skipped-no-channels' }
    if (needsSecrets(config) && !secrets.ok) result.warnings.push(`secrets-${secrets.reason || 'unavailable'}`)

    // 上一轮正常退出后重新启动 → 补齐现场 timeline（不启动进程，只记录）
    const restarted = Boolean(heartbeat?.bootId && state.heartbeat?.bootId && heartbeat.bootId !== state.heartbeat.bootId)
    if (restarted) {
      const crashRef = state.incidents?.crash?.id
      if (crashRef) {
        const file = path.join(incidentsDir, `${crashRef}.json`)
        const incident = await readIncidentFile(file)
        if (incident && incident.status === 'open' && !incident.restartedAt) {
          incident.restartedAt = heartbeat.startedAt || now
          incident.timeline = [...(incident.timeline || []),
            { at: now, type: 'restart', detail: `DSH 已重新启动（pid ${heartbeat.pid || '?'}）` }].slice(-60)
          incident.summary = `${incident.summary}；已于 ${formatClock(incident.restartedAt)} 重新启动`
          await writeJsonAtomic(file, incident)
        }
      }
    }

    // 补发 outbox（DSH 起来 / 网络恢复后自动重试；也接管插件 monitor.js 排队的 toast/webhook/email/qq）
    const flushed = await flushOutbox({ monitorDir, config, secrets, deps, now, scriptDir })
    result.outbox.flushed = flushed.length

    // 事件日志（只读；不可读时降级为只用心跳）
    const sinceMs = state.events?.lastCheckAt
      ? Math.max(asNumber(state.events.lastCheckAt, 0) - 600000, now - config.thresholds.eventLookbackMs)
      : now - config.thresholds.eventLookbackMs
    let rawEvents = { ok: false, application: [], system: [], errors: [] }
    try {
      rawEvents = await deps.queryEvents({ sinceMs, now, config })
    } catch (error) {
      rawEvents = { ok: false, application: [], system: [], errors: [String(error?.message || error)] }
    }
    rawEvents = normalizeEvents(rawEvents, { sinceMs, now })
    const recentEvents = mergeRecentEvents(state.events?.recent, rawEvents, { now })
    if (!rawEvents.ok) result.warnings.push('event-log-degraded')
    const eventsBundle = {
      ok: rawEvents.ok,
      application: recentEvents.filter((event) => event.log === 'Application'),
      system: recentEvents.filter((event) => event.log === 'System'),
      errors: rawEvents.errors,
    }

    // 进程（只读查询；绝不启停）
    let processInfo
    try {
      processInfo = await deps.detectProcess({ config, now, processName: config.process.name })
    } catch (error) {
      processInfo = { ok: false, alive: false, error: 'process-query-failed', detail: String(error?.message || error) }
    }
    if (!processInfo?.ok) result.warnings.push('process-query-degraded')

    // home 统计（只读遍历；绝不写入）。口径已与插件 monitor.computeLightStats 对齐。
    let homeStats
    try {
      homeStats = await deps.scanHome({ home, excludes: config.excludes, now })
    } catch (error) {
      homeStats = { ok: false, home, exists: false, error: String(error?.message || error) }
    }
    // 关键：优先用“新鲜心跳里的 stats”作为 current，扫描只作兜底；
    // 这样 baseline 与 current 同源，不会再出现“心跳 138 会话 vs 扫描 7 工作区”的误报。
    const currentStats = resolveCurrentStats({
      heartbeat,
      homeStats,
      thresholds: config.thresholds,
      now,
      baseline,
    })
    result.statsSource = currentStats.source
    for (const warning of currentStats.warnings || []) {
      if (!result.warnings.includes(warning)) result.warnings.push(warning)
    }
    if (currentStats.source === 'scan') {
      await log('info', `heartbeat unavailable, using scan stats (${formatDuration(now - asNumber(heartbeat?.lastSeen, now))} stale)`)
    }

    // 磁盘
    let disk
    try {
      disk = await deps.diskFree({ target: storeRoot, now })
    } catch {
      disk = { ok: false, freeBytes: null }
    }

    // 备份检查：到“每小时全量校验”的档期就直接跑 deep —— deep 已包含全部清单，
    // 没必要再先跑一遍 quick（真实库 quick 0.8s + deep 1.1s，省一次能让单次运行稳定 <5s）。
    const deepDue = !state.lastDeepVerifyAt ||
      now - asNumber(state.lastDeepVerifyAt, 0) >= config.thresholds.deepVerifyEveryMs
    let backup = await inspectBackup({
      storeDir,
      monitorDir,
      mode: deepDue ? 'deep' : 'quick',
      limit: config.thresholds.quickVerifySnapshots,
      now,
    })
    const deepRan = deepDue
    if (deepRan) state.lastDeepVerifyAt = now
    const offsite = await inspectOffsite({ storeDir, heartbeat, now })

    // ---------------------------------------------------------- 分类
    const classification = classifyAll({
      config,
      now,
      heartbeat,
      baseline,
      processInfo,
      events: eventsBundle,
      homeStats,
      currentStats,
      backup,
      offsite,
      disk,
      state,
    })
    result.suppressed = classification.suppressed
    result.health = classification.health
    for (const warning of classification.warnings || []) {
      if (!result.warnings.includes(warning)) result.warnings.push(warning)
    }
    if (classification.suppressed.length) {
      await log('info', `suppressed: ${classification.suppressed.map((item) => `${item.kind}:${item.reason}`).join(',')}`)
      const sleep = classification.suppressed.find((item) => item.kind === 'crash')
      if (sleep) state.lastSleepAt = now
    }

    // 深查：事故取证 / quick 已发现问题（deep 本档已跑过就不再重复）
    const needsDeep = !deepRan && (classification.drafts.some((draft) => ['crash', 'hang', 'data-loss'].includes(draft.kind)) ||
      (backup.ok === false && (backup.initialized === true || asNumber(heartbeat?.backup?.snapshots, 0) > 0)))
    if (needsDeep) {
      const crashDraft = classification.drafts.find((draft) => draft.kind === 'crash')
      const suspectFrom = crashDraft ? Math.max(0, asNumber(crashDraft.firstAt, 0) - 300000) : 0
      const deep = await inspectBackup({
        storeDir, monitorDir, mode: 'deep', suspectFrom, suspectTo: now, now,
      })
      state.lastDeepVerifyAt = now
      if (deep.initialized) backup = deep
      if (deep.ok === false && !classification.drafts.some((draft) => draft.kind === 'backup-corrupt') &&
        (deep.initialized === true || asNumber(heartbeat?.backup?.snapshots, 0) > 0 || asNumber(deep.snapshotsTotal, 0) > 0)) {
        const badSnapshots = (deep.snapshots || []).filter((snap) => snap.status !== 'ok')
        classification.drafts.push({
          kind: 'backup-corrupt',
          severity: 'high',
          firstAt: now,
          lastAt: now,
          summary: `备份仓库异常：全量校验发现 ${badSnapshots.length} 份快照缺块/不可读` +
            (deep.corruptManifests?.length ? `，${deep.corruptManifests.length} 份清单损坏` : ''),
          evidence: { backup: { mode: 'deep', checked: deep.checked, snapshotsTotal: deep.snapshotsTotal, blobCount: deep.blobCount, writable: deep.writable, bad: deep.bad, corruptManifests: deep.corruptManifests, errors: deep.errors } },
          timeline: [{ at: now, type: 'backup-scan', detail: `全量校验 ${deep.checked} 份清单` }],
        })
      }
      const impact = {
        local: {
          checked: backup.checked,
          total: backup.snapshotsTotal,
          mode: backup.mode,
          writable: backup.writable,
          bad: (backup.bad || []).slice(0, 20),
          corruptManifests: (backup.corruptManifests || []).slice(0, 20),
        },
        snapshots: (backup.snapshots || []).slice(0, 40).map((snap) => ({
          id: snap.id,
          at: snap.at,
          status: snap.suspect && snap.status === 'ok' ? 'suspect' : snap.status,
        })),
        offsite: {
          configured: offsite.configured,
          checked: offsite.checked,
          archives: offsite.archives,
          ledgerOk: offsite.ledgerOk,
          repoPresent: offsite.repoPresent,
          bad: offsite.bad.slice(0, 20),
        },
      }
      for (const draft of classification.drafts) {
        if (!['crash', 'hang', 'data-loss', 'backup-corrupt'].includes(draft.kind)) continue
        draft.impact = draft.impact || impact
        if (draft.kind !== 'backup-corrupt') draft.recommendation = recommendFromBackup(backup, draft)
        else draft.recommendation = recommendFromBackup(backup, { kind: 'backup-corrupt', firstAt: now })
      }
    } else {
      const impact = {
        local: { checked: backup.checked, total: backup.snapshotsTotal, mode: backup.mode, writable: backup.writable, bad: backup.bad || [], corruptManifests: backup.corruptManifests || [] },
        snapshots: (backup.snapshots || []).map((snap) => ({ id: snap.id, at: snap.at, status: snap.status })),
        offsite: { configured: offsite.configured, checked: offsite.checked, archives: offsite.archives, ledgerOk: offsite.ledgerOk, repoPresent: offsite.repoPresent, bad: offsite.bad.slice(0, 20) },
      }
      for (const draft of classification.drafts) {
        if (!['crash', 'hang', 'data-loss', 'backup-corrupt'].includes(draft.kind)) continue
        draft.impact = draft.impact || impact
        draft.recommendation = draft.recommendation || recommendFromBackup(backup, draft)
      }
    }

    // ---------------------------------------------------------- 事故落盘 + 通知
    const draftedKinds = new Set(classification.drafts.map((draft) => draft.kind))
    for (const draft of classification.drafts) {
      // 面板「忽略」只写 alerts/ack.json：已 ack 的同类事故不再重建/再通知，
      // 否则下一轮又把这条写回 open，面板会反复弹。
      const referenced = state.incidents?.[draft.kind]
      if (referenced?.id && acked.has(String(referenced.id))) {
        result.suppressed.push({ kind: draft.kind, reason: 'acked', id: referenced.id })
        await log('info', `acked incident ${referenced.id} (${draft.kind}) suppressed`)
        continue
      }
      const existing = await findOpenIncident({
        incidentsDir,
        kind: draft.kind,
        state,
        now,
        dedupeMs: config.thresholds.dedupeMs,
        acked,
      })
      if (existing) {
        const merged = await mergeIncident(existing, draft, { now })
        await writeJsonAtomic(path.join(incidentsDir, `${merged.id}.json`), merged)
        state.incidents[draft.kind] = {
          id: merged.id,
          detectedAt: merged.detectedAt,
          lastAt: merged.lastAt,
          notifiedAt: state.incidents?.[draft.kind]?.notifiedAt || 0,
        }
        result.merged.push({ id: merged.id, kind: draft.kind })
        await log('info', `merged ${draft.kind} incident ${merged.id} (${config.thresholds.dedupeMs / 60000}min dedupe)`)
        continue
      }
      const incident = await buildIncident({
        draft, config, now, hostname, home, storeDir, incidentsDir,
      })
      await writeJsonAtomic(path.join(incidentsDir, `${incident.id}.json`), incident)
      state.incidents[draft.kind] = {
        id: incident.id,
        detectedAt: incident.detectedAt,
        lastAt: incident.lastAt,
        notifiedAt: 0,
      }
      result.incidents.push({ id: incident.id, kind: incident.kind, severity: incident.severity, summary: incident.summary })
      await log('warn', `incident ${incident.kind} ${incident.id}: ${incident.summary}`)
      if (options.noNotify) {
        result.warnings.push(`notify-skipped:${incident.id}`)
        continue
      }
      try {
        const notification = await notifyAll({
          incident, config, secrets, monitorDir, scriptDir, deps, now,
        })
        incident.notify = { at: now, channels: notification.results }
        await writeJsonAtomic(path.join(incidentsDir, `${incident.id}.json`), incident)
        state.incidents[draft.kind].notifiedAt = now
        result.channels.push({ incidentId: incident.id, results: notification.results })
        if (notification.outboxFile) result.outbox.pending += 1
        const failed = notification.results.filter((entry) => entry.ok !== true && entry.skipped !== true)
        await log('info', `notify ${incident.id}: ${notification.results.length} channels, ${failed.length} failed`)
      } catch (error) {
        result.errors.push({ code: 'notify-failed', incidentId: incident.id, message: String(error?.message || error).slice(0, 200) })
        await log('error', `notify failed ${incident.id}: ${String(error?.message || error)}`)
      }
    }
    // 事故条件已经消失：清掉 state 里的 kind 引用，未来再发生才会重新提醒
    //（ack 过的同 kind 事故在条件持续期间一直抑制，不会每轮重建）。
    for (const kind of Object.keys(isPlainObject(state.incidents) ? state.incidents : {})) {
      if (!draftedKinds.has(kind)) delete state.incidents[kind]
    }

    // ---------------------------------------------------------- alerts
    const alerts = await rebuildAlerts({
      monitorDir, incidentsDir, now, config, heartbeat, channels: result.channels,
    })
    result.alerts = { path: alerts.path, open: alerts.count, fromWatchdog: alerts.ours, preservedForeign: alerts.foreign }

    // ---------------------------------------------------------- baseline
    // 只在“心跳健康 + 当前 stats 来自心跳”时写 baseline，保证与后续 current 同源。
    // 若现有 baseline 是历史 scan 口径（1.0.0 或 monitor 老数据），健康时立即自愈重写，
    // 不等 24h —— 否则会拿“扫描文件数”去比“心跳文件数”。
    const baselineStats = currentStats.source === 'heartbeat' ? currentStats.stats : null
    const baselineNeedsRebase = Boolean(baseline?.present && baseline.statsSource !== 'heartbeat')
    const baselineDue = now - asNumber(baseline?.at, 0) >= config.thresholds.baselineMinIntervalMs
    const canBaseline = classification.health.healthy &&
      !classification.drafts.some((draft) => ['data-loss', 'backup-corrupt'].includes(draft.kind)) &&
      (baselineDue || baselineNeedsRebase) &&
      baselineStats != null
    if (canBaseline) {
      const baselinePayload = {
        v: 1,
        at: now,
        host: hostname,
        home,
        source: 'watchdog',
        statsSource: currentStats.source,
        stats: {
          files: baselineStats.files,
          bytes: baselineStats.bytes,
          sessions: baselineStats.sessions,
          storages: baselineStats.storages,
          profiles: baselineStats.profiles,
          attachments: baselineStats.attachments,
          credentials: baselineStats.credentials,
          keyFiles: baselineStats.keyFiles || null,
        },
      }
      await writeJsonAtomic(path.join(monitorDir, 'baseline.json'), baselinePayload)
      state.baseline = { ...baselinePayload.stats, at: now, statsSource: currentStats.source }
      state.lastBaselineAt = now
      result.baselineUpdated = true
      await log('info', `baseline updated (${currentStats.source}): ${baselineStats.files} files / ` +
        `${baselineStats.sessions} sessions / ${baselineStats.storages} storage files`)
    }

    // ---------------------------------------------------------- 维护
    const pruned = await pruneMaintenance({ monitorDir, incidentsDir, config, now, state })
    result.maintenance = pruned

    // ---------------------------------------------------------- state
    state.v = 1
    state.host = hostname
    state.updatedAt = now
    state.lastRunAt = now
    state.lastRunOk = true
    state.runs = asNumber(state.runs, 0) + 1
    state.failures = 0
    state.lastError = null
    state.process = {
      alive: processInfo?.ok === true && processInfo.alive === true,
      pid: processInfo?.main?.pid || 0,
      startedAt: processInfo?.main?.startedAt || 0,
      firstSeenAt: state.process?.firstSeenAt || (processInfo?.alive ? now : 0),
      lastSeenAt: processInfo?.alive ? now : asNumber(state.process?.lastSeenAt, 0),
      queryOkAt: now,
    }
    state.heartbeat = {
      lastSeen: heartbeat?.lastSeen || 0,
      pid: heartbeat?.pid || 0,
      bootId: heartbeat?.bootId || null,
      ageMs: heartbeat?.lastSeen ? now - heartbeat.lastSeen : null,
      lastHeartbeatAt: heartbeat?.lastSeen || 0,
    }
    state.events = {
      lastCheckAt: now,
      lastOk: rawEvents.ok,
      applicationCursor: Math.max(asNumber(state.events?.applicationCursor, 0), ...recentEvents.filter((event) => event.log === 'Application').map((event) => asNumber(event.recordId, 0)), 0),
      systemCursor: Math.max(asNumber(state.events?.systemCursor, 0), ...recentEvents.filter((event) => event.log === 'System').map((event) => asNumber(event.recordId, 0)), 0),
      recent: recentEvents,
    }
    if (classification.suppressed.some((item) => item.kind === 'crash')) state.lastSleepAt = now
    // 统计来源显式落盘：heartbeat（与插件 monitor 同源）或 scan（兜底）。
    state.statsSource = currentStats.source
    state.stats = currentStats.stats
      ? { source: currentStats.source, at: now, ...currentStats.stats }
      : { source: currentStats.source, at: now }
    if (currentStats.scannedStats && currentStats.source === 'heartbeat') {
      state.scannedStats = { at: now, ...currentStats.scannedStats }
    }
    state.channels = {
      at: now,
      results: result.channels.flatMap((entry) => entry.results).slice(-40),
      secrets: secrets.ok ? 'ok' : (secrets.reason || 'unavailable'),
    }
    state.outbox = { pending: await countOutbox(monitorDir), lastFlushAt: now }
    await writeJsonAtomic(path.join(monitorDir, 'watchdog-state.json'), state)
    await log('info', `run ok incidents=${result.incidents.length} merged=${result.merged.length} ` +
      `suppressed=${result.suppressed.length} baseline=${result.baselineUpdated} durationMs=${Date.now() - startedWall}`)
  } catch (error) {
    result.ok = false
    const message = String(error?.message || error).slice(0, 400)
    result.errors.push({ code: 'run-failed', message })
    try {
      if (monitorDir) {
        const state = await readState(monitorDir)
        state.lastRunAt = now
        state.lastRunOk = false
        state.failures = asNumber(state.failures, 0) + 1
        state.lastError = message
        state.updatedAt = now
        await writeJsonAtomic(path.join(monitorDir, 'watchdog-state.json'), state)
        await appendLog(path.join(monitorDir, 'watchdog.log'),
          `${new Date(now).toISOString()} [watchdog] error run failed: ${message}`)
      }
    } catch { /* ignore */ }
  } finally {
    if (lock && lock.held === true && typeof lock.release === 'function') {
      try { await lock.release() } catch { /* ignore */ }
      result.lock = { ...(result.lock || {}), released: true }
    }
    result.durationMs = Date.now() - startedWall
  }
  return result
}

/* --------------------------------------------------------------- CLI */

const USAGE = `dsh-disaster-recovery 外部看门狗 v${WATCHDOG_VERSION}

  node watchdog.mjs --once [选项]        跑一次（计划任务每分钟调用）
  node watchdog.mjs --loop               调试用：按 --interval-ms 循环
  node watchdog.mjs --test-notify <ch>   面板「测试」按钮：只发选中通道的一条测试消息
                                         ch = panel|toast|webhook|email|qq|peer

选项：
  --config <file>        配置文件（默认 %LOCALAPPDATA%\\DeepSeek Recovery\\monitor\\config.json，
                         也可用环境变量 DSH_MONITOR_CONFIG）
  --recovery-home <dir>  外部恢复区（默认 %LOCALAPPDATA%\\DeepSeek Recovery）
  --store-root <dir>     覆盖配置里的 storeRoot
  --home <dir>           覆盖配置里的 DSH_HOME
  --hostname <name>      覆盖 store 的 host 目录名
  --json                 只输出 JSON 摘要
  --test-notify <ch>     只测试选中通知通道（panel|toast|webhook|email|qq|peer），
                         输出 {ok,channel,result}；退出码 0=通过、1=通道未通过、2=参数/配置错误
  --no-notify            只记录事故、不发任何通知（调试/演练）
  --skip-lock            跳过单实例锁（仅测试）
  --help / --version

行为约束：只读 DSH、绝不启动/重启/杀 DSH、绝不写 .dsh；只记录 + 通知。`

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(1000, Number(ms) || 60000)))
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) { process.stdout.write(`${USAGE}\n`); return 0 }
  if (args.version) { process.stdout.write(`${WATCHDOG_VERSION}\n`); return 0 }
  const baseOptions = {
    configPath: typeof args.config === 'string' ? args.config : undefined,
    recoveryHome: typeof args['recovery-home'] === 'string' ? args['recovery-home'] : undefined,
    storeRoot: typeof args['store-root'] === 'string' ? args['store-root'] : undefined,
    home: typeof args.home === 'string' ? args.home : undefined,
    hostname: typeof args.hostname === 'string' ? args.hostname : undefined,
    lockPath: typeof args.lock === 'string' ? args.lock : undefined,
    scriptDir: typeof args['script-dir'] === 'string' ? args['script-dir'] : undefined,
    noNotify: args['no-notify'] === true,
    skipLock: args['skip-lock'] === true,
  }
  if (args['test-notify'] !== undefined) {
    const channelArg = args['test-notify']
    const report = await testNotify({
      ...baseOptions,
      channel: typeof channelArg === 'string' ? channelArg : '',
    })
    const fatal = report.result?.code === 'bad-channel' || report.result?.code === 'config-missing'
    if (args.json || args.quiet) process.stdout.write(`${JSON.stringify(report)}\n`)
    else {
      process.stdout.write(`通知通道测试：${report.channel || '(未知)'} → ${report.ok ? '通过' : '未通过'}\n`)
      process.stdout.write(`  code   : ${report.result?.code || 'unknown'}\n`)
      if (report.result?.detail) process.stdout.write(`  detail : ${report.result.detail}\n`)
      const file = report.result?.path || report.result?.outboxFile
      if (file) process.stdout.write(`  file   : ${file}\n`)
      if (Array.isArray(report.result?.hooks)) {
        for (const hook of report.result.hooks) {
          process.stdout.write(`  hook ${hook.name}: ${hook.ok ? 'ok' : 'fail'} attempts=${hook.attempts}` +
            `${hook.status ? ` status=${hook.status}` : ''}${hook.error ? ` error=${hook.error}` : ''}\n`)
        }
      }
      process.stdout.write(`  config : ${report.configPath}\n`)
    }
    if (fatal) return 2
    return report.ok ? 0 : 1
  }
  if (args.loop) {
    const interval = Math.max(5000, Number(args['interval-ms']) || 60000)
    let stopping = false
    const stop = () => { stopping = true }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    process.stdout.write(`[watchdog] loop mode, interval ${interval}ms\n`)
    while (!stopping) {
      const result = await runOnce({ ...baseOptions, mode: 'loop' })
      process.stdout.write(`${JSON.stringify(result)}\n`)
      if (stopping) break
      await sleep(interval)
    }
    return 0
  }
  const result = await runOnce({ ...baseOptions, mode: 'once' })
  if (args.json || args.quiet) process.stdout.write(`${JSON.stringify(result)}\n`)
  else {
    const summary = result.skipped === 'locked'
      ? '跳过：另一个看门狗实例正在运行'
      : `检查完成：事故 ${result.incidents.length}，合并 ${result.merged.length}，` +
        `抑制 ${result.suppressed.length}，基线${result.baselineUpdated ? '已更新' : '未变'}，${result.durationMs}ms`
    process.stdout.write(`${summary}\n`)
    if (result.warnings.length) process.stdout.write(`提示：${result.warnings.join(', ')}\n`)
    if (!result.ok) process.stdout.write(`错误：${result.errors.map((item) => item.message).join('; ')}\n`)
  }
  return result.ok ? 0 : 1
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1]
    if (!entry) return false
    return pathToFileURL(path.resolve(entry)).href === import.meta.url
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((error) => {
    try { process.stderr.write(`watchdog fatal: ${String(error?.stack || error)}\n`) } catch { /* ignore */ }
    process.exit(1)
  })
}
