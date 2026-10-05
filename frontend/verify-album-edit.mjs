/**
 * GalleryPage 贴纸册 UI 端到端验证。
 *
 * 覆盖：
 *  1. 收藏徽标渲染
 *  2. 点卡片打开编辑抽屉
 *  3. 改标题 + 取消收藏 → 保存 → 后端真的更新
 *  4. 标签添加（回车）
 *  5. 取消收藏后从置顶位置掉下来
 *  6. 删除两段式确认 → 列表不再有该条目
 *
 * 自己造数据自己清理，不依赖其他脚本。
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
  viewport: { width: 1280, height: 1800 },
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(URL, { waitUntil: "networkidle" });

// 造一条带元数据的 job（favorite=true 以便验证置顶）
const jid = await page.evaluate(async () => {
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
  const { job_id } = await r.json();
  await fetch(`/api/gallery/${job_id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "待编辑", note: "原备注", tags: ["原标签"], favorite: true }),
  });
  return job_id;
});
check("造数据成功", !!jid, jid);

try {
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="album-edit-title"]', { state: "attached", timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);

  // ---- 1) 收藏徽标 ----
  const starSel = "span:has-text('★')";
  const starCount = await page.locator(starSel).count();
  check("收藏徽标已渲染", starCount >= 1, `count=${starCount}`);

  // 我们造的 job 应该排在第一位（favorite 置顶）
  const firstCardText = await page.locator("button.relative").first().innerText();
  check("favorite 条目排在首位", firstCardText.includes("待编辑"), firstCardText.slice(0, 30));

  // ---- 2) 打开编辑抽屉 ----
  await page.locator("button.relative").first().click();
  await page.waitForSelector('[data-testid="album-edit-title"]', { state: "visible", timeout: 5000 });
  check("编辑抽屉已打开", await page.locator('[data-testid="album-edit-title"]').isVisible());
  const titleJobId = await page.locator('[data-testid="album-edit-title"]').getAttribute("data-job-id");
  check("data-job-id 与后端一致", titleJobId === jid, `${titleJobId} vs ${jid}`);

  // 初始值回填
  const initTitle = await page.locator('input[maxlength="64"]').inputValue();
  check("标题回填正确", initTitle === "待编辑", initTitle);
  const initNote = await page.locator("textarea").inputValue();
  check("备注回填正确", initNote === "原备注", initNote);
  const favChecked = await page.locator('input[type="checkbox"]').first().isChecked();
  check("收藏勾选状态回填为 true", favChecked);

  // ---- 3) 改标题 + 取消收藏 + 加标签 ----
  await page.fill('input[maxlength="64"]', "改过的标题");
  await page.locator('input[type="checkbox"]').first().uncheck();
  // 标签输入框没有 maxLength（用 onChange slice 实现），按顺序取第 3 个 text-like input
  const tagBox = page.locator('input[type="text"], input:not([type])').last();
  await tagBox.fill("新标签");
  await tagBox.press("Enter");
  await page.waitForTimeout(300);
  // chip 的 span 内还嵌了一个删除按钮 ×，所以用 hasText 而非精确文本
  const tagChips = await page.locator("span", { hasText: "原标签" }).count();
  check("原标签仍在", tagChips >= 1);
  const newTagChip = await page.locator("span", { hasText: "新标签" }).count();
  check("新标签已添加为 chip", newTagChip >= 1);

  await page.click("button:has-text('保存')");
  await page.waitForSelector('[data-testid="album-edit-title"]', { state: "detached", timeout: 5000 });
  check("保存后抽屉关闭", !(await page.locator('[data-testid="album-edit-title"]').count()));

  // ---- 4) 后端真的更新了 ----
  const verify = await page.evaluate(async (j) => {
    const { items } = await (await fetch("/api/gallery")).json();
    return items.find((x) => x.job_id === j);
  }, jid);
  check("后端 title 已更新", verify?.title === "改过的标题", verify?.title);
  check("后端 favorite 已取消", verify?.favorite === false);
  check("后端 note 仍保留", verify?.note === "原备注", verify?.note);
  check("后端 tags 含新标签", verify?.tags?.includes("新标签"), JSON.stringify(verify?.tags));
  check("后端 tags 含原标签", verify?.tags?.includes("原标签"));

  // ---- 5) UI 上标题已更新 ----
  await page.waitForTimeout(500);
  const cardTexts = await page.locator("button.relative").allInnerTexts();
  check("卡片显示新标题", cardTexts.some((t) => t.includes("改过的标题")));
  const starAfter = await page.locator(starSel).count();
  check("取消收藏后徽标消失", starAfter === starCount - 1, `${starCount} -> ${starAfter}`);

  // ---- 6) 删除两段式 ----
  await page.locator("button.relative").first().click();
  await page.waitForSelector('[data-testid="album-edit-title"]', { state: "visible", timeout: 5000 });
  await page.click("button:has-text('删除这条')");
  await page.waitForSelector("button:has-text('确认删除')", { timeout: 3000 });
  check("二次确认按钮出现", await page.locator("button:has-text('确认删除')").isVisible());
  await page.click("button:has-text('确认删除')");
  await page.waitForSelector('[data-testid="album-edit-title"]', { state: "detached", timeout: 5000 });
  check("删除后抽屉关闭", !(await page.locator('[data-testid="album-edit-title"]').count()));

  const after = await page.evaluate(async () => (await fetch("/api/gallery")).json());
  check("后端列表不再含该 job", !after.items.find((x) => x.job_id === jid));

  // ---- 7) 无 JS 错误 ----
  check("无未捕获 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));
} finally {
  await page.evaluate(async (j) => {
    await fetch(`/api/gallery/${j}`, { method: "DELETE" }).catch(() => {});
  }, jid);
  await browser.close();
}

console.log(`\nResult: ${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length) console.log("FAILED:", FAIL.join(" | "));
process.exit(FAIL.length ? 1 : 0);
