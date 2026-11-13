import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// ── 最小渲染器：支持 useState / useEffect / useRef，按树上的位置保存状态 ─────────
export function createRenderer() {
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

export function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return node.children.map(textOf).join(' ')
}
export function findAll(node, pred, out = []) {
  if (!node || typeof node === 'string') return out
  if (Array.isArray(node)) { node.forEach(n => findAll(n, pred, out)); return out }
  if (pred(node)) out.push(node)
  node.children.forEach(n => findAll(n, pred, out))
  return out
}
export const button = (tree, label) => findAll(tree, n => n.tag === 'button' && textOf(n).trim() === label)[0]

// ── 接近真实的 Host 数据 ───────────────────────────────────────
const NOW = Date.now()
export const FIXTURES = {
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

export async function loadBridge(options = {}) {
  const r = createRenderer()
  const posts = []
  const registered = {}
  const fetch = async (url, opts = {}) => {
    const path = url.replace('/api/dsh-plugin-dot', '')
    if (opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      posts.push([path, body])
      const json = options.post ? await options.post(path, body) : path === '/turns' ? { results: body.ranges.map(() => TURN) } : path === '/turn' ? TURN
        : path === '/sessions/search' ? { ok: true, hits: [{ id: 'old1', title: '上周的会话', snippet: '把登录页改成深色', time: NOW - 3 * 86_400_000 }] }
        : { ok: true, text: '好' }
      return { ok: true, json: async () => json }
    }
    return { ok: true, json: async () => (options.get ? await options.get(path) : structuredClone((options.fixtures || FIXTURES)[path])) }
  }
  const sandbox = {
    fetch, setTimeout, clearTimeout, console, Promise, Object, Symbol, Set, Map, JSON, Date, Math, Number, String, Array, Error,
    document: { hidden: false, addEventListener() {}, removeEventListener() {}, createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} } },
  }
  sandbox.window = sandbox
  let factory
  sandbox.window.__ModuleLoader__ = { load: m => { factory = m.factory } }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(new URL('../../lib/bridge.js', import.meta.url), 'utf8'), sandbox)
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

