# 卡通人物 v2 素材记录

2026-11-14，使用内置 image_gen 工具生成和编辑。六格图片沿用站立、招手、闭眼、桌边中立、左右手跟敲的布局。三者采用更大的头部比例、明确描边和简洁色块；没有修改运行时输入或任务逻辑。

## 交付文件

- whale-maiden-v2.png：DeepSeek 社区鲸鱼娘风格参考，蓝白女仆裙、鲸鳍耳、大鲸尾。第一次生成后仅调整了两格抬手方向，使掌心朝向键盘。
- young-man-v2.png：以本项目 young-man-v1.png 为人物身份与服装参考，以卡通鲸鱼娘初稿为线条和比例参考。
- young-woman-v2.png：以本项目 young-woman-v1.png 为人物身份与服装参考，以卡通鲸鱼娘初稿为线条和比例参考。

## 鲸鱼娘参考来源与署名

- [参考图集](https://iphsiibl.github.io/deepseek-whale-girl-gallery/)
- [使用的女仆鲸鱼娘参考图](https://iphsiibl.github.io/deepseek-whale-girl-gallery/moegirl/02-nvpu-whale-girl.png)
- 图集标注：原型为上善无形的原创角色「溟月」，女仆版设计为 ZipZipPipe；该形象是社区二创。
- 图集为这组形象标注 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)。本项目 whale-maiden-v2.png 作为该参考的卡通化衍生素材沿用此许可与署名；不属于插件代码的 MIT 授权范围。参考原图只留在本地 .preview/references，未装入插件包。
- 本次修改：重新绘制为卡通比例、简化色块与衣褶、增加六个桌宠姿态、制作透明通道与左右手键盘动作。

## 鲸鱼娘生成提示词

Create a production transparent PNG sprite atlas for a desktop companion, using the attached image ONLY as character design reference for the recognizable DeepSeek community whale-maid girl. Redraw in a visibly more CARTOON style for a small desktop pet: stylish four-head-tall proportions, slightly oversized expressive head and hands, confident clean dark-blue outlines, simple flat color shapes, one crisp cel-shadow tone, simplified large hair locks and folds. Charming young adult character with a self-possessed playful face, not a toddler, not a blob, not realistic fashion illustration, not painterly, no glossy airbrush. Preserve reference identity: blue eyes, long wavy navy-to-sky-blue hair, curved ahoge, blue-white whale-fin ears, white frill maid headband with small blue bow, navy blue long maid dress, white apron with small simple blue whale emblem, modest ivory blouse and sleeves, small gold details, white socks, dark blue Mary Jane shoes, and ONE large blue whale tail with two terminal flukes behind her, completely inside each cell.

EXACT format: one 1536x1024 transparent RGBA image, seamless unmarked 3 columns by 2 rows, each cell exactly 512x512. No grid lines, no labels, no text, no backdrop, no floor, no cast shadow, no vignette, no glow or haze. Outside the character/keyboard silhouettes fully transparent alpha ZERO, including gaps between hair, limbs and tail.
Top row three full-body poses, complete head, hair, shoes and tail within each 512 square with safe padding. Identical design, scale, camera and anchor in all top cells. Cell 0 calm standing looking toward viewer. Cell 1 same stance with a small friendly wave. Cell 2 same standing calmly closing eyes, arms relaxed.
Bottom row three waist-up desk portraits with the SAME face, expression, open eyes, hair, body, proportions and keyboard position across all three cells. Use a large readable head and shoulders with both hands clearly visible over a small slim gray keyboard at the bottom of each square. NO desk surface or background. Cell 3 both hands resting lightly on keyboard. Cell 4 viewer-left hand raised a palm height with bent elbow, viewer-right hand pressing keys. Cell 5 viewer-RIGHT hand raised a palm height with bent elbow, viewer-LEFT hand pressing keys. Only arms/hands differ in the bottom row; do not change the face or close one eye. Each pose remains entirely in its cell and no part crosses the x=512/1024 or y=512 cell boundaries.
The result must unmistakably be clean cartoon sprite artwork rather than the previous tall seven-head anime illustrations.

## 鲸鱼娘手部修正提示词

Edit only the TWO RAISED HANDS in the bottom-middle and bottom-right cells of this six-cell atlas. Keep all other drawings, faces, scale, positions, outfits and colors unchanged, especially the three full-body poses and bottom-left neutral pose. These are keyboard typing frames, so remove the palm-up presenting gestures. Bottom-middle: viewer-left hand is raised just 30 pixels ABOVE ITS OWN HALF OF THE KEYBOARD, palm facing DOWN, fingers curled down poised to tap; viewer-right hand continues pressing keys. Bottom-right: viewer-right hand raised just 30 pixels ABOVE ITS OWN HALF OF THE KEYBOARD, palm facing DOWN, fingers curled down poised to tap; viewer-left hand continues pressing keys. Elbows low, hands directly over keys, no hand near shoulders, no shrug, no wave or palm-up gesture. Preserve clean cartoon style. Exact 1536x1024 3x2 grid,512 square cells. Keep all backgrounds fully transparent alpha zero, no haze, glow, shadow, colored matte or background.

## 美少年提示词

Production transparent PNG sprite atlas for our desktop companion. Input 1 is the EDIT TARGET and identity/costume reference. Input 2 is a STYLE REFERENCE only: match its clean bold dark contours, large readable expressive eyes, simplified hair locks, simple flat color areas, crisp single-tone cel shadows, and stylish approximately FOUR-head-tall cartoon proportions. Keep the edit target's own identity and outfit; do not borrow the maid costume, blue hair, tail, or fin ears from the style reference. Redraw the entire atlas in this substantially more cartoon visual language. A charming stylized adult rather than a baby, toddler or blob. No painterly rendering, airbrush gradients, realistic fabric texture, or seven-head fashion proportions.
Output exactly 1536x1024, three columns by two rows of 512x512 square cells. Same character in each cell. Top row: full body calm standing, same stance small friendly wave, same stance eyes gently closed. Complete hair and shoes fit within each cell, safe padding, same camera/anchor/scale.
Bottom row: three identically aligned waist-up front-facing portraits behind a small slim neutral-gray keyboard at the bottom. Exactly same face, open eyes, slight smile, hair, outfit, head/torso and keyboard position across all three. Only hands/forearms change. Cell 3 both hands lightly on keys. Cell 4 viewer-left hand lifted 30 pixels just above the keyboard with PALM DOWN and fingers curled downward ready to tap, viewer-right hand pressing keys. Cell 5 viewer-right hand lifted 30 pixels just above the keyboard PALM DOWN fingers curled downward, viewer-left hand pressing keys. Elbows stay low and close to body, hands stay directly over their half of the keyboard. No palm-up presentation gesture, no shrug, no raised hand beside the face, no pointing. Clean recognizable hands with simplified fingers. No winking in typing frames.
True RGBA transparency: every pixel outside character/keyboard silhouette must be fully transparent alpha ZERO. No white or gray backdrop, no black fill, no haze/glow/halo/cast shadow, no gradient behind character, no cell panels, no captions, no grid lines, no decorative props. Keep all art within each square and do not cross cell boundaries.
Character to preserve from input 1: handsome young adult man, black layered hair with one silver forelock, gray-green eyes, black tailored casual jacket over an ivory shirt, dark trousers, black shoes, discreet silver pendant. Use an easy confident smile and appealing cartoon features, concise hair shapes, crisp black/ivory color blocking.

## 美少女提示词

Production transparent PNG sprite atlas for our desktop companion. Input 1 is the EDIT TARGET and identity/costume reference. Input 2 is a STYLE REFERENCE only: match its clean bold dark contours, large readable expressive eyes, simplified hair locks, simple flat color areas, crisp single-tone cel shadows, and stylish approximately FOUR-head-tall cartoon proportions. Keep the edit target's own identity and outfit; do not borrow the maid costume, blue hair, tail, or fin ears from the style reference. Redraw the entire atlas in this substantially more cartoon visual language. A charming stylized adult rather than a baby, toddler or blob. No painterly rendering, airbrush gradients, realistic fabric texture, or seven-head fashion proportions.
Output exactly 1536x1024, three columns by two rows of 512x512 square cells. Same character in each cell. Top row: full body calm standing, same stance small friendly wave, same stance eyes gently closed. Complete hair and shoes fit within each cell, safe padding, same camera/anchor/scale.
Bottom row: three identically aligned waist-up front-facing portraits behind a small slim neutral-gray keyboard at the bottom. Exactly same face, open eyes, slight smile, hair, outfit, head/torso and keyboard position across all three. Only hands/forearms change. Cell 3 both hands lightly on keys. Cell 4 viewer-left hand lifted 30 pixels just above the keyboard with PALM DOWN and fingers curled downward ready to tap, viewer-right hand pressing keys. Cell 5 viewer-right hand lifted 30 pixels just above the keyboard PALM DOWN fingers curled downward, viewer-left hand pressing keys. Elbows stay low and close to body, hands stay directly over their half of the keyboard. No palm-up presentation gesture, no shrug, no raised hand beside the face, no pointing. Clean recognizable hands with simplified fingers. No winking in typing frames.
True RGBA transparency: every pixel outside character/keyboard silhouette must be fully transparent alpha ZERO. No white or gray backdrop, no black fill, no haze/glow/halo/cast shadow, no gradient behind character, no cell panels, no captions, no grid lines, no decorative props. Keep all art within each square and do not cross cell boundaries.
Character to preserve from input 1: attractive young adult woman, long burgundy hair with side braid, warm eyes, small gold drop earrings, ivory collared blouse, charcoal midi skirt and burgundy waist ribbon, dark ankle boots. Use friendly expressive cartoon eyes, a calm playful smile, simplified flowing hair, crisp ivory/burgundy/charcoal color blocking.


## 动作扩展

preview.5 新增三个人物各自的生活动作与连续跟敲图集；六张图片路径、提示词及生成方式见 [MOTION-SOURCES.md](MOTION-SOURCES.md)。鲸鱼娘衍生图集继续遵守本页署名与许可。
