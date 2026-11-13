import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hub } from '../lib/hub.js'
import { apply as applyHost } from '../lib/host.js'
import { getStore } from '../lib/store.js'
import { deskCards, deskSummary, deskView, fmtDue } from '../lib/petcards.js'

beforeEach(() => hub.reset())

const NOW = new Date(2026, 10, 11, 14, 0).getTime()

test('桌面精灵卡片：顺序、按钮和网页小精灵一致', () => {
  const s = {
    decisions: [{ label: 'Dot', reason: '想发一封邮件', kind: 'approval', open: { sessionId: 'a' } }],
    notices: [
      { id: 'n1', kind: 'done', title: '写报告', text: '写完了', open: 'w1' },
      { id: 'n2', kind: 'handoff', title: 'Dot', text: '请你亲自付款' },
    ],
    tasks: [
      { id: 't1', title: '交周报', due: new Date(NOW - 60_000).toISOString(), overdue: true },
      { id: 't2', title: '开会', due: new Date(NOW + 10 * 60_000).toISOString() },
      { id: 't3', title: '远着呢', due: new Date(NOW + 5 * 3600_000).toISOString() },
    ],
    suggestions: [{ id: 's1', title: '设个每日简报' }, { id: 's2', title: 'x' }],
    routes: {},
  }
  const cards = deskCards(s, NOW)
  assert.deepEqual(cards.map(c => c.kind), ['approval', 'done', 'handoff', 'overdue', 'soon', 'suggestions'])
  assert.deepEqual(cards[0].buttons, [{ label: '去处理', main: true, op: { open: { sessionId: 'a' } } }])
  // 打开跑完的会话：同时标为已读
  assert.deepEqual(cards[1].buttons[0].op, { open: 'w1', post: '/notice', body: { id: 'n1' } })
  assert.deepEqual(cards[2].buttons.map(b => b.label), ['记为事务', '我做完了', '知道了'])
  assert.deepEqual(cards[3].buttons[0].op, { post: '/task', body: { id: 't1', action: 'done' } })
  assert.deepEqual(cards[3].buttons[1].op, { post: '/task', body: { id: 't1', action: 'snooze', to: '1h' } })
  assert.equal(cards[4].body, '还有 10 分钟')
  assert.equal(cards[5].title, 'Dot 有 2 个建议')
  assert.deepEqual(cards[5].buttons[0].op, { nav: 'dot' })
  // 卡片里的写操作都在桌面精灵的白名单里
  for (const c of cards) for (const b of c.buttons) if (b.op.post) assert.ok(['/task', '/notice', '/say', '/focus'].includes(b.op.post))
})

test('桌面精灵卡片：关掉通知卡的事件不显示；摘要和配色', () => {
  const s = { decisions: [{ label: 'Dot', reason: 'r' }], tasks: [], routes: { decision: { card: false } } }
  assert.equal(deskCards(s, NOW).length, 0)
  assert.equal(deskSummary({ counts: { active: 3, running: 1 }, mood: 'busy', bubble: '正在思考…' }), '3 件事在办，1 个子任务在跑 — 正在思考…')
  assert.equal(deskSummary({ counts: {}, paused: true, mood: 'paused', bubble: '' }), '已暂停 · 一切安静')
  const v = deskView({ pet: { name: ' 小点 ', color: 'green' }, counts: {}, hasDotSession: true }, NOW)
  assert.equal(v.name, '小点')
  assert.deepEqual(v.color, ['#7fe0a8', '#2fb36d'])
  assert.equal(v.hint, '')
  assert.deepEqual(deskView({ pet: { color: '#ff0000' }, counts: {} }, NOW).color, ['#8aa2ff', '#4d6bfe'])
  assert.equal(fmtDue(new Date(NOW + 3600_000).toISOString(), NOW), '今天 15:00')
})

async function hostSetup() {
  const routes = {}
  const ctx = {
    webServer: { register: r => { routes[r.path] = r.handler }, getOrigin: () => 'http://127.0.0.1:3999' },
    on: () => {},
    get: () => undefined,
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-dot-desk-'))
  await applyHost(ctx, { dataDir, pet: true })
  return { routes, store: getStore(join(dataDir, 'state.json')) }
}
async function call(handler, body, url = '/') {
  const req = {
    url,
    method: body ? 'POST' : 'GET',
    headers: { host: '127.0.0.1:3999', 'x-dot-client': '1', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) },
  }
  let out
  const res = { setHeader() {}, end: b => { out = JSON.parse(b) }, statusCode: 200 }
  await handler(req, res)
  return { code: res.statusCode, ...out }
}

test('精灵形象：桌面和网页读同一图鉴，换角色持久化且保留名字、颜色与生活数据', async () => {
  const { routes, store } = await hostSetup()
  await store.mutate(s => { s.prefs.pet = { name: '小棉', color: 'green' }; s.prefs.life = { outfit: 'scarf' } })
  const catalog = await call(routes['/api/dsh-plugin-dot/pet/catalog'])
  assert.equal(catalog.characters.length, 3)
  assert.equal(catalog.gestures.length, 6)
  const pet = routes['/api/dsh-plugin-dot/pet']
  assert.equal((await call(pet, { action: 'character', id: 'missing' })).code, 400)
  assert.equal((await call(pet, { action: 'motion', value: 'invalid' })).code, 400)
  assert.equal((await call(pet, { action: 'character', id: 'bunny' })).ok, true)
  assert.equal((await call(pet, { action: 'motion', value: 'reduced' })).ok, true)
  assert.deepEqual(store.snapshot().prefs.pet, { name: '小棉', color: 'green', character: 'bunny', motion: 'reduced' })
  assert.equal(store.snapshot().prefs.life.outfit, 'scarf')
  const s = await call(routes['/api/dsh-plugin-dot/status'], null, '/status?desk=1')
  assert.equal(s.petArt.id, 'bunny')
  assert.equal(s.pet.motion, 'reduced')
  assert.equal(s.desk.life.outfit, 'scarf')
  assert.equal(s.desk.name, '小棉')
  const data = await call(routes['/api/dsh-plugin-dot/data'])
  assert.equal(data.petCharacters.length, 3)
})

test('/focus：桌面精灵交来的跳转目标出现在 /status 里，网页端回执后清掉；/status?desk=1 带卡片', async () => {
  const { routes } = await hostSetup()
  const focus = routes['/api/dsh-plugin-dot/focus']
  const status = routes['/api/dsh-plugin-dot/status']
  assert.equal((await call(focus, {})).code, 400)
  assert.equal((await call(focus, { nav: 'elsewhere' })).code, 400)
  const r = await call(focus, { open: { sessionId: 'abc' } })
  assert.equal(r.ok, true)
  const s1 = await call(status, null, '/api/dsh-plugin-dot/status')
  assert.deepEqual(s1.focus.open, { sessionId: 'abc' })
  assert.equal(s1.desk, undefined) // 网页小精灵不需要
  // 新的目标顶掉旧的；旧 id 的回执不清新的
  const r2 = await call(focus, { nav: 'sessions' })
  await call(focus, { ack: r.id })
  assert.equal((await call(status, null, '/')).focus.nav, 'sessions')
  await call(focus, { ack: r2.id })
  assert.equal((await call(status, null, '/')).focus, undefined)
  const s2 = await call(status, null, '/api/dsh-plugin-dot/status?desk=1')
  assert.equal(s2.desk.name, 'Dot')
  assert.ok(Array.isArray(s2.desk.cards))
  assert.equal(s2.desktopPet, false)
})

test('/focus 是写接口：没有 X-Dot-Client 头、跨域都拒绝', async () => {
  const { routes } = await hostSetup()
  const focus = routes['/api/dsh-plugin-dot/focus']
  let code = 0
  const res = { setHeader() {}, end() {}, set statusCode(v) { code = v }, get statusCode() { return code } }
  await focus({ url: '/', method: 'POST', headers: { host: '127.0.0.1:3999', 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() {} }, res)
  assert.equal(code, 403)
  await focus({ url: '/', method: 'POST', headers: { host: '127.0.0.1:3999', origin: 'http://evil.example', 'x-dot-client': '1', 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() {} }, res)
  assert.equal(code, 403)
})

test('/focus/wait：长轮询，新的跳转目标一登记就返回；已有的直接返回', async () => {
  const { routes } = await hostSetup()
  const focus = routes['/api/dsh-plugin-dot/focus']
  const wait = routes['/api/dsh-plugin-dot/focus/wait']
  // 长轮询的处理函数先返回、稍后才写响应：等 res.end
  const pending = new Promise(resolve => {
    const req = { url: '/api/dsh-plugin-dot/focus/wait?after=0', method: 'GET', headers: { host: '127.0.0.1:3999' } }
    wait(req, { setHeader() {}, statusCode: 200, end: b => resolve(JSON.parse(b)) })
  })
  await new Promise(r => setTimeout(r, 20))
  const posted = await call(focus, { nav: 'sessions' })
  const got = await pending
  assert.equal(got.focus.id, posted.id)
  assert.equal(got.focus.nav, 'sessions')
  // 已经有比 after 新的：立刻返回
  assert.equal((await call(wait, null, `/api/dsh-plugin-dot/focus/wait?after=${posted.id - 1}`)).focus.id, posted.id)
})

test('/say：Dot 会话没加载时交给定时服务唤起最近的 Dot 会话；一个都没有就新开', async () => {
  const created = []
  const routes = {}
  const ctx = {
    webServer: { register: r => { routes[r.path] = r.handler }, getOrigin: () => 'http://127.0.0.1:3999' },
    on: () => {},
    get: name => (name === 'schedule' ? { async create(req) { created.push(req); return { id: 'x' } }, async list() { return { items: [] } } } : undefined),
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-dot-say-'))
  await applyHost(ctx, { dataDir, pet: true })
  const r = await call(routes['/api/dsh-plugin-dot/say'], { text: '帮我看看明天的安排' })
  assert.equal(r.ok, true)
  assert.match(r.text, /新开一个 Dot 会话/)
  assert.deepEqual(created[0].target, { kind: 'new_once', create: { agentPreset: 'dot' } })
  assert.equal(created[0].prompt, '帮我看看明天的安排')
})
