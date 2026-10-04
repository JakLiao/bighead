/**
 * 相框几何计算 —— 屏幕预览与 canvas 出片共用的唯一真相源。
 *
 * 为什么单独抽出来:LIVE 预览(div 叠加)和 snap()(canvas 合成)必须算出
 * 完全一样的边框宽度与标题位置,否则用户会看到"取景框里框很窄,拍出来框很宽"。
 * 两边各写一份 CSS/像素换算是这类 bug 的典型来源。
 *
 * 坐标系约定:pad 在后端是按 960 短边基准设计的像素数,这里按 shortSide/960
 * 等比缩放,保证预览与成片的边框视觉比例一致。
 */
import type { FrameInfo } from "../types";

export interface FrameGeometry {
  /** 相框是否需要绘制 */
  hasFrame: boolean;
  /** 照片区域相对"整张成片"的左上角坐标与尺寸 */
  photo: { x: number; y: number; w: number; h: number };
  /** 整张成片(含边框)的尺寸 */
  canvas: { w: number; h: number };
  /** 底部标题文字(无底部留白时为空) */
  title: string;
  /** 标题文字颜色 */
  titleColor: string;
  /** 棋盘格背景标记 */
  checker: boolean;
}

/**
 * 按成片最终尺寸推导相框几何。
 *
 * @param frame      后端下发的相框参数
 * @param photoW     照片区域宽度(出片时为 canvas 内照片的宽)
 * @param photoH     照片区域高度
 */
export function computeFrameGeometry(
  frame: FrameInfo | undefined,
  photoW: number,
  photoH: number,
): FrameGeometry {
  const pad = frame?.pad ?? 0;
  const bottomPad = frame?.bottom_pad ?? 0;

  if (pad <= 0) {
    return {
      hasFrame: false,
      photo: { x: 0, y: 0, w: photoW, h: photoH },
      canvas: { w: photoW, h: photoH },
      title: "",
      titleColor: "#5a4646",
      checker: false,
    };
  }

  // 基准:取景框里照片区域的短边,按 pad 的设计像素等比缩放。
  // 缩放因子让"预览里的框"和"成片里的框"保持同一视觉比例,
  // 而非在 640px 预览和 1280px 成片上得到两套绝对像素宽度。
  const shortSide = Math.min(photoW, photoH);
  const scale = shortSide / 960; // 960 = 后端相框的参考基准边

  const p = Math.max(2, Math.round(pad * scale));
  const bp = Math.max(0, Math.round(bottomPad * scale));

  return {
    hasFrame: true,
    photo: { x: p, y: p, w: photoW, h: photoH },
    canvas: { w: photoW + p * 2, h: photoH + p + bp },
    title: frame?.title ?? "",
    titleColor: "#5a4646",
    checker: frame?.bg === "checker",
  };
}

/** 相框背景:纯色或棋盘格渐变。棋盘格与后端 _checker_bg 的观感一致。 */
export function frameBackgroundStyle(g: FrameGeometry, bgColor: string): string {
  if (!g.hasFrame) return "transparent";
  if (!g.checker) return bgColor;
  // 18px 棋盘格,与后端 _checker_bg(cell=16) 接近
  return (
    "repeating-conic-gradient(#fff0f0 0% 25%, #dcc8c8 0% 50%) 0 0 / 36px 36px"
  );
}
