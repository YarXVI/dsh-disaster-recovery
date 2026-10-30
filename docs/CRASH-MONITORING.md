# DSH 崩溃监控与一键恢复（设计 v1）

> 用户 2026-10-28 拍板：全范围监控（进程崩溃/断电、卡死、数据被删/损坏、备份/同步故障）；
> 装外部看门狗但**不自动重启**；通知饱和式（面板卡 + Windows 通知 + QQ + 子机 + 通用 API/邮件）；
> 手动确认的一键恢复；崩溃后**本地全量 + 异地交叉校验**。
> 额外要求：`.dsh` 整个被删也能从**外部桌面快捷方式一次恢复全部数据并启动 DSH**。

## 0. 现状（必须先修）

`%LOCALAPPDATA%\DeepSeek Recovery\` **不存在**，但桌面/开始菜单「Deepseek恢复」快捷方式仍指向
`...\scripts\recovery-console.ps1` → 现在点开是空的。旧的 `DSH-HomeTripwire.cmd` 启动项路径乱码
（`D:\???\_recovery\tripwire.ps1`），实际没运行；旧 tripwire 2 秒全树轮询，已停。

## 1. 目录与职责

### 外部恢复区（不在 .dsh，DSH 全没也能用）
`%LOCALAPPDATA%\DeepSeek Recovery\`：

```
recovery-console.ps1        # 快捷方式入口（保持该文件名/路径不变）
console.mjs                 # 独立恢复控制台（Node≥20，零依赖）
plugin\                     # 自包含的灾备 CLI 副本（scripts/cli.mjs + src/ + package.json）
monitor\watchdog.mjs        # 外部看门狗（计划任务每分钟 --once）
monitor\config.json         # 非密配置：storeRoot/home/host/阈值/通知目标
monitor\secrets.dpapi       # DPAPI(CurrentUser) 保护的 SMTP 密码/webhook token 等
monitor\state.json          # 上次检查、事件日志游标、进程状态
monitor\watchdog.log
monitor\toast.ps1           # Windows 通知（WinRT，失败退 msg）
notify.ps1                  # 邮件/通知辅助（Send-MailMessage）
version.json
```

### 监控数据（跟随备份盘，跑在 .dsh 外）
`<storeRoot>\<host>\monitor\`：

```
heartbeat.json              # 插件每 5s 原子覆盖
heartbeat.log               # 追加，30s 一条，5MB 轮转
baseline.json               # 上次健康时各目录文件数/字节
incidents\<id>.json         # 事故记录（见 §4）
alerts\current.json         # 最新未关闭事故摘要（面板读）
alerts\ack.json             # 已读/关闭标记
outbox\<id>.json            # 待外发通知（DSH 不在时排队）
watchdog-state.json
watchdog.log
```

### 插件内
`src/monitor.js`（新）：心跳、启动时“上一轮是否干净退出”检测、数据基线对比、备份健康检查、
事故记录/通知 outbox。`src/plugin.js` 装配；`src/panel.js` 增加 monitor-* action；
`client.js` 增加「事故与监控」卡（有未关闭事故时置顶红条）。

## 2. 心跳（插件 → 监控数据）

每 5s 原子写 `heartbeat.json`；正常退出在 dispose 写 `cleanExit:true, cleanExitAt`。

```json
{ "v":1, "bootId":"<random>", "pid":123, "startedAt":0, "lastSeen":0,
  "cleanExit":false, "cleanExitAt":0, "version":"0.4.0",
  "host":{"name":"LAPTOP-...","home":"C:\\Users\\shens\\.dsh","root":"D:\\dsh-backup"},
  "stats":{"files":8204,"bytes":521000000,"sessions":7,"storages":2,"profiles":1,
           "attachments":491,"credentials":true},
  "backup":{"snapshots":99,"latestId":"...","latestAt":0,"lastSnapshotAt":0,"lastError":null},
  "offsite":{"configured":false,"locked":true,"lastExportAt":0,"lastSyncAt":0,"peerOnline":false,"archives":0},
  "client":{"lastSeen":0},
  "lastAction":{"type":"snapshot","at":0}
}
```

`client.lastSeen`：面板页面每 10s 调一次轻量 `monitor-ping`，Host 记录；用于发现「进程在、界面卡死」。

## 3. 外部看门狗（每分钟一次）

计划任务 `DSH-DisasterWatchdog`（用户级，`wscript.exe //nologo monitor\run-hidden.vbs` 隐藏运行
`watchdog.mjs --once`，不弹控制台；无需管理员）。
单实例锁；单次运行 <5s（全树 stat 约 0.5s，事件日志查询 <1s）。每次：

1. 读心跳、state、baseline；
2. 检测进程：任意 `DeepSeek Harness.exe`（记录主 pid/启动时间）；
3. 分类判定（去重：同 kind 30 分钟内合并 timeline，不重复刷屏）：
   - **crash**：进程不存在 + `lastSeen` 距今 >120s + `cleanExit!=true` + 之前处于运行态；
     崩溃时间区间 = `[lastSeen, lastSeen+5s]`；查事件日志（Application 1000/1001/1002、
     System 41/6008/1074；排除睡眠 42/107）补证据；
   - **hang**：进程存在 + `lastSeen` >180s（且非睡眠）→「Host 卡死/无响应」；
   - **data-loss**：相对 baseline 文件数下降 >max(50,5%)、sessions 减少、profiles/storages/
     `.credentials.yaml` 消失 → 高严重度；记录当前进程命令行快照（仅写本地，不入通知）；
   - **backup-corrupt**：本地快照清单不可读 / `verify` 出现 missing blobs / 仓库不可写；
   - **offsite-stale**：已启用但 >48h 未导出/未同步、或子机仓库清单与 ledger 不一致；
   - **disk-low**：D: 剩余 <10 GiB；
4. 写事故 + `alerts/current.json` + `outbox`；**立即**发 Windows 通知、webhook、邮件；
   QQ/子机通知写 outbox 等 DSH 起来补发（或 OneBot HTTP 直发，若已配置）；
5. 更新 baseline（仅当无 data-loss/backup-corrupt 且心跳健康，且 24h 最多一次）；
6. 维护：事故/日志保留 90 天，日志轮转 10MB。

睡眠/关机抑制：System 1074（正常关机）、42/107（睡眠/恢复）窗口内不判 crash。

## 4. 事故记录

```json
{ "id":"20261028-...-crash", "kind":"crash", "status":"open",
  "detectedAt":0, "firstAt":0, "lastAt":0, "recoveredAt":0,
  "summary":"DSH 于 15:32:10 异常退出，15:33:02 重新启动",
  "severity":"high",
  "timeline":[{"at":0,"type":"last-heartbeat","detail":"..."}, {"at":0,"type":"event-log","detail":"Application Error 1000 ..."}, {"at":0,"type":"restart","detail":"pid ..."}],
  "evidence":{"heartbeat":{"lastSeen":0,"gapMs":0,"bootId":"..."},
              "process":{"pid":0,"startedAt":0,"alive":false},
              "events":[{"time":0,"id":1000,"provider":"Application Error","message":"..."}],
              "data":{"before":{},"after":{},"delta":{}},
              "backup":{"local":{"checked":99,"bad":[]},"offsite":{"checked":0,"bad":[]}}},
  "impact":{"snapshots":[{"id":"...","at":0,"status":"ok|corrupt|missing-blobs|suspect"}],
            "offsite":{"checked":0,"bad":[]},
            "affectedPaths":["sessions/..."]},
  "recommendation":{"snapshotId":"...","at":0,"reason":"崩溃前最后一份已验证快照","verified":true},
  "recovery":{"status":"none|restored","restoredAt":0,"quarantine":"...","report":"..."} }
```

**受影响备份的判定**：
- 本地：读全部 manifest（秒级），逐份检查引用的块是否存在；事故窗口内（lastSeen 前 5 分钟到
  恢复启动）产生的快照标 `suspect`；清单不可读/缺块标 `corrupt`；
- 异地：读子机仓库清单/pack 索引（DSH 在时走 dsh-sync；不在时只做文件级检查），
  与本地 ledger 交叉；解密级校验由面板解锁后做；
- 推荐恢复点：`at <= lastSeen` 的最后一份 `status=ok` 快照；没有则更早。

## 5. 通知（饱和式，无短路）

统一 `notify(incident)`：所有已启用通道并行发，单通道失败只记结果，不影响其它通道。
通道：`panel`（alerts/current.json）、`toast`（Windows 通知）、`webhook`（POST JSON，可多个）、
`email`（SMTP，PowerShell Send-MailMessage）、`qq`（OneBot HTTP 或 outbox 等插件）、
`peer`（outbox，DSH 起来后经 dsh-sync 推子机）。配置放 `monitor/config.json`（非密）+
`secrets.dpapi`（SMTP 密码/webhook token）。面板提供「测试所有通道」。
通知正文只含：主机名、事故类型、时间、推荐恢复点、快照数；**不含文件内容、密码、路径明细**。

## 6. 面板「事故与监控」卡

- 顶部红条（有 open 事故时）：`检测到 DSH 在 <时间> 异常退出；已恢复到 <时间>；推荐恢复到 <快照时间>`；
- 按钮：`一键恢复（推荐快照）`、`查看时间线/受影响备份`、`重新体检`、`忽略`、`安装/修复外部看门狗`；
- 无事故时折叠显示：看门狗状态、最近心跳、上次体检、通知通道配置状态；
- 一键恢复走现有 restore（pre-restore + quarantine + 重启提示），恢复后事故标 `recovered`。

## 7. 外部一键恢复控制台（极端情况）

入口保持 `%LOCALAPPDATA%\DeepSeek Recovery\recovery-console.ps1`（快捷方式已指向它）。流程：

1. 检测 DSH 进程；在运行则提示先完全退出（或 `--force` 仅限用户确认）。
2. 定位 storeRoot（config / `D:\dsh-backup` / 提示输入），列出快照（最近 10 + 总数）；
3. 推荐恢复点：监控事故的 `recommendation` → 否则最新一份 `verify` 通过（缺块=0）的快照；
4. 显示「将恢复 N 文件 / 覆盖 M 文件 / 当前 .dsh 是否存在」，要求输入 `YES`；
5. 调用自带副本 `plugin\scripts\cli.mjs restore <id> --home <home> --yes`（DSH 停止状态）；
6. 修复 `profiles\<p>\node_modules` 下 `link:` 依赖的 junction（从 profile package.json 重建），
   校验每个插件 `package.json` 可读；
7. 写 `D:\dsh-backup\manual\<ts>-external-restore\report.json`，可选启动
   `D:\DeepSeek\DeepSeek Harness.exe`（默认启动，可 --no-start）；
8. 本地仓库不可用/损坏：提示输入子机仓库目录（U 盘/UNC）→ 用其 `recovery-kit/recover.mjs
   restore` → 同样修 junction → 启动；
9. `--auto`：无交互走推荐点（仍要求输入 YES 防误触，除非 `--yes`）。

外部目录由 `scripts/install-external.ps1` 生成/更新（安装插件、部署后调用），并把旧
`DSH-HomeTripwire.cmd` 启动项备份到 `D:\dsh-backup\manual` 后替换为看门狗安装。

## 8. 验收

1. 杀掉 DSH 进程（或临时 home 模拟）：1 分钟内 watchdog 记 crash，时间区间含 lastSeen；
   Windows 通知 + webhook 测试服务器收到；面板红条显示。
2. `.dsh` 移到别处（模拟全丢）：外部快捷方式列出快照 → 恢复到临时 home → 文件数/manifest
   sha256 一致、profile junction 重建、可启动 DSH（沙箱验证不启动真实 GUI）。
3. 数据骤降（临时 home 删 100 文件）：data-loss 事故，推荐恢复点为骤降前快照。
4. 睡眠/正常关机不误报；DSH 正常退出不误报。
5. 备份坏块（临时仓库删一个 blob）：backup-corrupt，报告具体缺块快照/文件。
6. 通知通道逐个禁用/失败不影响其它通道；重试与 outbox 补发正确。
7. 旧 tripwire 启动项已备份并替换；外部目录自愈（删除后插件启动/安装脚本能重建）。
