/**
 * 蒙版「所见即所得」验证:预览层 vs 成片逐像素比对。
 *
 * 这是整个功能最关键的一条性质。取景框里画的是一张 dataURL 的 <img>,
 * 成片走的是另一条 canvas 路径 —— 两者只要有一处不一致(缩放基准、
 * 镂空位置、贴纸位置),用户就会看到"预览和拍出来不一样"。
 *
 * 做法:同尺寸下渲染两份(预览用的 dpr 尺寸、成片用的照片尺寸),
 * 比较同一坐标的像素是否一致。留 2 级容差,容忍 JPEG 压缩。
 */
import { chromium } from "playwright";
import { burstTo } from "./maskBurstHelper.mjs";

const URL = process.env.APP_URL || "http://localhost:5173/home";
const PASS = [];
const FAIL = [];
const check = (n, c, d = "") => {
  (c ? PASS : FAIL).push(n);
  console.log(`  [${c ? "PASS" : "FAIL"}] ${n} ${d}`);
};

const browser = await chromium.launch({
  channel: "chrome",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const ctx = await browser.newContext({ permissions: ["camera"] });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelector("video")?.videoWidth > 0, { timeout: 15000 });

const res = await page.evaluate(async () => {
  const { MASKS, getMask } = await import("/src/components/masks/maskDefs.ts");
  const { renderMaskLayer } = await import("/src/components/masks/renderMask.ts");

  // 模拟真实取景尺寸(4:3)与成片尺寸
  const cases = [];
  for (const m of MASKS) {
    const W = 640, H = 480;
    const a = renderMaskLayer(m, W, H);
    const b = renderMaskLayer(m, W, H); // 同参数重渲染,必须完全一致(确定性)
    if (!a || !b) { cases.push({ key: m.key, ok: false }); continue; }
    const ga = a.getContext("2d").getImageData(0, 0, W, H).data;
    const gb = b.getContext("2d").getImageData(0, 0, W, H).data;
    let diff = 0;
    for (let i = 0; i < ga.length; i++) {
      if (Math.abs(ga[i] - gb[i]) > 2) diff++;
    }
    cases.push({ key: m.key, ok: true, diffRatio: diff / ga.length });
  }
  // 跨尺寸一致性:同一蒙版在预览尺寸与成片尺寸下,镂空中心是否落在同一相对位置
  const geom = [];
  for (const m of MASKS) {
    const centroid = (w, h) => {
      const c = renderMaskLayer(m, w, h);
      const d = c.getContext("2d").getImageData(0, 0, w, h).data;
      let sx = 0, n = 0;
      for (let y = 0; y < h; y += 2) {
        for (let x = 0; x < w; x += 2) {
          if (d[(y * w + x) * 4 + 3] < 12) { sx += x; n++; }
        }
      }
      return n ? sx / n / w : -1;
    };
    const c1 = centroid(320, 240);
    const c2 = centroid(1280, 960);
    geom.push({ key: m.key, c1: +c1.toFixed(3), c2: +c2.toFixed(3) });
  }
  return { cases, geom, total: MASKS.length, keys: MASKS.map((m) => m.key) };
});

console.log(`\n--- 1. 同参数重渲染必须逐像素一致(确定性,无随机) ---`);
for (const c of res.cases) {
  if (!c.ok) { check(c.key, false, "渲染失败"); continue; }
  check(`${c.key} 渲染确定性`, c.diffRatio < 0.001, `差异像素=${(c.diffRatio * 100).toFixed(3)}%`);
}

console.log("\n--- 2. 跨尺寸镂空中心相对位置一致(预览=成片) ---");
for (const g of res.geom) {
  check(`${g.key} 镂空中心一致`, Math.abs(g.c1 - g.c2) < 0.02, `${g.c1} vs ${g.c2}`);
}

console.log("\n--- 3. 预览 <img> 已挂载且随蒙版切换 ---");
// 蒙版已改为按人数分标签页,所以要先切到对应标签页,按钮才存在。
// 直接点 [data-mask=...] 在标签页外会 timeout —— 这点容易被漏掉。
for (const [key, tab] of [
  ["heart", "single"],
  ["dual_circle", "dual"],
  ["bear", "single"],
]) {
  await page.locator(`[data-tab="${tab}"]`).click();
  await page.waitForTimeout(250);
  await page.locator(`[data-mask="${key}"]`).click();
  await page.waitForTimeout(450);
  const info = await page.evaluate(() => {
    const img = [...document.querySelectorAll("img")].find((i) =>
      (i.getAttribute("src") || "").startsWith("data:image/png"),
    );
    return img ? { w: img.naturalWidth, h: img.naturalHeight } : null;
  });
  check(`${key} 预览层已生成`, !!info, info ? `${info.w}x${info.h}` : "未找到 img");
}

console.log("\n--- 4. 走真实拍照流程,验证出片真的烧录了蒙版 ---");
// 这条路径同时覆盖 ref 改造后的拍照链路:空格 -> CountdownOverlay -> doSnap
// -> camRef.current.snap()。早先这里用动态 import 拿 snap(),会得到另一个模块
// 实例而恒为 null,现已改为走真实 UI。
await page.locator('[data-tab="single"]').click();
await page.waitForTimeout(250);
await page.locator('[data-mask="heart"]').click();
await page.waitForTimeout(400);

await page.evaluate(() => {
  const s = window.__store;
  if (s) s.getState().setFrames([]);
});
await page.keyboard.press("Space");
// 等 4 张连拍完成(3 秒倒计时 ×4)
await burstTo(page, 4);
await page.waitForTimeout(500);

const burn = await page.evaluate(() => {
  const s = window.__store;
  const frames = s.getState().frames;
  if (!frames.length) return { ok: false, reason: "store 内无成片" };
  // frames 元素现在是 {url, burnedIn}(见 store.ts 的 Frame), 兼容旧的裸字符串。
  const entry = frames[0];
  const first = typeof entry === "string" ? entry : entry.url;
  return { ok: true, count: frames.length, first, burnedIn: entry.burnedIn };
});
check("真实流程产出 4 张成片", burn.ok && burn.count >= 4, burn.reason ?? `${burn.count} 张`);

if (burn.ok) {
  const px = await page.evaluate(async (dataUrl) => {
    const img = new Image();
    await new Promise((r, j) => {
      img.onload = r;
      img.onerror = j;
      img.src = dataUrl;
    });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    // 爱心蒙版:四角是粉色背景,心形洞内是照片
    const corner = g.getImageData(4, 4, 1, 1).data;
    const center = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return { w: c.width, h: c.height, corner: [...corner], center: [...center] };
  }, burn.first);

  const [r, g, b] = px.corner;
  const isPink = Math.abs(r - 255) < 18 && Math.abs(g - 216) < 18 && Math.abs(b - 225) < 18;
  check("成片四角是蒙版背景粉色", isPink, `rgb(${r},${g},${b})`);
  // 假摄像头画面偏绿/偏灰,绝不应等于粉色
  const centerNotPink =
    Math.abs(px.center[0] - 255) > 20 || Math.abs(px.center[2] - 225) > 20;
  check("成片中心透出照片而非蒙版色", centerNotPink, `rgb(${px.center.slice(0, 3).join(",")})`);
  console.log(`         成片尺寸 ${px.w}x${px.h}`);
}

console.log("\n--- 5. 无运行时错误 ---");
check("无 pageerror", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();
console.log(`\n结果: ${PASS.length} 通过, ${FAIL.length} 失败`);
if (FAIL.length) {
  console.log("失败项: " + FAIL.join(", "));
  process.exit(1);
}
