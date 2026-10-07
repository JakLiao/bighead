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
import { createHarness } from "./verifyHarness.mjs";

const URL = process.env.APP_URL || "http://localhost:5173/gallery";

/**
 * 夹具接管断言与清理。
 *
 * 本脚本两条 job 都由 /api/capture/save 生成, 是后端的随机 hex, 目录名里
 * 没有可识别前缀 —— 早先"只删自己登记过的 id"这种收尾自检对它们完全无感,
 * 漏清理从来不会被发现。harness 的快照 diff 看的是"本轮期间 outputs/ 多了
 * 什么", 与目录名无关。
 */
const h = await createHarness("verify-album-meta");
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
  viewport: { width: 1280, height: 1600 },
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", e));

await page.goto(URL, { waitUntil: "networkidle" });

/**
 * 造一条 job 并登记。
 *
 * 这里必须用 `adopt` 而不是 `adoptMarked`: 本脚本有一条断言是
 * "无元数据条目 title 缺省为空串", 而 adoptMarked 会 PATCH 写入 title=runTag,
 * 于是纳管动作自己毁掉了被测的前置条件, 断言必然失败。
 *
 * 教训值得记下来: **纳管不是隐式无害的**。harness 的登记本身确实只往内存
 * Set 里加个 id, 但"顺手打个标记"这个便利会把元数据写进 _album.json,
 * 对任何断言元数据默认值的脚本就是自伤。判断标准很简单 ——
 * 这个脚本有没有断言 title/tags/note/favorite 的**缺省或初始值**?
 * 有, 就只能 adopt。
 *
 * 登记仍然放在造数函数内部返回, 消除的是"造完 → 断言 → 在 try 里 push"
 * 这种顺序里天然存在的漏窗口(早先 check() 一抛错, finally 拿到的数组是空的)。
 */
async function makeJob(n) {
  const id = await page.evaluate(async (idx) => {
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
  return h.adopt(id);
}

let jidA;
let jidB;
try {
  jidA = await makeJob(1);
  jidB = await makeJob(2);
  check("两条 job 创建成功", !!jidA && !!jidB && jidA !== jidB, `${jidA} / ${jidB}`);

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

  // ---- DELETE 软删除(默认) ----
  // 原注释写的是「真删」。删除已改成**默认进回收站**, 所以这里的断法要跟着变:
  // 目录离开 outputs/ 就算删成功(可恢复性由 verify-gallery-trash.mjs 专门覆盖)。
  const del = await page.evaluate(async (jid) => {
    const r = await fetch(`/api/gallery/${jid}`, { method: "DELETE" });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, jidA);
  check("DELETE 返回 200", del.status === 200, `got ${del.status}`);
  check("DELETE 回显 deleted:true", del.body?.deleted === true);
  check("DELETE 默认非永久(进回收站)", del.body?.permanent === false);

  const after = await page.evaluate(async () => (await fetch("/api/gallery")).json());
  check("GET 不再含已删条目", !after.items.find((x) => x.job_id === jidA));
  check("DELETE 后仍保留其他条目", !!after.items.find((x) => x.job_id === jidB));

  // 删一次再删 → 404(目录已不在 outputs/)
  const del2 = await page.evaluate(async (jid) => {
    const r = await fetch(`/api/gallery/${jid}`, { method: "DELETE" });
    return r.status;
  }, jidA);
  check("重复 DELETE 返回 404", del2 === 404, `got ${del2}`);

  // 清掉刚软删进去的 A, 否则会留在回收站里变成下一次运行的噪声
  await page.evaluate(async (jid) => {
    await fetch(`/api/gallery/trash/${jid}/purge`, { method: "POST" }).catch(() => {});
  }, jidA);
} catch (e) {
  // 不静默: 异常若被吞掉, run-all-verify 只能看到"少了断言", 定位成本很高。
  check("脚本主体未抛异常", false, String(e && e.message ? e.message : e));
} finally {
  /**
   * 清理 + 泄漏自检。
   *
   * 换用 harness 的理由, 每一个都对应旧实现的一个真实缺陷:
   *
   * 1. 旧 finally 只 `DELETE ?permanent=true`。jidA 在 try 里被软删除过,
   *    源目录已搬进 _trash, 而 permanent 对这种 id 走 missing 分支 ——
   *    清不到回收站里那一份, 于是它在回收站里留到下一次运行。
   * 2. 旧收尾自检在 `browser.close()` 之后用 `page.evaluate` 探测: 此时
   *    页面已关, fetch 失败被 catch 吞掉, 两个集合都是 null, `left` 必然
   *    为空 —— 这条断言**恒真通过**, 看起来在防泄漏, 实际什么都防不了。
   * 3. 旧自检只比对"自己登记过的 id", 漏登记的那些天然不在比对范围里,
   *    而它们正是残留的来源。
   *
   * harness 的快照 diff 在 node 侧直接读磁盘, 三条路径(job 目录 /
   * 回收站条目 / _album.json 孤儿键)一次覆盖, 且不受页面状态影响。
   */
  await h.finish(entrySnapshot);
  await browser.close();
  h.report();
}
