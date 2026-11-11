import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DotStore } from '../lib/store.js'
import { createActions, isDotSchedule } from '../lib/actions.js'
import { createCommandHandlers } from '../lib/commands.js'
import { hub, petStatus, summarize, taskIdFromName, STUCK_MS } from '../lib/hub.js'
import { apply } from '../lib/index.js'

const NOW = new Date(2026, 10, 10, 14, 20)

function fakeSchedule(items = []) {
  const edits = []
  return {
    items, edits,
    async create() { return { id: `schedule-${items.length + 1}` } },
    async edit(req) {
      edits.push(req)
      const it = items.find(x => x.id === req.id)
      if (it && req.action === 'update') it.status = req.patch.active ? 'active' : 'paused'
    },
    async list() { return { items } },
  }
}

async function setup(scheduleItems = []) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dot-v3-'))
  const store = new DotStore(join(dir, 'state.json'))
  const schedule = fakeSchedule(scheduleItems)
  const actions = createActions({ store, getSchedule: () => schedule, now: () => NOW })
  const handlers = createCommandHandlers({ actions, store, configRules: [], now: () => NOW, dotSessionIds: () => ['dot-1'] })
  return { dir, store, schedule, actions, handlers }
}

beforeEach(() => hub.reset())

test('子任务名字解析与结果摘要', () => {
  assert.equal(taskIdFromName('t3-pricing'), 't3')
  assert.equal(taskIdFromName('t12-pricing/check'), 't12')
  assert.equal(taskIdFromName('t3'), 't3')
  assert.equal(taskIdFromName('agent-1'), null)
  assert.equal(taskIdFromName('tea-time'), null)
  assert.equal(summarize([{ type: 'text', text: '结论：\n  A 最便宜' }, { type: 'image' }]), '结论： A 最便宜')
  assert.equal(summarize(undefined), '')
  assert.match(summarize([{ type: 'text', text: 'x'.repeat(300) }]), /…$/)
})

test('子任务生命周期：开始 → 工具 → 结束，挂到对应事务下', async () => {
  const { store, actions } = await setup()
  await actions.addTask({ title: '竞品定价调研', owner: 'delegated' })
  hub.rootStatus({ id: 'dot-1' }, 'running')
  hub.childStart({ id: 'c1', parentId: 'dot-1', rootId: 'dot-1', name: 't1-pricing' })
  hub.childTool('c1', 'web_fetch')
  hub.childToolEnd('c1')
  hub.childTool('c1', 'web_search')

  let s = petStatus(store.snapshot(), new Date())
  assert.equal(s.tasks[0].children.length, 1)
  const kid = s.tasks[0].children[0]
  assert.equal(kid.name, 't1-pricing')
  assert.equal(kid.status, 'running')
  assert.equal(kid.tool, '搜索网页')
  assert.equal(kid.steps, 1)
  assert.equal(s.counts.running, 1)

  hub.rootStatus({ id: 'dot-1' }, 'idle')
  s = petStatus(store.snapshot(), new Date())
  assert.equal(s.mood, 'busy')
  assert.match(s.bubble, /t1-pricing 正在搜索网页/)

  hub.childEnd({ id: 'c1', stopReason: 'completed', summary: 'A 最便宜' })
  s = petStatus(store.snapshot(), new Date())
  assert.equal(s.tasks[0].children[0].status, 'done')
  assert.equal(s.tasks[0].children[0].summary, 'A 最便宜')
  assert.equal(s.mood, 'done')
  assert.match(s.bubble, /t1-pricing 完成了，Dot 正在汇总/)
})

test('没按约定命名的子任务进「其他子任务」，失败和停止分别标记', async () => {
  const { store } = await setup()
  hub.childStart({ id: 'c1', name: 'agent-1' })
  hub.childStart({ id: 'c2', name: 't9-ghost' }) // t9 不存在
  hub.childEnd({ id: 'c1', stopReason: 'error' })
  hub.childEnd({ id: 'c2', stopReason: 'aborted' })
  const s = petStatus(store.snapshot(), new Date())
  assert.deepEqual(s.unlinked.map(k => [k.name, k.status]), [['agent-1', 'failed'], ['t9-ghost', 'stopped']])
})

test('子任务超过 5 分钟没动静：标记卡住并提醒', async () => {
  const { store } = await setup()
  hub.childStart({ id: 'c1', name: 'agent-1' })
  const later = new Date(Date.now() + STUCK_MS + 60_000)
  const s = petStatus(store.snapshot(), later)
  assert.equal(s.unlinked[0].stuck, true)
  assert.equal(s.mood, 'alert')
  assert.match(s.bubble, /agent-1 \d+ 分钟没动静/)
})

test('沿用 Dot 预设的子代理不会被当成 Dot 根会话', async () => {
  const { store } = await setup()
  hub.rootStatus({ id: 'c1' }, 'running') // 子代理的插件实例可能先上报
  hub.childStart({ id: 'c1', name: 't1-x' })
  assert.equal(hub.roots().length, 0)
  hub.rootStatus({ id: 'c1' }, 'running') // 登记为子代理后再上报也会被忽略
  assert.equal(hub.roots().length, 0)
  assert.equal(petStatus(store.snapshot(), new Date()).sessions.length, 0)
})

test('待你决定：登记、按会话清除、结束时撤销', async () => {
  const { store } = await setup()
  hub.childStart({ id: 'c1', name: 't1-x' })
  const e1 = {}, e2 = {}
  hub.addDecision(e1, { agentId: 'dot-1', label: 'Dot', tool: 'pwsh', reason: '执行命令前需要确认' })
  hub.addDecision(e2, { agentId: 'c1', label: 't1-x', tool: 'web_fetch', reason: '上网前先问我' })
  let s = petStatus(store.snapshot(), new Date())
  assert.equal(s.mood, 'waiting')
  assert.equal(s.bubble, '2 件事需要你确认')
  assert.deepEqual(s.decisions.map(d => d.label), ['Dot', 't1-x'])
  hub.childEnd({ id: 'c1', stopReason: 'completed' })
  s = petStatus(store.snapshot(), new Date())
  assert.equal(s.decisions.length, 1)
  hub.rootStatus({ id: 'dot-1' }, 'idle')
  assert.equal(petStatus(store.snapshot(), new Date()).decisions.length, 0)
})

test('识别属于 Dot 的定时任务', () => {
  const ids = new Set(['dot-1'])
  assert.ok(isDotSchedule({ title: 'Dot 提醒：交周报' }, ids))
  assert.ok(isDotSchedule({ title: '每日简报', target: { kind: 'new_once', create: { agentPreset: 'dot' } } }, ids))
  assert.ok(isDotSchedule({ title: '每日简报', target: { kind: 'session', sessionId: 'dot-1' } }, ids))
  assert.ok(isDotSchedule({ title: 'x', involvedSessionIds: ['dot-1'] }, ids))
  assert.ok(!isDotSchedule({ title: '部署检查', target: { kind: 'session', sessionId: 'other' }, involvedSessionIds: ['other'] }, ids))
})

test('/pause 暂停 Dot 的定时任务，/resume 只恢复被暂停的那些', async () => {
  const items = [
    { id: 's1', title: 'Dot 提醒：交周报', status: 'active', scheduledAt: '2026-11-11T01:00:00.000Z' },
    { id: 's2', title: '每日简报', status: 'active', target: { kind: 'session', sessionId: 'dot-1' } },
    { id: 's3', title: 'Dot 提醒：早就暂停的', status: 'paused' },
    { id: 's4', title: '别人的部署检查', status: 'active', target: { kind: 'session', sessionId: 'other' } },
  ]
  const { handlers, store, schedule } = await setup(items)
  const r = await handlers.pause.run('', { id: 'dot-1' })
  assert.match(r.text, /暂停了 2 个定时任务/)
  assert.deepEqual(store.snapshot().paused.scheduleIds, ['s1', 's2'])
  assert.equal(items.find(x => x.id === 's4').status, 'active')
  assert.match((await handlers.pause.run('', null)).text, /已经在暂停/)
  assert.equal(petStatus(store.snapshot(), new Date()).mood, 'paused')

  const back = await handlers.resume.run('', null)
  assert.match(back.text, /恢复了 2 个定时任务/)
  assert.equal(items.find(x => x.id === 's3').status, 'paused') // 原本就暂停的保持不变
  assert.equal(store.snapshot().paused, null)
  assert.equal(schedule.edits.length, 4)
  assert.match((await handlers.resume.run('', null)).text, /没有在暂停/)
})

test('/tasks 列出子任务', async () => {
  const { handlers } = await setup()
  await handlers.task.run('竞品定价调研 @委派', null)
  hub.childStart({ id: 'c1', name: 't1-pricing' })
  hub.childTool('c1', 'web_fetch')
  const r = await handlers.tasks.run('', null)
  assert.match(r.text, /t1.*竞品定价调研/)
  assert.match(r.text, /└ t1-pricing 运行中 · 正在阅读网页 · 0 步/)
})

// ── 预设插件的接线（用假的 Cordis ctx） ──────────────────────────
function fakeCtx({ subagents, agents } = {}) {
  const listeners = {}
  const services = { subagents, agents }
  return {
    tools: { register() {} },
    systemPrompt: { section() {}, context() {} },
    on: (event, fn) => { listeners[event] = fn },
    get: name => services[name],
    effect() {},
    listeners,
  }
}

test('预设插件：子代理开始/结束事件进入状态中枢', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dot-v3-'))
  const childAgent = { id: 'c1' }
  const rootAgent = { id: 'dot-1' }
  const ctx = fakeCtx({
    agents: { get: id => (id === 'c1' ? childAgent : undefined) },
    subagents: {
      namesOf: a => (a === childAgent ? { self: 't1-pricing', parent: 'lead' } : { self: 'lead' }),
      rootOf: a => (a === childAgent ? rootAgent : a),
    },
  })
  await apply(ctx, { dataDir: dir })
  ctx.listeners['subagent/start']({ id: 'c1', parentSessionId: 'dot-1', provider: 'spawn', local: true })
  assert.equal(hub.child('c1').name, 't1-pricing')
  assert.equal(hub.child('c1').taskId, 't1')
  assert.equal(hub.child('c1').rootId, 'dot-1')

  // 子代理自己的状态事件不当成 Dot 根会话
  ctx.listeners['agent/status']({ agent: childAgent, status: 'running' })
  ctx.listeners['agent/status']({ agent: rootAgent, status: 'running' })
  assert.deepEqual(hub.roots().map(r => r.id), ['dot-1'])

  ctx.listeners['subagent/end']({ id: 'c1', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '做完了' }] })
  assert.equal(hub.child('c1').status, 'done')
  assert.equal(hub.child('c1').summary, '做完了')
})

test('预设插件：需要确认的调用进入「待你决定」，暂停时拒绝有副作用的调用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dot-v3-'))
  const ctx = fakeCtx({ subagents: { rootOf: a => a } })
  await apply(ctx, { dataDir: dir, rules: [{ tool: 'pwsh', decision: 'ask', note: '执行命令前问我' }] })
  const gate = ctx.listeners['tools/pre-execute']
  const agent = { id: 'dot-1' }

  const exec = { name: 'pwsh', arguments: {}, agent }
  assert.equal((await gate(exec, async () => ({ kind: 'allow' }))).kind, 'ask')
  assert.equal(hub.decisions().length, 1)
  assert.match(hub.decisions()[0].reason, /需要你确认/)
  ctx.listeners['tools/result'](exec)
  assert.equal(hub.decisions().length, 0)

  const ask = { name: 'ask_user_question', arguments: { question: '要订哪家酒店？' }, agent }
  await gate(ask, async () => ({ kind: 'allow' }))
  assert.equal(hub.decisions()[0].reason, '要订哪家酒店？')
  ctx.listeners['tools/result'](ask)

  // 暂停
  const { DotStore: S } = await import('../lib/store.js')
  const { getStore } = await import('../lib/store.js')
  const store = getStore(join(dir, 'state.json'))
  await store.mutate(s => { s.paused = { at: 'x', scheduleIds: [] } })
  assert.equal((await gate({ name: 'web_fetch', arguments: {}, agent }, async () => ({ kind: 'allow' }))).kind, 'deny')
  assert.equal((await gate({ name: 'dot_tasks', arguments: { action: 'list' }, agent }, async () => ({ kind: 'allow' }))).kind, 'allow')
  assert.equal((await gate({ name: 'dot_tasks', arguments: { action: 'add' }, agent }, async () => ({ kind: 'allow' }))).kind, 'deny')
  assert.ok(S)
})

test('暂停期间新建的提醒也被暂停，恢复时一起恢复', async () => {
  const items = []
  const { handlers, store, schedule } = await setup(items)
  schedule.create = async () => { const it = { id: `s${items.length + 1}`, title: 'Dot 提醒：x', status: 'active' }; items.push(it); return it }
  await handlers.pause.run('', { id: 'dot-1' })
  await handlers.task.run('明天9点 体检', { id: 'dot-1' })
  assert.equal(items[0].status, 'paused')
  assert.deepEqual(store.snapshot().paused.scheduleIds, ['s1'])
  await handlers.resume.run('', null)
  assert.equal(items[0].status, 'active')
})

// 回归：真实的 rootOf 只认 ctx.agents 里的那个对象，事件里带的 agent 会让它抛 UNAUTHORIZED。
// v0.3a 把“抛错”当成“是子代理”，Dot 根会话因此从不登记，浮标再也不显示忙碌。
test('rootOf 抛错时，Dot 根会话照样登记为根，并上报正在用的工具', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dot-v3-'))
  const unauthorized = () => { throw new Error('subagent tree access requires the exact live caller') }
  const ctx = fakeCtx({ subagents: { rootOf: unauthorized, namesOf: unauthorized } })
  await apply(ctx, { dataDir: dir })
  const root = { id: 'dot-9', session: { header: { delegationDepth: 0 } } }
  ctx.listeners['agent/status']({ agent: root, status: 'running' })
  assert.deepEqual(hub.roots().map(r => r.id), ['dot-9'])
  const s = petStatus({ version: 1, nextId: { m: 1, t: 1, r: 1 }, memories: [], tasks: [], rules: [], paused: null }, new Date())
  assert.equal(s.mood, 'busy')

  // 子代理（会话头标了委派）仍然不算根
  ctx.listeners['agent/status']({ agent: { id: 'kid', session: { header: { origin: 'subagent', delegationDepth: 1 } } }, status: 'running' })
  assert.deepEqual(hub.roots().map(r => r.id), ['dot-9'])
})

test('isDelegatedAgent 只看会话头和已登记的子任务', async () => {
  const { isDelegatedAgent } = await import('../lib/hub.js')
  assert.equal(isDelegatedAgent({ id: 'a', session: { header: { delegationDepth: 0 } } }), false)
  assert.equal(isDelegatedAgent({ id: 'a' }), false)
  assert.equal(isDelegatedAgent({ id: 'a', session: { header: { delegationDepth: 2 } } }), true)
  assert.equal(isDelegatedAgent({ id: 'a', session: { header: { origin: 'subagent' } } }), true)
  assert.equal(isDelegatedAgent({ id: 'a' }, id => id === 'a'), true)
})

// 回归：DSH 0.2.2 的 subagent/start 只有 { runId, provider, id, local }，没有父会话，子代理此时也可能还不在 ctx.agents 里。
test('子任务开始时解析不全，后续从会话头补上名字和父会话；停止要带父会话 id', async () => {
  const { resolveChild } = await import('../lib/hub.js')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dot-v3-'))
  const live = new Map()
  const agents = { get: id => live.get(id) }
  const subagents = { namesOf: a => (a.id === 'k1' ? { self: 't3-phones', parent: 'lead' } : { self: 'lead' }), rootOf: () => { throw new Error('UNAUTHORIZED') } }
  const ctx = fakeCtx({ agents, subagents })
  await apply(ctx, { dataDir: dir })
  ctx.listeners['subagent/start']({ runId: 'r1', provider: 'spawn', id: 'k1', local: true })
  assert.equal(hub.child('k1').name, 'k1') // 还解析不出来
  assert.equal(hub.childIncomplete('k1'), true)

  live.set('dot-1', { id: 'dot-1', session: { header: { delegationDepth: 0 } } })
  live.set('k1', { id: 'k1', session: { header: { origin: 'subagent', delegationDepth: 1, parentSession: 'dot-1' } } })
  hub.childUpdate('k1', resolveChild(agents, subagents, 'k1'))
  assert.equal(hub.child('k1').name, 't3-phones')
  assert.equal(hub.child('k1').taskId, 't3')
  assert.equal(hub.child('k1').parentId, 'dot-1')
  assert.equal(hub.child('k1').rootId, 'dot-1')
  assert.equal(hub.childIncomplete('k1'), false)

  // 重启（再次 start 且名字仍解析不出）不会把已解析的名字冲掉
  hub.childStart({ id: 'k1', name: 'k1' })
  assert.equal(hub.child('k1').name, 't3-phones')
})

test('被停止的子任务：Dot 自己 send_message 续上会被拦，用户补一句后放行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dot-v3-'))
  const ctx = fakeCtx({ subagents: { rootOf: a => a } })
  await apply(ctx, { dataDir: dir })
  hub.childStart({ id: 'k2', name: 't5-headphones', parentId: 'dot-1', rootId: 'dot-1' })
  hub.childEnd({ id: 'k2', stopReason: 'aborted' })
  const root = { id: 'dot-1', session: { header: { delegationDepth: 0 } } }
  const gate = ctx.listeners['tools/pre-execute']
  const allow = async () => ({ kind: 'allow' })
  for (const ref of ['k2', 't5-headphones', 'lead/t5-headphones']) {
    const r = await gate({ name: 'send_message', agent: root, arguments: { agent_id: ref, message: '继续' } }, allow)
    assert.equal(r.kind, 'deny', ref)
    assert.match(r.reason, /已被停止/)
  }
  hub.childRelease('k2')
  assert.equal((await gate({ name: 'send_message', agent: root, arguments: { agent_id: 'k2', message: '继续' } }, allow)).kind, 'allow')
})
