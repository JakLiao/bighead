import { create } from "zustand";
import type { FilterInfo, FilterKey, FrameInfo, FrameKey, LayoutKey, StyleKey } from "./types";
import type { DoodleStroke, DoodlesByIndex } from "./components/doodles/doodleTypes";

/**
 * 一张连拍照。
 *
 * burnedIn 是**拍照那一刻**的快照: 取景页的 maskPreview 滤镜是否已通过
 * canvas ctx.filter 烧进这张图。它必须逐帧记录, 不能在 DecoratePage 里读
 * 当前的 maskPreview —— 那是取景页一个随时可改的 UI 开关, 用户在拍照后
 * 翻转它会导致状态漂移: 关掉 -> 后端重复调色一次(二次调色);
 * 打开 -> 后端跳过, grain/vignette 静默丢失。
 */
export interface Frame {
  /** dataURL */
  url: string;
  /** 滤镜是否已烧进 url(取景时 maskPreview 为真) */
  burnedIn: boolean;
}

export interface CaptureState {
  frames: Frame[];
  currentJobId: string | null;
  filter: FilterKey;
  style: StyleKey;
  frame: FrameKey;
  layout: LayoutKey;
  aiEnabled: boolean;
  aiImages: string[];
  layoutUrl: string | null;
  // 取景框实时预览需要相框/滤镜的完整参数(css、vignette、pad...).
  // HomePage 拉到 /api/meta 后写进这里, DecoratePage 直接复用, 不再重复请求。
  frameMeta: Record<string, FrameInfo>;
  filterMeta: Record<string, FilterInfo>;
  // 用户是否开启"拍照时实时叠加蒙版"。默认开 —— 这正是本次要交付的体验。
  maskPreview: boolean;
  showGuides: boolean;
  /** 蒙版 key。内置为 heart/star…,图库为 manifest 里登记的 key,"none" = 原图。 */
  maskKey: string;
  /** 蒙版图库抽屉是否展开 */
  maskGalleryOpen: boolean;
  /**
   * 每张照片的手写涂鸦, key 是 frames 数组下标(与 displayImages 同源)。
   *
   * 为什么进 store 而不是 DecoratePage 的局部 state: 涂鸦要活到「点生成拼图」
   * 那一刻, 而编辑入口(缩略图)与烧录出口(doLayout)都在 DecoratePage 内,
   * 局部 state 其实也够。真正的原因是**跨页与重渲染的确定性** —— store 有
   * reset 这个明确的生命周期钩子, 新一轮连拍时能一并清掉; 局部 state 只能
   * 靠 useEffect 手动清理, 漏一次就会出现"上一轮的笔迹烧进这一轮的照片"。
   */
  doodles: DoodlesByIndex;
  setFrames: (f: Frame[]) => void;
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
  setMaskGalleryOpen: (v: boolean) => void;
  /** 覆盖第 idx 张照片的涂鸦(整体替换, 编辑器每落一笔调用一次) */
  setDoodles: (idx: number, strokes: DoodleStroke[]) => void;
  /** 丢掉第 idx 张照片的涂鸦, 回到"没画过" */
  clearDoodle: (idx: number) => void;
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
  maskGalleryOpen: false,
  doodles: {},
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
  setMaskGalleryOpen: (v) => set({ maskGalleryOpen: v }),
  setDoodles: (idx, strokes) => set((s) => ({ doodles: { ...s.doodles, [idx]: strokes } })),
  // 删 key 而不是置空数组: "没画过"与"画了又清空"在成片上等价, 但用
  // 缺 key 表示前者, doLayout 的 `doodles[i]?.length` 一处判断就够。
  clearDoodle: (idx) =>
    set((s) => {
      if (!(idx in s.doodles)) return s;
      const next = { ...s.doodles };
      delete next[idx];
      return { doodles: next };
    }),
  // 开始新一轮连拍时清掉上一轮的成片。DecoratePage 的 layoutUrl 可能是
  // blob: URL, 这里只置空 —— 真正的 revoke 在 DecoratePage 的卸载 effect 里做,
  // 因为那里才知道当前值是不是自己创建的 blob。
  // doodles 必须一起清: 涂鸦按 frames 下标索引, 而 frames 会被整体换掉,
  // 残留的旧下标会被新照片"继承"—— 上一轮写在第 2 张的笔迹会烧到这一轮
  // 的第 2 张上, 用户完全无法解释这个现象。
  reset: () =>
    set({
      frames: [],
      currentJobId: null,
      aiImages: [],
      layoutUrl: null,
      doodles: {},
    }),
}));

// 开发期把 store 挂到 window,便于 Playwright 端到端验证读取成片。
// 生产构建里这段会被 tree-shake 掉(依赖 import.meta.env.DEV)。
if (import.meta.env.DEV) {
  (window as unknown as { __store?: typeof useStore }).__store = useStore;
}
