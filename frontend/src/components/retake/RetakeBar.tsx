/**
 * 「重拍本张 / 继续」暂停确认条。
 *
 * 仅在 idx < PHOTO_COUNT - 1 时出现, 第 4 张拍完由 HomePage 直接 nav 走。
 * 重拍与继续都通过 onPick(mode) 上抛, 由父组件统一 setSnapTick 复用 3-2-1 倒计时,
 * RetakeBar 自己不调任何相机接口 —— 与 CountdownOverlay 的「tick 自增即重启」
 * 语义保持同源。
 *
 * 视觉上盖在 LiveCamera 下方, 不会遮住取景框主体, 用户既能看到自己也能
 * 看到刚拍的那张缩略图。
 */
interface Props {
  /** 刚拍好的照片(用于左侧小预览) */
  previewUrl: string | null;
  /** 1-based 张数, 用于文案 */
  photoNumber: number;
  /** 总张数, 用于文案 */
  total: number;
  onPick: (mode: "retake" | "continue") => void;
}

export function RetakeBar({ previewUrl, photoNumber, total, onPick }: Props) {
  return (
    <div
      className="absolute bottom-0 inset-x-0 z-30
                 bg-cream/95 border-t-2 border-pink
                 px-4 py-3 flex items-center gap-3 backdrop-blur-sm"
    >
      {previewUrl && (
        <img
          src={previewUrl}
          alt=""
          className="w-12 h-16 object-cover rounded border-2 border-pink"
        />
      )}
      <div className="flex-1 text-sm text-brown">
        第 <span className="font-pixel text-brick">{photoNumber}</span> / {total} 张拍好了
      </div>
      <button
        type="button"
        onClick={() => onPick("retake")}
        className="px-4 py-2 rounded-full bg-white border-2 border-brick text-brick text-sm hover:bg-pink/30"
      >
        重拍本张
      </button>
      <button
        type="button"
        onClick={() => onPick("continue")}
        className="px-4 py-2 rounded-full bg-brick text-white text-sm hover:bg-brick/90"
      >
        继续
      </button>
    </div>
  );
}
