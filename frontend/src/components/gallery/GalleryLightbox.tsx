/**
 * 画廊大图灯箱 —— 全屏看历史产物, 并从原图重新编辑大头贴。
 *
 * 为什么是独立组件而不是塞进 GalleryPage
 * --------------------------------------
 * 灯箱有自己的一套状态(当前第几张、是否在重新编辑)和一个**全局**键盘
 * 监听。混在 GalleryPage 里会让"列表筛选状态"与"正在看第几张图"互相
 * 污染 —— 尤其要按 Esc 退出时, 究竟是关灯箱还是清筛选, 两种语义混在一个
 * 组件里会变成一个 if/else 里猜的分支。
 *
 * 键盘约定: Esc 关闭 / ← → 翻页 / Home End 跳首尾。
 * 翻页在**两端不循环**(第一张按 ← 停在第一张), 因为灯箱的内容是有序产物
 * (原图 1→2→拼图→分享卡), 循环会让用户误以为已经翻完。
 */
import { useCallback, useEffect, useState } from "react";
import type { GalleryItem, GalleryMedia } from "../../types";
import { StickerEditor } from "../stickers/StickerEditor";
import { burnStickers } from "../stickers/burnStickers";
import type { StickerPlacement } from "../stickers/stickerTypes";
import { saveCaptures } from "../../api";

interface Props {
  item: GalleryItem;
  /** 初始展示第几张。点"重新编辑"时用当前这张的序号传进来。 */
  initialIndex: number;
  onClose: () => void;
  /** 新 job 落盘后回调, 让画廊刷新出新记录。 */
  onSaved: () => void;
}

export function GalleryLightbox({ item, initialIndex, onClose, onSaved }: Props) {
  const media = item.media ?? [];
  const [idx, setIdx] = useState(() =>
    Math.min(Math.max(0, initialIndex), Math.max(0, media.length - 1)),
  );
  /** 正在编辑的源图(仅 kind==="photo" 可能非空)。null = 只看不做。 */
  const [editing, setEditing] = useState<GalleryMedia | null>(null);
  const current = media[idx] ?? null;

  const go = useCallback(
    (delta: number) => {
      setIdx((v) => Math.min(media.length - 1, Math.max(0, v + delta)));
    },
    [media.length],
  );

  // 键盘监听挂 window: 灯箱是个覆盖层, 焦点在 body 上, 绑在容器 div 上
  // 等于永远收不到按键。放在这里统一管, 而不是让 useEscape 只管 Esc ——
  // 方向键与 Esc 必须在**同一个**回调里判断, 否则按下 Esc 时两个监听器
  // 都跑, "关灯箱"和"退出重新编辑"会同时发生(闪一下又回到灯箱)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 编辑态优先: 此时 Esc/方向键属于编辑器, 不能被灯箱抢走。
      // StickerEditor 自己监听 Delete/方向键无关的按键, 这里只挡 Esc。
      if (editing) {
        if (e.key === "Escape") {
          e.stopPropagation();
          setEditing(null);
        }
        return;
      }
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "Home") setIdx(0);
      else if (e.key === "End") setIdx(media.length - 1);
      else return;
      // 方向键/Home/End 默认会滚动页面, 灯箱内不该出现"翻页顺便滚一下"。
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, go, onClose, media.length]);

  if (!current) return null;

  return (
    <div
      data-gallery-lightbox=""
      className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`${item.title || "记录"} 大图查看`}
    >
      {/* 顶栏: 标题 / 序号 / 关闭 */}
      <div className="flex items-start justify-between gap-3 px-4 py-3 text-white">
        <div className="min-w-0">
          <div className="truncate text-sm font-pixel">
            {item.title || new Date(item.mtime * 1000).toLocaleString()}
          </div>
          <div className="text-xs text-white/60" data-lightbox-counter="">
            {idx + 1} / {media.length} · {current.label}
          </div>
        </div>
        <button
          type="button"
          data-lightbox-close=""
          onClick={onClose}
          aria-label="关闭大图"
          className="shrink-0 rounded-full bg-white/15 px-3 py-1.5 text-xs hover:bg-white/30"
        >
          关闭 ✕
        </button>
      </div>

      {/* 主体: 左 / 图 / 右 */}
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 px-2">
        <button
          type="button"
          data-lightbox-prev=""
          onClick={() => go(-1)}
          disabled={idx === 0}
          aria-label="上一张"
          className="shrink-0 rounded-full bg-white/15 px-3 py-2 text-white disabled:opacity-25 hover:bg-white/30"
        >
          ‹
        </button>

        <div className="flex min-h-0 flex-1 items-center justify-center">
          {editing ? (
            <ReeditPanel
              media={editing}
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                onSaved();
              }}
            />
          ) : (
            <img
              key={current.url}
              src={current.url}
              alt={current.label}
              data-lightbox-image=""
              className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
            />
          )}
        </div>

        <button
          type="button"
          data-lightbox-next=""
          onClick={() => go(1)}
          disabled={idx >= media.length - 1}
          aria-label="下一张"
          className="shrink-0 rounded-full bg-white/15 px-3 py-2 text-white disabled:opacity-25 hover:bg-white/30"
        >
          ›
        </button>
      </div>

      {/* 底栏: 胶片条 + 下载 + 重新编辑 */}
      {!editing && (
        <div className="flex flex-col gap-2 px-4 py-3">
          {media.length > 1 && (
            <div className="flex flex-wrap justify-center gap-1.5">
              {media.map((m, i) => (
                <button
                  key={m.url}
                  type="button"
                  data-lightbox-thumb={i}
                  onClick={() => setIdx(i)}
                  aria-label={m.label}
                  aria-current={i === idx}
                  className={`overflow-hidden rounded border-2 ${
                    i === idx ? "border-white" : "border-white/30 opacity-60"
                  }`}
                >
                  <img
                    src={m.url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="h-10 w-10 object-cover"
                  />
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center justify-center gap-2">
            <a
              href={current.url}
              download={`${item.job_id}_${current.label}`}
              data-lightbox-download=""
              className="rounded-full bg-white/15 px-3 py-1.5 text-xs text-white hover:bg-white/30"
            >
              下载这张
            </a>
            {/*
              「重新编辑」只对原图开放。拼图/分享卡是**派生产物**(多图合成),
              拿它当编辑输入等于把合成结果再叠一层贴纸 —— 用户要的"再编辑"
              几乎总是针对某一张原图。刻意不在这里判断可行性, 而是直接不
              渲染这个按钮: 灰着点的按钮会让人反复点, 解释成本比省下的那点
              像素高得多。
            */}
            {current.kind === "photo" && (
              <button
                type="button"
                data-lightbox-reedit=""
                onClick={() => setEditing(current)}
                className="rounded-full bg-brick px-3 py-1.5 text-xs text-white hover:brightness-110"
              >
                重新编辑这张
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 重新编辑面板: 一张历史原图 + 贴纸工具条, 存为**新** job。
 *
 * 三个刻意的选择:
 *
 * 1. **局部 state, 不碰拍摄 store**。store 里的 stickerOverrides/frames
 *    属于"这一轮连拍", 灌进历史照片会污染用户正在进行的拍摄流程; 而历史
 *    记录本来就没存过贴纸摆位(后端 _album.json 只存标题/备注/标签/收藏),
 *    所以这里从空白开始 —— 试图"恢复上次的摆位"是不可能的, 假装能恢复
 *    只会让用户以为数据丢了。
 *
 * 2. **存为新 job, 绝不覆盖原记录**。原图是用户的历史资产, 重新编辑是
 *    派生。saveCaptures 每次都建新 job, 于是"再编辑一次"可以无限重复,
 *    且旧版本永远可回溯。
 *
 * 3. **只用贴纸层, 不接涂鸦/滤镜/相框**。历史原图是**已经烧完滤镜与年代
 *    处理**的成片, 再叠一层滤镜是双重处理。要完整流水线应该回拍摄页重来,
 *    这里提供的是"给这张图加点东西"的轻量路径。
 */
function ReeditPanel({
  media,
  onCancel,
  onSaved,
}: {
  media: GalleryMedia;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [stickers, setStickers] = useState<StickerPlacement[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 画布显示尺寸。与照片同比例(4:3), 否则贴纸的 0..1 坐标会相对"被裁后
  // 的画面", 烧录时整体偏移 —— 与 StickerEditor 的 width/height 契约同源。
  const W = 640;
  const H = 480;

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const src = await fetch(media.url).then((r) => {
        if (!r.ok) throw new Error(`读取原图失败 ${r.status}`);
        return r.blob();
      });
      const edited = await burnStickers(src, stickers);
      await saveCaptures([edited]);
      onSaved();
    } catch (e) {
      setError((e as Error).message ?? String(e));
      setBusy(false);
    }
  };

  return (
    <div
      data-gallery-reedit=""
      className="flex max-h-full w-full flex-col items-center gap-2 overflow-auto p-2"
    >
      <StickerEditor
        src={media.url}
        stickers={stickers}
        onChange={setStickers}
        width={W}
        height={H}
        safe={{ left: 0, right: 0, top: 0, bottom: 0 }}
      />
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          data-reedit-cancel=""
          onClick={onCancel}
          disabled={busy}
          className="rounded-full bg-white/15 px-3 py-1.5 text-xs text-white hover:bg-white/30 disabled:opacity-40"
        >
          取消
        </button>
        <button
          type="button"
          data-reedit-save=""
          onClick={save}
          disabled={busy}
          className="rounded-full bg-brick px-4 py-1.5 text-xs text-white hover:brightness-110 disabled:opacity-40"
        >
          {busy ? "正在保存..." : "存为新的一张"}
        </button>
        <span className="text-[11px] text-white/60">
          原记录不会被覆盖, 会新增一条
        </span>
      </div>
      {error && <div className="text-xs text-red-300">{error}</div>}
    </div>
  );
}
