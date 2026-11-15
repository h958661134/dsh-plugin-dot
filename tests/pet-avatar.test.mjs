import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { PET_CATALOG } from '../lib/petart.js'

function renderer() {
  class Node {
    constructor(tag) { this.tag = tag; this.attrs = {}; this.style = {}; this.children = [] }
    setAttribute(k, v) { this.attrs[k] = String(v) }
    getAttribute(k) { return this.attrs[k] }
    appendChild(n) { this.children.push(n); n.parent = this; return n }
    replaceChildren(...items) { this.children = items }
    remove() { this.parent.children = this.parent.children.filter(n => n !== this) }
  }
  let now = 1000, id = 0
  const frames = new Map(), document = { hidden: false, createElementNS: (_, tag) => new Node(tag) }, window = {}
  runInNewContext(readFileSync(new URL('../lib/pet-motion.js', import.meta.url), 'utf8') + '\n' + readFileSync(new URL('../lib/pet-avatar.js', import.meta.url), 'utf8'), {
    window, document, performance: { now: () => now },
    requestAnimationFrame: fn => { frames.set(++id, fn); return id }, cancelAnimationFrame: n => frames.delete(n),
  })
  const container = new Node('div'), avatar = window.__DotPetAvatar.mount(container)
  avatar.setArt({ renderer: 'dot-vector-v1', radius: 22, ahoge: true, back: [], front: [] })
  const find = (node, key) => node.attrs['data-part'] === key ? node : node.children.map(n => find(n, key)).find(Boolean)
  const hand = name => find(avatar.element, name).attrs.transform
  const advance = ms => { now += ms; const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(now)) }
  return { avatar, document, frames, container, hand, advance, part: name => find(avatar.element, name) }
}

test('人物桌边左右手即时切帧，停手归位，站姿和状态切换不跳成半身', () => {
  const r = renderer(), frame = () => Number(r.part('portrait').attrs['data-frame'])
  for (const c of PET_CATALOG.characters.filter(c=>c.renderer==='dot-atlas-v1')) {
    r.avatar.setArt({ ...c, animations: undefined }); r.avatar.setOptions({ posture: 'desk' })
    assert.equal(frame(), 3)
    assert.equal(r.avatar.tap(), true); const first = frame()
    assert.ok([4, 5].includes(first))
    r.advance(70); assert.equal(r.avatar.tap(), true)
    assert.equal(frame(), first === 4 ? 5 : 4)
    assert.equal(r.avatar.tap(), false); assert.equal(r.frames.size, 1)
    r.advance(300); assert.equal(frame(), 3); assert.equal(r.frames.size, 0)
    r.avatar.setOptions({ posture: 'classic' }); assert.equal(frame(), 0)
    r.avatar.tap(); r.advance(70); assert.equal(frame(), 0)
    r.avatar.stop()
  }
  r.avatar.setOptions({ posture: 'classic' })
  r.avatar.play(PET_CATALOG.gestures.find(g => g.id === 'wave'), false)
  r.advance(100); assert.equal(frame(), 1)
  r.advance(4000); assert.equal(frame(), 0)
  r.avatar.setOptions({ posture: 'classic', resting: true }); assert.equal(frame(), 2)
  r.avatar.setOptions({ posture: 'desk', focused: true }); assert.equal(r.avatar.tap(), false); assert.equal(frame(), 3)
  r.avatar.setOptions({ posture: 'desk', reduced: true }); assert.equal(r.avatar.tap(), false)
  r.avatar.setOptions({ posture: 'desk' }); r.avatar.tap(); r.document.hidden = true; r.advance(40)
  assert.equal(r.frames.size, 0); assert.equal(frame(), 3)
})

test('输入第一下即回应，双手交替，快速重复不无限排队，停手回到中立', () => {
  const r = renderer()
  assert.equal(r.avatar.tap(), true)
  r.advance(70)
  const first = [r.hand('left-hand'), r.hand('right-hand')]
  assert.equal(first.filter(s => !s.startsWith('translate(0 0)')).length, 1)
  assert.equal(r.avatar.tap(), true)
  assert.equal(r.avatar.tap(), false)
  r.advance(70)
  assert.ok([r.hand('left-hand'), r.hand('right-hand')].every(s => !s.startsWith('translate(0 0)')))
  assert.equal(r.frames.size, 1)
  r.advance(300)
  assert.ok([r.hand('left-hand'), r.hand('right-hand')].every(s => s.startsWith('translate(0 0)')))
  assert.equal(r.frames.size, 0)
})

test('姿态切换保留形象契约，经典姿态可敲键盘，状态优先并停止残留动作', () => {
  const r = renderer()
  assert.equal(r.avatar.element.attrs['data-posture'], 'desk')
  r.avatar.setOptions({ posture: 'classic', outfit: 'scarf' })
  assert.equal(r.avatar.element.attrs['data-posture'], 'classic')
  r.avatar.tap(); r.advance(70)
  assert.match(r.hand('right-hand'), /translate\(-8 /)
  r.avatar.setMood('waiting')
  assert.equal(r.frames.size, 0)
  assert.equal(r.avatar.tap(), false)
  r.avatar.setMood('idle')
  for (const options of [{ reduced: true }, { focused: true }, { resting: true }]) {
    r.avatar.setOptions(options)
    assert.equal(r.avatar.tap(), false)
    assert.equal(r.frames.size, 0)
  }
  r.avatar.setOptions({ posture: 'desk' })
  assert.equal(r.avatar.tap(), true)
  r.document.hidden = true; r.advance(40)
  assert.equal(r.frames.size, 0)
  r.avatar.dispose()
  assert.equal(r.container.children.length, 0)
})

test('抬手、落键与回弹清楚分段，键帽只在落键时回应并完全复位', () => {
  const r = renderer()
  r.avatar.tap()
  assert.ok(!r.hand('right-hand').startsWith('translate(0 0)'), '立即抬手')
  r.advance(45)
  assert.match(r.hand('right-hand'), /translate\(0 -13\)/)
  assert.equal(r.part('right-impact').attrs.opacity, '0')
  r.advance(57)
  assert.equal(r.part('right-keys').attrs.transform, 'translate(0 1.5)')
  assert.equal(r.part('right-impact').attrs.opacity, '0.9')
  assert.match(r.hand('right-hand'), /scale\(1.22 0.78\)/)
  r.advance(43)
  assert.match(r.hand('right-hand'), /translate\(0 -6\)/)
  r.advance(140)
  assert.equal(r.part('right-keys').attrs.transform, 'translate(0 0)')
  assert.equal(r.part('right-impact').attrs.opacity, '0')
  assert.equal(r.frames.size, 0)
})

test('手动仪态结束后恢复跟敲，减少动画只回应表情', () => {
  const r = renderer()
  r.avatar.play(PET_CATALOG.gestures[0], false)
  assert.equal(r.avatar.tap(), false)
  r.advance(2000)
  assert.equal(r.frames.size, 0)
  assert.equal(r.avatar.tap(), true)
  r.avatar.stop()
  r.avatar.play(PET_CATALOG.gestures[1], true)
  r.advance(350)
  assert.ok([r.hand('left-hand'), r.hand('right-hand')].every(s => s.startsWith('translate(0 0)')))
  r.advance(500)
  assert.equal(r.frames.size, 0)
})

test('紧凑人物：主体不切帧，指尖独立回应，立即坐下，贴边与销毁可恢复', () => {
 const r=renderer(),portrait=()=>r.part('portrait').attrs;
 for(const c of PET_CATALOG.characters.filter(c=>c.renderer==='dot-atlas-v1')){
  r.avatar.setArt(c);r.avatar.setOptions({posture:'desk'});
  assert.equal(portrait()['data-frame'],'0');r.avatar.tap();r.advance(60);
  assert.equal(portrait()['data-frame'],'0');assert.ok(Number(r.part('left-fingers').attrs.opacity)>.99);assert.equal(r.part('typing-contact').attrs.opacity,'0');
  r.advance(200);assert.equal(r.part('left-fingers').attrs.opacity,'0');assert.equal(r.frames.size,1);
  r.avatar.setOptions({posture:'classic'});assert.equal(portrait()['data-state'],'sit');assert.equal(portrait()['data-frame'],'0');
  r.advance(16500);assert.equal(portrait()['data-frame'],'3');
  r.avatar.setEnvironment({held:true,velocity:10});assert.equal(portrait()['data-frame'],'4');assert.equal(r.avatar.tap(),false);
  r.avatar.setEnvironment({held:false,edge:'right',hover:false});assert.equal(portrait()['data-frame'],'5');assert.match(r.part('portrait-rig').attrs.transform,/scale\(-/);
  r.advance(450);assert.ok(r.avatar.motionState().reveal<.1);r.avatar.setEnvironment({hover:true});assert.equal(r.avatar.motionState().reveal,1);
  r.avatar.setEnvironment({edge:'ground',hover:false});
 }
 r.document.hidden=true;r.advance(100);assert.equal(r.frames.size,0);r.avatar.dispose();assert.equal(r.container.children.length,0);
})

test('线条形象恢复：坐姿、换装、跟敲与空闲眨眼共存，轮询不重置眨眼时钟',()=>{
 const r=renderer(),art=PET_CATALOG.characters.find(c=>c.id==='bunny');
 r.avatar.setArt(art);r.avatar.setOptions({posture:'classic',outfit:'scarf'});
 assert.equal(r.avatar.element.attrs['data-style'],'soft-line-v2');assert.equal(r.avatar.element.attrs['data-state'],'sit');
 assert.equal(r.part('portrait').style.display,'none');assert.equal(r.frames.size,1);
 r.advance(3000);r.avatar.setArt(art);r.advance(560);
 // Closed-eye paths have no vertical segment, then naturally reopen.
 const paths=[];const walk=n=>{if(n.tag==='path')paths.push(n);n.children.forEach(walk)};walk(r.avatar.element);
 assert.ok(paths.some(n=>n.attrs.d==='M17 28h6'));r.advance(180);assert.ok(paths.some(n=>n.attrs.d==='M20 26v4'));
 assert.equal(r.avatar.tap(),true);r.advance(45);assert.ok(!r.hand('right-hand').startsWith('translate(0 0)'));
 r.avatar.setOptions({posture:'classic',focused:true});assert.equal(r.avatar.tap(),false);assert.equal(r.frames.size,0);
 for(const blocked of [{suspended:true},{quiet:true},{reduced:true}]){r.avatar.setOptions(blocked);assert.equal(r.avatar.tap(),false);assert.equal(r.frames.size,0)}
 r.avatar.setArt(PET_CATALOG.characters[0]);r.avatar.setOptions({posture:'desk'});r.avatar.tap();r.advance(60);assert.equal(r.part('left-fingers').attrs.opacity,'1');
 r.advance(55);assert.equal(r.part('left-fingers').attrs.opacity,'0');assert.equal(r.part('left-keycap').attrs.opacity,'0.75');
 r.avatar.setArt(art);assert.equal(r.part('left-keycap').attrs.opacity,'0');assert.equal(r.part('left-fingers').attrs.opacity,'0');
 r.document.hidden=true;r.advance(100);assert.equal(r.frames.size,0);r.avatar.dispose();
})
