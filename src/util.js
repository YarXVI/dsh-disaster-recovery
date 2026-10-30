/**
 * 通用工具：路径、哈希、原子写、目录遍历、排除规则。
 * 不依赖 DSH，CLI 与 Host 插件共用。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export function sha256hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export async function exists(p) {
  try { await fsp.access(p); return true } catch { return false }
}

/** 把相对路径拼到 root 下，越界返回 null。 */
export function joinInside(root, rel) {
  const raw = String(rel == null ? '' : rel).replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('//')) return null
  const parts = raw.split('/').filter((p) => p && p !== '.' && p !== '..')
  if (!parts.length) return null
  const abs = path.resolve(root, ...parts)
  const base = path.resolve(root)
  return abs === base || abs.startsWith(base.endsWith(path.sep) ? base : base + path.sep) ? abs : null
}

/** 绝对路径转相对路径（正斜杠）；不在 root 下返回 null。 */
export function toRelative(root, abs) {
  const rel = path.relative(path.resolve(root), path.resolve(abs))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

/**
 * 排除规则：按路径段匹配（`dsh-runtimes` 排除任意层级的同名目录），
 * 含 `/` 的按前缀匹配，`*` 开头按后缀匹配。
 */
export function isExcluded(rel, excludes) {
  const norm = String(rel || '').replace(/\\/g, '/')
  const parts = norm.split('/')
  for (const raw of excludes || []) {
    const entry = String(raw || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!entry) continue
    if (entry.includes('/')) {
      if (norm === entry || norm.startsWith(entry + '/')) return true
      continue
    }
    if (entry.startsWith('*')) {
      if (parts.some((p) => p.endsWith(entry.slice(1)))) return true
      continue
    }
    if (parts.includes(entry)) return true
  }
  return false
}

/** 写盘时常见的临时/锁文件，没有备份价值。 */
export const VOLATILE_PATTERNS = ['*.lock', '*.tmp', '*.temp', '*.crdownload', '*.part', '~$*', '.DS_Store', 'Thumbs.db']

export function isVolatileName(name) {
  const lower = String(name || '').toLowerCase()
  return VOLATILE_PATTERNS.some((pattern) => {
    if (pattern.startsWith('*')) return lower.endsWith(pattern.slice(1).toLowerCase())
    return lower === pattern.toLowerCase()
  })
}

/** Windows 上 rename 可能被短暂占用，退避重试。 */
export async function writeFileAtomic(abs, buf) {
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.${process.pid}.${Date.now().toString(36)}.tmp`
  await fsp.writeFile(tmp, buf)
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(tmp, abs)
      return
    } catch (error) {
      const transient = error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY')
      if (!transient || attempt >= 7) {
        try { await fsp.rm(tmp, { force: true }) } catch { /* ignore */ }
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, 20 * 2 ** attempt)))
    }
  }
}

/**
 * 遍历目录，返回 [{ rel, abs, size, mtimeMs }]。跳过符号链接与排除项。
 * 单个文件超过 maxFileBytes 的记入 skipped（不备份，但会在结果里报告）。
 */
export async function walkFiles(root, { excludes = [], maxFileBytes = Infinity } = {}) {
  const out = []
  const skipped = []
  const rootAbs = path.resolve(root)
  const stack = ['']
  while (stack.length) {
    const relDir = stack.pop()
    const absDir = relDir ? path.join(rootAbs, ...relDir.split('/')) : rootAbs
    let entries
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (isExcluded(rel, excludes)) continue
      if (entry.isSymbolicLink()) continue
      const abs = path.join(absDir, entry.name)
      if (entry.isDirectory()) {
        stack.push(rel)
        continue
      }
      if (!entry.isFile()) continue
      if (isVolatileName(entry.name)) continue
      let stat
      try { stat = await fsp.stat(abs) } catch { continue }
      if (stat.size > maxFileBytes) {
        skipped.push({ rel, size: stat.size, reason: 'too-large' })
        continue
      }
      out.push({ rel, abs, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) })
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return { files: out, skipped }
}

export async function readJsonSafe(file, fallback = null) {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'))
}

/**
 * 清单条目的内容块列表。新条目是 `{ s, m, c: [hash…] }`；
 * 兼容 0.1.0 早期清单的整文件 `{ s, m, h }`。
 */
export function entryChunks(entry) {
  if (!entry) return []
  if (Array.isArray(entry.c)) return entry.c
  if (typeof entry.h === 'string' && entry.h) return [entry.h]
  return []
}

export function formatBytes(bytes) {  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1 }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}

/** 快照 id：本地时间 + 原因，字典序即时间序。 */
export function makeSnapshotId(date = new Date(), reason = 'auto') {
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  const tag = String(reason || 'auto').replace(/[^a-z0-9-]/gi, '').slice(0, 12) || 'auto'
  return `${stamp}-${tag}`
}
