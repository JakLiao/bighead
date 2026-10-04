import { useEffect, useState } from "react";
import { fetchGallery } from "../api";

export function GalleryPage() {
  const [items, setItems] = useState<{ job_id: string; mtime: number; thumbs: string[] }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // 补 catch: 原来没有错误处理, 后端 500 时 .json() 抛异常,
    // setLoading 永远不会执行 —— 页面卡在「加载中...」且控制台一片红。
    fetchGallery()
      .then((g) => {
        if (!alive) return;
        setItems(g.items);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e.message ?? String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-6 py-6">
      <h1 className="font-pixel text-2xl text-brick mb-4">画廊</h1>
      {loading && <div className="text-brown/70">加载中...</div>}
      {error && <div className="text-red-500 text-sm">加载失败：{error}</div>}
      {!loading && !error && items.length === 0 && (
        <div className="text-brown/70">还没有拍摄记录。</div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {items.map((it) => (
          <div key={it.job_id} className="bg-white rounded-xl border-2 border-pink p-2">
            <div className="text-xs text-brown/60 font-mono-retro mb-1">
              {new Date(it.mtime * 1000).toLocaleString()}
            </div>
            <div className="grid grid-cols-2 gap-1">
              {it.thumbs.slice(0, 4).map((t) => (
                <img
                  key={t}
                  src={t}
                  alt=""
                  // 画廊可能有几十个任务, 缩略图指向的是原图路径。
                  // 不加 lazy 的话首屏会并发拉所有图片, 把带宽和内存一次吃满。
                  loading="lazy"
                  decoding="async"
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
