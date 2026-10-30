# 异地加密副本（去重仓库）— 设计定稿 v1

> 2026-10-28 与用户确认的决策：
> - 密码：**≥9 位、必须数字+字母混合、长度不设上限**（≥256 也接受）；忘记密码 = 数据不可读，无后门。
> - 子机只暂存：密文存 **C 盘**、目录名伪装；密码/明文**永不发往子机**。
> - 两机联通 + 凭证匹配（dsh-sync 已配对）后，本机灾备面板出现「异地副本」；在本机输入密码后
>   才能看到档案列表并一键恢复（LAN 直取，不需要先完整拷回）。
> - 传输与存储用**块级去重仓库**，不是每天一份独立全量档案。
> - 允许修改 dsh-sync：只新增受限的 `ext.dr.repo.*` 暂存 op，不动现有同步语义。
> - 未特别指定的项按推荐默认：每日 04:00 计划任务、逐块 sha256、每周一次真恢复演练、
>   导出 sessions/storages/profiles/attachments 全部（照旧排除 `dsh-runtimes`）。

## 1. 威胁模型

保护目标（按优先级）：
1. 本机磁盘/整机损坏、`.dsh` 被误删、勒索软件：子机有异地密文副本。
2. 子机磁盘被偷/被翻：只能拿到密文，且看不到文件名、路径、快照数量之外的元数据。
3. 传输链路被嗅探：dsh-sync 通道本身是 X25519+AES-GCM 信封，仓库内容再套一层静态加密。
4. 子机管理员删档/回滚：源端 ledger + 哈希链检测缺档/断链并在恢复前告警。

不防：本机被完全控制（DPAPI 缓存可被同用户解开）、用户忘记密码、两台机器同时被物理破坏。
建议用户再加一份离线盘（3-2-1），文档里明确写。

## 2. 仓库格式 v1

本地暂存仓库目录（在 DSH_HOME 之外）：
`<storeDir>/offsite/repo/`，ledger 在 `<storeDir>/offsite/ledger.json`。

```
repo/
  repo.json                         # 明文头：format/version/repoId/createdAt/kdf/cipher/chunkSize
  chunks/<a>/<b>/<name>.cbin        # name = HMAC-SHA256(masterKey, "chunk:"+plainHash) 的 hex（64）
  manifests/<name>.mbin             # name = HMAC-SHA256(masterKey, "manifest:"+snapshotId) 的 hex
  packs/<name>.pbin                 # 上传/下发用的打包文件（name = HMAC-SHA256(masterKey,"pack:"+packId)）
  recovery-kit/                     # 不加密的恢复工具（不含任何密钥）：recover.mjs + 说明
```

`repo.json`：
```json
{ "format": "dsh-dr-repo", "version": 1, "repoId": "<hex16>", "createdAt": 1793...,
  "kdf": { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<base64 16B>" },
  "cipher": "aes-256-gcm", "chunkSize": 65536 }
```

密钥推导：`masterKey = scrypt(password(NFKC), salt, 32, {N,r,p,maxmem:512MB})`。
密码只存在本机内存/DPAPI 缓存，**绝不写入仓库、日志、面板响应、RPC payload**。

- 块加密：`key = HMAC-SHA256(masterKey, "chunkkey:"+plainHash)`；`nonce = random 12B`；
  文件 = `"DRA1"(4) | nonce(12) | AES-256-GCM(ciphertext) | tag(16)`；`AAD = name`。
  解密后再校验 `sha256(plaintext) === plainHash`，不符即整档拒绝。
- 清单加密：同上，`magic "DRM1"`，`AAD = manifestName`。明文 JSON：
  ```json
  { "version": 1, "snapshot": { "id": "...", "at": 123, "reason": "change",
      "chunkSize": 65536, "stats": { "files": 1850, "bytes": 123 },
      "files": { "rel/path": { "s": 123, "m": 123, "c": ["<plainHash>", ...] } } },
    "exportedAt": 123, "prevManifest": "<name|null>", "seq": 7 }
  ```
  `prevManifest/seq` 构成哈希链，恢复工具检测断链。
- 打包文件（只用于跨机传输，不改变逻辑存储）：
  `"DRP1"(4) | nonce(12) | AES-256-GCM( JSON header + 拼接的 chunk 记录 ) | tag`，
  明文 = `{version, packId, entries:[{name, size, sha256}], ...}` + 记录体。`AAD = packName`。
  单 pack 目标 4 MiB（≤ 8MB RPC 响应/1MB 请求限制），上传按 512 KiB 切片。

去重：同一 `plainHash` 在仓库里只存一份；跨快照共享。清单不参与去重。
（`name` 是 keyed HMAC，子机看到的是随机名，不能从密文反推路径/文件名。）

## 3. 与 dsh-sync 的暂存协议（peer 只存）

dsh-sync 新增服务端 op（`registerRpc(op, handler, { allow: true })`），存储根由**子机自己**生成并持久化：
`$DSH_HOME/dsh-sync/archive.json { dir: "%LOCALAPPDATA%\\<16hex>" }`，目录首次使用时创建（伪装名随机，
不设隐藏属性；文件名随机，不出现日期/快照 id）。只做「文件柜」，不解密、不解释内容：

| op | payload | 返回 |
|---|---|---|
| `ext.dr.repo.info` | — | `{format, version, quotaBytes, usedBytes, count}` |
| `ext.dr.repo.putBegin` | `{name, size, sha256}` | `{uploadId}`（同 size+sha 已存在则 `{exists:true,name}`） |
| `ext.dr.repo.putChunk` | `{uploadId, index, dataBase64<=512KiB}` | `{received}` |
| `ext.dr.repo.putCommit` | `{uploadId}` | `{name, size, sha256}`（原子 rename，永不覆盖） |
| `ext.dr.repo.putAbort` | `{uploadId}` | `{ok}` |
| `ext.dr.repo.list` | `{cursor?, limit<=500}` | `{names:[{name,size}], cursor}` |
| `ext.dr.repo.get` | `{name, offset=0, length<=4MiB}` | `{name,size,offset,dataBase64}` |
| `ext.dr.repo.delete` | `{names:[...<=200]}` | `{deleted:[...], missing:[...]}` |

约束：
- name 白名单正则：`^(chunks/[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64}\.cbin|manifests/[0-9a-f]{64}\.mbin|packs/[0-9a-f]{64}\.pbin|repo\.json|recovery-kit/[A-Za-z0-9._/-]{1,120})$`；
  解析后必须 `path.resolve` 仍在 archive 根内。
- 配额默认 20 GiB；`putCommit` 超配额返回 `quota-exceeded`。
- 不覆盖同名文件（`putBegin` 返回 exists）。
- 只接受**已配对设备**（dshSync 传输层保证）；审计日志只记 op/name 长度/字节数，不记内容。
- `get`/`list`/`delete` 只由 `ext.dr.repo.*` 自身提供，不开放目录遍历。

源端（DR 插件）通过 `ctx.dshSync.rpc(peerId, 'ext.dr.repo.*', payload, { timeoutMs })` 调用。
请求上限 1MB / 响应 8MB：单次 `get` ≤4MiB、`putChunk` ≤512KiB、`list` 分页。

## 4. 本地仓库 / 导出 / 恢复

- **导出**（`offsite-export`）：选 latest 已验证快照 → `engine.pinSnapshot(id)`（prune 不得删）→
  逐块：`engine.store.get(hash)` → 校验 sha256 → 仓库已有同名块则跳过，否则加密落盘 →
  写清单 → 写 ledger（seq/prevManifest/文件数/字节/块数）→ 更新 pack 索引 → 释放 pin。
  首次导出会写全部块（~350MB），之后每天只写新增块（通常几 MB）。
- **同步到子机**（`offsite-sync`）：对比子机 `list` 清单，把缺失的 chunks/manifests 打成 4MiB pack，
  经 `putBegin/putChunk/putCommit` 上传；记录回执（sha256）。保留策略在源端计算：
  保留最近 `retainDaily` 份每日 + `retainWeekly` 份每周清单；被淘汰清单引用的块若不再被任何
  保留清单引用 → 从子机 `delete` 并删本地仓库副本。ledger 记录哈希链。
- **恢复**（`offsite-restore`）：本机输入密码解锁（DPAPI 缓存或手输）→ 解密清单并校验哈希链 →
  从子机按需取 pack/块（LAN 直取；缺失块本地有则用本地）→ 校验并写入本地 BlobStore →
  `engine.importSnapshot(manifest)` → `engine.restore(id)`（沿用 pre-restore / quarantine 语义）→
  提示重启 DSH。
- **演练**（`offsite-drill`）：同上但恢复到临时目录（临时 engine，`home=temp`），逐文件比对
  sha256；不动真实 home。默认每周自动跑一次并记录结果到 ledger。
- **恢复工具**：`recovery-kit/recover.mjs`（单文件、零依赖、Node≥20）可对仓库目录离线操作：
  `list / verify / export-home <dir> / restore <dir>`；子机可以完全不装 DSH 也能被人工拷回。

## 5. 配置（DR 插件，cordis.patch.yml + 运行期 config.json）

```yaml
offsite:
  enabled: true
  dir: ''                 # 空 = <root>/<host>/offsite
  peerDeviceId: ''        # 空 = 第一个已配对在线设备
  retainDaily: 7
  retainWeekly: 4
  quotaBytes: 21474836480
  schedule: '04:00'       # 本地时间；空 = 不自动导出（面板生成的计划任务见下）
  weeklyDrill: true
```
密码不在此配置里。无人值守导出用 DPAPI 缓存：
`<storeDir>/offsite/key.dpapi`（Windows DPAPI，仅当前用户可解；由 `scripts/dpapi.ps1` 帮助 Node 调用）。
面板提供「清除本机密钥缓存」。

## 6. 引擎改动

- `pinSnapshot(id)` / `unpinSnapshot(id)`：导出期间保护快照；prune 永不删 pinned。
- `importSnapshot(manifest)`：恢复时把解密出的清单注册进内存/磁盘（不触发 prune）。
- `store` 不变；`state.config.offsite` 暴露只读摘要；`state.offsite` 暴露进度/错误。

## 7. 安全红线

- 密码 / masterKey 只在本机；RPC payload 永不包含密码、明文、文件名、路径。
- 子机看到的最小元数据：随机文件名、文件大小、修改时间；`repo.json` 只含 format/version/repoId/盐/KDF 参数。
- 日志/面板错误信息不得包含密码或明文内容；最多包含「块名长度/失败原因」。
- 删除只允许 archive 根内、由已配对设备发起、按白名单 name；配额超限直接拒绝。
- DPAPI 缓存是便利性功能，默认开启但可关闭；面板醒目提示「换机/重装系统后必须用恢复密码」。

## 8. 验收清单

1. 密码：≥9 且必须字母+数字；`abcdefgh`/`123456789` 被拒；超长（≥256）可正常导出/恢复。
2. 错误密码：解锁失败且不泄露任何清单/元数据。
3. 篡改任意块/清单/包 1 字节：verify/restore 明确报错，不写真实 home。
4. 去重：同快照导出两次 → 第二次新增块数 0；改一个文件后导出 → 只新增该文件相关块。
5. pin：导出时并发 prune/新快照不会删掉正在导出的块。
6. 演练：临时目录恢复后与清单逐文件 sha256 一致。
7. 子机 op：路径穿越/超配额/覆盖同名/未配对/超大 payload 全部拒绝。
8. 拆除：删除本机仓库/缓存后，仅凭子机密文 + 恢复密码 + recovery-kit 能恢复（在临时 home 验证）。
9. 失败恢复：子机缺 pack（人为删）→ 提示具体缺失文件名，不部分恢复。
10. 无人值守：进程内调度（DSH 运行时）完成「导出 + 同步子机」；DSH 未运行时 schtasks/CLI
    只做本地兜底导出（拿不到 dshSync，明确标记 localOnly，不假装已同步子机）；未缓存密钥时
    明确报错；同一时刻只有一个 ledger 写者。
