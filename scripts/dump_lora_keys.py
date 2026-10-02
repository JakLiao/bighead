"""打印某个 LoRA 的真实 key 命名与关键张量形状,用于校准 check_sdxl_lora.py。"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import backend.config as cfg  # noqa: E402

from safetensors import safe_open  # noqa: E402

name = sys.argv[1] if len(sys.argv) > 1 else "VELVIA"
if name.upper() == "VELVIA":
    path = cfg.VELVIA_LORA
elif name.upper() == "SDXLREF":
    path = cfg.MODEL_BASE / "Lora" / "亚洲审美（Asian Aesthetics）_v1.0.safetensors"
else:
    path = Path(name)

print(f"  file = {path.name}\n")
with safe_open(str(path), framework="pt", device="cpu") as f:
    keys = list(f.keys())
    print(f"  total keys = {len(keys)}\n")
    print("  --- 前 10 个 key ---")
    for k in keys[:10]:
        print(f"    {k}  {f.get_slice(k).get_shape()}")
    print("\n  --- 含 attn2 的 key(前 8 个)---")
    for k in [x for x in keys if "attn2" in x][:8]:
        print(f"    {k}  {f.get_slice(k).get_shape()}")
    print("\n  --- 含 to_k / to_q 的 key(前 8 个)---")
    for k in [x for x in keys if ".to_k" in x or ".to_q" in x][:8]:
        print(f"    {k}  {f.get_slice(k).get_shape()}")
print("=" * 88)
