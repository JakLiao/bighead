"""量化「风格化强度」: 客观测量输出与原图的差异, 代替肉眼判断。

为什么需要: 目视对比四个风格时, 「风格化太弱」这个判断很主观 ——
容易把「改了但改得少」和「没改」混为一谈。这里用可复算的指标。

**关键前提: 必须复现 worker 的 _fit_exact 裁切, 否则测的是裁切不是风格。**
原始照片是 1280x720 横图, 而 worker 在推理前会先居中裁成 2:3 竖图
(见 qwen_worker._fit_exact) 再缩到 512x768。所以输出图和原图**不是同一
个取景**。如果直接拿原图去比, RMSE 会虚高到 80~100(那全是裁切带来的
几何差异), 风格本身的贡献被彻底淹没 —— 第一版就踩了这个坑。

做法: 把原图也走一遍同样的 _fit_exact, 得到「裁切基准图」, 再和输出比。
这样测出来的差异才只反映模型到底改了多少。

用法: python scripts/_measure_style_shift.py <输出图1> <输出图2> ...
       python scripts/_measure_style_shift.py --ref <基准图> <输出图1> ...
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(r"f:\Trae-work\bighead\outputs")
DEFAULT_REF = ROOT / "1a0b12477d66" / "photo_1.jpg"


def fit_exact(img: Image.Image, w: int, h: int) -> Image.Image:
    """复刻 qwen_worker._fit_exact: 居中裁到目标宽高比再缩放。"""
    iw, ih = img.size
    if (iw, ih) == (w, h):
        return img
    target_ratio = w / h
    src_ratio = iw / ih
    if src_ratio > target_ratio:
        new_w = int(round(ih * target_ratio))
        left = (iw - new_w) // 2
        img = img.crop((left, 0, left + new_w, ih))
    else:
        new_h = int(round(iw / target_ratio))
        top = (ih - new_h) // 2
        img = img.crop((0, top, iw, top + new_h))
    return img.resize((w, h), Image.LANCZOS)


def stats(im: Image.Image) -> tuple[float, np.ndarray]:
    a = np.asarray(im).astype(np.float32)
    s = float(np.asarray(im.convert("HSV")).astype(np.float32)[..., 1].mean())
    return s, a


def main() -> int:
    args = sys.argv[1:]
    # 基准图必须和被测图同源。默认写死 photo_1 曾经导致一个隐蔽错误:
    # 拿 photo_3 的输出去比 photo_1 的基准, 数字看着合理但毫无意义。
    # 所以允许 --ref 显式指定。
    ref_path = DEFAULT_REF
    if "--ref" in args:
        i = args.index("--ref")
        ref_path = Path(args[i + 1])
        del args[i:i + 2]
        # 顺手把基准图自己从待测列表里去掉(它是路径解析的常见坑:
        # --ref 后面那个参数如果没被 del 掉, 就会被当成待测文件)
        args = [a for a in args if Path(a) != ref_path]
    if not args:
        print(__doc__)
        return 1
    if not ref_path.exists():
        print(f"基准图不存在: {ref_path}")
        return 1

    with Image.open(ref_path) as im:
        base_im = fit_exact(im.convert("RGB"), 512, 768)
    bs, ba = stats(base_im)
    print(f"基准 {ref_path.name} (经 _fit_exact 512x768)  饱和度={bs:6.2f}  "
          f"亮度={ba.mean():6.2f}")
    print("-" * 74)
    print(f"{'文件':<38}{'饱和Δ':>9}{'亮度Δ':>9}{'RMSE':>9}")
    print("-" * 74)

    for p in sys.argv[1:]:
        p = Path(p)
        if not p.exists():
            print(f"{p.name:<38}  (不存在)")
            continue
        with Image.open(p) as im:
            # 输出已经是 512x768, 但仍走一遍 fit_exact 保证同尺寸
            o_im = fit_exact(im.convert("RGB"), 512, 768)
        s, a = stats(o_im)
        rmse = float(np.sqrt(((a - ba) ** 2).mean()))
        flag = "  <-- 几乎没改" if rmse < 8 else ""
        print(f"{p.parent.name + '/' + p.name:<38}"
              f"{s - bs:>+9.2f}{a.mean() - ba.mean():>+9.2f}"
              f"{rmse:>9.2f}{flag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
