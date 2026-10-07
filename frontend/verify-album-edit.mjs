/**
 * GalleryPage 贴纸册 UI 端到端验证。
 *
 * 覆盖：
 *  1. 收藏徽标渲染
 *  2. 点卡片打开编辑抽屉
 *  3. 改标题 + 取消收藏 → 保存 → 后端真的更新
 *  4. 标签添加（回车）
 *  5. 取消收藏后徽标消失
 *  6. 删除两段式确认 → 列表不再有该条目
 *
 * 自己造数据自己清理，不依赖其他脚本。
 *
 * ============================ 为什么全程按 job_id 定位 ============================
 *
 * 早先这里用的是 `page.locator("button.relative").first()` —— "第一张卡"。
 * 在**空**环境里它恰好等于"我刚造的那条", 于是长期 0 失败。
 *
 * 但 outputs/ 是**用户的真实相册**, 不是测试沙箱。实测本机有 79 条 job,
 * 而 PAGE_SIZE 只有 24。此时 first() 命中的可能是用户上周拍的照片 ——
 * 于是脚本对它执行了 PATCH、点了「删除这条」、确认删除, **把用户的照片
 * 移进了回收站**。跑出来是 5 条 FAIL + 两条用户的图没了, 而被测代码
 * 一点问题都没有。
 *
 * 更糟的是它同时让断言**失去意义**:
 *   - "favorite 条目排在首位" 只检查第一张卡的文本含 "待编辑",
 *     而环境里可能存在另一条标题相同的旧数据 -> 假通过;
 *   - 真正要验的"本轮这条 favorite 后置顶"根本没被验到。
 *
 * 改法是三条一起上, 缺一条都还会漏:
 *   1. 造数时用 `h.runTag` 生成**唯一** title, 不再用会与旧数据撞车的常量;
 *   2. 进页面后先用搜索框按 title 过滤, 把候选集收敛到本轮这一条 ——
 *      PAGE_SIZE=24 意味着"造完 favorite 就会置顶到第一屏"这个假设
 *      在 79 条数据下依然成立(favorite 优先排序), 但那是**别人的数据**
 *      在承担这个假设, 不该依赖;
 *   3. 所有点击/断言一律用 `button[data-job-id="${jid}"]`,
 *      不断言"第几张", 只断言"是不是那一条"。
 */
import { chromium } from "playwright";
import { createHarness } from "./verifyHarness.mjs";

const URL = process.env.APP_URL || "http://localhost:5173/gallery";

const h = await createHarness("verify-album-edit");
const check = h.check;
const entrySnapshot = await h.snapshot();

/** 本轮唯一标题。带上 runTag, 避免与环境里任何既有数据撞车。 */
const TITLE = `待编辑-${h.runTag}`;
const NOTE = `原备注-${h.runTag}`;
const TAG_OLD = `原标签${h.runCode}`;
const TAG_NEW = `新标签${h.runCode}`;
const TITLE_EDITED = `改过的标题-${h.runTag}`;
const DRAFT = `待保存的标题-${h.runTag}`;

/** 本轮 job 的 id。造数之前为 null —— 不允许在造数前就拿它做定位。 */
let jid = null;

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
  viewport: { width: 1280, height: 1800 },
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

/**
 * 造一条带元数据的 job（favorite=true 以便验证置顶）。
 *
 * 登记顺序是刻意的：**capture/save 一返回就 adopt**，早于 PATCH。
 * PATCH 失败(网络、后端 4xx)会让 createJob 抛错, 此时 job 已经在磁盘上,
 * 必须有人负责删 —— 而 harness 的 finally 会兜住它。
 *
 * 早先这里把 capture + PATCH 塞在同一个 evaluate 里, PATCH 的响应从没被
 * 检查过: 它 4xx 了脚本照样往下走, 然后在"后端 favorite 已取消"这类
 * 断言上炸出一句与真实原因无关的报错。
 */
async function makeJob() {
  const id = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 400;
    const g = c.getContext("2d");
    g.fillStyle = "#8e44ad";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#fff";
    g.font = "40px sans-serif";
    g.fillText("EDIT", 90, 220);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.9));
    const fd = new FormData();
    fd.append("images", blob, "e1.jpg");
    const r = await fetch("/api/capture/save", { method: "POST", body: fd });
    if (!r.ok) throw new Error(`capture/save ${r.status}`);
    return (await r.json()).job_id;
  });

  // 先登记, 再 PATCH。
  h.adopt(id);

  const patched = await page.evaluate(
    async ({ job_id, title, note, tag }) => {
      const r = await fetch(`/api/gallery/${job_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, note, tags: [tag], favorite: true }),
      });
      return { ok: r.ok, status: r.status, body: await r.text() };
    },
    { job_id: id, title: TITLE, note: NOTE, tag: TAG_OLD },
  );

  if (!patched.ok) {
    throw new Error(
      `初始 PATCH 失败 ${patched.status}: ${patched.body.slice(0, 200)}`,
    );
  }
  return id;
}

try {
  // 必须先进真实页面: makeJob 里的 fetch 用的是**相对**路径 /api/capture/save,
  // 依赖页面的 origin 做代理。停在 about:blank 上时 origin 是 "null",
  // fetch 直接抛 "Failed to parse URL" —— 早先这里漏了这句 goto,
  // 表现为造数第一步就炸, 与真正的失败原因毫无关系。
  await page.goto(URL, { waitUntil: "networkidle" });

  jid = await makeJob();
  check("造数据成功", !!jid, jid);

  await page.reload({ waitUntil: "networkidle" });

  // ---- 0) 把候选集收敛到本轮这一条 ----
  //
  // 搜索 q 会在服务端过滤(title/note/tags/job_id 任一命中, 见 gallery.py
  // 的 _matches), 所以用 runTag 就能把 79 条降到 1 条。收敛之后再做
  // 所有断言, 就不会再被邻居的数据干扰。
  await page.fill("[data-gallery-search]", TITLE);
  await page.waitForTimeout(900);

  /** 本轮那一张卡。**唯一定位入口**, 脚本里不再出现 .first()/.nth()。 */
  const card = page.locator(`button[data-job-id="${jid}"]`);
  await card.waitFor({ state: "visible", timeout: 10000 });

  // 收敛是否真的生效: 网格里应当只剩这一张卡。这一条专门用来把
  // "定位错了" 与 "功能坏了" 区分开 ——
  // 若这里失败, 说明筛选没生效, 后面所有断言都不可信。
  const gridCount = await page.locator("[data-gallery-grid] button[data-job-id]").count();
  check("搜索已把候选集收敛到唯一一条", gridCount === 1, `cards=${gridCount}`);

  // ---- 1) 收藏徽标 ----
  // 断**本轮这张卡**上的徽标, 不再断全页 ★ 的总数 ——
  // 全页总数会把用户自己的收藏算进来, 别人收藏一条这个断言就红。
  const starInCard = () => card.locator("span:has-text('★')").count();
  const starBefore = await starInCard();
  check("本轮卡片已渲染收藏徽标", starBefore >= 1, `count=${starBefore}`);

  // favorite 置顶: 本轮这条应排在结果集首位。
  // 收窄到搜索结果后"首位"的含义才明确 —— 它是**本轮这组**的首位。
  const firstIdInGrid = await page
    .locator("[data-gallery-grid] button[data-job-id]")
    .first()
    .getAttribute("data-job-id");
  check("favorite 条目排在首位", firstIdInGrid === jid, `${firstIdInGrid} vs ${jid}`);

  // ---- 2) 打开编辑抽屉 ----
  await card.click();
  await page.waitForSelector('[data-testid="album-edit-title"]', { state: "visible", timeout: 5000 });
  check("编辑抽屉已打开", await page.locator('[data-testid="album-edit-title"]').isVisible());

  /**
   * 抽屉标题上的 data-job-id 才是"抽屉里编辑的是哪一条"的权威答案。
   *
   * 它与本轮 jid 一致, 才说明后续所有输入/保存都作用在正确对象上。
   * 早先这行是 `=== "待编辑"` 之类的文本比对, 在有重名数据的环境下
   * 恒真, 于是"打开了错误条目"这件事完全不会报错。
   */
  const titleJobId = await page.locator('[data-testid="album-edit-title"]').getAttribute("data-job-id");
  check("data-job-id 与后端一致", titleJobId === jid, `${titleJobId} vs ${jid}`);

  // 初始值回填
  const initTitle = await page.locator("[data-album-title]").inputValue();
  check("标题回填正确", initTitle === TITLE, initTitle);
  const initNote = await page.locator("[data-album-note]").inputValue();
  check("备注回填正确", initNote === NOTE, initNote);
  const favChecked = await page.locator('input[type="checkbox"]').first().isChecked();
  check("收藏勾选状态回填为 true", favChecked);

  // ---- 3) 改标题 + 取消收藏 + 加标签 ----
  await page.fill("[data-album-title]", TITLE_EDITED);
  await page.locator('input[type="checkbox"]').first().uncheck();

  // 标签输入框**故意**不给 data-* 属性(它没有 maxLength, 与其它框不同)。
  // 这里按抽屉内的顺序取: 标题框/备注框/标签框, 标签框是唯一的无 data 属性文本框。
  const tagBox = page.locator("input[type='text'], input:not([type])").last();
  await tagBox.fill(TAG_NEW);
  await tagBox.press("Enter");
  await page.waitForTimeout(300);

  // chip 的 span 内还嵌了一个删除按钮 ×, 所以用 hasText 而非精确文本
  const tagChips = await page.locator("span", { hasText: TAG_OLD }).count();
  check("原标签仍在", tagChips >= 1);
  const newTagChip = await page.locator("span", { hasText: TAG_NEW }).count();
  check("新标签已添加为 chip", newTagChip >= 1);

  await page.click("[data-album-save]");
  await page.waitForSelector('[data-testid="album-edit-title"]', { state: "detached", timeout: 5000 });
  check("保存后抽屉关闭", !(await page.locator('[data-testid="album-edit-title"]').count()));

  // ---- 4) 后端真的更新了 ----
  const verify = await page.evaluate(async (j) => {
    const { items } = await (await fetch("/api/gallery")).json();
    return items.find((x) => x.job_id === j);
  }, jid);
  check("后端 title 已更新", verify?.title === TITLE_EDITED, verify?.title);
  check("后端 favorite 已取消", verify?.favorite === false, `favorite=${verify?.favorite}`);
  check("后端 note 仍保留", verify?.note === NOTE, verify?.note);
  check("后端 tags 含新标签", verify?.tags?.includes(TAG_NEW), JSON.stringify(verify?.tags));
  check("后端 tags 含原标签", verify?.tags?.includes(TAG_OLD), JSON.stringify(verify?.tags));

  // ---- 5) UI 上标题已更新、徽标消失 ----
  /**
   * 保存后必须**重新用新标题搜索**, 否则这一步必然超时。
   *
   * 搜索框里还留着旧标题(保存前填的), 而服务端 `_matches` 是拿 title/note/
   * tags 一起比的 —— 标题已经改成 TITLE_EDITED, 旧字符串不再命中, 于是这条
   * 卡片被过滤掉, `cardAfterSave.waitFor()` 10 秒后超时。
   *
   * 这不是"保存失败", 是**过滤条件过期**。所以这里换新标题重搜, 并把
   * 搜索框内容也纳入断言 —— 少了这步, 失败会报成"卡片显示新标题失败",
   * 而真实原因是上一步的查询条件没跟着更新。
   */
  await page.fill("[data-gallery-search]", TITLE_EDITED);
  await page.waitForTimeout(900);

  // 重新按 job_id 定位: 保存后父组件会 reload() 拉回新 items,
  // 旧 locator 仍可用(它是选择器不是元素句柄), 但重新 waitFor 能把
  // "列表还没刷新完" 与 "标题没更新" 区分开。
  const cardAfterSave = page.locator(`button[data-job-id="${jid}"]`);
  await cardAfterSave.waitFor({ state: "visible", timeout: 10000 });
  const cardText = await cardAfterSave.innerText();
  check("卡片显示新标题", cardText.includes(TITLE_EDITED), cardText.slice(0, 40));
  check("取消收藏后本卡片徽标消失", (await starInCard()) === 0, `stars=${await starInCard()}`);

  // ---- 6) 删除确认弹窗 ----
  // 同样按 job_id 点。早先这里是 .first(), 于是这一段删的往往是别人的图。
  await cardAfterSave.click();
  await page.waitForSelector('[data-testid="album-edit-title"]', { state: "visible", timeout: 5000 });
  check("删除段打开的是同一条", (await page.locator('[data-testid="album-edit-title"]').getAttribute("data-job-id")) === jid);

  // 先在标题框里改一个**非空**的新标题。只有非空才验得住"编辑还在" ——
  // 对着空输入框断言非空, 失败时说不清是丢数据还是本来就没内容。
  await page.locator("[data-album-title]").fill(DRAFT);
  await page.click("[data-album-delete]");
  /**
   * 断**data 属性**而不是按钮文案。
   *
   * 早先这里用 `button:has-text('确认删除')`, 而软删除把文案改成了
   * "移到回收站" —— 于是这个脚本整个崩在 waitForSelector 超时上, 报一个
   * 与"编辑功能坏了"毫不相干的错。文案是给人看的, 会改; data 属性是
   * 给测试的契约, 不该跟着文案一起变。
   *
   * 同样的教训在本轮又用上一次: 二次确认从"按钮变色"改成了**弹窗**,
   * 契约属性随之从 data-album-delete-confirm 变成 data-confirm-dialog。
   * 断属性而不是断结构, 才让这次改动只改一行就完事。
   */
  await page.waitForSelector('[data-confirm-dialog="album"]', { timeout: 3000 });
  check(
    "二次确认弹窗出现",
    await page.locator('[data-confirm-dialog="album"]').isVisible(),
  );
  // 弹窗必须盖在编辑抽屉之上。两层都是 z-50, 靠 DOM 顺序决定 ——
  // 所以这里直接问"用户看到的是谁": 取弹窗中心那个点, 看命中的元素
  // 属于谁。
  //
  // (早先这里写的是 compareDocumentPosition 与标题比, 方向弄反了:
  // 标题在弹窗**之前**, 断言却要求它 FOLLOWING。这类"钉错了方向"的
  // 断言比没有断言更糟 —— 它会一直红, 逼人学会忽略它。)
  const onTop = await page.evaluate(() => {
    const d = document.querySelector('[data-confirm-dialog="album"]');
    if (!d) return "missing";
    const r = d.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return d.contains(hit) ? "ok" : `under:${hit?.tagName ?? "null"}`;
  });
  check("确认弹窗盖在编辑抽屉之上", onTop === "ok", String(onTop));

  /**
   * Esc 只该关弹窗, **不该连带关掉整个抽屉**。
   *
   * 这条钉的是本轮修掉的一个真实缺陷: AlbumEditor 自己的 useEscape 挂
   * 在 document 上, ConfirmDialog 内部也挂了一个, 两个都会响应同一次
   * 按键 -> "按 Esc 取消删除"变成"取消删除 + 丢掉未保存的编辑"。
   *
   * 之所以隐蔽: 抽屉里通常有用户刚改的标题/标签, 丢掉了不会有任何报错,
   * 表现为"我明明改了标题, 保存后还是旧的"。所以必须用"抽屉是否还在"
   * 来判, 而不是只看弹窗关没关。
   */
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-confirm-dialog="album"]', {
    state: "detached",
    timeout: 3000,
  });
  check("Esc 关掉了确认弹窗", (await page.locator('[data-confirm-dialog="album"]').count()) === 0);
  check(
    "Esc 没有连带关掉编辑抽屉",
    (await page.locator('[data-testid="album-edit-title"]').count()) === 1,
  );
  check(
    "抽屉里未保存的编辑还在",
    (await page.locator("[data-album-title]").inputValue()) === DRAFT,
    await page.locator("[data-album-title]").inputValue(),
  );
  // 取消删除后草稿必须还在, 否则那个"保存"按钮点下去也来不及 ——
  // dirty 是相对抽屉打开那一刻的初始值算的, 草稿真丢了就变成"无改动"。
  check(
    "取消删除后仍处于已修改状态",
    ((await page.locator("[data-album-save]").textContent()) || "").includes("保存"),
    (await page.locator("[data-album-save]").textContent()) || "",
  );

  // 再打开一次, 走真正的删除路径。
  await page.click("[data-album-delete]");
  await page.waitForSelector('[data-confirm-dialog="album"]', { timeout: 3000 });
  await page.click('[data-confirm-ok="album"]');
  await page.waitForSelector('[data-testid="album-edit-title"]', { state: "detached", timeout: 5000 });
  check("删除后抽屉关闭", !(await page.locator('[data-testid="album-edit-title"]').count()));
  check("删除后确认弹窗也关闭", !(await page.locator('[data-confirm-dialog="album"]').count()));

  const after = await page.evaluate(async () => (await fetch("/api/gallery")).json());
  check("后端列表不再含该 job", !after.items.find((x) => x.job_id === jid));
  // 软删除的必然结果: 该 job 进了回收站而不是被物理清除。
  const trashed = await page.evaluate(
    async (id) => (await fetch("/api/gallery/trash")).json().then((t) => t.items.some((x) => x.job_id === id)),
    jid,
  );
  check("删除后进了回收站(软删除而非真删)", trashed);
  /**
   * 这一段**手工** purge 回收站里的那一份, 不交给 finally。
   *
   * 理由: 它是本脚本要验的行为之一(软删除), 而 harness 的 finish()
   * 是在页面关闭之前跑的, 那时这条已经进了回收站 —— 由 finish() 统一
   * batch-delete + purge 同样能收干净。之所以仍在这里显式做, 是为了让
   * "软删除"这个断言与"回收站里确实有它"之间没有时间差, 避免下一步
   * 断言读到的是被清理后的状态。
   *
   * ⚠️ 只 purge **本轮这一条**, 绝不用 `/api/gallery/trash/empty`:
   * 那是全局清空, 会把用户回收站里的东西一并永久删除。
   * 详见 verify-gallery-trash.mjs 里对 empty 的前置守卫说明。
   */
  await page.evaluate(async (id) => {
    await fetch(`/api/gallery/trash/${id}/purge`, { method: "POST" });
  }, jid);

  // ---- 7) 无 JS 错误 ----
  const realErrors = errors.filter(
    (e) => !/favicon|manifest|Failed to load resource|Failed to fetch/i.test(e),
  );
  check(
    "无未捕获 JS 异常",
    realErrors.length === 0,
    realErrors.slice(0, 2).join(" | "),
  );
} catch (e) {
  check("脚本主体未抛异常", false, String(e?.message ? e.message : e));
} finally {
  // 顺序刻意如此: harness 先把 outputs/ 收干净, 再关浏览器。
  // 反过来的话, 清理要依赖的页面已经没了。
  await h.finish(entrySnapshot);
  await browser.close();
}

h.report();