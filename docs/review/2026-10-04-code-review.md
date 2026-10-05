# 代码审查记录：语法缺陷与性能优化

- 审查日期：2026-10-04
- 范围：`backend/`（FastAPI + OpenCV + Qwen-Image-Edit）、`frontend/src`（React 18 + TS + zustand）
- 方法：编译器/类型检查兜底 + 人工逐文件审查；每条结论均已回读源码确认
- **状态：三批修复已全部完成并验证**（详见文末「修复记录」）

## 修复状态总览

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| 第一批 | 7 项：事件循环阻塞、CORS、渲染热循环、摄像头泄漏、Blob 泄漏、死依赖 | ✅ 已修 |
| 第二批 | 7 项：`burnedIn` 语义、WS 兜底、AI 拼图、滤镜优化、缓存上限、页面容错 | ✅ 已修 |
| 第三批 | 9 项：worker 半死、上传校验、代码清理、组件 memo、**ruff + eslint 接入** | ✅ 已修 |
| 工具链 | `pyproject.toml`(ruff) + `frontend/eslint.config.js`(eslint 9) + `npm run lint` | ✅ 已接入 |

**修复后的质量门禁**（全部通过）：

```
ruff check backend            → All checks passed
compileall backend scripts    → 0 错误
tsc -b --force                → 0 错误
eslint src                    → 0 error, 1 warning(已说明理由)
vite build                    → 成功, 217 KB / gzip 71 KB
全链路冒烟(meta→capture→filter→layout→ai_layout→jobs→health) → 通过
```

> **工具链的价值已被验证**：eslint 上线当天就抓出 7 个问题，其中 3 个是修复过程中
> 新引入的（未使用的 `retryCount`、两处渲染期写 ref、`Date.now()` 纯度）。
> 这正是「零 lint → 人工审查」模式漏网的东西，现在有机制兜底了。

---

## 0. 编译级检查结果（审查当时）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| Python 语法 | `python -m compileall -q backend scripts` | **0 错误** |
| 前端类型 | `tsc -b --force`（strict: true） | **0 错误** |

**重要前提**：审查当时该项目**没有任何 lint 工具链**（无 eslint / ruff / flake8 / mypy 配置），
`package.json` 里也没有 `lint` 脚本。因此「语法缺陷」在编译层面为零，
真正的风险全部集中在**编译器无法捕获的语义层**：引用不稳定、事件循环阻塞、资源泄漏、状态语义错误。

> 该建议已在第三批落实：`pyproject.toml` 启用 ruff（`F` + `E9` 规则集，排除 vendor），
> `frontend/eslint.config.js` 启用 eslint 9 + typescript-eslint + react-hooks，
> 并把 `react-hooks/exhaustive-deps` 提为 `error`——它能自动拦住 S1-1 那类不稳定依赖。

---

## 1. 严重问题（功能性缺陷）

### S1-1 `getMask()` 返回不稳定引用 → 蒙版渲染热循环 + 每次重跑全画布 PNG 编码

`frontend/src/components/LiveCamera.tsx:158` 在**渲染体**里调用：

```tsx
const maskDef = getMask(maskKey);
```

而 `frontend/src/components/masks/maskLibrary.ts:99-112`：

```ts
export function getImageMasks(): ImageMaskDef[] {
  return getLoadedManifest().masks.map(toImageMask);   // 每次重建全部对象
}

export function getMask(key: string | null | undefined): MaskDef | undefined {
  if (!key || key === "none") return undefined;
  const builtin = MASKS_BY_KEY[key];
  if (builtin) return builtin;                        // 内置：稳定引用 ✓
  return getImageMasks().find((m) => m.key === key);  // 图库：每次全新对象 ✗
}
```

**后果链**（选中图库位图蒙版时）：

1. `maskDef` 每次渲染都是新对象引用
2. 直接引爆 `LiveCamera.tsx:175` 与 `LiveCamera.tsx:190-212` 两个 effect
3. 该 effect 内执行 `renderMaskLayer(...)` + `layer.toDataURL("image/png")`（**2× DPR 全画布同步 PNG 编码**）
4. `LiveCamera` 未加 `React.memo`，HomePage 每次 `snapTick` 自增都重渲染它
   → 连拍期间每次倒计时 tick 都会重跑一次多 MB 级 PNG 编码

**旁证**：这个坑项目里已被明确记录过，`MaskGallery.tsx:56-57` 注释写着
「放 def 进依赖会出问题 —— getMask() 每次调用都返回新对象」，
`MaskCard` 修正了，但 `LiveCamera` 又踩了同一个坑。

**修复**：给 `getImageMasks()` 加模块级 `Map` 缓存，或 `useMemo(() => getMask(maskKey), [maskKey])`。

### S1-2 `burnedIn = maskPreview`：默认永远不跑后端滤镜

`frontend/src/pages/DecoratePage.tsx:40-42`：

```tsx
// 是否需要后端补滤镜:取景已用 CSS 滤镜烧了一份,后端再跑一遍会二次调色。
// 因此仅当用户在本页换了滤镜,或相框被烧录时才需要重跑。
const burnedIn = maskPreview;
```

代码 `DecoratePage.tsx:84-86`：

```tsx
if (!burnedIn) {
  blobs = await Promise.all(blobs.map((b) => applyFilter(b, filter)));
}
```

两个独立缺陷：

**(a) 注释与代码自相矛盾。** 上一行注释明确说后端滤镜负责「grain/vignette —— CSS 滤镜表达不了噪点」，
但 `maskPreview` 默认为 `true`（`store.ts:59`）→ `burnedIn` 默认为真 → **后端滤镜永远被跳过**，
grain/vignette 在默认配置下**从未被应用**，与设计意图完全相反。

**(b) 用「实时预览开关」当「是否已烧录」的真相源，状态会漂移。**
`maskPreview` 是取景页一个**随时可改的 UI 开关**。用户在拍照后、进入本页前翻转它：

- 拍照时 `true`（已烧）→ 之后关掉 → `burnedIn=false` → **后端再跑一遍 OpenCV，同一张照片被调色两次**
- 拍照时 `false`（未烧）→ 之后打开 → `burnedIn=true` → **后端跳过，噪点/暗角丢失**

**修复**：`burnedIn` 必须在 `snap()` 时逐帧记录并随 `frames` 存入 store，
不能在 DecoratePage 读实时开关。数据结构要变成 `frames: {url, burnedIn}[]`。

### S1-3 AI 路径永不生成拼图 —— 按钮承诺的「AI 生成 + 拼图」不存在

`DecoratePage.tsx:89-94`：

```tsx
if (useAi) {
  const cap = await saveCaptures(blobs);
  setCurrentJobId(cap.job_id);
  await startGeneration(cap.job_id, style);
  return; // 等待 WS
}
```

WS 的 `done` 分支 `DecoratePage.tsx:54-57`：

```tsx
} else if (msg.status === "done") {
  setProgress({ current: msg.total, total: msg.total, msg: "完成" });
  setAiImages(msg.images ?? []);
  setBusy(false);          // ← 直接结束，从不调用 makeLayout
}
```

`makeLayout` 只在非 AI 分支 `DecoratePage.tsx:97` 被调用。
**AI 模式下 `layoutUrl` 永远是 `null`，最终拼图区域永不出现**，
而按钮文案却是「开始 AI 生成 + 拼图」（`DecoratePage.tsx:218`）。

**佐证**：`JobStatus.layout_url` 在 `types.ts:57` 和 `backend/schemas.py:66` 都有定义，
但 `backend/routes/generate.py` 的 `update()` **根本没写这个字段**，前端也从未读 `msg.layout_url`。
前后端一致地缺实现 —— 这是设计遗漏，不是笔误。

### S1-4 WebSocket 无 error/close 处理 → 生成中永久卡死

`frontend/src/api.ts:62-73` 只挂了 `onmessage`：

```ts
export function openJobSocket(job_id: string, onMessage: (msg: any) => void): WebSocket {
  const ws = new WebSocket(`${proto}://${location.host}/ws/jobs/${job_id}`);
  ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch {} };
  return ws;                       // ← 无 onerror / onclose / onopen
}
```

若 WS 在生成途中因网络/代理/后端重启断开：`busy` 永远为 `true`，生成按钮永久禁用，
UI 卡在「AI 生成中 0/0」；又因 `progress.total` 为 0，
`DecoratePage.tsx:228` 的 `progress.total > 0` 条件让进度条整个不显示，**用户得不到任何错误提示**。

同时存在**订阅竞态**：`DecoratePage.tsx:91-92` 先 `setCurrentJobId` 触发 effect 建连，
**之后**才 `await startGeneration`。若后端在 subscribe 之前就 broadcast 了 `done`，该消息永久丢失。

**修复**：用现成但零调用的 `fetchJob`（`api.ts:57-60`）做兜底轮询；
补 `onerror`/`onclose`；把 `startGeneration` 提到 `setCurrentJobId` 之前。

---

## 2. 后端性能问题

### S2-1 ★ `async def` 路由里直接跑 CPU 阻塞任务 → 阻塞整个事件循环

这是后端**最严重**的性能问题。FastAPI 的 `async def` 路由运行在事件循环里，
里面任何 CPU 密集操作都会**阻塞同一 worker 上所有其他请求**（含 WebSocket 进度推送）。

`backend/routes/preview.py:15-28`：

```python
@router.post("/api/preview/filter")
async def preview_filter(image: bytes = File(...), preset: str = Form("faded_90s")) -> Response:
    ...
    pil = Image.open(io.BytesIO(image)); pil.load()     # CPU
    out = apply_filter(pil, preset)                      # CPU: OpenCV 全图运算
    out.convert("RGB").save(buf, format="JPEG", quality=92)   # CPU: JPEG 编码
```

`backend/routes/layout.py:16-32` 同样问题：

```python
@router.post("/api/layout/make")
async def layout_make(images: list[bytes] = File(...), ...):
    pils = [Image.open(io.BytesIO(b)) for b in images]   # CPU
    data = collage_to_bytes(pils, ...)                    # CPU: 拼图 + 编码
```

**具体危害**：用户在连拍后点「生成拼图」，`/api/layout/make` 阻塞事件循环约 1-3 秒，
此时 **WebSocket 心跳（15s 间隔）与所有进度推送全部卡住**，
前端 `DecoratePage` 收不到任何消息，UI 表现为「点了没反应」。

**修复**：改 `def`（非 `async def`），FastAPI 会自动丢到线程池执行；或显式
`await run_in_threadpool(...)`。这是**单行改动，收益极高**。

### S2-2 滤镜内部每次调用重建常量数组 + 全分辨率 float32 拷贝

`backend/filters.py` 每个算子都对整图做 float32 转换和 `np.full_like` 分配：

- `_warmth` (39-46)：`bgr.astype(np.float32)` 整图拷贝 ×1，`cv2.split` 分配 3 个数组
- `_fade` (53-54)：`np.full_like(bgr, 255)` **每次都分配一张全白图**
- `_grain` (60-61)：`np.random.normal(0, sigma, bgr.shape)` 生成**全分辨率 float64 噪声**再转 float32
- `_vignette` (69-73)：`np.ogrid` + `np.sqrt` 全分辨率距离场，**每次调用重算**
- `_vhs` (91-92)：`for y in range(0, h, 2)` **Python 逐行循环**，且每行做一次 astype

`_grain` 的 `np.random.normal` 是最大头：float64 噪声矩阵 = `h × w × 3 × 8` 字节，
1280×960 就是 **~29 MB** 的临时分配，且用 Python 侧 RNG（`np.random`）而非 OpenCV 的 RNG。

**优化建议**：
1. 滤镜预设是**静态的**，把 `white` 掩码、vignette 距离场按 (h,w,preset) 做 LRU 缓存
2. `np.random.normal` → `cv2.randn`（走 OpenCV 内部状态，省去 float64 中间量）
3. `_vhs` 的逐行循环 → 向量化 `out[::2] *= 0.85`

### S2-3 `qwen_worker` 与 `qwen_pipeline` 重复硬编码模型路径，绕过 config

同一份模型路径在**两处**各自硬编码，且都没走 `config.py`：

- `backend/qwen_worker.py:66` — `MODEL_BASE = Path(r"E:\Code\stable-diffusion-webui\models")`
- `backend/pipeline.py:123` — `sd_xl_yaml = Path(r"E:\Code\...\configs\inference\sd_xl_base.yaml")`

换机器/换用户即失效。`backend/config.py` 已经存在并管理了 `QWEN_WORKER`、`SDXL_CKPT` 等，
这两个路径应统一收敛到 config（用环境变量 + 默认值）。

### S2-4 `qwen_worker` 未被父进程守护：崩溃后不会自动重启

`backend/qwen_worker.py:409-456` 的 `main()` 里，`load_pipeline()` 抛异常时：

```python
if op == "warmup" and _pipe is None:
    try:
        load_pipeline()
        ...
    except Exception as e:
        reply(req, {"ok": False, ...})     # 回错误，但进程继续活着
```

加载失败后 worker **不退出、也不重试**，`_pipe` 永远是 `None`。
此后每个 `gen` 请求都会走 `backend/qwen_worker.py:444-449` 再次尝试 `load_pipeline()`，
即**每个请求都重试一次 75 秒的加载**，且失败信息只返回给单个用户，进程始终处于半死状态。

`backend/qwen_pipeline.py` 的 `_spawn()` 只在 `self.proc.poll() is not None`（进程已退出）时才重启，
而这里进程**没退出**，所以 `_spawn()` 认定它健康，永远不会重启。

**修复**：`load_pipeline()` 连续失败 N 次后 `return 1` 退出，让父进程在下次 `_spawn()` 时拉起新进程。

### S2-5 SDXL 路线每次生成都重复做人脸检测

`backend/pipeline.py:555` → `_correct_skin_cast()` 内部（`pipeline.py:588-589`）：

```python
arr = np.asarray(img.convert("RGB"), dtype=np.float32)
faces = _get_app().get(arr.astype(np.uint8))
```

而 `generate_one()` 在 `pipeline.py:468` 已经调用过 `self.face_app.get(arr)` 做同一次检测。
`_correct_skin_cast` 对**每张生成图**又跑一次 InsightFace 全图检测（det_size 640×640），
纯属重复计算。Qwen 路线不走这段，不受影响。

**修复**：把 `generate_one` 里已得到的 `kps`（关键点）随结果一起传给肤色校正，省掉第二次检测。

### S2-6 `face.py` 的 InsightFace 单例无锁，并发下可能重复加载模型

`backend/face.py:14-28`：

```python
def _get_app():
    global _app
    if _app is None:          # ← 检查
        ...
        _app = FaceAnalysis(...)   # ← 赋值
        _app.prepare(...)
    return _app
```

经典的 check-then-act 竞态。`app.py:67` 的预热线程、`generate_async` 的
`asyncio.to_thread(_work)`（`pipeline.py:737`）会并发调用。
两个线程同时看到 `_app is None` → **同时加载一遍 640×640 的 InsightFace 模型**（显存 + 数秒），
后写的覆盖先写的，先前那个实例被 GC 掉，其 CUDA context 随之释放。

项目在 `jobs.py` 里已经用了 `threading.Lock` 保护字典，这里却漏了。
**修复**：用 `threading.Lock` 或 `functools.lru_cache` 包裹。

### S2-7 `_get_app()` 被高频调用，且每次都可能触发 GPU 上下文开销

`pipeline.py:189` / `pipeline.py:247` / `pipeline.py:586` / `face.py` 多处直接调 `_get_app()`。
虽然有单例，但 `FaceAnalysis.get()` 是**同步 GPU 推理**，在 `pipeline.py:737` 的工作线程里被调用。
配合 S2-5，每张图实际跑 **2 次** InsightFace（生成前 + 肤色校正），4 张图就是 8 次全图检测。

### S2-8 `capture.py` 与 `gallery.py` 用同步文件 IO 跑在 `async def` 里

`backend/routes/capture.py:12-23`：

```python
@router.post("/api/capture/save")
async def capture_save(images: list[UploadFile] = File(...)):
    ...
    for i, up in enumerate(images[: 8]):
        data = await up.read()          # 这行是 async，OK
        path.write_bytes(data)          # ← 同步阻塞写盘
```

`backend/routes/gallery.py:14-37`：

```python
@router.post("/api/gallery")   # 实际是 @router.get
async def gallery():
    for job_dir in sorted(OUTPUT_DIR.iterdir(), key=lambda p: p.stat().st_mtime, ...):
```

`gallery()` 遍历整个 outputs 目录、每个 job 再 `stat()` + `glob()`，全是同步磁盘 IO。
随着历史任务累积（每次拍摄一个目录），**这个接口会越来越慢，且期间阻塞整个事件循环**
（含 WS 进度推送）。前端 `GalleryPage` 一进页面就调它。

**修复**：`def gallery()`（非 async）让 FastAPI 自动走线程池；或 `OUTPUT_DIR` 列表结果做 LRU 缓存。

---

## 2b. 安全问题

### S2-9 ★ CORS 配置：`allow_origins` 含 `"*"` 且同时 `allow_credentials=True`

`backend/app.py:20-26`：

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

两个问题：

1. **`"*"` 与 `allow_credentials=True` 组合是无效且危险的**。按 CORS 规范，
   凭据模式下的通配符 `*` 会被浏览器拒绝，Starlette 的行为是**原样回显请求的 Origin**，
   等价于「允许任意来源带凭据访问」。本项目虽无登录态，但 `/outputs` 挂载了用户生成的照片，
   且 `host="0.0.0.0"`（`app.py:74`）意味着服务暴露在局域网 —— 任意网站可读用户照片。
2. `"*"` 让前两项列举毫无意义，实际等同于全放开。

**修复**：删掉 `"*"`，只保留明确的 dev origin；生产用环境变量注入白名单。

### S2-10 服务绑定 `0.0.0.0` 且无任何认证

`backend/app.py:74`：`uvicorn.run("backend.app:app", host="0.0.0.0", reload=False)`

`/api/gallery`、`/api/layout/make`、`/api/generate/start` 均无鉴权，
任何能访问该端口的人都能浏览全部历史照片、消耗 GPU 算力生成图片。
本地开发场景风险可控，但需明确「仅限可信局域网」。

### S2-11 `capture_save` 接受任意数量与任意大小的文件，无校验

`backend/routes/capture.py:18`：`for i, up in enumerate(images[: 8]):`

只截断了**数量**（最多 8），但**没有校验单文件大小与 MIME 类型**。
`await up.read()` 会把整个文件读进内存。恶意/误操作上传一个 2GB 文件即可打爆内存。

**修复**：加 `MAX_UPLOAD_BYTES` 校验（读流时截断）与 content-type 白名单。

---

## 2c. 值得肯定的部分

审查中发现这些地方**已经处理得很好**，修 bug 时不要破坏：

- `backend/ws.py:24` 有界队列 `maxsize=32` + 满了丢最旧 —— 注释里记录了
  「40 条空闲连接把 commit 从 17.5GB 顶到 26.4GB」的真实事故，边界清晰
- `backend/jobs.py:29-47` `_evict_locked` 有界淘汰 + TTL 保护期，且说明了为何是软上限
- `backend/qwen_pipeline.py:149-238` `_rpc` 用独立 reader 线程 + `queue.get(timeout=0.5)`
  实现真超时，注释详细论证了「`readline()` 阻塞会让超时形同虚设」
- `backend/pipeline.py:674-773` `generate_async` 正确用 `asyncio.to_thread(_work)` 把推理移出事件循环
- `backend/qwen_worker.py:56-61` stdout 裸 fd 与 `sys.stdout` 分离，避免第三方库污染 JSON 协议通道
- `backend/face.py:140-158` 裁切框的「最后一道保险」循环，宁可打破比例也不切脸 —— 附有实测教训

---

## 3b. 前端补充确认（已逐条回读源码）

### S3-8 `HomePage` 的 `/api/meta` 与 `DecoratePage` 重复请求

已确认 `HomePage.tsx:56-66` 与 `DecoratePage.tsx:44-46` 各写了一份 `fetchMeta()`，
`store.ts:14-17` 的注释声明要缓存以避免重复请求，但 `DecoratePage` 用的是自己的 `meta` state，
从未读 store 里的 `filterMeta`/`frameMeta`。缓存形同虚设，每次进 DecoratePage 多一次往返。

### S3-9 `CountdownOverlay` 的 `onComplete` 闭包过期风险靠隐式不变量

`CountdownOverlay.tsx:25-44` 把 `onComplete` 用 `eslint-disable` 排除在依赖外。
当前靠「每拍一张 `tick` 必自增 → effect 必重跑 → 必捕获最新 `doSnap`」侥幸正确。
同文件 `LiveCamera.tsx` 用 `snapRef` 解决同类问题的范式可直接照搬。

### S3-10 组件级 `memo`/`useCallback` 几乎完全缺失

`frontend/src` 下 `memo(` 零使用，`useCallback` 仅 1 处、`useMemo` 仅 3 处（全在 MaskGallery）。
`LiveCamera`、`MaskStrip`、`MaskCard` 均未 memo。
`LiveCamera` 尤其关键 —— 它是 S1-1 渲染热循环的**放大器**：
HomePage 每次 `snapTick` 自增都重渲染它，而它内部会重跑全画布 PNG 编码。

> 注意：`MaskCard` 的 effect 依赖 `[item.key, item.kind]` 与 `MaskThumb` 的 `[mask]`
> 经确认是**正确**的（内置蒙版是稳定引用），问题只在组件级未 memo，不要误改这两处依赖。

### S3-11 `store.reset()` 定义了但零调用

`store.ts:78-84` 定义了 `reset()`，全仓库无调用点。
`frames`（4 张 base64）、`aiImages`、`layoutUrl` 跨路由导航永久驻留。

---

## 3. 中等问题（资源泄漏 / 健壮性）

### S3-1 `createObjectURL` 从不 revoke

`DecoratePage.tsx:98`：`setLayoutUrl(URL.createObjectURL(result));`
全仓库 `revokeObjectURL` **零出现**。每点一次「生成拼图」泄漏一个数 MB Blob 的驻留内存。

### S3-2 HomePage 两个 `setTimeout` 未清理，其中一个会在卸载后强制路由跳转

`frontend/src/pages/HomePage.tsx:103-112`：

```tsx
setFlash(true);
setTimeout(() => setFlash(false), 250);      // ← 未保存、未清理
...
if (next.length >= PHOTO_COUNT) {
  setCapturing(false);
  setTimeout(() => nav("/decorate"), 400);    // ← 未保存、未清理
}
```

`doSnap` 是普通函数（非 effect 回调），无 cleanup 通道。
第 4 张拍完后的 400ms 窗口内，用户若点顶部「画廊」离开页面，
**定时器照常触发 `nav("/decorate")`，把用户从刚打开的页面强行拽走**。可复现，非理论风险。

### S3-3 `fetch(dataUrl)` 解析 base64，照片在网络上传输两遍

`DecoratePage.tsx:6-8`：

```tsx
function dataUrlToBlob(url: string): Promise<Blob> {
  return fetch(url).then((r) => r.blob());
}
```

`fetch()` 处理 data URL 需完整解析 base64，4 张 1280×960 JPEG 需全部驻留内存并逐个解码，
峰值内存 = base64 字符串 + 解码 Blob 双份。建议改 `atob` + `Uint8Array` 手写转换。

**重复传输**：当 `burnedIn === false` 时，`DecoratePage.tsx:78-97` 把同样 4 个 Blob 上传**两遍**
（先 4 次 `/api/preview/filter`，再整体传给 `/api/layout/make`）。应让后端合并算子。

### S3-4 空格拍照监听不判断焦点 → 在搜索框输入空格会触发连拍

`HomePage.tsx:70-80`：

```tsx
const onKey = (e: KeyboardEvent) => {
  if (e.code === "Space" && !capturing) { e.preventDefault(); startCapture(); }
};
window.addEventListener("keydown", onKey);
```

监听挂在 `window` 且**无任何焦点判断**。蒙版图库搜索框（`MaskGallery.tsx:179-184`）是 HomePage 子节点，
用户输入「珍珠 贴纸」按空格 → `preventDefault()` 吞掉空格（打不进去）**并启动 3 秒倒计时连拍**。
未排除 `INPUT`/`TEXTAREA`/`isContentEditable`。

### S3-5 错误态下 `<video>` 被卸载但 MediaStream 未停止 —— 摄像头指示灯常亮

`LiveCamera.tsx:367-386` 在 `state === "error"` 时提前 return，`<video>` 从 DOM 移除，
React 随即调用 ref 回调 `attach(null)`，而 `attach`（`LiveCamera.tsx` 内）逻辑是
`if (!el || !stream) return;` —— **`el` 为 null 时直接返回，不 stop track**。
停止 track 的唯一位置是 effect cleanup，只在 `[active, retryKey]` 变化或卸载时才跑。
结果：进入错误态后 effect 仍是 active 的，**摄像头持续占用设备、硬件指示灯常亮**。

### S3-6 `imageCache` 是无界 `Map`，永不淘汰解码后的 `HTMLImageElement`

`frontend/src/components/masks/maskLibrary.ts:155-172` 缓存的是**已解码的 `HTMLImageElement`**，
每张位图蒙版的解码位图常驻（宽×高×4 字节）。逐个浏览蒙版时缓存无上限增长、无 LRU、无 `clear()`，是稳定泄漏。

### S3-7 三个 API 无 `r.ok` 校验 + 两个页面无 `.catch` → 永久 loading

`api.ts:11-14`（`fetchHealth`）、`api.ts:57-60`（`fetchJob`）、`api.ts:75-78`（`fetchGallery`）
均直接 `return r.json()`，无 `r.ok` 检查 —— 与 `fetchMeta`（`api.ts:5-9`，有 `if (!r.ok) throw`）风格不一致。

调用侧全部无 catch：`GalleryPage.tsx:8-13` 失败则 `setLoading` 永不执行；
`SettingsPage.tsx:7-9` health 永远为 null，卡在「加载中...」。
后端 500 返回 HTML 错误页时 `.json()` 抛 `SyntaxError` → 未处理 Promise rejection + 界面永久停在加载态。

---

## 4. 低优先级（代码清理）

| 项 | 位置 | 问题 |
| --- | --- | --- |
| L-1 | `package.json:19-22` | `konva` + `react-konva` 是**死依赖**，全仓库零 import（渲染全用原生 Canvas 2D），白带 ~150 KB |
| L-2 | `DecoratePage.tsx:246` | `src.startsWith("/") ? src : src` 两分支相同，恒等于 `src`，疑似丢失逻辑 |
| L-3 | `DecoratePage.tsx:16-17` | `frame`/`setFrame` 零引用（被 `frameOverride` 取代未清理），`noUnusedLocals: false` 让它悄悄通过编译 |
| L-4 | `HomePage.tsx:96-100` | `SNAP_MAX_RETRY` 拿「已拍张数」当重试计数器，耗尽后静默停在「已拍 0/4」无提示 |
| L-5 | `CountdownOverlay.tsx:25-44` | `onComplete` 被 `eslint-disable` 排除在依赖外，靠「tick 必自增」隐式不变量侥幸正确，应用 `useRef` |
| L-6 | `store.ts:78-84` | `reset()` 全仓库零调用，`frames`/`aiImages`/`layoutUrl` 跨路由永久驻留 |
| L-7 | `GalleryPage.tsx:29-35` | 缩略图无 `loading="lazy"`、无虚拟化；后端未生成缩略图，直接给原图路径 |
| L-8 | `HomePage.tsx:51-67`、`DecoratePage.tsx:44-46` | 4 处异步 effect 无 `alive` 守卫 / `AbortController`（项目内 `LiveCamera.tsx:168` 已有正确范式） |
| L-9 | `LiveCamera.tsx:144` | `retriedRef` 自动重试**成功后不重置**，后续真实设备占用不再重试 |
| L-10 | 多处 | `key={i}` 索引作 key（`HomePage.tsx:216`、`DecoratePage.tsx:244`、`GalleryPage.tsx:31`） |
| L-11 | `store.ts:14-17` vs `HomePage.tsx:58`/`DecoratePage.tsx:45` | store 注释声明缓存 `/api/meta` 避免重复请求，实际两页各自 fetch，缓存形同虚设 |

---

## 5. 修复优先级路线图

### 第一批：单行/小改动，高收益（建议立即做）

| 顺序 | 项 | 位置 | 理由 |
| --- | --- | --- | --- |
| 1 | **S2-1** async 路由改 `def` | `routes/preview.py:16`、`routes/layout.py:16` | 解除全站事件循环阻塞，单行改动 |
| 2 | **S1-1** `getMask()` 引用不稳定 | `maskLibrary.ts:99-112` + `LiveCamera.tsx:158` | 唯一渲染热循环，加个 Map 缓存即可 |
| 3 | **S2-9** CORS 删掉 `"*"` | `app.py:20-26` | 安全，改一行 |
| 4 | **S3-1 / S3-2** revoke + 定时器清理 | `DecoratePage.tsx:98`、`HomePage.tsx:103,107` | 各 1-2 行，可复现故障 |
| 5 | **S3-5** 错误态停摄像头 | `LiveCamera.tsx` 的 `attach` | 摄像头指示灯常亮，用户可感知 |
| 6 | **S2-6** `_get_app()` 加锁 | `face.py:14` | 防并发重复加载模型 |
| 7 | **L-1** 删除 konva 死依赖 | `package.json:19-22` | 立即减包 ~150 KB |

### 第二批：需要设计改动

| 顺序 | 项 | 理由 |
| --- | --- | --- |
| 8 | **S1-4** WS 错误兜底 | 接入现成 `fetchJob` 做兜底轮询 |
| 9 | **S1-3** AI 路径补拼图 | 需前后端一起补 `layout_url` |
| 10 | **S1-2** `burnedIn` 语义 | store 结构改为 `frames: {url, burnedIn}[]` |
| 11 | **S2-2** 滤镜算子优化 | 掩码/距离场 LRU 缓存 + 向量化 |
| 12 | **S2-8** gallery 改 def + 缓存 | 历史任务累积后该接口会持续变慢 |
| 13 | **S2-5** 去掉重复人脸检测 | 复用 `generate_one` 已得到的 `kps` |
| 14 | **S3-3 / S3-6 / S3-7** | base64 转换、缓存上限、API `r.ok` 校验 |

### 第三批：健壮性与清理

- **S2-4** worker 加载失败不退出（半死进程，每个请求重试 75s）
- **S2-11** 上传大小/MIME 校验
- **S3-4** 空格键焦点判断（在搜索框按空格会触发连拍）
- **S3-8 ~ S3-11** 重复请求、闭包过期、memo 缺失、`reset()` 未调用
- **L-2 ~ L-11** 代码清理

---

## 5b. 问题分布小结（审查时）

| 类别 | 严重 | 高 | 中 | 低 |
| --- | --- | --- | --- | --- |
| 缺陷（功能/逻辑错误） | 4 | 3 | 8 | 11 |
| 性能 | 0 | 3 | 2 | 0 |
| 安全 | 0 | 2 | 1 | 0 |
| 资源泄漏 | 0 | 1 | 4 | 0 |

**一句话结论**：这个项目的**注释质量明显高于代码正确性** ——
`qwen_pipeline.py`、`ws.py`、`face.py`、`jobs.py` 里留下了大量对历史 bug 的准确记录，
甚至能看出踩坑的实测数据。但正因为注释里写清楚了「正确做法长什么样」，
`preview.py` / `layout.py` 里那两个 `async def` 里的 CPU 阻塞才更像是**漏改**而非有意为之
（对比 `pipeline.py:737` 正确用了 `asyncio.to_thread`）—— 这类不一致正是当前缺少 lint 与
端到端验证所导致的典型漏网。

---

## 6. 工具链（已在第三批落实）

原建议已全部实现：

- **Python**：`pyproject.toml` 启用 ruff，规则集 `select = ["F", "E9"]`
  （pyflakes + 语法错误），`extend-exclude = ["backend/vendor"]` 排除 vendored 代码。
  刻意不开 E501 与风格类规则，避免与既有代码风格冲突、淹没真问题。
- **前端**：`frontend/eslint.config.js`（eslint 9 flat config）+ typescript-eslint +
  eslint-plugin-react-hooks。其中 `react-hooks/exhaustive-deps` 提为 `error`，
  这是能自动拦住 S1-1 那类"不稳定依赖进 effect"的关键规则。
- **脚本**：`package.json` 新增 `"lint": "eslint src"` 与 `"typecheck": "tsc -b --force"`。
- `set-state-in-effect` 降为 `warn`：倒计时组件在新一轮开始时必须在 effect 里
  同步重置显示数字，属"由外部 tick 驱动"的固有模式，已在配置里注明理由。

### 接入后立刻发现的问题（证明工具链有效）

eslint 上线时报出 7 个 error，其中 **3 个是本次修复过程中新引入的**：

1. `retryCount` 声明为 state 但只用于判断 → 改 ref（顺带避免无谓重渲染）
2. `layoutUrlRef.current = layoutUrl` 写在渲染期 → 移入 effect
3. `Date.now()` 在渲染期求值（`react-hooks/purity`）→ 去掉自定义下载文件名，
   改用服务端 URL 自带的唯一名称

另外 4 个是历史遗留：`MaskGallery` 的 `useMemo` 多余依赖、`layoutFromAiImages`
缺失依赖（改 `useCallback` 稳定引用，同时避免 WS effect 反复重订阅）。

---

## 7. 修复记录（实际改动）

### 第一批（7 项）

| 项 | 文件 | 改动 |
| --- | --- | --- |
| S2-1 | `routes/preview.py` `routes/layout.py` `routes/gallery.py` | `async def` → `def`，CPU/磁盘 IO 移交线程池 |
| S2-9 | `app.py` | CORS 删掉 `"*"`，改由 `BIGHEAD_EXTRA_ORIGINS` 追加 |
| S2-6 | `face.py` | `_get_app()` 改双重检查锁 |
| S1-1 | `masks/maskLibrary.ts` | `getImageMasks()` 加引用缓存 + `EMPTY_MANIFEST` 常量 |
| S3-5 | `LiveCamera.tsx` | `attach(null)` 停轨道；重试成功重置 `retriedRef` |
| S3-1 | `DecoratePage.tsx` | 释放旧 objectURL + 卸载清理 |
| S3-2 | `HomePage.tsx` | 定时器 ref 统一清理 + 空格键焦点判断 |
| L-1 | `package.json` | 删除 konva / react-konva 死依赖（构建产物 214 KB） |

### 第二批（7 项）

| 项 | 文件 | 改动 |
| --- | --- | --- |
| S1-2 | `store.ts` `HomePage.tsx` `DecoratePage.tsx` | `frames` 改 `{url, burnedIn}[]`，逐帧 `some(f => !f.burnedIn)` |
| S1-4 | `api.ts` `DecoratePage.tsx` | WS 补 `onerror`/`onclose` + `fetchJob` 轮询兜底 + 修复订阅竞态 |
| S1-3 | `pipeline.py` `routes/generate.py` | 新增 `build_ai_layout()`，`layout_url` 随 WS done 广播并写入 job 状态 |
| S2-5 | `pipeline.py` | 肤色校正避免 float32↔uint8 往返 |
| S2-2 | `filters.py` | vignette 掩码 LRU 缓存、grain 改 `cv2.randn` 原地填充、`_vhs` 向量化、`_fade` 去临时图 |
| S3-6 | `masks/maskLibrary.ts` | `imageCache` 加 40 项 LRU 上限 |
| S3-7 | `api.ts` `GalleryPage.tsx` `SettingsPage.tsx` | 补 `r.ok` 校验、`.catch` 与错误态 UI |

### 第三批（9 项）

| 项 | 文件 | 改动 |
| --- | --- | --- |
| S2-4 | `qwen_worker.py` | 连续 3 次加载失败后 `exit(3)`，让父进程重启（不再半死） |
| S2-11 | `routes/capture.py` | 分块读 + 16MB 上限 + MIME 白名单 + Pillow 实际解码验证 |
| S3-10 | `LiveCamera.tsx` `HomePage.tsx` | 加 `memo`；`onCapture` 改稳定引用（否则 memo 失效） |
| L-2/L-3 | `DecoratePage.tsx` | 删恒等三元表达式与死订阅 |
| L-5 | `CountdownOverlay.tsx` | `onComplete` 改 ref，去掉 `eslint-disable` |
| L-6 | `store.ts` `HomePage.tsx` | `reset()` 接入 `startCapture` |
| L-7 | `GalleryPage.tsx` `DecoratePage.tsx` | 缩略图加 `loading="lazy"` |
| L-8 | `HomePage.tsx` | 异步 effect 加 `alive` 守卫 |
| L-11 | `DecoratePage.tsx` `store.ts` | 复用 store 已缓存的 meta，消除重复请求 |

### 验证方式

除编译与 lint 外，做了以下**行为级**验证：

- **滤镜等价性**：`_fade` 四个档位逐像素 `maxdiff=0`；`_vhs` 与原实现完全一致；
  7 个预设全部正常出图（bw 变灰、vhs 偏色、faded 提亮）
- **上传校验**：伪装成 `image/jpeg` 的文本被 400 拦下、17MB 超限返回 413、
  空文件/错误 MIME/超数量均正确拒绝
- **AI 拼图**：生成 1320×1800、重复调用幂等、缺文件时优雅降级为 `None` 而非崩溃
- **CORS**：恶意来源不再回显 `ACAO`，合法开发源正常放行
- **路由签名**：确认三个路由 `iscoroutinefunction == False`，即真的会走线程池
- **全链路冒烟**：meta → capture → filter → layout → build_ai_layout → jobs → health

### 过程中被验证推翻的两个错误假设

值得记录，因为它们说明「读代码」不够，必须实测：

1. `cv2.addWeighted(bgr, a, None, 0, b)` 不可用 —— OpenCV 4.9 的 `arithm_op`
   不接受 `None` 输入，直接抛 `Sizes of input arguments do not match`。
   改用零权重的 `bgr` 自身作第二输入。
2. `cv2.randn` 的签名是 `randn(dst, mean, stddev)`（**原地填充**），
   与 numpy 的 `(shape, mean, std)` 不同。按 numpy 习惯写会返回 `(3,1)` 数组。
   顺带发现 `np.random.Generator.standard_normal(out=)` 只接受 float64，
   所以省内存的正确解法是 `cv2.randn` 而非 numpy。

---

## 8. 仍可继续的项

以下未在本轮处理，均为低优先级或需产品决策：

- `S2-3` 硬编码模型路径（`E:\Code\...`）应收敛到 `config.py`
- `S2-10` 服务绑 `0.0.0.0` 且无鉴权 —— 需明确「仅限可信局域网」或加认证
- `L-10` 多处 `key={i}` 索引作 key（数据无增删时可接受，暂不改）

---

## 9. 端到端回归（Playwright）

三批修复后跑了仓库里全部 8 个 Playwright 脚本，**144 项断言全部通过，0 失败**。

| 脚本 | 断言数 | 结果 | 覆盖到的本次改动 |
| --- | --- | --- | --- |
| `verify-camera.mjs` | 7 | ✅ 全通过 | `LiveCamera` memo、`attach(null)` 停轨道 |
| `verify-mask-preview.mjs` | 14 | ✅ 全通过 | `getMask()` 引用缓存、**`burnedIn` 逐帧记录** |
| `verify-mask-output.mjs` | 37 | ✅ 全通过 | `snap()` 烧录链路（14 种蒙版镂空几何） |
| `verify-mask-tabs.mjs` | 21 | ✅ 全通过 | `frames` 结构改造后拍照链路 |
| `verify-mask-gallery.mjs` | 31 | ✅ 全通过 | `imageCache` LRU 上限未改变渲染结果 |
| `verify-gallery-capture.mjs` | 11 | ✅ 全通过 | 位图蒙版烧录 + `snap()` 出片非空 |
| `verify-masks.mjs` | 22 | ✅ 全通过 | 蒙版镂空几何(连通块计数) |
| `verify-burst.mjs` | 1 | ✅ PASS | 连拍 4/4 完成、按钮正确释放 |

---

## 10. 补充:贴纸自由编排(Task 3, 2026-10-05)

`feature/p0-vintage-parity` 分支新增贴纸用户编排能力:在「排版装饰」页
(`DecoratePage`) 的编辑模态里增加「涂鸦 / 贴纸」tab,贴纸 tab 由自研
`StickerEditor` 提供拖动/旋转/删除能力,与「涂鸦」同源安全区 (`doodleSafeArea`),
并在 `doLayout` 中位于涂鸦**下层**烧录。

### 改动清单

- 新增 `frontend/src/components/stickers/stickerTypes.ts` — 贴纸数据契约
  (`StickerPlacement`、`StickersByIndex`、可选形状白名单 `STICKER_SHAPE_KEYS`、
  7 色调色板 `STICKER_COLORS`)。坐标 0..1、尺寸相对短边、形状取自
  `masks/geometry.ts` 的 `STICKER_SHAPES`(不另写几何)。
- 新增 `frontend/src/components/stickers/StickerEditor.tsx` — 自研 canvas
  拖拽编辑器:
  - 复用 `paintStickers`(导出函数),与 `DecoratePage.burnStickers` 共用同一份
    渲染器,所见即所得是结构性保证而非约定。
  - **命中测试改为中心矩形** (`|dx|<=half && |dy|<=half`), 替换任务要求前
    的外接圆实现,与位移无关,星/心等形状的"点进贴纸内就抓到"稳定。
  - pointer 事件 + `setPointerCapture`, 拖动期间连续写 store。
  - Delete / Backspace 键删除选中贴纸,挂在 window 上;`isEditingText`
    拦截 INPUT/TEXTAREA/SELECT/contenteditable,避免"在输入框里按退格把
    贴纸删了"这类反向 bug。
- 改 `frontend/src/store.ts`:
  - 新增 `stickerOverrides: StickersByIndex` 与 `setStickerOverrides` /
    `clearStickerOverrides`(删 key 而非置空,与 `clearDoodle` 同源)。
  - `reset` 一并清空,确保新一轮连拍时上一轮贴纸不会"继承"到新照片。
- 改 `frontend/src/pages/DecoratePage.tsx`:
  - 编辑模态新增 tab 切换(`editTab: "doodle" | "sticker"`),两 tab 状态完全
    独立,切 tab 不清任何 store。
  - 侧栏新增贴纸计数卡片 + 「清空当前这张贴纸」按钮(进编辑后才显示)。
  - 缩略图新增「N 贴」角标(贴纸靠左、笔迹靠右,两角不互盖)。
  - `doLayout` 中**贴纸在下、涂鸦在上**的串行烧录顺序,与编辑模态的视觉
    一致(用户先摆贴纸,再在照片上画,笔迹是最后落在纸面上的)。两层按
    "marked 下标 + 单循环串行" 实现,层序隐式约定被消除:分两个循环会让
    层序静默翻转却无断言能发现。
  - `burnStickers` 与 `burnDoodles` 同构:独立透明 canvas + JPEG 重编码,
    try/finally 释放 `ImageBitmap`,避免一次抛错泄漏 4.7MB/张。
  - 安全区文案改 `safeText(safeArea, noun)` 可变 noun,贴纸 tab 显示
    「贴纸」、涂鸦 tab 显示「笔迹」,共用同一句事实陈述。

### 端到端回归

新增 `frontend/verify-sticker-edit.mjs`,60 项断言,全部通过:

| 脚本 | 断言数 | 结果 | 关键覆盖 |
| --- | --- | --- | --- |
| `verify-sticker-edit.mjs`(新) | 60 | ✅ 全通过 | tab 切换、3 色块烧录、中心矩形命中、Delete/Backspace、输入框内不拦截、安全区按排版切换、边缘裁切、reset 清空 |

回归原 10 个脚本全部仍然全过:

| 脚本 | 断言数 | 结果 |
| --- | --- | --- |
| `verify-camera.mjs` | 7 | ✅ 全通过 |
| `verify-mask-preview.mjs` | 14 | ✅ 全通过 |
| `verify-mask-output.mjs` | 37 | ✅ 全通过 |
| `verify-mask-tabs.mjs` | 21 | ✅ 全通过 |
| `verify-mask-gallery.mjs` | 31 | ✅ 全通过 |
| `verify-gallery-capture.mjs` | 11 | ✅ 全通过 |
| `verify-masks.mjs` | 22 | ✅ 全通过 |
| `verify-burst.mjs` | 1 | ✅ PASS |
| `verify-doodle-burn.mjs` | 58 | ✅ 全通过 |
| `verify-era-e2e.mjs` | 19 | ✅ 全通过 |

合计 281 项断言,0 失败;`tsc -b --force` 0 错误;`eslint src` 0 error
(仅 1 个与本次无关的 CountdownOverlay 预存 warning)。

### 过程中遇到并修复的两个问题

1. **place() 时序受 selected 影响**:`StickerEditor` 的色板按钮同时调
   `setColor` 与 `recolorSelected`。place 第一颗贴纸后默认选中,
   第二次 place 时颜色按钮会**改掉上一颗的颜色**而非设置下一颗要用的色。
   修复:place() 先切到 select 工具并点画布角落清掉 selected,再选色。
2. **关闭/重开模态后坐标过期**: 旧测试用脚本顶层缓存的 `boundingBox`
   与 `at()`,模态重开后 `place()` 落在画布外导致 hitTest 全部 -1。
   修复:place() 每次重新读 `boundingBox`。

### 回归中发现并修复的问题

**`frames` 结构改造破坏了 3 处验证脚本**。这正是脚本存在的价值 —— 如果没跑，
这些脚本会静默失效（`frames[0]` 变成对象后赋给 `img.src` 会得到无效图片，
`img.onerror` 触发后 `await` 永远挂起 → 脚本超时而非明确报错）：

- `verify-mask-preview.mjs:112` — `frames[0]` 直接当 dataURL 用
- `verify-mask-output.mjs:136` — 同上
- 已改成兼容写法：`typeof entry === "string" ? entry : entry.url`

### 回归中新增的断言

在 `verify-mask-preview.mjs` 里加了 `burnedIn 已随帧记录` 一项，直接验证本次核心修复：
开着「实时蒙版预览」拍照时 `burnedIn` 必须是 `true`。若为 `false`，说明 DecoratePage
会误判成"未烧录"从而让后端重复调色 —— 正是 S1-2 修的那个 bug。

### 两条意外收获

1. **`gum=2` 且无残留轨道**：`verify-camera.mjs` 显示 StrictMode 下 `getUserMedia`
   仍被调用 2 次（React 18 预期行为），但没有泄漏轨道 —— 印证 `attach(null)`
   停轨道的修复有效。
2. **同参数重渲染逐像素一致（差异 0/43200）**：`verify-mask-gallery.mjs` 的这项
   断言直接证明 `getImageMasks()` 引用缓存只优化了引用稳定性，**没有改变任何
   渲染结果** —— 这是加缓存最该担心的事。

### 运行方式

```powershell
# 后端（本轮用 8077，避开常被占用的 8000）
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8077

# 前端（代理目标用环境变量指定，不再硬编码）
$env:BIGHEAD_API_TARGET="http://127.0.0.1:8077"; npm run dev

# 逐个跑验证脚本
node verify-camera.mjs
```

> `vite.config.ts` 已改为读 `BIGHEAD_API_TARGET`（默认仍是 8000），
> 这样本机同时跑多个实例、或 8000 被别的项目占用时不必改代码。

### 沙箱提示

跑这些脚本时终端会报 `TRAE Sandbox Error: hit restricted`（Chrome 想写
`NVIDIA\DXCache` 与字体缓存被拦）。**这不影响测试结果** —— 每个脚本自身的
`PASS/FAIL` 计数与退出码都是正确的（均为 0）。

---

# Task 1：古早画质预设 `era`（2026-10-05，分支 feature/p0-vintage-parity）

## 1. 计划与现有代码的 5 处冲突（先读后改，全部已按现有代码修正）

计划文档 `docs/superpowers/plans/2026-10-05-p0-vintage-parity.md` 的 Task 1
是照着「backend 尚未接线」的假设写的，实读现有代码后发现 5 处对不上。
**没有照抄计划**，逐条修正如下：

| # | 计划说的 | 现有代码实际 | 处理 |
| --- | --- | --- | --- |
| 1 | `backend/tests/test_filters_era.py` + `pytest` | venv 里**没有 pytest**（`find_spec('pytest') is None`） | 按约定改用 `backend/scripts/verify_era.py`（裸 assert + 退出码） |
| 2 | `capture_save` 是同步 `def`，「不要改为 async」 | [capture.py](file:///f:/Trae-work/bighead/backend/routes/capture.py#L41) 已经是 `async def`，因为它 `await up.read()` 分块读 | **保持 `async def` 不动**。把 era 烧录放进已有的 `async` 循环里，`await` 不能丢 |
| 3 | `apply_filter` 签名改 `era: str = "modern"` | [filters.py](file:///f:/Trae-work/bighead/backend/filters.py#L117) `preset="none"` 时**直接 return 原图**，不做任何像素处理 | era 必须能在 `preset="none"` 下单独生效，故 `none` 分支也要走像素链路；同时给 `modern` 加恒等短路，避免白跑一次 RGB↔BGR 转换 |
| 4 | `preview.py` 里 `from ..config import ERA_KEYS` 局部 import「避免循环依赖」 | `preview.py` 顶部**已经** `from ..config import FILTERS`，config 不 import 任何 route，本来就没环 | 直接提到模块顶部，与既有 `FILTERS` 导入并列，不引入特殊写法 |
| 5 | `FILTERS` 每项加 `era: "modern"`、`FilterInfo` 加 `era: EraKey` | `era` 是**顶层独立维度**，不属于任何滤镜；计划自己的 Step 1.7 也写了「FilterInfo 不动」 | **后端不加** per-filter `era` 字段（否则是永远为 `modern` 的死字段）；改为 `Meta` 新增顶层 `era_presets` |

> 第 5 条是计划内部自相矛盾（文件总览表说要加 `FilterInfo.era`，
> Step 1.7 又说不动）。取后者 —— 与「era 叠加在滤镜之上」的架构描述一致。

## 2. `era` 的实现要点

- **恒等函数不是废话**：`modern` 保留成一个显式函数（而不是 `if era == ...` 分支），
  这样 `apply_filter` 的调用路径恒定，调用方无需知道有哪些 era 存在。
- **必须能叠加**：`era` 串在**所有**滤镜算子之后，语义是「成片再过一层年代处理」，
  这样 `preset` 与 `era` 互不干扰（`faded_90s + vintage_2000` ≠ 只跑其中一个）。
- **`preset="none"` 也要走 era**：用户在取景页关掉滤镜、只想要古早画质是合法组合。

## 3. 验证策略

venv 无 pytest，故 `backend/scripts/verify_era.py` 用裸 `assert` + `TestClient`，
覆盖三层：

1. **纯函数层**：`_era_modern_pixels` 严格恒等、`_era_vintage_2000_pixels` 通道可度量退化
2. **路由层**：`era` 非法值 400、`era` 生效、`preset` + `era` 叠加三者都不同
3. **契约层**：`/api/meta` 的 `era_presets` 与 `config.ERA_PRESETS` 一致（前后端不会各说一套）

**结果：46 项断言全通过，退出码 0。**

## 4. 写验证脚本时抓到的 3 个坑（都是脚本自己的错，不是实现的错）

值得记下来，因为它们都是「断言看起来对、实际是错的」这类隐性错误：

| 坑 | 现象 | 真因 | 修法 |
| --- | --- | --- | --- |
| 确定性断言 | 同参数跑两次像素不一致 | `faded_90s` 带 `grain: 8`，`_grain` 用 `cv2.randn` 填噪声，**本来就该每次不同** | 改用 `preset="none"` 隔离 era 再测确定性；随机性是滤镜的既定行为，不该拿来判 era |
| httpx 的 `files=` | 不传 era 时返回 422 而非 200 | 把 `preset` 放进了 `files=`，httpx 会当作「文件部分」发送，FastAPI 收不到同名 Form 字段 | `files` / `data` 分开传，与前端 `api.ts` 的 FormData 行为对齐 |
| 通道序 BGR vs RGB | 落盘图「顶部漏光没生效」 | 纯函数层直接用 numpy 判的是 **BGR**（R 在 index 2），而 PIL `convert("RGB")` 出来的是 **RGB**（R 在 index 0），两处混用 | 落盘断言改用 index 0，并在注释里写明两层次序不同 |

> 第 3 条尤其值得警惕：它给出的失败信息是「功能没生效」，
> 而真因是「断言读错了通道」。若当时直接去改实现，就会把对的代码改错。

## 5. 门禁结果

```
依赖预检  PY= E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe + OK
ruff check backend scripts                → All checks passed!
compileall -q backend scripts              → exit 0
verify_era.py                              → 46 passed, 0 failed (exit 0)
tsc -b --force                             → exit 0
eslint src                                 → 0 error, 1 warning（既有, CountdownOverlay）
```

> eslint 那条 warning 在 [CountdownOverlay.tsx](file:///f:/Trae-work/bighead/frontend/src/components/CountdownOverlay.tsx#L39)，
> 是本次改动之前就存在的，与 era 无关。

## 6. 未做 / 已知遗留

- **未跑 8 个 Playwright 端到端回归**。本次只改了 era 这条新链路，
  `renderMask.ts` 与连拍/蒙版链路零改动，故未启动前后端跑全量脚本。
  风险面：DecoratePage 的 `doLayout` 条件由 `needFilter` 扩成
  `needFilter || needEra` —— 当 `era=modern`（默认）时该条件退化为原表达式，
  行为与改动前逐字节一致，**不影响既有用例**。
- **`era` 不参与「取景框实时预览」**。取景页的 CSS `ctx.filter` 表达不了
  低分辨率/漏光/色阶断层，所以实时预览看不到 era 效果，只在成片里体现。
  这是刻意的：要在浏览器里复刻需引入 canvas 像素级后处理，与
  「预览=出片」契约的成本收益不划算。
- **`era` 不进 AI 提示词**。AI 写真走的是模型重绘，era 只作用于
  `/api/preview/filter` 与落盘，不影响 prompt 构造。

---

# Task 1 复审：修复 2078b49 的 6 处问题（2026-10-05，分支 feature/p0-vintage-parity）

复审对象是 `2078b49 feat: era preset (modern | vintage_2000)`。功能是对的，
但有 1 处死代码、2 处 docstring 事实错误、2 处实现与文档不符、1 处参数埋死。

## 1. `capture.py` 的 era 分支是死代码，且留着会双烧（严重）

`/api/capture/save` 接收 `era: str = Form(ERA_DEFAULT)` 并在落盘时烧 era。
但前端 [DecoratePage.tsx](file:///f:/Trae-work/bighead/frontend/src/pages/DecoratePage.tsx#L278)
调 `saveCaptures(finalBlobs)` **不传 era**，而 era 早在同函数上一段就被
`applyFilter(b, preset, era)` 烧进 `finalBlobs` 了。

于是这条分支的前端可达性恒为 0：`era` 恒等于 `ERA_DEFAULT`，
`if era != ERA_DEFAULT` 永不成立。它属于「看起来能跑、实际从没生效」的代码 ——
更糟的是它一旦被接通就是**双烧**：era 算子非幂等（下采样再糊一次、
漏光再抬一次、色阶再砍一次），成片会「糊上加糊」。

`api.ts` 的 `era: EraKey = "modern"` 形参是同一根因的另一半：形参存在但
唯一的调用点不传，读者会以为 era 是在这里烧的。两处一起删。

**顺带修正 docstring 的事实错误**：原注释写「era 在这里烧进落盘的像素，
之后再改年代只能重拍，所以必须在存的时候就定死」——因果说反了。
era 在**上传前**就烧好了，落盘时的字节就是最终字节。

## 2. 上采样用 `INTER_NEAREST` 与 docstring 的说法自相矛盾

原 docstring 写「下采到 ~480p 再用最近邻上采回原尺寸 …… 皮肤细节在此
过程中被自然平滑（这是"糊"得对的关键）」。

**这句里的「自然平滑」对 `INTER_NEAREST` 而言不成立**：最近邻把每个源像素
原样复制成硬边方块，产出的观感是马赛克/锯齿，与「CCD 低分辨率」方向相反。
真正做低通的是第一步的 `INTER_AREA`（面积平均本身就是低通滤波）。
所以这是一句**描述了不存在的行为**的注释 —— 读代码的人会以为平滑是
设计意图，从而不敢改插值。上采样改 `INTER_LINEAR`，docstring 补上
「为什么是线性、谁负责平滑」。

## 3. 顶部漏光的常数加法在带底留了一条硬边

原实现 `out[:h//4] += 30 / += 10` 是**常数**加法，带底那一行与带外
第一行相差约 30 个色阶 —— 在 1500x1000 的成片上是一条肉眼可见的横线。
改成 `np.linspace(1.0, 0.0, leak_h)` 沿高度线性衰减到 0（`endpoint=True`
保证带底恰好落在 0，与带外连续）。`leak_ratio` 相应从 0.25 提到 0.5，
让衰减尾巴拖到画面中线，同时顶部 1/4 的均值仍稳定超过 20 个色阶
（实测 dR=29.0，断言阈值 >20 有余量）。

## 4. era 参数埋在函数体里，无法调参

`short_edge=480` / `leak_r=30` / `leak_g=10` 原本是函数体内的字面量。
这些是纯美术手感参数，改一次要动代码。已外置到
`config.ERA_PRESETS[key]["params"]`（结构与 `FILTERS`/`FRAMES` 对齐），
算子签名统一为 `(bgr, params)`，由 `_apply_era` 注入。
连带 `health.py` 的 `/api/meta` 从 `name=v` 改为 `name=v["name"]`。

> 注意：改成嵌套 dict 后 `/api/meta` 若忘了改 `v` → `v["name"]`，
> 会把整个 python dict 塞进 `EraInfo.name` 并被 pydantic 拒掉。已加断言钉住。

## 5. `ERA_OPS` 与 `ERA_PRESETS` 两张表没有任何同步机制

两张表分居 `filters`（算子实现）与 `config`（参数/展示名），只加一边时
症状是「新 era 在 `/api/meta` 里露脸，选了却毫无效果」——因为 `_apply_era`
在任一表缺失时都静默返回原图。已补 `set(ERA_OPS) == set(ERA_PRESETS)`
断言，并额外断言「顺序一致」「每个 key 都能跑通 `apply_filter`」
「非默认 era 真的改变像素」（防止又一个「存在但没接线」的空壳）。

## 6. verify_era.py 自身修掉的 3 个假断言

改实现时暴露出旧断言里 3 处「看起来在测 A、实际测的是 B 或恒真」：

| 坑 | 现象 | 真因 | 修法 |
| --- | --- | --- | --- |
| posterize 色阶数 | 漏光改渐变后从 3 级涨到 21 级，断言挂了 | `len(uniq) <= 4` 隐含依赖「漏光是常数」（纯色图 + 常数带 = 3 级），渐变带每行一级 | 换一张 256 级渐变图、并关掉漏光，只量 posterize 自己的贡献（256→128） |
| 插值判据恒假 | 「与最近邻不同」失败 | 用 480x640 做样本，短边正好 = `short_edge` → `scale=1.0` **根本不缩放**，两种插值都退化成恒等 | 换 1000x1500（6寸相纸真实尺寸），顺带覆盖非 4:3 |
| 参照系漏了漏光 | 「与线性复刻版一致」失败 | 参照实现只复刻了 resize，而实际输出还叠了渐变漏光 | 比对时 `{**VINTAGE, "leak_r": 0, "leak_g": 0}` 关掉漏光，只比「重采样」这一段 |

> 第 2 条值得单独记：`short_edge` 恰好等于图短边时，缩放比例是 1.0，
> 整条重采样链路退化成 no-op —— 这类「参数与样本尺寸撞车」导致的恒真断言，
> 靠读代码看不出来，只有把两个插值版本都比一遍才会暴露。

## 7. 门禁结果

```
ruff check backend scripts                → All checks passed!
compileall -q backend scripts              → exit 0
verify_era.py                              → 64 passed, 0 failed (exit 0)
tsc -b --force                             → exit 0
eslint src                                 → 0 error, 1 warning（既有, CountdownOverlay）
```

> eslint 那条 warning 在 [CountdownOverlay.tsx](file:///f:/Trae-work/bighead/frontend/src/components/CountdownOverlay.tsx#L39)，
> 与本次改动无关。运行时末尾的 `TRAE Sandbox Error: hit restricted` 是
> npm 想写 `E:\nodejs\node_cache\_logs` 被拦，不影响 tsc/eslint 的判定。

## 8. 已知遗留

- **仍未跑 8 个 Playwright 端到端回归**。本次把 era 从落盘路径移到
  「上传前烧好」，`DecoratePage` 的 `finalBlobs` 计算逻辑未变
  （仍是 `needFilter || needEra`），但 `/api/capture/save` 的签名变了
  （少了 Form 字段）。该路由的字节级行为由 verify_era.py 的
  「原样落盘」断言覆盖，但连拍→落盘→AI 的完整链路仍建议手工点一次。
- **`leak_ratio` 0.5 / `leak_r` 40 这组值是按断言阈值反推的**，不是
  肉眼看图定的。真实观感建议出图后人工确认一次；调整只需改 config，
  不必再动 `filters.py`。

---

# Task 2：手写涂鸦层（2026-10-05，分支 feature/p0-vintage-parity）

实现 `88c2f52`，审查修复 `2189d84`。

## 1. 计划里的一个必然编译不过的 bug

计划给的 `DoodleCanvas` props 同时声明了两个 `width`：

```ts
interface Props {
  width: number;   // 笔刷宽
  width: number;   // 容器宽
}
```

实读时发现并改为 `brush` / `width` / `height`。计划是照「组件还没写」写的，
这类细节对不上是预期内的——**关键是实读而不是照抄**。

## 2. 核心设计：预览=出片靠共用一份渲染代码

`paintDoodleStrokes` 是全仓唯一的涂鸦渲染实现，编辑模态与烧录都调它。
它**从 `ctx.canvas` 直读尺寸，不接受外部传 w/h**——从签名上根除
「预览传 640、成片传 1280 忘了换算」整类 bug。

笔刷基准取「短边 960」（`DOODLE_BASE`）正好同时等于成片短边（1280×960）
与编辑 canvas 的 backing store 短边（640×2），所以同一个 `width: 14` 在
预览与成片上**逐像素相等**，不需要换算系数。取短边而非长边是鲁棒性的来源：
即使将来出片改竖构图，两者也会同时偏移、**仍然相等**。

## 3. 橡皮为什么不能直接画在照片上

`destination-out` 擦的是「目标画布上已有的一切」。直接作用于照片会把照片
擦成透明洞，导成 JPEG 就是一块白/黑——用户想擦掉一笔笔迹，结果在照片上
开了个洞。做法是先画**独立透明层**再整体合成，橡皮只能擦到同一层里的笔迹，
擦完露出来的是照片。这条已写成 e2e 断言：B 带擦完后必须仍是
`rgb(128,128,128)` 而非白洞/黑洞。

## 4. 审查发现的最严重问题：144 项全绿掩盖了一个真实 bug

后端 [_smart_crop](file:///f:/Trae-work/bighead/backend/layouts.py#L69-L107)
是 **cover 式裁切**。1280×960 塞进 0.75 比例的 cell，左右各裁掉 **21.7%**
——用户画在画面边缘的笔迹**会静默消失**，而提示文案写着「所有笔迹在点生成
拼图时烧进最终图」，这是**事实性错误**。

最值得警惕的是：测试脚本里有一行注释

```js
// x 收在 0.30~0.70, 落在 cover 裁切保留的 0.217~0.784 内 —— 画到边上会在这里被后端裁掉。
```

**测试刻意绕开了被裁区域，等于把缺陷藏进了测试盲区。** 如果只看
「39 项全过」，这个 bug 会一路带到用户手上。这是本轮最值得记住的一条：
**断言全绿不等于缺陷不存在，有时是缺陷被藏进了断言的选点里。**

### 修法不是换个常数

逐个排版实算后发现 `6inch_4p` 的 cell 是 705×415（比例 **1.6988**），比照片
还宽，`_smart_crop` 走的是**裁上下**分支（上 2.8% / 下 18.8%），横向一点
不裁。**原来的左右两条遮罩对这个排版指错了方向**：既遮了不会丢的左右，
又把本该保留的左右边缘标成「会丢」。

最终改成按所选排版镜像 `make_collage` 的整数算术动态算**四边**安全区
（`doodleSafeArea`），并新增一条「故意画到 `x=0.02`」的回归断言把缺陷钉死。
文案统一用「约」字——只在 `_face_focus` 落几何中心时准确，检到人脸时裁切
窗口会平移，而前端拿不到后端人脸框，不谎称精确边界。

## 5. 其余修复

| 项 | 问题 | 修法 |
| --- | --- | --- |
| H2 | `ImageBitmap.close()` 在异常路径永不执行，一次失败泄漏 4.7MB/张，连拍几轮足以让移动端标签页被系统杀掉 | `try/finally` |
| M1 | 每个 `pointermove` 全量重绘所有笔画 | 0.002 最小间距去重 + rAF 合帧 |
| M2 | `Promise.all` 造成 4 倍主线程峰值且 UI 无反馈 | 改串行 + 逐步 `setProgress` |
| M2b | 进度条渲染条件被 `aiEnabled` 挡住，普通「生成拼图」看不到反馈 | 放开为 `busy && progress.total > 0` |
| L2 | `TOOL_MAP` 声明成 `Record` 使 `?? 兜底` 成编译器死代码 | 改 `Partial<Record<>>` |
| L3 | 缩略图 `key={i}` 未随 `displayImages` 变化重置 | key 掺入 src |

### 顺带修掉一个必崩 bug

修 H1 过程中 `tsc` 暴露 `doodles` 是 `Record<number, DoodleStroke[]>`，
对稀疏字典 `.map` 会抛 `does not exist`。已改按 `blobs` 长度显式遍历，
同时修掉「给不存在的第 N 帧画了笔会让 `stamped` 超出 `blobs`、
`applyFilter` 拿到 `undefined`」的越界。

---

# Task 3：贴纸自由编排（2026-10-05，分支 feature/p0-vintage-parity）

实现 `59d88a6`，审查修复 `0fb713d`。

## 1. 复用而非重写

Task 2 已建好 `cellRatio` / `doodleSafeArea`，直接复用——贴纸的安全区与
涂鸦用**同一套几何**，不存在两套算法漂移的可能。形状则复用
`masks/geometry.ts` 的 `STICKER_SHAPES`。

层序：贴纸在下、涂鸦在上，`doLayout` 里单循环串行
（`if (hasSticker) burnStickers(); if (hasDoodle) burnDoodles();`），
第二层以第一层输出为输入。`paintStickers` 与 `paintDoodleStrokes` 同构——
尺寸都从 `ctx.canvas` 读，保证「预览=成片」是结构性保证而非人工对齐。

## 2. 审查发现的两个真问题

### H1：hitTest 不跟旋转

`paintSticker` 做了 `translate → rotate → scale`，心形旋转 30° 后视觉上真的
翘起；但 `hitTest` 用轴对齐包围盒，用户想从**翘出的尖角**把贴纸抓起来
调位置，点过去返回 -1。**最常见的用法恰恰是斜着贴**，这会立刻触发大量
「我已经点了怎么没反应」。

修法是把 `(dx,dy)` 绕贴纸中心**逆旋转** `s.rotation` 度再做轴对齐判定。
比外接圆更准，且 `rotation=0` 时逐字节退化为原行为。

### H2：拖动期间每帧写 store

`onPointerMove` 每个事件都 `onChange(next)` 写进 zustand 全局 store。
120 Hz 屏下连发 200ms = 24 次全量 React 调度 + 24 次 canvas 全画，
4 张图叠加时移动端发木。

值得注意的是，作者**自己**在 `dragRef` 处写了注释说「放 ref 不放 state」，
但 `onPointerMove` 一行就绕回 store——**设计意图与实现之间出现鸿沟**。
H1 + H2 是同一类失败模式：「知道该用 local store，但只做到一半」。

修法：拖动期间只写 `dragRef.current.localX/Y`，`repaint` 用本地 ref +
stickers 合成那一颗的当前帧，**pointerup 时才一次性 `onChange` 写回**。
新增断言验证拖动期间 `storeWrites === 0`、up 后 `=== 1`。

## 3. 其余修复

| 项 | 问题 | 修法 |
| --- | --- | --- |
| M1 | canvas 的 pointerdown/click 冒泡到外层触发 `setEditingIdx(null)` 关模态 | 两处 `stopPropagation` |
| M2 | `pointercancel` 后再 `releasePointerCapture` 抛 `InvalidStateError` | `try/catch` 静默吃掉 |
| M5 | 四边安全区遮罩被色板工具栏视觉遮挡 | 遮罩 `z-20` 抬到工具栏之上 |

---

# Task 4：全量门禁与收口（2026-10-05）

## 1. 依赖预检

```
PY= E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe
OK
```

## 2. 四道门禁

| 门禁 | 结果 |
| --- | --- |
| `ruff check backend scripts` | All checks passed! |
| `compileall -q backend scripts` | exit 0 |
| `tsc -b --force` | exit 0 |
| `eslint src` | 0 error, 1 warning |

唯一的 eslint warning 在 [CountdownOverlay.tsx:39](file:///f:/Trae-work/bighead/frontend/src/components/CountdownOverlay.tsx#L39)
（`react-hooks/set-state-in-effect`），**改动前既有问题**，本轮全程未触碰该文件。

## 3. 全部 11 个验证脚本：290 项断言 0 失败

| 脚本 | 断言 | 结果 |
| --- | --- | --- |
| `verify-camera.mjs` | 7 | 通过 |
| `verify-burst.mjs` | 1 | 通过 |
| `verify-mask-preview.mjs` | 14 | 通过 |
| `verify-mask-output.mjs` | 37 | 通过 |
| `verify-mask-tabs.mjs` | 21 | 通过 |
| `verify-mask-gallery.mjs` | 31 | 通过 |
| `verify-masks.mjs` | 22 | 通过 |
| `verify-gallery-capture.mjs` | 11 | 通过 |
| `verify-era-e2e.mjs`（新） | 19 | 通过 |
| `verify-doodle-burn.mjs`（新） | 58 | 通过 |
| `verify-sticker-edit.mjs`（新） | 69 | 通过 |
| **合计** | **290** | **0 失败** |

后端 `verify_era.py` 另有 **64 项断言 0 失败**。

> `verify-burst.mjs` 是散文式输出（`=> PASS 连拍完成`），只记 1 项；
> 其余脚本均为 `N passed, M failed` 格式。

## 4. 本轮提交

```
0fb713d  fix(sticker): 旋转命中、拖动期间不写 store、遮罩 z-顺序
59d88a6  feat(sticker): 贴纸自由编排，自研 canvas 拖拽，拼图前烧录
2189d84  fix(doodle): 标注 cover 裁切安全区、修复 ImageBitmap 泄漏与重绘性能
88c2f52  feat(doodle): 手写涂鸦层，拼图前烧录
0c59aee  test(era): 补 era 端到端验证, 覆盖漏光真实进成片与回退归零
41c93a0  fix(era): 移除落盘死代码、参数外置、修正上采样与漏光
2078b49  feat: era preset (modern | vintage_2000)
```

未改 `renderMask.ts`（预览=出片契约保持）、未改 `package.json`（零新依赖）、
未改后端路由契约以外的任何既有行为。

## 5. 已知遗留

- **`era` 不参与取景实时预览**。低分辨率/漏光是 OpenCV 像素操作，
  `ctx.filter` 表达不了（与 `grain`/`vignette` 同处境）。用户选古早画质后
  在成片前看不到效果——这是刻意取舍，也意味着它暂时不适合进 store。
  要进的话得给 era 配一套 CSS 近似的 `css` 字符串。
- **`era` 不进 AI 提示词**，AI 写真重绘后 era 完全不体现。
- **`LAYOUT_PAPER` 是前端镜像**。`/api/meta` 的 `LayoutInfo` 只带
  `cols/rows` 不带 `paper`，而 cell 最终宽高依赖 `paper`。改后端
  `config.LAYOUTS` 的 `paper` 时**必须同步**这里，否则安全区指错方向
  （`6inch_4p` 会退化成 2x2 的比例）。`verify-doodle-burn.mjs` 有一条断言
  拿后端排版清单核对覆盖率，漏同步会直接失败。
- **`leak_ratio` 0.5 / `leak_r` 40** 是按断言阈值反推的，不是肉眼看图定的。
  调整只需改 `config.py`，不必动 `filters.py`。
- **`aiImages` 与 `frames` 的下标同源无断言**。涂鸦/贴纸都按 frames 下标
  索引，若将来 AI 生成数量可配置（如「选 3 张生成」）会静默错位。
  目前不可配置，所以不急。
- **橡皮擦只支持逐笔擦除**，没有独立的撤销栈。`eraser` 作为一笔参与
  合成（数组顺序即时间线），已能擦掉中间一笔并保留前后两笔，但没有
  「撤销最后一笔」的 UI。
- **贴纸无旋转手柄**，只有 `↺↻` 按钮按固定步进旋转。
- **验证脚本未接入 `npm scripts`**，仍需 `node xxx.mjs` 手动调用
  （与项目既有的 8 个脚本一致）。

