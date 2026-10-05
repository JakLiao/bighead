/**
 * 单张照片的涂鸦编辑器。
 *
 * 与 renderMask 同一个思路: **预览与出片共用同一份渲染代码**
 * (见下方导出的 paintDoodleStrokes)。编辑模态里看到的就是烧进拼图的那一笔,
 * 所见即所得是结构性保证的, 不靠"两边各写一份、参数对齐"这种人工约定。
 *
 * 落笔用 pointer 事件而非 mouse/touch: pointer 统一处理鼠标/触屏/触控笔,
 * 且 setPointerCapture 能在指针移出 canvas 后继续收到 move —— 否则
 * 快速划线会在边界断笔。
 */
import { useCallback, useEffect, useRef } from "react";
import {
  DOODLE_BASE,
  doodleToolDef,
  type DoodlePoint,
  type DoodleStroke,
  type DoodleTool,
} from "./doodleTypes";

interface Props {
  /** 照片 src(dataURL 或 /outputs URL) */
  src: string;
  /** 已落笔的笔画(按时间顺序) */
  strokes: DoodleStroke[];
  /** 当前选中色 */
  color: string;
  /** 当前选中工具 */
  tool: DoodleTool;
  /** 当前笔刷直径(960 基准) */
  brush: number;
  /** 每落一笔回调一次, 参数是落笔后的完整列表 */
  onChange: (strokes: DoodleStroke[]) => void;
  /**
   * 容器显示尺寸(px)。
   *
   * 必须与照片**同一比例**: canvas 覆盖在 img 之上, 两者一旦比例不同,
   * img 会被 object-cover 裁掉一圈, 而 canvas 仍按整块容器铺 —— 存下来的
   * 0..1 坐标就相对"被裁后的画面"而非"完整照片", 烧录时笔迹会整体偏移。
   * 调用方按 CAPTURE_ASPECT 传 4:3 即可。
   */
  width: number;
  height: number;
}

/**
 * 把笔画画到一个 ctx 上 —— **全仓库唯一的涂鸦渲染实现**。
 *
 * 调用方负责准备画布: 编辑器传覆盖在照片上的透明 canvas(擦除天然只擦笔迹);
 * 烧录时先画到独立透明层再整体贴到照片上(见 DecoratePage.burnDoodles)。
 *
 * 尺寸从 ctx.canvas 直接读, 不接受外部传 w/h —— 少一个参数就少一处
 * "预览传 640、成片传 1280 却忘了换算"的可能。
 *
 * @param extra 正在画、尚未提交的当前笔。渲染顺序在已提交笔画之后。
 */
export function paintDoodleStrokes(
  ctx: CanvasRenderingContext2D | null,
  strokes: DoodleStroke[],
  extra?: DoodleStroke | null,
) {
  if (!ctx) return;
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  // 笔刷基准是"短边 960"。取短边而非长边: 照片是横 4:3, 用长边会让
  // 同一笔在不同画幅下粗细不同(与 masks/geometry.ts 的 unit() 同理)。
  const u = Math.min(width, height) / DOODLE_BASE;
  const all = extra ? [...strokes, extra] : strokes;
  for (const s of all) paintStroke(ctx, s, width, height, u);
}

function paintStroke(
  ctx: CanvasRenderingContext2D,
  s: DoodleStroke,
  w: number,
  h: number,
  u: number,
) {
  if (s.points.length === 0) return;
  const def = doodleToolDef(s.tool);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(0.5, s.width * u * def.scale);
  ctx.globalAlpha = def.alpha;
  ctx.strokeStyle = s.color;
  // 橡皮擦的是"这一笔之前画在**同一层**上的东西", 所以是 destination-out。
  // 前提是调用方给它一块透明画布 —— 直接画在照片上会把照片一起擦穿。
  if (s.tool === "eraser") ctx.globalCompositeOperation = "destination-out";

  if (s.points.length === 1) {
    // 轻点一下(没拖动)也要留下一个圆点, 否则"点一下想点个句号"会毫无反应
    const p = s.points[0];
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fillStyle = s.tool === "eraser" ? "#000" : s.color;
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.beginPath();
  const p0 = s.points[0];
  ctx.moveTo(p0.x * w, p0.y * h);
  for (let i = 1; i < s.points.length; i++) {
    const p = s.points[i];
    ctx.lineTo(p.x * w, p.y * h);
  }
  ctx.stroke();
  ctx.restore();
}

/** 屏幕坐标 → 照片相对坐标。夹到 0..1: 指针被 capture 后仍可能落在画布外。 */
function toRelative(e: React.PointerEvent<HTMLCanvasElement>): DoodlePoint {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - rect.left) / (rect.width || 1);
  const y = (e.clientY - rect.top) / (rect.height || 1);
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

export function DoodleCanvas({ src, strokes, color, tool, brush, onChange, width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 当前正在画的笔放 ref 而不是 state: 每加一个点就 setState 会让 React
  // 在一帧内重渲染几十次, 而重渲染又会经 useEffect 触发全量重绘。
  const currentRef = useRef<DoodleStroke | null>(null);

  const repaint = useCallback(
    (extra?: DoodleStroke | null) => {
      paintDoodleStrokes(canvasRef.current?.getContext("2d") ?? null, strokes, extra);
    },
    [strokes],
  );

  useEffect(() => {
    repaint(null);
  }, [repaint]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // 只响应主键/触摸/笔, 右键菜单不当作落笔
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const stroke: DoodleStroke = { color, width: brush, tool, points: [toRelative(e)] };
    currentRef.current = stroke;
    // 立刻画出来: 否则"点一下"要等 pointerup 才出点, 反馈迟钝
    repaint(stroke);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cur = currentRef.current;
    if (!cur) return;
    cur.points.push(toRelative(e));
    repaint(cur);
  };

  const endStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cur = currentRef.current;
    currentRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!cur) return;
    onChange([...strokes, cur]);
  };

  return (
    <div className="relative" style={{ width, height }}>
      <img
        src={src}
        alt=""
        draggable={false}
        className="absolute inset-0 h-full w-full select-none object-cover"
      />
      <canvas
        ref={canvasRef}
        data-doodle-canvas=""
        // backing store 取 2×: 短边 = 480×2 = 960, 正好等于笔刷基准,
        // 于是「宽度 8」在预览与 1280x960 成片上是同一个像素粗细。
        width={Math.round(width * 2)}
        height={Math.round(height * 2)}
        style={{ width, height }}
        className="absolute inset-0 touch-none cursor-crosshair"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
      />
    </div>
  );
}
