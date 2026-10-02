"""InsightFace 人脸检测与提取(单例懒加载)."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image

from .config import INSIGHTFACE_ROOT

_app = None


def _get_app():
    global _app
    if _app is None:
        from insightface.app import FaceAnalysis

        _app = FaceAnalysis(
            name="buffalo_l",
            root=str(INSIGHTFACE_ROOT),
            providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        try:
            _app.prepare(ctx_id=0, det_size=(640, 640))
        except Exception:
            _app.prepare(ctx_id=-1, det_size=(640, 640))
    return _app


@dataclass
class FaceResult:
    face_pil: Image.Image | None
    bbox: tuple[int, int, int, int] | None
    score: float
    no_face: bool
    embedding: "np.ndarray | None" = None


def extract_face(pil: Image.Image, target_size: int = 512) -> FaceResult:
    """检测最大人脸,裁剪为正方形 PIL,并返回 512 维归一化人脸向量."""
    img = np.array(pil.convert("RGB"))
    app = _get_app()
    faces = app.get(img)
    if not faces:
        return FaceResult(face_pil=None, bbox=None, score=0.0, no_face=True)

    face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    x1, y1, x2, y2 = [int(v) for v in face.bbox]
    h, w = img.shape[:2]
    x1 = max(0, x1); y1 = max(0, y1); x2 = min(w, x2); y2 = min(h, y2)

    # 扩一点边距
    side = max(x2 - x1, y2 - y1)
    cx = (x1 + x2) // 2
    cy = (y1 + y2) // 2
    half = side // 2 + int(side * 0.15)
    x1 = max(0, cx - half); y1 = max(0, cy - half)
    x2 = min(w, cx + half); y2 = min(h, cy + half)
    side = min(x2 - x1, y2 - y1)
    x2 = x1 + side; y2 = y1 + side

    crop = img[y1:y2, x1:x2]
    face_pil = Image.fromarray(crop).resize((target_size, target_size), Image.LANCZOS)
    emb = getattr(face, "normed_embedding", None)
    embedding = None
    if emb is not None:
        embedding = emb.reshape(1, -1).astype(np.float32)
    return FaceResult(
        face_pil=face_pil,
        bbox=(x1, y1, x2, y2),
        score=float(face.det_score),
        no_face=False,
        embedding=embedding,
    )
