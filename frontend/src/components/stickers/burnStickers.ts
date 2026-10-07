/**
 * 把贴纸层烧进照片 —— 排版页与画廊「重新编辑」共用的唯一实现。
 *
 * 为什么要抽出来共享, 而不是各自写一份
 * ------------------------------------
 * 本仓库最核心的不变量是「编辑时看到的贴纸, 必须与成片里烧进去的贴纸是
 * 同一个贴纸」(见 stickerTypes.ts 文件头)。这个不变量一旦有两份烧录实现,
 * 就不再是结构性保证, 而变成"两处参数要人工对齐"的约定 —— 排版页改了
 * JPEG 质量或忘了预加载位图, 画廊的重新编辑就会静默产出另一套结果, 而且
 * 只有对比两张图才看得出来。
 *
 * 层序也是共享的理由之一: **贴纸在下、涂鸦在上、滤镜/年代最后**。
 * 把这个顺序写进一个函数, 就不必在每个调用点靠注释提醒。
 */
import { paintStickers } from "./StickerEditor";
import { getLoadedStickerImages, preloadStickerAssets } from "./stickerLibrary";
import type { StickerPlacement } from "./stickerTypes";

/** 出片 JPEG 质量。与 DecoratePage 烧录涂鸦时用的值一致, 不要单独调。 */
const JPEG_QUALITY = 0.92;

/**
 * 把用户摆的贴纸烧进照片, 返回新 Blob。
 *
 * 复用 paintStickers(与 StickerEditor 同一个渲染器), 保证"摆时看到的那颗"
 * 与"这里烧进去的那颗"一致。
 *
 * 同样隔一层透明 canvas 再贴: 贴纸有 opacity 字段, 直接画在照片上时
 * 半透明贴纸会把照片一起调淡, 等于给整张照片加了层滤镜。隔一层之后
 * 半透明只作用在贴纸自己身上。
 *
 * selected 传 -1: 选中虚线框是编辑器 UI, 绝不能烧进成片。
 *
 * **先 await preloadStickerAssets**: 位图解码是异步的, 而 paintStickers 是
 * 同步的。少这一步, 位图贴纸在成片里会**整批消失**(不是画错, 是不画) ——
 * 而且只在"素材还没被浏览器缓存"的那一次发生, 复现极难。
 *
 * try/finally 释放 ImageBitmap: createImageBitmap 是显式资源, 不 close()
 * 不会自动回收(1280x960x4 ≈ 4.7MB/张), 中间任何一次抛错都会泄漏。
 */
export async function burnStickers(
  photoBlob: Blob,
  stickers: StickerPlacement[],
): Promise<Blob> {
  if (stickers.length === 0) return photoBlob;
  await preloadStickerAssets(stickers);
  const bitmap = await createImageBitmap(photoBlob);
  try {
    const w = bitmap.width;
    const h = bitmap.height;

    const layer = document.createElement("canvas");
    layer.width = w;
    layer.height = h;
    // 传 getLoadedStickerImages() 而非依赖默认参数: 上面刚预加载完,
    // 显式取一次让"烧录读的是刚预热的那份缓存"写在调用点上。
    paintStickers(layer.getContext("2d"), stickers, -1, getLoadedStickerImages());

    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d");
    if (!ctx) return photoBlob;
    ctx.drawImage(bitmap, 0, 0, w, h);
    ctx.drawImage(layer, 0, 0);

    // toBlob 在 canvas tainted 或尺寸超限时给 null, 回落原图而不是抛错 ——
    // 烧录失败不该让用户丢掉整轮照片。
    const burned = await new Promise<Blob | null>((resolve) =>
      out.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
    return burned ?? photoBlob;
  } finally {
    bitmap.close();
  }
}
