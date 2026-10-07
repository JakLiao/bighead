import { useCallback, useEffect, useRef, useState } from "react";
import { fetchGallery, patchAlbum, deleteAlbum, batchDeleteAlbums } from "../api";
import type { GalleryItem, TagCount } from "../types";
import { RETENTION_DAYS } from "../types";
import TrashPanel from "../components/album/TrashPanel";
import { AlbumEditor } from "../components/album/AlbumEditor";
import { GalleryLightbox } from "../components/gallery/GalleryLightbox";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  collectMarqueeHits as collectHits,
  didExceedMarqueeThreshold,
  normalizeMarquee,
  selectAllOrClear,
  selectRangeIds,
  toggleSelectedId,
} from "../components/gallery/selection";
import type { CardMeasure, MarqueeBox } from "../components/gallery/selection";

/**
 * 每页条数。24 条在 1280px 宽下约 6 行, 足够滚起来, 又不至于让首屏等待
 * 明显变长。必须 <= 后端 gallery.MAX_PAGE(200), 否则最后一页会被后端
 * 截断, 前端以为到底了而实际还有 —— 表现为"最后几页永远加载不出来"。
 */
const PAGE_SIZE = 24;

/**
 * 观察某个元素是否**已滚出视口顶部**, 返回布尔值。
 *
 * ## 为什么要这个 hook
 *
 * 批量操作条原本是文档流里的一个普通 `<div className="mb-3 flex ...">`。
 * 页面一滚动它就跟着上移出视口, 于是出现一个很具体的问题:
 * 用户往下滚、框选了一堆照片, 抬头找不到删除按钮 —— 而**选中状态还在**
 * (卡上的勾还在), 看上去像是"选上了但没法操作"。
 *
 * 这与 §8.16 那次修的是同一类病: **变化/操作出现在用户视线之外**。
 * 当时是"按钮变色看不见", 这次是"按钮滚走了看不见"。所以同一个判据,
 * 同一个解法方向(把关键操作搬进视口)。
 *
 * ## 为什么用 IntersectionObserver 而不是 scroll 事件
 *
 * `window.addEventListener("scroll")` 每帧都回调, 而这里只关心一个布尔值。
 * 用 observer + 一个哨兵元素, 浏览器在 C++ 侧判断, 跨过一次边界才回调
 * 一次。代价是要多渲染一个 1px 的空 div, 换来的是零 JS 参与滚动热路径。
 *
 * ## rootMargin 的含义
 *
 * `rootMargin: "-80px 0px 0px 0px"` = 哨兵上方留 80px 余量。也就是**再往上
 * 滚 80px 才算"藏起来了"**。这个缓冲是刻意的: 刚滚过临界点时工具栏其实还
 * 露着一点边, 此时就把浮动条弹出来会显得很跳。留一点重叠让两者的切换
 * 发生在"原工具栏确实看不见"之后。
 */
function useScrolledPast(ref: React.RefObject<HTMLElement | null>, offset = 80): boolean {
  const [past, setPast] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    /**
     * ## 为什么判据与观察器要分开写
     *
     * 早先写成 `{ rootMargin: "-80px" }` + `!isIntersecting && bottom < 0`。
     * 当时以为"负 rootMargin 让观察器的翻转点与判据不是同一个位置, 中间有
     * 死区" —— **这个诊断是错的**, 后来做故障注入才发现: 把 rootMargin
     * 加回去、甚至连 scroll 兜底一起删掉, 50 项断言照样全绿。
     *
     * 真正的原因在测试数据: marquee 脚本全程用搜索把列表筛到 6 张卡,
     * 页面只有两行、`docH` 撑不到一屏, `scrollTo` 是**静默失效**的。
     * 于是从来没有真的"滚过去"过 —— 断言全绿是因为**根本没测到**,
     * 不是因为代码对。
     *
     * 所以现在把位置比较放在自己的回调里, 让"判断依据"只有一处,
     * 不依赖观察器与判据的边界恰好重合:
     *
     * - 观察器: 覆盖绝大多数情况, 由浏览器在 C++ 侧判断, 不占 JS 线程。
     * - scroll 兜底: 覆盖"不跨边界但位置变了"的情况(工具栏换行导致
     *   高度变化、拖动滚动条、程序化 scrollBy)。
     *
     * 两者任一失效另一个仍能工作。
     */
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.bottom < 0) {
        setPast(true);
      } else if (rect.bottom > offset) {
        setPast(false);
      }
    };

    // 立即同步一次: 挂载时可能已经滚了一段(刷新页面保留滚动位置),
    // 而 IntersectionObserver 的首次回调是异步的 —— 不同步就会有一帧
    // 的"该显示却没显示"。
    update();

    const io = new IntersectionObserver(update);
    io.observe(el);
    // 补一条 scroll 监听: 观察器只在跨边界时回调, 而我们还要处理
    // "元素高度变化"(工具栏内容换行导致高度变化)这类不跨边界的情况。
    // 用 passive 避免阻塞滚动。
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [ref, offset]);

  return past;
}

/**
 * 哨兵元素进入视口多少像素时开始预取下一页。
 *
 * 早于真实可见(用户还没滚到底)是为了让下一批图片的解码与网络请求
 * 在他滚过去之前就完成 —— 滚到底时才发现「在加载」是最明显的卡顿来源。
 * 800px 约等于两行卡片, 足够覆盖滚动惯性, 又不会在首屏就把 2~3 页
 * 全拉下来(那等于没分页)。
 */
const PREFETCH_MARGIN = 800;

/**
 * 拖动多少像素才算"框选"而不是"点击"。
 *
 * 浏览器把手指/鼠标的轻微抖动也算位移, 没有阈值的话, 想点一张卡片
 * 就可能顺手圈进隔壁几张。5px 是常见的经验值: 明显小于人的有意拖动,
 * 又明显大于手抖。
 */
const MARQUEE_THRESHOLD = 5;

/**
 * 单次批量删除请求送多少个 id。
 *
 * 必须 <= 后端 MAX_BATCH_DELETE(200)。前端切片而不是让后端放宽上限, 是
 * 因为那个上限的作用是"一次请求不能把整个 outputs/ 删空" —— 放宽它等于
 * 取消这道护栏; 而分片后在用户那边没有区别: 一次点击照样删掉全部选中,
 * 只是内部走了几个请求。
 */
const MAX_BATCH_CHUNK = 200;

export function GalleryPage() {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  /** 首屏/换筛选条件的整页加载 —— 此时列表要清空, 与「加载更多」区分开。 */
  const [loading, setLoading] = useState(true);
  /** 追加下一页。列表已有内容, 不能整页替换, 也不能显示「加载中」空态。 */
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // 筛选条件。**由后端过滤**(见 backend/routes/gallery.py 的 gallery()),
  // 前端只负责把输入传下去 —— 这样 ?q=xx 是一个可复现的链接, 而不是
  // 只在这一次的内存里生效的临时状态。
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [tags, setTags] = useState<TagCount[]>([]);
  /**
   * 灯箱打开的记录(job_id + 第几张)。
   *
   * 与 editingId 分开两个 state, 而不是复用一个"弹层类型"字段: 两者能
   * 同时为真(灯箱里开着重新编辑, 而 AlbumEditor 在下面还开着), 分开表达
   * 就不必写"互斥优先级"这种一旦漏改就出错的规则。
   */
  const [lightbox, setLightbox] = useState<{ jobId: string; index: number } | null>(
    null,
  );

  /**
   * 批量选择。
   *
   * 用 Set 而不是数组: 选中/取消是 O(1) 的「有没有这条」判断, 而
   * 每渲染一张卡片都要问一次「它选中了没」。数组在几十条规模下也够用,
   * 但 Set 让「全选本页」的批量写入与去重都变成一行。
   *
   * 刻意用 **Set 而不是 Record<id, true>**: 前者天然去重,
   * 后者要先判断 `if (!(id in sel))` 再写。
   */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /**
   * 是否处于多选模式。**与 selected 分开两个 state**, 不能用
   * `selected.size > 0` 代替。
   *
   * 分开的理由: 卡片点击的处理函数要看「现在是不是多选模式」来决定
   * 是切换选中还是打开编辑抽屉, 而"选中了 0 条"的多选模式是真实存在的
   * 状态 —— 用户刚点「多选」还没勾任何东西。如果用 selected.size>0 判断,
   * 那个状态下点卡片会走"打开抽屉"分支, 于是**用户永远无法只选一条**:
   * 要么全选, 要么进不去。早先就是这么写的, 被端到端脚本抓到。
   */
  const [selectMode, setSelectMode] = useState(false);

  /**
   * Shift 范围选的锚点(items 里的下标)。
   *
   * 记下标而不是 job_id: 范围选要在 items 顺序上取区间, 存id
   * 还得每次反查下标。
   *
   * 声明在这里而不是「批量选择」那节, 因为 applyQuery(第 140 行左右)
   * 也要清它 —— 而 const 有 TDZ, 定义在 applyQuery 之后会在首帧报错。
   * 位置跟着 selectMode 走, 语义上也更顺: 它们都是"多选模式的状态"。
   *
   * 为什么可能为 null: 用户可能先零散勾了几条(此时没有起点),
   * 然后才按住 Shift 点第一张。此时把那一张当作锚点更符合直觉 ——
   * 资源管理器与 Finder 都是这个行为。
   */
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);

  /**
   * 拖动框选的几何。null = 当前没在框选。
   *
   * 存"起点 + 当前点"而不是存算好的 rect: 起点固定、当前点变, 于是
   * 每次 pointermove 只 setState 一个新对象, 矩形由两者算出。
   */
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null);

  /**
   * 框选是否已越过"这是框选而不是点击"的阈值。
   *
   * 从卡片上按下时不能立即框选 —— 那个手势本来就该响应点击
   * (打开编辑器 / 切换勾选)。越过阈值(5px)之后才接管为框选,
   * 并吞掉随后那一次 click。
   *
   * 必须用 ref 而不是 state: 它要在 pointerdown/click 里**同步**读到,
   * 而 state 更新要等下一次渲染 —— 那时 click 已经发生了。
   */
  const marqueeActiveRef = useRef(false);

  /**
   * 框选几何的同步副本。
   *
   * state 版本(marquee)只用于渲染选框; 而 pointerup 必须在同一次
   * 事件处理里读到最终位置, 那时 state 还没提交。两者并存:
   * **state 管显示, ref 管时序**。
   */
  const marqueeBoxRef = useRef<MarqueeBox | null>(null);

  /**
   * 按下时的起点。
   *
   * 与 marqueeBoxRef 分开: 前者是"框选几何"(阈值后才存在), 这个是
   * "手势起点"(按下就存在)。分开才能在阈值前不画选框, 同时仍然
   * 知道位移是从哪算的。
   */
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);

  /**
   * "刚刚这一手势是框选" —— 用来吞掉随后那一次 click。
   *
   * 为什么不能直接读 marqueeActiveRef: 它在 pointerup 里就被清成 false
   * 了, 而 click 在 pointerup **之后**才派发 —— 时序上根本读不到。
   * 第一版就是这么写的, 结果是框选完总会顺带弹出某张卡的编辑器。
   *
   * 生命周期: pointerup 置位 → click 读后清空 → 下一次 pointerdown 兜底重置。
   */
  const justMarqueedRef = useRef(false);
  /**
   * 批量删除确认弹窗是否打开。
   *
   * 早先这里的状态叫「删除确认的第二段」—— 语义是"顶栏按钮已经变成危险态,
   * 再点一下就真删"。现在**删除确认已经搬到弹窗里**, 这个状态退化成
   * "弹窗开着没", 所以改名 confirmDelete -> 保留原名以减少 diff, 但注释
   * 必须跟上, 否则下一个读代码的人会去找那个已经不存在的"变色的按钮"。
   */
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [batchPending, setBatchPending] = useState(false);
  /** 批量删除的部分失败提示(如文件被占用)。空字符串 = 无。 */
  const [batchNote, setBatchNote] = useState("");
  /** 回收站抽屉是否打开 */
  const [trashOpen, setTrashOpen] = useState(false);

  const editing = items.find((it) => it.job_id === editingId) ?? null;
  const lightboxItem = items.find((it) => it.job_id === lightbox?.jobId) ?? null;

  /**
   * 正在加载下一页的**同步**标记。
   *
   * 为什么不能用 loadingMore 这个 state: IntersectionObserver 的回调
   * 在两次 render 之间可能触发多次(尤其首屏 items 很少、哨兵一直可见时),
   * 而 setState 是异步的 —— 在 state 生效前连着触发两次就会发出两个相同
   * offset 的请求, 后到的覆盖先到的, 表现为「列表卡在 24 条不动」。
   * ref 的读写同步生效, 是这里唯一正确的判据。
   */
  const loadingMoreRef = useRef(false);
  /** 当前筛选条件的"代"。用于丢弃过期的 loadMore 响应。 */
  const queryRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  /**
   * 改筛选条件的**唯一入口**。
   *
   * 把三处状态重置都收在这里, 而不是放进下面那个 useEffect:
   *
   *  1. loadingMoreRef / loadingMore —— 正在飞的那趟 loadMore 带的是旧
   *     offset, 必须作废。不复位的话后果是**永久性**的: loadMore 的 finally
   *     里有 `gen === queryRef.current` 守卫, 旧请求回来时 gen 已不匹配,
   *     那句 `loadingMoreRef.current = false` 就不会执行 —— ref 永远卡在
   *     true, 之后每次 loadMore 都在第一行 return。表现是「搜索一次之后,
   *     加载更多再也点不动也滚不动」。
   *  2. selected —— 不清会出现危险的组合: 用户在「全部」下选了 5 条,
   *     改搜「旅行」, 屏幕上是子集而按钮写着「删除选中的 5 条」, 其中 4 条
   *     他此刻根本看不见, 点下去就删了。
   *  3. confirmDelete —— 换筛选后确认框上的数字必须失效。
   *
   * 为什么不在 effect 里重置: effect body 里同步调 setState 会引发级联
   * 渲染(react-hooks/set-state-in-effect 会警告), 而且 StrictMode 下
   * effect 会跑两次, 纯重置逻辑放在那里是多余的。这些状态本来就只由
   * 「用户改筛选」这一个动作触发, 放在事件处理器里语义更直白。
   */
  const applyQuery = useCallback((nextQ: string, nextTag: string) => {
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setSelected(new Set());
    // anchorIndex 同样要清: 它是 items 顺序里的下标, 而改筛选会换掉
    // 整个 items。留着旧下标, 之后 Shift+点击算出的区间会落在
    // 无关的条目上 —— 而且这种错没有任何报错, 只是"选出来的东西不对"。
    setAnchorIndex(null);
    setConfirmDelete(false);
    setBatchNote("");
    setQ(nextQ);
    setTag(nextTag);
  }, []);

  // q / tag 变了就重新拉第一页。取消守卫防的是「快速连续输入时, 早先发出的请求
  // 后到达, 把后发的结果覆盖掉」—— 这不是理论问题, 本机几十条数据时
  // 两个请求的间隔可能只有几毫秒。
  useEffect(() => {
    const gen = ++queryRef.current;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const g = await fetchGallery(q, tag, PAGE_SIZE, 0);
        if (cancelled || gen !== queryRef.current) return;
        setItems(g.items);
        setTotal(g.total);
        setHasMore(g.has_more);
        setTags(g.tags ?? []);
        setError(null);
      } catch (e) {
        if (cancelled || gen !== queryRef.current) return;
        setError((e as Error).message ?? String(e));
      } finally {
        if (!cancelled && gen === queryRef.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [q, tag]);

  /**
   * 加载下一页并**追加**。
   *
   * 三个容易写错的地方, 都在下面注掉了: 过期响应、按 job_id 去重、
   * 以及 loadingMoreRef 的同步判重。
   */
  const loadMore = useCallback(async () => {
    // 同步判重, 见 loadingMoreRef 的注释
    if (loadingMoreRef.current) return;
    const gen = queryRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const g = await fetchGallery(q, tag, PAGE_SIZE, items.length);
      // 筛选条件在这趟请求途中变了 → 这次的结果属于旧查询, 丢掉。
      if (gen !== queryRef.current) return;
      setItems((prev) => {
        /**
         * 按 job_id 去重。
         *
         * 为什么需要: offset 分页在「两次请求之间列表发生变化」时会漏/重。
         * 具体场景 —— 用户在第 1 页加载完的瞬间又拍了一组, 新 job 的 mtime
         * 最大、排在最前, 于是第 2 页的第一条变成了原来第 1 页的第一条,
         * 前端把它再追加一次, 界面上出现两张一样的卡片。
         *
         * 这是 offset 分页的固有代价(见 api.ts 的注释), 单机自用规模下
         * 不值得上 cursor 分页; 但**去重必须做** —— 重复卡片比少一条更刺眼,
         * 而且 React 的 key 会重复报警并可能错位复用 DOM。
         */
        const seen = new Set(prev.map((it) => it.job_id));
        return [...prev, ...g.items.filter((it) => !seen.has(it.job_id))];
      });
      setTotal(g.total);
      setHasMore(g.has_more);
      setError(null);
    } catch (e) {
      if (gen !== queryRef.current) return;
      setError((e as Error).message ?? String(e));
    } finally {
      if (gen === queryRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [q, tag, items.length]);

  /**
   * 哨兵观察器。滚到底部附近自动 loadMore。
   *
   * 依赖里带上 hasMore/loadingMore 是为了在「没有更多了」时**不再观察** ——
   * 继续 observe 一个始终可见的哨兵只会反复触发回调。
   * 这不是性能问题而是正确性问题: hasMore=false 后 loadMore 会一直
   * 发空请求。
   */
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading || error) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: `${PREFETCH_MARGIN}px 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, hasMore, loading, error]);

  // 编辑/删除后按**当前筛选条件**重拉第一页, 而不是无条件全量 —— 否则在筛选状态下
  // 保存一条, 列表会突然变回全量, 用户刚找到的那条记录"消失"了。
  //
  // 重拉第一页而非"重拉当前页": 排序是 favorite 优先, 改一个 favorite 会让
  // 这条从第 3 页跳到第 1 页, 停在原来的 offset 上会漏掉它。列表短, 重拉代价低。
  const reload = useCallback(async () => {
    try {
      const g = await fetchGallery(q, tag, PAGE_SIZE, 0);
      setItems(g.items);
      setTotal(g.total);
      setHasMore(g.has_more);
      setTags(g.tags ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message ?? String(e));
    }
  }, [q, tag]);

  async function handleSave(jobId: string, patch: Partial<GalleryItem>) {
    // 把 GalleryItem 上的额外字段(title/note/tags/favorite)提取出来
    const { title, note, tags, favorite } = patch;
    await patchAlbum(jobId, { title, note, tags, favorite });
    await reload();
  }

  async function handleDelete(jobId: string) {
    await deleteAlbum(jobId);
    await reload();
  }

  // ---- 批量选择 --------------------------------------------------------
  /**
   * 勾选切换的纯逻辑在 selection.ts 的 toggleSelectedId 里, 这里只提供
   * 列表边界(items 展开成 id 数组)与状态写入。
   *
   * 传入 jobIds 而不是让纯函数自己信任调用: 它要靠这个列表拒绝未知 id,
   * 防止界面外的不存在 id 混进批量删除请求(见 toggleSelectedId 注释)。
   */
  const toggleSelect = useCallback(
    (jobId: string) => {
      setSelected((prev) =>
        toggleSelectedId(prev, jobId, items.map((it) => it.job_id)),
      );
      // 换一条就退出确认态: 确认框上的数字必须与当前选中集一致,
      // 否则用户会对着「确认删除 5 条」点下去, 结果删掉的是另一批。
      setConfirmDelete(false);
    },
    [items],
  );

  /**
   * 卡片点击统一入口。按住 Shift 时是"范围选"而不是"切换勾选"。
   *
   * 范围 = anchor 到当前之间的**闭区间**, 且会**替换**(不是追加)整个
   * 选中集。替换而非追加是关键: Shift+点击的语义是"我要这一段",
   * 之前零散勾的别的条目不该混进来, 否则会出现"看着没选却要一起删"。
   */
  const handleCardClick = useCallback(
    (jobId: string, index: number, shiftKey: boolean) => {
      if (shiftKey) {
        // 区间计算(闭区间 + 越界夹逼 + 无锚点时自锚)在 selectRangeIds 里。
        const ids = selectRangeIds(
          items.map((it) => it.job_id),
          anchorIndex,
          index,
        );
        setSelected(new Set(ids));
        setConfirmDelete(false);
        return;
      }
      setAnchorIndex(index);
      toggleSelect(jobId);
    },
    [anchorIndex, items, toggleSelect],
  );

  /** 全选/取消全选当前**已加载**的条目。 */
  const toggleSelectAllLoaded = useCallback(() => {
    setSelected((prev) => selectAllOrClear(prev, items.map((it) => it.job_id)));
    setConfirmDelete(false);
  }, [items]);

  /**
   * 框选: 与选框相交即命中。
   *
   * 本函数只负责**从 DOM 量测**(querySelectorAll + getBoundingClientRect),
   * 判定本身在 selection.ts 的 collectMarqueeHits 里。
   *
   * 分工的原因: 量测必须在组件里(getBoundingClientRect 依赖布局),
   * 但"什么算相交""零尺寸算不算"这些是纯几何规则, 写在组件里就只能靠
   * 手动拖框来验证。抽出去之后它们被逐条断言, 见
   * verify-gallery-selection.mjs。
   *
   * 用元素实时量测, 不缓存位置: 无限滚动会增删卡片、窗口会缩放,
   * 缓存必然过期。
   */
  const collectMarqueeHits = useCallback((box: MarqueeBox): string[] => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>("[data-gallery-card]"),
    );
    const measures: CardMeasure[] = [];
    for (const el of nodes) {
      const id = el.getAttribute("data-gallery-card");
      if (!id) continue;
      const r = el.getBoundingClientRect();
      measures.push({
        id,
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      });
    }
    return collectHits(box, measures);
  }, []);

  /**
   * 网格空白处按下: 准备开始框选。
   *
   * 绑在**网格容器**而不是 window: 只关心落在网格内的按下,
   * 免得用户拖到工具栏上时也画出选框。
   */
  const handleGridPointerDown = useCallback((e: React.PointerEvent) => {
    // 只响应鼠标主键: 右键/中键可能有别的语义(右键菜单等)
    if (e.button !== 0) return;
    /**
     * 允许从**网格之外的页面空白**起拖。
     *
     * 早先只把 onPointerDown 绑在网格容器上, 于是网格左侧的 24px 内边距
     * (max-w-7xl mx-auto px-6)、以及卡片之间的 gap 都不响应。用户滚动到
     * 下面后很自然地从左边空白处起拖 —— 那个位置命中的是
     * `DIV < MAIN`, pointerdown 压根到不了网格, 框选静默失败。
     *
     * 表现是"框选没反应"而不是报错, 极难自查。
     *
     * 做法: 在页面容器上监听 pointerdown, 只排除**真正的交互控件**。
     *
     * 注意 `button` 必须**排除在判断之外再单独处理**: 卡片主体本身就是
     * `<button>`, 若一律 `closest("button")` 就 return, 等于把"从卡片上
     * 起拖"这条最自然的路径又堵回去了(第一版就是这么坏的)。
     * 所以判据是"这个 button 是不是卡片":
     *   - 是卡片 -> 允许(按下只记起点, 由 pointermove 决定是否接管)
     *   - 是别的按钮(工具栏/筛选条/浮动条) -> 忽略
     */
    const t = e.target as HTMLElement | null;
    if (t?.closest("input, textarea, select, a, [role=dialog]")) return;
    const btn = t?.closest("button");
    if (btn && !btn.closest("[data-gallery-card]")) return;
    marqueeActiveRef.current = false;
    marqueeBoxRef.current = null;
    justMarqueedRef.current = false;
    pointerStartRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleGridPointerMove = useCallback((e: React.PointerEvent) => {
    const start = pointerStartRef.current;
    if (!start) return;
    const moved = didExceedMarqueeThreshold(
      start,
      { x: e.clientX, y: e.clientY },
      MARQUEE_THRESHOLD,
    );
    // 阈值前**完全不改状态**(连选框都不画): 那时用户以为自己是在点击,
    // 突然冒出矩形会很突兀。越过阈值才接管。
    if (!moved && !marqueeBoxRef.current) return;
    marqueeActiveRef.current = moved;
    const box: MarqueeBox = {
      x0: start.x,
      y0: start.y,
      x1: e.clientX,
      y1: e.clientY,
    };
    marqueeBoxRef.current = box;
    setMarquee(box);
  }, []);

  /**
   * 框选结束。
   *
   * **刻意不用 setMarquee 的 updater 做这件事**(那里只能拿到 prev)。
   * 改成用 ref 持有框选几何: pointermove 里写 ref, pointerup 直接读 ——
   * 这样"读几何"和"改选中集"是两步普通代码, 而不是在状态 updater 里
   * 调setSelected/setSelectMode。
   *
   * 后者是被明确禁止的: React 会用两次调用来探测 updater 是否 impure
   * (StrictMode), 于是里面的 setSelected 会被调两次, 每次基于不同的
   * prev, 结果依赖调用顺序。同样的坑在 toggleSelectMode 处已经踩过一次。
   */
  const handleGridPointerUp = useCallback(
    // 参数不再需要: 移除了 setPointerCapture 之后, pointerup 里已经没有
    // 指针相关的操作了。保留事件参数只为签名完整, 所以按项目约定加下划线。
    (_e: React.PointerEvent) => {
      // **先读出来再清**: box 是本次手势的最终几何, 下面要拿它做命中测试。
      const box = marqueeBoxRef.current;
      const wasActive = marqueeActiveRef.current;
      marqueeBoxRef.current = null;
      marqueeActiveRef.current = false;
      pointerStartRef.current = null;
      setMarquee(null);
      // 不需要 releasePointerCapture: pointerdown 处没有 capture 过。
      // **不要在这里清justMarqueed**: click 在 pointerup 之后才派发,
      // 由handleGridClickCapture 读完再清。同一手势的 pointerdown 会先把它置回 false。
      justMarqueedRef.current = wasActive;
      if (!box || !wasActive) return;

      const hits = collectMarqueeHits(box);
      if (hits.length === 0) return;
      // 框选即进入多选, 并把选中集**替换**为框到的那些 ——
      // 与 Shift+点击一致的语义: "我圈的就是我要的"。
      setSelectMode(true);
      setSelected(new Set(hits));
      setConfirmDelete(false);
      // 锚点取第一个命中项的**真实索引**, 这样紧接着 Shift+点某张,
      // 区间是从框选起点算的, 而不是从 0 算。
      const first = items.findIndex((it) => it.job_id === hits[0]);
      setAnchorIndex(first >= 0 ? first : null);
    },
    [collectMarqueeHits, items],
  );

  /**
   * 框选结束后那一次 click 必须被吞掉, 否则会顺带打开某张卡的编辑器
   * 或切换掉某张卡的勾选 —— 表现为"框选完突然弹出一个抽屉"。
   *
   * 用 capture 阶段在容器上拦, 而不是给每张卡加判断: 这样新增卡片时
   * 不需要记得补逻辑。
   */
  const handleGridClickCapture = useCallback((e: React.MouseEvent) => {
    if (justMarqueedRef.current) {
      // 读完立刻清: 只吞这一次 click, 不能让后续正常点击全部失效。
      justMarqueedRef.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, []);

  /**
   * 进入/退出多选模式。
   *
   * 依赖 selectMode 而非用 updater 里再 setSelected: 在 setSelectMode 的
   * updater 内部调另一个 setState 是把副作用写进了"纯状态计算"里 ——
   * React 会调用 updater 两次以探测 impurity(StrictMode 下), 嵌套的
   * setSelected 于是被调用两次, 每次都基于不同的 prev, 结果依赖调用顺序。
   * 这里改成读当前 selectMode 的普通分支, 行为确定且可读。
   */
  const toggleSelectMode = useCallback(() => {
    if (selectMode) {
      setSelected(new Set());
      // 退出时必须清锚点: 它存的是**旧 items 顺序里的索引**。
      // 留着的话, 下次进入多选后第一次 Shift+点击会用过期锚点算区间,
      // 选出的一大片与用户点的那张毫无关系。
      setAnchorIndex(null);
    }
    setSelectMode(!selectMode);
    setConfirmDelete(false);
    setBatchNote("");
  }, [selectMode]);

  /**
   * 删完之后退出多选模式。
   *
   * 全部成功时才退: 部分失败时留在多选里, 让用户能直接重试
   * (失败的那些还保持选中, 见 handleBatchDelete 里的注释)。
   */
  function leaveSelectModeAfterDelete() {
    setSelectMode(false);
    setSelected(new Set());
    setConfirmDelete(false);
  }

  /**
   * 主动退出多选模式, 并清掉选中集与锚点。
   *
   * 语义与顶栏的「退出多选」(`toggleSelectMode` 的退出分支)保持一致 ——
   * 同样是退出多选, 浮动条上的 ✕ 不该有一套不同的清理规则。
   * 两处行为分叉比"多写一个函数"危险得多: 用户在顶部退出和在底部退出
   * 得到的不同状态, 没法形成稳定预期。
   */
  function leaveSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
    // 锚点存的是**旧 items 顺序里的索引**, 必须清。
    setAnchorIndex(null);
    setConfirmDelete(false);
  }

  async function handleBatchDelete() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setBatchPending(true);
    setBatchNote("");
    /**
     * 聚合多次请求的结果, 而不是只看最后一次。
     *
     * 为什么要分块: 后端 MAX_BATCH_DELETE = 200 是防"一次请求把整个
     * outputs/ 删空"的护栏。而"全选已加载的 N 条"在库变大后必然能超过它
     * (本机已经 222 个 job) —— 那时后端会返回 400, 表现为「全选后一点
     * 删除就报错, 一条也删不掉」。所以前端按上限切片, 串行发多次。
     *
     * 刻意**串行**而不是 Promise.all: 并发发 5 个删 200 条的请求会让
     * 后端同时跑 5 次 rmtree, 磁盘 IO 争抢反而更慢, 且进度提示无法
     * 反映真实完成度。
     */
    const agg = {
      deleted: [] as string[],
      missing: [] as string[],
      failed: [] as { job_id: string; error: string }[],
    };
    try {
      for (let i = 0; i < ids.length; i += MAX_BATCH_CHUNK) {
        const chunk = ids.slice(i, i + MAX_BATCH_CHUNK);
        const res = await batchDeleteAlbums(chunk);
        agg.deleted.push(...res.deleted);
        agg.missing.push(...res.missing);
        agg.failed.push(...res.failed);
      }
      await reload();
      /**
       * 成功与失败要分开处理。
       *
       * 后端不做整体回滚(见 gallery_batch_delete 的 docstring), 所以
       * `failed` 非空时列表里**仍然有**没删掉的条目 —— 此时清空选择会
       * 让用户丢掉重试的抓手, 所以只从选择集里摘掉真正删掉的,
       * 剩下的(通常是 failed)继续保持选中, 可以直接再点一次删除。
       */
      if (agg.failed.length > 0) {
        const stillThere = new Set(ids);
        for (const id of agg.deleted) stillThere.delete(id);
        for (const id of agg.missing) stillThere.delete(id);
        setSelected(stillThere);
        setBatchNote(
          `已移到回收站 ${agg.deleted.length} 条, ${agg.failed.length} 条失败(文件可能被占用)。已为你保留选中, 可重试。`,
        );
      } else {
        leaveSelectModeAfterDelete();
        // 提示里必须点名"回收站"和期限: 用户删完如果不知道可以去哪儿找回,
        // 就等于没有回收站。措辞也刻意不用"已删" —— 那会让他以为不可逆。
        setBatchNote(
          agg.missing.length > 0
            ? `已移到回收站 ${agg.deleted.length} 条(${RETENTION_DAYS} 天内可恢复), 另有 ${agg.missing.length} 条本就不存在。`
            : `已移到回收站 ${agg.deleted.length} 条, ${RETENTION_DAYS} 天内可从回收站恢复。`,
        );
      }
    } catch (e) {
      setBatchNote(`批量删除失败:${(e as Error).message ?? String(e)}`);
    } finally {
      setBatchPending(false);
      /**
       * 无论成败都关掉弹窗。
       *
       * 部分失败时 `selected` 还留着未删掉的条目, 若弹窗条件只绑
       * selected.size, 它会**继续开着** —— 而此时页面下方已经出现了
       * batchNote 提示, 弹窗挡着它, 用户既看不到"哪几条没删"也看不到
       * 重试入口。
       */
      setConfirmDelete(false);
    }
  }

  const selecting = selectMode;

  /**
   * 把视图滚回第一个选中的卡片。
   *
   * ## 为什么需要它
   *
   * 浮动条解决了"按钮看不见", 但引出一个新问题: 用户滚到第 50 张卡附近
   * 才框选, 此时**被选中的那批卡在视口上方**。于是浮动条变成一根与选中项
   * 毫无关系的孤立条子 —— 用户看得到"已选 3 条", 却看不到是哪 3 条。
   *
   * 那个危险组合又回来了: 数量可见、对象不可见。这正是 §8.8 里
   * `applyQuery` 要清 selected 所避免的情形, 只是这次发生在**滚动**上。
   *
   * 所以给浮动条一个"回到选中"入口: 一键让选中项重新进入视野。
   * 做成**显式按钮**而不是自动滚动 —— 自动滚会在用户正浏览别处时突然
   * 把视口拽走, 比"看不到"更让人失去方向感。
   */
  const scrollToFirstSelected = useCallback(() => {
    const first = selected.values().next();
    if (first.done) return;
    const el = document.querySelector<HTMLElement>(
      `[data-gallery-card="${CSS.escape(first.value)}"]`,
    );
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [selected]);

  /** 顶部工具栏的 ref。滚出视口后由吸底浮动条接管, 见 useScrolledPast。 */
  const toolbarRef = useRef<HTMLDivElement>(null);
  const scrolledPast = useScrolledPast(toolbarRef);

  /**
   * 选中态的全部操作。**只渲染在顶部控制条里** —— 吸底浮动条有自己的一套
   * 精简 JSX(见渲染处注释), 两处共享 state 但取舍不同。
   *
   * ## 为什么不复用同一个节点对象
   *
   * 早先这里写的是"两处渲染同一个 React 节点对象, 所以天然一致"。合并
   * 顶部布局后浮动条改成了独立精简版, 那条说法已经不成立了, 留着会误导
   * 下一个读代码的人以为改一处会同时改两处。真正保证数字一致的是
   * `selected` / `items.length` 这同一份 state, 而不是 JSX 复用。
   *
   * ## 为什么每个按钮都要 shrink-0 + whitespace-nowrap
   *
   * 控制条是 `flex`, 空间不够时 flex 子项默认会被压缩, 于是中文被压成
   * 竖排("全选已加载的 144 条"变成两列竖字), 看起来像渲染错误。
   *
   * `whitespace-nowrap` 禁止换行, `shrink-0` 禁止压缩; 空间真的不够时
   * 由父容器的 `flex-wrap` 整项换行 —— 换行是可读的, 竖排不是。
   */
  const selectionActions = (
    <>
      <button
        type="button"
        onClick={toggleSelectAllLoaded}
        data-gallery-select-all=""
        className="shrink-0 whitespace-nowrap px-2.5 py-1.5 rounded-full text-xs border
                   border-pink bg-white text-brown hover:border-brick"
      >
        {selected.size === items.length && items.length > 0
          ? "取消全选"
          : `全选已加载的 ${items.length} 条`}
      </button>
      <span
        className="shrink-0 whitespace-nowrap text-xs text-brown/70"
        data-gallery-selected-count=""
      >
        已选 {selected.size} 条
      </span>
      {/*
        删除入口只负责"**打开弹窗**", 不再有第二段按钮。
        原来的两段式是就地换按钮, 而按钮常在视口之外 ——
        他刚框完选时眼睛还在卡片区, 按钮换个颜色多半没进视野,
        于是"点了没反应"被读成界面坏了。见 ConfirmDialog 的注释。

        未选中时用一句提示占位而不是留空: 空按钮会让用户以为这里本该有
        东西从而去找, 一句"勾选卡片后可批量删除"直接告诉他们下一步。
      */}
      {selected.size === 0 ? (
        <span className="shrink-0 whitespace-nowrap text-xs text-brown/50">
          勾选卡片后可批量删除
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          data-gallery-batch-delete=""
          disabled={batchPending}
          className="shrink-0 whitespace-nowrap px-2.5 py-1.5 rounded-full text-xs
                     text-red-500 border border-red-300 hover:bg-red-50
                     disabled:opacity-40"
        >
          删除选中的 {selected.size} 条
        </button>
      )}
    </>
  );

  return (
    /*
     * pointer 事件绑在**页面容器**而不是网格上: 网格有 px-6 内边距和 gap,
     * 从那些空白处起拖收不到 pointerdown, 框选静默失败。详见
     * handleGridPointerDown 的注释。
     *
     * 用 capture 在**捕获阶段**就记起点: 若等冒泡, 某些子元素可能
     * stopPropagation 掉。clickCapture 同理, 且必须先于卡片的 onClick。
     */
    <div
      className="max-w-7xl mx-auto px-6 pt-4 pb-28"
      onPointerDown={handleGridPointerDown}
      onPointerMove={handleGridPointerMove}
      onPointerUp={handleGridPointerUp}
      onPointerCancel={handleGridPointerUp}
      onClickCapture={handleGridClickCapture}
    >
      {trashOpen && (
        <TrashPanel
          onClose={() => setTrashOpen(false)}
          onRestored={() => void reload()}
        />
      )}

      {/*
        顶部控制条。**把原来的三块合成一块**。

        ## 为什么要合并

        合并前顶部是四个纵向堆叠的独立区块: 标题行、多选条、搜索框+标签、
        以及各自的 mb-4/mb-3。逐项量下来的固定开销:

        | 区块                     | 内容高度 | 外边距 |
        |--------------------------|----------|--------|
        | 标题行                   | ~32px    | mb-4   |
        | 多选条(常驻, 多为单按钮) | ~30px    | mb-3   |
        | 搜索框                   | ~38px    | —      |
        | 标签条(可换行, 1~3 行)   | 24~72px  | mb-4   |

        合计约 190~250px。而这个页面的网格是 `grid-cols-2 md:3 lg:4`,
        一屏最多 4 行卡片 —— 顶部吃掉 200px 意味着**首屏几乎看不到照片**,
        用户每次进来都要先滚一次。

        ## 合并后的结构

        - **第一行(常驻)**: 标题 · 计数 · 搜索框(自适应伸展) · 批量操作(仅多选时) ·
          多选开关 · 回收站。用 `flex-wrap` + `shrink-0`, 空间不够时优雅换行而不是压扁。
        - **第二行(仅标签存在时)**: 标签条横向滚动, 永远单行。

        固定开销降到 ~76px(有标签)/ ~38px(无标签), 且**不再随标签数量增长**。

        ## 为什么标题从 text-2xl 降到 text-lg

        它是页面唯一的 h1, 但这一屏的主角是照片而不是标题。text-2xl 的
        Press Start 2P 单行就吃掉 32px, 而标题信息量只有一个词 ——
        换成 text-lg 视觉层级依然明确, 省下的 10px 留给卡片。

        ref 交给 useScrolledPast: 整条控制区滚出视口后, 下面那枚吸底浮动条
        接管, 所以用户滚到哪都能操作选中项。
      */}
      <div ref={toolbarRef} className="mb-2">
        {/*
          控制条本体。

          ## 为什么窄屏要用 basis-full 而不是让 flex-wrap 随便换行

          第一版直接写 `flex-wrap`, 桌面端(1280px)确实压成了一行, 但在
          420px 窄屏下量出来是**三行**: 标题+计数 / 搜索+多选 / 回收站。
          换行本身不算 bug, 问题在于最后那个「回收站」**孤零零独占一行**
          —— 它只有三个字, 却占了整行 30px 还左对齐, 看起来像布局出错。

          根因是 flex-wrap 的换行位置由"剩余空间"决定, 而**不由控件的重要
          性决定**。窄屏放不下时, 它会把最后一个按钮甩到下一行, 恰好甩掉的
          是最不该独占一行的那个。

          现在改成:
          - 搜索框 `max-sm:basis-full` —— 窄屏时它独占一整行。这是对的:
            输入框本来就该是整行宽的, 挤成 140px 只能显示 4 个字, 占位
            文字「搜索标题 / 备注 / 标签 / 编号」被截成「搜索标题 / 备注 / 标」。
          - 按钮组 `max-sm:ml-auto` —— 窄屏时两个按钮靠右并排, 不会失衡。

          换行后的窄屏形态是两行(搜索一行 + 标题计数按钮一行), 比三行少
          30px, 且没有孤行元素。
        */}
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-pixel text-lg text-brick shrink-0">贴纸册</h1>

          {/*
            计数。分页后 items.length 只是"已加载", 不是总数 ——
            显示 24 而实际有 223, 用户会以为剩下的丢了。
            「收藏置顶」降级成 title 提示: 它解释的是**排序规则**而不是
            当前状态, 属于"想知道才需要"的信息, 不该常驻占宽度。
          */}
          <span
            data-gallery-count=""
            title="收藏的照片排在最前"
            className="shrink-0 whitespace-nowrap text-[11px] text-brown/60"
          >
            {hasMore || items.length < total
              ? `已加载 ${items.length} / 共 ${total} 条`
              : `${total} 条`}
          </span>

          {/*
            搜索框。

            `flex-1 min-w-[7rem]` 而非原来的 `w-full max-w-md`: 合并后它要和
            别人共用一行, 固定 max-w 会在宽屏上留下大片空白, 而 flex-1 让
            它吃掉剩余空间。

            `max-sm:basis-full` 是窄屏专属, 见上方控制条注释。
          */}
          <input
            value={q}
            onChange={(e) => applyQuery(e.target.value, tag)}
            placeholder="搜索标题 / 备注 / 标签 / 编号"
            data-gallery-search=""
            aria-label="搜索贴纸册"
            className="flex-1 min-w-[7rem] max-sm:basis-full px-3 py-1.5
                       rounded-full border border-pink bg-white text-xs"
          />

          {selecting && selectionActions}

          {/*
            多选与回收站包成一组并 `ml-auto` 靠右。

            ## 为什么非要包一层

            不包的话它们是两个独立的 flex 子项, 窄屏换行时各自为战: 实测
            420px 下「多选」留在第一行、「回收站」被甩到第二行独占整行,
            而一个三字按钮占 372px 宽的整行, 左对齐, 看起来像渲染坏了。

            包成组之后, `ml-auto` 把整组推到右侧, 换行时**两个按钮一起
            挪到下一行并排**, 孤行元素消失。`shrink-0` 保证组内按钮
            不被压缩(压缩 = 中文竖排, 之前浮动条踩过这个坑)。
          */}
          <div className="flex shrink-0 items-center gap-2 max-sm:ml-auto">
            {/*
              多选开关。**常驻**而不是进入多选才出现 —— 进入多选的入口就在
              这里; 若隐藏, 用户根本不知道这个功能存在。
            */}
            <button
              type="button"
              onClick={toggleSelectMode}
              data-gallery-select-mode=""
              aria-pressed={selectMode}
              disabled={items.length === 0}
              className={`shrink-0 whitespace-nowrap px-2.5 py-1.5 rounded-full
                          text-xs border
                          ${selectMode
                            ? "bg-brick text-white border-brick"
                            : "bg-white text-brown border-pink hover:border-brick"}
                          disabled:opacity-40`}
            >
              {selectMode ? "退出多选" : "多选"}
            </button>

            {/*
              回收站入口与删除入口同级, 而不是藏在设置或菜单里 ——
              它是删除操作的**另一半**。放在二级菜单里的后果很具体:
              用户删完才发现有回收站, 于是"先不敢删"变成永久的犹豫。
            */}
            <button
              type="button"
              onClick={() => setTrashOpen(true)}
              data-trash-open=""
              className="shrink-0 whitespace-nowrap px-2.5 py-1.5 rounded-full
                         text-xs border border-pink bg-white text-brown
                         hover:border-brick"
            >
              回收站
            </button>
          </div>
        </div>

        {/*
          标签条。条件与原来**完全一致**, 那个"删光标签就再也退不出筛选"
          的死局修正在 GalleryPage 里另有注释, 见下方 applyQuery。

          ## 为什么从 flex-wrap 改成横向滚动

          原来 `flex-wrap` 让高度随标签数量线性增长: 8 个标签就换到第二行,
          顶部再涨 24px, 首屏能看到的卡片又少一行。而标签是**导航**而不是
          **内容** —— 用户只需要"知道有哪些可筛", 不需要一次看完。

          横向滚动(`overflow-x-auto`)把高度钉死在一行, 标签再多也不影响
          首屏。配合 `shrink-0` 保证单个标签不会被压扁, 这是
          FilterStrip / FrameStrip 已在用的范式。

          滚动条的可见性交给浏览器默认值: 隐藏滚动条会让用户不知道
          "右边还有标签", 那比多占 24px 更糟。
        */}
        {(tags.length > 0 || tag !== "") && (
          <div
            className="mt-1.5 flex items-center gap-1.5 overflow-x-auto
                       pb-0.5"
            data-gallery-tags=""
          >
            <button
              type="button"
              onClick={() => applyQuery(q, "")}
              aria-pressed={tag === ""}
              data-gallery-tag=""
              className={`shrink-0 whitespace-nowrap px-2.5 py-0.5
                          rounded-full text-xs border ${
                            tag === "" ? "bg-brick text-white border-brick"
                                       : "bg-cream text-brown border-pink"
                          }`}
            >
              全部
            </button>
            {tags.map((t) => (
              <button
                key={t.tag}
                type="button"
                data-gallery-tag={t.tag}
                onClick={() => applyQuery(q, t.tag === tag ? "" : t.tag)}
                aria-pressed={tag === t.tag}
                className={`shrink-0 whitespace-nowrap px-2.5 py-0.5
                            rounded-full text-xs border ${
                              tag === t.tag
                                ? "bg-brick text-white border-brick"
                                : "bg-cream text-brown border-pink"
                            }`}
              >
                {t.tag} {t.count}
              </button>
            ))}
          </div>
        )}
      </div>

      {/*
        吸底浮动操作条。

        ## 为什么需要它

        顶栏那套操作在文档流里, 页面一滚动就跟着走出视口。用户往下滚、
        框选了一堆照片之后抬头找不到删除按钮, 而**卡上的勾还在** ——
        看上去就像"选上了却没法操作"。这与 §8.16 那次是同一类病:
        **关键操作落在用户视线之外**(那次是"按钮变色看不见")。

        ## 出现时机: 三者同时满足

        1. `selecting` —— 没进多选模式时不占地方。
        2. `selected.size > 0` —— 没选东西时浮动条只是噪声。
        3. `scrolledPast` —— 顶栏**确实滚出视口了**才出现。
           少了第 3 条, 顶部会同时出现两套一模一样的按钮, 用户会以为
           页面重复渲染了。

        ## 为什么要放底部而不是顶部

        用户的注意力在**刚框选的那些卡片**上, 而框选动作发生在视口中部。
        底部是离手指与视线最近的"空白边缘", 不遮挡任何正在看的内容;
        顶部则会被吸顶的导航栏挤到视野角落, 且与顶栏原按钮重叠。

        ## z-40 而不是 z-50

        z-50 是 ConfirmDialog 与 TrashPanel 的层级。浮动条刻意低一级:
        它不该盖住删除确认弹窗, 弹窗弹出后它只是背景里的一块色块。

        ## 与顶部控制条的关系

        两处**不共用 JSX**(早先的注释说共用, 顶部合并后已改成各自的精简版),
        但**共用同一份 state** —— `selected.size` 和 `items.length` 是同一个
        来源, 所以不会出现"顶栏显示已选 12 条、浮动条显示 8 条"这种
        无法自证的分裂状态。同步靠的是 state 而不是节点复用。

        取舍不同是故意的: 顶部要"把选中范围扩大", 浮动条要"把选中的删掉",
        前者需要全选按钮, 后者需要回到选中; 窄屏下两者都塞不下, 只能各取
        最重要的那几项。
      */}
      {selecting && selected.size > 0 && scrolledPast && (
        <div
          data-gallery-floating-bar=""
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40
                     flex flex-nowrap items-center gap-3 px-4 py-2.5 rounded-full
                     bg-cream border border-pink shadow-lg
                     max-w-[calc(100vw-2rem)]"
        >
          {/*
            "全选" 在浮动条里是**次要**的: 用户已经滚到这里了, 他要的是
            "把选中的删掉", 不是"扩大选中范围"。而它恰好是最宽的一项
            (「全选已加载的 144 条」), 于是窄屏下最先把它挤爆。

            窄屏隐藏它(顶栏那一处仍然可用), 而**已选 N 条与删除必须留着**
            —— 那是浮动条存在的全部理由。
            `hidden sm:inline-block` 而不是 CSS 媒体查询写两套: 同一处
            判断, 不会两边不同步。
          */}
          <span className="hidden sm:contents">
            <button
              type="button"
              onClick={toggleSelectAllLoaded}
              data-gallery-floating-select-all=""
              className="shrink-0 whitespace-nowrap px-3 py-1.5 rounded-full text-xs
                         border border-pink bg-white text-brown hover:border-brick"
            >
              {selected.size === items.length && items.length > 0
                ? "取消全选"
                : `全选已加载的 ${items.length} 条`}
            </button>
          </span>
          {/*
            已选数量与删除按钮。**不用 selectionActions** 而是单独写 ——
            因为浮动条需要的是"精简版", 而 selectionActions 是给顶栏的完整版。
            两处共享数字与回调(state 同源), 但取舍不同。
          */}
          <span
            className="shrink-0 whitespace-nowrap text-xs font-medium text-brown"
            data-gallery-floating-count=""
          >
            已选 {selected.size} 条
          </span>
          {/*
            "回到选中"。让用户能重新看见被选中的那几张 —— 没有它,
            浮动条只说明"选了几个", 却不说明"选的是谁"。
            点击后第一张选中项会滚到视口中央。
          */}
          <button
            type="button"
            onClick={scrollToFirstSelected}
            data-gallery-floating-back=""
            className="shrink-0 whitespace-nowrap px-2 py-1.5 rounded-full text-xs
                       text-brown/70 border border-pink/60 hover:text-brick"
            title="回到选中的照片"
          >
            回到选中
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            data-gallery-floating-delete=""
            disabled={batchPending}
            className="shrink-0 whitespace-nowrap px-3 py-1.5 rounded-full text-xs
                       text-white bg-red-500 hover:bg-red-600 disabled:opacity-40"
          >
            删除选中的 {selected.size} 条
          </button>
          {/*
            明确的关闭入口。浮动条挡住了一部分视野, 必须是**一次点击**
            就能让它消失, 而不是"滚回顶部去点退出多选"。
          */}
          <button
            type="button"
            onClick={leaveSelectMode}
            data-gallery-floating-close=""
            className="shrink-0 px-2 py-1 rounded-full text-xs text-brown/70
                       hover:text-brick"
            title="退出多选"
          >
            ✕
          </button>
        </div>
      )}

      {/*
        批量删除确认弹窗。

        `open` 只绑 confirmDelete 与 selected.size: **不能带 batchPending**。
        带了的话请求一发出弹窗就消失, 用户点完确认后看到的是"什么都没发生",
        反而比原来的两段式更没反馈。busy 是弹窗**内部**的 prop ——
        弹窗要留在原地显示「处理中...」, 遮罩继续挡着底层页面。

        selected.size > 0 这个条件让"选中集清空即失效"自动成立:
        框选/Shift/切筛选都会改变它, 不必在每个地方手动 setConfirmDelete(false)
        (漏一处就会出现"对着 20 条点下去, 删掉的是另一批")。
      */}
      <ConfirmDialog
        open={confirmDelete && selected.size > 0}
        title="移到回收站"
        message={`将选中的 ${selected.size} 条照片移入回收站。`}
        hint={`${RETENTION_DAYS} 天内可从回收站恢复, 之后自动永久删除。`}
        confirmLabel="确认移入"
        busy={batchPending}
        onConfirm={() => void handleBatchDelete()}
        onCancel={() => setConfirmDelete(false)}
        testId="batch"
      />

      {batchNote && (
        <div
          data-gallery-batch-note=""
          className="mb-3 text-xs text-brown/70 border border-pink/60 bg-white/60
                     rounded-full px-3 py-1.5"
        >
          {batchNote}
        </div>
      )}

      {loading && items.length === 0 && <div className="text-brown/70">加载中...</div>}
      {/*
        错误提示。**已有内容时必须给重试入口** ——
        哨兵和兜底按钮都因 error 而不渲染, 于是"加载更多失败"会变成
        「剩下的记录再也加载不出来」, 且页面上没有任何按钮能恢复。

        按钮只在 items.length > 0 时出现: 那才是"追加失败"的场景,
        重试语义明确(接着拉下一页)。首屏失败时 items 为空, 用户改一下
        搜索词就会重新触发首屏请求(见 [q, tag] 那个 effect), 自带恢复路径,
        不必在这里堆一个语义含糊的按钮。
      */}
      {error && (
        <div className="text-red-500 text-sm">
          加载失败:{error}
          {items.length > 0 && (
            <button
              type="button"
              onClick={() => void loadMore()}
              data-gallery-retry=""
              className="ml-2 underline"
            >
              重试加载更多
            </button>
          )}
        </div>
      )}
      {!loading && !error && items.length === 0 && (
        <div className="text-brown/70">
          {q || tag ? "没有匹配的记录。" : "还没有拍摄记录。"}
        </div>
      )}

      {/*
        搜索框与标签条已合并进上方控制条(见那里的注释)。
        这里保留它们原先的**设计约束**, 以免将来有人"顺手优化"回去:

        1. 标签条的条件是「有标签可选」**或「当前正按标签筛选」**, 而不只是
           前者。后半个条件修的是一个会困住用户的死局: tags 是首屏加载时算
           出来的, 假设用户正按某个标签筛选, 而这个标签名下的记录被他自己
           批量删光了 —— tags 随之变空, 整条筛选栏消失, 于是「全部」按钮
           也没了, 用户**没有任何办法退出这个筛选**: 搜索框里没有标签可搜,
           页面上也没有取消入口, 只能刷新浏览器。

        2. 搜索框用 `flex-1 min-w-[7rem]` 而不是 `w-full max-w-md`。
      */}

      {/*
        卡片网格。**外层是 div 而不是 button**: 一张卡要能点出两件事 ——
        点卡片主体打开相册编辑(旧行为, verify-album-edit 依赖
        `button.relative`), 点放大镜打开大图灯箱。而 <button> 不能嵌套
        <button>(HTML 非法, 且点击冒泡会让两个动作一起触发)。
        所以卡片主体仍是一个 class 含 relative 的 button(选择器不变),
        放大镜是它的**兄弟**元素, 绝对定位盖在右上角。
      */}
      <div
        data-gallery-grid=""
        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 relative select-none"
      >
        {/*
          框选矩形。**fixed 定位**而不是 absolute: 几何用的是
          clientX/clientY(viewport 坐标), 绝对定位会把它定位到文档里,
          一旦页面滚动就完全错位。fixed 则与视口同步。
          z-30高于卡片(卡片本身没有 z-index), 半透明以便看见下面的内容。
        */}
        {marquee && (() => {
          // 几何用 normalizeMarquee 算, 而不是就地 Math.min/Math.abs:
          // 命中测试那边也用同一个归一化, 两处必须逐位一致 —— 否则会出现
          // "框画在一处, 命中按另一处算" 的错位, 且只在反向拖动时出现。
          const r = normalizeMarquee(marquee);
          return (
            <div
              data-gallery-marquee=""
              aria-hidden="true"
              className="fixed z-30 pointer-events-none border-2 border-brick
                         bg-brick/10 rounded-sm"
              style={{
                left: r.left,
                top: r.top,
                width: r.right - r.left,
                height: r.bottom - r.top,
              }}
            />
          );
        })()}
        {items.map((it, index) => {
          const isSelected = selected.has(it.job_id);
          return (
          <div
            key={it.job_id}
            // 框选的命中测试靠这个属性找元素(collectMarqueeHits)。
            // 它在**外层** div 上而不是内层 button: 命中测试关心的是
            // 整张卡的矩形, 包含选框角标占用的右下角。
            data-gallery-card={it.job_id}
            className={`relative ${selecting ? "ring-2 rounded-xl" : ""}
                        ${isSelected ? "ring-brick" : "ring-transparent"}`}
          >
            <button
              type="button"
              data-job-id={it.job_id}
              onClick={(e) =>
                selecting
                  ? handleCardClick(it.job_id, index, e.shiftKey)
                  : setEditingId(it.job_id)
              }
              aria-pressed={selecting ? isSelected : undefined}
              className="relative w-full bg-white rounded-xl border-2 border-pink p-2 text-left
                         hover:border-brick transition-colors group"
            >
              {/* 收藏徽标:固定左上, 与编辑按钮不重叠 */}
              {it.favorite && (
                <span className="absolute top-1 left-1 z-10 bg-brick text-white text-[10px] px-1.5 py-0.5 rounded-full">
                  ★
                </span>
              )}
              {/*
                选择框。放在**右下**而不是左上: 左上已经被收藏徽标占了,
                两者都是"状态指示", 叠在一起会同时消失。
                右下在卡片上是空的(tags 只在有标签时渲染一行, 且不占满)。
              */}
              {selecting && (
                <span
                  data-gallery-check={it.job_id}
                  aria-hidden="true"
                  className={`absolute bottom-1 right-1 z-10 w-5 h-5 rounded
                              border-2 flex items-center justify-center text-[11px]
                              ${isSelected
                                ? "bg-brick border-brick text-white"
                                : "bg-white/90 border-pink text-transparent"}`}
                >
                  ✓
                </span>
              )}
              <div className="text-xs text-brown/60 font-mono-retro mb-1 truncate">
                {it.title || new Date(it.mtime * 1000).toLocaleString()}
              </div>
              {it.title && (
                <div className="text-xs text-brown/50 font-mono-retro mb-1">
                  {new Date(it.mtime * 1000).toLocaleDateString()}
                </div>
              )}
              <div className="grid grid-cols-2 gap-1">
                {it.thumbs.slice(0, 4).map((t) => (
                  <img
                    key={t}
                    src={t}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="aspect-square object-cover rounded border border-pink/40"
                  />
                ))}
              </div>
              {it.tags.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {it.tags.slice(0, 3).map((t) => (
                    <span
                      key={t}
                      className="bg-pink/30 text-brown text-[10px] px-1.5 py-0.5 rounded-full"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <div className="absolute inset-0 rounded-xl bg-brick/0 group-hover:bg-brick/5 transition-colors" />
            </button>
            {/*
              放大镜。只在有可查看产物时出现 —— 没有 media 的记录
              (理论上不该有, 因为至少有 photo_1) 点开会是空灯箱。
              放在右上角: 收藏徽标在左上, 两者不抢位置。
              **多选模式下隐藏**: 选择态下点卡片 = 切换选中,
              再放一个"打开另一个东西"的按钮只会让用户犹豫点哪。
            */}
            {!selecting && (it.media?.length ?? 0) > 0 && (
              <button
                type="button"
                data-gallery-zoom={it.job_id}
                onClick={() => setLightbox({ jobId: it.job_id, index: 0 })}
                aria-label={`大图查看 ${it.title || it.job_id}`}
                title="大图查看"
                className="absolute right-1 top-1 z-10 rounded-full bg-white/85 px-1.5
                           py-0.5 text-[11px] text-brick shadow hover:bg-white"
              >
                ⤢
              </button>
            )}
          </div>
          );
        })}
      </div>

      {/*
        哨兵 + 手动兜底按钮, 两者都要。

        哨兵负责"正常情况下的无缝加载"; 按钮负责**兜底**:
        IntersectionObserver 在某些环境不可用或不可靠(旧浏览器、
        某些嵌入式 webview、Playwright 里未真正滚动的视口),
        没有按钮的话用户会**永远停在第 1 页**且看不到任何"还有更多"的提示。
        按钮同时也是给键盘用户与读屏用户的可聚焦入口 —— 纯滚动容器
        对这两类用户等于内容被截断且无从察觉。
      */}
      <div ref={sentinelRef} data-gallery-sentinel="" className="h-px" aria-hidden="true" />
      {hasMore && !loading && !error && (
        <div className="flex justify-center py-6">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            data-gallery-load-more=""
            className="px-4 py-2 text-sm border border-pink rounded-full bg-white text-brown
                       hover:border-brick disabled:opacity-50"
          >
            {loadingMore ? "加载中..." : `加载更多(还有 ${Math.max(0, total - items.length)} 条)`}
          </button>
        </div>
      )}
      {!hasMore && items.length > 0 && !loading && (
        <div className="py-6 text-center text-xs text-brown/50" data-gallery-end="">
          没有更多了
        </div>
      )}

      {editing && (
        <AlbumEditor
          key={editing.job_id}
          jobId={editing.job_id}
          initial={{
            title: editing.title,
            note: editing.note,
            tags: editing.tags,
            favorite: editing.favorite,
            updated_at: editing.updated_at,
          }}
          onSave={(patch) => handleSave(editing.job_id, patch)}
          onDelete={() => handleDelete(editing.job_id)}
          onClose={() => setEditingId(null)}
        />
      )}

      {/*
        灯箱放在 AlbumEditor **之后**渲染, 让它在同一层里更靠上。
        两者能同时为真(灯箱里开着"重新编辑", 而相册编辑还开着), 顺序
        决定谁盖住谁 —— 灯箱 z-50 本就高于 AlbumEditor, 这里只是让 DOM
        顺序与视觉层级一致, 避免"视觉在上面、DOM 在下面"导致的
        读屏顺序错乱。
      */}
      {lightboxItem && lightbox && (
        <GalleryLightbox
          key={lightbox.jobId}
          item={lightboxItem}
          initialIndex={lightbox.index}
          onClose={() => setLightbox(null)}
          onSaved={() => {
            // 存了新 job, 必须按当前筛选条件重拉才能看到新记录 —— 与
            // handleSave 同理(见 reload 的注释)。
            void reload();
          }}
        />
      )}
    </div>
  );
}
