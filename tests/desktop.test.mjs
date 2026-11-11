import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createDesktopPet, petCommand, SCRIPT, wantsDesktopPet } from '../lib/desktop.js'

function fakeSpawn() {
  /** @type {any[]} */
  const procs = []
  const spawn = (/** @type {string} */ command, /** @type {string[]} */ args, /** @type {any} */ opts) => {
    const p = Object.assign(new EventEmitter(), {
      pid: 1000 + procs.length, exitCode: /** @type {number | null} */ (null), killed: false, command, args, opts,
      kill() { this.killed = true; this.exitCode = 1; this.emit('exit', 1) },
      exit(/** @type {number} */ code) { this.exitCode = code; this.emit('exit', code) },
    })
    procs.push(p)
    return p
  }
  return { spawn: /** @type {any} */ (spawn), procs }
}

const wait = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms))

test('桌面精灵：命令行只读本机 status，带父进程和状态文件', () => {
  const { command, args } = petCommand({ statusUrl: 'http://127.0.0.1:3999/api/dsh-plugin-dot/status', parentPid: 42, stateFile: 'D:/d/desktop-pet.json' })
  assert.equal(command, 'powershell.exe')
  assert.deepEqual(args.slice(args.indexOf('-File') + 1, args.indexOf('-File') + 2), [SCRIPT])
  assert.equal(args[args.indexOf('-StatusUrl') + 1], 'http://127.0.0.1:3999/api/dsh-plugin-dot/status')
  assert.equal(args[args.indexOf('-ParentPid') + 1], '42')
  assert.ok(args.includes('-STA') && args.includes('-NoProfile'))
})

test('桌面精灵：非 Windows 不启动；端口没绑定时稍后再试', async () => {
  const a = fakeSpawn()
  assert.equal(createDesktopPet({ platform: 'darwin', getStatusUrl: () => 'x', stateFile: 's', spawn: a.spawn }).start(), false)
  assert.equal(a.procs.length, 0)

  let url = /** @type {string | null} */ (null)
  const b = fakeSpawn()
  const pet = createDesktopPet({ platform: 'win32', getStatusUrl: () => url, stateFile: 's', spawn: b.spawn, retryDelay: 5 })
  assert.equal(pet.start(), true)
  assert.equal(b.procs.length, 0)
  url = 'http://127.0.0.1:1/api/dsh-plugin-dot/status'
  await wait(20)
  assert.equal(b.procs.length, 1)
  assert.equal(pet.alive(), true)
  assert.equal(b.procs[0].opts.windowsHide, true)
  pet.stop()
  assert.equal(b.procs[0].killed, true)
  assert.equal(pet.alive(), false)
})

test('桌面精灵：用户关掉（退出码 0）不重启；崩溃重启，10 分钟内最多 3 次', async () => {
  const a = fakeSpawn()
  const pet = createDesktopPet({ platform: 'win32', getStatusUrl: () => 'u', stateFile: 's', spawn: a.spawn, retryDelay: 1 })
  pet.start()
  a.procs[0].exit(0)
  await wait(10)
  assert.equal(a.procs.length, 1)
  assert.equal(pet.alive(), false)

  const b = fakeSpawn()
  const pet2 = createDesktopPet({ platform: 'win32', getStatusUrl: () => 'u', stateFile: 's', spawn: b.spawn, retryDelay: 1, now: () => 1000 })
  pet2.start()
  for (let i = 0; i < 5; i++) {
    b.procs.at(-1).exit(1)
    await wait(10)
  }
  assert.equal(b.procs.length, 4) // 首次 + 3 次重启
  pet2.stop()
})

test('桌面精灵脚本：带 BOM（PowerShell 5.1 才能读中文），写操作只走 Dot 自己的白名单接口，父进程没了就退出', () => {
  const raw = readFileSync(SCRIPT)
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.notDeepEqual([...raw.subarray(3, 6)], [0xef, 0xbb, 0xbf], '只能有一个 BOM')
  const src = raw.toString('utf8')
  assert.match(src, /Get-Dot \$StatusUrl 'On-Status'/)
  // 只有 Http.Post 一个地方发 POST，带网页小精灵同样的请求头；PowerShell 侧只能经 Send-Dot 发，Send-Dot 先查白名单
  assert.equal(src.match(/HttpMethod\.Post/g)?.length, 1)
  assert.match(src, /req\.Headers\.Add\("X-Dot-Client", "1"\)/)
  assert.doesNotMatch(src, /Invoke-WebRequest|Invoke-RestMethod|UploadString/i)
  assert.equal(src.match(/\[DotPet\.Http\]::Post/g)?.length, 1)
  { const i = src.indexOf('function Send-Dot'); assert.ok(i > 0 && src.slice(i, i + 160).includes('if ($AllowedPosts -notcontains $path)')) }
  assert.match(src, /\$AllowedPosts = @\('\/task', '\/notice', '\/say', '\/focus'\)/)
  for (const m of src.matchAll(/Send-Dot '([^']+)'/g)) assert.ok(['/task', '/notice', '/say', '/focus'].includes(m[1]), m[1])
  // 打开 DSH：先直接切前台，失败才退回 dsh://open
  assert.match(src, /BringToFront\(\$DshMainPid\)/)
  // 闭包看不到脚本里的函数：事件处理不能用 GetNewClosure
  assert.doesNotMatch(src.replace(/^#.*$/gm, ''), /GetNewClosure/)
  assert.match(src, /Get-Process -Id \$ParentPid/)
  assert.match(src, /Topmost="True"/)
})

test('桌面精灵默认值：桌面版 Windows 默认开；命令行网页版、其他平台、明确写了 true/false 的都不开', () => {
  const desk = String.raw`D:\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js`
  const cli = String.raw`D:\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`
  assert.equal(wantsDesktopPet(undefined, 'win32', desk), true)
  assert.equal(wantsDesktopPet(undefined, 'win32', cli), false)
  assert.equal(wantsDesktopPet(undefined, 'win32', undefined), false)
  assert.equal(wantsDesktopPet(undefined, 'darwin', desk), false)
  assert.equal(wantsDesktopPet(true, 'win32', desk), false)
  assert.equal(wantsDesktopPet(false, 'win32', desk), false)
  assert.equal(wantsDesktopPet('desktop', 'linux', cli), true) // 明确要：非 Windows 时看管者自己不启动
})
