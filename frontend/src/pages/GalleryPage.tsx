import { useEffect, useState } from "react";
import { fetchGallery } from "../api";

export function GalleryPage() {
  const [items, setItems] = useState<{ job_id: string; mtime: number; thumbs: string[] }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchGallery().then((g) => {
      setItems(g.items);
      setLoading(false);
    });
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-6 py-6">
      <h1 className="font-pixel text-2xl text-brick mb-4">画廊</h1>
      {loading && <div className="text-brown/70">加载中...</div>}
      {!loading && items.length === 0 && (
        <div className="text-brown/70">还没有拍摄记录。</div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {items.map((it) => (
          <div key={it.job_id} className="bg-white rounded-xl border-2 border-pink p-2">
            <div className="text-xs text-brown/60 font-mono-retro mb-1">
              {new Date(it.mtime * 1000).toLocaleString()}
            </div>
            <div className="grid grid-cols-2 gap-1">
              {it.thumbs.slice(0, 4).map((t, i) => (
                <img
                  key={i}
                  src={t}
                  className="aspect-square object-cover rounded border border-pink/40"
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
