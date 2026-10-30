#!/usr/bin/env node
/**
 * 「Deepseek恢复」外部一键恢复控制台（docs/CRASH-MONITORING.md §7）。
 *
 * 极端场景：`.dsh` 整个被删 / DSH 起不来 / 插件面板打不开时，
 * 双击桌面快捷方式（→ recovery-console.ps1 → 本文件）就能：
 *   1. 确认 DSH 进程已退出；
 *   2. 找到备份库（config / D:\dsh-backup），列出快照；
 *   3. 选推荐恢复点：监控事故的 recommendation → 否则最新一份校验通过（缺块=0）的快照；
 *   4. 显示恢复计划，要求输入 YES；
 *   5. 调用自包含副本 plugin\scripts\cli.mjs restore <id> --home <home> --yes；
 *   6. 重建 profiles\<p>\node_modules 下 link: 依赖的 junction；
 *   7. 写 <storeRoot>\manual\<ts>-external-restore\report.json + console.log；
 *   8. 默认启动 D:\DeepSeek\DeepSeek Harness.exe（--no-start 可关）。
 * 本地备份库不可用/缺块时：提示输入子机仓库目录（U 盘/UNC），
 * 用其 recovery-kit/recover.mjs 恢复后再修 junction。
 *
 * 零第三方依赖；Node >= 20；不 import 本插件以外的任何包。
 *
 * 用法：
 *   node console.mjs [--home <dir>] [--store <dir>] [--host <name>] [--snapshot <id>]
 *                    [--yes] [--auto] [--force] [--dry-run] [--list] [--verify]
 *                    [--no-start] [--repo <dir>] [--plugin <dir|cli.mjs>] [--config <file>]
 *                    [--password-env NAME] [--dpapi] [--dpapi-file <file>] [--exe <path>]
 *
 * 退出码：0 成功 / 1 用法、取消或环境不允许 / 2 校验失败或备份库不可用 / 3 恢复部分失败
 *
 * 安全底线：
 *   - 恢复只按清单写文件，绝不删除目标里「清单没有」的文件；
 *   - 被覆盖的旧文件由 CLI / recovery-kit 放进 quarantine；
 *   - 删 junction 只用 `cmd /c rmdir`（只摘 reparse point），绝不递归删目标；
 *   - 所有路径运算都不接受 `..` 越界；不碰真实 .dsh 以外的用户数据。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CONSOLE_FILE = fileURLToPath(import.meta.url)
const CONSOLE_DIR = path.dirname(CONSOLE_FILE)

/** 报告 / 报告目录格式版本（便于以后脚本消费）。 */
export const REPORT_VERSION = 1
export const CONSOLE_VERSION = 1
export const DEFAULT_STORE_ROOT = 'D:\\dsh-backup'
export const DEFAULT_DSH_EXE = 'D:\\DeepSeek\\DeepSeek Harness.exe'
export const RECOVERY_HOME_DIRNAME = 'DeepSeek Recovery'
export const SNAPSHOT_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,120}$/
export const SNAPSHOT_LIST_LIMIT = 10
export const RECOVERY_KIT_DIRNAME = 'recovery-kit'

const USAGE = `用法：node console.mjs [选项]

通用：
  --home <dir>         DSH 数据目录（默认 $DSH_HOME 或 %USERPROFILE%\\.dsh）
  --store <dir>        备份库根目录（默认读 monitor\\config.json 的 storeRoot，再退 D:\\dsh-backup）
  --host <name>        多主机备份目录时直接指定（如 LAPTOP-XXXX）
  --snapshot <id>      指定快照 id（默认按推荐点自动选）
  --config <file>      监控配置文件（默认 <RECOVERY_HOME>\\monitor\\config.json）
  --plugin <dir|file>  自包含灾备 CLI 目录（含 scripts/cli.mjs）或直接给 cli.mjs 路径
  --exe <path>         恢复后启动的 DeepSeek Harness.exe（默认 ${DEFAULT_DSH_EXE}）

流程：
  --yes                跳过输入 YES（--auto 仍需 YES，除非同时给 --yes）
  --auto               非交互：自动选推荐点/host（仍要求 YES 防误触，除非 --yes）
  --force              DSH 进程在运行时，经明确确认后继续（默认拒绝）
  --no-start           恢复成功后不启动 DSH
  --dry-run            只校验 + 打印计划 + junction 计划，不做任何修改
  --list               只列备份库/快照/推荐点
  --verify             只校验快照完整性（缺块/坏清单）

从子机仓库恢复（本地备份库不可用时）：
  --repo <dir>         子机仓库目录（U 盘/UNC，含 repo.json 与 recovery-kit\\）
  --password-env NAME  密码从环境变量读（转发给 recovery-kit）
  --dpapi             用 DPAPI 缓存密码（仅 Windows，同用户同机）
  --dpapi-file <file>  DPAPI 缓存文件路径

退出码：0 成功 / 1 用法·取消·环境不允许 / 2 校验失败·备份库不可用 / 3 恢复部分失败
`

/* ═══════════════════════════════════════════════════════ 基础工具 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 与 engine.sanitizeHostTag 保持一致（这里不 import 插件 src，保证独立可用）。 */
export function sanitizeHostTag(name) {
  return String(name || 'host').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'host'
}

/** 当前主机在备份库里对应的目录名。 */
export function currentHostTag() {
  return sanitizeHostTag(os.hostname())
}

export function isMainModule(metaUrl = import.meta.url) {
  try {
    return path.resolve(fileURLToPath(metaUrl)) === path.resolve(process.argv[1] || '')
  } catch {
    return false
  }
}

/** 参数解析：--key value / --key=value / 位置参数进 `_`。 */
export function parseArgs(argv = []) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i])
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq > 2) { out[arg.slice(2, eq)] = arg.slice(eq + 1); continue }
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next === undefined || String(next).startsWith('--')) out[key] = true
      else { out[key] = String(next); i += 1 }
    } else {
      out._.push(arg)
    }
  }
  return out
}

/** 从 root 拼相对路径；越界/绝对路径返回 null（与 src/util.js joinInside 同口径）。 */
export function joinInside(root, rel) {
  const raw = String(rel == null ? '' : rel).replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('//')) return null
  const parts = raw.split('/').filter((p) => p && p !== '.')
  if (!parts.length || parts.some((p) => p === '..')) return null
  const abs = path.resolve(root, ...parts)
  const base = path.resolve(root)
  return abs === base || abs.startsWith(base.endsWith(path.sep) ? base : base + path.sep) ? abs : null
}

/** 路径 a 是否等于/位于 b 内（大小写不敏感，Windows 语义）。 */
export function isInsidePath(parent, child) {
  const p = path.resolve(String(parent || ''))
  const c = path.resolve(String(child || ''))
  if (p.toLowerCase() === c.toLowerCase()) return true
  return c.toLowerCase().startsWith(p.toLowerCase().endsWith(path.sep) ? p.toLowerCase() : p.toLowerCase() + path.sep)
}

/** 原子写文件（与本仓库 util 相同套路，避免半截文件）。 */
export async function writeFileAtomic(abs, data) {
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.${process.pid}.${Date.now().toString(36)}.tmp`
  await fsp.writeFile(tmp, data)
  for (let attempt = 0; ; attempt += 1) {
    try { await fsp.rename(tmp, abs); return } catch (error) {
      const transient = error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY')
      if (!transient || attempt >= 7) {
        try { await fsp.rm(tmp, { force: true }) } catch { /* ignore */ }
        throw error
      }
      await sleep(Math.min(200, 20 * 2 ** attempt))
    }
  }
}

export async function exists(p) {
  try { await fsp.access(p); return true } catch { return false }
}

async function readJsonFile(file, fallback = null) {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    return JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

/** 本地时间戳：20261028-153210（快照 id 同款，字典序=时间序）。 */
export function localStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function formatWhen(ms) {
  const n = Number(ms) || 0
  if (!n) return '—'
  const d = new Date(n)
  const pad = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1 }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}

/** 清单条目的内容块：新格式 `{s,m,c:[hash…]}`，老格式 `{s,m,h}`。 */
export function entryChunks(entry) {
  if (!entry) return []
  if (Array.isArray(entry.c)) return entry.c
  if (typeof entry.h === 'string' && entry.h) return [entry.h]
  return []
}

function tail(text, limit = 4000) {
  const value = String(text == null ? '' : text)
  return value.length > limit ? value.slice(value.length - limit) : value
}

/* ═════════════════════════════════════════════ 目录/配置/host 定位 */

/** RECOVERY_HOME：env → 安装布局（console 在 scripts\ 下取上级）→ %LOCALAPPDATA%。 */
export function resolveRecoveryHome({ args = {}, env = process.env, consoleDir = CONSOLE_DIR } = {}) {
  if (typeof args.recovery === 'string' && args.recovery.trim()) return path.resolve(args.recovery.trim())
  if (typeof args['recovery-home'] === 'string' && args['recovery-home'].trim()) {
    return path.resolve(args['recovery-home'].trim())
  }
  const envHome = env.DSH_RECOVERY_HOME || env.RECOVERY_HOME
  if (typeof envHome === 'string' && envHome.trim()) return path.resolve(envHome.trim())
  const parent = path.dirname(path.resolve(consoleDir))
  const looksInstalled = path.basename(consoleDir).toLowerCase() === 'scripts'
    && (fs.existsSync(path.join(parent, 'monitor'))
      || fs.existsSync(path.join(parent, 'plugin'))
      || fs.existsSync(path.join(parent, 'version.json')))
  if (looksInstalled) return parent
  if (fs.existsSync(path.join(parent, 'monitor')) || fs.existsSync(path.join(parent, 'plugin'))) return parent
  if (env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, RECOVERY_HOME_DIRNAME)
  return parent
}

export function resolveConfigPath({ args = {}, env = process.env, recoveryHome }) {
  if (typeof args.config === 'string' && args.config.trim()) return path.resolve(args.config.trim())
  if (typeof env.DSH_RECOVERY_CONFIG === 'string' && env.DSH_RECOVERY_CONFIG.trim()) {
    return path.resolve(env.DSH_RECOVERY_CONFIG.trim())
  }
  return path.join(recoveryHome, 'monitor', 'config.json')
}

export async function readMonitorConfig(configPath) {
  const parsed = await readJsonFile(configPath, null)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

export function resolveHome({ args = {}, env = process.env } = {}) {
  if (typeof args.home === 'string' && args.home.trim()) return path.resolve(args.home.trim())
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/** store 根：--store/--root → env → monitor/config.json（storeRoot/root）→ D:\dsh-backup。 */
export function resolveStoreRoot({ args = {}, env = process.env, config = null, defaultRoot = DEFAULT_STORE_ROOT } = {}) {
  if (typeof args.store === 'string' && args.store.trim()) return path.resolve(args.store.trim())
  if (typeof args.root === 'string' && args.root.trim()) return path.resolve(args.root.trim())
  const fromEnv = env.DSH_RECOVERY_STORE || env.DSH_BACKUP_ROOT
  if (typeof fromEnv === 'string' && fromEnv.trim()) return path.resolve(fromEnv.trim())
  const value = config && typeof config === 'object' ? (config.storeRoot || config.root) : null
  if (typeof value === 'string' && value.trim()) return path.resolve(value.trim())
  return path.resolve(defaultRoot)
}

/** 备份库里所有「主机目录」（<root>\<host>\snapshots\*.json）。 */
export async function findHostStores(storeRoot) {
  let entries = []
  try { entries = await fsp.readdir(storeRoot, { withFileTypes: true }) } catch { return [] }
  const stores = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'manual' || entry.name === 'offsite') continue
    const dir = path.join(storeRoot, entry.name)
    if (!(await exists(path.join(dir, 'snapshots')))) continue
    const ids = await listSnapshotIds(dir)
    let latest = null
    if (ids.length) latest = await summarizeSnapshot(dir, ids[0])
    stores.push({
      name: entry.name,
      dir,
      snapshotCount: ids.length,
      latestId: latest ? latest.id : null,
      latestAt: latest ? latest.at : 0,
      home: latest ? latest.home : null,
      currentHost: entry.name === currentHostTag(),
    })
  }
  stores.sort((a, b) => (Number(b.currentHost) - Number(a.currentHost)) || (b.latestAt - a.latestAt))
  return stores
}

/** 选择 host 目录；多个时列出让用户选（--auto 自动选当前主机/最新）。 */
export async function pickHostStore(ctx, stores) {
  if (!stores.length) return null
  if (stores.length === 1) return stores[0]
  if (typeof ctx.args.host === 'string' && ctx.args.host.trim()) {
    const wanted = ctx.args.host.trim().toLowerCase()
    const found = stores.find((store) => store.name.toLowerCase() === wanted)
    if (found) return found
    ctx.logErr(`找不到 host 目录：${ctx.args.host}（可用：${stores.map((s) => s.name).join(', ')}）`)
    return null
  }
  const preferred = stores.find((store) => store.currentHost) || stores[0]
  if (ctx.args.auto || ctx.args.yes || !ctx.D.interactive) {
    ctx.log(`检测到 ${stores.length} 个主机备份目录，自动选择：${preferred.name}` +
      (preferred.currentHost ? '（当前主机）' : ''))
    return preferred
  }
  ctx.log('检测到多个主机备份目录：')
  stores.forEach((store, index) => {
    ctx.log(`  [${index + 1}] ${store.name}${store.currentHost ? '（当前主机）' : ''}  ` +
      `${store.snapshotCount} 快照  最近 ${formatWhen(store.latestAt)}  home=${store.home || '—'}`)
  })
  const answer = (await ctx.D.ask(`选择主机目录编号 [默认 ${stores.indexOf(preferred) + 1}]：`)).trim()
  if (!answer) return preferred
  const index = Number(answer)
  if (Number.isInteger(index) && index >= 1 && index <= stores.length) return stores[index - 1]
  ctx.logErr('编号无效，使用默认推荐。')
  return preferred
}

/* ═══════════════════════════════════════════════════════ 快照读取 */

export async function listSnapshotIds(hostDir) {
  let names = []
  try { names = await fsp.readdir(path.join(hostDir, 'snapshots')) } catch { return [] }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5))
    .filter((id) => SNAPSHOT_ID_PATTERN.test(id))
    .sort()
    .reverse()
}

export async function loadManifest(hostDir, id) {
  const value = String(id || '')
  if (!SNAPSHOT_ID_PATTERN.test(value)) throw new Error(`快照 id 不合法：${value}`)
  const file = path.join(hostDir, 'snapshots', `${value}.json`)
  let raw
  try { raw = await fsp.readFile(file, 'utf8') } catch {
    throw new Error(`快照不存在或不可读：${value}`)
  }
  let manifest
  try { manifest = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch {
    throw new Error(`快照清单损坏（JSON 解析失败）：${value}`)
  }
  if (!manifest || manifest.id !== value || typeof manifest.files !== 'object' || !manifest.files) {
    throw new Error(`快照清单损坏（id/文件表不对）：${value}`)
  }
  return manifest
}

export function summarizeManifest(manifest) {
  const files = manifest && manifest.files ? manifest.files : {}
  const count = Object.keys(files).length
  return {
    id: String((manifest && manifest.id) || ''),
    at: Number(manifest && manifest.at) || 0,
    reason: String((manifest && manifest.reason) || ''),
    files: Number(manifest && manifest.stats && manifest.stats.files) || count,
    bytes: Number(manifest && manifest.stats && manifest.stats.bytes) || 0,
    changed: Number(manifest && manifest.stats && manifest.stats.changed) || 0,
    home: String((manifest && manifest.home) || ''),
  }
}

export async function summarizeSnapshot(hostDir, id) {
  try {
    return summarizeManifest(await loadManifest(hostDir, id))
  } catch {
    return null
  }
}

/** 最近 N 份快照摘要 + 总数（不解析全部清单，避免大备份库拖慢交互）。 */
export async function readSnapshotSummaries(hostDir, { limit = SNAPSHOT_LIST_LIMIT } = {}) {
  const ids = await listSnapshotIds(hostDir)
  const snapshots = []
  for (const id of ids.slice(0, Math.max(0, limit))) {
    const summary = await summarizeSnapshot(hostDir, id)
    if (summary) snapshots.push(summary)
  }
  return { total: ids.length, ids, snapshots }
}

export function blobPath(hostDir, hash) {
  const h = String(hash || '')
  if (!/^[0-9a-f]{64}$/.test(h)) return null
  return path.join(hostDir, 'blobs', h.slice(0, 2), h.slice(2, 4), h)
}

/** 本地校验：清单引用的内容块是否都在（缺块=0 才算通过）。不 import 插件 src。 */
export async function verifySnapshotLocal(hostDir, id) {
  let manifest
  try {
    manifest = await loadManifest(hostDir, id)
  } catch (error) {
    return { id, at: 0, files: 0, ok: false, missingCount: -1, missing: [], error: String((error && error.message) || error) }
  }
  const missing = []
  const files = manifest.files || {}
  for (const [rel, entry] of Object.entries(files)) {
    const chunks = entryChunks(entry)
    if (!chunks.length) {
      if (Number(entry && entry.s) === 0) continue
      missing.push(rel)
      continue
    }
    let bad = false
    for (const hash of chunks) {
      const file = blobPath(hostDir, hash)
      if (!file || !(await exists(file))) { bad = true; break }
    }
    if (bad) missing.push(rel)
  }
  return {
    id: manifest.id,
    at: Number(manifest.at) || 0,
    files: Object.keys(files).length,
    ok: missing.length === 0,
    missingCount: missing.length,
    missing: missing.slice(0, 20),
    checkedAt: Date.now(),
  }
}

/** 读监控事故（<storeRoot>/<host>/monitor/incidents/*.json）。 */
export async function readIncidents(hostDir) {
  const dir = path.join(hostDir, 'monitor', 'incidents')
  let names = []
  try { names = await fsp.readdir(dir) } catch { return [] }
  const incidents = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const parsed = await readJsonFile(path.join(dir, name), null)
    if (!parsed || typeof parsed !== 'object') continue
    const rec = parsed.recommendation && typeof parsed.recommendation === 'object'
      ? {
        snapshotId: String(parsed.recommendation.snapshotId || ''),
        at: Number(parsed.recommendation.at) || 0,
        reason: String(parsed.recommendation.reason || ''),
        verified: parsed.recommendation.verified === true,
      }
      : null
    incidents.push({
      file: name,
      id: String(parsed.id || name.slice(0, -5)),
      kind: String(parsed.kind || ''),
      status: String(parsed.status || ''),
      severity: String(parsed.severity || ''),
      detectedAt: Number(parsed.detectedAt) || 0,
      firstAt: Number(parsed.firstAt) || 0,
      lastAt: Number(parsed.lastAt) || 0,
      summary: String(parsed.summary || ''),
      recommendation: rec,
    })
  }
  incidents.sort((a, b) => incidentTime(b) - incidentTime(a))
  return incidents
}

export function incidentTime(incident) {
  return Number(incident && (incident.lastAt || incident.detectedAt || incident.firstAt)) || 0
}

/**
 * 选推荐恢复点：
 *   1. 事故 recommendation（verified=true 且 快照时间 <= 事故时间，且现场校验缺块=0），取最近事故的；
 *   2. 否则最新一份 verify 缺块=0 的快照（向前探测，最多 maxProbe 份）。
 * 返回 { source:'incident'|'verified-latest'|null, snapshotId, snapshot, incident, verified, reason, probes }
 */
export async function chooseRecoveryPoint({ hostDir, snapshotIds, incidents = [], maxProbe = 40 } = {}) {
  const ids = Array.isArray(snapshotIds) ? snapshotIds : await listSnapshotIds(hostDir)
  const idSet = new Set(ids)
  const probes = []
  const candidates = incidents
    .filter((incident) => incident.recommendation && incident.recommendation.snapshotId)
    .filter((incident) => incident.recommendation.verified === true)
    .filter((incident) => Number.isFinite(incident.recommendation.at) && incident.recommendation.at > 0)
    .filter((incident) => idSet.has(incident.recommendation.snapshotId))
    .filter((incident) => incident.recommendation.at <= incidentTime(incident))
    .sort((a, b) => (incidentTime(b) - incidentTime(a)) || (b.recommendation.at - a.recommendation.at))

  for (const incident of candidates) {
    const id = incident.recommendation.snapshotId
    const verified = await verifySnapshotLocal(hostDir, id)
    probes.push({ id, ok: verified.ok, missing: verified.missingCount, from: 'incident' })
    if (!verified.ok) continue
    return {
      source: 'incident',
      snapshotId: id,
      snapshot: await summarizeSnapshot(hostDir, id),
      incident,
      verified,
      reason: `事故 ${incident.id} 的推荐点（${formatWhen(incident.recommendation.at)}，verified）`,
      probes,
    }
  }

  for (const id of ids.slice(0, Math.max(0, maxProbe))) {
    // pre-restore 是「恢复前自动拍的事故现场」，拿它当推荐点会把坏状态再盖回去
    // （与 engine.latestSnapshotId 的排除口径一致）。
    const summary = await summarizeSnapshot(hostDir, id)
    if (!summary) continue
    if (summary.reason === 'pre-restore') {
      probes.push({ id, ok: false, skipped: 'pre-restore', from: 'latest' })
      continue
    }
    const verified = await verifySnapshotLocal(hostDir, id)
    probes.push({ id, ok: verified.ok, missing: verified.missingCount, from: 'latest' })
    if (!verified.ok) continue
    return {
      source: 'verified-latest',
      snapshotId: id,
      snapshot: summary,
      incident: null,
      verified,
      reason: `最新一份校验通过（缺块=0）的快照：${formatWhen(verified.at)}`,
      probes,
    }
  }

  return {
    source: null,
    snapshotId: null,
    snapshot: null,
    incident: null,
    verified: null,
    reason: probes.length
      ? `最近 ${probes.length} 份快照都缺块，无法从本地备份库恢复`
      : '备份库里没有快照',
    probes,
  }
}

/* ═══════════════════════════════════════════════════ 恢复计划/统计 */

/** 遍历 home 的普通文件（跳过符号链接/junction、dsh-runtimes、临时文件）。 */
export async function walkHomeFiles(root, { excludes = ['dsh-runtimes'] } = {}) {
  const rootAbs = path.resolve(root)
  if (!(await exists(rootAbs))) return { exists: false, files: [] }
  const out = []
  const stack = ['']
  const skipDirs = new Set(excludes.map((value) => String(value).replace(/^\/+|\/+$/g, '').toLowerCase()))
  while (stack.length) {
    const relDir = stack.pop()
    const absDir = relDir ? path.join(rootAbs, ...relDir.split('/')) : rootAbs
    let entries
    try { entries = await fsp.readdir(absDir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name.toLowerCase())) continue
        stack.push(rel)
        continue
      }
      if (!entry.isFile()) continue
      if (/\.(lock|tmp|temp|crdownload|part)$/i.test(entry.name) || entry.name === 'Thumbs.db') continue
      out.push(rel)
    }
  }
  out.sort()
  return { exists: true, files: out }
}

/** 恢复预演：与 engine.previewRestore 同口径（size+mtime 都一致 ⇔ 未变）。 */
export async function buildPlan({ home, manifest }) {
  const files = (manifest && manifest.files) || {}
  const rels = Object.keys(files)
  let create = 0
  let changed = 0
  let unchanged = 0
  let bytes = 0
  for (const rel of rels) {
    const entry = files[rel]
    if (!entry) continue
    const abs = joinInside(home, rel)
    let stat = null
    if (abs) {
      try { stat = await fsp.stat(abs) } catch { stat = null }
    }
    if (!stat) {
      create += 1
      bytes += Number(entry.s) || 0
      continue
    }
    if (!stat.isFile()) {
      changed += 1
      bytes += Number(entry.s) || 0
      continue
    }
    if (stat.size === entry.s && Math.round(stat.mtimeMs) === entry.m) {
      unchanged += 1
      continue
    }
    changed += 1
    bytes += Number(entry.s) || 0
  }
  const current = await walkHomeFiles(home)
  const known = new Set(rels)
  const extra = current.files.filter((rel) => !known.has(rel)).length
  return {
    files: rels.length,
    create,
    changed,
    unchanged,
    extra,
    bytes,
    overwrite: changed,
    current: { exists: current.exists, files: current.files.length },
  }
}

/* ═══════════════════════════════════════════════════════ junction */

function linkNameParts(depName) {
  const parts = String(depName || '').split('/')
  if (!parts.length) return null
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.includes('\\') || part.includes(':')) return null
  }
  return parts
}

/** 归一化 junction 的目标路径：去掉 `\\?\` 前缀、统一分隔符。 */
export function normalizeLinkTarget(raw) {
  let value = String(raw == null ? '' : raw).trim()
  if (!value) return ''
  value = value.replace(/^\\\\\?\\/, '').replace(/^\\\?\?\\/, '')
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/')) return path.resolve(value.replace(/\//g, '\\'))
  return value.replace(/\//g, '\\')
}

export function samePath(a, b) {
  if (!a || !b) return false
  try {
    return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase()
  } catch {
    return false
  }
}

async function inspectLink(linkPath) {
  let stat
  try { stat = await fsp.lstat(linkPath) } catch { return { exists: false, kind: 'none', target: null } }
  if (stat.isSymbolicLink()) {
    let target = null
    try { target = await fsp.readlink(linkPath) } catch { target = null }
    return { exists: true, kind: 'link', target: target ? normalizeLinkTarget(target) : null, rawTarget: target }
  }
  if (stat.isDirectory()) return { exists: true, kind: 'dir', target: null }
  return { exists: true, kind: 'file', target: null }
}

/** 解析 link: 依赖（相对 profile 目录归一化 ../）。返回 {target, outsideHome} 或 null。 */
export function resolveLinkSpec(profileDir, spec, home) {
  if (typeof spec !== 'string' || !spec.startsWith('link:')) return null
  const raw = spec.slice(5).trim().replace(/\\/g, '/')
  if (!raw) return null
  let target
  if (/^[a-zA-Z]:\//.test(raw) || raw.startsWith('//')) {
    target = path.resolve(raw)
  } else {
    target = path.resolve(profileDir, raw)
  }
  return { raw, target, outsideHome: home ? !isInsidePath(home, target) : false }
}

/**
 * 生成 junction 修复计划（只读）：每个 profile 的 link: 依赖 → create/rebuild/ok/conflict/error，
 * npm 依赖 → node_modules 下是否存在。
 */
export async function planJunctions({ home }) {
  const plan = {
    home,
    profiles: 0,
    actions: [],
    npm: [],
    npmMissing: [],
    warnings: [],
    errors: [],
    conflicts: [],
    nodeModulesMissing: [],
  }
  const profilesDir = path.join(home, 'profiles')
  let entries = []
  try { entries = await fsp.readdir(profilesDir, { withFileTypes: true }) } catch {
    return plan
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const profileDir = path.join(profilesDir, entry.name)
    const pkgFile = path.join(profileDir, 'package.json')
    if (!(await exists(pkgFile))) {
      plan.warnings.push(`profile ${entry.name} 没有 package.json，跳过 junction 修复`)
      continue
    }
    plan.profiles += 1
    const pkg = await readJsonFile(pkgFile, null)
    if (!pkg || typeof pkg !== 'object') {
      plan.errors.push(`profile ${entry.name} 的 package.json 无法解析`)
      continue
    }
    const deps = pkg.dependencies && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies)
      ? pkg.dependencies
      : {}
    const nodeModules = path.join(profileDir, 'node_modules')
    if (!(await exists(nodeModules))) plan.nodeModulesMissing.push(entry.name)
    for (const [depName, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string') continue
      const nameParts = linkNameParts(depName)
      if (!nameParts) {
        plan.errors.push(`profile ${entry.name} 的依赖名不合法：${depName}`)
        continue
      }
      const linkPath = path.join(nodeModules, ...nameParts)
      if (!spec.startsWith('link:')) {
        const item = {
          profile: entry.name,
          name: depName,
          spec,
          kind: 'npm',
          present: await exists(path.join(linkPath, 'package.json')) || await exists(linkPath),
        }
        plan.npm.push(item)
        if (!item.present) plan.npmMissing.push(item)
        continue
      }
      const resolved = resolveLinkSpec(profileDir, spec, home)
      const item = {
        profile: entry.name,
        name: depName,
        spec,
        kind: 'link',
        target: resolved ? resolved.target : null,
        link: linkPath,
        outsideHome: resolved ? resolved.outsideHome : false,
        action: 'ok',
        error: null,
      }
      plan.actions.push(item)
      if (!resolved || !resolved.target) {
        item.action = 'error'
        item.error = `无法解析 link 依赖：${spec}`
        continue
      }
      let targetStat = null
      try { targetStat = await fsp.stat(resolved.target) } catch { targetStat = null }
      if (!targetStat || !targetStat.isDirectory()) {
        item.action = 'error'
        item.error = `插件目录不存在：${resolved.target}`
        continue
      }
      if (!(await exists(path.join(resolved.target, 'package.json')))) {
        item.action = 'error'
        item.error = `插件目录里没有 package.json：${resolved.target}`
        continue
      }
      const link = await inspectLink(linkPath)
      if (!link.exists) {
        item.action = 'create'
        continue
      }
      if (link.kind === 'link') {
        if (samePath(link.target, resolved.target)) {
          item.action = 'ok'
          item.currentTarget = link.target
        } else {
          item.action = 'rebuild'
          item.currentTarget = link.target
        }
        continue
      }
      // 真实目录/文件：绝不自动删除（可能是 npm 装出来的真目录）
      item.action = 'conflict'
      item.error = `node_modules/${depName} 是真实${link.kind === 'dir' ? '目录' : '文件'}，拒绝自动删除；` +
        '请人工确认后改名再恢复'
      plan.conflicts.push(item)
    }
  }
  return plan
}

export function junctionSummary(plan) {
  const summary = { profiles: plan.profiles, create: 0, rebuild: 0, ok: 0, conflict: 0, error: 0, npm: 0, npmMissing: 0 }
  for (const item of plan.actions || []) {
    if (Object.prototype.hasOwnProperty.call(summary, item.action)) summary[item.action] += 1
  }
  summary.npm = (plan.npm || []).length
  summary.npmMissing = (plan.npmMissing || []).length
  return summary
}

/** 执行 junction 计划（删除只用 cmd /c rmdir；创建用 mklink /J）。 */
export async function applyJunctions(plan, { runCommandFn = runCommand } = {}) {
  const results = []
  let updated = 0
  let failed = 0
  for (const source of plan.actions || []) {
    const item = { ...source }
    results.push(item)
    if (item.action === 'ok' || item.action === 'error' || item.action === 'conflict') continue
    try {
      if (item.action === 'rebuild') {
        const removed = runCommandFn('cmd', ['/c', 'rmdir', item.link])
        if (!removed || removed.code !== 0) {
          throw new Error(`删除旧 junction 失败：${String((removed && (removed.stderr || removed.stdout)) || '').trim()}`)
        }
      }
      await fsp.mkdir(path.dirname(item.link), { recursive: true })
      const created = runCommandFn('cmd', ['/c', 'mklink', '/J', item.link, item.target])
      if (!created || created.code !== 0) {
        throw new Error(`创建 junction 失败：${String((created && (created.stderr || created.stdout)) || '').trim()}`)
      }
      const check = await inspectLink(item.link)
      if (check.kind !== 'link') throw new Error('junction 创建后检查失败（不是 reparse point）')
      if (!samePath(check.target, item.target)) {
        throw new Error(`junction 指向不符：期望 ${item.target}，实际 ${check.target || '未知'}`)
      }
      item.action = item.action === 'rebuild' ? 'rebuilt' : 'created'
      item.ok = true
      updated += 1
    } catch (error) {
      item.error = String((error && error.message) || error)
      failed += 1
    }
  }
  return { results, updated, failed }
}

/** 默认命令执行器（不经过 shell，避免注入；cmd 子命令用它包）。 */
export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    env: options.env || process.env,
    cwd: options.cwd || undefined,
  })
  return {
    code: result.status == null ? -1 : result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error ? String(result.error.message || result.error) : null,
  }
}

/* ═══════════════════════════════════════════════════ 进程/插件定位 */

/** 检测 DeepSeek Harness 进程（tasklist；非 Windows 返回空）。 */
export function defaultDetectDshProcesses({ runCommandFn = runCommand } = {}) {
  if (process.platform !== 'win32') return []
  const result = runCommandFn('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'])
  if (!result || result.code !== 0 || !result.stdout) return []
  const processes = []
  for (const line of result.stdout.split(/\r?\n/)) {
    const text = line.trim()
    if (!text.startsWith('"')) continue
    if (!/DeepSeek Harness\.exe/i.test(text)) continue
    const cells = text.replace(/^"|"$/g, '').split('","')
    processes.push({ pid: Number(cells[1]) || null, name: cells[0] || 'DeepSeek Harness.exe' })
  }
  return processes
}

/**
 * 解析自包含插件目录（scripts/cli.mjs）。
 * 顺序：<RECOVERY_HOME>\plugin → --plugin → <RECOVERY_HOME>\scripts（旧安装布局）
 *       → <consoleDir>\..\plugin → <consoleDir>\..（仓库布局）。
 */
export function resolvePluginDir({ args = {}, env = process.env, consoleDir = CONSOLE_DIR } = {}) {
  const candidates = []
  const recoveryHome = resolveRecoveryHome({ args, env, consoleDir })
  const envHome = env.DSH_RECOVERY_HOME || env.RECOVERY_HOME
  if (typeof envHome === 'string' && envHome.trim()) candidates.push(path.join(path.resolve(envHome.trim()), 'plugin'))
  if (typeof args.plugin === 'string' && args.plugin.trim()) {
    const value = path.resolve(args.plugin.trim())
    if (/\.mjs$/i.test(value)) {
      return { dir: path.dirname(path.dirname(value)), cliPath: value }
    }
    candidates.push(value)
  }
  candidates.push(path.join(recoveryHome, 'plugin'))
  candidates.push(recoveryHome)
  candidates.push(path.join(path.dirname(path.resolve(consoleDir)), 'plugin'))
  candidates.push(path.dirname(path.resolve(consoleDir)))
  for (const dir of candidates) {
    const cliPath = path.join(dir, 'scripts', 'cli.mjs')
    if (fs.existsSync(cliPath)) return { dir, cliPath }
  }
  return null
}

/** recovery-kit 的 recover.mjs：优先子机仓库自带，其次 plugin 副本。 */
export function resolveKitScript({ args = {}, env = process.env, consoleDir = CONSOLE_DIR, repoDir = null } = {}) {
  const candidates = []
  if (repoDir) candidates.push(path.join(repoDir, RECOVERY_KIT_DIRNAME, 'recover.mjs'))
  const plugin = resolvePluginDir({ args, env, consoleDir })
  if (plugin) {
    candidates.push(path.join(plugin.dir, 'scripts', 'recover.mjs'))
    candidates.push(path.join(plugin.dir, 'recovery-kit', 'recover.mjs'))
  }
  const recoveryHome = resolveRecoveryHome({ args, env, consoleDir })
  candidates.push(path.join(recoveryHome, 'plugin', 'scripts', 'recover.mjs'))
  candidates.push(path.join(path.dirname(path.resolve(consoleDir)), 'scripts', 'recover.mjs'))
  for (const file of candidates) if (fs.existsSync(file)) return file
  return null
}

/* ═══════════════════════════════════════════════ 子进程执行/解析 */

/** 执行子进程并实时转发 stdout/stderr；返回 {code, stdout, stderr, error}。 */
export async function runStreamed({ command, args, spawnFn = spawn, env = process.env, cwd, stdinText = null, emit = () => {} }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(command, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: [stdinText == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: '', error: String((error && error.message) || error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        const text = String(chunk)
        stdout += text
        emit({ stream: 'out', text })
      })
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const text = String(chunk)
        stderr += text
        emit({ stream: 'err', text })
      })
    }
    if (stdinText != null && child.stdin) {
      child.stdin.on('error', () => { /* 子进程提前退出时忽略 EPIPE */ })
      child.stdin.write(stdinText)
      child.stdin.end()
    }
    child.on('error', (error) => finish({ code: -1, stdout, stderr, error: String((error && error.message) || error) }))
    child.on('close', (code) => finish({ code: code == null ? -1 : code, stdout, stderr, error: null }))
  })
}

/** 解析 `cli.mjs restore` 的人类可读输出。 */
export function parseCliRestoreOutput(text) {
  const value = String(text || '')
  const parsed = { restored: null, unchanged: null, quarantined: null, extraLeft: null, failed: [] }
  const done = /恢复完成：覆盖\s*(\d+)，未变\s*(\d+)，隔离\s*(\d+)/.exec(value)
  if (done) {
    parsed.restored = Number(done[1])
    parsed.unchanged = Number(done[2])
    parsed.quarantined = Number(done[3])
  }
  const extra = /保留未动的文件：\s*(\d+)/.exec(value)
  if (extra) parsed.extraLeft = Number(extra[1])
  const failIndex = value.search(/失败\s*\d+\s*项/)
  if (failIndex >= 0) {
    for (const line of value.slice(failIndex).split(/\r?\n/).slice(1)) {
      const match = /^\s{2,}(.+?):\s*(.+)$/.exec(line)
      if (match) parsed.failed.push({ rel: match[1], reason: match[2] })
      else if (/^\s{0,2}\S/.test(line) && !/^请完全退出/.test(line)) break
    }
  }
  return parsed
}

/** 解析 `recover.mjs restore` 的人类可读输出。 */
export function parseKitRestoreOutput(text) {
  const value = String(text || '')
  const parsed = { snapshotId: null, restored: null, unchanged: null, quarantined: null, extraLeft: null, quarantineDir: null, failed: [] }
  const done = /写回\s*(\d+)\s*个文件，未变\s*(\d+)，覆盖前已备份\s*(\d+)\s*个/.exec(value)
  if (done) {
    parsed.restored = Number(done[1])
    parsed.unchanged = Number(done[2])
    parsed.quarantined = Number(done[3])
  }
  const snapshot = /恢复快照\s*:\s*(.+)/.exec(value)
  if (snapshot) parsed.snapshotId = snapshot[1].trim()
  const quarantine = /quarantine[：:]\s*(.+)/i.exec(value)
  if (quarantine) parsed.quarantineDir = quarantine[1].trim()
  const extra = /清单没有的文件：\s*(\d+)\s*个/.exec(value)
  if (extra) parsed.extraLeft = Number(extra[1])
  const failIndex = value.search(/失败\s*\d+\s*项/)
  if (failIndex >= 0) {
    for (const line of value.slice(failIndex).split(/\r?\n/).slice(1)) {
      const match = /^\s*-\s*(.+?):\s*(.+)$/.exec(line)
      if (match) parsed.failed.push({ rel: match[1], reason: match[2] })
    }
  }
  return parsed
}

/** 本地备份库恢复：默认走自包含 CLI；host 目录不属于当前主机名时退化为内置引擎。 */
export async function restoreFromLocalStore({
  plugin, storeRoot, hostStoreDir, hostTag, home, snapshotId, deps = {}, emit = () => {},
}) {
  const currentTag = currentHostTag()
  if (!plugin) {
    return {
      tool: null, exitCode: 1, ok: false, parsed: null, stdout: '', stderr: '',
      error: '找不到自包含的灾备 CLI（plugin\\scripts\\cli.mjs）。请用 --plugin 指定，或用 --repo 从子机仓库恢复。',
    }
  }
  if (hostTag === currentTag) {
    const args = [plugin.cliPath, 'restore', snapshotId, '--home', home, '--root', storeRoot, '--yes']
    emit({ stream: 'out', text: `\n[console] 执行：${deps.nodeExe || process.execPath} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\n` })
    const result = await runStreamed({
      command: deps.nodeExe || process.execPath,
      args,
      spawnFn: deps.spawn || spawn,
      env: deps.env || process.env,
      emit,
    })
    const parsed = parseCliRestoreOutput(result.stdout)
    return {
      tool: 'cli',
      exitCode: result.code,
      ok: result.code === 0,
      parsed,
      result: parsed,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error || (result.code === 0 ? null : `cli.mjs restore 退出码 ${result.code}`),
    }
  }

  // 所选 host 目录不是当前主机名：CLI 无法覆盖（它固定用 os.hostname()），
  // 这里直接加载插件自带 engine 并指定 hostname。skipPreBackup=true：
  // 不往别的 host 的库里写 pre-restore 快照，避免触发它的 prune。
  const enginePath = path.join(plugin.dir, 'src', 'engine.js')
  if (!fs.existsSync(enginePath)) {
    return {
      tool: 'engine', exitCode: 1, ok: false, parsed: null, stdout: '', stderr: '',
      error: `找不到插件引擎：${enginePath}（无法按 host=${hostTag} 恢复）`,
    }
  }
  emit({ stream: 'err', text: `\n[console] 所选 host=${hostTag} 与当前主机 ${currentTag} 不同，改用自带 engine 恢复（不写 pre-restore 快照）。\n` })
  const mod = await import(pathToFileURL(enginePath).href)
  const engine = new mod.BackupEngine({
    home,
    hostname: hostTag,
    snapshotOnStart: false,
    config: { root: storeRoot, enabled: false, watch: false, scanMs: 3_600_000, minIntervalMs: 0 },
    log: (message) => emit({ stream: 'err', text: `[engine] ${message}\n` }),
  })
  await engine.start()
  let result
  try {
    result = await engine.restore(snapshotId, { skipPreBackup: true })
  } finally {
    await engine.stop()
  }
  emit({
    stream: 'out',
    text: `恢复完成：覆盖 ${result.restored}，未变 ${result.unchanged}，隔离 ${result.quarantined}` +
      (result.failed.length ? `，失败 ${result.failed.length}` : '') + '\n',
  })
  return {
    tool: 'engine',
    exitCode: result.failed.length ? 3 : 0,
    ok: result.failed.length === 0,
    parsed: {
      restored: result.restored,
      unchanged: result.unchanged,
      quarantined: result.quarantined,
      extraLeft: result.extraLeft,
      failed: result.failed,
    },
    result,
    stdout: '',
    stderr: '',
    error: result.failed.length ? `${result.failed.length} 个文件恢复失败` : null,
  }
}

/** 从子机加密仓库恢复（recovery-kit/recover.mjs restore）。 */
export async function restoreFromKit({
  kitScript, repoDir, home, password = null, passwordEnv = null, dpapi = false, dpapiFile = null,
  force = false, deps = {}, emit = () => {},
}) {
  if (!kitScript || !fs.existsSync(kitScript)) {
    return { tool: 'recovery-kit', exitCode: 1, ok: false, parsed: null, stdout: '', stderr: '', error: `找不到 recovery-kit\\recover.mjs：${kitScript || '未提供'}` }
  }
  const args = [kitScript, 'restore', '--dir', repoDir, '--home', home, '--yes']
  if (force) args.push('--force')
  let stdinText = null
  if (typeof passwordEnv === 'string' && passwordEnv.trim()) {
    args.push('--password-env', passwordEnv.trim())
  } else if (dpapi) {
    args.push('--dpapi')
    if (typeof dpapiFile === 'string' && dpapiFile.trim()) args.push('--dpapi-file', path.resolve(dpapiFile.trim()))
  } else if (typeof password === 'string' && password.length) {
    args.push('--password-stdin')
    stdinText = `${password}\n`
  } else {
    return { tool: 'recovery-kit', exitCode: 1, ok: false, parsed: null, stdout: '', stderr: '', error: '缺少密码来源（--password-env / --dpapi / 环境变量 DSH_RECOVERY_PASSWORD）' }
  }
  emit({ stream: 'out', text: `\n[console] 执行：${deps.nodeExe || process.execPath} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\n` })
  const result = await runStreamed({
    command: deps.nodeExe || process.execPath,
    args,
    spawnFn: deps.spawn || spawn,
    env: deps.env || process.env,
    stdinText,
    emit,
  })
  const parsed = parseKitRestoreOutput(result.stdout)
  return {
    tool: 'recovery-kit',
    exitCode: result.code,
    ok: result.code === 0,
    parsed,
    result: parsed,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error || (result.code === 0 ? null : `recover.mjs 退出码 ${result.code}`),
  }
}

/** 恢复后核对：清单里的文件是否都写到了 home（存在 + 大小一致）。 */
export async function postRestoreCheck({ hostDir, manifest, home }) {
  const files = (manifest && manifest.files) || {}
  let checked = 0
  let present = 0
  const missing = []
  const sizeMismatch = []
  for (const [rel, entry] of Object.entries(files)) {
    checked += 1
    const abs = joinInside(home, rel)
    let stat = null
    if (abs) {
      try { stat = await fsp.stat(abs) } catch { stat = null }
    }
    if (!stat) { missing.push(rel); continue }
    if (Number(entry.s) === stat.size) present += 1
    else sizeMismatch.push(rel)
  }
  return {
    checked,
    present,
    missing: missing.length,
    missingSample: missing.slice(0, 10),
    sizeMismatch: sizeMismatch.length,
    sizeMismatchSample: sizeMismatch.slice(0, 10),
  }
}

/* ═══════════════════════════════════════════════════════ 报告/启动 */

/** 报告目录：<storeRoot>\manual\<ts>-external-restore（重名时追加序号）。 */
export function reportDirFor(storeRoot, date = new Date()) {
  const base = path.join(storeRoot, 'manual', `${localStamp(date)}-external-restore`)
  let dir = base
  let n = 2
  while (fs.existsSync(dir)) { dir = `${base}-${n}`; n += 1 }
  return dir
}

/** 写 report.json + console.log；返回 {dir, reportPath, logPath}。 */
export async function writeReport({ storeRoot, report, logText, dir = null }) {
  const target = dir || reportDirFor(storeRoot)
  await fsp.mkdir(target, { recursive: true })
  const reportPath = path.join(target, 'report.json')
  const logPath = path.join(target, 'console.log')
  report.reportDir = target
  report.reportPath = reportPath
  report.logs = { consoleLog: logPath }
  await writeFileAtomic(logPath, Buffer.from(String(logText || ''), 'utf8'))
  await writeFileAtomic(reportPath, Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8'))
  return { dir: target, reportPath, logPath }
}

function quotePs(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** 默认启动 DSH：Start-Process（与手动双击一致，不继承本控制台环境）。 */
export function defaultStartDsh(exePath, { spawnFn = spawn } = {}) {
  const exe = path.resolve(String(exePath || DEFAULT_DSH_EXE))
  if (!fs.existsSync(exe)) {
    return { requested: true, started: false, exe, error: `找不到 DeepSeek Harness：${exe}` }
  }
  try {
    const command = `Start-Process -FilePath ${quotePs(exe)}`
    const child = spawnFn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    if (child && child.unref) child.unref()
    return { requested: true, started: true, exe, error: null }
  } catch (error) {
    return { requested: true, started: false, exe, error: String((error && error.message) || error) }
  }
}

/* ═══════════════════════════════════════════════════════ 交互输入 */

export async function defaultAsk(question) {
  if (!process.stdin.isTTY) return ''
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return String(await rl.question(question))
  } finally {
    rl.close()
  }
}

/** 隐藏输入（不回显）。非 TTY 返回空串，由调用方给 --password-env/--dpapi 提示。 */
export async function defaultAskPassword(prompt) {
  const stdin = process.stdin
  if (!stdin.isTTY) return ''
  process.stdout.write(prompt)
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
            process.stdout.write('\n')
            resolve(value)
            return
          }
          if (ch === '\u0003') {
            stdin.removeListener('data', onData)
            process.stdout.write('\n')
            reject(new Error('已取消（Ctrl+C）'))
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

/* ═══════════════════════════════════════════════════════ 主流程 */

function createContext(argv, deps) {
  const env = (deps && deps.env) || process.env
  const lines = []
  const out = typeof deps.stdout === 'function' ? deps.stdout : (text) => process.stdout.write(text)
  const err = typeof deps.stderr === 'function' ? deps.stderr : (text) => process.stderr.write(text)
  const emit = ({ stream, text }) => {
    const value = String(text == null ? '' : text)
    lines.push(value)
    if (stream === 'err') err(value)
    else out(value)
  }
  const log = (text) => emit({ stream: 'out', text: `${text}\n` })
  const logErr = (text) => emit({ stream: 'err', text: `${text}\n` })
  const runCommandFn = deps.runCommand || runCommand
  const spawnFn = deps.spawn || spawn
  const D = {
    env,
    spawn: spawnFn,
    runCommand: runCommandFn,
    detectDshProcesses: deps.detectDshProcesses
      || (() => defaultDetectDshProcesses({ runCommandFn })),
    ask: deps.ask || defaultAsk,
    askPassword: deps.askPassword || defaultAskPassword,
    startDsh: deps.startDsh || ((exe) => defaultStartDsh(exe, { spawnFn })),
    nodeExe: deps.nodeExe || process.execPath,
    interactive: deps.interactive === undefined ? Boolean(process.stdin.isTTY) : Boolean(deps.interactive),
    password: typeof deps.password === 'string' ? deps.password : null,
    now: deps.now || Date.now,
    defaultStoreRoot: typeof deps.defaultStoreRoot === 'string' ? deps.defaultStoreRoot : DEFAULT_STORE_ROOT,
  }
  return {
    args: parseArgs(argv),
    env,
    D,
    emit,
    log,
    logErr,
    lines,
    out,
    err,
    recoveryHome: '',
    configPath: '',
    config: {},
    storeRoot: '',
    home: '',
    report: null,
    reportDir: null,
  }
}

function contextHeader(ctx) {
  ctx.log('')
  ctx.log('  Deepseek 恢复 · 外部一键恢复控制台')
  ctx.log('  适用于 .dsh 整个丢失 / DSH 起不来；恢复前请完全退出 DeepSeek Harness。')
  ctx.log('')
  ctx.log(`  数据目录 home : ${ctx.home}`)
  ctx.log(`  备份库 store  : ${ctx.storeRoot}`)
  ctx.log(`  监控配置      : ${ctx.configPath}${ctx.config && Object.keys(ctx.config).length ? '' : '（不存在，使用默认值）'}`)
  ctx.log(`  恢复工具目录  : ${ctx.recoveryHome}`)
  ctx.log('')
}

/** 入口：执行一次控制台；返回退出码。deps 可注入（测试/自动化）。 */
export async function runConsole(argv = [], deps = {}) {
  const ctx = createContext(argv, deps)
  const args = ctx.args
  if (args.help || args.h || args['?']) {
    ctx.out(USAGE)
    return 0
  }
  ctx.recoveryHome = resolveRecoveryHome({ args, env: ctx.env })
  ctx.configPath = resolveConfigPath({ args, env: ctx.env, recoveryHome: ctx.recoveryHome })
  ctx.config = await readMonitorConfig(ctx.configPath)
  ctx.home = resolveHome({ args, env: ctx.env })
  ctx.storeRoot = resolveStoreRoot({ args, env: ctx.env, config: ctx.config, defaultRoot: ctx.D.defaultStoreRoot })
  contextHeader(ctx)
  if (args.list) return commandList(ctx)
  if (args.verify) return commandVerify(ctx)
  return commandRestore(ctx)
}

/* ------------------------------------------------------------------ list */

async function commandList(ctx) {
  const stores = await findHostStores(ctx.storeRoot)
  if (!stores.length) {
    ctx.logErr(`备份库不可用：${ctx.storeRoot} 下没有 <host>/snapshots 目录。`)
    ctx.logErr('如果要用子机仓库查看，请先恢复（--repo <目录>）；这里只读列出，不做恢复。')
    return 2
  }
  const store = await pickHostStore(ctx, stores)
  if (!store) return 1
  const { total, snapshots } = await readSnapshotSummaries(store.dir, { limit: SNAPSHOT_LIST_LIMIT })
  const incidents = await readIncidents(store.dir)
  ctx.log(`主机目录      : ${store.name}${store.currentHost ? '（当前主机）' : ''}`)
  ctx.log(`快照总数      : ${total}`)
  ctx.log(`监控事故      : ${incidents.length} 条`)
  ctx.log('')
  ctx.log(`最近 ${snapshots.length} 份快照：`)
  snapshots.forEach((snapshot, index) => {
    ctx.log(`  [${String(index + 1).padStart(2)}] ${snapshot.id}  ${formatWhen(snapshot.at)}  ` +
      `${String(snapshot.files).padStart(5)} 文件  ${snapshot.reason}`)
  })
  if (!snapshots.length) ctx.log('  （没有快照）')
  ctx.log('')
  const point = await chooseRecoveryPoint({
    hostDir: store.dir,
    snapshotIds: await listSnapshotIds(store.dir),
    incidents,
  })
  if (point.source) {
    ctx.log(`推荐恢复点    : ${point.snapshotId}（${point.reason}）`)
    ctx.log(`  ${formatWhen(point.snapshot ? point.snapshot.at : 0)}，` +
      `${point.snapshot ? point.snapshot.files : '?'} 个文件，缺块 ${point.verified ? point.verified.missingCount : '?'}`)
  } else {
    ctx.logErr(`没有可用恢复点：${point.reason}`)
    return 2
  }
  return 0
}

/* ---------------------------------------------------------------- verify */

async function commandVerify(ctx) {
  const stores = await findHostStores(ctx.storeRoot)
  if (!stores.length) {
    ctx.logErr(`备份库不可用：${ctx.storeRoot} 下没有 <host>/snapshots 目录。`)
    return 2
  }
  const store = await pickHostStore(ctx, stores)
  if (!store) return 1
  let ids = await listSnapshotIds(store.dir)
  if (typeof ctx.args.snapshot === 'string' && ctx.args.snapshot.trim() && ctx.args.snapshot !== 'latest') {
    ids = [ctx.args.snapshot.trim()]
  } else if (ctx.args.snapshot === 'latest') {
    ids = ids.slice(0, 1)
  }
  if (!ids.length) {
    ctx.logErr('没有快照可校验。')
    return 2
  }
  ctx.log(`校验 ${ids.length} 份快照（缺块=0 才 PASS）：`)
  let bad = 0
  for (const id of ids) {
    const result = await verifySnapshotLocal(store.dir, id)
    const mark = result.ok ? 'PASS' : 'FAIL'
    ctx.log(`  ${mark}  ${id}  ${formatWhen(result.at)}  ${result.files} 文件` +
      (result.ok ? '' : `  缺块 ${result.missingCount}（示例：${result.missing.slice(0, 3).join(', ') || '清单不可读'}）`))
    if (!result.ok) bad += 1
  }
  ctx.log('')
  ctx.log(bad ? `${bad} 份快照校验失败。` : '全部通过。')
  return bad ? 2 : 0
}

/* --------------------------------------------------------------- restore */

async function commandRestore(ctx) {
  const args = ctx.args
  const startedAt = ctx.D.now()
  const report = {
    version: REPORT_VERSION,
    kind: 'external-restore',
    tool: `dsh-disaster-recovery/recovery-console@${CONSOLE_VERSION}`,
    dryRun: Boolean(args['dry-run']),
    startedAt,
    finishedAt: null,
    durationMs: null,
    ok: false,
    exitCode: null,
    source: 'local-store',
    console: { version: CONSOLE_VERSION, argv: process.argv.slice(2), node: process.version, platform: process.platform },
    paths: {
      home: ctx.home,
      storeRoot: ctx.storeRoot,
      configPath: ctx.configPath,
      recoveryHome: ctx.recoveryHome,
      hostStore: null,
      currentHost: currentHostTag(),
    },
    host: null,
    hostStore: null,
    snapshot: null,
    recommendation: null,
    incidents: [],
    plan: null,
    junctions: null,
    restore: null,
    postCheck: null,
    dshProcesses: [],
    start: { requested: false, started: false, exe: null, error: null },
    errors: [],
  }
  ctx.report = report

  // 1) DSH 进程检测：真正恢复时默认拒绝；--dry-run 是只读预演，不受此限。
  const processes = await ctx.D.detectDshProcesses()
  report.dshProcesses = processes
  if (processes.length && !args['dry-run']) {
    const pids = processes.map((item) => item.pid).filter(Boolean).join(', ')
    ctx.logErr(`检测到 DeepSeek Harness 正在运行${pids ? `（pid ${pids}）` : ''}。`)
    ctx.logErr('请先完全退出 DeepSeek Harness（托盘图标 → 退出），否则它的内存态会覆盖恢复结果。')
    if (!args.force) {
      ctx.logErr('确认已退出后重试；确实要先恢复可加 --force（会再要求明确确认）。')
      report.errors.push('dsh-running')
      return 1
    }
    if (!args.yes) {
      const answer = (await ctx.D.ask('仍要继续吗？输入 CONTINUE 继续（直接回车取消）：')).trim()
      if (answer !== 'CONTINUE') {
        ctx.log('已取消（没有做任何修改）。')
        return 1
      }
    } else {
      ctx.logErr('--force --yes：跳过二次确认继续（风险自负）。')
    }
  }

  // 2) 备份库 / 主机目录 / 快照定位
  const stores = await findHostStores(ctx.storeRoot)
  if (!stores.length) {
    report.errors.push(`备份库不可用：${ctx.storeRoot}`)
    return tryKitRestore(ctx, report, `备份库不可用：${ctx.storeRoot} 下没有 <host>/snapshots 目录`)
  }
  const store = await pickHostStore(ctx, stores)
  if (!store) {
    report.errors.push('未选择 host 目录')
    return 1
  }
  report.host = store.name
  report.hostStore = store.dir
  report.paths.hostStore = store.dir
  ctx.log(`主机目录      : ${store.name}${store.currentHost ? '（当前主机）' : ''}  ${store.dir}`)
  const ids = await listSnapshotIds(store.dir)
  if (!ids.length) {
    report.errors.push('备份库没有快照')
    return tryKitRestore(ctx, report, `${store.dir} 里没有快照`)
  }
  const { total, snapshots } = await readSnapshotSummaries(store.dir, { limit: SNAPSHOT_LIST_LIMIT })
  const incidents = await readIncidents(store.dir)
  report.incidents = incidents.map((incident) => ({
    id: incident.id,
    kind: incident.kind,
    status: incident.status,
    at: incidentTime(incident),
    recommendation: incident.recommendation,
  }))
  ctx.log(`快照总数      : ${total}`)

  // 3) 推荐恢复点
  let point
  const manualId = typeof args.snapshot === 'string' && args.snapshot.trim()
    ? (args.snapshot.trim() === 'latest' ? ids[0] : args.snapshot.trim())
    : null
  if (manualId) {
    const verified = await verifySnapshotLocal(store.dir, manualId)
    if (!verified.ok) {
      ctx.logErr(`指定快照 ${manualId} 校验失败（缺块 ${verified.missingCount}），拒绝恢复。`)
      report.errors.push(`指定快照缺块：${manualId}`)
      return tryKitRestore(ctx, report, `指定快照 ${manualId} 缺块`)
    }
    point = {
      source: 'manual',
      snapshotId: manualId,
      snapshot: await summarizeSnapshot(store.dir, manualId),
      incident: null,
      verified,
      reason: '命令行 --snapshot 指定',
      probes: [],
    }
  } else {
    point = await chooseRecoveryPoint({ hostDir: store.dir, snapshotIds: ids, incidents })
  }
  if (!point.source || !point.snapshotId) {
    ctx.logErr(`本地备份库没有可用恢复点：${point.reason}`)
    report.errors.push(point.reason)
    return tryKitRestore(ctx, report, point.reason)
  }
  report.recommendation = {
    kind: point.source,
    reason: point.reason,
    snapshotId: point.snapshotId,
    incidentId: point.incident ? point.incident.id : null,
    verified: point.verified ? point.verified.ok : null,
    probes: point.probes,
  }
  report.snapshot = point.snapshot
  ctx.log('')
  ctx.log(`推荐恢复点    : ${point.snapshotId}（${point.reason}）`)
  ctx.log(`  时间 ${formatWhen(point.snapshot.at)}，${point.snapshot.files} 个文件，` +
    `缺块 ${point.verified.missingCount}，来源 ${point.source}`)
  ctx.log('')
  ctx.log(`最近 ${snapshots.length} 份快照：`)
  snapshots.forEach((snapshot, index) => {
    const mark = snapshot.id === point.snapshotId ? '*' : ' '
    ctx.log(` ${mark}[${String(index + 1).padStart(2)}] ${snapshot.id}  ${formatWhen(snapshot.at)}  ` +
      `${String(snapshot.files).padStart(5)} 文件  ${snapshot.reason}`)
  })
  ctx.log('')

  // 4) 恢复计划
  let manifest
  try {
    manifest = await loadManifest(store.dir, point.snapshotId)
  } catch (error) {
    ctx.logErr(`读取快照清单失败：${String((error && error.message) || error)}`)
    report.errors.push(`清单不可读：${point.snapshotId}`)
    return tryKitRestore(ctx, report, '快照清单不可读')
  }
  const plan = await buildPlan({ home: ctx.home, manifest })
  report.plan = plan
  ctx.log('恢复计划：')
  ctx.log(`  快照          : ${point.snapshotId}  ${formatWhen(point.snapshot.at)}  ${plan.files} 个文件`)
  ctx.log(`  当前 .dsh     : ${plan.current.exists ? `存在，${plan.current.files} 个文件` : '不存在（将新建）'}`)
  ctx.log(`  新建          : ${plan.create} 个`)
  ctx.log(`  覆盖          : ${plan.overwrite} 个（被覆盖文件先入 quarantine）`)
  ctx.log(`  未变化        : ${plan.unchanged} 个`)
  ctx.log(`  快照外文件    : ${plan.extra} 个（保留不动，不删除）`)
  ctx.log(`  写入数据量    : ${formatBytes(plan.bytes)}`)
  ctx.log('')

  // 5) junction 预计划（恢复后执行）
  const junctionPlan = await planJunctions({ home: ctx.home })
  const junctionStat = junctionSummary(junctionPlan)
  ctx.log('junction 检查（profile 的 link: 依赖）：')
  ctx.log(`  profile ${junctionStat.profiles} 个；待创建 ${junctionStat.create}，待重建 ${junctionStat.rebuild}，` +
    `已正常 ${junctionStat.ok}，冲突 ${junctionStat.conflict}，错误 ${junctionStat.error}`)
  if (junctionStat.npm) ctx.log(`  npm 依赖 ${junctionStat.npm} 个，node_modules 缺失 ${junctionStat.npmMissing} 个`)
  for (const warning of junctionPlan.warnings) ctx.log(`  ! ${warning}`)
  for (const conflict of junctionPlan.conflicts) ctx.logErr(`  ! 冲突：${conflict.profile} / ${conflict.name}：${conflict.error}`)
  ctx.log('')

  // 6) dry-run：到此为止
  if (args['dry-run']) {
    ctx.log('dry-run：只校验和打印计划，没有修改任何文件。')
    report.ok = true
    report.exitCode = 0
    report.finishedAt = ctx.D.now()
    report.durationMs = report.finishedAt - startedAt
    return 0
  }

  // 7) 确认（YES / 编号改选 / c 取消）
  if (!args.yes) {
    let confirmed = false
    for (let round = 0; round < 5; round += 1) {
      const answer = (await ctx.D.ask(
        `输入 YES 开始恢复；输入编号（1-${snapshots.length}）改选快照；输入 c 取消：`,
      )).trim()
      if (answer === 'YES') { confirmed = true; break }
      if (/^c$/i.test(answer)) {
        ctx.log('已取消（没有做任何修改）。')
        return 1
      }
      const index = Number(answer)
      if (answer && Number.isInteger(index) && index >= 1 && index <= snapshots.length) {
        const chosen = snapshots[index - 1]
        const verified = await verifySnapshotLocal(store.dir, chosen.id)
        if (!verified.ok) {
          ctx.logErr(`快照 ${chosen.id} 校验失败（缺块 ${verified.missingCount}），换一个。`)
          continue
        }
        point = {
          source: 'manual', snapshotId: chosen.id, snapshot: chosen, incident: null, verified,
          reason: '交互选择', probes: [],
        }
        report.recommendation = {
          kind: 'manual', reason: '交互选择', snapshotId: chosen.id, incidentId: null, verified: true, probes: [],
        }
        report.snapshot = chosen
        try { manifest = await loadManifest(store.dir, chosen.id) } catch { continue }
        report.plan = await buildPlan({ home: ctx.home, manifest })
        ctx.log(`已改选快照：${chosen.id}（${formatWhen(chosen.at)}，${chosen.files} 个文件）`)
        continue
      }
      ctx.log('请输入 YES 或快照编号（或 c 取消）。')
    }
    if (!confirmed) {
      ctx.logErr('没有收到 YES，已取消（没有做任何修改）。')
      return 1
    }
  }

  // 8) 执行恢复（自包含 CLI / 引擎回退）
  const plugin = resolvePluginDir({ args, env: ctx.env, consoleDir: CONSOLE_DIR })
  const restore = await restoreFromLocalStore({
    plugin,
    storeRoot: ctx.storeRoot,
    hostStoreDir: store.dir,
    hostTag: store.name,
    home: ctx.home,
    snapshotId: point.snapshotId,
    deps: ctx.D,
    emit: ctx.emit,
  })
  report.restore = {
    tool: restore.tool,
    ok: restore.ok,
    exitCode: restore.exitCode,
    error: restore.error,
    result: restore.parsed || null,
    stdoutTail: tail(restore.stdout),
    stderrTail: tail(restore.stderr),
  }
  let exitCode = 0
  if (!restore.ok) {
    const child = Number(restore.exitCode)
    exitCode = child === 2 ? 2 : (child === 3 ? 3 : (child === 1 ? 2 : 3))
    ctx.logErr(`恢复失败（退出码 ${restore.exitCode}）：${restore.error || '未知错误'}`)
    report.errors.push(restore.error || `恢复失败：${restore.exitCode}`)
  } else {
    ctx.log('恢复完成。')
  }

  // 9) junction 修复（恢复后重新计算计划：恢复前 home 里可能还没有 profiles）
  const junctionPlanAfter = await planJunctions({ home: ctx.home })
  const applied = await applyJunctions(junctionPlanAfter, { runCommandFn: ctx.D.runCommand })
  report.junctions = {
    summary: junctionSummary(junctionPlanAfter),
    results: applied.results,
    updated: applied.updated,
    failed: applied.failed,
    npmMissing: junctionPlanAfter.npmMissing.map((item) => ({ profile: item.profile, name: item.name, spec: item.spec })),
    warnings: junctionPlanAfter.warnings,
    nodeModulesMissing: junctionPlanAfter.nodeModulesMissing,
  }
  if (applied.updated) ctx.log(`junction 已修复 ${applied.updated} 个。`)
  for (const item of applied.results) {
    if (item.action === 'created' || item.action === 'rebuilt') {
      ctx.log(`  [${item.action}] ${item.profile}/${item.name} -> ${item.target}`)
    } else if (item.action === 'conflict' || item.action === 'error') {
      ctx.logErr(`  [${item.action}] ${item.profile}/${item.name}：${item.error}`)
    } else if (item.error) {
      ctx.logErr(`  [失败] ${item.profile}/${item.name}：${item.error}`)
    }
  }
  if (applied.failed) {
    ctx.logErr(`junction 修复有 ${applied.failed} 项失败。`)
    if (exitCode === 0) exitCode = 3
    report.errors.push(`junction 修复失败 ${applied.failed} 项`)
  }
  if (junctionPlan.npmMissing.length) {
    ctx.logErr(`警告：${junctionPlan.npmMissing.length} 个 npm 依赖在 node_modules 里缺失，DSH 可能加载失败；` +
      '需要时在 profile 目录执行 npm install。')
  }

  // 10) 恢复后核对（只对本地备份库，kit 无法在不解密时核对）
  if (restore.ok && restore.tool !== 'recovery-kit' && manifest) {
    report.postCheck = await postRestoreCheck({ hostDir: store.dir, manifest, home: ctx.home })
    const post = report.postCheck
    ctx.log(`核对：清单 ${post.checked} 个文件，存在 ${post.present}，缺失 ${post.missing}，大小不符 ${post.sizeMismatch}。`)
    if (post.missing || post.sizeMismatch) {
      if (exitCode === 0) exitCode = 3
      report.errors.push(`恢复后核对不一致：缺失 ${post.missing}，大小不符 ${post.sizeMismatch}`)
    }
  }

  // 11) 启动 DSH（默认；--no-start 关闭）
  if (exitCode === 0 && !args['no-start']) {
    const exe = typeof args.exe === 'string' && args.exe.trim() ? path.resolve(args.exe.trim()) : DEFAULT_DSH_EXE
    ctx.log('')
    ctx.log(`启动 DeepSeek Harness：${exe}`)
    const started = await ctx.D.startDsh(exe)
    report.start = { requested: true, started: Boolean(started && started.started), exe, error: started ? started.error : '启动函数未返回' }
    if (report.start.started) ctx.log('已发出启动命令；请等 DSH 启动完成后确认数据。')
    else ctx.logErr(`启动失败：${report.start.error}。请手动双击 DeepSeek Harness。`)
  } else if (args['no-start']) {
    report.start = { requested: false, started: false, exe: null, error: null }
    ctx.log('按 --no-start：不自动启动 DeepSeek Harness。')
  }

  // 12) 写报告
  report.ok = exitCode === 0
  report.exitCode = exitCode
  report.finishedAt = ctx.D.now()
  report.durationMs = report.finishedAt - startedAt
  await finishAndWriteReport(ctx, report)
  ctx.log('')
  if (exitCode === 0) {
    ctx.log('恢复成功。建议马上启动 DSH 检查会话/插件是否正常，并保留这次报告。')
  } else {
    ctx.logErr(`恢复未完全成功（退出码 ${exitCode}），详情见报告：${report.reportPath || report.reportDir || '(报告写入失败)'}`)
  }
  return exitCode
}

/* -------------------------------------------------------- 子机仓库恢复 */

async function tryKitRestore(ctx, report, reason) {
  const args = ctx.args
  ctx.log('')
  ctx.logErr(`本地备份库不可用：${reason}`)
  ctx.log('可以改用子机仓库（U 盘/UNC）里的 recovery-kit\\recover.mjs 恢复；需要有恢复密码。')
  let repoDir = typeof args.repo === 'string' && args.repo.trim()
    ? path.resolve(args.repo.trim().replace(/^"|"$/g, ''))
    : null
  if (!repoDir && !args.auto && ctx.D.interactive) {
    const answer = (await ctx.D.ask('请输入子机仓库目录（U 盘/UNC 路径，直接回车取消）：')).trim()
    if (answer) repoDir = path.resolve(answer.replace(/^"|"$/g, ''))
  }
  if (!repoDir) {
    ctx.logErr('没有可用的子机仓库目录：请加 --repo <目录>（含 repo.json 与 recovery-kit\\）后重试。')
    report.source = 'none'
    report.ok = false
    report.exitCode = 2
    report.finishedAt = ctx.D.now()
    report.durationMs = report.finishedAt - report.startedAt
    await finishAndWriteReport(ctx, report)
    return 2
  }
  if (!fs.existsSync(path.join(repoDir, 'repo.json'))) {
    ctx.logErr(`不是加密仓库（缺少 repo.json）：${repoDir}`)
    report.source = 'recovery-kit'
    report.errors.push(`不是加密仓库：${repoDir}`)
    report.ok = false
    report.exitCode = 2
    report.finishedAt = ctx.D.now()
    report.durationMs = report.finishedAt - report.startedAt
    await finishAndWriteReport(ctx, report)
    return 2
  }
  const kitScript = resolveKitScript({ args, env: ctx.env, consoleDir: CONSOLE_DIR, repoDir })
  if (!kitScript) {
    ctx.logErr('找不到 recovery-kit\\recover.mjs（子机仓库里应有 recovery-kit 目录；或安装器的 plugin 副本缺失）。')
    report.errors.push('找不到 recovery-kit/recover.mjs')
    report.ok = false
    report.exitCode = 2
    report.finishedAt = ctx.D.now()
    report.durationMs = report.finishedAt - report.startedAt
    await finishAndWriteReport(ctx, report)
    return 2
  }

  report.source = 'recovery-kit'
  report.kit = { repoDir, kitScript }
  ctx.log('')
  ctx.log(`子机仓库      : ${repoDir}`)
  ctx.log(`恢复工具      : ${kitScript}`)
  ctx.log(`目标 home     : ${ctx.home}${(await isNonEmptyDir(ctx.home)) ? '（非空：会被覆盖的文件先入 recovery-quarantine）' : '（空/不存在）'}`)
  ctx.log('')

  const passwordEnv = typeof args['password-env'] === 'string' && args['password-env'].trim()
    ? args['password-env'].trim()
    : null
  const dpapi = Boolean(args.dpapi)
  const dpapiFile = typeof args['dpapi-file'] === 'string' ? args['dpapi-file'] : null
  let password = null
  if (!passwordEnv && !dpapi) {
    password = ctx.D.password || (typeof ctx.env.DSH_RECOVERY_PASSWORD === 'string' ? ctx.env.DSH_RECOVERY_PASSWORD : null)
    if (!password) {
      if (ctx.D.interactive) {
        password = await ctx.D.askPassword('恢复密码（输入不回显）：')
      } else {
        ctx.logErr('需要恢复密码：--password-env NAME / --dpapi / 环境变量 DSH_RECOVERY_PASSWORD（或交互终端输入）。')
        report.errors.push('缺少恢复密码')
        report.ok = false
        report.exitCode = 1
        report.finishedAt = ctx.D.now()
        report.durationMs = report.finishedAt - report.startedAt
        await finishAndWriteReport(ctx, report)
        return 1
      }
    }
    if (!password) {
      ctx.logErr('恢复密码为空，已取消。')
      report.errors.push('恢复密码为空')
      report.ok = false
      report.exitCode = 1
      report.finishedAt = ctx.D.now()
      report.durationMs = report.finishedAt - report.startedAt
      await finishAndWriteReport(ctx, report)
      return 1
    }
  }

  if (args['dry-run']) {
    ctx.log('dry-run：只做校验，不写任何文件。')
    const verifyArgs = [kitScript, 'verify', '--dir', repoDir, '--yes']
    if (passwordEnv) verifyArgs.push('--password-env', passwordEnv)
    else if (dpapi) {
      verifyArgs.push('--dpapi')
      if (dpapiFile) verifyArgs.push('--dpapi-file', path.resolve(dpapiFile))
    } else {
      verifyArgs.push('--password-stdin')
    }
    const verify = await runStreamed({
      command: ctx.D.nodeExe,
      args: verifyArgs,
      spawnFn: ctx.D.spawn,
      env: ctx.env,
      stdinText: password ? `${password}\n` : null,
      emit: ctx.emit,
    })
    report.verify = { exitCode: verify.code, stdoutTail: tail(verify.stdout), stderrTail: tail(verify.stderr) }
    const code = verify.code === 0 ? 0 : 2
    report.ok = code === 0
    report.exitCode = code
    report.finishedAt = ctx.D.now()
    report.durationMs = report.finishedAt - report.startedAt
    await finishAndWriteReport(ctx, report)
    return code
  }

  if (!args.yes) {
    const answer = (await ctx.D.ask('输入 YES 开始从子机仓库恢复（输入其他内容取消）：')).trim()
    if (answer !== 'YES') {
      ctx.log('已取消（没有做任何修改）。')
      return 1
    }
  }

  const force = await isNonEmptyDir(ctx.home)
  const restore = await restoreFromKit({
    kitScript,
    repoDir,
    home: ctx.home,
    password,
    passwordEnv,
    dpapi,
    dpapiFile,
    force,
    deps: ctx.D,
    emit: ctx.emit,
  })
  report.restore = {
    tool: 'recovery-kit',
    ok: restore.ok,
    exitCode: restore.exitCode,
    error: restore.error,
    result: restore.parsed || null,
    stdoutTail: tail(restore.stdout),
    stderrTail: tail(restore.stderr),
    forced: force,
  }
  let exitCode = 0
  if (!restore.ok) {
    const child = Number(restore.exitCode)
    exitCode = child === 2 ? 2 : (child === 3 ? 3 : (child === 4 || child === 1 ? 1 : 3))
    ctx.logErr(`从子机仓库恢复失败（退出码 ${restore.exitCode}）：${restore.error || '未知错误'}`)
    if (child === 4) ctx.logErr('密码错误或 DPAPI 不可用（换机/重装系统后 DPAPI 缓存无效，只能输入密码）。')
    report.errors.push(restore.error || `recovery-kit 退出码 ${restore.exitCode}`)
  } else {
    ctx.log('从子机仓库恢复完成。')
  }

  // 修 junction（与本地恢复同一套逻辑）
  const junctionPlan = await planJunctions({ home: ctx.home })
  const applied = await applyJunctions(junctionPlan, { runCommandFn: ctx.D.runCommand })
  report.junctions = {
    summary: junctionSummary(junctionPlan),
    results: applied.results,
    updated: applied.updated,
    failed: applied.failed,
    npmMissing: junctionPlan.npmMissing.map((item) => ({ profile: item.profile, name: item.name, spec: item.spec })),
    warnings: junctionPlan.warnings,
    nodeModulesMissing: junctionPlan.nodeModulesMissing,
  }
  if (applied.updated) ctx.log(`junction 已修复 ${applied.updated} 个。`)
  for (const item of applied.results) {
    if (item.action === 'created' || item.action === 'rebuilt') {
      ctx.log(`  [${item.action}] ${item.profile}/${item.name} -> ${item.target}`)
    } else if (item.action === 'conflict' || item.action === 'error' || item.error) {
      ctx.logErr(`  [${item.action}] ${item.profile}/${item.name}：${item.error}`)
    }
  }
  if (applied.failed) {
    if (exitCode === 0) exitCode = 3
    report.errors.push(`junction 修复失败 ${applied.failed} 项`)
  }

  if (exitCode === 0 && !args['no-start']) {
    const exe = typeof args.exe === 'string' && args.exe.trim() ? path.resolve(args.exe.trim()) : DEFAULT_DSH_EXE
    ctx.log('')
    ctx.log(`启动 DeepSeek Harness：${exe}`)
    const started = await ctx.D.startDsh(exe)
    report.start = { requested: true, started: Boolean(started && started.started), exe, error: started ? started.error : '启动函数未返回' }
    if (!report.start.started) ctx.logErr(`启动失败：${report.start.error}。请手动双击 DeepSeek Harness。`)
  }

  report.ok = exitCode === 0
  report.exitCode = exitCode
  report.finishedAt = ctx.D.now()
  report.durationMs = report.finishedAt - report.startedAt
  await finishAndWriteReport(ctx, report)
  ctx.log('')
  if (exitCode === 0) ctx.log('恢复成功。建议马上启动 DSH 检查会话/插件是否正常，并保留这次报告。')
  else ctx.logErr(`恢复未完全成功（退出码 ${exitCode}），详情见报告：${report.reportPath || '(报告写入失败)'}`)
  return exitCode
}

async function isNonEmptyDir(dir) {
  try {
    const entries = await fsp.readdir(dir)
    return entries.length > 0
  } catch {
    return false
  }
}

async function finishAndWriteReport(ctx, report) {
  if (ctx.args['dry-run']) {
    ctx.log('dry-run：不写报告、不改备份库。')
    return
  }
  try {
    const written = await writeReport({
      storeRoot: ctx.storeRoot,
      report,
      logText: ctx.lines.join(''),
    })
    ctx.log(`报告          : ${written.reportPath}`)
    ctx.log(`控制台日志    : ${written.logPath}`)
  } catch (error) {
    ctx.logErr(`写报告失败（不影响恢复结果）：${String((error && error.message) || error)}`)
  }
}

/* ═══════════════════════════════════════════════════════════ 入口 */

if (isMainModule()) {
  runConsole(process.argv.slice(2))
    .then((code) => { process.exitCode = Number.isInteger(code) ? code : 1 })
    .catch((error) => {
      process.stderr.write(`[console] 致命错误：${String((error && error.stack) || error)}\n`)
      process.exitCode = 1
    })
}
