/**
 * verify-*.mjs 共享测试夹具 —— 根治 outputs/ 数据泄漏。
 *
 * ============================ 为什么要这个模块 ============================
 *
 * 此前每个脚本各自实现造数与清理, 于是"测试数据留在真实 outputs/ 里"
 * 这件事反复发生, 且**每次都是 0 失败**。三个独立的根因:
 *
 * 1. **登记责任外置**: 造数函数造完, 要靠调用方记得 `created.push(id)`。
 *    verify-gallery-paging.mjs 有 8 处调用点, 漏登记 6 处, 清理静默空转 ——
 *    收尾断言只逐个比对 `created`, 于是"漏掉的那 6 个"恰好不在比对范围里,
 *    断言通过、数据留下。**能发现问题的断法, 恰好被这个 bug 一起废掉了。**
 *
 * 2. **异常路径不完整**: 清理写在脚本末尾的裸语句里, 不在 finally 中。
 *    verify-decorate-persist.mjs 前半段有 12 个 `page.evaluate`, 任一抛错
 *    (超时是最常见的) 就直接跳到 catch, 清理那几行根本不执行。
 *
 * 3. **hex id 无法识别归属**: 走 `/api/capture/save` 的脚本拿到的 job_id
 *    是后端生成的随机 12 位 hex, 目录名里没有任何本次运行的痕迹。
 *    前缀扫描(`mq*` / `bt*` / `ui*`)对它们**完全无感** —— 这类残留
 *    在收尾自检里查不出来, 只能靠人工翻 outputs/ 才发现。
 *
 * ============================ 这个模块怎么根治 ============================
 *
 * 不是"记得清理", 而是**让泄漏变得可观测**。三个机制:
 *
 * - **adopt 强制登记**: 只有经 `makeJob*()` / `adopt()` 造出来的数据才会
 *   被登记, 登记发生在造数函数**内部**。调用方无从漏 —— 这消除了根因 1,
 *   因为它不再依赖调用方的记性。
 *
 * - **快照 diff 取代"我认为清干净了"**: `snapshot()` 在脚本开始时拍一张
 *   outputs/ 目录 + 回收站 + _album.json 键的快照, `assertNoLeak()` 在退出时
 *   拍第二张并求差集。**任何**新增的 job 目录/回收站条目/孤儿键都会被抓到,
 *   哪怕它来自一条完全没被登记的路径。这消除了根因 3 —— 识别不再依赖
 *   目录名, 而是依赖"进入时没有、退出时有了"这个事实。
 *
 * - **SIGINT/SIGTERM 兜底**: Ctrl+C 是最常见的死法(跑到一半觉得卡住)。
 *   装上 process 监听后, 中断会先同步清掉已登记的数据再退出。
 *   注意这**不能替代** diff 断言, 只是在人工介入前先尽量收拾干净。
 *
 * - **watchCapturedJobs: 把登记时点前移到 job 诞生的那一刻**。
 *   前两个机制都要求"脚本已经知道 job_id", 而有一类脚本做不到: job 是
 *   **被测代码自己**造的。点一下「生成拼图」, DecoratePage.doLayout 内部
 *   就调 saveCaptures() 建了目录, 脚本只能事后从 layoutUrl 反解 id ——
 *   而"事后"之前隔着三次网络往返和十几条断言, 任何一处超时(这三个脚本
 *   各有 3 处 120s 等待)都会让登记永远不发生。这类脚本每次跑都往
 *   outputs/ 里丢 2~3 个 hex 目录, 且脚本**全绿**。
 *
 *   监听 `response` 让登记发生在 job 刚建好、页面还没做任何别的事时,
 *   之后无论抛什么错都兜得住。异步登记的时序由 finish() 里的 drain 保证:
 *   Playwright 不会 await 事件处理器, 不显式等它落地就会"清理跑完了,
 *   登记还没发生"。
 *
 * 刻意保留的能力边界: 本模块**不**改动被测的前后端代码, 也不引入新依赖。
 * 它只是把散落在 12 个脚本里的重复逻辑收成一处, 并加上此前不存在的自检。
 *
 * ============================ 用法 ============================
 *
 *   import { createHarness } from "./verifyHarness.mjs";
 *
 *   const h = await createHarness("verify-gallery-marquee");
 *   h.check("断言名", cond, detail);
 *   const ids = [await h.makeJobOnDisk(), await h.makeJobOnDisk()];
 *   try {
 *     ...测试主体...
 *   } finally {
 *     await h.finish();     // 清理 + 快照 diff 自检
 *   }
 *   h.report();             // 打印汇总并设置 exit code
 *
 * job 由**页面代码**创建时(点按钮触发), 多挂一行:
 *
 *   h.watchCapturedJobs(page);
 */

/** 1x1 像素 JPEG。各脚本此前各抄一份 base64, 改字节时容易只改一处。 */
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);

/**
 * 回收站目录名前缀: `<毫秒时间戳>_<job_id>`。与 gallery.py 的 _trash_name 一致。
 *
 * 快照只需要 job_id 部分来判重(时间戳每次都变, 直接比目录名没有意义),
 * 所以这里按 `_` 切一次还原出 job_id。
 */
const TRASH_DIRNAME = "_trash";

/** outputs/ 顶层的内部目录/文件, 由 gallery.py 按前缀跳过, 快照同样跳过。 */
function isInternalDir(name) {
  return name.startsWith("_") || name.startsWith(".");
}

export async function createHarness(scriptName, options = {}) {
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  // rmSync 单独取: 中断路径上必须同步删, 而 fs/promises 全是异步的。
  // 动态 import 是为了不在模块顶层引入同步 IO —— 只有真发生中断时才用得上。
  const { rmSync } = await import("node:fs");

  /**
   * outputs/ 绝对路径。
   *
   * 从本文件位置推导 (`frontend/verifyHarness.mjs` -> `../outputs`) 而不是
   * 硬编码 `f:/Trae-work/bighead/outputs`: 此前 4 个脚本各写了一份字面量,
   * 换机器或把仓库挪到别的盘时, 漏改的那一个会安静地往别处造数据 ——
   * 而它仍然会 0 失败, 因为清理用的是同一个错误的路径。
   */
  const here = path.dirname(fileURLToPath(import.meta.url));
  const outDir = options.outputsDir
    ? path.resolve(options.outputsDir)
    : path.resolve(here, "..", "outputs");

  /** 后端 API 基址, **含 /api 前缀**。与 vite 代理目标同源, 便于整体覆盖。 */
  const apiBase = (options.apiBase || process.env.API_URL || "http://127.0.0.1:8077/api")
    .replace(/\/+$/, "");

  const pass = [];
  const fail = [];
  /**
   * 需要人工看一眼的告警。与 fail 分开是刻意的:
   *
   * 断言红 = "本脚本的代码有问题, 改代码"; 告警黄 = "outputs/ 里有来源不明的
   * 数据, 人来判断"。混在一起会让跑脚本的人养成忽略红字的习惯, 而那正是
   * 本项目最擅长的一种自欺。
   */
  const warn = [];

  /**
   * 未知残留的处理策略。由 BIGHEAD_VERIFY_LEAK_MODE 决定。
   *
   * 三档的取舍围绕同一个问题: **harness 有没有资格删一个它不认识的目录?**
   *
   * - `report`(默认): 只报告, 不删, 也不判失败。
   *   最保守。适用于 outputs/ 里有用户真实相册的常态环境 —— 此时
   *   "运行期间用户新拍了一张照片"与"脚本漏清理"在磁盘上完全同构,
   *   任何自动处置都可能删掉不该删的。误删不可恢复, 漏删只是难看。
   *
   * - `strict`: 报告**并且**判失败, 仍然不删。
   *   给 CI / 独占沙箱用: 那里的 outputs/ 里除了测试数据不该有别的,
   *   于是"有未知残留"本身就是环境异常, 应当让流水线红。
   *
   * - `purge`: 报告并强制删除。
   *   只适用于一次性沙箱(比如 CI 里现建现删的 outputs/)。
   *   ⚠️ 在有用户数据的机器上打开这个开关 = 授权 harness 删别人的照片。
   *
   * 缺省选 report 而不是 purge: 前者最坏结果是留几个目录被人看见,
   * 后者最坏结果是用户数据没了且不可恢复。
   */
  const LEAK_MODE = (() => {
    const m = (process.env.BIGHEAD_VERIFY_LEAK_MODE || "report").toLowerCase();
    if (m === "strict" || m === "purge") return m;
    return "report";
  })();

  /**
   * 本次运行造出并登记的 job id。
   *
   * 用 Set 而不是数组: 同一个 id 重复登记是可能的(比如造完又 adopt 一次),
   * 而重复 id 会让 batch-delete 的 deleted 计数与实际不符, 把清理结果
   * 变成一个看起来像断言失败的数字。
   */
  const adopted = new Set();

  let cleaned = false;

  function check(name, cond, detail = "") {
    (cond ? pass : fail).push(name);
    console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? "  " + detail : ""}`);
    return !!cond;
  }

  /** 造数登记。**唯一**的登记入口, 外部不应直接碰 adopted。 */
  function track(jobId) {
    if (jobId) adopted.add(jobId);
    return jobId;
  }

  /**
   * 纳管一个已存在的 job。
   *
   * 存在的意义: 有些 job 是**被测代码自己**造的, 脚本只能事后从返回值里
   * 拿到 id(比如 `/api/capture/save` 的响应), 无法让造数函数代为登记。
   * 这类路径必须显式 adopt, 否则它们就成了快照 diff 唯一能抓到的那类泄漏 ——
   * 能抓到是好事, 但正确做法是不产生它们。
   */
  function adopt(jobId) {
    return track(jobId);
  }

  /**
   * 磁盘直写造 job。
   *
   * 为什么绕过 `/api/capture/save`: 那条路会校验图片内容并写 _album 相关状态,
   * 造数更慢也更绕。这里要的只是"outputs/ 里多一个目录时画廊怎么表现",
   * 真实拍摄链路由其它脚本覆盖。
   *
   * @param {string} tag 目录名前缀, 便于人在 outputs/ 里一眼认出是测试数据。
   *                      此前各脚本传 "bt"/"pt"/"ui" 这类两字母前缀, 极易撞车 ——
   *                      撞车时收尾断言会把邻居的数据算成自己的残留。
   *                      这里默认带上本次运行的短码, 撞车概率可忽略。
   */
  async function makeJobOnDisk(tag = "vt") {
    for (let i = 0; i < 40; i++) {
      const id = `${tag}${runCode}${Date.now().toString(36)}${i}`;
      const full = path.join(outDir, id);
      try {
        // recursive:false 是刻意的: 撞到已存在的目录时必须抛出来重试,
        // 用 true 会直接复用别人的目录并往里写文件。
        await fsp.mkdir(full, { recursive: false });
      } catch {
        continue;
      }
      /*
        登记必须在 mkdir 成功之后**立刻**发生, 早于任何可能抛错的操作。

        这正是本次修复的核心根因: 早先这里是 `writeFile` 成功之后才 track,
        于是"目录建好了但文件写失败"(磁盘满、权限、杀毒软件锁文件)这条
        路径上, 目录已经落盘却没人负责删 —— 而收尾断言只逐个比对已登记的
        id, 这个漏登记的目录恰好不在比对范围里, 于是脚本仍然 0 失败。

        顺序反过来就堵死了: mkdir 一旦成功, 责任就已经转移给 harness,
        后面无论哪一步抛错, finally 里的 cleanupRegistered 都会覆盖它。
      */
      track(id);
      // 必须是真 JPEG: _pick_media 只查文件名不校验内容, 但前端 <img>
      // 解码失败会触发 onerror, 让后续与缩略图相关的断言失真。
      await fsp.writeFile(path.join(full, "photo_1.jpg"), TINY_JPEG);
      return id;
    }
    throw new Error(`makeJobOnDisk 未能创建唯一目录 (outputs=${outDir})`);
  }

  /**
   * 给已存在的 job 打上本次运行的元数据标记(title)。
   *
   * 解决的是"hex id 不可识别"这件事: 打了标记之后, 即使清理失败,
   * 下一次跑也能用 `?q=<标记>` 把它搜出来删掉, 而不必人工翻目录。
   *
   * 标记长度受 ALBUM_MAX_TITLE=64 约束, 这里刻意留足余量。
   *
   * ⚠️ 打标记会**真的 PATCH 写进 _album.json**, 所以它不是无副作用的。
   * 断言了 title/tags/note/favorite 缺省值或精确计数的脚本不能用它 ——
   * 纳管动作会毁掉被测的前置条件, 表现为"断言失败但被测代码完全正常"。
   * 判据与 adoptMarked 的说明一致。
   */
  async function markJob(jobId, { title = runTag, tags } = {}) {
    await fetch(`${apiBase}/gallery/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tags ? { title, tags } : { title }),
    }).catch(() => {});
    return jobId;
  }

  /**
   * 打标记 + 登记。capture/save 这类"被测代码造数"的省事入口。
   *
   * ⚠️ **先确认你的脚本能不能用这个**, 否则用 `adopt`。
   *
   * 它会往 job 写 title=runTag, 于是:
   *   - 断言"无元数据条目 title 缺省为空串" -> 必然失败
   *   - 断言搜索"恰好命中 N 条" -> runTag 进了搜索索引, N 可能变大
   *   - 断言 tags/note/favorite 初始值 -> 同理
   *
   * 真实踩过的坑: verify-album-meta 就因为用了 adoptMarked 而报
   * "无元数据条目 title 缺省为空串" 失败, 而后端行为完全正确。
   * 一句话判据 —— **脚本里有没有断言 title/tags 的值或数量? 有就只能 adopt。**
   * adopt 少的那点追溯能力, 由 finish() 的快照终检兜着, 不会因此泄漏。
   */
  async function adoptMarked(jobId, opts) {
    await markJob(jobId, opts);
    return track(jobId);
  }

  /**
   * 挂上"造数即登记"的监听, 返回一个句柄。
   *
   * ============================ 为什么需要它 ============================
   *
   * adopt/adoptMarked 要求调用方**已经知道** job_id。但有一类脚本压根拿不到:
   * job 是**被测代码自己**造的 —— verify-doodle-burn / verify-sticker-edit /
   * verify-era-e2e 都是点「生成拼图」, 由 DecoratePage.doLayout 内部调
   * saveCaptures() -> POST /api/capture/save 建目录。脚本只能事后从
   * `layoutUrl`(/outputs/{job_id}/layout.jpg) 里反解出 id。
   *
   * 那个"事后"就是泄漏窗口: 从 job 落盘到脚本读到 layoutUrl 之间隔着
   * makeLayoutToJob、renderShareCard、saveShareCard 三次网络往返, 以及
   * 脚本自己的十几次断言。**任何一个环节抛错**(这三个脚本各有 3 处
   * 120s waitForFunction, 超时是常态), 登记就永远不会发生, 而磁盘上
   * 已经躺着一个 hex id 的 job —— 收尾自检只能把它当"来源不明"报出来,
   * 删不掉。这正是 harness 开头列的根因 3。
   *
   * 所以改成在**响应到达的那一刻**登记: 那时 job 刚建好、脚本还什么都没
   * 做, 后面无论抛什么错, finally 里的 cleanupRegistered 都覆盖得到。
   *
   * ============================ 为什么必须 drain ============================
   *
   * `response` 事件处理器是 async 的(要 await res.json()), 而 Playwright
   * **不会** await 它。于是存在一种交错: 脚本主体跑完 -> finish() 开始
   * 清理 -> 这时某个 handler 才刚拿到 body 并 register(...) —— 清理早就
   * 过去了, 于是这个 job 逃过本轮清理, 变成下次运行的"历史垃圾"。
   *
   * 修法是把所有在飞的 Promise 记在 pending 里, finish() 在
   * cleanupRegistered **之前**逐个 await 完。顺序不能反: 先清理再 drain
   * 等于没 drain。
   *
   * @param {import("playwright").Page} page
   * @param {object} [opts]
   * @param {string} [opts.endpoint] 只拦这个路径上的 POST。
   * @param {boolean} [opts.mark] 是否给 job 打 title 标记(见下)。
   *
   * mark 的判据与 adoptMarked 一致: **脚本里有没有断言 title/tags 的值或
   * 数量**。有就不能开 —— 打标记会真的 PATCH 写进 _album.json, 会毁掉
   * 被测前置条件。这三个脚本只做像素级断言(涂鸦/贴纸/era 烧没烧进成片),
   * 不断言元数据, 所以默认开。留下的 runTag 让"清理也失败了"这种极端
   * 情况仍可用 `?q=<runTag>` 找回, 而不必人工翻 outputs/ 猜哪个 hex 是
   * 测试留下的。
   */
  function watchCapturedJobs(page, { endpoint = "/api/capture/save", mark = true } = {}) {
    const inFlight = new Set();
    const onResponse = (res) => {
      if (res.request().method() !== "POST") return;
      if (!res.url().includes(endpoint)) return;
      const p = res
        .json()
        .then((body) => {
          const id = body?.job_id;
          if (!id) return undefined;
          return mark ? adoptMarked(id) : track(id);
        })
        .catch(() => {
          /*
           * 读不到 body 就放弃登记, **不**报错。
           *
           * 这一刻 job 可能已经建好(响应是 200 但 body 读不出来, 例如
           * 已被浏览器回收), 而我们无法证明它属于本轮还是属于用户 ——
           * 凭空造一个 id 去删才是危险动作。这种情况交给 finish() 的
           * 快照终检报出来: 它会把这条例为"来源不明的残留"并跳过删除,
           * 正是设计想要的保守行为。
           */
        });
      inFlight.add(p);
      p.then(
        () => inFlight.delete(p),
        () => inFlight.delete(p),
      );
    };
    page.on("response", onResponse);
    const handle = {
      /** 等待所有在飞的登记完成。finish() 会自动调, 一般不需要手动调。 */
      async drain() {
        while (inFlight.size) await Promise.all([...inFlight]);
      },
      dispose() {
        page.off("response", onResponse);
      },
    };
    watchers.push(handle);
    return handle;
  }

  /**
   * 已注册的 watchCapturedJobs 句柄。finish() 靠它做清理前的 drain。
   *
   * 放在闭包里而不是让脚本自己保管: 漏掉 drain 的后果是"清理看起来跑了
   * 却漏掉最后一个 job", 而这正是本模块要根治的那类静默失败, 不该再
   * 依赖调用方的记性 —— 与 track() 的设计理由同源。
   */
  const watchers = [];

  /** 在真正动手清理之前, 先把所有在途的登记落定。 */
  async function drainWatchers() {
    for (const w of watchers) {
      await w.drain().catch(() => {});
    }
  }

  /**
   * 拍快照: outputs/ 顶层 job 目录、回收站 job_id、_album.json 的键。
   *
   * 三者都要拍, 因为它们是**三条独立的泄漏路径**:
   *   - job 目录没删 -> 画廊上多出碎图卡片
   *   - 回收站没清 -> 下次跑时"清空前回收站恰有 N 条"这类计数断言失败,
   *     而失败原因看起来与被测功能毫无关系
   *   - _album.json 孤儿键 -> 目录删了但元数据还在, 列表页会突然多出
   *     指向不存在缩略图的条目(后端会丢弃它们, 但文件会一直涨)
   */
  async function snapshot() {
    const dirs = await fsp
      .readdir(outDir, { withFileTypes: true })
      .then((es) => es.filter((e) => e.isDirectory() && !isInternalDir(e.name)).map((e) => e.name))
      .catch(() => []);
    const trash = await fsp
      .readdir(path.join(outDir, TRASH_DIRNAME), { withFileTypes: true })
      .then((es) =>
        es
          .filter((e) => e.isDirectory())
          // 目录名是 `<毫秒>_<job_id>`, 切出 job_id 才能与运行前后的集合比对。
          .map((e) => e.name.split("_").slice(1).join("_"))
          .filter(Boolean),
      )
      .catch(() => []);
    const albumKeys = await fsp
      .readFile(path.join(outDir, "_album.json"), "utf-8")
      .then((t) => Object.keys(JSON.parse(t)))
      .catch(() => []);
    return { dirs, trash, albumKeys };
  }

  /**
   * 清理已登记的 job。
   *
   * 三步, 少一步都会留下垃圾:
   *
   * 1. `batch-delete` 带 `permanent: true` —— 删除默认是软删除(进回收站),
   *    用默认值等于把它们搬到回收站里, 下次跑就是残留。
   * 2. 逐个 `purge` —— permanent 对"源目录已不在"的 id 走 missing 分支,
   *    清不到回收站里那一份。脚本中段的删除步骤常已搬走过目录, 所以必须 purge。
   * 3. 后端不可用时退回 fs.rm —— 留孤儿键好过留测试目录, 但两者都不该发生;
   *    走到这一步说明环境有问题, 应当由 assertNoLeak 报出来。
   *
   * 刻意**不用** fs.rm 作为主路径: 直接删目录会留下永久孤儿键, 而孤儿键
   * 在列表页表现为"多出一条碎图", 排查起来比残留目录更难。
   */
  async function cleanupRegistered() {
    const ids = [...adopted];
    if (!ids.length) return { ok: true, ids };
    try {
      await fetch(`${apiBase}/gallery/batch-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_ids: ids, permanent: true }),
      });
      for (const id of ids) {
        // 源目录已不在时返回 404; 还在回收站里才会成功。
        await fetch(`${apiBase}/gallery/trash/${id}/purge`, { method: "POST" }).catch(() => {});
      }
    } catch {
      for (const id of ids) {
        await fsp.rm(path.join(outDir, id), { recursive: true, force: true }).catch(() => {});
      }
      return { ok: false, ids, reason: "后端不可用, 已退回直接删目录" };
    }
    // 刻意**不**清空 adopted: finish() 的补救阶段还要用它做减法 ——
    // "本轮新增但不在已登记集合里"正是漏网的判据, 清空了就没法区分了。
    // 重复 finish() 由 cleaned 标志挡住, 不存在重复清理的问题。
    return { ok: true, ids };
  }

  /**
   * 拍两张快照求差集, 报出"相对基线新增了什么"。**只诊断, 不判定成败。**
   *
   * ============================ 它不是断言 ============================
   *
   * 早先 finish() 把它当断言用, 实跑立刻出问题: verify-gallery-paging
   * 正常就要造 8 个 job 放进 outputs/, 于是每次都报 3 条 FAIL, 而磁盘
   * 其实是**按设计**脏的。
   *
   * 原因是"本轮新增了目录"这件事**无法**区分两种情况:
   *   - 脚本正在正常造数(接下来会删掉)
   *   - 脚本漏了清理(没人会删)
   * 在清理发生之前, 两者的磁盘状态**完全一样**, 没有任何信号能区分。
   *
   * 所以它现在只承担"找出该删什么"的职责(供 finish 的补救阶段使用),
   * 判定成败交给 finish 里清理**之后**的终检。保留这个函数是因为
   * verify-harness-selftest 需要直接检验"diff 能不能看见泄漏"。
   *
   * 断法上刻意不做"扫固定前缀": 前缀会与别的脚本/历史轮次撞车, 在共用
   * 环境下误报; 而差集法只看"本次运行期间新增了什么", 与邻居无关。
   */
  async function diffFrom(before) {
    const after = await snapshot();
    const added = (a, b) => a.filter((x) => !b.includes(x));
    return {
      newDirs: added(after.dirs, before.dirs),
      newTrash: added(after.trash, before.trash),
      newAlbumKeys: added(after.albumKeys, before.albumKeys),
    };
  }

  /** @deprecated 保留给自测脚本; 判定请用 finish() 内部的终检。 */
  async function assertNoLeak(before) {
    const d = await diffFrom(before);
    const fmt = (n) => (n.length ? n.slice(0, 5).join(",") + (n.length > 5 ? " ..." : "") : "");
    check("诊断: outputs/ 新增目录", d.newDirs.length === 0, fmt(d.newDirs));
    check("诊断: 回收站新增条目", d.newTrash.length === 0, fmt(d.newTrash));
    check("诊断: _album.json 新增孤儿键", d.newAlbumKeys.length === 0, fmt(d.newAlbumKeys));
    return d;
  }

  /**
   * 退出钩子: 清理 -> 补救 -> 终检。**必须放在 finally 里。**
   *
   * ============================ 为什么是三段而不是一段 ============================
   *
   * 最早的设计是"先自检再清理", 想着自检报出来的就是泄漏。实跑
   * verify-gallery-paging 时立刻发现问题: 它正常就要造 8 个 job 放在
   * outputs/ 里, 于是自检必然报 3 条 FAIL, 而磁盘其实是**按设计**脏的。
   *
   * 也就是说, "本轮新增了目录" 这件事本身**不能**判定泄漏 ——
   * 正常造数与漏清理在那一刻的磁盘状态完全一样, 没有任何信号能区分。
   * 唯一能区分的是**清理之后**: 该删的都删掉了才是干净。
   *
   * 所以拆成两种用途, 断言语义完全不同:
   *
   *   - **中间 diff**(清理前): 只用来**找漏网**并补救。它抓到的集合里
   *     混着"已登记的"与"没登记的", 前者本就该删, 后者才是泄漏。
   *     对已登记的那些不该报警 —— 报了就是噪声。
   *   - **终检 diff**(补救后): 才是真正的断言, 判据是"磁盘回到了
   *     进入前的状态"。此时仍有残留, 就是清理真的失败了。
   *
   * 保留中间快照的价值: 补救要靠它才知道**该删什么**。若只做终检,
   * 漏登记的残留永远查不出来 —— 而那正是本项目反复中招的那一类。
   */
  async function finish(before) {
    if (cleaned) return;
    cleaned = true;
    uninstallSignalHandlers();

    /**
     * 0. 先把在途的登记全部落定, **再**动手清理。
     *
     * 顺序是硬要求: 被测代码造出来的 job(如 capture/save)是在 HTTP 响应
     * 到达时才被登记的, 而那个登记是异步的。若不先 await 完, 清理可能
     * 早于登记发生 —— 于是"清理跑完了, 看起来一切正常", 那个 job 却
     * 逃出了本轮, 变成下次运行里的历史垃圾。这类失败不会让任何断言变红,
     * 正是本模块存在的意义所在。
     */
    await drainWatchers();
    for (const w of watchers) w.dispose();
    watchers.length = 0;

    // 1. 清理已登记的(走 API, 保证 _album.json 不留孤儿键)
    const res = await cleanupRegistered();
    if (!res.ok) {
      check("清理已登记数据", false, res.reason || "");
    }

    // 2. 中间 diff -> 找出**未登记**的漏网
    if (before) {
      const mid = await snapshot();
      // 减去已登记的: 已登记的刚被 cleanupRegistered 清过了, 还在就说明
      // 清理对它们也失败了, 那属于"清理已登记数据"该报的账, 不重复报。
      const rogueDirs = mid.dirs.filter((x) => !before.dirs.includes(x) && !adopted.has(x));
      const rogueTrash = mid.trash.filter((x) => !before.trash.includes(x) && !adopted.has(x));
      const rogue = [...new Set([...rogueDirs, ...rogueTrash])];

      /**
       * 把"未登记的漏网"再分成两类 —— **能不能证明是本轮造的**。
       *
       * 早先这里对 rogue 一律 forcePurge, 依据是"入口没有、现在有, 所以是
       * 脚本漏清理的"。这个推理在**独占**环境成立, 在共享环境不成立:
       * 用户在这 30 秒里新拍了一张照片, 另一个 verify 进程也在造数 ——
       * 它们在磁盘上的形态与 rogue 完全一样。于是脚本会理直气壮地把
       * 用户的照片删掉, 并且**每一项断言都还是绿的**。
       *
       * 证据只有一种形态是可信的: **id 里带着本次运行的短码**。
       * makeJobOnDisk 造的目录必然含 runCode, 于是"含 runCode 且未登记"
       * 只能是本轮造数漏了登记, 删它没有疑问。随机 hex(用户自己拍的、
       * 或别的进程造的)不含 runCode, 判不了归属。
       *
       * 反过来也要承认代价: 一条**真的**漏登记的 capture/save 数据,
       * 它是随机 hex, 会被归进"不可自动删", 于是要靠人处理。这是刻意的
       * 取舍 —— 见 LEAK_MODE 的注释。宁可漏删, 不能误删。
       */
      const ownRun = (id) => id.includes(runCode);
      const safeToPurge = rogue.filter(ownRun);
      const uncertain = rogue.filter((x) => !ownRun(x));

      if (safeToPurge.length) {
        console.log(
          `  [harness] 发现 ${safeToPurge.length} 条本轮漏登记的残留(含运行码), 强制清理: ${safeToPurge.slice(0, 5).join(",")}`,
        );
        await forcePurge(safeToPurge);
      }

      /**
       * 判不了归属的一律走"报告"而不是"删除", 除非显式要求 purge。
       *
       * 这里刻意**不**用 check(): 判失败的语义是"脚本写错了", 而这些
       * 条目很可能根本不是脚本造的。让别人的数据把测试跑红, 等于训练
       * 所有人忽略红字。strict 模式才判失败, 那是在"这个环境本来就该
       * 只有测试数据"的前提下。
       */
      if (uncertain.length) {
        const detail = uncertain.slice(0, 6).join(",") + (uncertain.length > 6 ? " ..." : "");
        console.log(
          `  [harness][warn] ${uncertain.length} 条来源不明的残留, 无法证明属于本轮, 已跳过删除: ${detail}`,
        );
        console.log(
          "  [harness][warn] 若确认是测试垃圾, 用 node verify-sweep.mjs --dry-run 先看清再删。",
        );
        warn.push(`未自动清理的未知残留 ${uncertain.length} 条`);
        if (LEAK_MODE === "strict") {
          check("无来源不明的残留(strict)", false, detail);
        } else if (LEAK_MODE === "purge") {
          await forcePurge(uncertain);
        }
      }
    }

    // 3. 终检: 此时磁盘应回到进入前的样子
    if (before) {
      const after = await snapshot();
      const added = (a, b) => a.filter((x) => !b.includes(x));
      /**
       * 终检要**扣掉判不了归属的那批**。
       *
       * 不扣的话, 上面刚刚"刻意不删"的条目会在这里变成 3 条 FAIL, 于是
       * report 模式实际上退化成 strict —— 默认档位形同虚设。扣掉之后
       * 语义才干净: 终检只负责验"**本轮该清的**清干净了", 归属不明的
       * 由上面的 warn 单独报。
       */
      const skip = new Set();
      const midNow = await snapshot();
      for (const id of [...midNow.dirs, ...midNow.trash]) {
        if (!before.dirs.includes(id) && !before.trash.includes(id) && !adopted.has(id) && !id.includes(runCode)) {
          skip.add(id);
        }
      }
      const newDirs = added(after.dirs, before.dirs).filter((x) => !skip.has(x));
      const newTrash = added(after.trash, before.trash).filter((x) => !skip.has(x));
      // _album.json 同理: 判不了归属的目录留下的孤儿键不该判本轮失败。
      const newAlbumKeys = added(after.albumKeys, before.albumKeys).filter((k) => !skip.has(k));
      const fmt = (n) => (n.length ? n.slice(0, 5).join(",") + (n.length > 5 ? " ..." : "") : "");

      check("清理后 outputs/ 回到进入前状态", newDirs.length === 0, fmt(newDirs));
      check("清理后回收站回到进入前状态", newTrash.length === 0, fmt(newTrash));
      check("清理后 _album.json 无新增孤儿键", newAlbumKeys.length === 0, fmt(newAlbumKeys));
    }
  }

  /**
   * 强制删除一批 id。
   *
   * ⚠️ 调用方**有义务**先证明这些 id 属于本轮。这个函数不做归属判断,
   * 也不该做 —— 它拿到的每个 id 都对应一次不可恢复的删除。
   * finish() 里按"含运行码"筛选之后才调它, 正是这个义务的落点。
   *
   * 走 API(能同时清掉 _album.json 的键), 失败再退回 fs.rm。
   * 退回时孤儿键会留下, 但那由 _album.json 那条断言去报 —— 宁可留个
   * 可见的孤儿键, 也不要留一个看不见的目录。
   */
  async function forcePurge(ids) {
    if (!ids.length) return;
    try {
      await fetch(`${apiBase}/gallery/batch-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_ids: ids, permanent: true }),
      });
      for (const id of ids) {
        await fetch(`${apiBase}/gallery/trash/${id}/purge`, { method: "POST" }).catch(() => {});
      }
    } catch {
      for (const id of ids) {
        await fsp.rm(path.join(outDir, id), { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  /**
   * Ctrl+C 兜底。
   *
   * 只在"已登记的数据"上做尽力而为的同步清理, 不做快照自检 —— 中断时
   * 打印一堆断言只会淹没真正有用的信息。它降低残留概率, 但**不能**替代
   * diff 断言: 进程被强杀(任务管理器/断电)时监听根本不会触发。
   */
  function onSignal(sig) {
    console.log(`\n  [harness] 收到 ${sig}, 尽力清理本轮已登记的 ${adopted.size} 条数据...`);
    for (const id of adopted) {
      // 同步删: 进程即将退出, 没有 await 的机会。
      // 不走 API 是因为 fetch 是异步的, exit 阶段调它等于没调。
      try {
        rmSync(path.join(outDir, id), { recursive: true, force: true });
      } catch {
        /* 中断路径上的失败不再上报, 交给下次运行的 diff 断言 */
      }
    }
    process.exit(130);
  }

  let sigintHandler = null;
  let sigtermHandler = null;
  function installSignalHandlers() {
    if (process.env.BIGHEAD_VERIFY_NO_SIGNAL_GUARD === "1") return;
    sigintHandler = () => onSignal("SIGINT");
    sigtermHandler = () => onSignal("SIGTERM");
    process.on("SIGINT", sigintHandler);
    process.on("SIGTERM", sigtermHandler);
  }
  function uninstallSignalHandlers() {
    if (sigintHandler) process.off("SIGINT", sigintHandler);
    if (sigtermHandler) process.off("SIGTERM", sigtermHandler);
    sigintHandler = null;
    sigtermHandler = null;
  }

  /**
   * 本次运行的短码。用于造目录名与元数据标记。
   *
   * 必须**每次运行都不同**: 固定前缀(如 "mq")会让上一轮的残留混进本轮
   * 搜索结果, 于是按 DOM 下标算的期望值全部错位, 表现为"区间选随机算错",
   * 而被测代码完全正常。
   */
  const runCode = Date.now().toString(36).slice(-6);
  const runTag = options.markPrefix || `${scriptName.replace(/^verify-/, "").slice(0, 4)}${runCode}`;

  installSignalHandlers();

  return {
    // 常量
    apiBase,
    outDir,
    runCode,
    runTag,
    // 断言与登记
    check,
    track,
    adopt,
    adoptMarked,
    markJob,
    /**
     * 本次运行已登记的 job id 快照。
     *
     * 存在的理由是**白名单**: 有些脚本必须"只对我造的那些条目动手"
     * 才能保证不误删用户数据(verify-gallery-trash 的批量删除段就是
     * 逐个勾选白名单里的卡片, 而不是点「全选」)。没有这个出口, 那些
     * 脚本只能自己维护一份 created, 于是又有了"两份登记、可能不一致"
     * 这个新问题 —— 而不一致的方向恰恰是漏清理。
     *
     * 返回**副本**: 调用方拿到的是当时的快照, 之后继续造数不会改动它。
     */
    tracked: () => [...adopted],
    // 造数
    makeJobOnDisk,
    /**
     * 监听被测代码自己造的 job 并自动登记。
     *
     * 何时用: job 由**页面里的代码**创建(典型是点「生成拼图」→
     * DecoratePage.doLayout → saveCaptures), 脚本手里没有 id, 只能从
     * layoutUrl 反解。而反解之前的每一次网络往返/断言都是一个泄漏窗口。
     *
     * 何时不用: job 是脚本自己造的(makeJobOnDisk), 或者脚本本来就知道
     * id(自己调 /api/capture/save 并拿到响应) —— 那两种直接 track/adopt
     * 就够, 多挂一个监听只是白费功夫。
     */
    watchCapturedJobs,
    // 生命周期
    snapshot,
    diffFrom,
    cleanupRegistered,
    assertNoLeak,
    finish,
    // 汇总
    pass,
    fail,
    /**
     * 告警列表。与 fail 分开, 因为"要人看一眼"和"脚本写错了"是两种事,
     * 混在同一个红字里只会让人学会无视红字。
     */
    warn,
    /**
     * 打印汇总并设置 exit code。
     *
     * 退出码非 0 是 run-all-verify.ps1 判定失败的依据, 所以这里必须
     * 无条件以 fail.length 决定, 不能沿用最后一个 check 的结果。
     */
    report(label = scriptName) {
      // 兜底卸载: 信号监听会**阻止 Node 自然退出**(有 listener 就不是
      // 干净的 event loop), 脚本若在 createHarness 之后、finish 之前
      // 抛异常, 进程会挂住不退出 —— 表现为"跑着跑着卡住了", 而不是报错。
      // finish() 正常路径已经卸过一次, 这里重复调用是无害的。
      uninstallSignalHandlers();
      console.log(`\nResult: ${pass.length} passed, ${fail.length} failed`);
      if (fail.length) console.log("FAILED:", fail.join(" | "));
      /**
       * 告警**不影响**退出码。
       *
       * 刻意如此: 判红等于"这次回归不通过", 而来源不明的残留很可能
       * 根本不是本脚本造的(用户新拍的照片、同事在跑另一个脚本)。
       * 让它们把退出码染红, 就会有人在 CI 上开始忽略红字 —— 那比留
       * 几个目录严重得多。需要卡住的话用 BIGHEAD_VERIFY_LEAK_MODE=strict。
       */
      if (warn.length) console.log("WARN:", warn.join(" | "));
      process.exitCode = fail.length ? 1 : 0;
      return fail.length === 0;
    },
  };
}

/**
 * 清扫历史残留 —— 独立入口, 不参与任何断言。
 *
 * 用途: 模块上线之前, outputs/ 里已经躺着几十个无主目录(hex id 的那些
 * 靠前缀扫不出来), 以及若干孤儿键。这个脚本按"可识别的测试痕迹"清理:
 *
 *   1. 目录名匹配已知测试前缀(bt/pt/ui/tr/tk/tp/tb/tu/mq...) —— 这些是
 *      各脚本历史上用的两字母前缀, 现在不会再产生, 属于纯垃圾。
 *   2. title 带 "verify" 或 "mq" 之类运行标记的条目 —— 通过 /api/gallery
 *      拿 title 再比对, 能清掉 hex id 那一类。
 *
 * **不碰**任何无法判定归属的目录: 用户自己的 12 位 hex job_id 与测试
 * 造的 hex job_id 在磁盘上完全同构, 靠猜清理就是在赌用户的数据不重要。
 * 这一条宁可少清, 也不能误删 —— 误删不可恢复, 漏删只是难看。
 *
 * 用法:
 *   node verify-sweep.mjs --dry-run     只列不删(默认)
 *   node verify-sweep.mjs --yes         真删
 *   node verify-sweep.mjs --yes --title 测试   额外清 title 含该子串的
 *   node verify-sweep.mjs --all-hex     额外**只读**列出无标记 hex 目录
 */
export async function sweep({ dryRun = true, titleMatch = null, listHex = false } = {}) {
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const here = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.resolve(here, "..", "outputs");
  const apiBase = (process.env.API_URL || "http://127.0.0.1:8077/api").replace(/\/+$/, "");

  /**
   * 历史上各脚本用过的目录前缀。**只列确定的**。
   *
   * 这份清单是"当时造数用了什么"的考古结果, 不是设计: 新的测试数据一律
   * 带运行短码, 不再产生固定前缀。它存在的唯一理由是把存量清掉。
   */
  const LEGACY_PREFIXES = [
    "bt", "pt", "ui", // gallery-paging
    "mq", // gallery-marquee
    "tr", "tk", "tp", "tb", "tu", // gallery-trash
  ];

  const entries = await fsp
    .readdir(outDir, { withFileTypes: true })
    .then((es) => es.filter((e) => e.isDirectory() && !isInternalDir(e.name)).map((e) => e.name))
    .catch(() => []);

  const byPrefix = entries.filter((name) => LEGACY_PREFIXES.some((p) => name.startsWith(p)));

  // title 匹配: 走 API 拿全量, 因为 title 存在 _album.json 里, 目录名上看不到。
  const gallery = await fetch(`${apiBase}/gallery?limit=0`)
    .then((r) => r.json())
    .catch(() => null);
  const byTitle = [];
  if (gallery && Array.isArray(gallery.items)) {
    const needle = titleMatch ?? "verify";
    for (const it of gallery.items) {
      const hay = `${it.title || ""} ${(it.tags || []).join(" ")}`;
      if (hay.toLowerCase().includes(needle.toLowerCase())) byTitle.push(it.job_id);
    }
  }

  const targets = [...new Set([...byPrefix, ...byTitle])];

  console.log(`扫描 ${outDir}`);
  console.log(`  固定前缀命中: ${byPrefix.length}`);
  console.log(`  元数据标记命中: ${byTitle.length}`);
  console.log(`  待处理合计: ${targets.length}`);
  if (targets.length) {
    for (const t of targets.slice(0, 30)) console.log(`    - ${t}`);
    if (targets.length > 30) console.log(`    ... 另有 ${targets.length - 30} 条`);
  }

  /**
   * --all-hex: 只**列**出抓不到的 hex 目录, 绝不把它们加进 targets。
   *
   * 形态依据是 backend/jobs.py 的 `uuid.uuid4().hex[:12]` —— 12 位小写 hex。
   * 之所以只列不删: 这个形态与用户真实 job 完全同构, 判定归属需要的是
   * 拍摄内容或时间上下文, 而脚本手里只有目录名。让它出现在清单里, 是为了
   * 让人(而不是脚本)去画廊里一眼确认, 而不是把删除权交给一条正则。
   */
  if (listHex) {
    const HEX_RE = /^[0-9a-f]{12}$/;
    const hexDirs = entries.filter((name) => HEX_RE.test(name) && !targets.includes(name));
    console.log(`\n无标记 hex 目录 (只列不删, 共 ${hexDirs.length} 个):`);
    for (const t of hexDirs.slice(0, 40)) console.log(`    ? ${t}`);
    if (hexDirs.length > 40) console.log(`    ... 另有 ${hexDirs.length - 40} 个`);
    if (!hexDirs.length) console.log("    (无)");
    console.log("  这些与用户自己的 job 无法区分, 请到画廊里人工确认后再处理。");
  }

  if (dryRun) {
    console.log("\n(dry-run: 未删除任何东西。加 --yes 执行)");
    return { targets, deleted: [] };
  }
  if (!targets.length) return { targets, deleted: [] };

  const r = await fetch(`${apiBase}/gallery/batch-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_ids: targets, permanent: true }),
  });
  const body = await r.json().catch(() => ({}));
  // 与 cleanupRegistered 同理: permanent 清不到回收站里那一份, 必须逐个 purge。
  for (const id of targets) {
    await fetch(`${apiBase}/gallery/trash/${id}/purge`, { method: "POST" }).catch(() => {});
  }
  console.log(
    `\n已删除 ${(body.deleted || []).length} 条; missing=${(body.missing || []).length} failed=${(body.failed || []).length}`,
  );
  return { targets, deleted: body.deleted || [] };
}

// 仅在直接运行时执行清扫(`node verify-sweep.mjs`), 被 import 时不触发。
if (process.argv[1] && process.argv[1].endsWith("verify-sweep.mjs")) {
  const args = process.argv.slice(2);
  const tIdx = args.indexOf("--title");
  await sweep({
    dryRun: !args.includes("--yes"),
    titleMatch: tIdx >= 0 ? args[tIdx + 1] : null,
    listHex: args.includes("--all-hex"),
  });
}
