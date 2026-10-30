/**
 * 从加密仓库恢复到引擎（docs/OFFSITE-ARCHIVE.md §4「恢复 / 演练」）。
 *
 * importSnapshotToEngine：解密清单（校验清单名 ↔ snapshot.id 的 HMAC 绑定）→
 *   逐块：本地 BlobStore 已有则跳过（去重），否则从仓库解密、校验 sha256 后写入本地 store →
 *   清单交给 engine.importSnapshot(manifest)（原子写 store/snapshots/<id>.json 并注册进内存，
 *   不触发 prune）→ 由调用方决定是否 engine.restore(id)。
 *
 * 「不部分恢复」：写入任何块 / 注册清单之前先做一遍可用性检查，缺块或块损坏直接抛错并列出
 * 具体块名，不会写半份清单、也就不会让用户误以为恢复成功。
 *
 * 只读 API：verifyRemoteSnapshot 只解密校验，不写仓库、不写 store、不改引擎内存快照列表。
 */
import { isPlainHash, repoError } from './format.js'
import { entryChunks, sha256hex } from '../util.js'

/**
 * 清单结构自检（只校验结构/哈希格式/大小自洽，不读块内容）：
 * 恶意或损坏的清单不能把 restore 引到「0 字节文件」「错块拼接」这类状态。
 */
function assertManifestShape(manifest, id) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw repoError('bad-manifest', `清单格式非法：${id}`)
  }
  if (String(manifest.id) !== String(id)) throw repoError('bad-manifest', `清单 snapshot.id 与请求不一致：${id}`)
  const files = manifest.files
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw repoError('bad-manifest', `清单缺少 files 映射：${id}`)
  }
  for (const [rel, entry] of Object.entries(files)) {
    if (!entry || typeof entry !== 'object') throw repoError('bad-manifest', `清单条目非法：${rel}`)
    const size = Number(entry.s)
    if (!Number.isFinite(size) || size < 0) throw repoError('bad-manifest', `清单条目 ${rel} 的 s 非法`)
    const chunks = entryChunks(entry)
    for (const hash of chunks) {
      if (!isPlainHash(hash)) throw repoError('bad-manifest', `清单条目 ${rel} 含非法块哈希`)
    }
    if (size > 0 && chunks.length === 0) throw repoError('bad-manifest', `清单条目 ${rel} 缺块`)
  }
  return manifest
}

function collectChunks(manifest) {
  const order = []
  const seen = new Set()
  for (const rel of Object.keys((manifest && manifest.files) || {}).sort()) {
    for (const hash of entryChunks(manifest.files[rel])) {
      if (seen.has(hash)) continue
      seen.add(hash)
      order.push(hash)
    }
  }
  return order
}

function resolveSnapshotId(snapshotId) {
  const id = String(snapshotId == null ? '' : snapshotId)
  if (!id) throw repoError('bad-args', '缺少 snapshotId')
  return id
}

/**
 * 把仓库里的快照导入本机引擎（块 + 清单），不执行 restore。
 *
 * @param {object} options
 * @param {object} options.engine BackupEngine
 * @param {object} options.repo LocalRepo（已解锁）
 * @param {string} options.snapshotId
 * @param {boolean} [options.lockBusy=true] 导入期间占用 engine.busy，
 *   避免并发 prune/snapshot 把刚写入但尚未被清单引用的块当成孤儿回收
 * @returns {Promise<{manifest:object, importedChunks:number, reusedChunks:number, files:number}>}
 */
export async function importSnapshotToEngine({ engine, repo, snapshotId, lockBusy = true } = {}) {
  if (!engine || typeof engine !== 'object') throw repoError('bad-args', '缺少 engine')
  if (!repo || typeof repo !== 'object') throw repoError('bad-args', '缺少 repo')
  if (!engine.store) throw repoError('not-ready', '备份引擎尚未启动')
  if (typeof engine.importSnapshot !== 'function') {
    throw repoError('unsupported-engine', 'BackupEngine 缺少 importSnapshot')
  }
  const id = resolveSnapshotId(snapshotId)

  if (lockBusy && engine.busy) throw repoError('busy', '正在备份/恢复，稍后再试')
  const previousBusy = engine.busy
  if (lockBusy) engine.busy = true
  try {
    const { name, payload } = await repo.getManifest(id)
    const manifest = payload && payload.snapshot
    if (!manifest || typeof manifest !== 'object') throw repoError('bad-manifest', `清单缺少 snapshot 字段：${id}`)
    assertManifestShape(manifest, id)

    const order = collectChunks(manifest)
    const files = Object.keys(manifest.files || {}).length

    // 1) 可用性检查：本地有 / 仓库有 / 缺；缺或坏就整体拒绝（不部分恢复）
    const fromRepo = []
    const missing = []
    for (const hash of order) {
      if (await engine.store.has(hash)) continue
      let present = false
      try { present = await repo.hasChunk(hash) } catch { present = false }
      if (!present) missing.push(hash)
      else fromRepo.push(hash)
    }
    if (missing.length) {
      const names = missing.slice(0, 20).map((hash) => repo.chunkNameFor(hash))
      throw repoError('missing-chunks',
        `仓库缺少 ${missing.length} 个内容块，拒绝部分恢复：${names.join(', ')}` +
        (missing.length > names.length ? ` …（共 ${missing.length} 个）` : ''))
    }

    // 2) 逐块解密 → 校验 → 写入本地 store
    const fromRepoSet = new Set(fromRepo)
    let importedChunks = 0
    let reusedChunks = 0
    for (const hash of order) {
      if (!fromRepoSet.has(hash)) { reusedChunks += 1; continue }
      let buf
      try {
        buf = await repo.getChunk(hash)
      } catch (error) {
        throw repoError('integrity',
          `块解密/校验失败（${hash.slice(0, 12)}…，清单 ${name}）：${String((error && error.message) || error)}`)
      }
      if (sha256hex(buf) !== hash) {
        throw repoError('integrity', `块内容 sha256 不符（${hash.slice(0, 12)}…），拒绝导入`)
      }
      const stored = await engine.store.put(buf)
      if (stored !== hash) throw repoError('integrity', `本地 store 写入的块哈希不符（${hash.slice(0, 12)}…）`)
      importedChunks += 1
    }

    // 3) 清单持久化 + 注册（engine.importSnapshot 内部原子写 store/snapshots/<id>.json，不 prune）
    await engine.importSnapshot(manifest)

    return { manifest, importedChunks, reusedChunks, files }
  } finally {
    engine.busy = previousBusy
  }
}

/**
 * 只读校验仓库里的快照能不能恢复（不写任何东西）。
 * deep=true 时逐块解密并校验 sha256（真正验证密文完整性与清单自洽）。
 *
 * 口径：「缺失」指的是**仓库里缺块**（异地副本不完整，换机恢复会失败）；
 * 本地 BlobStore 里已有的块只作为附加信息（fromStore），不会掩盖仓库缺块。
 * importSnapshotToEngine 允许本地兜底，所以它能容忍 repo 缺块而本地有；这里不行。
 *
 * @returns {Promise<{snapshotId:string, manifestName:string, files:number, chunks:number,
 *   ok:boolean, missingChunks:string[], missingNames:string[],
 *   corrupt:Array<{hash:string,name:string,reason:string}>,
 *   fromRepo:number, fromStore:number, prevManifest:string|null, seq:number}>}
 */
export async function verifyRemoteSnapshot({ engine, repo, snapshotId, deep = true } = {}) {
  if (!repo || typeof repo !== 'object') throw repoError('bad-args', '缺少 repo')
  if (!engine || !engine.store) throw repoError('not-ready', '备份引擎尚未启动')
  const id = resolveSnapshotId(snapshotId)

  const { name, payload } = await repo.getManifest(id)
  const manifest = payload && payload.snapshot
  if (!manifest || typeof manifest !== 'object') throw repoError('bad-manifest', `清单缺少 snapshot 字段：${id}`)
  assertManifestShape(manifest, id)

  const order = collectChunks(manifest)
  const missingChunks = []
  const missingNames = []
  const corrupt = []
  let fromRepo = 0
  let fromStore = 0

  for (const hash of order) {
    if (await engine.store.has(hash)) fromStore += 1
    if (!(await repo.hasChunk(hash))) {
      missingChunks.push(hash)
      missingNames.push(repo.chunkNameFor(hash))
      continue
    }
    if (deep) {
      try {
        await repo.getChunk(hash)
      } catch (error) {
        if (error && error.code === 'missing-chunk') {
          missingChunks.push(hash)
          missingNames.push(repo.chunkNameFor(hash))
        } else {
          corrupt.push({ hash, name: repo.chunkNameFor(hash), reason: String((error && error.message) || error) })
        }
        continue
      }
    }
    fromRepo += 1
  }

  return {
    snapshotId: id,
    manifestName: name,
    files: Object.keys(manifest.files || {}).length,
    chunks: order.length,
    ok: missingChunks.length === 0 && corrupt.length === 0,
    missingChunks,
    missingNames,
    corrupt,
    fromRepo,
    fromStore,
    prevManifest: payload.prevManifest === undefined ? null : payload.prevManifest,
    seq: Number(payload.seq) || 0,
  }
}
