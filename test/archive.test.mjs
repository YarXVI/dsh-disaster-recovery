/**
 * 异地加密去重仓库核心测试（docs/OFFSITE-ARCHIVE.md §8 验收清单 1-6、8-9）。
 *
 * 铁律：全部在 os.tmpdir() 的 mkdtemp 临时目录里跑，home / store / repo 都是临时的，
 * 绝不读写真实的 %USERPROFILE%\.dsh 或 D:\dsh-backup。
 *
 * 覆盖：
 *   1. 密码规则（≥9、字母+数字）、超长密码、错误密码
 *   2. AES-GCM 篡改检测（块 / 清单 / 包）
 *   3. 块 / 清单 / 包 roundtrip、命名白名单、repo 原子写
 *   4. 去重：同快照重导出新增 0 块；改一个文件只新增相关块
 *   5. pin：导出期间并发 prune/新快照不删 pinned 快照及其块；pinned 快照拒绝 delete
 *   6. 导出 → 导入 → 恢复（临时 home）；演练逐文件 sha256
 *   8. 拆除本机仓库后仅凭密文副本 + 密码恢复（临时 home）
 *   9. 缺块 / 篡改块：verify 列出具体块名，import 拒绝且不注册清单（不部分恢复）
 *   10. CLI：init→export→list→verify→drill→status，真实 store 只读演练（临时副本）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BackupEngine, entryChunks } from '../src/engine.js'
import * as fmt from '../src/archive/format.js'
import { LocalRepo, isRepoDir, readRepoMeta } from '../src/archive/repo.js'
import {
  checkLedgerChain, exportSnapshot, readLedger,
} from '../src/archive/export.js'
import { importSnapshotToEngine, verifyRemoteSnapshot } from '../src/archive/import.js'
import * as port from '../src/archive/port.js'
import {
  ensureRecoveryKit, recoveryKitStatus, RECOVERY_KIT_DIRNAME, RECOVERY_KIT_FORMAT,
} from '../src/archive/recovery.js'
import {
  dpapiAvailable, parseDpapiSecret, passwordFromDpapi, readDpapiBlob, secretFromDpapi,
} from '../src/archive/dpapi.js'
import { sha256hex } from '../src/util.js'

const RECOVER_PATH = fileURLToPath(new URL('../scripts/recover.mjs', import.meta.url))

const PASSWORD = 'correct-horse-9'
const CLI_PATH = fileURLToPath(new URL('../scripts/archive.mjs', import.meta.url))

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** 造一个“像真的 DSH_HOME”的临时 home（含排除项 dsh-runtimes、空文件、多块文件）。 */
async function makeHome(prefix = 'dbk-arch-home-') {
  const home = await tempDir(prefix)
  await fs.mkdir(path.join(home, 'sessions', '--D-x--', 'session-1'), { recursive: true })
  await fs.mkdir(path.join(home, 'storages'), { recursive: true })
  await fs.mkdir(path.join(home, 'dsh-runtimes', 'node'), { recursive: true })
  await fs.writeFile(path.join(home, 'workspace.json'), '{"v":1}')
  await fs.writeFile(path.join(home, 'sessions', '--D-x--', 'session-1', 'session.v4.jsonl.zstd'), 'session-body')
  await fs.writeFile(path.join(home, 'storages', 'db.json'), '{"rows":[1,2,3]}')
  await fs.writeFile(path.join(home, 'empty.txt'), '')
  await fs.writeFile(path.join(home, 'dsh-runtimes', 'node', 'node.exe'), 'runtime-binary')
  return home
}

function makeEngine(home, root, extra = {}) {
  return new BackupEngine({
    home,
    config: { root, watch: false, scanMs: 3_600_000, debounceMs: 0, minIntervalMs: 0, ...extra },
    log: () => {},
    hostname: 'arch-host',
  })
}

async function startEngine(home, root, extra = {}) {
  const engine = makeEngine(home, root, extra)
  await engine.start()
  return engine
}

/** 新建一个加密仓库（默认 <base>/offsite/repo，ledger 在 <base>/offsite/ledger.json）。 */
async function newRepo(base, { chunkSize } = {}) {
  const dir = path.join(base, 'offsite', 'repo')
  const repo = await LocalRepo.init({ dir, password: PASSWORD, chunkSize })
  return { repo, dir }
}

/** 目录树摘要（相对路径 → sha256 + size），用来证明“整棵树没被写过”。 */
async function treeDigest(root) {
  const out = {}
  const stack = ['']
  while (stack.length) {
    const relDir = stack.pop()
    const absDir = relDir ? path.join(root, ...relDir.split('/')) : root
    let entries = []
    try { entries = await fs.readdir(absDir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      const abs = path.join(absDir, entry.name)
      if (entry.isDirectory()) { stack.push(rel); continue }
      if (!entry.isFile()) continue
      const buf = await fs.readFile(abs)
      out[rel] = `${buf.length}:${sha256hex(buf)}`
    }
  }
  return out
}

/** 快照里每个文件的内容（按清单块拼接），用于恢复后逐文件比对。 */
async function readSnapshotFiles(engine, manifest) {
  const out = {}
  for (const [rel, entry] of Object.entries(manifest.files || {})) {
    const parts = []
    for (const hash of entryChunks(entry)) parts.push(await engine.store.get(hash))
    out[rel] = Buffer.concat(parts)
  }
  return out
}

function runCli(args, { input, env = {} } = {}) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 120_000,
  })
  return {
    code: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error,
  }
}

function parseJsonOutput(run) {
  try {
    return JSON.parse(run.stdout)
  } catch (error) {
    throw new Error(`CLI stdout 不是 JSON：${run.stdout}\nstderr：${run.stderr}`)
  }
}

/** 跑 recovery-kit 的 recover.mjs（cliPath 可以是 kit 副本或开发目录里的 scripts/recover.mjs）。 */
function runRecover(cliPath, args, { input, env = {} } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 120_000,
  })
  return {
    code: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error,
  }
}

/** 造一个「子机视角」的仓库副本：<peerRoot>/offsite/repo（quarantine 也会落在 <peerRoot>/offsite 下）。 */
async function copyRepoForPeer(repoDir) {
  const peerRoot = await tempDir('dbk-arch-kit-peer-')
  const peerRepo = path.join(peerRoot, 'offsite', 'repo')
  await fs.mkdir(path.dirname(peerRepo), { recursive: true })
  await fs.cp(repoDir, peerRepo, { recursive: true })
  return { peerRoot, peerRepo }
}

/* ═══════════════════════════════════════════════════════════ 1. 密码规则 */

test('validatePassword: ≥9 位且必须同时含字母和数字', () => {
  const bad = [
    [undefined, 'password-required'],
    ['', 'password-required'],
    [12345678, 'password-required'],
    ['abcdefgh', 'password-too-short'], // 8 位
    ['abcdefghi', 'password-needs-digit'], // ≥9 但没数字
    ['123456789', 'password-needs-letter'], // ≥9 但没字母
    ['abc12345', 'password-too-short'], // 8 位
    ['        9', 'password-needs-letter'], // 8 空格 + 数字 = 9 位但没字母
  ]
  for (const [value, code] of bad) {
    const result = fmt.validatePassword(value)
    assert.equal(result.ok, false, `${String(value)} 必须被拒`)
    assert.equal(result.code, code, `${String(value)} → ${code}`)
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0)
  }
  for (const value of ['abcdefg1x', 'abcd1234x', 'Aa1aaaaaa', 'a1' + 'b'.repeat(7), 'p@ssw0rd!!']) {
    const result = fmt.validatePassword(value)
    assert.equal(result.ok, true, `${value} 应通过：${JSON.stringify(result)}`)
  }
  // 255/256 位（验收 §8.1 的“超长可正常导出/恢复”）在纯规则层必须合法
  assert.equal(fmt.validatePassword('a1' + 'x'.repeat(254)).ok, true)
  // 超过 4096：仍然合法，但会被标记 truncated（KDF 只用前 4096 个字符）
  const huge = fmt.validatePassword('a1' + 'x'.repeat(5000))
  assert.equal(huge.ok, true)
  assert.equal(huge.truncated, true)
  assert.equal(fmt.normalizePasswordForKdf('a1' + 'x'.repeat(5000)).length <= 4096 * 4, true)
  // NFKC 归一化：全角字符与半角归一后一致
  assert.equal(
    fmt.normalizePasswordForKdf('ａｂｃ１２３４５６').toString(),
    fmt.normalizePasswordForKdf('abc123456').toString(),
  )
})

test('createRepoMeta/openRepoKey: 超长密码可导出恢复，错密码抛 bad-password 且不泄露', async () => {
  const longPassword = 'a1' + 'x'.repeat(300) // ≥256 位（验收 §8.1）
  const { meta, masterKey } = fmt.createRepoMeta({ password: longPassword, chunkSize: 65536 })
  assert.equal(meta.format, 'dsh-dr-repo')
  assert.equal(meta.version, 1)
  assert.match(meta.repoId, /^[0-9a-f]{16}$/)
  assert.equal(meta.cipher, 'aes-256-gcm')
  assert.equal(meta.chunkSize, 65536)
  assert.deepEqual(
    { N: meta.kdf.N, r: meta.kdf.r, p: meta.kdf.p, name: meta.kdf.name },
    { N: 131072, r: 8, p: 1, name: 'scrypt' },
  )
  assert.equal(Buffer.from(meta.kdf.salt, 'base64').length, 16, '盐必须是 16B 随机值')
  assert.equal(masterKey.length, 32)
  // repo.json 里绝不能出现密码/密钥
  const metaJson = JSON.stringify(meta)
  assert.ok(!metaJson.includes(longPassword))
  assert.ok(!metaJson.includes(masterKey.toString('hex')))
  assert.ok(!/"(password|masterKey|key|secret)"/i.test(metaJson), 'repo.json 不含密码字段')

  const reopened = fmt.openRepoKey(meta, longPassword)
  assert.deepEqual(reopened, masterKey, '同一密码 + 盐必须得到同一 masterKey')

  for (const wrong of ['wrong-password-9', 'a1' + 'x'.repeat(299), 'abcd1234x']) {
    let error = null
    try { fmt.openRepoKey(meta, wrong) } catch (caught) { error = caught }
    assert.ok(error, `错密码 ${wrong.slice(0, 12)}… 必须失败`)
    assert.equal(error.code, 'bad-password')
    assert.ok(!String(error.message).includes(longPassword))
    assert.ok(!String(error.message).includes(meta.repoId), '错误信息不含 salt/repoId 之外的元数据')
  }
  // 弱密码直接抛 weak-password（面板/CLI 用于提示规则）
  assert.throws(() => fmt.createRepoMeta({ password: 'abcdefgh' }), (error) => {
    assert.equal(error.code, 'weak-password')
    assert.match(error.message, /至少 9 位/)
    return true
  })
  // 被篡改的 repo.json（KDF 参数异常）必须 fail-closed
  const evil = { ...meta, kdf: { ...meta.kdf, N: 2 ** 30 } }
  assert.throws(() => fmt.openRepoKey(evil, longPassword), (error) => error.code === 'bad-repo')
  assert.throws(() => fmt.openRepoKey({ ...meta, format: 'other' }, longPassword), (error) => error.code === 'bad-repo')
  assert.throws(() => fmt.openRepoKey({ ...meta, keyCheck: undefined }, longPassword), (error) => error.code === 'bad-repo')
})

/* ═════════════════════════════════════════════ 3. 命名 / 块·清单·包 roundtrip */

test('chunkName/manifestName/packName 命中设计文档白名单且密钥派生自洽', () => {
  const { masterKey } = fmt.createRepoMeta({ password: PASSWORD })
  const hash = sha256hex(Buffer.from('hello'))
  const name = fmt.chunkName(masterKey, hash)
  assert.match(name, /^chunks\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.cbin$/)
  assert.ok(fmt.isRepoName(name))
  assert.equal(fmt.nameKind(name), 'chunk')
  assert.equal(fmt.chunkName(masterKey, hash), name, '确定性命名')
  assert.notEqual(fmt.chunkName(masterKey, sha256hex(Buffer.from('hello2'))), name)
  assert.deepEqual(fmt.chunkKey(masterKey, hash), fmt.chunkKeyFromName(masterKey, name), '解密端仅凭 name 可派生同一密钥')
  assert.equal(fmt.chunkKey(masterKey, hash).length, 32)

  const mname = fmt.manifestName(masterKey, '20261028-120000-change')
  assert.match(mname, /^manifests\/[0-9a-f]{64}\.mbin$/)
  assert.equal(fmt.nameKind(mname), 'manifest')
  assert.equal(fmt.manifestName(masterKey, '20261028-120000-change'), mname)

  const pname = fmt.packName(masterKey, 'pack-1')
  assert.match(pname, /^packs\/[0-9a-f]{64}\.pbin$/)
  assert.equal(fmt.nameKind(pname), 'pack')

  // 白名单：路径穿越/非法扩展名/未知目录一律拒绝
  for (const bad of [
    'chunks/zz/zz/x.cbin', 'chunks/aa/bb/../../x.cbin', '../repo.json', 'repo.json.bak',
    'chunks/aa/bb/' + 'z'.repeat(64) + '.cbin', 'manifests/x.txt', 'packs/../evil.pbin',
  ]) {
    assert.equal(fmt.isRepoName(bad), false, `${bad} 应被白名单拒绝`)
  }
  assert.equal(fmt.isRepoName('repo.json'), true)
  assert.equal(fmt.isRepoName('recovery-kit/recover.mjs'), true)
  assert.throws(() => fmt.chunkName(masterKey, 'not-a-hash'), (error) => error.code === 'bad-hash')
})

test('encryptChunk/decryptChunk roundtrip + AES-GCM 逐字节篡改检测', () => {
  const { masterKey } = fmt.createRepoMeta({ password: PASSWORD })
  const plain = randomBytes(65536)
  const hash = sha256hex(plain)
  const name = fmt.chunkName(masterKey, hash)
  const envelope = fmt.encryptChunk(masterKey, hash, plain)

  // 布局：magic(4) | nonce(12) | ciphertext | tag(16)
  assert.equal(envelope.subarray(0, 4).toString('ascii'), 'DRA1')
  assert.equal(envelope.length, 4 + 12 + plain.length + 16)
  assert.equal(envelope.includes(plain), false, '密文里不能出现明文')

  // 3 参调用（只有 name）即可解密并校验 sha256(plaintext) 对应 name
  assert.deepEqual(fmt.decryptChunk(masterKey, name, envelope), plain)
  // 传 plainHash 时额外强校验
  assert.deepEqual(fmt.decryptChunk(masterKey, name, envelope, hash), plain)

  // 篡改 magic / nonce / 密文 / tag 的任意 1 字节都必须报错
  const flip = (offset) => {
    const copy = Buffer.from(envelope)
    copy[offset] ^= 0xff
    return copy
  }
  for (const offset of [0, 3, 4, 10, 16, 20, envelope.length - 17, envelope.length - 1]) {
    assert.throws(
      () => fmt.decryptChunk(masterKey, name, flip(offset)),
      (error) => ['integrity', 'corrupt'].includes(error.code),
      `offset ${offset} 篡改必须被检测`,
    )
  }
  // 截断
  assert.throws(() => fmt.decryptChunk(masterKey, name, envelope.subarray(0, envelope.length - 1)), (error) => error.code === 'integrity' || error.code === 'corrupt')
  // 换 name（换块）：AAD 绑定失败
  const otherName = fmt.chunkName(masterKey, sha256hex(Buffer.from('other')))
  assert.throws(() => fmt.decryptChunk(masterKey, otherName, envelope), (error) => error.code === 'integrity')
  // 传错 plainHash
  assert.throws(() => fmt.decryptChunk(masterKey, name, envelope, sha256hex(Buffer.from('nope'))), (error) => error.code === 'integrity')
  // 加密端内容与 plainHash 不符
  assert.throws(() => fmt.encryptChunk(masterKey, sha256hex(Buffer.from('x')), plain), (error) => error.code === 'integrity')
  assert.throws(() => fmt.decryptChunk(Buffer.alloc(32), name, envelope), (error) => error.code === 'integrity')
})

test('encryptManifest/decryptManifest roundtrip + 篡改/换名检测', () => {
  const { masterKey } = fmt.createRepoMeta({ password: PASSWORD })
  const snapshotId = '20261028-120000-change'
  const name = fmt.manifestName(masterKey, snapshotId)
  const payload = {
    version: 1,
    snapshot: {
      id: snapshotId,
      at: 1793000000000,
      reason: 'change',
      chunkSize: 65536,
      stats: { files: 1, bytes: 5 },
      files: { 'a.txt': { s: 5, m: 1, c: [sha256hex(Buffer.from('hello'))] } },
    },
    exportedAt: 1793000000001,
    prevManifest: null,
    seq: 1,
  }
  const envelope = fmt.encryptManifest(masterKey, name, payload)
  assert.equal(envelope.subarray(0, 4).toString('ascii'), 'DRM1')
  assert.deepEqual(fmt.decryptManifest(masterKey, name, envelope), payload)

  // 篡改 1 字节
  const tampered = Buffer.from(envelope)
  tampered[tampered.length - 1] ^= 0xff
  assert.throws(() => fmt.decryptManifest(masterKey, name, tampered), (error) => error.code === 'integrity')

  // 清单名 ↔ snapshot.id 的 HMAC 绑定：换名必须失败
  const otherName = fmt.manifestName(masterKey, 'other-snapshot')
  assert.throws(() => fmt.encryptManifest(masterKey, otherName, payload), (error) => error.code === 'bad-name')
  // 用别的清单名解密（内容 id 不匹配）也必须失败
  const forged = { ...payload, snapshot: { ...payload.snapshot, id: 'other-snapshot' } }
  const forgedEnvelope = fmt.encryptManifest(masterKey, otherName, forged)
  assert.throws(() => fmt.decryptManifest(masterKey, name, forgedEnvelope), (error) => error.code === 'integrity')
  // 明文结构非法（缺 snapshot.id）
  assert.throws(() => fmt.encryptManifest(masterKey, name, { snapshot: {} }), (error) => error.code === 'bad-args')
})

test('encryptPack/decryptPack roundtrip + 篡改检测（含记录 intent）', () => {
  const { masterKey } = fmt.createRepoMeta({ password: PASSWORD })
  const packId = 'pack-0001'
  const name = fmt.packName(masterKey, packId)
  const records = []
  for (const text of ['alpha', 'bravo-bravo', '']) {
    const data = Buffer.from(text)
    const plainHash = sha256hex(data)
    const chunkName = fmt.chunkName(masterKey, plainHash)
    records.push({ name: chunkName, plainHash, data: fmt.encryptChunk(masterKey, plainHash, data) })
  }
  const envelope = fmt.encryptPack(masterKey, name, { packId, kind: 'chunks' }, records)
  assert.equal(envelope.subarray(0, 4).toString('ascii'), 'DRP1')

  const opened = fmt.decryptPack(masterKey, name, envelope)
  assert.equal(opened.header.packId, packId)
  assert.equal(opened.header.kind, 'chunks')
  assert.equal(opened.records.length, records.length)
  for (let index = 0; index < records.length; index += 1) {
    assert.equal(opened.records[index].name, records[index].name)
    assert.equal(opened.records[index].plainHash, records[index].plainHash)
    assert.equal(sha256hex(opened.records[index].data), sha256hex(records[index].data))
    assert.equal(opened.header.entries[index].sha256, sha256hex(records[index].data))
  }
  // 记录体还能直接解密回原文
  assert.equal(fmt.decryptChunk(masterKey, opened.records[0].name, opened.records[0].data).toString(), 'alpha')

  // 篡改任意位置
  for (const offset of [4, 20, Math.floor(envelope.length / 2), envelope.length - 1]) {
    const copy = Buffer.from(envelope)
    copy[offset] ^= 0xff
    assert.throws(
      () => fmt.decryptPack(masterKey, name, copy),
      (error) => ['integrity', 'corrupt'].includes(error.code),
      `pack 偏移 ${offset} 篡改必须被检测`,
    )
  }
  // 包名 ↔ packId 绑定
  assert.throws(
    () => fmt.decryptPack(masterKey, fmt.packName(masterKey, 'other-pack'), envelope),
    (error) => ['integrity', 'corrupt'].includes(error.code),
  )
  assert.throws(
    () => fmt.encryptPack(masterKey, fmt.packName(masterKey, 'other-pack'), { packId }, records),
    (error) => error.code === 'bad-name',
  )
})

test('pack 可以混装 recovery-kit 文件（面板 syncToPeer 会把 kit 同步给子机）', async () => {
  const base = await tempDir('dbk-arch-kitpack-')
  const { repo } = await newRepo(base, { chunkSize: 65536 })
  try {
    const masterKey = repo.masterKey
    // 真实仓库里的 kit 文件（init 已写入）
    const kitReadme = await fs.readFile(path.join(repo.dir, RECOVERY_KIT_DIRNAME, 'README.txt'))
    const kitRecover = await fs.readFile(path.join(repo.dir, RECOVERY_KIT_DIRNAME, 'recover.mjs'))
    const repoJson = await fs.readFile(path.join(repo.dir, 'repo.json'))
    // 一个真实块 + 一份清单 + kit 文件混装
    const plain = Buffer.from('pack-with-kit')
    const plainHash = sha256hex(plain)
    const chunkEnvelope = fmt.encryptChunk(masterKey, plainHash, plain)
    const manifestPayload = {
      version: 1,
      snapshot: { id: '20261028-150000-manual', at: Date.now(), reason: 'manual', chunkSize: 65536, stats: { files: 1, bytes: plain.length }, files: { 'a.txt': { s: plain.length, m: 1, c: [plainHash] } } },
      exportedAt: Date.now(), prevManifest: null, seq: 1,
    }
    const manifestName = fmt.manifestName(masterKey, manifestPayload.snapshot.id)
    const manifestEnvelope = fmt.encryptManifest(masterKey, manifestName, manifestPayload)

    const packId = 'kit-sync-0001'
    const name = fmt.packName(masterKey, packId)
    const records = [
      { name: fmt.chunkName(masterKey, plainHash), plainHash, data: chunkEnvelope },
      { name: manifestName, data: manifestEnvelope },
      { name: 'recovery-kit/README.txt', data: kitReadme },
      { name: 'recovery-kit/recover.mjs', data: kitRecover },
      { name: 'repo.json', data: repoJson },
    ]
    const envelope = fmt.encryptPack(masterKey, name, { packId, kind: 'files' }, records)
    const opened = fmt.decryptPack(masterKey, name, envelope)
    assert.equal(opened.records.length, records.length)
    for (let index = 0; index < records.length; index += 1) {
      assert.equal(opened.records[index].name, records[index].name)
      assert.equal(opened.records[index].plainHash, records[index].plainHash == null ? null : records[index].plainHash)
      assert.equal(sha256hex(opened.records[index].data), sha256hex(records[index].data))
    }
    // kit / repo.json 记录解出来就是原文件字节，plainHash 为 null
    assert.deepEqual(opened.records[2].data, kitReadme)
    assert.equal(opened.records[2].plainHash, null)
    assert.deepEqual(opened.records[4].data, repoJson)

    // 通过 port 层（面板实际走的路径）也能打/解
    const portKey = await LocalRepo.open({ dir: repo.dir, password: PASSWORD })
    try {
      const built = await port.buildPack({
        key: portKey,
        entries: [
          { name: 'recovery-kit/README.txt', buf: kitReadme },
          { name: 'recovery-kit/src/archive/format.js', buf: await fs.readFile(path.join(repo.dir, RECOVERY_KIT_DIRNAME, 'src', 'archive', 'format.js')) },
        ],
      })
      const unpacked = await port.unpackPack({ key: portKey, name: built.name, buf: built.buf })
      assert.deepEqual(unpacked.map((item) => item.name), ['recovery-kit/README.txt', 'recovery-kit/src/archive/format.js'])
      assert.deepEqual(unpacked[0].buf, kitReadme)
    } finally {
      portKey.close()
    }

    // 白名单外的名字仍然拒绝（不能让 pack 变成任意文件搬运工）
    assert.throws(
      () => fmt.encryptPack(masterKey, name, { packId }, [{ name: 'evil/x.bin', data: Buffer.from('x') }]),
      (error) => error.code === 'bad-name',
    )
    // 块记录仍然必须带 plainHash
    assert.throws(
      () => fmt.encryptPack(masterKey, name, { packId }, [{ name: fmt.chunkName(masterKey, plainHash), data: chunkEnvelope }]),
      (error) => error.code === 'bad-hash',
    )
    // repo 层 putPack/getPack 也接受 kit 记录（面板可能直接用它）
    const receipt = await repo.putPack({
      packId: 'kit-sync-0002',
      records: [{ name: 'recovery-kit/README.txt', data: kitReadme }],
    })
    const fetched = await repo.getPack('kit-sync-0002')
    assert.deepEqual(fetched.records[0].data, kitReadme)
    assert.equal(receipt.chunks, 1)
  } finally {
    repo.close()
  }
})

/* ═════════════════════════════════════════════════════════════ 2. LocalRepo */

test('LocalRepo: init/open/stats、content-addressed 去重、原子写、白名单与越界', async () => {
  const base = await tempDir('dbk-arch-repo-')
  const { repo, dir } = await newRepo(base, { chunkSize: 1024 })
  try {
    assert.equal(await isRepoDir(dir), true)
    const meta = await readRepoMeta(dir)
    assert.equal(meta.format, 'dsh-dr-repo')

    const buf = Buffer.from('chunk-body')
    const hash = sha256hex(buf)
    assert.equal(await repo.hasChunk(hash), false)
    assert.equal(await repo.putChunk(hash, buf), 'created')
    assert.equal(await repo.putChunk(hash, buf), 'exists', '同内容只存一份')
    assert.equal(await repo.hasChunk(hash), true)
    assert.deepEqual(await repo.getChunk(hash), buf)
    assert.deepEqual(await repo.listChunkNames(), [repo.chunkNameFor(hash)])

    // 内容与 plainHash 不符 → 拒绝写入
    await assert.rejects(
      async () => repo.putChunk(sha256hex(Buffer.from('other')), buf),
      (error) => error.code === 'integrity',
    )

    // 原子写：仓库里不应留下 .tmp 中间文件
    const tree = await treeDigest(dir)
    assert.equal(Object.keys(tree).some((rel) => rel.endsWith('.tmp')), false)
    // 块文件布局
    const raw = await fs.readFile(repo.absPath(repo.chunkNameFor(hash)))
    assert.equal(raw.subarray(0, 4).toString('ascii'), 'DRA1')

    // 清单
    const snapshotId = '20261028-130000-manual'
    const payload = {
      version: 1,
      snapshot: { id: snapshotId, at: Date.now(), reason: 'manual', chunkSize: 1024, stats: { files: 1, bytes: buf.length }, files: { 'a.txt': { s: buf.length, m: 1, c: [hash] } } },
      exportedAt: Date.now(),
      prevManifest: null,
      seq: 1,
    }
    const manifestName = await repo.putManifest(snapshotId, payload)
    assert.match(manifestName, /^manifests\/[0-9a-f]{64}\.mbin$/)
    assert.deepEqual(await repo.listManifestNames(), [manifestName])
    assert.deepEqual(await repo.getManifestByName(manifestName), payload)
    assert.deepEqual((await repo.getManifest(snapshotId)).payload, payload)
    assert.equal(await repo.hasManifest(snapshotId), true)

    // 包
    const pack = await repo.putPack({
      packId: 'pack-a',
      packObj: { kind: 'chunks' },
      records: [{ name: repo.chunkNameFor(hash), plainHash: hash, data: await fs.readFile(repo.absPath(repo.chunkNameFor(hash))) }],
    })
    assert.equal(pack.chunks, 1)
    assert.ok(pack.size > 0)
    assert.equal(pack.sha256, sha256hex(await fs.readFile(repo.absPath(pack.name))))
    const opened = await repo.getPack('pack-a')
    assert.equal(opened.records.length, 1)
    assert.deepEqual(await repo.listPackNames(), [pack.name])
    assert.deepEqual((await repo.getPack(pack.name)).header.packId, 'pack-a')

    // 统计
    const stats = await repo.stats()
    assert.equal(stats.chunks, 1)
    assert.equal(stats.manifests, 1)
    assert.equal(stats.packs, 1)
    assert.equal(stats.chunkBytes, raw.length)
    assert.equal(stats.repoId, meta.repoId)

    // 白名单 / 越界
    for (const bad of ['../escape.bin', 'chunks/aa/bb/../../../x.cbin', 'manifests/../../repo.json', 'evil/x.bin', 'repo.json.bak']) {
      assert.throws(() => repo.absPath(bad), (error) => error.code === 'bad-name', `${bad} 必须被拒`)
    }

    // init 不覆盖已有仓库；init 目录自动创建
    await assert.rejects(
      () => LocalRepo.init({ dir, password: PASSWORD }),
      (error) => error.code === 'repo-exists',
    )
    // 错密码打不开
    await assert.rejects(
      () => LocalRepo.open({ dir, password: 'wrong-password-9' }),
      (error) => error.code === 'bad-password',
    )
    // 只读打开：不解密
    const readonly = await LocalRepo.openReadonly({ dir })
    assert.equal(readonly.unlocked, false)
    assert.equal((await readonly.stats()).chunks, 1)
    assert.throws(() => readonly.chunkNameFor(hash), (error) => error.code === 'no-key')
    readonly.close()

    // 磁盘上块被篡改 → getChunk 报 integrity
    const abs = repo.absPath(repo.chunkNameFor(hash))
    const onDisk = await fs.readFile(abs)
    onDisk[onDisk.length - 1] ^= 0x01
    await fs.writeFile(abs, onDisk)
    await assert.rejects(() => repo.getChunk(hash), (error) => error.code === 'integrity')
  } finally {
    repo.close()
  }
  // 自动建目录：init 到多层不存在的路径
  const deep = path.join(base, 'a', 'b', 'c', 'repo')
  const created = await LocalRepo.init({ dir: deep, password: PASSWORD })
  assert.equal(await isRepoDir(deep), true)
  created.close()
})

/* ══════════════════════════════════════════════════════ 4. 导出 / 去重 / 链 */

test('exportSnapshot: 首次导出 / 幂等重导出 / 改一个文件只新增相关块 / 哈希链', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-arch-root-')
  const base = await tempDir('dbk-arch-export-')
  const engine = await startEngine(home, root, { chunkSize: 1024 })
  const { repo, dir } = await newRepo(base, { chunkSize: 1024 })
  try {
    const firstId = engine.latestSnapshotId()
    const first = await exportSnapshot({ engine, repo, snapshotId: firstId })
    assert.equal(first.snapshotId, firstId)
    assert.equal(first.manifestName, repo.manifestNameFor(firstId))
    assert.equal(first.seq, 1)
    assert.ok(first.newChunks >= 3, `首次导出应写入全部块，实际 ${first.newChunks}`)
    assert.equal(first.reusedChunks, 0)
    assert.equal(first.files, 4, 'workspace / session / storages / empty.txt（dsh-runtimes 排除）')
    assert.ok(first.bytes > 0)
    // 导出的清单内容与引擎清单一致（块列表、s）
    const manifest = await engine.store.readManifest(firstId)
    const stored = await repo.getManifestByName(first.manifestName)
    assert.equal(stored.version, 1)
    assert.equal(stored.seq, 1)
    assert.equal(stored.prevManifest, null)
    assert.deepEqual(stored.snapshot.files, manifest.files)
    assert.equal(stored.snapshot.stats.files, Object.keys(manifest.files).length)
    // ledger
    let ledger = await readLedger(dir)
    assert.equal(ledger.seq, 1)
    assert.equal(ledger.lastManifest, first.manifestName)
    assert.equal(ledger.entries.length, 1)
    assert.equal(ledger.entries[0].snapshotId, firstId)
    assert.equal(ledger.entries[0].newChunks, first.newChunks)
    assert.equal((await checkLedgerChain(ledger, repo)).ok, true)
    // pin 必须已释放
    assert.deepEqual(engine.listPinnedSnapshots(), [])

    // 幂等：同一快照再导出，新增块 0、seq 不变、链节点不重复
    const manifestBytesBefore = await fs.readFile(repo.absPath(first.manifestName))
    const again = await exportSnapshot({ engine, repo, snapshotId: firstId })
    assert.equal(again.newChunks, 0)
    assert.equal(again.reusedChunks, first.newChunks + first.reusedChunks)
    assert.equal(again.seq, 1)
    assert.equal(again.manifestName, first.manifestName)
    assert.deepEqual(
      await fs.readFile(repo.absPath(first.manifestName)),
      manifestBytesBefore,
      '幂等重导出不得改动清单字节（否则 ledger 里记的 manifestSha256 会过期）',
    )
    ledger = await readLedger(dir)
    assert.equal(ledger.entries.length, 1, '幂等重导出不得新增链节点')
    assert.equal(ledger.entries[0].manifestSha256, sha256hex(manifestBytesBefore), 'ledger 必须记录清单哈希')
    assert.deepEqual(engine.listPinnedSnapshots(), [])

    // 改一个文件 → 新快照 → 只新增该文件相关块
    await fs.writeFile(path.join(home, 'workspace.json'), '{"v":2}')
    const secondId = (await engine.snapshot('manual')).id
    const second = await exportSnapshot({ engine, repo, snapshotId: secondId })
    assert.equal(second.seq, 2)
    assert.equal(second.newChunks, 1, `只应新增被改动文件的 1 个块，实际 ${second.newChunks}`)
    assert.ok(second.reusedChunks >= 1)
    ledger = await readLedger(dir)
    assert.equal(ledger.seq, 2)
    assert.equal(ledger.entries.length, 2)
    assert.equal(ledger.entries[1].prevManifest, first.manifestName, '哈希链必须指向前一份清单')
    assert.equal(ledger.entries[1].seq, 2)
    const chain = await checkLedgerChain(ledger, repo)
    assert.equal(chain.ok, true, JSON.stringify(chain.problems))

    // 导出缺块的快照：明确报错，且 finally 仍释放 pin
    await fs.writeFile(path.join(home, 'storages', 'db.json'), '{"rows":[9,9,9]}')
    const third = await engine.snapshot('manual')
    assert.ok(third.id, '第三次快照应写入')
    const thirdManifest = await engine.store.readManifest(third.id)
    const secondHashes = new Set()
    for (const entry of Object.values((await engine.store.readManifest(secondId)).files || {})) {
      for (const hash of entryChunks(entry)) secondHashes.add(hash)
    }
    let victim = null
    for (const entry of Object.values(thirdManifest.files || {})) {
      for (const hash of entryChunks(entry)) if (!secondHashes.has(hash)) { victim = hash; break }
      if (victim) break
    }
    assert.ok(victim, '第三次快照应有独有块')
    const backup = await engine.store.get(victim)
    await fs.rm(engine.store.blobPath(victim))
    await assert.rejects(
      () => exportSnapshot({ engine, repo, snapshotId: third.id }),
      (error) => error.code === 'missing-chunk' && /内容块/.test(error.message),
    )
    assert.deepEqual(engine.listPinnedSnapshots(), [], '异常路径也必须 unpin')
    await engine.store.put(backup)

    // 不存在的快照
    await assert.rejects(
      () => exportSnapshot({ engine, repo, snapshotId: 'no-such-snapshot' }),
      (error) => error.code === 'no-snapshot',
    )
  } finally {
    repo.close()
    await engine.stop()
  }
})

test('exportSnapshot: 无可用快照时报错（不创建 ledger/清单）', async () => {
  const home = await tempDir('dbk-arch-empty-home-')
  const root = await tempDir('dbk-arch-empty-root-')
  const base = await tempDir('dbk-arch-empty-')
  const engine = new BackupEngine({
    home, config: { root, watch: false, scanMs: 3_600_000 }, hostname: 'arch-host', snapshotOnStart: false, log: () => {},
  })
  await engine.start()
  const { repo, dir } = await newRepo(base)
  try {
    await assert.rejects(
      () => exportSnapshot({ engine, repo }),
      (error) => error.code === 'no-snapshot',
    )
    assert.equal((await readLedger(dir)).entries.length, 0)
    assert.deepEqual(await repo.listManifestNames(), [])
  } finally {
    repo.close()
    await engine.stop()
  }
})

/* ═════════════════════════════════════════════════════════ 5. pin 与 prune */

test('pinSnapshot: 导出期间并发快照/prune 不删 pinned 快照及其内容块', async () => {
  const home = await tempDir('dbk-arch-pin-home-')
  await fs.writeFile(path.join(home, 'data.bin'), randomBytes(4096))
  const root = await tempDir('dbk-arch-pin-root-')
  // keepLast=1 + maxSnapshots=5：不 pin 的话，最快被淘汰的就是最旧那个
  const engine = await startEngine(home, root, {
    chunkSize: 1024, keepLast: 1, keepHourlyHours: 0, keepDailyDays: 0, maxSnapshots: 5,
  })
  const base = await tempDir('dbk-arch-pin-')
  const { repo } = await newRepo(base, { chunkSize: 1024 })
  try {
    const exportId = engine.latestSnapshotId()
    const exportManifest = await engine.store.readManifest(exportId)
    const exportHashes = []
    for (const entry of Object.values(exportManifest.files || {})) {
      for (const hash of entryChunks(entry)) if (!exportHashes.includes(hash)) exportHashes.push(hash)
    }
    assert.ok(exportHashes.length >= 2, '多块文件用于验证增量导出')

    // 导出中途卡住：模拟“正在导出”
    const originalGet = engine.store.get.bind(engine.store)
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let gated = false
    engine.store.get = async (hash) => {
      if (!gated) { gated = true; await gate }
      return originalGet(hash)
    }

    const exporting = exportSnapshot({ engine, repo, snapshotId: exportId })
    while (!gated) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.deepEqual(engine.listPinnedSnapshots(), [exportId], '导出期间必须持 pin')

    // 导出进行中：连拍 8 个新快照（每个都会 prune），pinned 快照必须活下来
    for (let index = 1; index <= 8; index += 1) {
      await fs.writeFile(path.join(home, 'data.bin'), randomBytes(512))
      await engine.snapshot('manual')
    }
    assert.equal(engine.state().snapshotCount <= 6, true, `pinned + 硬上限，实际 ${engine.state().snapshotCount}`)
    assert.equal(engine.snapshots.some((snapshot) => snapshot.id === exportId), true, 'pinned 快照不得被 prune 删除')
    assert.equal(engine.isSnapshotPinned(exportId), true)
    // pinned 快照的清单与所有块都还在
    assert.equal((await engine.store.readManifest(exportId)).id, exportId)
    for (const hash of exportHashes) assert.equal(await engine.store.has(hash), true, `pinned 块 ${hash.slice(0, 8)} 不得被 GC`)
    // pinned 快照拒绝删除
    await assert.rejects(() => engine.deleteSnapshot(exportId), /pinned/)

    release()
    const result = await exporting
    assert.equal(result.newChunks, exportHashes.length)
    assert.deepEqual(engine.listPinnedSnapshots(), [], '导出结束必须释放 pin')
    // 导出的每个块都能完整解密回原内容
    for (const hash of exportHashes) {
      const expected = await engine.store.get(hash)
      assert.deepEqual(await repo.getChunk(hash), expected)
    }

    // 释放 pin 之后，pinned 快照才允许被后续 prune 淘汰
    await fs.writeFile(path.join(home, 'data.bin'), randomBytes(256))
    await engine.snapshot('manual')
    await engine.snapshot('manual')
    assert.equal(engine.snapshots.some((snapshot) => snapshot.id === exportId), false, 'unpin 后按保留策略淘汰')
  } finally {
    repo.close()
    await engine.stop()
  }
})

/* ═══════════════════════════════ 4/6/8. 导入 → 恢复 → 演练 / 拆除重建 */

test('importSnapshotToEngine: 导出→新引擎导入→恢复（临时 home）逐文件一致', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-arch-imp-root-')
  const base = await tempDir('dbk-arch-imp-')
  const engine = await startEngine(home, root, { chunkSize: 1024 })
  const { repo } = await newRepo(base, { chunkSize: 1024 })
  let restoredEngine = null
  try {
    const id = engine.latestSnapshotId()
    const manifest = await engine.store.readManifest(id)
    const expected = await readSnapshotFiles(engine, manifest)
    const exported = await exportSnapshot({ engine, repo, snapshotId: id })

    // 模拟“另一台机器/重装后”：全新的空 home + 空 store
    const home2 = await tempDir('dbk-arch-imp-home2-')
    const root2 = await tempDir('dbk-arch-imp-root2-')
    restoredEngine = await startEngine(home2, root2, { chunkSize: 1024 })
    const imported = await importSnapshotToEngine({ engine: restoredEngine, repo, snapshotId: id })
    assert.equal(imported.files, exported.files)
    assert.equal(imported.importedChunks, exported.newChunks + exported.reusedChunks)
    assert.equal(imported.reusedChunks, 0)
    assert.deepEqual(imported.manifest.files, manifest.files)
    // 清单已落盘 + 注册进内存
    assert.equal((await restoredEngine.store.readManifest(id)).id, id)
    assert.equal(restoredEngine.snapshots.some((snapshot) => snapshot.id === id), true)
    assert.equal(restoredEngine.lastManifest.id, id)
    assert.equal(restoredEngine.busy, false, '导入结束必须恢复 busy')

    // 再导入一次：全部复用本地块
    const again = await importSnapshotToEngine({ engine: restoredEngine, repo, snapshotId: id })
    assert.equal(again.importedChunks, 0)
    assert.equal(again.reusedChunks, imported.importedChunks)
    assert.equal(restoredEngine.snapshots.filter((snapshot) => snapshot.id === id).length, 1, '不得重复注册')

    // 恢复（沿用 pre-restore / quarantine 语义；空 home 上恢复 = 建文件）
    const restored = await restoredEngine.restore(id)
    assert.equal(restored.ok, true)
    assert.ok(restored.restored >= 4)
    assert.ok(restored.preSnapshot, '必须自动拍 pre-restore 快照')
    for (const [rel, buf] of Object.entries(expected)) {
      assert.deepEqual(await fs.readFile(path.join(home2, rel)), buf, `${rel} 内容必须一致`)
    }
    // busy 被误设成 true 时导入必须拒绝
    restoredEngine.busy = true
    await assert.rejects(
      () => importSnapshotToEngine({ engine: restoredEngine, repo, snapshotId: id }),
      (error) => error.code === 'busy',
    )
    restoredEngine.busy = false

    // 只读校验：不写任何东西
    const before = await treeDigest(restoredEngine.store.dir)
    const verified = await verifyRemoteSnapshot({ engine: restoredEngine, repo, snapshotId: id })
    assert.equal(verified.ok, true)
    assert.equal(verified.files, exported.files)
    assert.equal(verified.chunks, verified.fromRepo, '仓库必须完整覆盖所有块')
    assert.equal(verified.fromStore, verified.chunks, '导入后本地 store 也应有全部块')
    assert.deepEqual(verified.missingChunks, [])
    assert.deepEqual(verified.corrupt, [])
    assert.equal(verified.seq, exported.seq)
    assert.equal(verified.prevManifest, null)
    assert.deepEqual(await treeDigest(restoredEngine.store.dir), before, 'verify 必须只读')
  } finally {
    repo.close()
    if (restoredEngine) await restoredEngine.stop()
    await engine.stop()
  }
})

test('importSnapshot 不触发 prune：导入不会挤掉已有快照', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-arch-noprune-root-')
  const base = await tempDir('dbk-arch-noprune-')
  const engine = await startEngine(home, root, { chunkSize: 1024, keepLast: 1, keepHourlyHours: 0, keepDailyDays: 0, maxSnapshots: 5 })
  const { repo } = await newRepo(base, { chunkSize: 1024 })
  const target = await startEngine(await tempDir('dbk-arch-noprune-home2-'), await tempDir('dbk-arch-noprune-root2-'), { chunkSize: 1024 })
  try {
    const id = engine.latestSnapshotId()
    await exportSnapshot({ engine, repo, snapshotId: id })
    const before = target.snapshots.length
    const beforeFiles = (await fs.readdir(target.store.snapDir)).length
    await importSnapshotToEngine({ engine: target, repo, snapshotId: id })
    assert.equal(target.snapshots.length, before + 1, 'importSnapshot 只新增，不 prune')
    assert.equal((await fs.readdir(target.store.snapDir)).length, beforeFiles + 1)
    // 连续导入多个旧快照也不会互相淘汰
    for (let index = 0; index < 3; index += 1) {
      await fs.writeFile(path.join(home, 'workspace.json'), `{"v":${index + 10}}`)
      // reason 带序号：同一秒内多次快照的 id 也必须互不相同
      const snap = await engine.snapshot(`manual-${index}`)
      assert.ok(snap.id, `第 ${index + 1} 个快照应写入`)
      await exportSnapshot({ engine, repo, snapshotId: snap.id })
      await importSnapshotToEngine({ engine: target, repo, snapshotId: snap.id })
    }
    assert.equal(target.snapshots.length, before + 4)
    assert.equal((await fs.readdir(target.store.snapDir)).length, beforeFiles + 4)
  } finally {
    repo.close()
    await target.stop()
    await engine.stop()
  }
})

test('拆除演练：删掉本机仓库与 store 后，仅凭密文副本 + 密码恢复到临时 home（§8.8）', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-arch-peer-root-')
  const base = await tempDir('dbk-arch-peer-')
  const engine = await startEngine(home, root, { chunkSize: 1024 })
  const { repo, dir } = await newRepo(base, { chunkSize: 1024 })
  // 子机视角：只拿到 repo 目录（密文 + repo.json），拿不到 ledger
  const peerRepo = await tempDir('dbk-arch-peer-repo-')
  let peer = null
  let fresh = null
  try {
    const id = engine.latestSnapshotId()
    const manifest = await engine.store.readManifest(id)
    const expected = await readSnapshotFiles(engine, manifest)
    await exportSnapshot({ engine, repo, snapshotId: id })
    await fs.cp(dir, peerRepo, { recursive: true })
    // 本机被毁：仓库、ledger、store、home 全没了（都在 tmp 里，删除安全）
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(path.join(base, 'offsite'), { recursive: true, force: true })
    await fs.rm(root, { recursive: true, force: true })
    assert.equal(await isRepoDir(dir), false)
    await fs.rm(home, { recursive: true, force: true })

    // 只剩子机密文 + 密码
    peer = await LocalRepo.open({ dir: peerRepo, password: PASSWORD })
    const home3 = await tempDir('dbk-arch-peer-home3-')
    const root3 = await tempDir('dbk-arch-peer-root3-')
    fresh = await startEngine(home3, root3, { chunkSize: 1024 })
    // 没有 ledger 也能校验 + 导入（完全从清单/密文推导）
    const verified = await verifyRemoteSnapshot({ engine: fresh, repo: peer, snapshotId: id })
    assert.equal(verified.ok, true)
    assert.equal(verified.fromRepo, verified.chunks)
    const imported = await importSnapshotToEngine({ engine: fresh, repo: peer, snapshotId: id })
    assert.ok(imported.importedChunks > 0)
    const restored = await fresh.restore(id)
    assert.equal(restored.ok, true)
    for (const [rel, buf] of Object.entries(expected)) {
      assert.deepEqual(await fs.readFile(path.join(home3, rel)), buf, `${rel} 必须从子机密文恢复出来`)
    }
    // ledger 不存在时 readLedger 返回空链（不静默伪造）
    assert.equal((await readLedger(peerRepo)).entries.length, 0)
  } finally {
    if (peer) peer.close()
    if (fresh) await fresh.stop()
    repo.close()
    await engine.stop()
  }
})

/* ═══════════════════════════════════════════════ 6/9. 演练与缺失/篡改块 */

test('缺块：verify 列出具体块名，import 拒绝且不注册清单（不部分恢复）', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-arch-miss-root-')
  const base = await tempDir('dbk-arch-miss-')
  const engine = await startEngine(home, root, { chunkSize: 1024 })
  const { repo } = await newRepo(base, { chunkSize: 1024 })
  const target = await startEngine(await tempDir('dbk-arch-miss-home2-'), await tempDir('dbk-arch-miss-root2-'), { chunkSize: 1024 })
  try {
    const id = engine.latestSnapshotId()
    const manifest = await engine.store.readManifest(id)
    const exported = await exportSnapshot({ engine, repo, snapshotId: id })
    const hashes = []
    for (const entry of Object.values(manifest.files || {})) {
      for (const hash of entryChunks(entry)) if (!hashes.includes(hash)) hashes.push(hash)
    }
    assert.ok(hashes.length >= 2)
    // 人为删掉一个块（模拟子机缺档）
    const victim = hashes[0]
    await fs.rm(repo.absPath(repo.chunkNameFor(victim)))

    const verified = await verifyRemoteSnapshot({ engine: target, repo, snapshotId: id })
    assert.equal(verified.ok, false)
    assert.deepEqual(verified.missingChunks, [victim], '必须精确列出缺失块')
    assert.deepEqual(verified.missingNames, [repo.chunkNameFor(victim)])
    assert.match(verified.missingNames[0], /^chunks\//)

    const before = target.snapshots.length
    await assert.rejects(
      () => importSnapshotToEngine({ engine: target, repo, snapshotId: id }),
      (error) => {
        assert.equal(error.code, 'missing-chunks')
        assert.ok(error.message.includes(repo.chunkNameFor(victim)), '错误里要有具体块名')
        return true
      },
    )
    assert.equal(target.snapshots.length, before, '不得部分恢复（不注册清单）')
    await assert.rejects(() => target.store.readManifest(id), /ENOENT|bad|corrupt/)
    assert.equal((await fs.readdir(target.store.snapDir)).length, 0)

    // 篡改（而不是删除）块：verify 报 corrupt，import 报 integrity
    const raw = await fs.readFile(repo.absPath(repo.chunkNameFor(hashes[1])))
    const tampered = Buffer.from(raw)
    tampered[16] ^= 0xff
    await fs.writeFile(repo.absPath(repo.chunkNameFor(hashes[1])), tampered)
    const corrupt = await verifyRemoteSnapshot({ engine: target, repo, snapshotId: id })
    assert.equal(corrupt.ok, false)
    assert.equal(corrupt.corrupt.length, 1)
    assert.equal(corrupt.corrupt[0].hash, hashes[1])
    await assert.rejects(
      () => importSnapshotToEngine({ engine: target, repo, snapshotId: id }),
      (error) => error.code === 'missing-chunks' || error.code === 'integrity',
    )
    assert.equal(target.snapshots.length, before)
    assert.equal(exported.newChunks + exported.reusedChunks, hashes.length)
    // 结论：缺块/坏块都不会让目标 home 或目标 store 里出现“半份快照”
    assert.deepEqual(await fs.readdir(target.store.snapDir), [])
  } finally {
    repo.close()
    await target.stop()
    await engine.stop()
  }
})

test('篡改清单 1 字节：verify/import 明确报错，不写真实 home（§8.3）', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-arch-tam-root-')
  const base = await tempDir('dbk-arch-tam-')
  const engine = await startEngine(home, root, { chunkSize: 1024 })
  const { repo } = await newRepo(base, { chunkSize: 1024 })
  const target = await startEngine(await tempDir('dbk-arch-tam-home2-'), await tempDir('dbk-arch-tam-root2-'), { chunkSize: 1024 })
  try {
    const id = engine.latestSnapshotId()
    await exportSnapshot({ engine, repo, snapshotId: id })
    const name = repo.manifestNameFor(id)
    const abs = repo.absPath(name)
    const raw = await fs.readFile(abs)
    raw[raw.length - 1] ^= 0x01
    await fs.writeFile(abs, raw)
    await assert.rejects(() => repo.getManifestByName(name), (error) => error.code === 'integrity')
    await assert.rejects(
      () => verifyRemoteSnapshot({ engine: target, repo, snapshotId: id }),
      (error) => error.code === 'integrity' || error.code === 'corrupt',
    )
    await assert.rejects(
      () => importSnapshotToEngine({ engine: target, repo, snapshotId: id }),
      (error) => error.code === 'integrity' || error.code === 'corrupt',
    )
    // 目标 home 一个文件都不能写出来（没有部分恢复）
    assert.deepEqual(await fs.readdir(target.home), [])
    assert.equal(target.snapshots.length, 0)

    // 结构非法（但加密/命名都合法）的清单：s>0 却没有任何块 ⇒ bad-manifest，绝不按空文件恢复
    const fakeId = '20261028-999999-fake'
    const fakeName = fmt.manifestName(repo.masterKey, fakeId)
    const fakeEnvelope = fmt.encryptManifest(repo.masterKey, fakeName, {
      version: 1,
      snapshot: {
        id: fakeId, at: Date.now(), reason: 'manual', chunkSize: 1024,
        stats: { files: 1, bytes: 10 },
        files: { 'broken.txt': { s: 10, m: 1, c: [] } },
      },
      exportedAt: Date.now(), prevManifest: null, seq: 9,
    })
    await fs.writeFile(repo.absPath(fakeName), fakeEnvelope)
    await assert.rejects(
      () => verifyRemoteSnapshot({ engine: target, repo, snapshotId: fakeId }),
      (error) => error.code === 'bad-manifest',
    )
    await assert.rejects(
      () => importSnapshotToEngine({ engine: target, repo, snapshotId: fakeId }),
      (error) => error.code === 'bad-manifest',
    )
    assert.equal(target.snapshots.length, 0)
  } finally {
    repo.close()
    await target.stop()
    await engine.stop()
  }
})

/* ═════════════════════════════════════════ 面板侧 archive port（src/offsite.js 对齐） */

test('archive port: offsite.js 的 12 个对象参数方法全部可用且 roundtrip 自洽', async () => {
  const base = await tempDir('dbk-arch-port-')
  const dir = path.join(base, 'offsite', 'repo')

  // 12 个方法一个都不能少（与 src/offsite.js 的 ARCHIVE_PORT_METHODS 对齐）
  assert.deepEqual([...port.ARCHIVE_PORT_METHODS].sort(), [
    'buildPack', 'chunkName', 'decodeChunk', 'decodeManifest', 'encodeChunk', 'encodeManifest',
    'initRepo', 'keyFromMasterKey', 'manifestName', 'masterKeyOf', 'openRepoKey', 'unpackPack',
  ].sort())
  for (const name of port.ARCHIVE_PORT_METHODS) assert.equal(typeof port[name], 'function', `${name} 必须存在`)

  const key = await port.initRepo({ dir, password: PASSWORD, chunkSize: 65536 })
  assert.equal(path.resolve(key.dir), path.resolve(dir))
  assert.equal((await port.masterKeyOf(key)).length, 32)
  assert.equal((await port.masterKeyOf(key)).toString('hex'), key.masterKey.toString('hex'))

  // 密码解锁 / masterKey 直挂（DPAPI 缓存路径）
  const reopened = await port.openRepoKey({ dir, password: PASSWORD })
  const viaMasterKey = await port.keyFromMasterKey({ dir, masterKey: await port.masterKeyOf(reopened) })
  assert.equal((await port.masterKeyOf(viaMasterKey)).toString('hex'), key.masterKey.toString('hex'))
  const wrongMaster = Buffer.alloc(32, 7)
  await assert.rejects(
    () => port.keyFromMasterKey({ dir, masterKey: wrongMaster }),
    (error) => error.code === 'bad-password',
  )
  await assert.rejects(
    () => port.openRepoKey({ dir, password: 'wrong-password-9' }),
    (error) => error.code === 'bad-password',
  )

  // 块：encodeChunk({key, plainBuf}) -> {name, buf, plainHash}
  const plainBuf = Buffer.from('port-chunk-payload')
  const encoded = await port.encodeChunk({ key, plainBuf })
  assert.equal(encoded.plainHash, sha256hex(plainBuf))
  assert.equal(encoded.name, await port.chunkName({ key, plainHash: encoded.plainHash }))
  assert.match(encoded.name, /^chunks\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.cbin$/)
  const decoded = await port.decodeChunk({ key, name: encoded.name, buf: encoded.buf })
  assert.deepEqual(decoded.plainBuf, plainBuf)
  assert.equal(decoded.plainHash, encoded.plainHash)

  // 清单：encodeManifest({key, manifest}) -> {name, buf, sha256}
  const manifest = {
    version: 1,
    snapshot: {
      id: '20261028-140000-manual', at: 1793000000000, reason: 'manual', chunkSize: 65536,
      stats: { files: 1, bytes: plainBuf.length },
      files: { 'a.txt': { s: plainBuf.length, m: 1, c: [encoded.plainHash] } },
    },
    exportedAt: 1793000000001,
    prevManifest: null,
    seq: 1,
  }
  const encodedManifest = await port.encodeManifest({ key, manifest })
  assert.equal(encodedManifest.name, await port.manifestName({ key, snapshotId: manifest.snapshot.id }))
  assert.equal(encodedManifest.sha256, sha256hex(encodedManifest.buf))
  const decodedManifest = await port.decodeManifest({ key, name: encodedManifest.name, buf: encodedManifest.buf })
  assert.deepEqual(decodedManifest.manifest, manifest)
  assert.equal(decodedManifest.sha256, encodedManifest.sha256)

  // 包：一个 pack 同时装块 + 清单（offsite.js 的 sealPacks 会把两类文件混装）
  const packed = await port.buildPack({
    key,
    entries: [
      { name: encoded.name, buf: encoded.buf },
      { name: encodedManifest.name, buf: encodedManifest.buf },
    ],
  })
  assert.match(packed.name, /^packs\/[0-9a-f]{64}\.pbin$/)
  assert.equal(packed.entries, 2)
  const unpacked = await port.unpackPack({ key, name: packed.name, buf: packed.buf })
  assert.equal(unpacked.length, 2)
  assert.equal(unpacked[0].name, encoded.name)
  assert.deepEqual(unpacked[0].buf, encoded.buf)
  assert.equal(unpacked[0].plainHash, encoded.plainHash)
  assert.equal(unpacked[1].name, encodedManifest.name)
  assert.deepEqual(unpacked[1].buf, encodedManifest.buf)
  assert.equal(unpacked[1].plainHash, null)
  // 解出来的块记录仍可再解密（包只是搬运工）
  assert.deepEqual(
    (await port.decodeChunk({ key, name: unpacked[0].name, buf: unpacked[0].buf })).plainBuf,
    plainBuf,
  )
  // 坏包：篡改 1 字节必须报错
  const badPack = Buffer.from(packed.buf)
  badPack[badPack.length - 1] ^= 0xff
  await assert.rejects(() => port.unpackPack({ key, name: packed.name, buf: badPack }), (error) => error.code === 'integrity')
  // 密码规则便捷函数
  assert.equal(port.checkPassword('abcdefgh').ok, false)
  assert.equal(port.checkPassword(PASSWORD).ok, true)
})

/* ═══════════════════════════════ ledger 兼容（CLI 与面板共用 <offsite>/ledger.json） */

test('ledger 兼容：能读面板 schema（seq/prevManifest/archives），写回时保留面板字段并镜像 archives', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-arch-ledger-root-')
  const base = await tempDir('dbk-arch-ledger-')
  const engine = await startEngine(home, root, { chunkSize: 1024 })
  const { repo, dir } = await newRepo(base, { chunkSize: 1024 })
  try {
    const firstId = engine.latestSnapshotId()
    const first = await exportSnapshot({ engine, repo, snapshotId: firstId })
    assert.equal(first.seq, 1)

    // 模拟面板（src/offsite.js）接管 ledger：{version, seq, prevManifest, archives, lastExportAt}
    const panelLedger = {
      version: 1,
      seq: 5,
      prevManifest: first.manifestName,
      archives: [{
        snapshotId: firstId,
        manifestName: first.manifestName,
        at: Date.now(),
        seq: 5,
        files: first.files,
        bytes: first.bytes,
        newChunks: first.newChunks,
        manifestSha256: sha256hex(await fs.readFile(repo.absPath(first.manifestName))),
      }],
      lastExportAt: 123456,
      lastDrillAt: null,
    }
    await fs.writeFile(path.join(base, 'offsite', 'ledger.json'), JSON.stringify(panelLedger, null, 2))
    const ledger = await readLedger(dir)
    assert.equal(ledger.seq, 5, '从面板 schema 读 seq')
    assert.equal(ledger.lastManifest, first.manifestName, 'prevManifest 视作链尾')
    assert.equal(ledger.entries.length, 1)
    assert.equal(ledger.entries[0].snapshotId, firstId)
    assert.ok(ledger.foreign, '标记为面板 ledger')
    const chain = await checkLedgerChain(ledger, repo)
    assert.equal(chain.ok, true, JSON.stringify(chain.problems))
    assert.equal(chain.compat, true)

    // 再导出：seq 必须接着面板的 5，prevManifest 指向前一份
    await fs.writeFile(path.join(home, 'workspace.json'), '{"v":3}')
    const secondId = (await engine.snapshot('manual')).id
    const second = await exportSnapshot({ engine, repo, snapshotId: secondId })
    assert.equal(second.seq, 6, 'seq 必须从面板 ledger 续上')
    const stored = await repo.getManifestByName(second.manifestName)
    assert.equal(stored.prevManifest, first.manifestName)

    // 写回后：面板自有字段保留，archives 镜像两条，entries 两条
    const raw = JSON.parse(await fs.readFile(path.join(base, 'offsite', 'ledger.json'), 'utf8'))
    assert.equal(raw.format, 'dsh-dr-ledger')
    assert.equal(raw.lastExportAt, 123456, '面板字段必须保留')
    assert.equal(raw.seq, 6)
    assert.equal(raw.prevManifest, second.manifestName, '面板的 prevManifest 别名同步')
    assert.equal(raw.entries.length, 2)
    assert.equal(raw.archives.length, 2, 'archives 必须镜像 CLI 导出，面板才看得到')
    assert.deepEqual(raw.archives.map((item) => item.snapshotId).sort(), [firstId, secondId].sort())

    // 面板再存一次（normalizeLedger 只保留 archives）→ CLI 仍能读
    const panelAgain = { ...raw, format: undefined, entries: undefined }
    await fs.writeFile(path.join(base, 'offsite', 'ledger.json'), JSON.stringify(panelAgain))
    const reread = await readLedger(dir)
    assert.equal(reread.entries.length, 2)
    assert.equal(reread.lastManifest, second.manifestName)
    assert.equal((await checkLedgerChain(reread, repo)).ok, true)
    // 用密码枚举时也能看到这份快照
    assert.equal(await repo.hasManifest(secondId), true)
  } finally {
    repo.close()
    await engine.stop()
  }
})

test('跨 writer ledger：CLI 导出写的 entries+archives 镜像面板 normalizeLedger 能读，面板存回后 CLI 继续接链', async () => {
  const home = await makeHome('dbk-arch-xledger-home-')
  const root = await tempDir('dbk-arch-xledger-root-')
  const base = await tempDir('dbk-arch-xledger-')
  const engine = await startEngine(home, root, { chunkSize: 1024 })
  const { repo, dir } = await newRepo(base, { chunkSize: 1024 })
  try {
    const id = engine.latestSnapshotId()
    const exported = await exportSnapshot({ engine, repo, snapshotId: id })
    const ledgerFile = path.join(base, 'offsite', 'ledger.json')
    const raw = JSON.parse(await fs.readFile(ledgerFile, 'utf8'))

    // 1) 面板视角：normalizeLedger 只认自己的 schema（archives/prevManifest/seq），
    //    CLI 写的镜像必须让它读到快照、且 manifestName 真实存在。
    const { normalizeLedger } = await import('../src/offsite.js')
    const panelView = normalizeLedger(raw)
    assert.equal(panelView.seq, 1)
    assert.equal(panelView.prevManifest, exported.manifestName)
    assert.equal(panelView.archives.length, 1)
    const archive = panelView.archives[0]
    assert.equal(archive.snapshotId, id)
    assert.equal(archive.manifestName, exported.manifestName)
    assert.equal(archive.files, exported.files)
    assert.equal(archive.bytes, exported.bytes)
    assert.equal(archive.seq, 1)
    assert.equal(await repo.hasManifestName(archive.manifestName), true)

    // 2) 面板保存（丢掉 CLI 的 format/entries，只留自己的字段）→ CLI 必须仍能读
    await fs.writeFile(ledgerFile, JSON.stringify(panelView, null, 2) + '\n')
    const reread = await readLedger(dir)
    assert.equal(reread.lastManifest, exported.manifestName)
    assert.equal(reread.entries.length, 1)
    assert.equal(reread.entries[0].snapshotId, id)
    assert.equal((await checkLedgerChain(reread, repo)).ok, true)

    // 3) CLI 接着导出新快照：seq 从面板存的 1 续到 2，prevManifest 指向面板存的那份
    await fs.writeFile(path.join(home, 'workspace.json'), '{"v":42}')
    const secondId = (await engine.snapshot('manual')).id
    const second = await exportSnapshot({ engine, repo, snapshotId: secondId })
    assert.equal(second.seq, 2)
    assert.equal((await repo.getManifestByName(second.manifestName)).prevManifest, exported.manifestName)

    // 4) 面板再读：archives 镜像两条齐全、seq=2（面板侧 sync/prune 有东西可读）
    const panelAgain = normalizeLedger(JSON.parse(await fs.readFile(ledgerFile, 'utf8')))
    assert.equal(panelAgain.seq, 2)
    assert.equal(panelAgain.prevManifest, second.manifestName)
    assert.deepEqual(
      panelAgain.archives.map((item) => item.snapshotId).sort(),
      [id, secondId].sort(),
    )
  } finally {
    repo.close()
    await engine.stop()
  }
})

/* ══════════════════════════════════════════════════════════════════ 10. CLI */

async function cliFixture() {
  const home = await makeHome('dbk-arch-cli-home-')
  await fs.writeFile(path.join(home, 'sessions', '--D-x--', 'session-1', 'session.v4.jsonl.zstd'), 'l'.repeat(3000))
  const root = await tempDir('dbk-arch-cli-root-')
  const base = await tempDir('dbk-arch-cli-')
  const engine = await startEngine(home, root, { chunkSize: 1024 })
  const id = engine.latestSnapshotId()
  await engine.stop()
  return { home, root, base, id, repoDir: path.join(base, 'offsite', 'repo') }
}

test('CLI: init→export→list→verify→drill→status 冒烟（密码只走 stdin）', async () => {
  const { home, root, base, id, repoDir } = await cliFixture()
  const common = ['--home', home, '--root', root, '--dir', repoDir]
  const pwdIn = `${PASSWORD}\n`

  // init
  let run = runCli(['init', ...common, '--password-stdin'], { input: pwdIn })
  assert.equal(run.code, 0, `init 失败：${run.stderr}`)
  assert.match(run.stdout, /已初始化加密仓库/)
  assert.equal(await isRepoDir(repoDir), true)
  // 不覆盖已有仓库
  run = runCli(['init', ...common, '--password-stdin'], { input: pwdIn })
  assert.equal(run.code, 1)
  assert.match(run.stderr, /repo-exists|仓库已存在/)

  // export --json
  run = runCli(['export', ...common, '--password-stdin', '--json'], { input: pwdIn })
  assert.equal(run.code, 0, `export 失败：${run.stderr}`)
  const exported = parseJsonOutput(run)
  assert.equal(exported.ok, true)
  assert.equal(exported.snapshotId, id)
  assert.equal(exported.seq, 1)
  assert.ok(exported.newChunks >= 3)
  assert.equal(run.stdout.includes(PASSWORD), false, 'stdout 不得出现密码')
  assert.equal(run.stderr.includes(PASSWORD), false, 'stderr 不得出现密码')

  // export 第二次：新增块 0
  run = runCli(['export', ...common, '--password-stdin', '--json'], { input: pwdIn })
  assert.equal(run.code, 0, run.stderr)
  const reExported = parseJsonOutput(run)
  assert.equal(reExported.newChunks, 0)
  assert.equal(reExported.seq, 1)

  // list（不需要密码：从 ledger 读）
  run = runCli(['list', ...common, '--json'])
  assert.equal(run.code, 0, run.stderr)
  const listed = parseJsonOutput(run)
  assert.equal(listed.source, 'ledger')
  assert.equal(listed.snapshots.length, 1)
  assert.equal(listed.snapshots[0].snapshotId, id)
  assert.equal(listed.snapshots[0].seq, 1)
  assert.equal(listed.snapshots[0].files, exported.files)

  // verify --json
  run = runCli(['verify', ...common, '--password-stdin', '--json'], { input: pwdIn })
  assert.equal(run.code, 0, run.stderr)
  const verified = parseJsonOutput(run)
  assert.equal(verified.ok, true)
  assert.equal(verified.chain.ok, true)
  assert.equal(verified.snapshots.length, 1)
  assert.equal(verified.snapshots[0].ok, true)
  assert.deepEqual(verified.snapshots[0].missingChunks, [])

  // drill --json（临时 home 真恢复 + 逐文件 sha256）
  run = runCli(['drill', ...common, '--password-stdin', '--json'], { input: pwdIn })
  assert.equal(run.code, 0, `drill 失败：${run.stderr}`)
  const drilled = parseJsonOutput(run)
  assert.equal(drilled.ok, true)
  assert.equal(drilled.passed, drilled.files)
  assert.equal(drilled.failed, 0)
  assert.equal(drilled.tempDir, null, '默认清理临时目录（不碰真实 home）')

  // status --json（不需要密码）
  run = runCli(['status', ...common, '--json'])
  assert.equal(run.code, 0, run.stderr)
  const status = parseJsonOutput(run)
  assert.equal(status.repoExists, true)
  assert.match(status.repo.repoId, /^[0-9a-f]{16}$/)
  assert.equal(status.ledger.seq, 1)
  assert.equal(status.ledger.chainOk, true)
  assert.equal(status.engine.latestExported, true)
  assert.equal(status.repoStats.chunks > 0, true)

  // 错密码：退出码 1，且不泄露任何清单名/metadata
  run = runCli(['verify', ...common, '--password-stdin'], { input: 'wrong-password-9\n' })
  assert.equal(run.code, 1)
  assert.match(run.stderr, /bad-password/)
  assert.equal(run.stdout.includes('manifests/'), false)
  // 弱密码 init 被拒（--home/--root 也指临时目录：连真实路径解析都不碰）
  run = runCli([
    'init', '--home', home, '--root', root,
    '--dir', path.join(base, 'offsite', 'repo-weak'), '--password-stdin',
  ], { input: 'abcdefgh\n' })
  assert.equal(run.code, 1)
  assert.match(run.stderr, /weak-password/)
  // 拒绝命令行明文密码（密码类错误统一退出码 4）
  run = runCli(['export', ...common, '--password', PASSWORD])
  assert.equal(run.code, 4)
  assert.match(run.stderr, /password-argv|不接受命令行明文密码/)
  assert.equal(run.stderr.includes(PASSWORD), false)
  // 非交互环境没有密码来源：退出码 4（password-required）
  run = runCli(['export', ...common])
  assert.equal(run.code, 4)
  assert.match(run.stderr, /password-required|需要密码/)

  // 灾难恢复：另一个空 home/root，用 import + restore
  const home2 = await tempDir('dbk-arch-cli-home2-')
  const root2 = await tempDir('dbk-arch-cli-root2-')
  const common2 = ['--home', home2, '--root', root2, '--dir', repoDir]
  run = runCli(['import', id, ...common2, '--password-stdin', '--json'], { input: pwdIn })
  assert.equal(run.code, 0, run.stderr)
  const imported = parseJsonOutput(run)
  assert.equal(imported.ok, true)
  assert.ok(imported.importedChunks > 0)
  assert.equal(imported.files, exported.files)

  run = runCli(['restore', id, ...common2, '--password-stdin', '--yes', '--json'], { input: pwdIn })
  assert.equal(run.code, 0, `restore 失败：${run.stderr}`)
  const restored = parseJsonOutput(run)
  assert.equal(restored.ok, true)
  assert.ok(restored.restore.restored >= exported.files)
  assert.equal(restored.restore.needRestart, true)
  assert.ok(restored.restore.preSnapshot, 'CLI restore 必须沿用 pre-restore 语义')
  // 恢复后的文件内容与原 home 一致
  const expected = await treeDigest(home)
  const actual = await treeDigest(home2)
  for (const [rel, digest] of Object.entries(expected)) {
    if (rel.startsWith('dsh-runtimes/')) continue
    assert.equal(actual[rel], digest, `${rel} 恢复后内容必须一致`)
  }
})

test('CLI: 真实 store 只读演练（临时副本；list/verify/status/export 不得改 store）', async () => {
  const { home, root, repoDir } = await cliFixture()
  const common = ['--home', home, '--root', root, '--dir', repoDir]
  const pwdIn = `${PASSWORD}\n`
  // 先建仓库（init 只写 repo 目录，在 store 之外）
  let run = runCli(['init', ...common, '--password-stdin'], { input: pwdIn })
  assert.equal(run.code, 0, run.stderr)

  // store 指的临时副本：口令/仓库都在临时目录，真实 .dsh 完全不参与
  const storeDir = path.join(root, 'arch-host')
  const before = await treeDigest(storeDir)
  assert.ok(Object.keys(before).length > 0, 'store 里应有 blob 与清单')

  run = runCli(['export', ...common, '--password-stdin', '--json'], { input: pwdIn })
  assert.equal(run.code, 0, run.stderr)
  run = runCli(['list', ...common, '--json'])
  assert.equal(run.code, 0, run.stderr)
  run = runCli(['verify', ...common, '--password-stdin', '--json'], { input: pwdIn })
  assert.equal(run.code, 0, run.stderr)
  run = runCli(['status', ...common, '--json'])
  assert.equal(run.code, 0, run.stderr)
  run = runCli(['drill', ...common, '--password-stdin', '--json'], { input: pwdIn })
  assert.equal(run.code, 0, run.stderr)

  const after = await treeDigest(storeDir)
  assert.deepEqual(after, before, '真实 store 的临时副本必须保持只读：CLI 不得新增/修改任何文件')
  // 同时确认 repo 目录确实被写入了（export 不是空操作）
  assert.ok((await fs.readdir(path.join(repoDir, 'chunks'))).length > 0)
})

test('CLI: verify 对缺失块返回退出码 2 且列出块名', async () => {
  const { home, root, repoDir } = await cliFixture()
  const common = ['--home', home, '--root', root, '--dir', repoDir]
  const pwdIn = `${PASSWORD}\n`
  let run = runCli(['init', ...common, '--password-stdin'], { input: pwdIn })
  assert.equal(run.code, 0, run.stderr)
  run = runCli(['export', ...common, '--password-stdin', '--json'], { input: pwdIn })
  assert.equal(run.code, 0, run.stderr)
  // 删掉任意一个块文件
  const chunkDirs = await fs.readdir(path.join(repoDir, 'chunks'))
  let victimPath = null
  for (const a of chunkDirs) {
    for (const b of await fs.readdir(path.join(repoDir, 'chunks', a))) {
      for (const file of await fs.readdir(path.join(repoDir, 'chunks', a, b))) {
        victimPath = path.join(repoDir, 'chunks', a, b, file)
        break
      }
      if (victimPath) break
    }
    if (victimPath) break
  }
  assert.ok(victimPath)
  await fs.rm(victimPath)
  run = runCli(['verify', ...common, '--password-stdin', '--json'], { input: pwdIn })
  assert.equal(run.code, 2, `缺块时退出码应为 2，实际 ${run.code}；stderr=${run.stderr}`)
  const payload = parseJsonOutput(run)
  assert.equal(payload.ok, false)
  assert.equal(payload.snapshots[0].ok, false)
  assert.equal(payload.snapshots[0].missingChunks.length, 1)
  assert.match(payload.snapshots[0].missingNames[0], /^chunks\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.cbin$/)
  // 文本模式也必须打印具体块名
  const textRun = runCli(['verify', ...common, '--password-stdin'], { input: pwdIn })
  assert.equal(textRun.code, 2)
  assert.match(textRun.stdout, /缺块\s*:\s*1 个/)
  assert.match(textRun.stdout, /chunks\/[0-9a-f]{2}\//)
})

/* ══════════════════════════════════ 11. DPAPI 桥（task-6，不需要真实 DPAPI） */

test('dpapi 桥：可注入 runner；缺文件/缺脚本/解密失败都有明确 code（不打印密码）', async () => {
  const base = await tempDir('dbk-arch-dpapi-')
  const keyFile = path.join(base, 'key.dpapi')
  const scriptPath = path.join(base, 'dpapi.ps1')
  await fs.writeFile(scriptPath, '# fake dpapi script\n')
  await fs.writeFile(keyFile, `  ${Buffer.from('dpapi-ciphertext-blob').toString('base64')}\n\n`)

  assert.equal(dpapiAvailable(), process.platform === 'win32')

  // 读 blob：去掉空白
  const blob = await readDpapiBlob(keyFile)
  assert.equal(blob, Buffer.from('dpapi-ciphertext-blob').toString('base64'))
  await assert.rejects(() => readDpapiBlob(path.join(base, 'nope.dpapi')), (error) => {
    assert.equal(error.code, 'dpapi-missing')
    assert.match(error.message, /DPAPI|恢复密码/)
    return true
  })
  const emptyFile = path.join(base, 'empty.dpapi')
  await fs.writeFile(emptyFile, '  \n\t ')
  await assert.rejects(() => readDpapiBlob(emptyFile), (error) => error.code === 'dpapi-invalid')

  // 注入 runner：map blob → base64(密码)，全程不碰真实 DPAPI
  const expectedPassword = 'dpapi-secret-9'
  let seenBlob = null
  const ok = await passwordFromDpapi({
    file: keyFile,
    scriptPath,
    runner: async ({ blobBase64 }) => {
      seenBlob = blobBase64
      return Buffer.from(expectedPassword, 'utf8').toString('base64')
    },
  })
  assert.equal(ok, expectedPassword)
  assert.equal(seenBlob, blob, 'runner 应拿到 key.dpapi 里的 base64')

  // 解密失败 / 空结果 / 缺脚本
  await assert.rejects(
    () => passwordFromDpapi({
      file: keyFile, scriptPath, runner: async () => { const error = new Error('换用户了'); error.code = 'dpapi-failed'; throw error },
    }),
    (error) => error.code === 'dpapi-failed',
  )
  await assert.rejects(
    () => passwordFromDpapi({ file: keyFile, scriptPath, runner: async () => '   ' }),
    (error) => error.code === 'dpapi-failed',
  )
  await assert.rejects(
    () => passwordFromDpapi({ file: keyFile, scriptPath: path.join(base, 'missing.ps1') }),
    (error) => error.code === 'dpapi-missing',
  )

  // 平台不支持时 fail-closed（在当前平台下只能验证 Windows 分支可用）
  if (process.platform !== 'win32') {
    assert.equal(dpapiAvailable(), false)
    await assert.rejects(
      () => passwordFromDpapi({ file: keyFile, scriptPath }),
      (error) => error.code === 'dpapi-unavailable',
    )
  }
})

test('dpapi 兼容：面板 JSON{masterKey} 缓存 + LocalRepo.openWithMasterKey', async () => {
  const base = await tempDir('dbk-arch-dpapi2-')
  const keyFile = path.join(base, 'key.dpapi')
  const scriptPath = path.join(base, 'dpapi.ps1')
  await fs.writeFile(scriptPath, '# fake\n')
  await fs.writeFile(keyFile, Buffer.from('blob').toString('base64'))

  const { masterKey } = fmt.createRepoMeta({ password: PASSWORD })

  // parseDpapiSecret：面板 JSON（masterKey） / JSON（password） / 明文密码
  const fromJson = parseDpapiSecret(JSON.stringify({ v: 1, repoId: 'x', at: 1, masterKey: masterKey.toString('base64') }))
  assert.deepEqual(fromJson.masterKey, masterKey)
  assert.equal(parseDpapiSecret('plain-password-9').password, 'plain-password-9')
  assert.equal(parseDpapiSecret(JSON.stringify({ v: 1, password: 'json-password-9' })).password, 'json-password-9')
  // 坏缓存：明确 dpapi-failed，不能退化成「把 JSON 当密码」
  assert.throws(
    () => parseDpapiSecret(JSON.stringify({ v: 1, masterKey: Buffer.alloc(8).toString('base64') })),
    (error) => error.code === 'dpapi-failed',
  )
  assert.throws(() => parseDpapiSecret(JSON.stringify({ v: 1 })), (error) => error.code === 'dpapi-failed')
  assert.throws(() => parseDpapiSecret(''), (error) => error.code === 'dpapi-failed')

  // secretFromDpapi 走注入 runner（面板格式）
  const secret = await secretFromDpapi({
    file: keyFile,
    scriptPath,
    runner: async () => Buffer.from(JSON.stringify({ v: 1, masterKey: masterKey.toString('base64') })).toString('base64'),
  })
  assert.deepEqual(secret.masterKey, masterKey)
  assert.equal(secret.password, undefined, '拿到的应是 masterKey 而不是密码')

  // LocalRepo.openWithMasterKey：正确密钥可解锁，错 key 明确 bad-password，长度不对报 bad-master-key
  const repoDir = path.join(base, 'repo')
  const repo = await LocalRepo.init({ dir: repoDir, password: PASSWORD, chunkSize: 1024 })
  try {
    const viaKey = await LocalRepo.openWithMasterKey({ dir: repoDir, masterKey: repo.masterKey })
    assert.equal(viaKey.unlocked, true)
    const plain = Buffer.from('open-by-master-key')
    const hash = sha256hex(plain)
    assert.equal(await viaKey.putChunk(hash, plain), 'created')
    assert.deepEqual(await viaKey.getChunk(hash), plain, '用 masterKey 打开后必须能真正加解密')
    viaKey.close()
    await assert.rejects(
      () => LocalRepo.openWithMasterKey({ dir: repoDir, masterKey: Buffer.alloc(32, 9) }),
      (error) => error.code === 'bad-password',
    )
    await assert.rejects(
      () => LocalRepo.openWithMasterKey({ dir: repoDir, masterKey: Buffer.alloc(8) }),
      (error) => error.code === 'bad-master-key',
    )
  } finally {
    repo.close()
  }
})

test('CLI/kit --dpapi 复用面板 JSON 缓存（fake dpapi.ps1，不依赖真实 DPAPI）', async (t) => {
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8' })
  if (!probe || probe.error || probe.status !== 0) {
    t.skip('pwsh 不可用，跳过 fake dpapi.ps1 端到端')
    return
  }
  const home = await makeHome('dbk-arch-dpapi-cli-home-')
  const root = await tempDir('dbk-arch-dpapi-cli-root-')
  const base = await tempDir('dbk-arch-dpapi-cli-')
  // 先让引擎拍一次快照（export 需要 store 里有快照；CLI 自己不会拍）
  const seeded = await startEngine(home, root, { chunkSize: 1024 })
  await seeded.stop()
  const repoDir = path.join(base, 'offsite', 'repo')
  const command = ['--home', home, '--root', root, '--dir', repoDir]
  const pwdIn = `${PASSWORD}\n`
  let run = runCli(['init', ...command, '--password-stdin'], { input: pwdIn })
  assert.equal(run.code, 0, run.stderr)

  // 取仓库 masterKey（模拟面板 DPAPI 缓存里存的内容）；先复制再 close（close 会清零原 buffer）
  const opened = await LocalRepo.open({ dir: repoDir, password: PASSWORD })
  const masterKey = Buffer.from(opened.masterKey)
  opened.close()
  assert.equal(masterKey.equals(Buffer.alloc(32)), false)

  // 造一个 key.dpapi（内容对 fake 脚本无意义）+ fake dpapi.ps1：无视 blob，直接输出 base64(指定明文)
  const keyFile = path.join(base, 'offsite', 'key.dpapi')
  await fs.writeFile(keyFile, Buffer.from('fake-dpapi-blob').toString('base64'))
  const fakeScript = path.join(base, 'fake-dpapi.ps1')
  const writeFake = async (plaintext) => {
    const encoded = Buffer.from(plaintext, 'utf8').toString('base64')
    await fs.writeFile(fakeScript, `param([string]$Mode)\n[Console]::Out.Write('${encoded}')\n`)
  }

  // (a) 面板格式：JSON{masterKey} → CLI export --dpapi 应成功
  await writeFake(JSON.stringify({ v: 1, repoId: 'x', at: Date.now(), masterKey: masterKey.toString('base64') }))
  run = runCli(['export', ...command, '--dpapi', '--dpapi-script', fakeScript, '--json'], { input: pwdIn })
  assert.equal(run.code, 0, `面板 JSON 缓存解锁失败：stdout=${run.stdout} stderr=${run.stderr}`)
  const firstExport = parseJsonOutput(run)
  assert.equal(firstExport.ok, true)
  assert.ok(firstExport.newChunks > 0)
  assert.equal(firstExport.seq, 1)

  // (b) 明文密码格式（task-6 文档里的 base64(密码)）→ 也能解锁；重导出幂等
  await writeFake(PASSWORD)
  run = runCli(['export', ...command, '--dpapi', '--dpapi-script', fakeScript, '--json'])
  assert.equal(run.code, 0, `明文密码缓存解锁失败：${run.stderr}`)
  const secondExport = parseJsonOutput(run)
  assert.equal(secondExport.newChunks, 0, '重导出应幂等')
  assert.equal(secondExport.seq, 1)

  // (c) 错 masterKey → bad-password（exit 1，不泄露）
  await writeFake(JSON.stringify({ v: 1, masterKey: Buffer.alloc(32, 7).toString('base64') }))
  run = runCli(['verify', ...command, '--dpapi', '--dpapi-script', fakeScript, '--json'])
  assert.equal(run.code, 1, run.stdout)
  const failed = parseJsonOutput(run)
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'bad-password')
  assert.equal(run.stdout.includes(PASSWORD), false)

  // (d) 坏 masterKey 长度 → dpapi-failed（exit 4）
  await writeFake(JSON.stringify({ v: 1, masterKey: Buffer.alloc(8).toString('base64') }))
  run = runCli(['verify', ...command, '--dpapi', '--dpapi-script', fakeScript, '--json'])
  assert.equal(run.code, 4, run.stdout)
  assert.equal(parseJsonOutput(run).error.code, 'dpapi-failed')

  // (e) recovery-kit 的 recover.mjs 也能用同一份面板缓存格式
  await writeFake(JSON.stringify({ v: 1, masterKey: masterKey.toString('base64') }))
  const kitRecover = path.join(repoDir, 'recovery-kit', 'recover.mjs')
  run = runRecover(kitRecover, ['verify', '--dir', repoDir, '--dpapi', '--dpapi-script', fakeScript, '--json'])
  assert.equal(run.code, 0, `kit --dpapi 失败：${run.stderr}`)
  assert.equal(parseJsonOutput(run).ok, true)

  // (f) 没给 DPAPI 缓存路径时仍要报清楚（--dpapi 且 key.dpapi 被删 → exit 4）
  await fs.rm(keyFile)
  run = runCli(['verify', ...command, '--dpapi', '--dpapi-script', fakeScript, '--json'])
  assert.equal(run.code, 4)
  assert.equal(parseJsonOutput(run).error.code, 'dpapi-missing')
})

/* ═══════════════════════════════════ 12. recovery-kit 写入 / 自校验 / 修复 */

test('ensureRecoveryKit：init/导出自动写入、幂等、可修复，kit 里没有密码', async () => {
  const base = await tempDir('dbk-arch-kit-')
  const dir = path.join(base, 'offsite', 'repo')
  const repo = await LocalRepo.init({ dir, password: PASSWORD, chunkSize: 1024 })
  const kitDir = path.join(dir, RECOVERY_KIT_DIRNAME)
  try {
    // init 就应写入 kit（不用等导出）
    const expected = [
      'recover.mjs', 'dpapi.ps1', 'README.txt', 'kit.json',
      'src/archive/format.js', 'src/archive/repo.js', 'src/archive/recovery.js',
      'src/archive/dpapi.js', 'src/util.js',
    ]
    for (const rel of expected) {
      const stat = await fs.stat(path.join(kitDir, ...rel.split('/')))
      assert.ok(stat.isFile(), `kit 缺少 ${rel}`)
      assert.ok(stat.size > 0, `kit 文件为空：${rel}`)
    }
    // kit.json 记录每个文件 sha256，且与磁盘一致
    const kitJson = JSON.parse(await fs.readFile(path.join(kitDir, 'kit.json'), 'utf8'))
    assert.equal(kitJson.format, RECOVERY_KIT_FORMAT)
    for (const [rel, digest] of Object.entries(kitJson.files)) {
      const buf = await fs.readFile(path.join(kitDir, ...rel.split('/')))
      assert.equal(sha256hex(buf), digest, `${rel} 的 kit.json 摘要应一致`)
    }
    // kit 里绝不能出现密码
    for (const rel of expected) {
      const raw = await fs.readFile(path.join(kitDir, ...rel.split('/')), 'utf8')
      assert.equal(raw.includes(PASSWORD), false, `kit 文件 ${rel} 不得包含密码`)
    }
    // README 有命令示例与密码提示
    const readme = await fs.readFile(path.join(kitDir, 'README.txt'), 'utf8')
    assert.match(readme, /recover\.mjs restore --dir/)
    assert.match(readme, /密码丢失/)

    // 幂等：内容没变 → 不重写
    const again = await ensureRecoveryKit(repo)
    assert.deepEqual(again.written, [], `内容没变不应重写：${JSON.stringify(again.written)}`)
    let status = await recoveryKitStatus(dir)
    assert.equal(status.present, true)
    assert.deepEqual(status.missing, [])
    assert.deepEqual(status.stale, [])

    // 篡改一个 kit 文件 → status 报 stale；ensure 修复（并不需要密码）
    const victim = path.join(kitDir, 'src', 'archive', 'format.js')
    await fs.appendFile(victim, '\n// tampered\n')
    status = await recoveryKitStatus(dir)
    assert.deepEqual(status.stale, ['src/archive/format.js'])
    const repaired = await ensureRecoveryKit(dir)
    assert.ok(repaired.written.includes('src/archive/format.js'))
    assert.deepEqual((await recoveryKitStatus(dir)).stale, [])

    // 缺文件也能报出来并修复
    await fs.rm(path.join(kitDir, 'recover.mjs'))
    assert.ok((await recoveryKitStatus(dir)).missing.includes('recover.mjs'))
    await ensureRecoveryKit(repo)
    assert.equal(await fspExists(path.join(kitDir, 'recover.mjs')), true)

    // --force 重写
    const forced = await ensureRecoveryKit(repo, { force: true })
    assert.ok(forced.written.length >= expected.length)
  } finally {
    repo.close()
  }

  // CLI `kit` 命令可修复，且 status 里能看到 kit 就绪
  const home = await makeHome()
  const root = await tempDir('dbk-arch-kit-root-')
  const command = ['--home', home, '--root', root, '--dir', dir]
  const kitRun = runCli(['kit', ...command, '--json'])
  assert.equal(kitRun.code, 0, kitRun.stderr)
  const kitPayload = parseJsonOutput(kitRun)
  assert.equal(kitPayload.ok, true)
  assert.equal(kitPayload.status.present, true)
  assert.ok(kitPayload.files.includes('recover.mjs'))
  // 删掉 kit.json 后 status 报「不完整」，kit 命令修复
  await fs.rm(path.join(dir, RECOVERY_KIT_DIRNAME, 'kit.json'))
  const before = runCli(['status', ...command, '--json'])
  assert.equal(parseJsonOutput(before).recoveryKit.ok, false)
  assert.ok(parseJsonOutput(before).recoveryKit.missing.includes('kit.json'))
  const fixed = runCli(['kit', ...command, '--json'])
  assert.equal(fixed.code, 0, fixed.stderr)
  assert.equal(parseJsonOutput(fixed).status.ok, true)
  const after = runCli(['status', ...command, '--json'])
  assert.equal(parseJsonOutput(after).recoveryKit.ok, true)
})

/* ═════════════════ 13. recovery-kit 离线恢复（复制仓库→删本机依赖→只凭 kit 恢复） */

test('recovery-kit：只把仓库目录拷到别处、删掉本机 repo/store/home 后仍能恢复并逐文件一致', async () => {
  const home = await makeHome('dbk-arch-kit-home-')
  await fs.writeFile(path.join(home, 'sessions', '--D-x--', 'session-1', 'session.v4.jsonl.zstd'), 'k'.repeat(2500))
  const root = await tempDir('dbk-arch-kit-root-')
  const base = await tempDir('dbk-arch-kit-origin-')
  const engine = await startEngine(home, root, { chunkSize: 1024 })
  const repo = await LocalRepo.init({ dir: path.join(base, 'offsite', 'repo'), password: PASSWORD, chunkSize: 1024 })
  try {
    const id = engine.latestSnapshotId()
    const manifest = await engine.store.readManifest(id)
    const expected = await readSnapshotFiles(engine, manifest)
    const exported = await exportSnapshot({ engine, repo, snapshotId: id })
    assert.ok(exported.newChunks > 0)

    // 子机视角：把整个仓库目录（含 recovery-kit）复制到另一个临时路径
    const { peerRoot, peerRepo } = await copyRepoForPeer(repo.dir)
    const kitRecover = path.join(peerRepo, RECOVERY_KIT_DIRNAME, 'recover.mjs')
    assert.ok(await fs.stat(kitRecover), '仓库副本里必须带 recovery-kit/recover.mjs')

    // 本机被毁：本地仓库、ledger、store、home 全部删除（都在临时目录，删除安全）
    repo.close()
    await engine.stop()
    await fs.rm(base, { recursive: true, force: true })
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
    assert.equal(await isRepoDir(repo.dir), false)

    const pwdIn = `${PASSWORD}\n`
    // 1) list（kit 副本，独立运行，不依赖插件仓库）
    let run = runRecover(kitRecover, ['list', '--dir', peerRepo, '--password-stdin', '--json'], { input: pwdIn })
    assert.equal(run.code, 0, run.stderr)
    const listed = parseJsonOutput(run)
    assert.equal(listed.ok, true)
    assert.equal(listed.snapshots.length, 1)
    assert.equal(listed.snapshots[0].snapshotId, id)
    assert.equal(listed.snapshots[0].files, Object.keys(expected).length)

    // 2) verify
    run = runRecover(kitRecover, ['verify', '--dir', peerRepo, '--password-stdin', '--json'], { input: pwdIn })
    assert.equal(run.code, 0, run.stderr)
    const verified = parseJsonOutput(run)
    assert.equal(verified.ok, true)
    assert.equal(verified.snapshots[0].ok, true)
    assert.equal(verified.snapshots[0].missingChunks.length, 0)

    // 3) restore 到全新的空目录
    const targetRoot = await tempDir('dbk-arch-kit-target-')
    const target = path.join(targetRoot, 'restored')
    run = runRecover(kitRecover, [
      'restore', '--dir', peerRepo, '--home', target, '--password-stdin', '--yes', '--json',
    ], { input: pwdIn })
    assert.equal(run.code, 0, `restore 失败：${run.stderr}`)
    const restored = parseJsonOutput(run)
    assert.equal(restored.ok, true)
    assert.equal(restored.restored, Object.keys(expected).length)
    assert.equal(restored.needRestart, true)
    // 逐文件 sha256 与清单一致（这里直接与灾难前内容比对）
    for (const [rel, buf] of Object.entries(expected)) {
      assert.deepEqual(await fs.readFile(path.join(target, ...rel.split('/'))), buf, `${rel} 必须逐字节一致`)
    }
    // quarantine 目录里应有审计报告（即使没有覆盖任何文件）
    const quarantines = await fs.readdir(path.join(peerRoot, 'offsite', 'recovery-quarantine'))
    assert.equal(quarantines.length, 1)
    const reportPath = path.join(peerRoot, 'offsite', 'recovery-quarantine', quarantines[0], '_recovery-report.json')
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'))
    assert.equal(report.snapshotId, id)
    assert.equal(report.ok, true)

    // 4) 开发目录里的 scripts/recover.mjs 也能对同一仓库副本工作（双布局兼容）
    run = runRecover(RECOVER_PATH, ['verify', '--dir', peerRepo, '--password-stdin', '--json'], { input: pwdIn })
    assert.equal(run.code, 0, run.stderr)
    assert.equal(parseJsonOutput(run).ok, true)
  } finally {
    try { repo.close() } catch { /* 已关闭 */ }
    try { await engine.stop() } catch { /* 已停止 */ }
  }
})

test('recovery-kit 安全语义：非空拒绝 / --force+quarantine / 多余文件保留 / 缺块拒绝 / 错密码 / --dpapi 缺缓存', async () => {
  const home = await makeHome('dbk-arch-kitsafe-home-')
  const root = await tempDir('dbk-arch-kitsafe-root-')
  const base = await tempDir('dbk-arch-kitsafe-origin-')
  const engine = await startEngine(home, root, { chunkSize: 1024 })
  const repo = await LocalRepo.init({ dir: path.join(base, 'offsite', 'repo'), password: PASSWORD, chunkSize: 1024 })
  try {
    const id = engine.latestSnapshotId()
    const exported = await exportSnapshot({ engine, repo, snapshotId: id })
    const { peerRoot, peerRepo } = await copyRepoForPeer(repo.dir)
    const kitRecover = path.join(peerRepo, RECOVERY_KIT_DIRNAME, 'recover.mjs')
    const pwdIn = `${PASSWORD}\n`

    // a) 错密码：退出码 1，不泄露清单名
    let run = runRecover(kitRecover, ['verify', '--dir', peerRepo, '--password-stdin'], { input: 'wrong-password-9\n' })
    assert.equal(run.code, 1)
    assert.match(run.stderr, /bad-password/)
    assert.equal(run.stdout.includes('manifests/'), false)

    // b) 目标非空、没有 --force：拒绝（且不动文件）
    const target = await tempDir('dbk-arch-kitsafe-target-')
    await fs.writeFile(path.join(target, 'workspace.json'), '{"v":999}')
    await fs.writeFile(path.join(target, 'extra.txt'), 'do-not-touch')
    run = runRecover(kitRecover, [
      'restore', '--dir', peerRepo, '--home', target, '--password-stdin', '--yes',
    ], { input: pwdIn })
    assert.equal(run.code, 1)
    assert.match(run.stderr, /--force|非空/)
    assert.equal(await fs.readFile(path.join(target, 'workspace.json'), 'utf8'), '{"v":999}', '拒绝时不得写任何文件')

    // c) --force：被覆盖文件进 quarantine，多余文件保留，内容恢复正确
    run = runRecover(kitRecover, [
      'restore', '--dir', peerRepo, '--home', target, '--password-stdin', '--yes', '--force', '--json',
    ], { input: pwdIn })
    assert.equal(run.code, 0, `restore --force 失败：${run.stderr}`)
    const forced = parseJsonOutput(run)
    assert.equal(forced.ok, true)
    assert.ok(forced.quarantined >= 1, '被覆盖的文件必须进 quarantine')
    assert.ok(forced.restored >= 1)
    assert.equal(await fs.readFile(path.join(target, 'workspace.json'), 'utf8'), '{"v":1}')
    assert.equal(await fs.readFile(path.join(target, 'extra.txt'), 'utf8'), 'do-not-touch', '清单外文件不得删除')
    assert.ok(forced.extraLeft >= 1)
    // quarantine 里留着被覆盖的旧内容
    const quarantinedCopy = path.join(forced.quarantineDir, 'workspace.json')
    assert.equal(await fs.readFile(quarantinedCopy, 'utf8'), '{"v":999}')
    assert.ok(await fs.stat(path.join(forced.quarantineDir, '_recovery-report.json')))

    // d) 不安全目标（仓库目录内/互相包含）：拒绝
    run = runRecover(kitRecover, [
      'restore', '--dir', peerRepo, '--home', peerRepo, '--password-stdin', '--yes',
    ], { input: pwdIn })
    assert.equal(run.code, 1)
    assert.match(run.stderr, /unsafe-target|拒绝恢复到该目录/)

    // e) 非交互没有 --yes：拒绝（避免无声覆盖）
    const freshTarget = path.join(await tempDir('dbk-arch-kitsafe-fresh-'), 'home')
    run = runRecover(kitRecover, ['restore', '--dir', peerRepo, '--home', freshTarget, '--password-stdin'], { input: pwdIn })
    assert.equal(run.code, 1)
    assert.match(run.stderr, /need-confirm|--yes/)

    // f) 缺块：verify 退出码 2 并列出块名；restore 整体拒绝、目标一个新文件都不写
    const chunksRoot = path.join(peerRepo, 'chunks')
    let victimPath = null
    for (const a of await fs.readdir(chunksRoot)) {
      for (const b of await fs.readdir(path.join(chunksRoot, a))) {
        for (const file of await fs.readdir(path.join(chunksRoot, a, b))) {
          victimPath = path.join(chunksRoot, a, b, file)
          break
        }
        if (victimPath) break
      }
      if (victimPath) break
    }
    assert.ok(victimPath)
    await fs.rm(victimPath)
    run = runRecover(kitRecover, ['verify', '--dir', peerRepo, '--password-stdin', '--json'], { input: pwdIn })
    assert.equal(run.code, 2)
    const missing = parseJsonOutput(run)
    assert.equal(missing.ok, false)
    assert.equal(missing.snapshots[0].missingChunks.length, 1)
    assert.match(missing.snapshots[0].missingNames[0], /^chunks\//)
    const emptyTarget = path.join(await tempDir('dbk-arch-kitsafe-empty-'), 'home')
    run = runRecover(kitRecover, [
      'restore', '--dir', peerRepo, '--home', emptyTarget, '--password-stdin', '--yes', '--json',
    ], { input: pwdIn })
    assert.equal(run.code, 2, '缺块必须整体拒绝（退出码 2）')
    assert.equal(JSON.parse(run.stdout).ok, false)
    assert.equal(await fspExists(emptyTarget), false, '拒绝时连目标目录都不该创建')

    // g) --dpapi 但没有缓存文件：退出码 4，文案明确，不打印密码
    run = runRecover(kitRecover, [
      'restore', '--dir', peerRepo, '--home', freshTarget, '--yes', '--dpapi',
    ])
    assert.equal(run.code, 4, run.stderr)
    assert.match(run.stderr, /dpapi/i)
    assert.equal(run.stderr.includes(PASSWORD), false)
    assert.equal(run.stdout.includes(PASSWORD), false)

    // h) 没有密码来源且非 TTY：退出码 4
    run = runRecover(kitRecover, ['verify', '--dir', peerRepo])
    assert.equal(run.code, 4)
    assert.match(run.stderr, /password-required|需要密码/)

    // i) 拒绝命令行明文密码
    run = runRecover(kitRecover, ['verify', '--dir', peerRepo, '--password', PASSWORD])
    assert.equal(run.code, 4)
    assert.match(run.stderr, /password-argv/)
  } finally {
    repo.close()
    await engine.stop()
  }
})

/** fsp.access 存在性（不存在返回 false）。 */
async function fspExists(target) {
  try { await fs.stat(target); return true } catch { return false }
}

/* ═══════════════════════ 14. engine.uniqueId：激进 prune 下同秒快照 id 不复用 */

test('engine.uniqueId：keepLast=1 连续同秒快照 id 不重复，导出不会覆盖同名清单', async () => {
  const home = await tempDir('dbk-arch-uid-home-')
  const dataFile = path.join(home, 'data.bin')
  await fs.writeFile(dataFile, 'seed')
  const root = await tempDir('dbk-arch-uid-root-')
  const engine = await startEngine(home, root, {
    chunkSize: 1024, keepLast: 1, keepHourlyHours: 0, keepDailyDays: 0, maxSnapshots: 5,
  })
  const base = await tempDir('dbk-arch-uid-repo-')
  const repo = await LocalRepo.init({ dir: path.join(base, 'offsite', 'repo'), password: PASSWORD, chunkSize: 1024 })
  try {
    const ids = []
    const exported = []
    const contents = []
    for (let index = 0; index < 5; index += 1) {
      // 内容互不相同（同样长度，专门覆盖“同秒 + 同大小”的最恶劣情况）
      const content = `content-${index}-` + 'x'.repeat(60)
      contents.push(content)
      await fs.writeFile(dataFile, content)
      const snap = await engine.snapshot('manual')
      assert.ok(snap.id, `第 ${index + 1} 个快照应写入（不能被跳过）`)
      ids.push(snap.id)
      exported.push(await exportSnapshot({ engine, repo, snapshotId: snap.id }))
      // 激进 prune 后列表里只剩 1~2 个，但最近 id 必须仍被记住
      assert.equal(engine.isRecentSnapshotId(snap.id), true)
    }
    assert.equal(new Set(ids).size, ids.length, `快照 id 不得复用：${ids.join(', ')}`)
    assert.equal(new Set(exported.map((item) => item.manifestName)).size, ids.length, '清单名不得重复')
    // 每份清单都能解出、且指向自己那一版内容（没被后一次导出覆盖）
    for (let index = 0; index < ids.length; index += 1) {
      const payload = await repo.getManifestByName(exported[index].manifestName)
      assert.equal(payload.snapshot.id, ids[index])
      const hash = sha256hex(Buffer.from(contents[index]))
      assert.deepEqual(payload.snapshot.files['data.bin'].c, [hash],
        `快照 ${ids[index]} 的清单必须仍指向它自己的内容`)
    }
    // seq 连续递增，没有因为 id 复用而错乱
    assert.deepEqual(exported.map((item) => item.seq), [1, 2, 3, 4, 5])
    const ledger = await readLedger(repo.dir)
    assert.equal(ledger.entries.length, 5)
    assert.equal((await checkLedgerChain(ledger, repo)).ok, true)
    // 被 prune 掉的旧 id 必须仍在最近集合里（这是修复的核心）
    assert.equal(engine.isRecentSnapshotId(ids[0]), true)
  } finally {
    repo.close()
    await engine.stop()
  }
})
