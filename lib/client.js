// dsh-plugin-dot —— 浏览器端浮标（Dot 小精灵）。
//
// 由 lib/host.js 自托管在 /dsh-plugin-dot/client.js，并通过官方的 webserver/index-inject 事件注入页面。
// 纯 DOM 实现，不依赖 React；所有文字用 textContent 写入，不拼接 HTML。
//
// 小精灵只做两件事：状态通知 + 快捷操作。完整功能在 Dot 窗口（右侧栏）和会话总览（整页），
// 由 lib/bridge.js 注册，这里通过 window.__dshDotBridge 跳过去。
//   - 表情和气泡：按状态优先级挑一个
//   - 「需要你」通知卡（最多 3 张）：审批 / 提问 → 去处理；被盯着的会话结束 → 打开 / 知道了；
//     逾期或快到期的事 → 完成 / 推迟 30 分钟
//   - 一行快捷输入、暂停、两个入口
//   - 窗口不在前台时，新的「需要你」事件同时发系统通知
(function () {
	"use strict";

	var API = "/api/dsh-plugin-dot";
	var POS_KEY = "dsh-dot-pet-pos";
	var CSS_ID = "dsh-plugin-dot/pet.css";
	var MAX_CARDS = 3;
	var SOON_MS = 30 * 60000;

	var CSS = [
		".ddp-root{position:fixed;z-index:9998;display:flex;flex-direction:column;align-items:flex-end;gap:8px;font-family:inherit;user-select:none;pointer-events:none}",
		".ddp-root>*{pointer-events:auto}",
		// 气泡
		".ddp-bubble{max-width:240px;padding:7px 11px;border-radius:12px 12px 4px 12px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1f2329);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));box-shadow:0 6px 20px rgba(0,0,0,.14);font-size:12px;line-height:18px;opacity:0;transform:translateY(6px) scale(.97);transition:opacity .18s ease,transform .18s ease;pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
		".ddp-bubble.ddp-show{opacity:1;transform:none;pointer-events:auto;cursor:pointer}",
		// 小精灵本体
		".ddp-pet{position:relative;width:48px;height:48px;border-radius:50%;border:none;padding:0;cursor:grab;background:radial-gradient(circle at 32% 28%,var(--ddp-c1,#8aa2ff) 0%,var(--ddp-c2,#4d6bfe) 55%,var(--ddp-c3,#3450d8) 100%);box-shadow:0 6px 18px var(--ddp-glow,rgba(77,107,254,.45)),inset 0 -3px 6px rgba(0,0,0,.18);display:flex;align-items:center;justify-content:center;outline:none;transition:transform .15s ease}",
		".ddp-pet:hover{transform:scale(1.06)}",
		".ddp-pet:focus-visible{box-shadow:0 0 0 3px rgba(77,107,254,.45)}",
		".ddp-face{position:relative;width:26px;height:18px}",
		".ddp-eye{position:absolute;top:3px;width:6px;height:9px;border-radius:3px;background:#fff;transition:all .2s ease}",
		".ddp-eye.l{left:4px}.ddp-eye.r{right:4px}",
		".ddp-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 4px;border-radius:9px;font-size:11px;line-height:18px;font-weight:700;color:#fff;text-align:center;display:none;box-shadow:0 2px 6px rgba(0,0,0,.2)}",
		".ddp-idle .ddp-eye{height:2px;top:7px;border-radius:1px}",
		".ddp-idle .ddp-pet{animation:ddp-breathe 3.6s ease-in-out infinite}",
		".ddp-busy .ddp-eye{animation:ddp-look 1.6s ease-in-out infinite}",
		".ddp-busy .ddp-pet::after{content:'';position:absolute;inset:-4px;border-radius:50%;border:2px solid transparent;border-top-color:#4d6bfe;border-right-color:rgba(77,107,254,.4);animation:ddp-spin 1s linear infinite}",
		".ddp-waiting .ddp-eye{height:11px;top:2px}",
		".ddp-waiting .ddp-pet{animation:ddp-wiggle 1.2s ease-in-out infinite}",
		".ddp-waiting .ddp-badge{display:block;background:#ff9f0a}",
		".ddp-alert .ddp-badge{display:block;background:#ff453a}",
		".ddp-alert .ddp-pet{animation:ddp-shake 2.4s ease-in-out infinite}",
		".ddp-done .ddp-eye{background:transparent;border-top:3px solid #fff;border-radius:50% 50% 0 0;height:6px;top:5px;width:8px}",
		".ddp-done .ddp-eye.l{left:3px}.ddp-done .ddp-eye.r{right:3px}",
		".ddp-done .ddp-badge{display:block;background:#30d158}",
		".ddp-done .ddp-pet{animation:ddp-hop .6s ease 2}",
		".ddp-paused .ddp-pet{filter:grayscale(.75);opacity:.8}",
		".ddp-paused .ddp-eye{height:2px;top:7px;border-radius:1px}",
		".ddp-paused .ddp-badge{display:block;background:#8f959e}",
		".ddp-root.ddp-has-cards .ddp-badge{display:block}",
		"@keyframes ddp-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}",
		"@keyframes ddp-look{0%,100%{transform:translateX(0)}30%{transform:translateX(-2px)}70%{transform:translateX(2px)}}",
		"@keyframes ddp-spin{to{transform:rotate(360deg)}}",
		"@keyframes ddp-wiggle{0%,100%{transform:rotate(0)}25%{transform:rotate(-8deg)}75%{transform:rotate(8deg)}}",
		"@keyframes ddp-shake{0%,86%,100%{transform:translateX(0)}88%,92%,96%{transform:translateX(-3px)}90%,94%,98%{transform:translateX(3px)}}",
		"@keyframes ddp-hop{0%,100%{transform:translateY(0)}40%{transform:translateY(-8px)}}",
		// 弹窗
		".ddp-panel{width:320px;display:none;flex-direction:column;border-radius:16px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#fff) 94%,transparent);-webkit-backdrop-filter:blur(18px) saturate(1.4);backdrop-filter:blur(18px) saturate(1.4);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));box-shadow:0 4px 12px rgba(0,0,0,.10),0 20px 48px rgba(0,0,0,.22);color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:20px;overflow:hidden;user-select:text;animation:ddp-pop .16s ease-out;transform-origin:bottom right}",
		".ddp-panel.ddp-open{display:flex}",
		"@keyframes ddp-pop{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:none}}",
		".ddp-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px 4px}",
		".ddp-title{font-weight:600;font-size:14px}",
		".ddp-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#646a73);padding:0 14px 8px}",
		".ddp-headr{display:flex;align-items:center;gap:4px}",
		".ddp-x{border:none;background:none;cursor:pointer;color:var(--dsw-alias-label-secondary,#646a73);font-size:16px;line-height:16px;padding:4px;border-radius:6px}",
		".ddp-x:hover{background:var(--dsw-alias-fill-l1,rgba(0,0,0,.05))}",
		".ddp-pbtn{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:none;color:var(--dsw-alias-label-secondary,#646a73);border-radius:999px;padding:1px 9px;font-size:11px;line-height:18px;cursor:pointer}",
		".ddp-pbtn:hover{border-color:#4d6bfe;color:#4d6bfe}",
		// 通知卡
		".ddp-cards{display:flex;flex-direction:column;gap:6px;padding:0 10px}",
		".ddp-card{border-radius:10px;padding:8px 10px;font-size:12px;line-height:18px;border:1px solid transparent}",
		".ddp-card.approval,.ddp-card.question{background:rgba(255,159,10,.10);border-color:rgba(255,159,10,.3)}",
		".ddp-card.done{background:rgba(48,209,88,.10);border-color:rgba(48,209,88,.3)}",
		".ddp-card.failed,.ddp-card.overdue{background:rgba(255,69,58,.08);border-color:rgba(255,69,58,.25)}",
		".ddp-card.suggestions{background:rgba(77,107,254,.06);border-color:rgba(77,107,254,.25)}",
		".ddp-card.handoff{background:rgba(77,107,254,.10);border-color:rgba(77,107,254,.35)}",
		".ddp-card.soon{background:rgba(77,107,254,.08);border-color:rgba(77,107,254,.25)}",
		".ddp-card-t{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
		".ddp-card-b{color:var(--dsw-alias-label-secondary,#646a73);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}",
		".ddp-card-a{display:flex;gap:6px;margin-top:6px}",
		".ddp-cbtn{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;border-radius:8px;padding:1px 10px;font-size:12px;line-height:20px;cursor:pointer}",
		".ddp-cbtn:hover{border-color:#4d6bfe;color:#4d6bfe}",
		".ddp-cbtn.main{background:#4d6bfe;border-color:#4d6bfe;color:#fff}",
		".ddp-cbtn.main:hover{color:#fff;opacity:.9}",
		".ddp-more{font-size:12px;color:var(--dsw-alias-label-secondary,#646a73);padding:0 4px}",
		".ddp-calm{padding:4px 14px 2px;font-size:12px;color:var(--dsw-alias-label-secondary,#646a73)}",
		// 快捷操作
		".ddp-quick{display:flex;flex-wrap:wrap;gap:6px;padding:10px 14px 0}",
		".ddp-chip{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;border-radius:999px;padding:3px 10px;font-size:12px;line-height:18px;cursor:pointer}",
		".ddp-chip:hover{border-color:#4d6bfe;color:#4d6bfe}",
		".ddp-out{margin:8px 14px 0;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-fill-l1,rgba(0,0,0,.04));font-size:12px;line-height:18px;white-space:pre-wrap;max-height:160px;overflow:auto;display:none}",
		".ddp-out.ddp-err{color:#ff453a}",
		".ddp-form{display:flex;gap:6px;padding:10px 14px 8px}",
		".ddp-in{flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;border-radius:10px;padding:6px 10px;font-size:13px;outline:none}",
		".ddp-in:focus{border-color:#4d6bfe}",
		".ddp-send{border:none;background:#4d6bfe;color:#fff;border-radius:10px;padding:0 12px;cursor:pointer;font-size:13px}",
		".ddp-send:disabled{opacity:.5;cursor:default}",
		".ddp-hint{padding:0 14px 4px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8f959e)}",
		".ddp-foot{display:flex;gap:6px;padding:0 14px 12px}",
		".ddp-foot .ddp-cbtn{flex:1}",
	].join("\n");

	var QUICK = [
		{ label: "记一件事", fill: "/task " },
		{ label: "设个提醒", fill: "/remind " },
		{ label: "今日简报", say: "/brief" },
		{ label: "能做什么", say: "/dot" },
	];

	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	}

	function fmtDue(iso) {
		var d = new Date(iso);
		var now = new Date();
		var hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
		if (d.toDateString() === now.toDateString()) return "今天 " + hm;
		if (new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toDateString() === d.toDateString()) return "明天 " + hm;
		return (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
	}

	function post(path, body) {
		return fetch(API + path, {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json", "x-dot-client": "1" },
			body: JSON.stringify(body),
		}).then(function (r) { return r.json(); });
	}

	function bridge() { return window.__dshDotBridge || null; }

	/** Dot 会话 id：正在跑的在前，其次会话记录里的（DSH 重启后还没加载的也算）。 */
	function dotIds(s) {
		var ids = s.sessions.filter(function (x) { return x.status === "running"; }).concat(s.sessions).map(function (x) { return x.id; });
		return ids.concat(s.dotSessions || []).filter(function (x, i, a) { return a.indexOf(x) === i; });
	}

	/**
	 * 从状态里挑出「需要你」的卡片，按紧急程度排序。
	 * 每张卡：{ key, kind, title, body, actions: [{ label, main?, run }] }，run 由调用方填入具体动作。
	 */
	/** 小精灵配色：高光、主色、暗部、投影。 */
	var PALETTE = {
		blue: ["#8aa2ff", "#4d6bfe", "#3450d8", "rgba(77,107,254,.45)"],
		green: ["#7fe0a8", "#2fb36d", "#1f8a52", "rgba(47,179,109,.40)"],
		orange: ["#ffc27a", "#ff8a3d", "#e0651c", "rgba(255,138,61,.42)"],
		purple: ["#c4a5ff", "#8a5cf6", "#6a3bd8", "rgba(138,92,246,.42)"],
		pink: ["#ffa8c8", "#f2558f", "#d03570", "rgba(242,85,143,.40)"],
		gray: ["#c9ccd3", "#8a8f99", "#666b75", "rgba(100,106,115,.35)"],
	};

	function buildCards(s, now) {
		var cards = [];
		s.decisions.forEach(function (d, i) {
			cards.push({
				key: "d:" + d.label + ":" + d.reason + ":" + i, kind: d.kind === "question" ? "question" : "approval", event: "decision",
				title: d.label + (d.kind === "question" ? " 在问你" : " 需要你批准"), body: d.reason,
				open: d.open, notify: true,
			});
		});
		(s.notices || []).forEach(function (n) {
			cards.push({
				key: "n:" + n.id, kind: n.kind, id: n.id, event: n.kind === "handoff" ? "handoff" : "watched",
				title: n.kind === "handoff" ? n.title + " 把一件事交给你亲自做" : "「" + n.title + "」" + (n.kind === "failed" ? "出错了" : "跑完了"), body: n.text,
				open: n.open, notify: true,
			});
		});
		s.tasks.forEach(function (t) {
			if (!t.due) return;
			var left = new Date(t.due).getTime() - now;
			if (t.overdue || left <= 0) {
				cards.push({ key: "o:" + t.id + ":" + t.due, kind: "overdue", event: "due", task: t, title: "「" + t.title + "」已逾期", body: "截止 " + fmtDue(t.due), notify: true });
			} else if (left <= SOON_MS) {
				cards.push({ key: "s:" + t.id + ":" + t.due, kind: "soon", event: "due", task: t, title: "「" + t.title + "」快到了", body: "还有 " + Math.max(1, Math.round(left / 60000)) + " 分钟", notify: false });
			}
		});
		// 建议不在小精灵里逐条处理，只放一张汇总卡，点了去 Dot 窗口「今天」页
		var sugs = s.suggestions || [];
		if (sugs.length) {
			cards.push({
				key: "g:" + sugs.map(function (g) { return g.id; }).join(","), kind: "suggestions",
				title: sugs.length === 1 ? "Dot 有一个建议" : "Dot 有 " + sugs.length + " 个建议",
				body: sugs[0].title + (sugs.length > 1 ? " 等" : ""), notify: false,
			});
		}
		// 按通知路由开关过滤：关掉通知卡的不显示，关掉系统通知的不弹
		var routes = s.routes || {};
		cards.forEach(function (c) {
			var r = routes[c.event];
			if (r && r.system === false) c.notify = false;
		});
		return cards.filter(function (c) { var r = routes[c.event]; return !r || r.card !== false || c.notify; })
			.map(function (c) { var r = routes[c.event]; c.hidden = Boolean(r && r.card === false); return c; });
	}

	function mount() {
		if (typeof document === "undefined" || document.getElementById("dsh-dot-pet")) return function () {};

		if (!document.querySelector('style[data-plugin-css="' + CSS_ID + '"]')) {
			var style = document.createElement("style");
			style.dataset.plugin = "dsh-plugin-dot";
			style.dataset.pluginCss = CSS_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		var root = el("div", "ddp-root ddp-idle");
		root.id = "dsh-dot-pet";
		var panel = el("div", "ddp-panel");
		var bubble = el("div", "ddp-bubble");
		var pet = el("button", "ddp-pet");
		pet.type = "button";
		pet.setAttribute("aria-label", "Dot 小精灵：点击打开");
		var face = el("span", "ddp-face");
		face.appendChild(el("span", "ddp-eye l"));
		face.appendChild(el("span", "ddp-eye r"));
		var badge = el("span", "ddp-badge");
		pet.appendChild(face);
		pet.appendChild(badge);

		var head = el("div", "ddp-head");
		var titleEl = el("span", "ddp-title", "Dot");
		head.appendChild(titleEl);
		var headR = el("span", "ddp-headr");
		var pauseBtn = el("button", "ddp-pbtn", "暂停");
		pauseBtn.type = "button";
		var close = el("button", "ddp-x", "×");
		close.type = "button";
		close.setAttribute("aria-label", "关闭");
		headR.appendChild(pauseBtn);
		headR.appendChild(close);
		head.appendChild(headR);
		var sub = el("div", "ddp-sub", "");
		var cardsBox = el("div", "ddp-cards");
		var quick = el("div", "ddp-quick");
		var out = el("div", "ddp-out");
		var form = el("form", "ddp-form");
		var input = el("input", "ddp-in");
		input.placeholder = "跟 Dot 说一句，或输入 /task …";
		input.setAttribute("aria-label", "跟 Dot 说一句");
		var sendBtn = el("button", "ddp-send", "发送");
		sendBtn.type = "submit";
		form.appendChild(input);
		form.appendChild(sendBtn);
		var hint = el("div", "ddp-hint", "");
		var foot = el("div", "ddp-foot");
		var dotBtn = el("button", "ddp-cbtn", "打开 Dot");
		dotBtn.type = "button";
		dotBtn.title = "Dot 对话 + 右侧栏的事务、排程、记忆、规则";
		var sessBtn = el("button", "ddp-cbtn", "会话总览");
		sessBtn.type = "button";
		sessBtn.title = "其他会话各自在干什么";
		foot.appendChild(dotBtn);
		foot.appendChild(sessBtn);
		QUICK.forEach(function (q) {
			var b = el("button", "ddp-chip", q.label);
			b.type = "button";
			b.addEventListener("click", function () {
				if (q.say) return say(q.say);
				input.value = q.fill;
				input.focus();
			});
			quick.appendChild(b);
		});
		panel.appendChild(head);
		panel.appendChild(sub);
		panel.appendChild(cardsBox);
		panel.appendChild(quick);
		panel.appendChild(out);
		panel.appendChild(form);
		panel.appendChild(hint);
		panel.appendChild(foot);

		root.appendChild(panel);
		root.appendChild(bubble);
		root.appendChild(pet);
		document.body.appendChild(root);

		// 位置（可拖动，记住位置）
		var pos = { right: 24, bottom: 112 };
		try { var saved = JSON.parse(localStorage.getItem(POS_KEY) || "null"); if (saved && saved.right >= 0 && saved.bottom >= 0) pos = saved; } catch (e) { /* 忽略 */ }
		function place() {
			pos.right = Math.min(Math.max(pos.right, 4), window.innerWidth - 56);
			pos.bottom = Math.min(Math.max(pos.bottom, 4), window.innerHeight - 56);
			root.style.right = pos.right + "px";
			root.style.bottom = pos.bottom + "px";
		}
		place();

		var drag = null;
		pet.addEventListener("pointerdown", function (e) {
			if (e.button !== 0) return;
			drag = { x: e.clientX, y: e.clientY, right: pos.right, bottom: pos.bottom, moved: false };
			try { pet.setPointerCapture(e.pointerId); } catch (err) { /* 没有活动指针（如程序触发的事件） */ }
		});
		pet.addEventListener("pointermove", function (e) {
			if (!drag) return;
			var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
			if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
			drag.moved = true;
			pos.right = drag.right - dx;
			pos.bottom = drag.bottom - dy;
			place();
		});
		pet.addEventListener("pointerup", function () {
			if (!drag) return;
			var moved = drag.moved;
			drag = null;
			if (moved) { try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch (e) { /* 忽略 */ } return; }
			toggle();
		});
		pet.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
		window.addEventListener("resize", place);

		// ── 名字和颜色（在 Dot 窗口「规则」页里改） ──────────────
		var petName = "Dot";
		var lookKey = "";
		function applyLook(look) {
			var name = look && look.name ? look.name : "Dot";
			var c = (look && PALETTE[look.color]) || PALETTE.blue;
			var key = name + "|" + c.join(",");
			if (key === lookKey) return;
			lookKey = key;
			petName = name;
			titleEl.textContent = name;
			root.style.setProperty("--ddp-c1", c[0]);
			root.style.setProperty("--ddp-c2", c[1]);
			root.style.setProperty("--ddp-c3", c[2]);
			root.style.setProperty("--ddp-glow", c[3]);
		}
		function toggle(force) {
			var open = force != null ? force : !panel.classList.contains("ddp-open");
			panel.classList.toggle("ddp-open", open);
			if (open) {
				hideBubble();
				askNotifyPermission();
				refresh();
				setTimeout(function () { input.focus(); }, 0);
			}
		}
		close.addEventListener("click", function () { toggle(false); pet.focus(); });
		bubble.addEventListener("click", function () { toggle(true); });
		document.addEventListener("keydown", function (e) {
			if (e.key === "Escape" && panel.classList.contains("ddp-open")) { toggle(false); pet.focus(); }
			// Alt+Shift+D：在任何地方唤起小精灵的输入框（Alt+D 会被浏览器抢去聚焦地址栏）
			if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.code === "KeyD" || e.key === "D" || e.key === "d")) {
				e.preventDefault();
				toggle(!panel.classList.contains("ddp-open"));
			}
		});
		document.addEventListener("pointerdown", function (e) {
			if (panel.classList.contains("ddp-open") && !root.contains(e.target)) toggle(false);
		});

		function showOut(text, isErr) {
			out.textContent = text;
			out.style.display = text ? "block" : "none";
			out.classList.toggle("ddp-err", !!isErr);
		}
		function say(text) {
			text = String(text || "").trim();
			if (!text) return;
			sendBtn.disabled = true;
			showOut("…");
			post("/say", { text: text }).then(function (r) {
				showOut(r.text || "", !r.ok);
				if (r.ok && text === input.value.trim()) input.value = "";
				refresh();
			}).catch(function () {
				showOut("发送失败，请稍后再试", true);
			}).then(function () { sendBtn.disabled = false; });
		}
		form.addEventListener("submit", function (e) { e.preventDefault(); say(input.value); });
		pauseBtn.addEventListener("click", function () { say(lastState && lastState.paused ? "/resume" : "/pause"); });

		function act(path, body) {
			return post(path, body).then(function (r) { if (r.text) showOut(r.text, !r.ok); forceCards = true; refresh(); })
				.catch(function () { showOut("操作失败，请稍后再试", true); });
		}

		// ── 桌面精灵点了「打开」：它先把 DSH 拉到前台，这里接着跳到对应位置并回执 ──
		var handledFocus = null;
		function runFocus(s, direct) {
			var f = direct || s.focus;
			if (!f || f.id === handledFocus) return;
			var b = bridge();
			if (!b) return; // bridge 还没加载：下次轮询再试
			handledFocus = f.id;
			try {
				if (f.open) b.openSession(f.open);
				else if (f.nav === "sessions") b.openSessions();
				else if (f.nav === "dot") { var id = f.dot || (s ? dotIds(s)[0] : null); if (id) b.openDot(id); }
			} catch (e) { /* 跳不过去就停在当前页 */ }
			post("/focus", { ack: f.id }).catch(function () {});
		}

		// ── 跳转（经 bridge.js；bridge 不在时退回提示）────────────
		function openTarget(target) {
			var b = bridge();
			if (!target || !b) return false;
			try { b.openSession(target); toggle(false); return true; } catch (e) { showOut("打不开这个会话：" + (e && e.message ? e.message : e), true); return false; }
		}
		dotBtn.addEventListener("click", function () {
			var b = bridge();
			var id = lastState ? dotIds(lastState)[0] || null : null;
			if (!b) return showOut("Dot 窗口还没加载好，刷新页面试试", true);
			if (!id) return showOut("先在 DSH 里新建一个「Dot 总管」会话", true);
			b.openDot(id);
			toggle(false);
		});
		sessBtn.addEventListener("click", function () {
			var b = bridge();
			if (!b) return showOut("会话总览还没加载好，刷新页面试试", true);
			b.openSessions();
			toggle(false);
		});

		// ── 气泡 ──────────────────────────────────────────────
		var lastBubble = "";
		var bubbleTimer = null;
		function hideBubble() { bubble.classList.remove("ddp-show"); }
		function showBubble(text, sticky) {
			bubble.textContent = text;
			bubble.classList.add("ddp-show");
			clearTimeout(bubbleTimer);
			if (!sticky) bubbleTimer = setTimeout(hideBubble, 8000);
		}
		pet.addEventListener("mouseenter", function () { if (lastBubble && !panel.classList.contains("ddp-open")) showBubble(lastBubble, false); });

		// ── 系统通知：窗口不在前台时，新的「需要你」事件弹出来 ──────
		var seen = null; // 第一次拿到状态时记下已有的，不为旧事补发
		function askNotifyPermission() {
			try { if (window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch (e) { /* 不支持 */ }
		}
		function systemNotify(cards) {
			var fresh = cards.filter(function (c) { return c.notify && !seen.has(c.key); });
			cards.forEach(function (c) { seen.add(c.key); });
			if (!fresh.length || (!document.hidden && document.hasFocus())) return;
			if (!window.Notification || Notification.permission !== "granted") return;
			fresh.slice(0, 3).forEach(function (c) {
				try {
					var n = new Notification(petName + "：" + c.title, { body: c.body || "", tag: "dsh-dot-" + c.key, silent: false });
					n.onclick = function () { window.focus(); if (c.open) openTarget(c.open); else toggle(true); n.close(); };
				} catch (e) { /* 忽略 */ }
			});
		}

		// ── 通知卡 ────────────────────────────────────────────
		function cardButton(text, main, onClick) {
			var b = el("button", "ddp-cbtn" + (main ? " main" : ""), text);
			b.type = "button";
			b.addEventListener("click", function (e) { e.stopPropagation(); onClick(); });
			return b;
		}
		function renderCard(c) {
			var box = el("div", "ddp-card " + c.kind);
			var t = el("div", "ddp-card-t", c.title);
			t.title = c.title;
			box.appendChild(t);
			if (c.body) { var b = el("div", "ddp-card-b", c.body); b.title = c.body; box.appendChild(b); }
			var a = el("div", "ddp-card-a");
			if (c.kind === "approval" || c.kind === "question") {
				if (c.open) a.appendChild(cardButton(c.kind === "question" ? "去回答" : "去处理", true, function () { openTarget(c.open); }));
			} else if (c.kind === "handoff") {
				a.appendChild(cardButton("记为事务", true, function () { act("/notice", { id: c.id, action: "task" }); }));
				a.appendChild(cardButton("我做完了", false, function () { act("/notice", { id: c.id, action: "done" }); }));
				a.appendChild(cardButton("知道了", false, function () { act("/notice", { id: c.id }); }));
			} else if (c.kind === "done" || c.kind === "failed") {
				a.appendChild(cardButton("打开", true, function () { openTarget(c.open); act("/notice", { id: c.id }); }));
				a.appendChild(cardButton("知道了", false, function () { act("/notice", { id: c.id }); }));
			} else if (c.kind === "suggestions") {
				a.appendChild(cardButton("去看看", true, function () { dotBtn.click(); }));
			} else if (c.task) {
				a.appendChild(cardButton("完成", true, function () { act("/task", { id: c.task.id, action: "done" }); }));
				a.appendChild(cardButton("推迟 30 分钟", false, function () { act("/say", { text: "/due " + c.task.id + " 30分钟后" }); }));
			}
			if (a.childNodes.length) box.appendChild(a);
			return box;
		}

		// 卡片只在内容变了时重建；鼠标停在卡片上时先不动（重建会吞掉点击）
		var cardsKey = "";
		var hoverCards = false;
		var pendingCards = null;
		var forceCards = false;
		cardsBox.addEventListener("mouseenter", function () { hoverCards = true; });
		cardsBox.addEventListener("mouseleave", function () {
			hoverCards = false;
			if (pendingCards) { var p = pendingCards; pendingCards = null; renderCards(p, false); }
		});
		function renderCards(cards, force) {
			if (forceCards) { force = true; forceCards = false; }
			var key = cards.map(function (c) { return c.key + "|" + c.body; }).join("\n");
			if (!force && key === cardsKey) return;
			if (!force && hoverCards) { pendingCards = cards; return; }
			cardsKey = key;
			cardsBox.textContent = "";
			if (!cards.length) {
				cardsBox.appendChild(el("div", "ddp-calm", "没有要你处理的事。"));
				return;
			}
			cards.slice(0, MAX_CARDS).forEach(function (c) { cardsBox.appendChild(renderCard(c)); });
			if (cards.length > MAX_CARDS) {
				var more = el("button", "ddp-cbtn", "还有 " + (cards.length - MAX_CARDS) + " 件，去 Dot 窗口看");
				more.type = "button";
				more.addEventListener("click", function () { dotBtn.click(); });
				cardsBox.appendChild(more);
			}
		}

		// ── 状态渲染 ──────────────────────────────────────────
		var BADGE = { waiting: "!", done: "✓", paused: "z" };
		var lastState = null;

		function render(s) {
			lastState = s;
			var b = bridge();
			if (b && b.noteDotSessions) b.noteDotSessions(dotIds(s));
			if (b && b.noteStatus) b.noteStatus({ watchedIds: s.watchedIds || [], petName: (s.pet && s.pet.name) || "Dot" });

			var all = buildCards(s, Date.now());
			if (seen === null) { seen = new Set(all.map(function (c) { return c.key; })); }
			else systemNotify(all);
			var cards = all.filter(function (c) { return !c.hidden; });

			root.className = "ddp-root ddp-" + s.mood + (cards.length ? " ddp-has-cards" : "");
			// 桌面精灵在跑时，页面里的小精灵让位（桌面精灵退出后自动回来）
			root.style.display = s.desktopPet ? "none" : "";
			if (s.focus && s.focus.id !== handledFocus) runFocus(s);
			var badgeText = BADGE[s.mood] || "";
			if (cards.length) badgeText = String(cards.length);
			badge.style.background = cards.some(function (c) { return c.kind === "approval" || c.kind === "question"; }) ? "#ff9f0a"
				: cards.some(function (c) { return c.kind === "failed" || c.kind === "overdue"; }) ? "#ff453a" : cards.length ? "#4d6bfe" : "";
			badge.textContent = badgeText;
			applyLook(s.pet);
			pet.setAttribute("aria-label", petName + "：" + (s.bubble || "休息中") + "。点击打开，或按 Alt+Shift+D");
			pauseBtn.textContent = s.paused ? "恢复" : "暂停";

			if (s.bubble !== lastBubble) {
				lastBubble = s.bubble;
				if (s.bubble && !panel.classList.contains("ddp-open")) showBubble(s.bubble, s.mood === "busy" || s.mood === "waiting");
				if (!s.bubble) hideBubble();
			}

			var c = s.counts;
			var parts = [];
			if (c.active) parts.push(c.active + " 件事在办");
			if (c.running) parts.push(c.running + " 个子任务在跑");
			if (c.others) parts.push(c.others + " 个其他会话在跑");
			sub.textContent = (s.paused ? "已暂停 · " : "") + (parts.join("，") || "一切安静") + (s.bubble && s.mood !== "idle" ? " — " + s.bubble : "");
			hint.textContent = s.hasDotSession ? "" : "提示：新建一个「Dot 总管」会话，Dot 就能接对话里的活";
			renderCards(cards, false);
		}

		// ── 轮询 ──────────────────────────────────────────────
		var timer = null;
		var stopped = false;
		var failures = 0;
		function refresh() {
			return fetch(API + "/status", { credentials: "same-origin" })
				.then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
				.then(function (s) { failures = 0; root.style.display = ""; render(s); })
				.catch(function () { failures++; if (failures >= 3) root.style.display = "none"; });
		}
		var inflight = false;
		function loop() {
			if (stopped || inflight) return;
			inflight = true;
			refresh().then(function () {
				inflight = false;
				if (stopped) return;
				var busy = root.classList.contains("ddp-busy") || root.classList.contains("ddp-waiting");
				// 窗口在后台也要继续拉（系统通知靠它），只是放慢
				var delay = document.hidden ? 10000 : busy ? 1500 : 3000;
				timer = setTimeout(loop, delay);
			});
		}
		loop();

		// 长轮询跳转目标：桌面精灵一点「打开」，这里马上跳（后台标签页的普通轮询会被浏览器放慢到十几秒）
		var waitCtl = null;
		var lastFocusId = 0;
		function waitFocus() {
			if (stopped) return;
			waitCtl = typeof AbortController === "function" ? new AbortController() : null;
			fetch(API + "/focus/wait?after=" + lastFocusId, { credentials: "same-origin", signal: waitCtl ? waitCtl.signal : undefined })
				.then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
				.then(function (r) {
					if (r && r.focus) { lastFocusId = r.focus.id; runFocus(lastState, r.focus); }
					setTimeout(waitFocus, 50);
				})
				.catch(function () { if (!stopped) setTimeout(waitFocus, 5000); });
		}
		waitFocus();
		// 窗口回到前台时立刻刷新一次，不等下一轮
		function wake() { if (!document.hidden) { clearTimeout(timer); loop(); } }
		document.addEventListener("visibilitychange", wake);
		window.addEventListener("focus", wake);

		return function dispose() {
			stopped = true;
			if (waitCtl) waitCtl.abort();
			document.removeEventListener("visibilitychange", wake);
			window.removeEventListener("focus", wake);
			clearTimeout(timer);
			clearTimeout(bubbleTimer);
			window.removeEventListener("resize", place);
			root.remove();
		};
	}

	// 通过 webserver/index-inject 的 script-src 行在 body 末尾加载，直接挂载即可。
	if (typeof document !== "undefined") {
		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
		else mount();
	}
})();
