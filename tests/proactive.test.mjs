import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DotStore, normalizeState } from '../lib/store.js'
import { createActions } from '../lib/actions.js'
import { createTools } from '../lib/tools.js'
import { createCommandHandlers } from '../lib/commands.js'
import { endSummary, hub } from '../lib/hub.js'
import { parseRepeat } from '../lib/repeat.js'
import { describeAction, patrol } from '../lib/suggest.js'

// 2026-11-10（周二）14:20 本地时间
const NOW = new Date(2026, 10, 10, 14, 20)
const DAY = 86_400_000

function fakeSchedule() {
  const created = []
  return {
    created,
    async create(req, actor) { created.push({ req, actor }); return { id: `schedule-${created.length}` } },
    async edit() {},
  }
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dot-v6-'))
  const store = new DotStore(join(dir, 'state.json'))
  const schedule = fakeSchedule()
  let now = NOW
  const actions = createActions({ store, getSchedule: () => schedule, now: () => now, timeZone: 'Asia/Shanghai' })
  const handlers = createCommandHandlers({ actions, store, configRules: [], timeZone: 'Asia/Shanghai', now: () => now })
  const tools = Object.fromEntries(createTools(store, { maxMemories: 100, timeZone: 'Asia/Shanghai', now: () => now }, [], actions).map(t => [t.name, t]))
  const followups = []
  const agent = { id: 'session-1', status: 'idle', followup: m => followups.push(m) }
  const run = (cmd, input = '') => handlers[cmd].run(input, agent)
  return { store, schedule, actions, tools, agent, followups, run, setNow: d => { now = d } }
}

beforeEach(() => hub.reset())

test('周期解析：每天、工作日、周末、每周几、每隔多久；看不懂返回 null', () => {
  const tz = 'Asia/Shanghai'
  assert.deepEqual(parseRepeat('每天9点 喝水', tz), { timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: tz } }, label: '每天 09:00', rest: '喝水' })
  assert.equal(parseRepeat('天天晚上10点半 写日记', tz).timing.daily.time, '22:30:00')
  assert.deepEqual(parseRepeat('工作日18点 写日报', tz).timing.weekly.weekdays, [1, 2, 3, 4, 5])
  assert.deepEqual(parseRepeat('周末上午10点 打球', tz).timing.weekly.weekdays, [6, 7])
  const w = parseRepeat('每周一三五 9:30 站会', tz)
  assert.deepEqual([w.timing.weekly.weekdays, w.timing.weekly.time, w.label, w.rest], [[1, 3, 5], '09:30:00', '每周一、三、五 09:30', '站会'])
  assert.deepEqual(parseRepeat('每周日晚上8点 复盘', tz).timing.weekly, { time: '20:00:00', time_zone: tz, weekdays: [7] })
  assert.deepEqual(parseRepeat('每30分钟 站起来', tz), { timing: { kind: 'every', every_seconds: 1800 }, label: '每半小时', rest: '站起来' })
  assert.equal(parseRepeat('每隔2小时 喝水', tz).label, '每 2 小时')
  assert.equal(parseRepeat('每小时 休息', tz).timing.every_seconds, 3600)
  assert.equal(parseRepeat('明天9点 开会', tz), null)
  assert.equal(parseRepeat('每天25点 x', tz), null)
})

test('/every 建周期提醒，投递到当前会话；看不懂就交给 Dot', async () => {
  const { run, schedule, followups } = await setup()
  const r = await run('every', '工作日18点 写日报')
  assert.equal(r.kind, 'success')
  assert.match(r.text, /工作日 18:00 提醒你：写日报/)
  const req = schedule.created[0].req
  assert.equal(req.title, 'Dot 提醒：写日报（工作日 18:00）')
  assert.equal(req.timing.kind, 'weekly')
  assert.deepEqual(req.target, { kind: 'session', sessionId: 'session-1' })
  const r2 = await run('every', '隔三差五 浇花')
  assert.match(r2.text, /交给 Dot/)
  assert.equal(followups.length, 1)
})

test('巡检：没有简报、逾期一天、等了三天、其他会话出错，各出一条建议', () => {
  const t = NOW.getTime()
  const state = normalizeState({
    tasks: [
      { id: 't1', title: '交周报', status: 'open', priority: 'high', owner: 'user', due: new Date(t - 2 * DAY).toISOString(), updatedAt: NOW.toISOString() },
      { id: 't2', title: '等报价', status: 'waiting', priority: 'normal', owner: 'user', due: null, updatedAt: new Date(t - 4 * DAY).toISOString() },
      { id: 't3', title: '刚逾期', status: 'open', priority: 'normal', owner: 'user', due: new Date(t - 3600_000).toISOString(), updatedAt: NOW.toISOString() },
    ],
  })
  const others = [
    { id: 's1', title: '跑数据', status: 'idle', result: 'failed', endedAt: t - 3600_000, error: '额度不足' },
    { id: 's2', title: '盯着的', status: 'idle', result: 'failed', endedAt: t - 3600_000, watched: true },
  ]
  const { drafts, isStale } = patrol(state, { now: NOW, schedules: [], others })
  assert.deepEqual(drafts.map(d => d.kind), ['brief', 'overdue', 'waiting', 'failed'])
  assert.match(drafts[1].title, /「交周报」已经逾期 2 天/)
  assert.equal(drafts[1].options[0].action.type, 'reschedule')
  assert.equal(new Date(drafts[1].options[0].action.due).getHours(), 9)
  assert.match(drafts[3].body, /额度不足/)
  assert.equal(describeAction(drafts[0].options[0].action), '建一个每天 09:00 的简报')

  // 已有简报就不再建议；拿不到定时列表时也不提，但已有的简报建议不算过期
  assert.ok(!patrol(state, { now: NOW, schedules: [{ title: 'Dot 提醒：每日简报 09:00' }], others: [] }).drafts.some(d => d.kind === 'brief'))
  const none = patrol(state, { now: NOW, schedules: null, others: [] })
  assert.ok(!none.drafts.some(d => d.kind === 'brief'))
  assert.equal(none.isStale({ key: 'daily-brief', source: 'patrol' }), false)
  // 事务完成后，它的逾期建议自动作废；Dot 提的建议不归巡检管
  assert.equal(isStale({ key: 'overdue:t9:x', source: 'patrol' }), true)
  assert.equal(isStale({ key: 'dot:x', source: 'dot' }), false)
})

test('建议收件箱：去重、7 天内处理过不再提、自动收起、上限', async () => {
  const { actions, store, setNow } = await setup()
  const draft = { key: 'k1', kind: 'dot', source: 'dot', title: 'A', body: '', options: [] }
  const s1 = await actions.addSuggestion(draft)
  assert.equal(s1.id, 's1')
  assert.equal(await actions.addSuggestion(draft), null) // 还开着
  await actions.resolveSuggestion('s1', 'dismissed')
  assert.equal(await actions.addSuggestion(draft), null) // 刚处理过
  setNow(new Date(NOW.getTime() + 8 * DAY))
  assert.ok(await actions.addSuggestion(draft)) // 过了 7 天可以再提
  await assert.rejects(actions.resolveSuggestion('s1', 'accepted'), /处理过/)

  await actions.addSuggestion({ ...draft, key: 'k2', source: 'patrol' })
  assert.equal(await actions.expireSuggestions(s => s.key === 'k2'), 1)
  assert.equal(store.snapshot().suggestions.find(s => s.key === 'k2').status, 'dismissed')

  for (let i = 0; i < 25; i++) await actions.addSuggestion({ ...draft, key: `many${i}` })
  assert.equal(store.snapshot().suggestions.filter(s => s.status === 'open').length, 20)
})

test('每日简报：建一个 daily 定时，标题带「简报」', async () => {
  const { actions, schedule } = await setup()
  const r = await actions.scheduleDailyBrief('8:30', 'session-1')
  assert.match(r.line, /每天 08:30/)
  const req = schedule.created[0].req
  assert.equal(req.title, 'Dot 提醒：每日简报 08:30')
  assert.deepEqual(req.timing, { kind: 'daily', daily: { time: '08:30:00', time_zone: 'Asia/Shanghai' } })
  assert.match(req.prompt, /dot_brief/)
  await assert.rejects(actions.scheduleDailyBrief('25:00'), /时间格式/)
})

test('dot_suggest：放进收件箱，重复的不再加', async () => {
  const { tools, store } = await setup()
  const r = await tools.dot_suggest.execute({ title: '报价等了 3 天，要不要催？', do_label: '起草催办', do_text: '帮我起草催办消息，先给我看' })
  assert.match(r.summary, /建议收件箱/)
  const s = store.snapshot().suggestions[0]
  assert.deepEqual(s.options, [{ label: '起草催办', action: { type: 'say', text: '帮我起草催办消息，先给我看' } }])
  const again = await tools.dot_suggest.execute({ title: '报价等了 3 天，要不要催？', task_title: '催报价' })
  assert.match(again.summary, /不再重复/)
  await assert.rejects(tools.dot_suggest.execute({ title: '要不要整理一下桌面？' }), /task_title/)
  await tools.dot_suggest.execute({ title: '周报模板该更新了？', task_title: '更新周报模板' })
  assert.deepEqual(store.snapshot().suggestions[1].options[0].action, { type: 'task', title: '更新周报模板' })
})

test('简报带上最近的其他会话和待看的建议', async () => {
  const { tools, actions } = await setup()
  hub.restoreOther({ id: 'o1', title: '写报告', createdAt: Date.now() - 3600_000 })
  await actions.addSuggestion({ key: 'k', kind: 'dot', source: 'dot', title: '催一下报价', body: '', options: [] })
  const r = await tools.dot_brief.execute({})
  assert.match(r.summary, /最近 24 小时的其他会话（1）/)
  assert.match(r.summary, /「写报告」已结束/)
  assert.match(r.summary, /待你看的建议（1/)
})

test('盯着的会话结束总结：用时、步数、文件、最后一句', () => {
  const now = Date.now()
  const text = endSummary({ result: 'done', startedAt: now - 5 * 60_000, steps: 7 }, { files: ['a/b/x.js', 'y.md', 'C:\\z\\w.ts', 'q.txt'], lastText: '都改好了' }, now)
  assert.equal(text, '用时 5 分钟 · 7 步 · 改了 4 个文件（x.js、y.md、w.ts 等）。都改好了')
  assert.equal(endSummary({ result: 'failed', startedAt: now, steps: 1 }, { error: '额度不足' }, now), '不到 1 分钟 · 1 步。额度不足')
})
