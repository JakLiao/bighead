/**
 * 画廊框选 / Shift 范围选 —— 纯函数单元测试
 *
 * 与 verify-gallery-marquee.mjs 的分工:
 *   - marquee.mjs 是 E2E: 真的拖一次框, 看 UI 对不对。覆盖真实但慢,
 *     而且失败时只能得到"框选没反应"这种含混现象。
 *   - 本文件是单元测试: 直接 import src/components/gallery/selection.ts,
 *     逐条钉住几何与区间的边界。失败时能直接指出是哪个判定出的问题。
 *
 * 为什么用 Playwright 而不是 Vitest:
 *   项目没有前端测试 runner, 且本项目的纯函数测试一贯走"Vite dev server
 *   转译 TS + 浏览器内 import"这条路(见 verify-masks.mjs)。沿用它可以
 *   不新增任何依赖 —— 引入 Vitest 意味着新增 devDependencies、配置与
 *   一套新的 CI 入口, 而这里要验证的只是几个几十行的纯函数。
 *
 * 断言方式: 每条用例把 {实际值, 期望值} 交给 check, 由页面内比较后回传。
 * 在页面里比而不是把结果搬回 Node 再比, 是因为 Set 无法结构化克隆 ——
 * 必须在页面内转成数组。
 */
import { chromium } from "playwright";

const URL = process.env.APP_URL || "http://localhost:5173/home";
const PASS = [];
const FAIL = [];
const check = (n, c, d = "") => {
  (c ? PASS : FAIL).push(n);
  console.log(`  [${c ? "PASS" : "FAIL"}] ${n}${d ? ` ${d}` : ""}`);
};

const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// 只 goto 一次拿到 Vite 的模块图, 之后所有断言都在页面内跑纯函数。
// 用 /home 而不是 /gallery: 这里不碰真实数据, 也就不需要后端就绪。
await page.goto(URL, { waitUntil: "domcontentloaded" });

const results = await page.evaluate(async () => {
  const S = await import("/src/components/gallery/selection.ts");
  const out = [];
  const t = (name, actual, expected) => {
    out.push({
      name,
      ok: Object.is(actual, expected),
      actual: JSON.stringify(actual),
      expected: JSON.stringify(expected),
    });
  };
  const tj = (name, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    out.push({ name, ok: a === e, actual: a, expected: e });
  };
  /**
   * 集合相等断言(忽略顺序)。
   *
   * 为什么需要它: Set 保持**插入顺序**, 新增的 id 追加到末尾, 而断言里
   * 写 ["a","b","c"] 会隐含"Set 会排序"的错误前提。这类失败不指向任何
   * 真实缺陷 —— 选中集的下游用法只有 `has()`(渲染勾选)与展开成数组
   * (发批量删除请求, 后端自己去重), 顺序不影响任何行为。
   *
   * 所以选中集相关断言一律用 tset 比内容, 只有"命中顺序"这类**顺序本身
   * 就是契约**的场景(第一个命中项要当 Shift 锚点)才用 tj 比顺序。
   */
  const tset = (name, actual, expected) => {
    const a = [...actual].slice().sort();
    const e = [...expected].slice().sort();
    out.push({
      name,
      ok: JSON.stringify(a) === JSON.stringify(e),
      actual: JSON.stringify(a),
      expected: JSON.stringify(e),
    });
  };

  // ---- 1. 阈值判定 -----------------------------------------------------
  // 核心不变量: 阈值内不算框选(否则轻点会误圈), 超阈值才算。
  t("阈值 0 位移不激活", S.didExceedMarqueeThreshold({ x: 10, y: 10 }, { x: 10, y: 10 }, 5), false);
  t("阈值内 4px 不激活", S.didExceedMarqueeThreshold({ x: 0, y: 0 }, { x: 4, y: 0 }, 5), false);
  t("超阈值 6px 激活", S.didExceedMarqueeThreshold({ x: 0, y: 0 }, { x: 6, y: 0 }, 5), true);
  // 恰好等于阈值判为未激活: 边界手势不该在按下瞬间跳进框选。
  t("恰好等于阈值不激活", S.didExceedMarqueeThreshold({ x: 0, y: 0 }, { x: 5, y: 0 }, 5), false);
  // 反方向同样成立: 只看 x 会让"纯竖直拖动"永远不激活。
  t("反向 -6px 激活", S.didExceedMarqueeThreshold({ x: 100, y: 0 }, { x: 94, y: 0 }, 5), true);
  t("仅竖直超阈值激活", S.didExceedMarqueeThreshold({ x: 0, y: 0 }, { x: 0, y: 6 }, 5), true);
  t("仅竖直在阈值内不激活", S.didExceedMarqueeThreshold({ x: 0, y: 0 }, { x: 0, y: 4 }, 5), false);
  // 对角: 两个方向都超, 取"或"所以任一超即可。
  t("对角双超激活", S.didExceedMarqueeThreshold({ x: 0, y: 0 }, { x: 4, y: 4 }, 5), false);
  t("对角单轴超即激活", S.didExceedMarqueeThreshold({ x: 0, y: 0 }, { x: 3, y: 9 }, 5), true);
  // 阈值 0: 任何位移都算框选(用于测试本身, 也钉住"没有魔数减一")。
  t("阈值 0 时任何位移激活", S.didExceedMarqueeThreshold({ x: 0, y: 0 }, { x: 0, y: 1 }, 0), true);
  t("阈值 0 时零位移不激活", S.didExceedMarqueeThreshold({ x: 3, y: 3 }, { x: 3, y: 3 }, 0), false);

  // ---- 2. 选框归一化 ---------------------------------------------------
  // 不变量: left<=right 且 top<=bottom, 无论拖动方向。
  tj("正向归一化", S.normalizeMarquee({ x0: 10, y0: 20, x1: 30, y1: 50 }), { left: 10, top: 20, right: 30, bottom: 50 });
  tj("反向归一化(左下->右上)", S.normalizeMarquee({ x0: 30, y0: 50, x1: 10, y1: 20 }), { left: 10, top: 20, right: 30, bottom: 50 });
  tj("仅 x 反向", S.normalizeMarquee({ x0: 30, y0: 20, x1: 10, y1: 50 }), { left: 10, top: 20, right: 30, bottom: 50 });
  tj("仅 y 反向", S.normalizeMarquee({ x0: 10, y0: 50, x1: 30, y1: 20 }), { left: 10, top: 20, right: 30, bottom: 50 });
  // 零宽/零高(拖出一条直线): 归一化后不能出现负数。
  tj("零宽选框", S.normalizeMarquee({ x0: 15, y0: 0, x1: 15, y1: 40 }), { left: 15, top: 0, right: 15, bottom: 40 });
  tj("零高选框", S.normalizeMarquee({ x0: 0, y0: 7, x1: 40, y1: 7 }), { left: 0, top: 7, right: 40, bottom: 7 });
  tj("零面积选框", S.normalizeMarquee({ x0: 5, y0: 5, x1: 5, y1: 5 }), { left: 5, top: 5, right: 5, bottom: 5 });
  // 负坐标: 视口可以滚动到负的 clientX? 不会, 但归一化不该因此崩。
  tj("负坐标归一化", S.normalizeMarquee({ x0: -30, y0: -50, x1: -10, y1: -20 }), { left: -30, top: -50, right: -10, bottom: -20 });

  // ---- 3. 矩形相交 -----------------------------------------------------
  const box = (l, t, r, b) => ({ left: l, top: t, right: r, bottom: b });
  t("完全包含算相交", S.rectsIntersect(box(0, 0, 100, 100), box(10, 10, 20, 20)), true);
  t("完全被包含算相交", S.rectsIntersect(box(10, 10, 20, 20), box(0, 0, 100, 100)), true);
  t("部分重叠算相交", S.rectsIntersect(box(0, 0, 50, 50), box(25, 25, 75, 75)), true);
  t("仅擦到左边缘算相交", S.rectsIntersect(box(0, 0, 50, 50), box(50, 10, 80, 20)), true);
  t("仅擦到右边缘算相交", S.rectsIntersect(box(10, 10, 50, 20), box(0, 0, 10, 50)), true);
  t("仅擦到上边缘算相交", S.rectsIntersect(box(0, 0, 50, 10), box(10, 10, 20, 20)), true);
  t("仅擦到下边缘算相交", S.rectsIntersect(box(0, 10, 50, 20), box(10, 0, 20, 10)), true);
  // 差 1px 就不算: 钉住"严格小于"而不是"小于等于"。
  t("差 1px 不相交", S.rectsIntersect(box(0, 0, 50, 50), box(50.5, 10, 80, 20)), false);
  t("左侧完全分离", S.rectsIntersect(box(60, 0, 100, 50), box(0, 0, 40, 50)), false);
  t("右侧完全分离", S.rectsIntersect(box(0, 0, 40, 50), box(60, 0, 100, 50)), false);
  t("上方完全分离", S.rectsIntersect(box(0, 60, 50, 100), box(0, 0, 50, 40)), false);
  t("下方完全分离", S.rectsIntersect(box(0, 0, 50, 40), box(0, 60, 50, 100)), false);
  // 对角分离: x 与 y 都不重叠。
  t("对角完全分离", S.rectsIntersect(box(0, 0, 10, 10), box(50, 50, 60, 60)), false);
  // 零面积选框压住卡片: 手感上算圈到了。
  t("零面积点落在卡内算相交", S.rectsIntersect(box(5, 5, 5, 5), box(0, 0, 10, 10)), true);
  t("零面积点在卡外不相交", S.rectsIntersect(box(50, 50, 50, 50), box(0, 0, 10, 10)), false);
  // 相交必须对称: 交换参数结果不变。
  t("相交判定对称", S.rectsIntersect(box(0, 0, 50, 50), box(25, 25, 75, 75)), S.rectsIntersect(box(25, 25, 75, 75), box(0, 0, 50, 50)));

  // ---- 4. 框选命中收集 -------------------------------------------------
  // 构造一个 3x2 网格, 每张卡 100x50, 间距 10。
  //   布局: (0,0) (110,0) (220,0)
  //         (0,60) (110,60) (220,60)
  const mk = (id, x, y, w = 100, h = 50) => ({
    id, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h,
  });
  const grid = [
    mk("c0", 0, 0), mk("c1", 110, 0), mk("c2", 220, 0),
    mk("c3", 0, 60), mk("c4", 110, 60), mk("c5", 220, 60),
  ];
  const B = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 });

  // 完全圈住前两张。
  tj("圈住前两张", S.collectMarqueeHits(B(-5, -5, 105, 55), grid), ["c0"]);
  tj("圈住第一行两张", S.collectMarqueeHits(B(-5, -5, 215, 55), grid), ["c0", "c1"]);
  tj("圈住整个网格", S.collectMarqueeHits(B(-5, -5, 400, 200), grid), ["c0", "c1", "c2", "c3", "c4", "c5"]);
  // 反向拖动必须与正向得到相同结果(归一化的直接后果)。
  tj("反向拖动结果一致", S.collectMarqueeHits(B(215, 55, -5, -5), grid), S.collectMarqueeHits(B(-5, -5, 215, 55), grid));
  // 部分相交: 选框只压到 c1 左边缘。
  tj("只擦到一张的边缘", S.collectMarqueeHits(B(110, 0, 130, 10), grid), ["c1"]);
  // 圈住整列。
  tj("圈住第一列", S.collectMarqueeHits(B(-5, -5, 105, 200), grid), ["c0", "c3"]);
  // 命中保持传入顺序(DOM 顺序), 调用方拿第一个当 Shift 锚点。
  tj("命中保持传入顺序", S.collectMarqueeHits(B(-5, -5, 400, 200), grid.slice().reverse()), ["c5", "c4", "c3", "c2", "c1", "c0"]);
  // 一个都没圈到。
  tj("圈到空白返回空", S.collectMarqueeHits(B(1000, 1000, 1100, 1100), grid), []);
  // 空卡片列表。
  tj("空列表返回空", S.collectMarqueeHits(B(0, 0, 100, 100), []), []);

  // 零尺寸卡片必须跳过: 0 宽矩形落在任何选框内都会被判相交,
  // 不跳过就会选出一堆界面上看不见的条目。
  const withZero = [mk("z0", 0, 0, 0, 0), mk("z1", 0, 0, 0, 50), mk("z2", 0, 0, 100, 0), ...grid];
  tj("跳过零宽卡片", S.collectMarqueeHits(B(-5, -5, 400, 200), withZero), ["c0", "c1", "c2", "c3", "c4", "c5"]);
  tj("全零尺寸列表返回空", S.collectMarqueeHits(B(0, 0, 500, 500), [mk("z", 0, 0, 0, 0)]), []);
  // 空 id 的卡片(属性存在但值为空串)必须跳过。
  tj("跳过空 id 卡片", S.collectMarqueeHits(B(-5, -5, 400, 200), [mk("", 0, 0), ...grid]), ["c0", "c1", "c2", "c3", "c4", "c5"]);

  // 悬空选框(在所有卡片之上)不该命中任何东西。
  tj("选框在网格上方不命中", S.collectMarqueeHits(B(0, -500, 400, -100), grid), []);
  // 全部命中时数量正确 —— 防止"只取前 N 个"的截断回归。
  t("全选数量正确", S.collectMarqueeHits(B(-5, -5, 400, 200), grid).length, 6);

  // ---- 5. Shift 范围选 -------------------------------------------------
  const ids = ["a", "b", "c", "d", "e"];

  tj("闭区间 1->3", S.selectRangeIds(ids, 1, 3), ["b", "c", "d"]);
  tj("闭区间 0->0", S.selectRangeIds(ids, 0, 0), ["a"]);
  tj("闭区间含首尾", S.selectRangeIds(ids, 0, 4), ["a", "b", "c", "d", "e"]);
  // 反向: anchor 在后, target 在前, 结果集合必须与正向一致。
  tj("反向 3->1 与正向一致", S.selectRangeIds(ids, 3, 1), S.selectRangeIds(ids, 1, 3));
  tj("反向 4->0", S.selectRangeIds(ids, 4, 0), ["a", "b", "c", "d", "e"]);
  // 无锚点: 只选当前这张(用户心智是"从这张开始")。
  tj("无锚点只选当前", S.selectRangeIds(ids, null, 2), ["c"]);
  tj("无锚点在末位", S.selectRangeIds(ids, null, 4), ["e"]);
  // 越界夹逼: 不含 undefined, 不抛错, 返回连续子段。
  tj("target 越界夹逼到末尾", S.selectRangeIds(ids, 0, 99), ["a", "b", "c", "d", "e"]);
  tj("target 负值夹逼到开头", S.selectRangeIds(ids, 2, -5), ["a", "b", "c"]);
  tj("anchor 越界夹逼", S.selectRangeIds(ids, 99, 0), ["a", "b", "c", "d", "e"]);
  tj("两端都越界返回空", S.selectRangeIds(ids, 99, 100), []);
  // 空列表。
  tj("空列表返回空", S.selectRangeIds([], null, 0), []);
  tj("空列表带锚点返回空", S.selectRangeIds([], 3, 1), []);
  // 单元素列表。
  tj("单元素列表", S.selectRangeIds(["x"], 0, 0), ["x"]);
  // 结果必须是列表的连续子段: 用 indexOf 差值恒为 1 验证。
  const seg = S.selectRangeIds(ids, 1, 3);
  const gaps = seg.slice(1).map((id, i) => ids.indexOf(id) - ids.indexOf(seg[i]));
  tj("结果是连续子段", gaps, [1, 1]);
  // Shift 是替换而非追加: 两次调用之间没有累积, 第二次结果只取决于参数。
  tj("连续 Shift 不累积", S.selectRangeIds(ids, 0, 1), ["a", "b"]);
  tj("连续 Shift 第二段独立", S.selectRangeIds(ids, 3, 4), ["d", "e"]);

  // ---- 6. 勾选切换 -----------------------------------------------------
  // 以下全部用 tset: 选中集的顺序不是契约, 只关心内容。
  tset("未选中则加入", S.toggleSelectedId(new Set(), "b", ids), ["b"]);
  tset("已选中则移除", S.toggleSelectedId(new Set(["a", "b"]), "a", ids), ["b"]);
  tset("切换不影响其它项", S.toggleSelectedId(new Set(["a", "c"]), "b", ids), ["a", "b", "c"]);
  // 幽灵 id: 不在列表里的 id 必须被拒绝, 否则会被批量删除请求带走。
  tset("拒绝未知 id", S.toggleSelectedId(new Set(["a"]), "zzz", ids), ["a"]);
  t("拒绝未知 id 且不写入", S.toggleSelectedId(new Set(["a"]), "zzz", ids).has("zzz"), false);
  // 返回新对象: React 靠引用变化判断重渲染。
  const src = new Set(["a"]);
  const next = S.toggleSelectedId(src, "b", ids);
  t("返回新 Set 引用", next === src, false);
  tset("原集合未被修改", src, ["a"]);
  // 空列表下切换任何 id 都不应改变状态。
  tset("空列表下切换无效", S.toggleSelectedId(new Set(), "a", []), []);
  // 连续两次切换同一个 id 回到原状(幂等往返)。
  tset("切换两次回到原状", S.toggleSelectedId(S.toggleSelectedId(new Set(), "c", ids), "c", ids), []);

  // ---- 7. 全选 / 取消全选 ---------------------------------------------
  tset("空列表全选得到空集", S.selectAllOrClear(new Set(), []), []);
  tset("空列表已全选也得到空集", S.selectAllOrClear(new Set(["ghost"]), []), []);
  tset("全选所有", S.selectAllOrClear(new Set(), ids), ids);
  tset("已全选则清空", S.selectAllOrClear(new Set(ids), ids), []);
  // 脏状态: selected 里有分页移出视口的旧 id 时, 不能误判为"已全选"。
  tset("含视图外旧 id 时仍执行全选", S.selectAllOrClear(new Set(["a", "old1"]), ids), ids);
  // 部分选中 -> 全选(而不是清空)。
  tset("部分选中执行全选", S.selectAllOrClear(new Set(["a", "c"]), ids), ids);
  // 数量相同但内容不同 -> 不是全选。这正是"用 size 判断"的经典错法。
  tset("数量相同内容不同视为未全选", S.selectAllOrClear(new Set(["x", "y", "z", "w", "v"]), ids), ids);
  // 单元素列表。
  tset("单元素全选", S.selectAllOrClear(new Set(), ["only"]), ["only"]);
  tset("单元素已选则清空", S.selectAllOrClear(new Set(["only"]), ["only"]), []);

  return out;
});

for (const r of results) {
  if (r.ok) check(r.name, true);
  else check(r.name, false, `actual=${r.actual} expected=${r.expected}`);
}

check("页面无 JS 错误", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();

console.log(`\n结果: ${PASS.length} 通过, ${FAIL.length} 失败`);
if (FAIL.length) {
  console.log("失败项:");
  for (const f of FAIL) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("框选 / Shift 多选 纯函数单元测试全部通过");
