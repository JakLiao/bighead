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
  type DoodleSafeArea,
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
  /**
   * 四边安全区(相对 0..1): 这些区域里的笔迹会在后端 cover 裁切时被切掉,
   * 故压暗提示。**必须由调用方按当前所选排版实算**(doodleSafeArea),
   * 不能写死常数 —— 排版不同, 被裁的方向与宽度都不同(6inch_4p 裁的是上下)。
   */
  safe: DoodleSafeArea;
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

/**
 * 采样点最小间距(相对坐标)。小于它就丢弃这次 move。
 *
 * 指针事件按**设备回报率**触发(120Hz 屏一帧 8 个 move), 而重绘按
 * requestAnimationFrame 合帧(60Hz)。不去重的话, 一笔 2 秒的划线会灌进
 * 近千个点, 每个点都进 store —— 这些点里有 90% 落在两个已记录点之间,
 * 对折线形状零贡献, 纯粹让 React 状态、序列化体积、烧录时的 lineTo 循环
 * 成倍膨胀。0.002 相对 1280px 出片 = 2.6px, 小到看不出折线, 又足以
 * 滤掉静止抖动。
 */
const MIN_SAMPLE_DIST = 0.002;

export function DoodleCanvas({
  src,
  strokes,
  color,
  tool,
  brush,
  onChange,
  width,
  height,
  safe,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 当前正在画的笔放 ref 而不是 state: 每加一个点就 setState 会让 React
  // 在一帧内重渲染几十次, 而重渲染又会经 useEffect 触发全量重绘。
  const currentRef = useRef<DoodleStroke | null>(null);
  // 已排定的 rAF 句柄。用来保证"一帧最多重绘一次": 指针事件频率高于
  // 刷新率时(120Hz 屏 / 触控笔), 同一帧内来 2~3 个 move 是常态,
  // 每个都全量重绘(clearRect + 遍历所有笔画 stroke)等于白烧 CPU。
  const frameRef = useRef<number | null>(null);

  const repaint = useCallback(
    (extra?: DoodleStroke | null) => {
      paintDoodleStrokes(canvasRef.current?.getContext("2d") ?? null, strokes, extra);
    },
    [strokes],
  );

  useEffect(() => {
    repaint(null);
  }, [repaint]);

  // 卸载时撤掉待执行的帧, 否则会对已卸载的 canvas 拿到 null ctx 后
  // 静默空转(不会崩, 但句柄泄漏且 白跑一次全量重绘)。
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

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
    const p = toRelative(e);
    // 采样去重: 与上一个已记录点的距离过近就丢弃这次 move。
    // 用平方距离比, 免掉一次开方。
    const last = cur.points[cur.points.length - 1];
    if (last) {
      const dx = p.x - last.x;
      const dy = p.y - last.y;
      if (dx * dx + dy * dy < MIN_SAMPLE_DIST * MIN_SAMPLE_DIST) return;
    }
    cur.points.push(p);
    // 合帧: 已排过帧就只攒点, 等那一帧统一重绘。
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      repaint(currentRef.current);
    });
  };

  const endStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cur = currentRef.current;
    currentRef.current = null;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      // 补一次收尾重绘: 被取消的那一帧里攒下的点还没画过,
      // 不补的话最后一小段会缺一小截(然后才被 onChange 的重渲染盖上)。
      if (cur) repaint(cur);
    }
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
      {/*
        安全区遮罩: 把"会被后端 cover 裁掉"的那几条边压暗。
        这几块里的笔迹不会出现在成片里 —— 此前 UI 毫无提示, 用户以为
        "所有笔迹都会烧进最终图", 结果成片上凭空少一截。

        尺寸由 safe 决定(调用方按当前所选排版实算), 不是写死的常数: 排版
        换成 6inch_4p 时裁的是**上下**, 左右一点都不裁, 无条件压暗左右
        反而会把本该保留的边缘标成"会丢"。

        pointer-events-none 是关键: 遮罩只做视觉提示, 不能吃掉画布上的
        pointer 事件, 否则那几条边上就画不了笔(而"能不能画"与"画了留不
        留得住"是两件事, 不该由提示层替用户做决定)。
        某边为 0 时不渲染, 免得留一条无意义的 0 宽元素干扰命中测试。
      */}
      {safe.left > 0 && (
        <div
          data-doodle-safe="left"
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 bg-black/45"
          style={{ width: `${safe.left * 100}%` }}
        />
      )}
      {safe.right > 0 && (
        <div
          data-doodle-safe="right"
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 bg-black/45"
          style={{ width: `${safe.right * 100}%` }}
        />
      )}
      {safe.top > 0 && (
        <div
          data-doodle-safe="top"
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 bg-black/45"
          style={{ height: `${safe.top * 100}%` }}
        />
      )}
      {safe.bottom > 0 && (
        <div
          data-doodle-safe="bottom"
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/45"
          style={{ height: `${safe.bottom * 100}%` }}
        />
      )}
    </div>
  );
}
