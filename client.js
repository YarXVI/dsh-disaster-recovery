/**
 * dsh-disaster-recovery — 浏览器侧面板（复刻 DSH 原生设置页 + 仪表盘）。
 *
 * 版式与取值全部来自 DSH 自带主题：
 *   - 颜色：--dsw-* token（design-platform.css 的 light / dark 两套），不硬编码暗色值；
 *   - 行：padding 16px 0、.5px 底边（--dsw-alias-border-l2）、标题 14/22、说明 12/18 tertiary；
 *   - 按钮：主按钮 = button-primary-fill（黑白对比色）+ label-primary-foreground；
 *   - 开关：36x20、border-l3 轨道、brand-primary 选中、16px 圆钮（与原生一致）；
 *   - 卡片：settings-card-fill / settings-card-stroke（base.css 的设置卡片材质）；
 *   - 圆角：--dsw-radius-*（4/8/12/16/20/28）。
 *
 * 挂载：sidebar.panellist → 左栏「忆匣」入口；main → 主区域。
 * 数据：Host 同源路由 /plugins/dsh-disaster-recovery/panel（只允许回环）。
 * 兼容：旧 Host 不认识 verify/preview/open 时降级提示「重启 DSH 后可用」，不刷错误。
 */
window.__ModuleLoader__.load({
  id: 'dsh-disaster-recovery',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'disaster-recovery'
    const PANEL_ID = 'dsh-disaster-recovery-panel'
    const ROUTE = '/plugins/dsh-disaster-recovery/panel'
    const STYLE_ID = 'dsh-disaster-recovery-style'
    const VERSION = '0.8.0'

    /* ------------------------------------------------------------------ 文案 */

    const zh = {
      title: '忆匣',
      subtitle: '失去之前，先有一份。实时备份整个数据目录，出问题可退回任意时间点。',
      versionNote: '内容去重存储 · DSH 打不开也能恢复',
      seatLine: '求索骑士团 · 第一席',
      backup: '立即备份',
      backingUp: '备份中…',
      refresh: '刷新',
      working: '处理中…',
      retry: '重试',
      open: '打开',
      openLog: '查看日志',
      copy: '复制',
      copied: '已复制',
      cancel: '取消',
      save: '保存',
      saving: '保存中…',
      unsaved: '未保存',
      saved: '设置已保存',
      loading: '正在读取备份状态…',
      loadFailed: '读取失败',
      emptySnapshots: '还没有快照。点右上角「立即备份」创建第一个。',
      noMatch: '没有匹配的快照。',

      healthy: '实时保护中',
      pausedState: '已暂停',
      disabledState: '备份已关闭',
      watchOffState: '轮询备份中',
      staleState: '快照偏旧',
      errorState: '需要注意',
      notBackedUp: '尚未备份',
      shortHealthy: '正常',
      shortPaused: '已暂停',
      shortWarn: '注意',
      shortError: '异常',
      shortOff: '已关闭',
      shortNotBackedUp: '未备份',
      lastSnapshot: '最近快照',
      lastSnapshotLine: '{time}（{ago} · {files} 个文件）',
      noSnapshotYet: '还没有快照',
      snapshots: '快照',
      storage: '占用',
      chunks: '内容块',
      changedLast: '上次变化',

      health: '健康状态',
      healthDesc: '只读检查：确认最近快照的每个内容块都还在，能不能真的恢复。',
      check: '检查完整性',
      checking: '正在检查完整性…',
      checkOk: '检查通过：{files} 个文件内容完整，可以恢复。',
      checkMissing: '检查发现 {n} 个文件的数据缺失，这份备份不能完整恢复。',
      checkUnsupported: '检查完整性需要重启 DSH 后可用。',
      checkAt: '检查于 {time}',

      monitoring: '实时监控',
      monitoringPaused: '已暂停：不会自动创建快照',
      monitoringOn: '监听文件变化，静止约 {sec} 秒后创建快照',
      monitoringOff: '文件监听不可用，按固定间隔扫描',

      latest: '最近一次自动快照',
      store: '备份位置',
      storeDesc: '在 DSH 数据目录之外；DSH 整个被清掉也还在。',
      home: 'DSH 数据目录',
      homeDesc: '快照覆盖的根目录。',
      lastError: '上次错误',
      restorePending: '恢复完成：写入 {restored} 个文件，跳过 {unchanged} 个未变文件。请完全退出并重新启动 DeepSeek Harness。',
      restorePendingPlan: '删除后不可恢复。',

      snapshotsTitle: '快照时间线',
      searchPlaceholder: '搜索日期或 id（如 10-27 / 20:07）',
      total: '共 {n} 个',
      totalFiltered: '筛选 {n} / {total} 个',
      groupCount: '{n} 个',
      showRest: '显示其余 {n} 个',
      hideRest: '收起',
      expandAll: '全部展开',
      collapseAll: '全部收起',

      restore: '恢复',
      delete: '删除',
      restoreTitle: '把快照 {time} 恢复到当前 DSH 数据目录？',
      previewLoading: '正在预演这次恢复…',
      previewCreate: '新建 {n} 个文件',
      previewChanged: '覆盖 {n} 个文件',
      previewUnchanged: '跳过 {n} 个未变文件',
      previewExtra: '保留 {n} 个额外文件',
      previewBytes: '写入内容 {size}',
      previewUnsupported: '预演需要重启 DSH 后可用；恢复本身不受影响。',
      restoreNote: '恢复前会先为当前状态拍一份 pre-restore 快照；被覆盖的旧文件另存到隔离区；恢复完成后必须重启 DSH。',
      confirmRestore: '确认恢复',
      deleteTitle: '删除快照 {time}？',
      deleteNote: '删除后不可恢复；内容块只有在没有其它快照引用时才会被回收。',
      confirmDelete: '确认删除',

      settings: '备份设置',
      interval: '快照间隔',
      intervalDesc: '两次自动快照的最小间隔（秒）。聊天时日志持续追加，用它控制快照节奏。',
      keepLast: '最近快照数',
      keepLastDesc: '最近 N 个一定保留，不受下面的分层规则影响。',
      keepHourly: '每小时保留',
      keepHourlyDesc: '更早的快照，在这段时间内每小时保留一个（小时）。',
      keepDaily: '每天保留',
      keepDailyDesc: '再早的快照，在这段时间内每天保留一个。',
      keepLastShort: '最近',
      keepHourlyShort: '每小时',
      keepDailyShort: '每天',
      capLabel: '上限',
      snapshotsCap: '快照（上限 {n}）',
      maxSnapshots: '最大保留快照数',
      maxSnapshotsDesc: '快照总数超过这个数就从最旧的开始自动删除；这也是磁盘占用的硬上限。默认 100，最小 5。',
      maxSnapshotsInvalid: '最大保留数需在 5 到 10000 之间。',
      unitSec: '秒',
      unitCount: '个',
      unitHour: '小时',
      unitDay: '天',
      excludes: '排除项',
      excludesDesc: '按路径段匹配：dsh-runtimes 这类名字任意层级都排除；含 / 表示前缀；* 开头表示后缀。用逗号分隔。',
      root: '备份根目录',
      rootDesc: '可在下面直接修改；修改后需要重启 DSH，旧备份不会自动迁移（仍保留在原目录）。',
      rootChange: '修改',
      rootEditTitle: '修改备份根目录',
      rootEditDesc: '必须是绝对路径、不能在 DSH 数据目录内、且可写。修改只影响之后的新快照，旧备份保留在原目录。',
      rootValidate: '校验路径',
      rootValid: '路径可用',
      rootConfirmTitle: '确认修改备份根目录？',
      rootConfirmNote: '将备份并改写 profile 的 cordis.patch.yml 里的 root 行；需要重启 DSH 生效，旧备份不会自动迁移。',
      rootConfirm: '确认修改',
      rootChanged: '备份根目录已改为 {root}，重启 DSH 后生效',
      rootPending: '待生效：{root}（重启 DSH 后生效；旧备份保留在原目录）',
      rootApplyFailed: '修改备份根目录失败：{message}',
      intervalInvalid: '快照间隔需在 10 秒到 24 小时之间。',
      keepInvalid: '保留数量需为 ≥1 的整数。',

      records: '恢复记录',
      recordsEmpty: '还没有恢复记录。每次恢复都会把被覆盖的旧文件存到隔离区并在报告里计数。',
      recordMeta: '写入 {restored} · 跳过 {unchanged} · 隔离 {quarantined} · 额外 {extra}',
      recordFailed: '失败 {n}',
      openQuarantine: '打开隔离区',

      offTitle: '异地备份',
      offDesc: '加密去重仓库：本机存密文，已配对的设备只保存密文、不保存密码；换机/重装后必须用恢复密码。',
      offLoading: '正在读取异地备份状态…',
      offUnsupported: '异地备份需要重启 DSH 后可用（面板已更新，Host 还是旧版）。',
      offDisabled: '异地备份已关闭',
      offDisabledDesc: '开启后每天把最新快照加密归档，并同步到已配对的异地设备。',
      offEnable: '启用',
      offEnableToast: '已启用异地备份',
      offStateOff: '已关闭',
      offStateLocked: '已锁定',
      offStateUnlocked: '已解锁',
      offStateNew: '未初始化',
      offInitTitle: '设置恢复密码',
      offInitDesc: '密码至少 9 位，且必须同时包含字母和数字；忘记密码后档案无法解密（没有后门）。密码只在本机内存与 DPAPI 缓存里使用，绝不发给异地设备。',
      offPassword: '恢复密码',
      offPasswordPlaceholder: '至少 9 位，含字母和数字',
      offPasswordWeak: '密码至少 9 位，且必须同时包含字母和数字。',
      offInit: '初始化仓库',
      offIniting: '正在初始化…',
      offInitOk: '异地备份仓库已初始化，可以开始首次导出。',
      offLockedTitle: '档案已锁定',
      offLockedDesc: '输入恢复密码后可以查看档案列表并一键恢复。',
      offUnlock: '解锁',
      offUnlocking: '正在解锁…',
      offUnlockOk: '已解锁',
      offCacheUse: '用本机缓存密钥解锁',
      offCacheNote: '本机已缓存密钥（DPAPI，仅当前 Windows 用户可解）。换机或重装系统后必须用恢复密码；建议每周演练一次。',
      offCacheClear: '清除本机密钥缓存',
      offCacheCleared: '已清除本机密钥缓存',
      offClearKeyTitle: '清除本机记住的恢复密码？',
      offClearKeyNote: '清除后必须重新输入恢复密码；如果密码也忘了，异地档案将永久无法解密。',
      offClearKeyConfirm: '确认清除',
      offLock: '锁定',
      offLockedToast: '已锁定：密码已从内存清除',
      offPeer: '异地备份',
      offPeerDesc: '已配对的设备只保存密文，不保存密码。',
      offPeerOnline: '在线',
      offPeerOffline: '离线',
      offPeerMissing: '未配置设备同步',
      offPairHint: '去「设备同步」配对异地设备并保持在线，才能同步与直取档案。',
      offTarget: '备份到',
      offTargetDesc: '选择导出/同步的目标设备；未选择时自动选一个在线且已配对的设备。',
      offTargetAuto: '自动：{name}',
      offTargetNone: '未配对异地设备',
      offTargetSaved: '已保存备份目标：{name}',
      offTargetInvalid: '已保存的目标不在已配对列表，当前回退到 {name}',
      offTargetOffline: '备份目标当前离线，同步/导出会失败',
      offArchives: '异地备份档案',
      offArchivesEmpty: '还没有异地备份档案。点「立即导出」把最新快照加密归档。',
      offArchiveMeta: '{files} 个文件 · {size}',
      offSourceLocal: '本地',
      offSourcePeer: '异地',
      offExport: '立即导出',
      offExporting: '正在导出…',
      offExportOk: '已导出 {files} 个文件（新增 {chunks} 个块）',
      offRepoUsage: '已用空间',
      offRepoEmpty: '还没有导出过档案',
      offTimeline: '时间线',
      offProgressExport: '加密归档',
      offProgressSync: '同步到异地设备',
      offProgressFetch: '从异地设备取回',
      offProgressRestore: '恢复数据',
      offProgressDrill: '恢复演练',
      offSync: '立即同步',
      offSyncing: '正在同步…',
      offSyncOk: '已同步 {packs} 个包（{size}）',
      offSyncUpToDate: '异地设备已是最新',
      offRestore: '一键恢复',
      offRestoring: '正在恢复…',
      offRestoreTitle: '从异地备份档案 {time} 恢复？',
      offRestoreNote: '会先从异地设备取回缺失的块，再恢复当前 DSH 数据目录；恢复完成后必须重启 DSH。',
      offConfirmRestore: '确认恢复',
      offRestoreOk: '异地恢复完成：写入 {n} 个文件。请重启 DeepSeek Harness。',
      offDrill: '演练',
      offDrilling: '演练中…',
      offDrillOk: '演练通过：{files} 个文件 sha256 一致',
      offDrillBad: '演练发现 {n} 个文件不一致',
      offLastExport: '上次导出',
      offLastSync: '上次同步',
      offLastDrill: '上次演练',
      offNever: '从未',
      offSettings: '异地备份设置',
      offRetainDaily: '每日保留',
      offRetainDailyDesc: '保留最近 N 份每日档案；更早的按每周保留。',
      offRetainWeekly: '每周保留',
      offRetainWeeklyDesc: '再早的档案每周保留 1 份（0 = 不保留）。',
      offQuota: '异地设备配额',
      offQuotaDesc: '异地备份目录的硬上限，超出后同步会被拒绝。',
      offQuotaInvalid: '配额需在 1 GB 到 1024 GB 之间。',
      offSchedule: '每日导出时间',
      offScheduleDesc: '本地时间 HH:MM；留空表示不自动导出（仍可手动导出）。',
      offScheduleInvalid: '时间格式应为 HH:MM（例如 04:00）。',
      offWeeklyDrill: '每周自动演练',
      offWeeklyDrillDesc: '每周在临时目录做一次真恢复并逐文件校验；需要本机已缓存密钥。',
      offSave: '保存设置',
      offSaved: '异地副本设置已保存',
      offTaskCmd: '复制计划任务命令',
      offTaskCmdDesc: '在管理员 PowerShell 里执行才会真正安装每日无人值守导出；面板不会自动安装。',
      offTaskCopied: '已复制计划任务命令',
      offChainBroken: '哈希链在 {name} 处断开，建议重新导出一次。',
      offError: '上次错误',
      offNoSchedule: '未设置自动导出时间',
      offBusyOther: '已有异地副本任务在进行，请稍候。',
      offPasswordNeeded: '请先输入恢复密码。',
      offLockedHint: '解锁后才能查看档案内容并恢复。',
      offUsage: '已用 {used} / {quota}',
      offDrillUnsupported: '演练需要重启 DSH 后可用。',

      monTitle: '事故与监控',
      monNormal: '正常',
      monNormalDesc: '心跳每 5 秒写一次；崩溃、数据丢失、备份损坏会在这里出现红色提醒。',
      monOpenCount: '有 {n} 条未处理事故',
      monUnsupported: '事故监控需要重启 DSH 后可用（面板已更新，Host 还是旧版）。',
      monUnavailable: '事故监控服务不可用。',
      monBannerTitle: '检测到事故',
      monBannerCrash: 'DSH 于 {time} 异常退出（没有正常关闭）。推荐恢复到 {snap} 的快照。',
      monBannerDataLoss: '检测到数据骤降：{detail}。推荐恢复到 {snap} 的快照。',
      monBannerGeneric: '检测到「{kind}」事故（{time}）。',
      monBannerNoSnap: '暂无可用推荐快照',
      monDetectedAt: '发现于 {time}',
      monRestore: '一键恢复',
      monRestoring: '正在恢复…',
      monDetails: '查看详情',
      monAck: '忽略',
      monAckOk: '已忽略这条事故',
      monCollapse: '收起',
      monExpand: '展开',
      monHeartbeat: '最近心跳',
      monHeartbeatLine: '{time}（{ago}）',
      monHeartbeatDead: '界面 {age} 没有心跳上报，可能已卡死',
      monNever: '从未',
      monWatchdog: '外部看门狗',
      monWatchdogInstalled: '已安装',
      monWatchdogMissing: '未安装',
      monWatchdogOk: '运行正常',
      monWatchdogLastCheck: '上次检查 {time}',
      monWatchdogStale: '最近一次检查在 {ago} 前，可能已停摆',
      monWatchdogTask: '计划任务 {task}',
      monNotify: '通知通道',
      monNotifyHint: '面板 / Windows 通知 / Webhook / 邮件 / QQ / 子机；通道互相独立，单个失败不影响其它。',
      monVerify: '检查完整性',
      monVerifying: '正在检查…',
      monVerifyOk: '检查通过：{n} 份备份内容完整',
      monVerifyBad: '发现 {n} 份备份异常（文件缺失或读不出）',
      monVerifyAt: '上次检查 {time}',
      monInstall: '安装/修复外部看门狗',
      monInstalling: '正在安装…',
      monInstallOk: '外部看门狗已就绪：{home}',
      monInstallConfirm: '会复制看门狗与恢复控制台到 %LOCALAPPDATA%\\DeepSeek Recovery，并注册计划任务 DSH-DisasterWatchdog。继续？',
      monInstallNote: '看门狗每分钟检查一次心跳与进程，只记录 + 通知，不会自动重启 DSH。',
      monInstallMissing: '安装脚本不存在：{message}',
      monIncidents: '事故记录',
      monTimeline: '时间线',
      monImpact: '受影响备份',
      monImpactLocal: '本地快照：检查 {checked} 份，异常 {bad} 份',
      monImpactOffsite: '异地文件：检查 {checked} 个，异常 {bad} 个',
      monImpactNone: '未发现受影响备份',
      monRecommend: '推荐恢复点',
      monRecommendLine: '{time} · {id}',
      monRecommendVerified: '已验证',
      monRecommendUnverified: '未验证',
      monNoRecommend: '暂无推荐恢复点',
      monKindCrash: '异常退出',
      monKindDataLoss: '数据丢失（遗忘潮）',
      monKindHang: '无响应',
      monKindBackupCorrupt: '备份损坏',
      monKindOffsiteStale: '异地过期',
      monKindDiskLow: '磁盘不足',
      monKindOther: '其它',
      monOpenTag: '未处理',
      monAckTag: '已忽略',
      monRecoveredTag: '已恢复',
      monRestoreConfirmTitle: '恢复到 {time} 的快照？',
      monRestoreConfirmNote: '恢复前会先拍 pre-restore 快照，被覆盖的旧文件进隔离区；恢复完成后必须重启 DSH。',
      monConfirmRestore: '确认恢复',
      monRestoreOk: '已恢复 {n} 个文件，请重启 DeepSeek Harness',
      monConfirmInstallTitle: '安装/修复外部看门狗？',
      monConfirmInstall: '确认安装',
      monBaseline: '数据基线',
      monBaselineLine: '{files} 个文件 · {sessions} 个会话 · {time}',
      monOutbox: '待外发通知',
      monOutboxLine: '{n} 条',
      monChannelPanel: '面板',
      monChannelToast: 'Windows 通知',
      monChannelWebhook: 'Webhook',
      monChannelEmail: '邮件',
      monChannelQQ: 'QQ',
      monChannelPeer: '异地设备',
      monTlLastHeartbeat: '最后心跳',
      monTlRestart: '重新启动',
      monTlDataBaseline: '数据基线',
      monTlDataDrop: '数据骤降',
      monTlDetected: '检测',
      monTlAck: '忽略',
      monTlRecovered: '恢复完成',
      monTlOther: '事件',
      monFieldFiles: '文件',
      monFieldSessions: '会话',
      monProtectionTitle: '事故保护已生效',
      monProtectionPaused: '已自动暂停自动快照（避免新快照覆盖事故现场）',
      monProtectionPinnedList: '已钉住恢复点：{ids}',
      monProtectionNote: '点「忽略」或恢复成功后，会自动还原你原先的暂停状态；钉住的恢复点不会被自动清理。',
      monTagAutoPaused: '已暂停备份',
      monTagPinned: '已钉住 {id}',
      monDetailsShort: '查看详情',
      monError: '监控异常：{message}',

      notifyTitle: '通知设置',
      notifyDesc: '事故通知走外部看门狗；面板卡/Windows 通知/Webhook/邮件/QQ/异地设备通道互相独立，可逐个测试。',
      notifyPanel: '面板卡',
      notifyPanelDesc: '在「事故与监控」顶部与 alerts/current.json 显示（始终开启）。',
      notifyToast: 'Windows 通知',
      notifyToastDesc: '通过 toast.ps1 弹系统通知（无需 DSH 运行）。',
      notifyWebhook: 'Webhook',
      notifyWebhookDesc: 'POST JSON 到自定义地址，可配置多个；token 可选（只存 DPAPI 密文）。',
      notifyHookName: '名称',
      notifyHookUrl: 'URL',
      notifyHookToken: 'Token（留空不修改）',
      notifyHookEnabled: '启用',
      notifyAddHook: '添加 Webhook',
      notifyRemove: '删除',
      notifyEmail: '邮件（SMTP）',
      notifyEmailDesc: '通过外部 notify.ps1 发信；密码只存 DPAPI 密文，面板不回显。',
      notifySmtpHost: 'SMTP 服务器',
      notifySmtpPort: '端口',
      notifySmtpSsl: 'SSL/TLS',
      notifySmtpUser: '用户名',
      notifySmtpPassword: '密码（留空不修改）',
      notifySmtpFrom: '发件人',
      notifySmtpTo: '收件人（逗号分隔）',
      notifyQQ: 'QQ / OneBot',
      notifyQQDesc: '直接调用 OneBot HTTP 发送私聊消息；失败时进入 outbox 重试。',
      notifyQQHttp: 'OneBot HTTP 地址',
      notifyQQToken: 'Access token（留空不修改）',
      notifyQQAction: '动作',
      notifyQQTarget: '目标（QQ 号/群号）',
      notifyPeer: '异地设备',
      notifyPeerDesc: '通过 dsh-sync 把事故摘要推送到已配对的异地设备（需 DSH 在运行）。',
      notifyPeerEnabled: '启用异地设备通知',
      notifyTest: '测试',
      notifyTesting: '测试中…',
      notifySave: '保存通知设置',
      notifySaving: '保存中…',
      notifySaved: '通知设置已保存',
      notifyLoadFailed: '读取通知设置失败：{message}',
      notifyUnsupported: '通知设置需要重启 DSH 后可用（面板已更新，Host 还是旧版）。',
      notifySecretKeep: '已配置，留空不修改',
      notifySecretEmpty: '未配置',
      notifyTestOk: '通知测试通过：{channel}',
      notifyTestFail: '通知测试未通过（{code}）：{detail}',
      notifyWatchdogMissing: '外部看门狗未安装：请先点「安装/修复外部看门狗」',
      notifyTestUnavailable: '外部看门狗版本过旧：请重新「安装/修复外部看门狗」后再测试',
      notifySaveFailed: '保存通知设置失败：{message}',

      help: '救命入口',
      helpMenu: 'DSH 起不来时',
      helpMenuDesc: '开始菜单搜「Deepseek恢复」，或运行 %LOCALAPPDATA%\\DeepSeek Recovery\\scripts\\restore.cmd。不需要 DSH 能启动。',
      helpCli: '命令行',
      helpCliDesc: 'node scripts/cli.mjs list | backup | restore latest | verify latest',
      helpRestart: '恢复之后',
      helpRestartDesc: '必须完全退出并重新启动 DeepSeek Harness：DSH 以内存态为准，不重启会把恢复结果又写回旧的。',

      agoS: '{n} 秒前',
      agoM: '{n} 分钟前',
      agoH: '{n} 小时前',
      agoD: '{n} 天前',
      today: '今天',
      yesterday: '昨天',
      justNow: '刚刚',

      reasonChange: '自动',
      reasonManual: '手动',
      reasonStartup: '启动',
      reasonPreRestore: '恢复前',
      reasonRestore: '恢复后',
      reasonAuto: '自动',

      snapMeta: '{files} 文件 · 变化 {changed} · {size}',
      unknownAction: '这个操作需要重启 DSH 后才能用。',
      restoreToast: '已恢复 {n} 个文件。请重启 DeepSeek Harness。',
      deleteToast: '已删除 {id} 这份备份',
      backupToast: '备份完成：{files} 个文件，其中 {changed} 个有变化，共 {size}',
      backupSkipped: '没有变化，这次不用备份',
      backupPausedToast: '自动备份已暂停，这次没有备份；先点「恢复自动备份」再试。',
      backupDisabledToast: '备份功能已关闭，这次没有备份。',
      pausedToast: '已暂停自动备份',
      resumedToast: '已恢复自动备份',
      openFailed: '打开目录失败：{message}',
      actionFailed: '{action}失败：{message}',
      /* v0.7 新版界面 */
      tabBackup: '备份与恢复',
      tabSettings: '设置',
      pillNormal: '正常',
      pillIncident: '需要处理',
      pillPaused: '已暂停',
      pillEmpty: '未开启',
      pillRestored: '待重启',

      protectTitle: '你的数据正在被保护',
      protectDesc: '文件有变化就自动备份，最快每 {interval}一次。最近一次在 {ago}，共 {count} 个备份，覆盖约 {days} 天。',
      lastBackupLabel: '最近备份',
      intervalLabel: '备份间隔',
      historyLabel: '历史备份',
      usageLabel: '占用',
      whereLabel: '备份存在哪',
      restoreOpen: '恢复数据…',
      backupNow: '立即备份一次',
      viewRecords: '查看恢复记录',
      checkLine: '还没检查过这份备份能不能用',
      checkOkLine: '检查通过：这份备份可以完整恢复',
      checkNow: '检查备份能不能用',
      checkUnsupportedLine: '检查完整性需要重启 DSH 后才能用。',
      unitCountPlain: '{n} 个',

      incidentTitle: '数据可能丢了，建议马上恢复',
      incidentDesc: '最近一次异常退出在 {time}，之后会话数从 {before} 个变成了 {after} 个。推荐恢复到 {snap} 的备份。',
      incidentDescGeneric: '检测到「{kind}」事故（{time}）。推荐恢复到 {snap} 的备份。',
      incidentNoSnap: '检测到「{kind}」事故（{time}），暂时没有可用的恢复点。',
      restoreTo: '恢复到 {snap}',
      pickAnother: '换一个时间…',
      ignoreIncident: '暂时忽略',
      incidentFoot: '恢复前会自动保存当前状态（后悔了还能回来）；恢复完成后需要重启 DeepSeek Harness。',
      monProtectionShort: '已自动暂停备份，并锁定恢复点',

      pausedTitle: '自动备份已暂停',
      pausedDesc: '暂停于 {time}。此后的改动不会进备份，出事只能恢复到这个时间点之前。',
      pausedDescNoTime: '此后的改动不会进备份，出事只能恢复到暂停前的时间点。',
      resumeAuto: '恢复自动备份',
      backupOnceNow: '现在就备份一次',
      resumeAndBackup: '恢复并备份一次',
      pausedFoot: '已有的 {n} 个历史备份不受影响，随时可以恢复。',

      emptyTitle: '还没有备份，先做一次吧',
      emptyDesc: '备份是你数据的副本。文件有变化就自动存一份，出问题可以回到之前的时间点。',
      startProtect: '立即创建第一份备份',
      emptyFoot: '备份会存在 {store}，和 DSH 数据分开；即使 .dsh 整个被删也能恢复。',

      restoredTitle: '已恢复到 {time}',
      restoredDesc: '写入了 {restored} 个文件；备份里没有的 {kept} 个新文件保留了，没有被删。恢复前的状态已经自动存档。',
      rollback: '回到恢复前的状态',
      rollbackMissing: '找不到恢复前的存档，无法回退。',
      restartBannerTitle: '恢复完成，需要重启 DeepSeek Harness 才会生效。',
      restartBannerDesc: '重启前，DSH 里看到的可能还是旧数据。重启后这条提示会自动消失。',
      restartFoot: '重启 DeepSeek Harness 后生效。这条提示会一直显示，直到重启完成。',

      rescueTitle: 'DeepSeek 打不开怎么办？',
      rescueDesc: '不用打开 DSH：在开始菜单搜索「DeepSeek 恢复」运行即可，它会先修好数据再启动。',

      pickerTitle: '恢复到哪个时间？',
      pickerDesc: '选一个时间点，DSH 会回到那一刻的样子。恢复前会先保存当前状态。',
      pickerSearch: '搜索日期，比如 10-27',
      pickerEarlier: '更早',
      pickerKeepDaily: '每天留 1 个，共 {n} 天',
      pickerLatest: '最新',
      pickerRecommended: '推荐',
      pickerStale: '事故之后',
      pickerManual: '手动',
      pickerCount: '{n} 个',
      pickerEmpty: '没有匹配的备份。',
      pickerNoSnapshots: '还没有备份记录，先做一次备份。',

      confirmRestoreTitle: '恢复到 {time}？',
      confirmRestoreSub: '这份备份里有 {files} 个文件；确认后恢复前会先校验内容，缺数据会中止。',
      confirmRestoreSubPlain: '这份备份里有 {files} 个文件。',
      effectChanged: '{n} 个文件会变回 {time} 时的样子',
      effectSaved: '现在的状态会先自动存一份，恢复错了还能回来',
      effectKept: '这份备份里没有的 {n} 个新文件会保留，不会被删',
      effectUnknown: '正在对比文件，请稍候…',
      filesToggle: '会改哪些文件',
      filesMore: '… 还有 {n} 个文件',
      filesUnsupported: '当前 Host 不支持逐文件对比，恢复本身不受影响。',
      previewFailed: '无法预览这次恢复：{message}',
      restoreFailed: '恢复没有完成：{message}',
      restoringNow: '正在恢复…',
      restartWarn: '恢复完成后，需要关闭并重新打开 DeepSeek Harness。',
      confirmRestoreBtn: '确认恢复',
      confirmDeleteTitle: '删除 {time} 的备份？',
      confirmDeleteNote: '删除后不可恢复；只删这一份，其他备份不受影响。',
      confirmDeleteBtn: '确认删除',

      settingsAuto: '自动备份',
      settingsAutoDesc: '文件一有变化就备份，平时不用管。',
      settingsAutoVal: '每 {interval}检查一次变化',
      settingsKeep: '保留多久',
      settingsKeepDesc: '旧备份会自动清理，不会把硬盘占满。',
      settingsKeepVal: '最近 {last} 个；更早的 {hours} 小时内每小时 1 个、{days} 天内每天 1 个',
      settingsStore: '备份存在哪',
      settingsStoreDesc: '要放在 DSH 数据目录以外，整个目录被删也能救回来。',
      settingsOffsite: '异地备份',
      settingsOffsiteDesc: '每天把备份加密复制到另一台电脑，两台一起坏也不怕。',
      settingsOffsiteOff: '未开启',
      settingsOffsiteOn: '已开启',
      settingsNotify: '出事时通知我',
      settingsNotifyDesc: '崩溃、数据丢失、备份损坏时提醒。',
      settingsWatchdog: '外部守护',
      settingsWatchdogDesc: 'DSH 卡死或崩溃时，由系统每分钟检查一次。',
      settingsWatchdogRunning: '运行中',
      settingsWatchdogMissing: '未安装',
      settingsAdvanced: '高级选项',
      settingsNotifyOn: '已开启',
      settingsNotifyOff: '未开启',
      settingsAdvancedDesc: '排除项、命令行、上次错误、关于忆匣。',
      settingsAdjust: '调整',
      settingsView: '查看',
      settingsGo: '去设置',
      subBack: '返回',
      subRetention: '备份节奏与清理',
      subAdvanced: '高级选项',
      subRecords: '恢复记录',
      subMonitor: '事故与守护',
      subOffsite: '异地备份',
      subNotify: '通知设置',
      retentionInterval: '备份间隔',
      retentionIntervalDesc: '两次自动备份之间的最短时间（秒）。',
      retentionKeepLast: '最近保留',
      retentionKeepLastDesc: '最近 N 个一定保留，不受下面分层规则影响。',
      retentionMax: '最大保留数',
      retentionMaxDesc: '总数超过这个数就从最旧的开始删除，也是磁盘占用的硬上限。',
      retentionHourly: '每小时保留',
      retentionHourlyDesc: '更早的备份，在这段时间内每小时保留一个（小时）。',
      retentionDaily: '每天保留',
      retentionDailyDesc: '再早的备份，在这段时间内每天保留一个。',
      retentionExcludes: '排除项',
      retentionExcludesDesc: '按路径匹配；含 / 表示前缀；* 开头表示后缀。用逗号分隔。',
      retentionUnsaved: '未保存',
      advancedRoot: '备份根目录',
      advancedRecords: '恢复记录',
      advancedRecordsDesc: '共 {n} 条；被覆盖的旧文件都存在隔离区。',
      advancedCli: '命令行',
      advancedCliDesc: 'DSH 起不来时也能用命令行恢复。',
      aboutTitle: '关于忆匣',
      aboutDesc: '求索骑士团第一席 · 忆匣（Casket）：全库封存、回滚与隔离，不做检索与联想。',
      aboutNote: '「失去之前，先有一份。」',

      /* v0.8 新界面 */
      tabOverview: '概览',
      tabBackups: '备份',
      tabRestore: '恢复',
      tabSettings: '设置',
      subStore: '备份位置',
      retentionPace: '备份节奏',
      integrity: '完整性',
      integrityUnchecked: '还没检查过这份备份能不能用',
      integrityChecking: '正在检查完整性…',
      integrityOk: '检查通过：{files} 个文件都能完整恢复',
      integrityBad: '发现 {n} 个文件的数据缺失，这份备份不能完整恢复',
      integrityUnsupported: '检查完整性需要重启 DSH 后才能用。',
      integrityAt: '检查于 {time}',
      integrityRecheck: '重新检查',
      checkRecommend: '检查这个恢复点',
      activity: '最近活动',
      activityAll: '全部记录',
      activityEmpty: '还没有活动。备份、检查、恢复和事故会出现在这里。',
      actBackup: '备份',
      actCheck: '检查',
      actRestore: '恢复',
      actIncident: '事故',
      actBackupDone: '{reason}备份完成',
      actCheckDone: '检查完整性通过',
      actRestoreDone: '已恢复到 {time}',
      actIncidentSeen: '检测到{kind}',
      actIncidentDesc: '会话数从 {before} 个变成 {after} 个',
      backupNotice: '事故之后拍的备份不参与推荐；推荐恢复到 {time}。',
      backupNoticeAction: '查看推荐点',
      backupTotal: '{n} 个 · {size}',
      backupSearch: '搜索日期或 id，如 10-29',
      backupLatest: '最新',
      backupNoMatch: '没有匹配的备份',
      backupNoMatchDesc: '换一个日期或 id 试试，比如 10-29。',
      retentionNote: '保留策略：最近 {last} 个；更早的 {hours} 小时内每小时 1 个、{days} 天内每天 1 个。',
      retentionAdjust: '调整保留策略',
      restoreRecords: '恢复记录',
      restoreRecordsCount: '· {n} 条',
      restoreRecordMeta: '写入 {restored} 个 · 跳过 {unchanged} 个 · 存档 {quarantined} 个 · 额外保留 {extra} 个',
      restoreArchives: '恢复前存档',
      restoreArchivesDesc: '被覆盖的旧文件，可单独找回',
      restoreArchivesEmpty: '还没有存档。下次恢复时会自动创建。',
      restoreIncidents: '事故记录',
      restoreIncidentsDesc: '恢复的上下文',
      restoreIncidentOpen: '{n} 条未处理事故',
      restoreIncidentNone: '暂无未处理事故',
      restoreIncidentLine: '{time} · 会话数从 {before} 变成 {after} · 推荐恢复点 {rec}',
      restoreOpenQuarantine: '打开隔离区',
      restoreBackPre: '回到恢复前',
      restoreQuarantineRow: '{files} 个文件，被覆盖前的原样存档',
      settingsGroupBackup: '备份',
      settingsGroupProtect: '保护',
      settingsGroupIncident: '事故',
      settingsGroupOther: '其他',
      settingsAdvancedAbout: '高级选项与关于',
      rescueSteps: '三步',
      rescueShow: '查看步骤',
      rescueHide: '收起步骤',
      rescueStep1: '开始菜单搜索「Deepseek 恢复」并运行。',
      rescueStep2: '按提示选一个时间点（默认推荐事故前最近一份）。',
      rescueStep3: '恢复完成后程序会自动启动 DSH，不需要手工复制文件。',
      emptyIncludes: '第一次备份会包含',
      emptyIncludesDesc: '会话记录、工作区、设置与凭据等 {files} 个文件；dsh-runtimes 等可重装的大文件默认排除。',
      incidentSectionTitle: '事故',
      incidentRecommended: '推荐恢复点',
      recVerifyNote: '恢复前会先校验内容，缺数据会中止。',
      incidentProtection: '事故保护已生效',
      incidentProtectionDesc: '已自动暂停自动备份（避免新备份覆盖事故现场），并锁定 {id} 不会被自动清理。',
      incidentMore: '仍有 {n} 条未处理事故',
      incidentMoreDesc: '恢复完成不代表事故已处理；建议到「事故与守护」确认并标记。',
      incidentSee: '查看',
      incidentSwitchTime: '换一个时间…',
      incidentLater: '稍后处理',
      incidentRestoreTo: '恢复到 {time}',
      modalClose: '关闭',
      saveDiscard: '放弃',
      storeCurrent: '当前备份根目录',
      storeModify: '修改位置',
      storeNew: '新位置',
      storeValidate: '校验路径',
      storeSave: '保存',
      storeValid: '路径可用',
      storeNote: '保存后会改写 profile 的 cordis.patch.yml，需要重启 DSH 生效；旧备份不会自动迁移。',
      storeOccupied: '占用',
      noError: '无',
      settingsOffsiteValue: '{name} · {state} · 每天 {time}',
      settingsNotifyValue: '面板 · Windows 通知 · Webhook · 邮件 · 异地设备',
      settingsWatchdogValue: '上次检查 {time}',
      monitorRunning: '运行状态',
      monitorHeartbeatDesc: '心跳每 5 秒写一次',
      monitorWatchdogDesc: '每分钟检查一次；只记录与通知，不会自动重启 DSH',
      monitorNoIncident: '没有未处理事故',
      monitorNoIncidentDesc: '最近 30 天没有新的异常退出。',
      monitorResolved: '已处理事故',
      monitorNoResolved: '暂无已处理事故',
      monitorNotifySummary: '通知通道',
      monitorNotifyGo: '去设置',
      notifyPanelFixed: '始终开启',
      notifyConfigQQ: '去配置',
      notifyDescShort: '事故通知走外部守护发送；通道互相独立，单个失败不影响其它。',
      aboutVersion: '版本',
      offLockedShort: '已锁定',
      offUnlockedShort: '已解锁',
      offEnableShort: '已开启',
      offDisabledShort: '已关闭',

      checking: '正在检查完整性…',
      durationSec: '{n} 秒',
      durationMin: '{n} 分钟',
      durationHour: '{n} 小时',
      snapFiles: '{n} 个文件',
    }

    const en = {
      title: 'Casket',
      subtitle: 'Quest · Data restore: continuous backup of the whole data folder; rewind to any point in time.',
      versionNote: 'Content-addressed storage · restores without a running DSH',
      seatLine: 'Ordo Quaerentium · First seat',
      backup: 'Back up now',
      backingUp: 'Backing up…',
      refresh: 'Refresh',
      working: 'Working…',
      retry: 'Retry',
      open: 'Open',
      openLog: 'View log',
      copy: 'Copy',
      copied: 'Copied',
      cancel: 'Cancel',
      save: 'Save',
      saving: 'Saving…',
      unsaved: 'Unsaved',
      saved: 'Settings saved',
      loading: 'Reading backup status…',
      loadFailed: 'Could not load',
      emptySnapshots: 'No snapshots yet. Use “Back up now” in the top right to create the first one.',
      noMatch: 'No matching snapshots.',

      healthy: 'Protected live',
      pausedState: 'Paused',
      disabledState: 'Backup disabled',
      watchOffState: 'Interval backup',
      staleState: 'Snapshots are stale',
      errorState: 'Needs attention',
      notBackedUp: 'Not backed up yet',
      shortHealthy: 'Live',
      shortPaused: 'Paused',
      shortWarn: 'Notice',
      shortError: 'Issue',
      shortOff: 'Off',
      shortNotBackedUp: 'No backup',
      lastSnapshot: 'Last snapshot',
      lastSnapshotLine: '{time} ({ago} · {files} files)',
      noSnapshotYet: 'No snapshot yet',
      snapshots: 'Snapshots',
      storage: 'On disk',
      chunks: 'Chunks',
      changedLast: 'Last change',

      health: 'Health',
      healthDesc: 'Read-only check that every content chunk of the latest snapshot still exists.',
      check: 'Check integrity',
      checking: 'Checking integrity…',
      checkOk: 'Check passed: all {files} files are intact and restorable.',
      checkMissing: 'Check found {n} files with missing data; this backup cannot be fully restored.',
      checkUnsupported: 'Checking integrity needs a DSH restart.',
      checkAt: 'Checked {time}',

      monitoring: 'Live monitoring',
      monitoringPaused: 'Paused: no automatic snapshots',
      monitoringOn: 'Watching for changes; snapshot about {sec}s after writes settle',
      monitoringOff: 'File watching unavailable; falling back to interval scans',

      latest: 'Latest automatic snapshot',
      store: 'Backup location',
      storeDesc: 'Outside the DSH data directory, so it survives a wiped home.',
      home: 'DSH data directory',
      homeDesc: 'Root directory covered by snapshots.',
      lastError: 'Last error',
      restorePending: 'Restored {restored} files ({unchanged} unchanged). Quit and restart DeepSeek Harness completely.',
      restorePendingPlan: 'Deletion cannot be undone.',

      snapshotsTitle: 'Snapshot timeline',
      searchPlaceholder: 'Search date or id (e.g. 10-27 / 20:07)',
      total: '{n} total',
      totalFiltered: '{n} of {total}',
      groupCount: '{n}',
      showRest: 'Show {n} more',
      hideRest: 'Collapse',
      expandAll: 'Expand all',
      collapseAll: 'Collapse all',

      restore: 'Restore',
      delete: 'Delete',
      restoreTitle: 'Restore snapshot {time} into the current DSH data directory?',
      previewLoading: 'Previewing this restore…',
      previewCreate: 'Create {n} files',
      previewChanged: 'Overwrite {n} files',
      previewUnchanged: 'Skip {n} unchanged',
      previewExtra: 'Keep {n} extra files',
      previewBytes: 'Write {size}',
      previewUnsupported: 'Preview needs a DSH restart; the restore itself still works.',
      restoreNote: 'A pre-restore snapshot of the current state is taken first; overwritten files are copied to quarantine; DSH must be restarted afterwards.',
      confirmRestore: 'Restore',
      deleteTitle: 'Delete snapshot {time}?',
      deleteNote: 'This cannot be undone. Chunks are reclaimed only when no other snapshot references them.',
      confirmDelete: 'Delete',

      settings: 'Backup settings',
      interval: 'Snapshot interval',
      intervalDesc: 'Minimum time between automatic snapshots, in seconds. Chat logs keep appending, so this sets the pace.',
      keepLast: 'Recent snapshots',
      keepLastDesc: 'Always keep the latest N snapshots, regardless of the tiering below.',
      keepHourly: 'Hourly retention',
      keepHourlyDesc: 'For older snapshots within this window, keep one per hour (hours).',
      keepDaily: 'Daily retention',
      keepDailyDesc: 'For even older snapshots within this window, keep one per day (days).',
      keepLastShort: 'recent',
      keepHourlyShort: 'hourly',
      keepDailyShort: 'daily',
      capLabel: 'max',
      snapshotsCap: 'Snapshots (max {n})',
      maxSnapshots: 'Max snapshots kept',
      maxSnapshotsDesc: 'Snapshots beyond this count are deleted oldest-first automatically; it is also the hard disk-usage cap. Default 100, minimum 5.',
      maxSnapshotsInvalid: 'Max snapshots must be between 5 and 10000.',
      unitSec: 's',
      unitCount: '',
      unitHour: 'h',
      unitDay: 'd',
      excludes: 'Excludes',
      excludesDesc: 'Matched by path segment: names like dsh-runtimes are excluded at any depth; a / means prefix; a leading * means suffix. Comma separated.',
      root: 'Backup root',
      rootDesc: 'Editable below; a DSH restart is required and old backups are not migrated (they stay in the old directory).',
      rootChange: 'Change',
      rootEditTitle: 'Change backup root',
      rootEditDesc: 'Must be an absolute path outside the DSH data directory and writable. Only future snapshots use it; old backups stay in the old directory.',
      rootValidate: 'Validate path',
      rootValid: 'Path is usable',
      rootConfirmTitle: 'Change the backup root?',
      rootConfirmNote: 'The profile cordis.patch.yml will be backed up and its root line rewritten; a DSH restart is required and old backups are not migrated.',
      rootConfirm: 'Change root',
      rootChanged: 'Backup root changed to {root}; it takes effect after a DSH restart',
      rootPending: 'Pending: {root} (takes effect after DSH restart; old backups stay in the old directory)',
      rootApplyFailed: 'Changing the backup root failed: {message}',
      intervalInvalid: 'Interval must be between 10 seconds and 24 hours.',
      keepInvalid: 'Retention must be an integer ≥ 1.',

      records: 'Restore history',
      recordsEmpty: 'No restores yet. Each restore copies overwritten files into quarantine and records counts.',
      recordMeta: '{restored} written · {unchanged} skipped · {quarantined} quarantined · {extra} extra',
      recordFailed: '{n} failed',
      openQuarantine: 'Open quarantine',

      offTitle: 'Offsite backup',
      offDesc: 'Encrypted deduplicated repo: ciphertext here; paired devices store ciphertext only, never the password. After a reinstall only the recovery password works.',
      offLoading: 'Reading offsite backup status…',
      offUnsupported: 'Offsite backup needs a DSH restart (panel updated, host still on the old build).',
      offDisabled: 'Offsite backup is off',
      offDisabledDesc: 'When enabled, the latest snapshot is encrypted and archived daily, then synced to the paired offsite device.',
      offEnable: 'Enable',
      offEnableToast: 'Offsite backup enabled',
      offStateOff: 'Off',
      offStateLocked: 'Locked',
      offStateUnlocked: 'Unlocked',
      offStateNew: 'Not initialised',
      offInitTitle: 'Set the recovery password',
      offInitDesc: 'At least 9 characters including letters and digits. If you forget it the archive cannot be decrypted (no backdoor). The password is only used in memory and in the DPAPI cache; it is never sent to the peer.',
      offPassword: 'Recovery password',
      offPasswordPlaceholder: 'At least 9 characters, letters and digits',
      offPasswordWeak: 'Use at least 9 characters including both letters and digits.',
      offInit: 'Initialise repo',
      offIniting: 'Initialising…',
      offInitOk: 'Offsite repo initialised. You can run the first export now.',
      offLockedTitle: 'Archive locked',
      offLockedDesc: 'Enter the recovery password to list archives and restore.',
      offUnlock: 'Unlock',
      offUnlocking: 'Unlocking…',
      offUnlockOk: 'Unlocked',
      offCacheUse: 'Unlock with cached key',
      offCacheNote: 'A key is cached on this machine (DPAPI, only the current Windows user can decrypt it). After a reinstall only the recovery password works; run a drill weekly.',
      offCacheClear: 'Clear cached key',
      offCacheCleared: 'Cached key cleared',
      offClearKeyTitle: 'Forget the restore password on this machine?',
      offClearKeyNote: 'You will have to enter the restore password again. If you have also forgotten it, the offsite archives can never be decrypted.',
      offClearKeyConfirm: 'Clear now',
      offLock: 'Lock',
      offLockedToast: 'Locked: password dropped from memory',
      offPeer: 'Offsite backup',
      offPeerDesc: 'Paired devices store ciphertext only, never the password.',
      offPeerOnline: 'online',
      offPeerOffline: 'offline',
      offPeerMissing: 'Device sync unavailable',
      offPairHint: 'Pair an offsite device in “Device sync” and keep it online to sync and restore directly over the LAN.',
      offTarget: 'Back up to',
      offTargetDesc: 'Target device for export/sync; when unset, an online paired device is picked automatically.',
      offTargetAuto: 'Auto: {name}',
      offTargetNone: 'No paired offsite device',
      offTargetSaved: 'Backup target saved: {name}',
      offTargetInvalid: 'Saved target is no longer paired; falling back to {name}',
      offTargetOffline: 'Backup target is offline; sync/export will fail',
      offArchives: 'Offsite archives',
      offArchivesEmpty: 'No offsite archives yet. Use “Export now” to encrypt the latest snapshot.',
      offArchiveMeta: '{files} files · {size}',
      offSourceLocal: 'local',
      offSourcePeer: 'offsite',
      offExport: 'Export now',
      offExporting: 'Exporting…',
      offExportOk: 'Exported {files} files ({chunks} new chunks)',
      offRepoUsage: 'Space used',
      offRepoEmpty: 'No archives exported yet',
      offTimeline: 'Timeline',
      offProgressExport: 'Encrypting archive',
      offProgressSync: 'Syncing to offsite device',
      offProgressFetch: 'Fetching from offsite device',
      offProgressRestore: 'Restoring data',
      offProgressDrill: 'Restore drill',
      offSync: 'Sync now',
      offSyncing: 'Syncing…',
      offSyncOk: 'Synced {packs} packs ({size})',
      offSyncUpToDate: 'Offsite device is up to date',
      offRestore: 'Restore',
      offRestoring: 'Restoring…',
      offRestoreTitle: 'Restore from offsite archive {time}?',
      offRestoreNote: 'Missing chunks are fetched from the offsite device first, then the current DSH data directory is restored; DSH must be restarted afterwards.',
      offConfirmRestore: 'Restore',
      offRestoreOk: 'Offsite restore finished: {n} files written. Restart DeepSeek Harness.',
      offDrill: 'Drill',
      offDrilling: 'Drilling…',
      offDrillOk: 'Drill passed: sha256 matches for {files} files',
      offDrillBad: 'Drill found {n} mismatched files',
      offLastExport: 'Last export',
      offLastSync: 'Last sync',
      offLastDrill: 'Last drill',
      offNever: 'never',
      offSettings: 'Offsite backup settings',
      offRetainDaily: 'Daily retention',
      offRetainDailyDesc: 'Keep the latest N daily archives; older ones fall back to weekly retention.',
      offRetainWeekly: 'Weekly retention',
      offRetainWeeklyDesc: 'Keep one archive per week beyond that (0 = keep none).',
      offQuota: 'Offsite device quota',
      offQuotaDesc: 'Hard cap for the offsite backup directory; sync is refused once exceeded.',
      offQuotaInvalid: 'Quota must be between 1 GB and 1024 GB.',
      offSchedule: 'Daily export time',
      offScheduleDesc: 'Local time HH:MM; empty means no automatic export (manual export still works).',
      offScheduleInvalid: 'Use HH:MM, e.g. 04:00.',
      offWeeklyDrill: 'Weekly auto drill',
      offWeeklyDrillDesc: 'Restore into a temp directory once a week and verify every file; needs a cached key.',
      offSave: 'Save settings',
      offSaved: 'Offsite settings saved',
      offTaskCmd: 'Copy scheduled-task command',
      offTaskCmdDesc: 'Running it in an elevated PowerShell installs the daily unattended export; the panel never installs it itself.',
      offTaskCopied: 'Scheduled-task command copied',
      offChainBroken: 'Hash chain is broken at {name}; consider exporting again.',
      offError: 'Last error',
      offNoSchedule: 'No automatic export time',
      offBusyOther: 'Another offsite task is already running, please wait.',
      offPasswordNeeded: 'Enter the recovery password first.',
      offLockedHint: 'Unlock to list archives and restore.',
      offUsage: '{used} / {quota}',
      offDrillUnsupported: 'Drill needs a DSH restart.',

      monTitle: 'Incidents & monitoring',
      monNormal: 'Normal',
      monNormalDesc: 'A heartbeat is written every 5 seconds; crashes, data loss and backup corruption show up here as a red alert.',
      monOpenCount: '{n} unresolved incident(s)',
      monUnsupported: 'Incident monitoring needs a DSH restart (panel updated, host still on the old build).',
      monUnavailable: 'Incident monitoring service is unavailable.',
      monBannerTitle: 'Incident detected',
      monBannerCrash: 'DSH exited unexpectedly at {time} (no clean shutdown). Recommended restore point: {snap}.',
      monBannerDataLoss: 'Data loss detected: {detail}. Recommended restore point: {snap}.',
      monBannerGeneric: '“{kind}” incident detected at {time}.',
      monBannerNoSnap: 'no verified snapshot available',
      monDetectedAt: 'detected {time}',
      monRestore: 'Restore now',
      monRestoring: 'Restoring…',
      monDetails: 'Details',
      monAck: 'Ignore',
      monAckOk: 'Incident ignored',
      monCollapse: 'Collapse',
      monExpand: 'Expand',
      monHeartbeat: 'Last heartbeat',
      monHeartbeatLine: '{time} ({ago})',
      monHeartbeatDead: 'No heartbeat from the UI for {age}; it may be stuck',
      monNever: 'never',
      monWatchdog: 'External watchdog',
      monWatchdogInstalled: 'Installed',
      monWatchdogMissing: 'Not installed',
      monWatchdogOk: 'Running',
      monWatchdogLastCheck: 'last check {time}',
      monWatchdogStale: 'last check was {ago} ago; it may have stopped',
      monWatchdogTask: 'scheduled task {task}',
      monNotify: 'Notification channels',
      monNotifyHint: 'Panel / Windows toast / webhook / email / QQ / peer. Channels are independent; one failing never blocks the others.',
      monVerify: 'Check integrity',
      monVerifying: 'Checking…',
      monVerifyOk: 'Check passed: {n} backups are intact',
      monVerifyBad: '{n} backups have problems (missing or unreadable files)',
      monVerifyAt: 'last check {time}',
      monInstall: 'Install / repair watchdog',
      monInstalling: 'Installing…',
      monInstallOk: 'External watchdog ready: {home}',
      monInstallConfirm: 'This copies the watchdog and recovery console to %LOCALAPPDATA%\\DeepSeek Recovery and registers the scheduled task DSH-DisasterWatchdog. Continue?',
      monInstallNote: 'The watchdog checks the heartbeat and process once a minute. It only records and notifies; it never restarts DSH.',
      monInstallMissing: 'Installer missing: {message}',
      monIncidents: 'Incidents',
      monTimeline: 'Timeline',
      monImpact: 'Affected backups',
      monImpactLocal: 'Local snapshots: {checked} checked, {bad} with problems',
      monImpactOffsite: 'Offsite files: {checked} checked, {bad} with problems',
      monImpactNone: 'No affected backups found',
      monRecommend: 'Recommended restore point',
      monRecommendLine: '{time} · {id}',
      monRecommendVerified: 'verified',
      monRecommendUnverified: 'not verified',
      monNoRecommend: 'No recommended restore point',
      monKindCrash: 'Unexpected exit',
      monKindDataLoss: 'Data loss (Forgotten Tide)',
      monKindHang: 'Hang',
      monKindBackupCorrupt: 'Backup corrupt',
      monKindOffsiteStale: 'Offsite stale',
      monKindDiskLow: 'Disk low',
      monKindOther: 'Other',
      monOpenTag: 'Open',
      monAckTag: 'Ignored',
      monRecoveredTag: 'Recovered',
      monRestoreConfirmTitle: 'Restore the snapshot from {time}?',
      monRestoreConfirmNote: 'A pre-restore snapshot is taken first and overwritten files go to quarantine; DSH must be restarted afterwards.',
      monConfirmRestore: 'Restore',
      monRestoreOk: 'Restored {n} files. Restart DeepSeek Harness.',
      monConfirmInstallTitle: 'Install / repair the external watchdog?',
      monConfirmInstall: 'Install',
      monBaseline: 'Data baseline',
      monBaselineLine: '{files} files · {sessions} sessions · {time}',
      monOutbox: 'Queued notifications',
      monOutboxLine: '{n}',
      monChannelPanel: 'Panel',
      monChannelToast: 'Windows toast',
      monChannelWebhook: 'Webhook',
      monChannelEmail: 'Email',
      monChannelQQ: 'QQ',
      monChannelPeer: 'Offsite device',
      monTlLastHeartbeat: 'Last heartbeat',
      monTlRestart: 'Restart',
      monTlDataBaseline: 'Data baseline',
      monTlDataDrop: 'Data drop',
      monTlDetected: 'Detected',
      monTlAck: 'Ignored',
      monTlRecovered: 'Recovered',
      monTlOther: 'Event',
      monFieldFiles: 'files',
      monFieldSessions: 'sessions',
      monProtectionTitle: 'Incident protection active',
      monProtectionPaused: 'Automatic snapshots are paused (to keep the failure state from being overwritten)',
      monProtectionPinnedList: 'Pinned restore point(s): {ids}',
      monProtectionNote: 'Ignoring the incident or restoring a snapshot automatically restores your previous pause state; pinned restore points are never pruned.',
      monTagAutoPaused: 'Snapshots paused',
      monTagPinned: 'Pinned {id}',
      monDetailsShort: 'Details',
      monError: 'Monitoring error: {message}',

      notifyTitle: 'Notification settings',
      notifyDesc: 'Incident notifications are sent by the external watchdog. Panel / Windows toast / webhook / email / QQ / offsite device channels are independent and can be tested one by one.',
      notifyPanel: 'Panel card',
      notifyPanelDesc: 'Shown at the top of “Incidents & monitoring” and in alerts/current.json (always on).',
      notifyToast: 'Windows toast',
      notifyToastDesc: 'System notification through toast.ps1 (no running DSH required).',
      notifyWebhook: 'Webhook',
      notifyWebhookDesc: 'POST JSON to custom URLs; multiple hooks allowed. Token is optional and stored as DPAPI ciphertext only.',
      notifyHookName: 'Name',
      notifyHookUrl: 'URL',
      notifyHookToken: 'Token (blank = unchanged)',
      notifyHookEnabled: 'Enabled',
      notifyAddHook: 'Add webhook',
      notifyRemove: 'Remove',
      notifyEmail: 'Email (SMTP)',
      notifyEmailDesc: 'Sent through the external notify.ps1; the password is stored as DPAPI ciphertext and never shown.',
      notifySmtpHost: 'SMTP host',
      notifySmtpPort: 'Port',
      notifySmtpSsl: 'SSL/TLS',
      notifySmtpUser: 'Username',
      notifySmtpPassword: 'Password (blank = unchanged)',
      notifySmtpFrom: 'From',
      notifySmtpTo: 'Recipients (comma separated)',
      notifyQQ: 'QQ / OneBot',
      notifyQQDesc: 'Sends a private message through the OneBot HTTP API; failures go to the outbox retry queue.',
      notifyQQHttp: 'OneBot HTTP endpoint',
      notifyQQToken: 'Access token (blank = unchanged)',
      notifyQQAction: 'Action',
      notifyQQTarget: 'Target (QQ / group id)',
      notifyPeer: 'Offsite device',
      notifyPeerDesc: 'Pushes the incident summary to a paired offsite device through dsh-sync (DSH must be running).',
      notifyPeerEnabled: 'Enable offsite device notifications',
      notifyTest: 'Test',
      notifyTesting: 'Testing…',
      notifySave: 'Save notification settings',
      notifySaving: 'Saving…',
      notifySaved: 'Notification settings saved',
      notifyLoadFailed: 'Reading notification settings failed: {message}',
      notifyUnsupported: 'Notification settings need a DSH restart (panel updated, host still on the old build).',
      notifySecretKeep: 'configured; blank keeps it',
      notifySecretEmpty: 'not configured',
      notifyTestOk: 'Notification test passed: {channel}',
      notifyTestFail: 'Notification test failed ({code}): {detail}',
      notifyWatchdogMissing: 'External watchdog is not installed: use “Install / repair watchdog” first',
      notifyTestUnavailable: 'External watchdog is too old: re-run “Install / repair watchdog” and test again',
      notifySaveFailed: 'Saving notification settings failed: {message}',

      help: 'Recovery entry points',
      helpMenu: 'When DSH will not start',
      helpMenuDesc: 'Search “Deepseek恢复” in the Start menu, or run %LOCALAPPDATA%\\DeepSeek Recovery\\scripts\\restore.cmd. No running DSH needed.',
      helpCli: 'Command line',
      helpCliDesc: 'node scripts/cli.mjs list | backup | restore latest | verify latest',
      helpRestart: 'After restoring',
      helpRestartDesc: 'Quit and restart DeepSeek Harness completely: DSH trusts its in-memory state and would write the old state back.',

      agoS: '{n}s ago',
      agoM: '{n}m ago',
      agoH: '{n}h ago',
      agoD: '{n}d ago',
      today: 'Today',
      yesterday: 'Yesterday',
      justNow: 'just now',

      reasonChange: 'Auto',
      reasonManual: 'Manual',
      reasonStartup: 'Startup',
      reasonPreRestore: 'Pre-restore',
      reasonRestore: 'Restore',
      reasonAuto: 'Auto',

      snapMeta: '{files} files · {changed} changed · {size}',
      unknownAction: 'This action needs a DSH restart.',
      restoreToast: 'Restored {n} files. Restart DeepSeek Harness.',
      deleteToast: 'Deleted the backup {id}',
      backupToast: 'Backup done: {files} files, {changed} changed, {size}',
      backupSkipped: 'Nothing changed; no backup needed',
      backupPausedToast: 'Automatic backup is paused; nothing was backed up. Resume automatic backup first.',
      backupDisabledToast: 'Backup is disabled; nothing was backed up.',
      pausedToast: 'Automatic backup paused',
      resumedToast: 'Automatic backup resumed',
      openFailed: 'Could not open folder: {message}',
      actionFailed: '{action} failed: {message}',
      /* v0.7 new layout */
      tabBackup: 'Backup & restore',
      tabSettings: 'Settings',
      pillNormal: 'Protected',
      pillIncident: 'Needs action',
      pillPaused: 'Paused',
      pillEmpty: 'Off',
      pillRestored: 'Restart needed',

      protectTitle: 'Your data is being protected',
      protectDesc: 'Backups run whenever files change, at most every {interval}. Last one {ago}; {count} backups covering about {days} days.',
      lastBackupLabel: 'Last backup',
      intervalLabel: 'Interval',
      historyLabel: 'Points',
      usageLabel: 'On disk',
      whereLabel: 'Where backups live',
      restoreOpen: 'Restore data…',
      backupNow: 'Back up now',
      viewRecords: 'Restore history',
      checkLine: 'This backup has not been checked yet',
      checkOkLine: 'Check passed: this backup can be fully restored',
      checkNow: 'Check backup health',
      checkUnsupportedLine: 'Checking integrity needs a DSH restart.',
      unitCountPlain: '{n}',

      incidentTitle: 'Data may be lost — restore now',
      incidentDesc: 'DSH exited unexpectedly at {time}; sessions dropped from {before} to {after}. Recommended restore point: {snap}.',
      incidentDescGeneric: '“{kind}” incident detected at {time}. Recommended restore point: {snap}.',
      incidentNoSnap: '“{kind}” incident detected at {time}, but no restore point is available.',
      restoreTo: 'Restore {snap}',
      pickAnother: 'Pick another time…',
      ignoreIncident: 'Ignore for now',
      incidentFoot: 'The current state is saved first (you can roll back); DSH must be restarted afterwards.',
      monProtectionShort: 'Automatic backup paused; restore point pinned',

      pausedTitle: 'Automatic backup is paused',
      pausedDesc: 'Paused at {time}. Changes since then are not backed up; if something goes wrong you can only restore to before that time.',
      pausedDescNoTime: 'Changes since then are not backed up; if something goes wrong you can only restore to the last backup before the pause.',
      resumeAuto: 'Resume automatic backup',
      backupOnceNow: 'Back up once now',
      resumeAndBackup: 'Resume and back up once',
      pausedFoot: 'The {n} existing restore points are unaffected and can still be restored.',

      emptyTitle: 'No backup yet — start with one',
      emptyDesc: 'A backup is a copy of your data. Files are backed up automatically when they change, so you can return to an earlier point.',
      startProtect: 'Create the first backup',
      emptyFoot: 'Backups are stored in {store}, outside the DSH data folder — even if .dsh is deleted they survive.',

      restoredTitle: 'Restored to {time}',
      restoredDesc: 'Wrote {restored} files; kept {kept} newer files that were not in the backup (nothing deleted). The previous state was archived.',
      rollback: 'Go back to the previous state',
      rollbackMissing: 'No pre-restore archive was found; cannot roll back.',
      restartBannerTitle: 'Restore finished — restart DeepSeek Harness to apply it.',
      restartBannerDesc: 'Until you restart, DSH may still show the old data. This notice disappears after the restart.',
      restartFoot: 'Takes effect after restarting DeepSeek Harness. This notice stays until then.',

      rescueTitle: 'What if DeepSeek will not start?',
      rescueDesc: 'No need to open DSH: search “DeepSeek Recovery” in the Start menu and run it; it repairs the data first, then starts DSH.',

      pickerTitle: 'Restore to which time?',
      pickerDesc: 'Pick a moment; DSH returns to that state. The current state is saved first.',
      pickerSearch: 'Search a date, e.g. 10-27',
      pickerEarlier: 'Earlier',
      pickerKeepDaily: '1 per day, {n} days',
      pickerLatest: 'Latest',
      pickerRecommended: 'Suggested',
      pickerStale: 'After incident',
      pickerManual: 'Manual',
      pickerCount: '{n}',
      pickerEmpty: 'No matching backup.',
      pickerNoSnapshots: 'No backups yet — create one first.',

      confirmRestoreTitle: 'Restore to {time}?',
      confirmRestoreSub: 'This backup contains {files} files; content is verified before restoring and the restore stops if data is missing.',
      confirmRestoreSubPlain: 'This backup contains {files} files.',
      effectChanged: '{n} files go back to their {time} version',
      effectSaved: 'The current state is saved first — you can undo this restore',
      effectKept: '{n} newer files not in this backup are kept, not deleted',
      effectUnknown: 'Comparing files…',
      filesToggle: 'Which files will change',
      filesMore: '… and {n} more files',
      filesUnsupported: 'This host cannot list files; the restore itself is unaffected.',
      previewFailed: 'Could not preview this restore: {message}',
      restoreFailed: 'Restore did not finish: {message}',
      restoringNow: 'Restoring…',
      restartWarn: 'After restoring, close and reopen DeepSeek Harness.',
      confirmRestoreBtn: 'Restore now',
      confirmDeleteTitle: 'Delete the backup from {time}?',
      confirmDeleteNote: 'This cannot be undone. Only this backup is deleted; the others are untouched.',
      confirmDeleteBtn: 'Delete backup',

      settingsAuto: 'Automatic backup',
      settingsAutoDesc: 'Backs up whenever files change; nothing to manage.',
      settingsAutoVal: 'Checks for changes every {interval}',
      settingsKeep: 'How long to keep',
      settingsKeepDesc: 'Old backups are pruned automatically so the disk never fills up.',
      settingsKeepVal: 'Latest {last} kept; 1 per hour for {hours} h, 1 per day for {days} days',
      settingsStore: 'Where backups live',
      settingsStoreDesc: 'Must be outside the DSH data folder, so a wiped folder can still be restored.',
      settingsOffsite: 'Offsite copy',
      settingsOffsiteDesc: 'Encrypts and copies backups to another machine daily — survives losing both.',
      settingsOffsiteOff: 'Off',
      settingsOffsiteOn: 'On',
      settingsNotify: 'Tell me about failures',
      settingsNotifyDesc: 'Alerts on crash, data loss or a corrupted backup.',
      settingsWatchdog: 'External guard',
      settingsWatchdogDesc: 'Checks DSH once a minute in case it hangs or crashes.',
      settingsWatchdogRunning: 'Running',
      settingsWatchdogMissing: 'Not installed',
      settingsAdvanced: 'Advanced',
      settingsNotifyOn: 'On',
      settingsNotifyOff: 'Off',
      settingsAdvancedDesc: 'Excludes, command line, last error, about Casket.',
      settingsAdjust: 'Adjust',
      settingsView: 'View',
      settingsGo: 'Configure',
      subBack: 'Back',
      subRetention: 'Cadence & cleanup',
      subAdvanced: 'Advanced',
      subRecords: 'Restore history',
      subMonitor: 'Incidents & watchdog',
      subOffsite: 'Offsite copy',
      subNotify: 'Notifications',
      retentionInterval: 'Backup interval',
      retentionIntervalDesc: 'Minimum seconds between two automatic backups.',
      retentionKeepLast: 'Keep recent',
      retentionKeepLastDesc: 'The newest N are always kept, regardless of the tiered rules below.',
      retentionMax: 'Hard limit',
      retentionMaxDesc: 'Snapshots beyond this count are pruned oldest-first; also the disk-usage cap.',
      retentionHourly: 'Keep hourly',
      retentionHourlyDesc: 'For older snapshots, keep one per hour within this many hours.',
      retentionDaily: 'Keep daily',
      retentionDailyDesc: 'For even older snapshots, keep one per day within this many days.',
      retentionExcludes: 'Excludes',
      retentionExcludesDesc: 'Path patterns; “/” means prefix, “*” means suffix. Comma separated.',
      retentionUnsaved: 'Unsaved',
      advancedRoot: 'Backup root',
      advancedRecords: 'Restore history',
      advancedRecordsDesc: '{n} entries; overwritten files are kept in quarantine.',
      advancedCli: 'Command line',
      advancedCliDesc: 'Restore from the command line even when DSH cannot start.',
      aboutTitle: 'About Casket',
      aboutDesc: 'First seat of the Order of Seekers (Ordo Quaerentium): archive, rewind and quarantine the whole data folder; no search, no association.',
      aboutNote: '“Keep a copy before you lose it.”',

      /* v0.8 UI */
      tabOverview: 'Overview',
      tabBackups: 'Backups',
      tabRestore: 'Restore',
      tabSettings: 'Settings',
      subStore: 'Backup location',
      retentionPace: 'Backup cadence',
      integrity: 'Integrity',
      integrityUnchecked: 'This backup has not been checked yet',
      integrityChecking: 'Checking integrity…',
      integrityOk: 'Check passed: all {files} files can be restored',
      integrityBad: '{n} files are missing data; this backup cannot be fully restored',
      integrityUnsupported: 'Integrity check needs a DSH restart.',
      integrityAt: 'checked at {time}',
      integrityRecheck: 'Check again',
      checkRecommend: 'Check this restore point',
      activity: 'Recent activity',
      activityAll: 'All records',
      activityEmpty: 'No activity yet. Backups, checks, restores and incidents show up here.',
      actBackup: 'Backup',
      actCheck: 'Check',
      actRestore: 'Restore',
      actIncident: 'Incident',
      actBackupDone: '{reason} backup finished',
      actCheckDone: 'Integrity check passed',
      actRestoreDone: 'Restored to {time}',
      actIncidentSeen: 'Detected {kind}',
      actIncidentDesc: 'Sessions went from {before} to {after}',
      backupNotice: 'Backups taken after the incident are not recommended; recommended restore point: {time}.',
      backupNoticeAction: 'View recommended',
      backupTotal: '{n} · {size}',
      backupSearch: 'Search date or id, e.g. 10-29',
      backupLatest: 'Latest',
      backupNoMatch: 'No matching backups',
      backupNoMatchDesc: 'Try another date or id, e.g. 10-29.',
      retentionNote: 'Retention: latest {last}; older ones hourly within {hours} h, daily within {days} days.',
      retentionAdjust: 'Adjust retention',
      restoreRecords: 'Restore history',
      restoreRecordsCount: '· {n}',
      restoreRecordMeta: 'restored {restored} · skipped {unchanged} · quarantined {quarantined} · extra {extra}',
      restoreArchives: 'Pre-restore archives',
      restoreArchivesDesc: 'Overwritten files, kept for individual recovery',
      restoreArchivesEmpty: 'No archives yet. The next restore creates one automatically.',
      restoreIncidents: 'Incident history',
      restoreIncidentsDesc: 'Context for restores',
      restoreIncidentOpen: '{n} open incident(s)',
      restoreIncidentNone: 'No open incidents',
      restoreIncidentLine: '{time} · sessions {before} → {after} · recommended {rec}',
      restoreOpenQuarantine: 'Open quarantine',
      restoreBackPre: 'Back to pre-restore',
      restoreQuarantineRow: '{files} files, kept as they were before the restore',
      settingsGroupBackup: 'Backup',
      settingsGroupProtect: 'Protection',
      settingsGroupIncident: 'Incidents',
      settingsGroupOther: 'Other',
      settingsAdvancedAbout: 'Advanced & about',
      rescueSteps: 'Three steps',
      rescueShow: 'View steps',
      rescueHide: 'Hide steps',
      rescueStep1: 'Search “Deepseek Recovery” in the Start menu and run it.',
      rescueStep2: 'Pick a point in time (the latest before the incident is recommended).',
      rescueStep3: 'DSH starts automatically after the restore; no manual copying.',
      emptyIncludes: 'The first backup includes',
      emptyIncludesDesc: '{files} files: sessions, workspaces, settings and credentials; large re-installable folders such as dsh-runtimes are excluded.',
      incidentSectionTitle: 'Incident',
      incidentRecommended: 'Recommended restore point',
      recVerifyNote: 'Content is verified before restoring; missing data aborts the restore.',
      incidentProtection: 'Incident protection is active',
      incidentProtectionDesc: 'Automatic backups are paused (to avoid overwriting the scene) and {id} is pinned so it will not be pruned.',
      incidentMore: '{n} open incident(s) remain',
      incidentMoreDesc: 'A restore does not resolve the incident; confirm and acknowledge it in “Incidents & watchdog”.',
      incidentSee: 'View',
      incidentSwitchTime: 'Pick another time…',
      incidentLater: 'Later',
      incidentRestoreTo: 'Restore to {time}',
      modalClose: 'Close',
      saveDiscard: 'Discard',
      storeCurrent: 'Current backup root',
      storeModify: 'Change location',
      storeNew: 'New location',
      storeValidate: 'Validate path',
      storeSave: 'Save',
      storeValid: 'Path is usable',
      storeNote: 'Saving rewrites the root line in the profile cordis.patch.yml; a DSH restart is required. Old backups stay where they are.',
      storeOccupied: 'Used',
      noError: 'None',
      settingsOffsiteValue: '{name} · {state} · daily at {time}',
      settingsNotifyValue: 'Panel · Windows notifications · Webhook · Email · Peer device',
      settingsWatchdogValue: 'Last check {time}',
      monitorRunning: 'Status',
      monitorHeartbeatDesc: 'A heartbeat is written every 5 seconds',
      monitorWatchdogDesc: 'Checked every minute; records and notifies only, never restarts DSH',
      monitorNoIncident: 'No open incidents',
      monitorNoIncidentDesc: 'No abnormal exit in the last 30 days.',
      monitorResolved: 'Resolved incidents',
      monitorNoResolved: 'No resolved incidents yet',
      monitorNotifySummary: 'Notification channels',
      monitorNotifyGo: 'Open settings',
      notifyPanelFixed: 'Always on',
      notifyConfigQQ: 'Configure',
      notifyDescShort: 'Incident notifications are sent by the external watchdog; channels are independent.',
      aboutVersion: 'Version',
      offLockedShort: 'Locked',
      offUnlockedShort: 'Unlocked',
      offEnableShort: 'Enabled',
      offDisabledShort: 'Disabled',

      checking: 'Checking integrity…',
      durationSec: '{n} s',
      durationMin: '{n} min',
      durationHour: '{n} h',
      snapFiles: '{n} files',
    }

    /* ------------------------------------------------------------------ 样式 */

    const css = `
.dbk-page {
  --dbk-accent: var(--dsw-alias-state-business-primary, #4176e6);
  --dbk-accent-soft: color-mix(in srgb, var(--dbk-accent) 14%, transparent);
  --dbk-hair: var(--dsw-alias-border-l2, rgba(128, 128, 128, .22));
  --dbk-hair-strong: var(--dsw-alias-border-l4, rgba(128, 128, 128, .32));
  --dbk-surface: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, .06)));
  --dbk-stroke: var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, rgba(128, 128, 128, .28)));
  --dbk-field-w: 240px;
  --dbk-field-h: 30px;
  /* 第一席 · 忆匣：席位色只用于品牌记号与署名，语义色仍走 DSH token */
  --dbk-brand: #b45309;
  --dbk-brand-soft: color-mix(in srgb, var(--dbk-brand) 13%, transparent);
  --dbk-ok-ink: #15803d;
  --dbk-warn-ink: #b45309;
  --dbk-err-ink: #b91c1c;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  height: 100%;
  max-height: 100dvh;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: 20px 28px 56px;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
  -webkit-font-smoothing: antialiased;
  overflow-wrap: anywhere;
}
/* 内容列限宽居中：滚动条仍然贴面板右缘，和原生页面一致。
   toast 是 fixed 浮层，不参与这条限宽。 */
.dbk-page > * { max-width: 860px; width: 100%; margin-left: auto; margin-right: auto; }
.dbk-page > .dbk-toast { max-width: none; width: auto; margin-left: 0; margin-right: 0; }
.dbk-page *, .dbk-page *::before, .dbk-page *::after { box-sizing: border-box; }
.dbk-page > * { flex: none; }

/* ---------- 页头 ---------- */
.dbk-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.dbk-head-main { display: flex; gap: 12px; min-width: 0; }
.dbk-mark {
  width: 34px; height: 34px; flex: none; border-radius: 10px;
  display: grid; place-items: center; color: var(--dbk-brand);
  background: var(--dbk-brand-soft);
  border: .5px solid color-mix(in srgb, var(--dbk-brand) 26%, transparent);
}
.dbk-title { font-size: 16px; line-height: 24px; font-weight: 500; }
.dbk-sub { margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-head-actions { display: flex; align-items: center; gap: 8px; flex: none; padding-top: 2px; }

/* ---------- 按钮 ---------- */
.dbk-btn {
  appearance: none; border: 0; background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit; font-size: 13px; line-height: 20px; font-weight: 400;
  height: 28px; padding: 0 10px; border-radius: var(--dsw-radius-sm, 8px);
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  white-space: nowrap; cursor: pointer; user-select: none;
  transition: background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease),
              color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease),
              opacity var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease);
}
.dbk-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, .14)); }
.dbk-btn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, rgba(128, 128, 128, .2)); }
.dbk-btn:disabled { opacity: .45; cursor: default; }
.dbk-btn:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dbk-accent));
  outline-offset: 2px;
}
.dbk-btn.primary {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font-weight: 500; padding: 0 12px;
}
.dbk-btn.primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary));
  opacity: .92;
}
.dbk-btn.primary:active:not(:disabled) { opacity: 1; }
.dbk-btn.ghost { border: .5px solid var(--dbk-hair-strong); }
.dbk-btn.ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, .14)); }
.dbk-btn.danger { color: var(--dsw-alias-state-error-primary, #e0645c); }
.dbk-btn.danger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, .06));
}
.dbk-btn.small { height: 24px; padding: 0 8px; font-size: 12px; line-height: 18px; border-radius: var(--dsw-radius-xs, 4px); }
.dbk-btn.icon { width: 28px; padding: 0; }
.dbk-spin {
  width: 12px; height: 12px; flex: none; border-radius: 50%;
  border: 1.5px solid currentColor; border-top-color: transparent;
  animation: dbk-rot .7s linear infinite;
}
@keyframes dbk-rot { to { transform: rotate(360deg); } }

/* ---------- 状态药丸 ---------- */
.dbk-status {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 10px; border-radius: 999px;
  border: .5px solid var(--dbk-hair);
  background: var(--dsw-alias-bg-module-platform, rgba(128, 128, 128, .06));
  color: var(--dsw-alias-label-secondary, #8a8f98);
  font-size: 12px; line-height: 18px; white-space: nowrap;
}
.dbk-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; position: relative; background: var(--dsw-alias-label-caption, #9aa0a6); }
.dbk-dot.ok { background: var(--dsw-alias-state-success-primary, #22c55e); }
.dbk-dot.warn { background: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dbk-dot.err { background: var(--dsw-alias-state-error-primary, #ef5350); }
.dbk-dot.off { background: var(--dsw-alias-label-caption, #9aa0a6); }
.dbk-dot.live::after {
  content: ""; position: absolute; inset: -3px; border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, currentColor 45%, transparent);
  animation: dbk-pulse 2.4s ease-out infinite;
}
.dbk-dot.live.ok::after { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 45%, transparent); }
.dbk-dot.live.warn::after { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 45%, transparent); }
.dbk-dot.live.err::after { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef5350) 45%, transparent); }
@keyframes dbk-pulse {
  0% { opacity: .85; transform: scale(.65); }
  70% { opacity: 0; transform: scale(1.4); }
  100% { opacity: 0; transform: scale(1.4); }
}

/* ---------- 仪表盘 ---------- */
.dbk-hero {
  margin-top: 18px; padding: 16px 18px;
  border: .5px solid var(--dbk-stroke); border-radius: var(--dsw-radius-md, 12px);
  background: var(--dbk-surface);
  animation: dbk-in .22s ease-out both;
}
@keyframes dbk-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.dbk-hero-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.dbk-hero-status { display: flex; align-items: center; gap: 8px; font-size: 14px; line-height: 22px; font-weight: 500; }
.dbk-hero-meta { margin-top: 3px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8f98); font-variant-numeric: tabular-nums; }
.dbk-stats { display: flex; flex: none; }
.dbk-stat { min-width: 86px; padding: 0 14px; border-left: .5px solid var(--dbk-hair); }
.dbk-stat:first-child { border-left: 0; padding-left: 0; }
.dbk-stat:last-child { padding-right: 0; }
.dbk-stat-val { font-size: 18px; line-height: 26px; font-weight: 600; letter-spacing: -.2px; font-variant-numeric: tabular-nums; }
.dbk-stat-label { margin-top: 1px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-ret { margin-top: 14px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.dbk-retbar {
  flex: 1; min-width: 160px; display: flex; height: 6px; border-radius: 999px;
  overflow: hidden; background: var(--dsw-alias-bg-skeleton, rgba(128, 128, 128, .14));
}
.dbk-retseg { height: 100%; }
.dbk-retseg.a { background: var(--dbk-accent); }
.dbk-retseg.b { background: color-mix(in srgb, var(--dbk-accent) 58%, transparent); }
.dbk-retseg.c { background: color-mix(in srgb, var(--dbk-accent) 30%, transparent); }
.dbk-legend { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #8a8f98); font-variant-numeric: tabular-nums; }
.dbk-legend i { display: inline-block; width: 7px; height: 7px; border-radius: 2px; margin-right: 4px; vertical-align: .5px; }
.dbk-legend i.a { background: var(--dbk-accent); }
.dbk-legend i.b { background: color-mix(in srgb, var(--dbk-accent) 58%, transparent); }
.dbk-legend i.c { background: color-mix(in srgb, var(--dbk-accent) 30%, transparent); }
.dbk-legend-cap { margin-left: auto; white-space: nowrap; color: var(--dsw-alias-label-secondary, #8a8f98); }

/* ---------- 分区 / 行 ---------- */
.dbk-section { margin-top: 26px; }
.dbk-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 22px; flex-wrap: wrap; }
.dbk-section-title { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary, #8a8f98); }
.dbk-section-side { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8f98); flex-wrap: wrap; }
.dbk-rows { margin-top: 2px; border-top: .5px solid var(--dbk-hair); }
.dbk-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 14px 0; border-bottom: .5px solid var(--dbk-hair); }
.dbk-row:last-child { border-bottom: 0; }
.dbk-row-main { flex: 1; min-width: 0; }
.dbk-row-title { font-size: 14px; line-height: 22px; font-weight: 400; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dbk-row-desc { margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-row-note { margin-top: 2px; font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-row-desc.mono { font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); font-size: 11.5px; line-height: 17px; }
.dbk-row-desc.err { color: var(--dsw-alias-state-error-primary, #e0645c); }
.dbk-row-action { flex: none; display: flex; align-items: center; gap: 8px; }

/* ---------- 开关（原生尺寸） ---------- */
.dbk-switch {
  position: relative; flex: none; width: 36px; height: 20px; padding: 2px;
  border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3, rgba(128, 128, 128, .45));
  cursor: pointer; transition: background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease);
}
.dbk-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary, #111); }
.dbk-switch:disabled { opacity: .5; cursor: default; }
.dbk-switch:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dbk-accent)); outline-offset: 2px; }
.dbk-knob {
  display: block; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, #fff);
  transition: transform var(--ds-transition-duration-fast, .12s) var(--ds-ease-in-out, ease);
}
.dbk-switch[aria-checked="true"] .dbk-knob {
  background: var(--dsw-alias-label-primary-foreground, #fff);
  transform: translateX(16px);
}

/* ---------- 输入 ---------- */
.dbk-input {
  height: var(--dbk-field-h); width: var(--dbk-field-w); padding: 0 10px;
  border: .5px solid var(--dbk-hair-strong); border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-module-platform, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit; font-size: 13px; line-height: 18px; text-align: right;
  font-variant-numeric: tabular-nums;
  transition: border-color var(--ds-transition-duration-fast, .1s) ease, box-shadow var(--ds-transition-duration-fast, .1s) ease;
}
.dbk-input:hover { border-color: var(--dsw-alias-border-l3, rgba(128, 128, 128, .4)); }
.dbk-input:focus { outline: none; border-color: var(--dbk-accent); box-shadow: 0 0 0 2px var(--dbk-accent-soft); }
.dbk-input.wide { width: min(100%, 420px); max-width: 46vw; text-align: left; font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); font-size: 11.5px; }
/* 统一设置输入框：文本/密码/下拉同宽同高（task-14） */
.dbk-field-input {
  height: var(--dbk-field-h); width: var(--dbk-field-w); max-width: 100%;
  padding: 0 10px; box-sizing: border-box;
  border: .5px solid var(--dbk-hair-strong); border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-module-platform, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit; font-size: 13px; line-height: 18px; text-align: left;
  transition: border-color var(--ds-transition-duration-fast, .1s) ease, box-shadow var(--ds-transition-duration-fast, .1s) ease;
}
.dbk-field-input:hover { border-color: var(--dsw-alias-border-l3, rgba(128, 128, 128, .4)); }
.dbk-field-input:focus { outline: none; border-color: var(--dbk-accent); box-shadow: 0 0 0 2px var(--dbk-accent-soft); }
.dbk-field-input.small { width: 120px; }
.dbk-select { padding-right: 8px; appearance: auto; }
.dbk-field-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dbk-row-note.err { color: var(--dsw-alias-state-error-primary, #e0645c); }
.dbk-section-head.dbk-clickable {
  cursor: pointer; border-radius: var(--dsw-radius-sm, 8px);
  margin-left: -6px; padding-left: 6px; padding-right: 6px;
  transition: background var(--ds-transition-duration-fast, .1s) ease;
}
.dbk-section-head.dbk-clickable:hover { background: var(--dbk-surface); }
.dbk-section-head.dbk-clickable:focus-visible { outline: 2px solid var(--dbk-accent); outline-offset: 1px; }
.dbk-section-head.dbk-subhead { margin-top: 8px; }
.dbk-section-toggle { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-chev.open { transform: rotate(90deg); }
.dbk-notify-block { margin-top: 12px; padding-top: 10px; border-top: .5px solid var(--dbk-hair); }
.dbk-notify-body { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.dbk-notify-hook { padding: 8px 0 2px; border-top: .5px dashed var(--dbk-hair); }
.dbk-notify-hook:first-of-type { border-top: 0; }
.dbk-unit { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-field { display: flex; align-items: center; gap: 8px; }
.dbk-stepper {
  display: inline-flex; align-items: center; justify-content: space-between; gap: 8px;
  width: var(--dbk-field-w); max-width: 100%; box-sizing: border-box;
  height: var(--dbk-field-h); padding: 0 10px;
  border: .5px solid var(--dbk-hair-strong); border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-module-platform, transparent);
  transition: border-color var(--ds-transition-duration-fast, .1s) ease, box-shadow var(--ds-transition-duration-fast, .1s) ease;
}
.dbk-stepper:hover { border-color: var(--dsw-alias-border-l3, rgba(128, 128, 128, .4)); }
.dbk-stepper:focus-within { border-color: var(--dbk-accent); box-shadow: 0 0 0 2px var(--dbk-accent-soft); }
.dbk-stepper input {
  width: 52px; padding: 0; border: 0; outline: none; background: transparent;
  color: var(--dsw-alias-label-primary, inherit); font: inherit; font-size: 13px;
  text-align: right; font-variant-numeric: tabular-nums;
}
.dbk-stepper-unit { margin-left: 3px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8f98); }

/* ---------- 徽标 / 检查结果 ---------- */
.dbk-badge {
  display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 6px;
  border-radius: var(--dsw-radius-xs, 4px); font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-secondary, #8a8f98);
  background: var(--dsw-alias-bg-module-platform, rgba(128, 128, 128, .08));
  white-space: nowrap;
}
.dbk-badge.manual { color: var(--dbk-accent); background: var(--dbk-accent-soft); }
.dbk-badge.pre {
  color: var(--dbk-warn-ink);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 14%, transparent);
}
.dbk-badge.restore {
  color: var(--dbk-ok-ink);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 13%, transparent);
}
.dbk-badge.muted { color: var(--dsw-alias-label-tertiary, #8a8f98); background: transparent; border: .5px solid var(--dbk-hair); }
.dbk-check {
  margin: 0 0 12px; padding: 10px 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  border: .5px solid var(--dbk-hair); border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-module-platform, rgba(128, 128, 128, .05));
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #8a8f98);
}
.dbk-check.ok { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 38%, var(--dbk-hair)); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 9%, transparent); }
.dbk-check.bad { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef5350) 42%, var(--dbk-hair)); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef5350) 9%, transparent); color: var(--dsw-alias-state-error-primary, #e0645c); }
.dbk-check.warn { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 42%, var(--dbk-hair)); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 9%, transparent); }
.dbk-protect-title { font-weight: 500; color: var(--dsw-alias-label-primary, inherit); }
.dbk-protect-line { margin-top: 2px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.dbk-protect-note { flex-basis: 100%; margin-top: 2px; font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-check .dbk-ico { flex: none; display: inline-flex; }
.dbk-check-files { flex-basis: 100%; font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-check-time { color: var(--dsw-alias-label-tertiary, #8a8f98); font-variant-numeric: tabular-nums; }
.dbk-check-ok-text { color: var(--dsw-alias-label-primary, inherit); }

/* ---------- 快照时间线 ---------- */
.dbk-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 8px 0 4px; }
.dbk-search { position: relative; flex: 1; min-width: 180px; max-width: 320px; }
.dbk-search .dbk-ico { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); color: var(--dsw-alias-label-tertiary, #8a8f98); pointer-events: none; display: inline-flex; }
.dbk-search input {
  width: 100%; height: 30px; padding: 0 10px 0 28px;
  border: .5px solid var(--dbk-hair-strong); border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-module-platform, transparent);
  color: var(--dsw-alias-label-primary, inherit); font: inherit; font-size: 12px; line-height: 18px;
}
.dbk-search input:focus { outline: none; border-color: var(--dbk-accent); box-shadow: 0 0 0 2px var(--dbk-accent-soft); }
.dbk-search input::placeholder { color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-toolbar-side { display: flex; align-items: center; gap: 8px; margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a8f98); }

.dbk-day {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 14px 0 6px; border: 0; background: transparent; color: inherit;
  font: inherit; cursor: pointer; text-align: left;
}
.dbk-day:hover .dbk-day-label { color: var(--dsw-alias-label-primary, inherit); }
.dbk-day:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dbk-accent)); outline-offset: 2px; border-radius: 4px; }
.dbk-day-label { font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); }
.dbk-day-count { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8f98); font-variant-numeric: tabular-nums; }
.dbk-day-line { flex: 1; height: .5px; background: var(--dbk-hair); }
.dbk-chev { display: inline-flex; color: var(--dsw-alias-label-tertiary, #8a8f98); transition: transform var(--ds-transition-duration-fast, .12s) var(--ds-ease-in-out, ease); }
.dbk-day[aria-expanded="true"] .dbk-chev { transform: rotate(90deg); }

.dbk-snap {
  display: flex; align-items: center; gap: 14px; padding: 9px 6px; margin: 0 -6px;
  border-top: .5px solid var(--dbk-hair); border-radius: var(--dsw-radius-xs, 4px);
}
.dbk-snap:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, .08)); }
.dbk-snap-time { flex: none; width: 48px; font-size: 13px; line-height: 20px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary, inherit); }
.dbk-snap-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dbk-snap-meta { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8f98); font-variant-numeric: tabular-nums; }
.dbk-snap-actions { flex: none; display: flex; align-items: center; gap: 2px; opacity: .6; transition: opacity var(--ds-transition-duration-fast, .12s) ease; }
.dbk-snap:hover .dbk-snap-actions, .dbk-snap:focus-within .dbk-snap-actions { opacity: 1; }
.dbk-snap-wrap { border-bottom: 0; }
.dbk-more { padding: 6px 0 10px; }

/* ---------- 确认面板 ---------- */
.dbk-confirm {
  margin: 4px 0 12px; padding: 14px 16px;
  border: .5px solid var(--dbk-stroke); border-radius: var(--dsw-radius-md, 12px);
  background: var(--dbk-surface);
  font-size: 12px; line-height: 18px;
  animation: dbk-in .18s ease-out both;
}
.dbk-confirm-title { font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); }
.dbk-confirm-grid { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 8px; }
.dbk-kv { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8f98); font-variant-numeric: tabular-nums; }
.dbk-kv b { color: var(--dsw-alias-label-primary, inherit); font-weight: 500; }
.dbk-confirm-note { margin-top: 8px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-confirm-note.warn { color: var(--dsw-alias-state-warn-label, #b45309); }
.dbk-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.dbk-preview-load { display: inline-flex; align-items: center; gap: 8px; margin-top: 8px; color: var(--dsw-alias-label-tertiary, #8a8f98); }

/* ---------- 提示条 ---------- */
.dbk-banner {
  display: flex; align-items: flex-start; gap: 10px;
  margin-top: 14px; padding: 12px 14px;
  border: .5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 42%, var(--dbk-hair));
  border-radius: var(--dsw-radius-sm, 8px);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 10%, transparent);
  font-size: 12px; line-height: 18px;
}
.dbk-banner-main { flex: 1; min-width: 0; }
.dbk-banner-title { display: flex; align-items: center; gap: 6px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); }
.dbk-banner-desc { margin-top: 2px; color: var(--dsw-alias-label-secondary, #8a8f98); }

/* ---------- 空态 / 骨架 / 进度 ---------- */
.dbk-empty {
  margin-top: 12px; padding: 26px 16px; text-align: center;
  border: .5px dashed var(--dbk-hair-strong); border-radius: var(--dsw-radius-md, 12px);
  color: var(--dsw-alias-label-tertiary, #8a8f98); font-size: 13px; line-height: 20px;
}
.dbk-skel { padding: 10px 0; border-top: .5px solid var(--dbk-hair); }
.dbk-skel-bar {
  height: 10px; border-radius: 5px;
  background: linear-gradient(90deg, var(--dsw-alias-bg-skeleton, rgba(128,128,128,.12)), transparent, var(--dsw-alias-bg-skeleton, rgba(128,128,128,.12)));
  background-size: 200% 100%;
  animation: dbk-shimmer 1.4s ease-in-out infinite;
}
.dbk-skel-bar + .dbk-skel-bar { margin-top: 8px; width: 60%; }
@keyframes dbk-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.dbk-progress {
  position: relative; height: 4px; margin-top: 10px; border-radius: 999px; overflow: hidden;
  background: var(--dsw-alias-bg-skeleton, rgba(128, 128, 128, .14));
}
.dbk-progress::after {
  content: ""; position: absolute; inset: 0 auto 0 0; width: 38%; border-radius: 999px;
  background: linear-gradient(90deg, transparent, var(--dbk-accent), transparent);
  animation: dbk-slide 1.2s ease-in-out infinite;
}
@keyframes dbk-slide { from { transform: translateX(-100%); } to { transform: translateX(320%); } }

/* ---------- Toast ---------- */
.dbk-toast {
  position: fixed; left: 50%; bottom: 28px; z-index: 80;
  display: flex; align-items: center; gap: 8px;
  max-width: min(560px, 82vw); padding: 8px 14px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-toast-bg, #353638);
  color: var(--dsw-alias-toast-label, #fff);
  font-size: 12px; line-height: 18px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .28);
  pointer-events: none;
  animation: dbk-toast-in .18s ease-out both;
}
@keyframes dbk-toast-in { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translate(-50%, 0); } }
.dbk-toast .dbk-ico { flex: none; }

/* ---------- 帮助 ---------- */
.dbk-code {
  font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace);
  font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-secondary, #8a8f98);
  white-space: pre-wrap;
}
.dbk-foot {
  margin-top: auto; padding-top: 12px; border-top: .5px solid var(--dbk-hair);
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #6b7280);
  display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;
}
.dbk-foot-brand { color: var(--dbk-brand); }

/* ---------- 异地副本 ---------- */
.dbk-off-lock {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin: 8px 0 2px; padding: 12px 14px;
  border: .5px solid var(--dbk-hair); border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-module-platform, rgba(128, 128, 128, .05));
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #8a8f98);
}
.dbk-off-lock .dbk-ico { flex: none; color: var(--dbk-accent); display: inline-flex; }
.dbk-off-lock-main { flex: 1; min-width: 140px; }
.dbk-off-lock-title { font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); }
.dbk-off-form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.dbk-off-pass {
  height: 30px; width: 218px; max-width: 52vw; padding: 0 10px;
  border: .5px solid var(--dbk-hair-strong); border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-module-platform, transparent);
  color: var(--dsw-alias-label-primary, inherit); font: inherit; font-size: 13px; line-height: 18px;
  transition: border-color var(--ds-transition-duration-fast, .1s) ease, box-shadow var(--ds-transition-duration-fast, .1s) ease;
}
.dbk-off-pass:hover { border-color: var(--dsw-alias-border-l3, rgba(128, 128, 128, .4)); }
.dbk-off-pass:focus { outline: none; border-color: var(--dbk-accent); box-shadow: 0 0 0 2px var(--dbk-accent-soft); }
.dbk-off-pass::placeholder { color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-off-hint { flex-basis: 100%; text-align: right; font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-off-hint.err { color: var(--dsw-alias-state-error-primary, #e0645c); }
.dbk-off-tags { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dbk-off-tag {
  display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 6px;
  border-radius: var(--dsw-radius-xs, 4px); font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-secondary, #8a8f98);
  background: var(--dsw-alias-bg-module-platform, rgba(128, 128, 128, .08));
  white-space: nowrap;
}
.dbk-off-tag.ok { color: var(--dbk-ok-ink); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 13%, transparent); }
.dbk-off-tag.warn { color: var(--dbk-warn-ink); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 14%, transparent); }
.dbk-off-tag.err { color: var(--dbk-err-ink); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef5350) 12%, transparent); }
.dbk-off-tag.quiet { color: var(--dsw-alias-label-tertiary, #8a8f98); background: transparent; border: .5px solid var(--dbk-hair); }
.dbk-off-prog { margin: 10px 0 2px; }
.dbk-off-prog-bar { height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-skeleton, rgba(128, 128, 128, .14)); overflow: hidden; }
.dbk-off-prog-fill {
  height: 100%; border-radius: 999px; background: var(--dbk-accent);
  transition: width .25s var(--ds-ease-in-out, ease);
}
.dbk-off-prog-fill.indet {
  width: 38% !important; animation: dbk-slide 1.2s ease-in-out infinite;
  background: linear-gradient(90deg, transparent, var(--dbk-accent), transparent);
}
.dbk-off-prog-text {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-top: 5px; font-size: 11.5px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary, #8a8f98); font-variant-numeric: tabular-nums;
}
.dbk-off-archive-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dbk-off-archive-id {
  font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace);
  font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #8a8f98);
}
.dbk-off-archive-meta { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8f98); font-variant-numeric: tabular-nums; }
.dbk-off-empty {
  margin-top: 10px; padding: 16px; text-align: center;
  border: .5px dashed var(--dbk-hair-strong); border-radius: var(--dsw-radius-md, 12px);
  color: var(--dsw-alias-label-tertiary, #8a8f98); font-size: 12px; line-height: 18px;
}
.dbk-off-setting { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-off-schedule { width: var(--dbk-field-w); max-width: 100%; text-align: center; font-variant-numeric: tabular-nums; }

/* ---------- 事故与监控（崩溃卡片 / 时间线） ---------- */
.dbk-alert {
  display: flex; align-items: flex-start; gap: 10px; flex-wrap: wrap;
  margin-top: 14px; padding: 12px 14px;
  border: .5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef5350) 46%, var(--dbk-hair));
  border-radius: var(--dsw-radius-sm, 8px);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef5350) 9%, transparent);
  font-size: 12px; line-height: 18px;
  animation: dbk-in .2s ease-out both;
}
.dbk-alert-ico { flex: none; display: inline-flex; margin-top: 1px; color: var(--dsw-alias-state-error-primary, #e0645c); }
.dbk-alert-main { flex: 1; min-width: 0; }
.dbk-alert-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); }
.dbk-alert-desc { margin-top: 2px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.dbk-alert-meta { margin-top: 5px; display: flex; gap: 6px 14px; flex-wrap: wrap; font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #8a8f98); font-variant-numeric: tabular-nums; }
.dbk-alert-actions { flex: none; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dbk-mon-inc {
  margin-top: 12px; padding: 12px 14px;
  border: .5px solid var(--dbk-hair); border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-module-platform, rgba(128, 128, 128, .05));
  animation: dbk-in .18s ease-out both;
}
.dbk-mon-inc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.dbk-mon-inc-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); }
.dbk-mon-inc-time { font-size: 11.5px; line-height: 16px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #8a8f98); font-variant-numeric: tabular-nums; }
.dbk-mon-inc-text { margin-top: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.dbk-mon-list { margin-top: 2px; }
.dbk-tl {
  margin-top: 10px; padding-left: 12px;
  border-left: 1.5px solid var(--dbk-hair-strong);
  display: flex; flex-direction: column; gap: 6px;
}
.dbk-tl-item { position: relative; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.dbk-tl-item::before {
  content: ""; position: absolute; left: -16px; top: 6px;
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--dbk-accent);
}
.dbk-tl-at { margin-right: 8px; color: var(--dsw-alias-label-tertiary, #8a8f98); font-variant-numeric: tabular-nums; }
.dbk-tl-type { margin-right: 6px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); }
.dbk-tl-detail { overflow-wrap: anywhere; }
.dbk-mon-note { margin-top: 8px; font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-mon-note.err { color: var(--dsw-alias-state-error-primary, #e0645c); }

/* ---------- 响应式 / 动效偏好 ---------- */
@media (max-width: 640px) {
  .dbk-page { padding: 16px 18px 44px; }
  .dbk-alert-actions { width: 100%; }
  .dbk-alert-actions .dbk-btn { flex: 1; }
  .dbk-head { flex-direction: column; gap: 12px; }
  .dbk-head-actions { padding-top: 0; }
  .dbk-hero-top { flex-direction: column; }
  .dbk-stats { width: 100%; }
  .dbk-stat { flex: 1; min-width: 0; padding: 0 10px; }
  .dbk-row { flex-direction: column; align-items: flex-start; gap: 8px; }
  .dbk-row-action { align-self: flex-end; }
  .dbk-input.wide { width: 100%; max-width: none; }
  .dbk-snap-time { width: 42px; }
}
@media (prefers-reduced-motion: reduce) {
  .dbk-page *, .dbk-page *::before, .dbk-page *::after {
    animation-duration: .001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .001ms !important;
  }
}
/* ==================== v0.7 新版布局 ==================== */
/* 主界面：状态卡 + 信息条 + 救命入口；两个标签页；恢复选择/确认走弹窗。
   旧的 dbk-row / dbk-section 样式保留给二级页（异地/监控/通知）使用。 */

.dbk-card {
  margin-top: 16px;
  border: .5px solid var(--dbk-stroke);
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dbk-surface);
  animation: dbk-in .2s ease-out both;
}
.dbk-card:first-child { margin-top: 0; }
.dbk-muted { color: var(--dsw-alias-label-secondary, #6b7280); }
.dbk-spacer { flex: 1 1 auto; }
.dbk-ico { display: inline-flex; align-items: center; flex: none; }
.dbk-btn.lg { height: 34px; padding: 0 16px; font-size: 14px; border-radius: var(--dsw-radius-md, 10px); }
.dbk-btn.primary.lg { padding: 0 18px; }
.dbk-btn.danger-solid {
  background: var(--dsw-alias-state-error-primary, #dc2626);
  color: var(--dsw-alias-label-primary-foreground, #fff); font-weight: 500;
}
.dbk-btn.danger-solid:hover:not(:disabled) { opacity: .92; }

/* ---------- 标签页 ---------- */
.dbk-tabs { display: flex; gap: 22px; margin-top: 12px; margin-bottom: 16px; border-bottom: .5px solid var(--dbk-hair); }
.dbk-tab {
  appearance: none; border: 0; background: none; cursor: pointer; font: inherit;
  font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary, #8a8f98);
  padding: 0 1px 9px; margin-bottom: -.5px;
  border-bottom: 2px solid transparent;
  transition: color .12s ease, border-color .12s ease;
}
.dbk-tab:hover { color: var(--dsw-alias-label-secondary, #6b7280); }
.dbk-tab[aria-selected="true"] {
  color: var(--dsw-alias-label-primary, inherit); font-weight: 500;
  border-bottom-color: var(--dsw-alias-label-primary, #1f2023);
}
.dbk-tab-dot {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: var(--dsw-alias-state-error-primary, #ef5350);
  margin-left: 6px; vertical-align: 2px;
}

/* ---------- 状态卡 ---------- */
.dbk-status-card { --sc: var(--dsw-alias-state-success-primary, #22c55e); padding: 20px 22px 15px; }
.dbk-status-card.bad { --sc: var(--dsw-alias-state-error-primary, #ef5350); }
.dbk-status-card.warn { --sc: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dbk-status-card.off { --sc: var(--dsw-alias-label-caption, #9aa0a6); }
.dbk-status-card.bad,
.dbk-status-card.warn {
  background: color-mix(in srgb, var(--sc) 5%, var(--dbk-surface));
  border-left: 2px solid var(--sc);
}
.dbk-status-top { display: flex; gap: 14px; align-items: flex-start; }
.dbk-status-icon {
  width: 40px; height: 40px; flex: none; border-radius: 50%;
  display: grid; place-items: center; margin-top: 1px;
  color: var(--sc);
  background: color-mix(in srgb, var(--sc) 12%, transparent);
  border: .5px solid color-mix(in srgb, var(--sc) 32%, transparent);
}
.dbk-status-main { flex: 1; min-width: 0; }
.dbk-status-h2 {
  margin: 0 0 4px; font-size: 18px; line-height: 26px;
  font-weight: 600; letter-spacing: -.2px;
}
.dbk-status-card.bad .dbk-status-h2,
.dbk-status-card.warn .dbk-status-h2 { color: var(--dsw-alias-label-primary, inherit); }
.dbk-status-lede {
  margin: 0; font-size: 13px; line-height: 21px;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.dbk-status-lede b { color: var(--dsw-alias-label-primary, inherit); font-weight: 600; }
.dbk-status-actions { display: flex; gap: 8px; align-items: center; margin-top: 16px; flex-wrap: wrap; }
.dbk-status-foot {
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  margin: 16px -22px -15px; padding: 10px 22px;
  border-top: .5px solid var(--dbk-hair);
  border-radius: 0 0 var(--dsw-radius-md, 12px) var(--dsw-radius-md, 12px);
  background: color-mix(in srgb, var(--sc) 6%, transparent);
  font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.dbk-status-foot .dbk-ico { color: var(--sc); }
.dbk-status-card.bad .dbk-status-foot { color: var(--dbk-err-ink); }

/* ---------- 信息条 ---------- */
.dbk-strip {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 11px 18px; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.dbk-strip-item { display: inline-flex; align-items: baseline; gap: 6px; }
.dbk-strip-item b { font-size: 13px; color: var(--dsw-alias-label-primary, inherit); font-variant-numeric: tabular-nums; }
.dbk-strip-div { width: 1px; height: 12px; background: var(--dbk-hair); flex: none; }

/* ---------- 救命入口 ---------- */
.dbk-rescue {
  display: flex; gap: 12px; align-items: flex-start;
  margin-top: 16px; padding: 14px 16px; border-radius: var(--dsw-radius-md, 12px);
  border: .5px dashed var(--dbk-hair-strong);
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.dbk-rescue > .dbk-ico { margin-top: 2px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-rescue b { font-size: 13px; color: var(--dsw-alias-label-primary, inherit); }
.dbk-rescue-desc { margin-top: 2px; font-size: 12px; line-height: 19px; }
.dbk-rescue kbd {
  font: inherit; font-size: 11.5px; padding: 0 5px; border-radius: 4px;
  border: .5px solid var(--dbk-hair-strong);
  background: var(--dsw-alias-bg-module-platform, rgba(128, 128, 128, .08));
  color: var(--dsw-alias-label-secondary, #6b7280);
}

/* ---------- 待重启横幅 ---------- */
.dbk-restart {
  display: flex; gap: 11px; align-items: flex-start;
  margin-top: 14px; padding: 11px 14px; border-radius: var(--dsw-radius-md, 12px);
  border: .5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 38%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 9%, transparent);
  color: var(--dsw-alias-state-warn-primary, #b45309);
  animation: dbk-in .2s ease-out both;
}
.dbk-restart > .dbk-ico { margin-top: 2px; }
.dbk-restart-title { font-size: 13px; line-height: 20px; font-weight: 600; }
.dbk-restart-desc { margin-top: 2px; font-size: 12px; line-height: 18px; opacity: .92; }

/* ---------- 弹窗 ---------- */
.dbk-page > .dbk-backdrop { max-width: none; width: auto; margin: 0; }
.dbk-backdrop {
  position: fixed; inset: 0; z-index: 60;
  display: grid; place-items: center; padding: 24px;
  background: rgba(16, 18, 22, .55);
  animation: dbk-fade .14s ease-out both;
}
@keyframes dbk-fade { from { opacity: 0; } to { opacity: 1; } }
[data-ds-dark-theme] .dbk-backdrop { background: rgba(0, 0, 0, .62); }
[data-ds-dark-theme] .dbk-page {
  --dbk-brand: #f7ad31;
  --dbk-brand-soft: color-mix(in srgb, var(--dbk-brand) 16%, transparent);
  --dbk-ok-ink: var(--dsw-alias-state-success-primary, #22c55e);
  --dbk-warn-ink: var(--dsw-alias-state-warn-primary, #f59e0b);
  --dbk-err-ink: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f25a5a) 70%, #fff);
}
.dbk-modal {
  width: 100%; max-width: 470px; max-height: min(760px, calc(100vh - 48px));
  display: flex; flex-direction: column;
  padding: 20px 20px 16px;
  border-radius: var(--dsw-radius-lg, 16px);
  border: .5px solid var(--dbk-stroke);
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, inherit);
  box-shadow: 0 24px 64px rgba(0, 0, 0, .24);
  animation: dbk-pop .16s ease-out both;
}
@keyframes dbk-pop { from { opacity: 0; transform: translateY(6px) scale(.99); } to { opacity: 1; transform: none; } }
.dbk-modal.wide { max-width: 530px; }
.dbk-modal-title { margin: 0 0 3px; font-size: 17px; line-height: 25px; font-weight: 600; letter-spacing: -.2px; }
.dbk-modal-sub { margin: 0 0 14px; font-size: 12.5px; line-height: 19px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-modal-foot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; flex: none; }

/* 影响清单 */
.dbk-effects {
  list-style: none; margin: 0; padding: 0; flex: none;
  border: .5px solid var(--dbk-hair); border-radius: var(--dsw-radius-sm, 10px);
  overflow: hidden;
}
.dbk-effects li {
  display: flex; gap: 9px; align-items: flex-start;
  padding: 9px 12px; font-size: 12.5px; line-height: 19px;
  border-top: .5px solid var(--dbk-hair);
  color: var(--dsw-alias-label-secondary, #6b7280);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, rgba(128,128,128,.05)) 70%, transparent);
}
.dbk-effects li:first-child { border-top: 0; }
.dbk-effects li b { color: var(--dsw-alias-label-primary, inherit); font-weight: 600; }
.dbk-effects .dbk-ico { color: var(--dsw-alias-state-success-primary, #22c55e); margin-top: 2px; }

.dbk-warnbar {
  display: flex; gap: 9px; align-items: flex-start; flex: none;
  margin-top: 12px; padding: 9px 12px; border-radius: var(--dsw-radius-sm, 10px);
  font-size: 12.5px; line-height: 19px;
  color: var(--dbk-warn-ink);
  border: .5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 36%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 8%, transparent);
}
.dbk-warnbar .dbk-ico { margin-top: 2px; }
.dbk-warnbar.err {
  color: var(--dbk-err-ink);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef5350) 36%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef5350) 8%, transparent);
}

/* 文件清单 */
.dbk-files-toggle {
  appearance: none; width: 100%; flex: none; cursor: pointer; font: inherit;
  display: flex; align-items: center; gap: 6px; text-align: left;
  margin-top: 10px; padding: 8px 11px; border-radius: var(--dsw-radius-sm, 10px);
  border: .5px solid var(--dbk-hair);
  background: transparent; color: var(--dsw-alias-label-secondary, #6b7280);
  font-size: 12.5px;
}
.dbk-files-toggle:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); }
.dbk-files-toggle .dbk-chev { margin-left: auto; transition: transform .14s ease; }
.dbk-files-toggle[aria-expanded="true"] .dbk-chev { transform: rotate(90deg); }
.dbk-files {
  margin-top: 8px; flex: 1 1 auto; min-height: 0; overflow: auto;
  padding: 8px 10px; border-radius: var(--dsw-radius-sm, 10px);
  border: .5px solid var(--dbk-hair);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, rgba(128,128,128,.05)) 70%, transparent);
}
.dbk-files code {
  display: block; font-family: var(--ds-font-mono, "Cascadia Mono", Consolas, monospace);
  font-size: 11.5px; line-height: 1.7; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.dbk-files-more { margin-top: 4px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #8a8f98); }

/* 恢复点选择 */
.dbk-search2 {
  display: flex; align-items: center; gap: 8px; flex: none;
  height: 34px; padding: 0 11px; margin-bottom: 10px;
  border-radius: var(--dsw-radius-sm, 10px);
  border: .5px solid var(--dbk-hair);
  background: var(--dsw-alias-bg-module-platform, rgba(128, 128, 128, .06));
  color: var(--dsw-alias-label-tertiary, #8a8f98);
}
.dbk-search2 input {
  flex: 1; min-width: 0; border: 0; outline: none; background: none;
  font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary, inherit);
}
.dbk-search2 input::placeholder { color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-picks { flex: 1 1 auto; min-height: 0; overflow: auto; margin: 0 -4px; padding: 0 4px; }
.dbk-pick-day {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 2px 5px; font-size: 12px; font-weight: 500;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
}
.dbk-pick-day span:last-child { margin-left: auto; font-weight: 400; }
.dbk-pick {
  appearance: none; width: 100%; cursor: pointer; font: inherit; text-align: left;
  display: flex; align-items: center; gap: 11px;
  padding: 9px 10px; border-radius: var(--dsw-radius-sm, 10px);
  border: .5px solid transparent; background: none;
  color: var(--dsw-alias-label-primary, inherit);
}
.dbk-pick:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); border-color: var(--dbk-hair); }
.dbk-pick.rec {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef5350) 8%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef5350) 30%, transparent);
}
.dbk-pick.stale { opacity: .62; }
.dbk-pick-time { flex: none; width: 54px; font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dbk-pick-ago { flex: none; width: 76px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-pick-meta { flex: 1 1 auto; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #6b7280); font-variant-numeric: tabular-nums; }
.dbk-pick-tag {
  flex: none; font-size: 11px; line-height: 18px; padding: 0 6px; border-radius: 5px;
  border: .5px solid var(--dbk-hair);
  background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.08));
  color: var(--dsw-alias-label-tertiary, #8a8f98);
}
.dbk-pick-tag.rec {
  background: var(--dsw-alias-state-error-primary, #dc2626);
  border-color: transparent; color: #fff; font-weight: 500;
}
.dbk-pick-tag.stale {
  color: var(--dsw-alias-state-warn-primary, #b45309);
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 36%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 10%, transparent);
}
.dbk-pick-go { flex: none; display: flex; color: var(--dsw-alias-label-caption, #9aa0a6); }

/* ---------- 设置页 ---------- */
.dbk-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 16px; }
.dbk-grid .dbk-card { margin-top: 0; }
.dbk-set-card { padding: 15px 16px; }
.dbk-set-card.clickable { cursor: pointer; transition: background .12s ease, border-color .12s ease; }
.dbk-set-card.clickable:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.06)); border-color: var(--dbk-hair-strong); }
.dbk-set-card:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dbk-accent)); outline-offset: 2px; }
.dbk-set-head { display: flex; align-items: center; gap: 7px; }
.dbk-set-head .dbk-switch { margin-left: auto; }
.dbk-set-go { margin-left: auto; display: inline-flex; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-set-title { font-size: 13px; line-height: 20px; font-weight: 600; }
.dbk-set-desc { margin: 2px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.dbk-set-val {
  margin-top: 8px; display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  font-size: 12.5px; color: var(--dsw-alias-label-secondary, #6b7280);
}
.dbk-set-val b { color: var(--dsw-alias-label-primary, inherit); font-weight: 600; }
.dbk-set-val code {
  font-family: var(--ds-font-mono, "Cascadia Mono", Consolas, monospace);
  font-size: 11.5px; padding: 1px 5px; border-radius: 4px;
  border: .5px solid var(--dbk-hair);
  background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.06));
  word-break: break-all;
}
.dbk-tag {
  display: inline-block; font-size: 11px; line-height: 18px; padding: 0 6px; border-radius: 5px;
  border: .5px solid var(--dbk-hair);
  background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.08));
  color: var(--dsw-alias-label-tertiary, #8a8f98); font-weight: 400;
}
.dbk-tag.ok {
  color: var(--dbk-ok-ink);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 34%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 10%, transparent);
}
.dbk-tag.warn {
  color: var(--dbk-warn-ink);
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 36%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 10%, transparent);
}
.dbk-tag.err {
  color: var(--dbk-err-ink);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef5350) 36%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef5350) 10%, transparent);
}

/* ---------- 二级页 ---------- */
.dbk-subhead-row { display: flex; align-items: center; gap: 10px; margin-top: 16px; }
.dbk-subhead-title { font-size: 14px; line-height: 22px; font-weight: 600; }
.dbk-subactions { display: flex; align-items: center; gap: 10px; justify-content: flex-end; margin-top: 14px; }
.dbk-panel { margin-top: 12px; padding: 4px 16px 12px; }
.dbk-panel .dbk-section,
.dbk-panel .dbk-section-head { margin-top: 12px; }
.dbk-notify-block .dbk-section-head { margin-top: 12px; }

@media (max-width: 700px) {
  .dbk-grid { grid-template-columns: 1fr; }
  .dbk-status-top { flex-direction: column; }
  .dbk-pick-ago { display: none; }
  .dbk-strip { gap: 8px; }
  .dbk-strip-div { display: none; }
}

/* v0.7 补充 */
.dbk-pick-more {
  appearance: none; border: 0; background: none; cursor: pointer;
  width: 24px; height: 24px; border-radius: 6px; flex: none;
  color: var(--dsw-alias-label-secondary, #8a8f98);
  font: inherit; font-size: 14px; line-height: 1; opacity: .7;
  transition: opacity .12s ease, background .12s ease;
}
.dbk-pick:hover .dbk-pick-more, .dbk-pick-more:focus-visible { opacity: 1; }

/* 焦点可见性：键盘用户在每个可点元素上都能看到 2px ring */
.dbk-tab:focus-visible,
.dbk-pick:focus-visible,
.dbk-pick-more:focus-visible,
.dbk-files-toggle:focus-visible,
.dbk-day:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dbk-accent));
  outline-offset: 2px;
  border-radius: var(--dsw-radius-sm, 8px);
}
.dbk-search2:focus-within {
  border-color: var(--dbk-accent);
  box-shadow: 0 0 0 2px var(--dbk-accent-soft);
}
.dbk-pick-more:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16)); color: var(--dsw-alias-label-primary, inherit); }
.dbk-pick-more:disabled { cursor: default; opacity: .2; }
.dbk-set-card.wide { grid-column: 1 / -1; }
.dbk-status-foot.err, .dbk-status-foot.err .dbk-ico { color: var(--dsw-alias-state-error-primary, #b91c1c); }

/* =====================================================================
   v0.8 视觉层：DSH 原生（行式、hairline、16px 标题上限、分段页签）
   旧类名保留，二级页（异地/通知/监控/高级）继续复用 .dbk-section/.dbk-row
   ===================================================================== */
.dbk-page {
  --dbk-hair: var(--dsw-alias-border-l2, rgba(128, 128, 128, .22));
  --dbk-hair-strong: var(--dsw-alias-border-l4, rgba(128, 128, 128, .3));
  --dbk-surface: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, transparent));
  --dbk-stroke: var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4, rgba(128, 128, 128, .28)));
  --dbk-ok-ink: #15803d;
  --dbk-warn-ink: #b45309;
  --dbk-err-ink: #b91c1c;
  --dbk-ok-soft: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 11%, transparent);
  --dbk-warn-soft: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 12%, transparent);
  --dbk-err-soft: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef5350) 11%, transparent);
  padding: 20px 24px 40px;
  font-size: 13px;
  line-height: 20px;
}
body[data-ds-dark-theme] .dbk-page {
  --dbk-ok-ink: var(--dsw-alias-state-success-primary, #4ed17e);
  --dbk-warn-ink: var(--dsw-alias-state-warn-primary, #f7ad31);
  --dbk-err-ink: var(--dsw-alias-state-error-primary, #f25a5a);
}
.dbk-page > * { max-width: 920px; }
@media (max-width: 760px) { .dbk-page { padding: 16px 14px 32px; } }

/* 页头 */
.dbk-head { display: flex; align-items: flex-start; gap: 16px; padding: 2px 2px 14px; }
.dbk-head-main { display: block; min-width: 0; flex: 1; }
.dbk-head-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); }
.dbk-head-sub { margin: 3px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-head-side { margin-left: auto; display: flex; align-items: center; gap: 10px; padding-top: 2px; flex: none; }
.dbk-status-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, #61666b); white-space: nowrap; }
.dbk-head-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.dbk-title { font-size: 16px; line-height: 24px; font-weight: 500; }
.dbk-sub { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-mark { display: none; }

/* 分段页签（原生 Tab pill 组） */
.dbk-seg-row { display: flex; align-items: center; }
.dbk-seg {
  display: inline-flex; gap: 2px; padding: 4px; margin: 0;
  width: max-content; max-width: 100%;
  border-radius: 16px;
  background: var(--dsw-alias-bg-module-platform, #f5f6f7);
}
.dbk-seg-tab {
  height: 28px; padding: 0 12px; border: 0; border-radius: 12px;
  display: inline-flex; align-items: center; gap: 6px;
  font-family: inherit; font-size: 13px; line-height: 20px; font-weight: 500;
  color: var(--dsw-alias-label-secondary, #61666b); background: transparent; cursor: pointer;
  transition: background .16s ease, color .16s ease;
}
.dbk-seg-tab:hover { color: var(--dsw-alias-label-primary, inherit); }
.dbk-seg-tab[aria-selected="true"] {
  color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: 0 0 0 .5px var(--dbk-hair), 0 2px 6px #00000008;
}
body[data-ds-dark-theme] .dbk-seg-tab[aria-selected="true"] { background: var(--dsw-alias-bg-layer-1, #232324); box-shadow: 0 1px 3px #00000040; }
.dbk-seg-count { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-seg-tab[aria-selected="true"] .dbk-seg-count { color: var(--dsw-alias-label-secondary, #61666b); }
.dbk-seg-flag { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-error-primary, #ec1313); }
.dbk-seg-flag.warn { background: var(--dsw-alias-state-warn-primary, #f59e0b); }

/* 通用分组 / 行 */
.dbk-section, .dbk-card {
  background: var(--dbk-surface);
  border: .5px solid var(--dbk-stroke);
  border-radius: 12px;
  padding: 0;
  margin-top: 12px;
  overflow: hidden;
}
.dbk-section:first-child, .dbk-card:first-child { margin-top: 0; }
.dbk-section + .dbk-section { margin-top: 12px; }
.dbk-section-head {
  display: flex; align-items: center; gap: 8px;
  margin: 0; padding: 10px 16px;
  border: 0; border-bottom: .5px solid var(--dbk-hair);
  background: transparent; position: static;
  font-size: 13px; line-height: 20px; font-weight: 500;
  color: var(--dsw-alias-label-primary, inherit);
}
.dbk-section-head.dbk-clickable { cursor: pointer; }
.dbk-section-head.dbk-clickable:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08)); }
.dbk-section-title { font-size: 13px; line-height: 20px; font-weight: 500; color: inherit; }
.dbk-section-side { margin-left: auto; display: flex; align-items: center; gap: 8px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-section-toggle { font-size: 12px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-rows { display: block; }
.dbk-row {
  display: flex; align-items: flex-start; gap: 16px;
  margin: 0; padding: 12px 16px;
  border: 0; border-top: .5px solid var(--dbk-hair);
  background: transparent;
}
.dbk-rows > .dbk-row:first-child, .dbk-section-head + .dbk-row, .dbk-row:first-child { border-top: 0; }
.dbk-row-main { min-width: 0; flex: 1; }
.dbk-row-title {
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  font-size: 14px; line-height: 22px; font-weight: 400;
  color: var(--dsw-alias-label-primary, inherit);
}
.dbk-row-desc { margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #81858c); overflow-wrap: anywhere; }
.dbk-row-desc.mono { font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); font-size: 11.5px; }
.dbk-row-desc.err { color: var(--dbk-err-ink); }
.dbk-row-note { margin-top: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-row-note.err { color: var(--dbk-err-ink); }
.dbk-row-action { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: none; padding-top: 1px; }
.dbk-rows.single { padding: 0; }
.dbk-muted { color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-spacer { margin-left: auto; }
.dbk-ico { display: inline-flex; align-items: center; color: var(--dsw-alias-label-tertiary, #81858c); flex: none; }
.dbk-chev { display: inline-flex; align-items: center; color: var(--dsw-alias-label-tertiary, #81858c); transition: transform .16s ease; }
.dbk-chev.open { transform: rotate(90deg); }

/* 统计行 */
.dbk-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); padding: 6px 0 2px; }
.dbk-stat-cell { min-width: 0; padding: 0 16px; border-left: .5px solid var(--dbk-hair); }
.dbk-stat-cell:first-child { border-left: 0; padding-left: 0; }
.dbk-stat-cell .k { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-stat-cell .v { margin-top: 2px; font-size: 14px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 700px) {
  .dbk-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 8px; }
  .dbk-stat-cell:nth-child(3) { border-left: 0; padding-left: 0; }
}

/* 状态行（概览） */
.dbk-status-line { display: flex; align-items: center; gap: 8px; font-size: 14px; line-height: 22px; font-weight: 500; }
.dbk-status-line.bad { color: var(--dbk-err-ink); }
.dbk-status-line.warn { color: var(--dbk-warn-ink); }
.dbk-status-lede { margin: 4px 0 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary, #61666b); max-width: 74ch; }
.dbk-status-meta { margin-top: 6px; display: flex; gap: 10px; flex-wrap: wrap; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-status-meta b { color: var(--dsw-alias-label-secondary, #61666b); font-weight: 500; }
.dbk-section.tone-bad { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef5350) 34%, var(--dbk-stroke)); }
.dbk-section.tone-bad .dbk-section-head { color: var(--dbk-err-ink); }
.dbk-section.tone-warn { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 34%, var(--dbk-stroke)); }
.dbk-section.tone-warn .dbk-section-head { color: var(--dbk-warn-ink); }
.dbk-section.tone-bad > .dbk-row:first-child { box-shadow: inset 2px 0 0 var(--dsw-alias-state-error-primary, #ef5350); }
.dbk-section.tone-warn > .dbk-row:first-child { box-shadow: inset 2px 0 0 var(--dsw-alias-state-warn-primary, #f59e0b); }

/* 按钮 */
.dbk-btn {
  height: 28px; padding: 0 10px;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border: .5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.3));
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit; font-size: 12px; line-height: 18px; font-weight: 500;
  white-space: nowrap; cursor: pointer;
  transition: background .16s ease, color .16s ease, border-color .16s ease;
}
.dbk-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.dbk-btn.primary {
  background: var(--dsw-alias-brand-primary, #0f1115);
  border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.dbk-btn.primary:hover { background: var(--dsw-alias-brand-primary, #0f1115); opacity: .9; }
.dbk-btn.ghost { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary, #61666b); }
.dbk-btn.ghost:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); color: var(--dsw-alias-label-primary, inherit); }
.dbk-btn.danger { border-color: transparent; background: transparent; color: var(--dbk-err-ink); }
.dbk-btn.danger:hover { background: var(--dbk-err-soft); }
.dbk-btn.danger-solid { background: var(--dsw-alias-state-error-primary, #ec1313); border-color: transparent; color: #fff; }
body[data-ds-dark-theme] .dbk-btn.danger-solid { color: #0f1115; }
.dbk-btn.lg { height: 36px; padding: 0 14px; border-radius: 12px; font-size: 14px; line-height: 22px; }
.dbk-btn.small { height: 28px; padding: 0 10px; font-size: 12px; }
.dbk-btn.icon { width: 28px; padding: 0; }
.dbk-btn[disabled] { opacity: .45; cursor: default; }
.dbk-btn[disabled]:hover { background: transparent; }
.dbk-btn.primary[disabled]:hover { background: var(--dsw-alias-brand-primary, #0f1115); }

/* 开关 */
.dbk-switch {
  position: relative; width: 36px; height: 20px; flex: none;
  padding: 0; border: 0; border-radius: 999px;
  background: var(--dsw-alias-border-l4, rgba(128,128,128,.35));
  cursor: pointer; transition: background .16s ease;
}
.dbk-switch .dbk-knob {
  position: absolute; top: 2px; left: 2px;
  width: 16px; height: 16px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px #00000024;
  transition: transform .16s ease;
}
.dbk-switch[aria-checked="true"] { background: var(--dsw-alias-state-business-primary, #4176e6); }
.dbk-switch[aria-checked="true"] .dbk-knob { transform: translateX(16px); }
.dbk-switch[disabled] { opacity: .45; cursor: default; }

/* 标签 / 徽标 */
.dbk-tag, .dbk-off-tag, .dbk-badge {
  display: inline-flex; align-items: center; gap: 4px;
  height: 20px; padding: 0 8px;
  border: 0; border-radius: 999px;
  background: var(--dsw-alias-bg-module-platform, #f5f6f7);
  color: var(--dsw-alias-label-secondary, #61666b);
  font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap;
}
.dbk-tag.ok, .dbk-off-tag.ok, .dbk-badge.ok { color: var(--dbk-ok-ink); background: var(--dbk-ok-soft); }
.dbk-tag.warn, .dbk-off-tag.warn, .dbk-badge.warn { color: var(--dbk-warn-ink); background: var(--dbk-warn-soft); }
.dbk-tag.err, .dbk-off-tag.err, .dbk-badge.err { color: var(--dbk-err-ink); background: var(--dbk-err-soft); }
.dbk-tag.pre, .dbk-off-tag.quiet, .dbk-badge.pre { color: var(--dsw-alias-label-tertiary, #81858c); background: transparent; box-shadow: inset 0 0 0 .5px var(--dbk-hair); }
.dbk-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-caption, #adb2b8); }
.dbk-dot.ok { background: var(--dsw-alias-state-success-primary, #22c55e); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 16%, transparent); }
.dbk-dot.warn { background: var(--dsw-alias-state-warn-primary, #f59e0b); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 16%, transparent); }
.dbk-dot.err { background: var(--dsw-alias-state-error-primary, #ec1313); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 18%, transparent); }
.dbk-dot.off { background: var(--dsw-alias-state-idle-primary, #d4d4d4); }

/* 输入 */
.dbk-input, .dbk-field-input, .dbk-select, .dbk-off-pass, .dbk-off-schedule {
  height: 32px; padding: 0 10px;
  border: .5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.3));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3, #f5f6f7);
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit; font-size: 13px; line-height: 20px;
  min-width: 0;
}
body[data-ds-dark-theme] .dbk-input,
body[data-ds-dark-theme] .dbk-field-input,
body[data-ds-dark-theme] .dbk-select,
body[data-ds-dark-theme] .dbk-off-pass { background: var(--dsw-alias-bg-layer-3, #353638); }
.dbk-input:focus, .dbk-field-input:focus, .dbk-select:focus, .dbk-off-pass:focus {
  outline: 2px solid var(--dsw-focus-ring-color, #4176e6); outline-offset: 0;
}
.dbk-field-input.small { width: 120px; }
.dbk-select { padding-right: 8px; }
.dbk-field { display: inline-flex; align-items: center; }
.dbk-field-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 16px; }
.dbk-stepper {
  display: inline-flex; align-items: center; height: 32px;
  padding-right: 10px; border: .5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.3));
  border-radius: 10px; background: var(--dsw-alias-bg-layer-3, #f5f6f7);
}
body[data-ds-dark-theme] .dbk-stepper { background: var(--dsw-alias-bg-layer-3, #353638); }
.dbk-stepper input {
  width: 76px; height: 30px; padding: 0 6px; border: 0; background: transparent;
  color: inherit; font-family: inherit; font-size: 13px; text-align: right;
}
.dbk-stepper input:focus { outline: none; }
.dbk-stepper-unit { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #81858c); white-space: nowrap; }

/* 搜索 */
.dbk-searchline { position: relative; display: inline-flex; align-items: center; }
.dbk-searchline .dbk-ico { position: absolute; left: 8px; pointer-events: none; }
.dbk-searchline input {
  width: 210px; height: 30px; padding: 0 10px 0 28px;
  border: .5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.3)); border-radius: 9px;
  background: var(--dsw-alias-bg-layer-3, #f5f6f7); color: inherit; font-family: inherit; font-size: 12.5px;
}
body[data-ds-dark-theme] .dbk-searchline input { background: var(--dsw-alias-bg-layer-3, #353638); }
.dbk-searchline input:focus { outline: 2px solid var(--dsw-focus-ring-color, #4176e6); outline-offset: 0; }

/* 备份列表 */
.dbk-day {
  display: flex; align-items: center; gap: 8px; width: 100%;
  margin: 0; padding: 8px 16px;
  border: 0; border-top: .5px solid var(--dbk-hair);
  background: color-mix(in srgb, var(--dsw-alias-bg-module-platform, #f5f6f7) 62%, transparent);
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-family: inherit; font-size: 11.5px; line-height: 18px; text-align: left; cursor: pointer;
}
.dbk-rows > .dbk-day:first-child { border-top: 0; }
.dbk-day-label { color: var(--dsw-alias-label-secondary, #61666b); font-size: 12px; font-weight: 500; }
.dbk-day-count { margin-left: auto; }
.dbk-day-line { display: none; }
.dbk-snap-wrap { border-top: .5px solid var(--dbk-hair); }
.dbk-snap-wrap:first-child { border-top: 0; }
.dbk-snap {
  display: flex; align-items: center; gap: 12px;
  padding: 9px 16px;
}
.dbk-snap:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08)); }
.dbk-snap-time { width: 58px; flex: none; font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; }
.dbk-snap-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dbk-snap-meta { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-snap-actions { margin-left: auto; flex: none; display: flex; align-items: center; gap: 6px; }
.dbk-snap-actions .dbk-btn.danger { color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-snap:hover .dbk-snap-actions .dbk-btn.danger { color: var(--dbk-err-ink); }
.dbk-more { padding: 8px 16px; border-top: .5px solid var(--dbk-hair); }

/* 活动 */
.dbk-act { display: flex; align-items: baseline; gap: 12px; padding: 9px 16px; border-top: .5px solid var(--dbk-hair); }
.dbk-act:first-child { border-top: 0; }
.dbk-act-time { width: 52px; flex: none; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #81858c); font-variant-numeric: tabular-nums; }
.dbk-act-main { flex: 1; min-width: 0; }
.dbk-act-title { display: block; font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-primary, inherit); }
.dbk-act-desc { display: block; font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-act-side { flex: none; }
.dbk-act .dbk-tag { height: 19px; }

/* 设置行 */
.dbk-set-row {
  display: flex; align-items: center; gap: 16px; width: 100%;
  margin: 0; padding: 14px 16px;
  border: 0; border-top: .5px solid var(--dbk-hair);
  background: transparent; text-align: left;
  font-family: inherit; color: inherit; cursor: pointer;
}
.dbk-rows > .dbk-set-row:first-child, .dbk-section-head + .dbk-set-row { border-top: 0; }
.dbk-set-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08)); }
.dbk-set-row.static { cursor: default; }
.dbk-set-row.static:hover { background: transparent; }
.dbk-set-main { flex: 1; min-width: 0; }
.dbk-set-title { display: flex; align-items: center; gap: 8px; font-size: 14px; line-height: 22px; font-weight: 400; }
.dbk-set-desc { display: block; margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #81858c); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbk-set-value { display: block; margin-top: 3px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #81858c); overflow-wrap: anywhere; }
.dbk-set-value.mono { font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); font-size: 11.5px; }
.dbk-set-side { margin-left: auto; flex: none; display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-tertiary, #81858c); }

/* 二级页 */
.dbk-panel { margin: 0; padding: 0; }
.dbk-panel .dbk-section, .dbk-panel .dbk-section-head { margin-top: 0; }
.dbk-subhead-row { display: flex; align-items: center; gap: 10px; margin: 0 0 14px; }
.dbk-subhead-title { font-size: 16px; line-height: 24px; font-weight: 500; }
.dbk-subactions { display: flex; align-items: center; gap: 10px; justify-content: flex-end; margin-top: 0; padding: 12px 16px; border-top: .5px solid var(--dbk-hair); }
.dbk-savebar { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-top: .5px solid var(--dbk-hair); }
.dbk-savebar .dbk-save-note { font-size: 12px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-savebar .dbk-save-actions { margin-left: auto; display: flex; gap: 8px; }

/* 弹窗 */
.dbk-backdrop {
  position: fixed; inset: 0; z-index: 60;
  display: flex; align-items: flex-start; justify-content: center;
  padding: max(40px, 10vh) 24px 24px;
  background: var(--dsw-alias-bg-mask-1, #0000003d);
  backdrop-filter: blur(2px);
  animation: dbk-fade .14s ease;
}
body[data-ds-dark-theme] .dbk-backdrop { background: var(--dsw-alias-bg-mask-1, #00000080); }
@keyframes dbk-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes dbk-pop { from { transform: translateY(6px); opacity: .6; } to { transform: none; opacity: 1; } }
.dbk-modal {
  width: min(380px, 100%); max-height: calc(100vh - 96px);
  display: flex; flex-direction: column;
  padding: 0; border: 0; border-radius: 28px;
  background: var(--dsw-alias-bg-layer-2, #fff);
  color: var(--dsw-alias-label-primary, inherit);
  box-shadow: 0 12px 40px #0000002e, 0 0 0 .5px #00000014;
  overflow: hidden;
  animation: dbk-pop .16s ease;
}
body[data-ds-dark-theme] .dbk-modal { background: var(--dsw-alias-bg-layer-2, #2c2c2e); }
.dbk-modal.wide { width: min(440px, 100%); }
.dbk-modal-head { display: flex; align-items: flex-start; gap: 8px; padding: 20px 14px 0 22px; }
.dbk-modal-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }
.dbk-modal-close {
  margin-left: auto; width: 28px; height: 28px; flex: none;
  display: grid; place-items: center; border: 0; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-tertiary, #81858c);
  font-size: 16px; line-height: 1; cursor: pointer;
}
.dbk-modal-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); color: var(--dsw-alias-label-primary, inherit); }
.dbk-modal-sub { margin: 4px 22px 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary, #61666b); }
.dbk-modal-body { padding: 14px 22px 0; overflow: auto; }
.dbk-modal-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 16px 22px 18px; }
.dbk-modal-foot .dbk-btn { height: 36px; padding: 0 14px; border-radius: 12px; font-size: 14px; }
.dbk-preview-load { display: flex; align-items: center; gap: 9px; padding: 4px 0 12px; font-size: 12.5px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-effects { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 7px; border: 0; border-radius: 0; overflow: visible; background: transparent; }
.dbk-effects li { display: flex; gap: 8px; padding: 0; border: 0; border-radius: 0; background: transparent; font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-secondary, #61666b); }
.dbk-warnbar {
  display: flex; gap: 8px; align-items: flex-start;
  padding: 8px 10px; border-radius: 8px;
  background: var(--dbk-warn-soft); color: var(--dbk-warn-ink);
  font-size: 12px; line-height: 18px;
}
.dbk-warnbar.err { background: var(--dbk-err-soft); color: var(--dbk-err-ink); }
.dbk-files-toggle {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 8px 0; border: 0; background: transparent;
  color: var(--dsw-alias-label-secondary, #61666b); font-family: inherit; font-size: 12.5px; text-align: left; cursor: pointer;
}
.dbk-files-toggle:hover { color: var(--dsw-alias-label-primary, inherit); }
.dbk-files { max-height: 140px; overflow: auto; border: .5px solid var(--dbk-hair); border-radius: 8px; background: var(--dsw-alias-bg-layer-3, #f5f6f7); padding: 6px; display: flex; flex-direction: column; gap: 4px; }
body[data-ds-dark-theme] .dbk-files { background: var(--dsw-alias-bg-layer-3, #353638); }
.dbk-files code { font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); font-size: 11px; color: var(--dsw-alias-label-secondary, #61666b); overflow-wrap: anywhere; }
.dbk-files-more { font-size: 11px; color: var(--dsw-alias-label-caption, #adb2b8); }

/* toast / 页脚 */
.dbk-toast {
  position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 80;
  display: flex; align-items: center; gap: 8px;
  max-width: 520px; padding: 9px 14px;
  border-radius: 9px;
  background: #212123; color: #fff;
  font-size: 12.5px; line-height: 18px;
  box-shadow: 0 6px 24px #00000033;
  animation: dbk-pop .18s ease;
}
body[data-ds-dark-theme] .dbk-toast { background: #2c2c2e; color: #f9fafb; box-shadow: 0 6px 24px #00000066; }
.dbk-foot { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 14px; padding: 0 2px; font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-label-caption, #adb2b8); }
.dbk-foot-brand { color: var(--dsw-alias-label-caption, #adb2b8); }

/* 占位 / 空态 / 骨架 */
.dbk-empty { padding: 20px 16px; text-align: center; font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-empty b { display: block; margin-bottom: 3px; font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-secondary, #61666b); }
.dbk-skel { padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
.dbk-skel-bar { height: 12px; border-radius: 6px; background: var(--dsw-alias-bg-skeleton, rgba(128,128,128,.12)); }
.dbk-hero { display: none; }
.dbk-alert { display: none; }

/* 异地副本（沿用旧标记，重排为原生行） */
.dbk-off-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dbk-off-tags { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dbk-off-archive-main { display: inline-flex; align-items: baseline; gap: 8px; }
.dbk-off-archive-meta { display: inline-flex; align-items: baseline; gap: 4px; flex-wrap: wrap; }
.dbk-off-archive-id { font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); font-size: 11px; }
.dbk-off-lock { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 14px 16px; border-top: .5px solid var(--dbk-hair); }
.dbk-off-lock > .dbk-ico { color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-off-lock-main { flex: 1; min-width: 220px; }
.dbk-off-lock-title { font-size: 14px; line-height: 22px; font-weight: 400; }
.dbk-off-form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dbk-off-form .dbk-off-pass { width: 240px; }
.dbk-off-hint { flex-basis: 100%; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-off-hint.err { color: var(--dbk-err-ink); }
.dbk-off-empty { padding: 16px; border: 0; background: transparent; font-size: 12.5px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-off-prog { padding: 12px 16px; border-top: .5px solid var(--dbk-hair); }
.dbk-off-prog-bar { height: 4px; border-radius: 999px; background: var(--dsw-alias-bg-module-platform, #f5f6f7); overflow: hidden; }
.dbk-off-prog-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-state-business-primary, #4176e6); transition: width .2s ease; }
.dbk-off-prog-fill.indet { width: 34%; animation: dbk-indet 1.2s ease-in-out infinite; }
@keyframes dbk-indet { 0% { transform: translateX(-100%); } 100% { transform: translateX(320%); } }
.dbk-off-prog-text { display: flex; justify-content: space-between; gap: 10px; margin-top: 6px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-off-schedule { width: 96px; }

/* 通知 */
.dbk-notify-block, .dbk-notify-body { display: block; }
.dbk-notify-body .dbk-section-head { margin-top: 0; border-bottom: .5px solid var(--dbk-hair); }
.dbk-notify-body .dbk-subhead { margin-top: 0; }
.dbk-notify-body .dbk-row:first-child,
.dbk-notify-body .dbk-section-head + .dbk-row { border-top: 0; }
.dbk-notify-hook { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 16px; border-top: .5px solid var(--dbk-hair); }
.dbk-notify-hook .dbk-field-row { padding: 0; flex: 1; }
.dbk-notify-hook .dbk-field-input { flex: 1; min-width: 140px; }
.dbk-notify-hook .dbk-field-input.small { flex: 0 0 110px; }
.dbk-row-note { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-row-note.err { color: var(--dbk-err-ink); }

/* 监控 */
.dbk-mon-list { border-top: .5px solid var(--dbk-hair); }
.dbk-mon-inc { padding: 12px 16px; border-top: .5px solid var(--dbk-hair); }
.dbk-mon-list .dbk-mon-inc:first-child { border-top: 0; }
.dbk-mon-inc-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dbk-mon-inc-title { display: inline-flex; align-items: center; gap: 7px; font-size: 14px; line-height: 22px; font-weight: 400; }
.dbk-mon-inc-time { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-mon-inc-text { margin-top: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #61666b); }
.dbk-confirm-grid { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 6px 0; }
.dbk-kv { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-kv b { color: var(--dsw-alias-label-secondary, #61666b); font-weight: 500; }
.dbk-tl { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.dbk-tl-item { display: flex; gap: 10px; font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-tl-at { width: 42px; flex: none; font-variant-numeric: tabular-nums; }
.dbk-tl-type { width: 64px; flex: none; color: var(--dsw-alias-label-secondary, #61666b); }
.dbk-tl-detail { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.dbk-check { display: flex; align-items: flex-start; gap: 8px; margin: 0 16px 12px; padding: 10px 12px; border-radius: 9px; background: var(--dsw-alias-bg-module-platform, #f5f6f7); font-size: 12px; line-height: 18px; }
.dbk-check.bad, .dbk-check.warn { background: var(--dbk-warn-soft); color: var(--dbk-warn-ink); }
.dbk-check.bad { background: var(--dbk-err-soft); color: var(--dbk-err-ink); }
.dbk-check-files { margin-top: 4px; font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); font-size: 11px; opacity: .85; overflow-wrap: anywhere; }
.dbk-protect-title { font-size: 13px; font-weight: 500; }
.dbk-protect-line { font-size: 12px; line-height: 18px; }
.dbk-protect-note { margin-top: 2px; font-size: 11.5px; line-height: 17px; opacity: .8; }
.dbk-banner-main { flex: 1; min-width: 0; }

/* 其他小组件 */
.dbk-code { display: inline-block; padding: 2px 6px; border-radius: 5px; background: var(--dsw-alias-bg-module-platform, #f5f6f7); font-family: var(--ds-font-family-code, ui-monospace, Consolas, monospace); font-size: 11.5px; color: var(--dsw-alias-label-secondary, #61666b); overflow-wrap: anywhere; }
.dbk-spin { width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid currentColor; border-top-color: transparent; animation: dbk-spin .8s linear infinite; flex: none; }
@keyframes dbk-spin { to { transform: rotate(360deg); } }
.dbk-rescue { display: flex; align-items: flex-start; gap: 10px; padding: 12px 16px; }
.dbk-rescue-desc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #81858c); }
.dbk-rescue-steps { margin: 4px 0 0; padding-left: 18px; font-size: 12px; line-height: 19px; color: var(--dsw-alias-label-secondary, #61666b); }
.dbk-set-card { display: none; }
.dbk-grid { display: block; }
.dbk-strip { display: none; }
.dbk-status-card { display: none; }
.dbk-panel .dbk-rows > .dbk-row:first-child { border-top: 0; }
.dbk-panel > .dbk-section + .dbk-section { margin-top: 12px; }

@media (prefers-reduced-motion: reduce) {
  .dbk-page *, .dbk-page *::before, .dbk-page *::after { animation-duration: .001ms !important; transition-duration: .001ms !important; }
}
`

    function ensureStyle() {
      if (typeof document === 'undefined') return
      let el = document.getElementById(STYLE_ID)
      if (!el) {
        el = document.createElement('style')
        el.id = STYLE_ID
        document.head.appendChild(el)
      }
      // HMR 替换 bundle 后旧样式还在，这里每次 apply 都覆盖，避免新旧样式叠加。
      if (el.textContent !== css) el.textContent = css
    }

    /* ------------------------------------------------------------ 小工具 */

    function fill(text, vars) {
      if (!vars) return String(text)
      return String(text).replace(/\{(\w+)\}/g, (match, key) => (vars[key] == null ? '' : String(vars[key])))
    }

    const pad2 = (n) => String(n).padStart(2, '0')

    function fmtClock(d) {
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    }

    function fmtFull(d) {
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    }

    function dayKey(ms) {
      const d = new Date(ms || 0)
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    }

    function fmtDayLabel(ms, t, nowMs) {
      const d = new Date(ms || 0)
      const today = dayKey(nowMs)
      const yesterday = dayKey(nowMs - 86400000)
      const key = dayKey(ms)
      const md = `${d.getMonth() + 1}月${d.getDate()}日`
      if (key === today) return `${t('today')} · ${md}`
      if (key === yesterday) return `${t('yesterday')} · ${md}`
      if (d.getFullYear() !== new Date(nowMs).getFullYear()) return `${d.getFullYear()}年${md}`
      return md
    }

    function agoParts(ms) {
      const sec = Math.max(0, Math.round((Number(ms) || 0) / 1000))
      if (sec < 60) return { n: sec, unit: 'S' }
      const min = Math.round(sec / 60)
      if (min < 60) return { n: min, unit: 'M' }
      const hour = Math.round(min / 60)
      if (hour < 24) return { n: hour, unit: 'H' }
      return { n: Math.round(hour / 24), unit: 'D' }
    }

    function fmtAgo(ms, t) {
      const parts = agoParts(ms)
      if (parts.unit === 'S' && parts.n <= 1) return t('justNow')
      return t('ago' + parts.unit, { n: parts.n })
    }

    function fmtBytes(n) {
      const value = Number(n) || 0
      if (value < 1024) return `${value} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let out = value / 1024
      let i = 0
      while (out >= 1024 && i < units.length - 1) { out /= 1024; i += 1 }
      return `${out.toFixed(out >= 100 ? 0 : 1)} ${units[i]}`
    }

    function fmtInt(n) {
      const value = Number(n) || 0
      return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    function clampInt(raw, min, max) {
      const value = Math.round(Number(raw))
      if (!Number.isFinite(value)) return null
      return Math.min(max, Math.max(min, value))
    }

    function parseExcludes(raw) {
      const out = []
      for (const piece of String(raw || '').split(/[,，\n]/)) {
        const value = piece.trim().replace(/^\\+|\/+$/g, '').replace(/\/+$/, '')
        if (!value) continue
        if (!out.includes(value)) out.push(value)
        if (out.length >= 100) break
      }
      return out
    }

    function reasonKey(reason) {
      const value = String(reason || '')
      if (value === 'manual') return { key: 'reasonManual', cls: 'manual' }
      if (value === 'startup') return { key: 'reasonStartup', cls: 'muted' }
      if (value === 'pre-restore') return { key: 'reasonPreRestore', cls: 'pre' }
      if (value === 'restore') return { key: 'reasonRestore', cls: 'restore' }
      if (value === 'change' || value === 'auto') return { key: 'reasonChange', cls: '' }
      return { key: 'reasonAuto', cls: 'muted' }
    }

    function deriveHealth(state) {
      if (!state) return { level: 'error', code: 'last-error', message: '' }
      if (state.paused) return { level: 'off', code: 'paused', message: '' }
      if (state.enabled === false) return { level: 'off', code: 'disabled', message: '' }
      if (state.lastError) return { level: 'error', code: 'last-error', message: String(state.lastError) }
      if (state.watching === false || (state.config && state.config.watch === false)) {
        return { level: 'warn', code: 'watching-off', message: '' }
      }
      // 旧 Host 没有 health 字段时：只要 watcher 在、没有错误，就认为健康。
      // 快照新旧不作为判据 —— 没有文件变化本来就不会产生新快照。
      return { level: 'ok', code: 'healthy', message: '' }
    }

    function healthDot(level) {
      if (level === 'ok') return 'ok'
      if (level === 'warn') return 'warn'
      if (level === 'error') return 'err'
      return 'off'
    }

    async function api(action, payload) {
      const init = action
        ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ action, ...(payload || {}) }),
        }
        : { credentials: 'same-origin', headers: { accept: 'application/json' } }
      const response = await fetch(ROUTE, init)
      const data = await response.json().catch(() => null)
      if (!data) throw Object.assign(new Error('响应不是 JSON'), { code: 'bad-response' })
      if (!data.ok) {
        const error = data.error || {}
        throw Object.assign(new Error(error.message || `请求失败（HTTP ${response.status}）`), { code: error.code })
      }
      return data
    }

    /* ------------------------------------------------------------------ 图标 */

    function IconShield(props) {
      const size = (props && props.size) || 18
      return h('svg', {
        width: size, height: size, viewBox: '0 0 20 20', fill: 'none',
        'aria-hidden': 'true', style: { display: 'block' },
      },
        h('path', {
          d: 'M10 2.4 16.4 4.6v4.1c0 3.7-2.7 6.5-6.4 7.7-3.7-1.2-6.4-4-6.4-7.7V4.6L10 2.4Z',
          stroke: 'currentColor', strokeWidth: 1.35, strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'm7.2 9.5 2 2 3.6-3.7',
          stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round', strokeLinejoin: 'round',
        }))
    }

    /* 第一席 · 忆匣：关而不锁的方匣，匣内碎晶按内容排布。 */
    function IconCasket(props) {
      const size = (props && props.size) || 18
      return h('svg', {
        width: size, height: size, viewBox: '0 0 20 20', fill: 'none',
        'aria-hidden': 'true', style: { display: 'block' },
      },
        h('path', {
          d: 'M4.2 9.1 6.3 5.5h7.4l2.1 3.6',
          stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('rect', {
          x: 4.2, y: 9.1, width: 11.6, height: 7.6, rx: 1.8,
          stroke: 'currentColor', strokeWidth: 1.35,
        }),
        h('path', { d: 'm7.5 12.6 1-1.1 1 1.1-1 1.1z', fill: 'currentColor' }),
        h('path', { d: 'm10.5 12.6 1-1.1 1 1.1-1 1.1z', fill: 'currentColor', opacity: .72 }))
    }

    function IconRefresh(props) {
      const size = (props && props.size) || 14
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': 'true', style: { display: 'block' },
      },
        h('path', { d: 'M13.2 6.4A5.4 5.4 0 1 0 13 8.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { d: 'M13.4 2.5v4.1H9.3', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function IconChevron() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
        h('path', { d: 'M4.4 2.4 8 6l-3.6 3.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function IconSearch() {
      return h('svg', { width: 13, height: 13, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
        h('circle', { cx: 6.2, cy: 6.2, r: 4.2, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'm9.4 9.4 2.6 2.6', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }))
    }

    function IconCheck() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
        h('circle', { cx: 8, cy: 8, r: 6.2, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'm5.4 8.1 1.8 1.8 3.5-3.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function IconAlert() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
        h('path', { d: 'M8 2.2 14.2 13H1.8L8 2.2Z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
        h('path', { d: 'M8 6.2v3.1', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('circle', { cx: 8, cy: 11.2, r: .75, fill: 'currentColor' }))
    }

    function IconLock(props) {
      const size = (props && props.size) || 14
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
        h('rect', { x: 3.4, y: 7, width: 9.2, height: 6.2, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M5.7 7V5.3a2.3 2.3 0 0 1 4.6 0V7', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('circle', { cx: 8, cy: 10.1, r: .85, fill: 'currentColor' }))
    }

    function IconKey() {
      return h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
        h('circle', { cx: 5.6, cy: 10.4, r: 2.7, stroke: 'currentColor', strokeWidth: 1.25 }),
        h('path', { d: 'm7.6 8.4 5-5M10.4 5.6 12 7.2M11.6 4.4 13.2 6', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    /* ------------------------------------------------------------------ 通用件 */

    function Btn(props) {
      const p = props || {}
      const cls = ['dbk-btn']
      if (p.variant) cls.push(p.variant)
      if (p.small) cls.push('small')
      if (p.lg) cls.push('lg')
      if (p.iconOnly) cls.push('icon')
      return h('button', {
        type: 'button',
        className: cls.join(' '),
        onClick: p.onClick,
        disabled: p.disabled,
        title: p.title,
        'aria-label': p.ariaLabel || p.title,
        'data-dbk-action': p.action || undefined,
      },
      p.busy ? h('span', { className: 'dbk-spin' }) : (p.icon || null),
      p.iconOnly ? null : (p.children || null))
    }

    function Switch(props) {
      const p = props || {}
      return h('button', {
        type: 'button',
        className: 'dbk-switch',
        role: 'switch',
        'aria-checked': p.on ? 'true' : 'false',
        'aria-label': p.label,
        disabled: p.disabled,
        onClick: p.onToggle,
      }, h('span', { className: 'dbk-knob' }))
    }

    function Row(props) {
      const p = props || {}
      return h('div', { className: 'dbk-row' + (p.className ? ' ' + p.className : '') },
        h('div', { className: 'dbk-row-main' },
          h('div', { className: 'dbk-row-title' }, p.title,
            p.badge || null),
          p.desc ? h('div', { className: 'dbk-row-desc' + (p.mono ? ' mono' : '') + (p.error ? ' err' : '') }, p.desc) : null,
          p.note ? h('div', { className: 'dbk-row-note' }, p.note) : null),
        p.children ? h('div', { className: 'dbk-row-action' }, p.children) : null)
    }

    function Stat(props) {
      return h('div', { className: 'dbk-stat' },
        h('div', { className: 'dbk-stat-val' }, props.value),
        h('div', { className: 'dbk-stat-label' }, props.label))
    }

    function Toast(props) {
      const toast = props.toast
      if (!toast) return null
      return h('div', {
        className: 'dbk-toast', role: 'status', 'aria-live': 'polite',
      },
      h('span', { className: 'dbk-ico', style: { color: toast.kind === 'err' ? '#ffb4ae' : 'currentColor' } },
        toast.kind === 'err' ? h(IconAlert) : h(IconCheck)),
      h('span', null, toast.text))
    }

    /* ------------------------------------------------------------------ 面板 */

    function PanelBody(props) {
      const t = props.t
      const ctx = props.ctx
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [toast, setToast] = useState(null)
      const [confirm, setConfirm] = useState(null)
      const [verify, setVerify] = useState(null)
      const [query, setQuery] = useState('')
      const [openDays, setOpenDays] = useState({})
      const [showAllDays, setShowAllDays] = useState({})
      const [draft, setDraft] = useState(null)
      const [dirty, setDirty] = useState(false)
      const [saving, setSaving] = useState(false)
      const [restoreBanner, setRestoreBanner] = useState(null)
      const [dismissedAt, setDismissedAt] = useState(0)
      const [tab, setTab] = useState('overview')
      const [subView, setSubView] = useState('')
      const [rescueOpen, setRescueOpen] = useState(false)
      const [filesOpen, setFilesOpen] = useState(false)

      const busyRef = useRef(false)
      const dirtyRef = useRef(false)
      const confirmRef = useRef(null)
      const pageRef = useRef(null)
      busyRef.current = Boolean(busy) || Boolean(state && state.busy)
      dirtyRef.current = dirty
      confirmRef.current = confirm

      const toastTimer = useRef(null)

      /* ---- 异地副本（状态机：未初始化 / 已锁定 / 已解锁 / 进度 / 完成待重启） ---- */
      const [off, setOff] = useState(null)
      const [offLoaded, setOffLoaded] = useState(false)
      // '' = 支持；'restart' = 旧 Host（没有 offsite 字段）；'missing' = 新 Host 但服务不可用
      const [offUnsupported, setOffUnsupported] = useState('')
      const [offBusy, setOffBusy] = useState('')
      const [offDraft, setOffDraft] = useState(null)
      const [offDirty, setOffDirty] = useState(false)
      // 恢复密码只在 React 内存里：不写 localStorage / sessionStorage，也不进 URL
      const [offPassword, setOffPassword] = useState('')
      const [offSavedAt, setOffSavedAt] = useState(0)
      const offBusyRef = useRef(false)
      const offDirtyRef = useRef(false)
      offBusyRef.current = Boolean(offBusy) || Boolean(off && off.busy)
      offDirtyRef.current = offDirty

      /* ---- 崩溃监控 ---- */
      const [mon, setMon] = useState(null)
      const [monLoaded, setMonLoaded] = useState(false)
      // '' = 支持；'old' = 旧 Host（state 里没有 monitor 字段）
      const [monUnsupported, setMonUnsupported] = useState('')
      const [monBusy, setMonBusy] = useState('')
      const monBusyRef = useRef(false)
      const monInitRef = useRef(false)
      monBusyRef.current = Boolean(monBusy)

      /* ---- 通知设置 / 备份根目录（task-14） ---- */
      const [notifyCfg, setNotifyCfg] = useState(null)
      const [notifyLoaded, setNotifyLoaded] = useState(false)
      const [notifyUnsupported, setNotifyUnsupported] = useState('')
      const [notifyDraft, setNotifyDraft] = useState(null)
      const [notifySecretsDraft, setNotifySecretsDraft] = useState({ smtpPassword: '', qqToken: '', webhookTokens: {} })
      const [notifyBusy, setNotifyBusy] = useState('')
      const [notifyResults, setNotifyResults] = useState({})
      const notifyBusyRef = useRef(false)
      notifyBusyRef.current = Boolean(notifyBusy)
      const [rootEdit, setRootEdit] = useState(null)
      const [rootPending, setRootPending] = useState('')
      const [rootBusy, setRootBusy] = useState(false)
      const rootBusyRef = useRef(false)
      rootBusyRef.current = rootBusy

      const notify = useCallback((kind, text) => {
        setToast({ kind, text })
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 6000)
      }, [])

      useEffect(() => () => {
        if (toastTimer.current) clearTimeout(toastTimer.current)
      }, []) // 卸载时清掉 toast 计时器（不要改成每渲染清理）

      // 面板自身滚动：父容器高度可能是 auto（这时 CSS 百分比高度不生效），
      // 所以按「父容器可见高度 / 窗口高度取小」显式定高，窗口缩放 / 侧栏折叠时重算。
      useEffect(() => {
        if (typeof window === 'undefined') return undefined
        let last = 0
        let observer = null
        const fit = () => {
          const el = pageRef.current
          if (!el) return
          const parent = el.parentElement
          const avail = parent && parent.clientHeight > 80 ? parent.clientHeight : window.innerHeight
          const height = Math.max(240, Math.min(avail, window.innerHeight))
          if (Math.abs(height - last) < 1) return
          last = height
          el.style.height = `${Math.round(height)}px`
        }
        fit()
        const timer = setTimeout(fit, 60)
        window.addEventListener('resize', fit)
        const parent = pageRef.current && pageRef.current.parentElement
        if (parent && typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(() => fit())
          observer.observe(parent)
        }
        return () => {
          clearTimeout(timer)
          window.removeEventListener('resize', fit)
          if (observer) observer.disconnect()
        }
      }, [])

      // 弹窗键盘：Esc 关闭（恢复进行中除外）
      useEffect(() => {
        if (!confirm) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          if (confirm && confirm.restoring) return
          setConfirm(null)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [confirm])

      // 弹窗打开时把焦点放进弹窗，关闭时归还（v0.8 无障碍）
      const modalReturnRef = useRef(null)
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        if (confirm) {
          if (!modalReturnRef.current) modalReturnRef.current = document.activeElement
          const timer = setTimeout(() => {
            const el = document.querySelector('.dbk-modal [data-dbk-autofocus="1"], .dbk-modal .dbk-modal-close, .dbk-modal')
            if (el && typeof el.focus === 'function') el.focus()
          }, 30)
          return () => clearTimeout(timer)
        }
        const prev = modalReturnRef.current
        modalReturnRef.current = null
        if (prev && typeof prev.focus === 'function') {
          try { prev.focus() } catch (err) { /* ignore */ }
        }
        return undefined
      }, [confirm])

      const nextDraft = (cfg) => {
        const c = cfg || {}
        return {
          minIntervalSec: String(Math.round((Number(c.minIntervalMs) || 60000) / 1000)),
          keepLast: String(c.keepLast == null ? 60 : c.keepLast),
          maxSnapshots: String(c.maxSnapshots == null ? 100 : c.maxSnapshots),
          keepHourly: String(c.keepHourlyHours == null ? 48 : c.keepHourlyHours),
          keepDaily: String(c.keepDailyDays == null ? 30 : c.keepDailyDays),
          excludes: (Array.isArray(c.excludes) ? c.excludes : []).join(', '),
        }
      }

      const load = useCallback(async (quiet) => {
        try {
          const data = await api()
          if (data && data.state) {
            setState(data.state)
            setError('')
            if (!dirtyRef.current) setDraft(nextDraft(data.state.config))
          }
        } catch (err) {
          if (!quiet) setError(String((err && err.message) || err))
        }
      }, [])

      useEffect(() => {
        load(false)
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          if (busyRef.current || dirtyRef.current || confirmRef.current) return
          load(true)
        }, 5000)
        return () => clearInterval(timer)
      }, [load])

      /* ---------------- 异地副本：加载 / 5s 进度轮询 ---------------- */

      const offNextDraft = (value) => {
        const c = (value && value.config) || {}
        const quotaBytes = Number(c.quotaBytes) || 20 * 1024 ** 3
        return {
          retainDaily: String(c.retainDaily == null ? 7 : c.retainDaily),
          retainWeekly: String(c.retainWeekly == null ? 4 : c.retainWeekly),
          quotaGb: String(Math.max(1, Math.round(quotaBytes / 1024 ** 3))),
          schedule: c.schedule == null ? '04:00' : String(c.schedule),
        }
      }

      const loadOffsite = useCallback(async (probe) => {
        try {
          const data = await api('offsite-state', probe ? { probe: true } : undefined)
          const next = data.offsite || null
          setOff(next)
          setOffUnsupported('')
          setOffLoaded(true)
          if (!offDirtyRef.current) setOffDraft(offNextDraft(next))
          return next
        } catch (err) {
          const code = err && err.code
          if (code === 'unknown-action' || code === 'offsite-unavailable') {
            setOffUnsupported(code === 'unknown-action' ? 'restart' : 'missing')
          }
          setOffLoaded(true)
          return null
        }
      }, [])

      const panelReady = Boolean(state)
      useEffect(() => {
        if (!panelReady || offUnsupported) return undefined
        loadOffsite(false)
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          if (offBusyRef.current) return
          loadOffsite(false)
        }, 5000)
        return () => clearInterval(timer)
        // offConfirm 变化不重开轮询：这里只用于读取当前值，故意不进依赖
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [panelReady, offUnsupported, loadOffsite])

      /* ---------------- 崩溃监控：状态同步 / 10s ping / 默认展开 ---------------- */

      useEffect(() => {
        if (!state) return
        // 旧 Host 的 state 里没有 monitor 字段 → 整块降级（不渲染红条/section）
        if (!Object.prototype.hasOwnProperty.call(state, 'monitor')) {
          setMonUnsupported('old')
          setMonLoaded(true)
          return
        }
        setMonUnsupported('')
        setMonLoaded(true)
        setMon(state.monitor || null)
      }, [state])

      useEffect(() => {
        if (!panelReady || monUnsupported) return undefined
        let alive = true
        const ping = () => {
          api('monitor-ping').catch((err) => {
            if (!alive) return
            const code = err && err.code
            if (code === 'unknown-action' || code === 'monitor-unavailable') setMonUnsupported('old')
          })
        }
        ping()
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          ping()
        }, 10000)
        return () => { alive = false; clearInterval(timer) }
      }, [panelReady, monUnsupported])

      /* ---------------- 通知设置 / 备份根目录（task-14） ---------------- */

      const notifyNextDraft = (cfg) => {
        const c = cfg || {}
        const email = c.email || {}
        const qq = c.qq || {}
        return {
          panel: c.panel !== false,
          toast: c.toast !== false,
          retries: String(c.retries == null ? 2 : c.retries),
          outboxMaxAttempts: String(c.outboxMaxAttempts == null ? 12 : c.outboxMaxAttempts),
          webhook: (Array.isArray(c.webhook) ? c.webhook : []).map((hook) => ({
            name: String(hook.name || ''),
            url: String(hook.url || ''),
            enabled: hook.enabled !== false,
            retries: String(hook.retries == null ? 2 : hook.retries),
            timeoutMs: String(hook.timeoutMs == null ? 8000 : hook.timeoutMs),
            token: '',
          })),
          email: {
            enabled: email.enabled === true,
            host: String(email.host || ''),
            port: String(email.port == null ? 587 : email.port),
            useSsl: email.useSsl !== false,
            user: String(email.user || ''),
            from: String(email.from || ''),
            to: (Array.isArray(email.to) ? email.to : []).join(', '),
            password: '',
          },
          qq: {
            enabled: qq.enabled === true,
            http: String(qq.http || ''),
            action: String(qq.action || 'send_private_msg'),
            target: String(qq.target || ''),
            token: '',
          },
          peer: { enabled: Boolean(c.peer && c.peer.enabled === true) },
        }
      }

      const loadNotify = useCallback(async () => {
        try {
          const data = await api('notify-state')
          const notifyValue = data.notify || null
          setNotifyCfg(notifyValue)
          if (notifyValue) setNotifyDraft(notifyNextDraft(notifyValue.config))
          setNotifySecretsDraft({ smtpPassword: '', qqToken: '', webhookTokens: {} })
          setNotifyLoaded(true)
          setNotifyUnsupported('')
          return notifyValue
        } catch (err) {
          const code = err && err.code
          if (code === 'unknown-action' || code === 'monitor-unavailable') {
            setNotifyUnsupported('old')
          } else {
            notify('err', fill(t('notifyLoadFailed'), { message: String((err && err.message) || err) }))
          }
          setNotifyLoaded(true)
          return null
        }
      }, [])

      useEffect(() => {
        if (!panelReady || monUnsupported) return
        if (notifyLoaded || notifyUnsupported) return
        loadNotify()
        // 只在第一次进入时加载；之后由保存/测试动作刷新
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [panelReady, monUnsupported, notifyLoaded, notifyUnsupported])

      const notifyChannelLabel = (channel) => {
        const map = {
          panel: 'monChannelPanel',
          toast: 'monChannelToast',
          webhook: 'monChannelWebhook',
          email: 'monChannelEmail',
          qq: 'monChannelQQ',
          peer: 'monChannelPeer',
        }
        return t(map[String(channel || '')] || 'monChannelPanel')
      }

      const editNotify = (patch) => setNotifyDraft((value) => (value ? { ...value, ...patch } : value))

      const editNotifyEmail = (patch) => setNotifyDraft((value) => (
        value ? { ...value, email: { ...value.email, ...patch } } : value
      ))

      const editNotifyQQ = (patch) => setNotifyDraft((value) => (
        value ? { ...value, qq: { ...value.qq, ...patch } } : value
      ))

      const editNotifyHook = (index, patch) => setNotifyDraft((value) => {
        if (!value) return value
        const webhook = value.webhook.map((hook, i) => (i === index ? { ...hook, ...patch } : hook))
        return { ...value, webhook }
      })

      const addNotifyHook = () => setNotifyDraft((value) => {
        if (!value) return value
        return {
          ...value,
          webhook: [...value.webhook, {
            name: `hook${value.webhook.length + 1}`,
            url: '',
            enabled: true,
            retries: '2',
            timeoutMs: '8000',
            token: '',
          }],
        }
      })

      const removeNotifyHook = (index) => setNotifyDraft((value) => (
        value ? { ...value, webhook: value.webhook.filter((hook, i) => i !== index) } : value
      ))

      const notifyBuildPayload = () => {
        const draftValue = notifyDraft || {}
        const secrets = { webhookTokens: {} }
        const emailPassword = draftValue.email ? String(draftValue.email.password || '') : ''
        if (emailPassword) secrets.smtpPassword = emailPassword
        const qqToken = draftValue.qq ? String(draftValue.qq.token || '') : ''
        if (qqToken) secrets.qqToken = qqToken
        for (const [index, hook] of (draftValue.webhook || []).entries()) {
          const token = String(hook.token || '')
          if (token) secrets.webhookTokens[String(hook.name || `webhook${index + 1}`)] = token
        }
        return {
          config: {
            panel: draftValue.panel !== false,
            toast: draftValue.toast !== false,
            retries: Number(draftValue.retries) || 2,
            outboxMaxAttempts: Number(draftValue.outboxMaxAttempts) || 12,
            webhook: (draftValue.webhook || []).map((hook) => ({
              name: hook.name,
              url: hook.url,
              enabled: hook.enabled !== false,
              retries: Number(hook.retries) || 2,
              timeoutMs: Number(hook.timeoutMs) || 8000,
            })),
            email: {
              enabled: Boolean(draftValue.email && draftValue.email.enabled),
              host: draftValue.email ? draftValue.email.host : '',
              port: Number(draftValue.email && draftValue.email.port) || 587,
              useSsl: Boolean(draftValue.email && draftValue.email.useSsl),
              user: draftValue.email ? draftValue.email.user : '',
              from: draftValue.email ? draftValue.email.from : '',
              to: String((draftValue.email && draftValue.email.to) || '')
                .split(/[,，;；\s]+/)
                .map((item) => item.trim())
                .filter(Boolean),
            },
            qq: {
              enabled: Boolean(draftValue.qq && draftValue.qq.enabled),
              http: draftValue.qq ? draftValue.qq.http : '',
              action: draftValue.qq ? draftValue.qq.action : 'send_private_msg',
              target: draftValue.qq ? draftValue.qq.target : '',
            },
            peer: { enabled: Boolean(draftValue.peer && draftValue.peer.enabled) },
          },
          secrets,
        }
      }

      const onNotifySave = async () => {
        if (notifyBusyRef.current) return
        setNotifyBusy('save')
        notifyBusyRef.current = true
        try {
          const payload = notifyBuildPayload()
          const data = await api('notify-save', payload)
          setNotifyCfg(data.notify || null)
          if (data.notify) setNotifyDraft(notifyNextDraft(data.notify.config))
          setNotifySecretsDraft({ smtpPassword: '', qqToken: '', webhookTokens: {} })
          notify('ok', t('notifySaved'))
        } catch (err) {
          const code = err && err.code
          if (code === 'unknown-action' || code === 'monitor-unavailable') {
            setNotifyUnsupported('old')
            notify('err', t('notifyUnsupported'))
          } else {
            notify('err', fill(t('notifySaveFailed'), { message: String((err && err.message) || err) }))
          }
        } finally {
          setNotifyBusy('')
          notifyBusyRef.current = false
        }
      }

      const onNotifyTest = async (channel) => {
        if (notifyBusyRef.current) return
        setNotifyBusy(`test:${channel}`)
        notifyBusyRef.current = true
        try {
          const data = await api('notify-test', { channel })
          const test = data.test || {}
          if (data.notify) setNotifyCfg(data.notify)
          setNotifyResults((value) => ({ ...value, [channel]: test }))
          if (test.ok) {
            notify('ok', fill(t('notifyTestOk'), { channel: notifyChannelLabel(channel) }))
          } else {
            const result = test.result || {}
            const detail = result.detail || result.message || result.path || ''
            notify('err', fill(t('notifyTestFail'), {
              code: result.code || 'unknown',
              detail: String(detail).slice(0, 160),
            }))
            if (result.code === 'watchdog-missing') notify('err', t('notifyWatchdogMissing'))
            if (result.code === 'test-notify-unavailable') notify('err', t('notifyTestUnavailable'))
          }
        } catch (err) {
          notify('err', fill(t('notifyTestFail'), {
            code: String((err && err.code) || 'action'),
            detail: String((err && err.message) || err).slice(0, 160),
          }))
        } finally {
          setNotifyBusy('')
          notifyBusyRef.current = false
        }
      }

      const openRootEdit = () => {
        const current = (state && state.root) || ''
        setRootEdit({ open: true, value: current, preview: null, error: '' })
      }

      const onRootValidate = async () => {
        if (rootBusyRef.current || !rootEdit) return
        setRootBusy(true)
        rootBusyRef.current = true
        try {
          const data = await api('root-set', { root: rootEdit.value })
          setRootEdit((value) => (value ? { ...value, preview: data.rootResult || null, error: '' } : value))
        } catch (err) {
          setRootEdit((value) => (value ? { ...value, preview: null, error: String((err && err.message) || err) } : value))
        } finally {
          setRootBusy(false)
          rootBusyRef.current = false
        }
      }

      const onRootApply = async () => {
        if (rootBusyRef.current || !rootEdit) return
        setRootBusy(true)
        rootBusyRef.current = true
        try {
          const data = await api('root-set', { root: rootEdit.value, apply: true })
          const result = data.rootResult || {}
          setRootPending(result.root || '')
          setRootEdit(null)
          notify('ok', fill(t('rootChanged'), { root: result.root || '' }))
        } catch (err) {
          notify('err', fill(t('rootApplyFailed'), { message: String((err && err.message) || err) }))
        } finally {
          setRootBusy(false)
          rootBusyRef.current = false
        }
      }

      const run = async (action, payload, label) => {
        if (busyRef.current) return null
        setBusy(action)
        busyRef.current = true
        try {
          const data = await api(action, payload)
          if (data.state) {
            setState(data.state)
            if (!dirtyRef.current) setDraft(nextDraft(data.state.config))
          }
          return data
        } catch (err) {
          if (err && err.code === 'unknown-action') {
            notify('err', t('unknownAction'))
          } else {
            notify('err', fill(t('actionFailed'), { action: label || action, message: String((err && err.message) || err) }))
          }
          return null
        } finally {
          setBusy('')
          busyRef.current = false
        }
      }

      const openTarget = async (target) => {
        if (busyRef.current) return
        setBusy('open')
        busyRef.current = true
        try {
          try {
            await api('open', { target })
            return
          } catch (err) {
            if (err && err.code !== 'unknown-action') throw err
          }
          if (target === 'store') {
            await api('open-dir')
            return
          }
          throw Object.assign(new Error(t('unknownAction')), { code: 'unknown-action' })
        } catch (err) {
          notify('err', fill(t('openFailed'), { message: String((err && err.message) || err) }))
        } finally {
          setBusy('')
          busyRef.current = false
        }
      }

      const onBackup = async () => {
        const data = await run('backup', {}, t('backup'))
        if (!data) return
        const r = data.result || {}
        if (r.skipped) {
          if (r.reason === 'paused') notify('err', t('backupPausedToast'))
          else if (r.reason === 'disabled') notify('err', t('backupDisabledToast'))
          else notify('ok', t('backupSkipped'))
        } else {
          notify('ok', fill(t('backupToast'), {
            files: fmtInt(r.files),
            changed: fmtInt(r.changed),
            size: fmtBytes(r.bytes),
          }))
        }
      }

      const onToggle = async () => {
        const paused = Boolean(state && state.paused)
        const data = await run(paused ? 'resume' : 'pause', {}, paused ? t('resumedToast') : t('pausedToast'))
        if (data) notify('ok', paused ? t('resumedToast') : t('pausedToast'))
      }

      const onResumeAndBackup = async () => {
        const data = await run('resume', {}, t('resumedToast'))
        if (!data) return
        notify('ok', t('resumedToast'))
        await onBackup()
      }

      const openRestore = async (snap, retry) => {
        setFilesOpen(false)
        setConfirm((current) => (
          retry && current && current.kind === 'restore' && current.id === snap.id
            ? { ...current, loading: true, error: '' }
            : { kind: 'restore', id: snap.id, snap, loading: true, preview: null, unsupported: false, error: '' }
        ))
        try {
          const data = await api('preview', { id: snap.id })
          setConfirm((current) => (
            current && current.kind === 'restore' && current.id === snap.id
              ? { ...current, loading: false, preview: data.preview, error: '' }
              : current
          ))
        } catch (err) {
          const code = err && err.code
          setConfirm((current) => (
            current && current.kind === 'restore' && current.id === snap.id
              ? {
                ...current,
                loading: false,
                unsupported: code === 'unknown-action',
                error: code === 'unknown-action' ? '' : String((err && err.message) || err),
              }
              : current
          ))
        }
      }

      const doRestore = async () => {
        const target = confirm
        if (!target || target.restoring) return
        setConfirm({ ...target, restoring: true, error: '' })
        setBusy('restore')
        busyRef.current = true
        try {
          const data = await api('restore', { id: target.id })
          if (data.state) {
            setState(data.state)
            if (!dirtyRef.current) setDraft(nextDraft(data.state.config))
          }
          const r = data.result || {}
          const banner = {
            id: target.id,
            at: Date.now(),
            restored: Number(r.restored) || 0,
            unchanged: Number(r.unchanged) || 0,
            quarantined: Number(r.quarantined) || 0,
            extraLeft: Number(r.extraLeft) || 0,
            failed: Array.isArray(r.failed) ? r.failed.length : 0,
            preSnapshot: r.preSnapshot || null,
          }
          setConfirm(null)
          setRestoreBanner(banner)
          setTab('overview')
          setSubView('')
          notify('ok', fill(t('restoreToast'), { n: fmtInt(banner.restored) }))
          if (verify && verify.id === target.id) setVerify(null)
        } catch (err) {
          const message = String((err && err.message) || err)
          setConfirm((current) => (
            current && current.kind === 'restore' && current.id === target.id
              ? { ...current, restoring: false, error: message }
              : current
          ))
          notify('err', fill(t('restoreFailed'), { message }))
        } finally {
          setBusy('')
          busyRef.current = false
        }
      }

      const openDelete = (snap) => {
        setConfirm({ kind: 'delete', id: snap.id, snap })
      }

      const doDelete = async () => {
        const target = confirm
        if (!target) return
        setConfirm(null)
        const data = await run('delete', { id: target.id }, t('delete'))
        if (!data) return
        notify('ok', fill(t('deleteToast'), { id: target.id }))
        if (verify && verify.id === target.id) setVerify(null)
      }

      const doOffClear = async () => {
        setConfirm(null)
        await onOffClearKey()
      }

      const runVerify = async () => {
        if (busyRef.current) return
        setVerify({ loading: true })
        try {
          const data = await api('verify', {})
          const v = data.verify || {}
          setVerify({
            id: v.id,
            ok: Boolean(v.ok),
            files: Number(v.files) || 0,
            missingCount: Number(v.missingCount) || 0,
            missing: Array.isArray(v.missing) ? v.missing.slice(0, 5) : [],
            checkedAt: Number(v.checkedAt) || Date.now(),
            loading: false,
          })
          if (data.state) setState(data.state)
          notify(v.ok ? 'ok' : 'err', v.ok
            ? fill(t('checkOk'), { files: fmtInt(v.files) })
            : fill(t('checkMissing'), { n: fmtInt(v.missingCount) }))
        } catch (err) {
          if (err && err.code === 'unknown-action') {
            setVerify({ unsupported: true, loading: false })
            notify('err', t('checkUnsupported'))
          } else {
            setVerify({ loading: false })
            notify('err', fill(t('actionFailed'), { action: t('check'), message: String((err && err.message) || err) }))
          }
        }
      }

      const onSave = async () => {
        if (!draft || saving) return
        const seconds = clampInt(draft.minIntervalSec, 10, 86400)
        const keep = clampInt(draft.keepLast, 1, 1000)
        const maxKeep = clampInt(draft.maxSnapshots, 5, 10000)
        const hourly = clampInt(draft.keepHourly, 0, 8760)
        const daily = clampInt(draft.keepDaily, 0, 3650)
        if (seconds == null) { notify('err', t('intervalInvalid')); return }
        if (keep == null) { notify('err', t('keepInvalid')); return }
        if (maxKeep == null) { notify('err', t('maxSnapshotsInvalid')); return }
        setSaving(true)
        const data = await run('config', {
          config: {
            minIntervalMs: seconds * 1000,
            keepLast: keep,
            maxSnapshots: maxKeep,
            keepHourlyHours: hourly == null ? 0 : hourly,
            keepDailyDays: daily == null ? 0 : daily,
            excludes: parseExcludes(draft.excludes),
          },
        }, t('save'))
        setSaving(false)
        if (!data) return
        setDirty(false)
        dirtyRef.current = false
        setDraft(nextDraft((data.state && data.state.config) || (state && state.config)))
        notify('ok', t('saved'))
      }

      const editDraft = (patch) => {
        setDraft((current) => ({ ...(current || {}), ...patch }))
        setDirty(true)
        dirtyRef.current = true
      }

      const copyText = async (text) => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text)
            notify('ok', t('copied'))
            return
          }
        } catch (err) { /* fall through */ }
        try {
          const area = document.createElement('textarea')
          area.value = text
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          document.execCommand('copy')
          document.body.removeChild(area)
          notify('ok', t('copied'))
        } catch (err) {
          notify('err', String((err && err.message) || err))
        }
      }

      /* ---------------- 异地副本动作 ---------------- */

      const offNotify = (kind, text) => notify(kind, text)

      const offFail = (err, label) => {
        const code = err && err.code
        if (code === 'unknown-action' || code === 'offsite-unavailable') {
          setOffUnsupported('restart')
          offNotify('err', t('offUnsupported'))
          return
        }
        offNotify('err', fill(t('actionFailed'), { action: label, message: String((err && err.message) || err) }))
      }

      const runOffsite = async (action, payload, label) => {
        if (offBusyRef.current) {
          offNotify('err', t('offBusyOther'))
          return null
        }
        setOffBusy(action)
        offBusyRef.current = true
        try {
          const data = await api(action, payload)
          if (data.offsite) {
            setOff(data.offsite)
            if (!offDirtyRef.current) setOffDraft(offNextDraft(data.offsite))
            setOffUnsupported('')
          }
          return data
        } catch (err) {
          offFail(err, label)
          return null
        } finally {
          setOffBusy('')
          offBusyRef.current = false
        }
      }

      const validateOffPassword = (value) => {
        const text = String(value || '')
        if (text.length < 9) return t('offPasswordWeak')
        if (!/[A-Za-z]/.test(text) || !/[0-9]/.test(text)) return t('offPasswordWeak')
        return ''
      }

      const onOffInit = async () => {
        const password = offPassword
        const invalid = validateOffPassword(password)
        if (invalid) { offNotify('err', invalid); return }
        const data = await runOffsite('offsite-init', { password }, t('offInit'))
        if (data) {
          setOffPassword('')
          offNotify('ok', t('offInitOk'))
        }
      }

      const onOffUnlock = async (useCache) => {
        const payload = useCache ? { useCache: true } : { password: offPassword }
        if (!useCache) {
          if (!offPassword) { offNotify('err', t('offPasswordNeeded')); return }
          const invalid = validateOffPassword(offPassword)
          if (invalid) { offNotify('err', invalid); return }
        }
        const data = await runOffsite('offsite-unlock', payload, useCache ? t('offCacheUse') : t('offUnlock'))
        if (data) {
          setOffPassword('')
          offNotify('ok', t('offUnlockOk'))
        }
      }

      const onOffLock = async () => {
        if (await runOffsite('offsite-lock', {}, t('offLock'))) offNotify('ok', t('offLockedToast'))
      }

      const onOffClearKey = async () => {
        if (await runOffsite('offsite-clear-key', {}, t('offCacheClear'))) offNotify('ok', t('offCacheCleared'))
      }

      const onOffExport = async () => {
        const data = await runOffsite('offsite-export', {}, t('offExport'))
        if (!data) return
        const r = data.result || {}
        offNotify('ok', fill(t('offExportOk'), { files: fmtInt(r.files), chunks: fmtInt(r.newChunks) }))
        if (r.sync && r.sync.ok === false && r.sync.code === 'peer-offline') offNotify('err', t('offPeerOffline'))
      }

      const onOffSync = async () => {
        const data = await runOffsite('offsite-sync', {}, t('offSync'))
        if (!data) return
        const r = data.result || {}
        if (r.upToDate) offNotify('ok', t('offSyncUpToDate'))
        else offNotify('ok', fill(t('offSyncOk'), { packs: fmtInt(r.uploaded), size: fmtBytes(r.uploadedBytes) }))
      }

      const onOffDrill = async (snapshotId) => {
        const data = await runOffsite('offsite-drill', snapshotId ? { snapshotId } : {}, t('offDrill'))
        if (!data) return
        const r = data.result || {}
        if (r.ok) offNotify('ok', fill(t('offDrillOk'), { files: fmtInt(r.files) }))
        else offNotify('err', fill(t('offDrillBad'), { n: fmtInt(r.mismatched) }))
      }

      const onOffRestore = async () => {
        const target = confirm && confirm.kind === 'off-restore' ? confirm.item : null
        if (!target) return
        setConfirm(null)
        const data = await runOffsite('offsite-restore', { snapshotId: target.snapshotId }, t('offRestore'))
        if (!data) return
        const r = data.result || {}
        const restore = r.restore || {}
        const restored = Number(restore.restored) || 0
        // 复用现有「恢复完成，请重启 DSH」banner
        setRestoreBanner({
          at: Date.now(),
          restored,
          unchanged: Number(restore.unchanged) || 0,
          quarantined: Number(restore.quarantined) || 0,
          extraLeft: Number(restore.extraLeft) || 0,
          failed: Array.isArray(restore.failed) ? restore.failed.length : 0,
          preSnapshot: restore.preSnapshot || null,
        })
        setDismissedAt(0)
        offNotify('ok', fill(t('offRestoreOk'), { n: fmtInt(restored) }))
        if (r.chainOk === false) offNotify('err', fill(t('offChainBroken'), { name: String(r.manifestName || '').slice(0, 24) }))
      }

      const editOffDraft = (patch) => {
        setOffDraft((current) => ({ ...(current || {}), ...patch }))
        setOffDirty(true)
        offDirtyRef.current = true
      }

      const onOffSave = async () => {
        if (!offDraft) return
        const daily = clampInt(offDraft.retainDaily, 1, 365)
        const weekly = clampInt(offDraft.retainWeekly, 0, 104)
        const quotaGb = clampInt(offDraft.quotaGb, 1, 1024)
        const schedule = String(offDraft.schedule || '').trim()
        if (daily == null) { offNotify('err', t('keepInvalid')); return }
        if (quotaGb == null) { offNotify('err', t('offQuotaInvalid')); return }
        if (schedule && !/^\d{1,2}:\d{2}$/.test(schedule)) { offNotify('err', t('offScheduleInvalid')); return }
        const data = await runOffsite('offsite-config', {
          config: {
            retainDaily: daily,
            retainWeekly: weekly == null ? 0 : weekly,
            quotaBytes: quotaGb * 1024 ** 3,
            schedule,
          },
        }, t('offSave'))
        if (!data) return
        setOffDirty(false)
        offDirtyRef.current = false
        setOffSavedAt(Date.now())
        offNotify('ok', t('offSaved'))
      }

      const onOffToggleEnabled = async () => {
        const enabled = !(off && off.config && off.config.enabled)
        const data = await runOffsite('offsite-config', { config: { enabled } }, t('offEnable'))
        if (data) offNotify('ok', enabled ? t('offEnableToast') : t('offDisabled'))
      }

      const onOffToggleWeeklyDrill = async () => {
        const weeklyDrill = !(off && off.config && off.config.weeklyDrill)
        await runOffsite('offsite-config', { config: { weeklyDrill } }, t('offWeeklyDrill'))
      }

      /** 「备份到 [设备选择]」：保存 peerDeviceId（空 = 恢复自动选择）。 */
      const onOffSelectPeer = async (deviceId) => {
        if (offBusyRef.current || !off) return
        const data = await runOffsite('offsite-config', { config: { peerDeviceId: String(deviceId || '') } }, t('offTarget'))
        if (!data) return
        const peers = (data.offsite && Array.isArray(data.offsite.peers) ? data.offsite.peers : [])
        const target = peers.find((peer) => peer.deviceId === deviceId)
          || (data.offsite && data.offsite.peer && data.offsite.peer.id === deviceId ? data.offsite.peer : null)
        const name = target ? (target.name || target.deviceId) : (deviceId || t('offTargetNone'))
        // 保存成功但目标离线：不是保存失败，提示「已选但当前离线」
        const offline = target
          ? target.online === false
          : Boolean(data.offsite && data.offsite.peer && data.offsite.peer.online === false)
        offNotify('ok', fill(t('offTargetSaved'), { name }) + (offline ? ' · ' + t('offTargetOffline') : ''))
      }

      const onOffCopyTask = async () => {
        const command = off && off.schedule && off.schedule.command
        if (!command) { offNotify('err', t('offNoSchedule')); return }
        await copyText(command.command || command.schtasks || '')
        offNotify('ok', t('offTaskCopied'))
      }

      /* ---------------- 崩溃监控动作 ---------------- */

      const monNotify = (kind, text) => notify(kind, text)

      const monFail = (err, label) => {
        const code = err && err.code
        if (code === 'unknown-action' || code === 'monitor-unavailable') {
          setMonUnsupported('old')
          monNotify('err', t('monUnsupported'))
          return
        }
        monNotify('err', fill(t('actionFailed'), { action: label, message: String((err && err.message) || err) }))
      }

      const runMonitor = async (action, payload, label) => {
        if (monBusyRef.current) return null
        setMonBusy(action)
        monBusyRef.current = true
        try {
          const data = await api(action, payload)
          if (data.monitor) setMon(data.monitor)
          return data
        } catch (err) {
          monFail(err, label)
          return null
        } finally {
          setMonBusy('')
          monBusyRef.current = false
        }
      }

      const onMonAck = async (incident) => {
        if (!incident) return
        const data = await runMonitor('monitor-ack', { id: incident.id }, t('monAck'))
        if (data) monNotify('ok', t('monAckOk'))
      }

      const onMonInstall = () => {
        setConfirm({ kind: 'mon-install' })
      }

      const doMonInstall = async () => {
        setConfirm(null)
        const data = await runMonitor('monitor-install', { apply: true }, t('monInstall'))
        if (!data) return
        const install = data.install || {}
        monNotify('ok', fill(t('monInstallOk'), { home: install.recoveryHome || '—' }))
      }

      const onMonRestore = (incident) => {
        if (!incident) return
        const recommendation = incident.recommendation || null
        if (!recommendation) { monNotify('err', t('monNoRecommend')); return }
        setConfirm({ kind: 'mon-restore', incident })
      }

      const doMonRestore = async () => {
        const target = confirm && confirm.incident
        setConfirm(null)
        const data = await runMonitor('monitor-restore', target ? { incidentId: target.id } : {}, t('monRestore'))
        if (!data) return
        const r = data.result || {}
        setRestoreBanner({
          at: Date.now(),
          restored: Number(r.restored) || 0,
          unchanged: Number(r.unchanged) || 0,
          quarantined: Number(r.quarantined) || 0,
          extraLeft: Number(r.extraLeft) || 0,
          failed: Array.isArray(r.failed) ? r.failed.length : 0,
          preSnapshot: r.preSnapshot || null,
        })
        setDismissedAt(0)
        setTab('overview')
        setSubView('')
        monNotify('ok', fill(t('monRestoreOk'), { n: fmtInt(r.restored) }))
      }

      /* ---------------- 加载 / 错误视图 ---------------- */

      if (!state && !error) {
        return h('div', { className: 'dbk-page' },
          h('header', { className: 'dbk-head' },
            h('div', { className: 'dbk-head-main' },
              h('h1', { className: 'dbk-head-title' }, t('title')),
              h('p', { className: 'dbk-head-sub' }, t('loading')))),
          h('section', { className: 'dbk-section' },
            h('div', { className: 'dbk-skel' },
              h('div', { className: 'dbk-skel-bar', style: { width: '46%' } }),
              h('div', { className: 'dbk-skel-bar' }))))
      }
      if (!state) {
        return h('div', { className: 'dbk-page' },
          h('header', { className: 'dbk-head' },
            h('div', { className: 'dbk-head-main' },
              h('h1', { className: 'dbk-head-title' }, t('title')),
              h('p', { className: 'dbk-head-sub' }, t('loadFailed')))),
          h('section', { className: 'dbk-section' },
            h('div', { className: 'dbk-row' },
              h('div', { className: 'dbk-row-main' },
                h('div', { className: 'dbk-row-title' }, h(IconAlert), t('loadFailed')),
                h('div', { className: 'dbk-row-desc' }, error)),
              h('div', { className: 'dbk-row-action' },
                h(Btn, { onClick: () => load(false) }, t('retry'))))))
      }

      /* ---------------- 派生数据 ---------------- */

      const config = state.config || {}
      const maxSnapshots = Math.max(5, Number(config.maxSnapshots) || 100)
      const snapshots = Array.isArray(state.snapshots) ? state.snapshots : []
      let health = state.health || deriveHealth(state)
      if (health.code === 'busy' && !busy) health = { level: 'ok', code: 'healthy', message: '', lastSnapshotAgeMs: health.lastSnapshotAgeMs }
      const dot = healthDot(health.level)
      const paused = Boolean(state.paused)
      const busyAny = Boolean(busy) || Boolean(state.busy)
      const blob = state.blob || null
      const last = state.lastSnapshot || null
      const working = busy === 'backup' ? t('backingUp') : t('working')

      const healthLabel = (() => {
        if (busy) return working
        if (!last && health.code !== 'paused' && health.code !== 'disabled') return t('notBackedUp')
        const map = {
          healthy: 'healthy',
          paused: 'pausedState',
          disabled: 'disabledState',
          'watching-off': 'watchOffState',
          stale: 'staleState',
          'last-error': 'errorState',
          busy: 'working',
        }
        return t(map[health.code] || 'healthy')
      })()

      const intervalText = () => {
        const sec = Math.max(1, Math.round((Number(config.minIntervalMs) || 60000) / 1000))
        if (sec >= 3600) return fill(t('durationHour'), { n: Math.round(sec / 3600) })
        if (sec >= 60) return fill(t('durationMin'), { n: Math.round(sec / 60) })
        return fill(t('durationSec'), { n: sec })
      }

      const snapshotCount = () => Number(state.snapshotCount != null ? state.snapshotCount : snapshots.length) || 0

      const lastLine = last
        ? fill(t('lastSnapshotLine'), {
          time: fmtFull(new Date(last.at)),
          ago: fmtAgo(state.lastSnapshotAgeMs, t),
          files: fmtInt(last.files),
        })
        : t('noSnapshotYet')

      const retention = (() => {
        const keepLast = Math.min(maxSnapshots, Number(config.keepLast) || 60)
        const hourly = Number(config.keepHourlyHours) || 0
        const daily = Number(config.keepDailyDays) || 0
        const now = Date.now()
        let recent = 0
        let hourlyCount = 0
        let dailyCount = 0
        snapshots.forEach((snap, index) => {
          if (index < keepLast) { recent += 1; return }
          const age = now - (Number(snap.at) || 0)
          if (hourly > 0 && age <= hourly * 3600000) hourlyCount += 1
          else if (daily > 0 && age <= daily * 86400000) dailyCount += 1
        })
        return { recent, hourly: hourlyCount, daily: dailyCount, keepLast, hourlyHours: hourly, dailyDays: daily }
      })()

      const filtered = (() => {
        const q = query.trim().toLowerCase()
        if (!q) return snapshots
        return snapshots.filter((snap) => {
          const d = new Date(snap.at)
          const hay = `${snap.id} ${fmtFull(d)} ${dayKey(snap.at)} ${snap.reason || ''}`.toLowerCase()
          return hay.includes(q)
        })
      })()

      const groups = (() => {
        const out = []
        const index = new Map()
        for (const snap of filtered) {
          const key = dayKey(snap.at)
          if (!index.has(key)) {
            const group = { key, at: snap.at, items: [] }
            index.set(key, group)
            out.push(group)
          }
          index.get(key).items.push(snap)
        }
        return out
      })()

      const bannerRestore = restoreBanner || state.lastRestore || null
      const bannerVisible = bannerRestore && (Number(bannerRestore.at) || 0) > dismissedAt

      const quarantines = Array.isArray(state.quarantines) ? state.quarantines : []
      const totalBytes = blob ? fmtBytes(blob.bytes) : '—'
      const retentionTotal = retention.recent + retention.hourly + retention.daily

      const offPeerInfo = (off && off.peer) || null
      const offProgressPhase = off && off.progress && off.progress.phase && off.progress.phase !== 'idle'
        ? off.progress.phase
        : ''
      const offWorking = Boolean(offBusy) || Boolean(offProgressPhase) || Boolean(off && off.busy)
      const offUnlocked = Boolean(off && off.initialized !== false && off.locked === false)
      const offArchivesHidden = Boolean(offPeerInfo && (offPeerInfo.sync === false || offPeerInfo.online === false))

      const monitorOpenIncidents = (mon && mon.incidents && Array.isArray(mon.incidents.open))
        ? mon.incidents.open
        : []
      const monitorPrimary = monitorOpenIncidents[0] || null
      const monitorRec = (monitorPrimary && monitorPrimary.recommendation) || (mon && mon.recommendation) || null
      const monitorBusyAny = Boolean(monBusy)

      const restoreDone = () => Boolean(bannerVisible)
      const offPhaseLabel = {
        exporting: 'offProgressExport',
        syncing: 'offProgressSync',
        fetching: 'offProgressFetch',
        restoring: 'offProgressRestore',
        drilling: 'offProgressDrill',
        pruning: 'offProgressSync',
      }

      const statusInfo = (() => {
        let tone = 'ok'
        let label = t('pillNormal')
        if (restoreDone()) { tone = 'warn'; label = t('pillRestored') }
        else if (monitorPrimary) { tone = 'bad'; label = t('pillIncident') }
        else if (paused) { tone = 'warn'; label = t('pillPaused') }
        else if (!last) { tone = 'mute'; label = t('pillEmpty') }
        const dotTone = tone === 'bad' ? 'err' : tone === 'warn' ? 'warn' : tone === 'mute' ? 'off' : 'ok'
        return { tone, label, dotTone }
      })()

      /* ---------------- 导航与动作桥接 ---------------- */

      function gotoBackups() {
        setSubView('')
        setTab('backups')
      }

      function openSub(next) {
        setTab('settings')
        setSubView(next)
        if (next === 'notify' && !notifyLoaded) loadNotify()
        if (next === 'offsite' && !offLoaded) loadOffsite(false)
      }

      function restoreFromRecommendation() {
        const rec = monitorRec
        if (!rec) return
        openRestore({
          id: rec.snapshotId,
          at: Number(rec.at) || Date.now(),
          files: Number(rec.files) || 0,
          reason: 'restore',
        })
      }

      function onRollback() {
        const id = (bannerRestore && bannerRestore.preSnapshot) || ''
        if (!id) { notify('err', t('rollbackMissing')); return }
        openRestore({ id, at: Date.now(), files: 0, reason: 'restore' })
      }

      function pausedAt() {
        const value = Number(state.pausedAt || (state.config && state.config.pausedAt) || 0)
        return Number.isFinite(value) ? value : 0
      }

      /* ---------------- 主渲染 ---------------- */

      return h('div', { className: 'dbk-page', ref: pageRef, 'data-dbk-view': subView || tab },
        renderHead(),
        renderRestart(),
        subView ? null : renderSegTabs(),
        tab === 'overview' ? renderOverview()
          : tab === 'backups' ? renderBackups()
            : tab === 'restore' ? renderRestorePage()
              : (subView ? renderSubPage() : renderSettings()),
        renderFooter(),
        renderConfirm(),
        h(Toast, { toast }))

      /* ---------------- 页头 / 页签 / 页脚 ---------------- */

      function renderHead() {
        const st = statusInfo
        return h('header', { className: 'dbk-head' },
          h('div', { className: 'dbk-head-main' },
            h('h1', { className: 'dbk-head-title' }, t('title')),
            h('p', { className: 'dbk-head-sub' }, t('subtitle'))),
          h('div', { className: 'dbk-head-side' },
            h('span', { className: 'dbk-status-pill', 'data-dbk-status': st.tone },
              h('span', { className: 'dbk-dot ' + st.dotTone }),
              st.label)))
      }

      function renderRestart() {
        if (!restoreDone()) return null
        return h('section', { className: 'dbk-section tone-warn', role: 'status', 'data-dbk-restart': '1' },
          h('div', { className: 'dbk-row' },
            h('span', { className: 'dbk-ico', style: { color: 'var(--dbk-warn-ink)' } }, h(IconRefresh, { size: 15 })),
            h('div', { className: 'dbk-row-main' },
              h('div', { className: 'dbk-row-title' }, t('restartBannerTitle')),
              h('div', { className: 'dbk-row-desc' }, t('restartBannerDesc')))))
      }

      function renderSegTabs() {
        const tabs = [
          { id: 'overview', label: t('tabOverview'), flag: monitorPrimary ? 'err' : (restoreDone() ? 'warn' : '') },
          { id: 'backups', label: t('tabBackups'), count: snapshotCount() },
          { id: 'restore', label: t('tabRestore'), count: quarantines.length },
          { id: 'settings', label: t('tabSettings') },
        ]
        return h('div', { className: 'dbk-seg-row' },
          h('div', { className: 'dbk-seg', role: 'tablist', 'aria-label': t('title'), style: { display: 'inline-flex', width: 'max-content', maxWidth: '100%' } },
            tabs.map((item) => h('button', {
              key: item.id,
              type: 'button',
              role: 'tab',
              className: 'dbk-seg-tab',
              'aria-selected': (!subView && tab === item.id) ? 'true' : 'false',
              'data-dbk-tab': item.id,
              onClick: () => { setSubView(''); setTab(item.id) },
            },
            item.label,
            item.flag ? h('span', { className: 'dbk-seg-flag' + (item.flag === 'warn' ? ' warn' : '') }) : null,
            item.count != null ? h('span', { className: 'dbk-seg-count' }, fmtInt(item.count)) : null))))
      }

      function renderFooter() {
        return h('div', { className: 'dbk-foot' },
          h('span', { className: 'dbk-foot-brand' }, t('title') + ' v' + VERSION + ' · ' + t('seatLine')),
          h('span', null, t('versionNote')))
      }

      /* ---------------- 概览 ---------------- */

      function renderOverview() {
        let status = null
        if (monitorPrimary) status = incidentSection()
        else if (restoreDone()) status = restoredSection()
        else if (paused) status = pausedSection()
        else if (!last) status = emptySection()
        else status = normalSection()
        const extra = last || monitorPrimary ? activitySection() : null
        return h('div', null, status, extra, rescueSection())
      }

      function statsRow() {
        const autoText = paused ? t('shortPaused') : intervalText()
        return h('div', { className: 'dbk-row' },
          h('div', { className: 'dbk-row-main' },
            h('div', { className: 'dbk-stats' },
              statCell(t('lastBackupLabel'), last ? fmtAgo(state.lastSnapshotAgeMs, t) : t('noSnapshotYet')),
              statCell(t('intervalLabel'), autoText),
              statCell(t('historyLabel'), fill(t('unitCountPlain'), { n: fmtInt(snapshotCount()) })),
              statCell(t('usageLabel'), totalBytes))))
      }

      function statCell(label, value) {
        return h('div', { className: 'dbk-stat-cell' },
          h('div', { className: 'k' }, label),
          h('div', { className: 'v' }, value))
      }

      function integrityRow() {
        let desc = t('integrityUnchecked')
        let action = h(Btn, { small: true, onClick: runVerify, disabled: busyAny || !last, action: 'verify-run' }, t('check'))
        let tone = ''
        if (verify && verify.loading) {
          desc = t('integrityChecking')
          action = h(Btn, { small: true, disabled: true, busy: true }, t('integrityChecking'))
        } else if (verify && verify.unsupported) {
          desc = t('integrityUnsupported')
          action = null
        } else if (verify && verify.ok === true) {
          desc = fill(t('integrityOk'), { files: fmtInt(verify.files) }) + (verify.checkedAt ? ' · ' + fill(t('integrityAt'), { time: fmtClock(new Date(verify.checkedAt)) }) : '')
          action = h(Btn, { small: true, variant: 'ghost', onClick: runVerify, disabled: busyAny || !last, action: 'verify-run' }, t('integrityRecheck'))
          tone = 'ok'
        } else if (verify && verify.ok === false) {
          desc = fill(t('integrityBad'), { n: fmtInt(verify.missingCount) })
          action = h(Btn, { small: true, variant: 'ghost', onClick: runVerify, disabled: busyAny || !last, action: 'verify-run' }, t('retry'))
          tone = 'bad'
        }
        return h('div', { className: 'dbk-row', 'data-dbk-integrity': tone || 'unchecked' },
          h('div', { className: 'dbk-row-main' },
            h('div', { className: 'dbk-row-title' }, tone === 'bad' ? h(IconAlert) : (tone === 'ok' ? h(IconCheck) : h(IconShield)), t('integrity')),
            h('div', { className: 'dbk-row-desc' + (tone === 'bad' ? ' err' : '') }, desc)),
          h('div', { className: 'dbk-row-action' }, action))
      }

      function normalSection() {
        return h('section', { className: 'dbk-section', 'data-dbk-card': 'normal' },
          h('div', { className: 'dbk-row' },
            h('div', { className: 'dbk-row-main' },
              h('div', { className: 'dbk-status-line' }, h('span', { className: 'dbk-dot ok' }), t('protectTitle')),
              h('p', { className: 'dbk-status-lede' }, fill(t('protectDesc'), {
                interval: intervalText(),
                ago: last ? fmtAgo(state.lastSnapshotAgeMs, t) : t('noSnapshotYet'),
                time: last ? fmtFull(new Date(last.at)) : '—',
                count: fmtInt(snapshotCount()),
                days: Number(config.keepDailyDays) || 30,
              }))),
            h('div', { className: 'dbk-row-action' },
              h(Btn, {
                variant: 'primary',
                lg: true,
                onClick: onBackup,
                disabled: busyAny,
                busy: busy === 'backup',
                action: 'backup-now',
              }, busy === 'backup' ? t('backingUp') : t('backupNow')),
              h(Btn, { lg: true, onClick: gotoBackups, disabled: busyAny, action: 'restore-open' }, t('restoreOpen')))),
          statsRow(),
          integrityRow())
      }

      function pausedSection() {
        const sinceMs = pausedAt()
        return h('section', { className: 'dbk-section tone-warn', 'data-dbk-card': 'paused' },
          h('div', { className: 'dbk-row' },
            h('div', { className: 'dbk-row-main' },
              h('div', { className: 'dbk-status-line warn' }, h('span', { className: 'dbk-dot warn' }), t('pausedTitle')),
              h('p', { className: 'dbk-status-lede' }, sinceMs ? fill(t('pausedDesc'), { time: fmtFull(new Date(sinceMs)) }) : t('pausedDescNoTime')),
              h('div', { className: 'dbk-status-meta' },
                h('span', null, fill(t('pausedFoot'), { n: fmtInt(snapshotCount()) })))),
            h('div', { className: 'dbk-row-action' },
              h(Btn, { variant: 'primary', lg: true, onClick: onToggle, disabled: busyAny, action: 'resume-auto' }, t('resumeAuto')),
              h(Btn, { onClick: onResumeAndBackup, disabled: busyAny, busy: busy === 'backup', action: 'resume-backup' }, busy === 'backup' ? t('backingUp') : t('resumeAndBackup')))),
          statsRow(),
          integrityRow())
      }

      function emptySection() {
        const files = fmtInt((last && last.files) || (state.lastCycle && state.lastCycle.files) || 0)
        return h('section', { className: 'dbk-section', 'data-dbk-card': 'empty' },
          h('div', { className: 'dbk-row' },
            h('div', { className: 'dbk-row-main' },
              h('div', { className: 'dbk-status-line' }, h('span', { className: 'dbk-dot' }), t('emptyTitle')),
              h('p', { className: 'dbk-status-lede' }, fill(t('emptyDesc'), { interval: intervalText() })),
              h('div', { className: 'dbk-status-meta' },
                h('span', null, fill(t('emptyFoot'), { store: state.storeDir || state.root || '—' })))),
            h('div', { className: 'dbk-row-action' },
              h(Btn, {
                variant: 'primary',
                lg: true,
                onClick: onBackup,
                disabled: busyAny,
                busy: busy === 'backup',
                action: 'backup-now',
              }, busy === 'backup' ? t('backingUp') : t('startProtect')))),
          h('div', { className: 'dbk-row' },
            h('div', { className: 'dbk-row-main' },
              h('div', { className: 'dbk-row-title' }, t('emptyIncludes')),
              h('div', { className: 'dbk-row-desc' }, fill(t('emptyIncludesDesc'), { files: files }))),
            h('div', { className: 'dbk-row-action' },
              h(Btn, { small: true, variant: 'ghost', onClick: () => openTarget('store'), disabled: busyAny }, t('open')))))
      }

      function incidentSection() {
        const incident = monitorPrimary
        const rec = monitorRec
        const recAt = rec ? Number(rec.at) || 0 : 0
        const desc = monitorBannerText(incident, rec)
        const protection = (incident && incident.protection && incident.protection.active)
          ? incident.protection
          : (mon && mon.protection && mon.protection.active ? mon.protection : null)
        const recRow = h('div', { className: 'dbk-row' },
          h('div', { className: 'dbk-row-main' },
            h('div', { className: 'dbk-row-title' }, t('incidentRecommended'),
              h('span', { className: 'dbk-tag ' + (rec && rec.verified ? 'ok' : 'pre') }, rec && rec.verified ? t('monRecommendVerified') : t('monRecommendUnverified'))),
            h('div', { className: 'dbk-row-desc' }, rec
              ? fill(t('monRecommendLine'), { time: fmtFull(new Date(recAt)), id: rec.snapshotId })
                + (rec.files ? ' · ' + fill(t('snapFiles'), { n: fmtInt(rec.files) }) : '')
                + ' · ' + t('recVerifyNote')
              : t('monNoRecommend'))),
          null)
        const protectionRow = protection
          ? h('div', { className: 'dbk-row' },
            h('div', { className: 'dbk-row-main' },
              h('div', { className: 'dbk-row-title' }, t('incidentProtection')),
              h('div', { className: 'dbk-row-desc' }, fill(t('incidentProtectionDesc'), {
                id: (protection.pinnedSnapshots && protection.pinnedSnapshots[0]) || (rec && rec.snapshotId) || '—',
              }))),
            h('div', { className: 'dbk-row-action' },
              h(Btn, { small: true, variant: 'ghost', onClick: () => openSub('monitor'), action: 'incident-details' }, t('monDetails')),
              h(Btn, { small: true, variant: 'ghost', onClick: () => onMonAck(incident), disabled: monitorBusyAny, action: 'incident-later' }, t('incidentLater'))))
          : null
        return h('section', { className: 'dbk-section tone-bad', 'data-dbk-card': 'incident' },
          h('div', { className: 'dbk-section-head' }, h('span', { className: 'dbk-dot err' }), t('incidentSectionTitle'),
            h('span', { className: 'dbk-section-side' }, h('span', { className: 'dbk-tag err' }, t('monOpenTag')))),
          h('div', { className: 'dbk-row' },
            h('div', { className: 'dbk-row-main' },
              h('div', { className: 'dbk-status-line bad' }, t('incidentTitle')),
              h('p', { className: 'dbk-status-lede' }, desc)),
            h('div', { className: 'dbk-row-action' },
              h(Btn, {
                variant: 'danger-solid',
                lg: true,
                onClick: restoreFromRecommendation,
                action: 'incident-restore',
                disabled: monitorBusyAny || !rec,
                busy: monBusy === 'monitor-restore',
              }, rec ? fill(t('restoreTo'), { snap: fmtClock(new Date(recAt)) }) : t('restoreOpen')),
              h(Btn, { onClick: gotoBackups, disabled: monitorBusyAny, action: 'incident-switch-time' }, t('incidentSwitchTime')))),
          recRow,
          protectionRow,
          monitorOpenIncidents.length > 1
            ? h('div', { className: 'dbk-row' },
              h('div', { className: 'dbk-row-main' },
                h('div', { className: 'dbk-row-title' }, fill(t('incidentMore'), { n: fmtInt(monitorOpenIncidents.length - 1) })),
                h('div', { className: 'dbk-row-desc' }, t('incidentMoreDesc'))),
              h('div', { className: 'dbk-row-action' },
                h(Btn, { small: true, variant: 'ghost', onClick: () => openSub('monitor') }, t('incidentSee'))))
            : null)
      }

      function restoredSection() {
        const info = bannerRestore || {}
        const at = Number(info.at) || 0
        const openCount = monitorOpenIncidents.length
        return h('section', { className: 'dbk-section tone-warn', 'data-dbk-card': 'restored' },
          h('div', { className: 'dbk-row' },
            h('div', { className: 'dbk-row-main' },
              h('div', { className: 'dbk-status-line warn' }, h('span', { className: 'dbk-dot warn' }),
                fill(t('restoredTitle'), { time: at ? fmtFull(new Date(at)) : '—' })),
              h('p', { className: 'dbk-status-lede' }, fill(t('restoredDesc'), {
                restored: fmtInt(info.restored),
                kept: fmtInt(info.extraLeft),
              })),
              h('div', { className: 'dbk-status-meta' }, h('span', null, t('restartFoot')))),
            h('div', { className: 'dbk-row-action' },
              h(Btn, { onClick: onRollback, disabled: busyAny || !info.preSnapshot }, t('rollback')),
              h(Btn, { variant: 'ghost', onClick: () => { setSubView(''); setTab('restore') } }, t('restoreRecords')))),
          statsRow(),
          integrityRow(),
          openCount
            ? h('div', { className: 'dbk-row' },
              h('div', { className: 'dbk-row-main' },
                h('div', { className: 'dbk-row-title' }, fill(t('incidentMore'), { n: fmtInt(openCount) })),
                h('div', { className: 'dbk-row-desc' }, t('incidentMoreDesc'))),
              h('div', { className: 'dbk-row-action' },
                h(Btn, { small: true, variant: 'ghost', onClick: () => openSub('monitor') }, t('incidentSee'))))
            : null)
      }

      function activityItems() {
        const items = []
        snapshots.slice(0, 3).forEach((snap) => {
          const reason = reasonKey(snap.reason)
          items.push({
            at: Number(snap.at) || 0,
            kind: 'backup',
            title: fill(t('actBackupDone'), { reason: t(reason.key) }),
            desc: fill(t('snapMeta'), { files: fmtInt(snap.files), changed: fmtInt(snap.changed), size: fmtBytes(snap.bytes) }),
          })
        })
        if (bannerRestore) {
          items.push({
            at: Number(bannerRestore.at) || Date.now(),
            kind: 'restore',
            title: fill(t('actRestoreDone'), { time: fmtFull(new Date(Number(bannerRestore.at) || Date.now())) }),
            desc: fill(t('restoreRecordMeta'), {
              restored: fmtInt(bannerRestore.restored),
              unchanged: fmtInt(bannerRestore.unchanged),
              quarantined: fmtInt(bannerRestore.quarantined),
              extra: fmtInt(bannerRestore.extraLeft),
            }),
          })
        } else if (quarantines[0]) {
          const q = quarantines[0]
          items.push({
            at: Number(q.at) || 0,
            kind: 'restore',
            title: fill(t('actRestoreDone'), { time: fmtFull(new Date(Number(q.at) || 0)) }),
            desc: fill(t('restoreRecordMeta'), {
              restored: fmtInt(q.restored),
              unchanged: fmtInt(q.unchanged),
              quarantined: fmtInt(q.quarantined),
              extra: fmtInt(q.extraLeft),
            }),
          })
        }
        if (verify && verify.checkedAt && !verify.loading) {
          items.push({
            at: Number(verify.checkedAt) || 0,
            kind: 'check',
            title: t('actCheckDone'),
            desc: verify.ok
              ? fill(t('integrityOk'), { files: fmtInt(verify.files) })
              : fill(t('integrityBad'), { n: fmtInt(verify.missingCount) }),
          })
        }
        const incidentsAll = monitorOpenIncidents.concat((mon && mon.incidents && Array.isArray(mon.incidents.recent)) ? mon.incidents.recent : [])
        incidentsAll.slice(0, 2).forEach((incident) => {
          items.push({
            at: Number(incident.detectedAt) || 0,
            kind: 'incident',
            title: fill(t('actIncidentSeen'), { kind: t(monKindKey(incident.kind)) }),
            desc: incident.kind === 'data-loss'
              ? fill(t('actIncidentDesc'), {
                before: fmtInt((incident.data && incident.data.before && incident.data.before.sessions) || 0),
                after: fmtInt((incident.data && incident.data.after && incident.data.after.sessions) || 0),
              })
              : t(monKindKey(incident.kind)),
          })
        })
        const seen = new Set()
        return items
          .filter((item) => item.at > 0)
          .sort((a, b) => b.at - a.at)
          .filter((item) => {
            const key = item.kind + ':' + item.at
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
          .slice(0, 5)
      }

      function activitySection() {
        const items = activityItems()
        if (!items.length) return null
        const tagOf = (kind) => {
          if (kind === 'incident') return h('span', { className: 'dbk-tag err' }, t('actIncident'))
          if (kind === 'restore') return h('span', { className: 'dbk-tag brand' }, t('actRestore'))
          if (kind === 'check') return h('span', { className: 'dbk-tag ok' }, t('actCheck'))
          return h('span', { className: 'dbk-tag pre' }, t('actBackup'))
        }
        return h('section', { className: 'dbk-section', 'data-dbk-card': 'activity' },
          h('div', { className: 'dbk-section-head' }, t('activity'),
            h('span', { className: 'dbk-section-side' },
              h(Btn, { small: true, variant: 'ghost', onClick: () => { setSubView(''); setTab('restore') } }, t('activityAll')))),
          items.map((item, index) => h('div', { className: 'dbk-act', key: item.kind + index },
            h('span', { className: 'dbk-act-time' }, dayKey(item.at) === dayKey(Date.now()) ? fmtClock(new Date(item.at)) : fmtDayLabel(item.at, t, Date.now())),
            h('span', { className: 'dbk-act-main' },
              h('span', { className: 'dbk-act-title' }, item.title),
              h('span', { className: 'dbk-act-desc' }, item.desc)),
            h('span', { className: 'dbk-act-side' }, tagOf(item.kind)))))
      }

      function rescueSection() {
        return h('section', { className: 'dbk-section', 'data-dbk-card': 'rescue' },
          h('div', { className: 'dbk-section-head' }, t('help'), h('span', { className: 'dbk-section-side' }, t('helpMenu'))),
          h('div', { className: 'dbk-row' },
            h('div', { className: 'dbk-row-main' },
              h('div', { className: 'dbk-row-title' }, t('rescueTitle')),
              h('div', { className: 'dbk-row-desc' }, t('rescueDesc'))),
            h('div', { className: 'dbk-row-action' },
              h(Btn, {
                small: true,
                variant: 'ghost',
                onClick: () => setRescueOpen((value) => !value),
                action: 'rescue-toggle',
              }, rescueOpen ? t('rescueHide') : t('rescueShow')))),
          rescueOpen
            ? h('div', { className: 'dbk-row' },
              h('div', { className: 'dbk-row-main' },
                h('div', { className: 'dbk-row-title' }, t('rescueSteps')),
                h('ol', { className: 'dbk-rescue-steps', style: { listStyle: 'decimal', margin: '4px 0 0', paddingLeft: '18px' } },
                  h('li', null, t('rescueStep1')),
                  h('li', null, t('rescueStep2')),
                  h('li', null, t('rescueStep3')))))
            : null)
      }

      /* ---------------- 备份页 ---------------- */

      function backupTagOf(snap, index) {
        if (monitorRec && String(snap.id) === String(monitorRec.snapshotId)) return h('span', { className: 'dbk-tag brand' }, t('pickerRecommended'))
        if (index === 0) return h('span', { className: 'dbk-tag pre' }, t('backupLatest'))
        const reason = reasonKey(snap.reason)
        if (reason.key === 'reasonManual' || reason.key === 'reasonStartup' || reason.key === 'reasonPreRestore' || reason.key === 'reasonRestore') {
          return h('span', { className: 'dbk-tag pre' }, t(reason.key))
        }
        return null
      }

      function snapRow(snap, index) {
        return h('div', { className: 'dbk-snap', key: snap.id, 'data-dbk-snap': snap.id },
          h('span', { className: 'dbk-snap-time' }, fmtClock(new Date(snap.at))),
          h('div', { className: 'dbk-snap-main' },
            h('span', { className: 'dbk-snap-meta' }, fill(t('snapMeta'), {
              files: fmtInt(snap.files),
              changed: fmtInt(snap.changed),
              size: fmtBytes(snap.bytes),
            })),
            backupTagOf(snap, index)),
          h('div', { className: 'dbk-snap-actions' },
            h(Btn, {
              small: true,
              variant: 'ghost',
              onClick: () => openRestore(snap),
              disabled: busyAny,
              action: 'snap-restore',
            }, t('restore') + '…'),
            h(Btn, {
              small: true,
              variant: 'ghost',
              onClick: () => openDelete(snap),
              disabled: busyAny,
              action: 'snap-delete',
            }, t('delete'))))
      }

      function renderBackups() {
        let body = null
        if (!snapshots.length) {
          body = h('div', { className: 'dbk-empty' }, h('b', null, t('pickerNoSnapshots')))
        } else if (!filtered.length) {
          body = h('div', { className: 'dbk-empty' },
            h('b', null, t('backupNoMatch')),
            h('div', null, t('backupNoMatchDesc')))
        } else {
          let index = 0
          body = groups.map((group) => h('div', { key: 'day-' + group.key, className: 'dbk-day-group' },
            h('div', { className: 'dbk-day' },
              h('span', { className: 'dbk-day-label' }, fmtDayLabel(group.at, t, Date.now())),
              h('span', { className: 'dbk-day-count' }, fill(t('pickerCount'), { n: fmtInt(group.items.length) }))),
            group.items.map((snap) => {
              const row = snapRow(snap, index)
              index += 1
              return row
            })))
        }
        return h('section', { className: 'dbk-section', 'data-dbk-card': 'backups' },
          h('div', { className: 'dbk-section-head' }, t('tabBackups'),
            h('span', { className: 'dbk-section-side', style: { gap: '10px' } },
              h('span', { className: 'dbk-muted' }, fill(t('backupTotal'), { n: fmtInt(snapshotCount()), size: totalBytes })),
              h('label', { className: 'dbk-searchline' },
                h('span', { className: 'dbk-ico' }, h(IconSearch)),
                h('input', {
                  type: 'search',
                  value: query,
                  onChange: (event) => setQuery(event.target.value),
                  placeholder: t('backupSearch'),
                  'aria-label': t('backupSearch'),
                  'data-dbk-field': 'snapshot-search',
                })))),
          monitorPrimary && monitorRec
            ? h('div', { className: 'dbk-row' },
              h('div', { className: 'dbk-row-main' },
                h('div', { className: 'dbk-row-desc' }, fill(t('backupNotice'), { time: fmtFull(new Date(Number(monitorRec.at) || 0)) }))),
              h('div', { className: 'dbk-row-action' },
                h(Btn, {
                  small: true,
                  variant: 'ghost',
                  onClick: () => openRestore({
                    id: monitorRec.snapshotId,
                    at: Number(monitorRec.at) || Date.now(),
                    files: Number(monitorRec.files) || 0,
                    reason: 'restore',
                  }),
                }, t('backupNoticeAction'))))
            : null,
          body,
          h('div', { className: 'dbk-row' },
            h('div', { className: 'dbk-row-main' },
              h('div', { className: 'dbk-row-desc' }, fill(t('retentionNote'), {
                last: fmtInt(retention.keepLast),
                hours: fmtInt(retention.hourlyHours),
                days: fmtInt(retention.dailyDays),
              }))),
            h('div', { className: 'dbk-row-action' },
              h(Btn, { small: true, variant: 'ghost', onClick: () => openSub('retention') }, t('retentionAdjust')))))
      }

      /* ---------------- 恢复页 ---------------- */

      function renderRestorePage() {
        const records = quarantines.length
          ? quarantines.map((item) => h('div', { className: 'dbk-row', key: item.id },
            h('div', { className: 'dbk-row-main' },
              h('div', { className: 'dbk-row-title' }, fmtFull(new Date(Number(item.at) || 0)),
                h('span', { className: 'dbk-tag pre' }, String(item.id || '').slice(0, 24))),
              h('div', { className: 'dbk-row-desc' }, fill(t('restoreRecordMeta'), {
                restored: fmtInt(item.restored),
                unchanged: fmtInt(item.unchanged),
                quarantined: fmtInt(item.quarantined),
                extra: fmtInt(item.extraLeft),
              }))),
            h('div', { className: 'dbk-row-action' },
              h(Btn, { small: true, variant: 'ghost', onClick: () => openTarget('quarantine'), disabled: busyAny }, t('open')))))
          : h('div', { className: 'dbk-empty' }, h('b', null, t('recordsEmpty')))
        const archives = quarantines.length
          ? quarantines.map((item) => h('div', { className: 'dbk-row', key: 'archive-' + item.id },
            h('div', { className: 'dbk-row-main' },
              h('div', { className: 'dbk-row-title' }, fmtFull(new Date(Number(item.at) || 0)),
                h('span', { className: 'dbk-tag pre' }, String(item.id || '').slice(0, 24))),
              h('div', { className: 'dbk-row-desc' }, fill(t('restoreQuarantineRow'), {
                files: fmtInt(item.quarantined),
              }))),
            h('div', { className: 'dbk-row-action' },
              h(Btn, { small: true, variant: 'ghost', onClick: () => openTarget('quarantine'), disabled: busyAny }, t('open')))))
          : h('div', { className: 'dbk-empty' }, h('b', null, t('restoreArchivesEmpty')))
        const incident = monitorPrimary
        return h('div', null,
          h('section', { className: 'dbk-section', 'data-dbk-card': 'restore-records' },
            h('div', { className: 'dbk-section-head' }, t('restoreRecords'),
              h('span', { className: 'dbk-section-side' },
                h('span', { className: 'dbk-muted' }, fill(t('restoreRecordsCount'), { n: fmtInt(records.length || quarantines.length) })),
                h(Btn, { small: true, variant: 'ghost', onClick: () => openTarget('quarantine'), disabled: busyAny }, t('restoreOpenQuarantine')))),
            records),
          h('section', { className: 'dbk-section', 'data-dbk-card': 'restore-archives' },
            h('div', { className: 'dbk-section-head' }, t('restoreArchives'), h('span', { className: 'dbk-section-side' }, t('restoreArchivesDesc'))),
            archives),
          h('section', { className: 'dbk-section', 'data-dbk-card': 'restore-incidents' },
            h('div', { className: 'dbk-section-head' }, t('restoreIncidents'), h('span', { className: 'dbk-section-side' }, t('restoreIncidentsDesc'))),
            h('div', { className: 'dbk-row' },
              h('div', { className: 'dbk-row-main' },
                h('div', { className: 'dbk-row-title' }, incident
                  ? fill(t('restoreIncidentOpen'), { n: fmtInt(monitorOpenIncidents.length) })
                  : t('restoreIncidentNone'),
                  incident ? h('span', { className: 'dbk-tag err' }, t(monKindKey(incident.kind))) : null),
                h('div', { className: 'dbk-row-desc' }, incident
                  ? fill(t('restoreIncidentLine'), {
                    time: fmtFull(new Date(Number(incident.detectedAt) || 0)),
                    before: fmtInt((incident.data && incident.data.before && incident.data.before.sessions) || 0),
                    after: fmtInt((incident.data && incident.data.after && incident.data.after.sessions) || 0),
                    rec: monitorRec ? fmtFull(new Date(Number(monitorRec.at) || 0)) : '—',
                  })
                  : t('monNormalDesc'))),
              h('div', { className: 'dbk-row-action' },
                h(Btn, { small: true, variant: 'ghost', onClick: () => openSub('monitor'), action: 'incident-details' }, t('monDetails'))))))
      }

      /* ---------------- 设置页 ---------------- */

      function setRow(opts) {
        const clickable = typeof opts.onClick === 'function'
        const content = [
          h('span', { className: 'dbk-set-main', key: 'main' },
            h('span', { className: 'dbk-set-title' }, opts.title, opts.tag || null),
            opts.desc ? h('span', { className: 'dbk-set-desc' }, opts.desc) : null,
            opts.value ? h('span', { className: 'dbk-set-value' + (opts.mono ? ' mono' : '') }, opts.value) : null),
          h('span', { className: 'dbk-set-side', key: 'side' },
            opts.side || null,
            clickable ? h('span', { className: 'dbk-chev' }, h(IconChevron)) : null),
        ]
        if (clickable) {
          return h('button', {
            type: 'button',
            className: 'dbk-set-row',
            onClick: opts.onClick,
            'data-dbk-sub': opts.sub || undefined,
          }, content)
        }
        return h('div', { className: 'dbk-set-row static' }, content)
      }

      function renderSettings() {
        const keepLast = Math.min(maxSnapshots, Number(config.keepLast) || 60)
        const keepDays = Number(config.keepDailyDays) || 30
        const keepHours = Number(config.keepHourlyHours) || 48
        const offOn = Boolean(off && off.enabled !== false)
        const channels = (mon && mon.notify && Array.isArray(mon.notify.channels)) ? mon.notify.channels : []
        const notifyOn = channels.some((channel) => channel.configured)
        const watchdog = (mon && mon.watchdog) || {}
        const peer = offPeerInfo || {}
        return h('div', null,
          h('section', { className: 'dbk-section', 'data-dbk-card': 'settings-backup' },
            h('div', { className: 'dbk-section-head' }, t('settingsGroupBackup')),
            setRow({
              title: t('settingsAuto'),
              desc: t('settingsAutoDesc'),
              value: paused ? t('shortPaused') : fill(t('settingsAutoVal'), { interval: intervalText() }),
              side: h(Switch, { on: !paused, onToggle: onToggle, disabled: busyAny, label: t('settingsAuto'), action: 'toggle-auto-backup' }),
            }),
            setRow({
              sub: 'retention',
              title: t('settingsKeep'),
              desc: t('settingsKeepDesc'),
              value: fill(t('settingsKeepVal'), { last: fmtInt(keepLast), hours: fmtInt(keepHours), days: fmtInt(keepDays) }),
              onClick: () => openSub('retention'),
            }),
            setRow({
              sub: 'store',
              title: t('settingsStore'),
              desc: t('settingsStoreDesc'),
              value: state.storeDir || state.root || '—',
              mono: true,
              onClick: () => openSub('store'),
            })),
          h('section', { className: 'dbk-section', 'data-dbk-card': 'settings-protect' },
            h('div', { className: 'dbk-section-head' }, t('settingsGroupProtect')),
            setRow({
              sub: 'offsite',
              title: t('settingsOffsite'),
              desc: t('settingsOffsiteDesc'),
              tag: h('span', { className: 'dbk-tag ' + (offOn ? 'ok' : 'warn') }, offOn ? t('settingsOffsiteOn') : t('settingsOffsiteOff')),
              value: fill(t('settingsOffsiteValue'), {
                name: peer.name || t('offTargetNone'),
                state: peer.online === false ? t('offPeerOffline') : t('offPeerOnline'),
                time: (off && off.config && off.config.schedule) || '—',
              }),
              onClick: () => openSub('offsite'),
            }),
            setRow({
              sub: 'notify',
              title: t('settingsNotify'),
              desc: t('settingsNotifyDesc'),
              tag: h('span', { className: 'dbk-tag ' + (notifyOn ? 'ok' : 'warn') }, notifyOn ? t('settingsNotifyOn') : t('settingsNotifyOff')),
              value: t('settingsNotifyValue'),
              onClick: () => openSub('notify'),
            }),
            setRow({
              sub: 'monitor',
              title: t('settingsWatchdog'),
              desc: t('settingsWatchdogDesc'),
              tag: h('span', { className: 'dbk-tag ' + (watchdog.installed ? 'ok' : 'warn') }, watchdog.installed ? t('settingsWatchdogRunning') : t('settingsWatchdogMissing')),
              value: watchdog.lastCheckAt ? fill(t('settingsWatchdogValue'), { time: fmtFull(new Date(watchdog.lastCheckAt)) }) : t('monNever'),
              onClick: () => openSub('monitor'),
            })),
          h('section', { className: 'dbk-section', 'data-dbk-card': 'settings-incident' },
            h('div', { className: 'dbk-section-head' }, t('settingsGroupIncident')),
            setRow({
              sub: 'monitor',
              title: t('restoreIncidents'),
              desc: t('restoreIncidentsDesc'),
              tag: monitorOpenIncidents.length
                ? h('span', { className: 'dbk-tag err' }, fill(t('monOpenCount'), { n: fmtInt(monitorOpenIncidents.length) }))
                : null,
              value: monitorPrimary
                ? t(monKindKey(monitorPrimary.kind)) + ' · ' + fmtFull(new Date(Number(monitorPrimary.detectedAt) || 0))
                : t('monitorNoIncidentDesc'),
              onClick: () => openSub('monitor'),
            })),
          h('section', { className: 'dbk-section', 'data-dbk-card': 'settings-other' },
            h('div', { className: 'dbk-section-head' }, t('settingsGroupOther')),
            setRow({
              sub: 'advanced',
              title: t('settingsAdvancedAbout'),
              desc: t('settingsAdvancedDesc'),
              onClick: () => openSub('advanced'),
            })))
      }

      /* ---------------- 二级页 ---------------- */

      function renderSubPage() {
        const titles = {
          retention: t('subRetention'),
          store: t('subStore'),
          offsite: t('subOffsite'),
          notify: t('subNotify'),
          monitor: t('subMonitor'),
          advanced: t('subAdvanced'),
        }
        let body = null
        if (subView === 'retention') body = retentionPanel()
        else if (subView === 'store') body = storePage()
        else if (subView === 'offsite') body = h('div', { className: 'dbk-panel' }, offsiteSection(true))
        else if (subView === 'notify') body = h('div', { className: 'dbk-panel' }, notifyPage())
        else if (subView === 'monitor') body = monitorPage()
        else body = advancedPanel()
        return h('div', null,
          h('div', { className: 'dbk-subhead-row' },
            h('button', {
              type: 'button',
              className: 'dbk-btn ghost small',
              onClick: () => setSubView(''),
              'data-dbk-action': 'sub-back',
            }, '‹ ' + t('subBack')),
            h('div', { className: 'dbk-subhead-title' }, titles[subView] || t('tabSettings')),
            subView === 'offsite'
              ? h('div', { className: 'dbk-subhead-side', style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' } },
                offsiteStateTag(),
                h(Btn, { small: true, onClick: () => loadOffsite(true), disabled: offWorking, title: t('refresh') }, t('refresh')))
              : null),
          body)
      }

      function retentionPanel() {
        const digits = (event) => String(event.target.value).replace(/[^0-9]/g, '')
        return h('div', { className: 'dbk-panel' },
          h('section', { className: 'dbk-section' },
            h('div', { className: 'dbk-section-head' }, t('retentionPace')),
            h(Row, { title: t('retentionMax'), desc: t('retentionMaxDesc') },
              numberField(draft && draft.maxSnapshots, t('unitCount'), t('retentionMax'), (event) => editDraft({ maxSnapshots: digits(event) }))),
            h(Row, { title: t('retentionKeepLast'), desc: t('retentionKeepLastDesc') },
              numberField(draft && draft.keepLast, t('unitCount'), t('retentionKeepLast'), (event) => editDraft({ keepLast: digits(event) }))),
            h(Row, { title: t('retentionInterval'), desc: t('retentionIntervalDesc') },
              numberField(draft && draft.minIntervalSec, t('unitSec'), t('retentionInterval'), (event) => editDraft({ minIntervalSec: digits(event) }))),
            h(Row, { title: t('retentionHourly'), desc: t('retentionHourlyDesc') },
              numberField(draft && draft.keepHourly, t('unitHour'), t('retentionHourly'), (event) => editDraft({ keepHourly: digits(event) }))),
            h(Row, { title: t('retentionDaily'), desc: t('retentionDailyDesc') },
              numberField(draft && draft.keepDaily, t('unitDay'), t('retentionDaily'), (event) => editDraft({ keepDaily: digits(event) }))),
            h(Row, { title: t('retentionExcludes'), desc: t('retentionExcludesDesc') },
              h('input', {
                className: 'dbk-field-input',
                style: { width: '260px' },
                value: (draft && draft.excludes) || '',
                onChange: (event) => editDraft({ excludes: event.target.value }),
                'aria-label': t('retentionExcludes'),
                placeholder: 'dsh-runtimes',
              }))),
          h('section', { className: 'dbk-section' },
            h('div', { className: 'dbk-savebar' },
              dirty ? h('span', { className: 'dbk-tag warn' }, t('retentionUnsaved')) : h('span', { className: 'dbk-save-note' }, t('settingsAdjust')),
              h('span', { className: 'dbk-save-actions' },
                h(Btn, { onClick: () => { setDirty(false); dirtyRef.current = false; setDraft(nextDraft(config)) }, disabled: saving, action: 'retention-discard' }, t('saveDiscard')),
                h(Btn, { variant: 'primary', onClick: onSave, disabled: !dirty || saving || busyAny, busy: saving, action: 'retention-save' }, saving ? t('saving') : t('save'))))))
      }

      function storePage() {
        const currentRoot = state.storeDir || state.root || '—'
        const pending = rootPending
        const preview = rootEdit && rootEdit.preview
        return h('div', { className: 'dbk-panel' },
          h('section', { className: 'dbk-section' },
            h('div', { className: 'dbk-section-head' }, t('storeCurrent')),
            h('div', { className: 'dbk-row' },
              h('div', { className: 'dbk-row-main' },
                h('div', { className: 'dbk-row-title' }, t('settingsStore')),
                h('div', { className: 'dbk-row-desc mono' }, currentRoot)),
              h('div', { className: 'dbk-row-action' },
                h(Btn, { small: true, variant: 'ghost', onClick: () => openTarget('store'), disabled: busyAny }, t('open')))),
            h('div', { className: 'dbk-row' },
              h('div', { className: 'dbk-row-main' },
                h('div', { className: 'dbk-row-title' }, t('storeOccupied')),
                h('div', { className: 'dbk-row-desc' }, totalBytes + ' · ' + fill(t('unitCountPlain'), { n: fmtInt(snapshotCount()) }) + ' · ' + t('versionNote')))),
            pending
              ? h('div', { className: 'dbk-row' },
                h('div', { className: 'dbk-row-main' },
                  h('div', { className: 'dbk-row-title' }, fill(t('rootPending'), { root: pending })),
                  h('div', { className: 'dbk-row-desc' }, t('rootDesc'))))
              : null),
          h('section', { className: 'dbk-section' },
            h('div', { className: 'dbk-section-head' }, t('storeModify')),
            !rootEdit
              ? h('div', { className: 'dbk-row' },
                h('div', { className: 'dbk-row-main' },
                  h('div', { className: 'dbk-row-title' }, t('storeNew')),
                  h('div', { className: 'dbk-row-desc' }, t('rootDesc'))),
                h('div', { className: 'dbk-row-action' },
                  h(Btn, { small: true, onClick: openRootEdit, disabled: busyAny || rootBusy, action: 'root-change' }, t('rootChange'))))
              : h('div', null,
                h('div', { className: 'dbk-row' },
                  h('div', { className: 'dbk-row-main' },
                    h('div', { className: 'dbk-row-title' }, t('storeNew')),
                    h('div', { className: 'dbk-row-desc' }, t('rootEditDesc')),
                    h('input', {
                      className: 'dbk-field-input',
                      style: { width: '100%', marginTop: '8px' },
                      value: rootEdit.value,
                      onChange: (event) => setRootEdit((value) => (value ? { ...value, value: event.target.value, preview: null, error: '' } : value)),
                      placeholder: 'D:\\dsh-backup',
                      'aria-label': t('rootEditTitle'),
                      'data-dbk-field': 'root',
                      disabled: Boolean(rootBusy),
                    }))),
                rootEdit.error
                  ? h('div', { className: 'dbk-row' }, h('div', { className: 'dbk-row-main' }, h('div', { className: 'dbk-row-desc err' }, rootEdit.error)))
                  : null,
                preview
                  ? h('div', { className: 'dbk-row' },
                    h('div', { className: 'dbk-row-main' },
                      h('div', { className: 'dbk-row-title' }, h('span', { className: 'dbk-tag ok' }, t('storeValid'))),
                      h('div', { className: 'dbk-row-desc mono' }, preview.root),
                      h('div', { className: 'dbk-row-desc' }, t('rootConfirmNote'))))
                  : null,
                h('div', { className: 'dbk-row' },
                  h('div', { className: 'dbk-row-main' }, h('div', { className: 'dbk-row-desc' }, t('storeNote'))),
                  h('div', { className: 'dbk-row-action' },
                    preview
                      ? h(Btn, { variant: 'primary', onClick: onRootApply, disabled: rootBusy, busy: rootBusy, action: 'root-apply' }, t('rootConfirm'))
                      : h(Btn, { onClick: onRootValidate, disabled: rootBusy || !String(rootEdit.value || '').trim(), busy: rootBusy, action: 'root-validate' }, t('storeValidate')),
                    h(Btn, { variant: 'ghost', onClick: () => setRootEdit(null), disabled: Boolean(rootBusy) }, t('cancel')))))))
      }

      function notifyPage() {
        if (!notifyLoaded && !notifyUnsupported) {
          return h('section', { className: 'dbk-section' },
            h('div', { className: 'dbk-skel' },
              h('div', { className: 'dbk-skel-bar', style: { width: '42%' } }),
              h('div', { className: 'dbk-skel-bar' })))
        }
        return h('section', { className: 'dbk-section', 'data-dbk-card': 'notify' }, notifyEditor())
      }

      function monitorPage() {
        if (monUnsupported) {
          return h('section', { className: 'dbk-section' },
            h('div', { className: 'dbk-row' },
              h('div', { className: 'dbk-row-main' },
                h('div', { className: 'dbk-row-title' }, t('monTitle')),
                h('div', { className: 'dbk-row-desc' }, t('monUnsupported')))))
        }
        if (!monLoaded) {
          return h('section', { className: 'dbk-section' },
            h('div', { className: 'dbk-skel' },
              h('div', { className: 'dbk-skel-bar', style: { width: '42%' } }),
              h('div', { className: 'dbk-skel-bar' })))
        }
        if (!mon) {
          return h('section', { className: 'dbk-section' },
            h('div', { className: 'dbk-row' },
              h('div', { className: 'dbk-row-main' },
                h('div', { className: 'dbk-row-title' }, t('monTitle')),
                h('div', { className: 'dbk-row-desc' }, t('monUnavailable')))))
        }
        const heartbeat = mon.heartbeat || {}
        const watchdog = mon.watchdog || {}
        const channels = (mon.notify && Array.isArray(mon.notify.channels)) ? mon.notify.channels : []
        const open = monitorOpenIncidents
        const recent = (mon.incidents && Array.isArray(mon.incidents.recent)) ? mon.incidents.recent : []
        const protection = mon.protection || null
        return h('div', { className: 'dbk-panel' },
          h('section', { className: 'dbk-section', 'data-dbk-card': 'monitor-status' },
            h('div', { className: 'dbk-section-head' }, t('monitorRunning')),
            h('div', { className: 'dbk-row' },
              h('div', { className: 'dbk-row-main' },
                h('div', { className: 'dbk-row-title' }, t('monHeartbeat'), h('span', { className: 'dbk-tag ' + (heartbeat.clientStale ? 'warn' : (heartbeat.at ? 'ok' : 'pre')) },
                  heartbeat.clientStale ? t('monError') : (heartbeat.at ? t('monNormal') : t('monNever')))),
                h('div', { className: 'dbk-row-desc' }, heartbeat.at
                  ? fill(t('monHeartbeatLine'), { time: fmtFull(new Date(heartbeat.at)), ago: monAgo(heartbeat.ageMs) })
                  : t('monNever'))),
              h('div', { className: 'dbk-row-action' }, h('span', { className: 'dbk-row-desc' }, t('monitorHeartbeatDesc')))),
            h('div', { className: 'dbk-row' },
              h('div', { className: 'dbk-row-main' },
                h('div', { className: 'dbk-row-title' }, t('monWatchdog'),
                  h('span', { className: 'dbk-tag ' + (watchdog.installed ? (watchdog.status === 'ok' ? 'ok' : 'warn') : 'warn') },
                    watchdog.installed ? t('monWatchdogInstalled') : t('monWatchdogMissing'))),
                h('div', { className: 'dbk-row-desc' }, watchdog.installed
                  ? (watchdog.status === 'stale'
                    ? fill(t('monWatchdogStale'), { ago: monAgo(watchdog.staleMs) })
                    : fill(t('monWatchdogLastCheck'), { time: watchdog.lastCheckAt ? fmtFull(new Date(watchdog.lastCheckAt)) : '—' }) + ' · ' + fill(t('monWatchdogTask'), { task: watchdog.taskName || 'DSH-DisasterWatchdog' }))
                  : t('monWatchdogMissing') + ' · ' + t('monitorWatchdogDesc'))),
              h('div', { className: 'dbk-row-action' },
                h(Btn, { small: true, variant: 'ghost', onClick: onMonInstall, disabled: monitorBusyAny, busy: monBusy === 'monitor-install', action: 'monitor-install' }, t('monInstall'))))),
          h('section', { className: 'dbk-section', 'data-dbk-card': 'monitor-incidents' },
            h('div', { className: 'dbk-section-head' }, t('restoreIncidents'),
              h('span', { className: 'dbk-section-side' }, open.length
                ? h('span', { className: 'dbk-tag err' }, fill(t('monOpenCount'), { n: fmtInt(open.length) }))
                : h('span', { className: 'dbk-tag ok' }, t('monNormal')))),
            open.length
              ? h('div', { className: 'dbk-mon-list' }, open.map((incident) => monitorIncidentCard(incident)))
              : h('div', { className: 'dbk-row' },
                h('div', { className: 'dbk-row-main' },
                  h('div', { className: 'dbk-row-title' }, t('monitorNoIncident')),
                  h('div', { className: 'dbk-row-desc' }, t('monitorNoIncidentDesc')))),
            protection && protection.active
              ? h('div', { className: 'dbk-check warn' },
                h('span', { className: 'dbk-ico' }, h(IconLock, { size: 14 })),
                h('div', { className: 'dbk-banner-main' },
                  h('div', { className: 'dbk-protect-title' }, t('monProtectionTitle')),
                  protection.autoPaused ? h('div', { className: 'dbk-protect-line' }, t('monProtectionPaused')) : null,
                  h('div', { className: 'dbk-protect-note' }, t('monProtectionNote'))))
              : null),
          h('section', { className: 'dbk-section', 'data-dbk-card': 'monitor-resolved' },
            h('div', { className: 'dbk-section-head' }, t('monitorResolved')),
            recent.length
              ? h('div', { className: 'dbk-mon-list' }, recent.slice(0, 3).map((incident) => monitorIncidentCard(incident)))
              : h('div', { className: 'dbk-row' },
                h('div', { className: 'dbk-row-main' }, h('div', { className: 'dbk-row-desc' }, t('monitorNoResolved'))))),
          h('section', { className: 'dbk-section', 'data-dbk-card': 'monitor-notify' },
            h('div', { className: 'dbk-section-head' }, t('monitorNotifySummary')),
            h('div', { className: 'dbk-row' },
              h('div', { className: 'dbk-row-main' },
                h('div', { className: 'dbk-row-title' }, channels.map((channel) => h('span', { key: channel.id, className: 'dbk-tag ' + (channel.configured ? 'ok' : 'pre') }, monChannelLabel(channel.id)))),
                h('div', { className: 'dbk-row-desc' }, t('monNotifyHint'))),
              h('div', { className: 'dbk-row-action' },
                h(Btn, { small: true, variant: 'ghost', onClick: () => openSub('notify') }, t('monitorNotifyGo'))))))
      }

      function advancedPanel() {
        return h('div', { className: 'dbk-panel' },
          h('section', { className: 'dbk-section' },
            h('div', { className: 'dbk-section-head' }, t('settingsAdvanced')),
            h(Row, { title: t('advancedRoot'), desc: rootPending ? fill(t('rootPending'), { root: rootPending }) : (state.root || '—'), mono: true },
              h('div', { className: 'dbk-off-actions' },
                h(Btn, { small: true, onClick: () => openSub('store'), disabled: busyAny }, t('rootChange')),
                h(Btn, { small: true, variant: 'ghost', onClick: () => openTarget('store'), disabled: busyAny }, t('open')))),
            h(Row, { title: t('home'), desc: state.home || '—', mono: true }),
            h(Row, { title: t('advancedCli'), desc: h('div', { className: 'dbk-code' }, 'node scripts/cli.mjs list | backup | restore latest | verify latest') },
              h(Btn, { small: true, variant: 'ghost', onClick: () => copyText('node scripts/cli.mjs list | backup | restore latest | verify latest') }, t('copy'))),
            state.lastError
              ? h(Row, { title: t('lastError'), desc: String(state.lastError), error: true },
                h(Btn, { small: true, variant: 'ghost', onClick: () => openTarget('logs'), disabled: busyAny }, t('openLog')))
              : h(Row, { title: t('lastError'), desc: t('noError') }),
            h(Row, { title: t('openLog'), desc: t('advancedCliDesc') },
              h(Btn, { small: true, variant: 'ghost', onClick: () => openTarget('logs'), disabled: busyAny }, t('openLog')))),
          h('section', { className: 'dbk-section' },
            h('div', { className: 'dbk-section-head' }, t('aboutTitle')),
            h('div', { className: 'dbk-row' },
              h('div', { className: 'dbk-row-main' },
                h('div', { className: 'dbk-row-title' }, t('aboutDesc')),
                h('div', { className: 'dbk-row-desc' }, t('aboutNote')))),
            h('div', { className: 'dbk-row' },
              h('div', { className: 'dbk-row-main' }, h('div', { className: 'dbk-row-title' }, t('aboutVersion') + ' ' + VERSION + ' · ' + t('seatLine')))),
            h('div', { className: 'dbk-row' },
              h('div', { className: 'dbk-row-main' }, h('div', { className: 'dbk-row-desc' }, t('versionNote'))))))
      }

      /* ---------------- 确认弹窗 ---------------- */

      function renderConfirm() {
        if (!confirm) return null
        const restoring = Boolean(confirm.restoring)
        const close = () => { if (!restoring) setConfirm(null) }
        let title = ''
        let sub = ''
        let body = null
        let foot = null
        let wide = false
        if (confirm.kind === 'delete') {
          const snap = confirm.snap || {}
          title = fill(t('confirmDeleteTitle'), { time: snap.at ? fmtFull(new Date(snap.at)) : '—' })
          sub = t('confirmDeleteNote')
          body = h('div', { className: 'dbk-warnbar' }, h('span', { className: 'dbk-ico' }, h(IconAlert)), h('span', null, fill(t('snapMeta'), {
            files: fmtInt(snap.files), changed: fmtInt(snap.changed), size: fmtBytes(snap.bytes),
          })))
          foot = [
            h(Btn, { onClick: close, key: 'cancel', action: 'modal-cancel' }, t('cancel')),
            h(Btn, { variant: 'danger-solid', onClick: doDelete, disabled: busyAny, key: 'ok', action: 'delete-confirm' }, t('confirmDelete')),
          ]
        } else if (confirm.kind === 'off-clear') {
          title = t('offClearKeyTitle')
          sub = t('offClearKeyNote')
          body = h('div', { className: 'dbk-warnbar err' }, h('span', { className: 'dbk-ico' }, h(IconAlert)), h('span', null, t('offCacheNote')))
          foot = [
            h(Btn, { onClick: close, key: 'cancel', action: 'modal-cancel' }, t('cancel')),
            h(Btn, { variant: 'danger-solid', onClick: doOffClear, disabled: offBusyRef.current, key: 'ok', action: 'offkey-confirm' }, t('offClearKeyConfirm')),
          ]
        } else if (confirm.kind === 'mon-install') {
          title = t('monConfirmInstallTitle')
          sub = t('monInstallConfirm')
          body = h('div', { className: 'dbk-warnbar' }, h('span', { className: 'dbk-ico' }, h(IconAlert)), h('span', null, t('monInstallNote')))
          foot = [
            h(Btn, { onClick: close, key: 'cancel', action: 'modal-cancel' }, t('cancel')),
            h(Btn, { variant: 'primary', onClick: doMonInstall, disabled: monitorBusyAny, busy: monBusy === 'monitor-install', key: 'ok', action: 'monitor-install-confirm' }, t('monConfirmInstall')),
          ]
        } else if (confirm.kind === 'mon-restore') {
          const incident = confirm.incident || {}
          const recommendation = incident.recommendation || {}
          title = fill(t('monRestoreConfirmTitle'), { time: fmtFull(new Date(Number(recommendation.at) || 0)) })
          sub = t('monRestoreConfirmNote')
          body = h('div', null,
            h('div', { className: 'dbk-confirm-grid' },
              h('div', { className: 'dbk-kv' }, h('b', null, recommendation.snapshotId || '—')),
              h('div', { className: 'dbk-kv' }, t(monKindKey(incident.kind)))),
            h('div', { className: 'dbk-warnbar' }, h('span', { className: 'dbk-ico' }, h(IconAlert)), h('span', null, t('monRestoreConfirmNote'))))
          foot = [
            h(Btn, { onClick: close, key: 'cancel', action: 'modal-cancel' }, t('cancel')),
            h(Btn, { variant: 'danger-solid', onClick: doMonRestore, disabled: monitorBusyAny, busy: monBusy === 'monitor-restore', key: 'ok', action: 'monitor-restore-confirm' }, t('monConfirmRestore')),
          ]
        } else if (confirm.kind === 'off-restore') {
          const item = confirm.item || {}
          title = fill(t('offRestoreTitle'), { time: item.at ? fmtFull(new Date(item.at)) : '—' })
          sub = t('offRestoreNote')
          body = h('div', null,
            h('div', { className: 'dbk-confirm-grid' },
              h('div', { className: 'dbk-kv' }, h('b', null, item.snapshotId || '—')),
              h('div', { className: 'dbk-kv' }, fill(t('offArchiveMeta'), { files: fmtInt(item.files), size: fmtBytes(item.bytes) }))),
            h('div', { className: 'dbk-warnbar' }, h('span', { className: 'dbk-ico' }, h(IconAlert)), h('span', null, t('offRestoreNote'))))
          foot = [
            h(Btn, { onClick: close, key: 'cancel', action: 'modal-cancel' }, t('cancel')),
            h(Btn, { variant: 'danger-solid', onClick: onOffRestore, disabled: offWorking, busy: offBusy === 'offsite-restore', key: 'ok', action: 'offsite-restore-confirm' }, t('offConfirmRestore')),
          ]
        } else {
          const snap = confirm.snap || {}
          const preview = confirm.preview
          const failed = Boolean(confirm.error)
          wide = true
          title = fill(t('confirmRestoreTitle'), { time: snap.at ? fmtFull(new Date(snap.at)) : '—' })
          sub = preview && !confirm.unsupported
            ? fill(t('confirmRestoreSub'), { files: fmtInt(snap.files) })
            : fill(t('confirmRestoreSubPlain'), { files: fmtInt(snap.files) })
          const parts = []
          if (confirm.loading) {
            parts.push(h('div', { className: 'dbk-preview-load' }, h('span', { className: 'dbk-spin' }), t('previewLoading')))
          }
          if (failed) {
            parts.push(h('div', { className: 'dbk-warnbar err' }, h('span', { className: 'dbk-ico' }, h(IconAlert)),
              h('span', null, fill(preview ? 'restoreFailed' : 'previewFailed', { message: confirm.error }))))
          }
          if (confirm.unsupported) {
            parts.push(h('div', { className: 'dbk-warnbar' }, h('span', { className: 'dbk-ico' }, h(IconAlert)), h('span', null, t('previewUnsupported'))))
          }
          if (preview) {
            parts.push(h('ul', { className: 'dbk-effects' },
              h('li', null, h('span', { className: 'dbk-ico', style: { color: 'var(--dbk-ok-ink)', flex: 'none' } }, h(IconCheck)),
                h('span', null, fill(t('previewChanged'), { n: fmtInt(preview.changed) }) + ' · ' + fill(t('previewCreate'), { n: fmtInt(preview.create) }))),
              h('li', null, h('span', { className: 'dbk-ico', style: { flex: 'none' } }, h(IconCheck)),
                h('span', null, t('effectSaved'))),
              h('li', null, h('span', { className: 'dbk-ico', style: { flex: 'none' } }, h(IconCheck)),
                h('span', null, fill(t('previewExtra'), { n: fmtInt(preview.extra) }))),
              h('li', null, h('span', { className: 'dbk-ico', style: { flex: 'none' } }, h(IconCheck)),
                h('span', null, fill(t('previewBytes'), { size: fmtBytes(preview.bytes) })))))
            if (preview.sample && preview.sample.length) {
              parts.push(h('button', {
                type: 'button',
                className: 'dbk-files-toggle',
                'aria-expanded': filesOpen ? 'true' : 'false',
                onClick: () => setFilesOpen((value) => !value),
              }, h('span', null, filesOpen ? '▾' : '▸'), t('filesToggle') + '（' + fmtInt(preview.changed + preview.create) + '）'))
              if (filesOpen) {
                parts.push(h('div', { className: 'dbk-files' },
                  preview.sample.map((item) => h('code', { key: item.rel }, item.rel))))
              }
            }
          }
          parts.push(h('div', { className: 'dbk-warnbar' }, h('span', { className: 'dbk-ico' }, h(IconAlert)), h('span', null, t('restartWarn'))))
          body = h('div', null, parts)
          foot = restoring
            ? [h(Btn, { variant: 'primary', disabled: true, busy: true, key: 'restoring' }, t('restoringNow'))]
            : [
              h(Btn, { onClick: close, key: 'cancel', action: 'modal-cancel' }, t('cancel')),
              failed && !preview
                ? h(Btn, { variant: 'primary', onClick: () => openRestore(snap, true), key: 'retry', action: 'restore-retry' }, t('retry'))
                : h(Btn, { variant: 'primary', onClick: doRestore, disabled: !preview || busyAny, key: 'ok', action: 'restore-confirm' }, t('confirmRestoreBtn')),
            ]
        }
        return h('div', { className: 'dbk-backdrop', onClick: close },
          h('div', {
            className: 'dbk-modal' + (wide ? ' wide' : ''),
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dbk-modal-title',
            'data-dbk-modal': confirm.kind,
            onClick: (event) => event.stopPropagation(),
          },
          h('div', { className: 'dbk-modal-head' },
            h('h2', { className: 'dbk-modal-title', id: 'dbk-modal-title' }, title),
            h('button', { type: 'button', className: 'dbk-modal-close', onClick: close, 'aria-label': t('modalClose') }, '×')),
          h('p', { className: 'dbk-modal-sub' }, sub),
          h('div', { className: 'dbk-modal-body' }, body),
          h('div', { className: 'dbk-modal-foot' }, foot)))
      }

      function numberField(value, unitText, ariaLabel, onInput) {
        return h('div', { className: 'dbk-stepper' },
          h('input', {
            inputMode: 'numeric',
            value: value == null ? '' : String(value),
            onChange: onInput,
            'aria-label': ariaLabel,
          }),
          unitText ? h('span', { className: 'dbk-stepper-unit' }, unitText) : null)
      }
      /* ---------------- 异地副本 UI ---------------- */

      function offsiteStateTag() {
        // 旧 Host 的降级提示已经写在区块正文里，标题右侧不再重复一遍长句子
        if (offUnsupported) return null
        if (!off || offLoaded === false) return h('span', { className: 'dbk-off-tag quiet' }, t('offLoading'))
        if (off.busy || (off.progress && off.progress.phase && off.progress.phase !== 'idle')) {
          return h('span', { className: 'dbk-off-tag' }, h('span', { className: 'dbk-spin' }), t(offPhaseLabel[(off.progress && off.progress.phase) || ''] || 'working'))
        }
        if (off.enabled === false) return h('span', { className: 'dbk-off-tag quiet' }, t('offStateOff'))
        if (off.initialized === false) return h('span', { className: 'dbk-off-tag warn' }, t('offStateNew'))
        if (off.locked) return h('span', { className: 'dbk-off-tag warn' }, t('offStateLocked'))
        return h('span', { className: 'dbk-off-tag ok' }, t('offStateUnlocked'))
      }

      function offsiteProgress() {
        const p = (off && off.progress) || {}
        const phase = p.phase && p.phase !== 'idle' ? p.phase : ''
        if (!offWorking && !phase) return null
        const total = Number(p.totalBytes) || 0
        const done = Number(p.doneBytes) || 0
        const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
        const indet = !(total > 0)
        const label = t(offPhaseLabel[phase] || 'working')
        return h('div', {
          className: 'dbk-off-prog',
          role: 'progressbar',
          'aria-label': label,
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': indet ? undefined : pct,
        },
        h('div', { className: 'dbk-off-prog-bar' },
          h('div', {
            className: 'dbk-off-prog-fill' + (indet ? ' indet' : ''),
            style: indet ? undefined : { width: Math.max(2, pct) + '%' },
          })),
        h('div', { className: 'dbk-off-prog-text' },
          h('span', null, label),
          h('span', null, total > 0 ? `${fmtBytes(done)} / ${fmtBytes(total)}` : '')))
      }

      function offsitePasswordForm(mode) {
        const invalid = offPassword ? validateOffPassword(offPassword) : ''
        const busyAction = mode === 'init' ? 'offsite-init' : 'offsite-unlock'
        return h('div', { className: 'dbk-off-lock' },
          h('span', { className: 'dbk-ico' }, h(mode === 'init' ? IconKey : IconLock)),
          h('div', { className: 'dbk-off-lock-main' },
            h('div', { className: 'dbk-off-lock-title' }, mode === 'init' ? t('offInitTitle') : t('offLockedTitle')),
            h('div', null, mode === 'init' ? t('offInitDesc') : t('offLockedDesc'))),
          h('div', { className: 'dbk-off-form' },
            h('input', {
              className: 'dbk-off-pass',
              type: 'password',
              minLength: 9,
              value: offPassword,
              autoComplete: 'off',
              spellCheck: false,
              placeholder: t('offPasswordPlaceholder'),
              'aria-label': t('offPassword'),
              onChange: (event) => setOffPassword(event.target.value),
              onKeyDown: (event) => {
                if (event.key !== 'Enter') return
                if (mode === 'init') onOffInit()
                else onOffUnlock(false)
              },
            }),
            h(Btn, {
              variant: 'primary',
              onClick: mode === 'init' ? onOffInit : () => onOffUnlock(false),
              disabled: offWorking || Boolean(invalid),
              busy: offBusy === busyAction,
            }, mode === 'init' ? t('offInit') : t('offUnlock'))),
          invalid
            ? h('div', { className: 'dbk-off-hint err' }, invalid)
            : (mode === 'init' ? h('div', { className: 'dbk-off-hint' }, t('offPasswordWeak')) : null))
      }

      function offsitePeerRow() {
        const peer = offPeerInfo || {}
        let tag = h('span', { className: 'dbk-off-tag warn' }, t('offPeerMissing'))
        let desc = t('offPairHint')
        if (peer.sync) {
          if (peer.online) {
            tag = h('span', { className: 'dbk-off-tag ok' }, t('offPeerOnline') + (peer.name ? ' · ' + peer.name : ''))
            desc = t('offPeerDesc')
          } else {
            tag = h('span', { className: 'dbk-off-tag warn' }, t('offPeerOffline') + (peer.name ? ' · ' + peer.name : ''))
            desc = t('offPairHint')
          }
        }
        return h(Row, { title: t('offPeer'), desc },
          h('div', { className: 'dbk-off-actions' }, tag,
            offUnlocked && peer.online
              ? h(Btn, {
                small: true,
                variant: 'ghost',
                onClick: onOffSync,
                disabled: offWorking,
                busy: offBusy === 'offsite-sync',
              }, t('offSync'))
              : null))
      }

      function offsiteTargetRow() {
        const peer = offPeerInfo || {}
        const peers = (off && Array.isArray(off.peers) && off.peers.length)
          ? off.peers
          : (Array.isArray(peer.peers) ? peer.peers : [])
        if (!peers.length) {
          return h(Row, { title: t('offTarget'), desc: t('offTargetDesc') },
            h('span', { className: 'dbk-off-tag quiet' }, t('offTargetNone')))
        }
        const selected = peers.find((item) => item.selected)
          || peers.find((item) => item.deviceId === peer.id)
          || null
        // 「自动」当前实际命中的设备：优先 offsite 解析后的 peer.name（source='fallback'）
        const autoName = (peer.source === 'fallback' && peer.name)
          ? peer.name
          : (((peers.find((item) => item.online) || peers[0]) || {}).name
            || ((peers.find((item) => item.online) || peers[0]) || {}).deviceId
            || t('offTargetNone'))
        let desc = t('offTargetDesc')
        if (peer.configValid === false) {
          desc = fill(t('offTargetInvalid'), { name: (selected && (selected.name || selected.deviceId)) || peer.name || peer.id || '—' })
        } else if (peer.source === 'fallback') {
          desc = fill(t('offTargetAuto'), { name: autoName })
        }
        const offline = selected ? selected.online === false : false
        return h(Row, {
          title: t('offTarget'),
          desc: h('span', null,
            desc,
            offline ? h('span', { className: 'dbk-off-tag warn', style: { marginLeft: '8px' } }, t('offTargetOffline')) : null),
        }, h('select', {
          className: 'dbk-field-input dbk-select',
          value: selected ? selected.deviceId : '',
          onChange: (event) => onOffSelectPeer(event.target.value),
          disabled: offWorking,
          'aria-label': t('offTarget'),
          'data-dbk-field': 'peer-target',
        },
        h('option', { value: '' },
          fill(t('offTargetAuto'), { name: autoName })),
        peers.map((item) => h('option', { key: item.deviceId, value: item.deviceId },
          `${item.name || item.deviceId} · ${item.online ? t('offPeerOnline') : t('offPeerOffline')}`))))
      }

      function offsiteArchiveRow(item) {
        const time = item.at ? fmtFull(new Date(item.at)) : '—'
        const source = item.source === 'peer' ? t('offSourcePeer') : t('offSourceLocal')
        return h(Row, {
          key: (item.manifestName || '') + (item.snapshotId || ''),
          title: h('span', { className: 'dbk-off-archive-main' },
            h('span', null, time),
            h('span', { className: 'dbk-off-tag quiet' }, source)),
          desc: h('span', { className: 'dbk-off-archive-meta' },
            h('span', { className: 'dbk-off-archive-id' }, item.snapshotId || '—'),
            ' · ',
            fill(t('offArchiveMeta'), { files: fmtInt(item.files), size: fmtBytes(item.bytes) })),
        },
        h('div', { className: 'dbk-off-actions' },
          h(Btn, { small: true, variant: 'ghost', onClick: () => onOffDrill(item.snapshotId), disabled: offWorking }, t('offDrill')),
          h(Btn, {
            small: true,
            variant: 'primary',
            onClick: () => setConfirm({ kind: 'off-restore', item }),
            disabled: offWorking,
          }, t('offRestore'))))
      }

      function offsiteInitBody() {
        // 换机/重装：本地没有仓库头但子机上有 → 输密码直接引导恢复，不新建仓库覆盖
        if (off && off.bootstrapAvailable) {
          return h('div', null,
            offsitePasswordForm('unlock'),
            h('div', { className: 'dbk-row-note' }, t('offPairHint')))
        }
        return offsitePasswordForm('init')
      }

      function offsiteSection(embedded) {
        const head = embedded ? null : h('div', { className: 'dbk-section-head' },
          h('div', { className: 'dbk-section-title' }, t('offTitle')),
          h('div', { className: 'dbk-section-side' },
            offsiteStateTag(),
            h(Btn, {
              small: true,
              onClick: () => loadOffsite(true),
              disabled: offWorking,
              title: t('refresh'),
              ariaLabel: t('refresh'),
            }, t('refresh'))))

        if (offUnsupported) {
          return h('div', { className: 'dbk-section', id: 'dbk-offsite' },
            head,
            h('div', { className: 'dbk-rows' }, h(Row, { title: t('offTitle'), desc: t('offUnsupported') })))
        }
        if (!offLoaded || !off) {
          return h('div', { className: 'dbk-section', id: 'dbk-offsite' },
            head,
            h('div', { className: 'dbk-rows' },
              h('div', { className: 'dbk-skel' },
                h('div', { className: 'dbk-skel-bar', style: { width: '42%' } }),
                h('div', { className: 'dbk-skel-bar' }))))
        }

        const children = [
          h(Row, {
            title: t('offEnable'),
            desc: off.enabled === false ? t('offDisabledDesc') : t('offDesc'),
          }, h(Switch, {
            on: off.enabled !== false,
            onToggle: onOffToggleEnabled,
            disabled: offWorking,
            label: t('offTitle'),
          })),
          offsitePeerRow(),
          offsiteTargetRow(),
        ]

        if (off.initialized === false) {
          children.push(offsiteInitBody())
        } else if (off.locked) {
          children.push(offsitePasswordForm('unlock'))
          if (off.hasCachedKey) {
            children.push(h(Row, {
              title: t('offCacheUse'),
              desc: t('offCacheNote'),
            }, h('div', { className: 'dbk-off-actions' },
              h(Btn, {
                small: true,
                variant: 'ghost',
                onClick: () => onOffUnlock(true),
                disabled: offWorking,
                busy: offBusy === 'offsite-unlock',
                icon: h(IconKey),
              }, t('offCacheUse')),
              h(Btn, { small: true, variant: 'danger', onClick: () => setConfirm({ kind: 'off-clear' }), disabled: offWorking }, t('offCacheClear')))))
          }
          children.push(h(Row, { title: t('offArchives'), desc: t('offLockedHint') }))
        } else if (offArchivesHidden) {
          // 子机离线 / 没有设备同步：只显示原因和配对提示，不展示档案内容
          children.push(h(Row, {
            title: t('offArchives'),
            desc: t('offPairHint'),
          }, h('span', { className: 'dbk-off-tag warn' }, offPeerInfo && offPeerInfo.sync === false ? t('offPeerMissing') : t('offPeerOffline'))))
          children.push(h(Row, { title: t('offLock'), desc: t('offCacheNote') },
            h('div', { className: 'dbk-off-actions' },
              h(Btn, { small: true, variant: 'ghost', onClick: onOffLock, disabled: offWorking }, t('offLock')),
              off.hasCachedKey
                ? h(Btn, { small: true, variant: 'danger', onClick: () => setConfirm({ kind: 'off-clear' }), disabled: offWorking }, t('offCacheClear'))
                : null)))
        } else {
          // 已解锁：进度 → 档案列表 → 密钥管理 → 设置
          children.push(offsiteProgress())
          children.push(h('div', { className: 'dbk-rows' },
            h(Row, {
              title: t('offRepoUsage'),
              desc: off.repo
                ? fill(t('offUsage'), {
                  used: fmtBytes(off.repo.bytes || 0),
                  quota: fmtBytes((off.config && off.config.quotaBytes) || 0),
                })
                : t('offRepoEmpty'),
            },
            h('div', { className: 'dbk-off-actions' },
              off.repo && off.repo.overQuota
                ? h('span', { className: 'dbk-off-tag err' }, t('offQuota'))
                : null,
              h(Btn, {
                small: true,
                variant: 'primary',
                onClick: onOffExport,
                disabled: offWorking,
                busy: offBusy === 'offsite-export',
              }, t('offExport')))),
            h(Row, { title: t('offLock'), desc: t('offCacheNote') },
              h('div', { className: 'dbk-off-actions' },
                h(Btn, { small: true, variant: 'ghost', onClick: onOffLock, disabled: offWorking }, t('offLock')),
                off.hasCachedKey
                  ? h(Btn, { small: true, variant: 'danger', onClick: () => setConfirm({ kind: 'off-clear' }), disabled: offWorking }, t('offCacheClear'))
                  : h('span', { className: 'dbk-off-tag quiet' }, t('offCacheClear'))))))

          children.push(h('div', { className: 'dbk-section-head', style: { marginTop: '16px' } },
            h('div', { className: 'dbk-section-title' }, t('offArchives')),
            off.archives && off.archives.length
              ? h('div', { className: 'dbk-section-side' }, h('span', null, fill(t('total'), { n: fmtInt(off.archives.length) })))
              : null))
          if (!off.archives || !off.archives.length) {
            children.push(h('div', { className: 'dbk-off-empty' }, t('offArchivesEmpty')))
          } else {
            children.push(h('div', { className: 'dbk-rows' }, off.archives.map((item) => offsiteArchiveRow(item))))
          }

          // 时间线 / 错误
          const stamps = []
          stamps.push(`${t('offLastExport')}: ${off.lastExportAt ? fmtFull(new Date(off.lastExportAt)) : t('offNever')}`)
          stamps.push(`${t('offLastSync')}: ${off.lastSyncAt ? fmtFull(new Date(off.lastSyncAt)) : t('offNever')}`)
          stamps.push(`${t('offLastDrill')}: ${off.lastDrillAt ? fmtFull(new Date(off.lastDrillAt)) : t('offNever')}`)
          children.push(h(Row, { title: t('offTimeline'), desc: stamps.join(' · ') }))
          if (off.lastDrill) {
            children.push(h(Row, {
              title: t('offLastDrill'),
              desc: off.lastDrill.ok
                ? fill(t('offDrillOk'), { files: fmtInt(off.lastDrill.files) })
                : fill(t('offDrillBad'), { n: fmtInt(off.lastDrill.mismatched) }),
            }))
          }
          if (off.lastError) {
            children.push(h(Row, {
              title: t('offError'),
              desc: String(off.lastError.message || off.lastError.code || ''),
              error: true,
            }))
          }

          // 设置
          children.push(h('div', { className: 'dbk-section-head', style: { marginTop: '16px' } },
            h('div', { className: 'dbk-section-title' }, t('offSettings')),
            h('div', { className: 'dbk-section-side' },
              offDirty ? h('span', { className: 'dbk-badge pre' }, t('unsaved')) : null,
              h(Btn, {
                variant: 'primary',
                small: true,
                onClick: onOffSave,
                disabled: !offDirty || offWorking,
                busy: offBusy === 'offsite-config',
              }, t('offSave')))))
          children.push(h('div', { className: 'dbk-rows' },
            h(Row, { title: t('offRetainDaily'), desc: t('offRetainDailyDesc') },
              numberField(offDraft && offDraft.retainDaily, t('unitCount'), t('offRetainDaily'),
                (event) => editOffDraft({ retainDaily: String(event.target.value).replace(/[^0-9]/g, '') }))),
            h(Row, { title: t('offRetainWeekly'), desc: t('offRetainWeeklyDesc') },
              numberField(offDraft && offDraft.retainWeekly, t('unitCount'), t('offRetainWeekly'),
                (event) => editOffDraft({ retainWeekly: String(event.target.value).replace(/[^0-9]/g, '') }))),
            h(Row, { title: t('offQuota'), desc: t('offQuotaDesc') },
              numberField(offDraft && offDraft.quotaGb, 'GB', t('offQuota'),
                (event) => editOffDraft({ quotaGb: String(event.target.value).replace(/[^0-9]/g, '') }))),
            h(Row, { title: t('offSchedule'), desc: t('offScheduleDesc') },
              h('input', {
                className: 'dbk-input dbk-off-schedule',
                value: (offDraft && offDraft.schedule) || '',
                placeholder: '04:00',
                maxLength: 5,
                'aria-label': t('offSchedule'),
                onChange: (event) => editOffDraft({ schedule: event.target.value }),
              })),
            h(Row, { title: t('offWeeklyDrill'), desc: t('offWeeklyDrillDesc') },
              h(Switch, {
                on: Boolean(off.config && off.config.weeklyDrill),
                onToggle: onOffToggleWeeklyDrill,
                disabled: offWorking,
                label: t('offWeeklyDrill'),
              })),
            h(Row, { title: t('offTaskCmd'), desc: t('offTaskCmdDesc') },
              h(Btn, {
                small: true,
                variant: 'ghost',
                onClick: onOffCopyTask,
                disabled: !(off.schedule && off.schedule.command),
              }, t('offTaskCmd')))))
        }

        return h('div', { className: 'dbk-section', id: 'dbk-offsite' }, head, h('div', { className: 'dbk-rows' }, children))
      }

      /* ---------------- 崩溃监控 UI ---------------- */

      function monKindKey(kind) {
        const map = {
          crash: 'monKindCrash',
          'data-loss': 'monKindDataLoss',
          hang: 'monKindHang',
          'backup-corrupt': 'monKindBackupCorrupt',
          'offsite-stale': 'monKindOffsiteStale',
          'disk-low': 'monKindDiskLow',
        }
        return map[String(kind || '')] || 'monKindOther'
      }

      function monTimelineKey(type) {
        const map = {
          'last-heartbeat': 'monTlLastHeartbeat',
          restart: 'monTlRestart',
          'data-baseline': 'monTlDataBaseline',
          'data-drop': 'monTlDataDrop',
          'data-drop-detected': 'monTlDataDrop',
          acknowledged: 'monTlAck',
          recovered: 'monTlRecovered',
          detected: 'monTlDetected',
        }
        return map[String(type || '')] || 'monTlOther'
      }

      function monChannelLabel(id) {
        const map = {
          panel: 'monChannelPanel',
          toast: 'monChannelToast',
          webhook: 'monChannelWebhook',
          email: 'monChannelEmail',
          qq: 'monChannelQQ',
          peer: 'monChannelPeer',
        }
        return t(map[String(id || '')] || 'monChannelPanel')
      }

      function monChannelTag(channel) {
        const configured = channel && channel.configured
        const cls = configured === true ? 'ok' : 'quiet'
        const mark = configured === true ? ' ✓' : (configured === false ? ' —' : ' ?')
        return h('span', { key: channel.id, className: 'dbk-off-tag ' + cls }, monChannelLabel(channel.id) + mark)
      }

      function monAgo(ms) {
        if (ms == null) return t('monNever')
        return fmtAgo(ms, t)
      }

      function monitorBannerText(incident, recommendation) {
        const when = incident.detectedAt ? fmtFull(new Date(incident.detectedAt)) : '—'
        const snap = recommendation ? fmtFull(new Date(recommendation.at)) : t('monBannerNoSnap')
        if (incident.kind === 'crash') return fill(t('monBannerCrash'), { time: when, snap })
        if (incident.kind === 'data-loss') {
          const data = incident.data || {}
          const before = data.before || {}
          const after = data.after || {}
          let detail = ''
          if (before.files != null && after.files != null && before.files !== after.files) {
            detail = `${t('monFieldFiles')} ${fmtInt(before.files)} → ${fmtInt(after.files)}`
          } else if (before.sessions != null && after.sessions != null && before.sessions !== after.sessions) {
            detail = `${t('monFieldSessions')} ${fmtInt(before.sessions)} → ${fmtInt(after.sessions)}`
          } else {
            detail = incident.summary ? String(incident.summary).slice(0, 120) : '—'
          }
          return fill(t('monBannerDataLoss'), { detail, snap })
        }
        return fill(t('monBannerGeneric'), { kind: t(monKindKey(incident.kind)), time: when })
      }

      function monitorStatusTag() {
        if (monUnsupported) return null
        if (!monLoaded || !mon) return h('span', { className: 'dbk-off-tag quiet' }, t('loading'))
        const open = (mon.incidents && mon.incidents.open) || []
        if (open.length) {
          return h('span', { className: 'dbk-off-tag err' }, fill(t('monOpenCount'), { n: fmtInt(open.length) }))
        }
        return h('span', { className: 'dbk-off-tag ok' }, t('monNormal'))
      }

      function monitorImpactLine(incident) {
        const impact = incident.impact || {}
        const local = impact.local || {}
        const offsite = impact.offsite || {}
        const parts = [fill(t('monImpactLocal'), { checked: fmtInt(local.checked), bad: fmtInt(local.badCount) })]
        if (offsite.checked || offsite.badCount) {
          parts.push(fill(t('monImpactOffsite'), { checked: fmtInt(offsite.checked), bad: fmtInt(offsite.badCount) }))
        }
        return parts.join(' · ')
      }

      function monitorIncidentCard(incident) {
        const recommendation = incident.recommendation || null
        const timeline = Array.isArray(incident.timeline) ? incident.timeline.slice(-8) : []
        const status = String(incident.status || 'open')
        const statusTag = status === 'recovered'
          ? h('span', { className: 'dbk-off-tag ok' }, t('monRecoveredTag'))
          : (status === 'open'
            ? h('span', { className: 'dbk-off-tag err' }, t('monOpenTag'))
            : h('span', { className: 'dbk-off-tag quiet' }, t('monAckTag')))
        return h('div', {
          className: 'dbk-mon-inc',
          key: incident.id,
          'data-dbk-incident': incident.id,
        },
        h('div', { className: 'dbk-mon-inc-head' },
          h('div', { className: 'dbk-mon-inc-title' },
            h('span', { className: 'dbk-dot ' + (status === 'open' ? 'err' : 'off') }),
            t(monKindKey(incident.kind)),
            h('span', { className: 'dbk-mon-inc-time' }, fmtFull(new Date(incident.detectedAt || 0)))),
          h('div', { className: 'dbk-off-actions' },
            statusTag,
            incident.protection && incident.protection.autoPaused
              ? h('span', { className: 'dbk-off-tag warn' }, t('monTagAutoPaused'))
              : null,
            incident.protection && incident.protection.pinnedSnapshot
              ? h('span', { className: 'dbk-off-tag quiet' }, fill(t('monTagPinned'), {
                id: String(incident.protection.pinnedSnapshot).slice(0, 26),
              }))
              : null,
            status === 'open'
              ? h(Btn, {
                small: true,
                variant: 'ghost',
                onClick: () => onMonAck(incident),
                disabled: monitorBusyAny,
                action: 'monitor-ack',
              }, t('monAck'))
              : null,
            status === 'open'
              ? h(Btn, {
                small: true,
                variant: 'primary',
                onClick: () => onMonRestore(incident),
                disabled: monitorBusyAny || !recommendation,
                title: recommendation ? undefined : t('monNoRecommend'),
                action: 'monitor-restore',
              }, t('monRestore'))
              : null)),
        incident.summary ? h('div', { className: 'dbk-mon-inc-text' }, String(incident.summary)) : null,
        h('div', { className: 'dbk-confirm-grid' },
          incident.impact
            ? h('div', { className: 'dbk-kv' }, h('b', null, t('monImpact')), ' · ', monitorImpactLine(incident))
            : null,
          recommendation
            ? h('div', { className: 'dbk-kv' },
              h('b', null, t('monRecommend')), ' · ',
              fill(t('monRecommendLine'), {
                time: fmtFull(new Date(recommendation.at)),
                id: recommendation.snapshotId,
              }),
              ' · ',
              recommendation.verified ? t('monRecommendVerified') : t('monRecommendUnverified'))
            : h('div', { className: 'dbk-kv' }, h('b', null, t('monRecommend')), ' · ', t('monNoRecommend')),
          status === 'recovered' && incident.recoveredAt
            ? h('div', { className: 'dbk-kv' }, t('monRecoveredTag'), ' · ', fmtFull(new Date(incident.recoveredAt)))
            : null),
        timeline.length
          ? h('div', { className: 'dbk-tl', 'aria-label': t('monTimeline') },
            timeline.map((item, index) => h('div', { className: 'dbk-tl-item', key: index },
              h('span', { className: 'dbk-tl-at' }, fmtClock(new Date(item.at || 0))),
              h('span', { className: 'dbk-tl-type' }, t(monTimelineKey(item.type))),
              h('span', { className: 'dbk-tl-detail' }, String(item.detail || '')))))
          : null)
      }

      function notifySecretHint(configured) {
        return configured ? t('notifySecretKeep') : t('notifySecretEmpty')
      }

      function notifyTestButton(channel) {
        return h(Btn, {
          small: true,
          variant: 'ghost',
          onClick: () => onNotifyTest(channel),
          disabled: Boolean(notifyBusy),
          busy: notifyBusy === `test:${channel}`,
          action: `notify-test-${channel}`,
        }, t('notifyTest'))
      }

      function notifyResultLine(channel) {
        const result = notifyResults[channel]
        if (!result) return null
        const ok = result.ok === true
        const detail = result.result && (result.result.detail || result.result.message || result.result.path)
        return h('div', {
          className: 'dbk-row-note' + (ok ? '' : ' err'),
          'data-dbk-notify-result': channel,
        }, ok
          ? fill(t('notifyTestOk'), { channel: notifyChannelLabel(channel) })
          : fill(t('notifyTestFail'), {
            code: String((result.result && result.result.code) || 'unknown'),
            detail: String(detail || '').slice(0, 120),
          }))
      }

      function notifyEditor() {
        if (!notifyLoaded && !notifyUnsupported) {
          return h('div', { className: 'dbk-skel' },
            h('div', { className: 'dbk-skel-bar', style: { width: '42%' } }),
            h('div', { className: 'dbk-skel-bar' }))
        }
        if (notifyUnsupported) return h('div', { className: 'dbk-row-note' }, t('notifyUnsupported'))
        if (!notifyDraft) return h('div', { className: 'dbk-row-note' }, t('notifyUnsupported'))
        const draftValue = notifyDraft
        const cfgWebhooks = (notifyCfg && notifyCfg.config && Array.isArray(notifyCfg.config.webhook)) ? notifyCfg.config.webhook : []
        const hookConfigured = (hook) => {
          const key = String(hook.name || '')
          const match = cfgWebhooks.find((item) => item.name === key)
          if (match) return Boolean(match.tokenConfigured)
          return Boolean(notifyCfg && notifyCfg.secrets && notifyCfg.secrets.webhooks && notifyCfg.secrets.webhooks[key])
        }
        const rows = []
        rows.push(h('div', { className: 'dbk-section-head dbk-subhead' },
          h('div', { className: 'dbk-section-title' }, t('notifyPanel')),
          h('div', { className: 'dbk-section-side' },
            h('span', { className: 'dbk-off-tag ok' }, t('offEnable')),
            h('span', { className: 'dbk-row-note' }, t('notifyPanelDesc')))))
        rows.push(h(Row, {
          title: t('notifyToast'),
          desc: t('notifyToastDesc'),
        }, h('div', { className: 'dbk-off-actions' },
          h(Switch, {
            on: draftValue.toast,
            onToggle: () => editNotify({ toast: !draftValue.toast }),
            label: t('notifyToast'),
          }),
          notifyTestButton('toast'))))
        rows.push(notifyResultLine('toast'))

        rows.push(h('div', { className: 'dbk-section-head dbk-subhead' },
          h('div', { className: 'dbk-section-title' }, t('notifyWebhook')),
          h('div', { className: 'dbk-section-side' },
            notifyTestButton('webhook'),
            h(Btn, { small: true, onClick: addNotifyHook, disabled: Boolean(notifyBusy), action: 'notify-add-hook' }, t('notifyAddHook')))))
        rows.push(notifyResultLine('webhook'))
        if (!draftValue.webhook.length) rows.push(h('div', { className: 'dbk-row-note' }, t('notifyWebhookDesc')))
        for (const [index, hook] of draftValue.webhook.entries()) {
          rows.push(h('div', { className: 'dbk-notify-hook', key: `notify-hook-${index}` },
            h('div', { className: 'dbk-field-row' },
              h('input', {
                className: 'dbk-field-input small',
                value: hook.name,
                placeholder: t('notifyHookName'),
                'aria-label': t('notifyHookName'),
                onChange: (event) => editNotifyHook(index, { name: event.target.value }),
              }),
              h('input', {
                className: 'dbk-field-input',
                value: hook.url,
                placeholder: t('notifyHookUrl'),
                'aria-label': t('notifyHookUrl'),
                onChange: (event) => editNotifyHook(index, { url: event.target.value }),
              }),
              h('input', {
                className: 'dbk-field-input',
                type: 'password',
                value: hook.token,
                placeholder: hookConfigured(hook) ? notifySecretHint(true) : t('notifyHookToken'),
                'aria-label': t('notifyHookToken'),
                onChange: (event) => editNotifyHook(index, { token: event.target.value }),
              }),
              h(Switch, {
                on: hook.enabled,
                onToggle: () => editNotifyHook(index, { enabled: !hook.enabled }),
                label: t('notifyHookEnabled'),
              }),
              h(Btn, {
                small: true,
                variant: 'ghost',
                onClick: () => removeNotifyHook(index),
                disabled: Boolean(notifyBusy),
                action: 'notify-remove-hook',
              }, t('notifyRemove')))))
        }

        rows.push(h('div', { className: 'dbk-section-head dbk-subhead' },
          h('div', { className: 'dbk-section-title' }, t('notifyEmail')),
          h('div', { className: 'dbk-section-side' },
            notifyTestButton('email'),
            h(Switch, {
              on: draftValue.email.enabled,
              onToggle: () => editNotifyEmail({ enabled: !draftValue.email.enabled }),
              label: t('notifyEmail'),
            }))))
        rows.push(h('div', { className: 'dbk-field-row' },
          h('input', { className: 'dbk-field-input', value: draftValue.email.host, placeholder: t('notifySmtpHost'), 'aria-label': t('notifySmtpHost'), onChange: (event) => editNotifyEmail({ host: event.target.value }) }),
          h('input', { className: 'dbk-field-input small', value: draftValue.email.port, placeholder: t('notifySmtpPort'), 'aria-label': t('notifySmtpPort'), onChange: (event) => editNotifyEmail({ port: event.target.value.replace(/[^0-9]/g, '') }) }),
          h(Switch, { on: draftValue.email.useSsl, onToggle: () => editNotifyEmail({ useSsl: !draftValue.email.useSsl }), label: t('notifySmtpSsl') })))
        rows.push(h('div', { className: 'dbk-field-row' },
          h('input', { className: 'dbk-field-input', value: draftValue.email.user, placeholder: t('notifySmtpUser'), 'aria-label': t('notifySmtpUser'), onChange: (event) => editNotifyEmail({ user: event.target.value }) }),
          h('input', { className: 'dbk-field-input', type: 'password', value: draftValue.email.password, placeholder: notifyCfg && notifyCfg.config && notifyCfg.config.email && notifyCfg.config.email.passwordConfigured ? notifySecretHint(true) : t('notifySmtpPassword'), 'aria-label': t('notifySmtpPassword'), onChange: (event) => editNotifyEmail({ password: event.target.value }) })))
        rows.push(h('div', { className: 'dbk-field-row' },
          h('input', { className: 'dbk-field-input', value: draftValue.email.from, placeholder: t('notifySmtpFrom'), 'aria-label': t('notifySmtpFrom'), onChange: (event) => editNotifyEmail({ from: event.target.value }) }),
          h('input', { className: 'dbk-field-input', value: draftValue.email.to, placeholder: t('notifySmtpTo'), 'aria-label': t('notifySmtpTo'), onChange: (event) => editNotifyEmail({ to: event.target.value }) })))
        rows.push(notifyResultLine('email'))

        rows.push(h('div', { className: 'dbk-section-head dbk-subhead' },
          h('div', { className: 'dbk-section-title' }, t('notifyQQ')),
          h('div', { className: 'dbk-section-side' },
            notifyTestButton('qq'),
            h(Switch, {
              on: draftValue.qq.enabled,
              onToggle: () => editNotifyQQ({ enabled: !draftValue.qq.enabled }),
              label: t('notifyQQ'),
            }))))
        rows.push(h('div', { className: 'dbk-field-row' },
          h('input', {
            className: 'dbk-field-input',
            value: draftValue.qq.http,
            placeholder: t('notifyQQHttp'),
            'aria-label': t('notifyQQHttp'),
            onChange: (event) => editNotifyQQ({ http: event.target.value }),
          }),
          h('input', {
            className: 'dbk-field-input',
            type: 'password',
            value: draftValue.qq.token,
            placeholder: notifyCfg && notifyCfg.config && notifyCfg.config.qq && notifyCfg.config.qq.tokenConfigured
              ? notifySecretHint(true)
              : t('notifyQQToken'),
            'aria-label': t('notifyQQToken'),
            onChange: (event) => editNotifyQQ({ token: event.target.value }),
          })))
        rows.push(h('div', { className: 'dbk-field-row' },
          h('input', {
            className: 'dbk-field-input small',
            value: draftValue.qq.action,
            placeholder: t('notifyQQAction'),
            'aria-label': t('notifyQQAction'),
            onChange: (event) => editNotifyQQ({ action: event.target.value }),
          }),
          h('input', {
            className: 'dbk-field-input',
            value: draftValue.qq.target,
            placeholder: t('notifyQQTarget'),
            'aria-label': t('notifyQQTarget'),
            onChange: (event) => editNotifyQQ({ target: event.target.value }),
          })))
        rows.push(notifyResultLine('qq'))

        rows.push(h(Row, {
          title: t('notifyPeer'),
          desc: t('notifyPeerDesc'),
        }, h('div', { className: 'dbk-off-actions' },
          (off && Array.isArray(off.peers) && off.peers.length)
            ? h('select', {
              className: 'dbk-field-input dbk-select',
              value: (off.config && off.config.peerDeviceId) || '',
              onChange: (event) => onOffSelectPeer(event.target.value),
              'aria-label': t('offTarget'),
              'data-dbk-field': 'notify-peer-target',
            },
            h('option', { value: '' }, fill(t('offTargetAuto'), {
              name: (off.peers.find((peer) => peer.online) || off.peers[0]).name || t('offTargetNone'),
            })),
            off.peers.map((peer) => h('option', { key: peer.deviceId, value: peer.deviceId },
              `${peer.name || peer.deviceId} · ${peer.online ? t('offPeerOnline') : t('offPeerOffline')}`)))
            : null,
          h(Switch, {
            on: draftValue.peer.enabled,
            onToggle: () => editNotify({ peer: { enabled: !(draftValue.peer && draftValue.peer.enabled) } }),
            label: t('notifyPeerEnabled'),
          }),
          notifyTestButton('peer'))))
        rows.push(notifyResultLine('peer'))

        rows.push(h('div', { className: 'dbk-confirm-actions' },
          h(Btn, {
            variant: 'primary',
            onClick: onNotifySave,
            disabled: Boolean(notifyBusy),
            busy: notifyBusy === 'save',
            action: 'notify-save',
          }, notifyBusy === 'save' ? t('notifySaving') : t('notifySave'))))
        return h('div', { className: 'dbk-notify-body' }, rows)
      }

    }

    /* -------------------------------------------------------------- 侧栏图标 */

    function PanelIcon() {
      return h('span', { style: { display: 'inline-flex' } }, h(IconCasket, { size: 16 }))
    }

    /* ---------------------------------------------------------------- apply */

    const inject = ['slots', 'layout', 'locale']

    function apply(ctx) {
      ensureStyle()

      let t = (key, vars) => fill(zh[key] || key, vars)
      try {
        const locale = ctx.get('locale')
        if (locale && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-disaster-recovery: dictionaries')
        }
        if (locale && typeof locale.bind === 'function') {
          const bound = locale.bind(NS)
          t = (key, vars) => {
            let text = ''
            try { text = bound(key) } catch (err) { text = '' }
            if (!text) text = zh[key] || key
            return fill(text, vars)
          }
        }
      } catch (err) { /* locale 不可用时回退中文 */ }

      const registerAll = () => {
        const stopPanel = ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          inject: () => ({ ctx, t }),
        }, PanelBody)
        let stopEntry
        try {
          stopEntry = ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 44,
            label: () => t('title'),
          }, PanelIcon)
        } catch (error) {
          stopPanel()
          throw error
        }
        return () => {
          try { stopEntry() } catch (err) { /* ignore */ }
          try { stopPanel() } catch (err) { /* ignore */ }
        }
      }

      ctx.effect(() => {
        if (typeof ctx.slots.inject === 'function') {
          return ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => registerAll()))
        }
        return registerAll()
      }, 'dsh-disaster-recovery: sidebar entry + main panel')
    }

    const mod = { exports: {} }
    mod.exports.apply = apply
    mod.exports.inject = inject
    mod.exports.name = 'dsh-disaster-recovery'
    return mod.exports
  },
})
