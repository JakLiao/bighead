"""定位 Qwen-Image-Edit 在本机的瓶颈:到底慢在哪一步。

现象:4 步 x 768x1024 跑了 8+ 分钟没出图;GPU 100% 但功耗只有 79W
(满载约 250W)—— 说明 GPU 大部分时间在等,不是算。

怀疑对象(按可能性排序):
  1. GGUF 动态反量化:每层 forward 时把 uint8 权重解成 bf16。
     DIFFUSERS_GGUF_CUDA_KERNELS 默认 false,走的是慢速 PyTorch 路径。
  2. bitsandbytes NF4:警告 "inner dimension (3420) is not aligned for
     blocksize=64, falling back to slower implementation" ——
     Qwen2.5-VL 的 hidden dim 不是 64 倍数,快速内核用不上。
  3. text_encoder 4bit 被反复调用(每步都要重算 prompt embeds?)。

本脚本分段计时,只跑 2 步、512x512(最小可用),把时间拆开:
  text_encoder 前向 / transformer 每步 / VAE 解码
另外对比 DIFFUSERS_GGUF_CUDA_KERNELS 开关的影响。

用法:
    python scripts/_profile_qwen.py
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import torch
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
D = Path(r"E:\Code\stable-diffusion-webui\models\qwen")
OUT = ROOT / "outputs" / "_verify" / "qwen"
OUT.mkdir(parents=True, exist_ok=True)
SRC = ROOT / "outputs" / "1a0b12477d66" / "photo_2.jpg"

W = H = 512
STEPS = 2


def build():
    from diffusers import (
        AutoencoderKLQwenImage, FlowMatchEulerDiscreteScheduler,
        GGUFQuantizationConfig, QwenImageEditPlusPipeline,
        QwenImageTransformer2DModel,
    )
    from transformers import (
        BitsAndBytesConfig, Qwen2VLProcessor,
        Qwen2_5_VLForConditionalGeneration,
    )

    t0 = time.time()
    tr = QwenImageTransformer2DModel.from_single_file(
        str(D / "transformer" / "qwen-image-edit-2511-Q4_K_M.gguf"),
        quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
        dtype=torch.bfloat16, config=str(D / "transformer"),
        subfolder="transformer", local_files_only=True)
    print(f"load transformer      {time.time()-t0:6.1f}s")

    t0 = time.time()
    vae = AutoencoderKLQwenImage.from_pretrained(
        D / "vae", torch_dtype=torch.bfloat16, local_files_only=True)

    te = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        D / "text_encoder", torch_dtype=torch.bfloat16,
        quantization_config=BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True),
        device_map="cuda", local_files_only=True)
    print(f"load vae+text_encoder {time.time()-t0:6.1f}s")

    proc = Qwen2VLProcessor.from_pretrained(D / "processor", local_files_only=True)
    sched = FlowMatchEulerDiscreteScheduler.from_pretrained(
        D / "scheduler", local_files_only=True)
    pipe = QwenImageEditPlusPipeline(
        scheduler=sched, vae=vae, text_encoder=te,
        tokenizer=proc.tokenizer, processor=proc, transformer=tr)
    pipe.vae.to("cuda", dtype=torch.bfloat16)
    pipe.transformer.to("cuda")
    pipe.set_progress_bar_config(disable=True)
    return pipe


def main() -> int:
    from diffusers.quantizers.gguf.utils import can_use_cuda_kernels
    print(f"DIFFUSERS_GGUF_CUDA_KERNELS = {os.getenv('DIFFUSERS_GGUF_CUDA_KERNELS', 'false')}")
    print(f"diffusers can_use_cuda_kernels = {can_use_cuda_kernels}")
    print(f"target {W}x{H} steps={STEPS}\n")

    pipe = build()
    print(f"vram {torch.cuda.memory_allocated()/1e9:.2f} GB\n")

    src = Image.open(SRC).convert("RGB")
    marks = []

    def on_step(p, i, t, kw):
        marks.append(("step", i, time.time()))
        return kw

    torch.cuda.reset_peak_memory_stats()
    t0 = time.time()
    with torch.inference_mode():
        out = pipe(
            prompt="复古大头贴风格,保持人物身份与五官不变。",
            negative_prompt="cartoon, anime, text, watermark",
            image=src, width=W, height=H, num_inference_steps=STEPS,
            true_cfg_scale=4.0, generator=torch.Generator("cpu").manual_seed(7),
            callback_on_step_end=on_step,
        ).images[0]
    total = time.time() - t0

    print(f"\n总耗时 {total:.1f}s  ({W}x{H}, {STEPS} 步)")
    if marks:
        prep = marks[0][2] - t0
        print(f"  准备(含 text_encoder 前向) {prep:6.1f}s")
        for k in range(1, len(marks)):
            d = marks[k][2] - marks[k - 1][2]
            print(f"  step {marks[k][1]}                  {d:6.1f}s")
        if len(marks) > 1:
            print(f"  末步+VAE 解码         {total-(marks[-1][2]-t0):6.1f}s")
    print(f"vram peak {torch.cuda.max_memory_allocated()/1e9:.2f} GB")

    p = OUT / "profile.jpg"
    out.save(p, quality=90)
    print(f"saved {p}")

    per = total / STEPS
    print(f"\n外推: 单步 {per:.1f}s")
    print(f"  4 张 x 30 步(1024x1024) = {per*30*4/60:.1f} 分钟")
    print(f"  4 张 x 20 步( 768x1024) = {per*20*4/60:.1f} 分钟")
    return 0


if __name__ == "__main__":
    sys.exit(main())
