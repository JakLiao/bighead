"""分享卡合成:把拼图装进固定 4:3 卡片,加品牌 footer,落盘.

为什么不并进 layouts.py: layouts.py 是「拼图」—— 输出尺寸完全由排版决定
(2x2 / 3x3 / strip 各自不同)。分享卡是「成品」—— 尺寸恒为 4:3, 内容是
拼图 + 文案。两者的输入输出契约不同, 混在一个文件里会让 make_collage
逐渐长出「如果 frame 是 share 就怎样」的分支。

几何(固定 4:3 = 1200x900):
    +------------------------------+
    |  <- 40 边距                   |
    |   +----------------------+   |
    |   |                      |   |
    |   |  拼图(等比 contain)  |   | 680 高
    |   |                      |   |
    |   +----------------------+   |
    |   -- footer 分隔线 --        |
    |   BigHead 大头贴复古         | 220 高
    |   #a1b2c3 - 2026-10-05      |
    +------------------------------+

镜像实现在 frontend/src/shareCard.ts(浏览器端 canvas 合成)。
两份几何常量必须逐值一致 —— 见 config.SHARE_CARD_SIZE 的注释。
"""
from __future__ import annotations

import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .config import (
    SHARE_CARD_BG,
    SHARE_CARD_BRAND,
    SHARE_CARD_FONT_FALLBACK,
    SHARE_CARD_FONTS,
    SHARE_CARD_FOOTER_H,
    SHARE_CARD_MARGIN,
    SHARE_CARD_SHORT_ID,
    SHARE_CARD_SIZE,
    SHARE_FILENAME,
)

# footer 文字配色
_INK_BRAND = (90, 70, 70)
_INK_META = (150, 120, 118)
_INK_LINE = (210, 190, 180)
# 字号
_BRAND_SIZE = 48
_META_SIZE = 30


def _load_font(size: int) -> ImageFont.FreeTypeFont | None:
    """按候选链取第一个能用的字体, 全都不存在时返回 None。

    刻意不设「候选链全挂 -> load_default()」兜底: PIL 的
    ImageFont.load_default() 返回的是位图字体, 字形极小且**不含中文**,
    排出来是一串模糊方块。宁可返回 None 让调用方自己降级, 也不要输出一张
    看起来排好版、实际全是豆腐块的图。

    仍然兜 arial.ttf: 它至少能让纯 ASCII 的 job_id 正常显示。
    """
    for path in SHARE_CARD_FONTS + [SHARE_CARD_FONT_FALLBACK]:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return None


def short_job_id(job_id: str) -> str:
    """短 job ID: uuid4().hex[:12] 的前 SHARE_CARD_SHORT_ID 位。"""
    return job_id[:SHARE_CARD_SHORT_ID]


def render_share_card(
    collage: Image.Image,
    job_id: str,
    captured_at: float | None = None,
) -> Image.Image:
    """把拼图装进 4:3 卡片并加 footer, 返回 PIL.Image。"""
    card_w, card_h = SHARE_CARD_SIZE
    card = Image.new("RGB", SHARE_CARD_SIZE, SHARE_CARD_BG)

    inner_w = card_w - SHARE_CARD_MARGIN * 2
    inner_h = card_h - SHARE_CARD_MARGIN * 2 - SHARE_CARD_FOOTER_H
    inner_x = SHARE_CARD_MARGIN
    inner_y = SHARE_CARD_MARGIN

    # 等比 contain 适配。
    #
    # 用 thumbnail 而不是直接 resize: 拼图可能是 4:1 的长条(排版 strip),
    # 直接 resize 到内容区尺寸会把它拉成 4:3 的糊图。contain 保住长条的
    # 原始比例, 代价是上下/左右出现留白 —— 而留白正好是米色纸底,
    # 视觉上是「拍立得的白边」而不是「排版坏了」。
    #
    # thumbnail 是**原地**修改, 所以必须先 convert 出一个副本: 直接改
    # collage 会让调用方手里的图被缩掉(若调用方还要复用它就会踩坑)。
    src = collage.convert("RGB")
    src.thumbnail((inner_w, inner_h), Image.LANCZOS)
    # 居中: 留白平均分到两侧。靠左排会让卡片视觉重心偏左, 发出去看着
    # 像没对齐 —— 这正是「留白」和「没对齐」在观感上的分界线。
    px = inner_x + (inner_w - src.width) // 2
    py = inner_y + (inner_h - src.height) // 2
    card.paste(src, (px, py))

    _draw_footer(card, job_id, captured_at)
    return card


def _draw_footer(card: Image.Image, job_id: str, captured_at: float | None) -> None:
    """画 footer: 分隔线 + 品牌行 + 短 job ID + 拍摄日期。"""
    d = ImageDraw.Draw(card)
    card_w, card_h = SHARE_CARD_SIZE
    line_y = card_h - SHARE_CARD_FOOTER_H
    d.line(
        [(SHARE_CARD_MARGIN, line_y), (card_w - SHARE_CARD_MARGIN, line_y)],
        fill=_INK_LINE,
        width=2,
    )

    brand_font = _load_font(_BRAND_SIZE)
    meta_font = _load_font(_META_SIZE)

    if brand_font is not None:
        d.text(
            (SHARE_CARD_MARGIN, line_y + 44),
            SHARE_CARD_BRAND,
            fill=_INK_BRAND,
            font=brand_font,
        )

    # 用 `is not None` 而非真值判断: captured_at=0.0(epoch) 是合法的
    # 「已知的极早时间戳」, 写成 `if captured_at` 会把它当成「没传」而
    # 回落到当前时间 —— 输出上看不出异常, 只是日期悄悄错了, 极难排查。
    when = (
        time.strftime("%Y-%m-%d", time.localtime(captured_at))
        if captured_at is not None
        else time.strftime("%Y-%m-%d")
    )
    meta_line = f"#{short_job_id(job_id)} - {when}"
    if meta_font is not None:
        # 右对齐靠反推起点: d.text 的原点固定在左上角, 没有 anchor 参数
        # (Pillow 8+ 才有, 且不能与 default 基线混用)。写死 x 的话, 品牌
        # 文案一改长就会撞到右边界; 反推式在文案变化时自动跟随。
        tw = d.textlength(meta_line, font=meta_font)
        d.text(
            (card_w - SHARE_CARD_MARGIN - tw, line_y + 130),
            meta_line,
            fill=_INK_META,
            font=meta_font,
        )


def share_to_file(
    collage: Image.Image,
    job_dir: Path,
    job_id: str,
    captured_at: float | None = None,
) -> Path:
    """合成并写 outputs/{job_id}/share.jpg, 返回落盘路径。"""
    card = render_share_card(collage, job_id, captured_at)
    job_dir.mkdir(parents=True, exist_ok=True)
    out = job_dir / SHARE_FILENAME
    card.save(out, format="JPEG", quality=92)
    return out


if __name__ == "__main__":
    import sys

    im = Image.new("RGB", (600, 400), (120, 160, 200))
    p = share_to_file(im, Path("outputs") / "_share_selftest", "a1b2c3d4e5f6", 0.0)
    print(f"OK {p} {Image.open(p).size}")
    sys.exit(0)
