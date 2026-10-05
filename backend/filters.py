"""实时复古滤镜(纯 OpenCV,毫秒级)."""
from __future__ import annotations

import io
from functools import lru_cache

import cv2
import numpy as np
from PIL import Image

from .config import ERA_DEFAULT, ERA_PRESETS, FILTERS


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


def _era_modern_pixels(bgr: np.ndarray, params: dict) -> np.ndarray:
    """modern 是恒等函数: 不动任何像素.

    刻意保留成一个显式的空操作, 而不是让调用方写 `if era != "modern"` ——
    这样 apply_filter 里 era 的调用路径恒定, 新增 era 时不必回头改所有分支。

    `params` 收下但不用: modern 的可调空间就是"什么都不做", 没有参数可调。
    签名仍与其它算子一致, 是为了让 ERA_OPS 里的算子可以被同一种方式调用。
    """
    return bgr


def _era_vintage_2000_pixels(bgr: np.ndarray, params: dict) -> np.ndarray:
    """古早画质: 复刻 2000 年 CCD 大头贴机的视觉特征.

    三步顺序执行, 后一步覆盖前一步。所有可调项都从 `params` 读
    (见 config.ERA_PRESETS["vintage_2000"]["params"]), 函数体内不写死魔数:
      1. 下采到 short_edge 再上采回原尺寸 —— CCD 时代的低分辨率观感。
      2. 顶部暖色漏光, 强度沿高度线性衰减。
      3. posterize(每通道清掉最低位) —— 模拟浅色阶的断层。

    关于上采样插值(原先这里是 INTER_NEAREST, 是本函数的实现错误):
    最近邻上采样**不产生任何平滑**, 它把每个源像素原样复制成一个硬边方块,
    观感是马赛克/锯齿, 与"CCD 低分辨率"要的方向正好相反 —— docstring 里
    "皮肤细节在此过程中被自然平滑"对 INTER_NEAREST 而言是**不成立的**。
    真正让细节被抹平的是第一步的 INTER_AREA 下采样(面积平均, 本身就是
    低通滤波); 上采样用 INTER_LINEAR 只是把方块边界补成平滑过渡, 不额外
    引入锐化或噪点。

    目标短边用 min(h, w) 推算而不是写死 640x480, 因为 layout 出来的
    成片尺寸不固定(6寸相纸是 1500x1000), 写死会把非 4:3 的图拉变形。
    """
    h, w = bgr.shape[:2]
    short_edge = float(params.get("short_edge", 480))
    scale = short_edge / min(h, w)
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    small = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_AREA)
    out = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)

    # 顶部暖色漏光: 沿高度从 leak_r/leak_g 线性衰减到 0, 只抬 R/G, B 不动
    # (R+G 才是暖黄, 只抬 R 会发红)。用 float32 累加避免 uint8 溢出回绕。
    #
    # 为什么是渐变而不是"顶部 1/4 加常数"(原实现): 常数加法在 leak_band
    # 的下边界留下一条**横向硬边** —— 上一行比下一行突然亮 30 个色阶,
    # 在 1500x1000 的成片上是一条肉眼可见的直线。linspace 的 endpoint=True
    # 让带底恰好落到 0, 与带外首行连续, 硬边从根上消失。
    leak_h = max(1, int(round(h * float(params.get("leak_ratio", 0.5)))))
    ramp = np.linspace(1.0, 0.0, leak_h, dtype=np.float32)[:, None]
    band = out[:leak_h, :, :].astype(np.float32)
    band[..., 2] += float(params.get("leak_r", 40)) * ramp  # R in BGR
    band[..., 1] += float(params.get("leak_g", 14)) * ramp  # G
    out[:leak_h, :, :] = np.clip(band, 0, 255).astype(np.uint8)

    # posterize: 清掉每通道最低位 -> 相邻灰阶坍缩, 出现色阶断层
    return (out >> 1) << 1


# era key -> 像素算子。新增 era 时只改这张表, 调用方无需改动。
# 约定: 算子统一签名为 (bgr, params) -> bgr, params 由 _apply_era 从
# config.ERA_PRESETS[era]["params"] 取。本表与 ERA_PRESETS 的 key 必须完全
# 一致 —— verify_era.py 有一条断言专门守这个不变量(加了一边忘了另一边时,
# 该 era 会在 /api/meta 里露脸却静默不生效)。
ERA_OPS = {
    "modern": _era_modern_pixels,
    "vintage_2000": _era_vintage_2000_pixels,
}


def _apply_era(bgr: np.ndarray, era: str) -> np.ndarray:
    """按 era 名取算子并作用。未知 era 交给调用方校验, 这里只做兜底。

    两张表任一缺该 key 都退化成"原样返回"而不是抛异常: era 已经过
    /api/preview/filter 的 ERA_KEYS 校验, 走到这里说明是内部调用方传错,
    静默不生效比让整个成片请求 500 更好排查(症状是"选了没效果")。
    """
    op = ERA_OPS.get(era)
    spec = ERA_PRESETS.get(era)
    if op is None or spec is None:
        return bgr
    return op(bgr, spec["params"])


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
