# 人物动作素材记录

2026-11-14。使用内置 image_gen 默认工具模式，以三个 `*-v2.png` 为人物身份、服装和线条参考，分别生成生活动作和跟敲图集。输出直接复制进项目，保留原始透明通道；裁切、眼部贴片、镜像与过渡由 SVG / WPF 在运行时完成。

## 修图记录

鲸鱼娘生活动作 v2 局部缩小左下和中下格的呆毛，使其完整落在各自 512 方格内；脸、身体和动作位置保持。使用同一内置 image_gen 工具编辑 v1，提示词：

Edit ONLY the small curved ahoge/cowlick above the head of the BOTTOM-LEFT and BOTTOM-MIDDLE characters in this exact atlas. They currently cross the y=512 grid boundary and will be clipped when the bottom row is sliced into square sprites. Remove each of those two oversized loops completely and replace it with a small tidy curved loop that fits entirely INSIDE its own bottom-row cell, with ALL its pixels below y=526, to the upper-left of the head. Keep heads, faces, eyes, hair other than these two loops, body, hands, costume, feet, keyboard, every other cell and all positions EXACTLY UNCHANGED. This is a tiny targeted correction; do not redraw the character or shift/resize any pose. Do not add marks, lines or background. Preserve the exact 1536x1024 three-by-two grid, original RGBA transparency, original outlines and colors. Keep every other existing silhouette intact.

v2 检查发现半透明背景残留，未采用；再次用内置 image_gen 进行背景移除，输出 v3。校验为 1536×1024 RGBA，935497 个完全透明像素，空白区采样 alpha 均为 0。v3 为最终运行时素材。背景移除提示词：

BACKGROUND REMOVAL ONLY. Make this exact six-pose whale-maid sprite sheet a clean transparent cutout. The image currently has unwanted semi-transparent dark blue/gray gradients and halos covering the empty areas behind the characters. DELETE ALL of that background, including dim haze between figures and in gaps between hair, limbs and tail. Every pixel that is not actual character clothing/hair/skin/outline or the keyboards must have alpha exactly ZERO, not translucent gray. Keep anti-aliasing only along the immediate 1-pixel contour of the drawings. Do NOT change, redraw, shift, enlarge, shrink, recolor or rearrange ANY of the six characters or keyboards, especially keep the small corrected hair loops in the bottom-left and bottom-middle. Exact 1536x1024 PNG,3x2 grid of512. This is background removal, NOT a new illustration. No gradients, glows, drop shadows, haze or background panels anywhere.

## 保存文件

- [whale-maiden-life-v3.png](whale-maiden-life-v3.png)
- [whale-maiden-typing-v1.png](whale-maiden-typing-v1.png)
- [young-man-life-v1.png](young-man-life-v1.png)
- [young-man-typing-v1.png](young-man-typing-v1.png)
- [young-woman-life-v1.png](young-woman-life-v1.png)
- [young-woman-typing-v1.png](young-woman-typing-v1.png)

鲸鱼娘两张新图集沿用 [CARTOON-SOURCES.md](CARTOON-SOURCES.md) 的社区角色署名与 CC BY-NC-SA 4.0 许可。角色原型：上善无形「溟月」；女仆版设计：ZipZipPipe。本次新增闭眼、托腮、悬空、贴边、坐姿及左右手连续敲击关键帧。

## 生活动作提示词（三个角色共用，每次附对应 v2 图集）

Use the attached six-cell cartoon character atlas as an EXACT identity, costume, color, linework, and scale reference. Create an additional LIFELIKE ACTION atlas for THIS SAME adult cartoon desktop companion. Keep recognizable face, hair and every costume feature unchanged. This is a production sprite asset, not concept art.
Output ONE 1536x1024 RGBA transparent image, exact 3 columns x 2 rows of 512x512 squares, no grid lines or text. Safe padding. No backdrop, vignette, gray/brown haze, glow, cast shadow, floor, furniture, chair, taskbar or screen border. Only the character and the keyboard in desk poses. Empty pixels outside silhouette alpha ZERO.
Cell 0 top-left: EXACT duplicate of reference bottom-left desk-neutral half-body composition, keyboard in exactly same location, same relaxed hands on keys, SAME head/torso/face placement, ONLY gently closed eyelids for a blink. Do not turn or tilt head, change smile or move body.
Cell 1 top-middle: SAME desk scale/composition and keyboard, one elbow at desk height, cheek/chin resting softly in that hand, other hand relaxed on keyboard, thoughtful gentle face looking slightly aside. No extra table.
Cell 2 top-right: FULL BODY being gently picked up by an invisible cursor from the upper back/shoulders, both feet dangling and knees slightly bent, arms loosely lifted outward a little, mild surprised expression. No cursor, string, hand holding them or any prop. Same four-head proportions as reference standing pose.
Cell 3 bottom-left: FULL BODY lightly clinging/leaning on an INVISIBLE VERTICAL EDGE ON THE VIEWER-LEFT, both palms resting against that invisible vertical line at x=90, body facing three-quarter toward viewer-right with curious face peeking inward; knees softly bent. No drawn wall, screen, line or background. Entire character visible in cell. Same scale as standing.
Cell 4 bottom-middle: FULL BODY seated on an INVISIBLE horizontal taskbar ledge, hips/seat point at y=380 within its cell, upper body upright, two relaxed hands resting beside hips/on lap, lower legs dangling naturally and shoes fully visible near y=485. Keep whole head/hair and any tail inside cell. No seat, stool, chair or horizontal line. Calm smile and open eyes.
Cell 5 bottom-right: SAME EXACT seated character composition, head/torso size, hips at y=380 and shoes near485 as cell4, one elbow on knee and chin resting on that hand, thoughtful relaxed expression; other hand on lap. No props.
For the whale-maid preserve her single whale tail and fin ears, do not add them to other characters. Keep all details comfortably within each 512 square. The two desk cells must fit the existing desk animation, the seated pair must have identical alignment.

## 跟敲提示词（三个角色共用，每次附对应 v2 图集）

Create six consecutive KEYBOARD ANIMATION keyframes for the exact same cartoon adult character as the reference atlas. The reference bottom-left desk pose is the frozen master layout. Copy its face, OPEN eyes, smile, head, torso, hair and costume exactly into all six new cells; identical camera, position and size. All six cells are waist-up keyboard views, NO full-body views. Do not redraw the face differently per frame; do not tilt/turn the head or change expression. Use exactly the reference clean outlines and flat cel colors.
Output 1536x1024 true transparent RGBA, 3 columns by 2 rows, each square512. Identical head top/keyboard bottom locations from the reference lower-left 512 square. Every background pixel outside character+keyboard is alpha ZERO; no haze, glow, black/white backdrop, shadows or grid lines or text.
Top row is the viewer-LEFT hand's typing stroke; opposite hand stays resting on its keys:
cell0: LEFT hand raised noticeably HIGH 85 pixels above its half of the keyboard, elbow low, palm DOWN, fingers curved toward keys.
cell1: LEFT hand halfway down 40 pixels above its keys, fingers curved down, same arm path.
cell2: LEFT fingertips visibly touching/depressing keys, wrist low, fingers bent in contact. Right hand stays resting.
Bottom row is the viewer-RIGHT hand's typing stroke; opposite hand stays resting on its keys:
cell3: RIGHT hand raised HIGH 85 pixels directly above its keys, palm DOWN, fingers curved.
cell4: RIGHT hand halfway down 40 pixels above its keys.
cell5: RIGHT fingertips touching/depressing keys, wrist low, visible contact.
Hands stay directly OVER keyboard, elbows close to body. No waving, palms facing up, pointing, arms beside the face, extra hands or extra fingers. The keyboard remains IDENTICAL and perfectly aligned in all six cells. Same head/body/hair throughout, only active forearm/hand moves; show enough clearance to read the motion at 180px display size. Keep all shapes within each cell.
