/**
 * 位图贴纸图库 —— manifest 加载 + 图片解码缓存。
 *
 * 与 masks/maskLibrary.ts 同构(素材规范见 scripts/sticker_assets/build_stickers.py
 * 生成的 manifest): manifest 是唯一登记入口, 往 public/stickers/ 里丢 PNG 并
 * 登记 manifest 就能上架新贴纸, **不需要改渲染管线**。
 *
 * 为什么必须有这一层, 而不是直接 new Image().src = ...
 * ------------------------------------------------------
 * paintStickers 是**同步**函数(编辑器每帧重画 + 烧录一次成片都靠它), 而
 * 图片解码是异步的。若在渲染里现 new Image, 首次绘制时 complete=false,
 * drawImage 会抛 InvalidStateError 或静默不画 —— 表现为"贴纸点下去有了、
 * 却看不见", 而且只在**第一次**出现, 之后图片被浏览器缓存好了又"自己好了"。
 * 这种首帧缺失的 bug 极难复现和定位。
 *
 * 所以约定: **先 await 预加载, 再画**。编辑器在挂载时预加载 manifest 里
 * 全部素材; 烧录前用 preloadStickerAssets() 等到位图解码完成再进
 * paintStickers。两边共用同一份 HTMLImageElement, 于是"预览看到的位置
 * 与颜色"和"烧进成片的"逐像素一致。
 */
import { isAssetSticker, type StickerPlacement } from "./stickerTypes";

const MANIFEST_URL = "/stickers/manifest.json";

/** manifest 里的一条记录。字段由 build_stickers.py 的 Spec 决定。 */
interface ManifestEntry {
  key: string;
  name: string;
  src: string;
  category: string;
  tags: string[];
}

export interface StickerAsset {
  key: string;
  name: string;
  /** 绝对地址。运行时补全资源根路径, 与 maskLibrary 一致。 */
  src: string;
  category: string;
  tags: string[];
}

export interface StickerManifest {
  version: number;
  stickers: StickerAsset[];
}

/** key -> 素材。渲染时按 key 查 src, manifest 是唯一事实来源。 */
let byKeyCache: Map<string, StickerAsset> | null = null;
let manifestCache: StickerManifest | null = null;
let inflight: Promise<StickerManifest> | null = null;
let lastError: string | null = null;

/** 未加载时的降级空表。用模块级常量保证引用稳定。 */
const EMPTY_MANIFEST: StickerManifest = { version: 1, stickers: [] };

function toAsset(e: ManifestEntry): StickerAsset {
  return {
    key: e.key,
    name: e.name,
    src: e.src.startsWith("/") ? e.src : `/stickers/${e.src}`,
    category: e.category || "其他",
    tags: Array.isArray(e.tags) ? e.tags : [],
  };
}

/**
 * 拉取 manifest。失败时降级为空表 —— 贴纸是增强功能, 不该因为素材缺失
 * 让整个排版页崩掉(现有的 7 个代码形状照常可用)。
 *
 * catch 后返回空表, 所以调用方无法从返回值区分"加载失败"与"清单本来就是空的",
 * 因此额外导出 stickerManifestError()。
 */
export async function loadStickerManifest(): Promise<StickerManifest> {
  if (manifestCache) return manifestCache;
  if (inflight) return inflight;

  inflight = (async () => {
    const res = await fetch(MANIFEST_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const data = (await res.json()) as StickerManifest;
    if (!data || !Array.isArray(data.stickers)) throw new Error("manifest 结构非法");
    manifestCache = { version: data.version ?? 1, stickers: data.stickers.map(toAsset) };
    byKeyCache = new Map(manifestCache.stickers.map((s) => [s.key, s]));
    lastError = null;
    return manifestCache;
  })();

  try {
    return await inflight;
  } catch (e) {
    manifestCache = EMPTY_MANIFEST;
    byKeyCache = new Map();
    lastError = e instanceof Error ? e.message : String(e);
    return manifestCache;
  } finally {
    inflight = null;
  }
}

/** 最近一次 manifest 加载失败的原因;成功或从未尝试过则为 null。 */
export function stickerManifestError(): string | null {
  return lastError;
}

/** 同步读取已加载的 manifest;未加载时返回空表(供渲染期安全降级)。 */
export function getLoadedStickerManifest(): StickerManifest {
  return manifestCache ?? EMPTY_MANIFEST;
}

/** 已加载的素材列表。引用稳定 —— 放进 useEffect 依赖时不会因每次重建而重跑。 */
export function getStickerAssets(): StickerAsset[] {
  return getLoadedStickerManifest().stickers;
}

/** 按 key 查素材。渲染时用;未加载或 key 不存在返回 undefined。 */
export function getStickerAsset(key: string | undefined | null): StickerAsset | undefined {
  if (!key) return undefined;
  if (!byKeyCache) byKeyCache = new Map(getStickerAssets().map((s) => [s.key, s]));
  return byKeyCache.get(key);
}

/**
 * 已解码图片缓存: key -> HTMLImageElement。
 *
 * 只放**已成功解码**的图。加载中的 Promise 不入表 —— 渲染期是同步的,
 * 拿到一个 pending 的 Promise 毫无用处, 还容易让调用方误以为"已就绪"。
 */
const MAX_IMAGE_CACHE = 40;
const imageCache = new Map<string, HTMLImageElement>();
/** key -> 正在进行的加载。合并并发请求, 避免同图解码多次。 */
const pending = new Map<string, Promise<HTMLImageElement | null>>();

/** 供 paintStickers 同步读取。渲染期只认这张表, 不碰 pending。 */
export function getLoadedStickerImages(): ReadonlyMap<string, HTMLImageElement> {
  return imageCache;
}

/**
 * 加载并解码一张位图贴纸, 返回已就绪的 HTMLImageElement(失败为 null)。
 *
 * 缓存的是**已解码的位图**(宽×高×4 字节常驻), 逐个浏览素材会无上限增长,
 * 所以按 LRU 淘汰: Map 的插入顺序即访问顺序, 超限时删最早的。
 */
export function loadStickerImage(key: string): Promise<HTMLImageElement | null> {
  const hit = imageCache.get(key);
  if (hit) {
    // 命中时重新插入, 把它挪到队尾(= 最近使用)。
    imageCache.delete(key);
    imageCache.set(key, hit);
    return Promise.resolve(hit);
  }
  const inflightImg = pending.get(key);
  if (inflightImg) return inflightImg;

  const p = (async () => {
    const asset = getStickerAsset(key);
    if (!asset) {
      console.warn(`[sticker] 未知素材 key:${key}`);
      return null;
    }
    const img = new Image();
    img.decoding = "async";
    const ok = await new Promise<boolean>((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = asset.src;
    });
    if (!ok) {
      console.warn(`[sticker] 素材加载失败:${asset.src}`);
      return null;
    }
    // decode() 让首帧绘制不再等解码。失败不致命: complete 已经是 true,
    // drawImage 会走同步解码路径。
    try {
      await img.decode();
    } catch {
      /* 忽略: 部分浏览器对已加载的图再 decode() 会抛, 不影响绘制 */
    }
    imageCache.set(key, img);
    while (imageCache.size > MAX_IMAGE_CACHE) {
      const oldest = imageCache.keys().next().value;
      if (oldest === undefined) break;
      imageCache.delete(oldest);
    }
    return img;
  })().finally(() => {
    pending.delete(key);
  });

  pending.set(key, p);
  return p;
}

/** 一批素材的 key(去重)。只取位图贴纸, 代码形状没有素材。 */
export function collectAssetKeys(stickers: StickerPlacement[]): string[] {
  const keys = new Set<string>();
  for (const s of stickers) {
    if (isAssetSticker(s)) keys.add(s.asset);
  }
  return [...keys];
}

/**
 * 预加载一批贴纸用到的全部位图素材, 返回**已就绪**的 key 集合。
 *
 * 渲染前必须 await 它。失败/未知的 key 不会出现在返回值里, paintStickers
 * 遇到没有对应图片的位图贴纸会跳过绘制(而不是抛错中断整层)—— 与对待
 * 未知 shape key 的处理一致。
 */
export async function preloadStickerAssets(
  stickers: StickerPlacement[],
): Promise<Set<string>> {
  const keys = collectAssetKeys(stickers);
  if (keys.length === 0) return new Set();
  // manifest 未必已加载(例如直接从画廊进入的重新编辑页)。
  await loadStickerManifest();
  const results = await Promise.all(keys.map((k) => loadStickerImage(k)));
  const ready = new Set<string>();
  keys.forEach((k, i) => {
    if (results[i]) ready.add(k);
  });
  return ready;
}

/** 预加载 manifest 里的**全部**素材。编辑器挂载时调, 让工具条缩略图可用。 */
export async function preloadAllStickerAssets(): Promise<void> {
  const m = await loadStickerManifest();
  await Promise.all(m.stickers.map((s) => loadStickerImage(s.key)));
}
