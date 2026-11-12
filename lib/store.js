// @ts-check
/**
 * Dot 的持久化状态：长期记忆、事务清单、行为规则。
 *
 * 所有 Dot 会话共享同一个 JSON 文件（按路径单例），写入串行化并通过
 * “写临时文件 + rename” 原子落盘。读取走内存快照，因此系统提示词里的
 * 动态上下文可以同步取值。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** @typedef {'preference' | 'person' | 'routine' | 'fact' | 'account' | 'other'} MemoryCategory */
/** @typedef {{ id: string, text: string, category: MemoryCategory, createdAt: string, updatedAt: string }} Memory */
/** @typedef {'open' | 'waiting' | 'done' | 'dropped'} TaskStatus */
/** @typedef {'high' | 'normal' | 'low'} TaskPriority */
/** @typedef {'user' | 'dot' | 'delegated'} TaskOwner */
/**
 * @typedef {{
 *   id: string, title: string, notes: string, status: TaskStatus, priority: TaskPriority,
 *   owner: TaskOwner, due: string | null, createdAt: string, updatedAt: string, doneAt: string | null,
 *   reminderId?: string, createdIn?: string, linkedSession?: string,
 *   today?: string | null, steps?: { text: string, done: boolean }[],
 *   repeat?: { label: string, timing: any } | null, waitingOn?: string
 * }} Task
 * today：放进「今天」的那天（YYYY-MM-DD），过了那天自动失效；steps：拆出来的小步骤；
 * repeat：周期待办，完成后自动生成下一次；waitingOn：等谁 / 等什么（status 为 waiting 时）。
 */
/** @typedef {'allow' | 'preapproved' | 'ask' | 'handoff' | 'block'} RuleDecision */
/** @typedef {{ id: string, tool: string, decision: RuleDecision, note: string, createdAt: string, match?: string, until?: string }} Rule */
/** @typedef {{ routes: Record<string, Record<string, boolean>>, pet?: { name?: string, color?: string } }} DotPrefs */
/**
 * 建议的一个选项：label 是按钮文字，action 是采纳后执行的动作。
 * action.type：daily_brief（建每日简报）、reschedule（改期）、drop（放弃事务）、task（记为事务）、
 * remind（建提醒）、say（交给 Dot 去做）。
 * @typedef {{ label: string, action: { type: string, [k: string]: unknown } }} SuggestionOption
 */
/**
 * @typedef {{
 *   id: string, key: string, kind: string, title: string, body: string,
 *   options: SuggestionOption[], source: 'patrol' | 'dot',
 *   status: 'open' | 'accepted' | 'dismissed', createdAt: string, resolvedAt: string | null,
 *   outcome?: string
 * }} Suggestion
 */
/**
 * @typedef {{
 *   version: 1,
 *   nextId: { m: number, t: number, r: number, s: number },
 *   memories: Memory[], tasks: Task[], rules: Rule[],
 *   paused: { at: string, scheduleIds: string[] } | null,
 *   prefs: DotPrefs,
 *   suggestions: Suggestion[],
 *   watched: string[],
 *   notices: { id: string, kind: string, sessionId: string, title: string, text: string, at: number }[],
 *   turnLog: { sessionId: string, at: number, kind: string, text: string, ref?: string }[]
 * }} DotState
 */

export const MEMORY_CATEGORIES = /** @type {const} */ (['preference', 'person', 'routine', 'fact', 'account', 'other'])
export const TASK_STATUSES = /** @type {const} */ (['open', 'waiting', 'done', 'dropped'])
export const TASK_PRIORITIES = /** @type {const} */ (['high', 'normal', 'low'])
export const TASK_OWNERS = /** @type {const} */ (['user', 'dot', 'delegated'])
export const RULE_DECISIONS = /** @type {const} */ (['allow', 'preapproved', 'ask', 'handoff', 'block'])

/** @returns {DotState} */
export function emptyState() {
  return { version: 1, nextId: { m: 1, t: 1, r: 1, s: 1 }, memories: [], tasks: [], rules: [], paused: null, prefs: { routes: {} }, suggestions: [], watched: [], notices: [], turnLog: [] }
}

/**
 * Normalize a parsed file into a {@link DotState}, tolerating missing arrays
 * from older or hand-edited files but rejecting a structurally wrong root.
 * @param {unknown} raw
 * @returns {DotState}
 */
export function normalizeState(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Dot 状态文件的根必须是 JSON 对象')
  }
  const r = /** @type {Record<string, any>} */ (raw)
  const state = emptyState()
  state.memories = Array.isArray(r.memories) ? r.memories : []
  state.tasks = Array.isArray(r.tasks) ? r.tasks : []
  state.rules = Array.isArray(r.rules) ? r.rules : []
  state.watched = Array.isArray(r.watched) ? r.watched.filter((/** @type {unknown} */ x) => typeof x === 'string').slice(-50) : []
  state.notices = Array.isArray(r.notices) ? r.notices.filter((/** @type {any} */ n) => n && typeof n.id === 'string').slice(-20) : []
  state.turnLog = Array.isArray(r.turnLog) ? r.turnLog.filter((/** @type {any} */ x) => x && typeof x.sessionId === 'string').slice(-300) : []
  state.suggestions = Array.isArray(r.suggestions) ? r.suggestions.filter((/** @type {any} */ s) => s && typeof s.id === 'string') : []
  state.paused = r.paused && typeof r.paused === 'object'
    ? { at: String(r.paused.at ?? ''), scheduleIds: Array.isArray(r.paused.scheduleIds) ? r.paused.scheduleIds.map(String) : [] }
    : null
  const routes = r.prefs?.routes && typeof r.prefs.routes === 'object' && !Array.isArray(r.prefs.routes) ? r.prefs.routes : {}
  state.prefs = { routes: {} }
  if (r.prefs?.pet && typeof r.prefs.pet === 'object') {
    const p = r.prefs.pet
    state.prefs.pet = {
      ...(typeof p.name === 'string' && p.name.trim() ? { name: p.name.trim().slice(0, 12) } : {}),
      ...(typeof p.color === 'string' ? { color: p.color } : {}),
    }
  }
  for (const [event, channels] of Object.entries(routes)) {
    if (!channels || typeof channels !== 'object') continue
    state.prefs.routes[event] = {}
    for (const [ch, on] of Object.entries(channels)) if (typeof on === 'boolean') state.prefs.routes[event][ch] = on
  }
  const next = r.nextId && typeof r.nextId === 'object' ? r.nextId : {}
  // 防止手工编辑后 id 冲突：计数器至少比现存最大编号大 1。
  state.nextId = {
    m: Math.max(Number(next.m) || 1, maxSuffix(state.memories) + 1),
    t: Math.max(Number(next.t) || 1, maxSuffix(state.tasks) + 1),
    r: Math.max(Number(next.r) || 1, maxSuffix(state.rules) + 1),
    s: Math.max(Number(next.s) || 1, maxSuffix(state.suggestions) + 1),
  }
  return state
}

/** @param {{ id: string }[]} items */
function maxSuffix(items) {
  let max = 0
  for (const item of items) {
    const n = Number(String(item?.id ?? '').slice(1))
    if (Number.isInteger(n) && n > max) max = n
  }
  return max
}

export class DotStore {
  /** @param {string} file 状态文件绝对路径 */
  constructor(file) {
    this.file = file
    /** @type {DotState} */
    this.state = emptyState()
    /** @type {Promise<void> | null} */
    this.loading = null
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve()
    /** @type {string | null} 加载时发现文件损坏并另存的路径 */
    this.recoveredFrom = null
  }

  /** 首次调用时从磁盘加载；之后复用同一个 promise。 */
  load() {
    this.loading ??= this.#read()
    return this.loading
  }

  async #read() {
    let text
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return
      throw error
    }
    try {
      this.state = normalizeState(JSON.parse(text))
    } catch {
      // 损坏的文件不覆盖、不丢弃：改名保留，交给用户处理，Dot 以空状态继续工作。
      const aside = `${this.file}.corrupt-${Date.now()}`
      await rename(this.file, aside)
      this.recoveredFrom = aside
      this.state = emptyState()
    }
  }

  /** @returns {Readonly<DotState>} 当前内存快照（只读使用）。 */
  snapshot() {
    return this.state
  }

  /**
   * 串行执行一次修改并原子落盘。回调抛错时不写盘、状态回滚。
   * @template T
   * @param {(state: DotState, newId: (kind: 'm' | 't' | 'r' | 's') => string) => T} fn
   * @returns {Promise<T>}
   */
  mutate(fn) {
    const run = this.queue.then(async () => {
      await this.load()
      const draft = structuredClone(this.state)
      const newId = (/** @type {'m' | 't' | 'r' | 's'} */ kind) => `${kind}${draft.nextId[kind]++}`
      const result = fn(draft, newId)
      await this.#write(draft)
      this.state = draft
      return result
    })
    // 一次失败不能卡死后续写入。
    this.queue = run.catch(() => {})
    return run
  }

  /** @param {DotState} state */
  async #write(state) {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(tmp, this.file)
  }
}

/** @type {Map<string, DotStore>} */
const stores = new Map()

/**
 * 同一路径共享一个 store：每个 Dot 会话都会挂载一次插件，但状态只有一份。
 * @param {string} file
 */
export function getStore(file) {
  let store = stores.get(file)
  if (!store) {
    store = new DotStore(file)
    stores.set(file, store)
  }
  return store
}
