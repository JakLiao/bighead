"""
生成**位图贴纸**素材(透明 PNG)并同步写出 manifest.json。

为什么需要位图贴纸
------------------
内置的 7 个贴纸形状(心/星/花/圆/云/流体/闪)全是**几何 Path2D**,
做得出"规整的形", 做不出"票根/胶片/猫爪/皇冠"这类插画 —— 它们有
成百上千条边、渐变、高光与描边, 用代码描述只会得到一个拙劣的近似。

位图贴纸与代码形状**共用同一套摆放管线**(坐标相对 0..1、尺寸相对短边、
同一个 paintSticker 渲染器、同一个烧录出口), 差别只在渲染分支:
shape 走 Path2D.fill, asset 走 drawImage。因此新增素材**不需要改
渲染管线**, 与 scripts/mask_assets 的位图蒙版是同一个思路。

产物
----
    frontend/public/stickers/*.png            透明底贴纸
    frontend/public/stickers/manifest.json    唯一登记入口

manifest 由本脚本一并写出(而不是手写): 手写 manifest 时"加了 PNG
忘了登记"和"登记了 PNG 还没生成"这两类漂移只能靠人眼发现, 而这里
生成与登记是同一次循环里不可能分开的两步。

用法(必须用 webui venv 的解释器, 见项目规则)
--------------------------------------------
    & "E:\\Code\\stable-diffusion-webui\\.venv\\Scripts\\python.exe" \\
        scripts/sticker_assets/build_stickers.py
"""
from __future__ import annotations

import json
import math
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "frontend" / "public" / "stickers"

# 成片边长。贴纸最终会被 drawImage 缩到"相对照片短边"的某个比例,
# 512 足够让 4x 缩放后仍然锐利, 又不至于让浏览器一次下载上百 KB。
BASE = 512
# 画布内留给图形本体的那部分(其余是透明边距 + 白描边)。
ART = 400
# 超采样倍数: 先按 SS 倍画, 再 LANCZOS 缩回去, 边缘才是平滑的。
# PIL 的 ellipse/arc 没有抗锯齿, 直接画 512 会有明显锯齿。
SS = 3
WORK = ART * SS

# 白描边宽度(工作分辨率下的像素)。贴纸的"模切白边"是这类素材的
# 识别特征: 没有它, 半透明 PNG 贴在浅色照片上会"融"进背景。
BORDER = 9 * SS

# 字体: 票根上要印字。Windows 自带 arialbd/arial; 找不到就退回
# PIL 内置点阵字体(会小一号, 但不至于让脚本挂掉)。
_FONT_CANDIDATES = (
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
)


def _font(size: int):
    from PIL import ImageFont

    for path in _FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


# ────────────────────────────── 通用工具 ──────────────────────────────

def new_layer() -> Image.Image:
    return Image.new("RGBA", (WORK, WORK), (0, 0, 0, 0))


def u(v: float) -> int:
    """0..1 的归一化坐标 -> 工作分辨率像素。"""
    return round(v * WORK)


def rgba(color) -> tuple[int, int, int, int]:
    """把 3 元组(RGB)补成 4 元组(RGBA, alpha=255), 4 元组原样返回。

    描边色既能用 (255, 255, 255) 也能用 (108, 176, 234, 255) 写 ——
    后者在素材里就是带 alpha 的 RGBA 字面量, 硬拼一个 (255,) 上去会
    变成 5 元组, PIL 直接报 "color must be int, or tuple of one,
    three or four elements"。这类错误在构造阶段就抛, 不会静默出错图。
    """
    return tuple(color) if len(color) == 4 else (color[0], color[1], color[2], 255)


def rotated(img: Image.Image, deg: float) -> Image.Image:
    """在画布内旋转(expand=False)。素材都留了边距, 不会被裁到。"""
    return img.rotate(deg, resample=Image.Resampling.BICUBIC, expand=False)


def add_white_border(img: Image.Image, width: int = BORDER) -> Image.Image:
    """给图形加一圈模切白边。

    做法是 alpha **膨胀**后与原 alpha 相减得到环, 再把环填成白色:
    直接对 RGBA 描边会连内部半透明区域一起描, 出来的白边忽粗忽细。
    膨胀用 MaxFilter 逐像素扩张, 每趟只涨 1px, 所以要 width 趟 ——
    一次 MaxFilter(大核) 在方形核下是各向同性膨胀, 但核太大时
    性能与边缘质量都下降, 逐趟更可控。
    """
    return with_colored_border(img, (255, 255, 255), width)


def finish(img: Image.Image, name: str, border: bool = True) -> Path:
    """白边 -> 缩到 ART -> 居中贴到 BASE 画布 -> 存盘。

    border=False 用于半透明素材(和纸胶带): 模切白边是给不透明贴纸用的,
    盖在半透明图案上会把图案切碎。详见 washi_tape 的说明。
    """
    if border:
        img = add_white_border(img)
    art = img.resize((ART, ART), Image.Resampling.LANCZOS)
    out = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    out.alpha_composite(art, ((BASE - ART) // 2, (BASE - ART) // 2))
    path = OUT / f"{name}.png"
    out.save(path, "PNG", optimize=True)
    return path


def rotate_about_center(draw_fn, deg: float) -> Image.Image:
    """在独立图层上画再整体旋转, 避免每张图都手算旋转后的坐标。"""
    layer = new_layer()
    draw_fn(ImageDraw.Draw(layer))
    return rotated(layer, deg)


# ────────────────────────────── 各款贴纸 ──────────────────────────────

def retro_ticket() -> Image.Image:
    """复古票根: 米色纸卡 + 齿孔边 + 虚线撕口 + 印字。"""
    cream = (243, 232, 205, 255)
    ink = (60, 42, 33, 255)
    red = (186, 58, 44, 255)

    def body(d: ImageDraw.ImageDraw) -> None:
        d.rounded_rectangle(
            [u(0.06), u(0.30), u(0.94), u(0.66)],
            radius=u(0.04),
            fill=cream,
            outline=ink,
            width=int(SS * 3),
        )
        # 齿孔边: 沿上下长边各咬一串半圆。
        r = u(0.028)
        n = 11
        for i in range(n):
            cx = u(0.06) + (u(0.94) - u(0.06)) * (i + 0.5) / n
            for cy in (u(0.30), u(0.66)):
                d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(0, 0, 0, 0))
        # 撕口虚线
        y = u(0.44)
        for i in range(9):
            x0 = u(0.60) + i * u(0.036)
            d.line([x0, y, x0 + u(0.020), y], fill=red, width=int(SS * 3))
        f1 = _font(int(SS * 44))
        f2 = _font(int(SS * 26))
        d.text((u(0.12), u(0.36)), "ADMIT ONE", font=f1, fill=ink)
        d.text((u(0.12), u(0.53)), "No. 0426", font=f2, fill=red)
        d.ellipse([u(0.10), u(0.545), u(0.155), u(0.60)], outline=red,
                  width=int(SS * 3))

    return rotate_about_center(body, -7)


def film_strip() -> Image.Image:
    """胶片条: 深色片身 + 上下齿孔 + 三个画格。"""
    body_c = (38, 36, 48, 255)
    hole = (247, 245, 238, 255)

    def body(d: ImageDraw.ImageDraw) -> None:
        d.rounded_rectangle(
            [u(0.02), u(0.34), u(0.98), u(0.62)],
            radius=u(0.02),
            fill=body_c,
        )
        for cy in (u(0.375), u(0.585)):
            for i in range(9):
                cx = u(0.055) + i * u(0.105)
                w, h = u(0.026), u(0.017)
                d.rounded_rectangle([cx - w, cy - h, cx + w, cy + h],
                                    radius=u(0.006), fill=hole)
        for i in range(3):
            x0 = u(0.075) + i * u(0.295)
            d.rounded_rectangle([x0, u(0.395), x0 + u(0.245), u(0.565)],
                                radius=u(0.012), outline=hole,
                                width=int(SS * 2.5))

    return rotate_about_center(body, 8)


def cat_paw() -> Image.Image:
    """猫爪印: 4 个脚趾 + 一个肉垫。粉色, 圆头。"""
    pad = (240, 130, 160, 255)

    def body(d: ImageDraw.ImageDraw) -> None:
        toes = [
            (0.245, 0.360, 0.088),
            (0.415, 0.305, 0.093),
            (0.585, 0.305, 0.093),
            (0.755, 0.360, 0.088),
        ]
        for cx, cy, r in toes:
            d.ellipse([u(cx - r), u(cy - r), u(cx + r), u(cy + r)], fill=pad)
        # 肉垫: 下宽上窄的圆角块, 比圆更像肉垫。
        d.rounded_rectangle([u(0.265), u(0.455), u(0.735), u(0.735)],
                            radius=u(0.20), fill=pad)

    return body_img(body)


def crown() -> Image.Image:
    """皇冠: 金色主体 + 三颗宝石 + 顶珠。"""
    gold = (247, 195, 62, 255)
    dark = (176, 128, 20, 255)
    gems = [(226, 62, 84, 255), (86, 152, 232, 255), (108, 196, 132, 255)]

    def body(d: ImageDraw.ImageDraw) -> None:
        pts = [
            (u(0.10), u(0.70)), (u(0.10), u(0.30)), (u(0.27), u(0.47)),
            (u(0.50), u(0.20)), (u(0.73), u(0.47)), (u(0.90), u(0.30)),
            (u(0.90), u(0.70)),
        ]
        d.polygon(pts, fill=gold, outline=dark)
        d.line(pts + [pts[0]], fill=dark, width=int(SS * 3), joint="curve")
        d.rounded_rectangle([u(0.10), u(0.70), u(0.90), u(0.80)],
                            radius=u(0.035), fill=gold, outline=dark,
                            width=int(SS * 3))
        for i, cx in enumerate((0.27, 0.50, 0.73)):
            r = u(0.045)
            cy = u(0.60 if i != 1 else 0.50)
            d.ellipse([u(cx) - r, cy - r, u(cx) + r, cy + r],
                      fill=gems[i], outline=dark, width=int(SS * 2))
        r = u(0.052)
        d.ellipse([u(0.50) - r, u(0.155) - r, u(0.50) + r, u(0.155) + r],
                  fill=gems[1], outline=dark, width=int(SS * 2))

    return body_img(body)


def music_note() -> Image.Image:
    """双八分音符: 两个符头 + 符干 + 连梁。"""
    ink = (72, 58, 122, 255)
    accent = (233, 106, 122, 255)
    layer = new_layer()
    d = ImageDraw.Draw(layer)
    # 符干与连梁
    d.rectangle([u(0.425), u(0.24), u(0.475), u(0.690)], fill=ink)
    d.rectangle([u(0.755), u(0.28), u(0.805), u(0.735)], fill=ink)
    d.polygon([(u(0.425), u(0.24)), (u(0.805), u(0.28)),
               (u(0.805), u(0.40)), (u(0.425), u(0.36))], fill=ink)
    # 符头: 在独立图层上画椭圆再旋转 -20°, 才是音符头那种"斜着的胖椭圆"。
    # 直接 draw.ellipse 得到的是水平椭圆, 贴在符干底下像颗药丸。
    for cx, cy in ((0.300, 0.700), (0.630, 0.745)):
        w, h = u(0.118), u(0.086)
        head = Image.new("RGBA", (w * 2, h * 2), (0, 0, 0, 0))
        ImageDraw.Draw(head).ellipse([0, 0, w * 2 - 1, h * 2 - 1], fill=ink)
        head = head.rotate(-20, resample=Image.Resampling.BICUBIC)
        layer.alpha_composite(head, (u(cx) - w, u(cy) - h))
    d = ImageDraw.Draw(layer)
    d.ellipse([u(0.585), u(0.34), u(0.700), u(0.425)], fill=accent)
    return layer


def flower_spray() -> Image.Image:
    """小花束: 三朵五瓣花 + 两片叶。"""
    petals = [(247, 168, 200, 255), (255, 214, 122, 255), (196, 176, 240, 255)]
    core = (255, 240, 168, 255)
    leaf = (128, 186, 118, 255)
    stem = (94, 150, 88, 255)

    def body(d: ImageDraw.ImageDraw) -> None:
        d.line([(u(0.50), u(0.86)), (u(0.30), u(0.42))], fill=stem,
               width=int(SS * 5))
        d.line([(u(0.50), u(0.86)), (u(0.70), u(0.40))], fill=stem,
               width=int(SS * 5))
        d.ellipse([u(0.16), u(0.68), u(0.38), u(0.80)], fill=leaf)
        d.ellipse([u(0.62), u(0.70), u(0.86), u(0.82)], fill=leaf)
        centers = [(0.30, 0.34), (0.50, 0.60), (0.70, 0.32)]
        for (cx, cy), pc in zip(centers, petals):
            pr, cr = u(0.115), u(0.055)
            for i in range(5):
                a = -math.pi / 2 + i * 2 * math.pi / 5
                px, py = u(cx) + math.cos(a) * pr * 0.95, u(cy) + math.sin(a) * pr * 0.95
                d.ellipse([px - pr * 0.62, py - pr * 0.62,
                           px + pr * 0.62, py + pr * 0.62], fill=pc)
            d.ellipse([u(cx) - cr, u(cy) - cr, u(cx) + cr, u(cy) + cr], fill=core)

    return rotate_about_center(body, -6)


def washi_tape() -> Image.Image:
    """和纸胶带: 半透明斜纹胶带 + 锯齿撕口。

    **刻意不加模切白边**: 其余 7 张是不透明贴纸, 白边是模切工艺的
    特征; 而和纸胶带本身是半透明的, 白边会盖在斜纹上把图案切碎
    (斜纹断成一段段), 看起来像渲染错误而不是胶带。半透明素材只保留
    自身的撕口边缘。
    """
    base = (126, 214, 196, 190)
    stripe = (247, 240, 214, 210)

    def body(d: ImageDraw.ImageDraw) -> None:
        d.rectangle([u(0.04), u(0.36), u(0.96), u(0.60)], fill=base)
        step = int(SS * 26)
        x = u(0.02)
        while x < u(1.02):
            d.line([(x, u(0.62)), (x + u(0.10), u(0.34))],
                   fill=stripe, width=int(SS * 9))
            x += step
        for i in range(16):
            x0 = u(0.04) + i * u(0.0585)
            d.polygon([(x0, u(0.36)), (x0 + u(0.029), u(0.325)),
                       (x0 + u(0.0585), u(0.36))], fill=(0, 0, 0, 0))
            d.polygon([(x0, u(0.60)), (x0 + u(0.029), u(0.635)),
                       (x0 + u(0.0585), u(0.60))], fill=(0, 0, 0, 0))

    return rotate_about_center(body, -14)


def rainbow_arc() -> Image.Image:
    """彩虹: 五道同心弧 + 两朵云。

    白云 + 白模切边在浅色照片上会融成一片(云"消失"了), 而彩虹本身
    是**彩色**主体 —— 用一圈淡蓝描边而不是白色, 既保留模切感, 又不
    会把云吃掉。
    """
    bands = [
        (240, 90, 90, 255),
        (247, 166, 82, 255),
        (250, 216, 106, 255),
        (140, 208, 130, 255),
        (116, 178, 232, 255),
    ]
    cloud = (255, 255, 255, 255)
    cloud_line = (150, 196, 236, 255)
    edge = (108, 176, 234, 255)

    layer = new_layer()
    d = ImageDraw.Draw(layer)
    band = int(SS * 21)
    for i, c in enumerate(bands):
        r = u(0.42) - i * band
        d.arc([u(0.50) - r, u(0.52) - r, u(0.50) + r, u(0.52) + r],
              180, 360, fill=c, width=band)
    # 云: 白填充 + 淡蓝描边, 让它从白边里"浮"出来。
    for cx in (0.16, 0.84):
        for dx, dy, r in ((-0.075, 0.0, 0.062), (0.0, -0.022, 0.080),
                          (0.075, 0.0, 0.062)):
            rr = u(r)
            d.ellipse([u(cx + dx) - rr, u(0.60 + dy) - rr,
                       u(cx + dx) + rr, u(0.60 + dy) + rr],
                      fill=cloud, outline=cloud_line, width=int(SS * 3))
    return with_colored_border(layer, edge)


def with_colored_border(img: Image.Image, color, width: int = BORDER) -> Image.Image:
    """add_white_border 的彩色版: 描边取给定色而非纯白。

    与 add_white_border 里的膨胀/相减/二值化完全一致, 只换填充色 ——
    两条路径必须共用同一段几何逻辑, 否则同款素材的白边与彩边宽度会有
    肉眼可见的差异, 而这种差异在并排比较时才暴露, 极难定位。
    """
    alpha = img.getchannel("A")
    grown = alpha
    for _ in range(width):
        grown = grown.filter(ImageFilter.MaxFilter(3))
    ring = ImageChops.subtract(grown, alpha)
    ring = ring.filter(ImageFilter.GaussianBlur(width * 0.16))
    ring = ring.point(lambda v: 255 if v > 60 else 0)
    ring = ring.filter(ImageFilter.GaussianBlur(SS * 0.25))
    border = Image.new("RGBA", img.size, rgba(color))
    border.putalpha(ring)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.alpha_composite(border)
    out.alpha_composite(img)
    return out


def body_img(body) -> Image.Image:
    layer = new_layer()
    body(ImageDraw.Draw(layer))
    return layer


# ────────────────────────────── 登记表 ──────────────────────────────

@dataclass(frozen=True)
class Spec:
    """一张位图贴纸的登记项。

    border 是**登记表**的字段, 而不是 finish() 调用处的临时 if: 判断
    "这张要不要模切边"是素材的固有属性(半透明主体、自带描边的主体都
    不该有白边), 属于素材定义本身。放在主流程里判断, 迟早会有人新增
    一张半透明素材而忘了写这个开关。
    """
    key: str
    fn: Callable[[], Image.Image]
    name: str
    category: str
    tags: tuple[str, ...]
    border: bool = True


STICKERS = [
    Spec("retro_ticket", retro_ticket, "复古票根", "复古", ("票根", "复古", "胶片")),
    Spec("film_strip", film_strip, "胶片格", "复古", ("胶片", "拍立得", "摄影")),
    # 自带淡蓝描边(见 rainbow_arc), 再套白边会变成"白边里嵌了圈彩边"。
    Spec("rainbow_arc", rainbow_arc, "彩虹", "童趣", ("彩虹", "童趣", "多彩"), border=False),
    Spec("flower_spray", flower_spray, "小花束", "自然", ("小花", "手绘", "春日")),
    Spec("cat_paw", cat_paw, "猫爪印", "动物", ("猫", "肉垫", "可爱")),
    Spec("crown", crown, "皇冠", "奢华", ("皇冠", "金色", "氛围")),
    Spec("music_note", music_note, "双音符", "音乐", ("音符", "手绘", "节奏")),
    # 半透明主体, 白边会盖在斜纹上把图案切碎。
    Spec("washi_tape", washi_tape, "和纸胶带", "手作", ("胶带", "手账", "半透明"), border=False),
]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    entries = []
    for spec in STICKERS:
        path = finish(spec.fn(), spec.key, border=spec.border)
        kb = path.stat().st_size / 1024
        print(f"  {spec.key:14s} {spec.name:6s} {kb:6.1f}KB")
        entries.append({
            "key": spec.key,
            "name": spec.name,
            "src": f"{spec.key}.png",
            "category": spec.category,
            "tags": list(spec.tags),
        })
    manifest = {"version": 1, "stickers": entries}
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"\nmanifest -> {(OUT / 'manifest.json')}")
    print(f"共 {len(entries)} 张贴纸")


if __name__ == "__main__":
    main()