# 发版和曝光清单

每次发新版本照着走一遍。前半是发版，后半是让社区知道。

## 一、发版

1. `node --test tests/` 全部通过。
2. `package.json` 的 `version` 改成新版本号；`CHANGELOG.md` 把「未发布」改成「## x.y.z（日期）」。
3. 检视 README（中文、英文）：新功能有没有写进「界面一览」和路线图，截图和动图是否过时，测试数量、兼容的 DSH 版本是否还对。
4. 回复相关 issue，修好的关掉。
5. 提交，打 tag `vx.y.z`，推送，在 GitHub 上用 CHANGELOG 的这一节发 Release。
6. 在一个全新的 `DSH_HOME` 里验证从 GitHub 安装：

   ```bash
   DSH_HOME=/tmp/dot-check dsh plugin --profile web add github:h958661134/dsh-plugin-dot#vx.y.z
   ```

   启动后 `GET /api/dsh-plugin-dot/status` 里 `preset.ok` 为 `true`。

## 二、曝光

各渠道只需要首次登记一次，之后多数会自动跟上，只有少数需要手动更新。

| 渠道 | 首次 | 之后每个版本 |
|---|---|---|
| GitHub topic（`dsh-plugin` 等） | 已加 | 不用动。dsh.so 和 awesome 列表的全量目录按这个 topic 自动索引 |
| [awesome-dsh-plugins](https://github.com/cccakeee/awesome-dsh-plugins) | 已提 [PR #68](https://github.com/cccakeee/awesome-dsh-plugins/pull/68)：在 `data/verified-plugins.csv` 加一行，再运行 `python scripts/generate_docs.py` 重新生成 README 和分类页（README 不要手改；Windows 上生成后要把 CRLF 换回 LF） | 只有能力描述、安装方式、权限或兼容的 DSH 版本变了，才提 PR 改这两行。小版本不用提 |
| [deepseekharnessplugins.com](https://deepseekharnessplugins.com/submit) | 跟着 awesome 列表同步 | 同上，不用单独操作 |
| [dsh.so](https://www.dsh.so/zh/submit/) | 用检查器检查后提交；topic 也会被自动索引 | 星标、提交时间自动同步。大版本可以再跑一次检查器 |
| 官方 Discussions「Show Your Plugins!」 | 已发 [#13048](https://github.com/deepseek-ai/deepseek-harness/discussions/13048)（格式按置顶帖 #2004） | **不要再开新帖**（规则写明重复帖会被删）。在原帖下回复一条更新说明：版本号、两三条亮点、一张新图，并把原帖正文里过时的地方改掉 |
| npm（可选） | 用作者自己的账号 `npm login` 后 `npm publish --access public` | 每个版本 `npm publish`。发了 npm 之后，README 的安装命令可以改成包名 |

升级方式已实测：不带 `#tag` 安装的用户，重新运行同一条 `dsh plugin … add github:…` 命令就会拿到最新提交。

### Discussions 更新回复的模板

```markdown
**vx.y.z 已发布**：https://github.com/h958661134/dsh-plugin-dot/releases/tag/vx.y.z

- 亮点一
- 亮点二

升级：重新运行 `dsh plugin --profile web add github:h958661134/dsh-plugin-dot`（桌面版 `--profile desktop`），然后完全退出 DSH 再打开。
```

### 写对外文案的原则

- 只写能验证的事实：做了什么、怎么装、会访问什么（本地文件、会话、网络、按键）。不写「最好」「安全」「官方」。
- 写明是非官方的社区项目。
- 图片用 `https://raw.githubusercontent.com/h958661134/dsh-plugin-dot/main/docs/images/…`，替换仓库里的图片后，帖子里的图会自动更新。
