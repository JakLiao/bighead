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
 * 第 6 节反过来专门画在 x=0.02(保留窗口之外), 断言成片**没有**蓝色 ——
 * 把"边缘笔迹会被静默裁掉"这个事实钉成回归, 同时验证 UI 的安全区提示
 * 随排版切换而改变(2x2 裁左右 21.7%, 6inch_4p 裁上下 2.8%/18.8%)。
 *
 * 画三笔:
 *   A 蓝色马克笔, 相对 y=0.50 横贯画面 —— 成片里**必须**出现该蓝
 *   B 蓝色马克笔, 相对 y=0.75 短横 —— 用来验证橡皮真的能擦
 *   C 橡皮, 覆盖 B 的位置 —— B 的蓝必须消失, 且**照片不能被擦穿**
 *      (若橡皮直接 destination-out 画在照片上, 那块会变透明, 导成 JPEG
 *       就是一块白/黑 —— 这正是 burnDoodles 隔一层透明层的原因)
 */
import { chromium } from "playwright";
import { createHarness } from "./verifyHarness.mjs";

/**
 * 夹具接管断言收集与数据清理。
 *
 * 本脚本点三次「生成拼图」(第 2/4/6 节), 每次都经 DecoratePage.doLayout
 * -> saveCaptures() 建一个 outputs/{job_id}/ 目录, job_id 是后端生成的
 * 随机 hex。原先**没有任何清理**, 于是每跑一次就往 outputs/ 里丢 3 个
 * job, 而脚本全绿: 泄漏不会被任何断言发现, 事后也无法靠目录名认领
 * (前缀扫描对 hex 完全无感), 只能人工翻 outputs/。
 *
 * 现在由 h.watchCapturedJobs 在 /api/capture/save 响应到达时登记,
 * h.finish() 无条件兜底。可以开 mark(打 runTag 标记)是因为本脚本只做
 * 像素级断言, 不断言 title/tags 的值或数量。
 */
const h = await createHarness("verify-doodle-burn");
const check = h.check;

/**
 * 进入前拍快照, 供 finish() 求差集。必须在第一次点「生成拼图」之前 ——
 * 否则新 job 进了基线, 差集恒空, 终检就是"什么都没查"的空检查。
 */
const entrySnapshot = await h.snapshot();

const URL_BASE = process.env.APP_URL || "http://localhost:5173";

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

/**
 * 登记「被测代码自己造的 job」。必须早于第 2 节的第一次点击, 否则第一个
 * job 抓不到 —— 而它恰好是最容易在超时里丢掉的(那一节要等 120s)。
 */
h.watchCapturedJobs(page);

try {

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
console.log("\n--- 6. 回归: 故意画到 x=0.02 的边缘笔迹, 成片该区域必须没有蓝色 ---");
// 这一节把 H1 的缺陷钉成回归。
//
// 缺陷本身: 后端 _smart_crop 是 cover 裁切, 1280x960 塞进 615x815(0.755)
// 会裁掉左右各 21.7%(保留 x∈[0.217,0.784])。画在 x=0.02 的笔迹**确实
// 烧进了照片**, 但成片上凭空消失, 而旧文案写着「所有笔迹都会烧进最终图」。
//
// 断言为什么是"没有蓝色"而不是"有蓝色": 这不是在测功能能不能用, 而是在
// 测**裁切行为是否与 UI 提示一致**。x=0.02 落在保留窗口之外, 所以正确结果
// 就是成片边缘看不到那笔蓝。若哪天有人把 _smart_crop 改成 contain/不裁切,
// 这条断言会失败 —— 那正是我们要的: 几何一变, 提示与成片的对应关系必须
// 重新验证, 而不是悄悄放过。
//
// 取样窗口用照片坐标反推: x∈[0, 0.217] 的照片区域, 在拼图里落在
// cell 左侧的**外面**(被裁掉了), 因此预期整条左侧带都是纯灰。
// 拼图 cell(0,0) 起点 (30,30), cell 宽 615, 照片保留窗口 0.217~0.784。
const BAND_EDGE_L = [0.0, 0.045, 0.20, 0.30];
/** 右侧对称带。cell 右边界 = 30+615=645 -> 645/1320 = 0.4886。 */
const BAND_EDGE_R = [0.455, 0.5, 0.20, 0.30];

const edgeDrawn = await page.evaluate(() => {
  window.__store.getState().reset();
  return true;
});
check("已 reset 准备边缘用例", edgeDrawn === true);

const reInjected = await page.evaluate((gray) => {
  const frames = Array.from({ length: 4 }, () => ({
    url: window.__mkGray(1280, 960, gray),
    burnedIn: true,
  }));
  window.__store.getState().setFrames(frames);
  return window.__store.getState().frames.length;
}, GRAY);
check("重新注入 4 张灰帧", reInjected === 4, `${reInjected} 张`);

await page.locator("[data-doodle-thumb='0']").click();
await page.locator("[data-doodle-canvas]").waitFor({ state: "visible", timeout: 10000 });
const modalScope2 = page.locator("[data-doodle-scope='modal']");
await modalScope2.locator(`[data-doodle-color='${BLUE}']`).click();
// 必须显式选回马克笔: 工具状态活在 DecoratePage 里并跨模态保留, 第 3 节
// 最后画的是橡皮(C 笔), 不点这一下就仍是 eraser, 画出来的是擦除笔迹。
await modalScope2.locator("[data-doodle-tool='marker']").click();
await modalScope2.locator("[data-doodle-width='14']").click();

const box2 = await page.locator("[data-doodle-canvas]").boundingBox();
const at2 = (rx, ry) => ({ x: box2.x + rx * box2.width, y: box2.y + ry * box2.height });
/** 沿相对坐标画一笔(pointerdown → 多次 move → pointerup)。 */
async function stroke2(fromX, y, toX) {
  const p0 = at2(fromX, y);
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const p = at2(fromX + ((toX - fromX) * i) / steps, y);
    await page.mouse.move(p.x, p.y);
  }
  await page.mouse.up();
  await page.waitForTimeout(60);
}

// 关键: 起点 x=0.02, 远在 0.217 之外, 但仍在照片范围内(画得出来)。
await stroke2(0.02, 0.5, 0.06);

const edgeStroke = await page.evaluate(() => {
  const d = window.__store.getState().doodles[0] ?? [];
  const s = d[0];
  return {
    n: d.length,
    tool: s?.tool,
    color: s?.color,
    minX: s ? Math.min(...s.points.map((p) => p.x)) : -1,
    maxX: s ? Math.max(...s.points.map((p) => p.x)) : -1,
  };
});
check("边缘笔迹已进 store", edgeStroke.n === 1, `${edgeStroke.n} 笔`);
check("边缘笔迹是蓝色马克笔", edgeStroke.color === BLUE && edgeStroke.tool === "marker",
  `${edgeStroke.color}/${edgeStroke.tool}`);
check(
  "边缘笔迹 x 确实落在保留窗口 0.217 之外(前提成立, 否则本用例无意义)",
  edgeStroke.minX < 0.217,
  `x∈[${edgeStroke.minX.toFixed(3)}, ${edgeStroke.maxX.toFixed(3)}]`,
);

// 安全区可视化: 2x2 排版下必须存在左右两条压暗, 且宽度接近 21.7%。
//
// 量取要分清方向: 左/右是竖条, 量 width; 上/下是横条, 量 height。
// 早期版本一律取 width, 于是上/下拿到的是整条画布宽(640), 除以画布高
// 480 得到 133% 这种明显荒谬的数 —— 断言虽然红了, 但红的原因是量错了,
// 不是被测行为有问题, 这种测试会浪费排查时间。
const safe2x2 = await page.evaluate(() => {
  const box = (s) => {
    const el = document.querySelector(`[data-doodle-safe='${s}']`);
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return s === "top" || s === "bottom" ? r.height : r.width;
  };
  const c = document.querySelector("[data-doodle-canvas]")?.getBoundingClientRect();
  return {
    left: box("left"), right: box("right"), top: box("top"), bottom: box("bottom"),
    cw: c?.width ?? 0, ch: c?.height ?? 0,
  };
});
check("2x2 排版下存在左右安全区遮罩", safe2x2.left > 0 && safe2x2.right > 0,
  `L=${safe2x2.left.toFixed(1)} R=${safe2x2.right.toFixed(1)}`);
check(
  "左右安全区宽度约为画布的 21.7%(与 _smart_crop 实算一致)",
  Math.abs(safe2x2.left / safe2x2.cw - 0.217) < 0.02,
  `${(safe2x2.left / safe2x2.cw * 100).toFixed(1)}%`,
);
check("2x2 不裁上下, 故无上下遮罩", safe2x2.top === 0 && safe2x2.bottom === 0,
  `T=${safe2x2.top} B=${safe2x2.bottom}`);

// 文案必须如实说明, 不能再出现"所有笔迹都会烧进最终图"。
const copy2x2 = await page.locator("[data-doodle-safe-text]").textContent();
check("文案不再声称所有笔迹都会保留", !(copy2x2 ?? "").includes("所有笔迹"), copy2x2 ?? "(无)");
check("文案点明压暗区不会被保留", (copy2x2 ?? "").includes("不会被保留"), copy2x2 ?? "(无)");

// 换排版: 6inch_4p 的 cell 比照片宽, 裁的是**上下**, 左右不裁。
// 这一条断言是"安全区按排版动态算"的核心证据 —— 写死 0.217 的实现
// 在这个排版下会同时指错方向(遮了不裁的左右, 没遮真正被裁的上下)。
await page.evaluate(() => window.__store.getState().setLayout("6inch_4p"));
await page.waitForTimeout(300);
const safe6 = await page.evaluate(() => {
  const box = (s) => {
    const el = document.querySelector(`[data-doodle-safe='${s}']`);
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return s === "top" || s === "bottom" ? r.height : r.width;
  };
  const c = document.querySelector("[data-doodle-canvas]")?.getBoundingClientRect();
  return {
    left: box("left"), right: box("right"), top: box("top"), bottom: box("bottom"),
    cw: c?.width ?? 0, ch: c?.height ?? 0,
  };
});
check("6inch_4p 下左右不再有遮罩(该排版不裁左右)", safe6.left === 0 && safe6.right === 0,
  `L=${safe6.left} R=${safe6.right}`);
check("6inch_4p 下出现上下遮罩(该排版裁上下)", safe6.top > 0 && safe6.bottom > 0,
  `T=${safe6.top.toFixed(1)} B=${safe6.bottom.toFixed(1)}`);
check(
  "上遮罩约为画布高的 2.8%, 下遮罩约为 18.8%",
  Math.abs(safe6.top / safe6.ch - 0.028) < 0.02 && Math.abs(safe6.bottom / safe6.ch - 0.188) < 0.02,
  `T=${(safe6.top / safe6.ch * 100).toFixed(1)}% B=${(safe6.bottom / safe6.ch * 100).toFixed(1)}%`,
);
const copy6 = await page.locator("[data-doodle-safe-text]").textContent();
check("6inch_4p 文案不再提两侧", !(copy6 ?? "").includes("两侧"), copy6 ?? "(无)");

// 切回 2x2, 生成拼图, 断言边缘区域没有蓝色。
await page.evaluate(() => window.__store.getState().setLayout("2x2"));
await page.waitForTimeout(200);
await page.locator("[data-doodle-modal] button", { hasText: "完成" }).click();
check("「完成」关闭模态", (await page.locator("[data-doodle-modal]").count()) === 0);

const baseUrl2 = await page.evaluate(() => window.__store.getState().layoutUrl);
await genBtn.click();
await page.waitForFunction(
  (p) => {
    const u = window.__store?.getState().layoutUrl;
    return typeof u === "string" && u.length > 0 && u !== p;
  },
  baseUrl2,
  { timeout: 120000 },
);
const edgeUrl = await page.evaluate(() => window.__store.getState().layoutUrl);
check("边缘用例生成了新拼图", edgeUrl !== baseUrl2);
const edgeShot = await page.evaluate(
  ([u, a, b]) => window.__scan(u, a, b),
  [edgeUrl, BAND_EDGE_L, BAND_EDGE_R],
);
console.log(
  `         边缘拼图 ${edgeShot.w}x${edgeShot.h}  蓝色像素 ${edgeShot.total}` +
    `  左带(${edgeShot.aN}px) 右带(${edgeShot.bN}px)`,
);
check(
  "x=0.02 的边缘笔迹未出现在成片左侧(被 cover 裁掉, 与提示一致)",
  edgeShot.aN === 0,
  `左带残留 ${edgeShot.aN}px`,
);
check(
  "x=0.02 的边缘笔迹未出现在成片右侧",
  edgeShot.bN === 0,
  `右带残留 ${edgeShot.bN}px`,
);
check(
  "整张成片没有任何涂鸦蓝色(该笔迹整体被裁掉)",
  edgeShot.total === 0,
  `total=${edgeShot.total}`,
);

// ---------------------------------------------------------------------------
console.log("\n--- 7. reset 清掉涂鸦 ---");
const afterReset = await page.evaluate(() => {
  window.__store.getState().reset();
  const s = window.__store.getState();
  return { doodles: Object.keys(s.doodles).length, frames: s.frames.length };
});
check("reset 后 doodles 被清空", afterReset.doodles === 0, `${afterReset.doodles} 项`);
check("reset 后 frames 被清空", afterReset.frames === 0, `${afterReset.frames} 张`);

console.log("\n--- 8. 无运行时错误 ---");
check("无 pageerror", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (e) {
  // 断言失败也要算失败, 且不吞异常信息 —— 崩溃若被静默处理, run-all-verify
  // 会把它显示成 (no summary) 而不是失败(它认退出码)。
  check("脚本主体未抛异常", false, String(e && e.message ? e.message : e));
} finally {
  /**
   * 清理 + 泄漏自检。**必须**在 finally 里。
   *
   * 本脚本有 3 处 120s waitForFunction, 超时是常态而非例外。清理若写成
   * 末尾的裸语句, 超时就会直接跳到脚本结束 —— 那时第 2/4/6 节三次点击
   * 造出的 job 已经在 outputs/ 里了, 且一次都不会被删。h.finish() 先
   * drain 在途登记, 再删已登记的, 最后拿退出快照减 entrySnapshot 求差集:
   * 任何漏网的新增目录/回收站条目/孤儿键都会被抓到, 与目录名无关。
   */
  await h.finish(entrySnapshot);
  await browser.close();
  h.report();
}
