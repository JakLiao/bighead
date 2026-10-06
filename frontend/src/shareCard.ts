/**
 * 浏览器端分享卡合成。
 *
 * 为什么不调后端渲染: 前端此刻已经持有 collage Blob 与 job_id, 合成一张
 * 1200x900 的卡片是纯本地 canvas 操作; 走服务端意味着把几 MB 的拼图再上传
 * 一次、服务端合成、再下载一次。后端保留同名实现(backend/share_card.py)
 * 只用于「补生成历史卡片」这类没有前端上下文的场景。
 *
 * **几何常量必须与 backend/config.py 的 SHARE_CARD_* 逐值一致** ——
 * 两处独立实现同一个设计, 不一致时只有肉眼能发现差异, 没有任何断言会失败。
 * 改动务必同时改两个文件。
 */
export const SHARE_CARD_W = 1200;
export const SHARE_CARD_H = 900;
const MARGIN = 40;
const FOOTER_H = 220;
const BG = "#fff8f0";
const BRAND = "BigHead 大头贴复古";
const INK_BRAND = "#5a4646";
const INK_META = "#967876";
const INK_LINE = "#d2beb4";
const BRAND_SIZE = 48;
const META_SIZE = 30;
/** 短 job ID 取前 6 位: 卡片上不喧宾夺主, 又够口头指认某一张。 */
export const SHARE_CARD_SHORT_ID = 6;

export function shortJobId(jobId: string): string {
  return jobId.slice(0, SHARE_CARD_SHORT_ID);
}

export async function renderShareCard(
  collage: Blob,
  jobId: string,
): Promise<Blob | null> {
  const bmp = await createImageBitmap(collage);
  // ImageBitmap 是**显式**管理的资源: 不调 close() 不会进 GC 的自动回收
  // 路径, 解码后的像素会一直挂在内存里。一次失败就泄漏一份, 连拍重来
  // 几轮足以让移动端标签页被系统杀掉。try/finally 让"必须归还"成为
  // 语言级保证, 而不是靠每条分支都记得写一遍。
  try {
    const card = document.createElement("canvas");
    card.width = SHARE_CARD_W;
    card.height = SHARE_CARD_H;
    const ctx = card.getContext("2d");
    // getContext 失败不该让用户丢掉整轮照片 —— 但也不能静默: 返回 null
    // 让调用方明确知道「这一轮没有分享卡」, 而不是拿到一个内容其实
    // 是原始拼图的「分享卡」(那种卡看起来完全正常, 只是没有 4:3 卡框
    // 和 footer, 会被当成生成成功)。
    if (!ctx) {
      console.warn("[shareCard] 2d context 不可用, 跳过分享卡");
      return null;
    }

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, SHARE_CARD_W, SHARE_CARD_H);

    // 等比 contain + 居中, 与后端 render_share_card 同策略。
    // 不用 object-fit 那种"铺满"的思路: 排版 strip 是 4:1 长条, 铺满会
    // 把它拉成 4:3 的糊图; 留白正好是米色纸底, 视觉上是拍立得白边。
    const innerW = SHARE_CARD_W - MARGIN * 2;
    const innerH = SHARE_CARD_H - MARGIN * 2 - FOOTER_H;
    const scale = Math.min(innerW / bmp.width, innerH / bmp.height);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    // 居中而非靠左: 留白平均分到两侧, 靠左会让卡片视觉重心偏左。
    ctx.drawImage(bmp, MARGIN + (innerW - w) / 2, MARGIN + (innerH - h) / 2, w, h);

    const lineY = SHARE_CARD_H - FOOTER_H;
    ctx.strokeStyle = INK_LINE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(MARGIN, lineY);
    ctx.lineTo(SHARE_CARD_W - MARGIN, lineY);
    ctx.stroke();

    // 中文必须显式指定中文字体: canvas 的 font 简写里不写 family 时用
    // 无衬线默认字体, 在部分平台上中文字形会退化成方框。
    ctx.fillStyle = INK_BRAND;
    ctx.font = `${BRAND_SIZE}px "Microsoft YaHei", "SimHei", sans-serif`;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText(BRAND, MARGIN, lineY + 44);

    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const meta = `#${shortJobId(jobId)} - ${when}`;
    ctx.fillStyle = INK_META;
    ctx.font = `${META_SIZE}px "Microsoft YaHei", "SimHei", sans-serif`;
    // 右对齐: textAlign=right 让浏览器自己算起点, 不必像后端那样先量
    // textlength 再反推 x。
    ctx.textAlign = "right";
    ctx.fillText(meta, SHARE_CARD_W - MARGIN, lineY + 130);
    ctx.textAlign = "left";

    // toBlob 在 canvas tainted 或尺寸超限时给 null。返回 null 而非回落
    // collage: 回落会得到一张「内容是原始拼图、但文件名叫 share.jpg」的
    // 东西 —— 它看起来正常, 却缺了卡框与 footer, 属于静默的错误产物。
    // 显式 null 让调用方跳过落盘, 界面上不出现分享卡区块。
    return await new Promise<Blob | null>((r) =>
      card.toBlob(r, "image/jpeg", 0.92),
    );
  } finally {
    bmp.close();
  }
}
