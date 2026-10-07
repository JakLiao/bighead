import type { EraKey, Meta, JobStatus, GalleryResponse, BatchDeleteResult, AlbumDeleteResult, TrashResponse, AlbumEntry, AlbumPatchResult, ShareSaveResult } from "./types";

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

/**
 * 把已经烧好滤镜/年代的成片原样落盘。
 *
 * 刻意不接受 era: 落盘字节必须是调用方烧好的最终成片, era 算子非幂等,
 * 在这里再烧一遍会叠加(低分辨率再糊一次、漏光再抬一次)。
 * era 由 applyFilter 在上传前就烧进 blob —— 见 DecoratePage.doLayout。
 */
export async function saveCaptures(
  blobs: Blob[],
): Promise<{ job_id: string; count: number }> {
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

/**
 * 拉贴纸册。q / tag 由后端过滤(见 backend/routes/gallery.py 的 gallery())。
 *
 * 筛选放后端而不是前端过滤 items: 这样 ?q=xx 本身是一个可复现、可分享、
 * 刷新后保持的链接, 而不是只在这一次的内存里生效的临时状态。
 *
 * 分页用 limit/offset 而不是 page/cursor: 数据源是**磁盘目录扫描**,
 * 没有稳定的主键游标可依(offset 在有并发删除时理论上会漏/重一条,
 * 单机自用规模下这个代价可接受, 而 offset 让前后端都能无状态处理)。
 *
 * limit=0 表示不分页、返回全部 —— 这是**给旧调用方留的兼容档**:
 * 多个 verify-* 脚本直接 `fetch("/api/gallery")` 并对 items 断言,
 * 若默认变成 24 条, 它们在数据变多后会静默截断而看不出原因。
 * GalleryPage 自己显式传 PAGE_SIZE。
 *
 * 刻意**不做 debounce**: 本机自用, 每次击键打一次请求完全无感。
 * 加 debounce 要引入 timer ref + cleanup effect, 收益要到条目上千
 * 才出现 —— 那时再抽也不迟。这是有意识的取舍, 不是疏漏。
 */
export async function fetchGallery(
  q = "",
  tag = "",
  limit = 0,
  offset = 0,
): Promise<GalleryResponse> {
  const p = new URLSearchParams();
  if (q.trim()) p.set("q", q.trim());
  if (tag) p.set("tag", tag);
  if (limit > 0) p.set("limit", String(limit));
  if (offset > 0) p.set("offset", String(offset));
  const qs = p.toString();
  const r = await fetch(`${API}/gallery${qs ? `?${qs}` : ""}`);
  if (!r.ok) throw new Error(`fetchGallery ${r.status}`);
  return r.json();
}

/** PATCH 局部字段; tags 必须传完整数组(后端整体覆盖), 其他字段缺省视为不更新。 */
export async function patchAlbum(
  job_id: string,
  patch: Partial<AlbumEntry>,
): Promise<AlbumPatchResult> {
  const r = await fetch(`${API}/gallery/${encodeURIComponent(job_id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`patchAlbum ${r.status}: ${await r.text()}`);
  return r.json();
}

/**
 * 删一条。默认是**软删除**: 后端把目录移进 outputs/_trash/, 保留 7 天,
 * 可从回收站恢复。`permanent=true` 才真删(不可恢复)。
 */
export async function deleteAlbum(
  job_id: string,
  permanent = false,
): Promise<AlbumDeleteResult> {
  const q = permanent ? "?permanent=true" : "";
  const r = await fetch(`${API}/gallery/${encodeURIComponent(job_id)}${q}`, {
    method: "DELETE",
  });
  if (!r.ok) throw new Error(`deleteAlbum ${r.status}: ${await r.text()}`);
  return r.json();
}

/**
 * 批量删除。走 POST 而不是 `DELETE /api/gallery` 带 body:
 * DELETE 带请求体在部分代理/CDN 上会被静默丢弃, 且与
 * `DELETE /api/gallery/{job_id}` 的路径语义容易混淆 —— POST 到一个
 * 明确的 action 路径是这类批量操作更稳的写法。
 *
 * 后端**不做整体回滚**, 返回值要逐项看: deleted 是真删掉的,
 * missing 是本来就不存在的, failed 才需要提示用户。
 *
 * 默认同样进回收站(可恢复); permanent=true 才是不可恢复的真删。
 */
export async function batchDeleteAlbums(
  job_ids: string[],
  permanent = false,
): Promise<BatchDeleteResult> {
  const r = await fetch(`${API}/gallery/batch-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_ids, permanent }),
  });
  if (!r.ok) throw new Error(`batchDeleteAlbums ${r.status}: ${await r.text()}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// 回收站
// ---------------------------------------------------------------------------

/**
 * 回收站列表。
 *
 * 注意读**不是**纯读: 后端每次都会顺带清掉过保留期的条目, 所以响应里的
 * `purged` 可能非空。前端要把它显示出来 —— 用户看到列表突然少了 3 条,
 * 却没人告诉他"它们满 7 天被自动删了", 会以为是操作出了 bug。
 */
export async function fetchTrash(): Promise<TrashResponse> {
  const r = await fetch(`${API}/gallery/trash`);
  if (!r.ok) throw new Error(`fetchTrash ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function restoreFromTrash(job_id: string): Promise<{ job_id: string; restored: boolean }> {
  const r = await fetch(`${API}/gallery/trash/${encodeURIComponent(job_id)}/restore`, {
    method: "POST",
  });
  if (!r.ok) throw new Error(`restoreFromTrash ${r.status}: ${await r.text()}`);
  return r.json();
}

/** 彻底删除回收站里的一条(不可恢复)。 */
export async function purgeFromTrash(job_id: string): Promise<{ job_id: string; purged: boolean }> {
  const r = await fetch(`${API}/gallery/trash/${encodeURIComponent(job_id)}/purge`, {
    method: "POST",
  });
  if (!r.ok) throw new Error(`purgeFromTrash ${r.status}: ${await r.text()}`);
  return r.json();
}

/** 清空整个回收站(不可恢复)。 */
export async function emptyTrash(): Promise<{ removed_count: number; failed: { name: string; error: string }[] }> {
  const r = await fetch(`${API}/gallery/trash/empty`, { method: "POST" });
  if (!r.ok) throw new Error(`emptyTrash ${r.status}: ${await r.text()}`);
  return r.json();
}


/**
 * 落盘分享卡到 outputs/{job_id}/share.jpg。
 *
 * 传的是**前端已合成好的卡片字节**, 不是原始拼图: 服务端的
 * backend/share_card.py 只用于「补生成历史卡片」这类没有前端上下文的场景。
 * 正常出片时前端手里已有 collage blob 与 job_id, 本地 canvas 合成是零
 * 往返; 让浏览器把拼图上传回服务端再合成一次是纯粹的双向往返。
 */
export async function saveShareCard(
  job_id: string,
  card: Blob,
): Promise<ShareSaveResult> {
  const fd = new FormData();
  fd.append("job_id", job_id);
  fd.append("layout", card, "share.jpg");
  const r = await fetch(`${API}/share/save`, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`saveShareCard ${r.status}: ${await r.text()}`);
  return r.json();
}
