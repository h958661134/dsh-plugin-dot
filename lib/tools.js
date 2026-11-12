// @ts-check
/**
 * Dot 的模型可调用工具。采用 DSH 原生的 raw ToolDefinition（JSON Schema 参数 +
 * output.schema/render + execute），不依赖 @deepseek-ai/* 运行时包。
 */

import {
  MEMORY_CATEGORIES, RULE_DECISIONS, TASK_OWNERS, TASK_PRIORITIES, TASK_STATUSES,
} from './store.js'
import { BUILTIN_RULES, evaluate } from './rules.js'
import { detailView, hub } from './hub.js'
import { parseRepeat } from './repeat.js'
import { dayKey, nextDue } from './todo.js'

/** @typedef {import('./store.js').DotStore} DotStore */
/** @typedef {import('./store.js').Task} Task */
/** @typedef {import('./store.js').Memory} Memory */
/** @typedef {import('./store.js').Rule} Rule */

/**
 * @typedef {{
 *   maxMemories: number,
 *   timeZone: string | undefined,
 *   now?: () => Date,
 * }} ToolOptions
 */

/** 每个工具的统一输出：一句话摘要 + 可选结构化数据。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
  },
  required: ['summary'],
}

/**
 * @param {unknown} _args
 * @param {any} value
 */
function render(_args, value) {
  const { summary, ...rest } = value
  const text = Object.keys(rest).length === 0 ? summary : `${summary}\n${JSON.stringify(rest, null, 2)}`
  return [{ type: 'text', text }]
}

const CATEGORY_LABEL = { preference: '偏好', person: '人物', routine: '习惯', fact: '事实', account: '账户', other: '其他' }
const PRIORITY_LABEL = { high: '高', normal: '中', low: '低' }
const OWNER_LABEL = { user: '用户', dot: 'Dot', delegated: '已委派' }
const STATUS_LABEL = { open: '进行中', waiting: '等待中', done: '已完成', dropped: '已放弃' }

/**
 * 解析截止时间。接受 ISO 8601、`YYYY-MM-DD`、`YYYY-MM-DD HH:mm`；无时区的按宿主本地时间。
 * 空字符串表示清除。
 * @param {unknown} value
 * @returns {string | null | undefined} ISO 字符串；null 表示清除；undefined 表示未提供
 */
export function parseDue(value) {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw new Error('due 必须是字符串')
  let text = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += 'T23:59'
  text = text.replace(/^(\d{4}-\d{2}-\d{2})[\sT](\d{1,2}):(\d{2})/, (_, day, h, m) => `${day}T${h.padStart(2, '0')}:${m}`)
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`无法解析截止时间 ${JSON.stringify(value)}；请用 ISO 8601，例如 2026-11-12T09:00+08:00`)
  }
  return date.toISOString()
}

/**
 * @param {string} iso
 * @param {string | undefined} timeZone
 */
export function formatTime(iso, timeZone) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso))
}

/** @param {unknown} value @param {string} field */
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`缺少参数 ${field}`)
  return value.trim()
}

/**
 * @param {Task} task
 * @param {Date} now
 * @param {string | undefined} timeZone
 */
export function describeTask(task, now, timeZone) {
  const parts = [`[${task.id}]`, `[${PRIORITY_LABEL[task.priority] ?? task.priority}]`]
  if (task.status !== 'open') parts.push(`[${STATUS_LABEL[task.status] ?? task.status}]`)
  if (task.due) {
    const overdue = task.status !== 'done' && task.status !== 'dropped' && new Date(task.due) < now
    parts.push(`[截止 ${formatTime(task.due, timeZone)}${overdue ? ' 已逾期' : ''}]`)
  }
  if (task.today && task.today === dayKey(now)) parts.push('[今天]')
  parts.push(task.title)
  if (task.repeat) parts.push(`（${task.repeat.label}）`)
  const steps = Array.isArray(task.steps) ? task.steps : []
  if (steps.length) parts.push(`（步骤 ${steps.filter(s => s.done).length}/${steps.length}）`)
  if (task.status === 'waiting' && task.waitingOn) parts.push(`（在等：${task.waitingOn}）`)
  if (task.owner !== 'user') parts.push(`（${OWNER_LABEL[task.owner] ?? task.owner}）`)
  return parts.join(' ')
}

/** @param {Memory} memory */
export function describeMemory(memory) {
  return `[${memory.id}][${CATEGORY_LABEL[memory.category] ?? memory.category}] ${memory.text}`
}

/**
 * 简报的纯计算部分，便于测试。
 * @param {Readonly<import('./store.js').DotState>} state
 * @param {Date} now
 * @param {number} horizonHours
 */
export function computeBrief(state, now, horizonHours) {
  const active = state.tasks.filter(t => t.status === 'open' || t.status === 'waiting')
  const horizon = new Date(now.getTime() + horizonHours * 3600_000)
  const byDue = (/** @type {Task} */ a, /** @type {Task} */ b) => (a.due ?? '9999').localeCompare(b.due ?? '9999')
  const overdue = active.filter(t => t.due && new Date(t.due) < now).sort(byDue)
  const dueSoon = active.filter(t => t.due && new Date(t.due) >= now && new Date(t.due) <= horizon).sort(byDue)
  const highPriority = active.filter(t => t.priority === 'high' && !overdue.includes(t) && !dueSoon.includes(t))
  const waiting = active.filter(t => t.status === 'waiting')
  const delegated = active.filter(t => t.owner === 'delegated')
  const doneRecently = state.tasks.filter(t => t.status === 'done' && t.doneAt
    && now.getTime() - new Date(t.doneAt).getTime() <= 24 * 3600_000)
  return { active, overdue, dueSoon, highPriority, waiting, delegated, doneRecently }
}

/**
 * @param {DotStore} store
 * @param {ToolOptions} options
 * @param {readonly Rule[]} configRules 来自配置的固定规则（不可被模型删除）
 * @param {ReturnType<typeof import('./actions.js').createActions>} [actions] 提供时，带截止时间的事务会自动建提醒
 */
export function createTools(store, options, configRules, actions) {
  const now = options.now ?? (() => new Date())
  const tz = options.timeZone
  const sessionOf = (/** @type {any} */ exec) => exec?.agent?.id ?? exec?.agent?.session?.id
  /**
   * 工具参数里的周期：没给返回 undefined，空字符串返回 null（取消周期），看不懂就报错让模型换个说法。
   * @param {unknown} value
   */
  const parseRepeatArg = value => {
    if (value === undefined) return undefined
    const text = String(value).trim()
    if (!text) return null
    const r = parseRepeat(text, tz ?? 'UTC')
    if (!r) throw new Error(`看不懂周期「${text}」，换个说法，比如「每周一9点」「工作日18点」「每天9点」`)
    return { label: r.label, timing: r.timing }
  }

  /**
   * @param {any} args
   * @param {any} exec
   */
  async function addTask(args, exec) {
    const title = requireText(args.title, 'title')
    const rep = parseRepeatArg(args.repeat) ?? null
    const due = parseDue(args.due) ?? (rep ? nextDue(rep.timing, now())?.toISOString() ?? null : null)
    if (actions) {
      const r = await actions.addTask({
        title, notes: args.notes, priority: args.priority, owner: args.owner, due,
        remind: args.remind, sessionId: sessionOf(exec),
        today: args.today === true, steps: Array.isArray(args.steps) ? args.steps.map(String) : undefined, repeat: rep,
      })
      return { id: r.task.id, line: r.warning ? `${r.line}（${r.warning}）` : r.line }
    }
    return store.mutate((state, newId) => {
      const stamp = now().toISOString()
      /** @type {Task} */
      const task = {
        id: newId('t'), title, notes: args.notes ?? '', status: 'open',
        priority: args.priority ?? 'normal', owner: args.owner ?? 'user', due,
        createdAt: stamp, updatedAt: stamp, doneAt: null,
      }
      state.tasks.push(task)
      return { id: task.id, line: `已记下 ${describeTask(task, now(), tz)}` }
    })
  }

  const memoryTool = {
    name: 'dot_memory',
    description:
      '读写 Dot 关于用户的长期记忆（跨会话保留）。当用户透露了以后仍然有用的信息——偏好、常用账户/地址的非敏感描述、'
      + '人物关系、日常习惯、重要事实——用 remember 记下；信息过时用 update 或 forget。'
      + '不要记录密码、密钥、证件号、银行卡号等敏感数据。已有记忆会自动出现在上下文里，通常无需 list。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['remember', 'update', 'forget', 'list', 'search'], description: '操作' },
        text: { type: 'string', description: 'remember/update：一句话、自包含的记忆内容' },
        category: { type: 'string', enum: [...MEMORY_CATEGORIES], description: 'remember/update：分类，默认 fact' },
        id: { type: 'string', description: 'update/forget：记忆 id，如 m3' },
        query: { type: 'string', description: 'search：关键词（空格分隔，全部命中）' },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render },
    /** @param {any} args @param {any} [exec] */
    async execute(args, exec) {
      switch (args.action) {
        case 'remember': {
          const text = requireText(args.text, 'text')
          const before = store.snapshot().memories.length
          const out = await store.mutate((state, newId) => {
            const duplicate = state.memories.find(m => m.text === text)
            if (duplicate) return { summary: `已存在相同记忆 ${duplicate.id}，未重复记录。` }
            if (state.memories.length >= options.maxMemories) {
              throw new Error(`记忆已达上限 ${options.maxMemories} 条；请先 forget 过时的条目，或合并后 update。`)
            }
            const stamp = now().toISOString()
            const memory = { id: newId('m'), text, category: args.category ?? 'fact', createdAt: stamp, updatedAt: stamp }
            state.memories.push(memory)
            return { summary: `已记住 ${describeMemory(memory)}` }
          })
          if (actions && store.snapshot().memories.length > before) await actions.logTurn(sessionOf(exec), { kind: 'memory', text })
          return out
        }
        case 'update': {
          const id = requireText(args.id, 'id')
          return store.mutate(state => {
            const memory = state.memories.find(m => m.id === id)
            if (!memory) throw new Error(`没有记忆 ${id}`)
            if (args.text !== undefined) memory.text = requireText(args.text, 'text')
            if (args.category !== undefined) memory.category = args.category
            memory.updatedAt = now().toISOString()
            return { summary: `已更新 ${describeMemory(memory)}` }
          })
        }
        case 'forget': {
          const id = requireText(args.id, 'id')
          return store.mutate(state => {
            const index = state.memories.findIndex(m => m.id === id)
            if (index < 0) throw new Error(`没有记忆 ${id}`)
            const [removed] = state.memories.splice(index, 1)
            return { summary: `已忘记 ${describeMemory(removed)}` }
          })
        }
        case 'list':
        case 'search': {
          await store.load()
          const terms = args.action === 'search' ? requireText(args.query, 'query').toLowerCase().split(/\s+/) : []
          const found = store.snapshot().memories.filter(m => terms.every(t => m.text.toLowerCase().includes(t)))
          return {
            summary: found.length === 0 ? '没有匹配的记忆。' : found.map(describeMemory).join('\n'),
          }
        }
        default:
          throw new Error(`未知操作 ${args.action}`)
      }
    },
  }

  const tasksTool = {
    name: 'dot_tasks',
    description:
      '管理 Dot 替用户跟踪的事务清单（跨会话保留，不同于本轮编码用的 todo）。用户交代的事、答应要跟进的事、'
      + '等别人回复的事都放这里。owner：user=用户自己要做，dot=你负责，delegated=已交给子代理/外部。'
      + '带 due 的事务会自动建一个到点提醒（remind=false 可关闭），标记 done/dropped 时自动取消提醒，'
      + '所以不要再为同一件事调用 schedule_create。一次要记多件事或同时记偏好时，用 dot_capture 更快。'
      + '大一点的事拆成 steps（小步骤，用户可以逐个勾）；用户说「今天要做」就设 today=true；'
      + '固定周期的事（每周一交周报）设 repeat，完成后会自动生成下一次；在等别人回复时 status=waiting 并写 waiting_on。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'list'], description: '操作' },
        id: { type: 'string', description: 'update：事务 id，如 t2' },
        title: { type: 'string', description: 'add/update：一句话描述' },
        notes: { type: 'string', description: 'add/update：补充说明、进展、相关链接' },
        status: { type: 'string', enum: [...TASK_STATUSES], description: 'update：状态' },
        priority: { type: 'string', enum: [...TASK_PRIORITIES], description: 'add/update：优先级，默认 normal' },
        owner: { type: 'string', enum: [...TASK_OWNERS], description: 'add/update：负责人，默认 user' },
        due: { type: 'string', description: 'add/update：截止时间，ISO 8601（带时区最好）；空字符串清除' },
        remind: { type: 'boolean', description: 'add：有 due 时是否到点提醒，默认 true' },
        steps: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'add/update：小步骤，按顺序；update 时整个替换（同名步骤保留勾选状态）' },
        today: { type: 'boolean', description: 'add/update：放进（true）或移出（false）今天' },
        repeat: { type: 'string', description: 'add/update：周期，比如「每周一9点」「工作日18点」「每天9点」；空字符串取消周期。设了周期而没给 due 时，due 取下一次' },
        waiting_on: { type: 'string', description: 'update：status=waiting 时在等谁 / 等什么' },
        include_closed: { type: 'boolean', description: 'list：是否包含已完成/已放弃，默认 false' },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render },
    /** @param {any} args @param {any} exec */
    async execute(args, exec) {
      switch (args.action) {
        case 'add': {
          return { summary: (await addTask(args, exec)).line }
        }
        case 'update': {
          const id = requireText(args.id, 'id')
          const rep = parseRepeatArg(args.repeat)
          let due = parseDue(args.due)
          if (due === undefined && rep && rep.timing) due = nextDue(rep.timing, now())?.toISOString()
          // 完成 / 放弃交给 closeTasks：周期待办会生成下一次，提醒也一起处理
          const closing = Boolean(actions) && (args.status === 'done' || args.status === 'dropped')
          /** @type {string | undefined} */
          let staleReminder
          const result = await store.mutate(state => {
            const task = state.tasks.find(t => t.id === id)
            if (!task) throw new Error(`没有事务 ${id}`)
            if (args.title !== undefined) task.title = requireText(args.title, 'title')
            if (args.notes !== undefined) task.notes = args.notes
            if (args.priority !== undefined) task.priority = args.priority
            if (args.owner !== undefined) task.owner = args.owner
            if (due !== undefined) task.due = due
            if (rep === null) delete task.repeat
            else if (rep) task.repeat = rep
            if (args.today === true) task.today = dayKey(now())
            if (args.today === false) delete task.today
            if (typeof args.waiting_on === 'string') task.waitingOn = args.waiting_on.trim().slice(0, 60)
            if (Array.isArray(args.steps)) {
              const old = new Map((task.steps ?? []).map(x => [x.text, x.done]))
              const steps = args.steps.map(String).map((/** @type {string} */ x) => x.trim().slice(0, 120)).filter(Boolean).slice(0, 20)
              if (steps.length) task.steps = steps.map((/** @type {string} */ text) => ({ text, done: Boolean(old.get(text)) }))
              else delete task.steps
            }
            if (!closing && args.status !== undefined && args.status !== task.status) {
              task.status = args.status
              task.doneAt = args.status === 'done' ? now().toISOString() : null
              if (args.status === 'done') hub.flash(`完成：${task.title}`)
            }
            // 关闭事务或改了截止时间：旧提醒作废。
            const closed = task.status === 'done' || task.status === 'dropped'
            if (task.reminderId && (closed || due !== undefined)) {
              staleReminder = task.reminderId
              delete task.reminderId
            }
            task.updatedAt = now().toISOString()
            return { summary: `已更新 ${describeTask(task, now(), tz)}` }
          })
          if (staleReminder && actions) await actions.cancelReminder(staleReminder, sessionOf(exec))
          if (closing && actions) {
            const { closed, next } = await actions.closeTasks([id], args.status, sessionOf(exec))
            const t = closed[0]
            if (t) await actions.logTurn(sessionOf(exec), { kind: args.status, text: t.title, ref: id })
            const tail = next?.length ? `；下一次 ${describeTask(next[0], now(), tz)}` : ''
            return { summary: `${args.status === 'done' ? '完成' : '放弃'} ${t ? describeTask(t, now(), tz) : id}${tail}` }
          }
          const task = store.snapshot().tasks.find(t => t.id === id)
          if (actions && task) {
            if (args.status === 'done' || args.status === 'dropped') await actions.logTurn(sessionOf(exec), { kind: args.status, text: task.title, ref: id })
            else if (due !== undefined) await actions.logTurn(sessionOf(exec), { kind: 'due', text: `${task.title} → ${due ? formatTime(due, tz) : '不设时间'}`, ref: id })
          }
          if (actions && task && due && (task.status === 'open' || task.status === 'waiting')) {
            const r = await actions.scheduleReminder({ text: task.title, at: new Date(due), sessionId: sessionOf(exec), taskId: id })
            if ('id' in r) {
              await store.mutate(state => { const t = state.tasks.find(x => x.id === id); if (t) t.reminderId = r.id })
              return { summary: `${result.summary}，已按新时间重设提醒` }
            }
            return { summary: `${result.summary}（${r.warning}）` }
          }
          return result
        }
        case 'list': {
          await store.load()
          const tasks = store.snapshot().tasks
            .filter(t => args.include_closed || t.status === 'open' || t.status === 'waiting')
          if (tasks.length === 0) return { summary: '事务清单为空。' }
          const linked = (/** @type {Task} */ t) => {
            if (!t.linkedSession) return ''
            const o = hub.other(t.linkedSession)
            const st = !o ? '不在最近的会话里' : o.status === 'running' ? '运行中' : o.result === 'failed' ? '出错停下' : '已结束'
            return `\n    关联会话：「${o?.title ?? t.linkedSession}」${st}（dot_sessions read 可以看细节）`
          }
          return {
            summary: tasks.map(t => describeTask(t, now(), tz) + (t.notes ? `\n    备注：${t.notes}` : '') + linked(t)).join('\n'),
          }
        }
        default:
          throw new Error(`未知操作 ${args.action}`)
      }
    },
  }

  const rulesTool = {
    name: 'dot_rules',
    description:
      '查看或修改 Dot 的行为规则：按工具名（支持 * 通配，| 分隔多个）和可选的参数关键词设定 allow（直接做）、'
      + 'preapproved（用户事先同意过，抵消内置规则的「先问」）、ask（先征求用户同意）、handoff（交给用户亲自做）、block（禁止）。'
      + '另有不可删除的内置安全规则：付钱和密码类交给用户，对外发消息和删除先问。'
      + '内置「交给用户」的事被误拦时（比如用户明确让你在某个网站下单），只能由用户亲口要求后，加一条带 match 关键词收窄的 preapproved 规则覆盖，最好再设 until。'
      + '用户说“以后发消息前都问我”“别碰 xx”“这类事直接做”时使用。add/remove 每次都会弹出用户确认。'
      + 'allow 只表示 Dot 不额外打扰，不会绕过系统自身的权限设置。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove'], description: '操作' },
        tool: { type: 'string', description: 'add：工具名模式，如 web_fetch、pwsh、schedule_*' },
        decision: { type: 'string', enum: [...RULE_DECISIONS], description: 'add：allow / preapproved / ask / handoff / block' },
        match: { type: 'string', description: 'add：可选，参数关键词，用 | 分隔；只有参数里含其中一个时规则才生效，如 boss@example.com|周报' },
        until: { type: 'string', description: 'add：可选，规则到期时间（ISO 8601 带时区），如用户说「这周内」「今天」时设置' },
        note: { type: 'string', description: 'add：用户的原话或理由' },
        id: { type: 'string', description: 'remove：规则 id，如 r2' },
        check_tool: { type: 'string', description: 'list：可选，查看某个工具名当前会命中哪条规则' },
        check_args: { type: 'string', description: 'list：可选，配合 check_tool，模拟的参数文本' },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render },
    /** @param {any} args */
    async execute(args) {
      const describeRule = (/** @type {Rule} */ r, fixed = '') => {
        const words = r.match ? r.match.split('|') : []
        const match = words.length ? `（参数含 ${words.slice(0, 4).join('、')}${words.length > 4 ? '…' : ''}）` : ''
        const until = r.until ? ` 到 ${formatTime(r.until, tz)} 为止${new Date(r.until) <= now() ? '（已过期）' : ''}` : ''
        return `[${r.id}] ${r.tool}${match} → ${r.decision}${r.note ? `（${r.note}）` : ''}${until}${fixed ? ` [${fixed}]` : ''}`
      }
      switch (args.action) {
        case 'list': {
          await store.load()
          const lines = [
            ...BUILTIN_RULES.map(r => describeRule(/** @type {any} */ (r), '内置')),
            ...configRules.map(r => describeRule(r, '配置固定')),
            ...store.snapshot().rules.map(r => describeRule(r)),
          ]
          let summary = lines.length === 0 ? '暂无规则。' : lines.join('\n')
          if (typeof args.check_tool === 'string' && args.check_tool) {
            const v = evaluate(args.check_tool, args.check_args ?? '', [...configRules, ...store.snapshot().rules])
            summary += `\n${args.check_tool} → ${v.decision ? `${v.decision}（命中 ${v.rule?.id} ${v.rule?.tool}）` : '无规则，按 DSH 默认审批'}`
          }
          return { summary }
        }
        case 'add': {
          const tool = requireText(args.tool, 'tool')
          if (!RULE_DECISIONS.includes(args.decision)) throw new Error('decision 必须是 allow / ask / block')
          const match = typeof args.match === 'string' && args.match.trim() ? args.match.trim() : undefined
          const until = args.until ? parseDue(args.until) : null
          if (args.until && !until) throw new Error('until 不是有效的时间')
          if (until && new Date(until) <= now()) throw new Error('until 已经过去了')
          if (tool === 'dot_rules' || tool.split('|').some(p => p.trim() === '*')) {
            // dot_rules 自身永远 ask；`*` 的放行或禁止太宽，容易把 Dot 锁死或放开一切（带关键词的除外）。
            if (tool === 'dot_rules' ? args.decision !== 'ask' : !match && !['ask', 'handoff'].includes(args.decision)) {
              throw new Error(`不能把 ${tool} 设为 ${args.decision}${tool === 'dot_rules' ? '' : '：请加上 match 关键词收窄范围'}`)
            }
          }
          return store.mutate((state, newId) => {
            /** @type {Rule} */
            const rule = { id: newId('r'), tool, decision: args.decision, note: args.note ?? '', createdAt: now().toISOString(), ...(match ? { match } : {}), ...(until ? { until } : {}) }
            state.rules.push(rule)
            return { summary: `已添加规则 ${describeRule(rule)}` }
          })
        }
        case 'remove': {
          const id = requireText(args.id, 'id')
          if (BUILTIN_RULES.some(r => r.id === id)) throw new Error(`${id} 是内置安全规则，不能删除；要放行具体的事，加一条 preapproved 规则`)
          if (configRules.some(r => r.id === id)) throw new Error(`${id} 来自插件配置，只能在 cordis.patch.yml 里修改`)
          return store.mutate(state => {
            const index = state.rules.findIndex(r => r.id === id)
            if (index < 0) throw new Error(`没有规则 ${id}`)
            const [removed] = state.rules.splice(index, 1)
            return { summary: `已删除规则 ${describeRule(removed)}` }
          })
        }
        default:
          throw new Error(`未知操作 ${args.action}`)
      }
    },
  }

  const briefTool = {
    name: 'dot_brief',
    description:
      '生成一份当前事务简报：已逾期、即将到期、高优先级、等待中、已委派、最近完成。用于定时简报、用户问“今天有什么事”'
      + '或开始新一天时。拿到结果后用简短的中文向用户汇报重点，而不是原样贴出。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        horizon_hours: { type: 'number', description: '“即将到期”的时间窗口（小时），默认 24' },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render },
    /** @param {any} args */
    async execute(args) {
      await store.load()
      const at = now()
      const horizon = typeof args.horizon_hours === 'number' && args.horizon_hours > 0 ? args.horizon_hours : 24
      const b = computeBrief(store.snapshot(), at, horizon)
      const section = (/** @type {string} */ title, /** @type {Task[]} */ list) =>
        list.length === 0 ? [] : [`${title}（${list.length}）`, ...list.map(t => `  - ${describeTask(t, at, tz)}`)]
      const lines = [
        `现在 ${formatTime(at.toISOString(), tz)}，进行中的事务 ${b.active.length} 件。`,
        ...section('已逾期', b.overdue),
        ...section(`${horizon} 小时内到期`, b.dueSoon),
        ...section('其他高优先级', b.highPriority),
        ...section('等待他人', b.waiting),
        ...section('已委派', b.delegated),
        ...section('过去 24 小时完成', b.doneRecently),
      ]
      if (b.active.length === 0) lines.push('清单里没有待办事务。')
      // 用户别的会话最近做了什么（DSH 重启前的会话只有标题）
      const t = at.getTime()
      const recent = hub.others().filter(o => t - o.lastActive < 86_400_000).slice(0, 8)
      if (recent.length) {
        lines.push(`最近 24 小时的其他会话（${recent.length}）`)
        for (const o of recent) {
          const d = detailView(o.id, t)
          const state = o.status === 'running' ? '进行中' : o.result === 'failed' ? '出错停下' : '已结束'
          const files = d?.files?.length ? `，改了 ${d.files.length} 个文件` : ''
          const said = d?.lastText ? `：${d.lastText.replace(/\s+/g, ' ').slice(0, 80)}` : d?.error ? `：${d.error.slice(0, 80)}` : ''
          lines.push(`  - 「${o.title}」${state}${files}${said}`)
        }
      }
      const open = store.snapshot().suggestions.filter(s => s.status === 'open')
      if (open.length) lines.push(`待你看的建议（${open.length}，在 Dot 窗口「今天」页）`, ...open.slice(0, 5).map(s => `  - ${s.title}`))
      lines.push('提示：如需同时汇报定时提醒，可调用 schedule_list。')
      return { summary: lines.join('\n') }
    },
  }

  const suggestTool = {
    name: 'dot_suggest',
    description:
      '把一个「值得做但不急」的想法放进用户的建议收件箱，用户在 Dot 窗口点采纳或忽略。'
      + '用于你在汇报、巡检或干活时发现的事：比如某件事该跟进了、某个会话出错没人管、可以把重复的事设成周期提醒。'
      + '用户当面让你做的事直接做，不要再建议；同一件事不要反复建议。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '一句话建议，如「供应商报价等了 3 天，要不要催一下？」' },
        body: { type: 'string', description: '可选，一两句理由' },
        do_label: { type: 'string', description: '采纳按钮的文字，如「起草催办消息」，不超过 8 个字' },
        do_text: { type: 'string', description: '用户采纳后交给你执行的指令（以用户口吻），如「帮我起草催办供应商报价的消息，先给我看」。不给就是「记为事务」' },
        task_title: { type: 'string', description: '不给 do_text 时必填：采纳后记下的事务标题，写成要做的事，如「催供应商报价」' },
      },
      required: ['title'],
    },
    output: { schema: OUTPUT_SCHEMA, render },
    /** @param {any} args */
    async execute(args) {
      if (!actions) throw new Error('当前环境不支持建议收件箱')
      const title = requireText(args.title, 'title').slice(0, 80)
      const doText = typeof args.do_text === 'string' ? args.do_text.trim() : ''
      const option = doText
        ? { label: String(args.do_label || '交给 Dot 去做').slice(0, 12), action: { type: 'say', text: doText } }
        : { label: '记为事务', action: { type: 'task', title: requireText(args.task_title, 'task_title（不给 do_text 时必填）').slice(0, 80) } }
      const s = await actions.addSuggestion({
        key: `dot:${title}`, kind: 'dot', source: 'dot', title,
        body: typeof args.body === 'string' ? args.body.slice(0, 200) : '', options: [option],
      })
      return { summary: s ? `已放进建议收件箱（${s.id}），用户会在 Dot 窗口看到。` : '这条建议已经在收件箱里，或用户最近处理过，不再重复。' }
    },
  }

  const captureTool = {
    name: 'dot_capture',
    description:
      '一次性落地用户一句话里的所有可记录信息：事务（带截止时间会自动到点提醒）、单纯的提醒、长期记忆。'
      + '这是 Dot 最常用的工具——用户交代事情、约时间、说起自己的偏好时，抽取出结构后调用一次即可，'
      + '不要拆成多次 dot_tasks / dot_memory / schedule_create 调用。调用前不必向用户确认，事后用一句话汇报。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tasks: {
          type: 'array',
          description: '要跟进的事务',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', description: '一句话、动宾结构，如「把报价单发给王强」' },
              due: { type: 'string', description: '截止时间，ISO 8601 带时区；没有就省略' },
              priority: { type: 'string', enum: [...TASK_PRIORITIES] },
              owner: { type: 'string', enum: [...TASK_OWNERS] },
              notes: { type: 'string' },
              remind: { type: 'boolean', description: '有 due 时是否到点提醒，默认 true' },
            },
            required: ['title'],
          },
        },
        reminders: {
          type: 'array',
          description: '只需要到点提醒、不需要跟踪的事（如「半小时后叫我喝水」）',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string' },
              at: { type: 'string', description: 'ISO 8601 带时区' },
            },
            required: ['text', 'at'],
          },
        },
        memories: {
          type: 'array',
          description: '值得长期记住的用户信息',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string' },
              category: { type: 'string', enum: [...MEMORY_CATEGORIES] },
            },
            required: ['text'],
          },
        },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render },
    /** @param {any} args @param {any} exec */
    async execute(args, exec) {
      const lines = []
      for (const t of args.tasks ?? []) {
        try { lines.push((await addTask(t, exec)).line) } catch (e) { lines.push(`✗ 事务「${t.title}」：${errorText(e)}`) }
      }
      for (const r of args.reminders ?? []) {
        try {
          if (!actions) throw new Error('当前环境不支持提醒')
          const at = parseDue(r.at)
          if (!at) throw new Error('缺少时间')
          const res = await actions.scheduleReminder({ text: requireText(r.text, 'text'), at: new Date(at), sessionId: sessionOf(exec) })
          lines.push('id' in res ? `已设提醒：${formatTime(at, tz)} ${r.text}` : `✗ 提醒「${r.text}」：${res.warning}`)
          if ('id' in res) await actions.logTurn(sessionOf(exec), { kind: 'reminder', text: `${formatTime(at, tz)} ${r.text}`, ref: res.id })
        } catch (e) { lines.push(`✗ 提醒「${r.text}」：${errorText(e)}`) }
      }
      for (const m of args.memories ?? []) {
        try {
          if (actions) {
            const line = await actions.remember(m.text, m.category)
            lines.push(line)
            if (!line.startsWith('已经记得')) await actions.logTurn(sessionOf(exec), { kind: 'memory', text: m.text })
          } else lines.push((await memoryTool.execute({ action: 'remember', text: m.text, category: m.category }, exec)).summary)
        } catch (e) { lines.push(`✗ 记忆「${m.text}」：${errorText(e)}`) }
      }
      return { summary: lines.length ? lines.join('\n') : '没有需要记录的内容。' }
    },
  }

  return [captureTool, memoryTool, tasksTool, rulesTool, briefTool, suggestTool]
}

/** @param {unknown} e */
function errorText(e) {
  return e instanceof Error ? e.message : String(e)
}
