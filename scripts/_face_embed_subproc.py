"""在 SDXL 环境里跑,输出图片的人脸 embedding(cos 相似度用)。

为什么不放在 .venv-qwen 里:insightface 2.0 硬依赖 CPU 版 onnxruntime,
与 onnxruntime-gpu 互斥,会让 pip 报 ResolutionImpossible。而 Qwen 环境的
生成链路根本不需要人脸检测,只在验证时借用一下 —— 所以用子进程隔离。

用法:
    python _face_embed_subproc.py <img1> <img2> ...
    输出: 每行 "<路径> <cos_via_self>" 不可用则输出 NONE
若要两两比对,直接传多张,本脚本会算相邻/全部两两余弦并打印。

输出格式(每行一个 key=value,便于父进程解析):
    EMB <path>=<512 floats, 空格分隔>
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main() -> int:
    paths = sys.argv[1:]
    if not paths:
        print("no input", file=sys.stderr)
        return 1
    from backend.face import _get_app
    app = _get_app()
    for p in paths:
        try:
            img = np.array(Image.open(p).convert("RGB"))
            fs = app.get(img)
            if not fs:
                print(f"EMB {p}=NONE")
                continue
            f = max(fs, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]))
            v = f.normed_embedding.astype(np.float32)
            print(f"EMB {p}=" + " ".join(f"{x:.6f}" for x in v))
        except Exception as e:
            print(f"EMB {p}=ERR:{type(e).__name__}:{e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
