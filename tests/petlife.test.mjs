// 桌宠的生活：专注、问候、休息、统计、装扮（docs/DESK-BUDDY.md）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  answerBreak, continuousMinutes, emptyLife, eveningPlan, fmtCount, fmtDuration, hourKey, lifeCards, lifeDesk, lifeOf,
  morningGreeting, onTasksDone, recordActivity, startFocus, statsLine, stopFocus, todayStats,
} from '../lib/petlife.js'

// 2026-11-12 是周四
const at = (/** @type {number} */ h, m = 0, d = 12) => new Date(2026, 10, d, h, m)
const task = (/** @type {any} */ x) => ({ status: 'open', priority: 'normal', due: null, ...x })
/** n 分钟连续在用电脑，从 start 开始 @param {Date} start @param {number} n @param {number} keys */
const minutes = (start, n, keys = 0) => Array.from({ length: n }, (_, i) => ({ at: start.getTime() + i * 60_000, active: true, keys }))

test('旧数据、坏数据都能读；装扮不认识就回到不戴', () => {
  assert.deepEqual(lifeOf(undefined), emptyLife())
  assert.equal(lifeOf({ outfit: 'crown' }).outfit, 'crown')
  assert.equal(lifeOf({ outfit: 'rocket' }).outfit, 'none')
  assert.equal(lifeOf({ focus: { title: 'x' } }).focus, null)
  assert.equal(lifeOf({ activity: { keys: 1, hours: null } }).activity.keys, true)
  // 没有等级、亲密度这类东西
  assert.equal('bond' in lifeOf({ bond: 99 }), false)
})

test('专注：开始、到点出卡（勾掉 / 再来 / 先这样），做满才算一轮；勾掉那件待办专注就结束', () => {
  let life = startFocus(emptyLife(), { id: 't1', title: '写周报' }, undefined, at(10))
  assert.equal(life.focus?.minutes, 25)
  assert.equal(startFocus(emptyLife(), { id: 't1', title: 'x' }, 500, at(10)).focus?.minutes, 90)
  const tasks = [task({ id: 't1', title: '写周报' })]
  assert.equal(lifeCards(life, tasks, at(10, 20)).length, 0) // 还没到点
  life = recordActivity(life, minutes(at(10), 20), at(10, 25))
  const card = lifeCards(life, tasks, at(10, 25))[0]
  assert.equal(card.kind, 'focus')
  assert.match(card.body, /20 分钟在用电脑/)
  assert.deepEqual(card.buttons.map(b => b.label), ['勾掉', '再来 25 分钟', '先这样'])
  // 中途停下：不算一轮
  assert.equal(stopFocus(startFocus(emptyLife(), { id: 't1', title: 'x' }, 25, at(10)), at(10, 5)).full, false)
  // 做满了：算一轮
  const done = stopFocus(life, at(10, 26))
  assert.equal(done.full, true)
  assert.equal(done.life.today.focus, 1)
  // 勾掉正在专注的那件：专注结束，并记下喂食时间
  const fed = onTasksDone(startFocus(emptyLife(), { id: 't1', title: 'x' }, 25, at(10)), ['t1'], at(10, 10))
  assert.equal(fed.focus, null)
  assert.equal(fed.lastFed, at(10, 10).toISOString())
  // 勾掉别的：专注继续
  assert.ok(onTasksDone(startFocus(emptyLife(), { id: 't1', title: 'x' }, 25, at(10)), ['t9'], at(10, 10)).focus)
})

test('工作时长：按小时汇总；按键没开时不记；空闲超过 5 分钟连续工作就断', () => {
  let life = recordActivity(emptyLife(), minutes(at(9, 50), 20, 30), at(10, 10))
  let s = todayStats(life, at(10, 10))
  assert.equal(s.activeMin, 20)
  assert.equal(s.keys, 0) // 没开按键计数
  assert.equal(s.activeByHour[9], 10)
  assert.equal(s.activeByHour[10], 10)
  assert.equal(continuousMinutes(life, at(10, 10)), 20)
  assert.equal(continuousMinutes(life, at(10, 20)), 0) // 10 分钟没动了
  // 打开按键计数后才记次数
  life = recordActivity({ ...life, activity: { ...life.activity, keys: true } }, minutes(at(10, 10), 5, 100), at(10, 15))
  s = todayStats(life, at(10, 15))
  assert.equal(s.keys, 500)
  assert.equal(s.continuousMin, 25)
  // 同一分钟报两次只算一次；未来、太久以前的丢掉
  const again = recordActivity(emptyLife(), [{ at: at(11).getTime(), active: true }, { at: at(11).getTime() + 1000, active: true }, { at: at(15).getTime(), active: true }, { at: at(11, 0, 10).getTime(), active: true }], at(11, 1))
  assert.equal(todayStats(again, at(11, 1)).activeMin, 1)
  // 空闲 6 分钟后重新开始数
  let gap = recordActivity(emptyLife(), minutes(at(13), 10), at(13, 10))
  gap = recordActivity(gap, minutes(at(13, 16), 3), at(13, 19))
  assert.equal(continuousMinutes(gap, at(13, 19)), 3)
})

test('只留 30 天的统计', () => {
  const old = { ...emptyLife(), activity: { keys: false, hours: { [hourKey(at(9, 0, 1))]: { active: 5, keys: 0 }, [hourKey(new Date(2026, 9, 1, 9))]: { active: 5, keys: 0 } } } }
  const life = recordActivity(old, minutes(at(10), 1), at(10, 1))
  assert.deepEqual(Object.keys(life.activity.hours).sort(), [hourKey(at(9, 0, 1)), hourKey(at(10))])
})

test('连续干 90 分钟提醒歇一下；休息和再干会儿；一天最多 3 次；专注时不提醒', () => {
  let life = recordActivity(emptyLife(), minutes(at(9), 95), at(10, 35))
  let cards = lifeCards(life, [], at(10, 35))
  assert.equal(cards[0].kind, 'break')
  assert.match(cards[0].title, /1 小时 35 分/)
  // 专注中不提醒
  assert.equal(lifeCards(startFocus(life, { id: 't1', title: 'x' }, 25, at(10, 30)), [], at(10, 35)).length, 0)
  // 再干会儿：30 分钟内不再提
  const later = answerBreak(life, 'later', at(10, 35))
  assert.equal(lifeCards(later, [], at(10, 50)).filter(c => c.kind === 'break').length, 0)
  // 休息：连续工作从头算，休息期间不提
  const rest = answerBreak(life, 'rest', at(10, 35))
  assert.ok(rest.rest)
  assert.equal(continuousMinutes(rest, at(10, 36)), 0)
  assert.equal(lifeDesk(rest, [], at(10, 37)).life.rest?.leftSec, 180)
  assert.equal(lifeDesk(rest, [], at(10, 41)).life.rest, null)
  // 一天最多 3 次
  life = { ...life, breaks: { day: '2026-11-12', count: 3, snoozeUntil: null } }
  assert.equal(lifeCards(life, [], at(10, 35)).length, 0)
})

test('早上问候：你在用电脑时说一次；傍晚收尾：还有没办完的才出，推到明天', () => {
  const tasks = [task({ id: 't1', title: '交周报', today: '2026-11-12' }), task({ id: 't2', title: '买牛奶', due: at(20).toISOString(), priority: 'high' }), task({ id: 't3', title: '已完成', status: 'done', doneAt: at(9).toISOString() })]
  const active = recordActivity(emptyLife(), minutes(at(8, 58), 2), at(9))
  assert.equal(morningGreeting(active, tasks, at(9)), '早！今天 2 件待办，先办「买牛奶」？')
  assert.equal(morningGreeting(emptyLife(), tasks, at(9)), null) // 你不在电脑前，不说
  assert.equal(morningGreeting({ ...active, greetedDay: '2026-11-12' }, tasks, at(9)), null)
  assert.match(String(morningGreeting(active, [], at(9))), /还没排事/)
  // 傍晚
  const life = recordActivity(emptyLife(), minutes(at(17), 30, 0), at(18, 30))
  const card = lifeCards(life, tasks, at(18, 30)).find(c => c.kind === 'evening')
  assert.ok(card)
  assert.equal(card.title, '今天工作 30 分钟，勾掉 1 件')
  assert.match(card.body, /还剩 2 件/)
  assert.equal(lifeCards({ ...life, eveningDay: '2026-11-12' }, tasks, at(18, 30)).filter(c => c.kind === 'evening').length, 0)
  assert.equal(lifeCards(life, [tasks[2]], at(18, 30)).filter(c => c.kind === 'evening').length, 0) // 都办完了就不打扰
  assert.equal(lifeCards(life, tasks, at(17, 30)).filter(c => c.kind === 'evening').length, 0) // 还没到傍晚
  const plan = eveningPlan(tasks, at(18, 30))
  assert.deepEqual(plan.map(p => p.id), ['t1', 't2'])
  assert.equal(plan[0].due.getTime(), at(9, 0, 13).getTime())
  assert.deepEqual(plan[0].before, { due: null, today: true })
})

test('统计的说法', () => {
  assert.equal(fmtDuration(45), '45 分钟')
  assert.equal(fmtDuration(370), '6 小时 10 分')
  assert.equal(fmtDuration(120), '2 小时')
  assert.equal(fmtCount(12345), '1.2万')
  assert.equal(fmtCount(20000), '2万')
  assert.equal(fmtCount(999), '999')
  const life = { ...recordActivity({ ...emptyLife(), activity: { keys: true, hours: {} } }, minutes(at(9), 10, 1500), at(9, 10)), today: { day: '2026-11-12', focus: 2 } }
  assert.equal(statsLine(life, [], at(9, 10)), '工作 10 分钟，敲了 1.5万 下，勾掉 0 件，专注 2 轮')
})

// ── 通过 Host 走一遍：/pet 和 /task、/status?desk=1 ──
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hub } from '../lib/hub.js'
import { apply as applyHost } from '../lib/host.js'

async function host() {
  hub.reset()
  /** @type {Record<string, any>} */
  const routes = {}
  const services = { schedule: { async create() { return { id: 's1' } }, async edit() { return {} }, async list() { return { items: [] } }, async remove() { return {} } } }
  const ctx = {
    webServer: { register: (/** @type {any} */ r) => { routes[r.path] = r.handler }, getOrigin: () => 'http://127.0.0.1:3999' },
    on() {},
    get: (/** @type {string} */ name) => /** @type {any} */ (services)[name],
  }
  await applyHost(ctx, { dataDir: await mkdtemp(join(tmpdir(), 'dsh-dot-life-')), pet: true })
  /** @param {string} path @param {any} body */
  const call = async (path, body, url = '/') => {
    /** @type {any} */
    let out
    const req = { url, method: body ? 'POST' : 'GET', headers: { host: '127.0.0.1:3999', 'x-dot-client': '1', 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) } }
    const res = { setHeader() {}, end: (/** @type {string} */ b) => { out = JSON.parse(b) }, statusCode: 200 }
    await routes['/api/dsh-plugin-dot/' + path](req, res)
    return { code: res.statusCode, ...out }
  }
  const desk = async () => (await call('status', null, '/api/dsh-plugin-dot/status?desk=1')).desk
  return { call, desk }
}

test('Host：专注、勾掉喂食、装扮、统计开关都走 /pet；desk 里带 life 和 stats', async () => {
  const { call, desk } = await host()
  const a = await call('task', { action: 'add', text: '写周报', today: true })
  let r = await call('pet', { action: 'focus', id: a.id })
  assert.equal(r.text, '陪你专注 25 分钟：写周报')
  let d = await desk()
  assert.equal(d.life.focus.title, '写周报')
  assert.ok(d.life.focus.leftSec > 1490)
  assert.equal(d.life.outfits.length, 7)
  assert.equal(d.life.lastFed, null)
  // 勾掉：喂了一颗星星，专注结束
  await call('task', { id: a.id, action: 'done' })
  d = await desk()
  assert.equal(d.life.focus, null)
  assert.ok(d.life.lastFed)
  // 装扮
  assert.equal((await call('pet', { action: 'outfit', id: 'scarf' })).text, '换上小围巾')
  assert.equal((await call('pet', { action: 'outfit', id: 'jetpack' })).ok, false)
  assert.equal((await desk()).life.outfit, 'scarf')
  // 统计：按键默认不数；打开后才数
  const now = Date.now()
  await call('pet', { action: 'activity', minutes: [{ at: now - 60_000, active: true, keys: 80 }] })
  d = await desk()
  assert.equal(d.stats.activeMin, 1)
  assert.equal(d.stats.keys, 0)
  assert.equal(d.stats.keysOn, false)
  r = await call('pet', { action: 'keys', on: true })
  assert.match(r.text, /只数次数/)
  await call('pet', { action: 'activity', minutes: [{ at: now, active: true, keys: 80 }] })
  d = await desk()
  assert.equal(d.stats.keys, 80)
  assert.equal(d.stats.keysOn, true)
  // 专注一件不存在的：说清楚
  assert.equal((await call('pet', { action: 'focus', id: 't999' })).ok, false)
})

test('Host：傍晚把剩下的推到明天，能撤销', async () => {
  const { call } = await host()
  const a = await call('task', { action: 'add', text: '买牛奶', today: true })
  const r = await call('pet', { action: 'evening', op: 'tomorrow' })
  assert.match(r.text, /推到明早 9 点：买牛奶/)
  assert.equal(r.undo.post, '/pet')
  let s = await call('status', null, '/api/dsh-plugin-dot/status')
  let t = s.tasks.find((/** @type {any} */ x) => x.id === a.id)
  assert.equal(t.today, false)
  assert.ok(t.due)
  await call('pet', r.undo.body)
  s = await call('status', null, '/api/dsh-plugin-dot/status')
  t = s.tasks.find((/** @type {any} */ x) => x.id === a.id)
  assert.equal(t.today, true)
  assert.equal(t.due, null)
})
