import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DotStore, normalizeState } from '../lib/store.js'
import { createActions } from '../lib/actions.js'
import { apply } from '../lib/index.js'
import { hub } from '../lib/hub.js'
import { turnEffects } from '../lib/host.js'
import { checkPetLook } from '../lib/routes.js'

beforeEach(() => hub.reset())

test('对话事务卡：只取这一轮、这个会话里建的事务，以及这一轮 Dot 提的建议', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dot-v7-'))
  const store = new DotStore(join(dir, 'state.json'))
  let now = new Date(2026, 10, 11, 10, 0, 0)
  const actions = createActions({ store, getSchedule: () => undefined, now: () => now })
  await actions.addTask({ title: '旧的', sessionId: 'dot-1' })
  now = new Date(2026, 10, 11, 10, 5, 0)
  const from = now.getTime() - 1000
  await actions.addTask({ title: '这轮的', sessionId: 'dot-1' })
  await actions.addTask({ title: '别的会话', sessionId: 'dot-2' })
  await actions.addTask({ title: '小精灵记的' })
  await actions.addSuggestion({ key: 'k', kind: 'dot', source: 'dot', title: '催一下', body: '', options: [{ label: '起草', action: { type: 'say', text: 'x' } }] })
  await actions.addSuggestion({ key: 'p', kind: 'brief', source: 'patrol', title: '巡检的', body: '', options: [] })
  await actions.logTurn('dot-1', { kind: 'reminder', text: '周五 15:00 回电话' })
  await actions.logTurn('dot-2', { kind: 'memory', text: '别的会话的' })
  const to = now.getTime() + 1000
  const r = turnEffects(store.snapshot(), 'dot-1', from, to)
  assert.deepEqual(r.effects, [{ kind: 'reminder', text: '周五 15:00 回电话', ref: null }])
  assert.deepEqual(r.tasks.map(t => t.title), ['这轮的'])
  assert.deepEqual(r.suggestions.map(s => [s.title, s.options[0].label]), [['催一下', '起草']])
  assert.equal(store.snapshot().tasks.find(t => t.title === '小精灵记的').createdIn, undefined)
  assert.deepEqual(turnEffects(store.snapshot(), '', from, to), { tasks: [], suggestions: [], effects: [] })
  assert.deepEqual(turnEffects(store.snapshot(), 'dot-1', NaN, to), { tasks: [], suggestions: [], effects: [] })
})

test('小精灵外观：名字和颜色校验，旧文件里的坏值被丢掉', () => {
  assert.deepEqual(checkPetLook({ name: ' 小点 ', color: 'green' }), { name: '小点', color: 'green' })
  assert.throws(() => checkPetLook({ name: '  ' }), /不能为空/)
  assert.throws(() => checkPetLook({ name: '一二三四五六七八九十一二三' }), /12 个字/)
  assert.throws(() => checkPetLook({ color: 'rainbow' }), /没有这个颜色/)
  assert.deepEqual(normalizeState({ prefs: { pet: { name: '  ', color: 'pink' } } }).prefs.pet, { color: 'pink' })
  assert.equal(normalizeState({}).prefs.pet, undefined)
})

test('工作偏好：总是带进上下文，即使超过记忆条数上限', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-dot-v7-'))
  const contexts = []
  const tools = new Map()
  const ctx = {
    tools: { register: t => { tools.set(t.name, t) } },
    systemPrompt: { section: () => {}, context: c => { contexts.push(c) } },
    on: () => {}, get: () => undefined, effect: () => {},
  }
  await apply(ctx, { dataDir, contextMemoryLimit: 2 })
  const remember = text => tools.get('dot_memory').execute({ action: 'remember', text, category: 'preference' }, {})
  await remember('工作偏好：汇报先给结论')
  for (const x of ['a', 'b', 'c']) await remember(`普通记忆 ${x}`)
  const text = contexts[0].text()
  assert.match(text, /工作偏好：汇报先给结论/)
  assert.match(text, /普通记忆 c/)
  assert.doesNotMatch(text, /普通记忆 a/)
})
