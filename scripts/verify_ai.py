"""AI 写真验证:SDXL + FaceID 身份保持 + 显存压测.

与 smoke_test.py --ai 的区别:
1) 使用真实人脸照片,而非合成色块图(合成图 InsightFace 检测不到脸)
2) 量化身份相似度:用 InsightFace 提取原图与生成图的 512 维人脸向量算余弦相似度
3) 逐档压测显存:512x768 / 640x960 / 768x1152,确认 8GB 预算内的安全边界
4) 验证无脸输入的降级行为
"""
from __future__ import annotations

import argparse
import gc
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# 必须先导入 config:其中的环境变量设置要在 torch/diffusers 加载前生效
import backend.config  # noqa: F401,E402

EXPORTS = ROOT / "outputs" / "_verify"
EXPORTS.mkdir(parents=True, exist_ok=True)

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name} {detail}", flush=True)


def cosine(a, b) -> float:
    import numpy as np

    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


def embed(app, pil):
    import numpy as np

    faces = app.get(np.array(pil.convert("RGB")))
    if not faces:
        return None
    f = max(faces, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]))
    return f.normed_embedding.reshape(-1).astype(np.float32)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--face", required=True, help="真实人脸照片路径")
    ap.add_argument("--quick", action="store_true", help="只测 512x768 一档")
    args = ap.parse_args()

    import torch
    from PIL import Image

    from backend.config import STYLES
    from backend.face import _get_app
    from backend.pipeline import pipeline

    print("=" * 64)
    print("  AI verification: SDXL + FaceID")
    print("=" * 64, flush=True)

    src_path = Path(args.face)
    face_img = Image.open(src_path)
    print(f"\n[0] input: {src_path.name} {face_img.size}", flush=True)

    app = _get_app()
    src_emb = embed(app, face_img)
    check("InsightFace detects face in source", src_emb is not None,
          f"emb={None if src_emb is None else src_emb.shape}")
    if src_emb is None:
        print("  无法在人脸图上建立基准,终止")
        return 1

    # ---------- 加载模型 ----------
    print("\n[1] load models", flush=True)
    t0 = time.time()
    pipeline._ensure_loaded("sdxl")
    print(f"  loaded in {time.time() - t0:.1f}s", flush=True)
    check("SDXL + FaceID pipeline loaded", pipeline.pipe is not None)
    check("ip_adapter attached", pipeline.ip_adapter is not None,
          type(pipeline.ip_adapter).__name__)

    # ---------- 尺寸档位压测 ----------
    sizes = [(512, 768)] if args.quick else [(512, 768), (640, 960), (768, 1152)]
    results = []
    for i, (w, h) in enumerate(sizes, 1):
        print(f"\n[{i + 1}] generate {w}x{h}", flush=True)
        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        t0 = time.time()
        try:
            out = pipeline.generate_one(
                face_img, STYLES["FILM_VELVIA"], backbone="sdxl", steps=20, size=(w, h)
            )
        except Exception as e:
            check(f"{w}x{h} generate", False, repr(e))
            continue
        el = time.time() - t0
        peak = torch.cuda.max_memory_allocated() / 1e9
        path = EXPORTS / f"ai_{w}x{h}.jpg"
        out.convert("RGB").save(path, quality=92)

        gen_emb = embed(app, out)
        sim = cosine(src_emb, gen_emb) if gen_emb is not None else None
        results.append((w, h, el, peak, sim))
        print(f"  {w}x{h}: {el:.1f}s  vram_peak={peak:.2f}GB  "
              f"cosine={sim if sim is None else round(sim, 4)}", flush=True)
        check(f"{w}x{h} produced image", path.exists() and path.stat().st_size > 10000,
              f"{path.stat().st_size // 1024}KB")
        check(f"{w}x{h} face preserved", sim is not None and sim > 0.25,
              f"cosine={sim if sim is None else round(sim, 4)}")
        check(f"{w}x{h} within 8GB budget", peak <= 8.0, f"peak={peak:.2f}GB")

    # ---------- 无脸降级 ----------
    print("\n[n] no-face fallback", flush=True)
    blank = Image.new("RGB", (512, 768), (128, 128, 128))
    try:
        out = pipeline.generate_one(
            blank, STYLES["PORTRAIT_HK"], backbone="sdxl", steps=8, size=(512, 768)
        )
        p = EXPORTS / "ai_noface.jpg"
        out.convert("RGB").save(p, quality=92)
        check("no-face input still renders", p.exists(),
              "降级为纯文本生成(零 embedding)")
    except Exception as e:
        check("no-face input still renders", False, repr(e))

    # ---------- 汇总 ----------
    print("\n" + "=" * 64)
    print("  summary")
    print("  size        time     vram_peak   cosine")
    for w, h, el, peak, sim in results:
        flag = "OK " if peak <= 8.0 else "OVER"
        print(f"  {w}x{h:<5} {el:6.1f}s   {peak:5.2f}GB {flag}  "
              f"{'-' if sim is None else round(sim, 4)}")
    print(f"\n  PASS: {len(PASS)}   FAIL: {len(FAIL)}")
    if FAIL:
        print("  failed -> " + ", ".join(FAIL))
    print("=" * 64)
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
