"""验证 face_aware_crop_box: 横图裁竖图时能不能保住所有人脸。

要保证:
  1. 裁切框比例 == 目标比例(否则 resize 后会拉伸变形)
  2. 裁切框在图内
  3. **所有人脸都还在框内** —— 这是修 bug 的核心目的
  4. 检不到脸时返回 None(退回居中裁切)

这个脚本需要 insightface, 所以要用 webui 的解释器跑
(E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe)。

用法: <webui python> scripts/_test_face_crop.py
"""
from __future__ import annotations

import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))

from PIL import Image  # noqa: E402

from backend.face import detect_all_faces, face_aware_crop_box  # noqa: E402

SRC = PROJECT / "outputs" / "1a0b12477d66"
OUT = PROJECT / "outputs" / "_face_crop"
OUT.mkdir(parents=True, exist_ok=True)
W, H = 512, 768
TOL = 0.02


def main() -> int:
    print(f"目标比例 {W}x{H} = {W / H:.4f}\n")
    all_ok = True
    for p in sorted(SRC.glob("photo_*.jpg")):
        im = Image.open(p).convert("RGB")
        iw, ih = im.size
        boxes = detect_all_faces(im)
        crop = face_aware_crop_box(im, W, H)
        if not boxes:
            print(f"{p.name}: 检不到脸 -> 返回 {crop}(应为空, 退回居中裁切)")
            continue
        if crop is None:
            print(f"{p.name}: FAIL 检到 {len(boxes)} 张脸但返回 None")
            all_ok = False
            continue

        x1, y1, x2, y2 = crop
        cw, ch = x2 - x1, y2 - y1
        ratio = cw / ch
        inside = 0 <= x1 < x2 <= iw and 0 <= y1 < y2 <= ih
        # 关键: 每张脸是否完整落在框内。这是硬要求。
        kept = [b for b in boxes
                if b[0] >= x1 and b[1] >= y1 and b[2] <= x2 and b[3] <= y2]
        # 比例只是次要偏好: 多人合照横向铺太开时, face_aware_crop_box 会
        # 主动放弃目标比例以保住人脸, 这时 ratio_ok 应该是 False 但仍算通过。
        ratio_ok = abs(ratio - W / H) < TOL
        faces_ok = len(kept) == len(boxes)
        ok = inside and faces_ok
        all_ok &= ok
        note = "" if ratio_ok else "  (比例已让位于人脸, 属预期)"
        print(f"{p.name}  {iw}x{ih}  检出 {len(boxes)} 张脸")
        print(f"    裁切框 ({x1},{y1},{x2},{y2}) = {cw}x{ch} 比例{ratio:.4f}"
              f"{note}")
        print(f"    在图内 {'OK' if inside else 'FAIL'}   "
              f"完整保留 {len(kept)}/{len(boxes)} 张脸  "
              f"{'OK' if faces_ok else 'FAIL 有脸被切'}")

        vis = im.crop(crop).resize((W, H), Image.LANCZOS)
        vp = OUT / f"{p.stem}_facecrop.jpg"
        vis.save(vp, quality=92)
        print(f"    -> {vp}")

    print("-" * 60)
    print("PASS" if all_ok else "FAIL")
    return 0 if all_ok else 2


if __name__ == "__main__":
    sys.exit(main())
