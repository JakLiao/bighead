/**
 * 画廊分页 + 批量删除 端到端验证。
 *
 * 覆盖：
 *  1. 后端分页契约：limit/offset/total/has_more、跨页不重不漏、tags 基于全集
 *  2. 后端批量删除：真删 / missing / failed 三类分开报告、重复 id 去重
 *  3. 前端首屏只渲染一页，且有「加载更多」兜底按钮
 *  4. 前端点「加载更多」能追加下一页（而不是替换）
 *  5. 前端多选：全选、单选切换、计数、两段式确认
 *  6. 前端批量删除后列表真的少了对应条目
 *
 * 注：本脚本自己造数据、自己清理，不依赖其他脚本的残留，
 * 也不会碰用户已有的 job（清理只针对 createdIds）。
 */
import { chromium } from "playwright";

// 刻意**不叫 URL**: 本文件后面要用 `new URL(...)` 解析请求 url,
// 而 const URL = "..." 会遮蔽全局 URL 构造器, 表现为
// "TypeError: URL is not a constructor" —— 一个与被测功能毫无关系的崩溃。
const PAGE_URL = process.env.APP_URL || "http://localhost:5173/gallery";
/**
 * 后端 API 基址, **含 `/api` 前缀**。
 *
 * 踩过的坑: 早先这里只写 "http://127.0.0.1:8077", 调用处拼 `${API}/gallery/...`,
 * 结果少了 `/api` —— 请求打到 `http://127.0.0.1:8077/gallery/batch-delete`,
 * FastAPI 找不到路由, 返回 **404**。
 *
 * 404 而不是"连接被拒"让排查绕了远路: curl 和 PowerShell 手测同一地址是 200,
 * 只有脚本里的请求失败, 于是怀疑过 URL 遮蔽、服务进程、后端重启……
 * 教训: 把前缀收进这个常量, 让调用处无法拼错 —— 少一个前缀的表现是
 * "路由不存在", 而它是**静默**的(fetch 不抛异常, 只有 r.ok 为 false)。
 */
const API = "http://127.0.0.1:8077/api";
const OUT_DIR = "f:/Trae-work/bighead/outputs";

/**
 * 本脚本造过的 job id。**必须声明在 makeJobOnDisk 之前** ——
 * 那函数体里会 created.push(id), 而它定义在下面。const 有 TDZ,
 * 谁把这条声明"顺手挪到脚本中间"就会踩到。
 * 位置放在文件顶部是刻意的: 让依赖方向单向(顶部数据 → 下方逻辑)。
 */
const created = [];
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
  viewport: { width: 1280, height: 900 },
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", e));

await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });

/**
 * 造 job。**不依赖 canvas** —— 用 Node 侧直接写文件更简单, 且不占用页面。
 * 但这会绕过 /api/capture/save, 所以只用来测「磁盘上多一个目录时
 * 画廊怎么表现」, 真实拍摄链路由其它脚本覆盖。
 */
async function makeJobOnDisk(tag) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  for (let i = 0; i < 40; i++) {
    const id = `${tag}${Date.now().toString(36)}${i}`;
    const full = path.join(OUT_DIR, id);
    try {
      await fs.mkdir(full, { recursive: false });
    } catch {
      continue;
    }
    // 1x1 JPEG。必须是真图: _pick_media 只查文件名不校验内容,
    // 但前端 <img> 会因解码失败触发 onerror, 让后续断言失真。
    const jpg = Buffer.from(
      "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
        "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
        "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
      "base64",
    );
    await fs.writeFile(path.join(full, "photo_1.jpg"), jpg);
    /**
     * 自己登记进 created, 而不是指望调用方记得 push。
     *
     * 早先是在调用方 `created.push(id)`, 而 makeJobOnDisk 有 8 处调用点,
     * 漏了 6 处 —— 于是 cleanupDisk 收到的数组缺了大半, 清理静默空转:
     * 跑完一轮, 回收站里留下 3 条 bt* 残留, _album.json 里留下十几个
     * 孤儿键, 而脚本全程 0 失败。**测试数据没清干净, 且没有任何断言会发现**。
     *
     * 登记的责任必须落在"造数据的那个函数"里, 因为它是唯一知道
     * "有个东西需要被清理"的地方。
     */
    created.push(id);
    return id;
  }
  throw new Error("makeJobOnDisk 未能创建唯一目录");
}

/**
 * 清理本次造的记录。
 *
 * 四处细节, 少一处就会留下垃圾:
 *
 * 1. 走 **batch-delete API** 而不是 `fs.rm`: 这些 job 被 PATCH 过,
 *    元数据在 outputs/_album.json 里, fs.rm 会留下永久孤儿键。
 * 2. 必须带 `permanent: true`。删除已改成软删除(进回收站), 用默认参数
 *    会把它们留在回收站里 —— 下次跑脚本时列表里就有前一次的残留。
 * 3. 源目录可能已经不在了(被本脚本前面的删除步骤搬进 _trash), 此时
 *    batch-delete 走 missing 分支, **清不到回收站里那一份**, 所以还要
 *    逐个 purge。
 * 4. 少任何一条都会让"清空前回收站恰有 N 条"这类精确计数断言失败,
 *    而且失败原因看起来毫不相关(像是被测功能坏了)。
 */
async function cleanupDisk(ids) {
  if (!ids.length) return;
  try {
    await fetch(`${API}/gallery/batch-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_ids: ids, permanent: true }),
    });
    for (const id of ids) {
      // 源目录已不在时返回 404; 还在回收站里才会成功。
      await fetch(`${API}/gallery/trash/${id}/purge`, { method: "POST" }).catch(() => {});
    }
  } catch {
    // 服务不可用时退回直接删目录: 留孤儿键比留测试目录好, 但两者都不该发生。
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    for (const id of ids) {
      await fs.rm(path.join(OUT_DIR, id), { recursive: true, force: true }).catch(() => {});
    }
  }
}

try {
  // ===================== 后端分页契约 =====================
  const all0 = await page.evaluate(async () => (await fetch("/api/gallery")).json());
  check("GET 返回 total 字段", typeof all0.total === "number", String(all0.total));
  check("GET 返回 has_more 字段", typeof all0.has_more === "boolean", String(all0.has_more));
  check(
    "不分页时 items.length === total",
    all0.items.length === all0.total,
    `${all0.items.length} vs ${all0.total}`,
  );
  check("不分页时 has_more=false", all0.has_more === false, String(all0.has_more));

  const p1 = await page.evaluate(async () =>
    (await fetch("/api/gallery?limit=5&offset=0")).json(),
  );
  check("limit 生效: items 恰好 5 条", p1.items.length === 5, String(p1.items.length));
  check("total 是全集而非当页", p1.total === all0.total, `${p1.total} vs ${all0.total}`);
  check("还有更多时 has_more=true", p1.has_more === true, String(p1.has_more));

  const pLast = await page.evaluate(
    async (t) => (await fetch(`/api/gallery?limit=5&offset=${Math.max(0, t - 2)}`)).json(),
    p1.total,
  );
  check("最后一页 has_more=false", pLast.has_more === false, String(pLast.has_more));

  const pOver = await page.evaluate(
    async (t) => (await fetch(`/api/gallery?limit=5&offset=${t + 500}`)).json(),
    p1.total,
  );
  check("offset 越界返回空 items", pOver.items.length === 0, String(pOver.items.length));
  check("offset 越界 has_more=false", pOver.has_more === false, String(pOver.has_more));

  const pNeg = await page.evaluate(async () => (await fetch("/api/gallery?limit=-5&offset=-9")).json());
  check("负数 limit/offset 不 500", Array.isArray(pNeg.items), JSON.stringify(pNeg).slice(0, 80));

  // 跨页不重不漏：走完全部分页, 与不分页的全集比对
  const walk = await page.evaluate(async () => {
    const seen = [];
    let off = 0;
    for (;;) {
      const r = await (await fetch(`/api/gallery?limit=24&offset=${off}`)).json();
      seen.push(...r.items.map((x) => x.job_id));
      if (!r.has_more) break;
      off += 24;
      if (off > 5000) break;
    }
    return seen;
  });
  check(
    "分页走完的条数 === total",
    walk.length === all0.total,
    `${walk.length} vs ${all0.total}`,
  );
  check("分页走完无重复", new Set(walk).size === walk.length, `${new Set(walk).size}/${walk.length}`);
  const missingIds = all0.items.map((x) => x.job_id).filter((x) => !walk.includes(x));
  check("分页走完无遗漏", missingIds.length === 0, missingIds.slice(0, 3).join(","));

  // tags 基于筛选后全集, 而不是当页 —— 否则筛选条会随滚动抖动
  // 刻意用**短**标签: 后端 ALBUM_MAX_TAG=16 会静默截断超长标签,
  // 早先这里用 18 字符的 tagProbe, 写入时被截成 16, 再拿 18 字符去查
  // 自然查不到 —— 看起来像"汇总功能坏了", 实际是脚本自己造了超限数据。
  const tagProbe = `pt${Date.now().toString(36).slice(-8)}`;
  check("测试标签未超 ALBUM_MAX_TAG(16)", tagProbe.length <= 16, `${tagProbe.length}: ${tagProbe}`);
  const taggedId = await makeJobOnDisk("pt");
  await page.evaluate(
    async ({ id, t }) => {
      await fetch(`/api/gallery/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: [t] }),
      });
    },
    { id: taggedId, t: tagProbe },
  );
  const tagPage = await page.evaluate(
    async (t) => (await fetch(`/api/gallery?tag=${encodeURIComponent(t)}&limit=1&offset=0`)).json(),
    tagProbe,
  );
  check(
    "tags 汇总基于全集而非当页（limit=1 仍能数出全量）",
    tagPage.tags.some((x) => x.tag === tagProbe && x.count >= 1),
    JSON.stringify(tagPage.tags),
  );
  check("limit=1 时 items 只有 1 条", tagPage.items.length === 1, String(tagPage.items.length));

  // ===================== 后端批量删除契约 =====================
  const batchIds = [];
  for (let i = 0; i < 3; i++) batchIds.push(await makeJobOnDisk("bt"));
  const beforeBatch = (await page.evaluate(async () => (await fetch("/api/gallery")).json())).total;

  const batchRes = await page.evaluate(
    async (ids) => {
      const r = await fetch("/api/gallery/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 混入: 一个真删过的(stale)、一个非法 id、以及 batchIds[0] 的重复项
        body: JSON.stringify({ job_ids: [...ids, "definitely_not_here_zz", "..", ids[0]] }),
      });
      return { status: r.status, body: await r.json() };
    },
    batchIds,
  );
  check("batch-delete 返回 200", batchRes.status === 200, `got ${batchRes.status}`);
  check(
    "三条真删掉",
    batchRes.body.deleted.length === 3 && batchRes.body.deleted_count === 3,
    JSON.stringify(batchRes.body.deleted),
  );
  check(
    "重复 id 被去重（不会重复计数）",
    batchRes.body.deleted.filter((x) => x === batchIds[0]).length === 1,
    JSON.stringify(batchRes.body.deleted),
  );
  check("不存在的 id 归入 missing", batchRes.body.missing.includes("definitely_not_here_zz"),
    JSON.stringify(batchRes.body.missing));
  check(
    "非法 id 归入 failed 而非整批失败",
    batchRes.body.failed.some((x) => x.job_id === ".."),
    JSON.stringify(batchRes.body.failed),
  );
  check(
    "failed 条目带原因",
    batchRes.body.failed.every((x) => typeof x.error === "string" && x.error.length > 0),
    JSON.stringify(batchRes.body.failed),
  );

  const afterBatch = (await page.evaluate(async () => (await fetch("/api/gallery")).json())).total;
  check("total 减少 3", afterBatch === beforeBatch - 3, `${beforeBatch} -> ${afterBatch}`);

  const badBody = await page.evaluate(async () => {
    const r = await fetch("/api/gallery/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_ids: "not-an-array" }),
    });
    return r.status;
  });
  check("job_ids 非数组返回 400", badBody === 400, `got ${badBody}`);

  const emptyBatch = await page.evaluate(async () => {
    const r = await fetch("/api/gallery/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_ids: [] }),
    });
    return { status: r.status, body: await r.json() };
  });
  check("空数组返回 200 且 deleted_count=0",
    emptyBatch.status === 200 && emptyBatch.body.deleted_count === 0,
    JSON.stringify(emptyBatch.body));

  // ===================== 前端：首屏分页 =====================
  /**
   * 断首屏分页要断**网络契约**, 不能断"渲染了几张卡"。
   *
   * 早先这里断言"首屏 <= 24 张卡", 结果量到 48 —— 但那不是 bug:
   * rootMargin=800px 的预取哨兵在 900px 高的视口下, 第 1 页渲染完
   * 哨兵就已经落在"视口底部 + 800px"范围内, 于是自动把第 2 页也拉了。
   * 这是**有意的**"填满视口 + 预取一屏"行为, 且会自行收敛
   * (内容够高后哨兵移出范围就停), 不是失控加载。
   *
   * 真正要守住的不变量是: 首个请求就是 limit=24, 而不是一次性要全部。
   * 这才是"确实分页了"的证据, 且不受预取策略影响。
   */
  const galleryReqs = [];
  const onReq = (r) => {
    const u = new URL(r.url());
    if (u.pathname === "/api/gallery") {
      galleryReqs.push({ limit: u.searchParams.get("limit"), offset: u.searchParams.get("offset") });
    }
  };
  page.on("request", onReq);

  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-job-id]", { timeout: 20000 });
  await page.waitForTimeout(1200); // 给预取留出触发时间
  page.off("request", onReq);

  const totalNow = (await page.evaluate(async () => (await fetch("/api/gallery")).json())).total;
  check("首屏发的是分页请求(limit=24)", galleryReqs[0]?.limit === "24", JSON.stringify(galleryReqs[0]));
  check("首屏从 offset=0 开始", galleryReqs[0]?.offset === "0" || galleryReqs[0]?.offset === null,
    JSON.stringify(galleryReqs[0]));
  check(
    "没有任何一次请求要全量(limit 始终有值)",
    galleryReqs.every((r) => r.limit !== null),
    JSON.stringify(galleryReqs.slice(0, 5)),
  );

  /**
   * offset 必须单调不减, 且**同一个 offset 至多出现两次**。
   *
   * 两次是 StrictMode 的额度: React 18 在 dev 下会 mount→cleanup→mount
   * 双调用 effect, 于是首屏那个 offset=0 的请求必然发两次(第一次的结果
   * 被 cancelled 守卫丢弃, 只是白花一次往返)。生产构建不会双调用。
   *
   * 早先这里写成"offset 不能重复", 结果被 StrictMode 判失败 —— 那是把
   * 框架的既定行为当成了缺陷。真正要防的是**loadMore 卡住反复要同一页**
   * (那会让列表永远不增长), 所以上界取 2 而不是 1。
   */
  const offsets = galleryReqs.map((r) => (r.offset === null ? 0 : Number(r.offset)));
  const perOffset = new Map();
  for (const o of offsets) perOffset.set(o, (perOffset.get(o) || 0) + 1);
  check(
    "同一 offset 至多请求两次(StrictMode 双调用额度)",
    Math.max(...perOffset.values()) <= 2,
    JSON.stringify([...perOffset.entries()]),
  );
  check(
    "offset 单调不减(不会来回翻页)",
    offsets.every((o, i) => i === 0 || o >= offsets[i - 1]),
    JSON.stringify(offsets),
  );

  const firstCount = await page.locator("[data-job-id]").count();
  if (totalNow > 24) {
    check("首屏渲染数远小于总数(确实分页了)", firstCount < totalNow, `${firstCount} < ${totalNow}`);
    check(
      "首屏渲染数被预取上限约束(<= 3 页)",
      firstCount <= 72,
      `count=${firstCount}`,
    );

    const loadMoreBtn = page.locator("[data-gallery-load-more]");
    check("存在「加载更多」兜底按钮", (await loadMoreBtn.count()) === 1);
    check(
      "「加载更多」按钮显示剩余条数",
      /\d/.test((await loadMoreBtn.textContent()) || ""),
      (await loadMoreBtn.textContent()) || "",
    );

    // 点「加载更多」应**追加**而不是替换
    const before = await page.locator("[data-job-id]").count();
    await loadMoreBtn.click();
    await page.waitForFunction(
      (n) => document.querySelectorAll("[data-job-id]").length > n,
      before,
      { timeout: 15000 },
    ).catch(() => {});
    const secondCount = await page.locator("[data-job-id]").count();
    check("点加载更多后条目变多(追加而非替换)", secondCount > before, `${before} -> ${secondCount}`);
  } else {
    check("数据量不足 24 条, 跳过首屏分页断言", true, `total=${totalNow}`);
  }

  check("渲染了哨兵元素", (await page.locator("[data-gallery-sentinel]").count()) === 1);
  check("存在「多选」入口", (await page.locator("[data-gallery-select-mode]").count()) === 1);

  // ===================== 前端：批量选择与删除 =====================
  /**
   * 只操作**本脚本自己创建**的两条记录。
   *
   * 早先这里取的是"列表里的前两张卡"(`slice(0, 2)`)再执行真批量删除 ——
   * 那就是在删用户自己的照片, 而且脚本照样跑完、照样"通过"。
   * 测试脚本误删真实数据是最难查的一类事故: 它不报错, 只留下"我明明
   * 存过那张图"。所以这里改成造两条带唯一标签的 job, 用标签把列表
   * 过滤到只剩它们再操作。
   *
   * 下面还有一道**前置守卫**: 过滤后可见集合必须恰好等于自建的那两条,
   * 否则只判失败并跳过删除。宁可不测, 也不能删错东西 ——
   * 断言失败是可以修的, 误删的数据不能。
   */
  const uiTag = `ui${Date.now().toString(36).slice(-8)}`;
  check("UI 测试标签未超 ALBUM_MAX_TAG(16)", uiTag.length <= 16, `${uiTag.length}: ${uiTag}`);
  const cardIds = [await makeJobOnDisk("ui"), await makeJobOnDisk("ui")];
  await page.evaluate(
    async ({ ids, t }) => {
      for (const id of ids) {
        await fetch(`/api/gallery/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tags: [t] }),
        });
      }
    },
    { ids: cardIds, t: uiTag },
  );

  /**
   * 标签汇总来自**首次加载**的那次响应, 之后 reload()/loadMore() 都不会
   * 重新拉第一页的 tags —— 所以页面刚打开时新造的 job 标签还不在筛选条上。
   * 直接等待必然超时。这里显式重载一次, 让筛选条包含 uiTag。
   *
   * 注意不能改成"reload 里也刷新 tags": 那会让筛选条在每次滚动加载后
   * 都重排, 用户刚点到一半的标签按钮会移位 —— 用测试的隔离需求去改产品
   * 行为是本末倒置。
   */
  await page.reload({ waitUntil: "domcontentloaded" });
  const uiTagBtn = page.locator(`[data-gallery-tag="${uiTag}"]`);
  await uiTagBtn.waitFor({ timeout: 15000 });
  await uiTagBtn.click();
  await page
    .waitForFunction(
      (ids) => {
        const now = Array.from(document.querySelectorAll("[data-job-id]")).map((el) =>
          el.getAttribute("data-job-id"),
        );
        return now.length === ids.length && ids.every((id) => now.includes(id));
      },
      cardIds,
      { timeout: 10000 },
    )
    .catch(() => {});

  const visible = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-job-id]")).map((el) =>
      el.getAttribute("data-job-id"),
    ),
  );
  const isolated =
    visible.length === cardIds.length &&
    cardIds.every((id) => visible.includes(id)) &&
    visible.every((id) => cardIds.includes(id));
  check(
    "按标签过滤后只剩本脚本创建的 2 条",
    isolated,
    JSON.stringify(visible),
  );
  if (!isolated) {
    // 守卫失败: 列表里混进了不属于本脚本的记录, 此时任何"批量删除"都会
    // 作用到用户数据上。直接跳过删除段, 只保留已完成的断言。
    check("已跳过前端批量删除(过滤隔离失败, 不冒误删风险)", true, "skipped");
  } else {

  const beforeUi = (await page.evaluate(async () => (await fetch("/api/gallery")).json())).total;

  // 先点卡片必须打开编辑抽屉(旧行为不能被多选功能破坏)
  await page.locator(`[data-job-id="${cardIds[0]}"]`).click();
  await page.waitForSelector("[data-album-save]", { timeout: 8000 });
  check("非多选模式下点卡片打开编辑抽屉(旧行为保留)", (await page.locator("[data-album-save]").count()) === 1);
  await page.keyboard.press("Escape");
  await page.waitForSelector("[data-album-save]", { state: "detached", timeout: 8000 });

  // 进入多选模式
  check("有「多选」模式开关", (await page.locator("[data-gallery-select-mode]").count()) === 1);
  await page.locator("[data-gallery-select-mode]").click();
  await page.waitForSelector("[data-gallery-selected-count]", { timeout: 5000 });
  check(
    "进入多选后计数显示 0(此时尚未勾选)",
    ((await page.locator("[data-gallery-selected-count]").textContent()) || "").includes("0"),
  );
  check("多选模式下出现勾选标记", (await page.locator(`[data-gallery-check="${cardIds[0]}"]`).count()) === 1);
  check(
    "多选模式下隐藏放大镜(避免两个动作打架)",
    (await page.locator(`[data-gallery-zoom="${cardIds[0]}"]`).count()) === 0,
  );
  check("未勾选时不显示删除按钮", (await page.locator("[data-gallery-batch-delete]").count()) === 0);

  await page.locator(`[data-job-id="${cardIds[0]}"]`).click();
  await page.waitForTimeout(200);
  check(
    "单选后计数为 1",
    ((await page.locator("[data-gallery-selected-count]").textContent()) || "").includes("1"),
  );
  check("选中态不打开编辑抽屉", (await page.locator("[data-album-save]").count()) === 0);

  await page.locator(`[data-job-id="${cardIds[1]}"]`).click();
  await page.waitForTimeout(200);
  check(
    "再选一条后计数为 2",
    ((await page.locator("[data-gallery-selected-count]").textContent()) || "").includes("2"),
  );
  check("卡片 aria-pressed 反映选中", (await page.locator(`[data-job-id="${cardIds[0]}"]`).getAttribute("aria-pressed")) === "true");

  // 再点一次应取消选中
  await page.locator(`[data-job-id="${cardIds[1]}"]`).click();
  await page.waitForTimeout(200);
  check(
    "再点同一条取消选中(计数回到 1)",
    ((await page.locator("[data-gallery-selected-count]").textContent()) || "").includes("1"),
  );
  await page.locator(`[data-job-id="${cardIds[1]}"]`).click();
  await page.waitForTimeout(200);

  // 弹窗确认: 第一次点击只开弹窗, 不发请求
  check("有「删除选中的 N 条」按钮", (await page.locator("[data-gallery-batch-delete]").count()) === 1);
  await page.locator("[data-gallery-batch-delete]").click();
  await page.waitForSelector('[data-confirm-dialog="batch"]', { timeout: 5000 });
  check("第一次点击弹出确认框", (await page.locator('[data-confirm-dialog="batch"]').count()) === 1);
  /**
   * 数量断在**正文**上, 不断在确认按钮上。
   *
   * 按钮文案从「移到回收站 2 条」简化成「确认移入」之后, 条数就只出现在
   * 正文一处了。这样排版也更好: 标题、正文、按钮三处各说一件事, 不会
   * 把同一句话读两遍。
   *
   * 这条断言真正要钉的是"弹窗上的数字 = 实际要删的数量", 所以断正文
   * 比断按钮更贴近那个不变量。
   */
  check(
    "确认框正文含条数",
    /2/.test((await page.locator('[data-confirm-dialog="batch"]').textContent()) || ""),
  );
  check(
    "确认按钮文案简洁不含数字",
    /^\D+$/.test(((await page.locator('[data-confirm-ok="batch"]').textContent()) || "").trim()),
    (await page.locator('[data-confirm-ok="batch"]').textContent()) || "",
  );
  // 标题不带问号: 弹窗已把"确认/取消"摆出来, 再问一遍是多余的,
  // 而且问号的基线在像素字体下会明显偏上。
  const dlgTitle = (await page.locator('[data-confirm-title]').textContent()) || "";
  check("确认框标题不含问号", !dlgTitle.includes("?"), dlgTitle);
  // 文案去重: 标题/正文/按钮三处各说一件事, 不重复同一句。
  const okLabel = (await page.locator('[data-confirm-ok="batch"]').textContent()) || "";
  check(
    "确认按钮文案与标题不重复",
    !(okLabel.trim() && dlgTitle.includes(okLabel.trim())),
    `title=${dlgTitle} ok=${okLabel}`,
  );
  // 弹窗必须压暗整页, 否则它仍然可能被"视线的焦点之外"忽略掉 ——
  // 那正是从"按钮变色"改弹窗要解决的问题本身。
  check(
    "弹窗有全屏遮罩",
    (await page.locator('[data-confirm-overlay="batch"]').count()) === 1,
  );
  /**
   * 弹窗开着时, 那个入口按钮在 DOM 里**仍然存在** —— 这是对的, 它只是被
   * 遮罩盖住并拦截了点击。原先这里断言"入口应当消失", 那是把设计偏好当
   * 契约: 按钮消失会让"取消之后按钮要重新出现"这件事多一个需要同步的
   * 渲染分支, 而遮罩已经足够阻止误触。
   *
   * 真正该保证的是**遮罩拦得住**。用 elementFromPoint 验: 入口按钮中心
   * 那个位置命中的是遮罩而不是按钮。这条比"按钮消失了"更贴近用户体感 ——
   * 用户看到的是"点不到", 不是"按钮没了"。
   */
  const covered = await page.evaluate(() => {
    const b = document.querySelector("[data-gallery-batch-delete]");
    const o = document.querySelector('[data-confirm-overlay="batch"]');
    if (!b || !o) return "missing";
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return o.contains(hit) ? "covered" : `leak:${hit?.tagName ?? "null"}`;
  });
  check("遮罩挡住了底层入口按钮", covered === "covered", String(covered));

  const midCount = (await page.evaluate(async () => (await fetch("/api/gallery")).json())).total;
  check("确认框打开时尚未真的删除", midCount === beforeUi, `${beforeUi} -> ${midCount}`);

  // Esc 取消: 关掉弹窗, 什么也不该删。这是弹窗相比"按钮变色"的关键优势 ——
  // 退路不需要用户先理解"我现在处于第二段"。
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-confirm-dialog="batch"]', {
    state: "detached",
    timeout: 5000,
  });
  check("Esc 关闭确认框", (await page.locator('[data-confirm-dialog="batch"]').count()) === 0);
  check(
    "Esc 取消后没有删除",
    (await page.evaluate(async () => (await fetch("/api/gallery")).json())).total === beforeUi,
  );
  check("Esc 取消后选中集保留", (await page.locator("[data-gallery-selected-count]").count()) === 1);

  // 点遮罩取消: 再验一条退路。
  await page.locator("[data-gallery-batch-delete]").click();
  await page.waitForSelector('[data-confirm-dialog="batch"]', { timeout: 5000 });
  await page.locator('[data-confirm-cancel="batch"]').click();
  await page.waitForSelector('[data-confirm-dialog="batch"]', {
    state: "detached",
    timeout: 5000,
  });
  check("取消按钮关闭确认框", (await page.locator('[data-confirm-dialog="batch"]').count()) === 0);
  check(
    "取消后没有删除",
    (await page.evaluate(async () => (await fetch("/api/gallery")).json())).total === beforeUi,
  );

  await page.locator("[data-gallery-batch-delete]").click();
  await page.waitForSelector('[data-confirm-dialog="batch"]', { timeout: 5000 });
  await page.locator('[data-confirm-ok="batch"]').click();
  await page.waitForSelector("[data-gallery-batch-note]", { timeout: 15000 });
  check("确认框已关闭", (await page.locator('[data-confirm-dialog="batch"]').count()) === 0);
  const note = (await page.locator("[data-gallery-batch-note]").textContent()) || "";
  check("删除后给出结果提示", note.includes("2"), note);
  const afterUi = (await page.evaluate(async () => (await fetch("/api/gallery")).json())).total;
  check("批量删除后 total 减少 2", afterUi === beforeUi - 2, `${beforeUi} -> ${afterUi}`);
  check(
    "被删的两条不再出现在列表",
    !(await page.evaluate(
      (ids) => ids.some((id) => !!document.querySelector(`[data-job-id="${id}"]`)),
      cardIds,
    )),
  );
  check("删除成功后自动退出多选", (await page.locator("[data-gallery-selected-count]").count()) === 0);
  check(
    "被删目录已从磁盘移除",
    (await page.evaluate(
      (ids) => Promise.all(ids.map((id) => fetch(`/api/gallery/${id}`, { method: "DELETE" }).then((r) => r.status))),
      cardIds,
    )).every((s) => s === 404),
  );

  /**
   * 删光最后一个该标签的记录后, 「全部」按钮必须还在。
   *
   * 这条断言是在修一个真实的死局: 筛选栏原本渲染条件是 tags.length > 0,
   * 而 tags 来自首屏那次响应。把 uiTag 下的两条删光后 tags 变空 → 整条
   * 筛选栏消失 → 「全部」也没了 → 用户**没有任何办法退出这个筛选**,
   * 只能刷新浏览器。产品侧已改成 (tags.length > 0 || tag !== "")。
   */
  check(
    "删光该标签后「全部」按钮仍在(否则用户无法退出筛选)",
    (await page.locator('button[data-gallery-tag=""]').count()) === 1,
  );

  /**
   * 回到全量视图。
   *
   * 这一步是**后续断言的前提**, 不是清理动作: 上面刚把过滤出来的两条
   * 删光, 此时列表为空, 而「多选」按钮在 items.length === 0 时是
   * disabled 的 —— 不恢复全量视图, 下面点它不会有任何反应,
   * 断言会以"与被测功能无关的失败"收场。
   */
  await page.locator('button[data-gallery-tag=""]').click();
  await page
    .waitForFunction(
      () => {
        const all = document.querySelector('button[data-gallery-tag=""]');
        return (
          document.querySelectorAll("[data-job-id]").length > 2 &&
          all?.getAttribute("aria-pressed") === "true"
        );
      },
      null,
      { timeout: 10000 },
    )
    .catch(() => {});
  const restoredCount = await page.locator("[data-job-id]").count();
  check("取消筛选后回到全量视图(卡片恢复且「全部」高亮)", restoredCount > 2, `count=${restoredCount}`);

  // 全选 / 退出多选
  await page.locator("[data-gallery-select-mode]").click();
  await page.waitForSelector("[data-gallery-select-all]", { timeout: 5000 });
  await page.locator("[data-gallery-select-all]").click();
  await page.waitForTimeout(300);
  const allSelText = (await page.locator("[data-gallery-selected-count]").textContent()) || "";
  check("全选后计数 = 已加载条数", /已选 \d+ 条/.test(allSelText), allSelText);
  await page.locator("[data-gallery-select-mode]").click();
  await page.waitForTimeout(200);
  check("退出多选后计数消失", (await page.locator("[data-gallery-selected-count]").count()) === 0);
  /**
   * 勾选标记的消失必须用一张**当前还在列表里**的卡来断。
   *
   * 早先这里断的是 cardIds[0] —— 它刚被真删掉, 元素本来就不存在,
   * 于是这条断言无论退出多选有没有生效都会"通过", 是个假阳性。
   */
  const freshId = await page.evaluate(
    () => document.querySelector("[data-job-id]")?.getAttribute("data-job-id") ?? "",
  );
  check("取到一张仍存在的卡片", freshId.length > 0, freshId);
  check("退出多选后勾选标记消失", (await page.locator(`[data-gallery-check="${freshId}"]`).count()) === 0);
  await page.locator(`[data-job-id="${freshId}"]`).click();
  await page.waitForSelector("[data-album-save]", { timeout: 8000 });
  check("退出多选后点卡片打开抽屉", (await page.locator("[data-album-save]").count()) === 1);
  await page.keyboard.press("Escape");
  await page.waitForSelector("[data-album-save]", { state: "detached", timeout: 8000 });
  }
} catch (e) {
  check("脚本执行未抛异常", false, String(e && e.message ? e.message : e));
} finally {
  await cleanupDisk(created);

  /**
   * 收尾断言: 清理必须真的干净。
   *
   * 这一段是被"跑完之后实测发现回收站里躺着 3 条 bt* 残留"逼出来的 ——
   * cleanupDisk 收到的 created 数组漏登记了 6 处调用点, 于是清理空转,
   * 而**脚本全程 0 失败**。测试数据没清干净这件事没有任何断言会发现:
   * 功能断言全绿, 清理是 finally 里的副作用, 没人检查它的结果。
   *
   * 断法刻意只按**前缀**扫回收站, 而不是逐个比对 created:
   * 逐个比对只能证明"我登记过的都清了", 而漏登记的那些 id 根本不在
   * created 里, 正是残留的来源 —— 那种断法会漏掉问题本身。
   *
   * 用 node 侧 fetch 而不是 page.evaluate: 下面紧接着就要 close 浏览器,
   * 页面已经关闭时 evaluate 会抛, 而这是收尾路径, 不该再抛。
   */
  const leftoverIds = await fetch(`${API}/gallery/trash`)
    .then((r) => r.json())
    .then((t) => t.items.map((x) => x.job_id))
    .catch(() => []);
  check(
    "回收站里没有本脚本前缀(bt/pt/ui)的残留",
    !leftoverIds.some((id) => /^(bt|pt|ui)[a-z0-9]/.test(id)),
    `残留: ${leftoverIds.join(",")}`,
  );

  const albumKeys = await (async () => {
    try {
      const fsp = await import("node:fs/promises");
      return Object.keys(JSON.parse(await fsp.readFile(`${OUT_DIR}/_album.json`, "utf-8")));
    } catch {
      // 文件不存在 = 没有孤儿键(后端在 album 为空时会删掉整个文件)
      return [];
    }
  })();
  check(
    "_album.json 里没有本脚本前缀的孤儿键",
    !albumKeys.some((k) => /^(bt|pt|ui)[a-z0-9]/.test(k)),
    `孤儿键: ${albumKeys.join(",")}`,
  );

  await browser.close();
}

console.log(`\nResult: ${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length) console.log("FAILED:", FAIL.join(" | "));
process.exit(FAIL.length ? 1 : 0);
