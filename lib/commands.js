// @ts-check
/**
 * Dot 的快捷指令（dsh-plugin-dot/commands）。挂在 Dot 预设里，只在 Dot 会话中可用；
 * 全部在本地执行，不经过模型、不消耗 token。
 *
 *   /dot                 能力卡 + 当前状态
 *   /task <时间?> <内容> [!高|!低] [@dot|@委派]
 *   /tasks               进行中的事务
 *   /done <id…>          标记完成
 *   /remind <时间> <内容>
 *   /every <周期> <内容>  周期提醒
 *   /note <内容>         记住一件事
 *   /brief [ai]          简报；加 ai 交给模型写成口语汇报
 *   /rules               查看规则
 */

import { join } from 'node:path'
import { getStore } from './store.js'
import { resolveConfig } from './index.js'
import { createActions, sessionIdOf, userMessage } from './actions.js'
import { parseWhen } from './when.js'
import { parseRepeat } from './repeat.js'
import { computeBrief, describeMemory, describeTask, formatTime } from './tools.js'
import { hub, toolLabel } from './hub.js'
import { BUILTIN_RULES } from './rules.js'

export const name = 'dsh-dot-commands'
export const inject = ['commands']

export const CAPABILITY_CARD = [
  'Dot 能帮你做这些事（随口说，或用快捷指令）：',
  '',
  '· 记事务　「周五前把报价单发给老王」　/task 周五 发报价单给老王 !高',
  '· 提醒　　「明早9点提醒我开会」　　　/remind 明早9点 开会',
  '· 周期提醒「工作日晚上6点提醒我写日报」　/every 工作日18点 写日报',
  '· 记住我　「我不吃辣，周末不看工作」　/note 我不吃辣',
  '· 简报　　「今天有什么事？」　　　　　/brief',
  '· 代办　　「帮我对比三款降噪耳机」　　（直接说，Dot 会拆解并派给子代理）',
  '· 规矩　　「以后上网前先问我」　　　　/rules',
  '',
  '管事务：/tasks 清单和子任务 · /done t3 完成 · /due t3 周五 改时间 · /drop t3 放弃 · /reopen t3 重开 · /del t3 删除',
  '管记忆和规则：/memories 看记忆 · /forget m3 忘掉 · /rules 看规则 · /rules del r2 删规则',
  '其他：/brief ai 让 Dot 口头汇报 · /pause 暂停 · /resume 恢复',
].join('\n')

/**
 * 解析 /task 的修饰符。
 * @param {string} text
 */
export function parseTaskInput(text) {
  /** @type {'high' | 'normal' | 'low'} */
  let priority = 'normal'
  /** @type {'user' | 'dot' | 'delegated'} */
  let owner = 'user'
  let rest = text
    .replace(/[!！](高|急|重要|high)/gi, () => { priority = 'high'; return ' ' })
    .replace(/[!！](低|low)/gi, () => { priority = 'low'; return ' ' })
    .replace(/[@＠](dot|Dot|DOT)/g, () => { owner = 'dot'; return ' ' })
    .replace(/[@＠](委派|delegated)/g, () => { owner = 'delegated'; return ' ' })
  return { rest: rest.replace(/\s+/g, ' ').trim(), priority, owner }
}

/** "t3, T5 t7" → ['t3', 't5', 't7'] @param {string} input */
function parseIds(input) {
  return input.split(/[\s,，、]+/).filter(Boolean).map(x => x.toLowerCase())
}

const CHILD_STATE = { starting: '启动中', running: '运行中', idle: '待命', done: '✓ 完成', failed: '✗ 出错', stopped: '已停止' }

/**
 * 去掉时间词留下的连接词：“周五前 交周报” → “交周报”，“提醒我开会” → “开会”。
 * @param {string} text
 */
export function cleanTitle(text) {
  return text.replace(/^[\s,，、]*(?:之前|以前|前|之内|内)?[\s,，、]*(?:提醒我|叫我|记得)?[\s,，、:：]*/, '').trim()
}

/**
 * 指令实现与注册分开，便于测试。
 * @param {{ actions: ReturnType<typeof createActions>, store: import('./store.js').DotStore, configRules: import('./store.js').Rule[], timeZone?: string, now?: () => Date, dotSessionIds?: () => string[] }} deps
 */
export function createCommandHandlers(deps) {
  const { actions, store, configRules, timeZone } = deps
  const dotSessionIds = deps.dotSessionIds ?? (() => hub.roots().map(r => r.id))
  const now = deps.now ?? (() => new Date())
  const ok = (/** @type {string} */ text) => ({ kind: /** @type {const} */ ('success'), text })
  const err = (/** @type {string} */ text) => ({ kind: /** @type {const} */ ('error'), text })

  /** @type {Record<string, { description: string, hint?: string, run: (input: string, agent: any) => Promise<{ kind: 'success' | 'error', text: string }> }>} */
  const handlers = {
    dot: {
      description: 'Dot 能做什么 + 当前状态',
      async run() {
        await store.load()
        const s = store.snapshot()
        const active = s.tasks.filter(t => t.status === 'open' || t.status === 'waiting').length
        const overdue = computeBrief(s, now(), 24).overdue.length
        const status = `\n\n当前：进行中 ${active} 件${overdue ? `（逾期 ${overdue}）` : ''} · 记忆 ${s.memories.length} 条 · 规则 ${s.rules.length + configRules.length} 条`
        return ok(CAPABILITY_CARD + status)
      },
    },

    task: {
      description: '记一件事；带时间会自动建提醒',
      hint: '<时间?> <内容> [!高] [@dot]',
      async run(input, agent) {
        const { rest, priority, owner } = parseTaskInput(input)
        if (!rest) return err('用法：/task 周五18点 交周报 !高')
        const when = parseWhen(rest, now())
        const title = cleanTitle(when ? when.rest : rest)
        if (!title) return err('只写了时间，没写要做什么。用法：/task 周五18点 交周报')
        const r = await actions.addTask({
          title, priority, owner, due: when ? when.at.toISOString() : null, sessionId: sessionIdOf(agent),
        })
        return ok(r.warning ? `${r.line}\n（${r.warning}）` : r.line)
      },
    },

    tasks: {
      description: '查看进行中的事务',
      async run() {
        await store.load()
        const list = store.snapshot().tasks.filter(t => t.status === 'open' || t.status === 'waiting')
        if (list.length === 0) return ok('清单是空的。用 /task 记一件事吧。')
        const kids = hub.children()
        return ok(list.map(t => [
          describeTask(t, now(), timeZone),
          ...kids.filter(c => c.taskId === t.id).map(c =>
            `    └ ${c.name} ${CHILD_STATE[c.status] ?? c.status}${c.tool ? ` · 正在${toolLabel(c.tool)}` : ''} · ${c.steps} 步`),
        ].join('\n')).join('\n'))
      },
    },

    done: {
      description: '标记事务完成',
      hint: '<id…>',
      async run(input, agent) {
        const ids = parseIds(input)
        if (ids.length === 0) return err('用法：/done t3 t5')
        const { closed, missing } = await actions.closeTasks(ids, 'done', sessionIdOf(agent))
        const lines = closed.map(t => `✓ ${t.id} ${t.title}`)
        if (missing.length) lines.push(`没找到：${missing.join(' ')}`)
        return closed.length ? ok(lines.join('\n')) : err(lines.join('\n'))
      },
    },

    drop: {
      description: '放弃事务（保留记录，可 /reopen）',
      hint: '<id…>',
      async run(input, agent) {
        const ids = parseIds(input)
        if (ids.length === 0) return err('用法：/drop t3')
        const { closed, missing } = await actions.closeTasks(ids, 'dropped', sessionIdOf(agent))
        const lines = closed.map(t => `✗ 已放弃 ${t.id} ${t.title}`)
        if (missing.length) lines.push(`没找到：${missing.join(' ')}`)
        return closed.length ? ok(lines.join('\n')) : err(lines.join('\n'))
      },
    },

    del: {
      description: '彻底删除事务（连同提醒，不可恢复）',
      hint: '<id…>',
      async run(input, agent) {
        const ids = parseIds(input)
        if (ids.length === 0) return err('用法：/del t3')
        const { removed, missing } = await actions.deleteTasks(ids, sessionIdOf(agent))
        const lines = removed.map(t => `已删除 ${t.id} ${t.title}`)
        if (missing.length) lines.push(`没找到：${missing.join(' ')}`)
        return removed.length ? ok(lines.join('\n')) : err(lines.join('\n'))
      },
    },

    due: {
      description: '改截止时间（提醒跟着改）；/due t3 无 取消截止时间',
      hint: '<id> <时间|无>',
      async run(input, agent) {
        const m = /^\s*(t\d+)\s+(.+)$/i.exec(input)
        if (!m) return err('用法：/due t3 周五18点（取消截止时间：/due t3 无）')
        const id = m[1].toLowerCase()
        const rest = m[2].trim()
        let due = null
        if (!/^(无|不要|取消|none|clear)$/i.test(rest)) {
          const when = parseWhen(rest, now())
          if (!when) return err(`没看懂「${rest}」，换个说法，比如「周五18点」「明早9点」「3天后」`)
          due = when.at
        }
        const r = await actions.rescheduleTask(id, due, sessionIdOf(agent))
        const line = `${due ? '改好了' : '已取消截止时间'}：${describeTask(r.task, now(), timeZone)}${r.task.reminderId ? '，到点提醒你' : ''}`
        return ok(r.warning ? `${line}\n（${r.warning}）` : line)
      },
    },

    reopen: {
      description: '把完成或放弃的事务重新打开',
      hint: '<id>',
      async run(input) {
        const id = parseIds(input)[0]
        if (!id) return err('用法：/reopen t3')
        const t = await actions.reopenTask(id)
        return ok(`重新打开 ${describeTask(t, now(), timeZone)}`)
      },
    },

    memories: {
      description: '查看 Dot 记得的事',
      async run() {
        await store.load()
        const list = store.snapshot().memories
        if (list.length === 0) return ok('还没记住任何事。用 /note 我不吃辣 告诉 Dot。')
        return ok([...list.map(m => describeMemory(m)), '', '删除用 /forget m3'].join('\n'))
      },
    },

    forget: {
      description: '让 Dot 忘掉一条记忆',
      hint: '<id…>',
      async run(input) {
        const ids = parseIds(input).filter(id => /^m\d+$/.test(id))
        if (ids.length === 0) return err('用法：/forget m3（先用 /memories 看编号）')
        const lines = []
        for (const id of ids) {
          try { lines.push(`已忘掉 ${id}：${(await actions.forgetMemory(id)).text}`) } catch (e) { lines.push(e instanceof Error ? e.message : String(e)) }
        }
        return ok(lines.join('\n'))
      },
    },

    remind: {
      description: '到点提醒我',
      hint: '<时间> <内容>',
      async run(input, agent) {
        const text = input.trim()
        if (!text) return err('用法：/remind 明早9点 开会')
        const when = parseWhen(text, now())
        const what = when ? cleanTitle(when.rest) : ''
        if (!when || !what) {
          // 看不懂时间就交给 Dot（模型）处理，而不是猜。
          if (!agent) return err('这句我没看懂时间。换个说法，比如「明早9点 开会」，或者在 Dot 会话里直接说。')
          agent.followup(userMessage(`提醒我：${text}`))
          return ok('这句我没看懂时间，已交给 Dot 处理。')
        }
        const r = await actions.scheduleReminder({ text: what, at: when.at, sessionId: sessionIdOf(agent) })
        if ('warning' in r) return err(r.warning)
        return ok(`好的，${formatTime(when.at.toISOString(), timeZone)} 提醒你：${what}`)
      },
    },

    every: {
      description: '周期提醒：每天、工作日、每周几、每隔多久',
      hint: '<周期> <内容>',
      async run(input, agent) {
        const text = input.trim()
        if (!text) return err('用法：/every 每天9点 喝水、/every 工作日18点 写日报、/every 每周一 10点 周会、/every 每30分钟 站起来')
        const r = parseRepeat(text, timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
        const what = r ? cleanTitle(r.rest) : ''
        if (!r || !what) {
          if (!agent) return err('这句我没看懂周期。换个说法，比如「每天9点 喝水」「工作日18点 写日报」。')
          agent.followup(userMessage(`周期提醒我：${text}`))
          return ok('这句我没看懂周期，已交给 Dot 处理。')
        }
        const made = await actions.scheduleRepeat({
          title: `${what}（${r.label}）`,
          prompt: `【Dot 周期提醒】${what}（${r.label}）。请用一句话提醒用户。`,
          timing: r.timing,
          sessionId: sessionIdOf(agent),
        })
        if ('warning' in made) return err(made.warning)
        return ok(`好的，${r.label} 提醒你：${what}。不想要了在排程里删掉。`)
      },
    },

    note: {
      description: '让 Dot 记住一件事',
      hint: '<内容>',
      async run(input) {
        if (!input.trim()) return err('用法：/note 我不吃辣')
        return ok(await actions.remember(input))
      },
    },

    brief: {
      description: '今日简报；/brief ai 让 Dot 口头汇报',
      hint: '[ai]',
      async run(input, agent) {
        if (/^\s*ai\s*$/i.test(input)) {
          if (!agent) return err('先在 DSH 里打开一个「Dot 总管」会话')
          agent.followup(userMessage('请调用 dot_brief，然后用三五句话向我汇报今天的重点，并说说你能替我做的事。'))
          return ok('Dot 正在整理简报…')
        }
        await store.load()
        const b = computeBrief(store.snapshot(), now(), 24)
        const sec = (/** @type {string} */ title, /** @type {any[]} */ list) =>
          list.length ? [`${title}（${list.length}）`, ...list.map(t => `  ${describeTask(t, now(), timeZone)}`)] : []
        const lines = [
          `${formatTime(now().toISOString(), timeZone)} · 进行中 ${b.active.length} 件`,
          ...sec('⚠ 已逾期', b.overdue),
          ...sec('⏰ 24 小时内', b.dueSoon),
          ...sec('★ 高优先级', b.highPriority),
          ...sec('… 等待中', b.waiting),
          ...sec('→ 已委派', b.delegated),
          ...sec('✓ 今天完成', b.doneRecently),
        ]
        if (b.active.length === 0) lines.push('没有待办，轻松的一天。')
        return ok(lines.join('\n'))
      },
    },

    pause: {
      description: '暂停 Dot：暂停它的定时任务，拒绝一切有副作用的操作',
      async run(_input, agent) {
        const ids = new Set(dotSessionIds())
        const own = agent?.id
        if (own) ids.add(own)
        const r = await actions.pause(ids)
        if (r.already) return ok('Dot 已经在暂停中。输入 /resume 恢复。')
        return ok(`Dot 已暂停${r.count ? `，同时暂停了 ${r.count} 个定时任务` : ''}。输入 /resume 恢复。`)
      },
    },

    resume: {
      description: '恢复 Dot',
      async run() {
        const r = await actions.resume()
        if (r.already) return ok('Dot 没有在暂停。')
        return ok(`Dot 回来了${r.count ? `，恢复了 ${r.count} 个定时任务` : ''}。`)
      },
    },

    rules: {
      description: '查看 Dot 的行为规则；/rules del r2 删除',
      hint: '[del <id>]',
      async run(input) {
        const m = /^\s*(?:del|rm|remove|删除?)\s+(\S+)/i.exec(input)
        if (m) {
          const r = await actions.removeRule(m[1].toLowerCase())
          return ok(`已删除规则 [${r.id}] ${r.tool} → ${r.decision}`)
        }
        await store.load()
        const rules = [...configRules, ...store.snapshot().rules]
        const line = (/** @type {any} */ r) => {
          const words = r.match ? r.match.split('|') : []
          const match = words.length ? `（参数含 ${words.slice(0, 4).join('、')}${words.length > 4 ? '…' : ''}）` : ''
          return `[${r.id}] ${r.tool}${match} → ${r.decision}${r.note ? `（${r.note}）` : ''}${r.until ? `（到 ${formatTime(r.until, timeZone)} 为止）` : ''}`
        }
        return ok([
          '内置安全规则（不能删）：', ...BUILTIN_RULES.map(line), '',
          rules.length ? '你的规则：' : '你还没有加规则。对 Dot 说「以后上网前先问我」就能加一条。', ...rules.map(line), '',
          '删除用 /rules del r2（c 开头的是配置文件里的固定规则，b 开头的是内置规则）',
        ].join('\n'))
      },
    },
  }
  return handlers
}

/**
 * @param {any} ctx
 * @param {unknown} rawConfig
 */
export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const store = getStore(join(config.dataDir, 'state.json'))
  await store.load()
  const actions = createActions({
    store, getSchedule: () => ctx.get('schedule'), timeZone: config.timeZone, maxMemories: config.maxMemories,
  })
  const handlers = createCommandHandlers({ actions, store, configRules: config.rules, timeZone: config.timeZone })
  for (const [cmd, h] of Object.entries(handlers)) {
    ctx.commands.register({
      name: cmd,
      description: h.description,
      ...(h.hint ? { input: { hint: h.hint } } : {}),
      handler: async (/** @type {any} */ invocation) => {
        try {
          return await h.run(invocation.rawInput ?? '', invocation.agent)
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    })
  }
}
