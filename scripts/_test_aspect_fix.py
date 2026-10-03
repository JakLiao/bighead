"""验证 _fit_exact 修复: 脸的长宽比不再被扭曲。

判据(这是关键, 比「看起来正常」可靠):
  **人脸 bbox 的宽高比必须在处理前后基本一致。**
  用 InsightFace 检测处理前后的脸, 比较 w/h。
  修复前: 2.42x 纵向拉伸 -> 脸会明显变窄变长
  修复后: 偏差应在 5% 以内

这是纯几何 + 检测的验证, 不需要 GPU/模型, 秒级完成。

用法: <webui python> scripts/_test_aspect_fix.py
"""
from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))
os.environ["BIGHEAD_QWEN_AS_LIBRARY"] = "1"

spec = importlib.util.spec_from_file_location(
    "qw", PROJECT / "backend" / "qwen_worker.py")
qw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qw)

from backend.face import _get_app, face_aware_crop_box  # noqa: E402

SRC = PROJECT / "outputs" / "1a0b12477d66" / "photo_3.jpg"
OUT = PROJECT / "outputs" / "_aspect_diag"
OUT.mkdir(parents=True, exist_ok=True)
W, H = 512, 768
TOL = 0.05


def face_ratios(app, im: Image.Image) -> list[float]:
    """每张检出人脸的 宽/高。"""
    out = []
    for f in app.get(np.array(im.convert("RGB"))) or []:
        x1, y1, x2, y2 = [float(v) for v in f.bbox]
        if y2 - y1 >= 8:
            out.append((x2 - x1) / (y2 - y1))
    out.sort()
    return out


def main() -> int:
    app = _get_app()
    src = Image.open(SRC).convert("RGB")
    box = face_aware_crop_box(src, W, H)
    print(f"原图 {src.size}   裁切框 {box}")

    before = face_ratios(app, src)
    print(f"原图人脸宽高比: {[f'{r:.3f}' for r in before]}")

    fixed = qw._fit_exact(src, W, H, crop_box=box)
    print(f"\n修复后 _fit_exact 输出: {fixed.size}")
    assert fixed.size == (W, H), f"尺寸不对: {fixed.size}"
    p = OUT / "fixed_fit.jpg"
    fixed.save(p, quality=92)
    print(f"-> {p}")

    after = face_ratios(app, fixed)
    print(f"修复后人脸宽高比: {[f'{r:.3f}' for r in after]}")

    # 只比第一张脸(原图里男士脸最大, 且是改脸最严重的那张)
    if not before or not after:
        print("\n没检出人脸, 无法比较")
        return 1
    b, a = before[0], after[0]
    dev = abs(a - b) / b
    print(f"\n最大那张脸: {b:.3f} -> {a:.3f}   偏差 {dev:.1%}")
    ok = dev <= TOL
    print("PASS: 人脸比例未被扭曲" if ok
          else f"FAIL: 人脸比例仍被扭曲({dev:.1%})")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
