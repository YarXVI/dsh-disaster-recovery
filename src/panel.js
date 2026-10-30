/**
 * 面板路由：/plugins/dsh-disaster-recovery/panel
 * GET  → 状态；POST → { action, ... }
 * 只允许本机回环访问（与 dsh-sync 的 panel 一致）。
 *
 * 契约 v0.3.0：
 *   - GET / action:'state' 不得每次扫盘：blob 统计走 engine.refreshBlobStats() 的 30s 缓存；
 *   - verify / preview 只读，不强制刷新统计；
 *   - backup / restore / delete 之后强刷统计（maxAgeMs: 0）；
 *   - open 支持 store / quarantine / home / logs，open-dir 兼容 = store。
 *
 * 契约 v0.4.0（异地副本）：
 *   - state 增加只读摘要 `state.offsite`（旧 Host 无此字段 → 客户端整块降级）；
 *   - offsite-* 动作全部走本机回环 + 密码只在本机内存/DPAPI，绝不进日志/响应/RPC；
 *   - 长操作由服务自身串行化，并发请求返回 `{ code:'busy' }`。
 *
 * 契约 v0.5.0（崩溃监控 / 事故卡）：
 *   - state 增加只读摘要 `state.monitor`（旧 Host 无此字段 → 客户端整块降级）；
 *   - monitor-state / monitor-ping / monitor-ack / monitor-verify / monitor-install /
 *     monitor-restore；错误统一 `{ok:false,error:{code,message}}`；
 *   - monitor-restore 仍走 engine.restore（pre-restore + quarantine），成功后事故标 recovered。
 *
 * 契约 v0.6.0（通知设置 / 备份根目录修改）：
 *   - notify-state → `{notify}`：非密的 notify 配置 + 密钥存在性（绝不回显密码/token）；
 *   - notify-save `{config,secrets}` → `{notify}`：写外部 `monitor/config.json` 的 notify 段，
 *     secrets 用 scripts/dpapi.ps1（CurrentUser）写 `monitor/secrets.dpapi`；空字符串=不修改；
 *   - notify-test `{channel}` → `{test:{ok,channel,result},notify}`：调用外部看门狗
 *     `watchdog.mjs --test-notify <channel> --json`，失败原因走 result.code；
 *   - root-set `{root,apply?}` → `{rootResult:{ok,preview?,root,previousRoot,patchFile,
 *     backupPath?,patchAction?,needRestart:true,note}}`：apply=true 时先备份 profile
 *     cordis.patch.yml、原子改 `root:` 行、读回校验，失败回滚；不需要重启才能返回结果。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const LOG_FILE = path.join(os.tmpdir(), 'dsh-disaster-recovery.log')
const OPEN_TARGETS = ['store', 'quarantine', 'home', 'logs']

function sendJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function isLoopback(address) {
  const value = String(address || '')
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1'
}

function readJsonBody(req, limit = 1_000_000) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > limit) req.destroy()
    })
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

function badRequest(message) {
  return { ok: false, error: { code: 'bad-request', message } }
}

export const PANEL_ROUTE = '/plugins/dsh-disaster-recovery/panel'

/**
 * @param {object} options
 * @param {Function} options.getEngine 取引擎实例
 * @param {Function} [options.getStartError] 引擎启动失败原因
 * @param {Function} [options.log]
 * @param {Function} [options.spawnProcess] 可注入的 spawn（测试用，避免真的弹资源管理器）
 * @param {string} [options.logFile] 日志文件路径（测试可指向临时文件）
 * @param {Function} [options.getOffsite] 取异地副本服务（可选；没有则 offsite-* 返回 offsite-unavailable）
 * @param {Function} [options.getMonitor] 取崩溃监控服务（可选；没有则 monitor-* 返回 monitor-unavailable）
 */
export function createPanelHandler({
  getEngine, getStartError, log = () => {}, spawnProcess, logFile = LOG_FILE, getOffsite, getMonitor,
}) {
  const startErrorNow = () => (typeof getStartError === 'function' ? getStartError() : null)

  /** 取崩溃监控服务；Host 旧版/未注入时返回 null（客户端整块降级）。 */
  const monitorService = () => {
    try {
      const service = typeof getMonitor === 'function' ? getMonitor() : null
      return service && typeof service === 'object' ? service : null
    } catch {
      return null
    }
  }

  const monitorUnavailable = () => ({
    ok: false,
    error: {
      code: 'monitor-unavailable',
      message: '崩溃监控需要重启 DSH 后可用（面板已更新，Host 还是旧版）',
    },
  })

  /** 执行一个监控动作：统一错误码、绝不把内部异常漏给面板。 */
  const runMonitor = async (name, fn) => {
    const service = monitorService()
    if (!service) return monitorUnavailable()
    try {
      return { ok: true, ...(await fn(service)) }
    } catch (error) {
      const code = String((error && error.code) || 'monitor-error')
      const message = String((error && error.message) || error || '监控操作失败').slice(0, 400)
      try { log(`monitor ${name} failed: ${code}`) } catch { /* ignore */ }
      const value = { ok: false, error: { code, message } }
      if (error && error.install) value.install = error.install
      return value
    }
  }

  /** 取异地副本服务；Host 旧版/未注入时返回 null（客户端整块降级）。 */
  const offsiteService = () => {
    try {
      const service = typeof getOffsite === 'function' ? getOffsite() : null
      return service && typeof service === 'object' ? service : null
    } catch {
      return null
    }
  }

  /** 错误脱敏：把请求里出现的密码从任何消息里抹掉（防御性，服务本身不回显密码）。 */
  const sanitize = (value, secrets) => {
    let text = String(value == null ? '' : value)
    for (const secret of secrets || []) {
      if (secret == null) continue
      const raw = String(secret)
      if (raw.length > 0) text = text.split(raw).join('***')
    }
    return text.slice(0, 400)
  }

  const offsiteUnavailable = () => ({
    ok: false,
    error: {
      code: 'offsite-unavailable',
      message: '异地副本需要重启 DSH 后可用（面板已更新，Host 还是旧版）',
    },
  })

  /** 执行一个异地副本动作：统一错误码、脱敏、永不回显密码。 */
  const runOffsite = async (name, payload, fn) => {
    const service = offsiteService()
    if (!service) return offsiteUnavailable()
    const secrets = [payload && payload.password].filter((value) => typeof value === 'string' && value.length > 0)
    try {
      const result = await fn(service)
      return { ok: true, ...result }
    } catch (error) {
      const code = String((error && error.code) || 'offsite-error')
      const message = sanitize((error && error.message) || error, secrets)
      try { log(`offsite ${name} failed: ${code}`) } catch { /* ignore */ }
      return { ok: false, error: { code, message: message || '异地副本操作失败' } }
    }
  }

  /** 用 explorer 打开目录/选中文件；spawnProcess 可注入便于测试。 */
  const spawnExplorer = async (args) => {
    if (typeof spawnProcess === 'function') {
      const child = spawnProcess('explorer.exe', args, { detached: true, stdio: 'ignore' })
      if (child && typeof child.unref === 'function') child.unref()
      return
    }
    const { spawn } = await import('node:child_process')
    spawn('explorer.exe', args, { detached: true, stdio: 'ignore' }).unref()
  }

  const run = async (action, payload) => {
    const engine = getEngine()
    if (!engine) {
      return { ok: false, error: { code: 'not-ready', message: startErrorNow() || '备份引擎尚未启动' } }
    }

    /** 引擎状态 + startError 覆盖（启动失败时 health 必须是 error）。 */
    const buildState = () => {
      const state = engine.state()
      const startError = startErrorNow()
      if (startError) {
        state.health = {
          level: 'error',
          code: 'last-error',
          message: `备份引擎启动失败：${String(startError).slice(0, 300)}`,
          lastSnapshotAgeMs: state.lastSnapshotAgeMs,
        }
      }
      // 异地副本只读摘要：旧 Host 没有这个字段（客户端据此整块降级）。
      // 新 Host 一定带上（null = 服务不可用），所以只看字段是否出现。
      const service = offsiteService()
      if (service) {
        try {
          state.offsite = typeof service.summary === 'function' ? service.summary() : null
        } catch {
          state.offsite = null
        }
      }
      // 崩溃监控只读摘要：同样只看字段是否出现（旧 Host 没有 → 客户端降级）。
      const monitor = monitorService()
      if (monitor) {
        try {
          state.monitor = typeof monitor.summary === 'function' ? monitor.summary() : null
        } catch {
          state.monitor = null
        }
      }
      return state
    }

    /** state 动作统一刷新：blob 统计走 30s TTL，隔离记录顺带刷新（目录很小）。 */
    const refreshStateCaches = async () => {
      if (typeof engine.refreshBlobStats === 'function') await engine.refreshBlobStats().catch(() => {})
      if (typeof engine.refreshQuarantines === 'function') await engine.refreshQuarantines().catch(() => {})
    }

    /** 长操作之后强刷引擎统计（老引擎没有这些方法时跳过）。 */
    const forceRefreshStats = async () => {
      if (typeof engine.refreshBlobStats === 'function') await engine.refreshBlobStats({ maxAgeMs: 0 }).catch(() => {})
      if (typeof engine.refreshQuarantines === 'function') await engine.refreshQuarantines({ maxAgeMs: 0 }).catch(() => {})
    }

    switch (action) {
      case 'state': {
        await refreshStateCaches()
        // 预热监控摘要（读的都是 monitor 目录下的小 JSON；2s 内复用缓存）。
        const monitor = monitorService()
        if (monitor && typeof monitor.state === 'function') await monitor.state().catch(() => {})
        return { ok: true, state: buildState() }
      }
      case 'backup': {
        const result = await engine.snapshot('manual')
        await engine.refreshBlobStats({ maxAgeMs: 0 }).catch(() => {})
        if (typeof engine.refreshQuarantines === 'function') await engine.refreshQuarantines().catch(() => {})
        return { ok: true, result, state: buildState() }
      }
      case 'restore': {
        const id = String(payload.id || '')
        if (!id) return badRequest('缺少快照 id')
        const result = await engine.restore(id)
        await engine.refreshBlobStats({ maxAgeMs: 0 }).catch(() => {})
        if (typeof engine.refreshQuarantines === 'function') await engine.refreshQuarantines().catch(() => {})
        return { ok: true, result, state: buildState() }
      }
      case 'delete': {
        const id = String(payload.id || '')
        if (!id) return badRequest('缺少快照 id')
        const pruned = await engine.deleteSnapshot(id)
        await engine.refreshBlobStats({ maxAgeMs: 0 }).catch(() => {})
        return { ok: true, pruned, state: buildState() }
      }
      case 'offsite-state': {
        const probe = payload.probe === true
        return runOffsite(action, payload, async (service) => {
          const offsite = await service.state({ probe })
          return { offsite, state: buildState() }
        })
      }
      case 'offsite-init': {
        if (typeof payload.password !== 'string' || !payload.password) {
          return badRequest('缺少恢复密码')
        }
        return runOffsite(action, payload, async (service) => {
          const result = await service.initRepo(payload.password)
          return { result, offsite: await service.state({ probe: false }), state: buildState() }
        })
      }
      case 'offsite-unlock': {
        const useCache = payload.useCache === true
        if (!useCache && (typeof payload.password !== 'string' || !payload.password)) {
          return badRequest('缺少恢复密码')
        }
        return runOffsite(action, payload, async (service) => {
          const result = useCache ? await service.unlockFromCache() : await service.unlock(payload.password)
          return { result, offsite: await service.state({ probe: false }), state: buildState() }
        })
      }
      case 'offsite-lock': {
        return runOffsite(action, payload, async (service) => {
          await service.lock()
          return { offsite: await service.state({ probe: false }), state: buildState() }
        })
      }
      case 'offsite-clear-key': {
        return runOffsite(action, payload, async (service) => {
          await service.clearKey()
          return { offsite: await service.state({ probe: false }), state: buildState() }
        })
      }
      case 'offsite-export': {
        const snapshotId = payload.snapshotId ? String(payload.snapshotId) : undefined
        return runOffsite(action, payload, async (service) => {
          const result = await service.exportNow({ snapshotId })
          await forceRefreshStats()
          return { result, offsite: await service.state({ probe: false }), state: buildState() }
        })
      }
      case 'offsite-sync': {
        return runOffsite(action, payload, async (service) => {
          const result = await service.syncToPeer()
          return { result, offsite: await service.state({ probe: false }), state: buildState() }
        })
      }
      case 'offsite-restore': {
        const snapshotId = String(payload.snapshotId || '')
        if (!snapshotId) return badRequest('缺少快照 id')
        const password = typeof payload.password === 'string' && payload.password ? payload.password : undefined
        return runOffsite(action, payload, async (service) => {
          const result = await service.restore({ snapshotId, password })
          await forceRefreshStats()
          return { result, offsite: await service.state({ probe: false }), state: buildState() }
        })
      }
      case 'offsite-drill': {
        const snapshotId = payload.snapshotId ? String(payload.snapshotId) : undefined
        return runOffsite(action, payload, async (service) => {
          const result = await service.drill({ snapshotId })
          return { result, offsite: await service.state({ probe: false }), state: buildState() }
        })
      }
      case 'offsite-prune': {
        return runOffsite(action, payload, async (service) => {
          const result = await service.pruneRemote()
          return { result, offsite: await service.state({ probe: false }), state: buildState() }
        })
      }
      case 'offsite-config': {
        const config = payload.config && typeof payload.config === 'object' ? payload.config : null
        if (!config) return badRequest('缺少 config')
        return runOffsite(action, payload, async (service) => {
          const applied = await service.updateConfig(config)
          return { applied, offsite: await service.state({ probe: false }), state: buildState() }
        })
      }
      case 'offsite-task-cmd':
      case 'offsite-install-task': {
        // 只返回命令字符串，绝不真的安装计划任务。
        return runOffsite(action, payload, async (service) => {
          const command = typeof service.taskCommand === 'function' ? service.taskCommand() : null
          if (!command) {
            throw Object.assign(new Error('先在异地副本设置里填写计划时间（例如 04:00）'), { code: 'no-schedule' })
          }
          return { command, schedule: command.schedule, taskName: command.taskName, installed: false }
        })
      }
      case 'monitor-state': {
        return runMonitor(action, async (monitor) => {
          const monitorState = await monitor.state({ fresh: payload.fresh !== false })
          return { monitor: monitorState, state: buildState() }
        })
      }
      case 'monitor-ping': {
        return runMonitor(action, async (monitor) => {
          const ping = typeof monitor.ping === 'function' ? monitor.ping(payload) : null
          return { ping }
        })
      }
      case 'monitor-ack': {
        const id = String(payload.id || '')
        if (!id) return badRequest('缺少事故 id')
        return runMonitor(action, async (monitor) => {
          const incident = await monitor.ack(id)
          return { incident, monitor: await monitor.state({ fresh: true }), state: buildState() }
        })
      }
      case 'monitor-verify': {
        return runMonitor(action, async (monitor) => {
          const verify = await monitor.verifyImpact()
          return { verify, monitor: await monitor.state({ fresh: true }), state: buildState() }
        })
      }
      case 'monitor-install': {
        return runMonitor(action, async (monitor) => {
          const install = await monitor.installExternal({ apply: payload.apply !== false })
          if (install && install.ok === false && install.error) {
            throw Object.assign(new Error(install.error.message), { code: install.error.code, install })
          }
          return { install, monitor: await monitor.state({ fresh: true }), state: buildState() }
        })
      }
      case 'monitor-restore': {
        const snapshotId = payload.snapshotId ? String(payload.snapshotId) : undefined
        const incidentId = payload.incidentId ? String(payload.incidentId) : undefined
        return runMonitor(action, async (monitor) => {
          const outcome = await monitor.restoreFromIncident({ snapshotId, incidentId })
          await forceRefreshStats()
          return {
            result: outcome.result,
            incident: outcome.incident,
            snapshot: outcome.snapshot,
            needRestart: true,
            monitor: await monitor.state({ fresh: true }),
            state: buildState(),
          }
        })
      }
      /* 契约 v0.6.0：通知设置（config.json + secrets.dpapi）与备份根目录修改 */
      case 'notify-state': {
        return runMonitor(action, async (monitor) => {
          const notify = await monitor.notifyState()
          return { notify, state: buildState() }
        })
      }
      case 'notify-save': {
        const config = payload.config && typeof payload.config === 'object' && !Array.isArray(payload.config)
          ? payload.config
          : null
        if (!config) return badRequest('缺少 notify.config')
        const secrets = payload.secrets && typeof payload.secrets === 'object' && !Array.isArray(payload.secrets)
          ? payload.secrets
          : {}
        return runMonitor(action, async (monitor) => {
          const notify = await monitor.saveNotifyConfig({ config, secrets })
          return { notify, state: buildState() }
        })
      }
      case 'notify-test': {
        const channel = String(payload.channel || '').trim()
        if (!channel) return badRequest('缺少 channel（panel|toast|webhook|email|qq|peer）')
        return runMonitor(action, async (monitor) => {
          const test = await monitor.testNotifyChannel(channel)
          return { test, notify: await monitor.notifyState() }
        })
      }
      case 'root-set': {
        const rawRoot = typeof payload.root === 'string' ? payload.root : ''
        if (!rawRoot.trim()) return badRequest('缺少 root')
        const apply = payload.apply === true
        return runMonitor(action, async (monitor) => {
          const value = apply
            ? await monitor.applyBackupRoot(rawRoot)
            : await monitor.previewBackupRoot(rawRoot)
          return { rootResult: value, state: buildState() }
        })
      }
      case 'pause':
        engine.setPaused(true)
        return { ok: true, state: buildState() }
      case 'resume':
        engine.setPaused(false)
        return { ok: true, state: buildState() }
      case 'config': {
        const applied = await engine.updateConfig(payload.config || {})
        return { ok: true, applied, state: buildState() }
      }
      case 'verify': {
        const id = payload.id ? String(payload.id) : undefined
        const verify = await engine.verifySnapshot(id)
        return { ok: true, verify, state: buildState() }
      }
      case 'preview': {
        const id = String(payload.id || '')
        if (!id) return badRequest('缺少快照 id')
        const preview = await engine.previewRestore(id)
        return { ok: true, preview, state: buildState() }
      }
      case 'open':
      case 'open-dir': {
        const target = action === 'open-dir' ? 'store' : String(payload.target || 'store')
        if (!OPEN_TARGETS.includes(target)) {
          return badRequest(`未知打开目标：${target}`)
        }
        const storeDir = engine.state().storeDir
        let dir = null
        if (target === 'store') dir = storeDir
        else if (target === 'quarantine') dir = storeDir ? path.join(storeDir, 'restore-quarantine') : null
        else if (target === 'home') dir = engine.home
        else if (target === 'logs') dir = logFile
        if (!dir) {
          return { ok: false, error: { code: 'not-ready', message: startErrorNow() || '备份引擎尚未启动' } }
        }
        if (target === 'quarantine') {
          // 隔离目录只会在恢复后出现；用户主动点“打开隔离目录”时允许补建空目录
          await fsp.mkdir(dir, { recursive: true }).catch(() => {})
        }
        if (process.platform === 'win32') {
          let args
          if (target === 'logs') {
            // 日志文件还不存在时打开临时目录本身（explorer /select 对不存在的文件不友好）
            const exists = await fsp.access(dir).then(() => true, () => false)
            args = exists ? [`/select,${dir}`] : [os.tmpdir()]
          } else {
            args = [dir]
          }
          await spawnExplorer(args)
        } else {
          log('open is only implemented on Windows')
        }
        return { ok: true, dir }
      }
      default:
        return { ok: false, error: { code: 'unknown-action', message: `未知操作：${action}` } }
    }
  }

  return async function panelHandler(req, res) {
    if (!isLoopback(req.socket && req.socket.remoteAddress)) {
      return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: '只允许本机访问' } })
    }
    try {
      if (req.method === 'GET') {
        const value = await run('state', {})
        return sendJson(res, 200, value)
      }
      if (req.method === 'POST') {
        const payload = await readJsonBody(req)
        if (!payload) return sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '请求体必须是 JSON' } })
        const value = await run(String(payload.action || ''), payload)
        return sendJson(res, value.ok ? 200 : 400, value)
      }
      return sendJson(res, 405, { ok: false, error: { code: 'method', message: 'GET 或 POST' } })
    } catch (error) {
      log(`panel request failed: ${String((error && error.stack) || error)}`)
      return sendJson(res, 500, { ok: false, error: { code: 'panel', message: String((error && error.message) || error) } })
    }
  }
}
