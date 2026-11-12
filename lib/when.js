// @ts-check
/**
 * 轻量中文时间解析：从一句话里找出时间表达，返回绝对时间和去掉时间后的剩余文字。
 *
 * 支持：
 *   相对：30分钟后 / 半小时后 / 2小时以后 / 3天后
 *   日期：今天 明天 后天 大后天 / 昨天 前天 大前天（补记过去的事）/ 今晚 明早 明晚 昨晚 / 周五 星期三 礼拜天 / 下周二 /
 *         11月12日 11月12号 / 11-12 11/12 / 2026-11-12
 *   时段：凌晨 早上 上午 中午 下午 傍晚 晚上
 *   钟点：9点 9点半 9点15 9点一刻 十点 21:30 9：30
 * 解析不了就返回 null，调用方不应猜测。按宿主本地时区计算。
 */

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/** @param {string} text 阿拉伯数字或 0–99 的中文数字 */
export function parseNumber(text) {
  if (/^\d+$/.test(text)) return Number(text)
  if (text === '半') return 0.5
  if (!/^[零〇一二两三四五六七八九十]+$/.test(text)) return NaN
  if (!text.includes('十')) return text.length === 1 ? CN_DIGITS[text] : NaN
  const [tens, ones] = text.split('十')
  return (tens ? CN_DIGITS[tens] : 1) * 10 + (ones ? CN_DIGITS[ones] : 0)
}

const NUM = '(?:\\d{1,3}|[零〇一二两三四五六七八九十]{1,3})'
const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 七: 0 }

const RELATIVE = new RegExp(`(${NUM}|半)\\s*(?:个)?\\s*(分钟|分|小时|钟头|天)\\s*(?:后|以后|之后)`)
const DAY_WORD = /(大后天|后天|明天|今天|明早|明晚|今晚|今早|大前天|前天|昨天|昨晚)/
const WEEK = /(下下|下个?|这个?|本)?(?:周|星期|礼拜)([一二三四五六日天七])/
const MONTH_DAY = new RegExp(`(?:(\\d{4})[-/年])?(${NUM})月(${NUM})[日号]?`)
const ISO_DAY = /(?:(\d{4})-)?(\d{1,2})[-/](\d{1,2})(?![:\d])/
const PERIOD = /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)/
const CLOCK = new RegExp(`(${NUM})\\s*(?:[:：](\\d{2})|点(?:钟)?\\s*(半|一刻|三刻|(${NUM})(?:分)?)?)`)

const PERIOD_DEFAULT_HOUR = { 凌晨: 6, 早上: 8, 早晨: 8, 上午: 9, 中午: 12, 下午: 15, 傍晚: 18, 晚上: 20, 夜里: 22 }

/**
 * timeGiven：说了具体时刻（钟点、时段或「30分钟后」）；只说了日期（今天、周五）时为 false，at 用当天 9 点占位。
 * @typedef {{ at: Date, rest: string, matched: string[], past: boolean, timeGiven: boolean }} WhenResult
 */

/**
 * @param {string} input
 * @param {Date} [now]
 * @returns {WhenResult | null}
 */
export function parseWhen(input, now = new Date()) {
  let rest = input
  /** @type {string[]} */
  const matched = []
  const take = (/** @type {RegExpMatchArray} */ m) => {
    matched.push(m[0])
    rest = rest.replace(m[0], ' ')
  }

  // 1. 相对时间：直接得出结果。
  const rel = rest.match(RELATIVE)
  if (rel) {
    const n = parseNumber(rel[1])
    if (Number.isFinite(n) && n > 0) {
      take(rel)
      const unit = rel[2]
      const ms = unit === '天' ? 86_400_000 : unit === '小时' || unit === '钟头' ? 3_600_000 : 60_000
      return finish(new Date(now.getTime() + n * ms), true)
    }
  }

  // 2. 日期。
  /** @type {Date | null} */
  let day = null
  /** @type {string | null} */
  let impliedPeriod = null
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const addDays = (/** @type {number} */ d) => new Date(startOfToday.getFullYear(), startOfToday.getMonth(), startOfToday.getDate() + d)

  const dw = rest.match(DAY_WORD)
  if (dw) {
    take(dw)
    const word = dw[1]
    const offset = { 今天: 0, 今早: 0, 今晚: 0, 明天: 1, 明早: 1, 明晚: 1, 后天: 2, 大后天: 3, 昨天: -1, 昨晚: -1, 前天: -2, 大前天: -3 }[word]
    day = addDays(offset)
    if (word.endsWith('早')) impliedPeriod = '早上'
    if (word.endsWith('晚')) impliedPeriod = '晚上'
  }

  if (!day) {
    const wk = rest.match(WEEK)
    if (wk) {
      take(wk)
      const target = WEEKDAY[wk[2]]
      const today = now.getDay()
      // 以周一为一周开始：周日记为 7。
      const t = target === 0 ? 7 : target
      const d = today === 0 ? 7 : today
      const prefix = wk[1] ?? ''
      let offset
      if (prefix.startsWith('下下')) offset = 14 - d + t
      else if (prefix.startsWith('下')) offset = 7 - d + t
      else offset = t >= d ? t - d : 7 - d + t
      day = addDays(offset)
    }
  }

  if (!day) {
    const md = rest.match(MONTH_DAY) ?? rest.match(ISO_DAY)
    if (md) {
      const month = parseNumber(md[2])
      const date = parseNumber(md[3])
      if (month >= 1 && month <= 12 && date >= 1 && date <= 31) {
        take(md)
        let year = md[1] ? Number(md[1]) : now.getFullYear()
        let candidate = new Date(year, month - 1, date)
        // 没写年份且日期已过：理解为明年。
        if (!md[1] && candidate < startOfToday) candidate = new Date(++year, month - 1, date)
        day = candidate
      }
    }
  }

  // 3. 时段与钟点。
  const pm = rest.match(PERIOD)
  if (pm) take(pm)
  const period = pm?.[1] ?? impliedPeriod

  /** @type {number | null} */
  let hour = null
  let minute = 0
  const ck = rest.match(CLOCK)
  if (ck) {
    const h = parseNumber(ck[1])
    let m = 0
    if (ck[2]) m = Number(ck[2])
    else if (ck[3] === '半') m = 30
    else if (ck[3] === '一刻') m = 15
    else if (ck[3] === '三刻') m = 45
    else if (ck[4]) m = parseNumber(ck[4])
    if (Number.isInteger(h) && h >= 0 && h <= 24 && Number.isInteger(m) && m >= 0 && m < 60) {
      take(ck)
      hour = h
      minute = m
    }
  }

  if (hour !== null && period) {
    if ((period === '下午' || period === '傍晚' || period === '晚上' || period === '夜里') && hour < 12) hour += 12
    if (period === '中午' && hour < 3) hour += 12
  }
  if (hour === null && period) hour = PERIOD_DEFAULT_HOUR[period]

  if (!day && hour === null) return null

  const timeGiven = hour !== null
  if (hour === null) hour = 9
  if (!day) {
    day = startOfToday
    // 只说了钟点且今天已过：理解为明天；但没写时段的 1–6 点在下午时优先理解为今天下午（“3点开会”）。
    const today = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute)
    if (today <= now && !period && hour >= 1 && hour <= 6) {
      const pmToday = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour + 12, minute)
      if (pmToday > now) return finish(pmToday, timeGiven)
    }
    if (today <= now) day = addDays(1)
  }
  return finish(new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute), timeGiven)

  /** @param {Date} at @param {boolean} timeGiven */
  function finish(at, timeGiven) {
    return { at, rest: rest.replace(/\s+/g, ' ').trim(), matched, past: at.getTime() <= now.getTime(), timeGiven }
  }
}
