/**
 * 手写涂鸦层的数据契约。
 *
 * 三条不变量, 与仓库里 mask 的既有做法同源(见 masks/geometry.ts 顶部注释),
 * 目的只有一个: **编辑时看到的笔迹, 必须与拼图里烧进去的笔迹是同一笔**。
 *
 * 1. **坐标相对 0..1, 不存绝对像素。**
 *    取景出片是 1280x960, 而编辑模态里的 canvas 只有 640x480(还要再 ×2 补
 *    devicePixelRatio)。存绝对像素就得存两套, 且换一次编辑尺寸全部报废。
 *    相对坐标让同一笔在 640 的预览与 1280 的成片上落在同一个**相对位置**。
 *
 * 2. **笔刷宽度以「照片短边 960px」为基准**(DOODLE_BASE)。**
 *    取景出片短边恰好是 960, 所以「宽度 8」在成片上就是 8px; 而编辑 canvas
 *    的 backing store 取 2×(640×2=1280, 480×2=960), 短边同样是 960 ——
 *    预览与成片的笔刷粗细因此**逐像素相等**, 不需要任何换算系数。
 *    这也是"预览=出片"能被结构性保证、而非靠人工对齐的前提。
 *
 * 3. **橡皮是 tool="eraser" 的一笔, 按数组顺序参与合成, 不是"删除某笔"。**
 *    删数组元素做不到"擦掉中间一笔、保留它前后两笔"; 而 destination-out 可以。
 *    数组顺序即时间线, 渲染时严格按序执行。
 */

export type DoodleTool = "marker" | "highlighter" | "eraser";

/** 笔迹上的一个点。x/y 是相对照片宽/高的比例, 0..1。 */
export interface DoodlePoint {
  x: number;
  y: number;
}

/** 一笔: 一次 pointerdown → pointermove* → pointerup。 */
export interface DoodleStroke {
  /** CSS 颜色串(hex 或 rgba)。eraser 不看这个值。 */
  color: string;
  /** 笔刷直径, 单位是「短边 960 基准」下的像素。见文件头不变量 2。 */
  width: number;
  tool: DoodleTool;
  /** 落笔顺序即数组顺序。单点(轻点一下)也算一笔, 渲染成一个圆点。 */
  points: DoodlePoint[];
}

/** 一张照片一张涂鸦层。key 用 frames 数组下标 —— 与 displayImages 的下标同源。 */
export type DoodlesByIndex = Record<number, DoodleStroke[]>;

/** 笔刷基准: 所有 width 换算成像素时都除以它。见文件头不变量 2。 */
export const DOODLE_BASE = 960;

/** 取景出片尺寸(短边 = DOODLE_BASE)。编辑模态的容器按同一比例铺。 */
export const CAPTURE_ASPECT = { w: 1280, h: 960 } as const;

export interface DoodleToolDef {
  key: DoodleTool;
  name: string;
  hint: string;
  /** 不透明度。荧光笔要"透出底下的照片", 所以不是 1。 */
  alpha: number;
  /** 粗细倍率。同一个 width 下荧光笔更宽, 视觉上才对得上"荧光笔"。 */
  scale: number;
}

export const DOODLE_TOOLS: DoodleToolDef[] = [
  { key: "marker", name: "马克笔", hint: "实心不透明, 日常写字", alpha: 1, scale: 1 },
  { key: "highlighter", name: "荧光笔", hint: "半透明, 涂底色", alpha: 0.45, scale: 1.8 },
  { key: "eraser", name: "橡皮", hint: "擦掉已画的笔迹", alpha: 1, scale: 1.4 },
];

const TOOL_MAP: Record<DoodleTool, DoodleToolDef> = Object.fromEntries(
  DOODLE_TOOLS.map((t) => [t.key, t]),
) as Record<DoodleTool, DoodleToolDef>;

/** 取工具参数。未知 key 回落 marker, 避免一条脏数据让整层渲染崩掉。 */
export function doodleToolDef(tool: DoodleTool): DoodleToolDef {
  return TOOL_MAP[tool] ?? TOOL_MAP.marker;
}

export interface DoodleColorDef {
  color: string;
  name: string;
}

/** 8 色板。古早大头贴机的可写色域: 黑/白/红/蓝/绿/粉/黄/紫。 */
export const DOODLE_COLORS: DoodleColorDef[] = [
  { color: "#1a1a1a", name: "黑" },
  { color: "#ffffff", name: "白" },
  { color: "#ff3b30", name: "红" },
  { color: "#3b6cff", name: "蓝" },
  { color: "#22c55e", name: "绿" },
  { color: "#ec4899", name: "粉" },
  { color: "#facc15", name: "黄" },
  { color: "#a855f7", name: "紫" },
];

export interface DoodleWidthDef {
  /** DOODLE_BASE 基准下的像素直径 */
  width: number;
  name: string;
}

export const DOODLE_WIDTHS: DoodleWidthDef[] = [
  { width: 4, name: "细" },
  { width: 8, name: "中" },
  { width: 14, name: "粗" },
];

export const DOODLE_DEFAULT_COLOR = DOODLE_COLORS[0].color;
export const DOODLE_DEFAULT_WIDTH = DOODLE_WIDTHS[1].width;
export const DOODLE_DEFAULT_TOOL: DoodleTool = "marker";
