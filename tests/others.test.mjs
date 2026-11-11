import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hub, petStatus } from '../lib/hub.js'
import { apply } from '../lib/host.js'

const EMPTY = { version: 1, nextId: { m: 1, t: 1, r: 1 }, memories: [], tasks: [], rules: [], paused: null }

beforeEach(() => hub.reset())

/** 假的全局 Host ctx：记录监听器和路由。 */
async function setup() {
  const listeners = {}
  const routes = {}
  const live = new Map()
  const titles = new Map()
  const ctx = {
    webServer: { register: r => { routes[r.path] = r.handler }, getOrigin: () => 'http://127.0.0.1:3999' },
    on: (event, fn) => { listeners[event] = fn },
    get: name => ({
      agents: { get: id => live.get(id), list: () => [...live.values()] },
      agentPresets: { presetForSession: s => s.preset ?? 'standard' },
      sessionTitle: { get: s => (titles.has(s.id) ? { title: titles.get(s.id) } : undefined) },
    })[name],
  }
  await apply(ctx, { dataDir: await mkdtemp(join(tmpdir(), 'dsh-dot-others-')) })
  const agent = (id, preset, header = { delegationDepth: 0 }) => {
    const a = { id, session: { id, preset, header }, cancelled: null, cancel(c) { this.cancelled = c } }
    live.set(id, a)
    return a
  }
  return { listeners, routes, agent, titles }
}

/** 调用一个路由，返回 JSON。 */
async function call(handler, body) {
  const req = {
    method: 'POST', headers: { host: '127.0.0.1:3999', 'x-dot-client': '1', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  }
  let out
  const res = { setHeader() {}, end: b => { out = JSON.parse(b) }, statusCode: 200 }
  await handler(req, res)
  return { code: res.statusCode, ...out }
}

test('其他会话：跑起来登记、记工具和步数、结束后提醒；Dot 会话和子代理不算', async () => {
  const { listeners, agent, titles } = await setup()
  const w = agent('w1', 'standard')
  titles.set('w1', '重构登录模块')
  listeners['agent/status']({ agent: w, status: 'running' })
  await listeners['tools/pre-execute']({ agent: w, name: 'pwsh' }, async () => ({ kind: 'allow' }))
  let s = petStatus(EMPTY, new Date())
  assert.equal(s.others.length, 1)
  assert.equal(s.others[0].title, '重构登录模块')
  assert.equal(s.others[0].tool, '执行命令')
  assert.equal(s.others[0].steps, 1)
  assert.equal(s.counts.others, 1)

  // Dot 会话（按预设识别）和别的会话派出的子代理都不进列表
  listeners['agent/status']({ agent: agent('d1', 'dot'), status: 'running' })
  listeners['agent/status']({ agent: agent('n1', 'standard', { origin: 'subagent', delegationDepth: 1, parentSession: 'w1' }), status: 'running' })
  assert.deepEqual(petStatus(EMPTY, new Date()).others.map(o => o.id), ['w1'])

  // 跑够 15 秒才结束 → 气泡提醒
  hub.other('w1').startedAt -= 20_000
  listeners['agent/status']({ agent: w, status: 'idle' })
  s = petStatus(EMPTY, new Date())
  assert.equal(s.others[0].status, 'idle')
  assert.equal(s.others[0].result, 'done')
  assert.equal(s.bubble, '「重构登录模块」跑完了')
})

test('其他会话出错、被停止；只登记跑过的会话', async () => {
  const { listeners, routes, agent } = await setup()
  const quiet = agent('q1', 'standard')
  listeners['agent/status']({ agent: quiet, status: 'idle' })
  assert.equal(hub.others().length, 0)

  const w = agent('w2', 'standard')
  listeners['agent/status']({ agent: w, status: 'running' })
  listeners['agent/error']({ agent: w, error: new Error('x') })
  listeners['agent/status']({ agent: w, status: 'idle' })
  assert.equal(hub.other('w2').result, 'failed')
  assert.match(petStatus(EMPTY, new Date()).bubble, /出错停下了/)

  const w3 = agent('w3', 'standard')
  listeners['agent/status']({ agent: w3, status: 'running' })
  const r = await call(routes['/api/dsh-plugin-dot/session'], { id: 'w3', action: 'stop' })
  assert.equal(r.ok, true)
  assert.deepEqual(w3.cancelled, { kind: 'user' })
  listeners['agent/status']({ agent: w3, status: 'idle' })
  assert.equal(hub.other('w3').result, 'stopped')

  // 没登记过的会话不能从这里停
  const bad = await call(routes['/api/dsh-plugin-dot/session'], { id: 'q1', action: 'stop' })
  assert.equal(bad.code, 404)
})

test('任何会话等审批时进「待你决定」，审批结束就撤掉', async () => {
  const { listeners, agent, titles } = await setup()
  const w = agent('w4', 'standard')
  titles.set('w4', '部署脚本')
  listeners['agent/status']({ agent: w, status: 'running' })
  let release
  const answered = new Promise(r => { release = r })
  const pending = listeners['approval/request'](
    { agent: w, toolName: 'pwsh', reason: 'escalate sandbox', displayReason: { en: 'Run outside sandbox', zh: '要在沙箱外执行命令' } },
    () => answered,
  )
  let s = petStatus(EMPTY, new Date())
  assert.equal(s.mood, 'waiting')
  assert.deepEqual(s.decisions.map(d => [d.label, d.reason]), [['部署脚本', '要在沙箱外执行命令']])
  assert.equal(s.others[0].waiting, true)
  release('allowed-once')
  assert.equal(await pending, 'allowed-once')
  s = petStatus(EMPTY, new Date())
  assert.equal(s.decisions.length, 0)
})

test('watchOthers: false 时不跟踪其他会话', async () => {
  const listeners = {}
  const ctx = {
    webServer: { register() {}, getOrigin: () => 'http://127.0.0.1:1' },
    on: (event, fn) => { listeners[event] = fn },
    get: () => undefined,
  }
  await apply(ctx, { dataDir: await mkdtemp(join(tmpdir(), 'dsh-dot-others-')), watchOthers: false })
  listeners['agent/status']({ agent: { id: 'w9', session: { header: {} } }, status: 'running' })
  assert.equal(hub.others().length, 0)
})
