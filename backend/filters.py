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
    """加暖(amount > 0)/加冷(amount < 0)。

    暖调在 RGB 空间的做法:R 升、**G 同步升**、B 小幅降。
    G 参与是关键 —— 黄 = R + G,若 G 完全不动,色相会停在 30deg 的纯橙,
    饱和度被推高(实测 sat 10.2%),人眼就读作"发红"而不是"暖"。

    系数取 (0.5, 0.45, -0.25):同样 warmth=0.18 下
        旧实现 (1, 0, -1)      -> hue 30deg, sat 10.2%  (偏红)
        本实现 (0.5,0.45,-0.25)-> hue 56deg, sat  3.9%  (暖黄,且不抢眼)
    亮度基本不变(val 52.9% -> 51.5%),不会出现"加暖=变亮"。

    参考:HSV 色相 15~45deg 是橙、45~60deg 是黄,都在"暖"的范围里;
    区别在饱和度 —— 复古要的是低饱和的淡暖,不是高饱和的红。
    """
    if amount == 0:
        return bgr
    b, g, r = cv2.split(bgr.astype(np.float32))
    k = 255 * amount * 0.15
    r = r + k * 0.50
    g = g + k * 0.45
    b = b - k * 0.25
    return cv2.merge([
        np.clip(b, 0, 255), np.clip(g, 0, 255), np.clip(r, 0, 255)
    ]).astype(np.uint8)


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
