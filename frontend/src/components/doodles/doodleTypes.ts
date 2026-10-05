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

/** 描述一个排版的单元格几何。字段与后端 LAYOUTS 条目一一对应。 */
export interface DoodleLayoutGeom {
  key: string;
  cols: number;
  rows: number;
  /** 固定相纸尺寸(px)。缺省时后端按 600x800 cell 自适应(见 cellRatio)。 */
  paper?: [number, number];
}

/**
 * 把后端 LAYOUTS 的 `paper` 字段补齐到前端。
 *
 * ⚠️ 这是**有意的前端镜像**, 不是重复数据。/api/meta 的 LayoutInfo 只带
 * cols/rows(见 backend/routes/health.py), 不带 paper —— 而 cell 的最终宽高
 * 依赖 paper, 缺了它 6inch_4p 会被算成 2x2 的比例, 安全区就指错了方向。
 * 改后端 config.LAYOUTS 的 paper 时必须同步这里; verify-doodle-burn.mjs 里
 * 有一条断言专门拿后端 /api/meta 的排版清单核对覆盖率, 漏同步会直接失败。
 */
const LAYOUT_PAPER: Record<string, [number, number]> = {
  "6inch_4p": [1500, 1000],
};

/**
 * 某个排版里**单个 cell** 的宽高比(宽/高)。
 *
 * 严格镜像 backend/layouts.py 的 make_collage:
 *   paper 缺省 -> paper_w = 600*cols + 40*(cols+1)
 *                 paper_h = 800*rows + 40*(rows+1) + 80
 *   margin = 30
 *   cell_w = (paper_w - 30*(cols+1)) // cols
 *   cell_h = (paper_h - 30*(rows+1) - 80) // rows
 * 实算结果: 2x2 615x815 / 2x3 615x813 / 3x3 613x813 / strip 612x820 /
 *           6inch_4p 705x415。
 *
 * 之所以敢在前端算: 这几个整数是**排版定义的常量**, 不依赖任何运行时输入
 * (不读图片、不看人脸), 后端改了 cell 尺寸前端自然要跟着改 —— 与其让用户
 * 在错误的提示区里丢笔迹, 不如把公式抄一份并用测试钉住。
 */
export function cellRatio(l: DoodleLayoutGeom): number {
  const { cols, rows } = l;
  const paper = l.paper ?? LAYOUT_PAPER[l.key];
  const paperW = paper ? paper[0] : 600 * cols + 40 * (cols + 1);
  const paperH = paper ? paper[1] : 800 * rows + 40 * (rows + 1) + 80;
  const cellW = Math.floor((paperW - 30 * (cols + 1)) / cols);
  const cellH = Math.floor((paperH - 30 * (rows + 1) - 80) / rows);
  return cellW / cellH;
}

/** 安全区: 四边各占画幅的比例(0..1)。该边上的笔迹**不会出现在成片里**。 */
export interface DoodleSafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * 按排版算出四边安全区 —— 落在这些区域的笔迹会被后端 cover 裁掉。
 *
 * 推导与 _smart_crop 逐行对应。照片是 CAPTURE_ASPECT(4:3 = 1.3333):
 *   cell 比例 < 照片比例 -> 原图更宽, 裁左右, 保留 [side, 1-side],
 *     side = x1 / 1280, x1 = round(1280/2 - round(960*ratio)/2)
 *   cell 比例 >= 照片比例 -> 裁上下, 横向不裁, 纵向按 cy=0.42 定位
 * 实算(1280x960):
 *     2x2       0.7546 -> L/R 0.2172
 *     2x3       0.7565 -> L/R 0.2164
 *     3x3       0.7540 -> L/R 0.2172
 *     strip     0.7463 -> L/R 0.2203  <- 横向最宽
 *     6inch_4p  1.6988 -> T 0.0281 / B 0.1875, **横向完全不裁**
 *
 * 最后一行是这个函数存在的理由: 6inch_4p 的 cell 比照片还宽, 裁的是**上下**,
 * 左右两侧一点都不裁。此前 UI 无条件压暗左右两条, 对这个排版既指错了方向,
 * 又把本该保留的左右边缘标成了"会丢"。
 *
 * ⚠️ 局限: 只在 _smart_crop 的 focus 落几何中心时准确。检到人脸时 focus 由
 * _face_focus 给出(纵向还会 -0.06), 裁切窗口会平移, 真实安全区随之偏移 ——
 * 前端拿不到后端人脸框, 无法逐帧精确。这里按几何中心给, 并在文案上如实
 * 标注"约", 不谎称精确边界。
 */
export function doodleSafeArea(l: DoodleLayoutGeom): DoodleSafeArea {
  const t = cellRatio(l);
  const srcRatio = CAPTURE_ASPECT.w / CAPTURE_ASPECT.h;
  if (srcRatio > t) {
    const newW = Math.round(CAPTURE_ASPECT.h * t);
    const x1 = Math.round(CAPTURE_ASPECT.w / 2 - newW / 2);
    const left = Math.max(0, Math.min(x1, CAPTURE_ASPECT.w - newW)) / CAPTURE_ASPECT.w;
    return { top: 0, right: left, bottom: 0, left };
  }
  const newH = Math.round(CAPTURE_ASPECT.w / t);
  const y1 = Math.round(0.42 * CAPTURE_ASPECT.h - newH / 2);
  const top = Math.max(0, Math.min(y1, CAPTURE_ASPECT.h - newH)) / CAPTURE_ASPECT.h;
  return { top, right: 0, bottom: 1 - (top * CAPTURE_ASPECT.h + newH) / CAPTURE_ASPECT.h, left: 0 };
}

/** 排版清单(取不到 /api/meta 时的兜底, 与后端 LAYOUTS 的 key/cols/rows 一致)。 */
export const DOODLE_FALLBACK_LAYOUTS: DoodleLayoutGeom[] = [
  { key: "2x2", cols: 2, rows: 2 },
  { key: "2x3", cols: 2, rows: 3 },
  { key: "3x3", cols: 3, rows: 3 },
  { key: "strip", cols: 4, rows: 1 },
  { key: "6inch_4p", cols: 2, rows: 2 },
];

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

/**
 * 刻意声明成 Partial 而不是 Record: Record<DoodleTool, ...> 会让
 * `TOOL_MAP[tool]` 的类型是 DoodleToolDef(非可选), 于是 `?? TOOL_MAP.marker`
 * 被编译器判定为永远走不到的死代码 —— 而它恰恰是脏数据(存档里的未知 tool
 * 串)唯一的救命稻草。标成 Partial 后, 索引结果含 undefined, 兜底才在
 * 类型层真正成立, 删掉它也会立刻编译报错。
 */
const TOOL_MAP: Partial<Record<DoodleTool, DoodleToolDef>> = Object.fromEntries(
  DOODLE_TOOLS.map((t) => [t.key, t]),
);

/** 取工具参数。未知 key 回落 marker, 避免一条脏数据让整层渲染崩掉。 */
export function doodleToolDef(tool: DoodleTool): DoodleToolDef {
  // DOODLE_TOOLS[0] 恒为 marker(见上表), 标成非空以结束返回类型推导。
  return TOOL_MAP[tool] ?? TOOL_MAP.marker ?? (DOODLE_TOOLS[0] as DoodleToolDef);
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
