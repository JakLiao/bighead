/**
 * 框选(rubber band)与 Shift 范围选的端到端验证。
 *
 * 与 verify-gallery-paging.mjs 的分工:
 * 那个脚本验分页契约; 这个脚本验**多选的三种手势**能正确产生选中集。
 *
 * 覆盖:
 *  1. Shift+点击 = 选一段连续区间(不是追加, 是替换)
 *  2. Shift 反向选择(往后拖的方向相反时也成立)
 *  3. 没有锚点时第一次 Shift+点击 = 只选它自己
 *  4. 普通点击仍是切换勾选(不是全选)
 *  5. 拖动框选 = 选中矩形内的卡片, 并自动进入多选
 *  6. 框选会替换已有选中集
 *  7. 从卡片上按下拖动**不会**变成框选(保护点击行为)
 *  8. 框选后那一次 click 被吞掉(不会顺带弹出编辑器)
 *  9. 框选在多选模式下同样可用
 *  10. 框选后可以直接批量删除
 *
 * 数据安全: 本脚本只点自己造的数据, 删也只有自己造的。
 */
import { chromium } from "playwright";

// 刻意不叫 URL: 后面要用 new URL(...) 解析请求 url。
const PAGE_URL = process.env.APP_URL || "http://localhost:5173/gallery";
const API = process.env.API_URL || "http://127.0.0.1:8077/api";
const OUT = "f:/Trae-work/bighead/outputs";
const PASS = [];
const FAIL = [];
const check = (n, c, d = "") => {
  (c ? PASS : FAIL).push(n);
  console.log(`  [${c ? "PASS" : "FAIL"}] ${n}${d ? "  " + d : ""}`);
};

/**
 * 本次运行的唯一标记。
 *
 * **搜索必须用它, 而不是"mq"这种可复用的前缀**。
 * 早先按 `mq` 搜, 于是只要上一轮有任何 `mq*` 没清干净(异常退出、
 * 手动 Ctrl+C、断言失败后我提前返回), 那些残留就会混进本次搜索结果。
 * 后果是 `waitForFunction(卡片数 === 6)` 等到的是"新 6 + 旧 N"的混合,
 * 于是按 DOM 下标算的期望值全部错位 —— 表现为"区间选随机算错",
 * 而实际被测代码完全正常(同��代码第 1 次跑是 23/0 全绿)。
 *
 * 唯一标记让"搜到什么"与"历史残留"彻底无关。
 * 长度受ALBUM_MAX_TAG(=16) 限制, 所以用 base36 短码。
 */
const RUN = `mq${Date.now().toString(36).slice(-9)}`;
const PREFIX = RUN.slice(0, 3);

const created = new Set();
const fsp = await import("node:fs/promises");
const path = await import("node:path");

function jpeg() {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
      "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
      "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
    "base64",
  );
}

/**
 * 造 job 并**自己登记**进 created。
 *
 * 登记责任放在这里而不是调用方: verify-gallery-paging.mjs 曾因调用方漏 push
 * 导致清理静默空转, 测试数据留在真实 outputs/ 里而脚本全程 0 失败。
 */
async function makeJob(prefix) {
  for (let i = 0; i < 40; i++) {
    // 前缀带本次运行的短码: 万一清理失败, 下次也不会被误当成自己的数据
    const id = `${prefix}${RUN.slice(2)}${Date.now().toString(36)}${i}`;
    const full = path.join(OUT, id);
    try {
      await fsp.mkdir(full, { recursive: false });
    } catch {
      continue;
    }
    await fsp.writeFile(path.join(full, "photo_1.jpg"), jpeg());
    created.add(id);
    // 打上本次运行的唯一标记: 搜索靠它而不是靠目录名前缀,
    // 于是历史残留(任何前缀)都不会混进筛选结果。
    await fetch(`${API}/gallery/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: RUN }),
    }).catch(() => {});
    return id;
  }
  throw new Error("makeJob 未能创建唯一目录");
}

async function cleanup() {
  if (!created.size) return;
  await fetch(`${API}/gallery/batch-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_ids: [...created], permanent: true }),
  });
  // permanent 对源目录已不在的 id 返回 missing, 清不到回收站里那一份, 必须逐个 purge。
  for (const id of created) {
    await fetch(`${API}/gallery/trash/${id}/purge`, { method: "POST" }).catch(() => {});
  }
  created.clear();
}

/** 当前选中的 job_id 集合(读 DOM 上的勾选态)。 */
async function readSelected(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-job-id]"))
      .filter((el) => el.getAttribute("aria-pressed") === "true")
      .map((el) => el.getAttribute("data-job-id")),
  );
}

/** 读顶栏的「已选 N 条」。 */
async function readCount(page) {
  const txt = await page.locator("[data-gallery-selected-count]").textContent().catch(() => null);
  return txt ? Number((txt.match(/\d+/) || [])[0] ?? -1) : -1;
}

const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", e));

try {
  // 造 6 条, 用搜索框过滤到只剩它们, 这样顺序与位置都可控。
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(await makeJob(PREFIX));
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  /**
   * 搜索用**本次运行的唯一标记**(makeJob 已把它写进 title),
   * 不用"mq"这种固定前缀 —— 见 RUN 的注释: 前缀会与历史残留撞车,
   * 而按固定前缀搜出来的混合集合会让后续所有按下标算的期望值错位。
   */
  await page.fill("[data-gallery-search]", RUN);
  await page.waitForSelector(`[data-job-id="${ids[0]}"]`, { timeout: 10000 });
  // 等筛选生效: 6 条都要在, 否则后面按下标算区间会算错。
  await page.waitForFunction(
    (n) => document.querySelectorAll("[data-job-id]").length === n,
    ids.length,
    { timeout: 10000 },
  );
  check("筛出恰好 6 条", (await page.locator("[data-job-id]").count()) === 6);

  // ---------- 进入多选 ----------
  await page.locator("[data-gallery-select-mode]").click();
  await page.waitForSelector("[data-gallery-select-all]", { timeout: 5000 });
  check("进入多选模式", (await page.locator("[data-gallery-select-all]").count()) === 1);

  const card = (i) => page.locator(`[data-job-id="${ids[i]}"]`);

  // ===================== 1. Shift 选连续区间 =====================
  /**
   * 一律用**DOM 顺序**而不是"我造出来的顺序"作为期望值。
   *
   * 画廊按 mtime 倒序展示, 而 makeJob 是按时间顺序创建的 ——
   * 两个顺序不同。早先直接拿 ids[i] 当期望值, 于是前 4 张碰巧对上
   * (通过), 换一段就错(红), 表现为"区间选随机算错"。
   * 用 dom[i] 才是"用户眼睛看到的第 i 张"。
   */
  const dom = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-job-id]")).map((e) => e.getAttribute("data-job-id")),
  );
  check("DOM 顺序与筛选结果一致", dom.length === ids.length && ids.every((x) => dom.includes(x)));

  const sameSet = (got, want) =>
    got.length === want.length && JSON.stringify(got.slice().sort()) === JSON.stringify(want.slice().sort());

  await card(1).click();
  check("普通点击选中 1 条", (await readSelected(page)).length === 1, `got ${(await readSelected(page)).length}`);

  await card(4).click({ modifiers: ["Shift"] });
  await page.waitForTimeout(200);
  let sel = await readSelected(page);
  /**
   * 断言"选中集 == 期望区间"而不是"选中了 4 条"。
   * 后者会在锚点算错时仍然通过(比如错位地选了 4 张)。
   */
  check("Shift+点击选中 1..4 的连续区间", sameSet(sel, dom.slice(1, 5)), JSON.stringify(sel));
  check("顶栏计数与实际一致", (await readCount(page)) === 4, `count=${await readCount(page)}`);

  // ===================== 2. 反向 Shift =====================
  await card(5).click();
  await page.waitForTimeout(150);
  await card(3).click({ modifiers: ["Shift"] });
  await page.waitForTimeout(200);
  sel = await readSelected(page);
  check(
    "Shift 反向选择(向后)同样成立",
    sameSet(sel, dom.slice(3, 6)),
    JSON.stringify(sel),
  );

  // ===================== 3. Shift 是替换而非追加 =====================
  // 先点 0(锚点=0), Shift 点 2 => 选中 0..2; 再 Shift 点 4 => 应变成 0..4,
  // 而不是 0,1,2 + 0..4 的并集(那会让计数悄悄变大)。
  await card(0).click();
  await page.waitForTimeout(150);
  await card(2).click({ modifiers: ["Shift"] });
  await page.waitForTimeout(150);
  await card(4).click({ modifiers: ["Shift"] });
  await page.waitForTimeout(200);
  sel = await readSelected(page);
  check(
    "连续 Shift 替换选中集而非累积",
    sameSet(sel, dom.slice(0, 5)),
    JSON.stringify(sel),
  );

  // ===================== 4. 普通点击是切换而非全选 =====================
  // 上一步选中 dom[0..4] 共 5 张, 点掉 dom[3] 之后应剩 4 张。
  await card(3).click();
  await page.waitForTimeout(150);
  sel = await readSelected(page);
  check(
    "普通点击只切换那一张(其余保持)",
    sameSet(sel, dom.slice(0, 3).concat(dom.slice(4, 5))),
    JSON.stringify(sel),
  );
  check("取消勾选后数量减一", (await readCount(page)) === 4, `count=${await readCount(page)}`);

  // ===================== 5. 拖动框选 =====================
  // 退出多选, 用空白处起拖框选
  await page.locator("[data-gallery-select-mode]").click();
  await page.waitForTimeout(200);

  /**
   * 框选: 在网格内按下并拖动。
   *
   * 坐标都相对网格容器左上角 —— 绝对坐标在滚动后会漂。
   *
   * 起点刻意放在**第一张卡片上**而不是空白处: 卡片铺满网格宽度,
   * gap 只在卡片之间, 实测 `pointerdown` 的 target 几乎总是某张卡片
   * (grid box 与 card0 box 的 x/y 完全相同)。早先"必须从空白处起拖"
   * 的设计因此让框选永远触发不了。
   */
  async function marqueeDrag(from, to) {
    const box = await page.locator("[data-gallery-grid]").boundingBox();
    await page.mouse.move(box.x + from.x, box.y + from.y);
    await page.mouse.down();
    // 分几步移动: 一步到位的话浏览器不会派发足够的 pointermove,
    // 框选矩形还没来得及更新就 pointerup 了。
    for (let i = 1; i <= 5; i++) {
      await page.mouse.move(
        box.x + from.x + ((to.x - from.x) * i) / 5,
        box.y + from.y + ((to.y - from.y) * i) / 5,
      );
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
    await page.waitForTimeout(250);
  }

  // 只框前两张: 起点在第一行左外侧, 终点落在第二行中部
  const gridBox = await page.locator("[data-gallery-grid]").boundingBox();
  const card0 = await card(0).boundingBox();
  const card1 = await card(1).boundingBox();
  // 起点: 第一张卡片左侧的 gap 处
  await marqueeDrag({ x: 2, y: card0.y - gridBox.y + 4 }, {
    x: card1.x - gridBox.x + card1.width - 4,
    y: card0.y - gridBox.y + 4,
  });
  sel = await readSelected(page);
  check(
    "框选选中前两张",
    sameSet(sel, dom.slice(0, 2)),
    JSON.stringify(sel),
  );
  check("框选自动进入多选", (await page.locator("[data-gallery-select-all]").count()) === 1);

  // ===================== 6. 框选替换已有选中集 =====================
  // 连着框两次同一区域: 结果必须完全一样(幂等), 而不是"第二次把
  // 上次的选中当成追加"导致越框越多。
  await marqueeDrag({ x: 2, y: card0.y - gridBox.y + 4 }, {
    x: card1.x - gridBox.x + card1.width - 4,
    y: card0.y - gridBox.y + 4,
  });
  sel = await readSelected(page);
  check("重复框选同一区域结果一致", sameSet(sel, dom.slice(0, 2)), JSON.stringify(sel));

  // ===================== 7. 从卡片上起拖**也能**框选 =====================
  // 卡片铺满网格、gap 只在卡片之间, 所以"从空白处起拖"是不可行的 ——
  // 第一版把"落在卡片上就 return"当成保护点击的做法, 实际上让这个功能
  // 永远触发不了。真实语义是: 框选是**后置判定**(越过阈值才接管),
  // 于是从任何位置起拖都能用, 而轻点仍然走点击。
  await page.locator("[data-gallery-select-mode]").click(); // 退出多选
  await page.waitForTimeout(200);
  const card2Box = await card(2).boundingBox();
  check(
    "退出多选后从卡片上起拖**也**能框选",
    await (async () => {
      await page.mouse.move(card2Box.x + card2Box.width / 2, card2Box.y + 8);
      await page.mouse.down();
      for (let i = 1; i <= 5; i++) {
        await page.mouse.move(card2Box.x + card2Box.width / 2 + i * 30, card2Box.y + 8 + i * 12);
        await page.waitForTimeout(20);
      }
      await page.mouse.up();
      await page.waitForTimeout(250);
      return (await readSelected(page)).length > 0;
    })(),
    `选中 ${(await readSelected(page)).length} 张`,
  );
  check("拖动后自动进入多选", (await page.locator("[data-gallery-select-all]").count()) === 1);

  // ===================== 7b. 从页面左边缘起拖也能框选 =====================
  /**
   * 回归: 早先 pointer 事件只绑在 `[data-gallery-grid]` 上, 而网格有
   * `px-6` 内边距(24px)与 gap。用户滚动到下面后很自然地从**左边缘空白**
   * 起拖, 那个位置命中的是 `DIV < MAIN`, pointerdown 到不了网格 ——
   * 框选静默失败, 表现是"拖了没反应", 不报任何错。
   *
   * 这条必须显式钉住, 因为它测的是"事件绑在哪"而不是"框选算法对不对":
   * 早先 42 项断言全绿, 唯独漏了这个位置。
   */
  await page.locator("[data-gallery-select-mode]").click(); // 退出多选
  await page.waitForTimeout(200);
  // 起点取 x=2 —— 明确落在 px-6 内边距里, 而不在任何卡片上。
  const edgeOk = await page.evaluate(() => {
    const first = document.querySelector("[data-gallery-card]");
    if (!first) return { skipped: true };
    const r = first.getBoundingClientRect();
    const el = document.elementFromPoint(2, Math.round(r.y + 10));
    const inGrid = !!(el && el.closest("[data-gallery-grid]"));
    return { skipped: false, inGrid, cardLeft: Math.round(r.x) };
  });
  // 前提断言: 起点 x=2 必须**落在网格外**。若哪天布局改成没有 px-6,
  // 这条会先失败, 提醒"前提已变, 后面那条测的不再是边缘场景"。
  check(
    "前提: 左边缘起点在网格之外",
    edgeOk.skipped === true || edgeOk.inGrid === false,
    JSON.stringify(edgeOk),
  );
  if (!edgeOk.skipped) {
    const dragY = await page.evaluate(
      () => Math.round(document.querySelector("[data-gallery-card]").getBoundingClientRect().y) + 10,
    );
    await page.mouse.move(2, dragY);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(2 + i * 120, dragY + i * 20);
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
    await page.waitForTimeout(300);
    check("从页面左边缘起拖也能框选", (await readSelected(page)).length > 0,
      `选中 ${(await readSelected(page)).length} 张`);
  }
  check(
    "拖动不会顺带弹出编辑器(click 被吞)",
    (await page.locator('[data-testid="album-edit-title"]').count()) === 0,
  );

  // ===================== 7c. 点勾选路径也要能唤出浮动条 =====================
  /**
   * 回归: 早先所有浮动条断言都跑在**筛选后的 6 张卡**上, 页面只有两行,
   * 根本没有滚动空间 —— `scrollTo` 静默失效, `docH` 撑不到一屏。
   * 于是"滚动后浮动条出现"这条**从来没被真正验证过**。
   *
   * 第一版这条断言是红的, 我一度归因为"`useScrolledPast` 的负 rootMargin
   * 造成观察器死区"。后来做故障注入才发现: 把 rootMargin 加回去、连 scroll
   * 兜底一起删掉, **50 项照样全绿** —— 说明代码本来就是对的, 错的是
   * **测试环境不成立**。
   *
   * 所以这条断言的价值不在于"钉住某个 bug", 而在于**换一条操作路径**
   * (点勾选而非框选) 并**保证页面真的能滚**。以后任何人把搜索筛选提前,
   * "前提: 清空搜索后页面可滚动"会先失败提醒。
   */
  await page.locator("[data-gallery-select-mode]").click(); // 退出多选
  await page.waitForTimeout(200);
  // 清空搜索, 让页面恢复成可滚动状态。applyQuery 会清掉 selected, 所以
  // 顺序必须是"先清搜索, 再点选"。
  await page.fill("[data-gallery-search]", "");
  await page.waitForTimeout(800);
  await page.waitForSelector("[data-gallery-card]", { timeout: 10000 });
  const canScroll = await page.evaluate(
    () => document.body.scrollHeight > window.innerHeight + 200,
  );
  check("前提: 清空搜索后页面可滚动", canScroll === true);
  await page.locator("[data-gallery-select-mode]").click(); // 进入多选
  await page.waitForSelector("[data-gallery-select-all]", { timeout: 5000 });
  for (let i = 0; i < 2; i++) {
    await page.locator("[data-gallery-card]").nth(i).locator("[data-gallery-check]").click();
    await page.waitForTimeout(180);
  }
  check("点勾选框也能选中", (await readSelected(page)).length === 2,
    `选中 ${(await readSelected(page)).length} 张`);
  // 关键断言: 纯点选 + 滚动, 浮动条必须出现。这条在 rootMargin 存在时是红的。
  await page.evaluate(() => window.scrollTo(0, 1500));
  await page.waitForTimeout(800);
  // 诊断输出: 失败时能一眼看出是"没选中"还是"选中了但条没出来"。
  const diag = await page.evaluate(() => ({
    sel: document.querySelector("[data-gallery-selected-count]")?.textContent?.trim() ?? null,
    checked: document.querySelectorAll("[data-gallery-check].bg-brick").length,
    tbTop: (() => {
      const e = document.querySelector("[data-gallery-select-all]");
      return e ? Math.round(e.parentElement.getBoundingClientRect().top) : null;
    })(),
    y: Math.round(window.scrollY),
    docH: document.body.scrollHeight,
    bar: document.querySelectorAll("[data-gallery-floating-bar]").length,
  }));
  check(
    "点勾选路径下滚动后也出现浮动条",
    diag.bar === 1,
    JSON.stringify(diag),
  );
  // 滚回顶部必须收起, 否则两处操作条会同时在。
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  check(
    "滚回顶部后浮动条收起",
    (await page.locator("[data-gallery-floating-bar]").count()) === 0,
  );
  // 恢复: 退出多选、清空选中、**把搜索词加回去**。后面 7b 与第 9 段都
  // 依赖那 6 张卡的顺序, 不恢复的话它们会对着全量列表取 nth(3) 而错位。
  await page.locator("[data-gallery-select-mode]").click();
  await page.waitForTimeout(300);
  check("退出多选后选中集清空", (await readSelected(page)).length === 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.fill("[data-gallery-search]", RUN);
  await page.waitForSelector(`[data-job-id="${ids[0]}"]`, { timeout: 10000 });
  await page.waitForTimeout(500);
  check(
    "恢复搜索后回到 6 张卡",
    (await page.locator("[data-gallery-card]").count()) === 6,
    `count=${await page.locator("[data-gallery-card]").count()}`,
  );
  await page.locator("[data-gallery-select-mode]").click();
  await page.waitForSelector("[data-gallery-select-all]", { timeout: 5000 });

  // ===================== 7b. 轻点仍然走点击 =====================
  // 框选是后置判定的另一面: 没越过阈值时**不得**干预点击。
  // 这条不成立的话, 整个画廊就没法点开了。
  await page.locator("[data-gallery-select-mode]").click(); // 退出多选
  await page.waitForTimeout(200);
  await card(3).click();
  await page.waitForTimeout(400);
  check(
    "轻点卡片仍然打开编辑器(框选没抢走点击)",
    (await page.locator('[data-testid="album-edit-title"]').count()) === 1,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // ===================== 8. 多选模式下也能框选 =====================
  await page.locator("[data-gallery-select-mode]").click();
  await page.waitForTimeout(200);
  await marqueeDrag({ x: 2, y: card0.y - gridBox.y + 4 }, {
    x: card1.x - gridBox.x + card1.width - 4,
    y: card0.y - gridBox.y + 4,
  });
  sel = await readSelected(page);
  check("多选模式下框选同样可用", sameSet(sel, dom.slice(0, 2)), JSON.stringify(sel));

  // ===================== 8b. 吸底浮动操作条 =====================
  /**
   * 需求: 「我滚动到下面, 选中多个照片, 但是没有见到操作按键」。
   *
   * 根因是工具栏在文档流里, 滚动后跟着走出视口 —— 而卡上的勾还在,
   * 于是看上去像"选上了却没法操作"。现在顶栏滚出视口后, 底部浮出
   * 一条常驻操作条。
   *
   * 断三个时机, 少一个都不够:
   *   - 未选中: 不该占地方。
   *   - 选中但**没滚动**: 顶栏还在视野里, 此时浮出会变成"两套一样的
   *     按钮同时存在", 用户会以为页面重复渲染了。
   *   - 滚动后: 必须出现, 且**在视口内**(用 boundingBox 断,
   *     不用 count —— 元素存在不等于看得见)。
   */
  check(
    "选中但未滚动时底部不出现浮动条",
    (await page.locator("[data-gallery-floating-bar]").count()) === 0,
  );

  /**
   * 必须**清空搜索并重新选中**再测浮动条。
   *
   * 两个坑叠在一起:
   *
   * 1. 前面为了控制顺序与位置, 一直用搜索把列表筛到 6 条 —— 6 张卡只有
   *    两三行, 页面根本没得滚, 顶栏永远不会离开视口。
   * 2. 更隐蔽的是: **清空搜索会清掉 selected**。`applyQuery` 在改筛选时
   *    明确 `setSelected(new Set())` —— 这是**正确设计**(换了筛选还留着
   *    旧选中, 就会出现"按钮写着 5 条、其中 4 条看不见"的危险组合)。
   *    所以清空搜索后浮动条不出现是**对的**, 因为那时确实没选东西。
   *
   * 于是顺序必须是: 清空搜索 → 重新勾选 → 再滚动。
   *
   * 另外不能用 scrollTo(0, scrollHeight) 一次到底: 无限滚动有 800px
   * 预取, 滚到底会触发下一批加载, 页面再次变长, 位置也不再是真正的底部
   * —— 分段 scrollBy 才是稳定的。
   */
  await page.fill("[data-gallery-search]", "");
  await page.waitForTimeout(800);
  await page.waitForSelector("[data-gallery-card]", { timeout: 10000 });
  // 重新勾 2 张(全量列表里的前两张)。用 data-job-id 定位, 不用下标 ——
  // 清空搜索后 items 换了一批, 下标不再对应刚才那 6 条。
  const freshIds = await page.evaluate(() =>
    [...document.querySelectorAll("[data-gallery-card]")].slice(0, 2)
      .map((e) => e.getAttribute("data-gallery-card")),
  );
  for (const id of freshIds) {
    await page.locator(`[data-job-id="${id}"]`).click();
    await page.waitForTimeout(150);
  }
  check("清空搜索后重新选中 2 条", (await readSelected(page)).length === 2,
    `sel=${(await readSelected(page)).length}`);
  // 确认页面真的够长: 视口底边之下还得有内容。
  const scrollable = await page.evaluate(
    () => document.body.scrollHeight > window.innerHeight + 200,
  );
  check("清空搜索后页面可滚动", scrollable === true);
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(700);

  const bar = page.locator("[data-gallery-floating-bar]");
  // 先确认顶栏真的滚出去了 —— 否则下面所有断言都没有意义。
  // (count 为 0 时不能再取 boundingBox, 会 30 秒超时。)
  const toolbarSel = await page.locator("[data-gallery-select-all]").first().boundingBox();
  const toolbarGone = !toolbarSel || toolbarSel.y + toolbarSel.height < 0;
  check("顶栏已滚出视口", toolbarGone, `toolbarY=${toolbarSel ? Math.round(toolbarSel.y) : "null"}`);

  const barCount0 = await bar.count();
  check("滚动后底部出现浮动条", barCount0 === 1, `count=${barCount0}`);
  if (barCount0 === 1) {
    const barBox = await bar.boundingBox();
    const vh = page.viewportSize().height;
    check(
      "浮动条确实在视口内(不是存在但看不见)",
      !!barBox && barBox.y >= 0 && barBox.y + barBox.height <= vh + 2,
      `y=${barBox ? Math.round(barBox.y) : "null"} h=${barBox ? Math.round(barBox.height) : "?"} vh=${vh}`,
    );
    /**
     * 断"高度 < 64px" 而不只是 count —— 这是本轮抓到的一个真实回归:
     * 浮动条是 flex, 子项默认可压缩, 空间不够时中文被压成**竖排**,
     * 420px 视口下整条只有 210px 宽却占 148px 高, 看起来像渲染错误。
     * count 依然是 1, 所以只断数量的测试**抓不到**它。
     */
    check(
      "浮动条是单行(未被压成竖排)",
      !!barBox && barBox.height < 64,
      `h=${barBox ? Math.round(barBox.height) : "null"}`,
    );
    // 浮动条上的数字必须与选中数一致(同一份 state)。
    const barCnt = ((await bar.locator("[data-gallery-floating-count]").textContent()) || "").trim();
    check("浮动条计数与选中数一致", barCnt === "已选 2 条", `bar=${barCnt}`);
    // 关键: 删除按钮要能点, 且点得开删除弹窗。
    check(
      "浮动条上有删除按钮",
      (await bar.locator("[data-gallery-floating-delete]").count()) === 1,
    );
    /**
     * "回到选中": 浮动条解决了按钮可见, 但选中项可能已滚出视野 ——
     * 用户看得到"已选 2 条"却看不到是哪两张。这个按钮把选中项带回视野。
     */
    check(
      "浮动条上有「回到选中」",
      (await bar.locator("[data-gallery-floating-back]").count()) === 1,
    );
    const backY = await page.evaluate(() => window.scrollY);
    await bar.locator("[data-gallery-floating-back]").click();
    await page.waitForTimeout(900); // smooth scroll
    const afterY = await page.evaluate(() => window.scrollY);
    check("点「回到选中」后视口位置改变", afterY !== backY, `${Math.round(backY)} -> ${Math.round(afterY)}`);
    // 滚回之后第一张选中卡必须在视野内, 否则这按钮没起作用。
    const firstSelVisible = await page.evaluate(() => {
      const box = document.querySelector("[data-gallery-check].bg-brick");
      if (!box) return "no-checked";
      const r = box.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight;
    });
    check("滚回后能看到选中的卡片", firstSelVisible === true, String(firstSelVisible));

    // 再滚下去, 继续验删除。
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollBy(0, 500));
      await page.waitForTimeout(160);
    }
    await page.waitForTimeout(500);
    check("再次滚动后浮动条仍在", (await bar.count()) === 1);

    await bar.locator("[data-gallery-floating-delete]").click();
    await page.waitForSelector('[data-confirm-dialog="batch"]', { timeout: 5000 });
    check(
      "从浮动条能打开删除确认弹窗",
      (await page.locator('[data-confirm-dialog="batch"]').count()) === 1,
    );
    // 弹窗必须盖住浮动条, 不能被它压住(z-50 vs z-40)。
    const onTop = await page.evaluate(() => {
      const d = document.querySelector('[data-confirm-dialog="batch"]');
      if (!d) return "missing";
      const r = d.getBoundingClientRect();
      return d.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
        ? "ok"
        : "under";
    });
    check("弹窗盖在浮动条之上", onTop === "ok", String(onTop));
    await page.locator('[data-confirm-cancel="batch"]').click();
    await page.waitForSelector('[data-confirm-dialog="batch"]', { state: "detached", timeout: 5000 });
  }
  // 收工: 退出多选、清空选中, 让第 9 段重新开始。
  // 不用 scrollTo(0,0) 再恢复搜索 —— 直接退多选更干净, 也避免
  // "滚回去之后 applyQuery 顺手清了选中" 这类状态纠缠。
  await page.locator("[data-gallery-select-mode]").first().click();
  await page.waitForTimeout(300);
  check(
    "退出多选后浮动条消失",
    (await page.locator("[data-gallery-floating-bar]").count()) === 0,
  );
  check("退出多选后选中集清空", (await readSelected(page)).length === 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  await page.fill("[data-gallery-search]", RUN);
  await page.waitForSelector(`[data-job-id="${ids[0]}"]`, { timeout: 10000 });
  await page.waitForTimeout(400);

  // ===================== 9. 框选后直接批量删除 =====================
  // 上一段收尾时退出了多选, 这里要重新进入并重新框选 ——
  // 8b 段为了测浮动条清空过搜索, 那 6 条已不在当前列表里。
  await page.locator("[data-gallery-select-mode]").click();
  await page.waitForSelector("[data-gallery-select-all]", { timeout: 5000 });
  const dom9 = await page.evaluate(() =>
    [...document.querySelectorAll("[data-gallery-card]")]
      .map((e) => e.getAttribute("data-gallery-card")),
  );
  const gridBox9 = await page.locator("[data-gallery-grid]").boundingBox();
  const b0 = await page.locator(`[data-gallery-card="${dom9[0]}"]`).boundingBox();
  const b1 = await page.locator(`[data-gallery-card="${dom9[1]}"]`).boundingBox();
  await marqueeDrag({ x: 2, y: b0.y - gridBox9.y + 4 }, {
    x: b1.x - gridBox9.x + b1.width - 4,
    y: b0.y - gridBox9.y + 4,
  });
  check("第 9 段重新框选两张", (await readSelected(page)).length === 2,
    `sel=${(await readSelected(page)).length}`);
  await page.locator("[data-gallery-batch-delete]").click();
  await page.waitForSelector('[data-confirm-dialog="batch"]', { timeout: 5000 });
  check("框选后弹出删除确认框", (await page.locator('[data-confirm-dialog="batch"]').count()) === 1);
  // 框选两张 -> 弹窗正文的数字必须也是 2。这条钉的是"弹窗读的是当前
  // 选中集而不是某个缓存值": 框选刚结束就开弹窗, 数字若对不上, 用户就是
  // 对着「2 条」点下去删掉了别的批次。
  //
  // 断**正文**而不是全文: 全文里还有标题和按钮, 它们都不带数字, 断全文
  // 等于让无关文案参与了这条断言 —— 将来哪天上文案里加个数字就会假失败。
  const dlgBody =
    (await page.locator('[data-confirm-dialog="batch"]').textContent()) || "";
  check("确认框正文数字与框选数量一致", /选中的 2 条/.test(dlgBody), dlgBody.slice(0, 60));
  await page.locator('[data-confirm-ok="batch"]').click();
  await page.waitForSelector("[data-gallery-batch-note]", { timeout: 15000 });
  const note = (await page.locator("[data-gallery-batch-note]").textContent()) || "";
  check("批量删除提示点名回收站", note.includes("回收站"), note);
  check(
    "被框选的两张已进回收站",
    (await fetch(`${API}/gallery/trash`)
      .then((r) => r.json())
      .then((t) => t.items.filter((x) => dom.slice(0, 2).includes(x.job_id)).length)) === 2,
  );
} catch (e) {
  check("脚本执行未抛异常", false, String(e && e.message ? e.message : e));
} finally {
  await cleanup();
  await browser.close();

  /**
   * 收尾断言: 清理必须真的干净。
   *
   * 扫的是**本次运行的短码**(id 形如 mq<run><time><n>)而不是整个 mq 前缀
   * —— 后者会把别的脚本/历史轮次的数据算成"我的残留", 在共用环境下
   * 误报。按前缀扫而不是逐个比对 created 的理由不变: 漏登记的 id 根本
   * 不在 created 里, 逐个比对恰好会漏掉问题本身(这是 verify-gallery-paging
   * 实测踩过的坑: 回收站里躺着 3 条残留而脚本 0 失败)。
   */
  const mine = new RegExp(`^${PREFIX}${RUN.slice(3)}`);
  const leftover = await fetch(`${API}/gallery/trash`)
    .then((r) => r.json())
    .then((t) => t.items.map((x) => x.job_id))
    .catch(() => []);
  check(
    "回收站里没有本次运行的残留",
    !leftover.some((id) => mine.test(id)),
    `残留: ${leftover.join(",")}`,
  );
  const albumKeys = await (async () => {
    try {
      return Object.keys(JSON.parse(await fsp.readFile(`${OUT}/_album.json`, "utf-8")));
    } catch {
      // 文件不存在 = 没有孤儿键
      return [];
    }
  })();
  check(
    "_album.json 里没有本次运行的孤儿键",
    !albumKeys.some((k) => mine.test(k)),
    `孤儿键: ${albumKeys.join(",")}`,
  );
}

console.log(`\nResult: ${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length) console.log("FAILED:", FAIL.join(" | "));
process.exit(FAIL.length ? 1 : 0);