/**
 * 插件内黑匣子（崩溃监控）：心跳、启动时事故检测、事故记录、体检、外部看门狗安装、一键恢复联动。
 *
 * 数据全部落在备份盘（`.dsh` 整个没了也还在）：
 *   <storeRoot>/<host>/monitor/
 *     heartbeat.json          每 5s 原子覆盖（schema 见 docs/CRASH-MONITORING.md §2）
 *     heartbeat.log           30s 一条，5MB 轮转
 *     baseline.json           健康时的数据基线（24h 最多一次）
 *     incidents/<id>.json     事故记录（§4 schema）
 *     alerts/current.json     最新未关闭事故摘要（面板/看门狗读；合并时保留其它 source 条目）
 *     alerts/ack.json         已读/忽略标记（`{v:1,acked:{id:at}}`，与看门狗共用）
 *     outbox/<id>.json        待外发通知（看门狗接管 fan-out）
 *     last-verify.json        上次体检结果（只读检查的缓存）
 *
 * 硬约束：
 *   - **绝不每 5s 递归遍历 home**：心跳里的 stats 用 engine 的内存清单 + 每 60s 一次的轻量
 *     readdir（sessions/storages/profiles/attachments），失败一律吞掉只记日志；
 *   - 写盘失败只记日志，绝不抛给引擎/插件生命周期；
 *   - 本模块只写 `<storeRoot>/<host>/monitor/**`（watchdog-state.json 由外部看门狗独占，只读）；
 *   - 不杀进程、不重启 DSH、不联网、不自动恢复（恢复必须由用户手动确认）。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  entryChunks, exists, makeSnapshotId, readJsonSafe, writeFileAtomic, writeJsonAtomic,
} from './util.js'
import { createDpapiClient } from './offsite.js'

/** 监控数据格式版本（heartbeat/incidents 的 v）。 */
export const MONITOR_VERSION = 1
/** 外部看门狗计划任务名（与 install-external.ps1 对齐）。 */
export const WATCHDOG_TASK_NAME = 'DSH-DisasterWatchdog'
/** 监控数据目录（相对 storeRoot）：<storeRoot>/<host>/monitor。 */
export const MONITOR_DIR_NAME = 'monitor'
/** 子机通知 RPC（dsh-sync 提供：ext.dr.notify）。 */
export const PEER_NOTIFY_OP = 'ext.dr.notify'
/** 子机通知补发周期。 */
const PEER_FLUSH_INTERVAL_MS = 60_000
/** 子机通知 RPC 超时。 */
const PEER_RPC_TIMEOUT_MS = 15_000
/** outbox 每个通道的默认最大尝试次数（与 watchdog 的 notify.outboxMaxAttempts 一致）。 */
const DEFAULT_OUTBOX_MAX_ATTEMPTS = 12

export const MONITOR_DEFAULTS = Object.freeze({
  /** 心跳周期（文档 §2：5s）。 */
  intervalMs: 5000,
  /** 轻量数据统计刷新周期（禁止每 5s 遍历 home）。 */
  statsRefreshMs: 60_000,
  /** heartbeat.log 追加周期。 */
  heartbeatLogMs: 30_000,
  /** heartbeat.log 轮转阈值。 */
  heartbeatLogMaxBytes: 5 * 1024 * 1024,
  /** 启动时“上一份心跳距今多久才算异常退出”（用户拍板：>30s）。 */
  crashGapMs: 30_000,
  /** 同 kind 事故合并窗口。 */
  mergeWindowMs: 30 * 60_000,
  /** 面板页面 ping 超过这个时长没更新 → 视为“进程在、界面卡死”的证据。 */
  clientPingStaleMs: 60_000,
  /** 文件数骤降阈值：max(dataLossMinFiles, 基线 * dataLossRatio)。 */
  dataLossMinFiles: 50,
  dataLossRatio: 0.05,
  /** 事故/outbox 保留天数。 */
  retentionDays: 90,
  /** baseline 最短更新间隔。 */
  baselineIntervalMs: 24 * 3600_000,
  /** 安装外部看门狗的超时。 */
  installTimeoutMs: 120_000,
  /** 运行期数据骤降检测的启动宽限期（避免启动快照期间误报）。 */
  runtimeDetectGraceMs: 60_000,
  /** 子机通知补发周期。 */
  peerFlushIntervalMs: 60_000,
  /** 子机通知总开关（插件配置可关；默认开，是否可达由 dsh-sync 配对状态决定）。 */
  peerNotify: true,
  /** 恢复后多久内不做运行期数据骤降检测。 */
  runtimeDetectAfterRestoreMs: 5 * 60_000,
  /** 秒级“变全新客户端”检查：启动后宽限期（等 startup 快照/文件稳定）。 */
  keyCheckGraceMs: 15_000,
  /** 秒级检查：sessions 相对上一轮下降多少个即报 data-loss。 */
  keyCheckSessionsDrop: 5,
  /** 秒级检查是否抓进程命令行快照（PowerShell Get-CimInstance；失败降级）。 */
  captureCommandLines: true,
  /** 覆写/大量变更检测：changed+deleted 超过 max(minFiles, 文件数 * ratio) 才报。 */
  massChangeEnabled: true,
  massChangeMinFiles: 200,
  massChangeRatio: 0.15,
  /** 事故保护：是否自动暂停自动快照（data-loss/backup-corrupt/mass-change）。 */
  autoProtect: true,
})

const INCIDENT_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,120}$/
const SNAPSHOT_LIMIT = 300
const RECENT_INCIDENT_LIMIT = 5

function noop() {}

function sanitizeHostTag(name) {
  return String(name || 'host').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'host'
}

/** 带 code 的错误（面板统一转成 `{ok:false,error:{code,message}}`）。 */
export function monitorError(code, message) {
  const error = new Error(String(message || code || 'monitor-error'))
  error.code = String(code || 'monitor-error')
  return error
}

function toNumberOrNull(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clip(text, max) {
  const value = String(text == null ? '' : text)
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function normalizeStats(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const key of ['files', 'bytes', 'sessions', 'storages', 'profiles', 'attachments']) {
    out[key] = toNumberOrNull(source[key])
  }
  const rawKeyFiles = source.keyFiles && typeof source.keyFiles === 'object' ? source.keyFiles : {}
  out.credentials = source.credentials === true || rawKeyFiles.credentials === true
  out.keyFiles = {
    workspace: rawKeyFiles.workspace === true || source.workspace === true,
    profile: rawKeyFiles.profile === true || source.profile === true,
    credentials: out.credentials,
  }
  return out
}

/** 目录里条目计数（不递归超过 maxDepth，防止在异常大的目录上卡住）。 */
async function countTree(dir, { dirs = false, maxDepth = 2, cap = 20_000 } = {}) {
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
 * sessions 的会话数：真实布局是 sessions/<workspace>/<session-id>/…，
 * 数第二层目录；如果只有一层（旧布局/自定义），退化为数第一层目录。
 */
async function countSessions(dir) {
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

function aggregateManifest(manifest) {
  const files = manifest && manifest.files && typeof manifest.files === 'object' ? manifest.files : null
  if (!files) return null
  let count = 0
  let bytes = 0
  for (const entry of Object.values(files)) {
    count += 1
    bytes += Number(entry && entry.s) || 0
  }
  return { files: count, bytes }
}

/* ------------------------------------------------------------------ 主体 */

/**
 * @param {object} options
 * @param {object} options.engine      备份引擎（只读使用；恢复时调用 engine.restore）
 * @param {string} options.home        DSH 数据目录
 * @param {string} options.storeDir    备份根目录（monitor 数据落在 <storeDir>/<host>/monitor）
 * @param {string} [options.hostname]  主机名（默认 engine.hostname / os.hostname()）
 * @param {string} [options.version]   插件版本
 * @param {Function} [options.logger]
 * @param {Function} [options.getOffsite] 取异地副本服务（可缺省）
 * @param {Function} [options.getSync] 取 dsh-sync 服务（子机通知用；可缺省）
 * @param {object} [options.config]    阈值覆盖（见 MONITOR_DEFAULTS）
 * @param {Function} [options.now]     时间源（测试可注入）
 * @param {Function} [options.spawnProcess] 可注入的 spawn（测试用）
 * @param {string} [options.externalDir] 外部恢复区（默认 %LOCALAPPDATA%\\DeepSeek Recovery）
 * @param {string} [options.installScriptPath] 安装脚本路径覆盖（测试用）
 * @param {object} [options.dpapi]      DPAPI 客户端覆盖（测试用：{available,protect,unprotect}）
 */
export function createMonitorService({
  engine,
  home,
  storeDir,
  hostname,
  version,
  logger = noop,
  getOffsite,
  getSync,
  config,
  now = () => Date.now(),
  spawnProcess = nodeSpawn,
  externalDir,
  installScriptPath,
  dpapi,
} = {}) {
  const cfg = { ...MONITOR_DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const homeAbs = path.resolve(String(home || (engine && engine.home) || path.join(os.homedir(), '.dsh')))
  const rootAbs = path.resolve(String(
    storeDir
    || (engine && engine.config && engine.config.root)
    || 'D:\\dsh-backup',
  ))
  const hostTag = sanitizeHostTag(hostname || (engine && engine.hostname) || os.hostname())
  const pluginVersion = String(version || (engine && engine.version) || '0.0.0')
  const hostDir = path.join(rootAbs, hostTag)
  const monitorDir = path.join(hostDir, MONITOR_DIR_NAME)
  const incidentDir = path.join(monitorDir, 'incidents')
  const alertsDir = path.join(monitorDir, 'alerts')
  const outboxDir = path.join(monitorDir, 'outbox')
  const heartbeatFile = path.join(monitorDir, 'heartbeat.json')
  const heartbeatLogFile = path.join(monitorDir, 'heartbeat.log')
  const baselineFile = path.join(monitorDir, 'baseline.json')
  const alertsCurrentFile = path.join(alertsDir, 'current.json')
  const alertsAckFile = path.join(alertsDir, 'ack.json')
  const verifyFile = path.join(monitorDir, 'last-verify.json')
  const watchdogStateFile = path.join(monitorDir, 'watchdog-state.json')
  const externalRoot = path.resolve(String(
    externalDir
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DeepSeek Recovery'),
  ))
  const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
  const installerFile = installScriptPath || path.join(repoRoot, 'scripts', 'install-external.ps1')
  const notifyConfigFile = path.join(externalRoot, 'monitor', 'config.json')
  const notifySecretsFile = path.join(externalRoot, 'monitor', 'secrets.dpapi')
  const notifyBackupDir = path.join(monitorDir, 'config-backups')
  const watchdogScript = path.join(externalRoot, 'monitor', 'watchdog.mjs')

  const log = (message) => {
    try { logger(`[monitor] ${message}`) } catch { /* logger 不可用 */ }
  }
  const logError = (label, error) => log(`${label}: ${String((error && error.message) || error)}`)

  const state = {
    started: false,
    stopping: false,
    bootId: '',
    startedAt: 0,
    lastSeen: 0,
    clientLastSeen: 0,
    lastAction: null,
    stats: normalizeStats(null),
    baseline: null,
    previousHeartbeat: null,
    lastVerify: null,
    lastStatsAt: 0,
    lastLogAt: 0,
    startError: null,
    stoppingDone: null,
    installBusy: false,
    installResult: null,
    peerBusy: false,
    peerLastRunAt: 0,
    peerLastResult: null,
    peerLastError: null,
    timers: { heartbeat: null, stats: null, peer: null },
    writeChain: Promise.resolve(),
    statePromise: null,
    stateCache: null,
    stateCacheAt: 0,
    recentCache: null,
    recentCacheAt: 0,
    externalCache: null,
    externalCacheAt: 0,
    alertsCache: null,
    alertsCacheAt: 0,
    // 秒级“变全新客户端”检查（每 5s 只 readdir sessions + stat 3 个关键文件）
    keyStats: null,
    keyLastLossAt: 0,
    // 覆写/大量变更检测：记住最近一次已处理的快照 id
    lastProcessedSnapshotId: null,
    massCheckBusy: false,
    // 事故保护（自动 pause + pin）状态
    protection: null,
    // 通知配置编辑 / 备份根目录修改的串行保护
    notifyBusy: false,
    notifyTestBusy: false,
    rootBusy: false,
  }

  function enqueueWrite(fn) {
    const next = state.writeChain.then(() => fn(), () => fn())
    state.writeChain = next.then(() => {}, () => {})
    return next
  }

  async function ensureDirs() {
    await fsp.mkdir(incidentDir, { recursive: true })
    await fsp.mkdir(alertsDir, { recursive: true })
    await fsp.mkdir(outboxDir, { recursive: true })
  }

  function ensureDirsSync() {
    fs.mkdirSync(incidentDir, { recursive: true })
    fs.mkdirSync(alertsDir, { recursive: true })
    fs.mkdirSync(outboxDir, { recursive: true })
  }

  /* ------------------------------------------------------------ 数据统计 */

  /** 轻量统计：只 readdir 4 个固定目录（60s 一次），不遍历整个 home。 */
  async function computeLightStats() {
    const homeDir = homeAbs
    const sessions = await countSessions(path.join(homeDir, 'sessions'))
    const storages = await countTree(path.join(homeDir, 'storages'), { dirs: false, maxDepth: 3 })
    const profiles = await countTree(path.join(homeDir, 'profiles'), { dirs: true, maxDepth: 1 })
    const attachments = await countTree(path.join(homeDir, 'attachments'), { dirs: false, maxDepth: 3 })
    const keyFiles = await checkKeyFiles()
    return { sessions, storages, profiles, attachments, credentials: keyFiles.credentials, keyFiles }
  }

  /**
   * 关键文件存在性（秒级检查 + stats/baseline 用）：
   * storages/workspace.json、profiles/desktop/package.json、.credentials.yaml。
   */
  async function checkKeyFiles() {
    const homeDir = homeAbs
    const [workspace, profile, credentials] = await Promise.all([
      exists(path.join(homeDir, 'storages', 'workspace.json')).catch(() => false),
      exists(path.join(homeDir, 'profiles', 'desktop', 'package.json')).catch(() => false),
      exists(path.join(homeDir, '.credentials.yaml')).catch(() => false),
    ])
    return { workspace, profile, credentials }
  }

  /** 文件数/字节：来自 engine 已加载的最新清单（内存），不扫盘。 */
  function computeBackupStats() {
    if (!engine) return { files: null, bytes: null }
    const manifest = engine.lastManifest
    const agg = aggregateManifest(manifest)
    if (agg) return agg
    try {
      const snapshot = engine.state && engine.state().lastSnapshot
      const files = snapshot ? Number(snapshot.files) : NaN
      return { files: Number.isFinite(files) ? files : null, bytes: null }
    } catch {
      return { files: null, bytes: null }
    }
  }

  function backupInfo() {
    let snapshots = []
    try { snapshots = Array.isArray(engine && engine.snapshots) ? engine.snapshots : [] } catch { snapshots = [] }
    const last = (engine && engine.lastManifest) || snapshots[0] || null
    const at = last ? Number(last.at) || 0 : 0
    let lastError = null
    try { if (engine && engine.lastError) lastError = clip(engine.lastError, 300) } catch { lastError = null }
    return {
      snapshots: snapshots.length,
      latestId: last ? String(last.id || '') : null,
      latestAt: at,
      lastSnapshotAt: at,
      lastError,
    }
  }

  function offsiteInfo() {
    const empty = {
      configured: false, locked: true, lastExportAt: 0, lastSyncAt: 0, peerOnline: false, archives: 0,
    }
    try {
      const service = typeof getOffsite === 'function' ? getOffsite() : null
      if (!service || typeof service.summary !== 'function') return empty
      const summary = service.summary() || {}
      return {
        configured: Boolean(summary.initialized) && summary.enabled !== false,
        locked: summary.locked !== false,
        lastExportAt: Number(summary.lastExportAt) || 0,
        lastSyncAt: Number(summary.lastSyncAt) || 0,
        peerOnline: Boolean(summary.peer && summary.peer.online),
        archives: Number(summary.archives) || 0,
        dir: typeof summary.dir === 'string' ? summary.dir : null,
      }
    } catch {
      return empty
    }
  }

  /* --------------------------------------------------------------- 心跳 */

  function buildHeartbeat({ cleanExit = false } = {}) {
    const seenAt = state.lastSeen || now()
    return {
      v: MONITOR_VERSION,
      bootId: state.bootId,
      pid: process.pid,
      startedAt: state.startedAt || seenAt,
      lastSeen: seenAt,
      cleanExit: Boolean(cleanExit),
      cleanExitAt: cleanExit ? now() : 0,
      version: pluginVersion,
      host: { name: hostTag, home: homeAbs, root: rootAbs },
      stats: { ...state.stats },
      backup: backupInfo(),
      offsite: offsiteInfo(),
      client: { lastSeen: state.clientLastSeen || 0 },
      lastAction: state.lastAction ? { ...state.lastAction } : null,
    }
  }

  async function writeHeartbeat({ final = false } = {}) {
    if (state.stopping && !final) return null
    const heartbeat = buildHeartbeat({ cleanExit: final })
    await writeJsonAtomic(heartbeatFile, heartbeat)
    return heartbeat
  }

  /** 最终 cleanExit 用同步写：dispose 期间进程可能马上退出，异步写不保证落盘。 */
  function writeHeartbeatSync({ final = false } = {}) {
    try {
      ensureDirsSync()
      const heartbeat = buildHeartbeat({ cleanExit: final })
      const body = Buffer.from(`${JSON.stringify(heartbeat, null, 2)}\n`, 'utf8')
      const tmp = `${heartbeatFile}.${process.pid}.${Date.now().toString(36)}.tmp`
      fs.writeFileSync(tmp, body)
      fs.renameSync(tmp, heartbeatFile)
    } catch (error) {
      logError('heartbeat write failed', error)
    }
  }

  async function appendHeartbeatLog() {
    if (now() - state.lastLogAt < cfg.heartbeatLogMs) return
    state.lastLogAt = now()
    const line = JSON.stringify({
      at: state.lastSeen,
      pid: process.pid,
      bootId: state.bootId,
      stats: { files: state.stats.files, sessions: state.stats.sessions },
      backup: (() => { const info = backupInfo(); return { snapshots: info.snapshots, latestId: info.latestId } })(),
      version: pluginVersion,
    })
    try {
      const stat = await fsp.stat(heartbeatLogFile).catch(() => null)
      if (stat && stat.size > cfg.heartbeatLogMaxBytes) {
        await fsp.rename(heartbeatLogFile, `${heartbeatLogFile}.1`).catch(() => {})
      }
      await fsp.appendFile(heartbeatLogFile, `${line}\n`)
    } catch (error) {
      logError('heartbeat.log append failed', error)
    }
  }

  /* ----------------------------------------------------------- 事故读写 */

  async function readAlerts({ maxAgeMs = 0 } = {}) {
    if (maxAgeMs > 0 && state.alertsCache && now() - state.alertsCacheAt < maxAgeMs) return state.alertsCache
    const raw = await readJsonSafe(alertsCurrentFile, null)
    const alerts = raw && typeof raw === 'object' ? raw : null
    state.alertsCache = alerts
    state.alertsCacheAt = now()
    return alerts
  }

  /** 已读/忽略标记：`{v:1,acked:{<id>:<epochMs>}}`（与外部看门狗共用同一文件）。 */
  async function readAckMap() {
    const raw = await readJsonSafe(alertsAckFile, null)
    const source = raw && typeof raw === 'object'
      ? (raw.acked && typeof raw.acked === 'object' ? raw.acked : raw)
      : {}
    const out = {}
    for (const [id, at] of Object.entries(source)) {
      if (INCIDENT_ID_PATTERN.test(id) && Number.isFinite(Number(at))) out[id] = Number(at)
    }
    state.ackCache = out
    state.ackCacheAt = now()
    return out
  }

  async function writeAlertsCurrent() {
    const previous = await readAlerts({ maxAgeMs: 0 })
    const base = previous && typeof previous === 'object' ? previous : {}
    // 与外部看门狗的双键（open / incidents）兼容：两处都收集非 monitor 条目，按 id 合并。
    const others = []
    for (const list of [base.open, base.incidents]) {
      if (!Array.isArray(list)) continue
      for (const entry of list) {
        if (!entry || typeof entry !== 'object' || entry.source === 'monitor') continue
        if (!others.some((item) => item.id === entry.id)) others.push(entry)
      }
    }
    const incidents = await listIncidents({ limit: 500, useCache: false })
    const acked = await readAckMap()
    const open = incidents
      .filter((incident) => incident && incident.status === 'open' && !acked[String(incident.id)])
      .map(summaryEntry)
    const merged = [...open, ...others.filter((entry) => !acked[String(entry.id)] && !open.some((item) => item.id === entry.id))]
    const last = incidents.length ? summaryEntry(incidents[0]) : (base.last && typeof base.last === 'object' ? base.last : null)
    const next = {
      ...base,
      v: MONITOR_VERSION,
      at: now(),
      updatedAt: now(),
      source: 'monitor',
      open: merged,
      incidents: merged,
      count: merged.length,
      last,
    }
    await writeJsonAtomic(alertsCurrentFile, next)
    state.alertsCache = next
    state.alertsCacheAt = now()
  }

  function summaryEntry(incident) {
    const impact = incident.impact || {}
    const bad = Array.isArray(impact.snapshots && impact.snapshots.bad) ? impact.snapshots.bad : []
    return {
      id: String(incident.id || ''),
      kind: String(incident.kind || 'other'),
      severity: String(incident.severity || 'medium'),
      status: String(incident.status || 'open'),
      detectedAt: Number(incident.detectedAt) || 0,
      firstAt: Number(incident.firstAt) || Number(incident.detectedAt) || 0,
      lastAt: Number(incident.lastAt) || Number(incident.detectedAt) || 0,
      recoveredAt: Number(incident.recoveredAt) || 0,
      summary: clip(incident.summary || '', 400),
      source: 'monitor',
      recommendation: incident.recommendation || null,
      data: incident.evidence && incident.evidence.data
        ? {
          before: incident.evidence.data.before || null,
          after: incident.evidence.data.after || null,
          delta: incident.evidence.data.delta || null,
        }
        : null,
      impact: {
        local: {
          checked: Number(impact.local && impact.local.checked) || 0,
          badCount: Number(impact.local && impact.local.badCount) || bad.length,
          bad: bad.slice(0, 10),
        },
        offsite: {
          checked: Number(impact.offsite && impact.offsite.checked) || 0,
          badCount: Number(impact.offsite && impact.offsite.badCount) || 0,
          bad: Array.isArray(impact.offsite && impact.offsite.bad) ? impact.offsite.bad.slice(0, 10) : [],
        },
      },
      timeline: Array.isArray(incident.timeline) ? incident.timeline.slice(-20) : [],
      recovery: incident.recovery || null,
      protection: incident.protection && typeof incident.protection === 'object'
        ? {
          pausedBefore: incident.protection.pausedBefore,
          autoPaused: incident.protection.autoPaused !== false && incident.protection.pausedApplied === true,
          pinnedSnapshot: incident.protection.pinnedSnapshot || null,
          at: Number(incident.protection.at) || 0,
          releasedAt: Number(incident.protection.releasedAt) || 0,
        }
        : null,
    }
  }

  async function readIncident(id) {
    const value = String(id || '')
    if (!INCIDENT_ID_PATTERN.test(value)) throw monitorError('bad-id', `非法事故 id：${value.slice(0, 80)}`)
    const incident = await readJsonSafe(path.join(incidentDir, `${value}.json`), null)
    if (!incident || typeof incident !== 'object') throw monitorError('incident-missing', `事故不存在：${value}`)
    return incident
  }

  async function listIncidents({ limit = 200, useCache = true } = {}) {
    if (useCache && state.recentCache && now() - state.recentCacheAt < 5_000) {
      return state.recentCache.slice(0, limit)
    }
    let names = []
    try { names = await fsp.readdir(incidentDir) } catch { names = [] }
    const incidents = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -5)
      if (!INCIDENT_ID_PATTERN.test(id)) continue
      const incident = await readJsonSafe(path.join(incidentDir, name), null)
      if (incident && typeof incident === 'object') incidents.push({ ...incident, id: String(incident.id || id) })
    }
    incidents.sort((a, b) => (Number(b.detectedAt) || 0) - (Number(a.detectedAt) || 0))
    state.recentCache = incidents
    state.recentCacheAt = now()
    return incidents.slice(0, limit)
  }

  async function uniqueIncidentId(at, kind) {
    const base = makeSnapshotId(new Date(at), kind)
    let candidate = base
    let suffix = 2
    for (;;) {
      if (!(await exists(path.join(incidentDir, `${candidate}.json`)))) return candidate
      candidate = `${base}-${suffix}`
      suffix += 1
      if (suffix > 200) return `${base}-${randomUUID().slice(0, 6)}`
    }
  }

  function severityRank(value) {
    if (value === 'high') return 3
    if (value === 'medium') return 2
    if (value === 'low') return 1
    return 0
  }

  /**
   * outbox 与外部看门狗对齐（watchdog 定稿结构）：
   * `{v:1, incidentId, kind, createdAt, updatedAt, status, channels:{panel:{status…},…}, payload:{…}}`。
   * 已标记 sent 的文件不降级；插件只排队 `peer`（DSH 启动后由 flushPeerOutbox 补发）。
   */
  async function writeOutbox(incident) {
    const id = String(incident.id || '')
    if (!INCIDENT_ID_PATTERN.test(id)) return
    const file = path.join(outboxDir, `${id}.json`)
    const existing = await readJsonSafe(file, null)
    const priorChannels = existing && existing.channels && typeof existing.channels === 'object' ? existing.channels : {}
    const channels = {}
    for (const channel of ['panel', 'toast', 'webhook', 'email', 'qq', 'peer']) {
      const prior = priorChannels[channel]
      channels[channel] = prior && typeof prior === 'object'
        ? prior
        : { status: channel === 'panel' ? 'sent' : 'pending', attempts: 0, lastError: null }
    }
    const peerReady = Boolean(channels.peer && channels.peer.status === 'sent')
    if (!peerReady && channels.peer && channels.peer.status === 'pending' && !channels.peer.waitingFor) {
      // peer 是 DSH 侧通道：外部看门狗拿不到 dshSync，只能由插件补发。
      channels.peer = { ...channels.peer, waitingFor: 'plugin' }
    }
    const payload = {
      v: MONITOR_VERSION,
      incidentId: id,
      kind: String(incident.kind || 'other'),
      createdAt: Number(existing && existing.createdAt) || now(),
      updatedAt: now(),
      status: existing && existing.status === 'sent' ? 'sent' : 'pending',
      channels,
      payload: {
        title: `DSH ${String(incident.kind || 'incident')}`,
        body: clip(incident.summary || '', 400),
        host: hostTag,
        incident: {
          id,
          kind: String(incident.kind || 'other'),
          severity: String(incident.severity || 'medium'),
          detectedAt: Number(incident.detectedAt) || 0,
          summary: clip(incident.summary || '', 400),
          recommendation: incident.recommendation || null,
        },
      },
    }
    if (!peerReady) payload.peerPending = true
    await writeJsonAtomic(file, payload)
  }

  /* ------------------------------------------------------ 子机通知补发（peer） */

  function syncPort() {
    try {
      const sync = typeof getSync === 'function' ? getSync() : null
      if (!sync || typeof sync.rpc !== 'function') return null
      return sync
    } catch {
      return null
    }
  }

  function peerErrorMessage(code) {
    switch (code) {
      case 'sync-missing': return '没有可用的设备同步（dsh-sync 未安装或未启用）'
      case 'sync-not-ready': return '设备同步尚未就绪，请稍后再试'
      case 'no-peers': return '还没有已配对的子机'
      case 'peer-not-found': return '配置的子机不在已配对列表中'
      case 'peer-offline': return '子机不在线'
      case 'peer-disabled': return '子机通知通道已关闭'
      default: return '子机通知暂不可用'
    }
  }

  /**
   * 选一个可用的子机：优先 offsite.peerSnapshot（已实现 peerDeviceId 优先 / trusted+online 兜底），
   * 没有 offsite 时退回 ctx.dshSync.peers() 自己挑。
   */
  function pickPeer() {
    let service = null
    try { service = typeof getOffsite === 'function' ? getOffsite() : null } catch { service = null }
    if (service && typeof service.peerSnapshot === 'function') {
      try {
        const snapshot = service.peerSnapshot({ force: true }) || service.peerSnapshot()
        if (snapshot && snapshot.sync) {
          if (!snapshot.id) return { ok: false, code: snapshot.reason || 'no-peers' }
          if (!snapshot.online) return { ok: false, code: 'peer-offline', deviceId: snapshot.id }
          return { ok: true, deviceId: String(snapshot.id), name: String(snapshot.name || '') }
        }
      } catch { /* 退回直接读 dshSync */ }
    }
    const sync = syncPort()
    if (!sync) return { ok: false, code: 'sync-missing' }
    let list = []
    try {
      list = sync.peers() || []
    } catch {
      return { ok: false, code: 'sync-not-ready' }
    }
    const peers = list
      .map((peer) => ({
        deviceId: String((peer && peer.deviceId) || ''),
        online: Boolean(peer && peer.online),
        trusted: Boolean(peer && peer.trusted),
      }))
      .filter((peer) => peer.deviceId)
    let wanted = ''
    try { wanted = String((service && service.config && service.config.peerDeviceId) || '').trim() } catch { wanted = '' }
    let picked = wanted ? peers.find((peer) => peer.deviceId === wanted) || null : null
    if (!picked) picked = peers.find((peer) => peer.online && peer.trusted) || peers.find((peer) => peer.online) || null
    if (!picked) return { ok: false, code: peers.some((peer) => peer.trusted) ? 'peer-offline' : 'no-peers' }
    if (!picked.online) return { ok: false, code: 'peer-offline', deviceId: picked.deviceId }
    return { ok: true, deviceId: picked.deviceId, name: '' }
  }

  function outboxMaxAttempts() {
    try {
      const notify = readExternalInfo().notify || {}
      const value = Number(notify.outboxMaxAttempts)
      if (Number.isFinite(value) && value > 0) return Math.min(100, Math.round(value))
    } catch { /* ignore */ }
    return DEFAULT_OUTBOX_MAX_ATTEMPTS
  }

  function peerNotificationsEnabled() {
    // 注意：不读外部 config 的 notify.peer.enabled —— peer 是 DSH 侧通道，
    // 是否可发由 dsh-sync 是否有已配对在线子机决定；要硬关用插件配置 monitor.peerNotify=false。
    return cfg.peerNotify !== false
  }

  /**
   * 只保留 lead 定稿的白名单字段：不含路径、文件内容、命令行、密钥。
   * 注意：dsh-sync 的 `ext.dr.notify` 里 `incident.recommendation` 是**展示字符串**
   * （sanitizeNotification 会对它 String()/裁剪），所以这里把结构化推荐点压成一行短文本。
   */
  function buildPeerNotifyPayload(entry) {
    const data = entry.payload && typeof entry.payload === 'object' ? entry.payload : {}
    const incident = data.incident && typeof data.incident === 'object' ? data.incident : {}
    const detectedAt = Number(incident.detectedAt || entry.detectedAt || entry.createdAt)
    const payload = {
      title: clip(data.title || `DSH ${incident.kind || entry.kind || 'incident'}`, 120),
      body: clip(data.body || incident.summary || '', 400),
      host: clip(data.host || hostTag, 80),
      incident: {
        id: String(incident.id || entry.incidentId || entry.id || ''),
        kind: String(incident.kind || entry.kind || 'other'),
        severity: String(incident.severity || 'medium'),
        detectedAt: Number.isFinite(detectedAt) && detectedAt > 0 ? detectedAt : now(),
      },
      sentAt: now(),
    }
    const recommendation = incident.recommendation
    if (recommendation && typeof recommendation === 'object') {
      const snapshotId = String(recommendation.snapshotId || '').trim()
      const at = Number(recommendation.at) || 0
      if (snapshotId) {
        const pad = (value) => String(value).padStart(2, '0')
        const date = at > 0 ? new Date(at) : null
        const stamp = date
          ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
          : ''
        payload.incident.recommendation = clip(
          `snapshot ${snapshotId}${stamp ? ` @ ${stamp}` : ''}${recommendation.verified === true ? ' (verified)' : ''}`,
          400,
        )
      }
    } else if (typeof recommendation === 'string' && recommendation.trim()) {
      payload.incident.recommendation = clip(recommendation.trim(), 400)
    }
    return payload
  }

  /** 只改 outbox 里 peer 通道字段（其它通道/未知字段/看门狗字段原样保留）。 */
  async function updatePeerChannel(file, entry, patch, { clearPeerPending = false } = {}) {
    const priorChannels = entry.channels && typeof entry.channels === 'object' && !Array.isArray(entry.channels)
      ? entry.channels
      : {}
    const priorPeer = priorChannels.peer && typeof priorChannels.peer === 'object' ? priorChannels.peer : {}
    const nextPeer = { ...priorPeer }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      if (value === null) delete nextPeer[key]
      else nextPeer[key] = value
    }
    const next = { ...entry, channels: { ...priorChannels, peer: nextPeer }, updatedAt: now() }
    if (clearPeerPending) delete next.peerPending
    const unchanged = JSON.stringify(priorChannels.peer || null) === JSON.stringify(nextPeer)
      && Boolean(entry.peerPending) === Boolean(next.peerPending)
    if (unchanged) return false
    await enqueueWrite(() => writeJsonAtomic(file, next))
    return true
  }

  /**
   * 补发 outbox 里的子机通知：DSH 启动后立即跑一次，之后每 60s 一次。
   * 成功 → `channels.peer={status:'sent',sentAt,deliveredAt}` 并清 peerPending；
   * 失败/离线/无 sync/未知 op → 保留 pending + lastError + attempts（绝不标 failed）。
   */
  async function flushPeerOutbox() {
    if (state.peerBusy) return { ok: false, code: 'busy', checked: 0, sent: 0, failed: 0, skipped: 0 }
    if (state.stopping) return { ok: false, code: 'stopped', checked: 0, sent: 0, failed: 0, skipped: 0 }
    state.peerBusy = true
    const startedAt = now()
    const result = {
      ok: true, checked: 0, sent: 0, failed: 0, skipped: 0, deviceId: null, durationMs: 0, error: null,
    }
    try {
      const maxAttempts = outboxMaxAttempts()
      let peer = null
      let peerError = null
      if (!peerNotificationsEnabled()) {
        peerError = { code: 'peer-disabled', message: peerErrorMessage('peer-disabled') }
      } else {
        const picked = pickPeer()
        if (picked.ok) {
          peer = picked
          result.deviceId = picked.deviceId
        } else {
          peerError = { code: picked.code, message: peerErrorMessage(picked.code) }
        }
      }
      let names = []
      try { names = await fsp.readdir(outboxDir) } catch { names = [] }
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const file = path.join(outboxDir, name)
        const entry = await readJsonSafe(file, null)
        if (!entry || typeof entry !== 'object') continue
        const rawChannel = entry.channels && typeof entry.channels === 'object' ? entry.channels.peer : null
        const channel = rawChannel && typeof rawChannel === 'object' ? rawChannel : null
        const pending = entry.peerPending === true || Boolean(channel && channel.status === 'pending')
        if (!pending) { result.skipped += 1; continue }
        result.checked += 1
        if (channel && channel.status === 'sent') { result.skipped += 1; continue }
        const attempts = Number(channel && channel.attempts) || 0
        if (attempts >= maxAttempts) {
          if (!(channel && channel.lastError && channel.lastError.code === 'max-attempts')) {
            await updatePeerChannel(file, entry, {
              status: 'pending',
              attempts,
              waitingFor: 'plugin',
              lastError: { code: 'max-attempts', message: `已达到最大重试次数（${maxAttempts}），保留 pending` },
              lastAttemptAt: now(),
            })
          }
          result.skipped += 1
          continue
        }
        if (!peer) {
          // 没 sync / 离线 / 被禁用：只记 lastError，不增加 attempts（没有真的发过）。
          const sameError = Boolean(channel && channel.lastError && channel.lastError.code === peerError.code)
          if (!sameError) {
            await updatePeerChannel(file, entry, {
              status: 'pending',
              waitingFor: 'plugin',
              lastError: peerError,
              lastAttemptAt: now(),
            })
          }
          result.failed += 1
          continue
        }
        const payload = buildPeerNotifyPayload(entry)
        try {
          const sync = syncPort()
          if (!sync) throw Object.assign(new Error(peerErrorMessage('sync-missing')), { code: 'sync-missing' })
          const response = await sync.rpc(peer.deviceId, PEER_NOTIFY_OP, payload, { timeoutMs: PEER_RPC_TIMEOUT_MS })
          if (!response || response.ok === false) {
            const code = String((response && (response.code || response.error)) || 'notify-failed')
            const message = clip((response && (response.message || response.error)) || '子机返回失败', 200)
            await updatePeerChannel(file, entry, {
              status: 'pending',
              attempts: attempts + 1,
              waitingFor: 'plugin',
              lastError: { code, message },
              lastAttemptAt: now(),
            })
            result.failed += 1
            continue
          }
          const deliveredAtRaw = response && response.deliveredAt
          const deliveredAtMs = (typeof deliveredAtRaw === 'number' && Number.isFinite(deliveredAtRaw) && deliveredAtRaw > 0)
            ? deliveredAtRaw
            : (typeof deliveredAtRaw === 'string' && Number.isFinite(Date.parse(deliveredAtRaw)) ? Date.parse(deliveredAtRaw) : now())
          const stored = response && typeof response.stored === 'string' ? clip(response.stored, 160) : undefined
          await updatePeerChannel(file, entry, {
            status: 'sent',
            attempts: attempts + 1,
            sentAt: now(),
            deliveredAt: deliveredAtMs,
            stored,
            lastError: null,
            lastAttemptAt: now(),
          }, { clearPeerPending: true })
          result.sent += 1
        } catch (error) {
          const code = String((error && (error.code || error.name)) || 'peer-rpc-failed')
          const message = clip((error && error.message) || error, 200)
          await updatePeerChannel(file, entry, {
            status: 'pending',
            attempts: attempts + 1,
            waitingFor: 'plugin',
            lastError: { code, message },
            lastAttemptAt: now(),
          })
          result.failed += 1
        }
      }
      result.durationMs = now() - startedAt
      state.peerLastRunAt = now()
      state.peerLastResult = { ...result }
      state.peerLastError = result.deviceId ? null : peerError
      noteAction('peer-flush')
      return result
    } catch (error) {
      const failure = { code: 'peer-flush-failed', message: clip((error && error.message) || error, 200) }
      state.peerLastError = failure
      state.peerLastRunAt = now()
      state.peerLastResult = { ...result, ok: false, error: failure }
      logError('peer outbox flush failed', error)
      return { ...result, ok: false, error: failure }
    } finally {
      state.peerBusy = false
    }
  }

  /**
   * 写一份事故：同 kind 且 30 分钟内还有 open 事故 → 合并 timeline（不刷屏）。
   * 新事故写 incidents/<id>.json + outbox + alerts/current.json。
   */
  async function recordIncident({
    kind, severity = 'medium', detectedAt, firstAt, summary, timeline = [], evidence = {}, impact, recommendation,
  }) {
    await ensureDirs()
    const at = Number(detectedAt) || now()
    const incidents = await listIncidents({ limit: 200, useCache: false })
    const existing = incidents.find((item) => (
      item
      && item.kind === kind
      && item.status === 'open'
      && at - (Number(item.lastAt) || Number(item.detectedAt) || 0) <= cfg.mergeWindowMs
    ))
    let incident
    if (existing) {
      incident = { ...existing }
      incident.lastAt = at
      incident.timeline = [...(Array.isArray(existing.timeline) ? existing.timeline : []), ...timeline].slice(-60)
      incident.evidence = mergeEvidence(existing.evidence, evidence)
      if (impact) incident.impact = simplifyImpact(impact)
      if (recommendation && !incident.recommendation) incident.recommendation = recommendation
      if (severityRank(severity) > severityRank(incident.severity)) incident.severity = severity
      incident.merges = [...(Array.isArray(existing.merges) ? existing.merges : []), { at, bootId: state.bootId }].slice(-20)
      incident.lastSummary = clip(summary || incident.summary || '', 400)
    } else {
      incident = {
        v: MONITOR_VERSION,
        id: await uniqueIncidentId(at, kind),
        kind,
        status: 'open',
        detectedAt: at,
        firstAt: Number(firstAt) || at,
        lastAt: at,
        recoveredAt: 0,
        summary: clip(summary || '', 400),
        severity,
        source: 'monitor',
        host: { name: hostTag, home: homeAbs, root: rootAbs },
        bootId: state.bootId,
        timeline,
        evidence,
        impact: simplifyImpact(impact),
        recommendation: recommendation || null,
        recovery: { status: 'none', restoredAt: 0, quarantine: null, report: null },
      }
    }
    await enqueueWrite(() => writeJsonAtomic(path.join(incidentDir, `${incident.id}.json`), incident))
    await enqueueWrite(() => writeOutbox(incident))
    await enqueueWrite(() => writeAlertsCurrent())
    state.recentCache = null
    log(`incident ${incident.id} ${existing ? 'merged' : 'created'} kind=${kind} severity=${incident.severity}`)
    // 有 dsh-sync 时立即尝试把子机通知补发出去（失败只写 lastError，不影响事故记录）。
    if (typeof getSync === 'function') {
      void flushPeerOutbox().catch((error) => logError('peer outbox flush after incident failed', error))
    }
    return incident
  }

  function mergeEvidence(previous, next) {
    const left = previous && typeof previous === 'object' ? previous : {}
    const right = next && typeof next === 'object' ? next : {}
    return {
      heartbeat: right.heartbeat || left.heartbeat || null,
      process: right.process || left.process || null,
      events: [...(Array.isArray(left.events) ? left.events : []), ...(Array.isArray(right.events) ? right.events : [])].slice(-50),
      data: right.data || left.data || null,
      backup: right.backup || left.backup || null,
    }
  }

  /** incident.impact：只保留面板需要的摘要（完整快照状态在 evidence/verify 结果里）。 */
  function simplifyImpact(impact) {
    if (!impact) return { local: { checked: 0, badCount: 0, bad: [] }, offsite: { checked: 0, badCount: 0, bad: [] } }
    const snapshots = Array.isArray(impact.snapshots) ? impact.snapshots : []
    const bad = snapshots.filter((item) => item.status !== 'ok')
    return {
      local: {
        checked: snapshots.length,
        badCount: bad.length,
        bad: bad.slice(0, 20).map((item) => ({ id: item.id, at: item.at, status: item.status, missingCount: item.missingCount || 0 })),
      },
      offsite: {
        checked: Number(impact.offsite && impact.offsite.checked) || 0,
        badCount: Number(impact.offsite && impact.offsite.badCount) || 0,
        bad: Array.isArray(impact.offsite && impact.offsite.bad) ? impact.offsite.bad.slice(0, 20) : [],
      },
    }
  }

  /* ------------------------------------------------------- 快照/异地体检 */

  function manifestList() {
    try {
      const list = Array.isArray(engine && engine.snapshots) ? engine.snapshots : []
      return list.filter((item) => item && typeof item === 'object' && item.id)
    } catch {
      return []
    }
  }

  /** 并发检查一组块哈希是否还在（只读；不信任 BlobStore.known 缓存，避免“缓存说还在”）。 */
  async function findMissingChunks(manifests) {
    const blobPathOf = (() => {
      const store = engine && engine.store
      if (store && typeof store.blobPath === 'function') {
        return (hash) => store.blobPath(hash)
      }
      return null
    })()
    if (!blobPathOf) return { available: false, referenced: 0, missing: new Set() }
    const hashes = new Set()
    for (const manifest of manifests) {
      const files = manifest && manifest.files && typeof manifest.files === 'object' ? manifest.files : {}
      for (const entry of Object.values(files)) {
        for (const hash of entryChunks(entry)) hashes.add(hash)
      }
    }
    const list = [...hashes]
    const missing = new Set()
    let cursor = 0
    const worker = async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= list.length) return
        const hash = list[index]
        let abs = null
        try { abs = blobPathOf(hash) } catch { abs = null }
        if (!abs) { missing.add(hash); continue }
        if (!(await exists(abs))) missing.add(hash)
      }
    }
    const workers = []
    const count = Math.min(32, list.length)
    for (let i = 0; i < count; i += 1) workers.push(worker())
    await Promise.all(workers)
    return { available: true, referenced: list.length, missing }
  }

  /** 本地快照只读体检；suspectFrom/suspectTo 标记事故窗口内的快照。 */
  async function checkSnapshots({ suspectFrom = 0, suspectTo = 0 } = {}) {
    const manifests = manifestList()
    const check = await findMissingChunks(manifests)
    const snapshots = []
    for (const manifest of manifests) {
      const files = manifest.files && typeof manifest.files === 'object' ? manifest.files : {}
      let missingCount = 0
      if (check.available) {
        for (const entry of Object.values(files)) {
          if (entryChunks(entry).some((hash) => check.missing.has(hash))) { missingCount += 1; break }
        }
      }
      const at = Number(manifest.at) || 0
      let status = 'ok'
      if (!check.available) status = 'unknown'
      else if (missingCount > 0) status = 'missing-blobs'
      else if (suspectFrom && at >= suspectFrom && at <= suspectTo) status = 'suspect'
      snapshots.push({
        id: String(manifest.id || ''),
        at,
        reason: String(manifest.reason || ''),
        files: Object.keys(files).length,
        status,
        missingCount,
        verified: check.available ? missingCount === 0 : null,
      })
    }
    snapshots.sort((a, b) => (b.at || 0) - (a.at || 0))

    // 清单不可读（在 engine.snapshots 里看不到但磁盘上有 .json）→ corrupt
    if (engine && engine.store && typeof engine.store.snapDir === 'string') {
      let names = []
      try { names = await fsp.readdir(engine.store.snapDir) } catch { names = [] }
      const known = new Set(manifests.map((item) => String(item.id)))
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const id = name.slice(0, -5)
        if (!INCIDENT_ID_PATTERN.test(id) || known.has(id)) continue
        const raw = await readJsonSafe(path.join(engine.store.snapDir, name), null)
        if (!raw || typeof raw !== 'object') {
          snapshots.push({ id, at: 0, reason: '', files: 0, status: 'corrupt', missingCount: 0, verified: false })
        }
      }
    }
    return {
      available: check.available,
      checked: snapshots.length,
      bad: snapshots.filter((item) => item.status !== 'ok' && item.status !== 'unknown'),
      snapshots,
      referenced: check.referenced,
    }
  }

  /**
   * 异地副本文件级检查（不要求解锁、不发 RPC）：
   * ledger 里的 manifest、packs 索引里的 pack 文件是否还在本地仓库目录。
   */
  async function checkOffsiteFiles() {
    let service = null
    try { service = typeof getOffsite === 'function' ? getOffsite() : null } catch { service = null }
    if (!service || typeof service !== 'object') {
      return { available: false, checked: 0, badCount: 0, bad: [], note: 'offsite-unavailable' }
    }
    let pathsInfo = null
    try { pathsInfo = service.paths || null } catch { pathsInfo = null }
    if (!pathsInfo || typeof pathsInfo.repo !== 'string') {
      return { available: false, checked: 0, badCount: 0, bad: [], note: 'offsite-not-initialized' }
    }
    const repoDir = path.resolve(pathsInfo.repo)
    let ledger = null
    try { ledger = service.ledger || null } catch { ledger = null }
    const archives = ledger && Array.isArray(ledger.archives) ? ledger.archives : []
    const files = new Map()
    for (const archive of archives.slice(-200)) {
      const name = archive && typeof archive.manifestName === 'string' ? archive.manifestName : ''
      if (!name || files.has(name)) continue
      files.set(name, 'manifest')
    }
    const packs = await readJsonSafe(String(pathsInfo.packs || ''), null)
    if (packs && packs.packs && typeof packs.packs === 'object') {
      for (const name of Object.keys(packs.packs)) {
        if (!files.has(name)) files.set(name, 'pack')
      }
    }
    const bad = []
    let checked = 0
    for (const [name, kind] of files) {
      checked += 1
      const abs = path.resolve(repoDir, ...String(name).split('/'))
      if (!abs.startsWith(repoDir + path.sep)) { bad.push({ name, kind, reason: 'path-escape' }); continue }
      if (!(await exists(abs))) bad.push({ name, kind, reason: 'file-missing' })
    }
    return {
      available: true,
      repoDir,
      checked,
      badCount: bad.length,
      bad: bad.slice(0, 50),
      note: 'file-level-only',
    }
  }

  async function impactAt({ referenceAt = 0, detectAt = now() } = {}) {
    const local = await checkSnapshots({ suspectFrom: referenceAt ? referenceAt - 5 * 60_000 : 0, suspectTo: detectAt })
    const offsite = await checkOffsiteFiles()
    return {
      snapshots: local.snapshots,
      local: { available: local.available, checked: local.checked, badCount: local.bad.length, bad: local.bad.slice(0, 50) },
      offsite,
      checkedAt: now(),
    }
  }

  /** 推荐恢复点：事故窗口前最后一份“块齐全”的快照；优先 status=ok，退而求其次取 suspect。 */
  function pickRecommendation(snapshots, referenceAt, reasonText) {
    const list = (Array.isArray(snapshots) ? snapshots : [])
      .filter((item) => item && item.id && Number(item.at) > 0)
      .filter((item) => item.reason !== 'pre-restore')
      .sort((a, b) => (b.at || 0) - (a.at || 0))
    const usable = list.filter((item) => item.verified === true || item.status === 'ok' || item.status === 'suspect')
    if (!usable.length) return null
    // 崩溃前最后一份“块齐全”的快照优先（suspect = 事故窗口内但块齐全，仍可恢复，
    // 比它更早的 ok 快照数据更旧，所以不因为 suspect 标记而跳过它）。
    const beforeRef = usable.filter((item) => item.at <= referenceAt)
    const chosen = beforeRef[0] || usable[0]
    if (!chosen) return null
    return {
      snapshotId: chosen.id,
      at: chosen.at,
      reason: String(reasonText || '事故前最后一份已验证快照'),
      verified: chosen.verified === true || chosen.status === 'ok',
      status: chosen.status,
    }
  }

  /* ------------------------------------------------------------- 检测 */

  function recentRestore() {
    try {
      const last = engine && engine.lastRestore
      return Boolean(last && now() - (Number(last.at) || 0) < cfg.runtimeDetectAfterRestoreMs)
    } catch {
      return false
    }
  }

  function engineBusy() {
    try { return Boolean(engine && engine.busy) } catch { return false }
  }

  /** 数据骤降判定（阈值见文档 §3：>max(50,5%)、sessions 减少、profiles/storages/credentials 消失）。 */
  function evaluateDataLoss(beforeRaw, afterRaw) {
    const before = normalizeStats(beforeRaw)
    const after = normalizeStats(afterRaw)
    const reasons = []
    let severity = 'medium'
    if (before.files != null && after.files != null && before.files > 0) {
      const drop = before.files - after.files
      const threshold = Math.max(cfg.dataLossMinFiles, Math.ceil(before.files * cfg.dataLossRatio))
      if (drop > threshold) {
        reasons.push({ type: 'files', before: before.files, after: after.files, drop, threshold })
        severity = 'high'
      }
    }
    if (before.sessions != null && after.sessions != null && after.sessions < before.sessions) {
      reasons.push({ type: 'sessions', before: before.sessions, after: after.sessions, drop: before.sessions - after.sessions })
      severity = 'high'
    }
    for (const key of ['profiles', 'storages']) {
      if (before[key] != null && after[key] != null && before[key] > 0 && after[key] === 0) {
        reasons.push({ type: key, before: before[key], after: after[key], drop: before[key] })
        severity = 'high'
      }
    }
    if (before.credentials === true && after.credentials === false) {
      reasons.push({ type: 'credentials', before: true, after: false })
      severity = 'high'
    }
    // 关键文件消失（workspace/profile；credentials 上面已覆盖）：DSH 变“全新客户端”的强信号
    for (const key of ['workspace', 'profile']) {
      if (before.keyFiles && before.keyFiles[key] === true && after.keyFiles && after.keyFiles[key] === false) {
        reasons.push({ type: `key-file:${key}`, before: true, after: false })
        severity = 'high'
      }
    }
    if (!reasons.length) return null
    const delta = {}
    for (const key of ['files', 'bytes', 'sessions', 'storages', 'profiles', 'attachments']) {
      if (before[key] != null && after[key] != null) delta[key] = after[key] - before[key]
    }
    return { reasons, severity, before, after, delta }
  }

  function crashTimeline(prev, lastSeen, detectAt, gapMs) {
    const timeline = [
      {
        at: lastSeen,
        type: 'last-heartbeat',
        detail: `最后一次心跳 ${new Date(lastSeen).toISOString()}（bootId=${prev && prev.bootId ? String(prev.bootId).slice(0, 36) : '?'}）`,
      },
      {
        at: detectAt,
        type: 'restart',
        detail: `进程重新启动：pid=${process.pid}，bootId=${state.bootId}，间隔 ${Math.round(gapMs / 1000)}s`,
      },
    ]
    return timeline
  }

  async function raiseCrash(prev, { detectAt, gapMs }) {
    const lastSeen = Number(prev.lastSeen) || 0
    const referenceAt = lastSeen
    const impact = await impactAt({ referenceAt, detectAt })
    const recommendation = pickRecommendation(impact.snapshots, referenceAt, '崩溃前最后一份已验证快照')
    const summary = `DSH 于 ${new Date(lastSeen).toLocaleString('zh-CN')} 异常退出（未写 cleanExit），`
      + `${Math.round(gapMs / 1000)} 秒后于 ${new Date(detectAt).toLocaleString('zh-CN')} 重新启动`
    const timeline = crashTimeline(prev, lastSeen, detectAt, gapMs)
    const evidence = {
      heartbeat: {
        lastSeen,
        gapMs,
        bootId: prev.bootId || null,
        cleanExit: prev.cleanExit === true,
        cleanExitAt: Number(prev.cleanExitAt) || 0,
        window: { from: lastSeen, to: lastSeen + Math.min(5000, Math.max(1000, gapMs)) },
      },
      process: { pid: process.pid, startedAt: state.startedAt, alive: true },
      events: [],
      data: {
        before: normalizeStats(prev.stats),
        after: { ...state.stats },
        delta: null,
      },
      backup: {
        local: { checked: impact.local.checked, bad: impact.local.bad.map((item) => item.id).slice(0, 50) },
        offsite: { checked: impact.offsite.checked, bad: impact.offsite.bad.map((item) => item.name).slice(0, 50) },
      },
    }
    return recordIncident({
      kind: 'crash',
      severity: 'high',
      detectedAt: detectAt,
      firstAt: lastSeen,
      summary,
      timeline,
      evidence,
      impact,
      recommendation,
    })
  }

  async function raiseDataLoss({
    before, after, loss, referenceAt, detectAt, runtime = false, commandLines = null, trigger = null,
  }) {
    const impact = await impactAt({ referenceAt, detectAt })
    const recommendation = pickRecommendation(impact.snapshots, referenceAt, '数据骤降前最后一份已验证快照')
    const parts = loss.reasons.map((reason) => {
      if (reason.type === 'files') return `文件数 ${reason.before} → ${reason.after}（阈值 ${reason.threshold}）`
      if (reason.type === 'sessions') return `会话数 ${reason.before} → ${reason.after}`
      if (reason.type === 'sessions-drop') return `会话数 ${reason.before} → ${reason.after}（秒级）`
      if (reason.type === 'sessions-empty') return `会话目录清空（${reason.before} → 0）`
      if (reason.type === 'credentials') return '.credentials.yaml 消失'
      if (reason.type === 'key-file:workspace') return 'storages/workspace.json 消失'
      if (reason.type === 'key-file:profile') return 'profiles/desktop/package.json 消失'
      return `${reason.type} ${reason.before} → ${reason.after}`
    })
    const summary = `检测到 DSH 数据骤降${runtime ? '（运行期）' : ''}：${parts.join('；')}`
    const timeline = [
      {
        at: referenceAt,
        type: 'data-baseline',
        detail: `上一次健康统计：files=${loss.before.files} sessions=${loss.before.sessions} `
          + `storages=${loss.before.storages} profiles=${loss.before.profiles}`,
      },
      {
        at: detectAt,
        type: runtime ? 'data-drop-detected' : 'data-drop',
        detail: parts.join('；'),
      },
      {
        at: detectAt,
        type: 'restart',
        detail: `当前进程 pid=${process.pid}，bootId=${state.bootId}${trigger ? `，触发=${trigger}` : ''}`,
      },
    ]
    const processInfo = { pid: process.pid, startedAt: state.startedAt, alive: true }
    if (Array.isArray(commandLines) && commandLines.length) processInfo.commandLines = commandLines
    const evidence = {
      heartbeat: {
        lastSeen: Number(referenceAt) || 0,
        gapMs: Math.max(0, detectAt - (Number(referenceAt) || detectAt)),
        bootId: null,
        cleanExit: null,
      },
      process: processInfo,
      events: [],
      data: { before: loss.before, after: loss.after, delta: loss.delta },
      keyFiles: {
        before: (loss.before && loss.before.keyFiles) || null,
        after: (loss.after && loss.after.keyFiles) || null,
      },
      trigger: trigger || (runtime ? 'runtime' : 'startup'),
      backup: {
        local: { checked: impact.local.checked, bad: impact.local.bad.map((item) => item.id).slice(0, 50) },
        offsite: { checked: impact.offsite.checked, bad: impact.offsite.bad.map((item) => item.name).slice(0, 50) },
      },
    }
    const incident = await recordIncident({
      kind: 'data-loss',
      severity: loss.severity,
      detectedAt: detectAt,
      firstAt: referenceAt,
      summary,
      timeline,
      evidence,
      impact,
      recommendation,
    })
    // A) 事故保护：自动暂停自动快照 + pin 推荐恢复点
    return protectIncident(incident, recommendation)
  }

  /* ------------------------------------------- A) 事故保护（pause + pin） */

  const PROTECTED_KINDS = new Set(['data-loss', 'backup-corrupt', 'mass-change'])

  function isProtectedKind(kind) {
    return PROTECTED_KINDS.has(String(kind || ''))
  }

  /**
   * 事故保护：data-loss / backup-corrupt / mass-change 时
   *   - `engine.setPaused(true)`（记录此前 paused 值，ack/恢复后还原）；
   *   - `engine.pinSnapshot(recommendation.snapshotId)`（prune 不会删推荐恢复点）。
   * 幂等：合并事故时不会重复 pause/pin，也不会覆盖用户手动改过的 paused。
   */
  async function protectIncident(incident, recommendation = null) {
    if (!incident || !INCIDENT_ID_PATTERN.test(String(incident.id || ''))) return incident
    if (!isProtectedKind(incident.kind)) return incident
    if (cfg.autoProtect === false) return incident
    const protection = incident.protection && typeof incident.protection === 'object' ? { ...incident.protection } : null
    let pausedBefore = protection && protection.pausedBefore !== undefined ? protection.pausedBefore : null
    if (pausedBefore === null) {
      try {
        pausedBefore = Boolean(engine && (engine.paused === true || (engine.state && engine.state().paused === true)))
      } catch { pausedBefore = null }
    }
    let pausedApplied = Boolean(protection && protection.pausedApplied)
    if (pausedBefore === false && !pausedApplied && cfg.autoProtect !== false
      && engine && typeof engine.setPaused === 'function' && engine.paused !== true) {
      try {
        engine.setPaused(true)
        pausedApplied = true
        log(`auto-paused backups for ${incident.kind} incident ${incident.id}`)
      } catch (error) {
        logError('auto pause failed', error)
      }
    }
    let pinnedSnapshot = protection && protection.pinnedSnapshot ? String(protection.pinnedSnapshot) : null
    const target = recommendation && recommendation.snapshotId ? String(recommendation.snapshotId) : null
    if (!pinnedSnapshot && target && engine && typeof engine.pinSnapshot === 'function') {
      try {
        engine.pinSnapshot(target)
        pinnedSnapshot = target
        log(`pinned recovery snapshot ${target} for incident ${incident.id}`)
      } catch (error) {
        logError('pin snapshot failed', error)
      }
    }
    const nextProtection = {
      ...(protection || {}),
      pausedBefore,
      pausedApplied,
      pinnedSnapshot,
      autoPaused: pausedApplied,
      at: (protection && protection.at) || now(),
      updatedAt: now(),
    }
    const comparable = (value) => (value ? JSON.stringify({ ...value, updatedAt: undefined }) : null)
    if (protection && comparable(protection) === comparable(nextProtection)) return incident
    incident.protection = nextProtection
    await enqueueWrite(() => writeJsonAtomic(path.join(incidentDir, `${incident.id}.json`), incident))
    await enqueueWrite(() => writeAlertsCurrent())
    state.recentCache = null
    state.stateCache = null
    return incident
  }

  /**
   * 解除保护：ack 或恢复成功后调用。只还原「事故前是运行态（pausedBefore=false）」的自动暂停；
   * 用户原本就暂停的保持暂停。pin 保留（保护刚恢复的恢复点不被 prune），仅记录释放时间。
   */
  async function releaseProtection(incident, reason) {
    if (!incident || !incident.protection) return incident
    const protection = { ...incident.protection }
    const incidents = await listIncidents({ limit: 200, useCache: false })
    const stillAutoPaused = incidents.some((item) => (
      item && String(item.id) !== String(incident.id) && item.status === 'open'
      && item.protection && item.protection.pausedBefore === false
    ))
    if (protection.pausedBefore === false && !stillAutoPaused && engine && typeof engine.setPaused === 'function' && engine.paused === true) {
      try {
        engine.setPaused(false)
        log(`resumed backups after ${reason || 'ack'} released protection for incident ${incident.id}`)
      } catch (error) {
        logError('auto resume failed', error)
      }
    }
    protection.pausedApplied = false
    protection.autoPaused = false
    protection.releasedAt = now()
    protection.releasedReason = String(reason || 'ack')
    incident.protection = protection
    await enqueueWrite(() => writeJsonAtomic(path.join(incidentDir, `${incident.id}.json`), incident))
    await enqueueWrite(() => writeAlertsCurrent())
    state.recentCache = null
    state.stateCache = null
    return incident
  }

  /**
   * 重启后恢复保护状态：仍 open 的保护类事故 → 重新 pin 推荐快照；
   * 若事故前是运行态且当时自动暂停过，重启后继续保持暂停（避免新快照覆盖现场）。
   */
  async function applyPersistedProtection() {
    let incidents = []
    try { incidents = await listIncidents({ limit: 200, useCache: false }) } catch { incidents = [] }
    const open = incidents.filter((incident) => (
      incident && incident.status === 'open' && incident.protection && isProtectedKind(incident.kind)
    ))
    if (!open.length) return 0
    let autoPause = false
    for (const incident of open) {
      const pinned = incident.protection.pinnedSnapshot
      if (pinned && engine && typeof engine.pinSnapshot === 'function') {
        try { engine.pinSnapshot(String(pinned)) } catch (error) { logError('re-pin failed', error) }
      }
      if (incident.protection.pausedBefore === false) autoPause = true
    }
    if (autoPause && engine && typeof engine.setPaused === 'function' && engine.paused !== true) {
      try {
        engine.setPaused(true)
        log(`re-applied incident protection pause (${open.length} open incident(s))`)
      } catch (error) {
        logError('re-apply pause failed', error)
      }
    }
    state.stateCache = null
    return open.length
  }

  /* --------------------------------- B) 秒级“变全新客户端”检测（5s 轻量） */

  /** 每 5s：sessions 目录数 + 3 个关键文件存在性（不遍历整棵树）。 */
  async function refreshKeyStats() {
    const beforeStats = {
      ...state.stats,
      keyFiles: { ...(state.stats.keyFiles || {}) },
    }
    let sessions = null
    let keyFiles = null
    try { sessions = await countSessions(path.join(homeAbs, 'sessions')) } catch { sessions = null }
    try { keyFiles = await checkKeyFiles() } catch { keyFiles = null }
    const current = { sessions, keyFiles, at: now() }
    const previous = state.keyStats
    state.keyStats = current
    if (sessions != null) state.stats.sessions = sessions
    if (keyFiles) {
      state.stats.keyFiles = { ...keyFiles }
      state.stats.credentials = keyFiles.credentials
    }
    return { previous, current, beforeStats }
  }

  /** 相对上一轮（5s 前）：sessions 骤降 ≥N / 清空 / 关键文件消失 → 立即 data-loss。 */
  async function checkKeyLoss(previous, current, beforeStats) {
    if (!previous || !current || state.stopping) return null
    if (now() - state.startedAt < cfg.keyCheckGraceMs) return null
    if (engineBusy() || recentRestore()) return null
    const prevSessions = previous.sessions
    const curSessions = current.sessions
    const prevKeyFiles = previous.keyFiles || {}
    const curKeyFiles = current.keyFiles || {}
    const reasons = []
    if (prevSessions != null && curSessions != null) {
      if (prevSessions > 0 && curSessions === 0) {
        reasons.push({ type: 'sessions-empty', before: prevSessions, after: 0, drop: prevSessions })
      } else if (prevSessions - curSessions >= Math.max(1, Number(cfg.keyCheckSessionsDrop) || 5)) {
        reasons.push({
          type: 'sessions-drop', before: prevSessions, after: curSessions, drop: prevSessions - curSessions,
        })
      }
    }
    for (const key of ['workspace', 'profile', 'credentials']) {
      if (prevKeyFiles[key] === true && curKeyFiles[key] === false) {
        reasons.push({ type: key === 'credentials' ? 'credentials' : `key-file:${key}`, before: true, after: false })
      }
    }
    if (!reasons.length) return null
    const commandLines = await captureCommandLines()
    const after = {
      ...beforeStats,
      sessions: curSessions == null ? beforeStats.sessions : curSessions,
      keyFiles: { ...curKeyFiles },
      credentials: curKeyFiles.credentials === true,
    }
    const loss = {
      reasons,
      severity: 'high',
      before: beforeStats,
      after,
      delta: {},
    }
    return raiseDataLoss({
      before: beforeStats,
      after,
      loss,
      referenceAt: Number(previous.at) || now() - Math.max(1000, Number(cfg.intervalMs) || 5000),
      detectAt: now(),
      runtime: true,
      commandLines,
      trigger: 'key-check',
    })
  }

  /** 抓一次进程命令行快照（只写本地 incident evidence，不入通知正文）。 */
  async function captureCommandLines() {
    if (cfg.captureCommandLines === false) return null
    if (process.platform !== 'win32') return null
    const script = '$ErrorActionPreference="SilentlyContinue"; '
      + 'Get-CimInstance Win32_Process | Where-Object { $_.Name -match "DeepSeek Harness|node" } '
      + '| Select-Object -First 20 ProcessId,Name,CommandLine | ConvertTo-Json -Compress'
    const result = await runCaptureProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 8000)
    if (!result || !result.stdout) return null
    try {
      const parsed = JSON.parse(result.stdout.trim())
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      return rows
        .map((row) => ({
          pid: Number(row && row.ProcessId) || 0,
          name: clip((row && row.Name) || '', 120),
          commandLine: clip((row && row.CommandLine) || '', 600),
        }))
        .filter((row) => row.pid || row.name)
        .slice(0, 20)
    } catch {
      return null
    }
  }

  function runCaptureProcess(command, args, timeoutMs) {
    return new Promise((resolve) => {
      let child = null
      let settled = false
      const stdout = []
      const stderr = []
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const timer = setTimeout(() => {
        try { if (child && typeof child.kill === 'function') child.kill() } catch { /* ignore */ }
        finish(null)
      }, Math.max(1000, Number(timeoutMs) || 8000))
      if (timer.unref) timer.unref()
      try {
        child = spawnProcess(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch {
        clearTimeout(timer)
        return finish(null)
      }
      if (!child) { clearTimeout(timer); return finish(null) }
      child.on('error', () => { clearTimeout(timer); finish(null) })
      if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
      if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
      child.on('close', (code) => {
        clearTimeout(timer)
        finish({ code, stdout: stdout.join(''), stderr: stderr.join('') })
      })
      return null
    })
  }

  /* ------------------------------------- C) 覆写/大量变更检测（新快照） */

  function currentManifest() {
    try {
      if (engine && engine.lastManifest && engine.lastManifest.id) return engine.lastManifest
      const list = manifestList()
      return list[0] || null
    } catch {
      return null
    }
  }

  async function readManifestPair(previousId, newestId) {
    const memory = manifestList()
    let newest = memory.find((item) => String(item.id) === String(newestId)) || null
    let previous = memory.find((item) => String(item.id) === String(previousId)) || null
    const store = engine && engine.store
    if (store && typeof store.readManifest === 'function') {
      try { newest = await store.readManifest(newestId) } catch { /* fallback memory */ }
      try { previous = await store.readManifest(previousId) } catch { /* fallback memory */ }
    }
    if (!newest || !previous) return null
    return { newest, previous }
  }

  function entrySignature(entry) {
    if (!entry) return ''
    return `${Number(entry.s) || 0}|${Number(entry.m) || 0}|${entryChunks(entry).join(',')}`
  }

  /** 统计最近两份 manifest 的 created/changed/deleted（只记路径样例，不含内容）。 */
  function diffManifests(previous, newest) {
    const before = (previous && previous.files) || {}
    const after = (newest && newest.files) || {}
    let created = 0
    let changed = 0
    let deleted = 0
    const samples = []
    const pushSample = (rel, kind) => {
      if (samples.length < 20) samples.push({ rel: clip(rel, 300), kind })
    }
    for (const rel of Object.keys(after)) {
      const left = before[rel]
      const right = after[rel]
      if (!left) { created += 1; pushSample(rel, 'created'); continue }
      if (entrySignature(left) !== entrySignature(right)) { changed += 1; pushSample(rel, 'changed') }
    }
    for (const rel of Object.keys(before)) {
      if (!after[rel]) { deleted += 1; pushSample(rel, 'deleted') }
    }
    return {
      created,
      changed,
      deleted,
      // 阈值按需求只看「覆写/删除」：changed + deleted；created（新增文件）不算破坏
      impact: changed + deleted,
      total: created + changed + deleted,
      samples,
      previousFiles: Object.keys(before).length,
      newestFiles: Object.keys(after).length,
    }
  }

  async function raiseMassChange({ diff, previous, newest, detectAt }) {
    const referenceAt = Number(previous.at) || Math.max(0, Number(newest.at) - 1)
    const impact = await impactAt({ referenceAt, detectAt })
    const recommendation = pickRecommendation(impact.snapshots, referenceAt, '大量变更前最后一份已验证快照')
    const threshold = diff.threshold
    const summary = `检测到大量文件变更/覆写：新增 ${diff.created}、修改 ${diff.changed}、删除 ${diff.deleted}`
      + `（变更+删除 ${diff.impact}，阈值 ${threshold}）`
    const timeline = [
      {
        at: referenceAt,
        type: 'previous-snapshot',
        detail: `上一份已处理快照 ${previous.id}（${previous.reason || 'auto'}，${diff.previousFiles} 个文件）`,
      },
      {
        at: Number(newest.at) || detectAt,
        type: 'new-snapshot',
        detail: `新快照 ${newest.id}（${newest.reason || 'auto'}，${diff.newestFiles} 个文件）`,
      },
      {
        at: detectAt,
        type: 'mass-change',
        detail: `changed=${diff.changed} created=${diff.created} deleted=${diff.deleted} threshold=${threshold}`,
      },
    ]
    const commandLines = await captureCommandLines()
    const processInfo = { pid: process.pid, startedAt: state.startedAt, alive: true }
    if (Array.isArray(commandLines) && commandLines.length) processInfo.commandLines = commandLines
    const evidence = {
      heartbeat: {
        lastSeen: state.lastSeen,
        gapMs: Math.max(0, detectAt - (Number(previous.at) || detectAt)),
        bootId: state.bootId,
        cleanExit: null,
      },
      process: processInfo,
      events: [],
      data: {
        before: { files: diff.previousFiles, snapshot: String(previous.id || '') },
        after: { files: diff.newestFiles, snapshot: String(newest.id || '') },
        delta: {
          created: diff.created, changed: diff.changed, deleted: diff.deleted,
          impact: diff.impact, total: diff.total, threshold,
        },
      },
      files: {
        samples: diff.samples,
        created: diff.created,
        changed: diff.changed,
        deleted: diff.deleted,
        impact: diff.impact,
        total: diff.total,
        threshold,
      },
      trigger: 'mass-change',
      backup: {
        local: { checked: impact.local.checked, bad: impact.local.bad.map((item) => item.id).slice(0, 50) },
        offsite: { checked: impact.offsite.checked, bad: impact.offsite.bad.map((item) => item.name).slice(0, 50) },
      },
    }
    const incident = await recordIncident({
      kind: 'mass-change',
      severity: 'high',
      detectedAt: detectAt,
      firstAt: Number(newest.at) || detectAt,
      summary,
      timeline,
      evidence,
      impact,
      recommendation,
    })
    return protectIncident(incident, recommendation)
  }

  /**
   * 新快照出现时对比最近两份 manifest：changed+deleted > max(200, 15%) 才报 mass-change。
   * restore 后 5 分钟内、startup/pre-restore 快照跳过，避免把正常恢复/启动误报。
   */
  async function checkMassChange() {
    if (cfg.massChangeEnabled === false) return null
    if (state.massCheckBusy || state.stopping) return null
    const newest = currentManifest()
    if (!newest || !newest.id) return null
    if (!state.lastProcessedSnapshotId) {
      state.lastProcessedSnapshotId = String(newest.id)
      return null
    }
    if (state.lastProcessedSnapshotId === String(newest.id)) return null
    if (now() - state.startedAt < cfg.keyCheckGraceMs) return null
    if (engineBusy() || recentRestore()) {
      state.lastProcessedSnapshotId = String(newest.id)
      return null
    }
    const previousId = state.lastProcessedSnapshotId
    const skipReasons = new Set(['pre-restore', 'restore', 'import', 'startup'])
    if (skipReasons.has(String(newest.reason || ''))) {
      state.lastProcessedSnapshotId = String(newest.id)
      return null
    }
    state.massCheckBusy = true
    try {
      const pair = await readManifestPair(previousId, String(newest.id))
      state.lastProcessedSnapshotId = String(newest.id)
      if (!pair) return null
      const diff = diffManifests(pair.previous, pair.newest)
      const base = Math.max(diff.previousFiles, diff.newestFiles, 1)
      const threshold = Math.max(
        Number(cfg.massChangeMinFiles) || 200,
        Math.ceil(base * (Number(cfg.massChangeRatio) || 0.15)),
      )
      diff.threshold = threshold
      if (diff.impact <= threshold) return null
      return await raiseMassChange({ diff, previous: pair.previous, newest: pair.newest, detectAt: now() })
    } catch (error) {
      logError('mass-change check failed', error)
      return null
    } finally {
      state.massCheckBusy = false
    }
  }

  /** 启动时检测：上一份心跳是否干净退出 / 数据是否骤降。 */
  async function detectAtStartup(previous) {
    if (!previous || typeof previous !== 'object') return null
    const prev = previous
    const lastSeen = Number(prev.lastSeen) || 0
    if (!lastSeen) return null
    const detectAt = state.startedAt || now()
    const gapMs = Math.max(0, detectAt - lastSeen)
    const cleanExit = prev.cleanExit === true
    const crashed = !cleanExit && gapMs > cfg.crashGapMs

    let baseStats = normalizeStats(prev.stats)
    const hasPrevStats = ['files', 'sessions', 'storages', 'profiles'].some((key) => baseStats[key] != null)
    if (!hasPrevStats && state.baseline) {
      baseStats = normalizeStats(state.baseline.stats || state.baseline)
    }
    const loss = hasPrevStats || state.baseline ? evaluateDataLoss(baseStats, state.stats) : null

    let created = null
    if (crashed) created = await raiseCrash(prev, { detectAt, gapMs })
    if (loss) {
      const incident = await raiseDataLoss({
        before: loss.before,
        after: loss.after,
        loss,
        referenceAt: lastSeen,
        detectAt,
      })
      if (!created) created = incident
    }
    return created
  }

  /* -------------------------------------------------------------- 基线 */

  async function readBaseline() {
    const raw = await readJsonSafe(baselineFile, null)
    return raw && typeof raw === 'object' ? raw : null
  }

  async function writeBaseline() {
    const previous = await readBaseline()
    const stats = { ...state.stats }
    const next = {
      ...(previous && typeof previous === 'object' ? previous : {}),
      v: MONITOR_VERSION,
      at: now(),
      host: hostTag,
      home: homeAbs,
      source: 'monitor',
      // 与外部看门狗对齐：本文件的 stats 是“心跳口径”（同一进程内内存统计 + 秒级 keyFiles），
      // 不是 watchdog 的 scanHome 口径；watchdog 读 source:'monitor' 时按 heartbeat 处理。
      statsSource: 'heartbeat',
      stats,
    }
    await enqueueWrite(() => writeJsonAtomic(baselineFile, next))
    state.baseline = next
  }

  async function maybeUpdateBaseline() {
    const incidents = await listIncidents({ limit: 200, useCache: false })
    const blocking = incidents.some((incident) => (
      incident && incident.status === 'open' && (incident.kind === 'data-loss' || incident.kind === 'backup-corrupt')
    ))
    if (blocking) return false
    let lastError = null
    try { lastError = engine && engine.lastError } catch { lastError = null }
    if (lastError) return false
    const baseAt = Number(state.baseline && state.baseline.at) || 0
    if (baseAt && now() - baseAt < cfg.baselineIntervalMs) return false
    const meaningful = ['files', 'sessions', 'storages', 'profiles'].some((key) => state.stats[key] != null)
    if (!meaningful) return false
    await writeBaseline()
    return true
  }

  /* ---------------------------------------------------------- 统计刷新 */

  /** 刷新轻量统计；运行期还会对比上一次统计检测数据骤降（启动宽限期之后）。 */
  async function refreshStats({ detect = true } = {}) {
    let light = { sessions: 0, storages: 0, profiles: 0, attachments: 0, credentials: false }
    try { light = await computeLightStats() } catch (error) { logError('light stats failed', error) }
    const backup = computeBackupStats()
    const nextStats = { files: backup.files, bytes: backup.bytes, ...light }
    const previousStats = state.stats
    const previousAt = state.lastStatsAt
    const firstMeasure = state.lastStatsAt === 0
    state.stats = nextStats
    state.lastStatsAt = now()

    if (detect && !firstMeasure && !state.stopping && state.started) {
      const graceOver = now() - state.startedAt >= cfg.runtimeDetectGraceMs
      if (graceOver && !engineBusy() && !recentRestore()) {
        const loss = evaluateDataLoss(previousStats, nextStats)
        if (loss) {
          try {
            await raiseDataLoss({
              before: loss.before,
              after: loss.after,
              loss,
              referenceAt: previousAt || (now() - cfg.statsRefreshMs),
              detectAt: now(),
              runtime: true,
            })
            state.stateCache = null
          } catch (error) {
            logError('runtime data-loss incident failed', error)
          }
        }
      }
    }
  }

  /* ------------------------------------------------------------ 外部区 */

  function readExternalInfo() {
    if (state.externalCache && now() - state.externalCacheAt < 10_000) return state.externalCache
    const info = { watchdog: null, notify: null, external: null }
    try {
      const monitorExternal = path.join(externalRoot, 'monitor')
      const config = (() => {
        try {
          const raw = fs.readFileSync(path.join(monitorExternal, 'config.json'), 'utf8')
          return JSON.parse(raw)
        } catch { return null }
      })()
      const stateFile = path.join(monitorExternal, 'state.json')
      const externalState = (() => {
        try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return null }
      })()
      const storeState = (() => {
        try { return JSON.parse(fs.readFileSync(watchdogStateFile, 'utf8')) } catch { return null }
      })()
      const pickTime = (raw, keys) => {
        for (const key of keys) {
          const value = Number(raw && raw[key])
          if (Number.isFinite(value) && value > 0) return value
        }
        return 0
      }
      const externalWatchdog = Boolean(existsSync(path.join(monitorExternal, 'watchdog.mjs')))
      const lastCheckAt = Math.max(
        pickTime(externalState, ['lastCheckAt', 'at', 'lastRunAt', 'checkedAt']),
        pickTime(storeState, ['lastCheckAt', 'at', 'lastRunAt', 'checkedAt']),
      )
      const logAt = (() => {
        try { return fs.statSync(path.join(monitorExternal, 'watchdog.log')).mtimeMs } catch { return 0 }
      })()
      const installed = externalWatchdog
      let status = 'missing'
      if (installed) {
        if (!lastCheckAt) status = 'pending'
        else if (now() - lastCheckAt > 5 * 60_000) status = 'stale'
        else status = 'ok'
      }
      info.watchdog = {
        installed,
        status,
        taskName: WATCHDOG_TASK_NAME,
        dir: externalRoot,
        configFile: config ? path.join(monitorExternal, 'config.json') : null,
        stateFile: existsSync(stateFile) ? stateFile : (existsSync(watchdogStateFile) ? watchdogStateFile : null),
        lastCheckAt,
        lastRunAt: lastCheckAt,
        logAt,
        staleMs: lastCheckAt ? Math.max(0, now() - lastCheckAt) : null,
        pid: toNumberOrNull(externalState && (externalState.pid || (externalState.process && externalState.process.pid))),
      }
      info.notify = readNotifyConfig(config)
      info.external = {
        installed: existsSync(path.join(externalRoot, 'recovery-console.ps1'))
          || existsSync(path.join(externalRoot, 'scripts', 'recovery-console.ps1')),
        root: externalRoot,
        configFile: config ? path.join(monitorExternal, 'config.json') : null,
        recoveryConsole: existsSync(path.join(externalRoot, 'recovery-console.ps1'))
          || existsSync(path.join(externalRoot, 'scripts', 'recovery-console.ps1')),
        watchdog: installed,
      }
    } catch (error) {
      logError('external info failed', error)
      info.watchdog = { installed: false, status: 'unknown', taskName: WATCHDOG_TASK_NAME, dir: externalRoot, lastCheckAt: 0 }
      info.notify = readNotifyConfig(null)
      info.external = { installed: false, root: externalRoot }
    }
    state.externalCache = info
    state.externalCacheAt = now()
    return info
  }

  function existsSync(target) {
    try { return fs.existsSync(target) } catch { return false }
  }

  /* --------------------------------------------------- 通知配置（config.json + secrets.dpapi） */

  const NOTIFY_CHANNELS = ['panel', 'toast', 'webhook', 'email', 'qq', 'peer']

  function dpapiClient() {
    if (dpapi) return dpapi
    if (!state.dpapiClient) {
      state.dpapiClient = createDpapiClient({
        scriptPath: path.join(repoRoot, 'scripts', 'dpapi.ps1'),
        spawn: spawnProcess,
      })
    }
    return state.dpapiClient
  }

  /** 通用子进程捕获（stdin 可选）：test-notify / PowerShell 探测用。 */
  function runTool(command, args, { timeoutMs = 30_000, input = null } = {}) {
    return new Promise((resolve) => {
      let child = null
      let settled = false
      const stdout = []
      const stderr = []
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const timer = setTimeout(() => {
        try { if (child && typeof child.kill === 'function') child.kill() } catch { /* ignore */ }
        finish({ code: null, stdout: stdout.join(''), stderr: stderr.join(''), timeout: true, spawnError: null })
      }, Math.max(1000, Number(timeoutMs) || 30_000))
      if (timer.unref) timer.unref()
      try {
        child = spawnProcess(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (error) {
        clearTimeout(timer)
        return finish({ code: null, stdout: '', stderr: '', timeout: false, spawnError: error })
      }
      if (!child) {
        clearTimeout(timer)
        return finish({ code: null, stdout: '', stderr: '', timeout: false, spawnError: new Error('spawn failed') })
      }
      child.on('error', (error) => { clearTimeout(timer); finish({ code: null, stdout: stdout.join(''), stderr: stderr.join(''), timeout: false, spawnError: error }) })
      if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
      if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
      child.on('close', (code) => { clearTimeout(timer); finish({ code, stdout: stdout.join(''), stderr: stderr.join(''), timeout: false, spawnError: null }) })
      if (input != null && child.stdin && typeof child.stdin.write === 'function') {
        try { child.stdin.end(String(input)) } catch { /* ignore */ }
      } else if (child.stdin && typeof child.stdin.end === 'function') {
        try { child.stdin.end() } catch { /* ignore */ }
      }
      return null
    })
  }

  function parseLastJson(text) {
    const raw = String(text || '').trim()
    if (!raw) return null
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]
      if (!line.startsWith('{') || !line.endsWith('}')) continue
      try { return JSON.parse(line) } catch { /* continue */ }
    }
    try { return JSON.parse(raw) } catch { return null }
  }

  function normalizeHooks(raw) {
    const list = []
    const input = Array.isArray(raw) ? raw : []
    for (const item of input.slice(0, 10)) {
      if (!item || typeof item !== 'object') continue
      const name = clip(String(item.name || '').trim() || `webhook${list.length + 1}`, 40)
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        throw monitorError('bad-webhook-name', `Webhook 名称只能包含字母数字 . _ -：${name}`)
      }
      const url = String(item.url || '').trim()
      if (url) {
        let parsed = null
        try { parsed = new URL(url) } catch { parsed = null }
        if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
          throw monitorError('bad-webhook-url', `Webhook「${name}」URL 必须是 http(s) 地址`)
        }
      }
      list.push({
        name,
        url: clip(url, 500),
        enabled: item.enabled !== false,
        retries: Math.max(0, Math.min(10, Math.round(Number(item.retries) || 2))),
        timeoutMs: Math.max(1000, Math.min(60_000, Math.round(Number(item.timeoutMs) || 8000))),
        tokenSecret: clip(String(item.tokenSecret || name), 40),
      })
    }
    const seen = new Set()
    for (const hook of list) {
      if (seen.has(hook.name)) throw monitorError('bad-webhook-name', `Webhook 名称重复：${hook.name}`)
      seen.add(hook.name)
    }
    return list
  }

  /** 把 UI 提交的 notify 段规范化成 watchdog 的 config.notify 结构。 */
  function normalizeNotifyInput(input) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
    const emailRaw = source.email && typeof source.email === 'object' ? source.email : {}
    const qqRaw = source.qq && typeof source.qq === 'object' ? source.qq : {}
    const peerRaw = source.peer && typeof source.peer === 'object' ? source.peer : {}
    const port = Math.round(Number(emailRaw.port) || 587)
    if (port < 1 || port > 65535) throw monitorError('bad-email-port', 'SMTP 端口必须在 1–65535')
    const to = (Array.isArray(emailRaw.to) ? emailRaw.to : String(emailRaw.to || '').split(/[,，;；\s]+/))
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .slice(0, 20)
    const action = clip(String(qqRaw.action || 'send_private_msg').trim() || 'send_private_msg', 60)
    return {
      panel: source.panel !== false,
      toast: source.toast !== false,
      toastTimeoutMs: Math.max(2000, Math.min(120_000, Math.round(Number(source.toastTimeoutMs) || 20_000))),
      retries: Math.max(0, Math.min(10, Math.round(Number(source.retries) || 2))),
      outboxMaxAttempts: Math.max(1, Math.min(100, Math.round(Number(source.outboxMaxAttempts) || 12))),
      webhook: normalizeHooks(source.webhook),
      email: {
        enabled: emailRaw.enabled === true,
        host: clip(String(emailRaw.host || '').trim(), 200),
        port,
        useSsl: emailRaw.useSsl !== false,
        user: clip(String(emailRaw.user || '').trim(), 200),
        from: clip(String(emailRaw.from || '').trim(), 200),
        to,
      },
      qq: {
        enabled: qqRaw.enabled === true,
        http: clip(String(qqRaw.http || '').trim(), 300),
        action,
        target: clip(String(qqRaw.target || '').trim(), 120),
        token: '',
      },
      peer: { enabled: peerRaw.enabled === true },
    }
  }

  function normalizeSecretsInput(input) {
    const source = input && typeof input === 'object' ? input : {}
    const out = { any: false, smtp: null, qq: null, webhook: {} }
    if (typeof source.smtpPassword === 'string' && source.smtpPassword) {
      out.smtp = { password: clip(source.smtpPassword, 500) }
      out.any = true
    }
    if (typeof source.qqToken === 'string' && source.qqToken) {
      out.qq = { token: clip(source.qqToken, 500) }
      out.any = true
    }
    const hooks = source.webhookTokens && typeof source.webhookTokens === 'object' ? source.webhookTokens : {}
    for (const [name, token] of Object.entries(hooks)) {
      if (typeof token !== 'string' || !token) continue
      out.webhook[clip(name, 40)] = clip(token, 500)
      out.any = true
    }
    return out
  }

  function notifySafeState(rawNotify, secretPresence) {
    const notify = rawNotify && typeof rawNotify === 'object' ? rawNotify : {}
    const email = notify.email && typeof notify.email === 'object' ? notify.email : {}
    const qq = notify.qq && typeof notify.qq === 'object' ? notify.qq : {}
    const hooks = Array.isArray(notify.webhook) ? notify.webhook : []
    const tokens = (secretPresence && secretPresence.webhooks) || {}
    return {
      panel: notify.panel !== false,
      toast: notify.toast !== false,
      toastTimeoutMs: Number(notify.toastTimeoutMs) || 20_000,
      retries: Number(notify.retries) || 0,
      outboxMaxAttempts: Number(notify.outboxMaxAttempts) || 12,
      webhook: hooks.map((hook) => ({
        name: String(hook.name || 'webhook'),
        url: String(hook.url || ''),
        enabled: hook.enabled !== false,
        retries: Number(hook.retries) || 0,
        timeoutMs: Number(hook.timeoutMs) || 8000,
        tokenConfigured: Boolean(tokens[String(hook.name || '')]),
      })),
      email: {
        enabled: email.enabled === true,
        host: String(email.host || ''),
        port: Number(email.port) || 587,
        useSsl: email.useSsl !== false,
        user: String(email.user || ''),
        from: String(email.from || ''),
        to: Array.isArray(email.to) ? email.to.map(String) : [],
        passwordConfigured: Boolean(secretPresence && secretPresence.smtp),
      },
      qq: {
        enabled: qq.enabled === true,
        http: String(qq.http || ''),
        action: String(qq.action || 'send_private_msg'),
        target: String(qq.target || ''),
        tokenConfigured: Boolean(secretPresence && secretPresence.qq),
      },
      peer: { enabled: Boolean(notify.peer && notify.peer.enabled === true) },
    }
  }

  async function readNotifyConfigFile() {
    const raw = await readJsonSafe(notifyConfigFile, null)
    return { present: Boolean(raw && typeof raw === 'object'), raw: raw && typeof raw === 'object' ? raw : null }
  }

  /** 读取 secrets.dpapi 的存在性（不返回明文；解密失败只标记 error）。 */
  async function readNotifySecretPresence() {
    const presence = { present: false, smtp: false, qq: false, webhooks: {}, error: null }
    const text = await fsp.readFile(notifySecretsFile, 'utf8').catch(() => null)
    if (!text) return presence
    presence.present = true
    try {
      const data = await decryptNotifySecrets(text)
      presence.smtp = Boolean(data && data.smtp && data.smtp.password)
      presence.qq = Boolean(data && data.qq && data.qq.token)
      if (data && data.webhook && typeof data.webhook === 'object') {
        for (const [name, token] of Object.entries(data.webhook)) presence.webhooks[name] = Boolean(token)
      }
    } catch (error) {
      presence.error = 'decrypt-failed'
      logError('notify secrets decrypt failed', error)
    }
    return presence
  }

  async function decryptNotifySecrets(textRaw) {
    const text = String(textRaw || '').trim()
    if (!text) return {}
    let blob = text
    if (text.startsWith('{')) {
      const parsed = JSON.parse(text)
      blob = parsed.blob || parsed.data || parsed.ciphertext || parsed.dpapi || ''
    }
    if (!blob) return {}
    const client = dpapiClient()
    if (!client || !client.available) throw monitorError('dpapi-unavailable', 'DPAPI 不可用（仅 Windows 可用）')
    const plain = await client.unprotect(blob)
    if (!plain) return {}
    const data = JSON.parse(plain)
    return data && typeof data === 'object' ? data : {}
  }

  async function encryptNotifySecrets(data) {
    const client = dpapiClient()
    if (!client || !client.available) throw monitorError('dpapi-unavailable', 'DPAPI 不可用（仅 Windows 可用）')
    const blob = await client.protect(JSON.stringify(data))
    if (!blob) throw monitorError('dpapi-failed', 'DPAPI 加密返回空结果')
    return String(blob)
  }

  async function notifyState() {
    const { present, raw } = await readNotifyConfigFile()
    const config = raw && raw.notify && typeof raw.notify === 'object' ? raw.notify : {}
    const secrets = await readNotifySecretPresence()
    let watchdog = { path: watchdogScript, installed: false, testNotifySupported: false, version: null }
    try {
      const content = await fsp.readFile(watchdogScript, 'utf8')
      const match = content.match(/WATCHDOG_VERSION\s*=\s*['"]([^'"]+)['"]/)
      watchdog = {
        path: watchdogScript,
        installed: true,
        testNotifySupported: content.includes('test-notify'),
        version: match ? match[1] : null,
      }
    } catch { /* 外部目录未安装 */ }
    return {
      ok: true,
      present,
      configPath: notifyConfigFile,
      secretsPath: notifySecretsFile,
      config: notifySafeState(config, secrets),
      secrets: {
        present: secrets.present,
        smtp: secrets.smtp,
        qq: secrets.qq,
        webhooks: secrets.webhooks,
        error: secrets.error,
      },
      watchdog,
      channels: NOTIFY_CHANNELS,
    }
  }

  /**
   * 保存通知配置：非密写 `monitor/config.json` 的 notify 段（保留其它未知键），
   * 密文写 `monitor/secrets.dpapi`（DPAPI CurrentUser；空输入表示不修改）。
   */
  async function saveNotifyConfig({ config, secrets } = {}) {
    if (state.notifyBusy) throw monitorError('busy', '正在保存通知配置，请稍候')
    state.notifyBusy = true
    try {
      const notify = normalizeNotifyInput(config)
      const { raw } = await readNotifyConfigFile()
      const base = raw || {}
      const next = {
        ...base,
        v: Number(base.v) || 1,
        storeRoot: base.storeRoot || rootAbs,
        home: base.home || homeAbs,
        hostname: base.hostname || hostTag,
        installedAt: Number(base.installedAt) || now(),
        notify,
      }
      await fsp.mkdir(path.dirname(notifyConfigFile), { recursive: true })
      await writeJsonAtomic(notifyConfigFile, next)

      const incoming = normalizeSecretsInput(secrets)
      if (incoming.any) {
        let existing = {}
        try {
          const text = await fsp.readFile(notifySecretsFile, 'utf8')
          if (text) existing = await decryptNotifySecrets(text)
        } catch { existing = {} }
        const merged = {
          ...(existing && typeof existing === 'object' ? existing : {}),
          smtp: { ...(existing.smtp || {}), ...(incoming.smtp || {}) },
          qq: { ...(existing.qq || {}), ...(incoming.qq || {}) },
          webhook: { ...(existing.webhook || {}), ...incoming.webhook },
        }
        const blob = await encryptNotifySecrets(merged)
        await fsp.mkdir(path.dirname(notifySecretsFile), { recursive: true })
        await writeFileAtomic(notifySecretsFile, Buffer.from(`${blob}\n`, 'utf8'))
      }
      state.externalCache = null
      state.stateCache = null
      log(`notify config saved: webhook=${notify.webhook.length} email=${notify.email.enabled} qq=${notify.qq.enabled} peer=${notify.peer.enabled}`)
      return await notifyState()
    } finally {
      state.notifyBusy = false
    }
  }

  /** 面板「测试」按钮：调用外部 watchdog 的 `--test-notify <channel>`（契约 {ok,channel,result}）。 */
  async function testNotifyChannel(channelRaw) {
    const channel = String(channelRaw || '').trim().toLowerCase()
    if (!NOTIFY_CHANNELS.includes(channel)) {
      return { ok: false, channel: channel || null, result: { code: 'bad-channel', message: `未知通道：${channel}` } }
    }
    if (state.notifyTestBusy) return { ok: false, channel, result: { code: 'busy', message: '已有测试在进行，请稍候' } }
    state.notifyTestBusy = true
    const startedAt = now()
    try {
      if (!(await exists(watchdogScript).catch(() => false))) {
        return { ok: false, channel, result: { code: 'watchdog-missing', message: `外部看门狗未安装：${watchdogScript}` } }
      }
      let content = ''
      try { content = await fsp.readFile(watchdogScript, 'utf8') } catch { content = '' }
      if (!content.includes('test-notify')) {
        return {
          ok: false,
          channel,
          result: { code: 'test-notify-unavailable', message: '外部看门狗版本过旧，请用「安装/修复外部看门狗」同步后再测试' },
        }
      }
      const run = await runTool(process.execPath, [
        watchdogScript,
        '--test-notify', channel,
        '--config', notifyConfigFile,
        '--json',
      ], { timeoutMs: 60_000 })
      const report = parseLastJson(run.stdout)
      const durationMs = now() - startedAt
      if (run.spawnError) {
        return {
          ok: false, channel, durationMs,
          result: { code: 'spawn-failed', message: clip(run.spawnError.message || 'spawn failed', 200) },
        }
      }
      if (!report) {
        return {
          ok: false, channel, durationMs, exitCode: run.code,
          result: {
            code: run.timeout ? 'timeout' : 'bad-output',
            message: clip((run.stderr || run.stdout || '外部看门狗没有返回 JSON').slice(0, 300), 300),
          },
          stdout: clip(run.stdout, 2000),
        }
      }
      return {
        ok: report.ok === true,
        channel,
        durationMs,
        exitCode: run.code,
        result: report.result || { code: 'unknown' },
        report,
      }
    } finally {
      state.notifyTestBusy = false
    }
  }

  /* ------------------------------------------------ 备份根目录修改（profile cordis.patch.yml） */

  async function findPluginPatchFile() {
    const candidates = []
    const profilesDir = path.join(homeAbs, 'profiles')
    let entries = []
    try { entries = await fsp.readdir(profilesDir, { withFileTypes: true }) } catch { entries = [] }
    for (const entry of entries) {
      if (entry.isDirectory()) candidates.push(path.join(profilesDir, entry.name, 'cordis.patch.yml'))
    }
    candidates.push(path.join(homeAbs, 'cordis.patch.yml'))
    let fallback = null
    for (const file of candidates) {
      const content = await fsp.readFile(file, 'utf8').catch(() => null)
      if (content == null) continue
      if (content.includes('dsh-disaster-recovery')) return { file, content }
      if (!fallback) fallback = { file, content }
    }
    return fallback
  }

  function yamlQuote(value) {
    return `'${String(value).replace(/'/g, "''")}'`
  }

  /** 在 cordis.patch.yml 里写入/替换 disaster-recovery 条目的 config.root。 */
  function patchContentWithRoot(content, newRoot) {
    const eol = content.includes('\r\n') ? '\r\n' : '\n'
    const lines = String(content).split(/\r?\n/)
    const rootLine = (indent) => `${' '.repeat(indent)}root: ${yamlQuote(newRoot)}`
    const nameIdx = lines.findIndex((line) => /name:\s*['"]?dsh-disaster-recovery['"]?/.test(line))
    let entryIdx = -1
    if (nameIdx >= 0) {
      const nameIndent = (lines[nameIdx].match(/^(\s*)/) || ['', ''])[1].length
      for (let i = nameIdx; i >= 0; i -= 1) {
        const match = lines[i].match(/^(\s*)-\s+/)
        if (match && match[1].length < nameIndent) { entryIdx = i; break }
      }
    }
    if (entryIdx < 0) {
      const idIdx = lines.findIndex((line) => /^\s*-\s+id:\s*['"]?disaster-recovery['"]?\s*$/.test(line))
      if (idIdx >= 0) entryIdx = idIdx
    }
    if (entryIdx >= 0) {
      const entryIndent = ((lines[entryIdx].match(/^(\s*)/) || ['', ''])[1]).length
      let endIdx = lines.length
      for (let i = entryIdx + 1; i < lines.length; i += 1) {
        const match = lines[i].match(/^(\s*)-\s+/)
        if (match && match[1].length <= entryIndent) { endIdx = i; break }
      }
      let configIdx = -1
      for (let i = entryIdx; i < endIdx; i += 1) {
        if (/^\s*config:\s*$/.test(lines[i])) { configIdx = i; break }
      }
      if (configIdx >= 0) {
        const configIndent = ((lines[configIdx].match(/^(\s*)/) || ['', ''])[1]).length
        let rootIdx = -1
        for (let i = configIdx + 1; i < endIdx; i += 1) {
          if (/^\s*root\s*:/.test(lines[i])) { rootIdx = i; break }
        }
        if (rootIdx >= 0) {
          const indent = ((lines[rootIdx].match(/^(\s*)/) || ['', ''])[1]).length
          lines[rootIdx] = rootLine(indent)
          return { content: lines.join(eol), action: 'replace-root', line: rootIdx + 1 }
        }
        lines.splice(configIdx + 1, 0, rootLine(configIndent + 2))
        return { content: lines.join(eol), action: 'insert-root', line: configIdx + 2 }
      }
      // 没有 config: 段 → 在 name 行后插入
      const anchor = nameIdx >= 0 ? nameIdx : entryIdx
      const entryNameIndent = ((lines[anchor].match(/^(\s*)/) || ['', ''])[1]).length
      const inserted = [
        `${' '.repeat(entryIndent + 2)}config:`,
        rootLine(entryIndent + 4),
      ]
      lines.splice(anchor + 1, 0, ...inserted)
      return { content: lines.join(eol), action: 'insert-config', line: anchor + 2 }
    }
    // 完全没有我们的条目 → 追加一条（loader patch 用 id+name+config 覆盖）
    const block = [
      '- id: disaster-recovery',
      "  name: 'dsh-disaster-recovery'",
      '  config:',
      `    root: ${yamlQuote(newRoot)}`,
    ]
    let text = lines.join(eol)
    if (text.length && !text.endsWith(eol)) text += eol
    if (text.length) text += eol
    text += block.join(eol) + eol
    return { content: text, action: 'append-entry', line: null }
  }

  async function probeWritableDir(dir) {
    let stat = null
    try { stat = await fsp.stat(dir) } catch { stat = null }
    if (stat && !stat.isDirectory()) {
      return { ok: false, code: 'root-not-dir', message: '该路径已存在但不是目录' }
    }
    let probeDir = dir
    if (!stat) {
      let cursor = dir
      for (;;) {
        const parent = path.dirname(cursor)
        if (parent === cursor) break
        try {
          const parentStat = await fsp.stat(parent)
          if (parentStat.isDirectory()) { probeDir = parent; break }
        } catch { /* keep walking up */ }
        cursor = parent
      }
    }
    try {
      // probeDir 已经是“最近一个存在的祖先目录”（或 dir 本身）；只有它真的不存在时才创建。
      // 不能对已存在的盘符根（如 D:\）调用 mkdir(recursive) —— Windows 会返回 EPERM。
      let probeStat = null
      try { probeStat = await fsp.stat(probeDir) } catch { probeStat = null }
      if (!probeStat) await fsp.mkdir(probeDir, { recursive: true })
      const tmp = path.join(probeDir, `.dsh-dr-write-${process.pid}-${Date.now().toString(36)}.tmp`)
      await fsp.writeFile(tmp, 'probe')
      await fsp.rm(tmp, { force: true })
      return { ok: true, probeDir }
    } catch (error) {
      return { ok: false, code: 'root-not-writable', message: `目录不可写：${String((error && error.message) || error)}` }
    }
  }

  async function validateBackupRoot(rootRaw) {
    const input = String(rootRaw == null ? '' : rootRaw).trim()
    if (!input) throw monitorError('bad-root', '请填写备份根目录')
    if (!path.isAbsolute(input)) throw monitorError('root-relative', '必须是绝对路径（例如 D:\\dsh-backup）')
    const resolved = path.resolve(input)
    const rel = path.relative(homeAbs, resolved)
    const insideHome = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
    if (insideHome) throw monitorError('root-inside-home', '备份根目录不能放在 DSH 数据目录（DSH_HOME）里面')
    if (resolved.toLowerCase() === rootAbs.toLowerCase()) {
      throw monitorError('root-same', '新路径与当前备份根目录相同')
    }
    const patch = await findPluginPatchFile()
    if (!patch) throw monitorError('patch-missing', '找不到 profile 的 cordis.patch.yml，无法修改备份根目录')
    const probe = await probeWritableDir(resolved)
    if (!probe.ok) throw monitorError(probe.code, probe.message)
    const warnings = []
    const parent = path.dirname(resolved)
    if (!(await exists(parent).catch(() => false))) warnings.push('parent-missing')
    return {
      root: resolved,
      previousRoot: rootAbs,
      patchFile: patch.file,
      patchContent: patch.content,
      warnings,
    }
  }

  /** 预览 root 修改（只校验，不写任何文件；dry-run 会在最近已存在的父目录做一次写探测）。 */
  async function previewBackupRoot(rootRaw) {
    const valid = await validateBackupRoot(rootRaw)
    return {
      ok: true,
      preview: true,
      root: valid.root,
      previousRoot: valid.previousRoot,
      patchFile: valid.patchFile,
      warnings: valid.warnings,
      needRestart: true,
      requiresDshRestart: true,
      note: '需要重启 DSH 生效；旧备份不会自动迁移，保留在原目录。',
    }
  }

  /** 应用 root 修改：备份 profile cordis.patch.yml → 原子改写 root → 读回校验，失败回滚。 */
  async function applyBackupRoot(rootRaw) {
    if (state.rootBusy) throw monitorError('busy', '正在修改备份根目录，请稍候')
    state.rootBusy = true
    try {
      const valid = await validateBackupRoot(rootRaw)
      await fsp.mkdir(valid.root, { recursive: true })
      const probe = await probeWritableDir(valid.root)
      if (!probe.ok) throw monitorError(probe.code, probe.message)
      const patched = patchContentWithRoot(valid.patchContent, valid.root)
      if (patched.content === valid.patchContent) throw monitorError('patch-noop', 'cordis.patch.yml 内容没有变化')
      await fsp.mkdir(notifyBackupDir, { recursive: true })
      const stamp = makeSnapshotId(new Date(now()), 'root')
      const backupPath = path.join(notifyBackupDir, `cordis.patch.yml.${stamp}.bak`)
      await fsp.copyFile(valid.patchFile, backupPath)
      try {
        await writeFileAtomic(valid.patchFile, Buffer.from(patched.content, 'utf8'))
        const verify = await fsp.readFile(valid.patchFile, 'utf8')
        if (!verify.includes(yamlQuote(valid.root)) && !verify.includes(valid.root)) {
          throw monitorError('patch-verify-failed', '写入后读回校验失败')
        }
      } catch (error) {
        // 失败回滚：把备份内容写回
        try {
          const original = await fsp.readFile(backupPath)
          await writeFileAtomic(valid.patchFile, original)
        } catch { /* ignore */ }
        throw monitorError(
          (error && error.code) || 'patch-write-failed',
          `写入 cordis.patch.yml 失败：${String((error && error.message) || error)}`,
        )
      }
      noteAction('root-set')
      // 如果外部监控配置指向旧 root，一起改成新 root，避免重启后看门狗继续读旧目录误报。
      let configUpdated = false
      try {
        const existing = await readJsonSafe(notifyConfigFile, null)
        if (existing && typeof existing === 'object' && existing.storeRoot) {
          const currentStore = path.resolve(String(existing.storeRoot))
          if (currentStore.toLowerCase() === valid.previousRoot.toLowerCase()) {
            await writeJsonAtomic(notifyConfigFile, { ...existing, storeRoot: valid.root })
            configUpdated = true
          }
        }
      } catch (error) {
        logError('root-set external config update failed', error)
      }
      state.stateCache = null
      log(`backup root updated: ${valid.previousRoot} -> ${valid.root} (patch=${valid.patchFile}, backup=${backupPath}, externalConfig=${configUpdated})`)
      return {
        ok: true,
        root: valid.root,
        previousRoot: valid.previousRoot,
        patchFile: valid.patchFile,
        patchAction: patched.action,
        backupPath,
        configUpdated,
        needRestart: true,
        requiresDshRestart: true,
        note: '需要重启 DSH 生效；旧备份不会自动迁移，保留在原目录。',
      }
    } finally {
      state.rootBusy = false
    }
  }

  /** 通知通道配置状态（tolerant：不同看门狗版本的键名都认，但不回显任何 secret）。 */
  function readNotifyConfig(config) {
    const channels = [
      { id: 'panel', label: 'panel', configured: true },
    ]
    const source = config && typeof config === 'object' ? config : null
    const notify = source && typeof source.notify === 'object' && source.notify ? source.notify
      : (source && typeof source.notifications === 'object' && source.notifications ? source.notifications : null)
    const pick = (raw) => {
      if (raw == null) return null
      if (typeof raw === 'boolean') return raw
      if (Array.isArray(raw)) return raw.length > 0
      if (typeof raw === 'object') {
        if (raw.enabled === false) return false
        if (raw.enabled === true) return true
        for (const key of ['urls', 'url', 'to', 'recipients', 'targets']) {
          if (Array.isArray(raw[key])) return raw[key].length > 0
          if (typeof raw[key] === 'string') return raw[key].trim().length > 0
        }
        return Object.keys(raw).length > 0
      }
      if (typeof raw === 'string') return raw.trim().length > 0
      return null
    }
    const bool = (raw) => (typeof raw === 'boolean' ? raw : null)
    channels.push({ id: 'toast', label: 'toast', configured: source ? (bool(notify && notify.toast) ?? bool(source.toast) ?? pick(notify && notify.windowsToast)) : null })
    channels.push({ id: 'webhook', label: 'webhook', configured: source ? pick((notify && (notify.webhook || notify.webhooks)) ?? source.webhook ?? source.webhooks) : null })
    channels.push({ id: 'email', label: 'email', configured: source ? pick((notify && (notify.email || notify.smtp)) ?? source.email ?? source.smtp) : null })
    channels.push({ id: 'qq', label: 'qq', configured: source ? pick((notify && (notify.qq || notify.onebot)) ?? source.qq ?? source.onebot) : null })
    channels.push({ id: 'peer', label: 'peer', configured: source ? pick((notify && notify.peer) ?? source.peer) : null })
    const rawPeer = notify && notify.peer !== undefined ? notify.peer : (source && source.peer !== undefined ? source.peer : null)
    const peerEnabled = rawPeer == null
      ? null
      : (typeof rawPeer === 'boolean' ? rawPeer : !(rawPeer && rawPeer.enabled === false))
    const rawMaxAttempts = Number(notify && notify.outboxMaxAttempts)
    const outboxMaxAttempts = Number.isFinite(rawMaxAttempts) && rawMaxAttempts > 0
      ? Math.min(100, Math.round(rawMaxAttempts))
      : DEFAULT_OUTBOX_MAX_ATTEMPTS
    return {
      source: source ? 'external' : 'none',
      configured: Boolean(source),
      channels,
      peerEnabled,
      outboxMaxAttempts,
      configFile: source ? path.join(externalRoot, 'monitor', 'config.json') : null,
    }
  }

  /* -------------------------------------------------------------- 状态 */

  /* -------------------------------------------------------------- 状态 */

  function currentEnginePaused() {
    try {
      if (!engine) return false
      if (typeof engine.paused === 'boolean') return engine.paused
      const snapshot = typeof engine.state === 'function' ? engine.state() : null
      return Boolean(snapshot && snapshot.paused)
    } catch {
      return false
    }
  }

  /** 事故保护聚合摘要（面板显示「已自动暂停备份、已钉住恢复点」）。 */
  function protectionSummary(entries) {
    const list = (Array.isArray(entries) ? entries : []).filter((entry) => entry && entry.protection)
    const pinnedSnapshots = [...new Set(list.map((entry) => entry.protection.pinnedSnapshot).filter(Boolean))]
    const autoPaused = list.some((entry) => (
      entry.protection.pausedBefore === false && entry.protection.autoPaused !== false && !entry.protection.releasedAt
    ))
    return {
      active: list.length > 0,
      autoPaused,
      paused: currentEnginePaused(),
      pausedBefore: list.length ? list[0].protection.pausedBefore : null,
      pinnedSnapshots,
      incidents: list.map((entry) => entry.id),
      note: autoPaused ? 'incident-protection' : (list.length ? 'pinned-only' : null),
    }
  }

  async function buildState() {
    const external = readExternalInfo()
    const alerts = await readAlerts({ maxAgeMs: 2_000 })
    const acked = await readAckMap()
    const openEntries = (alerts && Array.isArray(alerts.open) ? alerts.open : [])
      .filter((entry) => entry && entry.status === 'open' && !acked[String(entry.id)])
    let recent = []
    try {
      const incidents = await listIncidents({ limit: 20, useCache: true })
      recent = incidents
        .filter((incident) => incident.status && incident.status !== 'open')
        .slice(0, RECENT_INCIDENT_LIMIT)
        .map(summaryEntry)
    } catch { recent = [] }
    let outboxPending = 0
    try {
      const names = await fsp.readdir(outboxDir)
      outboxPending = names.filter((name) => name.endsWith('.json')).length
    } catch { outboxPending = 0 }
    const ageMs = state.lastSeen ? now() - state.lastSeen : null
    const clientAgeMs = state.clientLastSeen ? now() - state.clientLastSeen : null
    const last = alerts && alerts.last && typeof alerts.last === 'object' ? alerts.last : (recent[0] || null)
    return {
      ok: true,
      v: MONITOR_VERSION,
      running: state.started && !state.stopping,
      bootId: state.bootId,
      pid: process.pid,
      startedAt: state.startedAt,
      heartbeat: {
        at: state.lastSeen,
        ageMs,
        bootId: state.bootId,
        pid: process.pid,
        startedAt: state.startedAt,
        cleanExit: false,
        version: pluginVersion,
        clientLastSeen: state.clientLastSeen,
        clientAgeMs,
        clientStale: clientAgeMs != null ? clientAgeMs > cfg.clientPingStaleMs : null,
      },
      stats: { ...state.stats },
      backup: backupInfo(),
      offsite: offsiteInfo(),
      baseline: state.baseline
        ? { at: Number(state.baseline.at) || 0, stats: normalizeStats(state.baseline.stats || state.baseline), source: state.baseline.source || 'monitor' }
        : null,
      incidents: {
        open: openEntries,
        recent,
        last: last && typeof last === 'object' ? last : null,
        openCount: openEntries.length,
      },
      recommendation: (openEntries[0] && openEntries[0].recommendation) || (last && last.recommendation) || null,
      protection: protectionSummary(openEntries),
      verify: state.lastVerify,
      watchdog: external.watchdog,
      notify: external.notify,
      external: external.external,
      outbox: { pending: outboxPending },
      peerOutbox: {
        op: PEER_NOTIFY_OP,
        lastRunAt: state.peerLastRunAt || 0,
        lastError: state.peerLastError || null,
        lastResult: state.peerLastResult || null,
        enabled: (() => {
          try {
            const notify = readExternalInfo().notify || {}
            return cfg.peerNotify !== false && notify.peerEnabled !== false
          } catch { return cfg.peerNotify !== false }
        })(),
      },
      config: {
        intervalMs: cfg.intervalMs,
        statsRefreshMs: cfg.statsRefreshMs,
        crashGapMs: cfg.crashGapMs,
        mergeWindowMs: cfg.mergeWindowMs,
        dataLossMinFiles: cfg.dataLossMinFiles,
        dataLossRatio: cfg.dataLossRatio,
        retentionDays: cfg.retentionDays,
      },
      error: state.startError,
      monitorDir,
      heartbeatFile,
    }
  }

  async function stateSnapshot({ fresh = false } = {}) {
    if (!fresh && state.stateCache && now() - state.stateCacheAt < 2_000) return state.stateCache
    if (state.statePromise) {
      if (!fresh) return state.statePromise
      try { await state.statePromise } catch { /* ignore */ }
    }
    const promise = buildState()
      .then((value) => {
        state.stateCache = value
        state.stateCacheAt = now()
        return value
      })
      .catch((error) => {
        logError('state build failed', error)
        const fallback = quickSummary()
        state.stateCache = fallback
        state.stateCacheAt = now()
        return fallback
      })
      .finally(() => { state.statePromise = null })
    state.statePromise = promise
    return promise
  }

  /** 同步摘要（面板每条响应都能带着；由心跳周期刷新成完整版）。 */
  function quickSummary() {
    const acked = state.ackCache || {}
    const open = (state.alertsCache && Array.isArray(state.alertsCache.open) ? state.alertsCache.open : [])
      .filter((entry) => entry && entry.status === 'open' && !acked[String(entry.id)])
    const external = state.externalCache || { watchdog: null, notify: null, external: null }
    return {
      ok: true,
      v: MONITOR_VERSION,
      running: state.started && !state.stopping,
      bootId: state.bootId,
      pid: process.pid,
      startedAt: state.startedAt,
      heartbeat: {
        at: state.lastSeen,
        ageMs: state.lastSeen ? now() - state.lastSeen : null,
        bootId: state.bootId,
        pid: process.pid,
        startedAt: state.startedAt,
        cleanExit: false,
        version: pluginVersion,
        clientLastSeen: state.clientLastSeen,
        clientAgeMs: state.clientLastSeen ? now() - state.clientLastSeen : null,
        clientStale: state.clientLastSeen ? now() - state.clientLastSeen > cfg.clientPingStaleMs : null,
      },
      stats: { ...state.stats },
      backup: backupInfo(),
      offsite: offsiteInfo(),
      baseline: state.baseline
        ? { at: Number(state.baseline.at) || 0, stats: normalizeStats(state.baseline.stats || state.baseline), source: state.baseline.source || 'monitor' }
        : null,
      incidents: {
        open,
        openCount: open.length,
        recent: [],
        last: (state.alertsCache && state.alertsCache.last) || null,
      },
      recommendation: (open[0] && open[0].recommendation) || null,
      protection: protectionSummary(open),
      verify: state.lastVerify,
      watchdog: external.watchdog || { installed: false, status: 'unknown', taskName: WATCHDOG_TASK_NAME },
      notify: external.notify || readNotifyConfig(null),
      external: external.external || { installed: false, root: externalRoot },
      outbox: { pending: 0 },
      peerOutbox: {
        op: PEER_NOTIFY_OP,
        lastRunAt: state.peerLastRunAt || 0,
        lastError: state.peerLastError || null,
        lastResult: state.peerLastResult || null,
        enabled: cfg.peerNotify !== false,
      },
      config: { ...cfg },
      error: state.startError,
      monitorDir,
      heartbeatFile,
    }
  }

  function summary() {
    return state.stateCache || quickSummary()
  }

  /* -------------------------------------------------------- 面板动作 */

  function ping() {
    state.clientLastSeen = now()
    return { ok: true, at: state.clientLastSeen, pid: process.pid, bootId: state.bootId }
  }

  function noteAction(type) {
    state.lastAction = { type: String(type || 'action'), at: now() }
  }

  /**
   * 忽略/已读一条事故：写 alerts/ack.json（与外部看门狗共用），
   * 自己写的事故同时把 incident 状态改成 acknowledged。
   */
  async function ack(id) {
    const value = String(id || '')
    if (!INCIDENT_ID_PATTERN.test(value)) throw monitorError('bad-id', '缺少或非法的事故 id')
    const at = now()
    let incident = null
    try {
      incident = await readIncident(value)
    } catch {
      incident = null
    }
    if (incident && incident.source === 'monitor') {
      incident.status = 'acknowledged'
      incident.acknowledgedAt = at
      incident.timeline = [...(Array.isArray(incident.timeline) ? incident.timeline : []), {
        at, type: 'acknowledged', detail: '用户在面板里忽略了这条事故',
      }].slice(-60)
      if (incident.protection) {
        // A) ack 后还原用户原先的 paused 状态（pin 保留，保护恢复点不被 prune）
        await releaseProtection(incident, 'ack')
      } else {
        await enqueueWrite(() => writeJsonAtomic(path.join(incidentDir, `${value}.json`), incident))
      }
    }
    const previous = await readJsonSafe(alertsAckFile, null)
    const acked = previous && previous.acked && typeof previous.acked === 'object' ? { ...previous.acked } : {}
    acked[value] = at
    await enqueueWrite(() => writeJsonAtomic(alertsAckFile, { v: MONITOR_VERSION, acked }))
    await enqueueWrite(() => writeAlertsCurrent())
    state.stateCache = null
    state.recentCache = null
    noteAction('ack')
    return { id: value, status: incident && incident.source === 'monitor' ? 'acknowledged' : 'ack-recorded', at }
  }

  /** 完整只读体检：本地全部快照 missing-blob + 异地文件级检查（不需要解锁）。 */
  async function verifyImpact() {
    const startedAt = now()
    let local
    try {
      local = await checkSnapshots({})
    } catch (error) {
      logError('verify local failed', error)
      local = { available: false, checked: 0, bad: [], snapshots: [], referenced: 0 }
    }
    let offsite
    try {
      offsite = await checkOffsiteFiles()
    } catch (error) {
      logError('verify offsite failed', error)
      offsite = { available: false, checked: 0, badCount: 0, bad: [], note: 'error' }
    }
    const result = {
      at: startedAt,
      durationMs: now() - startedAt,
      ok: local.bad.length === 0 && (offsite.badCount || 0) === 0,
      local: {
        available: Boolean(local.available),
        checked: local.checked,
        badCount: local.bad.length,
        bad: local.bad.slice(0, 20),
        snapshots: local.snapshots.slice(0, SNAPSHOT_LIMIT).map((item) => ({
          id: item.id, at: item.at, status: item.status, missingCount: item.missingCount,
        })),
      },
      offsite: {
        available: Boolean(offsite.available),
        checked: Number(offsite.checked) || 0,
        badCount: Number(offsite.badCount) || 0,
        bad: Array.isArray(offsite.bad) ? offsite.bad.slice(0, 20) : [],
        note: offsite.note || null,
      },
    }
    state.lastVerify = result
    await enqueueWrite(() => writeJsonAtomic(verifyFile, result)).catch(() => {})
    state.stateCache = null
    noteAction('verify')
    return result
  }

  /** 恢复联动：默认用事故 recommendation，先确认事故 open / 快照存在，再走 engine.restore。 */
  async function restoreFromIncident({ snapshotId, incidentId } = {}) {
    if (!engine || typeof engine.restore !== 'function') throw monitorError('not-ready', '备份引擎尚未启动')
    if (engineBusy()) throw monitorError('busy', '正在备份/恢复，稍后再试')
    let incident = null
    if (incidentId) {
      incident = await readIncident(String(incidentId))
      if (incident.status !== 'open') {
        throw monitorError('incident-not-open', `事故 ${incident.id} 已处理（${incident.status}）`)
      }
    } else {
      const alerts = await readAlerts({ maxAgeMs: 0 })
      const open = (alerts && Array.isArray(alerts.open) ? alerts.open : [])
        .filter((entry) => entry && entry.status === 'open')
      if (open.length) {
        try { incident = await readIncident(open[0].id) } catch { incident = null }
      }
    }
    const recommended = incident && incident.recommendation && incident.recommendation.snapshotId
    const target = String(snapshotId || recommended || '')
    if (!target) {
      throw monitorError('no-recommendation', '没有可用的推荐恢复点（请先跑一次体检或手动选择快照）')
    }
    const manifests = manifestList()
    const known = manifests.some((item) => String(item.id) === target)
    if (!known) throw monitorError('snapshot-missing', `快照不存在：${target}`)
    noteAction('restore')
    const result = await engine.restore(target)
    const recoveredAt = now()
    if (incident) {
      const latest = await readIncident(incident.id).catch(() => incident)
      latest.status = 'recovered'
      latest.recoveredAt = recoveredAt
      latest.recovery = {
        status: 'restored',
        restoredAt: recoveredAt,
        quarantine: result && result.quarantineDir ? result.quarantineDir : null,
        report: {
          snapshot: target,
          restored: Number(result && result.restored) || 0,
          unchanged: Number(result && result.unchanged) || 0,
          quarantined: Number(result && result.quarantined) || 0,
          extraLeft: Number(result && result.extraLeft) || 0,
          failed: Array.isArray(result && result.failed) ? result.failed.length : 0,
          preSnapshot: (result && result.preSnapshot) || null,
        },
      }
      latest.timeline = [...(Array.isArray(latest.timeline) ? latest.timeline : []), {
        at: recoveredAt,
        type: 'recovered',
        detail: `已从快照 ${target} 恢复（restored=${latest.recovery.report.restored}，需重启 DSH）`,
      }].slice(-60)
      if (latest.protection) {
        // A) 恢复成功 → 还原用户原先的 paused 状态（pin 保留，保护刚恢复的恢复点）
        await releaseProtection(latest, 'recovered')
      } else {
        await enqueueWrite(() => writeJsonAtomic(path.join(incidentDir, `${latest.id}.json`), latest))
      }
    }
    await enqueueWrite(() => writeAlertsCurrent())
    state.stateCache = null
    state.recentCache = null
    // 恢复后重新统计一次（restore 已把文件写回，next stats 用新清单）
    await refreshStats({ detect: false }).catch(() => {})
    return {
      result,
      needRestart: true,
      snapshot: target,
      incident: incident ? await readIncident(incident.id).catch(() => null) : null,
    }
  }

  /* ------------------------------------------------------ 外部看门狗安装 */

  function parseLastJson(text) {
    const raw = String(text || '').trim()
    if (!raw) return null
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]
      if (!line.startsWith('{') || !line.endsWith('}')) continue
      try { return JSON.parse(line) } catch { /* continue */ }
    }
    try { return JSON.parse(raw) } catch { return null }
  }

  function runInstaller({ apply }) {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installerFile]
    if (apply) args.push('-Apply')
    args.push('-Quiet')
    const candidates = [installerFile]
    void candidates
    return new Promise((resolve) => {
      let child = null
      let settled = false
      const stdout = []
      const stderr = []
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const timer = setTimeout(() => {
        try { if (child && typeof child.kill === 'function') child.kill() } catch { /* ignore */ }
        finish({ code: null, stdout: stdout.join(''), stderr: stderr.join(''), timeout: true, spawnError: null })
      }, cfg.installTimeoutMs)
      if (timer.unref) timer.unref()
      const commands = ['pwsh', 'powershell.exe']
      const attempt = (index) => {
        if (index >= commands.length) {
          clearTimeout(timer)
          return finish({ code: null, stdout: stdout.join(''), stderr: stderr.join(''), timeout: false, spawnError: new Error('pwsh/powershell 都不可用') })
        }
        const command = commands[index]
        let next = null
        try {
          next = spawnProcess(command, args, { cwd: repoRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (error) {
          return attempt(index + 1)
        }
        child = next
        let spawned = false
        next.on('error', (error) => {
          if (!spawned && error && error.code === 'ENOENT') {
            if (typeof next.kill === 'function') { try { next.kill() } catch { /* ignore */ } }
            return attempt(index + 1)
          }
          clearTimeout(timer)
          finish({
            code: null, stdout: stdout.join(''), stderr: stderr.join(''), timeout: false,
            spawnError: error || new Error('spawn failed'),
          })
        })
        if (next.stdout && typeof next.stdout.on === 'function') next.stdout.on('data', (chunk) => stdout.push(String(chunk)))
        if (next.stderr && typeof next.stderr.on === 'function') next.stderr.on('data', (chunk) => stderr.push(String(chunk)))
        next.on('spawn', () => { spawned = true })
        next.on('close', (code) => {
          clearTimeout(timer)
          finish({ code, stdout: stdout.join(''), stderr: stderr.join(''), timeout: false, spawnError: null })
        })
        return null
      }
      attempt(0)
    })
  }

  /**
   * 安装/修复外部看门狗：调用 scripts/install-external.ps1 -Apply -Quiet（看门狗队友提供）。
   * 脚本不存在/执行失败都返回 `{ok:false,error:{code,message}}`，不抛异常。
   */
  async function installExternal({ apply = true } = {}) {
    if (state.installBusy) throw monitorError('busy', '正在安装外部看门狗，请稍候')
    state.installBusy = true
    const startedAt = now()
    try {
      const scriptExists = await exists(installerFile).catch(() => false)
      if (!scriptExists) {
        return {
          ok: false,
          apply: Boolean(apply),
          script: installerFile,
          error: { code: 'installer-missing', message: `安装脚本不存在：${installerFile}` },
        }
      }
      const run = await runInstaller({ apply: Boolean(apply) })
      const parsed = parseLastJson(run.stdout)
      const failure = run.spawnError
        ? { code: 'installer-failed', message: clip(run.spawnError.message || 'spawn failed', 300) }
        : (run.timeout
          ? { code: 'installer-timeout', message: `安装脚本超时（>${Math.round(cfg.installTimeoutMs / 1000)}s）` }
          : (run.code !== 0
            ? { code: 'installer-failed', message: clip((run.stderr || run.stdout || `退出码 ${run.code}`), 300) }
            : (parsed && parsed.ok === false
              ? {
                code: 'install-failed',
                message: clip(
                  (Array.isArray(parsed.warnings) && parsed.warnings.length ? parsed.warnings.join('；') : '安装脚本返回 ok=false'),
                  300,
                ),
              }
              : null)))
      const result = {
        ok: !failure,
        apply: Boolean(apply),
        script: installerFile,
        exitCode: run.code,
        durationMs: now() - startedAt,
        recoveryHome: parsed && parsed.recoveryHome ? String(parsed.recoveryHome) : externalRoot,
        task: parsed && parsed.task ? parsed.task : WATCHDOG_TASK_NAME,
        mode: parsed && parsed.mode ? String(parsed.mode) : null,
        copied: parsed && parsed.copied ? Number(parsed.copied) || 0 : null,
        shortcuts: parsed && Array.isArray(parsed.shortcuts) ? parsed.shortcuts : [],
        backup: parsed && parsed.backup ? parsed.backup : null,
        warnings: parsed && Array.isArray(parsed.warnings) ? parsed.warnings.map((item) => String(item).slice(0, 300)) : [],
        output: clip(run.stdout, 4000),
        errorOutput: clip(run.stderr, 2000),
        parsed,
      }
      if (failure) result.error = failure
      state.installResult = result
      state.externalCache = null
      noteAction('install-external')
      log(`install external: ok=${result.ok}${failure ? ` code=${failure.code}` : ''}`)
      return result
    } finally {
      state.installBusy = false
    }
  }

  /* -------------------------------------------------------- 生命周期 */

  async function cleanupOld() {
    const cutoff = now() - cfg.retentionDays * 86400_000
    for (const dir of [incidentDir, outboxDir]) {
      let names = []
      try { names = await fsp.readdir(dir) } catch { continue }
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const abs = path.join(dir, name)
        try {
          const stat = await fsp.stat(abs)
          if (stat.mtimeMs < cutoff) await fsp.rm(abs, { force: true })
        } catch { /* ignore */ }
      }
    }
  }

  async function tick() {
    if (state.stopping || !state.started) return null
    state.lastSeen = now()
    try {
      await enqueueWrite(() => writeHeartbeat())
      await appendHeartbeatLog()
      // B) 秒级“变全新客户端”检查：只 readdir sessions + stat 3 个关键文件。
      try {
        const keyResult = await refreshKeyStats()
        await checkKeyLoss(keyResult.previous, keyResult.current, keyResult.beforeStats)
      } catch (error) {
        logError('key-check failed', error)
      }
      // C) 覆写/大量变更：只在最新快照 id 变化时读两份 manifest。
      try {
        await checkMassChange()
      } catch (error) {
        logError('mass-change check failed', error)
      }
      await stateSnapshot().catch(() => {})
    } catch (error) {
      logError('heartbeat tick failed', error)
    }
    return null
  }

  async function start() {
    if (state.started && !state.stopping) return summary()
    state.started = true
    state.stopping = false
    state.startedAt = state.startedAt || now()
    state.lastSeen = now()
    state.bootId = randomUUID()
    try {
      await ensureDirs()
    } catch (error) {
      state.startError = `monitor dir: ${String((error && error.message) || error)}`
      logError('ensure dirs failed', error)
    }
    let previous = null
    try { previous = await readJsonSafe(heartbeatFile, null) } catch { previous = null }
    state.previousHeartbeat = previous
    state.baseline = await readBaseline().catch(() => null)
    state.lastVerify = await readJsonSafe(verifyFile, null).catch(() => null)
    try {
      await refreshStats({ detect: false })
    } catch (error) {
      logError('initial stats failed', error)
    }
    // 秒级检查的起点：先抓一轮 key stats（5s 后才开始对比）。
    try {
      await refreshKeyStats()
    } catch (error) {
      logError('initial key stats failed', error)
    }
    const initialManifest = currentManifest()
    state.lastProcessedSnapshotId = initialManifest ? String(initialManifest.id) : null
    if (state.baseline && !state.stats.files && state.baseline.stats && Number(state.baseline.stats.files) >= 0) {
      // 没有清单时（备份禁用/尚无快照）用基线里的文件数兜底，只用于展示/对比
      state.stats.files = toNumberOrNull(state.baseline.stats.files)
      state.stats.bytes = toNumberOrNull(state.baseline.stats.bytes)
    }
    try {
      await detectAtStartup(previous)
    } catch (error) {
      logError('startup detection failed', error)
    }
    try {
      await applyPersistedProtection()
    } catch (error) {
      logError('re-apply protection failed', error)
    }
    try {
      await maybeUpdateBaseline()
    } catch (error) {
      logError('baseline update failed', error)
    }
    try {
      await enqueueWrite(() => writeHeartbeat())
      state.lastLogAt = 0
      await appendHeartbeatLog()
      // 启动时就把 alerts/current.json 建出来（哪怕没有事故），
      // 外部看门狗/面板不必处理“文件不存在”。
      await enqueueWrite(() => writeAlertsCurrent())
    } catch (error) {
      logError('initial heartbeat failed', error)
    }
    try {
      await cleanupOld()
    } catch (error) {
      logError('cleanup failed', error)
    }
    if (!state.timers.heartbeat) {
      state.timers.heartbeat = setInterval(() => { void tick() }, Math.max(1000, Number(cfg.intervalMs) || 5000))
      if (state.timers.heartbeat.unref) state.timers.heartbeat.unref()
    }
    if (!state.timers.stats) {
      state.timers.stats = setInterval(() => {
        refreshStats({ detect: true })
          .then(() => maybeUpdateBaseline())
          .catch((error) => logError('stats refresh failed', error))
      }, Math.max(10_000, Number(cfg.statsRefreshMs) || 60_000))
      if (state.timers.stats.unref) state.timers.stats.unref()
    }
    // 子机通知补发：有 dsh-sync 注入时启动后立即跑一次 + 每 60s 一次（失败只记日志）。
    if (typeof getSync === 'function') {
      if (!state.timers.peer) {
        state.timers.peer = setInterval(() => {
          void flushPeerOutbox().catch((error) => logError('peer outbox flush failed', error))
        }, Math.max(10_000, Number(cfg.peerFlushIntervalMs) || PEER_FLUSH_INTERVAL_MS))
        if (state.timers.peer.unref) state.timers.peer.unref()
      }
      void flushPeerOutbox().catch((error) => logError('peer outbox flush failed', error))
    }
    await stateSnapshot({ fresh: true }).catch(() => {})
    log(`started boot=${state.bootId} monitor=${monitorDir} snapshots=${backupInfo().snapshots}`)
    return summary()
  }

  /**
   * 正常退出：先同步写 cleanExit（进程可能马上退出），再按写链补写一次纠正竞态。
   * 只记日志，绝不抛异常。
   */
  function stop() {
    if (!state.started && !state.stopping) {
      return Promise.resolve()
    }
    state.stopping = true
    state.started = false
    if (state.timers.heartbeat) { clearInterval(state.timers.heartbeat); state.timers.heartbeat = null }
    if (state.timers.stats) { clearInterval(state.timers.stats); state.timers.stats = null }
    if (state.timers.peer) { clearInterval(state.timers.peer); state.timers.peer = null }
    state.lastSeen = now()
    writeHeartbeatSync({ final: true })
    const done = enqueueWrite(() => {
      state.lastSeen = now()
      writeHeartbeatSync({ final: true })
    }).catch((error) => logError('final heartbeat failed', error))
    state.stoppingDone = done
    return done
  }

  async function flush() {
    state.lastSeen = now()
    await enqueueWrite(() => writeHeartbeat()).catch((error) => logError('flush heartbeat failed', error))
    await state.writeChain.catch(() => {})
    return summary()
  }

  const api = {
    /* 生命周期 */
    start,
    stop,
    dispose: stop,
    flush,
    tick,
    refreshStats,
    /* 状态 */
    state: stateSnapshot,
    summary,
    /* 动作 */
    ping,
    ack,
    verifyImpact,
    installExternal,
    restoreFromIncident,
    /* 子机通知补发（DSH 启动后自动跑；测试/面板也可手动触发） */
    flushPeerOutbox,
    /* 通知配置 / 备份根目录（面板设置用） */
    notifyState,
    saveNotifyConfig,
    testNotifyChannel,
    previewBackupRoot,
    applyBackupRoot,
    /* 只读内部视图（测试/调试） */
    get paths() {
      return {
        root: rootAbs,
        hostDir,
        monitorDir,
        incidentDir,
        alertsDir,
        outboxDir,
        heartbeatFile,
        heartbeatLogFile,
        baselineFile,
        alertsCurrentFile,
        alertsAckFile,
        verifyFile,
        watchdogStateFile,
        externalRoot,
        installerFile,
      }
    },
    get started() { return state.started && !state.stopping },
    get stats() { return { ...state.stats } },
    get baseline() { return state.baseline ? { ...state.baseline } : null },
    get config() { return { ...cfg } },
  }
  return api
}
