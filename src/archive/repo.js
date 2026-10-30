/**
 * 本地加密仓库（去重）：repo 根内的文件读写 + 原子落盘 + name 白名单。
 *
 * 目录结构见 ./format.js 头注释与 docs/OFFSITE-ARCHIVE.md §2：
 *   repo.json / chunks/<ab>/<cd>/<name>.cbin / manifests/<name>.mbin / packs/<name>.pbin
 *
 * 约定：
 *   - 所有写盘都在 repo 根内（name 先过设计文档白名单，再 path.resolve 校验未越界）；
 *   - 写文件一律「临时文件 + rename」原子落盘（writeFileAtomic），中断不会留半截密文；
 *   - 块按 content-addressed 去重：已存在同名块直接返回 'exists'，绝不重写；
 *   - masterKey 只在内存里（close() 会清零），任何日志/错误信息都不含密码或密钥；
 *   - 清单名/包名对 snapshotId/packId 做 HMAC 绑定，重导出同一快照会覆盖同名清单（内容由调用方
 *     决定，export.js 用新 seq/prevManifest 保持哈希链线性）。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  CHUNK_NAME_RE, MANIFEST_NAME_RE, PACK_NAME_RE, REPO_HEADER_NAME,
  chunkName, clampChunkSize, createRepoMeta, decryptChunk, decryptManifest, decryptPack,
  encryptChunk, encryptManifest, encryptPack, isPlainHash, isRepoName, manifestName, nameKind,
  openRepoKey, packName, repoError, REPO_FORMAT, REPO_VERSION, verifyMasterKey,
} from './format.js'
import { exists, readJsonSafe, sha256hex, writeFileAtomic, writeJsonAtomic } from '../util.js'
import { ensureRecoveryKit, recoveryKitStatus } from './recovery.js'

function assertInside(root, abs) {
  const base = path.resolve(root)
  const resolved = path.resolve(abs)
  if (resolved !== base && !resolved.startsWith(base.endsWith(path.sep) ? base : base + path.sep)) {
    throw repoError('bad-name', '仓库文件名越界（path traversal）')
  }
  return resolved
}

export class LocalRepo {
  /**
   * @param {object} options
   * @param {string} options.dir       仓库根目录（如 <storeDir>/offsite/repo）
   * @param {object} options.meta      repo.json 内容
   * @param {Buffer} options.masterKey 32B 主密钥（只在内存）
   */
  constructor({ dir, meta, masterKey }) {
    this.dir = path.resolve(String(dir || ''))
    this.meta = meta
    this.masterKey = masterKey
  }

  get repoFile() { return path.join(this.dir, REPO_HEADER_NAME) }
  get repoId() { return String((this.meta && this.meta.repoId) || '') }
  get chunkSize() { return clampChunkSize((this.meta && this.meta.chunkSize) || 0) }
  get createdAt() { return Number((this.meta && this.meta.createdAt) || 0) }

  /** 打开已存在的仓库（密码错抛 code='bad-password'）。 */
  static async open({ dir, password } = {}) {
    const root = path.resolve(String(dir || ''))
    const meta = await readJsonSafe(path.join(root, REPO_HEADER_NAME), null)
    if (!meta) throw repoError('no-repo', `仓库不存在或 repo.json 无法解析：${root}`)
    const masterKey = openRepoKey(meta, password)
    return new LocalRepo({ dir: root, meta, masterKey })
  }

  /**
   * 用 32B masterKey 直接打开仓库（DPAPI 缓存 / 恢复工具用）。
   * 会校验 repo.json 的 keyCheck；不经过密码/KDF。
   */
  static async openWithMasterKey({ dir, masterKey } = {}) {
    const root = path.resolve(String(dir || ''))
    const meta = await readJsonSafe(path.join(root, REPO_HEADER_NAME), null)
    if (!meta) throw repoError('no-repo', `仓库不存在或 repo.json 无法解析：${root}`)
    const key = Buffer.isBuffer(masterKey) ? Buffer.from(masterKey) : Buffer.from(masterKey || [])
    if (key.length !== 32) throw repoError('bad-master-key', 'masterKey 必须是 32 字节')
    verifyMasterKey(meta, key)
    return new LocalRepo({ dir: root, meta, masterKey: key })
  }

  /**
   * 只读打开（不校验密码、不派生密钥）：只能做 stats/listNames 这类不解密的事。
   * 任何加解密都会抛 code='no-key'。CLI 的 status / list（ledger 视图）用。
   */
  static async openReadonly({ dir } = {}) {
    const root = path.resolve(String(dir || ''))
    const meta = await readJsonSafe(path.join(root, REPO_HEADER_NAME), null)
    if (!meta) throw repoError('no-repo', `仓库不存在或 repo.json 无法解析：${root}`)
    return new LocalRepo({ dir: root, meta, masterKey: null })
  }

  /** 初始化新仓库；目录不存在会自动创建。已存在 repo.json 视为错误（不覆盖）。 */
  static async init({ dir, password, chunkSize } = {}) {
    const root = path.resolve(String(dir || ''))
    if (!root) throw repoError('bad-args', '缺少仓库目录')
    await fsp.mkdir(root, { recursive: true })
    const existing = await readJsonSafe(path.join(root, REPO_HEADER_NAME), null)
    if (existing) throw repoError('repo-exists', `仓库已存在，拒绝覆盖：${root}`)
    const { meta, masterKey } = createRepoMeta({ password, chunkSize })
    await writeJsonAtomic(path.join(root, REPO_HEADER_NAME), meta)
    const repo = new LocalRepo({ dir: root, meta, masterKey })
    await fsp.mkdir(path.join(root, 'chunks'), { recursive: true })
    await fsp.mkdir(path.join(root, 'manifests'), { recursive: true })
    await fsp.mkdir(path.join(root, 'packs'), { recursive: true })
    // 离线恢复工具：初始化就写入，别等到需要它的时候才发现没有
    await ensureRecoveryKit(repo)
    return repo
  }

  /** 释放内存里的主密钥（之后任何加解密都会抛 code='no-key'）。 */
  close() {
    if (Buffer.isBuffer(this.masterKey)) this.masterKey.fill(0)
    this.masterKey = null
  }

  get unlocked() { return Buffer.isBuffer(this.masterKey) && this.masterKey.length === 32 }

  requireKey() {
    if (!this.unlocked) throw repoError('no-key', '仓库未解锁（masterKey 已释放），请用密码重新打开')
    return this.masterKey
  }

  /* ------------------------------------------------------------- 路径 */

  /** name（posix 相对名，白名单内）→ 绝对路径；越界抛 code='bad-name'。 */
  absPath(name) {
    if (!isRepoName(name)) throw repoError('bad-name', `非法的仓库文件名：${String(name).slice(0, 120)}`)
    return assertInside(this.dir, path.join(this.dir, ...String(name).split('/')))
  }

  /* --------------------------------------------------------------- 块 */

  chunkNameFor(plainHash) {
    return chunkName(this.requireKey(), plainHash)
  }

  async hasChunk(plainHash) {
    if (!isPlainHash(plainHash)) return false
    return exists(this.absPath(this.chunkNameFor(plainHash)))
  }

  /** 加密落盘；返回 'created'（新写）或 'exists'（已有，去重跳过）。 */
  async putChunk(plainHash, buf) {
    if (!isPlainHash(plainHash)) throw repoError('bad-hash', 'plainHash 必须是 64 位小写 hex')
    const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
    const actual = sha256hex(data)
    if (actual !== plainHash) {
      throw repoError('integrity', `待写入块内容与 plainHash 不符（期望 ${plainHash.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`)
    }
    const name = this.chunkNameFor(plainHash)
    const abs = this.absPath(name)
    if (await exists(abs)) return 'exists'
    const envelope = encryptChunk(this.requireKey(), plainHash, data)
    await writeFileAtomic(abs, envelope)
    return 'created'
  }

  /** 解密取块并校验 sha256；缺失抛 code='missing-chunk'，篡改抛 code='integrity'。 */
  async getChunk(plainHash) {
    if (!isPlainHash(plainHash)) throw repoError('bad-hash', 'plainHash 必须是 64 位小写 hex')
    const name = this.chunkNameFor(plainHash)
    let raw
    try {
      raw = await fsp.readFile(this.absPath(name))
    } catch (error) {
      if (error && error.code === 'ENOENT') throw repoError('missing-chunk', `仓库缺少内容块 ${plainHash.slice(0, 12)}…`)
      throw error
    }
    return decryptChunk(this.requireKey(), name, raw, plainHash)
  }

  async listChunkNames() {
    const out = []
    let prefixes = []
    try { prefixes = await fsp.readdir(path.join(this.dir, 'chunks')) } catch { return out }
    for (const a of prefixes) {
      if (!/^[0-9a-f]{2}$/.test(a)) continue
      let subs = []
      try { subs = await fsp.readdir(path.join(this.dir, 'chunks', a)) } catch { continue }
      for (const b of subs) {
        if (!/^[0-9a-f]{2}$/.test(b)) continue
        let names = []
        try { names = await fsp.readdir(path.join(this.dir, 'chunks', a, b)) } catch { continue }
        for (const file of names) {
          const rel = `chunks/${a}/${b}/${file}`
          if (CHUNK_NAME_RE.test(rel)) out.push(rel)
        }
      }
    }
    out.sort()
    return out
  }

  /* ------------------------------------------------------------- 清单 */

  manifestNameFor(snapshotId) {
    return manifestName(this.requireKey(), snapshotId)
  }

  async hasManifestName(name) {
    if (!MANIFEST_NAME_RE.test(String(name || ''))) return false
    return exists(this.absPath(name))
  }

  async hasManifest(snapshotId) {
    return this.hasManifestName(this.manifestNameFor(snapshotId))
  }

  /** 写清单（覆盖同名清单：同一 snapshotId 重导出时由 export.js 重写链信息）。返回 name。 */
  async putManifest(snapshotId, obj) {
    const name = this.manifestNameFor(snapshotId)
    const expected = obj && obj.snapshot && obj.snapshot.id
    if (expected != null && String(expected) !== String(snapshotId)) {
      throw repoError('bad-args', '清单 snapshot.id 与 snapshotId 参数不一致')
    }
    const body = { ...(obj || {}) }
    if (!body.snapshot || typeof body.snapshot !== 'object') {
      throw repoError('bad-args', '清单缺少 snapshot 字段')
    }
    body.snapshot = { ...body.snapshot, id: String(snapshotId) }
    const envelope = encryptManifest(this.requireKey(), name, body)
    await writeFileAtomic(this.absPath(name), envelope)
    return name
  }

  async getManifestByName(name) {
    if (!MANIFEST_NAME_RE.test(String(name || ''))) throw repoError('bad-name', '非法的清单名')
    let raw
    try {
      raw = await fsp.readFile(this.absPath(name))
    } catch (error) {
      if (error && error.code === 'ENOENT') throw repoError('missing-manifest', `仓库缺少清单 ${String(name).slice(0, 24)}…`)
      throw error
    }
    return decryptManifest(this.requireKey(), name, raw)
  }

  /** 按 snapshotId 解密清单：返回 {name, payload}（payload.snapshot 即引擎清单）。 */
  async getManifest(snapshotId) {
    const name = this.manifestNameFor(snapshotId)
    const payload = await this.getManifestByName(name)
    return { name, payload }
  }

  async listManifestNames() {
    let names = []
    try { names = await fsp.readdir(path.join(this.dir, 'manifests')) } catch { return [] }
    return names
      .map((file) => `manifests/${file}`)
      .filter((rel) => MANIFEST_NAME_RE.test(rel))
      .sort()
  }

  /* --------------------------------------------------------------- 包 */

  packNameFor(packId) {
    return packName(this.requireKey(), packId)
  }

  /**
   * 打一个包并落盘（只用于跨机传输，不改变逻辑存储）。
   * @returns {{name: string, packId: string, size: number, sha256: string, chunks: number}}
   */
  async putPack({ packId, packObj = {}, records = [] } = {}) {
    const id = String(packId == null ? '' : packId)
    if (!id) throw repoError('bad-args', '缺少 packId')
    const name = this.packNameFor(id)
    const envelope = encryptPack(this.requireKey(), name, { ...packObj, packId: id }, records)
    await writeFileAtomic(this.absPath(name), envelope)
    return {
      name,
      packId: id,
      size: envelope.length,
      sha256: sha256hex(envelope),
      chunks: Array.isArray(records) ? records.length : 0,
    }
  }

  /** 接受 packId 或 pack 名（packs/xxx.pbin），返回 {name, header, records}。 */
  async getPack(packIdOrName) {
    const raw = String(packIdOrName == null ? '' : packIdOrName)
    const name = PACK_NAME_RE.test(raw) ? raw : this.packNameFor(raw)
    let envelope
    try {
      envelope = await fsp.readFile(this.absPath(name))
    } catch (error) {
      if (error && error.code === 'ENOENT') throw repoError('missing-pack', `仓库缺少包 ${name.slice(0, 20)}…`)
      throw error
    }
    return { name, ...decryptPack(this.requireKey(), name, envelope) }
  }

  async listPackNames() {
    let names = []
    try { names = await fsp.readdir(path.join(this.dir, 'packs')) } catch { return [] }
    return names
      .map((file) => `packs/${file}`)
      .filter((rel) => PACK_NAME_RE.test(rel))
      .sort()
  }

  /* ------------------------------------------------------------- 统计 */

  /** 只 stat，不解密：{chunks, chunkBytes, manifests, manifestBytes, packs, packBytes, bytes}。 */
  async stats() {
    const walk = async (rel, filter) => {
      const names = []
      let prefixes = []
      try { prefixes = await fsp.readdir(path.join(this.dir, rel)) } catch { return names }
      if (rel === 'chunks') {
        for (const a of prefixes) {
          if (!/^[0-9a-f]{2}$/.test(a)) continue
          let subs = []
          try { subs = await fsp.readdir(path.join(this.dir, rel, a)) } catch { continue }
          for (const b of subs) {
            if (!/^[0-9a-f]{2}$/.test(b)) continue
            let files = []
            try { files = await fsp.readdir(path.join(this.dir, rel, a, b)) } catch { continue }
            for (const file of files) names.push(`${rel}/${a}/${b}/${file}`)
          }
        }
      } else {
        for (const file of prefixes) names.push(`${rel}/${file}`)
      }
      return names.filter(filter)
    }
    const sum = async (names) => {
      let count = 0
      let bytes = 0
      for (const name of names) {
        try {
          const stat = await fsp.stat(this.absPath(name))
          count += 1
          bytes += stat.size
        } catch { /* 并发删除忽略 */ }
      }
      return { count, bytes }
    }
    const chunkNames = await walk('chunks', (rel) => CHUNK_NAME_RE.test(rel))
    const manifestNames = await walk('manifests', (rel) => MANIFEST_NAME_RE.test(rel))
    const packNames = await walk('packs', (rel) => PACK_NAME_RE.test(rel))
    const chunks = await sum(chunkNames)
    const manifests = await sum(manifestNames)
    const packs = await sum(packNames)
    return {
      repoId: this.repoId,
      chunkSize: this.chunkSize,
      chunks: chunks.count,
      chunkBytes: chunks.bytes,
      manifests: manifests.count,
      manifestBytes: manifests.bytes,
      packs: packs.count,
      packBytes: packs.bytes,
      bytes: chunks.bytes + manifests.bytes + packs.bytes,
    }
  }

  /** 只读自查：repo.json 是否是我们认识的格式（不解密）。 */
  static describe(meta) {
    if (!meta) return null
    return {
      format: meta.format,
      version: meta.version,
      repoId: meta.repoId,
      createdAt: meta.createdAt,
      cipher: meta.cipher,
      chunkSize: meta.chunkSize,
      kdf: meta.kdf ? { name: meta.kdf.name, N: meta.kdf.N, r: meta.kdf.r, p: meta.kdf.p } : null,
      keyCheck: Boolean(meta.keyCheck),
      supported: meta.format === REPO_FORMAT && Number(meta.version) === REPO_VERSION,
    }
  }
}

/** 读取仓库明文头（不需要密码；repo.json 设计上只含非敏感元数据）。 */
export async function readRepoMeta(dir) {
  return readJsonSafe(path.join(path.resolve(String(dir || '')), REPO_HEADER_NAME), null)
}

/** 判断目录是否是一个仓库（有 repo.json）。 */
export async function isRepoDir(dir) {
  return exists(path.join(path.resolve(String(dir || '')), REPO_HEADER_NAME))
}

// 恢复工具相关（面板/计划任务可直接从 './archive/repo.js' 取用）：
//   ensureRecoveryKit(repo)  —— 首次导出/初始化时把离线恢复工具写进 <repo>/recovery-kit/
//   recoveryKitStatus(repo)  —— 只读检查 kit 是否齐全/是否过期
export { ensureRecoveryKit, recoveryKitStatus, RECOVERY_KIT_VERSION, RECOVERY_KIT_DIRNAME } from './recovery.js'
export { nameKind }
