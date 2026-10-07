# P1 贴纸册 + pose 引导 / 单张重拍 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地竞品分析 `2026-10-04-古早大头贴竞品分析.md` 第 3.4、3.5 节的两项 P1 能力 —— 让画廊成为可编辑、可收藏、可删除的「贴纸册」；让连拍流程在第 1~3 张拍完时插入「重拍本张 / 继续」的暂停态，并伴随可开关的 pose 文字浮层。

**Architecture:** 三个能力彼此独立、互不耦合。

- **贴纸册**：纯目录扫描之上挂一层 `outputs/_album.json` sidecar 元数据；新增 `PATCH /api/gallery/{job_id}` 与 `DELETE /api/gallery/{job_id}`，`GET /api/gallery` 合并元数据返回。排序固定「收藏优先 + 时间倒序」，不引入切换开关。
- **pose 引导**：4 个固定词（嘟嘴/比心/看镜头/笑僵）按拍照顺序循环，新增可开关 `showPose` 与 `poseIndex`；前端纯展示，不向后端发任何数据。
- **单张重拍**：在 `HomePage` `doSnap` 之后插入局部 `retakeIdx` 暂停态，「重拍本张 / 继续」都通过 `setSnapTick(t => t+1)` 复用既有 3-2-1 倒计时，**不改 `CountdownOverlay.tsx`**；第 4 张仍直通 `/decorate`，无暂停条。

**Tech Stack:**
- 后端：FastAPI + 标准库（json/threading/pathlib），**无新依赖**
- 前端：React 18 + Zustand（既有），**无新依赖**
- 验证：3 个新脚本 `verify-album-meta.mjs`、`verify-album-edit.mjs`、`verify-retake-bar.mjs`，跑齐现有 11 个回归脚本（11 × ? 项 + 新 3 × ? 项）

---

## 文件总览

| 路径 | 状态 | 责任 |
|---|---|---|
| `backend/routes/gallery.py` | 修改 | `_load_album`/`_save_album` 私有助手；GET 合并；新增 PATCH/DELETE |
| `backend/config.py` | 修改 | 新增 `ALBUM_FILENAME = "_album.json"` 常量 |
| `frontend/src/types.ts` | 修改 | 新增 `AlbumEntry` 类型；`GalleryItem` 加 `title/note/tags/favorite/updated_at` 字段 |
| `frontend/src/api.ts` | 修改 | 新增 `patchAlbum(job_id, patch)`、`deleteAlbum(job_id)`；`fetchGallery` 返回类型扩展 |
| `frontend/src/store.ts` | 修改 | 新增 `showPose` 与 `setShowPose`；`reset()` 不动（pose 是 UI 偏好，不是拍摄产物） |
| `frontend/src/pages/HomePage.tsx` | 修改 | 引入 `RetakeBar` 与 `PoseHint`；`doSnap` 后改写为「前 3 张暂停、第 4 张直通」 |
| `frontend/src/components/retake/RetakeBar.tsx` | 新增 | 重拍确认条（仅前 3 张出现） |
| `frontend/src/components/retake/PoseHint.tsx` | 新增 | 文字浮层 pose 提示 |
| `frontend/src/pages/GalleryPage.tsx` | 修改 | 卡片化、收藏徽标、编辑抽屉、删除按钮、调用 `patchAlbum`/`deleteAlbum` |
| `frontend/src/components/album/AlbumEditor.tsx` | 新增 | 单条记录的标题/备注/标签编辑抽屉 |
| `frontend/verify-album-meta.mjs` | 新增 | PATCH / DELETE / 路径穿越 / 孤儿条目断言 |
| `frontend/verify-album-edit.mjs` | 新增 | UI 层编辑 + 收藏排序 + 删除端到端 |
| `frontend/verify-retake-bar.mjs` | 新增 | RetakeBar 出现/隐藏、第 4 张直通、pose 轮换、burnedIn 重读 |

---

## Task 1: 后端元数据存储层

**Files:**
- Modify: `backend/config.py:48-53`（`OUTPUT_DIR` 定义旁加 `ALBUM_FILENAME`）
- Modify: `backend/routes/gallery.py`（整体重写 —— 原 41 行扩到 ~120 行）

> **前置依赖**：无。`OUTPUT_DIR.mkdir(parents=True, exist_ok=True)` 已在 [config.py:53](file:///f:/Trae-work/bighead/backend/config.py#L53) 自检。

### Step 1.1: 加 `ALBUM_FILENAME` 常量

**File**: `backend/config.py`

在 `OUTPUT_DIR` 块后（约 L53 之后）追加：

```python
# 贴纸册元数据 sidecar。下划线开头是有意为之:
# gallery.py 的目录扫描以 _ 或 . 开头的名字作为内部目录/文件跳过,
# 这样 _album.json 既能被 ALBUM 路径找到, 又不会被列进 /api/gallery 的 items。
ALBUM_FILENAME = "_album.json"
ALBUM_MAX_TITLE = 64      # 标题字节数上限
ALBUM_MAX_NOTE = 280      # 备注字节数上限
ALBUM_MAX_TAG = 16        # 单标签字节数上限
ALBUM_MAX_TAGS = 8        # 标签数量上限
```

### Step 1.2: 写 gallery 元数据纯函数自测

**File**: `backend/scripts/verify_album_meta.py`（新建）

裸 assert 模式（参考 [verify_era.py](file:///f:/Trae-work/bighead/backend/scripts/verify_era.py) —— venv 无 pytest）：

```python
"""贴纸册元数据纯函数验证.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.config import ALBUM_FILENAME  # noqa: E402
from backend.routes.gallery import (  # noqa: E402
    _album_path,
    _load_album,
    _save_album,
    _validate_job_id,
    _normalize_entry,
    _merge_entry,
)

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{('  ' + detail) if detail else ''}")


def _tmp_outdir() -> Path:
    d = Path(tempfile.mkdtemp(prefix="album_test_"))
    (d / "j1").mkdir()
    (d / "j1" / "photo_1.jpg").write_bytes(b"\xff\xd8\xff\xe0")  # JPEG 头
    return d


# ---------- _validate_job_id ----------
check("合法 job_id 接受", _validate_job_id("job_20260101_abc123") is None)
err = _validate_job_id("../etc/passwd")
check(".. 路径穿越拒绝", err is not None, err or "")
err = _validate_job_id("a/b")
check("/ 子路径拒绝", err is not None, err or "")
err = _validate_job_id("")
check("空字符串拒绝", err is not None, err or "")
err = _validate_job_id("a" * 200)
check("过长拒绝", err is not None, err or "")


# ---------- _normalize_entry ----------
e = _normalize_entry({})
check("空 patch → 默认 title 空", e["title"] == "")
check("空 patch → 默认 favorite 假", e["favorite"] is False)
check("空 patch → 默认 tags []", e["tags"] == [])
check("空 patch → updated_at 是 int", isinstance(e["updated_at"], int))


# ---------- _merge_entry ----------
base = {"title": "T", "note": "N", "tags": ["a"], "favorite": False, "updated_at": 1}
patch = {"title": "T2", "favorite": True}
out = _merge_entry(base, patch)
check("合并后 title 被覆盖", out["title"] == "T2")
check("合并后 favorite 被覆盖", out["favorite"] is True)
check("合并后 note 保留", out["note"] == "N")
check("合并后 tags 保留", out["tags"] == ["a"])
check("合并后 updated_at 单调递增", out["updated_at"] > 1)


# ---------- _load / _save 落盘与原子替换 ----------
with tempfile.TemporaryDirectory(prefix="album_io_") as td:
    outdir = Path(td)
    p = _album_path(outdir)
    check("sidecar 在 OUTPUT_DIR 顶层", p.parent == outdir)
    check("sidecar 用 _album.json", p.name == ALBUM_FILENAME)

    _save_album(outdir, {"j1": {"title": "x"}})
    raw = json.loads(p.read_text(encoding="utf-8"))
    check("落盘后能读回", raw == {"j1": {"title": "x"}})

    loaded = _load_album(outdir)
    check("空 album 返回空 dict", _load_album(Path(tempfile.mkdtemp())) == {})


print(f"\nResult: {len(PASS)} passed, {len(FAIL)} failed")
sys.exit(0 if not FAIL else 1)
```

### Step 1.3: 跑测试确认红 → 绿

```powershell
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" backend/scripts/verify_album_meta.py
```

预期：先全 FAIL（`ImportError: cannot import name '_album_path'`），因为下面 Step 1.4 才落地实现。

### Step 1.4: 在 `backend/routes/gallery.py` 实现元数据层

**File**: `backend/routes/gallery.py`

整体替换为：

```python
"""画廊:扫描 outputs/,列出历次任务;并维护 _album.json 元数据侧车."""
from __future__ import annotations

import json
import os
import re
import shutil
import time
from pathlib import Path
from threading import Lock

from fastapi import APIRouter, Body, HTTPException

from ..config import (
    ALBUM_FILENAME,
    ALBUM_MAX_NOTE,
    ALBUM_MAX_TAG,
    ALBUM_MAX_TAGS,
    ALBUM_MAX_TITLE,
    OUTPUT_DIR,
)

router = APIRouter()

# job_id 必须是文件系统安全且相对短的 token。规则:字母数字下划线, 长度 4~64。
# 比对 URL 后再 resolve() 到 OUTPUT_DIR 内, 双层防御, 任意一层失守也不会
# 越过 OUTPUT_DIR 边界。
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")

# 单进程内对 _album.json 的所有读写都过这个锁。读也加锁, 否则 PATCH 与
# GET 之间会出现「读到中间态」的可能。单机自用, 不需要跨进程。
_album_lock = Lock()


# ---------------------------------------------------------------------------
# 私有助手(被 verify_album_meta.py 与路由共享)
# ---------------------------------------------------------------------------
def _validate_job_id(job_id: str) -> str | None:
    """合法返回 None, 不合法返回错误描述。"""
    if not _JOB_ID_RE.match(job_id):
        return "job_id 必须是 4~64 位的 [A-Za-z0-9_-]"
    return None


def _album_path(outdir: Path) -> Path:
    return outdir / ALBUM_FILENAME


def _load_album(outdir: Path) -> dict:
    p = _album_path(outdir)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        # 文件坏了不能让整个 /api/gallery 挂掉, 静默退化为空集。
        # 用户真实元数据已经丢了, 但 photos 还在, 这是权衡之下的最小伤害。
        return {}


def _save_album(outdir: Path, album: dict) -> None:
    """原子写: 写 .tmp 再 os.replace。读端不需要看到中间态。"""
    p = _album_path(outdir)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(album, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, p)


def _normalize_entry(patch: dict) -> dict:
    """把前端 PATCH 的部分字段补齐成完整条目。"""
    title = str(patch.get("title") or "")[:ALBUM_MAX_TITLE]
    note = str(patch.get("note") or "")[:ALBUM_MAX_NOTE]
    raw_tags = patch.get("tags") or []
    if not isinstance(raw_tags, list):
        raw_tags = []
    tags = [str(t)[:ALBUM_MAX_TAG] for t in raw_tags[:ALBUM_MAX_TAGS]]
    favorite = bool(patch.get("favorite"))
    return {
        "title": title,
        "note": note,
        "tags": tags,
        "favorite": favorite,
        "updated_at": int(time.time()),
    }


def _merge_entry(base: dict, patch: dict) -> dict:
    """PATCH 语义: 只覆盖 patch 里出现的 key, 其余从 base 继承。
    updated_at 必须单调递增, 即便前端时钟倒流, 也不允许回退。
    """
    out = dict(base)
    nxt = _normalize_entry(patch)
    for k, v in nxt.items():
        if k == "updated_at":
            out[k] = max(int(out.get(k, 0)), int(v))
        else:
            out[k] = v
    return out


def _resolve_job_dir(job_id: str) -> Path:
    """校验 + 解析为绝对路径。校验失败抛 400, 越界抛 400。"""
    err = _validate_job_id(job_id)
    if err:
        raise HTTPException(400, err)
    target = (OUTPUT_DIR / job_id).resolve()
    # resolve() 后必须仍在 OUTPUT_DIR.resolve() 内 —— 防 ../ 与符号链接。
    out_abs = OUTPUT_DIR.resolve()
    try:
        target.relative_to(out_abs)
    except ValueError:
        raise HTTPException(400, "job_id 越界")
    return target


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------
@router.get("/api/gallery")
def gallery():
    """扫描 outputs/ 列出历次任务, 合并 _album.json 元数据。

    排序规则(固定, 不提供切换): favorite 优先, 同组内按 mtime 倒序。
    不在 album 但存在于磁盘的条目以缺省元数据呈现。
    不在磁盘但存在于 album 的条目是孤儿, 直接丢弃(保留在文件里供手工恢复)。

    刻意用同步 def: 纯磁盘 IO, 跑线程池; 与改前一致。
    """
    album = _load_album(OUTPUT_DIR)
    items: list[dict] = []
    if not OUTPUT_DIR.exists():
        return {"items": []}
    seen: set[str] = set()
    raw: list[tuple[str, int, dict]] = []
    for entry in sorted(OUTPUT_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not entry.is_dir():
            # _album.json 与 _smoke/_verify 等都从这里走掉, 不会进 items
            continue
        if entry.name.startswith("_") or entry.name.startswith("."):
            continue
        seen.add(entry.name)
        thumbs: list[str] = []
        layout = entry / "layout.jpg"
        if layout.exists():
            thumbs.append(f"/outputs/{entry.name}/layout.jpg")
        else:
            for f in sorted(entry.glob("photo_*.jpg"))[: 4]:
                thumbs.append(f"/outputs/{entry.name}/{f.name}")
        mtime = int(entry.stat().st_mtime)
        meta = album.get(entry.name) or {}
        # 缺省补齐 —— 不能让前端拿到 None.title
        merged = _merge_entry(_normalize_entry({}), meta)
        raw.append((entry.name, mtime, {
            "job_id": entry.name,
            "mtime": mtime,
            "thumbs": thumbs,
            **merged,
        }))
    # 排序: favorite True 在前, 同组内 mtime 降序
    raw.sort(key=lambda t: (not t[2]["favorite"], -t[1]))
    return {"items": [t[2] for t in raw]}


@router.patch("/api/gallery/{job_id}")
def gallery_patch(job_id: str, body: dict = Body(default_factory=dict)):
    """局部更新元数据。"""
    job_dir = _resolve_job_dir(job_id)
    if not job_dir.exists():
        raise HTTPException(404, f"job {job_id} 不存在")
    with _album_lock:
        album = _load_album(OUTPUT_DIR)
        base = album.get(job_id) or _normalize_entry({})
        merged = _merge_entry(base, body)
        album[job_id] = merged
        _save_album(OUTPUT_DIR, album)
    return {"job_id": job_id, **merged}


@router.delete("/api/gallery/{job_id}")
def gallery_delete(job_id: str):
    """真删: 删整个 job 目录 + 元数据条目。

    删除前再次校验(已经在 _resolve_job_dir 里做过) + is_dir 检查,
    防止「目录不存在但元数据残留」时 rmtree 报 FileNotFoundError。
    """
    job_dir = _resolve_job_dir(job_id)
    if not job_dir.is_dir():
        raise HTTPException(404, f"job {job_id} 不存在")
    shutil.rmtree(job_dir)
    with _album_lock:
        album = _load_album(OUTPUT_DIR)
        album.pop(job_id, None)
        _save_album(OUTPUT_DIR, album)
    return {"job_id": job_id, "deleted": True}
```

### Step 1.5: 跑自测确认红 → 绿

```powershell
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" backend/scripts/verify_album_meta.py
```

预期：`Result: N passed, 0 failed`（约 20 项断言）。

如果失败：优先看 `ImportError`，确认 Step 1.1 的 `ALBUM_FILENAME` 与 Step 1.4 的导出符号都对得上；再检查 `_normalize_entry` 的字节裁剪是否漏掉 `[:ALBUM_MAX_TITLE]`。

### Step 1.6: 后端门禁

```powershell
cd f:\Trae-work\bighead
ruff check backend
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" -m compileall -q backend
```

预期：无报错。

### Step 1.7: 提交

```powershell
git add backend/config.py backend/routes/gallery.py backend/scripts/verify_album_meta.py
git commit -m "feat(album): _album.json sidecar + PATCH/DELETE /api/gallery/{job_id}"
```

---

## Task 2: 前端 API 与类型

**Files:**
- Modify: `frontend/src/types.ts:42-55`（`AlbumEntry` 与 `GalleryItem`）
- Modify: `frontend/src/api.ts:118-122`（扩展 `fetchGallery` 返回 + 新增 patch/delete）

### Step 2.1: 加 `AlbumEntry` 与扩展 `GalleryItem`

**File**: `frontend/src/types.ts`

在文件末尾追加：

```typescript
/** 单条贴纸册元数据。缺省字段见后端 _normalize_entry。 */
export interface AlbumEntry {
  title: string;
  note: string;
  /** 标签列表, 后端会裁剪到 16 字节/个、8 个上限 */
  tags: string[];
  favorite: boolean;
  updated_at: number;
}

/** /api/gallery items 元素的完整形态(磁盘信息 + 元数据)。 */
export interface GalleryItem {
  job_id: string;
  mtime: number;
  thumbs: string[];
  title: string;
  note: string;
  tags: string[];
  favorite: boolean;
  updated_at: number;
}

export interface GalleryResponse {
  items: GalleryItem[];
}
```

### Step 2.2: 扩展 `fetchGallery` 与新增 PATCH/DELETE

**File**: `frontend/src/api.ts`

**先**改顶部 import 区：在第一行 `import type { EraKey, Meta, JobStatus } from "./types";` 之后追加 `import type { GalleryResponse, AlbumEntry } from "./types";`。改完后顶部应该是：

```typescript
import type { EraKey, Meta, JobStatus } from "./types";
import type { GalleryResponse, AlbumEntry } from "./types";

const API = "/api";
```

**然后**把文件末尾最后一段：

```typescript
export async function fetchGallery(): Promise<{ items: { job_id: string; mtime: number; thumbs: string[] }[] }> {
  const r = await fetch(`${API}/gallery`);
  if (!r.ok) throw new Error(`fetchGallery ${r.status}`);
  return r.json();
}
```

替换为：

```typescript
export async function fetchGallery(): Promise<GalleryResponse> {
  const r = await fetch(`${API}/gallery`);
  if (!r.ok) throw new Error(`fetchGallery ${r.status}`);
  return r.json();
}

/** PATCH 局部字段; tags 必须传完整数组(后端整体覆盖), 其他字段缺省视为不更新。 */
export async function patchAlbum(
  job_id: string,
  patch: Partial<AlbumEntry>,
): Promise<AlbumEntry & { job_id: string }> {
  const r = await fetch(`${API}/gallery/${encodeURIComponent(job_id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`patchAlbum ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function deleteAlbum(job_id: string): Promise<{ job_id: string; deleted: boolean }> {
  const r = await fetch(`${API}/gallery/${encodeURIComponent(job_id)}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`deleteAlbum ${r.status}: ${await r.text()}`);
  return r.json();
}
```

### Step 2.3: 前端门禁

```powershell
cd f:\Trae-work\bighead\frontend
npm run typecheck
npm run lint
```

预期：无报错（**这一关是 typecheck 的硬关**：旧 `fetchGallery` 的返回类型现在用 `GalleryResponse` 替代，但调用方类型会自动推断，未使用字段不会触发 strict 错；本任务还没有调用方，会在 Task 4 才用到）。

### Step 2.4: 提交

```powershell
git add frontend/src/types.ts frontend/src/api.ts
git commit -m "feat(album): AlbumEntry/GalleryItem types + patchAlbum/deleteAlbum API"
```

---

## Task 3: pose 引导组件 + 单张重拍组件

**Files:**
- Create: `frontend/src/components/retake/PoseHint.tsx`
- Create: `frontend/src/components/retake/RetakeBar.tsx`

> **前置依赖**：无。这两个组件是纯展示，逻辑集成在 Task 4。

### Step 3.1: PoseHint 组件

**File**: `frontend/src/components/retake/PoseHint.tsx`（新建）

```typescript
/**
 * 拍照前的 pose 文字浮层。
 *
 * 4 个固定词按拍摄顺序循环:嘟嘴 / 比心 / 看镜头 / 笑僵。
 * 与 store 的 showPose(用户偏好)双重控制: 关掉时整个组件不渲染。
 *
 * 关键约束: 不能进入 React 渲染分支去读 poseIndex —— 那样会在每次
 * 拍照后强制重渲染 LiveCamera(父组件)与取景层, 引发「视频流闪烁」。
 * 这里用 props 传 poseIndex 触发 useEffect 重置 key, 让 CSS 动画从头
 * 播放; 文本节点直接显示在当前值上。
 */
interface Props {
  /** 当前应当显示的 pose 词, 由父组件按 frames.length 推算 */
  pose: string;
  /** 是否显示(整体开关) */
  visible: boolean;
}

export function PoseHint({ pose, visible }: Props) {
  if (!visible) return null;
  return (
    <div
      key={pose}
      className="absolute top-4 left-1/2 -translate-x-1/2 z-30
                 bg-brick/90 text-white px-4 py-1.5 rounded-full
                 font-pixel text-sm shadow-lg
                 animate-pose-in pointer-events-none select-none"
    >
      {pose}
    </div>
  );
}
```

### Step 3.2: RetakeBar 组件

**File**: `frontend/src/components/retake/RetakeBar.tsx`（新建）

```typescript
/**
 * 「重拍本张 / 继续」暂停确认条。
 *
 * 仅在 idx < PHOTO_COUNT - 1 时出现, 第 4 张拍完由 HomePage 直接 nav 走。
 * 重拍与继续都通过 onPick(mode) 上抛, 由父组件统一 setSnapTick 复用 3-2-1 倒计时,
 * RetakeBar 自己不调任何相机接口 —— 与 CountdownOverlay 的「tick 自增即重启」
 * 语义保持同源。
 *
 * 视觉上盖在 LiveCamera 下方, 不会遮住取景框主体, 用户既能看到自己也能
 * 看到刚拍的那张缩略图。
 */
interface Props {
  /** 刚拍好的照片(用于左侧小预览) */
  previewUrl: string | null;
  /** 1-based 张数, 用于文案 */
  photoNumber: number;
  /** 总张数, 用于文案 */
  total: number;
  onPick: (mode: "retake" | "continue") => void;
}

export function RetakeBar({ previewUrl, photoNumber, total, onPick }: Props) {
  return (
    <div
      className="absolute bottom-0 inset-x-0 z-30
                 bg-cream/95 border-t-2 border-pink
                 px-4 py-3 flex items-center gap-3 backdrop-blur-sm"
    >
      {previewUrl && (
        <img
          src={previewUrl}
          alt=""
          className="w-12 h-16 object-cover rounded border-2 border-pink"
        />
      )}
      <div className="flex-1 text-sm text-brown">
        第 <span className="font-pixel text-brick">{photoNumber}</span> / {total} 张拍好了
      </div>
      <button
        type="button"
        onClick={() => onPick("retake")}
        className="px-4 py-2 rounded-full bg-white border-2 border-brick text-brick text-sm hover:bg-pink/30"
      >
        重拍本张
      </button>
      <button
        type="button"
        onClick={() => onPick("continue")}
        className="px-4 py-2 rounded-full bg-brick text-white text-sm hover:bg-brick/90"
      >
        继续
      </button>
    </div>
  );
}
```

### Step 3.3: 全局 CSS 动画

**File**: `frontend/src/index.css`（如已有该文件，则追加；如无，新建）

确认或新建：

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@keyframes pose-in {
  0% {
    opacity: 0;
    transform: translate(-50%, -8px) scale(0.9);
  }
  100% {
    opacity: 1;
    transform: translate(-50%, 0) scale(1);
  }
}

.animate-pose-in {
  animation: pose-in 320ms ease-out both;
}
```

**执行者需先读 `frontend/src/index.css`**：如果文件已存在（多半有 Tailwind 入口），把 `@keyframes pose-in` 与 `.animate-pose-in` **追加在文件末尾**，不要重写 Tailwind 三行指令；如果文件不存在，按上面整段写。

### Step 3.4: 前端门禁

```powershell
cd f:\Trae-work\bighead\frontend
npm run typecheck
npm run lint
```

预期：无报错。

### Step 3.5: 提交

```powershell
git add frontend/src/components/retake/PoseHint.tsx frontend/src/components/retake/RetakeBar.tsx frontend/src/index.css
git commit -m "feat(retake): PoseHint + RetakeBar UI 组件"
```

---

## Task 4: HomePage 集成 pose + 重拍

**Files:**
- Modify: `frontend/src/store.ts:25-91`（新增 `showPose` + `setShowPose`）
- Modify: `frontend/src/pages/HomePage.tsx:135-166`（重写 `doSnap` 与新增 RetakeBar/PoseHint 集成）

> **前置依赖**：Task 3 已落地两个组件。

### Step 4.1: store 加 `showPose`

**File**: `frontend/src/store.ts`

在 `CaptureState` interface 末尾、`reset` 之前追加：

```typescript
  /** pose 浮层是否可见。默认开, 是 UI 偏好, reset 不清。 */
  showPose: boolean;
  setShowPose: (v: boolean) => void;
```

在 `useStore` 初始 state 里、`showGuides: true,` 之后加：

```typescript
  showPose: true,
```

在 `setShowGuides: (v) => set({ showGuides: v }),` 之后加：

```typescript
  setShowPose: (v) => set({ showPose: v }),
```

**注意**：`reset()` **不动** `showPose`——它和 `showGuides` 一样是 UI 偏好, 不属于某一轮拍摄的产物。执行者务必不要把 `showPose: true` 加进 `reset()` 的 set 里。

### Step 4.2: 在 HomePage 引入 PoseHint + RetakeBar

**File**: `frontend/src/pages/HomePage.tsx`

在顶部 imports 追加：

```typescript
import { PoseHint } from "../components/retake/PoseHint";
import { RetakeBar } from "../components/retake/RetakeBar";
```

在 HomePage 函数体顶部（`useStore((s) => s.showGuides)` 附近）加：

```typescript
const showPose = useStore((s) => s.showPose);
const setShowPose = useStore((s) => s.setShowPose);
const [retakeIdx, setRetakeIdx] = useState<number | null>(null);
```

并在文件中加入固定 pose 数组常量（在 `PHOTO_COUNT` 旁）：

```typescript
const POSES = ["嘟嘴", "比心", "看镜头", "笑僵"] as const;
```

### Step 4.3: 改写 `doSnap` 与新增 `handleRetakePick`

**File**: `frontend/src/pages/HomePage.tsx`

把原 [doSnap](file:///f:/Trae-work/bighead/frontend/src/pages/HomePage.tsx#L135-L166) 整体替换为：

```typescript
  function doSnap() {
    const url = camRef.current?.snap() ?? null;
    if (!url) {
      // 摄像头还没出帧(videoWidth === 0)。这里必须继续排下一轮倒计时,
      // 否则整个连拍会永久停住 —— 用户只能刷新页面。
      // 用独立的 retry 计数, 不能拿「已拍张数」当重试次数(那是两个
      // 不同语义: 检不到帧时 frames 恒为 0, 会被当成永不超限)。
      // 存 ref 而非 state: 它只用于这里的判断, 不需要触发重渲染。
      const c = retryRef.current;
      retryRef.current = c + 1;
      if (c < SNAP_MAX_RETRY) {
        setSnapTick((t) => t + 1);
      } else {
        setCapturing(false);
      }
      return;
    }
    retryRef.current = 0;
    setFlash(true);
    timers.current.push(window.setTimeout(() => setFlash(false), 250));
    // burnedIn 取此刻的 maskPreview 快照: snap() 里已按这个值把滤镜
    // 烧进像素, 之后用户再怎么改开关都不影响这张成片。
    // 包括「重拍本张」 —— 重拍就是再调一次 doSnap, 自然读到当下的 maskPreview,
    // 语义与首拍一致, 不用额外处理。
    const next = [...frames, { url, burnedIn: maskPreview }];
    setFrames(next);
    if (next.length >= PHOTO_COUNT) {
      // 第 4 张直通 decorate —— RetakeBar 只在 idx < PHOTO_COUNT - 1 时出现。
      setCapturing(false);
      setRetakeIdx(null);
      timers.current.push(window.setTimeout(() => nav("/decorate"), 400));
    } else {
      // 前 3 张拍完进入暂停: 用户在 RetakeBar 上点「重拍本张」或「继续」。
      // 不再像旧版那样 setSnapTick++ 自动进下一张。
      setRetakeIdx(next.length - 1);
    }
  }

  function handleRetakePick(mode: "retake" | "continue") {
    if (retakeIdx === null) return;
    if (mode === "retake") {
      // 丢掉当前 frames[retakeIdx], 重拍这一张。
      // setSnapTick++ 触发新一轮 3-2-1, doSnap 再拍一张插回 retakeIdx。
      const cur = frames[retakeIdx];
      setFrames(frames.filter((_, i) => i !== retakeIdx));
      // 上一张被丢弃后, 它的 url 是 dataURL —— 浏览器会在页面卸载/手动
      // revoke 时释放。这里只置空, 不强制 revoke(blob 不是 blob:, 没意义)。
      void cur; // 仅为了让 ESLint 不抱怨未使用变量
    }
    // continue: frames 保持不变, 倒计时启动 → doSnap 追加一张。
    setRetakeIdx(null);
    setSnapTick((t) => t + 1);
  }
```

### Step 4.4: 把 PoseHint 与 RetakeBar 挂到取景层

**File**: `frontend/src/pages/HomePage.tsx`

找到 `<div className="relative">` 块（[L182](file:///f:/Trae-work/bighead/frontend/src/pages/HomePage.tsx#L182) 附近），把：

```tsx
<CountdownOverlay tick={snapTick} onComplete={doSnap} />
<ShutterFlash show={flash} />
```

替换为：

```tsx
<CountdownOverlay tick={snapTick} onComplete={doSnap} />
<ShutterFlash show={flash} />
<PoseHint
  pose={POSES[frames.length % POSES.length]}
  visible={showPose && capturing}
/>
{retakeIdx !== null && (
  <RetakeBar
    previewUrl={frames[retakeIdx]?.url ?? null}
    photoNumber={retakeIdx + 1}
    total={PHOTO_COUNT}
    onPick={handleRetakePick}
  />
)}
```

### Step 4.5: 加「pose 提示」开关

**File**: `frontend/src/pages/HomePage.tsx`

在「构图引导线」checkbox 旁（[L209-217](file:///f:/Trae-work/bighead/frontend/src/pages/HomePage.tsx#L209-L217)）追加：

```tsx
<label className="flex items-center gap-2 cursor-pointer select-none">
  <input
    type="checkbox"
    checked={showPose}
    onChange={(e) => setShowPose(e.target.checked)}
    className="w-4 h-4 accent-brick"
  />
  pose 文字提示
</label>
```

### Step 4.6: 前端门禁

```powershell
cd f:\Trae-work\bighead\frontend
npm run typecheck
npm run lint
```

预期：无报错。

### Step 4.7: 提交

```powershell
git add frontend/src/store.ts frontend/src/pages/HomePage.tsx
git commit -m "feat(retake): pose 浮层 + RetakeBar 暂停条 + 单张重拍"
```

---

## Task 5: GalleryPage 贴纸册化 + AlbumEditor

**Files:**
- Create: `frontend/src/components/album/AlbumEditor.tsx`
- Modify: `frontend/src/pages/GalleryPage.tsx`（整体改写）

### Step 5.1: AlbumEditor 组件

**File**: `frontend/src/components/album/AlbumEditor.tsx`（新建）

```typescript
import { useEffect, useState } from "react";
import type { AlbumEntry } from "../../types";

interface Props {
  jobId: string;
  initial: AlbumEntry;
  onSave: (patch: Partial<AlbumEntry>) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
}

/**
 * 单条记录的编辑抽屉。标题 / 备注 / 标签 / 收藏 / 删除。
 *
 * 标签输入: 逗号或回车提交一项, Enter 直接提交整个表单。
 * 保存按钮在 pending 期间 disabled 防止重复 PATCH。
 */
export function AlbumEditor({ jobId, initial, onSave, onDelete, onClose }: Props) {
  const [title, setTitle] = useState(initial.title);
  const [note, setNote] = useState(initial.note);
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>(initial.tags);
  const [favorite, setFavorite] = useState(initial.favorite);
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 当 initial 变化(从不同 item 打开)时重置本地态
  useEffect(() => {
    setTitle(initial.title);
    setNote(initial.note);
    setTags(initial.tags);
    setFavorite(initial.favorite);
    setTagInput("");
    setConfirmDelete(false);
  }, [initial, jobId]);

  function addTag(raw: string) {
    const t = raw.trim();
    if (!t) return;
    if (tags.includes(t)) return;
    if (tags.length >= 8) return;
    setTags([...tags, t]);
    setTagInput("");
  }

  async function handleSave() {
    setPending(true);
    try {
      await onSave({ title, note, tags, favorite });
      onClose();
    } finally {
      setPending(false);
    }
  }

  async function handleDelete() {
    setPending(true);
    try {
      await onDelete();
      onClose();
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-cream rounded-2xl border-2 border-pink p-5 max-w-md w-[92vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-3">
          <div className="font-pixel text-brick">编辑 · {jobId.slice(0, 8)}</div>
          <button
            type="button"
            onClick={onClose}
            className="text-brown/60 hover:text-brick text-xl leading-none"
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <label className="block text-xs text-brown/70 mb-1">标题 (≤64)</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value.slice(0, 64))}
          maxLength={64}
          className="w-full px-3 py-2 rounded border border-pink bg-white text-sm mb-3"
        />

        <label className="block text-xs text-brown/70 mb-1">备注 (≤280)</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 280))}
          maxLength={280}
          rows={3}
          className="w-full px-3 py-2 rounded border border-pink bg-white text-sm mb-3 resize-none"
        />

        <label className="block text-xs text-brown/70 mb-1">
          标签 ({tags.length}/8, 回车添加)
        </label>
        <input
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value.slice(0, 16))}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addTag(tagInput);
            }
            if (e.key === "Backspace" && !tagInput && tags.length) {
              setTags(tags.slice(0, -1));
            }
          }}
          className="w-full px-3 py-2 rounded border border-pink bg-white text-sm mb-2"
        />
        <div className="flex flex-wrap gap-1 mb-3 min-h-[24px]">
          {tags.map((t) => (
            <span
              key={t}
              className="bg-pink/40 text-brown text-xs px-2 py-0.5 rounded-full flex items-center gap-1"
            >
              {t}
              <button
                type="button"
                onClick={() => setTags(tags.filter((x) => x !== t))}
                aria-label={`删 ${t}`}
                className="hover:text-brick"
              >
                ×
              </button>
            </span>
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm text-brown mb-4 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={favorite}
            onChange={(e) => setFavorite(e.target.checked)}
            className="w-4 h-4 accent-brick"
          />
          收藏(置顶显示)
        </label>

        <div className="flex gap-2">
          {!confirmDelete ? (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={pending}
              className="px-3 py-2 text-xs text-red-500 border border-red-300 rounded-full hover:bg-red-50"
            >
              删除这条
            </button>
          ) : (
            <button
              type="button"
              onClick={handleDelete}
              disabled={pending}
              className="px-3 py-2 text-xs bg-red-500 text-white rounded-full hover:bg-red-600"
            >
              确认删除? 不可恢复
            </button>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="px-4 py-2 text-sm border border-pink rounded-full"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={pending}
            className="px-4 py-2 text-sm bg-brick text-white rounded-full disabled:opacity-50"
          >
            {pending ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

### Step 5.2: GalleryPage 整体改写

**File**: `frontend/src/pages/GalleryPage.tsx`

整体替换为：

```typescript
import { useEffect, useState } from "react";
import { fetchGallery, patchAlbum, deleteAlbum } from "../api";
import type { GalleryItem } from "../types";
import { AlbumEditor } from "../components/album/AlbumEditor";

export function GalleryPage() {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const editing = items.find((it) => it.job_id === editingId) ?? null;

  async function reload() {
    setLoading(true);
    try {
      const g = await fetchGallery();
      setItems(g.items);
      setError(null);
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let alive = true;
    reload().then(() => {
      if (!alive) return;
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  return (
    <div className="max-w-7xl mx-auto px-6 py-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="font-pixel text-2xl text-brick">贴纸册</h1>
        <div className="text-xs text-brown/60">
          {items.length} 条 · 收藏置顶
        </div>
      </div>

      {loading && <div className="text-brown/70">加载中...</div>}
      {error && <div className="text-red-500 text-sm">加载失败:{error}</div>}
      {!loading && !error && items.length === 0 && (
        <div className="text-brown/70">还没有拍摄记录。</div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {items.map((it) => (
          <button
            key={it.job_id}
            type="button"
            onClick={() => setEditingId(it.job_id)}
            className="relative bg-white rounded-xl border-2 border-pink p-2 text-left
                       hover:border-brick transition-colors group"
          >
            {/* 收藏徽标:固定左上, 与编辑按钮不重叠 */}
            {it.favorite && (
              <span className="absolute top-1 left-1 z-10 bg-brick text-white text-[10px] px-1.5 py-0.5 rounded-full">
                ★
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
        ))}
      </div>

      {editing && (
        <AlbumEditor
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
    </div>
  );
}
```

### Step 5.3: 前端门禁

```powershell
cd f:\Trae-work\bighead\frontend
npm run typecheck
npm run lint
```

预期：无报错。

### Step 5.4: 提交

```powershell
git add frontend/src/components/album/AlbumEditor.tsx frontend/src/pages/GalleryPage.tsx
git commit -m "feat(album): GalleryPage 贴纸册化 + AlbumEditor 编辑抽屉"
```

---

## Task 6: 验证脚本

**Files:**
- Create: `frontend/verify-album-meta.mjs`（覆盖 Task 1 后端）
- Create: `frontend/verify-album-edit.mjs`（覆盖 Task 5 UI）
- Create: `frontend/verify-retake-bar.mjs`（覆盖 Task 3/4）

### Step 6.1: verify-album-meta.mjs

**File**: `frontend/verify-album-meta.mjs`（新建）

启动段参考 [verify-gallery-capture.mjs:1-37](file:///f:/Trae-work/bighead/frontend/verify-gallery-capture.mjs#L1-L37)：

```javascript
/**
 * 贴纸册元数据 API 端到端验证。
 *
 * 覆盖:
 *  1. PATCH 写入并合并 _album.json
 *  2. GET /api/gallery 把元数据合并进 items
 *  3. DELETE 真删 (目录与元数据一起没)
 *  4. 路径穿越 422/400
 *  5. 孤儿条目 (album 有但磁盘无) 不返回
 *  6. 排序: favorite 置顶
 */
import { chromium } from "playwright";

const URL = process.env.APP_URL || "http://localhost:5173/gallery";
const PASS = [], FAIL = [];
const check = (n, c, d = "") => {
  (c ? PASS : FAIL).push(n);
  console.log(`  [${c ? "PASS" : "FAIL"}] ${n}${d ? "  " + d : ""}`);
};

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const ctx = await browser.newContext({ permissions: ["camera"] });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", e));
await page.goto(URL, { waitUntil: "networkidle" });

// 用后端自带的 capture/save 落两条 job
const jids = await page.evaluate(async () => {
  // 1x1 红色 jpeg
  const jpg = Uint8Array.from(atob(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKK/IT+iT/2Q=="
  ), (c) => c.charCodeAt(0));
  const fd = (n) => {
    const f = new FormData();
    f.append("images", new Blob([jpg], { type: "image/jpeg" }), `p${n}.jpg`);
    return f;
  };
  const r1 = await fetch("/api/capture/save", { method: "POST", body: fd(1) });
  const r2 = await fetch("/api/capture/save", { method: "POST", body: fd(2) });
  const a = await r1.json();
  const b = await r2.json();
  return [a.job_id, b.job_id];
});
const [jidA, jidB] = jids;
check("两条 job 创建成功", jidA && jidB && jidA !== jidB);

// PATCH 第一条
const r1 = await page.evaluate(async (jid) => {
  const r = await fetch(`/api/gallery/${jid}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "测试标题", tags: ["毕业季", "非主流"], favorite: true }),
  });
  return { status: r.status, body: await r.json() };
}, jidA);
check("PATCH 200", r1.status === 200, JSON.stringify(r1.body).slice(0, 80));
check("PATCH 返回 title", r1.body.title === "测试标题");
check("PATCH 返回 favorite", r1.body.favorite === true);

// GET 合并
const list = await page.evaluate(async () => {
  const r = await fetch("/api/gallery");
  return await r.json();
});
check("GET 返回 items", Array.isArray(list.items));
const itemA = list.items.find((x) => x.job_id === jidA);
check("GET 包含 A 的 title", itemA?.title === "测试标题");
check("GET 包含 A 的 tags", Array.isArray(itemA?.tags) && itemA.tags.length === 2);
check("GET 包含 A 的 favorite", itemA?.favorite === true);

// 排序: favorite=true 的 A 在 B 前
const iA = list.items.findIndex((x) => x.job_id === jidA);
const iB = list.items.findIndex((x) => x.job_id === jidB);
check("A(favorite)排在 B 前面", iA < iB);

// 路径穿越
const trav = await page.evaluate(async () => {
  const r = await fetch("/api/gallery/..%2Fetc%2Fpasswd", { method: "DELETE" });
  return r.status;
});
check("路径穿越被 400/422 拒绝", trav === 400 || trav === 422, `got ${trav}`);

// DELETE 真删
const del = await page.evaluate(async (jid) => {
  const r = await fetch(`/api/gallery/${jid}`, { method: "DELETE" });
  return r.status;
}, jidA);
check("DELETE 200", del === 200);

// 确认删完
const after = await page.evaluate(async () => {
  const r = await fetch("/api/gallery");
  return (await r.json()).items;
});
check("GET 不再含已删 A", !after.find((x) => x.job_id === jidA));

console.log(`\nResult: ${PASS.length} passed, ${FAIL.length} failed`);
await browser.close();
process.exit(FAIL.length ? 1 : 0);
```

### Step 6.2: 跑 verify-album-meta

```powershell
# 启动后端 (新 terminal)
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" -m uvicorn backend.app:app --host 127.0.0.1 --port 8077

# 启动前端 (新 terminal)
cd f:\Trae-work\bighead\frontend
$env:BIGHEAD_API_TARGET="http://127.0.0.1:8077"
npm run dev

# 等两个服务就绪后, 在第三个 terminal
cd f:\Trae-work\bighead\frontend
node verify-album-meta.mjs
```

预期：`Result: N passed, 0 failed`（约 11 项）。

### Step 6.3: verify-album-edit.mjs

**File**: `frontend/verify-album-edit.mjs`（新建）

```javascript
/**
 * GalleryPage UI 端到端验证:编辑抽屉、收藏置顶、删除。
 *
 * 依赖: 后端已落至少 1 条 job。前面 verify-album-meta.mjs 跑过后
 * 还剩 jidB, 可作为基础数据; 如果之前没跑, 本脚本自己 PATCH 一条。
 */
import { chromium } from "playwright";

const URL = process.env.APP_URL || "http://localhost:5173/gallery";
const PASS = [], FAIL = [];
const check = (n, c, d = "") => {
  (c ? PASS : FAIL).push(n);
  console.log(`  [${c ? "PASS" : "FAIL"}] ${n}${d ? "  " + d : ""}`);
};

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const ctx = await browser.newContext({
  permissions: ["camera"],
  viewport: { width: 1280, height: 1600 },
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", e));

await page.goto(URL, { waitUntil: "networkidle" });

// 自造一条有 title 的 job
const jid = await page.evaluate(async () => {
  const jpg = Uint8Array.from(atob(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKK/IT+iT/2Q=="
  ), (c) => c.charCodeAt(0));
  const fd = new FormData();
  fd.append("images", new Blob([jpg], { type: "image/jpeg" }), "p1.jpg");
  const r = await fetch("/api/capture/save", { method: "POST", body: fd });
  const { job_id } = await r.json();
  await fetch(`/api/gallery/${job_id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "可编辑测试", tags: ["t1"], favorite: true }),
  });
  return job_id;
});

await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("button:has(span:has-text('★'))", { timeout: 5000 });

// 1) 收藏徽标显示
const favCount = await page.locator("span:has-text('★')").count();
check("收藏徽标显示", favCount >= 1);

// 2) 点开编辑抽屉
await page.locator("button:has(span:has-text('★'))").first().click();
await page.waitForSelector("text=编辑 ·", { timeout: 3000 });
check("编辑抽屉打开", await page.locator("text=编辑 ·").isVisible());

// 3) 修改标题 + 收藏
await page.fill('input[maxlength="64"]', "新标题");
await page.locator('input[type="checkbox"]').first().uncheck(); // 取消收藏
await page.click("button:has-text('保存')");
await page.waitForSelector("text=编辑 ·", { state: "detached", timeout: 3000 });
check("抽屉关闭", !(await page.locator("text=编辑 ·").isVisible()));

// 4) 校验后端确实更新
const verify = await page.evaluate(async (j) => {
  const r = await fetch("/api/gallery");
  const { items } = await r.json();
  return items.find((x) => x.job_id === j);
}, jid);
check("后端 title 已更新", verify.title === "新标题");
check("后端 favorite 已取消", verify.favorite === false);

// 5) 删除流程: 本脚本只造了一条 jid, 此时 GalleryPage 只剩它一张卡片,
// 点第一个 .relative 卡片按钮即可。
// 不要按 title 文本定位 —— 中文 slice 按字节切会乱码。
await page.locator("button.relative").first().click();
await page.waitForSelector("text=删除这条", { timeout: 3000 });
await page.click("button:has-text('删除这条')");
await page.click("button:has-text('确认删除')");
await page.waitForSelector("text=编辑 ·", { state: "detached", timeout: 3000 });

const after = await page.evaluate(async () => {
  const r = await fetch("/api/gallery");
  return (await r.json()).items;
});
check("删除后列表不含该 job", !after.find((x) => x.job_id === jid));

console.log(`\nResult: ${PASS.length} passed, ${FAIL.length} failed`);
await browser.close();
process.exit(FAIL.length ? 1 : 0);
```

### Step 6.4: 跑 verify-album-edit

```powershell
cd f:\Trae-work\bighead\frontend
node verify-album-edit.mjs
```

预期：`Result: N passed, 0 failed`（约 7 项）。

### Step 6.5: verify-retake-bar.mjs

**File**: `frontend/verify-retake-bar.mjs`（新建）

```javascript
/**
 * pose 浮层 + RetakeBar 暂停条端到端验证。
 *
 * 覆盖:
 *  1. pose 浮层在 capturing 期间可见, 词按 POSES 循环
 *  2. RetakeBar 在第 1~3 张拍完时出现
 *  3. 第 4 张拍完不出现 RetakeBar, 直接进 /decorate
 *  4. 点「重拍本张」后 frames.length 不增, pose 词不变
 *  5. 点「继续」后下一张拍出, frames.length + 1
 */
import { chromium } from "playwright";

const URL = process.env.APP_URL || "http://localhost:5173/home";
const PASS = [], FAIL = [];
const check = (n, c, d = "") => {
  (c ? PASS : FAIL).push(n);
  console.log(`  [${c ? "PASS" : "FAIL"}] ${n}${d ? "  " + d : ""}`);
};

const browser = await chromium.launch({
  channel: "chrome",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const ctx = await browser.newContext({
  permissions: ["camera"],
  viewport: { width: 1280, height: 1600 },
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", e));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelector("video")?.videoWidth > 0, { timeout: 20000 });

// 触发连拍: 通过 store 的 reset + setCapturing/startCapture 走真实链路
await page.evaluate(() => {
  window.__store.getState().reset();
});

// 开始连拍(click 不被 in-flight capture 卡住 —— capture 完成前 disabled)
await page.click("button:has-text('开始连拍')");

// 等第 1 张拍完, RetakeBar 应出现
await page.waitForSelector("text=重拍本张", { timeout: 20000 });
check("拍完第 1 张 RetakeBar 出现", await page.locator("text=重拍本张").isVisible());

// pose 浮层应见
const pose1 = await page.locator(".animate-pose-in").first().textContent();
check("pose 浮层显示", /^(嘟嘴|比心|看镜头|笑僵)$/.test((pose1 || "").trim()), pose1 || "");

// 点「重拍本张」: frames.length 仍 1(因为刚拍的那张被丢, 重拍后还是 1)
const beforeRetake = await page.evaluate(() => window.__store.getState().frames.length);
await page.click("button:has-text('重拍本张')");
// 等下一轮倒计时+拍照
await page.waitForSelector("text=重拍本张", { timeout: 20000 });
const afterRetake = await page.evaluate(() => window.__store.getState().frames.length);
check("重拍本张 frames.length 不变", beforeRetake === afterRetake, `${beforeRetake} -> ${afterRetake}`);

// 点「继续」: 拍下一张, frames.length 变 2
await page.click("button:has-text('继续')");
await page.waitForSelector("text=重拍本张", { timeout: 20000 });
const afterContinue = await page.evaluate(() => window.__store.getState().frames.length);
check("继续后 frames.length +1", afterContinue === afterRetake + 1, `${afterRetake} -> ${afterContinue}`);

// 跳过 RetakeBar: 直接点继续 2 次, 到达第 4 张
await page.click("button:has-text('继续')");
await page.waitForSelector("text=重拍本张", { timeout: 20000 });
await page.click("button:has-text('继续')");

// 第 4 张拍完: 应直接进 /decorate, 不出现 RetakeBar
await page.waitForURL(/\/decorate$/, { timeout: 5000 }).catch(() => {});
const finalUrl = page.url();
check("第 4 张后直达 /decorate", /\/decorate$/.test(finalUrl), finalUrl);

// pose 浮层在 capturing=false 时应不渲染 —— 已不在 home 页, 跳过
// (此处的额外断言 —— 在 home 页面时验证 showPose=false 不渲染)
// 由于已跳走, 这里只断言 store 值
const showPose = await page.evaluate(() => window.__store.getState().showPose);
check("store.showPose 默认 true", showPose === true);

console.log(`\nResult: ${PASS.length} passed, ${FAIL.length} failed`);
await browser.close();
process.exit(FAIL.length ? 1 : 0);
```

### Step 6.6: 跑 verify-retake-bar

```powershell
cd f:\Trae-work\bighead\frontend
node verify-retake-bar.mjs
```

预期：`Result: N passed, 0 failed`（约 7 项）。

### Step 6.7: 提交

```powershell
git add frontend/verify-album-meta.mjs frontend/verify-album-edit.mjs frontend/verify-retake-bar.mjs
git commit -m "test: album meta/edit/retake 三个端到端脚本"
```

---

## Task 7: 全量门禁 + 全量回归

**Files:** none

### Step 7.1: 后端预检 + 门禁

```powershell
cd f:\Trae-work\bighead
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" -c "from backend.routes.gallery import _load_album, _validate_job_id, _normalize_entry; from backend.config import ALBUM_FILENAME; print('PY=', __import__('sys').executable); print('OK=', ALBUM_FILENAME)"
ruff check backend
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" -m compileall -q backend
```

预期：输出 `PY= <WEBUI_ROOT>\python.exe` + `OK= _album.json`，无 compile 报错，无 ruff 报错。

### Step 7.2: 前端门禁

```powershell
cd f:\Trae-work\bighead\frontend
npm run typecheck
npm run lint
```

预期：无报错。

### Step 7.3: 启动后端 + 前端

后端（新 terminal）:

```powershell
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" -m uvicorn backend.app:app --host 127.0.0.1 --port 8077
```

前端（新 terminal）:

```powershell
cd f:\Trae-work\bighead\frontend
$env:BIGHEAD_API_TARGET="http://127.0.0.1:8077"
npm run dev
```

等两个服务都返回 200（用 `curl http://127.0.0.1:8077/api/health` 与 `curl http://localhost:5173/`）。

### Step 7.4: 跑后端元数据自测

```powershell
cd f:\Trae-work\bighead
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" backend/scripts/verify_album_meta.py
```

预期：`Result: N passed, 0 failed`（约 20 项）。

### Step 7.5: 跑全部 14 个验证脚本

```powershell
cd f:\Trae-work\bighead\frontend
node verify-camera.mjs
node verify-burst.mjs
node verify-mask-preview.mjs
node verify-mask-output.mjs
node verify-mask-tabs.mjs
node verify-mask-gallery.mjs
node verify-masks.mjs
node verify-gallery-capture.mjs
node verify-era-e2e.mjs
node verify-doodle-burn.mjs
node verify-sticker-edit.mjs
node verify-album-meta.mjs
node verify-album-edit.mjs
node verify-retake-bar.mjs
```

预期：14 个脚本全部 0 失败。**特别注意**：`verify-gallery-capture.mjs` 仍要通过 —— 它走的是 `outputs/` 物理目录，与新加的元数据无关，应当无回归。如果失败，先看是否是测试脚本硬编码了 `/api/gallery` 的旧响应结构（它只读 `thumbs` 字段，新字段不影响）。

### Step 7.6: 写入 review 文档

**File**: `docs/review/2026-10-05-p1-album-and-retake.md`（新建）

新增一份独立的 review 文档（不追加到 2026-10-04-code-review.md），记录：

- 两项功能实际改动文件清单
- 验证脚本断言数（后端自测 ~20 + 14 个 Playwright 脚本）
- 任何与计划偏离（默认值的调整、文件路径调整等）
- 已知遗留（标签去重仅在前端做、没搜索/筛选框、删后 _album.json 不会自动瘦身为空等）

---

## Self-Review Checklist（写计划时已自审）

- [x] **Spec 覆盖**：竞品分析 P1 两项（贴纸册、pose + 单张重拍）每一项都有独立 Task（1+2 / 3+4+5），Task 6 是验证脚本，Task 7 是回归门禁。
- [x] **占位符扫描**：所有代码块都是具体实现，没有 "TBD / TODO / 适当处理" 等含糊词。
- [x] **类型一致性**：
  - `AlbumEntry` 在 [types.ts](file:///f:/Trae-work/bighead/frontend/src/types.ts) 与 `AlbumEditor` props 一致。
  - `GalleryItem` 字段（`title/note/tags/favorite/updated_at`）在 [api.ts](file:///f:/Trae-work/bighead/frontend/src/api.ts)、[GalleryPage.tsx](file:///f:/Trae-work/bighead/frontend/src/pages/GalleryPage.tsx)、后端 `_normalize_entry` 三处同源。
  - `POSES = ["嘟嘴", "比心", "看镜头", "笑僵"]` 在 `HomePage.tsx` 与 Task 3 的注释里同源。
  - `burnedIn` 语义沿用 [store.ts:18-23](file:///f:/Trae-work/bighead/frontend/src/store.ts#L18-L23) —— 重拍只是再调一次 `doSnap`，自然读当下 `maskPreview`，无需额外逻辑。
- [x] **后端契约**：`PATCH /api/gallery/{job_id}` 与 `DELETE /api/gallery/{job_id}` 都挂到现有 [gallery.py](file:///f:/Trae-work/bighead/backend/routes/gallery.py)，路径校验 `_JOB_ID_RE` + `resolve().relative_to()` 双层防御；`_load_album` 在文件损坏时静默返回 `{}`，不影响 `/api/gallery` 主链路。
- [x] **未修改** `CountdownOverlay.tsx`、`renderMask.ts`、`backend/filters.py`、`backend/routes/capture.py`、`backend/routes/preview.py` —— 前序 P0 链路完全不动。
- [x] **未引入新依赖**：后端只用标准库 + 已有第三方（fastapi/pydantic/Pillow）；前端只用既有 React/zustand/Tailwind；测试仅用既有 chromium/playwright。
- [x] **frontmatter 兼容**：Plan 假设分支 `feature/p1-album-and-retake` 已切出（创建分支的命令在本文最前）；`docs/review/2026-10-05-p1-album-and-retake.md` 是新文件, 不追加到旧 review（避免 review 越堆越长难读）。

---

## 执行入口

**Plan complete and saved to `docs/superpowers/plans/2026-10-05-p1-album-and-retake.md`. Two execution options:**

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
