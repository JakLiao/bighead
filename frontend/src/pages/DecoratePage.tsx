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

/** 拼图最多用几张(与 HomePage 的连拍张数一致)。 */
const PHOTO_COUNT_FOR_LAYOUT = 4;

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
  // 相框已在取景阶段烧进照片。本页的"相框"选择改为「额外再套一层」,
  // 默认 none,即保持所见即所得的结果不变。想换框请回取景页重拍。
  const [frameOverride, setFrameOverride] = useState<string | null>(null);
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
      const needFilter = frames.some((f) => !f.burnedIn);
      // era 必须与 preset 走同一趟后端: burnedIn 只保证「滤镜」已烧, 不含年代。
      // 所以 needFilter 为假但选了古早画质时, 仍要发一次请求(preset 传 none,
      // 避免把已烧的滤镜再叠一遍)。反之 era=modern 且无需补滤镜时, 一次请求
      // 都不发 —— 这是连拍 4 张的快路径, 别为 modern 白跑 4 轮 OpenCV。
      const needEra = era !== ERA_DEFAULT;
      const finalBlobs =
        needFilter || needEra
          ? await Promise.all(
              blobs.map((b) => applyFilter(b, needFilter ? filter : "none", era)),
            )
          : blobs;

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

          {/* 生成按钮 */}
          <button
            onClick={() => doLayout(aiEnabled)}
            disabled={busy}
            className="w-full px-6 py-3 bg-brick text-white rounded-full font-pixel text-sm shadow-lg hover:bg-brick/90 disabled:opacity-50"
          >
            {busy
              ? aiEnabled
                ? `AI 生成中 ${progress.current}/${progress.total}`
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

          {busy && aiEnabled && progress.total > 0 && (
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            {displayImages.slice(0, 8).map((src, i) => (
              <div key={i} className="aspect-[3/4] bg-white rounded-lg border-2 border-pink overflow-hidden">
                <img
                  src={src}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="w-full h-full object-cover"
                />
              </div>
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
