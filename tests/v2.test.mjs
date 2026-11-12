import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DotStore } from '../lib/store.js'
import { createActions } from '../lib/actions.js'
import { createTools } from '../lib/tools.js'
import { cleanTitle, createCommandHandlers, parseTaskInput } from '../lib/commands.js'
import { hub, petStatus, toolLabel } from '../lib/hub.js'
import { checkRequest, hostAllowed } from '../lib/host.js'

// 2026-11-10（周二）14:20 本地时间
const NOW = new Date(2026, 10, 10, 14, 20)

function fakeSchedule() {
  const created = []
  const deleted = []
  return {
    created, deleted,
    async create(req, actor) { created.push({ req, actor }); return { id: `schedule-${created.length}` } },
    async edit(req) { deleted.push(req.id) },
  }
}

async function setup({ withSchedule = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dot-v2-'))
  const store = new DotStore(join(dir, 'state.json'))
  const schedule = fakeSchedule()
  const actions = createActions({ store, getSchedule: () => (withSchedule ? schedule : undefined), now: () => NOW })
  const handlers = createCommandHandlers({ actions, store, configRules: [], now: () => NOW })
  const tools = Object.fromEntries(createTools(store, { maxMemories: 100, timeZone: undefined, now: () => NOW }, [], actions).map(t => [t.name, t]))
  const followups = []
  const agent = { id: 'session-1', status: 'idle', followup: m => followups.push(m) }
  const run = (cmd, input = '') => handlers[cmd].run(input, agent)
  return { store, schedule, actions, handlers, tools, agent, followups, run }
}

beforeEach(() => hub.reset())

test('/task 解析修饰符与清理标题', () => {
  assert.deepEqual(parseTaskInput('周五 交周报 !高 @dot'), { rest: '周五 交周报', priority: 'high', owner: 'dot' })
  assert.deepEqual(parseTaskInput('买菜 ！低'), { rest: '买菜', priority: 'low', owner: 'user' })
  assert.equal(cleanTitle('前 发报价单给老王'), '发报价单给老王')
  assert.equal(cleanTitle('提醒我开会'), '开会')
  assert.equal(cleanTitle('之前，记得交房租'), '交房租')
})

test('/task 带时间：记事务 + 建提醒，提醒投递到当前会话', async () => {
  const { run, schedule, store } = await setup()
  const r = await run('task', '周五18点前 交周报 !高')
  assert.equal(r.kind, 'success')
  assert.match(r.text, /t1.*\[高\].*交周报/)
  assert.match(r.text, /到点提醒你/)
  assert.equal(schedule.created.length, 1)
  const req = schedule.created[0].req
  assert.equal(req.timing.kind, 'at')
  assert.equal(new Date(req.timing.at).getTime(), new Date(2026, 10, 13, 18, 0).getTime())
  assert.deepEqual(req.target, { kind: 'session', sessionId: 'session-1' })
  assert.equal(store.snapshot().tasks[0].reminderId, 'schedule-1')
})

test('/task 不带时间：只记事务', async () => {
  const { run, schedule } = await setup()
  const r = await run('task', '想想年终总结怎么写')
  assert.match(r.text, /想想年终总结怎么写/)
  assert.equal(schedule.created.length, 0)
})

test('/task 没有定时服务：事务照记，并提示', async () => {
  const { run } = await setup({ withSchedule: false })
  const r = await run('task', '明天9点 交周报')
  assert.equal(r.kind, 'success')
  assert.match(r.text, /没有定时服务/)
})

test('/task 用法错误', async () => {
  const { run } = await setup()
  assert.equal((await run('task', '')).kind, 'error')
  assert.equal((await run('task', '明天9点')).kind, 'error')
})

test('/done 完成事务并删除提醒，浮标显示完成', async () => {
  const { run, schedule } = await setup()
  await run('task', '明天9点 交周报')
  await run('task', '买牛奶')
  const r = await run('done', 'T1 t9')
  assert.match(r.text, /✓ t1 交周报/)
  assert.match(r.text, /没找到：t9/)
  assert.deepEqual(schedule.deleted, ['schedule-1'])
  const pet = petStatus((await setup()).store.snapshot(), NOW)
  assert.equal(pet.mood, 'done')
  assert.match(pet.bubble, /交周报/)
})

test('/remind：有时间就记成待办并到点提醒；没写时间也照记，放进今天、不打扰、不交给模型', async () => {
  const { run, schedule, followups, store } = await setup()
  const ok = await run('remind', '30分钟后 喝水')
  assert.match(ok.text, /提醒你：喝水/)
  assert.equal(schedule.created.length, 1)
  assert.equal(store.snapshot().tasks[0].title, '喝水') // 提醒就是带时间的待办，能在清单里勾掉
  const plain = await run('remind', '精细化插件使用')
  assert.equal(plain.kind, 'success')
  assert.match(plain.text, /记进今天的待办了：精细化插件使用/)
  assert.match(plain.text, /\/due t2 1小时后/)
  assert.equal(schedule.created.length, 1) // 没写时间：不建提醒
  assert.equal(followups.length, 0) // 也不交给模型去猜
  const t2 = store.snapshot().tasks.find(t => t.id === 't2')
  assert.equal(t2?.due, null)
  assert.ok(t2?.today)
})

test('/remind 没有会话时新开 Dot 会话投递；看不懂的时间也不报错，先记下', async () => {
  const { handlers, schedule } = await setup()
  const r = await handlers.remind.run('明早8点 跑步', undefined)
  assert.equal(r.kind, 'success')
  assert.deepEqual(schedule.created[0].req.target, { kind: 'new_once', create: { agentPreset: 'dot' } })
  const later = await handlers.remind.run('改天吧', undefined)
  assert.equal(later.kind, 'success')
  assert.match(later.text, /记进今天的待办了：改天吧/)
})

test('/note /tasks /rules /dot /brief', async () => {
  const { run, followups } = await setup()
  assert.match((await run('note', '我不吃辣')).text, /已记住/)
  assert.match((await run('note', '我不吃辣')).text, /已经记得/)
  assert.match((await run('tasks')).text, /清单是空的/)
  await run('task', '昨天的事 2026-11-01')
  assert.match((await run('tasks')).text, /已逾期/)
  assert.match((await run('rules')).text, /还没有加规则/)
  const card = await run('dot')
  assert.match(card.text, /\/task/)
  assert.match(card.text, /逾期 1/)
  const brief = await run('brief')
  assert.match(brief.text, /已逾期（1）/)
  const ai = await run('brief', 'ai')
  assert.match(ai.text, /整理简报/)
  assert.equal(followups.length, 1)
})

test('dot_capture：一次落地事务、提醒、记忆', async () => {
  const { tools, schedule, store } = await setup()
  const r = await tools.dot_capture.execute({
    tasks: [{ title: '把报价单发给老王', due: '2026-11-13T18:00:00+08:00', priority: 'high' }, { title: '想年终总结' }],
    reminders: [{ text: '喝水', at: new Date(NOW.getTime() + 40 * 60_000).toISOString() }], // 相对 NOW，和机器时区无关
    memories: [{ text: '用户不吃辣', category: 'preference' }],
  }, { agent: { id: 'session-9' } })
  assert.match(r.summary, /把报价单发给老王/)
  assert.match(r.summary, /已设提醒/)
  assert.match(r.summary, /已记住/)
  assert.equal(store.snapshot().tasks.length, 2)
  assert.equal(store.snapshot().memories.length, 1)
  assert.equal(schedule.created.length, 2) // 一个跟着事务，一个单纯提醒
  assert.equal(schedule.created[0].req.target.sessionId, 'session-9')
})

test('dot_capture：单项失败不影响其他项', async () => {
  const { tools } = await setup()
  const r = await tools.dot_capture.execute({
    tasks: [{ title: '   ' }, { title: '正常的事' }],
    reminders: [{ text: '过去的提醒', at: '2020-01-01T00:00:00Z' }],
  }, {})
  assert.match(r.summary, /✗ 事务/)
  assert.match(r.summary, /已记下.*正常的事/)
  assert.match(r.summary, /✗ 提醒「过去的提醒」/)
})

test('dot_tasks：改截止时间会重设提醒，完成会删除提醒', async () => {
  const { tools, schedule } = await setup()
  await tools.dot_tasks.execute({ action: 'add', title: '交合同', due: '2026-11-12T10:00:00+08:00' }, { agent: { id: 's' } })
  const moved = await tools.dot_tasks.execute({ action: 'update', id: 't1', due: '2026-11-19T10:00:00+08:00' }, { agent: { id: 's' } })
  assert.match(moved.summary, /重设提醒/)
  assert.deepEqual(schedule.deleted, ['schedule-1'])
  assert.equal(schedule.created.length, 2)
  await tools.dot_tasks.execute({ action: 'update', id: 't1', status: 'done' }, { agent: { id: 's' } })
  assert.deepEqual(schedule.deleted, ['schedule-1', 'schedule-2'])
})

test('浮标状态：优先级 等你 > 忙碌 > 提醒 > 休息', async () => {
  const { store, run } = await setup()
  assert.equal(petStatus(store.snapshot(), NOW).mood, 'idle')

  await run('task', '2026-11-10 14:50 交周报')
  let s = petStatus(store.snapshot(), NOW)
  assert.equal(s.mood, 'alert')
  assert.match(s.bubble, /还有 30 分钟/)

  const agent = { id: 'a1' }
  hub.rootStatus(agent, 'running')
  hub.rootTool(agent, 'web_search')
  s = petStatus(store.snapshot(), NOW)
  assert.equal(s.mood, 'busy')
  assert.equal(s.bubble, '正在搜索网页…')

  const exec = {}
  hub.addDecision(exec, { agentId: 'a1', label: 'Dot', tool: 'pwsh', reason: '按用户规则需要确认' })
  assert.equal(petStatus(store.snapshot(), NOW).mood, 'waiting')
  hub.removeDecision(exec)
  assert.equal(petStatus(store.snapshot(), NOW).mood, 'busy')

  hub.rootStatus(agent, 'idle')
  assert.equal(petStatus(store.snapshot(), NOW).mood, 'alert')
  assert.equal(petStatus(store.snapshot(), NOW).tasks[0].title, '交周报')
})

test('工具名翻译', () => {
  assert.equal(toolLabel('pwsh'), '执行命令')
  assert.equal(toolLabel('subagent'), '委派子代理')
  assert.equal(toolLabel('mystery_tool'), '调用 mystery_tool')
})

test('接口安全校验', () => {
  const allowed = new Set(['dsh.example.com'])
  assert.ok(hostAllowed('127.0.0.1:3080', allowed))
  assert.ok(hostAllowed('localhost:3080', allowed))
  assert.ok(hostAllowed('[::1]:3080', allowed))
  assert.ok(hostAllowed('dsh.example.com', allowed))
  assert.ok(!hostAllowed('evil.com', allowed))
  assert.ok(!hostAllowed(undefined, allowed))

  const ok = { method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-dot-client': '1', 'content-type': 'application/json' } }
  assert.equal(checkRequest(ok, allowed, true), null)
  assert.equal(checkRequest({ ...ok, headers: { ...ok.headers, origin: 'http://evil.com' } }, allowed, true), 'cross-origin')
  assert.equal(checkRequest({ ...ok, headers: { ...ok.headers, host: 'rebind.evil.com:3080', origin: 'http://rebind.evil.com:3080' } }, allowed, true), 'host not allowed')
  assert.equal(checkRequest({ ...ok, headers: { ...ok.headers, 'x-dot-client': undefined } }, allowed, true), 'missing client header')
  assert.equal(checkRequest({ ...ok, headers: { ...ok.headers, 'content-type': 'text/plain' } }, allowed, true), 'content-type')
  assert.equal(checkRequest({ ...ok, method: 'GET' }, allowed, true), 'method')
  assert.equal(checkRequest({ method: 'GET', headers: { host: '127.0.0.1:3080' } }, allowed, false), null)
})
