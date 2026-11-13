// @ts-check
/** 数据驱动的形象与小动作。两个客户端共享同一坐标契约，不加载脚本、XAML 或远程资源。 */
import { readFileSync } from 'node:fs'

export const RENDERER = 'dot-vector-v1'
const COLORS = ['blue', 'green', 'orange', 'purple', 'pink', 'gray']
const PAINT = /^(body|light|face|none|#[\da-fA-F]{6})$/
const PATH = /^[MmLlHhVvCcSsQqTtAaZz\d.,\s+\-]+$/
export const POSE = Object.freeze({ tilt: 0, lift: 0, sx: 1, sy: 1, lx: 0, ly: 0, la: 0, rx: 0, ry: 0, ra: 0 })
/** @param {any} input */
export function validateCatalog(input) {
  if (input?.version !== 1 || !Array.isArray(input.characters) || !Array.isArray(input.gestures)) throw new Error('精灵图鉴版本或结构不支持')
  const ids = new Set()
  const characters = input.characters.map((/** @type {any} */ c) => {
    if (!c || !/^[a-z][a-z0-9-]{0,39}$/.test(c.id) || ids.has(c.id) || c.renderer !== RENDERER || !COLORS.includes(c.color)
      || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 24 || typeof c.description !== 'string' || c.description.length > 120
      || !Number.isFinite(c.radius) || c.radius < 0 || c.radius > 28) throw new Error('精灵形象配置不合法')
    ids.add(c.id)
    const layer = (/** @type {any} */ paths) => {
      if (!Array.isArray(paths) || paths.length > 24) throw new Error('精灵图层不合法')
      return paths.map((/** @type {any} */ p) => {
        if (typeof p?.d !== 'string' || !p.d || p.d.length > 2000 || !PATH.test(p.d) || !PAINT.test(p.fill)
          || (p.stroke != null && !PAINT.test(p.stroke)) || (p.width != null && (!Number.isFinite(p.width) || p.width < 0 || p.width > 6))) throw new Error('精灵矢量路径不合法')
        return { d: p.d, fill: p.fill, ...(p.stroke ? { stroke: p.stroke, width: p.width ?? 1 } : {}) }
      })
    }
    return { id: c.id, name: c.name, description: c.description, renderer: RENDERER, color: c.color, radius: c.radius, ahoge: c.ahoge === true, back: layer(c.back), front: layer(c.front) }
  })
  if (!ids.has('dot')) throw new Error('图鉴必须保留默认小点')
  ids.clear()
  const gestures = input.gestures.map((/** @type {any} */ g) => {
    if (!g || !/^[a-z][a-z0-9-]{0,39}$/.test(g.id) || ids.has(g.id) || typeof g.name !== 'string' || g.name.length > 24
      || !Number.isFinite(g.duration) || g.duration < 500 || g.duration > 4000 || !['normal', 'happy', 'half', 'line', 'wink', 'dot'].includes(g.eyes)
      || !['w', 'o', 'smile', 'flat', 'open', 'wave'].includes(g.mouth) || !['heart', 'star', 'note', 'none'].includes(g.particle)
      || (g.revealAt != null && (!Number.isFinite(g.revealAt) || g.revealAt <= 0 || g.revealAt >= 1))
      || !Array.isArray(g.frames) || g.frames.length < 2 || g.frames.length > 20) throw new Error('精灵动作配置不合法')
    ids.add(g.id)
    let last = -1
    const frames = g.frames.map((/** @type {any} */ f) => {
      if (!Number.isFinite(f.at) || f.at <= last || f.at < 0 || f.at > 1) throw new Error('动作时间必须递增')
      last = f.at
      const out = { at: f.at, ...POSE }
      for (const k of Object.keys(POSE)) if (f[k] != null) {
        const scale = k === 'sx' || k === 'sy'
        if (!Number.isFinite(f[k]) || f[k] < (scale ? 0.7 : -60) || f[k] > (scale ? 1.3 : 60)) throw new Error('动作幅度不合法')
        out[k] = f[k]
      }
      return out
    })
    if (frames[0].at !== 0 || last !== 1 || Object.keys(POSE).some(k => frames[0][k] !== POSE[k] || frames.at(-1)[k] !== POSE[k])) throw new Error('动作必须从中立姿态开始并回到原位')
    return { id: g.id, name: g.name, duration: g.duration, eyes: g.eyes, mouth: g.mouth, cheeks: g.cheeks === true, particle: g.particle, revealAt: g.revealAt ?? null, frames }
  })
  return { version: 1, characters, gestures }
}

/** 损坏的扩展图鉴不应让总管起不来；保留最小的小点，并在 Host 日志说明原因。 @param {string} text @param {(message: string) => void} warn */
export function parseCatalog(text, warn = console.warn) {
  try { return validateCatalog(JSON.parse(text)) } catch (error) {
    warn(`Dot 精灵图鉴未加载，已回退小点：${error instanceof Error ? error.message : String(error)}`)
    return validateCatalog({ version: 1, characters: [{ id: 'dot', name: '小点', description: '陪你把事情安排好。', renderer: RENDERER, color: 'blue', radius: 17, ahoge: true, back: [], front: [] }], gestures: [] })
  }
}
export const PET_CATALOG = parseCatalog(readFileSync(new URL('./pets/catalog.json', import.meta.url), 'utf8'))
export const PET_CHARACTERS = PET_CATALOG.characters
/** 未知形象、移除的形象都退回小点；不改掉用户保存的 ID，装回来还能继续用。 @param {unknown} id */
export function characterOf(id) { return PET_CHARACTERS.find(c => c.id === id) ?? PET_CHARACTERS.find(c => c.id === 'dot') }
/** 共享的插值契约：smoothstep，整段持续时间由墙上时钟决定，不依赖帧率。 @param {any} gesture @param {number} progress */
export function poseAt(gesture, progress) {
  const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0
  const frames = gesture.frames
  let i = 1
  while (i < frames.length - 1 && p > frames[i].at) i++
  const a = frames[i - 1], b = frames[i]
  const t = Math.max(0, Math.min(1, (p - a.at) / (b.at - a.at))), ease = t * t * (3 - 2 * t)
  return Object.fromEntries(Object.keys(POSE).map(k => [k, a[k] + (b[k] - a[k]) * ease]))
}
