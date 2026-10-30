/**
 * Windows DPAPI 桥：把 `<offsite>/key.dpapi`（DPAPI CurrentUser 密文）解成恢复密码。
 *
 * 为什么要单独一个模块：
 *   - Node 没有内置 DPAPI，实际转换由 `scripts/dpapi.ps1`（PowerShell）完成：
 *     stdin = base64(DPAPI blob) → stdout = base64(UTF-8 明文)；只走管道，不落盘；
 *   - CLI（无人值守导出 `--dpapi`）和 recovery-kit（离线恢复 `recover.mjs --dpapi`）
 *     都要用，而 recovery-kit 是独立目录，需要一个可被一起复制过去的实现。
 *
 * 安全约定：
 *   - 本模块只把密码/masterKey 返回给调用方（仅内存），绝不写文件、不打印；
 *   - 错误信息里不含密码/明文 blob；
 *   - 换机/重装系统后 DPAPI 必然解不开（CurrentUser scope），此时必须用恢复密码。
 *   - 兼容两种缓存明文：面板的 JSON `{masterKey}` 与 CLI/文档的明文密码（见 parseDpapiSecret）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { repoError } from './format.js'

export const DPAPI_MODES = Object.freeze(['Protect', 'Unprotect'])

/** DPAPI 只在 Windows 可用。 */
export function dpapiAvailable() {
  return process.platform === 'win32'
}

/** 读 key.dpapi 文件，返回去掉空白后的 base64（不存在 → code='dpapi-missing'）。 */
export async function readDpapiBlob(file) {
  const abs = path.resolve(String(file || ''))
  if (!abs || abs === path.resolve('.')) throw repoError('dpapi-missing', '缺少 key.dpapi 路径')
  let text
  try {
    text = await fsp.readFile(abs, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw repoError('dpapi-missing', `本机没有 DPAPI 密钥缓存（${abs}）；请改用 --password-stdin / --password-env 输入恢复密码`)
    }
    if (error && (error.code === 'EACCES' || error.code === 'EPERM')) {
      throw repoError('dpapi-unavailable', `无法读取 DPAPI 密钥缓存（${abs}，权限不足）`)
    }
    throw error
  }
  const cleaned = String(text).replace(/\s+/g, '')
  if (!cleaned) throw repoError('dpapi-invalid', 'DPAPI 密钥缓存为空（可能已损坏，请用恢复密码）')
  return cleaned
}

/**
 * 默认 runner：调用 PowerShell 的 Unprotect。
 * 先试 `pwsh`（DSH 环境自带），再退 `powershell`（Windows PowerShell 5.1）。
 * @returns {string} stdout（base64(UTF-8 明文)）
 */
export function runPowerShellUnprotect({ scriptPath, blobBase64, timeoutMs = 60_000, mode = 'Unprotect' } = {}) {
  if (!dpapiAvailable()) {
    throw repoError('dpapi-unavailable', `DPAPI 仅支持 Windows（当前平台 ${process.platform}）`)
  }
  if (!scriptPath || !existsSync(scriptPath)) {
    throw repoError('dpapi-missing', `找不到 dpapi.ps1：${String(scriptPath || '')}`)
  }
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath, '-Mode', String(mode),
  ]
  let lastError = null
  for (const exe of ['pwsh', 'powershell']) {
    const result = spawnSync(exe, args, {
      input: String(blobBase64 || ''),
      encoding: 'utf8',
      timeout: Math.max(1000, Number(timeoutMs) || 60_000),
      windowsHide: true,
    })
    if (result && result.error) {
      lastError = result.error
      // 找不到可执行文件就换下一个；其它错误直接报不可用
      if (result.error.code === 'ENOENT') continue
      throw repoError('dpapi-unavailable', `无法执行 PowerShell：${String(result.error.message || result.error)}`)
    }
    if (!result || result.status !== 0) {
      const detail = String((result && result.stderr) || '').replace(/\s+/g, ' ').trim().slice(0, 200)
      // stderr 里只有 DPAPI 的失败原因（例如换用户/换机器），不含明文
      throw repoError('dpapi-failed', `DPAPI 解密失败${detail ? `：${detail}` : ''}（换机/重装系统后缓存失效，请用恢复密码）`)
    }
    return String(result.stdout || '').trim()
  }
  throw repoError('dpapi-unavailable', `找不到 pwsh / powershell 可执行文件${lastError ? `：${String(lastError.message || lastError)}` : ''}`)
}

/**
 * 从 key.dpapi 解出密码（仅内存）。
 *
 * @param {object} options
 * @param {string} options.file       key.dpapi 路径
 * @param {string} options.scriptPath dpapi.ps1 路径
 * @param {Function} [options.runner] 可注入（测试用）：({scriptPath, blobBase64}) -> base64(明文)
 * @returns {Promise<string>} 密码
 */
export async function passwordFromDpapi({ file, scriptPath, runner = runPowerShellUnprotect } = {}) {
  if (!dpapiAvailable()) {
    throw repoError('dpapi-unavailable', `DPAPI 仅支持 Windows（当前平台 ${process.platform}）`)
  }
  if (!scriptPath || !existsSync(scriptPath)) {
    throw repoError('dpapi-missing', `找不到 dpapi.ps1：${String(scriptPath || '')}`)
  }
  const blobBase64 = await readDpapiBlob(file)
  const encoded = String(await runner({ scriptPath, blobBase64 }) || '').trim()
  if (!encoded) throw repoError('dpapi-failed', 'DPAPI 解密结果为空（缓存可能已失效，请用恢复密码）')
  let plaintext
  try {
    plaintext = Buffer.from(encoded, 'base64').toString('utf8')
  } catch {
    throw repoError('dpapi-failed', 'DPAPI 解密结果不是合法 base64（请用恢复密码）')
  }
  if (!plaintext) throw repoError('dpapi-failed', 'DPAPI 解密结果为空（缓存可能已失效，请用恢复密码）')
  return plaintext
}

/**
 * 兼容两种缓存格式：
 *   - 面板（src/offsite.js）写的是 JSON `{v,repoId,at,masterKey:<base64 32B>}`（缓存 masterKey，比缓存密码更窄）；
 *   - 旧格式 / recovery-kit / CLI 文档里写的是明文恢复密码（非 JSON）。
 * 另外也接受 JSON `{password:"..."}`（未来格式）。
 * 返回 `{masterKey: Buffer}` 或 `{password: string}`，绝不打印内容。
 */
export function parseDpapiSecret(plaintext) {
  const text = String(plaintext == null ? '' : plaintext)
  if (!text) throw repoError('dpapi-failed', 'DPAPI 解密结果为空（缓存可能已失效，请用恢复密码）')
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    let parsed = null
    try { parsed = JSON.parse(trimmed) } catch { parsed = null }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.masterKey === 'string' && parsed.masterKey) {
        const masterKey = Buffer.from(parsed.masterKey, 'base64')
        if (masterKey.length !== 32) {
          // 明确报「缓存损坏」，不要退化成「把整段 JSON 当密码」→ 否则只会得到一个莫名的密码错
          throw repoError('dpapi-failed', 'DPAPI 缓存里的 masterKey 长度不正确（缓存可能损坏，请用恢复密码）')
        }
        return { masterKey }
      }
      if (typeof parsed.password === 'string' && parsed.password) {
        return { password: parsed.password }
      }
      throw repoError('dpapi-failed', 'DPAPI 缓存是 JSON 但既没有 masterKey 也没有 password（格式不识别，请用恢复密码）')
    }
  }
  return { password: text }
}

/**
 * 从 key.dpapi 解出 `{masterKey}` 或 `{password}`（仅内存）。
 * runner 可注入（测试用，避免依赖真实 DPAPI）：({scriptPath, blobBase64}) -> base64(明文)。
 */
export async function secretFromDpapi(options = {}) {
  if (!dpapiAvailable()) {
    throw repoError('dpapi-unavailable', `DPAPI 仅支持 Windows（当前平台 ${process.platform}）`)
  }
  const plaintext = await passwordFromDpapi(options)
  return parseDpapiSecret(plaintext)
}
