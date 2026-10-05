/**
 * 贴纸册元数据 API 端到端验证（后端契约层）。
 *
 * 覆盖：
 *  1. PATCH 写入并合并 _album.json
 *  2. GET /api/gallery 把元数据合并进 items
 *  3. 排序：favorite 置顶
 *  4. 路径穿越被拒（400/422）
 *  5. DELETE 真删（目录 + 元数据一起没）
 *  6. PATCH 局部语义：只传 title 不清空 note
 *
 * 注：本脚本自己造数据，自己清理，不依赖其他脚本的残留。
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
page.on("pageerror", (e) => console.error("[pageerror]", e));

await page.goto(URL, { waitUntil: "networkidle" });

// 在页面里用 canvas 生成 JPEG（省掉手写 base64 的坑）
async function makeJob(n) {
  return page.evaluate(async (idx) => {
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 400;
    const g = c.getContext("2d");
    g.fillStyle = ["#c0392b", "#27ae60", "#2980b9"][idx % 3];
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#fff";
    g.font = "48px sans-serif";
    g.fillText(String(idx), 120, 220);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.9));
    const fd = new FormData();
    fd.append("images", blob, `p${idx}.jpg`);
    const r = await fetch("/api/capture/save", { method: "POST", body: fd });
    if (!r.ok) throw new Error(`capture/save ${r.status}`);
    return (await r.json()).job_id;
  }, n);
}

const jidA = await makeJob(1);
const jidB = await makeJob(2);
check("两条 job 创建成功", !!jidA && !!jidB && jidA !== jidB, `${jidA} / ${jidB}`);

const cleanup = [];
try {
  // ---- PATCH 写入 ----
  const r1 = await page.evaluate(async (jid) => {
    const r = await fetch(`/api/gallery/${jid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "毕业季",
        note: "和阿珍在西门",
        tags: ["闺蜜", "非主流"],
        favorite: true,
      }),
    });
    return { status: r.status, body: await r.json() };
  }, jidA);
  cleanup.push(jidA, jidB);
  check("PATCH 返回 200", r1.status === 200, `got ${r1.status}`);
  check("PATCH 回显 title", r1.body.title === "毕业季", r1.body.title);
  check("PATCH 回显 note", r1.body.note === "和阿珍在西门", r1.body.note);
  check("PATCH 回显 tags", Array.isArray(r1.body.tags) && r1.body.tags.length === 2);
  check("PATCH 回显 favorite", r1.body.favorite === true);
  check("PATCH 回显 updated_at", typeof r1.body.updated_at === "number" && r1.body.updated_at > 0);

  // ---- PATCH 局部语义：只传 title，note 不应被清空 ----
  const r2 = await page.evaluate(async (jid) => {
    const r = await fetch(`/api/gallery/${jid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "毕业季改" }),
    });
    return await r.json();
  }, jidA);
  check("局部 PATCH 不清空 note", r2.note === "和阿珍在西门", `note=${r2.note}`);
  check("局部 PATCH 不清空 tags", Array.isArray(r2.tags) && r2.tags.length === 2);
  check("局部 PATCH 覆盖 title", r2.title === "毕业季改", r2.title);
  check("局部 PATCH 保留 favorite", r2.favorite === true);

  // ---- GET 合并 ----
  const list = await page.evaluate(async () => (await fetch("/api/gallery")).json());
  check("GET 返回 items 数组", Array.isArray(list.items));
  const itemA = list.items.find((x) => x.job_id === jidA);
  check("GET 合并 title", itemA?.title === "毕业季改", itemA?.title);
  check("GET 合并 note", itemA?.note === "和阿珍在西门");
  check("GET 合并 favorite", itemA?.favorite === true);
  check("GET 保留 thumbs", Array.isArray(itemA?.thumbs));
  check("GET 保留 job_id/mtime", typeof itemA?.job_id === "string" && typeof itemA?.mtime === "number");

  // 无元数据的条目也要有完整默认字段（不能让前端拿到 undefined）
  const itemB = list.items.find((x) => x.job_id === jidB);
  check("无元数据条目 title 缺省为空串", itemB?.title === "", JSON.stringify(itemB?.title));
  check("无元数据条目 favorite 缺省 false", itemB?.favorite === false);
  check("无元数据条目 tags 缺省 []", Array.isArray(itemB?.tags) && itemB.tags.length === 0);

  // ---- 排序：favorite 置顶 ----
  const iA = list.items.findIndex((x) => x.job_id === jidA);
  const iB = list.items.findIndex((x) => x.job_id === jidB);
  check("favorite 条目排在非 favorite 之前", iA >= 0 && iB >= 0 && iA < iB, `iA=${iA} iB=${iB}`);

  // ---- 路径穿越 ----
  const trav = await page.evaluate(async () => {
    const out = {};
    for (const bad of ["..%2F..%2Fetc%2Fpasswd", "..", "a%2Fb"]) {
      const r = await fetch(`/api/gallery/${bad}`, { method: "DELETE" });
      out[bad] = r.status;
    }
    return out;
  });
  for (const [k, v] of Object.entries(trav)) {
    check(`路径穿越 ${k} 被拒`, v === 400 || v === 404 || v === 422, `got ${v}`);
  }

  // ---- PATCH 不存在的 job → 404 ----
  const nf = await page.evaluate(async () => {
    const r = await fetch("/api/gallery/job_ZZZZnotexist9999", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    return r.status;
  });
  check("PATCH 不存在的 job 返回 404", nf === 404, `got ${nf}`);

  // ---- DELETE 真删 ----
  const del = await page.evaluate(async (jid) => {
    const r = await fetch(`/api/gallery/${jid}`, { method: "DELETE" });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, jidA);
  check("DELETE 返回 200", del.status === 200, `got ${del.status}`);
  check("DELETE 回显 deleted:true", del.body?.deleted === true);

  const after = await page.evaluate(async () => (await fetch("/api/gallery")).json());
  check("GET 不再含已删条目", !after.items.find((x) => x.job_id === jidA));
  check("DELETE 后仍保留其他条目", !!after.items.find((x) => x.job_id === jidB));

  // 删一次再删 → 404
  const del2 = await page.evaluate(async (jid) => {
    const r = await fetch(`/api/gallery/${jid}`, { method: "DELETE" });
    return r.status;
  }, jidA);
  check("重复 DELETE 返回 404", del2 === 404, `got ${del2}`);
} finally {
  // 清理自己造的 B
  await page.evaluate(async (jid) => {
    await fetch(`/api/gallery/${jid}`, { method: "DELETE" }).catch(() => {});
  }, jidB);
  await browser.close();
}

console.log(`\nResult: ${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length) console.log("FAILED:", FAIL.join(" | "));
process.exit(FAIL.length ? 1 : 0);
