// 界面冒烟测试：用一个最小的「假 React」在 Node 里把 bridge.js 注册的组件真正渲染出来，
// 喂上接近真实的 Host 数据，检查不报错、关键文字和按钮都在、按钮发出的请求对。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// ── 最小渲染器：支持 useState / useEffect / useRef，按树上的位置保存状态 ─────────
function createRenderer() {
  const instances = new Map()
  let current = null
  let dirty = false
  const pending = []
  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.flat(Infinity) } }
    },
    useState(init) {
      const inst = current
      const i = inst.hook++
      if (!(i in inst.state)) inst.state[i] = typeof init === 'function' ? init() : init
      const set = v => {
        const next = typeof v === 'function' ? v(inst.state[i]) : v
        if (next !== inst.state[i]) { inst.state[i] = next; dirty = true }
      }
      return [inst.state[i], set]
    },
    useEffect(fn, deps) {
      const inst = current
      const i = inst.hook++
      const old = inst.effects[i]
      const changed = !old || !deps || deps.length !== old.deps?.length || deps.some((d, k) => d !== old.deps[k])
      if (changed) pending.push(() => { old?.cleanup?.(); inst.effects[i] = { deps, cleanup: fn() } })
    },
    useRef(init) {
      const inst = current
      const i = inst.hook++
      if (!(i in inst.state)) inst.state[i] = { current: init }
      return inst.state[i]
    },
  }
  /** 把元素展开成只含原生标签的树 */
  function expand(el, path) {
    if (el === null || el === undefined || el === false || el === true) return null
    if (typeof el === 'string' || typeof el === 'number') return String(el)
    if (Array.isArray(el)) return el.map((c, i) => expand(c, `${path}.${i}`))
    if (typeof el.type === 'function') {
      const key = `${path}:${el.type.name}${el.props?.key != null ? `#${el.props.key}` : ''}`
      let inst = instances.get(key)
      if (!inst) { inst = { state: {}, effects: {}, hook: 0 }; instances.set(key, inst) }
      inst.hook = 0
      inst.alive = true
      const prev = current
      current = inst
      const out = el.type(el.props)
      current = prev
      return expand(out, key)
    }
    return { tag: el.type, props: el.props, children: (el.props.children || []).map((c, i) => expand(c, `${path}/${el.type}${i}`)) }
  }
  async function render(el, rounds = 6) {
    let tree
    for (let r = 0; r < rounds; r++) {
      dirty = false
      tree = expand(el, 'root')
      while (pending.length) pending.shift()()
      await new Promise(res => setTimeout(res, 50)) // 事务卡会把请求攒 30ms 再一起发
      if (!dirty && r >= 1) break
    }
    return tree
  }
  function unmount() {
    for (const inst of instances.values()) for (const e of Object.values(inst.effects)) e?.cleanup?.()
    instances.clear()
  }
  return { React, render, unmount }
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return node.children.map(textOf).join(' ')
}
function findAll(node, pred, out = []) {
  if (!node || typeof node === 'string') return out
  if (Array.isArray(node)) { node.forEach(n => findAll(n, pred, out)); return out }
  if (pred(node)) out.push(node)
  node.children.forEach(n => findAll(n, pred, out))
  return out
}
const button = (tree, label) => findAll(tree, n => n.tag === 'button' && textOf(n).trim() === label)[0]

// ── 接近真实的 Host 数据 ───────────────────────────────────────
const NOW = Date.now()
const FIXTURES = {
  '/status': {
    mood: 'waiting', bubble: '', counts: { active: 2, decisions: 1 }, paused: false, routes: {},
    tasks: [{ id: 't1', title: '交周报', due: new Date(NOW + 3600_000).toISOString(), priority: 'high', owner: 'user', status: 'open', overdue: false, children: [] }],
    unlinked: [], completed: [], scheduled: [{ id: 'sch-1', title: 'Dot 提醒：每日简报 09:00', status: 'active', next: new Date(NOW + 86_400_000).toISOString() }],
    decisions: [{ label: 'Dot', tool: '执行命令', reason: '按 Dot 规则 b5，调用 pwsh 前需要你确认', kind: 'approval', open: 's1' }],
    notices: [{ id: 'n1', kind: 'handoff', title: 'Dot', text: '付钱、转账、下单交给你亲自做：去结账', sessionId: 'dot-1', at: NOW, open: 'dot-1' }],
    suggestions: [{ id: 's1', kind: 'brief', title: '每天早上给你发一份简报？', body: '你有 2 件事在跟。', source: 'patrol', options: [{ label: '每天 9 点', hint: '建一个每天 09:00 的简报' }] }],
    others: [], sessions: [], dotSessions: ['dot-1'], watchedIds: ['s9'], pet: { name: '小点', color: 'green' },
  },
  '/data': {
    memories: [{ id: 'm1', text: '工作偏好：汇报先给结论', category: 'preference', createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z' }],
    rules: [
      { id: 'b1', tool: '*', decision: 'handoff', note: '付钱交给你', match: '支付|付款', source: 'builtin' },
      { id: 'r1', tool: 'browser_*', decision: 'preapproved', match: 'shop.example.com', note: '这个店可以直接下单', until: new Date(NOW + 86_400_000).toISOString(), source: 'chat' },
    ],
    stats: { counts: { b1: 2 }, gate: { handoff: 2, pass: 5 }, recent: [{ stage: 'handoff', tool: 'browser_navigate', decision: 'handoff', label: 'Dot', ruleId: 'b1', note: '付钱交给你', at: NOW }] },
    routes: { decision: { bubble: true, card: true, system: true } },
    routeEvents: [{ event: 'decision', label: '审批、提问', defaults: { bubble: true, card: true, system: true }, locked: ['card'] }, { event: 'child', label: '子任务', defaults: {}, channels: ['bubble'] }],
    pet: { name: '小点', color: 'green' }, petColors: ['blue', 'green'],
  },
  '/sessions': {
    watchOthers: true,
    sessions: [{
      id: 's9', title: '改登录页', status: 'running', result: null, restored: false, watched: true, tool: 'edit', stepCount: 4,
      startedAt: NOW - 120_000, endedAt: null, elapsedMs: 120_000, stuck: false, waiting: null,
      todos: [{ content: '改样式', status: 'completed' }, { content: '加测试', status: 'in_progress' }], todoDone: 1, todoTotal: 2, current: '加测试',
      steps: [{ tool: 'apply_patch', name: '改文件', detail: 'src/login.tsx', at: NOW, ms: 30, running: false, ok: true }],
      files: ['src/login.tsx'], asking: null, lastText: '', error: '', jobs: [], goal: null, context: { used: 120_000, window: 128_000 },
    }],
  },
}
const TURN = { tasks: [{ id: 't8', title: '给供应商回电话', status: 'open', due: new Date(NOW + 86_400_000).toISOString(), priority: 'normal' }],
  suggestions: [], effects: [{ kind: 'reminder', text: '周五 15:00 回电话', ref: null }, { kind: 'memory', text: '工作偏好：先给结论', ref: null }] }

async function loadBridge() {
  const r = createRenderer()
  const posts = []
  const registered = {}
  const fetch = async (url, opts = {}) => {
    const path = url.replace('/api/dsh-plugin-dot', '')
    if (opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      posts.push([path, body])
      const json = path === '/turns' ? { results: body.ranges.map(() => TURN) } : path === '/turn' ? TURN
        : path === '/sessions/search' ? { ok: true, hits: [{ id: 'old1', title: '上周的会话', snippet: '把登录页改成深色', time: NOW - 3 * 86_400_000 }] }
        : { ok: true, text: '好' }
      return { ok: true, json: async () => json }
    }
    return { ok: true, json: async () => structuredClone(FIXTURES[path]) }
  }
  const sandbox = {
    fetch, setTimeout, clearTimeout, console, Promise, Object, Symbol, Set, Map, JSON, Date, Math, Number, String, Array, Error,
    document: { hidden: false, createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} } },
  }
  sandbox.window = sandbox
  let factory
  sandbox.window.__ModuleLoader__ = { load: m => { factory = m.factory } }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8'), sandbox)
  const mod = factory(name => (name === 'react' ? r.React : {}))
  const ctx = {
    effect: fn => fn(),
    slots: { inject: (_name, cb) => cb(), register: (meta, C) => { registered[meta.name + (meta.key ? `:${meta.key}` : meta.id ? `:${meta.id}` : '')] = C } },
    sidebarRightTabs: { register: meta => { registered.tabMeta = meta } },
    sidebarRight: { mounted: { getSnapshot: () => null, subscribe: () => () => {} }, openTab() {} },
    layout: { selectPanel() {} },
    uiWorkspace: { openSession() {} },
  }
  mod.apply(ctx)
  return { r, posts, registered, bridge: sandbox.window.__dshDotBridge }
}

test('bridge 注册了全部入口', async () => {
  const { registered } = await loadBridge()
  for (const k of ['main:dot-sessions', 'sidebar.panellist:dot-sessions', 'sidebar.right.pane.tab:dsh-plugin-dot/panel',
    'conversation.chat.turnTail:dsh-plugin-dot-turn', 'sidebar.workspaces.session.row.action:dsh-plugin-dot-watch']) {
    assert.equal(typeof registered[k], 'function', k)
  }
})

test('Dot 窗口：今天页有审批、交给你（记为事务 / 我做完了）、建议；规则页有试一试、期限和覆盖提醒、外观', async () => {
  const { r, posts, registered, bridge } = await loadBridge()
  const Panel = registered['sidebar.right.pane.tab:dsh-plugin-dot/panel']
  const el = r.React.createElement(Panel, {})
  let tree = await r.render(el)
  let text = textOf(tree)
  assert.match(text, /需要你批准|执行命令|按 Dot 规则 b5/)
  assert.match(text, /把一件事交给你亲自做/)
  assert.match(text, /每天早上给你发一份简报/)
  button(tree, '我做完了').props.onClick({ stopPropagation() {} })
  button(tree, '每天 9 点').props.onClick({ stopPropagation() {} })
  await r.render(el)
  assert.deepEqual(posts.slice(0, 2), [['/notice', { id: 'n1', action: 'done' }], ['/suggestion', { id: 's1', option: 0 }]])

  findAll(tree, n => n.tag === 'button' && /^规则/.test(textOf(n).trim()))[0].props.onClick({})
  tree = await r.render(el)
  text = textOf(tree)
  assert.match(text, /试一试/)
  assert.match(text, /有效期到/)
  assert.match(text, /可以放行内置规则要交给你的事/)
  assert.match(text, /命中 2 次/)
  assert.match(text, /小精灵/)
  assert.match(text, /Alt\+Shift\+D/)
  // 小精灵改名后，右栏标签跟着叫这个名字
  bridge.noteStatus({ watchedIds: [], petName: '小点' })
  assert.equal(registered.tabMeta.title(), '小点')
  r.unmount()
})

test('会话总览：待办、文件、上下文用量（快满变红）', async () => {
  const { r, registered } = await loadBridge()
  const tree = await r.render(r.React.createElement(registered['main:dot-sessions'], {}))
  const text = textOf(tree)
  assert.match(text, /改登录页/)
  assert.match(text, /src\/login\.tsx/)
  assert.match(text, /上下文 120K \/ 128K（94%） 快满了/)
  r.unmount()
})

test('对话事务卡：合并请求，显示事务、提醒、记住的事；非 Dot 会话不显示', async () => {
  const { r, posts, registered, bridge } = await loadBridge()
  const Card = registered['conversation.chat.turnTail:dsh-plugin-dot-turn']
  const turn = (a, b) => ({ start: { time: a }, end: { time: b } })
  const none = await r.render(r.React.createElement(Card, { dotSessionId: 'other', turn: turn(1, 2) }))
  assert.equal(textOf(none), '')
  bridge.noteDotSessions(['dot-1'])
  const el = r.React.createElement('div', null,
    r.React.createElement(Card, { key: 'a', dotSessionId: 'dot-1', turn: turn(1, 2) }),
    r.React.createElement(Card, { key: 'b', dotSessionId: 'dot-1', turn: turn(3, 4) }))
  const tree = await r.render(el)
  const text = textOf(tree)
  assert.match(text, /给供应商回电话/)
  assert.match(text, /周五 15:00 回电话/)
  assert.match(text, /记住了/)
  const batch = posts.filter(p => p[0] === '/turns')
  assert.equal(batch.length, 1)
  assert.deepEqual(batch[0][1].ranges, [[1, 2], [3, 4]])
  r.unmount()
})

test('侧栏「盯着」按钮：按 Host 记录显示已盯；Dot 会话不显示', async () => {
  const { r, registered, bridge } = await loadBridge()
  const Row = registered['sidebar.workspaces.session.row.action:dsh-plugin-dot-watch']
  bridge.noteDotSessions(['dot-1'])
  bridge.noteStatus({ watchedIds: ['s9'], petName: 'Dot' })
  const on = await r.render(r.React.createElement(Row, { sessionId: 's9' }))
  assert.match(on.props.className, /\bon\b/)
  const off = await r.render(r.React.createElement(Row, { sessionId: 's8' }))
  assert.doesNotMatch(off.props.className, /\bon\b/)
  assert.equal(await r.render(r.React.createElement(Row, { sessionId: 'dot-1' })), null)
  r.unmount()
})

test('会话总览：搜索框搜所有会话；卡片上「转告…」直接发，「归档」走 Host', async () => {
  const { r, posts, registered } = await loadBridge()
  const el = r.React.createElement(registered['main:dot-sessions'], {})
  let tree = await r.render(el)
  const submit = async (form, text) => {
    findAll(form, n => n.tag === 'input')[0].props.onChange({ target: { value: text } })
    tree = await r.render(el)
    const again = findAll(tree, n => n.tag === 'form').find(f => f.props.className === form.props.className && textOf(f) === textOf(form))
    ;(again || form).props.onSubmit({ preventDefault() {} })
    tree = await r.render(el)
  }
  const searchForm = findAll(tree, n => n.tag === 'form')[0]
  assert.match(findAll(searchForm, n => n.tag === 'input')[0].props.placeholder, /搜所有会话/)
  await submit(searchForm, '登录页')
  assert.deepEqual(posts.at(-1), ['/sessions/search', { query: '登录页' }])
  let text = textOf(tree)
  assert.match(text, /「登录页」出现在 1 个会话里/)
  assert.match(text, /上周的会话/)
  assert.match(text, /把登录页改成深色/)

  button(tree, '转告…').props.onClick({ stopPropagation() {} })
  tree = await r.render(el)
  const forms = findAll(tree, n => n.tag === 'form')
  const relayForm = forms.find(f => /Dot 代你转告/.test(findAll(f, n => n.tag === 'input')[0].props.placeholder))
  assert.ok(relayForm, '卡片上出现转告输入框')
  findAll(relayForm, n => n.tag === 'input')[0].props.onChange({ target: { value: '顺便把测试也跑一下' } })
  tree = await r.render(el)
  findAll(tree, n => n.tag === 'form').find(f => /Dot 代你转告/.test(findAll(f, n => n.tag === 'input')[0].props.placeholder)).props.onSubmit({ preventDefault() {} })
  await r.render(el)
  assert.deepEqual(posts.at(-1), ['/session', { id: 's9', action: 'relay', text: '顺便把测试也跑一下' }])
  // 正在跑的会话没有「归档」按钮
  assert.equal(button(tree, '归档'), undefined)
  r.unmount()
})
