# BigHead · 大头贴复古应用 —— 实施计划(v3)

## 1. Summary

参考 **Photobooth Project** 与 **Photobooth-App** 的成熟产品形态,在 `f:\Trae-work\bighead` 完整复刻一个本地大头贴应用:

**核心玩法(大头贴机本体)**
- 本机摄像头取流 + 实时预览
- 倒计时 3-2-1 自动连拍 4-6 张(默认 4 张)
- 实时复古滤镜叠加(OpenCV 调色 + 漏光 + 颗粒,毫秒级)
- 拍照后 N 宫格拼图,可换相框、加贴纸、加手写文字
- 一键导出 PNG / JPG,可走系统打印机(本地打印)
- 本地画廊(浏览器内浏览历次拍摄)

**AI 加分项(可选开关)**
- 选 "AI 复古写真" 后,后端用 SDXL + IP-Adapter FaceID 锁定人脸,把 4 张自拍换成 4 张复古写真风格再排版
- 显存峰值 ≤ 7GB(关闭 AI 时不占用显存,纯大头贴模式无 AI)

**架构(完整前后端分离)**
- 后端:**FastAPI**(已装)+ WebSocket/SSE 实时通信
- 前端:**React 18 + Vite + TypeScript + TailwindCSS + Konva**(画布)
- 与 webui 共享 `.venv`,共享模型目录

---

## 2. Current State Analysis

### 2.1 工作目录
`f:\Trae-work\bighead` 空目录,从零开始。

### 2.2 硬件
- RTX 5070 Ti(Blackwell sm_120),16GB 显存,空闲 ~12.4GB。
- 大头贴机本体(无 AI)对显卡几乎零依赖;启用 AI 写真时峰值 ≤ 7GB。

### 2.3 环境
**全局 conda 已损坏**(`huggingface-hub 1.2.3` 与 `transformers 4.52.1` 不兼容)。
**复用** `E:\Code\stable-diffusion-webui\.venv`(健康):
- `python 3.11.9` · `torch 2.8.0.dev+cu128`(含 sm_120)
- `fastapi 0.94.0` · `gradio 3.41.2`(备选)
- `diffusers 0.34.0` · `insightface 0.7.3` · `onnxruntime-gpu 1.22.0`
- `transformers 4.37.2` · `accelerate 0.21.0`

新装 `opencv-python`、`pillow`、`numpy`、`uvicorn[standard]`、`python-multipart`、`websockets`。

### 2.4 模型(全部已就绪,**0 下载**)
| 用途 | 路径 | 大小 |
|---|---|---|
| SDXL 底模(亚洲人像) | `checkpoints/人像-XL-asian aesthetics（亚洲美学XL）_v2.0.safetensors` | 6.46 GB |
| IP-Adapter FaceID SDXL | `ipadapter/ip-adapter-faceid-plusv2_sdxl.bin` | 1.39 GB |
| FaceID LoRA SDXL | `Lora/ip-adapter-faceid-plusv2_sdxl_lora.safetensors` | 0.35 GB |
| CLIP-ViT-H Vision | `clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors` | 2.35 GB |
| InsightFace buffalo_l | `insightface/buffalo_l/*.onnx` | ~0.32 GB |
| SDXL VAE | `VAE/sdxl_vae.safetensors_sdxl_vae.safetensors` | 0.31 GB |
| 胶片 VELVIA LoRA | `Lora/LEOSAM's FilmGirl 胶片风 LoRA--全新VELVIA版本_3.0.safetensors` | 0.14 GB |
| 备用 SD1.5 底模 | `Stable-diffusion/人像-realisticVisionV50_v50VAE.safetensors` | 3.97 GB |
| 备用 SD1.5 FaceID | `ipadapter/ip-adapter-faceid-plusv2_sd15.bin` | 0.15 GB |

### 2.5 网络与磁盘
- pip 阿里云镜像,HF hf-mirror。无外网也能跑大头贴机本体(纯滤镜)。
- E 盘 158GB · F 盘 1.6TB。

---

## 3. Proposed Changes

### 3.1 仓库结构

```
f:\Trae-work\bighead\
├── backend/
│   ├── app.py                      # FastAPI 入口 + 路由注册
│   ├── config.py                   # 路径、显存预算、风格/滤镜预设
│   ├── camera.py                   # 摄像头帧代理(可选,前端直连亦可)
│   ├── filters.py                  # 实时复古滤镜(色调/颗粒/漏光/划痕)
│   ├── layouts.py                  # 相框 + N 宫格 + 6寸相纸排版(PIL/OpenCV)
│   ├── pipeline.py                 # SDXL+FaceID 推理(懒加载)
│   ├── face.py                     # InsightFace 人脸检测
│   ├── gallery.py                  # 本地画廊(扫描 outputs/)
│   ├── printer.py                  # Windows 系统打印(可选,默认关闭)
│   ├── ws.py                       # WebSocket 进度推送
│   ├── schemas.py                  # Pydantic 模型
│   ├── outputs/                    # 生成图、拼图、导出图(.gitignore 忽略)
│   └── routes/
│       ├── health.py
│       ├── preview.py              # POST /api/preview/filter  实时滤镜预览
│       ├── capture.py              # POST /api/capture/save  保存原始连拍
│       ├── layout.py               # POST /api/layout/make   拼图排版
│       ├── generate.py             # POST /api/generate/start AI 写真(异步)
│       ├── jobs.py                 # GET  /api/jobs/{id}     查询进度
│       ├── export.py               # GET  /api/export/{id}   下载图
│       └── gallery.py              # GET  /api/gallery       列出历史
├── frontend/
│   ├── package.json                # react 18, vite 5, ts 5, tailwind 3, konva, react-konva, zustand, react-router 6
│   ├── vite.config.ts              # /api proxy → localhost:8000
│   ├── tailwind.config.ts
│   ├── postcss.config.cjs
│   ├── tsconfig.json
│   ├── index.html                  # 全屏 kiosk 样式,启动自动隐藏鼠标
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                 # Router + 全局键盘监听(空格=拍照,Esc=退出)
│       ├── store.ts                # zustand:frames, style, layout, jobs
│       ├── api.ts                  # fetch / ws 封装
│       ├── types.ts
│       ├── components/
│       │   ├── LiveCamera.tsx      # getUserMedia 实时预览 + 倒计时
│       │   ├── FilterStrip.tsx     # 底部滤镜条(港风/胶片/昭和/原片)
│       │   ├── CaptureSequence.tsx # 倒计时 3-2-1 + 白闪 + 快门音
│       │   ├── PhotoStrip.tsx      # 拍完后的 4 张缩略图条
│       │   ├── StickerCanvas.tsx   # Konva 排版画布(贴纸/文字/拖拽/缩放)
│       │   ├── FramePicker.tsx     # 相框选择
│       │   ├── LayoutPicker.tsx    # 2x2 / 2x3 / 6寸相纸
│       │   ├── Gallery.tsx         # 历史画廊网格
│       │   ├── AISwitch.tsx        # 开关:是否启用 AI 写真
│       │   ├── ProgressBar.tsx     # WebSocket 拉到的实时进度
│       │   └── KioskShell.tsx      # 全屏外壳 + 顶部状态栏(时间/磁盘/状态)
│       ├── pages/
│       │   ├── HomePage.tsx        # 默认拍照页(大头贴机主界面)
│       │   ├── DecoratePage.tsx    # 排版装饰页
│       │   ├── GalleryPage.tsx     # 历史画廊
│       │   └── SettingsPage.tsx    # 风格/参数/打印配置
│       ├── styles/
│       │   ├── globals.css         # Tailwind + 复古色板 + 像素感字体
│       │   └── retro.ts            # 设计 token
│       └── assets/
│           ├── sounds/             # 快门.wav / 倒计时.wav(开源)
│           └── frames/             # SVG 相框素材
├── scripts/
│   ├── run.sh / run.bat            # 双击启动后端 + 前端 dev
│   ├── smoke_test.py               # AI 推理烟测
│   └── kiosk.bat                   # 全屏 kiosk 启动(可选)
├── outputs/                        # 运行时产物,gitignore
├── README.md
└── .gitignore
```

### 3.2 后端关键文件

#### `backend/config.py`
- `MODEL_BASE = r"E:\Code\stable-diffusion-webui\models"`
- `OUTPUT_DIR = ./outputs`(运行时建)
- `VRAM_BUDGET_GB = 7`(`AI 写真`开启时使用)
- `STYLES = {...}`:港风 / 胶片 VELVIA / 昭和动漫 / 真大头贴机质感 / 原片,每个含 prompt 模板
- `FILTERS = {...}`:`faded_90s` / `warm_kodak` / `bw_classic` / `vhs` / `polaroid` / `vintage_korean` / `none`(原片)
- `FRAMES = {...}`:`plain_white` / `korean_pink` / `polaroid` / `checker` / `none`
- `LAYOUTS`:2x2 / 2x3 / 3x3 / 6inch_4p(6 寸相纸 4 张版)

#### `backend/filters.py` —— 实时滤镜(纯 OpenCV,毫秒级)
- `apply_filter(pil, preset) -> pil`:
  - 色调:HSV 调整 + 曲线(LUT)
  - 颗粒:`cv2.add(randn * sigma)`
  - 漏光:右上角径向暖色叠加
  - 划痕:随机 alpha 横向线
  - 暗角:径向遮罩
- 输入 PIL,返回 PIL,512×768 处理 < 30ms

#### `backend/layouts.py` —— 排版(纯 PIL/OpenCV)
- `make_collage(images, frame, n_cols)`:圆角白边 + 顶部"BIGHEAD 2026"戳印 + 随机小图标(心/星)
- `make_print_sheet(images, paper="6inch_4p")`:1500×1000 px 6 寸相纸排版 + 3mm 裁切参考线
- 字体用 `PIL.ImageFont.load_default()`(可选外部字体,找不到时降级)

#### `backend/face.py` —— 人脸提取
- 单例 `InsightFace.app.FaceAnalysis(name="buffalo_l", root=...)`,首次 `prepare(ctx_id=0)`
- `extract_face(pil) -> {"face_pil": PIL, "bbox": tuple, "no_face": bool}`

#### `backend/pipeline.py` —— SDXL+FaceID 推理
- `class BigHeadPipeline`:懒加载
- `_ensure_loaded()`:
  - `StableDiffusionXLPipeline.from_single_file(SDXL_CKPT, torch_dtype=torch.float16)`
  - 单独覆盖 VAE(`pipeline.vae = AutoencoderKL.from_single_file(VAE)`)
  - `load_ip_adapter(IPADAPTER_BIN)`
  - `load_lora_weights(VELVIA_LORA)`
  - `fuse_lora(lora_scale=0.7)`(关键,节省显存)
  - `enable_model_cpu_offload()`(关键,压峰值)
  - `enable_vae_tiling()` + `enable_attention_slicing(1)`
- `generate_async(job_id, frames, style_key, steps=25, faceid_scale=0.7)`:
  - 后台任务,逐张生成
  - 每张完成后通过 `ws.broadcast(job_id, progress)` 推送进度
  - 完成后结果存 `outputs/{job_id}/`,返回路径列表

#### `backend/ws.py` —— WebSocket
- `/ws/jobs/{job_id}`:客户端订阅该 job 的进度,服务端在生成过程中定期推送 `{progress: 0..1, current: int, total: int, status: "running"|"done"|"error"}`

#### `backend/app.py` —— FastAPI 入口
- 注册所有路由、挂载 `/outputs` 静态目录
- `CORSMiddleware` 允许 `localhost:5173`
- `uvicorn backend.app:app --host 0.0.0.0 --port 8000`

### 3.3 前端关键文件

#### `frontend/src/components/LiveCamera.tsx`
- `navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 960, facingMode: "user" } })`
- `<canvas>` 实时绘制视频帧
- 选中的实时滤镜通过 `requestAnimationFrame` 应用到 canvas(纯前端滤镜,或可选调 `/api/preview/filter` 后端滤镜)

#### `frontend/src/components/CaptureSequence.tsx`
- 用户点"拍照"或按空格 → 倒计时 3-2-1(屏幕大数字 + 音效)
- 每张自动 `canvas.toDataURL()` → 推入 `store.frames`
- 白闪 200ms + 快门音

#### `frontend/src/components/StickerCanvas.tsx`(Konva)
- 加载 4 张图作为背景层
- 上层可加:`Image`(贴纸 PNG)、`Text`(用户输入,可选字体)、`Rect`(纯色块)
- 支持拖拽、缩放、旋转、删除
- "完成" → `POST /api/layout/make` 把合成后的 PNG 返回并展示

#### `frontend/src/components/AISwitch.tsx`
- 大开关"启用 AI 复古写真"
- 关闭:流程是 `拍照 → 实时滤镜 → 拼图 → 导出`,完全本地,毫秒级
- 打开:流程多一步"AI 生成"(`拍照 → AI 生成 4 张写真 → 拼图 → 导出`),每张 5-10 秒
- 默认关闭,UI 显眼提示"将消耗 7GB 显存,加载约 30 秒"

#### `frontend/src/components/KioskShell.tsx`
- 全屏黑底 + 顶部状态栏(系统时间、剩余磁盘、当前模式)
- 底部状态栏(模式、快捷键提示:空格拍照、Esc 退出)
- 可选 F11 全屏自动进入

### 3.4 路由

| 路由 | 用途 |
|---|---|
| `GET  /` | (前后端分离)前端 dev server `http://localhost:5173` |
| `GET  /api/health` | 健康检查 |
| `POST /api/preview/filter` | 实时滤镜预览(前端选择滤镜时调用) |
| `POST /api/capture/save` | 保存原始连拍到 outputs,返回 job_id |
| `POST /api/layout/make` | 接收 N 张图 + layout/frame,返回拼图 PNG URL |
| `POST /api/generate/start` | 启动 AI 写真任务,返回 job_id |
| `GET  /api/jobs/{id}` | 查任务状态 |
| `WS   /ws/jobs/{id}` | 实时进度 |
| `GET  /api/export/{id}?format=` | 下载 |
| `GET  /api/gallery` | 历史列表(扫描 outputs/) |
| `GET  /api/settings` | 当前风格/滤镜/参数 |
| `POST /api/settings` | 改设置 |

### 3.5 一键启动

#### `scripts/run.bat`
```bat
@echo off
set VENV=E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe
%VENV% -m pip install --quiet fastapi 'uvicorn[standard]' python-multipart websockets opencv-python pillow numpy 2>nul
start "BigHead Backend" cmd /k "%VENV% -m uvicorn backend.app:app --host 0.0.0.0 --port 8000 --reload"
cd frontend
if not exist node_modules (call npm install)
start "BigHead Frontend" cmd /k "npm run dev"
echo Open http://localhost:5173
pause
```

### 3.6 验收脚本 `scripts/smoke_test.py`
- 加载模型 → 跑 `pipeline.generate()` 生成 1 张 → 落盘 PNG → 打印显存峰值
- 失败时给可读提示

---

## 4. Key Design Decisions

| 决策 | 选择 | 理由 |
|---|---|---|
| **产品定位** | **大头贴机主体 + AI 加分项** | 参考 Photobooth Project / Photobooth-App,大头贴是核心,AI 是开关式可选 |
| 前后端 | **FastAPI + React 18 + Vite + TS** | 用户选"完整",前后端分离最专业;UI 与模型解耦 |
| 模型底座 | **SDXL(AI 开关启用时)** | 用户明确选 SDXL;开关默认关闭,不拍照时不加载 |
| 实时滤镜 | **OpenCV 纯后端**(或前端 canvas) | 毫秒级,与 AI 无关,所有照片都过 |
| 排版 | **纯 PIL + Konva**(前端编辑,后端合成) | Konva 编辑体验好,后端合成给最终 PNG |
| WebSocket | 进度推送 | AI 生成时间长,WS 让 UI 不卡 |
| 启动 | 后端懒加载模型 | 不强制预加载,启动快 |
| 并发 | AI 单队列串行 | 8GB 显存安全 |
| 打印 | `python win32print`(可选模块,默认关闭) | 真正的大头贴体验,但 Windows only,可选 |
| 画廊 | 本地 `outputs/` 扫描 | 无数据库,YAGNI |
| 字体 | `PIL.ImageFont.load_default()` | YAGNI,可后续扩展 |

---

## 5. Verification Steps

### 5.1 环境
1. `E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe -c "import diffusers, insightface, onnxruntime, torch, fastapi, uvicorn; print(torch.cuda.get_device_capability())"` → `(12, 0)`。

### 5.2 后端烟测(大头贴机本体,无需 AI)
2. `uvicorn backend.app:app` 启动,日志无 ERROR。
3. `curl http://localhost:8000/api/health` → `{"ok": true}`。
4. `curl -F "image=@a.jpg" -F "preset=faded_90s" http://localhost:8000/api/preview/filter` → 返回 PNG。

### 5.3 后端烟测(AI 写真,可选)
5. `python scripts/smoke_test.py`:
   - 模型全部加载成功
   - 输出 1 张 832×1216 PNG
   - **显存峰值日志 ≤ 7GB**

### 5.4 前端
6. `cd frontend && npm install && npm run dev` 启动,`http://localhost:5173` 打开:
   - 授权摄像头 → 实时预览
   - **不开启 AI**:拍照 → 实时滤镜切换 → 拼图 → 导出 PNG,全程 < 5 秒
   - **开启 AI**:拍照 → 选风格 → AI 生成(看到进度) → 拼图 → 导出

### 5.5 端到端验收
7. 4 张自拍生成 4 张 AI 写真:至少 3 张人脸一致、风格明显
8. N 宫格拼图导出 PNG 在 Photoshop/画图里能正常打开
9. 画廊页能看到历次拍摄
10. `nvidia-smi` 监控:AI 关闭时显存占用 ≈ 系统空闲;AI 开启时 ≤ 7GB

### 5.6 稳定性
11. 连续生成 20 张 AI 写真,无显存泄漏,无崩溃
12. 摄像头被拒、无人脸、磁盘满等异常都给清晰提示,不崩

---

## 6. Out of Scope

- 多机分布式、视频大头贴、GIF/视频导出、boomerang
- 用户账号、云同步、社交分享
- 手机端适配(只做桌面浏览器)
- WLED 硬件灯光联动(Photobooth-App 有,本版不做)
- DSLR 单反远程控制(只做 webcam)
- 自定义 LoRA 训练、模型市场
- 多语言(中文 UI 即可)
- Docker 打包
- 树莓派部署

---

## 7. Risks & Mitigations

| 风险 | 缓解 |
|---|---|
| `.venv` 的 gradio/fastapi 版本偏旧 | fastapi 0.94 + uvicorn 最新能跑;pip install 时升级 uvicorn |
| `accelerate 0.21` 偏旧 | `pipeline.py` 用 try/except,失败回退到 `pipe.to('cuda')` |
| WebSocket 在某些代理下不稳 | 进度接口同时提供 `/api/jobs/{id}` 轮询作为兜底 |
| 浏览器拒绝摄像头 | Gradio/原生 `getUserMedia` 都会清晰报错;UI 给"重试"按钮 |
| 拍无人脸 | `extract_face` 返回 `no_face=True`,AI 生成降级为不传 FaceID |
| Windows 路径空格/中文 | 全部用 `os.path.join` + `np.fromfile` 解码图 |
| Konva 字体中文缺失 | 优先用默认 sans,缺字时降级到 placeholder |
| 长时间运行内存泄漏 | 每张生成后 `torch.cuda.empty_cache()`;gallery 列表分页 |
| 摄像头权限被企业策略禁 | 给"上传图片"备选入口(本版留 UI 入口,后端复用 `preview/filter` 与 `generate`) |

---

## 8. Assumptions

- 用户授权 ≤ 8GB 显存;**AI 开启时承诺 ≤ 7GB**,大头贴机本体(关闭 AI)几乎不占显存
- 摄像头在本机可用,麦克风不需要
- 浏览器为 Chromium 内核(Chrome / Edge),`getUserMedia` + Konva + WebSocket 都支持
- 用户接受首启 AI 时 30 秒模型加载
- 用户接受每张 AI 写真 5-10 秒
- 风格以"提示词 + LoRA + 滤镜叠加"组合,4 种风格手工写 prompt 模板(放 `config.py`)
- 拼图相框与字体不引外部资源,代码现绘;若视觉不满意再迭代
- 不引 xformers / flash-attn 等需编译包,用 PyTorch 内置 SDPA
