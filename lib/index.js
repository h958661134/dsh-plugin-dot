// @ts-check
/**
 * dsh-dot —— DeepSeek Harness 的“Dot 总管”。
 *
 * 作为 `dot` agent preset 的子插件挂载（每个 Dot 会话一份，作用域隔离），提供：
 *   - 长期记忆 dot_memory：跨会话记住用户偏好、人物、习惯，并自动注入上下文；
 *   - 事务清单 dot_tasks：替用户跟踪交代的事、等待的事、委派出去的事；
 *   - 行为规则 dot_rules + tools/pre-execute 闸门：allow / ask / block；
 *   - 简报 dot_brief：配合内置 schedule_create 实现每日主动简报。
 *
 * 状态保存在 `$DSH_HOME/dot/state.json`（可配置），所有 Dot 会话共享。
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { getStore, RULE_DECISIONS } from './store.js'
import { BUILTIN_RULES, evaluate, isRuleMutation } from './rules.js'
import { createTools, describeMemory, describeTask } from './tools.js'
import { DOT_GUIDE } from './prompt.js'
import { createActions } from './actions.js'
import { createSessionsTool } from './sessions.js'
import { describeArgs, hub, idOf, isDelegatedAgent, resolveChild, summarize, trace } from './hub.js'

export const name = 'dsh-dot'
export const inject = ['tools', 'systemPrompt']

/**
 * @typedef {{
 *   dataDir: string,
 *   timeZone: string | undefined,
 *   maxMemories: number,
 *   contextMemoryLimit: number,
 *   contextTaskLimit: number,
 *   guide: boolean,
 *   rules: import('./store.js').Rule[],
 * }} ResolvedConfig
 */

/**
 * 手动校验配置并填默认值。不导出 `Config`：Cordis 要求 Standard Schema，
 * 而本插件刻意不在运行时依赖 @deepseek-ai/schemastery；非法配置在加载时直接抛错。
 * @param {unknown} raw
 * @returns {ResolvedConfig}
 */
export function resolveConfig(raw) {
  const c = /** @type {Record<string, any>} */ (raw && typeof raw === 'object' ? raw : {})
  const fail = (/** @type {string} */ msg) => { throw new Error(`[dsh-dot] 配置错误：${msg}`) }
  const positiveInt = (/** @type {string} */ key, /** @type {number} */ fallback) => {
    if (c[key] === undefined) return fallback
    if (!Number.isInteger(c[key]) || c[key] < 0) fail(`${key} 必须是非负整数`)
    return c[key]
  }

  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dataDir = c.dataDir === undefined ? join(home, 'dot') : c.dataDir
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir)) fail('dataDir 必须是绝对路径')

  let timeZone = c.timeZone
  if (timeZone !== undefined) {
    if (typeof timeZone !== 'string') fail('timeZone 必须是 IANA 时区名，如 Asia/Shanghai')
    try { new Intl.DateTimeFormat('en', { timeZone }) } catch { fail(`未知时区 ${timeZone}`) }
  }

  const rawRules = c.rules ?? []
  if (!Array.isArray(rawRules)) fail('rules 必须是数组')
  const rules = rawRules.map((r, i) => {
    if (!r || typeof r.tool !== 'string' || r.tool.trim() === '') fail(`rules[${i}].tool 必须是非空字符串`)
    if (!RULE_DECISIONS.includes(r.decision)) fail(`rules[${i}].decision 必须是 ${RULE_DECISIONS.join(' / ')}`)
    return { id: `c${i + 1}`, tool: r.tool.trim(), decision: r.decision, note: String(r.note ?? ''), createdAt: '', ...(typeof r.match === 'string' && r.match.trim() ? { match: r.match.trim() } : {}) }
  })

  return {
    dataDir,
    timeZone,
    maxMemories: positiveInt('maxMemories', 200),
    contextMemoryLimit: positiveInt('contextMemoryLimit', 40),
    contextTaskLimit: positiveInt('contextTaskLimit', 15),
    guide: c.guide === undefined ? true : Boolean(c.guide),
    rules,
  }
}

/**
 * 每一步注入的动态上下文：记忆 + 进行中的事务 + 用户规则。
 * @param {import('./store.js').DotStore} store
 * @param {ResolvedConfig} config
 * @param {Date} now
 */
export function buildContextText(store, config, now) {
  const state = store.snapshot()
  const lines = ['# Dot 状态（来自 dsh-dot，跨会话持久）']
  if (store.recoveredFrom) {
    lines.push(`注意：原状态文件损坏，已另存为 ${store.recoveredFrom}，当前从空状态开始。请告知用户。`)
  }

  // 「工作偏好：」开头的记忆总是带上（最多 20 条），其余取最近的
  const prefs = state.memories.filter(m => m.text.startsWith('工作偏好')).slice(-20)
  const rest = state.memories.filter(m => !prefs.includes(m))
  const room = Math.max(0, config.contextMemoryLimit - prefs.length)
  const memories = [...prefs, ...(room ? rest.slice(-room) : [])]
  lines.push('', `## 关于用户的记忆（${state.memories.length} 条${memories.length < state.memories.length ? `，显示最近 ${memories.length} 条，其余用 dot_memory search` : ''}）`)
  lines.push(...(memories.length ? memories.map(m => `- ${describeMemory(m)}`) : ['- （暂无。了解到用户的长期信息时用 dot_memory 记下。）']))

  const rank = { high: 0, normal: 1, low: 2 }
  const active = state.tasks
    .filter(t => t.status === 'open' || t.status === 'waiting')
    .sort((a, b) => (rank[a.priority] - rank[b.priority]) || (a.due ?? '9999').localeCompare(b.due ?? '9999'))
  const shown = active.slice(0, config.contextTaskLimit)
  lines.push('', `## 进行中的事务（${active.length} 件${shown.length < active.length ? `，显示前 ${shown.length} 件，完整列表用 dot_tasks list` : ''}）`)
  lines.push(...(shown.length ? shown.map(t => `- ${describeTask(t, now, config.timeZone)}`) : ['- （清单为空。）']))

  const rules = [...config.rules, ...state.rules]
  lines.push('', '## 规则（系统会强制执行，你也应主动遵守）')
  lines.push('- 内置安全规则：' + BUILTIN_RULES.map(r => r.note).join('；') + '。handoff 的事直接告诉用户要他亲自做哪一步，不要尝试代做。')
  lines.push(...rules.filter(r => !r.until || new Date(r.until) > now).map(r => `- [${r.id}] ${r.tool}${r.match ? `（参数含 ${r.match}）` : ''} → ${r.decision}${r.note ? `：${r.note}` : ''}${r.until ? `（到 ${r.until} 为止）` : ''}`))
  return lines.join('\n')
}

/**
 * @param {any} ctx Cordis Context（agent preset 作用域）
 * @param {unknown} rawConfig
 */
export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const store = getStore(join(config.dataDir, 'state.json'))
  await store.load()
  const actions = createActions({
    store, getSchedule: () => ctx.get('schedule'), timeZone: config.timeZone, maxMemories: config.maxMemories,
  })

  for (const tool of createTools(store, { maxMemories: config.maxMemories, timeZone: config.timeZone }, config.rules, actions)) {
    ctx.tools.register(tool)
  }
  ctx.tools.register(createSessionsTool({ actions, getQuery: () => ctx.get?.('sessionQuery') }))

  if (config.guide) {
    ctx.systemPrompt.section({ name: 'dsh-dot:guide', order: 9000, interpolate: false, text: DOT_GUIDE })
  }
  ctx.systemPrompt.context({
    name: 'dsh-dot:state',
    order: 9000,
    interpolate: false,
    required: true,
    text: () => buildContextText(store, config, new Date()),
  })

  // ── 向状态中枢上报（浮标用）。监听器都在 preset 作用域里，只收到本会话（及其子树生命周期）的事件。
  const subagents = () => ctx.get('subagents')
  /** 本插件实例挂在 Dot 根会话上，还是挂在沿用 Dot 预设的子代理上。 */
  const isChildAgent = (/** @type {any} */ agent) => isDelegatedAgent(agent, id => hub.isChild(id))
  /** @type {Set<string>} */
  const seen = new Set()

  ctx.on('agent/status', (/** @type {any} */ { agent, status }) => {
    const child = isChildAgent(agent)
    trace(`status ${String(agent?.id ?? '?').slice(-8)} ${status}${child ? ' (child)' : ''}`)
    if (child) return // 子代理的状态由 Host 的全局监听统一记录
    const id = agent?.id
    if (id) seen.add(id)
    hub.rootStatus(agent, status)
  })
  ctx.on('tools/result', (/** @type {any} */ exec) => {
    hub.removeDecision(exec)
    if (!isChildAgent(exec.agent)) hub.rootTool(exec.agent, null)
  })
  // 子代理生命周期：按子树根分发，Dot 根会话的作用域能收到整棵树的开始和结束。
  ctx.on('subagent/start', (/** @type {any} */ info) => {
    const r = resolveChild(ctx.get('agents'), subagents(), info.id)
    const parentId = info.parentSessionId ?? r.parentId
    trace(`subagent/start ${String(info?.id).slice(-8)} ${r.name ?? '?'} parent ${String(parentId).slice(-8)}`)
    hub.childStart({ id: info.id, parentId, rootId: r.rootId ?? parentId, name: r.name ?? info.id, ref: ctx.get('agents')?.get?.(info.id) })
  })
  ctx.on('subagent/end', (/** @type {any} */ info) => {
    trace(`subagent/end ${String(info?.id).slice(-8)} ${info?.stopReason}`)
    hub.childEnd({ id: info.id, stopReason: info.stopReason, summary: summarize(info.lastAssistantMessage) })
  })
  ctx.effect?.(() => () => { for (const id of seen) hub.forget(id) })

  /**
   * 闸门的返回值统一经过这里：需要用户确认时登记到「待你决定」。
   * @param {any} exec @param {any} decision
   */
  const report = (exec, decision) => {
    if (decision?.kind === 'ask') {
      hub.addDecision(exec, {
        agentId: exec.agent?.id ?? '', label: hub.labelOf(exec.agent), tool: exec.name,
        reason: decision.displayReason?.zh ?? decision.reason ?? `调用 ${exec.name}`,
      })
    }
    return decision
  }

  // 暂停时只放行只读操作，让 Dot 还能回答“我暂停了”。
  const READ_ONLY = /^(dot_brief|ask_user.*|read.*|view.*|glob|grep|fs_search.*|search.*)$/
  const readOnlyDotCall = (/** @type {any} */ exec) =>
    (exec.name === 'dot_memory' && ['list', 'search'].includes(exec.arguments?.action))
    || (exec.name === 'dot_tasks' && exec.arguments?.action === 'list')
    || (exec.name === 'dot_rules' && exec.arguments?.action === 'list')

  // 规则闸门。监听器注册在 preset 作用域里，只拦截 Dot 会话（及沿用 Dot 预设的子代理）自己的工具调用。
  ctx.on('tools/pre-execute', async (/** @type {any} */ exec, /** @type {() => Promise<any>} */ next) => {
    if (!isChildAgent(exec.agent)) {
      const id = exec.agent?.id
      if (id) seen.add(id)
      hub.rootTool(exec.agent, exec.name)
      if (/^ask_user/.test(exec.name)) {
        hub.addDecision(exec, { agentId: id ?? '', label: 'Dot', tool: exec.name, reason: String(exec.arguments?.question ?? exec.arguments?.questions?.[0]?.question ?? 'Dot 有问题要问你') })
      }
    }

    // 用户停掉的子任务，Dot 收到「已停止」通知后常会自己发消息把它续上；拦下来，先问用户。
    if (exec.name === 'send_message') {
      const held = hub.heldChild(exec.arguments?.agent_id ?? exec.arguments?.agentId ?? exec.arguments?.to)
      if (held) {
        hub.ruleHit({ stage: 'held', tool: exec.name, decision: 'block', label: hub.labelOf(exec.agent), note: `子任务 ${held.name} 已被你停止` })
        return { kind: 'deny', reason: `子任务 ${held.name} 已被停止。不要自己让它继续：先用一句话告诉用户它停在哪一步，问用户要不要继续；用户要继续时，用户会在面板上给它补一句。` }
      }
    }

    if (store.snapshot().paused && !READ_ONLY.test(exec.name) && !readOnlyDotCall(exec)) {
      hub.ruleHit({ stage: 'paused', tool: exec.name, decision: 'block', label: hub.labelOf(exec.agent), note: 'Dot 暂停中' })
      return { kind: 'deny', reason: 'Dot 已被用户暂停：恢复前不要执行任何操作。告诉用户输入 /resume 即可恢复。' }
    }

    if (isRuleMutation(exec.name, exec.arguments)) {
      const inner = await next()
      if (inner.kind !== 'allow') return report(exec, inner)
      const a = exec.arguments ?? {}
      const what = a.action === 'add' ? `新增规则：${a.tool}${a.match ? `（参数含 ${a.match}）` : ''} → ${a.decision}` : `删除规则 ${a.id}`
      hub.ruleHit({ stage: 'mutation', tool: exec.name, decision: 'ask', label: hub.labelOf(exec.agent), note: what })
      return report(exec, { kind: 'ask', reason: `Dot 请求修改行为规则（${what}）`, displayReason: { en: `Dot wants to change its rules (${what})`, zh: `Dot 请求修改行为规则（${what}）` } })
    }

    const verdict = evaluate(exec.name, exec.arguments, [...config.rules, ...store.snapshot().rules])
    const rule = verdict.rule
    const label = hub.labelOf(exec.agent)
    const tag = rule ? `${rule.id}${rule.note ? `「${rule.note}」` : ''}` : ''
    const overrideNote = verdict.overrides ? `你的规则 ${rule?.id} 放行了内置规则 ${verdict.overrides} 要拦的事` : '' 
    /** @param {string} stage */
    const log = stage => hub.ruleHit({
      stage, ruleId: rule?.id, layer: verdict.layer ?? undefined, tool: exec.name,
      decision: verdict.decision ?? 'none', label, note: overrideNote || rule?.note || describeArgs(exec.name, exec.arguments),
    })
    if (!verdict.decision || verdict.decision === 'allow' || verdict.decision === 'preapproved') {
      // preapproved：用户事先同意过，Dot 不再加问；DSH 自身的审批照常。
      log(verdict.decision ?? 'pass')
      return report(exec, await next())
    }
    if (verdict.decision === 'block') {
      log('block')
      return { kind: 'deny', reason: `用户规则禁止调用 ${exec.name}（规则 ${tag}：${rule?.tool} → block）。请换一种方式，或向用户说明。` }
    }
    if (verdict.decision === 'handoff') {
      log('handoff')
      const what = describeArgs(exec.name, exec.arguments) || exec.name
      hub.notify({ kind: 'handoff', sessionId: exec.agent?.id ?? '', title: label, text: `${rule?.note || '这件事要你亲自做'}：${what}` })
      hub.flash(`${label} 把一件事交给你亲自做`, 'handoff')
      return {
        kind: 'deny',
        reason: `按 Dot 的安全规则 ${tag}，这一步（${exec.name}）必须由用户亲自完成，Dot 不能代做，也不要换个工具重试。`
          + '请用一两句话告诉用户：需要他亲自做哪一步、去哪里做、要准备什么；其余不涉及这一步的工作可以继续。',
      }
    }
    // ask：先让后续策略（权限预设、沙箱等）表态；它们已拒绝或已要求确认时不再叠加。
    log('ask')
    const inner = await next()
    const reason = `按 Dot 规则 ${tag}，调用 ${exec.name} 前需要你确认`
    if (inner.kind === 'ask') {
      // DSH 自己也要确认：两条理由一起显示，你能看到 Dot 规则也要求先问
      const zh = `${inner.displayReason?.zh ?? inner.reason ?? ''}（另外：${reason}）`
      const en = `${inner.displayReason?.en ?? inner.reason ?? ''} (also: Dot rule ${rule?.id})`
      return report(exec, { ...inner, reason: zh, displayReason: { ...(inner.displayReason ?? {}), zh, en } })
    }
    if (inner.kind !== 'allow') return report(exec, inner)
    return report(exec, { kind: 'ask', reason, displayReason: { en: `Dot rule ${rule?.id} asks before running ${exec.name}`, zh: reason } })
  })
}
