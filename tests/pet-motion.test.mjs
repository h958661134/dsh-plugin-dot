import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
const window={}; runInNewContext(readFileSync(new URL('../lib/pet-motion.js',import.meta.url),'utf8'),{window})
const create=()=>window.__DotPetMotion.create(1000,0)
const desk={posture:'desk',activity:'idle',edge:'ground'}
const seated=()=>window.__DotPetMotion.create(1000,0,'seated-v2')

test('指尖模式固定主体帧和变换，190ms 完成一次，连续输入只续一次',()=>{
 const m=seated();assert.equal(m.pulse(1000,desk),true)
 for(const t of [1000,1030,1060,1090,1130]){const s=m.sample(t,desk);assert.equal(s.index,0);assert.equal(s.sx,1);assert.equal(s.sy,1);assert.equal(s.tilt,0);assert.equal(s.y,0)}
 assert.equal(m.sample(1060,desk).fingerLift,1);assert.equal(m.sample(1060,desk).contact,0);assert.equal(m.sample(1115,desk).contact,1);assert.equal(m.sample(1115,desk).fingerLift,0);m.pulse(1120,desk);assert.equal(m.sample(1190,desk).hand,1);assert.equal(m.sample(1250,desk).fingerLift,1);assert.equal(m.sample(1305,desk).contact,1)
 assert.equal(m.sample(1400,desk).typing,false);assert.equal(m.sample(1400,desk).contact,0)
 m.pulse(1500,desk);m.pulse(1570,desk);assert.equal(m.sample(9000,desk).typing,false)
})
test('全身立即坐下，托腮和个性动作保持坐姿；工作与减少动画优先',()=>{
 const m=seated(),full={...desk,posture:'classic'}
 assert.equal(m.sample(1000,full).pose,'sit');assert.equal(m.sample(1000,full).index,0)
 assert.equal(m.sample(17500,full).index,3);assert.equal(m.sample(25500,full).index,2)
 for(const activity of ['focus','waiting','alert','rest','paused']){const s=m.sample(26000,{...full,activity});assert.equal(s.index,0);assert.equal(s.moving,false)}
 assert.equal(m.sample(27000,{...full,reduced:true}).sy,1)
 for(const t of [28000,28100,28200])assert.ok(Math.abs(m.sample(t,{...desk,activity:'held',velocity:100}).tilt)<=2.01)
})
test('藏猫猫只使用头手探出帧，隐藏、再探头和悬停揭晓可逆且不积压输入',()=>{
 const m=seated(),edge={...desk,edge:'left',hover:false};m.pulse(900,desk)
 assert.equal(m.sample(1000,edge).index,5);assert.equal(m.sample(1450,edge).reveal,.06);assert.equal(m.sample(2700,edge).reveal,.75);assert.ok(m.sample(4000,edge).reveal<.2)
 const revealed=m.sample(4500,{...edge,hover:true});assert.equal(revealed.reveal,1);assert.equal(revealed.typing,false)
 assert.equal(m.sample(5000,{...edge,edge:'right'}).mirror,-1);assert.equal(m.pulse(5100,edge),false)
 assert.equal(m.sample(5200,{...edge,reduced:true}).reveal,1);assert.equal(m.sample(5500,desk).pose,'desk')
})

test('200ms 一次完整敲击，连续输入只缓存一次换手，实际触键不会被快速输入跳过',()=>{
 const m=create();assert.equal(m.pulse(1000,desk),true)
 assert.equal(m.sample(1000,desk).index,0)
 assert.equal(m.sample(1050,desk).index,1)
 m.pulse(1070,desk)
 assert.equal(m.sample(1106,desk).index,2);assert.equal(m.sample(1106,desk).contact,1)
 assert.equal(m.sample(1200,desk).index,3)
 assert.equal(m.sample(1306,desk).index,5)
 assert.equal(m.sample(1450,desk).pose,'desk');assert.equal(m.busy(),false)
 for(let t=2000;t<12000;t+=20){m.pulse(t,desk);m.sample(t,desk)}
 assert.equal(m.sample(12400,desk).typing,false);assert.equal(m.busy(),false)
})
test('低帧率和后台恢复不会补播积压输入',()=>{
 const m=create();m.pulse(1000,desk);m.pulse(1070,desk)
 assert.equal(m.sample(12000,desk).typing,false)
 assert.equal(m.sample(13000,{...desk,hidden:true}).moving,false)
 assert.equal(m.pulse(13010,{...desk,hidden:true}),false)
 assert.equal(m.sample(14000,desk).pose,'desk')
})
test('眨眼分为闭合、停留和睁开，呼吸平稳，静置后托腮或坐在底边',()=>{
 const m=create();m.sample(1000,desk)
 assert.equal(m.sample(4525,desk).blink,.5);assert.equal(m.sample(4560,desk).blink,1);assert.equal(m.sample(4680,desk).blink,0)
 for(let t=1000;t<10000;t+=80){const s=m.sample(t,desk);assert.ok(s.sy>.99&&s.sy<1.01);assert.ok(Math.abs(s.tilt)<1)}
 assert.equal(m.sample(17500,desk).pose,'thinking')
 const full={...desk,posture:'classic'};m.sample(18000,full)
 assert.equal(m.sample(26500,full).pose,'sit');assert.equal(m.sample(34500,full).index,5)
 assert.equal(m.sample(35000,{...full,edge:'none'}).pose,'standing')
})
test('物理姿态优先，少动一点仍保留悬空与贴边静态反馈；工作状态取消跟敲',()=>{
 for(const activity of ['waiting','alert','focus','rest','paused']){
  const m=create();m.pulse(1000,desk);const c={...desk,activity};assert.equal(m.sample(1050,c).typing,false);assert.equal(m.pulse(1100,c),false);assert.equal(m.sample(1200,c).moving,false)
 }
 const m=create();m.sample(1000,desk)
 assert.equal(m.sample(1100,{...desk,activity:'held'}).pose,'held')
 const edge=m.sample(1200,{...desk,edge:'right'});assert.equal(edge.pose,'edge');assert.equal(edge.mirror,-1)
 const reduced=m.sample(1300,{...desk,activity:'held',reduced:true});assert.equal(reduced.pose,'held');assert.equal(reduced.tilt,0)
 assert.equal(m.pulse(1400,{...desk,edge:'left'}),false)
})
