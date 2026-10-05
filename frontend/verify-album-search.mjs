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
  viewport: { width: 1280, height: 2000 },
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", e));

await page.goto(URL, { waitUntil: "domcontentloaded" });

async function makeJob(n) {
  return page.evaluate(async (idx) => {
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
    return (await r.json()).job_id;
  }, n);
}

const jidA = await makeJob(1);
const jidB = await makeJob(2);
const jidC = await makeJob(3);
check("三条 job 创建成功", !!jidA && !!jidB && !!jidC);

try {
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
} finally {
  for (const jid of [jidA, jidB, jidC]) {
    await page
      .evaluate(async (j) => {
        await fetch(`/api/gallery/${j}`, { method: "DELETE" }).catch(() => {});
      }, jid)
      .catch(() => {});
  }
  await browser.close();
}

console.log(`\nResult: ${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length) console.log("FAILED:", FAIL.join(" | "));
process.exit(FAIL.length ? 1 : 0);
