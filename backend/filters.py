"""实时复古滤镜(纯 OpenCV,毫秒级)."""
from __future__ import annotations

import io

import cv2
import numpy as np
from PIL import Image, ImageOps

from .config import FILTERS


def _pil_to_bgr(pil: Image.Image) -> np.ndarray:
    rgb = np.array(pil.convert("RGB"))
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def _bgr_to_pil(bgr: np.ndarray) -> Image.Image:
    return Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))


def _warmth(bgr: np.ndarray, amount: float) -> np.ndarray:
    """amount > 0 加暖(偏黄),< 0 加冷."""
    if amount == 0:
        return bgr
    b, g, r = cv2.split(bgr.astype(np.float32))
    r = np.clip(r + 255 * amount * 0.15, 0, 255)
    b = np.clip(b - 255 * amount * 0.15, 0, 255)
    return cv2.merge([b, g, r]).astype(np.uint8)


def _fade(bgr: np.ndarray, amount: float) -> np.ndarray:
    """amount 0..1, 越大越淡(高光下压、阴影上提)."""
    if amount <= 0:
        return bgr
    white = np.full_like(bgr, 255, dtype=np.uint8)
    return cv2.addWeighted(bgr, 1 - amount, white, amount, 0)


def _grain(bgr: np.ndarray, sigma: float) -> np.ndarray:
    if sigma <= 0:
        return bgr
    noise = np.random.normal(0, sigma, bgr.shape).astype(np.float32)
    out = cv2.convertScaleAbs(bgr.astype(np.float32) + noise)
    return out


def _vignette(bgr: np.ndarray, strength: float) -> np.ndarray:
    if strength <= 0:
        return bgr
    h, w = bgr.shape[:2]
    y, x = np.ogrid[:h, :w]
    cy, cx = h / 2, w / 2
    dist = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / np.sqrt(cx**2 + cy**2)
    mask = np.clip(1 - dist * strength, 0.4, 1.0).astype(np.float32)
    out = (bgr.astype(np.float32) * mask[..., None]).clip(0, 255).astype(np.uint8)
    return out


def _bw(bgr: np.ndarray, contrast: float) -> np.ndarray:
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    if contrast != 1.0:
        g = cv2.convertScaleAbs(g, alpha=contrast, beta=0)
    return cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)


def _vhs(bgr: np.ndarray, shift: int) -> np.ndarray:
    """RGB 通道错位 + 扫描线."""
    b, g, r = cv2.split(bgr)
    r = np.roll(r, shift, axis=1)
    b = np.roll(b, -shift, axis=1)
    out = cv2.merge([b, g, r])
    h = out.shape[0]
    for y in range(0, h, 2):
        out[y] = (out[y].astype(np.float32) * 0.85).astype(np.uint8)
    return out


def apply_filter(pil: Image.Image, preset: str = "faded_90s") -> Image.Image:
    """对一张 PIL 图应用指定滤镜预设."""
    if preset == "none" or preset not in FILTERS:
        return pil
    p = FILTERS[preset]["params"]
    bgr = _pil_to_bgr(pil)

    if p.get("bw"):
        bgr = _bw(bgr, p.get("contrast", 1.1))
    elif p.get("vhs"):
        bgr = _vhs(bgr, p.get("shift", 4))
    else:
        bgr = _warmth(bgr, p.get("warmth", 0.0))
        bgr = _fade(bgr, p.get("fade", 0.0))

    bgr = _grain(bgr, p.get("grain", 0))
    bgr = _vignette(bgr, p.get("vignette", 0.0))
    return _bgr_to_pil(bgr)


def apply_filter_bytes(data: bytes, preset: str) -> bytes:
    pil = Image.open(io.BytesIO(data))
    out = apply_filter(pil, preset)
    buf = io.BytesIO()
    out.save(buf, format="JPEG", quality=92)
    return buf.getvalue()
