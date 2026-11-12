// issue #1：宿主没有 web 服务时，Dot 预设不能因为 tool-web 被标成 broken
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hub } from '../lib/hub.js'
import { apply as applyHost, dotPresetHealth } from '../lib/host.js'

beforeEach(() => hub.reset())

/** 从 cordis.patch.yml 里取出某一行的 disabled 表达式 */
async function disabledExpr(/** @type {string} */ id) {
  const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex(l => l.trim() === `- id: ${id}`)
  assert.ok(at >= 0, `找不到 ${id} 这一行`)
  for (const l of lines.slice(at + 1, at + 4)) {
    const m = l.match(/^\s*disabled: !!js "(.*)"\s*$/)
    if (m) return m[1]
  }
  return null
}

/** 和 loader 一样用 ctx 求值 */
const evalWith = (/** @type {string} */ expr, /** @type {any} */ ctx) => new Function('ctx', `return (${expr})`)(ctx)
const loaderWith = (/** @type {any[]} */ rows) => ({ loader: { *entries() { yield* rows } } })

test('tool-web 只在宿主组合里有启用的 web 服务时才启用', async () => {
  const expr = await disabledExpr('tool-web')
  assert.ok(expr, 'tool-web 必须有 disabled 条件，否则没有 web 服务的 DSH 会把整个 Dot 预设标成 broken')
  const web = { options: { name: '@deepseek-ai/dsh-web' }, disabled: false }
  const other = { options: { name: '@deepseek-ai/dsh-tool-fs' }, disabled: false }
  assert.equal(evalWith(expr, loaderWith([other, web])), false) // 有 web：启用
  assert.equal(evalWith(expr, loaderWith([other])), true) // 没有 web 服务行：停用
  assert.equal(evalWith(expr, loaderWith([other, { ...web, disabled: true }])), true) // web 行被禁用（桌面版）：停用
  assert.equal(evalWith(expr, {}), true) // 读不到加载器：保守地停用，不让预设坏掉
})

test('预设健康：找出 Dot 预设的 broken 原因', () => {
  assert.deepEqual(dotPresetHealth([{ id: 'standard' }, { id: 'dot' }]), { ok: true })
  assert.deepEqual(dotPresetHealth([{ id: 'dot', broken: 'tool-web (@deepseek-ai/dsh-tool-web): waiting for web' }]),
    { ok: false, broken: 'tool-web (@deepseek-ai/dsh-tool-web): waiting for web' })
  assert.equal(dotPresetHealth([{ id: 'standard' }]).ok, false)
  // 网页工具开没开
  const rows = (/** @type {boolean} */ on) => [{ id: 'dot', rows: [{ entryId: 'tool-fs', enabled: true }, { entryId: 'tool-web', enabled: on }] }]
  assert.deepEqual(dotPresetHealth([{ id: 'dot' }], rows(true)), { ok: true, web: true })
  assert.deepEqual(dotPresetHealth([{ id: 'dot' }], rows(false)), { ok: true, web: false })
})

test('/status 带出预设的问题，查询在后台进行，不拖慢 /status', async () => {
  /** @type {Record<string, any>} */
  const routes = {}
  let calls = 0
  const services = {
    schedule: { async list() { return { items: [] } } },
    agentPresets: { async list() { calls++; return [{ id: 'dot', broken: 'tool-web: waiting for web' }] } },
  }
  const ctx = {
    webServer: { register: (/** @type {any} */ r) => { routes[r.path] = r.handler }, getOrigin: () => 'http://127.0.0.1:3999' },
    on() {},
    get: (/** @type {string} */ name) => /** @type {any} */ (services)[name],
  }
  await applyHost(ctx, { dataDir: await mkdtemp(join(tmpdir(), 'dsh-dot-preset-')), pet: true })
  const status = routes['/api/dsh-plugin-dot/status']
  const get = async () => {
    /** @type {any} */
    let out
    const req = { url: '/api/dsh-plugin-dot/status', method: 'GET', headers: { host: '127.0.0.1:3999', 'x-dot-client': '1' }, async *[Symbol.asyncIterator]() {} }
    await status(req, { setHeader() {}, end: (/** @type {string} */ b) => { out = JSON.parse(b) }, statusCode: 200 })
    return out
  }
  await get() // 第一次：后台开始查
  await new Promise(r => setTimeout(r, 10))
  const s = await get()
  assert.deepEqual(s.preset, { ok: false, broken: 'tool-web: waiting for web' })
  await get()
  assert.equal(calls, 1) // 一分钟内不重复查
})
