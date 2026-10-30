import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BlobStore } from '../src/store.js'
import { sha256hex } from '../src/util.js'

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

test('blob store: put is content addressed and deduped', async () => {
  const dir = await tempDir('dbk-store-')
  const store = new BlobStore(dir)
  await store.init()

  const a = Buffer.from('hello')
  const b = Buffer.from('hello')
  const c = Buffer.from('world')

  const ha = await store.put(a)
  const hb = await store.put(b)
  const hc = await store.put(c)

  assert.equal(ha, hb)
  assert.notEqual(ha, hc)
  assert.equal(ha, sha256hex(a))
  assert.equal((await store.get(ha)).toString(), 'hello')

  const stats = await store.stats()
  assert.equal(stats.count, 2)
  assert.equal(stats.bytes, 10)

  // gc 只删没人引用的
  const removed = await store.gc(new Set([ha]))
  assert.equal(removed.removed, 1)
  const after = await store.stats()
  assert.equal(after.count, 1)
})

test('blob store: rejects path traversal shaped ids', async () => {
  const dir = await tempDir('dbk-store2-')
  const store = new BlobStore(dir)
  await store.init()
  await assert.rejects(() => store.readManifest('../../etc/passwd'), /bad snapshot id/)
  await assert.rejects(() => store.put(Buffer.alloc(0)).then(() => store.get('not-a-hash')), /bad blob hash/)
})

test('blob store: verify reports missing blobs', async () => {
  const dir = await tempDir('dbk-store3-')
  const store = new BlobStore(dir)
  await store.init()
  const hash = await store.put(Buffer.from('payload'))
  const manifest = { id: 'x', files: { 'a.txt': { h: hash, s: 7, m: 1 } } }
  assert.deepEqual((await store.verify(manifest)).missing, [])

  await fs.rm(store.blobPath(hash))
  const missing = (await store.verify(manifest)).missing
  assert.deepEqual(missing, ['a.txt'])
})

test('blob store: verify treats 0-byte entries as valid empty files', async () => {
  const dir = await tempDir('dbk-store4-')
  const store = new BlobStore(dir)
  await store.init()
  const hash = await store.put(Buffer.from('payload'))
  const result = await store.verify({
    id: 'x',
    files: {
      'empty-new.txt': { s: 0, m: 1, c: [] }, // 新格式：0 字节 + 空块列表
      'empty-legacy.txt': { s: 0, m: 1, h: '' }, // 老格式：h 为空字符串
      'real.txt': { s: 7, m: 1, c: [hash] },
    },
  })
  assert.deepEqual(result.missing, [], '0 字节文件不是缺块')
  assert.equal(result.files, 3)
  assert.equal(result.emptyFiles, 2, 'emptyFiles 统计合法空文件（可选字段，调用方可忽略）')

  // s > 0 却没有块：仍然算缺失
  const broken = await store.verify({ id: 'y', files: { 'broken.txt': { s: 5, m: 1, c: [] } } })
  assert.deepEqual(broken.missing, ['broken.txt'])
  assert.equal(broken.emptyFiles, 0)

  // 非空文件的块缺失照旧报
  await fs.rm(store.blobPath(hash))
  assert.deepEqual((await store.verify({ id: 'z', files: { 'real.txt': { s: 7, m: 1, c: [hash] } } })).missing, ['real.txt'])
})
