// 用接近真实 Host 的数据渲染插件组件，检查交互请求与失败恢复。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadBridge, textOf, findAll, button, FIXTURES } from './helpers/ui-harness.mjs'
import { PET_CHARACTERS } from '../lib/petart.js'

test('bridge 注册了全部入口', async () => {
  const { registered } = await loadBridge()
  for (const k of ['main:dot-sessions', 'sidebar.panellist:dot-sessions', 'sidebar.right.pane.tab:dsh-plugin-dot/panel',
    'conversation.chat.turnTail:dsh-plugin-dot-turn', 'sidebar.workspaces.session.row.action:dsh-plugin-dot-watch']) {
    assert.equal(typeof registered[k], 'function', k)
  }
})

test('Dot 窗口：今天页有审批、交给你（记为事务 / 我做完了）、建议；规则页有试一试、期限和覆盖提醒、外观', async () => {
  const { r, posts, registered, bridge } = await loadBridge()
  const Panel = registered['sidebar.right.pane.tab:dsh-plugin-dot/panel']
  const el = r.React.createElement(Panel, {})
  let tree = await r.render(el)
  let text = textOf(tree)
  assert.match(text, /需要你批准|执行命令|按 Dot 规则 b5/)
  assert.match(text, /把一件事交给你亲自做/)
  assert.match(text, /每天早上给你发一份简报/)
  button(tree, '我做完了').props.onClick({ stopPropagation() {} })
  button(tree, '每天 9 点').props.onClick({ stopPropagation() {} })
  await r.render(el)
  assert.deepEqual(posts.slice(0, 2), [['/notice', { id: 'n1', action: 'done' }], ['/suggestion', { id: 's1', option: 0 }]])

  findAll(tree, n => n.tag === 'button' && /^规则/.test(textOf(n).trim()))[0].props.onClick({})
  tree = await r.render(el)
  text = textOf(tree)
  assert.match(text, /试一试/)
  assert.match(text, /有效期到/)
  assert.match(text, /可以放行内置规则要交给你的事/)
  assert.match(text, /命中 2 次/)
  assert.match(text, /小精灵/)
  assert.match(text, /Alt\+Shift\+D/)
  // 小精灵改名后，右栏标签跟着叫这个名字
  bridge.noteStatus({ watchedIds: [], petName: '小点' })
  assert.equal(registered.tabMeta.title(), '小点')
  r.unmount()
})

test('会话总览：待办、文件、上下文用量（快满变红）', async () => {
  const { r, registered } = await loadBridge()
  const tree = await r.render(r.React.createElement(registered['main:dot-sessions'], {}))
  const text = textOf(tree)
  assert.match(text, /改登录页/)
  assert.match(text, /src\/login\.tsx/)
  assert.match(text, /上下文 120K \/ 128K（94%） 快满了/)
  r.unmount()
})

test('对话事务卡：合并请求，显示事务、提醒、记住的事；非 Dot 会话不显示', async () => {
  const { r, posts, registered, bridge } = await loadBridge()
  const Card = registered['conversation.chat.turnTail:dsh-plugin-dot-turn']
  const turn = (a, b) => ({ start: { time: a }, end: { time: b } })
  const none = await r.render(r.React.createElement(Card, { dotSessionId: 'other', turn: turn(1, 2) }))
  assert.equal(textOf(none), '')
  bridge.noteDotSessions(['dot-1'])
  const el = r.React.createElement('div', null,
    r.React.createElement(Card, { key: 'a', dotSessionId: 'dot-1', turn: turn(1, 2) }),
    r.React.createElement(Card, { key: 'b', dotSessionId: 'dot-1', turn: turn(3, 4) }))
  const tree = await r.render(el)
  const text = textOf(tree)
  assert.match(text, /给供应商回电话/)
  assert.match(text, /周五 15:00 回电话/)
  assert.match(text, /记住了/)
  const batch = posts.filter(p => p[0] === '/turns')
  assert.equal(batch.length, 1)
  assert.deepEqual(batch[0][1].ranges, [[1, 2], [3, 4]])
  r.unmount()
})

test('侧栏「盯着」按钮：按 Host 记录显示已盯；Dot 会话不显示', async () => {
  const { r, registered, bridge } = await loadBridge()
  const Row = registered['sidebar.workspaces.session.row.action:dsh-plugin-dot-watch']
  bridge.noteDotSessions(['dot-1'])
  bridge.noteStatus({ watchedIds: ['s9'], petName: 'Dot' })
  const on = await r.render(r.React.createElement(Row, { sessionId: 's9' }))
  assert.match(on.props.className, /\bon\b/)
  const off = await r.render(r.React.createElement(Row, { sessionId: 's8' }))
  assert.doesNotMatch(off.props.className, /\bon\b/)
  assert.equal(await r.render(r.React.createElement(Row, { sessionId: 'dot-1' })), null)
  r.unmount()
})

test('会话总览：搜索框搜所有会话；卡片上「转告…」直接发，「归档」走 Host', async () => {
  const { r, posts, registered } = await loadBridge()
  const el = r.React.createElement(registered['main:dot-sessions'], {})
  let tree = await r.render(el)
  const submit = async (form, text) => {
    findAll(form, n => n.tag === 'input')[0].props.onChange({ target: { value: text } })
    tree = await r.render(el)
    const again = findAll(tree, n => n.tag === 'form').find(f => f.props.className === form.props.className && textOf(f) === textOf(form))
    ;(again || form).props.onSubmit({ preventDefault() {} })
    tree = await r.render(el)
  }
  const searchForm = findAll(tree, n => n.tag === 'form')[0]
  assert.match(findAll(searchForm, n => n.tag === 'input')[0].props.placeholder, /搜所有会话/)
  await submit(searchForm, '登录页')
  assert.deepEqual(posts.at(-1), ['/sessions/search', { query: '登录页' }])
  let text = textOf(tree)
  assert.match(text, /「登录页」出现在 1 个会话里/)
  assert.match(text, /上周的会话/)
  assert.match(text, /把登录页改成深色/)

  button(tree, '转告…').props.onClick({ stopPropagation() {} })
  tree = await r.render(el)
  const forms = findAll(tree, n => n.tag === 'form')
  const relayForm = forms.find(f => /Dot 代你转告/.test(findAll(f, n => n.tag === 'input')[0].props.placeholder))
  assert.ok(relayForm, '卡片上出现转告输入框')
  findAll(relayForm, n => n.tag === 'input')[0].props.onChange({ target: { value: '顺便把测试也跑一下' } })
  tree = await r.render(el)
  findAll(tree, n => n.tag === 'form').find(f => /Dot 代你转告/.test(findAll(f, n => n.tag === 'input')[0].props.placeholder)).props.onSubmit({ preventDefault() {} })
  await r.render(el)
  assert.deepEqual(posts.at(-1), ['/session', { id: 's9', action: 'relay', text: '顺便把测试也跑一下' }])
  // 正在跑的会话没有「归档」按钮
  assert.equal(button(tree, '归档'), undefined)
  r.unmount()
})

test('工作台：数字进入对应清单；关键词匹配备注、小步骤；筛选和清空可组合', async t => {
  const fixtures = structuredClone(FIXTURES)
  fixtures['/status'].tasks = [
    { id: 't1', title: '报价', notes: 'ACME 合同', bucket: 'overdue', priority: 'high' },
    { id: 't2', title: '周报', bucket: 'today', priority: 'normal', steps: [{ text: '核对营收', done: false }] },
    { id: 't3', title: '设计反馈', bucket: 'waiting', status: 'waiting', waitingOn: '设计师' },
  ].map(x => ({ owner: 'user', children: [], status: 'open', ...x }))
  const { r, registered } = await loadBridge({ fixtures })
  t.after(() => r.unmount())
  const el = r.React.createElement(registered['sidebar.right.pane.tab:dsh-plugin-dot/panel'], {})
  let tree = await r.render(el)
  findAll(tree, n => n.props['aria-label'] === '已逾期 1 件，查看')[0].props.onClick()
  tree = await r.render(el)
  assert.equal(findAll(tree, n => n.props.className === 'dotui-filter on')[0].children[0], '逾期')
  const rows = () => findAll(tree, n => /\bdotui-todo\b/.test(n.props.className || ''))
  assert.equal(rows().length, 1)
  findAll(tree, n => n.props.className === 'dotui-filter' && textOf(n).startsWith('全部'))[0].props.onClick()
  tree = await r.render(el)
  for (const [query, title] of [['acme', '报价'], ['营收', '周报'], ['设计师', '设计反馈']]) {
    findAll(tree, n => n.props['aria-label'] === '搜索待办')[0].props.onChange({ target: { value: query } })
    tree = await r.render(el)
    assert.equal(rows().length, 1)
    assert.match(textOf(rows()[0]), new RegExp(title))
  }
  findAll(tree, n => n.props['aria-label'] === '搜索待办')[0].props.onChange({ target: { value: '不存在' } })
  tree = await r.render(el)
  assert.match(textOf(tree), /没有找到匹配的待办/)
  button(tree, '查看全部待办').props.onClick({ stopPropagation() {} })
  tree = await r.render(el)
  assert.equal(rows().length, 3)
})

test('添加待办：中文组词回车不提交；请求期间禁用；失败保留草稿，成功后清空', async t => {
  let settle
  const { r, registered, posts } = await loadBridge({ post: () => new Promise(resolve => { settle = resolve }) })
  t.after(() => r.unmount())
  const el = r.React.createElement(registered['sidebar.right.pane.tab:dsh-plugin-dot/panel'], {})
  let tree = await r.render(el)
  const input = () => findAll(tree, n => n.props['aria-label'] === '添加待办')[0]
  let prevented = false
  input().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(posts.length, 0)
  input().props.onChange({ target: { value: '明天9点 开会' } })
  tree = await r.render(el)
  const submit = () => findAll(tree, n => n.tag === 'form' && n.props.className === 'dotui-addrow')[0].props.onSubmit({ preventDefault() {} })
  submit()
  tree = await r.render(el)
  assert.equal(input().props.readOnly, true)
  submit()
  assert.equal(posts.length, 1)
  settle({ ok: false, text: '保存失败' })
  tree = await r.render(el)
  assert.equal(input().props.value, '明天9点 开会')
  assert.equal(input().props.readOnly, false)
  submit()
  tree = await r.render(el)
  settle({ ok: true, text: '记下了' })
  tree = await r.render(el)
  assert.equal(input().props.value, '')
  assert.equal(posts.length, 2)
})

test('完成待办失败：撤回划线状态，仍可重试', async t => {
  const fixtures = structuredClone(FIXTURES)
  fixtures['/status'].tasks[0].bucket = 'today'
  const { r, registered, posts } = await loadBridge({ fixtures, post: async () => ({ ok: false, text: '暂时无法保存' }) })
  t.after(() => r.unmount())
  const el = r.React.createElement(registered['sidebar.right.pane.tab:dsh-plugin-dot/panel'], {})
  let tree = await r.render(el)
  findAll(tree, n => n.props['aria-label'] === '完成：交周报')[0].props.onClick({ stopPropagation() {} })
  tree = await r.render(el)
  assert.match(findAll(tree, n => /\bdotui-todo\b/.test(n.props.className || ''))[0].props.className, /gone/)
  await new Promise(resolve => setTimeout(resolve, 280))
  tree = await r.render(el)
  assert.doesNotMatch(findAll(tree, n => /\bdotui-todo\b/.test(n.props.className || ''))[0].props.className, /gone/)
  assert.equal(posts.length, 1)
})

test('断线显示重试；恢复后退出错误状态', async t => {
  let offline = true
  const { r, registered } = await loadBridge({ get: async path => {
    if (offline) throw new Error('offline')
    return structuredClone(FIXTURES[path])
  } })
  t.after(() => r.unmount())
  const el = r.React.createElement(registered['sidebar.right.pane.tab:dsh-plugin-dot/panel'], {})
  let tree = await r.render(el)
  assert.match(textOf(tree), /暂时无法连接 Dot/)
  offline = false
  button(tree, '重试').props.onClick({ stopPropagation() {} })
  tree = await r.render(el)
  assert.doesNotMatch(textOf(tree), /连接中断|暂时无法连接/)
  assert.match(textOf(tree), /需要你批准/)
})

test('会话筛选：只看在等你的会话；关闭搜索后迟到的响应不重新打开结果', async t => {
  const fixtures = structuredClone(FIXTURES)
  fixtures['/sessions'].sessions.push({ ...fixtures['/sessions'].sessions[0], id: 'waiting', title: '等确认', asking: '用哪一版？' })
  let settle
  const { r, registered } = await loadBridge({ fixtures, post: () => new Promise(resolve => { settle = resolve }) })
  t.after(() => r.unmount())
  const el = r.React.createElement(registered['main:dot-sessions'], {})
  let tree = await r.render(el)
  button(tree, '在等你').props.onClick()
  tree = await r.render(el)
  assert.match(textOf(tree), /等确认/)
  assert.doesNotMatch(textOf(tree), /改登录页/)
  findAll(tree, n => n.tag === 'input')[0].props.onChange({ target: { value: '登录' } })
  tree = await r.render(el)
  findAll(tree, n => n.tag === 'form')[0].props.onSubmit({ preventDefault() {} })
  tree = await r.render(el)
  button(tree, '关闭').props.onClick({ stopPropagation() {} })
  settle({ ok: true, hits: [{ id: 'late', title: '迟到的结果' }] })
  tree = await r.render(el)
  assert.doesNotMatch(textOf(tree), /迟到的结果|出现在.*会话里/)
})

test('精灵选择器：显示三个形象，切换形象与减少动作只提交对应偏好', async t => {
  const fixtures = structuredClone(FIXTURES)
  fixtures['/data'].petCharacters = PET_CHARACTERS
  const { r, registered, posts } = await loadBridge({ fixtures })
  t.after(() => r.unmount())
  const el = r.React.createElement(registered['sidebar.right.pane.tab:dsh-plugin-dot/panel'], {})
  let tree = await r.render(el)
  findAll(tree, n => n.props.role === 'tab' && textOf(n).trim() === '规则')[0].props.onClick()
  tree = await r.render(el)
  assert.match(textOf(tree), /小点.*棉花兔.*糯米猫/)
  button(tree, '棉花兔').props.onClick()
  button(tree, '少动一点').props.onClick()
  await r.render(el)
  assert.deepEqual(posts.slice(-2), [['/prefs', { pet: { character: 'bunny' } }], ['/prefs', { pet: { motion: 'reduced' } }]])
})
