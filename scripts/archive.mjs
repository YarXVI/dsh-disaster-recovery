#!/usr/bin/env node
/**
 * dsh-disaster-recovery 异地加密仓库 CLI（零第三方依赖，Node >= 20）。
 *
 *   node scripts/archive.mjs init    [--dir <repoDir>] --password-stdin|--password-env NAME
 *   node scripts/archive.mjs export  [--snapshot <id>]
 *   node scripts/archive.mjs list
 *   node scripts/archive.mjs verify  [--snapshot <id>] [--all] [--fast]
 *   node scripts/archive.mjs import  <snapshotId>
 *   node scripts/archive.mjs restore <snapshotId>
 *   node scripts/archive.mjs drill   [--snapshot <id>] [--keep-temp]
 *   node scripts/archive.mjs status
 *   node scripts/archive.mjs kit     [--force]
 *
 * 全局参数：
 *   --home <dir>          DSH_HOME，默认 $DSH_HOME 或 ~/.dsh（只读遍历，不写它）
 *   --root <dir>          备份根，默认读 cordis.patch.yml 的 root / $DSH_DR_ROOT / D:\dsh-backup
 *   --store <dir>         直接指定 store 目录（<root>/<host>）；默认自动探测
 *   --offsite <dir>       offsite 目录，默认 <storeDir>/offsite
 *   --dir <dir>           仓库目录，默认 <offsite>/repo
 *   --password-stdin      从 stdin 第一行读密码（推荐：echo '密码' | node ...）
 *   --password-env NAME   从环境变量读密码
 *   --dpapi               用本机 DPAPI 缓存解锁（默认 <offsite>/key.dpapi，仅 Windows；无人值守导出用）
 *   --dpapi-file <file>   指定 DPAPI 缓存文件路径
 *   --json                机器可读输出（stdout 只输出一个 JSON）
 *   --yes                 restore 跳过交互确认
 *   --keep-temp           drill 保留临时目录（排错用）
 *
 * 安全约定：
 *   - 绝不接受命令行明文密码（--password 会被拒绝），密码不写日志/不写文件/不进 JSON 输出；
 *   - 默认 home 只被「读」；本 CLI 任何命令都不会自己拍快照（snapshotOnStart=false），
 *     所以 list/verify/status 对真实 store 是只读的；
 *   - restore 沿用引擎语义：先 pre-restore 快照，被覆盖文件进 restore-quarantine；
 *   - drill 全部在 os.tmpdir()/dsh-dr-drill-* 临时 home + 临时 store 里做，绝不碰真实 home。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import { BackupEngine, CONFIG_DEFAULTS } from '../src/engine.js'
import { LocalRepo, isRepoDir, readRepoMeta } from '../src/archive/repo.js'
import {
  checkLedgerChain, exportSnapshot, findLedgerEntry, ledgerPathFor, readLedger,
} from '../src/archive/export.js'
import { importSnapshotToEngine, verifyRemoteSnapshot } from '../src/archive/import.js'
import { passwordFromDpapi, secretFromDpapi } from '../src/archive/dpapi.js'
import { ensureRecoveryKit, recoveryKitStatus } from '../src/archive/recovery.js'
import { entryChunks, exists, formatBytes, joinInside, sha256hex } from '../src/util.js'

/** 密码/DPAPI 类失败统一用退出码 4（区别于一般错误 1、校验失败 2、恢复部分失败 3）。 */
const EXIT_PASSWORD = 4
const PASSWORD_ERROR_CODES = new Set([
  'dpapi-missing', 'dpapi-unavailable', 'dpapi-failed', 'dpapi-invalid',
  'password-required', 'password-missing', 'password-argv',
])

const USAGE = `用法：node scripts/archive.mjs <命令> [选项]

命令：
  init                    初始化加密仓库（需要密码；同时写入离线恢复工具 recovery-kit/）
  export                  导出最新快照到仓库（--snapshot 指定别的快照）
  list                    列出已归档快照
  verify                  校验仓库完整性（--snapshot 指定；--all 全量；--fast 跳过逐块解密）
  import <snapshotId>     把仓库里的快照导入本机引擎（不恢复文件）
  restore <snapshotId>    导入并恢复（pre-restore 快照 + quarantine，沿用引擎语义）
  drill [--snapshot id]   在临时 home 里真恢复并逐文件校验 sha256（不碰真实 home）
  status                  查看仓库/ledger/引擎/恢复工具状态
  kit [--force]           写入或修复离线恢复工具 <repo>/recovery-kit/

选项：
  --home <dir>        DSH_HOME（默认 $DSH_HOME 或 ~/.dsh）
  --root <dir>        备份根（默认 cordis.patch.yml 的 root / $DSH_DR_ROOT / D:\\dsh-backup）
  --store <dir>       直接指定 <root>/<host> store 目录
  --offsite <dir>     offsite 目录（默认 <storeDir>/offsite）
  --dir <dir>         仓库目录（默认 <offsite>/repo）
  --password-stdin    从 stdin 第一行读密码
  --password-env N    从环境变量 N 读密码
  --dpapi             用 DPAPI 缓存解锁（默认 <offsite>/key.dpapi，仅 Windows）
  --dpapi-file <f>    指定 DPAPI 缓存文件
  --dpapi-script <f>  指定 dpapi.ps1 路径（默认插件自带 scripts/dpapi.ps1）
  --snapshot <id>     指定快照
  --json              JSON 输出
  --yes               跳过 restore 确认
  --keep-temp         drill 保留临时目录
  --force             kit 强制重写

退出码：0 成功 / 1 一般错误 / 2 校验失败或缺块 / 3 恢复有文件失败 / 4 密码或 DPAPI 问题
`

/* ------------------------------------------------------------------ 基础 */

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) out[key] = true
      else { out[key] = next; i += 1 }
    } else {
      out._.push(arg)
    }
  }
  return out
}

function cliError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function sanitizeHostTag(name) {
  return String(name || 'host').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'host'
}

function log(message) {
  process.stderr.write(`[archive] ${message}\n`)
}

/* ------------------------------------------------------------------ 密码 */

const DPAPI_SCRIPT = fileURLToPath(new URL('../scripts/dpapi.ps1', import.meta.url))

/**
 * 取密码：--password-stdin / --password-env NAME / --dpapi（DPAPI 缓存）/ TTY 隐藏输入。
 * 任何来源都只在内存里，绝不打印、不落盘、不进 JSON。
 * @param {object} args  解析后的参数
 * @param {object} options
 * @param {string} [options.prompt] TTY 提示语
 * @param {{offsiteDir?:string}} [options.paths] --dpapi 默认缓存路径用
 */
async function acquirePassword(args, { prompt = '恢复密码：', paths = null } = {}) {
  if (typeof args.password === 'string' || args.password === true) {
    throw cliError('password-argv', '不接受命令行明文密码；请用 --password-stdin / --password-env NAME / --dpapi')
  }
  const envName = typeof args['password-env'] === 'string' ? args['password-env'] : ''
  if (envName) {
    const value = process.env[envName]
    if (typeof value !== 'string' || value.length === 0) {
      throw cliError('password-missing', `环境变量 ${envName} 不存在或为空`)
    }
    return value
  }
  if (args['password-stdin']) return readPasswordFromStdin()
  if (args.dpapi || typeof args['dpapi-file'] === 'string') {
    const explicit = typeof args['dpapi-file'] === 'string' && args['dpapi-file']
      ? path.resolve(args['dpapi-file'])
      : null
    // 默认：仓库目录的上一级（标准布局 = <storeDir>/offsite/key.dpapi，与面板一致）
    const fallback = paths && paths.repoDir
      ? path.join(path.dirname(path.resolve(paths.repoDir)), 'key.dpapi')
      : (paths && paths.offsiteDir ? path.join(paths.offsiteDir, 'key.dpapi') : null)
    if (!explicit && !fallback) {
      throw cliError('dpapi-missing', '无法确定 DPAPI 缓存路径：请加 --dpapi-file <file>')
    }
    const scriptPath = typeof args['dpapi-script'] === 'string' && args['dpapi-script']
      ? path.resolve(args['dpapi-script'])
      : DPAPI_SCRIPT
    return secretFromDpapi({ file: explicit || fallback, scriptPath })
  }
  if (process.stdin.isTTY) return readPasswordHidden(prompt)
  throw cliError('password-required',
    '需要密码：请用 --password-stdin / --password-env NAME / --dpapi')
}

async function readPasswordFromStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  const line = text.split(/\r?\n/)[0]
  if (!line) throw cliError('password-required', 'stdin 没有读到密码（第一行不能为空）')
  return line
}

/** TTY 下隐藏回显读密码（只写 stderr 提示，不回显字符）。 */
async function readPasswordHidden(prompt) {
  const stdin = process.stdin
  process.stderr.write(prompt)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  let value = ''
  try {
    return await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        for (const ch of String(chunk)) {
          if (ch === '\r' || ch === '\n') {
            stdin.removeListener('data', onData)
            process.stderr.write('\n')
            resolve(value)
            return
          }
          if (ch === '\u0003') { // Ctrl+C
            stdin.removeListener('data', onData)
            process.stderr.write('\n')
            reject(cliError('cancelled', '已取消'))
            return
          }
          if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue }
          if (ch === '\u001b' || ch === '\u0004') continue
          value += ch
        }
      }
      stdin.on('data', onData)
    })
  } finally {
    try { stdin.setRawMode(false) } catch { /* ignore */ }
    stdin.pause()
  }
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question(`${question} [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/* --------------------------------------------------------------- 路径解析 */

function resolveHome(args) {
  if (typeof args.home === 'string' && args.home) return path.resolve(args.home)
  const env = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (env) return path.resolve(env)
  return path.join(os.homedir(), '.dsh')
}

/** 备份根：--root > $DSH_DR_ROOT > cordis.patch.yml 的 root > CONFIG_DEFAULTS.root。 */
async function resolveRoot(args) {
  if (typeof args.root === 'string' && args.root) return path.resolve(args.root)
  const env = typeof process.env.DSH_DR_ROOT === 'string' ? process.env.DSH_DR_ROOT.trim() : ''
  if (env) return path.resolve(env)
  try {
    const text = await fsp.readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const match = text.match(/^\s*root:\s*(.+?)\s*$/m)
    if (match) {
      const value = match[1].replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')
      if (value) return path.resolve(value)
    }
  } catch { /* 没有 patch 文件就用默认值 */ }
  return path.resolve(CONFIG_DEFAULTS.root)
}

async function looksLikeStore(dir) {
  for (const name of ['offsite', 'snapshots', 'blobs', 'config.json']) {
    if (await exists(path.join(dir, name))) return true
  }
  return false
}

/** store 目录：--store > <root>/<hostname>（存在）> root 下唯一像 store 的目录 > <root>/<hostname>。 */
async function resolveStoreDir(args, root) {
  if (typeof args.store === 'string' && args.store) return path.resolve(args.store)
  const derived = path.join(path.resolve(root), sanitizeHostTag(os.hostname()))
  if (await looksLikeStore(derived)) return derived
  let entries = []
  try { entries = await fsp.readdir(path.resolve(root), { withFileTypes: true }) } catch { entries = [] }
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(path.resolve(root), entry.name)
    if (await looksLikeStore(dir)) candidates.push(dir)
  }
  if (candidates.length === 1) return candidates[0]
  return derived
}

async function resolvePaths(args) {
  const home = resolveHome(args)
  const root = await resolveRoot(args)
  const storeDir = await resolveStoreDir(args, root)
  const offsiteDir = typeof args.offsite === 'string' && args.offsite
    ? path.resolve(args.offsite)
    : path.join(storeDir, 'offsite')
  const repoDir = typeof args.dir === 'string' && args.dir
    ? path.resolve(args.dir)
    : path.join(offsiteDir, 'repo')
  return { home, root: path.dirname(storeDir), storeDir, offsiteDir, repoDir }
}

/**
 * 起一个「只读优先」的引擎：snapshotOnStart=false、watch=关，
 * 这样 list/verify/status/export 都不会往 store 里写快照。
 */
async function createEngine({ paths, verbose = false }) {
  const hostTag = path.basename(paths.storeDir)
  const engine = new BackupEngine({
    home: paths.home,
    config: {
      ...CONFIG_DEFAULTS,
      root: path.dirname(paths.storeDir),
      watch: false,
      debounceMs: 0,
      minIntervalMs: 0,
      scanMs: 3_600_000,
    },
    hostname: hostTag,
    snapshotOnStart: false,
    log: verbose ? (message) => log(message) : () => {},
  })
  await engine.start()
  engine.config.watch = false
  engine.stopWatcher()
  if (path.resolve(engine.store.dir) !== path.resolve(paths.storeDir)) {
    await engine.stop()
    throw cliError('store-mismatch',
      `无法把引擎指向 store 目录（引擎解析为 ${engine.store.dir}，期望 ${paths.storeDir}）`)
  }
  return engine
}

async function openRepo(paths, credential, { readonly = false } = {}) {
  if (!(await isRepoDir(paths.repoDir))) {
    throw cliError('no-repo', `仓库不存在：${paths.repoDir}（先运行 init）`)
  }
  if (readonly) return LocalRepo.openReadonly({ dir: paths.repoDir })
  if (typeof credential === 'string') return LocalRepo.open({ dir: paths.repoDir, password: credential })
  if (credential && credential.masterKey) {
    return LocalRepo.openWithMasterKey({ dir: paths.repoDir, masterKey: credential.masterKey })
  }
  if (credential && typeof credential.password === 'string') {
    return LocalRepo.open({ dir: paths.repoDir, password: credential.password })
  }
  throw cliError('password-required', '缺少可用的密码/密钥')
}

/** init 只能使用密码：DPAPI 缓存/ masterKey 只适用于已存在的仓库。 */
function passwordFromCredential(credential) {
  if (typeof credential === 'string') return credential
  if (credential && typeof credential.password === 'string') return credential.password
  throw cliError('dpapi-init', '初始化仓库必须输入恢复密码；DPAPI 缓存只用于已有仓库')
}

function bytesText(value) {
  return formatBytes(Number(value) || 0)
}

function isoText(ms) {
  const value = Number(ms) || 0
  return value ? new Date(value).toLocaleString() : '—'
}

/** ledger 里每个快照的最新节点，按 seq 倒序。 */
function latestLedgerEntries(ledger) {
  const byId = new Map()
  for (const entry of ledger && Array.isArray(ledger.entries) ? ledger.entries : []) {
    if (!entry || typeof entry !== 'object') continue
    const id = String(entry.snapshotId || '')
    if (!id) continue
    const previous = byId.get(id)
    if (!previous || (Number(entry.seq) || 0) > (Number(previous.seq) || 0)) byId.set(id, entry)
  }
  return [...byId.values()].sort((a, b) => (Number(b.seq) || 0) - (Number(a.seq) || 0))
}

/** 没有 ledger 时用密码解密清单枚举快照 id。 */
async function listSnapshotIdsFromRepo(repo) {
  const out = []
  for (const name of await repo.listManifestNames()) {
    try {
      const payload = await repo.getManifestByName(name)
      const id = payload && payload.snapshot && payload.snapshot.id
      if (id) out.push({ snapshotId: String(id), manifestName: name, prevManifest: payload.prevManifest || null, seq: Number(payload.seq) || 0 })
    } catch (error) {
      out.push({ snapshotId: null, manifestName: name, error: String((error && error.message) || error) })
    }
  }
  return out
}

function defaultSnapshotId(args) {
  const value = typeof args.snapshot === 'string' ? args.snapshot : ''
  return value && value !== 'latest' ? value : null
}

async function resolveTargetSnapshotId({ args, ledger, engine, repo = null }) {
  const explicit = defaultSnapshotId(args)
  if (explicit) return explicit
  const tip = latestLedgerEntries(ledger)[0]
  if (tip && tip.snapshotId) return tip.snapshotId
  const latest = engine && engine.latestSnapshotId ? engine.latestSnapshotId() : null
  if (latest) return latest
  if (repo) {
    const found = await listSnapshotIdsFromRepo(repo)
    const ids = found.filter((item) => item.snapshotId)
    if (ids.length) {
      ids.sort((a, b) => (b.seq || 0) - (a.seq || 0))
      return ids[0].snapshotId
    }
  }
  throw cliError('no-snapshot', '没有可用的快照（先用 export 归档一次）')
}

/* ---------------------------------------------------------------- 命令实现 */

async function cmdInit({ args, paths, json }) {
  const credential = await acquirePassword(args, { prompt: '设置恢复密码（至少 9 位，含字母和数字）：', paths })
  const password = passwordFromCredential(credential)
  const dir = paths.repoDir
  if (await isRepoDir(dir)) {
    throw cliError('repo-exists', `仓库已存在，拒绝覆盖：${dir}`)
  }
  const repo = await LocalRepo.init({ dir, password, chunkSize: CONFIG_DEFAULTS.chunkSize })
  const meta = repo.meta
  repo.close()
  const payload = {
    ok: true,
    dir,
    repoId: meta.repoId,
    chunkSize: meta.chunkSize,
    createdAt: meta.createdAt,
    kdf: { name: meta.kdf.name, N: meta.kdf.N, r: meta.kdf.r, p: meta.kdf.p },
  }
  if (json) return { code: 0, payload }
  console.log(`已初始化加密仓库：${dir}`)
  console.log(`  repoId   : ${meta.repoId}`)
  console.log(`  chunkSize: ${meta.chunkSize}`)
  console.log(`  KDF      : scrypt N=${meta.kdf.N} r=${meta.kdf.r} p=${meta.kdf.p}（16B 随机盐）`)
  console.log(`  ledger   : ${ledgerPathFor(dir)}（首次 export 时创建）`)
  console.log('')
  console.log('注意：密码丢失 = 数据不可读（无后门）。请把密码记在密码管理器里，并另做一份离线备份。')
  return { code: 0 }
}

async function cmdExport({ args, paths, json }) {
  const password = await acquirePassword(args, { paths })
  const repo = await openRepo(paths, password)
  const engine = await createEngine({ paths, verbose: Boolean(args.verbose) })
  try {
    const id = defaultSnapshotId(args) || engine.latestSnapshotId()
    if (!id) throw cliError('no-snapshot', '本机还没有可导出的快照（先让备份引擎拍一次快照）')
    const result = await exportSnapshot({ engine, repo, snapshotId: id })
    const ledger = await readLedger(repo.dir)
    const payload = { ok: true, ...result, ledgerSeq: Number(ledger.seq) || 0, ledgerPath: ledgerPathFor(repo.dir) }
    if (json) return { code: 0, payload }
    console.log(`已导出快照 ${result.snapshotId}`)
    console.log(`  清单      : ${result.manifestName}`)
    console.log(`  新增块    : ${result.newChunks}（复用 ${result.reusedChunks}）`)
    console.log(`  文件/字节 : ${result.files} / ${bytesText(result.bytes)}`)
    console.log(`  链序号    : seq=${result.seq}`)
    console.log(`  ledger    : ${ledgerPathFor(repo.dir)}`)
    return { code: 0 }
  } finally {
    repo.close()
    await engine.stop()
  }
}

async function cmdList({ args, paths, json }) {
  const ledger = await readLedger(paths.repoDir)
  let entries = latestLedgerEntries(ledger)
  let source = 'ledger'
  let extra = null
  if (!entries.length) {
    const password = await acquirePassword(args, { paths })
    const repo = await openRepo(paths, password)
    try {
      extra = await listSnapshotIdsFromRepo(repo)
      entries = extra.filter((item) => item.snapshotId).map((item) => ({
        snapshotId: item.snapshotId, manifestName: item.manifestName, seq: item.seq, files: null, bytes: null,
      }))
      source = 'manifests'
    } finally {
      repo.close()
    }
  } else if (args['password-stdin'] || typeof args['password-env'] === 'string'
    || args.dpapi || typeof args['dpapi-file'] === 'string') {
    // 给了密码/DPAPI：顺带验证每份清单都能解开（不改变列表来源）
    const password = await acquirePassword(args, { paths })
    const repo = await openRepo(paths, password)
    try {
      for (const entry of entries) {
        try {
          const { payload } = await repo.getManifest(entry.snapshotId)
          entry.files = payload.snapshot && Object.keys(payload.snapshot.files || {}).length
          entry.bytes = payload.snapshot && payload.snapshot.stats && payload.snapshot.stats.bytes
          entry.verified = true
        } catch (error) {
          entry.verified = false
          entry.error = String((error && error.message) || error)
        }
      }
    } finally {
      repo.close()
    }
  }
  const payload = {
    ok: true,
    repoDir: paths.repoDir,
    ledgerSeq: Number(ledger.seq) || 0,
    lastManifest: ledger.lastManifest || null,
    source,
    snapshots: entries.map((entry) => ({
      snapshotId: entry.snapshotId,
      manifestName: entry.manifestName,
      seq: Number(entry.seq) || 0,
      at: Number(entry.at) || 0,
      exportedAt: Number(entry.exportedAt) || 0,
      files: entry.files == null ? null : Number(entry.files),
      bytes: entry.bytes == null ? null : Number(entry.bytes),
      newChunks: entry.newChunks == null ? null : Number(entry.newChunks),
      reusedChunks: entry.reusedChunks == null ? null : Number(entry.reusedChunks),
      verified: entry.verified == null ? null : Boolean(entry.verified),
      error: entry.error || null,
    })),
  }
  if (json) return { code: 0, payload }
  console.log(`仓库      : ${paths.repoDir}`)
  console.log(`ledger    : seq=${payload.ledgerSeq} last=${payload.lastManifest ? payload.lastManifest.slice(0, 20) + '…' : '—'}（来源 ${source}）`)
  if (!payload.snapshots.length) {
    console.log('（还没有已归档快照；先运行 export）')
    return { code: 0 }
  }
  console.log('')
  for (const snap of payload.snapshots) {
    const files = snap.files == null ? '    ?' : String(snap.files).padStart(5)
    const bytes = snap.bytes == null ? '        ?' : bytesText(snap.bytes).padStart(9)
    const bad = snap.verified === false ? '  [清单校验失败]' : ''
    console.log(`${String(snap.seq).padStart(4)}  ${snap.snapshotId.padEnd(30)} ${files} files ${bytes}  ` +
      `${isoText(snap.exportedAt || snap.at)}${bad}`)
  }
  return { code: 0 }
}

async function cmdVerify({ args, paths, json }) {
  const password = await acquirePassword(args, { paths })
  const repo = await openRepo(paths, password)
  const engine = await createEngine({ paths, verbose: Boolean(args.verbose) })
  try {
    const ledger = await readLedger(repo.dir)
    const chain = await checkLedgerChain(ledger, repo)
    let targets = []
    if (args.all) {
      targets = latestLedgerEntries(ledger).map((entry) => entry.snapshotId)
      if (!targets.length) targets = (await listSnapshotIdsFromRepo(repo)).map((item) => item.snapshotId).filter(Boolean)
    } else {
      targets = [await resolveTargetSnapshotId({ args, ledger, engine, repo })]
    }
    const results = []
    for (const snapshotId of targets) {
      try {
        results.push(await verifyRemoteSnapshot({
          engine, repo, snapshotId, deep: !args.fast,
        }))
      } catch (error) {
        results.push({
          snapshotId,
          ok: false,
          manifestName: null,
          files: 0,
          chunks: 0,
          missingChunks: [],
          missingNames: [],
          corrupt: [{ hash: '', name: '', reason: String((error && error.message) || error) }],
          fromRepo: 0,
          fromStore: 0,
          prevManifest: null,
          seq: 0,
        })
      }
    }
    const ok = results.every((item) => item.ok) && chain.ok
    const payload = { ok, repoDir: repo.dir, ledger: { seq: Number(ledger.seq) || 0, lastManifest: ledger.lastManifest || null }, chain, snapshots: results }
    if (json) return { code: ok ? 0 : 2, payload }
    console.log(`仓库      : ${repo.dir}`)
    console.log(`哈希链    : ${chain.ok ? `完整（${chain.entries} 个节点）` : `异常 ${chain.problems.length} 处`}`)
    for (const problem of chain.problems.slice(0, 20)) {
      console.log(`  ! seq=${problem.seq} ${problem.snapshotId}: ${problem.problem}`)
    }
    for (const item of results) {
      console.log('')
      console.log(`快照      : ${item.snapshotId}`)
      console.log(`  清单    : ${item.manifestName || '—'}（seq=${item.seq}，prev=${item.prevManifest ? String(item.prevManifest).slice(0, 20) + '…' : 'null'}）`)
      console.log(`  文件/块 : ${item.files} / ${item.chunks}（仓库取 ${item.fromRepo}，本地已有 ${item.fromStore}）`)
      if (item.missingChunks.length) {
        console.log(`  缺块    : ${item.missingChunks.length} 个`)
        for (const name of item.missingNames.slice(0, 20)) console.log(`    - ${name}`)
      }
      if (item.corrupt.length) {
        console.log(`  损坏    : ${item.corrupt.length} 个`)
        for (const bad of item.corrupt.slice(0, 20)) console.log(`    - ${bad.name || bad.hash}: ${bad.reason}`)
      }
      console.log(`  结论    : ${item.ok ? 'PASS' : 'FAIL'}`)
    }
    return { code: ok ? 0 : 2 }
  } finally {
    repo.close()
    await engine.stop()
  }
}

async function cmdImport({ args, paths, json }) {
  const password = await acquirePassword(args, { paths })
  const repo = await openRepo(paths, password)
  const engine = await createEngine({ paths, verbose: Boolean(args.verbose) })
  try {
    const ledger = await readLedger(repo.dir)
    const positional = args._[1]
    const id = positional && positional !== 'latest' ? positional : await resolveTargetSnapshotId({ args, ledger, engine, repo })
    const result = await importSnapshotToEngine({ engine, repo, snapshotId: id })
    const payload = {
      ok: true,
      snapshotId: id,
      manifestName: repo.manifestNameFor(id),
      importedChunks: result.importedChunks,
      reusedChunks: result.reusedChunks,
      files: result.files,
      storeDir: engine.store.dir,
    }
    if (json) return { code: 0, payload }
    console.log(`已导入快照 ${id} 到引擎（未恢复文件）`)
    console.log(`  清单    : ${payload.manifestName}`)
    console.log(`  块      : 新写入 ${result.importedChunks}，本地已复用 ${result.reusedChunks}`)
    console.log(`  文件    : ${result.files}`)
    console.log(`  store   : ${engine.store.dir}`)
    console.log('下一步：node scripts/archive.mjs restore ' + id)
    return { code: 0 }
  } finally {
    repo.close()
    await engine.stop()
  }
}

async function cmdRestore({ args, paths, json }) {
  const password = await acquirePassword(args, { paths })
  const repo = await openRepo(paths, password)
  const engine = await createEngine({ paths, verbose: Boolean(args.verbose) })
  try {
    const ledger = await readLedger(repo.dir)
    const positional = args._[1]
    const id = positional && positional !== 'latest' ? positional : await resolveTargetSnapshotId({ args, ledger, engine, repo })
    if (!json && !args.yes) {
      if (!process.stdin.isTTY) {
        throw cliError('need-confirm', '非交互环境请加 --yes 确认恢复')
      }
      console.log(`即将把 ${id} 恢复到 ${paths.home}`)
      console.log('当前状态会先自动做一次 pre-restore 快照；被覆盖的文件另存到 restore-quarantine。')
      if (!(await confirm('确认恢复？'))) {
        console.log('已取消')
        return { code: 1 }
      }
    }
    const imported = await importSnapshotToEngine({ engine, repo, snapshotId: id })
    const result = await engine.restore(id)
    const payload = {
      ok: result.failed.length === 0,
      snapshotId: id,
      importedChunks: imported.importedChunks,
      reusedChunks: imported.reusedChunks,
      files: imported.files,
      restore: {
        restored: result.restored,
        unchanged: result.unchanged,
        quarantined: result.quarantined,
        extraLeft: result.extraLeft,
        failed: result.failed,
        quarantineDir: result.quarantineDir,
        preSnapshot: result.preSnapshot,
        needRestart: result.needRestart,
      },
    }
    if (json) return { code: result.failed.length ? 3 : 0, payload }
    console.log(`恢复完成：快照 ${id}`)
    console.log(`  覆盖 ${result.restored}，未变 ${result.unchanged}，隔离 ${result.quarantined}`)
    if (result.extraLeft) console.log(`  快照里没有、当前保留未动的文件：${result.extraLeft}`)
    if (result.quarantineDir) console.log(`  隔离目录：${result.quarantineDir}`)
    if (result.preSnapshot) console.log(`  恢复前快照：${result.preSnapshot}`)
    if (result.failed.length) {
      console.log(`  失败 ${result.failed.length} 项：`)
      for (const item of result.failed.slice(0, 20)) console.log(`    - ${item.rel}: ${item.reason}`)
    }
    console.log('请完全退出并重新启动 DeepSeek Harness。')
    return { code: result.failed.length ? 3 : 0 }
  } finally {
    repo.close()
    await engine.stop()
  }
}

async function cmdDrill({ args, paths, json }) {
  const password = await acquirePassword(args, { paths })
  const repo = await openRepo(paths, password)
  const startedAt = Date.now()
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-dr-drill-'))
  const tempHome = path.join(base, 'home')
  const tempRoot = path.join(base, 'root')
  await fsp.mkdir(tempHome, { recursive: true })
  await fsp.mkdir(tempRoot, { recursive: true })
  const engine = new BackupEngine({
    home: tempHome,
    config: {
      ...CONFIG_DEFAULTS, root: tempRoot, watch: false, debounceMs: 0, minIntervalMs: 0, scanMs: 3_600_000,
    },
    hostname: 'drill-host',
    snapshotOnStart: false,
    log: () => {},
  })
  try {
    await engine.start()
    engine.config.watch = false
    engine.stopWatcher()
    const ledger = await readLedger(repo.dir)
    const id = await resolveTargetSnapshotId({ args, ledger, engine: null, repo })
    const imported = await importSnapshotToEngine({ engine, repo, snapshotId: id })
    const manifest = imported.manifest
    const restored = await engine.restore(id, { skipPreBackup: true })
    const chunkSize = Math.max(1024, Number(manifest.chunkSize) || CONFIG_DEFAULTS.chunkSize)
    const failures = []
    let passed = 0
    const files = Object.keys(manifest.files || {})
    for (const rel of files) {
      const entry = manifest.files[rel]
      const abs = joinInside(tempHome, rel)
      if (!abs) { failures.push({ rel, reason: '非法路径（越界）' }); continue }
      let buf
      try {
        buf = await fsp.readFile(abs)
      } catch (error) {
        failures.push({ rel, reason: `恢复后文件缺失/不可读：${String((error && error.code) || error)}` })
        continue
      }
      if (buf.length !== Number(entry.s || 0)) {
        failures.push({ rel, reason: `大小不符（期望 ${Number(entry.s || 0)}，实际 ${buf.length}）` })
        continue
      }
      const chunks = entryChunks(entry)
      if (chunks.length === 0) {
        if (buf.length !== 0) { failures.push({ rel, reason: '清单为空块但恢复出非空文件' }); continue }
        passed += 1
        continue
      }
      const expectedCount = Math.ceil(buf.length / chunkSize)
      if (expectedCount !== chunks.length) {
        failures.push({ rel, reason: `块数不符（清单 ${chunks.length}，按 chunkSize=${chunkSize} 应为 ${expectedCount}）` })
        continue
      }
      let bad = null
      for (let index = 0; index < chunks.length; index += 1) {
        const piece = buf.subarray(index * chunkSize, Math.min((index + 1) * chunkSize, buf.length))
        if (sha256hex(piece) !== chunks[index]) { bad = `第 ${index + 1}/${chunks.length} 块 sha256 不符`; break }
      }
      if (bad) { failures.push({ rel, reason: bad }); continue }
      passed += 1
    }
    for (const item of restored.failed || []) failures.push({ rel: item.rel, reason: item.reason })
    const ok = failures.length === 0
    const payload = {
      ok,
      snapshotId: id,
      files: files.length,
      passed,
      failed: failures.length,
      failures: failures.slice(0, 50),
      chunks: imported.importedChunks + imported.reusedChunks,
      importedChunks: imported.importedChunks,
      reusedChunks: imported.reusedChunks,
      restored: { restored: restored.restored, unchanged: restored.unchanged, quarantined: restored.quarantined },
      durationMs: Date.now() - startedAt,
      tempDir: args['keep-temp'] ? base : null,
    }
    if (json) return { code: ok ? 0 : 2, payload }
    console.log(`演练快照 : ${id}`)
    console.log(`临时 home: ${tempHome}`)
    console.log(`文件校验 : ${passed}/${files.length} 通过`)
    console.log(`结果     : ${ok ? 'PASS' : `FAIL（${failures.length} 项）`}`)
    for (const item of failures.slice(0, 20)) console.log(`  ! ${item.rel}: ${item.reason}`)
    console.log(`耗时     : ${payload.durationMs} ms`)
    if (args['keep-temp']) console.log(`临时目录保留：${base}`)
    return { code: ok ? 0 : 2 }
  } finally {
    try { await engine.stop() } catch { /* ignore */ }
    repo.close()
    if (!args['keep-temp']) {
      try { await fsp.rm(base, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}

async function cmdKit({ args, paths, json }) {
  if (!(await isRepoDir(paths.repoDir))) {
    throw cliError('no-repo', `仓库不存在：${paths.repoDir}（先运行 init）`)
  }
  const result = await ensureRecoveryKit(paths.repoDir, { force: Boolean(args.force) })
  const status = await recoveryKitStatus(paths.repoDir)
  const payload = {
    ok: status.ok,
    dir: result.dir,
    version: result.version,
    written: result.written,
    files: result.files.map((file) => file.path),
    status,
  }
  if (json) return { code: payload.ok ? 0 : 2, payload }
  console.log(`恢复工具目录：${result.dir}`)
  console.log(`  kit 版本  : v${result.version}（${result.files.length} 个文件）`)
  if (result.written.length) console.log(`  本次写入  : ${result.written.join(', ')}`)
  else console.log('  本次写入  : 无（内容已是最新）')
  if (status.missing.length) console.log(`  缺失      : ${status.missing.join(', ')}`)
  if (status.stale.length) console.log(`  与代码不一致：${status.stale.join(', ')}`)
  console.log('')
  console.log('离线恢复用法（把整个仓库目录拷到任意装了 Node≥20 的机器）：')
  console.log(`  node ${path.join(result.dir, 'recover.mjs')} list    --dir ${paths.repoDir}`)
  console.log(`  node ${path.join(result.dir, 'recover.mjs')} verify  --dir ${paths.repoDir}`)
  console.log(`  node ${path.join(result.dir, 'recover.mjs')} restore --dir ${paths.repoDir} --home <目标目录> --yes`)
  return { code: payload.ok ? 0 : 2 }
}

async function cmdStatus({ args, paths, json }) {
  const meta = await readRepoMeta(paths.repoDir)
  const ledger = await readLedger(paths.repoDir)
  let repoStats = null
  let repo = null
  let kit = null
  if (meta) {
    repo = await LocalRepo.openReadonly({ dir: paths.repoDir })
    repoStats = await repo.stats()
    kit = await recoveryKitStatus(paths.repoDir).catch(() => null)
  }
  let engine = null
  if (await exists(paths.storeDir)) {
    engine = await createEngine({ paths })
  }
  try {
    const chain = await checkLedgerChain(ledger, repo)
    const state = engine ? engine.state() : null
    const entries = latestLedgerEntries(ledger)
    const engineLatest = state ? state.lastSnapshot && state.lastSnapshot.id : null
    const exported = engineLatest ? Boolean(findLedgerEntry(ledger, engineLatest)) : false
    const payload = {
      ok: true,
      home: paths.home,
      storeDir: paths.storeDir,
      offsiteDir: paths.offsiteDir,
      repoDir: paths.repoDir,
      repoExists: Boolean(meta),
      repo: meta ? LocalRepo.describe(meta) : null,
      repoStats,
      recoveryKit: kit,
      ledger: {
        path: ledgerPathFor(paths.repoDir),
        seq: Number(ledger.seq) || 0,
        lastManifest: ledger.lastManifest || null,
        entries: entries.length,
        updatedAt: Number(ledger.updatedAt) || 0,
        chainOk: chain.ok,
        chainProblems: chain.problems,
      },
      engine: state ? {
        snapshotCount: state.snapshotCount,
        latest: engineLatest,
        latestAt: state.lastSnapshot ? state.lastSnapshot.at : null,
        latestExported: exported,
        paused: state.paused,
        health: state.health ? state.health.code : null,
        storeDir: state.storeDir,
        pinned: state.pinned || [],
      } : null,
    }
    if (json) return { code: 0, payload }
    console.log(`home      : ${payload.home}`)
    console.log(`store     : ${payload.storeDir}`)
    console.log(`仓库      : ${payload.repoDir}${payload.repoExists ? '' : '（未初始化）'}`)
    if (payload.repo) {
      const info = payload.repo
      console.log(`  仓库头  : format=${info.format} v${info.version} repoId=${info.repoId} chunkSize=${info.chunkSize}`)
      console.log(`  KDF     : ${info.kdf ? `${info.kdf.name} N=${info.kdf.N} r=${info.kdf.r} p=${info.kdf.p}` : '—'}，keyCheck=${info.keyCheck ? '有' : '无'}`)
      if (payload.repoStats) {
        const s = payload.repoStats
        console.log(`  内容    : ${s.chunks} 块 / ${bytesText(s.chunkBytes)}，${s.manifests} 清单 / ${bytesText(s.manifestBytes)}，` +
          `${s.packs} 包 / ${bytesText(s.packBytes)}，合计 ${bytesText(s.bytes)}`)
      }
      if (payload.recoveryKit) {
        const k = payload.recoveryKit
        const state = !k.present ? '缺失（运行 kit 命令修复）'
          : (k.missing.length || k.stale.length ? `不完整（缺 ${k.missing.length}，过期 ${k.stale.length}；运行 kit 修复）` : '就绪')
        console.log(`  恢复工具: ${state}（${k.dir}）`)
      }
    }
    console.log(`ledger    : seq=${payload.ledger.seq}，${payload.ledger.entries} 个快照，` +
      `链${payload.ledger.chainOk ? '完整' : `异常（${payload.ledger.chainProblems.length} 处）`}，更新于 ${isoText(payload.ledger.updatedAt)}`)
    if (payload.engine) {
      console.log(`引擎      : ${payload.engine.snapshotCount} 个快照，latest=${payload.engine.latest || '—'}` +
        `${payload.engine.latest ? `（${payload.engine.latestExported ? '已导出' : '未导出'}）` : ''}` +
        `${payload.engine.paused ? '，已暂停' : ''}，健康=${payload.engine.health}`)
    } else {
      console.log('引擎      : store 目录不存在（还没备份过）')
    }
    return { code: 0 }
  } finally {
    if (repo) repo.close()
    if (engine) await engine.stop()
  }
}

/* -------------------------------------------------------------------- main */

const COMMANDS = {
  init: cmdInit,
  export: cmdExport,
  list: cmdList,
  verify: cmdVerify,
  import: cmdImport,
  restore: cmdRestore,
  drill: cmdDrill,
  status: cmdStatus,
  kit: cmdKit,
}

async function main(argv) {
  const args = parseArgs(argv)
  const command = args._[0] || (args.help ? 'help' : 'status')
  if (command === 'help' || command === '--help' || args.help) {
    process.stdout.write(USAGE)
    return 0
  }
  const handler = COMMANDS[command]
  if (!handler) {
    log(`未知命令：${command}`)
    process.stderr.write(USAGE)
    return 1
  }
  const paths = await resolvePaths(args)
  const json = Boolean(args.json)
  try {
    const result = await handler({ args, paths, json })
    if (json && result && result.payload) {
      process.stdout.write(JSON.stringify(result.payload, null, 2) + '\n')
    }
    return result && Number.isInteger(result.code) ? result.code : 0
  } catch (error) {
    const errorCode = error && error.code ? String(error.code) : 'error'
    const code = error && error.code ? `[${error.code}] ` : ''
    const message = String((error && error.message) || error)
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, error: { code: errorCode, message } }, null, 2) + '\n')
    } else {
      log(`失败：${code}${message}`)
      if (args.debug && error && error.stack) process.stderr.write(error.stack + '\n')
    }
    return PASSWORD_ERROR_CODES.has(errorCode) ? EXIT_PASSWORD : 1
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code
}).catch((error) => {
  log(`失败：${String((error && error.message) || error)}`)
  process.exitCode = 1
})
