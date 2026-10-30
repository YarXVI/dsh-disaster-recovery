/**
 * 外部看门狗 + 安装器的测试（task-8）。
 *
 * 全部离线：注入 fake 进程检测 / 事件日志 / fetch / 命令执行；
 * 不杀真实进程、不写真实 .dsh、不装真实计划任务、不联网。
 * 安装器测试只跑在临时目录（-Source fixture、-RecoveryHome 临时、-NoTask），
 * 且默认 dry-run 阶段断言“一个文件都没写”。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  acquireLock,
  buildNotifyPayload,
  classifyAll,
  flushOutbox,
  formatDuration,
  inspectBackup,
  normalizeConfig,
  parseArgs,
  postJsonWithRetry,
  resolveCurrentStats,
  runOnce,
  scanHomeDefault,
  TEST_NOTIFY_TITLE,
  testNotify,
  WATCHDOG_VERSION,
} from '../watchdog/watchdog.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IS_WINDOWS = process.platform === 'win32'
const PS_EXE = IS_WINDOWS
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'pwsh'
// 固定“现在”，避免测试跟真实时钟/时区耦合。
const NOW = Date.UTC(2026, 9, 28, 8, 0, 0)
const HOUR = 3600 * 1000
const DAY = 24 * HOUR

const worlds = []
after(async () => {
  for (const root of worlds) {
    try { await fsp.rm(root, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
  }
})

/* --------------------------------------------------------------- 测试工具 */

async function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'))
}

async function exists(target) {
  try { await fsp.access(target); return true } catch { return false }
}

async function listTree(root) {
  const out = []
  const walk = async (dir, rel) => {
    let entries = []
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      out.push(childRel)
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel)
    }
  }
  await walk(root, '')
  return out.sort()
}

async function makeWorld(options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-wd-'))
  worlds.push(root)
  const hostname = options.hostname || 'TESTHOST'
  const home = path.join(root, 'home')
  const storeRoot = path.join(root, 'store')
  const recoveryHome = path.join(root, 'recovery')
  const storeDir = path.join(storeRoot, hostname)
  const monitorDir = path.join(storeDir, 'monitor')
  const configPath = path.join(recoveryHome, 'monitor', 'config.json')
  await fsp.mkdir(home, { recursive: true })
  for (let i = 0; i < (options.homeFiles || 0); i += 1) {
    await fsp.writeFile(path.join(home, `file-${i}.txt`), `content-${i}`)
  }
  const config = {
    v: 1,
    storeRoot,
    home,
    hostname,
    thresholds: options.thresholds || {},
    notify: options.notify || {
      panel: true, toast: false, webhook: [], email: { enabled: false }, qq: { enabled: false }, peer: { enabled: false },
    },
  }
  await writeJson(configPath, config)
  return { root, hostname, home, storeRoot, storeDir, monitorDir, recoveryHome, configPath, config, lockPath: path.join(recoveryHome, 'monitor', 'watchdog.lock') }
}

async function writeHeartbeat(world, payload) {
  await writeJson(path.join(world.monitorDir, 'heartbeat.json'), {
    v: 1,
    host: { name: world.hostname, home: world.home, root: world.storeRoot },
    ...payload,
  })
}

async function writeBaseline(world, stats, at, extra = {}) {
  await writeJson(path.join(world.monitorDir, 'baseline.json'), {
    v: 1, at, host: world.hostname, home: world.home, source: 'test', stats, ...extra,
  })
}

async function seedBackup(world, { manifests = [], blobs = {} } = {}) {
  await fsp.mkdir(path.join(world.storeDir, 'snapshots'), { recursive: true })
  await fsp.mkdir(path.join(world.storeDir, 'blobs'), { recursive: true })
  for (const [hash, content] of Object.entries(blobs)) {
    const dir = path.join(world.storeDir, 'blobs', hash.slice(0, 2), hash.slice(2, 4))
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, hash), content)
  }
  for (const manifest of manifests) {
    await writeJson(path.join(world.storeDir, 'snapshots', `${manifest.id}.json`), manifest)
  }
}

/**
 * 构造与真实 `.dsh` 同形状的监控目录：
 *   sessions/<workspace>/<session-id>/（会话数按第二层目录数）
 *   storages/ 下 root/level1/level1-level2 三层文件（maxDepth=3）
 *   profiles/<name>/（第一层目录数）、attachments/ 嵌套文件、关键文件
 * 返回值与 scanHome 的 monitor 语义应一致（storages 含 workspace.json 本身）。
 */
async function seedHomeMetrics(world, {
  workspaceCounts = [],
  storageFiles = 0,
  attachmentFiles = 0,
  profileDirs = 1,
  keyFiles = {},
} = {}) {
  const sessionsRoot = path.join(world.home, 'sessions')
  await fsp.mkdir(sessionsRoot, { recursive: true })
  for (let w = 0; w < workspaceCounts.length; w += 1) {
    const workspace = path.join(sessionsRoot, `workspace-${w}`)
    await fsp.mkdir(workspace, { recursive: true })
    for (let i = 0; i < workspaceCounts[w]; i += 1) {
      const session = path.join(workspace, `session-${i}`)
      await fsp.mkdir(session, { recursive: true })
      await fsp.writeFile(path.join(session, 'chat.json'), '{}')
    }
  }
  const storagesRoot = path.join(world.home, 'storages')
  await fsp.mkdir(storagesRoot, { recursive: true })
  for (let i = 0; i < storageFiles; i += 1) {
    const depth = i % 3
    const dir = depth === 0
      ? storagesRoot
      : depth === 1
        ? path.join(storagesRoot, 'level1')
        : path.join(storagesRoot, 'level1', 'level2')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, `data-${i}.json`), '{}')
  }
  if (keyFiles.workspace !== false) await fsp.writeFile(path.join(storagesRoot, 'workspace.json'), '{}')
  const profilesRoot = path.join(world.home, 'profiles')
  for (let i = 0; i < profileDirs; i += 1) {
    const name = i === 0 ? 'desktop' : `profile-${i}`
    const dir = path.join(profilesRoot, name)
    await fsp.mkdir(dir, { recursive: true })
    if (i === 0 && keyFiles.profile !== false) await fsp.writeFile(path.join(dir, 'package.json'), '{}')
  }
  const attachmentsRoot = path.join(world.home, 'attachments')
  await fsp.mkdir(attachmentsRoot, { recursive: true })
  for (let i = 0; i < attachmentFiles; i += 1) {
    const dir = i % 2 === 0 ? attachmentsRoot : path.join(attachmentsRoot, 'nested')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, `a-${i}.bin`), 'x')
  }
  if (keyFiles.credentials !== false) {
    await fsp.writeFile(path.join(world.home, '.credentials.yaml'), 'key: value\n')
  }
}

function manifestFor(id, at, files) {
  return { version: 2, id, at, reason: 'change', host: 'TESTHOST', chunkSize: 65536, files }
}

async function readIncidents(world) {
  const dir = path.join(world.monitorDir, 'incidents')
  let names = []
  try { names = (await fsp.readdir(dir)).filter((name) => name.endsWith('.json')).sort() } catch { return [] }
  const list = []
  for (const name of names) list.push(await readJson(path.join(dir, name)))
  return list
}

async function readAlerts(world) {
  return readJson(path.join(world.monitorDir, 'alerts', 'current.json'))
}

/**
 * 跑一次 runOnce，全部外部依赖注入 fake。
 * 默认不发通知（deps.notify=false），需要测通知时传 enableNotify:true。
 */
async function runWorld(world, options = {}) {
  const calls = { runCommand: [], fetch: [], detectProcess: 0 }
  const processInfo = options.processInfo ?? { ok: true, alive: false, count: 0, processes: [], main: null }
  const events = options.events ?? { ok: true, application: [], system: [], errors: [] }
  const result = await runOnce({
    configPath: world.configPath,
    lockPath: world.lockPath,
    now: options.now ?? NOW,
    storeRoot: options.storeRoot,
    home: options.home,
    scriptDir: path.join(REPO, 'watchdog'),
    noNotify: options.noNotify === true,
    deps: {
      detectProcess: async () => { calls.detectProcess += 1; return processInfo },
      queryEvents: async () => events,
      diskFree: async () => options.disk ?? { ok: true, freeBytes: 500 * 1024 ** 3, totalBytes: 2000 * 1024 ** 3, path: 'D:\\' },
      fetchFn: async (url, init) => {
        calls.fetch.push({ url, init })
        if (typeof options.fetch === 'function') return options.fetch(url, init)
        return { ok: true, status: 200 }
      },
      runCommand: async (exe, args, opts) => {
        calls.runCommand.push({ exe, args, input: opts?.input })
        if (typeof options.runCommand === 'function') return options.runCommand(exe, args, opts)
        return { ok: true, code: 0, stdout: '', stderr: '' }
      },
      sleep: async () => {},
      notify: options.enableNotify === true,
      ...(options.deps || {}),
    },
  })
  return { result, calls }
}

const absentProcess = { ok: true, alive: false, count: 0, processes: [], main: null }
const aliveProcess = (pid = 4321) => ({
  ok: true,
  alive: true,
  count: 1,
  processes: [{ pid, parentPid: 1, name: 'DeepSeek Harness.exe', commandLine: 'D:\\DeepSeek\\DeepSeek Harness.exe', startedAt: NOW - 4 * HOUR }],
  main: { pid, parentPid: 1, name: 'DeepSeek Harness.exe', commandLine: 'D:\\DeepSeek\\DeepSeek Harness.exe', startedAt: NOW - 4 * HOUR },
})

/* --------------------------------------------------------------- 单元：参数/配置 */

test('watchdog: parseArgs / normalizeConfig 基本契约', () => {
  const args = parseArgs(['--once', '--config', 'C:\\x\\config.json', '--json', '--no-notify', '--interval-ms', '5000', '--bogus'])
  assert.equal(args.once, true)
  assert.equal(args.config, 'C:\\x\\config.json')
  assert.equal(args.json, true)
  assert.equal(args['no-notify'], true)
  assert.equal(args['interval-ms'], '5000')
  assert.deepEqual(args.unknown, ['bogus'])

  const { config, warnings } = normalizeConfig({
    storeRoot: 'E:\\backup',
    thresholds: { heartbeatStaleMs: 5000, hangStaleMs: -1 },
    notify: {
      toast: false,
      webhook: { primary: 'https://example.test/hook' },
      email: { enabled: true, to: 'ops@example.test' },
      qq: { enabled: true, http: 'http://127.0.0.1:3000/' },
    },
  })
  assert.equal(config.storeRoot, 'E:\\backup')
  assert.equal(config.thresholds.heartbeatStaleMs, 5000)
  assert.equal(config.thresholds.hangStaleMs, 180000, '非法阈值回退默认值')
  assert.ok(warnings.includes('threshold-hangStaleMs-invalid'))
  assert.equal(config.notify.toast, false)
  assert.equal(config.notify.webhook[0].name, 'primary')
  assert.deepEqual(config.notify.email.to, ['ops@example.test'])
  assert.equal(config.notify.qq.http, 'http://127.0.0.1:3000/')
  assert.equal(config.notify.qq.enabled, true)
})

test('watchdog: 通知正文不含路径/文件内容，只含主机/类型/时间/推荐点', () => {
  const payload = buildNotifyPayload({
    id: '20261028-160000-crash',
    kind: 'crash',
    severity: 'high',
    detectedAt: NOW,
    host: 'LAPTOP-X',
    summary: '备份仓库异常：快照 x 缺块（sessions/abc.json）',
    recommendation: { snapshotId: '20261028-155000-change', at: NOW - HOUR, verified: true },
    impact: { local: { total: 99 } },
  }, { hostname: 'LAPTOP-X' })
  assert.match(payload.title, /DSH/)
  assert.match(payload.body, /LAPTOP-X/)
  assert.match(payload.body, /20261028-155000-change/)
  assert.match(payload.body, /99/)
  assert.doesNotMatch(payload.body, /sessions\/abc\.json/, '通知不该带路径明细')
  assert.doesNotMatch(payload.body, /C:\\|D:\\/)
  assert.ok(!JSON.stringify(payload).includes('sessions/abc.json'))
})

/* --------------------------------------------------------------- 事故分类：crash */

test('watchdog: 心跳断档 + 进程缺失 → crash 事故 + alerts + 事故文件', async () => {
  const world = await makeWorld({ homeFiles: 3 })
  const blobHash = await sha256('crashtest')
  await seedBackup(world, {
    blobs: { [blobHash]: 'crashtest' },
    manifests: [manifestFor('20261028-140000-change', NOW - 3 * HOUR, {
      'AGENTS.md': { s: 9, m: NOW - 3 * HOUR, c: [blobHash] },
    })],
  })
  await writeHeartbeat(world, {
    bootId: 'boot-crashed', pid: 4242, startedAt: NOW - 5 * HOUR,
    lastSeen: NOW - 5 * 60 * 1000, cleanExit: false, version: '0.4.0',
    stats: { files: 3, bytes: 30, sessions: 1, storages: 0, profiles: 1, attachments: 0, credentials: true },
    backup: { snapshots: 1, latestId: '20261028-140000-change', latestAt: NOW - 3 * HOUR },
  })

  const { result, calls } = await runWorld(world, { processInfo: absentProcess })
  assert.equal(result.ok, true)
  assert.equal(result.incidents.length, 1)
  const incident = (await readIncidents(world))[0]
  assert.equal(incident.kind, 'crash')
  assert.equal(incident.status, 'open')
  assert.equal(incident.severity, 'high')
  assert.equal(incident.firstAt, NOW - 5 * 60 * 1000)
  assert.match(incident.summary, /异常退出/)
  assert.equal(incident.evidence.heartbeat.gapMs, 5 * 60 * 1000)
  assert.equal(incident.recommendation.snapshotId, '20261028-140000-change')
  assert.equal(incident.recommendation.verified, true)

  const alerts = await readAlerts(world)
  assert.equal(alerts.source, 'watchdog')
  assert.equal(alerts.incidents.length, 1)
  assert.equal(alerts.open.length, 1)
  assert.equal(alerts.incidents[0].kind, 'crash')
  // 绝不启停 DSH：一次进程查询而已，没有任何 kill/stop 命令
  assert.ok(calls.runCommand.every((call) => !String(call.args || []).join(' ').match(/Stop-Process|taskkill|kill/i)))
  assert.equal(calls.detectProcess, 1)
})

test('watchdog: cleanExit=true 不误报 crash', async () => {
  const world = await makeWorld({ homeFiles: 2 })
  await writeHeartbeat(world, {
    bootId: 'boot-clean', pid: 1, startedAt: NOW - 2 * HOUR,
    lastSeen: NOW - 5 * 60 * 1000, cleanExit: true, cleanExitAt: NOW - 5 * 60 * 1000,
  })
  const { result } = await runWorld(world, { processInfo: absentProcess })
  assert.equal(result.incidents.length, 0)
  assert.equal((await readIncidents(world)).length, 0)
  const alerts = await readAlerts(world)
  assert.equal(alerts.incidents.length, 0)
})

test('watchdog: 进程在但心跳停止 → hang', async () => {
  const world = await makeWorld({ homeFiles: 2 })
  await writeHeartbeat(world, {
    bootId: 'boot-hang', pid: 999, startedAt: NOW - 2 * HOUR,
    lastSeen: NOW - 7 * 60 * 1000, cleanExit: false,
    client: { lastSeen: NOW - 8 * 60 * 1000 },
  })
  const { result } = await runWorld(world, { processInfo: aliveProcess(999) })
  assert.equal(result.incidents.length, 1)
  const incident = (await readIncidents(world))[0]
  assert.equal(incident.kind, 'hang')
  assert.equal(incident.severity, 'medium')
  assert.match(incident.summary, /卡死|无响应/)
  assert.equal(incident.evidence.process.pid, 999)
})

/* --------------------------------------------------------- 睡眠/关机抑制 */

test('watchdog: 睡眠/正常关机窗口内不误报 crash（42/107/1074）', async () => {
  for (const eventId of [42, 107, 1074]) {
    const world = await makeWorld({ homeFiles: 1 })
    const lastSeen = NOW - 5 * 60 * 1000
    await writeHeartbeat(world, { bootId: 'boot-sleep', pid: 77, startedAt: NOW - HOUR, lastSeen, cleanExit: false })
    const events = {
      ok: true,
      application: [],
      system: [{
        log: 'System', time: lastSeen + 1000, id: eventId, provider: 'Microsoft-Windows-Kernel-Power',
        recordId: 100 + eventId, level: 'Information', message: `event ${eventId}`,
      }],
      errors: [],
    }
    const { result } = await runWorld(world, { processInfo: absentProcess, events })
    assert.equal(result.incidents.length, 0, `event ${eventId} 不应触发 crash`)
    assert.ok(result.suppressed.some((item) => item.kind === 'crash' && item.reason === 'sleep-or-shutdown'), `event ${eventId} 应记录抑制`)
    assert.equal((await readIncidents(world)).length, 0)
  }
})

/* --------------------------------------------------------------- data-loss */

test('watchdog: 数据骤降（心跳口径）→ data-loss + 事故前快照推荐', async () => {
  const world = await makeWorld({ homeFiles: 120 })
  const blobHash = await sha256('before-loss')
  await seedBackup(world, {
    blobs: { [blobHash]: 'before-loss' },
    manifests: [manifestFor('20261028-130000-change', NOW - 2 * HOUR, {
      'sessions/a.json': { s: 11, m: NOW - 2 * HOUR, c: [blobHash] },
    })],
  })
  const keyFiles = { workspace: true, profile: true, credentials: true }
  await writeBaseline(world, {
    files: 120, bytes: 1200, sessions: 8, storages: 2, profiles: 1, attachments: 0, credentials: true, keyFiles,
  }, NOW - HOUR, { statsSource: 'heartbeat' })
  // 删掉 100 个文件（保留 20 个）+ 关键文件消失
  for (let i = 0; i < 100; i += 1) {
    await fsp.unlink(path.join(world.home, `file-${i}.txt`))
  }
  await fsp.rm(path.join(world.home, '.credentials.yaml'), { force: true })
  // 心跳是 current 的首选来源：模拟插件 60s 内已刷新到骤降后的 stats
  await writeHeartbeat(world, {
    bootId: 'boot-loss', pid: 555, startedAt: NOW - 3 * HOUR, lastSeen: NOW - 2000, cleanExit: false,
    stats: {
      files: 20, bytes: 200, sessions: 0, storages: 0, profiles: 0, attachments: 0, credentials: false,
      keyFiles: { workspace: false, profile: false, credentials: false },
    },
  })

  const { result } = await runWorld(world, { processInfo: aliveProcess(555) })
  assert.equal(result.statsSource, 'heartbeat', 'baseline 与 current 都必须来自新鲜心跳')
  assert.equal(result.incidents.length, 1)
  const incident = (await readIncidents(world))[0]
  assert.equal(incident.kind, 'data-loss')
  assert.equal(incident.severity, 'critical')
  assert.match(incident.summary, /数据骤降/)
  assert.equal(incident.evidence.data.before.files, 120)
  assert.equal(incident.evidence.data.after.files, 20)
  assert.equal(incident.evidence.data.statsSource, 'heartbeat')
  assert.equal(incident.evidence.data.baselineStatsSource, 'heartbeat')
  assert.equal(incident.recommendation.snapshotId, '20261028-130000-change')
  assert.match(incident.summary, /关键文件消失/)
  assert.ok(incident.evidence.data.missingTop.includes('.credentials.yaml'))
  // 数据骤降时记录当前进程命令行快照（只落本地事故文件，通知正文不含）
  assert.match(incident.evidence.process.main.commandLine, /DeepSeek Harness\.exe/)
  const notifyPayload = buildNotifyPayload(incident, world.config)
  assert.doesNotMatch(JSON.stringify(notifyPayload), /DeepSeek Harness\.exe/)
})

test('watchdog: 心跳过期时用扫描兜底，同源 baseline 下删文件仍能报 data-loss', async () => {
  const world = await makeWorld({ homeFiles: 10, thresholds: { dataLossMinFiles: 2 } })
  const before = await scanHomeDefault({ home: world.home })
  await writeBaseline(world, {
    files: before.files, bytes: before.bytes, sessions: before.sessions, storages: before.storages,
    profiles: before.profiles, attachments: before.attachments, credentials: before.credentials,
    keyFiles: before.keyFiles,
  }, NOW - HOUR, { statsSource: 'scan' })
  for (let i = 0; i < 8; i += 1) await fsp.unlink(path.join(world.home, `file-${i}.txt`))
  // 无心跳（DSH 没在跑/还没写过）→ current 只能来自扫描
  const { result } = await runWorld(world, { processInfo: absentProcess })
  assert.equal(result.statsSource, 'scan')
  assert.equal(result.incidents.length, 1)
  const incident = (await readIncidents(world))[0]
  assert.equal(incident.kind, 'data-loss')
  assert.equal(incident.evidence.data.statsSource, 'scan')
  assert.equal(incident.evidence.data.baselineStatsSource, 'scan')
})

/* ------------------------------------------- 统计口径对齐（task-12 回归） */

test('watchdog: scanHome 口径与插件 computeLightStats 对齐（sessions 第二层 / storages 递归）', async () => {
  const world = await makeWorld({ homeFiles: 0 })
  await seedHomeMetrics(world, {
    workspaceCounts: [20, 20, 20, 20, 20, 20, 18], // 7 个 workspace，共 138 个会话目录
    storageFiles: 130, // 130 + workspace.json = 131
    attachmentFiles: 5,
    profileDirs: 1,
  })
  const stats = await scanHomeDefault({ home: world.home })
  assert.equal(stats.sessions, 138, 'sessions 必须数第二层会话目录，而不是 workspace 目录数')
  assert.equal(stats.storages, 131, 'storages 数 maxDepth=3 内的文件（含 workspace.json）')
  assert.equal(stats.profiles, 1, 'profiles 数第一层目录')
  assert.equal(stats.attachments, 5, 'attachments 数 maxDepth=3 内的文件')
  assert.deepEqual(stats.keyFiles, { workspace: true, profile: true, credentials: true })
  assert.equal(stats.credentials, true)
  // 回归断言：旧实现误把 7 个 workspace 当成 7 个 session
  const workspaces = (await fsp.readdir(path.join(world.home, 'sessions'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).length
  assert.equal(workspaces, 7)
  assert.notEqual(stats.sessions, workspaces)
})

test('watchdog: 真实 138 会话布局不再误报 data-loss（baseline 与心跳同源）', async () => {
  const world = await makeWorld({ homeFiles: 0 })
  await seedHomeMetrics(world, {
    workspaceCounts: [20, 20, 20, 20, 20, 20, 18],
    storageFiles: 130,
    attachmentFiles: 5,
    profileDirs: 1,
  })
  const stats = {
    files: 1980, bytes: 254671422, sessions: 138, storages: 131, profiles: 1, attachments: 5,
    credentials: true, keyFiles: { workspace: true, profile: true, credentials: true },
  }
  await writeBaseline(world, stats, NOW - 2 * HOUR, { statsSource: 'heartbeat', source: 'monitor' })
  await writeHeartbeat(world, {
    bootId: 'boot-138', pid: 900, startedAt: NOW - 2 * HOUR, lastSeen: NOW - 1000, cleanExit: false,
    version: '0.5.1', stats,
  })
  const { result } = await runWorld(world, { processInfo: aliveProcess(900) })
  assert.equal(result.statsSource, 'heartbeat')
  assert.equal(result.incidents.length, 0, '138 会话是真实数据，绝不能判 data-loss')
  assert.equal((await readIncidents(world)).length, 0)
  assert.ok(!result.warnings.some((warning) => String(warning).startsWith('stats-mismatch')),
    '心跳与扫描口径一致时不应有 mismatch 警告')
})

test('watchdog: 心跳新鲜时即使扫描口径差异也不判 data-loss，只记 warning', async () => {
  const world = await makeWorld({ homeFiles: 0 })
  // 只有 7 个空 workspace（扫描会退化成 7），但真实心跳说 138 → 1.0.0 会误报
  for (let w = 0; w < 7; w += 1) {
    await fsp.mkdir(path.join(world.home, 'sessions', `workspace-${w}`), { recursive: true })
  }
  const heartbeatStats = {
    files: 1980, bytes: 254671422, sessions: 138, storages: 131, profiles: 1, attachments: 0,
    credentials: true, keyFiles: { workspace: true, profile: true, credentials: true },
  }
  await writeBaseline(world, heartbeatStats, NOW - 2 * HOUR, { statsSource: 'heartbeat' })
  await writeHeartbeat(world, {
    bootId: 'boot-mismatch', pid: 901, startedAt: NOW - 2 * HOUR, lastSeen: NOW - 1000, cleanExit: false,
    stats: heartbeatStats,
  })
  const { result } = await runWorld(world, { processInfo: aliveProcess(901) })
  assert.equal(result.statsSource, 'heartbeat', '新鲜心跳优先，扫描只作兜底')
  assert.equal(result.incidents.length, 0, '扫描与心跳差异不能直接判 data-loss')
  assert.ok(result.warnings.some((warning) => String(warning).startsWith('stats-mismatch') &&
    String(warning).includes('sessions')))
  const state = await readJson(path.join(world.monitorDir, 'watchdog-state.json'))
  assert.equal(state.statsSource, 'heartbeat')
})

test('watchdog: 1.0.0 遗留的 scan 口径 baseline 会被自愈重写为心跳口径', async () => {
  const world = await makeWorld({ homeFiles: 0 })
  await seedHomeMetrics(world, {
    workspaceCounts: [20, 20, 20, 20, 20, 20, 18],
    storageFiles: 130,
    attachmentFiles: 0,
    profileDirs: 1,
  })
  // 1.0.0 误报现场：watchdog 用 scan 口径写的 baseline（sessions=7、storages=工作区条目数），
  // 而且没有 statsSource 字段 → 必须按 scan 兼容识别，健康时立刻重写。
  await writeBaseline(world, {
    files: 5000, bytes: 900000, sessions: 7, storages: 3, profiles: 1, attachments: 0, credentials: true,
  }, NOW - HOUR, { source: 'watchdog' })
  const heartbeatStats = {
    files: 1980, bytes: 254671422, sessions: 138, storages: 131, profiles: 1, attachments: 0,
    credentials: true, keyFiles: { workspace: true, profile: true, credentials: true },
  }
  await writeHeartbeat(world, {
    bootId: 'boot-legacy', pid: 902, startedAt: NOW - 2 * HOUR, lastSeen: NOW - 1000, cleanExit: false,
    stats: heartbeatStats,
  })
  const { result } = await runWorld(world, { processInfo: aliveProcess(902) })
  assert.equal(result.statsSource, 'heartbeat')
  assert.equal(result.incidents.length, 0, '遗留 scan baseline 不能触发 138=7 误报')
  assert.equal(result.baselineUpdated, true, '健康时立即重写为心跳口径 baseline（不等 24h）')
  const baseline = await readJson(path.join(world.monitorDir, 'baseline.json'))
  assert.equal(baseline.statsSource, 'heartbeat')
  assert.equal(baseline.stats.sessions, 138)
  assert.equal(baseline.stats.storages, 131)
  assert.equal(baseline.stats.files, 1980)
})

/* --------------------------------------------------------- backup-corrupt */

test('watchdog: 备份缺块 → backup-corrupt，报告具体快照与文件', async () => {
  const world = await makeWorld({ homeFiles: 1 })
  const goodHash = await sha256('good-blob')
  const missingHash = await sha256('missing-blob')
  // 只写入 good-blob，missing-blob 被“删掉”
  await seedBackup(world, {
    blobs: { [goodHash]: 'good-blob' },
    manifests: [manifestFor('20261028-150000-change', NOW - 10 * 60 * 1000, {
      'AGENTS.md': { s: 9, m: NOW, c: [goodHash] },
      'sessions/broken.json': { s: 12, m: NOW, c: [missingHash] },
    })],
  })
  const { result } = await runWorld(world, { processInfo: absentProcess })
  assert.equal(result.incidents.length, 1)
  const incident = (await readIncidents(world))[0]
  assert.equal(incident.kind, 'backup-corrupt')
  assert.equal(incident.severity, 'high')
  assert.match(incident.summary, /备份仓库异常/)
  const bad = incident.evidence.backup.bad
  assert.equal(bad.length, 1)
  assert.equal(bad[0].id, '20261028-150000-change')
  assert.ok(bad[0].missing.includes('sessions/broken.json'))
  assert.ok(incident.impact.local.bad.some((item) => item.id === '20261028-150000-change'))
})

/* --------------------------------------------------------------- disk-low */

test('watchdog: 备份盘剩余低于阈值 → disk-low', async () => {
  const world = await makeWorld({ homeFiles: 1 })
  const { result } = await runWorld(world, {
    processInfo: absentProcess,
    disk: { ok: true, freeBytes: 5 * 1024 ** 3, totalBytes: 500 * 1024 ** 3, path: 'D:\\' },
  })
  assert.equal(result.incidents.length, 1)
  const incident = (await readIncidents(world))[0]
  assert.equal(incident.kind, 'disk-low')
  assert.equal(incident.severity, 'medium')
  assert.match(incident.summary, /低于阈值/)
})

/* ----------------------------------------------------------- offsite-stale */

test('watchdog: 异地副本 >48h 未同步 → offsite-stale', async () => {
  const world = await makeWorld({ homeFiles: 1 })
  await writeHeartbeat(world, {
    bootId: 'boot-off', pid: 321, startedAt: NOW - 5 * HOUR, lastSeen: NOW - 2000, cleanExit: false,
    offsite: { configured: true, locked: true, lastExportAt: NOW - 3 * DAY, lastSyncAt: NOW - 3 * DAY, peerOnline: false, archives: 4 },
  })
  const { result } = await runWorld(world, { processInfo: aliveProcess(321) })
  assert.equal(result.incidents.length, 1)
  const incident = (await readIncidents(world))[0]
  assert.equal(incident.kind, 'offsite-stale')
  assert.match(incident.summary, /异地副本过期/)
  assert.equal(incident.evidence.offsite.archives, 4)
})

/* ------------------------------------------------------- 通知饱和式 fan-out */

test('watchdog: 通知 fan-out 单路失败不影响其它通道，并写 outbox', async () => {
  const world = await makeWorld({
    homeFiles: 2,
    notify: {
      panel: true,
      toast: true,
      retries: 2,
      webhook: [
        { name: 'ok-hook', url: 'https://ok.test/hook', enabled: true, retries: 0 },
        { name: 'bad-hook', url: 'https://bad.test/hook', enabled: true, retries: 2 },
      ],
      email: { enabled: true, host: 'smtp.test', port: 587, useSsl: true, user: '', from: 'dsh@test', to: ['ops@test'] },
      qq: { enabled: true, http: 'https://qq.test', target: '10001' },
      peer: { enabled: true },
    },
  })
  await writeHeartbeat(world, {
    bootId: 'boot-notify', pid: 808, startedAt: NOW - 3 * HOUR,
    lastSeen: NOW - 6 * 60 * 1000, cleanExit: false,
  })
  const runCommandCalls = []
  const { result } = await runWorld(world, {
    processInfo: absentProcess,
    enableNotify: true,
    runCommand: async (exe, args) => {
      runCommandCalls.push({ exe, args })
      if (args.some((arg) => String(arg).includes('toast.ps1'))) {
        return { ok: false, code: 1, stdout: '', stderr: 'toast: unavailable' }
      }
      if (args.some((arg) => String(arg).includes('notify.ps1'))) {
        return { ok: false, code: 1, stdout: '', stderr: 'email: SMTP_AUTH' }
      }
      return { ok: true, code: 0, stdout: '', stderr: '' }
    },
    fetch: async (url) => {
      if (String(url).includes('bad.test')) return { ok: false, status: 500 }
      return { ok: true, status: 200 }
    },
  })

  assert.equal(result.incidents.length, 1)
  const notification = result.channels[0].results
  const byName = (channel, name) => notification.find((entry) => entry.channel === channel && (name === undefined || entry.name === name))
  assert.equal(byName('panel').ok, true)
  assert.equal(byName('toast').ok, false, 'toast 失败不影响其它通道')
  assert.equal(byName('webhook', 'ok-hook').ok, true)
  assert.equal(byName('webhook', 'bad-hook').ok, false)
  assert.equal(byName('webhook', 'bad-hook').attempts, 3, '失败 webhook 重试 2 次（共 3 次尝试）')
  assert.equal(byName('email').ok, false)
  assert.equal(byName('email').error, 'SMTP_AUTH')
  assert.equal(byName('qq').ok, true)
  assert.equal(byName('peer').queued, true)

  // 事故文件里记录每个通道的结果（便于面板展示）
  const incident = (await readIncidents(world))[0]
  assert.equal(incident.notify.channels.length, notification.length)

  // peer 需要插件起来后补发 → 必定有 outbox，且正文不含路径
  const outboxDir = path.join(world.monitorDir, 'outbox')
  const names = (await fsp.readdir(outboxDir)).filter((name) => name.endsWith('.json'))
  assert.equal(names.length, 1)
  const outbox = await readJson(path.join(outboxDir, names[0]))
  assert.equal(outbox.status, 'pending')
  assert.equal(outbox.channels.peer.status, 'pending')
  assert.doesNotMatch(JSON.stringify(outbox), /C:\\\\Users|sessions\//)
  assert.ok(runCommandCalls.length >= 2, 'toast 与 email 都应该被尝试过')
})

test('watchdog: webhook 重试策略（失败两次后成功）', async () => {
  let attempts = 0
  const okResult = await postJsonWithRetry({
    url: 'https://flaky.test/hook',
    payload: { hello: 'world' },
    retries: 2,
    sleep: async () => {},
    fetchFn: async () => {
      attempts += 1
      return attempts < 3 ? { ok: false, status: 503 } : { ok: true, status: 200 }
    },
  })
  assert.equal(okResult.ok, true)
  assert.equal(okResult.attempts, 3)

  const failed = await postJsonWithRetry({
    url: 'https://down.test/hook',
    payload: {},
    retries: 2,
    sleep: async () => {},
    fetchFn: async () => ({ ok: false, status: 500 }),
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.attempts, 3)
  assert.equal(failed.error, 'http-500')
})

test('watchdog: outbox 在 qq 直发失败后排队，下一轮补发成功', async () => {
  const world = await makeWorld({
    homeFiles: 1,
    notify: {
      panel: true, toast: false, webhook: [], email: { enabled: false },
      qq: { enabled: true, http: 'https://qq.test', target: '10001' },
      peer: { enabled: false },
    },
  })
  await writeHeartbeat(world, {
    bootId: 'boot-outbox', pid: 606, startedAt: NOW - 2 * HOUR,
    lastSeen: NOW - 5 * 60 * 1000, cleanExit: false,
  })
  const failFetch = async () => ({ ok: false, status: 500 })
  const first = await runWorld(world, { processInfo: absentProcess, enableNotify: true, fetch: failFetch })
  assert.equal(first.result.incidents.length, 1)
  const outboxDir = path.join(world.monitorDir, 'outbox')
  let outboxNames = (await fsp.readdir(outboxDir)).filter((name) => name.endsWith('.json'))
  assert.equal(outboxNames.length, 1)
  let outbox = await readJson(path.join(outboxDir, outboxNames[0]))
  assert.equal(outbox.channels.qq.status, 'pending')
  assert.equal(outbox.status, 'pending')

  // 第二轮：qq 恢复；同 kind 30 分钟内只合并，不重复通知，但 outbox 要补发
  const second = await runWorld(world, {
    processInfo: absentProcess,
    enableNotify: true,
    now: NOW + 60000,
    fetch: async () => ({ ok: true, status: 200 }),
  })
  assert.equal(second.result.incidents.length, 0)
  assert.equal(second.result.merged.length, 1)
  outbox = await readJson(path.join(outboxDir, outboxNames[0]))
  assert.equal(outbox.channels.qq.status, 'sent')
  assert.equal(outbox.status, 'sent')
})

test('watchdog: qq 已启用但缺 OneBot HTTP → 仍然写 outbox（不静默丢弃）', async () => {
  const world = await makeWorld({
    homeFiles: 1,
    notify: {
      panel: true, toast: false, webhook: [], email: { enabled: false },
      qq: { enabled: true, http: '', token: '', action: 'send_private_msg', target: '10001' },
      peer: { enabled: false },
    },
  })
  await writeHeartbeat(world, {
    bootId: 'boot-qq-nohttp', pid: 505, startedAt: NOW - 2 * HOUR,
    lastSeen: NOW - 5 * 60 * 1000, cleanExit: false,
  })
  const { result } = await runWorld(world, { processInfo: absentProcess, enableNotify: true })
  assert.equal(result.incidents.length, 1)
  const channel = result.channels[0].results.find((entry) => entry.channel === 'qq')
  assert.equal(channel.queued, true)
  assert.equal(channel.reason, 'no-http')
  const outboxDir = path.join(world.monitorDir, 'outbox')
  const names = (await fsp.readdir(outboxDir)).filter((name) => name.endsWith('.json'))
  assert.equal(names.length, 1)
  const outbox = await readJson(path.join(outboxDir, names[0]))
  assert.equal(outbox.channels.qq.status, 'pending')
  assert.equal(outbox.status, 'pending')
})

/* --------------------------------------------------------------- 锁/去重 */

test('watchdog: 单实例锁（持锁拒绝、过期可抢占、runOnce 跳过）', async () => {
  const world = await makeWorld({ homeFiles: 1 })
  const lockPath = world.lockPath
  const first = await acquireLock(lockPath, { now: NOW, staleMs: 120000, isAlive: () => true })
  assert.equal(first.held, true)

  const blocked = await acquireLock(lockPath, { now: NOW + 1000, staleMs: 120000, isAlive: () => true })
  assert.equal(blocked.held, false)
  assert.equal(blocked.reason, 'locked')

  const skipped = await runWorld(world, { now: NOW + 2000, processInfo: absentProcess })
  assert.equal(skipped.result.skipped, 'locked')
  assert.equal(skipped.result.incidents.length, 0)

  await first.release()
  const afterRelease = await acquireLock(lockPath, { now: NOW + 3000, staleMs: 120000, isAlive: () => true })
  assert.equal(afterRelease.held, true)
  await afterRelease.release()

  // 过期锁（写一个 5 分钟前的锁）可抢占
  await writeJson(lockPath, { v: 1, pid: 999999, token: 'stale', startedAt: NOW - 5 * 60 * 1000 })
  const stolen = await acquireLock(lockPath, { now: NOW, staleMs: 120000, isAlive: () => true })
  assert.equal(stolen.held, true)
  assert.equal(stolen.stolen, true)
  await stolen.release()
})

test('watchdog: 同 kind 30 分钟内合并 timeline，不重复通知', async () => {
  const world = await makeWorld({ homeFiles: 1 })
  await writeHeartbeat(world, {
    bootId: 'boot-dedupe', pid: 202, startedAt: NOW - 4 * HOUR,
    lastSeen: NOW - 5 * 60 * 1000, cleanExit: false,
  })
  const first = await runWorld(world, { processInfo: absentProcess, enableNotify: true })
  assert.equal(first.result.incidents.length, 1)
  const incidentId = first.result.incidents[0].id
  const before = await readIncidents(world)
  const timelineBefore = before[0].timeline.length

  const second = await runWorld(world, {
    processInfo: absentProcess, enableNotify: true, now: NOW + 60 * 1000,
  })
  assert.equal(second.result.incidents.length, 0)
  assert.equal(second.result.merged.length, 1)
  assert.equal(second.result.merged[0].id, incidentId)
  assert.equal(second.result.channels.length, 0, '合并的事故不重复通知')
  const afterIncident = (await readIncidents(world))[0]
  assert.equal(afterIncident.id, incidentId)
  assert.ok(afterIncident.timeline.length > timelineBefore)
  assert.ok(afterIncident.timeline.some((entry) => entry.type === 'repeat'))
})

/* --------------------------------------------------------------- baseline */

test('watchdog: baseline 仅健康时更新，且 24h 最多一次', async () => {
  const world = await makeWorld({ homeFiles: 3 })
  const heartbeat = {
    bootId: 'boot-baseline', pid: 707, startedAt: NOW - 2 * HOUR, cleanExit: false,
    stats: {
      files: 3, bytes: 30, sessions: 1, storages: 0, profiles: 1, attachments: 0, credentials: true,
      keyFiles: { workspace: true, profile: true, credentials: true },
    },
  }
  await writeHeartbeat(world, { ...heartbeat, lastSeen: NOW - 1000 })
  const first = await runWorld(world, { processInfo: aliveProcess(707) })
  assert.equal(first.result.baselineUpdated, true)
  const baseline = await readJson(path.join(world.monitorDir, 'baseline.json'))
  assert.equal(baseline.source, 'watchdog')
  assert.equal(baseline.stats.files, 3)
  assert.equal(baseline.statsSource, 'heartbeat', 'baseline 只用心跳口径写，保证与 current 同源')
  assert.deepEqual(baseline.stats.keyFiles, { workspace: true, profile: true, credentials: true })

  await writeHeartbeat(world, { ...heartbeat, lastSeen: NOW + 30 * 1000 - 1000 })
  const second = await runWorld(world, { processInfo: aliveProcess(707), now: NOW + 30 * 1000 })
  assert.equal(second.result.baselineUpdated, false, '24h 内不重复更新')

  await writeHeartbeat(world, { ...heartbeat, lastSeen: NOW + DAY + 60 * 1000 - 1000 })
  const third = await runWorld(world, { processInfo: aliveProcess(707), now: NOW + DAY + 60 * 1000 })
  assert.equal(third.result.baselineUpdated, true, '超过 24h 再更新')
})

/* --------------------------------------------------------------- 安全约束 */

test('watchdog: 只读 home —— 运行前后 home 文件树完全不变', async () => {
  const world = await makeWorld({ homeFiles: 6 })
  await writeHeartbeat(world, {
    bootId: 'boot-readonly', pid: 303, startedAt: NOW - HOUR, lastSeen: NOW - 5 * 60 * 1000, cleanExit: false,
  })
  const before = await listTree(world.home)
  const { calls } = await runWorld(world, { processInfo: absentProcess })
  const afterTree = await listTree(world.home)
  assert.deepEqual(afterTree, before)
  assert.ok(!afterTree.some((rel) => rel.startsWith('.dsh')), '不得在 home 下创建 .dsh')
  // 除注入的只读查询外，没有任何外部命令（更不可能有 stop/kill）
  assert.equal(calls.runCommand.length, 0)
})

test('watchdog: 事故/日志 90 天保留清理只删单个旧文件', async () => {
  const world = await makeWorld({ homeFiles: 1 })
  const incidentsDir = path.join(world.monitorDir, 'incidents')
  const outboxDir = path.join(world.monitorDir, 'outbox')
  await writeJson(path.join(incidentsDir, '20200101-000000-crash.json'), {
    v: 1, id: '20200101-000000-crash', kind: 'crash', status: 'open', severity: 'high',
    detectedAt: NOW - 100 * DAY, firstAt: NOW - 100 * DAY, lastAt: NOW - 100 * DAY, summary: 'old',
    timeline: [], evidence: {}, impact: {}, recommendation: {}, recovery: { status: 'none' },
  })
  await writeJson(path.join(outboxDir, '20200101-000000-crash.json'), {
    v: 1, incidentId: 'old', status: 'sent', createdAt: NOW - 100 * DAY, channels: {},
  })
  const { result } = await runWorld(world, { processInfo: absentProcess })
  assert.equal(result.maintenance.incidents, 1)
  assert.equal(result.maintenance.outbox, 1)
  assert.equal(await exists(path.join(incidentsDir, '20200101-000000-crash.json')), false)
  assert.equal(await exists(path.join(outboxDir, '20200101-000000-crash.json')), false)
})

/* --------------------------------------------------------------- 安装器 */

const installerScript = path.join(REPO, 'scripts', 'install-external.ps1')

async function makeInstallerFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-wd-inst-'))
  worlds.push(root)
  const fixture = path.join(root, 'fixture')
  const dirs = {
    recovery: path.join(root, 'Recovery'),
    store: path.join(root, 'store'),
    dsh: path.join(root, 'dsh-home'),
    startup: path.join(root, 'startup'),
    desktop: path.join(root, 'desktop'),
    startmenu: path.join(root, 'startmenu'),
    manual: path.join(root, 'manual'),
    // 每次测试用独立任务名：避免真实机器上已部署 DSH-DisasterWatchdog（或并发测试）
    // 让 dry-run 的 task.action 在 register/update 之间抖动。
    taskName: `DSH-DisasterWatchdog-Test-${Math.random().toString(36).slice(2, 8)}`,
  }
  // 故意不预建 RecoveryHome：dry-run 断言它不会被创建。
  for (const dir of [dirs.store, dirs.dsh, dirs.startup, dirs.desktop, dirs.startmenu, dirs.manual]) {
    await fsp.mkdir(dir, { recursive: true })
  }
  await writeJson(path.join(fixture, 'package.json'), { name: 'dsh-disaster-recovery', version: '9.9.9', type: 'module' })
  await fsp.mkdir(path.join(fixture, 'scripts'), { recursive: true })
  await fsp.writeFile(path.join(fixture, 'scripts', 'cli.mjs'), '// cli\n')
  await fsp.writeFile(path.join(fixture, 'scripts', 'recover.mjs'), '// recover\n')
  await fsp.writeFile(path.join(fixture, 'scripts', 'dpapi.ps1'), '# dpapi\n')
  await fsp.mkdir(path.join(fixture, 'src', 'archive'), { recursive: true })
  await fsp.writeFile(path.join(fixture, 'src', 'engine.js'), '// engine\n')
  await fsp.writeFile(path.join(fixture, 'src', 'archive', 'repo.js'), '// repo\n')
  await fsp.mkdir(path.join(fixture, 'locale'), { recursive: true })
  await fsp.writeFile(path.join(fixture, 'locale', 'zh.json'), '{}\n')
  await fsp.writeFile(path.join(fixture, 'locale', 'en.json'), '{}\n')
  await fsp.mkdir(path.join(fixture, 'watchdog'), { recursive: true })
  await fsp.writeFile(path.join(fixture, 'watchdog', 'watchdog.mjs'), "export const WATCHDOG_VERSION = '0.0.1'\n")
  await fsp.writeFile(path.join(fixture, 'watchdog', 'toast.ps1'), 'param()\n')
  await fsp.writeFile(path.join(fixture, 'watchdog', 'notify.ps1'), 'param()\n')
  await fsp.mkdir(path.join(fixture, 'recovery-console'), { recursive: true })
  await fsp.writeFile(path.join(fixture, 'recovery-console', 'console.mjs'), '// console\n')
  await fsp.writeFile(path.join(fixture, 'recovery-console', 'recovery-console.ps1'), 'param()\n')
  await fsp.writeFile(path.join(fixture, 'recovery-console', 'README.txt'), 'readme\n')
  await fsp.writeFile(path.join(dirs.startup, 'DSH-HomeTripwire.cmd'),
    '@echo off\r\nstart "" "C:\\Program Files\\PowerShell\\7\\pwsh.exe" -File "D:\\???\\_recovery\\tripwire.ps1"\r\n')
  return { root, fixture, dirs }
}

function installerArgs(sourcePath, dirs, extra = []) {
  return [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installerScript,
    '-Source', sourcePath,
    '-RecoveryHome', dirs.recovery,
    '-StoreRoot', dirs.store,
    '-DshHome', dirs.dsh,
    '-StartupDir', dirs.startup,
    '-DesktopDir', dirs.desktop,
    '-StartMenuDir', dirs.startmenu,
    '-ManualDir', dirs.manual,
    '-NodePath', process.execPath,
    '-TaskName', dirs.taskName,
    '-Quiet',
    ...extra,
  ]
}

function runPowerShell(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(PS_EXE, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      resolve({ code: -1, stdout, stderr: `${stderr}\ntimeout`, timedOut: true })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

function parseInstallerJson(stdout) {
  const lines = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (!line.startsWith('{')) continue
    try { return JSON.parse(line) } catch { /* 继续往上找 */ }
  }
  return null
}

test('install-external: 默认 dry-run —— 输出 JSON 计划且一个文件都不写', { skip: !IS_WINDOWS }, async () => {
  const fixture = await makeInstallerFixture()
  const { stdout, stderr, code } = await runPowerShell(installerArgs(fixture.fixture, fixture.dirs))
  assert.equal(code, 0, `installer 退出码应为 0；stderr=${stderr}`)
  const summary = parseInstallerJson(stdout)
  assert.ok(summary, `stdout 应包含 JSON：${stdout.slice(0, 500)}`)
  assert.equal(summary.ok, true)
  assert.equal(summary.mode, 'dry-run')
  assert.equal(summary.recoveryHome, fixture.dirs.recovery)
  assert.equal(summary.task.name, fixture.dirs.taskName)
  // 独立任务名 → 一定不存在，计划必然是 register；容忍真实环境秒级并发（update 也可接受）。
  assert.ok(['register', 'update'].includes(summary.task.action), `unexpected task.action=${summary.task.action}`)
  assert.match(summary.task.arguments, /run-hidden\.vbs/)
  assert.match(summary.task.execute, /wscript\.exe$/i)
  assert.equal(summary.task.hidden, true, '看门狗任务必须用隐藏启动器，避免每分钟弹控制台')
  assert.equal(summary.task.trigger.everyMinutes, 1)
  assert.equal(summary.shortcuts.length, 2)
  assert.ok(summary.shortcuts.every((item) => item.action === 'create'))
  assert.ok(summary.shortcuts.every((item) => /recovery-console\.ps1$/.test(item.arguments.replace(/^.*-File\s+"?/, '').replace(/"$/, ''))))
  assert.ok(summary.copied.scripts.includes('recovery-console.ps1'))
  assert.ok(summary.copied.monitor.includes('watchdog.mjs'))
  assert.ok(summary.copied.plugin.includes('scripts/cli.mjs'))
  assert.ok(summary.copied.plugin.includes('src/engine.js'))
  assert.equal(summary.config.action, 'create')
  assert.equal(summary.backup.tripwire.found, true)
  assert.equal(summary.backup.tripwire.copied, false, 'dry-run 不备份')
  assert.equal(summary.backup.tripwire.removed, false, 'dry-run 不删除')
  // 结论：dry-run 阶段没有创建任何目标目录、旧启动项还在
  assert.equal(await exists(fixture.dirs.recovery), false)
  assert.equal(await exists(fixture.dirs.manual), true) // 原本就存在的空目录
  assert.equal(await exists(path.join(fixture.dirs.startup, 'DSH-HomeTripwire.cmd')), true)
})

test('install-external: -Apply 幂等 —— 目录/config/快捷方式/tripwire 备份替换', { skip: !IS_WINDOWS }, async () => {
  const fixture = await makeInstallerFixture()
  const first = await runPowerShell(installerArgs(fixture.fixture, fixture.dirs, ['-Apply', '-NoTask']))
  assert.equal(first.code, 0, `apply 退出码应为 0；stderr=${first.stderr}`)
  const summary = parseInstallerJson(first.stdout)
  assert.ok(summary)
  assert.equal(summary.ok, true)
  assert.equal(summary.mode, 'apply')
  assert.equal(summary.task.action, 'skipped', '-NoTask 测试不装真实任务')

  // scripts\recovery-console.ps1（快捷方式入口）必须就位
  assert.equal(await exists(path.join(fixture.dirs.recovery, 'scripts', 'recovery-console.ps1')), true)
  assert.equal(await exists(path.join(fixture.dirs.recovery, 'scripts', 'console.mjs')), true)
  // monitor\ 完整（watchdog + 通知脚本 + dpapi）
  assert.equal(await exists(path.join(fixture.dirs.recovery, 'monitor', 'watchdog.mjs')), true)
  assert.equal(await exists(path.join(fixture.dirs.recovery, 'monitor', 'toast.ps1')), true)
  assert.equal(await exists(path.join(fixture.dirs.recovery, 'monitor', 'notify.ps1')), true)
  assert.equal(await exists(path.join(fixture.dirs.recovery, 'monitor', 'dpapi.ps1')), true)
  // plugin\ 自包含副本
  assert.equal(await exists(path.join(fixture.dirs.recovery, 'plugin', 'scripts', 'cli.mjs')), true)
  assert.equal(await exists(path.join(fixture.dirs.recovery, 'plugin', 'scripts', 'recover.mjs')), true)
  assert.equal(await exists(path.join(fixture.dirs.recovery, 'plugin', 'src', 'archive', 'repo.js')), true)
  assert.equal(await exists(path.join(fixture.dirs.recovery, 'plugin', 'locale', 'zh.json')), true)
  // config.json
  const configPath = path.join(fixture.dirs.recovery, 'monitor', 'config.json')
  const config = await readJson(configPath)
  assert.equal(config.storeRoot, fixture.dirs.store)
  assert.equal(config.home, fixture.dirs.dsh)
  assert.equal(config.v, 1)
  assert.equal(config.notify.panel, true)
  assert.equal(config.notify.email.enabled, false, '外部通道默认关闭但结构就绪')
  assert.deepEqual(config.notify.webhook, [])
  assert.equal(config.notify.qq.enabled, false)
  assert.equal(config.notify.peer.enabled, false)
  assert.ok(config.thresholds.diskLowFreeBytes > 0)
  assert.ok(config.installedAt > 0)
  // 快捷方式
  assert.equal(await exists(path.join(fixture.dirs.startmenu, 'Deepseek恢复.lnk')), true)
  assert.equal(await exists(path.join(fixture.dirs.desktop, 'Deepseek恢复.lnk')), true)
  // version.json
  assert.equal(await exists(path.join(fixture.dirs.recovery, 'version.json')), true)
  // tripwire：先备份再删启动项
  assert.equal(await exists(path.join(fixture.dirs.startup, 'DSH-HomeTripwire.cmd')), false)
  const manualEntries = await fsp.readdir(fixture.dirs.manual)
  const backupDir = manualEntries.find((name) => name.endsWith('-home-tripwire-backup'))
  assert.ok(backupDir, `应在 manual 下生成 tripwire 备份目录：${manualEntries.join(',')}`)
  const backupRoot = path.join(fixture.dirs.manual, backupDir)
  assert.equal(await exists(path.join(backupRoot, 'DSH-HomeTripwire.cmd')), true)
  const manifest = await readJson(path.join(backupRoot, 'manifest.json'))
  assert.match(manifest.sha256, /^[0-9A-F]{64}$/)
  assert.match(manifest.reason, /看门狗/)
  assert.equal(summary.backup.tripwire.copied, true)
  assert.equal(summary.backup.tripwire.removed, true)

  // 第二次 -Apply：幂等；用户对 config 的修改要保留
  const installedAtBefore = config.installedAt
  config.thresholds.heartbeatStaleMs = 99999
  config.notify.toast = false
  await writeJson(configPath, config)
  const second = await runPowerShell(installerArgs(fixture.fixture, fixture.dirs, ['-Apply', '-NoTask']))
  assert.equal(second.code, 0, `第二次 apply 退出码应为 0；stderr=${second.stderr}`)
  const summary2 = parseInstallerJson(second.stdout)
  assert.equal(summary2.ok, true)
  assert.equal(summary2.config.action, 'merge')
  assert.equal(summary2.backup.tripwire.found, false, '已替换过，第二次没有 tripwire 可处理')
  const configAfter = await readJson(configPath)
  assert.equal(configAfter.installedAt, installedAtBefore, 'installedAt 不应被重写')
  assert.equal(configAfter.thresholds.heartbeatStaleMs, 99999, '用户修改的阈值要保留')
  assert.equal(configAfter.notify.toast, false, '用户关闭的通道要保留')
  assert.equal(await exists(path.join(fixture.dirs.recovery, 'monitor', 'watchdog.mjs')), true)
})

test('watchdog: 安装器 dry-run 缺少 recovery-console 时只警告不失败', { skip: !IS_WINDOWS }, async () => {
  const fixture = await makeInstallerFixture()
  // 把 recovery-console/ 挪走，模拟 console 队友还没产出
  await fsp.rename(path.join(fixture.fixture, 'recovery-console'), path.join(fixture.fixture, 'recovery-console-away'))
  const { stdout, code } = await runPowerShell(installerArgs(fixture.fixture, fixture.dirs))
  assert.equal(code, 0)
  const summary = parseInstallerJson(stdout)
  assert.equal(summary.ok, true)
  assert.ok(summary.warnings.some((message) => String(message).includes('recovery-console')))
  assert.equal(summary.copied.scripts.length, 0)
})

/* ----------------------------------------------------- 纯函数补充断言 */

test('watchdog: inspectBackup quick/deep 与 classifyAll 纯函数契约', async () => {
  const world = await makeWorld({ homeFiles: 1 })
  const blobHash = await sha256('pure')
  await seedBackup(world, {
    blobs: { [blobHash]: 'pure' },
    manifests: [
      manifestFor('20261028-150000-change', NOW - 10 * 60 * 1000, { 'a.txt': { s: 4, m: NOW, c: [blobHash] } }),
      manifestFor('20261028-140000-change', NOW - 70 * 60 * 1000, { 'a.txt': { s: 4, m: NOW, c: [blobHash] } }),
    ],
  })
  const quick = await inspectBackup({ storeDir: world.storeDir, monitorDir: world.monitorDir, mode: 'quick', limit: 1, now: NOW })
  assert.equal(quick.ok, true)
  assert.equal(quick.checked, 1)
  assert.equal(quick.snapshotsTotal, 2)
  const deep = await inspectBackup({ storeDir: world.storeDir, monitorDir: world.monitorDir, mode: 'deep', now: NOW })
  assert.equal(deep.checked, 2)
  assert.equal(deep.snapshots.every((snap) => snap.status === 'ok'), true)

  // classifyAll 只读：不写文件、不抛异常
  const classification = classifyAll({
    config: normalizeConfig({}).config,
    now: NOW,
    heartbeat: null,
    baseline: null,
    processInfo: absentProcess,
    events: { application: [], system: [] },
    homeStats: { ok: true, exists: true, files: 1, bytes: 4, sessions: 0, storages: 0, profiles: 0, credentials: false },
    backup: quick,
    offsite: null,
    disk: { ok: true, freeBytes: 500 * 1024 ** 3 },
    state: {},
  })
  assert.deepEqual(classification.drafts, [])
  assert.equal(classification.health.healthy, false, '没有心跳时不算健康')
  assert.equal(typeof formatDuration(120000), 'string')
  assert.equal(WATCHDOG_VERSION, '1.0.2', 'task-16 通知通道自检版本')
})

test('watchdog: flushOutbox 对已 sent 条目不再发', async () => {
  const world = await makeWorld({ homeFiles: 0 })
  const outboxDir = path.join(world.monitorDir, 'outbox')
  await writeJson(path.join(outboxDir, 'sent.json'), {
    v: 1, incidentId: 'sent', status: 'sent', createdAt: NOW, channels: { qq: { status: 'sent' } }, payload: { body: 'x' },
  })
  let fetchCalls = 0
  const results = await flushOutbox({
    monitorDir: world.monitorDir,
    config: normalizeConfig({}).config,
    secrets: { ok: false, reason: 'missing' },
    deps: { fetchFn: async () => { fetchCalls += 1; return { ok: true, status: 200 } }, sleep: async () => {} },
    now: NOW,
  })
  assert.equal(results.length, 0)
  assert.equal(fetchCalls, 0)
})

/* ------------------------------------------------ ack / 插件 outbox 接管 */

test('watchdog: 面板 ack 后同 kind 不再重建/再弹；条件消失后才允许新事故', async () => {
  const world = await makeWorld({ homeFiles: 1 })
  const crashHeartbeat = (lastSeen) => ({
    bootId: 'boot-ack', pid: 1201, startedAt: NOW - 6 * HOUR, lastSeen, cleanExit: false,
  })
  await writeHeartbeat(world, crashHeartbeat(NOW - 5 * 60 * 1000))
  const first = await runWorld(world, { processInfo: absentProcess, enableNotify: true })
  assert.equal(first.result.incidents.length, 1)
  const incidentId = first.result.incidents[0].id

  // 面板「忽略」：monitor.js 只写 alerts/ack.json，不改 incidents 文件
  await writeJson(path.join(world.monitorDir, 'alerts', 'ack.json'), {
    v: 1, acked: { [incidentId]: NOW + 60 * 1000 },
  })
  const second = await runWorld(world, {
    processInfo: absentProcess, enableNotify: true, now: NOW + 60 * 1000,
  })
  assert.equal(second.result.incidents.length, 0, 'ack 后不再新建事故')
  assert.equal(second.result.merged.length, 0, 'ack 后也不再合并回 open')
  assert.equal(second.result.channels.length, 0, 'ack 后不再重复通知')
  assert.ok(second.result.suppressed.some((item) => item.kind === 'crash' && item.reason === 'acked'))
  assert.equal((await readIncidents(world)).length, 1, '事故文件仍保留 1 份')
  const alerts = await readAlerts(world)
  assert.equal(alerts.incidents.length, 0, 'alerts/current.json 里 ack 过的条目应被过滤')

  // 条件消失（进程回来、心跳新鲜）→ 清掉 state 里的 ack 抑制引用
  const resolvedAt = NOW + 3 * HOUR
  await writeHeartbeat(world, { ...crashHeartbeat(resolvedAt - 1000), bootId: 'boot-ack-2' })
  await runWorld(world, { processInfo: aliveProcess(1201), now: resolvedAt })
  const state = await readJson(path.join(world.monitorDir, 'watchdog-state.json'))
  assert.equal(state.incidents.crash, undefined, '条件消失后应清掉抑制引用')

  // 再次崩溃（>30min 去重窗口 + 已 ack 的旧事故不再吸收）→ 允许新事故并通知
  const againAt = resolvedAt + HOUR
  await writeHeartbeat(world, { ...crashHeartbeat(againAt - 5 * 60 * 1000), bootId: 'boot-ack-3' })
  const third = await runWorld(world, { processInfo: absentProcess, enableNotify: true, now: againAt })
  assert.equal(third.result.incidents.length, 1, '旧事故 ack/已关闭后，新崩溃应重新提醒')
  assert.notEqual(third.result.incidents[0].id, incidentId)
})

test('watchdog: flushOutbox 接管插件 monitor.js 排队的 toast/webhook/email/qq', async () => {
  const world = await makeWorld({ homeFiles: 0 })
  const outboxDir = path.join(world.monitorDir, 'outbox')
  const entryPath = path.join(outboxDir, 'plugin-incident.json')
  await writeJson(entryPath, {
    v: 1,
    incidentId: '20261028-160000-crash',
    kind: 'crash',
    severity: 'high',
    detectedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    status: 'pending',
    host: 'TESTHOST',
    summary: 'DSH 异常退出',
    channels: {
      panel: { status: 'pending' },
      toast: { status: 'pending', attempts: 0 },
      webhook: { status: 'pending', attempts: 0 },
      email: { status: 'pending', attempts: 0 },
      qq: { status: 'pending', attempts: 0 },
      peer: { status: 'pending', attempts: 0 },
    },
    payload: {
      title: '[DSH] DSH 异常退出',
      body: '2026-10-28 16:00:00 · TESTHOST',
      host: 'TESTHOST',
      incident: { id: '20261028-160000-crash', kind: 'crash', severity: 'high', detectedAt: NOW },
    },
  })
  const config = normalizeConfig({
    notify: {
      panel: true,
      toast: true,
      webhook: [{ name: 'primary', url: 'https://hook.test/incident', enabled: true, retries: 0 }],
      email: { enabled: true, host: 'smtp.test', from: 'dsh@test', to: ['ops@test'], user: 'u' },
      qq: { enabled: false, http: '', target: '' },
      peer: { enabled: true },
    },
  }).config
  const runCommandCalls = []
  const first = await flushOutbox({
    monitorDir: world.monitorDir,
    config,
    secrets: { ok: false, reason: 'missing' },
    deps: {
      runCommand: async (exe, args) => { runCommandCalls.push(args.join(' ')); return { ok: true, code: 0, stdout: '', stderr: '' } },
      fetchFn: async () => ({ ok: true, status: 200 }),
      sleep: async () => {},
    },
    now: NOW,
    scriptDir: path.join(REPO, 'watchdog'),
  })
  const byChannel = (name) => first.find((item) => item.channel === name)
  assert.equal(byChannel('toast').ok, true)
  assert.equal(byChannel('webhook').ok, true)
  assert.equal(byChannel('email').ok, false, 'SMTP 密钥缺失时保持待发而不是丢通知')
  assert.equal(byChannel('email').reason, 'secret-unavailable')
  assert.equal(byChannel('qq').reason, 'disabled')
  assert.equal(byChannel('peer').waitingFor, 'plugin')
  let saved = await readJson(entryPath)
  assert.equal(saved.channels.panel.status, 'sent')
  assert.equal(saved.channels.toast.status, 'sent')
  assert.equal(saved.channels.webhook.status, 'sent')
  assert.equal(saved.channels.email.status, 'pending')
  assert.equal(saved.channels.email.lastError, 'secret-unavailable')
  assert.equal(saved.channels.qq.status, 'pending', '通道稍后才配置时仍可补发')
  assert.equal(saved.channels.qq.lastError, 'disabled')
  assert.equal(saved.channels.peer.status, 'pending')
  assert.equal(saved.channels.peer.waitingFor, 'plugin')
  assert.equal(saved.status, 'pending', '还有待发通道时不标 sent')

  // 第二轮：密钥就位 + qq 配好 → email/qq 补发，最终 sent
  const secondRunCommandCalls = []
  const second = await flushOutbox({
    monitorDir: world.monitorDir,
    config: normalizeConfig({
      notify: {
        panel: true, toast: true, webhook: [{ name: 'primary', url: 'https://hook.test/incident', enabled: true }],
        email: { enabled: true, host: 'smtp.test', from: 'dsh@test', to: ['ops@test'], user: 'u' },
        qq: { enabled: true, http: 'https://qq.test', target: '10001' }, peer: { enabled: true },
      },
    }).config,
    secrets: { ok: true, data: { smtp: { password: 'secret' }, qq: { token: 't' } } },
    deps: {
      runCommand: async (exe, args) => {
        secondRunCommandCalls.push(args.join(' '))
        return { ok: true, code: 0, stdout: '', stderr: '' }
      },
      fetchFn: async () => ({ ok: true, status: 200 }),
      sleep: async () => {},
    },
    now: NOW + 60000,
    scriptDir: path.join(REPO, 'watchdog'),
  })
  const secondByChannel = (name) => second.find((item) => item.channel === name)
  assert.equal(secondByChannel('email').ok, true)
  assert.equal(secondByChannel('qq').ok, true)
  saved = await readJson(entryPath)
  assert.equal(saved.channels.email.status, 'sent')
  assert.equal(saved.channels.qq.status, 'sent')
  assert.equal(saved.status, 'sent')
  assert.equal(saved.peerPending, true, 'peer 还没被插件消费，标记出来')
  assert.ok(runCommandCalls.some((line) => line.includes('toast.ps1')))
  assert.ok(secondRunCommandCalls.some((line) => line.includes('notify.ps1')))
})

test('watchdog: 与插件 flushPeerOutbox 双向兼容（不洗掉对方字段、sent 不降级）', async () => {
  const world = await makeWorld({ homeFiles: 0 })
  const outboxDir = path.join(world.monitorDir, 'outbox')
  const entryPath = path.join(outboxDir, 'plugin-peer.json')
  await writeJson(entryPath, {
    v: 1,
    incidentId: '20261028-160000-hang',
    kind: 'hang',
    status: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    host: 'TESTHOST',
    summary: 'DSH 无响应',
    channels: {
      panel: { status: 'sent' },
      toast: { status: 'sent', attempts: 1 },
      // 插件已经试过 peer 并写了对象型 lastError / deliveredAt 等我们不认识的字段
      peer: {
        status: 'pending',
        attempts: 2,
        lastError: { code: 'no-sync', message: 'dshSync 未就绪' },
        lastAttemptAt: NOW - 5000,
        deliveredAt: 0,
        waitingFor: 'plugin',
      },
    },
    peerPending: true,
    payload: { title: '[DSH] DSH 无响应', body: 'body', host: 'TESTHOST', incident: { id: 'x', kind: 'hang' } },
  })
  const config = normalizeConfig({ notify: { peer: { enabled: true } } }).config

  // watchdog 每轮 flush：不应动插件的 attempts/lastError/lastAttemptAt，也不该把对象型 lastError 字符串化
  await flushOutbox({
    monitorDir: world.monitorDir,
    config,
    secrets: { ok: false, reason: 'missing' },
    deps: { runCommand: async () => ({ ok: false }), fetchFn: async () => ({ ok: false, status: 500 }), sleep: async () => {} },
    now: NOW,
    scriptDir: path.join(REPO, 'watchdog'),
  })
  let saved = await readJson(entryPath)
  assert.equal(saved.channels.peer.status, 'pending')
  assert.equal(saved.channels.peer.attempts, 2, '外部看门狗不能改插件的投递计数')
  assert.deepEqual(saved.channels.peer.lastError, { code: 'no-sync', message: 'dshSync 未就绪' })
  assert.equal(saved.channels.peer.lastAttemptAt, NOW - 5000)
  assert.equal(saved.channels.peer.deliveredAt, 0)
  assert.equal(saved.channels.peer.waitingFor, 'plugin')
  assert.equal(saved.peerPending, true)

  // 插件成功投递后（read-modify-write）把 peer 置 sent：watchdog 下一轮只收尾，不降级、不清 deliveredAt
  saved.channels.peer = {
    ...saved.channels.peer,
    status: 'sent',
    attempts: 3,
    sentAt: NOW + 1000,
    deliveredAt: NOW + 1000,
    lastError: null,
  }
  delete saved.peerPending
  await writeJson(entryPath, saved)

  const results = await flushOutbox({
    monitorDir: world.monitorDir,
    config,
    secrets: { ok: false, reason: 'missing' },
    deps: { runCommand: async () => ({ ok: true, code: 0 }), fetchFn: async () => ({ ok: true, status: 200 }), sleep: async () => {} },
    now: NOW + 60000,
    scriptDir: path.join(REPO, 'watchdog'),
  })
  assert.equal(results.length, 0, 'peer 已 sent 时没有需要外部补发的通道')
  const finalEntry = await readJson(entryPath)
  assert.equal(finalEntry.channels.peer.status, 'sent', '绝不把 sent 降级')
  assert.equal(finalEntry.channels.peer.attempts, 3)
  assert.equal(finalEntry.channels.peer.deliveredAt, NOW + 1000)
  assert.equal(finalEntry.peerPending, undefined, '插件投递成功后 peerPending 应被清掉')
  assert.equal(finalEntry.status, 'sent')
})

/* ------------------------------------------- 通知通道自检 --test-notify（task-16） */

const watchdogScript = path.join(REPO, 'watchdog', 'watchdog.mjs')

async function makeNotifyWorld(notify) {
  return await makeWorld({ homeFiles: 0, notify })
}

function spawnNode(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      resolve({ code: -1, stdout, stderr: `${stderr}\ntimeout`, timedOut: true })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

function parseLastJsonLine(text) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue
    try { return JSON.parse(lines[i]) } catch { /* 继续 */ }
  }
  return null
}

test('test-notify: panel 写面板测试文件、只发 panel、返回 {ok,channel,result}', async () => {
  const world = await makeNotifyWorld({
    panel: true, toast: true, webhook: [], email: { enabled: false },
    qq: { enabled: false }, peer: { enabled: false },
  })
  const configBefore = await fsp.readFile(world.configPath, 'utf8')
  let runCommandCalls = 0
  let fetchCalls = 0
  const report = await testNotify({
    channel: 'panel',
    configPath: world.configPath,
    now: NOW,
    scriptDir: path.join(REPO, 'watchdog'),
    deps: {
      runCommand: async () => { runCommandCalls += 1; return { ok: true, code: 0 } },
      fetchFn: async () => { fetchCalls += 1; return { ok: true, status: 200 } },
      sleep: async () => {},
    },
  })
  assert.equal(report.ok, true)
  assert.equal(report.channel, 'panel')
  assert.equal(report.result.code, 'ok')
  assert.equal(report.version, '1.0.2')
  const probeFile = path.join(world.monitorDir, 'alerts', 'notify-test.json')
  assert.equal(report.result.path, probeFile)
  const probe = await readJson(probeFile)
  assert.equal(probe.title, TEST_NOTIFY_TITLE)
  assert.ok(probe.body.includes('TESTHOST'))
  assert.equal(runCommandCalls, 0, 'panel 测试不能触发其它通道脚本')
  assert.equal(fetchCalls, 0, 'panel 测试不能触发 webhook/qq')
  assert.equal(await fsp.readFile(world.configPath, 'utf8'), configBefore, '测试只读配置，不得修改 config.json')
})

test('test-notify: toast 成功/禁用，且不串发 webhook/email/qq', async () => {
  const world = await makeNotifyWorld({
    panel: true,
    toast: true,
    webhook: [{ name: 'hook', url: 'https://hook.test/x', enabled: true }],
    email: { enabled: true, host: 'smtp.test', from: 'a@test', to: ['b@test'] },
    qq: { enabled: true, http: 'https://qq.test', target: '1' },
    peer: { enabled: true },
  })
  const commandCalls = []
  const fetchCalls = []
  const report = await testNotify({
    channel: 'toast',
    configPath: world.configPath,
    now: NOW,
    scriptDir: path.join(REPO, 'watchdog'),
    deps: {
      runCommand: async (exe, args) => { commandCalls.push(args.join(' ')); return { ok: true, code: 0 } },
      fetchFn: async (url) => { fetchCalls.push(String(url)); return { ok: true, status: 200 } },
      sleep: async () => {},
    },
  })
  assert.equal(report.ok, true)
  assert.equal(report.result.code, 'ok')
  assert.equal(commandCalls.length, 1)
  assert.match(commandCalls[0], /toast\.ps1/)
  assert.equal(fetchCalls.length, 0, 'toast 测试不应请求 webhook/qq')
  // toast 被禁用 → 明确 code，不调用脚本
  const disabledWorld = await makeNotifyWorld({ panel: true, toast: false, webhook: [], email: { enabled: false }, qq: { enabled: false }, peer: { enabled: false } })
  let calls = 0
  const disabled = await testNotify({
    channel: 'toast',
    configPath: disabledWorld.configPath,
    now: NOW,
    deps: { runCommand: async () => { calls += 1; return { ok: true, code: 0 } }, fetchFn: async () => ({ ok: true, status: 200 }), sleep: async () => {} },
  })
  assert.equal(disabled.ok, false)
  assert.equal(disabled.result.code, 'disabled')
  assert.equal(calls, 0)
})

test('test-notify: webhook 成功/失败/未配置', async () => {
  const okWorld = await makeNotifyWorld({
    panel: true, toast: false,
    webhook: [{ name: 'a', url: 'https://a.test/hook', enabled: true, retries: 0 }],
    email: { enabled: false }, qq: { enabled: false }, peer: { enabled: false },
  })
  const okReport = await testNotify({
    channel: 'webhook', configPath: okWorld.configPath, now: NOW,
    deps: { fetchFn: async () => ({ ok: true, status: 200 }), sleep: async () => {}, runCommand: async () => ({ ok: true }) },
  })
  assert.equal(okReport.ok, true)
  assert.equal(okReport.result.code, 'ok')
  assert.equal(okReport.result.hooks.length, 1)
  assert.equal(okReport.result.hooks[0].ok, true)

  const mixedWorld = await makeNotifyWorld({
    panel: true, toast: false,
    webhook: [
      { name: 'ok', url: 'https://ok.test/hook', enabled: true, retries: 0 },
      { name: 'bad', url: 'https://bad.test/hook', enabled: true, retries: 0 },
    ],
    email: { enabled: false }, qq: { enabled: false }, peer: { enabled: false },
  })
  const badReport = await testNotify({
    channel: 'webhook', configPath: mixedWorld.configPath, now: NOW,
    deps: {
      fetchFn: async (url) => (String(url).includes('bad.test') ? { ok: false, status: 500 } : { ok: true, status: 200 }),
      sleep: async () => {},
      runCommand: async () => ({ ok: true }),
    },
  })
  assert.equal(badReport.ok, false)
  assert.match(badReport.result.code, /^webhook-/)
  assert.equal(badReport.result.hooks.find((hook) => hook.name === 'bad').ok, false)

  const emptyWorld = await makeNotifyWorld({ panel: true, toast: false, webhook: [], email: { enabled: false }, qq: { enabled: false }, peer: { enabled: false } })
  let fetchCalls = 0
  const emptyReport = await testNotify({
    channel: 'webhook', configPath: emptyWorld.configPath, now: NOW,
    deps: { fetchFn: async () => { fetchCalls += 1; return { ok: true } }, sleep: async () => {}, runCommand: async () => ({ ok: true }) },
  })
  assert.equal(emptyReport.ok, false)
  assert.equal(emptyReport.result.code, 'not-configured')
  assert.equal(fetchCalls, 0)
})

test('test-notify: email 缺密钥返回 secrets-missing；注入密钥后成功/失败 code', async () => {
  const world = await makeNotifyWorld({
    panel: true, toast: false, webhook: [], email: { enabled: true, host: 'smtp.test', port: 587, useSsl: true, user: 'u', from: 'a@test', to: ['b@test'] },
    qq: { enabled: false }, peer: { enabled: false },
  })
  let calls = 0
  const missing = await testNotify({
    channel: 'email', configPath: world.configPath, now: NOW,
    scriptDir: path.join(REPO, 'watchdog'),
    deps: { runCommand: async () => { calls += 1; return { ok: true } }, fetchFn: async () => ({ ok: true }), sleep: async () => {} },
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.result.code, 'secrets-missing')
  assert.equal(calls, 0, '缺密钥时不应调用 SMTP 脚本')

  // 放一个“密文”文件 + 注入 unprotectSecrets
  await fsp.writeFile(path.join(world.recoveryHome, 'monitor', 'secrets.dpapi'), 'ZmFrZQ==\n')
  const inputs = []
  const okReport = await testNotify({
    channel: 'email', configPath: world.configPath, now: NOW,
    scriptDir: path.join(REPO, 'watchdog'),
    deps: {
      unprotectSecrets: async () => ({ smtp: { password: 'secret-pass' } }),
      runCommand: async (exe, args, opts) => { inputs.push(opts?.input || ''); return { ok: true, code: 0 } },
      fetchFn: async () => ({ ok: true }), sleep: async () => {},
    },
  })
  assert.equal(okReport.ok, true)
  assert.equal(okReport.result.code, 'ok')
  assert.equal(inputs.length, 1)
  assert.ok(inputs[0].includes('secret-pass'), '密码通过 stdin JSON 传给 notify.ps1（不进命令行）')
  assert.ok(!inputs[0].includes('--password'), '密码不得出现在命令行参数')

  const failReport = await testNotify({
    channel: 'email', configPath: world.configPath, now: NOW,
    scriptDir: path.join(REPO, 'watchdog'),
    deps: {
      unprotectSecrets: async () => ({ smtp: { password: 'x' } }),
      runCommand: async () => ({ ok: false, code: 1, stderr: 'email: SMTP_AUTH' }),
      fetchFn: async () => ({ ok: true }), sleep: async () => {},
    },
  })
  assert.equal(failReport.ok, false)
  assert.equal(failReport.result.code, 'SMTP_AUTH')
})

test('test-notify: qq 直发成功/未配置 HTTP 时排队 pending', async () => {
  const world = await makeNotifyWorld({
    panel: true, toast: false, webhook: [], email: { enabled: false },
    qq: { enabled: true, http: 'https://qq.test', target: '10001' },
    peer: { enabled: false },
  })
  const urls = []
  const direct = await testNotify({
    channel: 'qq', configPath: world.configPath, now: NOW,
    deps: { fetchFn: async (url) => { urls.push(String(url)); return { ok: true, status: 200 } }, sleep: async () => {}, runCommand: async () => ({ ok: true }) },
  })
  assert.equal(direct.ok, true)
  assert.equal(direct.result.code, 'ok')
  assert.match(urls[0], /\/send_private_msg$/)

  const noHttpWorld = await makeNotifyWorld({
    panel: true, toast: false, webhook: [], email: { enabled: false },
    qq: { enabled: true, http: '', target: '10001' },
    peer: { enabled: false },
  })
  let fetchCalls = 0
  const queued = await testNotify({
    channel: 'qq', configPath: noHttpWorld.configPath, now: NOW,
    deps: { fetchFn: async () => { fetchCalls += 1; return { ok: true } }, sleep: async () => {}, runCommand: async () => ({ ok: true }) },
  })
  assert.equal(queued.ok, false)
  assert.equal(queued.result.code, 'not-configured')
  assert.equal(queued.result.queued, true)
  assert.equal(fetchCalls, 0)
  const outbox = await readJson(queued.result.outboxFile)
  assert.equal(outbox.test, true)
  assert.equal(outbox.channels.qq.status, 'pending')
})

test('test-notify: peer 只能排队 → queued/pending，并写 outbox 供插件补发', async () => {
  const world = await makeNotifyWorld({
    panel: true, toast: false, webhook: [], email: { enabled: false },
    qq: { enabled: false }, peer: { enabled: false },
  })
  const report = await testNotify({
    channel: 'peer', configPath: world.configPath, now: NOW,
    scriptDir: path.join(REPO, 'watchdog'),
    deps: { runCommand: async () => ({ ok: true }), fetchFn: async () => ({ ok: true }), sleep: async () => {} },
  })
  assert.equal(report.ok, true)
  assert.equal(report.result.code, 'queued')
  assert.equal(report.result.queued, true)
  assert.equal(report.result.pending, true)
  assert.equal(report.result.delivery, 'plugin')
  const outbox = await readJson(report.result.outboxFile)
  assert.equal(outbox.test, true)
  assert.equal(outbox.peerPending, true)
  assert.equal(outbox.channels.peer.status, 'pending')
  assert.equal(outbox.channels.peer.waitingFor, 'plugin')
  assert.equal(outbox.payload.title, TEST_NOTIFY_TITLE)
  assert.ok(outbox.payload.body.includes('TESTHOST'))
})

test('test-notify: 未知通道/config 缺失 → 明确 code 且不写文件', async () => {
  const world = await makeNotifyWorld({ panel: true, toast: false, webhook: [], email: { enabled: false }, qq: { enabled: false }, peer: { enabled: false } })
  let calls = 0
  const bad = await testNotify({
    channel: 'telegram', configPath: world.configPath, now: NOW,
    deps: {
      runCommand: async () => { calls += 1; return { ok: true } },
      fetchFn: async () => { calls += 1; return { ok: true } },
      sleep: async () => {},
    },
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.result.code, 'bad-channel')
  assert.equal(calls, 0)
  const missing = await testNotify({
    channel: 'panel', configPath: path.join(world.root, 'nope', 'config.json'), now: NOW,
    deps: { runCommand: async () => ({ ok: true }), fetchFn: async () => ({ ok: true }), sleep: async () => {} },
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.result.code, 'config-missing')
  assert.equal(await exists(path.join(world.root, 'nope')), false, 'config 缺失时不得创建目录')
})

test('test-notify: CLI --test-notify --json 契约与退出码', async () => {
  const world = await makeNotifyWorld({ panel: true, toast: false, webhook: [], email: { enabled: false }, qq: { enabled: false }, peer: { enabled: false } })
  const ok = await spawnNode([watchdogScript, '--test-notify', 'panel', '--config', world.configPath, '--json'], { timeoutMs: 60000 })
  assert.equal(ok.code, 0, ok.stderr)
  const okReport = parseLastJsonLine(ok.stdout)
  assert.ok(okReport)
  assert.equal(okReport.ok, true)
  assert.equal(okReport.channel, 'panel')
  assert.equal(okReport.result.code, 'ok')
  assert.equal(okReport.version, '1.0.2')

  const badChannel = await spawnNode([watchdogScript, '--test-notify', 'bogus', '--config', world.configPath, '--json'])
  assert.equal(badChannel.code, 2)
  assert.equal(parseLastJsonLine(badChannel.stdout).result.code, 'bad-channel')

  const missingConfig = await spawnNode([watchdogScript, '--test-notify', 'panel', '--config', path.join(world.root, 'missing.json'), '--json'])
  assert.equal(missingConfig.code, 2)
  assert.equal(parseLastJsonLine(missingConfig.stdout).result.code, 'config-missing')
})
