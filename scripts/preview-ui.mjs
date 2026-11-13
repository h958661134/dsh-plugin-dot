// 本地演示：直接加载产品 bridge.js，所有数据和操作都留在浏览器内。
// 首次运行前：npm install --prefix .preview --ignore-scripts react@18.3.1 react-dom@18.3.1
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { FIXTURES } from '../tests/helpers/ui-harness.mjs'

const fixtures = structuredClone(FIXTURES)
const now = Date.now()
const date = hours => new Date(now + hours * 3600_000).toISOString()
fixtures['/status'] = {
  ...fixtures['/status'], pet: { name: 'Dot', color: 'blue' },
  tasks: [
    { id: 't1', title: '确认品牌首页的最终方案', notes: '核对首屏文案与移动端布局', priority: 'high', bucket: 'overdue', due: date(-3), overdue: true },
    { id: 't2', title: '整理本周的产品反馈', today: true, bucket: 'today', steps: [{ text: '归类反馈', done: true }, { text: '列出三个改进方向', done: false }] },
    { id: 't3', title: '把项目进展发给团队', today: true, bucket: 'today', due: date(2) },
    { id: 't4', title: '准备下周的设计评审', bucket: 'upcoming', due: date(48), notes: '整理交互原型和对比方案' },
    { id: 't5', title: '试试新的阅读清单', bucket: 'inbox' },
    { id: 't6', title: '跟进供应商的报价', bucket: 'waiting', status: 'waiting', waitingOn: '供应商回邮件', due: date(24) },
  ].map(t => ({ owner: 'user', priority: 'normal', status: 'open', children: [], ...t })),
  completed: [{ id: 't7', title: '梳理插件的导航结构', status: 'done', doneAt: date(-1) }],
  counts: { active: 6, decisions: 1 },
  decisions: [{ label: '品牌首页', kind: 'question', reason: '两版首屏已经准备好了，选一个方向就能继续。', open: 's2' }],
  notices: [],
  suggestions: [{ id: 'g1', kind: 'brief', title: '每天早上，帮你理一遍今天的事', body: '待办、提醒和会话进展，一份简报就够了。', options: [{ label: '每天 9 点', hint: '开启每日简报' }] }],
}
const running = fixtures['/sessions'].sessions[0]
fixtures['/sessions'].sessions = [
  { ...running, id: 's2', title: '品牌官网 · 首屏设计', current: '确认首屏方向', waiting: { reason: '需要你选定一版首屏，之后继续完善移动端。' }, todoDone: 2, todoTotal: 4, context: { used: 32000, window: 128000 }, files: ['src/home.tsx', 'src/theme.css'], steps: [{ name: '对比两版首屏', detail: '布局与文案已就绪', ok: true, ms: 420, at: now }], lastText: '' },
  { ...running, id: 's3', title: '插件界面 · 交互打磨', current: '检查窄侧栏的显示', todoDone: 3, todoTotal: 5, context: { used: 48000, window: 128000 }, files: ['lib/bridge.js'], steps: [{ name: '检查组件', detail: '搜索与筛选交互', ok: true, ms: 420, at: now }], lastText: '正在检查键盘导航与表单反馈。' },
  { ...running, id: 's4', title: '用户反馈 · 本周摘要', status: 'idle', result: 'done', current: '', endedAt: now - 1800000, todoDone: 3, todoTotal: 3, context: null, steps: [], files: ['feedback.md'], lastText: '已整理出 3 个主要改进方向，可以开始安排下周的工作。' },
]

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dot 界面预览</title>
<style>
*{box-sizing:border-box}body{margin:0;font:13px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#182131}body.dark{color-scheme:dark;--dsw-alias-bg-base:#171b24;--dsw-alias-bg-layer-1:#1d222d;--dsw-alias-label-primary:#e7ebf4;--dsw-alias-label-secondary:#a9b1c0;--dsw-alias-label-tertiary:#919baa;--dsw-alias-border-l2:#ffffff20;--dsw-alias-border-l1:#ffffff0d;--dsw-alias-state-business-primary:#8caaff;--dsw-alias-state-business-tertiary:#29354f;--dsw-alias-state-warn-primary:#efbb6a;--dsw-alias-state-warn-tertiary:#393021;--dsw-alias-state-error-primary:#f68f95;--dsw-alias-state-success-primary:#7ed3a5;background:#171b24;color:#e7ebf4}
.preview-tools{height:48px;padding:0 20px;display:flex;align-items:center;gap:18px;border-bottom:1px solid #8190a522;font-size:12px}.preview-tools a{color:inherit;text-decoration:none}.preview-tools strong{margin-right:auto;font-size:12px}.preview-tools span{opacity:.55}.preview-stage{height:calc(100vh - 48px);margin:auto;background:var(--dsw-alias-bg-base,#fff);max-width:100%}.preview-stage.workspace{display:grid;grid-template-columns:minmax(0,1fr) 400px}.preview-stage>div{height:100%;min-width:0;overflow:hidden}.preview-side{border-left:1px solid #8190a522}.dotui{height:100%}@media(max-width:720px){.preview-stage.workspace{grid-template-columns:1fr}.workspace>.preview-side{display:none}.preview-tools{gap:10px;padding:0 12px}.preview-tools span{display:none}}
</style><body><header class="preview-tools"><strong>Dot <span> / 界面预览 · 演示数据</span></strong><a href="?view=today">今天</a><a href="?view=tasks">待办</a><a href="?view=sessions">会话</a><a href="?view=workspace">工作台</a><a id="theme" href="#">切换深浅</a></header><div id="app" class="preview-stage"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script>
<script>
var fixtures = ${JSON.stringify(fixtures).replaceAll('<', '\\u003c')};
var params = new URLSearchParams(location.search), view = params.get('view') || 'today';
if(params.get('theme')==='dark') document.body.classList.add('dark');
document.querySelector('#theme').onclick=function(e){e.preventDefault();document.body.classList.toggle('dark')};
if(params.get('empty')){Object.assign(fixtures['/status'],{tasks:[],completed:[],decisions:[],notices:[],suggestions:[],counts:{active:0}});fixtures['/sessions'].sessions=[]}
window.fetch=async function(url,opts){var path=url.replace('/api/dsh-plugin-dot',''),r=fixtures[path];
 if(params.get('offline')) throw new Error('演示断线');
 if(opts&&opts.method==='POST'){var b=JSON.parse(opts.body);r={ok:true,text:'演示操作已完成'};
 if(path==='/task'&&b.action==='add'){fixtures['/status'].tasks.push({id:'demo'+Date.now(),title:b.text,owner:'user',priority:'normal',status:'open',bucket:b.today?'today':'inbox',today:b.today,children:[]})}
 if(path==='/task'&&b.action==='done'){fixtures['/status'].tasks=fixtures['/status'].tasks.filter(function(t){return t.id!==b.id})}
 if(path==='/sessions/search')r.hits=fixtures['/sessions'].sessions.filter(function(s){return s.title.indexOf(b.query)>=0}).map(function(s){return {id:s.id,title:s.title,snippet:s.lastText||s.current,time:Date.now()}});
 fixtures['/status'].counts.active=fixtures['/status'].tasks.length;
 }return {ok:true,json:async function(){return JSON.parse(JSON.stringify(r||{}))}};
};
var registered={}, plugin;
window.__ModuleLoader__={load:function(m){plugin=m.factory(function(name){return name==='react'?React:{}})}};
</script><script src="/bridge.js"></script><script>
plugin.apply({effect:function(fn){return fn()},slots:{inject:function(n,fn){return fn()},register:function(m,c){registered[m.name+(m.key?':'+m.key:m.id?':'+m.id:'')]=c}},sidebarRightTabs:{register:function(){}},sidebarRight:{mounted:{getSnapshot:function(){return null},subscribe:function(){return function(){}}},openTab:function(){}},layout:{selectPanel:function(){location.search='?view=sessions'}},uiWorkspace:{openSession:function(){}}});
if(view==='tasks') window.__dshDotBridge.openDot(null,'tasks');
var app=document.querySelector('#app'),h=React.createElement,Panel=registered['sidebar.right.pane.tab:dsh-plugin-dot/panel'],Sessions=registered['main:dot-sessions'];
if(view==='workspace'){app.classList.add('workspace');ReactDOM.createRoot(app).render(h(React.Fragment,null,h('div',null,h(Sessions)),h('div',{className:'preview-side'},h(Panel))))}
else{if(view!=='sessions')app.style.width=(Number(params.get('width'))||420)+'px';ReactDOM.createRoot(app).render(h(view==='sessions'?Sessions:Panel))}
</script></body></html>`

const root = new URL('../', import.meta.url)
const routes = { '/bridge.js': 'lib/bridge.js', '/react.js': '.preview/node_modules/react/umd/react.development.js', '/react-dom.js': '.preview/node_modules/react-dom/umd/react-dom.development.js' }
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  try {
    if (path === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); return }
    if (!routes[path]) { res.writeHead(404); res.end(); return }
    res.setHeader('content-type', 'text/javascript; charset=utf-8')
    res.end(await readFile(new URL(routes[path], root)))
  } catch { res.writeHead(500); res.end('Preview dependencies missing. See scripts/preview-ui.mjs.') }
}).listen(4173, '127.0.0.1', () => console.log('Dot preview: http://127.0.0.1:4173 — only demo data'))
