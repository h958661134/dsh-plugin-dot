import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hub, petStatus } from '../lib/hub.js'
import { apply as applyHost } from '../lib/host.js'
import { getStore } from '../lib/store.js'
import { createActions } from '../lib/actions.js'
import { addTaskFromText } from '../lib/commands.js'
import { createSessionsTool } from '../lib/sessions.js'
import { patrol } from '../lib/suggest.js'
import { deskView } from '../lib/petcards.js'
import { bucketOf, dayKey, nextDue, placeholderTitle, snoozeTo, tempTitle, titleIssue, titleIssues, todoBuckets } from '../lib/todo.js'

beforeEach(() => hub.reset())

// 2026-11-11 是周三
const at = (/** @type {number} */ d, /** @type {number} */ h, m = 0) => new Date(2026, 10, d, h, m)

test('周期：每天、工作日、每周几、每隔多久的下一次', () => {
  const daily = { kind: 'daily', daily: { time: '09:00:00' } }
  assert.equal(nextDue(daily, at(11, 8)).getTime(), at(11, 9).getTime())
  assert.equal(nextDue(daily, at(11, 9)).getTime(), at(12, 9).getTime()) // 正好 9 点：严格晚于，排到明天
  const workday = { kind: 'weekly', weekly: { time: '18:00:00', weekdays: [1, 2, 3, 4, 5] } }
  assert.equal(nextDue(workday, at(13, 19)).getTime(), at(16, 18).getTime()) // 周五晚上 → 下周一
  const monday = { kind: 'weekly', weekly: { time: '09:00', weekdays: [1] } }
  assert.equal(nextDue(monday, at(11, 10)).getTime(), at(16, 9).getTime())
  const sunday = { kind: 'weekly', weekly: { time: '20:00', weekdays: [7] } }
  assert.equal(nextDue(sunday, at(11, 10)).getTime(), at(15, 20).getTime())
  assert.equal(nextDue({ kind: 'every', every_seconds: 1800 }, at(11, 10)).getTime(), at(11, 10, 30).getTime())
  assert.equal(nextDue({ kind: 'weekly', weekly: { time: '09:00', weekdays: [] } }, at(11, 10)), null)
  assert.equal(nextDue(null, at(11, 10)), null)
})

test('分组：逾期、今天（截止今天或放进今天）、之后、收件箱、等别人', () => {
  const now = at(11, 12)
  const base = { notes: '', owner: 'user', createdAt: now.toISOString(), updatedAt: now.toISOString(), doneAt: null }
  const t = (/** @type {any} */ x) => ({ ...base, status: 'open', priority: 'normal', due: null, ...x })
  const tasks = [
    t({ id: 'a', title: '逾期', due: at(11, 9).toISOString() }),
    t({ id: 'b', title: '今晚', due: at(11, 20).toISOString() }),
    t({ id: 'c', title: '放进今天', today: dayKey(now) }),
    t({ id: 'd', title: '昨天放进今天的', today: dayKey(at(10, 9)) }),
    t({ id: 'e', title: '明天', due: at(12, 9).toISOString() }),
    t({ id: 'f', title: '等老王', status: 'waiting', due: at(10, 9).toISOString() }),
    t({ id: 'g', title: '高优先级的收件箱', priority: 'high' }),
    t({ id: 'h', title: '做完了', status: 'done' }),
  ]
  assert.deepEqual(tasks.map(x => bucketOf(x, now)), ['overdue', 'today', 'today', 'inbox', 'upcoming', 'waiting', 'inbox', 'inbox'])
  const g = todoBuckets(tasks, now)
  assert.deepEqual(g.inbox.map(x => x.id), ['g', 'd']) // 高优先级在前；做完的不算
  assert.deepEqual(g.waiting.map(x => x.id), ['f']) // 等别人的过了追问时间也不算逾期
})

test('推迟的预设', () => {
  const now = at(11, 12) // 周三中午
  assert.equal(snoozeTo('1h', now).getTime(), at(11, 13).getTime())
  assert.equal(snoozeTo('tonight', now).getTime(), at(11, 20).getTime())
  assert.equal(snoozeTo('tonight', at(11, 21)).getTime(), at(11, 22).getTime()) // 已经过了 8 点：一小时后
  assert.equal(snoozeTo('tomorrow', now).getTime(), at(12, 9).getTime())
  assert.equal(snoozeTo('weekend', now).getTime(), at(14, 10).getTime())
  assert.equal(snoozeTo('nextweek', now).getTime(), at(16, 9).getTime())
  assert.equal(snoozeTo('whenever', now), null)
})

test('会话标题：没标题、临时、笼统、重名、太长都要整理；临时标题从第一句话截', () => {
  assert.equal(titleIssue(''), '没有标题')
  assert.equal(titleIssue('帮我看看登录页', { temp: true }), '临时标题')
  assert.equal(titleIssue('你好'), '标题太笼统')
  assert.equal(titleIssue('继续！'), '标题太笼统')
  assert.equal(titleIssue('修复登录页的验证码'), null)
  assert.equal(titleIssue('x'.repeat(40)), '标题太长')
  const m = titleIssues([{ id: '1', title: '整理周报' }, { id: '2', title: '整理周报' }, { id: '3', title: '修复登录页' }])
  assert.deepEqual([...m.entries()], [['1', '和别的会话重名'], ['2', '和别的会话重名']])
  assert.equal(tempTitle('  帮我\n看看   登录页  '), '帮我 看看 登录页')
  assert.equal([...tempTitle('一'.repeat(30))].length, 25) // 24 个字 + …
  assert.match(placeholderTitle(at(11, 14, 5).getTime()), /^新会话 · 14:05$/)
})

async function makeActions() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dot-todo-'))
  const store = getStore(join(dir, 'state.json'))
  await store.load()
  /** @type {any[]} */
  const reminders = []
  const schedule = {
    async create(/** @type {any} */ r) { reminders.push(r); return { id: `r${reminders.length}` } },
    async edit() { return {} },
  }
  return { store, reminders, actions: createActions({ store, getSchedule: () => schedule, timeZone: 'Asia/Shanghai' }) }
}

test('一句话记待办：周期、今天、小步骤；周期待办勾掉后自动排下一次（带提醒）', async () => {
  const { store, reminders, actions } = await makeActions()
  const now = new Date()
  const r = await addTaskFromText(actions, '每天9点 喝水；拿杯子；接水', { now, timeZone: 'Asia/Shanghai' })
  assert.ok('task' in r)
  const task = /** @type {any} */ (r).task
  assert.equal(task.title, '喝水')
  assert.equal(task.repeat.label, '每天 09:00')
  assert.deepEqual(task.steps.map((/** @type {any} */ s) => s.text), ['拿杯子', '接水'])
  assert.equal(new Date(task.due).getHours(), 9)
  assert.ok(new Date(task.due).getTime() > now.getTime())
  assert.match(r.line, /每天 09:00/)

  const today = await addTaskFromText(actions, '今天 买牛奶', { now, timeZone: 'Asia/Shanghai' })
  assert.ok('task' in today)
  assert.equal(/** @type {any} */ (today).task.title, '买牛奶')
  assert.equal(/** @type {any} */ (today).task.today, dayKey(now))
  assert.equal(/** @type {any} */ (today).task.due, null)
  assert.deepEqual(await addTaskFromText(actions, '；', { now }), { error: '没写要做什么' })

  const before = reminders.length
  const { closed, next } = await actions.closeTasks([task.id], 'done')
  assert.equal(closed[0].status, 'done')
  assert.equal(next.length, 1)
  assert.equal(next[0].title, '喝水')
  assert.equal(new Date(next[0].due).getTime() - new Date(task.due).getTime(), 86_400_000) // 下一天同一时间
  assert.deepEqual(next[0].steps.map((/** @type {any} */ s) => s.done), [false, false])
  assert.equal(reminders.length, before + 1) // 下一次的提醒也建好了
  // 已经关掉的再关一次：不重复生成
  const again = await actions.closeTasks([task.id], 'done')
  assert.equal(again.next.length, 0)
  // 放弃周期待办：不生成下一次
  const dropped = await actions.closeTasks([next[0].id], 'dropped')
  assert.equal(dropped.next.length, 0)
  assert.equal(store.snapshot().tasks.filter(t => t.title === '喝水' && t.status === 'open').length, 0)
})

test('editTask：放进今天、小步骤增删勾、等别人和接着办', async () => {
  const { actions } = await makeActions()
  const { task } = await actions.addTask({ title: '准备周会' })
  let t = await actions.editTask(task.id, { today: true })
  assert.equal(t.today, dayKey(new Date()))
  t = await actions.editTask(task.id, { step: { op: 'add', text: '整理数据' } })
  t = await actions.editTask(task.id, { step: { op: 'add', text: '写结论' } })
  t = await actions.editTask(task.id, { step: { op: 'toggle', index: 0 } })
  assert.deepEqual(t.steps, [{ text: '整理数据', done: true }, { text: '写结论', done: false }])
  t = await actions.editTask(task.id, { step: { op: 'edit', index: 1, text: '写结论和下一步' } })
  t = await actions.editTask(task.id, { step: { op: 'remove', index: 0 } })
  assert.deepEqual(t.steps, [{ text: '写结论和下一步', done: false }])
  await assert.rejects(actions.editTask(task.id, { step: { op: 'toggle', index: 5 } }), /没有这个步骤/)
  t = await actions.editTask(task.id, { waiting: true, waitingOn: '老王回邮件' })
  assert.equal(t.status, 'waiting')
  assert.equal(t.waitingOn, '老王回邮件')
  assert.equal(t.today, undefined) // 等别人的不占「今天」
  t = await actions.editTask(task.id, { waiting: false })
  assert.equal(t.status, 'open')
  assert.equal(t.waitingOn, undefined)
})

/** @param {any} [extra] */
async function hostSetup(extra = {}) {
  /** @type {Record<string, any>} */
  const routes = {}
  /** @type {Record<string, any>} */
  const listeners = {}
  /** @type {any[]} */
  const created = []
  /** @type {any[]} */
  const renamed = []
  const services = {
    schedule: { async create(/** @type {any} */ r) { created.push(r); return { id: `s${created.length}` } }, async edit() { return {} }, async list() { return { items: [] } } },
    sessionController: { async rename(/** @type {any} */ r) { renamed.push(r); return { title: r.title, seq: 1 } } },
    ...extra,
  }
  const ctx = {
    webServer: { register: (/** @type {any} */ r) => { routes[r.path] = r.handler }, getOrigin: () => 'http://127.0.0.1:3999' },
    on: (/** @type {string} */ name, /** @type {any} */ fn) => { listeners[name] = fn },
    get: (/** @type {string} */ name) => /** @type {any} */ (services)[name],
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-dot-todo-host-'))
  await applyHost(ctx, { dataDir, pet: true })
  return { routes, listeners, created, renamed, store: getStore(join(dataDir, 'state.json')) }
}
/** @param {any} handler @param {any} body */
async function call(handler, body, url = '/') {
  const req = {
    url, method: body ? 'POST' : 'GET',
    headers: { host: '127.0.0.1:3999', 'x-dot-client': '1', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) },
  }
  /** @type {any} */
  let out
  const res = { setHeader() {}, end: (/** @type {string} */ b) => { out = JSON.parse(b) }, statusCode: 200 }
  await handler(req, res)
  return { code: res.statusCode, ...out }
}

test('/task 接口：一句话记下、勾掉可撤销（周期的下一次一起撤掉）、推迟可撤销、等别人、交给 Dot', async () => {
  const { routes, created, store } = await hostSetup()
  const task = routes['/api/dsh-plugin-dot/task']
  const status = routes['/api/dsh-plugin-dot/status']

  const a = await call(task, { action: 'add', text: '写周报 !高；列提纲；补数据', today: true })
  assert.equal(a.ok, true)
  let s = await call(status, null, '/api/dsh-plugin-dot/status')
  let row = s.tasks.find((/** @type {any} */ x) => x.id === a.id)
  assert.equal(row.title, '写周报')
  assert.equal(row.priority, 'high')
  assert.equal(row.bucket, 'today')
  assert.deepEqual(row.steps.map((/** @type {any} */ x) => x.text), ['列提纲', '补数据'])
  assert.equal(s.counts.today, 1)

  // 步骤全勾完：提示可以勾掉
  await call(task, { id: a.id, action: 'step', op: 'toggle', index: 0 })
  const last = await call(task, { id: a.id, action: 'step', op: 'toggle', index: 1 })
  assert.equal(last.allDone, true)

  // 勾掉 → 撤销
  const done = await call(task, { id: a.id, action: 'done' })
  assert.deepEqual(done.undo, { post: '/task', body: { id: a.id, action: 'undo-close' } })
  const undo = await call(task, done.undo.body)
  assert.equal(undo.ok, true)
  assert.equal(store.snapshot().tasks.find(x => x.id === a.id)?.status, 'open')

  // 周期待办：勾掉生成下一次；撤销时下一次也删掉
  const w = await call(task, { action: 'add', text: '每周一9点 交周报' })
  const wd = await call(task, { id: w.id, action: 'done' })
  assert.match(wd.text, /下次 /)
  const nextId = wd.undo.body.next
  assert.ok(store.snapshot().tasks.some(x => x.id === nextId))
  await call(task, wd.undo.body)
  assert.ok(!store.snapshot().tasks.some(x => x.id === nextId))
  assert.equal(store.snapshot().tasks.find(x => x.id === w.id)?.status, 'open')

  // 推迟到明早 → 撤销回到原来（没有截止时间、在今天）
  const sn = await call(task, { id: a.id, action: 'snooze', to: 'tomorrow' })
  assert.match(sn.text, /明天 09:00 提醒你：写周报/)
  assert.equal(store.snapshot().tasks.find(x => x.id === a.id)?.today, undefined)
  await call(task, sn.undo.body)
  const back = store.snapshot().tasks.find(x => x.id === a.id)
  assert.equal(back?.due, null)
  assert.equal(back?.today, dayKey(new Date()))
  assert.equal((await call(task, { id: a.id, action: 'snooze', to: 'someday' })).code, 400)

  // 等别人：两天后上午 10 点提醒追
  const wait = await call(task, { id: a.id, action: 'wait', waitingOn: '老王' })
  assert.match(wait.text, /在等「老王」/)
  s = await call(status, null, '/api/dsh-plugin-dot/status')
  row = s.tasks.find((/** @type {any} */ x) => x.id === a.id)
  assert.equal(row.bucket, 'waiting')
  assert.equal(new Date(row.due).getHours(), 10)
  await call(task, { id: a.id, action: 'resume' })

  // 交给 Dot：没有加载的 Dot 会话时，经定时服务新开一个 Dot 会话去做，带上没做完的步骤
  const before = created.length
  const dg = await call(task, { id: a.id, action: 'delegate' })
  assert.equal(dg.ok, true)
  const sent = created.slice(before).find(x => /帮我推进待办/.test(x.prompt))
  assert.ok(sent)
  assert.match(sent.prompt, /写周报/)
  assert.equal(sent.target.kind, 'new_once')
})

test('跑完的会话正好是某件待办在等的：通知卡上「勾掉待办」', async () => {
  const { routes, listeners, store } = await hostSetup()
  const ag = { id: 'w1', session: { id: 'w1', preset: 'standard', header: { delegationDepth: 0 } } }
  listeners['agent/status']({ agent: ag, status: 'running' })
  await call(routes['/api/dsh-plugin-dot/session'], { id: 'w1', action: 'watch' })
  await call(routes['/api/dsh-plugin-dot/session'], { id: 'w1', action: 'task' })
  const taskId = store.snapshot().tasks[0].id
  hub.other('w1').startedAt -= 60_000
  listeners['agent/status']({ agent: ag, status: 'idle' })
  const s = await call(routes['/api/dsh-plugin-dot/status'], null, '/api/dsh-plugin-dot/status?desk=1')
  const n = s.notices.find((/** @type {any} */ x) => x.sessionId === 'w1')
  assert.equal(n.taskId, taskId)
  const card = s.desk.cards.find((/** @type {any} */ c) => c.key === `n:${n.id}`)
  assert.deepEqual(card.buttons[0], { label: '勾掉待办', main: true, op: { post: '/notice', body: { id: n.id, action: 'complete', taskId } } })
  const r = await call(routes['/api/dsh-plugin-dot/notice'], card.buttons[0].op.body)
  assert.equal(r.ok, true)
  assert.equal(store.snapshot().tasks[0].status, 'done')
  assert.equal(hub.notices().length, 0)
})

test('会话标题：没标题时用第一句话做临时标题，正式标题来了换上，临时的不会盖掉正式的', async () => {
  const docs = { w2: [{ type: 'user/message', text: '帮我把登录页的验证码换成滑块', time: 1 }] }
  const { listeners } = await hostSetup({
    sessionQuery: { async filterEvents(/** @type {string} */ id) { return /** @type {any} */ (docs)[id] ?? [] } },
  })
  const ag = { id: 'w2', session: { id: 'w2', preset: 'standard', header: { delegationDepth: 0 } } }
  listeners['agent/status']({ agent: ag, status: 'running' })
  assert.match(hub.other('w2').title, /^新会话 · \d\d:\d\d$/)
  assert.equal(hub.other('w2').titleTemp, true)
  await new Promise(r => setTimeout(r, 10))
  assert.equal(hub.other('w2').title, '帮我把登录页的验证码换成滑块')
  assert.equal(hub.other('w2').titleTemp, true)
  assert.equal(hub.setOtherTitle('w2', '登录页验证码改滑块'), true)
  assert.equal(hub.other('w2').titleTemp, false)
  assert.equal(hub.setOtherTitle('w2', '别的第一句话', true), false)
  assert.equal(hub.other('w2').title, '登录页验证码改滑块')
})

test('改名：总览里亲手改直接生效；Dot 提的改名是一张卡，点了才改，改完能撤销', async () => {
  const { routes, listeners, renamed, store } = await hostSetup()
  for (const id of ['w3', 'w4']) listeners['agent/status']({ agent: { id, session: { id, preset: 'standard', header: { delegationDepth: 0 } } }, status: 'running' })
  const session = routes['/api/dsh-plugin-dot/session']
  const r = await call(session, { id: 'w3', action: 'rename', title: '  登录页 验证码\n改滑块 ' })
  assert.equal(r.ok, true)
  assert.deepEqual(renamed[0], { sessionId: 'w3', title: '登录页 验证码 改滑块' })
  assert.equal(hub.other('w3').title, '登录页 验证码 改滑块')
  assert.equal((await call(session, { id: 'w3', action: 'rename', title: '   ' })).code, 500)

  // Dot 起名：工具只放卡
  const tool = createSessionsTool({ actions: /** @type {any} */ ({ addSuggestion: async (/** @type {any} */ d) => { await store.mutate((st, newId) => { st.suggestions.push({ ...d, id: newId('s'), status: 'open', createdAt: new Date().toISOString(), resolvedAt: null }) }); return { id: 'x' } } }), getQuery: () => null })
  const out = await tool.execute({ action: 'rename', renames: [{ id: 'w4', title: '周报数据整理' }] })
  assert.match(out.summary, /等用户在 Dot 窗口点「改名」/)
  assert.equal(renamed.length, 1) // 还没改
  const card = store.snapshot().suggestions.find(s => s.kind === 'rename')
  assert.ok(card)
  const ok = await call(routes['/api/dsh-plugin-dot/suggestion'], { id: card.id, option: 0 })
  assert.equal(ok.ok, true)
  assert.deepEqual(renamed[1], { sessionId: 'w4', title: '周报数据整理' })
  // 撤销卡：改回原来的名字
  const undo = store.snapshot().suggestions.find(s => s.kind === 'undo' && s.status === 'open')
  assert.ok(undo)
  assert.equal(/** @type {any} */ (undo.options[0].action).items[0].sessionId, 'w4')
  assert.match(/** @type {any} */ (undo.options[0].action).items[0].title, /^新会话 · /)
  await assert.rejects(tool.execute({ action: 'rename', renames: [] }), /rename 需要 renames/)
})

test('巡检：名字不清楚的会话攒到 3 个，提议让 Dot 起名（只是一句交给 Dot 的话）', () => {
  const now = new Date()
  const base = { status: 'idle', result: 'done' }
  const others = [
    { ...base, id: 'a', title: '你好' }, { ...base, id: 'b', title: '帮我看看', titleTemp: true },
    { ...base, id: 'c', title: '周报' }, { ...base, id: 'd', title: '周报' }, { ...base, id: 'e', title: '登录页改版', status: 'running' },
  ]
  const state = { tasks: [], suggestions: [] }
  const { drafts } = patrol(/** @type {any} */ (state), { now, schedules: null, others, stale: null })
  const d = drafts.find(x => x.kind === 'names')
  assert.ok(d)
  assert.match(d.title, /有 4 个会话名字不清楚/)
  assert.equal(d.options[0].action.type, 'say')
  assert.match(String(d.options[0].action.text), /\[a\]「你好」（标题太笼统）/)
  assert.ok(!String(d.options[0].action.text).includes('[e]')) // 正在跑的不算
})

test('桌面精灵的「今天」清单：今天和逾期的，已经是卡片的不重复；带时间、周期、步骤', () => {
  const now = Date.now()
  const s = {
    counts: { today: 3, inbox: 2 },
    tasks: [
      { id: 't1', title: '逾期的', bucket: 'overdue', overdue: true, due: new Date(now - 60_000).toISOString(), priority: 'normal', steps: [] },
      { id: 't2', title: '今天的', bucket: 'today', due: null, priority: 'high', steps: [{ text: 'a', done: true }, { text: 'b', done: false }], repeat: '每天 09:00' },
      { id: 't3', title: '明天的', bucket: 'upcoming', due: new Date(now + 2 * 86_400_000).toISOString(), priority: 'normal', steps: [] },
      { id: 't4', title: '今天也要', bucket: 'today', due: null, priority: 'normal', steps: [] },
    ],
  }
  const v = deskView(s, now)
  assert.deepEqual(v.todos.map((/** @type {any} */ x) => x.id), ['t2', 't4']) // t1 已经是逾期卡
  assert.equal(v.todos[0].sub, '↻ 每天 09:00 · 1/2 步')
  assert.equal(v.todos[0].high, true)
  assert.equal(v.todoMore, 0)
  assert.equal(v.inbox, 2)
  assert.match(v.summary, /今天 3 件待办/)
})

test('/status 带 bucket、today、steps；petStatus 计数 today / inbox', async () => {
  const { actions, store } = await makeActions()
  await actions.addTask({ title: '收件箱的' })
  await actions.addTask({ title: '今天的', today: true })
  const s = petStatus(store.snapshot(), new Date())
  assert.equal(s.counts.today, 1)
  assert.equal(s.counts.inbox, 1)
  assert.deepEqual(s.tasks.map((/** @type {any} */ x) => x.bucket).sort(), ['inbox', 'today'])
})

test('一句话都没说的空会话：显示「新会话 · 时:分」，但不算名字待整理', () => {
  const m = titleIssues([{ id: 'e', title: '新会话 · 21:56', titleTemp: true }, { id: 'f', title: '帮我看看', titleTemp: true }])
  assert.deepEqual([...m.keys()], ['f'])
})

test('待办的时间：没写、只写今天、写了以后某天、说了时刻、时刻已过、口语里的模糊时间，都不报错', async () => {
  const { parseTodoTime } = await import('../lib/todo.js')
  const now = at(12, 10, 20) // 周四上午 10:20
  const hm = (/** @type {Date | null} */ d) => d && `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const t = (/** @type {string} */ s) => { const r = parseTodoTime(s, now); return [r.rest, hm(r.due), r.today, r.remind, r.note] }
  // 用户实际遇到的两句
  assert.deepEqual(t('精细化插件使用'), ['精细化插件使用', null, false, false, ''])
  assert.deepEqual(t('今天精细化插件使用'), ['精细化插件使用', null, true, false, ''])
  // 只说了以后某天：截止那天，那天早上 9 点提醒
  assert.deepEqual(t('明天 交周报'), ['交周报', '11/13 09:00', false, true, ''])
  assert.deepEqual(t('周五 交周报'), ['交周报', '11/13 09:00', false, true, ''])
  // 说了时刻
  assert.deepEqual(t('今天下午3点 开会'), ['开会', '11/12 15:00', false, true, ''])
  assert.deepEqual(t('1小时后 喝水'), ['喝水', '11/12 11:20', false, true, ''])
  // 今天的时刻已经过了：上午钟点没写时段 → 晚上同一钟点；写了「上午」→ 放进今天、不提醒
  assert.deepEqual(t('今天9点 精细化插件使用'), ['精细化插件使用', '11/12 21:00', false, true, '09:00 已经过了，按晚上 21:00 算'])
  assert.deepEqual(t('今天上午9点 打电话'), ['打电话', null, true, false, '09:00 已经过了，先放进今天的待办'])
  // 口语里的模糊时间
  assert.deepEqual(t('等会 回老王消息'), ['回老王消息', '11/12 10:50', false, true, ''])
  assert.deepEqual(t('下班前 交日报'), ['交日报', '11/12 18:00', false, true, ''])
  assert.deepEqual(t('睡前 记账'), ['记账', '11/12 22:00', false, true, ''])
  assert.deepEqual(t('周末 大扫除'), ['大扫除', '11/14 10:00', false, true, ''])
  assert.deepEqual(t('下周 体检'), ['体检', '11/16 09:00', false, true, ''])
  assert.deepEqual(t('月底 报销'), ['报销', '11/30 18:00', false, true, ''])
  // 已经是周末时说「周末」：就是今天
  assert.deepEqual(parseTodoTime('周末 大扫除', at(14, 15)).today, true)
})

test('/task 接口：从「今天」入口记、没写时间的放进今天；从待办页记的进收件箱；推迟里有半小时后、下班前', async () => {
  const { routes, store } = await hostSetup()
  const task = routes['/api/dsh-plugin-dot/task']
  const a = await call(task, { action: 'add', text: '精细化插件使用', today: true })
  const b = await call(task, { action: 'add', text: '研究打包方案' })
  const s = store.snapshot().tasks
  assert.ok(s.find(x => x.id === a.id)?.today)
  assert.equal(s.find(x => x.id === b.id)?.today, undefined)
  const r = await call(task, { id: b.id, action: 'snooze', to: '30m' })
  assert.match(r.text, /提醒你：研究打包方案/)
  assert.ok(store.snapshot().tasks.find(x => x.id === b.id)?.due)
  assert.match((await call(task, { id: b.id, action: 'snooze', to: 'offwork' })).text, /^改到 /)
})
