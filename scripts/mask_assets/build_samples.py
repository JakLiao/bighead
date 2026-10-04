"""
生成**规范示例**蒙版素材。

用途:位图蒙版的正式素材后补,本脚本先产出少量样例把链路打通 ——
前端加载、图库展示、预览与出片烧录都能立刻跑起来。
样式刻意做得克制(渐变底 + 描边 + 几何装饰),方便一眼看出
"洞在哪、边框多宽",同时不与将来替换的正式素材混淆。

产出严格符合 SPEC.md:
  · 1200x900(4:3)、RGBA
  · 中央镂空为**几何精确**的形状,alpha=0
  · 四周完全不透明
  · 单张 < 400KB

用法:
    python scripts/mask_assets/build_samples.py
"""
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "frontend" / "public" / "masks"

W, H = 1200, 900
SS = 2  # 超采样倍数,先放大画再缩小,得到平滑边缘


# ────────────────────────────── 绘图基元 ──────────────────────────────

def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vgradient(size, top, bottom):
    """竖直线性渐变。逐行插值,比 numpy 少一个依赖。"""
    w, h = size
    img = Image.new("RGB", (1, h))
    px = img.load()
    for y in range(h):
        px[0, y] = lerp(top, bottom, y / max(1, h - 1))
    return img.resize((w, h), Image.BILINEAR)


def radial_fade(size, cx, cy, r, inner=255, outer=0):
    """径向alpha遮罩,用来在渐变底上叠一团柔光/暗角。"""
    w, h = size
    m = Image.new("L", (w, h), outer)
    d = ImageDraw.Draw(m)
    steps = 48
    for i in range(steps, 0, -1):
        t = i / steps
        rr = r * t
        val = round(outer + (inner - outer) * (1 - t) ** 1.6)
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=val)
    return m.filter(ImageFilter.GaussianBlur(r * 0.06))


def heart_points(cx, cy, w, h, n=220):
    """经典心形参数方程,尖端朝下。"""
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        x = 16 * math.sin(t) ** 3
        y = -(13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t))
        pts.append((cx + x / 16 * w / 2, cy + y / 16 * h / 2))
    return pts


def star_points(cx, cy, r_out, r_in, points=5, rot=-math.pi / 2):
    pts = []
    for i in range(points * 2):
        r = r_out if i % 2 == 0 else r_in
        a = i / (points * 2) * 2 * math.pi + rot
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def blob_points(cx, cy, r, harmonics, n=240):
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        rr = r
        for h_n, amp, phase in harmonics:
            rr += r * amp * math.cos(h_n * t + phase)
        pts.append((cx + rr * math.cos(t), cy + rr * math.sin(t)))
    return pts


def scallop_ring(draw, box, lobes, amp, color, width):
    """扇贝边(蕾丝感):沿矩形周长画一串半圆。"""
    x0, y0, x1, y1 = box
    # 四条边各自布点
    segs = [
        ((x0, y0), (x1, y0), lobes // 4, False),
        ((x1, y0), (x1, y1), lobes // 4, True),
        ((x1, y1), (x0, y1), lobes // 4, False),
        ((x0, y1), (x0, y0), lobes // 4, True),
    ]
    r = amp
    for (ax, ay), (bx, by), n, vert in segs:
        for i in range(n):
            t0 = i / n
            t1 = (i + 0.5) / n
            t2 = (i + 1) / n
            def pt(t):
                return (ax + (bx - ax) * t, ay + (by - ay) * t)
            p0, p1, p2 = pt(t0), pt(t1), pt(t2)
            # 半圆弧:以 p1 为心,向边缘外侧鼓出
            nx, ny = (0, 1) if not vert else (1, 0)
            ox, oy = p1[0] + nx * r, p1[1] + ny * r
            bbox = [
                min(p0[0], p2[0], ox) - 1, min(p0[1], p2[1], oy) - 1,
                max(p0[0], p2[0], ox) + 1, max(p0[1], p2[1], oy) + 1,
            ]
            draw.arc(bbox, 0, 360, fill=color, width=width)


def pearl_strand(draw, box, color, r=9, step=30, hi=("#FFFFFF", "#E8E2F0")):
    """沿矩形周长排一串珍珠(带高光)。"""
    x0, y0, x1, y1 = box
    pts = []
    n_h = max(2, int((x1 - x0) // step))
    n_v = max(2, int((y1 - y0) // step))
    for i in range(n_h):
        pts.append((x0 + (x1 - x0) * i / n_h, y0))
        pts.append((x0 + (x1 - x0) * i / n_h, y1))
    for i in range(n_v):
        pts.append((x0, y0 + (y1 - y0) * i / n_v))
        pts.append((x1, y0 + (y1 - y0) * i / n_v))
    for (x, y) in pts:
        draw.ellipse([x - r, y - r, x + r, y + r], fill=color)
        draw.ellipse(
            [x - r * 0.45, y - r * 0.55, x + r * 0.05, y - r * 0.05],
            fill=hi[0],
        )


def rosette(draw, cx, cy, r, petal, core, outline=None, petals=7, width=0):
    """玫瑰/花:多层花瓣 + 花心,用于图1风格的角落装饰。"""
    for i in range(petals):
        a = 2 * math.pi * i / petals
        px = cx + math.cos(a) * r * 0.52
        py = cy + math.sin(a) * r * 0.52
        pr = r * 0.46
        draw.ellipse([px - pr, py - pr, px + pr, py + pr], fill=petal,
                     outline=outline, width=width)
    draw.ellipse([cx - r * 0.3, cy - r * 0.3, cx + r * 0.3, cy + r * 0.3], fill=core)


def sparkle(draw, cx, cy, r, color):
    """四角星,小尺寸点缀。"""
    draw.polygon(
        [(cx, cy - r), (cx + r * 0.22, cy - r * 0.22), (cx + r, cy),
         (cx + r * 0.22, cy + r * 0.22), (cx, cy + r), (cx - r * 0.22, cy + r * 0.22),
         (cx - r, cy), (cx - r * 0.22, cy - r * 0.22)],
        fill=color,
    )


def dots_grid(draw, box, color, step=44, r=3):
    x0, y0, x1, y1 = box
    y = y0 + step
    while y < y1 - step:
        x = x0 + step
        while x < x1 - step:
            draw.ellipse([x - r, y - r, x + r, y + r], fill=color)
            x += step
        y += step


def punch(img, hole_pts, feather=1.4):
    """把洞挖成**完全透明**(alpha=0),边缘做羽化。

    构造的是"洞指示图":洞内 255、洞外 0,再从 alpha 里减掉。
    反过来(洞外 255)会把整张图变透明 —— 减法方向搞错是最容易踩的坑。
    先在 L 遮罩上做再减,而不是直接往 RGBA 上画,是为了避免半透明描边
    留下预乘色残影。
    """
    ind = Image.new("L", img.size, 0)
    ImageDraw.Draw(ind).polygon(hole_pts, fill=255)
    if feather > 0:
        ind = ind.filter(ImageFilter.GaussianBlur(feather))
        # 重新压实洞芯,保证正中心彻底透明(模糊会让中心也发灰)
        d = ImageDraw.Draw(ind)
        cx = sum(p[0] for p in hole_pts) / len(hole_pts)
        cy = sum(p[1] for p in hole_pts) / len(hole_pts)
        f = 0.94
        d.polygon([(cx + (x - cx) * f, cy + (y - cy) * f) for x, y in hole_pts], fill=255)

    from PIL import ImageChops
    img.putalpha(ImageChops.subtract(img.getchannel("A"), ind))
    return img


def punch_many(img, holes):
    """多洞蒙版(双人):每个洞各自挖一次,重叠处依旧是全透明。"""
    from PIL import ImageChops
    ind = Image.new("L", img.size, 0)
    d = ImageDraw.Draw(ind)
    for h in holes:
        d.polygon(h, fill=255)
    img.putalpha(ImageChops.subtract(img.getchannel("A"), ind))
    return img


# ────────────────────────────── 样例定义 ──────────────────────────────

def build_pearl_heart():
    top, bottom = (240, 236, 250), (206, 196, 234)
    img = vgradient((W * SS, H * SS), top, bottom).convert("RGBA")
    d = ImageDraw.Draw(img)
    s = SS
    cx, cy = W * s / 2, H * s / 2

    # 中心柔光,让底色不至于太平
    glow = radial_fade(img.size, cx, cy * 0.92, 520 * s, inner=70, outer=0)
    base = img.convert("RGB")
    base = Image.composite(Image.new("RGB", img.size, (255, 255, 255)), base, glow)
    img = base.convert("RGBA")
    d = ImageDraw.Draw(img)

    gold = (198, 168, 108)
    pearl = (253, 251, 246)

    # 双线金框 + 蕾丝 + 珍珠串
    d.rounded_rectangle([40 * s, 40 * s, (W - 40) * s, (H - 40) * s],
                        radius=54 * s, outline=gold, width=5 * s)
    d.rounded_rectangle([58 * s, 58 * s, (W - 58) * s, (H - 58) * s],
                        radius=44 * s, outline=(214, 190, 140), width=2 * s)
    scallop_ring(d, [76 * s, 76 * s, (W - 76) * s, (H - 76) * s],
                 lobes=56, amp=13 * s, color=(226, 214, 240), width=3 * s)
    pearl_strand(d, [104 * s, 104 * s, (W - 104) * s, (H - 104) * s],
                 color=pearl, r=10 * s, step=34 * s)

    # 四角玫瑰 + 顶部蝴蝶结感
    rosette(d, 132 * s, 132 * s, 54 * s, (255, 255, 255), (226, 206, 160),
            outline=(214, 198, 168), petals=7, width=2 * s)
    rosette(d, (W - 132) * s, 132 * s, 46 * s, (255, 255, 255), (226, 206, 160),
            outline=(214, 198, 168), petals=6, width=2 * s)
    rosette(d, 120 * s, (H - 120) * s, 40 * s, (252, 250, 255), (222, 204, 158),
            outline=(214, 198, 168), petals=6, width=2 * s)
    rosette(d, (W - 120) * s, (H - 120) * s, 40 * s, (252, 250, 255), (222, 204, 158),
            outline=(214, 198, 168), petals=6, width=2 * s)

    for (x, y, r) in [(300, 96, 15), (900, 108, 13), (196, 780, 14), (1010, 760, 12)]:
        sparkle(d, x * s, y * s, r * s, (255, 255, 255))

    hole = heart_points(cx, cy + 12 * s, 520 * s, 470 * s)
    return punch(img, hole)


def build_pearl_round():
    top, bottom = (253, 249, 238), (240, 228, 202)
    img = vgradient((W * SS, H * SS), top, bottom).convert("RGBA")
    s = SS
    cx, cy = W * s / 2, H * s / 2
    d = ImageDraw.Draw(img)
    gold = (198, 160, 96)

    d.rounded_rectangle([40 * s, 40 * s, (W - 40) * s, (H - 40) * s],
                        radius=54 * s, outline=gold, width=5 * s)
    d.rounded_rectangle([58 * s, 58 * s, (W - 58) * s, (H - 58) * s],
                        radius=44 * s, outline=(216, 194, 152), width=2 * s)
    pearl_strand(d, [104 * s, 104 * s, (W - 104) * s, (H - 104) * s],
                 color=(255, 253, 246), r=10 * s, step=34 * s)
    rosette(d, 138 * s, 138 * s, 50 * s, (255, 255, 255), (226, 200, 140),
            outline=(214, 192, 150), petals=7, width=2 * s)
    rosette(d, (W - 138) * s, (H - 138) * s, 46 * s, (255, 255, 255), (226, 200, 140),
            outline=(214, 192, 150), petals=6, width=2 * s)
    for (x, y, r) in [(300, 100, 14), (905, 96, 12), (200, 790, 13)]:
        sparkle(d, x * s, y * s, r * s, (255, 255, 255))

    r = 232 * s
    hole = [(cx + r * math.cos(2 * math.pi * i / 200), cy + r * math.sin(2 * math.pi * i / 200))
            for i in range(200)]
    return punch(img, hole)


def build_pearl_bow():
    top, bottom = (252, 250, 246), (232, 224, 210)
    img = vgradient((W * SS, H * SS), top, bottom).convert("RGBA")
    s = SS
    cx, cy = W * s / 2, H * s / 2
    d = ImageDraw.Draw(img)
    gold = (190, 162, 112)

    d.rounded_rectangle([40 * s, 40 * s, (W - 40) * s, (H - 40) * s],
                        radius=54 * s, outline=gold, width=5 * s)
    pearl_strand(d, [96 * s, 96 * s, (W - 96) * s, (H - 96) * s],
                 color=(255, 255, 252), r=9 * s, step=32 * s)

    # 顶部蝴蝶结:两片环 + 中结
    by = 128 * s
    d.ellipse([cx - 150 * s, by - 62 * s, cx - 24 * s, by + 62 * s],
              fill=(246, 240, 230), outline=gold, width=4 * s)
    d.ellipse([cx + 24 * s, by - 62 * s, cx + 150 * s, by + 62 * s],
              fill=(246, 240, 230), outline=gold, width=4 * s)
    d.ellipse([cx - 40 * s, by - 40 * s, cx + 40 * s, by + 40 * s],
              fill=(238, 228, 212), outline=gold, width=4 * s)
    for dx in (-118, 118):
        d.polygon(
            [(cx + dx * s, by + 40 * s), (cx + (dx + 44) * s, by + 128 * s),
             (cx + (dx - 30) * s, by + 120 * s)],
            fill=(246, 240, 230), outline=gold,
        )

    rosette(d, 128 * s, (H - 128) * s, 44 * s, (255, 255, 255), (226, 206, 160),
            outline=(214, 198, 168), petals=6, width=2 * s)
    rosette(d, (W - 128) * s, (H - 128) * s, 44 * s, (255, 255, 255), (226, 206, 160),
            outline=(214, 198, 168), petals=6, width=2 * s)

    box = [250 * s, 300 * s, (W - 250) * s, (H - 250) * s]
    hole = [(box[0], box[1]),
            (box[2], box[1]), (box[2], box[3]), (box[0], box[3])]
    return punch(img, hole, feather=0)


def _cartoon_base(bg, ink="#2B2B2B"):
    img = Image.new("RGBA", (W * SS, H * SS), bg + (255,))
    return img, ImageDraw.Draw(img), ink


def build_cartoon_speech():
    img, d, ink = _cartoon_base((255, 233, 240))
    s = SS
    cx, cy = W * s / 2, H * s / 2

    # 气泡主体 + 尾巴
    body = [180 * s, 96 * s, (W - 180) * s, (H - 150) * s]
    d.rounded_rectangle(body, radius=110 * s, fill=(255, 255, 255), outline=ink, width=9 * s)
    d.polygon([(cx - 90 * s, (H - 150) * s), (cx + 30 * s, (H - 150) * s),
               (cx - 40 * s, (H - 60) * s)], fill=(255, 255, 255))
    d.line([(cx - 90 * s, (H - 150) * s), (cx - 40 * s, (H - 60) * s),
            (cx + 30 * s, (H - 150) * s)], fill=ink, width=9 * s, joint="curve")

    # 周围小元素
    for (x, y, c) in [(96, 120, (255, 176, 200)), (W - 96, 120, (186, 225, 255)),
                      (110, H - 110, (255, 214, 130)), (W - 110, H - 110, (198, 240, 210))]:
        d.polygon(heart_points(x * s, y * s, 58 * s, 52 * s), fill=c, outline=ink)
    for (x, y, r) in [(250, 74, 20), (W - 250, 74, 20), (150, H - 60, 17), (W - 150, H - 60, 17)]:
        d.polygon(star_points(x * s, y * s, r * s, r * 0.45 * s), fill=(255, 214, 130), outline=ink)

    inner = [232 * s, 148 * s, (W - 232) * s, (H - 202) * s]
    hole = [(inner[0], inner[1]), (inner[2], inner[1]), (inner[2], inner[3]), (inner[0], inner[3])]
    return punch(img, hole, feather=0)


def build_cartoon_wreath():
    img, d, ink = _cartoon_base((233, 243, 230))
    s = SS
    cx, cy = W * s / 2, H * s / 2

    # 花环:沿圆周排布 alternating 的花与叶
    r = 300 * s
    for i in range(18):
        a = 2 * math.pi * i / 18
        x, y = cx + math.cos(a) * r, cy + math.sin(a) * r * 0.86
        if i % 2 == 0:
            rosette(d, x, y, 42 * s, (255, 190, 214), (255, 240, 160),
                    outline=ink, petals=6, width=4 * s)
        else:
            d.polygon(
                blob_points(x, y, 34 * s, [(3, 0.22, 0.4), (5, 0.12, 1.1)]),
                fill=(150, 200, 160), outline=ink,
            )
    d.ellipse([cx - r * 0.80, cy - r * 0.80, cx + r * 0.80, cy + r * 0.80],
              fill=(255, 255, 255), outline=ink, width=8 * s)

    for (x, y, r2) in [(140, 96, 20), (W - 140, 96, 20), (140, H - 96, 18), (W - 140, H - 96, 18)]:
        d.polygon(star_points(x * s, y * s, r2 * s, r2 * 0.45 * s), fill=(255, 214, 130), outline=ink)

    r = 218 * s
    hole = [(cx + r * math.cos(2 * math.pi * i / 200), cy + r * math.sin(2 * math.pi * i / 200))
            for i in range(200)]
    return punch(img, hole, feather=0)


def build_cartoon_rainbow():
    img, d, ink = _cartoon_base((226, 240, 255))
    s = SS
    cx, cy = W * s / 2, H * s / 2

    # 彩虹弧:七段同心圆环
    bands = [(255, 138, 128), (255, 178, 96), (255, 224, 96), (150, 210, 120),
             (120, 200, 220), (150, 160, 230), (200, 150, 220)]
    r_out = 470 * s
    bw = 34 * s
    for i, c in enumerate(bands):
        r = r_out - i * bw
        d.arc([cx - r, cy - r + 190 * s, cx + r, cy + r + 190 * s],
              180, 360, fill=c, width=int(bw))
    # 云朵
    for sx in (-1, 1):
        bx = cx + sx * (r_out - 3 * bw)
        for (ox, oy, r) in [(0, 0, 54), (-52, 18, 40), (52, 18, 40)]:
            d.ellipse([bx + ox * s - r * s, 190 * s + oy * s - r * s,
                       bx + ox * s + r * s, 190 * s + oy * s + r * s],
                      fill=(255, 255, 255), outline=ink, width=5 * s)

    for (x, y, r2) in [(150, 120, 22), (W - 150, 120, 22), (W / 2, 96, 20)]:
        d.polygon(star_points(x * s, y * s, r2 * s, r2 * 0.45 * s), fill=(255, 214, 130), outline=ink)

    box = [248 * s, 372 * s, (W - 248) * s, (H - 130) * s]
    hole = [(box[0], box[1]), (box[2], box[1]), (box[2], box[3]), (box[0], box[3])]
    return punch(img, hole, feather=0)


def build_cartoon_dual():
    """双人:两个独立圆窗,验证多洞蒙版的取景提示。"""
    img, d, ink = _cartoon_base((250, 240, 224))
    s = SS
    cx, cy = W * s / 2, H * s / 2

    d.rounded_rectangle([70 * s, 90 * s, (W - 70) * s, (H - 90) * s],
                        radius=80 * s, fill=(255, 255, 255), outline=ink, width=9 * s)
    # 杯身条纹
    for i in range(5):
        y = (150 + i * 130) * s
        d.line([(120 * s, y), ((W - 120) * s, y)], fill=(240, 214, 178), width=10 * s)
    for (x, y, c) in [(92, 120, (255, 190, 214)), (W - 92, 120, (186, 225, 255))]:
        d.polygon(heart_points(x * s, y * s, 54 * s, 48 * s), fill=c, outline=ink)
    d.polygon(star_points(cx, 108 * s, 34 * s, 15 * s), fill=(255, 214, 130), outline=ink)

    holes = []
    r = 168 * s
    for ox in (-208, 208):
        hx = cx + ox * s
        holes.append([(hx + r * math.cos(2 * math.pi * i / 160),
                       cy + r * math.sin(2 * math.pi * i / 160)) for i in range(160)])

    return punch_many(img, holes)


def build_vintage_ticket():
    img = vgradient((W * SS, H * SS), (246, 238, 220), (226, 210, 184)).convert("RGBA")
    s = SS
    cx, cy = W * s / 2, H * s / 2
    d = ImageDraw.Draw(img)
    ink = (74, 60, 46)

    d.rounded_rectangle([40 * s, 40 * s, (W - 40) * s, (H - 40) * s],
                        radius=40 * s, fill=(252, 246, 232), outline=ink, width=6 * s)
    d.rounded_rectangle([62 * s, 62 * s, (W - 62) * s, (H - 62) * s],
                        radius=28 * s, outline=(196, 170, 132), width=3 * s)
    dots_grid(d, [80 * s, 80 * s, (W - 80) * s, (H - 80) * s], (214, 196, 164), step=52 * s, r=3 * s)

    # 齿孔虚线
    for x in range(int(96 * s), int((W - 96) * s), int(34 * s)):
        d.ellipse([x - 5 * s, 44 * s - 5 * s, x + 5 * s, 44 * s + 5 * s], fill=(252, 246, 232))
        d.ellipse([x - 5 * s, (H - 44) * s - 5 * s, x + 5 * s, (H - 44) * s + 5 * s], fill=(252, 246, 232))

    for (x, y) in [(120, 120), (W - 120, 120), (120, H - 120), (W - 120, H - 120)]:
        rosette(d, x * s, y * s, 38 * s, (214, 178, 150), (168, 128, 96),
                outline=ink, petals=6, width=2 * s)

    box = [250 * s, 210 * s, (W - 250) * s, (H - 210) * s]
    hole = [(box[0], box[1]), (box[2], box[1]), (box[2], box[3]), (box[0], box[3])]
    return punch(img, hole, feather=0)


SAMPLES = {
    "pearl_heart_lilac": build_pearl_heart,
    "pearl_round_cream": build_pearl_round,
    "pearl_bow_white": build_pearl_bow,
    "cartoon_speech": build_cartoon_speech,
    "cartoon_flowerwreath": build_cartoon_wreath,
    "cartoon_rainbow": build_cartoon_rainbow,
    "cartoon_takeout": build_cartoon_dual,
    "vintage_ticket": build_vintage_ticket,
}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for key, fn in SAMPLES.items():
        img = fn()
        # 先超采样绘制再缩回目标尺寸,边缘自然平滑
        img = img.resize((W, H), Image.LANCZOS).convert("RGBA")
        path = OUT / f"{key}.png"
        img.save(path, "PNG", optimize=True)
        print(f"  {key}.png  {path.stat().st_size // 1024}KB")

    # 与 manifest 对账:manifest 有而这里没生成的,提醒补
    manifest = OUT / "manifest.json"
    if manifest.is_file():
        declared = {m["src"] for m in json.loads(manifest.read_text(encoding="utf-8"))["masks"]}
        missing = declared - {f"{k}.png" for k in SAMPLES}
        if missing:
            print(f"\n[WARN] manifest 声明但未生成的素材: {sorted(missing)}")
    print(f"\n完成:{len(SAMPLES)} 张 → {OUT}")


if __name__ == "__main__":
    main()
