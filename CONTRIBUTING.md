# 参与开发

谢谢你愿意改进 Dot。

## 反馈问题

- **用起来别扭、看不懂、想要新功能**：用 [使用反馈](https://github.com/h958661134/dsh-plugin-dot/issues/new?template=feedback.md) 模板提 issue。零散的感受也欢迎。
- **出错了**：用 [问题报告](https://github.com/h958661134/dsh-plugin-dot/issues/new?template=bug.md) 模板，写上 DSH 版本、操作步骤和看到的结果。

提交前请把截图和日志里的 API key、token、个人路径打码。

## 本地开发

```bash
git clone https://github.com/h958661134/dsh-plugin-dot.git
cd dsh-plugin-dot
npm test
```

- 不需要 `npm install`：运行时和测试都只用 Node 22 自带的模块。
- 代码是纯 JavaScript ESM 加 `@ts-check`，不需要构建。浏览器端的 `lib/bridge.js` 和 `lib/client.js` 是手写的 ES5，直接注入页面。
- 代码结构见 [功能参考](docs/FEATURES.md#代码结构)。

### 在真实 DSH 里试

用一个隔离的 `DSH_HOME`，不要动你日常用的 profile：

```bash
export DSH_HOME=/tmp/dsh-dev        # Windows PowerShell：$env:DSH_HOME = "D:\dsh-dev"
dsh plugin --profile web add /path/to/dsh-plugin-dot
dsh --profile web --no-open --port 3999
```

改了代码要重启这个 DSH 才会生效。

### 单独预览界面

不启动 DSH，也可以在浏览器检查真实的插件组件：

```bash
npm install --prefix .preview --ignore-scripts --no-audit --no-fund react@18.3.1 react-dom@18.3.1
node scripts/preview-ui.mjs
```

打开 `http://127.0.0.1:4173`。顶部可以切换今天、待办、会话总览与深浅主题。
用 `?view=tasks&width=320&theme=dark` 检查窄侧栏，用 `&empty=1` 或 `&offline=1` 检查空状态和断线提示。
预览使用 `lib/bridge.js` 和浏览器内的演示数据，支持添加与完成演示待办，其他写操作只返回演示回执；刷新即还原，不读写日常 DSH 数据。
预览依赖仅放在忽略的 `.preview` 目录里，不会进入插件发布包。

精灵的独立预览不需要安装依赖：`node scripts/preview-pet.mjs`，然后打开 `http://127.0.0.1:4174`。形象和动作的扩展约定见 [精灵图鉴](lib/pets/README.md)。

## 提交改动

- 每个改动都配上测试，提交前跑一遍 `npm test`。
- 改了界面，在 PR 里附截图。
- 新增「替用户做事」的能力时，先想清楚它属于哪一类：只读、起草后等用户点、还是必须交给用户亲自做。默认选更保守的那一类，理由见 [README 的安全模型](README.md#安全模型)。

## 发版

维护者发新版本时，照 [docs/RELEASE.md](docs/RELEASE.md) 走一遍：测试、版本号、README、Release，以及之后在各社区渠道怎么更新。
