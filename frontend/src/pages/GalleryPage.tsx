import { useCallback, useEffect, useState } from "react";
import { fetchGallery, patchAlbum, deleteAlbum } from "../api";
import type { GalleryItem, TagCount } from "../types";
import { AlbumEditor } from "../components/album/AlbumEditor";

export function GalleryPage() {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // 筛选条件。**由后端过滤**(见 backend/routes/gallery.py 的 gallery()),
  // 前端只负责把输入传下去 —— 这样 ?q=xx 是一个可复现的链接, 而不是
  // 只在这一次的内存里生效的临时状态。
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [tags, setTags] = useState<TagCount[]>([]);

  const editing = items.find((it) => it.job_id === editingId) ?? null;

  // q / tag 变了就重新拉。取消守卫防的是「快速连续输入时, 早先发出的请求
  // 后到达, 把后发的结果覆盖掉」—— 这不是理论问题, 本机几十条数据时
  // 两个请求的间隔可能只有几毫秒。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const g = await fetchGallery(q, tag);
        if (cancelled) return;
        setItems(g.items);
        setTags(g.tags ?? []);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [q, tag]);

  // 编辑/删除后按**当前筛选条件**重拉, 而不是无条件全量 —— 否则在筛选状态下
  // 保存一条, 列表会突然变回全量, 用户刚找到的那条记录"消失"了。
  const reload = useCallback(async () => {
    try {
      const g = await fetchGallery(q, tag);
      setItems(g.items);
      setTags(g.tags ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message ?? String(e));
    }
  }, [q, tag]);

  async function handleSave(jobId: string, patch: Partial<GalleryItem>) {
    // 把 GalleryItem 上的额外字段(title/note/tags/favorite)提取出来
    const { title, note, tags, favorite } = patch;
    await patchAlbum(jobId, { title, note, tags, favorite });
    await reload();
  }

  async function handleDelete(jobId: string) {
    await deleteAlbum(jobId);
    await reload();
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="font-pixel text-2xl text-brick">贴纸册</h1>
        <div className="text-xs text-brown/60">
          {items.length} 条 · 收藏置顶
        </div>
      </div>

      {loading && items.length === 0 && <div className="text-brown/70">加载中...</div>}
      {error && <div className="text-red-500 text-sm">加载失败:{error}</div>}
      {!loading && !error && items.length === 0 && (
        <div className="text-brown/70">
          {q || tag ? "没有匹配的记录。" : "还没有拍摄记录。"}
        </div>
      )}

      <div className="mb-4 flex flex-col gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索标题 / 备注 / 标签 / 编号"
          data-gallery-search=""
          aria-label="搜索贴纸册"
          className="px-3 py-2 rounded-full border border-pink bg-white text-sm w-full max-w-md"
        />
        {/*
          筛选条只在有标签时出现。空状态给一块空白横条毫无信息量, 且会让
          "搜索框下面空着一块" 看起来像加载失败。
        */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5" data-gallery-tags="">
            <button
              type="button"
              onClick={() => setTag("")}
              aria-pressed={tag === ""}
              data-gallery-tag=""
              className={`px-2.5 py-0.5 rounded-full text-xs border ${
                tag === "" ? "bg-brick text-white border-brick"
                           : "bg-cream text-brown border-pink"
              }`}
            >
              全部
            </button>
            {tags.map((t) => (
              <button
                key={t.tag}
                type="button"
                data-gallery-tag={t.tag}
                onClick={() => setTag(t.tag === tag ? "" : t.tag)}
                aria-pressed={tag === t.tag}
                className={`px-2.5 py-0.5 rounded-full text-xs border ${
                  tag === t.tag ? "bg-brick text-white border-brick"
                                : "bg-cream text-brown border-pink"
                }`}
              >
                {t.tag} {t.count}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {items.map((it) => (
          <button
            key={it.job_id}
            type="button"
            data-job-id={it.job_id}
            onClick={() => setEditingId(it.job_id)}
            className="relative bg-white rounded-xl border-2 border-pink p-2 text-left
                       hover:border-brick transition-colors group"
          >
            {/* 收藏徽标:固定左上, 与编辑按钮不重叠 */}
            {it.favorite && (
              <span className="absolute top-1 left-1 z-10 bg-brick text-white text-[10px] px-1.5 py-0.5 rounded-full">
                ★
              </span>
            )}
            <div className="text-xs text-brown/60 font-mono-retro mb-1 truncate">
              {it.title || new Date(it.mtime * 1000).toLocaleString()}
            </div>
            {it.title && (
              <div className="text-xs text-brown/50 font-mono-retro mb-1">
                {new Date(it.mtime * 1000).toLocaleDateString()}
              </div>
            )}
            <div className="grid grid-cols-2 gap-1">
              {it.thumbs.slice(0, 4).map((t) => (
                <img
                  key={t}
                  src={t}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="aspect-square object-cover rounded border border-pink/40"
                />
              ))}
            </div>
            {it.tags.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {it.tags.slice(0, 3).map((t) => (
                  <span
                    key={t}
                    className="bg-pink/30 text-brown text-[10px] px-1.5 py-0.5 rounded-full"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
            <div className="absolute inset-0 rounded-xl bg-brick/0 group-hover:bg-brick/5 transition-colors" />
          </button>
        ))}
      </div>

      {editing && (
        <AlbumEditor
          jobId={editing.job_id}
          initial={{
            title: editing.title,
            note: editing.note,
            tags: editing.tags,
            favorite: editing.favorite,
            updated_at: editing.updated_at,
          }}
          onSave={(patch) => handleSave(editing.job_id, patch)}
          onDelete={() => handleDelete(editing.job_id)}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}