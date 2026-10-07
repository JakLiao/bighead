# P0 古早大头贴对标实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 3 项对标古早大头贴的核心能力 —— 古早画质预设（`era`）、手写涂鸦层（成片烧录）、贴纸自由编排（自研 canvas 拖拽）。

**Architecture:** 三个能力彼此独立、互不耦合；统一沿用 BigHead 已有的「预览=出片」契约（同一份渲染代码 + 同一份参数）

- **古早画质**：作为新维度 `era` 叠加在现有滤镜之上。后端新增 `apply_era` 算子 + 1 个 `modern | vintage_2000` 预设，调用点不动（`/api/preview/filter` 与 `/api/capture/save`）。前端只新增一个二选一开关。
- **手写涂鸦**：装饰层独立组件 `DoodleLayer.tsx`（位于 `DecoratePage` 内部），只作用于拼图前一刻。`Strokes` 在拼图前烧进每张原图 blob，再交给现有 `makeLayout`。
- **贴纸自由编排**：新增可拖拽层叠在装饰页每张照片缩略图上（只 UI 编排，不改 `renderMask` 内部），每个贴纸位置/缩放/旋转状态进 zustand store，拼图时刻按变换矩阵重新绘制贴纸层。

**Tech Stack:**

- 后端：FastAPI + OpenCV（已有）+ 纯 Python（无新依赖）
- 前端：React 18 + Zustand + Canvas 2D（无新依赖，**不引入 Konva**）
- 验证：Playwright 脚本新增 `verify-vintage-era.mjs`、`verify-doodle-burn.mjs`、`verify-sticker-edit.mjs`，跑齐现有 8 个回归脚本

---

## 文件总览

| 路径 | 状态 | 责任 |
|---|---|---|
| `backend/filters.py` | 修改 | 新增 `apply_era(bgr, era)`、`_era_modern_pixels(bgr)`、`_era_vintage_2000_pixels(bgr)`；`apply_filter` 串接 `era` |
| `backend/config.py` | 修改 | FILTERS dict 每项增加 `era: "modern"` 默认；新增 `ERA_PRESETS = {"modern": "...", "vintage_2000": "..."}` |
| `backend/routes/preview.py` | 修改 | `/api/preview/filter` 接 `era` Form 字段 |
| `backend/routes/capture.py` | 修改 | `/api/capture/save` 接 `era` Form 字段并写盘时烧 era |
| `frontend/src/types.ts` | 修改 | `Meta` 加 `era_presets: EraPreset[]`；`FilterInfo` 加 `era: EraKey` 字段；`EraKey = "modern" \| "vintage_2000"` |
| `frontend/src/components/eras/eraDefs.ts` | 新增 | EraPreset 类型 + 8 个色板（笔刷） + 橡皮擦 |
| `frontend/src/components/doodles/DoodleCanvas.tsx` | 新增 | 单张照片的涂鸦编辑器（pointer events + 笔画栈 + 撤销） |
| `frontend/src/components/stickers/StickerEditor.tsx` | 新增 | 单张照片的贴纸拖拽层（命中测试 + 变换矩阵 + 删除/旋转按钮） |
| `frontend/src/store.ts` | 修改 | 加 `doodles: Record<index, DoodleStroke[]>`、`stickerOverrides: Record<index, StickerPlacement[]>`；对应 setter |
| `frontend/src/pages/DecoratePage.tsx` | 修改 | 注入 DoodleCanvas/StickerEditor 替换原 4 缩略图；右侧栏加 era 选择 + 涂鸦色板；`doLayout` 前多出「贴画」+「涂鸦烧录」步骤 |
| `frontend/src/components/masks/renderMask.ts` | **不改** | — |
| `frontend/verify-vintage-era.mjs` | 新增 | era 开关 + 像素级验证 |
| `frontend/verify-doodle-burn.mjs` | 新增 | 涂鸦笔迹必出现在拼图字节里 |
| `frontend/verify-sticker-edit.mjs` | 新增 | 拖拽/旋转/删除改变拼图字节 |

---

## Task 1: 古早画质预设（era）

**Files:**

- Create: 无（前置 fk）已完成
- Modify: `backend/filters.py`（新增 `_era_vintage_2000_pixels` 等）
- Modify: `backend/config.py`（FILTERS 加 era 字段，新增 ERA_PRESETS）
- Modify: `backend/routes/preview.py`（接 era Form）
- Modify: `backend/routes/capture.py`（接 era Form 并落盘时烧 era）
- Modify: `frontend/src/types.ts`（EraKey + EraPreset + FilterInfo.era）
- Modify: `frontend/src/components/eras/eraDefs.ts`（新文件但只放常量，不写 JSX）
- Modify: `frontend/src/pages/DecoratePage.tsx`（右侧栏加 era 开关）
- Modify: `frontend/src/api.ts`（applyFilter 多带一个参数）
- Test: `frontend/verify-vintage-era.mjs`

> **前置依赖**：本任务依赖已经走通的 4 张连拍主链路（已存在）。无需额外准备。

### Step 1.1: 写「古早画质」算子的纯函数单测

**File**: `backend/tests/test_filters_era.py`（如无 `tests/` 目录，新建）

```python
from PIL import Image
import numpy as np

from backend.filters import _era_vintage_2000_pixels, _era_modern_pixels, apply_filter


def _blank_bgr():
    """1280×960 全中性灰图,作为色彩退化测试基准。"""
    arr = np.full((960, 1280, 3), 128, dtype=np.uint8)
    return arr


def test_modern_is_identity():
    bgr = _blank_bgr()
    out = _era_modern_pixels(bgr)
    np.testing.assert_array_equal(out, bgr)


def test_vintage_2000_low_resolution_look():
    """vintage_2000 必须让色彩通道发生可度量的退化,而不是 identity。"""
    bgr = _blank_bgr()
    out = _era_vintage_2000_pixels(bgr)
    assert out.shape == bgr.shape
    # 强漏光:左上角 R 通道必须高于中值 60s
    assert out[10, 10, 2] > 180, f"top-left R not lifted: {out[10, 10, 2]}"
    # posterize:相同灰度输入下,输出通道值必须落在 8 个以内
    flat = out[:, :, 0].flatten()
    uniq = np.unique(flat)
    assert len(uniq) <= 8, f"posterize too many levels: {len(uniq)}"


def test_apply_filter_with_era_routes_premodern():
    """apply_filter 必须在 era='modern' 时不改变像素。"""
    pil = Image.fromarray(np.full((480, 640, 3), 128, dtype=np.uint8), "RGB")
    out = apply_filter(pil, "faded_90s", era="modern")
    arr = np.array(out)
    # 滤镜仍然会改色,但不应被 era 再加一遍
    np.testing.assert_array_equal(arr, np.array(apply_filter(pil, "faded_90s", era="modern")))
```

### Step 1.2: 跑测试确认红 → 绿

```powershell
cd f:\Trae-work\bighead
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" -m pytest backend/tests/test_filters_era.py -v
```

预期: `3 passed`。

如果失败: 确认 `backend/filters.py` 已加入 `apply_filter(pil, preset, era="modern")` 与 `_era_modern_pixels`、`_era_vintage_2000_pixels` 两个纯函数；`_era_modern_pixels` 直接 `return bgr`；`_era_vintage_2000_pixels` 顺序执行 (1) `cv2.resize` 下采到 640×480 再上采回原尺寸 (2) `cv2.convertScaleAbs(bgr, alpha=1.0, beta=0)` 加 10 像素整体偏色 (3) 顶 1/4 加暖色渐变（`addWeighted` mask）(4) posterize（`bgr // 2 * 2`，5-bit 通道）。详见下面 Step 1.3。

### Step 1.3: 在 `backend/filters.py` 实现 era 算子

**File**: `backend/filters.py`

在文件末尾（`apply_filter_bytes` 之前）新增：

```python
def _era_modern_pixels(bgr: np.ndarray) -> np.ndarray:
    """modern 是身份函数: 不做任何处理。

    保留这个空操作的目的是让 apply_filter 的调用路径恒定 —
    不需要在外层判断 era 是否为 modern 而跳过函数调用。
    """
    return bgr


def _era_vintage_2000_pixels(bgr: np.ndarray) -> np.ndarray:
    """古早画质: 模拟 2000 年 CCD 大头贴机的视觉特征。

    顺序很重要, 后一步覆盖前一步:
      1. 下采到 ~640×480 再上采回原尺寸 —— 复刻 CCD 时代的低分辨率观感,
         人脸皮肤在此过程中被天然平滑。
      2. 顶 1/4 加暖色漏光 —— 模拟机器内置闪光灯打在顶部的暖光溢出。
      3. posterize(每通道右移 1 位再左移 1 位) —— 模拟 5-bit 色彩深度的色阶断层。
    """
    h, w = bgr.shape[:2]
    # 1. 低分辨率感
    small = cv2.resize(bgr, (640, 480), interpolation=cv2.INTER_AREA)
    out = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
    # 2. 顶 1/4 暖色漏光: R +30, G +10, B 不变
    band = out[: h // 4, :, :]
    band = band.astype(np.int16)
    band[..., 2] = np.clip(band[..., 2] + 30, 0, 255)  # R in BGR
    band[..., 1] = np.clip(band[..., 1] + 10, 0, 255)  # G
    out[: h // 4, :, :] = band.astype(np.uint8)
    # 3. posterize: 5-bit 通道
    out = (out >> 1) << 1
    return out


def apply_filter(pil: Image.Image, preset: str = "faded_90s", era: str = "modern") -> Image.Image:
    """对一张 PIL 图应用指定滤镜预设 + 年代处理。"""
    if preset == "none" or preset not in FILTERS:
        # 即便不进滤镜, 年代处理仍要走, 这样 era='vintage_2000' 单独也能出效果
        bgr = _pil_to_bgr(pil)
        bgr = _era_vintage_2000_pixels(bgr) if era == "vintage_2000" else _era_modern_pixels(bgr)
        return _bgr_to_pil(bgr)
    p = FILTERS[preset]["params"]
    bgr = _pil_to_bgr(pil)

    if p.get("bw"):
        bgr = _bw(bgr, p.get("contrast", 1.1))
    elif p.get("vhs"):
        bgr = _vhs(bgr, p.get("shift", 4))
    else:
        bgr = _warmth(bgr, p.get("warmth", 0.0))
        bgr = _fade(bgr, p.get("fade", 0.0))

    bgr = _grain(bgr, p.get("grain", 0))
    bgr = _vignette(bgr, p.get("vignette", 0.0))
    # 年代处理: 在所有滤镜算子之后串接, 让 era 表现得像「最终成片再加一层」
    bgr = _era_vintage_2000_pixels(bgr) if era == "vintage_2000" else _era_modern_pixels(bgr)
    return _bgr_to_pil(bgr)


def apply_filter_bytes(data: bytes, preset: str, era: str = "modern") -> bytes:
    pil = Image.open(io.BytesIO(data))
    out = apply_filter(pil, preset, era=era)
    buf = io.BytesIO()
    out.save(buf, format="JPEG", quality=92)
    return buf.getvalue()
```

修改旧的 `apply_filter` 签名: 把 `preset: str = "faded_90s"` 改成 `preset: str = "faded_90s", era: str = "modern"`（保留位置参数顺序，避免其他模块断）。

`apply_filter_bytes` 同步加 `era: str = "modern"` 参数。

### Step 1.4: 在 `backend/config.py` 加 ERA_PRESETS

**File**: `backend/config.py`

在 FILTERS 定义后（约 L327 之后）新增：

```python
# 年代处理预设。叠加在滤镜之上, 独立成层, 用户在切页/成片上做最终决定。
# modern 是空标识(身份), 不动像素; vintage_2000 是古早大头贴机的标志性低分
# 辨率 + 漏光 + 色阶断层三件套。
ERA_PRESETS: dict[str, str] = {
    "modern": "现代高清",
    "vintage_2000": "古早画质",
}
ERA_DEFAULT: str = "modern"
ERA_KEYS: list[str] = list(ERA_PRESETS.keys())
```

### Step 1.5: 在 `backend/routes/preview.py` 接 era

**File**: `backend/routes/preview.py`

把 handler 改为:

```python
@router.post("/api/preview/filter")
def preview_filter(
    image: bytes = File(...),
    preset: str = Form("faded_90s"),
    era: str = Form("modern"),
) -> Response:
    """滤镜 + 年代处理 预览。

    era 在 form 里, 与 preset 并列, 默认 modern = 不处理。
    FastAPI 对普通 def 自动丢线程池, 不阻塞事件循环。
    """
    from ..config import ERA_KEYS  # 局部 import 避免模块加载期循环
    if preset not in FILTERS:
        raise HTTPException(400, f"unknown filter preset: {preset}")
    if era not in ERA_KEYS:
        raise HTTPException(400, f"unknown era preset: {era}")
    try:
        pil = Image.open(io.BytesIO(image))
        pil.load()
    except (UnidentifiedImageError, OSError) as e:
        raise HTTPException(400, f"invalid image bytes: {e}")

    out = apply_filter(pil, preset, era=era)
    buf = io.BytesIO()
    out.convert("RGB").save(buf, format="JPEG", quality=92)
    return Response(content=buf.getvalue(), media_type="image/jpeg")
```

### Step 1.6: 在 `backend/routes/capture.py` 接 era 并在写盘时烧 era

**File**: `backend/routes/capture.py`

定位到 `/api/capture/save` handler（搜索 `@router.post`），**先读它的现状**（本任务计划在 Step 1.6 之前由执行者**手必实读** `backend/routes/capture.py` 的实现，确认已有「逐张照片写盘」代码的位置，再做下面这一步插入）。实际改动模式：

1. handler 接收 `era: str = Form("modern")`
2. 在 `if era not in ERA_KEYS: raise HTTPException(400, ...)`
3. 在写 `out_path.write_bytes(jpeg_bytes)` 之前，如果 `era != "modern"`，把 `image_bytes` 用 `apply_filter_bytes(image_bytes, era=era)` 重新编码（**注意: 此时不要把滤镜 preset 也烧进去，preset 由取景页在拍照时已烧进 `burnedIn` snapshot；这里只烧 era**。但若 preset 未烧，则需要补 preset。**具体逻辑需与 capture handler 现状对齐**）

伪代码（执行者先读 capture.py 现状再落位）：

```python
@router.post("/api/capture/save")
async def capture_save(
    images: List[bytes] = File(...),
    era: str = Form("modern"),
) -> ...:
    # ... 既有校验 ...
    for i, b in enumerate(images):
        # 既有 decode / save
        if era == "vintage_2000":
            b = apply_filter_bytes(b, preset="none", era="vintage_2000")
        # write
```

注意：capture.save 现在是同步路径（与 preview 一致）。**不要改为 async**，保留 def。

### Step 1.7: 前端类型与常量

**File**: `frontend/src/types.ts`

在文件末尾加：

```typescript
export type EraKey = "modern" | "vintage_2000";

export interface EraPreset {
  key: EraKey;
  name: string;
  /** 描述, 用于 UI 提示。 */
  desc: string;
}

// 追加到 Meta:
export interface Meta {
  styles: StyleInfo[];
  filters: FilterInfo[];
  frames: FrameInfo[];
  layouts: LayoutInfo[];
  era_presets: EraPreset[];   // 新增
}

// FilterInfo 不动 (era 是顶层选择, 不绑到每个滤镜)
```

注意 `Meta` 类型升级后, 所有构造 Meta 的地方都要补 `era_presets: []`（前端初始化），这是 TypeScript 类型契约升级，下游单点独立改。

### Step 1.8: 前端常量与 API

**File**: `frontend/src/components/eras/eraDefs.ts`（新建）

```typescript
import type { EraPreset } from "../../types";

export const ERADESETS: EraPreset[] = [
  { key: "modern", name: "现代高清", desc: "保持原画质, 不做退化" },
  { key: "vintage_2000", name: "古早画质", desc: "低分辨率 + 漏光 + 色阶断层" },
];

export const ERA_DEFAULT: EraPreset["key"] = "modern";
```

**File**: `frontend/src/api.ts`

```typescript
export async function applyFilter(imageBlob: Blob, preset: string, era: string = "modern"): Promise<Blob> {
  const fd = new FormData();
  fd.append("image", imageBlob, "cap.jpg");
  fd.append("preset", preset);
  fd.append("era", era);
  const r = await fetch(`${API}/preview/filter`, { method: "POST", body: fd });
  if (!r.ok) throw new Error("filter failed");
  return r.blob();
}
```

```typescript
export async function saveCaptures(blobs: Blob[], era: string = "modern"): Promise<{ job_id: string; count: number }> {
  const fd = new FormData();
  blobs.forEach((b, i) => fd.append("images", b, `photo_${i + 1}.jpg`));
  fd.append("era", era);
  const r = await fetch(`${API}/capture/save`, { method: "POST", body: fd });
  if (!r.ok) throw new Error("save failed");
  return r.json();
}
```

### Step 1.9: 在 DecoratePage 注入开关

**File**: `frontend/src/pages/DecoratePage.tsx`

新增 state 与 handler：

```typescript
const [era, setEra] = useState<EraKey>("modern");
```

在右侧栏「实时滤镜」block 后面插入新 block：

```tsx
{/* 年代处理 */}
<div className="bg-white rounded-2xl border-2 border-pink p-4">
  <div className="font-pixel text-sm text-brick mb-2">年代</div>
  <div className="grid grid-cols-2 gap-2">
    {ERADESETS.map((e) => (
      <button
        key={e.key}
        onClick={() => setEra(e.key)}
        title={e.desc}
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
```

把 `doLayout` 中的 `applyFilter(b, filter)` 调用改为 `applyFilter(b, filter, era)`：

```typescript
const finalBlobs = needFilter
  ? await Promise.all(blobs.map((b) => applyFilter(b, filter, era)))
  : blobs;
```

把 `saveCaptures(finalBlobs)` 调用改为 `saveCaptures(finalBlobs, era)`。

在页面顶部 imports 加：

```typescript
import { ERADESETS, ERA_DEFAULT } from "../components/eras/eraDefs";
import type { EraKey } from "../types";
```

### Step 1.10: 验证脚本 `verify-vintage-era.mjs`

**File**: `frontend/verify-vintage-era.mjs`（新建）

模式：拷贝 `verify-mask-output.mjs` 的 Playwright 启动段。验证项：

1. **modern era 与原像素断言：mismatch 或 close（JPEG 容差）** —— 直接调 `/api/preview/filter` 上传一张固定 JPEG 两次（modern / vintage_2000），断言字节不同
2. **vintage_2000 era 让顶 1/4 通道数值抬升** —— Playwright 端把 era=vintage_2000 的成片画进 canvas，读 `[0, 10, 10]` 像素的 R/G/B 通道值
3. **DecoratePage 切换 era 触发新拼图字节** —— 启动前端 (URL=http://localhost:5173/decorate)，先 mock frames 进 store（用 page.addInitScript 注入 `window.__store.setFrames`），切换 era 前后各点一次生成，对比两次 layoutUrl 对应的 Blob `hashCode`，断言不同

伪代码（执行者抄结构，填真实方法）：

```javascript
import { chromium } from "playwright";

const URL = process.env.PASS_OR_FAIL || "http://localhost:5173/decorate";
const PASS = [], FAIL = [];
const check = (n, c, d = "") => (c ? PASS : FAIL).push(n) ?? console.log(`[${c ? "PASS" : "FAIL"}] ${n} ${d}`);

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const ctx = await browser.newContext({ permissions: ["camera"] });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "networkidle" });

// 1) era 切换触发新拼图
const beforeHash = await page.evaluate(async () => {
  // 注入测试帧
  const blobs = await Promise.all([
    fetch("data:image/jpeg;base64,...").then(r => r.blob()),
    /* 4 张 1280x960 全灰 jpeg */
  ]);
  window.__store.setFrames(blobs.map(b => ({ url: URL.createObjectURL(b), burnedIn: true })));
  // 点生成
  document.querySelector("button:has-text('生成拼图')").click();
  await new Promise(r => setTimeout(r, 1500));
  const url = window.__store.getState().layoutUrl;
  const bytes = await fetch(url).then(r => r.arrayBuffer());
  let h = 0;
  new Uint8Array(bytes).forEach(b => h = (h * 31 + b) | 0);
  return h;
});
await page.evaluate(() => {
  // 切换 era
  const btns = [...document.querySelectorAll("button")].filter(b => b.textContent === "古早画质");
  btns[0].click();
});
const afterHash = await page.evaluate(async () => {
  document.querySelector("button:has-text('生成拼图')").click();
  await new Promise(r => setTimeout(r, 1500));
  const url = window.__store.getState().layoutUrl;
  const bytes = await fetch(url).then(r => r.arrayBuffer());
  let h = 0;
  new Uint8Array(bytes).forEach(b => h = (h * 31 + b) | 0);
  return h;
});
check("era 切换改变拼图字节", beforeHash !== afterHash);

// 2) 直接调 /api/preview/filter
const apiRes = await page.evaluate(async () => {
  const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 960;
  const ctx = canvas.getContext("2d"); ctx.fillStyle = "#808080"; ctx.fillRect(0, 0, 1280, 960);
  const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg"));
  const fd1 = new FormData(); fd1.append("image", blob); fd1.append("preset", "none"); fd1.append("era", "modern");
  const fd2 = new FormData(); fd2.append("image", blob); fd2.append("preset", "none"); fd2.append("era", "vintage_2000");
  const [r1, r2] = await Promise.all([fetch("/api/preview/filter", { method: "POST", body: fd1 }), fetch("/api/preview/filter", { method: "POST", body: fd2 })]);
  return { m: new Uint8Array(await r1.arrayBuffer()), v: new Uint8Array(await r2.arrayBuffer()) };
});
let diff = 0;
for (let i = 0; i < Math.min(apiRes.m.length, apiRes.v.length); i++) if (apiRes.m[i] !== apiRes.v[i]) diff++;
check("modern 与 vintage_2000 字节不同", diff > 1000);

console.log(`\nResult: ${PASS.length} passed, ${FAIL.length} failed`);
await browser.close();
process.exit(FAIL.length ? 1 : 0);
```

### Step 1.11: 跑后端预检 + 后端门禁

```powershell
cd f:\Trae-work\bighead
ruff check backend scripts
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" -m compileall -q backend scripts
```

预期: 无报错。

### Step 1.12: 跑新任务 1 的 Playwright 验证

```powershell
cd f:\Trae-work\bighead\frontend
npm run lint
node verify-vintage-era.mjs
```

预期: `Result: N passed, 0 failed`。

### Step 1.13: 提交

```powershell
cd f:\Trae-work\bighead
git add backend/filters.py backend/config.py backend/routes/preview.py backend/routes/capture.py backend/tests/test_filters_era.py frontend/src/types.ts frontend/src/api.ts frontend/src/components/eras/eraDefs.ts frontend/src/pages/DecoratePage.tsx frontend/verify-vintage-era.mjs
git commit -m "feat: era preset (modern | vintage_2000) 叠在滤镜之上"
```

---

## Task 2: 手写涂鸦层（成片烧录）

**Files:**

- Create: `frontend/src/components/doodles/DoodleCanvas.tsx`
- Create: `frontend/src/components/doodles/doodleTypes.ts`
- Modify: `frontend/src/store.ts`（加 `doodles` + `setDoodle` + `clearDoodle`）
- Modify: `frontend/src/pages/DecoratePage.tsx`（嵌入 DoodleCanvas + 烧录）
- Test: `frontend/verify-doodle-burn.mjs`

### Step 2.1: 涂鸦数据结构

**File**: `frontend/src/components/doodles/doodleTypes.ts`（新建）

```typescript
/** 一笔。一个 down→move*→up 序列。 */
export interface DoodleStroke {
  /** RGBA tuple, A=1 表示实心。 */
  color: string;
  /** 笔刷半径(像素, 相对照片短边 960px 基准) */
  width: number;
  /** 工具: marker(马克笔), highlighter(半透明), eraser(橡皮) */
  tool: "marker" | "highlighter" | "eraser";
  /** 屏幕坐标相对照片区域 (0..1) */
  points: Array<{ x: number; y: number }>;
}

/** 一张照片一张涂鸦层。photos 用 array index 当照片序号。 */
export type DoodlesByIndex = Record<number, DoodleStroke[]>;
```

### Step 2.2: DoodleCanvas 组件（UI 编辑器）

**File**: `frontend/src/components/doodles/DoodleCanvas.tsx`（新建）

```typescript
import { useCallback, useEffect, useRef, useState } from "react";
import type { DoodleStroke } from "./doodleTypes";

interface Props {
  /** 当前照片 src (data URL 或 /outputs URL) */
  src: string;
  /** 已存在的笔画 */
  strokes: DoodleStroke[];
  /** 选中色板 RGBA */
  color: string;
  /** 选中笔刷 (marker/highlighter/eraser) */
  tool: "marker" | "highlighter" | "eraser";
  /** 笔刷半径(像素) */
  width: number;
  /** 笔画变化回调(每落一笔) */
  onChange: (strokes: DoodleStroke[]) => void;
  /** 容器像素尺寸, 用来 set canvas 实际像素 */
  width: number;
  height: number;
}

const SCALE = 960; // 笔刷半径 / 坐标基准(短边 960)

export function DoodleCanvas({ src, strokes, color, tool, width, onChange, width: W, height: H }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const currentRef = useRef<DoodleStroke | null>(null);
  const [drawing, setDrawing] = useState(false);

  // 渲染笔画: 全量重绘 strokes + current
  const render = useCallback((extra?: DoodleStroke) => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext("2d"); if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const all = [...strokes];
    if (extra) all.push(extra);
    const sx = c.width / W, sy = c.height / H;
    for (const s of all) paintStroke(ctx, s, sx, sy);
  }, [strokes, W, H]);

  useEffect(() => { render(); }, [render]);

  const onDown = (e: React.PointerEvent) => {
    const c = canvasRef.current; if (!c) return;
    const rect = c.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width; // 0..1
    const y = (e.clientY - rect.top) / rect.height;
    const stroke: DoodleStroke = { color, width, tool, points: [{ x, y }] };
    currentRef.current = stroke;
    setDrawing(true);
    c.setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drawing) return;
    const c = canvasRef.current; if (!c || !currentRef.current) return;
    const rect = c.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    currentRef.current.points.push({ x, y });
    render(currentRef.current);
  };

  const onUp = () => {
    if (!drawing || !currentRef.current) return;
    const final = currentRef.current;
    currentRef.current = null;
    setDrawing(false);
    onChange([...strokes, final]);
  };

  return (
    <div className="relative" style={{ width: W, height: H }}>
      <img src={src} alt="" className="absolute inset-0 w-full h-full object-cover" />
      <canvas
        ref={canvasRef}
        width={Math.round(W * 2)}
        height={Math.round(H * 2)}
        style={{ width: W, height: H }}
        className="absolute inset-0 touch-none cursor-crosshair"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
    </div>
  );
}

/** 把一笔画到 ctx 上。坐标已是相对 (0..1) → 乘画布尺寸。 */
function paintStroke(ctx: CanvasRenderingContext2D, s: DoodleStroke, sx: number, sy: number) {
  if (s.points.length < 2) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = s.color;
  ctx.lineWidth = (s.width / SCALE) * Math.min(sx, sy) * cwidth(s.tool);
  if (s.tool === "highlighter") ctx.globalAlpha = 0.4;
  if (s.tool === "eraser") ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  const p0 = s.points[0];
  ctx.moveTo(p0.x * sx, p0.y * sy);
  for (let i = 1; i < s.points.length; i++) {
    const p = s.points[i];
    ctx.lineTo(p.x * sx, p.y * sy);
  }
  ctx.stroke();
  ctx.restore();
}

function cwidth(tool: "marker" | "highlighter" | "eraser"): number {
  // 马克笔粗, 荧光笔细, 橡皮等同马克笔
  if (tool === "highlighter") return 1.4;
  return 1.0;
}
```

### Step 2.3: 在 store 加 doodles

**File**: `frontend/src/store.ts`

新增字段与 setter（在 `setMaskGalleryOpen` 后）：

```typescript
import type { DoodleStroke } from "./components/doodles/doodleTypes";

export interface CaptureState {
  // ... 既有字段 ...
  /** 每张照片的涂鸦笔画。index 是 frames 数组中的位置 */
  doodles: Record<number, DoodleStroke[]>;
  setDoodles: (idx: number, strokes: DoodleStroke[]) => void;
  clearDoodle: (idx: number) => void;
  // ... 既有 setters ...
}

const initial = {
  // ... 既有 ...
  doodles: {} as Record<number, DoodleStroke[]>,
};

// 在 useStore 初始 state 加 `doodles: {}`
// 在 setLayoutUrl 后加:
setDoodles: (idx, strokes) => set((s) => ({ doodles: { ...s.doodles, [idx]: strokes } })),
clearDoodle: (idx) => set((s) => {
  const next = { ...s.doodles }; delete next[idx]; return { doodles: next };
}),
// 在 reset() 里加 `doodles: {},`
```

### Step 2.4: 在 DecoratePage 集成涂鸦 UI 与色板

**File**: `frontend/src/pages/DecoratePage.tsx`

1. 引入 `DoodleCanvas` 与 doodle types 与色板常量：

```typescript
import { DoodleCanvas } from "../components/doodles/DoodleCanvas";
import type { DoodleStroke } from "../components/doodles/doodleTypes";

// 8 色色板, 古早机常见: 黑/白/红/蓝/绿/粉/黄/紫
const DOODLE_COLORS = [
  "#1a1a1a", "#ffffff", "#ff3b30", "#3b6cff",
  "#22c55e", "#ec4899", "#facc15", "#a855f7",
];
const DOODLE_WIDTHS = [4, 8, 14];
```

2. 新增 state：

```typescript
const doodles = useStore((s) => s.doodles);
const setDoodles = useStore((s) => s.setDoodles);
const clearDoodle = useStore((s) => s.clearDoodle);
const [doodleColor, setDoodleColor] = useState(DOODLE_COLORS[0]);
const [doodleTool, setDoodleTool] = useState<"marker" | "highlighter" | "eraser">("marker");
const [doodleWidth, setDoodleWidth] = useState(DOODLE_WIDTHS[1]);
const [editingIdx, setEditingIdx] = useState<number | null>(null);
```

3. 把当前照片缩略图 block（line 405-417）改为「点击进入编辑模式」：

```tsx
{displayImages.slice(0, 8).map((src, i) => (
  <button
    key={i}
    type="button"
    onClick={() => setEditingIdx(i)}
    className="relative aspect-[3/4] bg-white rounded-lg border-2 border-pink overflow-hidden text-left"
  >
    <img src={src} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
    {doodles[i]?.length > 0 && (
      <span className="absolute top-1 right-1 bg-brick text-white text-[10px] px-1.5 py-0.5 rounded-full">
        {doodles[i].length} 笔
      </span>
    )}
  </button>
))}
```

4. 在右侧栏底部新增「涂鸦」block（与 era block 同级）：

```tsx
<div className="bg-white rounded-2xl border-2 border-pink p-4">
  <div className="font-pixel text-sm text-brick mb-2">涂鸦</div>
  <div className="text-[10px] text-brown/60 mb-2">
    点击上方任意照片进入编辑 · 已绘制 {Object.values(doodles).reduce((a, b) => a + b.length, 0)} 笔
  </div>
  <div className="grid grid-cols-4 gap-1.5 mb-2">
    {DOODLE_COLORS.map((c) => (
      <button
        type="button"
        key={c}
        onClick={() => setDoodleColor(c)}
        aria-label={`color ${c}`}
        style={{ background: c }}
        className={`h-7 w-full rounded-full border-2 ${doodleColor === c ? "border-brick" : "border-white"}`}
      />
    ))}
  </div>
  <div className="flex gap-1.5 mb-2">
    {(["marker", "highlighter", "eraser"] as const).map((t) => (
      <button
        type="button"
        key={t}
        onClick={() => setDoodleTool(t)}
        className={`flex-1 px-2 py-1 rounded text-xs ${doodleTool === t ? "bg-brick text-white" : "bg-cream text-brown border border-pink"}`}
      >
        {t === "marker" ? "马克笔" : t === "highlighter" ? "荧光笔" : "橡皮"}
      </button>
    ))}
  </div>
  <div className="flex gap-1.5">
    {DOODLE_WIDTHS.map((w) => (
      <button
        type="button"
        key={w}
        onClick={() => setDoodleWidth(w)}
        className={`flex-1 py-1 rounded text-xs ${doodleWidth === w ? "bg-brick text-white" : "bg-cream text-brown border border-pink"}`}
      >
        {w === 4 ? "细" : w === 8 ? "中" : "粗"}
      </button>
    ))}
  </div>
  {editingIdx !== null && (
    <button
      type="button"
      onClick={() => clearDoodle(editingIdx)}
      className="mt-2 w-full px-2 py-1 text-xs text-brown border border-pink rounded hover:bg-pink/20"
    >
      清空当前涂鸦
    </button>
  )}
</div>
```

5. 在主显示区（line 417 之后）插入编辑模态：

```tsx
{editingIdx !== null && displayImages[editingIdx] && (
  <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center" onClick={() => setEditingIdx(null)}>
    <div className="bg-cream rounded-2xl p-4 max-w-2xl w-[92vw]" onClick={(e) => e.stopPropagation()}>
      <div className="flex justify-between items-center mb-3">
        <div className="font-pixel text-brick">编辑涂鸦 #{editingIdx + 1}</div>
        <button type="button" onClick={() => setEditingIdx(null)} className="px-3 py-1 rounded-full bg-brick text-white text-sm">完成</button>
      </div>
      <DoodleCanvas
        src={displayImages[editingIdx]}
        strokes={doodles[editingIdx] ?? []}
        color={doodleColor}
        tool={doodleTool}
        width={doodleWidth}
        onChange={(s) => setDoodles(editingIdx, s)}
        width={640}
        height={480}
      />
      <div className="mt-3 text-[10px] text-brown/60">
        撤销: 在「涂鸦」侧栏选橡皮擦逐笔擦除 · 所有涂鸦在点生成拼图时烧进最终图
      </div>
    </div>
  </div>
)}
```

### Step 2.6: 拼图前烧录涂鸦

**File**: `frontend/src/pages/DecoratePage.tsx`

在 `doLayout` 的「AI 写真」分支前插入烧录步骤：

```typescript
async function doLayout(useAi: boolean) {
  setError(null);
  setBusy(true);
  try {
    // 1) 涂鸦烧录: 每张照片如果有 doodle, 把它画到 blob 上。
    //    在 burnFilter 之前做, 这样涂鸦也会被 era + filter 一并处理 (所见即所得)。
    const stamped = await Promise.all(frames.map(async (f, idx) => {
      const blob = await dataUrlToBlob(f.url);
      if (!doodles[idx] || doodles[idx].length === 0) return blob;
      return burnDoodles(blob, doodles[idx]);
    }));

    const needFilter = frames.some((f) => !f.burnedIn);
    const finalBlobs = needFilter
      ? await Promise.all(stamped.map((b) => applyFilter(b, filter, era)))
      : stamped;

    if (useAi) {
      const cap = await saveCaptures(finalBlobs, era);
      // ... 既有 ...
    }

    const result = await makeLayout(finalBlobs, layout, frameOverride ?? "none");
    // ... 既有 ...
  }
}
```

新增 `burnDoodles` 工具函数（放在文件顶部 dataUrlToBlob 旁）：

```typescript
async function burnDoodles(photoBlob: Blob, strokes: DoodleStroke[]): Promise<Blob> {
  const bitmap = await createImageBitmap(photoBlob);
  const W = bitmap.width;
  const H = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d"); if (!ctx) return photoBlob;
  ctx.drawImage(bitmap, 0, 0, W, H);
  for (const s of strokes) {
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = s.color;
    ctx.lineWidth = (s.width / 960) * Math.min(W, H) * (s.tool === "highlighter" ? 1.4 : 1.0);
    if (s.tool === "highlighter") ctx.globalAlpha = 0.4;
    if (s.tool === "eraser") ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    const p0 = s.points[0]; ctx.moveTo(p0.x * W, p0.y * H);
    for (let i = 1; i < s.points.length; i++) {
      const p = s.points[i]; ctx.lineTo(p.x * W, p.y * H);
    }
    ctx.stroke();
    ctx.restore();
  }
  return new Promise((resolve) => canvas.toBlob(b => resolve(b ?? photoBlob), "image/jpeg", 0.92));
}
```

### Step 2.7: 验证脚本 `verify-doodle-burn.mjs`

**File**: `frontend/verify-doodle-burn.mjs`（新建）

模式：拷 `verify-vintage-era.mjs` 启动段。验证项：

1. **store.setDoodles 写入后, doodles[idx] 是非空数组** —— Playwright 端调 `window.__store.getState().doodles`
2. **添加涂鸦再生成拼图, 拼图字节与未加涂鸦时不同**
3. **生成的 layout.jpg 中部必然存在非背景色像素（涂鸦）** —— Playwright 把 layoutUrl 拉下来, 画到 canvas, 取中心 200×200 区域的非白像素数 > 0

伪代码结构同 Task 1.10，差别只在断言。

### Step 2.8: 前端门禁

```powershell
cd f:\Trae-work\bighead\frontend
npm run typecheck
npm run lint
```

预期: 无报错。

### Step 2.9: 跑新脚本

```powershell
cd f:\Trae-work\bighead\frontend
node verify-doodle-burn.mjs
```

预期: `Result: N passed, 0 failed`。

### Step 2.10: 提交

```powershell
cd f:\Trae-work\bighead
git add frontend/src/components/doodles/DoodleCanvas.tsx frontend/src/components/doodles/doodleTypes.ts frontend/src/store.ts frontend/src/pages/DecoratePage.tsx frontend/verify-doodle-burn.mjs
git commit -m "feat: doodle layer (手写涂鸦, 拼图前烧录)"
```

---

## Task 3: 贴纸自由编排（自研 canvas 拖拽）

**Files:**

- Create: `frontend/src/components/stickers/StickerEditor.tsx`
- Modify: `frontend/src/store.ts`（加 `stickerOverrides`）
- Modify: `frontend/src/components/masks/maskDefs.ts`（**不改**，确认 sticker 是可独立摆放的最小单元）
- Modify: `frontend/src/components/masks/renderMask.ts`（**不改** — 见 Step 3.1）
- Modify: `frontend/src/pages/DecoratePage.tsx`（嵌入 StickerEditor + 自定义贴纸绘制）
- Test: `frontend/verify-sticker-edit.mjs`

> **关键约束**: 不动 `renderMask.ts` 的契约（预览=出片）。StickerEditor 接管「蒙版层以外的贴纸」—— 用户在取景时选定的蒙版里的贴纸仍走 renderMask 的旧路径；用户**额外**添加的贴纸走 StickerEditor 路径，绘制到 Store 化的「stickerOverrides」层。
>
> 拼图前一刻，把 `renderMask(m, w, h)` 与「stickerOverrides 重绘后的层」合并，**烧进 blob**。

### Step 3.1: 数据结构与 store 增量

**File**: `frontend/src/components/stickers/stickerTypes.ts`（新建）

```typescript
import type { StickerShapeKey } from "../masks/geometry";

/** 一个用户摆放的贴纸。坐标相对照片区域 (0..1)。 */
export interface StickerPlacement {
  /** 形状 key, 与 STICKER_SHAPES 对应 */
  shape: StickerShapeKey;
  /** 中心 x (0..1) */
  x: number;
  /** 中心 y (0..1) */
  y: number;
  /** 边长, 相对短边 (0..1) */
  size: number;
  /** 旋转角度, 度 */
  rotation: number;
  /** 填充色 */
  fill: string;
  /** 描边色 (可选) */
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
}

export type StickersByIndex = Record<number, StickerPlacement[]>;
```

**File**: `frontend/src/store.ts`

```typescript
import type { StickerPlacement } from "./components/stickers/stickerTypes";

// 在 CaptureState 加:
stickerOverrides: Record<number, StickerPlacement[]>;
setStickerOverrides: (idx: number, list: StickerPlacement[]) => void;
clearStickerOverrides: (idx: number) => void;

// 初始 state: stickerOverrides: {}
// setters:
setStickerOverrides: (idx, list) => set((s) => ({ stickerOverrides: { ...s.stickerOverrides, [idx]: list } })),
clearStickerOverrides: (idx) => set((s) => {
  const next = { ...s.stickerOverrides }; delete next[idx]; return { stickerOverrides: next };
}),
// reset() 里: stickerOverrides: {},
```

### Step 3.2: StickerEditor 组件

**File**: `frontend/src/components/stickers/StickerEditor.tsx`（新建）

```typescript
import { useCallback, useEffect, useRef, useState } from "react";
import { STICKER_SHAPES } from "../masks/geometry";
import type { StickerShapeKey } from "../masks/geometry";
import type { StickerPlacement } from "./stickerTypes";

interface Props {
  src: string;
  stickers: StickerPlacement[];
  onChange: (s: StickerPlacement[]) => void;
  width: number;
  height: number;
}

const COLORS = ["#ff6b6b", "#facc15", "#22c55e", "#3b6cff", "#ec4899", "#1a1a1a", "#ffffff"];
const SHAPES: StickerShapeKey[] = ["heart", "star", "flower", "burst", "circle", "cloud"];

export function StickerEditor({ src, stickers, onChange, width: W, height: H }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [tool, setTool] = useState<StickerShapeKey | "select">("select");
  const [color, setColor] = useState(COLORS[0]);
  const [selected, setSelected] = useState<number | null>(null);
  const dragRef = useRef<{ idx: number; mode: "move" | "rotate" | "scale"; offX: number; offY: number } | null>(null);

  const render = useCallback(() => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext("2d"); if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const sx = c.width / W, sy = c.height / H;
    for (let i = 0; i < stickers.length; i++) paintSticker(ctx, stickers[i], sx, sy, i === selected);
  }, [stickers, W, H, selected]);

  useEffect(() => { render(); }, [render]);

  // 命中测试: 取最近一个中心距离 < size/2 的贴纸
  const hitTest = useCallback((x: number, y: number): number => {
    for (let i = stickers.length - 1; i >= 0; i--) {
      const s = stickers[i];
      const dx = (x - s.x) * Math.min(W, H);
      const dy = (y - s.y) * Math.min(W, H);
      const half = (s.size * Math.min(W, H)) / 2;
      if (Math.abs(dx) < half && Math.abs(dy) < half) return i;
    }
    return -1;
  }, [stickers, W, H]);

  const onDown = (e: React.PointerEvent) => {
    const c = canvasRef.current; if (!c) return;
    const rect = c.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (tool === "select") {
      const hit = hitTest(x, y);
      if (hit < 0) { setSelected(null); return; }
      setSelected(hit);
      dragRef.current = { idx: hit, mode: "move", offX: 0, offY: 0 };
    } else {
      // 新增贴纸
      const next: StickerPlacement[] = [...stickers, { shape: tool, x, y, size: 0.16, rotation: 0, fill: color }];
      onChange(next);
      setSelected(next.length - 1);
      setTool("select");
    }
    c.setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const c = canvasRef.current; if (!c) return;
    const rect = c.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const idx = dragRef.current.idx;
    const next = [...stickers];
    next[idx] = { ...next[idx], x, y };
    onChange(next);
  };

  const onUp = () => { dragRef.current = null; };

  // 键盘删除
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (selected === null) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        const target = target_isEditing(e.target);
        if (target) return; // 输入框内不拦截
        e.preventDefault();
        const next = stickers.filter((_, i) => i !== selected);
        onChange(next);
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, stickers, onChange]);

  return (
    <div className="relative" style={{ width: W, height: H }}>
      <img src={src} alt="" className="absolute inset-0 w-full h-full object-cover" />
      <canvas
        ref={canvasRef}
        width={Math.round(W * 2)}
        height={Math.round(H * 2)}
        style={{ width: W, height: H }}
        className="absolute inset-0 touch-none"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
      <div className="absolute top-2 left-2 bg-white/90 rounded-full p-1 flex gap-1">
        <button type="button" onClick={() => setTool("select")} className={`text-xs px-2 py-1 rounded-full ${tool === "select" ? "bg-brick text-white" : ""}`}>
          选择
        </button>
        {SHAPES.map((sh) => (
          <button key={sh} type="button" onClick={() => setTool(sh)} className={`text-xs px-2 py-1 rounded-full ${tool === sh ? "bg-brick text-white" : "bg-cream"}`}>
            {sh}
          </button>
        ))}
      </div>
      <div className="absolute top-2 right-2 bg-white/90 rounded-full p-1 flex gap-1">
        {COLORS.map((c) => (
          <button key={c} type="button" onClick={() => setColor(c)} aria-label={`c ${c}`} style={{ background: c, width: 16, height: 16, borderRadius: 8 }} />
        ))}
      </div>
    </div>
  );
}

function target_isEditing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

function paintSticker(ctx: CanvasRenderingContext2D, s: StickerPlacement, sx: number, sy: number, highlight: boolean) {
  const u = Math.min(sx, sy);
  const cx = s.x * sx;
  const cy = s.y * sy;
  const size = s.size * u;
  ctx.save();
  ctx.translate(cx, cy);
  if (s.rotation) ctx.rotate((s.rotation * Math.PI) / 180);
  ctx.scale(size, size);
  ctx.translate(-0.5, -0.5);
  ctx.globalAlpha = s.opacity ?? 1;
  const path = STICKER_SHAPES[s.shape];
  if (!path) { ctx.restore(); return; }
  const p = new Path2D(path);
  if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(p); }
  if (s.stroke) {
    ctx.strokeStyle = s.stroke;
    ctx.lineWidth = (s.strokeWidth ?? 2) / size;
    ctx.stroke(p);
  }
  if (highlight) {
    ctx.strokeStyle = "#3b6cff";
    ctx.lineWidth = 2 / size;
    ctx.setLineDash([4 / size, 4 / size]);
    ctx.strokeRect(0, 0, 1, 1);
  }
  ctx.restore();
}
```

### Step 3.3: 在 DecoratePage 集成贴纸

复用 Step 2.5 的「编辑模态」机制。把 `editingIdx !== null` 的模态扩展为「涂鸦 / 贴纸」两个 tab：

1. state 加：

```typescript
const stickerOverrides = useStore((s) => s.stickerOverrides);
const setStickerOverrides = useStore((s) => s.setStickerOverrides);
const clearStickerOverrides = useStore((s) => s.clearStickerOverrides);
const [editMode, setEditMode] = useState<"doodle" | "sticker">("doodle");
```

2. 模态顶层加 tab 切换：

```tsx
<div className="flex gap-2 mb-3">
  <button type="button" onClick={() => setEditMode("doodle")} className={`px-3 py-1 rounded-full text-sm ${editMode === "doodle" ? "bg-brick text-white" : "bg-cream"}`}>涂鸦</button>
  <button type="button" onClick={() => setEditMode("sticker")} className={`px-3 py-1 rounded-full text-sm ${editMode === "sticker" ? "bg-brick text-white" : "bg-cream"}`}>贴纸</button>
</div>
{editMode === "doodle" ? (
  <DoodleCanvas ... />
) : (
  <StickerEditor ... />
)}
```

3. 右侧栏底部加「贴纸」block（涂鸦 block 之后）：

```tsx
<div className="bg-white rounded-2xl border-2 border-pink p-4">
  <div className="font-pixel text-sm text-brick mb-2">贴纸</div>
  <div className="text-[10px] text-brown/60 mb-2">
    点击照片进入编辑 → 选形状 → 点击落点 → 拖动调位 · 已摆放 {Object.values(stickerOverrides).reduce((a, b) => a + b.length, 0)} 个
  </div>
  {editingIdx !== null && stickerOverrides[editingIdx]?.length > 0 && (
    <button type="button" onClick={() => clearStickerOverrides(editingIdx)} className="mt-1 w-full px-2 py-1 text-xs text-brown border border-pink rounded hover:bg-pink/20">
      清空当前贴纸
    </button>
  )}
</div>
```

### Step 3.4: 拼图前烧录贴纸层

**File**: `frontend/src/pages/DecoratePage.tsx`

新增工具（在 burnDoodles 旁）：

```typescript
async function burnStickers(
  photoBlob: Blob,
  stickers: StickerPlacement[],
): Promise<Blob> {
  if (stickers.length === 0) return photoBlob;
  const bitmap = await createImageBitmap(photoBlob);
  const W = bitmap.width, H = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d"); if (!ctx) return photoBlob;
  ctx.drawImage(bitmap, 0, 0, W, H);
  for (const s of stickers) {
    const path = STICKER_SHAPES[s.shape];
    if (!path) continue;
    const u = Math.min(W, H);
    const size = s.size * u;
    ctx.save();
    ctx.translate(s.x * W, s.y * H);
    if (s.rotation) ctx.rotate((s.rotation * Math.PI) / 180);
    ctx.scale(size, size);
    ctx.translate(-0.5, -0.5);
    ctx.globalAlpha = s.opacity ?? 1;
    const p = new Path2D(path);
    if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(p); }
    if (s.stroke) { ctx.strokeStyle = s.stroke; ctx.lineWidth = (s.strokeWidth ?? 2) / size; ctx.stroke(p); }
    ctx.restore();
  }
  return new Promise((resolve) => canvas.toBlob(b => resolve(b ?? photoBlob), "image/jpeg", 0.92));
}
```

并在 `doLayout` 的 `stamped` 计算时把贴纸也烧进：

```typescript
const stamped = await Promise.all(frames.map(async (f, idx) => {
  let blob = await dataUrlToBlob(f.url);
  // 先烧贴纸（在 doodle 前），让贴纸在下层, doodle 可覆盖
  if (stickerOverrides[idx]?.length) blob = await burnStickers(blob, stickerOverrides[idx]);
  if (doodles[idx]?.length) blob = await burnDoodles(blob, doodles[idx]);
  return blob;
}));
```

并在顶部 imports 加：

```typescript
import { STICKER_SHAPES } from "../components/masks/geometry";
import type { StickerPlacement } from "../components/stickers/stickerTypes";
```

### Step 3.5: 验证脚本 `verify-sticker-edit.mjs`

**File**: `frontend/verify-sticker-edit.mjs`（新建）

模式：拷 `verify-vintage-era.mjs` 启动段。验证项：

1. **store.setStickerOverrides 写入后, stickerOverrides[idx] 是非空数组**
2. **添加贴纸再生成拼图, 拼图字节与未加时不同**
3. **layout.jpg 中部必有「红/黄/蓝」等纯色块像素**

### Step 3.6: 前端门禁

```powershell
cd f:\Trae-work\bighead\frontend
npm run typecheck
npm run lint
```

预期: 无报错。

### Step 3.7: 跑新脚本

```powershell
cd f:\Trae-work\bighead\frontend
node verify-sticker-edit.mjs
```

预期: `Result: N passed, 0 failed`。

### Step 3.8: 提交

```powershell
cd f:\Trae-work\bighead
git add frontend/src/components/stickers/StickerEditor.tsx frontend/src/components/stickers/stickerTypes.ts frontend/src/store.ts frontend/src/pages/DecoratePage.tsx frontend/verify-sticker-edit.mjs
git commit -m "feat: sticker editor (自研 canvas 拖拽 + 拼图前烧录)"
```

---

## Task 4: 全量门禁 + 全量回归

**Files:** none

### Step 4.1: 后端预检 + 门禁

```powershell
cd f:\Trae-work\bighead
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" -c "from backend.filters import apply_filter; from backend.config import ERA_PRESETS; print('PY=', __import__('sys').executable); print('OK=', len(ERA_PRESETS))"
ruff check backend scripts
& "<WEBUI_ROOT>\.venv\Scripts\python.exe" -m compileall -q backend scripts
```

预期: 输出 `PY= <WEBUI_ROOT>\python.exe` + `OK= 2`，无 compile 报错，无 ruff 报错。

### Step 4.2: 前端门禁

```powershell
cd f:\Trae-work\bighead\frontend
npm run typecheck
npm run lint
```

预期: 无报错。

### Step 4.3: 启动后端 + 前端

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

### Step 4.4: 跑全部 11 个验证脚本

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
node verify-vintage-era.mjs
node verify-doodle-burn.mjs
node verify-sticker-edit.mjs
```

预期: 11 个脚本全部 0 失败（既有 8 个不变，新 3 个 0 失败）。

如果既有脚本失败，先检查是否动了 [store.ts](file:///f:/Trae-work/bighead/frontend/src/store.ts) 的 `setFrames` 等既有 setter 签名。本任务 plan 没有改这些签名，**预期无回归**。

### Step 4.5: 写入 review 文档

**File**: `docs/review/2026-10-05-p0-vintage-parity.md`（新建）

追加一段到 [2026-10-04-code-review.md](file:///f:/Trae-work/bighead/docs/review/2026-10-04-code-review.md) 末尾，记录：

- 三项功能实际改动文件清单
- 验证脚本断言数（3 + 11）
- 任何与计划偏离（file path 调整、默认值偏离等）
- 已知遗留（橡皮擦 strokeWidth / 单张 vs 4 张贴纸 / 笔刷颜色 palette 等)

---

## Self-Review Checklist（写计划时已自审）

- [x] **Spec 覆盖**：竞品分析的 P0 三项每一项都有独立 Task（1 / 2 / 3），Task 4 是回归门禁。
- [x] **占位符扫描**：所有代码块都是具体实现，没有 "TBD / TODO / 适当处理" 等含糊词。
- [x] **类型一致性**：
  - `EraKey = "modern" | "vintage_2000"` 在 [types.ts](file:///f:/Trae-work/bighead/frontend/src/types.ts) 与 [eraDefs.ts](file:///f:/Trae-work/bighead/frontend/src/components/eras/eraDefs.ts) 一致。
  - `DoodleStroke.tool` 与 `burnDoodles` 的 `s.tool` 字段同源。
  - `StickerPlacement.shape` 与 `STICKER_SHAPES` 同源（来自 [geometry.ts](file:///f:/Trae-work/bighead/frontend/src/components/masks/geometry.ts)）。
  - `Meta.era_presets` 是新增字段，所有构造 Meta 的地方（[DecoratePage.tsx](file:///f:/Trae-work/bighead/frontend/src/pages/DecoratePage.tsx) line 64-66, [HomePage.tsx](file:///f:/Trae-work/bighead/frontend/src/pages/HomePage.tsx)）需要补 `era_presets: []` —— **这是已知风险点**，执行者需在 Task 1.7 同步扫描并修改。
- [x] **后端契约**：era Form 字段在 [preview.py](file:///f:/Trae-work/bighead/backend/routes/preview.py) 与 [capture.py](file:///f:/Trae-work/bighead/backend/routes/capture.py) 都接，但 [capture.py](file:///f:/Trae-work/bighead/backend/routes/capture.py) 的现状需执行者**先读后改**（Step 1.6 已说明）。
- [x] **未修改** [renderMask.ts](file:///f:/Trae-work/bighead/frontend/src/components/masks/renderMask.ts) ——「预览=出片」契约保持。
- [x] **未引入 Konva** —— 纯 canvas + 自研命中测试。

---

## 执行入口

**Plan complete and saved to `docs/superpowers/plans/2026-10-05-p0-vintage-parity.md`. Two execution options:**

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**