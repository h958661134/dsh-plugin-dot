// 闭环：每样东西能建、能看、能改、能结束、能删。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DotStore } from '../lib/store.js'
import { createActions } from '../lib/actions.js'
import { createCommandHandlers } from '../lib/commands.js'
import { hub, petStatus } from '../lib/hub.js'

const NOW = new Date(2026, 10, 11, 10, 0)

/** 会记账的假定时服务：create 进列表，delete 出列表。 */
function liveSchedule() {
  const items = []
  return {
    items,
    async create(req) {
      const id = `s${items.length + 1}`
      items.push({ id, title: req.title, status: 'active', target: req.target })
      return { id }
    },
    async edit(req) {
      const i = items.findIndex(x => x.id === req.id)
      if (i < 0) throw new Error('not found')
      if (req.action === 'delete') items.splice(i, 1)
      else items[i].status = req.patch.active ? 'active' : 'paused'
    },
    async list() { return { items } },
  }
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dot-life-'))
  const store = new DotStore(join(dir, 'state.json'))
  const schedule = liveSchedule()
  const actions = createActions({ store, getSchedule: () => schedule, now: () => NOW })
  const handlers = createCommandHandlers({ actions, store, configRules: [{ id: 'c1', tool: 'pwsh', decision: 'ask', note: '', createdAt: '' }], now: () => NOW, dotSessionIds: () => ['dot-1'] })
  return { store, schedule, actions, handlers }
}

beforeEach(() => hub.reset())

test('事务：完成 → 重开 → 放弃 → 删除，提醒跟着删', async () => {
  const { store, schedule, handlers } = await setup()
  await handlers.task.run('明天9点 交周报', null)
  assert.equal(schedule.items.length, 1)

  assert.match((await handlers.done.run('t1', null)).text, /✓ t1/)
  assert.equal(schedule.items.length, 0) // 完成时提醒删除
  let s = petStatus(store.snapshot(), NOW)
  assert.deepEqual(s.completed.map(t => [t.id, t.status]), [['t1', 'done']])

  assert.match((await handlers.reopen.run('t1', null)).text, /重新打开/)
  assert.equal(store.snapshot().tasks[0].status, 'open')

  assert.match((await handlers.drop.run('t1', null)).text, /已放弃 t1/)
  s = petStatus(store.snapshot(), NOW)
  assert.deepEqual(s.completed.map(t => [t.id, t.status]), [['t1', 'dropped']]) // 放弃的也能在「已完成」里看到

  assert.match((await handlers.del.run('t1', null)).text, /已删除 t1/)
  assert.equal(store.snapshot().tasks.length, 0)
  assert.equal((await handlers.del.run('t9', null)).kind, 'error')
})

test('删除仍在进行的事务时，它的提醒一起删掉', async () => {
  const { store, schedule, actions } = await setup()
  await actions.addTask({ title: '体检', due: new Date(2026, 10, 12, 9).toISOString() })
  assert.equal(schedule.items.length, 1)
  await actions.deleteTasks(['t1'])
  assert.equal(schedule.items.length, 0)
  assert.equal(store.snapshot().tasks.length, 0)
})

test('定时任务：删除时解除事务关联，别人的定时任务删不了', async () => {
  const { store, schedule, actions } = await setup()
  await actions.addTask({ title: '交报告', due: new Date(2026, 10, 12, 9).toISOString() })
  schedule.items.push({ id: 'x1', title: '别人的部署检查', status: 'active', target: { kind: 'session', sessionId: 'other' } })
  await assert.rejects(actions.deleteSchedule('x1', ['dot-1']), /找不到/)
  await actions.deleteSchedule('s1', ['dot-1'])
  assert.deepEqual(schedule.items.map(x => x.id), ['x1'])
  assert.equal(store.snapshot().tasks[0].reminderId, undefined)
})

test('记忆：/memories 列出，/forget 删除', async () => {
  const { store, handlers } = await setup()
  await handlers.note.run('我不吃辣', null)
  await handlers.note.run('周末不谈工作', null)
  assert.match((await handlers.memories.run('', null)).text, /m1.*我不吃辣[\s\S]*m2.*周末不谈工作/)
  assert.match((await handlers.forget.run('m1', null)).text, /已忘掉 m1/)
  assert.deepEqual(store.snapshot().memories.map(m => m.id), ['m2'])
  assert.match((await handlers.forget.run('m1', null)).text, /没有记忆 m1/)
  assert.equal((await handlers.forget.run('', null)).kind, 'error')
})

test('规则：/rules del 删对话里加的规则，配置里的固定规则删不掉', async () => {
  const { store, handlers } = await setup()
  await store.mutate((state, newId) => { state.rules.push({ id: newId('r'), tool: 'web_*', decision: 'ask', note: '', createdAt: '' }) })
  assert.match((await handlers.rules.run('', null)).text, /\[c1\][\s\S]*\[r1\]/)
  assert.match((await handlers.rules.run('del r1', null)).text, /已删除规则 \[r1\]/)
  assert.equal(store.snapshot().rules.length, 0)
  await assert.rejects(handlers.rules.run('del c1', null), /固定规则/)
})

test('面板移除：只能移除已结束的子任务和会话', () => {
  hub.childStart({ id: 'k1', name: 't1-x', parentId: 'dot-1' })
  assert.equal(hub.dismiss('k1'), false) // 还在跑
  hub.childEnd({ id: 'k1', stopReason: 'completed' })
  assert.equal(hub.dismiss('k1'), true)
  assert.equal(hub.child('k1'), null)

  hub.otherStatus({ id: 'w1' }, 'running', '会话 A')
  hub.otherStatus({ id: 'w2' }, 'running', '会话 B')
  assert.equal(hub.dismiss('w1'), false)
  hub.otherStatus({ id: 'w1' }, 'idle')
  assert.equal(hub.clearEndedOthers(), 1)
  assert.deepEqual(hub.others().map(o => o.id), ['w2'])
})

test('小精灵跟着其他会话忙；待你决定带上跳转目标', async () => {
  const { store } = await setup()
  hub.otherStatus({ id: 'w1' }, 'running', '重构登录')
  hub.otherTool('w1', 'pwsh')
  let s = petStatus(store.snapshot(), new Date())
  assert.equal(s.mood, 'busy')
  assert.equal(s.bubble, '「重构登录」正在执行命令…')

  hub.childStart({ id: 'k1', name: 't1-x', parentId: 'dot-1' })
  hub.addDecision({}, { agentId: 'k1', label: 't1-x', tool: 'pwsh', reason: '要执行命令' })
  hub.addDecision({}, { agentId: 'w1', label: '重构登录', tool: 'pwsh', reason: '要在沙箱外执行' })
  s = petStatus(store.snapshot(), new Date())
  assert.deepEqual(s.decisions.map(d => d.open), [{ parentSessionId: 'dot-1', childSessionId: 'k1' }, 'w1'])
  assert.equal(s.unlinked[0].parentId, 'dot-1')
})

test('/due 改时间：旧提醒删掉，按新时间重建；/due 无 取消', async () => {
  const { store, schedule, handlers } = await setup()
  await handlers.task.run('明天9点 交周报', null)
  assert.deepEqual(schedule.items.map(x => x.id), ['s1'])
  const r = await handlers.due.run('t1 周五18点', null)
  assert.match(r.text, /改好了.*交周报.*到点提醒你/)
  assert.equal(schedule.items.length, 1)
  assert.equal(store.snapshot().tasks[0].reminderId, schedule.items[0].id)
  assert.equal(new Date(store.snapshot().tasks[0].due).getHours(), 18)

  assert.match((await handlers.due.run('t1 无', null)).text, /已取消截止时间/)
  assert.equal(schedule.items.length, 0)
  assert.equal(store.snapshot().tasks[0].due, null)
  assert.equal((await handlers.due.run('t1 乱写', null)).kind, 'error')
})
