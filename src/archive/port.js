/**
 * archive port（面板/编排侧窄接口）适配层。
 *
 * 背景：`src/offsite.js`（异地副本编排）只想要一组「命名 + 加解密 + 打包」函数，
 * 由它自己负责仓库文件搬运/ledger/子机 RPC。它按 ARCHIVE_PORT_METHODS 这一组**对象参数**
 * 签名调用（见 offsite.js 顶部注释）。而本仓库核心模块（format.js/repo.js/export.js/import.js）
 * 暴露的是位置参数签名 + LocalRepo 类（CLI 与测试在用）。
 *
 * 本文件把两边对上，**不改动核心签名**：
 *   - key      = LocalRepo 实例（有 .dir / .meta / .masterKey），本模块的 masterKeyOf(key) 返回 Buffer；
 *   - 12 个方法与 offsite.js 的 ARCHIVE_PORT_METHODS 一一对应；
 *   - 包（pack）既可装块也可装清单（记录体是仓库里的密文原样字节）。
 *
 * 用法（offsite.js 侧）：
 *   const port = await import(new URL('./archive/port.js', import.meta.url).href)
 *   // 或把 './archive/port.js' 放在 createArchivePort 的模块列表**最前面**（避免同名的
 *   //   format.js openRepoKey 位置参数版本被 pick 到）。
 *
 * 所有方法都在出错时抛带 code 的错误；绝不记录密码/密钥/明文。
 */
import { randomBytes } from 'node:crypto'
import {
  chunkName as chunkNameRaw,
  createRepoMeta,
  decryptChunk,
  decryptManifest,
  decryptPack,
  encryptChunk,
  encryptManifest,
  encryptPack,
  manifestName as manifestNameRaw,
  openRepoKey as openRepoKeyRaw,
  packName as packNameRaw,
  repoError,
  validatePassword,
  verifyMasterKey,
} from './format.js'
import { LocalRepo, readRepoMeta } from './repo.js'
import { sha256hex } from '../util.js'

/** 与 offsite.js 的 ARCHIVE_PORT_METHODS 对齐（供对方自检）。 */
export const ARCHIVE_PORT_METHODS = Object.freeze([
  'initRepo', 'openRepoKey', 'keyFromMasterKey', 'masterKeyOf',
  'chunkName', 'manifestName', 'encodeChunk', 'decodeChunk',
  'encodeManifest', 'decodeManifest', 'buildPack', 'unpackPack',
])

function masterKeyOf(key) {
  const masterKey = key && Buffer.isBuffer(key.masterKey) ? key.masterKey : null
  if (!masterKey || masterKey.length !== 32) {
    throw repoError('no-key', '仓库未解锁（请先在面板输入密码）')
  }
  return masterKey
}

/** 把 masterKey 挂到已存在的 repo.json 上（DPAPI 缓存解锁）。 */
export async function keyFromMasterKey({ dir, masterKey } = {}) {
  const root = String(dir || '')
  const meta = await readRepoMeta(root)
  if (!meta) throw repoError('no-repo', `仓库不存在或 repo.json 无法解析：${root}`)
  const buf = Buffer.isBuffer(masterKey) ? Buffer.from(masterKey) : Buffer.from(masterKey || [])
  verifyMasterKey(meta, buf)
  return new LocalRepo({ dir: root, meta, masterKey: buf })
}

/** ({ dir, password, chunkSize }) -> key（LocalRepo） */
export async function initRepo({ dir, password, chunkSize } = {}) {
  return LocalRepo.init({ dir, password, chunkSize })
}

/** ({ dir, password }) -> key（密码错抛 code='bad-password'） */
export async function openRepoKey({ dir, password } = {}) {
  return LocalRepo.open({ dir, password })
}

export { masterKeyOf }

/** ({ key, plainHash }) -> 'chunks/ab/cd/<64>.cbin' */
export async function chunkName({ key, plainHash } = {}) {
  return chunkNameRaw(masterKeyOf(key), plainHash)
}

/** ({ key, snapshotId }) -> 'manifests/<64>.mbin' */
export async function manifestName({ key, snapshotId } = {}) {
  return manifestNameRaw(masterKeyOf(key), snapshotId)
}

/** ({ key, plainBuf }) -> { name, buf, plainHash } */
export async function encodeChunk({ key, plainBuf } = {}) {
  const masterKey = masterKeyOf(key)
  const data = Buffer.isBuffer(plainBuf) ? plainBuf : Buffer.from(plainBuf)
  const plainHash = sha256hex(data)
  const name = chunkNameRaw(masterKey, plainHash)
  return { name, buf: encryptChunk(masterKey, plainHash, data), plainHash }
}

/** ({ key, name, buf }) -> { plainBuf, plainHash }（解密 + 校验 sha256 对应 name） */
export async function decodeChunk({ key, name, buf } = {}) {
  const plainBuf = decryptChunk(masterKeyOf(key), name, buf)
  return { plainBuf, plainHash: sha256hex(plainBuf) }
}

/** ({ key, manifest }) -> { name, buf, sha256 }；manifest.snapshot.id 决定清单名。 */
export async function encodeManifest({ key, manifest } = {}) {
  const masterKey = masterKeyOf(key)
  const snapshotId = manifest && manifest.snapshot && manifest.snapshot.id
  if (!snapshotId) throw repoError('bad-args', '清单缺少 snapshot.id')
  const name = manifestNameRaw(masterKey, snapshotId)
  const buf = encryptManifest(masterKey, name, manifest)
  return { name, buf, sha256: sha256hex(buf) }
}

/** ({ key, name, buf }) -> { manifest, sha256 }（校验清单名 ↔ snapshot.id 绑定） */
export async function decodeManifest({ key, name, buf } = {}) {
  const manifest = decryptManifest(masterKeyOf(key), name, buf)
  return { manifest, sha256: sha256hex(buf) }
}

/**
 * ({ key, entries: [{ name, buf, plainHash? }], packId? }) -> { name, buf, packId, entries }
 * entries 里的 buf 是**仓库密文原样字节**（块 .cbin / 清单 .mbin / recovery-kit 文件都可以）。
 * 块记录若没给 plainHash，会先解密自校验再算出来（坏块在这里就会抛 integrity）；
 * manifests / recovery-kit 记录 plainHash=null（包只是搬运工，接收端写盘前会自己再过白名单）。
 */
export async function buildPack({ key, entries = [], packId } = {}) {
  const masterKey = masterKeyOf(key)
  const id = packId ? String(packId) : randomBytes(8).toString('hex')
  const name = packNameRaw(masterKey, id)
  const records = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object' || !entry.name) throw repoError('bad-args', 'pack entry 缺少 name')
    const label = String(entry.name)
    const data = Buffer.isBuffer(entry.buf) ? entry.buf : Buffer.from(entry.buf || [])
    let plainHash = entry.plainHash == null ? null : String(entry.plainHash)
    if (plainHash == null && label.startsWith('chunks/')) {
      // 从密文解出明文哈希：顺带自校验，坏块/坏名在这里报 integrity
      plainHash = sha256hex(decryptChunk(masterKey, label, data))
    }
    records.push({ name: label, plainHash, data })
  }
  return {
    name,
    buf: encryptPack(masterKey, name, { packId: id, kind: 'files' }, records),
    packId: id,
    entries: records.length,
  }
}

/** ({ key, name, buf }) -> [{ name, buf, plainHash, sha256 }]（记录体已校验 sha256） */
export async function unpackPack({ key, name, buf } = {}) {
  const opened = decryptPack(masterKeyOf(key), name, buf)
  return opened.records.map((record) => ({
    name: record.name,
    buf: record.data,
    plainHash: record.plainHash,
    sha256: record.sha256,
  }))
}

/** 便捷：密码规则校验（面板表单可直接用；不涉及仓库）。 */
export function checkPassword(password) {
  return validatePassword(password)
}

/** 便捷：建仓库头（不落盘，测试/预检可用）。 */
export function newRepoMeta({ password, chunkSize } = {}) {
  const { meta } = createRepoMeta({ password, chunkSize })
  return meta
}
