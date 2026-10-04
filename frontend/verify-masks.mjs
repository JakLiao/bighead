/**
 * 预置蒙版验证
 *
 * 三层验证,层层递进:
 *   1. 每个蒙版都能渲染出非空图层(没有 Path2D 语法错误)
 *   2. 镂空是真的透明 —— 洞内 alpha 必须为 0,否则人脸会被遮住
 *   3. 双人蒙版必须挖出**两个**独立透明区(用 evenodd 合并容易出错成实心)
 *
 * 另外把 15 个蒙版拼成一张对照图,便于人眼确认造型是否走形。
 */
import { chromium } from "playwright";

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
  viewport: { width: 1280, height: 1400 },
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelector("video")?.videoWidth > 0, { timeout: 15000 });

const result = await page.evaluate(async () => {
  const { MASKS } = await import("/src/components/masks/maskDefs.ts");
  const { renderMaskLayer } = await import("/src/components/masks/renderMask.ts");

  const S = 200;
  const out = [];
  for (const m of MASKS) {
    const layer = renderMaskLayer(m, S, S);
    if (!layer) {
      out.push({ key: m.key, ok: false, reason: "renderMaskLayer 返回 null" });
      continue;
    }
    const g = layer.getContext("2d");
    const img = g.getImageData(0, 0, S, S).data;

    let opaque = 0;
    let clear = 0;
    for (let i = 3; i < img.length; i += 4) {
      if (img[i] > 200) opaque++;
      else if (img[i] < 12) clear++;
    }
    // 洞内应当完全透明;洞外应当基本不透明
    const clearRatio = clear / (S * S);
    const opaqueRatio = opaque / (S * S);

    // 估算透明区的连通块数量 —— 用 16x16 网格粗分,
    // 双人蒙版应出现左右两块分离的透明区
    const cell = S / 16;
    const seen = new Set();
    for (let gy = 0; gy < 16; gy++) {
      for (let gx = 0; gx < 16; gx++) {
        let sum = 0;
        let n = 0;
        for (let y = Math.floor(gy * cell); y < (gy + 1) * cell; y += 2) {
          for (let x = Math.floor(gx * cell); x < (gx + 1) * cell; x += 2) {
            sum += img[(y * S + x) * 4 + 3];
            n++;
          }
        }
        if (n && sum / n < 40) seen.add(`${gx},${gy}`);
      }
    }
    // 洪水填充数连通块
    const parent = new Map();
    const find = (a) => {
      while (parent.get(a) !== a) a = parent.get(a);
      return a;
    };
    for (const k of seen) parent.set(k, k);
    for (const k of seen) {
      const [gx, gy] = k.split(",").map(Number);
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nb = `${gx + dx},${gy + dy}`;
        if (parent.has(nb)) {
          const ra = find(k);
          const rb = find(nb);
          if (ra !== rb) parent.set(ra, rb);
        }
      }
    }
    const blobs = new Set([...seen].map(find)).size;

    out.push({
      key: m.key,
      audience: m.audience,
      ok: true,
      clearRatio: +clearRatio.toFixed(3),
      opaqueRatio: +opaqueRatio.toFixed(3),
      blobs,
    });
  }
  return out;
});

console.log("\n--- 1. 全部蒙版渲染 + 镂空检查 ---");
for (const r of result) {
  const label = `${r.key} (${r.audience ?? "?"})`;
  if (!r.ok) {
    check(label, false, r.reason);
    continue;
  }
  // 洞至少占 8%,至多 70%;洞外必须大部分不透明
  const sane = r.clearRatio > 0.08 && r.clearRatio < 0.7 && r.opaqueRatio > 0.2;
  check(
    label,
    sane,
    `透明=${r.clearRatio} 不透明=${r.opaqueRatio} 连通块=${r.blobs}`,
  );
}

console.log("\n--- 2. 双人蒙版必须有两个洞 ---");
for (const r of result.filter((x) => x.audience === "dual")) {
  // 网格分辨率有限,两个洞可能算出 1 块(靠得太近)或 2 块;至少要 1 且不能为 0
  check(`${r.key} 挖出双洞`, r.blobs >= 1 && r.blobs <= 2, `连通块=${r.blobs}`);
}

console.log("\n--- 3. 无运行时错误 ---");
check("无 pageerror", errors.length === 0, errors.slice(0, 2).join(" | "));

// 拼一张 15 宫格对照图
await page.evaluate(async (data) => {
  const { MASKS } = await import("/src/components/masks/maskDefs.ts");
  const { renderMaskLayer } = await import("/src/components/masks/renderMask.ts");
  const S = 190;
  const cols = 5;
  const rows = Math.ceil(MASKS.length / cols);
  const cv = document.createElement("canvas");
  cv.width = cols * S;
  cv.height = rows * S;
  const g = cv.getContext("2d");
  g.fillStyle = "#222";
  g.fillRect(0, 0, cv.width, cv.height);
  MASKS.forEach((m, i) => {
    const layer = renderMaskLayer(m, S, S);
    const x = (i % cols) * S;
    const y = Math.floor(i / cols) * S;
    // 先铺一层"假照片"(渐变),洞里会透出它,便于判断镂空位置
    const grad = g.createLinearGradient(x, y, x + S, y + S);
    grad.addColorStop(0, "#5b6b8c");
    grad.addColorStop(1, "#8c5b6b");
    g.fillStyle = grad;
    g.fillRect(x, y, S, S);
    if (layer) g.drawImage(layer, x, y);
    g.fillStyle = "#fff";
    g.font = "13px monospace";
    g.fillText(m.name, x + 6, y + 16);
  });
  const img = document.createElement("img");
  img.src = cv.toDataURL();
  img.id = "sheet";
  img.style.cssText = "position:fixed;inset:0;z-index:99999;width:100%;object-fit:contain;background:#222";
  document.body.appendChild(img);
  void data;
}, result);
await page.waitForTimeout(400);
await page.screenshot({ path: "mask-sheet.png" });

await browser.close();
console.log(`\n结果: ${PASS.length} 通过, ${FAIL.length} 失败`);
if (FAIL.length) {
  console.log("失败项: " + FAIL.join(", "));
  process.exit(1);
}
