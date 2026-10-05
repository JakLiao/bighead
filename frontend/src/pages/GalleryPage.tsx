import { useEffect, useState } from "react";
import { fetchGallery, patchAlbum, deleteAlbum } from "../api";
import type { GalleryItem } from "../types";
import { AlbumEditor } from "../components/album/AlbumEditor";

export function GalleryPage() {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const editing = items.find((it) => it.job_id === editingId) ?? null;

  async function reload() {
    setLoading(true);
    try {
      const g = await fetchGallery();
      setItems(g.items);
      setError(null);
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let alive = true;
    reload().then(() => {
      if (!alive) return;
    });
    return () => {
      alive = false;
    };
  }, []);

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

      {loading && <div className="text-brown/70">加载中...</div>}
      {error && <div className="text-red-500 text-sm">加载失败:{error}</div>}
      {!loading && !error && items.length === 0 && (
        <div className="text-brown/70">还没有拍摄记录。</div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {items.map((it) => (
          <button
            key={it.job_id}
            type="button"
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