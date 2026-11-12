import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNumber, parseWhen } from '../lib/when.js'

// 2026-11-10 是周二，本地时间 14:20。
const NOW = new Date(2026, 10, 10, 14, 20)
const fmt = d => `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

function check(input, expectedTime, expectedRest) {
  const r = parseWhen(input, NOW)
  assert.ok(r, `应能解析：${input}`)
  assert.equal(fmt(r.at), expectedTime, input)
  if (expectedRest !== undefined) assert.equal(r.rest, expectedRest, input)
}

test('中文数字', () => {
  assert.equal(parseNumber('九'), 9)
  assert.equal(parseNumber('十'), 10)
  assert.equal(parseNumber('十二'), 12)
  assert.equal(parseNumber('二十三'), 23)
  assert.equal(parseNumber('两'), 2)
  assert.equal(parseNumber('15'), 15)
  assert.ok(Number.isNaN(parseNumber('abc')))
})

test('相对时间', () => {
  check('30分钟后 喝水', '11-10 14:50', '喝水')
  check('半小时后提醒我开会', '11-10 14:50', '提醒我开会')
  check('两个小时以后 出门', '11-10 16:20', '出门')
  check('3天后 续费', '11-13 14:20', '续费')
})

test('日期词 + 钟点', () => {
  check('明天9点 交周报', '11-11 09:00', '交周报')
  check('明早 跑步', '11-11 08:00', '跑步')
  check('明晚8点半 看电影', '11-11 20:30', '看电影')
  check('今晚 给妈妈打电话', '11-10 20:00', '给妈妈打电话')
  check('后天下午三点 开会', '11-12 15:00')
  check('大后天 中午1点 吃饭', '11-13 13:00')
  check('明天 交报告', '11-11 09:00', '交报告')
})

test('星期', () => {
  check('周五18点 交周报', '11-13 18:00', '交周报')
  check('星期二 上午10点 例会', '11-10 10:00')
  check('周一 例会', '11-16 09:00')
  check('下周三 体检', '11-18 09:00')
  check('下周二 复诊', '11-17 09:00')
  check('礼拜天 爬山', '11-15 09:00')
})

test('具体日期', () => {
  check('11月12日 交房租', '11-12 09:00', '交房租')
  check('12月1号 下午2点 面试', '12-1 14:00', '面试')
  check('2026-11-20 09:30 提交材料', '11-20 09:30', '提交材料')
  check('11/15 生日', '11-15 09:00', '生日')
  check('3月8日 老婆生日', '3-8 09:00') // 已过，理解为明年
  assert.equal(parseWhen('3月8日 老婆生日', NOW).at.getFullYear(), 2027)
})

test('只有钟点', () => {
  check('21:30 关灯', '11-10 21:30', '关灯')
  check('9点 开会', '11-11 09:00') // 今天 9 点已过，顺延到明早
  check('3点 开会', '11-10 15:00')
  check('下午5点 下班打卡', '11-10 17:00')
  check('九点一刻 站会', '11-11 09:15')
})

test('解析不出时返回 null', () => {
  assert.equal(parseWhen('交周报', NOW), null)
  assert.equal(parseWhen('买3份早餐', NOW), null)
  assert.equal(parseWhen('', NOW), null)
})

test('过去的时间被标记', () => {
  assert.equal(parseWhen('今天上午9点 开会', NOW).past, true)
  assert.equal(parseWhen('明天9点 开会', NOW).past, false)
})

test('昨天、前天：补记过去的事，日期往前算，不会被当成明天', () => {
  const now = new Date(2026, 10, 12, 13, 0)
  const y = parseWhen('昨天10点 交季度报告', now)
  assert.equal(y?.at.getTime(), new Date(2026, 10, 11, 10, 0).getTime())
  assert.equal(y?.rest, '交季度报告')
  assert.equal(y?.past, true)
  assert.equal(parseWhen('前天下午3点 开会', now)?.at.getTime(), new Date(2026, 10, 10, 15, 0).getTime())
  assert.equal(parseWhen('昨晚 写日记', now)?.at.getHours(), 20)
})
