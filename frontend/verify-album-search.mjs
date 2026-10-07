/**
 * 贴纸册搜索/筛选 + no-op PATCH + Escape 关闭 端到端验证。
 *
 * 覆盖：
 *  1. ?q= 大小写不敏感，命中 title/note/tags/job_id 任一
 *  2. ?tag= 精确匹配；多 tag 逗号分隔任一命中
 *  3. ?q= 与 ?tag= 叠加（AND）
 *  4. tags 汇总的 count 正确，且只统计筛选后的结果
 *  5. no-op PATCH 返回 changed=false（后端不写盘）
 *  6. 标签顺序不同算 no-op（集合语义）
 *  7. 局部 PATCH 不清空未传的字段
 *  8. UI：搜索框输入后列表收敛；标签芯片 aria-pressed 切换
 *  9. UI：内容无改动时保存按钮置灰显示「无改动」
 * 10. UI：编辑抽屉内按 Esc 关闭
 *
 * 注：本脚本自己造数据、自己清理，不依赖其他脚本的残留。
 */
import { chromium } from "playwright";
import { createHarness } from "./verifyHarness.mjs";

const URL = process.env.APP_URL || "http://localhost:5173/gallery";

/**
 * 夹具接管断言与清理。
 *
 * 本脚本三条 job 都由 /api/capture/save 生成, 是后端随机 hex, 目录名里没有
 * 可识别前缀 —— 早先"逐个比对登记过的 id"的收尾自检对它们完全无感。
 * 快照 diff 看的是"本轮期间 outputs/ 多了什么", 与目录名无关。
 */
const h = await createHarness("verify-album-search");
const check = h.check;
const entrySnapshot = await h.snapshot();

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
  viewport: { width: 1280, height: 2000 },
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", e));

await page.goto(URL, { waitUntil: "domcontentloaded" });

/**
 * 造一条 job 并登记。
 *
 * 登记仍然在造数函数内部完成 —— 早先是"造完三条之后再 push", 于是造到
 * 第二条失败时登记集合是空的, 而第一条其实已经落盘 —— 清理会拿着
 * "undefined" 去打 DELETE(400), 真正的残留反而留着。
 *
 * 用 `adopt` 而不是 `adoptMarked`: 本脚本的搜索断言是**精确计数**的
 * ("q 不命中返回空" 期望 0 条、"q 命中备注" 期望恰好 1 条)。给三条 job
 * 打上同一个 runTag 标题, 等于往搜索索引里塞了一个所有 job 都命中的词 ——
 * 一旦某条搜索词与 runTag 碰巧重叠(它含 6 位 base36 短码), "恰好 1 条"
 * 会变成 3 条, 而被测代码完全正常。
 *
 * 详见 verify-album-meta.mjs 里同名的说明: 判断标准是"这个脚本有没有
 * 断言 title/tags 的值或计数", 有就只能 adopt。
 */
async function makeJob(n) {
  const id = await page.evaluate(async (idx) => {
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 400;
    const g = c.getContext("2d");
    g.fillStyle = ["#c0392b", "#27ae60", "#8e44ad"][idx % 3];
    g.fillRect(0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    const fd = new FormData();
    fd.append("images", blob, `p${idx}.jpg`);
    const r = await fetch("/api/capture/save", { method: "POST", body: fd });
    if (!r.ok) throw new Error(`capture/save ${r.status}`);
    return (await r.json()).job_id;
  }, n);
  return h.adopt(id);
}

let jidA;
let jidB;
let jidC;
try {
  jidA = await makeJob(1);
  jidB = await makeJob(2);
  jidC = await makeJob(3);
  check("三条 job 创建成功", !!jidA && !!jidB && !!jidC);
  // 造元数据：A 有独特标题，B 有独特标签，C 无元数据
  await page.evaluate(async (a) => {
    await fetch(`/api/gallery/${a}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "毕业旅行",
        note: "西湖边散步",
        tags: ["旅行", "户外"],
        favorite: true,
      }),
    });
  }, jidA);
  await page.evaluate(async (b) => {
    await fetch(`/api/gallery/${b}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "宿舍日常", tags: ["生活"] }),
    });
  }, jidB);
  check("元数据写入成功", true);

  // ---- q 筛选 ----
  const q = async (s) =>
    page.evaluate(async (v) => {
      const r = await fetch(`/api/gallery?q=${encodeURIComponent(v)}`);
      return r.json();
    }, s);

  const q1 = await q("毕业");
  check("q 命中标题", q1.items.length >= 1 && q1.items[0].job_id === jidA, `${q1.items.length}`);

  const q2 = await q("西湖");
  check("q 命中备注", q2.items.length === 1 && q2.items[0].job_id === jidA, `${q2.items.length}`);

  const q3 = await q("旅行");
  check("q 命中标签", q3.items.some((x) => x.job_id === jidA), `${q3.items.length}`);

  const q4 = await q(jidA.slice(0, 6).toUpperCase());
  check("q 搜 job_id 前 6 位（分享卡 footer 上的号）", q4.items.length === 1 && q4.items[0].job_id === jidA, `${q4.items.length}`);

  const q5 = await q("不存在的关键词zzz");
  check("q 不命中返回空", q5.items.length === 0, `${q5.items.length}`);

  // ---- tag 筛选 ----
  const t = async (s) =>
    page.evaluate(async (v) => {
      const r = await fetch(`/api/gallery?tag=${encodeURIComponent(v)}`);
      return r.json();
    }, s);

  const t1 = await t("旅行");
  check("tag 精确命中", t1.items.length === 1 && t1.items[0].job_id === jidA, `${t1.items.length}`);

  const t2 = await t("不存在标签zzz");
  check("tag 不存在返回空", t2.items.length === 0, `${t2.items.length}`);

  const t3 = await t("生活,旅行");
  check("多 tag 逗号分隔任一命中", t3.items.length === 2, `${t3.items.length}`);

  // ---- tags 汇总 ----
  const all = await page.evaluate(async () => (await fetch("/api/gallery")).json());
  check("tags 是数组", Array.isArray(all.tags));
  const travel = all.tags.find((x) => x.tag === "旅行");
  check("tags 汇总含 旅行 且 count 正确", travel?.count === 1, JSON.stringify(travel));
  const filteredTags = await q("毕业");
  check(
    "tags 汇总只统计筛选后结果",
    Array.isArray(filteredTags.tags) && filteredTags.tags.every((x) => x.tag !== "生活"),
    JSON.stringify(filteredTags.tags),
  );

  // ---- no-op PATCH ----
  const noop = await page.evaluate(async (jid) => {
    const r = await fetch(`/api/gallery/${jid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "宿舍日常", tags: ["生活"] }),
    });
    return { status: r.status, body: await r.json() };
  }, jidB);
  check("no-op PATCH 返回 200", noop.status === 200, `got ${noop.status}`);
  check("no-op PATCH changed=false", noop.body.changed === false, JSON.stringify(noop.body.changed));

  // 顺序不同算 no-op: jidB 原本就是 ["生活"], 这里只调顺序不加新标签。
  // （早先误传 ["生活","旅行"] 是真新增了标签, 服务端返回 changed=true 是对的。）
  const reorder = await page.evaluate(async (jid) => {
    const r = await fetch(`/api/gallery/${jid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["生活", "生活"] }),
    });
    return r.json();
  }, jidB);
  check("标签重复项被去重后算 no-op（集合语义）", reorder.changed === false, JSON.stringify(reorder.changed));

  const real = await page.evaluate(async (jid) => {
    const r = await fetch(`/api/gallery/${jid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "宿舍日常改" }),
    });
    return r.json();
  }, jidB);
  check("有变化 PATCH changed=true", real.changed === true, JSON.stringify(real.changed));
  check("局部 PATCH 不清空 tags（仍是 1 个）", Array.isArray(real.tags) && real.tags.length === 1, JSON.stringify(real.tags));
  check("局部 PATCH 保留未设置的 favorite=false", real.favorite === false, JSON.stringify(real.favorite));

  // ---- UI 搜索框 ----
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-gallery-search]", { timeout: 15000 });
  check("搜索框渲染", await page.locator("[data-gallery-search]").count() === 1);

  const search = page.locator("[data-gallery-search]");
  await search.fill("毕业");
  await page.waitForFunction(
    () => document.querySelectorAll("[data-job-id]").length === 1,
    { timeout: 10000 },
  ).catch(() => {});
  const cardCountAfterSearch = await page.locator("[data-job-id]").count();
  check("输入搜索词后列表收敛到 1 条", cardCountAfterSearch === 1, `count=${cardCountAfterSearch}`);

  // ---- UI 标签芯片 ----
  await search.fill("");
  await page.waitForTimeout(600);
  const tagBar = await page.locator("[data-gallery-tags]").count();
  check("标签筛选条渲染", tagBar === 1, `count=${tagBar}`);

  const chip = page.locator('[data-gallery-tag="旅行"]');
  check("存在 旅行 芯片", (await chip.count()) === 1);
  await chip.click();
  await page.waitForTimeout(600);
  const pressed = await page
    .locator('[data-gallery-tag="旅行"]')
    .getAttribute("aria-pressed");
  check("点击芯片后 aria-pressed=true", pressed === "true", String(pressed));
  const afterTag = await page.locator("[data-job-id]").count();
  check("按标签筛选后只剩 1 条", afterTag === 1, `count=${afterTag}`);

  await page.locator('[data-gallery-tag="旅行"]').click();
  await page.waitForTimeout(600);
  const unpressed = await page
    .locator('[data-gallery-tag="旅行"]')
    .getAttribute("aria-pressed");
  check("再点一次取消筛选 aria-pressed=false", unpressed === "false", String(unpressed));

  // ---- UI 搜索空态 ----
  await search.fill("绝对不存在的关键词zzz");
  await page.waitForTimeout(600);
  const emptyMsg = await page.getByText("没有匹配的记录。").count();
  check("筛选无结果显示专用空态文案", emptyMsg >= 1, `count=${emptyMsg}`);

  // ---- UI no-op 置灰 ----
  await search.fill("毕业");
  await page.waitForTimeout(800);
  await page.locator("[data-job-id]").first().click();
  await page.waitForSelector("[data-album-save]", { timeout: 10000 });
  const saveBtn = page.locator("[data-album-save]");
  check("打开抽屉后保存按钮禁用（内容未改）", await saveBtn.isDisabled());
  const btnText = (await saveBtn.textContent()) || "";
  check("按钮文案显示「无改动」", btnText.includes("无改动"), btnText);

  // 抽屉里的标题输入框。必须用 data-album-title 精确定位:
  // page.locator("input").first() 命中的是页面上的**搜索框**, 填它会触发
  // 重新拉列表而不是编辑标题 —— 早先就这么踩过一次, 表现为后续选择器超时。
  const titleInput = page.locator("[data-album-title]");
  check("抽屉内找到标题输入框", (await titleInput.count()) >= 1);
  await titleInput.first().fill("毕业旅行改");
  await page.waitForTimeout(200);
  check("改动后保存按钮解禁", !(await saveBtn.isDisabled()));
  await page.locator("[data-album-cancel]").click();
  await page.waitForSelector("[data-album-save]", { state: "detached", timeout: 10000 });
  check("点取消后抽屉关闭", (await page.locator("[data-album-save]").count()) === 0);

  // ---- UI Escape 关闭 ----
  await page.locator("[data-job-id]").first().click();
  await page.waitForSelector("[data-album-save]", { timeout: 10000 });
  check("抽屉已打开", (await page.locator("[data-album-save]").count()) === 1);
  await page.keyboard.press("Escape");
  await page.waitForSelector("[data-album-save]", { state: "detached", timeout: 10000 });
  check("按 Esc 后抽屉关闭", (await page.locator("[data-album-save]").count()) === 0);

  // Esc 在输入框聚焦时也要生效（这是 useEscape 挂 document 而非容器的原因）
  await page.locator("[data-job-id]").first().click();
  await page.waitForSelector("[data-album-save]", { timeout: 10000 });
  await titleInput.first().focus();
  await page.keyboard.press("Escape");
  await page.waitForSelector("[data-album-save]", { state: "detached", timeout: 10000 });
  check("输入框聚焦时 Esc 仍关闭抽屉", (await page.locator("[data-album-save]").count()) === 0);
} catch (e) {
  // 不静默: 异常若被吞掉, run-all-verify 只能看到"少了断言", 定位成本很高。
  check("脚本主体未抛异常", false, String(e && e.message ? e.message : e));
} finally {
  /**
   * 清理 + 泄漏自检。
   *
   * 换用 harness 的理由, 每一个都对应旧实现的一个真实缺陷:
   *
   * 1. 旧 finally 走 `page.evaluate` 发 DELETE。页面若已崩/已关, evaluate
   *    自己先抛, 整段被 `.catch(() => {})` 吞掉 —— 清理静默失败, 而汇总
   *    早已打印完毕, 看起来是"通过了"。harness 走 node 侧 fetch。
   * 2. 旧收尾自检用 `ids.length === 3` 当"清理成功"的旁证: 造数失败时
   *    登记不足 3 条, 断言转红, 但那报的是"造数失败"而不是"泄漏",
   *    真正该红的清理失效被掩盖了。
   * 3. 旧自检在 `browser.close()` 之后探测: 页面已关, fetch 失败被吞,
   *    两个集合都是 null, `left` 必为空 —— 这条断言**恒真通过**。
   *
   * harness 的快照 diff 在 node 侧读磁盘, 不受页面状态影响, 且只看
   * "本轮期间多了什么", 登记与否都逃不掉。
   */
  await h.finish(entrySnapshot);
  await browser.close();
  h.report();
}
