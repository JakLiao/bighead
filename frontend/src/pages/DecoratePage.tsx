import { useEffect, useState } from "react";
import { useStore } from "../store";
import { applyFilter, fetchMeta, makeLayout, saveCaptures, startGeneration, openJobSocket } from "../api";
import type { FilterInfo, FrameInfo, LayoutInfo, StyleInfo } from "../types";

function dataUrlToBlob(url: string): Promise<Blob> {
  return fetch(url).then((r) => r.blob());
}

export function DecoratePage() {
  const frames = useStore((s) => s.frames);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  const frame = useStore((s) => s.frame);
  const setFrame = useStore((s) => s.setFrame);
  const style = useStore((s) => s.style);
  const setStyle = useStore((s) => s.setStyle);
  const aiEnabled = useStore((s) => s.aiEnabled);
  const setAiEnabled = useStore((s) => s.setAiEnabled);
  const aiImages = useStore((s) => s.aiImages);
  const setAiImages = useStore((s) => s.setAiImages);
  const layoutUrl = useStore((s) => s.layoutUrl);
  const setLayoutUrl = useStore((s) => s.setLayoutUrl);
  const setCurrentJobId = useStore((s) => s.setCurrentJobId);
  const currentJobId = useStore((s) => s.currentJobId);

  const [meta, setMeta] = useState<{
    styles: StyleInfo[]; filters: FilterInfo[]; frames: FrameInfo[]; layouts: LayoutInfo[];
  }>({ styles: [], filters: [], frames: [], layouts: [] });

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, msg: "" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMeta().then(setMeta).catch(() => {});
  }, []);

  // WS 监听
  useEffect(() => {
    if (!currentJobId) return;
    const ws = openJobSocket(currentJobId, (msg) => {
      if (msg.status === "running") {
        setProgress({ current: msg.current, total: msg.total, msg: msg.msg ?? "" });
      } else if (msg.status === "done") {
        setProgress({ current: msg.total, total: msg.total, msg: "完成" });
        setAiImages(msg.images ?? []);
        setBusy(false);
      } else if (msg.status === "error") {
        setError(msg.msg ?? "未知错误");
        setBusy(false);
      }
    });
    return () => ws.close();
  }, [currentJobId, setAiImages]);

  if (frames.length === 0) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12 text-center">
        <div className="text-brown/70">还没有拍照片,先去 <a href="/home" className="text-brick underline">拍照</a>。</div>
      </div>
    );
  }

  async function doLayout(useAi: boolean) {
    setError(null);
    setBusy(true);
    try {
      let blobs = await Promise.all(frames.map(dataUrlToBlob));
      // 应用实时滤镜(纯 OpenCV,毫秒级)
      blobs = await Promise.all(blobs.map((b) => applyFilter(b, filter)));

      // AI 写真
      if (useAi) {
        const cap = await saveCaptures(blobs);
        setCurrentJobId(cap.job_id);
        await startGeneration(cap.job_id, style);
        return; // 等待 WS
      }

      // 普通拼图
      const result = await makeLayout(blobs, layout, frame);
      setLayoutUrl(URL.createObjectURL(result));
      setBusy(false);
    } catch (e: any) {
      setError(e.message ?? String(e));
      setBusy(false);
    }
  }

  const displayImages = aiEnabled && aiImages.length > 0 ? aiImages : frames;

  return (
    <div className="max-w-7xl mx-auto px-6 py-6">
      <h1 className="font-pixel text-2xl text-brick mb-4">排版装饰</h1>

      <div className="grid lg:grid-cols-[300px_1fr] gap-6">
        <aside className="space-y-5">
          {/* AI 开关 */}
          <div className="bg-white rounded-2xl border-2 border-pink p-4">
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <div className="font-pixel text-sm text-brick">AI 复古写真</div>
                <div className="text-xs text-brown/60 mt-1">
                  {aiEnabled ? "已启用 · 显存峰值 ≤ 7GB" : "关闭 · 纯本地滤镜拼图"}
                </div>
              </div>
              <input
                type="checkbox"
                checked={aiEnabled}
                onChange={(e) => setAiEnabled(e.target.checked)}
                className="w-6 h-6 accent-brick"
              />
            </label>
            {aiEnabled && (
              <div className="mt-3">
                <div className="text-xs text-brown/70 mb-1">风格</div>
                <select
                  value={style}
                  onChange={(e) => setStyle(e.target.value as any)}
                  className="w-full border border-pink rounded px-2 py-1 text-sm bg-cream"
                >
                  {meta.styles.map((s) => (
                    <option key={s.key} value={s.key}>{s.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* 滤镜 */}
          <div className="bg-white rounded-2xl border-2 border-pink p-4">
            <div className="font-pixel text-sm text-brick mb-2">实时滤镜</div>
            <div className="grid grid-cols-2 gap-2">
              {meta.filters.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key as any)}
                  className={`px-3 py-1.5 rounded-full text-xs border ${
                    filter === f.key
                      ? "bg-brick text-white border-brick"
                      : "bg-cream text-brown border-pink"
                  }`}
                >
                  {f.name}
                </button>
              ))}
            </div>
          </div>

          {/* 排版 */}
          <div className="bg-white rounded-2xl border-2 border-pink p-4">
            <div className="font-pixel text-sm text-brick mb-2">排版</div>
            <select
              value={layout}
              onChange={(e) => setLayout(e.target.value as any)}
              className="w-full border border-pink rounded px-2 py-1 text-sm bg-cream mb-3"
            >
              {meta.layouts.map((l) => (
                <option key={l.key} value={l.key}>{l.name}</option>
              ))}
            </select>
            <div className="font-pixel text-sm text-brick mb-2">相框</div>
            <div className="grid grid-cols-2 gap-2">
              {meta.frames.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFrame(f.key as any)}
                  className={`px-3 py-1.5 rounded-full text-xs border ${
                    frame === f.key
                      ? "bg-brick text-white border-brick"
                      : "bg-cream text-brown border-pink"
                  }`}
                >
                  {f.name}
                </button>
              ))}
            </div>
          </div>

          {/* 生成按钮 */}
          <button
            onClick={() => doLayout(aiEnabled)}
            disabled={busy}
            className="w-full px-6 py-3 bg-brick text-white rounded-full font-pixel text-sm shadow-lg hover:bg-brick/90 disabled:opacity-50"
          >
            {busy
              ? aiEnabled
                ? `AI 生成中 ${progress.current}/${progress.total}`
                : "生成中..."
              : aiEnabled
                ? "开始 AI 生成 + 拼图"
                : "生成拼图"}
          </button>

          {error && (
            <div className="bg-brick/10 border border-brick text-brick text-xs p-2 rounded">
              {error}
            </div>
          )}

          {busy && aiEnabled && progress.total > 0 && (
            <div className="bg-cream rounded-lg p-3 text-xs">
              <div className="h-2 bg-pink rounded-full overflow-hidden">
                <div
                  className="h-full bg-brick transition-all"
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
                />
              </div>
              <div className="mt-1 text-brown/70">{progress.msg}</div>
            </div>
          )}
        </aside>

        <section>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            {displayImages.slice(0, 8).map((src, i) => (
              <div key={i} className="aspect-[3/4] bg-white rounded-lg border-2 border-pink overflow-hidden">
                <img
                  src={src.startsWith("/") ? src : src}
                  className="w-full h-full object-cover"
                />
              </div>
            ))}
          </div>

          {layoutUrl && (
            <div className="bg-white rounded-2xl border-2 border-brick p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="font-pixel text-sm text-brick">最终拼图</div>
                <a
                  href={layoutUrl}
                  download={`bighead_${Date.now()}.jpg`}
                  className="px-4 py-1.5 bg-brick text-white rounded-full text-xs"
                >
                  下载 JPG
                </a>
              </div>
              <img src={layoutUrl} className="w-full rounded-lg" />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
