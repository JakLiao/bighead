"""照片预处理的共享辅助: 降采样 -> 人脸感知裁切 -> 等比留边。

抽出来是因为三个验证脚本(check_photo / measure_identity /
make_style_sheet)都要走同一条预处理链, 各写一份必然漂移 —— 而漂移
恰恰是之前踩坑的根源(坐标按不同取景算过两次, 比的其实都是背景)。

**关键: 这里的 `fitted_canvas()` 必须和 backend/qwen_pipeline.generate_one
的预处理完全一致**, 否则在它上面量出来的坐标/尺寸与模型实际看到的
输入对不上。对应关系:

    generate_one:  降采样(>1600px) -> face_aware_crop_box -> 传 crop_box
    worker:        _fit_exact(img, w, h, crop_box)

所以本模块复刻的就是这条链。任何一处改了, 另一处必须跟着改。
"""
from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

from PIL import Image

PROJECT = Path(__file__).resolve().parent.parent
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

# 与 qwen_pipeline.generate_one 的降采样阈值保持一致
MAX_W = 1600


def load_worker():
    """按库方式加载 qwen_worker(它默认会把 stdout 抢去当协议通道)。"""
    os.environ.setdefault("BIGHEAD_QWEN_AS_LIBRARY", "1")
    spec = importlib.util.spec_from_file_location(
        "qwen_worker_lib", PROJECT / "backend" / "qwen_worker.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def downscale(img: Image.Image, max_w: int = MAX_W) -> Image.Image:
    """超大输入降采样。阈值与 generate_one 一致, 1280x720 完全不触发。"""
    if img.width <= max_w:
        return img
    s = max_w / float(img.width)
    return img.resize(
        (int(round(img.width * s)), int(round(img.height * s))),
        Image.LANCZOS,
    )


def crop_box_for(img: Image.Image, w: int, h: int):
    """人脸感知裁切框; 检不到脸返回 None(worker 会退回居中裁切)。"""
    from backend.face import face_aware_crop_box

    try:
        return face_aware_crop_box(img, int(w), int(h))
    except Exception:
        return None


def fitted_canvas(src: Path, w: int = 512, h: int = 768) -> Image.Image:
    """复刻 generate_one + worker 的完整预处理, 返回模型实际吃进去的图。

    在这张图上量人脸坐标才是对的 —— 之前按原图推算、按拉伸 resize 推算
    都因为「取景与实际不一致」而取到了背景。
    """
    img = downscale(Image.open(src).convert("RGB"))
    box = crop_box_for(img, w, h)
    worker = load_worker()
    return worker._fit_exact(img, w, h, crop_box=box)


def face_boxes(canvas: Image.Image, pad: float = 1.3) -> list[tuple]:
    """在**模型实际输入**上检出人脸, 各往外扩 pad 余量, 按 y 排序(上→下)。

    带余量是为了让特写带上发型/配饰, 更好判断是不是同一个人。
    """
    import numpy as np

    from backend.face import _get_app

    app = _get_app()
    out = []
    for f in app.get(np.array(canvas.convert("RGB"))) or []:
        x1, y1, x2, y2 = [float(v) for v in f.bbox]
        if x2 - x1 < 8 or y2 - y1 < 8:
            continue
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        s = max(x2 - x1, y2 - y1) * pad
        l = int(max(0, min(cx - s / 2, canvas.width - s)))
        t = int(max(0, min(cy - s / 2, canvas.height - s)))
        out.append((l, t, int(min(canvas.width, l + s)),
                    int(min(canvas.height, t + s))))
    out.sort(key=lambda b: b[1])
    return out


def face_ratio(app, im: Image.Image) -> list[float]:
    """每张人脸的 宽/高, 用来判断脸有没有被非等比拉伸拉扁。"""
    import numpy as np

    out = []
    for f in app.get(np.array(im.convert("RGB"))) or []:
        x1, y1, x2, y2 = [float(v) for v in f.bbox]
        if y2 - y1 >= 8:
            out.append((x2 - x1) / (y2 - y1))
    out.sort()
    return out


def font(size: int):
    """中文字体; Pillow 默认位图字体画不出中文。"""
    for n in ("msyh.ttc", "msyhbd.ttc", "simhei.ttf", "simsun.ttc"):
        p = Path("C:/Windows/Fonts") / n
        if p.exists():
            try:
                from PIL import ImageFont

                return ImageFont.truetype(str(p), size)
            except Exception:
                pass
    from PIL import ImageFont

    return ImageFont.load_default()
