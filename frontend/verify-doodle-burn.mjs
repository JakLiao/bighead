/**
 * 手写涂鸦端到端验证: 确认笔迹真的烧进了成片, 而不只是 UI 上多了个画板。
 *
 * 这是本任务最容易做成"假功能"的地方。涂鸦的链路是:
 *   指针事件 -> store.doodles -> doLayout 里 burnDoodles -> JPEG 重编码
 *   -> /api/layout/make -> 拼图像素
 * 任何一环漏掉, 页面都完全正常: 模态里能画、能撤销、能清空, 缩略图上
 * 还挂着一枚「N 笔」的角标, 但点「生成拼图」出来的成片里干干净净。
 * 单测守不住这个 —— 它只能证明 paintDoodleStrokes 自己是对的, 证不了
 * 「指针事件 -> store -> burnDoodles -> HTTP -> 后端拼图」这条链是通的。
 *
 * 实验设计与 era 脚本同源, 关键在**输入是纯灰帧**:
 * 全片只有 (128,128,128) 与米色纸 (255,248,240) 两种颜色, 任何"彩色像素"
 * 都只可能来自涂鸦, 不可能是画面本身或后端调色带出来的。
 *
 * 取样区域的推导(后端 layouts.py, layout=2x2 / frame=none):
 *   paper = 600*2+40*3 = 1320 x 800*2+40*3+80 = 1800, margin=30
 *   cell = (1320-30*3)/2 = 615 x (1800-30*3-80)/2 = 815, cell(0,0) 在 (30,30)
 * 照片 1280x960(4:3) 塞进 615x815(0.755) 会走 _smart_crop 的 cover 分支:
 * src_ratio 1.333 > target 0.755 -> 裁掉左右, 保留照片 x∈[278,1003]
 * (相对 0.217~0.784), 检不到人脸故 cx=0.5, 再缩到 615x815。
 * 于是 照片(px,py) -> 拼图: x = 30 + (px-278)*0.8483, y = 30 + py*0.8490
 *   A 笔 相对 y=0.50 -> 拼图 y≈437 (相对 0.243)
 *   B/C 笔 相对 y=0.75 -> 拼图 y≈641 (相对 0.356)
 * 两条带相距 204px, 而笔宽只有十几个像素, 互不干扰。
 *
 * **落笔的 x 必须落在相对 0.217~0.784 内**, 否则会被 cover 裁掉 —— 这是
 * 本脚本最容易踩空的地方: 画在边上时笔迹确实烧进了照片, 但拼图里看不到,
 * 断言会以"功能没做"的面貌失败。脚本里显式断言了每笔的 x 范围。
 *
 * 画三笔:
 *   A 蓝色马克笔, 相对 y=0.50 横贯画面 —— 成片里**必须**出现该蓝
 *   B 蓝色马克笔, 相对 y=0.75 短横 —— 用来验证橡皮真的能擦
 *   C 橡皮, 覆盖 B 的位置 —— B 的蓝必须消失, 且**照片不能被擦穿**
 *      (若橡皮直接 destination-out 画在照片上, 那块会变透明, 导成 JPEG
 *       就是一块白/黑 —— 这正是 burnDoodles 隔一层透明层的原因)
 */
import { chromium } from "playwright";

const URL_BASE = process.env.APP_URL || "http://localhost:5173";
const PASS = [];
const FAIL = [];
const check = (n, c, d = "") => {
  (c ? PASS : FAIL).push(n);
  console.log(`  [${c ? "PASS" : "FAIL"}] ${n} ${d}`);
};

/** 蓝色签名。#3b6cff = rgb(59,108,255), B 远高于 R。 */
const BLUE = "#3b6cff";
/** A 笔所在的带(相对拼图尺寸) */
const BAND_A = [0.05, 0.47, 0.215, 0.275];
/** B/C 笔所在的带(相对拼图尺寸) */
const BAND_B = [0.05, 0.47, 0.33, 0.395];
/** 纯灰底。留足余量, 避免任何算子把底色推到接近蓝色签名。 */
const GRAY = 128;
/** 全图蓝色像素下限。A 笔在拼图里约 430x12 ≈ 5000 px, 阈值取 400 足够宽松。 */
const MIN_BLUE = 400;

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
  // 扫拼图: 全图蓝色像素数 + 两条带的蓝色像素数与平均色。
  // band = [x0f, x1f, y0f, y1f], 按比例取样, 后端微调边距也不至于取空。
  window.__scan = async (u, a, b) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = u; });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const isBlue = (i) => (d[i + 2] - d[i] > 60) && (d[i + 2] > 170);
    const box = (t) => [
      Math.round(c.width * t[0]), Math.round(c.width * t[1]),
      Math.round(c.height * t[2]), Math.round(c.height * t[3]),
    ];
    const A = box(a), B = box(b);
    let total = 0, aN = 0, bN = 0, aCnt = 0, bCnt = 0;
    let aR = 0, aG = 0, aBl = 0, bR = 0, bG = 0, bBl = 0;
    // aMaxRow: A 带内单行最多的蓝像素。A 笔是一条横线, 每一行都该有几百个
    // 蓝像素; 零星噪点(压缩 ringing)只会有个位数。这个量能把"真的画了一笔"
    // 与"某处有几个偏蓝的像素"区分开。
    let aMaxRow = 0;
    for (let y = 0; y < c.height; y++) {
      let rowBlue = 0;
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        const blue = isBlue(i);
        if (blue) total++;
        if (x >= A[0] && x < A[1] && y >= A[2] && y < A[3]) {
          aCnt++; if (blue) { aN++; rowBlue++; }
          aR += d[i]; aG += d[i + 1]; aBl += d[i + 2];
        }
        if (x >= B[0] && x < B[1] && y >= B[2] && y < B[3]) {
          bCnt++; if (blue) bN++;
          bR += d[i]; bG += d[i + 1]; bBl += d[i + 2];
        }
      }
      if (rowBlue > aMaxRow) aMaxRow = rowBlue;
    }
    const mean = (r, g, bl, n) => (n ? [r / n, g / n, bl / n] : [0, 0, 0]);
    return {
      w: c.width, h: c.height, total: total, aN: aN, bN: bN, aMaxRow: aMaxRow,
      aMean: mean(aR, aG, aBl, aCnt), bMean: mean(bR, bG, bBl, bCnt),
    };
  };
`;

// ---------------------------------------------------------------------------
console.log("\n--- 1. 注入 4 张灰帧, 涂鸦面板就位 ---");
// store 是纯内存的(zustand 无 persist), 不能先 goto 再刷新 —— 刷新 frames 就没了。
// 顺序同 verify-era-e2e: 先落地页面, 再注入帧, 让组件自己重渲染。
await page.goto(`${URL_BASE}/decorate`, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.__store, { timeout: 15000 });
await page.evaluate(HELPERS);

// burnedIn 必须为 true: doLayout 用 frames.some(f => !f.burnedIn) 决定是否补滤镜。
// 若为 false 会额外叠一层 faded_90s(warmth/fade/grain/vignette), 暖色与暗角会
// 污染"灰底是否仍是灰底"这个前提。置 true 后 era=modern 走快路径, 一次
// /api/preview/filter 都不发 —— 成片与灰帧逐像素同源, 蓝色只可能来自涂鸦。
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
check("灰帧标记 burnedIn=true(不额外叠滤镜)", injected.burnedIn === true, `burnedIn=${injected.burnedIn}`);
await page.locator("[data-doodle-thumb]").first().waitFor({ state: "visible", timeout: 15000 });

// 面板定位用「手写涂鸦」标题, 不靠 DOM 顺序 —— 侧栏里 AI/滤镜/年代/排版
// 都是同构的 div.bg-white.rounded-2xl, 顺序一变就选错。
const panel = await page.evaluate(() => {
  const title = [...document.querySelectorAll("div")].find(
    (d) => d.children.length === 0 && d.textContent.trim() === "手写涂鸦",
  );
  const card = title?.closest("div.rounded-2xl");
  return {
    found: !!card,
    colors: card ? card.querySelectorAll("[data-doodle-color]").length : 0,
    tools: card
      ? [...card.querySelectorAll("[data-doodle-tool]")].map((b) => b.textContent.trim())
      : [],
    widths: card
      ? [...card.querySelectorAll("[data-doodle-width]")].map((b) => b.textContent.trim())
      : [],
    count: card?.querySelector("[data-doodle-count]")?.textContent.trim() ?? "",
  };
});
check("涂鸦面板已渲染", panel.found);
check("色板恰好 8 色", panel.colors === 8, `实际 ${panel.colors} 个`);
check(
  "三个工具为「马克笔」/「荧光笔」/「橡皮」",
  panel.tools.length === 3 &&
    panel.tools[0] === "马克笔" &&
    panel.tools[1] === "荧光笔" &&
    panel.tools[2] === "橡皮",
  panel.tools.join(" / "),
);
check(
  "三档粗细为「细」/「中」/「粗」",
  panel.widths.length === 3 && panel.widths.join("/") === "细/中/粗",
  panel.widths.join(" / "),
);
check("初始显示「共 0 笔」", panel.count.includes("共 0 笔"), panel.count);

const defaults = await page.evaluate(() => {
  const card = [...document.querySelectorAll("div")]
    .find((d) => d.children.length === 0 && d.textContent.trim() === "手写涂鸦")
    ?.closest("div.rounded-2xl");
  const on = (sel) =>
    [...(card?.querySelectorAll(sel) ?? [])]
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.getAttribute(sel.replace(/[\[\]"]/g, "")) ?? b.textContent.trim());
  return { tool: on("[data-doodle-tool]"), width: on("[data-doodle-width]") };
});
check("默认工具为马克笔", defaults.tool.length === 1 && defaults.tool[0] === "marker", defaults.tool.join(","));
check("默认粗细为中(8)", defaults.width.length === 1 && defaults.width[0] === "8", defaults.width.join(","));

// ---------------------------------------------------------------------------
console.log("\n--- 2. 基线: 还没画任何东西时, 成片里不该有涂鸦色 ---");
const genBtn = page.getByRole("button", { name: "生成拼图" });
await genBtn.waitFor({ state: "visible", timeout: 15000 });
await genBtn.click();
// 4 帧 -> 一次 /api/layout/make, 首帧可能还要加载 insightface 做焦点检测。
await page.waitForFunction(
  () => {
    const u = window.__store?.getState().layoutUrl;
    return typeof u === "string" && u.length > 0;
  },
  { timeout: 120000 },
);
const baseUrl = await page.evaluate(() => window.__store.getState().layoutUrl);
const base = await page.evaluate(
  ([u, a, b]) => window.__scan(u, a, b),
  [baseUrl, BAND_A, BAND_B],
);
console.log(`         基线拼图 ${base.w}x${base.h}  蓝色像素 ${base.total}`);
check("基线拼图尺寸为 1320x1800", base.w === 1320 && base.h === 1800, `${base.w}x${base.h}`);
check(
  "未画时全图无涂鸦蓝色(证明取样区域不含其它彩色)",
  base.total === 0,
  `total=${base.total}`,
);
check(
  "A 带此时是纯灰(证明底色未被任何算子污染)",
  Math.abs(base.aMean[0] - GRAY) < 12 &&
    Math.abs(base.aMean[1] - GRAY) < 12 &&
    Math.abs(base.aMean[2] - GRAY) < 12,
  `rgb(${base.aMean.map((v) => v.toFixed(1)).join(",")})`,
);

// ---------------------------------------------------------------------------
console.log("\n--- 3. 进编辑模态, 画 A/B/擦 C 三笔 ---");
check("初始 store.doodles 为空", (await page.evaluate(() => Object.keys(window.__store.getState().doodles).length)) === 0);

await page.locator("[data-doodle-thumb='0']").click();
await page.locator("[data-doodle-modal]").waitFor({ state: "visible", timeout: 10000 });
const canvas = page.locator("[data-doodle-canvas]");
await canvas.waitFor({ state: "visible", timeout: 10000 });
check("点缩略图进入编辑模态", await page.locator("[data-doodle-modal]").isVisible());

// 模态里也要能换笔具 —— 它是 fixed inset-0 遮罩, 会盖住侧栏那套控件。
const modalScope = page.locator("[data-doodle-scope='modal']");
check(
  "模态内含一套色板/工具/粗细",
  (await modalScope.locator("[data-doodle-color]").count()) === 8 &&
    (await modalScope.locator("[data-doodle-tool]").count()) === 3 &&
    (await modalScope.locator("[data-doodle-width]").count()) === 3,
);
await modalScope.locator(`[data-doodle-color='${BLUE}']`).click();
await modalScope.locator("[data-doodle-width='14']").click();

const box = await canvas.boundingBox();
const at = (rx, ry) => ({ x: box.x + rx * box.width, y: box.y + ry * box.height });
/** 沿相对坐标画一笔(pointerdown → 多次 move → pointerup)。 */
async function stroke(fromX, y, toX) {
  const p0 = at(fromX, y);
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const p = at(fromX + ((toX - fromX) * i) / steps, y);
    await page.mouse.move(p.x, p.y);
  }
  await page.mouse.up();
  await page.waitForTimeout(60);
}

// A: 蓝色马克笔横贯画面中部。x 收在 0.30~0.70, 落在 cover 裁切保留的
// 0.217~0.784 内 —— 画到边上会在这里被后端裁掉。
await stroke(0.3, 0.5, 0.7);
check("A 笔已进 store", (await page.evaluate(() => (window.__store.getState().doodles[0] ?? []).length)) === 1);

// B: 第二笔蓝, 稍后被橡皮覆盖。
await stroke(0.3, 0.75, 0.45);
check("B 笔已进 store", (await page.evaluate(() => (window.__store.getState().doodles[0] ?? []).length)) === 2);

// C: 橡皮盖住 B。
await modalScope.locator("[data-doodle-tool='eraser']").click();
await stroke(0.28, 0.75, 0.47);
check("C 笔已进 store", (await page.evaluate(() => (window.__store.getState().doodles[0] ?? []).length)) === 3);

const st = await page.evaluate(() => {
  const d = window.__store.getState().doodles[0] ?? [];
  const span = (s) => [Math.min(...s.points.map((p) => p.x)), Math.max(...s.points.map((p) => p.x))];
  const ys = d.map((s) => s.points[0].y);
  return {
    n: d.length,
    tools: d.map((x) => x.tool),
    colors: d.map((x) => x.color),
    widths: d.map((x) => x.width),
    pts: d.map((x) => x.points.length),
    xsA: span(d[0]),
    inUnit: d.every((s) => s.points.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)),
  };
});
check("store 内共 3 笔", st.n === 3, `${st.n} 笔`);
check(
  "工具序列为 马克/马克/橡皮",
  st.tools.join(",") === "marker,marker,eraser",
  st.tools.join(","),
);
check("A、B 两笔都是选中的蓝色", st.colors[0] === BLUE && st.colors[1] === BLUE, st.colors.join(","));
check("三笔都用「粗」(14)", st.widths.every((w) => w === 14), st.widths.join(","));
check("每笔至少 3 个采样点(拖动而非轻点)", st.pts.every((n) => n >= 3), st.pts.join(","));
check("坐标全部落在 0..1(相对坐标契约)", st.inUnit === true);
check(
  "A 笔 x 落在 cover 裁切保留的 0.217~0.784 内(否则拼图里看不到)",
  st.xsA[0] >= 0.217 && st.xsA[1] <= 0.784,
  `x∈[${st.xsA[0].toFixed(3)}, ${st.xsA[1].toFixed(3)}]`,
);

// 缩略图角标 + 侧栏计数: 证明 UI 与 store 同步, 不是只往 store 里偷偷写。
const badge = await page.locator("[data-doodle-badge]").first().textContent();
check("缩略图出现「N 笔」角标", (badge ?? "").includes("3 笔"), badge ?? "(无)");
const sidebarCount = await page
  .locator("[data-doodle-scope='sidebar'] [data-doodle-count]")
  .textContent();
check("侧栏计数为「共 3 笔」", (sidebarCount ?? "").includes("共 3 笔"), sidebarCount ?? "(无)");

await page.locator("[data-doodle-modal] button", { hasText: "完成" }).click();
check("「完成」关闭模态", (await page.locator("[data-doodle-modal]").count()) === 0);

// ---------------------------------------------------------------------------
console.log("\n--- 4. 重新生成拼图, 涂鸦色必须真的出现 ---");
// 必须等 layoutUrl **变成另一个**: 直接等非空会立刻命中上一张基线拼图,
// 断言就成了永远为真的空检查。
await genBtn.click();
await page.waitForFunction(
  (p) => {
    const u = window.__store?.getState().layoutUrl;
    return typeof u === "string" && u.length > 0 && u !== p;
  },
  baseUrl,
  { timeout: 120000 },
);
const drawnUrl = await page.evaluate(() => window.__store.getState().layoutUrl);
check("生成了新的拼图(URL 已变化)", drawnUrl !== baseUrl);
const shot = await page.evaluate(
  ([u, a, b]) => window.__scan(u, a, b),
  [drawnUrl, BAND_A, BAND_B],
);
console.log(
  `         涂鸦拼图 ${shot.w}x${shot.h}  蓝色像素 ${shot.total}` +
    `  A带(${shot.aN}px) 均色 rgb(${shot.aMean.map((v) => v.toFixed(1)).join(",")})` +
    `  B带(${shot.bN}px) 均色 rgb(${shot.bMean.map((v) => v.toFixed(1)).join(",")})`,
);
check(
  "A 笔的蓝色真的出现在成片里",
  shot.total >= MIN_BLUE,
  `蓝色像素 ${shot.total} (阈值 ≥${MIN_BLUE})`,
);
check(
  "蓝色落在预期的 A 带内(不是画到了别处)",
  shot.aN >= MIN_BLUE,
  `A 带 ${shot.aN}px`,
);
check(
  "A 带里存在一条连续横贯的蓝色行(是\"一笔\"而非零星噪点)",
  shot.aMaxRow >= 200,
  `单行最多 ${shot.aMaxRow}px`,
);
// 交叉校验: 带外没有蓝色。取样带是按 cover 裁切后的映射算的, 若后端改了
// 排版参数, 蓝色会跑到带外 —— 这条断言能立刻指出"几何假设变了"。
check(
  "蓝色基本都在 A 带内(拼图几何假设仍成立)",
  shot.total - shot.aN < shot.total * 0.2,
  `带外 ${shot.total - shot.aN}px / 共 ${shot.total}px`,
);

// ---------------------------------------------------------------------------
console.log("\n--- 5. 橡皮: 擦掉了 B, 且没有把照片擦穿 ---");
check("B 带内已无蓝色(B 被橡皮擦掉)", shot.bN === 0, `B 带残留 ${shot.bN}px`);
check(
  "B 带仍是灰底(橡皮没有在照片上开洞)",
  Math.abs(shot.bMean[0] - GRAY) < 14 &&
    Math.abs(shot.bMean[1] - GRAY) < 14 &&
    Math.abs(shot.bMean[2] - GRAY) < 14,
  `rgb(${shot.bMean.map((v) => v.toFixed(1)).join(",")})`,
);
check(
  "B 带不是白洞也不是黑洞",
  shot.bMean[0] > 90 && shot.bMean[0] < 200,
  `R=${shot.bMean[0].toFixed(1)}`,
);

// ---------------------------------------------------------------------------
console.log("\n--- 6. reset 清掉涂鸦 ---");
const afterReset = await page.evaluate(() => {
  window.__store.getState().reset();
  const s = window.__store.getState();
  return { doodles: Object.keys(s.doodles).length, frames: s.frames.length };
});
check("reset 后 doodles 被清空", afterReset.doodles === 0, `${afterReset.doodles} 项`);
check("reset 后 frames 被清空", afterReset.frames === 0, `${afterReset.frames} 张`);

console.log("\n--- 7. 无运行时错误 ---");
check("无 pageerror", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();
console.log(`\nResult: ${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length) {
  console.log("失败项: " + FAIL.join(", "));
}
process.exit(FAIL.length ? 1 : 0);
