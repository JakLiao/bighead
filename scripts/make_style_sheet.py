"""四风格横向对比: 全身图 + 每人脸特写。

人脸特写用**在模型实际输入上自动检出的坐标**, 不写死坐标。
之前写死过三次都错(按原图推算 / 按拉伸 resize 推算), 每次都取到背景
却不报错 —— 坐标必须和实际取景一致, 而取景是会变的(降采样、留边、
输出尺寸都由管线决定)。自动检测从根上避免了这类错误。

用法:
  BIGHEAD_AI_BACKEND=qwen <webui python> scripts/make_style_sheet.py <照片>
  BIGHEAD_AI_BACKEND=qwen <webui python> scripts/make_style_sheet.py <照片> --no-gen
"""
from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
from photo_util import face_boxes, fitted_canvas, font  # noqa: E402

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))

from backend.config import AI_BACKEND, OUTPUT_DIR, STYLES  # noqa: E402

W, H = 512, 768
TILE = 260
PAD = 10
LABEL_H = 32
HEAD = 58


def sheet_full(tiles, title, out: Path):
    n = len(tiles)
    im = Image.new("RGB",
                   (n * W + (n + 1) * PAD, HEAD + LABEL_H + H + PAD * 2),
                   (24, 24, 28))
    d = ImageDraw.Draw(im)
    d.text((PAD, 16), title, fill=(240, 240, 245), font=font(25))
    fl = font(19)
    for i, (name, t) in enumerate(tiles):
        x = PAD + i * (W + PAD)
        d.text((x + 3, HEAD), name, fill=(255, 226, 130), font=fl)
        im.paste(t.resize((W, H), Image.LANCZOS), (x, HEAD + LABEL_H))
        d.rectangle([x, HEAD + LABEL_H, x + W - 1, HEAD + LABEL_H + H - 1],
                    outline=(70, 70, 80))
    im.save(out, quality=92)
    print(f"-> {out}")


def sheet_faces(tiles, boxes, title, out: Path):
    """每张脸一行, 列与 sheet_full 一致, 便于横向对读。"""
    n, m = len(tiles), len(boxes)
    im = Image.new("RGB",
                   (n * TILE + (n + 1) * PAD,
                    HEAD + m * (LABEL_H + TILE + PAD) + PAD),
                   (24, 24, 28))
    d = ImageDraw.Draw(im)
    d.text((PAD, 14), title, fill=(240, 240, 245), font=font(23))
    fl = font(16)
    for r, box in enumerate(boxes):
        y0 = HEAD + r * (LABEL_H + TILE + PAD)
        d.text((PAD, y0), f"脸{r + 1}", fill=(180, 220, 255), font=fl)
        for i, (name, t) in enumerate(tiles):
            x = PAD + i * (TILE + PAD)
            y = y0 + LABEL_H
            if r == 0:
                d.text((x + 2, y0), name, fill=(255, 226, 130), font=fl)
            b = (min(box[0], t.width - 1), min(box[1], t.height - 1),
                 min(box[2], t.width), min(box[3], t.height))
            im.paste(t.crop(b).resize((TILE, TILE), Image.LANCZOS), (x, y))
            d.rectangle([x, y, x + TILE, y + TILE], outline=(70, 70, 80))
    im.save(out, quality=92)
    print(f"-> {out}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="输入照片路径")
    ap.add_argument("--no-gen", action="store_true",
                    help="不跑模型, 只用已有产物重拼对比图")
    ap.add_argument("--seed", type=int, default=4242)
    a = ap.parse_args()

    src = Path(a.src)
    if not src.exists():
        print(f"找不到: {src}")
        return 1
    tag = src.stem[:16]
    out_dir = OUTPUT_DIR / f"_styles_{tag}"
    base = Image.open(src).convert("RGB")

    # 基准图 = 模型实际吃进去的那张, 保证与生成图取景一致
    ref = fitted_canvas(src, W, H)
    print(f"基准(模型实际输入) {ref.size}")

    tiles = [("原图", ref)]
    if not a.no_gen:
        logging.basicConfig(level=logging.INFO,
                            format="%(asctime)s %(message)s")
        if AI_BACKEND != "qwen":
            print("请用 BIGHEAD_AI_BACKEND=qwen 运行, 或加 --no-gen")
            return 1
        from backend.qwen_pipeline import qwen_pipeline

        print("预热 ...", flush=True)
        t0 = time.time()
        qwen_pipeline.ensure_ready(wait=True)
        print(f"就绪 {time.time() - t0:.1f}s\n")
        out_dir.mkdir(parents=True, exist_ok=True)
        for key, style in STYLES.items():
            d = out_dir / key
            d.mkdir(parents=True, exist_ok=True)
            t0 = time.time()
            img = qwen_pipeline.generate_one(base, style, seed=a.seed)
            img.save(d / "out.jpg", quality=92)
            print(f"{key:<20} {time.time() - t0:6.1f}s "
                  f"peak={qwen_pipeline.last_peak_gb:.2f}G")
            tiles.append((style["name"], img))
    else:
        for key, style in STYLES.items():
            p = out_dir / key / "out.jpg"
            if p.exists():
                tiles.append((style["name"], Image.open(p).convert("RGB")))

    boxes = face_boxes(ref)
    if not boxes:
        print("未检出人脸, 只出全身对比图")
    sheet_full(tiles, f"四风格 · {src.name} ({W}x{H}, seed {a.seed})",
               OUTPUT_DIR / f"sheet_{tag}.jpg")
    if boxes:
        sheet_faces(tiles, boxes,
                    f"人脸特写 · 自动检出 {len(boxes)} 张 · 固定坐标不经检测器",
                    OUTPUT_DIR / f"faces_{tag}.jpg")
    print(f"产物目录: {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
