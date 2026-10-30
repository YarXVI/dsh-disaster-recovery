/**
 * 面板 HTTP 契约 v0.3.0 测试：state 走 30s 统计缓存、verify/preview 只读、
 * 写操作后强刷统计、open 目标校验、startError 覆盖 health、旧 action 兼容。
 * 全部用临时 home/root；open 只测非法 target（合法 target 会真的弹资源管理器）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { BackupEngine } from '../src/engine.js'
import { createPanelHandler } from '../src/panel.js'

const PKG = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function makeHome() {
  const home = await tempDir('dbk-panel-home-')
  await fs.mkdir(path.join(home, 'sessions', '--D-x--', 'session-1'), { recursive: true })
  await fs.writeFile(path.join(home, 'sessions', '--D-x--', 'session-1', 'session.v4.jsonl.zstd'), 'session-body')
  await fs.writeFile(path.join(home, 'workspace.json'), '{"v":1}')
  return home
}

function makeEngine(home, root) {
  return new BackupEngine({
    home,
    config: { root, watch: false, scanMs: 3_600_000, debounceMs: 0, minIntervalMs: 0 },
    log: () => {},
    hostname: 'test-host',
  })
}

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

async function call(handler, method, payload, remoteAddress) {
  const req = makeRequest(method, payload, remoteAddress)
  const res = makeResponse()
  await handler(req, res)
  return { status: res.statusCode, json: JSON.parse(res.body) }
}

async function withEngine(fn) {
  const home = await makeHome()
  const root = await tempDir('dbk-panel-root-')
  const engine = makeEngine(home, root)
  await engine.start()
  try {
    return await fn({ engine, home, root })
  } finally {
    await engine.stop()
  }
}

function countScans(engine) {
  const counter = { scans: 0 }
  const original = engine.store.stats.bind(engine.store)
  engine.store.stats = async () => {
    counter.scans += 1
    return original()
  }
  return counter
}

test('panel: GET/state return full v0.3 state and share the 30s blob-stat cache', async () => {
  await withEngine(async ({ engine }) => {
    engine.watching = true // 测试配置 watch:false，手动置为监听中才能得到 healthy
    const counter = countScans(engine)
    const handler = createPanelHandler({ getEngine: () => engine, getStartError: () => null, log: () => {} })

    const get = await call(handler, 'GET')
    assert.equal(get.status, 200)
    assert.equal(get.json.ok, true)
    const state = get.json.state
    assert.equal(state.version, PKG.version)
    assert.ok(state.blob && Number.isFinite(state.blob.at), 'state 动作会填充 blob 统计')
    assert.equal(state.health.code, 'healthy')
    assert.deepEqual(state.quarantines, [])
    assert.equal(state.lastRestore, null)
    assert.equal(counter.scans, 1)

    const second = await call(handler, 'POST', { action: 'state' })
    assert.equal(second.status, 200)
    assert.equal(second.json.state.blob.at, state.blob.at, '30s 内轮询复用缓存')
    assert.equal(counter.scans, 1, 'state 轮询不得重复扫盘')

    const forbidden = await call(handler, 'GET', undefined, '10.1.2.3')
    assert.equal(forbidden.status, 403)
    assert.equal(forbidden.json.error.code, 'forbidden')
  })
})

test('panel: verify/preview are read-only and do not force a stats refresh', async () => {
  await withEngine(async ({ engine, home }) => {
    const counter = countScans(engine)
    const handler = createPanelHandler({ getEngine: () => engine, getStartError: () => null, log: () => {} })
    const state = await call(handler, 'POST', { action: 'state' })
    assert.equal(counter.scans, 1)
    const id = state.json.state.lastSnapshot.id

    const verify = await call(handler, 'POST', { action: 'verify' })
    assert.equal(verify.status, 200)
    assert.equal(verify.json.verify.id, id)
    assert.equal(verify.json.verify.ok, true)
    assert.ok(verify.json.state, 'verify 也回 state')
    assert.equal(counter.scans, 1, 'verify 不强制刷新统计')
    assert.equal(engine.busy, false, 'verify 不得置 busy')
    assert.equal(engine.lastManifest.id, id)

    const preview = await call(handler, 'POST', { action: 'preview', id })
    assert.equal(preview.status, 200)
    assert.equal(preview.json.preview.id, id)
    assert.equal(preview.json.preview.unchanged, 2)
    assert.equal(counter.scans, 1, 'preview 不强制刷新统计')
    assert.equal(engine.busy, false, 'preview 不得置 busy')
    assert.equal(engine.lastManifest.id, id)

    // 缺 id / 未知 id 的错误路径
    const missing = await call(handler, 'POST', { action: 'preview' })
    assert.equal(missing.status, 400)
    assert.equal(missing.json.error.code, 'bad-request')
    const unknownId = await call(handler, 'POST', { action: 'verify', id: 'nope' })
    assert.equal(unknownId.status, 500)
    assert.equal(unknownId.json.error.code, 'panel')

    // 预演只读：不产生隔离目录、不改最后快照
    await assert.rejects(() => fs.stat(path.join(engine.store.dir, 'restore-quarantine')), /ENOENT/)
    assert.equal(engine.lastManifest.id, id)
    assert.equal(await fs.readFile(path.join(home, 'workspace.json'), 'utf8'), '{"v":1}')
  })
})

test('panel: backup/restore/delete force a stats refresh; pause/resume/config stay cached', async () => {
  await withEngine(async ({ engine, home }) => {
    const counter = countScans(engine)
    const handler = createPanelHandler({ getEngine: () => engine, getStartError: () => null, log: () => {} })
    await call(handler, 'POST', { action: 'state' })
    assert.equal(counter.scans, 1)
    const id = engine.latestSnapshotId()

    const pause = await call(handler, 'POST', { action: 'pause' })
    assert.equal(pause.json.state.paused, true)
    const resume = await call(handler, 'POST', { action: 'resume' })
    assert.equal(resume.json.state.paused, false)
    assert.equal(counter.scans, 1, 'pause/resume 不强制扫盘')

    const config = await call(handler, 'POST', { action: 'config', config: { minIntervalMs: 1, unknown: 1 } })
    assert.equal(config.status, 200)
    assert.equal(config.json.applied.minIntervalMs, 10_000, 'config 校验在 panel 路径上生效')
    assert.ok(!('unknown' in config.json.applied))
    assert.equal(counter.scans, 1, 'config 不强制扫盘')

    const backup = await call(handler, 'POST', { action: 'backup' })
    assert.equal(backup.status, 200)
    assert.equal(counter.scans, 2, 'backup 之后强制刷新统计')

    await fs.writeFile(path.join(home, 'workspace.json'), '{"v":999}')
    const restore = await call(handler, 'POST', { action: 'restore', id })
    assert.equal(restore.status, 200)
    assert.equal(restore.json.result.snapshot, id)
    assert.equal(counter.scans, 3, 'restore 之后强制刷新统计')
    assert.equal(restore.json.state.lastRestore.snapshot, id, 'state 带 lastRestore')
    assert.ok(restore.json.state.quarantines.length >= 1, 'state 带隔离记录')

    const deleted = await call(handler, 'POST', { action: 'delete', id: engine.latestSnapshotId() })
    assert.equal(deleted.status, 200)
    assert.ok(deleted.json.pruned)
    assert.equal(counter.scans, 4, 'delete 之后强制刷新统计')
  })
})

test('panel: startError overrides health with level=error', async () => {
  await withEngine(async ({ engine }) => {
    const handler = createPanelHandler({
      getEngine: () => engine,
      getStartError: () => '磁盘不可写（模拟）',
      log: () => {},
    })
    const state = await call(handler, 'POST', { action: 'state' })
    assert.equal(state.status, 200)
    assert.equal(state.json.state.health.level, 'error')
    assert.equal(state.json.state.health.code, 'last-error')
    assert.match(state.json.state.health.message, /磁盘不可写/)

    const get = await call(handler, 'GET')
    assert.equal(get.json.state.health.level, 'error')
  })
})

test('panel: not-ready, unknown-action, bad-request and open target validation', async () => {
  const notReady = createPanelHandler({ getEngine: () => null, getStartError: () => '引擎未启动', log: () => {} })
  const state = await call(notReady, 'POST', { action: 'state' })
  assert.equal(state.status, 400)
  assert.equal(state.json.error.code, 'not-ready')
  assert.match(state.json.error.message, /引擎未启动/)

  await withEngine(async ({ engine }) => {
    const handler = createPanelHandler({ getEngine: () => engine, getStartError: () => null, log: () => {} })

    const unknown = await call(handler, 'POST', { action: 'fly-away' })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.json.error.code, 'unknown-action')

    const badOpen = await call(handler, 'POST', { action: 'open', target: 'nope' })
    assert.equal(badOpen.status, 400)
    assert.equal(badOpen.json.error.code, 'bad-request')
    assert.match(badOpen.json.error.message, /nope/)

    const badRestore = await call(handler, 'POST', { action: 'restore' })
    assert.equal(badRestore.status, 400)
    assert.equal(badRestore.json.error.code, 'bad-request')

    const badDelete = await call(handler, 'POST', { action: 'delete' })
    assert.equal(badDelete.status, 400)
  })
})

test('panel: open resolves store/home/quarantine/logs; missing log opens tmpdir; mkdir quarantine', async () => {
  await withEngine(async ({ engine, root }) => {
    const spawns = []
    const spawnProcess = (command, args, options) => {
      spawns.push({ command, args, options })
      return { unref() {} }
    }
    const logFile = path.join(root, 'not-yet-created.log')
    const handler = createPanelHandler({
      getEngine: () => engine,
      getStartError: () => null,
      log: () => {},
      spawnProcess,
      logFile,
    })
    const win32 = process.platform === 'win32'
    const lastSpawn = () => spawns[spawns.length - 1]

    const store = await call(handler, 'POST', { action: 'open', target: 'store' })
    assert.equal(store.status, 200)
    assert.equal(store.json.dir, engine.store.dir)
    if (win32) {
      assert.equal(lastSpawn().command, 'explorer.exe')
      assert.deepEqual(lastSpawn().args, [engine.store.dir])
      assert.equal(lastSpawn().options.detached, true)
    }

    const home = await call(handler, 'POST', { action: 'open', target: 'home' })
    assert.equal(home.status, 200)
    assert.equal(home.json.dir, engine.home)
    if (win32) assert.deepEqual(lastSpawn().args, [engine.home])

    // 隔离目录不存在时先补建空目录，再打开
    const quarantineDir = path.join(engine.store.dir, 'restore-quarantine')
    await assert.rejects(() => fs.stat(quarantineDir), /ENOENT/)
    const quarantine = await call(handler, 'POST', { action: 'open', target: 'quarantine' })
    assert.equal(quarantine.status, 200)
    assert.equal(quarantine.json.dir, quarantineDir)
    assert.equal((await fs.stat(quarantineDir)).isDirectory(), true, 'open quarantine 应先 mkdir')
    if (win32) assert.deepEqual(lastSpawn().args, [quarantineDir])

    // logs 不存在 → 打开系统临时目录（不对不存在的文件 /select）
    const logsMissing = await call(handler, 'POST', { action: 'open', target: 'logs' })
    assert.equal(logsMissing.status, 200)
    assert.equal(logsMissing.json.dir, logFile)
    if (win32) assert.deepEqual(lastSpawn().args, [os.tmpdir()])

    // logs 存在 → explorer /select,<file>
    await fs.writeFile(logFile, 'log line\n')
    const logsExists = await call(handler, 'POST', { action: 'open', target: 'logs' })
    assert.equal(logsExists.status, 200)
    if (win32) assert.deepEqual(lastSpawn().args, [`/select,${logFile}`])

    // open-dir 兼容 = store
    const legacy = await call(handler, 'POST', { action: 'open-dir' })
    assert.equal(legacy.status, 200)
    assert.equal(legacy.json.dir, engine.store.dir)
    if (win32) assert.deepEqual(lastSpawn().args, [engine.store.dir])
  })
})

test('panel: non-JSON body is rejected with 400', async () => {
  await withEngine(async ({ engine }) => {
    const handler = createPanelHandler({ getEngine: () => engine, getStartError: () => null, log: () => {} })
    const req = Readable.from([Buffer.from('not-json')])
    req.method = 'POST'
    req.socket = { remoteAddress: '127.0.0.1' }
    const res = makeResponse()
    await handler(req, res)
    assert.equal(res.statusCode, 400)
    const json = JSON.parse(res.body)
    assert.equal(json.error.code, 'bad-request')
  })
})
