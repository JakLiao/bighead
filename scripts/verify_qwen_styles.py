"""四风格横向对比: 同一张照片 x 四个 qwen_prompt, 走生产链路。

为什么单独一个脚本: 风格 prompt 是靠眼睛判断的, 而 e2e 脚本每次只跑一个
风格, 没法横向比。四个风格跑**同一张脸**, 才能一眼看出:
  1. 风格是否真的生效(不是原图微调)
  2. 身份是否还在(尤其 SHOWA_ANIME, 写实->赛璐璐是最大跳跃)
  3. 有没有烧焦/糊脸/色偏等 4 步蒸馏常见退化

产物落在 outputs/_style_compare/<style_key>/, 不污染正式 job 目录。
看图: 直接打开输出目录。

用法: BIGHEAD_AI_BACKEND=qwen <webui python> scripts/verify_qwen_styles.py
"""
from __future__ import annotations

import logging
import sys
import time
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))

from backend.config import AI_BACKEND, OUTPUT_DIR, STYLES  # noqa: E402

OUT = OUTPUT_DIR / "_style_compare"


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )
    print(f"AI_BACKEND = {AI_BACKEND}")
    if AI_BACKEND != "qwen":
        print("这个脚本只测 qwen 后端, 请用 BIGHEAD_AI_BACKEND=qwen 运行")
        return 1

    src = OUTPUT_DIR / "1a0b12477d66"
    photos = sorted(src.glob("photo_*.jpg"))
    if not photos:
        print(f"缺少测试照片: {src}")
        return 1
    # 只取 1 张: 风格对比要的是横向可比, 不是样本量
    photo = photos[0]
    print(f"测试照片: {photo.name}\n")

    from backend.qwen_pipeline import qwen_pipeline

    print("预热(首次约 2 分钟, 含模型加载) ...", flush=True)
    t0 = time.time()
    qwen_pipeline.ensure_ready(wait=True)
    print(f"就绪 {time.time() - t0:.1f}s  LoRA 层数="
          f"{qwen_pipeline._lora_layers}\n")

    from PIL import Image

    base = Image.open(photo).convert("RGB")
    results: list[tuple[str, str, float, float]] = []

    for key, style in STYLES.items():
        d = OUT / key
        d.mkdir(parents=True, exist_ok=True)
        print(f"--- {key} ({style['name']}) ---")
        print(f"    prompt: {style.get('qwen_prompt', '')[:60]}...")
        t0 = time.time()
        img = qwen_pipeline.generate_one(base, style, seed=4242)
        dt = time.time() - t0
        p = d / f"{photo.stem}.jpg"
        img.save(p, quality=92)
        peak = qwen_pipeline.last_peak_gb
        results.append((key, str(p), dt, peak))
        print(f"    {dt:.1f}s  peak={peak:.2f}GB -> {p.name}\n")

    print("=" * 66)
    print(f"{'风格':<20} {'耗时':>8} {'峰值':>9}")
    for key, p, dt, peak in results:
        print(f"{key:<20} {dt:>7.1f}s {peak:>8.2f}G")
    print("=" * 66)
    print(f"\n原图: {photo}")
    print(f"产物目录: {OUT}")
    for key, p, _, _ in results:
        print(f"  {key:<20} {p}")

    bad = [k for k, _, dt, peak in results if peak <= 0]
    if bad:
        print(f"\nFAIL: 这些风格没拿到显存回传: {bad}")
        return 2
    print("\nPASS: 四个风格全部产出, 请目视对比")
    return 0


if __name__ == "__main__":
    sys.exit(main())
