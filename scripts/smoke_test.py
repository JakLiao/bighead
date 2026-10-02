"""后端烟测:
1) 加载 FastAPI app,启动测试 client(无 uvicorn 进程).
2) 验证 /api/health.
3) 验证 /api/preview/filter (生成测试图 → 应用 faded_90s → 落盘).
4) 验证 /api/layout/make (用 4 张测试图生成 2×2 拼图).
5) 可选:验证 AI 写真(传入 --ai).
"""
from __future__ import annotations

import argparse
import io
import os
import sys
import time
from pathlib import Path

# 让脚本可以直接 python scripts/smoke_test.py
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# 使用 webui 的 .venv,设置环境
os.environ.setdefault("PYTHONPATH", str(ROOT))

from fastapi.testclient import TestClient

from backend.app import app  # noqa: E402

EXPORTS = ROOT / "outputs" / "_smoke"
EXPORTS.mkdir(parents=True, exist_ok=True)


def make_test_image(idx: int, size=(640, 800)) -> bytes:
    """生成一张纯色 + 文字的测试 JPEG,模拟自拍."""
    from PIL import Image, ImageDraw

    colors = [(220, 180, 160), (180, 200, 220), (200, 220, 180), (240, 200, 200)]
    img = Image.new("RGB", size, colors[idx % len(colors)])
    d = ImageDraw.Draw(img)
    d.ellipse((size[0] // 4, size[1] // 4, size[0] * 3 // 4, size[1] * 3 // 4), fill=(255, 220, 180))
    d.text((20, 20), f"TEST #{idx + 1}", fill=(60, 60, 60))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ai", action="store_true", help="同时跑 AI 写真烟测")
    args = parser.parse_args()

    print("=" * 60)
    print("  BigHead smoke test")
    print("=" * 60)

    with TestClient(app) as client:
        # 1) /api/health
        print("\n[1/4] /api/health")
        r = client.get("/api/health")
        r.raise_for_status()
        print(f"  -> {r.json()}")

        # 2) /api/preview/filter
        print("\n[2/4] /api/preview/filter")
        img = make_test_image(0)
        r = client.post(
            "/api/preview/filter",
            files={"image": ("a.jpg", img, "image/jpeg")},
            data={"preset": "faded_90s"},
        )
        r.raise_for_status()
        out = EXPORTS / "preview_faded.jpg"
        out.write_bytes(r.content)
        print(f"  -> wrote {out} ({len(r.content)} bytes)")

        # 3) /api/capture/save + /api/layout/make
        print("\n[3/4] /api/capture/save + /api/layout/make")
        files = [("images", (f"p{i}.jpg", make_test_image(i), "image/jpeg")) for i in range(4)]
        r = client.post("/api/capture/save", files=files)
        r.raise_for_status()
        cap = r.json()
        print(f"  -> capture job_id={cap['job_id']}, count={cap['count']}")

        # 拉原图做拼图
        job_id = cap["job_id"]
        photo_paths = sorted((ROOT / "outputs" / job_id).glob("photo_*.jpg"))
        layout_files = [("images", (p.name, p.read_bytes(), "image/jpeg")) for p in photo_paths]
        r = client.post(
            "/api/layout/make",
            files=layout_files,
            data={"layout": "2x2", "frame": "korean_pink"},
        )
        r.raise_for_status()
        out = EXPORTS / "collage.jpg"
        out.write_bytes(r.content)
        print(f"  -> wrote {out} ({len(r.content)} bytes)")

        # 4) /api/meta
        print("\n[4/4] /api/meta")
        r = client.get("/api/meta")
        r.raise_for_status()
        meta = r.json()
        print(f"  -> styles={len(meta['styles'])}, filters={len(meta['filters'])}, "
              f"frames={len(meta['frames'])}, layouts={len(meta['layouts'])}")

        # 5) 可选 AI 烟测
        if args.ai:
            print("\n[5/5] AI generation smoke test (SDXL + FaceID)")
            from backend.config import STYLES
            from backend.pipeline import pipeline

            t0 = time.time()
            pipeline._ensure_loaded("sdxl")
            print(f"  model loaded in {time.time() - t0:.1f}s")

            from PIL import Image

            face = Image.open(EXPORTS / "preview_faded.jpg")  # 用前面的测试图
            t0 = time.time()
            img = pipeline.generate_one(face, STYLES["FILM_VELVIA"], backbone="sdxl", steps=20, size=(512, 768))
            elapsed = time.time() - t0
            out = EXPORTS / "ai_velvia.jpg"
            img.convert("RGB").save(out, quality=92)
            import torch
            peak = torch.cuda.max_memory_allocated() / 1e9
            print(f"  -> wrote {out}, {elapsed:.1f}s, vram_peak={peak:.2f}GB")

    print("\n" + "=" * 60)
    print("  smoke test PASS")
    print(f"  outputs in {EXPORTS}")
    print("=" * 60)


if __name__ == "__main__":
    main()
