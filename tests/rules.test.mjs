import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { BUILTIN_RULES, evaluate, globToRegExp, ruleMatches } from '../lib/rules.js'
import { checkRouteChange, resolveRoutes } from '../lib/routes.js'
import { normalizeState } from '../lib/store.js'
import { hub, petStatus } from '../lib/hub.js'
import { explainVerdict } from '../lib/host.js'

function fakeCtx() {
  const tools = new Map()
  const listeners = {}
  return {
    tools: { register: t => { tools.set(t.name, t) } },
    systemPrompt: { section: () => {}, context: c => { listeners._context = c } },
    on: (event, fn) => { listeners[event] = fn },
    get: () => undefined,
    effect: () => {},
    _tools: tools, _listeners: listeners,
  }
}

async function setup(config = {}) {
  hub.reset()
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-dot-rules-'))
  const ctx = fakeCtx()
  await apply(ctx, { dataDir, timeZone: 'Asia/Shanghai', ...config })
  const call = (name, args) => ctx._tools.get(name).execute(args, {})
  const gate = (name, args, inner = { kind: 'allow' }) =>
    ctx._listeners['tools/pre-execute']({ name, arguments: args, agent: { id: 'root-1' } }, async () => inner)
  return { ctx, call, gate, contextText: () => ctx._listeners._context.text() }
}

test('工具名模式支持 | 写多个；关键词匹配参数', () => {
  assert.ok(globToRegExp('web_*|pwsh').test('pwsh'))
  assert.ok(globToRegExp('web_*|pwsh').test('web_fetch'))
  assert.ok(!globToRegExp('web_*|pwsh').test('bash'))
  const rule = { id: 'r1', tool: 'send_email', decision: 'preapproved', match: 'boss@x.com|周报' }
  assert.ok(ruleMatches(rule, 'send_email', '{"to":"boss@x.com"}'))
  assert.ok(!ruleMatches(rule, 'send_email', '{"to":"someone@else"}'))
})

test('内置硬规则：付钱和密码交给你，发消息和删除先问，Dot 自己的账本和只读工具不看', () => {
  assert.equal(evaluate('browser_click', { text: '确认支付' }, []).decision, 'handoff')
  assert.equal(evaluate('fill_form', { field: 'password' }, []).decision, 'handoff')
  assert.equal(evaluate('send_email', { to: 'a@b.c' }, []).decision, 'ask')
  assert.equal(evaluate('file_delete', { path: 'x' }, []).decision, 'ask')
  assert.equal(evaluate('pwsh', { command: 'Remove-Item -Recurse foo' }, []).decision, 'ask')
  assert.equal(evaluate('pwsh', { command: 'Get-ChildItem' }, []).decision, null)
  // 「记一件事：周五付款」不是付款
  const v = evaluate('dot_tasks', { action: 'add', title: '周五付款给供应商' }, [])
  assert.equal(v.decision, null)
  assert.ok(v.exempt)
  assert.equal(evaluate('web_search', { query: '信用卡 比较' }, []).decision, null)
  assert.equal(evaluate('send_message', { text: '去查付款流程' }, []).decision, null)
  assert.equal(BUILTIN_RULES.every(r => /^b\d+$/.test(r.id)), true)
})

test('合并顺序：用户 block > handoff > 用户 ask > 内置 ask（可被 preapproved 抵消）> preapproved > allow', () => {
  const pre = { id: 'r1', tool: 'send_email', decision: 'preapproved', match: 'boss@x.com' }
  assert.equal(evaluate('send_email', { to: 'boss@x.com' }, [pre]).decision, 'preapproved')
  assert.equal(evaluate('send_email', { to: 'other@x.com' }, [pre]).decision, 'ask')
  // 不带关键词的 preapproved 抵消不了 handoff；带关键词收窄的可以覆盖（你亲口加的放行）
  const preWide = { id: 'r2', tool: '*', decision: 'preapproved' }
  assert.equal(evaluate('browser_click', { text: '支付' }, [preWide]).decision, 'handoff')
  const preShop = { id: 'r5', tool: 'browser_*', decision: 'preapproved', match: 'shop.example.com' }
  const over = evaluate('browser_click', { text: '支付', url: 'shop.example.com' }, [preShop])
  assert.deepEqual([over.decision, over.overrides], ['preapproved', 'b1'])
  assert.equal(evaluate('browser_click', { text: '支付', url: 'other.com' }, [preShop]).decision, 'handoff')
  // 过期的规则不生效
  assert.equal(evaluate('send_email', {}, [{ ...pre, match: undefined, until: '2000-01-01T00:00:00Z' }]).decision, 'ask')
  // 用户 ask 比 preapproved 严格
  const ask = { id: 'r3', tool: 'send_*', decision: 'ask' }
  assert.equal(evaluate('send_email', { to: 'boss@x.com' }, [pre, ask]).rule.id, 'r3')
  // 用户 block 最严
  const block = { id: 'r4', tool: 'browser_click', decision: 'block' }
  const v = evaluate('browser_click', { text: '支付' }, [block])
  assert.equal(v.decision, 'block')
  assert.deepEqual(v.hits.map(x => x.id).sort(), ['b1', 'r4'])
  assert.match(explainVerdict('browser_click', v), /拦下.*同时命中 b1/)
  assert.match(explainVerdict('glob', evaluate('glob', {}, [])), /没有规则命中/)
})

test('闸门：handoff 拒绝并通知你，命中都记下来', async () => {
  const { gate } = await setup()
  const r = await gate('browser_click', { text: '立即支付 ¥99' })
  assert.equal(r.kind, 'deny')
  assert.match(r.reason, /必须由用户亲自完成/)
  const n = hub.notices().find(x => x.kind === 'handoff')
  assert.ok(n)
  assert.match(n.text, /付钱/)
  assert.equal((await gate('send_email', { to: 'x' })).kind, 'ask')
  assert.equal((await gate('glob', {})).kind, 'allow')
  const stats = hub.ruleStats()
  assert.equal(stats.gate.handoff, 1)
  assert.equal(stats.gate.ask, 1)
  assert.equal(stats.gate.pass, 1)
  assert.equal(stats.counts.b1, 1)
  assert.equal(stats.counts.b3, 1)
  assert.equal(stats.recent[0].tool, 'send_email') // 最新的在前；放行的不进最近列表
  assert.equal(stats.recent.length, 2)
})

test('闸门：preapproved 不加问，但仍尊重 DSH 自己的审批', async () => {
  const { gate, call } = await setup()
  await call('dot_rules', { action: 'add', tool: 'send_email', decision: 'preapproved', match: 'boss@x.com', note: '给老板发周报不用问' })
  assert.equal((await gate('send_email', { to: 'boss@x.com' })).kind, 'allow')
  const inner = { kind: 'ask', reason: 'dsh' }
  assert.equal(await gate('send_email', { to: 'boss@x.com' }, inner), inner)
  assert.equal((await gate('send_email', { to: 'x@y.z' })).kind, 'ask')
})

test('dot_rules：内置规则删不掉；* 只能带关键词放行；list 能模拟参数', async () => {
  const { call, contextText } = await setup()
  await assert.rejects(call('dot_rules', { action: 'remove', id: 'b1' }), /内置/)
  await assert.rejects(call('dot_rules', { action: 'add', tool: '*', decision: 'preapproved' }), /match/)
  const ok = await call('dot_rules', { action: 'add', tool: '*', decision: 'preapproved', match: '周报' })
  assert.match(ok.summary, /参数含 周报/)
  const list = await call('dot_rules', { action: 'list', check_tool: 'browser_click', check_args: '去支付' })
  assert.match(list.summary, /\[内置\]/)
  assert.match(list.summary, /browser_click → handoff（命中 b1/)
  assert.match(contextText(), /内置安全规则/)
  assert.match(contextText(), /参数含 周报/)
})

test('通知路由：默认值、只存改过的、锁定项不能关', () => {
  const r = resolveRoutes(undefined)
  assert.equal(r.decision.card, true)
  assert.equal(r.child.card, false)
  assert.equal(resolveRoutes({ routes: { due: { system: true } } }).due.system, true)
  assert.equal(resolveRoutes({ routes: { decision: { card: false } } }).decision.card, true)
  assert.throws(() => checkRouteChange('decision', 'card'), /不能关/)
  assert.throws(() => checkRouteChange('nope', 'card'), /未知事件/)
  assert.throws(() => checkRouteChange('child', 'fax'), /未知通知渠道/)
  assert.throws(() => checkRouteChange('child', 'card'), /只在小精灵气泡/)
  assert.equal(resolveRoutes({ routes: { child: { card: true } } }).child.card, false)
  const s = normalizeState({ prefs: { routes: { other: { bubble: false, junk: 'x' } } } })
  assert.deepEqual(s.prefs.routes, { other: { bubble: false } })
  assert.deepEqual(normalizeState({}).prefs, { routes: {} })
})

test('通知路由：关掉气泡后小精灵不再为这类事冒泡', () => {
  hub.reset()
  const state = normalizeState({})
  hub.flash('「写报告」跑完了', 'other')
  assert.equal(petStatus(state, new Date()).bubble, '「写报告」跑完了')
  const off = resolveRoutes({ routes: { other: { bubble: false } } })
  const s = petStatus(state, new Date(), { routes: off })
  assert.notEqual(s.bubble, '「写报告」跑完了')
  assert.equal(s.routes.other.bubble, false)
  hub.flash('完成：交周报') // Dot 自己完成事务总是显示
  assert.equal(petStatus(state, new Date(), { routes: off }).bubble, '完成：交周报')
})
