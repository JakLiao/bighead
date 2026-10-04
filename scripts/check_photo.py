"""检查一张照片走完预处理后的几何状态: 比例、人脸分布、是否留边。

用途: 换新照片时先跑这个, 确认三件事 ——
  1. 人脸感知裁切框能不能把所有脸都装进去(不切人);
  2. 裁切框比例与目标差多少(决定 _fit_exact 要不要留边);
  3. **人脸有没有被非等比拉伸拉扁**(最关键, 见下)。

第 3 点曾经是真正的病根: 裁切框比例 != 目标比例时, 旧版 _fit_exact
直接 resize, 实测把脸纵向拉伸 2.42 倍, 而模型是拿这张畸变图去编辑的,
所以输出「不像本人」。判据用人脸 bbox 的 宽/高 在处理前后偏差 ≤5%,
因为它直接量了脸有没有被拉扁, 比肉眼看整图可靠得多。

用法:
  <webui python> scripts/check_photo.py <照片路径>
  <webui python> scripts/check_photo.py <照片路径> --w 512 --h 768
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from photo_util import (  # noqa: E402
    crop_box_for, downscale, face_ratio, fitted_canvas,
)

TOL = 0.05          # 人脸宽高比允许的偏差
DISTORT_LIMIT = 1.2  # 纵横失真超过这个倍数就明确告警


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="待检查的照片路径")
    ap.add_argument("--w", type=int, default=512)
    ap.add_argument("--h", type=int, default=768)
    a = ap.parse_args()

    src = Path(a.src)
    if not src.exists():
        print(f"找不到: {src}")
        return 1
    W, H = a.w, a.h

    img = Image.open(src).convert("RGB")
    print(f"原图 {img.size[0]}x{img.size[1]}  比例={img.width / img.height:.3f}")
    print(f"目标 {W}x{H}  比例={W / H:.3f}")

    small = downscale(img)
    if small.size != img.size:
        print(f"降采样 -> {small.size[0]}x{small.size[1]}")

    from backend.face import _get_app

    app = _get_app()
    before = face_ratio(app, small)
    print(f"\n人脸宽高比(降采样后): {[f'{r:.3f}' for r in before]}")

    box = crop_box_for(small, W, H)
    print(f"\n人脸感知裁切框 = {box}")
    if box:
        cw, ch = box[2] - box[0], box[3] - box[1]
        print(f"  尺寸 {cw}x{ch}  比例={cw / ch:.3f}")
        sx, sy = W / float(cw), H / float(ch)
        print(f"  若直接 resize: 横向 {sx:.3f} 纵向 {sy:.3f} "
              f"-> 失真 {max(sy / sx, sx / sy):.2f}x")
        if max(sy / sx, sx / sy) > DISTORT_LIMIT:
            print("  [警告] 比例差很多 —— 旧版 _fit_exact 在这里会拉扁脸")

    fitted = fitted_canvas(src, W, H)
    print(f"\n拟合后(模型实际输入) {fitted.size}")

    after = face_ratio(app, fitted)
    print(f"人脸宽高比(拟合后):   {[f'{r:.3f}' for r in after]}")

    if not before or not after:
        print("\n没检出人脸, 无法判断拉伸")
        return 1
    b, af = before[0], after[0]
    dev = abs(af - b) / b
    print(f"\n最大那张脸: {b:.3f} -> {af:.3f}   偏差 {dev:.1%}")
    if dev <= TOL:
        print("PASS: 人脸比例未被扭曲")
        return 0
    print(f"FAIL: 人脸比例被扭曲({dev:.1%} > {TOL:.0%})")
    return 2


if __name__ == "__main__":
    sys.exit(main())
