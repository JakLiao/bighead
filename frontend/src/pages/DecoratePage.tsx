import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import {
  applyFilter,
  fetchJob,
  fetchMeta,
  makeLayout,
  saveCaptures,
  startGeneration,
  openJobSocket,
} from "../api";
import type { EraInfo, EraKey, FilterInfo, FrameInfo, LayoutInfo, StyleInfo } from "../types";
import { ERA_DEFAULT, ERA_DEFS, type EraDef } from "../components/eras/eraDefs";
import { DoodleCanvas, paintDoodleStrokes } from "../components/doodles/DoodleCanvas";
import {
  CAPTURE_ASPECT,
  DOODLE_COLORS,
  DOODLE_DEFAULT_COLOR,
  DOODLE_DEFAULT_TOOL,
  DOODLE_DEFAULT_WIDTH,
  DOODLE_FALLBACK_LAYOUTS,
  DOODLE_TOOLS,
  DOODLE_WIDTHS,
  doodleSafeArea,
  type DoodleLayoutGeom,
  type DoodleStroke,
  type DoodleTool,
} from "../components/doodles/doodleTypes";

/** 拼图最多用几张(与 HomePage 的连拍张数一致)。 */
const PHOTO_COUNT_FOR_LAYOUT = 4;

/**
 * 编辑模态里涂鸦画布的显示尺寸(后端 backing store 是它的 2×)。
 * 取 4:3 与出片一致 —— 比例不一致会让 img 被 object-cover 裁掉一圈,
 * 而 canvas 仍按整块容器铺, 存下的 0..1 坐标就相对"被裁后的画面"了。
 */
const DOODLE_EDIT_W = 640;
const DOODLE_EDIT_H = Math.round((DOODLE_EDIT_W * CAPTURE_ASPECT.h) / CAPTURE_ASPECT.w);

/**
 * dataURL -> Blob。
 *
 * 不用 fetch(dataUrl): 那要先把整条 base64 字符串解出来, 4 张 1280x960 的
 * dataURL 会让峰值内存 = base64 字符串 + 解码 Blob 双份。atob 直接拿字节,
 * 少一次拷贝与一份完整副本。
 */
function dataUrlToBlob(url: string): Promise<Blob> {
  const comma = url.indexOf(",");
  if (comma < 0) return Promise.reject(new Error("非法 dataURL"));
  const head = url.slice(0, comma);
  const b64 = url.slice(comma + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const mime = /data:([^;,]+)/.exec(head)?.[1] ?? "image/jpeg";
  return Promise.resolve(new Blob([bytes], { type: mime }));
}

/**
 * 把一笔笔涂鸦烧进照片, 返回新 Blob。
 *
 * **为什么先画在独立透明层上, 再整体贴到照片**: 橡皮用的是
 * destination-out, 而 destination-out 擦的是"目标画布上已有的一切"。
 * 直接画在照片上就会把照片本身擦成透明, 导出 JPEG 时那块变成白/黑 ——
 * 用户想擦掉一笔笔迹, 结果在照片上开了个洞。隔一层之后, 橡皮只能擦到
 * 同一层里的笔迹, 擦完露出来的是照片, 正是所见即所得。
 *
 * 复用 paintDoodleStrokes(与编辑模态同一个渲染器), 保证"画时看到的那笔"
 * 与"这里烧进去的那笔"逐像素一致。
 */
async function burnDoodles(photoBlob: Blob, strokes: DoodleStroke[]): Promise<Blob> {
  if (strokes.length === 0) return photoBlob;
  const bitmap = await createImageBitmap(photoBlob);
  // ImageBitmap 是**显式**管理的资源: 不调 close() 不会进 GC 的自动回收路径,
  // 解码后的像素(1280x960x4 ≈ 4.7MB/张)会一直挂在 GPU/内存里。
  // 原来 close() 散落在函数体的多个分支上, 中间任何一次抛错(paintDoodleStrokes
  // 里的 canvas 调用、drawImage)都会跳过它 —— 一次失败就泄漏一张 4.7MB,
  // 连拍重来几轮就足以让移动端标签页被系统杀掉。try/finally 让"必须归还"
  // 变成语言级保证, 而不是靠每条分支都记得写一遍。
  try {
    const w = bitmap.width;
    const h = bitmap.height;

    const layer = document.createElement("canvas");
    layer.width = w;
    layer.height = h;
    paintDoodleStrokes(layer.getContext("2d"), strokes);

    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d");
    if (!ctx) return photoBlob;
    // 像素在此刻已拷进 out 画布, 之后 bitmap 与输出不再有引用关系,
    // 所以 close 放在 toBlob 之前是安全的(不必等编码结束)。
    ctx.drawImage(bitmap, 0, 0, w, h);
    ctx.drawImage(layer, 0, 0);

    // toBlob 在 canvas tainted 或尺寸超限时给 null, 回落原图而不是抛错 ——
    // 烧录失败不该让用户丢掉整轮照片。
    const burned = await new Promise<Blob | null>((resolve) =>
      out.toBlob(resolve, "image/jpeg", 0.92),
    );
    return burned ?? photoBlob;
  } finally {
    bitmap.close();
  }
}

interface ToolbarProps {
  color: string;
  tool: DoodleTool;
  width: number;
  onColor: (c: string) => void;
  onTool: (t: DoodleTool) => void;
  onWidth: (w: number) => void;
}

/**
 * 色板 + 工具 + 粗细。
 *
 * 侧栏与编辑模态各渲染一份, 状态是同一份(都提到 DecoratePage)。
 * 模态里必须再放一份: 它是 fixed inset-0 的全屏遮罩, 会把侧栏整个盖住 ——
 * 只在侧栏放控件的话, 用户一旦进编辑就换不了颜色, 只能"退出 → 换色 → 重进",
 * 而笔迹是画在遮罩之上的, 这个动线会直接劝退。
 */
function DoodleToolbar({ color, tool, width, onColor, onTool, onWidth }: ToolbarProps) {
  return (
    <>
      <div className="grid grid-cols-4 gap-1.5 mb-2">
        {DOODLE_COLORS.map((c) => (
          <button
            type="button"
            key={c.color}
            onClick={() => onColor(c.color)}
            data-doodle-color={c.color}
            aria-pressed={color === c.color}
            aria-label={`涂鸦颜色 ${c.name}`}
            title={c.name}
            style={{ background: c.color }}
            className={`h-7 w-full rounded-full border-2 transition ${
              color === c.color ? "border-brick scale-110" : "border-white"
            }`}
          />
        ))}
      </div>
      <div className="flex gap-1.5 mb-2">
        {DOODLE_TOOLS.map((t) => (
          <button
            type="button"
            key={t.key}
            onClick={() => onTool(t.key)}
            data-doodle-tool={t.key}
            aria-pressed={tool === t.key}
            title={t.hint}
            className={`flex-1 rounded px-2 py-1 text-xs transition ${
              tool === t.key
                ? "bg-brick text-white"
                : "border border-pink bg-cream text-brown hover:bg-pink/30"
            }`}
          >
            {t.name}
          </button>
        ))}
      </div>
      <div className="flex gap-1.5">
        {DOODLE_WIDTHS.map((w) => (
          <button
            type="button"
            key={w.width}
            onClick={() => onWidth(w.width)}
            data-doodle-width={w.width}
            aria-pressed={width === w.width}
            className={`flex-1 rounded py-1 text-xs transition ${
              width === w.width
                ? "bg-brick text-white"
                : "border border-pink bg-cream text-brown hover:bg-pink/30"
            }`}
          >
            {w.name}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * 把安全区渲染成一句**如实**的提示。
 *
 * 只列出真正会被裁掉的边: 6inch_4p 不裁左右, 文案就不该提"两侧"。
 * 措辞用"压暗区…不会出现在成片里"而不是"所有笔迹都会烧进最终图" ——
 * 后者是旧文案且是错的: 落在裁切窗口外的笔迹会被 _smart_crop 静默切掉。
 * 百分比带"约"字: 安全区按几何中心算, 检到人脸时后端 focus 会平移窗口
 * (见 doodleSafeArea 的局限说明), 精确到个位会显得比实际更可信。
 */
function safeText(s: { top: number; right: number; bottom: number; left: number }): string {
  const pct = (v: number) => Math.round(v * 100);
  const parts: string[] = [];
  if (s.left > 0) parts.push(`左 ${pct(s.left)}%`);
  if (s.right > 0) parts.push(`右 ${pct(s.right)}%`);
  if (s.top > 0) parts.push(`上 ${pct(s.top)}%`);
  if (s.bottom > 0) parts.push(`下 ${pct(s.bottom)}%`);
  if (parts.length === 0) return "当前排版不裁切画面, 笔迹都会保留";
  return `压暗区(${parts.join(" / ")})不会被保留`;
}

export function DecoratePage() {
  const frames = useStore((s) => s.frames);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  const style = useStore((s) => s.style);
  const setStyle = useStore((s) => s.setStyle);
  const aiEnabled = useStore((s) => s.aiEnabled);
  const setAiEnabled = useStore((s) => s.setAiEnabled);
  const aiImages = useStore((s) => s.aiImages);
  const setAiImages = useStore((s) => s.setAiImages);
  const layoutUrl = useStore((s) => s.layoutUrl);
  const setLayoutUrl = useStore((s) => s.setLayoutUrl);
  // 下载文件名。刻意不自定义: 服务端 layout.jpg 的路径里已含唯一的 job_id
  // (/outputs/<job_id>/ai/<style>/layout.jpg), 浏览器会自动取它做文件名。
  // 之前写的是 `bighead_${Date.now()}.jpg` —— 那是渲染期的 impure 调用,
  // 每次重渲染都会得到不同值(react-hooks/purity 会拦), 且语义不对。
  // 注意: 不再订阅 maskPreview。是否补滤镜改由每帧的 burnedIn 决定 ——
  // 拿取景页的实时开关当「是否已烧录」会在拍照后改开关时漂移。
  const setCurrentJobId = useStore((s) => s.setCurrentJobId);
  const currentJobId = useStore((s) => s.currentJobId);
  // HomePage 拉 /api/meta 时缓存了这两份, 本页直接复用避免重复请求。
  const filterMeta = useStore((s) => s.filterMeta);
  const frameMeta = useStore((s) => s.frameMeta);
  const cachedFilters = useMemo(() => Object.values(filterMeta), [filterMeta]);
  const cachedFrames = useMemo(() => Object.values(frameMeta), [frameMeta]);

  const [meta, setMeta] = useState<{
    styles: StyleInfo[]; filters: FilterInfo[]; frames: FrameInfo[]; layouts: LayoutInfo[];
    era_presets: EraInfo[];
  }>({ styles: [], filters: [], frames: [], layouts: [], era_presets: [] });

  // 年代是叠加在滤镜之上的独立维度, 与 filter 正交(不存 store: 它只在
  // 本页参与"生成拼图"这一次性动作, 跨页无意义)。
  const [era, setEra] = useState<EraKey>(ERA_DEFAULT);
  // 后端 /api/meta 是 era key 的唯一权威; 拿不到时回落到本地 ERA_DEFS,
  // 让开关在首屏就能点(否则 meta 慢一点整块面板就是空的)。
  const eraOptions: EraDef[] = useMemo(
    () =>
      meta.era_presets.length > 0
        ? meta.era_presets.map((e) => ({
            key: e.key,
            name: e.name,
            desc: ERA_DEFS.find((d) => d.key === e.key)?.desc ?? "",
          }))
        : ERA_DEFS,
    [meta.era_presets],
  );

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, msg: "" });
  const [error, setError] = useState<string | null>(null);
  // 涂鸦: 笔画进 store(要活到 doLayout), 笔具/颜色/粗细只是当前选中的
  // 编辑态参数, 不进 store —— 它们不参与出片, 换一轮连拍后保留也无害,
  // 但放 store 会让"哪些字段影响成片"这件事变得难以一眼看清。
  const doodles = useStore((s) => s.doodles);
  const setDoodles = useStore((s) => s.setDoodles);
  const clearDoodle = useStore((s) => s.clearDoodle);
  const [doodleColor, setDoodleColor] = useState(DOODLE_DEFAULT_COLOR);
  const [doodleTool, setDoodleTool] = useState<DoodleTool>(DOODLE_DEFAULT_TOOL);
  const [doodleWidth, setDoodleWidth] = useState(DOODLE_DEFAULT_WIDTH);
  // 正在编辑第几张。null = 没进编辑。
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const doodleTotal = useMemo(
    () => Object.values(doodles).reduce((n, list) => n + list.length, 0),
    [doodles],
  );
  // 相框已在取景阶段烧进照片。本页的"相框"选择改为「额外再套一层」,
  // 默认 none,即保持所见即所得的结果不变。想换框请回取景页重拍。
  const [frameOverride, setFrameOverride] = useState<string | null>(null);

  /**
   * 当前排版下会被后端 cover 裁掉的比例(四周各多少)。
   *
   * 刻意用 useMemo 跟着 `layout` 走: 排版是用户可切的, 而被裁的方向与宽度
   * 都随 cell 比例变(2x2 裁左右 21.7%, 6inch_4p 裁上下 2.8%/18.8%)。
   * 算一次存成常量的话, 用户切排版后提示就指错了地方 —— 那比没有提示更糟。
   *
   * meta.layouts 只带 cols/rows(见 backend/routes/health.py), paper 由
   * doodleTypes 内的镜像表补; meta 还没到时用 DOODLE_FALLBACK_LAYOUTS 兜底,
   * 保证首屏进模态就有提示, 而不是等 meta 到达后提示才突然出现。
   */
  const safeArea = useMemo(() => {
    const list: DoodleLayoutGeom[] =
      meta.layouts.length > 0 ? meta.layouts : DOODLE_FALLBACK_LAYOUTS;
    const hit = list.find((l) => l.key === layout) ?? list[0] ?? DOODLE_FALLBACK_LAYOUTS[0];
    return doodleSafeArea(hit);
  }, [layout, meta.layouts]);
  // AI 生成完成后要拼的图。AI 分支拿到的 URL 是 /outputs 下的服务端路径,
  // 拼图接口要的是二进制, 所以在内存里按需抓成 Blob。
  // 抓完直接喂给 makeLayout, 不需要跨渲染保留 —— 用局部变量即可。

  // /api/meta 是纯静态配置, HomePage 已经拉到并缓存了 filters/frames。
    // 原来本页无条件再 fetch 一次全量 meta(store.ts 注释里声称的「缓存在
    // store 避免重复请求」其实没落地)。这里改成: store 里已有的部分直接复用,
    // 只为缺失的 styles/layouts 拉一次 —— 并且拉到的结果并回 store。
  useEffect(() => {
    let alive = true;
    const hasFilter = cachedFilters.length > 0;
    const hasFrame = cachedFrames.length > 0;
    if (hasFilter && hasFrame && meta.styles.length > 0) return;

    fetchMeta()
      .then((m) => {
        if (!alive) return;
        setMeta({
          styles: m.styles,
          filters: hasFilter ? cachedFilters : m.filters,
          frames: hasFrame ? cachedFrames : m.frames,
          layouts: m.layouts,
          era_presets: m.era_presets ?? [],
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [cachedFilters, cachedFrames, meta.styles.length]);

  // 卸载时释放拼图 Blob 的 objectURL。effect 闭包只捕获挂载那一刻的
  // layoutUrl, 而它每次生成后都会变 —— 用 ref 读最新值, 否则只能清掉首帧。
  // 注意 ref 的写入放在 effect 里而不是渲染期: 渲染期写 ref 在并发模式下不安全。
  const layoutUrlRef = useRef<string | null>(null);
  useEffect(() => {
    layoutUrlRef.current = layoutUrl;
  }, [layoutUrl]);
  useEffect(() => {
    return () => {
      if (layoutUrlRef.current) URL.revokeObjectURL(layoutUrlRef.current);
    };
  }, []);

  // 用 AI 结果出拼图。首选后端已经拼好的 layout_url(服务端在写 job 状态时
  // 就生成好了, 存在 outputs 下), 省掉「把 4 张图再下载一遍、再上传一遍」;
  // 后端拼图失败(layout_url 为 null)时才退回客户端拼。
  // 用 AI 结果出拼图。首选后端已经拼好的 layout_url(服务端在写 job 状态时
  // 就生成好了, 存在 outputs 下), 省掉「把 4 张图再下载一遍、再上传一遍」;
  // 后端拼图失败(layout_url 为 null)时才退回客户端拼。
  //
  // 定义成 useCallback 并只依赖它真正用到的 state, 这样 WS 订阅 effect 的
  // 依赖数组能保持稳定 —— 否则每次 render 都是新函数, 会反复重建 WS 连接。
  const layoutFromAiImages = useCallback(async (urls: string[], serverLayout?: string | null) => {
    const prev = layoutUrlRef.current;
    try {
      if (serverLayout) {
        if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
        setLayoutUrl(serverLayout);
        return;
      }
      const picked = urls.slice(0, PHOTO_COUNT_FOR_LAYOUT);
      const blobs = await Promise.all(
        picked.map(async (u) => {
          const r = await fetch(u);
          if (!r.ok) throw new Error(`拉取 AI 结果失败 ${r.status}`);
          return r.blob();
        })
      );
      const result = await makeLayout(blobs, layout, frameOverride ?? "none");
      if (prev) URL.revokeObjectURL(prev);
      setLayoutUrl(URL.createObjectURL(result));
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [layout, frameOverride, setLayoutUrl]);

  // WS 监听。用 fetchJob 轮询兜底: WS 可能在生成途中因网络/代理/后端重启
  // 断开, 而 openJobSocket 只挂了 onmessage —— 没有 onerror/onclose 时
  // busy 永远为 true, 按钮永久禁用, 且 progress.total 为 0 连进度条都不显示,
  // 用户得不到任何提示。轮询保证终态一定能落地。
  useEffect(() => {
    if (!currentJobId) return;
    let stopped = false;
    let pollTimer: number | undefined;

    const finish = () => {
      if (!stopped) setBusy(false);
    };
    const onMessage = (msg: any) => {
      if (msg.status === "running") {
        setProgress({ current: msg.current, total: msg.total, msg: msg.msg ?? "" });
      } else if (msg.status === "done") {
        setProgress({ current: msg.total, total: msg.total, msg: "完成" });
        setAiImages(msg.images ?? []);
        finish();
        // AI 分支也要出拼图: 之前这里直接结束, 拼图区域永不出现。
        if (msg.images?.length) void layoutFromAiImages(msg.images, msg.layout_url);
      } else if (msg.status === "error") {
        setError(msg.msg ?? "未知错误");
        finish();
      }
    };

    const ws = openJobSocket(currentJobId, onMessage, () => {
      // WS 断了。轮询已在跑, 这里只提示一句, 避免页面静默卡住。
      if (!stopped) setError("进度连接中断, 正在改用轮询获取结果…");
    });

    const tick = async () => {
      if (stopped) return;
      try {
        const job = await fetchJob(currentJobId);
        if (stopped) return;
        // 轮询能拿到状态就说明链路是通的, 撤掉 WS 断线的提示。
        setError((e) => (e?.startsWith("进度连接中断") ? null : e));
        if (job.status === "done") {
          setProgress({ current: job.total, total: job.total, msg: "完成" });
          const imgs = job.images ?? [];
          setAiImages(imgs);
          finish();
          if (imgs.length) void layoutFromAiImages(imgs, job.layout_url);
          return; // 终态, 停轮询
        }
        if (job.status === "error") {
          setError(job.msg ?? "未知错误");
          finish();
          return;
        }
        if (job.status === "running") {
          setProgress({ current: job.current, total: job.total, msg: job.msg ?? "" });
        }
      } catch {
        // 后端暂时不可达, 下一轮再试; 连不上超过阈值由 WS 的 onerror 提示。
      }
      if (!stopped) pollTimer = window.setTimeout(tick, 3000);
    };
    pollTimer = window.setTimeout(tick, 3000);

    return () => {
      stopped = true;
      if (pollTimer) window.clearTimeout(pollTimer);
      ws.close();
    };
  }, [currentJobId, setAiImages, layoutFromAiImages]);

  if (frames.length === 0) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12 text-center">
        <div className="text-brown/70">还没有拍照片,先去 <a href="/home" className="text-brick underline">拍照</a>。</div>
      </div>
    );
  }

  async function doLayout(useAi: boolean) {
    setError(null);
    setBusy(true);
    try {
      // 逐帧决定是否补滤镜: burnedIn 是**拍照那一刻**的快照。
      // 只要有任何一帧没烧(用户在连拍中途关掉了取景预览),就必须让后端补,
      // 否则那几帧会静默丢掉 grain/vignette。也不能读当前 maskPreview ——
      // 那是取景页的实时开关,拍照之后再改它不该影响已成片的结果。
      const blobs = await Promise.all(
        frames.map((f) => dataUrlToBlob(f.url))
      );
      // 涂鸦烧录。位置很关键: 必须在滤镜/年代**之前**。
      // 这样笔迹会跟着整张图一起被处理(颗粒、漏光、暗角一视同仁), 也就是
      // 用户"在成片上手写"的真实预期; 反过来先烧滤镜再叠笔迹, 笔迹会
      // 浮在一层被处理过的画面上, 与编辑模态里看到的(原图上的笔迹)对不上。
      //
      // 串行而非 Promise.all: 每张 burnDoodles 同时持有 1 个 ImageBitmap
      // + 3 张全尺寸 canvas(1280x960x4 ≈ 4.7MB/张)。四张并发就是峰值
      // ~75MB 的瞬时分配, 在移动端 Safari 上足以触发标签页被杀;
      // 串行把这个峰值压到单张的量级。顺带能把进度真实报出来 ——
      // Promise.all 期间进度条只能干瞪眼, 用户点完按钮后面对一个
      // 不动的界面, 只能靠"是不是卡了"的猜测来决定要不要等。
      const stamped = [...blobs];
      // 只烧"这一帧真有笔迹"的下标。必须显式列出而不能对 doodles 做 map:
      // doodles 是 DoodlesByIndex = Record<number, DoodleStroke[]>(见
      // doodleTypes), 是稀疏字典而非数组, 对它 .map 会直接抛
      // "Property 'map' does not exist"。同时按 blobs 的长度收敛 ——
      // 用户可能给第 5 张画了笔而当前只有 4 帧, 多出来的下标会让
      // stamped 长度超过 blobs, 后面 applyFilter 就会拿到 undefined。
      const marked: number[] = [];
      for (let i = 0; i < blobs.length; i++) {
        if (doodles[i]?.length) marked.push(i);
      }
      for (let n = 0; n < marked.length; n++) {
        const i = marked[n];
        setProgress({
          current: n + 1,
          total: marked.length,
          msg: `正在烧录涂鸦 ${n + 1}/${marked.length}`,
        });
        stamped[i] = await burnDoodles(blobs[i], doodles[i]);
      }
      const needFilter = frames.some((f) => !f.burnedIn);
      // era 必须与 preset 走同一趟后端: burnedIn 只保证「滤镜」已烧, 不含年代。
      // 所以 needFilter 为假但选了古早画质时, 仍要发一次请求(preset 传 none,
      // 避免把已烧的滤镜再叠一遍)。反之 era=modern 且无需补滤镜时, 一次请求
      // 都不发 —— 这是连拍 4 张的快路径, 别为 modern 白跑 4 轮 OpenCV。
      const needEra = era !== ERA_DEFAULT;
      const finalBlobs =
        needFilter || needEra
          ? await Promise.all(
              stamped.map((b) => applyFilter(b, needFilter ? filter : "none", era)),
            )
          : stamped;

      // AI 写真
      if (useAi) {
        // 不传 era: 上面 applyFilter 已经把它烧进 finalBlobs 了。
        // era 算子非幂等, 再传一次会叠第二遍(低分辨率+漏光会翻倍),
        // 而 AI 生成是异步长任务, 这种错误要等 30s 后才看得出来。
        const cap = await saveCaptures(finalBlobs);
        // 先发起生成再订阅: 反过来(先 setCurrentJobId 再 await start)的话,
        // 后端可能在 WS 建连前就 broadcast 了 done, 那条消息永久丢失,
        // busy 永远为 true。
        await startGeneration(cap.job_id, style);
        setCurrentJobId(cap.job_id);
        return; // 等待 WS
      }

      // 普通拼图
      const result = await makeLayout(finalBlobs, layout, frameOverride ?? "none");
      // 释放上一个 objectURL 再换新的: 拼图是数 MB 的 Blob, 不 revoke
      // 的话每次点「生成拼图」都泄漏一份(旧 URL 永不释放)。
      if (layoutUrl) URL.revokeObjectURL(layoutUrl);
      setLayoutUrl(URL.createObjectURL(result));
      setBusy(false);
    } catch (e: any) {
      setError(e.message ?? String(e));
      setBusy(false);
    }
  }

  const displayImages: string[] =
    aiEnabled && aiImages.length > 0 ? aiImages : frames.map((f) => f.url);

  return (
    <div className="max-w-7xl mx-auto px-6 py-6">
      <h1 className="font-pixel text-2xl text-brick mb-4">排版装饰</h1>

      <div className="grid lg:grid-cols-[300px_1fr] gap-6">
        <aside className="space-y-5">
          {/* AI 开关 */}
          <div className="bg-white rounded-2xl border-2 border-pink p-4">
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <div className="font-pixel text-sm text-brick">AI 复古写真</div>
                <div className="text-xs text-brown/60 mt-1">
                  {aiEnabled ? "已启用 · 显存峰值 ≤ 7GB" : "关闭 · 纯本地滤镜拼图"}
                </div>
              </div>
              <input
                type="checkbox"
                checked={aiEnabled}
                onChange={(e) => setAiEnabled(e.target.checked)}
                className="w-6 h-6 accent-brick"
              />
            </label>
            {aiEnabled && (
              <div className="mt-3">
                <div className="text-xs text-brown/70 mb-1">风格</div>
                <select
                  value={style}
                  onChange={(e) => setStyle(e.target.value as any)}
                  className="w-full border border-pink rounded px-2 py-1 text-sm bg-cream"
                >
                  {meta.styles.map((s) => (
                    <option key={s.key} value={s.key}>{s.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* 滤镜 */}
          <div className="bg-white rounded-2xl border-2 border-pink p-4">
            <div className="font-pixel text-sm text-brick mb-2">实时滤镜</div>
            <div className="grid grid-cols-2 gap-2">
              {meta.filters.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key as any)}
                  className={`px-3 py-1.5 rounded-full text-xs border ${
                    filter === f.key
                      ? "bg-brick text-white border-brick"
                      : "bg-cream text-brown border-pink"
                  }`}
                >
                  {f.name}
                </button>
              ))}
            </div>
          </div>

          {/* 年代处理 */}
          <div className="bg-white rounded-2xl border-2 border-pink p-4">
            <div className="font-pixel text-sm text-brick mb-2">年代画质</div>
            <div className="text-[10px] text-brown/60 mb-2">
              叠加在滤镜之上, 生成拼图时烧进成片
            </div>
            <div className="grid grid-cols-2 gap-2">
              {eraOptions.map((e) => (
                <button
                  key={e.key}
                  type="button"
                  onClick={() => setEra(e.key)}
                  title={e.desc}
                  aria-pressed={era === e.key}
                  className={`px-3 py-1.5 rounded-full text-xs border ${
                    era === e.key
                      ? "bg-brick text-white border-brick"
                      : "bg-cream text-brown border-pink"
                  }`}
                >
                  {e.name}
                </button>
              ))}
            </div>
          </div>

          {/* 排版 */}
          <div className="bg-white rounded-2xl border-2 border-pink p-4">
            <div className="font-pixel text-sm text-brick mb-2">排版</div>
            <select
              value={layout}
              onChange={(e) => setLayout(e.target.value as any)}
              className="w-full border border-pink rounded px-2 py-1 text-sm bg-cream mb-3"
            >
              {meta.layouts.map((l) => (
                <option key={l.key} value={l.key}>{l.name}</option>
              ))}
            </select>
            <div className="font-pixel text-sm text-brick mb-2">
              追加相框
              <span className="ml-1 font-sans text-[10px] text-brown/50">取景已带框</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {meta.frames.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFrameOverride(f.key)}
                  className={`px-3 py-1.5 rounded-full text-xs border ${
                    (frameOverride ?? "none") === f.key
                      ? "bg-brick text-white border-brick"
                      : "bg-cream text-brown border-pink"
                  }`}
                >
                  {f.name}
                </button>
              ))}
            </div>
            {frameOverride && frameOverride !== "none" && (
              <button
                onClick={() => setFrameOverride(null)}
                className="mt-2 text-[10px] text-brown/60 underline hover:text-brick"
              >
                移除追加的相框
              </button>
            )}
          </div>

          {/* 涂鸦 */}
          <div className="bg-white rounded-2xl border-2 border-pink p-4" data-doodle-scope="sidebar">
            <div className="font-pixel text-sm text-brick mb-2">手写涂鸦</div>
            <div className="text-[10px] text-brown/60 mb-2" data-doodle-count={doodleTotal}>
              点上方照片进入编辑 · 共 {doodleTotal} 笔
            </div>
            <DoodleToolbar
              color={doodleColor}
              tool={doodleTool}
              width={doodleWidth}
              onColor={setDoodleColor}
              onTool={setDoodleTool}
              onWidth={setDoodleWidth}
            />
            {editingIdx !== null && (
              <div className="mt-2 flex gap-1.5">
                <button
                  type="button"
                  data-doodle-undo=""
                  disabled={!doodles[editingIdx]?.length}
                  onClick={() =>
                    setDoodles(editingIdx, doodles[editingIdx].slice(0, -1))
                  }
                  className="flex-1 rounded border border-pink px-2 py-1 text-xs text-brown hover:bg-pink/20 disabled:opacity-40"
                >
                  撤销一笔
                </button>
                <button
                  type="button"
                  data-doodle-clear=""
                  disabled={!doodles[editingIdx]?.length}
                  onClick={() => clearDoodle(editingIdx)}
                  className="flex-1 rounded border border-pink px-2 py-1 text-xs text-brown hover:bg-pink/20 disabled:opacity-40"
                >
                  清空这张
                </button>
              </div>
            )}
          </div>

          {/* 生成按钮 */}
          <button
            onClick={() => doLayout(aiEnabled)}
            disabled={busy}
            className="w-full px-6 py-3 bg-brick text-white rounded-full font-pixel text-sm shadow-lg hover:bg-brick/90 disabled:opacity-50"
          >
            {busy
              ? aiEnabled
                ? `AI 生成中 ${progress.current}/${progress.total}`
                : progress.total > 0
                  ? `生成中 ${progress.current}/${progress.total}`
                  : "生成中..."
              : aiEnabled
                ? "开始 AI 生成 + 拼图"
                : "生成拼图"}
          </button>

          {error && (
            <div className="bg-brick/10 border border-brick text-brick text-xs p-2 rounded">
              {error}
            </div>
          )}

          {/*
            进度条不按 aiEnabled 分流: 涂鸦烧录是串行的(见 doLayout), 每张
            都会 setProgress 一次。此前这里要求 aiEnabled 才渲染, 而普通
            "生成拼图"(aiEnabled=false, 默认路径)恰好把进度条藏了 —— 串行
            带来的实时反馈在主路径上完全看不到, 等于白做。total>0 才渲染,
            避免没有进度时画出空条。
          */}
          {busy && progress.total > 0 && (
            <div className="bg-cream rounded-lg p-3 text-xs">
              <div className="h-2 bg-pink rounded-full overflow-hidden">
                <div
                  className="h-full bg-brick transition-all"
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
                />
              </div>
              <div className="mt-1 text-brown/70">{progress.msg}</div>
            </div>
          )}
        </aside>

        <section>
          {editingIdx !== null && displayImages[editingIdx] && (
            <div
              data-doodle-modal=""
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
              onClick={() => setEditingIdx(null)}
            >
              <div
                className="max-h-[92vh] w-[92vw] max-w-3xl overflow-auto rounded-2xl bg-cream p-4"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-3 flex items-center justify-between">
                  <div className="font-pixel text-sm text-brick">
                    编辑涂鸦 #{editingIdx + 1}
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditingIdx(null)}
                    className="rounded-full bg-brick px-4 py-1.5 text-xs text-white"
                  >
                    完成
                  </button>
                </div>

                <div data-doodle-scope="modal">
                  <DoodleToolbar
                    color={doodleColor}
                    tool={doodleTool}
                    width={doodleWidth}
                    onColor={setDoodleColor}
                    onTool={setDoodleTool}
                    onWidth={setDoodleWidth}
                  />
                </div>

                <div className="mt-3 flex justify-center">
                  <DoodleCanvas
                    src={displayImages[editingIdx]}
                    strokes={doodles[editingIdx] ?? []}
                    color={doodleColor}
                    tool={doodleTool}
                    brush={doodleWidth}
                    onChange={(next) => setDoodles(editingIdx, next)}
                    width={DOODLE_EDIT_W}
                    height={DOODLE_EDIT_H}
                    safe={safeArea}
                  />
                </div>

                <div className="mt-3 text-[10px] text-brown/60">
                  在照片上按住拖动即可落笔 · 橡皮可擦掉已画的笔迹 ·
                  笔迹在点「生成拼图」时烧进照片 ·{" "}
                  <span className="text-brick" data-doodle-safe-text="">
                    {safeText(safeArea)}
                  </span>
                  {doodles[editingIdx]?.length
                    ? ` · 当前这张 ${doodles[editingIdx].length} 笔`
                    : ""}
                </div>
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            {displayImages.slice(0, 8).map((src, i) => (
              <button
                type="button"
                // key 掺入 src: 连拍换一轮后 frames 会被整体替换, 只用下标做
                // key 会让 React 认为"还是同一张图", 于是复用旧节点 —— 上一轮
                // 的 <img> 与「N 笔」角标会被原地改成新内容。掺入 src 后
                // 源变了就是新节点, 角标不会残留。
                key={`${i}:${src}`}
                data-doodle-thumb={i}
                onClick={() => setEditingIdx(i)}
                title="点击编辑这张的涂鸦"
                // 比例必须与编辑模态的画布一致(4:3 = CAPTURE_ASPECT):
                // 缩略图用 object-cover, 若容器是 3/4 则显示的是**被裁过的**
                // 画面, 与进模态后看到的整张照片对不上, 用户会以为笔迹位置
                // 整体偏移。object-cover 在同比例下等价于完整显示。
                className="relative w-full overflow-hidden rounded-lg border-2 border-pink bg-white text-left transition hover:border-brick"
                style={{ aspectRatio: `${CAPTURE_ASPECT.w} / ${CAPTURE_ASPECT.h}` }}
              >
                <img
                  src={src}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
                {doodles[i]?.length ? (
                  <span
                    data-doodle-badge={i}
                    className="absolute right-1 top-1 rounded-full bg-brick px-1.5 py-0.5 text-[10px] text-white"
                  >
                    {doodles[i].length} 笔
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          {layoutUrl && (
            <div className="bg-white rounded-2xl border-2 border-brick p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="font-pixel text-sm text-brick">最终拼图</div>
                <a
                  href={layoutUrl}
                  className="px-4 py-1.5 bg-brick text-white rounded-full text-xs"
                >
                  下载 JPG
                </a>
              </div>
              <img src={layoutUrl} className="w-full rounded-lg" />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
