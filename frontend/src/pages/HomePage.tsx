import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useStore } from "../store";
import { LiveCamera, type LiveCameraHandle } from "../components/LiveCamera";
import { CountdownOverlay } from "../components/CountdownOverlay";
import { ShutterFlash } from "../components/ShutterFlash";
import { FilterStrip } from "../components/FilterStrip";
import { FrameStrip } from "../components/FrameStrip";
import { MaskStrip } from "../components/MaskStrip";
import { MaskGallery } from "../components/MaskGallery";
import { getImageMasks, loadMaskManifest } from "../components/masks/maskLibrary";
import { fetchMeta } from "../api";
import type { FilterInfo, FrameInfo } from "../types";

const PHOTO_COUNT = 4;

export function HomePage() {
  const nav = useNavigate();
  const frames = useStore((s) => s.frames);
  const setFrames = useStore((s) => s.setFrames);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const frame = useStore((s) => s.frame);
  const setFrame = useStore((s) => s.setFrame);
  const maskPreview = useStore((s) => s.maskPreview);
  const setMaskPreview = useStore((s) => s.setMaskPreview);
  const showGuides = useStore((s) => s.showGuides);
  const setShowGuides = useStore((s) => s.setShowGuides);
  const setFrameMeta = useStore((s) => s.setFrameMeta);
  const setFilterMeta = useStore((s) => s.setFilterMeta);
  const maskKey = useStore((s) => s.maskKey);
  const setMaskKey = useStore((s) => s.setMaskKey);
  const galleryOpen = useStore((s) => s.maskGalleryOpen);
  const setGalleryOpen = useStore((s) => s.setMaskGalleryOpen);
  const filterMeta = useStore((s) => s.filterMeta);
  const frameMeta = useStore((s) => s.frameMeta);

  const [filters, setFilters] = useState<FilterInfo[]>([]);
  const [frameList, setFrameList] = useState<FrameInfo[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [flash, setFlash] = useState(false);
  // 倒计时触发器:每次自增都会重启 CountdownOverlay 的计时。
  // 不用 show 布尔量 —— 拍完第 1 张后 setShow(true) 的值与当前相同,
  // React 会 bail out 且不重渲染,useEffect([show]) 不重跑,倒计时会
  // 冻结在 1 永不触发 onComplete(表现为"已拍 1/4"卡死)。
  const [snapTick, setSnapTick] = useState(0);
  // 图库里的蒙版数量(不含内置 15 个),用于入口角标。
  // 先把 manifest 拉到内存里,这样点开抽屉是即时的,不用等网络。
  const [galleryCount, setGalleryCount] = useState(0);

  useEffect(() => {
    loadMaskManifest().then(() => setGalleryCount(getImageMasks().length));
  }, []);
  // 摄像头拍照能力。通过 ref 显式取用,而不是去读组件的静态属性。
  const camRef = useRef<LiveCameraHandle>(null);

  useEffect(() => {
    fetchMeta()
      .then((m) => {
        setFilters(m.filters);
        setFrameList(m.frames);
        // 缓存完整参数到 store,snap() 出片时要读 filter.css 与 frame.pad
        setFilterMeta(m.filters);
        setFrameMeta(m.frames);
      })
      .catch(() => {});
  }, [setFilterMeta, setFrameMeta]);

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

  function startCapture() {
    if (capturing) return;
    setCapturing(true);
    setFrames([]);
    setSnapTick((t) => t + 1);
  }

  function doSnap() {
    // ref 在整个挂载周期内稳定,连拍计时器闭包捕获它不会拿到过期引用。
    const url = camRef.current?.snap() ?? null;
    if (!url) {
      // 摄像头还没出帧(videoWidth === 0)。这里必须继续排下一轮倒计时,
      // 否则整个连拍会永久停住 —— 用户只能刷新页面。
      // 最多重试 SNAP_MAX_RETRY 次,避免摄像头始终不可用时无限循环。
      if (frames.length < SNAP_MAX_RETRY) {
        setSnapTick((t) => t + 1);
      } else {
        setCapturing(false);
      }
      return;
    }
    setFlash(true);
    setTimeout(() => setFlash(false), 250);
    const next = [...frames, url];
    setFrames(next);
    if (next.length >= PHOTO_COUNT) {
      setCapturing(false);
      setTimeout(() => nav("/decorate"), 400);
    } else {
      setSnapTick((t) => t + 1);
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
        {/* 摄像头全程保持挂载:连拍期间反复开关会触发 getUserMedia 竞态与设备抢占 */}
        <LiveCamera
          ref={camRef}
          onCapture={() => {}}
          active={true}
          frame={maskPreview ? frameMeta[frame] : undefined}
          filter={maskPreview ? filterMeta[filter] : undefined}
          maskKey={maskKey}
          maskPreview={maskPreview}
          showGuides={showGuides}
        />
        <CountdownOverlay tick={snapTick} onComplete={doSnap} />
        <ShutterFlash show={flash} />
      </div>

      {/* 蒙版开关:默认开启,拍前即可见相框/色调/构图引导 */}
      <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-brown/70">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={maskPreview}
            onChange={(e) => setMaskPreview(e.target.checked)}
            className="w-4 h-4 accent-brick"
          />
          实时蒙版预览
        </label>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showGuides}
            onChange={(e) => setShowGuides(e.target.checked)}
            className="w-4 h-4 accent-brick"
          />
          构图引导线
        </label>
        <span className="text-brown/50">
          {maskPreview ? "所见即所得：拍下即成片" : "已关闭：拍摄原始画面"}
        </span>
      </div>

      <div className="mt-3">
        <div className="text-xs font-pixel text-brick mb-1">蒙版</div>
        <MaskStrip
          selected={maskKey}
          onSelect={setMaskKey}
          galleryCount={galleryCount}
          onOpenGallery={() => setGalleryOpen(true)}
        />
      </div>

      <div className="mt-3">
        <div className="text-xs font-pixel text-brick mb-1">相框</div>
        <FrameStrip
          frames={frameList}
          selected={frame}
          onSelect={(k) => setFrame(k as any)}
        />
      </div>

      <div className="mt-2">
        <div className="text-xs font-pixel text-brick mb-1">滤镜</div>
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

      {/* 蒙版图库抽屉:选中即应用并自动收起,让用户立刻回到取景框确认效果 */}
      {galleryOpen && (
        <MaskGallery
          selected={maskKey}
          onSelect={(k) => {
            setMaskKey(k);
            setGalleryOpen(false);
          }}
          onClose={() => setGalleryOpen(false)}
        />
      )}
    </div>
  );
}

// 摄像头连续取不到帧时的重试上限
const SNAP_MAX_RETRY = PHOTO_COUNT * 3;
