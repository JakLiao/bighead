import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useStore } from "../store";
import { LiveCamera, snapFromCamera } from "../components/LiveCamera";
import { CountdownOverlay } from "../components/CountdownOverlay";
import { ShutterFlash } from "../components/ShutterFlash";
import { FilterStrip } from "../components/FilterStrip";
import { fetchMeta } from "../api";
import type { FilterInfo } from "../types";

const PHOTO_COUNT = 4;
const INTERVAL_MS = 1500;

export function HomePage() {
  const nav = useNavigate();
  const frames = useStore((s) => s.frames);
  const setFrames = useStore((s) => s.setFrames);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);

  const [filters, setFilters] = useState<FilterInfo[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [flash, setFlash] = useState(false);
  const [showCountdown, setShowCountdown] = useState(false);

  useEffect(() => {
    fetchMeta().then((m) => setFilters(m.filters)).catch(() => {});
  }, []);

  // 全局键盘:空格 = 拍照
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && !capturing) {
        e.preventDefault();
        startCapture();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing]);

  async function startCapture() {
    if (capturing) return;
    setCapturing(true);
    setFrames([]);
    setShowCountdown(true);
  }

  function doSnap() {
    const url = snapFromCamera();
    if (!url) return;
    setFlash(true);
    setTimeout(() => setFlash(false), 250);
    const next = [...frames, url];
    setFrames(next);
    if (next.length >= PHOTO_COUNT) {
      // 拍完了
      setShowCountdown(false);
      setCapturing(false);
      setTimeout(() => nav("/decorate"), 400);
    } else {
      setShowCountdown(true); // 下一张重新倒计时
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="font-pixel text-2xl text-brick">大头贴机</h1>
          <p className="text-sm text-brown/70 mt-1">
            连拍 {PHOTO_COUNT} 张 · 按 <kbd className="px-1.5 py-0.5 bg-white border rounded">空格</kbd> 开始
          </p>
        </div>
        <div className="text-sm font-mono-retro text-base text-brown/70">
          已拍 {frames.length} / {PHOTO_COUNT}
        </div>
      </div>

      <div className="relative">
        <LiveCamera onCapture={() => {}} active={!capturing || showCountdown} />
        <CountdownOverlay show={showCountdown} onComplete={doSnap} />
        <ShutterFlash show={flash} />
      </div>

      <div className="mt-4">
        <FilterStrip filters={filters} selected={filter} onSelect={(k) => setFilter(k as any)} />
      </div>

      <div className="mt-6 flex gap-3 justify-center">
        <button
          onClick={startCapture}
          disabled={capturing}
          className="px-8 py-3 bg-brick text-white rounded-full font-pixel text-sm shadow-lg hover:bg-brick/90 disabled:opacity-50"
        >
          {capturing ? "拍摄中..." : "开始连拍"}
        </button>
        {frames.length > 0 && !capturing && (
          <button
            onClick={() => nav("/decorate")}
            className="px-8 py-3 bg-white border-2 border-brick text-brick rounded-full font-pixel text-sm hover:bg-pink/30"
          >
            继续 ({frames.length} 张)
          </button>
        )}
      </div>

      {frames.length > 0 && (
        <div className="mt-6 grid grid-cols-4 gap-3">
          {Array.from({ length: PHOTO_COUNT }).map((_, i) => (
            <div
              key={i}
              className="aspect-[3/4] bg-white rounded-lg border-2 border-pink overflow-hidden"
            >
              {frames[i] && <img src={frames[i]} className="w-full h-full object-cover" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
