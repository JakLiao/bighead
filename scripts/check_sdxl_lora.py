"""检查候选 LoRA 是否与 SDXL 底座兼容(在下载前/加载前判定)。

SDXL UNet 的 cross_attention_dim = 2048,SD1.5 = 768。
Kohya/A1111 格式的 LoRA key 形如:
    lora_unet_down_blocks_0_attentions_0_transformer_blocks_0_attn2_to_k.lora_down.weight
其中 attn2.to_k / attn2.to_v 对应的输入维度必须是 cross_attention_dim。

判定规则(读权重 shape,不需要真正加载模型):
  - 取 lora_unet_*_attn2_to_{k,v}.lora_down.weight 的形状
    -> [rank, cross_attention_dim]?  rank 那一维之外应有 2048
  - 文本编码器:SDXL 是两个 CLIP(G pen, L pen),共 32+32 层;
    出现 lora_te_* 里有 12 层以内的 block 索引 => 是 SD1.5 权重
输出每个候选的结论 + 关键维度。
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import backend.config as cfg  # noqa: E402

from safetensors import safe_open  # noqa: E402

SDXL_CROSS = 2048
SD15_CROSS = 768
SDXL_TE_LAYERS = 32
SD15_TE_LAYERS = 12


def inspect(path: Path) -> None:
    try:
        with safe_open(str(path), framework="pt", device="cpu") as f:
            keys = list(f.keys())
            # Kohya 命名用下划线: ..._attn2_to_k.lora_down.weight
            unet_attn2 = [k for k in keys if k.startswith("lora_unet")
                          and "attn2_to_k" in k and k.endswith("lora_down.weight")]
            te = [k for k in keys if k.startswith("lora_te")]
            te_blocks = set()
            for k in te:
                for part in k.split(".")[0].split("_"):
                    if part.isdigit() and int(part) < 40:
                        te_blocks.add(int(part))
                        break
    except Exception as e:
        print(f"  {path.name[:52]:<54} 读取失败: {type(e).__name__}")
        return

    total = len(keys)
    n_unet = sum(1 for k in keys if k.startswith("lora_unet"))
    n_te = sum(1 for k in keys if k.startswith("lora_te"))
    other = total - n_unet - n_te

    if not unet_attn2:
        print(f"  {path.name[:52]:<54} 非 UNet LoRA (unet={n_unet} te={n_te} other={other})")
        return

    with safe_open(str(path), framework="pt", device="cpu") as f:
        shp = f.get_slice(unet_attn2[0]).get_shape()
    rank, cross = (shp[0], shp[1]) if len(shp) == 2 else (shp[0], -1)

    max_te = max(te_blocks) if te_blocks else -1
    if cross == SDXL_CROSS:
        arch = "SDXL"
    elif cross == SD15_CROSS:
        arch = "SD1.5"
    else:
        arch = f"未知({cross})"

    note = ""
    if arch == "SDXL" and max_te >= 0 and max_te < SDXL_TE_LAYERS and n_te:
        note = "  <- UNet 是 SDXL 但 TE 层数偏少,慎用"
    print(f"  {path.name[:52]:<54} unet={n_unet:>4} te={n_te:>4} "
          f"rank={rank:<3} cross={cross:<5} te_max={max_te:<4} => {arch}{note}")


def main() -> None:
    lora_dir = cfg.MODEL_BASE / "Lora"
    print(f"  目录: {lora_dir}\n")
    cands = [p for p in sorted(lora_dir.iterdir())
             if p.suffix == ".safetensors" and not p.name.startswith(".")]
    print(f"  共 {len(cands)} 个候选,以下为含 lora_unet/attn2 权重的:\n")
    for p in cands:
        inspect(p)
    print(f"\n  SDXL cross_attention_dim = {SDXL_CROSS}, SD1.5 = {SD15_CROSS}")
    print("=" * 96)


if __name__ == "__main__":
    main()
