# 指尖动作第二版

使用内置 image_gen 默认工具编辑四张 micro-v1 图集，只重新绘制两个抬指关键帧。最终输出原样复制至项目，保留原始 RGBA；线条小点、棉花兔、糯米猫直接使用项目矢量代码优化，没有生成或修改位图。

- [whale-maiden-micro-v2.png](whale-maiden-micro-v2.png)
- [young-man-micro-v2.png](young-man-micro-v2.png)
- [young-woman-micro-v2.png](young-woman-micro-v2.png)
- [scholar-micro-v2.png](scholar-micro-v2.png)

参考图：对应角色 micro-v1 图集。服装、人物身份和其他格沿用原版。动画保持主体图不动，按清单只裁切局部手指，采用抬指、落键、轻回弹的 190ms 周期；触键短亮一小块键帽。青年男孩和书卷姑娘的编辑输出左右格相反，由清单 frame 值校准，运行时不假定格序。

鲸鱼娘仍沿用 [LICENSE.md](LICENSE.md) 的社区署名与 CC BY-NC-SA 4.0。此前设计与全部提示词见 [SEATED-SOURCES.md](SEATED-SOURCES.md)。

## 最终编辑提示词（四张分别附对应原图）

PRECISE OBJECT EDIT of this existing production sprite atlas. Preserve the exact 1536x1024, 3 columns x2 rows of512 squares, original character identity, every face, hair, torso, clothes, sleeves, keyboard and cell positions. DO NOT redesign or resize anything.
ONLY edit the fingers of the viewer-LEFT hand in cell2 (TOP-RIGHT) and the fingers of the viewer-RIGHT hand in cell3 (BOTTOM-LEFT). These two cells should now be the visible FINGER-LIFT phase of typing, not the barely visible downward press. Keep the wrist heel anchored at precisely the current point, keep forearm and sleeve completely stationary. Curl and articulate the index, middle and ring fingers so their fingertips visibly rise approximately 18-22 pixels ABOVE the home-row keys, making a small arched typing hand with distinct bent knuckles. Fingers remain directed DOWN toward their keys, palm nearly horizontal; no palm-up, pointing, waving or whole-arm lift. The opposite hand must stay exactly as in cell0. Show a clean patch of clothing/keyboard behind where the moved fingertips used to be; no ghost fingers. Five fingers per hand, no extra hands.
Cells0,1,4,5 must remain EXACTLY UNCHANGED. All non-finger pixels in cells2,3 should remain aligned with cell0. Keep original linework and colors. Production cutout with true transparent alpha ZERO outside each character and keyboard. Remove all apparent gray/brown background haze; no background, glow, shadow, border, captions, motion streaks or text. This is a localized animation edit, not a new illustration.
