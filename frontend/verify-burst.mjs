/**
 * 验证连拍能完整走完 4 张, 且结束后按钮释放。
 *
 * 历史背景:曾有「倒计时冻结」bug —— CountdownOverlay 的倒计时由
 * useEffect 依赖 [show] 驱动, 第 1 张拍完后 setShowCountdown(true)
 * 因同值 bail out 导致倒计时不再重跑, 卡在 1/4。
 * 现在倒计时由 snapTick 自增驱动, 该 bug 已不复现。
 *
 * P1 变更:前 3 张拍完后会暂停等用户在 RetakeBar 上点「继续」或
 * 「重拍本张」, 所以本脚本必须在 RetakeBar 出现时点「继续」,
 * 否则会一直停在 1/4。这是计划内的行为变更, 不是回归。
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.APP_URL || "http://localhost:5173/home";

/**
 * 截图落盘路径, 从**本文件位置**推导而不是靠 CWD。
 *
 * 早先写的是 "../outputs/_verify/burst.png" —— 它只在 CWD 恰好是
 * frontend/ 时成立。从仓库根跑 `node frontend/verify-burst.mjs` 时,
 * 截图会落到仓库根的 outputs/ 下(还不存在, 于是 Playwright 报错),
 * 而真正的 outputs/_verify/ 里什么都没有。失败信息指向路径, 不指向
 * "你在错误的目录里跑了我"这件真正的事。
 *
 * _verify 以下划线开头, 后端扫描时会跳过它, 所以它不会污染画廊 ——
 * 这也是本脚本不需要 harness 的原因(它不造 job 数据)。
 */
const SHOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "outputs",
  "_verify",
  "burst.png",
);

/**
 * playwright 是否可用。同样的理由: existsSync("node_modules/playwright")
 * 依赖 CWD, 从仓库根跑会误判成"没装"从而静默 skip —— 一个从不执行的
 * 验证脚本比失败的更危险。createRequire 以本文件为基准解析, 与 CWD 无关。
 */
function canResolvePlaywright() {
  try {
    createRequire(import.meta.url).resolve("playwright");
    return true;
  } catch {
    return false;
  }
}

function log(...a) { console.log("  ", ...a); }

const counter = (page) =>
  page.locator("text=/已拍 \\d+ \\/ 4/").first().innerText();
const button = (page) =>
  page.locator("button", { hasText: /拍摄中|开始连拍/ }).first();

async function main() {
  if (!canResolvePlaywright()) {
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
  let retakeBarHits = 0;
  let reachedDecorate = false;
  const deadline = t0 + 90000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(700);
    // P1: 第 4 张拍完直接跳 /decorate, 计数器随之消失 —— 这是计划内行为,
    // 用 URL 判定而不是死等计数器文本。
    if (/\/decorate$/.test(page.url())) {
      reachedDecorate = true;
      log(`  t+${((Date.now() - t0) / 1000).toFixed(0)}s -> 已跳转到 /decorate (第 4 张直通)`);
      break;
    }
    const cur = (await counter(page)).replace(/\s+/g, " ");
    if (cur !== last) {
      log(`  t+${((Date.now() - t0) / 1000).toFixed(0)}s ->`, cur);
      last = cur;
    }
    // P1: 前 3 张拍完会弹 RetakeBar, 点「继续」推进下一张
    const cont = page.locator("button", { hasText: /^继续$/ }).first();
    if (await cont.count()) {
      if (await cont.isVisible().catch(() => false)) {
        retakeBarHits++;
        log(`  t+${((Date.now() - t0) / 1000).toFixed(0)}s -> RetakeBar 出现, 点「继续」`);
        await cont.click();
        await page.waitForTimeout(400);
      }
    }
  }

  // Playwright 不会自动创建截图的父目录, 目录不存在会直接抛 ENOENT
  mkdirSync(path.dirname(SHOT), { recursive: true });
  await page.screenshot({ path: SHOT });

  console.log("");
  const stillCapturing = /\/decorate$/.test(page.url())
    ? false
    : (await button(page).innerText()).includes("拍摄中");
  console.log(`  最终 URL: ${page.url()}`);
  console.log(`  按钮=${stillCapturing ? "仍在拍摄中(卡死)" : "已释放"}`);
  console.log(`  RetakeBar 暂停次数: ${retakeBarHits} (预期 3, 第 4 张直通)`);
  console.log(`  截图: ${SHOT}`);
  if (errors.length) console.log("  页面错误:", errors.slice(0, 3));
  // 成功条件: 暂停恰好 3 次(前 3 张) + 第 4 张拍完跳 decorate + 按钮已释放
  const ok = retakeBarHits === 3 && reachedDecorate && !stillCapturing;
  console.log(ok ? "  => PASS 连拍完成" : "  => FAIL 连拍中断");

  await browser.close();
  process.exit(ok ? 0 : 1);
}

main();
