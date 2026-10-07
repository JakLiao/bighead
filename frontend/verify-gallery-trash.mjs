/**
 * 回收站(软删除)端到端验证。
 *
 * 覆盖：
 *  1. 后端软删除契约：目录移入 _trash、主列表不再含、元数据随行、重复删 404
 *  2. 保留期：过期条目按天被自动真删，且前端告知用户
 *  3. 恢复：还原到画廊，且**标题/标签/收藏一并还原**
 *  4. 彻底删除与清空：不可恢复，且 _trash 目录本身不被删掉(静态挂载要保持有效)
 *  5. permanent=true 的批量真删不进回收站
 *  6. 路径穿越 / 恶意目录名无法骗过 API
 *  7. 前端：入口按钮、抽屉、空态、摘要、逐条恢复、逐条彻底删、两段式清空
 *  8. 前端：删除文案不再说「不可恢复」
 *
 * 注：本脚本自己造数据、自己清理，**绝不碰用户已有的 job**。
 * 见 makeJobOnDisk 上方说明。
 */
import { chromium } from "playwright";

// 刻意**不叫 URL**: 后面要用 `new URL(...)` 解析请求 url,
// 而 const URL = "..." 会遮蔽全局 URL 构造器, 表现为
// "TypeError: URL is not a constructor" —— 一个与被测功能无关的崩溃。
const PAGE_URL = process.env.APP_URL || "http://localhost:5173/gallery";
/**
 * 后端 API 基址, **含 `/api` 前缀**。
 *
 * 下面多数调用走 `api()` helper, 它内部自己拼了 "/api/..."。只有
 * 收尾断言里这一处直接用 `${API}` —— 而 API 已经含了 /api, 才不会少一段。
 * 若把前缀从常量里去掉, 这一处就会变成 /gallery/trash → 404,
 * 且 fetch 不抛异常, 只会安静地让断言读到空数组。
 */
const API = process.env.API_URL || "http://127.0.0.1:8077/api";

/**
 * 静态资源基址, **不含 `/api`**。
 *
 * 必须与 API 分开: `/outputs/...` 是 app.py 挂的 StaticFiles, 路径里
 * 没有 /api 段。给缩略图 URL 拼 `${API}` 会得到
 * "http://127.0.0.1:8077/api/outputs/_trash/..." → 404,
 * 表现为"缩略图真实可取回"失败, 而回收站功能本身完全正常。
 *
 * 这类"同一台服务器、不同路径前缀"的地址, 用两个常量表达比在调用处
 * 各自拼字符串更不容易错 —— 拼错时后者只会安静地返回 404。
 */
const ORIGIN = process.env.API_URL
  ? process.env.API_URL.replace(/\/api\/?$/, "")
  : "http://127.0.0.1:8077";
const OUT = "f:/Trae-work/bighead/outputs";
const PASS = [];
const FAIL = [];
const check = (n, c, d = "") => {
  (c ? PASS : FAIL).push(n);
  console.log(`  [${c ? "PASS" : "FAIL"}] ${n}${d ? "  " + d : ""}`);
};

const created = new Set();

/**
 * 文件系统模块在**模块作用域**引入一次。
 *
 * 早先是在 makeJobOnDisk / makeExpiredTrashEntry 里各自 `const fs = await
 * import(...)`, 而底部的 fileExists/dirExists 引用 `fs` 时它并不在作用域里 ——
 * 会抛 ReferenceError, 被 helper 里的 try/catch 吞掉后**一律返回 false**。
 * 后果是所有"目录/文件应该存在"的断言全挂, 而"应该不存在"的断言全过:
 * 一次错误能同时伪造出 4 个失败和一堆假绿, 比直接崩掉难查得多。
 */
const fsp = await import("node:fs/promises");

/**
 * 调用后端接口。
 *
 * `path` 请**不带** `/api` 前缀 —— 前缀已经在 API 常量里了。
 * 这函数会主动剥掉一个开头的 "/api", 所以两种写法都能工作:
 * 这么做的原因是被同一个 bug 咬过 —— 早先 API 常量里没有 /api,
 * 而 path 里写着 /api/gallery/...; 后来为了修收尾断言给常量补上前缀,
 * 于是这里就变成了 /api/api/... 全线 404。两种写法都接受, 就不再有
 * "哪一处多了/少了前缀"的问题。
 */
async function api(method, path, body) {
  const r = await fetch(API + (path.startsWith("/api/") ? path.slice(4) : path), {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应(例如 404 的 detail 是一段文本) */
  }
  return { status: r.status, body: json, text };
}

/**
 * 造 job。**不依赖 canvas** —— 直接写文件更简单, 且不占用页面。
 * 绕过 /api/capture/save, 所以只用来测「磁盘上多/少一个目录时画廊怎么表现」,
 * 真实拍摄链路由其它脚本覆盖。
 */
async function makeJobOnDisk(tag) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  for (let i = 0; i < 40; i++) {
    const id = `${tag}${Date.now().toString(36)}${i}`;
    const full = path.join(OUT, id);
    try {
      await fs.mkdir(full, { recursive: false });
    } catch {
      continue;
    }
    // 1x1 JPEG。必须是真图: 前端 <img> 解码失败会触发 onerror,
    // 让后续断言失真(看到的是 onerror 兜底而不是我们要的缩略图)。
    const jpg = Buffer.from(
      "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
        "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
        "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
      "base64",
    );
    await fs.writeFile(path.join(full, "photo_1.jpg"), jpg);
    created.add(id);
    return id;
  }
  throw new Error("makeJobOnDisk 未能创建唯一目录");
}

/**
 * 直接在 _trash 里造一个「N 天前被删」的条目, 用来测保留期。
 *
 * 目录名格式必须与后端 _trash_name 一致("<毫秒时间戳>_<job_id>"), 否则
 * _split_trash_name 会返回 None, 它会被当成垃圾忽略掉 —— 那这条断言就是
 * 因为造数据方式错了而"通过", 属于假阳性。
 */
async function makeExpiredTrashEntry(jobId, daysAgo) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const ms = Date.now() - daysAgo * 86400 * 1000;
  const name = `${Math.floor(ms)}_${jobId}`;
  const full = path.join(OUT, "_trash", name);
  await fs.mkdir(full, { recursive: true });
  await fs.writeFile(path.join(full, "photo_1.jpg"), Buffer.from("x"));
  created.add(jobId);
  return { name, full };
}

/**
 * 清理本脚本造的一切。
 *
 * 删除已经是软删除, 所以"造了 job 的脚本清理自己"必须覆盖**两个位置**,
 * 少一个就会给下一次运行留垃圾:
 *
 *  1. outputs/<id>/ —— 还在磁盘上的源目录。
 *  2. outputs/_trash/ —— 前面的步骤可能已经把它删进去了。
 *     `batch-delete?permanent=true` 对这些 id 会返回 missing(源目录已不在),
 *     **清不到回收站里那一份**。
 *
 * 早先只做 (1), 于是跑一轮之后回收站里堆着上一个脚本的残留
 * (实测 8 条), 而"清空前回收站恰有 3 条"这种精确计数断言就必然失败。
 *
 * 这里只 purge 本脚本 created 里记下的 id, 不碰别人的。
 */
async function cleanup() {
  if (!created.size) return;
  await api("POST", "/api/gallery/batch-delete", {
    job_ids: [...created],
    permanent: true,
  });
  for (const id of created) {
    // 源目录已不在时这条返回 404; 真的在回收站里才会 purge 成功。
    await api("POST", `/api/gallery/trash/${id}/purge`);
  }
  created.clear();
}

const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", e));

try {
  // ===================== 后端：软删除契约 =====================
  const A = await makeJobOnDisk("tr");
  await api("PATCH", `/api/gallery/${A}`, { tags: ["trsh"], title: "待恢复标题" });

  const del = await api("DELETE", `/api/gallery/${A}`);
  check("DELETE 返回 200", del.status === 200, `got ${del.status}`);
  check("默认不是永久删除", del.body?.permanent === false, JSON.stringify(del.body));
  check("返回回收站目录名", typeof del.body?.trash_name === "string", del.body?.trash_name);
  check("返回保留天数 7", del.body?.purge_after_days === 7, `${del.body?.purge_after_days}`);

  check("源目录已不在 outputs/", !(await fileExists(`${OUT}/${A}`)));
  check(
    "目录被移进 _trash 而非删除",
    (await dirExists(`${OUT}/_trash/${del.body.trash_name}`)),
    del.body.trash_name,
  );

  const listA = await api("GET", "/api/gallery?limit=0");
  check("主列表已不含该条目", !listA.body.items.find((x) => x.job_id === A));
  /**
   * 元数据是否已从 album 里清掉。
   *
   * 不能靠 `GET /api/gallery/{id}` 断 —— 后端**没有**这条 GET 路由,
   * 会返回 405 Method Not Allowed(而不是 404), 拿它当"不存在"的证据
   * 是错的。直接读 sidecar 文件才是这条断言真正要看的东西。
   */
  const albumPath = `${OUT}/_album.json`;
  check(
    "软删后 album 里也无残留",
    !(await fileExists(albumPath)) ||
      !JSON.parse(await fsp.readFile(albumPath, "utf-8"))[A],
  );

  check("重复 DELETE 返回 404", (await api("DELETE", `/api/gallery/${A}`)).status === 404);

  // ===================== 回收站列表 =====================
  const t1 = await api("GET", "/api/gallery/trash");
  check("回收站列表返回 200", t1.status === 200, `got ${t1.status}`);
  const row = (t1.body?.items ?? []).find((x) => x.job_id === A);
  check("回收站含该条目", !!row, JSON.stringify(row));
  check("带删除时间", typeof row?.deleted_at === "number" && row.deleted_at > 0);
  check("带占用大小(非 0)", row?.size > 0, `size=${row?.size}`);
  check("带缩略图 URL", Array.isArray(row?.thumbs) && row.thumbs.length > 0, JSON.stringify(row?.thumbs));
  check("缩略图指向 _trash", String(row?.thumbs?.[0] ?? "").includes("/outputs/_trash/"), row?.thumbs?.[0]);
  // 用 ORIGIN 而不是 API: 缩略图是 StaticFiles 挂的 /outputs/..., 没有 /api 前缀。
  check("缩略图真实可取回", row?.thumbs?.[0] ? await fileReachable(ORIGIN + row.thumbs[0]) : false);
  check("保留天数 7", t1.body?.retention_days === 7, `${t1.body?.retention_days}`);
  check("total 计数正确", t1.body?.total >= 1);
  check("total_size > 0", t1.body?.total_size > 0);
  check("truncated 默认 false", t1.body?.truncated === false);

  // 元数据随行(恢复要靠它)
  check(
    "元数据存进 _trash 的 sidecar",
    await fileExists(`${OUT}/_trash/${del.body.trash_name}.meta.json`),
  );

  // ===================== 恢复 =====================
  const res = await api("POST", `/api/gallery/trash/${A}/restore`);
  check("恢复返回 200", res.status === 200, `got ${res.status}`);
  check("源目录回到 outputs/", await dirExists(`${OUT}/${A}`));
  check("回收站里不再有它", !(await api("GET", "/api/gallery/trash")).body.items.find((x) => x.job_id === A));
  const back = (await api("GET", "/api/gallery?limit=0")).body.items.find((x) => x.job_id === A);
  check("回到主列表", !!back);
  check("恢复后标题还原", back?.title === "待恢复标题", back?.title);
  check("恢复后标签还原", (back?.tags ?? []).includes("trsh"), JSON.stringify(back?.tags));
  check("sidecar 已随之清除", !(await fileExists(`${OUT}/_trash/${del.body.trash_name}.meta.json`)));
  check("重复恢复返回 404", (await api("POST", `/api/gallery/trash/${A}/restore`)).status === 404);

  // ===================== 保留期 =====================
  const OLD = "expiredprobe01";
  const made = await makeExpiredTrashEntry(OLD, 30);
  const t2 = await api("GET", "/api/gallery/trash");
  check("过期条目读列表时被自动清理", t2.body.purged.includes(OLD), JSON.stringify(t2.body.purged));
  check("过期条目不再出现在列表", !t2.body.items.find((x) => x.job_id === OLD));
  check("过期条目磁盘真被删", !(await dirExists(made.full)));

  // 未过期的不能被误删(这是"自动清理"最危险的回归方向)
  const keepId = await makeJobOnDisk("tk");
  await api("DELETE", `/api/gallery/${keepId}`);
  const t3 = await api("GET", "/api/gallery/trash");
  check("未过期条目仍在回收站", !!t3.body.items.find((x) => x.job_id === keepId));
  check("未过期条目 purged 为空", !t3.body.purged.includes(keepId));

  // ===================== permanent 真删 =====================
  const P1 = await makeJobOnDisk("tp");
  const P2 = await makeJobOnDisk("tp");
  const perm = await api("POST", "/api/gallery/batch-delete", {
    job_ids: [P1, P2],
    permanent: true,
  });
  check("permanent 批量真删成功", perm.body?.deleted_count === 2, JSON.stringify(perm.body));
  check("响应标记 permanent", perm.body?.permanent === true);
  check("purge_after_days 为 0", perm.body?.purge_after_days === 0);
  check("真删后磁盘无目录", !(await dirExists(`${OUT}/${P1}`)) && !(await dirExists(`${OUT}/${P2}`)));
  const t4 = await api("GET", "/api/gallery/trash");
  check(
    "真删的条目不进回收站",
    !t4.body.items.find((x) => x.job_id === P1 || x.job_id === P2),
  );

  // ===================== 批量软删 =====================
  const B1 = await makeJobOnDisk("tb");
  const B2 = await makeJobOnDisk("tb");
  const soft = await api("POST", "/api/gallery/batch-delete", { job_ids: [B1, B2] });
  check("批量软删两条都成功", soft.body?.deleted_count === 2, JSON.stringify(soft.body));
  check("批量软删标记非永久", soft.body?.permanent === false);
  const t5 = await api("GET", "/api/gallery/trash");
  check(
    "两条都进回收站",
    !!t5.body.items.find((x) => x.job_id === B1) && !!t5.body.items.find((x) => x.job_id === B2),
  );

  // ===================== 安全：路径穿越 =====================
  const path = await import("node:path");
  const evilDir = path.join(OUT, "_trash", "1700000000000_..");
  await fsp.mkdir(evilDir, { recursive: true });
  const t6 = await api("GET", "/api/gallery/trash");
  check("恶意目录名 .. 被忽略", !t6.body.items.find((x) => x.job_id === ".."));
  await fsp.rm(evilDir, { recursive: true, force: true });
  /**
   * 路径穿越的三种形态要分开断, 因为它们死在**不同的地方**:
   *  - "a/b": %2F 解码成路径分隔符 → 路径段变多 → 匹配不到本路由(404)。
   *  - "..": 经 uvicorn 时 URL 被规范化, .. 段被消解, 请求落到一个不存在的
   *    路径上,于是匹配到 DELETE 路由 /api/gallery/{job_id} 但方法不符 → 405。
   *    注意这与 TestClient 进程内测试不同(那边是 400, 进了路由函数被
   *    _validate_job_id 挡下) —— **状态码依赖传输方式**, 所以这里只钉
   *    "4xx = 被拒绝" 这个不变量, 不硬编码具体码。
   *  - "bad!id": 段数对得上, 真的进到路由函数, 被 _validate_job_id 拒(400)。
   * 早先把三种都期望 400, 于是前两条永远失败 —— 断的是不存在的契约。
   *
   * 重要的是这里**只关心"没产生副作用"**: 任何 4xx 都说明请求没能触碰
   * 文件系统。真正要防的是 200/500(真去操作了)。
   */
  check("含路径分隔符的 id 被路由层拒(404)", (await api("POST", "/api/gallery/trash/a%2Fb/restore")).status === 404);
  const stDot = (await api("POST", "/api/gallery/trash/%2e%2e/restore")).status;
  check("'..' 被拒绝(4xx)", stDot >= 400 && stDot < 500, `${stDot}`);
  check("非法 id 被 _validate_job_id 拒(400)", (await api("POST", "/api/gallery/trash/bad!id/purge")).status === 400);

  // ===================== 清空回收站 =====================
  /**
 * 到这里回收站里必须有 keepId / B1 / B2 三条(本脚本造的)。
 *
 * 刻意**只断这三个 id 在里面**, 而不断 `total === 3`:
 * total 是全局量, 会因为任何别的脚本/上一次运行的残留而变化, 于是
 * "清空回收站"这个功能自己没坏, 断言却因为邻居脏了而失败 ——
 * 这种失败会诱导人去改被测代码或放宽断言, 比不断更糟。
 * 清空本身的行为(清完变 0)另有断言覆盖。
 */
  const beforeEmpty = (await api("GET", "/api/gallery/trash")).body;
  const inTrash = new Set(beforeEmpty.items.map((x) => x.job_id));
  check(
    "清空前本脚本造的 3 条都在回收站",
    inTrash.has(keepId) && inTrash.has(B1) && inTrash.has(B2),
    `keepId=${inTrash.has(keepId)} B1=${inTrash.has(B1)} B2=${inTrash.has(B2)} total=${beforeEmpty.total}`,
  );
  const emp = await api("POST", "/api/gallery/trash/empty");
  check("清空返回 200", emp.status === 200, `got ${emp.status}`);
  check("清空后 total 为 0", (await api("GET", "/api/gallery/trash")).body.total === 0);
  /**
   * _trash 目录本身必须还在。
   *
   * 它是 StaticFiles 挂载点(/outputs/_trash/...)。如果清空时 rmtree 掉整个
   * _trash, 挂载路径立刻 404, 直到下次有删除操作才重建 —— 期间前端缓存的
   * 缩略图 URL 全变碎图。逐条删内容、保目录是这个断言存在的唯一理由。
   */
  check("清空后 _trash 目录仍在(静态挂载有效)", await dirExists(`${OUT}/_trash`));

  // ===================== 前端 =====================
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  check("画廊顶部有「回收站」入口", (await page.locator("[data-trash-open]").count()) === 1);

  // 空态
  await page.locator("[data-trash-open]").click();
  await page.waitForSelector("[data-trash-panel]", { timeout: 8000 });
  check("点击后打开回收站抽屉", (await page.locator("[data-trash-panel]").count()) === 1);
  await page.waitForSelector("[data-trash-blank]", { timeout: 8000 });
  check("空回收站显示空态", ((await page.locator("[data-trash-blank]").textContent()) || "").includes("空"));
  /**
   * 空回收站不该出现「清空回收站」按钮。
   *
   * 按文本找而不是靠 data 属性 —— 空态(空回收站)和「清空」按钮是两组
   * 相反的语义, 如果共用一个属性名, 断言就分不清自己断的是哪一个,
   * 这里被迫写成恒真的形式。
   */
  check(
    "空回收站不显示清空按钮",
    (await page.locator("button:has-text('清空回收站')").count()) === 0,
  );
  check("空回收站不显示摘要行", (await page.locator("[data-trash-summary]").count()) === 0);

  // Esc 关闭
  await page.keyboard.press("Escape");
  await page.waitForSelector("[data-trash-panel]", { state: "detached", timeout: 8000 });
  check("Esc 可关闭回收站", (await page.locator("[data-trash-panel]").count()) === 0);

  // 造一条走前端删除 → 回收站 UI
  const U1 = await makeJobOnDisk("tu");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.fill("[data-gallery-search]", U1);
  await page.waitForSelector(`[data-job-id="${U1}"]`, { timeout: 8000 });

  /**
   * 删除文案不能再说「不可恢复」。
   *
   * 这条断言看似琐碎, 但它是软删除最重要的一环: 有了回收站之后,
   * 旧文案("确认删除? 不可恢复")就是**错的**。错的文案比没有文案更糟 ——
   * 用户要么被无谓吓住不敢删, 要么反过来以为删掉的东西永远都能找回,
   * 于是不敢在保留期后清空回收站。
   */
  await page.locator(`[data-job-id="${U1}"]`).click();
  await page.waitForSelector("[data-album-delete]", { timeout: 8000 });
  await page.locator("[data-album-delete]").click();
  await page.waitForSelector('[data-confirm-dialog="album"]', { timeout: 5000 });
  const confirmText = (await page.locator('[data-confirm-dialog="album"]').textContent()) || "";
  check("单条确认框说「移到回收站」", confirmText.includes("回收站"), confirmText);
  /**
   * 保留期提示现在在**确认弹窗**里, 不在抽屉里 —— 跟随"决策发生在弹窗里"
   * 一起搬过来了。所以这里查弹窗全文, 而不是查编辑抽屉。
   *
   * 查全文而不是只查确认按钮: 「不可恢复」这句错文案从来不在按钮上,
   * 只查按钮会漏掉"按钮说回收站、旁边小字却说不可恢复"这种自相矛盾。
   */
  check("单条删除不再声称「不可恢复」", !confirmText.includes("不可恢复"), confirmText.slice(0, 100));
  check("单条删除给出保留期提示", /\d+ 天后可从回收站恢复/.test(confirmText), confirmText.slice(0, 100));
  check(
    "确认框盖在编辑抽屉之上",
    (await page.locator("[data-album-save]").count()) === 1,
  );

  await page.locator('[data-confirm-ok="album"]').click();
  await page.waitForSelector("[data-album-save]", { state: "detached", timeout: 8000 });
  check("删除后卡片从列表消失", !(await page.locator(`[data-job-id="${U1}"]`).count()));
  check("源目录已不在磁盘", !(await dirExists(`${OUT}/${U1}`)));

  // 回收站面板里能看到并恢复
  await page.locator("[data-trash-open]").click();
  await page.waitForSelector("[data-trash-item]", { timeout: 8000 });
  check("回收站面板列出刚删的条目", (await page.locator(`[data-trash-item][data-job-id="${U1}"]`).count()) === 1);
  const summary = (await page.locator("[data-trash-summary]").textContent()) || "";
  check("摘要含条数", /\d+ 条/.test(summary), summary);
  check("摘要含占用大小", /KB|MB|GB|B/.test(summary), summary);
  check("摘要含保留天数", /7 天后自动删除/.test(summary), summary);

  // 缩略图真的加载出来(不是 onerror 兜底)
  const imgOk = await page.evaluate(async () => {
    const img = document.querySelector("[data-trash-item] img");
    if (!img) return false;
    if (img.complete) return img.naturalWidth > 0;
    await new Promise((r) => {
      img.onload = r;
      img.onerror = r;
    });
    return img.naturalWidth > 0;
  });
  check("回收站缩略图能正常解码", imgOk);

  await page.locator(`[data-trash-item][data-job-id="${U1}"] [data-trash-restore]`).click();
  await page.waitForSelector("[data-trash-note]", { timeout: 8000 });
  check("恢复后有提示", ((await page.locator("[data-trash-note]").textContent()) || "").includes("已恢复"));
  await page.waitForFunction(
    (jid) => !document.querySelector(`[data-trash-item][data-job-id="${jid}"]`),
    U1,
    { timeout: 8000 },
  );
  check("恢复后从回收站列表移除", (await page.locator(`[data-trash-item][data-job-id="${U1}"]`).count()) === 0);
  check("恢复后目录回到磁盘", await dirExists(`${OUT}/${U1}`));

  await page.locator("[data-trash-close]").click();
  await page.waitForSelector("[data-trash-panel]", { state: "detached", timeout: 8000 });
  // 面板恢复后画廊要能重新看到它(onRestored -> reload)
  await page.waitForSelector(`[data-job-id="${U1}"]`, { timeout: 8000 });
  check("恢复后画廊列表自动刷新", (await page.locator(`[data-job-id="${U1}"]`).count()) === 1);

  // ==================== 批量删除文案 ====================
  /**
   * 危险区守卫: 下面这段会执行批量删除, 而"批量删除"的天然入口是
   * **全选** —— 全选选的是"当前已加载的 N 条", 也就是**页面上所有卡片**,
   * 包含用户自己的照片。
   *
   * 这里曾经直接点「全选已加载的 N 条」再删除, 结果把用户 222 条真实数据
   * 永久删掉了(回收站也没有, 因为本段先校验"回收站恰好 0 条"再真删,
   * 等于逼着脚本走物理删除)。**脚本头部的注释声称"绝不碰用户已有的 job",
   * 而实现没有做到** —— 注释不是保护, 白名单才是。
   *
   * 现在改为**逐个勾选本脚本造的那几条**, 选中集由 created 决定。
   */
  // 逐个勾选白名单里的 id。
  // 勾选框是 data-gallery-check(aria-hidden, 无 aria-checked), 所以判定
  // 选中状态要读它自己的 class —— 有 `bg-brick` 即已选。
  //
  // `created` 里**不能**直接全用: 它还包含已经被删进回收站/已 purge 的 id,
  // 那些卡片不在列表里, 勾不到。所以先按"磁盘上还在不在"过滤。
  /**
   * 目标集合 = 本脚本造、且**后端现在还列在画廊里**的条目。
   *
   * 早先用 `dirExists` 判断, 有竞态: 前面几步的删除/恢复已经改过磁盘,
   * 而文件系统状态与后端列表之间存在时间差。加上无限滚动可能只加载了
   * 几批, 于是勾选时等一张已经被移走的卡片 —— 表现为
   * `waiting for [data-gallery-card="trm..."] to be visible` 超时,
   * 且**每次都在同一个 id 上**(前缀 tr = 前面 trash 用例留下的)。
   *
   * 现在问后端: 分页把所有 id 拉齐, 取交集。权威、与时序无关。
   */
  const listedIds = new Set();
  for (let off = 0; off < 1200; off += 200) {
    const page_ = await api("GET", `/api/gallery?limit=200&offset=${off}`);
    for (const it of page_.body.items) listedIds.add(it.job_id);
    if (!page_.body.has_more) break;
  }
  const batchTargets = [...created].filter((id) => listedIds.has(id));
  check("批量删除目标都是本脚本造的", batchTargets.length > 0, `n=${batchTargets.length}`);
  check(
    "批量删除目标都在后端列表里",
    batchTargets.every((id) => listedIds.has(id)),
    `${batchTargets.length} 条`,
  );

  await page.locator("[data-gallery-select-mode]").click();
  await page.waitForSelector("[data-gallery-select-all]", { timeout: 5000 });

  /**
   * **必须先清空搜索框**。
   *
   * 上面那段用 `fill(U1)` 定位卡片, 一直没清空 —— 于是列表被永久筛成只剩
   * 一张, 后面"滚到底加载全部页"全部无效, 表现为
   * `waiting for [data-gallery-card="trm..."] to be visible` 超时,
   * 且每次都卡在同一个 id 上。
   *
   * 这个 bug 潜伏很久的原因值得记下: 中间步骤全绿(那些断言不依赖列表内容),
   * 只有最后一处需要"目标卡片在页面上"才炸; 而更早一版是点「全选」,
   * 压根不需要卡片在页面上 —— 于是它一直没暴露, 直到"全选"被换成
   * "逐个勾选"。**换掉一个安全的实现, 会让旁边潜伏的 bug 显形。**
   */
  await page.fill("[data-gallery-search]", "");
  await page.waitForTimeout(600);
  check("清空搜索后列表恢复全量",
    (await page.locator("[data-gallery-card]").count()) > batchTargets.length,
    `cards=${await page.locator("[data-gallery-card]").count()}`);

  /**
    * 定位目标卡片: **滚到底**让 IntersectionObserver 把后续页加载出来。
    *
    * 这里踩过两个坑, 都记下来:
    *
    * 1. 靠点「加载更多」按钮翻页 —— 不可靠。无限滚动用 800px 预取, 数据够
    *    多时**按钮还没出现**观察器就把页加载完了, 于是 `more.count() === 0`
    *    直接 break, 后面的卡片永远等不到。
    * 2. 靠搜索定位 —— 会清空 selected(见下面那段注释), 与勾选冲突。
    *
    * 滚动是唯一同时满足"不碰 selected"与"一定会把全部页翻出来"的办法:
    * 它走的正是用户真实滚动的路径。
    */
  for (let guard = 0; guard < 60; guard++) {
    const remaining = await page.evaluate(
      (ids) => ids.filter((id) => !document.querySelector(`[data-gallery-card="${id}"]`)).length,
      batchTargets,
    );
    if (remaining === 0) break;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(400);

  for (const id of batchTargets) {
    const card = page.locator(`[data-gallery-card="${id}"]`);
    await card.waitFor({ state: "visible", timeout: 10000 });
    const mark = card.locator("[data-gallery-check]").first();
    const cls = (await mark.getAttribute("class")) || "";
    if (!cls.includes("bg-brick")) {
      await card.locator(`[data-job-id="${id}"]`).click();
    }
  }
  /**
   * 断言选中数量**恰好等于**白名单大小。
   *
   * 多一张就说明有用户数据混进来了, 这时要立刻停手而不是继续删。
   * 这是整段唯一的"提前刹车", 位置必须在点删除按钮之前。
   */
  const selText =
    (await page.locator("[data-gallery-selected-count]").textContent().catch(() => "")) || "";
  const selN = Number((selText.match(/(\d+)/) || [0, -1])[1]);
  check("选中数量只含本脚本数据", selN === batchTargets.length, `选中 ${selN}, 期望 ${batchTargets.length}`);
  if (selN !== batchTargets.length) {
    throw new Error("选中集与白名单不符, 中止以免误删用户数据");
  }

  // 记录基线: 后面"取消没删东西"要比的是**增量**, 不是绝对值 0。
  const trashBeforeBatch = (await api("GET", "/api/gallery/trash")).body.total;

  await page.locator("[data-gallery-batch-delete]").click();
  await page.waitForSelector('[data-confirm-dialog="batch"]', { timeout: 5000 });
  const batchConfirmText = (await page.locator('[data-confirm-dialog="batch"]').textContent()) || "";
  check("批量确认框说「移到回收站」", batchConfirmText.includes("回收站"), batchConfirmText);
  check("批量确认不再声称「不可恢复」", !batchConfirmText.includes("不可恢复"), batchConfirmText);
  check("批量确认框含保留期", /\d+ 天/.test(batchConfirmText), batchConfirmText);

  // **取消**确认: 什么都不能被删
  const beforeCancel = (await api("GET", "/api/gallery?limit=1")).body.total;
  await page.locator('[data-confirm-cancel="batch"]').click();
  await page.waitForSelector('[data-confirm-dialog="batch"]', { state: "detached", timeout: 5000 });
  await page.waitForTimeout(300);
  check("取消后 total 不变", (await api("GET", "/api/gallery?limit=1")).body.total === beforeCancel);
  /**
   * 回收站此时应恰好是"本脚本之前遗留的那些", 而**不是** 0。
   *
   * 原来这里断言 `=== 0`, 那个断言本身就是"必须物理删除用户数据"的同谋:
   * 它把"回收站里不能有任何东西"当成前提, 于是脚本只能走真删。
   * 换成"批量删除后条数增加"才是我们要验的东西。
   */
  const trashAfterBatch = (await api("GET", "/api/gallery/trash")).body.total;
  check("取消后回收站未增加", trashAfterBatch === trashBeforeBatch,
    `${trashBeforeBatch} -> ${trashAfterBatch}`);

  // 逐条彻底删
  await page.locator("[data-gallery-batch-delete]").click();
  await page.waitForSelector('[data-confirm-dialog="batch"]', { timeout: 5000 });
  await page.locator('[data-confirm-ok="batch"]').click();
  await page.waitForSelector("[data-gallery-batch-note]", { timeout: 15000 });
  const note = (await page.locator("[data-gallery-batch-note]").textContent()) || "";
  check("批量删除后提示点名回收站", note.includes("回收站"), note);
  check("批量删除后提示含保留期", /\d+ 天/.test(note), note);

  await page.locator("[data-trash-open]").click();
  await page.waitForSelector("[data-trash-item]", { timeout: 8000 });
  const trashN = (await api("GET", "/api/gallery/trash")).body.total;
  check("批量删除的条目全进了回收站", trashN > 0, `total=${trashN}`);

  // 两段式清空
  check("有「清空回收站」按钮", (await page.locator("[data-trash-empty]").count()) === 1);
  await page.locator("[data-trash-empty]").click();
  await page.waitForSelector("[data-trash-empty-confirm]", { timeout: 5000 });
  check("第一次点击只进确认态", (await page.locator("[data-trash-empty-confirm]").count()) === 1);
  await page.locator("[data-trash-empty-cancel]").click();
  await page.waitForTimeout(200);
  check("取消后回收站未被清", (await api("GET", "/api/gallery/trash")).body.total === trashN);
  await page.locator("[data-trash-empty]").click();
  await page.waitForSelector("[data-trash-empty-confirm]", { timeout: 5000 });
  await page.locator("[data-trash-empty-confirm]").click();
  await page.waitForSelector("[data-trash-note]", { timeout: 8000 });
  check("清空后回收站为空", (await api("GET", "/api/gallery/trash")).body.total === 0);
  check(
    "清空后卡片全部消失",
    (await page.locator("[data-trash-item]").count()) === 0,
    `items=${await page.locator("[data-trash-item]").count()}`,
  );
  check("清空后清空按钮消失", (await page.locator("button:has-text('清空回收站')").count()) === 0);
  check("清空后摘要行消失", (await page.locator("[data-trash-summary]").count()) === 0);
  /**
   * 刻意**不**断空态文案出现: TrashPanel 的空态条件带 `&& !note`,
   * 所以清空后那句"回收站已清空, 共删除 N 条"会取代它。
   *
   * 这是有意的优先级: 清空是用户刚做过的不可逆操作, 给一句"共删了 N 条"
   * 比让他看见一个冷冰冰的"回收站是空的"更能确认操作成功。
   * 早先这里等 data-trash-blank, 于是必然超时 —— 断的是一个设计上
   * 不该出现的状态。
   */
  check(
    "清空后给出结果提示",
    ((await page.locator("[data-trash-note]").textContent()) || "").includes("已清空"),
    (await page.locator("[data-trash-note]").textContent()) || "",
  );
} catch (e) {
  FAIL.push(`脚本异常:${e && e.message ? e.message : e}`);
  console.error("[error]", e);
} finally {
  await cleanup();
  /**
   * 收尾断言: 清理必须真的干净。
   *
   * 与 verify-gallery-paging 里那段同一个理由 —— 那个脚本因为
   * makeJobOnDisk 没登记 created, 清理静默空转, 回收站里留了 3 条 bt*,
   * 而它全程 0 失败。功能断言全绿, 清理是 finally 里的副作用,
   * 没人检查它的结果, 于是"测试数据没清干净"可以一直悄悄通过。
   *
   * 断法按**前缀**扫, 不逐个比对 created: 漏登记的 id 根本不在 created 里,
   * 逐个比对恰好会漏掉问题本身。
   */
  const leftoverIds = await fetch(`${API}/gallery/trash`)
    .then((r) => r.json())
    .then((t) => t.items.map((x) => x.job_id))
    .catch(() => []);
  check(
    "回收站里没有本脚本前缀(tr/tk/tp/tb/tu/expired)的残留",
    !leftoverIds.some((id) => /^(tr|tk|tp|tb|tu|expired)[a-z0-9]/.test(id)),
    `残留: ${leftoverIds.join(",")}`,
  );
  const albumKeys = await (async () => {
    try {
      return Object.keys(JSON.parse(await fsp.readFile(`${OUT}/_album.json`, "utf-8")));
    } catch {
      // 文件不存在 = 没有孤儿键(后端在 album 为空时会删掉整个文件)
      return [];
    }
  })();
  check(
    "_album.json 里没有本脚本前缀的孤儿键",
    !albumKeys.some((k) => /^(tr|tk|tp|tb|tu|expired)[a-z0-9]/.test(k)),
    `孤儿键: ${albumKeys.join(",")}`,
  );
  await browser.close();
}

console.log(`\nResult: ${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length) console.log("FAILED:", FAIL.join(" | "));
process.exit(FAIL.length ? 1 : 0);

// ---- 小工具 ----
async function fileExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}
async function dirExists(p) {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}
/** 缩略图 URL 是否真的能取到字节(而不是 404/占位)。 */
async function fileReachable(u) {
  try {
    const r = await fetch(u);
    return r.ok && (await r.arrayBuffer()).byteLength > 0;
  } catch {
    return false;
  }
}