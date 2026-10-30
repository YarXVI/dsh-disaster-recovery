import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BackupEngine, entryChunks } from '../src/engine.js'

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function makeHome() {
  const home = await tempDir('dbk-home-')
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

test('snapshot skips excluded runtime dirs and dedupes content', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-root-')
  const engine = makeEngine(home, root)
  await engine.start()
  try {
    const state = engine.state()
    assert.equal(state.snapshotCount, 1)
    assert.equal(state.lastSnapshot.files, 2, 'session 文件 + workspace.json；dsh-runtimes 被排除')

    const manifest = await engine.store.readManifest(state.lastSnapshot.id)
    assert.deepEqual(Object.keys(manifest.files).sort(), [
      'sessions/--D-x--/session-1/session.v4.jsonl.zstd',
      'workspace.json',
    ])

    // 没有变化时再快照应跳过
    const again = await engine.snapshot('manual')
    assert.equal(again.skipped, true)

    // 改一个文件 → 只传这一个内容块
    await fs.writeFile(path.join(home, 'workspace.json'), '{"v":2}')
    const second = await engine.snapshot('manual')
    assert.equal(second.changed, 1)
    assert.equal(second.stored, 1)
    assert.equal(engine.state().snapshotCount, 2)
  } finally {
    await engine.stop()
  }
})

test('restore brings content back, quarantines overwritten files, keeps extra files', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-root-')
  const engine = makeEngine(home, root)
  await engine.start()
  try {
    const first = engine.state().lastSnapshot.id
    const target = path.join(home, 'workspace.json')

    // 事故模拟：删掉一个文件、改掉一个文件、新增一个快照里没有的文件
    await fs.writeFile(target, '{"v":999}')
    await fs.rm(path.join(home, 'sessions', '--D-x--', 'session-1', 'session.v4.jsonl.zstd'))
    await fs.writeFile(path.join(home, 'brand-new.txt'), 'created-after-snapshot')

    const result = await engine.restore(first)
    assert.equal(result.ok, true)
    assert.ok(result.restored >= 2, `restored=${result.restored}`)
    assert.equal(await fs.readFile(target, 'utf8'), '{"v":1}')
    assert.equal(
      await fs.readFile(path.join(home, 'sessions', '--D-x--', 'session-1', 'session.v4.jsonl.zstd'), 'utf8'),
      'session-body',
    )
    // 快照里没有的文件保留不动
    assert.equal(await fs.readFile(path.join(home, 'brand-new.txt'), 'utf8'), 'created-after-snapshot')
    assert.ok(result.extraLeft >= 1)
    // 被覆盖的旧内容进了隔离目录
    assert.ok(result.quarantined >= 1)
    const quarantined = await fs.readFile(path.join(result.quarantineDir, 'workspace.json'), 'utf8')
    assert.equal(quarantined, '{"v":999}')
    // 恢复前自动留了 pre-restore 快照
    assert.ok(result.preSnapshot, 'pre-restore snapshot expected')
  } finally {
    await engine.stop()
  }
})

test('restore refuses a snapshot with missing blobs', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-root-')
  const engine = makeEngine(home, root)
  await engine.start()
  try {
    const id = engine.state().lastSnapshot.id
    const manifest = await engine.store.readManifest(id)
    const anyHash = entryChunks(Object.values(manifest.files)[0])[0]
    await fs.rm(engine.store.blobPath(anyHash))
    await assert.rejects(() => engine.restore(id), /缺少 1 个内容块/)
  } finally {
    await engine.stop()
  }
})

test('append-only logs only store their new tail chunk', async () => {
  const home = await tempDir('dbk-home-')
  const root = await tempDir('dbk-root-')
  const log = path.join(home, 'session.v4.jsonl.zstd')
  // 3 个块（1024 B 一块）：前两块在追加后必须保持不变
  await fs.writeFile(log, 'a'.repeat(3000))
  const engine = makeEngine(home, root, { chunkSize: 1024 })
  await engine.start()
  try {
    const first = engine.state().lastSnapshot.id
    const firstManifest = await engine.store.readManifest(first)
    const firstChunks = entryChunks(firstManifest.files['session.v4.jsonl.zstd'])
    assert.equal(firstChunks.length, 3)

    await fs.appendFile(log, 'b'.repeat(50))
    const second = await engine.snapshot('manual')
    assert.equal(second.changed, 1)
    // 只新增尾块：前两个块哈希不变
    const secondManifest = await engine.store.readManifest(second.id)
    const secondChunks = entryChunks(secondManifest.files['session.v4.jsonl.zstd'])
    assert.deepEqual(secondChunks.slice(0, 2), firstChunks.slice(0, 2))
    assert.notEqual(secondChunks[2], firstChunks[2])
    // 真正写入的新块数量应该是 1（尾块）
    assert.equal(second.stored, 1, `expected 1 new chunk, got ${second.stored}`)
  } finally {
    await engine.stop()
  }
})

test('retention keeps the newest snapshots and gc drops orphan blobs', async () => {
  const home = await tempDir('dbk-home-')
  await fs.writeFile(path.join(home, 'counter.txt'), '0')
  const root = await tempDir('dbk-root-')
  const engine = makeEngine(home, root, { keepLast: 3, keepHourlyHours: 0, keepDailyDays: 0 })
  await engine.start()
  try {
    for (let i = 1; i <= 6; i += 1) {
      await fs.writeFile(path.join(home, 'counter.txt'), `value-${i}`)
      await engine.snapshot('manual')
    }
    const state = engine.state()
    assert.equal(state.snapshotCount, 3, `expected 3 snapshots, got ${state.snapshotCount}`)
    // 只有被保留的快照内容还在 blobs 里
    const referenced = new Set()
    for (const snap of engine.snapshots) {
      for (const entry of Object.values(snap.files)) {
        for (const hash of entryChunks(entry)) referenced.add(hash)
      }
    }
    const stats = await engine.store.stats()
    assert.equal(stats.count, referenced.size)
  } finally {
    await engine.stop()
  }
})

test('maxSnapshots caps the total and deletes the oldest first', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-root-')
  const engine = makeEngine(home, root, {
    keepLast: 20, keepHourlyHours: 0, keepDailyDays: 0, maxSnapshots: 5,
  })
  await engine.start()
  try {
    for (let i = 1; i <= 9; i += 1) {
      await fs.writeFile(path.join(home, 'workspace.json'), `{"v":${i}}`)
      await engine.snapshot('manual')
    }
    const state = engine.state()
    assert.equal(state.config.maxSnapshots, 5)
    assert.equal(state.snapshotCount, 5, `expected cap 5, got ${state.snapshotCount}`)
    assert.equal(engine.latestSnapshotId(), state.snapshots[0].id)
    // 保留的一定是最新的 5 个：ids 按时间倒序，且都还有清单文件
    const ids = engine.snapshots.map((snap) => snap.id)
    assert.equal(new Set(ids).size, 5)
    for (const id of ids) {
      const manifest = await engine.store.readManifest(id)
      assert.equal(manifest.id, id)
    }
  } finally {
    await engine.stop()
  }
})

test('lowering maxSnapshots via updateConfig prunes immediately (clamped to >= 5)', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-root-')
  const engine = makeEngine(home, root, {
    keepLast: 20, keepHourlyHours: 0, keepDailyDays: 0, maxSnapshots: 100,
  })
  await engine.start()
  try {
    for (let i = 1; i <= 8; i += 1) {
      await fs.writeFile(path.join(home, 'workspace.json'), `{"step":${i}}`)
      await engine.snapshot('manual')
    }
    assert.ok(engine.state().snapshotCount >= 8)
    const before = engine.snapshots.map((snap) => snap.id)
    const applied = await engine.updateConfig({ maxSnapshots: 5 })
    assert.equal(applied.maxSnapshots, 5)
    const state = engine.state()
    assert.equal(state.snapshotCount, 5, '改小上限后应立即清理到 5 个')
    assert.deepEqual(engine.snapshots.map((snap) => snap.id), before.slice(0, 5))

    // 下限保护：1 会被夹到 5，不能把回滚余地删光
    const clamped = await engine.updateConfig({ maxSnapshots: 1 })
    assert.equal(clamped.maxSnapshots, 5)
    assert.equal(engine.state().snapshotCount, 5)
  } finally {
    await engine.stop()
  }
})

test('latestSnapshotId skips pre-restore snapshots', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-root-')
  const engine = makeEngine(home, root)
  await engine.start()
  try {
    await fs.writeFile(path.join(home, 'workspace.json'), '{"v":2}')
    const good = await engine.snapshot('manual')
    // 再改一次，然后拍一个“事故现场”快照（恢复前自动拍的那种）
    await fs.writeFile(path.join(home, 'workspace.json'), '{"v":3}')
    const bad = await engine.snapshot('pre-restore')
    assert.notEqual(good.id, bad.id)
    assert.equal(engine.snapshots[0].reason, 'pre-restore')
    assert.equal(engine.latestSnapshotId(), good.id, 'pre-restore 不应被当成 latest')
  } finally {
    await engine.stop()
  }
})

test('snapshotOnStart=false leaves the store untouched', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-root-')
  const engine = new BackupEngine({
    home,
    config: { root, watch: false, scanMs: 3_600_000 },
    log: () => {},
    hostname: 'test-host',
    snapshotOnStart: false,
  })
  await engine.start()
  try {
    assert.equal(engine.state().snapshotCount, 0)
    assert.equal(engine.latestSnapshotId(), null)
  } finally {
    await engine.stop()
  }
})

test('state survives restart and resume from disk', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-root-')
  const engine = makeEngine(home, root)
  await engine.start()
  const id = engine.state().lastSnapshot.id
  await engine.stop()

  const engine2 = makeEngine(home, root)
  await engine2.start()
  try {
    const state = engine2.state()
    assert.equal(state.snapshotCount, 1)
    assert.equal(state.lastSnapshot.id, id)
  } finally {
    await engine2.stop()
  }
})
