Deepseek 恢复 · 外部一键恢复控制台（recovery-console）
============================================================

.dsh 整个被删、DSH 起不来、插件面板打不开时，用这个目录里的东西从灾备快照
把数据恢复回来，并启动 DeepSeek Harness。它不依赖 DSH 能运行，只依赖 Node.js。

本目录最终会被安装器复制到：
  %LOCALAPPDATA%\DeepSeek Recovery\scripts\
    recovery-console.ps1    ← 双击/快捷方式入口（文件名、路径保持不变）
    console.mjs             ← 控制台主逻辑（Node >= 20，零第三方依赖）
    README.txt              ← 本说明

自包含的灾备 CLI 副本在：
  %LOCALAPPDATA%\DeepSeek Recovery\plugin\
    scripts\cli.mjs         ← 恢复用（本控制台会自动找到）
    scripts\recover.mjs     ← recovery-kit 恢复工具（本机仓库不可用时的退路）
    src\...                 ← 备份引擎/内容寻址存储
    package.json

快捷方式（桌面 / 开始菜单「Deepseek恢复」）：
  目标：powershell.exe -NoProfile -ExecutionPolicy Bypass -File "...\scripts\recovery-console.ps1"
  如果快捷方式丢了，重新运行一次安装器 scripts\install-external.ps1 -Apply。


一、最常用：点开就恢复
----------------------
1. 先把 DeepSeek Harness 完全退出（托盘图标 → 退出）。它还在运行时控制台会拒绝，
   因为运行中的 DSH 会把内存态写回磁盘，覆盖刚恢复的数据。
2. 双击桌面「Deepseek恢复」（或开始菜单同名项）。
3. 控制台会显示：
   - 数据目录（默认 %USERPROFILE%\.dsh）
   - 备份库（默认 D:\dsh-backup）
   - 快照列表（最近 10 份 + 总数）
   - 推荐恢复点：监控事故（monitor\incidents\*.json）推荐的快照；没有事故推荐时，
     用最新一份「逐块校验缺块=0」的快照
   - 恢复计划：快照 id/时间、文件数、当前 .dsh 是否存在/多少文件、将新建/覆盖/未变多少
4. 确认无误后输入大写的 YES 回车。输入编号（1-10）可以改选其它快照，输入 c 取消。
5. 控制台调用自包含 CLI 执行恢复（被覆盖的旧文件会先放进备份库的
   restore-quarantine\<时间戳>\，不会丢），然后重建 profiles\<p>\node_modules
   下 link: 依赖的 junction，最后默认启动 D:\DeepSeek\DeepSeek Harness.exe。
6. 报告写到：
   D:\dsh-backup\manual\<时间戳>-external-restore\
     report.json      ← 快照、恢复统计、junction 列表、结果、日志路径（机器可读）
     console.log      ← 本次控制台的全部输出（给人看/取证）


二、命令行用法（可选）
----------------------
双击入口本质上是：

  powershell -NoProfile -ExecutionPolicy Bypass -File recovery-console.ps1 [参数]

也可以直接跑：

  node console.mjs [参数]

常用参数：
  --home <dir>         DSH 数据目录（默认 $env:DSH_HOME 或 %USERPROFILE%\.dsh）
  --store <dir>        备份库根目录（默认读 monitor\config.json 的 storeRoot，
                       再退到 D:\dsh-backup；也认 --root）
  --host <name>        备份库下有多个主机目录时直接指定（如 LAPTOP-XXXX）
  --snapshot <id>      指定快照（默认按推荐点自动选）
  --yes                跳过输入 YES（--auto 仍需 YES，除非同时给 --yes）
  --auto               非交互：自动选推荐点/主机（仍要求 YES 防误触，除非 --yes）
  --force              DSH 进程在运行时，经输入 CONTINUE 明确确认后继续（默认拒绝）
  --no-start           恢复成功后不启动 DSH（只恢复数据）
  --dry-run            只校验 + 打印计划 + junction 计划，不做任何修改
  --list               只列备份库/主机/快照/推荐点
  --verify             只校验快照完整性（缺块/坏清单），PASS/FAIL 逐份列出
  --exe <path>         恢复后启动的程序（默认 D:\DeepSeek\DeepSeek Harness.exe）
  --config <file>      监控配置（默认 %LOCALAPPDATA%\DeepSeek Recovery\monitor\config.json）

从子机仓库恢复（本地备份库不可用/缺块时）：
  --repo <dir>         子机仓库目录（U 盘 / UNC 网络路径，含 repo.json 与 recovery-kit\）
  --password-env NAME  密码放在环境变量 NAME 里（推荐；不写进命令行）
  --dpapi              用 DPAPI 缓存密码（仅同一台机器/同一 Windows 用户有效）
  --dpapi-file <file>  DPAPI 缓存文件路径

PowerShell 风格开关也会被翻译：-List / -Verify / -Yes / -Auto / -Force / -DryRun /
-NoStart / -Home X / -Store X / -Host X / -Snapshot X / -Repo X / -Plugin X / -Config X /
-PasswordEnv X / -DpapiFile X / -NoPause（结束后不暂停）。

退出码：
  0  成功
  1  用法错误、用户取消、环境不允许（DSH 在运行等）、密码问题
  2  校验失败 / 备份库不可用 / 没有可用快照
  3  恢复部分失败（有文件写入失败、junction 修复失败或恢复后核对不一致）


三、密码（只在对子机加密仓库恢复时需要）
----------------------------------------
本地备份库（D:\dsh-backup）是明文内容寻址存储，恢复不需要密码。
从子机仓库（异地加密副本）恢复需要「恢复密码」（至少 9 位、含字母和数字）：
  - 推荐：设置环境变量后带 --password-env NAME，密码不经过命令行/日志；
  - 也可以在控制台提示时直接输入（不回显）；
  - 同一台机器同一用户可先用 DPAPI 缓存密码（--dpapi），换机/重装系统后只能用密码。
密码错误 = 数据不可读，没有后门；请务必单独记牢（不要只存在 .dsh 里）。


四、从子机仓库（U 盘 / 异地机 / UNC）恢复
-----------------------------------------
当本地 D:\dsh-backup 不存在、被清空、或推荐快照缺块时，控制台会提示输入
子机仓库目录（也可以直接 --repo <目录>）。要求该目录里至少有：
  repo.json                 加密仓库头（含 salt/kdf 参数，无密码）
  chunks\ / manifests\      密文块与加密清单
  recovery-kit\recover.mjs  离线恢复工具（导出时自动写入）
恢复流程：
  1. 用 recovery-kit\recover.mjs restore --dir <仓库> --home <home> --yes
     （目标非空时自动加 --force；被覆盖文件先备份到 <仓库>\..\recovery-quarantine\）
  2. 恢复后同样重建 junction；
  3. 启动 DSH。
注意：从子机仓库恢复时没有本地 pre-restore 快照（快照在远端仓库里），
但 quarantine 仍然生效；清单里没有的目标文件不会被删除。


五、junction（插件链接）是怎么修的
----------------------------------
DSH profile 的 package.json 里 link: 依赖（如
  "dsh-disaster-recovery": "link:./plugins/dsh-disaster-recovery"）
在 node_modules 下是指向 plugins\<name> 的目录 junction。恢复快照后这些 reparse point
可能缺失/指向旧路径，控制台会：
  1. 读 <home>\profiles\<p>\package.json 的 dependencies；
  2. 对每个 link: 依赖，把相对路径按 profile 目录归一化（./ 和 ../ 都支持），
     校验目标目录存在且含 package.json；
  3. node_modules\<name> 不存在 → 用 `cmd /c mklink /J` 创建；
     存在但指向错误 → 先用 `cmd /c rmdir` 摘掉旧 junction（只删除 reparse point，
     绝不递归删除目标目录），再创建；
  4. node_modules\<name> 是普通真实目录时**拒绝自动删除**（可能 npm 装出来的），
     报告里标 conflict，需要人工确认后改名再跑一次；
  5. 顺带检查 node_modules 是否存在、非 link: 的 npm 依赖是否已安装；
     缺 npm 依赖只警告（DSH 可能加载失败，需要时在 profile 目录 npm install）。
整个过程可先用 --dry-run 预览（会打印 create/rebuild/ok/conflict 数量）。


六、权限 / 环境
---------------
- 创建 junction、写 D:\dsh-backup、结束进程都不需要管理员权限；
  只有「跨用户」目录或受保护目录才需要提权。
- 若 D:\dsh-backup 在移动硬盘/网络盘上没挂载，控制台会提示改用子机仓库。
- 恢复的目标 home 默认是当前用户的 %USERPROFILE%\.dsh；恢复别人的数据用 --home 指定。
- 控制台不联网、不安装依赖、不修改 plugin 副本；报告和 quarantine 都写在备份库里。
- 防火墙/杀软可能拦 powershell.exe 启动 DSH（Start-Process），失败时手动双击 DSH 即可，
  数据已经恢复好，报告里 start.started=false。


七、边界（这些情况自动恢复不了）
--------------------------------
- 快照和子机仓库都缺块/损坏：控制台拒绝恢复（不会写一半），退出码 2，报告里列出缺块。
- 恢复密码完全丢失：异地仓库数据不可读，只能靠本地明文备份库。
- 备份库和桌面入口同时被删（整机重装/勒索）：需要子机仓库目录 + 密码 + recovery-kit。
- 目标 node_modules 里是真实目录（而不是 junction）：不自动删，需要人工处理。
- `.dsh` 里清单之外的现行文件不会被删除；恢复只覆盖快照里有的文件。
- 恢复前务必让 DSH 完全退出，否则内存态可能覆盖恢复结果（控制台默认会拦）。


八、相关位置速查
----------------
  快照/内容块          <storeRoot>\<host>\snapshots\<id>.json、blobs\
  监控事故与推荐点     <storeRoot>\<host>\monitor\incidents\*.json
  恢复隔离（旧文件）   <storeRoot>\<host>\restore-quarantine\<时间戳>\
  本次恢复报告         <storeRoot>\manual\<时间戳>-external-restore\report.json
  外部入口/自包含 CLI  %LOCALAPPDATA%\DeepSeek Recovery\scripts\、...\plugin\
  监控非密配置         %LOCALAPPDATA%\DeepSeek Recovery\monitor\config.json
  看门狗状态/日志      ...\monitor\state.json、watchdog.log
