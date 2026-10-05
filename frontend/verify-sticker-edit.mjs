/**
 * 贴纸自由编排端到端验证。
 *
 * 与 verify-doodle-burn.mjs 同源的设计: 输入是纯灰帧(128,128,128), 任何
 * 「彩色像素」都只可能来自贴纸或图层烧录链路, 不可能是画面或后端算子带
 * 出来的。所以这条链 "用户摆贴纸 -> store.stickerOverrides -> doLayout 里
 * burnStickers -> JPEG 重编码 -> /api/layout/make -> 拼图像素" 一旦漏掉
 * 任何一环, 这里都会红。
 *
 * 与涂鸦脚本不同的地方:
 *   - 涂鸦是「笔迹」(连续 path), 用"一条蓝色行"区分"零星蓝噪点"。贴纸是
 *     「纯色区域」, 用"红色块像素数"区分"涂鸦时和贴纸时都有的零星压缩噪点"。
 *   - 涂鸦验证"宽度"靠 aMaxRow, 贴纸验证"块"靠两个轴向上的总像素。
 *   - 涂鸦的命中测试是中心矩形, 贴纸的命中测试也是中心矩形
 *     (见 StickerEditor.hitTest)。但形状(星/花)中心是空的, 用最小包围矩
 *     的中心矩形点远 "近在中心点不动也能拖", 这正是它被选中的原因 —— 这条
 *     性质被「拖动后坐标改变」的断言钉死。
 *   - 涂鸦侧「安全区」用 4 块 band; 贴纸侧额外验「2x2 横向 + 6inch_4p 上下」
 *     动态切换, 把"复用 doodleSafeArea"这条不变量也写死成回归。
 *
 * 第三个用例专门画到 x=0.05(2x2 的 cover 保留窗口 0.217 之外), 断言成片
 * 该区没有该颜色 —— 把"贴纸会被静默裁掉"的事实钉成回归, 免得有人以为
 * "贴纸可以贴到任何地方"。
 */
import { chromium } from "playwright";

const URL_BASE = process.env.APP_URL || "http://localhost:5173";
const PASS = [];
const FAIL = [];
const check = (n, c, d = "") => {
  (c ? PASS : FAIL).push(n);
  console.log(`  [${c ? "PASS" : "FAIL"}] ${n} ${d}`);
};

/** 红/黄/蓝 三种纯色签名(对应 STICKER_COLORS 头三色)。 */
const RED = "#ff3b30"; // rgb(255,59,48)
const YELLOW = "#facc15"; // rgb(250,204,21)
const BLUE = "#3b6cff"; // rgb(59,108,255)
/** 输入底色 128(灰)。 */
const GRAY = 128;
/**
 * 一颗新贴纸 size=0.16、短边基准, 出片后约 0.16 * 960 ≈ 154 px,
 * 占一张 615x815 cell 的 ~19% 宽。块像素下限阈值 400: 星形 (~70% 填充率)
 * 仍能有 ~1.5 万 px, 阈值留 400 把"几何参数没改"和"贴纸完全没烧"分开。
 */
const MIN_SOLID = 400;

const browser = await chromium.launch({
  channel: "chrome",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
  permissions: ["camera"],
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// ---------------------------------------------------------------------------
// 页面内公用工具
// ---------------------------------------------------------------------------
const HELPERS = `
  window.__mkGray = (w, h, v) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = "rgb(" + v + "," + v + "," + v + ")";
    g.fillRect(0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.92);
  };

  /**
   * 扫描拼图, 统计红/黄/蓝三种颜色块的像素数与位置。
   * 颜色签名: 用 R/G/B 三通道的「差值」而不是固定阈值, 抗 JPEG 压缩。
   *   red    = R 高且 G/B 低
   *   yellow = R/G 高且 B 低
   *   blue   = B 高且 R/G 低
   * 返回: { w, h, total, redN, yellowN, blueN } 与各色块「最大连通区域中心」。
   */
  window.__scanColors = async (u) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = u; });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const isRed = (i) => d[i] > 200 && d[i + 1] < 110 && d[i + 2] < 90;
    const isYellow = (i) => d[i] > 200 && d[i + 1] > 160 && d[i + 2] < 90;
    const isBlue = (i) => d[i + 2] > 200 && d[i] < 110 && d[i + 1] < 130;
    let total = 0, redN = 0, yellowN = 0, blueN = 0;
    let redX = 0, redY = 0, yellowX = 0, yellowY = 0, blueX = 0, blueY = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (isRed(i)) { redN++; redX += x; redY += y; total++; }
        if (isYellow(i)) { yellowN++; yellowX += x; yellowY += y; total++; }
        if (isBlue(i)) { blueN++; blueX += x; blueY += y; total++; }
      }
    }
    const centroid = (n, sx, sy) => (n ? [sx / n / c.width, sy / n / c.height] : [-1, -1]);
    return {
      w: c.width, h: c.height, total,
      redN, yellowN, blueN,
      redCentroid: centroid(redN, redX, redY),
      yellowCentroid: centroid(yellowN, yellowX, yellowY),
      blueCentroid: centroid(blueN, blueX, blueY),
    };
  };
`;

// ---------------------------------------------------------------------------
// §1. 注入灰帧 + 验证侧栏贴纸面板就位
// ---------------------------------------------------------------------------
console.log("\n--- 1. 注入 4 张灰帧, 贴纸面板就位 ---");
await page.goto(`${URL_BASE}/decorate`, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.__store, { timeout: 15000 });
await page.evaluate(HELPERS);

const injected = await page.evaluate((gray) => {
  const frames = Array.from({ length: 4 }, () => ({
    url: window.__mkGray(1280, 960, gray),
    burnedIn: true,
  }));
  window.__store.getState().setFrames(frames);
  const s = window.__store.getState();
  return { count: s.frames.length, burnedIn: s.frames[0]?.burnedIn };
}, GRAY);
check("store 内已注入 4 张灰帧", injected.count === 4, `${injected.count} 张`);
check(
  "灰帧标记 burnedIn=true(不额外叠滤镜)",
  injected.burnedIn === true,
  `burnedIn=${injected.burnedIn}`,
);
await page.locator("[data-doodle-thumb]").first().waitFor({ state: "visible", timeout: 15000 });

// 侧栏贴纸面板: 标题「贴纸」+「共 N 个」计数 + (editingIdx===null 时) 无「清空」按钮。
const panel = await page.evaluate(() => {
  const title = [...document.querySelectorAll("div")].find(
    (d) => d.children.length === 0 && d.textContent.trim() === "贴纸",
  );
  const card = title?.closest("div.rounded-2xl");
  return {
    found: !!card,
    count: card?.querySelector("[data-sticker-count]")?.textContent.trim() ?? "",
    hasClear: !!card?.querySelector("[data-sticker-clear]"),
  };
});
check("贴纸面板已渲染", panel.found);
check("初始显示「共 0 个」", panel.count.includes("共 0 个"), panel.count);
check("未进编辑时无「清空」按钮", !panel.hasClear);

// ---------------------------------------------------------------------------
// §2. 基线: 不摆贴纸时成片没有任何红/黄/蓝色块
// ---------------------------------------------------------------------------
console.log("\n--- 2. 基线: 没贴纸时成片里不该有任何彩色块 ---");
const genBtn = page.getByRole("button", { name: "生成拼图" });
await genBtn.waitFor({ state: "visible", timeout: 15000 });
await genBtn.click();
await page.waitForFunction(
  () => {
    const u = window.__store?.getState().layoutUrl;
    return typeof u === "string" && u.length > 0;
  },
  { timeout: 120000 },
);
const baseUrl = await page.evaluate(() => window.__store.getState().layoutUrl);
const base = await page.evaluate((u) => window.__scanColors(u), baseUrl);
console.log(
  `         基线拼图 ${base.w}x${base.h}  红 ${base.redN} 黄 ${base.yellowN} 蓝 ${base.blueN}`,
);
check("基线拼图尺寸为 1320x1800", base.w === 1320 && base.h === 1800, `${base.w}x${base.h}`);
check("未贴时无红色块", base.redN === 0, `红 ${base.redN}px`);
check("未贴时无黄色块", base.yellowN === 0, `黄 ${base.yellowN}px`);
check("未贴时无蓝色块", base.blueN === 0, `蓝 ${base.blueN}px`);

// ---------------------------------------------------------------------------
// §3. 进编辑模态 -> 切到「贴纸」tab -> 选形状 -> 点画布落点 -> 三色各一颗
// ---------------------------------------------------------------------------
console.log("\n--- 3. 进编辑模态, 在「贴纸」tab 摆三色 ---");
check(
  "初始 store.stickerOverrides 为空",
  (await page.evaluate(() => Object.keys(window.__store.getState().stickerOverrides).length)) === 0,
);

await page.locator("[data-doodle-thumb='0']").click();
await page.locator("[data-edit-modal]").waitFor({ state: "visible", timeout: 10000 });

// tab 切换必须存在: 「涂鸦」默认选中, 「贴纸」可点击。点切到贴纸。
const tabs = await page.evaluate(() => {
  const list = [...document.querySelectorAll("[data-edit-tab]")];
  return list.map((b) => ({
    key: b.getAttribute("data-edit-tab"),
    pressed: b.getAttribute("aria-pressed"),
    text: b.textContent.trim(),
  }));
});
check("编辑模态含两个 tab", tabs.length === 2, `共 ${tabs.length} 个`);
check("涂鸦 tab 默认选中", tabs[0]?.key === "doodle" && tabs[0]?.pressed === "true", tabs[0]?.text);
check("贴纸 tab 默认未选", tabs[1]?.key === "sticker" && tabs[1]?.pressed === "false", tabs[1]?.text);

// 切到贴纸 tab, StickerEditor 应出现(data-sticker-canvas 是它独有的钩子)。
await page.locator("[data-edit-tab='sticker']").click();
const stickerCanvas = page.locator("[data-sticker-canvas]");
await stickerCanvas.waitFor({ state: "visible", timeout: 10000 });
check("切到「贴纸」tab 后 StickerEditor 渲染", await stickerCanvas.isVisible());
// 涂鸦侧此时不应再有画布 —— 否则就是 "切了 tab 两层都还活着",
// 用户会被画布叠加的视觉效果误导。
check(
  "切到「贴纸」tab 后 DoodleCanvas 不再渲染",
  (await page.locator("[data-doodle-canvas]").count()) === 0,
);

const stickerTools = await page.evaluate(() => {
  const tools = [...document.querySelectorAll("[data-sticker-tool]")];
  const shapes = [...document.querySelectorAll("[data-sticker-shape]")];
  const colors = [...document.querySelectorAll("[data-sticker-color]")];
  return {
    select: !!tools.find((t) => t.getAttribute("data-sticker-tool") === "select"),
    shapes: shapes.map((s) => s.getAttribute("data-sticker-shape")),
    colorCount: colors.length,
  };
});
check("「拖动」按钮存在", stickerTools.select);
check(
  "形状按钮至少 7 种(与 STICKER_SHAPE_KEYS 一致)",
  stickerTools.shapes.length >= 7,
  `${stickerTools.shapes.length} 种`,
);
check("色板共 7 色(与 STICKER_COLORS 一致)", stickerTools.colorCount === 7, `${stickerTools.colorCount} 色`);

const stickerBox = await stickerCanvas.boundingBox();
const at = (rx, ry) => ({ x: stickerBox.x + rx * stickerBox.width, y: stickerBox.y + ry * stickerBox.height });

/**
 * 选形状 + 选色 -> 点画布落点 -> 在 store 中确认多了一颗。
 *
 * 关键时序: 必须先点「拖动」+点空白处**取消选中**, 再选颜色 —— 颜色按钮
 * 同时调 setColor 与 recolorSelected, 若上一次 place 后留有 selected, 点
 * 颜色会改掉刚摆好的那颗, 而**不是**只更新「下一颗要用的色」。这是
 * StickerEditor 的设计("改色只改选中的那颗")与"先选色再点号落点"两者
 * 互相不打架, 但需要测试代码主动清理 selected。
 */
async function place(shape, color, rx, ry) {
  // 1. 切到 select 工具, 然后点画布空白处让 hitTest 返回 -1。
  //    重新读一次 boundingBox —— 模态可能因为重打开而位置变了, 老坐标会落
  //    在画布外, hitTest 全部返回 -1, 后续 setSelected(-1) 就把刚刚摆的
  //    贴纸给"取消选中"了, 表现成"点了空地"。
  const cb = await page.locator("[data-sticker-canvas]").boundingBox();
  if (!cb) throw new Error("sticker canvas 不存在");
  const a = (xx, yy) => ({ x: cb.x + xx * cb.width, y: cb.y + yy * cb.height });
  await page.locator("[data-sticker-tool='select']").click();
  await page.mouse.click(a(0.01, 0.01).x, a(0.01, 0.01).y);
  await page.waitForTimeout(40);
  // 2. 选形状 -> 选色 -> 落点。
  await page.locator(`[data-sticker-shape='${shape}']`).click();
  await page.locator(`[data-sticker-color='${color}']`).click();
  const before = await page.evaluate(() => window.__store.getState().stickerOverrides[0]?.length ?? 0);
  await page.mouse.click(a(rx, ry).x, a(rx, ry).y);
  await page.waitForTimeout(80);
  const after = await page.evaluate(() => window.__store.getState().stickerOverrides[0]?.length ?? 0);
  return { before, after };
}

// 第一颗: 红色「爱心」, 落在 2x2 cover 保留窗口 0.217~0.784 内, y=0.3 上半部。
const p1 = await place("heart", RED, 0.45, 0.30);
check("第一颗贴纸进 store", p1.after === p1.before + 1, `${p1.before} -> ${p1.after}`);

// 第二颗: 黄色「星星」, y=0.5 中部。
const p2 = await place("star", YELLOW, 0.55, 0.50);
check("第二颗贴纸进 store", p2.after === p2.before + 1, `${p2.before} -> ${p2.after}`);

// 第三颗: 蓝色「圆点」, y=0.7 下半部。
const p3 = await place("circle", BLUE, 0.40, 0.70);
check("第三颗贴纸进 store", p3.after === p3.before + 1, `${p3.before} -> ${p3.after}`);

const placed = await page.evaluate(() => {
  const list = window.__store.getState().stickerOverrides[0] ?? [];
  return {
    n: list.length,
    shapes: list.map((s) => s.shape),
    fills: list.map((s) => s.fill),
    xs: list.map((s) => s.x),
    ys: list.map((s) => s.y),
    inUnit: list.every(
      (s) => s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1 && s.size > 0 && s.size <= 1,
    ),
    shapesDistinct: new Set(list.map((s) => s.shape)).size === list.length,
  };
});
check("store 内共 3 颗贴纸", placed.n === 3, `${placed.n} 颗`);
check(
  "三颗形状分别为 heart / star / circle",
  placed.shapes.join(",") === "heart,star,circle",
  placed.shapes.join(","),
);
check(
  "三颗填充色分别为 红 / 黄 / 蓝",
  placed.fills.join(",") === `${RED},${YELLOW},${BLUE}`,
  placed.fills.join(","),
);
check("坐标全部落在 0..1(相对坐标契约)", placed.inUnit === true);
// 三颗位置要拉开: 心 y=0.30、星 y=0.50、圆 y=0.70; x 各不相同。心 vs 圆同
// 在 x=0.40~0.45 但 y 差 0.4, 拼图里能拉到不同 cell 区, 颜色块不重叠。
check(
  "三颗贴纸 y 坐标依次拉开(0.30/0.50/0.70)",
  placed.ys[0] < placed.ys[1] && placed.ys[1] < placed.ys[2],
  `y=[${placed.ys.map((v) => v.toFixed(2)).join(",")}]`,
);
check("三颗形状互不相同", placed.shapesDistinct);

// UI 角标: 侧栏计数 + 缩略图角标 + 模态 tab 上的「N」。
const sidebarCount = await page
  .locator("[data-sticker-scope='sidebar'] [data-sticker-count]")
  .textContent();
check("侧栏贴纸计数为「共 3 个」", (sidebarCount ?? "").includes("共 3 个"), sidebarCount ?? "(无)");

const thumbBadge = await page.locator("[data-sticker-badge='0']").textContent();
check("缩略图出现「N 贴」角标", (thumbBadge ?? "").includes("3 贴"), thumbBadge ?? "(无)");

const tabText = await page.locator("[data-edit-tab='sticker']").textContent();
check("贴纸 tab 显示计数「3」", (tabText ?? "").includes("3"), tabText ?? "(无)");

// ---------------------------------------------------------------------------
// §4. 拖动: 第二颗从 y=0.50 拖到 y=0.60, 验证中心矩形命中 + 拖动后坐标真变
// ---------------------------------------------------------------------------
console.log("\n--- 4. 拖动第二颗贴纸, 验证中心矩形命中 ---");
// 切到「拖动」工具。
await page.locator("[data-sticker-tool='select']").click();
// 从 (0.55, 0.50) 拖到 (0.55, 0.60)。拖动期间每 ~16ms 都进 store,
// 不能用 mouse.click 完成。
const start = at(0.55, 0.50);
const end = at(0.55, 0.60);
await page.mouse.move(start.x, start.y);
await page.mouse.down();
const steps = 10;
for (let i = 1; i <= steps; i++) {
  const t = i / steps;
  await page.mouse.move(start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t);
  await page.waitForTimeout(20);
}
await page.mouse.up();
await page.waitForTimeout(80);

const after = await page.evaluate(() => {
  const list = window.__store.getState().stickerOverrides[0] ?? [];
  return {
    n: list.length,
    ys: list.map((s) => s.y),
  };
});
check("拖动后贴纸数仍为 3", after.n === 3, `${after.n} 颗`);
check(
  "第二颗 y 坐标明显下移(中心矩形命中 + 拖动生效)",
  after.ys[1] > 0.55,
  `新 y=${after.ys[1].toFixed(3)}`,
);

// ---------------------------------------------------------------------------
// §5. 重新生成拼图, 红/黄/蓝色块必须真的烧进成片
// ---------------------------------------------------------------------------
// 必须在 §6 (Delete) 之前做, 否则删完就只剩红色了 —— §5 验的是 "三色各一颗
// 烧进成片", 需要三颗在 store 里同时存在。
console.log("\n--- 5. 重新生成拼图, 三色块像素必须出现 ---");
await page.locator("[data-edit-modal] button", { hasText: "完成" }).click();
check("「完成」关闭模态", (await page.locator("[data-edit-modal]").count()) === 0);

const beforeUrl = await page.evaluate(() => window.__store.getState().layoutUrl);
await genBtn.click();
await page.waitForFunction(
  (p) => {
    const u = window.__store?.getState().layoutUrl;
    return typeof u === "string" && u.length > 0 && u !== p;
  },
  beforeUrl,
  { timeout: 120000 },
);
const drawnUrl = await page.evaluate(() => window.__store.getState().layoutUrl);
const shot = await page.evaluate((u) => window.__scanColors(u), drawnUrl);
console.log(
  `         贴纸拼图 ${shot.w}x${shot.h}  ` +
    `红 ${shot.redN}px (心形 centroid ${shot.redCentroid.map((v) => v.toFixed(3)).join(",")})  ` +
    `黄 ${shot.yellowN}px (星形 centroid ${shot.yellowCentroid.map((v) => v.toFixed(3)).join(",")})  ` +
    `蓝 ${shot.blueN}px (圆 centroid ${shot.blueCentroid.map((v) => v.toFixed(3)).join(",")})`,
);

check(
  "成片出现红色块像素(爱心)",
  shot.redN >= MIN_SOLID,
  `红 ${shot.redN}px (阈值 ≥${MIN_SOLID})`,
);
check(
  "成片出现黄色块像素(星星)",
  shot.yellowN >= MIN_SOLID,
  `黄 ${shot.yellowN}px (阈值 ≥${MIN_SOLID})`,
);
check(
  "成片出现蓝色块像素(圆点)",
  shot.blueN >= MIN_SOLID,
  `蓝 ${shot.blueN}px (阈值 ≥${MIN_SOLID})`,
);
// 块的位置 centroid 应相对下方也算上中下三段(对应三颗 y=0.30/0.50/0.70)。
// 注: 拼图是 1320x1800, cell(0,0) 占照片 y∈[0,1] 在 cell 内相对位置经 cover
// 不裁上下(2x2 cell 0.755 < 照片 1.333, 横向裁, 纵向不裁), 所以三颗 centroid
// 的相对 y 排序应与原 y 一致: 红 < 黄 < 蓝。
const sortY = [shot.redCentroid[1], shot.yellowCentroid[1], shot.blueCentroid[1]];
check(
  "块像素 y 顺序与贴纸 y 一致(红在上 / 黄中 / 蓝下)",
  sortY[0] < sortY[1] && sortY[1] < sortY[2],
  `y=[${sortY.map((v) => v.toFixed(3)).join(",")}]`,
);

// ---------------------------------------------------------------------------
// §6. 键盘 Delete / Backspace 删除贴纸(在 §5 之后做, 不影响成片验证)
// ---------------------------------------------------------------------------
console.log("\n--- 6. 键盘 Delete / Backspace 删除贴纸 ---");
// §5 已关模态, 这里重新打开并切到贴纸 tab。
await page.locator("[data-doodle-thumb='0']").click();
await page.locator("[data-edit-modal]").waitFor({ state: "visible", timeout: 10000 });
await page.locator("[data-edit-tab='sticker']").click();
await page.locator("[data-sticker-canvas]").waitFor({ state: "visible", timeout: 10000 });
// 重新拿一次 boundingBox, 因为视口位置在重打开后变了。
const stickerBox6 = await page.locator("[data-sticker-canvas]").boundingBox();
const at6 = (rx, ry) => ({ x: stickerBox6.x + rx * stickerBox6.width, y: stickerBox6.y + ry * stickerBox6.height });
// 选中第三颗(圆): 点一下选中, 不能用拖动(会改坐标)。
// 命中测试是「中心矩形」, y=0.72(原本 0.70, §3 测得 y=0.72), x=0.40 正是它的中心。
await page.mouse.click(at6(0.40, 0.72).x, at6(0.40, 0.72).y);
await page.waitForTimeout(60);
const selBefore = await page.evaluate(() => {
  // 不暴露 selected state, 间接证明: 选中后工具条出现「删除」按钮。
  return !!document.querySelector("[data-sticker-delete]");
});
check("点中心矩形可命中并选中第三颗", selBefore);

await page.keyboard.press("Delete");
await page.waitForTimeout(60);
const afterDel = await page.evaluate(
  () => (window.__store.getState().stickerOverrides[0] ?? []).length,
);
check("Delete 删除选中的贴纸", afterDel === 2, `剩 ${afterDel} 颗`);
// Backspace 也得删 —— 点在第二颗(星星被拖到 y=0.616)中心, 命中选中后按 Backspace。
await page.mouse.click(at6(0.55, 0.616).x, at6(0.55, 0.616).y);
await page.waitForTimeout(60);
await page.keyboard.press("Backspace");
await page.waitForTimeout(60);
const afterBs = await page.evaluate(
  () => (window.__store.getState().stickerOverrides[0] ?? []).length,
);
check("Backspace 也能删除", afterBs === 1, `剩 ${afterBs} 颗`);

// 输入框内不拦截: 模拟一个 input 元素并聚焦, Backspace 应当不删贴纸。
// 这里只验「键盘监听不删贴纸」, 真实 input 由 React 控制, 这里换用 dispatch
// keydown 到一个普通 input 元素: 监听挂的是 window, 它接收事件后再判断
// target, 于是模拟出一个 contenteditable 的 input 即可。
await page.evaluate(() => {
  const el = document.createElement("input");
  el.id = "__sticker_test_input";
  el.value = "abc";
  document.body.appendChild(el);
  el.focus();
});
// 先把第二颗再摆上, 否则删完就空了。沿用默认红色。
const p4 = await place("heart", RED, 0.65, 0.65);
check("删除过程中又摆了一颗", p4.after === p4.before + 1, `${p4.before} -> ${p4.after}`);
await page.evaluate(() => {
  const input = document.getElementById("__sticker_test_input");
  const ev = new KeyboardEvent("keydown", { key: "Backspace", cancelable: true });
  input.dispatchEvent(ev);
});
await page.waitForTimeout(40);
const stillThere = await page.evaluate(
  () => (window.__store.getState().stickerOverrides[0] ?? []).length,
);
check(
  "输入框内 Backspace 不删贴纸(拦截函数识别 target)",
  stillThere >= 2,
  `仍 ${stillThere} 颗`,
);
await page.evaluate(() => document.getElementById("__sticker_test_input")?.remove());

// §6 末关模态 —— §7 要再开, 留着会让点缩略图被遮罩拦截。
await page.locator("[data-edit-modal] button", { hasText: "完成" }).click();
check("§6 末「完成」关闭模态", (await page.locator("[data-edit-modal]").count()) === 0);

// ---------------------------------------------------------------------------
// §7. 安全区按排版切换: 2x2 横向, 6inch_4p 上下
// ---------------------------------------------------------------------------
console.log("\n--- 7. 安全区按排版实拍切换(2x2 横向 vs 6inch_4p 上下) ---");
await page.locator("[data-doodle-thumb='0']").click();
await page.locator("[data-edit-modal]").waitFor({ state: "visible", timeout: 10000 });
// 切回贴纸 tab 以让 data-sticker-safe 遮罩存在。
await page.locator("[data-edit-tab='sticker']").click();
await page.locator("[data-sticker-canvas]").waitFor({ state: "visible", timeout: 10000 });

// 2x2: cell 0.7546 < 照片 1.333 -> 裁左右, 不裁上下。
await page.evaluate(() => window.__store.getState().setLayout("2x2"));
await page.waitForTimeout(300);
const safe2x2 = await page.evaluate(() => {
  const box = (side) => {
    const el = document.querySelector(`[data-sticker-safe='${side}']`);
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return side === "top" || side === "bottom" ? r.height : r.width;
  };
  const c = document.querySelector("[data-sticker-canvas]")?.getBoundingClientRect();
  return {
    left: box("left"), right: box("right"), top: box("top"), bottom: box("bottom"),
    cw: c?.width ?? 0, ch: c?.height ?? 0,
  };
});
check(
  "2x2 下左右有安全区(裁左右)",
  safe2x2.left > 0 && safe2x2.right > 0,
  `L=${safe2x2.left.toFixed(1)} R=${safe2x2.right.toFixed(1)}`,
);
check(
  "2x2 左右安全区约为画布宽的 21.7%",
  Math.abs(safe2x2.left / safe2x2.cw - 0.217) < 0.02,
  `${(safe2x2.left / safe2x2.cw * 100).toFixed(1)}%`,
);
check(
  "2x2 不裁上下, 故无上下遮罩",
  safe2x2.top === 0 && safe2x2.bottom === 0,
  `T=${safe2x2.top} B=${safe2x2.bottom}`,
);

// 6inch_4p: cell 1.6988 > 照片 1.333 -> 裁上下, 不裁左右。
await page.evaluate(() => window.__store.getState().setLayout("6inch_4p"));
await page.waitForTimeout(300);
const safe6 = await page.evaluate(() => {
  const box = (side) => {
    const el = document.querySelector(`[data-sticker-safe='${side}']`);
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return side === "top" || side === "bottom" ? r.height : r.width;
  };
  const c = document.querySelector("[data-sticker-canvas]")?.getBoundingClientRect();
  return {
    left: box("left"), right: box("right"), top: box("top"), bottom: box("bottom"),
    cw: c?.width ?? 0, ch: c?.height ?? 0,
  };
});
check(
  "6inch_4p 下左右不再有遮罩(不裁左右)",
  safe6.left === 0 && safe6.right === 0,
  `L=${safe6.left} R=${safe6.right}`,
);
check(
  "6inch_4p 下出现上下遮罩(裁上下)",
  safe6.top > 0 && safe6.bottom > 0,
  `T=${safe6.top.toFixed(1)} B=${safe6.bottom.toFixed(1)}`,
);
check(
  "上遮罩约为画布高的 2.8%, 下遮罩约为 18.8%",
  Math.abs(safe6.top / safe6.ch - 0.028) < 0.02 &&
    Math.abs(safe6.bottom / safe6.ch - 0.188) < 0.02,
  `T=${(safe6.top / safe6.ch * 100).toFixed(1)}% B=${(safe6.bottom / safe6.ch * 100).toFixed(1)}%`,
);

// 文案必须如实反映安全区: 6inch_4p 排版下应当提「上」/「下」而不提「左」/「右」。
const copy6 = await page.locator("[data-sticker-safe-text]").textContent();
check("6inch_4p 贴纸文案不再提「两侧」", !(copy6 ?? "").includes("两侧"), copy6 ?? "(无)");
check("6inch_4p 贴纸文案不出现「左」/右(只有上下被裁)", !(copy6).match(/左|右/), copy6 ?? "(无)");

// 关闭模态 —— §8 要重新点缩略图进模态, 留着的话点击会被遮罩拦截。
await page.locator("[data-edit-modal] button", { hasText: "完成" }).click();
check("§7 末「完成」关闭模态", (await page.locator("[data-edit-modal]").count()) === 0);

// ---------------------------------------------------------------------------
// §8. 边缘裁切: 把贴纸摆到 x=0.02 (2x2 cover 保留窗口 0.217 之外), 看不到
// ---------------------------------------------------------------------------
console.log("\n--- 8. 贴纸边缘用例: x=0.02 的贴纸, 成片该区域无对应颜色 ---");
await page.evaluate(() => window.__store.getState().setLayout("2x2"));
await page.waitForTimeout(200);
await page.evaluate(() => window.__store.getState().reset());
await page.evaluate((gray) => {
  const frames = Array.from({ length: 4 }, () => ({
    url: window.__mkGray(1280, 960, gray),
    burnedIn: true,
  }));
  window.__store.getState().setFrames(frames);
}, GRAY);
check("reset 后 stickerOverrides 已清", (await page.evaluate(() => Object.keys(window.__store.getState().stickerOverrides).length)) === 0);

await page.locator("[data-doodle-thumb='0']").click();
await page.locator("[data-edit-modal]").waitFor({ state: "visible", timeout: 10000 });
await page.locator("[data-edit-tab='sticker']").click();
await page.locator("[data-sticker-canvas]").waitFor({ state: "visible", timeout: 10000 });
const edgeBox = await page.locator("[data-sticker-canvas]").boundingBox();
const atE = (rx, ry) => ({ x: edgeBox.x + rx * edgeBox.width, y: edgeBox.y + ry * edgeBox.height });

// 摆一颗红色爱心到 x=0.04, 远在 0.217 之外(但仍在照片范围内, 摆得出来)。
await page.locator("[data-sticker-shape='heart']").click();
await page.mouse.click(atE(0.04, 0.5).x, atE(0.04, 0.5).y);
await page.waitForTimeout(80);

const edgeSticker = await page.evaluate(() => {
  const list = window.__store.getState().stickerOverrides[0] ?? [];
  const s = list[0];
  return {
    n: list.length,
    shape: s?.shape, fill: s?.fill,
    x: s?.x ?? -1,
  };
});
check("边缘贴纸已进 store", edgeSticker.n === 1, `${edgeSticker.n} 颗`);
check(
  "边缘贴纸是红爱心",
  edgeSticker.shape === "heart" && edgeSticker.fill === RED,
  `${edgeSticker.shape}/${edgeSticker.fill}`,
);
check(
  "边缘贴纸 x 落在保留窗口 0.217 之外(前提)",
  edgeSticker.x < 0.217,
  `x=${edgeSticker.x.toFixed(3)}`,
);

await page.locator("[data-edit-modal] button", { hasText: "完成" }).click();
const beforeBase = await page.evaluate(() => window.__store.getState().layoutUrl);
await genBtn.click();
await page.waitForFunction(
  (p) => {
    const u = window.__store?.getState().layoutUrl;
    return typeof u === "string" && u.length > 0 && u !== p;
  },
  beforeBase,
  { timeout: 120000 },
);
const edgeUrl = await page.evaluate(() => window.__store.getState().layoutUrl);
const edge = await page.evaluate((u) => window.__scanColors(u), edgeUrl);
console.log(
  `         边缘拼图 ${edge.w}x${edge.h}  红 ${edge.redN} 黄 ${edge.yellowN} 蓝 ${edge.blueN}`,
);
check(
  "x=0.04 的贴纸未出现在成片左侧(被 cover 裁掉)",
  edge.redN === 0,
  `红 ${edge.redN}px`,
);

// ---------------------------------------------------------------------------
// §9. reset 清掉贴纸
// ---------------------------------------------------------------------------
console.log("\n--- 9. reset 清掉贴纸 ---");
const afterReset = await page.evaluate(() => {
  window.__store.getState().reset();
  const s = window.__store.getState();
  return {
    stickers: Object.keys(s.stickerOverrides).length,
    frames: s.frames.length,
  };
});
check("reset 后 stickerOverrides 被清空", afterReset.stickers === 0, `${afterReset.stickers} 项`);
check("reset 后 frames 被清空", afterReset.frames === 0, `${afterReset.frames} 张`);

// ---------------------------------------------------------------------------
console.log("\n--- 10. 无运行时错误 ---");
check("无 pageerror", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();
console.log(`\nResult: ${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length) {
  console.log("失败项: " + FAIL.join(", "));
}
process.exit(FAIL.length ? 1 : 0);