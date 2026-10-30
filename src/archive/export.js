/**
 * 导出快照到本地加密仓库 + ledger 哈希链（docs/OFFSITE-ARCHIVE.md §4「导出」）。
 *
 * 流程（exportSnapshot）：
 *   1. engine.pinSnapshot(id) —— pin 期间 prune / 新快照都不会删掉该快照及其内容块；
 *   2. 逐块 engine.store.get(hash) → 校验 sha256 === hash → 仓库已有则跳过（去重）否则加密落盘；
 *   3. 写清单：plaintext = {version, snapshot, exportedAt, prevManifest, seq}，
 *      seq 从 ledger 读（`<repoDir>/../ledger.json`），prevManifest = 上一份清单名 ⇒ 哈希链；
 *   4. 更新 ledger（原子写）并释放 pin（finally 保证异常也 unpin）。
 *
 * 幂等：同一快照重导出不会新增链节点（seq/prevManifest 沿用 tip 节点），新增块数恒为 0。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_CHUNK_SIZE, isPlainHash, repoError } from './format.js'
import { ensureRecoveryKit } from './recovery.js'
import { entryChunks, sha256hex, writeJsonAtomic } from '../util.js'

export const LEDGER_FORMAT = 'dsh-dr-ledger'
export const LEDGER_VERSION = 1

/** ledger 路径：仓库目录的上一级（<storeDir>/offsite/ledger.json）。 */
export function ledgerPathFor(repoDir) {
  return path.resolve(path.dirname(path.resolve(String(repoDir || ''))), 'ledger.json')
}

export function defaultLedger() {
  return {
    format: LEDGER_FORMAT,
    version: LEDGER_VERSION,
    seq: 0,
    lastManifest: null,
    updatedAt: 0,
    entries: [],
  }
}

/**
 * 读 ledger；不存在返回默认空链。
 *
 * 兼容两种 schema（CLI 与面板 `src/offsite.js` 共用同一个 `<offsite>/ledger.json`）：
 *   A. 本文件的 {format:'dsh-dr-ledger', seq, lastManifest, entries:[…]}；
 *   B. 面板的 {version, seq, prevManifest, archives:[…], lastExportAt, …}。
 * 遇到 B 时把 archives 映射成 entries（按 seq 升序补 prevManifest），readLedger 只在内存里
 * 做适配，写回时由 writeLedger 合并保留面板自有字段。存在但无法解析 ⇒ 抛 code='bad-ledger'。
 */
export async function readLedger(repoDir) {
  const file = ledgerPathFor(repoDir)
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return defaultLedger()
    throw error
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    throw repoError('bad-ledger', `ledger 无法解析，拒绝继续：${file}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw repoError('bad-ledger', `ledger 格式不匹配，拒绝继续：${file}`)
  }
  const own = raw.format === LEDGER_FORMAT
  const hasForeign = Array.isArray(raw.archives) || raw.prevManifest !== undefined
  if (!own && !hasForeign && !Number.isFinite(Number(raw.seq))) {
    throw repoError('bad-ledger', `ledger 格式不匹配，拒绝继续：${file}`)
  }
  const entries = own
    ? (Array.isArray(raw.entries) ? raw.entries : []).filter((entry) => entry && typeof entry === 'object')
    : archivesToEntries(raw.archives)
  const lastManifest = typeof raw.lastManifest === 'string'
    ? raw.lastManifest
    : (typeof raw.prevManifest === 'string' && raw.prevManifest ? raw.prevManifest : null)
  return {
    format: own ? LEDGER_FORMAT : 'dsh-offsite-ledger',
    version: Number(raw.version) || LEDGER_VERSION,
    seq: Number.isFinite(Number(raw.seq)) ? Math.max(0, Math.round(Number(raw.seq))) : 0,
    lastManifest,
    updatedAt: Number(raw.updatedAt) || 0,
    entries,
    // 面板 ledger 的原始字段（写回时原样保留，避免 CLI 抹掉面板状态）
    foreign: own ? null : raw,
  }
}

/** 面板 ledger 的 archives → 本模块的 entries（补 prevManifest 链；信息量少的字段留 null）。 */
function archivesToEntries(archives) {
  if (!Array.isArray(archives)) return []
  const entries = []
  for (const item of archives) {
    if (!item || typeof item !== 'object') continue
    const snapshotId = String(item.snapshotId || '')
    const manifestName = String(item.manifestName || '')
    if (!snapshotId || !manifestName) continue
    entries.push({
      snapshotId,
      manifestName,
      seq: Number(item.seq) || 0,
      prevManifest: undefined, // 面板索引是「每快照一条」，不含逐节点 prev；下面按 seq 补
      at: Number(item.at) || 0,
      exportedAt: Number(item.exportedAt) || Number(item.at) || 0,
      files: Number(item.files) || 0,
      bytes: Number(item.bytes) || 0,
      chunks: Number(item.chunks) || null,
      newChunks: Number(item.newChunks) || 0,
      reusedChunks: null,
      manifestSha256: typeof item.manifestSha256 === 'string' ? item.manifestSha256 : '',
      source: 'offsite-ledger',
    })
  }
  entries.sort((a, b) => (a.seq || 0) - (b.seq || 0))
  for (let index = 0; index < entries.length; index += 1) {
    entries[index].prevManifest = index === 0 ? null : entries[index - 1].manifestName
  }
  return entries
}

/**
 * 写 ledger（原子写）。
 * 若磁盘上已有面板 ledger，则合并：保留面板自有字段（lastExportAt/archives/…），
 * 同时更新 seq / lastManifest / prevManifest / entries，并把 entries 镜像回 archives，
 * 这样 CLI 导出的档案在面板「异地副本」列表里也可见。
 */
export async function writeLedger(repoDir, ledger) {
  const file = ledgerPathFor(repoDir)
  let current = null
  try {
    current = JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch { current = null }
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {}
  const entries = Array.isArray(ledger.entries) ? ledger.entries : []
  const body = {
    ...base,
    format: LEDGER_FORMAT,
    version: LEDGER_VERSION,
    seq: Number(ledger.seq) || 0,
    lastManifest: ledger.lastManifest || null,
    // 面板字段别名：面板以 prevManifest 表示链尾清单名
    prevManifest: ledger.lastManifest || null,
    updatedAt: Date.now(),
    entries,
    archives: entriesToArchives(entries),
  }
  await writeJsonAtomic(file, body)
  return body
}

/** entries（可能同一快照多条）→ 面板 archives（每快照一条，取 seq 最大）。 */
function entriesToArchives(entries) {
  const byId = new Map()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const snapshotId = String(entry.snapshotId || '')
    if (!snapshotId) continue
    const previous = byId.get(snapshotId)
    if (!previous || (Number(entry.seq) || 0) >= (Number(previous.seq) || 0)) byId.set(snapshotId, entry)
  }
  return [...byId.values()]
    .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
    .map((entry) => ({
      snapshotId: String(entry.snapshotId),
      manifestName: String(entry.manifestName || ''),
      at: Number(entry.at) || 0,
      seq: Number(entry.seq) || 0,
      files: Number(entry.files) || 0,
      bytes: Number(entry.bytes) || 0,
      newChunks: Number(entry.newChunks) || 0,
      manifestSha256: typeof entry.manifestSha256 === 'string' ? entry.manifestSha256 : '',
      source: 'local',
    }))
}

/** 最近一次导出该快照的 ledger 节点（同一快照重导出时取 seq 最大的那条）。 */
export function findLedgerEntry(ledger, snapshotId) {
  const id = String(snapshotId == null ? '' : snapshotId)
  if (!id || !ledger || !Array.isArray(ledger.entries)) return null
  let found = null
  for (const entry of ledger.entries) {
    if (!entry || entry.snapshotId !== id) continue
    if (!found || (Number(entry.seq) || 0) > (Number(found.seq) || 0)) found = entry
  }
  return found
}

/** 只取清单需要持久化的字段（不含引擎内部字段与绝对路径）。 */
function pickSnapshot(manifest, uniqueChunks) {
  const files = {}
  let bytes = 0
  const source = (manifest && manifest.files) || {}
  for (const [rel, entry] of Object.entries(source)) {
    if (!entry || typeof entry !== 'object') throw repoError('bad-manifest', `清单条目非法：${rel}`)
    const chunks = entryChunks(entry)
    for (const hash of chunks) {
      if (!isPlainHash(hash)) throw repoError('bad-manifest', `清单条目 ${rel} 含非法块哈希`)
    }
    const size = Number(entry.s)
    if (!Number.isFinite(size) || size < 0) throw repoError('bad-manifest', `清单条目 ${rel} 的 s 非法`)
    // 非空文件却没有任何块：清单自身损坏（与 BlobStore.verify 口径一致）
    if (size > 0 && chunks.length === 0) throw repoError('bad-manifest', `清单条目 ${rel} 缺块`)
    files[rel] = { s: size, m: Number(entry.m) || 0, c: chunks.slice() }
    bytes += size
  }
  const stats = {
    files: Object.keys(files).length,
    bytes,
    chunks: uniqueChunks,
  }
  return {
    id: String(manifest.id),
    at: Number(manifest.at) || 0,
    reason: String(manifest.reason || 'auto'),
    chunkSize: Number(manifest.chunkSize) || DEFAULT_CHUNK_SIZE,
    stats,
    files,
  }
}

/**
 * 导出快照到本地加密仓库。
 *
 * @param {object} options
 * @param {object} options.engine  BackupEngine 实例（需 pinSnapshot/unpinSnapshot/store）
 * @param {object} options.repo    LocalRepo 实例（已解锁）
 * @param {string} [options.snapshotId] 默认 engine.latestSnapshotId()
 * @returns {Promise<{snapshotId:string, manifestName:string, newChunks:number,
 *   reusedChunks:number, files:number, bytes:number, seq:number}>}
 */
export async function exportSnapshot({ engine, repo, snapshotId } = {}) {
  if (!engine || typeof engine !== 'object') throw repoError('bad-args', '缺少 engine')
  if (!repo || typeof repo !== 'object') throw repoError('bad-args', '缺少 repo')
  if (!engine.store) throw repoError('not-ready', '备份引擎尚未启动')
  if (typeof engine.pinSnapshot !== 'function' || typeof engine.unpinSnapshot !== 'function') {
    throw repoError('unsupported-engine', 'BackupEngine 缺少 pinSnapshot/unpinSnapshot')
  }

  let id = String(snapshotId == null ? '' : snapshotId)
  if (!id) id = engine.latestSnapshotId ? engine.latestSnapshotId() : null
  if (!id) throw repoError('no-snapshot', '没有可导出的快照')

  // 首次导出就把离线恢复工具写进 <repo>/recovery-kit/（幂等：内容没变不重写）。
  // 这一步不依赖 masterKey，也不改仓库逻辑存储。
  try {
    await ensureRecoveryKit(repo)
  } catch (error) {
    throw repoError('recovery-kit-failed',
      `写入离线恢复工具失败：${String((error && error.message) || error)}`)
  }

  // pin 必须在读清单/读块之前：之后并发的 prune / 新 snapshot 不得回收它们的块
  engine.pinSnapshot(id)
  try {
    let manifest
    try {
      manifest = await engine.store.readManifest(id)
    } catch (error) {
      throw repoError('no-snapshot', `快照不存在或清单损坏：${id}（${String((error && error.message) || error)}）`)
    }
    if (!manifest || manifest.id !== id) throw repoError('bad-manifest', `清单与快照 id 不一致：${id}`)

    // 1) 收集去重块（保持稳定顺序：按文件路径 → 块顺序）
    const order = []
    const seen = new Set()
    for (const rel of Object.keys(manifest.files || {}).sort()) {
      for (const hash of entryChunks(manifest.files[rel])) {
        if (seen.has(hash)) continue
        seen.add(hash)
        order.push(hash)
      }
    }

    // 2) 逐块：读 → 校验 → 仓库去重写
    const sizeByHash = new Map()
    let newChunks = 0
    let reusedChunks = 0
    let bytes = 0
    for (const hash of order) {
      let buf
      try {
        buf = await engine.store.get(hash)
      } catch {
        throw repoError('missing-chunk', `本地 store 缺少内容块 ${hash.slice(0, 12)}…，快照 ${id} 不可导出`)
      }
      if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf)
      if (sha256hex(buf) !== hash) {
        throw repoError('integrity', `本地内容块 ${hash.slice(0, 12)}… 内容损坏（sha256 不符）`)
      }
      sizeByHash.set(hash, buf.length)
      bytes += buf.length
      const state = await repo.putChunk(hash, buf)
      if (state === 'created') newChunks += 1
      else reusedChunks += 1
    }

    // 3) 校验清单自洽：每个文件的块总长必须等于 s（防止「清单对但块拼接长度错」）
    for (const [rel, entry] of Object.entries(manifest.files || {})) {
      let total = 0
      for (const hash of entryChunks(entry)) total += sizeByHash.get(hash) || 0
      if (total !== Number(entry.s || 0)) {
        throw repoError('integrity', `清单条目 ${rel} 的块总长 ${total} 与 s=${entry.s} 不一致`)
      }
    }

    const snapshot = pickSnapshot(manifest, order.length)
    const files = snapshot.stats.files

    // 4) 清单 + 哈希链（seq 从 ledger 读）
    const ledger = await readLedger(repo.dir)
    const name = repo.manifestNameFor(id)
    const existing = findLedgerEntry(ledger, id)
    const isTip = Boolean(existing && ledger.lastManifest === name)
    let seq
    let prevManifest
    if (isTip) {
      // 幂等重导出：沿用原来的链节点，不新增 seq
      seq = Number(existing.seq) || 0
      prevManifest = existing.prevManifest === undefined ? null : existing.prevManifest
    } else {
      seq = (Number(ledger.seq) || 0) + 1
      prevManifest = ledger.lastManifest || null
    }

    const payload = {
      version: 1,
      snapshot,
      exportedAt: Date.now(),
      prevManifest,
      seq,
    }
    // 幂等重导出：清单已存在且就是链尾时不再重写（否则 exportedAt 变化会让 ledger 里
    // 记的 manifestSha256 立刻过期，链内容也无谓变动）。
    const alreadyStored = isTip && (await repo.hasManifestName(name))
    let manifestSha256 = ''
    if (!alreadyStored) {
      const written = await repo.putManifest(id, payload)
      if (written !== name) throw repoError('bad-name', '清单名与 snapshotId 的 HMAC 不一致')
      try {
        manifestSha256 = sha256hex(await fsp.readFile(repo.absPath(written)))
      } catch { manifestSha256 = '' }
    }

    if (!isTip) {
      const entry = {
        snapshotId: id,
        manifestName: name,
        seq,
        prevManifest,
        at: snapshot.at,
        exportedAt: payload.exportedAt,
        files,
        bytes,
        chunks: order.length,
        newChunks,
        reusedChunks,
        manifestSha256,
      }
      ledger.entries.push(entry)
      ledger.seq = seq
      ledger.lastManifest = name
      try {
        await writeLedger(repo.dir, ledger)
      } catch (error) {
        // 清单已落盘但链没更新：下一次导出会用新 seq 重写同名清单，链仍能自愈
        throw repoError('ledger-write-failed',
          `清单已写入但 ledger 更新失败：${String((error && error.message) || error)}`)
      }
    }

    return {
      snapshotId: id,
      manifestName: name,
      newChunks,
      reusedChunks,
      files,
      bytes,
      seq,
    }
  } finally {
    try { engine.unpinSnapshot(id) } catch { /* unpin 失败不掩盖原始异常 */ }
  }
}

/**
 * 校验 ledger 哈希链：seq 连续 + 每个 prevManifest 指向前一个 manifest 名，
 * 且（可选）清单/前驱清单在仓库里真实存在。只读。
 *
 * 面板 ledger（`{seq, prevManifest, archives}`，没有逐节点 prev）只做「清单存在性 + 链尾一致」
 * 校验，不把「archives 被保留策略修剪」误报成断链。
 * @returns {{ok:boolean, problems:Array<{seq:number, snapshotId:string, problem:string}>, entries:number, compat:boolean}}
 */
export async function checkLedgerChain(ledger, repo = null) {
  const problems = []
  const compat = Boolean(ledger && ledger.foreign)
  const entries = (ledger && Array.isArray(ledger.entries) ? ledger.entries : [])
    .filter((entry) => entry && typeof entry === 'object')
    .slice()
    .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
  let prev = null
  for (const entry of entries) {
    const seq = Number(entry.seq) || 0
    if (prev && !compat) {
      if (entry.prevManifest !== prev.manifestName) {
        problems.push({ seq, snapshotId: entry.snapshotId, problem: `prevManifest 未指向上一节点（期望 ${String(prev.manifestName).slice(0, 16)}…）` })
      }
      if (seq !== (Number(prev.seq) || 0) + 1) {
        problems.push({ seq, snapshotId: entry.snapshotId, problem: `seq 不连续（上一节点 ${prev.seq}）` })
      }
    } else if (prev && compat && seq <= (Number(prev.seq) || 0)) {
      problems.push({ seq, snapshotId: entry.snapshotId, problem: 'seq 未递增' })
    } else if (!prev && !compat && entry.prevManifest != null) {
      problems.push({ seq, snapshotId: entry.snapshotId, problem: '链首节点的 prevManifest 不为 null' })
    }
    if (repo && !(await repo.hasManifestName(entry.manifestName))) {
      problems.push({ seq, snapshotId: entry.snapshotId, problem: '该快照的清单在仓库里缺失' })
    }
    if (repo && prev && !compat && !(await repo.hasManifestName(entry.prevManifest))) {
      problems.push({ seq, snapshotId: entry.snapshotId, problem: 'prevManifest 指向的清单在仓库里缺失（断链）' })
    }
    prev = entry
  }
  // 链尾一致性：ledger.lastManifest 必须等于 seq 最大的节点
  if (prev && ledger.lastManifest && prev.manifestName !== ledger.lastManifest) {
    problems.push({ seq: Number(prev.seq) || 0, snapshotId: prev.snapshotId, problem: 'ledger 链尾与最后一条记录不一致' })
  }
  return { ok: problems.length === 0, problems, entries: entries.length, compat }
}
