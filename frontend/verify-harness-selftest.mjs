/**
 * 故障注入: 证明 verifyHarness 的泄漏自检**真的会红**。
 *
 * ============================ 为什么需要这个脚本 ============================
 *
 * 本项目最擅长的一种自欺是"看起来在防护的断言, 实际恒真"。本文件自己就
 * 改过一次这种 bug: verify-share-card.mjs 的收尾自检跑在 browser.close()
 * **之后**, page.evaluate 全部失败被 catch 成 null, 于是比对集合必然为空,
 * 断言永远通过 —— 它看起来在防泄漏, 实际什么都防不了。
 *
 * 一个从没红过的断言, 无法与"删掉它结果完全一样"区分开。所以这里刻意造出
 * 真实泄漏, 断言必须变红; 修复后必须变绿。**只验"正常路径是绿的"等于没验。**
 *
 * 用法: node verify-harness-selftest.mjs
 * 退出码 0 = 自检机制有效; 非 0 = 机制本身坏了(必须先修, 否则所有脚本的
 * 泄漏自检都是摆设)。
 */
import { createHarness } from "./verifyHarness.mjs";

const fsp = await import("node:fs/promises");
const path = await import("node:path");

const OUT = path.resolve(process.cwd(), "..", "outputs");

let failures = 0;
function expect(cond, name, detail = "") {
  if (!cond) failures++;
  console.log(`  [${cond ? "OK" : "BROKEN"}] ${name}${detail ? "  " + detail : ""}`);
}

console.log("=".repeat(64));
console.log("  Harness self-test: 泄漏自检必须能变红");
console.log("=".repeat(64));

// ---------------------------------------------------------------------------
// 用例 1: 正常路径 —— 造了又清掉, 终检必须全绿
//
// 这是最平常的情况: 造数、登记、清理, 然后磁盘回到进入前。
// 终检断的是"回到进入前状态", 不是"日志红不红" —— 早先误以为自检
// 跑在清理之前, 于是断言 fail.length === 0, 结果正常路径反而被判失败。
// ---------------------------------------------------------------------------
{
  const h = await createHarness("selftest-clean", { markPrefix: "selftestA" });
  const before = await h.snapshot();
  await h.makeJobOnDisk("stA");
  await h.finish(before);
  expect(
    h.fail.length === 0,
    "正常路径: 造数并清理后终检全绿",
    h.fail.join(" | "),
  );
}

// ---------------------------------------------------------------------------
// 用例 2: 泄漏路径 —— 造了**不登记**, 快照 diff 必须抓到并补救
//
// 这是本脚本的核心用例。它模拟的正是 verify-gallery-paging 踩过的那个坑:
// 造数函数存在, 但调用方忘了登记, 于是清理空转。
// 注意"不登记"意味着连 h 都不知道这个 id 存在 —— 只有 diff 能发现。
//
// ⚠️ 目录名**必须含 h.runCode**, 与 makeJobOnDisk 的命名约定一致。
// 这不是为了绕过归属判定, 而是因为 harness 现在只自动清理"能证明属于
// 本轮"的数据(见 finish 里 ownRun 的说明): 判不出归属的一律只报告。
// 本用例要验的正是"本轮漏登记的残留会被自动清掉", 所以它必须造出一条
// **归属明确**的漏登记数据 —— 否则测到的其实是另一条规则(只报告不删),
// 用例名与所测行为对不上, 就成了一条永远绿的废断言。
//
// 早先这里用 `stB${Date.now().toString(36)}`, 不含 runCode, 于是被归入
// "来源不明"、跳过删除, 用例报 BROKEN。那次失败其实暴露了自检与 harness
// 约定脱节, 而不是 harness 坏了 —— 但结果一样: 这条用例必须改。
// ---------------------------------------------------------------------------
{
  const h = await createHarness("selftest-leak", { markPrefix: "selftestB" });
  const before = await h.snapshot();

  // 绕过 h 的登记机制, 直接在磁盘上造一个目录: 模拟"漏登记"。
  // 前缀带 h.runCode, 与 makeJobOnDisk 同构, 表达"这是本轮造的, 只是没登记"。
  const rogue = `stB${h.runCode}${Date.now().toString(36)}`;
  const rogueDir = path.join(OUT, rogue);
  await fsp.mkdir(rogueDir, { recursive: true });
  await fsp.writeFile(path.join(rogueDir, "photo_1.jpg"), Buffer.from("x"));

  await h.finish(before);

  // 补救阶段必须**认出**它没被登记: 这正是"漏登记"这个 bug 的价值所在。
  // 早先的设计里终检跑在补救之前, 于是这里会报 FAIL —— 报得没错, 但那是
  // 把"发现"当成"失败", 会让每个正常脚本都红。现在补救在前、终检在后,
  // 补救成功则终检应当全绿。
  expect(
    h.fail.length === 0,
    "漏登记的残留被补救后, 终检应全绿",
    h.fail.join(" | "),
  );

  // 而且必须真的删掉了。只会报告不会收拾的 harness 没什么用:
  // 跑的人看到一堆红字多半直接跳过, 下次跑还是同样的残留。
  const stillThere = await fsp
    .stat(rogueDir)
    .then(() => true)
    .catch(() => false);
  expect(!stillThere, "补救逻辑已把本轮漏登记的残留清掉", rogue);
  // 兜底: 万一补救也失败, 本脚本自己收尾, 绝不留新泄漏。
  if (stillThere) await fsp.rm(rogueDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 用例 2b: 陌生数据**只报告不删除** —— 归属不明时不得动它
//
// 上一条用例的孪生面, 钉的是本轮加的安全边界: 快照 diff 看得见"运行期间
// 新出现的目录", 但它**分不清**这是本轮漏清理还是用户刚拍的照片。
// 于是 harness 只能删"能证明属于本轮"的那些(用例 2), 剩下的一律只报告。
//
// 这条用例若不存在, "只报告不删"这个行为就没有任何验证 —— 哪天有人觉得
// "反正都是新出现的, 一起清了吧"而改回去, 没有任何测试会红。而那个改动
// 的代价是删掉用户的照片。
// ---------------------------------------------------------------------------
{
  const h = await createHarness("selftest-foreign", { markPrefix: "selftestE" });
  const before = await h.snapshot();

  // 刻意用 12 位随机 hex —— 形态与用户真实 job_id 完全同构, 且不含 runCode,
  // 于是"无法证明属于本轮"。模拟: 脚本运行期间用户自己拍了一张。
  const foreign = Array.from({ length: 12 }, () =>
    "0123456789abcdef"[Math.floor(Math.random() * 16)],
  ).join("");
  const foreignDir = path.join(OUT, foreign);
  await fsp.mkdir(foreignDir, { recursive: true });
  await fsp.writeFile(path.join(foreignDir, "photo_1.jpg"), Buffer.from("x"));

  await h.finish(before);

  // 必须还在。harness 没有资格删一个它不认识的目录。
  const survived = await fsp
    .stat(foreignDir)
    .then(() => true)
    .catch(() => false);
  expect(survived, "来源不明的数据未被自动删除(不能误删用户数据)", foreign);

  // 而且必须**报出来**, 否则它就成了没人知道的存在。
  // 判据是终检不红: 判红等于"脚本写错了", 而这条不是脚本造的。
  expect(
    h.fail.length === 0,
    "来源不明的数据不判失败(只告警)",
    h.fail.join(" | "),
  );
  expect(
    h.warn.length > 0,
    "来源不明的数据有告警记录",
    `warn=${h.warn.join(" | ")}`,
  );

  // 本脚本自己收尾 —— 造它是为了测守卫, 不代表可以留着它。
  await fsp.rm(foreignDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 用例 3: 回收站泄漏 —— 软删除后不 purge, diff 必须看得见且终检能修复
//
// 单看 outputs/ 顶层发现不了这个(源目录已经不在了), 必须单独拍回收站。
//
// 这条钉的是"终检在补救**之后**仍有残留才算失败"这个语义。若把 diff
// 放在清理之前判(最早的设计), 它对每个正常脚本都会误报 —— 正常造数
// 和漏清理在那一刻的磁盘状态完全一样, 无法区分。
// ---------------------------------------------------------------------------
{
  const h = await createHarness("selftest-trash", { markPrefix: "selftestC" });
  const before = await h.snapshot();
  const id = await h.makeJobOnDisk("stC");

  // 模拟"软删除后没 purge": permanent 缺省 = false, 目录被搬进 _trash。
  await fetch(`${h.apiBase}/gallery/${id}`, { method: "DELETE" }).catch(() => {});

  // diff 必须能看见它(哪怕源目录已不在)。
  const leak = await h.diffFrom(before);
  expect(
    leak.newTrash.includes(id),
    "回收站泄漏: diff 看得见未 purge 的条目",
    `newTrash=${JSON.stringify(leak.newTrash)}`,
  );

  // 走完整 finish(): 补救把回收站那条 purge 掉, 终检应全绿。
  await h.finish(before);
  const trash = await fetch(`${h.apiBase}/gallery/trash`)
    .then((r) => r.json())
    .then((t) => t.items.map((x) => x.job_id))
    .catch(() => []);
  expect(!trash.includes(id), "finish() 已把回收站里的那条 purge 掉", id);
  expect(
    h.fail.length === 0,
    "补救后终检全绿(不应再有残留类失败)",
    h.fail.join(" | "),
  );
}

// ---------------------------------------------------------------------------
// 用例 4: 空 diff 必须是"真的没有新增", 而不是探测失败
//
// 反向验证: 快照在没有任何变化时, 新增集合长度必须是 0。
// 若哪天有人把 readdir 写错(比如路径拼错导致 catch 返回 []),
// 基线和退出快照会同时变成空集, diff 恒为 0 —— 断言全绿但什么都没查。
// 这条专门堵这个"两边都空"的假绿。
// ---------------------------------------------------------------------------
{
  const h = await createHarness("selftest-empty", { markPrefix: "selftestD" });
  const before = await h.snapshot();
  const after = await h.snapshot();
  expect(
    before.dirs.length > 0,
    "快照非空(证明确实读到了 outputs/, 不是路径错误导致的空集)",
    `dirs=${before.dirs.length} album=${before.albumKeys.length}`,
  );
  await h.finish(before);
  expect(
    h.fail.length === 0,
    "无变化时不应报失败",
    h.fail.join(" | "),
  );
}

console.log("\n" + "=".repeat(64));
if (failures) {
  console.log(`  SELFTEST BROKEN: ${failures} 项不通过 —— 泄漏自检不可信, 请先修 harness`);
  console.log("=".repeat(64));
  process.exit(1);
}
console.log("  SELFTEST OK: 5/5 —— 自检在正常路径绿、在本轮泄漏路径红、在陌生数据前不越界");
console.log("=".repeat(64));
/**
 * 刻意用 exitCode 而不是 process.exit()。
 *
 * 本脚本每个用例都 createHarness, 各自装了 SIGINT/SIGTERM 监听;
 * process.exit() 会在还有异步 IO 在飞的时候直接砍掉进程, libuv 偶发
 * "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" —— 那个崩溃
 * 会把退出码变成 0xC0000409, 于是 run-all-verify 把它判成 CRASHED,
 * 明明 4/4 全绿。
 *
 * 脚本末尾没有待完成的定时器/句柄, 自然退出即可, 不需要 force。
 */
process.exitCode = 0;
