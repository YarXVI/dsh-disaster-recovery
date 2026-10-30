# 设计说明

## 问题

2026-10-26 凌晨，一次清理动作把 `C:\Users\shens\.dsh` 的用户态删掉了（会话 100 个、
`workspace.json`、凭据、profile 插件），而 DSH 以内存态为准、照常运行了 9 小时，
直到重启才暴露。事后能救回来，靠的是对端机器上的一份同步副本 —— 这次要把这条后路做成默认。

## 目标

1. **实时**：文件变化几秒内就有一份可恢复的版本，而不是每天一次。
2. **不碍事**：快照便宜（stat 遍历 + 只读变化的文件），不占 IO、不涨磁盘。
3. **一定能救**：DSH 完全起不来时，也能用双击脚本恢复。

## 为什么是「分块内容寻址 + 清单」

会话日志是追加写的（`session.v4.jsonl.zstd` 每次追加一整帧）。如果按整文件哈希存 blob：

- 每次追加都会让整份日志变成一份新内容 → 每 10 秒重存一次 2.3 MB，一小时 800 MB；
- 实测第一版就是这样：十几分钟写了 18 个快照，磁盘肉眼可见地掉。

所以按 `chunkSize`（默认 64 KiB）把文件切块，每块单独寻址：

- 追加只改最后一个（未写满的）块，前面的块哈希不变 → 每次快照只新增「尾巴」；
- 块在**所有快照、所有文件之间**共享，同样的内容永远只存一份；
- 清单条目是 `{ s, m, c: [块哈希…] }`，`c` 顺序拼接就是文件内容；
- 早期整文件 `{ s, m, h }` 清单仍可读（`entryChunks()` 兼容），不需要迁移。

代价是清单变大（80 MB 日志 ≈ 1280 个哈希 ≈ 80 KB），相比省下的内容完全值得。

## 快照的成本

每次快照遍历一遍 `DSH_HOME`（实测 1156 个文件），对每个文件只做 `stat`：

- `size` 与 `mtimeMs` 都没变 → 直接沿用上次的块列表，不读内容；
- 变了 → 读一次、按块算哈希、缺块才写。

所以「没有变化」的快照只花一次目录遍历（毫秒级）；发生变化的快照只花变化部分的 IO。
首次全量 110 MB / 1156 文件耗时约 2.5 秒。

## 演练暴露的两个 bug（已修）

1. **`restore latest` 会把"事故现场"当成最新快照。**
   CLI 启动引擎时默认会拍一张 `startup` 快照；于是事故后跑恢复，先拍下损坏状态，
   再"恢复最新"= 恢复损坏状态，等于什么都没做。
   修法：`snapshotOnStart` 只对 `backup` 开启；`latest` 解析时跳过 `pre-restore`。
2. **追加型日志被整份重存。** 见上一节：改成分块后单次快照只新增尾块，
   测试 `append-only logs only store their new tail chunk` 锁住这个行为。

## 触发

| 触发 | 说明 |
|---|---|
| `fs.watch(recursive)` | Windows 下可用；事件只置脏标记，`debounceMs` 后合并成一次快照 |
| `scanMs` 轮询 | 兜底：watch 漏事件（网络盘、事件溢出）时仍能发现变化 |
| 面板 / CLI | 手动 |

两次快照之间有 `minIntervalMs` 下限，避免高频写入把磁盘打满；快照进行中再来的变化
会在结束后补一次（`pendingAgain`）。

## 恢复的语义

1. 先对**当前**状态做一次 `pre-restore` 快照（除非显式跳过）——恢复本身也可回退；
2. 逐文件：内容相同跳过；不同则把旧内容复制到 `restore-quarantine/<id>/<rel>`，再原子写入 blob；
3. 快照里没有、当前存在的文件：**保留**，只在报告里给数量（不做删除，避免"恢复"变"清理"）；
4. 清单缺 blob → 直接拒绝，不写半份数据；
5. 返回 `needRestart: true`：DSH 的内存态会覆盖磁盘，必须重启。

## 边界与取舍

- **备份目录必须在 home 之外**：这是唯一能对抗"home 被清空"的布局。
- **排除 `dsh-runtimes`**：几百 MB、可按需重装，备份它性价比太低。
- **不备份安装目录**：`D:\DeepSeek` 重装即可，且体积大。
- **单文件上限 128 MB**：防止一个巨大的临时文件把库撑爆；超限记入清单的 `skipped`。
- **只允许回环访问面板**：与 `dsh-sync` 的做法一致，避免同网段误操作。
- **保留策略是"多层"而非"最后一层"**：最近 60 个全留；48 小时内每小时一个；
  30 天内每天一个。删完清单后按引用集回收 blob。

## 数据布局

```
<root>/<host>/blobs/ab/cd/<sha256>
<root>/<host>/snapshots/<id>.json
<root>/<host>/restore-quarantine/<id>/...
<root>/<host>/config.json
```

`<host>` 用主机名，多台机器共用一个备份盘时互不覆盖。

## 测试

`test/` 用 `node --test` 覆盖：内容去重、路径穿越拒绝、缺失 blob 检测、
排除项、不变则跳过、恢复（含隔离目录、保留额外文件、pre-restore）、
保留策略 + blob 回收、重启后状态恢复。

## 异地加密副本（0.4.0）

本机快照仍然在 `D:\dsh-backup`（同机同盘），所以 0.4.0 增加「异地」这条腿：
每天把一份**已验证**的快照加密、块级去重后同步到子机，子机只存密文。

- 选择「去重仓库」而不是「每天一份独立全量」：内容块按 keyed-HMAC 名字寻址，
  跨快照/跨天共享；首次导出约 200–400 MB，之后每天通常只新增几 MB。
- 加密：密码 → scrypt（N=2^17）→ 32B masterKey；块/清单/包各自 AES-256-GCM，
  随机 nonce + AAD 绑定随机名。仓库里没有明文文件名、路径、密码或密钥。
- 子机：dsh-sync 新增受限 `ext.dr.repo.*` 暂存 op（配对设备专用、白名单、不覆盖、配额），
  存储在 C 盘随机伪装目录；子机不解密、不接触密码。
- 恢复：面板输入密码 → 校验哈希链 → 从子机按需取块 → 解密校验 → 走原有
  `pre-restore + restore-quarantine` 语义写回；换机/整机损坏时可用仓库自带的
  `recovery-kit/`（零依赖 Node）离线恢复。
- 风险与边界：同屋两台机器可能一起没（建议再加离线盘）；密码丢失不可恢复；
  子机可删档/回滚，靠本地 ledger + 哈希链检测；DPAPI 密钥缓存仅当前用户可解，
  换机后必须用恢复密码。详见 `docs/OFFSITE-ARCHIVE.md`。

## 崩溃监控与一键恢复（0.5.0）

- **黑匣子**：插件每 5 秒写 `heartbeat.json`（pid、启动时间、快照数、数据统计、异地状态）到
  `<store>/<host>/monitor/`；正常退出写 `cleanExit`；下次启动对比上一轮心跳，断档且未写
  cleanExit → 生成 crash 事故并估算崩溃区间。
- **快速异常检测**：心跳 tick 内每 5 秒只读 sessions 目录 + 3 个关键文件（workspace/profile/
  credentials），会话骤降/归零或关键文件消失立即判“变全新客户端”；新快照出现时对比最近两份
  manifest，changed+deleted 超过 max(200,15%) 判 mass-change（覆写/大量变更）。
- **事故自动保护**：data-loss/mass-change 成立即 `engine.setPaused(true)` + pin 推荐快照，
  防止空/坏状态快照挤出好恢复点；ack/恢复后还原事故前的暂停状态，pin 保留。
- **外部看门狗**：`%LOCALAPPDATA%\DeepSeek Recovery\monitor\watchdog.mjs`，用户级计划任务每分钟
  运行一次；检测 crash/hang/data-loss/backup-corrupt/offsite-stale/disk-low；事件日志
  （Application Error/WER、System 异常关机）作证据，睡眠/正常关机抑制；事故写
  `monitor/incidents/*.json`、`alerts/current.json`、`outbox/*.json`，通知饱和式 fan-out
  （面板/Windows 通知/Webhook/邮件/QQ/子机），单通道失败不影响其它。
- **面板事故卡**：红条 + 时间线 + 受影响备份/推荐恢复点；一键恢复走现有 engine.restore
  （pre-restore + quarantine），不自动重启 DSH。
- **外部一键恢复控制台**：`%LOCALAPPDATA%\DeepSeek Recovery\scripts\console.mjs`（桌面快捷方式
  入口）。DSH 完全起不来/.dsh 被删时，恢复全部数据 → 修复 profile junction → 启动 DSH；
  本地库损坏可改用子机仓库的 `recovery-kit`。外部目录由 `scripts/install-external.ps1` 生成，
  可重复执行修复；旧 tripwire 启动项会先备份再替换。
- 详见 `docs/CRASH-MONITORING.md`。
