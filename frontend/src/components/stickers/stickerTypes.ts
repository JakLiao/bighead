/**
 * 贴纸自由编排层的数据契约。
 *
 * 与 doodles/doodleTypes.ts 同源的三条不变量, 目的也一样只有一个:
 * **编辑时看到的贴纸, 必须与拼图里烧进去的贴纸是同一个贴纸。**
 *
 * 1. **坐标相对 0..1, 不存绝对像素。**
 *    与涂鸦同因: 编辑模态的 canvas 显示 640x480, 成片是 1280x960。存绝对
 *    像素就要存两套, 且换一次编辑尺寸全部报废。
 *
 * 2. **尺寸以「照片短边」为基准, 不是宽也不是高。**
 *    取短边与 doodles 的笔刷基准(masks/geometry.ts 的 unit()) 同一个道理:
 *    同一个 size=0.16 的贴纸, 在 4:3 与 3:4 的画幅下视觉大小才一致。
 *    取长边会把横向画幅上的贴纸压扁。
 *
 * 3. **形状不自研。**
 *    `shape` 直接取 masks/geometry.ts 的 STICKER_SHAPES key —— 那里已经
 *    有 heart/star/flower/cloud/cat/bear 等一整套极坐标与贝塞尔路径, 且是
 *    **确定性**的(不含 Math.random)。在这里另写一份几何公式必然漂移:
 *    蒙版预览、蒙版出片、贴纸编辑器、贴纸烧录四处会画出四种不同的星星。
 *
 * 与涂鸦层的分工: 蒙版(mask)里的贴纸是 maskDefs 硬编码的**取景期**装饰,
 * 走 renderMask 的旧路径; 这里管的是用户在排版页**额外**摆的贴纸, 两者
 * 互不影响。
 */
import type { StickerShapeKey } from "../masks/geometry";

/** 一个用户摆放的贴纸。x/y/size 全部相对照片, 0..1。 */
export interface StickerPlacement {
  /** 形状 key。与 masks/geometry.ts 的 STICKER_SHAPES 同源。 */
  shape: StickerShapeKey;
  /** 中心 x, 相对照片宽, 0..1。 */
  x: number;
  /** 中心 y, 相对照片高, 0..1。 */
  y: number;
  /** 边长, 相对照片**短边**, 0..1。 */
  size: number;
  /** 旋转角度(度)。顺时针为正, 与 canvas 的 rotate 一致。 */
  rotation: number;
  /** 填充色(CSS 颜色串)。 */
  fill: string;
  /** 描边色。缺省不描边。 */
  stroke?: string;
  /** 描边宽度, 单位与 size 同基准(相对短边)。 */
  strokeWidth?: number;
  /** 不透明度, 缺省 1。 */
  opacity?: number;
}

/**
 * 一张照片一张贴纸层。key 用 frames 数组下标 —— 与 doodles/displayImages
 * 的下标同源, 也与后端 collage 的 cell 顺序同源。
 *
 * 刻意用 Record 而不是数组: 与 DoodlesByIndex 保持一致, 且下标天然稀疏
 * (只有摆过贴纸的照片才有 key), doLayout 侧 `stickerOverrides[i]?.length`
 * 一处判断就够, "没摆过"与"摆了又清空"在成片上等价。
 */
export type StickersByIndex = Record<number, StickerPlacement[]>;

/**
 * 可选形状(取自 STICKER_SHAPES 的子集)。
 *
 * 刻意不 `Object.keys(STICKER_SHAPES)` 全量暴露: 蒙版预设里有些形状
 * (如 cat/bear 的耳朵) 在 STICKER_SHAPES 里只保留了头部单路径, 作为
 * 独立贴纸摆出来会像"半个猫头", 反而让用户以为是 bug。列一份显式白名单,
 * 加新形状要在这里过一遍, 免得无声地多出一个看不懂的按钮。
 */
export const STICKER_SHAPE_KEYS: StickerShapeKey[] = [
  "heart",
  "star",
  "sparkle",
  "flower",
  "circle",
  "cloud",
  "blob",
];

/** 形状按钮上的中文名。与 STICKER_SHAPE_KEYS 一一对应。 */
export const STICKER_SHAPE_NAMES: Record<string, string> = {
  heart: "爱心",
  star: "星星",
  sparkle: "闪光",
  flower: "花朵",
  circle: "圆点",
  cloud: "云朵",
  blob: "流体",
};

/** 贴纸色板。饱和度都拉满 —— 贴纸是"盖在照片上"的东西, 灰扑扑的颜色在大头贴上根本看不见。 */
export interface StickerColorDef {
  color: string;
  name: string;
}

export const STICKER_COLORS: StickerColorDef[] = [
  { color: "#ff3b30", name: "红" },
  { color: "#facc15", name: "黄" },
  { color: "#22c55e", name: "绿" },
  { color: "#3b6cff", name: "蓝" },
  { color: "#ec4899", name: "粉" },
  { color: "#1a1a1a", name: "黑" },
  { color: "#ffffff", name: "白" },
];

/** 新贴纸的默认边长(相对短边)。0.16 ≈ 4:3 画幅下的 1/6 宽, 是个不遮挡主体的大小。 */
export const STICKER_DEFAULT_SIZE = 0.16;

/** 新贴纸的默认颜色。用色板第一色, 不另立常量, 免得两处默认值漂移。 */
export const STICKER_DEFAULT_COLOR = STICKER_COLORS[0].color;
