"""检查各 backbone 所需的模型资源是否齐备."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import backend.config as c  # noqa: E402

print("=" * 70)
print("  Model assets check")
print("=" * 70)

items = [
    ("SDXL_CKPT", c.SDXL_CKPT),
    ("SDXL_VAE", c.SDXL_VAE),
    ("IPADAPTER_FACEID_SDXL", c.IPADAPTER_FACEID_SDXL),
    ("FACEID_LORA_SDXL", c.FACEID_LORA_SDXL),
    ("VELVIA_LORA", c.VELVIA_LORA),
    ("SD15_CKPT", getattr(c, "SD15_CKPT", None)),
    ("IPADAPTER_FACEID_SD15", getattr(c, "IPADAPTER_FACEID_SD15", None)),
    ("FACEID_LORA_SD15", getattr(c, "FACEID_LORA_SD15", None)),
    ("CLIP_VISION_H", c.CLIP_VISION_H),
]

for name, p in items:
    if p is None:
        print(f"  {name:<26} <未定义>")
        continue
    if not hasattr(p, "exists"):
        print(f"  {name:<26} <类型错误>")
        continue
    ok = p.exists()
    size = f"{p.stat().st_size / 1e6:.1f}MB" if ok and p.is_file() else ("dir" if ok else "-")
    print(f"  {name:<26} {'OK  ' if ok else 'MISS'}  {size:<10} {p.name}")

# LoRA 适用性判定
print("\n  LoRA compatibility:")
try:
    import re

    from safetensors import safe_open

    lora = c.VELVIA_LORA
    if lora.exists():
        with safe_open(str(lora), framework="pt") as f:
            keys = list(f.keys())
        te_layers = {int(m.group(1)) for m in
                     (re.match(r"lora_te_text_model_encoder_layers_(\d+)_", k) for k in keys)
                     if m}
        is_sd15 = bool(te_layers) and max(te_layers) <= 11
        print(f"    text_encoder layers = {max(te_layers) + 1 if te_layers else 0}")
        print(f"    => 适配 {'SD1.5' if is_sd15 else 'SDXL'}")
        print(f"    => SDXL 路线会因维度不匹配而无法加载 (预期行为)")
except Exception as e:
    print(f"    check failed: {e}")

print("=" * 70)
