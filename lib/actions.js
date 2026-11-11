// @ts-check
/**
 * Dot 的确定性动作：快捷指令、dot_capture 工具和浮标面板共用，不经过模型。
 *
 * 建事务时如果有截止时间，顺手通过 DSH 的 `ctx.schedule` 建一个一次性提醒，
 * 投递回当前 Dot 会话；事务完成或放弃时删除该提醒。没有定时服务时只记事务并给出提示。
 */

import { randomUUID } from 'node:crypto'
import { describeMemory, describeTask, formatTime } from './tools.js'
import { hub } from './hub.js'

/** @typedef {import('./store.js').DotStore} DotStore */
/** @typedef {import('./store.js').Task} Task */

/**
 * @typedef {{
 *   create(request: { title: string, prompt: string, timing: unknown, target?: unknown }, actorSessionId?: string): Promise<{ id: string }>
 *   edit(request: { id: string, action: 'delete' } | { id: string, action: 'update', patch: { active: boolean } }, actorSessionId?: string): Promise<unknown>
 *   list?(request?: { active?: boolean, limit?: number }): Promise<{ items: any[] }>
 * }} ScheduleLike
 */

/**
 * @param {{
 *   store: DotStore,
 *   getSchedule: () => ScheduleLike | undefined,
 *   timeZone?: string,
 *   now?: () => Date,
 *   maxMemories?: number,
 * }} deps
 */
export function createActions(deps) {
  const { store, getSchedule, timeZone } = deps
  const now = deps.now ?? (() => new Date())
  const maxMemories = deps.maxMemories ?? 200

  /**
   * @param {{ text: string, at: Date, sessionId?: string, taskId?: string }} input
   * @returns {Promise<{ id: string } | { warning: string }>}
   */
  async function scheduleReminder({ text, at, sessionId, taskId }) {
    const schedule = getSchedule()
    if (!schedule) return { warning: '当前环境没有定时服务，未建提醒' }
    if (at.getTime() <= now().getTime()) return { warning: `${formatTime(at.toISOString(), timeZone)} 已经过去，未建提醒` }
    const title = `Dot 提醒：${text}`.slice(0, 120)
    const prompt = taskId
      ? `【Dot 提醒】事务 ${taskId}「${text}」到时间了。请用一句话提醒用户，并问是否需要你帮忙推进或改期。`
      : `【Dot 提醒】${text}。请用一句话提醒用户。`
    try {
      const entry = await schedule.create(
        {
          title, prompt, timing: { kind: 'at', at: at.toISOString() },
          // 没有当前会话（例如从浮标发起）时，到点新开一个 Dot 会话来投递。
          target: sessionId ? { kind: 'session', sessionId } : { kind: 'new_once', create: { agentPreset: 'dot' } },
        },
        sessionId,
      )
      const id = String(entry.id)
      // 暂停期间新建的提醒立刻暂停，并记入恢复清单。
      if (store.snapshot().paused) {
        try {
          await schedule.edit({ id, action: 'update', patch: { active: false } }, sessionId)
          await store.mutate(state => { state.paused?.scheduleIds.push(id) })
        } catch { /* 暂停失败时提醒照常生效 */ }
      }
      return { id }
    } catch (error) {
      return { warning: `提醒创建失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** @param {string} id @param {string | undefined} sessionId */
  async function cancelReminder(id, sessionId) {
    const schedule = getSchedule()
    if (!schedule) return
    try {
      await schedule.edit({ id, action: 'delete' }, sessionId)
    } catch {
      // 提醒可能已被用户手动删除或已触发结束；不影响事务本身。
    }
  }

  /**
   * 周期提醒（/every、每日简报）。
   * @param {{ title: string, prompt: string, timing: unknown, sessionId?: string }} input
   * @returns {Promise<{ id: string } | { warning: string }>}
   */
  async function scheduleRepeat({ title, prompt, timing, sessionId }) {
    const schedule = getSchedule()
    if (!schedule) return { warning: '当前环境没有定时服务，建不了周期提醒' }
    try {
      const entry = await schedule.create(
        {
          title: `Dot 提醒：${title}`.slice(0, 120), prompt, timing,
          target: sessionId ? { kind: 'session', sessionId } : { kind: 'new_once', create: { agentPreset: 'dot' } },
        },
        sessionId,
      )
      const id = String(entry.id)
      if (store.snapshot().paused) {
        try {
          await schedule.edit({ id, action: 'update', patch: { active: false } }, sessionId)
          await store.mutate(state => { state.paused?.scheduleIds.push(id) })
        } catch { /* 暂停失败时照常生效 */ }
      }
      return { id }
    } catch (error) {
      return { warning: `周期提醒创建失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  return {
    scheduleReminder,
    cancelReminder,
    scheduleRepeat,

    /**
     * 通过定时服务马上（2 秒后）把一句话投递给 Dot：会话还没加载时也能送到，送到时会话会被唤起。
     * @param {string} text 以用户口吻
     * @param {string} [sessionId] 投递到哪个 Dot 会话；不给就新开一个
     */
    async deliverToDot(text, sessionId) {
      const schedule = getSchedule()
      if (!schedule) throw new Error('当前环境没有定时服务，请先打开一个 Dot 会话')
      await schedule.create(
        {
          title: `Dot 提醒：交给 Dot：${text}`.slice(0, 120), prompt: text,
          timing: { kind: 'after', after_seconds: 2 },
          target: sessionId ? { kind: 'session', sessionId } : { kind: 'new_once', create: { agentPreset: 'dot' } },
        },
        sessionId,
      )
    },

    /**
     * 清理很久以前完成或放弃的事务，免得状态文件越来越大。
     * @param {number} [days] 默认 90 天
     * @returns {Promise<number>} 删了几件
     */
    async pruneTasks(days = 90) {
      const cutoff = now().getTime() - days * 86_400_000
      const old = (/** @type {Task} */ t) => (t.status === 'done' || t.status === 'dropped')
        && new Date(t.doneAt ?? t.updatedAt).getTime() < cutoff
      if (!store.snapshot().tasks.some(old)) return 0
      return store.mutate(state => {
        const before = state.tasks.length
        state.tasks = state.tasks.filter(t => !old(t))
        return before - state.tasks.length
      })
    },

    /**
     * 记一笔「这一轮 Dot 做了什么」，给对话里的事务卡用。
     * @param {string | undefined} sessionId
     * @param {{ kind: 'reminder' | 'memory' | 'done' | 'dropped' | 'due', text: string, ref?: string }} entry
     */
    async logTurn(sessionId, entry) {
      if (!sessionId) return
      const at = now().getTime()
      await store.mutate(state => {
        state.turnLog.push({ sessionId, at, ...entry })
        if (state.turnLog.length > 300) state.turnLog.splice(0, state.turnLog.length - 300)
      })
    },

    /**
     * 每天定时简报。
     * @param {string} time HH:mm
     * @param {string} [sessionId] 投递到哪个 Dot 会话；不给就到点新开一个
     */
    async scheduleDailyBrief(time, sessionId) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(time)
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`时间格式不对：${time}`)
      const hhmm = `${m[1].padStart(2, '0')}:${m[2]}`
      const tz = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
      const r = await scheduleRepeat({
        title: `每日简报 ${hhmm}`,
        prompt: '【Dot 每日简报】调用 dot_brief，用三五句话向用户汇报：今天要办和已逾期的事、昨天各会话做了什么、需要用户决定的事。不要原样贴出工具结果。',
        timing: { kind: 'daily', daily: { time: `${hhmm}:00`, time_zone: tz } },
        sessionId,
      })
      if ('warning' in r) throw new Error(r.warning)
      return { id: r.id, line: `好的，每天 ${hhmm} 给你发简报` }
    },

    // ── 建议收件箱 ────────────────────────────────────────────
    /**
     * 加一条建议。同一个 key 已经在等你处理，或 7 天内处理过，就不再加。
     * @param {Omit<import('./store.js').Suggestion, 'id' | 'status' | 'createdAt' | 'resolvedAt'>} input
     * @returns {Promise<import('./store.js').Suggestion | null>}
     */
    async addSuggestion(input) {
      const t = now()
      return store.mutate((state, newId) => {
        const same = state.suggestions.filter(s => s.key === input.key)
        if (same.some(s => s.status === 'open')) return null
        if (same.some(s => s.resolvedAt && t.getTime() - new Date(s.resolvedAt).getTime() < 7 * 86_400_000)) return null
        /** @type {import('./store.js').Suggestion} */
        const s = { ...input, id: newId('s'), status: 'open', createdAt: t.toISOString(), resolvedAt: null }
        state.suggestions.push(s)
        // 开着的最多 20 条（最旧的自动作废），处理过的留最近 50 条做去重
        const open = state.suggestions.filter(x => x.status === 'open')
        for (const old of open.slice(0, Math.max(0, open.length - 20))) { old.status = 'dismissed'; old.resolvedAt = t.toISOString(); old.outcome = '太久没处理，自动收起' }
        const done = state.suggestions.filter(x => x.status !== 'open')
        if (done.length > 50) state.suggestions = state.suggestions.filter(x => x.status === 'open' || done.slice(-50).includes(x))
        return s
      })
    },
    /**
     * 不再成立的建议（比如事务已经完成）自动收起。
     * @param {(s: import('./store.js').Suggestion) => boolean} stale
     */
    async expireSuggestions(stale) {
      const t = now().toISOString()
      if (!store.snapshot().suggestions.some(s => s.status === 'open' && stale(s))) return 0
      return store.mutate(state => {
        let n = 0
        for (const s of state.suggestions) {
          if (s.status === 'open' && stale(s)) { s.status = 'dismissed'; s.resolvedAt = t; s.outcome = '情况变了，已自动收起'; n++ }
        }
        return n
      })
    },
    /**
     * @param {string} id
     * @param {'accepted' | 'dismissed'} status
     * @param {string} [outcome]
     */
    async resolveSuggestion(id, status, outcome) {
      return store.mutate(state => {
        const s = state.suggestions.find(x => x.id === id)
        if (!s) throw new Error(`没有建议 ${id}`)
        if (s.status !== 'open') throw new Error('这条建议已经处理过了')
        s.status = status
        s.resolvedAt = now().toISOString()
        if (outcome) s.outcome = outcome
        return s
      })
    },

    /**
     * @param {{
     *   title: string, notes?: string, priority?: Task['priority'], owner?: Task['owner'],
     *   due?: string | null, remind?: boolean, sessionId?: string, linkedSession?: string,
     * }} input
     * @returns {Promise<{ task: Task, line: string, warning?: string }>}
     */
    async addTask(input) {
      const title = input.title.trim()
      if (!title) throw new Error('事务内容不能为空')
      const task = await store.mutate((state, newId) => {
        const stamp = now().toISOString()
        /** @type {Task} */
        const t = {
          id: newId('t'), title, notes: input.notes ?? '', status: 'open',
          priority: input.priority ?? 'normal', owner: input.owner ?? 'user', due: input.due ?? null,
          createdAt: stamp, updatedAt: stamp, doneAt: null,
          ...(input.sessionId ? { createdIn: input.sessionId } : {}),
          ...(input.linkedSession ? { linkedSession: input.linkedSession } : {}),
        }
        state.tasks.push(t)
        return t
      })
      /** @type {string | undefined} */
      let warning
      if (task.due && input.remind !== false) {
        const r = await scheduleReminder({ text: title, at: new Date(task.due), sessionId: input.sessionId, taskId: task.id })
        if ('id' in r) {
          await store.mutate(state => {
            const t = state.tasks.find(x => x.id === task.id)
            if (t) t.reminderId = r.id
          })
          task.reminderId = r.id
        } else {
          warning = r.warning
        }
      }
      const line = `已记下 ${describeTask(task, now(), timeZone)}${task.reminderId ? '，到点提醒你' : ''}`
      return warning ? { task, line, warning } : { task, line }
    },

    /**
     * @param {string[]} ids
     * @param {'done' | 'dropped'} status
     * @param {string} [sessionId]
     */
    async closeTasks(ids, status, sessionId) {
      const { closed, missing } = await store.mutate(state => {
        /** @type {Task[]} */
        const closed = []
        /** @type {string[]} */
        const missing = []
        for (const id of ids) {
          const t = state.tasks.find(x => x.id === id)
          if (!t) { missing.push(id); continue }
          t.status = status
          t.doneAt = status === 'done' ? now().toISOString() : null
          t.updatedAt = now().toISOString()
          closed.push({ ...t })
        }
        return { closed, missing }
      })
      for (const t of closed) {
        if (t.reminderId) await cancelReminder(t.reminderId, sessionId)
      }
      if (status === 'done' && closed.length) hub.flash(closed.length === 1 ? `完成：${closed[0].title}` : `完成了 ${closed.length} 件事`)
      return { closed, missing }
    },

    /**
     * 彻底删除事务（连同它的提醒）。
     * @param {string[]} ids
     * @param {string} [sessionId]
     */
    async deleteTasks(ids, sessionId) {
      const { removed, missing } = await store.mutate(state => {
        /** @type {Task[]} */
        const removed = []
        /** @type {string[]} */
        const missing = []
        for (const id of ids) {
          const i = state.tasks.findIndex(x => x.id === id)
          if (i < 0) { missing.push(id); continue }
          removed.push(...state.tasks.splice(i, 1))
        }
        return { removed, missing }
      })
      for (const t of removed) if (t.reminderId) await cancelReminder(t.reminderId, sessionId)
      return { removed, missing }
    },

    /**
     * 改截止时间：旧提醒删掉，按新时间重建；due 为 null 表示取消截止时间。
     * @param {string} id
     * @param {Date | null} due
     * @param {string} [sessionId]
     */
    async rescheduleTask(id, due, sessionId) {
      const old = await store.mutate(state => {
        const t = state.tasks.find(x => x.id === id)
        if (!t) throw new Error(`没找到 ${id}`)
        const prev = t.reminderId
        delete t.reminderId
        t.due = due ? due.toISOString() : null
        t.updatedAt = now().toISOString()
        return { prev, task: { ...t } }
      })
      if (old.prev) await cancelReminder(old.prev, sessionId)
      /** @type {string | undefined} */
      let warning
      if (due && (old.task.status === 'open' || old.task.status === 'waiting')) {
        const r = await scheduleReminder({ text: old.task.title, at: due, sessionId, taskId: id })
        if ('id' in r) {
          await store.mutate(state => {
            const t = state.tasks.find(x => x.id === id)
            if (t) t.reminderId = r.id
          })
          old.task.reminderId = r.id
        } else warning = r.warning
      }
      return { task: old.task, warning }
    },

    /**
     * 把已完成 / 已放弃的事务重新打开。
     * @param {string} id
     */
    async reopenTask(id) {
      return store.mutate(state => {
        const t = state.tasks.find(x => x.id === id)
        if (!t) throw new Error(`没找到 ${id}`)
        t.status = 'open'
        t.doneAt = null
        t.updatedAt = now().toISOString()
        return { ...t }
      })
    },

    /**
     * 改事务的标题或优先级（截止时间走 rescheduleTask，因为要重建提醒）。
     * @param {string} id
     * @param {{ title?: string, priority?: string }} patch
     */
    async editTask(id, patch) {
      const title = typeof patch.title === 'string' ? patch.title.trim() : undefined
      if (title !== undefined && !title) throw new Error('事务内容不能为空')
      const priority = patch.priority
      if (priority !== undefined && !['high', 'normal', 'low'].includes(priority)) throw new Error('优先级只能是 high / normal / low')
      return store.mutate(state => {
        const t = state.tasks.find(x => x.id === id)
        if (!t) throw new Error(`没找到 ${id}`)
        if (title !== undefined) t.title = title
        if (priority !== undefined) t.priority = /** @type {import('./store.js').TaskPriority} */ (priority)
        t.updatedAt = now().toISOString()
        return { ...t }
      })
    },

    /**
     * 删除一个 Dot 的定时任务；如果它是某件事务的提醒，同时解除关联。
     * @param {string} id
     * @param {Iterable<string>} dotSessionIds
     */
    async deleteSchedule(id, dotSessionIds) {
      const mine = (await this.listSchedules(dotSessionIds)).some(x => x.id === id)
      if (!mine) throw new Error('找不到这个定时任务')
      await cancelReminder(id, undefined)
      await store.mutate(state => {
        for (const t of state.tasks) if (t.reminderId === id) delete t.reminderId
        if (state.paused) state.paused.scheduleIds = state.paused.scheduleIds.filter(x => x !== id)
      })
    },

    /** @param {string} id */
    async forgetMemory(id) {
      return store.mutate(state => {
        const i = state.memories.findIndex(m => m.id === id)
        if (i < 0) throw new Error(`没有记忆 ${id}`)
        return state.memories.splice(i, 1)[0]
      })
    },

    /** 只能删用户在对话里加的规则（r 开头）；配置文件里的固定规则（c 开头）删不掉。 @param {string} id */
    async removeRule(id) {
      if (/^b\d+$/.test(id)) throw new Error(`${id} 是内置安全规则，不能删除；要放行某件具体的事，加一条 preapproved 规则`)
      if (/^c\d+$/.test(id)) throw new Error(`${id} 是配置文件里的固定规则，要在 cordis.patch.yml 里改`)
      return store.mutate(state => {
        const i = state.rules.findIndex(r => r.id === id)
        if (i < 0) throw new Error(`没有规则 ${id}`)
        return state.rules.splice(i, 1)[0]
      })
    },

    /**
     * 列出属于 Dot 的定时任务：Dot 建的提醒、投递到 Dot 会话的、或会新开 Dot 会话的。
     * @param {Iterable<string>} dotSessionIds
     */
    async listSchedules(dotSessionIds) {
      const schedule = getSchedule()
      if (!schedule?.list) return []
      const ids = new Set(dotSessionIds)
      let items = []
      try {
        items = (await schedule.list({ limit: 200 })).items ?? []
      } catch {
        return []
      }
      return items.filter(e => isDotSchedule(e, ids)).map(e => ({
        id: String(e.id), title: String(e.title ?? ''), status: e.status, next: e.scheduledAt ?? null,
        kind: e.kind ?? null, running: Boolean(e.executionActive),
      }))
    },

    /**
     * 暂停：暂停 Dot 的所有活动定时任务，并记下哪些是被我们暂停的，恢复时只恢复这些。
     * @param {Iterable<string>} dotSessionIds
     */
    async pause(dotSessionIds) {
      if (store.snapshot().paused) return { already: true, count: 0 }
      const schedule = getSchedule()
      /** @type {string[]} */
      const paused = []
      for (const item of await this.listSchedules(dotSessionIds)) {
        if (item.status !== 'active' || !schedule) continue
        try {
          await schedule.edit({ id: item.id, action: 'update', patch: { active: false } })
          paused.push(item.id)
        } catch { /* 单个失败不影响暂停本身 */ }
      }
      await store.mutate(state => { state.paused = { at: now().toISOString(), scheduleIds: paused } })
      return { already: false, count: paused.length }
    },

    async resume() {
      const p = store.snapshot().paused
      if (!p) return { already: true, count: 0 }
      const schedule = getSchedule()
      let count = 0
      for (const id of p.scheduleIds) {
        try {
          await schedule?.edit({ id, action: 'update', patch: { active: true } })
          count++
        } catch { /* 任务可能已被删除 */ }
      }
      await store.mutate(state => { state.paused = null })
      return { already: false, count }
    },

    /**
     * @param {string} text
     * @param {import('./store.js').MemoryCategory} [category]
     */
    async remember(text, category = 'fact') {
      const clean = text.trim()
      if (!clean) throw new Error('记忆内容不能为空')
      return store.mutate((state, newId) => {
        const dup = state.memories.find(m => m.text === clean)
        if (dup) return `已经记得：${describeMemory(dup)}`
        if (state.memories.length >= maxMemories) throw new Error(`记忆已达上限 ${maxMemories} 条`)
        const stamp = now().toISOString()
        const memory = { id: newId('m'), text: clean, category, createdAt: stamp, updatedAt: stamp }
        state.memories.push(memory)
        return `已记住 ${describeMemory(memory)}`
      })
    },
  }
}

/**
 * @param {any} entry 定时任务目录项
 * @param {Set<string>} dotSessionIds
 */
export function isDotSchedule(entry, dotSessionIds) {
  if (String(entry?.title ?? '').startsWith('Dot 提醒')) return true
  if (entry?.target?.create?.agentPreset === 'dot') return true
  if (entry?.target?.kind === 'session' && dotSessionIds.has(String(entry.target.sessionId))) return true
  return (entry?.involvedSessionIds ?? []).some((/** @type {any} */ id) => dotSessionIds.has(String(id)))
}

/**
 * 构造一条用户消息（与 @deepseek-ai/dsh-llm 的 createUserMessage 同形），用于 followup。
 * @param {string} text
 */
export function userMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'user' }),
  })
}

/** @param {any} agent */
export function sessionIdOf(agent) {
  return agent?.id ?? agent?.session?.id
}
