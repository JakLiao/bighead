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
import { createHarness } from "./verifyHarness.mjs";

/**
 * 夹具接管断言收集与数据清理。
 *
 * 此前本脚本的清理写在末尾的裸语句里(不在 finally), 而前半段有 12 个
 * `page.evaluate` —— 超时是这里最常见的失败, 于是"清理"经常被整个跳过,
 * 一个真实出片 job 就留在 outputs/ 里。而 job_id 是后端生成的 hex, 事后
 * 靠目录名认不出来, 收尾自检也扫不到。现在改由 harness 统一兜底。
 */
const h = await createHarness("verify-decorate-persist");
const check = h.check;

/**
 * 进入前拍快照。
 *
 * 必须在任何造数**之前**拍, 否则新 job 会算进基线, diff 永远为空 ——
 * 那是"自检通过但什么都没查"的典型形态, 比没有自检更危险。
 *
 * 刻意不叫 `before`: 脚本中段已有一个 `before` 用来存 /api/gallery 的
 * 出片前列表(那条断言要对比"本轮新增了几个")。同名会让其中一个静默
 * 被另一个覆盖, 而两处都在用。
 */
const entrySnapshot = await h.snapshot();

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

/**
 * 本轮出片的 job_id。
 *
 * 提到 try 外面是因为 finally 要用它: 清理必须覆盖"已经出片、但后续断言
 * 抛了"的时刻, 而那一刻 jobId 已经有值了。
 */
let jobId = "";

/**
 * 主体全部包在 try 里。
 *
 * 此前清理是末尾的裸语句, 前面任何一个 `page.evaluate` 抛错(超时的概率
 * 相当高, 毕竟这里要等 AI 出图) 都会直接跳到脚本结束, 清理不执行 ——
 * 一个真实 job 留在 outputs/ 里, 而脚本**仍然报 0 失败**。
 * 这不是"偶尔忘了", 是结构上必然会发生。
 */
try {
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
jobId = state.shareUrl.split("/")[2];
/**
 * 立刻登记 + 打上 title 标记。
 *
 * 这一段是根治"hex id 泄漏"的关键: job_id 是后端生成的随机 hex, 目录名里
 * 没有本次运行的任何痕迹, 此前只能靠脚本末尾那行 `permanent=true` 清理。
 * 一旦中途抛错就没有下一次了。现在登记进 harness, 由 finally 无条件兜底。
 *
 * 用 adoptMarked 而不是 adopt: 万一连 harness 的清理也失败了(比如进程被
 * 强杀), title 里留着的 runTag 就是这条数据归属本脚本的唯一证据,
 * 下次跑能用 `?q= <runTag>` 搜出来, 不必人工翻 outputs/ 看哪个 hex 是
 * 测试留下的。`node verify-sweep.mjs --title <runTag>` 同样能定位。
 * 代价只是一次 PATCH, 且后端 permanent delete 会 album.pop 掉这个键,
 * 不会在 _album.json 里留下孤儿。
 */
await h.adoptMarked(jobId);
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
} catch (e) {
  // 断言失败也要算失败, 且不吞异常信息 —— 崩溃若被静默处理,
  // run-all-verify 会把它显示成 (no summary) 而不是失败(它认退出码)。
  check("脚本主体未抛异常", false, String(e && e.message ? e.message : e));
} finally {
  /**
   * 清理 + 泄漏自检。
   *
   * `h.finish()` 做两件事: 走 API 永久删除已登记的 job(源目录若已被搬进
   * 回收站, 还会逐个 purge), 然后拿退出时的快照减去 entrySnapshot 求差集。
   *
   * 后者是新增能力, 也是这个脚本此前最大的缺口: 它的 job_id 是 hex,
   * 旧的"扫前缀"式收尾自检对它完全无感, 于是漏清理从来不会被发现。
   * 差集法只看"本次运行期间 outputs/ 多了什么", 与目录名无关。
   */
  await h.finish(entrySnapshot);
  await browser.close();
  h.report();
}
