import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { MaskOverlay } from "./MaskOverlay";
import { computeFrameGeometry } from "./frameGeometry";
import { renderMaskLayer } from "./masks/renderMask";
import { getMask } from "./masks/maskDefs";
import type { FilterInfo, FrameInfo } from "../types";

interface Props {
  onCapture: (dataUrl: string) => void;
  active: boolean;
  /** 当前相框参数(null = 无相框)。用于实时蒙版预览与出片合成 */
  frame?: FrameInfo;
  /** 当前滤镜参数。css 用于实时预览与 ctx.filter 出片,vignette 用于叠暗角 */
  filter?: FilterInfo;
  /** 当前预置蒙版 key。挖形状洞 + 撒贴纸,预览与出片共用同一渲染器 */
  maskKey?: string;
  /** 是否叠加取景蒙版 */
  maskPreview: boolean;
  /** 是否显示构图引导线 */
  showGuides: boolean;
}

/**
 * 父组件通过 ref 拿到的拍照能力。
 *
 * 早先这里是把 snap 挂成 LiveCamera._snap 静态属性再由外部反查,那有三个问题:
 *   · 跨组件耦合 —— 父组件要访问子组件的私有字段,等于把内部实现当公共 API
 *   · 依赖渲染时机 —— 必须每次渲染都重新挂,否则拿到的是旧闭包(切滤镜拍不出新色调)
 *   · 无法共存 —— 页面上有两个摄像头实例时会互相覆盖同一个 _snap
 * useImperativeHandle 让"能拍照"成为显式契约,依赖由 React 自动处理。
 */
export interface LiveCameraHandle {
  /** 抓取当前帧并合成相框/滤镜/蒙版,返回 dataURL;摄像头未出帧时返回 null */
  snap: () => string | null;
}

/** 相框背景填充到 canvas:纯色或棋盘格,与 frameGeometry.frameBackgroundStyle 同源。 */
function paintChecker(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const cell = Math.max(8, Math.round(Math.min(w, h) / 24));
  ctx.fillStyle = "#fff0f0";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#dcc8c8";
  for (let cy = y; cy < y + h; cy += cell) {
    for (let cx = x; cx < x + w; cx += cell) {
      if ((Math.floor((cx - x) / cell) + Math.floor((cy - y) / cell)) % 2) {
        ctx.fillRect(cx, cy, Math.min(cell, x + w - cx), Math.min(cell, y + h - cy));
      }
    }
  }
}

/**
 * 把"照片 + 相框"合成到目标尺寸的画布。
 * 与 MaskOverlay 用同一个 computeFrameGeometry,保证预览的框宽 = 成片的框宽。
 *
 * @param source 已渲染好滤镜的照片画布
 */
function composeFramed(
  source: HTMLCanvasElement,
  frame: FrameInfo | undefined,
): HTMLCanvasElement {
  const vw = source.width;
  const vh = source.height;
  const g = computeFrameGeometry(frame, vw, vh);

  const out = document.createElement("canvas");
  out.width = g.canvas.w;
  out.height = g.canvas.h;
  const ctx = out.getContext("2d");
  if (!ctx) return out;

  if (g.hasFrame) {
    if (g.checker) {
      paintChecker(ctx, 0, 0, out.width, out.height);
    } else {
      ctx.fillStyle = frame?.bg ?? "#ffffff";
      ctx.fillRect(0, 0, out.width, out.height);
    }
  }

  // 照片区与源同尺寸(成片只是四周加边),直接 1:1 贴入,不做二次裁切,
  // 保证取景框里看到的构图就是成片的构图。
  ctx.drawImage(source, 0, 0, vw, vh, g.photo.x, g.photo.y, g.photo.w, g.photo.h);

  if (g.title) {
    ctx.fillStyle = g.titleColor;
    ctx.font = `${Math.max(14, Math.round(out.width * 0.022))}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(g.title, out.width / 2, out.height - (out.height - g.photo.y - g.photo.h) / 2);
  }
  return out;
}

type CamState = "idle" | "starting" | "live" | "error";

/** 区分「用户没给权限/没设备」这类硬错误,与「组件重渲染导致的中断」这类瞬时问题。 */
function describeError(e: unknown): string | null {
  const name = (e as { name?: string })?.name ?? "";
  const msg = (e as { message?: string })?.message ?? String(e);

  // play() 被中断通常是因为 video 节点在 await 期间被卸载/替换,
  // 这类瞬时问题不该弹错误,重试即可。
  if (name === "AbortError" || /interrupted|removed from the document|aborted/i.test(msg)) {
    return null;
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "摄像头权限被拒绝。请点击地址栏左侧的锁图标允许摄像头,然后重试。";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "未检测到可用摄像头(或请求的分辨率不被支持)。";
  }
  if (name === "NotReadableError") {
    return "摄像头被其他应用占用,请关闭占用程序后重试。";
  }
  return msg;
}

export const LiveCamera = forwardRef<LiveCameraHandle, Props>(function LiveCamera(
  {
    onCapture,
    active,
    frame,
    filter,
    maskKey,
    maskPreview,
    showGuides,
  },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // StrictMode 双调用时会自增,用于识别过期的异步结果
  const sessionRef = useRef(0);
  // NotReadableError 自动重试只做一次,避免真的被占用时无限循环
  const retriedRef = useRef(false);
  const [state, setState] = useState<CamState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  // 取景容器尺寸,供 MaskOverlay 做像素级相框定位
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  // 始终指向最新的 snap。这样 useImperativeHandle 只需挂一次,
  // 闭包过时的问题交给 ref 自身解决,而不是靠"每次渲染重新挂"。
  const snapRef = useRef<() => string | null>(() => null);
  // 预置蒙版的位图。用 img 而不是直接画 canvas,是因为蒙版要盖在 <video> 之上,
  // 而 video 与 canvas 无法直接叠层 —— 转成 <img> 就能像普通图片一样定位。
  const [maskUrl, setMaskUrl] = useState<string | null>(null);

  const maskDef = getMask(maskKey);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 蒙版预览:用真实渲染器按当前取景尺寸出一张图,盖在 video 上。
  // 尺寸跟随容器,是因为镂空洞的相对大小必须和成片一致。
  useEffect(() => {
    if (!maskPreview || !maskDef || box.w <= 0 || box.h <= 0) {
      setMaskUrl(null);
      return;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const layer = renderMaskLayer(maskDef, Math.round(box.w * dpr), Math.round(box.h * dpr));
    if (!layer) {
      setMaskUrl(null);
      return;
    }
    setMaskUrl(layer.toDataURL("image/png"));
  }, [maskPreview, maskDef, box.w, box.h]);

  useEffect(() => {
    if (!active) return;

    // StrictMode 会 mount→cleanup→mount 双调用。这里用「会话令牌」而不是局部 cancelled 变量:
    // 每次 effect 开启一个新 session,只有当前 session 的异步结果才允许写 state,
    // 过期 session 拿到的流会立刻归还设备。
    const session = ++sessionRef.current;
    const isCurrent = () => sessionRef.current === session;

    (async () => {
      try {
        // StrictMode 的第一次请求可能仍持有设备,立刻重试会撞上 NotReadableError。
        // 先让出事件循环再请求,给驱动释放设备的时间。
        if (sessionRef.current > 1) {
          await new Promise((r) => setTimeout(r, 120));
          if (!isCurrent()) return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 960 }, facingMode: "user" },
          audio: false,
        });

        // 拿到流之后先确认自己还是最新 session;不是就立刻归还设备
        if (!isCurrent()) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = stream;

        const el = videoRef.current;
        if (!el) return;
        el.srcObject = stream;
        // autoplay + muted 时 play() 一般不会因策略失败;
        // 若因节点被替换而中断,交给 ref 回调 attach 重新挂载,不算错误。
        await el.play().catch(() => undefined);

        if (!isCurrent()) return;
        if (el.srcObject !== stream) return; // 节点已被替换,交给 attach 处理
        setError(null);
        setState("live");
      } catch (e) {
        if (!isCurrent()) return;
        const name = (e as { name?: string })?.name ?? "";
        // 设备被上一轮会话短暂占用是常见情况,自动重试一次再判定为硬错误
        if (name === "NotReadableError" && !retriedRef.current) {
          retriedRef.current = true;
          await new Promise((r) => setTimeout(r, 400));
          if (isCurrent()) setRetryKey((k) => k + 1);
          return;
        }
        const described = describeError(e);
        if (described) {
          setError(described);
          setState("error");
        } else {
          setState("starting");
        }
      }
    })();

    return () => {
      if (isCurrent()) {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        setState("idle");
      }
    };
  }, [active, retryKey]);

  // video 节点被 React 重建时(StrictMode / 重渲染),把新节点重新接上已有流。
  // 这是 play() 中断的真正兜底:旧节点的 promise 会 reject,但新节点能续上。
  const attach = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    const stream = streamRef.current;
    if (!el || !stream) return;
    if (el.srcObject === stream) return;
    el.srcObject = stream;
    el.play()
      .then(() => {
        setError(null);
        setState("live");
      })
      .catch(() => {
        /* 节点又被替换了,下一次 attach 会再试 */
      });
  }, []);

  function snap(): string | null {
    const v = videoRef.current;
    if (!v || !streamRef.current || v.videoWidth === 0) return null;
    // 先把裸帧 + 滤镜画到一张 4:3 画布,再交给 composeFramed 加相框。
    // ctx.filter 接受的语法与 CSS filter 字符串一致,所以直接复用后端下发的
    // 同一份 css —— 取景框看到的色调就是成片的色调。
    const outW = v.videoWidth;
    const outH = Math.round((v.videoWidth * 3) / 4);
    const base = document.createElement("canvas");
    base.width = outW;
    base.height = outH;
    const bctx = base.getContext("2d");
    if (!bctx) return null;

    // 摄像头未必给回请求的 4:3(常见是 16:9)。这里做 cover 裁切而非拉伸,
    // 等价于页面上 video 的 object-cover,避免脸被拉变形。
    const srcRatio = v.videoWidth / v.videoHeight;
    const dstRatio = outW / outH;
    let sw = v.videoWidth;
    let sh = v.videoHeight;
    if (srcRatio > dstRatio) {
      sw = v.videoHeight * dstRatio;
    } else {
      sh = v.videoWidth / dstRatio;
    }
    const sx = (v.videoWidth - sw) / 2;
    const sy = (v.videoHeight - sh) / 2;

    const css = filter?.css ?? "";
    if (css) bctx.filter = css;
    bctx.drawImage(v, sx, sy, sw, sh, 0, 0, outW, outH);
    bctx.filter = "none";

    // 预置蒙版:盖上"挖了洞 + 有贴纸"的图层。洞是透明的,
    // 所以照片会从人脸形状里透出来 —— 这就是取景框里看到的效果。
    if (maskPreview && maskDef) {
      const layer = renderMaskLayer(maskDef, outW, outH);
      if (layer) bctx.drawImage(layer, 0, 0);
    }

    const framed = composeFramed(base, frame);
    const url = framed.toDataURL("image/jpeg", 0.92);
    onCapture(url);
    return url;
  }

  // 每次渲染把最新 snap 存进 ref,供 useImperativeHandle 转发。
  // 写在 useLayoutEffect 里而不是渲染体内,避免在渲染阶段改 ref
  // 带来的副作用警告,同时也保证父组件在 commit 后能立刻调到最新实现。
  useLayoutEffect(() => {
    snapRef.current = snap;
  });

  // 把拍照能力暴露给父组件。依赖数组交给 React 自动比对,
  // 切滤镜/相框/蒙版时会自动拿到最新闭包,不需要手动"每次渲染重新挂"。
  useImperativeHandle(
    ref,
    () => ({
      snap: () => snapRef.current(),
    }),
    [],
  );

  if (state === "error" && error) {
    return (
      <div className="bg-pink/30 border-2 border-brick/40 rounded-2xl p-8 text-center text-brown">
        <div className="font-pixel text-brick mb-2">摄像头不可用</div>
        <div className="text-sm">{error}</div>
        <div className="mt-3 text-xs">请在浏览器中允许摄像头权限,或检查是否有其他应用占用</div>
        <button
          onClick={() => {
            setError(null);
            setState("starting");
            retriedRef.current = false;
            setRetryKey((k) => k + 1);
          }}
          className="mt-4 px-6 py-2 bg-brick text-white rounded-full font-pixel text-sm hover:bg-brick/90"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      className="relative rounded-3xl overflow-hidden border-4 border-white shadow-2xl bg-deepblue"
    >
      <video
        ref={attach}
        autoPlay
        playsInline
        muted
        className="w-full aspect-[4/3] object-cover"
        style={{
          transform: "scaleX(-1)",
          // 取景框实时滤镜。同一份字符串会在 snap() 里交给 ctx.filter 烧进成片,
          // 所以这里看到的色调就是最终成片的色调。
          filter: maskPreview ? filter?.css || "none" : "none",
        }}
      />
      {maskUrl && (
        <img
          src={maskUrl}
          alt=""
          className="pointer-events-none absolute inset-0 h-full w-full"
        />
      )}
      {maskPreview && (
        <MaskOverlay
          frame={frame}
          vignette={filter?.vignette ?? 0}
          showGuides={showGuides}
          dual={maskDef?.audience === "dual"}
          containerWidth={box.w}
          containerHeight={box.h}
        />
      )}
      {state !== "live" && (
        <div className="absolute inset-0 flex items-center justify-center text-white/80">
          {state === "error" ? "" : "正在启动摄像头..."}
        </div>
      )}
    </div>
  );
});
