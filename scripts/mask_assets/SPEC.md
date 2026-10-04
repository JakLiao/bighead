# 位图蒙版素材规范

预置蒙版（`maskDefs.ts`）是**代码现绘**的 Path2D 图形，没有位图素材。
本目录定义**位图蒙版**的素材规范：图库里除内置蒙版之外的条目，都来自这里。

## 为什么需要位图蒙版

代码蒙版擅长"心形、星星、云朵"这类几何镂空 + 简笔贴纸，
但做不出图 1 那种**珍珠蕾丝 + 玫瑰花 + 金线**的华丽边框，
也做不出图 2 那种**粗描边卡通贴纸**的成套插画。
这两类需要美术素材，故引入 PNG。

## 目录约定

```
frontend/public/masks/
  manifest.json        # 图库清单(唯一入口,前端只读它)
  *.png                # 蒙版图,文件名 = manifest 里的 src
```

Vite 会把 `public/` 原样映射到根路径，所以 `src` 写 `pearl_heart.png`
即对应运行时地址 `/masks/pearl_heart.png`（前端会自动补 `/masks/` 前缀，
见 `maskLibrary.ts`）。

## PNG 硬性要求

| 项 | 要求 | 原因 |
| --- | --- | --- |
| 色彩模式 | RGBA（必须带 alpha 通道） | 透明区即"人脸窗口" |
| 画布尺寸 | 4:3，建议 1200×900 | 与 `snap()` 的出片比例一致，`drawImage` 1:1 贴合不拉伸 |
| 人脸窗口 | 位于画面中部，透明(alpha=0) | 照片从窗口透出，这就是"蒙版" |
| 窗口外围 | 完全不透明(alpha=255) | 挡住画面边缘，形成相纸观感 |
| 边缘 | 1~2px 羽化，避免硬锯齿 | 缩略图放大时不会出锯齿 |
| 文件体积 | 单张 < 400KB | 图库一次加载十几张，太大会让抽屉卡顿 |

**关键**：透明区就是最终效果，运行时**不会**再挖洞。
预览与成片共用同一个 `HTMLImageElement`，所以不存在二次缩放导致的错位。

## manifest.json 结构

```json
{
  "version": 1,
  "masks": [
    {
      "key": "pearl_heart_lilac",
      "name": "珍珠蕾丝爱心框",
      "src": "pearl_heart_lilac.png",
      "audience": "single",
      "category": "婚礼",
      "tags": ["珍珠", "爱心", "浪漫"],
      "hint": "把脸放进爱心里"
    }
  ]
}
```

字段说明：

- `key` — 唯一标识，也是 `store.maskKey` 的取值。**不得与内置蒙版 key 冲突**
  （内置为 `heart` / `star` / `cat` / `dual_circle` 等 15 个）。
- `name` — 图库卡片上显示的名字。
- `src` — 相对 `manifest.json` 的文件名。
- `audience` — `single` | `dual`，决定取景框给 1 个还是 2 个站位提示框。
- `category` — 顶部分类 chips 的一项。同类蒙版建议归到同一 category。
- `tags` — 搜索关键词。搜索会匹配 `name` / `category` / `tags`。
- `hint` — 可选，选中后提示用户怎么站位。

`category` 与 `tags` 建议取值（与内置蒙版语义对齐，便于混排筛选）：
`婚礼`、`卡通`、` ins风`、`复古`、`日常`、`节日`。

## 新增一张蒙版

1. 按上面的硬性要求做好 PNG，放进 `frontend/public/masks/`。
2. 在 `manifest.json` 的 `masks` 数组里加一条。
3. 跑校验：

   ```bash
   python scripts/mask_assets/validate_masks.py
   ```

   校验会检查：manifest 字段完整、key 不与内置蒙版重复、PNG 存在且为 RGBA、
   尺寸为 4:3、透明区占比在合理区间（8%~70%）、四周完全不透明。

## 与内置蒙版的关系

`getMask(key)` 会同时查两张表：内置 15 个代码蒙版，以及图库清单里的位图蒙版。
所以图库抽屉里**内置蒙版和位图蒙版是混排展示**的——
内置的标 `内置`，位图的标分类，方便一眼区分。

数据结构上二者统一为 `MaskDef` 联合类型（见 `maskDefs.ts`）：

```ts
type MaskDef = ProcMaskDef | ImageMaskDef;
```

`renderMaskLayer` 对二者都返回"带透明镂空的画布"，
这是预览与出片共用的唯一契约，新增位图蒙版无需改动渲染管线。
