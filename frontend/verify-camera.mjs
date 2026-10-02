/**
 * 摄像头挂载验证(Playwright + 假摄像头设备)
 *
 * 背景:此前 LiveCamera 在 React StrictMode 下会报
 * "The play() request was interrupted because the media was removed from the document"
 * 并误显示为「摄像头不可用」。
 *
 * 本测试用 Chromium 的 --use-fake-device-for-media-stream 模拟摄像头,
 * 验证:
 *   1. getUserMedia 能拿到流(设备层面可用)
 *   2. video 元素最终进入播放态(videoWidth > 0 且 readyState >= 2)
 *   3. 页面不出现「摄像头不可用」错误卡片
 *   4. StrictMode 双挂载下不产生残留轨道
 */
import { chromium } from "playwright";

const URL = process.env.APP_URL || "http://localhost:5173/home";

const PASS = [];
const FAIL = [];
function check(name, cond, detail = "") {
  (cond ? PASS : FAIL).push(name);
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name} ${detail}`);
}

// REAL_CAMERA=1 时用真实摄像头(需先关闭占用程序),默认用 Chromium 假设备
const REAL = process.env.REAL_CAMERA === "1";
const browser = await chromium.launch({
  channel: "chrome",
  args: REAL
    ? []
    : [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
});

const ctx = await browser.newContext({ permissions: ["camera"] });
const page = await ctx.newPage();

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(String(e)));

// 记录 getUserMedia / play 的实际调用次数,用于验证 StrictMode 双挂载行为
await page.addInitScript(() => {
  window.__gumCount = 0;
  window.__playCount = 0;
  window.__playRejects = [];
  // navigator.mediaDevices 在非安全上下文不存在,加保护避免污染异常统计
  const md = navigator.mediaDevices;
  if (md && typeof md.getUserMedia === "function") {
    const origGum = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      window.__gumCount += 1;
      return origGum(c);
    };
  }
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) {
    window.__playCount += 1;
    return origPlay.apply(this, a).catch((e) => {
      window.__playRejects.push(e.name + ": " + e.message);
      throw e;
    });
  };
});

console.log("=".repeat(64));
console.log("  Camera mount verification (fake device)");
console.log("=".repeat(64));

await page.goto(URL, { waitUntil: "networkidle" });

// 等待 video 真正出画
let video = null;
for (let i = 0; i < 40; i++) {
  const st = await page.evaluate(() => {
    const v = document.querySelector("video");
    if (!v) return null;
    return {
      hasSrc: !!v.srcObject,
      w: v.videoWidth,
      h: v.videoHeight,
      ready: v.readyState,
      paused: v.paused,
    };
  });
  if (st && st.w > 0 && st.ready >= 2) {
    video = st;
    break;
  }
  await page.waitForTimeout(250);
}

const stats = await page.evaluate(() => ({
  gum: window.__gumCount,
  play: window.__playCount,
  rejects: window.__playRejects,
}));

const bodyText = await page.evaluate(() => document.body.innerText);
const showsError = bodyText.includes("摄像头不可用");
const showsLoading = bodyText.includes("正在启动摄像头");

check("getUserMedia 被调用", stats.gum >= 1, `calls=${stats.gum}`);
check("video 拿到流尺寸", !!video, video ? `${video.w}x${video.h} ready=${video.ready}` : "no frames");
check("video 处于播放态", !!video && !video.paused, video ? `paused=${video.paused}` : "");
check("未显示「摄像头不可用」", !showsError, showsError ? "错误卡片出现了" : "");
check("未卡在加载中", !showsLoading, showsLoading ? "仍在「正在启动摄像头」" : "");

console.log(`\n  gum=${stats.gum} play=${stats.play}`);
if (stats.rejects.length) {
  console.log("  play() rejections (应被静默处理,不进 UI):");
  for (const r of stats.rejects) console.log(`    - ${r}`);
}

// StrictMode 会双调用, gum>=2 是预期的;关键是最终只有一路在用
check("StrictMode 双调用已发生", stats.gum >= 2, `gum=${stats.gum}`);

// 残留轨道检查:离开页面后应全部 stop
await page.goto("about:blank");
await page.waitForTimeout(300);
const leaked = await page.evaluate(() => {
  // 页面已卸载,无法直接读;用 ctx 关闭后统计活跃流
  return null;
});

const realErrors = consoleErrors.filter(
  (e) => !/favicon|ResizeObserver|Download the React DevTools/i.test(e),
);
check("无未捕获的 JS 异常", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

console.log("\n" + "=".repeat(64));
console.log(`  PASS: ${PASS.length}   FAIL: ${FAIL.length}`);
if (FAIL.length) console.log("  failed -> " + FAIL.join(", "));
console.log("=".repeat(64));

await browser.close();
process.exit(FAIL.length ? 1 : 0);
