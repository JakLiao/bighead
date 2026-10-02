import { useEffect, useRef, useState } from "react";

interface Props {
  onCapture: (dataUrl: string) => void;
  active: boolean;
}

export function LiveCamera({ onCapture, active }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);

  useEffect(() => {
    if (!active) return;
    let stream: MediaStream | null = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 960 }, facingMode: "user" },
          audio: false,
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setStreaming(true);
        }
      } catch (e: any) {
        setError(e?.message || "摄像头不可用");
      }
    })();
    return () => {
      stream?.getTracks().forEach((t) => t.stop());
      setStreaming(false);
    };
  }, [active]);

  function snap(): string | null {
    if (!videoRef.current || !streaming) return null;
    const v = videoRef.current;
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

  // 暴露 snap 给父组件用
  useEffect(() => {
    (LiveCamera as any)._snap = snap;
  });

  if (error) {
    return (
      <div className="bg-pink/30 border-2 border-brick/40 rounded-2xl p-8 text-center text-brown">
        <div className="font-pixel text-brick mb-2">摄像头不可用</div>
        <div className="text-sm">{error}</div>
        <div className="mt-3 text-xs">请在浏览器中允许摄像头权限,或检查是否有其他应用占用</div>
      </div>
    );
  }

  return (
    <div className="relative rounded-3xl overflow-hidden border-4 border-white shadow-2xl bg-deepblue">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full aspect-[4/3] object-cover"
        style={{ transform: "scaleX(-1)" }}
      />
      {!streaming && (
        <div className="absolute inset-0 flex items-center justify-center text-white/80">
          正在启动摄像头...
        </div>
      )}
    </div>
  );
}

export function snapFromCamera(): string | null {
  return (LiveCamera as any)._snap?.() ?? null;
}
