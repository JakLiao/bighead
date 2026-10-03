/**
 * 复现并验证连拍中断的根因。
 *
 * 推断:CountdownOverlay 的倒计时由 useEffect 依赖 [show] 驱动。
 * 第 1 张拍完后 HomePage 执行 setShowCountdown(true),而此时 show
 * 已经是 true —— React 对相同值的 setState 会 bail out,不会触发重渲染,
 * 于是 useEffect 不重跑,倒计时冻结在 1,永远不触发 onComplete。
 * 结果:已拍 1/4,按钮卡在"拍摄中..."。
 *
 * 验证方式:用 Playwright 驱动真实页面,连按空格,观察已拍计数是否推进。
 * 1/4 => 复现;4/4 => 已修复。
 */
import { chromium } from "playwright";
import { existsSync } from "node:fs";

const BASE = process.env.APP_URL || "http://localhost:5173/home";
const SHOT = "../outputs/_verify/burst.png";

function log(...a) { console.log("  ", ...a); }

const counter = (page) =>
  page.locator("text=/已拍 \\d+ \\/ 4/").first().innerText();
const button = (page) =>
  page.locator("button", { hasText: /拍摄中|开始连拍/ }).first();

async function main() {
  if (!existsSync("node_modules/playwright")) {
    console.log("  playwright 未安装,跳过");
    process.exit(0);
  }
  // 用系统 Chrome + 假摄像头,与 verify-camera.mjs 一致
  const browser = await chromium.launch({
    channel: "chrome",
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const ctx = await browser.newContext({
    permissions: ["camera"],
    viewport: { width: 940, height: 1000 },
  });
  await ctx.grantPermissions(["camera"], { origin: BASE });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  log("初始:", (await counter(page)).replace(/\s+/g, " "));
  const btn = button(page);
  log("按钮:", (await btn.innerText()).trim());

  await btn.click();
  log("点击后:", (await button(page).innerText()).trim());

  const t0 = Date.now();
  let last = "";
  const deadline = t0 + 45000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const cur = (await counter(page)).replace(/\s+/g, " ");
    if (cur !== last) {
      log(`  t+${((Date.now() - t0) / 1000).toFixed(0)}s ->`, cur);
      last = cur;
    }
    if (/已拍\s*4\s*\/\s*4/.test(cur)) break;
  }

  const final = (await counter(page)).replace(/\s+/g, " ");
  const stillCapturing = (await button(page).innerText()).includes("拍摄中");
  await page.screenshot({ path: SHOT });

  console.log("");
  const n = Number(/已拍\s*(\d+)\s*\/\s*4/.exec(final)?.[1] ?? 0);
  console.log(`  结果: ${final}  按钮=${stillCapturing ? "仍在拍摄中(卡死)" : "已释放"}`);
  console.log(`  截图: ${SHOT}`);
  if (errors.length) console.log("  页面错误:", errors.slice(0, 3));
  console.log(n === 4 && !stillCapturing ? "  => PASS 连拍完成" : "  => FAIL 连拍中断");

  await browser.close();
  process.exit(n === 4 && !stillCapturing ? 0 : 1);
}

main();
