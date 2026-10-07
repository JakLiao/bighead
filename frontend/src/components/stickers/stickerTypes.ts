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
 * 4. **代码形状与位图素材共用一套摆放管线。**
 *    StickerPlacement 是判别联合: 带 shape 走 Path2D, 带 asset 走 drawImage,
 *    但 x/y/size/rotation/opacity 的语义、叠放顺序、命中测试、选中框、
 *    烧录出口全部一致。新增位图素材**不需要**在渲染器里加第三条分支 ——
 *    只有 paintSticker 内部有 shape/asset 之分, 其它每一处都当它是同一种东西。
 *
 * 与涂鸦层的分工: 蒙版(mask)里的贴纸是 maskDefs 硬编码的**取景期**装饰,
 * 走 renderMask 的旧路径; 这里管的是用户在排版页**额外**摆的贴纸, 两者
 * 互不影响。
 */
import type { StickerShapeKey } from "../masks/geometry";

/** 摆放参数的公共部分。x/y/size 的语义见文件头的不变量 1、2。 */
interface StickerPlacementBase {
  /** 中心 x, 相对照片宽, 0..1。 */
  x: number;
  /** 中心 y, 相对照片高, 0..1。 */
  y: number;
  /** 边长, 相对照片**短边**, 0..1。 */
  size: number;
  /** 旋转角度(度)。顺时针为正, 与 canvas 的 rotate 一致。 */
  rotation: number;
  /** 不透明度, 缺省 1。 */
  opacity?: number;
}

/**
 * 代码形状贴纸(内置 7 选 1)。
 *
 * 走 Path2D.fill/stroke, 颜色由 fill 决定。
 */
export interface ShapeSticker extends StickerPlacementBase {
  /** 形状 key。与 masks/geometry.ts 的 STICKER_SHAPES 同源。 */
  shape: StickerShapeKey;
  /** 填充色(CSS 颜色串)。 */
  fill: string;
  /** 描边色。缺省不描边。 */
  stroke?: string;
  /** 描边宽度, 单位与 size 同基准(相对短边)。 */
  strokeWidth?: number;
  /** 位图贴纸专用字段。显式声明为 never, 让"既有 shape 又有 asset"在
   * 编译期就是非法的 —— 而不是一个运行时才被渲染器忽略的坏数据。 */
  asset?: never;
}

/**
 * 位图贴纸(public/stickers/ 下登记的 PNG)。
 *
 * 走 drawImage, **没有 fill**: PNG 自带颜色, 染色需要滤镜管线, 而滤镜是在
 * 贴纸之后才跑的(见 DecoratePage), 顺序不能倒 —— 否则预览和成片会不一致。
 * 同一个 key 的 PNG 只有一种样子, 这是刻意的: 素材的辨识度就来自原图。
 */
export interface AssetSticker extends StickerPlacementBase {
  /** 素材 key, 对应 stickerLibrary 加载的 manifest 条目。 */
  asset: string;
  /** 代码形状专用字段。见 ShapeSticker.asset 的说明。 */
  shape?: never;
}

/**
 * 一个用户摆放的贴纸。x/y/size 全部相对照片, 0..1。
 *
 * 判别方式是**看哪个 key 存在**(shape 还是 asset), 而非再加一个 kind 字段:
 * 多一个判别位就多一处可能与实际内容不一致的状态(placement.kind==="asset"
 * 但 asset 是 undefined), 而"存在哪个 key"无法被人为写歪。
 */
export type StickerPlacement = ShapeSticker | AssetSticker;

/** 是否是位图贴纸。渲染与命中测试的分支依据。 */
export function isAssetSticker(s: StickerPlacement): s is AssetSticker {
  return typeof (s as AssetSticker).asset === "string";
}

/** 是否是代码形状贴纸。 */
export function isShapeSticker(s: StickerPlacement): s is ShapeSticker {
  return typeof s.shape === "string";
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

/**
 * 位图贴纸的默认边长(相对短边)。
 *
 * 比代码形状大一圈: 代码形状是"规整的形", 视觉重量轻; 位图素材带模切
 * 白边和插画细节, 同样的边长摆出来明显更小一号。
 */
export const ASSET_STICKER_DEFAULT_SIZE = 0.22;

/** 新贴纸的默认颜色。用色板第一色, 不另立常量, 免得两处默认值漂移。 */
export const STICKER_DEFAULT_COLOR = STICKER_COLORS[0].color;

/**
 * 安全读取填充色。位图贴纸没有 fill(见 AssetSticker), UI 上的色板选中态
 * 与"改色"操作都要过这里, 而不是直接 `s.fill` ——
 * 联合类型下直接访问非公共字段是编译错误, 用 `in` 收窄则要在每个调用点
 * 重复一遍判别。集中在这里, 判别只写一次。
 *
 * 接受 null: 调用点通常是"当前选中的贴纸"(可能没选), 用 `s!.fill` 硬解
 * 只会把一个可空值伪装成非空, 免去调用点的 `!` 又不改变运行时行为。
 */
export function stickerFill(s: StickerPlacement | null): string | undefined {
  return s && isShapeSticker(s) ? s.fill : undefined;
}
