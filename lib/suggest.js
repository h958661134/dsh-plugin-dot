// @ts-check
/**
 * 巡检：只读地看一遍事务和会话，产出「建议」，放进 Dot 窗口「今天」页的建议收件箱。
 *
 * 全部在本地按规则判断，不调用模型、不花 token、不改任何东西；
 * 建议要你点「采纳」才会执行。同一件事处理过（采纳或忽略）7 天内不再提。
 */

import { parseWhen } from './when.js'
import { titleIssues } from './todo.js'

/** @typedef {import('./store.js').DotState} DotState */
/** @typedef {import('./store.js').Suggestion} Suggestion */
/** @typedef {Omit<Suggestion, 'id' | 'status' | 'createdAt' | 'resolvedAt'>} SuggestionDraft */

const DAY = 86_400_000

/**
 * @param {DotState} state
 * @param {{
 *   now: Date,
 *   schedules: { title: string, status?: string }[] | null,
 *   others: { id: string, title: string, titleTemp?: boolean, status: string, result: string | null, watched?: boolean, endedAt?: number | null, error?: string, restored?: boolean, context?: { used: number, window: number | null } | null }[],
 *   stale?: { id: string, title: string }[] | null,
 * }} env schedules 为 null 表示拿不到定时任务列表（不提每日简报）；stale 为 null 表示今天没算收纳候选
 * @returns {{ drafts: SuggestionDraft[], isStale: (s: Suggestion) => boolean }}
 */
export function patrol(state, env) {
  const t = env.now.getTime()
  /** @type {SuggestionDraft[]} */
  const drafts = []
  const tomorrow9 = parseWhen('明天9点', env.now)?.at ?? new Date(t + DAY)
  const hasBrief = (env.schedules ?? []).some(s => /简报/.test(s.title))

  // 1. 还没有每日简报（已经有事务在跟，才值得每天汇报）
  const active = state.tasks.filter(x => x.status === 'open' || x.status === 'waiting')
  if (env.schedules && !hasBrief && active.length >= 1) {
    drafts.push({
      key: 'daily-brief', kind: 'brief', source: 'patrol',
      title: '每天早上给你发一份简报？',
      body: `你有 ${active.length} 件事在跟。简报会汇总今天要办、已逾期的事，以及昨天各会话做了什么。`,
      options: [
        { label: '每天 9 点', action: { type: 'daily_brief', time: '09:00' } },
        { label: '每天 8 点半', action: { type: 'daily_brief', time: '08:30' } },
      ],
    })
  }

  // 2. 逾期超过一天
  for (const task of active) {
    if (!task.due) continue
    const late = t - new Date(task.due).getTime()
    if (late < DAY) continue
    drafts.push({
      key: `overdue:${task.id}:${task.due}`, kind: 'overdue', source: 'patrol',
      title: `「${task.title}」已经逾期 ${Math.floor(late / DAY)} 天`,
      body: '还要做的话改个时间，不做了就放弃，清单会清爽些。',
      options: [
        { label: '改到明天 9 点', action: { type: 'reschedule', taskId: task.id, due: tomorrow9.toISOString() } },
        { label: '放弃', action: { type: 'drop', taskId: task.id } },
      ],
    })
  }

  // 3. 在等别人，三天没动静
  for (const task of active) {
    if (task.status !== 'waiting') continue
    const idle = t - new Date(task.updatedAt).getTime()
    if (idle < 3 * DAY) continue
    drafts.push({
      key: `waiting:${task.id}:${task.updatedAt}`, kind: 'waiting', source: 'patrol',
      title: `「${task.title}」等了 ${Math.floor(idle / DAY)} 天`,
      body: '要不要催一下？',
      options: [
        { label: '明早提醒我催', action: { type: 'remind', text: `催一下：${task.title}`, at: tomorrow9.toISOString() } },
        { label: '让 Dot 起草催办', action: { type: 'say', text: `帮我起草一条催办「${task.title}」的消息，先给我看，不要发送。` } },
      ],
    })
  }

  // 4. 其他会话出错停下（没盯着的；盯着的已经有通知了）
  for (const o of env.others) {
    if (o.status !== 'idle' || o.result !== 'failed' || o.watched) continue
    if (!o.endedAt || t - o.endedAt > DAY) continue
    const err = (o.error || '').slice(0, 120)
    drafts.push({
      key: `failed:${o.id}:${o.endedAt}`, kind: 'failed', source: 'patrol',
      title: `「${o.title}」出错停下了`,
      body: err || '会话出错停下了，还没人处理。',
      options: [
        { label: '记为事务', action: { type: 'task', title: `跟进：${o.title}`, notes: err } },
        { label: '让 Dot 看看', action: { type: 'say', text: `会话「${o.title}」出错停下了${err ? `：${err}` : ''}。帮我分析可能的原因和下一步。` } },
      ],
    })
  }

  // 5. 关联了会话的事务：那个会话跑完了，问要不要标完成
  for (const task of active) {
    if (!task.linkedSession) continue
    const o = env.others.find(x => x.id === task.linkedSession)
    if (!o || o.status !== 'idle' || o.result !== 'done' || !o.endedAt || o.restored) continue
    if (o.endedAt < new Date(task.updatedAt).getTime()) continue
    drafts.push({
      key: `linked:${task.id}:${o.endedAt}`, kind: 'linked', source: 'patrol',
      title: `「${o.title}」跑完了，「${task.title}」算完成吗？`,
      body: '这件事务关联着那个会话。',
      options: [
        { label: '标为完成', action: { type: 'complete', taskId: task.id } },
        { label: '让 Dot 看看结果', action: { type: 'say', text: `读一下会话「${o.title}」（${o.id}）最近几轮，告诉我事务「${task.title}」做完了没有、还剩什么。` } },
      ],
    })
  }

  // 6. 正在跑的会话上下文快满了：提议写交接说明、开新会话接着做
  for (const o of env.others) {
    const c = o.context
    if (o.status !== 'running' || !c?.window || c.used / c.window < 0.85) continue
    drafts.push({
      key: `context:${o.id}`, kind: 'context', source: 'patrol',
      title: `「${o.title}」的上下文用了 ${Math.round((c.used / c.window) * 100)}%`,
      body: '快满时 DSH 会压缩历史，细节可能丢。可以让 Dot 读一遍、写好交接说明，再开个新会话接着做。',
      options: [
        { label: '写交接说明', action: { type: 'say', text: `读一下会话「${o.title}」（${o.id}）最近几轮，写一份交接说明（目标、已完成、进行中、下一步、注意事项），然后用 dot_sessions dispatch 起草一个新会话接着做。` } },
      ],
    })
  }

  // 7. 收纳：三天以上没动的旧会话凑满 3 个，提议收起来（候选由 Host 每天算一次）
  if (env.stale && env.stale.length >= 3) {
    const ids = env.stale.map(s => s.id)
    const day = env.now.toISOString().slice(0, 10)
    drafts.push({
      key: `tidy:${day}`, kind: 'tidy', source: 'patrol',
      title: `有 ${ids.length} 个会话三天多没动了，收起来？`,
      body: env.stale.slice(0, 6).map(s => `「${s.title}」`).join('、') + (ids.length > 6 ? ' 等' : '') + '。收起后侧栏清爽些，随时能撤销。',
      options: [{ label: '收起来', action: { type: 'archive', ids, titles: env.stale.map(s => s.title) } }],
    })
  }

  // 8. 名字不清楚的会话（没标题、临时标题、太笼统、重名）攒到 3 个：提议让 Dot 读一遍、起名字。
  //    巡检本身不调模型；你点了「让 Dot 起名」，Dot 才去读，起好的名字还要你再点一次才改。
  const named = env.others.filter(o => o.status !== 'running')
  const issues = titleIssues(named.map(o => ({ id: o.id, title: o.title, titleTemp: Boolean(o.titleTemp) })))
  if (issues.size >= 3) {
    const list = named.filter(o => issues.has(o.id)).slice(0, 12)
    const day = env.now.toISOString().slice(0, 10)
    drafts.push({
      key: `names:${day}`, kind: 'names', source: 'patrol',
      title: `有 ${issues.size} 个会话名字不清楚，让 Dot 起个名？`,
      body: list.slice(0, 5).map(o => `「${o.title}」（${issues.get(o.id)}）`).join('、') + (issues.size > 5 ? ' 等' : '') + '。Dot 会先看每个会话在做什么，起好名字后你再确认。',
      options: [{
        label: '让 Dot 起名',
        action: { type: 'say', text: `这几个会话的名字不清楚，帮我起个一眼能认出来的名字：\n${list.map(o => `[${o.id}]「${o.title}」（${issues.get(o.id)}）`).join('\n')}\n先用 dot_sessions read 看看每个在做什么，再用 dot_sessions rename 一次性提出来，我确认后再改。` },
      }],
    })
  }

  const live = new Set(drafts.map(d => d.key))
  /** 巡检产出的建议，情况变了（事务完成、改了时间、会话重跑）就自动收起。 */
  const isStale = (/** @type {Suggestion} */ s) =>
    s.source === 'patrol' && !live.has(s.key) && !(s.key === 'daily-brief' && env.schedules === null)
    && !(s.key.startsWith('tidy:') && !env.stale)
  return { drafts, isStale }
}

/**
 * 一句话说清采纳后会发生什么（界面上的小字）。
 * @param {{ type: string, [k: string]: unknown }} action
 */
export function describeAction(action) {
  switch (action.type) {
    case 'daily_brief': return `建一个每天 ${action.time} 的简报`
    case 'reschedule': return '改截止时间，提醒跟着改'
    case 'drop': return '把事务标为放弃'
    case 'task': return `记一件事务：${action.title}`
    case 'remind': return '建一个提醒'
    case 'say': return '把这句话交给 Dot 去做'
    case 'complete': return '把事务标为完成'
    case 'relay': return `送进「${action.title || '那个会话'}」，带「Dot 代你转告」`
    case 'dispatch': return `新开一个会话${action.cwd ? `（${action.cwd}）` : ''}去做，Dot 盯着并记一件已委派事务`
    case 'archive': return `归档 ${Array.isArray(action.ids) ? action.ids.length : 0} 个会话，能撤销`
    case 'unarchive': return '把刚收起的会话放回侧栏'
    case 'rename': return action.undo ? '把名字改回去' : `改 ${Array.isArray(action.items) ? action.items.length : 0} 个会话的名字，能撤销`
    default: return ''
  }
}
