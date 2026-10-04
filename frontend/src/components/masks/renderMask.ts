/**
 * 蒙版渲染器 —— 预览与出片共用的**唯一**实现。
 *
 * 返回一张带透明镂空的画布:背景 + 装饰已画好,人脸形状的洞被挖空。
 *   · 预览:把这张画布盖在 <video> 上,视频从洞里透出来
 *   · 出片:把同一张画布盖在照片上
 * 因为是同一份代码 + 同一份参数,所见即所得是结构上保证的,不靠人工对齐。
 *
 * 绘制顺序很关键:先背景、再装饰、**最后**挖洞。否则装饰会盖在洞上,
 * 出现"贴纸糊在人脸前面"的穿帮。
 */
import { STICKER_SHAPES } from "./geometry";
import type { MaskDef } from "./maskDefs";

/** 单位坐标(0..100)→ 画布像素。以短边为基准,保证正方形不被拉扁。 */
function unit(w: number, h: number, size = 100) {
  const s = Math.min(w, h) / size;
  return {
    s,
    x: (v: number) => (w - size * s) / 2 + v * s,
    y: (v: number) => (h - size * s) / 2 + v * s,
  };
}

function drawPattern(
  ctx: CanvasRenderingContext2D,
  mask: MaskDef,
  w: number,
  h: number,
) {
  const u = unit(w, h);
  ctx.fillStyle = mask.background;
  ctx.fillRect(0, 0, w, h);

  const c = mask.patternColor;
  if (!c || mask.pattern === "solid" || !mask.pattern) return;
  ctx.save();
  ctx.fillStyle = c;
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = c;
  ctx.lineWidth = Math.max(1, u.s * 0.8);

  switch (mask.pattern) {
    case "checker": {
      const cell = u.s * 8;
      for (let y = 0; y < h; y += cell) {
        for (let x = 0; x < w; x += cell) {
          if ((Math.floor(x / cell) + Math.floor(y / cell)) % 2) {
            ctx.fillRect(x, y, cell, cell);
          }
        }
      }
      break;
    }
    case "dots": {
      const step = u.s * 9;
      const r = u.s * 1.1;
      for (let y = step / 2; y < h + step; y += step) {
        for (let x = step / 2; x < w + step; x += step) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
    case "grid": {
      const step = u.s * 11;
      for (let x = step; x < w; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = step; y < h; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      break;
    }
    case "stripes": {
      ctx.lineWidth = u.s * 4;
      ctx.globalAlpha = 0.35;
      for (let i = -h; i < w; i += u.s * 14) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + h, h);
        ctx.stroke();
      }
      break;
    }
  }
  ctx.restore();
}

/** 沿路径填充/描边一个贴纸。 */
function paintSticker(
  ctx: CanvasRenderingContext2D,
  d: NonNullable<MaskDef["stickers"]>[number],
  w: number,
  h: number,
  path: string,
) {
  const u = unit(w, h);
  const size = d.size * u.s;
  const cx = u.x(d.x);
  const cy = u.y(d.y);

  ctx.save();
  ctx.translate(cx, cy);
  if (d.rot) ctx.rotate((d.rot * Math.PI) / 180);
  ctx.scale(size, size);
  // 路径定义在 0..1,以左上为原点;平移到中心。
  ctx.translate(-0.5, -0.5);
  ctx.globalAlpha = d.opacity ?? 1;

  const p = new Path2D(path);
  if (d.fill) {
    ctx.fillStyle = d.fill;
    ctx.fill(p);
  }
  if (d.stroke) {
    ctx.strokeStyle = d.stroke;
    ctx.lineWidth = (d.strokeWidth ?? 2) / size;
    ctx.stroke(p);
  }
  ctx.restore();
}

/**
 * 渲染蒙版层。
 * @returns 带透明镂空的画布,尺寸与 w×h 一致
 */
export function renderMaskLayer(
  mask: MaskDef | undefined,
  w: number,
  h: number,
): HTMLCanvasElement | null {
  if (!mask || w <= 0 || h <= 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  drawPattern(ctx, mask, w, h);

  // 彩纸屑
  for (const cf of mask.confetti ?? []) {
    const u = unit(w, h);
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = cf.fill;
    ctx.translate(u.x(cf.x), u.y(cf.y));
    ctx.rotate(((cf.rot ?? 0) * Math.PI) / 180);
    const s = cf.size * u.s;
    ctx.fillRect(-s / 2, -s / 2, s, s * 1.6);
    ctx.restore();
  }

  // 贴纸
  for (const d of mask.stickers ?? []) {
    const path = STICKER_SHAPES[d.shape];
    if (path) paintSticker(ctx, d, w, h, path);
  }

  // 文字
  for (const t of mask.texts ?? []) {
    const u = unit(w, h);
    ctx.save();
    ctx.translate(u.x(t.x), u.y(t.y));
    if (t.rot) ctx.rotate((t.rot * Math.PI) / 180);
    const px = t.size * u.s;
    ctx.font = `${px}px ${t.font ?? "monospace"}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (t.stroke) {
      ctx.strokeStyle = t.stroke;
      ctx.lineWidth = (t.strokeWidth ?? 3) / u.s;
      ctx.strokeText(t.text, 0, 0);
    }
    ctx.fillStyle = t.fill;
    ctx.fillText(t.text, 0, 0);
    ctx.restore();
  }

  // 最后挖洞 —— 放在所有装饰之后,保证洞里干净,不会有贴纸盖在人脸上。
  //
  // 逐条独立填充(而不是把所有洞塞进一个 Path2D 再用 evenodd):
  //   · evenodd 下两条重叠子路径会互相"抵消"成实心,猫耳/熊耳会变成熊猫
  //   · 而 destination-out 逐条擦除时,重叠处被擦两次依然是全透明,
  //     天然得到并集,不需要 any 之类的技巧
  const u = unit(w, h);
  // 缩放系数:洞路径定义在 0..1,mask.scale 是"占画面多少"的比例。
  // 双人用画面宽度作基准(wide),单人用短边(square)——
  // 正方形空间下并排两个洞会紧贴粘连,必须用满宽度才留得出中间间隙。
  const base = mask.space === "wide" ? w : Math.min(w, h);
  const s = mask.scale * base;
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "#000";
  for (const hole of mask.holes) {
    const p = new Path2D(hole);
    ctx.save();
    ctx.translate(u.x(50 + (mask.offsetX ?? 0)), u.y(50 + (mask.offsetY ?? 0)));
    ctx.scale(s, s);
    ctx.translate(-0.5, -0.5);
    ctx.fill(p);
    ctx.restore();
  }
  ctx.globalCompositeOperation = "source-over";

  return canvas;
}

/** 供 UI 画缩略图:把蒙版层缩放到小尺寸,便于在选择条里预览。 */
export function renderMaskThumb(
  mask: MaskDef | undefined,
  size: number,
): HTMLCanvasElement | null {
  return renderMaskLayer(mask, size, size);
}
