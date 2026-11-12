// @ts-check
/**
 * v0.8 会话管理：让 Dot 能「回忆、读档、转告、派活、收纳」用户的其他会话。
 *
 * 规矩（见 docs/DESIGN-v0.8.md）：
 *   - 读：只读，遵守 watchOthers；不读 Dot 自己的会话和子代理。
 *   - 转告、派活、归档：工具只生成一张建议卡，用户点了才由 Host 执行。
 */

import { isAbsolute } from 'node:path'
import { detailView, hub } from './hub.js'
import { titleIssues } from './todo.js'

const DAY = 86_400_000

/** @param {string} s @param {number} n */
function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** @param {number} ms */
function ago(ms) {
  if (ms < 60_000) return '刚刚'
  if (ms < 3600_000) return `${Math.round(ms / 60_000)} 分钟前`
  if (ms < DAY) return `${Math.round(ms / 3600_000)} 小时前`
  return `${Math.round(ms / DAY)} 天前`
}

/**
 * 一个其他会话的一行现状，给模型看。
 * @param {any} o hub 里的会话
 * @param {number} now
 */
export function sessionLine(o, now) {
  const d = detailView(o.id, now)
  const parts = [`[${o.id}] 「${o.title}」`]
  if (o.status === 'running') {
    parts.push(now - o.lastActive > 5 * 60_000 ? '运行中，但 5 分钟没动静' : '运行中')
    if (o.tool) parts.push(`正在：${o.tool}`)
  } else {
    const r = o.result === 'failed' ? '出错停下' : o.result === 'stopped' ? '被停止' : o.restored ? '已结束（重启前）' : '已结束'
    parts.push(`${r}${o.endedAt ? `，${ago(now - o.endedAt)}` : ''}`)
  }
  if (d.todoTotal) parts.push(`待办 ${d.todoDone}/${d.todoTotal}${d.current ? `（${clip(d.current, 30)}）` : ''}`)
  if (d.asking) parts.push('在等用户回答')
  if (d.files.length) parts.push(`改了 ${d.files.length} 个文件`)
  if (d.error) parts.push(`错误：${clip(d.error, 60)}`)
  if (o.watched) parts.push('Dot 盯着')
  return parts.join(' · ')
}

/**
 * 把一个会话的 user/message、assistant/message 文档整理成「一问一答」，取最后几轮。
 * @param {{ type: string, text: string, time: number }[]} docs 按 seq 升序
 * @param {number} turns
 */
export function turnsFromEvents(docs, turns) {
  /** @type {{ ask: string, reply: string, at: number }[]} */
  const out = []
  for (const d of docs) {
    const text = String(d.text ?? '').trim()
    if (!text) continue
    if (d.type === 'user/message') out.push({ ask: text, reply: '', at: d.time })
    else if (d.type === 'assistant/message') {
      if (!out.length) out.push({ ask: '', reply: '', at: d.time })
      out[out.length - 1].reply = text // 一轮里多条回复时，最后一条最能说明结果
    }
  }
  return out.slice(-turns).map(t => ({ ask: clip(t.ask, 200), reply: clip(t.reply, 500), at: t.at }))
}

/**
 * 能不能读、能不能转告这个会话：不是 Dot 自己，不是子代理。
 * @param {any} header 会话记录的 header（可能拿不到）
 * @param {string} id
 * @param {(id: string) => boolean} isDot
 */
export function isUserSession(header, id, isDot) {
  if (isDot(id) || hub.isChild(id)) return false
  if (header && (header.agentPreset === 'dot' || header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)) return false
  return true
}

/**
 * 找出可以收起来的旧会话：创建超过 days 天、这 days 天里没有新一轮对话、
 * 没在跑、没置顶、没归档、没被盯着、不是 Dot 也不是子代理。
 * @param {{ query: any, registry: any, now: number, isDot: (id: string) => boolean, days?: number, max?: number }} env
 * @returns {Promise<{ id: string, title: string }[]>}
 */
export async function findStale(env) {
  const { query, registry } = env
  if (!query?.listSessions || !query?.filterEvents || !registry?.archiveSession) return []
  const days = env.days ?? 3
  const cutoff = env.now - days * DAY
  const archived = new Set(registry.archivedSessionIds ?? [])
  const pinned = new Set(registry.pinnedSessionIds ?? [])
  const watched = new Set(hub.watchedIds())
  const candidates = (await query.listSessions())
    .map((/** @type {any} */ r) => r?.header)
    .filter((/** @type {any} */ h) => h?.id && !h.parentSession && typeof h.createdAt === 'number' && h.createdAt < cutoff
      && !archived.has(h.id) && !pinned.has(h.id) && !watched.has(h.id)
      && hub.other(h.id)?.status !== 'running' && isUserSession(h, h.id, env.isDot))
    .slice(0, 40)
  /** @type {string[]} */
  const stale = []
  for (const h of candidates) {
    if (stale.length >= (env.max ?? 10)) break
    try {
      const recent = await query.filterEvents(h.id, [{ kind: 'time', from: cutoff }, { kind: 'type', values: ['turn/start'] }])
      if (!recent.length) stale.push(h.id)
    } catch { /* 读不了的会话不碰 */ }
  }
  if (!stale.length) return []
  /** @type {Map<string, string>} */
  const titles = new Map()
  try {
    const snaps = await query.readTitleSnapshots(stale)
    snaps.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
      const t = s?.status === 'fulfilled' ? s.value?.title?.title : undefined
      if (typeof t === 'string') titles.set(stale[i], t)
    })
  } catch { /* 用默认名 */ }
  return stale.map(id => ({ id, title: titles.get(id) || hub.other(id)?.title || '（还没有标题）' }))
}

/**
 * 没有全文索引时的退路：最近 30 天、最多 40 个顶层会话里，逐个按字面找问答里提到关键词的那一句。
 * @param {any} query
 * @param {string} q
 * @param {number} now
 */
export async function scanSessions(query, q, now) {
  if (!query?.listSessions || !query?.filterEvents) return []
  const headers = (await query.listSessions())
    .map((/** @type {any} */ r) => r?.header)
    .filter((/** @type {any} */ h) => h?.id && !h.parentSession && h.origin !== 'subagent' && (h.createdAt ?? 0) >= now - 30 * DAY)
    .sort((/** @type {any} */ a, /** @type {any} */ b) => b.createdAt - a.createdAt)
    .slice(0, 40)
  const out = []
  for (const header of headers) {
    if (out.length >= 8) break
    try {
      const docs = await query.filterEvents(header.id, [{ kind: 'type', values: ['user/message', 'assistant/message'] }, { kind: 'text', text: q }])
      const d = docs.at(-1)
      if (!d) continue
      const text = String(d.text ?? '').replace(/\s+/g, ' ')
      const at = Math.max(0, text.toLowerCase().indexOf(q.toLowerCase()) - 60)
      out.push({ header, bestMatch: { snippet: text.slice(at, at + 160), time: d.time } })
    } catch { /* 读不了的跳过 */ }
  }
  return out
}

/**
 * 搜索用户自己的会话：优先全文索引，没开就逐个扫描。工具和会话总览共用。
 * @param {any} query sessionQuery
 * @param {string} q
 * @param {number} now
 * @param {(id: string) => boolean} isDot
 * @returns {Promise<{ id: string, title: string, snippet: string, time: number | null }[]>}
 */
export async function searchUserSessions(query, q, now, isDot) {
  if (!query?.searchSessions && !query?.filterEvents) throw new Error('这个 DSH 读不了会话记录')
  /** @type {any[]} */
  let items = []
  try {
    items = (await query.searchSessions({ query: q, limit: 12 }))?.items ?? []
  } catch {
    // 全文索引没开（openAt: never 等）：退回逐个会话做字面扫描
    items = await scanSessions(query, q, now)
  }
  const hits = items.filter((/** @type {any} */ h) => h?.header?.id && isUserSession(h.header, h.header.id, isDot)).slice(0, 8)
  /** @type {Map<string, string>} */
  const titles = new Map()
  if (hits.length) {
    try {
      const snaps = await query.readTitleSnapshots(hits.map((/** @type {any} */ h) => h.header.id))
      snaps.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
        const title = s?.status === 'fulfilled' ? s.value?.title?.title : undefined
        if (typeof title === 'string') titles.set(hits[i].header.id, title)
      })
    } catch { /* 默认名 */ }
  }
  return hits.map((/** @type {any} */ h) => ({
    id: h.header.id,
    title: titles.get(h.header.id) || hub.other(h.header.id)?.title || '（还没有标题）',
    snippet: clip(h.bestMatch?.snippet ?? '', 160),
    time: typeof h.bestMatch?.time === 'number' ? h.bestMatch.time : null,
  }))
}

/**
 * dot_sessions 工具。
 * @param {{
 *   actions: ReturnType<typeof import('./actions.js').createActions> | undefined,
 *   getQuery: () => any,
 *   now?: () => Date,
 * }} env
 */
export function createSessionsTool(env) {
  const now = env.now ?? (() => new Date())
  const isDot = (/** @type {string} */ id) => hub.isDotSession(id)

  /** 标题和 header：先看 hub，再查会话记录。 @param {string} id */
  async function lookup(id) {
    const o = hub.other(id)
    const query = env.getQuery()
    /** @type {any} */
    let header = null
    let title = o?.title ?? ''
    if (query?.filterSessions) {
      try {
        const [rec] = await query.filterSessions([{ kind: 'id', values: [id] }])
        header = rec?.header ?? null
      } catch { /* 拿不到就只看 hub */ }
      if (!title && header) {
        try {
          const [s] = await query.readTitleSnapshots([id])
          title = s?.status === 'fulfilled' ? (s.value?.title?.title ?? '') : ''
        } catch { /* 默认名 */ }
      }
    }
    if (!o && !header) return null
    return { id, title: title || '（还没有标题）', header }
  }

  /** @param {string} id */
  async function requireUserSession(id) {
    if (!hub.watchOthersEnabled()) throw new Error('用户关掉了「监控其他会话」（watchOthers），Dot 不读也不碰其他会话')
    const s = await lookup(id)
    if (!s) throw new Error(`找不到会话 ${id}。先用 action=list 或 search 找到它的 id`)
    if (!isUserSession(s.header, id, isDot)) throw new Error('这是 Dot 自己的会话或子代理，不能这样操作')
    return s
  }

  return {
    name: 'dot_sessions',
    description:
      '管理用户的其他 DSH 会话（不是 Dot 自己，也不是你派的子任务）。'
      + 'list：各会话一行现状；search：全文搜索所有会话（「上周改登录页那个会话」）；read：读某个会话最近几轮问答，用来汇总进展或写交接说明。'
      + 'relay：起草一句要转告给某个会话的话；dispatch：起草一个新会话的任务说明（新开会话去干一件独立的大活，Dot 会自动盯着）；archive：提议把一些旧会话收起来。'
      + 'rename：给名字不清楚的会话起新名字（list 里标了「名字待整理」的，先 read 看清在做什么，名字要一眼能认出：做什么 + 对象，十来个字，不带「会话」「帮我」这类空话）。'
      + 'relay、dispatch、archive、rename 都只是放一张卡到用户的建议收件箱，用户点了才执行，所以调用后要告诉用户「去 Dot 窗口点一下」。'
      + '小活用子任务（subagent）就够了；dispatch 用于要跑很久、用户想单独打开看的活。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'search', 'read', 'relay', 'dispatch', 'archive', 'rename'], description: '操作' },
        renames: {
          type: 'array', maxItems: 20, description: 'rename：要改名的会话和新名字',
          items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'title'] },
        },
        query: { type: 'string', description: 'search：关键词' },
        id: { type: 'string', description: 'read / relay：会话 id' },
        ids: { type: 'array', items: { type: 'string' }, description: 'archive：要收起的会话 id' },
        turns: { type: 'integer', minimum: 1, maximum: 6, description: 'read：读最近几轮，默认 3' },
        text: { type: 'string', description: 'relay：要转告的话，以用户口吻写给那个会话' },
        title: { type: 'string', description: 'dispatch：任务名，十来个字' },
        brief: { type: 'string', description: 'dispatch：交给新会话的完整任务说明：目标、背景、约束、做完的标准' },
        cwd: { type: 'string', description: 'dispatch：可选，新会话的工作目录（绝对路径）' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
      render: (/** @type {any} */ _a, /** @type {any} */ v) => [{ type: 'text', text: String(v?.summary ?? '') }],
    },
    /** @param {any} args */
    async execute(args) {
      const t = now().getTime()
      switch (args.action) {
        case 'list': {
          if (!hub.watchOthersEnabled()) return { summary: '用户关掉了「监控其他会话」，Dot 看不到其他会话。' }
          const list = hub.others().filter(o => isUserSession(null, o.id, isDot))
            .sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || b.lastActive - a.lastActive)
          if (!list.length) return { summary: '最近 24 小时没有其他会话。要找更早的会话，用 action=search。' }
          const issues = titleIssues(list)
          return { summary: list.slice(0, 20).map(o => sessionLine(o, t) + (issues.has(o.id) ? ` · 名字待整理（${issues.get(o.id)}）` : '')).join('\n') }
        }
        case 'search': {
          if (!hub.watchOthersEnabled()) throw new Error('用户关掉了「监控其他会话」，Dot 不搜其他会话')
          const q = String(args.query ?? '').trim()
          if (!q) throw new Error('search 需要 query')
          const hits = await searchUserSessions(env.getQuery(), q, t, isDot)
          if (!hits.length) return { summary: `没有会话提到「${q}」。` }
          return {
            summary: hits.map(h => `[${h.id}] 「${h.title}」${h.time ? `（${ago(t - h.time)}）` : ''}：…${h.snippet}…`).join('\n') + '\n要看细节用 action=read。',
          }
        }
        case 'read': {
          const s = await requireUserSession(String(args.id ?? ''))
          const query = env.getQuery()
          if (!query?.filterEvents) throw new Error('这个 DSH 读不了会话记录')
          const docs = await query.filterEvents(s.id, [{ kind: 'type', values: ['user/message', 'assistant/message'] }])
          const turns = turnsFromEvents(docs, Math.min(6, Math.max(1, Number(args.turns) || 3)))
          const o = hub.other(s.id)
          const head = o ? sessionLine(o, t) : `[${s.id}] 「${s.title}」`
          if (!turns.length) return { summary: `${head}\n（还没有对话）` }
          return {
            summary: [head, ...turns.map((x, i) => `第 ${i + 1} 轮（${ago(t - x.at)}）\n  用户：${x.ask || '（无）'}\n  回复：${x.reply || '（还没回复）'}`)].join('\n'),
          }
        }
        case 'relay': {
          if (!env.actions) throw new Error('当前环境不支持建议收件箱')
          const s = await requireUserSession(String(args.id ?? ''))
          const text = String(args.text ?? '').trim()
          if (!text) throw new Error('relay 需要 text')
          const card = await env.actions.addSuggestion({
            key: `relay:${s.id}:${text.slice(0, 60)}`, kind: 'relay', source: 'dot',
            title: `转告「${clip(s.title, 30)}」`, body: clip(text, 200),
            options: [{ label: '发送', action: { type: 'relay', sessionId: s.id, title: s.title, text: text.slice(0, 4000) } }],
          })
          return { summary: card ? `已起草，等用户在 Dot 窗口点「发送」（${card.id}）。还没有发出去。` : '同样的转告已经在收件箱里了。' }
        }
        case 'dispatch': {
          if (!env.actions) throw new Error('当前环境不支持建议收件箱')
          const title = String(args.title ?? '').trim().slice(0, 40)
          const brief = String(args.brief ?? '').trim()
          if (!title || !brief) throw new Error('dispatch 需要 title 和 brief')
          const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined
          if (cwd && !isAbsolute(cwd)) throw new Error('cwd 必须是绝对路径')
          const card = await env.actions.addSuggestion({
            key: `dispatch:${title}`, kind: 'dispatch', source: 'dot',
            title: `开一个新会话去做「${title}」`, body: clip(`${cwd ? `目录：${cwd}。` : ''}${brief}`, 200),
            options: [{ label: '开始', action: { type: 'dispatch', title, brief: brief.slice(0, 8000), ...(cwd ? { cwd } : {}) } }],
          })
          return { summary: card ? `已起草，等用户在 Dot 窗口点「开始」（${card.id}）。点了之后会新开会话、Dot 自动盯着、并记一件「已委派」事务。` : '同名的派活已经在收件箱里了。' }
        }
        case 'archive': {
          if (!env.actions) throw new Error('当前环境不支持建议收件箱')
          const ids = [...new Set((Array.isArray(args.ids) ? args.ids : []).map(String))].slice(0, 20)
          if (!ids.length) throw new Error('archive 需要 ids')
          const list = []
          for (const id of ids) list.push(await requireUserSession(id))
          const running = list.filter(s => hub.other(s.id)?.status === 'running')
          if (running.length) throw new Error(`「${running[0].title}」正在跑，不能收起`)
          const card = await env.actions.addSuggestion({
            key: `archive:${ids.join(',')}`, kind: 'tidy', source: 'dot',
            title: `把 ${list.length} 个会话收起来？`, body: clip(list.map(s => `「${s.title}」`).join('、'), 200),
            options: [{ label: '收起来', action: { type: 'archive', ids, titles: list.map(s => s.title) } }],
          })
          return { summary: card ? '已起草，等用户在 Dot 窗口点「收起来」。收起后随时能撤销。' : '同样的提议已经在收件箱里了。' }
        }
        case 'rename': {
          if (!env.actions) throw new Error('当前环境不支持建议收件箱')
          const raw = Array.isArray(args.renames) ? args.renames : []
          /** @type {{ sessionId: string, title: string, old: string }[]} */
          const items = []
          for (const r of raw.slice(0, 20)) {
            const title = String(r?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
            if (!title) continue
            const s = await requireUserSession(String(r?.id ?? ''))
            if (s.title === title) continue
            items.push({ sessionId: s.id, title, old: s.title })
          }
          if (!items.length) throw new Error('rename 需要 renames：[{ id, title }]，而且新名字要和原来不一样')
          const one = items.length === 1
          const card = await env.actions.addSuggestion({
            key: `rename:${items.map(x => `${x.sessionId}=${x.title}`).join(',')}`, kind: 'rename', source: 'dot',
            title: one ? `把「${clip(items[0].old, 20)}」改名为「${items[0].title}」？` : `给 ${items.length} 个会话改名？`,
            body: one ? '改的是 DSH 侧栏里的会话名，随时能再改。' : clip(items.map(x => `「${clip(x.old, 14)}」→「${x.title}」`).join('；'), 300),
            options: [{ label: one ? '改名' : '全部改名', action: { type: 'rename', items: items.map(({ sessionId, title }) => ({ sessionId, title })) } }],
          })
          return { summary: card ? `已起草 ${items.length} 个改名，等用户在 Dot 窗口点「${one ? '改名' : '全部改名'}」。还没有改。` : '同样的改名提议已经在收件箱里了。' }
        }
        default:
          throw new Error(`未知操作 ${args.action}`)
      }
    },
  }
}
