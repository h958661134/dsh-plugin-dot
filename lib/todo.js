// @ts-check
/**
 * 待办闭环的纯计算，不碰存储、不调模型，方便测试。
 *
 *   收：一句话记下（时间、周期、优先级都从这句话里读）
 *   理：逾期 / 今天 / 之后 / 收件箱 / 等别人，五个分组
 *   做：拆小步骤、放进今天、交给 Dot
 *   跟：等别人时到点追问，推迟一键改期
 *   结：完成可撤销；周期待办完成后自动生成下一次；关联的会话跑完时提示收尾
 *
 * 另外放了会话标题的好坏判断：没标题、临时标题、太笼统、太长、重名。
 */

import { parseWhen } from './when.js'

const DAY = 86_400_000
const pad2 = (/** @type {number} */ n) => String(n).padStart(2, '0')
/** @param {Date} d */
const hm = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`

/**
 * 口语里的模糊时间（parseWhen 不管的）：等会、下班前、睡前、周末、下周、月底。
 * 返回时间和去掉这个词后的文字；没有就返回 null。
 * @param {string} text @param {Date} now
 * @returns {{ at: Date | null, today?: boolean, rest: string, word: string } | null}
 */
function fuzzyWhen(text, now) {
  const at = (/** @type {number} */ addDays, /** @type {number} */ h, m = 0) => {
    const d = new Date(now)
    d.setDate(d.getDate() + addDays)
    d.setHours(h, m, 0, 0)
    return d
  }
  /** 今天这个点过了就明天 @param {number} h @param {number} [m] */
  const todayOrNext = (h, m = 0) => { const d = at(0, h, m); return d > now ? d : at(1, h, m) }
  /** @type {[RegExp, () => { at: Date | null, today?: boolean }][]} */
  const rules = [
    [/(等一?会儿?|待一?会儿?|一会儿|过一?会儿?|稍后|晚点)/, () => ({ at: new Date(now.getTime() + 30 * 60_000) })],
    [/下班(?:前|之前|以前)?/, () => ({ at: todayOrNext(18) })],
    [/下班(?:后|以后|之后)/, () => ({ at: todayOrNext(18, 30) })],
    [/睡(?:觉)?前/, () => ({ at: todayOrNext(22) })],
    [/(?<!每个?)(?:这个?)?周末/, () => {
      const wd = now.getDay()
      if (wd === 6 || wd === 0) return { at: null, today: true } // 已经是周末：就是今天
      return { at: at(6 - wd, 10) }
    }],
    [/下个?周(?![一二三四五六日天七])|下个?星期(?![一二三四五六日天七])/, () => ({ at: at(((8 - now.getDay()) % 7) || 7, 9) })],
    [/(?:这个?|本)?月底/, () => {
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0, 18, 0, 0, 0)
      return last > now ? { at: last } : { at: null, today: true }
    }],
  ]
  for (const [re, make] of rules) {
    const m = re.exec(text)
    if (m) return { ...make(), rest: text.replace(m[0], ' ').replace(/\s+/g, ' ').trim(), word: m[0] }
  }
  return null
}

/**
 * 待办的时间：先记下，提醒只是可选项，时间模糊也不报错。
 *
 *   没说时间          → 没有截止时间；inbox=true 进收件箱（todayIfNone 时放进今天）
 *   只说了今天        → 放进今天，不定时、不提醒
 *   只说了以后某天    → 截止那天，那天早上 9 点提醒
 *   说了具体时刻      → 到点提醒
 *   今天的时刻已经过了 → 没写上午 / 下午的上午钟点，改成晚上同一钟点（「今天9点」10 点说 = 21:00）；
 *                       否则放进今天、不提醒，并说清楚为什么
 *
 * @param {string} text
 * @param {Date} now
 * @returns {{ rest: string, due: Date | null, today: boolean, remind: boolean, note: string }}
 */
export function parseTodoTime(text, now) {
  const when = parseWhen(text, now)
  if (!when) {
    const f = fuzzyWhen(text, now)
    if (f?.at) return { rest: f.rest, due: f.at, today: false, remind: true, note: '' }
    if (f?.today) return { rest: f.rest, due: null, today: true, remind: false, note: '' }
    return { rest: text, due: null, today: false, remind: false, note: '' }
  }
  const isToday = dayKey(when.at) === dayKey(now)
  if (!when.timeGiven) {
    if (isToday) return { rest: when.rest, due: null, today: true, remind: false, note: '' }
    // 明确写了已经过去的日期（补记一件逾期的事）：照记，算逾期，不提醒
    if (when.at.getTime() < now.getTime()) return { rest: when.rest, due: when.at, today: false, remind: false, note: '' }
    return { rest: when.rest, due: when.at, today: false, remind: true, note: '' }
  }
  if (!when.past) return { rest: when.rest, due: when.at, today: false, remind: true, note: '' }
  // 说了今天的某个时刻，但已经过了
  const h = when.at.getHours()
  const saidPeriod = when.matched.some(m => /凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|今早|今晚/.test(m))
  if (!saidPeriod && h < 12) {
    const pm = new Date(when.at.getTime() + 12 * 3600_000)
    if (pm > now) return { rest: when.rest, due: pm, today: false, remind: true, note: `${hm(when.at)} 已经过了，按晚上 ${hm(pm)} 算` }
  }
  return { rest: when.rest, due: null, today: true, remind: false, note: `${hm(when.at)} 已经过了，先放进今天的待办` }
}

/** 本地日期 YYYY-MM-DD（和 parseWhen 一样用本机时区） @param {Date} d */
export function dayKey(d) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** @param {Date} d */
function endOfDay(d) {
  const e = new Date(d)
  e.setHours(23, 59, 59, 999)
  return e
}

/**
 * 周期待办的下一次截止时间：严格晚于 after。看不懂就返回 null。
 * timing 是 parseRepeat 的结果（every / daily / weekly），时间按本机时区算。
 * @param {any} timing
 * @param {Date} after
 * @returns {Date | null}
 */
export function nextDue(timing, after) {
  if (!timing || typeof timing !== 'object') return null
  if (timing.kind === 'every') {
    const sec = Number(timing.every_seconds)
    if (!Number.isFinite(sec) || sec < 60) return null
    return new Date(after.getTime() + sec * 1000)
  }
  const spec = timing.kind === 'daily' ? timing.daily : timing.kind === 'weekly' ? timing.weekly : null
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(spec?.time ?? ''))
  if (!m) return null
  /** @type {Set<number> | null} ISO 星期：1 = 周一 … 7 = 周日 */
  const days = timing.kind === 'weekly' ? new Set((spec.weekdays ?? []).map(Number)) : null
  if (days && !days.size) return null
  for (let i = 0; i <= 8; i++) {
    const d = new Date(after)
    d.setDate(d.getDate() + i)
    d.setHours(Number(m[1]), Number(m[2]), 0, 0)
    if (d.getTime() <= after.getTime()) continue
    if (days && !days.has(d.getDay() === 0 ? 7 : d.getDay())) continue
    return d
  }
  return null
}

/** @typedef {import('./store.js').Task} Task */
/** @typedef {'overdue' | 'today' | 'upcoming' | 'inbox' | 'waiting'} Bucket */

/**
 * 一件进行中的待办该放在哪个分组。
 * @param {Task} t @param {Date} now
 * @returns {Bucket}
 */
export function bucketOf(t, now) {
  if (t.status === 'waiting') return 'waiting'
  if (t.due && new Date(t.due).getTime() < now.getTime()) return 'overdue'
  if (t.today === dayKey(now)) return 'today'
  if (t.due && new Date(t.due).getTime() <= endOfDay(now).getTime()) return 'today'
  if (t.due) return 'upcoming'
  return 'inbox'
}

export const BUCKETS = /** @type {const} */ ([
  ['overdue', '逾期'], ['today', '今天'], ['upcoming', '之后'], ['inbox', '收件箱'], ['waiting', '等别人'],
])

/**
 * 分组并在组内排序：逾期、今天、之后按截止时间；收件箱按优先级再按新旧；等别人按追问时间。
 * @param {Task[]} tasks 进行中的（open / waiting）
 * @param {Date} now
 */
export function todoBuckets(tasks, now) {
  /** @type {Record<Bucket, Task[]>} */
  const out = { overdue: [], today: [], upcoming: [], inbox: [], waiting: [] }
  for (const t of tasks) if (t.status === 'open' || t.status === 'waiting') out[bucketOf(t, now)].push(t)
  const rank = { high: 0, normal: 1, low: 2 }
  const byDue = (/** @type {Task} */ a, /** @type {Task} */ b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || rank[a.priority] - rank[b.priority]
  const byPri = (/** @type {Task} */ a, /** @type {Task} */ b) => rank[a.priority] - rank[b.priority] || b.createdAt.localeCompare(a.createdAt)
  out.overdue.sort(byDue)
  out.today.sort((a, b) => rank[a.priority] - rank[b.priority] || (a.due ?? '9999').localeCompare(b.due ?? '9999'))
  out.upcoming.sort(byDue)
  out.inbox.sort(byPri)
  out.waiting.sort(byDue)
  return out
}

/**
 * 「推迟」的几个预设：返回新的截止时间。
 * @param {string} preset '1h' | 'tonight' | 'tomorrow' | 'weekend' | 'nextweek'
 * @param {Date} now
 * @returns {Date | null}
 */
export function snoozeTo(preset, now) {
  const d = new Date(now)
  switch (preset) {
    case '30m': return new Date(now.getTime() + 30 * 60_000)
    case '1h': return new Date(now.getTime() + 3600_000)
    case 'offwork': {
      d.setHours(18, 0, 0, 0)
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
      return d
    }
    case 'tonight':
      d.setHours(20, 0, 0, 0)
      return d.getTime() > now.getTime() ? d : new Date(now.getTime() + 3600_000)
    case 'tomorrow':
      d.setDate(d.getDate() + 1)
      d.setHours(9, 0, 0, 0)
      return d
    case 'weekend': {
      const add = (6 - d.getDay() + 7) % 7 || 7 // 下一个周六
      d.setDate(d.getDate() + add)
      d.setHours(10, 0, 0, 0)
      return d
    }
    case 'nextweek': {
      const add = ((8 - d.getDay()) % 7) || 7 // 下一个周一
      d.setDate(d.getDate() + add)
      d.setHours(9, 0, 0, 0)
      return d
    }
    default: return null
  }
}

/**
 * 小步骤的进度。
 * @param {Task} t
 * @returns {{ done: number, total: number } | null}
 */
export function stepProgress(t) {
  const steps = Array.isArray(t.steps) ? t.steps : []
  if (!steps.length) return null
  return { done: steps.filter(s => s.done).length, total: steps.length }
}

/**
 * 一件待办给界面的样子（网页和桌面精灵共用）。
 * @param {Task} t @param {Date} now
 */
export function todoView(t, now) {
  return {
    id: t.id, title: t.title, notes: t.notes ?? '', due: t.due, priority: t.priority, owner: t.owner, status: t.status,
    bucket: bucketOf(t, now),
    overdue: Boolean(t.due && t.status !== 'waiting' && new Date(t.due).getTime() < now.getTime()),
    today: t.today === dayKey(now),
    steps: Array.isArray(t.steps) ? t.steps.map(s => ({ text: s.text, done: Boolean(s.done) })) : [],
    repeat: t.repeat?.label ?? null,
    waitingOn: t.waitingOn ?? '',
    linkedSession: t.linkedSession ?? null,
  }
}

// ── 会话标题 ────────────────────────────────────────────────

const GENERIC = /^(你好|您好|hi|hello|hey|在吗|继续|接着|go on|continue|test|测试|试试|问一下|帮我|help|请问|嗯|好的|ok|新会话|new session|未命名会话|untitled)[!！。.?？\s]*$/i

/**
 * 标题有什么问题；没问题返回 null。
 * @param {string} title
 * @param {{ temp?: boolean, dup?: boolean }} [flags] temp：还没有正式标题，是从第一句话截的；dup：和别的会话重名
 */
export function titleIssue(title, flags = {}) {
  const t = String(title ?? '').trim()
  if (!t) return '没有标题'
  if (flags.temp) return '临时标题'
  if (GENERIC.test(t) || [...t].length <= 2) return '标题太笼统'
  if (flags.dup) return '和别的会话重名'
  if ([...t].length > 36) return '标题太长'
  return null
}

/**
 * 从第一句话截一个临时标题：去掉换行和多余空白，最多 24 个字。
 * @param {string} text
 */
export function tempTitle(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const chars = [...t]
  return chars.length > 24 ? `${chars.slice(0, 24).join('')}…` : t
}

const PLACEHOLDER = /^新会话( · \d\d:\d\d)?$/

/**
 * 没有任何文字时的兜底：「新会话 · 14:05」，至少能分清是哪个。
 * @param {number} startedAt
 */
export function placeholderTitle(startedAt) {
  const d = new Date(startedAt)
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0')
  return Number.isFinite(d.getTime()) ? `新会话 · ${p(d.getHours())}:${p(d.getMinutes())}` : '新会话'
}

/**
 * 一组会话里，哪些名字需要整理。
 * @param {{ id: string, title: string, titleTemp?: boolean }[]} list
 * @returns {Map<string, string>} id → 问题
 */
export function titleIssues(list) {
  /** @type {Map<string, number>} */
  const seen = new Map()
  for (const o of list) {
    const k = String(o.title ?? '').trim()
    if (k) seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  /** @type {Map<string, string>} */
  const out = new Map()
  for (const o of list) {
    // 一句话都还没说的空会话：没有内容可起名，不算
    if (o.titleTemp && PLACEHOLDER.test(String(o.title ?? ''))) continue
    const issue = titleIssue(o.title, { temp: Boolean(o.titleTemp), dup: (seen.get(String(o.title ?? '').trim()) ?? 0) > 1 })
    if (issue) out.set(o.id, issue)
  }
  return out
}

export { DAY }
