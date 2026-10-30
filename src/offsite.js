/**
 * 异地副本（加密去重仓库）—— 插件侧编排服务。
 *
 * 分工（详见 docs/OFFSITE-ARCHIVE.md）：
 *   - 本文件负责「编排」：配置 / ledger / 解锁锁 / DPAPI 密钥缓存 /
 *     通过 ctx.dshSync.rpc 与子机的 ext.dr.repo.* 暂存通道同步 / 导出 / 恢复 / 演练 /
 *     保留策略 / 进度 / 计划任务命令；
 *   - 加解密与仓库格式在 src/archive/*（core 队友实现），本文件只调用一个窄接口
 *     `archive port`（见 ARCHIVE_PORT_METHODS）。core 未就位时整块功能返回
 *     `archive-core-missing`，不会影响旧的备份/恢复功能；
 *   - 子机只做「文件柜」：只接收不透明文件、不解密、不解释内容（dsh-sync 的
 *     ext.dr.repo.* op）。
 *
 * 安全红线（§7）：
 *   - 密码 / masterKey 只存在本机内存与 DPAPI 缓存文件；绝不进日志、面板响应、
 *     RPC payload；
 *   - 错误信息最多带「块名（HMAC 随机 hex）/失败原因」，不带明文路径或密码；
 *   - 删除只发生在 archive 根内、按白名单 name、由已配对设备发起。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { pathToFileURL } from 'node:url'

import { entryChunks, exists, joinInside, readJsonSafe, sha256hex, writeFileAtomic, writeJsonAtomic } from './util.js'

/* --------------------------------------------------------------- 常量 */

export const OFFSITE_VERSION = 1
export const LEDGER_VERSION = 1

/** 配置默认值（docs §5）。密码不在配置里。 */
export const OFFSITE_DEFAULTS = Object.freeze({
  enabled: true,
  dir: '',
  peerDeviceId: '',
  retainDaily: 7,
  retainWeekly: 4,
  quotaBytes: 20 * 1024 * 1024 * 1024,
  schedule: '04:00',
  weeklyDrill: true,
  // 扩展项：DPAPI 密钥缓存开关（默认开；关掉后每次都要手输密码）
  cacheKey: true,
})

/** 单个 pack 目标大小：≤ 4MiB（RPC 响应上限 8MB、单次 get ≤4MiB）。 */
export const PACK_TARGET_BYTES = 4 * 1024 * 1024
/** 上传切片：reset 512KiB（RPC 请求上限 1MB）。 */
export const UPLOAD_SLICE_BYTES = 512 * 1024
/** 单次 get 最大 4MiB。 */
export const GET_SLICE_BYTES = 4 * 1024 * 1024
/** ext RPC 默认超时（导出/恢复的 pack 传输放宽到 60s）。 */
export const RPC_TIMEOUT_MS = 20_000
export const RPC_TRANSFER_TIMEOUT_MS = 60_000
/** repo 统计缓存：面板 5s 轮询不得反复扫仓库目录。 */
export const REPO_STATS_TTL_MS = 15_000
/** 多子机列表上限（防御性：LAN 组内设备通常个位数）。 */
export const PEER_LIST_LIMIT = 50
/**
 * peerDeviceId 允许的字符：dsh-sync 的 deviceId 是 sha256(pubkey) 前 32 位 hex，
 * 这里放宽到字母数字 + `._:-`，既覆盖 hex/uuid，也容忍测试与未来传输格式；
 * 拒绝空白/路径分隔符/控制字符，避免把配置写坏或注入路径。
 */
export const PEER_DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
/** 远端清单探测上限（避免一次刷新 decrypt 上千个清单）。 */
const REMOTE_MANIFEST_PROBE_LIMIT = 40
/** 从子机取块时最多顺序扫描的 pack 数量（每个 pack 4MiB）。 */
const PACK_SCAN_LIMIT = 128
/** 过期/旧版本 recovery-kit pack 的宽限期：给下一轮 sync 传新 kit 留时间。 */
const KIT_PACK_GRACE_MS = 7 * 86400_000

const LEDGER_FILE = 'ledger.json'
const PACK_INDEX_FILE = 'packs.json'
const KEY_CACHE_FILE = 'key.dpapi'
const CONFIG_FILE = 'config.json'
const MANIFEST_CHUNK_SIZE = 64 * 1024

/**
 * 仓库内文件名白名单：与 dsh-sync ext.dr.repo.* 的 name 校验保持一致
 * （chunks/<2>/<2>/<64>.cbin、manifests/<64>.mbin、packs/<64>.pbin、repo.json、recovery-kit/...）。
 */
export const REPO_NAME_PATTERN =
  /^(chunks\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.cbin|manifests\/[0-9a-f]{64}\.mbin|packs\/[0-9a-f]{64}\.pbin|repo\.json|recovery-kit\/[A-Za-z0-9._/-]{1,120})$/

/**
 * archive port：src/archive/* 必须提供的窄接口（core 队友按此对齐）。
 * 所有「加密/解密/HMAC 命名」都在 core，本文件只做编排与文件搬运。
 */
export const ARCHIVE_PORT_METHODS = Object.freeze([
  'initRepo',          // ({ dir, password, chunkSize }) -> key
  'openRepoKey',       // ({ dir, password }) -> key（密码错：throw code='bad-password'）
  'keyFromMasterKey',  // ({ dir, masterKey: Buffer }) -> key
  'masterKeyOf',       // (key) -> Buffer(32)
  'chunkName',         // ({ key, plainHash }) -> 'chunks/ab/cd/<64>.cbin'
  'manifestName',      // ({ key, snapshotId }) -> 'manifests/<64>.mbin'
  'encodeChunk',       // ({ key, plainBuf }) -> { name, buf, plainHash }
  'decodeChunk',       // ({ key, name, buf }) -> { plainBuf, plainHash }
  'encodeManifest',    // ({ key, manifest }) -> { name, buf, sha256 }
  'decodeManifest',    // ({ key, name, buf }) -> { manifest, sha256 }
  'buildPack',         // ({ key, entries: [{name, buf}] }) -> { name, buf }
  'unpackPack',        // ({ key, name, buf }) -> [{ name, buf }]
])

/* --------------------------------------------------------------- 小工具 */

/** 带 code 的错误：面板/CLI 用它区分失败原因（绝不含密码/明文）。 */
export function offlineError(code, message) {
  return Object.assign(new Error(String(message == null ? '' : message)), { code: String(code || 'offsite-error') })
}

function noopLogger() {}

/** powershell.exe 的 stderr 在中文 Windows 上常是 GBK：先 UTF-8，出现替换字符再退回 GBK。 */
function decodeConsoleText(buf) {
  const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'utf8')
  const utf8 = raw.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk', { fatal: false }).decode(raw)
  } catch {
    return utf8
  }
}

function sanitizeText(value, secret) {
  let text = String(value == null ? '' : value)
  if (secret != null && String(secret).length > 0) text = text.split(String(secret)).join('***')
  return text.slice(0, 400)
}

export function isRepoName(name) {
  return REPO_NAME_PATTERN.test(String(name || ''))
}

/** 仓库内相对 name → 绝对路径（严格白名单 + 越界检查）。 */
export function repoPath(dir, name) {
  const value = String(name || '')
  if (!isRepoName(value)) throw offlineError('bad-name', `非法的仓库文件名：${value.slice(0, 80)}`)
  const root = path.resolve(dir)
  const abs = path.resolve(root, ...value.split('/'))
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  if (abs !== root && !abs.startsWith(prefix)) throw offlineError('bad-name', '仓库路径越界')
  return abs
}

function isInside(parent, child) {
  const base = path.resolve(parent)
  const abs = path.resolve(child)
  return abs === base || abs.startsWith(base.endsWith(path.sep) ? base : base + path.sep)
}

function dayKey(ms) {
  const d = new Date(Number(ms) || 0)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** ISO 周键（跨年按 ISO 周，避免 12-31 与 01-01 被算成两周）。 */
function weekKey(ms) {
  const d = new Date(Number(ms) || 0)
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** "04:00" → { hour, minute }；空/非法 → null。 */
export function parseSchedule(value) {
  const text = String(value == null ? '' : value).trim()
  if (!text) return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null
  return { hour, minute, text: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` }
}

/** 最近一个已经到点的计划时刻（未到今日则用昨日），用于「补跑」。 */
export function scheduleDueAt(nowMs, parsed) {
  if (!parsed) return null
  const d = new Date(Number(nowMs) || Date.now())
  d.setHours(parsed.hour, parsed.minute, 0, 0)
  if (d.getTime() > Number(nowMs)) d.setDate(d.getDate() - 1)
  return d.getTime()
}

/* --------------------------------------------------------------- 密码规则 */

/**
 * 密码规则（§8.1）：≥9 位、必须字母+数字混合、长度不设上限。
 * 返回 { ok, code, message }。密码本身绝不回显。
 */
export function validatePassword(password) {
  const value = typeof password === 'string' ? password : String(password == null ? '' : password)
  if (value.length < 9) {
    return { ok: false, code: 'weak-password', message: '恢复密码至少 9 位，且必须同时包含字母和数字' }
  }
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    return { ok: false, code: 'weak-password', message: '恢复密码必须同时包含字母和数字' }
  }
  return { ok: true }
}

/* --------------------------------------------------------------- 配置校验 */

const CONFIG_KEYS = ['enabled', 'dir', 'peerDeviceId', 'retainDaily', 'retainWeekly', 'quotaBytes', 'schedule', 'weeklyDrill', 'cacheKey']

/**
 * 归一化异地副本配置：夹取数值、只收布尔、dir 必须是绝对路径（空 = 默认）。
 * 返回 { config, applied }；非法值忽略（不抛），未知键忽略。
 */
export function normalizeOffsiteConfig(patch, base = OFFSITE_DEFAULTS) {
  const source = patch && typeof patch === 'object' ? patch : {}
  const config = { ...OFFSITE_DEFAULTS, ...(base && typeof base === 'object' ? base : {}) }
  const applied = {}

  const take = (key) => Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined

  if (take('enabled')) {
    if (typeof source.enabled === 'boolean') { config.enabled = source.enabled; applied.enabled = source.enabled }
  }
  if (take('weeklyDrill')) {
    if (typeof source.weeklyDrill === 'boolean') { config.weeklyDrill = source.weeklyDrill; applied.weeklyDrill = source.weeklyDrill }
  }
  if (take('cacheKey')) {
    if (typeof source.cacheKey === 'boolean') { config.cacheKey = source.cacheKey; applied.cacheKey = source.cacheKey }
  }
  if (take('dir')) {
    const text = String(source.dir == null ? '' : source.dir).trim().replace(/^"(.*)"$/, '$1')
    if (text === '') { config.dir = ''; applied.dir = '' }
    else if (path.isAbsolute(text)) { config.dir = path.resolve(text); applied.dir = config.dir }
  }
  if (take('peerDeviceId')) {
    // 空字符串 = 自动选择（第一个在线已配对设备）；非空必须是合法 deviceId 形态。
    // 是否真的存在由 updateConfig 对照 dsh-sync 的已配对列表校验（unknown-peer）。
    const text = String(source.peerDeviceId == null ? '' : source.peerDeviceId).trim()
    if (text === '') { config.peerDeviceId = ''; applied.peerDeviceId = '' }
    else if (PEER_DEVICE_ID_PATTERN.test(text)) { config.peerDeviceId = text; applied.peerDeviceId = text }
  }
  if (take('retainDaily')) {
    if (typeof source.retainDaily === 'number' && Number.isFinite(source.retainDaily)) {
      config.retainDaily = Math.min(365, Math.max(1, Math.round(source.retainDaily)))
      applied.retainDaily = config.retainDaily
    }
  }
  if (take('retainWeekly')) {
    if (typeof source.retainWeekly === 'number' && Number.isFinite(source.retainWeekly)) {
      config.retainWeekly = Math.min(104, Math.max(0, Math.round(source.retainWeekly)))
      applied.retainWeekly = config.retainWeekly
    }
  }
  if (take('quotaBytes')) {
    if (typeof source.quotaBytes === 'number' && Number.isFinite(source.quotaBytes)) {
      config.quotaBytes = Math.min(1024 ** 4, Math.max(1024 * 1024, Math.round(source.quotaBytes)))
      applied.quotaBytes = config.quotaBytes
    }
  }
  if (take('schedule')) {
    const text = String(source.schedule == null ? '' : source.schedule).trim()
    if (text === '') { config.schedule = ''; applied.schedule = '' }
    else {
      const parsed = parseSchedule(text)
      if (parsed) { config.schedule = parsed.text; applied.schedule = parsed.text }
    }
  }
  // 只保留已知键（防止把密码之类的字段误写进配置文件）
  const clean = {}
  for (const key of CONFIG_KEYS) clean[key] = config[key]
  return { config: clean, applied }
}

/* --------------------------------------------------------------- ledger */

/**
 * ledger 空结构。
 *
 * 跨 writer 公开契约：`<offsite>/ledger.json` 由面板（本文件）与 archive-core 的
 * CLI（scripts/archive.mjs）共用。CLI 读得懂本 schema，本文件的 `normalizeLedger`
 * 也读得懂 CLI 写的 `entries`/`archives` 镜像。**函数名与导出一律保持稳定**
 * （archive-core 的跨 writer 测试直接 import 本函数）；内部实现可改。
 */
export function emptyLedger() {
  return {
    version: LEDGER_VERSION,
    seq: 0,
    prevManifest: null,
    archives: [],
    lastExportAt: null,
    lastDrillAt: null,
    lastSyncAt: null,
    lastError: null,
  }
}

/**
 * 归一化 ledger：坏数据不阻塞启动（字段缺失就补默认）。
 *
 * **公开契约（勿改名/移除导出）**：与 `scripts/archive.mjs` 的 CLI schema 双向兼容；
 * 面板保存时只写本 schema（会丢 CLI 的 `format`/`entries`），但保留 `archives` 镜像
 * 与 `prevManifest`/`seq` 链尾，CLI 能从这里接链。同一时刻只允许一个 ledger writer。
 */
export function normalizeLedger(raw) {
  const base = emptyLedger()
  if (!raw || typeof raw !== 'object') return base
  const out = { ...base }
  if (Number.isFinite(Number(raw.seq))) out.seq = Math.max(0, Math.round(Number(raw.seq)))
  if (typeof raw.prevManifest === 'string' && isRepoName(raw.prevManifest)) out.prevManifest = raw.prevManifest
  if (Array.isArray(raw.archives)) {
    const seen = new Set()
    const archives = []
    for (const item of raw.archives) {
      if (!item || typeof item !== 'object') continue
      const snapshotId = String(item.snapshotId || '')
      const manifestName = String(item.manifestName || '')
      if (!snapshotId || !isRepoName(manifestName) || seen.has(snapshotId)) continue
      seen.add(snapshotId)
      archives.push({
        snapshotId,
        manifestName,
        at: Number(item.at) || 0,
        seq: Number(item.seq) || 0,
        files: Number(item.files) || 0,
        bytes: Number(item.bytes) || 0,
        newChunks: Number(item.newChunks) || 0,
        manifestSha256: typeof item.manifestSha256 === 'string' ? item.manifestSha256 : '',
        source: 'local',
      })
    }
    archives.sort((a, b) => (b.at || 0) - (a.at || 0) || (b.seq || 0) - (a.seq || 0))
    out.archives = archives
  }
  for (const key of ['lastExportAt', 'lastDrillAt', 'lastSyncAt', 'lastPruneAt']) {
    if (Number.isFinite(Number(raw[key])) && Number(raw[key]) > 0) out[key] = Number(raw[key])
  }
  if (raw.lastError && typeof raw.lastError === 'object') {
    out.lastError = {
      code: String(raw.lastError.code || 'error').slice(0, 60),
      message: String(raw.lastError.message || '').slice(0, 300),
      at: Number(raw.lastError.at) || 0,
    }
  }
  if (raw.lastDrill && typeof raw.lastDrill === 'object') {
    out.lastDrill = {
      at: Number(raw.lastDrill.at) || 0,
      ok: Boolean(raw.lastDrill.ok),
      files: Number(raw.lastDrill.files) || 0,
      mismatched: Number(raw.lastDrill.mismatched) || 0,
      bytes: Number(raw.lastDrill.bytes) || 0,
      durationMs: Number(raw.lastDrill.durationMs) || 0,
    }
  }
  return out
}

/* --------------------------------------------------------------- 保留策略 */

/**
 * 保留策略（§4）：最近 retainDaily 份「每日」+ retainWeekly 份「每周」，pinned 永不淘汰，
 * 最新一份无论如何保留。按时间倒序扫描，每天/每周只取最新一份。
 *
 * @param {Array<{snapshotId:string, manifestName:string, at:number}>} archives
 * @returns {{ keep: object[], drop: object[] }}
 */
export function planRetention(archives, { retainDaily = 7, retainWeekly = 4, pinned = [], now = Date.now() } = {}) {
  const list = (Array.isArray(archives) ? [...archives] : [])
    .filter((item) => item && item.manifestName)
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
  const pinnedSet = new Set((Array.isArray(pinned) ? pinned : [...(pinned || [])]).map(String))
  const dailyLimit = Math.max(1, Number(retainDaily) || 1)
  const weeklyLimit = Math.max(0, Number(retainWeekly) || 0)
  const daySeen = new Set()
  const weekSeen = new Set()
  const keep = new Set()
  let daily = 0
  let weekly = 0

  for (const item of list) {
    const id = String(item.snapshotId || '')
    if (pinnedSet.has(id)) { keep.add(item.manifestName); continue }
    const day = dayKey(item.at)
    if (daily < dailyLimit && !daySeen.has(day)) {
      daySeen.add(day)
      keep.add(item.manifestName)
      daily += 1
      continue
    }
    const week = weekKey(item.at)
    if (weekly < weeklyLimit && !weekSeen.has(week)) {
      weekSeen.add(week)
      keep.add(item.manifestName)
      weekly += 1
    }
  }
  if (list.length) keep.add(list[0].manifestName)
  void now
  return {
    keep: list.filter((item) => keep.has(item.manifestName)),
    drop: list.filter((item) => !keep.has(item.manifestName)),
  }
}

/* --------------------------------------------------------------- DPAPI */

/**
 * DPAPI 客户端：调用 scripts/dpapi.ps1（[ProtectedData] CurrentUser）。
 * protect/unprotect 都只传 base64 文本，不落盘、不进日志。
 */
export function createDpapiClient({ scriptPath, spawn = nodeSpawn, platform = process.platform, timeoutMs = 20_000 } = {}) {
  const script = scriptPath || fileURLToPath(new URL('../scripts/dpapi.ps1', import.meta.url))
  async function run(mode, input) {
    if (platform !== 'win32') throw offlineError('dpapi-unavailable', 'DPAPI 密钥缓存只在 Windows 上可用')
    return await new Promise((resolve, reject) => {
      let child
      try {
        child = spawn('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode],
          { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      } catch (error) {
        reject(offlineError('dpapi-failed', `无法启动 powershell.exe：${String(error && error.message)}`))
        return
      }
      let out = ''
      const errChunks = []
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(value)
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* ignore */ }
        finish(reject, offlineError('dpapi-timeout', 'DPAPI 调用超时'))
      }, timeoutMs)
      if (timer.unref) timer.unref()
      child.stdout?.on('data', (chunk) => { out += chunk })
      child.stderr?.on('data', (chunk) => { errChunks.push(Buffer.from(chunk)) })
      child.on?.('error', (error) => finish(reject, offlineError('dpapi-failed', `DPAPI 调用失败：${String(error && error.message)}`)))
      child.on?.('close', (code) => {
        if (code !== 0) {
          // powershell.exe 的 stderr 是控制台代码页（中文系统上是 GBK），先按 UTF-8 解，坏了再退回 GBK，
          // 否则面板上会看到乱码。错误文本里绝不会有密码（脚本只写固定消息）。
          finish(reject, offlineError('dpapi-failed', `DPAPI 退出码 ${code}：${decodeConsoleText(Buffer.concat(errChunks)).trim() || '无输出'}`))
          return
        }
        finish(resolve, String(out).trim())
      })
      child.stdin?.on?.('error', () => { /* 子进程提前退出时忽略 EPIPE */ })
      try { child.stdin.end(Buffer.from(String(input), 'utf8')) } catch { /* close 事件会兜底 */ }
    })
  }
  return {
    available: platform === 'win32',
    platform,
    async protect(text) {
      const b64 = Buffer.from(String(text), 'utf8').toString('base64')
      return await run('Protect', b64)
    },
    async unprotect(blobBase64) {
      const out = await run('Unprotect', String(blobBase64 || ''))
      return Buffer.from(out, 'base64').toString('utf8')
    },
  }
}

/* --------------------------------------------------------------- archive port */

/**
 * 从 src/archive/* 动态装配 archive port。
 *
 * 首选 `src/archive/port.js`（core 提供的对象参数适配层，与 ARCHIVE_PORT_METHODS
 * 完全同名同签名）；老版本 core 没有 port.js 时才退回多模块 pick（此时 format.js 里
 * 位置参数版本的 openRepoKey 等可能导致接口不齐，会报 archive-core-missing）。
 * core 未就位或接口不齐时抛 `archive-core-missing`（面板显示「核心模块未就位」，
 * 旧的备份/恢复功能不受影响）。
 */
export async function createArchivePort({ importModule } = {}) {
  const load = importModule || ((spec) => import(spec))
  const arePortMethodsPresent = (candidate) =>
    candidate && ARCHIVE_PORT_METHODS.every((name) => typeof candidate[name] === 'function')

  // 1) 首选 port.js：对象参数签名，避免和 format.js 的位置参数版本撞名
  try {
    const port = await load(new URL('./archive/port.js', import.meta.url).href)
    if (arePortMethodsPresent(port)) return port
  } catch { /* 旧 core 没有 port.js：继续走兼容路径 */ }

  // 2) 兼容路径：从核心模块里 pick（只为过渡期不炸插件）
  const modules = []
  for (const spec of ['./archive/repo.js', './archive/format.js', './archive/export.js', './archive/import.js']) {
    try {
      const mod = await load(new URL(spec, import.meta.url).href)
      if (mod) modules.push(mod)
    } catch { /* 缺文件是正常情况（core 未就位） */ }
  }
  const pick = (...names) => {
    for (const name of names) {
      for (const mod of modules) {
        if (typeof mod[name] === 'function') return mod[name]
      }
    }
    return undefined
  }
  const port = {
    initRepo: pick('initRepo', 'initRepository', 'createRepo'),
    openRepoKey: pick('openRepoKey', 'openRepo', 'unlockRepo'),
    keyFromMasterKey: pick('keyFromMasterKey', 'keyFromMaster', 'openRepoWithMasterKey'),
    masterKeyOf: pick('masterKeyOf', 'getMasterKey'),
    chunkName: pick('chunkName', 'chunkNameFor'),
    manifestName: pick('manifestName', 'manifestNameFor'),
    encodeChunk: pick('encodeChunk', 'encryptChunk'),
    decodeChunk: pick('decodeChunk', 'decryptChunk'),
    encodeManifest: pick('encodeManifest', 'encryptManifest'),
    decodeManifest: pick('decodeManifest', 'decryptManifest'),
    buildPack: pick('buildPack', 'createPack', 'sealPack'),
    unpackPack: pick('unpackPack', 'readPack', 'openPack'),
  }
  const missing = ARCHIVE_PORT_METHODS.filter((name) => typeof port[name] !== 'function')
  if (missing.length) {
    throw offlineError(
      'archive-core-missing',
      `异地副本核心模块未就位或接口不齐（缺少 ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ' …' : ''}）`,
    )
  }
  return port
}

/* --------------------------------------------------------------- 服务 */

/**
 * 创建异地副本服务。
 *
 * @param {object} options
 * @param {object} options.engine        备份引擎（只读使用 store / state；pin/import 可选）
 * @param {string} [options.dir]         仓库目录（默认 <storeDir>/offsite）
 * @param {Function} [options.getSync]   () => ctx.dshSync（dsh-sync 的 broker api）；没有则降级
 * @param {object|Function} [options.archive] archive port 或其 loader（测试注入 fake）
 * @param {object} [options.dpapi]       { available, protect, unprotect }（测试注入 fake）
 * @param {Function} [options.logger]    日志函数（绝不传密码）
 * @param {object} [options.config]      插件配置里的 offsite 段（最低优先级）
 * @param {Function} [options.now]
 * @param {Function} [options.spawn]
 * @param {Function} [options.createTempEngine] 演练用的临时引擎工厂
 */
export function createOffsiteService({
  engine,
  dir,
  getSync,
  archive,
  dpapi,
  logger = noopLogger,
  config: pluginConfig,
  now = () => Date.now(),
  spawn = nodeSpawn,
  createTempEngine,
  platform = process.platform,
} = {}) {
  const state = {
    config: { ...OFFSITE_DEFAULTS },
    ledger: emptyLedger(),
    packs: {},
    key: null,
    keySource: null,
    unlockedAt: 0,
    repoInitialized: false,
    hasCachedKeyFlag: false,
    initialized: false,
    initPromise: null,
    busy: false,
    progress: { phase: 'idle', doneBytes: 0, totalBytes: 0, message: '' },
    lastError: null,
    cachedRepoStats: null,
    cachedRepoStatsAt: 0,
    cachedPeer: null,
    cachedPeerAt: 0,
    schedulerTimer: null,
    port: null,
    portLoading: null,
  }

  const log = (message) => {
    try { logger(`[offsite] ${sanitizeText(message)}`) } catch { /* logger 不可用 */ }
  }

  const resolveArchive = () => {
    if (state.port) return Promise.resolve(state.port)
    if (state.portLoading) return state.portLoading
    state.portLoading = (async () => {
      try {
        const source = typeof archive === 'function' ? await archive() : archive
        if (!source) throw offlineError('archive-core-missing', '异地副本核心模块未就位（src/archive/*）')
        const missing = ARCHIVE_PORT_METHODS.filter((name) => typeof source[name] !== 'function')
        if (missing.length) {
          throw offlineError(
            'archive-core-missing',
            `异地副本核心模块缺少接口：${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ' …' : ''}`,
          )
        }
        state.port = source
        return source
      } finally {
        state.portLoading = null
      }
    })()
    return state.portLoading
  }

  const getDpapi = () => {
    if (dpapi) return dpapi
    if (!state.dpapiClient) state.dpapiClient = createDpapiClient({ spawn, platform })
    return state.dpapiClient
  }

  const storeDir = () => {
    const value = engine && typeof engine.storeDir === 'string' ? engine.storeDir : ''
    if (value) return path.resolve(value)
    throw offlineError('not-ready', '备份引擎尚未启动')
  }

  const configuredDir = () => {
    const custom = String(state.config.dir || '').trim()
    if (custom) return path.resolve(custom)
    if (dir) return path.resolve(dir)
    return path.join(storeDir(), 'offsite')
  }

  const paths = () => {
    const root = configuredDir()
    return {
      root,
      repo: path.join(root, 'repo'),
      ledger: path.join(root, LEDGER_FILE),
      packs: path.join(root, PACK_INDEX_FILE),
      keyCache: path.join(root, KEY_CACHE_FILE),
      config: path.join(root, CONFIG_FILE),
    }
  }

  /* ------------------------------------------------------------ 初始化 */

  const readConfigChain = async () => {
    // 只认插件配置里的 offsite 段（engine 的 enabled/watch/root 等键与异地副本无关）
    const pluginOffsite = pluginConfig && typeof pluginConfig === 'object' && pluginConfig.offsite
      ? pluginConfig.offsite
      : {}
    let merged = normalizeOffsiteConfig(pluginOffsite).config
    let storeConfig = null
    try {
      const storeConfigFile = path.join(storeDir(), CONFIG_FILE)
      const parsed = await readJsonSafe(storeConfigFile, null)
      storeConfig = parsed && typeof parsed === 'object' ? parsed : null
    } catch { storeConfig = null }
    if (storeConfig && storeConfig.offsite) {
      merged = normalizeOffsiteConfig(storeConfig.offsite, merged).config
    }
    // 自己的 config.json 优先级最高（engine.persistConfig 会重写 <storeDir>/config.json，
    // 只保留它自己的键，所以异地副本必须有自己的落盘位置）
    const tentative = normalizeOffsiteConfig(merged, merged).config
    const ownDir = tentative.dir ? path.resolve(tentative.dir) : path.join(storeDir(), 'offsite')
    const own = await readJsonSafe(path.join(ownDir, CONFIG_FILE), null)
    if (own && typeof own === 'object') merged = normalizeOffsiteConfig(own, merged).config
    // 目录安全：不允许放在 DSH_HOME 里（会被备份/恢复互相踩）
    if (merged.dir && engine && engine.home && isInside(engine.home, path.resolve(merged.dir))) {
      log('配置的异地副本目录在 DSH 数据目录内，已忽略，改用默认位置')
      merged = { ...merged, dir: '' }
    }
    return merged
  }

  const persistConfig = async () => {
    await writeJsonAtomic(paths().config, state.config)
    // 尽力镜像到 <storeDir>/config.json 的 offsite 段（引擎重写该文件时可能丢，读回时以本文件为准）
    try {
      const storeConfigFile = path.join(storeDir(), CONFIG_FILE)
      const current = await readJsonSafe(storeConfigFile, null)
      const next = { ...(current && typeof current === 'object' ? current : {}), offsite: state.config }
      await writeJsonAtomic(storeConfigFile, next)
    } catch { /* 镜像失败不影响主配置 */ }
  }

  const readLedger = async () => normalizeLedger(await readJsonSafe(paths().ledger, null))
  const saveLedger = async () => {
    await writeJsonAtomic(paths().ledger, state.ledger)
  }

  const readPackIndex = async () => {
    const raw = await readJsonSafe(paths().packs, null)
    if (!raw || typeof raw !== 'object' || !raw.packs || typeof raw.packs !== 'object') return {}
    const out = {}
    for (const [name, value] of Object.entries(raw.packs)) {
      if (!isRepoName(name) || !name.startsWith('packs/')) continue
      if (!value || typeof value !== 'object') continue
      const names = Array.isArray(value.names) ? value.names.filter(isRepoName) : []
      const shas = {}
      if (value.shas && typeof value.shas === 'object') {
        for (const [fileName, sha] of Object.entries(value.shas)) {
          if (!isRepoName(fileName) || typeof sha !== 'string') continue
          shas[fileName] = sha
        }
      }
      out[name] = {
        at: Number(value.at) || 0,
        bytes: Number(value.bytes) || 0,
        sha256: typeof value.sha256 === 'string' ? value.sha256 : '',
        names,
        shas,
      }
    }
    return out
  }

  const savePackIndex = async () => {
    await writeJsonAtomic(paths().packs, { version: 1, packs: state.packs })
  }

  const recordError = (error) => {
    state.lastError = {
      code: String((error && error.code) || 'offsite-error'),
      message: sanitizeText((error && error.message) || error),
      at: now(),
    }
    state.ledger.lastError = state.lastError
    log(`error ${state.lastError.code}: ${state.lastError.message}`)
  }

  const ensureInit = async () => {
    if (state.initialized) return
    if (state.initPromise) return state.initPromise
    state.initPromise = (async () => {
      try {
        state.config = await readConfigChain()
        const p = paths()
        await fsp.mkdir(p.root, { recursive: true })
        await fsp.mkdir(p.repo, { recursive: true })
        state.ledger = await readLedger()
        state.packs = await readPackIndex()
        state.repoInitialized = await exists(path.join(p.repo, 'repo.json'))
        state.hasCachedKeyFlag = await exists(p.keyCache)
        if (state.repoInitialized) {
          const header = await readJsonSafe(path.join(p.repo, 'repo.json'), null)
          state.repoId = header && typeof header.repoId === 'string' ? header.repoId : null
        }
        state.cachedRepoStats = await computeRepoStats().catch(() => null)
        state.cachedRepoStatsAt = now()
      } catch (error) {
        recordError(error)
      } finally {
        state.initialized = true
        state.initPromise = null
      }
    })()
    return state.initPromise
  }

  const init = async () => {
    await ensureInit()
    log(`ready dir=${paths().root} initialized=${state.repoInitialized} locked=${!state.key}`)
    return api.summary()
  }

  /* ------------------------------------------------------------ 仓库统计 */

  const scanRepoFiles = async () => {
    const out = []
    const root = paths().repo
    const walk = async (rel) => {
      let entries = []
      try {
        entries = await fsp.readdir(rel ? path.join(root, ...rel.split('/')) : root, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const child = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) { await walk(child); continue }
        if (!entry.isFile()) continue
        if (!isRepoName(child)) continue
        const abs = path.join(root, ...child.split('/'))
        let stat = null
        try { stat = await fsp.stat(abs) } catch { continue }
        out.push({ name: child, size: stat.size })
      }
    }
    await walk('')
    return out
  }

  const computeRepoStats = async () => {
    const files = await scanRepoFiles()
    const out = { chunks: 0, chunkBytes: 0, manifests: 0, manifestBytes: 0, packs: 0, packBytes: 0, bytes: 0, count: files.length }
    for (const file of files) {
      out.bytes += file.size
      if (file.name.startsWith('chunks/')) { out.chunks += 1; out.chunkBytes += file.size }
      else if (file.name.startsWith('manifests/')) { out.manifests += 1; out.manifestBytes += file.size }
      else if (file.name.startsWith('packs/')) { out.packs += 1; out.packBytes += file.size }
    }
    out.quotaBytes = Number(state.config.quotaBytes) || OFFSITE_DEFAULTS.quotaBytes
    out.overQuota = out.bytes > out.quotaBytes
    out.at = now()
    return out
  }

  const repoStats = async ({ force = false } = {}) => {
    const maxAge = REPO_STATS_TTL_MS
    if (!force && state.cachedRepoStats && now() - state.cachedRepoStatsAt < maxAge) {
      return state.cachedRepoStats
    }
    const stats = await computeRepoStats()
    state.cachedRepoStats = stats
    state.cachedRepoStatsAt = now()
    return stats
  }

  /* ------------------------------------------------------------ key 状态 */

  const requireUnlocked = () => {
    if (!state.key) throw offlineError('locked', '异地副本已锁定：请先输入恢复密码解锁')
    return state.key
  }

  const requireInitialized = () => {
    if (!state.repoInitialized) throw offlineError('not-initialized', '异地副本仓库尚未初始化：先设置恢复密码')
  }

  const setKey = (key, source) => {
    state.key = key || null
    state.keySource = state.key ? source : null
    state.unlockedAt = state.key ? now() : 0
  }

  const unlockFromCache = async () => {
    await ensureInit()
    if (state.key) return { ok: true, keySource: state.keySource }
    if (!state.repoInitialized) await bootstrapRepoLocked()
    requireInitialized()
    const p = paths()
    if (!(await exists(p.keyCache))) throw offlineError('no-cached-key', '本机没有缓存密钥，请输入恢复密码')
    const client = getDpapi()
    if (!client.available) throw offlineError('dpapi-unavailable', 'DPAPI 密钥缓存只在 Windows 上可用')
    let masterKey
    try {
      const blob = (await fsp.readFile(p.keyCache, 'utf8')).trim()
      const text = await client.unprotect(blob)
      const parsed = JSON.parse(text)
      masterKey = Buffer.from(String(parsed.masterKey || ''), 'base64')
      if (masterKey.length !== 32) throw new Error('key length')
    } catch (error) {
      throw offlineError('cache-invalid', `本机密钥缓存不可用（${sanitizeText(error && error.message)}），请输入恢复密码`)
    }
    const port = await resolveArchive()
    let key
    try {
      key = await port.keyFromMasterKey({ dir: p.repo, masterKey })
    } catch (error) {
      throw offlineError('cache-invalid', `本机密钥缓存与仓库不匹配，请输入恢复密码（${sanitizeText(error && error.message)}）`)
    }
    setKey(key, 'cache')
    log('unlocked from DPAPI cache')
    return { ok: true, keySource: 'cache' }
  }

  const cacheKey = async (key) => {
    if (!state.config.cacheKey) return { ok: false, code: 'cache-disabled' }
    const client = getDpapi()
    if (!client.available) return { ok: false, code: 'dpapi-unavailable' }
    const port = await resolveArchive()
    const masterKey = port.masterKeyOf ? await port.masterKeyOf(key) : null
    if (!masterKey) return { ok: false, code: 'cache-unsupported' }
    const payload = JSON.stringify({
      v: 1,
      repoId: state.repoId || null,
      at: now(),
      masterKey: Buffer.from(masterKey).toString('base64'),
    })
    const blob = await client.protect(payload)
    if (!blob) throw offlineError('dpapi-failed', 'DPAPI 返回空结果')
    await writeFileAtomic(paths().keyCache, Buffer.from(blob, 'utf8'))
    state.hasCachedKeyFlag = true
    return { ok: true }
  }

  /**
   * 换机/重装系统的引导：本地没有 repo.json（明文头，只含 format/version/repoId/盐/KDF 参数），
   * 但子机上有 → 取回来。之后才能用恢复密码推导 masterKey。绝不传输密码/密钥。
   */
  const bootstrapRepoLocked = async () => {
    if (state.repoInitialized) return { ok: true, bootstrapped: false }
    const peer = requirePeer()
    const remote = await listRemote()
    if (!remote.has('repo.json')) {
      throw offlineError('not-initialized', `子机（${peer.name || peer.id}）上也没有仓库头 repo.json：请先在本机初始化异地副本`)
    }
    const buf = await fetchRemoteFile('repo.json', remote.get('repo.json'))
    await writeRepoFile('repo.json', buf)
    state.repoInitialized = true
    state.cachedRepoStats = null
    const header = await readJsonSafe(path.join(paths().repo, 'repo.json'), null)
    state.repoId = header && typeof header.repoId === 'string' ? header.repoId : null
    state.ledger = await readLedger()
    state.packs = await readPackIndex()
    log('repo header bootstrapped from peer')
    return { ok: true, bootstrapped: true }
  }

  const unlock = async (password) => {
    await ensureInit()
    // 换机/重装：本地没有仓库头，但子机上有 → 先把明文头 repo.json 取回来（不含任何密钥）
    if (!state.repoInitialized) await bootstrapRepoLocked()
    requireInitialized()
    const value = typeof password === 'string' ? password : String(password == null ? '' : password)
    const rules = validatePassword(value)
    if (!rules.ok) throw offlineError(rules.code, rules.message)
    const port = await resolveArchive()
    let key
    try {
      key = await port.openRepoKey({ dir: paths().repo, password: value })
    } catch (error) {
      const code = error && error.code === 'bad-password' ? 'bad-password' : 'unlock-failed'
      throw offlineError(code, code === 'bad-password'
        ? '恢复密码不正确'
        : `解锁失败：${sanitizeText((error && error.message) || error, value)}`)
    }
    setKey(key, 'password')
    let cache = { ok: true }
    try {
      cache = await cacheKey(key)
    } catch (error) {
      cache = { ok: false, code: (error && error.code) || 'cache-failed', message: sanitizeText(error && error.message) }
      log(`key cache unavailable: ${cache.code}`)
    }
    log('unlocked')
    return { ok: true, keySource: 'password', cache }
  }

  const lock = async () => {
    setKey(null)
    state.cachedPeer = null
    state.cachedPeerAt = 0
    log('locked (key dropped from memory)')
    return { ok: true, locked: true }
  }

  const clearKey = async () => {
    const p = paths()
    await fsp.rm(p.keyCache, { force: true }).catch(() => {})
    state.hasCachedKeyFlag = false
    setKey(null)
    log('key cache cleared')
    return { ok: true, locked: true, hasCachedKey: false }
  }

  const initRepo = async (password) => {
    await ensureInit()
    const value = typeof password === 'string' ? password : String(password == null ? '' : password)
    const rules = validatePassword(value)
    if (!rules.ok) throw offlineError(rules.code, rules.message)
    const p = paths()
    try { await fsp.mkdir(p.repo, { recursive: true }) } catch (error) {
      throw offlineError('dir-failed', `无法创建异地副本目录：${sanitizeText(error && error.message)}`)
    }
    if (await exists(path.join(p.repo, 'repo.json'))) {
      throw offlineError('already-initialized', '异地副本仓库已存在；如果要换密码，需要重新初始化（旧档案将不可读）')
    }
    const port = await resolveArchive()
    let key
    try {
      key = await port.initRepo({ dir: p.repo, password: value, chunkSize: MANIFEST_CHUNK_SIZE })
    } catch (error) {
      throw offlineError((error && error.code) || 'init-failed', `初始化仓库失败：${sanitizeText((error && error.message) || error, value)}`)
    }
    state.repoInitialized = true
    state.ledger = emptyLedger()
    state.packs = {}
    setKey(key, 'password')
    const header = await readJsonSafe(path.join(p.repo, 'repo.json'), null)
    state.repoId = header && typeof header.repoId === 'string' ? header.repoId : null
    // core 的 LocalRepo.init 已经写了 recovery-kit；这里只是兜底（老仓库/被删）
    const kit = await ensureRecoveryKitLocked()
    if (!kit.ok && kit.code !== 'unsupported') log(`recovery-kit 兜底失败：${kit.code}`)
    await saveLedger().catch(() => {})
    let cache = { ok: true }
    try { cache = await cacheKey(key) } catch (error) {
      cache = { ok: false, code: (error && error.code) || 'cache-failed' }
    }
    state.cachedRepoStats = null
    await repoStats({ force: true }).catch(() => {})
    log('repo initialized')
    return { ok: true, repoId: state.repoId || null, cache }
  }

  /* ------------------------------------------------------------ 配置 */

  const updateConfig = async (patch) => {
    await ensureInit()
    const before = paths().root
    const next = normalizeOffsiteConfig(patch, state.config)
    if (Object.keys(next.applied).length === 0) {
      throw offlineError('nothing-applied', '没有可应用的设置（值不合法或未被支持）')
    }
    if (next.config.dir && engine && engine.home && isInside(engine.home, path.resolve(next.config.dir))) {
      throw offlineError('bad-config', '异地副本目录不能放在 DSH 数据目录内（DSH 被清掉时会一起丢）')
    }
    // peerDeviceId 校验（在任何落盘之前）：必须命中当前已配对设备列表，
    // 否则 UI 选错/手填错会变成「悄悄回退」，用户无法察觉。
    if (Object.prototype.hasOwnProperty.call(next.applied, 'peerDeviceId')) {
      const wanted = String(next.config.peerDeviceId || '').trim()
      if (wanted) {
        const sync = syncPort()
        if (sync) {
          let list = null
          try { list = sync.peers() || [] } catch { list = null }
          if (Array.isArray(list)) {
            const known = list.some((peer) => String((peer && peer.deviceId) || '') === wanted)
            if (!known) throw offlineError('unknown-peer', `设备不在已配对列表中：${wanted}`)
          }
          // 同步不可用/未就绪时无法对照列表：先接受，状态里会显示 configValid=null
        }
      }
    }
    state.config = next.config
    invalidatePeerCache()
    await persistConfig()
    const after = paths().root
    if (after !== before) {
      state.ledger = await readLedger()
      state.packs = await readPackIndex()
      state.repoInitialized = await exists(path.join(paths().repo, 'repo.json'))
      state.cachedRepoStats = null
    } else {
      state.cachedRepoStats = null
      state.hasCachedKeyFlag = await exists(paths().keyCache)
    }
    await repoStats({ force: true }).catch(() => {})
    log(`config updated: ${Object.keys(next.applied).join(',')}`)
    return next.applied
  }

  /* ------------------------------------------------------------ 同步通道 */

  const syncPort = () => {
    try {
      const sync = typeof getSync === 'function' ? getSync() : null
      if (!sync || typeof sync.rpc !== 'function' || typeof sync.peers !== 'function') return null
      return sync
    } catch {
      return null
    }
  }

  const sanitizePeer = (peer) => ({
    deviceId: String((peer && peer.deviceId) || ''),
    name: String((peer && peer.name) || ''),
    online: Boolean(peer && peer.online),
    trusted: Boolean(peer && peer.trusted),
    lastSyncAt: (peer && peer.lastSyncAt) || null,
  })

  /** 列表排序：在线优先 → 名称（忽略大小写）→ deviceId（稳定）。 */
  const sortPeers = (peers) => [...peers].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1
    const an = a.name.toLowerCase()
    const bn = b.name.toLowerCase()
    if (an !== bn) return an < bn ? -1 : 1
    if (a.deviceId === b.deviceId) return 0
    return a.deviceId < b.deviceId ? -1 : 1
  })

  /**
   * 解析「当前备份目标」——所有选 peer 的路径（导出/同步/取回/恢复/演练/裁剪/引导/通知）
   * 都只认这里的结果，避免各处逻辑分叉。
   *
   * 规则（task-15）：
   *  1. config.peerDeviceId 命中已配对设备 → 用它；**它离线就报 peer-offline，绝不静默换设备**；
   *  2. 未配置，或配置的 deviceId 已不存在（失效）→ 回退第一个「在线且已配对」设备，
   *     其次第一个在线设备、第一个已配对设备；state 里用 configValid=false + source='fallback' 标明；
   *  3. 没有任何设备 → reason='no-peers'。
   */
  const resolvePeerSelection = (wanted) => {
    const base = {
      sync: false,
      configured: Boolean(wanted),
      requested: wanted || null,
      configValid: null,
      source: 'none',
      id: null,
      name: '',
      online: false,
      paired: false,
      trusted: false,
      reason: 'sync-missing',
      lastSyncAt: null,
      peers: [],
    }
    const sync = syncPort()
    if (!sync) return base
    let raw = null
    try {
      raw = sync.peers() || []
    } catch {
      return { ...base, sync: true, reason: 'sync-not-ready' }
    }
    // 去重（同一 deviceId 只留一条，防止传输层重复上报导致 selected 命中多条）
    const unique = new Map()
    for (const peer of raw.map(sanitizePeer)) {
      if (peer.deviceId && !unique.has(peer.deviceId)) unique.set(peer.deviceId, peer)
    }
    const peers = sortPeers([...unique.values()]).slice(0, PEER_LIST_LIMIT)

    let picked = null
    let configValid = null
    let source = 'none'
    if (wanted) {
      picked = peers.find((peer) => peer.deviceId === wanted) || null
      if (picked) {
        configValid = true
        source = 'config'
      } else {
        // 配置失效：允许回退，但要把「配置无效」如实暴露给 UI
        configValid = false
        source = 'fallback'
      }
    } else {
      source = 'fallback'
    }
    if (!picked) {
      picked = peers.find((peer) => peer.online && peer.trusted)
        || peers.find((peer) => peer.online)
        || peers.find((peer) => peer.trusted)
        || peers[0]
        || null
    }
    let reason = 'ok'
    if (!picked) reason = 'no-peers'
    else if (!picked.online) reason = 'peer-offline'
    if (!picked) source = 'none'

    return {
      sync: true,
      configured: Boolean(wanted),
      requested: wanted || null,
      configValid,
      source,
      id: picked ? picked.deviceId : null,
      name: picked ? picked.name : '',
      online: Boolean(picked && picked.online),
      paired: Boolean(picked && picked.trusted !== false),
      trusted: Boolean(picked && picked.trusted),
      reason,
      lastSyncAt: (picked && picked.lastSyncAt) || null,
      peers: peers.map((peer) => ({ ...peer, selected: Boolean(picked && peer.deviceId === picked.deviceId) })),
    }
  }

  const invalidatePeerCache = () => {
    state.cachedPeer = null
    state.cachedPeerAt = 0
  }

  const peerSnapshot = ({ maxAgeMs = 10_000, force = false } = {}) => {
    if (!force && state.cachedPeer && now() - state.cachedPeerAt < maxAgeMs) return state.cachedPeer
    const wanted = String(state.config.peerDeviceId || '').trim()
    const value = resolvePeerSelection(wanted)
    state.cachedPeer = value
    state.cachedPeerAt = now()
    return value
  }

  const requirePeer = () => {
    const peer = peerSnapshot({ force: true })
    if (!peer.sync) throw offlineError('sync-missing', '没有可用的设备同步（dsh-sync 未安装或未启用）')
    if (peer.reason === 'sync-not-ready') throw offlineError('sync-not-ready', '设备同步尚未就绪，请稍后再试')
    if (peer.reason === 'no-peers') {
      if (peer.configured && peer.configValid === false) {
        throw offlineError('no-peers', `配置的备份目标不在已配对列表中（${peer.requested}），也没有其它可用的已配对设备`)
      }
      throw offlineError('no-peers', '还没有已配对的设备：请先在 dsh-sync 里配对子机')
    }
    if (!peer.online) {
      const label = peer.name || peer.id || ''
      if (peer.configured && peer.configValid === false) {
        throw offlineError('peer-offline', `配置的备份目标不在已配对列表中（${peer.requested}），回退设备 ${label} 也不在线`)
      }
      if (peer.configured) {
        throw offlineError('peer-offline', `选中的备份设备不在线：${label}（不会自动改用其它设备）`)
      }
      throw offlineError('peer-offline', `子机不在线：${label}`)
    }
    return peer
  }

  const rpc = async (op, payload, { timeoutMs = RPC_TIMEOUT_MS } = {}) => {
    const sync = syncPort()
    if (!sync) throw offlineError('sync-missing', '没有可用的设备同步（dsh-sync 未安装或未启用）')
    const peer = requirePeer()
    try {
      return await sync.rpc(peer.id, `ext.dr.repo.${op}`, payload, { timeoutMs })
    } catch (error) {
      const code = String((error && error.code) || 'peer-rpc')
      const message = sanitizeText((error && error.message) || error)
      const mapped = {
        'not-paired': 'peer-not-paired',
        'peer-offline': 'peer-offline',
        'ext-disabled': 'peer-ext-disabled',
        'payload-too-large': 'payload-too-large',
        'response-too-large': 'response-too-large',
      }[code] || code
      throw offlineError(mapped, `子机 ${op} 失败：${message}`)
    }
  }

  const listRemote = async () => {
    const map = new Map()
    let cursor = null
    for (let page = 0; page < 400; page += 1) {
      const response = await rpc('list', cursor ? { cursor, limit: 500 } : { limit: 500 })
      const names = Array.isArray(response && response.names) ? response.names : []
      for (const item of names) {
        const name = String((item && item.name) || '')
        if (!isRepoName(name)) continue
        map.set(name, Number(item && item.size) || 0)
      }
      cursor = response && response.cursor ? String(response.cursor) : null
      if (!cursor) break
    }
    return map
  }

  const fetchRemoteFile = async (name, sizeHint) => {
    const expected = Number(sizeHint) || 0
    const parts = []
    let total = expected
    let offset = 0
    for (let guard = 0; guard < 1024; guard += 1) {
      const length = total ? Math.min(GET_SLICE_BYTES, total - offset) : GET_SLICE_BYTES
      if (total && length <= 0) break
      const response = await rpc('get', { name, offset, length }, { timeoutMs: RPC_TRANSFER_TIMEOUT_MS })
      const data = Buffer.from(String((response && response.dataBase64) || ''), 'base64')
      parts.push(data)
      offset += data.length
      if (!total) {
        total = Number(response && response.size) || offset
      }
      if (offset >= total || data.length === 0) break
    }
    const buf = Buffer.concat(parts)
    if (total && buf.length !== total) {
      throw offlineError('peer-bad-response', `子机返回的文件长度不符：${name}（${buf.length}/${total}）`)
    }
    return buf
  }

  const uploadRepoFile = async (name, buf) => {
    const size = buf.length
    const sha256 = sha256hex(buf)
    const begin = await rpc('putBegin', { name, size, sha256 }, { timeoutMs: RPC_TRANSFER_TIMEOUT_MS })
    if (begin && begin.exists) return { exists: true, name, size, sha256 }
    const uploadId = begin && begin.uploadId ? String(begin.uploadId) : ''
    if (!uploadId) throw offlineError('peer-protocol', '子机未返回 uploadId')
    try {
      let index = 0
      for (let offset = 0; offset < size; index += 1) {
        const slice = buf.subarray(offset, Math.min(offset + UPLOAD_SLICE_BYTES, size))
        await rpc('putChunk', { uploadId, index, dataBase64: slice.toString('base64') }, { timeoutMs: RPC_TRANSFER_TIMEOUT_MS })
        offset += slice.length
      }
      const commit = await rpc('putCommit', { uploadId }, { timeoutMs: RPC_TRANSFER_TIMEOUT_MS })
      return { exists: false, name: (commit && commit.name) || name, size, sha256 }
    } catch (error) {
      try { await rpc('putAbort', { uploadId }) } catch { /* ignore */ }
      throw error
    }
  }

  const deleteRemote = async (names) => {
    const list = (Array.isArray(names) ? names : []).filter(isRepoName)
    const deleted = []
    for (let offset = 0; offset < list.length; offset += 200) {
      const batch = list.slice(offset, offset + 200)
      if (!batch.length) continue
      const response = await rpc('delete', { names: batch })
      if (response && Array.isArray(response.deleted)) deleted.push(...response.deleted.map(String))
      else deleted.push(...batch)
    }
    return deleted
  }

  /* ------------------------------------------------------------ pack / 仓库文件 */

  const readRepoFile = async (name) => {
    await ensureInit()
    return await fsp.readFile(repoPath(paths().repo, name))
  }

  const writeRepoFile = async (name, buf) => {
    await ensureInit()
    const abs = repoPath(paths().repo, name)
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await writeFileAtomic(abs, buf)
  }

  const hasRepoFile = async (name) => {
    try {
      await ensureInit()
      return await exists(repoPath(paths().repo, name))
    } catch {
      return false
    }
  }

  /** 把一组仓库文件打成 ≤4MiB 的 pack（文件名、加密封装都在 core）。 */
  const sealPacks = async (files) => {
    const port = await resolveArchive()
    const packs = []
    let group = []
    let size = 0
    const flush = async () => {
      if (!group.length) return
      const entries = []
      for (const file of group) entries.push({ name: file.name, buf: await readRepoFile(file.name) })
      const pack = await port.buildPack({ key: requireUnlocked(), entries })
      if (!pack || !pack.name || !pack.buf) throw offlineError('pack-failed', '打包失败：核心模块返回空结果')
      packs.push({
        name: pack.name,
        buf: pack.buf,
        sha256: sha256hex(pack.buf),
        names: group.map((file) => file.name),
      })
      group = []
      size = 0
    }
    for (const file of files) {
      if (file.name === 'repo.json') continue
      const fileSize = Number(file.size) || 0
      if (group.length && size + fileSize > PACK_TARGET_BYTES) await flush()
      group.push(file)
      size += fileSize
      if (size >= PACK_TARGET_BYTES) await flush()
    }
    await flush()
    return packs
  }

  /* ------------------------------------------------------------ 导出 */

  const exportLocked = async ({ snapshotId } = {}) => {
    requireUnlocked()
    await ensureInit()
    requireInitialized()
    const port = await resolveArchive()
    if (!engine || !engine.store) throw offlineError('not-ready', '备份引擎尚未启动')
    const id = String(snapshotId || engine.latestSnapshotId() || '')
    if (!id) throw offlineError('no-snapshot', '还没有可导出的快照')
    let manifest
    try {
      manifest = await engine.store.readManifest(id)
    } catch {
      throw offlineError('no-snapshot', `快照不存在或已损坏：${id}`)
    }
    let verify
    try {
      verify = await engine.verifySnapshot(id)
    } catch (error) {
      throw offlineError('verify-failed', `导出前体检失败：${sanitizeText(error && error.message)}`)
    }
    if (!verify || !verify.ok) {
      throw offlineError('verify-failed', `快照 ${id} 有 ${Number(verify && verify.missingCount) || 0} 个内容块缺失，拒绝导出`)
    }

    const pinned = typeof engine.pinSnapshot === 'function'
    if (pinned) engine.pinSnapshot(id)
    try {
      const files = manifest.files || {}
      const totalBytes = Object.values(files).reduce((sum, entry) => sum + (Number(entry && entry.s) || 0), 0)
      state.progress = { phase: 'exporting', doneBytes: 0, totalBytes, message: '加密归档中' }
      const seen = new Set()
      const newChunks = []
      const key = requireUnlocked()
      for (const entry of Object.values(files)) {
        for (const hash of entryChunks(entry)) {
          if (seen.has(hash)) continue
          seen.add(hash)
          const name = await port.chunkName({ key, plainHash: hash })
          if (await hasRepoFile(name)) continue
          let buf
          try {
            buf = await engine.store.get(hash)
          } catch (error) {
            throw offlineError('chunk-missing', `读取内容块失败：${hash.slice(0, 8)}…（${sanitizeText(error && error.message)}）`)
          }
          if (sha256hex(buf) !== hash) throw offlineError('chunk-corrupt', `内容块校验失败：${hash.slice(0, 8)}…`)
          const encoded = await port.encodeChunk({ key, plainBuf: buf })
          if (!encoded || !encoded.name || !encoded.buf) throw offlineError('chunk-encode-failed', '内容块加密失败：核心模块返回空结果')
          await writeRepoFile(encoded.name, encoded.buf)
          newChunks.push(encoded.name)
          state.progress.doneBytes += buf.length
        }
      }

      const ledgerBefore = state.ledger || emptyLedger()
      const seq = (Number(ledgerBefore.seq) || 0) + 1
      const prevManifest = ledgerBefore.prevManifest || null
      const plaintext = {
        version: OFFSITE_VERSION,
        snapshot: {
          id,
          at: Number(manifest.at) || now(),
          reason: String(manifest.reason || 'auto'),
          chunkSize: Number(manifest.chunkSize) || MANIFEST_CHUNK_SIZE,
          stats: {
            files: Object.keys(files).length,
            bytes: Number((manifest.stats && manifest.stats.bytes) || 0),
          },
          files: Object.fromEntries(Object.entries(files).map(([rel, entry]) => [rel, {
            s: Number(entry && entry.s) || 0,
            m: Number(entry && entry.m) || 0,
            c: entryChunks(entry),
          }])),
        },
        exportedAt: now(),
        prevManifest,
        seq,
      }
      const encodedManifest = await port.encodeManifest({ key, manifest: plaintext })
      if (!encodedManifest || !encodedManifest.name || !encodedManifest.buf) {
        throw offlineError('manifest-encode-failed', '清单加密失败：核心模块返回空结果')
      }
      await writeRepoFile(encodedManifest.name, encodedManifest.buf)
      const manifestSha256 = encodedManifest.sha256 || sha256hex(encodedManifest.buf)

      const archives = (ledgerBefore.archives || []).filter((item) => item.snapshotId !== id)
      archives.push({
        snapshotId: id,
        manifestName: encodedManifest.name,
        at: Number(manifest.at) || now(),
        seq,
        files: Object.keys(files).length,
        bytes: totalBytes,
        newChunks: newChunks.length,
        manifestSha256,
        source: 'local',
      })
      archives.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0) || (Number(b.seq) || 0) - (Number(a.seq) || 0))
      state.ledger = {
        ...ledgerBefore,
        seq,
        prevManifest: encodedManifest.name,
        archives,
        lastExportAt: now(),
      }
      await saveLedger()
      state.cachedRepoStats = null
      await repoStats({ force: true }).catch(() => {})

      const result = {
        ok: true,
        snapshotId: id,
        manifestName: encodedManifest.name,
        manifestSha256,
        seq,
        files: Object.keys(files).length,
        bytes: totalBytes,
        newChunks: newChunks.length,
        durationMs: 0,
      }
      // 导出后立刻尝试同步；同步失败不影响本地导出结果
      try {
        result.sync = await syncLocked()
      } catch (error) {
        result.sync = { ok: false, code: (error && error.code) || 'sync-failed', message: sanitizeText(error && error.message) }
        log(`export ok, sync skipped: ${result.sync.code}`)
        if (result.sync.code !== 'sync-missing' && result.sync.code !== 'peer-offline' && result.sync.code !== 'no-peers') {
          recordError(error)
        }
      }
      log(`export ${id}: files=${result.files} newChunks=${result.newChunks}`)
      return result
    } finally {
      if (pinned) {
        try { engine.unpinSnapshot(id) } catch { /* ignore */ }
      }
    }
  }

  const exportNow = async (options = {}) => runExclusive('exporting', () => exportLocked(options))

  /* ------------------------------------------------------------ 同步 */

  const syncLocked = async () => {
    requireUnlocked()
    await ensureInit()
    requireInitialized()
    const peer = requirePeer()
    // 同步前兜底刷新 recovery-kit（不含密钥的离线恢复工具，换机时子机侧也能直接跑）
    const kit = await ensureRecoveryKitLocked()
    if (!kit.ok && kit.code !== 'unsupported') log(`recovery-kit 兜底失败：${kit.code}`)
    state.progress = { phase: 'syncing', doneBytes: 0, totalBytes: 0, message: '读取子机清单' }
    const remote = await listRemote()
    const local = await scanRepoFiles()
    // 子机只存 pack（文件柜）：已经被某个「子机上确实存在的 pack」覆盖的本地文件不再重复打包。
    // recovery-kit 例外：插件升级会幂等重写 kit（同名不同内容），必须比 sha 才算覆盖，
    // 否则子机上会一直躺着旧版 kit（手动离线恢复会用到它）。
    const kitShas = {}
    for (const file of local) {
      if (!file.name.startsWith('recovery-kit/')) continue
      try { kitShas[file.name] = sha256hex(await readRepoFile(file.name)) } catch { /* 读不到就当作未覆盖 */ }
    }
    const covered = new Set()
    for (const [packName, record] of Object.entries(state.packs || {})) {
      if (!remote.has(packName)) continue
      for (const name of record.names || []) {
        if (name.startsWith('recovery-kit/')) {
          const recorded = record.shas && record.shas[name]
          if (recorded && recorded === kitShas[name]) covered.add(name)
          continue
        }
        covered.add(name)
      }
    }
    const missing = local.filter((file) => !remote.has(file.name) && !covered.has(file.name))
    const totalBytes = missing.reduce((sum, file) => sum + file.size, 0)
    state.progress.totalBytes = totalBytes
    const repoJsonMissing = local.some((file) => file.name === 'repo.json') && !remote.has('repo.json')
    if (!missing.length && !repoJsonMissing) {
      state.ledger.lastSyncAt = now()
      await saveLedger().catch(() => {})
      log('sync: peer already up to date')
      return { ok: true, uploaded: 0, uploadedBytes: 0, packs: [], skipped: true, peer: peer.id, upToDate: true }
    }
    const packs = await sealPacks(missing)
    const uploadedPacks = []
    let uploadedBytes = 0
    for (const pack of packs) {
      const receipt = await uploadRepoFile(pack.name, pack.buf)
      // 只有上传成功之后才记「已覆盖」：失败时宁可下一轮重传，也不能让索引说谎
      const shas = {}
      for (const name of pack.names) if (name.startsWith('recovery-kit/') && kitShas[name]) shas[name] = kitShas[name]
      state.packs[pack.name] = { at: now(), bytes: pack.buf.length, sha256: pack.sha256, names: pack.names, shas }
      await savePackIndex().catch(() => {})
      if (!receipt.exists) {
        uploadedPacks.push(pack.name)
        uploadedBytes += pack.buf.length
      }
      state.progress.doneBytes += pack.buf.length
    }
    // repo.json 单独直传（恢复工具 / 端到端恢复需要它）
    const repoJson = local.find((file) => file.name === 'repo.json')
    let uploadedRepoJson = false
    if (repoJson && !remote.has('repo.json')) {
      const buf = await readRepoFile('repo.json')
      const receipt = await uploadRepoFile('repo.json', buf)
      uploadedRepoJson = !receipt.exists
      if (uploadedRepoJson) uploadedBytes += buf.length
    }
    if (uploadedPacks.length || packs.length) await savePackIndex().catch(() => {})
    state.ledger.lastSyncAt = now()
    await saveLedger().catch(() => {})
    state.cachedRepoStats = null
    log(`sync: packs=${uploadedPacks.length} bytes=${uploadedBytes} peer=${peer.id}`)
    return {
      ok: true,
      uploaded: uploadedPacks.length,
      uploadedBytes,
      packs: uploadedPacks,
      repoJson: uploadedRepoJson,
      skipped: false,
      peer: peer.id,
      upToDate: false,
    }
  }

  const syncToPeer = async () => runExclusive('syncing', () => syncLocked())

  /* ------------------------------------------------------------ 取回缺失 */

  const findArchive = (snapshotId) => {
    const id = String(snapshotId || '')
    return (state.ledger.archives || []).find((item) => item.snapshotId === id) || null
  }

  /** 解出某个快照对应的清单（本地没有就从子机取回并落盘）。 */
  const ensureManifestLocked = async (snapshotId) => {
    requireUnlocked()
    await ensureInit()
    requireInitialized()
    const port = await resolveArchive()
    const key = requireUnlocked()
    const id = String(snapshotId || '')
    if (!id) throw offlineError('bad-request', '缺少快照 id')
    const entry = findArchive(id)
    let manifestName = entry ? entry.manifestName : null
    if (!manifestName) manifestName = await port.manifestName({ key, snapshotId: id })
    let decoded = null
    if (await hasRepoFile(manifestName)) {
      try {
        decoded = await port.decodeManifest({ key, name: manifestName, buf: await readRepoFile(manifestName) })
      } catch {
        decoded = null
      }
    }
    if (!decoded) {
      state.progress = { phase: 'fetching', doneBytes: 0, totalBytes: 0, message: '从子机取清单' }
      const remote = await listRemote()
      let buf = null
      if (remote.has(manifestName)) {
        buf = await fetchRemoteFile(manifestName, remote.get(manifestName))
      } else {
        const found = await fetchFromPacks([manifestName], remote)
        buf = found.get(manifestName) || null
      }
      if (!buf) throw offlineError('missing-manifest', `子机缺少清单文件：${manifestName}`)
      await writeRepoFile(manifestName, buf)
      decoded = await port.decodeManifest({ key, name: manifestName, buf })
    }
    const manifest = decoded && decoded.manifest
    if (!manifest || !manifest.snapshot || typeof manifest.snapshot !== 'object') {
      throw offlineError('bad-manifest', `清单格式不对：${manifestName}`)
    }
    const manifestSha256 = decoded.sha256 || (entry && entry.manifestSha256) || ''
    // 哈希链：prevManifest 必须能在仓库里找到（找不到就提示断链，但不阻止恢复）
    let chainOk = true
    const prev = manifest.prevManifest || null
    if (prev) {
      chainOk = await hasRepoFile(prev)
      if (!chainOk) {
        try {
          const remote = await listRemote()
          chainOk = remote.has(prev)
        } catch { chainOk = false }
      }
    }
    return { snapshotId: id, manifestName, manifest, manifestSha256, chainOk, seq: Number(manifest.seq) || 0 }
  }

  /** 从子机的 packs 里凑出指定文件（顺序扫描，最多 PACK_SCAN_LIMIT 个）。 */
  const fetchFromPacks = async (neededNames, remote) => {
    const port = await resolveArchive()
    const key = requireUnlocked()
    const wanted = new Set(neededNames)
    const found = new Map()
    const indexed = []
    // 优先用本地 pack 索引定位；索引没覆盖的再顺序扫
    for (const [packName, record] of Object.entries(state.packs || {})) {
      if (!remote.has(packName)) continue
      if ((record.names || []).some((name) => wanted.has(name))) indexed.push(packName)
    }
    const ordered = new Set(indexed)
    for (const name of remote.keys()) {
      if (ordered.size >= PACK_SCAN_LIMIT) break
      if (!name.startsWith('packs/') || ordered.has(name)) continue
      ordered.add(name)
    }
    const packNames = [...ordered].filter((name) => remote.has(name))
    for (const packName of packNames) {
      if (found.size >= wanted.size) break
      const record = state.packs && state.packs[packName]
      const recordNames = (record && record.names) || null
      // 索引明确记录了这个 pack 的内容，且里面没有需要的文件 → 不浪费时间下载
      if (recordNames && !recordNames.some((name) => wanted.has(name) && !found.has(name))) continue
      const size = remote.get(packName) || (record && record.bytes) || 0
      state.progress = {
        phase: 'fetching',
        doneBytes: 0,
        totalBytes: size,
        message: '从子机取 pack',
      }
      let buf
      try {
        buf = await fetchRemoteFile(packName, size)
      } catch (error) {
        log(`pack fetch failed ${packName}: ${(error && error.code) || ''}`)
        continue
      }
      let entries
      try {
        entries = await port.unpackPack({ key, name: packName, buf })
      } catch (error) {
        log(`pack unpack failed ${packName}: ${(error && error.code) || ''}`)
        continue
      }
      if (!Array.isArray(entries)) continue
      for (const item of entries) {
        const name = String((item && item.name) || '')
        if (!isRepoName(name) || !wanted.has(name) || found.has(name)) continue
        await writeRepoFile(name, item.buf)
        found.set(name, item.buf)
      }
      state.progress.doneBytes = size
    }
    return found
  }

  /** 把快照需要、但本地仓库还没有的块从子机取回（写入本地加密仓库）。 */
  const fetchMissingLocked = async (snapshotId) => {
    const port = await resolveArchive()
    const key = requireUnlocked()
    const ensured = await ensureManifestLocked(snapshotId)
    const files = (ensured.manifest.snapshot && ensured.manifest.snapshot.files) || {}
    const needed = new Map()
    for (const entry of Object.values(files)) {
      for (const hash of entryChunks(entry)) {
        const name = await port.chunkName({ key, plainHash: hash })
        if (!(await hasRepoFile(name))) needed.set(name, hash)
      }
    }
    let fetched = 0
    let fetchedBytes = 0
    if (needed.size) {
      const remote = await listRemote()
      // 1) 子机若直接存了块（兼容只放块不放包的情况）→ 直接取
      for (const name of [...needed.keys()]) {
        if (!remote.has(name)) continue
        const buf = await fetchRemoteFile(name, remote.get(name))
        await writeRepoFile(name, buf)
        needed.delete(name)
        fetched += 1
        fetchedBytes += buf.length
      }
      // 2) 其余从 pack 里解
      if (needed.size) {
        const found = await fetchFromPacks([...needed.keys()], remote)
        for (const [name, buf] of found) {
          needed.delete(name)
          fetched += 1
          fetchedBytes += buf.length
        }
      }
      // 3) 复核
      const stillMissing = []
      for (const name of needed.keys()) {
        if (!(await hasRepoFile(name))) stillMissing.push(name)
      }
      if (stillMissing.length) {
        throw offlineError(
          'missing-chunks',
          `子机缺少 ${stillMissing.length} 个内容块（例如 ${stillMissing.slice(0, 3).join(', ')}），拒绝部分恢复`,
        )
      }
    }
    return { ...ensured, fetched, fetchedBytes }
  }

  const fetchMissingFromPeer = async (snapshotId) =>
    runExclusive('fetching', () => fetchMissingLocked(snapshotId))

  /* ------------------------------------------------------------ 恢复 */

  /** 把清单里的块解密后写进引擎的 BlobStore（engine.restore 只认自己的 store）。 */
  const materializeChunksLocked = async (manifest, targetStore, { phase = 'restoring', countProgress = true } = {}) => {
    const port = await resolveArchive()
    const key = requireUnlocked()
    const files = (manifest.snapshot && manifest.snapshot.files) || {}
    const total = Object.values(files).reduce((sum, entry) => sum + (Number(entry && entry.s) || 0), 0)
    if (countProgress) state.progress = { phase, doneBytes: 0, totalBytes: total, message: phase === 'drilling' ? '恢复到临时目录' : '写入备份仓库' }
    let written = 0
    const seen = new Set()
    for (const entry of Object.values(files)) {
      for (const hash of entryChunks(entry)) {
        if (seen.has(hash)) continue
        seen.add(hash)
        if (await targetStore.has(hash)) continue
        const name = await port.chunkName({ key, plainHash: hash })
        let encoded
        try {
          encoded = await readRepoFile(name)
        } catch {
          throw offlineError('missing-chunk', `本地仓库缺少内容块：${name}`)
        }
        const decoded = await port.decodeChunk({ key, name, buf: encoded })
        if (!decoded || !decoded.plainBuf) throw offlineError('chunk-decode-failed', '内容块解密失败：核心模块返回空结果')
        if (sha256hex(decoded.plainBuf) !== hash) {
          throw offlineError('chunk-corrupt', `内容块解密后校验失败：${name}`)
        }
        await targetStore.put(decoded.plainBuf)
        written += 1
        if (countProgress) state.progress.doneBytes += decoded.plainBuf.length
      }
    }
    return written
  }

  /** 清单注册进引擎（已有则跳过）。 */
  const registerManifestLocked = async (targetEngine, manifest) => {
    const id = String(manifest.snapshot.id || '')
    try {
      await targetEngine.store.readManifest(id)
      return false
    } catch { /* 需要注册 */ }
    if (typeof targetEngine.importSnapshot !== 'function') {
      throw offlineError('engine-import-missing', '备份引擎缺少 importSnapshot：请重启 DSH 升级 Host')
    }
    const payload = {
      version: 2,
      id,
      at: Number(manifest.snapshot.at) || now(),
      reason: String(manifest.snapshot.reason || 'offsite-restore'),
      host: (targetEngine && targetEngine.storeDir) ? path.basename(targetEngine.storeDir) : undefined,
      home: (targetEngine && targetEngine.home) || undefined,
      chunkSize: Number(manifest.snapshot.chunkSize) || MANIFEST_CHUNK_SIZE,
      files: manifest.snapshot.files || {},
      stats: {
        files: Object.keys((manifest.snapshot && manifest.snapshot.files) || {}).length,
        changed: 0,
        stored: 0,
        bytes: Number((manifest.snapshot && manifest.snapshot.stats && manifest.snapshot.stats.bytes) || 0),
        durationMs: 0,
      },
    }
    await targetEngine.importSnapshot(payload)
    return true
  }

  const restoreLocked = async ({ snapshotId, password } = {}) => {
    await ensureInit()
    requireInitialized()
    if (password != null && String(password) !== '') await unlock(String(password))
    requireUnlocked()
    const id = String(snapshotId || '')
    if (!id) throw offlineError('bad-request', '缺少快照 id')
    if (!engine || !engine.store) throw offlineError('not-ready', '备份引擎尚未启动')
    const fetchResult = await fetchMissingLocked(id)
    const manifest = fetchResult.manifest
    state.progress = { phase: 'restoring', doneBytes: 0, totalBytes: 0, message: '写入备份仓库' }
    const written = await materializeChunksLocked(manifest, engine.store, { phase: 'restoring' })
    const registered = await registerManifestLocked(engine, manifest)
    state.progress = { phase: 'restoring', doneBytes: 0, totalBytes: 0, message: '恢复到 DSH 数据目录' }
    let restore
    try {
      restore = await engine.restore(id)
    } catch (error) {
      throw offlineError((error && error.code) || 'restore-failed', `恢复失败：${sanitizeText(error && error.message)}`)
    }
    state.cachedRepoStats = null
    log(`restore ${id}: restored=${restore && restore.restored} chunksWritten=${written}`)
    return {
      ok: true,
      needRestart: true,
      snapshotId: id,
      manifestName: fetchResult.manifestName,
      chainOk: fetchResult.chainOk,
      fetched: fetchResult.fetched,
      fetchedBytes: fetchResult.fetchedBytes,
      chunksWritten: written,
      registered,
      restore,
    }
  }

  const restore = async (options = {}) => runExclusive('restoring', () => restoreLocked(options))

  /* ------------------------------------------------------------ 演练 */

  const defaultTempEngine = async ({ home, root }) => {
    const { BackupEngine } = await import('./engine.js')
    return new BackupEngine({
      home,
      config: { root, enabled: false, watch: false, scanMs: 3_600_000, debounceMs: 0, minIntervalMs: 0 },
      snapshotOnStart: false,
      log: () => {},
      hostname: 'drill',
    })
  }

  const compareDrillFiles = async (home, manifest) => {
    const files = (manifest.snapshot && manifest.snapshot.files) || {}
    const chunkSize = Math.max(1024, Number(manifest.snapshot.chunkSize) || MANIFEST_CHUNK_SIZE)
    const mismatched = []
    let checked = 0
    for (const [rel, entry] of Object.entries(files)) {
      const abs = joinInside(home, rel)
      if (!abs) { mismatched.push(rel); continue }
      let buf
      try {
        buf = await fsp.readFile(abs)
      } catch {
        mismatched.push(rel)
        continue
      }
      const chunks = entryChunks(entry)
      if (Number(entry.s) !== buf.length) { mismatched.push(rel); continue }
      let offset = 0
      let bad = false
      for (const hash of chunks) {
        const piece = buf.subarray(offset, Math.min(offset + chunkSize, buf.length))
        offset += piece.length
        if (sha256hex(piece) !== hash) { bad = true; break }
      }
      if (bad) mismatched.push(rel)
      checked += 1
      if (mismatched.length >= 200) break
    }
    return { checked, mismatched }
  }

  const safeRemoveTemp = async (dir) => {
    const tmp = path.resolve(os.tmpdir())
    const abs = path.resolve(dir)
    if (!isInside(tmp, abs) && abs !== tmp) throw offlineError('refuse-remove', '拒绝删除临时目录之外的路径')
    await fsp.rm(abs, { recursive: true, force: true })
  }

  const drillLocked = async ({ snapshotId } = {}) => {
    await ensureInit()
    requireInitialized()
    requireUnlocked()
    const firstArchive = (state.ledger.archives || [])[0] || null
    // 演练只针对「已经导出到异地仓库」的档案；没有档案就先导出（面板会提示）。
    const target = String(snapshotId || (firstArchive && firstArchive.snapshotId) || '')
    if (!target) throw offlineError('no-archive', '还没有可演练的异地档案：先导出一次再演练')
    const fetchResult = await fetchMissingLocked(target)
    const manifest = fetchResult.manifest
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-dr-drill-'))
    const home = path.join(base, 'home')
    const root = path.join(base, 'store')
    await fsp.mkdir(home, { recursive: true })
    await fsp.mkdir(root, { recursive: true })
    const factory = typeof createTempEngine === 'function' ? createTempEngine : defaultTempEngine
    let temp = null
    const startedAt = now()
    try {
      temp = await factory({ home, root })
      await temp.start()
      state.progress = { phase: 'drilling', doneBytes: 0, totalBytes: 0, message: '恢复到临时目录' }
      const written = await materializeChunksLocked(manifest, temp.store, { phase: 'drilling' })
      await registerManifestLocked(temp, manifest)
      await temp.restore(target)
      const compare = await compareDrillFiles(home, manifest)
      const ok = compare.mismatched.length === 0
      const result = {
        ok,
        snapshotId: target,
        manifestName: fetchResult.manifestName,
        chainOk: fetchResult.chainOk,
        files: compare.checked,
        mismatched: compare.mismatched.length,
        sample: compare.mismatched.slice(0, 10),
        chunksWritten: written,
        fetched: fetchResult.fetched,
        bytes: Object.values((manifest.snapshot && manifest.snapshot.files) || {})
          .reduce((sum, entry) => sum + (Number(entry && entry.s) || 0), 0),
        durationMs: now() - startedAt,
      }
      state.ledger.lastDrillAt = now()
      state.ledger.lastDrill = {
        at: now(), ok, files: result.files, mismatched: result.mismatched, bytes: result.bytes, durationMs: result.durationMs,
      }
      await saveLedger().catch(() => {})
      log(`drill ${target}: ok=${ok} files=${result.files} mismatched=${result.mismatched}`)
      return result
    } finally {
      if (temp && typeof temp.stop === 'function') {
        try { await temp.stop() } catch { /* ignore */ }
      }
      await safeRemoveTemp(base).catch((error) => log(`drill temp cleanup failed: ${(error && error.message) || error}`))
    }
  }

  const drill = async (options = {}) => runExclusive('drilling', () => drillLocked(options))

  /* ------------------------------------------------------------ 保留 / 清理 */

  const pinnedSnapshotIds = () => {
    const out = new Set()
    if (!engine) return []
    const collect = (value) => {
      if (!value) return
      if (value instanceof Set) { for (const item of value) out.add(String(item)); return }
      if (Array.isArray(value)) { for (const item of value) out.add(String(item)); return }
      if (typeof value === 'object') {
        for (const [key, flag] of Object.entries(value)) if (flag) out.add(String(key))
      }
    }
    // 公开契约优先：engine.listPinnedSnapshots() / engine.state().pinned
    // （core 明确 pinnedSnapshotIds 内部 Set 不是公开契约，不要依赖）
    try {
      if (typeof engine.listPinnedSnapshots === 'function') collect(engine.listPinnedSnapshots())
    } catch { /* ignore */ }
    try {
      const snapshotState = typeof engine.state === 'function' ? engine.state() : null
      if (snapshotState) collect(snapshotState.pinned)
    } catch { /* ignore */ }
    // 兼容更老的 engine（还没有公开方法时）
    collect(engine.pinnedSnapshots)
    return [...out]
  }

  let recoveryKitModule = null
  /**
   * 确保仓库里有 self-contained 的 recovery-kit（<repo>/recovery-kit/，不含密钥）。
   * core 的 LocalRepo.init 会自动写，这里只是兜底修复（旧仓库/被手动删掉），失败不阻塞。
   */
  const ensureRecoveryKitLocked = async () => {
    try {
      if (!recoveryKitModule) recoveryKitModule = await import('./archive/repo.js')
      const fn = recoveryKitModule && (recoveryKitModule.ensureRecoveryKit || recoveryKitModule.default?.ensureRecoveryKit)
      if (typeof fn !== 'function') return { ok: false, code: 'unsupported' }
      await fn(paths().repo)
      return { ok: true }
    } catch (error) {
      return { ok: false, code: (error && error.code) || 'kit-failed', message: sanitizeText(error && error.message) }
    }
  }

  const pruneLocked = async () => {
    requireUnlocked()
    await ensureInit()
    requireInitialized()
    const port = await resolveArchive()
    const key = requireUnlocked()
    state.progress = { phase: 'pruning', doneBytes: 0, totalBytes: 0, message: '计算保留清单' }
    const ledgerArchives = Array.isArray(state.ledger.archives) ? state.ledger.archives : []
    const pinned = pinnedSnapshotIds()
    const plan = planRetention(ledgerArchives, {
      retainDaily: state.config.retainDaily,
      retainWeekly: state.config.retainWeekly,
      pinned,
      now: now(),
    })
    const localFiles = await scanRepoFiles()
    const localNames = new Set(localFiles.map((file) => file.name))
    const keepNames = new Set(plan.keep.map((item) => item.manifestName))
    // recovery-kit/**（不含密钥的离线恢复工具）不参与保留策略：
    //   - 本地 kit 文件永不删；
    //   - 只保护「内容全是当前版本」的 kit pack；
    //   - 过期/含已移除文件（跨版本增删）的 kit pack 给一个宽限期（等同步把新 kit 传上去），
    //     过了宽限期才允许回收，避免「prune 跑在新 kit 同步之前」把子机上的 kit 清空。
    const currentKitSha = {}
    const currentKitNames = new Set()
    for (const file of localFiles) {
      if (!file.name.startsWith('recovery-kit/')) continue
      currentKitNames.add(file.name)
      try { currentKitSha[file.name] = sha256hex(await readRepoFile(file.name)) } catch { /* ignore */ }
    }
    const isProtectedKitPack = (record) => {
      const kitEntries = (record && Array.isArray(record.names) ? record.names : []).filter((name) => name.startsWith('recovery-kit/'))
      if (!kitEntries.length) return false
      let stale = false
      for (const name of kitEntries) {
        const recorded = record.shas && record.shas[name]
        // 老索引没有 sha 记录时保守保留（无法判断是否过期）
        if (!recorded) return true
        if (!currentKitNames.has(name)) { stale = true; continue } // 已从 kit 移除
        if (recorded !== currentKitSha[name]) { stale = true; continue } // 内容已升级
      }
      if (!stale) return true
      const age = now() - (Number(record.at) || 0)
      return age < KIT_PACK_GRACE_MS
    }
    const packShouldDrop = (name) => {
      const record = state.packs && state.packs[name]
      if (!record) return false // 没有索引信息：保守保留（可能是外部/CLI 拷入的真实数据）
      if (isProtectedKitPack(record)) return false
      return (record.names || []).every((item) => !referencedChunks.has(item) && !keepNames.has(item))
    }
    // 不在 ledger 里的清单保守保留（可能是 CLI 或其他机器导出后拷进来的）
    const ledgerNames = new Set(ledgerArchives.map((item) => item.manifestName))
    for (const name of localNames) {
      if (name.startsWith('manifests/') && !ledgerNames.has(name)) keepNames.add(name)
    }
    const referencedChunks = new Set()
    for (const name of keepNames) {
      if (!localNames.has(name)) continue
      try {
        const decoded = await port.decodeManifest({ key, name, buf: await readRepoFile(name) })
        const files = (decoded.manifest && decoded.manifest.snapshot && decoded.manifest.snapshot.files) || {}
        for (const entry of Object.values(files)) {
          for (const hash of entryChunks(entry)) referencedChunks.add(await port.chunkName({ key, plainHash: hash }))
        }
      } catch (error) {
        log(`prune: 无法解密清单 ${name}（保留不动）：${(error && error.code) || ''}`)
        keepNames.add(name)
      }
    }
    const dropLocal = []
    for (const file of localFiles) {
      const name = file.name
      if (name === 'repo.json') continue
      if (name.startsWith('manifests/')) { if (!keepNames.has(name)) dropLocal.push(name); continue }
      if (name.startsWith('chunks/')) { if (!referencedChunks.has(name)) dropLocal.push(name); continue }
      if (name.startsWith('packs/')) {
        if (!packShouldDrop(name)) continue
        // 只删「自己索引里记录过、且内容 sha 与索引一致」的本地 pack：
        // 外部/CLI 拷入的真实数据、或被人改过的文件一律不动。
        const record = state.packs[name]
        if (!record.sha256) continue
        try {
          const actual = sha256hex(await readRepoFile(name))
          if (actual !== record.sha256) continue
        } catch { continue }
        dropLocal.push(name)
      }
    }
    for (const name of dropLocal) {
      try { await fsp.rm(repoPath(paths().repo, name), { force: true }) } catch { /* ignore */ }
      if (name.startsWith('packs/') && state.packs) delete state.packs[name]
    }
    // 子机侧清理
    let remoteDeleted = 0
    let remoteError = null
    try {
      const remote = await listRemote()
      const dropRemote = []
      for (const name of remote.keys()) {
        if (name === 'repo.json') continue
        if (name.startsWith('manifests/')) { if (!keepNames.has(name)) dropRemote.push(name); continue }
        if (name.startsWith('chunks/')) { if (!referencedChunks.has(name)) dropRemote.push(name); continue }
        if (name.startsWith('packs/')) { if (packShouldDrop(name)) dropRemote.push(name) }
      }
      if (dropRemote.length) {
        const deleted = await deleteRemote(dropRemote)
        remoteDeleted = deleted.length
        // 子机上已删除的 pack 不再留在本地索引里（否则索引会随时间膨胀）
        for (const name of deleted) {
          if (state.packs && state.packs[name]) delete state.packs[name]
        }
      }
    } catch (error) {
      remoteError = { code: (error && error.code) || 'prune-remote-failed', message: sanitizeText(error && error.message) }
      log(`prune: 子机清理失败（本地已清理）：${remoteError.code}`)
    }
    const dropIds = new Set(plan.drop.map((item) => item.snapshotId))
    state.ledger.archives = ledgerArchives.filter((item) => !dropIds.has(item.snapshotId) || pinned.includes(item.snapshotId))
    state.ledger.lastPruneAt = now()
    await saveLedger().catch(() => {})
    await savePackIndex().catch(() => {})
    state.cachedRepoStats = null
    await repoStats({ force: true }).catch(() => {})
    log(`prune: kept=${keepNames.size} dropped=${plan.drop.length} local=${dropLocal.length} remote=${remoteDeleted}`)
    return {
      ok: true,
      kept: keepNames.size,
      dropped: plan.drop.length,
      localDeleted: dropLocal.length,
      remoteDeleted,
      referencedChunks: referencedChunks.size,
      pinned,
      remoteError,
    }
  }

  const pruneRemote = async () => runExclusive('pruning', () => pruneLocked())

  /* ------------------------------------------------------------ 独占执行 / 进度 */

  async function runExclusive(phase, fn) {
    if (state.busy) {
      throw offlineError('busy', `已有异地副本任务在进行（${state.progress.phase}），请稍候再试`)
    }
    state.busy = true
    const startedAt = now()
    state.progress = { phase, doneBytes: 0, totalBytes: 0, message: '', startedAt }
    try {
      const result = await fn()
      state.progress = { phase: 'idle', doneBytes: 0, totalBytes: 0, message: '', finishedAt: now(), durationMs: now() - startedAt }
      return result
    } catch (error) {
      state.progress = { phase: 'idle', doneBytes: 0, totalBytes: 0, message: '', finishedAt: now() }
      recordError(error)
      throw error
    } finally {
      state.busy = false
    }
  }

  /* ------------------------------------------------------------ 计划任务命令 */

  const pluginRoot = () => path.dirname(fileURLToPath(new URL('./offsite.js', import.meta.url)))

  const taskCommand = () => {
    const parsed = parseSchedule(state.config.schedule)
    if (!parsed) return null
    const node = process.execPath
    const entry = path.join(pluginRoot(), 'offsite.js')
    let home = ''
    let root = ''
    let hostname = ''
    try {
      home = engine && engine.home ? engine.home : ''
      root = engine && engine.config && engine.config.root ? path.resolve(engine.config.root) : ''
      hostname = (engine && engine.hostname) || os.hostname()
    } catch { /* ignore */ }
    const target = {
      home,
      root,
      hostname,
      dir: paths().root,
    }
    const entryUrl = pathToFileURL(path.resolve(entry)).href
    const js = `import(${JSON.stringify(entryUrl)}).then(m=>m.runHeadlessExport(${JSON.stringify(target)})).catch(e=>{try{console.error(String(e&&e.message||e))}catch{};process.exit(1)})`
    const th = `'${String(node).replace(/'/g, "''")}'`
    const actionArgs = `--input-type=module -e ${JSON.stringify(js)}`
    const psArgs = actionArgs.replace(/'/g, "''")
    const command = `$a = New-ScheduledTaskAction -Execute ${th} -Argument '${psArgs}'; ` +
      `$t = New-ScheduledTaskTrigger -Daily -At '${parsed.text}'; ` +
      `Register-ScheduledTask -TaskName 'dsh-disaster-recovery-offsite' -Action $a -Trigger $t ` +
      `-Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable) ` +
      `-Description 'dsh-disaster-recovery 异地副本无人值守导出（DPAPI 密钥缓存）' -Force`
    const schtasks = `schtasks.exe /Create /TN "dsh-disaster-recovery-offsite" /SC DAILY /ST ${parsed.text} ` +
      `/TR "\\"${node}\\" --input-type=module -e \\"${js.replace(/"/g, '\\"')}\\"" /F`
    return {
      taskName: 'dsh-disaster-recovery-offsite',
      schedule: parsed.text,
      program: node,
      arguments: actionArgs,
      command,
      schtasks,
      requiresDpapiKey: true,
      // 边界说明（面板/文档要写清）：独立进程拿不到 ctx.dshSync，所以计划任务只做本地导出；
      // 「导出 + 同步子机」由 DSH 进程内调度负责（要求 DSH 在运行且已缓存密钥）。
      localOnly: true,
      syncRequiresDsh: true,
      notes: [
        '计划任务在 DSH 未运行时也能跑：只用 DPAPI 缓存解锁并导出到本地仓库，不会同步子机。',
        '每日导出 + 同步子机由插件进程内调度完成（DSH 运行中，每 10 分钟检查一次计划时间）。',
        'DPAPI 缓存需要先在面板里解锁一次才会生成；换机/重装后用恢复密码。',
        '不要与面板里的导出/同步同时执行（同一个 ledger 同一时刻只允许一个写者）。',
      ],
    }
  }

  /* ------------------------------------------------------------ 状态 */

  const listArchives = () => {
    const archives = Array.isArray(state.ledger.archives) ? state.ledger.archives : []
    return archives.map((item) => ({
      snapshotId: item.snapshotId,
      manifestName: item.manifestName,
      at: Number(item.at) || 0,
      seq: Number(item.seq) || 0,
      files: Number(item.files) || 0,
      bytes: Number(item.bytes) || 0,
      newChunks: Number(item.newChunks) || 0,
      manifestSha256: item.manifestSha256 || '',
      source: 'local',
    }))
  }

  const remoteSummary = async ({ probe }) => {
    const result = { probed: Boolean(probe), ok: false, count: 0, manifests: 0, packs: 0, bytes: 0, repoJson: false, error: null }
    if (!probe) return result
    try {
      const names = await listRemote()
      result.ok = true
      result.count = names.size
      result.repoJson = names.has('repo.json')
      for (const [name, size] of names) {
        result.bytes += Number(size) || 0
        if (name.startsWith('manifests/')) result.manifests += 1
        else if (name.startsWith('packs/')) result.packs += 1
      }
    } catch (error) {
      result.error = { code: (error && error.code) || 'probe-failed', message: sanitizeText(error && error.message) }
    }
    return result
  }

  const remoteArchives = async ({ knownNames }) => {
    if (!state.key) return []
    const names = await listRemote()
    const port = await resolveArchive()
    const out = []
    const known = new Set(knownNames)
    for (const name of names.keys()) {
      if (out.length >= REMOTE_MANIFEST_PROBE_LIMIT) break
      if (!name.startsWith('manifests/') || known.has(name)) continue
      try {
        const buf = await fetchRemoteFile(name, names.get(name))
        const decoded = await port.decodeManifest({ key: state.key, name, buf })
        const manifest = decoded.manifest || {}
        const snapshot = manifest.snapshot || {}
        out.push({
          snapshotId: String(snapshot.id || ''),
          manifestName: name,
          at: Number(snapshot.at) || 0,
          seq: Number(manifest.seq) || 0,
          files: Object.keys(snapshot.files || {}).length,
          bytes: Number((snapshot.stats && snapshot.stats.bytes) || 0),
          newChunks: 0,
          manifestSha256: decoded.sha256 || '',
          source: 'peer',
        })
      } catch { /* 单个清单解不开不影响列表 */ }
    }
    return out
  }

  const stateAsync = async ({ probe = false } = {}) => {
    await ensureInit()
    const stats = await repoStats().catch(() => null)
    const peer = peerSnapshot()
    const cacheExists = await exists(paths().keyCache).catch(() => false)
    state.hasCachedKeyFlag = cacheExists
    const archives = listArchives()
    const remote = await remoteSummary({ probe })
    let peerArchives = []
    if (probe && state.key && peer.online) {
      try {
        peerArchives = await remoteArchives({ knownNames: archives.map((item) => item.manifestName) })
      } catch { peerArchives = [] }
    }
    const all = [...archives, ...peerArchives].sort((a, b) => (a.at || 0) - (b.at || 0)).reverse().slice(0, 80)
    const schedule = parseSchedule(state.config.schedule)
    return {
      ok: true,
      available: true,
      version: OFFSITE_VERSION,
      enabled: Boolean(state.config.enabled),
      initialized: Boolean(state.repoInitialized),
      configured: Boolean(state.repoInitialized),
      // 换机恢复：本地没有仓库头但子机上有 → 输密码即可引导解锁
      bootstrapAvailable: !state.repoInitialized && Boolean(remote.ok && remote.repoJson),
      dir: paths().root,
      repoDir: paths().repo,
      locked: !state.key,
      keySource: state.keySource,
      unlockedAt: state.unlockedAt || null,
      hasCachedKey: cacheExists,
      cacheEnabled: Boolean(state.config.cacheKey),
      repo: stats,
      peer,
      // 多子机列表（在线优先、名称排序，selected 标出当前备份目标）——
      // UI 的「备份到 [设备选择]」直接用这个列表；与 peer.id 永远一致。
      peers: Array.isArray(peer.peers) ? peer.peers : [],
      remote,
      archives: all,
      progress: { ...state.progress },
      busy: state.busy,
      lastExportAt: state.ledger.lastExportAt || null,
      lastSyncAt: state.ledger.lastSyncAt || null,
      lastDrillAt: state.ledger.lastDrillAt || null,
      lastPruneAt: state.ledger.lastPruneAt || null,
      lastDrill: state.ledger.lastDrill || null,
      lastError: state.lastError || state.ledger.lastError || null,
      chain: { seq: Number(state.ledger.seq) || 0, prevManifest: state.ledger.prevManifest || null },
      schedule: {
        at: schedule ? schedule.text : '',
        weeklyDrill: Boolean(state.config.weeklyDrill),
        taskName: 'dsh-disaster-recovery-offsite',
        command: schedule ? taskCommand() : null,
      },
      config: {
        enabled: Boolean(state.config.enabled),
        dir: state.config.dir || '',
        peerDeviceId: state.config.peerDeviceId || '',
        retainDaily: Number(state.config.retainDaily) || OFFSITE_DEFAULTS.retainDaily,
        retainWeekly: Number(state.config.retainWeekly) || 0,
        quotaBytes: Number(state.config.quotaBytes) || OFFSITE_DEFAULTS.quotaBytes,
        schedule: state.config.schedule || '',
        weeklyDrill: Boolean(state.config.weeklyDrill),
        cacheKey: Boolean(state.config.cacheKey),
      },
    }
  }

  /** 同步版摘要：给 GET / 旧 action 的 state 用（不扫盘、不发 RPC）。 */
  const summary = () => {
    const stats = state.cachedRepoStats
    // 首次 GET 时可能还没跑过 state()：这里补一次同步解析（只调 ctx.dshSync.peers()，不发 RPC），
    // 保证面板不需要先等 offsite-state 就能拿到 peers 列表。
    let peer = state.cachedPeer
    if (!peer) {
      try { peer = peerSnapshot() } catch { peer = null }
    }
    return {
      available: true,
      enabled: Boolean(state.config.enabled),
      initialized: Boolean(state.repoInitialized),
      locked: !state.key,
      hasCachedKey: Boolean(state.hasCachedKeyFlag),
      cacheEnabled: Boolean(state.config.cacheKey),
      dir: (() => { try { return paths().root } catch { return null } })(),
      repo: stats ? { chunks: stats.chunks, manifests: stats.manifests, packs: stats.packs, bytes: stats.bytes, quotaBytes: stats.quotaBytes } : null,
      archives: Array.isArray(state.ledger.archives) ? state.ledger.archives.length : 0,
      peer: peer ? {
        sync: peer.sync,
        online: peer.online,
        paired: peer.paired,
        reason: peer.reason,
        name: peer.name,
        id: peer.id,
        configured: peer.configured,
        requested: peer.requested,
        configValid: peer.configValid,
        source: peer.source,
      } : null,
      peers: peer && Array.isArray(peer.peers) ? peer.peers : [],
      busy: state.busy,
      progress: { ...state.progress },
      lastError: state.lastError || state.ledger.lastError || null,
      lastExportAt: state.ledger.lastExportAt || null,
      lastSyncAt: state.ledger.lastSyncAt || null,
      lastDrillAt: state.ledger.lastDrillAt || null,
      config: {
        enabled: Boolean(state.config.enabled),
        schedule: state.config.schedule || '',
        weeklyDrill: Boolean(state.config.weeklyDrill),
        retainDaily: Number(state.config.retainDaily) || 0,
        retainWeekly: Number(state.config.retainWeekly) || 0,
        quotaBytes: Number(state.config.quotaBytes) || 0,
        peerDeviceId: state.config.peerDeviceId || '',
      },
    }
  }

  /* ------------------------------------------------------------ 定时任务 */

  const scheduledTick = async () => {
    await ensureInit()
    if (!state.config.enabled || state.busy || !state.repoInitialized) return { skipped: 'disabled' }
    if (!state.key) {
      try { await unlockFromCache() } catch { return { skipped: 'locked' } }
    }
    const current = now()
    const parsed = parseSchedule(state.config.schedule)
    if (parsed) {
      const due = scheduleDueAt(current, parsed)
      const last = Number(state.ledger.lastExportAt) || 0
      if (due && last < due) {
        log('scheduled export due')
        try {
          const result = await exportNow({})
          return { exported: result }
        } catch (error) {
          return { exportError: { code: (error && error.code) || 'export-failed', message: sanitizeText(error && error.message) } }
        }
      }
    }
    if (state.config.weeklyDrill) {
      const last = Number(state.ledger.lastDrillAt) || 0
      if (current - last > 7 * 86400_000) {
        log('scheduled weekly drill due')
        try {
          const result = await drill({})
          return { drilled: result }
        } catch (error) {
          return { drillError: { code: (error && error.code) || 'drill-failed', message: sanitizeText(error && error.message) } }
        }
      }
    }
    return { skipped: 'not-due' }
  }

  const startScheduler = ({ intervalMs = 10 * 60_000, initialDelayMs = 120_000 } = {}) => {
    if (state.schedulerTimer) return () => {}
    const tick = () => {
      scheduledTick().catch((error) => log(`scheduler tick failed: ${(error && error.message) || error}`))
    }
    const first = setTimeout(tick, Math.max(10_000, initialDelayMs))
    if (first.unref) first.unref()
    state.schedulerTimer = setInterval(tick, Math.max(60_000, intervalMs))
    if (state.schedulerTimer.unref) state.schedulerTimer.unref()
    return () => {
      clearTimeout(first)
      if (state.schedulerTimer) clearInterval(state.schedulerTimer)
      state.schedulerTimer = null
    }
  }

  const dispose = async () => {
    if (state.schedulerTimer) clearInterval(state.schedulerTimer)
    state.schedulerTimer = null
    await lock().catch(() => {})
  }

  /* ------------------------------------------------------------ 对外 API */

  const api = {
    /* 生命周期 */
    init,
    dispose,
    startScheduler,
    scheduledTick,
    /* 配置 */
    updateConfig,
    get config() { return { ...state.config } },
    /* 密钥 */
    initRepo,
    unlock,
    unlockFromCache,
    lock,
    clearKey,
    /* 编排 */
    exportNow,
    syncToPeer,
    fetchMissingFromPeer,
    restore,
    drill,
    pruneRemote,
    /* 状态 */
    state: stateAsync,
    summary,
    /* 工具（面板/CLI 复用） */
    taskCommand,
    peerSnapshot,
    pinnedSnapshotIds,
    repoStats,
    /* 测试/调试用的内部视图（不含密钥） */
    get paths() { return paths() },
    get busy() { return state.busy },
    get progress() { return { ...state.progress } },
    get locked() { return !state.key },
    get ledger() { return JSON.parse(JSON.stringify(state.ledger)) },
  }

  return api
}

/* --------------------------------------------------------------- 无头导出 */

/**
 * 无人值守导出入口（计划任务 / 脚本调用）。
 *
 * 注意边界：dsh-sync 的 `ctx.dshSync` 只在运行中的 DSH 进程里存在，**独立 node 进程拿不到**。
 * 所以这个入口默认只做「用 DPAPI 缓存解锁 → 导出到本地仓库」；如果调用方显式注入了
 * `getSync`（例如测试或未来的独立传输客户端），才会顺带同步到子机。
 * 「每日导出 + 同步子机」的无人值守由插件进程内调度负责（DSH 运行中，每 10 分钟检查），
 * 计划任务在这里只是「DSH 没跑时的本地兜底导出」。
 */
export async function runHeadlessExport({
  home, root, hostname, dir, logger = noopLogger, getSync, dpapi, archive, now,
} = {}) {
  const log = (message) => { try { logger(`[offsite-headless] ${message}`) } catch { /* ignore */ } }
  const { BackupEngine } = await import('./engine.js')
  const engine = new BackupEngine({
    home,
    config: { root, enabled: false, watch: false, paused: true, scanMs: 86_400_000, debounceMs: 0, minIntervalMs: 0 },
    snapshotOnStart: false,
    hostname,
    log: () => {},
  })
  await engine.start()
  const service = createOffsiteService({
    engine,
    dir,
    getSync: getSync || (() => undefined),
    dpapi,
    archive,
    now,
    logger: log,
  })
  try {
    await service.init()
    if (!service.config.enabled) return { ok: true, skipped: 'disabled' }
    if (!(await service.state()).initialized) throw offlineError('not-initialized', '异地副本仓库尚未初始化')
    const unlocked = await service.unlockFromCache().catch((error) => {
      throw offlineError((error && error.code) || 'locked', '没有可用的 DPAPI 密钥缓存：请先在面板里解锁一次，或手动导出')
    })
    if (!unlocked || !unlocked.ok) throw offlineError('locked', '无法用 DPAPI 缓存解锁')
    return await service.exportNow({})
  } finally {
    await engine.stop().catch(() => {})
  }
}
