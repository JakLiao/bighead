"""Qwen-Image-Edit-2511 端到端推理验证 + 身份余弦打分(迁移的 go/no-go 判据)。

这是决定方案能不能用的关键一刀。判据:身份余弦均值 >= 0.55。
背景 —— SDXL + FaceID 的实测基线(同一批照片):
  photo_2/3/4 互相余弦 0.81~0.87(是同一人)
  但生成图 vs 原图仅 0.42~0.66,且肉眼明显不像本人
  零 embedding 对照组直接变成陌生女性
Qwen 是 image-to-image,身份保真应当是架构级的,所以阈值定 0.55。

显存:GGUF 权重 12.33GB 压缩态 + 文本编码器 15.45GB BF16。
17.1GB 卡放不下全部,所以 text_encoder 用 device_map="cpu" 留在内存,
只在编码时短暂上 GPU —— 这是 FlowBench 表格里「高级 Offload 仅 1.7GB」的思路。

用法: python scripts/_verify_qwen_infer.py [照片目录]
"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
D = Path(r"E:\Code\stable-diffusion-webui\models\qwen")
OUT = ROOT / "outputs" / "_verify" / "qwen"
OUT.mkdir(parents=True, exist_ok=True)
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "outputs" / "1a0b12477d66"
SEED = 4242
THRESHOLD = 0.55
LOCAL = D.as_posix()   # 关键:告诉 diffusers 全部从本地读,不去连 HF

PROMPT = (
    "将照片处理成复古大头贴风格:1990 年代香港电影剧照质感,暖调胶片,轻微褪色,柔和光晕。"
    "严格保持原图中人物的身份、五官比例、脸型、发型和眼镜不变,"
    "只改变画面风格、色彩与质感,不要改变人物长相。"
)
NEG = "cartoon, anime, illustration, deformed, extra fingers, text, watermark"


def build_pipe():
    from diffusers import (
        AutoencoderKLQwenImage,
        FlowMatchEulerDiscreteScheduler,
        GGUFQuantizationConfig,
        QwenImageEditPlusPipeline,
        QwenImageTransformer2DModel,
    )
    from transformers import Qwen2VLProcessor, Qwen2_5_VLForConditionalGeneration

    print("加载 transformer(GGUF 12.33GB)...")
    t0 = time.time()
    transformer = QwenImageTransformer2DModel.from_single_file(
        str(D / "transformer" / "qwen-image-edit-2511-Q4_K_M.gguf"),
        quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
        dtype=torch.bfloat16,
        config=str(D / "transformer"),
        subfolder="transformer",
        local_files_only=True,
    )
    print(f"  {time.time()-t0:.0f}s  {sum(p.numel() for p in transformer.parameters())/1e9:.2f}B")

    print("加载 VAE...")
    vae = AutoencoderKLQwenImage.from_pretrained(
        D / "vae", torch_dtype=torch.bfloat16, local_files_only=True)

    print("加载 text_encoder(Qwen2.5-VL 4 分片 16.58GB BF16 -> 需量化)...")
    t0 = time.time()
    # 显存硬约束(实测 2026-10-03):
    #   text_encoder BF16 16.58GB + transformer GGUF 13.24GB = 28.92GB
    #   >> 17.1GB 显存,必须量化 text_encoder。
    #   8bit(20.63GB)仍超,只有 NF4 4bit 理论可行(16.49GB)。
    # 而且 text_encoder 不能留 CPU —— Qwen-Image-Edit 每次调用都跑它,
    # 与 transformer 同在一条计算链上,留 CPU 会报
    # "index is on cuda:0, different from other tensors on cpu"。
    from transformers import BitsAndBytesConfig
    te = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        D / "text_encoder", torch_dtype=torch.bfloat16,
        quantization_config=BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        ),
        device_map="cuda", local_files_only=True)
    print(f"  {time.time()-t0:.0f}s  (4bit NF4)")
    proc = Qwen2VLProcessor.from_pretrained(
        D / "processor", local_files_only=True)
    print(f"  {time.time()-t0:.0f}s")

    sched = FlowMatchEulerDiscreteScheduler.from_pretrained(
        D / "scheduler", local_files_only=True)

    # 组件名严格按 __init__ 签名(见 diffusers 源码 pipeline_qwenimage_edit_plus.py:189):
    #   scheduler / vae / text_encoder / tokenizer / processor / transformer
    # 注意参数叫 `processor`,不叫 image_processor —— 传错会直接 TypeError。
    pipe = QwenImageEditPlusPipeline(
        scheduler=sched, vae=vae, text_encoder=te,
        tokenizer=proc.tokenizer, processor=proc, transformer=transformer,
    )
    # VAE 也要显式上 cuda。text_encoder 用了 device_map="cuda" 是 accelerate
    # 托管的,不会被 pipe.to() 覆盖;但 vae/transformer 是普通 Module,
    # 必须统一搬到同一设备,否则报
    # "Input type (CUDABFloat16Type) and weight type (CPUBFloat16Type)"。
    pipe.vae.to("cuda", dtype=torch.bfloat16)
    pipe.transformer.to("cuda")
    pipe.set_progress_bar_config(disable=True)
    return pipe


def face_embs(paths: list[Path]) -> dict:
    """借 SDXL 环境(有 insightface)取 embedding,子进程隔离。

    .venv-qwen 里装不了 insightface —— 2.0 硬依赖 CPU 版 onnxruntime,
    与 onnxruntime-gpu 互斥(见 requirements-qwen.txt 注释)。验证时借用
    SDXL 环境那一份,反正只是打分,不是运行时依赖。
    """
    py = r"E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe"
    script = Path(__file__).parent / "_face_embed_subproc.py"
    r = subprocess.run(
        [py, str(script), *[str(p) for p in paths]],
        capture_output=True, text=True, timeout=600, cwd=str(ROOT),
    )
    out: dict = {}
    for line in r.stdout.splitlines():
        if not line.startswith("EMB "):
            continue
        path, _, val = line[4:].partition("=")
        if val.startswith("NONE") or val.startswith("ERR"):
            out[path] = None
        else:
            try:
                out[path] = np.fromstring(val, sep=" ", dtype=np.float32)
            except Exception:
                out[path] = None
    if not out:
        print("  (insightface 取 embedding 失败)")
        print("  stderr:", (r.stderr or "")[-300:])
    return out


def main() -> int:
    photos = sorted(SRC.glob("photo_*.jpg"))[:4]
    if not photos:
        print(f"{SRC} 下没有 photo_*.jpg")
        return 1
    print(f"输入: {SRC}  共 {len(photos)} 张\n")

    pipe = build_pipe()
    torch.cuda.reset_peak_memory_stats()
    print(f"\nvram after load: {torch.cuda.memory_allocated()/1e9:.2f} GB")

    scores = []
    made = []
    for p in photos:
        src = Image.open(p).convert("RGB")
        g = torch.Generator(device="cpu").manual_seed(SEED)
        t0 = time.time()
        with torch.inference_mode():
            out = pipe(
                prompt=PROMPT, negative_prompt=NEG, image=src,
                num_inference_steps=30, true_cfg_scale=4.0, generator=g,
            ).images[0]
        dt = time.time() - t0
        o = OUT / f"qwen_{p.stem}.jpg"
        out.save(o, quality=92)
        made.append((p, o, dt))
        print(f"  {p.name}  {dt:5.1f}s  -> {o.name}")

    peak = torch.cuda.max_memory_allocated() / 1e9
    print(f"\nvram peak = {peak:.2f} GB")

    # 统一取 embedding(一次子进程调用,避免每张都起进程)
    embs = face_embs([x for pair in made for x in pair[:2]])
    print()
    for src_p, out_p, dt in made:
        a, b = embs.get(str(src_p)), embs.get(str(out_p))
        c = float(a @ b) if a is not None and b is not None else -1.0
        scores.append(c)
        flag = "OK" if c >= THRESHOLD else ("LOW" if c > 0 else "N/A")
        print(f"  {src_p.name:<14} {dt:5.1f}s  cos={c:.4f} [{flag}]")

    if scores and scores[0] > 0:
        m = float(np.mean(scores))
        print(f"mean cos = {m:.4f}  threshold = {THRESHOLD}")
        print("VERDICT:", "PASS" if m >= THRESHOLD else "FAIL")
        return 0 if m >= THRESHOLD else 2
    print("insightface 不可用,无法打分(在 .venv-qwen 里装不了它,见 requirements 注释)")
    return 3


if __name__ == "__main__":
    sys.exit(main())
