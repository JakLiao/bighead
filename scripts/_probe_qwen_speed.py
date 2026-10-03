"""测量 Qwen-Image-Edit 在本机的真实单步耗时,判断可行性。

背景:上一次 30 步 x 4 张的验证跑了 15+ 分钟还没出第一张,必须先搞清
瓶颈在哪,否则后面全是白等。这里用 4 步 x 1 张,逐步计时,拆开看:
  - text_encoder 前向(prompt+图像 token 过 Qwen2.5-VL)
  - transformer 去噪每步
  - VAE 解码
若单步 X 秒,则 4 张 x 30 步 = 120*X 秒,可直接判断能不能接受。

可调:STEPS / W / H / REPEAT
用法: python scripts/_probe_qwen_speed.py
"""
from __future__ import annotations

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

STEPS = 4
W, H = 768, 1024
SRC = ROOT / "outputs" / "1a0b12477d66" / "photo_2.jpg"

PROMPT = ("将照片处理成复古大头贴风格:1990 年代香港电影胶片质感。"
          "严格保持原图中人物的身份、五官比例、脸型、发型和眼镜不变。")


def main() -> int:
    from diffusers import (
        AutoencoderKLQwenImage,
        FlowMatchEulerDiscreteScheduler,
        GGUFQuantizationConfig,
        QwenImageEditPlusPipeline,
        QwenImageTransformer2DModel,
    )
    from transformers import (
        BitsAndBytesConfig,
        Qwen2VLProcessor,
        Qwen2_5_VLForConditionalGeneration,
    )

    t0 = time.time()
    transformer = QwenImageTransformer2DModel.from_single_file(
        str(D / "transformer" / "qwen-image-edit-2511-Q4_K_M.gguf"),
        quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
        dtype=torch.bfloat16, config=str(D / "transformer"),
        subfolder="transformer", local_files_only=True,
    )
    print(f"transformer  {time.time()-t0:5.0f}s")
    t0 = time.time()
    vae = AutoencoderKLQwenImage.from_pretrained(
        D / "vae", torch_dtype=torch.bfloat16, local_files_only=True)
    print(f"vae          {time.time()-t0:5.0f}s")
    t0 = time.time()
    te = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        D / "text_encoder", torch_dtype=torch.bfloat16,
        quantization_config=BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True),
        device_map="cuda", local_files_only=True)
    print(f"text_encoder {time.time()-t0:5.0f}s  (4bit)")
    proc = Qwen2VLProcessor.from_pretrained(D / "processor", local_files_only=True)
    sched = FlowMatchEulerDiscreteScheduler.from_pretrained(
        D / "scheduler", local_files_only=True)

    pipe = QwenImageEditPlusPipeline(
        scheduler=sched, vae=vae, text_encoder=te,
        tokenizer=proc.tokenizer, processor=proc, transformer=transformer)
    pipe.vae.to("cuda", dtype=torch.bfloat16)
    pipe.transformer.to("cuda")
    pipe.set_progress_bar_config(disable=True)

    print(f"\nload total   {time.time()-t0:5.0f}s")
    print(f"vram         {torch.cuda.memory_allocated()/1e9:.2f} GB")
    print(f"target       {W}x{H}, steps={STEPS}\n")

    src = Image.open(SRC).convert("RGB")
    g = torch.Generator(device="cpu").manual_seed(42)

    # callback_on_step_end 用来给每步计时。
    # 必须返回 dict —— pipeline 里会做 callback_outputs.pop(...),
    # 返回 None 会直接 AttributeError(踩过一次)。
    times = []

    def on_step(p, i, t, kw):
        times.append(time.time())
        return kw

    torch.cuda.reset_peak_memory_stats()
    t0 = time.time()
    with torch.inference_mode():
        out = pipe(
            prompt=PROMPT,
            negative_prompt="cartoon, anime, illustration, deformed, text, watermark",
            image=src, width=W, height=H,
            num_inference_steps=STEPS, true_cfg_scale=4.0, generator=g,
            callback_on_step_end=on_step,
        ).images[0]
    total = time.time() - t0

    print(f"total        {total:6.1f}s")
    if len(times) >= 2:
        d = [times[i + 1] - times[i] for i in range(len(times) - 1)]
        print(f"per-step     {sum(d)/len(d):6.2f}s  (min {min(d):.2f} max {max(d):.2f})")
        first = times[0] - t0
        print(f"step0+prep   {first:6.2f}s  (含 text_encoder 前向与 latent 准备)")
    print(f"vram peak    {torch.cuda.max_memory_allocated()/1e9:.2f} GB")

    p = OUT / "speed_probe.jpg"
    out.save(p, quality=90)
    print(f"saved        {p}")

    per = (total / STEPS) if STEPS else 0
    print(f"\n外推 4 张 x 30 步 = {per*30*4/60:.1f} 分钟")
    return 0


if __name__ == "__main__":
    sys.exit(main())
