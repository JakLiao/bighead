import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  onCapture: (dataUrl: string) => void;
  active: boolean;
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

export function LiveCamera({ onCapture, active }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // StrictMode 双调用时会自增,用于识别过期的异步结果
  const sessionRef = useRef(0);
  // NotReadableError 自动重试只做一次,避免真的被占用时无限循环
  const retriedRef = useRef(false);
  const [state, setState] = useState<CamState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

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
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0);
    const url = c.toDataURL("image/jpeg", 0.92);
    onCapture(url);
    return url;
  }

  // 把 snap 挂到组件上供外部(连拍逻辑)调用
  useEffect(() => {
    (LiveCamera as unknown as { _snap?: () => string | null })._snap = snap;
  });

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
    <div className="relative rounded-3xl overflow-hidden border-4 border-white shadow-2xl bg-deepblue">
      <video
        ref={attach}
        autoPlay
        playsInline
        muted
        className="w-full aspect-[4/3] object-cover"
        style={{ transform: "scaleX(-1)" }}
      />
      {state !== "live" && (
        <div className="absolute inset-0 flex items-center justify-center text-white/80">
          {state === "error" ? "" : "正在启动摄像头..."}
        </div>
      )}
    </div>
  );
}

export function snapFromCamera(): string | null {
  return (LiveCamera as unknown as { _snap?: () => string | null })._snap?.() ?? null;
}
