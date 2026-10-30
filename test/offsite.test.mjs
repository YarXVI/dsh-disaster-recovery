/**
 * 异地副本编排测试：全部用依赖注入的 fake archive / fake dshSync / fake DPAPI /
 * fake 引擎，不需要真实的 src/archive/*（core 队友并行实现）、不需要联网、
 * 不写真实 DSH_HOME。真实文件系统只用于临时目录里的仓库/ledger 落盘验证。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import {
  ARCHIVE_PORT_METHODS,
  OFFSITE_DEFAULTS,
  PACK_TARGET_BYTES,
  UPLOAD_SLICE_BYTES,
  createArchivePort,
  createOffsiteService,
  isRepoName,
  normalizeLedger,
  normalizeOffsiteConfig,
  parseSchedule,
  planRetention,
  repoPath,
  runHeadlessExport,
  scheduleDueAt,
  validatePassword,
} from '../src/offsite.js'
import { createPanelHandler } from '../src/panel.js'

/* ------------------------------------------------------------------ 工具 */

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const hmacLike = (tag, value) => sha256(`${tag}:${value}`)

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function removeTemp(dir) {
  const tmp = path.resolve(os.tmpdir())
  const abs = path.resolve(dir)
  if (!abs.startsWith(tmp + path.sep)) throw new Error(`refuse to remove outside temp: ${abs}`)
  await fsp.rm(abs, { recursive: true, force: true })
}

/* --------------------------------------------------------- fake archive */

/** fake 加密仓库：编码方式可预测，但仓库文件布局/命名与设计文档一致。 */
function createFakeArchive() {
  const headers = new Map() // dir -> { repoId, salt, verifier, createdAt }
  const repoFile = (dir) => path.join(dir, 'repo.json')

  const readHeader = async (dir) => {
    if (headers.has(dir)) return headers.get(dir)
    const raw = JSON.parse(await fsp.readFile(repoFile(dir), 'utf8'))
    headers.set(dir, raw)
    return raw
  }
  const masterFor = (password, salt) => createHash('sha256').update(`master:${salt}:${password}`).digest()
  const keyFor = (dir, masterKey) => ({ dir, masterKey: Buffer.from(masterKey) })

  return {
    async initRepo({ dir, password, chunkSize = 65536 }) {
      if (await fsp.access(repoFile(dir)).then(() => true, () => false)) {
        throw Object.assign(new Error('repo exists'), { code: 'repo-exists' })
      }
      const salt = createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 32)
      const header = {
        format: 'dsh-dr-repo',
        version: 1,
        repoId: sha256(`repo:${salt}`).slice(0, 16),
        createdAt: Date.now(),
        kdf: { name: 'scrypt', N: 131072, r: 8, p: 1, salt },
        cipher: 'aes-256-gcm',
        chunkSize,
        verifier: sha256(`verifier:${salt}:${password}`),
      }
      await fsp.writeFile(repoFile(dir), JSON.stringify(header, null, 2))
      headers.set(dir, header)
      return keyFor(dir, masterFor(password, salt))
    },

    async openRepoKey({ dir, password }) {
      const header = await readHeader(dir)
      const verifier = sha256(`verifier:${header.kdf.salt}:${password}`)
      if (verifier !== header.verifier) throw Object.assign(new Error('bad password'), { code: 'bad-password' })
      return keyFor(dir, masterFor(password, header.kdf.salt))
    },

    async keyFromMasterKey({ dir, masterKey }) {
      const header = await readHeader(dir)
      return keyFor(dir, Buffer.from(masterKey))
    },

    async masterKeyOf(key) {
      return Buffer.from(key.masterKey)
    },

    async chunkName({ key, plainHash }) {
      const name = hmacLike(`chunk:${sha256(key.masterKey).slice(0, 4)}`, plainHash)
      return `chunks/${name.slice(0, 2)}/${name.slice(2, 4)}/${name}.cbin`
    },

    async manifestName({ key, snapshotId }) {
      return `manifests/${hmacLike(`manifest:${sha256(key.masterKey).slice(0, 4)}`, snapshotId)}.mbin`
    },

    async encodeChunk({ key, plainBuf }) {
      const plainHash = sha256(plainBuf)
      const name = await this.chunkName({ key, plainHash })
      return { name, plainHash, buf: Buffer.concat([Buffer.from('DRA1'), Buffer.from(plainBuf)]) }
    },

    async decodeChunk({ key, name, buf }) {
      assert.equal(buf.subarray(0, 4).toString(), 'DRA1', 'chunk magic')
      const plainBuf = Buffer.from(buf.subarray(4))
      const plainHash = sha256(plainBuf)
      assert.equal(await this.chunkName({ key, plainHash }), name, 'chunk name 与内容不匹配')
      return { plainBuf, plainHash }
    },

    async encodeManifest({ key, manifest }) {
      const name = await this.manifestName({ key, snapshotId: manifest.snapshot.id })
      const buf = Buffer.from(JSON.stringify(manifest))
      return { name, buf, sha256: sha256(buf) }
    },

    async decodeManifest({ key, name, buf }) {
      const manifest = JSON.parse(buf.toString('utf8'))
      const expected = await this.manifestName({ key, snapshotId: manifest.snapshot.id })
      assert.equal(expected, name, 'manifest name 与快照 id 不匹配')
      return { manifest, sha256: sha256(buf) }
    },

    async buildPack({ key, entries }) {
      const digest = entries.map((entry) => entry.name).join('|')
      const name = `packs/${hmacLike(`pack:${sha256(key.masterKey).slice(0, 4)}`, digest)}.pbin`
      const buf = Buffer.from(JSON.stringify({
        format: 'DRP1',
        entries: entries.map((entry) => ({ name: entry.name, data: entry.buf.toString('base64') })),
      }))
      return { name, buf }
    },

    async unpackPack({ key, name, buf }) {
      const parsed = JSON.parse(buf.toString('utf8'))
      return parsed.entries.map((entry) => ({ name: entry.name, buf: Buffer.from(entry.data, 'base64') }))
    },
  }
}

/* ------------------------------------------------------------- fake 子机 */

/** 单个「文件柜」节点：只存不透明文件，不解释内容。 */
function createCabinetNode({ deviceId, name, online = true, trusted = true }) {
  return {
    deviceId: String(deviceId),
    name: String(name || deviceId),
    online: Boolean(online),
    trusted: Boolean(trusted),
    files: new Map(), // name -> Buffer
    uploads: new Map(),
    calls: [],
    seq: 0,
  }
}

async function handleCabinetOp(node, op, payload = {}) {
  node.calls.push({ op, payload })
  if (!node.online) throw Object.assign(new Error(`设备不在线: ${node.deviceId}`), { code: 'peer-offline' })
  switch (op) {
    case 'ext.dr.repo.list': {
      const limit = Math.min(500, Number(payload.limit) || 500)
      const names = [...node.files.entries()]
        .map(([name, buf]) => ({ name, size: buf.length }))
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .slice(0, limit)
      return { names, cursor: null }
    }
    case 'ext.dr.repo.putBegin': {
      if (node.files.has(payload.name)) return { exists: true, name: payload.name }
      node.seq += 1
      const uploadId = `u${node.seq}`
      node.uploads.set(uploadId, { name: payload.name, size: payload.size, sha256: payload.sha256, chunks: [] })
      return { uploadId }
    }
    case 'ext.dr.repo.putChunk': {
      const upload = node.uploads.get(payload.uploadId)
      if (!upload) throw Object.assign(new Error('bad uploadId'), { code: 'bad-upload' })
      upload.chunks[payload.index] = Buffer.from(String(payload.dataBase64 || ''), 'base64')
      return { received: upload.chunks[payload.index].length }
    }
    case 'ext.dr.repo.putCommit': {
      const upload = node.uploads.get(payload.uploadId)
      if (!upload) throw Object.assign(new Error('bad uploadId'), { code: 'bad-upload' })
      const buf = Buffer.concat(upload.chunks.filter(Boolean))
      assert.equal(buf.length, upload.size, '上传后长度必须与 putBegin 一致')
      assert.equal(sha256(buf), upload.sha256, '上传后 sha256 必须与 putBegin 一致')
      node.files.set(upload.name, buf)
      node.uploads.delete(payload.uploadId)
      return { name: upload.name, size: buf.length, sha256: sha256(buf) }
    }
    case 'ext.dr.repo.putAbort': {
      node.uploads.delete(payload.uploadId)
      return { ok: true }
    }
    case 'ext.dr.repo.get': {
      const buf = node.files.get(payload.name)
      if (!buf) throw Object.assign(new Error('missing'), { code: 'missing' })
      const offset = Number(payload.offset) || 0
      const length = Number(payload.length) || buf.length
      return {
        name: payload.name,
        size: buf.length,
        offset,
        dataBase64: buf.subarray(offset, offset + length).toString('base64'),
      }
    }
    case 'ext.dr.repo.delete': {
      const deleted = []
      const missing = []
      for (const name of payload.names || []) {
        if (node.files.delete(name)) deleted.push(name)
        else missing.push(name)
      }
      return { deleted, missing }
    }
    default:
      throw Object.assign(new Error(`unknown op ${op}`), { code: 'unknown-op' })
  }
}

/**
 * fake dshSync（多子机）：peers() 一次返回多个设备，rpc(deviceId, ...) 分发到对应文件柜。
 * 用于验证「多 peer 选择 / 选中设备离线报错 / 失效回退」。
 */
function createFakeSyncGroup(devices) {
  const nodes = new Map()
  for (const device of devices) {
    const node = createCabinetNode(device)
    nodes.set(node.deviceId, node)
  }
  const api = {
    peers() {
      return [...nodes.values()].map((node) => ({
        deviceId: node.deviceId,
        name: node.name,
        online: node.online,
        trusted: node.trusted,
        host: '127.0.0.1',
        port: 47821,
        lastSyncAt: null,
      }))
    },
    async rpc(peerId, op, payload = {}) {
      const id = String(peerId || '')
      const node = nodes.get(id)
      if (!node) throw Object.assign(new Error(`设备尚未配对: ${id}`), { code: 'not-paired' })
      return handleCabinetOp(node, op, payload)
    },
  }
  return {
    api,
    nodes,
    devices: () => [...nodes.values()],
    filesOf: (id) => nodes.get(String(id)).files,
    callsOf: (id) => nodes.get(String(id)).calls,
    addDevice: (device) => {
      const node = createCabinetNode(device)
      nodes.set(node.deviceId, node)
      return node
    },
    removeDevice: (id) => nodes.delete(String(id)),
    setOnline: (id, online) => { nodes.get(String(id)).online = Boolean(online) },
    setTrusted: (id, trusted) => { nodes.get(String(id)).trusted = Boolean(trusted) },
  }
}

/** 单子机适配器（既有用例大量使用 env.peer.files / calls / api）。 */
function createFakePeer({ online = true, trusted = true, deviceId = 'peer-abcdef01', name = '子机' } = {}) {
  const group = createFakeSyncGroup([{ deviceId, name, online, trusted }])
  const node = group.nodes.get(deviceId)
  return {
    api: group.api,
    files: node.files,
    calls: node.calls,
    state: {
      get online() { return node.online },
      set online(value) { node.online = Boolean(value) },
      get trusted() { return node.trusted },
    },
    deviceId,
    name,
    group,
    node,
  }
}

/* ------------------------------------------------------------- fake DPAPI */

function createFakeDpapi() {
  const blobs = new Map()
  return {
    available: true,
    protect: async (text) => {
      const b64 = Buffer.from(`DPAPI:${text}`, 'utf8').toString('base64')
      blobs.set(b64, text)
      return b64
    },
    unprotect: async (b64) => {
      const text = blobs.get(String(b64).trim())
      if (text == null) throw new Error('DPAPI blob 不属于当前用户')
      return text
    },
    get size() { return blobs.size },
  }
}

/* ------------------------------------------------------------- fake 引擎 */

const CHUNK_SIZE = 64 * 1024

function createFakeEngine({ home, storeDir, snapshots = {}, current = null, withSnapshot = true } = {}) {
  const manifests = new Map()
  const blobs = new Map()
  const calls = []
  const engine = {
    home,
    storeDir,
    hostname: 'test-host',
    config: { root: path.dirname(storeDir) },
    pinned: new Set(),
    calls,
    store: {},
  }
  const hashOf = (buf) => sha256(buf)

  const registerFiles = (files) => {
    const out = {}
    let total = 0
    let at = 1700000000000
    for (const [rel, content] of Object.entries(files)) {
      const buf = Buffer.from(content)
      const chunks = []
      for (let offset = 0; offset < buf.length; offset += CHUNK_SIZE) {
        const piece = buf.subarray(offset, Math.min(offset + CHUNK_SIZE, buf.length))
        const hash = hashOf(piece)
        blobs.set(hash, Buffer.from(piece))
        chunks.push(hash)
      }
      out[rel] = { s: buf.length, m: at, c: chunks }
      total += buf.length
      at += 1000
    }
    return { files: out, total }
  }

  engine.store = {
    dir: storeDir,
    has: async (hash) => blobs.has(hash),
    get: async (hash) => {
      if (!blobs.has(hash)) throw new Error(`ENOENT ${hash}`)
      return blobs.get(hash)
    },
    put: async (buf) => {
      const hash = hashOf(buf)
      if (!blobs.has(hash)) blobs.set(hash, Buffer.from(buf))
      return hash
    },
    readManifest: async (id) => {
      if (!manifests.has(id)) throw new Error(`manifest not found: ${id}`)
      return manifests.get(id)
    },
    writeManifest: async (manifest) => { manifests.set(manifest.id, manifest) },
    snapDir: path.join(storeDir, 'snapshots'),
  }
  engine.seedSnapshot = (id, files, reason = 'manual') => {
    const { files: fileMap, total } = registerFiles(files)
    manifests.set(id, {
      version: 2,
      id,
      at: 1700000000000,
      reason,
      host: 'test-host',
      home,
      chunkSize: CHUNK_SIZE,
      files: fileMap,
      stats: { files: Object.keys(fileMap).length, changed: Object.keys(fileMap).length, stored: 0, bytes: total, durationMs: 0 },
    })
    return id
  }
  engine.latestSnapshotId = () => current
  engine.verifySnapshot = async (id) => {
    calls.push({ op: 'verify', id })
    const manifest = manifests.get(id)
    if (!manifest) throw new Error('no such snapshot')
    return { id, ok: true, files: Object.keys(manifest.files).length, missingCount: 0, missing: [], checkedAt: Date.now() }
  }
  engine.pinSnapshot = (id) => { calls.push({ op: 'pin', id }); engine.pinned.add(id) }
  engine.unpinSnapshot = (id) => { calls.push({ op: 'unpin', id }); engine.pinned.delete(id) }
  engine.importSnapshot = async (manifest) => {
    calls.push({ op: 'import', id: manifest.id })
    manifests.set(manifest.id, manifest)
  }
  engine.restore = async (id) => {
    calls.push({ op: 'restore', id })
    const manifest = manifests.get(id)
    if (!manifest) throw new Error(`restore: no manifest ${id}`)
    let restored = 0
    for (const [rel, entry] of Object.entries(manifest.files)) {
      const parts = []
      for (const hash of entry.c) parts.push(await engine.store.get(hash))
      const abs = path.join(home, ...rel.split('/'))
      await fsp.mkdir(path.dirname(abs), { recursive: true })
      await fsp.writeFile(abs, Buffer.concat(parts))
      restored += 1
    }
    return { ok: true, snapshot: id, restored, unchanged: 0, quarantined: 0, extraLeft: 0, failed: [], needRestart: true }
  }
  engine.state = () => ({ pinned: [...engine.pinned], busy: false, snapshots: [] })
  engine.start = async () => {}
  engine.stop = async () => {}
  engine.manifests = manifests
  engine.blobs = blobs

  if (withSnapshot) {
    for (const [id, files] of Object.entries(snapshots)) engine.seedSnapshot(id, files)
    engine.current = current || Object.keys(snapshots)[0] || null
    engine.latestSnapshotId = () => engine.current
  } else {
    engine.latestSnapshotId = () => null
  }
  return engine
}

/* ------------------------------------------------------------- 环境装配 */

const SAMPLE_FILES = {
  'workspace.json': '{"v":1,"hello":"world"}',
  'sessions/--D-x--/session-1/session.v4.jsonl.zstd': 'x'.repeat(5000),
}

const SNAPSHOT_ID = '20261028-120000-manual'

async function setup({
  peerOnline = true,
  withSync = true,
  devices = null,
  snapshots = { [SNAPSHOT_ID]: SAMPLE_FILES },
  current = SNAPSHOT_ID,
  serviceOptions = {},
} = {}) {
  const root = await tempDir('dbk-offsite-test-')
  const storeDir = path.join(root, 'store', 'TEST-HOST')
  const home = path.join(root, 'home')
  await fsp.mkdir(storeDir, { recursive: true })
  await fsp.mkdir(home, { recursive: true })
  const engine = createFakeEngine({ home, storeDir, snapshots, current })
  // devices = 多子机模式；否则沿用单子机 fake（既有用例不变）
  const group = devices ? createFakeSyncGroup(devices) : null
  const peer = group ? null : createFakePeer({ online: peerOnline })
  const dpapi = createFakeDpapi()
  const archive = createFakeArchive()
  const service = createOffsiteService({
    engine,
    getSync: withSync ? () => (group ? group.api : peer.api) : () => undefined,
    archive,
    dpapi,
    logger: () => {},
    ...serviceOptions,
  })
  await service.init()
  return { root, storeDir, home, engine, peer, group, dpapi, archive, service }
}

async function bootstrapped(options = {}) {
  const env = await setup(options)
  await env.service.initRepo('Offsite-Pass1')
  return env
}

/* --------------------------------------------------------------- 密码规则 */

test('offsite: 密码规则 ≥9 且必须字母+数字，超长密码可用', () => {
  for (const bad of ['', 'abc', 'abcdefgh', '123456789', 'a1234567', '!!!!!!!!!', 'abcd123']) {
    const result = validatePassword(bad)
    assert.equal(result.ok, false, `应拒绝：${bad}`)
    assert.equal(result.code, 'weak-password')
  }
  assert.equal(validatePassword('abcdefg1x').ok, true)
  assert.equal(validatePassword('1abcdefgh').ok, true)
  assert.equal(validatePassword('Pässw0rd-中文').ok, true)
  assert.equal(validatePassword('a1' + 'x'.repeat(300)).ok, true, '长度不设上限')
})

/* --------------------------------------------------------- 初始化 / 解锁 */

test('offsite: init/unlock 错密码、DPAPI 缓存解锁、清除缓存', async () => {
  const env = await setup()
  try {
    const initial = await env.service.state()
    assert.equal(initial.initialized, false)
    assert.equal(initial.locked, true)

    // 未初始化且子机上没有 repo.json → 明确报 not-initialized（不是崩溃）
    await assert.rejects(() => env.service.unlock('Offsite-Pass1'), (error) => error.code === 'not-initialized')
    await assert.rejects(() => env.service.initRepo('short1'), (error) => error.code === 'weak-password')

    const init = await env.service.initRepo('Offsite-Pass1')
    assert.equal(init.ok, true)
    const unlocked = await env.service.state()
    assert.equal(unlocked.initialized, true)
    assert.equal(unlocked.locked, false)
    assert.equal(unlocked.keySource, 'password')
    assert.equal(unlocked.hasCachedKey, true, '解锁后默认写 DPAPI 缓存')

    await env.service.lock()
    const locked = await env.service.state()
    assert.equal(locked.locked, true)
    assert.equal(locked.hasCachedKey, true, '锁定只清内存，不删缓存')

    await assert.rejects(() => env.service.unlock('WrongPass123'), (error) => error.code === 'bad-password')
    await assert.rejects(() => env.service.unlock('onlyletters'), (error) => error.code === 'weak-password')

    const viaPassword = await env.service.unlock('Offsite-Pass1')
    assert.equal(viaPassword.keySource, 'password')
    await env.service.lock()
    const viaCache = await env.service.unlockFromCache()
    assert.equal(viaCache.keySource, 'cache')

    const cleared = await env.service.clearKey()
    assert.equal(cleared.hasCachedKey, false)
    assert.equal(env.service.locked, true)
    await assert.rejects(() => env.service.unlockFromCache(), (error) => error.code === 'no-cached-key')
    await assert.rejects(() => fsp.access(path.join(env.storeDir, 'offsite', 'key.dpapi')), /ENOENT/)
  } finally {
    await removeTemp(env.root)
  }
})

test('offsite: state() 不泄露密码/主密钥/明文内容', async () => {
  const env = await bootstrapped()
  try {
    await env.service.exportNow({})
    const state = await env.service.state({ probe: true })
    const json = JSON.stringify(state)
    assert.ok(!json.includes('Offsite-Pass1'), 'state 不得包含密码')
    assert.ok(!json.includes('masterKey'), 'state 不得包含主密钥')
    const key = await env.archive.openRepoKey({ dir: env.service.paths.repo, password: 'Offsite-Pass1' })
    assert.ok(!json.includes(Buffer.from(key.masterKey).toString('base64')), 'state 不得包含主密钥 base64')
    // 明文文件名/内容绝不能出现在面板响应里（清单是加密的）
    assert.ok(!json.includes('workspace.json'), 'state 不得包含明文文件名')
    assert.ok(!json.includes('hello'), 'state 不得包含明文内容')
    assert.equal(state.archives.length, 1)
    assert.equal(state.archives[0].source, 'local')
  } finally {
    await removeTemp(env.root)
  }
})

/* --------------------------------------------------- 导出 / 同步编排顺序 */

test('offsite: 导出编排（verify → pin → 逐块加密 → 清单 → ledger → 同步 → unpin）', async () => {
  const env = await bootstrapped()
  try {
    const result = await env.service.exportNow({})
    assert.equal(result.ok, true)
    assert.equal(result.snapshotId, SNAPSHOT_ID)
    assert.ok(result.newChunks > 0)
    assert.equal(result.sync.ok, true, '子机在线时导出后自动同步')
    assert.ok(result.sync.uploaded >= 1, '首次同步至少上传一个 pack')

    const ops = env.engine.calls.map((call) => call.op)
    assert.ok(ops.indexOf('verify') >= 0)
    assert.ok(ops.indexOf('verify') < ops.indexOf('pin'), '必须先体检再 pin')
    assert.ok(ops.indexOf('pin') < ops.indexOf('unpin'), '导出结束后必须 unpin')

    // ledger 原子写 + 字段完整
    const ledger = JSON.parse(await fsp.readFile(path.join(env.storeDir, 'offsite', 'ledger.json'), 'utf8'))
    assert.equal(ledger.version, 1)
    assert.equal(ledger.seq, 1)
    assert.equal(ledger.prevManifest, result.manifestName)
    assert.equal(ledger.archives.length, 1)
    assert.equal(ledger.archives[0].snapshotId, SNAPSHOT_ID)
    assert.equal(ledger.archives[0].manifestSha256, result.manifestSha256)
    assert.ok(Number(ledger.lastExportAt) > 0)
    assert.ok(Number(ledger.lastSyncAt) > 0)

    // 仓库里应该有块 + 清单；子机上有 pack + repo.json
    const repoFiles = await fsp.readdir(path.join(env.storeDir, 'offsite', 'repo', 'manifests'))
    assert.equal(repoFiles.length, 1)
    assert.ok([...env.peer.files.keys()].some((name) => name.startsWith('packs/')), '子机应收到 pack')
    assert.ok(env.peer.files.has('repo.json'), '子机应收到 repo.json（换机恢复用）')

    // 幂等：同快照再导出 → 新增块 0，清单名不变，同步 upToDate
    const second = await env.service.exportNow({})
    assert.equal(second.newChunks, 0, '同快照重复导出不得新增块')
    assert.equal(second.manifestName, result.manifestName)
    assert.equal(second.sync.upToDate, true, '子机已最新时同步跳过')
    const ledger2 = JSON.parse(await fsp.readFile(path.join(env.storeDir, 'offsite', 'ledger.json'), 'utf8'))
    assert.equal(ledger2.seq, 2)
    assert.equal(ledger2.archives.length, 1, '同一快照只保留一条 ledger 记录')
  } finally {
    await removeTemp(env.root)
  }
})

test('offsite: 导出前体检失败 → verify-failed，不写 ledger、不 pin', async () => {
  const env = await bootstrapped()
  try {
    const before = await fsp.readFile(path.join(env.storeDir, 'offsite', 'ledger.json'), 'utf8')
    env.engine.verifySnapshot = async (id) => ({ id, ok: false, files: 3, missingCount: 2, missing: ['a', 'b'], checkedAt: Date.now() })
    await assert.rejects(() => env.service.exportNow({}), (error) => error.code === 'verify-failed')
    const after = await fsp.readFile(path.join(env.storeDir, 'offsite', 'ledger.json'), 'utf8')
    assert.equal(after, before, '体检失败不得改 ledger')
    assert.ok(!env.engine.calls.some((call) => call.op === 'pin'), '体检失败不得 pin')
  } finally {
    await removeTemp(env.root)
  }
})

test('offsite: 并发拒绝（同一时刻只允许一个长操作）', async () => {
  const env = await bootstrapped()
  try {
    const first = env.service.exportNow({})
    const second = env.service.exportNow({})
    await assert.rejects(() => second, (error) => error.code === 'busy')
    await first
    const third = await env.service.exportNow({})
    assert.equal(third.ok, true, '前一个结束后可以继续')
  } finally {
    await removeTemp(env.root)
  }
})

/* ------------------------------------------------------- 子机离线 / 降级 */

test('offsite: 子机离线时导出照常完成，同步降级为 peer-offline', async () => {
  const env = await bootstrapped({ peerOnline: false })
  try {
    const result = await env.service.exportNow({})
    assert.equal(result.ok, true)
    assert.equal(result.newChunks > 0, true)
    assert.equal(result.sync.ok, false)
    assert.equal(result.sync.code, 'peer-offline')

    const state = await env.service.state({ probe: true })
    assert.equal(state.peer.online, false)
    assert.equal(state.peer.reason, 'peer-offline')
    assert.equal(state.remote.ok, false)
    assert.equal(state.remote.error.code, 'peer-offline')

    await assert.rejects(() => env.service.syncToPeer(), (error) => error.code === 'peer-offline')
  } finally {
    await removeTemp(env.root)
  }
})

test('offsite: 没有 dsh-sync 时整块降级为 sync-missing（导出仍可用）', async () => {
  const env = await bootstrapped({ withSync: false })
  try {
    const state = await env.service.state()
    assert.equal(state.peer.sync, false)
    assert.equal(state.peer.reason, 'sync-missing')
    assert.deepEqual(state.peers, [], '没有 dshSync 时 peers 必须是空数组')
    assert.equal(state.config.peerDeviceId, '')
    const result = await env.service.exportNow({})
    assert.equal(result.ok, true)
    assert.equal(result.sync.code, 'sync-missing')
    await assert.rejects(() => env.service.syncToPeer(), (error) => error.code === 'sync-missing')
  } finally {
    await removeTemp(env.root)
  }
})

/* ------------------------------------------------- 多子机：列表 / 选择 / 回退 */

const MULTI_DEVICES = [
  { deviceId: 'dev-b-offline', name: 'Beta', online: false, trusted: true },
  { deviceId: 'dev-z-online', name: 'Zeta', online: true, trusted: true },
  { deviceId: 'dev-a-online', name: 'Alpha', online: true, trusted: true },
]

test('offsite: 多子机 peers 列表（在线优先/名称排序/selected），未配置回退第一个在线已配对设备', async () => {
  const env = await setup({ devices: MULTI_DEVICES })
  try {
    const state = await env.service.state()
    assert.deepEqual(state.peers.map((peer) => peer.deviceId), ['dev-a-online', 'dev-z-online', 'dev-b-offline'], '在线优先、按名称排序')
    assert.deepEqual(state.peers.map((peer) => peer.selected), [true, false, false])
    assert.deepEqual(Object.keys(state.peers[0]).sort(), ['deviceId', 'lastSyncAt', 'name', 'online', 'selected', 'trusted'])
    assert.equal(state.peer.source, 'fallback')
    assert.equal(state.peer.configValid, null, '未配置时不存在「配置是否有效」')
    assert.equal(state.peer.id, 'dev-a-online')
    assert.equal(state.peer.online, true)
    assert.equal(state.config.peerDeviceId, '')

    // GET 用的同步摘要也要带 peers（面板不必先等 offsite-state）
    const summary = env.service.summary()
    assert.equal(summary.peers.length, 3)
    assert.equal(summary.peers.filter((peer) => peer.selected).length, 1)
    assert.equal(summary.peer.id, 'dev-a-online')
    assert.equal(summary.config.peerDeviceId, '')

    // 导出/同步只走选中的设备
    await env.service.initRepo('Offsite-Pass1')
    const exported = await env.service.exportNow({})
    assert.equal(exported.ok, true)
    assert.equal(exported.sync.ok, true)
    assert.ok(env.group.filesOf('dev-a-online').has('repo.json'))
    assert.equal(env.group.filesOf('dev-z-online').size, 0, '不得顺带发到其它设备')
    assert.equal(env.group.filesOf('dev-b-offline').size, 0)
  } finally {
    await removeTemp(env.root)
  }
})

test('offsite: 选中设备离线 → 明确报错且不静默换设备；配置失效 → 回退并标记 configValid=false', async () => {
  const env = await setup({
    devices: [
      { deviceId: 'dev-online', name: 'Online Box', online: true, trusted: true },
      { deviceId: 'dev-offline', name: 'Offline Box', online: false, trusted: true },
    ],
  })
  try {
    await env.service.initRepo('Offsite-Pass1')
    const applied = await env.service.updateConfig({ peerDeviceId: 'dev-offline' })
    assert.equal(applied.peerDeviceId, 'dev-offline')

    const state = await env.service.state()
    assert.equal(state.config.peerDeviceId, 'dev-offline')
    assert.equal(state.peer.source, 'config')
    assert.equal(state.peer.configValid, true)
    assert.equal(state.peer.requested, 'dev-offline')
    assert.equal(state.peer.id, 'dev-offline')
    assert.equal(state.peer.online, false)
    assert.equal(state.peer.reason, 'peer-offline')
    assert.equal(state.peers.find((peer) => peer.deviceId === 'dev-offline').selected, true)
    assert.equal(state.peers.find((peer) => peer.deviceId === 'dev-online').selected, false)

    // 同步/导出都必须明确报错，而不是改投在线设备
    await assert.rejects(
      () => env.service.syncToPeer(),
      (error) => error.code === 'peer-offline' && /Offline Box/.test(error.message),
    )
    const exported = await env.service.exportNow({})
    assert.equal(exported.ok, true, '导出本地仍成功')
    assert.equal(exported.sync.ok, false)
    assert.equal(exported.sync.code, 'peer-offline')
    assert.equal(env.group.filesOf('dev-online').size, 0, '不得静默改投在线设备')
    assert.equal(env.group.filesOf('dev-offline').size, 0)

    // 设备被解除配对（配置失效）→ 回退第一个在线已配对设备，但如实标记 configValid=false 且不改写配置
    env.group.removeDevice('dev-offline')
    env.service.peerSnapshot({ force: true })
    const after = await env.service.state()
    assert.equal(after.peer.configValid, false)
    assert.equal(after.peer.source, 'fallback')
    assert.equal(after.peer.id, 'dev-online')
    assert.equal(after.peer.reason, 'ok')
    assert.equal(after.config.peerDeviceId, 'dev-offline', '原配置保留，不悄悄改写')
    assert.equal(after.peers.find((peer) => peer.deviceId === 'dev-online').selected, true)

    const synced = await env.service.syncToPeer()
    assert.equal(synced.ok, true)
    assert.ok(env.group.filesOf('dev-online').has('repo.json'), '失效后回退设备可用')
  } finally {
    await removeTemp(env.root)
  }
})

test('offsite: config.peerDeviceId 校验（unknown-peer / 清空 / 非法字符 / 无 dshSync 时先接受）', async () => {
  const env = await setup({ devices: [{ deviceId: 'dev-a', name: 'Alpha', online: true, trusted: true }] })
  try {
    await assert.rejects(
      () => env.service.updateConfig({ peerDeviceId: 'nope-dev' }),
      (error) => error.code === 'unknown-peer',
    )
    assert.equal((await env.service.state()).config.peerDeviceId, '', '校验失败不得落盘')

    const applied = await env.service.updateConfig({ peerDeviceId: 'dev-a' })
    assert.equal(applied.peerDeviceId, 'dev-a')
    assert.equal((await env.service.state()).peer.source, 'config')
    assert.equal((await env.service.state()).peer.id, 'dev-a')

    const cleared = await env.service.updateConfig({ peerDeviceId: '' })
    assert.equal(cleared.peerDeviceId, '')
    assert.equal((await env.service.state()).peer.source, 'fallback')

    // 非法字符/超长被 normalize 忽略 → nothing-applied（不会写坏配置）
    await assert.rejects(() => env.service.updateConfig({ peerDeviceId: 'bad/id with space' }), (error) => error.code === 'nothing-applied')
    await assert.rejects(() => env.service.updateConfig({ peerDeviceId: 'a'.repeat(200) }), (error) => error.code === 'nothing-applied')

    // 同步不可用：无法对照已配对列表，先接受，状态里 peers=[] 且 configValid=null
    const noSync = await setup({ withSync: false })
    try {
      const accepted = await noSync.service.updateConfig({ peerDeviceId: 'dev-x' })
      assert.equal(accepted.peerDeviceId, 'dev-x')
      const state = await noSync.service.state()
      assert.equal(state.peer.reason, 'sync-missing')
      assert.equal(state.peer.configValid, null)
      assert.deepEqual(state.peers, [])
    } finally {
      await removeTemp(noSync.root)
    }
  } finally {
    await removeTemp(env.root)
  }
})

test('offsite: 多子机下恢复/演练/裁剪都走同一个选中设备（不串设备）', async () => {
  const env = await setup({ devices: MULTI_DEVICES })
  try {
    await env.service.initRepo('Offsite-Pass1')
    await env.service.updateConfig({ peerDeviceId: 'dev-z-online' })
    const exported = await env.service.exportNow({})
    assert.equal(exported.sync.ok, true)
    assert.ok(env.group.filesOf('dev-z-online').has('repo.json'))
    assert.equal(env.group.filesOf('dev-a-online').size, 0)

    // 裁剪也只针对选中设备：把选中设备换回 dev-a（离线设备 b 不参与），确认 prune 用同一逻辑
    const pruned = await env.service.pruneRemote()
    assert.equal(pruned.ok, true)
    const callsB = env.group.callsOf('dev-b-offline')
    assert.equal(callsB.length, 0, '离线设备不应收到任何 RPC')
    // 切到 fallback（清空选择）后再裁剪，应只碰 dev-a-online
    await env.service.updateConfig({ peerDeviceId: '' })
    const before = env.group.callsOf('dev-a-online').length
    await env.service.pruneRemote()
    assert.ok(env.group.callsOf('dev-a-online').length > before, 'prune 走当前选中的 dev-a-online')
  } finally {
    await removeTemp(env.root)
  }
})

/* ------------------------------------------------------------- 恢复编排 */

test('offsite: 换机恢复（子机引导 repo.json → 取包 → importSnapshot → restore）', async () => {
  const source = await bootstrapped()
  let restoreRoot = null
  try {
    await source.service.exportNow({})
    assert.ok(source.peer.files.has('repo.json'))

    // 新机器：空 home / 空仓库 / 无快照，只有同一台子机
    restoreRoot = await tempDir('dbk-offsite-restore-')
    const storeDir = path.join(restoreRoot, 'store', 'NEW-HOST')
    const home = path.join(restoreRoot, 'home')
    await fsp.mkdir(storeDir, { recursive: true })
    await fsp.mkdir(home, { recursive: true })
    const engine = createFakeEngine({ home, storeDir, withSnapshot: false })
    const dpapi = createFakeDpapi()
    const service = createOffsiteService({
      engine,
      getSync: () => source.peer.api,
      archive: createFakeArchive(),
      dpapi,
      logger: () => {},
    })
    await service.init()
    const before = await service.state({ probe: true })
    assert.equal(before.initialized, false)
    assert.equal(before.bootstrapAvailable, true, '子机上有 repo.json 时应提示可引导恢复')

    const unlocked = await service.unlock('Offsite-Pass1')
    assert.equal(unlocked.ok, true)
    const afterUnlock = await service.state()
    assert.equal(afterUnlock.initialized, true, '解锁时自动从子机取回 repo.json')
    assert.equal(afterUnlock.locked, false)

    const restored = await service.restore({ snapshotId: SNAPSHOT_ID })
    assert.equal(restored.ok, true)
    assert.equal(restored.needRestart, true)
    assert.ok(restored.fetched > 0, '应从子机取回清单/块')
    const ops = engine.calls.map((call) => call.op)
    assert.ok(ops.includes('import'), '引擎缺少本地清单时应 importSnapshot')
    assert.ok(ops.includes('restore'), '最后必须调用 engine.restore')
    assert.ok(ops.indexOf('import') < ops.indexOf('restore'), '先注册清单再恢复')
    // 恢复出的明文块都在引擎 BlobStore 里，且 home 里文件内容正确
    for (const content of Object.values(SAMPLE_FILES)) {
      const hash = sha256(Buffer.from(content.slice(0, CHUNK_SIZE)))
      assert.ok(await engine.store.has(hash), '明文块必须写进引擎 BlobStore')
    }
    const sessionFile = await fsp.readFile(path.join(home, 'workspace.json'), 'utf8')
    assert.equal(sessionFile, SAMPLE_FILES['workspace.json'])

    // 恢复后子机内容不得被删（失败/成功都不动对端）
    const packsBefore = [...source.peer.files.keys()].filter((name) => name.startsWith('packs/')).length
    assert.ok(packsBefore >= 1)
  } finally {
    await removeTemp(source.root)
    if (restoreRoot) await removeTemp(restoreRoot)
  }
})

test('offsite: 恢复时子机缺块 → missing-chunks（拒绝部分恢复）', async () => {
  const env = await bootstrapped()
  try {
    await env.service.exportNow({})
    // 人为删掉子机上的所有 pack → 取块失败
    for (const name of [...env.peer.files.keys()]) {
      if (name.startsWith('packs/')) env.peer.files.delete(name)
    }
    // 本地仓库也清空（模拟换机）→ 只能依赖子机
    await fsp.rm(path.join(env.storeDir, 'offsite', 'repo', 'chunks'), { recursive: true, force: true })
    await fsp.rm(path.join(env.storeDir, 'offsite', 'packs.json'), { force: true })
    const relaunch = createOffsiteService({
      engine: env.engine,
      getSync: () => env.peer.api,
      archive: env.archive,
      dpapi: env.dpapi,
      logger: () => {},
    })
    await relaunch.init()
    await relaunch.unlock('Offsite-Pass1')
    await assert.rejects(() => relaunch.fetchMissingFromPeer(SNAPSHOT_ID), (error) => error.code === 'missing-chunks')
  } finally {
    await removeTemp(env.root)
  }
})

/* ------------------------------------------------------------- 演练 */

test('offsite: 演练恢复到临时目录并逐文件 sha256 校验，不动真实 home', async () => {
  const env = await setup({
    serviceOptions: {
      createTempEngine: async ({ home, root }) => createFakeEngine({ home, storeDir: root, withSnapshot: false }),
    },
  })
  try {
    await env.service.initRepo('Offsite-Pass1')
    // 演练针对已导出的异地档案：先导出
    await env.service.exportNow({})
    const drill = await env.service.drill({})
    assert.equal(drill.ok, true)
    assert.equal(drill.files, Object.keys(SAMPLE_FILES).length)
    assert.equal(drill.mismatched, 0)
    assert.ok(drill.bytes > 0)
    const state = await env.service.state()
    assert.ok(Number(state.lastDrillAt) > 0)
    assert.equal(state.lastDrill.ok, true)
    // 真实 home 不得被写入
    const homeFiles = await fsp.readdir(env.home)
    assert.deepEqual(homeFiles, [], '演练不得动真实 home')
    // 没有档案时明确报 no-archive
    const fresh = await setup({ serviceOptions: { createTempEngine: () => { throw new Error('should not run') } } })
    try {
      await fresh.service.initRepo('Offsite-Pass1')
      await assert.rejects(() => fresh.service.drill({}), (error) => error.code === 'no-archive')
    } finally {
      await removeTemp(fresh.root)
    }
  } finally {
    await removeTemp(env.root)
  }
})

/* ------------------------------------------------ ledger / 裁剪 / 配置 */

test('offsite: ledger 原子写（坏文件也能恢复，且不残留 tmp）', async () => {
  const env = await bootstrapped()
  try {
    await env.service.exportNow({})
    const dir = path.join(env.storeDir, 'offsite')
    const entries = await fsp.readdir(dir)
    assert.ok(!entries.some((name) => name.endsWith('.tmp')), '原子写不得残留 .tmp')
    const ledger = JSON.parse(await fsp.readFile(path.join(dir, 'ledger.json'), 'utf8'))
    assert.equal(ledger.version, 1)

    // 坏 ledger → 归一化后仍能启动（不抛）
    await fsp.writeFile(path.join(dir, 'ledger.json'), '{ this is not json')
    const normalized = normalizeLedger(null)
    assert.equal(normalized.version, 1)
    assert.deepEqual(normalized.archives, [])
    const relaunch = createOffsiteService({
      engine: env.engine,
      getSync: () => env.peer.api,
      archive: env.archive,
      dpapi: env.dpapi,
      logger: () => {},
    })
    await relaunch.init()
    const state = await relaunch.state()
    assert.equal(state.ok, true)
    assert.equal(state.archives.length, 0)
  } finally {
    await removeTemp(env.root)
  }
})

test('offsite: 保留策略 最近 N 份每日 + M 份每周 + pinned 永不删', () => {
  const now = new Date('2026-10-28T12:00:00+08:00').getTime()
  const archives = []
  for (let day = 0; day < 20; day += 1) {
    const at = now - day * 86400_000
    archives.push({ snapshotId: `snap-${day}`, manifestName: `manifests/${String(day).padStart(2, '0')}.mbin`, at, seq: 20 - day })
  }
  const plan = planRetention(archives, { retainDaily: 7, retainWeekly: 4, pinned: [] })
  // 20 天里：最近 7 天各留 1 份；剩下 13 天跨 3 个 ISO 周 → 再留 3 份
  assert.equal(plan.keep.length, 10, '7 份每日 + 3 份每周（20 天只跨 3 周）')
  assert.equal(plan.drop.length, 10)
  assert.ok(plan.keep.some((item) => item.snapshotId === 'snap-0'), '最新一份必留')

  const pinned = planRetention(archives, { retainDaily: 1, retainWeekly: 0, pinned: ['snap-19'] })
  assert.ok(pinned.keep.some((item) => item.snapshotId === 'snap-19'), 'pinned 快照永不淘汰')
  assert.equal(pinned.keep.length, 2)

  const zeroWeekly = planRetention(archives, { retainDaily: 3, retainWeekly: 0 })
  assert.equal(zeroWeekly.keep.length, 3)
})

test('offsite: pruneRemote 删除未引用的清单/pack，保留 pinned', async () => {
  const env = await bootstrapped()
  try {
    // 两个快照：A 旧（内容不同），B 新
    const A = '20261001-040000-auto'
    const B = '20261028-040000-auto'
    env.engine.seedSnapshot(A, { 'a.txt': 'aaa', 'shared.txt': 'shared-content' })
    env.engine.seedSnapshot(B, { 'b.txt': 'bbb', 'shared.txt': 'shared-content' })
    env.engine.current = A
    const exportedA = await env.service.exportNow({})
    env.engine.current = B
    const exportedB = await env.service.exportNow({})
    assert.ok(exportedA.newChunks > 0)
    assert.ok(exportedB.newChunks > 0)
    const remotePacks = () => [...env.peer.files.keys()].filter((name) => name.startsWith('packs/'))
    assert.ok(remotePacks().length >= 1)

    // 保留 1 份每日 + 0 份每周：A 应被淘汰；把 A pin 起来后必须保留
    await env.service.updateConfig({ retainDaily: 1, retainWeekly: 0 })
    env.engine.pinned.add(A)
    const pruned = await env.service.pruneRemote()
    assert.equal(pruned.ok, true)
    assert.equal(pruned.dropped, 0, 'A 被 pin，不能被淘汰')
    assert.ok(env.engine.pinned.has(A))

    env.engine.pinned.delete(A)
    const pruned2 = await env.service.pruneRemote()
    assert.equal(pruned2.dropped, 1, '取消 pin 后 A 被淘汰')
    assert.ok(pruned2.localDeleted >= 1, '本地仓库里 A 的清单/独占块应被回收')
    const ledger = JSON.parse(await fsp.readFile(path.join(env.storeDir, 'offsite', 'ledger.json'), 'utf8'))
    assert.equal(ledger.archives.length, 1)
    assert.equal(ledger.archives[0].snapshotId, B)
    // a.txt 的块不再被任何保留清单引用 → 本地仓库应删掉；shared.txt 的块仍被 B 引用 → 必须保留
    const key = await env.archive.openRepoKey({ dir: env.service.paths.repo, password: 'Offsite-Pass1' })
    const aChunk = await env.archive.chunkName({ key, plainHash: sha256(Buffer.from('aaa')) })
    const sharedChunk = await env.archive.chunkName({ key, plainHash: sha256(Buffer.from('shared-content')) })
    assert.equal(await fsp.access(path.join(env.service.paths.repo, ...aChunk.split('/'))).then(() => true, () => false), false, 'a.txt 独占块应被删')
    assert.equal(await fsp.access(path.join(env.service.paths.repo, ...sharedChunk.split('/'))).then(() => true, () => false), true, '共享块必须保留')
  } finally {
    await removeTemp(env.root)
  }
})

test('offsite: 配置默认值与校验（enabled/retainDaily/retainWeekly/quota/schedule/dir）', async () => {
  const env = await setup()
  try {
    const state = await env.service.state()
    assert.equal(state.config.retainDaily, OFFSITE_DEFAULTS.retainDaily)
    assert.equal(state.config.retainWeekly, OFFSITE_DEFAULTS.retainWeekly)
    assert.equal(state.config.quotaBytes, OFFSITE_DEFAULTS.quotaBytes)
    assert.equal(state.config.schedule, '04:00')
    assert.equal(state.config.enabled, true)
    assert.equal(state.config.weeklyDrill, true)

    const normalized = normalizeOffsiteConfig({
      retainDaily: 999,
      retainWeekly: -3,
      quotaBytes: 1,
      schedule: '25:99',
      enabled: 'yes',
      peerDeviceId: 'abc123',
      unknownKey: 'x',
    })
    assert.equal(normalized.config.retainDaily, 365)
    assert.equal(normalized.config.retainWeekly, 0)
    assert.equal(normalized.config.quotaBytes, 1024 * 1024)
    assert.equal(normalized.config.schedule, '04:00', '非法时间忽略')
    assert.equal(normalized.config.enabled, true, '非布尔值忽略')
    assert.equal(normalized.config.peerDeviceId, 'abc123')
    assert.ok(!('unknownKey' in normalized.config))

    const applied = await env.service.updateConfig({ retainDaily: 14, weeklyDrill: false, schedule: '03:30' })
    assert.equal(applied.retainDaily, 14)
    const after = await env.service.state()
    assert.equal(after.config.retainDaily, 14)
    assert.equal(after.config.weeklyDrill, false)
    assert.equal(after.schedule.at, '03:30')

    await assert.rejects(() => env.service.updateConfig({}), (error) => error.code === 'nothing-applied')
    await assert.rejects(
      () => env.service.updateConfig({ dir: path.join(env.home, 'offsite-inside') }),
      (error) => error.code === 'bad-config',
    )
  } finally {
    await removeTemp(env.root)
  }
})

/* ------------------------------------------------------------- 通道细节 */

test('offsite: pack 目标 4MiB / 上传切片 512KiB / repo name 白名单', async () => {
  assert.equal(PACK_TARGET_BYTES, 4 * 1024 * 1024)
  assert.equal(UPLOAD_SLICE_BYTES, 512 * 1024)
  assert.equal(isRepoName('chunks/ab/cd/' + 'f'.repeat(64) + '.cbin'), true)
  assert.equal(isRepoName('manifests/' + 'f'.repeat(64) + '.mbin'), true)
  assert.equal(isRepoName('packs/' + 'f'.repeat(64) + '.pbin'), true)
  assert.equal(isRepoName('repo.json'), true)
  assert.equal(isRepoName('chunks/../../etc/passwd'), false)
  assert.equal(isRepoName('chunks/ab/cd/../' + 'f'.repeat(64) + '.cbin'), false)
  assert.throws(() => repoPath('/tmp/repo', '../../evil'), (error) => error.code === 'bad-name')

  assert.deepEqual(parseSchedule('04:00'), { hour: 4, minute: 0, text: '04:00' })
  assert.equal(parseSchedule('24:00'), null)
  assert.equal(parseSchedule(''), null)
  const due = scheduleDueAt(new Date('2026-10-28T05:00:00+08:00').getTime(), { hour: 4, minute: 0 })
  assert.equal(new Date(due).getHours(), 4)
})

test('offsite: archive port 缺失时给出 archive-core-missing（core 未就位不影响插件）', async () => {
  const error = await createArchivePort({ importModule: async () => ({}) }).then(
    () => null,
    (reason) => reason,
  )
  assert.ok(error)
  assert.equal(error.code, 'archive-core-missing')
  assert.match(error.message, /缺少/)

  const fake = createFakeArchive()
  const port = await createArchivePort({
    importModule: async (spec) => (spec.includes('/archive/port.js') ? fake : {}),
  })
  for (const name of ARCHIVE_PORT_METHODS) assert.equal(typeof port[name], 'function', `缺失 ${name}`)
})

test('offsite: 真实 port.buildPack 可以混装 块 + 清单 + recovery-kit（集成回归）', async (t) => {
  let port
  try {
    port = await import('../src/archive/port.js')
  } catch {
    t.skip('src/archive/port.js 尚未就位')
    return
  }
  const root = await tempDir('dbk-offsite-packmix-')
  try {
    const repoDir = path.join(root, 'repo')
    await fsp.mkdir(repoDir, { recursive: true })
    const key = await port.initRepo({ dir: repoDir, password: 'Offsite-Pack-1' })
    const chunk = await port.encodeChunk({ key, plainBuf: Buffer.from('hello pack') })
    const manifest = await port.encodeManifest({
      key,
      manifest: { version: 1, snapshot: { id: 'snap-pack-1', at: Date.now(), files: {} }, exportedAt: Date.now(), prevManifest: null, seq: 1 },
    })
    const kitBuf = Buffer.from('offline recovery kit (no keys)')
    const entries = [
      { name: chunk.name, buf: chunk.buf },
      { name: manifest.name, buf: manifest.buf },
      { name: 'recovery-kit/README.txt', buf: kitBuf },
      { name: 'repo.json', buf: Buffer.from('{"format":"dsh-dr-repo"}') },
    ]
    const pack = await port.buildPack({ key, entries })
    assert.ok(pack && pack.name && pack.buf, 'buildPack 必须能装 recovery-kit（core 放宽白名单后的回归点）')
    const back = await port.unpackPack({ key, name: pack.name, buf: pack.buf })
    assert.deepEqual(back.map((entry) => entry.name).sort(), entries.map((entry) => entry.name).sort())
    const byName = new Map(back.map((entry) => [entry.name, entry.buf]))
    for (const entry of entries) {
      assert.deepEqual(Buffer.from(byName.get(entry.name)), entry.buf, `roundtrip 内容不一致：${entry.name}`)
    }
    // unpackPack 契约：块带 plainHash；kit/manifest/repo.json 的 plainHash 为 null
    const byRecord = new Map(back.map((entry) => [entry.name, entry]))
    assert.equal(byRecord.get(chunk.name).plainHash, chunk.plainHash)
    assert.equal(byRecord.get('recovery-kit/README.txt').plainHash, null)
    assert.equal(byRecord.get(manifest.name).plainHash, null)
    assert.equal(byRecord.get('repo.json').plainHash, null)
    // 白名单外的名字仍然拒绝
    await assert.rejects(
      () => port.buildPack({ key, entries: [{ name: 'evil/x.bin', buf: Buffer.from('x') }] }),
      (error) => error.code === 'bad-name',
    )
  } finally {
    await removeTemp(root)
  }
})

test('offsite: 真实 port + 假 dshSync：导出→同步（pack 含 kit/块/清单）→换机恢复', async (t) => {
  let port
  try {
    port = await import('../src/archive/port.js')
  } catch {
    t.skip('src/archive/port.js 尚未就位')
    return
  }
  const { BackupEngine } = await import('../src/engine.js')
  const sourceRoot = await tempDir('dbk-offsite-syncsrc-')
  let targetRoot = null
  const peer = createFakePeer({ online: true })
  const dpapi = createFakeDpapi()
  let sourceEngine = null
  let sourceService = null
  let targetEngine = null
  try {
    const home = path.join(sourceRoot, 'home')
    const storeRoot = path.join(sourceRoot, 'store')
    await fsp.mkdir(home, { recursive: true })
    await fsp.writeFile(path.join(home, 'a.txt'), 'hello offsite sync')
    await fsp.mkdir(path.join(home, 'sessions', 's1'), { recursive: true })
    await fsp.writeFile(path.join(home, 'sessions', 's1', 'log'), 'x'.repeat(3000))
    sourceEngine = new BackupEngine({
      home,
      config: { root: storeRoot, watch: false, scanMs: 3_600_000, debounceMs: 0, minIntervalMs: 0 },
      snapshots: {},
      hostname: 'SYNC-HOST',
      log: () => {},
    })
    await sourceEngine.start()
    sourceService = createOffsiteService({ engine: sourceEngine, getSync: () => peer.api, archive: port, dpapi, logger: () => {} })
    await sourceService.init()
    await sourceService.initRepo('Offsite-Sync-1')

    const exported = await sourceService.exportNow({})
    assert.equal(exported.ok, true)
    assert.equal(exported.sync.ok, true, '导出后应自动同步')
    assert.ok(exported.sync.uploaded >= 1)
    const indexFile = path.join(sourceRoot, 'store', 'SYNC-HOST', 'offsite', 'packs.json')
    const index = JSON.parse(await fsp.readFile(indexFile, 'utf8'))
    const allNames = Object.values(index.packs).flatMap((value) => value.names || [])
    assert.ok(allNames.some((name) => name.startsWith('recovery-kit/')), 'pack 应包含 recovery-kit（真实 encryptPack 白名单）')
    assert.ok(allNames.some((name) => name.startsWith('chunks/')))
    assert.ok(allNames.some((name) => name.startsWith('manifests/')))
    assert.ok([...peer.files.keys()].some((name) => name.startsWith('packs/')))

    // 换机：只有子机上的密文 + 恢复密码
    targetRoot = await tempDir('dbk-offsite-syncrestore-')
    const home2 = path.join(targetRoot, 'home')
    const store2 = path.join(targetRoot, 'store')
    await fsp.mkdir(home2, { recursive: true })
    targetEngine = new BackupEngine({
      home: home2,
      config: { root: store2, watch: false, scanMs: 3_600_000, debounceMs: 0, minIntervalMs: 0 },
      snapshots: {},
      hostname: 'SYNC-HOST-2',
      log: () => {},
    })
    await targetEngine.start()
    const service2 = createOffsiteService({ engine: targetEngine, getSync: () => peer.api, archive: port, dpapi, logger: () => {} })
    await service2.init()
    const before = await service2.state({ probe: true })
    assert.equal(before.initialized, false)
    assert.equal(before.bootstrapAvailable, true, '子机上有 repo.json 应可引导')
    await service2.unlock('Offsite-Sync-1')
    const restored = await service2.restore({ snapshotId: exported.snapshotId })
    assert.equal(restored.ok, true)
    assert.ok(restored.fetched > 0, '应从子机取回清单/块')
    assert.equal(await fsp.readFile(path.join(home2, 'a.txt'), 'utf8'), 'hello offsite sync')
    assert.equal(await fsp.readFile(path.join(home2, 'sessions', 's1', 'log'), 'utf8'), 'x'.repeat(3000))
    await service2.dispose().catch(() => {})
  } finally {
    if (sourceService) await sourceService.dispose().catch(() => {})
    if (targetEngine) await targetEngine.stop().catch(() => {})
    if (sourceEngine) await sourceEngine.stop().catch(() => {})
    await removeTemp(sourceRoot)
    if (targetRoot) await removeTemp(targetRoot)
  }
})

test('offsite: kit 内容变化会重新同步，过期 kit pack 宽限期后回收（当前版本保留）', async () => {
  let clock = Date.now()
  const env = await setup({ serviceOptions: { now: () => clock } })
  try {
    await env.service.initRepo('Offsite-Pass1')
    const kitDir = path.join(env.storeDir, 'offsite', 'repo', 'recovery-kit')
    await fsp.mkdir(kitDir, { recursive: true })
    const extraFile = path.join(kitDir, 'extra.txt')
    await fsp.writeFile(extraFile, 'kit-v1')

    await env.service.syncToPeer()
    const readIndex = async () => JSON.parse(await fsp.readFile(path.join(env.storeDir, 'offsite', 'packs.json'), 'utf8'))
    const index1 = await readIndex()
    const oldPack = Object.entries(index1.packs).find(([, value]) => (value.names || []).includes('recovery-kit/extra.txt'))
    assert.ok(oldPack, '首次同步应把 kit 打进 pack')
    const [oldPackName] = oldPack

    clock += 60_000
    await fsp.writeFile(extraFile, 'kit-v2')
    const sync2 = await env.service.syncToPeer()
    assert.equal(sync2.ok, true)
    assert.ok(sync2.uploaded >= 1, 'kit 内容变化必须重新打包上传')

    // 宽限期内：旧 kit pack 不能删（给「新 kit 已同步」留时间，避免子机短暂没有可用 kit）
    const early = await env.service.pruneRemote()
    assert.equal(early.remoteDeleted, 0, '宽限期内不得回收旧 kit pack')
    assert.ok(env.peer.files.has(oldPackName))

    // 过了宽限期：过期 kit pack 回收，当前版本保留
    clock += 8 * 86400_000
    const pruned = await env.service.pruneRemote()
    assert.equal(pruned.ok, true)
    assert.ok(pruned.remoteDeleted >= 1, '过期 kit pack 应被回收')
    assert.equal(env.peer.files.has(oldPackName), false, '旧 kit pack 已删除')
    const index2 = await readIndex()
    const currentPack = Object.entries(index2.packs).find(([name, value]) => env.peer.files.has(name) && (value.names || []).includes('recovery-kit/extra.txt'))
    assert.ok(currentPack, '当前版本 kit pack 必须保留在子机')
    assert.deepEqual([...env.peer.files.keys()].filter((name) => name.startsWith('packs/')), [currentPack[0]])
  } finally {
    await removeTemp(env.root)
  }
})

test('offsite: prune 不删外部拷入/被改动的本地 pack（只删自己索引且 sha 一致的）', async () => {
  const env = await bootstrapped()
  try {
    const repoDir = path.join(env.storeDir, 'offsite', 'repo')
    const packName = 'packs/' + 'e'.repeat(64) + '.pbin'
    const packPath = path.join(repoDir, ...packName.split('/'))
    await fsp.mkdir(path.dirname(packPath), { recursive: true })
    const external = Buffer.from('external pack copied by hand')
    await fsp.writeFile(packPath, external)

    // ① 本地存在但索引里没有 → 不是我的数据，不得删
    const first = await env.service.pruneRemote()
    assert.equal(first.localDeleted, 0)
    assert.ok(await fsp.access(packPath).then(() => true, () => false), '无索引的本地 pack 必须保留')

    // ② 索引里记录过但内容 sha 与索引不一致（被改过/外部拷入）→ 不得删
    const indexFile = path.join(env.storeDir, 'offsite', 'packs.json')
    const index = JSON.parse(await fsp.readFile(indexFile, 'utf8'))
    index.packs[packName] = {
      at: Date.now() - 30 * 86400_000,
      bytes: external.length,
      sha256: 'f'.repeat(64),
      names: ['chunks/aa/bb/' + 'c'.repeat(64) + '.cbin'],
      shas: {},
    }
    await fsp.writeFile(indexFile, JSON.stringify(index))
    const service2 = createOffsiteService({
      engine: env.engine,
      getSync: () => env.peer.api,
      archive: env.archive,
      dpapi: env.dpapi,
      logger: () => {},
    })
    await service2.init()
    await service2.unlock('Offsite-Pass1')
    const second = await service2.pruneRemote()
    assert.equal(second.localDeleted, 0, 'sha 不一致的本地 pack 不得删')
    assert.ok(await fsp.access(packPath).then(() => true, () => false), '索引 sha 不一致的本地 pack 必须保留')
  } finally {
    await removeTemp(env.root)
  }
})

test('offsite: 与真实 src/archive/port.js 端到端（真实 BackupEngine + 真实加密仓库）', async (t) => {
  let realPort
  try {
    realPort = await import('../src/archive/port.js')
  } catch {
    t.skip('src/archive/port.js 尚未就位')
    return
  }
  const root = await tempDir('dbk-offsite-real-')
  const home = path.join(root, 'home')
  const storeRoot = path.join(root, 'store')
  await fsp.mkdir(home, { recursive: true })
  await fsp.writeFile(path.join(home, 'workspace.json'), '{"v":1,"real":true}')
  await fsp.mkdir(path.join(home, 'sessions', 's1'), { recursive: true })
  await fsp.writeFile(path.join(home, 'sessions', 's1', 'log.jsonl'), 'line\n'.repeat(400))
  const { BackupEngine } = await import('../src/engine.js')
  const engine = new BackupEngine({
    home,
    config: { root: storeRoot, watch: false, scanMs: 3_600_000, debounceMs: 0, minIntervalMs: 0 },
    snapshots: {},
    hostname: 'REAL-HOST',
    log: () => {},
  })
  const fakeDpapi = createFakeDpapi()
  let service = null
  try {
    await engine.start()
    service = createOffsiteService({
      engine,
      getSync: () => undefined,
      archive: realPort,
      dpapi: fakeDpapi,
      logger: () => {},
    })
    await service.init()
    await service.initRepo('Offsite-Real-1')

    const exported = await service.exportNow({})
    assert.equal(exported.ok, true)
    assert.ok(exported.newChunks > 0, '真实仓库应写入内容块')
    assert.equal(exported.sync.code, 'sync-missing')

    const state = await service.state()
    assert.equal(state.initialized, true)
    assert.equal(state.archives.length, 1)
    assert.ok(state.repo.chunks >= 2)

    // 同快照再导出：去重后 0 个新块
    const again = await service.exportNow({})
    assert.equal(again.newChunks, 0)

    // 演练：真实临时引擎 + 逐文件 sha256
    const drill = await service.drill({})
    assert.equal(drill.ok, true)
    assert.equal(drill.mismatched, 0)
    assert.ok(drill.files >= 2)

    // 恢复：改坏 home 里的文件再恢复回来
    const snapshotId = exported.snapshotId
    await fsp.writeFile(path.join(home, 'workspace.json'), '{"v":999}')
    const restored = await service.restore({ snapshotId })
    assert.equal(restored.ok, true)
    assert.equal(restored.needRestart, true)
    assert.equal(await fsp.readFile(path.join(home, 'workspace.json'), 'utf8'), '{"v":1,"real":true}')

    // DPAPI 缓存解锁 → 换一个服务实例也能直接导出
    await service.lock()
    const fresh = createOffsiteService({ engine, getSync: () => undefined, archive: realPort, dpapi: fakeDpapi, logger: () => {} })
    await fresh.init()
    const unlocked = await fresh.unlockFromCache()
    assert.equal(unlocked.keySource, 'cache')
    assert.equal((await fresh.state()).locked, false)
    await fresh.lock()
  } finally {
    if (service) await service.dispose().catch(() => {})
    await engine.stop().catch(() => {})
    await removeTemp(root)
  }
})

/* ------------------------------------------------------------- 无头入口 */

test('offsite: runHeadlessExport 只用 DPAPI 缓存无人值守导出；未注入 dshSync 时明确 sync-missing', async (t) => {
  let port
  try {
    port = await import('../src/archive/port.js')
  } catch {
    t.skip('src/archive/port.js 尚未就位')
    return
  }
  const { BackupEngine } = await import('../src/engine.js')
  const root = await tempDir('dbk-offsite-headless-')
  const home = path.join(root, 'home')
  const storeRoot = path.join(root, 'store')
  const hostname = 'HEADLESS-HOST'
  await fsp.mkdir(home, { recursive: true })
  await fsp.writeFile(path.join(home, 'a.txt'), 'headless export')
  const dpapi = createFakeDpapi()
  let engine = null
  try {
    engine = new BackupEngine({
      home,
      config: { root: storeRoot, watch: false, scanMs: 3_600_000, debounceMs: 0, minIntervalMs: 0 },
      snapshots: {},
      hostname,
      log: () => {},
    })
    await engine.start()
    const service = createOffsiteService({ engine, archive: port, dpapi, getSync: () => undefined, logger: () => {} })
    await service.init()
    await service.initRepo('Offsite-Headless-1')
    await service.lock()
    await engine.stop()

    // 无注入 dshSync：只导出本地仓库，结果里明确 sync-missing（计划任务的边界）
    const first = await runHeadlessExport({ home, root: storeRoot, hostname, dpapi, archive: port })
    assert.equal(first.ok, true)
    assert.ok(Number(first.newChunks) >= 0)
    assert.equal(first.sync.ok, false)
    assert.equal(first.sync.code, 'sync-missing')

    // 幂等：同快照再跑一次，不新增块
    const second = await runHeadlessExport({ home, root: storeRoot, hostname, dpapi, archive: port })
    assert.equal(second.ok, true)
    assert.equal(second.newChunks, 0)

    // 注入 dshSync 时会顺带同步（给「独立传输客户端」留的扩展点）
    const peer = createFakePeer({ online: true })
    const third = await runHeadlessExport({
      home,
      root: storeRoot,
      hostname,
      dpapi,
      archive: port,
      getSync: () => peer.api,
    })
    assert.equal(third.ok, true)
    assert.equal(third.sync.ok, true)
    assert.ok([...peer.files.keys()].some((name) => name.startsWith('packs/')))

    // 没有 DPAPI 缓存时必须明确失败，不能悄悄用错误密钥导出
    const offsiteDir = path.join(storeRoot, hostname, 'offsite')
    await fsp.rm(path.join(offsiteDir, 'key.dpapi'), { force: true })
    await assert.rejects(
      () => runHeadlessExport({ home, root: storeRoot, hostname, dpapi, archive: port }),
      (error) => error.code === 'no-cached-key',
    )
  } finally {
    if (engine) await engine.stop().catch(() => {})
    await removeTemp(root)
  }
})

/* ------------------------------------------------------------- 面板动作 */

function makeRequest(method, payload, remoteAddress = '127.0.0.1') {
  const body = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]
  const req = Readable.from(body)
  req.method = method
  req.socket = { remoteAddress }
  return req
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    end(chunk) { this.body = chunk === undefined ? '' : String(chunk) },
  }
}

async function call(handler, method, payload) {
  const req = makeRequest(method, payload)
  const res = makeResponse()
  await handler(req, res)
  return { status: res.statusCode, json: JSON.parse(res.body), raw: res.body }
}

test('offsite: recovery-kit 会被同步且 prune 永不删（离线恢复工具，不含密钥）', async () => {
  const env = await bootstrapped()
  try {
    // core 的 LocalRepo.init 会自动写 kit（fake 仓库也会被兜底写一份）；这里再放一个标记文件
    const kitDir = path.join(env.storeDir, 'offsite', 'repo', 'recovery-kit')
    await fsp.mkdir(kitDir, { recursive: true })
    await fsp.writeFile(path.join(kitDir, 'README.txt'), 'offline recovery kit — no keys\n')

    const sync = await env.service.syncToPeer()
    assert.equal(sync.ok, true)
    const indexFile = path.join(env.storeDir, 'offsite', 'packs.json')
    const index = JSON.parse(await fsp.readFile(indexFile, 'utf8'))
    const kitPack = Object.entries(index.packs).find(([, value]) => (value.names || []).some((name) => name.startsWith('recovery-kit/')))
    assert.ok(kitPack, 'recovery-kit 文件应被打进 pack 同步到子机')
    const [kitPackName] = kitPack
    assert.ok(env.peer.files.has(kitPackName), '子机上应有 kit pack')

    // 没有任何 archive 时 prune：kit 不在保留清单引用集里，但必须保留（本地与子机都不删）
    const kitBefore = (await fsp.readdir(kitDir)).sort()
    assert.ok(kitBefore.length >= 1)
    const pruned = await env.service.pruneRemote()
    assert.equal(pruned.ok, true)
    assert.equal(pruned.localDeleted, 0, '不得删 kit 文件/pack')
    assert.ok(env.peer.files.has(kitPackName), '子机上的 kit pack 必须保留')
    assert.deepEqual((await fsp.readdir(kitDir)).sort(), kitBefore, '本地 kit 文件必须原样保留')
  } finally {
    await removeTemp(env.root)
  }
})

test('panel: 旧 Host（没有 getOffsite）不暴露 offsite 字段，offsite-* 返回 offsite-unavailable', async () => {
  const env = await setup()
  try {
    const handler = createPanelHandler({ getEngine: () => env.engine, getStartError: () => null, log: () => {} })
    const get = await call(handler, 'GET')
    assert.equal(get.status, 200)
    assert.equal(Object.prototype.hasOwnProperty.call(get.json.state, 'offsite'), false, '旧 Host 不得出现 offsite 字段')
    const action = await call(handler, 'POST', { action: 'offsite-state' })
    assert.equal(action.status, 400)
    assert.equal(action.json.error.code, 'offsite-unavailable')
  } finally {
    await removeTemp(env.root)
  }
})

test('panel: offsite-* 动作契约（state/unlock/config/task-cmd 且响应不含密码）', async () => {
  const env = await setup()
  try {
    const handler = createPanelHandler({
      getEngine: () => env.engine,
      getStartError: () => null,
      log: () => {},
      getOffsite: () => env.service,
    })
    const state = await call(handler, 'POST', { action: 'offsite-state', probe: false })
    assert.equal(state.status, 200)
    assert.equal(state.json.ok, true)
    assert.ok(state.json.offsite)
    assert.equal(state.json.offsite.initialized, false)
    // 多子机列表由 offsite-state 原样透传（UI 的「备份到 [设备选择]」用它）
    assert.ok(Array.isArray(state.json.offsite.peers))
    assert.equal(state.json.offsite.peers.length, 1)
    assert.equal(state.json.offsite.peers[0].selected, true)
    assert.equal(state.json.offsite.peers[0].deviceId, state.json.offsite.peer.id)
    assert.ok(state.json.state && Object.prototype.hasOwnProperty.call(state.json.state, 'offsite'))

    const get = await call(handler, 'GET')
    assert.equal(get.json.state.offsite.initialized, false)
    assert.ok(Array.isArray(get.json.state.offsite.peers), 'GET 摘要也带 peers')
    assert.equal(get.json.state.offsite.peers[0].selected, true)

    // offsite-config 透传 peerDeviceId（选中已配对设备；panel 侧不做额外逻辑）
    const select = await call(handler, 'POST', { action: 'offsite-config', config: { peerDeviceId: 'peer-abcdef01' } })
    assert.equal(select.status, 200)
    assert.equal(select.json.applied.peerDeviceId, 'peer-abcdef01')
    assert.equal(select.json.offsite.config.peerDeviceId, 'peer-abcdef01')
    assert.equal(select.json.offsite.peer.source, 'config')
    assert.equal(select.json.offsite.peers[0].selected, true)

    const init = await call(handler, 'POST', { action: 'offsite-init', password: 'Offsite-Pass1' })
    assert.equal(init.status, 200)
    assert.equal(init.json.result.ok, true)
    assert.ok(!init.raw.includes('Offsite-Pass1'), '响应不得包含密码')

    await call(handler, 'POST', { action: 'offsite-lock' })
    const bad = await call(handler, 'POST', { action: 'offsite-unlock', password: 'WrongPass123' })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.error.code, 'bad-password')
    assert.ok(!bad.raw.includes('WrongPass123'), '错误响应不得回显密码')

    const missing = await call(handler, 'POST', { action: 'offsite-unlock' })
    assert.equal(missing.status, 400)
    assert.equal(missing.json.error.code, 'bad-request')

    const unlock = await call(handler, 'POST', { action: 'offsite-unlock', password: 'Offsite-Pass1' })
    assert.equal(unlock.status, 200)
    assert.equal(unlock.json.offsite.locked, false)
    assert.ok(!unlock.raw.includes('Offsite-Pass1'))

    const config = await call(handler, 'POST', { action: 'offsite-config', config: { retainDaily: 9 } })
    assert.equal(config.status, 200)
    assert.equal(config.json.applied.retainDaily, 9)
    assert.equal(config.json.offsite.config.retainDaily, 9)

    const task = await call(handler, 'POST', { action: 'offsite-task-cmd' })
    assert.equal(task.status, 200)
    assert.equal(task.json.installed, false)
    assert.ok(task.json.command && typeof task.json.command.command === 'string')
    assert.match(task.json.command.command, /Register-ScheduledTask/)
    assert.match(task.json.command.schtasks, /schtasks\.exe/)

    // 未知动作仍然是 unknown-action（旧契约不变）
    const unknown = await call(handler, 'POST', { action: 'offsite-nope' })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.json.error.code, 'unknown-action')

    // 导出 / 同步 / 演练 / 恢复的返回结构
    const exportAction = await call(handler, 'POST', { action: 'offsite-export' })
    assert.equal(exportAction.status, 200)
    assert.equal(exportAction.json.result.ok, true)
    assert.ok(exportAction.json.offsite.archives.length >= 1)

    const syncAction = await call(handler, 'POST', { action: 'offsite-sync' })
    assert.equal(syncAction.status, 200)
    assert.equal(syncAction.json.result.ok, true)

    const drillAction = await call(handler, 'POST', {
      action: 'offsite-drill',
    })
    // 演练需要临时引擎：面板路径没有注入 createTempEngine → 走真实 BackupEngine（本机可用），
    // 这里只断言契约形状（ok 或错误二选一，不能是 500）
    assert.ok(drillAction.status === 200 || drillAction.status === 400)
    assert.ok(drillAction.json.ok === true || typeof drillAction.json.error.code === 'string')

    const restoreMissing = await call(handler, 'POST', { action: 'offsite-restore' })
    assert.equal(restoreMissing.status, 400)
    assert.equal(restoreMissing.json.error.code, 'bad-request')
  } finally {
    await removeTemp(env.root)
  }
})
