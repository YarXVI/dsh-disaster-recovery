/**
 * 崩溃监控（src/monitor.js）测试。
 *
 * 全部使用临时 home / 临时备份根目录 / 假 engine：
 *   - 绝不写真实 .dsh，绝不杀真实进程，不联网、不安装计划任务；
 *   - install-external.ps1 的“成功路径”用注入的假 spawn，只断言命令行参数；
 *   - 时间相关逻辑用可控 now，不依赖真实等待（除少数 start/stop 生命周期）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { createMonitorService, MONITOR_VERSION } from '../src/monitor.js'
import { createPanelHandler } from '../src/panel.js'
import { sha256hex } from '../src/util.js'

/* --------------------------------------------------------------- 工具 */

async function tempDir(prefix = 'dbk-mon-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'))
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, String(content))
  }
}

const HOME_FILES = {
  'sessions/--D-x--/s1/session.v4.jsonl.zstd': 'a'.repeat(200),
  'sessions/--D-x--/s2/session.v4.jsonl.zstd': 'b'.repeat(200),
  'sessions/--D-x--/s3/session.v4.jsonl.zstd': 'c'.repeat(200),
  'storages/plugin/a.json': '{"a":1}',
  'storages/plugin/b.json': '{"b":2}',
  'profiles/desktop/package.json': '{"name":"desktop"}',
  'attachments/a1.bin': 'x',
  'attachments/a2.bin': 'y',
  'workspace.json': '{"v":1}',
  '.credentials.yaml': 'secret: yes',
}

async function makeHome(files = HOME_FILES) {
  const home = await tempDir('dbk-mon-home-')
  await writeTree(home, files)
  return home
}

/** 假 engine：只提供 monitor.js 用到的只读面 + restore。 */
function makeFakeEngine({ home, root, hostname = 'test-host', snapshots = [] } = {}) {
  const storeDir = path.join(root, hostname)
  const engine = {
    home,
    hostname,
    version: '0.4.0',
    config: { root, enabled: true, watch: true, paused: false },
    storeDir,
    snapshots: [],
    lastManifest: null,
    busy: false,
    paused: false,
    lastError: null,
    lastRestore: null,
    startedAt: Date.now(),
    restoreCalls: [],
    verifyCalls: [],
    pauseCalls: [],
    pinCalls: [],
    pinned: new Set(),
    setPaused(value) {
      engine.paused = Boolean(value)
      engine.pauseCalls.push(Boolean(value))
      return engine.paused
    },
    pinSnapshot(id) {
      const value = String(id || '')
      if (!value) throw new Error('缺少快照 id')
      engine.pinned.add(value)
      engine.pinCalls.push(value)
      return engine.pinned.size
    },
    unpinSnapshot(id) {
      engine.pinned.delete(String(id || ''))
      return engine.pinned.size
    },
    store: {
      dir: storeDir,
      blobDir: path.join(storeDir, 'blobs'),
      snapDir: path.join(storeDir, 'snapshots'),
      blobPath(hash) {
        const value = String(hash || '')
        if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`bad blob hash: ${value}`)
        return path.join(storeDir, 'blobs', value.slice(0, 2), value.slice(2, 4), value)
      },
      async readManifest(id) {
        const raw = await fs.readFile(path.join(storeDir, 'snapshots', `${id}.json`), 'utf8')
        return JSON.parse(raw)
      },
    },
    state() {
      const last = engine.lastManifest
      return {
        ok: true,
        home: engine.home,
        storeDir,
        snapshotCount: engine.snapshots.length,
        lastSnapshot: last
          ? { id: last.id, at: last.at, files: Object.keys(last.files || {}).length, bytes: 0, reason: last.reason }
          : null,
        lastSnapshotAgeMs: last ? Date.now() - last.at : null,
        lastError: engine.lastError,
        busy: engine.busy,
        blob: null,
      }
    },
    async refreshBlobStats() { return null },
    async restore(id) {
      engine.restoreCalls.push(id)
      return {
        ok: true,
        snapshot: id,
        preSnapshot: `${id}-pre`,
        restored: 3,
        unchanged: 1,
        quarantined: 2,
        extraLeft: 0,
        failed: [],
        quarantineDir: path.join(storeDir, 'restore-quarantine', id),
        needRestart: true,
      }
    },
    async verifySnapshot(id) {
      engine.verifyCalls.push(id)
      return { id, ok: true, files: 1, missingCount: 0 }
    },
  }
  return { engine, storeDir, addSnapshot: (spec) => addSnapshot(engine, spec) }
}

/** 写入一个真实清单 + 真实 blob 文件（体检用）。 */
async function addSnapshot(engine, { id, at, reason = 'auto', files = {}, missing = [] }) {
  const entries = {}
  await fs.mkdir(path.join(engine.storeDir, 'snapshots'), { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const buf = Buffer.from(String(content))
    const hash = sha256hex(buf)
    const abs = path.join(engine.storeDir, 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, buf)
    entries[rel] = { s: buf.length, m: 1000, c: [hash] }
  }
  for (const hash of missing) {
    // 故意只引用不写文件：模拟缺块
    entries[`broken-${hash.slice(0, 6)}`] = { s: 10, m: 1000, c: [hash] }
  }
  const manifest = {
    version: 2,
    id,
    at,
    reason,
    files: entries,
    stats: { files: Object.keys(entries).length, changed: 0, stored: 0, bytes: 0, durationMs: 0 },
  }
  engine.snapshots.push(manifest)
  engine.snapshots.sort((a, b) => (b.at || 0) - (a.at || 0))
  engine.lastManifest = engine.snapshots[0]
  await fs.writeFile(path.join(engine.storeDir, 'snapshots', `${id}.json`), JSON.stringify(manifest))
  return manifest
}

function monitorOptions({ engine, home, root, now, externalDir, installScriptPath, spawnProcess, config, dpapi }) {
  return {
    engine,
    home,
    storeDir: root,
    hostname: engine.hostname,
    version: engine.version,
    logger: () => {},
    now,
    externalDir: externalDir || path.join(root, 'external'),
    installScriptPath,
    spawnProcess,
    config,
    dpapi,
  }
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return fallback }
}

async function listIncidentFiles(monitor) {
  const names = await fs.readdir(monitor.paths.incidentDir).catch(() => [])
  return names.filter((name) => name.endsWith('.json')).sort()
}

function statsSnapshot(overrides = {}) {
  return {
    files: 10, bytes: 500, sessions: 3, storages: 2, profiles: 1, attachments: 2, credentials: true,
    ...overrides,
  }
}

function previousHeartbeat(overrides = {}) {
  return {
    v: 1,
    bootId: 'old-boot',
    pid: 4242,
    startedAt: Date.now() - 7_200_000,
    lastSeen: Date.now() - 600_000,
    cleanExit: true,
    cleanExitAt: Date.now() - 600_000,
    version: '0.4.0',
    host: { name: 'test-host', home: 'C:\\tmp\\home', root: 'D:\\tmp\\root' },
    stats: statsSnapshot(),
    backup: { snapshots: 1, latestId: 's1', latestAt: 0, lastSnapshotAt: 0, lastError: null },
    offsite: { configured: false, locked: true, lastExportAt: 0, lastSyncAt: 0, peerOnline: false, archives: 0 },
    client: { lastSeen: 0 },
    lastAction: null,
    ...overrides,
  }
}

async function seedFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(value, null, 2))
}

/* --------------------------------------------------------------- 测试 */

test('monitor: 心跳格式/原子写 + ping 记录 client.lastSeen + dispose 写 cleanExit', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const { engine } = makeFakeEngine({ home, root })
  await addSnapshot(engine, {
    id: '20261028-100000-manual',
    at: Date.now() - 60_000,
    files: { 'workspace.json': '{"v":1}', 'sessions/--D-x--/s1/log': 'x' },
  })
  const monitor = createMonitorService(monitorOptions({ engine, home, root }))
  try {
    await monitor.start()
    await monitor.flush()

    const heartbeat = await readJson(monitor.paths.heartbeatFile)
    assert.equal(heartbeat.v, MONITOR_VERSION)
    assert.equal(typeof heartbeat.bootId, 'string')
    assert.ok(heartbeat.bootId.length >= 8)
    assert.equal(heartbeat.pid, process.pid)
    assert.ok(heartbeat.lastSeen > 0)
    assert.equal(heartbeat.cleanExit, false)
    assert.equal(heartbeat.cleanExitAt, 0)
    assert.equal(heartbeat.version, '0.4.0')
    assert.equal(heartbeat.host.name, 'test-host')
    assert.equal(heartbeat.host.home, home)
    assert.equal(heartbeat.host.root, root)
    // 轻量统计（不遍历整个 home）
    assert.equal(heartbeat.stats.sessions, 3)
    assert.equal(heartbeat.stats.storages, 2)
    assert.equal(heartbeat.stats.profiles, 1)
    assert.equal(heartbeat.stats.attachments, 2)
    assert.equal(heartbeat.stats.credentials, true)
    assert.equal(heartbeat.stats.files, 2, 'files 来自 engine 最新清单，不扫盘')
    assert.equal(heartbeat.backup.snapshots, 1)
    assert.equal(heartbeat.backup.latestId, '20261028-100000-manual')
    assert.equal(heartbeat.offsite.configured, false)
    assert.equal(heartbeat.offsite.locked, true)
    assert.equal(heartbeat.client.lastSeen, 0)
    assert.equal(heartbeat.lastAction, null)

    // 原子写：目录里不能留 tmp 文件，JSON 必须完整可解析
    const names = await fs.readdir(monitor.paths.monitorDir)
    assert.deepEqual(names.filter((name) => name.endsWith('.tmp')), [])

    const ping = monitor.ping()
    assert.equal(ping.ok, true)
    await monitor.flush()
    const afterPing = await readJson(monitor.paths.heartbeatFile)
    assert.ok(afterPing.client.lastSeen > 0)
    assert.equal(afterPing.client.lastSeen, ping.at)

    monitor.noteAction?.(undefined) // 不存在的内部方法也必须安全（可选链，不抛）
    await monitor.stop()
    const final = await readJson(monitor.paths.heartbeatFile)
    assert.equal(final.cleanExit, true)
    assert.ok(final.cleanExitAt > 0)
    assert.ok(final.lastSeen >= final.startedAt)
  } finally {
    await monitor.stop()
  }
})

test('monitor: 上一份心跳 cleanExit=true 不误报 crash', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const { engine } = makeFakeEngine({ home, root })
  await addSnapshot(engine, { id: 's1', at: Date.now() - 120_000, files: { 'workspace.json': '{}' } })
  const monitor = createMonitorService(monitorOptions({ engine, home, root }))
  try {
    await seedFile(monitor.paths.heartbeatFile, previousHeartbeat({ cleanExit: true }))
    await monitor.start()
    await monitor.flush()
    assert.deepEqual(await listIncidentFiles(monitor), [], '正常退出后重启不得产生事故')
    const alerts = await readJson(monitor.paths.alertsCurrentFile)
    assert.deepEqual(alerts.open, [])
    const current = await readJson(monitor.paths.heartbeatFile)
    assert.equal(current.cleanExit, false)
  } finally {
    await monitor.stop()
  }
})

test('monitor: 心跳断档 >30s 判 crash，估算区间 [lastSeen,lastSeen+5s]，写 incidents/alerts/outbox', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const { engine } = makeFakeEngine({ home, root })
  const lastSeen = Date.now() - 120_000
  await addSnapshot(engine, { id: '20261028-090000-change', at: lastSeen - 60_000, files: { 'workspace.json': '{}' } })
  await addSnapshot(engine, { id: '20261028-091500-change', at: lastSeen - 10_000, files: { 'workspace.json': '{"v":2}' } })
  const monitor = createMonitorService(monitorOptions({ engine, home, root }))
  try {
    await seedFile(monitor.paths.heartbeatFile, previousHeartbeat({ cleanExit: false, lastSeen }))
    await monitor.start()
    await monitor.flush()

    const files = await listIncidentFiles(monitor)
    assert.equal(files.length, 1)
    const incident = await readJson(path.join(monitor.paths.incidentDir, files[0]))
    assert.equal(incident.kind, 'crash')
    assert.equal(incident.status, 'open')
    assert.equal(incident.source, 'monitor')
    assert.equal(incident.severity, 'high')
    assert.equal(incident.firstAt, lastSeen, '事故区间从最后一次心跳开始')
    assert.match(incident.summary, /异常退出/)
    assert.equal(incident.evidence.heartbeat.lastSeen, lastSeen)
    assert.ok(incident.evidence.heartbeat.gapMs >= 118_000)
    assert.deepEqual(incident.evidence.heartbeat.window, { from: lastSeen, to: lastSeen + 5000 })
    assert.ok(incident.timeline.some((item) => item.type === 'last-heartbeat'))
    assert.ok(incident.timeline.some((item) => item.type === 'restart'))
    assert.ok(incident.recommendation, '应给出崩溃前推荐恢复点')
    assert.ok(incident.recommendation.at <= lastSeen)
    assert.equal(incident.recommendation.verified, true)

    const alerts = await readJson(monitor.paths.alertsCurrentFile)
    assert.equal(alerts.open.length, 1)
    assert.equal(alerts.open[0].id, incident.id)
    assert.equal(alerts.open[0].source, 'monitor')
    assert.deepEqual(alerts.incidents, alerts.open, '与看门狗双键兼容')
    assert.equal(alerts.count, 1)
    assert.equal(alerts.last.id, incident.id)

    const outbox = await readJson(path.join(monitor.paths.outboxDir, `${incident.id}.json`))
    assert.equal(outbox.status, 'pending')
    assert.equal(outbox.incidentId, incident.id)
    assert.equal(outbox.payload.incident.kind, 'crash')
    assert.ok(outbox.channels.qq && outbox.channels.qq.status === 'pending')

    // 面板摘要能看到未关闭事故 + 推荐恢复点
    const state = await monitor.state({ fresh: true })
    assert.equal(state.incidents.openCount, 1)
    assert.equal(state.incidents.open[0].id, incident.id)
    assert.equal(state.recommendation.snapshotId, incident.recommendation.snapshotId)
    assert.equal(state.heartbeat.at, state.heartbeat.at)
    assert.ok(state.heartbeat.ageMs >= 0)
  } finally {
    await monitor.stop()
  }
})

test('monitor: stats 骤降（>max(50,5%) 且 sessions 减少）判 data-loss，推荐骤降前快照', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const { engine } = makeFakeEngine({ home, root })
  const lastSeen = Date.now() - 180_000
  // 当前只有 20 个文件（骤降后），但 sessions 目录还在（只是少了 2 个）
  await fs.rm(path.join(home, 'sessions', '--D-x--', 's1'), { recursive: true, force: true })
  await fs.rm(path.join(home, 'sessions', '--D-x--', 's2'), { recursive: true, force: true })
  const files = {}
  for (let i = 0; i < 20; i += 1) files[`files/f${i}.txt`] = `content-${i}`
  await addSnapshot(engine, { id: '20261028-080000-change', at: lastSeen - 120_000, files })
  const before = statsSnapshot({ files: 220, sessions: 3, storages: 2, profiles: 1, attachments: 2 })
  const monitor = createMonitorService(monitorOptions({ engine, home, root }))
  try {
    await seedFile(monitor.paths.heartbeatFile, previousHeartbeat({ cleanExit: false, lastSeen, stats: before }))
    await seedFile(monitor.paths.baselineFile, { v: 1, at: lastSeen - 3_600_000, source: 'monitor', stats: before })
    await monitor.start()
    await monitor.flush()

    const filesInDir = await listIncidentFiles(monitor)
    const kinds = []
    for (const name of filesInDir) kinds.push((await readJson(path.join(monitor.paths.incidentDir, name))).kind)
    assert.ok(kinds.includes('data-loss'), `应产生 data-loss 事故，实际：${kinds.join(',')}`)
    const incident = (await readJson(path.join(monitor.paths.incidentDir, filesInDir[kinds.indexOf('data-loss')])))
    assert.equal(incident.kind, 'data-loss')
    assert.equal(incident.severity, 'high')
    assert.equal(incident.evidence.data.before.files, 220)
    assert.equal(incident.evidence.data.after.files, 20)
    assert.ok(incident.timeline.some((item) => item.type === 'data-drop'))
    assert.ok(incident.recommendation, '应给出骤降前推荐恢复点')
    assert.equal(incident.recommendation.snapshotId, '20261028-080000-change')
    // 有 open 的 data-loss 时 baseline 不得被更新
    const baseline = await readJson(monitor.paths.baselineFile)
    assert.equal(baseline.at, lastSeen - 3_600_000)
  } finally {
    await monitor.stop()
  }
})

test('monitor: 同 kind 30 分钟内合并 timeline（第二次不新增事故文件）', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const { engine } = makeFakeEngine({ home, root })
  await addSnapshot(engine, { id: 's1', at: Date.now() - 300_000, files: { 'workspace.json': '{}' } })
  const monitor = createMonitorService(monitorOptions({ engine, home, root }))
  try {
    await seedFile(monitor.paths.heartbeatFile, previousHeartbeat({ cleanExit: false, lastSeen: Date.now() - 120_000 }))
    await monitor.start()
    await monitor.flush()
    const first = await listIncidentFiles(monitor)
    assert.equal(first.length, 1)
    const firstIncident = await readJson(path.join(monitor.paths.incidentDir, first[0]))
    assert.equal(firstIncident.timeline.length, 2)
    await monitor.stop()

    // 30 分钟内再次异常退出：合并到同一份事故
    await seedFile(monitor.paths.heartbeatFile, previousHeartbeat({ cleanExit: false, lastSeen: Date.now() - 60_000 }))
    const monitor2 = createMonitorService(monitorOptions({ engine, home, root }))
    try {
      await monitor2.start()
      await monitor2.flush()
      const files = await listIncidentFiles(monitor2)
      assert.equal(files.length, 1, '同 kind 30 分钟内不重复建事故')
      const merged = await readJson(path.join(monitor2.paths.incidentDir, files[0]))
      assert.equal(merged.id, firstIncident.id)
      assert.ok(merged.timeline.length >= 4)
      assert.ok(Array.isArray(merged.merges) && merged.merges.length >= 1)
      assert.ok(merged.lastAt >= firstIncident.lastAt)
    } finally {
      await monitor2.stop()
    }
  } finally {
    await monitor.stop()
  }
})

test('monitor: ack 写 ack.json/状态 acknowledged；恢复联动走 engine.restore 并标 recovered', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const { engine } = makeFakeEngine({ home, root })
  const lastSeen = Date.now() - 120_000
  await addSnapshot(engine, { id: '20261028-070000-change', at: lastSeen - 30_000, files: { 'workspace.json': '{}' } })
  await addSnapshot(engine, { id: '20261028-073000-change', at: lastSeen - 10_000, files: { 'workspace.json': '{"v":2}' } })
  // 第一份快照故意缺块（不应被推荐）
  await addSnapshot(engine, { id: '20261028-074000-bad', at: lastSeen - 5_000, files: {}, missing: ['f'.repeat(64)] })
  const monitor = createMonitorService(monitorOptions({ engine, home, root }))
  try {
    await seedFile(monitor.paths.heartbeatFile, previousHeartbeat({ cleanExit: false, lastSeen }))
    await monitor.start()
    await monitor.flush()
    const incidents = await listIncidentFiles(monitor)
    const crash = await readJson(path.join(monitor.paths.incidentDir, incidents[0]))
    assert.equal(crash.recommendation.snapshotId, '20261028-073000-change', '缺块快照不得被推荐')

    const ack = await monitor.ack(crash.id)
    assert.equal(ack.status, 'acknowledged')
    const acked = await readJson(monitor.paths.alertsAckFile)
    assert.ok(acked.acked[crash.id] > 0)
    let alerts = await readJson(monitor.paths.alertsCurrentFile)
    assert.deepEqual(alerts.open, [], '忽略后不再显示为 open')
    const afterAck = await readJson(path.join(monitor.paths.incidentDir, `${crash.id}.json`))
    assert.equal(afterAck.status, 'acknowledged')

    // 停掉第一实例（否则它的 5s 心跳会覆盖种下的“上一份心跳”）
    await monitor.stop()

    // 重新开一条事故（重启后检测）→ monitor-restore 默认用 recommendation
    await seedFile(monitor.paths.heartbeatFile, previousHeartbeat({ cleanExit: false, lastSeen: Date.now() - 90_000 }))
    const monitor2 = createMonitorService(monitorOptions({ engine, home, root }))
    try {
      await monitor2.start()
      await monitor2.flush()
      const openState = await monitor2.state({ fresh: true })
      const openIncident = openState.incidents.open.find((item) => item.source === 'monitor')
      assert.ok(openIncident, '重启后应再次产生未关闭事故（上一次已 ack）')
      assert.equal(openIncident.status, 'open')
      const outcome = await monitor2.restoreFromIncident({})
      assert.equal(outcome.needRestart, true)
      assert.equal(engine.restoreCalls.length, 1)
      assert.equal(engine.restoreCalls[0], openIncident.recommendation.snapshotId)
      assert.equal(outcome.incident.status, 'recovered')
      assert.equal(outcome.incident.recovery.status, 'restored')
      assert.equal(outcome.incident.recovery.report.restored, 3)
      alerts = await readJson(monitor2.paths.alertsCurrentFile)
      assert.deepEqual(alerts.open, [], '恢复后事故不再 open')
      const recovered = await readJson(path.join(monitor2.paths.incidentDir, `${outcome.incident.id}.json`))
      assert.equal(recovered.status, 'recovered')
      assert.ok(recovered.recoveredAt > 0)
      assert.ok(recovered.timeline.some((item) => item.type === 'recovered'))

      // 已处理的事故不能再恢复；没有事故时也不能凭空恢复
      await assert.rejects(() => monitor2.restoreFromIncident({ incidentId: openIncident.id }), /已处理/)
      await assert.rejects(() => monitor2.restoreFromIncident({}), (error) => error.code === 'no-recommendation')
    } finally {
      await monitor2.stop()
    }
  } finally {
    await monitor.stop()
  }
})

test('monitor: 体检只读——本地全部快照缺块 + 异地文件级检查，不解锁不扫 home 内容', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const { engine } = makeFakeEngine({ home, root })
  await addSnapshot(engine, { id: 'ok-1', at: Date.now() - 300_000, files: { 'workspace.json': '{"v":1}' } })
  await addSnapshot(engine, { id: 'bad-1', at: Date.now() - 200_000, files: { 'workspace.json': '{"v":2}' }, missing: ['a'.repeat(64)] })
  const offsiteDir = path.join(root, 'test-host', 'offsite')
  await fs.mkdir(path.join(offsiteDir, 'repo', 'manifests'), { recursive: true })
  await fs.writeFile(path.join(offsiteDir, 'repo', 'manifests', 'm1.mbin'), 'ciphertext')
  const offsite = {
    paths: { repo: path.join(offsiteDir, 'repo'), packs: path.join(offsiteDir, 'packs.json') },
    ledger: { archives: [{ snapshotId: 'ok-1', manifestName: 'manifests/m1.mbin', at: Date.now() }] },
  }
  const monitor = createMonitorService({
    ...monitorOptions({ engine, home, root }),
    getOffsite: () => offsite,
  })
  try {
    const verify = await monitor.verifyImpact()
    assert.equal(verify.local.available, true)
    assert.equal(verify.local.checked, 2)
    assert.equal(verify.local.badCount, 1)
    assert.equal(verify.local.bad[0].id, 'bad-1')
    assert.ok(verify.local.snapshots.find((item) => item.id === 'bad-1').status === 'missing-blobs')
    assert.equal(verify.offsite.available, true)
    assert.equal(verify.offsite.checked, 1)
    assert.equal(verify.offsite.badCount, 0)
    assert.equal(verify.ok, false)
    // 只读：不得产生隔离目录 / 不得改快照
    await assert.rejects(() => fs.stat(path.join(engine.storeDir, 'restore-quarantine')), /ENOENT/)
    assert.equal(engine.restoreCalls.length, 0)
    const cached = await readJson(monitor.paths.verifyFile)
    assert.equal(cached.local.badCount, 1)
    const state = await monitor.state({ fresh: true })
    assert.equal(state.verify.local.badCount, 1)
  } finally {
    await monitor.stop()
  }
})

test('monitor: install-external.ps1 缺失时返回明确错误（不抛异常）；成功路径命令行参数正确', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const { engine } = makeFakeEngine({ home, root })
  const missing = path.join(root, 'nope', 'install-external.ps1')
  const broken = createMonitorService(monitorOptions({ engine, home, root, installScriptPath: missing }))
  const result = await broken.installExternal({ apply: true })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'installer-missing')
  assert.match(result.error.message, /install-external\.ps1/)

  const script = path.join(root, 'scripts', 'install-external.ps1')
  await fs.mkdir(path.dirname(script), { recursive: true })
  await fs.writeFile(script, '# fake installer\n')
  const calls = []
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    setImmediate(() => {
      child.emit('spawn')
      child.stdout.emit('data', Buffer.from(`${JSON.stringify({
        ok: true,
        mode: 'apply',
        recoveryHome: 'C:\\Users\\x\\AppData\\Local\\DeepSeek Recovery',
        copied: 12,
        task: 'DSH-DisasterWatchdog',
        shortcuts: ['desktop'],
        backup: null,
        warnings: [],
        errors: [],
      })}\n`))
      child.emit('close', 0)
    })
    return child
  }
  const monitor = createMonitorService(monitorOptions({
    engine, home, root, installScriptPath: script, spawnProcess,
  }))
  try {
    const install = await monitor.installExternal({ apply: true })
    assert.equal(install.ok, true)
    assert.equal(install.task, 'DSH-DisasterWatchdog')
    assert.equal(install.copied, 12)
    assert.match(install.recoveryHome, /DeepSeek Recovery/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, 'pwsh')
    assert.deepEqual(calls[0].args, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Apply', '-Quiet'])
    assert.equal(path.basename(calls[0].options.cwd), 'dsh-disaster-recovery')
    // 并发第二次安装 → busy 错误（不抛未捕获异常）
    const first = monitor.installExternal({ apply: false })
    const second = monitor.installExternal({ apply: false })
    const [a, b] = await Promise.allSettled([first, second])
    const busy = [a, b].find((item) => item.status === 'rejected')
    assert.ok(busy, '并发安装必须至少一个被 busy 拒绝')
    assert.equal(busy.reason.code, 'busy')
  } finally {
    await monitor.stop()
  }
})

test('monitor: 并发/异常不抛出——start/stop 幂等、心跳写失败只记日志、state 永不抛', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const { engine } = makeFakeEngine({ home, root })
  const monitor = createMonitorService(monitorOptions({
    engine, home, root, installScriptPath: path.join(root, 'missing-installer.ps1'),
  }))
  try {
    const before = await monitor.state({ fresh: true })
    assert.equal(before.ok, true)
    assert.equal(before.running, false)
    assert.equal(monitor.ping().ok, true, '未 start 也能 ping（记录在内存）')
    await Promise.all([monitor.start(), monitor.start(), monitor.state(), monitor.verifyImpact()])
    await Promise.allSettled([
      monitor.ack('no-such-incident'),
      monitor.restoreFromIncident({}),
      monitor.installExternal({ apply: false }),
    ])
    await Promise.all([monitor.stop(), monitor.stop()])
    await assert.doesNotReject(() => monitor.stop())
    await monitor.flush()
  } finally {
    await monitor.stop()
  }

  // 写盘失败（storeDir 指向一个普通文件）→ start/flush 不抛异常，只记日志
  const blockedFile = path.join(await tempDir('dbk-mon-block-'), 'blocked')
  await fs.writeFile(blockedFile, 'not a dir')
  const { engine: engine2 } = makeFakeEngine({ home, root: blockedFile })
  const logs = []
  const monitor2 = createMonitorService({
    ...monitorOptions({ engine: engine2, home, root: blockedFile }),
    logger: (message) => logs.push(message),
  })
  await assert.doesNotReject(() => monitor2.start())
  await assert.doesNotReject(() => monitor2.flush())
  const state = await monitor2.state({ fresh: true })
  assert.equal(state.ok, true)
  await monitor2.stop()
  assert.ok(logs.length > 0, '写失败必须留下日志')
})

test('monitor: 运行期 stats 骤降（60s 宽限期后）也会产生 data-loss 事故', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const { engine } = makeFakeEngine({ home, root })
  const clock = { value: 1_700_000_000_000 }
  const monitor = createMonitorService(monitorOptions({ engine, home, root, now: () => clock.value }))
  try {
    await monitor.start()
    await monitor.flush()
    assert.ok(monitor.stats.sessions >= 3)
    // 宽限期内不判
    await fs.rm(path.join(home, 'storages'), { recursive: true, force: true })
    clock.value += 30_000
    await monitor.refreshStats({ detect: true })
    assert.deepEqual(await listIncidentFiles(monitor), [])
    // 超过 60s 宽限期后：sessions 骤降（删掉两个会话目录）
    await fs.rm(path.join(home, 'sessions', '--D-x--'), { recursive: true, force: true })
    clock.value += 40_000
    await monitor.refreshStats({ detect: true })
    const files = await listIncidentFiles(monitor)
    const kinds = []
    for (const name of files) kinds.push((await readJson(path.join(monitor.paths.incidentDir, name))).kind)
    assert.ok(kinds.includes('data-loss'), `运行期应检测到数据骤降，实际：${kinds.join(',')}`)
    const incident = await readJson(path.join(
      monitor.paths.incidentDir,
      files[kinds.indexOf('data-loss')],
    ))
    assert.ok(incident.timeline.some((item) => item.type === 'data-drop-detected'))
  } finally {
    await monitor.stop()
  }
})

test('monitor: alerts/current.json 写回保留 watchdog 条目/未知顶层键；ack 对 watchdog 事故也生效', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const { engine } = makeFakeEngine({ home, root })
  await addSnapshot(engine, { id: 's1', at: Date.now() - 400_000, files: { 'workspace.json': '{}' } })
  const monitor = createMonitorService(monitorOptions({ engine, home, root }))
  const watchdogIncident = {
    id: '20261028-060000-hang',
    kind: 'hang',
    severity: 'medium',
    status: 'open',
    detectedAt: Date.now() - 60_000,
    firstAt: Date.now() - 60_000,
    lastAt: Date.now() - 60_000,
    summary: 'Host 无响应（看门狗）',
    source: 'watchdog',
    recommendation: null,
  }
  try {
    await seedFile(monitor.paths.alertsCurrentFile, {
      v: 1,
      source: 'watchdog',
      customKey: 'keep-me',
      watchdog: { lastRunAt: Date.now() - 30_000, ok: true },
      open: [watchdogIncident],
      incidents: [watchdogIncident],
      last: watchdogIncident,
    })
    await seedFile(monitor.paths.heartbeatFile, previousHeartbeat({ cleanExit: false, lastSeen: Date.now() - 120_000 }))
    await monitor.start()
    await monitor.flush()
    let alerts = await readJson(monitor.paths.alertsCurrentFile)
    assert.equal(alerts.customKey, 'keep-me', '未知顶层键必须保留')
    assert.ok(alerts.watchdog && alerts.watchdog.ok === true)
    assert.ok(alerts.open.some((item) => item.id === watchdogIncident.id), 'watchdog 条目必须保留')
    const state = await monitor.state({ fresh: true })
    assert.ok(state.incidents.open.some((item) => item.id === watchdogIncident.id))

    // 忽略 watchdog 事故：写 ack.json，并从 open 列表移除（不改看门狗事故文件）
    await monitor.ack(watchdogIncident.id)
    alerts = await readJson(monitor.paths.alertsCurrentFile)
    assert.ok(!alerts.open.some((item) => item.id === watchdogIncident.id))
    const acked = await readJson(monitor.paths.alertsAckFile)
    assert.ok(acked.acked[watchdogIncident.id] > 0)
  } finally {
    await monitor.stop()
  }
})

test('monitor: state 摘要包含 watchdog/通知通道/心跳年龄/open incidents/推荐点（未安装时降级）', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const externalDir = path.join(root, 'external')
  const { engine } = makeFakeEngine({ home, root })
  await addSnapshot(engine, { id: 's1', at: Date.now() - 60_000, files: { 'workspace.json': '{}' } })
  // 外部目录：只有 watchdog.mjs（已安装）+ config.json + state.json
  await fs.mkdir(path.join(externalDir, 'monitor'), { recursive: true })
  await fs.mkdir(path.join(externalDir, 'scripts'), { recursive: true })
  await fs.writeFile(path.join(externalDir, 'monitor', 'watchdog.mjs'), '// watchdog\n')
  await fs.writeFile(path.join(externalDir, 'scripts', 'recovery-console.ps1'), '# console\n')
  await seedFile(path.join(externalDir, 'monitor', 'config.json'), {
    notify: {
      panel: true,
      toast: true,
      webhook: [{ name: 'primary', url: 'https://example.invalid/hook', enabled: true }],
      email: { enabled: false },
      qq: { enabled: false, http: 'http://127.0.0.1:3000' },
      peer: { enabled: true },
    },
  })
  await seedFile(path.join(externalDir, 'monitor', 'state.json'), { lastCheckAt: Date.now() - 20_000, ok: true, pid: 1 })
  const monitor = createMonitorService(monitorOptions({ engine, home, root, externalDir }))
  try {
    await monitor.start()
    await monitor.flush()
    const state = await monitor.state({ fresh: true })
    assert.equal(state.watchdog.installed, true)
    assert.equal(state.watchdog.status, 'ok')
    assert.equal(state.watchdog.taskName, 'DSH-DisasterWatchdog')
    assert.ok(state.watchdog.lastCheckAt > 0)
    assert.equal(state.external.recoveryConsole, true)
    assert.equal(state.notify.source, 'external')
    const channel = (id) => state.notify.channels.find((item) => item.id === id)
    assert.equal(channel('panel').configured, true)
    assert.equal(channel('toast').configured, true)
    assert.equal(channel('webhook').configured, true)
    assert.equal(channel('email').configured, false)
    assert.equal(channel('qq').configured, false)
    assert.equal(channel('peer').configured, true)
    assert.ok(state.heartbeat.ageMs != null && state.heartbeat.ageMs >= 0)
    assert.ok(state.incidents && Array.isArray(state.incidents.open))
    assert.ok(state.baseline && state.baseline.at > 0, '健康的首次启动会写 baseline')

    // 去掉外部目录 → 降级但不抛
    await extraRemoveAll(externalDir)
    const degraded = createMonitorService({
      ...monitorOptions({ engine, home, root, externalDir }),
    })
    const degradedState = await degraded.state({ fresh: true })
    assert.equal(degradedState.watchdog.installed, false)
    assert.equal(degradedState.notify.source, 'none')
    assert.equal(degradedState.notify.channels.find((item) => item.id === 'toast').configured, null)
    await degraded.stop()
  } finally {
    await monitor.stop()
  }
})

async function extraRemoveAll(dir) {
  await fs.rm(dir, { recursive: true, force: true })
}

/* ------------------------------------------------------- 面板动作契约 */

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

test('panel: 旧 Host（没有 getMonitor）不暴露 monitor 字段，monitor-* 明确返回 monitor-unavailable', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const { engine } = makeFakeEngine({ home, root })
  const handler = createPanelHandler({ getEngine: () => engine, getStartError: () => null, log: () => {} })
  const state = await call(handler, 'GET')
  assert.equal(state.status, 200)
  assert.equal('monitor' in state.json.state, false)
  const action = await call(handler, 'POST', { action: 'monitor-state' })
  assert.equal(action.status, 400)
  assert.equal(action.json.ok, false)
  assert.equal(action.json.error.code, 'monitor-unavailable')
})

test('panel: monitor-state/ping/ack/verify/install/restore 契约（错误 {ok:false,error:{code,message}}）', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const { engine } = makeFakeEngine({ home, root })
  const lastSeen = Date.now() - 120_000
  await addSnapshot(engine, { id: '20261028-050000-change', at: lastSeen - 20_000, files: { 'workspace.json': '{}' } })
  const missingInstaller = path.join(root, 'missing', 'install-external.ps1')
  const monitor = createMonitorService(monitorOptions({
    engine, home, root, installScriptPath: missingInstaller,
  }))
  await seedFile(monitor.paths.heartbeatFile, previousHeartbeat({ cleanExit: false, lastSeen }))
  await monitor.start()
  await monitor.flush()
  try {
    const handler = createPanelHandler({
      getEngine: () => engine,
      getStartError: () => null,
      getOffsite: () => null,
      getMonitor: () => monitor,
      log: () => {},
    })

    const state = await call(handler, 'GET')
    assert.equal(state.status, 200)
    assert.ok(state.json.state.monitor, 'state 必须带 monitor 摘要')
    const incident = state.json.state.monitor.incidents.open[0]
    assert.equal(incident.kind, 'crash')

    const ping = await call(handler, 'POST', { action: 'monitor-ping' })
    assert.equal(ping.status, 200)
    assert.equal(ping.json.ping.ok, true)

    const verify = await call(handler, 'POST', { action: 'monitor-verify' })
    assert.equal(verify.status, 200)
    assert.equal(verify.json.verify.local.checked, 1)
    assert.ok(verify.json.monitor.verify)

    const install = await call(handler, 'POST', { action: 'monitor-install', apply: true })
    assert.equal(install.status, 400)
    assert.equal(install.json.ok, false)
    assert.equal(install.json.error.code, 'installer-missing')
    assert.ok(install.json.install, '失败时也带回安装器输出（便于面板展示）')

    const badAck = await call(handler, 'POST', { action: 'monitor-ack' })
    assert.equal(badAck.status, 400)
    assert.equal(badAck.json.error.code, 'bad-request')

    const ack = await call(handler, 'POST', { action: 'monitor-ack', id: incident.id })
    assert.equal(ack.status, 200)
    assert.equal(ack.json.incident.status, 'acknowledged')
    const afterAck = await call(handler, 'POST', { action: 'monitor-state', fresh: true })
    assert.equal(afterAck.json.monitor.incidents.openCount, 0)

    // 停掉第一实例，避免它的心跳覆盖种下的“上一份心跳”
    await monitor.stop()

    // 开一条新事故后走 monitor-restore
    await seedFile(monitor.paths.heartbeatFile, previousHeartbeat({ cleanExit: false, lastSeen: Date.now() - 90_000 }))
    const monitor2 = createMonitorService(monitorOptions({ engine, home, root, installScriptPath: missingInstaller }))
    await monitor2.start()
    await monitor2.flush()
    try {
      const handler2 = createPanelHandler({
        getEngine: () => engine,
        getStartError: () => null,
        getMonitor: () => monitor2,
        log: () => {},
      })
      const restore = await call(handler2, 'POST', { action: 'monitor-restore' })
      assert.equal(restore.status, 200)
      assert.equal(restore.json.needRestart, true)
      assert.equal(restore.json.incident.status, 'recovered')
      assert.equal(engine.restoreCalls.length, 1)
      const stateAfter = await call(handler2, 'POST', { action: 'monitor-state', fresh: true })
      assert.equal(stateAfter.json.monitor.incidents.openCount, 0)
    } finally {
      await monitor2.stop()
    }
  } finally {
    await monitor.stop()
  }
})

/* ------------------------------------------------ 子机通知补发（peer outbox） */

function makeFakeSync({ peers = [], onRpc } = {}) {
  const calls = []
  return {
    calls,
    peers: () => peers,
    async rpc(deviceId, op, payload, options) {
      calls.push({ deviceId, op, payload, options })
      if (typeof onRpc === 'function') return onRpc(deviceId, op, payload, calls.length)
      // 与 dsh-sync 的 ext.dr.notify 返回结构一致（deliveredAt 是 ISO 字符串）
      return { ok: true, deliveredAt: new Date().toISOString(), stored: 'notification.json' }
    },
  }
}

function makeFakeOffsite(overrides = {}) {
  return {
    summary: () => ({
      available: true,
      enabled: true,
      initialized: true,
      locked: false,
      lastExportAt: 0,
      lastSyncAt: 0,
      archives: 0,
      peer: null,
    }),
    config: { peerDeviceId: '' },
    ...overrides,
  }
}

function peerOutboxEntry(overrides = {}) {
  const incidentId = overrides.incidentId || '20261028-160000-crash'
  return {
    v: 1,
    incidentId,
    kind: 'crash',
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
    status: 'pending',
    channels: {
      panel: { status: 'sent', attempts: 0, lastError: null },
      toast: { status: 'sent', attempts: 1, lastError: null },
      webhook: { status: 'sent', attempts: 1, lastError: null },
      email: { status: 'pending', attempts: 0, lastError: null },
      qq: { status: 'pending', attempts: 0, lastError: null },
      peer: { status: 'pending', attempts: 0, lastError: null },
    },
    peerPending: true,
    payload: {
      title: 'DSH crash',
      body: 'DSH 于 15:58 异常退出，推荐恢复到 20261028-155000-change',
      host: 'test-host',
      incident: {
        id: incidentId,
        kind: 'crash',
        severity: 'high',
        detectedAt: Date.now() - 120_000,
        summary: 'DSH 异常退出（未写 cleanExit）',
        recommendation: { snapshotId: '20261028-155000-change', at: Date.now() - 180_000, verified: true },
      },
    },
    ...overrides,
  }
}

async function writePeerOutboxEntry(monitor, entry) {
  const file = path.join(monitor.paths.outboxDir, `${entry.incidentId || entry.id}.json`)
  await seedFile(file, entry)
  return file
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
}

async function peerMonitor({ home, root, getSync, getOffsite = makeFakeOffsite(), externalDir, config }) {
  return createMonitorService({
    ...monitorOptions({ engine: makeFakeEngine({ home, root }).engine, home, root, externalDir, config }),
    getSync,
    getOffsite: () => getOffsite,
  })
}

test('peer: 成功补发 → channels.peer=sent + 清 peerPending，payload 只含白名单摘要', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const sync = makeFakeSync({ peers: [{ deviceId: 'peer-1', online: true, trusted: true, name: '子机' }] })
  const offsite = makeFakeOffsite({
    peerSnapshot: () => ({ sync: true, id: 'peer-1', name: '子机', online: true, trusted: true, reason: 'ok' }),
  })
  const monitor = await peerMonitor({ home, root, getSync: () => sync, getOffsite: offsite })
  try {
    const file = await writePeerOutboxEntry(monitor, peerOutboxEntry())
    const result = await monitor.flushPeerOutbox()
    assert.equal(result.sent, 1)
    assert.equal(result.failed, 0)
    assert.equal(result.deviceId, 'peer-1')

    const entry = await readJson(file)
    assert.equal(entry.channels.peer.status, 'sent')
    assert.ok(entry.channels.peer.sentAt > 0)
    assert.ok(entry.channels.peer.deliveredAt > 0)
    assert.equal(entry.channels.peer.attempts, 1)
    assert.ok(entry.channels.peer.deliveredAt > 0, 'ISO deliveredAt 要转成毫秒时间戳')
    assert.equal(entry.channels.peer.stored, 'notification.json')
    assert.equal('peerPending' in entry, false, '成功后清 peerPending')
    assert.equal(entry.channels.panel.status, 'sent', '其它通道字段必须原样保留')
    assert.equal(entry.channels.webhook.attempts, 1)
    assert.equal(entry.payload.incident.id, '20261028-160000-crash')

    assert.equal(sync.calls.length, 1)
    const call = sync.calls[0]
    assert.equal(call.deviceId, 'peer-1')
    assert.equal(call.op, 'ext.dr.notify')
    assert.deepEqual(Object.keys(call.payload).sort(), ['body', 'host', 'incident', 'sentAt', 'title'])
    assert.deepEqual(Object.keys(call.payload.incident).sort(), ['detectedAt', 'id', 'kind', 'recommendation', 'severity'])
    // dsh-sync 的 sanitizeNotification：recommendation 必须是展示字符串（对象会被 String 成 [object Object]）
    assert.equal(typeof call.payload.incident.recommendation, 'string')
    assert.match(call.payload.incident.recommendation, /20261028-155000-change/)
    assert.match(call.payload.incident.recommendation, /verified/)
    // 对齐 dsh-sync 的校验：title 非空、id 合法、detectedAt 正数、sentAt 毫秒
    assert.ok(call.payload.title.trim().length > 0)
    assert.match(call.payload.incident.id, /^[0-9A-Za-z][0-9A-Za-z._-]{0,119}$/)
    assert.ok(call.payload.incident.detectedAt > 0)
    assert.equal(typeof call.payload.sentAt, 'number')
    // 通知正文/字段不得包含本机路径或文件内容
    const wire = JSON.stringify(call.payload)
    for (const needle of ['C:\\\\', '.dsh', 'sessions', 'storages', 'workspace.json', 'credentials']) {
      assert.equal(wire.includes(needle), false, `payload 不得泄漏：${needle}`)
    }
  } finally {
    await monitor.stop()
  }
})

test('peer: RPC 失败保留 pending + lastError + 重试计数，绝不标 failed', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const sync = makeFakeSync({
    peers: [{ deviceId: 'peer-1', online: true, trusted: true }],
    onRpc: async () => { throw Object.assign(new Error('unknown-op: ext.dr.notify'), { code: 'unknown-op' }) },
  })
  const monitor = await peerMonitor({ home, root, getSync: () => sync })
  try {
    const file = await writePeerOutboxEntry(monitor, peerOutboxEntry())
    const first = await monitor.flushPeerOutbox()
    assert.equal(first.failed, 1)
    let entry = await readJson(file)
    assert.equal(entry.channels.peer.status, 'pending')
    assert.equal(entry.channels.peer.attempts, 1)
    assert.equal(entry.channels.peer.lastError.code, 'unknown-op')
    assert.equal(entry.peerPending, true)

    const second = await monitor.flushPeerOutbox()
    assert.equal(second.failed, 1)
    entry = await readJson(file)
    assert.equal(entry.channels.peer.attempts, 2, '每次失败累计 attempts')
    assert.notEqual(entry.channels.peer.status, 'failed')
    assert.equal(sync.calls.length, 2)

    // 子机返回 {ok:false} 也算失败，保留 pending
    const root2 = await tempDir('dbk-mon-root-')
    const sync2 = makeFakeSync({
      peers: [{ deviceId: 'peer-1', online: true, trusted: true }],
      onRpc: async () => ({ ok: false, code: 'not-allowed', message: 'op 未注册' }),
    })
    const monitor2 = await peerMonitor({ home, root: root2, getSync: () => sync2 })
    try {
      const file2 = await writePeerOutboxEntry(monitor2, peerOutboxEntry({ incidentId: '20261028-160500-crash' }))
      const third = await monitor2.flushPeerOutbox()
      assert.equal(third.failed, 1)
      const entry2 = await readJson(file2)
      assert.equal(entry2.channels.peer.status, 'pending')
      assert.equal(entry2.channels.peer.attempts, 1)
      assert.equal(entry2.channels.peer.lastError.code, 'not-allowed')
    } finally {
      await monitor2.stop()
    }
  } finally {
    await monitor.stop()
  }
})

test('peer: 离线/无 sync → 保留 pending + lastError，不发 RPC 也不加 attempts', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')

  const offlineSync = makeFakeSync({ peers: [{ deviceId: 'peer-1', online: false, trusted: true }] })
  const offline = await peerMonitor({
    home,
    root,
    getSync: () => offlineSync,
    getOffsite: makeFakeOffsite({
      peerSnapshot: () => ({ sync: true, id: 'peer-1', online: false, trusted: true, reason: 'peer-offline' }),
    }),
  })
  try {
    const file = await writePeerOutboxEntry(offline, peerOutboxEntry())
    const result = await offline.flushPeerOutbox()
    assert.equal(result.failed, 1)
    assert.equal(offlineSync.calls.length, 0)
    const entry = await readJson(file)
    assert.equal(entry.channels.peer.status, 'pending')
    assert.equal(entry.channels.peer.attempts, 0)
    assert.equal(entry.channels.peer.lastError.code, 'peer-offline')
    assert.equal(entry.peerPending, true)
  } finally {
    await offline.stop()
  }

  const root2 = await tempDir('dbk-mon-root-')
  const noSync = await peerMonitor({ home, root: root2, getSync: () => undefined })
  try {
    const file = await writePeerOutboxEntry(noSync, peerOutboxEntry({ incidentId: '20261028-161000-crash' }))
    const result = await noSync.flushPeerOutbox()
    assert.equal(result.failed, 1)
    assert.equal(result.error, null, '没有 sync 不是崩溃：返回结构仍然 ok')
    const entry = await readJson(file)
    assert.equal(entry.channels.peer.status, 'pending')
    assert.equal(entry.channels.peer.attempts, 0)
    assert.equal(entry.channels.peer.lastError.code, 'sync-missing')
    // 第二次没有变化时不重复写文件（updatedAt 不变）
    const before = entry.updatedAt
    await noSync.flushPeerOutbox()
    const again = await readJson(file)
    assert.equal(again.updatedAt, before, '状态未变化时不应每 60s 重写 outbox')
  } finally {
    await noSync.stop()
  }
})

test('peer: 已 sent 不降级；超过 outboxMaxAttempts 保留 pending 并记 max-attempts', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const externalDir = path.join(root, 'external')
  await fs.mkdir(path.join(externalDir, 'monitor'), { recursive: true })
  await seedFile(path.join(externalDir, 'monitor', 'config.json'), {
    notify: { panel: true, toast: true, outboxMaxAttempts: 2, peer: { enabled: true } },
  })
  const sync = makeFakeSync({
    peers: [{ deviceId: 'peer-1', online: true, trusted: true }],
    onRpc: async () => { throw Object.assign(new Error('still failing'), { code: 'peer-rpc-failed' }) },
  })
  const monitor = await peerMonitor({ home, root, getSync: () => sync, externalDir })
  try {
    const sentEntry = peerOutboxEntry({ incidentId: '20261028-161500-crash' })
    sentEntry.channels.peer = { status: 'sent', attempts: 3, sentAt: Date.now() - 10_000, deliveredAt: Date.now() - 10_000 }
    delete sentEntry.peerPending
    const sentFile = await writePeerOutboxEntry(monitor, sentEntry)
    const sentBefore = await readJson(sentFile)

    const maxedEntry = peerOutboxEntry({ incidentId: '20261028-162000-crash' })
    maxedEntry.channels.peer = { status: 'pending', attempts: 2, lastError: null }
    const maxedFile = await writePeerOutboxEntry(monitor, maxedEntry)

    const result = await monitor.flushPeerOutbox()
    assert.equal(result.skipped, 2)
    assert.equal(sync.calls.length, 0, '已 sent / 超限的条目都不能再发')
    assert.deepEqual(await readJson(sentFile), sentBefore, '已 sent 的条目不得被降级/改写')

    const maxed = await readJson(maxedFile)
    assert.equal(maxed.channels.peer.status, 'pending')
    assert.equal(maxed.channels.peer.attempts, 2)
    assert.equal(maxed.channels.peer.lastError.code, 'max-attempts')
  } finally {
    await monitor.stop()
  }
})

test('peer: peerDeviceId 优先，其次第一个 trusted+online；无 peerSnapshot 时也能挑', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const peers = [
    { deviceId: 'peer-a', online: true, trusted: true },
    { deviceId: 'peer-b', online: true, trusted: true },
  ]

  // offsite config 指定 peer-b（且不提供 peerSnapshot，走 dshSync.peers 兜底）
  const syncB = makeFakeSync({ peers })
  const offsiteB = makeFakeOffsite({ config: { peerDeviceId: 'peer-b' } })
  const monitorB = await peerMonitor({ home, root, getSync: () => syncB, getOffsite: offsiteB })
  try {
    await writePeerOutboxEntry(monitorB, peerOutboxEntry({ incidentId: '20261028-162500-crash' }))
    const result = await monitorB.flushPeerOutbox()
    assert.equal(result.deviceId, 'peer-b')
    assert.equal(syncB.calls[0].deviceId, 'peer-b')
  } finally {
    await monitorB.stop()
  }

  // 未配置时选第一个 trusted+online（peer-a 离线 → peer-b）
  const syncC = makeFakeSync({
    peers: [
      { deviceId: 'peer-a', online: false, trusted: true },
      { deviceId: 'peer-b', online: true, trusted: true },
      { deviceId: 'peer-c', online: true, trusted: false },
    ],
  })
  const monitorC = await peerMonitor({ home, root, getSync: () => syncC })
  try {
    await writePeerOutboxEntry(monitorC, peerOutboxEntry({ incidentId: '20261028-163000-crash' }))
    const result = await monitorC.flushPeerOutbox()
    assert.equal(result.deviceId, 'peer-b')
    assert.equal(syncC.calls[0].deviceId, 'peer-b')
  } finally {
    await monitorC.stop()
  }
})

test('peer: monitor.start 后自动补发一次（每 60s 定时器），stop 后不再发', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const sync = makeFakeSync({ peers: [{ deviceId: 'peer-1', online: true, trusted: true }] })
  const monitor = await peerMonitor({ home, root, getSync: () => sync })
  try {
    const file = await writePeerOutboxEntry(monitor, peerOutboxEntry({ incidentId: '20261028-163500-crash' }))
    await monitor.start()
    const sent = await waitFor(async () => {
      const entry = await readJson(file)
      return entry && entry.channels.peer.status === 'sent' ? entry : null
    })
    assert.ok(sent, 'start 后应自动补发 outbox 里的 peer 通知')
    assert.equal(sync.calls.length, 1)
    assert.equal(sync.calls[0].op, 'ext.dr.notify')
    assert.equal('peerPending' in sent, false)
  } finally {
    await monitor.stop()
  }
})

/* ------------------------------ 事故保护 / 秒级变全新客户端 / 覆写检测（task-13） */

async function protectionScenario({ homeFiles = null, snapshots = null, config = {}, extraBeforeStart = null } = {}) {
  const home = await makeHome(homeFiles || HOME_FILES)
  const root = await tempDir('dbk-mon-root-')
  const clock = { value: 1_700_000_000_000 }
  const { engine } = makeFakeEngine({ home, root })
  const now = () => clock.value
  if (snapshots) {
    for (const spec of snapshots) await addSnapshot(engine, spec)
  } else {
    await addSnapshot(engine, {
      id: '20261028-095000-change',
      at: clock.value - 60_000,
      files: { 'workspace.json': '{}' },
    })
  }
  if (typeof extraBeforeStart === 'function') await extraBeforeStart({ home, root, engine, clock })
  const monitor = createMonitorService(monitorOptions({
    engine,
    home,
    root,
    now,
    config: { captureCommandLines: false, ...(config || {}) },
  }))
  return { home, root, clock, engine, monitor, now }
}

async function incidentsOf(monitor) {
  const names = await fs.readdir(monitor.paths.incidentDir).catch(() => [])
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const value = await readJson(path.join(monitor.paths.incidentDir, name))
    if (value) out.push(value)
  }
  return out.sort((a, b) => (a.detectedAt || 0) - (b.detectedAt || 0))
}

test('task13/A+B: 关键文件消失 → 5s 内 data-loss、自动 pause、pin 推荐快照；ack 还原 paused', async () => {
  // 宽限期内（启动后 15s）不判
  const grace = await protectionScenario({
    extraBeforeStart: async ({ home }) => {
      await fs.mkdir(path.join(home, 'storages'), { recursive: true })
      await fs.writeFile(path.join(home, 'storages', 'workspace.json'), '{"v":1}')
    },
  })
  try {
    await grace.monitor.start()
    grace.clock.value += 5000
    await fs.rm(path.join(grace.home, 'storages', 'workspace.json'), { force: true })
    await grace.monitor.tick()
    assert.equal((await incidentsOf(grace.monitor)).filter((item) => item.kind === 'data-loss').length, 0)
  } finally {
    await grace.monitor.stop()
  }

  // 宽限期后：关键文件消失 → 立即 data-loss + 保护
  const scenario = await protectionScenario({
    extraBeforeStart: async ({ home }) => {
      await fs.mkdir(path.join(home, 'storages'), { recursive: true })
      await fs.writeFile(path.join(home, 'storages', 'workspace.json'), '{"v":1}')
    },
  })
  const { home, engine, monitor, clock } = scenario
  try {
    await monitor.start()
    assert.equal(engine.paused, false)
    clock.value += 20_000
    await fs.rm(path.join(home, 'storages', 'workspace.json'), { force: true })
    await monitor.tick()
    const incidents = await incidentsOf(monitor)
    const loss = incidents.find((item) => item.kind === 'data-loss')
    assert.ok(loss, `应产生 data-loss，实际：${incidents.map((i) => i.kind).join(',')}`)
    assert.equal(loss.status, 'open')
    assert.equal(loss.evidence.trigger, 'key-check')
    assert.equal(loss.evidence.keyFiles.before.workspace, true)
    assert.equal(loss.evidence.keyFiles.after.workspace, false)
    assert.ok(loss.timeline.some((item) => item.type === 'data-drop-detected'))
    // A) 自动暂停 + pin 推荐快照
    assert.equal(engine.paused, true)
    assert.deepEqual(engine.pauseCalls, [true])
    assert.equal(loss.protection.pausedBefore, false)
    assert.equal(loss.protection.autoPaused, true)
    assert.equal(loss.protection.pinnedSnapshot, loss.recommendation.snapshotId)
    assert.ok(engine.pinned.has(loss.recommendation.snapshotId))
    const state = await monitor.state({ fresh: true })
    assert.equal(state.protection.active, true)
    assert.equal(state.protection.autoPaused, true)
    assert.equal(state.protection.paused, true)
    assert.deepEqual(state.protection.pinnedSnapshots, [loss.recommendation.snapshotId])

    // ack → 还原用户原先 paused 状态（pin 保留）
    await monitor.ack(loss.id)
    assert.equal(engine.paused, false)
    assert.deepEqual(engine.pauseCalls, [true, false])
    assert.ok(engine.pinned.has(loss.recommendation.snapshotId), 'pin 保留，保护恢复点')
    const acked = (await incidentsOf(monitor)).find((item) => item.id === loss.id)
    assert.equal(acked.status, 'acknowledged')
    assert.ok(acked.protection.releasedAt > 0)
    const afterState = await monitor.state({ fresh: true })
    assert.equal(afterState.protection.active, false)
  } finally {
    await monitor.stop()
  }
})

test('task13/B: sessions 骤降 ≥5 立即报（无需等 60s）；sessions 清空也立即报', async () => {
  const extraSessions = {}
  for (let i = 4; i <= 8; i += 1) extraSessions[`sessions/--D-x--/s${i}/session.v4.jsonl.zstd`] = `x${i}`
  const scenario = await protectionScenario({
    homeFiles: { ...HOME_FILES, ...extraSessions },
  })
  const { home, engine, monitor, clock } = scenario
  try {
    await monitor.start()
    clock.value += 20_000
    const before = (await monitor.state({ fresh: true })).stats.sessions
    assert.ok(before >= 8, `初始 sessions 应 ≥8，实际 ${before}`)
    // 一次删 5 个会话目录 → 立即 data-loss（不等 statsRefreshMs）
    for (const name of ['s1', 's2', 's3', 's4', 's5']) {
      await fs.rm(path.join(home, 'sessions', '--D-x--', name), { recursive: true, force: true })
    }
    await monitor.tick()
    const incidents = await incidentsOf(monitor)
    const loss = incidents.find((item) => item.kind === 'data-loss')
    assert.ok(loss, 'sessions 骤降应产生 data-loss')
    assert.ok(loss.evidence.data.before.sessions - loss.evidence.data.after.sessions >= 5)
    assert.equal(engine.paused, true)
    assert.ok(engine.pinned.size >= 1)

    // sessions 清空：另一个实例，直接删掉整个 sessions
    clock.value += 30_000
    await fs.rm(path.join(home, 'sessions'), { recursive: true, force: true })
    await monitor.tick()
    const after = await incidentsOf(monitor)
    assert.ok(after.some((item) => item.evidence && item.evidence.data
      && item.evidence.data.after.sessions === 0), 'sessions 清空应报')
  } finally {
    await monitor.stop()
  }
})

test('task13/C: 覆写/大量变更超过阈值才报 mass-change；restore 后 5 分钟内抑制', async () => {
  const previousFiles = {}
  for (let i = 0; i < 300; i += 1) previousFiles[`files/f${i}.txt`] = `old-${i}`
  const scenario = await protectionScenario({
    snapshots: [{ id: '20261028-094000-change', at: 1_700_000_000_000 - 120_000, files: previousFiles }],
  })
  const { engine, monitor, clock } = scenario
  try {
    await monitor.start()
    clock.value += 20_000
    const overwritten = {}
    for (let i = 0; i < 250; i += 1) overwritten[`files/f${i}.txt`] = `overwritten-${i}`
    await addSnapshot(engine, {
      id: '20261028-100000-change',
      at: clock.value,
      files: { ...previousFiles, ...overwritten },
    })
    await monitor.tick()
    let incidents = await incidentsOf(monitor)
    const mass = incidents.find((item) => item.kind === 'mass-change')
    assert.ok(mass, `大量覆写应产生 mass-change，实际：${incidents.map((i) => i.kind).join(',')}`)
    assert.equal(mass.severity, 'high')
    assert.equal(mass.evidence.files.created, 0)
    assert.equal(mass.evidence.files.changed, 250)
    assert.equal(mass.evidence.files.deleted, 0)
    assert.equal(mass.evidence.files.impact, 250)
    assert.ok(mass.evidence.files.samples.length > 0)
    assert.ok(mass.evidence.files.samples.every((item) => Object.keys(item).sort().join(',') === 'kind,rel'),
      '样例只保留路径与类型，不含文件内容')
    assert.equal(mass.evidence.files.threshold, 200)
    assert.equal(mass.protection.pausedBefore, false)
    assert.equal(engine.paused, true)
    assert.ok(engine.pinned.has(mass.recommendation.snapshotId))
  } finally {
    await monitor.stop()
  }

  // 未超过阈值（覆写 100 个文件 < max(200, 45)) → 不报
  const smallFiles = {}
  for (let i = 0; i < 300; i += 1) smallFiles[`files/f${i}.txt`] = `old-${i}`
  const small = await protectionScenario({
    snapshots: [{ id: '20261028-093000-change', at: 1_700_000_000_000 - 120_000, files: smallFiles }],
  })
  try {
    await small.monitor.start()
    small.clock.value += 20_000
    const overwritten = {}
    for (let i = 0; i < 100; i += 1) overwritten[`files/f${i}.txt`] = `small-change-${i}`
    await addSnapshot(small.engine, {
      id: '20261028-100500-change',
      at: small.clock.value,
      files: { ...smallFiles, ...overwritten },
    })
    await small.monitor.tick()
    assert.equal((await incidentsOf(small.monitor)).filter((item) => item.kind === 'mass-change').length, 0)
    assert.equal(small.engine.paused, false)
  } finally {
    await small.monitor.stop()
  }

  // restore 后 5 分钟内抑制（即使覆写 250 个文件）
  const restored = await protectionScenario({
    snapshots: [{ id: '20261028-092000-change', at: 1_700_000_000_000 - 120_000, files: previousFiles }],
  })
  try {
    await restored.monitor.start()
    restored.clock.value += 20_000
    restored.engine.lastRestore = { at: restored.clock.value - 60_000 }
    const overwritten = {}
    for (let i = 0; i < 250; i += 1) overwritten[`files/f${i}.txt`] = `restored-${i}`
    await addSnapshot(restored.engine, {
      id: '20261028-101000-change',
      at: restored.clock.value,
      files: { ...previousFiles, ...overwritten },
    })
    await restored.monitor.tick()
    assert.equal((await incidentsOf(restored.monitor)).filter((item) => item.kind === 'mass-change').length, 0)
    assert.equal(restored.engine.paused, false)
  } finally {
    await restored.monitor.stop()
  }

  // 只“新增”大量文件不算覆写/破坏（阈值只看 changed+deleted）→ 不报
  const createOnly = await protectionScenario({
    snapshots: [{ id: '20261028-091500-change', at: 1_700_000_000_000 - 120_000, files: previousFiles }],
  })
  try {
    await createOnly.monitor.start()
    createOnly.clock.value += 20_000
    const added = {}
    for (let i = 0; i < 500; i += 1) added[`attachments/new${i}.bin`] = `blob-${i}`
    await addSnapshot(createOnly.engine, {
      id: '20261028-101500-change',
      at: createOnly.clock.value,
      files: { ...previousFiles, ...added },
    })
    await createOnly.monitor.tick()
    assert.equal((await incidentsOf(createOnly.monitor)).filter((item) => item.kind === 'mass-change').length, 0)
    assert.equal(createOnly.engine.paused, false)
  } finally {
    await createOnly.monitor.stop()
  }
})

test('task13/A: 重启后仍 open 的保护类事故会重新 pause + 重新 pin', async () => {
  const scenario = await protectionScenario()
  const { monitor, engine } = scenario
  await monitor.start()
  await monitor.stop()

  const incident = {
    v: 1,
    id: '20261028-110000-data-loss',
    kind: 'data-loss',
    status: 'open',
    detectedAt: 1_700_000_000_000 - 60_000,
    firstAt: 1_700_000_000_000 - 60_000,
    lastAt: 1_700_000_000_000 - 60_000,
    recoveredAt: 0,
    summary: '历史事故（重启后应恢复保护）',
    severity: 'high',
    source: 'monitor',
    host: { name: 'test-host', home: scenario.home, root: scenario.root },
    protection: {
      pausedBefore: false, pausedApplied: true, autoPaused: true,
      pinnedSnapshot: '20261028-095000-change', at: 1_700_000_000_000 - 60_000,
    },
    recommendation: { snapshotId: '20261028-095000-change', at: 1_700_000_000_000 - 120_000, reason: 'x', verified: true },
    timeline: [],
    evidence: {},
    impact: { local: { checked: 0, badCount: 0, bad: [] }, offsite: { checked: 0, badCount: 0, bad: [] } },
    recovery: { status: 'none', restoredAt: 0, quarantine: null, report: null },
  }
  await fs.mkdir(monitor.paths.incidentDir, { recursive: true })
  await fs.writeFile(path.join(monitor.paths.incidentDir, `${incident.id}.json`), JSON.stringify(incident, null, 2))

  const monitor2 = createMonitorService(monitorOptions({
    engine, home: scenario.home, root: scenario.root, now: scenario.now,
    config: { captureCommandLines: false },
  }))
  try {
    await monitor2.start()
    assert.equal(engine.paused, true, '重启后应保持事故保护的暂停状态')
    assert.ok(engine.pinned.has('20261028-095000-change'), '重启后应重新 pin 推荐快照')
  } finally {
    await monitor2.stop()
  }
})

test('task13/D: heartbeat/baseline 带 keyFiles；evaluateDataLoss 把关键文件消失作为理由', async () => {
  const scenario = await protectionScenario({
    extraBeforeStart: async ({ home }) => {
      await fs.mkdir(path.join(home, 'storages'), { recursive: true })
      await fs.writeFile(path.join(home, 'storages', 'workspace.json'), '{"v":1}')
    },
  })
  const { monitor, clock } = scenario
  try {
    await monitor.start()
    await monitor.flush()
    const heartbeat = await readJson(monitor.paths.heartbeatFile)
    assert.deepEqual(heartbeat.stats.keyFiles, { workspace: true, profile: true, credentials: true })
    const baseline = await readJson(monitor.paths.baselineFile)
    assert.deepEqual(baseline.stats.keyFiles, { workspace: true, profile: true, credentials: true })
    // 秒级统计里 sessions/keyFiles 与 60s 统计同源
    const state = await monitor.state({ fresh: true })
    assert.equal(state.stats.keyFiles.workspace, true)
    clock.value += 1000
    await monitor.refreshStats({ detect: false })
    const after = await monitor.state({ fresh: true })
    assert.equal(after.stats.keyFiles.profile, true)
  } finally {
    await monitor.stop()
  }
})

test('task13/B: 进程命令行快照只进本地 evidence（失败降级不抛）', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const clock = { value: 1_700_000_000_000 }
  const { engine } = makeFakeEngine({ home, root })
  await fs.mkdir(path.join(home, 'storages'), { recursive: true })
  await fs.writeFile(path.join(home, 'storages', 'workspace.json'), '{"v":1}')
  await addSnapshot(engine, { id: '20261028-090000-change', at: clock.value - 60_000, files: { 'workspace.json': '{}' } })
  const spawns = []
  const fakeSpawn = (command, args, options) => {
    spawns.push({ command, args, options })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify([
        { ProcessId: 123, Name: 'DeepSeek Harness.exe', CommandLine: '"D:\\DeepSeek\\DeepSeek Harness.exe"' },
      ])))
      child.emit('close', 0)
    })
    return child
  }
  const monitor = createMonitorService(monitorOptions({
    engine, home, root, now: () => clock.value, spawnProcess: fakeSpawn,
    config: { captureCommandLines: true },
  }))
  try {
    await monitor.start()
    clock.value += 20_000
    await fs.rm(path.join(home, 'storages', 'workspace.json'), { force: true })
    await monitor.tick()
    const incidents = await incidentsOf(monitor)
    const loss = incidents.find((item) => item.kind === 'data-loss')
    assert.ok(loss)
    assert.ok(Array.isArray(loss.evidence.process.commandLines))
    assert.equal(loss.evidence.process.commandLines[0].pid, 123)
    assert.match(loss.evidence.process.commandLines[0].name, /DeepSeek Harness/)
    assert.equal(spawns[0].options.windowsHide, true)
  } finally {
    await monitor.stop()
  }

  // PowerShell 不可用 → 降级为 null，不影响事故记录
  const brokenHome = await makeHome()
  const brokenRoot = await tempDir('dbk-mon-root-')
  const brokenClock = { value: 1_700_000_000_000 }
  const { engine: brokenEngine } = makeFakeEngine({ home: brokenHome, root: brokenRoot })
  await fs.mkdir(path.join(brokenHome, 'storages'), { recursive: true })
  await fs.writeFile(path.join(brokenHome, 'storages', 'workspace.json'), '{"v":1}')
  await addSnapshot(brokenEngine, {
    id: '20261028-090500-change',
    at: brokenClock.value - 60_000,
    files: { 'workspace.json': '{}' },
  })
  const broken = createMonitorService(monitorOptions({
    engine: brokenEngine,
    home: brokenHome,
    root: brokenRoot,
    now: () => brokenClock.value,
    spawnProcess: () => { throw new Error('powershell missing') },
    config: { captureCommandLines: true },
  }))
  try {
    await broken.start()
    brokenClock.value += 20_000
    await fs.rm(path.join(brokenHome, 'storages', 'workspace.json'), { force: true })
    await broken.tick()
    const incidents = await incidentsOf(broken)
    const loss = incidents.find((item) => item.kind === 'data-loss')
    assert.ok(loss, 'PowerShell 不可用时仍必须记录事故')
    assert.equal(loss.evidence.process.commandLines, undefined)
  } finally {
    await broken.stop()
  }
})

/* -------------------------- task-14：通知配置 / 备份根目录修改 -------------------------- */

function fakeDpapi() {
  return {
    available: true,
    async protect(plain) { return `fake:${Buffer.from(String(plain), 'utf8').toString('base64')}` },
    async unprotect(blob) {
      const text = String(blob)
      if (!text.startsWith('fake:')) throw new Error('bad blob')
      return Buffer.from(text.slice(5), 'base64').toString('utf8')
    },
  }
}

function fakeToolSpawn({ stdout = '', code = 0 } = {}) {
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { write() {}, end() {} }
    child.kill = () => {}
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
      child.emit('close', code)
    })
    return child
  }
  spawn.calls = calls
  return spawn
}

async function makeExternalDir(root) {
  const externalDir = path.join(root, 'external')
  await fs.mkdir(path.join(externalDir, 'monitor'), { recursive: true })
  return externalDir
}

test('task14/notify: 保存通知配置（非密进 config.json、密文进 secrets.dpapi，保留未知键/不泄露密码）', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const { engine } = makeFakeEngine({ home, root })
  const externalDir = await makeExternalDir(root)
  await seedFile(path.join(externalDir, 'monitor', 'config.json'), {
    v: 1,
    storeRoot: 'D:\\\\old-backup',
    home: 'C:\\\\Users\\\\x\\\\.dsh',
    hostname: 'old-host',
    process: { name: 'DeepSeek Harness.exe' },
    thresholds: { dedupeMs: 12345 },
    notify: { panel: true, toast: false },
  })
  const monitor = createMonitorService(monitorOptions({
    engine, home, root, externalDir, dpapi: fakeDpapi(),
  }))
  try {
    const notify = await monitor.saveNotifyConfig({
      config: {
        panel: true,
        toast: true,
        webhook: [
          { name: 'primary', url: 'https://example.invalid/hook', enabled: true, retries: 3 },
          { name: 'second', url: 'http://127.0.0.1:9999/hook', enabled: false },
        ],
        email: {
          enabled: true, host: 'smtp.example.invalid', port: 465, useSsl: true,
          user: 'bot@example.invalid', from: 'bot@example.invalid', to: ['a@example.invalid', 'b@example.invalid'],
        },
        qq: { enabled: true, http: 'http://127.0.0.1:3000', action: 'send_private_msg', target: '12345' },
        peer: { enabled: true },
      },
      secrets: {
        smtpPassword: 'smtp-secret-123',
        qqToken: 'qq-secret-456',
        webhookTokens: { primary: 'hook-secret-789' },
      },
    })
    assert.equal(notify.ok, true)
    assert.equal(notify.present, true)
    assert.equal(notify.config.webhook.length, 2)
    assert.equal(notify.config.webhook[0].tokenConfigured, true)
    assert.equal(notify.config.email.passwordConfigured, true)
    assert.equal(notify.config.qq.tokenConfigured, true)
    assert.equal(notify.config.peer.enabled, true)

    const rawConfig = await readJson(path.join(externalDir, 'monitor', 'config.json'))
    // 未知/其它键必须保留
    assert.equal(rawConfig.storeRoot, 'D:\\\\old-backup')
    assert.equal(rawConfig.hostname, 'old-host')
    assert.equal(rawConfig.process.name, 'DeepSeek Harness.exe')
    assert.equal(rawConfig.thresholds.dedupeMs, 12345)
    assert.equal(rawConfig.notify.toast, true)
    assert.equal(rawConfig.notify.webhook[0].name, 'primary')
    // 密码/token 绝不能出现在 config.json
    const configText = JSON.stringify(rawConfig)
    for (const needle of ['smtp-secret-123', 'qq-secret-456', 'hook-secret-789']) {
      assert.equal(configText.includes(needle), false, `config.json 不得包含密钥：${needle}`)
    }
    // secrets.dpapi 是 DPAPI 密文（fake 可解），且只含密钥
    const blob = (await fs.readFile(path.join(externalDir, 'monitor', 'secrets.dpapi'), 'utf8')).trim()
    const plain = await fakeDpapi().unprotect(blob)
    const secrets = JSON.parse(plain)
    assert.equal(secrets.smtp.password, 'smtp-secret-123')
    assert.equal(secrets.qq.token, 'qq-secret-456')
    assert.equal(secrets.webhook.primary, 'hook-secret-789')

    // 第二次保存：只改配置、不带密钥 → 已有密钥保留
    await monitor.saveNotifyConfig({
      config: { panel: true, toast: true, webhook: [], email: { enabled: false }, qq: { enabled: false }, peer: { enabled: false } },
      secrets: {},
    })
    const notify2 = await monitor.notifyState()
    assert.equal(notify2.config.email.passwordConfigured, true)
    assert.equal(notify2.config.qq.tokenConfigured, true)
    assert.equal(notify2.config.webhook.length, 0)

    // 校验失败（非 http URL）→ 明确 code，不写坏配置
    await assert.rejects(
      () => monitor.saveNotifyConfig({ config: { webhook: [{ name: 'bad', url: 'ftp://x' }] } }),
      (error) => error.code === 'bad-webhook-url',
    )
  } finally {
    await monitor.stop()
  }
})

test('task14/notify: 测试按钮调用 watchdog --test-notify（成功/缺失/旧版降级）', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const { engine } = makeFakeEngine({ home, root })
  const externalDir = await makeExternalDir(root)
  const report = { ok: true, channel: 'toast', version: '1.0.2', result: { code: 'ok', detail: 'toast ok' } }
  const spawn = fakeToolSpawn({ stdout: `${JSON.stringify(report)}\n`, code: 0 })
  const monitor = createMonitorService(monitorOptions({
    engine, home, root, externalDir, spawnProcess: spawn, dpapi: fakeDpapi(),
  }))
  try {
    await fs.writeFile(path.join(externalDir, 'monitor', 'watchdog.mjs'), "const WATCHDOG_VERSION = '1.0.2'\n// --test-notify support\n")
    const result = await monitor.testNotifyChannel('toast')
    assert.equal(result.ok, true)
    assert.equal(result.result.code, 'ok')
    assert.equal(spawn.calls.length, 1)
    const call = spawn.calls[0]
    assert.equal(call.command, process.execPath)
    assert.deepEqual(call.args.slice(0, 4), [path.join(externalDir, 'monitor', 'watchdog.mjs'), '--test-notify', 'toast', '--config'])
    assert.ok(call.args.includes('--json'))
    assert.equal(call.options.windowsHide, true)

    // 未知通道：不 spawn
    const bad = await monitor.testNotifyChannel('nope')
    assert.equal(bad.ok, false)
    assert.equal(bad.result.code, 'bad-channel')

    // watchdog 文件不存在 → watchdog-missing
    await fs.rm(path.join(externalDir, 'monitor', 'watchdog.mjs'))
    const missing = await monitor.testNotifyChannel('panel')
    assert.equal(missing.result.code, 'watchdog-missing')

    // 旧版 watchdog（没有 test-notify）→ 不执行，明确提示
    await fs.writeFile(path.join(externalDir, 'monitor', 'watchdog.mjs'), "const WATCHDOG_VERSION = '1.0.0'\n// --once only\n")
    const before = spawn.calls.length
    const old = await monitor.testNotifyChannel('panel')
    assert.equal(old.result.code, 'test-notify-unavailable')
    assert.equal(spawn.calls.length, before)
  } finally {
    await monitor.stop()
  }
})

test('task14/root: 备份根目录校验/预览/应用（改 cordis.patch.yml root 行 + 备份原文件）', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const currentRoot = path.join(root, 'old-backup')
  await fs.mkdir(currentRoot, { recursive: true })
  const profileDir = path.join(home, 'profiles', 'desktop')
  await fs.mkdir(profileDir, { recursive: true })
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  await fs.writeFile(patchFile, [
    '- id: other-plugin',
    '  name: other',
    '  config:',
    '    root: /tmp/other',
    '- id: disaster-recovery',
    "  name: 'dsh-disaster-recovery'",
    '  config:',
    '    root: ' + JSON.stringify(currentRoot),
    '    excludes:',
    '      - dsh-runtimes',
    '',
  ].join('\n'))
  const { engine } = makeFakeEngine({ home, root: currentRoot, hostname: 'test-host' })
  const externalDir = await makeExternalDir(root)
  await seedFile(path.join(externalDir, 'monitor', 'config.json'), {
    v: 1, storeRoot: currentRoot, home, hostname: 'test-host', notify: { panel: true },
  })
  const monitor = createMonitorService(monitorOptions({ engine, home, root: currentRoot, externalDir, dpapi: fakeDpapi() }))
  try {
    // 非法输入
    await assert.rejects(() => monitor.previewBackupRoot('relative\\path'), (e) => e.code === 'root-relative')
    await assert.rejects(() => monitor.previewBackupRoot(path.join(home, 'inside')), (e) => e.code === 'root-inside-home')
    await assert.rejects(() => monitor.previewBackupRoot(currentRoot), (e) => e.code === 'root-same')

    const newRoot = path.join(root, 'new-backup')
    const preview = await monitor.previewBackupRoot(newRoot)
    assert.equal(preview.ok, true)
    assert.equal(preview.preview, true)
    assert.equal(preview.needRestart, true)
    assert.equal(preview.root, path.resolve(newRoot))
    // 预览不得写 patch
    const beforeText = await fs.readFile(patchFile, 'utf8')
    assert.equal(beforeText.includes(newRoot), false)

    const applied = await monitor.applyBackupRoot(newRoot)
    assert.equal(applied.ok, true)
    assert.equal(applied.needRestart, true)
    assert.equal(applied.previousRoot, path.resolve(currentRoot))
    assert.equal(applied.configUpdated, true)
    const externalCfg = await readJson(path.join(externalDir, 'monitor', 'config.json'))
    assert.equal(path.resolve(externalCfg.storeRoot), path.resolve(newRoot))
    assert.ok(applied.backupPath && (await fs.stat(applied.backupPath)).isFile(), '必须备份原 patch')
    const backupText = await fs.readFile(applied.backupPath, 'utf8')
    assert.equal(backupText, beforeText)
    const afterText = await fs.readFile(patchFile, 'utf8')
    assert.ok(afterText.includes(newRoot), '新 root 必须写入 patch')
    assert.equal(afterText.includes(`root: ${JSON.stringify(currentRoot)}`), false)
    // 其它插件条目不能被破坏
    assert.ok(afterText.includes('- id: other-plugin') && afterText.includes('root: /tmp/other'))
    assert.ok(afterText.includes('excludes:'))

    // 没有 disaster-recovery 条目时 → 追加条目
    const home2 = await makeHome()
    const root2 = await tempDir('dbk-mon-root-')
    const currentRoot2 = path.join(root2, 'old2')
    await fs.mkdir(currentRoot2, { recursive: true })
    await fs.mkdir(path.join(home2, 'profiles', 'desktop'), { recursive: true })
    const patch2 = path.join(home2, 'profiles', 'desktop', 'cordis.patch.yml')
    await fs.writeFile(patch2, '- id: some-other\n  name: other\n')
    const { engine: engine2 } = makeFakeEngine({ home: home2, root: currentRoot2, hostname: 'test-host' })
    const external2 = await makeExternalDir(root2)
    const monitor2 = createMonitorService(monitorOptions({ engine: engine2, home: home2, root: currentRoot2, externalDir: external2, dpapi: fakeDpapi() }))
    try {
      const newRoot2 = path.join(root2, 'new2')
      const appended = await monitor2.applyBackupRoot(newRoot2)
      assert.equal(appended.patchAction, 'append-entry')
      const text2 = await fs.readFile(patch2, 'utf8')
      assert.ok(text2.includes('- id: disaster-recovery'))
      assert.ok(text2.includes("name: 'dsh-disaster-recovery'"))
      assert.ok(text2.includes(newRoot2))
    } finally {
      await monitor2.stop()
    }
  } finally {
    await monitor.stop()
  }
})

test('task14/panel: notify-state / notify-save / notify-test / root-set action 契约', async () => {
  const home = await makeHome()
  const root = await tempDir('dbk-mon-root-')
  const currentRoot = path.join(root, 'old-backup')
  await fs.mkdir(currentRoot, { recursive: true })
  await fs.mkdir(path.join(home, 'profiles', 'desktop'), { recursive: true })
  const patchFile = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml')
  await fs.writeFile(patchFile, "- id: disaster-recovery\n  name: 'dsh-disaster-recovery'\n  config:\n    root: 'old'\n")
  const { engine } = makeFakeEngine({ home, root: currentRoot, hostname: 'test-host' })
  const externalDir = await makeExternalDir(root)
  await fs.writeFile(path.join(externalDir, 'monitor', 'watchdog.mjs'), "const WATCHDOG_VERSION = '1.0.2'\n// --test-notify\n")
  const spawn = fakeToolSpawn({
    stdout: `${JSON.stringify({ ok: true, channel: 'panel', result: { code: 'ok' } })}\n`,
  })
  const monitor = createMonitorService(monitorOptions({
    engine, home, root: currentRoot, externalDir, spawnProcess: spawn, dpapi: fakeDpapi(),
  }))
  const handler = createPanelHandler({
    getEngine: () => engine,
    getStartError: () => null,
    getMonitor: () => monitor,
    log: () => {},
  })
  try {
    const state = await call(handler, 'POST', { action: 'notify-state' })
    assert.equal(state.status, 200)
    assert.equal(state.json.notify.ok, true)
    assert.equal(state.json.notify.watchdog.testNotifySupported, true)

    const saved = await call(handler, 'POST', {
      action: 'notify-save',
      config: { panel: true, toast: false, webhook: [{ name: 'hook', url: 'https://example.invalid/x' }] },
      secrets: { webhookTokens: { hook: 'tok' } },
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.json.notify.config.toast, false)
    assert.equal(saved.json.notify.config.webhook[0].tokenConfigured, true)

    const tested = await call(handler, 'POST', { action: 'notify-test', channel: 'panel' })
    assert.equal(tested.status, 200)
    assert.equal(tested.json.test.ok, true)

    const preview = await call(handler, 'POST', { action: 'root-set', root: path.join(root, 'new-backup') })
    assert.equal(preview.status, 200)
    assert.equal(preview.json.rootResult.preview, true)
    const applied = await call(handler, 'POST', { action: 'root-set', root: path.join(root, 'new-backup'), apply: true })
    assert.equal(applied.status, 200)
    assert.equal(applied.json.rootResult.needRestart, true)
    assert.ok(applied.json.rootResult.backupPath)

    const bad = await call(handler, 'POST', { action: 'notify-save', config: { webhook: [{ name: 'x', url: 'not-a-url' }] } })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.ok, false)
    assert.equal(bad.json.error.code, 'bad-webhook-url')

    const missingChannel = await call(handler, 'POST', { action: 'notify-test' })
    assert.equal(missingChannel.status, 400)
    assert.equal(missingChannel.json.error.code, 'bad-request')
  } finally {
    await monitor.stop()
  }
})
