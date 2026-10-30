/**
 * 备份引擎：扫描 → 分块内容寻址 → 写清单；文件变化时 debounce 触发。
 *
 * 设计要点：
 *   - 快照“便宜”：每次只做 stat 遍历，内容没变的文件沿用上次的块列表；
 *   - 大文件分块（默认 64 KiB）寻址：会话日志是追加写的，追加只会产生新的尾块，
 *     所以每次快照只新增“增长的尾巴”，不会把整份日志再存一遍；
 *   - 清单是权威：恢复只按清单走，绝不按“目录里有什么”猜；
 *   - 恢复不删任何东西：被覆盖的文件先复制到 restore-quarantine，当前快照里
 *     不存在的文件原地保留，只在报告里计数。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BlobStore } from './store.js'
import {
  entryChunks, formatBytes, joinInside, makeSnapshotId, readJsonSafe, sha256hex, toRelative,
  walkFiles, writeFileAtomic, writeJsonAtomic,
} from './util.js'

export const CONFIG_DEFAULTS = {
  root: 'D:\\dsh-backup',
  enabled: true,
  watch: true,
  paused: false,
  debounceMs: 10000,
  minIntervalMs: 60000,
  scanMs: 600000,
  maxFileBytes: 128 * 1024 * 1024,
  chunkSize: 64 * 1024,
  keepLast: 60,
  keepHourlyHours: 48,
  keepDailyDays: 30,
  // 硬上限：无论分层保留怎么算，快照总数超过它就从最旧的开始删。
  // 1 分钟一个快照的节奏下，100 个 ≈ 最近 100 分钟全量可回滚。
  maxSnapshots: 100,
  excludes: ['dsh-runtimes'],
}

const MUTABLE_KEYS = [
  'enabled', 'watch', 'paused', 'debounceMs', 'minIntervalMs', 'scanMs',
  'maxFileBytes', 'chunkSize', 'keepLast', 'keepHourlyHours', 'keepDailyDays',
  'maxSnapshots', 'excludes',
]

/** 改变保留策略的键：改完立即按新规则清理一次（否则要等下个快照才生效）。 */
const RETENTION_KEYS = ['keepLast', 'keepHourlyHours', 'keepDailyDays', 'maxSnapshots']

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  // 等待不该阻止进程退出（CLI / 测试 stop 后不拖尾）
  if (timer.unref) timer.unref()
})

/** state.snapshots 上限（契约 v0.3.0：从 50 提到 300）。 */
const SNAPSHOTS_LIMIT = 300
/** state.quarantines 上限（最近 20 条，时间倒序）。 */
const QUARANTINES_LIMIT = 20
/** blob 统计默认缓存时长：面板轮询期间不得重复扫盘。 */
const BLOB_STATS_DEFAULT_MAX_AGE_MS = 30_000

/**
 * updateConfig 的数值夹取范围。面板传什么都不能把引擎调成“扫盘风暴”或“永不保留”。
 * 未列出的数值键（目前没有）不做夹取。
 */
const NUMERIC_LIMITS = {
  debounceMs: { min: 0, max: 600_000 },
  minIntervalMs: { min: 10_000, max: 86_400_000 },
  scanMs: { min: 60_000, max: 86_400_000 },
  maxFileBytes: { min: 1024, max: 10 * 1024 * 1024 * 1024 },
  chunkSize: { min: 1024, max: 16 * 1024 * 1024 },
  keepLast: { min: 1, max: 10_000 },
  keepHourlyHours: { min: 0, max: 24 * 365 * 5 },
  keepDailyDays: { min: 0, max: 3650 },
  // 至少留 5 个，避免把保留数误设成 1~2 把回滚余地删光。
  maxSnapshots: { min: 5, max: 10_000 },
}

/**
 * 归一化单个可变配置项：返回 undefined 表示“忽略这个键，不应用”。
 * 数值夹取、布尔只收布尔、excludes 只收字符串数组（trim/去空/去重/上限 100）。
 */
function normalizeConfigValue(key, raw) {
  const limit = NUMERIC_LIMITS[key]
  if (limit) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
    return Math.min(limit.max, Math.max(limit.min, Math.round(raw)))
  }
  if (key === 'enabled' || key === 'watch' || key === 'paused') {
    return typeof raw === 'boolean' ? raw : undefined
  }
  if (key === 'excludes') {
    if (!Array.isArray(raw)) return undefined
    const values = []
    for (const item of raw) {
      if (typeof item !== 'string') continue
      const value = item.trim()
      if (!value || values.includes(value)) continue
      values.push(value)
      if (values.length >= 100) break
    }
    return values
  }
  return undefined
}

/** 插件版本：state.version（只读 package.json，不改它）。 */
function readPluginVersion() {
  try {
    const parsed = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function sanitizeHostTag(name) {
  return String(name || 'host').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'host'
}

/** 兼容老清单：新条目是 `{s,m,c:[hash…]}`，老条目是 `{s,m,h}`。 */
export { entryChunks }

export class BackupEngine {
  constructor({
    home, config = {}, log = () => {}, hostname = os.hostname(), snapshotOnStart = true,
    version = readPluginVersion(),
  }) {
    this.home = path.resolve(home)
    this.config = { ...CONFIG_DEFAULTS, ...(config || {}) }
    this.log = log
    this.hostname = hostname
    this.snapshotOnStart = snapshotOnStart !== false
    this.version = String(version || '0.0.0')
    this.store = null
    this.snapshots = []
    this.lastManifest = null
    this.startedAt = 0
    this.busy = false
    this.paused = Boolean(this.config.paused)
    this.lastError = null
    this.watching = false
    this.watcher = null
    this.timer = null
    this.scanTimer = null
    this.pendingAgain = false
    this.lastRunAt = 0
    this.lastCycle = null
    this.cyclePending = false
    this.stopped = false
    this.lastRestore = null
    this._blobStats = null
    this._blobStatsPromise = null
    this._quarantines = []
    this._quarantinesAt = 0
    // 正在被异地导出/上传的快照 id：prune 永不删（含其内容块），deleteSnapshot 拒绝。
    // 只是内存态：进程重启后自然清空（重启时导出不可能还在跑）。
    this.pinnedSnapshotIds = new Set()
    // 最近用过的快照 id（含刚被 prune 掉的）：同一秒内快照 id 只有秒级精度，
    // 若只查 this.snapshots + 磁盘，激进保留策略下可能复用刚被删掉的 id，
    // 导致同一 id 对应两份不同内容（异地导出会用后者覆盖同名清单）。
    this.recentSnapshotIds = new Set()
    this.recentSnapshotIdOrder = []
    // “写清单 + prune”串行链：并发 snapshot/delete 交错会误删别人刚写入的 blob
    this.writeChain = Promise.resolve()
  }

  /* --------------------------------------------------------------- 生命周期 */

  get storeDir() {
    return path.join(path.resolve(this.config.root), sanitizeHostTag(this.hostname))
  }

  async start() {
    this.stopped = false
    this.startedAt = Date.now()
    this.store = new BlobStore(this.storeDir)
    await this.store.init()

    // 运行期配置（面板改的）写在本机目录里，覆盖 patch 默认值。
    // 旧版本可能写进过越界值，读回时同样按新规则归一化，避免“历史脏配置”破坏节流。
    const saved = await readJsonSafe(path.join(this.store.dir, 'config.json'), null)
    if (saved && typeof saved === 'object') {
      for (const key of MUTABLE_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(saved, key)) continue
        const value = normalizeConfigValue(key, saved[key])
        if (value !== undefined) this.config[key] = value
      }
    }
    this.paused = Boolean(this.config.paused)

    const manifests = await this.store.listManifests()
    this.snapshots = manifests
    this.lastManifest = manifests[0] || null
    for (const manifest of manifests) this.rememberSnapshotId(manifest.id)

    if (this.config.enabled && this.snapshotOnStart) {
      await this.snapshot('startup').catch((error) => {
        this.lastError = `startup snapshot: ${String((error && error.message) || error)}`
        this.log(this.lastError)
      })
    }
    if (this.config.watch) this.startWatcher()
    this.startScanTimer()
    // 调度已就绪：健康检查用它判断“调度是否还活着”（之后每个周期由 runCycle 更新）
    this.lastRunAt = Date.now()
    await this.refreshQuarantines({ maxAgeMs: 0 }).catch(() => {})
    this.log(`engine ready: home=${this.home} store=${this.store.dir} snapshots=${this.snapshots.length}`)
  }

  async stop() {
    this.stopped = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null }
    this.stopWatcher()
  }

  stopWatcher() {
    if (this.watcher) {
      try { this.watcher.close() } catch { /* ignore */ }
      this.watcher = null
    }
    this.watching = false
  }

  startWatcher() {
    if (this.watcher) return
    try {
      this.watcher = fs.watch(this.home, { recursive: true }, (_event, filename) => {
        if (filename && this.isInsideStore(filename)) return
        this.pendingAgain = true
        this.schedule()
      })
      this.watcher.on('error', (error) => {
        this.watching = false
        this.lastError = `watch: ${String((error && error.message) || error)}`
        this.log(this.lastError)
      })
      this.watching = true
    } catch (error) {
      this.watching = false
      this.lastError = `watch unavailable: ${String((error && error.message) || error)}`
      this.log(this.lastError)
    }
  }

  startScanTimer() {
    if (this.scanTimer) clearInterval(this.scanTimer)
    const every = Math.max(60_000, Number(this.config.scanMs) || 600_000)
    this.scanTimer = setInterval(() => {
      this.pendingAgain = true
      this.schedule()
    }, every)
    if (this.scanTimer.unref) this.scanTimer.unref()
  }

  isInsideStore(filename) {
    const abs = path.resolve(this.home, String(filename))
    const storeDir = path.resolve(this.storeDir)
    return abs === storeDir || abs.startsWith(storeDir + path.sep)
  }

  /** 若用户把备份根目录放进了 home，排除它，避免自我备份。 */
  effectiveExcludes() {
    const excludes = new Set((this.config.excludes || []).map(String))
    const rel = toRelative(this.home, path.resolve(this.config.root))
    if (rel) excludes.add(rel)
    const relStore = toRelative(this.home, path.resolve(this.storeDir))
    if (relStore) excludes.add(relStore)
    return [...excludes]
  }

  /* ----------------------------------------------------------------- 调度 */

  schedule() {
    if (this.stopped || !this.config.enabled || this.paused || this.busy) return
    if (this.timer) return
    const debounce = Math.max(0, Number(this.config.debounceMs) || 0)
    this.timer = setTimeout(() => {
      this.timer = null
      this.runCycle().catch((error) => {
        this.lastError = String((error && error.message) || error)
        this.log(this.lastError)
      })
    }, debounce)
    if (this.timer.unref) this.timer.unref()
  }

  /**
   * 跑一轮快照。minIntervalMs 的等待期间**不占用 busy**：否则面板会整段
   * “正在备份/恢复”而把所有按钮锁住（恢复/体检都被 500 拒绝）。
   * cyclePending 保证等待期间不会被重复调度出第二个 runCycle。
   */
  async runCycle() {
    if (this.busy || this.cyclePending) { this.pendingAgain = true; return }
    this.cyclePending = true
    let ran = false
    try {
      const minInterval = Math.max(0, Number(this.config.minIntervalMs) || 0)
      const wait = this.lastRunAt + minInterval - Date.now()
      if (wait > 0) await sleep(wait)
      if (this.stopped) return
      if (this.busy) { this.pendingAgain = true; return }
      this.pendingAgain = false
      this.busy = true
      ran = true
      try {
        const result = await this.snapshot('change')
        this.lastCycle = { at: Date.now(), ...result }
      } finally {
        this.busy = false
      }
    } finally {
      this.cyclePending = false
      if (ran) this.lastRunAt = Date.now()
      if (this.pendingAgain) { this.pendingAgain = false; this.schedule() }
    }
  }

  /* ----------------------------------------------------------------- 快照 */

  chunkSize() {
    return Math.max(1024, Number(this.config.chunkSize) || 65536)
  }

  /** 把内容切成块存进 blob store，返回块哈希列表。 */
  async storeChunks(buf) {
    const size = this.chunkSize()
    const chunks = []
    for (let offset = 0; offset < buf.length; offset += size) {
      const piece = buf.subarray(offset, Math.min(offset + size, buf.length))
      chunks.push(await this.store.put(piece))
    }
    return chunks
  }

  /** 一轮快照成功（含“无变化”跳过）：清掉瞬时错误（watch error 下一轮自愈）。 */
  noteSnapshotSuccess() {
    this.lastError = null
  }

  /**
   * 串行化“写 blob → 写清单 → prune”相关操作。
   * 并发快照时，先完成者的 prune 依据的是当时的 this.snapshots；后完成者的
   * 独有块可能已经写入但清单还没落盘，会被先完成者当成孤儿删掉 → 之后恢复报缺块。
   * 用 promise 链把整个 snapshot 体串起来（reject 也不会污染后续链）。
   */
  withManifestLock(fn) {
    const next = this.writeChain.then(fn, fn)
    this.writeChain = next.then(() => {}, () => {})
    return next
  }

  async snapshot(reason = 'auto') {
    if (!this.store) throw new Error('engine not started')
    if (!this.config.enabled) return { skipped: true, reason: 'disabled' }
    if (this.paused) return { skipped: true, reason: 'paused' }
    // 整个快照体（含 blob 写入与 prune）串行：并发 snapshot/delete 不得交错
    return this.withManifestLock(() => this.snapshotLocked(reason))
  }

  async snapshotLocked(reason) {
    const startedAt = Date.now()
    const { files, skipped } = await walkFiles(this.home, {
      excludes: this.effectiveExcludes(),
      maxFileBytes: Number(this.config.maxFileBytes) || Infinity,
    })
    const prevFiles = (this.lastManifest && this.lastManifest.files) || {}
    const nextFiles = {}
    const errors = []
    let stored = 0
    let changed = 0
    let bytes = 0

    for (const file of files) {
      const prev = prevFiles[file.rel]
      if (prev && prev.s === file.size && prev.m === file.mtimeMs && entryChunks(prev).length >= 0) {
        nextFiles[file.rel] = prev
        continue
      }
      let buf
      try {
        buf = await fsp.readFile(file.abs)
      } catch (error) {
        errors.push({ rel: file.rel, error: String((error && error.message) || error) })
        continue
      }
      const before = this.store.known.size
      const chunks = await this.storeChunks(buf)
      stored += Math.max(0, this.store.known.size - before)
      nextFiles[file.rel] = { s: buf.length, m: file.mtimeMs, c: chunks }
      changed += 1
      bytes += buf.length
    }

    const identical = sameFileMap(prevFiles, nextFiles)
    if (identical && errors.length === 0) {
      this.noteSnapshotSuccess()
      return { skipped: true, reason: 'unchanged', files: Object.keys(nextFiles).length, durationMs: Date.now() - startedAt }
    }

    const id = await this.uniqueId(reason)
    const manifest = {
      version: 2,
      id,
      at: Date.now(),
      reason,
      host: path.basename(this.store.dir),
      home: this.home,
      chunkSize: this.chunkSize(),
      files: nextFiles,
      skipped,
      errors,
      stats: { files: Object.keys(nextFiles).length, changed, stored, bytes, durationMs: Date.now() - startedAt },
    }
    await this.store.writeManifest(manifest)
    this.rememberSnapshotId(id)
    this.lastManifest = manifest
    this.snapshots = [manifest, ...this.snapshots.filter((s) => s.id !== id)]
    this.snapshots.sort((a, b) => (b.at || 0) - (a.at || 0))
    const pruned = await this.prune()
    this.noteSnapshotSuccess()
    this.log(`snapshot ${id}: files=${manifest.stats.files} changed=${changed} new-chunks=${stored} ` +
      `(${formatBytes(bytes)}) pruned=${pruned.removed}`)
    return { id, at: manifest.at, files: manifest.stats.files, changed, stored, bytes, durationMs: manifest.stats.durationMs, pruned }
  }

  /**
   * 快照 id 唯一化。除了当前快照列表与磁盘清单，还要避开 recentSnapshotIds
   * （刚被 prune 掉的旧 id）——否则 keepLast 很小时同一秒内会复用 id，异地导出
   * 会用新内容覆盖同名清单，旧档案就不见了。
   */
  async uniqueId(reason) {
    const base = makeSnapshotId(new Date(), reason)
    let candidate = base
    let n = 2
    for (;;) {
      if (this.snapshots.some((s) => s.id === candidate) || this.isRecentSnapshotId(candidate)) {
        candidate = `${base}-${n++}`
        continue
      }
      try {
        await this.store.readManifest(candidate)
        candidate = `${base}-${n++}`
      } catch {
        return candidate
      }
    }
  }

  /* ------------------------------------------------------------- 导出保护 */

  /**
   * pin 一个快照：导出/上传期间 prune 不得删除该快照及其内容块，deleteSnapshot 也会拒绝。
   * 幂等；返回当前被 pin 的快照数。
   */
  pinSnapshot(id) {
    const value = String(id == null ? '' : id).trim()
    if (!value) throw new Error('缺少快照 id')
    this.pinnedSnapshotIds.add(value)
    return this.pinnedSnapshotIds.size
  }

  /** 释放 pin（导出 finally 里必须调用）；返回剩余被 pin 的快照数。 */
  unpinSnapshot(id) {
    const value = String(id == null ? '' : id).trim()
    if (value) this.pinnedSnapshotIds.delete(value)
    return this.pinnedSnapshotIds.size
  }

  isSnapshotPinned(id) {
    return this.pinnedSnapshotIds.has(String(id == null ? '' : id))
  }

  listPinnedSnapshots() {
    return [...this.pinnedSnapshotIds]
  }

  /**
   * 记住一个用过的快照 id（包括刚被 prune 掉、以及从磁盘恢复出来的）。
   * 快照 id 只精确到秒，若同一秒内被 prune 后再拍快照，只看 this.snapshots + 磁盘
   * 会复用旧 id；这里保留最近一批 id 供 uniqueId 避让。
   */
  rememberSnapshotId(id) {
    const value = String(id == null ? '' : id)
    if (!value || this.recentSnapshotIds.has(value)) return
    this.recentSnapshotIds.add(value)
    this.recentSnapshotIdOrder.push(value)
    // 上限：长跑进程也不能让这个集合无限增长（超出后只保留仍在快照列表/被 pin 的 id）
    while (this.recentSnapshotIdOrder.length > 2000) {
      const old = this.recentSnapshotIdOrder.shift()
      if (!old) continue
      const stillUsed = this.snapshots.some((snapshot) => snapshot.id === old)
        || this.pinnedSnapshotIds.has(old)
      if (!stillUsed) this.recentSnapshotIds.delete(old)
    }
  }

  /** 该 id 是否最近用过（uniqueId 用；测试也可直接查）。 */
  isRecentSnapshotId(id) {
    return this.recentSnapshotIds.has(String(id == null ? '' : id))
  }

  /**
   * 恢复流程用：把解密出的清单注册进引擎。
   *   - 原子写 store/snapshots/<id>.json（重启后仍在）；
   *   - 加入 this.snapshots（按 at 倒序去重）并更新 lastManifest；
   *   - 绝不触发 prune（否则刚导入的块/清单可能被当成孤儿清掉），也不拍新快照。
   * 与 snapshot/delete 共用写链，避免与并发 prune 交错。
   */
  async importSnapshot(manifest) {
    if (!this.store) throw new Error('engine not started')
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('清单必须是对象')
    const id = String(manifest.id || '')
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,120}$/.test(id)) throw new Error(`bad snapshot id: ${id}`)
    if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
      throw new Error('清单缺少 files 映射')
    }
    const entry = { ...manifest, id, at: Number(manifest.at) || Date.now() }
    return this.withManifestLock(async () => {
      await this.store.writeManifest(entry)
      this.rememberSnapshotId(id)
      this.snapshots = [entry, ...this.snapshots.filter((snapshot) => snapshot.id !== id)]
        .sort((a, b) => (b.at || 0) - (a.at || 0))
      this.lastManifest = this.snapshots[0] || null
      return entry
    })
  }

  /* ----------------------------------------------------------------- 保留 */

  async prune() {
    const list = [...this.snapshots].sort((a, b) => (b.at || 0) - (a.at || 0))
    const keep = new Set()
    const pinned = this.pinnedSnapshotIds instanceof Set ? this.pinnedSnapshotIds : new Set()
    const maxSnapshots = Math.max(5, Number(this.config.maxSnapshots) || 100)
    // keepLast 是“最近 N 个”的软下限，但不能超过硬上限
    const keepLast = Math.min(maxSnapshots, Math.max(1, Number(this.config.keepLast) || 60))
    const hourlyHours = Math.max(0, Number(this.config.keepHourlyHours) || 0)
    const dailyDays = Math.max(0, Number(this.config.keepDailyDays) || 0)
    const now = Date.now()
    const hourSeen = new Set()
    const daySeen = new Set()

    list.forEach((snapshot, index) => {
      if (index < keepLast) { keep.add(snapshot.id); return }
      const age = now - (snapshot.at || 0)
      if (hourlyHours > 0 && age <= hourlyHours * 3600_000) {
        const key = hourKey(snapshot.at)
        if (!hourSeen.has(key)) { hourSeen.add(key); keep.add(snapshot.id); return }
      }
      if (dailyDays > 0 && age <= dailyDays * 86400_000) {
        const key = dayKey(snapshot.at)
        if (!daySeen.has(key)) { daySeen.add(key); keep.add(snapshot.id) }
      }
    })

    // 硬上限：分层规则再想留，也不能让总数超过 maxSnapshots。
    // list 已按时间倒序，保留最新的 maxSnapshots 个，其余（无论分层是否选中）删掉。
    const capKeep = new Set(list.slice(0, maxSnapshots).map((snapshot) => snapshot.id))

    // 正在导出的快照（pin）：绝对保护 —— 不受 keepLast/分层规则/硬上限约束，
    // 否则导出中途被 GC 掉的块会让异地副本缺块（验收 §5）。
    for (const id of pinned) {
      if (!list.some((snapshot) => snapshot.id === id)) continue
      keep.add(id)
      capKeep.add(id)
    }

    for (const id of [...keep]) {
      if (!capKeep.has(id)) keep.delete(id)
    }

    const dropped = list.filter((s) => !keep.has(s.id))
    for (const snapshot of dropped) {
      // 记住被删掉的 id：同一秒内再拍快照不能复用（否则导出会覆盖同名清单）
      this.rememberSnapshotId(snapshot.id)
      try { await this.store.deleteManifest(snapshot.id) } catch { /* ignore */ }
    }
    if (dropped.length) this.snapshots = list.filter((s) => keep.has(s.id))

    // 已被移出内存列表、但仍被 pin 的快照（例如进程内 pin 了旧快照）：
    // 从磁盘补读清单，只用来保住它引用的块，不把它重新塞回快照列表。
    const pinnedExtra = []
    for (const id of pinned) {
      if (list.some((snapshot) => snapshot.id === id)) continue
      try { pinnedExtra.push(await this.store.readManifest(id)) } catch { /* 不存在则忽略 */ }
    }

    const referenced = new Set()
    for (const snapshot of [...this.snapshots, ...pinnedExtra]) {
      for (const entry of Object.values(snapshot.files || {})) {
        for (const hash of entryChunks(entry)) referenced.add(hash)
      }
    }
    const gc = await this.store.gc(referenced)
    return { removed: dropped.length, blobsRemoved: gc.removed, bytesRemoved: gc.removedBytes }
  }

  /* ----------------------------------------------------------------- 恢复 */

  async readEntry(entry) {
    const chunks = entryChunks(entry)
    if (!chunks.length) return Buffer.alloc(0)
    const parts = []
    for (const hash of chunks) parts.push(await this.store.get(hash))
    return Buffer.concat(parts)
  }

  async restore(id, { skipPreBackup = false } = {}) {
    if (!this.store) throw new Error('engine not started')
    if (this.busy) throw new Error('正在备份/恢复，稍后再试')
    this.busy = true
    const startedAt = Date.now()
    try {
      const manifest = await this.store.readManifest(id)
      const verify = await this.store.verify(manifest)
      if (verify.missing.length) {
        throw new Error(`快照 ${id} 缺少 ${verify.missing.length} 个内容块，拒绝恢复`)
      }

      let preSnapshot = null
      if (!skipPreBackup) {
        const saved = this.paused
        this.paused = false
        try { preSnapshot = await this.snapshot('pre-restore') } finally { this.paused = saved }
      }

      const quarantineDir = path.join(this.store.dir, 'restore-quarantine', makeSnapshotId(new Date(), 'restore'))
      let restored = 0
      let unchanged = 0
      let quarantined = 0
      const failed = []

      for (const [rel, entry] of Object.entries(manifest.files || {})) {
        const abs = joinInside(this.home, rel)
        if (!abs || !entry) { failed.push({ rel, reason: 'bad-path-or-entry' }); continue }
        let stat = null
        try { stat = await fsp.stat(abs) } catch { stat = null }
        // 大小与 mtime 都一致 ⇒ 认为没动过（与扫描器的判据一致）
        if (stat && stat.size === entry.s && Math.round(stat.mtimeMs) === entry.m) { unchanged += 1; continue }
        if (stat && stat.isFile()) {
          const q = joinInside(quarantineDir, rel)
          if (q) {
            try {
              const current = await fsp.readFile(abs)
              await fsp.mkdir(path.dirname(q), { recursive: true })
              await fsp.writeFile(q, current)
              quarantined += 1
            } catch (error) {
              failed.push({ rel, reason: `quarantine: ${String((error && error.message) || error)}` })
            }
          }
        }
        try {
          const buf = await this.readEntry(entry)
          await writeFileAtomic(abs, buf)
          restored += 1
        } catch (error) {
          failed.push({ rel, reason: String((error && error.message) || error) })
        }
      }

      // 当前存在、快照里没有的文件：保留不动，只计数
      const now = await walkFiles(this.home, {
        excludes: this.effectiveExcludes(),
        maxFileBytes: Number(this.config.maxFileBytes) || Infinity,
      })
      const known = new Set(Object.keys(manifest.files || {}))
      const extraLeft = now.files.filter((f) => !known.has(f.rel))

      await writeJsonAtomic(path.join(quarantineDir, '_restore-report.json'), {
        at: Date.now(), snapshot: id, preSnapshot: preSnapshot && preSnapshot.id,
        restored, unchanged, quarantined, extraLeft: extraLeft.length, failed,
      }).catch(() => {})

      const finishedAt = Date.now()
      const result = {
        ok: true,
        snapshot: id,
        preSnapshot: preSnapshot && preSnapshot.id,
        restored,
        unchanged,
        quarantined,
        extraLeft: extraLeft.length,
        extraSample: extraLeft.slice(0, 10).map((f) => f.rel),
        failed,
        quarantineDir,
        needRestart: true,
        durationMs: finishedAt - startedAt,
      }
      // 内存摘要（state.lastRestore）：重启后清空，不落盘。
      // 字段与契约严格一致；额外信息（quarantineDir 等）留在 result 里。
      this.lastRestore = {
        at: finishedAt,
        restored,
        unchanged,
        quarantined,
        extraLeft: result.extraLeft,
        failed: failed.length,
        snapshot: id,
        preSnapshot: result.preSnapshot,
      }
      await this.refreshQuarantines({ maxAgeMs: 0 }).catch(() => {})
      return result
    } finally {
      this.busy = false
    }
  }

  /**
   * 体检：只读校验清单引用的内容块是否都在。默认校验 latestSnapshotId()
   * （跳过 pre-restore —— 那是恢复前的“事故现场”，不能当作健康基线）。
   * 不写盘、不改 lastManifest。
   */
  async verifySnapshot(id) {
    if (!this.store) throw new Error('engine not started')
    const targetId = id == null || id === '' ? this.latestSnapshotId() : String(id)
    if (!targetId) throw new Error('没有可校验的快照')
    const manifest = await this.readManifestForRead(targetId)
    const result = await this.store.verify(manifest)
    const missing = result.missing || []
    return {
      id: manifest.id,
      at: manifest.at,
      files: result.files,
      ok: missing.length === 0,
      missingCount: missing.length,
      missing: missing.slice(0, 50),
      checkedAt: Date.now(),
    }
  }

  /**
   * 恢复预演：只 stat 当前 home，不读文件内容、不写盘、不改 lastManifest。
   * 返回 { create, changed, unchanged, extra, bytes, sample }，口径与 restore() 一致。
   */
  async previewRestore(id) {
    if (!this.store) throw new Error('engine not started')
    const targetId = String(id == null ? '' : id)
    if (!targetId) throw new Error('缺少快照 id')
    const manifest = await this.readManifestForRead(targetId)
    const files = manifest.files || {}
    const known = new Set()
    let create = 0
    let changed = 0
    let unchanged = 0
    let bytes = 0
    const sample = []
    const addSample = (rel, kind) => {
      if (sample.length < 20 && !sample.some((item) => item.rel === rel)) sample.push({ rel, kind })
    }

    for (const [rel, entry] of Object.entries(files)) {
      if (!entry) continue
      known.add(rel)
      const abs = joinInside(this.home, rel)
      let stat = null
      if (abs) {
        try { stat = await fsp.stat(abs) } catch { stat = null }
      }
      if (!stat) {
        create += 1
        bytes += Number(entry.s) || 0
        addSample(rel, 'create')
        continue
      }
      if (!stat.isFile()) {
        // 路径被目录/链接占住了：restore 会覆盖失败，按“会变”计
        changed += 1
        bytes += Number(entry.s) || 0
        addSample(rel, 'change')
        continue
      }
      // 与 restore() 相同判据：size 与 mtimeMs 都一致 ⇒ 跳过
      if (stat.size === entry.s && Math.round(stat.mtimeMs) === entry.m) {
        unchanged += 1
        continue
      }
      changed += 1
      bytes += Number(entry.s) || 0
      addSample(rel, 'change')
    }

    // 当前有、快照没有的文件：恢复时保留不删（只计数）
    const now = await walkFiles(this.home, {
      excludes: this.effectiveExcludes(),
      maxFileBytes: Number(this.config.maxFileBytes) || Infinity,
    })
    const extra = now.files.filter((file) => !known.has(file.rel)).length

    return {
      id: manifest.id,
      at: manifest.at,
      reason: manifest.reason,
      files: Object.keys(files).length,
      create,
      changed,
      unchanged,
      extra,
      bytes,
      sample,
    }
  }

  /** 最近 20 条恢复隔离记录（扫描 storeDir/restore-quarantine 下的 _restore-report.json），时间倒序。 */
  async listQuarantines({ limit = QUARANTINES_LIMIT } = {}) {
    if (!this.store) return []
    const base = path.join(this.store.dir, 'restore-quarantine')
    let entries = []
    try { entries = await fsp.readdir(base, { withFileTypes: true }) } catch { return [] }
    const reports = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(base, entry.name)
      const report = await readJsonSafe(path.join(dir, '_restore-report.json'), null)
      if (!report || typeof report !== 'object') continue
      const toCount = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)
      reports.push({
        id: entry.name,
        at: Number(report.at) || 0,
        dir,
        restored: toCount(report.restored),
        unchanged: toCount(report.unchanged),
        quarantined: toCount(report.quarantined),
        extraLeft: toCount(report.extraLeft),
        failed: Array.isArray(report.failed) ? report.failed.length : toCount(report.failed),
        snapshot: typeof report.snapshot === 'string' ? report.snapshot : null,
      })
    }
    reports.sort((a, b) => (b.at - a.at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    return reports.slice(0, Math.max(0, Number(limit) || 0))
  }

  /**
   * 刷新 state.quarantines 的内存缓存（state() 是同步的，不在这里扫盘）。
   * 默认同样 30s TTL：面板每 5s 轮询时不必反复 readdir/读报告；
   * 恢复完成后调用方传 { maxAgeMs: 0 } 强制刷新。
   */
  async refreshQuarantines({ maxAgeMs = BLOB_STATS_DEFAULT_MAX_AGE_MS } = {}) {
    const maxAge = Math.max(0, Number(maxAgeMs) || 0)
    if (maxAge > 0 && this._quarantinesAt && Date.now() - this._quarantinesAt < maxAge) {
      return this._quarantines
    }
    const list = await this.listQuarantines()
    this._quarantines = list
    this._quarantinesAt = Date.now()
    return list
  }

  async readManifestForRead(id) {
    try {
      return await this.store.readManifest(id)
    } catch {
      throw new Error(`快照不存在或已损坏：${id}`)
    }
  }

  async deleteSnapshot(id) {
    if (this.busy) throw new Error('正在备份/恢复，稍后再试')
    const target = String(id == null ? '' : id)
    if (this.isSnapshotPinned(target)) {
      throw new Error(`快照 ${target} 正在导出（pinned），不能删除`)
    }
    // 与 snapshot 的“写清单 + prune”同链：避免删清单+GC 撞上进行中的快照
    return this.withManifestLock(async () => {
      await this.store.deleteManifest(target)
      this.snapshots = this.snapshots.filter((s) => s.id !== target)
      if (this.lastManifest && this.lastManifest.id === target) this.lastManifest = this.snapshots[0] || null
      return this.prune()
    })
  }

  /* ------------------------------------------------------------- 对外状态 */

  setPaused(value) {
    this.paused = Boolean(value)
    this.config.paused = this.paused
    this.persistConfig()
    if (!this.paused) this.schedule()
    return this.paused
  }

  /**
   * 更新可变配置：数值夹取、布尔只收布尔、excludes 只收字符串数组（清洗后上限 100），
   * 未知键/非法值忽略；校验后的值持久化（config.json 仍只写 MUTABLE_KEYS）。
   */
  async updateConfig(patch) {
    const source = patch && typeof patch === 'object' ? patch : {}
    const applied = {}
    for (const key of MUTABLE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue
      const value = normalizeConfigValue(key, source[key])
      if (value === undefined) continue
      this.config[key] = value
      applied[key] = value
    }
    this.paused = Boolean(this.config.paused)
    // watch 开关立即生效（否则 state.watching 会一直和配置矛盾）
    if (Object.prototype.hasOwnProperty.call(applied, 'watch')) {
      if (this.config.watch) this.startWatcher()
      else this.stopWatcher()
    }
    await this.persistConfig()
    // 保留策略刚改过：立即清一次，不用等下一次快照。
    if (RETENTION_KEYS.some((key) => Object.prototype.hasOwnProperty.call(applied, key)) && this.store) {
      try {
        await this.withManifestLock(() => this.prune())
      } catch { /* 清理失败不影响配置本身 */ }
    }
    return applied
  }

  async persistConfig() {
    const out = {}
    for (const key of MUTABLE_KEYS) out[key] = this.config[key]
    try { await writeJsonAtomic(path.join(this.store.dir, 'config.json'), out) } catch { /* ignore */ }
  }

  /**
   * 解析 "latest"：跳过 pre-restore —— 那是恢复前自动拍的“事故现场”，
   * 拿它当“最新”会把刚恢复好的东西又盖回去。
   */
  latestSnapshotId({ excludeReasons = ['pre-restore'] } = {}) {
    const skip = new Set(excludeReasons)
    const found = this.snapshots.find((snapshot) => !skip.has(snapshot.reason))
    return found ? found.id : null
  }

  summary(snapshot) {
    if (!snapshot) return null
    return {
      id: snapshot.id,
      at: snapshot.at,
      reason: snapshot.reason,
      files: (snapshot.stats && snapshot.stats.files) || Object.keys(snapshot.files || {}).length,
      bytes: (snapshot.stats && snapshot.stats.bytes) || 0,
      changed: (snapshot.stats && snapshot.stats.changed) || 0,
    }
  }

  /**
   * 服务端健康摘要（契约 v0.3.0）。优先级：
   * disabled → paused → last-error → watching-off → stale → healthy。
   *
   * stale 判“调度是否还活着”，而不是“最近快照有多旧”：空闲且无文件变化时
   * snapshot() 会走 skipped/unchanged，但每个 scanMs 周期仍会跑一次 runCycle，
   * 所以 lastRunAt 会持续更新，不会误报。阈值 = max(5min, 3*minIntervalMs, 2*scanMs)。
   * busy 不再算健康问题（state.busy 只给 UI 用）。
   */
  healthNow(now, lastSnapshotAgeMs) {
    const minInterval = Math.max(0, Number(this.config.minIntervalMs) || 0)
    const scanMs = Math.max(60_000, Number(this.config.scanMs) || 600_000)
    const staleAfterMs = Math.max(300_000, 3 * minInterval, 2 * scanMs)
    const base = { lastSnapshotAgeMs }
    if (!this.config.enabled) {
      return { level: 'off', code: 'disabled', message: '备份已禁用', ...base }
    }
    if (this.paused) {
      return { level: 'off', code: 'paused', message: '备份已暂停', ...base }
    }
    if (this.lastError) {
      return {
        level: 'error',
        code: 'last-error',
        message: `最近一次错误：${String(this.lastError).slice(0, 300)}`,
        ...base,
      }
    }
    if (!this.watching) {
      return { level: 'warn', code: 'watching-off', message: '文件监听未生效，按固定间隔扫描', ...base }
    }
    if (!this.lastManifest) {
      return { level: 'warn', code: 'stale', message: '尚无任何快照', ...base }
    }
    if (now - this.lastRunAt > staleAfterMs) {
      const minutes = Math.max(1, Math.round((now - this.lastRunAt) / 60_000))
      return { level: 'warn', code: 'stale', message: `备份调度已 ${minutes} 分钟未运行`, ...base }
    }
    return { level: 'ok', code: 'healthy', message: '运行正常', ...base }
  }

  /** 状态快照：同步、不扫盘（blob 统计与隔离记录都走缓存，由 refresh* 更新）。 */
  state() {
    const now = Date.now()
    const lastSnapshotAgeMs = this.lastManifest ? now - this.lastManifest.at : null
    const blob = this._blobStats
      ? { count: this._blobStats.count, bytes: this._blobStats.bytes, at: this._blobStats.at }
      : null
    return {
      ok: true,
      home: this.home,
      storeDir: this.store ? this.store.dir : null,
      root: path.resolve(this.config.root),
      enabled: Boolean(this.config.enabled),
      paused: this.paused,
      watching: this.watching,
      busy: this.busy,
      startedAt: this.startedAt,
      lastSnapshot: this.summary(this.lastManifest),
      lastSnapshotAgeMs,
      snapshots: this.snapshots.slice(0, SNAPSHOTS_LIMIT).map((s) => this.summary(s)),
      snapshotCount: this.snapshots.length,
      config: {
        debounceMs: this.config.debounceMs,
        minIntervalMs: this.config.minIntervalMs,
        scanMs: this.config.scanMs,
        maxFileBytes: this.config.maxFileBytes,
        chunkSize: this.config.chunkSize,
        keepLast: this.config.keepLast,
        keepHourlyHours: this.config.keepHourlyHours,
        keepDailyDays: this.config.keepDailyDays,
        maxSnapshots: this.config.maxSnapshots,
        excludes: this.config.excludes,
        root: path.resolve(this.config.root),
        enabled: Boolean(this.config.enabled),
        watch: Boolean(this.config.watch),
        paused: Boolean(this.config.paused),
      },
      lastCycle: this.lastCycle,
      lastError: this.lastError,
      blob,
      statsAgeMs: blob ? now - blob.at : null,
      health: this.healthNow(now, lastSnapshotAgeMs),
      quarantines: this._quarantines || [],
      lastRestore: this.lastRestore,
      // 正在被异地导出/上传的 pinned 快照（面板/CLI 可显示“导出中”，不影响旧字段语义）
      pinned: this.listPinnedSnapshots(),
      version: this.version,
    }
  }

  /**
   * 刷新 blob 统计（面板轮询不能每次扫盘）。默认 30s 内直接复用缓存：
   * 传 { maxAgeMs: 0 } 可强制刷新（备份/恢复/删除之后）。
   */
  async refreshBlobStats({ maxAgeMs = BLOB_STATS_DEFAULT_MAX_AGE_MS } = {}) {
    if (!this.store) return null
    const maxAge = Math.max(0, Number(maxAgeMs) || 0)
    const cached = this._blobStats
    if (cached && Date.now() - cached.at < maxAge) return cached
    if (this._blobStatsPromise) return this._blobStatsPromise
    this._blobStatsPromise = (async () => {
      try {
        const stats = await this.store.stats()
        this._blobStats = { count: stats.count, bytes: stats.bytes, at: Date.now() }
        return this._blobStats
      } finally {
        this._blobStatsPromise = null
      }
    })()
    return this._blobStatsPromise
  }
}

function sameFileMap(a, b) {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of bKeys) {
    const left = a[key]
    const right = b[key]
    if (!left || !right) return false
    if (left.s !== right.s || left.m !== right.m) return false
    const leftChunks = entryChunks(left)
    const rightChunks = entryChunks(right)
    if (leftChunks.length !== rightChunks.length) return false
    for (let i = 0; i < leftChunks.length; i += 1) if (leftChunks[i] !== rightChunks[i]) return false
  }
  return true
}

function hourKey(ms) {
  const d = new Date(ms || 0)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`
}

function dayKey(ms) {
  const d = new Date(ms || 0)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}
