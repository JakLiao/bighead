"""go/no-go 判据: 身份余弦验证 (Q3_K_M + Lightning 4 步 LoRA + CFG 1.0)。

为什么必须做: 换 Qwen 的唯一理由是「产出和拍照的人对得上」。4 步蒸馏 + 3-bit
权重量化都可能损伤身份细节, 所以这是决定方案能不能上线的最后一刀。

判据 (沿用 SDXL 阶段定的阈值, 不事后调整):
  身份余弦均值 >= 0.55  -> PASS
  SDXL 实测基线: photo_2/3/4 互相余弦 0.81~0.87, 但生成图 vs 原图仅
  0.42~0.66 且肉眼明显不像本人 —— 0.55 就是「比 SDXL 好且肉眼可认」的水位。

同时做 A/B: Q3_K_M(挂 LoRA) vs Q4_K_M(不挂 LoRA), 两者输出都算分。
前者是候选方案, 后者是「不敢降量化档」的参照, 用来量化降档到底掉了多少。

用法: python scripts/verify_qwen_identity.py
"""
from __future__ import annotations

import gc
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
D = Path(r"E:\Code\stable-diffusion-webui\models\qwen")
SRC = ROOT / "outputs" / "1a0b12477d66"
OUT = ROOT / "outputs" / "_verify" / "qwen_identity"
OUT.mkdir(parents=True, exist_ok=True)

LORA_KOHYA = D / "lora" / "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"
LORA_PEFT = OUT / "lightning4_peft.safetensors"

W, H = 512, 512
STEPS = 4
CFG = 1.0
SEED = 4242
THRESHOLD = 0.55

PROMPT = (
    "将照片处理成复古大头贴风格:1990 年代香港电影剧照质感,暖调胶片,轻微褪色。"
    "严格保持原图中人物的身份、五官比例、脸型不变,只改变画面风格与色彩质感。"
)

# (标签, gguf, 是否挂 LoRA, 步数, CFG)
CASES = [
    ("Q3+LoRA", "qwen-image-edit-2511-Q3_K_M.gguf", True, STEPS, CFG),
    ("Q4裸跑", "qwen-image-edit-2511-Q4_K_M.gguf", False, 8, 4.0),
]


def kohya_to_peft(src: Path, dst: Path) -> None:
    """Kohya lora_down/lora_up/alpha -> PEFT lora_A/lora_B。

    方向不能反: Kohya 的 delta 是 (up @ down) * (alpha/rank),
    PEFT 的增量是 B @ A * scaling, 所以 up -> B, down -> A。
    alpha 融进 lora_B(等价于 scaling = alpha/rank)。
    """
    from safetensors.torch import load_file, save_file

    sd = load_file(str(src))
    out: dict[str, torch.Tensor] = {}
    n = 0
    for k in list(sd.keys()):
        if ".lora_down." not in k:
            continue
        prefix, _, tail = k.partition(".lora_down.")
        b = sd.get(f"{prefix}.lora_up.{tail}")
        if b is None:
            continue
        a = sd[k]
        alpha = sd.get(f"{prefix}.alpha")
        scale = float(alpha) / a.shape[0] if alpha is not None else 1.0
        out[f"{prefix}.lora_B.weight"] = (b.float() * scale).to(torch.bfloat16)
        out[f"{prefix}.lora_A.weight"] = a.to(torch.bfloat16)
        n += 1
    save_file(out, str(dst))
    print(f"LoRA 格式转换: {n} 对 -> {dst.name}")


def build_pipe(gguf: str):
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

    transformer = QwenImageTransformer2DModel.from_single_file(
        str(D / "transformer" / gguf),
        quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
        dtype=torch.bfloat16,
        config=str(D / "transformer"), subfolder="transformer",
        local_files_only=True,
    )
    vae = AutoencoderKLQwenImage.from_pretrained(
        D / "vae", torch_dtype=torch.bfloat16, local_files_only=True)
    te = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        D / "text_encoder", torch_dtype=torch.bfloat16,
        quantization_config=BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True),
        device_map="cpu", local_files_only=True)
    proc = Qwen2VLProcessor.from_pretrained(D / "processor", local_files_only=True)
    sched = FlowMatchEulerDiscreteScheduler.from_pretrained(
        D / "scheduler", local_files_only=True)
    pipe = QwenImageEditPlusPipeline(
        scheduler=sched, vae=vae, text_encoder=te,
        tokenizer=proc.tokenizer, processor=proc, transformer=transformer,
    )
    pipe.set_progress_bar_config(disable=True)
    pipe.to("cpu")

    # 组件显存编排: 不走 enable_model_cpu_offload(它逐参数搬运, 每步 ~49GB PCIe)
    te_m, tf_m, vae_m = pipe.text_encoder, pipe.transformer, pipe.vae
    st = {"tf_on_gpu": False}
    vae_m.to("cuda")

    def te_pre(m, args, kwargs):
        if st["tf_on_gpu"]:
            tf_m.to("cpu")
            torch.cuda.empty_cache()
            st["tf_on_gpu"] = False
        m.to("cuda")

    def te_post(m, args, out):
        m.to("cpu")
        torch.cuda.empty_cache()

    def tf_pre(m, args, kwargs):
        if not st["tf_on_gpu"]:
            m.to("cuda")
            st["tf_on_gpu"] = True

    te_m.register_forward_pre_hook(te_pre, with_kwargs=True)
    te_m.register_forward_hook(te_post)
    tf_m.register_forward_pre_hook(tf_pre, with_kwargs=True)
    return pipe


def face_embs(paths: list[Path]) -> dict:
    """借 SDXL 环境(有 insightface)取 embedding, 子进程隔离。"""
    py = r"E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe"
    script = Path(__file__).parent / "_face_embed_subproc.py"
    r = subprocess.run(
        [py, str(script), *[str(p) for p in paths]],
        capture_output=True, text=True, timeout=900, cwd=str(ROOT),
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
        print("  stderr:", (r.stderr or "")[-400:])
    return out


def main() -> int:
    photos = sorted(SRC.glob("photo_*.jpg"))[:4]
    if not photos:
        print(f"{SRC} 下没有 photo_*.jpg")
        return 1
    print(f"输入 {len(photos)} 张: {[p.name for p in photos]}\n")
    print(f"判据: 身份余弦均值 >= {THRESHOLD}\n" + "=" * 70)

    if not LORA_PEFT.exists():
        kohya_to_peft(LORA_KOHYA, LORA_PEFT)

    all_scores: dict[str, list[float]] = {}
    all_made: list[tuple[str, Path, Path, float]] = []

    for tag, gguf, use_lora, steps, cfg in CASES:
        print(f"\n[{tag}] {gguf}  LoRA={'是' if use_lora else '否'}  "
              f"{steps} 步 CFG{cfg:g}")
        pipe = build_pipe(gguf)

        if use_lora:
            # prefix=None 必须显式传: peft.py:195 会按默认的 "transformer"
            # 前缀过滤 key, 我们的 key 是 transformer_blocks.* 会被全滤掉,
            # 而 diffusers 只 warning 不报错 -> 静默挂不上。
            pipe.transformer.load_lora_adapter(
                str(LORA_PEFT), adapter_name="l4", prefix=None)
            from peft.tuners.tuners_utils import BaseTunerLayer
            n = sum(1 for m in pipe.transformer.modules()
                    if isinstance(m, BaseTunerLayer))
            print(f"  LoRA 层: {n}")
            if n == 0:
                print("  LoRA 没挂上, 跳过该组")
                del pipe
                gc.collect()
                torch.cuda.empty_cache()
                continue

        print("  预热 ...", end=" ", flush=True)
        tw = time.time()
        with torch.inference_mode():
            pipe(prompt=PROMPT, image=Image.open(photos[0]).convert("RGB")
                 .resize((256, 256)), num_inference_steps=1,
                 true_cfg_scale=cfg,
                 generator=torch.Generator("cpu").manual_seed(0))
        print(f"{time.time() - tw:.1f}s")

        for p in photos:
            src = Image.open(p).convert("RGB")
            t0 = time.time()
            with torch.inference_mode():
                out = pipe(
                    prompt=PROMPT, image=src,
                    num_inference_steps=steps, true_cfg_scale=cfg,
                    generator=torch.Generator("cpu").manual_seed(SEED),
                ).images[0]
            dt = time.time() - t0
            o = OUT / f"{tag.replace('+','_')}_{p.stem}.jpg"
            out.save(o, quality=92)
            all_made.append((tag, p, o, dt))
            print(f"    {p.name:<14} {dt:6.1f}s -> {o.name}")

        del pipe
        gc.collect()
        torch.cuda.empty_cache()

    # ---- 统一打分 ----
    print("\n" + "=" * 70)
    print("取 identityface embedding (借 SDXL 环境) ...", flush=True)
    embs = face_embs([x for _, a, b, _ in all_made for x in (a, b)])

    print()
    for tag in dict.fromkeys(t for t, _, _, _ in all_made):
        rows = [(a, b, d) for t, a, b, d in all_made if t == tag]
        scores = []
        print(f"--- {tag} ---")
        for src_p, out_p, dt in rows:
            a, b = embs.get(str(src_p)), embs.get(str(out_p))
            c = float(a @ b) if a is not None and b is not None else -1.0
            scores.append(c)
            flag = "OK" if c >= THRESHOLD else "LOW"
            print(f"  {src_p.name:<14} {dt:6.1f}s  cos={c:.4f} [{flag}]")
        if scores and scores[0] > 0:
            m = float(np.mean(scores))
            all_scores[tag] = m
            print(f"  mean = {m:.4f}   {'PASS' if m >= THRESHOLD else 'FAIL'}"
                  f"   总耗时 {sum(d for _, _, d in rows):.0f}s")
        print()

    print("=" * 70)
    for tag, m in all_scores.items():
        print(f"  {tag:<12} mean cos = {m:.4f}  "
              f"{'PASS' if m >= THRESHOLD else 'FAIL'}")
    if all_scores:
        best = max(all_scores, key=all_scores.get)
        print(f"\n最优: {best}  ({all_scores[best]:.4f})")
        return 0 if all_scores[best] >= THRESHOLD else 2
    return 3


if __name__ == "__main__":
    sys.exit(main())
