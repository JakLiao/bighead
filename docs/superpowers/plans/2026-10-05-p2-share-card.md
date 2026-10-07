# P2 拼图落盘 + 分享卡 / 清 P1 遗留 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补上「拼图落盘」这条从未存在的链路，让两条出片路径都产出规范的 `outputs/{job_id}/` 目录；在此基础上生成固定 4:3 的分享卡 `share.jpg`（footer 为品牌行 + 短 job ID + 拍摄日期）；并清掉 P1 遗留的三项（no-op PATCH、搜索/筛选、Escape 关闭）。

**Architecture:** 落盘是分享卡的前置条件——分享卡必须挂在 job 目录下，贴纸册才能展示它。所以顺序是「先统一落盘 → 再基于落盘产物做分享卡」。

- **统一落盘**：新增 `POST /api/share/save`，接收成片拼图字节 + 照片字节，服务端建/复用 job 目录，写 `layout.jpg`（拼图）与 `photo_N.jpg`（单张）。非 AI 路径在 `doLayout` 末尾调用它；AI 路径已由 `capture/save` 建好目录，改为把 `ai/{style}/layout.jpg` 提升一份到顶层 `layout.jpg`，让 [gallery.py:155](file:///f:/Trae-work/bighead/backend/routes/gallery.py#L155) 的非递归探测对两条路径都生效。
- **分享卡**：新增 `backend/share_card.py`，纯 PIL。输入拼图 PIL + job_id + 拍摄日期，输出固定 4:3 卡片。中文用 `msyh.ttc`（已确认系统存在）。落盘 `outputs/{job_id}/share.jpg`。
- **清遗留**：no-op PATCH 在**后端**拦（前端按钮置灰只是 UX，真正的不变量在后端）；搜索/筛选走后端 query 参数；Escape 用一个通用 `useEscape` hook。

**Tech Stack:**
- 后端：FastAPI + PIL（既有），**无新依赖**
- 前端：React 18 + Zustand（既有），**无新依赖**
- 验证：2 个新 Playwright 脚本 + 1 个新后端自测脚本，跑齐现有 14 个回归脚本

---

## 扫描阶段的关键发现（决定了本计划的范围）

这一节是实现前必须知道的事实，**每一条都改变了原本「加个保存按钮」的想法**。

### 发现 1：非 AI 路径的拼图 100% 不落盘

[DecoratePage.doLayout](file:///f:/Trae-work/bighead/frontend/src/pages/DecoratePage.tsx#L613-L618)：

```tsx
const result = await makeLayout(finalBlobs, layout, frameOverride ?? "none");
if (layoutUrl) URL.revokeObjectURL(layoutUrl);
setLayoutUrl(URL.createObjectURL(result));   // ← 纯内存 blob
```

[layout.py:36-37](file:///f:/Trae-work/bighead/backend/routes/layout.py#L36-L37) 把 `collage_to_bytes` 的结果直接 `Response` 回去了，磁盘上没有任何写入。**没有 `saveCaptures`，没有 `job_id`，没有目录。**

后果：默认路径（`aiEnabled=false`）拍完的拼图刷新页面即消失，贴纸册里永远不会出现这一条。用户唯一能留存的方式是点「下载 JPG」把 blob 存到浏览器下载目录——而 [DecoratePage:277-280](file:///f:/Trae-work/bighead/frontend/src/pages/DecoratePage.tsx#L277-L280) 的注释明确说下载文件名依赖服务端路径含 job_id，此时路径是 `blob:`，拿不到有意义的文件名。

### 发现 2：AI 路径落了盘，但贴纸册看不见

AI 路径写的是 `outputs/{job_id}/ai/{style}/layout.jpg`（[generate.py:45](file:///f:/Trae-work/bighead/backend/routes/generate.py#L45)），而 [gallery.py:155](file:///f:/Trae-work/bighead/backend/routes/gallery.py#L155) 只探测顶层：

```python
layout = entry / "layout.jpg"      # ← 不递归进 ai/
```

所以 AI 拼图在贴纸册里只以 4 张单图缩略图出现，那张拼图本身从不展示。

### 发现 3：`LAYOUT_FILENAME` 是死常量

[config.py:197](file:///f:/Trae-work/bighead/backend/config.py#L197) 定义了 `LAYOUT_FILENAME = "layout.jpg"`，但 `build_ai_layout`（[pipeline.py:799](file:///f:/Trae-work/bighead/backend/pipeline.py#L799)）与 gallery 都各自硬编码字符串。这是个「看起来有约定、实际没人在用」的陷阱——新增代码若再硬编码第四处，问题只会扩大。

### 由此确定的三项决策（已与用户确认）

| 决策 | 结论 | 理由 |
|---|---|---|
| 落点 | 两条路径统一产出顶层 `outputs/{job_id}/layout.jpg` | 一处探测覆盖全局，AI 拼图立刻能在贴纸册展示 |
| 分享卡文件名 | `outputs/{job_id}/share.jpg`，与 layout 平级 | 保留原始拼图，分享卡是独立产物 |
| 中文字体 | 微软雅黑 `msyh.ttc` | 已确认系统存在 `msyh.ttc` / `msyhbd.ttc`；见下方字体链说明 |

---

## 文件总览

| 路径 | 状态 | 责任 |
|---|---|---|
| `backend/share_card.py` | **新增** | 4:3 分享卡合成（纯 PIL）：等比适配 + footer + 落盘 |
| `backend/routes/share.py` | **新增** | `POST /api/share/save`（落盘）与 `GET /api/share/{job_id}`（取分享卡 URL） |
| `backend/routes/layout.py` | 修改 | `layout_make` 增加可选 `job_id`：给了就落盘到该 job 目录顶层 |
| `backend/config.py` | 修改 | 新增 `SHARE_FILENAME`；把 `LAYOUT_FILENAME` 真正接上；新增分享卡几何常量 |
| `backend/routes/gallery.py` | 修改 | 探测 `share.jpg`；`q`/`tag` 查询参数；no-op PATCH 拦截 |
| `backend/scripts/verify_share_card.py` | **新增** | 分享卡几何、footer 文本、落盘路径、no-op PATCH 的后端断言 |
| `frontend/src/api.ts` | 修改 | 新增 `saveShareCard`、`fetchGallery` 带查询参数 |
| `frontend/src/types.ts` | 修改 | `GalleryItem` 加 `share_url`；新增 `ShareSaveResult` |
| `frontend/src/pages/DecoratePage.tsx` | 修改 | 非 AI 路径落盘 + 生成分享卡；AI 路径提升 layout 到顶层 |
| `frontend/src/pages/GalleryPage.tsx` | 修改 | 搜索框 + 标签筛选条 |
| `frontend/src/components/album/AlbumEditor.tsx` | 修改 | no-op 置灰保存；Escape 关闭 |
| `frontend/src/hooks/useEscape.ts` | **新增** | Escape 关闭的通用 hook |
| `frontend/verify-share-card.mjs` | **新增** | 落盘 + 分享卡存在性 + 贴纸册展示端到端 |
| `frontend/verify-album-search.mjs` | **新增** | 搜索/筛选 + no-op PATCH + Escape 端到端 |
| `frontend/run-all-verify.ps1` | 修改 | 加入 2 个新脚本 |

---

## Task 1: 后端分享卡合成模块

**Files:**
- Create: `backend/share_card.py`
- Modify: `backend/config.py`（新增 `SHARE_FILENAME` 与分享卡几何常量）

### Step 1.1: 加配置常量

**File:** `backend/config.py`

在 `LAYOUT_FILENAME` 那一块（L196-198 附近）替换为：

```python
# 输出文件名模板
PHOTO_FILENAME = "photo_{idx}.jpg"
LAYOUT_FILENAME = "layout.jpg"
AI_FILENAME = "ai_{idx}.jpg"
# 分享卡(4:3 成品, 含品牌 footer)。与 layout.jpg 平级 —— layout 是
# 「拼图原样」, share 是「可直接发朋友圈的成品」, 两者都要留。
SHARE_FILENAME = "share.jpg"

# 分享卡几何(固定 4:3, 150 DPI → 1200x900 = 8x6 英寸)。
#
# 为什么固定比例而不跟随排版: 分享卡要发到社交平台, 比例不统一会导致
# 版式碎裂。排版本身有 2x2(接近 1:1)、strip(4:1 极端横长)等多种比例,
# 全部塞进同一个 4:3 画布 —— 长条会在上下留大片空白, 方形会在左右留白。
# 这是刻意接受的代价: 一致的对外形态 > 画面填满。
#
# 内容区(1120x680)与页脚区(1200x220)的高度差是按 4:3 反推的:
# 900 - 220(footer) = 680, 减去上下各 40 边距 = 600 给画面。
SHARE_CARD_SIZE = (1200, 900)
SHARE_CARD_BG = (255, 248, 240)     # 与 layouts.py 的纸底同色
SHARE_CARD_MARGIN = 40
SHARE_CARD_FOOTER_H = 220
# 品牌行文案。用户确认的 footer B = 品牌行 + 短 job ID + 拍摄日期。
SHARE_CARD_BRAND = "BigHead 大头贴复古"
# 中文字体候选链, 按优先级探测。msyh.ttc(微软雅黑)是 Windows 自带且
# 字形最稳; simhei.ttf 次之; arial.ttf 只覆盖 ASCII, 排中文会掉字形
# (PIL 不抛错, 静默画成空白/豆腐块), 所以它排在最后仅用于纯 ASCII 场景。
SHARE_CARD_FONTS = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\msyhbd.ttc",
]
SHARE_CARD_FONT_FALLBACK = r"C:\Windows\Fonts\arial.ttf"
```

> **教学点**：字体候选链里 `arial.ttf` 排最后不是随便排的。PIL 遇到字体里没有的字形**不会抛异常**，它会画出 `.notdef`（一个空心方框）。如果只写「找不到字体就 fallback 到 arial」，结果是一张看起来排版正常、但品牌行是三个豆腐块的图——而且**没有任何报错**。这类静默失败最难在测试里发现，所以候选链必须以真正含中文字形的字体开头。

### Step 1.2: 写分享卡合成模块

**File:** `backend/share_card.py`（新增）

```python
"""分享卡合成:把拼图装进固定 4:3 卡片,加品牌 footer,落盘.

为什么单独成模块而不放进 layouts.py: layouts.py 是「拼图」——它的输出
尺寸完全由排版决定(2x2 / 3x3 / strip 各自不同)。分享卡是「成品」——
尺寸恒为 4:3, 内容是拼图 + 文案。两者的输入输出契约不同, 混在一个文件里
会让 make_collage 逐渐长出"如果 frame 是 share 就怎样"的分支。

几何(固定 4:3 = 1200x900):
    ┌──────────────────────────────┐
    │  ← 40 边距                   │
    │   ┌──────────────────────┐   │
    │   │                      │   │
    │   │   拼图(等比 contain)  │   │ 680 高
    │   │                      │   │
    │   └──────────────────────┘   │
    │   ── footer 分隔线 ──        │
    │   BigHead 大头贴复古         │ 220 高
    │   #a1b2c3 · 2026-10-05      │
    └──────────────────────────────┘
"""
from __future__ import annotations

import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .config import (
    SHARE_CARD_BG,
    SHARE_CARD_BRAND,
    SHARE_CARD_FONT_FALLBACK,
    SHARE_CARD_FONTS,
    SHARE_CARD_FOOTER_H,
    SHARE_CARD_MARGIN,
    SHARE_CARD_SIZE,
)


def _load_font(size: int) -> ImageFont.FreeTypeFont:
    """按候选链取第一个能用的字体。

    刻意不设「arial.ttf 之外就 load_default」的兜底: PIL 的
    ImageFont.load_default() 返回的是位图字体, 字形极小且**不含中文**,
    排出来是一串模糊的方块。宁可让调用方拿到 None 自己降级, 也不要
    输出一张看起来排好版、实际全是豆腐块的图。

    仍然兜 arial.ttf: 它至少能让纯 ASCII 的 job_id 正常显示。
    """
    for path in SHARE_CARD_FONTS + [SHARE_CARD_FONT_FALLBACK]:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return None  # type: ignore[return-value]
```

后续 Step 1.3-1.5 给出 `render_share_card`、`share_to_file` 与自检入口。

### Step 1.3: `render_share_card` —— 核心合成

```python
def render_share_card(
    collage: Image.Image,
    job_id: str,
    captured_at: float | None = None,
) -> Image.Image:
    """把拼图装进 4:3 卡片并加 footer,返回 PIL.Image。"""
    card_w, card_h = SHARE_CARD_SIZE
    card = Image.new("RGB", SHARE_CARD_SIZE, SHARE_CARD_BG)

    # 内容区: 去掉上下边距, 底部留出 footer
    inner_w = card_w - SHARE_CARD_MARGIN * 2
    inner_h = card_h - SHARE_CARD_MARGIN * 2 - SHARE_CARD_FOOTER_H
    inner_x = SHARE_CARD_MARGIN
    inner_y = SHARE_CARD_MARGIN

    # 等比 contain 适配。
    #
    # 用 thumbnail 而不是直接 resize: 拼图可能是 4:1 的长条(排版 strip),
    # 直接 resize 到内容区尺寸会把它拉成 4:3 的糊图。contain 保住长条
    # 的原始比例, 代价是上下/左右出现留白 —— 而留白正好是米色纸底,
    # 视觉上是「拍立得的白边」而不是「排版坏了」。
    src = collage.convert("RGB")
    src.thumbnail((inner_w, inner_h), Image.LANCZOS)
    # 居中: 留白平均分到两侧, 不能靠左 —— 靠左会让卡片视觉重心偏左,
    # 分享到社交平台时看着像没对齐。
    px = inner_x + (inner_w - src.width) // 2
    py = inner_y + (inner_h - src.height) // 2
    card.paste(src, (px, py))

    _draw_footer(card, job_id, captured_at)
    return card


def _draw_footer(card: Image.Image, job_id: str, captured_at: float | None) -> None:
    """画 footer: 分隔线 + 品牌行 + 短 job ID + 拍摄日期。"""
    d = ImageDraw.Draw(card)
    card_w, card_h = SHARE_CARD_SIZE
    line_y = card_h - SHARE_CARD_FOOTER_H
    d.line(
        [(SHARE_CARD_MARGIN, line_y), (card_w - SHARE_CARD_MARGIN, line_y)],
        fill=(210, 190, 180),
        width=2,
    )

    brand_font = _load_font(48)
    meta_font = _load_font(30)
    ink = (90, 70, 70)
    # 品牌行
    if brand_font is not None:
        d.text(
            (SHARE_CARD_MARGIN, line_y + 44),
            SHARE_CARD_BRAND,
            fill=ink,
            font=brand_font,
        )

    # 短 job ID: uuid4().hex[:12] 的前 6 位。取 6 位而不是全长, 是为了
    # 在卡片上不喧宾夺主, 同时仍够用户口头指认某一张("你那张 c3f1a9 的")。
    short = job_id[:6]
    when = time.strftime("%Y-%m-%d", time.localtime(captured_at)) if captured_at \
        else time.strftime("%Y-%m-%d")
    meta_line = f"#{short} · {when}"
    if meta_font is not None:
        d.text(
            (card_w - SHARE_CARD_MARGIN - d.textlength(meta_line, font=meta_font),
             line_y + 130),
            meta_line,
            fill=(150, 120, 118),
            font=meta_font,
        )
```

> **教学点 —— 为什么 `meta_line` 要右对齐而用 `textlength` 反推 x**：`d.text` 没有 `anchor` 参数时原点固定是左上角。要右对齐就得先量出文字宽度再反推起点。这里直接用 `card_w - margin - width` 而不是写死坐标，是因为品牌文案一旦改长（"BigHead 大头贴复古" → "BigHead 大头贴复古相机"），写死的坐标会立刻撞到右边界，而反推式在文案变化时自动跟随。

### Step 1.4: `share_to_file` —— 落盘

```python
def share_to_file(
    collage: Image.Image,
    job_dir: Path,
    job_id: str,
    captured_at: float | None = None,
) -> Path:
    """合成并写 outputs/{job_id}/share.jpg,返回落盘路径。"""
    from .config import SHARE_FILENAME

    card = render_share_card(collage, job_id, captured_at)
    job_dir.mkdir(parents=True, exist_ok=True)
    out = job_dir / SHARE_FILENAME
    card.save(out, format="JPEG", quality=92)
    return out
```

### Step 1.5: 自检入口

```python
if __name__ == "__main__":
    import sys

    im = Image.new("RGB", (600, 400), (120, 160, 200))
    p = share_to_file(im, Path("outputs") / "_share_selftest", "a1b2c3d4e5f6", 0.0)
    print(f"OK {p} {Image.open(p).size}")
    sys.exit(0)
```

### Step 1.6: 跑通

```powershell
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" -m backend.share_card
```

期望输出 `OK outputs\_share_selftest\share.jpg (1200, 900)`。**必须确认尺寸是 1200×900 而不是别的** —— 这是整个 P2 唯一的硬几何断言。

---

## Task 2: 后端落盘路由

**Files:**
- Create: `backend/routes/share.py`
- Modify: `backend/routes/layout.py`
- Modify: `backend/app.py`（注册 router）
- Modify: `backend/config.py`（接入 `LAYOUT_FILENAME`）

### Step 2.1: `layout_make` 支持落盘

**File:** `backend/routes/layout.py`

给现有端点加一个**可选**的 `job_id` Form 字段：

```python
@router.post("/api/layout/make")
def layout_make(
    images: list[bytes] = File(...),
    layout: str = Form("2x2"),
    frame: str = Form("plain_white"),
    job_id: str | None = Form(None),
):
    """拼图排版。job_id 给了就顺便落盘到该 job 目录顶层。

    不给 job_id 时行为与改动前完全一致(纯返回字节), 这样 AI 路径的
    客户端拼图兜底(layoutFromAiImages 里的 makeLayout 调用)不受影响。
    """
    if layout not in LAYOUTS:
        raise HTTPException(400, f"unknown layout: {layout}")
    try:
        pils = [Image.open(io.BytesIO(b)) for b in images]
    except Exception as e:
        raise HTTPException(400, f"invalid image bytes: {e}")

    from ..layouts import collage_to_bytes

    data = collage_to_bytes(pils, layout=layout, frame=frame, fmt="JPEG")

    if job_id:
        from ..routes.gallery import _resolve_job_dir

        job_dir = _resolve_job_dir(job_id)
        if not job_dir.is_dir():
            raise HTTPException(404, f"job {job_id} 不存在")
        from ..config import LAYOUT_FILENAME

        (job_dir / LAYOUT_FILENAME).write_bytes(data)

    return Response(content=data, media_type="image/jpeg")
```

> **教学点 —— 复用 `_resolve_job_dir` 而不是自己拼路径**：gallery.py 里那个函数同时做了正则校验与 `resolve()` 后的越界检查。`job_id` 来自 HTTP 表单，是**用户可控输入**；`(OUTPUT_DIR / job_id).resolve()` 在 `job_id = "../.."` 时会逃出 outputs 目录。这里绝不能图省事新写一份 `OUTPUT_DIR / job_id` —— 复制一份路径拼接等于复制一份漏洞。

### Step 2.2: 新增分享卡路由

**File:** `backend/routes/share.py`（新增）

```python
"""分享卡落盘与查询."""
from __future__ import annotations

import io

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from PIL import Image

from ..config import LAYOUT_FILENAME, OUTPUT_DIR, SHARE_FILENAME
from .gallery import _resolve_job_dir

router = APIRouter()


@router.post("/api/share/save")
def share_save(
    job_id: str = Form(...),
    layout: UploadFile = File(...),
    share: bool = Form("1"),
):
    """把已生成的分享卡字节落盘到 outputs/{job_id}/share.jpg。

    刻意**不接收原始拼图**而接收前端合成好的分享卡: 服务端的
    share_card.render_share_card 只需要在落盘时用一次(补生成历史卡片),
    正常路径由前端 canvas 合成 —— 前端已经有 collage blob 和排版状态,
    再让浏览器把拼图传回服务端、服务端再合成一次是纯粹的双向往返。
    """
    job_dir = _resolve_job_dir(job_id)
    if not job_dir.is_dir():
        raise HTTPException(404, f"job {job_id} 不存在")
    data = layout.file.read()
    if not data:
        raise HTTPException(400, "空文件")
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.verify()
    except Exception as e:
        raise HTTPException(400, f"不是可解码的图片: {type(e).__name__}")
    out = job_dir / SHARE_FILENAME
    out.write_bytes(data)
    return {"job_id": job_id, "share_url": f"/outputs/{job_id}/{SHARE_FILENAME}"}
```

> **注意 `_resolve_job_dir` 的导入路径**：写 `from .gallery import _resolve_job_dir` 会触发 gallery 模块的完整加载（含 `from ..config import ...`）。这在 app.py 里没有循环风险，因为 gallery 本身不 import share。但如果后续把 share 的逻辑挪进 gallery 就会成环 —— 届时应把 `_resolve_job_dir` 下沉到 `backend/paths.py`。本计划不提前重构，避免为一个尚不存在的环付代价。

### Step 2.3: 注册路由

**File:** `backend/app.py`

改 import 行（[app.py:15](file:///f:/Trae-work/bighead/backend/app.py#L15)）：

```python
from .routes import capture, gallery, generate, health, layout, preview, share, ws_jobs
```

在 `app.include_router(gallery.router)` 后加：

```python
app.include_router(share.router)
```

### Step 2.4: 门禁

```powershell
ruff check backend scripts
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" -m compileall -q backend scripts
```

---

## Task 3: 贴纸册改造（探测 / 搜索 / no-op PATCH）

**Files:**
- Modify: `backend/routes/gallery.py`

### Step 3.1: 探测 `share.jpg`

**File:** `backend/routes/gallery.py`

改 [gallery.py:154-160](file:///f:/Trae-work/bighead/backend/routes/gallery.py#L154-L160) 的缩略图探测：

```python
        thumbs: list[str] = []
        # 分享卡优先于拼图: 它才是用户想分享/回看的那一张。
        # 用 LAYOUT_FILENAME/SHARE_FILENAME 常量而不是字面量 —— 原代码
        # 硬编码 "layout.jpg" 而 config.py 里同名常量没人用, 新增第三处
        # 硬编码只会让下次改名漏改更多地方。
        share = entry / SHARE_FILENAME
        layout = entry / LAYOUT_FILENAME
        if share.exists():
            thumbs.append(f"/outputs/{entry.name}/{SHARE_FILENAME}")
        elif layout.exists():
            thumbs.append(f"/outputs/{entry.name}/{LAYOUT_FILENAME}")
        else:
            for f in sorted(entry.glob("photo_*.jpg"))[: 4]:
                thumbs.append(f"/outputs/{entry.name}/{f.name}")
        mtime = int(entry.stat().st_mtime)
```

同步改 import（[gallery.py:14-21](file:///f:/Trae-work/bighead/backend/routes/gallery.py#L14-L21)）加 `LAYOUT_FILENAME` 与 `SHARE_FILENAME`。

### Step 3.2: 搜索 / 筛选

```python
@router.get("/api/gallery")
def gallery(q: str = "", tag: str = ""):
    """...

    q   : 大小写不敏感的子串匹配, 命中 title / note / tags / job_id 任一
    tag : 精确匹配单个标签(多个用逗号分隔, 任一命中即返回)
    """
    ...
    needle = q.strip().lower()
    want_tags = {t.strip() for t in tag.split(",") if t.strip()}

    out: list[dict] = []
    for ...  # 原有的目录扫描逻辑不动
        if needle:
            hay = " ".join([
                entry.name, meta_title, meta_note, " ".join(meta_tags),
            ]).lower()
            if needle not in hay:
                continue
        if want_tags and not (want_tags & set(meta_tags)):
            continue
        out.append({...})
```

同时补一个 `tags` 汇总字段（供前端渲染筛选条）：

```python
    all_tags: dict[str, int] = {}
    for it in out:
        for t in it["tags"]:
            all_tags[t] = all_tags.get(t, 0) + 1
    return {
        "items": out,
        "tags": [{"tag": t, "count": c} for t, c in
                 sorted(all_tags.items(), key=lambda kv: (-kv[1], kv[0]))],
    }
```

> **教学点 —— 筛选为什么在后端做而不是前端**：前端过滤只能隐藏已经下载的条目，`/api/gallery` 仍会把全部缩略图 URL 传过来。数据量小的时候无所谓，但语义上「筛选」是查询的一部分（对应 URL 可分享、刷新后保持），放后端才能让 `?q=xx` 成为一个可复现的链接。分页/大数据量下这更是唯一可扩展的做法。

### Step 3.3: no-op PATCH 拦截

改 [gallery_patch](file:///f:/Trae-work/bighead/backend/routes/gallery.py#L176-L188)：

```python
@router.patch("/api/gallery/{job_id}")
def gallery_patch(job_id: str, body: dict = Body(default_factory=dict)):
    """局部更新元数据。

    内容无变化时**不写盘**: 否则 updated_at 被 bump, 而 GET 的排序规则是
    「favorite 优先 + mtime 降序」—— 用户只是打开抽屉又关掉, 这条记录
    就会莫名跳到列表最前面, 看起来像被系统动过。
    """
    job_dir = _resolve_job_dir(job_id)
    if not job_dir.exists():
        raise HTTPException(404, f"job {job_id} 不存在")
    with _album_lock:
        album = _load_album(OUTPUT_DIR)
        base = album.get(job_id) or _normalize_entry({})
        merged = _merge_entry(base, body)
        if _same_content(base, merged):
            return {"job_id": job_id, **base, "changed": False}
        album[job_id] = merged
        _save_album(OUTPUT_DIR, album)
    return {"job_id": job_id, **merged, "changed": True}


def _same_content(a: dict, b: dict) -> bool:
    """只比较用户可见的四个字段, 忽略 updated_at。

    updated_at 必须排除: 它在 _merge_entry 里总是被 bump, 拿它参与比较
    会让本函数恒为 False, 拦截逻辑就成了死代码 —— 而且这种「看起来在
    工作、实际永远不成立」的死分支最难发现, 因为它不会报错。
    """
    return all(
        a.get(k, _normalize_entry({})[k]) == b.get(k)
        for k in ("title", "note", "tags", "favorite")
    )
```

> **教学点 —— 这就是 P1 遗留清单第 6 条的真正危害**。原实现每次 PATCH 都 bump `updated_at`，而 `updated_at` 不参与排序（排序用 `mtime`，即目录 mtime）—— 但 `_save_album` 写 `_album.json` **不会**改目录 mtime。所以严格说原实现的可见危害比清单里写的小；不过 `updated_at` 仍会漂移，未来若改成按 `updated_at` 排序就会突然暴露成 bug。拦截掉它是低成本的正确性保障，且顺带让前端可以做乐观更新。

### Step 3.4: 后端自测扩展

**File:** `backend/scripts/verify_share_card.py`（新增）

自测项（目标 ≥ 18 项断言）：
- `render_share_card` 输出尺寸严格 1200×900
- 长条图（1600×200）在卡片内不拉伸（输出仍是 4:3）
- footer 分隔线存在（在 y = 900-220 处有非背景像素）
- 品牌行区域有深色像素（证明中文真的渲染出来了，而非豆腐块）
- `share_to_file` 落盘路径为 `share.jpg`
- `_same_content` 对相同内容返回 True、对 title 变化返回 False
- no-op PATCH 后 `_album.json` 的 mtime 未变
- `share.jpg` 存在时 gallery 缩略图指向它，删除后回落到 `layout.jpg`
- `q=`, `tag=` 过滤正确
- job_id 路径穿越（`../`）被 `_resolve_job_dir` 拒绝

```powershell
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" backend\scripts\verify_share_card.py
```

---

## Task 4: 前端落盘与分享卡生成

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api.ts`
- Create: `frontend/src/shareCard.ts`
- Modify: `frontend/src/pages/DecoratePage.tsx`

### Step 4.1: 类型与 API

**File:** `frontend/src/types.ts`

```ts
/** /api/share/save 的返回。 */
export interface ShareSaveResult {
  job_id: string;
  share_url: string;
}

/** /api/gallery 的标签汇总, 供筛选条渲染。 */
export interface TagCount { tag: string; count: number }
```

`GalleryItem` 加一行 `share_url: string | null;`，`GalleryResponse` 加 `tags: TagCount[]`。

**File:** `frontend/src/api.ts`

```ts
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

export async function fetchGallery(
  q = "",
  tag = "",
): Promise<GalleryResponse> {
  const p = new URLSearchParams();
  if (q.trim()) p.set("q", q.trim());
  if (tag) p.set("tag", tag);
  const qs = p.toString();
  const r = await fetch(`${API}/gallery${qs ? `?${qs}` : ""}`);
  if (!r.ok) throw new Error(`fetchGallery ${r.status}`);
  return r.json();
}
```

### Step 4.2: 前端分享卡合成

**File:** `frontend/src/shareCard.ts`（新增）

与后端 `share_card.py` 保持同样的几何常量（前端这份是权威用于日常出片，后端那份用于补生成历史卡片）：

```ts
/**
 * 浏览器端分享卡合成。
 *
 * 为什么不直接调后端渲染: 前端此刻已经持有 collage Blob 与 job_id,
 * 合成一张 1200x900 的卡片是纯本地 canvas 操作; 走服务端意味着把
 * 几 MB 的拼图再上传一次再下载一次。后端保留同名实现
 * (backend/share_card.py) 只用于「历史条目补生成」这类没有前端上下文的场景。
 *
 * 几何必须与 backend/share_card.py 逐值一致 —— 两处独立实现同一个设计,
 * 不一致时只有肉眼能发现差异, 所以任何改动都要同时改两个文件。
 */
export const SHARE_CARD_W = 1200;
export const SHARE_CARD_H = 900;
const MARGIN = 40;
const FOOTER_H = 220;
const BG = "#fff8f0";
const BRAND = "BigHead 大头贴复古";
const INK = "#5a4646";
const META_INK = "#967876";
/** 短 job ID 取前 6 位: 卡片上不喧宾夺主, 又够口头指认一张。 */
export function shortJobId(jobId: string): string {
  return jobId.slice(0, 6);
}

export async function renderShareCard(
  collage: Blob,
  jobId: string,
): Promise<Blob> {
  const bmp = await createImageBitmap(collage);
  try {
    const card = document.createElement("canvas");
    card.width = SHARE_CARD_W;
    card.height = SHARE_CARD_H;
    const ctx = card.getContext("2d");
    if (!ctx) return collage;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, SHARE_CARD_W, SHARE_CARD_H);

    // 等比 contain + 居中, 与后端 render_share_card 同策略
    const innerW = SHARE_CARD_W - MARGIN * 2;
    const innerH = SHARE_CARD_H - MARGIN * 2 - FOOTER_H;
    const scale = Math.min(innerW / bmp.width, innerH / bmp.height);
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    ctx.drawImage(bmp, MARGIN + (innerW - w) / 2, MARGIN + (innerH - h) / 2, w, h);

    const lineY = SHARE_CARD_H - FOOTER_H;
    ctx.strokeStyle = "#d2beb4";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(MARGIN, lineY);
    ctx.lineTo(SHARE_CARD_W - MARGIN, lineY);
    ctx.stroke();

    ctx.fillStyle = INK;
    ctx.font = '48px "Microsoft YaHei", sans-serif';
    ctx.textBaseline = "top";
    ctx.fillText(BRAND, MARGIN, lineY + 44);

    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const meta = `#${shortJobId(jobId)} · ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    ctx.fillStyle = META_INK;
    ctx.font = '30px "Microsoft YaHei", sans-serif';
    ctx.textAlign = "right";
    ctx.fillText(meta, SHARE_CARD_W - MARGIN, lineY + 130);
    ctx.textAlign = "left";

    return await new Promise<Blob | null>((r) =>
      card.toBlob(r, "image/jpeg", 0.92),
    ) ?? collage;
  } finally {
    bmp.close();
  }
}
```

> **教学点 —— 为什么 `try/finally` 里 `bmp.close()` 不能省**：`createImageBitmap` 返回的是**显式管理**的资源，不调 `close()` 不会进 GC 的自动回收路径，解码后的像素会一直挂在内存里。这个模式在 [burnDoodles](file:///f:/Trae-work/bighead/frontend/src/pages/DecoratePage.tsx#L84-L111) 已有先例，注释里写明了「一次失败就泄漏 4.7MB」。`finally` 让"必须归还"变成语言级保证，而不是靠每条分支都记得写一遍。

### Step 4.3: `doLayout` 非 AI 路径落盘

**File:** `frontend/src/pages/DecoratePage.tsx`

在 [doLayout](file:///f:/Trae-work/bighead/frontend/src/pages/DecoratePage.tsx#L612-L618) 的普通拼图分支，替换为：

```tsx
      // 普通拼图。
      //
      // 这一段原先只把 collage 塞进内存 blob —— 磁盘上什么都没有,
      // 刷新页面拼图即消失, 贴纸册里也永远不会出现这一条。
      // 现在: 先落盘拿到 job 目录, 再基于落盘的拼图生成分享卡。
      const result = await makeLayout(finalBlobs, layout, frameOverride ?? "none");

      // capture/save 是唯一能创建 job 目录的入口(见 backend/routes/capture.py),
      // 所以即便 AI 关闭也必须走一次 —— 否则后面没有 job_id 可写。
      const cap = await saveCaptures(finalBlobs);
      await makeLayoutToJob(finalBlobs, cap.job_id);
      const shareBlob = await renderShareCard(result, cap.job_id);
      const saved = await saveShareCard(cap.job_id, shareBlob);
      setShareUrl(saved.share_url);

      if (layoutUrl) URL.revokeObjectURL(layoutUrl);
      setLayoutUrl(`/outputs/${cap.job_id}/layout.jpg`);
      setBusy(false);
```

并在 store 里加 `shareUrl`。同时在 JSX 的「最终拼图」区块下方加分享卡展示 + 下载：

```tsx
{shareUrl && (
  <div className="bg-white rounded-2xl border-2 border-pink p-4 mt-4" data-share-card="">
    <div className="flex items-center justify-between mb-2">
      <div className="font-pixel text-sm text-brick">分享卡</div>
      <a href={shareUrl} className="px-4 py-1.5 bg-pink text-white rounded-full text-xs">
        下载分享卡
      </a>
    </div>
    <img src={shareUrl} className="w-full rounded-lg" alt="分享卡" />
  </div>
)}
```

### Step 4.4: AI 路径提升 layout 到顶层

在 [layoutFromAiImages](file:///f:/Trae-work/bighead/frontend/src/pages/DecoratePage.tsx#L419-L443) 的 `serverLayout` 分支里，把 AI 的深层 layout 复制一份到 job 顶层：

```tsx
      if (serverLayout) {
        // AI 拼图在 outputs/{job_id}/ai/{style}/layout.jpg, 而 gallery
        // 只探测顶层的 layout.jpg(不递归), 于是那张拼图在贴纸册里
        // 永远不展示, 只剩 4 张单图缩略图。复制一份到顶层修掉它。
        void promoteAiLayout(currentJobIdRef.current);
        if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
        setLayoutUrl(serverLayout);
        return;
      }
```

`promoteAiLayout` 用 `fetch` + 上传到 `/api/layout/make?job_id=` 会重新拼一遍（浪费），所以更简单的做法是**在后端 `build_ai_layout` 里直接多写一份顶层**。这一点放到 Task 2 的补充里：

**File:** `backend/pipeline.py`（`build_ai_layout` 末尾，`out.write_bytes(data)` 之后）

```python
        out = out_dir / "layout.jpg"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        # 顶层副本: gallery.py 只探测 outputs/{job_id}/layout.jpg,
        # 不递归进 ai/{style}/。不写这份, AI 拼图在贴纸册里就永远
        # 只显示 4 张单图, 那张拼图本身从不出现。
        try:
            top = OUTPUT_DIR.parent / out.relative_to(OUTPUT_DIR.parent)
            shutil.copyfile(out, top)
        except OSError:
            log.warning("复制顶层 layout.jpg 失败: %s", out)
```

并加 `import shutil` 到 pipeline.py 顶部。

---

## Task 5: 搜索/筛选 + no-op + Escape

**Files:**
- Create: `frontend/src/hooks/useEscape.ts`
- Modify: `frontend/src/components/album/AlbumEditor.tsx`
- Modify: `frontend/src/pages/GalleryPage.tsx`

### Step 5.1: `useEscape` hook

```ts
import { useEffect } from "react";

/**
 * 按 Esc 时回调。
 *
 * 刻意挂 document 而不是容器: 抽屉是 fixed 全屏遮罩, 焦点在遮罩内的
 * input 时事件同样冒泡到 document, 挂容器上会漏掉「正在打字时按 Esc」。
 */
export function useEscape(onEscape: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onEscape, active]);
}
```

### Step 5.2: AlbumEditor 接入

在组件内加：

```tsx
  useEscape(() => {
    // pending 期间不允许关: PATCH/DELETE 正在飞, 关掉抽屉会让用户
    // 以为操作没生效, 而后台其实已经把数据改了。
    if (!pending) onClose();
  });

  // no-op 检测: 内容与初始值一致时不发 PATCH。
  // 后端也会拦一道(见 gallery_patch 的 _same_content), 但前端拦截
  // 能让按钮直接置灰 —— 用户立刻知道「没什么可保存」, 而不是点了
  // 才拿到一个「已保存但什么都没变」的响应。
  const dirty =
    title !== initial.title ||
    note !== initial.note ||
    favorite !== initial.favorite ||
    tags.length !== initial.tags.length ||
    tags.some((t, i) => t !== initial.tags[i]);
```

保存按钮加 `disabled={pending || !dirty}`，文案在未改动时显示「无改动」。

### Step 5.3: GalleryPage 搜索/筛选

加状态与 UI：

```tsx
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [tags, setTags] = useState<TagCount[]>([]);
```

`reload` 改为带参数拉取，并在 `useEffect` 里首次加载。搜索框 + 标签芯片：

```tsx
      <div className="mb-4 flex flex-col gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索标题 / 备注 / 标签 / 编号"
          data-gallery-search=""
          className="px-3 py-2 rounded-full border border-pink bg-white text-sm w-full max-w-md"
        />
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setTag("")}
              aria-pressed={tag === ""}
              className={`px-2.5 py-0.5 rounded-full text-xs border ${
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
                onClick={() => setTag(t.tag === tag ? "" : t.tag)}
                aria-pressed={tag === t.tag}
                className={`px-2.5 py-0.5 rounded-full text-xs border ${
                  tag === t.tag ? "bg-brick text-white border-brick"
                                : "bg-cream text-brown border-pink"
                }`}
              >
                {t.tag} {t.count}
              </button>
            ))}
          </div>
        )}
      </div>
```

> **教学点 —— 搜索为什么要 debounce**：上面这版没做，输入每个字符都会打一次 `/api/gallery`。本地自用场景条目数是几十量级，问题不大；但如果照抄到条目上千的部署就会打爆后端。P2 不加 debounce 属于**有意识的取舍**（保持与现有 `reload()` 一致的直白写法），值得在 review 文档里记一笔，而不是让它以「疏漏」的形式混过去。

---

## Task 6: 端到端验证

**Files:**
- Create: `frontend/verify-share-card.mjs`
- Create: `frontend/verify-album-search.mjs`
- Modify: `frontend/run-all-verify.ps1`

### Step 6.1: `verify-share-card.mjs`

断言清单：
1. `/api/share/save` 落盘后 `share.jpg` 存在
2. 落盘字节可被 PIL 解码且尺寸 1200×900
3. `share.jpg` 出现在 `/api/gallery` 的 `thumbs[0]`
4. `layout.jpg` 也在同目录
5. 无 `job_id` 的 `/api/layout/make` 仍返回图片（回归：不传时不落盘也不报错）
6. 传非法 `job_id`（`../etc`）返回 400
7. `job_id` 不存在时返回 404
8. 分享卡文件非空且 JPEG magic 正确

### Step 6.2: `verify-album-search.mjs`

1. 造 3 条带不同 title/tags 的记录
2. `?q=<标题片段>` 只返回匹配项
3. `?tag=<tag>` 只返回含该标签项
4. `?tag=<不存在的>` 返回空
5. `tags` 汇总的 count 正确
6. UI 搜索框输入后列表收敛
7. UI 标签芯片点击后 `aria-pressed` 切换
8. no-op PATCH 返回 `changed: false` 且 `_album.json` mtime 未变
9. 改标题后 PATCH 返回 `changed: true`
10. 编辑抽屉内按 Esc 关闭

### Step 6.3: 跑全量

先起后端（**必须先做依赖预检**）：

```powershell
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" -c "import sys; from backend.peft_compat import ensure_peft; import insightface, onnxruntime, diffusers, transformers, torch, fastapi, uvicorn; assert ensure_peft(), 'peft still broken'; print('PY=', sys.executable); print('OK')"
```

输出 `PY=` + `OK` 后再起后端 8077 与前端 5173，然后：

```powershell
cd frontend
node run-all-verify.ps1
```

---

## 门禁清单

```powershell
# 后端
ruff check backend scripts
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" -m compileall -q backend scripts
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" backend\scripts\verify_share_card.py

# 前端
cd frontend
npm run typecheck
npm run lint
node run-all-verify.ps1
```

全部 0 失败才算完成。

---

## 明确不在本计划范围内

以下项**已识别但本次不做**，避免范围蔓延：

- 二维码（用户明确排除）
- `/share/{job_id}` 公开分享页
- 邮件投递
- 道具/配饰图层
- 视频 / GIF 导出
- 原生打印对接
- P1 遗留第 1/3/4/7 条（后端标签去重、清空后残留 `_album.json`、`prefers-reduced-motion`、损坏备份自动清理）
- 搜索 debounce（理由见 Task 5.3 教学点）

---

## 风险与已知不确定项

1. **前后端两份几何常量可能漂移**：`frontend/src/shareCard.ts` 与 `backend/share_card.py` 各自定义 1200×900 / margin 40 / footer 220。不一致时只有肉眼能发现。缓解：两处注释互相点名，并在此文档留一份对照表。

2. **AI 路径的顶层 layout 副本会占双份磁盘**：`ai/{style}/layout.jpg` 与顶层 `layout.jpg` 内容相同。4 张 2x2 拼图约 1-2MB，可接受。

3. **中文渲染依赖 Windows 字体**：`msyh.ttc` 是本机确认存在的，但代码在别的机器上会退化到 `simhei.ttf` → `arial.ttf`，最后 arial **排不出中文**（静默出豆腐块）。本项目只在 Windows 跑，但这个限制要写进 review 文档。

4. **`/api/share/save` 命名容易误解**：它的参数叫 `layout` 但写的是 `share.jpg`。这是为了让前端 `FormData` 的语义与后端 `layout_make` 保持一致（都传「一张图」），但确实别扭。实施时若觉得不对，可改为 `image`。
