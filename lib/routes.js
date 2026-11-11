// @ts-check
/**
 * 通知路由：什么事通知到哪里（小精灵气泡 / 通知卡 / 系统通知）。
 * 默认值写在这里，用户改过的存进 state.prefs.routes，只存与默认不同的开关。
 */

export const ROUTE_CHANNELS = /** @type {const} */ (['bubble', 'card', 'system'])

/**
 * locked：这些开关不能关（审批和提问必须能看到，否则 Dot 会一直卡着等你）。
 * channels：这类事支持哪些渠道（子任务、其他会话结束只有气泡，看详情去 Dot 窗口和会话总览）。
 * @type {readonly { event: string, label: string, defaults: Record<string, boolean>, locked?: string[], channels?: string[] }[]}
 */
export const ROUTE_EVENTS = Object.freeze([
  { event: 'decision', label: '审批、提问', defaults: { bubble: true, card: true, system: true }, locked: ['card'] },
  { event: 'handoff', label: 'Dot 把事交给你亲自做', defaults: { bubble: true, card: true, system: true }, locked: ['card'] },
  { event: 'watched', label: '被盯着的会话完成或出错', defaults: { bubble: true, card: true, system: true } },
  { event: 'due', label: '逾期、快到期', defaults: { bubble: true, card: true, system: false } },
  { event: 'child', label: '子任务完成或出错', defaults: { bubble: true, card: false, system: false }, channels: ['bubble'] },
  { event: 'other', label: '其他会话跑完（没盯着）', defaults: { bubble: true, card: false, system: false }, channels: ['bubble'] },
  { event: 'suggestion', label: 'Dot 有新建议', defaults: { bubble: true, card: false, system: false }, channels: ['bubble'] },
])

/**
 * @param {{ routes?: Record<string, Record<string, boolean>> } | undefined} prefs
 * @returns {Record<string, Record<string, boolean>>}
 */
export function resolveRoutes(prefs) {
  /** @type {Record<string, Record<string, boolean>>} */
  const out = {}
  for (const e of ROUTE_EVENTS) {
    out[e.event] = {}
    for (const ch of ROUTE_CHANNELS) {
      const saved = prefs?.routes?.[e.event]?.[ch]
      out[e.event][ch] = e.channels && !e.channels.includes(ch) ? false
        : e.locked?.includes(ch) ? true : typeof saved === 'boolean' ? saved : e.defaults[ch]
    }
  }
  return out
}

export const PET_COLORS = /** @type {const} */ (['blue', 'green', 'orange', 'purple', 'pink', 'gray'])

/**
 * 校验小精灵外观的修改，返回规范化后的值。
 * @param {{ name?: unknown, color?: unknown }} input
 */
export function checkPetLook(input) {
  /** @type {{ name?: string, color?: string }} */
  const out = {}
  if (input.name !== undefined) {
    const name = String(input.name).trim()
    if (!name) throw new Error('名字不能为空')
    if ([...name].length > 12) throw new Error('名字最多 12 个字')
    out.name = name
  }
  if (input.color !== undefined) {
    if (!PET_COLORS.includes(/** @type {any} */ (input.color))) throw new Error(`没有这个颜色：${input.color}`)
    out.color = String(input.color)
  }
  return out
}

/**
 * 校验一次开关修改；不合法时抛错。
 * @param {string} event @param {string} channel
 */
export function checkRouteChange(event, channel) {
  const e = ROUTE_EVENTS.find(x => x.event === event)
  if (!e) throw new Error(`未知事件 ${event}`)
  if (!ROUTE_CHANNELS.includes(/** @type {any} */ (channel))) throw new Error(`未知通知渠道 ${channel}`)
  if (e.channels && !e.channels.includes(channel)) throw new Error(`「${e.label}」只在小精灵气泡里提示`)
  if (e.locked?.includes(channel)) throw new Error(`「${e.label}」的通知卡不能关：不然你会看不到 Dot 在等你`)
  return e
}
