/**
 * 外部一键恢复控制台测试（docs/CRASH-MONITORING.md §7 / task-9 验收）。
 *
 * 铁律：全部临时目录（os.tmpdir() 的 mkdtemp），绝不写真实 %USERPROFILE%\.dsh、
 * 不启动真实 DeepSeek Harness、不联网；进程检测/启动 DSH 全部注入 fake。
 *
 * 覆盖：
 *   1. 参数/路径/storeRoot/config 解析
 *   2. host 目录发现、多主机、快照摘要
 *   3. 本地校验（缺块=0）、事故推荐点与回退
 *   4. 恢复计划（current/新建/覆盖/未变/额外）
 *   5. junction 计划与重建（create/rebuild/冲突/npm 缺失/idempotent）
 *   6. 端到端：删 home → 从本地备份库恢复 → 逐文件 sha256、junction、报告 JSON、--no-start
 *   7. 非空目标：保留清单外文件、被覆盖文件进 quarantine
 *   8. 缺块整体拒绝（退出码 2，不写半份数据）
 *   9. DSH 正在运行时默认拒绝
 *  10. 从 recovery-kit（子机加密仓库）恢复 + 非空目标 --force 拒绝
 *  11. --list / --verify / --dry-run
 *  12. 插件/recovery-kit 路径解析（plugin/ 与 scripts/ 两种位置）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BackupEngine, entryChunks } from '../src/engine.js'
import { LocalRepo } from '../src/archive/repo.js'
import { exportSnapshot } from '../src/archive/export.js'
import {
  DEFAULT_DSH_EXE, DEFAULT_STORE_ROOT, REPORT_VERSION, applyJunctions, blobPath, buildPlan,
  chooseRecoveryPoint, currentHostTag, findHostStores, junctionSummary, loadManifest,
  localStamp, parseArgs, parseCliRestoreOutput, planJunctions, readMonitorConfig,
  readSnapshotSummaries, resolveConfigPath, resolveHome, resolveKitScript, resolvePluginDir,
  resolveRecoveryHome, resolveStoreRoot, restoreFromKit, runCommand, runConsole, samePath,
  verifySnapshotLocal, walkHomeFiles, writeFileAtomic,
} from '../recovery-console/console.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PASSWORD = 'correct-horse-9'

/* ═══════════════════════════════════════════════════════ helpers */

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** 只允许删除 os.tmpdir() 下的临时目录（防止误删真实数据）。 */
async function cleanup(dir) {
  if (!dir) return
  const abs = path.resolve(dir)
  const tmp = path.resolve(os.tmpdir())
  if (!abs.startsWith(tmp + path.sep)) throw new Error(`refuse to clean outside tmpdir: ${abs}`)
  await fs.rm(abs, { recursive: true, force: true })
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

async function makeEngine(home, root, extra = {}, hostname = currentHostTag()) {
  return new BackupEngine({
    home,
    hostname,
    config: { root, watch: false, scanMs: 3_600_000, debounceMs: 0, minIntervalMs: 0, ...extra },
    log: () => {},
  })
}

async function startEngine(home, root, extra = {}, hostname = currentHostTag()) {
  const engine = await makeEngine(home, root, extra, hostname)
  await engine.start()
  return engine
}

/** 造一个像真的 DSH_HOME：sessions/storages/profiles（含 link: 插件依赖）+ 额外文件。 */
async function makeHome(explicitDir = null) {
  const home = explicitDir ? path.resolve(explicitDir) : await tempDir('dbk-rc-home-')
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(path.join(home, 'sessions', '--D-x--', 'session-1'), { recursive: true })
  await fs.mkdir(path.join(home, 'storages'), { recursive: true })
  await fs.mkdir(path.join(home, 'dsh-runtimes', 'node'), { recursive: true })
  await fs.mkdir(path.join(home, 'profiles', 'desktop', 'plugins', 'dsh-disaster-recovery'), { recursive: true })
  await fs.mkdir(path.join(home, 'profiles', 'desktop', 'plugins', 'other-plugin'), { recursive: true })
  await fs.writeFile(path.join(home, 'workspace.json'), '{"v":1}')
  await fs.writeFile(path.join(home, 'sessions', '--D-x--', 'session-1', 'session.v4.jsonl.zstd'), 'session-body')
  await fs.writeFile(path.join(home, 'storages', 'db.json'), '{"rows":[1,2,3]}')
  await fs.writeFile(path.join(home, 'empty.txt'), '')
  await fs.writeFile(path.join(home, 'dsh-runtimes', 'node', 'node.exe'), 'runtime-binary')
  await fs.writeFile(path.join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: {
      'dsh-disaster-recovery': 'link:./plugins/dsh-disaster-recovery',
      'other-plugin': 'link:./plugins/other-plugin',
    },
  }, null, 2))
  for (const name of ['dsh-disaster-recovery', 'other-plugin']) {
    await fs.writeFile(path.join(home, 'profiles', 'desktop', 'plugins', name, 'package.json'),
      JSON.stringify({ name, version: '0.0.0' }, null, 2))
  }
  return home
}

/** 读清单内容（从内容寻址库拼块），用于恢复后逐文件比对。 */
async function readManifestFiles(hostDir, manifest) {
  const out = new Map()
  for (const [rel, entry] of Object.entries(manifest.files || {})) {
    const parts = []
    for (const hash of entryChunks(entry)) parts.push(await fs.readFile(blobPath(hostDir, hash)))
    out.set(rel, Buffer.concat(parts))
  }
  return out
}

async function assertHomeMatches(hostDir, manifest, home) {
  const files = await readManifestFiles(hostDir, manifest)
  assert.ok(files.size > 0, '清单里应有文件')
  for (const [rel, expected] of files) {
    const abs = path.join(home, ...rel.split('/'))
    const actual = await fs.readFile(abs)
    assert.equal(sha256(actual), sha256(expected), `${rel} 的 sha256 与清单不一致`)
  }
  return files.size
}

/** 读 <storeRoot>/manual 下最新一份 report.json。 */
async function readLatestReport(storeRoot) {
  const manual = path.join(storeRoot, 'manual')
  const names = (await fs.readdir(manual)).filter((name) => /-external-restore(-\d+)?$/.test(name)).sort()
  assert.ok(names.length, '应写出报告目录')
  const dir = path.join(manual, names[names.length - 1])
  const raw = await fs.readFile(path.join(dir, 'report.json'), 'utf8')
  return { dir, report: JSON.parse(raw), raw }
}

/** 跑控制台；默认注入「没有 DSH 进程 / 不启动 DSH / 非交互」。 */
async function runConsoleCapture(argv, deps = {}) {
  let out = ''
  let err = ''
  const startCalls = []
  const code = await runConsole(argv, {
    interactive: false,
    detectDshProcesses: async () => [],
    startDsh: async (exe) => {
      startCalls.push(exe)
      return { requested: true, started: false, exe, error: 'test-injected' }
    },
    stdout: (text) => { out += text },
    stderr: (text) => { err += text },
    ...deps,
  })
  return { code, out, err, startCalls }
}

/** 写一个假 host 目录（含 manifest / blob），供纯逻辑测试用。 */
async function writeFakeHost(storeRoot, hostName, manifests = []) {
  const dir = path.join(storeRoot, hostName)
  await fs.mkdir(path.join(dir, 'snapshots'), { recursive: true })
  await fs.mkdir(path.join(dir, 'blobs'), { recursive: true })
  for (const manifest of manifests) {
    await fs.writeFile(path.join(dir, 'snapshots', `${manifest.id}.json`), JSON.stringify(manifest))
  }
  return dir
}

async function putBlob(hostDir, buf) {
  const hash = sha256(buf)
  const file = blobPath(hostDir, hash)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, buf)
  return hash
}

function fakeManifest(id, at, files = {}, extra = {}) {
  return {
    version: 2,
    id,
    at,
    reason: 'auto',
    host: 'fake-host',
    home: 'C:\\fake-home',
    chunkSize: 65536,
    files,
    skipped: [],
    errors: [],
    stats: { files: Object.keys(files).length, changed: 0, stored: 0, bytes: 0, durationMs: 1 },
    ...extra,
  }
}

async function writeIncident(hostDir, incident) {
  const dir = path.join(hostDir, 'monitor', 'incidents')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${incident.id}.json`), JSON.stringify(incident))
}

/* ═══════════════════════════════════════════════════ 1. 参数/路径 */

test('console: 参数解析与 home/store/config 定位（含 monitor config 与 env 优先级）', async () => {
  const parsed = parseArgs(['pos', '--home', 'D:\\tmp\\h', '--yes', '--list', '--store=Y:\\b', '--auto'])
  assert.equal(parsed.home, 'D:\\tmp\\h')
  assert.equal(parsed.yes, true)
  assert.equal(parsed.list, true)
  assert.equal(parsed.store, 'Y:\\b')
  assert.deepEqual(parsed._, ['pos'])

  assert.equal(resolveHome({ args: { home: 'D:\\x\\home' }, env: {} }), path.resolve('D:\\x\\home'))
  assert.equal(resolveHome({ args: {}, env: { DSH_HOME: 'E:\\custom' } }), path.resolve('E:\\custom'))
  assert.ok(resolveHome({ args: {}, env: {} }).toLowerCase().endsWith(`${path.sep}.dsh`))

  const base = await tempDir('dbk-rc-paths-')
  try {
    const recoveryHome = path.join(base, 'DeepSeek Recovery')
    await fs.mkdir(path.join(recoveryHome, 'monitor'), { recursive: true })
    const configPath = path.join(recoveryHome, 'monitor', 'config.json')
    await writeFileAtomic(configPath, JSON.stringify({ storeRoot: path.join(base, 'from-config') }))
    const config = await readMonitorConfig(configPath)
    assert.equal(resolveStoreRoot({ args: {}, env: {}, config }), path.resolve(path.join(base, 'from-config')))
    assert.equal(resolveStoreRoot({ args: { store: path.join(base, 'explicit') }, env: {}, config }),
      path.resolve(path.join(base, 'explicit')))
    assert.equal(resolveStoreRoot({ args: {}, env: { DSH_BACKUP_ROOT: path.join(base, 'from-env') }, config }),
      path.resolve(path.join(base, 'from-env')))
    assert.equal(resolveStoreRoot({ args: {}, env: {}, config: null }), path.resolve(DEFAULT_STORE_ROOT))

    // 安装布局：console 在 <recoveryHome>\scripts 下 → 自动认出 recovery home / config 路径
    const installedConsoleDir = path.join(recoveryHome, 'scripts')
    await fs.mkdir(installedConsoleDir, { recursive: true })
    assert.equal(resolveRecoveryHome({ args: {}, env: {}, consoleDir: installedConsoleDir }), recoveryHome)
    assert.equal(resolveConfigPath({ args: {}, env: {}, recoveryHome }), configPath)

    // 插件目录：<RECOVERY_HOME>\plugin 优先于旧的 <RECOVERY_HOME>\scripts\cli.mjs
    const pluginDir = path.join(recoveryHome, 'plugin')
    await fs.mkdir(path.join(pluginDir, 'scripts'), { recursive: true })
    await fs.writeFile(path.join(pluginDir, 'scripts', 'cli.mjs'), '// fake cli\n')
    const resolved = resolvePluginDir({ args: {}, env: {}, consoleDir: installedConsoleDir })
    assert.equal(resolved.dir, pluginDir)
    assert.equal(resolved.cliPath, path.join(pluginDir, 'scripts', 'cli.mjs'))

    // env DSH_RECOVERY_HOME 优先
    const otherHome = path.join(base, 'otherhome')
    await fs.mkdir(path.join(otherHome, 'plugin', 'scripts'), { recursive: true })
    await fs.writeFile(path.join(otherHome, 'plugin', 'scripts', 'cli.mjs'), '// fake cli\n')
    assert.equal(resolvePluginDir({ args: {}, env: { DSH_RECOVERY_HOME: otherHome }, consoleDir: installedConsoleDir }).dir,
      path.join(otherHome, 'plugin'))

    // 仓库布局：<repo>/recovery-console → <repo>/scripts/cli.mjs
    const repoResolved = resolvePluginDir({ args: {}, env: {}, consoleDir: path.join(REPO_ROOT, 'recovery-console') })
    assert.equal(path.resolve(repoResolved.dir), path.resolve(REPO_ROOT))
    assert.equal(path.resolve(repoResolved.cliPath), path.resolve(REPO_ROOT, 'scripts', 'cli.mjs'))

    // recovery-kit：优先子机仓库自带 recovery-kit/recover.mjs
    const repoDir = path.join(base, 'offsite-repo')
    await fs.mkdir(path.join(repoDir, 'recovery-kit'), { recursive: true })
    await fs.writeFile(path.join(repoDir, 'recovery-kit', 'recover.mjs'), '// kit\n')
    assert.equal(resolveKitScript({ args: {}, env: {}, consoleDir: installedConsoleDir, repoDir }),
      path.join(repoDir, 'recovery-kit', 'recover.mjs'))
  } finally {
    await cleanup(base)
  }
})

/* ═══════════════════════════════════════════════════ 2. host/快照 */

test('console: host 目录发现/多主机选择/快照摘要（最近 10 + 总数）', async () => {
  const base = await tempDir('dbk-rc-hosts-')
  try {
    const storeRoot = path.join(base, 'store')
    const older = fakeManifest('20261028-090000-auto', 1000)
    const newer = fakeManifest('20261028-100000-auto', 2000)
    await writeFakeHost(storeRoot, 'host-a', [older, newer])
    await writeFakeHost(storeRoot, 'host-b', [fakeManifest('20261028-110000-auto', 3000)])
    // 无关目录不算 host
    await fs.mkdir(path.join(storeRoot, 'manual'), { recursive: true })

    const stores = await findHostStores(storeRoot)
    assert.equal(stores.length, 2)
    assert.deepEqual(stores.map((store) => store.name).sort(), ['host-a', 'host-b'])

    const { total, snapshots } = await readSnapshotSummaries(path.join(storeRoot, 'host-a'))
    assert.equal(total, 2)
    assert.equal(snapshots.length, 2)
    assert.equal(snapshots[0].id, newer.id, '快照按时间倒序')
    assert.equal(snapshots[0].files, 0)

    // 多主机时按 --host 指名
    const ctx = {
      args: { host: 'HOST-B' },
      D: { interactive: false, ask: async () => '' },
      log: () => {},
      logErr: () => {},
    }
    const picked = await (await import('../recovery-console/console.mjs')).pickHostStore(ctx, stores)
    assert.equal(picked.name, 'host-b')
    // 自动模式选当前主机（没有则最新）
    const autoCtx = { args: { auto: true }, D: { interactive: false }, log: () => {}, logErr: () => {} }
    const auto = await (await import('../recovery-console/console.mjs')).pickHostStore(autoCtx, stores)
    assert.ok(['host-a', 'host-b'].includes(auto.name))
  } finally {
    await cleanup(base)
  }
})

/* ══════════════════════════════════════════ 3. 校验/推荐点 */

test('console: verifySnapshotLocal 缺块=0 判定（0 字节文件算合法）', async () => {
  const base = await tempDir('dbk-rc-verify-')
  try {
    const hostDir = path.join(base, 'host')
    const content = Buffer.from('hello-console')
    const goodHash = sha256(content)
    const manifest = fakeManifest('20261028-100000-auto', 1000, {
      'data.txt': { s: content.length, m: 1, c: [goodHash] },
      'empty.txt': { s: 0, m: 0, c: [] },
    })
    await writeFakeHost(base, 'host', [manifest])

    let result = await verifySnapshotLocal(hostDir, manifest.id)
    assert.equal(result.ok, false)
    assert.equal(result.missingCount, 1, '缺 data.txt 的块')

    await putBlob(hostDir, content)
    result = await verifySnapshotLocal(hostDir, manifest.id)
    assert.equal(result.ok, true)
    assert.equal(result.missingCount, 0)
    assert.equal(result.files, 2)

    // 清单损坏 → 明确 ok=false，不抛
    await fs.writeFile(path.join(hostDir, 'snapshots', 'broken.json'), '{not json')
    const broken = await verifySnapshotLocal(hostDir, 'broken')
    assert.equal(broken.ok, false)
    assert.match(broken.error, /损坏|不可读/)
  } finally {
    await cleanup(base)
  }
})

test('console: 推荐点＝事故 recommendation（at<=事故时间且 verified）→ 否则最新校验通过快照', async () => {
  const base = await tempDir('dbk-rc-recommend-')
  try {
    const hostDir = path.join(base, 'host')
    const oldContent = Buffer.from('old-content')
    const newContent = Buffer.from('new-content')
    const oldHash = sha256(oldContent)
    const newHash = sha256(newContent)
    const t1 = 1_000_000
    const t2 = 2_000_000
    const t3 = 3_000_000
    const oldSnap = fakeManifest('20261028-100000-auto', t1, { 'data.txt': { s: oldContent.length, m: 1, c: [oldHash] } })
    const newSnap = fakeManifest('20261028-110000-auto', t2, { 'data.txt': { s: newContent.length, m: 2, c: [newHash] } })
    const badSnap = fakeManifest('20261028-120000-auto', t3, { 'data.txt': { s: 9, m: 3, c: ['a'.repeat(64)] } })
    await writeFakeHost(base, 'host', [oldSnap, newSnap, badSnap])
    await putBlob(hostDir, oldContent)
    await putBlob(hostDir, newContent)

    const incidents = await import('../recovery-console/console.mjs').then((mod) => mod.readIncidents)
    await writeIncident(hostDir, {
      id: 'inc-crash', kind: 'crash', status: 'open', firstAt: t2 + 1000, lastAt: t2 + 2000,
      recommendation: { snapshotId: oldSnap.id, at: t1, reason: '崩溃前最后一份已验证快照', verified: true },
    })

    let point = await chooseRecoveryPoint({ hostDir, snapshotIds: await listIds(hostDir), incidents: await incidents(hostDir) })
    assert.equal(point.source, 'incident')
    assert.equal(point.snapshotId, oldSnap.id, '事故推荐优先于更新的快照')
    assert.equal(point.verified.ok, true)

    // 推荐点时间晚于事故时间 → 不可信，回退到最新校验通过（badSnap 缺块被跳过，取 newSnap）
    await writeIncident(hostDir, {
      id: 'inc-crash', kind: 'crash', status: 'open', firstAt: t2 + 1000, lastAt: t2 + 2000,
      recommendation: { snapshotId: oldSnap.id, at: t3, reason: '时间不对', verified: true },
    })
    point = await chooseRecoveryPoint({ hostDir, snapshotIds: await listIds(hostDir), incidents: await incidents(hostDir) })
    assert.equal(point.source, 'verified-latest')
    assert.equal(point.snapshotId, newSnap.id)

    // verified=false → 忽略推荐
    await writeIncident(hostDir, {
      id: 'inc-crash', kind: 'crash', status: 'open', firstAt: t2 + 1000, lastAt: t2 + 2000,
      recommendation: { snapshotId: oldSnap.id, at: t1, reason: '未验证', verified: false },
    })
    point = await chooseRecoveryPoint({ hostDir, snapshotIds: await listIds(hostDir), incidents: await incidents(hostDir) })
    assert.equal(point.source, 'verified-latest')
    assert.equal(point.snapshotId, newSnap.id)
  } finally {
    await cleanup(base)
  }
})

async function listIds(hostDir) {
  const mod = await import('../recovery-console/console.mjs')
  return mod.listSnapshotIds(hostDir)
}

/* ═══════════════════════════════════════════════════ 4. 恢复计划 */

test('console: buildPlan 新建/覆盖/未变/清单外文件计数', async () => {
  const base = await tempDir('dbk-rc-plan-')
  try {
    const home = path.join(base, 'home')
    const bufferA = Buffer.from('contents-A')
    const manifest = fakeManifest('20261028-100000-auto', 1000, {
      'a.txt': { s: bufferA.length, m: 111, c: [sha256(bufferA)] },
      'b.txt': { s: 5, m: 222, c: [] },
      'empty.txt': { s: 0, m: 0, c: [] },
    })
    // home 不存在：全部新建
    let plan = await buildPlan({ home, manifest })
    assert.equal(plan.current.exists, false)
    assert.equal(plan.files, 3)
    assert.equal(plan.create, 3)
    assert.equal(plan.overwrite, 0)
    assert.equal(plan.extra, 0)

    // 非空 home：a.txt 未变（size+mtime 一致）、b.txt 大小不同 → 覆盖、c.txt 是清单外文件
    await fs.mkdir(home, { recursive: true })
    await fs.writeFile(path.join(home, 'a.txt'), bufferA)
    const stat = await fs.stat(path.join(home, 'a.txt'))
    manifest.files['a.txt'].m = Math.round(stat.mtimeMs)
    await fs.writeFile(path.join(home, 'b.txt'), 'changed-content')
    await fs.writeFile(path.join(home, 'c.txt'), 'extra-file')
    const walked = await walkHomeFiles(home)
    assert.equal(walked.exists, true)
    assert.equal(walked.files.length, 3)

    plan = await buildPlan({ home, manifest })
    assert.equal(plan.current.exists, true)
    assert.equal(plan.create, 1, 'b.txt 存在→覆盖；empty.txt 不存在→新建')
    assert.equal(plan.overwrite, 1)
    assert.equal(plan.unchanged, 1, 'a.txt size/mtime 一致 → 未变')
    assert.equal(plan.extra, 1, 'c.txt 在清单外，保留不动')
  } finally {
    await cleanup(base)
  }
})

/* ═══════════════════════════════════════════════════ 5. junction */

test('console: junction 计划/创建/重建/冲突/npm 缺失（绝不删真实目录）', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('junction 只测 Windows')
    return
  }
  const base = await tempDir('dbk-rc-junction-')
  try {
    const home = path.join(base, 'home')
    const profileDir = path.join(home, 'profiles', 'desktop')
    const nodeModules = path.join(profileDir, 'node_modules')
    const pluginTarget = path.join(profileDir, 'plugins', 'dsh-disaster-recovery')
    const otherTarget = path.join(home, 'shared', 'other-plugin')
    const realTarget = path.join(profileDir, 'plugins', 'real-plugin')
    const wrongTarget = path.join(base, 'wrong-target')
    for (const dir of [pluginTarget, otherTarget, realTarget, wrongTarget, nodeModules]) {
      await fs.mkdir(dir, { recursive: true })
    }
    for (const dir of [pluginTarget, otherTarget, realTarget]) {
      await fs.writeFile(path.join(dir, 'package.json'), '{"name":"x","version":"0.0.0"}')
    }
    await fs.writeFile(path.join(wrongTarget, 'marker.txt'), 'wrong-target-must-survive')
    // 故意造成：dsh-disaster-recovery 指向错误目标；other-plugin 缺失；
    // real-plugin 是真实目录（npm 装的），不应被自动删
    assert.equal(runCommand('cmd', ['/c', 'mklink', '/J',
      path.join(nodeModules, 'dsh-disaster-recovery'), wrongTarget]).code, 0)
    await fs.mkdir(path.join(nodeModules, 'real-plugin'), { recursive: true })
    await fs.writeFile(path.join(nodeModules, 'real-plugin', 'marker.txt'), 'real-dir-must-survive')
    await fs.writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
      dependencies: {
        'dsh-disaster-recovery': 'link:./plugins/dsh-disaster-recovery',
        'other-plugin': 'link:../../shared/other-plugin',
        'real-plugin': 'link:./plugins/real-plugin',
        'npm-missing': '^1.0.0',
        'npm-present': '^2.0.0',
      },
    }, null, 2))
    await fs.mkdir(path.join(nodeModules, 'npm-present'), { recursive: true })
    await fs.writeFile(path.join(nodeModules, 'npm-present', 'package.json'), '{"name":"npm-present"}')

    const plan = await planJunctions({ home })
    assert.equal(plan.profiles, 1)
    const byName = new Map(plan.actions.map((item) => [item.name, item]))
    assert.equal(byName.get('dsh-disaster-recovery').action, 'rebuild', '指向错误 → 重建')
    assert.equal(byName.get('other-plugin').action, 'create', '缺失 → 创建（../ 归一化）')
    assert.equal(byName.get('real-plugin').action, 'conflict', '真实目录 → 冲突不删')
    assert.equal(plan.conflicts.length, 1)
    assert.equal(plan.npmMissing.length, 1)
    assert.equal(plan.npmMissing[0].name, 'npm-missing')

    const applied = await applyJunctions(plan)
    assert.equal(applied.failed, 0)
    assert.ok(applied.updated >= 2)

    const fixed = await fs.readlink(path.join(nodeModules, 'dsh-disaster-recovery'))
    assert.ok(samePath(fixed, pluginTarget), `junction 应指向 ${pluginTarget}，实际 ${fixed}`)
    const created = await fs.readlink(path.join(nodeModules, 'other-plugin'))
    assert.ok(samePath(created, otherTarget), `junction 应指向 ${otherTarget}，实际 ${created}`)
    // 旧错误目标不是 junction，绝不能被删
    assert.equal(await fs.readFile(path.join(wrongTarget, 'marker.txt'), 'utf8'), 'wrong-target-must-survive')
    // 真实目录不能被删
    assert.equal(await fs.readFile(path.join(nodeModules, 'real-plugin', 'marker.txt'), 'utf8'), 'real-dir-must-survive')

    // 幂等：再跑一次计划，link 依赖全部 ok、没有待创建/重建
    const again = await planJunctions({ home })
    const againByName = new Map(again.actions.map((item) => [item.name, item]))
    assert.equal(againByName.get('dsh-disaster-recovery').action, 'ok')
    assert.equal(againByName.get('other-plugin').action, 'ok')
    assert.equal(junctionSummary(again).create, 0)
    assert.equal(junctionSummary(again).rebuild, 0)
  } finally {
    await cleanup(base)
  }
})

/* ═══════════════════════════════════════════════════ 6. 端到端 */

test('console: 删除 home 后从本地备份库恢复（逐文件 sha256、junction、报告 JSON、--no-start）', async () => {
  const base = await tempDir('dbk-rc-e2e-')
  try {
    const home = path.join(base, 'dsh-home')
    const storeRoot = path.join(base, 'store')
    await makeHome(home)
    const engine = await startEngine(home, storeRoot)
    const snapshotId = engine.state().lastSnapshot.id
    const hostDir = engine.store.dir
    const manifest = await engine.store.readManifest(snapshotId)
    const expectedFiles = await readManifestFiles(hostDir, manifest)
    assert.ok(expectedFiles.size >= 5)
    await engine.stop()

    // 模拟 .dsh 整个丢失
    const moved = path.join(base, 'dsh-home-moved-away')
    await fs.rename(home, moved)
    assert.equal(await pathExists(home), false)

    const first = await runConsoleCapture(['--home', home, '--store', storeRoot, '--yes', '--no-start'])
    assert.equal(first.code, 0, `restore exit=${first.code}\nstdout:\n${first.out}\nstderr:\n${first.err}`)
    assert.match(first.out, /推荐恢复点/)
    assert.match(first.out, /报告\s*:/)
    assert.ok(first.startCalls.length === 0, '--no-start 不得启动 DSH')

    // 逐文件 sha256 与清单一致
    const fileCount = await assertHomeMatches(hostDir, manifest, home)
    assert.ok(fileCount >= 5)

    // junction 已重建（我们恢复的 profile 声明了 link:./plugins/...）
    const junction = path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-disaster-recovery')
    const target = await fs.readlink(junction)
    assert.ok(samePath(target, path.join(home, 'profiles', 'desktop', 'plugins', 'dsh-disaster-recovery')))

    // 报告 JSON 字段
    const { report, raw, dir } = await readLatestReport(storeRoot)
    assert.equal(report.version, REPORT_VERSION)
    assert.equal(report.kind, 'external-restore')
    assert.equal(report.ok, true)
    assert.equal(report.exitCode, 0)
    assert.equal(report.source, 'local-store')
    assert.equal(report.paths.home, home)
    assert.equal(report.paths.storeRoot, storeRoot)
    assert.equal(report.snapshot.id, snapshotId)
    assert.equal(report.plan.files, Object.keys(manifest.files).length)
    assert.equal(report.restore.tool, 'cli')
    assert.equal(report.restore.ok, true)
    assert.ok(report.restore.result.restored >= 1)
    assert.ok(Array.isArray(report.junctions.results))
    assert.equal(report.start.requested, false)
    assert.equal(report.start.started, false)
    assert.ok(report.logs.consoleLog, '报告里应有日志路径')
    assert.equal(await pathExists(report.logs.consoleLog), true, 'console.log 必须真的写到磁盘')
    assert.equal(await pathExists(report.reportPath), true)
    assert.equal(path.basename(report.reportPath), 'report.json')
    assert.ok(dir.endsWith('-external-restore'))
    assert.ok(!/password|passwd/i.test(raw), '报告不得包含密码字段')

    // 再跑一次（不给 --no-start）：注入的 startDsh 应被调用（真实 GUI 不会启动）
    const second = await runConsoleCapture(['--home', home, '--store', storeRoot, '--yes'])
    assert.equal(second.code, 0, `second restore exit=${second.code}\n${second.out}\n${second.err}`)
    assert.deepEqual(second.startCalls, [DEFAULT_DSH_EXE])
  } finally {
    await cleanup(base)
  }
})

test('console: 非空目标恢复——清单外文件保留、被覆盖文件进 quarantine', async () => {
  const base = await tempDir('dbk-rc-nonempty-')
  try {
    const home = path.join(base, 'dsh-home')
    const storeRoot = path.join(base, 'store')
    await makeHome(home)
    const engine = await startEngine(home, storeRoot)
    const snapshotId = engine.state().lastSnapshot.id
    const hostDir = engine.store.dir
    await engine.stop()
    await fs.rename(home, path.join(base, 'moved'))
    await fs.mkdir(home, { recursive: true })
    await fs.writeFile(path.join(home, 'workspace.json'), '{"v":"dirty"}')
    await fs.writeFile(path.join(home, 'brand-new.txt'), 'keep-me')

    const result = await runConsoleCapture(['--home', home, '--store', storeRoot, '--yes', '--no-start'])
    assert.equal(result.code, 0, `${result.out}\n${result.err}`)
    // 清单内的文件恢复为快照内容
    const manifest = await loadManifest(hostDir, snapshotId)
    assert.equal(await fs.readFile(path.join(home, 'workspace.json'), 'utf8'), '{"v":1}')
    // 清单外文件保留
    assert.equal(await fs.readFile(path.join(home, 'brand-new.txt'), 'utf8'), 'keep-me')
    // quarantine 里应有被覆盖的旧内容
    const quarantineRoot = path.join(hostDir, 'restore-quarantine')
    const dirs = (await fs.readdir(quarantineRoot)).sort()
    assert.ok(dirs.length >= 1, '应有 restore-quarantine')
    let quarantined = null
    for (const name of dirs.slice().reverse()) {
      const candidate = path.join(quarantineRoot, name, 'workspace.json')
      if (await pathExists(candidate)) { quarantined = await fs.readFile(candidate, 'utf8'); break }
    }
    assert.equal(quarantined, '{"v":"dirty"}')
    const report = (await readLatestReport(storeRoot)).report
    assert.ok(report.restore.result.quarantined >= 1, `quarantine 计数：${JSON.stringify(report.restore.result)}`)
  } finally {
    await cleanup(base)
  }
})

/* ═══════════════════════════════════════════════ 7. 失败/拒绝 */

test('console: 快照缺块时整体拒绝（退出码 2，不写半份数据）', async () => {
  const base = await tempDir('dbk-rc-missing-')
  try {
    const home = path.join(base, 'dsh-home')
    const storeRoot = path.join(base, 'store')
    await makeHome(home)
    const engine = await startEngine(home, storeRoot)
    const snapshotId = engine.state().lastSnapshot.id
    const hostDir = engine.store.dir
    const manifest = await engine.store.readManifest(snapshotId)
    await engine.stop()
    // 删掉一个内容块
    const firstEntry = Object.values(manifest.files).find((entry) => entryChunks(entry).length > 0)
    const hash = entryChunks(firstEntry)[0]
    await fs.rm(blobPath(hostDir, hash))
    await fs.rename(home, path.join(base, 'moved'))

    const result = await runConsoleCapture(['--home', home, '--store', storeRoot, '--yes', '--no-start'])
    assert.equal(result.code, 2, `${result.out}\n${result.err}`)
    assert.match(result.err, /不可用|缺块|没有可用恢复点/)
    assert.equal(await pathExists(home), false, '拒绝时不得创建/写入 half home')
    const { report } = await readLatestReport(storeRoot)
    assert.equal(report.ok, false)
    assert.equal(report.exitCode, 2)
  } finally {
    await cleanup(base)
  }
})

test('console: DSH 正在运行时默认拒绝（不改任何数据），--force 需确认', async () => {
  const base = await tempDir('dbk-rc-running-')
  try {
    const storeRoot = path.join(base, 'store')
    await fs.mkdir(storeRoot, { recursive: true })
    const home = path.join(base, 'dsh-home')
    const result = await runConsoleCapture(
      ['--home', home, '--store', storeRoot, '--yes'],
      { detectDshProcesses: async () => [{ pid: 4321, name: 'DeepSeek Harness.exe' }] },
    )
    assert.equal(result.code, 1)
    assert.match(result.err, /正在运行/)
    assert.match(result.err, /--force/)
    assert.equal(await pathExists(path.join(storeRoot, 'manual')), false, '拒绝时不应写报告/改数据')

    // --force 但用户不输入 CONTINUE → 取消
    const cancelled = await runConsoleCapture(
      ['--home', home, '--store', storeRoot, '--force', '--auto'],
      {
        detectDshProcesses: async () => [{ pid: 4321, name: 'DeepSeek Harness.exe' }],
        ask: async () => 'no',
        interactive: true,
      },
    )
    assert.equal(cancelled.code, 1)
    assert.match(cancelled.out, /已取消/)
  } finally {
    await cleanup(base)
  }
})

/* ═══════════════════════════════════════════ 8. 子机仓库（recovery-kit） */

test('console: 本地备份库不可用时从子机 recovery-kit 恢复（dry-run + 真实恢复 + 报告）', async () => {
  const base = await tempDir('dbk-rc-kit-')
  try {
    const home = path.join(base, 'dsh-home')
    const localStore = path.join(base, 'local-store')
    await makeHome(home)
    const engine = await startEngine(home, localStore, {}, 'arch-host')
    const snapshotId = engine.state().lastSnapshot.id
    const hostDir = engine.store.dir
    const manifest = await engine.store.readManifest(snapshotId)
    const repoDir = path.join(base, 'offsite', 'repo')
    const repo = await LocalRepo.init({ dir: repoDir, password: PASSWORD, chunkSize: 1024 })
    await exportSnapshot({ engine, repo, snapshotId })
    await engine.stop()
    assert.equal(await pathExists(path.join(repoDir, 'recovery-kit', 'recover.mjs')), true, '导出应写入 recovery-kit')

    await fs.rename(home, path.join(base, 'moved'))
    const emptyStore = path.join(base, 'empty-store')
    const env = { ...process.env, DSH_TEST_RC_PW: PASSWORD }

    // 1) dry-run：只 verify，不写 home、不写报告
    const dry = await runConsoleCapture(
      ['--home', home, '--store', emptyStore, '--repo', repoDir, '--password-env', 'DSH_TEST_RC_PW', '--dry-run'],
      { env },
    )
    assert.equal(dry.code, 0, `${dry.out}\n${dry.err}`)
    assert.equal(await pathExists(home), false, 'dry-run 不得写目标目录')
    assert.equal(await pathExists(path.join(emptyStore, 'manual')), false, 'dry-run 不写报告')

    // 2) 真实恢复
    const restore = await runConsoleCapture(
      ['--home', home, '--store', emptyStore, '--repo', repoDir, '--password-env', 'DSH_TEST_RC_PW',
        '--yes', '--no-start'],
      { env },
    )
    assert.equal(restore.code, 0, `${restore.out}\n${restore.err}`)
    assert.match(restore.out, /从子机仓库恢复/)

    const fileCount = await assertHomeMatches(hostDir, manifest, home)
    assert.ok(fileCount >= 5)

    const { report, raw } = await readLatestReport(emptyStore)
    assert.equal(report.ok, true)
    assert.equal(report.exitCode, 0)
    assert.equal(report.source, 'recovery-kit')
    assert.equal(report.restore.tool, 'recovery-kit')
    assert.equal(report.restore.ok, true)
    assert.ok(report.restore.result.restored >= 1)
    assert.ok(report.kit.repoDir.length > 0)
    assert.equal(report.start.requested, false)
    assert.ok(!new RegExp(PASSWORD).test(raw), '报告不得包含密码')
    assert.equal(await pathExists(report.logs.consoleLog), true)
  } finally {
    await cleanup(base)
  }
})

test('console: recovery-kit 目标非空且没有 --force 时拒绝恢复（安全底线）', async () => {
  const base = await tempDir('dbk-rc-kit-force-')
  try {
    const seedHome = path.join(base, 'seed-home')
    const localStore = path.join(base, 'local-store')
    await makeHome(seedHome)
    const engine = await startEngine(seedHome, localStore, {}, 'arch-host')
    const snapshotId = engine.state().lastSnapshot.id
    const repoDir = path.join(base, 'offsite', 'repo')
    const repo = await LocalRepo.init({ dir: repoDir, password: PASSWORD, chunkSize: 1024 })
    await exportSnapshot({ engine, repo, snapshotId })
    await engine.stop()
    const kitScript = path.join(repoDir, 'recovery-kit', 'recover.mjs')

    const target = path.join(base, 'non-empty-target')
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, 'keep.txt'), 'must-not-be-touched')

    const rejected = await restoreFromKit({
      kitScript, repoDir, home: target, password: PASSWORD, force: false,
    })
    assert.notEqual(rejected.exitCode, 0, '非空目标不带 force 必须拒绝')
    assert.equal(rejected.ok, false)
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /force|非空/)
    assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'must-not-be-touched')
    assert.equal(await pathExists(path.join(target, 'workspace.json')), false)
  } finally {
    await cleanup(base)
  }
})

/* ═══════════════════════════════════════════ 9. list/verify/dry-run */

test('console: --list / --verify / --dry-run 行为与退出码', async () => {
  const base = await tempDir('dbk-rc-inspect-')
  try {
    const home = path.join(base, 'dsh-home')
    const storeRoot = path.join(base, 'store')
    await makeHome(home)
    const engine = await startEngine(home, storeRoot)
    const snapshotId = engine.state().lastSnapshot.id
    const hostDir = engine.store.dir
    const manifest = await engine.store.readManifest(snapshotId)
    await engine.stop()

    const list = await runConsoleCapture(['--home', home, '--store', storeRoot, '--list'])
    assert.equal(list.code, 0, `${list.out}\n${list.err}`)
    assert.match(list.out, /推荐恢复点/)
    assert.match(list.out, new RegExp(snapshotId))
    assert.equal(await pathExists(path.join(storeRoot, 'manual')), false, '--list 不写报告')

    const verified = await runConsoleCapture(['--home', home, '--store', storeRoot, '--verify'])
    assert.equal(verified.code, 0, `${verified.out}\n${verified.err}`)
    assert.match(verified.out, /PASS/)
    assert.match(verified.out, /全部通过/)

    // dry-run：计划可读、不改 home、不写报告（在删块之前跑，保证有可用推荐点）
    const moved = path.join(base, 'moved')
    await fs.rename(home, moved)
    const dry = await runConsoleCapture(['--home', home, '--store', storeRoot, '--dry-run'])
    assert.equal(dry.code, 0, `${dry.out}\n${dry.err}`)
    assert.match(dry.out, /dry-run/)
    assert.equal(await pathExists(home), false, 'dry-run 不得恢复')
    assert.equal(await pathExists(path.join(storeRoot, 'manual')), false, 'dry-run 不写报告')

    // 坏一份快照 → verify 退出码 2
    const firstEntry = Object.values(manifest.files).find((entry) => entryChunks(entry).length > 0)
    await fs.rm(blobPath(hostDir, entryChunks(firstEntry)[0]))
    const bad = await runConsoleCapture(['--home', home, '--store', storeRoot, '--verify'])
    assert.equal(bad.code, 2, `${bad.out}\n${bad.err}`)
    assert.match(bad.out, /FAIL/)
  } finally {
    await cleanup(base)
  }
})

/* ═══════════════════════════════════════════ 10. 安装布局（scripts/ + plugin/） */

test('console: 安装布局（scripts/ + plugin/）下独立运行、ps1 入口透传', async () => {
  const base = await tempDir('dbk-rc-installed-')
  try {
    const home = path.join(base, 'dsh-home')
    const storeRoot = path.join(base, 'store')
    await makeHome(home)
    const engine = await startEngine(home, storeRoot)
    const snapshotId = engine.state().lastSnapshot.id
    const hostDir = engine.store.dir
    const manifest = await engine.store.readManifest(snapshotId)
    await engine.stop()
    await fs.rename(home, path.join(base, 'moved'))

    // 按安装器约定：recovery-console/* → <RECOVERY_HOME>\scripts\；自包含 CLI → <RECOVERY_HOME>\plugin\
    const recoveryHome = path.join(base, 'DeepSeek Recovery')
    const scriptsDir = path.join(recoveryHome, 'scripts')
    const pluginDir = path.join(recoveryHome, 'plugin')
    await fs.mkdir(scriptsDir, { recursive: true })
    await fs.mkdir(path.join(pluginDir, 'scripts'), { recursive: true })
    for (const name of ['console.mjs', 'recovery-console.ps1', 'README.txt']) {
      await fs.copyFile(path.join(REPO_ROOT, 'recovery-console', name), path.join(scriptsDir, name))
    }
    await fs.copyFile(path.join(REPO_ROOT, 'scripts', 'cli.mjs'), path.join(pluginDir, 'scripts', 'cli.mjs'))
    await fs.copyFile(path.join(REPO_ROOT, 'package.json'), path.join(pluginDir, 'package.json'))
    await fs.cp(path.join(REPO_ROOT, 'src'), path.join(pluginDir, 'src'), { recursive: true })

    const env = { ...process.env, DSH_RECOVERY_HOME: recoveryHome }
    // 本机此时 DSH 正在运行（测试进程就在 DSH 里），子进程用 --force --yes 跳过进程拦截；
    // 默认拒绝的行为已由前面的注入式用例覆盖。
    const run = spawnSync(process.execPath, [
      path.join(scriptsDir, 'console.mjs'),
      '--home', home, '--store', storeRoot, '--yes', '--force', '--no-start',
    ], { encoding: 'utf8', env, timeout: 120000 })
    assert.equal(run.status, 0, `stdout=${run.stdout}\nstderr=${run.stderr}`)
    await assertHomeMatches(hostDir, manifest, home)
    const report = (await readLatestReport(storeRoot)).report
    assert.equal(report.restore.tool, 'cli')
    assert.equal(report.ok, true)

    // ps1 入口：-List 映射 --list、-NoPause 不暂停、参数透传
    const list = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsDir, 'recovery-console.ps1'),
      '-List', '-NoPause', '-Store', storeRoot, '-Home', home,
    ], { encoding: 'utf8', env, timeout: 120000 })
    assert.equal(list.status, 0, `stdout=${list.stdout}\nstderr=${list.stderr}`)
    assert.ok(String(list.stdout || '').trim().length > 0, 'ps1 入口应有输出')
  } finally {
    await cleanup(base)
  }
})

/* ═══════════════════════════════════════════ 11. 解析器小单元 */

test('console: CLI/kit 输出解析（恢复统计与失败明细）', () => {
  const cli = parseCliRestoreOutput([
    '即将把 snap-1 恢复到 C:\\x',
    '恢复完成：覆盖 12，未变 3，隔离 2',
    '快照里没有、当前保留未动的文件：4',
    '失败 2 项：',
    '  a/b.txt: write EPERM',
    '  c.txt: missing blob',
    '请完全退出并重新启动 DeepSeek Harness。',
  ].join('\n'))
  assert.equal(cli.restored, 12)
  assert.equal(cli.unchanged, 3)
  assert.equal(cli.quarantined, 2)
  assert.equal(cli.extraLeft, 4)
  assert.equal(cli.failed.length, 2)
  assert.equal(cli.failed[0].rel, 'a/b.txt')

  assert.equal(localStamp(new Date(2026, 9, 28, 15, 32, 10)), '20261028-153210')
})

async function pathExists(file) {
  try { await fs.access(file); return true } catch { return false }
}
