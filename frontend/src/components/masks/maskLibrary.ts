/**
 * 蒙版图库 —— 把「内置代码蒙版」与「位图素材蒙版」统一成一张表。
 *
 * 设计要点:
 *   · manifest.json 是位图蒙版的唯一入口(素材规范见 scripts/mask_assets/SPEC.md),
 *     往 public/masks/ 里丢 PNG 并登记 manifest 就能进图库,无需改代码。
 *   · 图片按需加载并缓存。首屏只加载 manifest(几 KB),缩略图用 <img> 让浏览器
 *     自己管加载;只有真正选中某张蒙版时才把它画进 canvas。
 *   · getMask 同时查两张表,所以调用方(maskStrip / LiveCamera / 图库)
 *     不必关心某个 key 来自哪里。
 */
import {
  BUILTIN_SUMMARIES,
  MASKS_BY_KEY,
  type ImageMaskDef,
  type MaskDef,
  type MaskSummary,
} from "./maskDefs";

const MANIFEST_URL = "/masks/manifest.json";

/** manifest 里的一条记录。字段与 SPEC.md 一致。 */
interface ManifestEntry {
  key: string;
  name: string;
  src: string;
  audience: "single" | "dual";
  category: string;
  tags: string[];
  hint?: string;
}

export interface MaskManifest {
  version: number;
  masks: ManifestEntry[];
}

let manifestCache: MaskManifest | null = null;
let inflight: Promise<MaskManifest> | null = null;
let lastError: string | null = null;

/**
 * 拉取 manifest。失败时降级为"只有内置蒙版"——
 * 图库是增强功能,不该因为素材文件缺失就让整个拍照页崩掉。
 *
 * 注意这里 catch 后返回空表而不抛出,所以调用方无法从结果区分
 * "加载失败"与"清单本来就是空的"。因此额外导出 manifestError()。
 */
export async function loadMaskManifest(): Promise<MaskManifest> {
  if (manifestCache) return manifestCache;
  if (inflight) return inflight;

  inflight = (async () => {
    const res = await fetch(MANIFEST_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const data = (await res.json()) as MaskManifest;
    if (!data || !Array.isArray(data.masks)) throw new Error("manifest 结构非法");
    manifestCache = { version: data.version ?? 1, masks: data.masks };
    lastError = null;
    return manifestCache;
  })();

  try {
    return await inflight;
  } catch (e) {
    manifestCache = { version: 1, masks: [] };
    lastError = e instanceof Error ? e.message : String(e);
    return manifestCache;
  } finally {
    inflight = null;
  }
}

/** 最近一次 manifest 加载失败的原因;成功或从未尝试过则为 null。 */
export function manifestError(): string | null {
  return lastError;
}

/** 同步读取已加载的 manifest;未加载时返回空表(供渲染期安全降级)。 */
export function getLoadedManifest(): MaskManifest {
  return manifestCache ?? { version: 1, masks: [] };
}

/** 把 manifest 条目转成 ImageMaskDef。src 补全为绝对地址。 */
function toImageMask(e: ManifestEntry): ImageMaskDef {
  return {
    kind: "image",
    key: e.key,
    name: e.name,
    audience: e.audience,
    src: e.src.startsWith("/") ? e.src : `/masks/${e.src}`,
    category: e.category || "其他",
    tags: Array.isArray(e.tags) ? e.tags : [],
    hint: e.hint,
  };
}

/** 已加载的位图蒙版表。 */
export function getImageMasks(): ImageMaskDef[] {
  return getLoadedManifest().masks.map(toImageMask);
}

/**
 * 统一解析:先查内置,再查图库。
 * 内置优先 —— 同名时以代码蒙版为准,避免素材意外覆盖既有行为。
 */
export function getMask(key: string | null | undefined): MaskDef | undefined {
  if (!key || key === "none") return undefined;
  const builtin = MASKS_BY_KEY[key];
  if (builtin) return builtin;
  return getImageMasks().find((m) => m.key === key);
}

/** 图库混排列表:内置 + 位图,供抽屉直接渲染。 */
export function getAllSummaries(): MaskSummary[] {
  const images: MaskSummary[] = getImageMasks().map((m) => ({
    key: m.key,
    name: m.name,
    audience: m.audience,
    kind: "image",
    category: m.category,
    tags: m.tags,
    hint: m.hint,
  }));
  return [...BUILTIN_SUMMARIES, ...images];
}

/** 图库里的全部分类,按出现次数降序 —— 常用分类排在前面更好点。 */
export function getCategories(list: MaskSummary[]): string[] {
  const count = new Map<string, number>();
  for (const m of list) count.set(m.category, (count.get(m.category) ?? 0) + 1);
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
    .map(([c]) => c);
}

/** 搜索:匹配名称 / 分类 / 标签,大小写与空格不敏感。 */
export function filterMasks(list: MaskSummary[], query: string, category: string): MaskSummary[] {
  const q = query.trim().toLowerCase();
  return list.filter((m) => {
    if (category !== "全部" && m.category !== category) return false;
    if (!q) return true;
    const hay = [m.name, m.category, ...m.tags].join(" ").toLowerCase();
    return q.split(/\s+/).every((token) => hay.includes(token));
  });
}

/**
 * 预加载位图蒙版,返回 HTMLImageElement。
 *
 * 预览与出片都需要同步拿到已解码的图像,所以这里维护一份 Promise 缓存:
 * 同一张图并发调用只会真正加载一次。加载失败返回 null,
 * 调用方据此跳过绘制(而不是抛错中断拍照流程)。
 */
const imageCache = new Map<string, Promise<HTMLImageElement | null>>();

export function loadMaskImage(src: string): Promise<HTMLImageElement | null> {
  const hit = imageCache.get(src);
  if (hit) return hit;

  const p = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => {
      console.warn(`[mask] 素材加载失败:${src}`);
      resolve(null);
    };
    img.src = src;
  });
  imageCache.set(src, p);
  return p;
}
