/**
 * 分享卡落盘 + 拼图落盘 端到端验证。
 *
 * 覆盖本次 P2 的核心目标 —— 落盘链路（此前完全不存在）：
 *  1. /api/layout/make 带 job_id 时把拼图写进 outputs/{job_id}/layout.jpg
 *  2. /api/layout/make 不带 job_id 时行为不变（回归：AI 兜底路径依赖它）
 *  3. /api/share/save 把 4:3 分享卡写进 outputs/{job_id}/share.jpg
 *  4. 分享卡字节确实是 1200x900 的 JPEG（几何硬约束）
 *  5. gallery 的 thumbs 优先选 share.jpg，删掉后回落到 layout.jpg
 *  6. 非法 job_id / 空文件 / 非图片字节 / 不存在的 job 全部被拒
 *  7. 落盘后刷新页面 URL 依然有效（blob: URL 做不到这一点）
 *
 * 注：本脚本自己造数据、自己清理，不依赖其他脚本的残留。
 */
import { chromium } from "playwright";
import { createHarness } from "./verifyHarness.mjs";

// 刻意不叫 URL: 下面要用 `new URL(...)` 之类, 且遮蔽全局构造器容易出问题。
const PAGE_URL = process.env.APP_URL || "http://localhost:5173/gallery";

/**
 * 夹具接管断言与清理。
 *
 * 本脚本的 job 由 /api/capture/save 生成, 是后端的随机 hex —— 目录名里
 * 没有可识别前缀。此前清理写在 finally 里(这点是对的), 但用的是
 * `page.evaluate` 发 DELETE: 一旦页面已经崩掉/关闭, evaluate 自己先抛,
 * 于是清理失败, 而脚本因为已经报完汇总, 看起来是"通过了"。
 * 改用 node 侧 fetch + harness 登记后, 清理不再依赖页面是否还活着。
 */
const h = await createHarness("verify-share-card");
const check = h.check;
const entrySnapshot = await h.snapshot();

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
  viewport: { width: 1280, height: 1600 },
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", e));

await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });

/**
 * 本脚本亲手造的 job id。**造完立刻登记**, 不等断言通过。
 *
 * 登记是负债登记: capture/save 返回 200 的那一刻, 磁盘上已经多了一个目录。
 * 早先 job 是在 try **之外**造的, 造完到进入 try 之间任何一步抛错
 * (后端 5xx、页面崩)都会让 finally 根本不执行, job 留在 outputs/ 里。
 *
 * 现在登记交给 harness: 它做的多一件事是打上 title 标记, 于是即使清理
 * 也失败, 下次跑仍能用 `?q=` 把这个 hex job 搜出来删掉, 而不必人工翻目录。
 */
async function makeJob() {
  const id = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 400;
    const g = c.getContext("2d");
    g.fillStyle = "#2980b9";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#fff";
    g.font = "64px sans-serif";
    g.fillText("P2", 100, 220);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    const fd = new FormData();
    for (let i = 0; i < 4; i++) fd.append("images", blob, `p${i}.jpg`);
    const r = await fetch("/api/capture/save", { method: "POST", body: fd });
    if (!r.ok) throw new Error(`capture/save ${r.status}`);
    return (await r.json()).job_id;
  });
  // adoptMarked = 打标记 + 登记。两者都在造数点内部完成, 调用方无从漏。
  return h.adoptMarked(id);
}

let jobId;
try {
  jobId = await makeJob();
  check("job 创建成功", !!jobId, jobId);

  // ---- layout/make 带 job_id -> 落盘 ----
  const lay = await page.evaluate(async (jid) => {
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 400;
    const g = c.getContext("2d");
    g.fillStyle = "#27ae60";
    g.fillRect(0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    const fd = new FormData();
    for (let i = 0; i < 4; i++) fd.append("images", blob, `p${i}.jpg`);
    fd.append("layout", "2x2");
    fd.append("frame", "plain_white");
    fd.append("job_id", jid);
    const r = await fetch("/api/layout/make", { method: "POST", body: fd });
    return { status: r.status, len: (await r.arrayBuffer()).byteLength };
  }, jobId);
  check("layout/make 带 job_id 返回 200", lay.status === 200, `got ${lay.status}`);
  check("layout/make 返回了图片字节", lay.len > 1000, `${lay.len}B`);

  const layoutFetch = await page.evaluate(
    async (jid) => {
      const r = await fetch(`/outputs/${jid}/layout.jpg`);
      if (!r.ok) return { status: r.status, len: 0 };
      return { status: r.status, len: (await r.arrayBuffer()).byteLength };
    },
    jobId,
  );
  check("layout.jpg 已落盘且可访问", layoutFetch.status === 200, `got ${layoutFetch.status}`);
  check("layout.jpg 非空", layoutFetch.len > 1000, `${layoutFetch.len}B`);

  // ---- 不带 job_id 仍返回图片（回归）----
  const noJob = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 200;
    c.height = 200;
    const g = c.getContext("2d");
    g.fillStyle = "#c0392b";
    g.fillRect(0, 0, 200, 200);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    const fd = new FormData();
    for (let i = 0; i < 4; i++) fd.append("images", blob, `p${i}.jpg`);
    fd.append("layout", "2x2");
    fd.append("frame", "none");
    const r = await fetch("/api/layout/make", { method: "POST", body: fd });
    return { status: r.status, len: (await r.arrayBuffer()).byteLength };
  });
  check("layout/make 不带 job_id 仍返回 200", noJob.status === 200, `got ${noJob.status}`);
  check("layout/make 不带 job_id 仍返回图片", noJob.len > 500, `${noJob.len}B`);

  // ---- share/save ----
  const sh = await page.evaluate(async (jid) => {
    const c = document.createElement("canvas");
    // 直接在浏览器里按 4:3 造一张卡，模拟 shareCard.ts 的产物
    c.width = 1200;
    c.height = 900;
    const g = c.getContext("2d");
    g.fillStyle = "#fff8f0";
    g.fillRect(0, 0, 1200, 900);
    g.fillStyle = "#5a4646";
    g.font = '48px "Microsoft YaHei", sans-serif';
    g.textBaseline = "top";
    g.fillText("BigHead 大头贴复古", 40, 740);
    g.font = '30px "Microsoft YaHei", sans-serif';
    g.textAlign = "right";
    g.fillText("#" + jid.slice(0, 6) + " - 2026-10-05", 1160, 830);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.92));
    const fd = new FormData();
    fd.append("job_id", jid);
    fd.append("layout", blob, "share.jpg");
    const r = await fetch("/api/share/save", { method: "POST", body: fd });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, jobId);
  check("share/save 返回 200", sh.status === 200, JSON.stringify(sh.body));
  check("share_url 指向 share.jpg", sh.body?.share_url === `/outputs/${jobId}/share.jpg`, sh.body?.share_url);

  const shFetch = await page.evaluate(async (jid) => {
    const r = await fetch(`/outputs/${jid}/share.jpg`);
    if (!r.ok) return { status: r.status, w: 0, h: 0 };
    const bmp = await createImageBitmap(await r.blob());
    const d = { status: r.status, w: bmp.width, h: bmp.height };
    bmp.close();
    return d;
  }, jobId);
  check("share.jpg 可访问", shFetch.status === 200, `got ${shFetch.status}`);
  check("分享卡落盘后仍是 1200x900（几何硬约束）",
    shFetch.w === 1200 && shFetch.h === 900, `${shFetch.w}x${shFetch.h}`);

  // ---- gallery 优先选 share.jpg ----
  const g1 = await page.evaluate(async () => (await fetch("/api/gallery")).json());
  const item = g1.items.find((x) => x.job_id === jobId);
  check("新 job 出现在 gallery", !!item);
  check("thumbs 优先指向 share.jpg", item?.thumbs?.[0] === `/outputs/${jobId}/share.jpg`, item?.thumbs?.[0]);
  check("有 share 时 thumbs 只返回 1 张", item?.thumbs?.length === 1, `${item?.thumbs?.length}`);

  // ---- 删掉 share.jpg 后回落到 layout.jpg ----
  // 静态挂载不支持 DELETE，用文件系统等价手段：直接验证 _pick_thumb 的顺序
  // 不变式 —— 改 job 目录内容需要后端配合，这里改为确认 layout.jpg 本身可访问，
  // 回落逻辑由 backend/scripts/verify_share_card.py 的 _pick_thumb 三级断言覆盖。
  const stillThere = await page.evaluate(async (jid) => {
    const r = await fetch(`/outputs/${jid}/layout.jpg`);
    return r.status;
  }, jobId);
  check("share 与 layout 同时存在（回落的前置条件）", stillThere === 200, `got ${stillThere}`);

  // ---- 拒绝非法输入 ----
  const bad = await page.evaluate(async (jid) => {
    const c = document.createElement("canvas");
    c.width = 10;
    c.height = 10;
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    const out = {};

    const mk = async (jobIdVal, body, name) => {
      const fd = new FormData();
      fd.append("job_id", jobIdVal);
      fd.append("layout", body, "s.jpg");
      const r = await fetch("/api/share/save", { method: "POST", body: fd });
      out[name] = r.status;
    };
    await mk("../etc", blob, "traversal");
    await mk("nonexistent_job_xyz", blob, "missing");
    await mk(jid, new Blob([]), "empty");
    await mk(jid, new Blob(["definitely not an image"]), "notimage");
    return out;
  }, jobId);
  check("路径穿越 job_id 被拒", bad.traversal === 400 || bad.traversal === 422, `got ${bad.traversal}`);
  check("不存在的 job 返回 404", bad.missing === 404, `got ${bad.missing}`);
  check("空文件被拒", bad.empty === 400, `got ${bad.empty}`);
  check("非图片字节被拒", bad.notimage === 400, `got ${bad.notimage}`);

  // ---- 落盘 URL 刷新后依然有效 ----
  // 这是本次改动的核心价值：此前 blob: URL 刷新即失效。
  const before = await page.evaluate(
    async (jid) => (await fetch(`/outputs/${jid}/share.jpg`)).status,
    jobId,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  const after = await page.evaluate(
    async (jid) => (await fetch(`/outputs/${jid}/share.jpg`)).status,
    jobId,
  );
  check("刷新页面后 share.jpg 依然可访问（不是 blob: URL）",
    before === 200 && after === 200, `before=${before} after=${after}`);
} catch (e) {
  // 不静默: 异常若被吞掉, run-all-verify 只能看到"少了断言", 定位成本很高。
  check("脚本主体未抛异常", false, String(e && e.message ? e.message : e));
} finally {
  /**
   * 清理 + 泄漏自检。
   *
   * 换用 harness 的三个理由, 每一个都对应旧实现的一个真实缺陷:
   *
   * 1. 旧清理走 `page.evaluate` 发 DELETE。页面若已崩/已关, evaluate 自己
   *    先抛, 整段被 `.catch(() => {})` 吞掉 —— 清理静默失败, 而汇总早已
   *    打印完毕, 看起来是"通过了"。harness 走 node 侧 fetch, 不依赖页面。
   *
   * 2. 旧的收尾自检在 `browser.close()` **之后**用 `page.evaluate` 探测。
   *    此时页面已关, fetch 失败被 `.catch(() => null)` 吞掉, inGallery 与
   *    inTrash 都是 null, 于是 `left` 必然为空数组, **这条断言恒真通过** ——
   *    它看起来在防泄漏, 实际上什么都防不了。harness 的快照 diff 在
   *    node 侧直接读磁盘, 不受页面状态影响。
   *
   * 3. 旧的比对范围只有"自己登记过的 id"。漏登记的那些天然不在比对集合里,
   *    而它们正是残留的来源。diff 法看的是"本轮期间 outputs/ 多了什么",
   *    登记与否都逃不掉。
   */
  await h.finish(entrySnapshot);
  await browser.close();
  h.report();
}
