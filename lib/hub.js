// @ts-check
/**
 * 进程内状态中枢（模块单例，同进程共享）。
 *
 * - roots：Dot 会话本身（由预设里的插件上报）。
 * - children：挂在 Dot 下的子代理（开始/结束来自 subagent/start|end，
 *   过程来自 Host 的全局工具/状态监听）。名字以 `t3-` 开头的归到事务 t3。
 * - decisions：等用户处理的事（审批、提问），按调用登记、结束即撤销。
 */

import { computeBrief } from './tools.js'

/**
 * @typedef {{ id: string, ref: any, status: 'idle' | 'running', tool: string | null, lastActive: number }} RootEntry
 * @typedef {'starting' | 'running' | 'idle' | 'done' | 'failed' | 'stopped'} ChildState
 * @typedef {{
 *   id: string, ref: any, rootId: string | null, parentId: string | null, name: string, taskId: string | null,
 *   status: ChildState, tool: string | null, steps: number, startedAt: number, lastActive: number,
 *   endedAt: number | null, summary: string, held?: boolean,
 * }} ChildEntry
 * @typedef {{ key: unknown, agentId: string, label: string, tool: string, reason: string, at: number }} Decision
 * @typedef {{
 *   id: string, ref: any, title: string, status: 'idle' | 'running', tool: string | null, steps: number,
 *   startedAt: number, lastActive: number, endedAt: number | null, result: 'done' | 'failed' | 'stopped' | null,
 *   watched?: boolean, restored?: boolean,
 * }} OtherEntry
 * @typedef {{ tool: string, detail: string, at: number, endAt: number | null, ok: boolean | null }} Step
 * @typedef {{
 *   todos: { content: string, status: string }[] | null, steps: Step[], files: string[],
 *   asking: string | null, lastText: string, error: string,
 * }} Detail 一个会话（子任务或其他会话）的工作详情
 * @typedef {{ id: string, kind: 'done' | 'failed' | 'handoff', sessionId: string, title: string, text: string, at: number }} Notice
 */

export const STUCK_MS = 5 * 60_000

/**
 * 状态挂在进程级的共享槽上：DSH 可能把 `dsh-plugin-dot/agent` 和 `dsh-plugin-dot`
 * 当成不同模块实例加载（各自一份模块单例），只靠模块变量的话，
 * Dot 会话里发生的事浮标看不到。
 * @type {{ roots: Map<string, RootEntry>, children: Map<string, ChildEntry>, decisions: Map<unknown, Decision>, flash: { text: string, at: number, kind?: string } | null, copies: number }}
 */
const shared = /** @type {any} */ (globalThis)[Symbol.for('dsh-plugin-dot.hub')] ??= {
  roots: new Map(), children: new Map(), decisions: new Map(), flash: null, copies: 0, trace: [],
}
shared.trace ??= []
shared.others ??= new Map()
shared.details ??= new Map()
shared.notices ??= []
shared.ruleLog ??= { counts: {}, gate: {}, recent: [] }
/** @type {Set<string>} 被盯着的会话（含还没登记的；DSH 重启后从 state.json 恢复） */
shared.watchedIds ??= new Set()
/** @type {(() => void) | null} 盯着和通知变化时通知 Host 落盘 */
shared.persist ??= null
/** @type {Map<string, string>} 派活时预先登记的会话标题（会话还没跑起来） */
shared.pendingTitles ??= new Map()
/** Host 设置：是否监控其他会话、怎么认出 Dot 会话 */
shared.policy ??= { watchOthers: true, isDot: (/** @type {string} */ _id) => false }
shared.copies++
const { roots, children, decisions } = shared
/** @type {Map<string, OtherEntry>} 用户的其他会话（非 Dot、非子代理） */
const others = shared.others
/** @type {Map<string, Detail>} */
const details = shared.details
/** @type {Notice[]} 等用户看一眼的通知（被盯着的会话结束等） */
const notices = shared.notices
let noticeSeq = 0

/** 已加载的 hub 模块份数（诊断用；大于 1 说明模块被重复加载过）。 */
export function hubCopies() {
  return shared.copies
}

/** 记一条诊断事件（只保留最近 30 条），用于排查事件有没有到达。 @param {string} msg */
export function trace(msg) {
  shared.trace.push(`${new Date().toISOString().slice(11, 19)} ${msg}`)
  if (shared.trace.length > 30) shared.trace.shift()
}

export function traceLog() {
  return [...shared.trace]
}

const TOOL_LABELS = [
  [/^(pwsh|bash)$/, '执行命令'],
  [/^web_search/, '搜索网页'],
  [/^web_fetch/, '阅读网页'],
  [/^(read|read_file|fs_read|view)/, '阅读文件'],
  [/^(write|edit|fs_write|apply_patch|multi_edit)/, '编辑文件'],
  [/^(glob|grep|fs_search|search)/, '查找文件'],
  [/^subagent/, '委派子代理'],
  [/^workflow/, '运行工作流'],
  [/^schedule_/, '安排提醒'],
  [/^dot_capture$/, '记录事务'],
  [/^dot_memory$/, '整理记忆'],
  [/^dot_tasks$/, '更新事务'],
  [/^dot_brief$/, '准备简报'],
  [/^dot_rules$/, '调整规则'],
  [/^todo_write$/, '规划步骤'],
  [/^ask_user/, '向你提问'],
  [/^skill/, '使用技能'],
]

/** @param {string} name */
export function toolLabel(name) {
  for (const [re, label] of TOOL_LABELS) if (/** @type {RegExp} */ (re).test(name)) return /** @type {string} */ (label)
  return `调用 ${name}`
}

/**
 * 把一次工具调用的参数缩成一句话：命令、路径、搜索词……
 * @param {string} name
 * @param {unknown} args
 */
export function describeArgs(name, args) {
  const a = /** @type {Record<string, any>} */ (args && typeof args === 'object' ? args : {})
  if (name === 'todo_write' && Array.isArray(a.todos)) {
    if (!a.todos.length) return ''
    const done = a.todos.filter((/** @type {any} */ t) => t?.status === 'completed').length
    const now = a.todos.find((/** @type {any} */ t) => t?.status === 'in_progress')
    const text = `待办 ${done}/${a.todos.length}${now?.content ? `，正在：${String(now.content).replace(/\s+/g, ' ').trim()}` : ''}`
    return text.length > 90 ? `${text.slice(0, 90)}…` : text
  }
  const pick = /** @type {unknown} */ (
    a.command ?? a.description ?? a.query ?? a.url ?? a.path ?? a.file_path ?? a.filePath ?? a.pattern
    ?? a.question ?? a.questions?.[0]?.question ?? a.prompt ?? a.title
  )
  let text = typeof pick === 'string' ? pick : ''
  if (!text && name !== 'todo_write') {
    const first = Object.values(a).find(v => typeof v === 'string')
    text = typeof first === 'string' ? first : ''
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > 90 ? `${text.slice(0, 90)}…` : text
}

/**
 * 被盯着的会话结束时的一段话：用时、几步、改了哪些文件，再加最后一句回复或出错原因。
 * @param {{ result: string | null, startedAt: number, steps: number }} e
 * @param {{ files?: string[], lastText?: string, error?: string } | undefined} d
 * @param {number} now
 */
export function endSummary(e, d, now) {
  const mins = Math.max(0, Math.round((now - e.startedAt) / 60_000))
  const parts = [mins < 1 ? '不到 1 分钟' : `用时 ${mins} 分钟`, `${e.steps} 步`]
  const files = d?.files ?? []
  if (files.length) {
    const names = files.slice(0, 3).map(f => String(f).split(/[\\/]/).pop())
    parts.push(`改了 ${files.length} 个文件（${names.join('、')}${files.length > 3 ? ' 等' : ''}）`)
  }
  const tail = e.result === 'failed' ? (d?.error || '出错停下了') : (d?.lastText || '跑完了')
  return `${parts.join(' · ')}。${tail.replace(/\s+/g, ' ').slice(0, 160)}`
}

/** 会改文件的工具，参数里的路径记进「改了哪些文件」。 */
const WRITES = /^(write|edit|fs_write|fs_edit|apply_patch|multi_edit|create_file|str_replace)/

/** @param {unknown} args */
export function pathsOf(args) {
  const a = /** @type {Record<string, any>} */ (args && typeof args === 'object' ? args : {})
  /** @type {string[]} */
  const out = []
  for (const k of ['path', 'file_path', 'filePath']) if (typeof a[k] === 'string') out.push(a[k])
  if (Array.isArray(a.edits)) for (const e of a.edits) if (typeof e?.path === 'string') out.push(e.path)
  // apply_patch：文件路径写在补丁文本里（*** Update File: x / *** Add File: x / +++ b/x）
  for (const k of ['input', 'patch', 'diff']) {
    if (typeof a[k] !== 'string') continue
    for (const m of a[k].matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$|^\*\*\* Move to:\s*(.+?)\s*$|^\+\+\+ (?:b\/)?(.+?)\s*$/gm)) {
      const p = m[1] ?? m[2] ?? m[3]
      if (p && p !== '/dev/null' && !out.includes(p)) out.push(p)
    }
  }
  return out
}

/** @param {any} agent */
export function idOf(agent) {
  return agent?.id ?? agent?.session?.id ?? null
}

/**
 * 这个 agent 是不是子代理。只看会话头（`origin` / `delegationDepth`）和已登记的子任务，
 * 不调用 `subagents.rootOf`：事件里拿到的 agent 不一定是 `ctx.agents` 里那个对象，
 * rootOf 会因此抛 UNAUTHORIZED，把 Dot 根会话误判成子代理。
 * @param {any} agent
 * @param {(id: string) => boolean} [isKnownChild]
 */
export function isDelegatedAgent(agent, isKnownChild = () => false) {
  const id = idOf(agent)
  if (id && isKnownChild(id)) return true
  const header = agent?.session?.header
  if (header?.origin === 'subagent') return true
  if (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0) return true
  const meta = agent?.options?.meta
  return meta?.origin === 'subagent' || Boolean(meta?.parentSession)
}

/**
 * 尽力解析一个子代理的名字、直接父会话和所属根会话。
 * DSH 0.2.2 的 subagent/start 不带父会话，子代理开始时也可能还没进 ctx.agents，
 * 所以开始时解析不全的，后续收到它的状态或工具事件时再补。
 * @param {any} agents ctx.agents
 * @param {any} subagents ctx.subagents
 * @param {string} id
 * @param {any} [hint] 事件里带的 agent 对象
 */
export function resolveChild(agents, subagents, id, hint) {
  const live = agents?.get?.(id) ?? hint
  const header = live?.session?.header
  /** @type {string | null} */
  let name = null
  try { name = live ? subagents?.namesOf?.(live)?.self ?? null : null } catch { /* 还没驻留 */ }
  const parentId = typeof header?.parentSession === 'string' ? header.parentSession : null
  // 沿 parentSession 往上找到不再是委派会话的那一层，就是 Dot 根会话。
  let rootId = parentId
  for (let i = 0; rootId && i < 16; i++) {
    const up = agents?.get?.(rootId)?.session?.header
    if (!up || typeof up.parentSession !== 'string') break
    rootId = up.parentSession
  }
  return { name, parentId, rootId }
}

/**
 * `t3-pricing` / `t3-pricing/check` → `t3`。
 * @param {string} name
 */
export function taskIdFromName(name) {
  const m = /^(t\d+)(?:-|\/|$)/.exec(name)
  return m ? m[1] : null
}

/**
 * @param {readonly any[] | undefined} blocks
 * @param {number} [max]
 */
export function summarize(blocks, max = 200) {
  const text = (blocks ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export const hub = {
  // ── Dot 会话本身 ──────────────────────────────────────────
  /** @param {any} agent @param {'idle' | 'running'} status */
  rootStatus(agent, status) {
    const e = this.root(agent)
    if (!e) return
    e.status = status
    e.lastActive = Date.now()
    if (status === 'idle') {
      e.tool = null
      this.clearDecisions(e.id)
    }
  },
  /** @param {any} agent */
  root(agent) {
    const id = idOf(agent)
    if (!id || children.has(id)) return null
    others.delete(id)
    let e = roots.get(id)
    if (!e) {
      e = { id, ref: agent, status: 'idle', tool: null, lastActive: Date.now() }
      roots.set(id, e)
    }
    e.ref = agent
    return e
  },
  /** @param {any} agent @param {string | null} tool */
  rootTool(agent, tool) {
    const e = this.root(agent)
    if (!e) return
    e.tool = tool
    e.lastActive = Date.now()
  },

  // ── 子代理 ────────────────────────────────────────────────
  /**
   * @param {{ id: string, parentId?: string | null, rootId?: string | null, name?: string, ref?: any }} info
   */
  childStart(info) {
    const now = Date.now()
    const prev = children.get(info.id)
    // 没解析出名字时 info.name 就是会话 id；别让它盖掉之前已解析出的名字。
    const name = (info.name && info.name !== info.id ? info.name : null) ?? prev?.name ?? info.id
    /** @type {ChildEntry} */
    const e = {
      id: info.id, ref: info.ref ?? prev?.ref ?? null, rootId: info.rootId ?? prev?.rootId ?? null,
      parentId: info.parentId ?? prev?.parentId ?? null, name, taskId: taskIdFromName(name),
      status: 'running', tool: null, steps: prev?.steps ?? 0, startedAt: prev?.startedAt ?? now,
      lastActive: now, endedAt: null, summary: '',
    }
    children.set(info.id, e)
    roots.delete(info.id) // 子代理沿用 Dot 预设时，可能先被当成根会话登记过
    others.delete(info.id)
  },
  /**
   * 补全子任务信息（名字、父会话、所属 Dot 根会话）。只填更好的值，不覆盖已有的。
   * @param {string} id
   * @param {{ name?: string | null, parentId?: string | null, rootId?: string | null }} info
   */
  childUpdate(id, info) {
    const e = children.get(id)
    if (!e) return
    if (info.name && info.name !== id && e.name === id) {
      e.name = info.name
      e.taskId = taskIdFromName(info.name)
    }
    if (info.parentId && !e.parentId) e.parentId = info.parentId
    if (info.rootId && (!e.rootId || e.rootId === e.parentId)) e.rootId = info.rootId
  },
  /** 名字或父会话还没解析出来。 @param {string} id */
  childIncomplete(id) {
    const e = children.get(id)
    return Boolean(e && (e.name === id || !e.parentId))
  },
  /** @param {string} id */
  isChild(id) {
    return children.has(id)
  },
  /** @param {string} id @param {'idle' | 'running'} status */
  childStatus(id, status) {
    const e = children.get(id)
    if (!e || e.endedAt) return
    e.status = status
    e.lastActive = Date.now()
    if (status === 'idle') { e.tool = null; this.clearDecisions(id) }
  },
  /** @param {string} id @param {string} tool */
  childTool(id, tool) {
    const e = children.get(id)
    if (!e || e.endedAt) return
    e.tool = tool
    e.status = 'running'
    e.lastActive = Date.now()
  },
  /** @param {string} id */
  childToolEnd(id) {
    const e = children.get(id)
    if (!e) return
    e.tool = null
    e.steps++
    e.lastActive = Date.now()
  },
  /** @param {{ id: string, stopReason?: string, summary?: string }} info */
  childEnd(info) {
    const e = children.get(info.id)
    if (!e) return
    const now = Date.now()
    e.endedAt = now
    e.lastActive = now
    e.tool = null
    e.summary = info.summary ?? ''
    e.status = info.stopReason === 'completed' ? 'done' : info.stopReason === 'aborted' ? 'stopped' : 'failed'
    // 被停下的子任务，Dot 不能自己再把它叫起来，要先问用户（见预设闸门）。
    if (e.status === 'stopped') e.held = true
    this.clearDecisions(info.id)
    if (e.status === 'done') this.flash(`${e.name} 完成了${e.taskId ? '，Dot 正在汇总' : ''}`, 'child')
    else if (e.status === 'failed') this.flash(`${e.name} 出错停止了`, 'child')
  },
  /** 用户在面板上点了「停止」。 @param {string} id */
  childStopRequested(id) {
    const e = children.get(id)
    if (e) e.held = true
  },
  /** 用户亲自给它补了一句，等于同意继续。 @param {string} id */
  childRelease(id) {
    const e = children.get(id)
    if (e) e.held = false
  },
  /**
   * Dot 想给 `ref` 发消息时，这个子任务是不是处于「用户已停止」状态。
   * ref 可能是会话 id、名字，或从根开始的路径（t3-phones/check）。
   * @param {unknown} ref
   */
  heldChild(ref) {
    if (typeof ref !== 'string' || !ref) return null
    const last = ref.split('/').pop()
    for (const e of children.values()) {
      if (e.held && (e.id === ref || e.name === ref || e.name === last)) return e
    }
    return null
  },
  /** @param {string} id */
  child(id) {
    return children.get(id) ?? null
  },
  /** @param {string} id 子代理所属根会话的 agent 引用 */
  rootRefOf(id) {
    const c = children.get(id)
    return c?.rootId ? roots.get(c.rootId)?.ref ?? null : null
  },

  // ── 待你决定 ──────────────────────────────────────────────
  /** @param {unknown} key @param {Omit<Decision, 'key' | 'at'>} d */
  addDecision(key, d) {
    decisions.set(key, { ...d, key, at: Date.now() })
  },
  /** @param {unknown} key */
  removeDecision(key) {
    decisions.delete(key)
  },
  /** @param {string} agentId */
  clearDecisions(agentId) {
    for (const [k, d] of decisions) if (d.agentId === agentId) decisions.delete(k)
  },
  /** @param {any} agent 给决策显示用的会话名 */
  labelOf(agent) {
    const id = idOf(agent)
    const c = id ? children.get(id) : null
    if (c) return c.name
    const o = id ? others.get(id) : null
    return o ? o.title : 'Dot'
  },

  // ── 用户的其他会话 ────────────────────────────────────────
  /**
   * @param {any} agent
   * @param {'idle' | 'running'} status
   * @param {string} [title]
   */
  otherStatus(agent, status, title) {
    const id = idOf(agent)
    if (!id || roots.has(id) || children.has(id)) return
    const now = Date.now()
    let e = others.get(id)
    if (!e) {
      if (status === 'idle') return // 没见过它跑，就不登记
      e = { id, ref: agent, title: title || shared.pendingTitles.get(id) || '未命名会话', status, tool: null, steps: 0, startedAt: now, lastActive: now, endedAt: null, result: null, watched: shared.watchedIds.has(id) }
      others.set(id, e)
    }
    e.ref = agent
    if (title) e.title = title
    if (status === 'running' && e.status !== 'running') {
      Object.assign(e, { startedAt: now, steps: 0, endedAt: null, result: null, restored: false })
      const d = details.get(id)
      if (d) { d.error = ''; d.asking = null }
    }
    if (status === 'idle' && e.status === 'running') {
      e.endedAt = now
      e.tool = null
      e.result ??= 'done'
      this.clearDecisions(id)
      const d = details.get(id)
      if (d) d.asking = null
      if (e.watched && (e.result === 'done' || e.result === 'failed')) {
        this.notify({
          kind: e.result, sessionId: id, title: e.title,
          text: endSummary(e, d, now),
        })
      }
      // 跑了一会儿的才提醒，避免一问一答的小对话也冒泡
      const kind = e.watched ? 'watched' : 'other'
      if (e.result === 'done' && now - e.startedAt >= 15_000) this.flash(`「${e.title}」跑完了`, kind)
      else if (e.result === 'failed') this.flash(`「${e.title}」出错停下了`, kind)
    }
    e.status = status
    e.lastActive = now
  },
  /** @param {string} id @param {string | null} tool */
  otherTool(id, tool) {
    const e = others.get(id)
    if (!e) return
    e.tool = tool
    e.lastActive = Date.now()
    if (tool) e.steps++
  },
  /** @param {string} id @param {'failed' | 'stopped'} result */
  otherResult(id, result) {
    const e = others.get(id)
    if (e && e.status === 'running') e.result = result
  },
  /** @param {string} id */
  other(id) {
    return others.get(id) ?? null
  },
  /** @returns {OtherEntry[]} */
  others() {
    return [...others.values()]
  },
  /**
   * 从面板上移除一行已结束的子任务或其他会话（正在跑的不能移除）。
   * @param {string} id
   * @returns {boolean}
   */
  dismiss(id) {
    const c = children.get(id)
    if (c) {
      if (!c.endedAt) return false
      children.delete(id)
      details.delete(id)
      return true
    }
    const o = others.get(id)
    if (o) {
      if (o.status === 'running') return false
      others.delete(id)
      details.delete(id)
      return true
    }
    return false
  },
  /** 清掉所有已结束的其他会话。 @returns {number} */
  clearEndedOthers() {
    let n = 0
    for (const [id, o] of others) if (o.status !== 'running') { others.delete(id); details.delete(id); n++ }
    return n
  },
  /** 一个会话后来被认出是 Dot 或子代理时，从「其他会话」里拿掉。 @param {string} id */
  dropOther(id) {
    others.delete(id)
  },

  // ── 工作详情（子任务和其他会话共用）──────────────────────
  /** @param {string} id */
  detail(id) {
    let d = details.get(id)
    if (!d) {
      d = { todos: null, steps: [], files: [], asking: null, lastText: '', error: '' }
      details.set(id, d)
    }
    return d
  },
  /** 只给已登记的会话记详情。 @param {string} id */
  tracked(id) {
    return children.has(id) || others.has(id)
  },
  /**
   * 一次工具调用开始。
   * @param {string} id @param {string} name @param {unknown} args
   */
  stepStart(id, name, args) {
    if (!this.tracked(id)) return
    const d = this.detail(id)
    d.steps.push({ tool: name, detail: describeArgs(name, args), at: Date.now(), endAt: null, ok: null })
    if (d.steps.length > 8) d.steps.shift()
    if (name === 'todo_write') {
      const list = /** @type {any} */ (args)?.todos
      if (Array.isArray(list)) {
        d.todos = list.filter(x => x && typeof x.content === 'string')
          .map(x => ({ content: String(x.content).slice(0, 120), status: String(x.status ?? 'pending') }))
      }
    }
    if (/^ask_user/.test(name)) d.asking = describeArgs(name, args) || '有问题等你回答'
    if (WRITES.test(name)) {
      for (const f of pathsOf(args)) d.files = [f, ...d.files.filter(x => x !== f)].slice(0, 20)
    }
  },
  /** @param {string} id @param {string} name @param {boolean} ok */
  stepEnd(id, name, ok) {
    const d = details.get(id)
    if (!d) return
    const open = [...d.steps].reverse().find(x => x.tool === name && x.endAt === null)
    if (open) { open.endAt = Date.now(); open.ok = ok }
    if (/^ask_user/.test(name)) d.asking = null
  },
  /** 会话说完的一段话。 @param {string} id @param {string} text */
  said(id, text) {
    if (!this.tracked(id)) return
    const t = text.replace(/\s+/g, ' ').trim()
    if (t) this.detail(id).lastText = t.length > 240 ? `${t.slice(0, 240)}…` : t
  },
  /** @param {string} id @param {unknown} error */
  failed(id, error) {
    if (!this.tracked(id)) return
    const msg = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
    this.detail(id).error = msg.slice(0, 200)
  },

  // ── 让 Dot 盯着 / 通知 ────────────────────────────────────
  /** @param {string} id @param {boolean} on */
  watch(id, on) {
    const o = others.get(id)
    if (!o) return false
    o.watched = on
    if (on) shared.watchedIds.add(id)
    else shared.watchedIds.delete(id)
    shared.persist?.()
    return true
  },
  /**
   * 派活：会话还没跑起来就先盯上，并记下标题。
   * @param {string} id
   * @param {string} title
   */
  prewatch(id, title) {
    shared.watchedIds.add(id)
    shared.pendingTitles.set(id, title)
    const o = others.get(id)
    if (o) o.watched = true
    shared.persist?.()
  },
  /** @param {{ watchOthers?: boolean, isDot?: (id: string) => boolean }} p */
  configure(p) {
    Object.assign(shared.policy, p)
  },
  watchOthersEnabled() {
    return shared.policy.watchOthers !== false
  },
  /** @param {string} id */
  isDotSession(id) {
    if (roots.has(id)) return true
    try { return Boolean(shared.policy.isDot(id)) } catch { return false }
  },
  /** @returns {string[]} */
  watchedIds() {
    return [...shared.watchedIds]
  },
  /**
   * DSH 重启后恢复盯着的会话和未读通知。
   * @param {{ watched?: string[], notices?: Notice[] }} saved
   */
  loadPersisted(saved) {
    for (const id of saved.watched ?? []) shared.watchedIds.add(id)
    for (const [id, o] of others) if (shared.watchedIds.has(id)) o.watched = true
    for (const n of saved.notices ?? []) if (!notices.some(x => x.id === n.id)) notices.push(n)
    notices.sort((a, b) => a.at - b.at)
    while (notices.length > 20) notices.shift()
  },
  /** @param {(() => void) | null} fn */
  onPersist(fn) {
    shared.persist = fn
  },
  /** @param {Omit<Notice, 'id' | 'at'>} n */
  notify(n) {
    notices.push({ ...n, id: `n${Date.now().toString(36)}${(noticeSeq++).toString(36)}`, at: Date.now() })
    if (notices.length > 20) notices.shift()
    shared.persist?.()
  },
  /** @returns {Notice[]} */
  notices() {
    return [...notices]
  },
  /** @param {string} id 通知 id；'all' 清空 */
  ackNotice(id) {
    if (id === 'all') { notices.length = 0; shared.persist?.(); return true }
    const i = notices.findIndex(n => n.id === id)
    if (i < 0) return false
    notices.splice(i, 1)
    shared.persist?.()
    return true
  },
  /**
   * DSH 重启后从会话记录里补回来的会话（只读，已结束）。
   * @param {{ id: string, title: string, createdAt: number }} info
   */
  restoreOther(info) {
    if (others.has(info.id) || roots.has(info.id) || children.has(info.id)) return
    others.set(info.id, {
      id: info.id, ref: null, title: info.title || '未命名会话', status: 'idle', tool: null, steps: 0,
      startedAt: info.createdAt, lastActive: info.createdAt, endedAt: info.createdAt, result: null, restored: true,
      watched: shared.watchedIds.has(info.id),
    })
  },

  // ── 其他 ──────────────────────────────────────────────────
  /**
   * @param {string} text
   * @param {string} [kind] 通知路由里的事件名；'done' 是 Dot 自己完成事务，总是显示
   */
  flash(text, kind = 'done') {
    shared.flash = { text, at: Date.now(), kind }
  },

  // ── 规则命中记录（只在内存里，DSH 重启清零） ─────────────────
  /**
   * @param {{ stage: string, ruleId?: string, layer?: string, tool: string, decision: string, label?: string, note?: string }} hit
   */
  ruleHit(hit) {
    const log = shared.ruleLog
    log.gate[hit.stage] = (log.gate[hit.stage] ?? 0) + 1
    if (hit.ruleId) log.counts[hit.ruleId] = (log.counts[hit.ruleId] ?? 0) + 1
    if (hit.stage !== 'pass') {
      log.recent.push({ ...hit, at: Date.now() })
      if (log.recent.length > 30) log.recent.shift()
    }
  },
  /** @returns {{ counts: Record<string, number>, gate: Record<string, number>, recent: any[] }} */
  ruleStats() {
    const log = shared.ruleLog
    return { counts: { ...log.counts }, gate: { ...log.gate }, recent: [...log.recent].reverse() }
  },
  /** @param {string} id */
  forget(id) {
    roots.delete(id)
    this.clearDecisions(id)
  },
  reset() {
    roots.clear()
    children.clear()
    others.clear()
    details.clear()
    notices.length = 0
    decisions.clear()
    shared.watchedIds.clear()
    shared.pendingTitles.clear()
    shared.policy = { watchOthers: true, isDot: () => false }
    shared.persist = null
    shared.ruleLog = { counts: {}, gate: {}, recent: [] }
    shared.flash = null
  },
  /** @returns {RootEntry[]} 最近活跃在前 */
  roots() {
    return [...roots.values()].sort((a, b) => b.lastActive - a.lastActive)
  },
  /** @returns {ChildEntry[]} */
  children() {
    return [...children.values()]
  },
  /** @returns {Decision[]} */
  decisions() {
    return [...decisions.values()].sort((a, b) => a.at - b.at)
  },
  /** 清理 24 小时前结束的子代理，避免无限增长。 */
  prune(now = Date.now()) {
    for (const [id, c] of children) if (c.endedAt && now - c.endedAt > 86_400_000) { children.delete(id); details.delete(id) }
    for (const [id, o] of others) if (o.status === 'idle' && now - o.lastActive > 86_400_000) { others.delete(id); details.delete(id) }
  },
}

/**
 * 小精灵点一下要跳去的会话：子代理用「父会话 + 子会话」地址，其他直接用会话 id。
 * @param {string} id
 * @returns {string | { parentSessionId: string, childSessionId: string } | null}
 */
function openTarget(id) {
  if (!id) return null
  const c = children.get(id)
  if (c) return c.parentId ? { parentSessionId: c.parentId, childSessionId: c.id } : null
  return id
}

/**
 * 一个会话的工作详情，给会话总览和 Dot 窗口用。
 * @param {string} id
 * @param {number} now
 */
export function detailView(id, now = Date.now()) {
  const d = details.get(id)
  if (!d) return { todos: null, todoDone: 0, todoTotal: 0, current: null, steps: [], files: [], asking: null, lastText: '', error: '' }
  const todos = d.todos
  return {
    todos,
    todoDone: todos ? todos.filter(x => x.status === 'completed').length : 0,
    todoTotal: todos ? todos.length : 0,
    current: todos?.find(x => x.status === 'in_progress')?.content ?? null,
    steps: d.steps.slice().reverse().map(x => ({
      tool: toolLabel(x.tool), name: x.tool, detail: x.detail, at: x.at,
      ms: (x.endAt ?? now) - x.at, running: x.endAt === null, ok: x.ok,
    })),
    files: d.files, asking: d.asking, lastText: d.lastText, error: d.error,
  }
}

/** @param {ChildEntry} c @param {number} now */
function childView(c, now) {
  const stuck = c.status === 'running' && now - c.lastActive > STUCK_MS
  return {
    id: c.id, parentId: c.parentId, name: c.name, taskId: c.taskId, status: c.status, stuck,
    tool: c.tool ? toolLabel(c.tool) : null, steps: c.steps,
    elapsedMs: (c.endedAt ?? now) - c.startedAt, summary: c.summary,
    detail: detailView(c.id, now),
  }
}

/**
 * 汇总给浮标的状态。心情优先级：暂停 > 等你 > 忙碌 > 完成（30 秒） > 卡住/到期提醒 > 休息。
 * @param {Readonly<import('./store.js').DotState>} state
 * @param {Date} now
 * @param {{ scheduled?: any[] }} [extra]
 */
export function petStatus(state, now, extra = {}) {
  const t = now.getTime()
  hub.prune(t)
  /** @type {Record<string, Record<string, boolean>>} */
  const routes = extra.routes ?? {}
  const bubbleOn = (/** @type {string} */ event) => routes[event]?.bubble !== false
  const rootList = hub.roots()
  const kids = hub.children()
  // 会话里有问题等你回答（ask_user），和审批一样算「待你决定」
  const asks = [...details.entries()]
    .filter(([id, d]) => d.asking && (children.get(id)?.status === 'running' || others.get(id)?.status === 'running'))
    .map(([id, d]) => /** @type {Decision} */ ({
      key: `ask:${id}`, agentId: id, label: children.get(id)?.name ?? others.get(id)?.title ?? '会话',
      tool: 'ask_user', reason: `在问你：${d.asking}`, at: d.steps.at(-1)?.at ?? t,
    }))
  const decisionList = [...hub.decisions(), ...asks]
  const b = computeBrief(state, now, 1)
  const counts = {
    active: b.active.length, overdue: b.overdue.length, dueSoon: b.dueSoon.length,
    delegated: b.delegated.length, waiting: b.waiting.length,
    running: kids.filter(c => c.status === 'running').length,
    decisions: decisionList.length,
    others: hub.others().filter(o => o.status === 'running').length,
  }

  /** @type {'paused' | 'waiting' | 'busy' | 'done' | 'alert' | 'idle'} */
  let mood = 'idle'
  let bubble = ''
  const busyRoot = rootList.find(r => r.status === 'running')
  const busyChild = kids.find(c => c.status === 'running' && t - c.lastActive <= STUCK_MS)
  const stuckChild = kids.find(c => c.status === 'running' && t - c.lastActive > STUCK_MS)
  const busyOther = hub.others().filter(o => o.status === 'running' && t - o.lastActive <= STUCK_MS).sort((a, b) => b.lastActive - a.lastActive)[0]
  const soon = b.dueSoon[0]
  if (state.paused) {
    mood = 'paused'
    bubble = 'Dot 已暂停'
  } else if (decisionList.length) {
    mood = 'waiting'
    bubble = !bubbleOn('decision') ? '' : decisionList.length === 1 ? `${decisionList[0].label} 需要你确认` : `${decisionList.length} 件事需要你确认`
  } else if (busyRoot) {
    mood = 'busy'
    bubble = busyRoot.tool ? `正在${toolLabel(busyRoot.tool)}…` : '正在思考…'
  } else if (busyChild) {
    mood = 'busy'
    bubble = `${busyChild.name} ${busyChild.tool ? `正在${toolLabel(busyChild.tool)}` : '在干活'}…`
  } else if (busyOther) {
    // 用户别的会话在干活：小精灵也跟着忙，气泡说是哪个会话在做什么
    mood = 'busy'
    bubble = `「${busyOther.title}」${busyOther.tool ? `正在${toolLabel(busyOther.tool)}` : '在思考'}…`
  } else if (shared.flash && t - shared.flash.at < 30_000 && bubbleOn(shared.flash.kind ?? 'done')) {
    mood = 'done'
    bubble = shared.flash.text
  } else if (stuckChild) {
    mood = 'alert'
    bubble = `${stuckChild.name} ${Math.round((t - stuckChild.lastActive) / 60_000)} 分钟没动静`
  } else if (b.overdue.length > 0) {
    mood = 'alert'
    bubble = !bubbleOn('due') ? '' : b.overdue.length === 1 ? `「${b.overdue[0].title}」已逾期` : `${b.overdue.length} 件事已逾期`
  } else if (soon && soon.due) {
    mood = 'alert'
    bubble = !bubbleOn('due') ? '' : `「${soon.title}」还有 ${Math.max(1, Math.round((new Date(soon.due).getTime() - t) / 60_000))} 分钟`
  }

  const rank = { high: 0, normal: 1, low: 2 }
  const byTask = new Map()
  for (const c of kids) {
    const key = c.taskId ?? ''
    if (!byTask.has(key)) byTask.set(key, [])
    byTask.get(key).push(childView(c, t))
  }
  const tasks = b.active
    .slice()
    .sort((x, y) => {
      const ox = b.overdue.includes(x) ? 0 : 1
      const oy = b.overdue.includes(y) ? 0 : 1
      return ox - oy || rank[x.priority] - rank[y.priority] || (x.due ?? '9999').localeCompare(y.due ?? '9999')
    })
    .slice(0, 50)
    .map(task => ({
      id: task.id, title: task.title, due: task.due, priority: task.priority, owner: task.owner,
      status: task.status, overdue: b.overdue.includes(task), children: byTask.get(task.id) ?? [],
    }))
  const linked = new Set(tasks.map(x => x.id))
  // 没关联上进行中事务的子代理（命名不规范，或事务已完成），单独列出，不丢。
  const unlinked = kids
    .filter(c => !c.taskId || !linked.has(c.taskId))
    .filter(c => !c.endedAt || t - c.endedAt < 3_600_000)
    .map(c => childView(c, t))

  const weekAgo = t - 7 * 86_400_000
  // 完成和放弃的都列出来（放弃的没有 doneAt，用最后更新时间），方便重开或删除
  const endedAt = (/** @type {import('./store.js').Task} */ x) => x.doneAt ?? x.updatedAt
  const completed = state.tasks
    .filter(x => (x.status === 'done' || x.status === 'dropped') && new Date(endedAt(x)).getTime() >= weekAgo)
    .sort((x, y) => String(endedAt(y)).localeCompare(String(endedAt(x))))
    .slice(0, 15)
    .map(x => ({ id: x.id, title: x.title, status: x.status, doneAt: endedAt(x), children: byTask.get(x.id) ?? [] }))

  return {
    mood, bubble, counts, paused: Boolean(state.paused), routes,
    tasks, unlinked, completed,
    scheduled: extra.scheduled ?? [],
    decisions: decisionList.map(d => ({
      label: d.label, tool: toolLabel(d.tool), reason: d.reason, at: new Date(d.at).toISOString(),
      open: openTarget(d.agentId), kind: d.tool === 'ask_user' ? 'question' : 'approval',
    })),
    notices: hub.notices().map(n => ({ ...n, open: openTarget(n.sessionId) })),
    sessions: rootList.map(r => ({ id: r.id, status: r.status, tool: r.tool ? toolLabel(r.tool) : null })),
    // 进行中的在前；结束的只保留最近 2 小时
    others: hub.others()
      .filter(o => o.status === 'running' || t - o.lastActive < 2 * 3_600_000)
      .sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || b.lastActive - a.lastActive)
      .slice(0, 20)
      .map(o => ({
        id: o.id, title: o.title, status: o.status, result: o.result, tool: o.tool ? toolLabel(o.tool) : null,
        steps: o.steps, elapsedMs: (o.endedAt ?? t) - o.startedAt, endedAt: o.endedAt,
        stuck: o.status === 'running' && t - o.lastActive > STUCK_MS,
        waiting: decisionList.some(d => d.agentId === o.id),
        watched: Boolean(o.watched),
      })),
  }
}
