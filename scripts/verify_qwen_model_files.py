"""验证已下载的 Qwen-Image-Edit-2511 Q4_K_M 文件是否完整可用。

下载完不等于能用:GGUF 可能截断、config 可能缺失。这里不碰 GPU,
纯离线校验文件结构,为 Task 3 的加载测试做准备。

用法: python scripts/verify_qwen_model_files.py
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

D = Path(r"E:\Code\stable-diffusion-webui\models\qwen")
PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    (PASS if ok else FAIL).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}"
          f"{'  ' + detail if detail else ''}")


def gguf_header(p: Path) -> dict:
    """解析 GGUF 头:魔数 + 版本 + tensor/kv 数量。"""
    with open(p, "rb") as f:
        magic = f.read(4)
        ver, = struct.unpack("<I", f.read(4))
        n_tensors, = struct.unpack("<Q", f.read(8))
        n_kv, = struct.unpack("<Q", f.read(8))
        # architecture 字段,定长字符串:len(u64) + bytes
        arch_len, = struct.unpack("<Q", f.read(8))
        arch = f.read(arch_len).decode("utf-8", "ignore") if arch_len < 256 else "?"
    return {"magic": magic, "ver": ver, "tensors": n_tensors, "kv": n_kv, "arch": arch}


def safetensors_meta(p: Path) -> int:
    with open(p, "rb") as f:
        n, = struct.unpack("<Q", f.read(8))
        if n > 100 * 1024 * 1024:      # 头部长得不合理 = 文件坏了
            return -1
        meta = json.loads(f.read(n).decode("utf-8"))
    return len([k for k in meta if k != "__metadata__"])


def main() -> int:
    print("=" * 68)
    print("  Qwen-Image-Edit-2511 文件完整性校验")
    print("=" * 68)

    gg = D / "transformer" / "qwen-image-edit-2511-Q4_K_M.gguf"
    print("\n  --- transformer (GGUF) ---")
    if not gg.exists():
        check("GGUF 存在", False, str(gg))
    else:
        h = gguf_header(gg)
        size = gg.stat().st_size
        check("GGUF 魔数正确", h["magic"] == b"GGUF", repr(h["magic"]))
        check("GGUF v3 且结构合理",
              h["ver"] == 3 and h["tensors"] > 1000,
              f"v{h['ver']}, {h['tensors']} tensors, arch={h['arch']}")
        # 实测字节数,来自魔塔 Content-Range
        check("字节数与远端一致", size == 13_244_758_624,
              f"{size:,}")

    print("\n  --- text_encoder (4 分片) ---")
    shards = sorted((D / "text_encoder").glob("model-0000*-of-00004.safetensors"))
    check("4 个分片齐全", len(shards) == 4, f"实际 {len(shards)}")
    for s in shards:
        n = safetensors_meta(s)
        check(f"{s.name} 头有效", n > 0, f"{n} tensors, "
              f"{s.stat().st_size/1e9:.2f} GB")
    idx = D / "text_encoder" / "model.safetensors.index.json"
    if idx.exists():
        m = json.loads(idx.read_text(encoding="utf-8"))
        want = set(m.get("weight_map", {}).values())
        have = {s.name for s in shards}
        check("index 引用的分片都存在", want <= have,
              f"缺 {want - have}" if want - have else "OK")

    print("\n  --- vae ---")
    vae = D / "vae" / "diffusion_pytorch_model.safetensors"
    if vae.exists():
        n = safetensors_meta(vae)
        check("VAE 头有效", n > 0, f"{n} tensors, {vae.stat().st_size/1e9:.2f} GB")
    else:
        check("VAE 存在", False)
    cfg = json.loads((D / "vae" / "config.json").read_text(encoding="utf-8"))
    check("VAE 是 AutoencoderKLQwenImage",
          cfg.get("_class_name") == "AutoencoderKLQwenImage",
          cfg.get("_class_name", "?"))
    check("VAE config 标注的 diffusers 最低版本",
          cfg.get("_diffusers_version", "") >= "0.36",
          cfg.get("_diffusers_version", "?"))

    print("\n  --- Pipeline 组装必需的小文件 ---")
    mi = D / "meta" / "model_index.json"
    if mi.exists():
        m = json.loads(mi.read_text(encoding="utf-8"))
        cls = m.get("_class_name", "?")
        check("model_index 声明 QwenImageEditPlusPipeline",
              cls == "QwenImageEditPlusPipeline", cls)
    else:
        check("model_index.json 存在", False)
    for rel in ["scheduler/scheduler_config.json",
                "tokenizer/tokenizer_config.json", "tokenizer/merges.txt",
                "tokenizer/vocab.json", "processor/preprocessor_config.json",
                "processor/tokenizer_config.json", "processor/merges.txt",
                "processor/vocab.json", "transformer/config.json"]:
        check(f"{rel}", (D / rel).exists())

    total = sum(f.stat().st_size for f in D.rglob("*") if f.is_file())
    print(f"\n  合计 {total/1e9:.2f} GB")
    print(f"\n  PASS={len(PASS)} FAIL={len(FAIL)}")
    if FAIL:
        print("  失败: " + ", ".join(FAIL))
    print("=" * 68)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
