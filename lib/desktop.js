// @ts-check
/**
 * 桌面精灵的看管者：由 Dot 的 Host 启动一个系统原生的置顶小窗口，并对它的整个生命周期负责。
 *
 * - 只在 Windows 上启动（PowerShell 5.1 + WPF，系统自带，不下载任何东西）；其他平台什么都不做。
 * - 精灵只读 Dot 自己的本机接口 /status，不写任何东西。
 * - 精灵自己正常退出（用户在右键菜单里关掉、或发现 DSH 已退出）不重启；异常退出才重启，
 *   10 分钟内最多 3 次，避免崩溃循环。
 * - Host 停止（插件卸载、DSH 退出）时结束精灵进程。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const SCRIPT = fileURLToPath(new URL('./desktop/pet-win.ps1', import.meta.url))
const RESTART_WINDOW = 10 * 60_000
const MAX_RESTARTS = 3

/**
 * 是不是 DSH 桌面版的运行时：桌面版用 dsh-desktop-host/lib/index.js 启动运行时，
 * 命令行（dsh.cmd，包括网页版）用的是同一个包里的 cli.js。
 * @param {string | undefined} entry 运行时的入口脚本（process.argv[1]）
 */
export function isDesktopRuntime(entry = process.argv[1]) {
  return /dsh-desktop-host[\\/]lib[\\/]index\.js$/i.test(String(entry ?? ''))
}

/**
 * 要不要桌面精灵：明确写了 pet: 'desktop' 就要；没写时，DSH 桌面版（Windows）默认要，
 * 命令行起的网页版保持网页小精灵。pet: true / false 都表示不要桌面精灵。
 * @param {unknown} pet
 * @param {string} [platform]
 * @param {string} [entry] 运行时的入口脚本
 */
export function wantsDesktopPet(pet, platform = process.platform, entry = process.argv[1]) {
  if (pet === 'desktop') return true
  return pet === undefined && platform === 'win32' && isDesktopRuntime(entry)
}

/**
 * 启动精灵用的命令行。单独导出方便测试。
 * @param {{ statusUrl: string, parentPid: number, stateFile: string, script?: string }} o
 */
export function petCommand(o) {
  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden',
      '-File', o.script ?? SCRIPT,
      '-StatusUrl', o.statusUrl,
      '-ParentPid', String(o.parentPid),
      '-StateFile', o.stateFile,
    ],
  }
}

/**
 * @param {{
 *   platform?: string,
 *   getStatusUrl: () => string | null,
 *   stateFile: string,
 *   parentPid?: number,
 *   spawn?: typeof nodeSpawn,
 *   now?: () => number,
 *   log?: (msg: string) => void,
 *   retryDelay?: number,
 * }} options
 */
export function createDesktopPet(options) {
  const platform = options.platform ?? process.platform
  const spawn = options.spawn ?? nodeSpawn
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})
  const retryDelay = options.retryDelay ?? 3000
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null
  let stopped = true
  /** @type {number[]} */
  let crashes = []
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  /** 用户自己关掉了：本次 DSH 运行期间不再拉起 */
  let dismissed = false

  const schedule = (/** @type {number} */ ms) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; launch() }, ms)
    timer.unref?.()
  }

  const launch = () => {
    if (stopped || child || dismissed) return
    const statusUrl = options.getStatusUrl()
    if (!statusUrl) { schedule(retryDelay); return } // 端口还没绑定，稍后再试
    const { command, args } = petCommand({ statusUrl, parentPid: options.parentPid ?? process.pid, stateFile: options.stateFile })
    let proc
    try {
      proc = spawn(command, args, { windowsHide: true, stdio: 'ignore', detached: false })
    } catch (error) {
      log(`desktop pet spawn failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    child = proc
    log(`desktop pet started (pid ${proc.pid})`)
    proc.on('error', error => log(`desktop pet error: ${error.message}`))
    proc.on('exit', code => {
      if (child === proc) child = null
      if (stopped) return
      if (code === 0) { dismissed = true; log('desktop pet closed by user'); return }
      const t = now()
      crashes = [...crashes.filter(x => t - x < RESTART_WINDOW), t]
      if (crashes.length > MAX_RESTARTS) { log(`desktop pet crashed ${crashes.length} times, giving up`); return }
      log(`desktop pet exited with ${code}, restarting`)
      schedule(retryDelay)
    })
  }

  return {
    /** 在支持的平台上启动；返回是否会启动。 */
    start() {
      if (platform !== 'win32') return false
      stopped = false
      launch()
      return true
    },
    stop() {
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
      const proc = child
      child = null
      if (proc && proc.exitCode === null) {
        try { proc.kill() } catch { /* 已经退出 */ }
      }
    },
    /** 精灵进程是否在跑：网页里的小精灵据此决定要不要藏起来。 */
    alive() { return Boolean(child && child.exitCode === null) },
  }
}
