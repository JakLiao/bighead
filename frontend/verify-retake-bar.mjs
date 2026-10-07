/**
 * pose 文字浮层 + RetakeBar 单张重拍端到端验证。
 *
 * 覆盖：
 *  1. pose 浮层在拍摄期间可见，词按 嘟嘴/比心/看镜头/笑僵 循环
 *  2. pose 浮层可用开关关闭（showPose）
 *  3. RetakeBar 在第 1~3 张拍完时出现
 *  4. 点「重拍本张」：张数不变，且新照片插回原位置
 *  5. 点「继续」：拍下一张，张数 +1
 *  6. 第 4 张拍完不弹 RetakeBar，直通 /decorate
 *
 * 用假摄像头 + 真实点击，不 mock store。
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const URL = process.env.APP_URL || "http://localhost:5173/home";

/**
 * 截图落盘路径, 从本文件位置推导而不是靠 CWD。
 *
 * 早先写的是 "../outputs/_verify/retake-bar.png": 只在 CWD 恰好是
 * frontend/ 时成立, 从仓库根跑会落到错误位置; 又因为外面套了
 * .catch(() => {}), 失败还被完全吞掉 —— 脚本报告"通过", 截图根本没生成,
 * 而这个截图恰恰是人工复看 pose/RetakeBar 布局的唯一凭据。
 * 静默失败比没有截图更坏: 它让人以为看过了。
 */
const SHOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "outputs",
  "_verify",
  "retake-bar.png",
);
const PASS = [];
const FAIL = [];
const check = (n, c, d = "") => {
  (c ? PASS : FAIL).push(n);
  console.log(`  [${c ? "PASS" : "FAIL"}] ${n}${d ? "  " + d : ""}`);
};

const POSES = ["嘟嘴", "比心", "看镜头", "笑僵"];

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
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const counter = () =>
  page.locator("text=/已拍 \\d+ \\/ 4/").first().innerText();
const shotCount = async () => {
  const t = await counter();
  return Number(/已拍\s*(\d+)\s*\/\s*4/.exec(t)?.[1] ?? 0);
};
const poseText = async () => {
  const el = page.locator(".animate-pose-in").first();
  return (await el.count()) ? ((await el.innerText()).trim()) : null;
};
const retakeBar = () => page.locator("button", { hasText: /^重拍本张$/ }).first();
const contBtn = () => page.locator("button", { hasText: /^继续$/ }).first();

// 用 domcontentloaded 而非 networkidle —— vite HMR 的 websocket 常驻，
// networkidle 永远等不到。首次访问 /home 需 vite 现编译，放宽导航超时。
page.setDefaultNavigationTimeout(90000);
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector("video")?.videoWidth > 0, { timeout: 20000 });
await page.waitForTimeout(800);

try {
  // ---- 1) 开拍前 capturing=false，pose 不显示（只在拍摄期间提示）----
  const p0 = await poseText();
  check("开拍前 pose 不显示（capturing=false）", p0 === null, `got ${p0}`);

  // ---- 2) pose 开关存在且默认勾选 ----
  const poseToggle = page.locator("label", { hasText: "pose 文字提示" }).locator('input[type="checkbox"]');
  check("pose 开关存在", (await poseToggle.count()) === 1);
  check("pose 开关默认勾选", await poseToggle.isChecked());

  // ---- 3) 开始连拍 ----
  await page.locator("button", { hasText: /开始连拍/ }).first().click();

  // 倒计时期间 pose 应显示第 1 个词
  await page.waitForSelector(".animate-pose-in", { timeout: 10000 });
  const pStart = await poseText();
  check("开拍后 pose 显示第 1 个词", pStart === POSES[0], `got ${pStart}`);

  // 关闭开关 → 浮层消失 → 再打开
  await poseToggle.uncheck();
  await page.waitForTimeout(400);
  check("关闭开关后 pose 浮层消失", (await poseText()) === null, `got ${await poseText()}`);
  await poseToggle.check();
  await page.waitForTimeout(400);
  check("重新打开后 pose 浮层回来", (await poseText()) === POSES[0], `got ${await poseText()}`);

  // 等第 1 张拍完 → RetakeBar 出现
  await page.waitForSelector("button:has-text('重拍本张')", { timeout: 25000 });
  check("第 1 张拍完 RetakeBar 出现", await retakeBar().isVisible());
  check("此时已拍 1 张", (await shotCount()) === 1, `n=${await shotCount()}`);

  // pose 应该推进到第 2 个词（= 即将拍的第 2 张）
  const p1 = await poseText();
  check("拍完第 1 张 pose 提示第 2 张的词", p1 === POSES[1], `got ${p1}`);

  // RetakeBar 上有缩略图 + 文案
  check("RetakeBar 显示张数文案", (await page.locator("text=/第 \\d+ \\/ 4 张拍好了/").count()) >= 1);
  check("RetakeBar 显示刚拍的缩略图", (await page.locator('img[alt=""]').count()) >= 1);

  // ---- 4) 点「重拍本张」：张数不变，pose 回退到该张的词 ----
  await retakeBar().click();
  // 重拍后再等 RetakeBar 回来（第 1 张位置）
  await page.waitForSelector("button:has-text('重拍本张')", { timeout: 25000 });
  // RetakeBar 重现时新帧尚未插回（setFrames 已删、doSnap 还没跑完），
  // 留一拍让 frames 落定再读 pose，否则会读到中间态。
  await page.waitForTimeout(1200);
  const afterRetake = await shotCount();
  check("重拍后张数仍为 1", afterRetake === 1, `n=${afterRetake}`);
  // 重拍的是第 1 张：重拍完成后 frames.length 回到 1，下一张就是第 2 张，
  // 所以 pose 应提示第 2 张的词（与重拍前一致 —— 用户视角没变化）。
  const p2 = await poseText();
  check("重拍后 pose 仍提示下一张的词", p2 === POSES[1], `got ${p2}`);

  // ---- 5) 点「继续」：拍下一张，张数 +1 ----
  await contBtn().click();
  await page.waitForSelector("button:has-text('重拍本张')", { timeout: 25000 });
  await page.waitForTimeout(1200);
  const afterCont = await shotCount();
  check("点继续后张数 +1", afterCont === 2, `n=${afterCont}`);
  const p3 = await poseText();
  check("拍完第 2 张 pose 提示第 3 张的词", p3 === POSES[2], `got ${p3}`);

  // ---- 6) 一路「继续」到第 4 张 → 直通 decorate ----
  await contBtn().click(); // -> 第 3 张
  await page.waitForFunction(
    () => /已拍\s*3\s*\/\s*4/.test(document.body.innerText),
    { timeout: 25000 }
  );
  check("已拍 3 张", (await shotCount()) === 3);
  const p4 = await poseText();
  check("拍完第 3 张 pose 提示第 4 张的词", p4 === POSES[3], `got ${p4}`);

  // 第 4 张：不点任何按钮，等它自己拍完
  await contBtn().click();
  await page.waitForURL(/\/decorate$/, { timeout: 25000 });
  check("第 4 张拍完直通 /decorate", /\/decorate$/.test(page.url()), page.url());
  check("第 4 张没有再弹 RetakeBar（已离开 home）", (await retakeBar().count()) === 0);

  // ---- 7) 无 JS 错误 ----
  check("无未捕获 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));
} finally {
  // 截图是 teardown 期的诊断产物: 失败要看得见, 但不能让它盖掉
  // 主体真正的失败原因, 所以只告警不计入 PASS/FAIL。
  try {
    mkdirSync(path.dirname(SHOT), { recursive: true });
    await page.screenshot({ path: SHOT });
    console.log(`  截图: ${SHOT}`);
  } catch (e) {
    console.log(`  [WARN] 截图未生成: ${String(e).split("\n")[0]}`);
  }
  await browser.close();
}

console.log(`\nResult: ${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length) console.log("FAILED:", FAIL.join(" | "));
process.exit(FAIL.length ? 1 : 0);
