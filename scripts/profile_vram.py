"""显存剖析:定位 8GB 超限的具体来源.

逐步测量 torch.cuda 显存,找出哪个组件占用最多,
以便决定是换 attention slicing、group norm 分组还是 sequential offload.
"""
from __future__ import annotations

import gc
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import backend.config  # noqa: F401,E402

import torch  # noqa: E402


def mb() -> float:
    return torch.cuda.memory_allocated() / 1e9


def peak() -> float:
    return torch.cuda.max_memory_allocated() / 1e9


def reserved() -> float:
    return torch.cuda.memory_reserved() / 1e9


def report(tag: str) -> None:
    print(f"  {tag:<42} alloc={mb():.3f}GB  peak={peak():.3f}GB  reserved={reserved():.3f}GB",
          flush=True)


def main() -> int:
    from PIL import Image

    from backend.config import FACEID_SCALE, SDXL_CFG, SDXL_CKPT, STYLES
    from backend.face import _get_app

    face_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not face_path:
        print("usage: profile_vram.py <face.jpg>")
        return 1

    print("=" * 74)
    print("  VRAM profiling")
    print("=" * 74, flush=True)

    torch.cuda.init()
    torch.cuda.reset_peak_memory_stats()
    report("0. baseline (torch init)")

    # 1) InsightFace
    app = _get_app()
    gc.collect(); torch.cuda.empty_cache()
    report("1. after InsightFace buffalo_l")

    # 2) SDXL
    from backend.pipeline import pipeline
    pipeline._ensure_loaded("sdxl")
    gc.collect(); torch.cuda.empty_cache()
    report("2. after SDXL + FaceID adapter (offloaded)")

    pipe = pipeline.pipe
    ip = pipeline.ip_adapter

    # 3) 各组件实际驻留情况
    print("\n  component residency (device / dtype / params):")
    for name, mod in [
        ("unet", pipe.unet), ("vae", pipe.vae),
        ("text_encoder", pipe.text_encoder), ("text_encoder_2", pipe.text_encoder_2),
        ("ip.image_encoder", getattr(ip, "image_encoder", None)),
        ("ip.image_proj_model", getattr(ip, "image_proj_model", None)),
    ]:
        if mod is None:
            print(f"    {name:<22} <none>")
            continue
        try:
            dev = next(mod.parameters()).device
            n = sum(p.numel() for p in mod.parameters())
            dt = next(mod.parameters()).dtype
            print(f"    {name:<22} {str(dev):<8} {str(dt):<15} {n / 1e6:8.1f}M params")
        except StopIteration:
            print(f"    {name:<22} <no params>")

    # 4) 分辨率扫描:找峰值拐点
    print("\n  resolution sweep (steps=20, VELVIA):", flush=True)
    face = Image.open(face_path)
    rows = []
    for w, h in [(512, 512), (512, 640), (512, 768), (576, 864), (640, 960)]:
        gc.collect(); torch.cuda.empty_cache(); torch.cuda.reset_peak_memory_stats()
        try:
            out = pipeline.generate_one(
                face, STYLES["FILM_VELVIA"], backbone="sdxl", steps=20, size=(w, h)
            )
            p = peak()
            flag = "OK" if p <= 8.0 else "OVER"
            print(f"    {w}x{h:<5} peak={p:.3f}GB  {flag}", flush=True)
            rows.append((w, h, p, flag))
            del out
        except torch.cuda.OutOfMemoryError as e:
            print(f"    {w}x{h:<5} OOM: {str(e)[:60]}", flush=True)
            rows.append((w, h, float("nan"), "OOM"))
            break
        except Exception as e:
            print(f"    {w}x{h:<5} ERR: {repr(e)[:80]}", flush=True)
            rows.append((w, h, float("nan"), "ERR"))
            break

    print("\n" + "=" * 74)
    print("  safe sizes (peak <= 8.0GB):")
    for w, h, p, flag in rows:
        if flag == "OK":
            print(f"    {w}x{h}  ({p:.3f}GB)")
    print("=" * 74)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
