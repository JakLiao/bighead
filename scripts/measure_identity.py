"""度量一组生成图的身份保持(按人配对)。

**为什么必须按人配对**: 旧口径是「原图最大脸 vs 生成图最大脸」。双人合照
下这会**比错人** —— 原图里脸大的是 A, 生成图里模型可能把 B 画得更大,
于是拿两个人的 embedding 互比, 得出 0.10 这种无意义的数字。
正确口径是「原图每张脸, 在生成图里找最像的那张」, 再取均值。

阈值 0.55 来自 Task 3 的单人特写基线。**多人合照时这个阈值偏严**:
实测同一批已确认是本人的输出, 单人配对 0.89、多人配对 0.94;
且合照输入下 InsightFace 会漏检(检不到就少一人, 均值失真)。

用法:
  <webui python> scripts/measure_identity.py <原图> <生成图...>
  <webui python> scripts/measure_identity.py -d outputs/_style_v2   # 按目录名
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))

from backend.face import _get_app  # noqa: E402

THRESHOLD = 0.55


def faces(app, im: Image.Image) -> list[dict]:
    out = []
    for f in app.get(np.array(im.convert("RGB"))) or []:
        x1, y1, x2, y2 = [float(v) for v in f.bbox]
        if x2 - x1 < 8 or y2 - y1 < 8:
            continue
        out.append({"w": x2 - x1, "emb": f.normed_embedding.astype(np.float32)})
    out.sort(key=lambda d: -d["w"])
    return out


def measure(app, src_path: Path, gen_path: Path) -> tuple[str, str]:
    src = faces(app, Image.open(src_path))
    if not src:
        return "原图检不到人脸", ""
    gen = faces(app, Image.open(gen_path))
    if not gen:
        return "检不到脸", "严重改形"
    best = [max(float(sd["emb"] @ gd["emb"]) for gd in gen) for sd in src]
    mean = float(np.mean(best))
    mark = "PASS" if mean >= THRESHOLD else "LOW"
    note = "" if len(gen) >= len(src) else f"  (检出 {len(gen)}/{len(src)})"
    return (f"mean={mean:.4f} worst={min(best):.4f} [{mark}]",
            f"各人={[round(c, 3) for c in best]}{note}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="原图路径")
    ap.add_argument("gen", nargs="*", help="生成图路径(可多个)")
    ap.add_argument("-d", "--dir", help="生成图目录(取其下子目录里的 out.jpg)")
    ap.add_argument("--name", default="out.jpg")
    a = ap.parse_args()

    src = Path(a.src)
    if not src.exists():
        print(f"找不到原图: {src}")
        return 1

    gens: list[Path] = [Path(g) for g in a.gen]
    if a.dir:
        d = Path(a.dir)
        gens += sorted(p for p in d.glob(f"*/{a.name}"))
    if not gens:
        print("没指定生成图")
        return 1

    app = _get_app()
    n = len(faces(app, Image.open(src)))
    print(f"原图 {src.name} 检出 {n} 张脸")
    print(f"阈值 配对余弦 >= {THRESHOLD}\n" + "=" * 66)
    for g in gens:
        if not g.exists():
            print(f"{g.parent.name:<20} (缺文件)")
            continue
        res, note = measure(app, src, g)
        print(f"{g.parent.name:<20} {res}  {note}")
    print("=" * 66)
    return 0


if __name__ == "__main__":
    sys.exit(main())
