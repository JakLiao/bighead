import { create } from "zustand";
import type { FilterInfo, FilterKey, FrameInfo, FrameKey, LayoutKey, StyleKey } from "./types";
import type { DoodleStroke, DoodlesByIndex } from "./components/doodles/doodleTypes";
import type {
  StickerPlacement,
  StickersByIndex,
} from "./components/stickers/stickerTypes";

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
  /**
   * 分享卡的**服务端** URL(/outputs/{job_id}/share.jpg), 非 blob。
   *
   * 刻意与 layoutUrl 分开存而不是复用: layoutUrl 在非 AI 路径下曾长期是
   * blob: URL(刷新即失效), 分享卡则一定是落盘后的服务端路径。混在一处
   * 会让「这个 URL 刷新后还在吗」变成一个每次都要重新判断的问题。
   */
  shareUrl: string | null;
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
  /** pose 浮层是否可见。默认开, 是 UI 偏好, reset 不清。 */
  showPose: boolean;
  setShowPose: (v: boolean) => void;
  /**
   * 每张照片**额外**摆放的贴纸, key 是 frames 数组下标。
   *
   * 与 doodles 同样的理由进 store(见上条注释): 下标会随 frames 整体换掉,
   * 残留的旧下标会被新照片"继承"。reset 必须一并清 —— 见 reset 的注释。
   *
   * 与蒙版贴纸的分工: 蒙版(maskDefs.stickers)里的贴纸是取景期硬编码的装饰,
   * 已在拍照时烧进照片(burnedIn); 这里是用户在排版页自己摆的, 走
   * DecoratePage.burnStickers 单独烧一层。
   */
  stickerOverrides: StickersByIndex;
  setFrames: (f: Frame[]) => void;
  setCurrentJobId: (id: string | null) => void;
  setFilter: (f: FilterKey) => void;
  setStyle: (s: StyleKey) => void;
  setFrame: (f: FrameKey) => void;
  setLayout: (l: LayoutKey) => void;
  setAiEnabled: (v: boolean) => void;
  setAiImages: (imgs: string[]) => void;
  setLayoutUrl: (u: string | null) => void;
  setShareUrl: (u: string | null) => void;
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
  /** 覆盖第 idx 张照片的贴纸(整体替换, 编辑器每次改动调用一次) */
  setStickerOverrides: (idx: number, list: StickerPlacement[]) => void;
  /** 丢掉第 idx 张照片的贴纸, 回到"没摆过" */
  clearStickerOverrides: (idx: number) => void;
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
  shareUrl: null,
  frameMeta: {},
  filterMeta: {},
  maskPreview: true,
  showGuides: true,
  showPose: true,
  maskKey: "heart",
  maskGalleryOpen: false,
  doodles: {},
  stickerOverrides: {},
  setFrames: (f) => set({ frames: f }),
  setCurrentJobId: (id) => set({ currentJobId: id }),
  setFilter: (f) => set({ filter: f }),
  setStyle: (s) => set({ style: s }),
  setFrame: (f) => set({ frame: f }),
  setLayout: (l) => set({ layout: l }),
  setAiEnabled: (v) => set({ aiEnabled: v }),
  setAiImages: (imgs) => set({ aiImages: imgs }),
  setLayoutUrl: (u) => set({ layoutUrl: u }),
  setShareUrl: (u) => set({ shareUrl: u }),
  setFrameMeta: (m) => set({ frameMeta: toMap(m) }),
  setFilterMeta: (m) => set({ filterMeta: toMap(m) }),
  setMaskPreview: (v) => set({ maskPreview: v }),
  setShowGuides: (v) => set({ showGuides: v }),
  setShowPose: (v) => set({ showPose: v }),
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
  setStickerOverrides: (idx, list) =>
    set((s) => ({ stickerOverrides: { ...s.stickerOverrides, [idx]: list } })),
  // 与 clearDoodle 同理删 key: "没摆过"用缺 key 表示, doLayout 侧
  // `stickerOverrides[i]?.length` 一处判断就够, 不用额外维护空数组。
  clearStickerOverrides: (idx) =>
    set((s) => {
      if (!(idx in s.stickerOverrides)) return s;
      const next = { ...s.stickerOverrides };
      delete next[idx];
      return { stickerOverrides: next };
    }),
  // 开始新一轮连拍时清掉上一轮的成片。DecoratePage 的 layoutUrl 可能是
  // blob: URL, 这里只置空 —— 真正的 revoke 在 DecoratePage 的卸载 effect 里做,
  // 因为那里才知道当前值是不是自己创建的 blob。
  // doodles 必须一起清: 涂鸦按 frames 下标索引, 而 frames 会被整体换掉,
  // 上一轮写在第 2 张的笔迹会烧到这一轮
  // 的第 2 张上, 用户完全无法解释这个现象。
  // stickerOverrides 同理, 且**必须**一起清: 贴纸同样按 frames 下标索引。
  // 只清 doodles 不清贴纸, 会出现更隐蔽的症状 —— 新一轮照片上凭空多出
  // 上一轮摆的贴纸, 而用户在新一轮里一个贴纸都没摆过。
  reset: () =>
    set({
      frames: [],
      currentJobId: null,
      aiImages: [],
      layoutUrl: null,
      shareUrl: null,
      doodles: {},
      stickerOverrides: {},
    }),
}));

// 开发期把 store 挂到 window,便于 Playwright 端到端验证读取成片。
// 生产构建里这段会被 tree-shake 掉(依赖 import.meta.env.DEV)。
if (import.meta.env.DEV) {
  (window as unknown as { __store?: typeof useStore }).__store = useStore;
}
