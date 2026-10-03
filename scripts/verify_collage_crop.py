"""验证智能裁切:排版留白是否被消除,且人脸没被切掉。

问题:摄像头原图 1280x720(宽>高),排版 cell 600x800(高>宽)。
旧实现用 thumbnail 等比缩放后居中贴,宽图塞进高格子必然上下留白,
用户反馈"生成效果图太多空白"。

判据(不看代码看行为):
  1. 空白率:cell 内非图像内容的像素占比。旧实现应 >25%,新的应接近 0。
     用"每行/每列的方差"定位纯色留白区域 —— 留白行/列的像素方差极低。
  2. 人脸完整性:裁切后重新检测人脸,要求仍能检出且面积不显著缩小。
     只看"检出"不够,要看脸有没有被切掉一半。
  3. 视觉对照:输出 smart / legacy 两张拼图供肉眼确认。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend" / "vendor"))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

OUT = ROOT / "outputs" / "_verify" / "crop"
OUT.mkdir(parents=True, exist_ok=True)
PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"    [{'PASS' if cond else 'FAIL'}] {name} {detail}", flush=True)


def blank_ratio(a: np.ndarray) -> float:
    """真留白率:纯白填充像素的占比。

    不要用"行/列方差低"来判留白 —— 纯色墙面、天空、过曝高光
    的方差也很低,会被误判成留白(合成图上尤其明显,曾把
    "完全铺满"的裁切结果判成 29.8% 留白)。

    真留白只有一个来源:缩放居中时补的纯白底 (255,255,255)。
    直接数纯白像素即可,相框的米白 (255,248,240) 与之不同,不会混淆。
    """
    white = np.all(a >= 252, axis=2)
    return float(white.mean())


def face_area(im: Image.Image) -> float:
    """人脸框面积占比,用于判断是否被裁掉太多。"""
    from backend.face import _get_app

    arr = np.array(im.convert("RGB"))
    faces = _get_app().get(arr)
    if not faces:
        return -1.0
    f = max(faces, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]))
    x1, y1, x2, y2 = [float(v) for v in f.bbox]
    return (x2 - x1) * (y2 - y1) / (arr.shape[0] * arr.shape[1])


def main() -> None:
    from backend.layouts import LAYOUTS, _smart_crop, make_collage

    # 必须用摄像头横图(1280x720)才能复现用户的留白问题。
    # 曾误用 AI 产出的 512x768 竖图 —— 竖图与高 cell 比例接近,
    # 本来就不留白,测出来"整版无变化"是选错样本,不是修复无效。
    # 用真实连拍照片(摄像头 1280x720 横图),这才能复现用户的留白场景
    srcs = sorted((ROOT / "outputs" / "9cf3cae8e18e").glob("photo_*.jpg"))[:4]
    if not srcs:
        # 现场造一张 1280x720 横图,保证能复现宽图塞高格子的场景
        from PIL import ImageDraw

        im = Image.new("RGB", (1280, 720), (200, 170, 150))
        d = ImageDraw.Draw(im)
        d.ellipse((520, 180, 760, 470), fill=(230, 190, 170))  # 假人脸
        d.rectangle((0, 600, 1280, 720), fill=(120, 100, 90))
        p = OUT / "fake_landscape_1280x720.jpg"
        im.save(p, quality=95)
        srcs = [p]

    pils = [Image.open(s).convert("RGB") for s in srcs]
    print(f"  源图 {len(pils)} 张, 尺寸 {pils[0].size}")
    if pils[0].width > pils[0].height:
        print(f"  -> 横图(宽>高),塞进高 cell 必然上下留白,这正是用户反馈的场景")
    else:
        print(f"  -> 竖图(高>宽),与 cell 比例接近,不会留白")
    print(f"  排版 2x2 -> cell 约 "
          f"{(LAYOUTS['2x2'].get('paper', (1280, 1720))[0] - 90) // 2} x "
          f"{(LAYOUTS['2x2'].get('paper', (1280, 1720))[1] - 200) // 2}\n")

    # 1) 单格对比
    cw, ch = 600, 800
    print(f"  A) 单格裁切 (cell={cw}x{ch})")
    im = pils[0]
    legacy = im.copy()
    legacy.thumbnail((cw, ch), Image.LANCZOS)
    cell_old = Image.new("RGB", (cw, ch), (255, 255, 255))
    cell_old.paste(legacy, ((cw - legacy.width) // 2, (ch - legacy.height) // 2))
    cell_old.save(OUT / "cell_legacy.jpg", quality=95)

    smart = _smart_crop(im, cw, ch, (0.5, 0.42))
    smart.save(OUT / "cell_smart.jpg", quality=95)

    b_old = blank_ratio(np.array(cell_old))
    b_new = blank_ratio(np.array(smart))
    print(f"      旧(缩放居中) 留白率 = {b_old * 100:5.1f}%  实际图像 "
          f"{legacy.size[0]}x{legacy.size[1]} 居中于 {cw}x{ch}")
    print(f"      新(cover 裁切) 留白率 = {b_new * 100:5.1f}%  实际图像 "
          f"{smart.size[0]}x{smart.size[1]} 铺满")
    check("智能裁切消除留白", b_new < 0.01, f"{b_old * 100:.1f}% -> {b_new * 100:.1f}%")
    check("输出尺寸精确等于 cell", smart.size == (cw, ch), f"{smart.size}")

    # 2) 人脸完整性:必须用真实照片测,合成图检不出人脸
    print(f"\n  B) 人脸完整性(裁切不能把脸切掉)")
    real = srcs
    if real:
        rim = Image.open(real[0]).convert("RGB")
        rsmart = _smart_crop(rim, cw, ch, None)
        rsmart.save(OUT / "cell_real_smart.jpg", quality=95)
        a_full = face_area(rim)
        a_smart = face_area(rsmart)
        # 人脸焦点裁切:用检测到的 bbox 当焦点
        from backend.layouts import _face_focus

        f = _face_focus(rim)
        rfocus = _smart_crop(rim, cw, ch, f)
        rfocus.save(OUT / "cell_real_facefocus.jpg", quality=95)
        a_focus = face_area(rfocus)
        print(f"      原图 {rim.size} 人脸占比 = {a_full * 100:.2f}%")
        print(f"      几何裁切后 = {a_smart * 100:.2f}%   "
              f"人脸焦点裁切后 = {a_focus * 100:.2f}%  (focus={f})")
        check("裁切后仍能检出人脸", a_smart > 0 and a_focus > 0)
        # cover 裁切会放大脸部(裁掉背景),面积变大正常;变小才说明脸被切
        check("几何裁切未切掉人脸", a_full <= 0 or a_smart >= a_full * 0.9,
              f"{a_full * 100:.2f}% -> {a_smart * 100:.2f}%")
        check("人脸焦点裁切未切掉人脸", a_full <= 0 or a_focus >= a_full * 0.9,
              f"{a_full * 100:.2f}% -> {a_focus * 100:.2f}%")
    else:
        print("      跳过:找不到真实照片")

    # 3) 全拼图对照
    # 注意:整版画布本身含相框米白与外边距,整体纯白占比低、不敏感。
    # 真正要量的是每个 cell 内部的留白,所以这里按 cell 区域裁出来量。
    print(f"\n  C) 整版拼图对照(量每个 cell 内部留白)")
    # 用 none 相框:plain_white 相框本身就是纯白边框,会污染留白统计
    os.environ["BIGHEAD_SMART_CROP"] = "0"
    old = make_collage(pils, layout="2x2", frame="none")
    old.save(OUT / "collage_legacy.jpg", quality=92)
    os.environ["BIGHEAD_SMART_CROP"] = "1"
    new = make_collage(pils, layout="2x2", frame="none")
    new.save(OUT / "collage_smart.jpg", quality=92)

    def cell_blank_ratio(paper: Image.Image) -> float:
        """按 2x2 布局切出四个 cell,量 cell 内的纯白占比均值。

        cell 尺寸由 make_collage 内部按"加框后的实际尺寸"算,
        这里按同样的规则反推:margin=30,fw/fh 为 cell 实际宽高。
        """
        w, h = paper.size
        margin = 30
        # 反推 fw/fh:paper_w = margin*2 + cols*fw + margin*(cols-1)
        fw = (w - margin * 3) // 2
        fh = (h - margin * 3 - 80) // 2
        vals = []
        for r in range(2):
            for c in range(2):
                x = margin + c * (fw + margin)
                y = margin + r * (fh + margin)
                if x + fw > w or y + fh > h:
                    continue
                vals.append(blank_ratio(np.array(paper.crop((x, y, x + fw, y + fh)))))
        return float(np.mean(vals)) if vals else 1.0

    bo = cell_blank_ratio(old)
    bn = cell_blank_ratio(new)
    print(f"      cell 内留白率: 旧 {bo * 100:.1f}% -> 新 {bn * 100:.1f}%")
    check("cell 内留白显著减少", bn < bo * 0.2, f"{bo * 100:.1f}% -> {bn * 100:.1f}%")
    print(f"      对照图: {OUT / 'collage_legacy.jpg'} vs {OUT / 'collage_smart.jpg'}")

    print(f"\n  PASS={len(PASS)} FAIL={len(FAIL)}")
    if FAIL:
        print("  失败: " + ", ".join(FAIL))
    print("=" * 74)
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
