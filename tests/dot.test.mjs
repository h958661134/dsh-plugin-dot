import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, resolveConfig } from '../lib/index.js'
import { DotStore } from '../lib/store.js'
import { evaluateRules, globToRegExp } from '../lib/rules.js'
import { computeBrief, createTools, parseDue } from '../lib/tools.js'

/** 模拟 Cordis Context：只实现 dsh-dot 用到的部分。 */
function fakeCtx() {
  const tools = new Map()
  const sections = []
  const contexts = []
  const listeners = {}
  return {
    tools: { register: t => { tools.set(t.name, t) } },
    systemPrompt: {
      section: s => { sections.push(s) },
      context: c => { contexts.push(c) },
    },
    on: (event, fn) => { listeners[event] = fn },
    get: () => undefined,
    effect: () => {},
    _tools: tools, _sections: sections, _contexts: contexts, _listeners: listeners,
  }
}

async function setup(config = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-dot-'))
  const ctx = fakeCtx()
  await apply(ctx, { dataDir, timeZone: 'Asia/Shanghai', ...config })
  const call = (name, args) => ctx._tools.get(name).execute(args, {})
  const gate = (name, args, inner = { kind: 'allow' }) =>
    ctx._listeners['tools/pre-execute']({ name, arguments: args }, async () => inner)
  const contextText = () => ctx._contexts[0].text()
  return { ctx, dataDir, call, gate, contextText }
}

test('注册 7 个工具、手册 section 和动态上下文', async () => {
  const { ctx } = await setup()
  assert.deepEqual([...ctx._tools.keys()], ['dot_capture', 'dot_memory', 'dot_tasks', 'dot_rules', 'dot_brief', 'dot_suggest', 'dot_sessions'])
  assert.equal(ctx._sections.length, 1)
  assert.equal(ctx._contexts.length, 1)
  for (const tool of ctx._tools.values()) {
    assert.equal(tool.parameters.type, 'object')
    assert.ok(tool.output.schema && typeof tool.output.render === 'function')
  }
})

test('guide: false 时不注入手册', async () => {
  const { ctx } = await setup({ guide: false })
  assert.equal(ctx._sections.length, 0)
})

test('记忆：记录、去重、更新、搜索、忘记，并持久化到磁盘', async () => {
  const { call, dataDir, contextText } = await setup()
  const r1 = await call('dot_memory', { action: 'remember', text: '用户喜欢简短的回答', category: 'preference' })
  assert.match(r1.summary, /m1/)
  const dup = await call('dot_memory', { action: 'remember', text: '用户喜欢简短的回答' })
  assert.match(dup.summary, /已存在/)
  await call('dot_memory', { action: 'remember', text: '用户的同事老王负责财务', category: 'person' })
  await call('dot_memory', { action: 'update', id: 'm2', text: '用户的同事王强负责财务' })
  const found = await call('dot_memory', { action: 'search', query: '王强' })
  assert.match(found.summary, /m2/)
  assert.match(contextText(), /用户喜欢简短的回答/)

  const disk = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'))
  assert.equal(disk.memories.length, 2)

  await call('dot_memory', { action: 'forget', id: 'm1' })
  assert.doesNotMatch(contextText(), /简短/)
  await assert.rejects(call('dot_memory', { action: 'forget', id: 'm99' }), /没有记忆/)
})

test('记忆上限', async () => {
  const { call } = await setup({ maxMemories: 1 })
  await call('dot_memory', { action: 'remember', text: 'a' })
  await assert.rejects(call('dot_memory', { action: 'remember', text: 'b' }), /上限/)
})

test('事务：新增、更新状态、列表过滤', async () => {
  const { call, contextText } = await setup()
  await call('dot_tasks', { action: 'add', title: '订周五的会议室', priority: 'high', due: '2026-11-14 10:00' })
  await call('dot_tasks', { action: 'add', title: '等供应商报价', owner: 'user' })
  await call('dot_tasks', { action: 'update', id: 't2', status: 'waiting', notes: '已发邮件' })
  let list = await call('dot_tasks', { action: 'list' })
  assert.match(list.summary, /t1.*订周五/)
  assert.match(list.summary, /等待中/)
  assert.match(contextText(), /订周五的会议室/)

  await call('dot_tasks', { action: 'update', id: 't1', status: 'done' })
  list = await call('dot_tasks', { action: 'list' })
  assert.doesNotMatch(list.summary, /订周五/)
  list = await call('dot_tasks', { action: 'list', include_closed: true })
  assert.match(list.summary, /已完成/)
})

test('截止时间解析', () => {
  assert.equal(parseDue(undefined), undefined)
  assert.equal(parseDue(''), null)
  assert.equal(parseDue('2026-11-12T09:00+08:00'), '2026-11-12T01:00:00.000Z')
  assert.ok(parseDue('2026-11-12'))
  assert.ok(parseDue('2026-11-12 9:30'))
  assert.throws(() => parseDue('下周三'), /无法解析/)
})

test('简报分组：逾期 / 即将到期 / 高优先级 / 委派', () => {
  const now = new Date('2026-11-10T12:00:00Z')
  const t = (id, extra) => ({ id, title: id, notes: '', status: 'open', priority: 'normal', owner: 'user', due: null, createdAt: '', updatedAt: '', doneAt: null, ...extra })
  const state = {
    tasks: [
      t('t1', { due: '2026-11-09T00:00:00Z' }),
      t('t2', { due: '2026-11-10T20:00:00Z' }),
      t('t3', { priority: 'high' }),
      t('t4', { owner: 'delegated', status: 'waiting' }),
      t('t5', { status: 'done', doneAt: '2026-11-10T08:00:00Z' }),
    ],
  }
  const b = computeBrief(state, now, 24)
  assert.deepEqual(b.overdue.map(x => x.id), ['t1'])
  assert.deepEqual(b.dueSoon.map(x => x.id), ['t2'])
  assert.deepEqual(b.highPriority.map(x => x.id), ['t3'])
  assert.deepEqual(b.delegated.map(x => x.id), ['t4'])
  assert.deepEqual(b.doneRecently.map(x => x.id), ['t5'])
  assert.equal(b.active.length, 4)
})

test('dot_brief 输出', async () => {
  const { call } = await setup()
  const empty = await call('dot_brief', {})
  assert.match(empty.summary, /没有待办/)
  await call('dot_tasks', { action: 'add', title: '交季度报告', due: '2020-01-01' })
  const brief = await call('dot_brief', {})
  assert.match(brief.summary, /已逾期（1）/)
})

test('规则匹配：通配、大小写、最严格优先', () => {
  assert.ok(globToRegExp('web_*').test('WEB_fetch'))
  assert.ok(!globToRegExp('web_*').test('pwsh'))
  assert.ok(globToRegExp('a.b').test('a.b') && !globToRegExp('a.b').test('axb'))
  const rules = [
    { tool: '*', decision: 'ask' },
    { tool: 'web_*', decision: 'allow' },
    { tool: 'web_fetch', decision: 'block' },
  ]
  assert.equal(evaluateRules('web_fetch', rules).decision, 'block')
  assert.equal(evaluateRules('web_search', rules).decision, 'ask')
  assert.equal(evaluateRules('x', []), null)
})

test('闸门：block 拒绝、ask 请求确认、allow 放行、尊重内层拒绝', async () => {
  const { call, gate } = await setup({ rules: [{ tool: 'pwsh', decision: 'block', note: '别动我的电脑' }] })
  assert.equal((await gate('pwsh', {})).kind, 'deny')
  assert.equal((await gate('web_fetch', {})).kind, 'allow')

  // 直接写 store 以绕过 dot_rules 的确认流程（确认由闸门负责，单测里不经过它）。
  await call('dot_rules', { action: 'add', tool: 'web_*', decision: 'ask', note: '上网前问我' })
  assert.equal((await gate('web_fetch', {})).kind, 'ask')
  const innerDeny = { kind: 'deny', reason: 'sandbox' }
  assert.equal(await gate('web_fetch', {}, innerDeny), innerDeny)

  await call('dot_rules', { action: 'add', tool: 'schedule_*', decision: 'allow' })
  assert.equal((await gate('schedule_create', {})).kind, 'allow')
})

test('闸门：修改规则永远需要确认，查看规则不需要', async () => {
  const { gate } = await setup({ rules: [{ tool: 'dot_*', decision: 'allow' }] })
  assert.equal((await gate('dot_rules', { action: 'add', tool: 'x', decision: 'allow' })).kind, 'ask')
  assert.equal((await gate('dot_rules', { action: 'remove', id: 'r1' })).kind, 'ask')
  assert.equal((await gate('dot_rules', { action: 'list' })).kind, 'allow')
})

test('dot_rules：拒绝危险规则，配置规则不可删除', async () => {
  const { call } = await setup({ rules: [{ tool: 'pwsh', decision: 'ask' }] })
  await assert.rejects(call('dot_rules', { action: 'add', tool: 'dot_rules', decision: 'allow' }), /不能/)
  await assert.rejects(call('dot_rules', { action: 'add', tool: '*', decision: 'block' }), /不能/)
  await assert.rejects(call('dot_rules', { action: 'remove', id: 'c1' }), /配置/)
  const list = await call('dot_rules', { action: 'list', check_tool: 'pwsh' })
  assert.match(list.summary, /配置固定/)
  assert.match(list.summary, /pwsh → ask/)
})

test('配置校验', () => {
  assert.throws(() => resolveConfig({ dataDir: 'relative/path' }), /绝对路径/)
  assert.throws(() => resolveConfig({ timeZone: 'Mars/Base' }), /未知时区/)
  assert.throws(() => resolveConfig({ rules: [{ tool: 'x', decision: 'maybe' }] }), /decision/)
  assert.throws(() => resolveConfig({ maxMemories: -1 }), /非负整数/)
  const c = resolveConfig({})
  assert.match(c.dataDir, /dot$/)
  assert.equal(c.maxMemories, 200)
})

test('存储：并发写串行化，id 不冲突', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dot-'))
  const store = new DotStore(join(dir, 'state.json'))
  const tools = createTools(store, { maxMemories: 1000, timeZone: 'UTC' }, [])
  const memory = tools.find(t => t.name === 'dot_memory')
  await Promise.all(Array.from({ length: 20 }, (_, i) => memory.execute({ action: 'remember', text: `第 ${i} 条` })))
  const ids = store.snapshot().memories.map(m => m.id)
  assert.equal(new Set(ids).size, 20)
  const reloaded = new DotStore(join(dir, 'state.json'))
  await reloaded.load()
  assert.equal(reloaded.snapshot().memories.length, 20)
  assert.equal(reloaded.snapshot().nextId.m, 21)
})

test('存储：写入失败时状态回滚，后续写入不受影响', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dot-'))
  const store = new DotStore(join(dir, 'state.json'))
  await assert.rejects(store.mutate(s => { s.memories.push({ id: 'x' }); throw new Error('boom') }), /boom/)
  assert.equal(store.snapshot().memories.length, 0)
  await store.mutate((s, newId) => { s.tasks.push({ id: newId('t') }) })
  assert.equal(store.snapshot().tasks.length, 1)
})

test('存储：损坏的文件被另存，不覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dot-'))
  const file = join(dir, 'state.json')
  await writeFile(file, '{ not json')
  const store = new DotStore(file)
  await store.load()
  assert.ok(store.recoveredFrom)
  const files = await readdir(dir)
  assert.ok(files.some(f => f.includes('.corrupt-')))
  assert.equal(store.snapshot().memories.length, 0)
})
