import type { FrameInfo } from "../types";

interface Props {
  frames: FrameInfo[];
  selected: string;
  onSelect: (k: string) => void;
}

/**
 * 相框选择条。每个按钮用真实的 bg 色 + 棋盘格缩略预览,
 * 让用户在按快门前就知道选中后画面四周会是什么样子 ——
 * 这正是 JUST FOTO "选边框 → 取景框实时呈现" 的前半段。
 */
export function FrameStrip({ frames, selected, onSelect }: Props) {
  return (
    <div className="flex gap-2 overflow-x-auto py-2 px-1">
      {frames.map((f) => (
        <button
          key={f.key}
          onClick={() => onSelect(f.key)}
          className={`flex-shrink-0 flex flex-col items-center gap-1 px-3 py-2 rounded-xl text-xs border transition ${
            selected === f.key
              ? "bg-brick text-white border-brick shadow"
              : "bg-white/80 text-brown border-pink hover:bg-pink/40"
          }`}
        >
          <span
            className="flex h-9 w-9 items-center justify-center rounded-md border border-black/10"
            style={{
              background:
                f.bg === "checker"
                  ? "repeating-conic-gradient(#fff0f0 0% 25%, #dcc8c8 0% 50%) 0 0 / 10px 10px"
                  : f.pad > 0
                    ? f.bg
                    : "transparent",
            }}
          >
            {f.pad > 0 && (
              <span className="block h-4 w-4 rounded-sm bg-deepblue/70" />
            )}
          </span>
          {f.name}
        </button>
      ))}
    </div>
  );
}
