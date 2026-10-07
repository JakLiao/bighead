import { useCallback, useEffect, useState } from "react";
import { emptyTrash, fetchTrash, purgeFromTrash, restoreFromTrash } from "../../api";
import type { TrashItem, TrashResponse } from "../../types";
import { useEscape } from "./useEscape";

/**
 * 回收站抽屉。
 *
 * 存在的唯一理由: 让"删除"变成**可撤销**的。photos 删了就找不回来,
 * 所以删错一次的心理代价很高; 有回收站之后, 两段式确认不再需要
 * 承担全部风险, 用户敢删。
 *
 * 三个刻意的设计决定:
 *
 * 1. **懒加载**: 挂载时才拉列表, 而不是画廊加载时就拉。回收站几乎总是空的,
 *    为一个空列表在首屏路径上多打一个请求不值得。
 * 2. **每条都能单独恢复或彻底删**, 而不是只有"清空"。用户想找回的是
 *    具体那一张, 不是"把回收站整个还原"。
 * 3. **明确写出剩余天数与占用空间**。不给数字的话用户没法判断该不该清空,
 *    于是回收站只进不出, 磁盘被无声吃掉。
 */
export default function TrashPanel({
  onClose,
  onRestored,
}: {
  onClose: () => void;
  /** 有条目被恢复后回调, 让画廊重新拉一次列表 */
  onRestored: () => void;
}) {
  const [data, setData] = useState<TrashResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 正在处理哪个 job_id(恢复/彻底删中的那一条) */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  /** 清空回收站的第二段确认 */
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  useEscape(onClose);

  /**
 * 重新拉列表(恢复/彻底删/清空之后调用)。
 *
 * 刻意**不切 loading**: 那时数据还在, 若切 true 再回来, 整个网格会被
 * "加载中..."替换掉又换回来 —— 闪一下, 而用户刚操作的那张卡的上下文
 * 就消失了。首屏那次不走这里(见下面的 effect)。
 */
  const reload = useCallback(async () => {
    try {
      const d = await fetchTrash();
      setData(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    /**
     * 首屏加载。把 async IIFE 内联在 effect 里, 而不是调 reload() ——
     * reload 的 finally 里有 setLoading, 而 eslint 的 set-state-in-effect
     * 规则会**穿过** useCallback 追踪进去, 报 "Avoid calling setState
     * directly within an effect"。这里首屏不需要重新置 loading(初始已是
     * true), 所以内联一份不含那行调用的版本, 规则就干净了。
     *
     * StrictMode 下这个 effect 会跑两次 → 首屏请求发两次。和画廊首屏
     * 同样的情况, 代价是多一个 GET, 不加防抖反而更简单。
     */
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchTrash();
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 逐条操作后只重拉列表, 不做乐观更新。
   *
   * 回收站规模是人工量级(几十条), 一次请求几十毫秒 —— 比起乐观更新要维护
   * "本地先移除、失败再塞回去"这套来回, 直接重拉更不容易出错。而且恢复
   * 会连带把元数据写回 _album.json, 本地那份临时数据已经不完整了。
   */
  const runOne = useCallback(
    async (jobId: string, kind: "restore" | "purge") => {
      setBusyId(jobId);
      setNote("");
      try {
        if (kind === "restore") {
          await restoreFromTrash(jobId);
          setNote(`已恢复 ${jobId.slice(0, 8)}`);
          onRestored();
        } else {
          await purgeFromTrash(jobId);
          setNote(`已彻底删除 ${jobId.slice(0, 8)}`);
        }
        await reload();
      } catch (e) {
        setError((e as Error).message ?? String(e));
      } finally {
        setBusyId(null);
      }
    },
    [onRestored, reload],
  );

  const handleEmpty = useCallback(async () => {
    setBusyId("__empty__");
    setNote("");
    try {
      const r = await emptyTrash();
      setNote(
        r.failed.length > 0
          ? `已清空 ${r.removed_count} 条, ${r.failed.length} 条被占用未能删除。`
          : `回收站已清空, 共删除 ${r.removed_count} 条。`,
      );
      setConfirmEmpty(false);
      await reload();
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setBusyId(null);
    }
  }, [reload]);

  const items: TrashItem[] = data?.items ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center
                 bg-black/40 p-4"
      onClick={onClose}
      data-trash-overlay=""
    >
      <div
        className="w-full max-w-3xl max-h-[80vh] overflow-y-auto
                   bg-cream rounded-lg border border-pink p-4"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="回收站"
        data-trash-panel=""
      >
        <div className="flex items-center mb-3">
          <div className="font-pixel text-brick">回收站</div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="text-brown/60 hover:text-brick text-xl leading-none"
            aria-label="关闭回收站"
            data-trash-close=""
          >
            ×
          </button>
        </div>

        {/*
          保留期与占用必须常驻可见, 而不是放在某个折叠区里 ——
          这决定了用户"要不要现在清空"。写清楚"N 天后自动删除"同时也是
          防止他误以为删掉的东西永远都在。
        */}
        {data && data.total > 0 && (
          <div className="text-xs text-brown/70 mb-3" data-trash-summary="">
            {data.total} 条 · {formatBytes(data.total_size)} · {data.retention_days} 天后自动删除
            {data.truncated && ` (仅显示最近 ${items.length} 条)`}
          </div>
        )}

        {loading && <div className="text-brown/70 text-sm">加载中...</div>}
        {error && (
          <div className="text-red-500 text-sm mb-2">
            {error}
            <button
              type="button"
              onClick={() => void reload()}
              className="ml-2 underline"
              data-trash-retry=""
            >
              重试
            </button>
          </div>
        )}
        {note && <div className="text-xs text-brown/80 mb-2" data-trash-note="">{note}</div>}

        {!loading && data && data.purged.length > 0 && (
          // 后端每次读回收站都会顺手清掉过期的条目。不告诉用户的话,
          // 他会看到列表凭空少了 N 条而以为是操作出了 bug。
          <div className="text-xs text-brown/60 mb-2" data-trash-purged="">
            {data.purged.length} 条已超过 {data.retention_days} 天保留期, 被自动永久删除。
          </div>
        )}

        {!loading && data && items.length === 0 && !note && (
          <div className="text-brown/60 text-sm py-8 text-center" data-trash-blank="">
            回收站是空的
          </div>
        )}

        <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
          {items.map((it) => (
            <div
              key={it.trash_name}
              className="border border-pink rounded bg-white p-1 relative"
              data-trash-item=""
              data-job-id={it.job_id}
            >
              <div className="aspect-square overflow-hidden bg-cream">
                {it.thumbs[0] ? (
                  <img
                    src={it.thumbs[0]}
                    alt=""
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-xs text-brown/50">
                    无图
                  </div>
                )}
              </div>
              <div className="text-[10px] text-brown/60 mt-1 truncate">{it.job_id.slice(0, 8)}</div>
              <div className="text-[10px] text-brown/50">
                {formatBytes(it.size)} · {daysLeft(it.deleted_at, data?.retention_days ?? 7)} 天后删
              </div>
              <div className="flex gap-1 mt-1">
                <button
                  type="button"
                  onClick={() => void runOne(it.job_id, "restore")}
                  disabled={busyId !== null}
                  data-trash-restore=""
                  className="flex-1 px-1 py-0.5 text-[10px] rounded border border-pink
                             hover:bg-pink/20 disabled:opacity-40"
                >
                  {busyId === it.job_id ? "..." : "恢复"}
                </button>
                <button
                  type="button"
                  onClick={() => void runOne(it.job_id, "purge")}
                  disabled={busyId !== null}
                  data-trash-purge=""
                  className="flex-1 px-1 py-0.5 text-[10px] rounded border border-red-300
                             text-red-500 hover:bg-red-50 disabled:opacity-40"
                >
                  彻底删
                </button>
              </div>
            </div>
          ))}
        </div>

        {data && data.total > 0 && (
          <div className="mt-4 pt-3 border-t border-pink flex items-center gap-2">
            {confirmEmpty ? (
              <>
                <button
                  type="button"
                  onClick={() => void handleEmpty()}
                  disabled={busyId !== null}
                  data-trash-empty-confirm=""
                  className="px-3 py-1.5 rounded-full text-xs bg-red-500 text-white
                             hover:bg-red-600 disabled:opacity-50"
                >
                  {busyId === "__empty__" ? "清空中..." : `确认清空 ${data.total} 条? 不可恢复`}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmEmpty(false)}
                  data-trash-empty-cancel=""
                  className="px-3 py-1.5 rounded-full text-xs border border-pink bg-white text-brown"
                >
                  取消
                </button>
              </>
            ) : (
              // 清空也要两段式: 它是回收站里唯一不可逆的操作。
              <button
                type="button"
                onClick={() => setConfirmEmpty(true)}
                data-trash-empty=""
                className="px-3 py-1.5 rounded-full text-xs text-red-500 border
                           border-red-300 hover:bg-red-50"
              >
                清空回收站
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 剩余保留天数。至少显示 0 —— 后端已经清了过期的, 不该出现负数。 */
function daysLeft(deletedAt: number, retention: number): number {
  const left = retention - (Date.now() / 1000 - deletedAt) / 86400;
  return Math.max(0, Math.ceil(left));
}

/** 字节数转可读。刻意不做"自动换算到 MB/G": 用户要的是"大概多大"这个量级感。 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}