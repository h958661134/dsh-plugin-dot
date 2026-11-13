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
  function mount(container) {
    var id = "dot-avatar-" + (++sequence), artKey = "", mood = "idle", frame = 0, active = null, lastTick = 0;
    var root = svg("svg", { viewBox: "-10 -22 80 94", width: 80, height: 94, "aria-hidden": "true", style: "overflow:visible;display:block;pointer-events:none" }, container);
    var defs = svg("defs", {}, root), gradient = svg("linearGradient", { id: id, x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
    svg("stop", { offset: 0, "stop-color": paint("light") }, gradient); svg("stop", { offset: 1, "stop-color": paint("body") }, gradient);
    svg("ellipse", { cx: 28, cy: 65, rx: 20, ry: 3, fill: "#17274b20" }, root);
    var body = svg("g", {}, root), back = svg("g", {}, body);
    svg("ellipse", { cx: 18, cy: 58, rx: 7, ry: 4, fill: paint("body") }, body); svg("ellipse", { cx: 38, cy: 58, rx: 7, ry: 4, fill: paint("body") }, body);
    var ahoge = svg("path", { d: "M28 12 C27 5 31 1 35 3", fill: "none", stroke: paint("body"), "stroke-width": 2.4, "stroke-linecap": "round" }, body);
    var shell = svg("rect", { x: 4, y: 10, width: 48, height: 46, rx: 17, fill: "url(#" + id + ")" }, body);
    svg("ellipse", { cx: 16, cy: 18, rx: 5, ry: 3, fill: "#ffffff55" }, body);
    var front = svg("g", {}, body), cheeks = svg("g", { opacity: 0 }, body);
    svg("ellipse", { cx: 13, cy: 37, rx: 4.5, ry: 2.5, fill: "#ff9bb6" }, cheeks); svg("ellipse", { cx: 43, cy: 37, rx: 4.5, ry: 2.5, fill: "#ff9bb6" }, cheeks);
    var eyes = svg("g", { stroke: "white", "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round", fill: "none" }, body);
    var lEye = svg("path", {}, eyes), rEye = svg("path", {}, eyes);
    var mouth = svg("path", { transform: "translate(23 37)", stroke: "white", "stroke-width": 1.8, "stroke-linecap": "round", fill: "none" }, body);
    var lArm = svg("g", {}, body), rArm = svg("g", {}, body);
    svg("ellipse", { cx: 4, cy: 40, rx: 4, ry: 7, fill: paint("body") }, lArm); svg("ellipse", { cx: 52, cy: 40, rx: 4, ry: 7, fill: paint("body") }, rArm);
    var fx = svg("g", {}, root);
    function face(eye, lips, blush) {
      function path(x, closed) { return closed ? "M" + x + " 28h6" : eye === "happy" ? "M" + (x - 1) + " 29l4-4 4 4" : eye === "half" ? "M" + (x + 3) + " 27v3" : "M" + (x + 3) + " 24v8"; }
      lEye.setAttribute("d", path(17, eye === "line")); rEye.setAttribute("d", path(33, eye === "line" || eye === "wink"));
      mouth.setAttribute("d", mouths[lips] || mouths.w); cheeks.setAttribute("opacity", blush ? ".8" : "0");
    }
    function pose(p) {
      body.setAttribute("transform", "translate(28 " + (60 + p.lift) + ") rotate(" + p.tilt + ") scale(" + p.sx + " " + p.sy + ") translate(-28 -60)");
      lArm.setAttribute("transform", "translate(" + p.lx + " " + p.ly + ") rotate(" + p.la + " 4 40)"); rArm.setAttribute("transform", "translate(" + p.rx + " " + p.ry + ") rotate(" + p.ra + " 52 40)");
    }
    function base() { face(mood === "done" ? "happy" : mood === "paused" ? "line" : "normal", mood === "busy" ? "flat" : mood === "waiting" ? "o" : "w", mood === "done"); }
    function stop() { cancelAnimationFrame(frame); frame = 0; active = null; pose(neutral); fx.replaceChildren(); base(); }
    function tick(t) {
      if (!active) return;
      if (document.hidden) { stop(); return; }
      var p = Math.min(1, (t - active.start) / active.duration), g = active.g;
      if (p >= 1) { stop(); return; }
      if (t - lastTick >= 32) {
        lastTick = t;
        if (!active.reduced) pose(sample(g, p));
        face(g.revealAt && p >= g.revealAt ? "wink" : g.eyes, g.revealAt && p >= g.revealAt ? "smile" : g.mouth, g.cheeks);
        fx.setAttribute("transform", "translate(0 " + (-p * 16) + ")"); fx.setAttribute("opacity", String(1 - p));
      }
      frame = requestAnimationFrame(tick);
    }
    base();
    return {
      element: root,
      setArt: function (art) {
        art = art && art.renderer === "dot-vector-v1" ? art : { radius: 17, ahoge: true, back: [], front: [] };
        var key = JSON.stringify(art); if (key === artKey) return; artKey = key; stop();
        shell.setAttribute("rx", art.radius); ahoge.style.display = art.ahoge ? "" : "none";
        [[back, art.back], [front, art.front]].forEach(function (item) { item[0].replaceChildren(); (item[1] || []).forEach(function (p) { svg("path", { d: p.d, fill: paint(p.fill), stroke: paint(p.stroke || "none"), "stroke-width": p.width || 1, "stroke-linecap": "round", "stroke-linejoin": "round" }, item[0]); }); });
      },
      setMood: function (next) { mood = next; if (active && ["idle", "done"].indexOf(mood) < 0) stop(); if (!active) base(); },
      play: function (g, reduced) {
        if (!g || active) return false;
        active = { g: g, start: performance.now(), duration: reduced ? 750 : g.duration, reduced: reduced }; lastTick = 0;
        if (!reduced && g.particle !== "none") [0, 1, 2].forEach(function (i) { var text = svg("text", { x: i * 24, y: i % 2 ? -5 : 8, fill: g.particle === "heart" ? "#f278a3" : "#deb44e", "font-size": 12, "text-anchor": "middle" }, fx); text.textContent = { heart: "♥", star: "✦", note: "♪" }[g.particle]; });
        frame = requestAnimationFrame(tick); return true;
      },
      stop: stop,
      dispose: function () { stop(); root.remove(); }
    };
  }
  window.__DotPetAvatar = { mount: mount, sample: sample };
})();
