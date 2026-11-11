// v0.8 会话调度：回忆、读档、转告、派活、收纳、事务关联、上下文提醒。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hub } from '../lib/hub.js'
import { apply as applyHost } from '../lib/host.js'
import { apply as applyPreset } from '../lib/index.js'
import { getStore } from '../lib/store.js'
import { createSessionsTool, findStale, turnsFromEvents } from '../lib/sessions.js'
import { patrol } from '../lib/suggest.js'

beforeEach(() => hub.reset())

const DAY = 86_400_000

/** 一个假的 sessionQuery：两个用户会话 + 一个 Dot 会话 */
function fakeQuery(now = Date.now()) {
  const headers = [
    { id: 'u1', createdAt: now - 10 * DAY, cwd: 'E:/proj' },
    { id: 'u2', createdAt: now - 10 * DAY },
    { id: 'u3', createdAt: now - 10 * DAY },
    { id: 'u4', createdAt: now - 10 * DAY },
    { id: 'd1', createdAt: now - 10 * DAY, agentPreset: 'dot' },
    { id: 'c1', createdAt: now - 10 * DAY, parentSession: 'u1', origin: 'subagent', delegationDepth: 1 },
  ]
  const events = {
    u1: [
      { type: 'user/message', text: '把登录页改成深色', time: now - 9 * DAY },
      { type: 'assistant/message', text: '先看看样式', time: now - 9 * DAY },
      { type: 'assistant/message', text: '改好了，login.css 换成深色', time: now - 9 * DAY },
      { type: 'user/message', text: '再加个记住我', time: now - 1 * DAY },
      { type: 'turn/start', text: '', time: now - 1 * DAY },
    ],
  }
  return {
    async listSessions() { return headers.map(header => ({ header, live: false, persisted: true })) },
    async filterSessions(f) { const ids = f[0].values; return headers.filter(h => ids.includes(h.id)).map(header => ({ header })) },
    async readTitleSnapshots(ids) { return ids.map(id => ({ status: 'fulfilled', value: { title: { title: `标题-${id}` } } })) },
    async filterEvents(id, filters) {
      let list = events[id] ?? []
      for (const f of filters) {
        if (f.kind === 'type') list = list.filter(e => f.values.includes(e.type))
        if (f.kind === 'time') list = list.filter(e => e.time >= (f.from ?? 0))
      }
      return list
    },
    async searchSessions(req) {
      const items = headers.filter(h => h.id === 'u1' || h.id === 'd1')
        .map(header => ({ header, bestMatch: { snippet: `…${req.query}…`, time: now - 9 * DAY } }))
      return { items }
    },
  }
}

async function presetTool(query) {
  const tools = new Map()
  const ctx = {
    tools: { register: t => { tools.set(t.name, t) } }, systemPrompt: { section() {}, context() {} },
    on() {}, get: name => (name === 'sessionQuery' ? query : undefined), effect() {},
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-dot-v8-'))
  await applyPreset(ctx, { dataDir })
  return { tool: tools.get('dot_sessions'), dataDir }
}

test('turnsFromEvents：一问一答，取每轮最后一条回复，截断', () => {
  const turns = turnsFromEvents([
    { type: 'user/message', text: '问一', time: 1 },
    { type: 'assistant/message', text: '过程', time: 2 },
    { type: 'assistant/message', text: '结论一', time: 3 },
    { type: 'user/message', text: '问二', time: 4 },
    { type: 'user/message', text: 'x'.repeat(300), time: 5 },
  ], 2)
  assert.deepEqual(turns.map(t => [t.ask.slice(0, 2), t.reply]), [['问二', ''], ['xx', '']])
  assert.ok(turns[1].ask.endsWith('…'))
  assert.equal(turnsFromEvents([{ type: 'user/message', text: '问', time: 1 }, { type: 'assistant/message', text: '答', time: 2 }], 3)[0].reply, '答')
})

test('dot_sessions search / read：只看用户自己的会话', async () => {
  const { tool } = await presetTool(fakeQuery())
  hub.configure({ isDot: id => id === 'd1' })
  const s = await tool.execute({ action: 'search', query: '登录页' })
  assert.match(s.summary, /\[u1\] 「标题-u1」/)
  assert.doesNotMatch(s.summary, /d1/)
  const r = await tool.execute({ action: 'read', id: 'u1', turns: 2 })
  assert.match(r.summary, /用户：把登录页改成深色\n {2}回复：改好了，login\.css 换成深色/)
  assert.match(r.summary, /用户：再加个记住我\n {2}回复：（还没回复）/)
  await assert.rejects(tool.execute({ action: 'read', id: 'd1' }), /Dot 自己的会话或子代理/)
  await assert.rejects(tool.execute({ action: 'read', id: 'c1' }), /Dot 自己的会话或子代理/)
  await assert.rejects(tool.execute({ action: 'read', id: 'nope' }), /找不到会话/)
  hub.configure({ watchOthers: false })
  await assert.rejects(tool.execute({ action: 'read', id: 'u1' }), /watchOthers/)
})

test('dot_sessions relay / dispatch / archive 只起草，不执行', async () => {
  const { tool, dataDir } = await presetTool(fakeQuery())
  const r = await tool.execute({ action: 'relay', id: 'u1', text: '把图表也补上' })
  assert.match(r.summary, /还没有发出去/)
  const d = await tool.execute({ action: 'dispatch', title: '补测试', brief: '给 lib 补单元测试，全部通过为止', cwd: 'E:/proj' })
  assert.match(d.summary, /点「开始」/)
  await assert.rejects(tool.execute({ action: 'dispatch', title: 'x', brief: 'y', cwd: 'relative' }), /绝对路径/)
  const a = await tool.execute({ action: 'archive', ids: ['u2', 'u3'] })
  assert.match(a.summary, /收起来/)
  const store = getStore(join(dataDir, 'state.json'))
  await store.load()
  const kinds = store.snapshot().suggestions.map(s => [s.kind, s.options[0].action.type])
  assert.deepEqual(kinds, [['relay', 'relay'], ['dispatch', 'dispatch'], ['tidy', 'archive']])
  // 同样的转告不重复起草
  assert.match((await tool.execute({ action: 'relay', id: 'u1', text: '把图表也补上' })).summary, /已经在收件箱/)
})

test('findStale：三天没新一轮的旧会话，跳过 Dot、子代理、置顶、归档、盯着的', async () => {
  const now = Date.now()
  hub.configure({ isDot: id => id === 'd1' })
  hub.prewatch('u4', '盯着的')
  const registry = { archivedSessionIds: ['u3'], pinnedSessionIds: [], archiveSession() {} }
  const stale = await findStale({ query: fakeQuery(now), registry, now, isDot: id => hub.isDotSession(id) })
  // u1 昨天还有新一轮；u3 已归档；u4 盯着；d1 是 Dot；c1 是子代理
  assert.deepEqual(stale, [{ id: 'u2', title: '标题-u2' }])
})

test('patrol：关联会话跑完问要不要标完成；上下文快满；收纳凑满 3 个', () => {
  const now = new Date()
  const t = now.getTime()
  const state = {
    tasks: [{ id: 't1', title: '补测试', status: 'open', due: null, updatedAt: new Date(t - 3600_000).toISOString(), linkedSession: 's9' }],
    suggestions: [],
  }
  const others = [
    { id: 's9', title: '补测试会话', status: 'idle', result: 'done', endedAt: t - 60_000 },
    { id: 's8', title: '大重构', status: 'running', result: null, context: { used: 90_000, window: 100_000 } },
  ]
  const stale = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }]
  const { drafts, isStale } = patrol(state, { now, schedules: null, others, stale })
  const byKind = Object.fromEntries(drafts.map(d => [d.kind, d]))
  assert.equal(byKind.linked.options[0].action.type, 'complete')
  assert.match(byKind.context.title, /90%/)
  assert.deepEqual(byKind.tidy.options[0].action.ids, ['a', 'b', 'c'])
  // 今天没算收纳候选时，不收起已有的收纳建议
  assert.equal(patrol(state, { now, schedules: null, others, stale: null }).isStale({ source: 'patrol', key: byKind.tidy.key }), false)
  assert.equal(isStale({ source: 'patrol', key: 'context:gone' }), true)
  // 两个以下不提
  assert.equal(patrol(state, { now, schedules: null, others: [], stale: stale.slice(0, 2) }).drafts.some(d => d.kind === 'tidy'), false)
})

// ── Host：点了建议卡之后 ──────────────────────────────────
async function hostSetup(services) {
  const routes = {}
  const listeners = {}
  const ctx = {
    webServer: { register: r => { routes[r.path] = r.handler }, getOrigin: () => 'http://127.0.0.1:3999' },
    on: (event, fn) => { listeners[event] = fn },
    get: name => services[name],
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-dot-v8h-'))
  await applyHost(ctx, { dataDir })
  const store = getStore(join(dataDir, 'state.json'))
  return { routes, listeners, store, dataDir }
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
async function addCard(store, option) {
  await store.load()
  return store.mutate((state, newId) => {
    const s = { id: newId('s'), key: `k${Math.random()}`, kind: 'x', source: 'dot', title: 't', body: '', options: [option], status: 'open', createdAt: new Date().toISOString(), resolvedAt: null }
    state.suggestions.push(s)
    return s
  })
}

test('点「发送」：已加载的会话直接 followup，带「Dot 代你转告」；没加载的走定时服务', async () => {
  const created = []
  const sent = []
  const services = {
    agents: { get: id => (id === 'live1' ? { followup: m => sent.push(m) } : undefined), list: () => [] },
    schedule: { async create(req) { created.push(req); return { id: 'x', target: req.target } }, async list() { return { items: [] } } },
  }
  const { routes, store } = await hostSetup(services)
  const s1 = await addCard(store, { label: '发送', action: { type: 'relay', sessionId: 'live1', title: '写报告', text: '把图表补上' } })
  const r1 = await call(routes['/api/dsh-plugin-dot/suggestion'], { id: s1.id, option: 0 })
  assert.equal(r1.text, '已转告「写报告」')
  assert.match(JSON.stringify(sent[0]), /（Dot 代你转告）把图表补上/)
  const s2 = await addCard(store, { label: '发送', action: { type: 'relay', sessionId: 'cold1', title: '老会话', text: '继续' } })
  const r2 = await call(routes['/api/dsh-plugin-dot/suggestion'], { id: s2.id, option: 0 })
  assert.match(r2.text, /几秒后送到/)
  assert.deepEqual(created.at(-1).target, { kind: 'session', sessionId: 'cold1' })
  // 不能转告给 Dot 会话
  hub.rootStatus({ id: 'dotA', session: { id: 'dotA' } }, 'running')
  const s3 = await addCard(store, { label: '发送', action: { type: 'relay', sessionId: 'dotA', text: 'x' } })
  assert.equal((await call(routes['/api/dsh-plugin-dot/suggestion'], { id: s3.id, option: 0 })).ok, false)
})

test('点「开始」：新开会话、先盯上、记一件关联的已委派事务；会话跑起来后标题和盯着都在', async () => {
  const created = []
  const services = {
    agents: { get: () => undefined, list: () => [] },
    schedule: { async create(req) { created.push(req); return { id: 'sch', target: { kind: 'new_once', sessionId: 'session-new', create: req.target.create ?? {} } } }, async list() { return { items: [] } } },
  }
  const { routes, listeners, store } = await hostSetup(services)
  const s = await addCard(store, { label: '开始', action: { type: 'dispatch', title: '补测试', brief: '给 lib 补测试', cwd: 'E:/proj' } })
  const r = await call(routes['/api/dsh-plugin-dot/suggestion'], { id: s.id, option: 0 })
  assert.match(r.text, /Dot 盯着/)
  assert.deepEqual(created[0].target, { kind: 'new_once', create: { cwd: 'E:/proj' } })
  assert.match(created[0].prompt, /^给 lib 补测试\n\n（这是用户通过 Dot 派给你的任务/)
  assert.deepEqual(hub.watchedIds(), ['session-new'])
  await store.load()
  const task = store.snapshot().tasks.at(-1)
  assert.deepEqual([task.title, task.owner, task.linkedSession], ['已委派：补测试', 'delegated', 'session-new'])
  // 新会话跑起来：自动登记成「盯着」，标题先用派活时的名字
  listeners['agent/status']({ agent: { id: 'session-new', session: { id: 'session-new', preset: 'standard', header: { delegationDepth: 0 } } }, status: 'running' })
  const o = hub.other('session-new')
  assert.equal(o?.watched, true)
  assert.equal(o?.title, '补测试')
})

test('点「收起来」：逐个归档，正在跑的被 DSH 拒绝就跳过；留一张撤销卡，点了放回', async () => {
  const archived = new Set()
  const registry = {
    archivedSessionIds: [], pinnedSessionIds: [],
    async archiveSession(id) { if (id === 'busy') throw new Error('active'); archived.add(id) },
    async unarchiveSession(id) { archived.delete(id) },
  }
  const { routes, store } = await hostSetup({ workspaceRegistry: registry, agents: { get: () => undefined, list: () => [] } })
  const s = await addCard(store, { label: '收起来', action: { type: 'archive', ids: ['a', 'b', 'busy'] } })
  const r = await call(routes['/api/dsh-plugin-dot/suggestion'], { id: s.id, option: 0 })
  assert.equal(r.text, '收起了 2 个会话；1 个没收（可能正在跑）')
  assert.deepEqual([...archived], ['a', 'b'])
  await store.load()
  const undo = store.snapshot().suggestions.find(x => x.kind === 'undo' && x.status === 'open')
  assert.deepEqual(undo.options[0].action, { type: 'unarchive', ids: ['a', 'b'] })
  const u = await call(routes['/api/dsh-plugin-dot/suggestion'], { id: undo.id, option: 0 })
  assert.equal(u.text, '放回了 2 个会话')
  assert.equal(archived.size, 0)
})

test('总览里「记为事务」会关联会话；dot_tasks list 显示关联会话的现状', async () => {
  const { routes, listeners, store, dataDir } = await hostSetup({ agents: { get: () => undefined, list: () => [] } })
  listeners['agent/status']({ agent: { id: 'w1', session: { id: 'w1', preset: 'standard', header: { delegationDepth: 0 } } }, status: 'running' })
  await call(routes['/api/dsh-plugin-dot/session'], { id: 'w1', action: 'task' })
  await store.load()
  assert.equal(store.snapshot().tasks.at(-1).linkedSession, 'w1')

  const tools = new Map()
  const ctx = { tools: { register: t => { tools.set(t.name, t) } }, systemPrompt: { section() {}, context() {} }, on() {}, get: () => undefined, effect() {} }
  await applyPreset(ctx, { dataDir })
  const list = await tools.get('dot_tasks').execute({ action: 'list' })
  assert.match(list.summary, /关联会话：「.*」运行中/)
})

test('dot_sessions list：各会话一行现状', async () => {
  const tool = createSessionsTool({ actions: undefined, getQuery: () => undefined })
  assert.match((await tool.execute({ action: 'list' })).summary, /没有其他会话/)
  hub.otherStatus({ id: 'x1', session: { id: 'x1' } }, 'running', '跑数据')
  hub.otherTool('x1', 'bash')
  assert.match((await tool.execute({ action: 'list' })).summary, /\[x1\] 「跑数据」 · 运行中 · 正在：bash/)
})

test('实测回归：输出是内容块数组；全文索引没开时 search 退回逐个扫描', async () => {
  const q = fakeQuery()
  q.searchSessions = async () => { throw new Error('session index disabled (openAt: never)') }
  const inner = q.filterEvents
  q.filterEvents = async (id, filters) => {
    const text = filters.find(f => f.kind === 'text')?.text
    const list = await inner(id, filters.filter(f => f.kind !== 'text'))
    return text ? list.filter(e => e.text.includes(text)) : list
  }
  const { tool } = await presetTool(q)
  hub.configure({ isDot: id => id === 'd1' })
  const s = await tool.execute({ action: 'search', query: '登录页' })
  assert.match(s.summary, /\[u1\] 「标题-u1」.*把登录页改成深色/)
  assert.ok(Array.isArray(tool.output.render({}, s)))
})

test('总览接口：/sessions/search 搜所有会话；/session relay 直接送出、archive 直接归档（正在跑的不行）', async () => {
  const sent = []
  const archived = []
  const services = {
    sessionQuery: fakeQuery(),
    agents: { get: id => (id === 'w2' ? { followup: m => sent.push(m) } : undefined), list: () => [] },
    workspaceRegistry: { archivedSessionIds: [], pinnedSessionIds: [], async archiveSession(id) { archived.push(id) }, async unarchiveSession() {} },
  }
  const { routes, listeners } = await hostSetup(services)
  const s = await call(routes['/api/dsh-plugin-dot/sessions/search'], { query: '登录页' })
  assert.deepEqual(s.hits.map(h => [h.id, h.title]), [['u1', '标题-u1']])
  const ag = id => ({ id, session: { id, preset: 'standard', header: { delegationDepth: 0 } } })
  listeners['agent/status']({ agent: ag('w2'), status: 'running' })
  const r = await call(routes['/api/dsh-plugin-dot/session'], { id: 'w2', action: 'relay', text: '顺便跑一下测试' })
  assert.equal(r.text, '已转告「未命名会话」')
  assert.match(JSON.stringify(sent[0]), /（Dot 代你转告）顺便跑一下测试/)
  assert.equal((await call(routes['/api/dsh-plugin-dot/session'], { id: 'w2', action: 'relay', text: ' ' })).ok, false)
  assert.match((await call(routes['/api/dsh-plugin-dot/session'], { id: 'w2', action: 'archive' })).text, /正在跑/)
  listeners['agent/status']({ agent: ag('w2'), status: 'idle' })
  const a = await call(routes['/api/dsh-plugin-dot/session'], { id: 'w2', action: 'archive' })
  assert.match(a.text, /收起了 1 个会话，收件箱里可以撤销/)
  assert.deepEqual(archived, ['w2'])
})
