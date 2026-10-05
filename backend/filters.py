"""实时复古滤镜(纯 OpenCV,毫秒级)."""
from __future__ import annotations

import io
from functools import lru_cache

import cv2
import numpy as np
from PIL import Image

from .config import ERA_DEFAULT, FILTERS


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
    # 之前 np.full_like 每次分配一整张全白图再交给 addWeighted 做加权。
    # 这里改成把常量项折进 addWeighted 的 offset(第 5 个参数 beta):
    #   dst = src*alpha + 255*amount
    # 免掉那张全白临时图。
    return cv2.addWeighted(bgr, 1 - amount, bgr, 0.0, 255 * amount)


def _grain(bgr: np.ndarray, sigma: float) -> np.ndarray:
    if sigma <= 0:
        return bgr
    # cv2.randn(dst, mean, stddev) 是**原地填充**, 直接写进预分配的 float32
    # 缓冲。原实现 np.random.normal(0, sigma, shape).astype(np.float32) 先落一张
    # 全尺寸 float64(1280x960x3 约 29MB)再转 float32, 峰值内存翻倍且多一次
    # 全图转换; 现在除结果本身外不额外占内存。
    noise = np.empty(bgr.shape, dtype=np.float32)
    cv2.randn(noise, 0.0, sigma)
    return cv2.convertScaleAbs(bgr.astype(np.float32) + noise)


@lru_cache(maxsize=8)
def _vignette_mask(h: int, w: int, strength: float) -> np.ndarray:
    """按 (h, w, strength) 缓存暗角掩码。

    预设是静态的, 连拍/拼图时同一尺寸会反复调用 —— 之前的实现每次都重算
    ogrid + sqrt 的全分辨率距离场, 纯属重复劳动。返回的数组只读, 调用方
    不得修改。
    """
    y, x = np.ogrid[:h, :w]
    cy, cx = h / 2, w / 2
    dist = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / np.sqrt(cx**2 + cy**2)
    return np.clip(1 - dist * strength, 0.4, 1.0).astype(np.float32)


def _vignette(bgr: np.ndarray, strength: float) -> np.ndarray:
    if strength <= 0:
        return bgr
    h, w = bgr.shape[:2]
    mask = _vignette_mask(h, w, float(strength))
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
    # 扫描线: 原来对 y=0,2,4... 逐行做一次 astype+乘法(每行一次 Python 往返,
    # 1080 行就是 540 次)。改成对切片整体做一次乘法, 视觉结果完全一致。
    out[::2] = (out[::2].astype(np.float32) * 0.85).astype(np.uint8)
    return out


def _era_modern_pixels(bgr: np.ndarray) -> np.ndarray:
    """modern 是恒等函数: 不动任何像素.

    刻意保留成一个显式的空操作, 而不是让调用方写 `if era != "modern"` ——
    这样 apply_filter 里era 的调用路径恒定, 新增 era 时不必回头改所有分支。
    """
    return bgr


def _era_vintage_2000_pixels(bgr: np.ndarray) -> np.ndarray:
    """古早画质: 复刻 2000 年 CCD 大头贴机的视觉特征.

    三步顺序执行, 后一步覆盖前一步:
      1. 下采到 ~480p 再用最近邻上采回原尺寸 —— CCD 时代的低分辨率观感,
         皮肤细节在此过程中被自然平滑(这是"糊"得对的关键, 不是加模糊)。
      2. 顶部 1/4 加暖色漏光 —— 模拟机器内置闪光灯打在顶部的暖光溢出。
      3. posterize(每通道清掉最低位) —— 模拟浅色阶的断层。

    注意: 目标短边用 min(h, w) 推算而不是写死 640x480, 因为 layout 出来的
    成片尺寸不固定(6寸相纸是 1500x1000), 写死会把非 4:3 的图拉变形。
    """
    h, w = bgr.shape[:2]
    short = min(h, w)
    scale = 480 / short
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    small = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_AREA)
    out = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)

    # 顶部 1/4 暖色漏光: R +30, G +10, B 不动。用 int16 累加避免 uint8 溢出回绕。
    band = out[: max(1, h // 4), :, :].astype(np.int16)
    band[..., 2] += 30  # R in BGR
    band[..., 1] += 10  # G
    out[: max(1, h // 4), :, :] = np.clip(band, 0, 255).astype(np.uint8)

    # posterize: 清掉每通道最低位 -> 相邻灰阶坍缩, 出现色阶断层
    return (out >> 1) << 1


# era key -> 像素算子。新增 era 时只改这张表, 调用方无需改动。
ERA_OPS = {
    "modern": _era_modern_pixels,
    "vintage_2000": _era_vintage_2000_pixels,
}


def _apply_era(bgr: np.ndarray, era: str) -> np.ndarray:
    """按 era 名取算子并作用。未知 era 交给调用方校验, 这里只做兜底。"""
    op = ERA_OPS.get(era)
    if op is None:
        return bgr
    return op(bgr)


def apply_filter(
    pil: Image.Image, preset: str = "faded_90s", era: str = ERA_DEFAULT
) -> Image.Image:
    """对一张 PIL 图应用指定滤镜预设 + 年代处理.

    era 串在**所有**滤镜算子之后, 语义是"成片再过一层年代处理",
    因此 preset 与 era 互不干扰(两者叠加 != 只跑其中一个)。

    `preset="none"` 时也要走 era: "不选滤镜、只要古早画质"是合法组合,
    此时只跑 era 算子。
    """
    # 恒等短路: 两者都是 modern/none 时原样返回, 省掉一次 RGB<->BGR 转换
    # (1280x960 全图往返约 10ms, 连拍 4 张就是 40ms, 不该白花)。
    no_filter = preset == "none" or preset not in FILTERS
    if no_filter and era == ERA_DEFAULT:
        return pil

    bgr = _pil_to_bgr(pil)
    if not no_filter:
        p = FILTERS[preset]["params"]
        if p.get("bw"):
            bgr = _bw(bgr, p.get("contrast", 1.1))
        elif p.get("vhs"):
            bgr = _vhs(bgr, p.get("shift", 4))
        else:
            bgr = _warmth(bgr, p.get("warmth", 0.0))
            bgr = _fade(bgr, p.get("fade", 0.0))

        bgr = _grain(bgr, p.get("grain", 0))
        bgr = _vignette(bgr, p.get("vignette", 0.0))

    return _bgr_to_pil(_apply_era(bgr, era))


def apply_filter_bytes(data: bytes, preset: str, era: str = ERA_DEFAULT) -> bytes:
    pil = Image.open(io.BytesIO(data))
    out = apply_filter(pil, preset, era=era)
    buf = io.BytesIO()
    out.save(buf, format="JPEG", quality=92)
    return buf.getvalue()
