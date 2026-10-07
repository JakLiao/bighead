/**
 * 年代(era)端到端验证: 确认「古早画质」真的烧进了成片, 而不只是 UI 上多了个开关。
 *
 * era 与 filter 是**两个正交维度**: filter 决定色调, era 决定"年代感"
 * (低分辨率 + 顶部漏光 + 色阶断层)。它最容易被做成假功能 ——
 * /api/meta 里 era_presets 照常返回, 按钮照常渲染, 但 applyFilter 忘了把 era
 * 串进去, 或者串了但被后续算子覆盖。用户点下去看不出任何差别, 也没有任何报错。
 * 单测守不住这个: 它只能证明 _era_vintage_2000_pixels 自己是对的, 证不了
 * 「前端开关 -> HTTP -> 后端 -> 烧进 JPEG -> 进拼图」这条链是通的。
 *
 * 所以本脚本全程用**中灰纯色帧**做输入。这是关键的实验设计:
 * 纯灰图里没有任何内容可供对比, 顶部与底部的 R 差**只可能**来自 era 算子的
 * 顶部漏光(if (bgr) 带内 R += leak_r * ramp)。换成灰粉渐变或真实照片,
 * 画面本身的明暗就会污染这个差值, 断言失去意义。
 *
 * 另外两处容易踩空的地方, 都在下面注释里标了。
 */
import { chromium } from "playwright";
import { createHarness } from "./verifyHarness.mjs";

/**
 * 夹具接管断言收集与数据清理。
 *
 * 本脚本点两次「生成拼图」, 每次都会经 DecoratePage.doLayout ->
 * saveCaptures() 建一个 outputs/{job_id}/ 目录, 而 job_id 是后端生成的
 * 随机 hex。此前台面上没有任何清理, 于是**每跑一次就往 outputs/ 里丢
 * 两个 job**, 且脚本全绿 —— 泄漏既不会被断言发现, 事后也无法靠目录名
 * 认出来(前缀扫描对 hex 完全无感)。
 *
 * 现在由 h.watchCapturedJobs 在 /api/capture/save 的响应到达时登记,
 * h.finish() 无条件兜底。判据: 本脚本只做像素级断言(era 有没有烧进
 * 成片), 不断言 title/tags, 所以可以打 runTag 标记, 清理万一失败也
 * 还能用 ?q=<runTag> 找回。
 */
const h = await createHarness("verify-era-e2e");
const check = h.check;

/**
 * 进入前拍快照, 供 finish() 求差集。
 *
 * 必须在第一次点「生成拼图」**之前**拍: 否则新 job 进了基线, 差集恒空,
 * 终检就成了"什么都没查"的空检查 —— 比没有自检更危险。
 */
const entrySnapshot = await h.snapshot();

const URL_BASE = process.env.APP_URL || "http://localhost:5173";

// 拼图用 2x2(LayoutStore 默认, 本脚本不改)时后端算出的画布是 1320x1800:
//   paper_w = 600*2 + 40*3 = 1320, paper_h = 800*2 + 40*3 + 80 = 1800
//   margin=30, cell 615x815, cell(0,0) 在 (30,30), cell(1,0) 在 (30,875)
//
// 取样区域按**比例**给(而非绝对像素), 这样即便后端微调边距也不至于取空。
// 两条都取自左侧那一列 cell 的内部, 刻意避开:
//   - 30px 米色边距与 cell 间隙: 背景是 (255,248,240), R=255。若误取到它,
//     modern 下"顶部 R"会直接飙到 255, 断言 4 必假阴。
//   - 底部 y>1690 的戳印区("BIGHEAD 2026")。
//   - 顶部 y<30 的空白。
// 换算到 1320x1800 上: top = y[54,297] 落在 cell(0,0) 的漏光带内;
// bottom = y[1404,1647] 落在 cell(1,0) 的漏光带**之外**(每帧漏光只覆盖自身
// 上 50%, 即 cell 内 y<437; 到 y=875+525=1400 时早已衰减到 0)。
const BAND = { x0: 0.08, x1: 0.45, topY0: 0.03, topY1: 0.165, botY0: 0.78, botY1: 0.915 };
// 漏光在顶部 1/4 内的平均增温约 +26 个色阶(leak_r=40 线性衰减到 leak_h 的 0)。
// 阈值取 12: 远高于 JPEG q92 在平坦区的误差(±1~2), 又远低于实测 ~26,
// 留足了后端调参的余量。modern 侧用 6 卡住"完全无漏光"。
const VINTAGE_MIN_DELTA = 12;
const MODERN_MAX_DELTA = 6;
// 纯灰底色 128。留足余量避免漏光 +40 把 R 顶到 255 发生截断(会低估效果)。
const GRAY = 128;

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
page.on("pageerror", (e) => errors.push(String(e)));

/**
 * 登记「被测代码自己造的 job」。
 *
 * 挂在建 page 之后、任何一次点按钮之前 —— 早于第一次 /api/capture/save
 * 发生, 才有 interception 的意义; 挂晚了则前几次生成的 job 抓不到。
 */
h.watchCapturedJobs(page);

try {

// ---------------------------------------------------------------------------
// 页面内公用工具
// ---------------------------------------------------------------------------
// 注入用帧。尺寸取 1280x960, 与取景页真实出片一致 —— 这个尺寸下 era 的
// 下采样(短边 480)是真的在跑(640x480 -> 回 1280x960), 不是 scale=1 的空转。
const HELPERS = `
  window.__mkGray = (w, h, v) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = "rgb(" + v + "," + v + "," + v + ")";
    g.fillRect(0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.92);
  };
  // 读拼图上/下两条带的 R 均值。
  window.__sampleBands = async (u, band) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = u; });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const avg = (x0f, y0f, x1f, y1f) => {
      const x0 = Math.round(c.width * x0f), x1 = Math.round(c.width * x1f);
      const y0 = Math.round(c.height * y0f), y1 = Math.round(c.height * y1f);
      const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let r = 0, gg = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
      const n = d.length / 4;
      return { r: r / n, g: gg / n, b: b / n };
    };
    return {
      w: c.width, h: c.height,
      top: avg(band.x0, band.topY0, band.x1, band.topY1),
      bottom: avg(band.x0, band.botY0, band.x1, band.botY1),
    };
  };
`;

// ---------------------------------------------------------------------------
console.log("\n--- 1. /decorate 的 era 开关: 两个按钮存在, 默认选中「现代高清」 ---");
// 直接 goto /decorate。注意 store 是纯内存的(zustand 无 persist 中间件),
// 所以**不能**先 goto 再刷新 —— 一刷新 frames 就没了。正确顺序是先落地页面,
// 再往 store 注入帧, 让组件自己重渲染出完整 UI。
await page.goto(`${URL_BASE}/decorate`, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.__store, { timeout: 15000 });
await page.evaluate(HELPERS);

// 注入帧必须**先于**任何 era 面板断言。
// DecoratePage 在 frames.length === 0 时提前 return 一个"还没拍照片"的空壳,
// 整个侧栏(含年代画质面板)根本不渲染 —— 首屏断言会读到 0 个按钮, 看起来像
// "era 功能没做", 实际只是页面处于空态。注入后组件重渲染, 面板才出现。
//
// burnedIn 必须为 true: doLayout 用 frames.some(f => !f.burnedIn) 决定是否补
// 滤镜; 若为 false 会额外叠一层当前 filter(默认 faded_90s 的
// warmth/fade/grain/vignette), 暖色与暗角会污染 R 差值, 测的就不再是 era。
// 置 true 后 preset 走 "none", **只有** era 算子在跑 —— 变量唯一。
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
// 等重渲染落地, 否则可能在面板出现前就去查 DOM。
await page.locator('button[aria-pressed]').first().waitFor({ state: "visible", timeout: 15000 });

const eraUi = await page.evaluate(() => {
  // 面板定位用「年代画质」这个标题, 而不是靠 DOM 顺序猜 ——
  // 侧栏里 AI/滤镜/相框都是同构的 div.bg-white.rounded-2xl, 顺序一变就选错。
  const title = [...document.querySelectorAll("div")].find(
    (d) => d.children.length === 0 && d.textContent.trim() === "年代画质",
  );
  const card = title?.closest("div.rounded-2xl");
  const btns = card
    ? [...card.querySelectorAll("button")].map((b) => ({
        text: b.textContent.trim(),
        pressed: b.getAttribute("aria-pressed"),
      }))
    : [];
  return { found: !!card, btns };
});
check("era 面板已渲染", eraUi.found);
check("era 恰好两个按钮", eraUi.btns.length === 2, `实际 ${eraUi.btns.length} 个`);
const names = eraUi.btns.map((b) => b.text);
check(
  "两个按钮为「现代高清」/「古早画质」",
  names.includes("现代高清") && names.includes("古早画质"),
  names.join(" / "),
);
const pressedNames = eraUi.btns.filter((b) => b.pressed === "true").map((b) => b.text);
check(
  "默认选中「现代高清」",
  pressedNames.length === 1 && pressedNames[0] === "现代高清",
  `aria-pressed=true: ${pressedNames.join(",") || "(无)"}`,
);

// ---------------------------------------------------------------------------
console.log("\n--- 2. /api/preview/filter: era 确实改变了返回字节 ---");
// 走页面内 fetch(经 vite 代理到 8077), 与前端真实调用同一条路径。
// preset 固定 "none": 这样字节差异只可能来自 era, 不会被 filter 的
// warmth/fade/grain/vignette 搅进来。顺带覆盖一个真实组合 —— "不选滤镜、
// 只要古早画质" 是合法用法(apply_filter 对 preset=none 仍会走 era)。
const apiCmp = await page.evaluate(async (gray) => {
  const url = window.__mkGray(1280, 960, gray);
  const blob = await (await fetch(url)).blob();
  const post = async (era) => {
    const fd = new FormData();
    fd.append("image", blob, "cap.jpg");
    fd.append("preset", "none");
    fd.append("era", era);
    const r = await fetch("/api/preview/filter", { method: "POST", body: fd });
    if (!r.ok) return { status: r.status, bytes: null };
    const b = new Uint8Array(await r.arrayBuffer());
    // 位置加权校验和: 比总和无意义(不同排列可能抵消), 比逐字节也没必要回传。
    let h = 2166136261;
    for (let i = 0; i < b.length; i++) {
      h ^= b[i] + i;
      h = Math.imul(h, 16777619) >>> 0;
    }
    return { status: r.status, len: b.length, hash: h, magic: [b[0], b[1]] };
  };
  return { modern: await post("modern"), vintage: await post("vintage_2000") };
}, GRAY);
check("era=modern 返回 200", apiCmp.modern.status === 200, `status=${apiCmp.modern.status}`);
check("era=vintage_2000 返回 200", apiCmp.vintage.status === 200, `status=${apiCmp.vintage.status}`);
check(
  "两者均为合法 JPEG",
  apiCmp.modern.magic?.[0] === 0xff && apiCmp.modern.magic?.[1] === 0xd8 &&
  apiCmp.vintage.magic?.[0] === 0xff && apiCmp.vintage.magic?.[1] === 0xd8,
  `magic=${(apiCmp.modern.magic || []).map((x) => x.toString(16)).join("")}`,
);
check(
  "era 两个取值返回的字节不同",
  apiCmp.modern.len !== apiCmp.vintage.len || apiCmp.modern.hash !== apiCmp.vintage.hash,
  `modern(len=${apiCmp.modern.len}, hash=${apiCmp.modern.hash}) vs ` +
    `vintage(len=${apiCmp.vintage.len}, hash=${apiCmp.vintage.hash})`,
);

// ---------------------------------------------------------------------------
console.log("\n--- 3. 点「古早画质」-> 生成拼图 -> 顶部漏光真的进成片 ---");
// 帧已在开头注入(见上)。此处直接切换 era 并生成。

// aria-pressed 是全仓库**只有** era 按钮才有的属性(见 DecoratePage.tsx),
// 所以可以拿它当 era 按钮的精确选择器 —— 不会误伤滤镜/相框那几排同构按钮。
await page.locator('button[aria-pressed]', { hasText: "古早画质" }).click();
await page.waitForTimeout(200);
const afterClick = await page.evaluate(() => {
  const title = [...document.querySelectorAll("div")].find(
    (d) => d.children.length === 0 && d.textContent.trim() === "年代画质",
  );
  const btns = [...(title?.closest("div.rounded-2xl")?.querySelectorAll("button") ?? [])];
  return btns.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent.trim());
});
check(
  "点击后「古早画质」成为选中态",
  afterClick.length === 1 && afterClick[0] === "古早画质",
  `aria-pressed=true: ${afterClick.join(",") || "(无)"}`,
);

const genBtn = page.getByRole("button", { name: "生成拼图" });
await genBtn.waitFor({ state: "visible", timeout: 15000 });
await genBtn.click();
// 4 帧各跑一次 era(OpenCV) + 一次拼图, 首次还可能加载 insightface 做
// 人脸焦点检测, 给足时间。
await page.waitForFunction(
  () => {
    const u = window.__store?.getState().layoutUrl;
    return typeof u === "string" && u.length > 0;
  },
  { timeout: 120000 },
);
const vintageUrl = await page.evaluate(() => window.__store.getState().layoutUrl);
const v = await page.evaluate(
  ([u, b]) => window.__sampleBands(u, b),
  [vintageUrl, BAND],
);

const vDelta = v.top.r - v.bottom.r;
console.log(`         拼图 ${v.w}x${v.h}  顶部 rgb(${v.top.r.toFixed(1)},${v.top.g.toFixed(1)},${v.top.b.toFixed(1)})` +
  `  底部 rgb(${v.bottom.r.toFixed(1)},${v.bottom.g.toFixed(1)},${v.bottom.b.toFixed(1)})`);
// 防假阳性: 底色是 128。若底/顶 R 接近 255, 说明取到了米色边距(255,248,240)
// 而不是照片内容 —— 那种情况下 delta 恒为大正, 断言会失去鉴别力。
const onPhoto = v.bottom.r < 240 && v.top.r < 240;
check("取样落在照片内容而非米色边距", onPhoto, `topR=${v.top.r.toFixed(1)} bottomR=${v.bottom.r.toFixed(1)}`);
check(
  "古早画质: 顶部 R 明显高于底部 R(漏光已烧进成片)",
  vDelta >= VINTAGE_MIN_DELTA,
  `ΔR=${vDelta.toFixed(1)} (阈值 ≥${VINTAGE_MIN_DELTA})`,
);

// ---------------------------------------------------------------------------
console.log("\n--- 4. 切回「现代高清」重新生成 -> 顶部不再有漏光 ---");
await page.locator('button[aria-pressed]', { hasText: "现代高清" }).click();
await page.waitForTimeout(200);
// 记下旧 URL 再等"变成另一个" —— 直接等 layoutUrl 非空会立刻命中上一张
// vintage 拼图, 拿到的是旧图, 断言 4 就成了永远为真的空检查。
const prevUrl = await page.evaluate(() => window.__store.getState().layoutUrl);
await genBtn.click();
await page.waitForFunction(
  (p) => {
    const u = window.__store?.getState().layoutUrl;
    return typeof u === "string" && u.length > 0 && u !== p;
  },
  prevUrl,
  { timeout: 120000 },
);
const modernUrl = await page.evaluate(() => window.__store.getState().layoutUrl);
check("生成了新的拼图(URL 已变化)", modernUrl !== prevUrl);
const m = await page.evaluate(
  ([u, b]) => window.__sampleBands(u, b),
  [modernUrl, BAND],
);
const mDelta = m.top.r - m.bottom.r;
console.log(`         拼图 ${m.w}x${m.h}  顶部 rgb(${m.top.r.toFixed(1)},${m.top.g.toFixed(1)},${m.top.b.toFixed(1)})` +
  `  底部 rgb(${m.bottom.r.toFixed(1)},${m.bottom.g.toFixed(1)},${m.bottom.b.toFixed(1)})`);
check("取样落在照片内容而非米色边距", m.bottom.r < 240 && m.top.r < 240, `topR=${m.top.r.toFixed(1)} bottomR=${m.bottom.r.toFixed(1)}`);
check(
  "现代高清: 顶部不再有漏光(ΔR 归零)",
  Math.abs(mDelta) <= MODERN_MAX_DELTA,
  `ΔR=${mDelta.toFixed(1)} (阈值 ≤${MODERN_MAX_DELTA})`,
);
// 交叉校验: 同一输入下 modern 顶部必须明显暗于 vintage 顶部, 且两者底部
// (都在漏光带之外) 基本齐平。底部齐平说明差异确实来自"顶部"而非整图偏色。
check(
  "交叉校验: vintage 顶部明显亮于 modern 顶部",
  v.top.r - m.top.r >= VINTAGE_MIN_DELTA,
  `vintage顶=${v.top.r.toFixed(1)} modern顶=${m.top.r.toFixed(1)}`,
);
check(
  "交叉校验: 两者底部基本齐平(差异只发生在顶部)",
  Math.abs(v.bottom.r - m.bottom.r) <= MODERN_MAX_DELTA,
  `vintage底=${v.bottom.r.toFixed(1)} modern底=${m.bottom.r.toFixed(1)}`,
);

console.log("\n--- 5. 无运行时错误 ---");
check("无 pageerror", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (e) {
  // 断言失败也要算失败, 且不吞异常信息 —— 崩溃若被静默处理, run-all-verify
  // 会把它显示成 (no summary) 而不是失败(它认退出码)。
  check("脚本主体未抛异常", false, String(e && e.message ? e.message : e));
} finally {
  /**
   * 清理 + 泄漏自检。**必须**在 finally 里。
   *
   * 本脚本有 3 处 120s waitForFunction, 超时是最常见的失败模式。清理若写成
   * 末尾的裸语句, 超时就会直接跳到脚本结束 —— 而此时第 1 次点击造出的
   * job 已经在 outputs/ 里躺着了。h.finish() 先 drain 在途登记(见
   * verifyHarness 的 watchCapturedJobs 注释), 再删已登记的, 最后拿退出时的
   * 快照减去 entrySnapshot 求差集: 任何漏网的新增目录/回收站条目/孤儿键
   * 都会被抓到, 不论它来自哪条路径。
   */
  await h.finish(entrySnapshot);
  await browser.close();
  h.report();
}
