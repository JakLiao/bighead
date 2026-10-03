"""相框 + N 宫格拼图 + 6 寸相纸排版(纯 PIL)."""
from __future__ import annotations

import io
import os
from typing import Iterable, Sequence

from PIL import Image, ImageDraw, ImageFont, ImageOps

from .config import FRAMES, LAYOUTS


def _load_font(size: int) -> ImageFont.ImageFont:
    """默认字体,跨平台可用."""
    try:
        return ImageFont.truetype("arial.ttf", size)
    except OSError:
        return ImageFont.load_default()


def _checker_bg(size: tuple[int, int], cell: int = 16, a=(255, 240, 240), b=(220, 200, 200)) -> Image.Image:
    img = Image.new("RGB", size, a)
    px = img.load()
    for y in range(0, size[1], cell):
        for x in range(0, size[0], cell):
            if ((x // cell) + (y // cell)) % 2:
                for dy in range(min(cell, size[1] - y)):
                    for dx in range(min(cell, size[0] - x)):
                        px[x + dx, y + dy] = b
    return img


def _draw_frame(canvas: Image.Image, frame_key: str, title: str = "") -> None:
    """在原图上叠一层相框(用 PIL.ImageOps.expand + ImageDraw)."""
    f = FRAMES.get(frame_key, FRAMES["none"])["params"]
    pad = int(f.get("pad", 0))
    if pad <= 0:
        return

    bg = f.get("bg", "#ffffff")
    if bg == "checker":
        bordered = _checker_bg(
            (canvas.width + pad * 2, canvas.height + pad * 2),
        )
        bordered.paste(canvas, (pad, pad))
        canvas.paste(bordered)
    else:
        bordered = ImageOps.expand(canvas, border=pad, fill=bg)
        canvas.paste(bordered)

    bottom_pad = int(f.get("bottom_pad", 0))
    if bottom_pad > 0:
        bordered = ImageOps.expand(canvas, border=(pad, pad, pad, pad + bottom_pad), fill=bg)
        canvas.paste(bordered)
        d = ImageDraw.Draw(bordered)
        font = _load_font(max(18, bottom_pad // 3))
        text = title or f.get("title", "")
        if text:
            tw = d.textlength(text, font=font)
            d.text(
                ((bordered.width - tw) / 2, bordered.height - bottom_pad + (bottom_pad - font.size) / 2),
                text,
                fill=(90, 70, 70),
                font=font,
            )
        canvas.paste(bordered)


def _smart_crop(
    im: Image.Image,
    cell_w: int,
    cell_h: int,
    focus: tuple[float, float] | None = None,
) -> Image.Image:
    """把原图裁成 cell 的宽高比并铺满,不留白。

    之前用 thumbnail 等比缩放后居中贴到 cell,宽图(摄像头 1280x720)
    塞进高格子(600x800)必然上下留一大片白 —— 排版看起来很空。

    这里改成 cover 式裁切:先按 cell 比例裁掉多余部分,再缩放到
    精确尺寸。focus 是裁切中心(归一化 0~1),默认取画面中上部 ——
    人像大头贴的主体在人脸,直接几何中心常常把头顶或下巴切掉。

    focus 缺省时用人脸位置:调用方传入 bbox 换算出的中心点。
    """
    im = im.convert("RGB")
    target_ratio = cell_w / cell_h
    w, h = im.size
    src_ratio = w / h

    if src_ratio > target_ratio:
        # 原图更宽,裁掉左右
        new_w = int(round(h * target_ratio))
        cx = focus[0] if focus else 0.5
        x1 = int(round(cx * w - new_w / 2))
        x1 = max(0, min(x1, w - new_w))
        box = (x1, 0, x1 + new_w, h)
    else:
        # 原图更高(或等比),裁掉上下
        new_h = int(round(w / target_ratio))
        # 竖向裁切中心默认上移一点,给头顶留空间,避免切下巴
        cy = focus[1] if focus else 0.42
        y1 = int(round(cy * h - new_h / 2))
        y1 = max(0, min(y1, h - new_h))
        box = (0, y1, w, y1 + new_h)

    return im.crop(box).resize((cell_w, cell_h), Image.LANCZOS)


def _resize_to_grid(
    images: Sequence[Image.Image],
    cell_w: int,
    cell_h: int,
) -> list[Image.Image]:
    """旧路径:等比缩放后居中贴到 cell,宽图会上下留白。

    保留是为了 BIGHEAD_SMART_CROP=0 时能回退对照 ——
    智能裁切见 _smart_crop。
    """
    out = []
    for im in images:
        im = im.convert("RGB")
        im.thumbnail((cell_w, cell_h), Image.LANCZOS)
        cell = Image.new("RGB", (cell_w, cell_h), (255, 255, 255))
        x = (cell_w - im.width) // 2
        y = (cell_h - im.height) // 2
        cell.paste(im, (x, y))
        out.append(cell)
    return out


def _face_focus(im: Image.Image) -> tuple[float, float] | None:
    """用人脸框算出裁切焦点(归一化坐标)。检不到人脸则返回 None。"""
    try:
        import numpy as np

        from .face import _get_app

        arr = np.array(im)
        faces = _get_app().get(arr)
        if not faces:
            return None
        f = max(faces, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]))
        x1, y1, x2, y2 = [float(v) for v in f.bbox]
        w, h = im.size
        # 人脸中心;纵向略微上移到发际线附近,大头贴构图更自然
        cx = (x1 + x2) / 2 / w
        cy = ((y1 + y2) / 2) / h - 0.06
        return (max(0.05, min(cx, 0.95)), max(0.05, min(cy, 0.95)))
    except Exception:
        return None


def make_collage(images: Sequence[Image.Image], layout: str = "2x2", frame: str = "plain_white") -> Image.Image:
    """根据 layout 拼图,每张图套上 frame,最终返回一张拼好的 PIL."""
    cfg = LAYOUTS.get(layout, LAYOUTS["2x2"])
    cols, rows = cfg["cols"], cfg["rows"]
    if "paper" in cfg:
        paper_w, paper_h = cfg["paper"]
    else:
        # 自适应大小:基于 800x1200 cell
        cell_w, cell_h = 600, 800
        paper_w = cell_w * cols + 40 * (cols + 1)
        paper_h = cell_h * rows + 40 * (rows + 1) + 80  # 底部留点余量

    # 单元格大小
    margin = 30
    cell_w = (paper_w - margin * (cols + 1)) // cols
    cell_h = (paper_h - margin * (rows + 1) - 80) // rows

    # 每张图先做 cell,再套 frame
    # smart=True 时按 cell 比例裁切铺满(无人脸则退回几何裁切),
    # 避免宽图塞进高格子时上下留大片空白
    smart = os.environ.get("BIGHEAD_SMART_CROP", "1") not in ("0", "false", "False")
    framed: list[Image.Image] = []
    for i, im in enumerate(images[: cols * rows]):
        focus = _face_focus(im) if smart else None
        cell = _smart_crop(im, cell_w, cell_h, focus) if smart \
            else _resize_to_grid([im], cell_w, cell_h)[0]
        _draw_frame(cell, frame, title=f"#{i+1}")
        framed.append(cell)

    # 空白补足
    while len(framed) < cols * rows:
        blank = Image.new("RGB", (cell_w, cell_h), (255, 248, 240))
        _draw_frame(blank, frame)
        framed.append(blank)

    # 拼到画布
    # 注意:_draw_frame 会给 cell 加 border(相框),尺寸比 cell_w/cell_h 大。
    # 旧代码按原始 cell_w/cell_h 推算 paste 坐标,相框会互相压盖并溢出
    # 画布右/下边缘。现在改用加框后的实际尺寸,并把画布按 cell 实际
    # 尺寸重新计算,保证边距均匀、不重叠。
    fw = max(c.width for c in framed)
    fh = max(c.height for c in framed)
    paper_w = margin + cols * fw + margin * (cols - 1) + margin
    paper_h = margin + rows * fh + margin * (rows - 1) + margin + 80

    bg_color = (255, 248, 240)
    paper = Image.new("RGB", (paper_w, paper_h), bg_color)
    for idx, cell in enumerate(framed):
        r, c = divmod(idx, cols)
        x = margin + c * (fw + margin)
        y = margin + r * (fh + margin)
        paper.paste(cell, (x, y))

    # 底部戳印
    d = ImageDraw.Draw(paper)
    font = _load_font(28)
    text = "BIGHEAD 2026"
    tw = d.textlength(text, font=font)
    d.text(((paper.width - tw) / 2, paper.height - 60), text, fill=(180, 100, 100), font=font)

    return paper


def collage_to_bytes(images: Sequence[Image.Image], layout: str, frame: str, fmt: str = "JPEG") -> bytes:
    paper = make_collage(images, layout=layout, frame=frame)
    buf = io.BytesIO()
    paper.save(buf, format=fmt, quality=92)
    return buf.getvalue()
