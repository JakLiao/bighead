"""验证 .venv-qwen 环境能否加载 Qwen-Image-Edit-2511。

分两步,便于定位失败点:
  1. 类是否存在(纯 import,不碰权重)
  2. GGUF transformer 能否 from_single_file 加载(需要读 12.33GB 权重)

第 2 步会占显存,单独跑。GGUF 不能用 Pipeline 直接加载,必须
from_single_file;而它需要 config 才知道结构,所以本地那份
transformer/config.json 是必需的(不是可选)。

用法:
    python scripts/_verify_qwen_env.py classes
    python scripts/_verify_qwen_env.py transformer
"""
from __future__ import annotations

import sys
from pathlib import Path

D = Path(r"E:\Code\stable-diffusion-webui\models\qwen")
GGUF = D / "transformer" / "qwen-image-edit-2511-Q4_K_M.gguf"
CFG = D / "transformer" / "config.json"


def check_classes() -> int:
    import diffusers
    import gguf
    import torch
    import transformers

    print(f"diffusers    {diffusers.__version__}")
    print(f"transformers {transformers.__version__}")
    print(f"torch        {torch.__version__}")
    print(f"gguf         (import 成功)")
    print(f"cuda         {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"gpu          {torch.cuda.get_device_name(0)} "
              f"sm_{''.join(map(str, torch.cuda.get_device_capability(0)))}")

    print("\n类可用性:")
    fails = []
    for name in ["QwenImageEditPlusPipeline", "QwenImageEditPipeline",
                 "QwenImageTransformer2DModel", "AutoencoderKLQwenImage",
                 "GGUFQuantizationConfig", "FlowMatchEulerDiscreteScheduler"]:
        ok = hasattr(diffusers, name)
        print(f"  [{'OK' if ok else '--'}] diffusers.{name}")
        if not ok:
            fails.append(name)

    try:
        from transformers import Qwen2_5_VLForConditionalGeneration
        print(f"  [OK] transformers.Qwen2_5_VLForConditionalGeneration")
    except Exception as e:
        print(f"  [--] transformers.Qwen2_5_VL... : {e}")
        fails.append("Qwen2_5_VL")

    try:
        from transformers import Qwen2VLProcessor
        print(f"  [OK] transformers.Qwen2VLProcessor")
    except Exception as e:
        print(f"  [--] Qwen2VLProcessor : {e}")
        fails.append("Qwen2VLProcessor")

    print(f"\n缺失: {fails if fails else '无'}")
    return 1 if fails else 0


def check_transformer() -> int:
    import torch
    from diffusers import GGUFQuantizationConfig, QwenImageTransformer2DModel

    print(f"gguf : {GGUF}")
    print(f"exists={GGUF.exists()} size={GGUF.stat().st_size:,}" if GGUF.exists() else "MISSING")
    print(f"config: {CFG} exists={CFG.exists()}")
    if not GGUF.exists() or not CFG.exists():
        return 1

    print("\n加载中(读 12.33GB 权重,首次较慢)...")
    t = QwenImageTransformer2DModel.from_single_file(
        str(GGUF),
        quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
        dtype=torch.bfloat16,
        config=str(CFG.parent),
        subfolder="transformer",
        local_files_only=True,
    )
    n = sum(p.numel() for p in t.parameters()) / 1e9
    print(f"\nOK  参数量 {n:.2f}B  dtype={next(t.parameters()).dtype}")
    print(f"device={next(t.parameters()).device}")

    # 权重确实以低内存 dtype 存放(未全部展开成 bf16)才省显存
    from collections import Counter
    c = Counter(str(p.dtype) for p in t.parameters())
    print(f"权重 dtype 分布: {dict(c)}")
    if len(c) > 1:
        print("  -> 存在混合 dtype,说明 GGUF 动态反量化生效(这是预期行为)")
    return 0


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "classes"
    sys.exit(check_classes() if mode == "classes" else check_transformer())
