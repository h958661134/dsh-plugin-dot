// 角标只数需要你处理的事；收纳建议记住你的选择（撤销过的、忽略过的不再提）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { patrol, keptSessions } from '../lib/suggest.js'

const DAY = 86_400_000
const now = new Date('2026-11-12T08:00:00Z')
const t = now.getTime()
const stale = ['a', 'b', 'c', 'd'].map(id => ({ id, title: `会话 ${id}` }))
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString()

/** @param {any[]} suggestions */
const stateWith = suggestions => /** @type {any} */ ({ tasks: [], suggestions })
/** @param {any} state @param {any[]} list */
const tidyOf = (state, list = stale) => patrol(state, { now, schedules: null, others: [], stale: list }).drafts.find(d => d.kind === 'tidy')

test('收纳：撤销过收起的会话 30 天内不再提议收起', () => {
  const undo = {
    id: 's3', key: 'undo-archive:a,b,c', kind: 'undo', source: 'system', status: 'accepted', outcome: '撤销：放回 3 个会话',
    createdAt: iso(t - DAY), resolvedAt: iso(t - DAY), options: [{ label: '撤销', action: { type: 'unarchive', ids: ['a', 'b', 'c'] } }],
  }
  // 只剩 d 一个候选，不够 3 个，不提
  assert.equal(tidyOf(stateWith([undo])), undefined)
  // 又多了两个新的旧会话：只提新的，不带撤销过的
  const more = [...stale, { id: 'e', title: '会话 e' }, { id: 'f', title: '会话 f' }]
  assert.deepEqual(tidyOf(stateWith([undo]), more)?.options[0].action.ids, ['d', 'e', 'f'])
  // 30 天后可以再提
  const old = { ...undo, resolvedAt: iso(t - 31 * DAY) }
  assert.deepEqual(tidyOf(stateWith([old]))?.options[0].action.ids, ['a', 'b', 'c', 'd'])
})

test('收纳：你忽略的 7 天内不再提；自动收起的不算你的选择', () => {
  const action = { type: 'archive', ids: ['a', 'b', 'c', 'd'] }
  const ignored = { id: 's4', key: 'tidy:2026-11-11', kind: 'tidy', source: 'patrol', status: 'dismissed', outcome: '你忽略了', createdAt: iso(t - DAY), resolvedAt: iso(t - DAY), options: [{ label: '收起来', action }] }
  assert.equal(tidyOf(stateWith([ignored])), undefined, '第二天换了 key 也不再提')
  assert.ok(tidyOf(stateWith([{ ...ignored, resolvedAt: iso(t - 8 * DAY) }])), '7 天后再提')
  const auto = { ...ignored, outcome: '情况变了，已自动收起' }
  assert.ok(tidyOf(stateWith([auto])), '自动收起的照常提')
  assert.deepEqual([...keptSessions([auto], t)], [])
})

test('收纳：还挂着的旧建议，候选被你留下后自动收起（角标随之消失）', () => {
  const undo = {
    id: 's3', key: 'undo-archive:a,b,c', kind: 'undo', source: 'system', status: 'accepted',
    createdAt: iso(t - DAY), resolvedAt: iso(t - DAY), options: [{ label: '撤销', action: { type: 'unarchive', ids: ['a', 'b', 'c'] } }],
  }
  const open = { id: 's4', key: 'tidy:2026-11-12', kind: 'tidy', source: 'patrol', status: 'open', createdAt: iso(t), resolvedAt: null, options: [] }
  const { isStale } = patrol(stateWith([undo, open]), { now, schedules: null, others: [], stale })
  assert.equal(isStale(/** @type {any} */ (open)), true)
})

test('角标：建议不计数（网页小精灵只亮小点，桌面精灵不举包裹）', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /var need = cards\.filter\(function \(c\) \{ return c\.kind !== "suggestions"; \}\)/)
  assert.match(client, /if \(need\.length\) badgeText = String\(need\.length\)/)
  const ps = readFileSync(new URL('../lib/desktop/pet-win.ps1', import.meta.url), 'utf8')
  assert.match(ps, /\$NoCarry = @\('suggestions', 'focus', 'break', 'evening'\)/)
  assert.match(ps, /\$NoCarry -notcontains \[string\]\$_\.kind/)
})

test('Dot 窗口：「今天」标签只数需要你处理的（待你批准、通知），不数建议', () => {
  const bridge = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
  assert.match(bridge, /var todayN = s \? s\.decisions\.length \+ s\.notices\.length : 0;/)
  assert.doesNotMatch(bridge, /counts\.decisions \|\| 0\) \+ \(\(s && s\.suggestions\)/)
})

test('桌面精灵：空卡片不能被 PowerShell 包成 1 张（$null 也会计数）', () => {
  const ps = readFileSync(new URL('../lib/desktop/pet-win.ps1', import.meta.url), 'utf8')
  // 刷新时取卡片、举包裹时过滤，两处都要先把 $null 去掉
  assert.match(ps, /\$desk\.cards\) \| Where-Object \{ \$null -ne \$_ \}/)
  assert.match(ps, /Where-Object \{ \$null -ne \$_ -and \$NoCarry -notcontains/)
})
