/**
 * 预置蒙版库。
 *
 * 参考 JUST FOTO / 各类大头贴 App 的做法:蒙版不是"给照片加个边框",
 * 而是**在画面上挖一个形状的洞,让人脸从洞里露出来**,周围再撒装饰。
 * 挖洞这一步决定了"人脸在哪",所以它必须和相框、引导线互斥地工作。
 *
 * 三类装饰:
 *   stickers —— 贴纸小图(心/星/花/猫/熊/云),代码现绘,不引外部素材
 *   text     —— 文字(年份、标语)
 *   confetti —— 彩纸屑,给背景加热闹感
 *
 * 所有装饰坐标都在「0..100 正方形」里,renderMask 会按实际画布等比缩放。
 * 刻意不用随机数:预览与成片必须逐像素一致,随机会导致贴纸位置漂移。
 */
import { DUAL_SHAPES, SINGLE_SHAPES, STICKER_SHAPES, type StickerShapeKey } from "./geometry";

export type MaskAudience = "single" | "dual";

export interface StickerDef {
  shape: StickerShapeKey;
  /** 中心点,0..100 */
  x: number;
  y: number;
  /** 边长,0..100(相对短边) */
  size: number;
  fill: string;
  /** 旋转角度 */
  rot?: number;
  /** 描边色,给浅色贴纸加对比 */
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
}

export interface ConfettiDef {
  x: number;
  y: number;
  size: number;
  fill: string;
  rot?: number;
}

export interface TextDef {
  text: string;
  x: number;
  y: number;
  size: number;
  fill: string;
  rot?: number;
  font?: string;
  stroke?: string;
  strokeWidth?: number;
}

export interface MaskDef {
  key: string;
  name: string;
  audience: MaskAudience;
  /** 镂空形状路径(0..1 单位坐标,渲染时缩放) */
  holes: string[];
  /** 镂空区域在画面中的占比(0..1),用于把单位坐标映射到画布 */
  scale: number;
  /**
   * 缩放基准:square = 以短边为准(单人);wide = 以画面宽度为准(双人)。
   * 双人并排挖两个洞时必须用 wide,否则两个洞会粘连成花生形。
   */
  space?: "square" | "wide";
  /** 洞的水平偏移(0=居中),双人时用于微调 */
  offsetX?: number;
  offsetY?: number;
  /** 画布底色,透过洞看到照片 */
  background: string;
  /** 背景图案 */
  pattern?: "checker" | "dots" | "grid" | "stripes" | "solid";
  patternColor?: string;
  stickers?: StickerDef[];
  confetti?: ConfettiDef[];
  texts?: TextDef[];
  /** 提示用户站位的文案(仅预览显示,不烧进成片) */
  hint?: string;
}

const PINK = "#FFD8E1";
const DEEP = "#1A1A2E";
const CREAM = "#FFF8EE";
const BRICK = "#FF6B6B";
const BROWN = "#5C4D3C";
const MINT = "#B8E6D9";
const LILAC = "#D9C2F0";
const SKY = "#BEE3F5";

/** 生成贴纸的简写,减少下面重复的样板代码。 */
const st = (
  shape: StickerShapeKey,
  x: number,
  y: number,
  size: number,
  fill: string,
  extra: Partial<StickerDef> = {},
): StickerDef => ({ shape, x, y, size, fill, ...extra });

export const MASKS: MaskDef[] = [
  // ─────────────────────────── 单人 ───────────────────────────
  {
    key: "heart",
    name: "爱心",
    audience: "single",
    holes: SINGLE_SHAPES.heart(),
    scale: 0.78,
    background: PINK,
    pattern: "dots",
    patternColor: "#FFB3C6",
    stickers: [
      st("heart", 12, 14, 13, BRICK, { rot: -15 }),
      st("heart", 88, 18, 10, "#FF9EC4", { rot: 12 }),
      st("sparkle", 84, 84, 12, CREAM, { rot: 0 }),
      st("sparkle", 15, 86, 9, CREAM, { rot: 0 }),
      st("flower", 50, 6, 11, MINT, { rot: 0 }),
    ],
    confetti: [
      { x: 8, y: 40, size: 5, fill: MINT },
      { x: 92, y: 52, size: 5, fill: LILAC },
      { x: 22, y: 92, size: 4, fill: SKY },
    ],
    hint: "把脸放进爱心里",
  },
  {
    key: "star",
    name: "星星",
    audience: "single",
    holes: SINGLE_SHAPES.star(),
    scale: 0.86,
    background: SKY,
    pattern: "solid",
    stickers: [
      st("star", 10, 12, 14, CREAM, { rot: -10 }),
      st("star", 90, 14, 11, "#FFD86B", { rot: 14 }),
      st("sparkle", 86, 87, 13, CREAM),
      st("sparkle", 12, 84, 10, "#FF9EC4"),
    ],
    texts: [{ text: "SUPER", x: 50, y: 93, size: 8, fill: BRICK, font: "Press Start 2P" }],
    hint: "对准星星中心",
  },
  {
    key: "flower",
    name: "花朵",
    audience: "single",
    holes: SINGLE_SHAPES.flower(),
    scale: 0.84,
    background: CREAM,
    pattern: "dots",
    patternColor: PINK,
    stickers: [
      st("flower", 11, 15, 14, PINK),
      st("flower", 89, 20, 12, MINT),
      st("heart", 50, 94, 12, BRICK),
      st("sparkle", 14, 86, 10, "#FFD86B"),
      st("sparkle", 87, 88, 10, LILAC),
    ],
    hint: "花心对准你的脸",
  },
  {
    key: "cat",
    name: "猫咪",
    audience: "single",
    holes: SINGLE_SHAPES.cat(),
    scale: 0.88,
    background: LILAC,
    pattern: "solid",
    stickers: [
      st("cat", 12, 16, 15, DEEP, { stroke: CREAM, strokeWidth: 2 }),
      st("sparkle", 88, 18, 12, CREAM),
      st("heart", 88, 85, 13, BRICK),
      st("sparkle", 12, 86, 10, CREAM),
    ],
    hint: "露出你的猫耳朵",
  },
  {
    key: "bear",
    name: "小熊",
    audience: "single",
    holes: SINGLE_SHAPES.bear(),
    scale: 0.88,
    background: MINT,
    pattern: "dots",
    patternColor: "#8FD3C0",
    stickers: [
      st("bear", 12, 17, 15, BROWN),
      st("heart", 87, 16, 12, BRICK),
      st("star", 50, 95, 12, "#FFD86B"),
      st("sparkle", 14, 85, 10, CREAM),
    ],
    hint: "躲进小熊脑袋里",
  },
  {
    key: "cloud",
    name: "云朵",
    audience: "single",
    holes: SINGLE_SHAPES.cloud(),
    scale: 0.8,
    background: SKY,
    pattern: "solid",
    stickers: [
      st("cloud", 12, 18, 14, CREAM),
      st("cloud", 88, 24, 11, CREAM),
      st("sparkle", 50, 8, 11, "#FFD86B"),
      st("heart", 88, 86, 12, BRICK),
    ],
    hint: "浮在云端",
  },
  {
    key: "blob",
    name: "流体",
    audience: "single",
    holes: SINGLE_SHAPES.blob(),
    scale: 0.84,
    background: MINT,
    pattern: "stripes",
    patternColor: "#8FD3C0",
    stickers: [
      st("blob", 12, 15, 13, LILAC),
      st("star", 88, 17, 12, CREAM),
      st("sparkle", 87, 86, 12, BRICK),
    ],
    hint: "站在色块中间",
  },
  {
    key: "burst",
    name: "爆炸",
    audience: "single",
    holes: SINGLE_SHAPES.burst(),
    scale: 0.92,
    background: "#FFD86B",
    pattern: "grid",
    patternColor: "#F0B429",
    stickers: [
      st("sparkle", 8, 10, 12, CREAM),
      st("sparkle", 92, 10, 12, CREAM),
      st("star", 50, 95, 13, BRICK),
    ],
    texts: [{ text: "WOW!", x: 50, y: 6, size: 9, fill: BRICK, font: "Press Start 2P" }],
    hint: "超有活力!",
  },
  {
    key: "ticket",
    name: "票根",
    audience: "single",
    holes: SINGLE_SHAPES.ticket(),
    scale: 0.84,
    background: CREAM,
    pattern: "solid",
    stickers: [
      st("circle", 8, 50, 7, PINK),
      st("circle", 92, 50, 7, PINK),
      st("star", 14, 12, 12, BRICK),
      st("star", 86, 12, 12, BRICK),
      st("heart", 50, 94, 11, BRICK),
    ],
    texts: [{ text: "ADMIT ONE", x: 50, y: 96, size: 6, fill: BROWN, font: "monospace" }],
    hint: "正面照,别眨眼",
  },

  // ─────────────────────────── 双人 ───────────────────────────
  {
    key: "dual_circle",
    name: "双圆",
    audience: "dual",
    holes: DUAL_SHAPES.dual_circle(),
    space: "wide",
    scale: 0.96,
    background: PINK,
    pattern: "dots",
    patternColor: "#FF9EC4",
    stickers: [
      st("heart", 50, 8, 13, BRICK),
      st("star", 8, 14, 12, "#FFD86B"),
      st("star", 92, 14, 12, "#FFD86B"),
      st("sparkle", 12, 88, 11, CREAM),
      st("sparkle", 88, 88, 11, CREAM),
    ],
    texts: [{ text: "BFF", x: 50, y: 94, size: 8, fill: BRICK, font: "Press Start 2P" }],
    hint: "两个人各站一个圈",
  },
  {
    key: "dual_heart",
    name: "双心",
    audience: "dual",
    holes: DUAL_SHAPES.dual_heart(),
    space: "wide",
    scale: 0.92,
    background: CREAM,
    pattern: "solid",
    stickers: [
      st("sparkle", 8, 12, 12, BRICK),
      st("sparkle", 92, 12, 12, BRICK),
      st("heart", 50, 95, 12, "#FF9EC4"),
      st("flower", 10, 88, 10, MINT),
      st("flower", 90, 88, 10, LILAC),
    ],
    hint: "各钻一个心",
  },
  {
    key: "dual_star",
    name: "双星",
    audience: "dual",
    holes: DUAL_SHAPES.dual_star(),
    space: "wide",
    scale: 0.96,
    background: DEEP,
    pattern: "solid",
    stickers: [
      st("sparkle", 8, 12, 12, "#FFD86B"),
      st("sparkle", 92, 12, 12, "#FFD86B"),
      st("star", 50, 8, 12, CREAM),
      st("heart", 50, 94, 12, BRICK),
    ],
    hint: "一人一颗星",
  },
  {
    key: "dual_bubble",
    name: "气泡",
    audience: "dual",
    holes: DUAL_SHAPES.dual_bubble(),
    space: "wide",
    scale: 0.96,
    background: SKY,
    pattern: "dots",
    patternColor: "#9BD3F0",
    stickers: [
      st("circle", 10, 20, 8, CREAM, { opacity: 0.8 }),
      st("circle", 90, 30, 6, CREAM, { opacity: 0.8 }),
      st("circle", 88, 76, 9, CREAM, { opacity: 0.8 }),
      st("heart", 50, 10, 12, BRICK),
    ],
    hint: "两个人挤进气泡",
  },
  {
    key: "dual_blob",
    name: "双流体",
    audience: "dual",
    holes: DUAL_SHAPES.dual_blob(),
    space: "wide",
    scale: 0.96,
    background: LILAC,
    pattern: "stripes",
    patternColor: "#B79BE0",
    stickers: [
      st("blob", 10, 14, 12, MINT),
      st("blob", 90, 16, 12, PINK),
      st("star", 50, 94, 12, CREAM),
    ],
    hint: "各站一块",
  },
  {
    key: "dual_rounded",
    name: "双框",
    audience: "dual",
    holes: DUAL_SHAPES.dual_rounded(),
    space: "wide",
    scale: 0.9,
    background: MINT,
    pattern: "grid",
    patternColor: "#8FD3C0",
    stickers: [
      st("heart", 50, 8, 12, BRICK),
      st("sparkle", 8, 16, 11, CREAM),
      st("sparkle", 92, 16, 11, CREAM),
      st("flower", 50, 95, 11, PINK),
    ],
    hint: "一人一个框",
  },
];

export const MASKS_BY_KEY: Record<string, MaskDef> = Object.fromEntries(
  MASKS.map((m) => [m.key, m]),
);

export function getMask(key: string | null | undefined): MaskDef | undefined {
  if (!key) return undefined;
  return MASKS_BY_KEY[key];
}

/** 贴纸形状路径表,渲染时按需取用。 */
export { STICKER_SHAPES };
