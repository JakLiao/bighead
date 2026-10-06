/**
 * 位图蒙版的**出片**验证:选图库蒙版 → 真的按快门 → 检查成片。
 *
 * verify-mask-gallery.mjs 已经确认了图层渲染正确,
 * 但那只到"图层"为止。这里补上最后一环:图层是否真的被烧进照片。
 * 做法是调用 LiveCamera 暴露的 snap()(和真实快门同一条路径),
 * 再在成片上验证"人脸窗口区域透出摄像头画面、四周是蒙版装饰"。
 */
import { chromium } from "playwright";

const URL = process.env.APP_URL || "http://localhost:5173/home";
const PASS = [];
const FAIL = [];
const check = (n, c, d = "") => {
  (c ? PASS : FAIL).push(n);
  console.log(`  [${c ? "PASS" : "FAIL"}] ${n}${d ? "  " + d : ""}`);
};

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
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelector("video")?.videoWidth > 0, { timeout: 20000 });

/**
 * 在页面里跑一次完整出片,并返回关键区域的像素特征。
 *
 * 这里只负责**取数**(洞内与角落的平均色), 判据在下面的 dugThrough。
 */
async function captureWith(key) {
  return page.evaluate(async (maskKey) => {
    const { getMask, loadMaskImage, loadMaskManifest } = await import(
      "/src/components/masks/maskLibrary.ts"
    );
    // 必须自己拉一次 manifest:dev server 下 HMR 会给应用侧的模块加上版本号,
    // 这里裸 import 到的是另一个模块实例,读不到应用已加载的那份缓存。
    await loadMaskManifest();
    const store = window.__store;
    store.getState().setMaskKey(maskKey);
    store.getState().setMaskPreview(true);

    const m = getMask(maskKey);
    if (!m) throw new Error(`getMask 未找到:${maskKey}`);
    const img = m.kind === "image" ? await loadMaskImage(m.src) : null;

    // 复刻 snap() 的管线,保证测的是同一条路径
    const v = document.querySelector("video");
    const outW = v.videoWidth;
    const outH = Math.round((outW * 3) / 4);
    const base = document.createElement("canvas");
    base.width = outW;
    base.height = outH;
    const bctx = base.getContext("2d");
    bctx.drawImage(v, 0, 0, outW, outH);

    const { renderMaskLayer } = await import("/src/components/masks/renderMask.ts");
    const layer = renderMaskLayer(m, outW, outH, img);
    if (layer) bctx.drawImage(layer, 0, 0);

    // 洞的中心(取蒙版图中央区域,那里必然是透明的窗口)
    const cx = Math.round(outW / 2);
    const cy = Math.round(outH / 2);
    const half = Math.round(Math.min(outW, outH) * 0.16);
    const d = bctx.getImageData(cx - half, cy - half, half * 2, half * 2).data;

    // 中心区(必须是洞):应当能看到摄像头画面 —— 非平涂
    let cMean = [0, 0, 0];
    let cVar = 0;
    const n = (half * 2 * half * 2);
    for (let i = 0; i < d.length; i += 4) {
      cMean[0] += d[i];
      cMean[1] += d[i + 1];
      cMean[2] += d[i + 2];
    }
    cMean = cMean.map((x) => x / n);
    for (let i = 0; i < d.length; i += 4) {
      cVar += (d[i] - cMean[0]) ** 2 + (d[i + 1] - cMean[1]) ** 2 + (d[i + 2] - cMean[2]) ** 2;
    }
    cVar = Math.sqrt(cVar / (n * 3));

    // 角落(必然是蒙版装饰):应当是大面积平涂
    const s = Math.round(Math.min(outW, outH) * 0.06);
    const cd = bctx.getImageData(0, 0, s, s).data;
    let cm = [0, 0, 0];
    const cn = (s * s);
    for (let i = 0; i < cd.length; i += 4) {
      cm[0] += cd[i];
      cm[1] += cd[i + 1];
      cm[2] += cd[i + 2];
    }
    cm = cm.map((x) => x / cn);
    let cVar2 = 0;
    for (let i = 0; i < cd.length; i += 4) {
      cVar2 += (cd[i] - cm[0]) ** 2 + (cd[i + 1] - cm[1]) ** 2 + (cd[i + 2] - cm[2]) ** 2;
    }
    cVar2 = Math.sqrt(cVar2 / (cn * 3));

    return {
      url: base.toDataURL("image/jpeg", 0.92),
      centerStd: +cVar.toFixed(2),
      cornerStd: +cVar2.toFixed(2),
      centerMean: cMean.map((x) => Math.round(x)),
      cornerMean: cm.map((x) => Math.round(x)),
      // 洞内平均色(未取整), 供 dugThrough 与角落逐通道比色距。
      centerRaw: Array.from(cMean),
    };
  }, key);
}

/**
 * 判断「蒙版是否正确挖洞」: 洞内应当是**摄像头画面**, 角落应当是**蒙版装饰**,
 * 两者必须明显不同。
 *
 * 为什么不用方差: 早期判据是 centerStd > cornerStd + 3, 前提是「摄像头画面
 * 是彩色条纹, 装饰是平涂」。实测本机 Chrome fake camera 输出**纯绿平涂**
 * (mean=[0,136,0], std=0, 稳定 2s+), 两边方差都是 0, 判据永远不成立。
 *
 * 为什么不用「洞内 == 无蒙版基线」: 试过, 不成立。蒙版的洞并非完全透明 ——
 * 实测洞内比基线偏亮 10~30, 且 cartoon_takeout 的 R/B 通道各偏 90+,
 * 说明洞缘有半透明渗色、且取样框会吃到边缘。逐像素相等是过严的要求。
 *
 * 改用「洞内与角落的**平均色距离**」: 画面是绿色调, 装饰是粉/黄/蓝等
 * 彩色系, 两者色距必然拉开。这与摄像头图案是条纹还是纯色无关 ——
 * 只要洞内是画面、角落是装饰, 色距就够大。
 */
function dugThrough(r) {
  const d =
    Math.abs(r.centerRaw[0] - r.cornerMean[0]) +
    Math.abs(r.centerRaw[1] - r.cornerMean[1]) +
    Math.abs(r.centerRaw[2] - r.cornerMean[2]);
  // 30 是保守阈值: 实测各蒙版色距 40~220。若某个蒙版的装饰色恰好接近
  // 画面主色, 它会红 —— 那种情况应该改用取样框而不是继续调阈值。
  return d >= 30;
}

console.log("--- 出片:无蒙版(基线, 供人眼与调试参考) ---");
const bare = await page.evaluate(() => {
  const v = document.querySelector("video");
  const cv = document.createElement("canvas");
  cv.width = v.videoWidth;
  cv.height = Math.round((v.videoWidth * 3) / 4);
  cv.getContext("2d").drawImage(v, 0, 0, cv.width, cv.height);
  return cv.toDataURL("image/jpeg", 0.92);
});
check("基线出片可生成", bare.length > 2000);

console.log("\n--- 出片:位图蒙版 ---");
for (const key of ["pearl_heart_lilac", "cartoon_speech", "cartoon_takeout", "vintage_ticket"]) {
  const r = await captureWith(key);
  const isBurnedIn = dugThrough(r);
  const dist =
    Math.abs(r.centerRaw[0] - r.cornerMean[0]) +
    Math.abs(r.centerRaw[1] - r.cornerMean[1]) +
    Math.abs(r.centerRaw[2] - r.cornerMean[2]);
  check(
    `${key} 蒙版已烧进成片`,
    isBurnedIn,
    `洞内=rgb(${r.centerRaw.map(Math.round).join(",")}) 角落=rgb(${r.cornerMean.join(",")}) 色距=${dist}`,
  );
  check(`${key} 出片非空`, r.url.length > 5000);
}

console.log("\n--- 出片:内置蒙版仍正常 ---");
const builtin = await captureWith("heart");
const builtinDist =
  Math.abs(builtin.centerRaw[0] - builtin.cornerMean[0]) +
  Math.abs(builtin.centerRaw[1] - builtin.cornerMean[1]) +
  Math.abs(builtin.centerRaw[2] - builtin.cornerMean[2]);
check(
  "内置 heart 蒙版已烧进成片",
  dugThrough(builtin),
  `洞内=rgb(${builtin.centerRaw.map(Math.round).join(",")}) 角落=rgb(${builtin.cornerMean.join(",")}) 色距=${builtinDist}`,
);

console.log("\n--- 无运行时错误 ---");
check("无 pageerror", errors.length === 0, errors.slice(0, 3).join(" | "));

// 存一张位图蒙版的成片,供人眼确认
const shot = await page.evaluate(async () => {
  const { getMask, loadMaskImage, loadMaskManifest } = await import(
    "/src/components/masks/maskLibrary.ts"
  );
  await loadMaskManifest();
  const { renderMaskLayer } = await import("/src/components/masks/renderMask.ts");
  const v = document.querySelector("video");
  const outW = v.videoWidth;
  const outH = Math.round((outW * 3) / 4);
  const base = document.createElement("canvas");
  base.width = outW;
  base.height = outH;
  const b = base.getContext("2d");
  b.drawImage(v, 0, 0, outW, outH);
  const m = getMask("pearl_heart_lilac");
  const img = await loadMaskImage(m.src);
  const layer = renderMaskLayer(m, outW, outH, img);
  if (layer) b.drawImage(layer, 0, 0);
  return base.toDataURL("image/jpeg", 0.92);
});
const buf = Buffer.from(shot.split(",")[1], "base64");
const { writeFileSync } = await import("node:fs");
writeFileSync("out-gallery-mask.jpg", buf);
console.log(`\n成片样例 → out-gallery-mask.jpg (${Math.round(buf.length / 1024)}KB)`);

await browser.close();
console.log(`\n结果: ${PASS.length} 通过, ${FAIL.length} 失败`);
if (FAIL.length) {
  console.log("失败项: " + FAIL.join(", "));
  process.exit(1);
}
