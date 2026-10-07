/**
 * 蒙版人数标签页验证
 *
 * 需求:蒙版按「无 / 单人 / 双人」分标签页,不要 15 个平铺一起显示。
 *
 * 重点验证三件事:
 *   1. 任一时刻只显示当前标签页的蒙版(平铺会造成一次看全部)
 *   2. 切标签页会同步切换选中项 —— 否则出现"标签写双人、预览是单人"的错位
 *   3. 各标签页数量正确:无=1项,单人=9,双人=6
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
const ctx = await browser.newContext({
  permissions: ["camera"],
  viewport: { width: 1100, height: 1200 },
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelector("video")?.videoWidth > 0, { timeout: 15000 });

// 统计当前可见的蒙版按钮(排除标签页按钮与"无"选项)
const visibleMasks = () =>
  page.evaluate(() => {
    const panel = document.querySelector('[role="tabpanel"]');
    if (!panel) return [];
    return [...panel.querySelectorAll("button[data-mask]")].map((b) => b.dataset.mask);
  });
const activeTab = () =>
  page.evaluate(() => {
    const t = document.querySelector('[role="tab"][aria-selected="true"]');
    return t ? t.dataset.tab : null;
  });
const selectedMask = () =>
  page.evaluate(() => window.__store.getState().maskKey);

console.log("\n--- 1. 三个标签页存在且标注数量 ---");
const tabs = await page.evaluate(() =>
  [...document.querySelectorAll('[role="tab"]')].map((t) => ({
    key: t.dataset.tab,
    label: t.textContent.trim(),
  })),
);
check("标签页共 3 个", tabs.length === 3, JSON.stringify(tabs.map((t) => t.key)));
check("标签为 无/单人/双人", JSON.stringify(tabs.map((t) => t.key)) === '["none","single","dual"]');
check("单人标注 9", tabs.find((t) => t.key === "single")?.label.includes("9"),
  tabs.find((t) => t.key === "single")?.label);
check("双人标注 6", tabs.find((t) => t.key === "dual")?.label.includes("6"),
  tabs.find((t) => t.key === "dual")?.label);

console.log("\n--- 2. 只显示当前标签页(不平铺) ---");
let seen = {};
for (const tab of ["single", "dual", "none"]) {
  await page.locator(`[data-tab="${tab}"]`).click();
  await page.waitForTimeout(350);
  const list = await visibleMasks();
  seen[tab] = list;
  const at = await activeTab();
  check(`切到「${tab}」后该页激活`, at === tab, `activeTab=${at}`);
  // 单人 9 / 双人 6 / 无 1
  const want = tab === "single" ? 9 : tab === "dual" ? 6 : 1;
  check(
    `「${tab}」页只显示 ${want} 项`,
    list.length === want,
    `实际 ${list.length}: ${list.join(",")}`,
  );
}
check("三页蒙版不重复(互斥)", (() => {
  const all = [...seen.single, ...seen.dual, ...seen.none];
  return new Set(all).size === all.length;
})(), `single=${seen.single.length} dual=${seen.dual.length} none=${seen.none.length}`);

console.log("\n--- 3. 切页同步切换选中项(预览不错位) ---");
await page.locator('[data-tab="dual"]').click();
await page.waitForTimeout(350);
const selDual = await selectedMask();
const visDual = await visibleMasks();
check("切到双人页后选中项属于双人", visDual.includes(selDual), `selected=${selDual}`);
check(
  "双人选中项确为 dual_*",
  selDual.startsWith("dual_"),
  selDual,
);

await page.locator('[data-tab="single"]').click();
await page.waitForTimeout(350);
const selSingle = await selectedMask();
const visSingle = await visibleMasks();
check("切回单人页后选中项属于单人", visSingle.includes(selSingle), `selected=${selSingle}`);
check("单人选中项不属 dual", !selSingle.startsWith("dual_"), selSingle);

await page.locator('[data-tab="none"]').click();
await page.waitForTimeout(350);
check("切到「无」页选中 none", (await selectedMask()) === "none");

// 关键回归:从 none 还能切回单人(若标签状态由 none 锁死就会卡住)
await page.locator('[data-tab="single"]').click();
await page.waitForTimeout(350);
check("从「无」页可切回单人(标签不锁死)", (await activeTab()) === "single");

console.log("\n--- 4. 预览层随标签页更新 ---");
await page.locator('[data-tab="dual"]').click();
await page.waitForTimeout(500);
const dualPreview = await page.evaluate(() => {
  const img = [...document.querySelectorAll("img")].find((i) =>
    (i.getAttribute("src") || "").startsWith("data:image/png"),
  );
  return img ? img.naturalWidth : 0;
});
check("双人蒙版预览层已渲染", dualPreview > 0, `${dualPreview}px`);

await page.locator('[data-tab="none"]').click();
await page.waitForTimeout(500);
const nonePreview = await page.evaluate(() => {
  const img = [...document.querySelectorAll("img")].find((i) =>
    (i.getAttribute("src") || "").startsWith("data:image/png"),
  );
  return img ? img.naturalWidth : 0;
});
check("「无」蒙版时预览层已移除", nonePreview === 0, `${nonePreview}px`);

console.log("\n--- 5. 出片仍与所选标签一致 ---");
await page.locator('[data-tab="dual"]').click();
await page.waitForTimeout(500);
await page.evaluate(() => window.__store.getState().setFrames([]));
await page.keyboard.press("Space");
await burstTo(page, 4);
const ok = await page.evaluate(() => {
  const s = window.__store.getState();
  return { mask: s.maskKey, n: s.frames.length };
});
check("双人页拍照出 4 张", ok.n >= 4, `${ok.n} 张, mask=${ok.mask}`);

console.log("\n--- 6. 无运行时错误 ---");
check("无 pageerror/console error", errors.length === 0, errors.slice(0, 2).join(" | "));

// 截一张标签页 UI
await page.locator('[data-tab="single"]').click();
await page.waitForTimeout(400);
// 前面跑完连拍后应用会跳到 /decorate,拍照页已卸载,
// 截图前先回 /home。用显式测试钩子定位选择条 —— 早期靠 tablist 的
// 父节点(xpath=..),但蒙版条后来把标签页与「图库」按钮并排放进同一个
// flex 行,父节点不再等于选择条本身。
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelector("video")?.videoWidth > 0, {
  timeout: 20000,
});
await page.locator('[data-tab="single"]').click();
await page.waitForTimeout(400);
const strip = page.locator("[data-mask-strip]");
await strip.screenshot({ path: "mask-tabs.png" });

await browser.close();
console.log(`\n结果: ${PASS.length} 通过, ${FAIL.length} 失败`);
if (FAIL.length) {
  console.log("失败项: " + FAIL.join(", "));
  process.exit(1);
}
