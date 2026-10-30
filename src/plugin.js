/**
 * Host 半边：起引擎、挂面板路由、装配异地副本服务。
 *
 * 异地副本依赖两件外部东西：
 *   - dsh-sync 的 broker（ctx.get('dshSync')）：没有就降级为「只导出、不同步」；
 *   - src/archive/*（加密去重仓库核心）：没就位时异地副本返回 archive-core-missing，
 *     旧的备份/恢复行为完全不变。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BackupEngine } from './engine.js'
import { createMonitorService } from './monitor.js'
import { PANEL_ROUTE, createPanelHandler } from './panel.js'
import { createArchivePort, createOffsiteService } from './offsite.js'

export const name = 'disaster-recovery'
export const inject = []

function resolveHome(config) {
  if (config && typeof config.home === 'string' && config.home.trim()) return path.resolve(config.home.trim())
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (fromEnv) return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh')
}

export function apply(ctx, config = {}) {
  const home = resolveHome(config)
  const logFile = path.join(os.tmpdir(), 'dsh-disaster-recovery.log')
  const log = (message) => {
    const line = `${new Date().toISOString()} [backup] ${message}`
    try { ctx.logger?.info?.(`[backup] ${message}`) } catch { /* logger 不可用 */ }
    try { fs.appendFileSync(logFile, line + '\n') } catch { /* ignore */ }
  }

  const engine = new BackupEngine({ home, config, log })
  let startError = null
  const ready = engine.start().catch((error) => {
    startError = String((error && error.message) || error)
    log(`engine start failed: ${startError}`)
  })

  // dsh-sync 是可选依赖：没装/未启用时 peers()/rpc() 全部降级，绝不让插件加载失败。
  const getSync = () => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('dshSync') : undefined
    } catch {
      return undefined
    }
  }

  let archivePort = null
  let archiveError = null
  /** archive 核心延迟装配：core 还没就位时只在真正用到时报错，不影响 Host 启动。 */
  const loadArchivePort = async () => {
    if (archivePort) return archivePort
    try {
      archivePort = await createArchivePort()
      archiveError = null
      return archivePort
    } catch (error) {
      archiveError = error
      throw error
    }
  }

  const offsite = createOffsiteService({
    engine,
    getSync,
    archive: loadArchivePort,
    logger: log,
    config,
  })

  // 插件内黑匣子：心跳/事故检测/体检/看门狗安装。写盘失败只记日志，绝不影响备份与恢复。
  const monitor = createMonitorService({
    engine,
    home,
    storeDir: path.resolve(engine.config.root),
    hostname: engine.hostname,
    version: engine.version,
    logger: log,
    getOffsite: () => offsite,
    getSync,
    config: config && typeof config.monitor === 'object' && config.monitor ? config.monitor : {},
  })

  // 引擎启动后初始化异地副本（读配置 / ledger / 仓库统计），失败只记日志。
  void ready.then(() => {
    offsite.init()
      .then(() => {
        if (archiveError) log(`offsite archive core unavailable: ${archiveError.code || archiveError.message}`)
      })
      .catch((error) => log(`offsite init failed: ${String((error && error.message) || error)}`))
  })

  // 监控在引擎 ready 之后启动（心跳里的快照统计依赖 engine.start 完成）；失败只记日志。
  void ready.then(() => {
    Promise.resolve()
      .then(() => monitor.start())
      .catch((error) => log(`monitor start failed: ${String((error && error.message) || error)}`))
  })

  const handler = createPanelHandler({
    getEngine: () => engine,
    getStartError: () => startError,
    getOffsite: () => offsite,
    getMonitor: () => monitor,
    log,
  })

  ctx.effect(() => {
    let stop = null
    try {
      ctx.inject(['webServer'], (scoped) => {
        try {
          const server = scoped.get('webServer')
          if (!server || typeof server.register !== 'function') {
            log('webServer.register 不可用：面板不可用，备份/恢复仍可用 CLI')
            return
          }
          stop = scoped.effect(
            () => server.register({ kind: 'prefix', path: PANEL_ROUTE, handler }),
            'dsh-disaster-recovery: panel route',
          )
          log(`panel route mounted ${PANEL_ROUTE}`)
        } catch (error) {
          log(`panel route mount failed: ${String((error && error.message) || error)}`)
        }
      })
    } catch (error) {
      log(`webServer inject failed: ${String((error && error.message) || error)}`)
    }
    return () => { try { if (typeof stop === 'function') stop() } catch { /* ignore */ } }
  })

  // 异地副本的无人值守调度：每日导出 + 每周演练（需要已缓存密钥，缺密钥时自动跳过）。
  ctx.effect(() => {
    const stopScheduler = typeof offsite.startScheduler === 'function' ? offsite.startScheduler() : null
    return () => {
      try { if (typeof stopScheduler === 'function') stopScheduler() } catch { /* ignore */ }
    }
  })

  ctx.effect(() => () => {
    // 先停监控（同步写 cleanExit，避免下次启动误报崩溃），再停引擎。
    try { void Promise.resolve(monitor.stop()).catch(() => {}) } catch { /* ignore */ }
    engine.stop().catch(() => {})
    try { offsite.dispose?.()?.catch?.(() => {}) } catch { /* ignore */ }
  })

  void ready
}
