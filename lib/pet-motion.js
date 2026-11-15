// Content-free input pulses and deterministic character motion. No timers or DOM here.
(function () {
  "use strict";
  var clamp = function (x, a, b) { return Math.max(a, Math.min(b, x)); };
  function create(now, seed) {
    seed = Number(seed) || 0;
    var born = now, touched = now, contextAt = now, contextKey = "", strokeAt = -1, hand = 1, pending = false, lastPulse = -1000;
    function blocked(c) { return c.reduced || c.hidden || c.quiet || ["waiting", "alert", "paused", "focus", "rest", "sleep"].indexOf(c.activity) >= 0; }
    function cancel() { strokeAt = -1; pending = false; }
    function pulse(t, c) {
      sample(t, c);
      if (blocked(c) || c.posture !== "desk" || c.gesture || ["held", "fall"].indexOf(c.activity) >= 0 || c.edge === "left" || c.edge === "right" || t - lastPulse < 65) return false;
      lastPulse = t; touched = t;
      if (strokeAt < 0) { hand = 1 - hand; strokeAt = t; } else pending = true;
      return true;
    }
    function sample(t, c) {
      var key = [c.posture, c.edge, c.activity, Boolean(c.reduced), Boolean(c.hidden), Boolean(c.quiet)].join("|");
      if (key !== contextKey) { contextKey = key; contextAt = t; touched = t; cancel(); }
      var desk = c.posture === "desk", stop = blocked(c), physical = c.activity === "held" || c.activity === "fall";
      var s = { sheet: desk ? "typing" : "base", index: desk ? 5 : 0, pose: desk ? "desk" : "standing", hand: hand,
        contact: 0, x: 0, y: 0, tilt: 0, sx: 1, sy: 1, mirror: 1, blink: 0, moving: !stop, typing: false };
      if (physical) {
        cancel(); s.sheet = "life"; s.index = 2; s.pose = c.activity;
        if (!stop) { s.tilt = clamp(Number(c.velocity) || 0, -10, 10) + Math.sin((t - contextAt) / 220) * 1.8; s.y = Math.sin(t / 350) * .5; }
        return s;
      }
      if (c.edge === "left" || c.edge === "right") {
        cancel(); s.sheet = "life"; s.index = 3; s.pose = "edge"; s.mirror = c.edge === "right" ? -1 : 1;
        if (!stop) { var elapsed = t - contextAt; s.x = s.mirror * Math.cos(elapsed / 75) * Math.exp(-elapsed / 210) * 3; s.tilt = Math.sin(t / 2600) * .5; }
        return s;
      }
      if (stop) {
        cancel(); s.moving = false;
        if (["sleep", "rest"].indexOf(c.activity) >= 0) s.blink = 1;
        return s;
      }
      if (c.gesture) {
        cancel();
        if (c.gesture === "think" || c.gesture === "sit") { s.sheet = "life"; s.index = desk ? 1 : c.gesture === "think" ? 5 : 4; s.pose = desk ? "thinking" : "sit"; }
        else if (!desk) { s.sheet = "base"; s.index = c.gesture === "wave" ? 1 : 2; }
      } else if (strokeAt >= 0 && desk) {
        var age = t - strokeAt;
        if (age >= 200) {
          // Keep only one recent continuation; a slow frame never replays a backlog.
          if (pending && t - lastPulse < 145 && age < 400) { strokeAt = t; hand = 1 - hand; pending = false; age = 0; }
          else { cancel(); age = 200; }
        }
        if (strokeAt >= 0) {
          s.typing = true; s.pose = "typing"; s.hand = hand;
          s.index = hand * 3 + (age < 44 ? 0 : age < 84 ? 1 : age < 132 ? 2 : age < 165 ? 1 : 2);
          s.contact = Math.max(0, 1 - Math.abs(age - 106) / 27);
          s.y = s.contact * .75; s.sy = 1 - .012 * s.contact; s.sx = 1 + .006 * s.contact; s.tilt = (hand ? 1 : -1) * s.contact * .6;
        }
      }
      if (!s.typing && !c.gesture) {
        var idle = t - touched;
        if (!desk && c.edge === "ground" && idle >= 8000) { s.sheet = "life"; s.index = 4; s.pose = "sit"; }
        if (idle >= 16000 && (idle - 16000) % 26000 < 3400) { s.sheet = "life"; s.index = desk ? 1 : c.edge === "ground" ? 5 : 0; s.pose = desk ? "thinking" : c.edge === "ground" ? "sit" : "standing"; if (s.pose === "standing") { s.sheet = "base"; s.index = 1; } }
        var breath = Math.sin((t - born) / 950 + seed);
        s.sy *= 1 + breath * .006; s.sx *= 1 - breath * .0025; s.y -= breath * .3; s.tilt += Math.sin((t - born) / 2500 + seed) * .45;
      }
      // Eyelid patches keep hair, torso and keyboard still while blinking.
      if (!c.gesture && !(s.sheet === "life" && s.index === 5) && ["desk", "standing", "sit", "typing"].indexOf(s.pose) >= 0) {
        var phase = (t - born + seed * 233) % (4700 + seed * 113);
        if (phase >= 3500 && phase < 3680) { var b = phase - 3500; s.blink = b < 50 ? b / 50 : b < 100 ? 1 : (180 - b) / 80; }
      }
      return s;
    }
    return { pulse: pulse, sample: sample, stop: function () { cancel(); }, touch: function (t) { touched = t; }, busy: function () { return strokeAt >= 0; } };
  }
  // Compact seated characters keep one stable desk image; only fingertip patches respond.
  function createSeated(now, seed) {
    seed = Number(seed) || 0;
    var born = now, touched = now, contextAt = now, key = '', at = -1, hand = 1, pending = false, last = -1000;
    function stop() { at = -1; pending = false; }
    function blocked(c) { return c.reduced || c.hidden || c.quiet || ['waiting','alert','paused','focus','rest','sleep'].indexOf(c.activity) >= 0; }
    function sample(t, c) {
      var next = [c.posture,c.edge,c.activity,!!c.reduced,!!c.hidden,!!c.quiet,!!c.hover].join('|');
      if (next !== key) { key = next; contextAt = touched = t; stop(); }
      var desk = c.posture === 'desk', quiet = blocked(c);
      var s = {sheet:desk?'typing':'life',index:0,pose:desk?'desk':'sit',hand:hand,contact:0,fingerLift:0,x:0,y:0,tilt:0,sx:1,sy:1,mirror:1,blink:0,reveal:1,moving:!quiet,typing:false};
      if (c.activity === 'held' || c.activity === 'fall') {
        stop();s.sheet='life';s.index=4;s.pose=c.activity;
        if(!quiet)s.tilt=clamp((Number(c.velocity)||0)*.16,-1.6,1.6)+Math.sin((t-contextAt)/260)*.4;
        return s;
      }
      if(c.edge==='left'||c.edge==='right') {
        stop();s.sheet='life';s.index=5;s.pose='edge';s.mirror=c.edge==='right'?-1:1;s.y=-8;
        if(!quiet&&!c.hover){
          var age=(t-contextAt)%12000;
          s.reveal=age<400?1-age/400*.94:age<1100?.06:age<1500?.06+(age-1100)/400*.69:age<2500?.75:age<2900?.75-(age-2500)/400*.6:.15;
        }
        return s;
      }
      if(quiet){stop();if(c.activity==='rest'||c.activity==='sleep')s.blink=1;return s;}
      if(c.gesture){
        stop();s.index=desk?(c.gesture==='think'?4:5):(c.gesture==='think'?3:c.gesture==='sit'?0:2);s.pose=desk?'thinking':'sit';
      }else if(at>=0&&desk){
        var age=t-at;
        if(age>=190){if(pending&&t-last<145&&age<380){at=t;hand=1-hand;pending=false;age=0;}else{stop();age=190;}}
        if(at>=0){
          s.typing=true;s.pose='typing';s.hand=hand;
          s.fingerLift=age<40?.3+age/40*.7:age<65?1:age<105?1-(age-65)/40:age<140?0:age<160?(age-140)/20*.25:Math.max(0,(190-age)/30*.25);
          s.contact=Math.max(0,1-Math.abs(age-115)/25);
        }
      }
      if(!s.typing&&!c.gesture){
        var idle=t-touched;
        if(c.activity==='idle'||c.activity==='done'){
          if(idle>=16000&&(idle-16000)%31000<3200){s.index=desk?4:3;s.pose=desk?'thinking':'sit';}
          else if(idle>=24000&&(idle-24000)%38000<2400){s.index=desk?5:2;s.pose=desk?'thinking':'sit';}
        }
        s.sy=1+Math.sin((t-born)/1200+seed)*.003;s.y=-Math.sin((t-born)/1200+seed)*.1;
      }
      if(!c.gesture&&s.index===0){var phase=(t-born+seed*233)%(5100+seed*113);if(phase>=3500&&phase<3680){var b=phase-3500;s.blink=b<50?b/50:b<100?1:(180-b)/80;}}
      return s;
    }
    return {sample:sample,pulse:function(t,c){sample(t,c);if(blocked(c)||c.posture!=='desk'||c.gesture||c.activity==='held'||c.activity==='fall'||c.edge==='left'||c.edge==='right'||t-last<65)return false;last=t;touched=t;if(at<0){hand=1-hand;at=t;}else pending=true;return true;},stop:stop,touch:function(t){touched=t;},busy:function(){return at>=0;}};
  }
  window.__DotPetMotion = { create: function(now,seed,style){return style==='seated-v2'?createSeated(now,seed):create(now,seed);} };
})();
