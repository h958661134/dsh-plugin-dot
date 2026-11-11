// 自检（SELF-REVIEW-v0.7）里每一条修复的回归测试。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { evaluate } from '../lib/rules.js'
import { hub, pathsOf } from '../lib/hub.js'
import { apply as applyHost } from '../lib/host.js'
import { apply as applyPreset } from '../lib/index.js'
import { DotStore } from '../lib/store.js'
import { createActions } from '../lib/actions.js'

beforeEach(() => hub.reset())

async function hostSetup(extra = {}) {
  const routes = {}
  const listeners = {}
  const created = []
  const services = {
    schedule: { async create(req) { created.push(req); return { id: `sch-${created.length}` } }, async edit() {}, async list() { return { items: [] } } },
    ...extra,
  }
  const ctx = {
    webServer: { register: r => { routes[r.path] = r.handler }, getOrigin: () => 'http://127.0.0.1:3999' },
    on: (event, fn) => { listeners[event] = fn },
    get: name => services[name],
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-dot-fix-'))
  await applyHost(ctx, { dataDir })
  return { routes, listeners, created, dataDir, ctx }
}
async function call(handler, body) {
  const req = {
    method: body ? 'POST' : 'GET',
    headers: { host: '127.0.0.1:3999', 'x-dot-client': '1', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) },
  }
  let out
  const res = { setHeader() {}, end: b => { out = JSON.parse(b) }, statusCode: 200 }
  await handler(req, res)
  return { code: res.statusCode, ...out }
}
const wait = ms => new Promise(r => setTimeout(r, ms))

test('#1 #3 内置规则：写文件、改代码、跑命令的内容不扫关键词；run_code 删文件先问；只读邮件工具不拦', () => {
  assert.equal(evaluate('write', { path: 'a.md', content: '下周付款给供应商' }, []).decision, null)
  assert.equal(evaluate('edit', { path: 'login.ts', new: 'password' }, []).decision, null)
  assert.equal(evaluate('apply_patch', { input: '+ const password = 1' }, []).decision, null)
  assert.equal(evaluate('bash', { command: 'grep -r password src' }, []).decision, null)
  // b5 只看命令本身，不看说明文字
  assert.equal(evaluate('pwsh', { command: 'ls', description: 'remove-item 不会真的执行' }, []).decision, null)
  assert.equal(evaluate('run_code', { code: 'import shutil; shutil.rmtree("x")' }, []).rule.id, 'b5')
  assert.equal(evaluate('gmail_list_messages', { q: 'x' }, []).decision, null)
  assert.equal(evaluate('gmail_send', { to: 'x' }, []).rule.id, 'b3')
  // 对外动作照样拦
  assert.equal(evaluate('browser_navigate', { url: 'https://x.com/checkout' }, []).decision, 'handoff')
})

test('#2 带关键词的 preapproved 可以覆盖内置「交给你」，并记进命中记录', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-dot-fix-'))
  const listeners = {}
  const tools = new Map()
  const ctx = {
    tools: { register: t => { tools.set(t.name, t) } },
    systemPrompt: { section() {}, context() {} },
    on: (e, fn) => { listeners[e] = fn }, get: () => undefined, effect() {},
  }
  await applyPreset(ctx, { dataDir })
  await tools.get('dot_rules').execute({ action: 'add', tool: 'browser_*', decision: 'preapproved', match: 'shop.example.com', until: new Date(Date.now() + 86_400_000).toISOString() })
  const gate = (name, args) => listeners['tools/pre-execute']({ name, arguments: args, agent: { id: 'root' } }, async () => ({ kind: 'allow' }))
  assert.equal((await gate('browser_navigate', { url: 'https://shop.example.com/checkout' })).kind, 'allow')
  assert.equal((await gate('browser_navigate', { url: 'https://other.com/checkout' })).kind, 'deny')
  const recent = hub.ruleStats().recent
  assert.match(recent.find(x => x.stage === 'preapproved').note, /放行了内置规则 b1/)
  await assert.rejects(tools.get('dot_rules').execute({ action: 'add', tool: 'x', decision: 'allow', until: '2000-01-01T00:00:00Z' }), /已经过去/)
})

test('#4 apply_patch 的补丁文本里解析出文件', () => {
  assert.deepEqual(pathsOf({ input: '*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: b.md\n*** End Patch' }), ['src/a.ts', 'b.md'])
  assert.deepEqual(pathsOf({ path: 'x.js' }), ['x.js'])
})

test('#9 Dot 规则和 DSH 审批都要确认时，两条理由合并', async () => {
  const listeners = {}
  const ctx = { tools: { register() {} }, systemPrompt: { section() {}, context() {} }, on: (e, fn) => { listeners[e] = fn }, get: () => undefined, effect() {} }
  await applyPreset(ctx, { dataDir: await mkdtemp(join(tmpdir(), 'dsh-dot-fix-')) })
  const r = await listeners['tools/pre-execute']({ name: 'gmail_send', arguments: {}, agent: { id: 'root' } },
    async () => ({ kind: 'ask', reason: '沙箱要求确认', displayReason: { zh: '沙箱要求确认', en: 'sandbox' } }))
  assert.equal(r.kind, 'ask')
  assert.match(r.displayReason.zh, /^沙箱要求确认（另外：按 Dot 规则 b3/)
})

test('#5 交给你之后：记为事务、我做完了（Dot 没加载时经定时服务投递）', async () => {
  const { routes, created } = await hostSetup()
  hub.notify({ kind: 'handoff', sessionId: 'dot-1', title: 'Dot', text: '付钱交给你：去结账' })
  const [n1] = hub.notices()
  const r1 = await call(routes['/api/dsh-plugin-dot/notice'], { id: n1.id, action: 'task' })
  assert.match(r1.text, /亲自做：付钱交给你：去结账/)
  hub.notify({ kind: 'handoff', sessionId: 'dot-1', title: 'Dot', text: '改密码' })
  const [n2] = hub.notices()
  const r2 = await call(routes['/api/dsh-plugin-dot/notice'], { id: n2.id, action: 'done' })
  assert.match(r2.text, /几秒后它会在 Dot 会话里接着做/)
  const req = created.at(-1)
  assert.deepEqual([req.timing, req.target], [{ kind: 'after', after_seconds: 2 }, { kind: 'session', sessionId: 'dot-1' }])
  assert.match(req.prompt, /我已经亲自完成了这一步：改密码/)
  assert.equal(hub.notices().length, 0)
})

test('#6 #7 盯着的会话和通知存进 state.json，重启后恢复', async () => {
  const { routes, listeners, dataDir } = await hostSetup()
  const agent = { id: 'w1', session: { id: 'w1', preset: 'standard', header: { delegationDepth: 0 } } }
  listeners['agent/status']({ agent, status: 'running' })
  await call(routes['/api/dsh-plugin-dot/session'], { id: 'w1', action: 'watch' })
  hub.notify({ kind: 'done', sessionId: 'w1', title: '跑数据', text: '好了' })
  await wait(400)
  const disk = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'))
  assert.deepEqual(disk.watched, ['w1'])
  assert.equal(disk.notices.length, 1)
  // 模拟重启：清空内存，再用同一个目录启动
  hub.reset()
  const store = new DotStore(join(dataDir, 'state.json'))
  await store.load()
  hub.loadPersisted({ watched: store.snapshot().watched, notices: store.snapshot().notices })
  assert.deepEqual(hub.watchedIds(), ['w1'])
  assert.equal(hub.notices()[0].title, '跑数据')
  hub.restoreOther({ id: 'w1', title: '跑数据', createdAt: Date.now() })
  assert.equal(hub.other('w1').watched, true)
  const s = await call(routes['/api/dsh-plugin-dot/status'])
  assert.deepEqual(s.watchedIds, ['w1'])
})

test('#12 采纳「交给 Dot 去做」：没有加载的 Dot 会话也能送到；#15 暂停时不巡检', async () => {
  const { routes, created, dataDir } = await hostSetup()
  const { getStore } = await import('../lib/store.js')
  const store = getStore(join(dataDir, 'state.json'))
  const actions = createActions({ store, getSchedule: () => undefined })
  const s = await actions.addSuggestion({ key: 'k', kind: 'dot', source: 'dot', title: '催一下？', body: '', options: [{ label: '起草', action: { type: 'say', text: '帮我起草催办' } }] })
  const r = await call(routes['/api/dsh-plugin-dot/suggestion'], { id: s.id, option: 0 })
  assert.equal(r.ok, true)
  assert.match(r.text, /新开一个 Dot 会话/)
  assert.deepEqual([created.at(-1).prompt, created.at(-1).target], ['帮我起草催办', { kind: 'new_once', create: { agentPreset: 'dot' } }])

  await call(routes['/api/dsh-plugin-dot/say'], { text: '/task 交周报' })
  await call(routes['/api/dsh-plugin-dot/say'], { text: '/pause' })
  const st = await call(routes['/api/dsh-plugin-dot/status'])
  assert.equal(st.paused, true)
  assert.equal(st.suggestions.length, 0) // 有事务、没有简报，但暂停中不提建议
})

test('#14 #15 清理 90 天前结束的事务；暂停时不巡检', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dot-fix-'))
  const store = new DotStore(join(dir, 'state.json'))
  let now = new Date('2026-01-01T00:00:00Z')
  const actions = createActions({ store, getSchedule: () => undefined, now: () => now })
  const { task } = await actions.addTask({ title: '老事' })
  await actions.closeTasks([task.id], 'done')
  await actions.addTask({ title: '还在做' })
  now = new Date('2026-06-01T00:00:00Z')
  assert.equal(await actions.pruneTasks(90), 1)
  assert.deepEqual(store.snapshot().tasks.map(t => t.title), ['还在做'])
  assert.equal(await actions.pruneTasks(90), 0)
})

test('#10 对话事务卡：提醒、记忆、完成都记进这一轮', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dot-fix-'))
  const tools = new Map()
  const schedule = { async create() { return { id: 'sch-1' } }, async edit() {} }
  const ctx = {
    tools: { register: t => { tools.set(t.name, t) } }, systemPrompt: { section() {}, context() {} },
    on() {}, get: name => (name === 'schedule' ? schedule : undefined), effect() {},
  }
  await applyPreset(ctx, { dataDir: dir })
  const exec = { agent: { id: 'dot-1' } }
  await tools.get('dot_capture').execute({
    reminders: [{ text: '喝水', at: new Date(Date.now() + 3600_000).toISOString() }],
    memories: [{ text: '我不吃辣', category: 'preference' }],
    tasks: [{ title: '交周报' }],
  }, exec)
  await tools.get('dot_tasks').execute({ action: 'update', id: 't1', status: 'done' }, exec)
  await tools.get('dot_memory').execute({ action: 'remember', text: '工作偏好：先给结论' }, exec)
  const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.deepEqual(state.turnLog.map(x => x.kind), ['reminder', 'memory', 'done', 'memory'])
  assert.ok(state.turnLog.every(x => x.sessionId === 'dot-1'))
  assert.equal(state.tasks[0].createdIn, 'dot-1')
})
