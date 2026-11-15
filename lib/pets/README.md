# 精灵图鉴与替换接口

`catalog.json` 是 Windows WPF、网页 SVG 和角色选择器的共同来源。当前支持四个人物与三款简洁线条。人物为鲸鱼娘、阳光男孩、青春女孩、书卷姑娘；桌边与坐姿共用同一身份、衣装和画风。资源本地加载，不调用图片生成模型。

人物使用原画配色与服饰。名字、任务、专注、统计和旧装扮偏好独立保存。已保存的 `young-man` / `young-woman` ID 继续有效；未知或已撤下 ID 显示默认鲸鱼娘，不改写原 ID。

## 当前图片契约

`renderer: dot-atlas-v1`，`animations.style: seated-v2`。`atlas` 与 `animations.life` 指向同一张坐姿图，`animations.typing` 指向指尖图。每张为透明 PNG，1536 × 1024，3 列 × 2 行，每格 512 方形。各格按先行后列排列：

| 索引 | life / atlas | typing |
| --- | --- | --- |
| 0 | 全身中立坐姿 | 桌边中立，手腕放低 |
| 1 | 相同坐姿闭眼 | 相同桌边构图闭眼 |
| 2 | 坐姿个性动作 | 一侧指尖抬起，左右以清单为准 |
| 3 | 坐着托腮 | 另一侧指尖抬起，左右以清单为准 |
| 4 | 托起悬空 | 桌边托腮 |
| 5 | 头部与小手从左侧探出 | 双手低位靠拢休息 |

敲击始终保留 typing 第 0 格，只在手指范围合成第 2 / 3 格。身体、键盘、手腕不跟随换帧。眼部也独立合成，托腮时不用正面闭眼贴片。

`animations` 额外元数据：

- `seatY`：座沿在 512 方格中的纵向比例，范围 0.45～0.85。
- `edgeX`：左侧探头原画的接触线比例，范围 0～0.45；右侧运行时镜像。
- `peekScale`：探头格缩放，范围 0.4～1，保持头部与正常人物比例接近。
- `blink.desk / blink.sit`：眼部贴片；旧图集还可使用 standing。
- `fingers.left / fingers.right`：必需的左右指尖贴片。

每个贴片含 `sheet: base|life|typing`、`frame: 0..5`、`source` 与 `target`。指尖贴片可另含 keycap: [x,y,width,height]，表示落键反馈的位置，与手部贴片坐标同样受校验。矩形均为 `[x,y,width,height]`，使用 512 方格坐标且不得越界。必须逐角色校准。WPF 缓存 CroppedBitmap，网页通过 SVG viewBox 裁切，不改写原画。

## 添加与替换

PNG 放在 assets，加入 characters 项，选择器会自动出现。复制一个完整当前角色作为配置起点，再校准眼部、指尖、座沿和接触线。替换现有角色应保留 ID，并使用新资源文件名避免旧缓存；defaultCharacter 必须存在。

文件名只接受小写字母开头的字母、数字、短横线与 .png；不接受路径、URL、SVG 或脚本。宽高最高 4096，必须与图片匹配。网页只提供图鉴内的精确资源路由，Windows 只从安装目录读取。

抬指增强素材与完整提示词见 [FINGER-SOURCES.md](assets/FINGER-SOURCES.md)。此前素材与完整提示词见 [SEATED-SOURCES.md](assets/SEATED-SOURCES.md)，许可见 [LICENSE.md](assets/LICENSE.md)。旧原画留在仓库，打包时排除已撤下的旧 PNG。旧 micro-v1 也不再打包。新增文件名不要套用 package.json 中历史资源的排除模式。

## 动作与兼容

`prefs.pet.posture` 仍使用 desk / classic，界面显示「桌边跟敲」/「任务栏坐姿」。classic 直接坐下。跟敲默认开启，显式关闭保留，按键统计不自动开启。一次指尖动作 190ms，脉冲限速 65ms，仅保留一个最近续击，低帧率不补播旧输入。

空闲 16 秒后托腮约 3.2 秒，之后每 31 秒重复；24 秒后个性动作约 2.4 秒，每 38 秒重复。眨眼约 5.1 秒一次，持续 180ms；呼吸缩放不超过 0.3%。托起最大约 2° 轻晃。贴边隐藏、再探头约 12 秒循环，悬停立即展示；少动一点时保持静态。

专注、休息、待确认、暂停、安静、减少动画优先；物理反馈优先于手动动作。网页隐藏后停止 RAF，dispose 清理。Windows 对齐任务栏座沿，留 4px 足部余量；底部可用高度不足 20px 时不下沉。

网页入口：setArt / setOptions / tap / play / setEnvironment({held,falling,edge,velocity,hover}) / dispose。运动模型为 pet-motion.js。Windows 适配器为 desktop/pet-atlas.ps1，新状态机为 desktop/pet-seated.ps1，通用输入在 pet-companion.ps1。新增皮肤应沿用这些接口。

未声明 seated-v2 的旧六格图集继续使用原动画契约；dot-vector-v1 同时用于简洁线条与损坏兜底。小点、棉花兔、糯米猫声明 style: soft-line-v2，支持奶白线条、收腿坐姿、呼吸和眨眼；保留旧 radius / ahoge / back / front 图层契约和装扮、配色。全身不自动走动。八个旧互动 ID 保留，人物按当前姿态映射到可用小动作；PNG 不是骨骼，不能直接复用旧矢量手臂关键帧。

## 验证

运行 npm test 与 node scripts/preview-pet.mjs。默认 http://127.0.0.1:4174，DOT_PREVIEW_PORT 可覆盖端口；POST /demo/reset 重置演示数据。

Windows 开发验证：DOT_PET_ART_SHOTS 指向隔离输出目录，用本地预览服务作为 StatusUrl，并指定隔离 StateFile。脚本只导出自身渲染，不截取桌面，不注入输入，校验后退出。覆盖四人物、即时指尖交替与复位、眼部贴片、工作优先、紧凑尺寸、托起、藏猫猫、任务栏边界和输入挂钩生命周期。
