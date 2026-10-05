/**
 * 单张照片的贴纸编排编辑器(自研 canvas 拖拽, 未引入 Konva 等新依赖)。
 *
 * 与 DoodleCanvas 同一个思路: **预览与出片共用同一份渲染代码**。
 * 下方导出的 paintStickers 是全仓库唯一的贴纸渲染实现:
 *   · 编辑模态: 画到覆盖在照片上的透明 canvas(所见即所得)
 *   · 拼图烧录: DecoratePage.burnStickers 画到独立透明层再整体贴到照片
 * 两边共用同一个函数, 于是"摆在哪看到就在哪"是结构性保证, 而不是靠
 * "两边各写一份、参数对齐"这种人工约定 —— 这类约定在换画幅/换 DPR 时
 * 一定会漂移。
 *
 * 形状路径一律取自 masks/geometry.ts 的 STICKER_SHAPES(确定性几何),
 * 本文件不定义任何形状公式。
 *
 * 交互用 pointer 事件 + setPointerCapture: 指针移出画布后仍能继续收到
 * move, 否则把贴纸拖到边缘会"掉手"。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { STICKER_SHAPES, type StickerShapeKey } from "../masks/geometry";
import type { DoodleSafeArea } from "../doodles/doodleTypes";
import {
  STICKER_COLORS,
  STICKER_DEFAULT_COLOR,
  STICKER_DEFAULT_SIZE,
  STICKER_SHAPE_KEYS,
  STICKER_SHAPE_NAMES,
  type StickerPlacement,
} from "./stickerTypes";

interface Props {
  /** 照片 src(dataURL 或 /outputs URL) */
  src: string;
  /** 已摆放的贴纸(数组顺序即叠放顺序: 后加的盖在上面) */
  stickers: StickerPlacement[];
  /** 每次改动回调一次, 参数是改动后的完整列表 */
  onChange: (stickers: StickerPlacement[]) => void;
  /**
   * 容器显示尺寸(px)。必须与照片**同一比例**(4:3 = CAPTURE_ASPECT),
   * 否则 img 被 object-cover 裁掉一圈而 canvas 仍按整块容器铺, 存下的
   * 0..1 坐标就相对"被裁后的画面", 烧录时贴纸会整体偏移。
   */
  width: number;
  height: number;
  /** 四边安全区(相对 0..1), 由调用方按当前排版实算。详见 DoodleCanvas 同名 prop。 */
  safe: DoodleSafeArea;
  /** 形状/色板是否由本组件自己渲染。侧栏已有一套时传 false, 避免同一屏两套控件。 */
  showToolbar?: boolean;
}

/**
 * 把贴纸画到一个 ctx 上 —— **全仓库唯一的贴纸渲染实现**。
 *
 * 与 paintDoodleStrokes 完全同构: 尺寸从 ctx.canvas 直接读, 不接受外部传
 * w/h, 少一个参数就少一处"预览传 640、成片传 1280 却忘了换算"的可能。
 *
 * 坐标换算(与 doodles 的 DOODLE_BASE / masks 的 unit() 同一套思路):
 *   位置 x/y 相对照片宽/高, 尺寸 size 相对**短边**(见 stickerTypes 不变量 2)。
 *
 * @param selected 需要画选中虚线框的贴纸下标。烧录时传 -1 —— 选中框是
 *   编辑器专属的 UI 状态, 绝不能烧进成片。
 */
export function paintStickers(
  ctx: CanvasRenderingContext2D | null,
  stickers: StickerPlacement[],
  selected = -1,
) {
  if (!ctx) return;
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  const u = Math.min(width, height);
  for (let i = 0; i < stickers.length; i++) {
    paintSticker(ctx, stickers[i], width, height, u, i === selected);
  }
}

function paintSticker(
  ctx: CanvasRenderingContext2D,
  s: StickerPlacement,
  w: number,
  h: number,
  u: number,
  selected: boolean,
) {
  const path = STICKER_SHAPES[s.shape];
  // 未知 shape(存档里的脏数据)跳过整张, 不让一条坏记录毁掉整层贴纸。
  if (!path) return;
  const size = s.size * u;
  if (size <= 0) return;

  ctx.save();
  ctx.translate(s.x * w, s.y * h);
  if (s.rotation) ctx.rotate((s.rotation * Math.PI) / 180);
  // 路径定义在 0..1 且以左上为原点(STICKER_SHAPES 的约定), 先缩放再平移
  // 让 (x,y) 落在贴纸的**中心**。缩放后坐标系里 1 单位 = size 像素。
  ctx.scale(size, size);
  ctx.translate(-0.5, -0.5);
  ctx.globalAlpha = s.opacity ?? 1;

  const p = new Path2D(path);
  if (s.fill) {
    ctx.fillStyle = s.fill;
    ctx.fill(p);
  }
  if (s.stroke) {
    ctx.strokeStyle = s.stroke;
    // 线宽除以 size: 当前坐标系已被缩放了 size 倍, 不除的话 2 会变成
    // 2*size 像素, 大贴纸的描边会粗得离谱。
    ctx.lineWidth = (s.strokeWidth ?? 0.02) / size;
    ctx.stroke(p);
  }

  if (selected) {
    // 选中框: 虚线 + 半透明底, 让"哪个被选中了"在密集摆放时一眼可见。
    // 只在编辑器里画, 烧录时 selected = -1。
    ctx.setLineDash([0.04, 0.03]);
    ctx.lineWidth = 0.012;
    ctx.strokeStyle = "#ffffff";
    ctx.strokeRect(0, 0, 1, 1);
    ctx.setLineDash([]);
    ctx.lineWidth = 0.02;
    ctx.strokeStyle = "#3b6cff";
    ctx.strokeRect(0, 0, 1, 1);
  }
  ctx.restore();
}

/** 屏幕坐标 → 照片相对坐标。夹到 0..1: 指针被 capture 后仍可能落在画布外。 */
function toRelative(e: React.PointerEvent<HTMLCanvasElement>) {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - rect.left) / (rect.width || 1);
  const y = (e.clientY - rect.top) / (rect.height || 1);
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

function isEditingText(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
}

export function StickerEditor({
  src,
  stickers,
  onChange,
  width,
  height,
  safe,
  showToolbar = true,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * 当前工具: "select" = 拖动/选中; 其余值 = "接下来点一下就放这种形状"。
   * 放完立刻回 select —— 连点几下想摆两颗同形贴纸时, 手动切回来太啰嗦,
   * 而"摆完仍处于放置态"会导致第二颗想拖动旧贴纸时反而多出一颗。
   */
  const [tool, setTool] = useState<StickerShapeKey | "select">("select");
  const [color, setColor] = useState(STICKER_DEFAULT_COLOR);
  const [selected, setSelected] = useState<number>(-1);
  // 正在拖动的贴纸。放 ref 不放 state: 拖动过程中每一帧都要算新坐标,
  // 放 state 会让"拖动"变成"每个 pointermove 触发一次 React 重渲染 +
  // 一次 store 写入", 手感发木。
  //
  // localX/localY 是"拖动期间**这一颗**的当前帧覆盖坐标":只动这一颗而不
  // 写 store,up 时再一次性 onChange 合进完整列表。父组件不会因为这一颗
  // 的位置而整体重渲染,选中/角标/其它贴纸都保持上一帧的稳定状态。
  const dragRef = useRef<{
    idx: number;
    offX: number;
    offY: number;
    localX: number;
    localY: number;
  } | null>(null);

  /**
   * 渲染当前一帧。拖动期间把「正在拖的这一颗」用 dragRef.localX/localY
   * 临时覆盖,**不**走 store —— 这样拖动期间的视觉跟随不走 React。
   * 其余贴纸一律读 stickers。
   */
  const repaint = useCallback(() => {
    const ctx = canvasRef.current?.getContext("2d") ?? null;
    if (!ctx) return;
    const drag = dragRef.current;
    const list =
      drag && drag.idx >= 0 && drag.idx < stickers.length
        ? stickers.map((s, i) =>
            i === drag.idx ? { ...s, x: drag.localX, y: drag.localY } : s,
          )
        : stickers;
    paintStickers(ctx, list, selected);
  }, [stickers, selected]);

  useEffect(() => {
    repaint();
  }, [repaint]);

  /**
   * 命中测试: 从上层往下找第一个落在「中心矩形」内的贴纸。
   *
   * 倒序遍历(而不是正序)是因为数组顺序即叠放顺序 —— 后加的盖在上面,
   * 点到重叠处时用户想抓的必然是最上面那颗。
   *
   * 用中心矩形而非外接圆 / 精确 path:
   *  - 极坐标形状(星/花)精确命中要写射线法, 几十行换来的精度用户感知不到;
   *  - 用外接圆会在稀疏的星形上"明明点在洞里也能拖", 让"点近抓住手感"打折;
   *  - 矩形 = 形状的轴对齐包围盒, 对花/星/心形都能稳定"点进贴纸内就抓到"。
   *
   * **必须把 (dx,dy) 绕贴纸中心逆旋转 s.rotation 度再判矩形**。否则心/
   * 星绕 30° 后用户从尖角点过去,点明明落在贴纸的可视范围内,中心矩形却
   * 说"没点中"。旋转判定等价于"在贴纸的本地坐标系里问点在哪":把世界向量
   * 旋转 -θ 后,贴纸回到了轴对齐位置,再用中心矩形即可。
   */
  const hitTest = useCallback(
    (x: number, y: number) => {
      const u = Math.min(width, height);
      for (let i = stickers.length - 1; i >= 0; i--) {
        const s = stickers[i];
        const half = (s.size * u) / 2;
        if (half <= 0) continue;
        const dx = (x - s.x) * u;
        const dy = (y - s.y) * u;
        // (dx,dy) 绕中心逆旋转 s.rotation 度:等价于把点转到贴纸的本地轴上。
        // 旋转矩阵 [[cos, sin], [-sin, cos]] 应用于 (dx,dy) 得:
        //   ldx = dx*cos + dy*sin
        //   ldy = -dx*sin + dy*cos
        // 无 rotation 时退化为 (dx, dy) 自身,与旧行为一致。
        const rot = ((s.rotation ?? 0) * Math.PI) / 180;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const ldx = dx * cos + dy * sin;
        const ldy = -dx * sin + dy * cos;
        if (Math.abs(ldx) <= half && Math.abs(ldy) <= half) return i;
      }
      return -1;
    },
    [stickers, width, height],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const p = toRelative(e);
    if (tool === "select") {
      const hit = hitTest(p.x, p.y);
      setSelected(hit);
      if (hit < 0) {
        // 命中失败时也吞掉事件: 外层装饰板的 onClick 会把 editingIdx 置空,
        // 即"点空白处等于关闭模态"。此处点空白再触发关闭是预期,但当用户
        // 在画布上点到了已有贴纸却没命中(旋转后尖角附近的轴对齐矩形外),
        // 二次点击会把模态关掉 —— 这是 H1 修之前的失败语义。命中后也
        // stopPropagation,避免重入事件链(例如外层挂的监听器因 React 18
        // 事件批处理被多触发一次)。
        e.stopPropagation();
        return;
      }
      const s = stickers[hit];
      // 记下"指针相对贴纸中心的偏移": 不记的话贴纸中心会瞬移到指针处,
      // 抓的时候视觉上"跳一下", 抓角上时还会把贴纸甩出去。
      dragRef.current = {
        idx: hit,
        offX: s.x - p.x,
        offY: s.y - p.y,
        localX: s.x,
        localY: s.y,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      // 命中贴纸后不再让外层吃到这次事件,否则同一 pointerup 链上外层
      // onClick 会把 editingIdx 置 null,模态立刻关掉。
      e.stopPropagation();
      return;
    }
    // 放置态: 落点即新贴纸中心。放完回到 select 并选中它, 用户接着就能拖。
    const next: StickerPlacement[] = [
      ...stickers,
      {
        shape: tool,
        x: p.x,
        y: p.y,
        size: STICKER_DEFAULT_SIZE,
        rotation: 0,
        fill: color,
      },
    ];
    onChange(next);
    setSelected(next.length - 1);
    setTool("select");
    // 落点成功: 别让同 pointerup 链上外层 onClick 关闭模态。
    e.stopPropagation();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = toRelative(e);
    // 拖动期间**只**写本地 ref + 主动重画, 不调 onChange → 不写 store →
    // 不触发父组件订阅者重渲染(选中/计数/角标等)。up 时再一次性 onChange
    // 合进完整列表。这是把"每帧写 store"压成"一次写 store",对 H2 的关键
    // 修复。坐标系仍按照片相对 0..1 夹紧, 防止指针被 capture 后滑出画布
    // 落到 1.05 / -0.05 这种异常坐标。
    drag.localX = Math.min(1, Math.max(0, p.x + drag.offX));
    drag.localY = Math.min(1, Math.max(0, p.y + drag.offY));
    repaint();
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag && (drag.localX !== stickers[drag.idx]?.x || drag.localY !== stickers[drag.idx]?.y)) {
      // 拖动期间确实移动过: 把 localX/localY 合回 store,这是整个拖动过程
      // 唯一一次 onChange。其余 onChange(选中态变化等)由各自的回调独立触发,
      // 互不影响。
      const next = stickers.slice();
      next[drag.idx] = { ...next[drag.idx], x: drag.localX, y: drag.localY };
      onChange(next);
    }
    dragRef.current = null;
    // releasePointerCapture 在 pointercancel/失焦后调用会抛 InvalidStateError
    // (Pointer already released / Not in active pointer state)。try/catch
    // 是必须的 —— 没保护的话一个被 cancel 的拖动会在控制台留下红色堆栈,
    // 且流程被未捕获异常打断,后续 onPointerUp / state 更新都不会跑。
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // 静默吃掉: pointer 主动结束/cancel 时再 release 是无意义的,但出错
      // 不应影响业务流程。
    }
  };

  /**
   * Delete / Backspace 删除选中的贴纸。
   *
   * 挂 window 而不是 canvas: 画布没有 tabIndex, 焦点通常不在它身上,
   * 绑在元素上等于永远收不到按键。
   *
   * 输入框内不拦截: 贴纸 tab 与其它 tab 同页共存, 用户若在某个输入框里
   * 按 Backspace 想删字符, 却把贴纸删了, 是比"按了没反应"严重得多的 bug。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (isEditingText(e.target)) return;
      if (selected < 0 || selected >= stickers.length) return;
      e.preventDefault();
      onChange(stickers.filter((_, i) => i !== selected));
      setSelected(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, stickers, onChange]);

  const selectedSticker = selected >= 0 ? stickers[selected] : null;

  /** 旋转: 每次 15°, 归一到 (-180, 180] 免得转几圈后数字变成 1080。 */
  const rotateSelected = (delta: number) => {
    if (!selectedSticker) return;
    const next = stickers.slice();
    let deg = (selectedSticker.rotation + delta) % 360;
    if (deg > 180) deg -= 360;
    if (deg <= -180) deg += 360;
    next[selected] = { ...selectedSticker, rotation: deg };
    onChange(next);
  };

  /** 改色: 只改选中的那颗。没选中就不动 —— 避免"点了色板全场变色"的意外。 */
  const recolorSelected = (fill: string) => {
    if (!selectedSticker) return;
    const next = stickers.slice();
    next[selected] = { ...selectedSticker, fill };
    onChange(next);
  };

  const removeSelected = () => {
    if (selected < 0 || selected >= stickers.length) return;
    onChange(stickers.filter((_, i) => i !== selected));
    setSelected(-1);
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
        data-sticker-canvas=""
        // backing store 取 2×(与 DoodleCanvas 一致): 预览与成片的贴纸
        // 在同一相对位置上按同一比例缩放, 只是成片更大。
        width={Math.round(width * 2)}
        height={Math.round(height * 2)}
        style={{ width, height }}
        className="absolute inset-0 touch-none cursor-pointer"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        // onPointerDown 里已 stopPropagation,但 pointer 与 click 是两条独立
        // 事件链:pointerdown 之后浏览器仍会触发一次原生 click,在 React 事件
        // 树上冒泡到外层,触发装饰页 onClick={setEditingIdx(null)} 把模态关掉。
        // 补一个 click 也 stopPropagation,确保画布上任何落点/拖动都不被外层
        // 误判成"点空白处=关闭"。
        onClick={(e) => e.stopPropagation()}
      />

      {/* 形状工具条。放画布内而不是模态顶部: 摆放是"看着照片点"的动作,
          工具条离点按位置越近, 视线来回扫动的距离越短。 */}
      {showToolbar && (
        <div className="absolute left-2 top-2 flex flex-wrap gap-1">
          <button
            type="button"
            data-sticker-tool="select"
            aria-pressed={tool === "select"}
            onClick={() => setTool("select")}
            className={`rounded-full px-2 py-1 text-[10px] shadow transition ${
              tool === "select" ? "bg-brick text-white" : "bg-white/90 text-brown"
            }`}
          >
            拖动
          </button>
          {STICKER_SHAPE_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              data-sticker-shape={k}
              aria-pressed={tool === k}
              onClick={() => setTool(k)}
              className={`rounded-full px-2 py-1 text-[10px] shadow transition ${
                tool === k ? "bg-brick text-white" : "bg-white/90 text-brown"
              }`}
            >
              {STICKER_SHAPE_NAMES[k]}
            </button>
          ))}
        </div>
      )}

      {/* 色板 + 选中贴纸的微调(旋转/换色/删除)。同样贴画布内。 */}
      {showToolbar && (
        <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
          <div className="flex flex-wrap justify-end gap-1">
            {STICKER_COLORS.map((c) => (
              <button
                key={c.color}
                type="button"
                data-sticker-color={c.color}
                onClick={() => {
                  setColor(c.color);
                  recolorSelected(c.color);
                }}
                aria-pressed={selectedSticker?.fill === c.color}
                aria-label={`贴纸颜色 ${c.name}`}
                title={c.name}
                style={{ background: c.color }}
                className={`h-5 w-5 rounded-full border-2 transition ${
                  selectedSticker?.fill === c.color
                    ? "border-brick scale-110"
                    : "border-white"
                }`}
              />
            ))}
          </div>
          {selectedSticker && (
            <div className="flex items-center gap-1 rounded-full bg-white/90 px-1.5 py-1 shadow">
              <span className="text-[10px] text-brown" data-sticker-selected-rot="">
                {Math.round(selectedSticker.rotation)}°
              </span>
              <button
                type="button"
                data-sticker-rotate="-15"
                onClick={() => rotateSelected(-15)}
                title="逆时针旋转 15°"
                className="rounded-full bg-cream px-1.5 text-[10px] text-brown"
              >
                ↺
              </button>
              <button
                type="button"
                data-sticker-rotate="15"
                onClick={() => rotateSelected(15)}
                title="顺时针旋转 15°"
                className="rounded-full bg-cream px-1.5 text-[10px] text-brown"
              >
                ↻
              </button>
              <button
                type="button"
                data-sticker-delete=""
                onClick={removeSelected}
                className="rounded-full bg-brick px-1.5 text-[10px] text-white"
              >
                删除
              </button>
            </div>
          )}
        </div>
      )}

      {/*
        四边安全区遮罩 —— 与 DoodleCanvas 里那份**结构完全相同**。
        复用理由不只是"省几行代码": 两层共用同一个 doodleSafeArea 口径,
        贴纸与笔迹的"会不会被裁"才必然一致。若贴纸自己写一份常量,
        排版一换(6inch_4p 裁的是上下)就会出现"笔迹提示对了、贴纸提示错了"。
        详见 DoodleCanvas 里 data-doodle-safe 遮罩的注释。

        **z-20 把遮罩抬到色板工具条之上**:遮罩是「被裁区提示」, 用户必须
        能清楚看到它「压暗了多少、覆盖到哪」。若 z 与工具条平级或更低,
        色板的白色背景/阴影会把遮罩完全吃掉, 一旦边角被工具条压住, 用户
        会以为排版没裁而把贴纸摆进去 —— 结果就是出片被静默切掉。遮罩是
        `pointer-events-none`, 把它抬高不会拦截工具条点击, 只影响视觉
        层级。
      */}
      {safe.left > 0 && (
        <div
          data-sticker-safe="left"
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 z-20 bg-black/45"
          style={{ width: `${safe.left * 100}%` }}
        />
      )}
      {safe.right > 0 && (
        <div
          data-sticker-safe="right"
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 z-20 bg-black/45"
          style={{ width: `${safe.right * 100}%` }}
        />
      )}
      {safe.top > 0 && (
        <div
          data-sticker-safe="top"
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 z-20 bg-black/45"
          style={{ height: `${safe.top * 100}%` }}
        />
      )}
      {safe.bottom > 0 && (
        <div
          data-sticker-safe="bottom"
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-black/45"
          style={{ height: `${safe.bottom * 100}%` }}
        />
      )}
    </div>
  );
}
