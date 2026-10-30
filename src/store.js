/**
 * 内容寻址存储：同样的内容只存一份。
 *
 *   <root>/<host>/blobs/ab/cd/<sha256>
 *   <root>/<host>/snapshots/<id>.json     # 清单：{ rel: {h,s,m} }
 *
 * 清单是唯一的“哪份内容属于哪个文件”的权威；blobs 只按哈希存。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { entryChunks, exists, sha256hex, writeFileAtomic } from './util.js'

const ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,120}$/

export class BlobStore {
  constructor(dir) {
    this.dir = path.resolve(dir)
    this.blobDir = path.join(this.dir, 'blobs')
    this.snapDir = path.join(this.dir, 'snapshots')
    this.known = new Set()
  }

  async init() {
    await fsp.mkdir(this.blobDir, { recursive: true })
    await fsp.mkdir(this.snapDir, { recursive: true })
  }

  blobPath(hash) {
    const h = String(hash || '')
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`bad blob hash: ${h}`)
    return path.join(this.blobDir, h.slice(0, 2), h.slice(2, 4), h)
  }

  async has(hash) {
    if (this.known.has(hash)) return true
    const ok = await exists(this.blobPath(hash))
    if (ok) this.known.add(hash)
    return ok
  }

  /** 存入内容，返回哈希。已存在则不重复写。 */
  async put(buf) {
    const hash = sha256hex(buf)
    if (await this.has(hash)) return hash
    await writeFileAtomic(this.blobPath(hash), buf)
    this.known.add(hash)
    return hash
  }

  async get(hash) {
    return fsp.readFile(this.blobPath(hash))
  }

  async writeManifest(manifest) {
    const id = String(manifest && manifest.id ? manifest.id : '')
    if (!ID_PATTERN.test(id)) throw new Error(`bad snapshot id: ${id}`)
    const body = JSON.stringify(manifest)
    await writeFileAtomic(path.join(this.snapDir, `${id}.json`), Buffer.from(body, 'utf8'))
  }

  async readManifest(id) {
    if (!ID_PATTERN.test(String(id || ''))) throw new Error(`bad snapshot id: ${id}`)
    const file = path.join(this.snapDir, `${id}.json`)
    const raw = await fsp.readFile(file, 'utf8')
    const manifest = JSON.parse(raw)
    if (!manifest || manifest.id !== id) throw new Error(`snapshot ${id} is corrupt`)
    return manifest
  }

  async listManifests() {
    let names = []
    try { names = await fsp.readdir(this.snapDir) } catch { return [] }
    const out = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -5)
      if (!ID_PATTERN.test(id)) continue
      try {
        const manifest = await this.readManifest(id)
        out.push(manifest)
      } catch { /* 坏清单跳过，不阻塞其它快照 */ }
    }
    out.sort((a, b) => (b.at || 0) - (a.at || 0))
    return out
  }

  async deleteManifest(id) {
    if (!ID_PATTERN.test(String(id || ''))) throw new Error(`bad snapshot id: ${id}`)
    await fsp.rm(path.join(this.snapDir, `${id}.json`), { force: true })
  }

  /** 删除没有被任何清单引用的 blob。 */
  async gc(referenced) {
    const keep = referenced instanceof Set ? referenced : new Set(referenced || [])
    let removed = 0
    let removedBytes = 0
    let prefixes = []
    try { prefixes = await fsp.readdir(this.blobDir) } catch { return { removed, removedBytes } }
    for (const a of prefixes) {
      const dirA = path.join(this.blobDir, a)
      let subs = []
      try { subs = await fsp.readdir(dirA) } catch { continue }
      for (const b of subs) {
        const dirB = path.join(dirA, b)
        let names = []
        try { names = await fsp.readdir(dirB) } catch { continue }
        for (const name of names) {
          if (keep.has(name)) continue
          const abs = path.join(dirB, name)
          try {
            const stat = await fsp.stat(abs)
            await fsp.rm(abs, { force: true })
            removed += 1
            removedBytes += stat.size
            this.known.delete(name)
          } catch { /* ignore */ }
        }
        try { await fsp.rmdir(dirB) } catch { /* 非空或不存在 */ }
      }
      try { await fsp.rmdir(dirA) } catch { /* 非空或不存在 */ }
    }
    return { removed, removedBytes }
  }

  /** blob 总数与总字节（用于面板展示“占用空间”）。 */
  async stats() {
    let count = 0
    let bytes = 0
    let prefixes = []
    try { prefixes = await fsp.readdir(this.blobDir) } catch { return { count, bytes } }
    for (const a of prefixes) {
      let subs = []
      try { subs = await fsp.readdir(path.join(this.blobDir, a)) } catch { continue }
      for (const b of subs) {
        let names = []
        try { names = await fsp.readdir(path.join(this.blobDir, a, b)) } catch { continue }
        for (const name of names) {
          try {
            const stat = await fsp.stat(path.join(this.blobDir, a, b, name))
            count += 1
            bytes += stat.size
            this.known.add(name)
          } catch { /* ignore */ }
        }
      }
    }
    return { count, bytes }
  }

  /**
   * 完整性检查：清单里引用的内容块（含分块）是否都在。
   *
   * 0 字节文件是合法条目：`{s:0,m,c:[]}`（或老格式 `{s:0,m,h:''}`）没有内容块，
   * 不能当成“缺块”。只有 `s > 0` 却没有任何块时才算缺失。
   * 返回 `{ files, missing, emptyFiles }`：emptyFiles 是合法空文件数（调用方可忽略）。
   */
  async verify(manifest) {
    const missing = []
    let emptyFiles = 0
    const files = (manifest && manifest.files) || {}
    for (const [rel, entry] of Object.entries(files)) {
      const chunks = entryChunks(entry)
      if (!chunks.length) {
        if (entry && Number(entry.s) === 0) {
          emptyFiles += 1
          continue
        }
        missing.push(rel)
        continue
      }
      for (const hash of chunks) {
        if (!(await exists(this.blobPath(hash)))) { missing.push(rel); break }
      }
    }
    return { files: Object.keys(files).length, missing, emptyFiles }
  }
}
