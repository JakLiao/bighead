/**
 * 取景框实时蒙版层。
 *
 * 对标 JUST FOTO 的核心体验:按下快门之前,屏幕上就能看到成片的边框、暗角
 * 和构图引导线 —— 即"所见即所得"。用户不必拍完再去 DecoratePage 猜成什么样。
 *
 * 全部尺寸用 px 显式计算(而非百分比),因为相框宽度必须与 snap() 出片时的
 * 边框宽度严格成比例,百分比在非正方形容器里会各自缩放导致比例漂移。
 *
 * 纯展示层,不吃事件(pointer-events-none),不影响快门与倒计时。
 */
import { computeFrameGeometry, frameBackgroundStyle } from "./frameGeometry";
import type { FrameInfo } from "../types";

interface Props {
  frame?: FrameInfo;
  /** 滤镜的暗角强度 0..1,叠径向渐变还原后端 _vignette */
  vignette: number;
  /** 是否显示四格分割线与人像留白提示 */
  showGuides: boolean;
  /** 双人蒙版:给两个留白框而不是一个 */
  dual?: boolean;
  /** 取景容器的像素尺寸,由父级 ResizeObserver 量出 */
  containerWidth: number;
  containerHeight: number;
}

export function MaskOverlay({
  frame,
  vignette,
  showGuides,
  dual = false,
  containerWidth,
  containerHeight,
}: Props) {
  if (containerWidth <= 0 || containerHeight <= 0) return null;

  const g = computeFrameGeometry(frame, containerWidth, containerHeight);

  // 容器显示的就是照片区,成片比照片区大出四周的边框。
  // s = 容器宽 / 照片宽,把"成片像素"映射到"屏幕像素"。
  const s = containerWidth / g.photo.w;
  const side = g.photo.x * s;        // 上下左右单边边框的屏幕厚度
  const bottom = (g.photo.x + (g.canvas.h - g.photo.h - g.photo.y)) * s; // 下边框 + 底部留白
  const bg = frameBackgroundStyle(g, frame?.bg ?? "#ffffff");

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* 暗角:CSS filter 表达不了后端的 _vignette,这里用径向渐变还原。
          中心亮、边缘按 strength 压暗,与后端按中心距衰减的算法同构。 */}
      {vignette > 0 && (
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 35%, rgba(0,0,0,${(
              vignette * 0.75
            ).toFixed(3)}) 100%)`,
          }}
        />
      )}

      {/* 相框:四片色块盖住画面边缘,与后端 ImageOps.expand 的落点一致。
          画在视频之上,模拟"相纸压住照片边缘"的观感。 */}
      {g.hasFrame && (
        <>
          <div className="absolute left-0 right-0 top-0" style={{ height: side, background: bg }} />
          <div className="absolute left-0 right-0 bottom-0" style={{ height: bottom, background: bg }} />
          <div className="absolute left-0" style={{ top: side, width: side, bottom: bottom, background: bg }} />
          <div className="absolute right-0" style={{ top: side, width: side, bottom: bottom, background: bg }} />
          {g.title && (
            <div
              className="absolute left-0 right-0 flex items-center justify-center"
              style={{ bottom: 0, height: bottom, paddingBottom: bottom * 0.18 }}
            >
              <span className="font-mono-retro text-xs" style={{ color: g.titleColor }}>
                {g.title}
              </span>
            </div>
          )}
        </>
      )}

      {/* 构图引导:四宫格分割线 + 人像留白框。
          双人蒙版给两个留白框,提示两位用户各站一边。
          对应 JUST FOTO「站在取景框中的留白位置」的做法。 */}
      {showGuides && (
        <>
          <svg
            className="absolute inset-0 h-full w-full"
            preserveAspectRatio="none"
            viewBox="0 0 100 100"
          >
            {[33.33, 66.66].map((p) => (
              <g key={p} stroke="rgba(255,255,255,0.4)" strokeWidth="0.3">
                <line x1={p} y1="0" x2={p} y2="100" />
                <line x1="0" y1={p} x2="100" y2={p} />
              </g>
            ))}
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            {dual ? (
              <div className="flex w-[72%] items-center justify-center gap-[8%]">
                {[0, 1].map((i) => (
                  <div
                    key={i}
                    className="rounded-[50%] border-2 border-dashed border-white/45"
                    style={{ width: "42%", aspectRatio: "3 / 4" }}
                  />
                ))}
              </div>
            ) : (
              <div
                className="rounded-[50%] border-2 border-dashed border-white/45"
                style={{ width: "34%", aspectRatio: "3 / 4" }}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
