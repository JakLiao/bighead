/**
 * 完整 UI 出片落盘链路验证。
 *
 * 为什么要单独一个脚本: verify-share-card.mjs 是**直接打 API** 验证落盘接口,
 * 而 P2 真正的新逻辑在 DecoratePage.doLayout 里 ——
 *   saveCaptures -> makeLayoutToJob -> renderShareCard -> saveShareCard
 * 这条链路上任何一步接错(比如忘了传 job_id、忘了把 layoutUrl 从 blob 换成
 * 服务端路径、分享卡存到了错误的 job), 纯 API 测试都发现不了, 因为它
 * 绕过了整个前端。
 *
 * 而且这三个点是会**静默**出错的:
 *   - 忘传 job_id -> 服务端不落盘(设计如此), UI 上照样出图, 看不出差别
 *   - layoutUrl 仍是 blob: -> 页面上能看, 刷新就消失
 *   - saveShareCard 传错 job_id -> 分享卡落到别的 job 目录, 本轮没有卡
 * 唯一可靠的判据是**去磁盘上核对**。
 */
import { chromium } from "playwright";
import { burstTo } from "./maskBurstHelper.mjs";

const PASS = [];
const FAIL = [];
const check = (n, c, d = "") => {
  (c ? PASS : FAIL).push(n);
  console.log(`  [${c ? "PASS" : "FAIL"}] ${n}${d ? "  " + d : ""}`);
};

const BASE = (process.env.APP_URL || "http://localhost:5173").replace(/\/$/, "");

const browser = await chromium.launch({
  channel: "chrome",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const ctx = await browser.newContext({
  permissions: ["camera"],
  viewport: { width: 1280, height: 1800 },
});
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => {
  pageErrors.push(String(e));
  console.error("[pageerror]", e);
});
page.on("console", (m) => {
  if (m.type() === "error") console.error("[console.error]", m.text());
});

// 记录出片前后 outputs 目录的差异, 用于事后确认本轮到底落盘了什么。
async function outputsSnapshot() {
  return page.evaluate(async () => {
    const r = await fetch("/api/gallery");
    const g = await r.json();
    return g.items.map((x) => x.job_id);
  });
}

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });

// ---- 拍 4 张(AI 关闭, 走普通拼图路径)----
const before = await outputsSnapshot();
await page.waitForSelector("video", { timeout: 30000 });
await page.waitForTimeout(1500);
await page.keyboard.press("Space");
await burstTo(page, 4);
// burstTo 只保证 frames 到 4 张, 不保证页面已跳转 —— 第 4 张后还要等
// HomePage 的导航 effect 跑完。少这一句会把「URL 还是 /home」误报成失败。
await page
  .waitForURL(/\/decorate/, { timeout: 30000 })
  .catch(() => {});
check("连拍 4 张完成并进入出片页", page.url().includes("/decorate"), page.url());

// ---- 点「生成拼图」----
const genBtn = page.getByRole("button", { name: "生成拼图" });
await genBtn.waitFor({ state: "visible", timeout: 20000 });
await genBtn.click();

// 等 shareUrl —— 它是整条链路的**最后一个**产物, 它出现就意味着
// saveCaptures / makeLayoutToJob / renderShareCard / saveShareCard 全跑过了。
await page.waitForFunction(
  () => {
    const u = window.__store?.getState().shareUrl;
    return typeof u === "string" && u.length > 0;
  },
  { timeout: 120000 },
);
check("出片流程走完并生成分享卡", true);

const state = await page.evaluate(() => {
  const s = window.__store.getState();
  return { layoutUrl: s.layoutUrl, shareUrl: s.shareUrl };
});
const jobId = state.shareUrl.split("/")[2];
console.log(`  job_id = ${jobId}`);
check("shareUrl 是服务端路径而非 blob:", !state.shareUrl.startsWith("blob:"));
check("shareUrl 指向该 job 的 share.jpg", state.shareUrl === `/outputs/${jobId}/share.jpg`, state.shareUrl);
check("layoutUrl 是服务端路径而非 blob:", !state.layoutUrl.startsWith("blob:"), state.layoutUrl);
check("layoutUrl 指向该 job 的 layout.jpg", state.layoutUrl === `/outputs/${jobId}/layout.jpg`, state.layoutUrl);

// ---- 核心断言: 去磁盘核对 ----
const onDisk = await page.evaluate(async (jid) => {
  const get = async (name) => {
    const r = await fetch(`/outputs/${jid}/${name}`);
    if (!r.ok) return { status: r.status, len: 0, w: 0, h: 0 };
    const blob = await r.blob();
    let w = 0, h = 0;
    try {
      const bmp = await createImageBitmap(blob);
      w = bmp.width;
      h = bmp.height;
      bmp.close();
    } catch {
      /* 解码失败保持 0 */
    }
    return { status: r.status, len: blob.size, w, h };
  };
  const photos = [];
  for (let i = 1; i <= 4; i++) photos.push(await get(`photo_${i}.jpg`));
  return {
    layout: await get("layout.jpg"),
    share: await get("share.jpg"),
    photos,
  };
}, jobId);

check("layout.jpg 真的落盘了", onDisk.layout.status === 200, `status=${onDisk.layout.status}`);
check("layout.jpg 非空", onDisk.layout.len > 1000, `${onDisk.layout.len}B`);
check("layout.jpg 可解码(是真 JPEG)", onDisk.layout.w > 0, `${onDisk.layout.w}x${onDisk.layout.h}`);
check("share.jpg 真的落盘了", onDisk.share.status === 200, `status=${onDisk.share.status}`);
check("share.jpg 可解码", onDisk.share.w > 0, `${onDisk.share.w}x${onDisk.share.h}`);
check(
  "share.jpg 严格 4:3 = 1200x900",
  onDisk.share.w === 1200 && onDisk.share.h === 900,
  `${onDisk.share.w}x${onDisk.share.h}`,
);

// 4 张单张也要在 —— 它们是贴纸册的兜底缩略图, 也是「本轮确实拍过」的证据。
const photosOk = onDisk.photos.filter((p) => p.status === 200 && p.len > 500).length;
check("4 张 photo_N.jpg 都落盘了", photosOk === 4, `${photosOk}/4`);

// ---- 新 job 出现在贴纸册, 且缩略图优先用 share.jpg ----
const after = await outputsSnapshot();
check("本轮 job 出现在 outputs 里", after.includes(jobId), `新增 ${after.length - before.length} 个`);
const g = await page.evaluate(async () => (await fetch("/api/gallery")).json());
const item = g.items.find((x) => x.job_id === jobId);
check("本轮 job 出现在贴纸册 API 里", !!item);
check("贴纸册缩略图优先用 share.jpg", item?.thumbs?.[0] === `/outputs/${jobId}/share.jpg`, item?.thumbs?.[0]);

// ---- 页面上能看到分享卡并可下载 ----
const card = page.locator("[data-share-card]");
check("页面渲染分享卡区块", (await card.count()) === 1);
const dl = page.locator("[data-share-download]");
check("分享卡有下载入口", (await dl.count()) === 1);
if ((await dl.count()) === 1) {
  const href = await dl.getAttribute("href");
  check("下载链接指向落盘文件", href === state.shareUrl, String(href));
}

// ---- 刷新后依然可见(blob: URL 做不到这一点) ----
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
const layoutAfterReload = await page.evaluate(
  async (u) => (await fetch(u)).status,
  state.layoutUrl,
);
check("刷新后 layout.jpg 依然可访问", layoutAfterReload === 200, `status=${layoutAfterReload}`);

// ---- 贴纸册里能点开这一条并看到元数据可编辑 ----
await page.goto(`${BASE}/gallery`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-job-id]", { timeout: 20000 });
const cardCount = await page.locator(`[data-job-id="${jobId}"]`).count();
check("贴纸册里能看到本轮记录", cardCount === 1, `count=${cardCount}`);

check("无未捕获的页面异常", pageErrors.length === 0, pageErrors.join(" | "));

// ---- 清理 ----
await page.evaluate(async (j) => {
  await fetch(`/api/gallery/${j}?permanent=true`, { method: "DELETE" }).catch(() => {});
}, jobId);
await browser.close();

console.log(`\nResult: ${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length) console.log("FAILED:", FAIL.join(" | "));
process.exit(FAIL.length ? 1 : 0);
