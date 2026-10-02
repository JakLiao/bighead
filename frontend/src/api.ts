import type { Meta, JobStatus } from "./types";

const API = "/api";

export async function fetchMeta(): Promise<Meta> {
  const r = await fetch(`${API}/meta`);
  if (!r.ok) throw new Error("fetchMeta failed");
  return r.json();
}

export async function fetchHealth(): Promise<{ ok: boolean; gpu: string; vram_free_gb: number }> {
  const r = await fetch(`${API}/health`);
  return r.json();
}

export async function applyFilter(imageBlob: Blob, preset: string): Promise<Blob> {
  const fd = new FormData();
  fd.append("image", imageBlob, "cap.jpg");
  fd.append("preset", preset);
  const r = await fetch(`${API}/preview/filter`, { method: "POST", body: fd });
  if (!r.ok) throw new Error("filter failed");
  return r.blob();
}

export async function saveCaptures(blobs: Blob[]): Promise<{ job_id: string; count: number }> {
  const fd = new FormData();
  blobs.forEach((b, i) => fd.append("images", b, `photo_${i + 1}.jpg`));
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
  return r.json();
}

export function openJobSocket(job_id: string, onMessage: (msg: any) => void): WebSocket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/jobs/${job_id}`);
  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data));
    } catch {
      // ignore
    }
  };
  return ws;
}

export async function fetchGallery(): Promise<{ items: { job_id: string; mtime: number; thumbs: string[] }[] }> {
  const r = await fetch(`${API}/gallery`);
  return r.json();
}
