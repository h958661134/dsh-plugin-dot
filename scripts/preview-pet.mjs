// 仅监听本机的精灵演示，不接入 DSH，不读写用户状态。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { PET_CATALOG, characterOf } from '../lib/petart.js'
import { checkPetLook } from '../lib/routes.js'
import { deskView } from '../lib/petcards.js'
import { emptyLife, lifeDesk } from '../lib/petlife.js'

let pet = {}, mood = 'idle'
const status = () => {
  const art = characterOf(pet.character)
  const s = { mood, paused: false, bubble: '', desktopPet: false, counts: {}, tasks: [], completed: [], unlinked: [], decisions: [], notices: [], suggestions: [], scheduled: [], sessions: [], dotSessions: [], watchedIds: [], hasDotSession: true, routes: {}, pet: { ...pet, color: pet.color || art.color }, petArt: art, petLife: { lastFed: null, focused: false, resting: false } }
  s.desk = { ...deskView(s, Date.now()), ...lifeDesk(emptyLife(), [], new Date()), greeting: null, dotBusy: false, cards: [] }
  return s
}
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dot · 小伙伴的日常</title><style>
*{box-sizing:border-box}body{margin:0;background:#faf8f4;color:#343541;font:14px/1.65 "Segoe UI","Microsoft YaHei",sans-serif}main{max-width:1060px;margin:56px auto;padding:0 28px}.eyebrow{font-size:12px;letter-spacing:2px;color:#8c8b94}.intro{display:flex;align-items:center;justify-content:space-between;gap:24px}h1{font-size:32px;line-height:1.45;letter-spacing:-1px;margin:14px 0 12px}p{color:#82818c;margin:0}.label{border:1px solid #e8e3db;background:#fffcf7;border-radius:40px;padding:7px 13px;font-size:11px;color:#8b8376}.gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin:34px 0 26px}.character{background:#fff;border:1px solid #eeebe5;border-radius:24px;overflow:hidden;text-align:center;padding:28px 20px 22px;box-shadow:0 5px 20px #44381d03}.stage{height:180px;display:flex;justify-content:center;align-items:center;background:radial-gradient(ellipse,#f5f4ff 0,transparent 68%);margin-bottom:18px}.character:nth-child(2) .stage{background:radial-gradient(ellipse,#fff0f5 0,transparent 68%)}.character:nth-child(3) .stage{background:radial-gradient(ellipse,#fff3df 0,transparent 68%)}.stage svg{width:150px;height:176px}.character h2{font-size:18px;margin:0 0 6px}.character p{font-size:12px}.character button{margin-top:20px;border:1px solid #e5e8f2;color:#6372ab;background:#f9faff;border-radius:10px;padding:7px 18px;font:inherit;font-size:12px;cursor:pointer}.actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:center}.actions button{border:1px solid #e4dfd7;background:#fffdf9;color:#696571;border-radius:12px;padding:10px 18px;cursor:pointer;font:inherit;font-size:12px}.actions button:hover,.actions button.on{background:#eef1ff;border-color:#cbd5ff;color:#4966c9}button:focus-visible{outline:2px solid #617cda;outline-offset:4px}.hint{text-align:center;font-size:12px;margin-top:20px}.settings{display:flex;align-items:center;justify-content:center;gap:20px;margin-top:32px;color:#8c8794;font-size:12px}.settings select{border:1px solid #e4dfd7;border-radius:8px;padding:5px;background:#fff;color:#696571}footer{margin:40px auto;text-align:center;color:#aaa4a0;font-size:11px}@media(max-width:700px){main{margin:24px auto}.gallery{grid-template-columns:1fr}.intro{display:block}h1{font-size:26px}.label{display:inline-block;margin-top:18px}}
</style><body><main><div class="eyebrow">DOT / LITTLE COMPANIONS</div><div class="intro"><div><h1>有空的话，<br>陪我玩一会儿。</h1><p>认真陪你工作，也想让你嘴角上扬。</p></div><div class="label">不打卡 · 不计分 · 随时给你一个抱抱</div></div><section class="gallery" id="gallery"></section><div class="actions" id="actions"></div><p class="hint" id="hint">点一个小动作，看看三个小伙伴怎么回应你。</p><div class="settings"><label><input id="reduced" type="checkbox"> 少动一点</label><label>右下角精灵状态 <select id="mood"><option value="idle">空闲</option><option value="busy">忙碌</option><option value="waiting">等你确认</option><option value="done">刚做完</option><option value="paused">暂停</option></select></label></div><footer>本地交互预览 · 演示数据 · 右下角是插件里实际使用的精灵</footer></main>
<script src="/pet-avatar.js"></script><script>
var catalog=${JSON.stringify(PET_CATALOG).replaceAll('<', '\\u003c')},views=[], colors={blue:['#9bafff','#5b78e8'],pink:['#ffaecf','#ed7faa'],orange:['#ffd499','#e9a15b']};
catalog.characters.forEach(function(c){var card=document.createElement('article');card.className='character';var stage=document.createElement('div');stage.className='stage';stage.style.setProperty('--ddp-c1',colors[c.color][0]);stage.style.setProperty('--ddp-c2',colors[c.color][1]);var av=window.__DotPetAvatar.mount(stage);av.setArt(c);views.push(av);var title=document.createElement('h2');title.textContent=c.name;var desc=document.createElement('p');desc.textContent=c.description;var btn=document.createElement('button');btn.textContent='选'+c.name+'陪我';btn.onclick=function(){fetch('/api/dsh-plugin-dot/pet',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'character',id:c.id})}).then(function(){document.querySelector('#hint').textContent=c.name+'在右下角等你。右键或点击它，试试摸摸头和小动作。'})};card.append(stage,title,desc,btn);document.querySelector('#gallery').appendChild(card)});
catalog.gestures.forEach(function(g){var b=document.createElement('button');b.textContent=g.name;b.onclick=function(){var reduced=document.querySelector('#reduced').checked||matchMedia('(prefers-reduced-motion:reduce)').matches;views.forEach(function(v){v.stop();v.play(g,reduced)});document.querySelectorAll('.actions button').forEach(function(x){x.classList.toggle('on',x===b)});document.querySelector('#hint').textContent=g.name+' · 一个短短的小动作，结束后继续陪你。'};document.querySelector('#actions').appendChild(b)});
document.querySelector('#mood').onchange=function(e){fetch('/demo/mood',{method:'POST',body:JSON.stringify({mood:e.target.value})})};
document.querySelector('#reduced').onchange=function(e){views.forEach(function(v){v.stop()});fetch('/api/dsh-plugin-dot/pet',{method:'POST',body:JSON.stringify({action:'motion',value:e.target.checked?'reduced':'auto'})})};
</script><script src="/client.js"></script></body></html>`
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const json = value => { res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)) }
  try {
    if (req.method === 'POST') {
      const chunks = []; for await (const b of req) chunks.push(b)
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      if (path === '/demo/mood') { mood = ['idle', 'busy', 'waiting', 'done', 'paused'].includes(body.mood) ? body.mood : 'idle' }
      if (path.endsWith('/pet')) {
        if (body.action === 'character') pet = { ...pet, ...checkPetLook({ character: body.id }) }
        if (body.action === 'motion') pet = { ...pet, ...checkPetLook({ motion: body.value }) }
      }
      json({ ok: true, text: '演示设置已更新', pet }); return
    }
    if (path.endsWith('/status')) { json(status()); return }
    if (path.endsWith('/pet/catalog')) { json(PET_CATALOG); return }
    if (path.endsWith('/focus/wait')) { setTimeout(() => json({ focus: null }), 1000); return }
    if (path === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); return }
    const files = { '/client.js': '../lib/client.js', '/pet-avatar.js': '../lib/pet-avatar.js' }
    if (files[path]) { res.setHeader('content-type', 'text/javascript; charset=utf-8'); res.end(await readFile(new URL(files[path], import.meta.url))); return }
    res.writeHead(404); res.end()
  } catch (e) { res.statusCode = 400; json({ ok: false, text: e.message }) }
})
server.listen(4174, '127.0.0.1', () => console.log('Pet preview: http://127.0.0.1:4174'))
