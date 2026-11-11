// 会话总览：其他会话的工作详情、让 Dot 盯着、重启后补回。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hub, petStatus, describeArgs } from '../lib/hub.js'
import { apply } from '../lib/host.js'

const EMPTY = { version: 1, nextId: { m: 1, t: 1, r: 1 }, memories: [], tasks: [], rules: [], paused: null }

beforeEach(() => hub.reset())

async function setup(extra = {}) {
  const listeners = {}
  const routes = {}
  const live = new Map()
  const titles = new Map()
  const services = {
    agents: { get: id => live.get(id), list: () => [...live.values()] },
    agentPresets: { presetForSession: s => s.preset ?? 'standard' },
    sessionTitle: { get: s => (titles.has(s.id) ? { title: titles.get(s.id) } : undefined) },
    ...extra,
  }
  const ctx = {
    webServer: { register: r => { routes[r.path] = r.handler }, getOrigin: () => 'http://127.0.0.1:3999' },
    on: (event, fn) => { listeners[event] = fn },
    get: name => services[name],
  }
  await apply(ctx, { dataDir: await mkdtemp(join(tmpdir(), 'dsh-dot-sessions-')) })
  const agent = (id, preset = 'standard', header = { delegationDepth: 0 }) => {
    const a = { id, session: { id, preset, header }, cancel() {} }
    live.set(id, a)
    return a
  }
  return { listeners, routes, agent, titles }
}

async function call(handler, body) {
  const req = {
    method: body ? 'POST' : 'GET',
    headers: { host: '127.0.0.1:3999', 'x-dot-client': '1', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) },
  }
  let out
  const res = { setHeader() {}, end: b => { out = JSON.parse(b) }, statusCode: 200 }
  await handler(req, res)
  return { code: res.statusCode, ...out }
}

/** 模拟一次工具调用：开始 → 结束。 */
async function tool(listeners, agent, name, args, ok = true) {
  await listeners['tools/pre-execute']({ agent, name, arguments: args }, async () => ({ kind: 'allow' }))
  listeners['tools/result']({ agent, name, arguments: args }, { isError: !ok, content: [] })
}

test('参数摘要：命令、路径、搜索词', () => {
  assert.equal(describeArgs('pwsh', { command: 'npm   test' }), 'npm test')
  assert.equal(describeArgs('fs_read', { path: 'src/a.ts' }), 'src/a.ts')
  assert.equal(describeArgs('web_search', { query: 'dsh plugin' }), 'dsh plugin')
  assert.equal(describeArgs('todo_write', { todos: [] }), '')
  assert.equal(describeArgs('todo_write', { todos: [{ content: 'a', status: 'completed' }, { content: '数文件', status: 'in_progress' }] }), '待办 1/2，正在：数文件')
  assert.ok(describeArgs('pwsh', { command: 'x'.repeat(200) }).endsWith('…'))
})

test('其他会话的详情：待办进度、最近步骤、改过的文件、最后一句回复', async () => {
  const { listeners, routes, agent, titles } = await setup()
  const w = agent('w1')
  titles.set('w1', '重构登录')
  listeners['agent/status']({ agent: w, status: 'running' })
  await tool(listeners, w, 'todo_write', { todos: [
    { content: '读代码', status: 'completed' },
    { content: '写测试', status: 'in_progress' },
    { content: '改实现', status: 'pending' },
  ] })
  await tool(listeners, w, 'fs_edit', { path: 'src/login.ts' })
  await tool(listeners, w, 'pwsh', { command: 'npm test' }, false)
  listeners['agent/assistant-stream']({ agent: w, frame: { type: 'chunk', chunk: { type: 'block-end', block: { type: 'text', text: '测试还有 2 个没过' } } } })
  // 推理块不算回复
  listeners['agent/assistant-stream']({ agent: w, frame: { type: 'chunk', chunk: { type: 'block-end', block: { type: 'reasoning', text: '想一想' } } } })

  const r = await call(routes['/api/dsh-plugin-dot/sessions'])
  assert.equal(r.sessions.length, 1)
  const s = r.sessions[0]
  assert.equal(s.title, '重构登录')
  assert.equal(s.todoDone, 1)
  assert.equal(s.todoTotal, 3)
  assert.equal(s.current, '写测试')
  assert.deepEqual(s.files, ['src/login.ts'])
  assert.deepEqual(s.steps.map(x => [x.name, x.ok]), [['pwsh', false], ['fs_edit', true], ['todo_write', true]])
  assert.equal(s.steps[0].detail, 'npm test')
  assert.equal(s.lastText, '测试还有 2 个没过')
})

test('嵌套子调用不算步骤；没登记的会话不记详情', async () => {
  const { listeners, routes, agent } = await setup()
  const w = agent('w2')
  listeners['agent/status']({ agent: w, status: 'running' })
  await listeners['tools/pre-execute']({ agent: w, name: 'pwsh', arguments: {}, parent: 'tok' }, async () => ({ kind: 'allow' }))
  await tool(listeners, agent('stranger'), 'pwsh', { command: 'ls' })
  const r = await call(routes['/api/dsh-plugin-dot/sessions'])
  assert.deepEqual(r.sessions.map(x => [x.id, x.steps.length]), [['w2', 0]])
})

test('会话在问你问题时进「待你决定」，回答后撤掉', async () => {
  const { listeners, agent, titles } = await setup()
  const w = agent('w3')
  titles.set('w3', '选型')
  listeners['agent/status']({ agent: w, status: 'running' })
  await listeners['tools/pre-execute']({ agent: w, name: 'ask_user', arguments: { question: '用 A 还是 B？' } }, async () => ({ kind: 'allow' }))
  let s = petStatus(EMPTY, new Date())
  assert.equal(s.mood, 'waiting')
  assert.deepEqual(s.decisions.map(d => [d.label, d.kind, d.reason]), [['选型', 'question', '在问你：用 A 还是 B？']])
  listeners['tools/result']({ agent: w, name: 'ask_user' }, { isError: false, content: [] })
  s = petStatus(EMPTY, new Date())
  assert.equal(s.decisions.length, 0)
})

test('让 Dot 盯着：结束时进通知，出错带错误原因；可以确认掉', async () => {
  const { listeners, routes, agent, titles } = await setup()
  const w = agent('w4')
  titles.set('w4', '跑数据')
  listeners['agent/status']({ agent: w, status: 'running' })
  const r = await call(routes['/api/dsh-plugin-dot/session'], { id: 'w4', action: 'watch' })
  assert.match(r.text, /盯着「跑数据」/)
  listeners['agent/assistant-stream']({ agent: w, frame: { type: 'chunk', chunk: { type: 'block-end', block: { type: 'text', text: '导出完成，共 120 行' } } } })
  listeners['agent/status']({ agent: w, status: 'idle' })
  let s = petStatus(EMPTY, new Date())
  assert.deepEqual(s.notices.map(n => [n.kind, n.title, n.open]), [['done', '跑数据', 'w4']])
  assert.match(s.notices[0].text, /^不到 1 分钟 · \d+ 步。导出完成，共 120 行$/)

  const w5 = agent('w5')
  listeners['agent/status']({ agent: w5, status: 'running' })
  await call(routes['/api/dsh-plugin-dot/session'], { id: 'w5', action: 'watch' })
  listeners['agent/error']({ agent: w5, error: new Error('额度不足') })
  listeners['agent/status']({ agent: w5, status: 'idle' })
  s = petStatus(EMPTY, new Date())
  assert.equal(s.notices[1].kind, 'failed')
  assert.match(s.notices[1].text, /。额度不足$/)

  // 没盯着的会话结束不进通知
  const w6 = agent('w6')
  listeners['agent/status']({ agent: w6, status: 'running' })
  listeners['agent/status']({ agent: w6, status: 'idle' })
  assert.equal(petStatus(EMPTY, new Date()).notices.length, 2)

  assert.equal((await call(routes['/api/dsh-plugin-dot/notice'], { id: s.notices[0].id })).ok, true)
  assert.equal(petStatus(EMPTY, new Date()).notices.length, 1)
  await call(routes['/api/dsh-plugin-dot/notice'], { id: 'all' })
  assert.equal(petStatus(EMPTY, new Date()).notices.length, 0)
})

test('记为事务：Dot 的事务清单里多一条跟进项', async () => {
  const { listeners, routes, agent, titles } = await setup()
  const w = agent('w7')
  titles.set('w7', '写周报')
  listeners['agent/status']({ agent: w, status: 'running' })
  const r = await call(routes['/api/dsh-plugin-dot/session'], { id: 'w7', action: 'task' })
  assert.equal(r.ok, true)
  assert.match(r.text, /跟进「写周报」/)
})

test('运行中的会话带上后台任务和目标', async () => {
  const jobs = { list: id => [
    { id: 'j1', kind: 'bash', label: 'npm run dev', owner: id, status: 'running' },
    { id: 'j2', kind: 'bash', label: '别人的', owner: 'zz', status: 'running' },
    { id: 'j3', kind: 'bash', label: '跑完了', owner: id, status: 'completed' },
  ] }
  const goals = { get: () => ({ objective: '所有测试通过', phase: 'active' }) }
  const { listeners, routes, agent } = await setup({ jobs, goals })
  listeners['agent/status']({ agent: agent('w8'), status: 'running' })
  const s = (await call(routes['/api/dsh-plugin-dot/sessions'])).sessions[0]
  assert.deepEqual(s.jobs.map(j => j.label), ['npm run dev'])
  assert.deepEqual(s.goal, { objective: '所有测试通过', phase: 'active' })
})

test('状态里带上会话记录中的 Dot 会话：提醒开的会话排在后面', async () => {
  const sessionQuery = {
    listSessions: async () => [
      { header: { id: 'main', createdAt: 1, agentPreset: 'dot' } },
      { header: { id: 'remind', createdAt: 9, agentPreset: 'dot' } },
      { header: { id: 'plain', createdAt: 5 } },
    ],
    readTitleSnapshots: async ids => ids.map(id => ({ status: 'fulfilled', value: { title: { title: id === 'remind' ? 'Dot 提醒：交周报' : 'Dot 总管' } } })),
  }
  const { routes } = await setup({ sessionQuery })
  const r = await call(routes['/api/dsh-plugin-dot/status'])
  assert.deepEqual(r.dotSessions, ['main', 'remind'])
  assert.equal(r.hasDotSession, true)
})

test('重启后从会话记录补回最近 24 小时的顶层会话，跳过子代理、Dot 和太旧的', async () => {
  const now = Date.now()
  const sessionQuery = {
    listSessions: async () => [
      { header: { id: 'a', createdAt: now - 3_600_000 } },
      { header: { id: 'sub', createdAt: now, parentSession: 'a', origin: 'subagent' } },
      { header: { id: 'dot', createdAt: now, agentPreset: 'dot' } },
      { header: { id: 'old', createdAt: now - 3 * 86_400_000 } },
    ],
    readTitleSnapshots: async ids => ids.map(id => ({ status: 'fulfilled', value: { title: { title: `标题 ${id}` } } })),
  }
  const { routes } = await setup({ sessionQuery })
  const r = await call(routes['/api/dsh-plugin-dot/sessions'])
  assert.deepEqual(r.sessions.map(s => [s.id, s.title, s.restored, s.status]), [['a', '标题 a', true, 'idle']])
  // 只补一次
  await call(routes['/api/dsh-plugin-dot/sessions'])
  assert.equal(hub.others().length, 1)
})

test('巡检经 /status 产出建议；采纳执行动作，忽略后不再提', async () => {
  const created = []
  const schedule = {
    async create(req) { created.push(req); return { id: `sch-${created.length}` } },
    async edit() {},
    async list() { return { items: [] } },
  }
  const { routes } = await setup({ schedule })
  await call(routes['/api/dsh-plugin-dot/say'], { text: '/task 交周报' })
  let s = await call(routes['/api/dsh-plugin-dot/status'])
  const brief = s.suggestions.find(g => g.kind === 'brief')
  assert.ok(brief)
  assert.equal(brief.options[0].hint, '建一个每天 09:00 的简报')
  const r = await call(routes['/api/dsh-plugin-dot/suggestion'], { id: brief.id, option: 0 })
  assert.equal(r.ok, true)
  assert.match(r.text, /每天 09:00/)
  assert.equal(created.at(-1).timing.kind, 'daily')
  s = await call(routes['/api/dsh-plugin-dot/status'])
  assert.equal(s.suggestions.length, 0)
  const again = await call(routes['/api/dsh-plugin-dot/suggestion'], { id: brief.id, option: 0 })
  assert.equal(again.ok, false)
})
