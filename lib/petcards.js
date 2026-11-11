// @ts-check
/**
 * 桌面精灵的「需要你」卡片：在 Host 端算好，精灵只负责画和执行。
 *
 * 和网页小精灵（client.js 的 buildCards / renderCard）同一套规则：
 * 等你确认 > 交给你 / 盯着的会话结束 > 逾期 / 快到期 > 建议汇总；按通知路由开关过滤。
 *
 * 每个按钮带一个 op，精灵按 op 执行：
 *   { post: '/task', body: {...} }   调 Dot 自己的写接口（和网页小精灵用的一样）
 *   { open: <会话目标> }             把 DSH 拉到前台并打开那个会话
 *   { nav: 'dot' | 'sessions' }     把 DSH 拉到前台并打开 Dot 窗口 / 会话总览
 * 一个按钮可以同时有 post 和 open（例：打开跑完的会话，并把通知标为已读）。
 */

export const SOON_MS = 30 * 60_000

/** @param {string} iso @param {number} now */
export function fmtDue(iso, now) {
  const d = new Date(iso)
  const today = new Date(now)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === today.toDateString()) return `今天 ${hm}`
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
  if (d.toDateString() === tomorrow.toDateString()) return `明天 ${hm}`
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/**
 * @typedef {{ post?: string, body?: any, open?: any, nav?: 'dot' | 'sessions' }} Op
 * @typedef {{ label: string, main?: boolean, op: Op }} Button
 * @typedef {{ key: string, kind: string, title: string, body: string, buttons: Button[] }} DeskCard
 */

/**
 * @param {any} s /status 的内容
 * @param {number} now
 * @returns {DeskCard[]}
 */
export function deskCards(s, now) {
  /** @type {(DeskCard & { event: string })[]} */
  const cards = []
  ;(s.decisions ?? []).forEach((/** @type {any} */ d, /** @type {number} */ i) => {
    const question = d.kind === 'question'
    cards.push({
      key: `d:${d.label}:${d.reason}:${i}`, kind: question ? 'question' : 'approval', event: 'decision',
      title: `${d.label}${question ? ' 在问你' : ' 需要你批准'}`, body: String(d.reason ?? ''),
      buttons: d.open ? [{ label: question ? '去回答' : '去处理', main: true, op: { open: d.open } }] : [],
    })
  })
  ;(s.notices ?? []).forEach((/** @type {any} */ n) => {
    const handoff = n.kind === 'handoff'
    /** @type {Button[]} */
    let buttons
    if (handoff) {
      buttons = [
        { label: '记为事务', main: true, op: { post: '/notice', body: { id: n.id, action: 'task' } } },
        { label: '我做完了', op: { post: '/notice', body: { id: n.id, action: 'done' } } },
        { label: '知道了', op: { post: '/notice', body: { id: n.id } } },
      ]
    } else {
      buttons = [
        ...(n.open ? [{ label: '打开', main: true, op: { open: n.open, post: '/notice', body: { id: n.id } } }] : []),
        { label: '知道了', op: { post: '/notice', body: { id: n.id } } },
      ]
    }
    cards.push({
      key: `n:${n.id}`, kind: n.kind, event: handoff ? 'handoff' : 'watched',
      title: handoff ? `${n.title} 把一件事交给你亲自做` : `「${n.title}」${n.kind === 'failed' ? '出错了' : '跑完了'}`,
      body: String(n.text ?? ''), buttons,
    })
  })
  for (const t of s.tasks ?? []) {
    if (!t.due) continue
    const left = new Date(t.due).getTime() - now
    const buttons = [
      { label: '完成', main: true, op: { post: '/task', body: { id: t.id, action: 'done' } } },
      { label: '推迟 30 分钟', op: { post: '/say', body: { text: `/due ${t.id} 30分钟后` } } },
    ]
    if (t.overdue || left <= 0) {
      cards.push({ key: `o:${t.id}:${t.due}`, kind: 'overdue', event: 'due', title: `「${t.title}」已逾期`, body: `截止 ${fmtDue(t.due, now)}`, buttons })
    } else if (left <= SOON_MS) {
      cards.push({ key: `s:${t.id}:${t.due}`, kind: 'soon', event: 'due', title: `「${t.title}」快到了`, body: `还有 ${Math.max(1, Math.round(left / 60_000))} 分钟`, buttons })
    }
  }
  const sugs = s.suggestions ?? []
  if (sugs.length) {
    cards.push({
      key: `g:${sugs.map((/** @type {any} */ g) => g.id).join(',')}`, kind: 'suggestions', event: 'suggestion',
      title: sugs.length === 1 ? 'Dot 有一个建议' : `Dot 有 ${sugs.length} 个建议`,
      body: `${sugs[0].title}${sugs.length > 1 ? ' 等' : ''}`,
      buttons: [{ label: '去看看', main: true, op: { nav: 'dot' } }],
    })
  }
  const routes = s.routes ?? {}
  return cards
    .filter(c => routes[c.event]?.card !== false)
    .map(({ event, ...c }) => c)
}

/** 面板顶部那一行：几件事在办、几个子任务在跑……（和网页小精灵一致） @param {any} s */
export function deskSummary(s) {
  const c = s.counts ?? {}
  /** @type {string[]} */
  const parts = []
  if (c.active) parts.push(`${c.active} 件事在办`)
  if (c.running) parts.push(`${c.running} 个子任务在跑`)
  if (c.others) parts.push(`${c.others} 个其他会话在跑`)
  return `${s.paused ? '已暂停 · ' : ''}${parts.join('，') || '一切安静'}${s.bubble && s.mood !== 'idle' ? ` — ${s.bubble}` : ''}`
}

/** 小精灵配色（和 client.js 的 PALETTE 一致）：高光、主色。 */
export const DESK_PALETTE = /** @type {Record<string, [string, string]>} */ ({
  blue: ['#8aa2ff', '#4d6bfe'],
  green: ['#7fe0a8', '#2fb36d'],
  orange: ['#ffc27a', '#ff8a3d'],
  purple: ['#c4a5ff', '#8a5cf6'],
  pink: ['#ffa8c8', '#f2558f'],
  gray: ['#c9ccd3', '#8a8f99'],
})

/**
 * 给桌面精灵的一整包：卡片、摘要、名字、颜色。
 * @param {any} s
 * @param {number} now
 */
export function deskView(s, now) {
  const look = s.pet ?? {}
  const color = typeof look.color === 'string' && DESK_PALETTE[look.color] ? look.color : 'blue'
  return {
    name: typeof look.name === 'string' && look.name.trim() ? look.name.trim() : 'Dot',
    color: DESK_PALETTE[color],
    summary: deskSummary(s),
    hint: s.hasDotSession ? '' : '提示：新建一个「Dot 总管」会话，Dot 就能接对话里的活',
    cards: deskCards(s, now),
  }
}
