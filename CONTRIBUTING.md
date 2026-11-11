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

## 提交改动

- 每个改动都配上测试，提交前跑一遍 `npm test`。
- 改了界面，在 PR 里附截图。
- 新增「替用户做事」的能力时，先想清楚它属于哪一类：只读、起草后等用户点、还是必须交给用户亲自做。默认选更保守的那一类，理由见 [README 的安全模型](README.md#安全模型)。
