import type { EraKey, Meta, JobStatus } from "./types";

const API = "/api";

export async function fetchMeta(): Promise<Meta> {
  const r = await fetch(`${API}/meta`);
  if (!r.ok) throw new Error("fetchMeta failed");
  return r.json();
}

export async function fetchHealth(): Promise<{ ok: boolean; gpu: string; vram_free_gb: number }> {
  const r = await fetch(`${API}/health`);
  if (!r.ok) throw new Error(`health ${r.status}`);
  return r.json();
}

export async function applyFilter(
  imageBlob: Blob,
  preset: string,
  era: EraKey = "modern",
): Promise<Blob> {
  const fd = new FormData();
  fd.append("image", imageBlob, "cap.jpg");
  fd.append("preset", preset);
  fd.append("era", era);
  const r = await fetch(`${API}/preview/filter`, { method: "POST", body: fd });
  if (!r.ok) throw new Error("filter failed");
  return r.blob();
}

export async function saveCaptures(
  blobs: Blob[],
  era: EraKey = "modern",
): Promise<{ job_id: string; count: number }> {
  const fd = new FormData();
  blobs.forEach((b, i) => fd.append("images", b, `photo_${i + 1}.jpg`));
  fd.append("era", era);
  const r = await fetch(`${API}/capture/save`, { method: "POST", body: fd });
  if (!r.ok) throw new Error("save failed");
  return r.json();
}

export async function makeLayout(blobs: Blob[], layout: string, frame: string): Promise<Blob> {
  const fd = new FormData();
  blobs.forEach((b, i) => fd.append("images", b, `p_${i}.jpg`));
  fd.append("layout", layout);
  fd.append("frame", frame);
  const r = await fetch(`${API}/layout/make`, { method: "POST", body: fd });
  if (!r.ok) throw new Error("layout failed");
  return r.blob();
}

export async function startGeneration(
  job_id: string,
  style: string,
  steps?: number,
): Promise<{ job_id: string; total: number }> {
  const fd = new FormData();
  fd.append("job_id", job_id);
  fd.append("style", style);
  if (steps) fd.append("steps", String(steps));
  const r = await fetch(`${API}/generate/start`, { method: "POST", body: fd });
  if (!r.ok) throw new Error("generate start failed");
  return r.json();
}

export async function fetchJob(job_id: string): Promise<JobStatus> {
  const r = await fetch(`${API}/jobs/${job_id}`);
  if (!r.ok) throw new Error(`fetchJob ${r.status}`);
  return r.json();
}

/**
 * 订阅任务进度。
 *
 * 除了 onmessage 还挂了 onerror / onclose: 生成途中 WS 可能因网络抖动、
 * 代理或后端重启断开, 只挂 onmessage 时调用方永远收不到终态。
 * onStatusChange 让调用方能立刻解锁 UI 并提示, 而不是无限等待。
 * 心跳由后端每 15s 主动发, 心跳本身不代表异常, 故不作为错误处理。
 */
export function openJobSocket(
  job_id: string,
  onMessage: (msg: any) => void,
  onDisconnect?: () => void
): WebSocket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/jobs/${job_id}`);
  let everConnected = false;
  ws.onopen = () => {
    everConnected = true;
  };
  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data));
    } catch {
      // ignore
    }
  };
  const fail = () => {
    // 连接建立后断开才算异常; 连都没连上时也通知, 让调用方走轮询兜底。
    onDisconnect?.();
  };
  ws.onerror = () => {
    /* onclose 紧随其后, 统一在那里处理 */
  };
  ws.onclose = (e) => {
    // 1000 = 正常关闭(后端终态 600s 后主动收尾), 不算异常。
    if (e.code !== 1000 || everConnected) fail();
  };
  return ws;
}

export async function fetchGallery(): Promise<{ items: { job_id: string; mtime: number; thumbs: string[] }[] }> {
  const r = await fetch(`${API}/gallery`);
  if (!r.ok) throw new Error(`fetchGallery ${r.status}`);
  return r.json();
}
