// @ts-check
/**
 * 周期时间解析：从一句话里找出「每天 / 工作日 / 每周几 / 每隔多久」，
 * 返回 DSH 定时服务能直接用的 timing，以及去掉时间后的剩余文字。
 *
 *   每天9点 喝水 · 天天晚上10点半 · 工作日18点 · 周末上午10点 · 每周一三五 9:30
 *   每周日晚上8点 · 每30分钟 · 每隔2小时 · 每半小时 · 每小时 · 每3天
 *
 * 看不懂就返回 null，调用方不应猜测。
 */

import { parseNumber } from './when.js'

const NUM = '(?:\\d{1,3}|[零〇一二两三四五六七八九十]{1,3})'
const WD = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 七: 7 }
const PERIOD_SHIFT = { 凌晨: 0, 早上: 0, 早晨: 0, 上午: 0, 中午: 12, 下午: 12, 傍晚: 12, 晚上: 12, 夜里: 12 }

const INTERVAL = new RegExp(`每(?:隔)?\\s*(${NUM}|半)?\\s*(?:个)?\\s*(分钟|分|小时|钟头|天)`)
const DAILY = /(每天|天天|每日)/
const WORKDAY = /(每个?工作日|工作日)/
const WEEKEND = /(每个?周末|周末)/
const WEEKLY = /每(?:个)?(?:周|星期|礼拜)([一二三四五六日天七、,，和及]+)/
const CLOCK = new RegExp(`(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)?\\s*(${NUM})\\s*(?:[:：](\\d{2})|点(?:钟)?\\s*(半|一刻|三刻|(${NUM})(?:分)?)?)`)

/**
 * @typedef {{
 *   timing: { kind: 'every', every_seconds: number }
 *     | { kind: 'daily', daily: { time: string, time_zone: string } }
 *     | { kind: 'weekly', weekly: { time: string, time_zone: string, weekdays: number[] } },
 *   label: string,
 *   rest: string,
 * }} RepeatResult
 */

/**
 * @param {string} input
 * @param {string} timeZone IANA 时区
 * @returns {RepeatResult | null}
 */
export function parseRepeat(input, timeZone) {
  let rest = ` ${input} `
  const take = (/** @type {RegExpMatchArray} */ m) => { rest = rest.replace(m[0], ' ') }

  // 每隔多久：没有钟点
  const iv = rest.match(INTERVAL)
  if (iv && !DAILY.test(iv[0])) {
    const n = iv[1] === undefined ? 1 : parseNumber(iv[1])
    const unit = iv[2]
    const sec = unit.startsWith('分') ? 60 : unit === '天' ? 86_400 : 3600
    const total = Math.round(n * sec)
    if (Number.isFinite(total) && total >= 60 && !(unit === '天' && CLOCK.test(rest.replace(iv[0], ' ')))) {
      take(iv)
      return { timing: { kind: 'every', every_seconds: total }, label: `每${/^[0-9]/.test(labelSeconds(total)) ? ' ' : ''}${labelSeconds(total)}`, rest: clean(rest) }
    }
  }

  /** @type {number[] | null} */
  let weekdays = null
  let label = ''
  const wk = rest.match(WEEKLY)
  const wd = rest.match(WORKDAY)
  const we = rest.match(WEEKEND)
  const dy = rest.match(DAILY)
  if (wk) {
    const days = [...new Set([...wk[1]].map(c => WD[/** @type {keyof typeof WD} */ (c)]).filter(Boolean))].sort((a, b) => a - b)
    if (!days.length) return null
    weekdays = days
    label = `每周${days.map(d => '一二三四五六日'[d - 1]).join('、')}`
    take(wk)
  } else if (wd) {
    weekdays = [1, 2, 3, 4, 5]
    label = '工作日'
    take(wd)
  } else if (we) {
    weekdays = [6, 7]
    label = '周末'
    take(we)
  } else if (dy) {
    label = '每天'
    take(dy)
  } else {
    return null
  }

  let hour = 9
  let minute = 0
  const ck = rest.match(CLOCK)
  if (ck) {
    hour = parseNumber(ck[2])
    if (ck[3]) minute = Number(ck[3])
    else if (ck[4] === '半') minute = 30
    else if (ck[4] === '一刻') minute = 15
    else if (ck[4] === '三刻') minute = 45
    else if (ck[5]) minute = parseNumber(ck[5])
    const shift = ck[1] ? PERIOD_SHIFT[/** @type {keyof typeof PERIOD_SHIFT} */ (ck[1])] : 0
    if (shift && hour < 12) hour += shift
    if (ck[1] === '凌晨' && hour === 12) hour = 0
    if (!Number.isInteger(hour) || hour > 23 || !Number.isInteger(minute) || minute > 59) return null
    take(ck)
  }
  const time = `${pad(hour)}:${pad(minute)}:00`
  label += ` ${pad(hour)}:${pad(minute)}`
  const timing = weekdays
    ? /** @type {const} */ ({ kind: 'weekly', weekly: { time, time_zone: timeZone, weekdays } })
    : /** @type {const} */ ({ kind: 'daily', daily: { time, time_zone: timeZone } })
  return { timing, label, rest: clean(rest) }
}

/** @param {number} n */
function pad(n) {
  return String(n).padStart(2, '0')
}

/** @param {string} s */
function clean(s) {
  return s.replace(/\s+/g, ' ').replace(/^[\s，,：:、]+|[\s，,。]+$/g, '').trim()
}

/** @param {number} sec */
export function labelSeconds(sec) {
  if (sec % 86_400 === 0) return sec === 86_400 ? '天' : `${sec / 86_400} 天`
  if (sec % 3600 === 0) return sec === 3600 ? '小时' : `${sec / 3600} 小时`
  if (sec === 1800) return '半小时'
  if (sec === 60) return '分钟'
  return `${Math.round(sec / 60)} 分钟`
}
