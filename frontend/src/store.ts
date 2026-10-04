import { create } from "zustand";
import type { FilterInfo, FilterKey, FrameInfo, FrameKey, LayoutKey, StyleKey } from "./types";

export interface CaptureState {
  frames: string[];            // dataURL
  currentJobId: string | null;
  filter: FilterKey;
  style: StyleKey;
  frame: FrameKey;
  layout: LayoutKey;
  aiEnabled: boolean;
  aiImages: string[];
  layoutUrl: string | null;
  // 取景框实时预览需要相框/滤镜的完整参数(css、vignette、pad...).
  // 缓存在 store 里,避免 HomePage 与 DecoratePage 各自重复 fetch /api/meta。
  frameMeta: Record<string, FrameInfo>;
  filterMeta: Record<string, FilterInfo>;
  // 用户是否开启"拍照时实时叠加蒙版"。默认开 —— 这正是本次要交付的体验。
  maskPreview: boolean;
  showGuides: boolean;
  /** 预置蒙版 key(爱心/星星/双圆…)。"none" = 原图。 */
  maskKey: string;
  setFrames: (f: string[]) => void;
  setCurrentJobId: (id: string | null) => void;
  setFilter: (f: FilterKey) => void;
  setStyle: (s: StyleKey) => void;
  setFrame: (f: FrameKey) => void;
  setLayout: (l: LayoutKey) => void;
  setAiEnabled: (v: boolean) => void;
  setAiImages: (imgs: string[]) => void;
  setLayoutUrl: (u: string | null) => void;
  setFrameMeta: (m: FrameInfo[]) => void;
  setFilterMeta: (m: FilterInfo[]) => void;
  setMaskPreview: (v: boolean) => void;
  setShowGuides: (v: boolean) => void;
  setMaskKey: (v: string) => void;
  reset: () => void;
}

function toMap<T extends { key: string }>(arr: T[]): Record<string, T> {
  return Object.fromEntries(arr.map((x) => [x.key, x]));
}

export const useStore = create<CaptureState>((set) => ({
  frames: [],
  currentJobId: null,
  filter: "faded_90s",
  style: "PORTRAIT_HK",
  frame: "korean_pink",
  layout: "2x2",
  aiEnabled: false,
  aiImages: [],
  layoutUrl: null,
  frameMeta: {},
  filterMeta: {},
  maskPreview: true,
  showGuides: true,
  maskKey: "heart",
  setFrames: (f) => set({ frames: f }),
  setCurrentJobId: (id) => set({ currentJobId: id }),
  setFilter: (f) => set({ filter: f }),
  setStyle: (s) => set({ style: s }),
  setFrame: (f) => set({ frame: f }),
  setLayout: (l) => set({ layout: l }),
  setAiEnabled: (v) => set({ aiEnabled: v }),
  setAiImages: (imgs) => set({ aiImages: imgs }),
  setLayoutUrl: (u) => set({ layoutUrl: u }),
  setFrameMeta: (m) => set({ frameMeta: toMap(m) }),
  setFilterMeta: (m) => set({ filterMeta: toMap(m) }),
  setMaskPreview: (v) => set({ maskPreview: v }),
  setShowGuides: (v) => set({ showGuides: v }),
  setMaskKey: (v) => set({ maskKey: v }),
  reset: () =>
    set({
      frames: [],
      currentJobId: null,
      aiImages: [],
      layoutUrl: null,
    }),
}));

// 开发期把 store 挂到 window,便于 Playwright 端到端验证读取成片。
// 生产构建里这段会被 tree-shake 掉(依赖 import.meta.env.DEV)。
if (import.meta.env.DEV) {
  (window as unknown as { __store?: typeof useStore }).__store = useStore;
}
