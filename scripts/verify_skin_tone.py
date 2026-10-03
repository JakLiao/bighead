"""验证偏红修复 —— 只测人脸区域,用 InsightFace 定位,不用颜色猜。

前一版用"RGB 关系"近似肤色掩膜,结果把暖色墙面、木质家具、
暖色灯光全算成肤色(原图被测出 R-B=+29.8,而全图只有 +3.5),
等于在测噪声。

本版改用 InsightFace 的 5 点关键点定位脸颊矩形区域 ——
那才是真正的人脸皮肤。这样测出来的 R-B 才对应用户
看到的"脸色发红"。
"""
from __future__ import annotations

import colorsys
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend" / "vendor"))

import backend.config as cfg  # noqa: E402

import numpy as np  # noqa: E402
import torch  # noqa: E402
from PIL import Image  # noqa: E402

SEED = 20240517
OUT = ROOT / "outputs" / "_verify" / "color" / "fixed"
OUT.mkdir(parents=True, exist_ok=True)
PASS: list[str] = []
FAIL: list[str] = []

# InsightFace 5 点关键点顺序:左眼 右眼 鼻  左嘴角 右嘴角
# 脸颊区域取"眼睛下缘到嘴角上方"的矩形,故意避开嘴唇(最红)与眼睛(高对比),
# 只测用户实际会盯着看的"脸色"。


def face_skin(a: np.ndarray, kps: np.ndarray, grow: float = 1.0) -> np.ndarray:
    """按关键点构造脸颊区域掩膜(只取皮肤,避开嘴唇/眼睛/头发)。"""
    h, w = a.shape[:2]
    le, re_, _nose, lm, rm = [np.array(p, dtype=np.float32) for p in kps[:5]]
    eye_y = (le[1] + re_[1]) / 2
    mouth_y = (lm[1] + rm[1]) / 2
    cx = (lm[0] + rm[0]) / 2
    half_w = (rm[0] - lm[0]) / 2 * grow
    # 脸颊垂直范围:眼睛下缘 到 嘴角上方(避开嘴唇)
    y0 = int(eye_y + (mouth_y - eye_y) * 0.25)
    y1 = int(eye_y + (mouth_y - eye_y) * 0.80)
    x0 = int(max(cx - half_w, 0))
    x1 = int(min(cx + half_w, w - 1))
    if y1 <= y0 or x1 <= x0:
        return np.zeros((h, w), dtype=bool)
    m = np.zeros((h, w), dtype=bool)
    m[y0:y1, x0:x1] = True
    return m


def analyze(tag: str, path_or_arr) -> tuple[float, float, int]:
    if isinstance(path_or_arr, (str, Path)):
        pil = Image.open(path_or_arr).convert("RGB")
    else:
        pil = path_or_arr
    a = np.array(pil).astype(np.float32)
    from backend.face import _get_app

    faces = _get_app().get(a.astype(np.uint8))
    if not faces:
        print(f"    {tag:<26} 检不到人脸,跳过")
        return 0.0, 0.0, 0
    f = max(faces, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]))
    m = face_skin(a, f.kps)
    n = int(m.sum())
    if n < 200:
        print(f"    {tag:<26} 脸颊区域太小({n}px),跳过")
        return 0.0, 0.0, n
    px = a[m]
    r, g, b = float(px[:, 0].mean()), float(px[:, 1].mean()), float(px[:, 2].mean())
    h, s, _ = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    print(f"    {tag:<26} 脸颊 {n:6d}px  R={r:5.1f} G={g:5.1f} B={b:5.1f}  "
          f"R-B={r - b:+6.1f}  hue={h * 360:5.1f}deg sat={s * 100:4.1f}%")
    return r - b, h * 360, n


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"      [{'PASS' if cond else 'FAIL'}] {name} {detail}")


def main() -> None:
    from backend.filters import apply_filter
    from backend.pipeline import BigHeadPipeline
    from backend.face import extract_face

    src = sorted((ROOT / "outputs" / "4f6963daf4d5").glob("photo_*.jpg"))[0]
    fr = extract_face(Image.open(src).convert("RGB"))

    print("  A) 复古滤镜(修复后)—— 只测脸颊\n")
    base_rb, _, _ = analyze("原图(基准)", src)
    filter_rb = {}
    for key in ("faded_90s", "warm_kodak", "polaroid", "vintage_korean"):
        out = apply_filter(Image.open(src).convert("RGB"), key)
        p = OUT / f"filter_{key}.jpg"
        out.save(p, quality=95)
        rb, hue, _ = analyze(f"FILTERS[{key}]", p)
        filter_rb[key] = (rb, hue)

    print(f"\n  B) AI 生成(修复后,固定 seed={SEED})")
    pipe = BigHeadPipeline()
    pipe._ensure_loaded("sdxl")
    gen_rb = {}
    for style in cfg.STYLES:
        img = pipe.generate_one(fr.face_pil, cfg.STYLES[style], backbone="sdxl",
                                faceid_embeds=fr.embedding, seed=SEED)
        path = OUT / f"{style}.jpg"
        img.save(path, quality=95)
        rb, hue, _ = analyze(style, path)
        gen_rb[style] = (rb, hue)

    print(f"\n  C) 判读")
    print(f"     原图脸颊 R-B={base_rb:+.1f} 作为基准;"
          f"亚洲人脸颊本身 R-B 通常在 25~40,不必压到 0")
    print(f"\n     滤镜(应与原图接近,不能大幅抬高 R-B):")
    for k, (rb, hue) in filter_rb.items():
        check(f"{k} 未把肤色推红", rb - base_rb < 12,
              f"Δ(R-B)={rb - base_rb:+.1f} hue={hue:.0f}deg")

    print(f"\n     AI 生成(修复前 PORTRAIT_HK 全图 R-B=+34.7,脸颊更高):")
    for k, (rb, hue) in gen_rb.items():
        check(f"{k} 肤色未过红", rb < 55, f"R-B={rb:+.1f} hue={hue:.0f}deg")

    print(f"\n  峰值显存 = {torch.cuda.max_memory_allocated() / 1e9:.2f}GB")
    print(f"  PASS={len(PASS)} FAIL={len(FAIL)}")
    if FAIL:
        print("  失败: " + ", ".join(FAIL))
    print("=" * 74)
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
