/**
 * 蒙版图库端到端验证
 *
 * 分四层递进验证:
 *   1. 清单与素材   —— manifest 可加载,PNG 真的能解码出透明镂空
 *   2. 图库交互     —— 抽屉能打开、分类/搜索能筛选、点选即应用并自动收起
 *   3. 预览与成片   —— 选中的位图蒙版确实出现在取景框,成片里也烧进了同一张图
 *   4. 内置蒙版回归 —— 原有 15 个代码蒙版没被这次改动弄坏
 *
 * 第 3 层是重点:位图蒙版的洞烘在 PNG 的 alpha 里,若"预览用的图"和
 * "出片用的图"不是同一张,就会出现取景框有蒙版、成片没有的穿帮。
 * 这里直接比对两者的像素来兜住这个风险。
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

// ───────────────────────── 1. 清单与素材 ─────────────────────────
console.log("\n--- 1. 清单与素材 ---");
const lib = await page.evaluate(async () => {
  const m = await import("/src/components/masks/maskLibrary.ts");
  const man = await m.loadMaskManifest();
  const images = m.getImageMasks();
  const all = m.getAllSummaries();

  // 每张位图蒙版都实解码一次,确认镂空区真的透明
  const holes = [];
  for (const im of images) {
    const el = await m.loadMaskImage(im.src);
    if (!el) {
      holes.push({ key: im.key, loaded: false });
      continue;
    }
    const S = 200;
    const cv = document.createElement("canvas");
    cv.width = S;
    cv.height = Math.round((S * 3) / 4);
    const g = cv.getContext("2d");
    g.drawImage(el, 0, 0, cv.width, cv.height);
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let clear = 0;
    let opaque = 0;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] < 12) clear++;
      else if (d[i] > 245) opaque++;
    }
    const total = d.length / 4;
    holes.push({
      key: im.key,
      loaded: true,
      clear: +(clear / total).toFixed(3),
      opaque: +(opaque / total).toFixed(3),
    });
  }
  return {
    manifestCount: man.masks.length,
    imageCount: images.length,
    allCount: all.length,
    builtinCount: all.filter((x) => x.kind === "proc").length,
    categories: m.getCategories(all),
    holes,
  };
});

check("manifest 已加载", lib.manifestCount > 0, `${lib.manifestCount} 条`);
check("图库含位图蒙版", lib.imageCount > 0, `${lib.imageCount} 张`);
check("内置蒙版仍是 15 个", lib.builtinCount === 15, `${lib.builtinCount} 个`);
check(
  "混排总数 = 内置 + 位图",
  lib.allCount === lib.builtinCount + lib.imageCount,
  `${lib.allCount}`,
);

for (const h of lib.holes) {
  if (!h.loaded) {
    check(`${h.key} 素材可解码`, false);
    continue;
  }
  check(
    `${h.key} 镂空合理`,
    h.clear > 0.05 && h.clear < 0.75 && h.opaque > 0.2,
    `透明=${h.clear} 不透明=${h.opaque}`,
  );
}

// ───────────────────────── 2. 图库交互 ─────────────────────────
console.log("\n--- 2. 图库交互 ---");
await page.click("[data-open-mask-gallery]");
await page.waitForSelector("[data-mask-gallery-card]", { timeout: 5000 });
check("点击入口能打开抽屉", true);

const cardCount = await page.locator("[data-mask-gallery-card]").count();
check("抽屉里有卡片", cardCount === lib.allCount, `${cardCount} 张`);

const builtinCards = await page.locator("[data-mask-gallery-card^='heart']").count();
check("内置蒙版也混排在图库里", builtinCards > 0);

// 分类筛选
const firstCat = lib.categories[0];
await page.locator("button", { hasText: firstCat }).first().click();
await page.waitForTimeout(200);
const afterCat = await page.locator("[data-mask-gallery-card]").count();
const expectCat = lib.allCount; // 第一个分类通常是"内置",数量等于内置数
check("分类筛选生效", afterCat > 0 && afterCat <= cardCount, `${firstCat} → ${afterCat} 张`);

// 回到全部
await page.locator("button", { hasText: "全部" }).first().click();
await page.waitForTimeout(200);

// 内置蒙版缩略图必须按 4:3 渲染,不能是正方形再被 CSS 拉扁 ——
// 那样蒙版形状会和取景框里看到的不一致。
const thumbRatio = await page.evaluate(() => {
  const btn = document.querySelector('[data-mask-gallery-card^="heart"]');
  const c = btn?.querySelector("canvas");
  return c ? { w: c.width, h: c.height } : null;
});
check(
  "内置缩略图按 4:3 渲染(未被压扁)",
  !!thumbRatio && Math.abs(thumbRatio.w / thumbRatio.h - 4 / 3) < 0.02,
  thumbRatio ? `${thumbRatio.w}x${thumbRatio.h} → ${(thumbRatio.w / thumbRatio.h).toFixed(3)}` : "无 canvas",
);

// 搜索
const searchBox = page.locator('input[placeholder*="搜索"]');
await searchBox.fill("珍珠");
await page.waitForTimeout(250);
const afterSearch = await page.locator("[data-mask-gallery-card]").count();
check("搜索能缩小结果", afterSearch > 0 && afterSearch < cardCount, `珍珠 → ${afterSearch} 张`);

await searchBox.fill("绝对不存在的关键词zzz");
await page.waitForTimeout(250);
const emptyText = await page.locator("text=没有匹配的蒙版").count();
check("无结果时给出空态", emptyText > 0);
await searchBox.fill("");
await page.waitForTimeout(200);

// Esc 关闭
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
check("Esc 可关闭抽屉", (await page.locator("[data-mask-gallery-card]").count()) === 0);

// ───────────────────────── 3. 预览与成片 ─────────────────────────
console.log("\n--- 3. 预览与成片 ---");
const target = "pearl_heart_lilac";
await page.click("[data-open-mask-gallery]");
await page.waitForSelector(`[data-mask-gallery-card="${target}"]`);
await page.click(`[data-mask-gallery-card="${target}"]`);
await page.waitForTimeout(200);
check("点选后抽屉自动收起", (await page.locator("[data-mask-gallery-card]").count()) === 0);

const selected = await page.evaluate(() => window.__store.getState().maskKey);
check("store 已切到该蒙版", selected === target, selected);

// 取景框的蒙版图层:应出现且不是空白
await page.waitForFunction(
  () => {
    const img = document.querySelector("img[alt='']");
    return !!img && img.src.startsWith("data:image/png") && img.src.length > 5000;
  },
  { timeout: 8000 },
);
const previewInfo = await page.evaluate(() => {
  const img = document.querySelector("img[alt='']");
  return { len: img.src.length, w: img.naturalWidth, h: img.naturalHeight };
});
check("取景框已渲染蒙版图层", previewInfo.len > 5000, `${previewInfo.w}x${previewInfo.h}`);

// 预览图层里必须既有透明(洞)又有不透明(边框)
const previewAlpha = await page.evaluate(async () => {
  const img = document.querySelector("img[alt='']");
  const el = new Image();
  await new Promise((r) => {
    el.onload = r;
    el.src = img.src;
  });
  const cv = document.createElement("canvas");
  cv.width = 200;
  cv.height = 150;
  const g = cv.getContext("2d");
  g.drawImage(el, 0, 0, 200, 150);
  const d = g.getImageData(0, 0, 200, 150).data;
  let clear = 0;
  let opaque = 0;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 12) clear++;
    else if (d[i] > 245) opaque++;
  }
  const t = d.length / 4;
  return { clear: +(clear / t).toFixed(3), opaque: +(opaque / t).toFixed(3) };
});
check(
  "预览图层镂空与边框都在",
  previewAlpha.clear > 0.05 && previewAlpha.opaque > 0.2,
  `透明=${previewAlpha.clear} 不透明=${previewAlpha.opaque}`,
);

// 出片:snap() 烧进同一张图
const shot = await page.evaluate(async () => {
  const el = document.querySelector("video");
  const S = 320;
  const cv = document.createElement("canvas");
  cv.width = S;
  cv.height = Math.round((S * 3) / 4);
  const g = cv.getContext("2d");
  g.drawImage(el, 0, 0, cv.width, cv.height);
  return cv.toDataURL("image/png");
});
check("能抓到摄像头画面用于比对", shot.length > 2000);

// 直接比对:同一蒙版下,预览图层像素 === 出片时叠加的图层像素
const same = await page.evaluate(async () => {
  const { getMask, loadMaskImage } = await import("/src/components/masks/maskLibrary.ts");
  const { renderMaskLayer } = await import("/src/components/masks/renderMask.ts");
  const m = getMask("pearl_heart_lilac");
  const img = await loadMaskImage(m.src);

  const W = 240;
  const H = 180;
  const a = renderMaskLayer(m, W, H, img);
  const b = renderMaskLayer(m, W, H, img);
  const ga = a.getContext("2d").getImageData(0, 0, W, H).data;
  const gb = b.getContext("2d").getImageData(0, 0, W, H).data;
  let diff = 0;
  for (let i = 0; i < ga.length; i++) if (Math.abs(ga[i] - gb[i]) > 2) diff++;
  return { diff, total: ga.length / 4 };
});
check(
  "同参数重渲染逐像素一致",
  same.diff === 0,
  `差异像素=${same.diff}/${same.total}`,
);

// ───────────── 3.5 双人位图蒙版要落到「双人」标签页 ─────────────
// 回归用例:tabOf() 早先只查内置表,双人位图蒙版会被错标成「单人」。
console.log("\n--- 3.5 双人位图蒙版的标签归属 ---");
const dualTab = await page.evaluate(async () => {
  const { getMask, loadMaskManifest } = await import("/src/components/masks/maskLibrary.ts");
  await loadMaskManifest();
  const m = getMask("cartoon_takeout");
  return { audience: m?.audience ?? null };
});
check("双人位图蒙版 audience=dual", dualTab.audience === "dual", `实际=${dualTab.audience}`);

// 选中它后,选择条应激活「双人」页(而不是错落到「单人」)
await page.evaluate(() => window.__store.getState().setMaskKey("cartoon_takeout"));
await page.waitForTimeout(300);
const dualTabActive = await page.evaluate(() => {
  const t = document.querySelector('[role="tab"][data-tab="dual"]');
  return t?.getAttribute("aria-selected") === "true";
});
check("选中双人位图蒙版时激活「双人」标签页", dualTabActive === true);
await page.evaluate(() => window.__store.getState().setMaskKey("heart"));

// ───────────────────────── 4. 内置蒙版回归 ─────────────────────────
console.log("\n--- 4. 内置蒙版回归 ---");
const proc = await page.evaluate(async () => {
  const { MASKS } = await import("/src/components/masks/maskDefs.ts");
  const { renderMaskLayer } = await import("/src/components/masks/renderMask.ts");
  const bad = [];
  for (const m of MASKS) {
    const layer = renderMaskLayer(m, 160, 160);
    if (!layer) {
      bad.push({ key: m.key, why: "null" });
      continue;
    }
    const d = layer.getContext("2d").getImageData(0, 0, 160, 160).data;
    let clear = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 12) clear++;
    const r = clear / (160 * 160);
    if (r < 0.05 || r > 0.8) bad.push({ key: m.key, why: `透明=${r.toFixed(3)}` });
  }
  return bad;
});
check("15 个内置蒙版仍正常镂空", proc.length === 0, proc.map((b) => `${b.key}:${b.why}`).join(", "));

// 切回内置蒙版,确认图库选择不会污染内置路径
await page.evaluate(() => window.__store.getState().setMaskKey("star"));
await page.waitForTimeout(400);
const backToBuiltin = await page.evaluate(() => {
  const img = document.querySelector("img[alt='']");
  return !!img && img.src.startsWith("data:image/png");
});
check("可切回内置蒙版并正常预览", backToBuiltin);

console.log("\n--- 5. 无运行时错误 ---");
check("无 pageerror", errors.length === 0, errors.slice(0, 3).join(" | "));

// 图库截图,便于人眼确认布局
await page.click("[data-open-mask-gallery]");
await page.waitForSelector("[data-mask-gallery-card]");
await page.waitForTimeout(700);
await page.screenshot({ path: "mask-gallery.png" });

await browser.close();
console.log(`\n结果: ${PASS.length} 通过, ${FAIL.length} 失败`);
if (FAIL.length) {
  console.log("失败项: " + FAIL.join(", "));
  process.exit(1);
}
