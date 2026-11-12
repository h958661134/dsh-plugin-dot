// dsh-plugin-dot —— 浏览器端模块（DSH client 模块）。
//
// 按 DSH 模块加载器的 factory 格式手写（不需要构建），由 package.json 的 dsh.client 声明。
// React 来自 DSH 的共享模块表，用 React.createElement 写界面。
//
// 注册三样东西：
//   1. 会话总览：左侧栏入口（sidebar.panellist）+ 整页（main 面板），看其他会话的工作详情
//   2. Dot 窗口：右侧栏标签页（kind 'dot'），今天 / 事务 / 排程 / 记忆 / 规则；
//      打开 Dot 会话时自动展开
//   3. window.__dshDotBridge：给小精灵（lib/client.js，独立脚本）调用的跳转接口
window.__ModuleLoader__.load({
	id: "dsh-plugin-dot",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var h = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useRef = React.useRef;

		var API = "/api/dsh-plugin-dot";
		var PANEL_ID = "dot-sessions";
		var TAB_ID = "dsh-plugin-dot/panel";
		var TAB_KIND = "dot";

		// ── 和 Host 通信 ────────────────────────────────────────
		function getJSON(path) {
			return fetch(API + path, { credentials: "same-origin" }).then(function (r) {
				if (!r.ok) throw new Error(String(r.status));
				return r.json();
			});
		}
		function post(path, body) {
			return fetch(API + path, {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json", "x-dot-client": "1" },
				body: JSON.stringify(body),
			}).then(function (r) { return r.json(); });
		}

		/** 挂载期间定时拉数据（path 为 null 时不拉）；窗口在后台时放慢。 */
		function usePoll(path, ms) {
			var st = useState(null);
			var tick = useState(0);
			useEffect(function () {
				if (!path) return undefined;
				var alive = true;
				var timer = 0;
				function run() {
					getJSON(path)
						.then(function (d) { if (alive) st[1](d); })
						.catch(function () {})
						.then(function () { if (alive) timer = setTimeout(run, document.hidden ? ms * 4 : ms); });
				}
				run();
				return function () { alive = false; clearTimeout(timer); };
			}, [path, tick[0]]);
			return [st[0], function () { tick[1](function (x) { return x + 1; }); }];
		}

		/** 执行一个操作，把结果显示成一行提示，然后刷新。 */
		function useAct(reload) {
			var msg = useState(null);
			var timer = useRef(0);
			function show(m) {
				msg[1](m);
				clearTimeout(timer.current);
				timer.current = setTimeout(function () { msg[1](null); }, m.undo ? 7000 : 4000);
			}
			function act(path, body) {
				return post(path, body)
					.then(function (r) {
						// 能撤销的操作（完成、放弃、推迟）：提示里带「撤销」
						var undo = r && r.undo && r.undo.post ? function () { msg[1](null); act(r.undo.post, r.undo.body); } : null;
						if (r && r.text) show({ ok: r.ok !== false, text: r.text, undo: undo });
						reload();
						return r;
					})
					.catch(function (e) { show({ ok: false, text: String(e && e.message || e) }); });
			}
			return [msg[0], act];
		}

		// ── 跳转 ────────────────────────────────────────────────
		var services = null; // apply 时填入 ctx
		function openTarget(target) {
			if (!services || !target) return;
			if (typeof target === "string") services.uiWorkspace.openSession(target);
			else if (target.parentSessionId && target.childSessionId) {
				services.uiWorkspace.openSession({ parentSessionId: target.parentSessionId, childSessionId: target.childSessionId, mode: "unknown" });
			}
		}

		// ── 格式化 ──────────────────────────────────────────────
		function fmtDur(ms) {
			var s = Math.max(0, Math.round(ms / 1000));
			if (s < 60) return s + " 秒";
			var m = Math.round(s / 60);
			if (m < 60) return m + " 分钟";
			return Math.floor(m / 60) + " 小时" + (m % 60 ? " " + (m % 60) + " 分" : "");
		}
		function pad(n) { return n < 10 ? "0" + n : String(n); }
		function fmtWhen(iso) {
			if (!iso) return "";
			var d = new Date(iso);
			var now = new Date();
			var day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
			var today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
			var diff = Math.round((day - today) / 86400000);
			var hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
			if (diff === 0) return "今天 " + hm;
			if (diff === 1) return "明天 " + hm;
			if (diff === -1) return "昨天 " + hm;
			return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hm;
		}
		function ago(ts) {
			var ms = Date.now() - ts;
			return ms < 60000 ? "刚刚" : fmtDur(ms) + "前";
		}
		function baseName(p) {
			var parts = String(p).split(/[\\/]/);
			return parts[parts.length - 1] || p;
		}

		// ── 样式（DSH 自己的设计变量，带回退值）─────────────────
		var CSS = [
			".dotui{--fg:var(--dsw-alias-label-primary,#0f1115);--fg2:var(--dsw-alias-label-secondary,#61666b);--fg3:var(--dsw-alias-label-tertiary,#81858c);",
			"--bg:var(--dsw-alias-bg-base,#fff);--card:var(--dsw-alias-bg-layer-1,#fff);--line:var(--dsw-alias-border-l2,#0000001a);--line1:var(--dsw-alias-border-l1,#0000000a);",
			"--hover:var(--dsw-alias-interactive-bg-hover,#2631480f);--blue:var(--dsw-alias-state-business-primary,#4176e6);--blueBg:var(--dsw-alias-state-business-tertiary,#e4edfd);",
			"--green:var(--dsw-alias-state-success-primary,#22c55e);--greenBg:var(--dsw-alias-state-success-tertiary,#e6faed);--red:var(--dsw-alias-state-error-primary,#ec1313);",
			"--redBg:var(--dsw-alias-interactive-bg-hover-danger,#ec13130d);--amber:var(--dsw-alias-state-warn-primary,#f59e0b);--amberBg:var(--dsw-alias-state-warn-tertiary,#fef5e7);",
			"--gray:var(--dsw-alias-state-idle-primary,#d4d4d4);--mono:var(--ds-font-family-code,monospace);",
			"color:var(--fg);font-size:13px;line-height:20px;box-sizing:border-box}",
			".dotui *{box-sizing:border-box}",
			".dotui-page{height:100%;overflow:auto;padding:24px 32px 48px}",
			".dotui-h1{font-size:20px;line-height:28px;font-weight:600;margin:0}",
			".dotui-sub{color:var(--fg2);font-size:13px}",
			".dotui-muted{color:var(--fg3);font-size:12px}",
			".dotui-row{display:flex;align-items:center;gap:8px;min-width:0}",
			".dotui-grow{flex:1;min-width:0}",
			".dotui-ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dotui-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px;margin-top:16px;align-items:start}",
			".dotui-card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;min-width:0}",
			".dotui-btn{font:inherit;font-size:12px;line-height:18px;color:var(--fg2);background:transparent;border:1px solid var(--line);border-radius:8px;padding:3px 9px;cursor:pointer;white-space:nowrap}",
			".dotui-btn:hover{background:var(--hover);color:var(--fg)}",
			".dotui-btn.primary{color:var(--blue);border-color:var(--blue)}",
			".dotui-btn.danger:hover{color:var(--red);background:var(--redBg)}",
			".dotui-btn.ghost{border-color:transparent}",
			".dotui-btn.on{background:var(--blueBg);color:var(--blue);border-color:transparent}",
			".dotui-link{color:var(--fg);cursor:pointer;background:none;border:0;padding:0;font:inherit;font-weight:600;text-align:left}",
			".dotui-link:hover{color:var(--blue);text-decoration:underline}",
			".dotui-dot{width:8px;height:8px;border-radius:50%;flex:none}",
			".dotui-chip{display:inline-flex;align-items:center;gap:4px;font-size:12px;line-height:18px;padding:0 7px;border-radius:9px;background:var(--hover);color:var(--fg2);white-space:nowrap}",
			".dotui-banner{border-radius:8px;padding:6px 10px;font-size:12px;display:flex;align-items:center;gap:8px}",
			".dotui-bar{height:4px;border-radius:2px;background:var(--hover);overflow:hidden}",
			".dotui-bar>i{display:block;height:100%;background:var(--blue)}",
			".dotui-turn{margin:6px 0;padding:8px 10px;border:1px solid var(--line);border-radius:10px;max-width:640px}",
			".dotui-rowbtn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);cursor:pointer;padding:0}",
			".dotui-rowbtn:hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f);color:var(--dsw-alias-label-primary,#0f1115)}",
			".dotui-rowbtn.on{color:var(--dsw-alias-state-business-primary,#4176e6)}",
			".dotui-steps{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}",
			".dotui-steps li{display:flex;gap:6px;align-items:baseline;font-size:12px;color:var(--fg2);min-width:0}",
			".dotui-code{font-family:var(--mono);font-size:11.5px;color:var(--fg3)}",
			".dotui-quote{border-left:2px solid var(--line);padding-left:8px;color:var(--fg2);font-size:12px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}",
			".dotui-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px}",
			".dotui-input{font:inherit;font-size:13px;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 10px;width:100%;outline:none}",
			".dotui-input:focus{border-color:var(--blue)}",
			".dotui-toast{position:sticky;bottom:8px;margin-top:12px;padding:8px 12px;border-radius:8px;font-size:12px;background:var(--fg);color:var(--bg)}",
			".dotui-undo{font:inherit;font-size:12px;font-weight:600;color:inherit;background:none;border:0;border-left:1px solid currentColor;padding:0 0 0 10px;cursor:pointer;opacity:.9}",
			".dotui-undo:hover{opacity:1;text-decoration:underline}",
			".dotui-todo{border-radius:8px}",
			".dotui-todo.open{background:var(--hover)}",
			".dotui-todo .dotui-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--fg3);font-size:12px;line-height:18px}",
			".dotui-todo.gone{opacity:.45;transition:opacity .3s}",
			".dotui-todo.gone .dotui-ttl{text-decoration:line-through}",
			".dotui-check.on{background:var(--green);border-color:var(--green)}",
			".dotui-detail{margin:0 8px 6px 32px;display:flex;flex-direction:column;gap:6px}",
			".dotui-step{display:flex;align-items:center;gap:6px;font-size:12.5px;min-width:0}",
			".dotui-step .dotui-hov{visibility:hidden}",
			".dotui-step:hover .dotui-hov{visibility:visible}",
			".dotui-sbox{width:13px;height:13px;border-radius:3px;border:1.5px solid var(--fg3);background:none;cursor:pointer;flex:none;padding:0;color:#fff;font-size:10px;line-height:10px}",
			".dotui-sbox.on{background:var(--blue);border-color:var(--blue)}",
			".dotui-menu{display:flex;gap:4px;flex-wrap:wrap;padding:4px 0}",
			".dotui-tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);padding:0 12px;position:sticky;top:0;background:var(--bg);z-index:1}",
			".dotui-tab{font:inherit;font-size:13px;color:var(--fg2);background:none;border:0;border-bottom:2px solid transparent;padding:8px 10px;cursor:pointer}",
			".dotui-tab.on{color:var(--fg);border-bottom-color:var(--fg);font-weight:600}",
			".dotui-pane{height:100%;overflow:auto;display:flex;flex-direction:column}",
			".dotui-body{padding:12px 14px 32px;display:flex;flex-direction:column;gap:14px}",
			".dotui-sec{display:flex;flex-direction:column;gap:6px}",
			".dotui-sech{font-size:12px;color:var(--fg3);font-weight:600;display:flex;align-items:center;gap:6px}",
			".dotui-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;min-width:0}",
			".dotui-item:hover{background:var(--hover)}",
			".dotui-item .dotui-hov{visibility:hidden}",
			".dotui-item:hover .dotui-hov{visibility:visible}",
			".dotui-check{width:16px;height:16px;border-radius:50%;border:1.5px solid var(--fg3);background:none;cursor:pointer;flex:none;padding:0}",
			".dotui-check:hover{border-color:var(--green);background:var(--greenBg)}",
			".dotui-sub-item{margin-left:24px;padding:4px 8px;border-left:2px solid var(--line);display:flex;flex-direction:column;gap:4px}",
			".dotui-empty{color:var(--fg3);font-size:12px;padding:8px}",
			".dotui-pipe{display:flex;align-items:stretch;gap:4px;flex-wrap:wrap}",
			".dotui-gate{border:1px solid var(--line);border-radius:8px;padding:6px 8px;font-size:12px;flex:1;min-width:90px}",
			".dotui-arrow{align-self:center;color:var(--fg3)}",
			".dotui-ladder{display:flex;flex-direction:column;gap:2px}",
			".dotui-ladder>div{font-size:12px;padding:3px 8px;border-radius:6px;color:var(--fg2)}",
			".dotui-ladder>div.on{background:var(--blueBg);color:var(--blue);font-weight:600}",
			".dotui-table{width:100%;border-collapse:collapse;font-size:12px}",
			".dotui-table td,.dotui-table th{border-bottom:1px solid var(--line1);padding:4px 6px;text-align:center}",
			".dotui-table th{color:var(--fg3);font-weight:500}",
			".dotui-table td:first-child,.dotui-table th:first-child{text-align:left}",
		].join("\n");

		// ── 小组件 ──────────────────────────────────────────────
		function Btn(props) {
			return h("button", {
				type: "button",
				className: "dotui-btn " + (props.kind || ""),
				title: props.title,
				onClick: function (e) { e.stopPropagation(); if (props.onClick) props.onClick(); },
			}, props.children);
		}
		function Chip(props) {
			return h("span", { className: "dotui-chip", style: props.style, title: props.title }, props.children);
		}
		function Toast(props) {
			if (!props.msg) return null;
			return h("div", { className: "dotui-toast dotui-row", style: props.msg.ok ? null : { background: "var(--red)" } },
				h("span", { className: "dotui-grow" }, props.msg.text),
				props.msg.undo ? h("button", { type: "button", className: "dotui-undo", onClick: props.msg.undo }, "撤销") : null);
		}
		/** 点一下变成输入框，回车保存，Esc 取消。 */
		function Editable(props) {
			var editing = useState(Boolean(props.startEditing));
			var val = useState(props.startEditing ? (props.initial != null ? props.initial : props.value || "") : "");
			function stop() { editing[1](false); if (props.onCancel) props.onCancel(); }
			if (!editing[0]) {
				return h("span", {
					className: props.className,
					style: Object.assign({ cursor: "text" }, props.style),
					title: props.hint || "点击修改",
					onClick: function (e) { e.stopPropagation(); val[1](props.initial != null ? props.initial : props.value || ""); editing[1](true); },
				}, props.value || h("span", { className: "dotui-muted" }, props.empty || "未设置"));
			}
			return h("input", {
				className: "dotui-input",
				style: { padding: "2px 6px", fontSize: 12, width: props.width || "100%" },
				autoFocus: true,
				value: val[0],
				placeholder: props.placeholder,
				onClick: function (e) { e.stopPropagation(); },
				onChange: function (e) { val[1](e.target.value); },
				onKeyDown: function (e) {
					if (e.key === "Enter") { editing[1](false); props.onSave(val[0].trim()); }
					else if (e.key === "Escape") stop();
				},
				onBlur: stop,
			});
		}
		/** 一行输入框 + 提交。 */
		function Ask(props) {
			var val = useState("");
			return h("form", {
				className: "dotui-row",
				onSubmit: function (e) {
					e.preventDefault();
					var text = val[0].trim();
					if (!text) return;
					val[1]("");
					props.onSubmit(text);
				},
			},
			h("input", { className: "dotui-input", value: val[0], placeholder: props.placeholder, onChange: function (e) { val[1](e.target.value); } }),
			h("button", { type: "submit", className: "dotui-btn primary" }, props.label || "发送"));
		}
		/** 上下文用量条：70% 变黄，85% 变红并提示。 */
		function ContextBar(props) {
			var c = props.c;
			var k = function (n) { return n >= 1e6 ? Math.round(n / 1e5) / 10 + "M" : n >= 1000 ? Math.round(n / 1000) + "K" : String(n); };
			if (!c.window) return h("div", { className: "dotui-muted" }, "上下文 " + k(c.used) + " token");
			var pct = Math.min(100, Math.round((c.used / c.window) * 100));
			var color = pct >= 85 ? "var(--red)" : pct >= 70 ? "var(--amber)" : "var(--blue)";
			return h("div", { title: "这个会话当前占用的上下文。快满时 DSH 会自动压缩早先的内容。" },
				h("div", { className: "dotui-row dotui-muted" }, "上下文 " + k(c.used) + " / " + k(c.window) + "（" + pct + "%）" + (pct >= 85 ? " 快满了，DSH 会自动压缩" : "")),
				h("div", { className: "dotui-bar" }, h("i", { style: { width: pct + "%", background: color } })));
		}
		// ── 哪些会话是 Dot：小精灵拿到状态后告诉这里 ─────────────────
		var knownDot = new Set();
		var dotListeners = new Set();
		function noteDot(ids) {
			var changed = false;
			(ids || []).forEach(function (x) { if (!knownDot.has(x)) { knownDot.add(x); changed = true; } });
			if (changed) dotListeners.forEach(function (fn) { fn(); });
			return changed;
		}
		var knownWatched = new Set();
		var petTitle = "Dot";
		function noteStatus(info) {
			var ids = info.watchedIds || [];
			var same = ids.length === knownWatched.size && ids.every(function (x) { return knownWatched.has(x); });
			petTitle = info.petName || "Dot";
			if (same) return;
			knownWatched = new Set(ids);
			dotListeners.forEach(function (fn) { fn(); });
		}
		function useIsDot(sessionId) {
			var tick = useState(0);
			useEffect(function () {
				function on() { tick[1](function (n) { return n + 1; }); }
				dotListeners.add(on);
				return function () { dotListeners.delete(on); };
			}, []);
			return Boolean(sessionId) && knownDot.has(sessionId);
		}

		/**
		 * Dot 对话每一轮下面的小卡片：这一轮记下的事务（可以直接完成、改时间）和提出的建议。
		 * 只在 Dot 会话、而且这一轮已经结束时去问 Host。
		 */
		/** 把同一时刻各轮的查询合并成一个请求。 */
		var turnQueue = null;
		function queryTurn(sessionId, from, to) {
			return new Promise(function (resolve, reject) {
				if (!turnQueue || turnQueue.sessionId !== sessionId) {
					var q = { sessionId: sessionId, items: [] };
					turnQueue = q;
					setTimeout(function () {
						if (turnQueue === q) turnQueue = null;
						post("/turns", { sessionId: q.sessionId, ranges: q.items.map(function (x) { return [x.from, x.to]; }) })
							.then(function (r) { q.items.forEach(function (x, i) { x.resolve((r && r.results && r.results[i]) || null); }); })
							.catch(function (e) { q.items.forEach(function (x) { x.reject(e); }); });
					}, 30);
				}
				turnQueue.items.push({ from: from, to: to, resolve: resolve, reject: reject });
			});
		}
		var EFFECT = {
			reminder: ["⏰", "提醒"], memory: ["🧠", "记住了"], done: ["✓", "完成"], dropped: ["✕", "放弃"], due: ["↻", "改期"],
		};
		function TurnCard(props) {
			var sessionId = props.dotSessionId;
			var turn = props.turn;
			var isDot = useIsDot(sessionId);
			var from = turn && turn.start ? turn.start.time : null;
			var to = turn && turn.end ? turn.end.time : null;
			var data = useState(null);
			var ver = useState(0);
			var msg = useState(null);
			useEffect(function () {
				if (!isDot || from == null || to == null) return;
				var alive = true;
				(ver[0] ? post("/turn", { sessionId: sessionId, from: from, to: to }) : queryTurn(sessionId, from, to))
					.then(function (r) { if (alive && r) data[1](r); })
					.catch(function () { /* 拿不到就不显示 */ });
				return function () { alive = false; };
			}, [isDot, sessionId, from, to, ver[0]]);
			var d = data[0];
			var effects = (d && d.effects) || [];
			if (!d || (!d.tasks.length && !d.suggestions.length && !effects.length)) return null;
			function act(path, body) {
				post(path, body).then(function (r) {
					if (r && r.text) msg[1](r.text);
					ver[1](ver[0] + 1);
				});
			}
			return h("div", { className: "dotui dotui-turn" },
				h("div", { className: "dotui-muted", style: { marginBottom: "4px" } }, "Dot 这一轮记下的"),
				d.tasks.map(function (t) {
					var closed = t.status === "done" || t.status === "dropped";
					return h("div", { key: t.id, className: "dotui-item" },
						h("span", { className: "dotui-check" + (t.status === "done" ? " on" : ""), title: closed ? "" : "完成", onClick: closed ? null : function () { act("/task", { id: t.id, action: "done" }); } }, t.status === "done" ? "✓" : ""),
						h("div", { className: "dotui-grow", style: { minWidth: 0, textDecoration: closed ? "line-through" : "none", color: closed ? "var(--fg3)" : "var(--fg)" } },
							t.title, h("span", { className: "dotui-muted" }, "  " + t.id + (t.due ? " · " + fmtWhen(t.due) : ""))),
						closed ? h("span", { className: "dotui-muted" }, t.status === "done" ? "已完成" : "已放弃")
							: h(Editable, { value: t.due ? "改时间" : "加时间", initial: "", width: "110px", className: "dotui-muted", hint: "输入新时间，如 明天9点；输入「无」取消", placeholder: "如：明天9点", onSave: function (v) { if (v) act("/say", { text: "/due " + t.id + " " + v }); } }));
				}),
				effects.map(function (x, i) {
					var e = EFFECT[x.kind] || ["·", ""];
					return h("div", { key: "e" + i, className: "dotui-row", style: { padding: "2px 6px", fontSize: "12px" } },
						h("span", { style: { width: "16px", textAlign: "center" } }, e[0]),
						h("span", { className: "dotui-muted" }, e[1]),
						h("span", { className: "dotui-grow dotui-ell", title: x.text }, x.text));
				}),
				d.suggestions.map(function (g) {
					return h("div", { key: g.id, className: "dotui-item", style: { background: "var(--blueBg)" } },
						h("span", null, "💡"),
						h("div", { className: "dotui-grow", style: { minWidth: 0 } }, g.title),
						g.status === "open" ? [
							g.options.map(function (o, i) { return h(Btn, { key: i, kind: "primary", onClick: function () { act("/suggestion", { id: g.id, option: i }); } }, o.label); }),
							h(Btn, { key: "x", kind: "ghost", onClick: function () { act("/suggestion", { id: g.id, dismiss: true }); } }, "忽略"),
						] : h("span", { className: "dotui-muted" }, g.status === "accepted" ? "已采纳" : "已忽略"));
				}),
				msg[0] ? h("div", { className: "dotui-muted", style: { marginTop: "4px" } }, msg[0]) : null);
		}

		/** 侧栏会话行的悬停按钮：让 Dot 盯着这个会话，结束时通知你。Dot 自己的会话不显示。 */
		function RowWatch(props) {
			var isDot = useIsDot(props.sessionId);
			var local = useState(null); // 刚点过、Host 还没同步回来时先按本地显示
			var on = [local[0] != null ? local[0] : knownWatched.has(props.sessionId), local[1]];
			var tip = useState(null);
			if (isDot) return null;
			tip = [tip[0] || (on[0] ? "Dot 在盯着这个会话，点一下取消" : "让 Dot 盯着：这个会话结束时通知你"), tip[1]];
			return h("button", {
				type: "button",
				className: "dotui-rowbtn" + (on[0] ? " on" : ""),
				title: tip[0],
				"aria-label": tip[0],
				onClick: function (e) {
					e.stopPropagation();
					e.preventDefault();
					var next = !on[0];
					post("/session", { id: props.sessionId, action: next ? "watch" : "unwatch" }).then(function (r) {
						if (r && r.ok !== false) on[1](next);
						tip[1]((r && r.text) || (next ? "Dot 在盯着" : "不再盯着了"));
					});
				},
			}, h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5 },
				h("path", { d: "M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" }),
				h("circle", { cx: 8, cy: 8, r: 2, fill: on[0] ? "currentColor" : "none" })));
		}

		function Progress(props) {
			var pct = props.total ? Math.round((props.done / props.total) * 100) : 0;
			return h("div", { className: "dotui-bar" }, h("i", { style: { width: pct + "%" } }));
		}
		function Steps(props) {
			var list = props.steps || [];
			if (!list.length) return null;
			return h("ul", { className: "dotui-steps" }, list.slice(0, props.max || 5).map(function (s, i) {
				var mark = s.running ? "▸" : s.ok === false ? "✕" : "✓";
				var color = s.running ? "var(--blue)" : s.ok === false ? "var(--red)" : "var(--green)";
				return h("li", { key: i },
					h("span", { style: { color: color, width: 10, flex: "none" } }, mark),
					h("span", { style: { flex: "none" } }, s.tool),
					h("span", { className: "dotui-code dotui-ell dotui-grow", title: s.detail }, s.detail),
					h("span", { className: "dotui-muted", style: { flex: "none" } }, s.running ? fmtDur(s.ms) + "…" : fmtDur(s.ms)));
			}));
		}

		// ── 会话总览 ────────────────────────────────────────────
		function sessionState(s) {
			if (s.status === "running") {
				if (s.waiting) return { text: s.waiting.kind === "question" ? "在问你" : "等你批准", color: "var(--amber)" };
				if (s.asking) return { text: "在问你", color: "var(--amber)" };
				if (s.stuck) return { text: "很久没动静", color: "var(--amber)" };
				return { text: s.tool ? "正在" + s.tool : "运行中", color: "var(--blue)" };
			}
			if (s.restored) return { text: "DSH 重启前", color: "var(--gray)" };
			if (s.result === "failed") return { text: "出错停下", color: "var(--red)" };
			if (s.result === "stopped") return { text: "已停止", color: "var(--gray)" };
			if (s.result === "done") return { text: "已完成", color: "var(--green)" };
			return { text: "空闲", color: "var(--gray)" };
		}

		function SessionCard(props) {
			var s = props.s;
			var act = props.act;
			var more = useState(false);
			var todosOpen = useState(false);
			var relaying = useState(false);
			var renaming = useState(false);
			var st = sessionState(s);
			var running = s.status === "running";
			return h("div", { className: "dotui-card" },
				h("div", { className: "dotui-row" },
					h("span", { className: "dotui-dot", style: { background: st.color } }),
					renaming[0]
						? h("span", { className: "dotui-grow" }, h(Editable, {
							value: s.title, initial: s.titleTemp ? "" : s.title, placeholder: "新名字：做什么 + 对象，十来个字", startEditing: true,
							onSave: function (v) { renaming[1](false); if (v && v !== s.title) act("/session", { id: s.id, action: "rename", title: v }); },
							onCancel: function () { renaming[1](false); },
						}))
						: h("button", { className: "dotui-link dotui-ell dotui-grow", title: "打开这个会话", onClick: function () { openTarget(s.id); }, style: s.titleTemp ? { fontWeight: 500, color: "var(--fg2)" } : null }, s.title),
					!renaming[0] && s.titleIssue ? h(Chip, { title: "点「改名」自己起，或者在上面让 Dot 一起起名", style: { background: "var(--amberBg)", color: "var(--amber)" } }, s.titleIssue) : null,
					!renaming[0] ? h("button", { type: "button", className: "dotui-rowbtn", title: "改名", onClick: function () { renaming[1](true); } }, "✎") : null,
					s.watched ? h(Chip, { style: { background: "var(--blueBg)", color: "var(--blue)" } }, "Dot 盯着") : null),
				h("div", { className: "dotui-row dotui-muted" },
					h("span", { style: { color: st.color, fontWeight: 600 } }, st.text),
					s.restored ? null : h("span", null, "· " + (running ? "已跑 " : "用时 ") + fmtDur(s.elapsedMs)),
					s.steps && s.steps.length ? h("span", null, "· 最近 " + s.steps.length + " 步") : null,
					!running && s.endedAt ? h("span", null, "· " + ago(s.endedAt)) : null),
				s.waiting ? h("div", { className: "dotui-banner", style: { background: "var(--amberBg)" } },
					h("span", { className: "dotui-grow" }, s.waiting.reason),
					h(Btn, { kind: "primary", onClick: function () { openTarget(s.id); } }, "去处理")) : null,
				!s.waiting && s.asking ? h("div", { className: "dotui-banner", style: { background: "var(--amberBg)" } },
					h("span", { className: "dotui-grow" }, "在问你：" + s.asking),
					h(Btn, { kind: "primary", onClick: function () { openTarget(s.id); } }, "去回答")) : null,
				s.error && s.result === "failed" ? h("div", { className: "dotui-banner", style: { background: "var(--redBg)", color: "var(--red)" } }, s.error) : null,
				s.context ? h(ContextBar, { c: s.context }) : null,
				s.goal ? h("div", { className: "dotui-muted" }, "目标：" + s.goal.objective + (s.goal.phase && s.goal.phase !== "active" ? "（" + s.goal.phase + "）" : "")) : null,
				s.todoTotal ? h("div", { style: { display: "flex", flexDirection: "column", gap: 4, cursor: "pointer" }, onClick: function () { todosOpen[1](!todosOpen[0]); }, title: "展开或收起待办" },
					h("div", { className: "dotui-row" },
						h("span", { style: { fontWeight: 600, fontSize: 12 } }, "待办 " + s.todoDone + "/" + s.todoTotal),
						s.current ? h("span", { className: "dotui-ell dotui-grow dotui-muted" }, "正在：" + s.current) : h("span", { className: "dotui-grow" })),
					h(Progress, { done: s.todoDone, total: s.todoTotal }),
					todosOpen[0] ? h("ul", { className: "dotui-steps" }, s.todos.map(function (t, i) {
						var m = t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "○";
						return h("li", { key: i, style: t.status === "completed" ? { textDecoration: "line-through" } : null }, h("span", { style: { width: 10, flex: "none" } }, m), h("span", null, t.content));
					})) : null) : null,
				h(Steps, { steps: s.steps, max: more[0] ? 8 : 4 }),
				s.files && s.files.length ? h("div", { className: "dotui-row", style: { flexWrap: "wrap", gap: 4 } },
					h("span", { className: "dotui-muted" }, "改了 " + s.files.length + " 个文件"),
					s.files.slice(0, more[0] ? 20 : 4).map(function (f) { return h(Chip, { key: f, title: f }, baseName(f)); })) : null,
				s.jobs && s.jobs.length ? h("div", { className: "dotui-muted" }, "后台：" + s.jobs.map(function (j) { return j.label + (j.progress ? "（" + j.progress + "）" : ""); }).join("；")) : null,
				s.lastText ? h("div", { className: "dotui-quote", title: s.lastText }, s.lastText) : null,
				s.restored ? h("div", { className: "dotui-muted" }, "这是 DSH 重启前的会话，只有标题；再跑起来就能看到详情。") : null,
				h("div", { className: "dotui-actions" },
					h(Btn, { onClick: function () { openTarget(s.id); } }, "打开"),
					running ? h(Btn, { kind: "danger", onClick: function () { act("/session", { id: s.id, action: "stop" }); } }, "停止") : null,
					s.restored ? null : h(Btn, { kind: s.watched ? "on" : "", title: "结束或出错时，小精灵通知你", onClick: function () { act("/session", { id: s.id, action: s.watched ? "unwatch" : "watch" }); } }, s.watched ? "取消盯着" : "让 Dot 盯着"),
					h(Btn, { kind: relaying[0] ? "on" : "", title: "给这个会话补一句话，不用切过去", onClick: function () { relaying[1](!relaying[0]); } }, "转告…"),
					h(Btn, { title: "在 Dot 的事务里记一条跟进，关联这个会话", onClick: function () { act("/session", { id: s.id, action: "task" }); } }, "记为事务"),
					!running ? h(Btn, { kind: "ghost", title: "归档：从侧栏收起，Dot 收件箱里可以撤销", onClick: function () { act("/session", { id: s.id, action: "archive" }); } }, "归档") : null,
					!running ? h(Btn, { kind: "ghost", title: "只从总览里移除，侧栏不变", onClick: function () { act("/dismiss", { id: s.id }); } }, "移除") : null,
					(s.steps && s.steps.length > 4) || (s.files && s.files.length > 4) ? h(Btn, { kind: "ghost", onClick: function () { more[1](!more[0]); } }, more[0] ? "收起" : "更多") : null),
				relaying[0] ? h(Ask, {
					placeholder: running ? "补一句，它会在这一步后看到（带「Dot 代你转告」）" : "发一句话让它接着做（带「Dot 代你转告」）",
					label: "发送",
					onSubmit: function (text) { act("/session", { id: s.id, action: "relay", text: text }).then(function (r) { if (r && r.ok !== false) relaying[1](false); }); },
				}) : null);
		}

		function SessionsPage() {
			var poll = usePoll("/sessions", 2500);
			var data = poll[0];
			var a = useAct(poll[1]);
			var filter = useState("all");
			var search = useState(null); // { query, hits, loading, error }
			var list = data ? data.sessions : [];
			function runSearch(q) {
				search[1]({ query: q, hits: [], loading: true });
				post("/sessions/search", { query: q }).then(function (r) {
					search[1]({ query: q, hits: (r && r.hits) || [], loading: false, error: r && r.ok === false ? r.text : null });
				}).catch(function (e) { search[1]({ query: q, hits: [], loading: false, error: String(e && e.message || e) }); });
			}
			var running = list.filter(function (s) { return s.status === "running"; });
			var waiting = running.filter(function (s) { return s.waiting || s.asking; });
			var shown = list.filter(function (s) {
				return filter[0] === "all" || (filter[0] === "running" ? s.status === "running" : s.status !== "running");
			});
			var unnamed = list.filter(function (s) { return s.titleIssue && s.status !== "running"; });
			return h("div", { className: "dotui dotui-page" },
				h("div", { className: "dotui-row", style: { alignItems: "flex-end", gap: 8 } },
					h("div", { className: "dotui-grow" },
						h("h1", { className: "dotui-h1" }, "会话总览"),
						h("div", { className: "dotui-sub" }, data ? running.length + " 个在跑" + (waiting.length ? "，" + waiting.length + " 个在等你" : "") + "，共 " + list.length + " 个" : "加载中…")),
					["all", "running", "ended"].map(function (k) {
						return h(Btn, { key: k, kind: filter[0] === k ? "on" : "", onClick: function () { filter[1](k); } }, { all: "全部", running: "运行中", ended: "已结束" }[k]);
					}),
					h(Btn, { kind: "ghost", onClick: function () { a[1]("/dismiss", { all: "others" }); } }, "清空已结束的")),
				data && data.watchOthers === false ? h("div", { className: "dotui-empty" }, "已在配置里关闭了其他会话监控（watchOthers: false）。") : null,
				data && data.watchOthers !== false ? h("div", { style: { marginTop: 12, maxWidth: 560 } },
					h(Ask, { placeholder: "搜所有会话里说过的话，比如「登录页」「报价」", label: "搜索", onSubmit: runSearch })) : null,
				search[0] ? h(SearchResults, { search: search[0], onClose: function () { search[1](null); } }) : null,
				unnamed.length ? h("div", { className: "dotui-banner", style: { background: "var(--amberBg)", marginTop: 12, maxWidth: 560 } },
					h("span", { className: "dotui-grow" }, unnamed.length + " 个会话的名字不清楚（没标题、太笼统或重名）。Dot 可以读一遍内容，起好名字给你确认。"),
					h(Btn, { kind: "primary", onClick: function () { a[1]("/session", { action: "name-all" }); } }, "让 Dot 起名")) : null,
				data && !shown.length ? h("div", { className: "dotui-empty", style: { padding: "40px 0", textAlign: "center" } },
					filter[0] === "running" ? "现在没有在跑的会话。" : "还没有其他会话的记录。在别的会话里让 DSH 干点活，这里就会出现它的进度。") : null,
				h("div", { className: "dotui-grid" }, shown.map(function (s) { return h(SessionCard, { key: s.id, s: s, act: a[1] }); })),
				h(Toast, { msg: a[0] }));
		}

		/** 会话搜索结果：会话名、多久以前、命中的那句话；点一下打开。 */
		function SearchResults(props) {
			var s = props.search;
			return h("div", { className: "dotui-card", style: { marginTop: 12, maxWidth: 760 } },
				h("div", { className: "dotui-row" },
					h("span", { className: "dotui-grow", style: { fontWeight: 600 } },
						s.loading ? "正在搜「" + s.query + "」…" : s.error ? "搜索失败：" + s.error : (s.hits.length ? "「" + s.query + "」出现在 " + s.hits.length + " 个会话里" : "没有会话提到「" + s.query + "」")),
					h(Btn, { kind: "ghost", onClick: props.onClose }, "关闭")),
				s.hits.map(function (x) {
					return h("div", { key: x.id, className: "dotui-row", style: { alignItems: "flex-start", gap: 10, padding: "4px 0", borderTop: "1px solid var(--line1)" } },
						h("div", { className: "dotui-grow", style: { minWidth: 0 } },
							h("div", { className: "dotui-row" },
								h("button", { className: "dotui-link dotui-ell", title: "打开这个会话", onClick: function () { openTarget(x.id); } }, x.title),
								x.time ? h("span", { className: "dotui-muted" }, ago(x.time)) : null),
							h("div", { className: "dotui-muted", style: { whiteSpace: "normal" } }, "…" + x.snippet + "…")),
						h(Btn, { onClick: function () { openTarget(x.id); } }, "打开"));
				}));
		}

		function SessionsIcon(props) {
			var size = props.size || 16;
			return h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, "aria-hidden": true },
				h("rect", { x: 2, y: 2.5, width: 5, height: 5, rx: 1.2 }),
				h("rect", { x: 9, y: 2.5, width: 5, height: 5, rx: 1.2 }),
				h("rect", { x: 2, y: 9.5, width: 5, height: 4, rx: 1.2 }),
				h("rect", { x: 9, y: 9.5, width: 5, height: 4, rx: 1.2 }));
		}

		// ── Dot 窗口（右侧栏）───────────────────────────────────
		var PRIORITY = { high: "高", normal: "中", low: "低" };
		var NEXT_PRIORITY = { high: "normal", normal: "low", low: "high" };

		function ChildRow(props) {
			var c = props.c;
			var act = props.act;
			var saying = useState(false);
			var d = c.detail || {};
			var color = c.status === "running" ? (c.stuck ? "var(--amber)" : "var(--blue)") : c.status === "done" ? "var(--green)" : c.status === "failed" ? "var(--red)" : "var(--gray)";
			var label = { starting: "启动中", running: c.stuck ? "很久没动静" : (c.tool ? "正在" + c.tool : "在干活"), idle: "等待中", done: "完成", failed: "出错", stopped: "已停止" }[c.status] || c.status;
			return h("div", { className: "dotui-sub-item" },
				h("div", { className: "dotui-row" },
					h("span", { className: "dotui-dot", style: { background: color } }),
					h("button", { className: "dotui-link dotui-ell", style: { fontWeight: 500 }, onClick: function () { openTarget(c.parentId ? { parentSessionId: c.parentId, childSessionId: c.id } : null); } }, c.name),
					h("span", { className: "dotui-muted dotui-grow dotui-ell" }, label + " · " + fmtDur(c.elapsedMs)),
					c.status === "running" ? h(Btn, { kind: "danger", onClick: function () { act("/child", { id: c.id, action: "stop" }); } }, "停止") : null,
					c.status === "running" || c.status === "stopped" ? h(Btn, { onClick: function () { saying[1](!saying[0]); } }, c.status === "stopped" ? "继续" : "补一句") : null,
					c.status !== "running" && c.status !== "starting" ? h(Btn, { kind: "ghost", onClick: function () { act("/dismiss", { id: c.id }); } }, "移除") : null),
				d.todoTotal ? h("div", { className: "dotui-muted" }, "待办 " + d.todoDone + "/" + d.todoTotal + (d.current ? " · 正在：" + d.current : "")) : null,
				c.status === "running" ? h(Steps, { steps: d.steps, max: 2 }) : null,
				c.summary ? h("div", { className: "dotui-quote" }, c.summary) : null,
				saying[0] ? h(Ask, { placeholder: "告诉 " + c.name + "…", label: "发送", onSubmit: function (text) { saying[1](false); act("/child", { id: c.id, action: "say", text: text }); } }) : null);
		}

		/** 待办的一行：勾掉、改名、改时间、放进今天、推迟、等别人、交给 Dot；点开看备注和小步骤。 */
		function TaskRow(props) {
			var t = props.t;
			var act = props.act;
			var open = useState(false);
			var menu = useState(""); // "" | "snooze" | "wait"
			var gone = useState(false);
			var steps = t.steps || [];
			var doneSteps = steps.filter(function (x) { return x.done; }).length;
			var waiting = t.status === "waiting";
			function finish() {
				// 先划掉，再提交：手感像真的在勾清单
				gone[1](true);
				setTimeout(function () { act("/task", { id: t.id, action: "done" }); }, 260);
			}
			return h("div", { className: "dotui-todo" + (open[0] ? " open" : "") + (gone[0] ? " gone" : "") },
				h("div", { className: "dotui-item", style: { alignItems: "flex-start", cursor: "pointer" }, onClick: function () { open[1](!open[0]); } },
					h("button", { type: "button", className: "dotui-check" + (gone[0] ? " on" : ""), style: { marginTop: 2 }, title: "完成（可撤销）", onClick: function (e) { e.stopPropagation(); finish(); } }),
					h("div", { className: "dotui-grow", style: { minWidth: 0 } },
						h(Editable, { value: t.title, className: "dotui-ell dotui-ttl", style: { display: "block", fontWeight: 500, color: t.priority === "high" ? "var(--red)" : null }, onSave: function (v) { if (v && v !== t.title) act("/task", { id: t.id, action: "edit", title: v }); } }),
						h("div", { className: "dotui-meta" },
							t.today && t.bucket !== "overdue" ? h("span", { style: { color: "var(--amber)" } }, "☀ 今天") : null,
							waiting ? h("span", { style: { color: "var(--blue)" } }, "⌛ 在等" + (t.waitingOn ? "「" + t.waitingOn + "」" : "") + (t.due ? " · " + fmtWhen(t.due) + " 追" : "")) : h(Editable, {
								value: t.due ? "⏰ " + fmtWhen(t.due) : "", initial: "", empty: "⏰ 提醒我…", hint: "什么时候提醒：1小时后、下班前、明早9点、周五18点；输入「无」取消",
								placeholder: "1小时后 / 下班前 / 周五18点", width: 170, style: t.overdue ? { color: "var(--red)", fontWeight: 600 } : null,
								onSave: function (v) { if (v) act("/say", { text: "/due " + t.id + " " + v }); },
							}),
							t.repeat ? h("span", { title: "周期待办：勾掉后自动排下一次" }, "↻ " + t.repeat) : null,
							steps.length ? h("span", { style: doneSteps === steps.length ? { color: "var(--green)" } : null }, "☑ " + doneSteps + "/" + steps.length) : null,
							t.notes ? h("span", { title: t.notes }, "✎ 备注") : null,
							t.linkedSession ? h("button", { type: "button", className: "dotui-link", style: { fontWeight: 400, fontSize: 12, color: "var(--blue)" }, onClick: function (e) { e.stopPropagation(); openTarget(t.linkedSession); } }, "↗ 关联会话") : null,
							t.owner !== "user" ? h("span", null, t.owner === "dot" ? "· Dot 在办" : "· 已委派") : null)),
					h("button", {
						type: "button", className: "dotui-chip", style: { border: 0, cursor: "pointer", color: t.priority === "high" ? "var(--red)" : null, marginTop: 1 },
						title: "点击切换优先级", onClick: function (e) { e.stopPropagation(); act("/task", { id: t.id, action: "edit", priority: NEXT_PRIORITY[t.priority] || "normal" }); },
					}, PRIORITY[t.priority] || "中"),
					h("span", { className: "dotui-hov dotui-row", style: { gap: 2 } },
						waiting ? null : h("button", { type: "button", className: "dotui-rowbtn" + (t.today ? " on" : ""), title: t.today ? "移出今天" : "放进今天", onClick: function (e) { e.stopPropagation(); act("/task", { id: t.id, action: t.today ? "untoday" : "today" }); } }, "☀"),
						h("button", { type: "button", className: "dotui-rowbtn" + (menu[0] === "snooze" ? " on" : ""), title: t.due ? "改时间 / 推迟" : "提醒我", onClick: function (e) { e.stopPropagation(); open[1](true); menu[1](menu[0] === "snooze" ? "" : "snooze"); } }, "⏰"),
						h("button", { type: "button", className: "dotui-rowbtn", title: "交给 Dot 去推进（要你拍板的它会先问）", onClick: function (e) { e.stopPropagation(); act("/task", { id: t.id, action: "delegate" }); } }, "➜"))),
				open[0] ? h("div", { className: "dotui-detail" },
					// 提醒我 / 改时间：一下点好；要别的时间直接写（下班前、周五18点……）
					menu[0] === "snooze" ? h("div", { className: "dotui-menu", style: { alignItems: "center" } },
						h("span", { className: "dotui-muted" }, t.due ? "改到：" : "提醒我："),
						[["30m", "半小时后"], ["1h", "1 小时后"], ["offwork", "下班前"], ["tonight", "今晚 8 点"], ["tomorrow", "明早 9 点"], ["weekend", "周末"], ["nextweek", "下周一"]].map(function (o) {
							return h(Btn, { key: o[0], onClick: function () { menu[1](""); act("/task", { id: t.id, action: "snooze", to: o[0] }); } }, o[1]);
						}),
						t.due ? h(Btn, { kind: "ghost", title: "不定时间，也不提醒", onClick: function () { menu[1](""); act("/say", { text: "/due " + t.id + " 无" }); } }, "不定时间") : null) : null,
					menu[0] === "wait" ? h(Ask, { placeholder: "在等谁 / 等什么，比如：老王回邮件（两天后提醒你追）", label: "好", onSubmit: function (text) { menu[1](""); act("/task", { id: t.id, action: "wait", waitingOn: text }); } }) : null,
					h(Editable, { value: t.notes, empty: "加备注", placeholder: "备注、链接、进展", className: "dotui-muted", style: { display: "block", whiteSpace: "pre-wrap" }, onSave: function (v) { if (v !== t.notes) act("/task", { id: t.id, action: "edit", notes: v }); } }),
					steps.map(function (s, i) {
						return h("div", { key: i, className: "dotui-step" },
							h("button", { type: "button", className: "dotui-sbox" + (s.done ? " on" : ""), title: s.done ? "取消勾选" : "做完了", onClick: function () { act("/task", { id: t.id, action: "step", op: "toggle", index: i }); } }, s.done ? "✓" : ""),
							h(Editable, { value: s.text, className: "dotui-grow dotui-ell", style: s.done ? { textDecoration: "line-through", color: "var(--fg3)" } : null, onSave: function (v) { if (v && v !== s.text) act("/task", { id: t.id, action: "step", op: "edit", index: i, text: v }); } }),
							h("button", { type: "button", className: "dotui-rowbtn dotui-hov", title: "删掉这一步", onClick: function () { act("/task", { id: t.id, action: "step", op: "remove", index: i }); } }, "×"));
					}),
					h(Ask, { placeholder: steps.length ? "再加一步" : "拆成小步骤：先写下第一步", label: "加", onSubmit: function (text) { act("/task", { id: t.id, action: "step", op: "add", text: text }); } }),
					h("div", { className: "dotui-actions" },
						h(Btn, { kind: "primary", onClick: finish }, "完成"),
						waiting
							? h(Btn, { onClick: function () { act("/task", { id: t.id, action: "resume" }); } }, "不等了，接着办")
							: h(Btn, { kind: menu[0] === "wait" ? "on" : "", title: "等别人回复：到时提醒你追一下", onClick: function () { menu[1](menu[0] === "wait" ? "" : "wait"); } }, "在等别人…"),
						h(Btn, { title: "把这件事交给 Dot：能做的它做，要你拍板的先问你", onClick: function () { act("/task", { id: t.id, action: "delegate" }); } }, "交给 Dot"),
						h(Btn, { kind: "ghost", onClick: function () { act("/task", { id: t.id, action: "drop" }); } }, "不做了"),
						h(Btn, { kind: "danger", onClick: function () { act("/task", { id: t.id, action: "delete" }); } }, "删除"),
						h("span", { className: "dotui-muted", style: { alignSelf: "center" } }, t.id))) : null,
				(t.children || []).map(function (c) { return h(ChildRow, { key: c.id, c: c, act: act }); }));
		}

		/** 待办分组：逾期、今天、之后、收件箱、等别人。 */
		var BUCKETS = [
			["overdue", "逾期", "var(--red)"], ["today", "今天", "var(--amber)"], ["upcoming", "之后", null],
			["inbox", "收件箱 · 没定时间", null], ["waiting", "等别人", "var(--blue)"],
		];
		function bucketsOf(tasks) {
			var out = { overdue: [], today: [], upcoming: [], inbox: [], waiting: [] };
			tasks.forEach(function (t) { (out[t.bucket] || out.inbox).push(t); });
			return out;
		}
		/** 一句话记一件待办：时间、周期、今天、!高、用「；」分出的小步骤都写在这句里。 */
		function QuickAdd(props) {
			return h("div", { className: "dotui-sec", style: { gap: 4 } },
				h(Ask, { placeholder: props.placeholder || "记一件：明天9点 交周报 · 每周一9点 周会 · 今天 买牛奶 !高", label: "记下", onSubmit: function (text) { props.act("/task", { action: "add", text: text, today: Boolean(props.today) }); } }),
				h("div", { className: "dotui-muted", style: { paddingLeft: 2 } }, "用「；」分出小步骤，比如：准备周会；整理数据；写结论"));
		}

		var SUG_ICON = { brief: "☀", overdue: "⏰", waiting: "⌛", failed: "⚠", dot: "💡" };
		function SuggestionRow(props) {
			var g = props.g;
			var act = props.act;
			return h("div", { className: "dotui-item", style: { background: "var(--blueBg)", alignItems: "flex-start" } },
				h("span", { style: { width: "18px", textAlign: "center" } }, SUG_ICON[g.kind] || "💡"),
				h("div", { className: "dotui-grow", style: { minWidth: 0 } },
					h("div", { style: { fontWeight: 500 } }, g.title),
					g.body ? h("div", { className: "dotui-muted" }, g.body) : null,
					h("div", { className: "dotui-row", style: { marginTop: "4px", flexWrap: "wrap" } },
						g.options.map(function (o, i) {
							return h(Btn, { key: i, kind: i === 0 ? "primary" : "", title: o.hint, onClick: function () { act("/suggestion", { id: g.id, option: i }); } }, o.label);
						}),
						h(Btn, { kind: "ghost", title: "7 天内不再提这件事", onClick: function () { act("/suggestion", { id: g.id, dismiss: true }); } }, "忽略"))),
				h("span", { className: "dotui-muted", style: { flexShrink: 0 } }, g.source === "dot" ? "Dot 提的" : "巡检"));
		}

		function TodayTab(props) {
			var s = props.s;
			var act = props.act;
			var due = s.tasks.filter(function (t) { return t.bucket === "overdue" || t.bucket === "today"; });
			var inboxN = s.tasks.filter(function (t) { return t.bucket === "inbox"; }).length;
			var kids = [];
			s.tasks.forEach(function (t) { (t.children || []).forEach(function (c) { if (c.status === "running") kids.push(c); }); });
			s.unlinked.forEach(function (c) { if (c.status === "running") kids.push(c); });
			var sugs = s.suggestions || [];
			var nothing = !s.decisions.length && !s.notices.length && !due.length && !kids.length && !sugs.length;
			var noteToday = nothing ? "今天没有要你操心的事。" : null;
			return h("div", { className: "dotui-body" },
				h(Ask, { placeholder: "跟 Dot 说一句，让它去办", onSubmit: function (text) { act("/say", { text: text }); } }),
				s.decisions.length || s.notices.length ? h("div", { className: "dotui-sec" },
					h("div", { className: "dotui-sech" }, "需要你"),
					s.decisions.map(function (d, i) {
						return h("div", { key: "d" + i, className: "dotui-item", style: { background: "var(--amberBg)" } },
							h("div", { className: "dotui-grow" }, h("div", { style: { fontWeight: 500 } }, d.label), h("div", { className: "dotui-muted" }, d.reason)),
							d.open ? h(Btn, { kind: "primary", onClick: function () { openTarget(d.open); } }, d.kind === "question" ? "去回答" : "去处理") : null);
					}),
					s.notices.map(function (n) {
						return h("div", { key: n.id, className: "dotui-item", style: { background: n.kind === "failed" ? "var(--redBg)" : n.kind === "handoff" ? "var(--blueBg)" : "var(--greenBg)" } },
							h("div", { className: "dotui-grow", style: { minWidth: 0 } },
								h("div", { style: { fontWeight: 500 } }, n.kind === "handoff" ? n.title + " 把一件事交给你亲自做" : "「" + n.title + "」" + (n.kind === "failed" ? "出错了" : "跑完了")),
								h("div", { className: "dotui-muted dotui-ell", title: n.text }, n.text)),
							n.kind === "handoff" ? [
								h(Btn, { key: "t", kind: "primary", title: "记成一件高优先级事务，免得忘了", onClick: function () { act("/notice", { id: n.id, action: "task" }); } }, "记为事务"),
								h(Btn, { key: "d", title: "告诉 Dot 你做完了，让它接着做剩下的", onClick: function () { act("/notice", { id: n.id, action: "done" }); } }, "我做完了"),
							] : [
								n.taskId ? h(Btn, { key: "c", kind: "primary", title: "这个会话是「" + n.taskTitle + "」在等的：把那件待办勾掉", onClick: function () { act("/notice", { id: n.id, action: "complete", taskId: n.taskId }); } }, "勾掉待办") : null,
								h(Btn, { key: "o", onClick: function () { openTarget(n.open); act("/notice", { id: n.id }); } }, "打开"),
							],
							h(Btn, { kind: "ghost", onClick: function () { act("/notice", { id: n.id }); } }, "知道了"));
					})) : null,
				sugs.length ? h("div", { className: "dotui-sec" },
					h("div", { className: "dotui-sech" }, "Dot 的建议 " + sugs.length + "（点了才会做）"),
					sugs.map(function (g) { return h(SuggestionRow, { key: g.id, g: g, act: act }); })) : null,
				h("div", { className: "dotui-sec" },
					h("div", { className: "dotui-sech" }, "今天要办 " + due.length, inboxN ? h("span", { className: "dotui-muted", style: { fontWeight: 400 } }, "· 收件箱还有 " + inboxN + " 件没定时间") : null),
					due.map(function (t) { return h(TaskRow, { key: t.id, t: t, act: act }); }),
					h(QuickAdd, { act: act, today: true, placeholder: "今天还要做：写周报 · 15点 开会 · 每天9点 站会" })),
				kids.length ? h("div", { className: "dotui-sec" },
					h("div", { className: "dotui-sech" }, "Dot 派出去的活"),
					kids.map(function (c) { return h(ChildRow, { key: c.id, c: c, act: act }); })) : null,
				noteToday ? h("div", { className: "dotui-empty" }, noteToday) : null);
		}

		function TasksTab(props) {
			var s = props.s;
			var act = props.act;
			var showDone = useState(false);
			var fold = useState({ upcoming: false, inbox: false, waiting: false });
			var g = bucketsOf(s.tasks);
			return h("div", { className: "dotui-body" },
				h(QuickAdd, { act: act }),
				!s.tasks.length ? h("div", { className: "dotui-empty" }, "清单是空的。在上面写一句就记下了；也可以在任何会话里跟 Dot 说「记一下……」。") : null,
				BUCKETS.map(function (b) {
					var list = g[b[0]];
					if (!list.length) return null;
					var folded = fold[0][b[0]];
					return h("div", { key: b[0], className: "dotui-sec" },
						h("div", { className: "dotui-sech", style: { cursor: "pointer", color: b[2] || null }, onClick: function () { var n = Object.assign({}, fold[0]); n[b[0]] = !folded; fold[1](n); } },
							(folded ? "▸ " : "▾ ") + b[1] + " " + list.length,
							b[0] === "inbox" && list.length > 3 ? h("span", { className: "dotui-muted", style: { fontWeight: 400 } }, "· 挑几件点 ☀ 放进今天") : null),
						folded ? null : list.map(function (t) { return h(TaskRow, { key: t.id, t: t, act: act }); }));
				}),
				s.unlinked.length ? h("div", { className: "dotui-sec" },
					h("div", { className: "dotui-sech" }, "其他子任务"),
					s.unlinked.map(function (c) { return h(ChildRow, { key: c.id, c: c, act: act }); })) : null,
				h("div", { className: "dotui-sec" },
					h("div", { className: "dotui-sech", style: { cursor: "pointer" }, onClick: function () { showDone[1](!showDone[0]); } },
						(showDone[0] ? "▾ " : "▸ ") + "最近完成和放弃的 " + s.completed.length),
					showDone[0] ? s.completed.map(function (t) {
						return h("div", { key: t.id, className: "dotui-item" },
							h("span", { style: { color: t.status === "done" ? "var(--green)" : "var(--fg3)", width: 16, textAlign: "center" } }, t.status === "done" ? "✓" : "–"),
							h("span", { className: "dotui-grow dotui-ell", style: { textDecoration: "line-through", color: "var(--fg2)" } }, t.title),
							h("span", { className: "dotui-muted" }, fmtWhen(t.doneAt)),
							h("span", { className: "dotui-hov dotui-row", style: { gap: 4 } },
								h(Btn, { onClick: function () { act("/task", { id: t.id, action: "reopen" }); } }, "重开"),
								h(Btn, { kind: "danger", onClick: function () { act("/task", { id: t.id, action: "delete" }); } }, "删除")));
					}) : null,
					showDone[0] && s.completed.length ? h("div", null, h(Btn, { kind: "ghost", onClick: function () { act("/task", { action: "clear-completed" }); } }, "清空已完成和放弃的")) : null));
		}

		function ScheduleTab(props) {
			var s = props.s;
			var act = props.act;
			return h("div", { className: "dotui-body" },
				h(Ask, { placeholder: "提醒我：周五18点 交报告", label: "添加", onSubmit: function (text) { act("/say", { text: "/remind " + text }); } }),
				h("div", { className: "dotui-sec" },
					h("div", { className: "dotui-sech" }, "Dot 的提醒和定时任务 " + s.scheduled.length),
					s.scheduled.length ? s.scheduled.map(function (x) {
						var active = x.status === "active";
						return h("div", { key: x.id, className: "dotui-item" },
							h("span", { className: "dotui-dot", style: { background: active ? "var(--blue)" : "var(--gray)" } }),
							h("div", { className: "dotui-grow", style: { minWidth: 0 } },
								h("div", { className: "dotui-ell", style: { fontWeight: 500 } }, x.title),
								h("div", { className: "dotui-muted" }, (x.next ? "下次 " + fmtWhen(x.next) : "没有下次") + (active ? "" : " · 已暂停") + (x.running ? " · 正在执行" : ""))),
							h(Btn, { onClick: function () { act("/schedule", { id: x.id, active: !active }); } }, active ? "暂停" : "恢复"),
							h(Btn, { kind: "danger", onClick: function () { act("/schedule", { id: x.id, action: "delete" }); } }, "删除"));
					}) : h("div", { className: "dotui-empty" }, "没有排程。带时间的事务会自动加提醒。")));
		}

		var CATEGORY = { preference: "偏好", person: "人", routine: "习惯", fact: "事实", account: "账号", other: "其他" };
		function MemoryTab(props) {
			var data = props.data;
			var act = props.act;
			var list = data ? data.memories : [];
			return h("div", { className: "dotui-body" },
				h(Ask, { placeholder: "让 Dot 记住：我周末不看工作消息", label: "记住", onSubmit: function (text) { act("/say", { text: "/note " + text }); } }),
				h("div", { className: "dotui-sec" },
					h("div", { className: "dotui-sech" }, "Dot 记得的事 " + list.length),
					!data ? h("div", { className: "dotui-empty" }, "加载中…") : list.length ? list.map(function (m) {
						return h("div", { key: m.id, className: "dotui-item" },
							h(Chip, null, CATEGORY[m.category] || m.category),
							h("span", { className: "dotui-grow" }, m.text),
							h("span", { className: "dotui-hov" }, h(Btn, { kind: "danger", onClick: function () { act("/say", { text: "/forget " + m.id }); } }, "忘掉")));
					}) : h("div", { className: "dotui-empty" }, "还没有记忆。")));
		}

		var DECISION = {
			allow: { text: "放行", color: "var(--green)", bg: "var(--greenBg)" },
			preapproved: { text: "事先同意", color: "var(--green)", bg: "var(--greenBg)" },
			ask: { text: "先问你", color: "var(--amber)", bg: "var(--amberBg)" },
			handoff: { text: "交给你", color: "var(--blue)", bg: "var(--blueBg)" },
			block: { text: "拦下", color: "var(--red)", bg: "var(--redBg)" },
			none: { text: "无规则", color: "var(--fg3)", bg: "var(--line1)" },
		};
		var LADDER = [
			["paused", "暂停"], ["waiting", "等你确认或回答"], ["busy", "Dot / 子任务 / 其他会话在忙"],
			["done", "刚完成的消息（30 秒）"], ["alert", "卡住、逾期、快到期"], ["idle", "空闲"],
		];
		/** 闸门的各道关，按执行顺序；stage 对应 Host 里记下的命中次数。 */
		var STAGES = [
			{ stage: "held", name: "停下的子任务", hint: "你停掉的子任务 Dot 不能自己续上" },
			{ stage: "paused", name: "暂停", hint: "暂停时只放行只读操作" },
			{ stage: "mutation", name: "改规则", hint: "改规则永远先问你" },
			{ stage: "block", name: "禁止", hint: "你的 block 规则" },
			{ stage: "handoff", name: "交给你", hint: "付钱、密码这类 Dot 不代做" },
			{ stage: "ask", name: "先问", hint: "ask 规则，内置的可被事先同意抵消" },
			{ stage: "preapproved", name: "事先同意", hint: "你说过这类事直接做" },
			{ stage: "allow+pass", name: "放行", hint: "allow 或没有命中规则" },
		];
		var SOURCE = { builtin: "内置，不能删", config: "配置文件", chat: "对话里加的" };
		function DecisionChip(props) {
			var d = DECISION[props.decision] || DECISION.none;
			return h("span", { className: "dotui-chip", style: { background: d.bg, color: d.color } }, d.text);
		}
		function TryRule() {
			var tool = useState("");
			var args = useState("");
			var out = useState(null);
			function run(e) {
				e.preventDefault();
				post("/rules/try", { tool: tool[0], args: args[0] })
					.then(function (r) { out[1](r); })
					.catch(function (err) { out[1]({ ok: false, text: String(err && err.message || err) }); });
			}
			var r = out[0];
			return h("form", { onSubmit: run, style: { display: "flex", flexDirection: "column", gap: "6px" } },
				h("div", { className: "dotui-row" },
					h("input", { className: "dotui-input", style: { flex: "0 0 34%" }, value: tool[0], placeholder: "工具名，如 send_email", onChange: function (e) { tool[1](e.target.value); } }),
					h("input", { className: "dotui-input", value: args[0], placeholder: "参数（可空），如 给老板发周报", onChange: function (e) { args[1](e.target.value); } }),
					h("button", { type: "submit", className: "dotui-btn primary" }, "试一试")),
				r ? h("div", { className: "dotui-row", style: { alignItems: "flex-start" } },
					r.ok === false ? null : h(DecisionChip, { decision: r.decision || "none" }),
					h("div", { className: "dotui-grow", style: { color: r.ok === false ? "var(--red)" : "var(--fg2)", fontSize: "12px" } }, r.text)) : null,
				h("div", { className: "dotui-muted" }, "只是模拟判定，不会真的调用任何工具。"));
		}
		var SWATCH = { blue: "#4d6bfe", green: "#2fb36d", orange: "#ff8a3d", purple: "#8a5cf6", pink: "#f2558f", gray: "#8a8f99" };
		function PetLook(props) {
			var pet = props.data.pet || {};
			var act = props.act;
			var colors = props.data.petColors || [];
			return h("div", { className: "dotui-sec" },
				h("div", { className: "dotui-sech" }, "小精灵"),
				h("div", { className: "dotui-row" },
					h("span", { className: "dotui-muted" }, "名字"),
					h(Editable, { value: pet.name || "Dot", width: "140px", hint: "点击改名，最多 12 个字", onSave: function (v) { if (v) act("/prefs", { pet: { name: v } }); } })),
				h("div", { className: "dotui-row", style: { marginTop: "6px" } },
					h("span", { className: "dotui-muted" }, "颜色"),
					colors.map(function (c) {
						var on = (pet.color || "blue") === c;
						return h("button", {
							key: c, type: "button", title: c, "aria-label": "颜色 " + c,
							onClick: function () { act("/prefs", { pet: { color: c } }); },
							style: { width: "20px", height: "20px", borderRadius: "50%", border: on ? "2px solid var(--fg)" : "2px solid transparent", background: SWATCH[c], cursor: "pointer", padding: 0 },
						});
					})),
				h("div", { className: "dotui-muted", style: { marginTop: "6px" } }, "快捷键：在任何地方按 Alt+Shift+D 打开小精灵的输入框。"));
		}
		function RulesTab(props) {
			var data = props.data;
			var s = props.s;
			var act = props.act;
			var rules = data ? data.rules : [];
			var stats = (data && data.stats) || { counts: {}, gate: {}, recent: [] };
			var gate = stats.gate || {};
			function stageCount(stage) {
				return stage.split("+").reduce(function (n, k) { return n + (gate[k] || 0); }, 0);
			}
			function ruleRow(r) {
				var words = r.match ? r.match.split("|") : [];
				var hits = stats.counts[r.id] || 0;
				return h("div", { key: r.source + r.id, className: "dotui-item" },
					h(DecisionChip, { decision: r.decision }),
					h("div", { className: "dotui-grow", style: { minWidth: 0 } },
						h("div", null, h("span", { className: "dotui-code", style: { color: "var(--fg)" } }, r.tool), h("span", { className: "dotui-muted" }, "  [" + r.id + "]")),
						words.length ? h("div", { className: "dotui-muted" }, "参数含：" + words.slice(0, 8).join("、") + (words.length > 8 ? " 等 " + words.length + " 个" : "")) : null,
						r.note ? h("div", { className: "dotui-muted" }, r.note) : null,
						r.until ? h("div", { className: "dotui-muted", style: { color: new Date(r.until) <= new Date() ? "var(--fg3)" : "var(--amber)" } }, (new Date(r.until) <= new Date() ? "已过期：" : "有效期到 ") + fmtWhen(r.until)) : null,
						r.decision === "preapproved" && r.match && r.source !== "builtin"
							? h("div", { style: { color: "var(--red)", fontSize: "12px" } }, "⚠ 这条规则可以放行内置规则要交给你的事（付钱、密码类），请确认关键词足够窄") : null),
					h("span", { className: "dotui-muted", title: "这次 DSH 启动以来命中次数" }, hits ? "命中 " + hits + " 次" : ""),
					r.source === "chat"
						? h("span", { className: "dotui-hov" }, h(Btn, { kind: "danger", onClick: function () { act("/say", { text: "/rules del " + r.id }); } }, "删除"))
						: h("span", { className: "dotui-muted" }, SOURCE[r.source] || ""));
			}
			function group(src, title) {
				var list = rules.filter(function (r) { return r.source === src; });
				if (!list.length && src !== "chat") return null;
				return h("div", { key: src },
					h("div", { className: "dotui-muted", style: { margin: "6px 0 2px" } }, title + " " + list.length),
					list.length ? list.map(ruleRow) : h("div", { className: "dotui-empty" }, "还没有。在对话里说「以后发邮件前先问我」「给老板发周报不用问」就能加。"));
			}
			var routes = data && data.routes;
			var events = (data && data.routeEvents) || [];
			function toggle(ev, ch) {
				if (ev.channels && ev.channels.indexOf(ch) < 0) return h("td", { key: ch, className: "dotui-muted", title: "这类事只在气泡里提示，详情看 Dot 窗口和会话总览" }, "—");
				var locked = (ev.locked || []).indexOf(ch) >= 0;
				var on = routes && routes[ev.event] && routes[ev.event][ch];
				return h("td", { key: ch },
					h("input", {
						type: "checkbox", checked: Boolean(on), disabled: locked,
						title: locked ? "这一项不能关，不然你会看不到 Dot 在等你" : "",
						onChange: function () { act("/prefs", { event: ev.event, channel: ch, on: !on }); },
					}));
			}
			return h("div", { className: "dotui-body" },
				h("div", { className: "dotui-sec" },
					h("div", { className: "dotui-sech" }, "试一试：这个调用会怎么处理"),
					h(TryRule, null)),
				h("div", { className: "dotui-sec" },
					h("div", { className: "dotui-sech" }, "工具调用怎么过闸（从左到右，先拦下的算数；数字是这次启动以来的次数）"),
					h("div", { className: "dotui-pipe" }, STAGES.map(function (g, i) {
						var n = stageCount(g.stage);
						return [
							i ? h("span", { key: "a" + i, className: "dotui-arrow" }, "→") : null,
							h("div", { key: g.stage, className: "dotui-gate", title: g.hint, style: n ? { borderColor: "var(--blue)" } : null },
								h("b", null, g.name), h("div", { className: "dotui-muted" }, n + " 次")),
						];
					}), h("span", { className: "dotui-arrow" }, "→"),
					h("div", { className: "dotui-gate" }, h("b", null, "DSH 审批"), h("div", { className: "dotui-muted" }, "沙箱和权限预设"))),
					h("div", { className: "dotui-muted" }, "规则只管 Dot 和它派出的子任务，不影响你的其他会话。放行和事先同意都不会绕过 DSH 自己的审批。")),
				h("div", { className: "dotui-sec" },
					h("div", { className: "dotui-sech" }, "规则 " + rules.length),
					!data ? h("div", { className: "dotui-empty" }, "加载中…") : [group("builtin", "内置安全规则"), group("config", "配置文件里的"), group("chat", "对话里加的")],
					h("div", { className: "dotui-muted" }, "多条同时命中时：你的禁止 > 交给你 > 你的先问 > 内置先问（可被你的事先同意抵消）> 事先同意 > 放行。")),
				h("div", { className: "dotui-sec" },
					h("div", { className: "dotui-sech" }, "最近拦下和问过的"),
					stats.recent.length ? stats.recent.slice(0, 12).map(function (x, i) {
						return h("div", { key: i, className: "dotui-item" },
							h(DecisionChip, { decision: x.decision }),
							h("div", { className: "dotui-grow", style: { minWidth: 0 } },
								h("div", null, h("span", { className: "dotui-code" }, x.tool), h("span", { className: "dotui-muted" }, "  " + (x.label || "") + (x.ruleId ? " · " + x.ruleId : ""))),
								x.note ? h("div", { className: "dotui-muted" }, x.note) : null),
							h("span", { className: "dotui-muted" }, ago(x.at)));
					}) : h("div", { className: "dotui-empty" }, "这次启动以来还没有被拦下或要确认的调用。")),
				h("div", { className: "dotui-sec" },
					h("div", { className: "dotui-sech" }, "小精灵为什么是这个表情（从上往下，第一个成立的生效）"),
					h("div", { className: "dotui-ladder" }, LADDER.map(function (x) {
						var on = s && s.mood === x[0];
						return h("div", { key: x[0], className: on ? "on" : "" }, x[1] + (on ? "  ← 现在" : ""));
					}))),
				h("div", { className: "dotui-sec" },
					h("div", { className: "dotui-sech" }, "什么事通知到哪里（勾选即生效）"),
					!routes ? h("div", { className: "dotui-empty" }, "加载中…") : h("table", { className: "dotui-table" },
						h("thead", null, h("tr", null, h("th", null, "事件"), h("th", null, "小精灵气泡"), h("th", null, "通知卡"), h("th", null, "系统通知"))),
						h("tbody", null, events.map(function (ev) {
							return h("tr", { key: ev.event }, h("td", null, ev.label), ["bubble", "card", "system"].map(function (ch) { return toggle(ev, ch); }));
						}))),
					h("div", { className: "dotui-muted" }, "系统通知只在 DSH 窗口不在前台时弹，第一次需要你在浏览器里允许。")),
				data ? h(PetLook, { data: data, act: act }) : null);
		}

		var TABS = [["today", "今天"], ["tasks", "待办"], ["schedule", "排程"], ["memory", "记忆"], ["rules", "规则"]];
		// 从外面（桌面精灵的「全部待办」）要求打开某一页
		var pendingTab = null;
		var tabListeners = new Set();
		function requestTab(t) {
			if (!TABS.some(function (x) { return x[0] === t; })) return;
			pendingTab = t;
			tabListeners.forEach(function (fn) { fn(t); });
		}
		function DotPanel() {
			var tab = useState(pendingTab || "today");
			useEffect(function () {
				pendingTab = null;
				function on(t) { tab[1](t); pendingTab = null; }
				tabListeners.add(on);
				return function () { tabListeners.delete(on); };
			}, []);
			var poll = usePoll("/status", 2500);
			// 补齐列表字段：旧版 Host 或出错时返回的状态可能缺字段，面板不能因此崩掉
			var s = poll[0] && Object.assign({ tasks: [], unlinked: [], completed: [], scheduled: [], decisions: [], notices: [], suggestions: [], counts: {} }, poll[0]);
			if (s && !Array.isArray(s.tasks)) s = null;
			var needData = tab[0] === "memory" || tab[0] === "rules";
			var dataPoll = usePoll(needData ? "/data" : null, 8000);
			var a = useAct(function () { poll[1](); if (needData) dataPoll[1](); });
			var counts = s ? s.counts : null;
			var body = !s ? h("div", { className: "dotui-empty" }, "加载中…")
				: tab[0] === "today" ? h(TodayTab, { s: s, act: a[1] })
				: tab[0] === "tasks" ? h(TasksTab, { s: s, act: a[1] })
				: tab[0] === "schedule" ? h(ScheduleTab, { s: s, act: a[1] })
				: tab[0] === "memory" ? h(MemoryTab, { data: dataPoll[0], act: a[1] })
				: h(RulesTab, { data: dataPoll[0], s: s, act: a[1] });
			return h("div", { className: "dotui dotui-pane" },
				h("div", { className: "dotui-tabs" }, TABS.map(function (t) {
					var todayN = counts ? (counts.decisions || 0) + ((s && s.suggestions) || []).length : 0;
					var badge = t[0] === "today" && todayN ? " " + todayN : counts && t[0] === "tasks" && counts.active ? " " + counts.active : "";
					return h("button", { key: t[0], type: "button", className: "dotui-tab" + (tab[0] === t[0] ? " on" : ""), onClick: function () { tab[1](t[0]); } }, t[1] + badge);
				}),
				s && s.paused ? h("span", { className: "dotui-muted", style: { marginLeft: "auto", alignSelf: "center" } }, "已暂停") : null),
				// 预设有一行起不来时，DSH 会把「Dot 总管」从新建会话的预设菜单里藏起来，这里把原因摆出来
				s && s.preset && s.preset.ok === false ? h("div", { className: "dotui-presetwarn", style: { margin: "8px 14px 0", padding: "8px 10px", borderRadius: 8, background: "rgba(220,120,40,.12)", border: "1px solid rgba(220,120,40,.35)", fontSize: 12, lineHeight: 1.5 } },
					h("div", null, "「Dot 总管」预设现在加载不起来，新建会话时的预设菜单里看不到它。已有的 Dot 会话和这个面板不受影响。"),
					h("details", null, h("summary", { style: { cursor: "pointer" } }, "原因"),
						h("pre", { style: { whiteSpace: "pre-wrap", margin: "4px 0 0", fontSize: 11 } }, s.preset.broken || ""))) : null,
				body,
				// 回执贴在面板底部（外层包一层 sticky：只有一个孩子的容器里，toast 自己 sticky 不起作用）
				a[0] ? h("div", { style: { position: "sticky", bottom: 0, padding: "0 14px 10px", zIndex: 2 } }, h(Toast, { msg: a[0] })) : null);
		}

		// ── 注册 ────────────────────────────────────────────────
		var inject = ["uiWorkspace", "slots", "sidebarRightTabs", "sidebarRight", "layout"];

		function apply(ctx) {
			services = ctx;

			function openPanel() {
				try { ctx.sidebarRight.openTab(TAB_KIND); return true; } catch (e) { return false; }
			}

			var bridge = {
				version: 2,
				openSession: function (target) {
					if (typeof target !== "string" && !(target && target.parentSessionId && target.childSessionId)) {
						throw new Error("dsh-plugin-dot: 无效的会话目标");
					}
					openTarget(target);
				},
				/** 打开 Dot 会话，并展开右栏的 Dot 面板。 */
				openDot: function (sessionId, tab) {
					if (tab) requestTab(tab);
					if (sessionId) ctx.uiWorkspace.openSession(sessionId);
					setTimeout(openPanel, 400);
				},
				openPanel: openPanel,
				openSessions: function () { ctx.layout.selectPanel(PANEL_ID); },
				/** 小精灵每次拿到状态时告诉这里哪些会话是 Dot，用于自动展开面板。 */
				noteDotSessions: function () {},
				noteStatus: noteStatus,
			};

			ctx.effect(function () {
				var style = document.createElement("style");
				style.setAttribute("data-dsh-plugin-dot", "");
				style.textContent = CSS;
				document.head.appendChild(style);
				return function () { style.remove(); };
			}, "dsh-plugin-dot: styles");

			// 会话总览：整页 + 左侧栏入口
			ctx.effect(function () {
				return ctx.slots.inject("main", function () {
					return ctx.slots.register({ name: "main", key: PANEL_ID }, SessionsPage);
				});
			}, "dsh-plugin-dot: sessions page");
			ctx.effect(function () {
				return ctx.slots.inject("sidebar.panellist", function () {
					return ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 20, label: function () { return "会话总览"; } }, SessionsIcon);
				});
			}, "dsh-plugin-dot: sessions entry");

			// Dot 对话每一轮下面的事务卡、建议卡
			ctx.effect(function () {
				return ctx.slots.inject("conversation.chat.turnTail", function () {
					return ctx.slots.register({
						name: "conversation.chat.turnTail", id: "dsh-plugin-dot-turn", order: 30,
						inject: function (sessionId) { return { dotSessionId: sessionId }; },
					}, TurnCard);
				});
			}, "dsh-plugin-dot: turn cards");
			// 侧栏会话行：让 Dot 盯着
			ctx.effect(function () {
				return ctx.slots.inject("sidebar.workspaces.session.row.action", function () {
					return ctx.slots.register({ name: "sidebar.workspaces.session.row.action", id: "dsh-plugin-dot-watch", order: 50 }, RowWatch);
				});
			}, "dsh-plugin-dot: row watch");

			// Dot 窗口：右侧栏标签页
			ctx.effect(function () {
				return ctx.sidebarRightTabs.register({ id: TAB_ID, kind: TAB_KIND, priority: "extension", title: function () { return petTitle; } });
			}, "dsh-plugin-dot: panel type");
			ctx.effect(function () {
				return ctx.slots.inject("sidebar.right.pane.tab", function () {
					return ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, DotPanel);
				});
			}, "dsh-plugin-dot: panel body");

			// 打开 Dot 会话时自动展开右栏的 Dot 面板（每个会话每次加载页面只自动开一次，关掉就不再打扰）
			ctx.effect(function () {
				var dotIds = new Set();
				var opened = new Set();
				var timer = 0;
				function check() {
					var id = ctx.sidebarRight.mounted.getSnapshot();
					if (!id || !dotIds.has(id) || opened.has(id)) return;
					clearTimeout(timer);
					// 会话刚切过来时右栏的 store 可能还没建好，稍等再开
					timer = setTimeout(function () {
						if (ctx.sidebarRight.mounted.getSnapshot() === id && openPanel()) opened.add(id);
					}, 400);
				}
				var unsubscribe = ctx.sidebarRight.mounted.subscribe(check);
				bridge.noteStatus = noteStatus;
				bridge.noteDotSessions = function (ids) {
					var changed = false;
					(ids || []).forEach(function (x) { if (!dotIds.has(x)) { dotIds.add(x); changed = true; } });
					noteDot(ids);
					if (changed) check();
				};
				return function () {
					clearTimeout(timer);
					if (typeof unsubscribe === "function") unsubscribe();
					bridge.noteDotSessions = function () {};
				};
			}, "dsh-plugin-dot: auto open panel");

			ctx.effect(function () {
				window.__dshDotBridge = bridge;
				return function () {
					if (window.__dshDotBridge === bridge) delete window.__dshDotBridge;
				};
			}, "dsh-plugin-dot: bridge");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
