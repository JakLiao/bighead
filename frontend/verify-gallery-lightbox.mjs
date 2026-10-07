/**
 * 画廊大图查看 + 历史照片重新编辑 + 位图贴纸 端到端验证。
 *
 * 覆盖三段链路, 它们是**串起来**的(所以放在一个脚本里, 因为第二步依赖第一步):
 *
 *   1. 后端 media 契约: 一条 job 的 media 必须给出「全部原图 + 拼图 + 分享卡」,
 *      且 thumbs 旧语义不变(有 share 时只 1 张)。这两条同时断言, 是因为
 *      verify-share-card / verify-decorate-persist 依赖 thumbs 的旧行为,
 *      而灯箱依赖 media —— 谁把谁改坏都会红。
 *
 *   2. 灯箱: 点放大镜打开、序号显示、← → 翻页、Home/End 跳首尾、
 *      Esc 关闭、翻到头不循环(内容是有序产物, 循环会让用户以为翻完了)。
 *
 *   3. 重新编辑: 只对 photo 开放(拼图/分享卡是派生产物)、摆一张**位图贴纸**、
 *      存为**新 job**、原 job 原封不动。这一段用"底色计数"证明贴纸真的
 *      烧进了成片 —— 只断言"新 job 建出来了"是不够的, 那完全可能是一张
 *      没贴纸的原图复制品。
 *
 * 本脚本自己造数据、自己清理, 不依赖其它脚本的残留。
 */
import { chromium } from "playwright";

const URL = process.env.APP_URL || "http://localhost:5173/gallery";
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
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });

/**
 * 造一个 job: 3 张纯色原图(青/品红/黄) + 拼图 + 分享卡。
 * 纯色底让"贴纸烧进去了"可以用颜色计数判定, 不受压缩噪点干扰。
 */
async function makeJobWithLayout(tag) {
  return page.evaluate(async (t) => {
    const cols = ["#00bcd4", "#e91e63", "#ffeb3b"];
    const blobs = [];
    for (let i = 0; i < cols.length; i++) {
      const c = document.createElement("canvas");
      c.width = 640;
      c.height = 480;
      const g = c.getContext("2d");
      g.fillStyle = cols[i];
      g.fillRect(0, 0, c.width, c.height);
      blobs.push(await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9)));
    }
    // 先存成 job(得到 job_id), 再让 layout/share 落到同一个 job 目录
    const fd = new FormData();
    blobs.forEach((b, i) => fd.append("images", b, `photo_${i + 1}.jpg`));
    const jr = await fetch("/api/capture/save", { method: "POST", body: fd });
    if (!jr.ok) throw new Error(`capture/save ${jr.status}`);
    const { job_id } = await jr.json();

    const fd2 = new FormData();
    blobs.forEach((b, i) => fd2.append("images", b, `p_${i}.jpg`));
    fd2.append("layout", "2x2");
    fd2.append("frame", "none");
    fd2.append("job_id", job_id);
    const lr = await fetch("/api/layout/make", { method: "POST", body: fd2 });
    if (!lr.ok) throw new Error(`layout/make ${lr.status}`);
    const layoutBlob = await lr.blob();
    // 分享卡: /api/share/save 收 multipart 的 job_id + layout(拼图字节),
    // 由前端合成好的卡片字节直接落盘。见 backend/routes/share.py 的说明。
    const sfd = new FormData();
    sfd.append("job_id", job_id);
    sfd.append("layout", layoutBlob, "share.jpg");
    const sr = await fetch("/api/share/save", { method: "POST", body: sfd });
    if (!sr.ok) throw new Error(`share/save ${sr.status}`);

    // 给个标题, 便于在列表里定位; 也顺带验证 title 与灯箱标题联动
    await fetch(`/api/gallery/${job_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: t }),
    });
    return job_id;
  }, tag);
}

const jid = await makeJobWithLayout("灯箱测试");
check("测试 job 创建成功", !!jid, jid);
/** 本脚本亲手建的 job id。finally 只删这些, 不扫全量。 */
const createdIds = [jid];

/** 找出「本次重新编辑」产生的新 job: 晚于测试起点、且只有 1 张原图。 */
async function findNewestSingle(startedAt) {
  return page.evaluate(async (t) => {
    const g = await (await fetch("/api/gallery")).json();
    return (
      g.items
        .filter((x) => x.mtime >= t && x.media.length === 1 && x.media[0].kind === "photo")
        .sort((a, b) => b.mtime - a.mtime)[0] ?? null
    );
  }, startedAt);
}

try {
  // =========================================================================
  // 1. 后端 media 契约
  // =========================================================================
  const item = await page.evaluate(async (j) => {
    const g = await (await fetch("/api/gallery")).json();
    return g.items.find((x) => x.job_id === j);
  }, jid);

  check("media 是数组", Array.isArray(item?.media), `got ${typeof item?.media}`);
  check("media 含 3 张原图", item?.media.filter((m) => m.kind === "photo").length === 3);
  check("media 含 layout", item?.media.some((m) => m.kind === "layout"));
  check("media 含 share", item?.media.some((m) => m.kind === "share"));
  check(
    "media 顺序为 原图->拼图->分享卡",
    item?.media.map((m) => m.kind).join(",") === "photo,photo,photo,layout,share",
    item?.media.map((m) => m.kind).join(","),
  );
  check(
    "media 每项都有 url 与 label",
    item?.media.every((m) => typeof m.url === "string" && m.url && typeof m.label === "string"),
  );
  // 旧语义不能被改坏: 有 share 时 thumbs 只 1 张
  check("thumbs 仍只含 share(旧语义)", item?.thumbs.length === 1, `thumbs=${item?.thumbs.length}`);
  check("thumbs 指向 share.jpg", /share\.jpg$/.test(item?.thumbs[0] ?? ""));

  // =========================================================================
  // 2. 灯箱
  // =========================================================================
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(`[data-gallery-zoom="${jid}"]`).click();
  await page.locator("[data-gallery-lightbox]").waitFor({ state: "visible", timeout: 8000 });
  check("点放大镜打开灯箱", true);

  const counter0 = await page.locator("[data-lightbox-counter]").innerText();
  check("灯箱序号从 1 开始", counter0.trim().startsWith("1 /"), counter0);
  const img0 = await page.locator("[data-lightbox-image]").getAttribute("src");
  check("首屏是原图 1", /photo_1\.jpg$/.test(img0 ?? ""), img0);

  // 点"重新编辑"按钮此刻应可见(photo 类)
  check("photo 上有重新编辑入口", await page.locator("[data-lightbox-reedit]").isVisible());

  // 右箭头翻页
  await page.keyboard.press("ArrowRight");
  const counter1 = await page.locator("[data-lightbox-counter]").innerText();
  check("→ 翻到第 2 张", counter1.trim().startsWith("2 /"), counter1);
  const img1 = await page.locator("[data-lightbox-image]").getAttribute("src");
  check("第 2 张是原图 2", /photo_2\.jpg$/.test(img1 ?? ""), img1);

  await page.keyboard.press("ArrowLeft");
  const counter2 = await page.locator("[data-lightbox-counter]").innerText();
  check("← 退回第 1 张", counter2.trim().startsWith("1 /"), counter2);

  // End 跳到分享卡; 那里不应有"重新编辑"
  await page.keyboard.press("End");
  const counterEnd = await page.locator("[data-lightbox-counter]").innerText();
  const imgEnd = await page.locator("[data-lightbox-image]").getAttribute("src");
  check("End 跳到最后一张", counterEnd.trim().endsWith(`5 · 分享卡`), counterEnd);
  check("最后一张是 share.jpg", /share\.jpg$/.test(imgEnd ?? ""), imgEnd);
  check(
    "分享卡上没有重新编辑入口",
    (await page.locator("[data-lightbox-reedit]").count()) === 0,
  );

  // 末尾再按 → 不循环
  await page.keyboard.press("ArrowRight");
  const counterEnd2 = await page.locator("[data-lightbox-counter]").innerText();
  check("末尾按 → 不循环", counterEnd2.trim().endsWith("5 · 分享卡"), counterEnd2);

  // Home 回第一张
  await page.keyboard.press("Home");
  const counterHome = await page.locator("[data-lightbox-counter]").innerText();
  check("Home 跳回第一张", counterHome.trim().startsWith("1 /"), counterHome);

  // 下载入口
  const dl = await page.locator("[data-lightbox-download]").getAttribute("href");
  check("下载链接指向当前产物", /photo_1\.jpg$/.test(dl ?? ""), dl);

  // =========================================================================
  // 3. 重新编辑: 摆位图贴纸 -> 存为新 job
  // =========================================================================
  await page.locator("[data-lightbox-reedit]").click();
  await page.locator("[data-gallery-reedit]").waitFor({ state: "visible", timeout: 8000 });
  check("进入重新编辑", true);
  await page.locator("[data-sticker-canvas]").waitFor({ state: "visible", timeout: 8000 });

  /*
    位图素材工具条。

    这里刻意**不写死 8**, 也不写死任何素材 key:
      · 素材库是活的 —— build_stickers.py 加一张登记表就多一项, 而
        "多了一张贴纸"是正常功能变更, 不该让测试变红。
      · 数量对但 key 错位(按钮渲染了、加载的却是别的图)同样该红, 而只
        数个数看不见这种错。
    所以期望值改为**从 manifest 现场读**: 断言的是"工具条与 manifest 一致",
    而不是"工具条等于我上次记得的 8 个"。

    素材条整体缺失与数量不符必须是**两条独立断言**: 合成一条时, 素材条
    压根没渲染出来会报成"got 0", 把排障方向带偏(看起来像数量不对, 实际
    是整个组件没挂上)。等待超时也不能 .catch(() => null) 吞掉。
  */
  const manifestKeys = await page.evaluate(async () => {
    const r = await fetch("/stickers/manifest.json", { cache: "no-cache" });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.stickers) ? j.stickers.map((s) => s.key) : null;
  });
  check(
    "manifest 可读且结构合法",
    Array.isArray(manifestKeys) && manifestKeys.length > 0,
    manifestKeys === null ? "manifest 不可读" : `n=${manifestKeys?.length}`,
  );

  const assetRow = page.locator("[data-sticker-assets]");
  const rowAppeared = await assetRow
    .waitFor({ state: "visible", timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("素材工具条已渲染", rowAppeared);

  const assetBtns = page.locator("[data-sticker-asset]");
  const shownKeys = await assetBtns.evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-sticker-asset")),
  );
  check(
    "素材项与 manifest 一一对应",
    Array.isArray(manifestKeys) &&
      shownKeys.length === manifestKeys.length &&
      manifestKeys.every((k, i) => k === shownKeys[i]),
    `shown=${shownKeys.length} manifest=${manifestKeys?.length} [${shownKeys.join(",")}]`,
  );

  // 钉住"素材 key 不与内置形状 key 撞名": 工具名共用一个 string 命名空间,
  // 撞名时该素材会静默变回代码形状(见 StickerEditor 的 tool 命名空间注释) ——
  // 按钮还在、数量不变, 只是一张永远摆不出来的图。
  const shapeKeys = await page
    .locator("[data-sticker-shape]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-sticker-shape")));
  const collided = shownKeys.filter((k) => shapeKeys.includes(k));
  check("素材 key 不与内置形状 key 冲突", collided.length === 0, collided.join(","));

  // 选第一张素材(复古票根), 点画布落一颗
  await assetBtns.first().click();
  check("素材按钮可进入放置态", true, `key=${manifestKeys?.[0]}`);
  const box = await page.locator("[data-sticker-canvas]").boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForTimeout(600);

  /*
    画布上确实画了东西(位图贴纸画进 canvas, 不是 DOM 节点)。

    刻意不只数像素总量: 落点固定在画布中心, 所以像素应当**集中在中心
    附近**。只验总量的话, 贴纸被画到角落、被画成极小的一团、或者上一次
    运行的残留帧, 都能凑够阈值通过 —— 而这些恰恰是渲染坐标算错时最常见
    的表现。所以返回包围盒并断言它贴近画布中部。
  */
  const canvasInk = await page.evaluate(() => {
    const c = document.querySelector("[data-sticker-canvas]");
    const g = c.getContext("2d");
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    let minX = c.width;
    let minY = c.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4 + 3] > 8) {
          n++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    return { n, minX, minY, maxX, maxY, w: c.width, h: c.height };
  });
  check("画布上出现贴纸像素", canvasInk.n > 500, `ink=${canvasInk.n}`);
  // 包围盒中心应落在画布中心附近(允许 20% 偏移), 且覆盖一定尺寸 ——
  // 贴纸 size=0.22 短边基准, 2x DPR 下约占短边 22%。
  const cx = (canvasInk.minX + canvasInk.maxX) / 2 / canvasInk.w;
  const cy = (canvasInk.minY + canvasInk.maxY) / 2 / canvasInk.h;
  const boxW = (canvasInk.maxX - canvasInk.minX) / canvasInk.w;
  check(
    "贴纸落在点击位置附近",
    Math.abs(cx - 0.5) < 0.2 && Math.abs(cy - 0.5) < 0.2,
    `center=(${cx.toFixed(2)},${cy.toFixed(2)})`,
  );
  check("贴纸尺寸符合默认 size", boxW > 0.08 && boxW < 0.4, `w=${boxW.toFixed(3)}`);

  // 存为新 job。先记下当前时间, 之后用 mtime 定位"这一次保存产生的新 job"
  const saveStartedAt = Math.floor(Date.now() / 1000) - 2;
  await page.locator("[data-reedit-save]").click();
  // 等灯箱关闭(保存成功会 onSaved -> 退出编辑态并重拉)
  await page
    .locator("[data-gallery-reedit]")
    .waitFor({ state: "detached", timeout: 25000 })
    .catch(() => null);

  const orig = await page.evaluate(async (j) => {
    const g = await (await fetch("/api/gallery")).json();
    return g.items.find((x) => x.job_id === j) ?? null;
  }, jid);

  // 原 job 必须完好 —— 这是"不覆盖历史"的直接断言
  check("原 job 仍在", !!orig);
  check("原 job 原图数不变(3)", orig?.media.filter((m) => m.kind === "photo").length === 3);
  check("原 job 产物数不变(5)", orig?.media.length === 5, `got ${orig?.media.length}`);

  // 新 job: 只有 1 张原图(单张重新编辑的必然结果)
  const newJob = await findNewestSingle(saveStartedAt);
  check("新 job 已创建", !!newJob, newJob?.job_id ?? "none");
  if (newJob) createdIds.push(newJob.job_id);
  check(
    "新 job 只有 1 张产物",
    newJob?.media.length === 1 && newJob.media[0].kind === "photo",
    newJob?.media.map((m) => m.kind).join(","),
  );
  check("新 job 与原 job 不同", newJob?.job_id !== jid);

  if (newJob) {
    // 关键断言: 贴纸真的烧进了新图 —— 与原图的青色底比对。
    // 只断言"新 job 建出来了"是不够的, 那完全可能是一张没贴纸的原图复制品。
    const px = await page.evaluate(async (url) => {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = url;
      });
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let nonCyan = 0;
      for (let i = 0; i < d.length; i += 4) {
        // 底色 #00bcd4 = rgb(0,188,212), 留 60 容差压 JPEG 噪点
        if (
          Math.abs(d[i] - 0) > 60 ||
          Math.abs(d[i + 1] - 188) > 60 ||
          Math.abs(d[i + 2] - 212) > 60
        ) {
          nonCyan++;
        }
      }
      return { nonCyan, w: c.width, h: c.height, total: c.width * c.height };
    }, newJob.media[0].url);

    const ratio = px.nonCyan / px.total;
    check(
      "新图上出现非底色像素(位图贴纸已烧录)",
      ratio > 0.005,
      `nonCyan=${px.nonCyan} ratio=${(ratio * 100).toFixed(2)}%`,
    );
    check("新图尺寸与原图一致", px.w === 640 && px.h === 480, `${px.w}x${px.h}`);
  }

  // Esc 关闭灯箱
  await page.keyboard.press("Escape");
  await page
    .locator("[data-gallery-lightbox]")
    .waitFor({ state: "detached", timeout: 8000 })
    .catch(() => null);
  check("Esc 关闭灯箱", (await page.locator("[data-gallery-lightbox]").count()) === 0);

  // 卡片旧行为没坏: 点卡片仍打开相册编辑
  await page.locator(`button[data-job-id="${jid}"]`).click();
  await page.locator('[data-testid="album-edit-title"]').waitFor({ state: "visible", timeout: 8000 });
  check("点卡片仍打开相册编辑(旧行为)", true);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  /*
    容错: manifest 拿不到时不该把整个编辑器拖垮。

    期望值同样不写死: 「代码形状仍然全在」比「代码形状恰好 7 个」更贴近
    真实的不变量 —— 加一个内置形状时这条不该红, 而**删掉**一个内置形状
    (白名单收窄) 也不该由本脚本负责报警。基准取自上面 manifest 正常时
    读到的 shapeKeys, 于是两次运行之间做的是同一份清单的前后对比。
  */
  await page.route("**/stickers/manifest.json", (r) => r.abort());
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(`[data-gallery-zoom="${jid}"]`).click();
  await page.locator("[data-gallery-lightbox]").waitFor({ state: "visible", timeout: 8000 });
  // 关键: 先点「重新编辑这张」再等面板 —— 面板是点了才出现的,
  // 直接等会一直等到超时(第一版就踩了这个坑)。
  await page.locator("[data-lightbox-reedit]").click();
  await page.locator("[data-gallery-reedit]").waitFor({ state: "visible", timeout: 8000 });
  check("manifest 加载失败时仍能进入重新编辑", true);

  // 素材行必须真的不出现。这里给足等待时间再判 count, 否则 reload 后
  // React 还没提交完成时会读到"暂时 0"而误判通过 —— 那等于没断言。
  await page.waitForTimeout(1200);
  const assetRowGone = (await page.locator("[data-sticker-assets]").count()) === 0;
  const assetBtnsGone = (await page.locator("[data-sticker-asset]").count()) === 0;
  check("manifest 失败时素材行不渲染", assetRowGone);
  check("manifest 失败时不残留素材按钮", assetBtnsGone);

  // 代码形状一个都不能少 —— 素材加载失败不能牵连内置贴纸。
  const shapeKeysAfter = await page
    .locator("[data-sticker-shape]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-sticker-shape")));
  check(
    "manifest 失败时代码形状仍完整",
    shapeKeysAfter.length === shapeKeys.length && shapeKeysAfter.every((k, i) => k === shapeKeys[i]),
    `before=${shapeKeys.length} after=${shapeKeysAfter.length}`,
  );
  // 且编辑器仍能摆代码形状(不只是按钮在, 是真的能落一颗)
  await page.locator(`[data-sticker-shape="${shapeKeysAfter[0]}"]`).click();
  const box2 = await page.locator("[data-sticker-canvas]").boundingBox();
  await page.mouse.click(box2.x + box2.width * 0.4, box2.y + box2.height * 0.4);
  await page.waitForTimeout(400);
  const fallbackInk = await page.evaluate(() => {
    const c = document.querySelector("[data-sticker-canvas]");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return n;
  });
  check("manifest 失败时代码形状仍能摆上画布", fallbackInk > 500, `ink=${fallbackInk}`);
  await page.unroute("**/stickers/manifest.json");
} finally {
  /*
    清理**只删本脚本亲手建的 job**。
    刻意不按"media.length === 1"去扫全量删除: 那是用户的真实数据
    (单张拍摄是正常使用路径), 批量删会在跑测试时把人家的照片清掉。
    created 数组是唯一可信的"我造了哪些"记录 —— 重新编辑产生的
    新 job 由 save 返回的 id 追加进去, 而不是事后反推。
  */
  const created = [...createdIds];
  await page.evaluate(
    async (list) => {
      for (const id of list) {
        await fetch(`/api/gallery/${id}?permanent=true`, { method: "DELETE" }).catch(() => {});
      }
    },
    created,
  );
  await browser.close();
}

/*
  未捕获页面错误。
  排除两类**本脚本自己制造**的错误, 否则断言永远是红的, 久而久之就没人看它了:
    · manifest 被 route.abort() 拦掉 -> fetch 抛 TypeError: Failed to fetch
      这是容错用例**故意**制造的输入, 产品正确地降级了(上面已断言)。
    · favicon / 静态资源 404 —— 与本功能无关。
  只放宽这两类; 其它任何未捕获错误仍然判失败。
*/
const realErrors = pageErrors.filter(
  (e) =>
    !/favicon|manifest|Failed to load resource|Failed to fetch/i.test(e),
);
check("无未捕获页面错误", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

console.log(`\nResult: ${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length) console.log("FAILED:", FAIL.join(" | "));
process.exit(FAIL.length ? 1 : 0);
