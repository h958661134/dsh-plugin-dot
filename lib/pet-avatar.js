// 浏览器矢量适配层：与 WPF 共用 56×66 身体坐标、前后图层和动作关键帧。
(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg", sequence = 0;
  var neutral = { tilt: 0, lift: 0, sx: 1, sy: 1, lx: 0, ly: 0, la: 0, rx: 0, ry: 0, ra: 0 };
  var mouths = { w: "M0 1 Q2.5 4.5 5 1 Q7.5 4.5 10 1", smile: "M1 .5 Q5 6.5 9 .5", o: "M5 .5 A2.6 2.6 0 1 1 4.99 .5 Z", flat: "M2 2 L8 2", wave: "M0 2 Q2.5 0 5 2 Q7.5 4 10 2", open: "M1 0 L9 0 Q9 7 5 7 Q1 7 1 0 Z" };
  function svg(tag, props, parent) { var n = document.createElementNS(NS, tag); Object.keys(props || {}).forEach(function (k) { n.setAttribute(k, props[k]); }); if (parent) parent.appendChild(n); return n; }
  function paint(v) { return { body: "var(--pet-body,var(--ddp-c2,#4d6bfe))", light: "var(--pet-light,var(--ddp-c1,#8aa2ff))", face: "#fff" }[v] || v; }
  function sample(g, p) {
    var frames = g.frames, i = 1;
    while (i < frames.length - 1 && p > frames[i].at) i++;
    var a = frames[i - 1], b = frames[i], t = (p - a.at) / (b.at - a.at), e = t * t * (3 - 2 * t), pose = {};
    Object.keys(neutral).forEach(function (k) { var x = a[k] == null ? neutral[k] : a[k], y = b[k] == null ? neutral[k] : b[k]; pose[k] = x + (y - x) * e; });
    return pose;
  }
  // 先抬起，再落到键帽上，最后回弹。两端都有限，不累积动作队列。
  function stroke(age) {
    var times = [0, 45, 95, 145, 215, 280], heights = [-3, -13, 5, -6, 1, 0];
    if (age < 0 || age >= 280) return { y: 0, press: 0, reach: 0 };
    var i = 1; while (i < times.length - 1 && age > times[i]) i++;
    var u = (age - times[i - 1]) / (times[i] - times[i - 1]), ease = u * u * (3 - 2 * u);
    return { y: heights[i - 1] + (heights[i] - heights[i - 1]) * ease, press: Math.max(0, 1 - Math.abs(age - 102) / 34), reach: Math.min(1, (age + 15) / 30, (280 - age) / 55) };
  }
  function mount(container) {
    var id = "dot-avatar-" + (++sequence), artKey = "", mood = "idle", frame = 0, active = null, lastTick = 0;
    var lineArt = false, lineBorn = 0;
    var posture = "desk", options = {}, optionsKey = "", taps = [0, 0], side = 0, lastTap = -1000, atlas = null;
    var motionArt = null, motion = null, environment = { edge: "ground" }, disposed = false, portraitKey = "", blendAt = -1, blendMs = 70, lastMotion = null;
    var outline = "color-mix(in srgb," + paint("body") + " 10%,#626172)", softBody = "color-mix(in srgb," + paint("light") + " 28%,#fffcf7)", cream = "color-mix(in srgb," + paint("light") + " 6%,#fffcf7)";
    var root = svg("svg", { viewBox: "-10 -22 80 94", width: 80, height: 94, "aria-hidden": "true", style: "overflow:visible;display:block;pointer-events:none" }, container);
    var defs = svg("defs", {}, root), gradient = svg("linearGradient", { id: id, x1: 0, y1: 0, x2: .2, y2: 1 }, defs);
    svg("stop", { offset: 0, "stop-color": cream }, gradient); svg("stop", { offset: 1, "stop-color": softBody }, gradient);
    var shadow = svg("ellipse", { cx: 28, cy: 66, rx: 27, ry: 3, fill: "#6c63851a" }, root);
    var figure = svg("g", {}, root), body = svg("g", { "data-part": "body" }, figure), back = svg("g", {}, body);
    var feet = svg("g", {}, body);
    svg("ellipse", { cx: 17, cy: 59, rx: 8, ry: 4.5, fill: softBody, stroke: outline, "stroke-width": 1.2 }, feet); svg("ellipse", { cx: 39, cy: 59, rx: 8, ry: 4.5, fill: softBody, stroke: outline, "stroke-width": 1.2 }, feet);
    var ahoge = svg("path", { d: "M28 12 C27 5 31 1 35 3", fill: "none", stroke: paint("body"), "stroke-width": 2.4, "stroke-linecap": "round" }, body);
    var shell = svg("rect", { x: 3, y: 10, width: 50, height: 47, rx: 23, fill: "url(#" + id + ")", stroke: outline, "stroke-width": 1.3 }, body);
    var deskBody = svg("path", { d: "M3 31 C3 17 12 9 28 9 C44 9 53 17 53 31 C57 42 55 53 47 55 Q28 59 9 55 C1 53 -1 42 3 31Z", fill: "url(#" + id + ")", stroke: outline, "stroke-width": 1.3 }, body);
    var shine = svg("path", { d: "M10 24Q12 16 21 15", fill: "none", stroke: "#ffffffb0", "stroke-width": 2.8, "stroke-linecap": "round" }, body);
    var front = svg("g", {}, body), cheeks = svg("g", { opacity: 0 }, body);
    svg("ellipse", { cx: 13, cy: 37, rx: 4.5, ry: 2.5, fill: "#ff9bb6" }, cheeks); svg("ellipse", { cx: 43, cy: 37, rx: 4.5, ry: 2.5, fill: "#ff9bb6" }, cheeks);
    var eyes = svg("g", { stroke: "white", "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round", fill: "none" }, body);
    var lEye = svg("path", {}, eyes), rEye = svg("path", {}, eyes), glints = svg("g", { fill: "#fffdf8" }, body);
    var lGlint = svg("circle", { cx: 19.2, cy: 26.1, r: .85 }, glints), rGlint = svg("circle", { cx: 35.2, cy: 26.1, r: .85 }, glints);
    var mouth = svg("path", { transform: "translate(23 37)", stroke: "white", "stroke-width": 1.8, "stroke-linecap": "round", fill: "none" }, body);
    var keyboard = svg("g", { "data-part": "keyboard" }, figure);
    svg("rect", { x: -5, y: 53, width: 66, height: 13, rx: 4, fill: "#d7d9e9", stroke: "#8e90a5", "stroke-width": 1.1 }, keyboard);
    svg("rect", { x: -5, y: 51, width: 66, height: 12, rx: 4, fill: "#f9f8ff", stroke: "#8e90a5", "stroke-width": 1.1 }, keyboard);
    var keyGroups = [svg("g", { "data-part": "left-keys" }, keyboard), svg("g", { "data-part": "right-keys" }, keyboard)], keyLights = [];
    keyGroups.forEach(function (group, side) {
      var glow = svg("rect", { x: side ? 30 : -1, y: 52.5, width: 27, height: 8, rx: 2, fill: "#b8b9f2", opacity: 0 }, group); keyLights.push(glow);
      for (var i = 0; i < 3; i++) svg("rect", { x: (side ? 31 : 0) + i * 9, y: 53, width: 7, height: 3.5, rx: 1, fill: "#fffefd", stroke: "#b1adc5", "stroke-width": .65 }, group);
    });
    svg("rect", { x: 14, y: 58.3, width: 28, height: 2.8, rx: 1, fill: "#e4dff5" }, keyboard);
    var hits = [svg("path", { d: "M-4 44L-7 40 M1 41V36 M6 42L8 38", "data-part": "left-impact" }, keyboard), svg("path", { d: "M50 42L48 38 M55 41V36 M60 44L63 40", "data-part": "right-impact" }, keyboard)];
    hits.forEach(function (h) { h.setAttribute("stroke", "#a8a0d5"); h.setAttribute("stroke-width", 1.5); h.setAttribute("stroke-linecap", "round"); h.setAttribute("opacity", 0); });
    var lArm = svg("g", {}, figure), rArm = svg("g", {}, figure);
    lArm.setAttribute("data-part", "left-hand"); rArm.setAttribute("data-part", "right-hand");
    var leftHand = svg("ellipse", {}, lArm), rightHand = svg("ellipse", {}, rArm);
    var pawLines = [svg("path", { fill: "none", stroke: outline, "stroke-width": .7, opacity: .45 }, lArm), svg("path", { fill: "none", stroke: outline, "stroke-width": .7, opacity: .45 }, rArm)];
    var outfit = svg("g", {}, body), gearKey = "";
    var portraitRig = svg("g", { "data-part": "portrait-rig" }, root);
    var portraitPrev = svg("svg", { x: -10, y: -8, width: 80, height: 80, overflow: "hidden", opacity: 0 }, portraitRig);
    portraitPrev.style.width = "80px"; portraitPrev.style.height = "80px"; portraitPrev.style.overflow = "hidden";
    var previousImage = svg("image", { preserveAspectRatio: "none" }, portraitPrev);
    var portrait = svg("svg", { x: -10, y: -8, width: 80, height: 80, viewBox: "0 0 512 512", preserveAspectRatio: "xMidYMid meet", overflow: "hidden", "data-part": "portrait", display: "none" }, portraitRig);
    // Square viewport clips the square atlas cell; letterboxing would expose neighboring cells.
    portrait.style.width = "80px"; portrait.style.height = "80px"; portrait.style.overflow = "hidden";
    var portraitImage = svg("image", { width: 1536, height: 1024, preserveAspectRatio: "none" }, portrait);
    var blinkPatch = svg("svg", { overflow: "hidden", opacity: 0, "data-part": "eyelids", preserveAspectRatio: "none" }, portraitRig);
    blinkPatch.style.overflow = "hidden";
    var blinkImage = svg("image", { preserveAspectRatio: "none" }, blinkPatch);
    var fingers = [0,1].map(function(i){var n=svg('svg',{overflow:'hidden',opacity:0,'data-part':i?'right-fingers':'left-fingers',preserveAspectRatio:'none'},portraitRig);n.style.overflow='hidden';return {node:n,image:svg('image',{preserveAspectRatio:'none'},n)};});
    var keycaps = [0,1].map(function(i){return svg('rect',{'data-part':i?'right-keycap':'left-keycap',rx:.3,fill:'#8eacc6',opacity:0},portraitRig)});
    var contactFx = svg("path", { d: "M-5 -1l-2 -3 M0 -3v-3 M5 -1l2 -3", stroke: "#b3b9df", "stroke-width": 1.2, "stroke-linecap": "round", fill: "none", opacity: 0, "data-part": "typing-contact" }, portraitRig);
    function motionContext() {
      return { posture: posture, activity: environment.held ? "held" : environment.falling ? "fall" : options.focused ? "focus" : options.resting ? "rest" : mood,
        edge: environment.edge || "none", hover: environment.hover, velocity: environment.velocity || 0, reduced: options.reduced, hidden: options.suspended || document.hidden, quiet: options.quiet, gesture: active && active.g.id };
    }
    function ambientAllowed() { return (motion || lineArt) && !disposed && !document.hidden && !options.suspended && !options.reduced && !options.quiet && !options.focused && !options.resting && ["waiting", "alert", "paused"].indexOf(mood) < 0; }
    function setPortrait(sheet, index, t, duration) {
      var a = sheet === "base" ? atlas : motionArt[sheet], cell = a.width / a.columns;
      var box = (index % 3) * cell + " " + Math.floor(index / 3) * cell + " " + cell + " " + cell, key = a.file + ":" + index;
      if (key !== portraitKey) {
        ["href", "width", "height"].forEach(function (k) { previousImage.setAttribute(k, portraitImage.getAttribute(k) || ""); });
        portraitPrev.setAttribute("viewBox", portrait.getAttribute("viewBox"));
        blendAt = portraitKey && !options.reduced ? t : -1; blendMs = duration;
        portraitImage.setAttribute("href", "/dsh-plugin-dot/pets/" + a.file); portraitImage.setAttribute("width", a.width); portraitImage.setAttribute("height", a.height);
        portrait.setAttribute("viewBox", box); portraitKey = key;
      }
      var alpha = blendAt < 0 ? 1 : Math.min(1, (t - blendAt) / blendMs);
      portrait.setAttribute("opacity", alpha); portraitPrev.setAttribute("opacity", alpha < 1 ? 1 : 0);
      portrait.setAttribute("data-frame", index); portrait.setAttribute("data-sheet", sheet);
    }
    function drawMotion(t) {
      var s = motion.sample(t, motionContext()); lastMotion = s;
      setPortrait(s.sheet, s.index, t, s.typing ? 32 : 95);
      portrait.setAttribute("data-state", s.pose);
      var micro=motionArt.style==='seated-v2';
      var seat = s.pose === 'edge' && micro ? motionArt.peekScale : s.pose === "sit" ? (environment.seatScale || 1) : 1;
      var edgeShift = s.pose === "edge" ? -s.mirror * 80 * (micro ? motionArt.edgeX*seat+(1-seat)*.5+(1-s.reveal)*.18 : (motionArt.edgeX || .27)) : 0;
      portraitRig.setAttribute("transform", "translate(" + (30 + s.x + edgeShift) + " " + (72 + s.y) + ") rotate(" + s.tilt + ") scale(" + (s.sx * s.mirror * seat) + " " + (s.sy * seat) + ") translate(-30 -72)");
      var pose = s.pose === "typing" ? "desk" : s.pose, b = motionArt.blink && motionArt.blink[pose];
      blinkPatch.setAttribute("opacity", b ? s.blink : 0);
      if (b) {
        var a = b.sheet === "base" ? atlas : motionArt[b.sheet], src = b.source, dst = b.target, cell = a.width / 3;
        blinkPatch.setAttribute("x", -10 + dst[0] * 80 / 512); blinkPatch.setAttribute("y", -8 + dst[1] * 80 / 512);
        blinkPatch.setAttribute("width", dst[2] * 80 / 512); blinkPatch.setAttribute("height", dst[3] * 80 / 512);
        blinkPatch.style.width = dst[2] * 80 / 512 + "px"; blinkPatch.style.height = dst[3] * 80 / 512 + "px";
        blinkPatch.setAttribute("viewBox", (b.frame % 3 * cell + src[0] * cell / 512) + " " + (Math.floor(b.frame / 3) * cell + src[1] * cell / 512) + " " + src[2] * cell / 512 + " " + src[3] * cell / 512);
        blinkImage.setAttribute("href", "/dsh-plugin-dot/pets/" + a.file); blinkImage.setAttribute("width", a.width); blinkImage.setAttribute("height", a.height);
      }
      fingers.forEach(function(p,i){
        var b=micro&&motionArt.fingers[i?'right':'left'],alpha=b&&s.typing&&s.hand===i?s.fingerLift:0;p.node.setAttribute('opacity',alpha);
        var k=keycaps[i];k.setAttribute('opacity',b&&b.keycap&&s.typing&&s.hand===i?s.contact*.75:0);if(b&&b.keycap){k.setAttribute('x',-10+b.keycap[0]*80/512);k.setAttribute('y',-8+b.keycap[1]*80/512);k.setAttribute('width',b.keycap[2]*80/512);k.setAttribute('height',b.keycap[3]*80/512)}
        if(!b)return;var a=motionArt[b.sheet],src=b.source,dst=b.target,cell=a.width/3;
        p.node.setAttribute('x',-10+dst[0]*80/512);p.node.setAttribute('y',-8+dst[1]*80/512);p.node.setAttribute('width',dst[2]*80/512);p.node.setAttribute('height',dst[3]*80/512);
        p.node.style.width=dst[2]*80/512+'px';p.node.style.height=dst[3]*80/512+'px';
        p.node.setAttribute('viewBox',(b.frame%3*cell+src[0]*cell/512)+' '+(Math.floor(b.frame/3)*cell+src[1]*cell/512)+' '+src[2]*cell/512+' '+src[3]*cell/512);
        p.image.setAttribute('href','/dsh-plugin-dot/pets/'+a.file);p.image.setAttribute('width',a.width);p.image.setAttribute('height',a.height);
      });
      contactFx.setAttribute("opacity", micro?0:s.contact * .85); contactFx.setAttribute("transform", "translate(" + (s.hand ? 41 : 19) + " 62)");
    }
    function portraitFrame(t) {
      if (!atlas) return;
      if (motion) { drawMotion(t); return; }
      var index = posture === "desk" ? 3 : 0;
      if (posture === "classic" && (options.resting || mood === "paused")) index = 2;
      if (active && posture === "classic") index = active.g.id === "wave" ? 1 : 2;
      var latest = Math.max(taps[0], taps[1]);
      if (posture === "desk" && latest && t - latest < 180) index = taps[0] >= taps[1] ? 4 : 5;
      var cell = atlas.width / atlas.columns;
      portrait.setAttribute("viewBox", (index % 3) * cell + " " + Math.floor(index / 3) * cell + " " + cell + " " + cell);
      portrait.setAttribute("data-frame", index);
    }
    var carry = svg("g", { "data-part": "carry", display: "none" }, root);
    var carryBox = svg("rect", { x: 44, y: 40, width: 22, height: 18, rx: 4, stroke: "white", "stroke-width": 1.2 }, carry);
    var carryText = svg("text", { x: 55, y: 52.5, "text-anchor": "middle", fill: "white", "font-size": 10, "font-weight": 600 }, carry);
    var fx = svg("g", {}, root);
    function face(eye, lips, blush) {
      function path(x, closed) { return closed ? "M" + x + " 28h6" : eye === "happy" ? "M" + (x - 1) + " 29q4-7 8 0" : eye === "half" ? "M" + (x + 3) + " 27v2" : "M" + (x + 3) + " 26v4"; }
      eyes.setAttribute("stroke-width", ["normal", "half", "wink"].indexOf(eye) >= 0 ? 4.4 : 2);
      lEye.setAttribute("d", path(17, eye === "line")); rEye.setAttribute("d", path(33, eye === "line" || eye === "wink"));
      glints.style.display = eye === "normal" || eye === "wink" ? "" : "none"; rGlint.style.display = eye === "wink" ? "none" : "";
      mouth.setAttribute("d", mouths[lips] || mouths.w); cheeks.setAttribute("opacity", blush ? ".7" : ".3");
    }
    function pose(p) {
      figure.setAttribute("transform", "translate(28 " + (60 + p.lift) + ") rotate(" + p.tilt + ") scale(" + p.sx + " " + p.sy + ") translate(-28 -60)");
      if (atlas && !motion) portrait.setAttribute("transform", "translate(28 " + (60 + p.lift * .3) + ") rotate(" + p.tilt * .18 + ") scale(" + (1 + (p.sx - 1) * .2) + " " + (1 + (p.sy - 1) * .2) + ") translate(-28 -60)");
      var desk = posture === "desk", x = desk ? .65 : 1, y = desk ? 1.25 : 1;
      lArm.setAttribute("transform", "translate(" + (p.lx * x) + " " + (p.ly * y) + ") rotate(" + p.la + (desk ? " 11 49)" : lineArt ? " 13 50)" : " 3 41)")); rArm.setAttribute("transform", "translate(" + (p.rx * x) + " " + (p.ry * y) + ") rotate(" + p.ra + (desk ? " 45 49)" : lineArt ? " 43 50)" : " 53 41)"));
    }
    function inputBody(press, tilt) { body.setAttribute("transform", "translate(28 " + (56 + press * 1.4) + ") rotate(" + tilt + ") scale(" + (1 + press * .025) + " " + ((posture === "desk" ? .94 : 1) - press * .035) + ") translate(-28 -56)"); }
    function resetInputArt() {
      inputBody(0, 0); keyGroups.forEach(function (g) { g.setAttribute("transform", "translate(0 0)"); });
      keyLights.concat(hits).forEach(function (n) { n.setAttribute("opacity", 0); });
    }
    function typingPose(t) {
      portraitFrame(t);
      var press = Object.assign({}, neutral), contact = 0, lean = 0;
      [0, 1].forEach(function (hand) {
        var s = taps[hand] ? stroke(t - taps[hand]) : { y: 0, press: 0, reach: 0 }, desk = posture === "desk";
        press[hand ? "ry" : "ly"] = desk ? s.y / 1.25 : ((lineArt?-1:8) + s.y) * s.reach;
        press[hand ? "rx" : "lx"] = desk ? 0 : (hand ? (lineArt?2:-8) : (lineArt?-2:8)) * s.reach;
        press[hand ? "ra" : "la"] = (hand ? 1 : -1) * Math.max(0, -s.y) * .9;
        keyGroups[hand].setAttribute("transform", "translate(0 " + s.press * 1.5 + ")");
        keyLights[hand].setAttribute("opacity", s.press * .9); hits[hand].setAttribute("opacity", s.press * .9);
        contact = Math.max(contact, s.press); lean += (hand ? 1 : -1) * s.press * 1.4;
      });
      pose(press); inputBody(contact, lean);
      [lArm, rArm].forEach(function (arm, hand) {
        var s = taps[hand] ? stroke(t - taps[hand]) : { press: 0 }, x = posture === "desk" ? (hand ? 45 : 11) : (lineArt ? (hand ? 43 : 13) : (hand ? 53 : 3)), y = posture === "desk" ? 49 : lineArt ? 50 : 41;
        arm.setAttribute("transform", arm.getAttribute("transform") + " translate(" + x + " " + y + ") scale(" + (1 + .22 * s.press) + " " + (1 - .22 * s.press) + ") translate(" + -x + " " + -y + ")");
      });
    }
    function lineIdle(t) {
      if(!lineArt||active||taps[0]||taps[1])return;
      var calm=!ambientAllowed(), held=environment.held, phase=(t-lineBorn)%5200, closed=!calm&&phase>=3500&&phase<3680;
      face(options.resting||mood==='paused'||closed?'line':mood==='done'?'happy':'normal',held?'o':options.focused||mood==='busy'?'flat':mood==='waiting'?'o':'w',false);
      var breath=calm?0:Math.sin((t-lineBorn)/1200)*.005;
      body.setAttribute('transform','translate(28 56) scale(1 '+((posture==='desk'?.94:1)+breath)+') translate(-28 -56)');
      root.setAttribute('data-state',held?'held':posture==='desk'?'desk':'sit');
      if(held){pose(Object.assign({},neutral,{tilt:calm?0:Math.max(-2,Math.min(2,environment.velocity||0))*.4,ly:3,ry:3}));keyboard.style.display='none';}else{pose(neutral);keyboard.style.display=posture==='desk'&&!options.resting?'':'none';}
    }
    function base() { face(options.resting || mood === "paused" ? "line" : mood === "done" ? "happy" : "normal", options.focused || mood === "busy" ? "flat" : mood === "waiting" ? "o" : "w", mood === "done"); portraitFrame(performance.now()); lineIdle(performance.now()); }
    function dress() {
      var name = options.focused ? "headphones" : options.outfit || "none";
      if (name === gearKey) return; gearKey = name; outfit.replaceChildren();
      var shapes = {
        scarf: [["M6 44 Q28 52 50 44L50 49Q28 57 6 49Z M36 48L41 60L35 59L32 50Z", "#e87777"]],
        leaf: [["M28 11Q22 0 31 -3Q36 5 28 11Z", "#4cc38a"]],
        cap: [["M9 18Q10 4 28 4Q46 4 47 18Z M28 18H56Q56 22 50 22L28 21Z", "#39465c"]],
        headphones: [["M5 30Q5 4 28 4Q51 4 51 30", "none", "#44506a", 3], ["M1 25Q1 23 5 23Q9 23 9 27V36Q5 42 1 36Z M47 27Q47 23 51 23Q55 23 55 27V36Q51 42 47 36Z", "#e6b865"]],
        bow: [["M40 12L32 6L33 17Z M40 12L48 6L47 17Z", "#ef8eb2"]],
        crown: [["M17 13L19 2L24 8L28 0L32 8L37 2L39 13Z", "#efc462"]]
      };
      (shapes[name] || []).forEach(function (p) { svg("path", { d: p[0], fill: p[1], stroke: p[2] || "none", "stroke-width": p[3] || 1, "stroke-linejoin": "round" }, outfit); });
    }
    function layout() {
      var desk = posture === "desk";
      root.setAttribute("data-posture", posture);
      shell.style.display = desk ? "none" : ""; deskBody.style.display = desk ? "" : "none"; feet.style.display = desk ? "none" : "";
      eyes.setAttribute("stroke", outline); mouth.setAttribute("stroke", outline); ahoge.setAttribute("stroke", outline);
      [leftHand, rightHand].forEach(function (hand, i) { var cx = desk ? (i ? 45 : 11) : lineArt ? (i ? 43 : 13) : (i ? 53 : 3), cy = desk ? 49 : lineArt ? 50 : 41; hand.setAttribute("cx", cx); hand.setAttribute("cy", cy); hand.setAttribute("rx", 7.2); hand.setAttribute("ry", desk ? 6 : 7); hand.setAttribute("fill", "url(#" + id + ")"); hand.setAttribute("stroke", outline); hand.setAttribute("stroke-width", 1.2); pawLines[i].setAttribute("d", "M" + (cx - 2) + " " + (cy + 3) + "v2 M" + (cx + 2) + " " + (cy + 3) + "v2"); });
      keyboard.style.display = (desk && !options.resting) || taps[0] || taps[1] ? "" : "none";
      shell.setAttribute('y',lineArt?12:10);shell.setAttribute('height',lineArt?43:47);shine.setAttribute('opacity',lineArt?0:1);shadow.setAttribute('opacity',lineArt?.35:1);
      [shell,deskBody,leftHand,rightHand].forEach(function(n){n.setAttribute('fill',lineArt?cream:'url(#'+id+')')});
      pose(neutral); resetInputArt(); dress();
    }
    function stop() { cancelAnimationFrame(frame); frame = 0; active = null; taps = [0, 0]; if (motion) motion.stop(performance.now()); pose(neutral); resetInputArt(); fx.replaceChildren(); base(); keyboard.style.display = posture === "desk" && !options.resting ? "" : "none"; }
    function schedule() { if (!frame) frame = requestAnimationFrame(tick); }
    function tick(t) {
      frame = 0;
      if (document.hidden) { stop(); return; }
      if (active && t >= active.start + active.duration) { active = null; pose(neutral); fx.replaceChildren(); base(); }
      for (var i = 0; i < 2; i++) if (taps[i] && t - taps[i] >= 280) taps[i] = 0;
      if (t - lastTick >= (motion ? (motion.busy() || active || environment.held || lastMotion && (lastMotion.blink > 0 || lastMotion.pose === "edge") || blendAt >= 0 && t - blendAt < blendMs ? 25 : 80) : active ? 32 : 16)) {
        lastTick = t;
        if (active) {
          var p = Math.min(1, (t - active.start) / active.duration), g = active.g;
          if (!active.reduced) pose(sample(g, p));
          face(g.revealAt && p >= g.revealAt ? "wink" : g.eyes, g.revealAt && p >= g.revealAt ? "smile" : g.mouth, g.cheeks);
          portraitFrame(t);
          fx.setAttribute("transform", "translate(0 " + (-p * 16) + ")"); fx.setAttribute("opacity", String(1 - p));
        } else {
          typingPose(t); lineIdle(t);
        }
      }
      if (active || taps[0] || taps[1] || ambientAllowed()) schedule(); else { pose(neutral); resetInputArt(); portraitFrame(t); keyboard.style.display = posture === "desk" && !options.resting ? "" : "none"; }
    }
    layout(); base();
    return {
      element: root,
      setArt: function (art) {
        if (art && art.renderer === "dot-atlas-v1" && art.atlas && /^[a-z][a-z0-9-]{0,60}\.png$/.test(art.atlas.file)) {
          var atlasKey = JSON.stringify(art); if (atlasKey === artKey) return; artKey = atlasKey; stop();
          lineArt=false;root.setAttribute('data-style','');
          atlas = art.atlas; root.setAttribute("data-renderer", art.renderer);
          motionArt = art.animations || null; motion = motionArt && window.__DotPetMotion ? window.__DotPetMotion.create(performance.now(), sequence % 5, motionArt.style) : null; portraitKey = "";
          figure.style.display = shadow.style.display = "none"; portrait.style.display = ""; portrait.setAttribute("display", "inline");
          portraitImage.setAttribute("href", "/dsh-plugin-dot/pets/" + atlas.file); portraitImage.setAttribute("width", atlas.width); portraitImage.setAttribute("height", atlas.height);
          portraitFrame(performance.now()); if (ambientAllowed()) schedule(); return;
        }
        lineArt=!!(art&&art.style==='soft-line-v2');root.setAttribute('data-style',lineArt?'soft-line-v2':'');keycaps.forEach(function(k){k.setAttribute('opacity',0)});
        atlas = null; motion = null; motionArt = null; fingers.forEach(function(p){p.node.setAttribute('opacity',0);});portraitRig.setAttribute('transform','');portraitPrev.setAttribute("opacity", 0); blinkPatch.setAttribute("opacity", 0); contactFx.setAttribute("opacity", 0); root.setAttribute("data-renderer", "dot-vector-v1"); portrait.style.display = "none"; figure.style.display = shadow.style.display = "";
        art = art && art.renderer === "dot-vector-v1" ? art : { radius: 17, ahoge: true, back: [], front: [] };
        var key = JSON.stringify(art); if (key === artKey) return; artKey = key; lineBorn=performance.now(); stop();
        shell.setAttribute("rx", Math.max(21, art.radius)); ahoge.style.display = art.ahoge ? "" : "none";
        [[back, art.back], [front, art.front]].forEach(function (item) { item[0].replaceChildren(); (item[1] || []).forEach(function (p) { svg("path", { d: p.d, fill: p.fill === "body" ? softBody : p.fill === "light" ? cream : paint(p.fill), stroke: p.stroke ? paint(p.stroke) : p.fill === "body" ? outline : "none", "stroke-width": p.width || 1.2, "stroke-linecap": "round", "stroke-linejoin": "round" }, item[0]); }); });
        layout();base();if(ambientAllowed())schedule();
      },
      setMood: function (next) { mood = next; if ((active && ["idle", "done"].indexOf(mood) < 0) || ["waiting", "alert", "paused"].indexOf(mood) >= 0) stop(); if (!active) base(); if (ambientAllowed()) schedule(); },
      setOptions: function (next) {
        var key = JSON.stringify(next || {}); if (key === optionsKey) { if (ambientAllowed()) schedule(); return; } optionsKey = key; options = next || {};
        var changed = posture !== (options.posture === "classic" ? "classic" : "desk"); posture = options.posture === "classic" ? "classic" : "desk";
        if (changed || options.reduced || options.focused || options.resting || options.suspended) stop();
        if (changed) layout(); else dress();
        if (!active && !taps[0] && !taps[1]) keyboard.style.display = posture === "desk" && !options.resting ? "" : "none";
        carry.style.display = options.carryCount ? "" : "none"; carryBox.setAttribute("fill", options.urgent ? "#d86b79" : options.delivery ? "#6698be" : "#c99550"); carryText.textContent = options.delivery ? "✉" : String(options.carryCount || "");
        base();
        if (ambientAllowed()) schedule();
      },
      setEnvironment: function (next) { environment = Object.assign({}, environment, next); portraitFrame(performance.now());lineIdle(performance.now()); if (ambientAllowed()) schedule(); },
      motionState: function () { return lastMotion; },
      tap: function () {
        var t = performance.now();
        if (motion) { if (!motion.pulse(t, motionContext())) return false; drawMotion(t); schedule(); return true; }
        if (active || options.reduced || options.focused || options.resting || options.suspended || options.quiet || environment.held || environment.falling || document.hidden || ["waiting", "alert", "paused"].indexOf(mood) >= 0 || t - lastTap < 65) return false;
        lastTap = t; side = 1 - side; taps[side] = t || .001; keyboard.style.display = ""; typingPose(t); schedule(); return true;
      },
      play: function (g, reduced) {
        if (!g || active) return false;
        if(motion)motion.touch(performance.now());
        taps = [0, 0]; pose(neutral); resetInputArt(); active = { g: g, start: performance.now(), duration: reduced ? 750 : g.duration, reduced: reduced }; lastTick = 0;
        if (!reduced && g.particle !== "none") [0, 1, 2].forEach(function (i) { var text = svg("text", { x: i * 24, y: i % 2 ? -5 : 8, fill: g.particle === "heart" ? "#f278a3" : "#deb44e", "font-size": 12, "text-anchor": "middle" }, fx); text.textContent = { heart: "♥", star: "✦", note: "♪" }[g.particle]; });
        schedule(); return true;
      },
      stop: stop,
      dispose: function () { disposed = true; stop(); root.remove(); }
    };
  }
  window.__DotPetAvatar = { mount: mount, sample: sample };
})();
