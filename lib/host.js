// @ts-check
/**
 * dsh-plugin-dot（包根，全局行）—— 浮标的 Host 侧：状态接口 + 一句话入口 + 自托管前端脚本。
 *
 *   GET  /api/dsh-plugin-dot/status   宠物状态快照
 *   POST /api/dsh-plugin-dot/say      { text }：以 / 开头的走快捷指令，否则发给最近的 Dot 会话
 *   POST /api/dsh-plugin-dot/done     { id }：完成一件事务
 *   POST /api/dsh-plugin-dot/child    { id, action: 'stop' | 'say', text? }：停止子代理 / 给它补一句
 *   POST /api/dsh-plugin-dot/schedule { id, active }：暂停或恢复一个 Dot 定时任务
 *   GET  /dsh-plugin-dot/client.js    浮标脚本（通过 webserver/index-inject 注入页面）
 *
 * 安全：这些路由能驱动 agent，所以除了 DSH 自身的防护，这里再做三层校验——
 * Host 必须是本机或 DSH 自己的地址（防 DNS rebinding）、Origin 必须同源、
 * 写操作必须带 `X-Dot-Client` 头和 JSON 体（跨站请求会被 CORS 预检挡住）。
 */

import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { getStore } from './store.js'
import { resolveConfig } from './index.js'
import { createActions, sessionIdOf, userMessage } from './actions.js'
import { createCommandHandlers } from './commands.js'
import { BUILTIN_RULES, evaluate } from './rules.js'
import { checkPetLook, checkRouteChange, PET_COLORS, resolveRoutes, ROUTE_EVENTS } from './routes.js'
import { describeAction, patrol } from './suggest.js'
import { findStale, searchUserSessions } from './sessions.js'
import { detailView, hub, hubCopies, idOf, isDelegatedAgent, petStatus, resolveChild, trace, traceLog } from './hub.js'

export const name = 'dsh-dot-host'
export const inject = ['webServer']

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const MAX_BODY = 16 * 1024

/**
 * @param {string | undefined} hostHeader
 * @param {Set<string>} allowed
 */
export function hostAllowed(hostHeader, allowed) {
  if (!hostHeader) return false
  const host = hostHeader.toLowerCase().replace(/:\d+$/, '')
  return LOOPBACK.has(host) || allowed.has(host)
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {Set<string>} allowedHosts
 * @param {boolean} write
 * @returns {string | null} 拒绝原因；null 表示放行
 */
export function checkRequest(req, allowedHosts, write) {
  const host = req.headers.host
  if (!hostAllowed(host, allowedHosts)) return 'host not allowed'
  const origin = req.headers.origin
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== String(host).toLowerCase()) return 'cross-origin'
    } catch {
      return 'bad origin'
    }
  }
  if (write) {
    if (req.method !== 'POST') return 'method'
    if (req.headers['x-dot-client'] !== '1') return 'missing client header'
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return 'content-type'
  }
  return null
}

/** @param {import('node:http').IncomingMessage} req */
async function readJson(req) {
  let size = 0
  /** @type {Buffer[]} */
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('body too large')
    chunks.push(chunk)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} code
 * @param {unknown} body
 */
/**
 * 一轮对话里 Dot 做下的事：在这个会话里新建的事务（带当前状态），以及 Dot 提出的建议。
 * 前后各放宽 2 秒，抵消时钟和写盘的先后。
 * @param {import('./store.js').DotState} state
 * @param {string} sessionId @param {number} from @param {number} to 毫秒时间戳
 */
export function turnEffects(state, sessionId, from, to) {
  if (!sessionId || !Number.isFinite(from) || !Number.isFinite(to)) return { tasks: [], suggestions: [], effects: [] }
  const inTurn = (/** @type {string | number} */ when) => {
    const t = typeof when === 'number' ? when : new Date(when).getTime()
    return t >= from - 2000 && t <= to + 2000
  }
  return {
    // 提醒、记住的事、完成 / 放弃 / 改期的事务
    effects: state.turnLog
      .filter(x => x.sessionId === sessionId && inTurn(x.at))
      .map(x => ({ kind: x.kind, text: x.text, ref: x.ref ?? null })),
    tasks: state.tasks
      .filter(t => t.createdIn === sessionId && inTurn(t.createdAt))
      .map(t => ({ id: t.id, title: t.title, status: t.status, due: t.due, priority: t.priority })),
    suggestions: state.suggestions
      .filter(s => s.source === 'dot' && inTurn(s.createdAt))
      .map(s => ({ id: s.id, title: s.title, status: s.status, options: s.options.map(o => ({ label: o.label })) })),
  }
}

/**
 * 把判定结果翻成一句人话（规则页「试一试」用）。
 * @param {string} tool @param {import('./rules.js').Verdict} v
 */
export function explainVerdict(tool, v) {
  const r = v.rule
  const who = r ? `${v.layer === 'builtin' ? '内置规则' : '规则'} ${r.id}${r.note ? `「${r.note}」` : ''}` : ''
  const others = v.hits.filter(h => h.id !== r?.id).map(h => `${h.id}→${h.decision}`)
  const also = others.length ? `（同时命中 ${others.join('、')}，按优先级取这条）` : ''
  const exempt = v.exempt ? '（这个工具是只读或 Dot 自己的账本，内置规则不看它）' : ''
  switch (v.decision) {
    case 'block': return `拦下：${who} 禁止 ${tool}。${also}`
    case 'handoff': return `交给你：${who}，Dot 不会代做，会告诉你要亲自做哪一步。${also}`
    case 'ask': return `先问你：${who}，Dot 会先弹确认。${also}`
    case 'preapproved': return `事先同意：${who}${v.overrides ? `，覆盖了内置规则 ${v.overrides}` : ''}，Dot 不再加问，DSH 自己的审批照常。${also}`
    case 'allow': return `放行：${who}，Dot 不额外打扰，DSH 自己的审批照常。${also}`
    default: return `没有规则命中，按 DSH 默认审批走。${exempt}`
  }
}

function send(res, code, body) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * 选出接收消息的 Dot 会话：正在运行的优先，其次最近活跃的。
 * @param {any} ctx
 */
export function pickDotAgent(ctx) {
  const agents = ctx.get?.('agents')
  const presets = ctx.get?.('agentPresets')
  // 优先用 ctx.agents 里的活对象：事件里带的 agent 引用不一定是它。
  const tracked = hub.roots().map(r => agents?.get?.(r.id) ?? r.ref).filter(Boolean)
  /** @type {any[]} */
  let candidates = tracked
  if (agents?.list && presets?.presetForSession) {
    const ids = new Set(tracked.map(a => sessionIdOf(a)))
    for (const a of agents.list()) {
      if (ids.has(sessionIdOf(a))) continue
      try {
        if (presets.presetForSession(a.session) === 'dot') candidates.push(a)
      } catch { /* 读不到预设的会话忽略 */ }
    }
  }
  candidates = candidates.filter(a => typeof a?.followup === 'function' && !isDelegatedAgent(a, id => hub.isChild(id)))
  return candidates.find(a => a.status === 'running') ?? candidates[0]
}

/**
 * @param {any} ctx
 * @param {unknown} rawConfig
 */
export async function apply(ctx, rawConfig) {
  const raw = /** @type {Record<string, any>} */ (rawConfig && typeof rawConfig === 'object' ? rawConfig : {})
  const config = resolveConfig(raw)
  const petEnabled = raw.pet === undefined ? true : Boolean(raw.pet)
  const watchOthers = raw.watchOthers === undefined ? true : Boolean(raw.watchOthers)
  const allowedHosts = new Set((Array.isArray(raw.trustedHosts) ? raw.trustedHosts : []).map(h => String(h).toLowerCase()))
  try {
    allowedHosts.add(new URL(ctx.webServer.getOrigin()).hostname.toLowerCase())
  } catch { /* 端口尚未绑定时忽略，回环地址始终允许 */ }

  const store = getStore(join(config.dataDir, 'state.json'))
  await store.load()
  const actions = createActions({
    store, getSchedule: () => ctx.get?.('schedule'), timeZone: config.timeZone, maxMemories: config.maxMemories,
  })
  // 盯着的会话和未读通知存进 state.json：DSH 重启后还在
  hub.loadPersisted({ watched: store.snapshot().watched, notices: /** @type {any} */ (store.snapshot().notices) })
  let persistTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null)
  hub.onPersist(() => {
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      store.mutate(state => {
        state.watched = hub.watchedIds().slice(-50)
        state.notices = /** @type {any} */ (hub.notices())
      }).catch(error => trace(`persist failed: ${error instanceof Error ? error.message : String(error)}`))
    }, 300)
  })
  /** 所有 Dot 根会话 id：状态中枢里登记的 + 按预设查到的。 */
  const dotSessionIds = () => {
    const ids = new Set(hub.roots().map(r => r.id))
    const agents = ctx.get?.('agents')
    const presets = ctx.get?.('agentPresets')
    if (agents?.list && presets?.presetForSession) {
      for (const a of agents.list()) {
        try { if (presets.presetForSession(a.session) === 'dot' && !hub.isChild(idOf(a))) ids.add(idOf(a)) } catch { /* 忽略 */ }
      }
    }
    return [...ids]
  }
  // 记住用过的 Dot 会话：DSH 重启后会话还没加载时，「打开 Dot」也知道去哪
  const seenFile = join(config.dataDir, 'dot-sessions.json')
  /** @type {Record<string, number>} 会话 id → 最近活跃时间 */
  let seenDot = {}
  try { seenDot = JSON.parse(readFileSync(seenFile, 'utf8')) ?? {} } catch { /* 第一次用 */ }
  hub.configure({ watchOthers, isDot: id => dotSessionIds().includes(id) || Object.hasOwn(seenDot, id) })
  const rememberDot = () => {
    let changed = false
    for (const r of hub.roots()) {
      // 精确到分钟，避免每次轮询都写盘
      const minute = Math.floor(r.lastActive / 60_000) * 60_000
      if (seenDot[r.id] !== minute) { seenDot[r.id] = minute; changed = true }
    }
    if (!changed) return
    const recent = Object.entries(seenDot).sort((a, b) => b[1] - a[1]).slice(0, 10)
    seenDot = Object.fromEntries(recent)
    writeFile(seenFile, JSON.stringify(seenDot)).catch(() => { /* 写不了不影响功能 */ })
  }

  /** 会话记录里的 Dot 会话（还没加载的也算），最近用过的在前；缓存一分钟。 */
  let storedDot = { at: 0, ids: /** @type {string[]} */ ([]) }
  const knownDotSessions = async () => {
    rememberDot()
    const live = [...dotSessionIds(), ...Object.entries(seenDot).sort((a, b) => b[1] - a[1]).map(([id]) => id)]
    const query = ctx.get?.('sessionQuery')
    if (query?.listSessions && Date.now() - storedDot.at > 60_000) {
      try {
        const headers = (await query.listSessions())
          .map((/** @type {any} */ r) => r?.header)
          .filter((/** @type {any} */ h) => h?.id && h.agentPreset === 'dot' && !h.parentSession)
        // 定时提醒在没有 Dot 会话时会开一个新会话（标题「Dot 提醒：…」），那不是用户的主对话，排到后面
        /** @type {Set<string>} */
        const reminders = new Set()
        try {
          const snaps = await query.readTitleSnapshots(headers.map((/** @type {any} */ h) => h.id))
          snaps.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
            const title = s?.status === 'fulfilled' ? s.value?.title?.title : undefined
            if (typeof title === 'string' && title.startsWith('Dot 提醒')) reminders.add(headers[i].id)
          })
        } catch { /* 读不到标题就只按时间排 */ }
        const ids = headers
          .sort((/** @type {any} */ a, /** @type {any} */ b) =>
            Number(reminders.has(a.id)) - Number(reminders.has(b.id)) || (b.createdAt ?? 0) - (a.createdAt ?? 0))
          .map((/** @type {any} */ h) => String(h.id))
        storedDot = { at: Date.now(), ids }
      } catch { storedDot = { at: Date.now(), ids: storedDot.ids } }
    }
    return [...new Set([...live, ...storedDot.ids])]
  }
  const handlers = createCommandHandlers({ actions, store, configRules: config.rules, timeZone: config.timeZone, dotSessionIds })

  // ── 子代理过程跟踪：子代理的事件不会冒泡到父会话的作用域，只能全局监听，再按 id 过滤。
  //    非 Dot 子树的事件第一步就返回，不做任何记录。
  /** 子任务开始时没解析全的信息，在它后续的事件里补上。 @param {string} id @param {any} agent */
  const complete = (id, agent) => {
    if (hub.childIncomplete(id)) hub.childUpdate(id, resolveChild(ctx.get?.('agents'), ctx.get?.('subagents'), id, agent))
  }
  /**
   * 这个会话属于谁：Dot 的子任务 / Dot 本身 / 别的会话派出的子代理 / 用户的其他会话。
   * @param {any} agent
   * @returns {'child' | 'dot' | 'nested' | 'other' | null}
   */
  const kindOf = agent => {
    const id = idOf(agent)
    if (!id) return null
    if (hub.isChild(id)) return 'child'
    if (hub.roots().some(r => r.id === id)) return 'dot'
    if (isDelegatedAgent(agent)) return 'nested'
    try { if (ctx.get?.('agentPresets')?.presetForSession(agent.session) === 'dot') return 'dot' } catch { /* 读不到预设 */ }
    return 'other'
  }
  /** @param {any} agent */
  const titleOf = agent => {
    try { return String(ctx.get?.('sessionTitle')?.get(agent.session)?.title ?? '') } catch { return '' }
  }

  ctx.on('agent/status', (/** @type {any} */ { agent, status }) => {
    const id = idOf(agent)
    if (!id) return
    if (hub.isChild(id)) { complete(id, agent); hub.childStatus(id, status); return }
    if (watchOthers && kindOf(agent) === 'other') hub.otherStatus(agent, status, titleOf(agent))
  }, { global: true })
  ctx.on('tools/pre-execute', async (/** @type {any} */ exec, /** @type {() => Promise<any>} */ next) => {
    const id = idOf(exec.agent)
    // 只看根调用：PTC 等嵌套子调用不单独算一步
    const nested = Boolean(exec.parent)
    if (id && hub.isChild(id)) { complete(id, exec.agent); hub.childTool(id, exec.name) }
    else if (id && hub.other(id)) hub.otherTool(id, exec.name)
    if (id && !nested) hub.stepStart(id, String(exec.name ?? ''), exec.arguments)
    return next()
  }, { global: true })
  ctx.on('tools/result', (/** @type {any} */ exec, /** @type {any} */ result) => {
    const id = idOf(exec.agent)
    if (id && hub.isChild(id)) hub.childToolEnd(id)
    else if (id && hub.other(id)) hub.otherTool(id, null)
    if (id && !exec.parent) hub.stepEnd(id, String(exec.name ?? ''), !result?.isError)
  }, { global: true })
  ctx.on('agent/error', (/** @type {any} */ { agent, error }) => {
    const id = idOf(agent)
    if (id && hub.other(id)) hub.otherResult(id, 'failed')
    if (id) hub.failed(id, error)
  }, { global: true })
  // 会话说完一段话：只取已经定稿的文本块，用作「最后一句回复」
  ctx.on('agent/assistant-stream', (/** @type {any} */ { agent, frame }) => {
    const block = frame?.type === 'chunk' && frame.chunk?.type === 'block-end' ? frame.chunk.block : null
    if (block?.type !== 'text' || typeof block.text !== 'string') return
    const id = idOf(agent)
    if (id) hub.said(id, block.text)
  }, { global: true })

  // 权限审批：任何会话在等你批准时都进「待你决定」，批完（或取消）就撤掉。
  // prepend：排在界面应答者前面，才能看到请求开始和结束。
  ctx.on('approval/request', async (/** @type {any} */ request, /** @type {() => Promise<any>} */ next) => {
    const agent = request?.agent
    const id = idOf(agent)
    const kind = id ? kindOf(agent) : null
    const tracked = kind === 'dot' || kind === 'child' || (watchOthers && (kind === 'other' || kind === 'nested'))
    // Dot 自己的规则闸门已经登记过同一个调用，不重复
    const dup = hub.decisions().some(d => d.agentId === id && d.tool === request?.toolName)
    if (!tracked || dup) return next()
    if (kind === 'other' && !hub.other(id)) hub.otherStatus(agent, 'running', titleOf(agent))
    const label = kind === 'dot' ? 'Dot' : kind === 'child' ? hub.labelOf(agent) : kind === 'other' ? (titleOf(agent) || hub.labelOf(agent)) : '某个子代理'
    const reason = String(request.displayReason?.zh ?? request.reason ?? request.displayReason?.en ?? `想调用 ${request.toolName}`)
    hub.addDecision(request, { agentId: /** @type {string} */ (id), label, tool: String(request.toolName ?? ''), reason })
    try {
      return await next()
    } finally {
      hub.removeDecision(request)
    }
  }, { global: true, prepend: true })

  const guard = (/** @type {any} */ req, /** @type {any} */ res, /** @type {boolean} */ write) => {
    const reason = checkRequest(req, allowedHosts, write)
    if (reason) send(res, 403, { error: reason })
    return reason === null
  }

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-plugin-dot/status',
    handler: async (/** @type {any} */ req, /** @type {any} */ res) => {
      if (!guard(req, res, false)) return
      await store.load()
      const scheduled = await actions.listSchedules(dotSessionIds())
      const dotSessions = await knownDotSessions()
      await runPatrol(scheduled)
      send(res, 200, { ...petStatus(store.snapshot(), new Date(), { scheduled, routes: resolveRoutes(store.snapshot().prefs) }), suggestions: openSuggestions(), pet: store.snapshot().prefs.pet ?? {}, watchedIds: hub.watchedIds(), dotSessions, hasDotSession: Boolean(pickDotAgent(ctx)) || dotSessions.length > 0, diag: { hubCopies: hubCopies(), trace: traceLog() } })
    },
  })

  /**
   * 把一句话交给 Dot。Dot 会话已加载就直接发；没加载就通过定时服务投递到最近用的 Dot 会话（会把它唤起）。
   * @param {string} text 以用户口吻
   * @param {string} [sessionId] 优先投递到这个会话
   */
  async function deliverToDot(text, sessionId) {
    const agents = ctx.get?.('agents')
    const live = (sessionId && agents?.get?.(sessionId)) || pickDotAgent(ctx)
    if (live?.followup) {
      live.followup(userMessage(text))
      return '交给 Dot 了'
    }
    const target = sessionId || (await knownDotSessions())[0]
    await actions.deliverToDot(text, target)
    return target ? '交给 Dot 了，几秒后它会在 Dot 会话里接着做' : '交给 Dot 了，几秒后会新开一个 Dot 会话来做'
  }

  // ── v0.8 会话调度：转告、派活、收纳（都由用户点了建议卡才执行）──
  /** 目标必须是用户自己的顶层会话。 @param {string} id */
  const assertUserSession = id => {
    if (!watchOthers) throw new Error('「监控其他会话」已关掉')
    if (!id || hub.isDotSession(id) || hub.isChild(id)) throw new Error('不能对 Dot 自己的会话或子代理这样做')
  }
  /**
   * 把一句话送进另一个会话，带上「Dot 代你转告」，那个会话知道这话不是用户亲手打的。
   * @param {string} id @param {string} text @param {string} title
   */
  async function relay(id, text, title) {
    assertUserSession(id)
    const prompt = `（Dot 代你转告）${text}`
    const live = ctx.get?.('agents')?.get?.(id)
    const name = hub.other(id)?.title || title || '那个会话'
    if (live?.followup) {
      live.followup(userMessage(prompt))
    } else {
      const schedule = ctx.get?.('schedule')
      if (!schedule?.create) throw new Error('那个会话没加载，而且没有定时服务可以把它唤起')
      await schedule.create({ title: `Dot 转告：${text}`.slice(0, 120), prompt, timing: { kind: 'after', after_seconds: 2 }, target: { kind: 'session', sessionId: id } })
    }
    trace(`relay → ${id}`)
    return live?.followup ? `已转告「${name}」` : `已转告「${name}」，几秒后送到`
  }
  /**
   * 新开一个会话去干活：预留的会话 id 先盯上，再记一件关联它的「已委派」事务。
   * @param {string} title @param {string} brief @param {string} [cwd]
   */
  async function dispatch(title, brief, cwd) {
    const schedule = ctx.get?.('schedule')
    if (!schedule?.create) throw new Error('没有定时服务，开不了新会话')
    const prompt = `${brief}

（这是用户通过 Dot 派给你的任务。做完请用几句话总结：做了什么、改了哪些文件、还剩什么没做。）`
    const entry = await schedule.create({
      title: `Dot 派活：${title}`.slice(0, 120), prompt, timing: { kind: 'after', after_seconds: 2 },
      target: { kind: 'new_once', ...(cwd ? { create: { cwd } } : {}) },
    })
    const sid = entry?.target?.sessionId
    if (typeof sid === 'string' && sid) hub.prewatch(sid, title)
    await actions.addTask({ title: `已委派：${title}`, owner: 'delegated', notes: sid ? `会话 ${sid}` : '', ...(sid ? { linkedSession: sid } : {}) })
    trace(`dispatch → ${sid ?? '?'}`)
    return sid ? '新会话几秒后开工，Dot 盯着，做完告诉你' : '新会话几秒后开工（拿不到会话 id，没能自动盯上）'
  }
  /** @param {string[]} ids */
  async function archive(ids) {
    const registry = ctx.get?.('workspaceRegistry')
    if (!registry?.archiveSession) throw new Error('这个 DSH 不支持归档会话')
    /** @type {string[]} */
    const done = []
    /** @type {string[]} */
    const skipped = []
    for (const id of ids) {
      assertUserSession(id)
      const title = hub.other(id)?.title ?? id
      try {
        await registry.archiveSession(id) // 不带 stopActivity：正在跑的会话 DSH 会拒绝，Dot 不强停
        done.push(id)
        hub.dismiss(id)
      } catch {
        skipped.push(title)
      }
    }
    staleCache.at = 0
    if (done.length) {
      await actions.addSuggestion({
        key: `undo-archive:${done.join(',')}:${Date.now()}`, kind: 'undo', source: 'system',
        title: `收起了 ${done.length} 个会话`, body: '在侧栏的「已归档」里能找到；点撤销放回原处。',
        options: [{ label: '撤销', action: { type: 'unarchive', ids: done } }],
      })
    }
    return `收起了 ${done.length} 个会话${skipped.length ? `；${skipped.length} 个没收（可能正在跑）` : ''}`
  }
  /** @param {string[]} ids */
  async function unarchive(ids) {
    const registry = ctx.get?.('workspaceRegistry')
    if (!registry?.unarchiveSession) throw new Error('这个 DSH 不支持取消归档')
    for (const id of ids) await registry.unarchiveSession(id)
    restored = false // 下次打开总览时重新补回
    return `放回了 ${ids.length} 个会话`
  }
  /** 收纳候选每天算一次（要读会话记录，别太勤）。 */
  let staleCache = { at: 0, list: /** @type {{ id: string, title: string }[] | null} */ (null) }
  /** @param {number} t */
  async function staleSessions(t) {
    if (!watchOthers) return null
    if (t - staleCache.at < 86_400_000) return staleCache.list
    staleCache.at = t
    try {
      staleCache.list = await findStale({ query: ctx.get?.('sessionQuery'), registry: ctx.get?.('workspaceRegistry'), now: t, isDot: id => hub.isDotSession(id) })
    } catch (error) {
      trace(`findStale failed: ${error instanceof Error ? error.message : String(error)}`)
      staleCache.list = null
    }
    return staleCache.list
  }

  // ── 巡检与建议收件箱 ───────────────────────────────────────
  let lastPatrol = 0
  let lastPrune = 0
  /**
   * 最多一分钟巡检一次：生成新建议，收起不再成立的。
   * @param {{ title: string, status?: string }[]} scheduled
   */
  async function runPatrol(scheduled, force = false) {
    const t = Date.now()
    if (!force && t - lastPatrol < 60_000) return
    lastPatrol = t
    try {
      if (store.snapshot().paused) return // 暂停时不打扰
      if (t - lastPrune > 86_400_000) { lastPrune = t; await actions.pruneTasks(90) }
      const schedule = ctx.get?.('schedule')
      const others = hub.others().map(o => ({ ...o, error: detailView(o.id, t)?.error ?? '', context: o.status === 'running' ? contextOf(o.id) : null }))
      const stale = await staleSessions(t)
      const { drafts, isStale } = patrol(store.snapshot(), { now: new Date(t), schedules: schedule?.list ? scheduled : null, others, stale })
      await actions.expireSuggestions(isStale)
      let added = 0
      for (const d of drafts) if (await actions.addSuggestion(d)) added++
      trace(`patrol: ${drafts.length} 条候选，新增 ${added} 条`)
      if (added) hub.flash(added === 1 ? 'Dot 有一个建议' : `Dot 有 ${added} 个建议`, 'suggestion')
    } catch (error) {
      trace(`patrol failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const openSuggestions = () => store.snapshot().suggestions
    .filter(s => s.status === 'open')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(s => ({ ...s, options: s.options.map(o => ({ label: o.label, hint: describeAction(o.action) })) }))

  /**
   * 执行建议里的一个动作。
   * @param {{ type: string, [k: string]: any }} action
   * @returns {Promise<string>} 给用户看的一句话
   */
  async function runSuggestion(action) {
    const agent = pickDotAgent(ctx)
    const sessionId = sessionIdOf(agent)
    switch (action.type) {
      case 'daily_brief':
        return (await actions.scheduleDailyBrief(String(action.time), sessionId)).line
      case 'reschedule': {
        await actions.rescheduleTask(String(action.taskId), new Date(String(action.due)), sessionId)
        return '改好了，提醒也跟着改了'
      }
      case 'drop': {
        const { closed } = await actions.closeTasks([String(action.taskId)], 'dropped', sessionId)
        if (!closed.length) throw new Error('这件事已经不在清单里了')
        return `已放弃：${closed[0].title}`
      }
      case 'task': {
        const r = await actions.addTask({ title: String(action.title), notes: String(action.notes ?? ''), sessionId })
        return r.line
      }
      case 'remind': {
        const r = await actions.scheduleReminder({ text: String(action.text), at: new Date(String(action.at)), sessionId })
        if ('warning' in r) throw new Error(r.warning)
        return '提醒建好了'
      }
      case 'say':
        return deliverToDot(String(action.text))
      case 'complete': {
        const { closed } = await actions.closeTasks([String(action.taskId)], 'done', sessionId)
        if (!closed.length) throw new Error('这件事务已经关掉了')
        return `完成：${closed[0].title}`
      }
      case 'relay':
        return relay(String(action.sessionId), String(action.text), String(action.title ?? ''))
      case 'dispatch':
        return dispatch(String(action.title), String(action.brief), typeof action.cwd === 'string' ? action.cwd : undefined)
      case 'archive':
        return archive((Array.isArray(action.ids) ? action.ids : []).map(String))
      case 'unarchive':
        return unarchive((Array.isArray(action.ids) ? action.ids : []).map(String))
      default:
        throw new Error(`不认识的动作 ${action.type}`)
    }
  }

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-plugin-dot/suggestion',
    handler: async (/** @type {any} */ req, /** @type {any} */ res) => {
      if (!guard(req, res, true)) return
      try {
        const body = await readJson(req)
        const id = typeof body.id === 'string' ? body.id : ''
        await store.load()
        const s = store.snapshot().suggestions.find(x => x.id === id)
        if (!s || s.status !== 'open') return send(res, 200, { ok: false, text: '这条建议已经处理过了' })
        if (body.dismiss) {
          await actions.resolveSuggestion(id, 'dismissed', '你忽略了')
          return send(res, 200, { ok: true, text: '好，7 天内不再提这件事' })
        }
        const option = s.options[Number(body.option)]
        if (!option) return send(res, 400, { ok: false, text: '没有这个选项' })
        const line = await runSuggestion(option.action)
        await actions.resolveSuggestion(id, 'accepted', `${option.label}：${line}`)
        return send(res, 200, { ok: true, text: line })
      } catch (error) {
        return send(res, 200, { ok: false, text: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-plugin-dot/say',
    handler: async (/** @type {any} */ req, /** @type {any} */ res) => {
      if (!guard(req, res, true)) return
      try {
        const body = await readJson(req)
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) return send(res, 400, { ok: false, text: '说点什么吧' })
        const agent = pickDotAgent(ctx)
        const cmd = text.match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/)
        if (cmd) {
          const h = handlers[cmd[1]]
          if (!h) return send(res, 200, { ok: false, text: `没有 /${cmd[1]} 这个指令，试试 /dot` })
          const r = await h.run(cmd[2] ?? '', agent)
          return send(res, 200, { ok: r.kind === 'success', text: r.text })
        }
        if (!agent) return send(res, 200, { ok: false, text: '先在 DSH 里打开一个「Dot 总管」会话，我就能接活了。' })
        agent.followup(userMessage(text))
        return send(res, 200, { ok: true, text: '收到，Dot 在处理了。' })
      } catch (error) {
        return send(res, 500, { ok: false, text: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-plugin-dot/done',
    handler: async (/** @type {any} */ req, /** @type {any} */ res) => {
      if (!guard(req, res, true)) return
      try {
        const body = await readJson(req)
        const id = typeof body.id === 'string' ? body.id : ''
        const { closed } = await actions.closeTasks([id], 'done', sessionIdOf(pickDotAgent(ctx)))
        return send(res, 200, { ok: closed.length > 0, text: closed.length ? `✓ ${closed[0].title}` : `没找到 ${id}` })
      } catch (error) {
        return send(res, 500, { ok: false, text: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  // 事务的完整生命周期：完成 / 放弃 / 重开 / 删除
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-plugin-dot/task',
    handler: async (/** @type {any} */ req, /** @type {any} */ res) => {
      if (!guard(req, res, true)) return
      try {
        const body = await readJson(req)
        const id = typeof body.id === 'string' ? body.id : ''
        const sid = sessionIdOf(pickDotAgent(ctx))
        if (body.action === 'done' || body.action === 'drop') {
          const { closed } = await actions.closeTasks([id], body.action === 'done' ? 'done' : 'dropped', sid)
          if (!closed.length) return send(res, 404, { ok: false, text: `没找到 ${id}` })
          return send(res, 200, { ok: true, text: `${body.action === 'done' ? '✓ 完成' : '已放弃'}：${closed[0].title}` })
        }
        if (body.action === 'edit') {
          const t = await actions.editTask(id, { title: body.title, priority: body.priority })
          return send(res, 200, { ok: true, text: `已更新：${t.title}` })
        }
        if (body.action === 'reopen') {
          const t = await actions.reopenTask(id)
          return send(res, 200, { ok: true, text: `重新打开：${t.title}` })
        }
        if (body.action === 'delete') {
          const { removed } = await actions.deleteTasks([id], sid)
          if (!removed.length) return send(res, 404, { ok: false, text: `没找到 ${id}` })
          return send(res, 200, { ok: true, text: `已删除：${removed[0].title}` })
        }
        if (body.action === 'clear-completed') {
          await store.load()
          const ids = store.snapshot().tasks.filter(t => t.status === 'done' || t.status === 'dropped').map(t => t.id)
          const { removed } = await actions.deleteTasks(ids, sid)
          return send(res, 200, { ok: true, text: removed.length ? `清掉了 ${removed.length} 件已结束的事` : '没有可清的' })
        }
        return send(res, 400, { ok: false, text: '未知操作' })
      } catch (error) {
        return send(res, 500, { ok: false, text: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  // 从面板上移除已结束的行（子任务、其他会话），不影响会话本身
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-plugin-dot/dismiss',
    handler: async (/** @type {any} */ req, /** @type {any} */ res) => {
      if (!guard(req, res, true)) return
      try {
        const body = await readJson(req)
        if (body.all === 'others') {
          const n = hub.clearEndedOthers()
          return send(res, 200, { ok: true, text: n ? `清掉了 ${n} 个已结束的会话` : '没有可清的' })
        }
        const id = typeof body.id === 'string' ? body.id : ''
        if (!hub.dismiss(id)) return send(res, 200, { ok: false, text: '还在运行，或者已经不在了' })
        return send(res, 200, { ok: true, text: '已移除' })
      } catch (error) {
        return send(res, 500, { ok: false, text: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-plugin-dot/child',
    handler: async (/** @type {any} */ req, /** @type {any} */ res) => {
      if (!guard(req, res, true)) return
      try {
        const body = await readJson(req)
        const id = typeof body.id === 'string' ? body.id : ''
        const child = hub.child(id)
        if (!child) return send(res, 404, { ok: false, text: '找不到这个子任务' })
        const subagents = ctx.get?.('subagents')
        if (!subagents) return send(res, 200, { ok: false, text: '当前环境没有子代理服务' })
        if (body.action === 'stop') {
          complete(id, null)
          // DSH 要求用户中断带上子代理的直接父会话 id，否则以 UNAUTHORIZED 拒绝。
          const parentSessionId = hub.child(id)?.parentId
          if (!parentSessionId) return send(res, 200, { ok: false, text: `找不到 ${child.name} 的父会话，没法停止` })
          subagents.interrupt(id, { kind: 'user', parentSessionId })
          hub.childStopRequested(id)
          return send(res, 200, { ok: true, text: `已让 ${child.name} 停下` })
        }
        if (body.action === 'say') {
          const text = typeof body.text === 'string' ? body.text.trim() : ''
          if (!text) return send(res, 400, { ok: false, text: '说点什么吧' })
          complete(id, null)
          // sendMessage 只认 ctx.agents 里的活对象，并且要是它的祖先：优先直接父会话，其次根会话。
          const agents = ctx.get?.('agents')
          const c = hub.child(id)
          const sender = (c?.parentId && agents?.get?.(c.parentId)) || (c?.rootId && agents?.get?.(c.rootId)) || hub.rootRefOf(id) || pickDotAgent(ctx)
          if (!sender) return send(res, 200, { ok: false, text: '找不到它所属的 Dot 会话' })
          hub.childRelease(id)
          await subagents.sendMessage(sender, id, [{ type: 'text', text: `（用户补充）${text}` }], { signal: AbortSignal.timeout(15_000) })
          return send(res, 200, { ok: true, text: `已转告 ${child.name}` })
        }
        return send(res, 400, { ok: false, text: '未知操作' })
      } catch (error) {
        return send(res, 500, { ok: false, text: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-plugin-dot/session',
    handler: async (/** @type {any} */ req, /** @type {any} */ res) => {
      if (!guard(req, res, true)) return
      try {
        const body = await readJson(req)
        const id = typeof body.id === 'string' ? body.id : ''
        // 只能操作「其他会话」里登记过的会话；从侧栏点「盯着」时可能还没登记，先从会话记录补一次
        if (!hub.other(id) && body.action === 'watch') await restoreOthers(true)
        const o = hub.other(id)
        if (!o) return send(res, 404, { ok: false, text: '找不到这个会话' })
        if (body.action === 'watch' || body.action === 'unwatch') {
          hub.watch(id, body.action === 'watch')
          return send(res, 200, { ok: true, text: body.action === 'watch' ? `Dot 会盯着「${o.title}」，结束时告诉你` : '不再盯着了' })
        }
        if (body.action === 'task') {
          // 记为事务：Dot 的事务清单里多一条跟进项，关联这个会话（它跑完时 Dot 会问要不要标完成）
          const { line } = await actions.addTask({ title: `跟进「${o.title}」`, notes: `会话 ${id}`, linkedSession: id })
          return send(res, 200, { ok: true, text: line })
        }
        if (body.action === 'relay') {
          // 用户在总览里亲手写、亲手点发送：直接送出
          const text = typeof body.text === 'string' ? body.text.trim() : ''
          if (!text) return send(res, 400, { ok: false, text: '要转告的话是空的' })
          return send(res, 200, { ok: true, text: await relay(id, text.slice(0, 4000), o.title) })
        }
        if (body.action === 'archive') {
          if (o.status === 'running') return send(res, 200, { ok: false, text: `「${o.title}」正在跑，不能收起` })
          return send(res, 200, { ok: true, text: await archive([id]) + '，收件箱里可以撤销' })
        }
        if (body.action !== 'stop') return send(res, 400, { ok: false, text: '未知操作' })
        if (o.status !== 'running') return send(res, 200, { ok: false, text: `「${o.title}」已经停了` })
        const agent = ctx.get?.('agents')?.get?.(id) ?? o.ref
        if (typeof agent?.cancel !== 'function') return send(res, 200, { ok: false, text: '这个会话不支持从这里停止' })
        hub.otherResult(id, 'stopped')
        agent.cancel({ kind: 'user' })
        return send(res, 200, { ok: true, text: `已让「${o.title}」停下` })
      } catch (error) {
        return send(res, 500, { ok: false, text: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  // ── 会话总览：每个其他会话的工作详情 ──────────────────────
  let restored = false
  /** DSH 重启后内存里的记录没了：从会话记录里补回最近 24 小时的顶层会话（只读）。 */
  const restoreOthers = async (force = false) => {
    if ((restored && !force) || !watchOthers) return
    restored = true
    const query = ctx.get?.('sessionQuery')
    if (!query?.listSessions) return
    try {
      const dot = new Set(dotSessionIds())
      const since = Date.now() - 86_400_000
      const records = (await query.listSessions())
        .map((/** @type {any} */ r) => r?.header)
        .filter((/** @type {any} */ h) => h?.id && !h.parentSession && h.origin !== 'subagent' && h.agentPreset !== 'dot'
          && !dot.has(h.id) && typeof h.createdAt === 'number' && h.createdAt >= since)
        .slice(0, 20)
      /** @type {Map<string, string>} */
      const titles = new Map()
      try {
        const snaps = await query.readTitleSnapshots(records.map((/** @type {any} */ h) => h.id))
        snaps.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
          const title = s?.status === 'fulfilled' ? s.value?.title?.title : undefined
          if (typeof title === 'string') titles.set(records[i].id, title)
        })
      } catch { /* 标题读不到就用默认名 */ }
      for (const h of records) hub.restoreOther({ id: h.id, title: titles.get(h.id) ?? '', createdAt: h.createdAt })
    } catch (error) {
      trace(`restore failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 一个会话此刻的附加信息：后台任务、目标。都是尽力而为，拿不到就不显示。 @param {string} id */
  const liveExtras = id => {
    const agent = ctx.get?.('agents')?.get?.(id)
    /** @type {{ jobs: { label: string, status: string, progress?: string }[], goal: { objective: string, phase: string } | null }} */
    const out = { jobs: [], goal: null }
    try {
      const list = ctx.get?.('jobs')?.list?.(id) ?? []
      out.jobs = list.filter((/** @type {any} */ j) => j.owner === id && (j.status === 'running' || j.status === 'stopping'))
        .slice(0, 5).map((/** @type {any} */ j) => ({ label: String(j.label ?? j.kind), status: String(j.status), progress: j.progress }))
    } catch { /* 没有后台任务服务 */ }
    try {
      const g = agent ? ctx.get?.('goals')?.get?.(agent) : undefined
      if (g?.objective) out.goal = { objective: String(g.objective), phase: String(g.phase ?? '') }
    } catch { /* 没有目标服务 */ }
    return out
  }

  /**
   * 会话的上下文用量（已加载的会话才有）：用了多少 token、窗口多大。
   * @param {string} id
   * @returns {{ used: number, window: number | null } | null}
   */
  const contextOf = id => {
    try {
      const agent = ctx.get?.('agents')?.get?.(id)
      const p = agent ? ctx.get?.('tokenMeter')?.contextPressure?.(agent.session) : null
      if (!p || !(p.pressureTokens > 0)) return null
      return { used: Number(p.pressureTokens), window: typeof p.contextWindow === 'number' ? p.contextWindow : null }
    } catch {
      return null
    }
  }

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-plugin-dot/sessions',
    handler: async (/** @type {any} */ req, /** @type {any} */ res) => {
      if (!guard(req, res, false)) return
      await restoreOthers()
      const now = Date.now()
      const status = petStatus(store.snapshot(), new Date(now))
      const waiting = new Map(status.decisions.map(d => [typeof d.open === 'string' ? d.open : '', d]))
      const sessions = hub.others()
        .sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || b.lastActive - a.lastActive)
        .map(o => ({
          id: o.id, title: o.title, status: o.status, result: o.result, restored: Boolean(o.restored),
          watched: Boolean(o.watched), tool: o.tool, stepCount: o.steps,
          startedAt: o.startedAt, endedAt: o.endedAt, elapsedMs: (o.endedAt ?? now) - o.startedAt,
          stuck: o.status === 'running' && now - o.lastActive > 5 * 60_000,
          waiting: waiting.get(o.id) ?? null,
          ...detailView(o.id, now),
          ...(o.status === 'running' ? liveExtras(o.id) : { jobs: [], goal: null }),
          context: contextOf(o.id),
        }))
      send(res, 200, { watchOthers, sessions })
    },
  })

  // 会话总览的搜索框：搜所有会话（包括 24 小时以前、不在总览里的）
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-plugin-dot/sessions/search',
    handler: async (/** @type {any} */ req, /** @type {any} */ res) => {
      if (!guard(req, res, true)) return
      try {
        if (!watchOthers) return send(res, 200, { ok: false, text: '已关闭其他会话监控', hits: [] })
        const body = await readJson(req)
        const q = typeof body.query === 'string' ? body.query.trim().slice(0, 200) : ''
        if (!q) return send(res, 200, { ok: true, hits: [] })
        const hits = await searchUserSessions(ctx.get?.('sessionQuery'), q, Date.now(), id => hub.isDotSession(id))
        return send(res, 200, { ok: true, hits })
      } catch (error) {
        return send(res, 200, { ok: false, text: error instanceof Error ? error.message : String(error), hits: [] })
      }
    },
  })

  // Dot 对话里每一轮下面的小卡片：这一轮记下的事务、提出的建议
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-plugin-dot/turn',
    handler: async (/** @type {any} */ req, /** @type {any} */ res) => {
      if (!guard(req, res, true)) return
      try {
        const body = await readJson(req)
        await store.load()
        send(res, 200, turnEffects(store.snapshot(), String(body.sessionId ?? ''), Number(body.from), Number(body.to)))
      } catch (error) {
        send(res, 500, { ok: false, text: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  // 一次查多轮（打开长对话时，各轮的卡片合并成一个请求）
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-plugin-dot/turns',
    handler: async (/** @type {any} */ req, /** @type {any} */ res) => {
      if (!guard(req, res, true)) return
      try {
        const body = await readJson(req)
        await store.load()
        const s = store.snapshot()
        const ranges = Array.isArray(body.ranges) ? body.ranges.slice(0, 200) : []
        send(res, 200, { results: ranges.map((/** @type {any} */ r) => turnEffects(s, String(body.sessionId ?? ''), Number(r?.[0]), Number(r?.[1]))) })
      } catch (error) {
        send(res, 500, { ok: false, text: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  // Dot 窗口的「记忆」「规则」页
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-plugin-dot/data',
    handler: async (/** @type {any} */ req, /** @type {any} */ res) => {
      if (!guard(req, res, false)) return
      await store.load()
      const s = store.snapshot()
      send(res, 200, {
        memories: s.memories.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        rules: [
          ...BUILTIN_RULES.map(r => ({ ...r, source: 'builtin' })),
          ...config.rules.map(r => ({ ...r, source: 'config' })),
          ...s.rules.map(r => ({ ...r, source: 'chat' })),
        ],
        stats: hub.ruleStats(),
        routes: resolveRoutes(s.prefs),
        routeEvents: ROUTE_EVENTS,
        pet: s.prefs.pet ?? {},
        petColors: PET_COLORS,
      })
    },
  })

  // 规则「试一试」：不执行任何东西，只说这次调用会被怎么处理
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-plugin-dot/rules/try',
    handler: async (/** @type {any} */ req, /** @type {any} */ res) => {
      if (!guard(req, res, true)) return
      try {
        const body = await readJson(req)
        const tool = typeof body.tool === 'string' ? body.tool.trim() : ''
        if (!tool) return send(res, 400, { ok: false, text: '先填一个工具名，如 pwsh、send_email' })
        await store.load()
        const v = evaluate(tool, typeof body.args === 'string' ? body.args : '', [...config.rules, ...store.snapshot().rules])
        return send(res, 200, { ok: true, tool, ...v, text: explainVerdict(tool, v) })
      } catch (error) {
        return send(res, 500, { ok: false, text: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  // 通知路由开关
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-plugin-dot/prefs',
    handler: async (/** @type {any} */ req, /** @type {any} */ res) => {
      if (!guard(req, res, true)) return
      try {
        const body = await readJson(req)
        if (body.pet && typeof body.pet === 'object') {
          const look = checkPetLook(body.pet)
          await store.mutate(state => { state.prefs.pet = { ...state.prefs.pet, ...look } })
          return send(res, 200, { ok: true, text: '改好了', pet: store.snapshot().prefs.pet })
        }
        const event = String(body.event ?? '')
        const channel = String(body.channel ?? '')
        const e = checkRouteChange(event, channel)
        const on = Boolean(body.on)
        await store.mutate(state => {
          const routes = state.prefs.routes
          routes[event] ??= {}
          // 只存与默认不同的开关，默认值以后改了也能跟着走
          if (e.defaults[channel] === on) delete routes[event][channel]
          else routes[event][channel] = on
          if (!Object.keys(routes[event]).length) delete routes[event]
        })
        return send(res, 200, { ok: true, routes: resolveRoutes(store.snapshot().prefs) })
      } catch (error) {
        return send(res, 400, { ok: false, text: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-plugin-dot/notice',
    handler: async (/** @type {any} */ req, /** @type {any} */ res) => {
      if (!guard(req, res, true)) return
      try {
        const body = await readJson(req)
        const id = typeof body.id === 'string' ? body.id : ''
        const n = hub.notices().find(x => x.id === id)
        if (id !== 'all' && !n) return send(res, 200, { ok: false, text: '这条通知已经没了' })
        if (n && body.action === 'task') {
          // 交给你的事记成一件事务，免得忘了
          const { line } = await actions.addTask({ title: `亲自做：${n.text}`.slice(0, 80), notes: `来自 ${n.title} · 会话 ${n.sessionId}`, priority: 'high' })
          hub.ackNotice(id)
          return send(res, 200, { ok: true, text: line })
        }
        if (n && body.action === 'done') {
          // 你亲自做完了：告诉 Dot，让它接着把剩下的做完
          const text = await deliverToDot(`我已经亲自完成了这一步：${n.text}。请接着把剩下的工作做完，做完告诉我。`, n.sessionId || undefined)
          hub.ackNotice(id)
          return send(res, 200, { ok: true, text })
        }
        const ok = hub.ackNotice(id)
        return send(res, 200, { ok, text: ok ? '' : '这条通知已经没了' })
      } catch (error) {
        return send(res, 500, { ok: false, text: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-plugin-dot/schedule',
    handler: async (/** @type {any} */ req, /** @type {any} */ res) => {
      if (!guard(req, res, true)) return
      try {
        const body = await readJson(req)
        const id = typeof body.id === 'string' ? body.id : ''
        const schedule = ctx.get?.('schedule')
        const mine = (await actions.listSchedules(dotSessionIds())).some(x => x.id === id)
        if (!schedule || !mine) return send(res, 404, { ok: false, text: '找不到这个定时任务' })
        if (body.action === 'delete') {
          await actions.deleteSchedule(id, dotSessionIds())
          return send(res, 200, { ok: true, text: '已删除' })
        }
        await schedule.edit({ id, action: 'update', patch: { active: Boolean(body.active) } })
        return send(res, 200, { ok: true, text: body.active ? '已恢复' : '已暂停' })
      } catch (error) {
        return send(res, 500, { ok: false, text: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  if (!petEnabled) return
  /** @type {Buffer | null} */
  let bundle = null
  try {
    bundle = readFileSync(new URL('./client.js', import.meta.url))
  } catch {
    return // 前端脚本缺失：接口照常可用
  }
  const rev = createHash('sha1').update(bundle).digest('hex').slice(0, 12)
  const script = bundle
  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-plugin-dot/client.js',
    handler: async (/** @type {any} */ _req, /** @type {any} */ res) => {
      res.setHeader('content-type', 'text/javascript; charset=utf-8')
      res.setHeader('cache-control', 'no-cache')
      res.end(script)
    },
  })
  // 不依赖页面开着：启动几秒后补回最近的会话（简报要用），之后每分钟自己巡检一次
  const startTimers = () => {
    const boot = setTimeout(() => { restoreOthers().catch(() => {}) }, 3000)
    const tick = setInterval(() => {
      actions.listSchedules(dotSessionIds()).then(s => runPatrol(s)).catch(() => {})
    }, 60_000)
    boot.unref?.()
    tick.unref?.()
    return () => { clearTimeout(boot); clearInterval(tick); hub.onPersist(null) }
  }
  if (typeof ctx.effect === 'function') ctx.effect(startTimers)
  else startTimers()

  // 官方注入点：每次渲染页面时追加一个外部脚本行。
  ctx.on('webserver/index-inject', (/** @type {any[]} */ table) => {
    table.push({ kind: 'script-src', placement: 'body', src: `/dsh-plugin-dot/client.js?rev=${rev}` })
  })
}
