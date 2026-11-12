// @ts-check
/**
 * 桌宠的「生活」：专注、早晚问候、休息提醒、工作时长和按键统计、装扮。
 * 全是纯计算，不调模型、不碰网络；数据存在 state.prefs.life。
 * 设计见 docs/DESK-BUDDY.md。没有等级、亲密度、连续天数——它不是打卡工具。
 *
 * 隐私：按键只有次数，没有键值；统计按小时汇总，保留 30 天。
 */
import { bucketOf, dayKey, snoozeTo } from './todo.js'

/** 装扮：一开始全部可选 */
export const OUTFITS = /** @type {const} */ ([
  ['none', '不戴'], ['scarf', '小围巾'], ['leaf', '头顶小叶子'], ['cap', '鸭舌帽'],
  ['headphones', '耳机'], ['bow', '蝴蝶结'], ['crown', '小皇冠'],
])
const OUTFIT_IDS = new Set(OUTFITS.map(o => o[0]))

export const FOCUS_DEFAULT = 25
export const BREAK_AFTER_MIN = 90      // 连续工作多久提醒休息
export const BREAK_MAX_PER_DAY = 3
export const BREAK_LATER_MIN = 30      // 点「再干会儿」后多久再提醒
export const REST_MIN = 5
export const IDLE_GAP_MIN = 5          // 中间空闲超过这么久，连续工作就断了
export const KEEP_DAYS = 30
const MIN = 60_000

/**
 * @typedef {{ taskId: string, title: string, startedAt: string, until: string, minutes: number, activeMin: number }} Focus
 * @typedef {{
 *   outfit: string,
 *   focus: Focus | null,
 *   rest: { until: string } | null,
 *   today: { day: string, focus: number },
 *   greetedDay: string | null,
 *   eveningDay: string | null,
 *   breaks: { day: string, count: number, snoozeUntil: string | null },
 *   run: { start: string, last: string } | null,
 *   lastFed: string | null,
 *   activity: { keys: boolean, hours: Record<string, { active: number, keys: number }> },
 * }} Life
 */

/** @returns {Life} */
export function emptyLife() {
  return {
    outfit: 'none', focus: null, rest: null, today: { day: '', focus: 0 }, greetedDay: null, eveningDay: null,
    breaks: { day: '', count: 0, snoozeUntil: null }, run: null, lastFed: null, activity: { keys: false, hours: {} },
  }
}

/**
 * 从 prefs 里读出 life，缺的字段补默认值（旧数据、手改坏的数据都能用）。
 * @param {any} raw
 * @returns {Life}
 */
export function lifeOf(raw) {
  const e = emptyLife()
  if (!raw || typeof raw !== 'object') return e
  const hours = raw.activity && typeof raw.activity.hours === 'object' && raw.activity.hours ? raw.activity.hours : {}
  return {
    outfit: OUTFIT_IDS.has(raw.outfit) ? raw.outfit : 'none',
    focus: raw.focus && typeof raw.focus.taskId === 'string' && raw.focus.until ? { activeMin: 0, ...raw.focus } : null,
    rest: raw.rest && raw.rest.until ? { until: String(raw.rest.until) } : null,
    today: raw.today && typeof raw.today.day === 'string' ? { day: raw.today.day, focus: Number(raw.today.focus) || 0 } : e.today,
    greetedDay: typeof raw.greetedDay === 'string' ? raw.greetedDay : null,
    eveningDay: typeof raw.eveningDay === 'string' ? raw.eveningDay : null,
    breaks: raw.breaks && typeof raw.breaks.day === 'string' ? { day: raw.breaks.day, count: Number(raw.breaks.count) || 0, snoozeUntil: raw.breaks.snoozeUntil ?? null } : e.breaks,
    run: raw.run && raw.run.start && raw.run.last ? { start: String(raw.run.start), last: String(raw.run.last) } : null,
    lastFed: typeof raw.lastFed === 'string' ? raw.lastFed : null,
    activity: { keys: Boolean(raw.activity?.keys), hours },
  }
}

/** 本地时间的小时键：2026-11-12T14 @param {Date} d */
export function hourKey(d) {
  return `${dayKey(d)}T${String(d.getHours()).padStart(2, '0')}`
}

/** 今天的计数：换了一天就从 0 开始 @param {Life} life @param {Date} now */
function todayOf(life, now) {
  const day = dayKey(now)
  return life.today.day === day ? life.today : { day, focus: 0 }
}

// ── 专注 ────────────────────────────────────────────────────

/**
 * @param {Life} life @param {{ id: string, title: string }} task @param {number | undefined} minutes @param {Date} now
 * @returns {Life}
 */
export function startFocus(life, task, minutes, now) {
  const m = Math.min(90, Math.max(5, Math.round(Number(minutes) || FOCUS_DEFAULT)))
  return {
    ...life, rest: null,
    focus: { taskId: task.id, title: task.title, startedAt: now.toISOString(), until: new Date(now.getTime() + m * MIN).toISOString(), minutes: m, activeMin: 0 },
  }
}

/**
 * 结束专注。做满了的算一轮（只是给傍晚收尾卡看的数字，不是成绩）。
 * @param {Life} life @param {Date} now
 * @returns {{ life: Life, full: boolean }}
 */
export function stopFocus(life, now) {
  if (!life.focus) return { life, full: false }
  const full = now.getTime() >= new Date(life.focus.until).getTime()
  const today = todayOf(life, now)
  return { life: { ...life, focus: null, today: full ? { ...today, focus: today.focus + 1 } : today }, full }
}

// ── 完成待办：喂一颗星星 ──────────────────────────────────────

/**
 * 有待办被勾掉：记下时间（精灵据此播放吃星星）；正在专注的那件被勾掉了，专注也就结束了。
 * @param {Life} life @param {string[]} doneIds @param {Date} now
 * @returns {Life}
 */
export function onTasksDone(life, doneIds, now) {
  if (!doneIds.length) return life
  let next = { ...life, lastFed: now.toISOString() }
  if (next.focus && doneIds.includes(next.focus.taskId)) next = stopFocus(next, now).life
  return next
}

// ── 工作时长和按键 ────────────────────────────────────────────

/**
 * 精灵每分钟上报一次：这一分钟有没有在用电脑、按了几下键。
 * 只存按小时的汇总；按键计数没开时忽略 keys。顺带维护「连续工作」和专注里的活跃分钟。
 * @param {Life} life
 * @param {{ at: string | number, active: boolean, keys?: number }[]} minutes
 * @param {Date} now
 * @returns {Life}
 */
export function recordActivity(life, minutes, now) {
  const hours = { ...life.activity.hours }
  let run = life.run
  let focus = life.focus
  const seen = new Set()
  const list = (Array.isArray(minutes) ? minutes : [])
    .map(m => ({ at: new Date(typeof m.at === 'number' ? m.at : String(m.at)), active: Boolean(m.active), keys: Math.max(0, Math.min(5000, Math.round(Number(m.keys) || 0))) }))
    .filter(m => Number.isFinite(m.at.getTime()) && m.at.getTime() <= now.getTime() + MIN && now.getTime() - m.at.getTime() < 24 * 60 * MIN)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(-120)
  for (const m of list) {
    const minuteKey = Math.floor(m.at.getTime() / MIN)
    if (seen.has(minuteKey)) continue
    seen.add(minuteKey)
    if (!m.active && !m.keys) continue
    const k = hourKey(m.at)
    const h = hours[k] ?? { active: 0, keys: 0 }
    hours[k] = { active: Math.min(60, h.active + (m.active ? 1 : 0)), keys: h.keys + (life.activity.keys ? m.keys : 0) }
    if (m.active) {
      const t = m.at.getTime()
      if (run && t - new Date(run.last).getTime() <= IDLE_GAP_MIN * MIN && t >= new Date(run.start).getTime()) run = { start: run.start, last: new Date(Math.max(t, new Date(run.last).getTime())).toISOString() }
      else run = { start: m.at.toISOString(), last: m.at.toISOString() }
      if (focus && t >= new Date(focus.startedAt).getTime() && t < new Date(focus.until).getTime()) focus = { ...focus, activeMin: Math.min(focus.minutes, focus.activeMin + 1) }
    }
  }
  // 只留 30 天
  const cutoff = hourKey(new Date(now.getTime() - KEEP_DAYS * 24 * 60 * MIN))
  for (const k of Object.keys(hours)) if (k < cutoff) delete hours[k]
  return { ...life, run, focus, activity: { ...life.activity, hours } }
}

/** 连续工作了多少分钟（最近 5 分钟内没动过就是 0） @param {Life} life @param {Date} now */
export function continuousMinutes(life, now) {
  if (!life.run) return 0
  const last = new Date(life.run.last).getTime()
  if (now.getTime() - last > IDLE_GAP_MIN * MIN) return 0
  return Math.round((last - new Date(life.run.start).getTime()) / MIN) + 1
}

/**
 * 今天的统计：工作分钟、按键次数、按小时（0~23）的工作分钟和按键。
 * @param {Life} life @param {Date} now
 */
export function todayStats(life, now) {
  const day = dayKey(now)
  /** @type {number[]} */
  const activeByHour = Array(24).fill(0)
  /** @type {number[]} */
  const keysByHour = Array(24).fill(0)
  for (const [k, v] of Object.entries(life.activity.hours)) {
    if (!k.startsWith(day + 'T')) continue
    const h = Number(k.slice(-2))
    if (h >= 0 && h < 24) { activeByHour[h] = v.active; keysByHour[h] = v.keys }
  }
  return {
    activeMin: activeByHour.reduce((a, b) => a + b, 0),
    keys: keysByHour.reduce((a, b) => a + b, 0),
    keysOn: life.activity.keys,
    continuousMin: continuousMinutes(life, now),
    activeByHour, keysByHour,
  }
}

/** 6 小时 10 分 @param {number} min */
export function fmtDuration(min) {
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m} 分钟`
  return `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ''}`
}
/** 1.2 万 @param {number} n */
export function fmtCount(n) {
  return n >= 10_000 ? `${(n / 10_000).toFixed(1).replace(/\.0$/, '')}万` : String(n)
}

/** 今天的一句话统计：「工作 6 小时 10 分，敲了 1.2 万下，勾掉 5 件」 @param {Life} life @param {any[]} tasks @param {Date} now */
export function statsLine(life, tasks, now) {
  const s = todayStats(life, now)
  const done = doneToday(tasks, now)
  /** @type {string[]} */
  const parts = []
  if (s.activeMin) parts.push(`工作 ${fmtDuration(s.activeMin)}`)
  if (s.keysOn && s.keys) parts.push(`敲了 ${fmtCount(s.keys)} 下`)
  parts.push(`勾掉 ${done} 件`)
  const focus = todayOf(life, now).focus
  if (focus) parts.push(`专注 ${focus} 轮`)
  return parts.join('，')
}

/** @param {any[]} tasks @param {Date} now */
function doneToday(tasks, now) {
  const day = dayKey(now)
  return tasks.filter(t => t.status === 'done' && t.doneAt && dayKey(new Date(t.doneAt)) === day).length
}
/** 今天还没办完的（今天和逾期的） @param {any[]} tasks @param {Date} now */
export function leftToday(tasks, now) {
  return tasks.filter(t => t.status === 'open' && ['today', 'overdue'].includes(bucketOf(t, now)))
}

// ── 卡片和问候 ────────────────────────────────────────────────

/**
 * 早上的问候：5 点以后、今天还没问候过、你刚刚在用电脑（最近 2 分钟有输入）。
 * @param {Life} life @param {any[]} tasks @param {Date} now
 * @returns {string | null}
 */
export function morningGreeting(life, tasks, now) {
  if (now.getHours() < 5 || now.getHours() >= 12) return null
  if (life.greetedDay === dayKey(now)) return null
  if (!life.run || now.getTime() - new Date(life.run.last).getTime() > 2 * MIN) return null
  const left = leftToday(tasks, now).sort((a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1))
  if (!left.length) return '早！今天还没排事。想到什么，拖到我身上就记下了。'
  return `早！今天 ${left.length} 件待办，先办「${left[0].title}」？`
}

/**
 * 桌宠自己的卡片：专注到点、该歇一会儿、傍晚收尾。和「需要你」的卡片放在一起。
 * @param {Life} life @param {any[]} tasks @param {Date} now
 * @returns {import('./petcards.js').DeskCard[]}
 */
export function lifeCards(life, tasks, now) {
  /** @type {import('./petcards.js').DeskCard[]} */
  const cards = []
  const t = now.getTime()
  const f = life.focus
  if (f && t >= new Date(f.until).getTime()) {
    const task = tasks.find(x => x.id === f.taskId)
    const open = task && (task.status === 'open' || task.status === 'waiting')
    cards.push({
      key: `focus:${f.startedAt}`, kind: 'focus',
      title: `专注 ${f.minutes} 分钟到了：「${f.title}」`,
      body: f.activeMin ? `这 ${f.minutes} 分钟里有 ${f.activeMin} 分钟在用电脑。` : '起来走走，喝口水。',
      buttons: [
        ...(open ? [{ label: '勾掉', main: true, op: { post: '/task', body: { id: f.taskId, action: 'done' } } }] : []),
        { label: `再来 ${f.minutes} 分钟`, op: { post: '/pet', body: { action: 'focus', id: f.taskId, minutes: f.minutes } } },
        { label: '先这样', op: { post: '/pet', body: { action: 'focus-stop' } } },
      ],
    })
  }
  const cont = continuousMinutes(life, now)
  const day = dayKey(now)
  const breaks = life.breaks.day === day ? life.breaks : { day, count: 0, snoozeUntil: null }
  const snoozed = breaks.snoozeUntil && t < new Date(breaks.snoozeUntil).getTime()
  const resting = life.rest && t < new Date(life.rest.until).getTime()
  if (!f && !resting && cont >= BREAK_AFTER_MIN && breaks.count < BREAK_MAX_PER_DAY && !snoozed) {
    cards.push({
      key: `break:${life.run?.start}:${breaks.count}`, kind: 'break',
      title: `已经连续干了 ${fmtDuration(cont)}`,
      body: '起来走走、喝口水？我陪你歇 5 分钟，到点叫你。',
      buttons: [
        { label: `休息 ${REST_MIN} 分钟`, main: true, op: { post: '/pet', body: { action: 'break', op: 'rest' } } },
        { label: '再干会儿', op: { post: '/pet', body: { action: 'break', op: 'later' } } },
      ],
    })
  }
  if (now.getHours() >= 18 && life.eveningDay !== day) {
    const left = leftToday(tasks, now)
    if (left.length) {
      cards.push({
        key: `evening:${day}`, kind: 'evening',
        title: `今天${statsLine(life, tasks, now)}`,
        body: `还剩 ${left.length} 件：${left.slice(0, 3).map(x => `「${x.title}」`).join('')}${left.length > 3 ? ' 等' : ''}`,
        buttons: [
          { label: '剩下的推到明天', main: true, op: { post: '/pet', body: { action: 'evening', op: 'tomorrow' } } },
          { label: '知道了', op: { post: '/pet', body: { action: 'evening', op: 'dismiss' } } },
        ],
      })
    }
  }
  return cards
}

/**
 * 傍晚「剩下的推到明天」要改哪些：返回每件的新时间和撤销用的旧值。
 * @param {any[]} tasks @param {Date} now
 */
export function eveningPlan(tasks, now) {
  const due = /** @type {Date} */ (snoozeTo('tomorrow', now))
  return leftToday(tasks, now).map(t => ({ id: t.id, title: t.title, due, before: { due: t.due ?? null, today: Boolean(t.today) } }))
}

/**
 * 休息提醒的两个按钮。
 * @param {Life} life @param {'rest' | 'later'} op @param {Date} now
 * @returns {Life}
 */
export function answerBreak(life, op, now) {
  const day = dayKey(now)
  const breaks = life.breaks.day === day ? life.breaks : { day, count: 0, snoozeUntil: null }
  if (op === 'rest') {
    // 休息：计一次提醒；连续工作从头算
    return { ...life, rest: { until: new Date(now.getTime() + REST_MIN * MIN).toISOString() }, run: null, breaks: { ...breaks, count: breaks.count + 1, snoozeUntil: null } }
  }
  return { ...life, breaks: { ...breaks, count: breaks.count + 1, snoozeUntil: new Date(now.getTime() + BREAK_LATER_MIN * MIN).toISOString() } }
}

/**
 * 给精灵的一包：装扮、专注、休息、最近一次喂食、今天的统计、问候、卡片。
 * @param {Life} life @param {any[]} tasks @param {Date} now
 */
export function lifeDesk(life, tasks, now) {
  const f = life.focus
  const rest = life.rest && now.getTime() < new Date(life.rest.until).getTime() ? life.rest : null
  return {
    life: {
      outfit: life.outfit,
      outfits: OUTFITS.map(([id, label]) => ({ id, label })),
      focus: f ? { taskId: f.taskId, title: f.title, startedAt: f.startedAt, until: f.until, minutes: f.minutes, leftSec: Math.max(0, Math.round((new Date(f.until).getTime() - now.getTime()) / 1000)) } : null,
      rest: rest ? { until: rest.until, leftSec: Math.round((new Date(rest.until).getTime() - now.getTime()) / 1000) } : null,
      lastFed: life.lastFed,
    },
    stats: { ...todayStats(life, now), line: statsLine(life, tasks, now) },
    greeting: morningGreeting(life, tasks, now),
    cards: lifeCards(life, tasks, now),
  }
}
