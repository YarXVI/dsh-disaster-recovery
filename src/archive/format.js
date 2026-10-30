/**
 * 异地加密仓库格式 v1 —— 加密 / 命名原语（docs/OFFSITE-ARCHIVE.md §2 的实现）
 *
 * 仓库布局（全部在 repo 根内，name 必须过白名单）：
 *   repo.json                          # 明文头：format/version/repoId/createdAt/kdf/cipher/chunkSize
 *   chunks/<a>/<b>/<name>.cbin         # name = HMAC-SHA256(masterKey, "chunk:"+plainHash) 的 hex
 *   manifests/<name>.mbin              # name = HMAC-SHA256(masterKey, "manifest:"+snapshotId) 的 hex
 *   packs/<name>.pbin                  # name = HMAC-SHA256(masterKey, "pack:"+packId) 的 hex
 *   recovery-kit/...                   # 不加密、不含密钥的恢复工具（本模块不生成内容）
 *
 * 密文信封（块 / 清单 / 包共用）：
 *   magic(4) | nonce(12, 随机) | AES-256-GCM(ciphertext) | tag(16)，AAD = name（相对仓库根的 posix 路径名）
 *   magic：块 "DRA1"、清单 "DRM1"、包 "DRP1"。
 *
 * ── 与设计文档 §2 的偏差（仅有以下两处，均不削弱安全性）───────────────────────
 * 1) 块/清单/包的 AES 密钥输入域：
 *    文档写的是 `key = HMAC-SHA256(masterKey, "chunkkey:"+plainHash)`。但解密端接口是
 *    `decryptChunk(masterKey, name, buf)`，只有不可逆的 keyed name，拿不到 plainHash，
 *    无法按文档构造重新派生密钥。因此这里把密钥派生定义为「以 keyed name 为输入域」：
 *      chunkKey(masterKey, plainHash) = HMAC-SHA256(masterKey, "chunkkey:" + chunkName(masterKey, plainHash))
 *      解密时等价地 chunkKeyFromName(masterKey, name) = HMAC-SHA256(masterKey, "chunkkey:" + name)
 *    name 本身就是 masterKey 的 HMAC（随机预言机输出），用它做 KDF 输入与用 plainHash 等价；
 *    文件字节布局、magic、AAD 与文档完全一致，磁盘上逐字节可比。
 *    清单/包同理：清单 key = HMAC(mk, "manifestkey:"+name)，包 key = HMAC(mk, "packkey:"+name)，
 *    解密后分别用 `manifestName(mk, obj.snapshot.id) === name` / `packName(mk, header.packId) === name`
 *    校验内容与 name 的绑定（相当于清单/包的完整性校验）。
 * 2) repo.json 多一个 `keyCheck: {v:1, mac}` = HMAC-SHA256(masterKey, "keycheck:"+repoId) 的 base64。
 *    否则「密码错」和「密文损坏」在 openRepoKey() 阶段无法区分，而冻结接口要求错密码抛
 *    code='bad-password'。keyCheck 只由 masterKey 派生，不含任何可直接反推密钥/口令的信息。
 *    没有 keyCheck 的 repo.json 会被 fail-closed 拒绝（code='bad-repo'）。
 *
 * 密码：≥9 位且必须同时含字母与数字；不设用户可见上限，超过 4096 个字符时 KDF 输入按
 * 前 4096 个字符截断（校验在截断前对整串做）。忘记密码 = 数据不可读，无后门。
 * 本模块绝不持久化/记录 password 或 masterKey。
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { sha256hex } from '../util.js'

export const REPO_FORMAT = 'dsh-dr-repo'
export const REPO_VERSION = 1
export const DEFAULT_CHUNK_SIZE = 65536
export const CHUNK_SIZE_MIN = 1024
export const CHUNK_SIZE_MAX = 16 * 1024 * 1024

/** KDF 参数（冻结，见设计文档 §2）。 */
export const KDF = Object.freeze({
  name: 'scrypt',
  N: 131072,
  r: 8,
  p: 1,
  maxmem: 512 * 1024 * 1024,
  saltBytes: 16,
  keyBytes: 32,
})

export const NONCE_BYTES = 12
export const TAG_BYTES = 16
export const MAGIC = Object.freeze({
  chunk: Buffer.from('DRA1', 'ascii'),
  manifest: Buffer.from('DRM1', 'ascii'),
  pack: Buffer.from('DRP1', 'ascii'),
})

export const PASSWORD_MIN_CHARS = 9
export const PASSWORD_MAX_CHARS = 4096

const HEX64 = '[0-9a-f]{64}'

/** 仓库内 name 白名单（设计文档 §3/§2 的正则，逐字一致）。 */
export const CHUNK_NAME_RE = new RegExp(`^chunks/[0-9a-f]{2}/[0-9a-f]{2}/${HEX64}\\.cbin$`)
export const MANIFEST_NAME_RE = new RegExp(`^manifests/${HEX64}\\.mbin$`)
export const PACK_NAME_RE = new RegExp(`^packs/${HEX64}\\.pbin$`)
export const REPO_HEADER_NAME = 'repo.json'
export const REPO_NAME_RE = new RegExp(
  `^(chunks/[0-9a-f]{2}/[0-9a-f]{2}/${HEX64}\\.cbin|manifests/${HEX64}\\.mbin` +
  `|packs/${HEX64}\\.pbin|repo\\.json|recovery-kit/[A-Za-z0-9._/-]{1,120})$`,
)

/** 带 code 的错误（面板/CLI 按 code 分支，message 可直接展示给用户）。 */
export function repoError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function isPlainHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

export function isRepoName(name) {
  return typeof name === 'string' && REPO_NAME_RE.test(name)
}

/** 'chunk' | 'manifest' | 'pack' | 'repo' | 'kit' | null */
export function nameKind(name) {
  if (typeof name !== 'string') return null
  if (CHUNK_NAME_RE.test(name)) return 'chunk'
  if (MANIFEST_NAME_RE.test(name)) return 'manifest'
  if (PACK_NAME_RE.test(name)) return 'pack'
  if (name === REPO_HEADER_NAME) return 'repo'
  if (/^recovery-kit\/[A-Za-z0-9._/-]{1,120}$/.test(name)) return 'kit'
  return null
}

export function assertName(name, kind = null) {
  const actual = nameKind(name)
  if (!actual || (kind && actual !== kind)) {
    throw repoError('bad-name', `非法的仓库文件名${kind ? `（期望 ${kind}）` : ''}`)
  }
  return name
}

export function clampChunkSize(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_CHUNK_SIZE
  return Math.min(CHUNK_SIZE_MAX, Math.max(CHUNK_SIZE_MIN, Math.round(n)))
}

/* ------------------------------------------------------------------ 密码 */

/**
 * 密码规则：≥9 位、必须同时含字母和数字。
 * 长度不设用户可见上限：>4096 位仍然合法（truncated:true），KDF 只用前 4096 个字符。
 * 返回 {ok, reason?, code?, truncated?}；reason/code 可直接作为面板文案。
 */
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, code: 'password-required', reason: '请提供恢复密码' }
  }
  const chars = [...password]
  if (chars.length < PASSWORD_MIN_CHARS) {
    return { ok: false, code: 'password-too-short', reason: `密码至少 ${PASSWORD_MIN_CHARS} 位` }
  }
  if (!/[A-Za-z]/.test(password)) {
    return { ok: false, code: 'password-needs-letter', reason: '密码必须同时包含字母和数字（缺字母）' }
  }
  if (!/[0-9]/.test(password)) {
    return { ok: false, code: 'password-needs-digit', reason: '密码必须同时包含字母和数字（缺数字）' }
  }
  if (chars.length > PASSWORD_MAX_CHARS) {
    return {
      ok: true,
      truncated: true,
      code: 'password-truncated',
      reason: `密码超过 ${PASSWORD_MAX_CHARS} 位，KDF 只使用前 ${PASSWORD_MAX_CHARS} 位（仍然合法）`,
    }
  }
  return { ok: true }
}

/**
 * 归一化 KDF 输入：NFKC + 按字符截断到 4096（不劈开多字节字符），再转 UTF-8。
 * 校验（字母/数字/长度）必须在调用本函数之前做。
 */
export function normalizePasswordForKdf(password) {
  const chars = [...String(password == null ? '' : password)]
  const capped = chars.length > PASSWORD_MAX_CHARS ? chars.slice(0, PASSWORD_MAX_CHARS) : chars
  return Buffer.from(capped.join('').normalize('NFKC'), 'utf8')
}

export function deriveMasterKey(password, salt) {
  const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt || ''), 'base64')
  if (saltBuf.length < 8 || saltBuf.length > 64) throw repoError('bad-repo', 'repo.json 的密钥盐不合法')
  return scryptSync(normalizePasswordForKdf(password), saltBuf, KDF.keyBytes, {
    N: KDF.N, r: KDF.r, p: KDF.p, maxmem: KDF.maxmem,
  })
}

function keyCheckMac(masterKey, repoId, salt) {
  return createHmac('sha256', masterKey).update(`keycheck:${repoId}:${salt.toString('hex')}`).digest()
}

function assertRepoMetaShape(meta) {
  if (!meta || typeof meta !== 'object') throw repoError('bad-repo', 'repo.json 不存在或无法解析')
  if (meta.format !== REPO_FORMAT) throw repoError('bad-repo', '不是 dsh-dr-repo 仓库（format 不匹配）')
  if (Number(meta.version) !== REPO_VERSION) {
    throw repoError('unsupported-version', `不支持的仓库版本：${meta.version}`)
  }
  if (meta.cipher !== 'aes-256-gcm') throw repoError('bad-repo', '不支持的加密算法')
}

function kdfParamsFromMeta(meta) {
  const kdf = (meta && meta.kdf) || {}
  if (kdf.name !== KDF.name) throw repoError('bad-repo', '不支持的密钥派生算法')
  const N = Number(kdf.N)
  const r = Number(kdf.r)
  const p = Number(kdf.p)
  // 夹取范围：防止恶意 repo.json 用超大 N 拖死进程
  if (!Number.isInteger(N) || N < 16384 || N > 1048576 || (N & (N - 1)) !== 0) {
    throw repoError('bad-repo', 'repo.json 的 scrypt N 不合法')
  }
  if (!Number.isInteger(r) || r < 1 || r > 32) throw repoError('bad-repo', 'repo.json 的 scrypt r 不合法')
  if (!Number.isInteger(p) || p < 1 || p > 8) throw repoError('bad-repo', 'repo.json 的 scrypt p 不合法')
  const salt = Buffer.from(String(kdf.salt || ''), 'base64')
  if (salt.length < 8 || salt.length > 64) throw repoError('bad-repo', 'repo.json 的盐不合法')
  return { N, r, p, salt }
}

/** 新建仓库头：{meta, masterKey}。密码不合规抛 code='weak-password'。 */
export function createRepoMeta({ password, chunkSize = DEFAULT_CHUNK_SIZE, now = Date.now() } = {}) {
  const check = validatePassword(password)
  if (!check.ok) throw repoError('weak-password', check.reason)
  const salt = randomBytes(KDF.saltBytes)
  const masterKey = deriveMasterKey(password, salt)
  const repoId = randomBytes(8).toString('hex')
  const meta = {
    format: REPO_FORMAT,
    version: REPO_VERSION,
    repoId,
    createdAt: now,
    kdf: { name: KDF.name, N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm',
    chunkSize: clampChunkSize(chunkSize),
    keyCheck: { v: 1, mac: keyCheckMac(masterKey, repoId, salt).toString('base64') },
  }
  return { meta, masterKey }
}

/**
 * 校验「已有的 masterKey 是否就是该 repo.json 的密钥」（DPAPI 缓存解锁用）。
 * 不匹配抛 code='bad-password'（错误信息不含密钥）；失败关闭。
 */
export function verifyMasterKey(meta, masterKey) {
  assertRepoMetaShape(meta)
  const buf = Buffer.isBuffer(masterKey) ? masterKey : Buffer.from(masterKey || [])
  if (buf.length !== KDF.keyBytes) throw repoError('bad-password', '仓库密钥长度不正确')
  const expected = meta.keyCheck && typeof meta.keyCheck.mac === 'string' ? meta.keyCheck.mac : ''
  if (!expected) throw repoError('bad-repo', 'repo.json 缺少 keyCheck，无法校验密钥（不是本实现生成的仓库）')
  const { salt } = kdfParamsFromMeta(meta)
  const want = Buffer.from(expected, 'base64')
  const got = keyCheckMac(buf, String(meta.repoId || ''), salt)
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    throw repoError('bad-password', '密钥与仓库不匹配')
  }
  return buf
}

/**
 * 用密码打开仓库头，返回 masterKey。密码错（含规则不合规）抛 code='bad-password'，
 * 错误信息里不含任何盐/清单/文件名，避免泄露元数据。
 */
export function openRepoKey(meta, password) {
  assertRepoMetaShape(meta)
  const check = validatePassword(password)
  if (!check.ok) throw repoError('bad-password', '密码不正确')
  const { N, r, p, salt } = kdfParamsFromMeta(meta)
  const masterKey = scryptSync(normalizePasswordForKdf(password), salt, KDF.keyBytes, {
    N, r, p, maxmem: KDF.maxmem,
  })
  try {
    return verifyMasterKey(meta, masterKey)
  } catch (error) {
    // 对外统一成「密码不正确」：不区分是规则不合规还是 keyCheck 不匹配
    if (error && error.code === 'bad-password') throw repoError('bad-password', '密码不正确')
    throw error
  }
}

/* ------------------------------------------------------------------ 命名 */

function hmac(masterKey, domain) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== KDF.keyBytes) {
    throw repoError('no-key', '仓库密钥不可用（未解锁）')
  }
  return createHmac('sha256', masterKey).update(domain).digest()
}

function hmacHex(masterKey, domain) {
  return hmac(masterKey, domain).toString('hex')
}

/** 块名（相对仓库根的 posix 路径）：chunks/<ab>/<cd>/<hmac>.cbin */
export function chunkName(masterKey, plainHash) {
  if (!isPlainHash(plainHash)) throw repoError('bad-hash', 'plainHash 必须是 64 位小写 hex')
  const name = hmacHex(masterKey, `chunk:${plainHash}`)
  return `chunks/${name.slice(0, 2)}/${name.slice(2, 4)}/${name}.cbin`
}

/** 块密钥（由 plainHash 派生；解密端用 chunkKeyFromName）。 */
export function chunkKey(masterKey, plainHash) {
  return hmac(masterKey, `chunkkey:${chunkName(masterKey, plainHash)}`)
}

export function chunkKeyFromName(masterKey, name) {
  assertName(name, 'chunk')
  return hmac(masterKey, `chunkkey:${name}`)
}

export function manifestName(masterKey, snapshotId) {
  const id = String(snapshotId == null ? '' : snapshotId)
  if (!id) throw repoError('bad-args', '缺少 snapshotId')
  return `manifests/${hmacHex(masterKey, `manifest:${id}`)}.mbin`
}

export function manifestKeyFromName(masterKey, name) {
  assertName(name, 'manifest')
  return hmac(masterKey, `manifestkey:${name}`)
}

export function packName(masterKey, packId) {
  const id = String(packId == null ? '' : packId)
  if (!id) throw repoError('bad-args', '缺少 packId')
  return `packs/${hmacHex(masterKey, `pack:${id}`)}.pbin`
}

export function packKeyFromName(masterKey, name) {
  assertName(name, 'pack')
  return hmac(masterKey, `packkey:${name}`)
}

/* -------------------------------------------------------------- 信封加解密 */

function asBuffer(buf) {
  if (Buffer.isBuffer(buf)) return buf
  if (buf instanceof Uint8Array) return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (typeof buf === 'string') return Buffer.from(buf, 'latin1')
  throw repoError('bad-input', '密文必须是 Buffer/Uint8Array')
}

function seal(magic, key, name, plaintext) {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(name, 'utf8'))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([magic, nonce, body, cipher.getAuthTag()])
}

function unseal(magic, key, name, envelope) {
  const buf = asBuffer(envelope)
  if (buf.length < magic.length + NONCE_BYTES + TAG_BYTES) {
    throw repoError('corrupt', '密文长度不足（文件被截断）')
  }
  if (!buf.subarray(0, magic.length).equals(magic)) {
    throw repoError('corrupt', '文件头 magic 不匹配（不是本格式的密文）')
  }
  const nonce = buf.subarray(magic.length, magic.length + NONCE_BYTES)
  const tag = buf.subarray(buf.length - TAG_BYTES)
  const body = buf.subarray(magic.length + NONCE_BYTES, buf.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(Buffer.from(name, 'utf8'))
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    // GCM tag 校验失败：密文被改过、被换了 name、或密钥不匹配
    throw repoError('integrity', `密文校验失败（${nameKind(name) || 'file'} 被篡改或密钥不匹配）`)
  }
}

/* --------------------------------------------------------------------- 块 */

/** 加密一个内容块；buf 必须真的等于 plainHash（否则抛 code='integrity'）。 */
export function encryptChunk(masterKey, plainHash, buf) {
  if (!isPlainHash(plainHash)) throw repoError('bad-hash', 'plainHash 必须是 64 位小写 hex')
  const data = asBuffer(buf)
  const actual = sha256hex(data)
  if (actual !== plainHash) {
    throw repoError('integrity', `待加密内容与 plainHash 不符（期望 ${plainHash.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`)
  }
  const name = chunkName(masterKey, plainHash)
  return seal(MAGIC.chunk, chunkKeyFromName(masterKey, name), name, data)
}

/**
 * 解密一个内容块并校验完整性：
 *   - 密文 AAD 绑定 name（换名/换块 → GCM 失败 → code='integrity'）；
 *   - 解密后 sha256(plaintext) 必须对应 name（chunkName(sha256) === name）；
 *   - 传入 plainHash 时额外强校验 sha256(plaintext) === plainHash。
 * 返回明文 Buffer。
 */
export function decryptChunk(masterKey, name, buf, plainHash = null) {
  assertName(name, 'chunk')
  const plain = unseal(MAGIC.chunk, chunkKeyFromName(masterKey, name), name, buf)
  const actual = sha256hex(plain)
  let nameMatches = false
  try { nameMatches = chunkName(masterKey, actual) === name } catch { nameMatches = false }
  if (!nameMatches) throw repoError('integrity', '块内容与文件名（keyed HMAC）不匹配，拒绝使用')
  if (plainHash != null) {
    const want = String(plainHash)
    if (!isPlainHash(want)) throw repoError('bad-hash', 'plainHash 必须是 64 位小写 hex')
    if (actual !== want) {
      throw repoError('integrity', `块内容 sha256 与清单不符（期望 ${want.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`)
    }
  }
  return plain
}

/* ------------------------------------------------------------------- 清单 */

/** 加密清单：obj 为 {version, snapshot, exportedAt, prevManifest, seq}。 */
export function encryptManifest(masterKey, name, obj) {
  assertName(name, 'manifest')
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw repoError('bad-args', '清单必须是对象')
  const snapshotId = obj.snapshot && obj.snapshot.id
  if (!snapshotId) throw repoError('bad-args', '清单缺少 snapshot.id')
  if (manifestName(masterKey, snapshotId) !== name) {
    throw repoError('bad-name', '清单名与 snapshot.id 不匹配（HMAC 绑定失败）')
  }
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8')
  return seal(MAGIC.manifest, manifestKeyFromName(masterKey, name), name, plaintext)
}

/** 解密清单并校验清单名与 snapshot.id 的 HMAC 绑定；返回明文对象（含 files 映射）。 */
export function decryptManifest(masterKey, name, buf) {
  assertName(name, 'manifest')
  const plain = unseal(MAGIC.manifest, manifestKeyFromName(masterKey, name), name, buf)
  let obj
  try {
    obj = JSON.parse(plain.toString('utf8'))
  } catch {
    throw repoError('corrupt', '清单不是合法 JSON（解密后损坏）')
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw repoError('corrupt', '清单结构非法')
  const snapshotId = obj.snapshot && obj.snapshot.id
  if (!snapshotId) throw repoError('corrupt', '清单缺少 snapshot.id')
  if (manifestName(masterKey, snapshotId) !== name) {
    throw repoError('integrity', '清单内容与清单名（keyed HMAC）不匹配，拒绝使用')
  }
  return obj
}

/* --------------------------------------------------------------------- 包 */

/**
 * 打一个传输包：
 *   plaintext = JSON header（一行，以 \n 结尾）|| 各记录体（按 entries 顺序拼接）
 *   header    = { version, kind, packId, createdAt, entries:[{name, plainHash|null, size, sha256}] }
 * 记录体 = 仓库文件密文（.cbin / .mbin / recovery-kit 文件原样字节）；
 * sha256 是记录体的 sha256，供接收端先验后解。
 *
 * entries 允许仓库白名单里的任意文件：
 *   - chunks/…   块（必须带 plainHash，用于接收端复核）
 *   - manifests/… 清单（plainHash=null）
 *   - recovery-kit/… 离线恢复工具（plainHash=null；面板 syncToPeer 会把 kit 一起同步给子机）
 * 包本身只是搬运工，不改变逻辑存储；接收端写盘前必须自己再过一遍 name 白名单。
 *
 * @param {Buffer} masterKey
 * @param {string} name packName(masterKey, packObj.packId)
 * @param {object} packObj 额外 header 字段（必须含 packId）
 * @param {Array<{name: string, plainHash?: string|null, data: Buffer}>} records
 * @returns {Buffer} 包密文
 */
export function encryptPack(masterKey, name, packObj, records) {
  assertName(name, 'pack')
  const header = { ...(packObj || {}) }
  const packId = header.packId != null ? String(header.packId) : ''
  if (!packId) throw repoError('bad-args', '打包缺少 packId')
  if (packName(masterKey, packId) !== name) {
    throw repoError('bad-name', '包名与 packId 不匹配（HMAC 绑定失败）')
  }
  const list = Array.isArray(records) ? records : []
  const entries = []
  const bodies = []
  for (const record of list) {
    if (!record || typeof record !== 'object') throw repoError('bad-args', '记录必须是对象')
    if (!isRepoName(record.name)) {
      throw repoError('bad-name', '包记录必须是仓库白名单内的文件名（chunks/…、manifests/…、recovery-kit/…）')
    }
    const kind = nameKind(record.name)
    const plainHash = record.plainHash == null ? null : String(record.plainHash)
    if (plainHash != null && !isPlainHash(plainHash)) throw repoError('bad-hash', '记录的 plainHash 不合法')
    if (kind === 'chunk' && plainHash == null) throw repoError('bad-hash', '块记录必须带 plainHash')
    const data = asBuffer(record.data)
    entries.push({ name: record.name, plainHash, size: data.length, sha256: sha256hex(data) })
    bodies.push(data)
  }
  const plainHeader = {
    version: 1,
    kind: header.kind || 'files',
    ...header,
    packId,
    entries,
    createdAt: Number.isFinite(Number(header.createdAt)) ? Number(header.createdAt) : Date.now(),
  }
  const plaintext = Buffer.concat([Buffer.from(JSON.stringify(plainHeader) + '\n', 'utf8'), ...bodies])
  return seal(MAGIC.pack, packKeyFromName(masterKey, name), name, plaintext)
}

/**
 * 解包：返回 {header, records:[{name, plainHash|null, size, sha256, data}]}。
 * 逐记录校验 sha256（记录体完整性），并校验包名 ↔ header.packId 的绑定。
 */
export function decryptPack(masterKey, name, buf) {
  assertName(name, 'pack')
  const plaintext = unseal(MAGIC.pack, packKeyFromName(masterKey, name), name, buf)
  const nl = plaintext.indexOf(0x0a)
  if (nl < 0) throw repoError('corrupt', '包结构非法（缺少 header 分隔符）')
  let header
  try {
    header = JSON.parse(plaintext.subarray(0, nl).toString('utf8'))
  } catch {
    throw repoError('corrupt', '包 header 不是合法 JSON')
  }
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw repoError('corrupt', '包 header 结构非法')
  const packId = header.packId != null ? String(header.packId) : ''
  if (!packId) throw repoError('corrupt', '包 header 缺少 packId')
  if (packName(masterKey, packId) !== name) {
    throw repoError('integrity', '包内容与包名（keyed HMAC）不匹配，拒绝使用')
  }
  const entries = Array.isArray(header.entries) ? header.entries : []
  const body = plaintext.subarray(nl + 1)
  const records = []
  let offset = 0
  for (const entry of entries) {
    const size = Number(entry && entry.size)
    if (!Number.isInteger(size) || size < 0) throw repoError('corrupt', '包记录长度非法')
    if (offset + size > body.length) throw repoError('corrupt', '包记录被截断')
    const data = body.subarray(offset, offset + size)
    offset += size
    if (!isRepoName(entry.name)) throw repoError('corrupt', '包记录的文件名非法')
    const plainHash = entry.plainHash == null ? null : String(entry.plainHash)
    if (plainHash != null && !isPlainHash(plainHash)) throw repoError('corrupt', '包记录 plainHash 非法')
    const digest = sha256hex(data)
    if (digest !== entry.sha256) throw repoError('integrity', '包记录 sha256 不符（包被篡改或截断）')
    records.push({ name: entry.name, plainHash, size, sha256: digest, data })
  }
  if (offset !== body.length) throw repoError('corrupt', '包尾部有多余数据')
  return { header, records }
}

/** 供本模块之外（repo/CLI）复用的 sha256，避免各处重复 import。 */
export { sha256hex }
