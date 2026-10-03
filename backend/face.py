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


def detect_all_faces(pil: Image.Image) -> list[tuple[int, int, int, int]]:
    """返回画面里**所有人脸**的 bbox(整数坐标, 已裁到图内)。

    为什么和 extract_face 分开: extract_face 只返回最大那张脸, 是给
    SDXL 路线裁正方形人脸用的。Qwen 路线需要的是「所有人脸都在哪」——
    用来决定横图裁成竖图时该以哪里为中心, 避免把人脸切掉(大头贴场景
    经常是多人合照, 居中裁会把边缘的人劈成半张脸)。

    检不到脸时返回空列表, 由调用方退回居中裁切。
    """
    img = np.array(pil.convert("RGB"))
    h, w = img.shape[:2]
    try:
        faces = _get_app().get(img)
    except Exception:
        return []
    out: list[tuple[int, int, int, int]] = []
    for f in faces or []:
        x1, y1, x2, y2 = [int(v) for v in f.bbox]
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w, x2), min(h, y2)
        if x2 - x1 >= 8 and y2 - y1 >= 8:
            out.append((x1, y1, x2, y2))
    return out


def face_aware_crop_box(
    pil: Image.Image,
    out_w: int,
    out_h: int,
    margin: float = 0.35,
) -> tuple[int, int, int, int] | None:
    """算出裁切框, 优先保证**所有人脸都完整保留**。

    两种情况, 按优先级:
      A. 人脸(含余量)能装进 out_w:out_h 的窗口 -> 用该窗口裁切。画质最好,
         没有多余边。
      B. 装不进(多人合照横向铺得太开) -> 退化为「按人脸并集的完整范围
         裁切, 比例交给 worker 的 resize 去微调」。**宁可比例略有偏差,
         也不能切掉人脸** —— 这是这个函数存在的唯一理由。

    曾经的 bug: 情况 B 里我按 out_w:out_h 强行取窗口再平移, 结果
    实测 photo_2/3/4 各有 2 张脸横向分开, 窗口只装得下 0 张 ——
    等于把「切掉边缘的人」换成了「切掉所有的人」, 更糟。
    教训: 裁切框的首要约束是内容, 比例只是次要偏好。

    返回 None 表示没检到脸, 调用方应退回居中裁切。
    """
    boxes = detect_all_faces(pil)
    if not boxes:
        return None
    iw, ih = pil.size
    x1 = min(b[0] for b in boxes)
    y1 = min(b[1] for b in boxes)
    x2 = max(b[2] for b in boxes)
    y2 = max(b[3] for b in boxes)
    fw, fh = x2 - x1, y2 - y1
    # 左右各多留一点, 上下多留一点(顶部要给头发留空间)
    mx = int(fw * margin)
    my = int(fh * margin * 1.6)
    x1, x2 = max(0, x1 - mx), min(iw, x2 + mx)
    y1, y2 = max(0, y1 - my), min(ih, y2 + my)
    fw, fh = x2 - x1, y2 - y1

    ratio = out_w / out_h
    # 三种情况, 优先级从高到低:
    #   A  人脸范围能装进目标比例的窗口 -> 用它, 无留边, 画质最好
    #   B  横向太宽装不下 -> 保持目标比例, 按高度撑满, 宽度方向留边
    #   C  连高度都不够(图比目标还矮) -> 用人脸并集全高, 靠留边补
    # B/C 都是「留边」结局, 但**必须保持目标比例**, 否则 _fit_exact 会
    # 非等比拉伸(实测那会造成 2.42x 纵横失真, 是之前「不像本人」的主因)。
    need_w, need_h = fw, fw / ratio
    if need_h <= fh:
        cw, ch = float(need_w), float(need_h)
    elif fh / ratio <= float(iw):
        # B: 高度足够撑出目标比例, 宽度不够就左右留边
        cw = min(float(iw), float(iw))
        ch = min(float(ih), float(iw) / ratio)
    else:
        cw, ch = float(fw), float(fh)

    # 平移窗口到图内, 尽量以人脸并集中心为锚
    cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
    # clamp 时若窗口比图还大, 先把窗口收缩到图内尺寸
    cw = min(cw, float(iw))
    ch = min(ch, float(ih))
    left = max(0, min(int(round(cx - cw / 2)), iw - int(cw)))
    top = max(0, min(int(round(cy - ch / 2)), ih - int(ch)))
    right = left + int(cw)
    bottom = top + int(ch)

    # 最后一道保险: 若仍有脸被窗口切到, 就把窗口往该方向扩出去。
    # 之所以需要这一步: 上面按「人脸并集 + 余量」估算, 但并集是各脸 bbox 的
    # 包围盒, 遇到斜侧的人脸时 bbox 的角会落在包围盒外, 仍可能贴边被切
    # (实测 photo_3 头顶被切)。这里直接用「窗口 vs 每张脸」的相交判断,
    # 比估算可靠。
    #
    # 注意: 这里允许**打破目标比例**。因为 _fit_exact 已经是「等比缩放 +
    # 留边」, 任何比例的框都不会再被拉伸变形(那正是之前 2.42x 失真的
    # 根因, 已修)。所以这里可以放心地为「不切脸」让位。
    for _ in range(4):
        need_l = need_t = need_r = need_b = 0
        for bx1, by1, bx2, by2 in boxes:
            if bx1 < left:
                need_l = max(need_l, left - bx1)
            if by1 < top:
                need_t = max(need_t, top - by1)
            if bx2 > right:
                need_r = max(need_r, bx2 - right)
            if by2 > bottom:
                need_b = max(need_b, by2 - bottom)
        if not (need_l or need_t or need_r or need_b):
            break
        left = max(0, left - need_l)
        top = max(0, top - need_t)
        right = min(iw, right + need_r)
        bottom = min(ih, bottom + need_b)
        if (left, top, right, bottom) == (0, 0, iw, ih):
            break

    return left, top, right, bottom


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
