# DSH 插件工程路线图

目标：为 DeepSeek Harness（DSH）做一批高质量插件，争取官方的插件作者激励。截至 2026-11，官方激励计划仍在筹备，公开的方向是 Token 激励、技术交流和作品推荐，具体规则以官方公告为准。

## 平台要点（来自 DSH 0.2.2-rc.1 源码与本机实测）

- 插件就是 Cordis 插件：一个导出 `name` / `inject` / `apply(ctx, config)` 的 ESM 模块。
- 分发单位是 **bundle**：在 `package.json` 里声明 `dsh.bundle.patch`，指向一个 `cordis.patch.yml`；用户通过 `dsh plugin --profile <name> add <包>` 安装。
- 发现渠道：GitHub 仓库加上 `dsh-plugin` topic，npm 关键词加 `dsh-plugin`，也可以收录到自建的插件索引（plugin index JSON）。
- 主要扩展点：`ctx.tools.register`（工具）、`ctx.systemPrompt.section/context`（提示词）、`tools/pre-execute`（策略闸门）、`@deepseek-ai/dsh-agent-preset`（预设）、`ctx.schedule`（定时）、`ctx.subagents`（子代理）。
- 经验：
  - 写纯 JS 加 `@ts-check`，不依赖 `@deepseek-ai/*` 运行时包，兼容性最好。
  - 预设子插件的 `tools/pre-execute` 监听器会按 agent 作用域过滤。
  - 测试叠加层里不要用 `E:/...` 这种 Windows 绝对路径作为预设子插件的模块名，否则会报 "never started"。
  - npm 上 `dsh-dot` 已被别人占用。

## 插件规划

| # | 插件 | 定位 | 状态 |
|---|---|---|---|
| 1 | **dsh-plugin-dot**（Dot 总管） | 对标 ChatGPT Dots 的个人总管预设：记忆、事务、规则、主动简报、委派 | v0.1.0 已完成，待在真实模型上试用 |
| 2 | Dot 渠道桥 | 把 Dot 接到微信 / 飞书 / 钉钉 / Telegram，实现手机上收简报、回消息 | 规划 |
| 3 | Dot 收件箱面板 | Web UI 侧边栏显示事务清单、记忆和规则，可以手动编辑 | 规划 |
| 4 | Dot 连接器 | 日历 / 邮件 / 网盘只读接入，让简报带上日程和未读邮件 | 规划 |
| 5 | 记忆语义检索 | 记忆量大时用向量检索替代全文搜索 | 规划 |

## Dot v0.2 候选

- 用 `ConversationNodeDefinition` 给工具结果做卡片渲染（事务卡、简报卡）。
- 简报自动建立：检测到不存在每日简报提醒时，直接调 `ctx.schedule` 创建，而不是靠模型提议。
- 事务和提醒双向关联：提醒触发时自动更新事务状态。
- 多语言 `displayReason` 和工具描述（en / zh）。
- 发布到 npm，并提交到社区 awesome 列表和插件索引。
