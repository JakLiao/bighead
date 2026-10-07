/**
 * 画廊批量选择的纯逻辑。
 *
 * 为什么单独成文件: 框选与 Shift 范围选里真正容易出错的是**几何与区间**,
 * 而它们此前全部内联在 GalleryPage.tsx 的事件回调里。那样写的代价是:
 * 改一个比较符号只能靠"手动拖一次框"来验证, 而拖框的失败方式非常含混
 * —— 表现为"框选没反应"或"多选了几张", 从现象反推不到是哪一行比较错了。
 *
 * 抽出来之后这些函数全部是**无副作用的纯函数**: 输入几个数字/一个数组,
 * 输出一个确定结果, 于是可以逐条钉住边界(见 verify-gallery-selection.mjs)。
 *
 * 刻意不接受的依赖:
 *   - 不碰 React: 组件负责什么时候调用, 这里只回答"结果是什么"。
 *   - 不碰 document / getBoundingClientRect: DOM 查询与布局测量留在组件层,
 *     这里只接受已经量好的数字。纯函数因此可以在任意环境里跑, 不需要 jsdom。
 *   - 不含 Math.random / Date.now: 结果可复现, 便于断言。
 */

/** 视口坐标系下的选框。x/y 是 clientX/clientY(不是页面文档坐标)。 */
export type MarqueeBox = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

/** 归一化后的矩形:保证 left <= right、top <= bottom。 */
export type Rect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/** 一张卡片的量测结果。rect 用 DOMRect 的字段子集, 便于测试直接构造字面量。 */
export type CardMeasure = {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

/**
 * 位移是否越过"这是框选而不是点击"的阈值。
 *
 * 阈值必须用 **两个方向分别取绝对值后取或**, 而不是比较欧氏距离:
 * 距离的平方根在这里没有任何收益(只需要一个布尔), 却让每一帧多一次
 * Math.sqrt; 而更重要的是 `>` 而不是 `>=` —— 恰好等于阈值时视为
 * "还没决定", 交给下一次 move 再判。这让"正好 5px"这种边界手势
 * 不会在按下瞬间就跳进框选状态。
 */
export function didExceedMarqueeThreshold(
  start: { x: number; y: number },
  current: { x: number; y: number },
  threshold: number,
): boolean {
  return (
    Math.abs(current.x - start.x) > threshold ||
    Math.abs(current.y - start.y) > threshold
  );
}

/**
 * 把"起点 + 当前点"归一化成矩形。
 *
 * 必须归一化: 指针可以往左/上拖, 于是 x1 < x0、y1 < y0 是常态。
 * 若直接拿 x0 当 left, 反向框选(从右下往左上拖)会算出负的宽高,
 * 选框不显示且命中全部落空 —— 这是实现里真实出现过的方向性 bug。
 */
export function normalizeMarquee(box: MarqueeBox): Rect {
  return {
    left: Math.min(box.x0, box.x1),
    top: Math.min(box.y0, box.y1),
    right: Math.max(box.x0, box.x1),
    bottom: Math.max(box.y0, box.y1),
  };
}

/**
 * 两个矩形是否相交(边界接触算相交)。
 *
 * 用 `a.right < b.left` 这种**严格小于**而不是 `<=`: 卡片边缘正好压在
 * 选框边界上时, 用户的意图显然是"我圈到它了"。写成 `<=` 会让"擦边"
 * 变成不命中, 表现为框选时最后一行永远选不进去, 而且只在某些缩放比例
 * 下偶发, 极难定位。
 *
 * 注意这不是几何学上严格的"相交"(零面积重叠不算), 而是**包围盒重叠
 * 判定**—— 空选框(x0===x1)也因此会命中它压住的那张卡, 这与"拖出一条
 * 零宽的线"的手感一致。
 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  if (a.right < b.left) return false;
  if (a.left > b.right) return false;
  if (a.bottom < b.top) return false;
  if (a.top > b.bottom) return false;
  return true;
}

/**
 * 框选命中: 返回所有与选框相交的卡片 id, **保持传入顺序**。
 *
 * 相交法而不是"中心点在框内": 中心点法在卡片只露出一角时会漏选,
 * 而相交法与用户直觉一致("我把它们圈进去了")。
 *
 * 跳过零尺寸卡片: 刚挂载未布局、或已卸载的卡片 rect 全是 0, 它们会与
 * 任何选框"相交"(0 宽矩形落在选框内即命中), 于是选出一堆看不见的条目。
 * 这不是理论风险: 无限滚动会同时挂载与卸载卡片, 量测时点完全可能
 * 落在布局未完成的那一帧。
 *
 * 保持传入顺序(而非按 x/y 排序)是因为调用方会把第一个命中项当 Shift
 * 锚点, 顺序应当反映用户看到的视觉顺序 = DOM 顺序。
 */
export function collectMarqueeHits(
  box: MarqueeBox,
  cards: CardMeasure[],
): string[] {
  const rect = normalizeMarquee(box);
  const hits: string[] = [];
  for (const card of cards) {
    if (!card.id) continue;
    if (card.width === 0 || card.height === 0) continue;
    if (!rectsIntersect(rect, card)) continue;
    hits.push(card.id);
  }
  return hits;
}

/**
 * Shift 范围选: 返回 anchor 到 target 之间**闭区间**的 id 列表。
 *
 * 两个刻意的决定:
 *
 * 1. **闭区间**。anchor 与 target 自身都应被选中 —— 用户按住 Shift 点
 *    目标卡片时, 预期是"这段全部选中", 若排除目标就会显得少了一张。
 *
 * 2. **返回全量替换值而不是增量**。Shift+点击的语义是"我要这一段",
 *    之前零散勾的别的条目不该混进来, 否则会出现"看着没选却要一起删"。
 *    所以调用方是 `setSelected(new Set(...))` 而非追加。
 *
 * 越界与空值一律**夹逼**而不是报错:
 *   - anchor 为 null(用户先零散勾了几条, 此时没有起点): 把 target
 *     当锚点, 只返回这一条。资源管理器与 Finder 都是这个行为。
 *   - 列表为空: 返回空数组。此时 slice 会静默给出 [], 不会抛错。
 *   - 越界下标: Math.min/Math.max 加 slice 的自动夹逼共同保证结果
 *     始终是列表的一个连续子段, 不含 undefined。
 */
export function selectRangeIds(
  jobIds: string[],
  anchorIndex: number | null,
  targetIndex: number,
): string[] {
  const from = anchorIndex ?? targetIndex;
  const lo = Math.min(from, targetIndex);
  const hi = Math.max(from, targetIndex);
  return jobIds.slice(lo, hi + 1);
}

/**
 * 普通点击的勾选切换: 命中则移除, 未命中则加入。
 *
 * 单独抽出来是因为它有一个真实存在的边界: 传入的 id 不在 jobIds 里。
 * 此时 `has` 为 false, 天真实现会把它**加进**选中集, 产生一个界面上
 * 永远看不见、但会被批量删除请求带上的幽灵 id。所以这里显式拒绝未知
 * id, 返回原集合。
 *
 * 返回新对象而不是原地改: React 靠引用变化判断要不要重渲染,
 * 原地 Set#add 不会触发更新。
 */
export function toggleSelectedId(
  selected: Set<string>,
  jobId: string,
  jobIds: string[],
): Set<string> {
  const next = new Set(selected);
  if (!jobIds.includes(jobId)) return next;
  if (next.has(jobId)) next.delete(jobId);
  else next.add(jobId);
  return next;
}

/**
 * 全选/取消全选当前已加载条目。
 *
 * 注意"全选"的基准是 **items 本身**而不是 selected ⊆ items:
 * 无限滚动下 selected 可能包含已被后端分页移出当前视图的 id, 用子集
 * 判断会在"旧 id 还在、新 id 没全选"时误判为已全选, 于是点一下反而清空。
 * 用"数量相等 + 逐个命中"双条件, 对这种脏状态是安全的。
 */
export function selectAllOrClear(
  selected: Set<string>,
  jobIds: string[],
): Set<string> {
  if (jobIds.length === 0) return new Set<string>();
  const allSelected =
    selected.size === jobIds.length && jobIds.every((id) => selected.has(id));
  if (allSelected) return new Set<string>();
  return new Set(jobIds);
}
