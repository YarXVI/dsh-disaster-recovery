#!/usr/bin/env node
/**
 * dsh-disaster-recovery 离线恢复工具（recovery-kit 入口，零第三方依赖，Node >= 20）
 *
 * 这个文件会被 `ensureRecoveryKit()` 原样复制到
 *   <repo>/recovery-kit/recover.mjs
 * 并把依赖一起复制成：
 *   <repo>/recovery-kit/src/archive/format.js
 *   <repo>/recovery-kit/src/archive/repo.js
 *   <repo>/recovery-kit/src/archive/dpapi.js
 *   <repo>/recovery-kit/src/util.js
 *   <repo>/recovery-kit/dpapi.ps1
 * 所以只要 Submachine / 离线盘上有整个仓库目录（含 recovery-kit），
 * 即使本机 DSH、本插件全没了，也能直接：
 *   node recovery-kit/recover.mjs verify --dir <repo>
 *   node recovery-kit/recover.mjs restore --dir <repo> --home <目标目录> --yes
 *
 * 命令：
 *   list   --dir <repo>                      列出快照（需要密码）
 *   verify --dir <repo> [--snapshot id] [--all] [--fast]
 *                                            校验清单与所有内容块（缺块/篡改会列出来）
 *   restore --dir <repo> --home <dir> [--snapshot id] [--force] [--yes]
 *                                            先完整 verify，再安全写回目标目录
 *
 * 密码来源（三选一，绝不接受命令行明文密码）：
 *   --password-stdin           stdin 第一行
 *   --password-env NAME        环境变量 NAME
 *   --dpapi [--dpapi-file f] [--dpapi-script f]
 *                              读 DPAPI 缓存（默认 <repo>/../key.dpapi，仅 Windows）
 *
 * 恢复语义（与面板/引擎一致的安全底线）：
 *   - 缺任何一个内容块都整体拒绝，不做部分恢复；
 *   - 目标目录非空必须显式 --force；
 *   - 会被覆盖的现有文件先复制到 <repo>/../recovery-quarantine/<时间戳>/；
 *   - 目标里「清单没有的多余文件」一个都不删；
 *   - 单个文件原子写（临时文件 + rename），中断不会留半截文件。
 *
 * 退出码：0 成功 / 1 用法或一般错误 / 2 校验失败或缺块 / 3 恢复有文件失败 / 4 密码或 DPAPI 问题
 */
import fsp from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const KIT_ROOT = path.dirname(fileURLToPath(import.meta.url))

/**
 * 同时支持两种布局：
 *   kit：<repo>/recovery-kit/recover.mjs  → ./src/...
 *   dev：插件仓库 scripts/recover.mjs     → ../src/...
 */
async function loadCore() {
  let lastError = null
  for (const base of ['./src', '../src']) {
    try {
      const repoMod = await import(new URL(`${base}/archive/repo.js`, import.meta.url).href)
      const formatMod = await import(new URL(`${base}/archive/format.js`, import.meta.url).href)
      const dpapiMod = await import(new URL(`${base}/archive/dpapi.js`, import.meta.url).href)
      const utilMod = await import(new URL(`${base}/util.js`, import.meta.url).href)
      if (typeof repoMod.LocalRepo !== 'function' || typeof formatMod.decryptManifest !== 'function') {
        throw new Error('核心模块导出不完整')
      }
      return { repoMod, formatMod, dpapiMod, utilMod }
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(
    'recover.mjs 找不到核心模块。请确认它和 recovery-kit/ 目录一起被复制（或在插件仓库的 scripts/ 下运行）。' +
    (lastError ? ` 原因：${String(lastError.message || lastError)}` : ''),
  )
}

const CORE = await loadCore()
const { LocalRepo, isRepoDir } = CORE.repoMod
const { repoError } = CORE.formatMod
const { entryChunks, formatBytes, joinInside, sha256hex, writeFileAtomic, walkFiles } = CORE.utilMod
const { secretFromDpapi } = CORE.dpapiMod

const USAGE = `用法：node recover.mjs <命令> [选项]

命令：
  list    列出仓库里的快照
  verify  校验快照（清单 + 逐块解密校验 sha256）
  restore 恢复到指定目录（先完整校验，再安全写回）

通用选项：
  --dir <repo>         仓库目录（含 repo.json；默认取 recovery-kit 的上一级）
  --snapshot <id>      指定快照 id（默认最新：seq 最大）
  --password-stdin     从 stdin 第一行读密码
  --password-env NAME  从环境变量读密码
  --dpapi              用 DPAPI 缓存密码（默认 <repo>/../key.dpapi，仅 Windows）
  --dpapi-file <file>  DPAPI 缓存文件路径
  --dpapi-script <f>   指定 dpapi.ps1 路径（默认 kit 自带 dpapi.ps1）
  --json               JSON 输出

verify 选项：
  --all                校验全部快照（默认只校验目标快照）
  --fast               只查块是否存在（跳过逐块解密校验，不建议）

restore 选项：
  --home <dir>         恢复目标目录（必填）
  --force              目标目录非空时仍继续（会被覆盖的文件进 quarantine）
  --yes                跳过交互确认

退出码：0 成功 / 1 用法或一般错误 / 2 校验失败或缺块 / 3 恢复有文件失败 / 4 密码或 DPAPI 问题
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
  const error = new Error(String(message == null ? '' : message))
  error.code = String(code || 'error')
  return error
}

const EXIT_CODE_BY_ERROR = {
  'dpapi-missing': 4,
  'dpapi-unavailable': 4,
  'dpapi-failed': 4,
  'dpapi-invalid': 4,
  'password-required': 4,
  'password-missing': 4,
  'password-argv': 4,
}

function exitCodeFor(error) {
  const code = error && error.code ? String(error.code) : ''
  return EXIT_CODE_BY_ERROR[code] || 1
}

function log(message) {
  process.stderr.write(`[recover] ${message}\n`)
}

function isoText(ms) {
  const value = Number(ms) || 0
  return value ? new Date(value).toLocaleString() : '—'
}

function shortName(name) {
  const text = String(name || '')
  return text.length > 34 ? `${text.slice(0, 18)}…${text.slice(-12)}` : text
}

/* ------------------------------------------------------------------ 密码 */

async function readPasswordFromStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  const line = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0]
  if (!line) throw cliError('password-required', 'stdin 没有读到密码（第一行不能为空）')
  return line
}

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
          if (ch === '\u0003') {
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

function defaultRepoDir() {
  return path.basename(KIT_ROOT) === 'recovery-kit' ? path.dirname(KIT_ROOT) : null
}

function resolveRepoDir(args) {
  if (typeof args.dir === 'string' && args.dir) return path.resolve(args.dir)
  const guess = defaultRepoDir()
  if (guess) return guess
  throw cliError('bad-args', '缺少 --dir <仓库目录>（repo.json 所在目录）')
}

function dpapiScriptPath(args = {}) {
  if (typeof args['dpapi-script'] === 'string' && args['dpapi-script']) {
    return path.resolve(args['dpapi-script'])
  }
  const candidates = [
    path.join(KIT_ROOT, 'dpapi.ps1'),
    path.join(KIT_ROOT, 'scripts', 'dpapi.ps1'),
    path.join(KIT_ROOT, '..', 'scripts', 'dpapi.ps1'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0]
}

async function acquirePassword(args, repoDir) {
  if (args.password !== undefined) {
    throw cliError('password-argv', '不接受命令行明文密码；请用 --password-stdin / --password-env / --dpapi')
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
    const file = typeof args['dpapi-file'] === 'string' && args['dpapi-file']
      ? path.resolve(args['dpapi-file'])
      : path.join(path.dirname(path.resolve(repoDir)), 'key.dpapi')
    return secretFromDpapi({ file, scriptPath: dpapiScriptPath(args) })
  }
  if (process.stdin.isTTY) return readPasswordHidden('恢复密码：')
  throw cliError('password-required', '需要密码：请用 --password-stdin / --password-env NAME / --dpapi')
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

/* --------------------------------------------------------------- 仓库读取 */

async function openRepo(args) {
  const dir = resolveRepoDir(args)
  if (!(await isRepoDir(dir))) {
    throw cliError('no-repo', `不是加密仓库（缺少 repo.json）：${dir}`)
  }
  const credential = await acquirePassword(args, dir)
  let repo
  if (typeof credential === 'string') {
    repo = await LocalRepo.open({ dir, password: credential })
  } else if (credential && credential.masterKey) {
    repo = await LocalRepo.openWithMasterKey({ dir, masterKey: credential.masterKey })
  } else if (credential && typeof credential.password === 'string') {
    repo = await LocalRepo.open({ dir, password: credential.password })
  } else {
    throw cliError('password-required', '缺少可用的密码/密钥')
  }
  return { repo, dir }
}

/** 读并解密全部清单，按 seq/at 倒序；坏清单单独收集。 */
async function readAllManifests(repo) {
  const manifests = []
  const problems = []
  for (const name of await repo.listManifestNames()) {
    try {
      const payload = await repo.getManifestByName(name)
      const snapshot = payload && payload.snapshot
      if (!snapshot || typeof snapshot !== 'object') throw cliError('bad-manifest', '清单缺少 snapshot')
      manifests.push({ name, payload, snapshot })
    } catch (error) {
      problems.push({ name, error: String((error && error.message) || error) })
    }
  }
  manifests.sort((a, b) => (Number(b.payload.seq) || 0) - (Number(a.payload.seq) || 0)
    || (Number(b.snapshot.at) || 0) - (Number(a.snapshot.at) || 0))
  return { manifests, problems }
}

/** 哈希链检查（只告警，不阻止恢复：保留策略可能删掉旧清单）。 */
async function checkChain(repo, manifests) {
  const problems = []
  const byName = new Map(manifests.map((item) => [item.name, item]))
  const sorted = [...manifests].sort((a, b) => (Number(a.payload.seq) || 0) - (Number(b.payload.seq) || 0))
  let prev = null
  for (const item of sorted) {
    const seq = Number(item.payload.seq) || 0
    const prevName = item.payload.prevManifest || null
    if (prev) {
      if (prevName !== prev.name) {
        problems.push({ seq, manifestName: item.name, problem: 'prevManifest 未指向上一个节点' })
      } else if (seq !== (Number(prev.payload.seq) || 0) + 1) {
        problems.push({ seq, manifestName: item.name, problem: 'seq 不连续' })
      }
    } else if (prevName) {
      // 链首节点仍有 prevManifest：说明更早的清单已被保留策略删掉（可能正常，也可能断档）
      if (!(await repo.hasManifestName(prevName))) {
        problems.push({ seq, manifestName: item.name, problem: `prevManifest 指向的旧清单不存在（${shortName(prevName)}）`, tolerated: true })
      }
    }
    if (prevName && !byName.has(prevName) && !(await repo.hasManifestName(prevName))) {
      problems.push({ seq, manifestName: item.name, problem: '前驱清单缺失（断链）', tolerated: true })
    }
    prev = item
  }
  return problems
}

function chunkListOf(snapshot) {
  const order = []
  const seen = new Set()
  for (const rel of Object.keys((snapshot && snapshot.files) || {}).sort()) {
    for (const hash of entryChunks(snapshot.files[rel])) {
      if (seen.has(hash)) continue
      seen.add(hash)
      order.push(hash)
    }
  }
  return order
}

/** 完整校验一个清单：逐块解密 + sha256 校验（fast=true 只查存在）。 */
async function verifyManifest(repo, manifestNameValue, snapshot, { fast = false } = {}) {
  const missingChunks = []
  const missingNames = []
  const corrupt = []
  const hashes = chunkListOf(snapshot)
  for (const hash of hashes) {
    if (!(await repo.hasChunk(hash))) {
      missingChunks.push(hash)
      missingNames.push(repo.chunkNameFor(hash))
      continue
    }
    if (fast) continue
    try {
      await repo.getChunk(hash)
    } catch (error) {
      if (error && error.code === 'missing-chunk') {
        missingChunks.push(hash)
        missingNames.push(repo.chunkNameFor(hash))
      } else {
        corrupt.push({ hash, name: repo.chunkNameFor(hash), reason: String((error && error.message) || error) })
      }
    }
  }
  return {
    manifestName: manifestNameValue,
    snapshotId: String(snapshot.id || ''),
    files: Object.keys(snapshot.files || {}).length,
    chunks: hashes.length,
    ok: missingChunks.length === 0 && corrupt.length === 0,
    missingChunks,
    missingNames,
    corrupt,
    bytes: Number((snapshot.stats && snapshot.stats.bytes) || 0),
  }
}

function pickTarget(manifests, args) {
  const wanted = typeof args.snapshot === 'string' ? args.snapshot : ''
  if (wanted && wanted !== 'latest') {
    return manifests.find((item) => String(item.snapshot.id) === wanted) || null
  }
  return manifests[0] || null
}

/* ---------------------------------------------------------------- 命令实现 */

async function cmdList({ args, json }) {
  const { repo, dir } = await openRepo(args)
  try {
    const { manifests, problems } = await readAllManifests(repo)
    const payload = {
      ok: problems.length === 0,
      repoDir: dir,
      counts: { snapshots: manifests.length },
      snapshots: manifests.map((item) => ({
        snapshotId: String(item.snapshot.id || ''),
        manifestName: item.name,
        at: Number(item.snapshot.at) || 0,
        reason: String(item.snapshot.reason || ''),
        files: Object.keys(item.snapshot.files || {}).length,
        bytes: Number((item.snapshot.stats && item.snapshot.stats.bytes) || 0),
        seq: Number(item.payload.seq) || 0,
        prevManifest: item.payload.prevManifest || null,
      })),
      problems,
    }
    if (json) return { code: problems.length ? 2 : 0, payload }
    console.log(`仓库      : ${dir}`)
    if (problems.length) {
      console.log(`坏清单    : ${problems.length} 个`)
      for (const item of problems.slice(0, 20)) console.log(`  ! ${shortName(item.name)}: ${item.error}`)
    }
    if (!payload.snapshots.length) {
      console.log('（仓库里没有可解开的快照清单）')
      return { code: problems.length ? 2 : 0 }
    }
    console.log('')
    for (const snap of payload.snapshots) {
      console.log(`${String(snap.seq).padStart(4)}  ${snap.snapshotId.padEnd(30)} ` +
        `${String(snap.files).padStart(5)} files ${formatBytes(snap.bytes).padStart(9)}  ${isoText(snap.at)}`)
    }
    return { code: problems.length ? 2 : 0 }
  } finally {
    repo.close()
  }
}

async function cmdVerify({ args, json }) {
  const { repo, dir } = await openRepo(args)
  try {
    const { manifests, problems: manifestProblems } = await readAllManifests(repo)
    const chainProblems = await checkChain(repo, manifests)
    const targets = args.all ? manifests : [pickTarget(manifests, args)].filter(Boolean)
    if (!targets.length && !manifestProblems.length) {
      throw cliError('no-snapshot', '仓库里没有可校验的快照')
    }
    const results = []
    for (const item of targets) {
      results.push(await verifyManifest(repo, item.name, item.snapshot, { fast: Boolean(args.fast) }))
    }
    const ok = results.every((item) => item.ok) && manifestProblems.length === 0
    const payload = {
      ok,
      repoDir: dir,
      chain: { ok: chainProblems.filter((item) => !item.tolerated).length === 0, problems: chainProblems },
      snapshots: results,
      manifestProblems,
    }
    if (json) return { code: ok ? 0 : 2, payload }
    console.log(`仓库      : ${dir}`)
    console.log(`清单      : ${manifests.length} 份${manifestProblems.length ? `（${manifestProblems.length} 份解不开）` : ''}`)
    const hardChain = chainProblems.filter((item) => !item.tolerated)
    console.log(`哈希链    : ${hardChain.length === 0 ? '完整' : `异常 ${hardChain.length} 处`}` +
      (chainProblems.length > hardChain.length ? `（另有 ${chainProblems.length - hardChain.length} 处因保留策略修剪的断档，仅提示）` : ''))
    for (const problem of chainProblems.slice(0, 10)) {
      console.log(`  ${problem.tolerated ? '·' : '!'} seq=${problem.seq}: ${problem.problem}`)
    }
    for (const item of results) {
      console.log('')
      console.log(`快照      : ${item.snapshotId}（${shortName(item.manifestName)}）`)
      console.log(`  文件/块 : ${item.files} / ${item.chunks}，${formatBytes(item.bytes)}`)
      if (item.missingNames.length) {
        console.log(`  缺块    : ${item.missingNames.length} 个`)
        for (const name of item.missingNames.slice(0, 20)) console.log(`    - ${name}`)
      }
      if (item.corrupt.length) {
        console.log(`  损坏    : ${item.corrupt.length} 个`)
        for (const bad of item.corrupt.slice(0, 20)) console.log(`    - ${bad.name}: ${bad.reason}`)
      }
      console.log(`  结论    : ${item.ok ? 'PASS' : 'FAIL'}`)
    }
    return { code: ok ? 0 : 2 }
  } finally {
    repo.close()
  }
}

async function cmdRestore({ args, json }) {
  if (typeof args.home !== 'string' || !args.home) {
    throw cliError('bad-args', '缺少 --home <恢复目标目录>')
  }
  const home = path.resolve(args.home)
  const { repo, dir } = await openRepo(args)
  const startedAt = Date.now()
  try {
    // 1) 目标选择 + 完整校验（缺一块就整体拒绝）
    const { manifests, problems: manifestProblems } = await readAllManifests(repo)
    const target = pickTarget(manifests, args)
    if (!target) {
      throw cliError('no-snapshot', `找不到要恢复的快照${args.snapshot ? `：${String(args.snapshot)}` : ''}`)
    }
    const checked = await verifyManifest(repo, target.name, target.snapshot)
    if (!checked.ok) {
      const lines = [
        `快照 ${checked.snapshotId} 校验失败，拒绝恢复（不做部分恢复）：`,
        `  缺块 ${checked.missingChunks.length} 个，损坏 ${checked.corrupt.length} 个`,
        ...checked.missingNames.slice(0, 20).map((name) => `  - 缺 ${name}`),
        ...checked.corrupt.slice(0, 20).map((bad) => `  - 坏 ${bad.name}：${bad.reason}`),
      ]
      if (json) {
        return { code: 2, payload: { ok: false, error: { code: 'verify-failed', message: lines.join('\n') }, snapshotId: checked.snapshotId } }
      }
      for (const line of lines) console.log(line)
      return { code: 2 }
    }

    // 2) 目标目录安全检查
    const repoAbs = path.resolve(dir)
    const isInside = (child, parent) => {
      const rel = path.relative(parent, child)
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
    }
    if (home === repoAbs || isInside(home, repoAbs) || isInside(repoAbs, home)) {
      throw cliError('unsafe-target', `拒绝恢复到该目录：${home}（不能与仓库目录 ${repoAbs} 互相包含）`)
    }
    let exists = false
    let entries = []
    try {
      const stat = await fsp.stat(home)
      exists = true
      if (!stat.isDirectory()) throw cliError('bad-target', `--home 不是目录：${home}`)
      entries = await fsp.readdir(home)
    } catch (error) {
      if (error && error.code === 'ENOENT') { exists = false; entries = [] }
      else throw error
    }
    const nonEmpty = entries.length > 0
    if (nonEmpty && !args.force) {
      throw cliError('target-not-empty',
        `目标目录非空（${entries.length} 项），恢复会覆盖同名文件。确认后加 --force（被覆盖文件会先备份到 recovery-quarantine）`)
    }
    if (!json && !args.yes) {
      if (!process.stdin.isTTY) throw cliError('need-confirm', '非交互环境请加 --yes 确认恢复')
      console.log(`即将把快照 ${checked.snapshotId}（${checked.files} 个文件，${formatBytes(checked.bytes)}）恢复到：${home}`)
      console.log(`目标目录${nonEmpty ? '非空：会被覆盖的文件先备份到 recovery-quarantine' : '为空'}；清单里没有的文件不会被删除。`)
      console.log('请先完全退出 DeepSeek Harness，恢复完成后再启动。')
      if (!(await confirm('确认恢复？'))) {
        console.log('已取消')
        return { code: 1 }
      }
    }

    // 3) 写回（原子写 + quarantine）
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
    const quarantineDir = path.join(path.dirname(repoAbs), 'recovery-quarantine', stamp)
    let restored = 0
    let unchanged = 0
    let quarantined = 0
    const failed = []
    const files = target.snapshot.files || {}
    for (const rel of Object.keys(files).sort()) {
      const entry = files[rel]
      const abs = joinInside(home, rel)
      if (!abs) { failed.push({ rel, reason: '非法路径（越界）' }); continue }
      let existing = null
      try { existing = await fsp.lstat(abs) } catch { existing = null }
      if (existing && existing.isDirectory()) {
        failed.push({ rel, reason: '目标路径是目录，无法覆盖' })
        continue
      }
      let buf
      try {
        const parts = []
        for (const hash of entryChunks(entry)) parts.push(await repo.getChunk(hash))
        buf = Buffer.concat(parts)
      } catch (error) {
        failed.push({ rel, reason: `读取/解密块失败：${String((error && error.message) || error)}` })
        continue
      }
      if (buf.length !== Number(entry.s)) {
        failed.push({ rel, reason: `内容长度 ${buf.length} 与清单 ${Number(entry.s)} 不符` })
        continue
      }
      let current = null
      if (existing && existing.isFile()) {
        try { current = await fsp.readFile(abs) } catch { current = null }
        if (current && current.length === buf.length && sha256hex(current) === sha256hex(buf)) {
          unchanged += 1
          continue
        }
      }
      if (current) {
        const targetPath = joinInside(quarantineDir, rel)
        if (!targetPath) { failed.push({ rel, reason: 'quarantine 路径越界' }); continue }
        try {
          await writeFileAtomic(targetPath, current)
          quarantined += 1
        } catch (error) {
          failed.push({ rel, reason: `写 quarantine 失败：${String((error && error.message) || error)}` })
          continue
        }
      }
      try {
        await writeFileAtomic(abs, buf)
        restored += 1
      } catch (error) {
        failed.push({ rel, reason: `写文件失败：${String((error && error.message) || error)}` })
      }
    }

    // 4) 清单里没有、目标里多出来的文件：保留不删，只统计
    let extraLeft = 0
    try {
      const walked = await walkFiles(home, { excludes: ['dsh-runtimes'] })
      const known = new Set(Object.keys(files))
      extraLeft = walked.files.filter((file) => !known.has(file.rel)).length
    } catch { extraLeft = -1 }

    const report = {
      ok: failed.length === 0,
      snapshotId: checked.snapshotId,
      manifestName: checked.manifestName,
      target: home,
      restored,
      unchanged,
      quarantined,
      extraLeft,
      failed,
      quarantineDir,
      needRestart: true,
      durationMs: Date.now() - startedAt,
    }
    // 审计报告：始终写一份到 quarantine 目录（不写 repo 内部）
    try {
      await writeFileAtomic(path.join(quarantineDir, '_recovery-report.json'), Buffer.from(JSON.stringify({
        at: Date.now(), ...report, source: 'recovery-kit',
      }, null, 2) + '\n', 'utf8'))
    } catch { /* 报告写失败不影响恢复结果 */ }

    if (json) return { code: failed.length ? 3 : 0, payload: report }
    console.log('')
    console.log(`恢复快照 : ${report.snapshotId}`)
    console.log(`目标目录 : ${home}`)
    console.log(`写回 ${restored} 个文件，未变 ${unchanged}，覆盖前已备份 ${quarantined} 个`)
    if (quarantined || restored) console.log(`quarantine：${quarantineDir}`)
    if (extraLeft > 0) console.log(`目标里清单没有的文件：${extraLeft} 个（保留未动）`)
    if (failed.length) {
      console.log(`失败 ${failed.length} 项：`)
      for (const item of failed.slice(0, 20)) console.log(`  - ${item.rel}: ${item.reason}`)
    }
    console.log(`结果     : ${failed.length ? 'FAIL' : 'PASS'}（耗时 ${report.durationMs} ms）`)
    console.log('请完全退出并重新启动 DeepSeek Harness。')
    return { code: failed.length ? 3 : 0 }
  } finally {
    repo.close()
  }
}

/* -------------------------------------------------------------------- main */

const COMMANDS = { list: cmdList, verify: cmdVerify, restore: cmdRestore }

async function main(argv) {
  const args = parseArgs(argv)
  const command = args._[0] || (args.help ? 'help' : '')
  if (args.help || command === 'help' || command === '--help') {
    process.stdout.write(USAGE)
    return 0
  }
  const handler = COMMANDS[command]
  if (!handler) {
    log(`未知命令：${command || '（空）'}`)
    process.stderr.write(USAGE)
    return 1
  }
  const json = Boolean(args.json)
  try {
    const result = await handler({ args, json })
    if (json && result && result.payload) {
      process.stdout.write(JSON.stringify(result.payload, null, 2) + '\n')
    }
    return result && Number.isInteger(result.code) ? result.code : 0
  } catch (error) {
    const code = error && error.code ? String(error.code) : 'error'
    const message = String((error && error.message) || error)
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, error: { code, message } }, null, 2) + '\n')
    } else {
      log(`失败：[${code}] ${message}`)
      if (args.debug && error && error.stack) process.stderr.write(error.stack + '\n')
    }
    return exitCodeFor(error)
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code
}).catch((error) => {
  log(`失败：${String((error && error.message) || error)}`)
  process.exitCode = 1
})
