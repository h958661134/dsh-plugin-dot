// @ts-check
/**
 * Dot 的规则：内置硬规则 + 用户规则（配置文件里的、对话里加的）。
 *
 * - 工具名模式支持 `*` 通配，用 `|` 写多个（如 `web_*|pwsh`），大小写不敏感。
 * - `match`（可选）是用 `|` 分隔的关键词：调用参数里出现任意一个才算命中。
 * - `until`（可选）是到期时间，过期的规则不再生效。
 * - 五种结果：allow（放行）、preapproved（你事先同意过，不再问）、ask（先问你）、
 *   handoff（交给你亲自做，Dot 不碰）、block（禁止）。
 * - 合并顺序（{@link evaluate}）：
 *   用户 block > 用户 handoff > 内置 handoff（可被**带关键词**的用户 preapproved 覆盖）
 *   > 用户 ask > 内置 ask（可被用户 preapproved 抵消）> 用户 preapproved > 用户 allow。
 * - allow / preapproved 的含义是「Dot 不额外打扰你」，它们不会绕过 DSH 自身的权限预设。
 */

/** @typedef {import('./store.js').Rule} Rule */
/** @typedef {import('./store.js').RuleDecision} RuleDecision */
/** @typedef {Pick<Rule, 'id' | 'tool' | 'decision'> & { match?: string, note?: string, until?: string }} RuleLike */
/**
 * 内置规则多两个字段：skip 是它不看的工具；scope 决定拿参数的哪一部分去匹配关键词
 * （'all' 整个参数，'command' 只看命令行或代码本身）。
 * @typedef {RuleLike & { note: string, skip?: RegExp, scope?: 'all' | 'command' }} BuiltinRule
 */
/** @typedef {'builtin' | 'user'} RuleLayer */
/**
 * @typedef {{
 *   decision: RuleDecision | null,
 *   rule: RuleLike | null,
 *   layer: RuleLayer | null,
 *   hits: { id: string, layer: RuleLayer, decision: RuleDecision, tool: string }[],
 *   exempt: boolean,
 *   overrides?: string,
 * }} Verdict
 */

const STRICTNESS = { allow: 0, preapproved: 1, ask: 2, handoff: 3, block: 4 }

/** 写文件、改代码、跑命令、跑代码：内容里提到「付款」「password」不等于在付款、改密码。 */
const CONTENT_TOOLS = /^(write|edit|multi_edit|create_file|apply_patch|str_replace.*|notebook.*|pwsh|powershell|bash|sh|cmd|shell.*|exec.*|run_command.*|run_code|terminal.*)$/i
/** 名字里带这些词的工具只是查看（如 gmail_list_messages），不算对外发消息。 */
const READ_VERBS = /(^|_)(list|get|read|search|fetch|query|find|view|show|count)(_|$)/i

/**
 * 内置硬规则：不能删除。ask 可以被你的 preapproved 抵消；handoff 只能被带关键词的 preapproved 覆盖。
 * @type {readonly BuiltinRule[]}
 */
export const BUILTIN_RULES = Object.freeze([
  {
    id: 'b1', tool: '*', decision: 'handoff', note: '付钱、转账、下单交给你亲自做', skip: CONTENT_TOOLS, scope: 'all',
    match: '支付|付款|转账|汇款|下单|结账|充值|checkout|payment|purchase|transfer money|信用卡|银行卡|银行账户|credit card|wallet',
  },
  {
    id: 'b2', tool: '*', decision: 'handoff', note: '密码、密钥、验证码、安全设置交给你亲自处理', skip: CONTENT_TOOLS, scope: 'all',
    match: 'password|passwd|密码|口令|api_key|apikey|api key|secret_key|private key|私钥|验证码|2fa|otp|安全设置|security settings',
  },
  {
    id: 'b3', tool: '*mail*|*sms*|*tweet*|*slack*|*wechat*|*weixin*|*feishu*|*dingtalk*|*_post|post_*|publish*|*send*',
    decision: 'ask', note: '替你对外发消息、发帖前先问你', skip: READ_VERBS,
  },
  {
    id: 'b4', tool: '*delete*|*remove*|rm|rmdir|*trash*',
    decision: 'ask', note: '删除东西前先问你',
  },
  {
    id: 'b5', tool: 'pwsh|powershell|bash|sh|cmd|shell*|exec*|run_command*|run_code|terminal*',
    decision: 'ask', note: '可能删东西或强推的命令先问你', scope: 'command',
    match: 'remove-item|rm -r|rm -f|rm -rf|del /|rmdir|rd /s|git push -f|git push --force|reset --hard|git clean|format-volume|shutdown|drop table|drop database'
      + '|os.remove|os.unlink|shutil.rmtree|unlinksync|rmsync|fs.rm|.unlink(|rimraf',
  },
])

/**
 * 内置规则不看这些工具：Dot 自己的账本、只读查询、给子代理派活。
 * 否则「记一件事：周五付款」也会被当成付款拦下。
 */
const BUILTIN_EXEMPT = /^(dot_.*|send_message|ask_user.*|todo_.*|read.*|view.*|glob|grep|ls|list.*|search.*|fs_search.*|web_search.*|web_fetch|spawn.*|subagent.*|task|agent.*|wait_agent|interrupt_agent|list_agents|goal.*)$/i

/**
 * @param {string} pattern 单个 glob，或用 `|` 分隔的多个
 * @returns {RegExp}
 */
export function globToRegExp(pattern) {
  const alts = String(pattern).split('|').map(p => p.trim()).filter(Boolean)
  const body = (alts.length ? alts : ['']).map(p => p.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'))
  return new RegExp(`^(?:${body.join('|')})$`, 'i')
}

/** @param {unknown} args */
export function argsText(args) {
  if (args === undefined || args === null) return ''
  if (typeof args === 'string') return args.toLowerCase()
  try { return JSON.stringify(args).toLowerCase() } catch { return String(args).toLowerCase() }
}

/** 只取命令行或代码本身（不含说明文字），给 scope: 'command' 的规则用。 @param {unknown} args */
export function commandText(args) {
  if (typeof args === 'string') return args.toLowerCase()
  const a = /** @type {Record<string, unknown>} */ (args && typeof args === 'object' ? args : {})
  const parts = ['command', 'cmd', 'code', 'script', 'input'].map(k => a[k]).filter(v => typeof v === 'string')
  return parts.join('\n').toLowerCase()
}

/** @param {RuleLike} rule @param {number} now */
export function ruleExpired(rule, now) {
  return Boolean(rule.until) && new Date(String(rule.until)).getTime() <= now
}

/**
 * @param {RuleLike} rule
 * @param {string} toolName
 * @param {string} haystack {@link argsText} 的结果（scope: 'command' 的内置规则自己取）
 * @param {unknown} [args]
 */
export function ruleMatches(rule, toolName, haystack, args) {
  if (!globToRegExp(rule.tool).test(toolName)) return false
  const b = /** @type {BuiltinRule} */ (rule)
  if (b.skip && b.skip.test(toolName)) return false
  if (!rule.match) return true
  const text = b.scope === 'command' ? commandText(args) : haystack
  return rule.match.split('|').map(k => k.trim().toLowerCase()).filter(Boolean).some(k => text.includes(k))
}

/**
 * 旧接口：只看用户规则，取最严格的那条。
 * @param {string} toolName
 * @param {readonly RuleLike[]} rules
 * @param {unknown} [args]
 * @returns {{ decision: RuleDecision, rule: RuleLike } | null}
 */
export function evaluateRules(toolName, rules, args) {
  const haystack = argsText(args)
  /** @type {{ decision: RuleDecision, rule: RuleLike } | null} */
  let best = null
  for (const rule of rules) {
    if (ruleExpired(rule, Date.now()) || !ruleMatches(rule, toolName, haystack, args)) continue
    if (best === null || STRICTNESS[rule.decision] > STRICTNESS[best.decision]) best = { decision: rule.decision, rule }
  }
  return best
}

/**
 * 完整判定：内置硬规则 + 用户规则。
 * @param {string} toolName
 * @param {unknown} args
 * @param {readonly RuleLike[]} userRules 配置规则在前，对话规则在后
 * @param {{ builtin?: readonly RuleLike[], now?: number }} [options]
 * @returns {Verdict}
 */
export function evaluate(toolName, args, userRules, options = {}) {
  const builtin = options.builtin ?? BUILTIN_RULES
  const now = options.now ?? Date.now()
  const haystack = argsText(args)
  const exempt = BUILTIN_EXEMPT.test(toolName)
  const b = exempt ? [] : builtin.filter(r => ruleMatches(r, toolName, haystack, args))
  const u = userRules.filter(r => !ruleExpired(r, now) && ruleMatches(r, toolName, haystack, args))
  const hits = [
    ...b.map(r => ({ id: r.id, layer: /** @type {RuleLayer} */ ('builtin'), decision: r.decision, tool: r.tool })),
    ...u.map(r => ({ id: r.id, layer: /** @type {RuleLayer} */ ('user'), decision: r.decision, tool: r.tool })),
  ]
  const pick = (/** @type {RuleLike[]} */ list, /** @type {RuleDecision} */ d) => list.find(r => r.decision === d)
  /** @param {RuleLike | undefined} rule @param {RuleLayer} layer @param {string} [overrides] */
  const out = (rule, layer, overrides) => (rule ? { decision: rule.decision, rule, layer, hits, exempt, ...(overrides ? { overrides } : {}) } : null)
  const builtinHandoff = pick(b, 'handoff')
  // 内置的「交给你」只能被你亲口加的、用关键词收窄过的 preapproved 覆盖（防止一条宽泛的规则放开所有付款）
  const narrowPre = u.find(r => r.decision === 'preapproved' && r.match)
  return out(pick(u, 'block'), 'user')
    ?? out(pick(u, 'handoff'), 'user')
    ?? (builtinHandoff ? (out(narrowPre, 'user', builtinHandoff.id) ?? out(builtinHandoff, 'builtin')) : null)
    ?? out(pick(u, 'ask'), 'user')
    ?? (pick(b, 'ask') ? (out(pick(u, 'preapproved'), 'user', pick(b, 'ask')?.id) ?? out(pick(b, 'ask'), 'builtin')) : null)
    ?? out(pick(u, 'preapproved'), 'user')
    ?? out(pick(u, 'allow'), 'user')
    ?? { decision: null, rule: null, layer: null, hits, exempt }
}

/**
 * 修改规则本身永远需要用户点头——否则模型可以先给自己放权再行动。
 * @param {string} toolName
 * @param {unknown} args
 */
export function isRuleMutation(toolName, args) {
  if (toolName !== 'dot_rules') return false
  const action = /** @type {{ action?: unknown }} */ (args ?? {}).action
  return action === 'add' || action === 'remove'
}
