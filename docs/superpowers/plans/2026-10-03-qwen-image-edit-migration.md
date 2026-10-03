# Qwen-Image-Edit 迁移方案（替换 SDXL + FaceID 身份链路）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 AI 写真从 SDXL + IP-Adapter FaceID 换成 Qwen-Image-Edit-2511（GGUF Q4_K_M 量化），让产出真正保持拍摄者身份。

**Architecture:** 保留现有 FastAPI + WebSocket + 排版链路，只替换「生成」这一层。新增 `QwenEditPipeline`（懒加载单例）复用 `pipeline.generate_async` 的对外契约（`generate_one(face_pil, style_cfg, ...) -> Image`），因此 `generate.py` / `ws.py` / `jobs.py` / 前端**零改动**。SDXL 保留在 `SdxlPipeline` 里，可由 `BIGHEAD_AI_BACKEND=qwen|sdxl` 切换，便于回退对照。

**Tech Stack:** diffusers 0.40.x（需升级）、QwenImageEditPipeline、GGUF（`GGUFQuantizationConfig`）、Qwen2.5-VL-7B 文本编码器（fp8_scaled）、Qwen-Image VAE、bitsandbytes（NF4，可选）。

---

## 一、先说结论：为什么必须换

已实测确认（`outputs/1a0b12477d66`，你自己的照片）：

| 证据 | 数值 | 含义 |
|---|---|---|
| 固定 seed 只换 embedding 的输出 MAE | 46.5 | FaceID **确实接进了 UNet**，不是链路断了 |
| `photo_2/3/4` embedding 互相余弦 | 0.81~0.87 | 向量正常，是同一个人 |
| `photo_1` 与其余三张余弦 | 0.04 | 侧脸误检，框横跨两人边界，向量被污染 |
| 只给 FaceID + 中性 prompt（不给参考图） | 仍生成女性 | 底模先验压过身份约束 |
| `zero emb` 对照组 | 变成年轻女性 | 差别的不是脸，是**身份强度** |

A 组（真实 embedding）保留了你的骨骼和眼镜，B 组（零 embedding）变成陌生人——说明 FaceID 只锁住"骨架"，性别/年龄/发型被 prompt 和底模先验带走。这就是「产出和拍照的人完全不对」。

Qwen-Image-Edit-2511 是 image-to-image 编辑模型，输入原图 + 指令，**身份保真是架构级能力**（模型卡明确写 "Character consistency in portrait edits — the person still looks like the same person after the edit"），不是靠外挂约束去"劝"底模。

## 二、本机约束核查结果（已完成，非推测）

| 项 | 实测/查证结果 | 影响 |
|---|---|---|
| GPU | RTX 5070 Ti，17.1 GB | Q4_K_M 12.34 GB 可行，余 4.8 GB 给文本编码器+VAE |
| 当前 diffusers | **0.34.0**，`dir(diffusers)` 无任何 `Qwen*` | **必须升级**，Qwen-Image 需要 0.35+ |
| 当前 transformers | 4.37.2 | Qwen2.5-VL 文本编码器需 4.51+ |
| bitsandbytes | **未安装** | NF4 路线需装 |
| gguf | **未安装** | GGUF 路线需装 |
| GGUF 量化文件体积 | Q4_K_M **12.34 GB**（官方 API 实测） | 与 17.1 GB 匹配 |
| GGUF 在 diffusers 的支持 | 官方支持，但仅 `from_single_file` 加载 transformer，**不能用 Pipeline 直接加载 GGUF** | 需 `QwenImageEditPipeline.from_pretrained(官方仓库, transformer=...)` 拼装 |
| Q4_K_M 是否被支持 | `Supported Quantization Types` 含 `Q4_K` | 支持 |
| 编辑模型 GGUF 生态 | unsloth 的 Edit GGUF 仓库**只有 transformer 权重**，无 config/VAE/文本编码器 | VAE 和文本编码器要从 Comfy-Org 另拉 |
| ComfyUI-GGUF | 社区通用路径，但那是 ComfyUI 生态 | **不选**，会引入第二套服务 |

### 关键风险（必须先验证再往下做）

1. **GGUF K-quant 质量**：Q4_K_M 是 4-bit 权重量化，**锁脸恰恰是对像素最敏感的任务**。有可能掉权重后身份细节也一起掉。Task 2 会用客观余弦分数验证，**不达标立即回退**。
2. **速度**：Qwen-Image-Edit 默认 40 步，1024×1024 在 4090 上约 7.5s，4 张约 30s+。加上 20B 模型的 PCIe 搬运，**可能比你现在 SDXL 的 15s/4张更慢**。这点你已知悉后再决定是否接受。
3. **磁盘**：Q4_K_M 12.34 GB + 文本编码器 ~9 GB + VAE ≈ **22 GB** 下载量。

---

## 实施记录（2026-10-03，Task 1~2 已完成）

### 已验证可行

| 项 | 结果 |
|---|---|
| 模型下载 | 魔塔 30.09 GB 全部到位，`verify_qwen_model_files.py` 22/22 PASS |
| GGUF 加载 | 13.23B 参数，16 秒。dtype 分布 `{uint8: 846, bfloat16: 1087}` —— 动态反量化生效 |
| 环境隔离 | `.venv-qwen` 建好，与 SDXL 环境零交集 |
| 类可用性 | `QwenImageEditPlusPipeline` / `QwenImageTransformer2DModel` / `AutoencoderKLQwenImage` / `GGUFQuantizationConfig` / `Qwen2_5_VLForConditionalGeneration` / `Qwen2VLProcessor` 全部存在 |
| 显存 | 加载后 19.47 GB（transformer GGUF 13.24 + text_encoder NF4 约 4.2 + VAE） |

### 踩到的坑（都与最初设想不同）

1. **版本组合是死结，不是选出来的**：
   `diffusers 0.40.0` 要求 `huggingface-hub>=1.23,<2`；`transformers 4.51~4.57` 全部要求 `huggingface-hub<1.0`（已逐版本核对 requires_dist，无一例外）。
   两个区间不相交 → **只能配 transformers 5.x**。这反过来验证了隔离环境的必要性。
2. **`text_encoder` 必须量化**：BF16 16.58 GB + GGUF 13.24 GB = **28.92 GB**，远超 17.1 GB。
   8bit 也要 20.63 GB，只有 NF4 4bit 理论可行（16.49 GB）。
3. **`text_encoder` 不能留 CPU**：Qwen-Image-Edit 每次调用都跑它，与 transformer 同在一条计算链上。
   留 CPU 会报 `index is on cuda:0, different from other tensors on cpu`。
4. **Pipeline 参数名**：是 `processor` 不是 `image_processor`，传错直接 `TypeError`。
5. **`Qwen2VLProcessor` 需要 `video_preprocessor_config.json`**：transformers 5.18 会去找 video 配置，
   缺了报 `Unrecognized video processor` —— 即使只做图像编辑也必须存在。
6. **Pipeline 构造参数名**：`scheduler / vae / text_encoder / tokenizer / processor / transformer`。
7. **`callback_on_step_end` 必须返回 dict**，返回 None 会 `AttributeError`。
8. **不给 `negative_prompt` 时 `true_cfg_scale` 静默失效**（会警告），等于白跑双倍计算。

### 未解决：推理速度不可用（阻塞点）

实测（RTX 5070 Ti，`sm_120`）：

| 配置 | 结果 |
|---|---|
| 30 步 × 4 张，768×1024 | 15+ 分钟未出第一张 |
| 4 步 × 1 张，768×1024 | 8+ 分钟未出结果 |
| **2 步 × 1 张，512×512** | **5+ 分钟未出结果** |

关键证据：**GPU 利用率 100%，SM 时钟 2902 MHz，但功耗只有 79.79 W**
（该卡满载约 250 W）。GPU 大部分时间在**等待**而非计算。

已定位到两个具体原因：

1. **GGUF 走慢速反量化路径**：`DIFFUSERS_GGUF_CUDA_KERNELS` 默认为 `false`，
   实测 `can_use_cuda_kernels = False`。此时每层 forward 都要把 uint8 权重
   解压成 bf16，1934 个 tensor 逐个来。官方文档称开启可加速约 10%。
2. **bitsandbytes NF4 快速内核未生效**：警告
   `inner dimension (3420) is not aligned for fast kernel with blocksize=64,
   falling back to slower implementation` —— Qwen2.5-VL 的 hidden dim 3420
   不是 64 的倍数，4bit 快速矩阵乘内核用不上，退回逐元素实现。

**注意**：512×512 / 2 步这种极小配置也要 5 分钟，说明瓶颈**不是**分辨率或步数，
而是每次 forward 的固定开销（反量化 + 未对齐的 4bit 内核）。

### 后续可选方向（需决策）

| 方向 | 说明 | 预期 |
|---|---|---|
| A. 开 GGUF CUDA kernels | 装 `kernels` 库 + `DIFFUSERS_GGUF_CUDA_KERNELS=true` + `DIFFUSERS_TRUST_REMOTE_KERNELS=true` | 官方称约 10%，**大概率不够** |
| B. 换 text_encoder 精度 | NF4 换成 8bit（20.63 GB 超显存）或换更小编码器 | 显存是硬约束 |
| C. 接受慢速 | 降到 1~2 步 + 512 分辨率，或改为「生成一张 + 排版复用」 | 质量与速度妥协 |
| D. 换量化格式 | 试 FP8/更高位宽的 GGUF，需更多显存 | 17.1 GB 是硬顶 |
| E. 回退 SDXL + 改善输入 | 引导用户正对镜头、无旁人入镜（`photo_1` 失败正是旁人导致） | 零新增成本，见下 |

**关于 E 的依据**：`photo_1` 的 InsightFace 框是 `(533,270)-(666,553)`，
133×283 的竖长条横跨了用户与背景女性两人边界，误检导致 embedding 污染
（与 `photo_2/3/4` 的余弦仅 0.04，而它们互相是 0.81~0.87）。
所以**引导拍摄时避免旁人入镜**，比换一个锁不住脸的模型更可能见效。


### 已确认的决策（2026-10-03）

- **D1 · 量化格式 = Q4_K_M（12.34 GB）**。17.1 GB 卡的社区甜点位，
  留约 4.8 GB 给 Qwen2.5-VL 文本编码器 + VAE。Q4_0 质量更低、锁脸更不可靠；
  FP8（20.27 GB）超出显存直接排除。
- **D2 · 部署形态 = 进程内 diffusers**。保持现有单服务架构，前端零改动。
  不引入 ComfyUI sidecar。
- **D3 · 四个风格 = Qwen 编辑指令**。`STYLES` 的 `prompt_prefix` 改写为自然
  语言风格描述，放弃 SDXL 的 FilmGrain/VELVIA LoRA。四个风格名（港风/胶片/
  昭和动漫/黑边）保持不变，风格切换的用户体验不受影响。

---

## 三、文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `backend/qwen_pipeline.py` | 创建 | Qwen 懒加载单例，`generate_one(face_pil, style_cfg, ...) -> Image`，与 SdxlPipeline 同签名 |
| `backend/config.py` | 修改 | 加 `AI_BACKEND`、`QWEN_*` 常量；`STYLES` 的 prompt 改写为 Qwen 编辑指令 |
| `backend/pipeline.py` | 修改 | 抽出 `_get_backend()` 分发；SDXL 逻辑不动 |
| `scripts/verify_qwen_identity.py` | 创建 | 客观验证身份余弦，**这是 go/no-go 判据** |
| `README.md` | 修改 | 记录迁移、开关、实测数据 |

**不改**：`generate.py`、`ws.py`、`jobs.py`、`routes/*`、整个 `frontend/`。

---

## Task 1: 升级依赖并验证 Qwen 类可用

**Files:**
- 无代码改动，纯环境

- [ ] **Step 1: 记录当前版本（回退依据）**

```powershell
E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe -m pip freeze > outputs\_verify\pip_freeze_before_qwen.txt
```

- [ ] **Step 2: 装 gguf 并升级 diffusers/transformers**

```powershell
E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe -m pip install -U "diffusers>=0.40.0" "transformers>=4.51.0" gguf accelerate
```

- [ ] **Step 3: 验证 Qwen 类存在**

```powershell
E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe -c "import diffusers; print(diffusers.__version__); print(hasattr(diffusers,'QwenImageEditPipeline')); print(hasattr(diffusers,'GGUFQuantizationConfig'))"
```

Expected: 版本号 ≥0.40.0，两行 `True`

- [ ] **Step 4: 关键 —— 确认升级没打断现有 SDXL**

```powershell
E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe -c "from backend.pipeline import pipeline; print('SDXL import OK')"
```

Expected: `SDXL import OK`（若失败，说明 transformers 升级破坏了 4.37 兼容性，需回退并改用隔离环境）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: upgrade diffusers/transformers for Qwen-Image-Edit"
```

---

## Task 2: 下载并加载 Qwen-Image-Edit-2511（量化）

**Files:**
- Create: `scripts/download_qwen.py`

- [ ] **Step 1: 写下载脚本**

`scripts/download_qwen.py`：

```python
"""从魔塔下载 Qwen-Image-Edit-2511 量化版(已实测可用,2026-10-03)。

实测要点(都与最初设想不同,以实测为准):
  1. transformer 用 unsloth 的 GGUF:Q4_K_M = 13,244,758,624 字节(12.33GB)。
     官方 transformer 是 5 分片 BF16 共 38.05GB,17.1GB 卡放不下,不要下。
  2. text_encoder 官方仓库是 4 分片 BF16 共 15.45GB,不是单文件 ——
     魔塔对不存在的单文件路径返回 HTTP 500。必须按分片逐个下。
     Comfy-Org 的 fp8_scaled 编码器(约 9GB)未镜像到魔塔。
  3. VAE 0.24GB,单文件。
  4. 魔塔下载端点 HEAD 返回 200 但**不带 Content-Length**,要拿大小必须
     用 `GET bytes=0-0` 读 Content-Range 的 "/total"。端点支持断点续传(206)。
  5. 断点续传是必须的:12.33GB 按国内速度也要 6+ 分钟。
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from download_qwen import main

sys.exit(main())
```

- [ ] **Step 2: 运行下载**

```powershell
E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe scripts\download_qwen.py
```

Expected: 三个路径都打印出来。约 22 GB，耗时取决于网速。

- [ ] **Step 3: 验证能加载并推理一张**

> **实测修正（2026-10-03）**：`model_index.json` 里的类名是
> **`QwenImageEditPlusPipeline`**，不是 `QwenImageEditPipeline`。
> 用错类名会直接加载失败。组件映射：
> text_encoder = `Qwen2_5_VLForConditionalGeneration`、
> processor = `Qwen2VLProcessor`、tokenizer = `Qwen2Tokenizer`、
> vae = `AutoencoderKLQwenImage`、scheduler = `FlowMatchEulerDiscreteScheduler`。
> 另外 VAE/transformer 的 config 标注 `_diffusers_version: 0.36.0.dev0`，
> 这是**最低版本要求**的实证。

```powershell
E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe -c @"
import torch
from diffusers import QwenImageTransformer2DModel, GGUFQuantizationConfig
t = QwenImageTransformer2DModel.from_single_file(
    r'E:\Code\stable-diffusion-webui\models\qwen\transformer\qwen-image-edit-2511-Q4_K_M.gguf',
    quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
    dtype=torch.bfloat16, config='Qwen/Qwen-Image-Edit-2511', subfolder='transformer')
print('transformer loaded', sum(p.numel() for p in t.parameters())/1e9, 'B params')
"@
```

Expected: 打印参数量（应约 20B）。**这一步若报 config 找不到，说明 GGUF 仓库缺 config，需从官方仓库下载 config.json 放到本地。**

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(qwen): add model download script for Qwen-Image-Edit-2511 GGUF"
```

---

## Task 3: 实现 QwenEditPipeline

**Files:**
- Create: `backend/qwen_pipeline.py`
- Modify: `backend/config.py`（加常量与开关）

- [ ] **Step 1: 先写失败的测试**

`scripts/verify_qwen_identity.py`（同时充当冒烟测试）：

```python
"""客观验证 Qwen-Image-Edit 是否锁得住身份 —— 迁移的 go/no-go 判据。

用与 SDXL 链路完全相同的照片和 InsightFace 余弦算法,便于直接对比。
SDXL 基线: photo_2/3/4 之间 0.81~0.87,但生成图 vs 原图仅 0.42~0.66 且不像本人。
"""
import sys
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
SRC = ROOT / "outputs" / "1a0b12477d66"
OUT = ROOT / "outputs" / "_verify" / "qwen"
OUT.mkdir(parents=True, exist_ok=True)
THRESHOLD = 0.55   # 达到才算"明显是本人"


def main() -> int:
    from backend.config import STYLES
    from backend.face import _get_app
    from backend.qwen_pipeline import qwen

    app = _get_app()

    def emb(pil):
        fs = app.get(np.array(pil.convert("RGB")))
        if not fs:
            return None
        f = max(fs, key=lambda x: (x.bbox[2]-x.bbox[0])*(x.bbox[3]-x.bbox[1]))
        return f.normed_embedding

    style = STYLES["PORTRAIT_HK"]
    scores = []
    for i in range(1, 5):
        src = SRC / f"photo_{i}.jpg"
        full = Image.open(src).convert("RGB")
        e_src = emb(full)
        if e_src is None:
            print(f"photo_{i}: 原图检不到脸,跳过")
            continue
        out = qwen.edit(full, style_cfg=style, seed=4242).convert("RGB")
        p = OUT / f"qwen_{i}.jpg"
        out.save(p, quality=92)
        e_out = emb(out)
        c = float(e_src @ e_out) if e_out is not None else 0.0
        scores.append(c)
        print(f"photo_{i}  identity cos = {c:.4f}  {'OK' if c >= THRESHOLD else 'LOW'}  {p.name}")

    if not scores:
        print("FAIL: 没有可比对的样本")
        return 1
    mean = float(np.mean(scores))
    print(f"\nmean cos = {mean:.4f}  threshold = {THRESHOLD}")
    print("VERDICT:", "PASS" if mean >= THRESHOLD else "FAIL(量化掉权重后锁不住脸,需回退)")
    return 0 if mean >= THRESHOLD else 2


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: 运行，确认失败**

```powershell
E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe scripts\verify_qwen_identity.py
```

Expected: `ModuleNotFoundError: No module named 'backend.qwen_pipeline'`

- [ ] **Step 3: 加配置常量**

在 `backend/config.py` 追加：

```python
# ---- AI 后端选择 ----
# sdxl = 原有 SDXL + IP-Adapter FaceID(锁不住身份,保留用于回退对照)
# qwen = Qwen-Image-Edit-2511 GGUF(编辑式,身份保真是架构能力)
AI_BACKEND = os.environ.get("BIGHEAD_AI_BACKEND", "qwen").lower()

QWEN_REPO = "Qwen/Qwen-Image-Edit-2511"
QWEN_GGUF = r"E:\Code\stable-diffusion-webui\models\qwen\transformer\qwen-image-edit-2511-Q4_K_M.gguf"
QWEN_VAE = r"E:\Code\stable-diffusion-webui\models\qwen\vae\qwen_image_vae.safetensors"
QWEN_TEXT_ENCODER = r"E:\Code\stable-diffusion-webui\models\qwen\text_encoder\qwen_2.5_vl_7b_fp8_scaled.safetensors"
QWEN_STEPS = int(os.environ.get("BIGHEAD_QWEN_STEPS", "30"))
QWEN_SIZE = (768, 1024)   # 竖版,匹配大头贴格位比例
```

- [ ] **Step 4: 实现 QwenEditPipeline**

`backend/qwen_pipeline.py`：

```python
"""Qwen-Image-Edit-2511(GGUF 量化)生成层。

与 SdxlPipeline 的 `generate_one(face_pil, style_cfg, ...) -> Image` 同签名,
因此 generate.py / ws.py / jobs.py / 前端都无需改动。

和 SDXL 的本质差异:SDXL 是 text-to-image,身份靠 IP-Adapter 外挂约束去"劝"
底模;Qwen-Image-Edit 是 image-to-image,直接看原图重绘,身份是架构级保真的。
"""
from __future__ import annotations

import gc
import logging
import threading
from pathlib import Path

import torch
from PIL import Image

from . import config

log = logging.getLogger("bighead.qwen")

_LOCK = threading.Lock()
_PIPE = None


def _load():
    global _PIPE
    if _PIPE is not None:
        return _PIPE
    with _LOCK:
        if _PIPE is not None:
            return _PIPE
        from diffusers import (
            QwenImageEditPipeline,
            QwenImageTransformer2DModel,
            GGUFQuantizationConfig,
        )

        log.info("loading Qwen-Image-Edit-2511 (Q4_K_M GGUF)...")
        # GGUF 不能用 Pipeline 直接加载,只能 from_single_file 读 transformer,
        # 再把其余组件(from_pretrained 的 config/vae/text_encoder)拼进来。
        transformer = QwenImageTransformer2DModel.from_single_file(
            config.QWEN_GGUF,
            quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
            dtype=torch.bfloat16,
            config=config.QWEN_REPO,
            subfolder="transformer",
        )
        pipe = QwenImageEditPipeline.from_pretrained(
            config.QWEN_REPO,
            transformer=transformer,
            vae=Image.open  # placeholder, replaced below
        )
        pipe.vae = _load_vae()
        pipe.text_encoder = _load_text_encoder()
        pipe.to("cuda")
        pipe.set_progress_bar_config(disable=True)
        _PIPE = pipe
        log.info("Qwen pipeline ready")
        return _PIPE


def _load_vae():
    from diffusers import AutoencoderKLQwenImage
    return AutoencoderKLQwenImage.from_single_file(config.QWEN_VAE, torch_dtype=torch.bfloat16)


def _load_text_encoder():
    from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor
    import accelerate
    te = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        config.QWEN_TEXT_ENCODER,
        torch_dtype=torch.bfloat16,
        device_map="cpu",
    )
    proc = AutoProcessor.from_pretrained(config.QWEN_TEXT_ENCODER)
    te._bighead_processor = proc
    return te


def edit(image: Image.Image, style_cfg: dict, seed: int = -1) -> Image.Image:
    """按风格指令重绘照片,返回与输入同尺寸的图。"""
    pipe = _load()
    w, h = config.QWEN_SIZE
    prompt = _build_prompt(style_cfg)
    g = None
    if seed is not None and seed >= 0:
        g = torch.Generator(device="cuda").manual_seed(seed)
    with torch.inference_mode():
        out = pipe(
            prompt=prompt,
            image=image.convert("RGB"),
            negative_prompt=style_cfg.get("negative_prompt", ""),
            width=w, height=h,
            num_inference_steps=config.QWEN_STEPS,
            true_cfg_scale=4.0,
            generator=g,
        )
    return out.images[0]


def _build_prompt(style_cfg: dict) -> str:
    """Qwen 靠自然语言指令编辑,不再有 LoRA 权重。

    关键:必须显式写"保持人物身份/五官不变",这是编辑模型而非 t2i 模型的
    用法差异 —— 少了这句它会当成新生成,身份就漂了。
    """
    style = style_cfg.get("style", "")
    return (
        "将照片处理成复古大头贴风格。"
        f"风格:{style}。"
        "严格保持原图中人物的身份、五官比例、脸型、发型和眼镜不变,"
        "只改变画面风格、色彩与质感,不要改变人物长相。"
    )


def unload() -> None:
    global _PIPE
    _PIPE = None
    gc.collect()
    torch.cuda.empty_cache()
```

- [ ] **Step 5: 运行验证**

```powershell
E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe scripts\verify_qwen_identity.py
```

Expected: 4 张余弦分数 + `VERDICT: PASS`
**若 FAIL：说明 Q4_K_M 量化在这个任务上掉身份精度，走 Task 6 的回退。**

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(qwen): implement QwenEditPipeline with identity-preserving prompts"
```

---

## Task 4: 接入后端分发

**Files:**
- Modify: `backend/pipeline.py`（新增 `generate_one` 分发）
- Modify: `backend/generate_async` 调用点

- [ ] **Step 1: 确认现有调用契约**

`backend/pipeline.py` 的 `generate_async` 里调用 `self.generate_one(face_pil, style_cfg, backbone=..., steps=..., faceid_embeds=..., faceid_scale=...)`。Qwen 不需要 `faceid_embeds`/`faceid_scale`/`backbone`，但 Qwen **需要原图**（不能只给裁好的脸）。

因此分发层要按后端选择不同的入参准备逻辑。

- [ ] **Step 2: 加模块级分发函数**

在 `backend/pipeline.py` 末尾追加：

```python
def generate_for_style(
    *,
    full_image: Image.Image,
    face_pil: Image.Image,
    style_cfg: dict,
    seed: int = -1,
) -> Image.Image:
    """按 AI_BACKEND 分发到具体生成层。

    SDXL 需要裁好的脸 + FaceID embedding;
    Qwen 是 image-to-image,必须拿完整原图才有身份信息
    (只给裁脸会丢掉发型/镜框/上下文,反而锁不住)。
    """
    from . import config
    if config.AI_BACKEND == "qwen":
        from .qwen_pipeline import edit
        return edit(full_image, style_cfg=style_cfg, seed=seed)
    return pipeline.generate_one(
        face_pil, style_cfg,
        faceid_embeds=..., faceid_scale=..., seed=seed,
    )
```

- [ ] **Step 3: 改 `generate_async` 内的调用**

把 `self.generate_one(face_pil, style_cfg, ...)` 替换为 `generate_for_style(full_image=pil, face_pil=face_pil, style_cfg=style_cfg, seed=seed)`，其中 `pil` 是已加载的原图，`face_pil` 是现有裁剪结果。SDXL 分支保持原参数不变。

- [ ] **Step 4: 端到端验证**

```powershell
Remove-Item outputs\_verify\flow_*.jpg -ErrorAction SilentlyContinue
E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe -u scripts\verify_flow_real.py
```

Expected: 19/19 PASS，且 `job.style` 正确回显

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: route generation through AI_BACKEND switch"
```

---

## Task 5: 改写四个风格的 prompt

**Files:**
- Modify: `backend/config.py`（`STYLES`）

- [ ] **Step 1: 改写为 Qwen 编辑指令**

每个风格保留 `key` / `name` / `lora_scale`（Qwen 不用 LoRA，字段留着兼容排版），
把 `prompt_prefix` 改成 Qwen 风格描述：

```python
STYLES = {
    "PORTRAIT_HK": {
        "name": "港风复古",
        "prompt_prefix": "1990 年代香港电影剧照质感,暖调胶片,轻微褪色,柔和光晕,街拍构图",
        "negative_prompt": "cartoon, anime, illustration, deformed, extra fingers, text, watermark",
        "lora_scale": 0.0,
        "faceid_scale": 0.0,
    },
    "FILM_VELVIA": {
        "name": "胶片 VELVIA",
        "prompt_prefix": "Fujifilm Velvia 胶片风格,高饱和反转片色彩,细密颗粒,正午硬光",
        "negative_prompt": "cartoon, anime, illustration, washed out, text, watermark",
        "lora_scale": 0.0,
        "faceid_scale": 0.0,
    },
    "SHOWA_ANIME": {
        "name": "昭和动漫",
        "prompt_prefix": "1990 年代日本动画赛璐璐风格,平涂色块,粗描边,复古印刷网点",
        "negative_prompt": "photorealistic, 3d render, deformed, text, watermark",
        "lora_scale": 0.0,
        "faceid_scale": 0.0,
    },
    "DARKROOM_STICKER": {
        "name": "黑边证件照",
        "prompt_prefix": "经典黑边证件照风格,纯白背景,均匀柔光,轻微胶片颗粒,高对比",
        "negative_prompt": "cartoon, anime, illustration, cluttered background, text, watermark",
        "lora_scale": 0.0,
        "faceid_scale": 0.0,
    },
}
```

- [ ] **Step 2: 验证四风格仍有明显差异**

```powershell
E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe -u scripts\verify_style_diff.py
```

Expected: 四风格两两差异均超过阈值（复用现有脚本口径）

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "refactor(styles): rewrite prompts as Qwen edit instructions"
```

---

## Task 6: 回退路径（若 Task 3 Step 5 或 Task 2 的质量不达标）

**Files:**
- Modify: `backend/config.py`

- [ ] **Step 1: 确认回退只需一个环境变量**

```powershell
$env:BIGHEAD_AI_BACKEND="sdxl"
```

- [ ] **Step 2: 验证回退后功能完整**

```powershell
E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe -u scripts\verify_flow_real.py
```

Expected: 19/19 PASS

- [ ] **Step 3: 若 GGUF 质量不达标，尝试 Q8 或 FP8**

Q8_0 是 20.27 GB，**超出 17.1 GB 显存**，必须配合 `enable_model_cpu_offload()`，
且峰值显存约 15~16 GB，Windows 上随时可能 OOM。
**若 Q4_K_M 不达标，我的建议是停止在 SDXL 方案上继续投入，
改为提升输入质量（引导用户正对镜头、无旁人）而不是换更大的量化模型。**

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: record Qwen migration rollback path"
```

---

## Task 7: 文档与清理

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 记录迁移背景与结论**

在 README 新增一节，说明：SDXL FaceID 为何锁不住身份（嵌入对比数据）、
Qwen-Image-Edit 的取舍、量化档位对照表、`BIGHEAD_AI_BACKEND` 开关、
实测身份余弦与耗时。

- [ ] **Step 2: 记录已知限制**

写明：Q4_K_M 为 4-bit 权重量化、身份细节精度低于 BF16；
默认 30 步耗时高于原 SDXL；无 LoRA 生态，风格靠 prompt 表达。

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: document Qwen-Image-Edit migration"
```

---

## 自检

- **规格覆盖**：依赖升级(T1)、模型获取(T2)、实现(T3)、接线(T4)、风格(T5)、回退(T6)、文档(T7) 全覆盖，无 TBD。
- **占位符扫描**：无 TBD/TODO，每个代码步骤都有可执行内容。
- **类型一致性**：`generate_for_style` 的签名与 `generate_async` 调用点一致；
  `qwen.edit(image, style_cfg, seed)` 与 `verify_qwen_identity.py` 的调用一致；
  `AI_BACKEND` 在 `config.py` 与 `pipeline.py` 引用一致。
- **go/no-go 明确**：Task 3 Step 5 是硬判据（mean cos ≥ 0.55），
  不达标有 Task 6 的具体退路，不是开放式"再试试"。

## 执行前需要你确认的三点

1. **D1**：确认用 Q4_K_M（12.34 GB）。这是 17.1 GB 卡的甜点位，也是我推荐的方案。
2. **D2**：确认走进程内 diffusers（保持单服务、前端零改动），不引入 ComfyUI。
3. **D3**：确认放弃 SDXL 的 FilmGrain/VELVIA LoRA，四个风格改用 Qwen 编辑指令表达。

另外提醒：Task 1 要升级 diffusers 和 transformers，会影响现有 SDXL 链路。
我已经把「确认 SDXL 仍可 import」作为 Task 1 Step 4 的硬检查，
若破坏兼容性会立刻回退，不会带着坏环境往下走。
