/**
 * 契约 v0.3.0 后端行为测试：verify / preview / 隔离记录 / 统计缓存 / 配置校验 / health。
 * 全部使用 mkdtemp 临时 home + 临时 root，绝不触碰真实 %USERPROFILE%\.dsh。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BackupEngine, entryChunks } from '../src/engine.js'

const PKG = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))
const MUTABLE_KEYS = [
  'enabled', 'watch', 'paused', 'debounceMs', 'minIntervalMs', 'scanMs',
  'maxFileBytes', 'chunkSize', 'keepLast', 'keepHourlyHours', 'keepDailyDays',
  'maxSnapshots', 'excludes',
]

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function makeHome() {
  const home = await tempDir('dbk-v3-home-')
  await fs.mkdir(path.join(home, 'sessions', '--D-x--', 'session-1'), { recursive: true })
  await fs.writeFile(path.join(home, 'sessions', '--D-x--', 'session-1', 'session.v4.jsonl.zstd'), 'session-body')
  await fs.writeFile(path.join(home, 'workspace.json'), '{"v":1}')
  await fs.mkdir(path.join(home, 'dsh-runtimes', 'node'), { recursive: true })
  await fs.writeFile(path.join(home, 'dsh-runtimes', 'node', 'node.exe'), 'runtime-binary')
  return home
}

function makeEngine(home, root, extra = {}) {
  return new BackupEngine({
    home,
    config: { root, watch: false, scanMs: 3_600_000, debounceMs: 0, minIntervalMs: 0, ...extra },
    log: () => {},
    hostname: 'test-host',
  })
}

/* --------------------------------------------------------------- verify */

test('verifySnapshot: ok for intact snapshot, reports missing blobs, is read-only', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-v3-root-')
  const engine = makeEngine(home, root)
  await engine.start()
  try {
    const id = engine.state().lastSnapshot.id
    const manifest = await engine.store.readManifest(id)
    const snapshotsBefore = engine.snapshots.length

    const good = await engine.verifySnapshot()
    assert.equal(good.id, id, '缺省 id 用 latestSnapshotId()')
    assert.equal(good.at, manifest.at)
    assert.equal(good.files, Object.keys(manifest.files).length)
    assert.equal(good.ok, true)
    assert.equal(good.missingCount, 0)
    assert.deepEqual(good.missing, [])
    assert.ok(Number.isFinite(good.checkedAt))
    assert.equal(engine.lastManifest.id, id, 'verify 不得改 lastManifest')
    assert.equal(engine.busy, false, 'verify 不得置 busy')
    assert.equal(engine.snapshots.length, snapshotsBefore, 'verify 不得改快照列表')
    const snapshotFilesBefore = (await fs.readdir(engine.store.snapDir)).length
    await engine.verifySnapshot()
    assert.equal((await fs.readdir(engine.store.snapDir)).length, snapshotFilesBefore, 'verify 不得写盘')

    // 删掉一个内容块 → 缺块
    const rel = Object.keys(manifest.files).sort()[0]
    const hash = entryChunks(manifest.files[rel])[0]
    await fs.rm(engine.store.blobPath(hash))
    const bad = await engine.verifySnapshot(id)
    assert.equal(bad.ok, false)
    assert.equal(bad.missingCount, 1)
    assert.deepEqual(bad.missing, [rel])
    assert.equal(engine.lastManifest.id, id)

    await assert.rejects(() => engine.verifySnapshot('no-such-snapshot'), /快照不存在或已损坏/)
  } finally {
    await engine.stop()
  }
})

test('verifySnapshot: default id skips pre-restore snapshots', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-v3-root-')
  const engine = makeEngine(home, root)
  await engine.start()
  try {
    await fs.writeFile(path.join(home, 'workspace.json'), '{"v":2}')
    const good = await engine.snapshot('manual')
    assert.ok(good.id)
    await fs.writeFile(path.join(home, 'workspace.json'), '{"v":3}')
    const pre = await engine.snapshot('pre-restore')
    assert.equal(engine.snapshots[0].reason, 'pre-restore')
    assert.notEqual(good.id, pre.id)
    const verify = await engine.verifySnapshot()
    assert.equal(verify.id, good.id, '默认体检不能挑中 pre-restore 快照')
    // 显式传 pre-restore id 时按传入的校验
    const explicit = await engine.verifySnapshot(pre.id)
    assert.equal(explicit.id, pre.id)
  } finally {
    await engine.stop()
  }
})

test('verifySnapshot: no snapshot at all is rejected', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-v3-root-')
  const engine = new BackupEngine({
    home,
    config: { root, watch: false, scanMs: 3_600_000 },
    log: () => {},
    hostname: 'test-host',
    snapshotOnStart: false,
  })
  await engine.start()
  try {
    await assert.rejects(() => engine.verifySnapshot(), /没有可校验的快照/)
  } finally {
    await engine.stop()
  }
})

test('0-byte files verify as valid and restore writes them back', async () => {
  const home = await tempDir('dbk-v3-empty-home-')
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true })
  await fs.writeFile(path.join(home, 'empty.txt'), '')
  await fs.writeFile(path.join(home, 'sessions', 'data.txt'), 'data-body')
  const root = await tempDir('dbk-v3-empty-root-')
  const engine = makeEngine(home, root)
  await engine.start()
  try {
    const id = engine.state().lastSnapshot.id
    const manifest = await engine.store.readManifest(id)
    assert.equal(manifest.files['empty.txt'].s, 0)
    assert.deepEqual(entryChunks(manifest.files['empty.txt']), [], '0 字节文件是空块列表')

    // 回归：0 字节文件不得被判成缺块（否则整个恢复会被拒绝）
    const verify = await engine.verifySnapshot(id)
    assert.equal(verify.ok, true, '0 字节文件不能判成缺块')
    assert.equal(verify.missingCount, 0)
    assert.deepEqual(verify.missing, [])
    assert.equal(verify.files, 2)

    // 恢复：删掉空文件 + 把另一个文件改成空内容，恢复后应写回快照内容
    await fs.rm(path.join(home, 'empty.txt'))
    await fs.writeFile(path.join(home, 'sessions', 'data.txt'), '')
    const result = await engine.restore(id)
    assert.equal(result.ok, true)
    assert.equal((await fs.stat(path.join(home, 'empty.txt'))).size, 0, '空文件应被恢复')
    assert.equal(await fs.readFile(path.join(home, 'sessions', 'data.txt'), 'utf8'), 'data-body')
    // 被覆盖的“空内容”进了隔离目录（恢复语义不变）
    assert.equal(await fs.readFile(path.join(result.quarantineDir, 'sessions', 'data.txt'), 'utf8'), '')

    // 真缺块（非空文件）仍然报 missing
    const hash = entryChunks(manifest.files['sessions/data.txt'])[0]
    await fs.rm(engine.store.blobPath(hash))
    const bad = await engine.verifySnapshot(id)
    assert.equal(bad.ok, false)
    assert.equal(bad.missingCount, 1)
    assert.deepEqual(bad.missing, ['sessions/data.txt'])
  } finally {
    await engine.stop()
  }
})

test('concurrent snapshots/deletes are serialized: every manifest verifies', async () => {
  const home = await tempDir('dbk-v3-conc-home-')
  const file = path.join(home, 'data.txt')
  await fs.writeFile(file, 'a')
  const root = await tempDir('dbk-v3-conc-root-')
  const engine = makeEngine(home, root, { chunkSize: 1024 })
  await engine.start()
  try {
    const originalPut = engine.store.put.bind(engine.store)
    let releaseGate
    const gate = new Promise((resolve) => { releaseGate = resolve })
    let gated = false
    engine.store.put = async (buf) => {
      if (!gated) { gated = true; await gate }
      return originalPut(buf)
    }

    // 第一个快照已读完 'bb'、卡在写 blob；此时改文件并排队第二个快照
    await fs.writeFile(file, 'bb')
    const first = engine.snapshot('manual')
    while (!gated) await new Promise((resolve) => setTimeout(resolve, 1))
    await fs.writeFile(file, 'ccc')
    const second = engine.snapshot('manual')
    releaseGate()

    const [a, b] = await Promise.all([first, second])
    assert.ok(a.id, '第一个并发快照应写入清单')
    assert.ok(b.id, '第二个并发快照应写入清单')
    assert.notEqual(a.id, b.id)

    // 旧 bug 的症状：先完成者 prune 掉后完成者的独有块 → 清单缺块
    const manifests = await engine.store.listManifests()
    assert.equal(manifests.length, 3, 'startup + 两个并发快照')
    for (const manifest of manifests) {
      assert.deepEqual((await engine.store.verify(manifest)).missing, [], `manifest ${manifest.id} 不应缺块`)
      assert.equal((await engine.verifySnapshot(manifest.id)).ok, true)
    }

    // deleteSnapshot 与 snapshot 并发：也不得破坏任何清单
    const victim = engine.snapshots[engine.snapshots.length - 1]
    assert.ok(victim && victim.id)
    await fs.writeFile(file, 'dddd')
    const snapshotPromise = engine.snapshot('manual')
    const deletePromise = engine.deleteSnapshot(victim.id)
    const [, deleted] = await Promise.all([snapshotPromise, deletePromise])
    assert.ok(deleted)
    for (const manifest of await engine.store.listManifests()) {
      assert.deepEqual((await engine.store.verify(manifest)).missing, [], `delete 并发后 ${manifest.id} 不应缺块`)
    }

    // 并发之后恢复仍然可用；restore 期间的 pre-restore 快照不会被外部 delete 打断
    const target = await engine.store.listManifests()
    assert.ok(target.length >= 1)
    const restorePromise = engine.restore(target[0].id)
    await assert.rejects(
      () => engine.deleteSnapshot(engine.snapshots[engine.snapshots.length - 1].id),
      /正在备份\/恢复/,
      'restore 进行中 delete 必须被拒绝（保护 pre-restore 快照）',
    )
    const restored = await restorePromise
    assert.equal(restored.ok, true)
  } finally {
    await engine.stop()
  }
})

/* -------------------------------------------------------------- preview */

test('previewRestore counts create/change/unchanged/extra and never writes', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-v3-root-')
  const engine = makeEngine(home, root)
  await engine.start()
  try {
    const id = engine.state().lastSnapshot.id
    const manifest = await engine.store.readManifest(id)
    const files = Object.keys(manifest.files)
    assert.equal(files.length, 2)
    const sessionRel = 'sessions/--D-x--/session-1/session.v4.jsonl.zstd'

    // 什么都没动
    const first = await engine.previewRestore(id)
    assert.equal(first.id, id)
    assert.equal(first.at, manifest.at)
    assert.equal(first.reason, 'startup')
    assert.equal(first.files, 2)
    assert.equal(first.create, 0)
    assert.equal(first.changed, 0)
    assert.equal(first.unchanged, 2)
    assert.equal(first.extra, 0)
    assert.equal(first.bytes, 0)
    assert.deepEqual(first.sample, [])

    // 改一个 → change；删一个 → create；加一个 → extra（恢复时保留）
    await fs.writeFile(path.join(home, 'workspace.json'), '{"v":999}')
    await fs.rm(path.join(home, sessionRel))
    await fs.writeFile(path.join(home, 'extra.txt'), 'created-after-snapshot')

    const second = await engine.previewRestore(id)
    assert.equal(second.create, 1)
    assert.equal(second.changed, 1)
    assert.equal(second.unchanged, 0)
    assert.equal(second.extra, 1)
    // bytes 是“将被写回的清单内容字节”（create + changed 的 entry.s 之和）
    assert.equal(second.bytes, Buffer.byteLength('{"v":1}') + Buffer.byteLength('session-body'))
    assert.equal(second.sample.length, 2)
    const kinds = Object.fromEntries(second.sample.map((item) => [item.rel, item.kind]))
    assert.equal(kinds['workspace.json'], 'change')
    assert.equal(kinds[sessionRel], 'create')

    // 只读：清单、快照列表、隔离目录都不变
    assert.equal(engine.lastManifest.id, id)
    assert.equal(engine.busy, false, 'preview 不得置 busy')
    assert.equal(engine.snapshots.length, 1)
    assert.equal((await fs.readdir(engine.store.snapDir)).length, 1, 'preview 不得写盘')
    await assert.rejects(() => fs.stat(path.join(engine.store.dir, 'restore-quarantine')), /ENOENT/)

    await assert.rejects(() => engine.previewRestore(''), /缺少快照 id/)
    await assert.rejects(() => engine.previewRestore('no-such-snapshot'), /快照不存在或已损坏/)
  } finally {
    await engine.stop()
  }
})

/* ---------------------------------------------------------- 配置校验 */

test('updateConfig clamps numbers, sanitizes excludes, ignores unknown keys, persists mutable only', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-v3-root-')
  const engine = makeEngine(home, root)
  await engine.start()
  try {
    const applied = await engine.updateConfig({
      minIntervalMs: 1,
      debounceMs: -5,
      scanMs: 1000,
      keepLast: 0,
      keepHourlyHours: -2,
      keepDailyDays: -1,
      maxFileBytes: 10,
      chunkSize: 7,
      excludes: [' dsh-runtimes ', 'dsh-runtimes', '', '  ', '*.tmp', 42, null],
      root: 'D:\\evil-root',
      unknownKey: 'nope',
    })
    assert.equal(applied.minIntervalMs, 10_000, 'minIntervalMs 下限 10s')
    assert.equal(applied.debounceMs, 0, 'debounceMs 下限 0')
    assert.equal(applied.scanMs, 60_000, 'scanMs 下限 60s')
    assert.equal(applied.keepLast, 1)
    assert.equal(applied.keepHourlyHours, 0)
    assert.equal(applied.keepDailyDays, 0)
    assert.equal(applied.maxFileBytes, 1024)
    assert.equal(applied.chunkSize, 1024)
    assert.deepEqual(applied.excludes, ['dsh-runtimes', '*.tmp'], 'excludes trim/去空/去重/只收字符串')
    assert.ok(!('root' in applied), 'root 不在 MUTABLE_KEYS，忽略')
    assert.ok(!('unknownKey' in applied), '未知键忽略')
    assert.equal(path.resolve(engine.config.root), path.resolve(root), '运行期不能改 root')

    const state = engine.state()
    assert.equal(state.config.minIntervalMs, 10_000)
    assert.equal(state.config.keepLast, 1)
    assert.deepEqual(state.config.excludes, ['dsh-runtimes', '*.tmp'])
    assert.equal(state.config.root, path.resolve(root))
    assert.equal(state.config.enabled, true)
    assert.equal(state.config.watch, false)
    assert.equal(state.config.paused, false)

    // 持久化：config.json 只含 MUTABLE_KEYS，且是夹取后的值
    const saved = JSON.parse(await fs.readFile(path.join(engine.store.dir, 'config.json'), 'utf8'))
    assert.deepEqual(Object.keys(saved).sort(), [...MUTABLE_KEYS].sort())
    assert.equal(saved.minIntervalMs, 10_000)
    assert.equal(saved.keepLast, 1)
    assert.deepEqual(saved.excludes, ['dsh-runtimes', '*.tmp'])
    assert.ok(!('root' in saved))

    // 非法类型整键忽略（不写入、不持久化脏值）
    const ignored = await engine.updateConfig({ keepLast: '5', excludes: 'dsh-runtimes', enabled: 'yes' })
    assert.deepEqual(ignored, {})
    assert.equal(engine.config.keepLast, 1)
    assert.equal(engine.config.enabled, true)
    assert.deepEqual(engine.config.excludes, ['dsh-runtimes', '*.tmp'])

    // 上限夹取
    const upper = await engine.updateConfig({ keepLast: 1e9, debounceMs: 1e9, minIntervalMs: 1e9 })
    assert.equal(upper.keepLast, 10_000)
    assert.equal(upper.debounceMs, 600_000)
    assert.equal(upper.minIntervalMs, 86_400_000)

    // excludes 上限 100 条
    const many = Array.from({ length: 150 }, (_, index) => `dir-${index}`)
    const capped = await engine.updateConfig({ excludes: many })
    assert.equal(capped.excludes.length, 100)
    assert.equal(capped.excludes[0], 'dir-0')
    assert.equal(capped.excludes[99], 'dir-99')
  } finally {
    await engine.stop()
  }
})

test('start() re-normalizes dirty config.json left by older versions', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-v3-root-')
  const engine = makeEngine(home, root)
  await engine.start()
  const storeDir = engine.store.dir
  await engine.stop()
  // 手写一份“脏”配置：低于新下限的数值 + 非数组 excludes
  await fs.writeFile(path.join(storeDir, 'config.json'), JSON.stringify({
    scanMs: 1, minIntervalMs: 2, keepLast: 0, excludes: 'dsh-runtimes',
  }))
  const engine2 = makeEngine(home, root)
  await engine2.start()
  try {
    assert.equal(engine2.config.scanMs, 60_000)
    assert.equal(engine2.config.minIntervalMs, 10_000)
    assert.equal(engine2.config.keepLast, 1)
    assert.deepEqual(engine2.config.excludes, ['dsh-runtimes'], '非法 excludes 保留默认值')
  } finally {
    await engine2.stop()
  }
})

/* ------------------------------------------------------- 统计缓存/state */

test('refreshBlobStats caches for 30s, state() never scans, maxAgeMs:0 forces refresh', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-v3-root-')
  const engine = makeEngine(home, root)
  await engine.start()
  try {
    let scans = 0
    const original = engine.store.stats.bind(engine.store)
    engine.store.stats = async () => { scans += 1; return original() }

    const before = engine.state()
    assert.equal(before.blob, null, '启动后不主动扫盘')
    assert.equal(before.statsAgeMs, null)
    engine.state()
    assert.equal(scans, 0, 'state() 自己不扫盘')

    const first = await engine.refreshBlobStats()
    assert.equal(scans, 1)
    assert.ok(first.count >= 1)
    assert.ok(Number.isFinite(first.at))

    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await engine.refreshBlobStats()
    assert.equal(scans, 1, '30s TTL 内复用缓存')
    assert.equal(second.at, first.at, '缓存命中时 at 不变')

    const state = engine.state()
    assert.equal(state.blob.at, first.at)
    assert.equal(state.blob.count, first.count)
    assert.ok(state.statsAgeMs >= 0 && state.statsAgeMs < 30_000)

    const forced = await engine.refreshBlobStats({ maxAgeMs: 0 })
    assert.equal(scans, 2, 'maxAgeMs:0 强制刷新')
    assert.ok(forced.at >= first.at)
  } finally {
    await engine.stop()
  }
})

test('state exposes version, 300-snapshot cap, new config fields, quarantine/lastRestore defaults', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-v3-root-')
  const engine = makeEngine(home, root)
  await engine.start()
  try {
    const state = engine.state()
    assert.equal(state.version, PKG.version)
    assert.equal(state.snapshotCount, 1)
    assert.equal(state.config.root, path.resolve(root))
    assert.equal(state.config.enabled, true)
    assert.equal(state.config.watch, false)
    assert.equal(state.config.paused, false)
    assert.deepEqual(state.quarantines, [])
    assert.equal(state.lastRestore, null)

    const now = Date.now()
    engine.snapshots = Array.from({ length: 305 }, (_, index) => ({
      id: `fake-${String(index).padStart(3, '0')}`,
      at: now - index * 1000,
      reason: 'auto',
      files: {},
      stats: { files: 0, bytes: 0, changed: 0 },
    }))
    const capped = engine.state()
    assert.equal(capped.snapshots.length, 300, 'snapshots 上限 300')
    assert.equal(capped.snapshotCount, 305)
    assert.equal(capped.snapshots[0].id, 'fake-000')
    assert.equal(capped.snapshots[299].id, 'fake-299')
  } finally {
    await engine.stop()
  }
})

/* ---------------------------------------------------------------- health */

test('state.health: 空闲不误报，调度停摆才 stale，busy 不算健康问题', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-v3-root-')
  // scanMs=60s ⇒ staleAfterMs = max(5min, 3*0, 2*60s) = 5min，便于构造
  const engine = makeEngine(home, root, { scanMs: 60_000 })
  await engine.start()
  try {
    // 测试配置 watch:false 不会真的起 fs.watch；healthy 需要 watching=true
    engine.watching = true
    const fresh = engine.state().health
    assert.equal(fresh.level, 'ok')
    assert.equal(fresh.code, 'healthy')
    assert.ok(Number.isFinite(fresh.lastSnapshotAgeMs))
    assert.ok(engine.lastRunAt > 0, 'startup snapshot 之后 lastRunAt 应已更新')

    // 空闲 10 分钟、没有新快照（调度仍在跑）→ healthy，不再误报“快照偏旧”
    const recentManifest = engine.lastManifest
    engine.lastManifest = { ...recentManifest, at: Date.now() - 10 * 60_000 }
    engine.lastRunAt = Date.now() - 30_000
    let health = engine.state().health
    assert.equal(health.code, 'healthy', '空闲 10 分钟不应报 stale')
    assert.equal(health.level, 'ok')
    assert.ok(engine.state().lastSnapshotAgeMs >= 10 * 60_000 - 1000)

    // 调度停摆：lastRunAt 超过 max(5min, 3*minIntervalMs, 2*scanMs) → stale
    engine.lastRunAt = Date.now() - (5 * 60_000 + 60_000)
    health = engine.state().health
    assert.equal(health.code, 'stale')
    assert.equal(health.level, 'warn')
    assert.match(health.message, /调度已 \d+ 分钟未运行/)
    engine.lastRunAt = Date.now()

    // busy 不再是 health 问题（state.busy 仍然给 UI 用）
    engine.busy = true
    health = engine.state().health
    assert.equal(health.code, 'healthy')
    assert.equal(engine.state().busy, true)
    engine.busy = false

    // 从未有快照 → stale
    engine.lastManifest = null
    health = engine.state().health
    assert.equal(health.code, 'stale')
    assert.match(health.message, /尚无任何快照/)
    engine.lastManifest = recentManifest

    // paused 优先于其它告警
    engine.lastError = '模拟历史错误'
    engine.setPaused(true)
    health = engine.state().health
    assert.equal(health.code, 'paused')
    assert.equal(health.level, 'off')
    engine.setPaused(false)
    engine.lastError = null

    engine.lastError = '模拟错误'
    health = engine.state().health
    assert.equal(health.code, 'last-error')
    assert.equal(health.level, 'error')
    assert.match(health.message, /模拟错误/)
    engine.lastError = null

    engine.watching = false
    health = engine.state().health
    assert.equal(health.code, 'watching-off', 'watcher 不在 ⇒ 轮询模式告警')
    assert.equal(health.level, 'warn')
    engine.watching = true
    assert.equal(engine.state().health.code, 'healthy')
  } finally {
    await engine.stop()
  }

  // enabled=false 单独起一个引擎（否则 start 会拍 startup 快照）
  const home2 = await makeHome()
  const root2 = await tempDir('dbk-v3-root-')
  const disabled = new BackupEngine({
    home: home2,
    config: { root: root2, enabled: false, watch: false, scanMs: 3_600_000 },
    log: () => {},
    hostname: 'test-host',
    snapshotOnStart: false,
  })
  await disabled.start()
  try {
    const health = disabled.state().health
    assert.equal(health.code, 'disabled')
    assert.equal(health.level, 'off')
    assert.equal(disabled.state().enabled, false)
  } finally {
    await disabled.stop()
  }
})

test('successful snapshot clears a transient lastError (watch error self-heals)', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-v3-root-')
  const engine = makeEngine(home, root)
  await engine.start()
  try {
    engine.watching = true
    engine.lastError = 'watch unavailable: 模拟'
    assert.equal(engine.state().health.code, 'last-error')

    // 无变化（skipped unchanged）也算成功的一轮
    const skipped = await engine.snapshot('manual')
    assert.equal(skipped.skipped, true)
    assert.equal(engine.lastError, null, '成功一轮后 lastError 应自愈')
    assert.equal(engine.state().health.code, 'healthy')

    // 有变化的 snapshot 同样清除
    engine.lastError = 'restore: 模拟'
    await fs.writeFile(path.join(home, 'workspace.json'), '{"v":2}')
    const changed = await engine.snapshot('manual')
    assert.ok(changed.id)
    assert.equal(engine.lastError, null)

    // runCycle（调度的一轮）也会清除
    engine.lastError = 'cycle: 模拟'
    await engine.runCycle()
    assert.equal(engine.lastError, null)

    // verify/preview 是只读的：不得改 lastError/lastRunAt
    engine.lastError = '只读期间保留'
    const lastRunBeforeReadOnly = engine.lastRunAt
    await engine.verifySnapshot()
    await engine.previewRestore(engine.latestSnapshotId())
    assert.equal(engine.lastError, '只读期间保留')
    assert.equal(engine.lastRunAt, lastRunBeforeReadOnly, '只读操作不得刷新调度时间')
  } finally {
    await engine.stop()
  }
})

/* ------------------------------------------------------------ 隔离记录 */

test('listQuarantines parses _restore-report.json (newest 20, malformed skipped)', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-v3-root-')
  const engine = makeEngine(home, root)
  await engine.start()
  try {
    const id = engine.state().lastSnapshot.id
    await fs.writeFile(path.join(home, 'workspace.json'), '{"v":999}')
    const restored = await engine.restore(id)

    // 真实恢复产生的那一条
    const list = await engine.listQuarantines()
    assert.equal(list.length, 1)
    const entry = list[0]
    assert.equal(entry.snapshot, id)
    assert.equal(entry.dir, restored.quarantineDir)
    assert.equal(entry.restored, restored.restored)
    assert.equal(entry.quarantined, restored.quarantined)
    assert.equal(entry.failed, 0)
    assert.ok(Number.isFinite(entry.at) && entry.at > 0)

    // restore 内部已刷新缓存，state 直接可见
    assert.equal(engine.state().quarantines.length, 1)
    assert.equal(engine.state().quarantines[0].snapshot, id)

    // 手工造 25 条更新的报告 + 2 个坏目录
    const base = path.join(engine.store.dir, 'restore-quarantine')
    const newerBase = Date.now() + 60_000
    for (let index = 1; index <= 25; index += 1) {
      const dir = path.join(base, `syn-${String(index).padStart(2, '0')}`)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, '_restore-report.json'), JSON.stringify({
        at: newerBase + index * 1000,
        snapshot: `snap-${index}`,
        restored: index,
        unchanged: 0,
        quarantined: 0,
        extraLeft: 0,
        failed: index % 3 === 0 ? [{ rel: 'x', reason: 'boom' }] : [],
      }))
    }
    await fs.mkdir(path.join(base, 'broken-no-report'), { recursive: true })
    const badJson = path.join(base, 'broken-json')
    await fs.mkdir(badJson, { recursive: true })
    await fs.writeFile(path.join(badJson, '_restore-report.json'), '{not json')

    const newest = await engine.listQuarantines()
    assert.equal(newest.length, 20, '最多 20 条')
    assert.equal(newest[0].id, 'syn-25', '时间倒序')
    assert.equal(newest[1].id, 'syn-24')
    assert.equal(newest[19].id, 'syn-06')
    assert.ok(newest.every((item) => path.isAbsolute(item.dir)))
    const withFailure = newest.find((item) => item.id === 'syn-24')
    assert.equal(withFailure.failed, 1, 'failed 报告为数量')
    assert.ok(!newest.some((item) => item.id.startsWith('broken')))

    // 手工写入的记录需要显式强制刷新缓存才能进 state（默认 30s TTL）
    await engine.refreshQuarantines({ maxAgeMs: 0 })
    assert.equal(engine.state().quarantines.length, 20)
    assert.equal(engine.state().quarantines[0].id, 'syn-25')
  } finally {
    await engine.stop()
  }
})

/* ----------------------------------------------------------- lastRestore */

test('lastRestore is remembered in memory after restore and cleared by restart', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-v3-root-')
  const engine = makeEngine(home, root)
  await engine.start()
  try {
    const id = engine.state().lastSnapshot.id
    assert.equal(engine.state().lastRestore, null)
    await fs.writeFile(path.join(home, 'workspace.json'), '{"v":999}')
    const result = await engine.restore(id)
    const summary = engine.state().lastRestore
    assert.ok(summary, 'restore 成功后应有内存摘要')
    assert.deepEqual(Object.keys(summary).sort(), [
      'at', 'extraLeft', 'failed', 'preSnapshot', 'quarantined', 'restored', 'snapshot', 'unchanged',
    ], 'lastRestore 字段与契约一致')
    assert.equal(summary.snapshot, id)
    assert.equal(summary.restored, result.restored)
    assert.equal(summary.quarantined, result.quarantined)
    assert.equal(summary.failed, 0)
    assert.equal(summary.preSnapshot, result.preSnapshot)
    assert.ok(Number.isFinite(summary.at))
  } finally {
    await engine.stop()
  }

  // 重启后内存摘要清空（不落盘）
  const engine2 = makeEngine(home, root)
  await engine2.start()
  try {
    assert.equal(engine2.state().lastRestore, null)
  } finally {
    await engine2.stop()
  }
})
