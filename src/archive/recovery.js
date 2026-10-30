/**
 * recovery-kit：把「离线恢复工具」写进 <repo>/recovery-kit/（设计文档 §2/§4）。
 *
 * 目的：本机 DSH、插件、甚至 Node 项目目录全丢时，只要 Submachine / 离线盘上还有整个
 * 仓库目录（其中自带 recovery-kit），就能用系统里任意 Node ≥20 直接：
 *
 *   node recovery-kit/recover.mjs list    --dir <repo>
 *   node recovery-kit/recover.mjs verify  --dir <repo>
 *   node recovery-kit/recover.mjs restore --dir <repo> --home <目标目录> --yes
 *
 * kit 布局（保持与源码相同的相对 import 结构，所以不需要改任何 import）：
 *   recovery-kit/
 *     recover.mjs
 *     dpapi.ps1
 *     src/archive/format.js
 *     src/archive/repo.js
 *     src/archive/dpapi.js
 *     src/util.js
 *     README.txt
 *     kit.json            # {version, format, files:{相对路径: sha256}}，可核对 kit 没被改过
 *
 * 约定：
 *   - kit 里**没有任何密钥/密码**；repo.json 公开头 + 密文照旧；
 *   - 幂等：内容没变就不重写（逐文件 sha256 比较 + 原子写）；
 *   - 仓库 name 白名单已允许 recovery-kit/[A-Za-z0-9._/-]{1,120}，所以这些文件也能同步到子机。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { repoError } from './format.js'
import { sha256hex, writeFileAtomic } from '../util.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 插件根目录（src/archive → ../..）。 */
const PKG_ROOT = path.resolve(HERE, '..', '..')

export const RECOVERY_KIT_VERSION = 1
export const RECOVERY_KIT_FORMAT = 'dsh-dr-recovery-kit'
export const RECOVERY_KIT_DIRNAME = 'recovery-kit'

/** kit 需要复制的文件：{ from: 源绝对路径, to: kit 内相对路径, mode: 'text'|'binary' } */
export function recoveryKitSources() {
  return [
    { from: path.join(PKG_ROOT, 'scripts', 'recover.mjs'), to: 'recover.mjs' },
    { from: path.join(PKG_ROOT, 'scripts', 'dpapi.ps1'), to: 'dpapi.ps1' },
    { from: path.join(HERE, 'format.js'), to: 'src/archive/format.js' },
    { from: path.join(HERE, 'repo.js'), to: 'src/archive/repo.js' },
    // repo.js 依赖 recovery.js（init 时写 kit），所以它也要进 kit，否则 kit 里的 repo.js 加载失败
    { from: path.join(HERE, 'recovery.js'), to: 'src/archive/recovery.js' },
    { from: path.join(HERE, 'dpapi.js'), to: 'src/archive/dpapi.js' },
    { from: path.join(PKG_ROOT, 'src', 'util.js'), to: 'src/util.js' },
  ]
}

function buildReadme({ repoExample = '<仓库目录>' } = {}) {
  return `dsh-disaster-recovery · 离线恢复工具（recovery-kit v${RECOVERY_KIT_VERSION}）

这个目录是「异地加密副本」的应急恢复工具，由插件导出时自动写入。
它不含任何密钥或密码；仓库本身（repo.json + chunks/ + manifests/）才是数据，
本目录只是「怎么解密」的那部分代码。

一、运行条件
  - 任意安装了 Node.js ≥ 20 的机器（Windows/macOS/Linux 均可；--dpapi 仅 Windows）；
  - 仓库目录（含 repo.json）必须在手边（子机目录、离线盘、或拷回来的整个目录）；
  - 你必须记得恢复密码。密码丢失 = 数据不可读，没有任何后门。

二、先看清有什么、再校验
  # 在仓库目录的上一级运行（recover.mjs 与 repo 同级也可以，用 --dir 指过去）
  node recovery-kit/recover.mjs list   --dir ${repoExample} --password-stdin
  node recovery-kit/recover.mjs verify --dir ${repoExample} --password-stdin

  verify 会逐块解密并校验 sha256；缺块/损坏会列出具体文件名。
  有缺块时恢复会被整体拒绝（不会只恢复一半）。退出码：0 通过 / 2 校验失败。

三、恢复（务必先完全退出 DSH）
  # 目标目录为空：
  node recovery-kit/recover.mjs restore --dir ${repoExample} --home D:\\恢复目标 --password-stdin --yes

  # 目标目录非空：加 --force；会被覆盖的文件先备份到
  #   ${repoExample}/../recovery-quarantine/<时间戳>/
  node recovery-kit/recover.mjs restore --dir ${repoExample} --home C:\\Users\\你\\.dsh --force --yes

  恢复完成后启动 DSH。清单里没有、目标里多出来的文件不会被删除（只统计并保留）。

四、密码怎么给（不写进命令行、不落盘）
  --password-stdin        从 stdin 第一行读（推荐：echo '密码' | node ...）
  --password-env NAME     从环境变量读
  --dpapi                 读 DPAPI 缓存（<repo>/../key.dpapi，仅 Windows 同一用户/同一台机器有效）
  密码规则：至少 9 位且同时包含字母和数字。换机/重装系统后 DPAPI 缓存必然失效，只能用密码。

五、怎么确认仓库没被动过
  - 所有文件名是 keyed HMAC（不可反推路径），内容是 AES-256-GCM 密文；
  - 清单里记录了每个块的 sha256 与文件大小，verify 会逐块比对；
  - 清单带 prevManifest/seq 哈希链，verify 会提示断链（保留策略可能让旧清单被修剪，仅提示）；
  - kit.json 记录本目录每个文件的 sha256，可用于核对工具本身没被篡改。

六、退出码
  0 成功 / 1 用法或一般错误 / 2 校验失败或缺块 / 3 恢复时有文件写失败 / 4 密码或 DPAPI 问题

七、别忘了 3-2-1
  异地副本文本是为了防整机损坏/误删/勒索软件；建议再保留一份离线盘副本。
`
}

async function fileDigest(abs) {
  try {
    const buf = await fsp.readFile(abs)
    return { sha256: sha256hex(buf), size: buf.length }
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

/** 写文件但内容相同就不动（避免每次导出都改 mtime）。 */
async function writeIfChanged(abs, data) {
  const next = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  const current = await fileDigest(abs)
  if (current && current.sha256 === sha256hex(next)) return false
  await writeFileAtomic(abs, next)
  return true
}

function kitDirOf(repoOrDir) {
  if (typeof repoOrDir === 'string') return path.resolve(repoOrDir)
  if (repoOrDir && typeof repoOrDir.dir === 'string') return path.resolve(repoOrDir.dir)
  throw repoError('bad-args', '缺少仓库目录（LocalRepo 实例或 dir 字符串）')
}

/**
 * 写入/刷新 recovery-kit（幂等）。首次导出（或初始化仓库）时调用即可。
 *
 * @param {object|string} repo LocalRepo 实例或仓库目录
 * @param {object} [options]
 * @param {boolean} [options.force=false] 即使内容相同也重写
 * @returns {Promise<{dir:string, version:number, written:string[], files:Array<{path:string, sha256:string, size:number}>}>}
 */
export async function ensureRecoveryKit(repo, { force = false } = {}) {
  const repoDir = kitDirOf(repo)
  const kitDir = path.join(repoDir, RECOVERY_KIT_DIRNAME)
  const written = []
  const files = []

  for (const source of recoveryKitSources()) {
    let data
    try {
      data = await fsp.readFile(source.from)
    } catch (error) {
      throw repoError('kit-source-missing', `恢复工具源文件缺失：${source.from}（${String((error && error.message) || error)}）`)
    }
    const dest = path.join(kitDir, ...source.to.split('/'))
    const changed = force ? (await writeFileAtomic(dest, data), true) : await writeIfChanged(dest, data)
    if (changed) written.push(source.to)
    files.push({ path: source.to, sha256: sha256hex(data), size: data.length })
  }

  const readme = buildReadme({ repoExample: '<仓库目录>' })
  const readmeChanged = force
    ? (await writeFileAtomic(path.join(kitDir, 'README.txt'), Buffer.from(readme, 'utf8')), true)
    : await writeIfChanged(path.join(kitDir, 'README.txt'), readme)
  if (readmeChanged) written.push('README.txt')

  // kit.json 不含时间戳，内容稳定：可用于核对工具文件是否被改过
  const manifest = {
    format: RECOVERY_KIT_FORMAT,
    version: RECOVERY_KIT_VERSION,
    repoFormat: 'dsh-dr-repo',
    repoVersion: 1,
    entry: 'recover.mjs',
    files: Object.fromEntries(files.map((file) => [file.path, file.sha256])),
  }
  const kitJson = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  const kitJsonChanged = force
    ? (await writeFileAtomic(path.join(kitDir, 'kit.json'), kitJson), true)
    : await writeIfChanged(path.join(kitDir, 'kit.json'), kitJson)
  if (kitJsonChanged) written.push('kit.json')

  return { dir: kitDir, version: RECOVERY_KIT_VERSION, written, files }
}

/**
 * 只读检查 kit 是否齐全/是否与当前插件代码一致（面板可用它显示「恢复工具缺失，请点修复」）。
 *
 * 判定：
 *   present —— recovery-kit/recover.mjs 是否存在（kit 到底有没有）
 *   ok      —— 所有文件都在、且内容与当前源码逐字节一致
 *   missing —— 缺失的文件（含 README.txt / kit.json）
 *   stale   —— 与当前源码不一致的文件（插件升级后会出现，kit 命令可修复）
 * @returns {Promise<{present:boolean, ok:boolean, dir:string, version:number|null,
 *   missing:string[], stale:string[]}>}
 */
export async function recoveryKitStatus(repoOrDir) {
  const repoDir = kitDirOf(repoOrDir)
  const kitDir = path.join(repoDir, RECOVERY_KIT_DIRNAME)
  const expected = await Promise.all(recoveryKitSources().map(async (source) => {
    let data = null
    try { data = await fsp.readFile(source.from) } catch { data = null }
    return { to: source.to, sha256: data ? sha256hex(data) : null }
  }))
  const missing = []
  const stale = []
  for (const item of expected) {
    const current = await fileDigest(path.join(kitDir, ...item.to.split('/')))
    if (!current) { missing.push(item.to); continue }
    if (item.sha256 && current.sha256 !== item.sha256) stale.push(item.to)
  }
  for (const extra of ['README.txt', 'kit.json']) {
    if (!(await fileDigest(path.join(kitDir, extra)))) missing.push(extra)
  }
  const present = Boolean(await fileDigest(path.join(kitDir, 'recover.mjs')))
  let version = null
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(kitDir, 'kit.json'), 'utf8'))
    if (parsed && parsed.format === RECOVERY_KIT_FORMAT) version = Number(parsed.version) || RECOVERY_KIT_VERSION
  } catch { version = null }
  return {
    present,
    ok: present && missing.length === 0 && stale.length === 0,
    dir: kitDir,
    version,
    missing,
    stale,
  }
}
