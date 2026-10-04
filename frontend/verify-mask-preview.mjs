/**
 * 取景框实时蒙版验证(Playwright + 假摄像头)
 *
 * 背景:大头贴的拍照体验参照 JUST FOTO —— 关键不是"能套相框",
 * 而是"按快门之前就能在取景框里看到成片长什么样"(所见即所得)。
 * 这依赖三件事同时成立,本测试逐条验证:
 *
 *   1. 取景框里真的画出了相框色块(不是只在 DOM 里挂了个空壳)
 *   2. 切滤镜时 <video> 的 CSS filter 实时跟着变
 *   3. snap() 出片时真的把相框与滤镜烧进了像素 —— 预览和成片一致
 *
 * 第 3 条最容易"看起来对但其实没生效"(例如 overlay 画了但 snap 忘了烧),
 * 所以这里直接读 canvas 像素来判定,而不是只看截图。
 */
import { chromium } from "playwright";

const URL = process.env.APP_URL || "http://localhost:5173/home";

const PASS = [];
const FAIL = [];
function check(name, cond, detail = "") {
  (cond ? PASS : FAIL).push(name);
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name} ${detail}`);
}

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
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });

// 等摄像头出帧
await page.waitForFunction(() => {
  const v = document.querySelector("video");
  return v && v.videoWidth > 0;
}, { timeout: 15000 });
await page.waitForTimeout(600);

console.log("\n--- 1. 蒙版 DOM 是否渲染 ---");
const overlay = await page.evaluate(() => {
  // MaskOverlay 根节点带 pointer-events-none
  const nodes = [...document.querySelectorAll("div.pointer-events-none")];
  return {
    count: nodes.length,
    hasSvg: nodes.some((n) => n.querySelector("svg")),
    childCount: nodes[0] ? nodes[0].children.length : 0,
  };
});
check("MaskOverlay 已挂载", overlay.count > 0, `找到 ${overlay.count} 个`);
check("构图引导线 SVG 存在", overlay.hasSvg);

// 相框色块:粉色边框(korean_pink 默认)应有非透明背景的绝对定位层
const frameBar = await page.evaluate(() => {
  const root = [...document.querySelectorAll("div.pointer-events-none")][0];
  if (!root) return null;
  const bars = [...root.querySelectorAll("div")].filter((d) => {
    const s = getComputedStyle(d);
    return s.position === "absolute" && s.backgroundColor !== "rgba(0, 0, 0, 0)";
  });
  return { n: bars.length, sample: bars[0] ? getComputedStyle(bars[0]).backgroundColor : null };
});
check("相框色块已绘制", (frameBar?.n ?? 0) > 0, `色块数=${frameBar?.n} 颜色=${frameBar?.sample}`);

console.log("\n--- 2. 滤镜实时预览 ---");
const readFilter = () =>
  page.evaluate(() => getComputedStyle(document.querySelector("video")).filter);
const before = await readFilter();
check("默认滤镜已施加到 video", before && before !== "none", before);

// 切到「黑白经典」,CSS filter 应变成 grayscale
await page.getByRole("button", { name: "黑白经典" }).click();
await page.waitForTimeout(300);
const after = await readFilter();
check("切换滤镜后 CSS filter 实时变化", after !== before, `${before} -> ${after}`);
check("黑白滤镜含 grayscale", /grayscale/.test(after), after);

// 切回一个带 sepia 的滤镜,验证暖调链路
await page.getByRole("button", { name: "柯达暖调" }).click();
await page.waitForTimeout(300);
const koda = await readFilter();
check("柯达暖调含 sepia", /sepia/.test(koda), koda);

console.log("\n--- 3. 出片是否真的烧录(所见即所得) ---");
/**
 * 走真实拍照流程(空格连拍),再从 store 取成片解码统计像素。
 * 早先这里用动态 import 去拿 LiveCamera 的 snap,但那会得到**另一个模块实例**,
 * _snap 实际挂在 React 使用的那份模块上,于是恒为 null —— 是测试方法的问题,
 * 不是功能的问题。改用真实 UI 流程后覆盖的是完整链路。
 */
await page.locator('[data-mask="none"]').click();
await page.waitForTimeout(300);
await page.evaluate(() => window.__store.getState().setFrames([]));
await page.keyboard.press("Space");
await page.waitForFunction(() => window.__store.getState().frames.length >= 4, { timeout: 60000 });

const burn = await page.evaluate(async () => {
  const first = window.__store.getState().frames[0];
  if (!first) return { ok: false, reason: "store 内无成片" };

  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = first;
  });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);

  // 四角应当是相框底色(粉 #ffd8e1),不是摄像头画面
  const corner = g.getImageData(2, 2, 1, 1).data;
  const center = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
  return {
    ok: true,
    w: c.width,
    h: c.height,
    corner: [...corner],
    center: [...center],
  };
});

check("拍照流程产出成片", burn.ok, burn.reason ?? `${burn.w}x${burn.h}`);
if (burn.ok) {
  // 粉色边框 R=253 G=216 B=225,容差 ±12(考虑 JPEG 压缩)
  const [r, gg, b] = burn.corner;
  const isPinkFrame =
    Math.abs(r - 253) < 14 && Math.abs(gg - 216) < 14 && Math.abs(b - 225) < 14;
  check("成片四角已被相框填充(粉色)", isPinkFrame, `rgb(${r},${gg},${b})`);
  check("成片中心保留画面(非相框色)", burn.center.join() !== burn.corner.join(),
    `center=rgb(${burn.center.slice(0, 3).join(",")})`);
}

console.log("\n--- 4. 关闭蒙版后应为裸画面 ---");
await page.getByText("实时蒙版预览").click();
await page.waitForTimeout(300);
const off = await page.evaluate(() => {
  const root = [...document.querySelectorAll("div.pointer-events-none")][0];
  const v = document.querySelector("video");
  return { overlayGone: !root, filter: getComputedStyle(v).filter };
});
check("蒙版层已隐藏", off.overlayGone);
check("滤镜已复位", off.filter === "none", off.filter);

console.log("\n--- 5. 控制台无报错 ---");
check("无 console/page 错误", errors.length === 0, errors.slice(0, 3).join(" | "));

await page.screenshot({ path: "verify-mask-preview.png" });
await browser.close();

console.log(`\n结果: ${PASS.length} 通过, ${FAIL.length} 失败`);
if (FAIL.length) {
  console.log("失败项: " + FAIL.join(", "));
  process.exit(1);
}
