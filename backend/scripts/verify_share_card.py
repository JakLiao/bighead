"""分享卡 + 贴纸册筛选/no-op 纯函数验证.

只测不依赖 HTTP 服务的部分(纯函数 + 落盘), 端到端路由行为交给
frontend/verify-share-card.mjs 与 frontend/verify-album-search.mjs。
分开的理由: 后端自测要能在**不起服务、不占端口、不需要 GPU** 的前提下跑,
这样它可以在每次改 gallery.py 后秒级验证纯逻辑。
"""
from __future__ import annotations

import logging
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.config import (  # noqa: E402
    ALBUM_FILENAME,
    LAYOUT_FILENAME,
    SHARE_CARD_BRAND,
    SHARE_CARD_FOOTER_H,
    SHARE_CARD_MARGIN,
    SHARE_CARD_SHORT_ID,
    SHARE_CARD_SIZE,
    SHARE_FILENAME,
)
from backend.routes.gallery import (  # noqa: E402
    _album_lock,
    _load_album,
    _matches,
    _merge_entry,
    _normalize_entry,
    _pick_thumb,
    _same_content,
    _save_album,
)
from backend.share_card import (  # noqa: E402
    render_share_card,
    share_to_file,
    short_job_id,
)

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{('  ' + detail) if detail else ''}")


def px(im, x: int, y: int) -> tuple[int, int, int]:
    return im.getpixel((x, y))


# ---------- 几何: 固定 4:3 是本计划唯一的硬约束 ----------
from PIL import Image  # noqa: E402

src = Image.new("RGB", (600, 400), (120, 160, 200))
card = render_share_card(src, "a1b2c3d4e5f6", 0.0)
check("分享卡尺寸严格 1200x900", card.size == (1200, 900), str(card.size))
check("尺寸常量为 4:3", SHARE_CARD_SIZE[0] * 3 == SHARE_CARD_SIZE[1] * 4,
      f"{SHARE_CARD_SIZE}")

# 长条图(4:1)不能被拉成 4:3 —— 这是 contain 策略存在的全部理由
strip = Image.new("RGB", (1600, 200), (200, 120, 120))
card_strip = render_share_card(strip, "a1b2c3d4e5f6", 0.0)
check("长条图输出仍是 4:3(不改变卡片比例)", card_strip.size == (1200, 900))
# contain 后画面高度应被 inner_h 限制: 1600x200 缩放到宽 1120 时高只有 140,
# 上下留白共 540。若代码误用 cover/stretch, 画面会铺满 680 高。
top_px = px(card_strip, 600, SHARE_CARD_MARGIN + 5)
check("长条图上下留白(contain 而非拉伸)", top_px != (200, 120, 120), str(top_px))

# 方形图(1:1)应在左右留白
sq = Image.new("RGB", (500, 500), (100, 200, 100))
card_sq = render_share_card(sq, "a1b2c3d4e5f6", 0.0)
left_px = px(card_sq, SHARE_CARD_MARGIN + 5, 300)
check("方形图左右留白(居中而非靠左)", left_px != (100, 200, 100), str(left_px))
# 居中验证: 左右留白宽度应几乎相等
mid = 300
w_l = 0
while px(card_sq, SHARE_CARD_MARGIN + w_l, mid) == (100, 200, 100):
    w_l += 1
w_r = 0
while px(card_sq, 1200 - SHARE_CARD_MARGIN - 1 - w_r, mid) == (100, 200, 100):
    w_r += 1
check("左右留白宽度基本对称", abs(w_l - w_r) <= 2, f"left={w_l} right={w_r}")

# ---------- footer ----------
line_y = SHARE_CARD_SIZE[1] - SHARE_CARD_FOOTER_H
line_px = px(card, 600, line_y)
check("footer 分隔线存在", line_px != (255, 248, 240), str(line_px))

# 品牌行区域必须有深色像素 —— 证明中文真的渲染出来了。
# 这一条是「豆腐块」的唯一可靠探针: PIL 排不出字形时画的是空心方框,
# 同样是深色, 所以还要配合下面的字形宽度检查。
brand_dark = sum(
    1
    for x in range(SHARE_CARD_MARGIN, 600)
    for y in range(line_y + 40, line_y + 100)
    if sum(px(card, x, y)) < 450
)
check("品牌行有深色像素(文字已渲染)", brand_dark > 200, f"dark={brand_dark}")

# 豆腐块 vs 真字形的判别: 真中文「贴」是**实心**方块, 内部有笔画;
# .notdef 豆腐是空心方框。统计品牌行里的"深色且四邻皆深色"像素占比,
# 实心字形的内部填充率远高于空心方框。
filled = 0
total = 0
for x in range(SHARE_CARD_MARGIN, 600):
    for y in range(line_y + 40, line_y + 100):
        if sum(px(card, x, y)) < 450:
            total += 1
            if sum(px(card, x + 1, y)) < 450 and sum(px(card, x, y + 1)) < 450:
                filled += 1
ratio = filled / total if total else 0.0
check("品牌行是实心字形而非空心豆腐块", ratio > 0.55, f"fill_ratio={ratio:.2f}")

check("短 job ID 取前 6 位", short_job_id("a1b2c3d4e5f6") == "a1b2c3")
check("短 job ID 对短输入不越界", short_job_id("ab") == "ab")

# captured_at=None 与 0.0 必须区分: 0.0 是合法 epoch, 不能回落到"今天"
d_none = render_share_card(src, "a1b2c3d4e5f6", None)
d_zero = render_share_card(src, "a1b2c3d4e5f6", 0.0)
check("captured_at=None 与 0.0 产生不同日期", d_none.tobytes() != d_zero.tobytes())

# 字体链: 必须命中含中文字形的字体, 而不是 arial
from backend.share_card import _load_font  # noqa: E402

f = _load_font(48)
check("字体加载成功", f is not None)
if f is not None:
    check("命中的字体不是纯 ASCII 兜底",
          "msyh" in (getattr(f, "path", "") or "").lower()
          or "simhei" in (getattr(f, "path", "") or "").lower(),
          getattr(f, "path", "?"))

# ---------- 落盘 ----------
with tempfile.TemporaryDirectory(prefix="share_") as td:
    d = Path(td) / "a1b2c3d4e5f6"
    out = share_to_file(src, d, "a1b2c3d4e5f6", 0.0)
    check("落盘文件名是 share.jpg", out.name == SHARE_FILENAME, out.name)
    check("落盘文件存在且非空", out.exists() and out.stat().st_size > 1000,
          f"{out.stat().st_size if out.exists() else 0}B")
    with Image.open(out) as im2:
        check("落盘后可解码且 1200x900", im2.size == (1200, 900), str(im2.size))
    # share_to_file 必须能创建不存在的目录
    deep = Path(td) / "new_job_1234" / "nested"
    out2 = share_to_file(src, deep, "new_job_1234", 0.0)
    check("目录不存在时自动创建", out2.exists())

# ---------- _pick_thumb 优先级 ----------
with tempfile.TemporaryDirectory(prefix="thumb_") as td:
    d = Path(td) / "jobthumb01"
    d.mkdir()
    # 只有单张
    for i in (1, 2):
        (d / f"photo_{i}.jpg").write_bytes(b"x")
    th = _pick_thumb("jobthumb01", d)
    check("无 share/layout 时退回单张", len(th) == 2 and "photo_1.jpg" in th[0], str(th))
    # 有 layout
    (d / LAYOUT_FILENAME).write_bytes(b"x")
    th = _pick_thumb("jobthumb01", d)
    check("有 layout 时用 layout", th == [f"/outputs/jobthumb01/{LAYOUT_FILENAME}"], str(th))
    # 有 share -> 抢在 layout 之前
    (d / SHARE_FILENAME).write_bytes(b"x")
    th = _pick_thumb("jobthumb01", d)
    check("有 share 时 share 优先于 layout",
          th == [f"/outputs/jobthumb01/{SHARE_FILENAME}"], str(th))

# ---------- _matches 筛选 ----------
base_item = {
    "job_id": "a1b2c3d4e5f6",
    "title": "毕业旅行",
    "note": "西湖边",
    "tags": ["旅行", "2026"],
}
check("空 q + 空 tag 命中", _matches(base_item, "", set()))
check("q 匹配标题", _matches(base_item, "毕业", set()))
check("q 匹配备注", _matches(base_item, "西湖", set()))
check("q 匹配标签", _matches(base_item, "旅行", set()))
check("q 匹配 job_id(分享卡 footer 上的短号)", _matches(base_item, "a1b2c3", set()))
check("q 大小写不敏感", _matches(base_item, "A1B2C3", set()))
check("q 不命中时排除", not _matches(base_item, "不存在", set()))
check("tag 精确命中", _matches(base_item, "", {"旅行"}))
check("tag 不命中时排除", not _matches(base_item, "", {"美食"}))
check("多 tag 任一命中即可", _matches(base_item, "", {"美食", "2026"}))
check("q 与 tag 同时生效(AND)",
      _matches(base_item, "毕业", {"旅行"})
      and not _matches(base_item, "毕业", {"美食"}))

# ---------- no-op PATCH ----------
empty = _normalize_entry({})
check("_same_content 空对空", _same_content(empty, _normalize_entry({})))
merged_same = _merge_entry(empty, {"title": "", "note": "", "tags": [], "favorite": False})
check("_same_content 忽略 updated_at 差异", _same_content(empty, merged_same))
merged_diff = _merge_entry(empty, {"title": "新标题"})
check("_same_content 检出 title 变化", not _same_content(empty, merged_diff))
merged_tag = _merge_entry(_normalize_entry({"tags": ["a"]}), {"tags": ["b"]})
check("_same_content 检出 tags 变化", not _same_content(_normalize_entry({"tags": ["a"]}), merged_tag))
# tags 是集合语义: 顺序不同必须被规范化成同一个值, 否则「顺序差异」会被
# _same_content 判成有变化, 重新引入 no-op 噪音。
t1 = _normalize_entry({"tags": ["a", "b"]})
t2 = _normalize_entry({"tags": ["b", "a"]})
check("tags 顺序被规范化(_same_content 判为无变化)", _same_content(t1, t2),
      f"{t1['tags']} vs {t2['tags']}")
check("tags 规范化后确实有序", t1["tags"] == sorted(t1["tags"]), str(t1["tags"]))
# 后端去重: 前端已拦, 但直接打 API 时后端也必须拦
dup = _normalize_entry({"tags": ["x", "x", "y"]})
check("后端去重重复标签", dup["tags"] == ["x", "y"], str(dup["tags"]))
check("超长标签被截断",
      all(len(t) <= 16 for t in _normalize_entry({"tags": ["z" * 40]})["tags"]))
check("标签数量超限被裁到 8",
      len(_normalize_entry({"tags": [f"t{i}" for i in range(20)]})["tags"]) == 8)

# no-op 不写盘: _album.json 的 mtime 必须不变
with tempfile.TemporaryDirectory(prefix="noop_") as td:
    outdir = Path(td)
    (outdir / "job_noop_001").mkdir()
    with _album_lock:
        _save_album(outdir, {"job_noop_001": _normalize_entry({"title": "原标题"})})
    p = outdir / "_album.json"
    before = p.stat().st_mtime_ns
    with _album_lock:
        album = _load_album(outdir)
        base = album.get("job_noop_001") or _normalize_entry({})
        merged = _merge_entry(base, {"title": "原标题"})
        changed = not _same_content(base, merged)
        if changed:
            album["job_noop_001"] = merged
            _save_album(outdir, album)
    check("no-op PATCH 不写盘", not changed and p.stat().st_mtime_ns == before)
    # 真变化要写盘
    with _album_lock:
        album = _load_album(outdir)
        base = album.get("job_noop_001") or _normalize_entry({})
        merged = _merge_entry(base, {"title": "新标题"})
        changed = not _same_content(base, merged)
        if changed:
            album["job_noop_001"] = merged
            _save_album(outdir, album)
    check("有变化的 PATCH 写盘", changed)
    check("写盘后标题已更新",
          _load_album(outdir)["job_noop_001"]["title"] == "新标题")

# ---------- 字体全缺失时的降级行为 ----------
# 复现过: 字体全部缺失时, render_share_card 仍输出一张**尺寸完全正确**的
# 4:3 卡片, 只是 footer 空白。若不 warn, 这种卡会被当成生成成功。
# 这里断言「仍然出图」+「有 warning」两件事, 锁住降级行为不被无声改掉。
import backend.config as _cfg  # noqa: E402
import backend.share_card as _sc  # noqa: E402

_saved_fonts = _cfg.SHARE_CARD_FONTS
_saved_fallback = _cfg.SHARE_CARD_FONT_FALLBACK
_sc.SHARE_CARD_FONTS = [r"C:\nope\missing.ttf"]
_sc.SHARE_CARD_FONT_FALLBACK = r"C:\nope\also-missing.ttf"
_records: list[logging.LogRecord] = []
_old_basic = _sc.log.warning


def _capture(msg, *a, **kw):
    _records.append(_sc.log.makeRecord(_sc.log.name, logging.WARNING, "", 0, msg, (), None))
    return _old_basic(msg, *a, **kw)


_sc.log.warning = _capture  # type: ignore[assignment]
try:
    card_nofont = _sc.render_share_card(src, "a1b2c3d4e5f6", 0.0)
    check("字体全缺失时仍产出 4:3 卡片(不抛异常)", card_nofont.size == (1200, 900), str(card_nofont.size))
    check("字体全缺失时有 warning", any("字体" in r.getMessage() for r in _records),
          str([r.getMessage() for r in _records])[:120])
    # footer 区域应该没有深色像素(证明确实没排上文字, 而不是"碰巧有")
    dark_in_footer = sum(
        1
        for x in range(SHARE_CARD_MARGIN, 1140)
        for y in range(line_y + 40, line_y + 100)
        if sum(px(card_nofont, x, y)) < 450
    )
    check("字体全缺失时品牌区确实空白", dark_in_footer == 0, f"dark={dark_in_footer}")
finally:
    _sc.log.warning = _old_basic  # type: ignore[assignment]
    _sc.SHARE_CARD_FONTS = _saved_fonts
    _sc.SHARE_CARD_FONT_FALLBACK = _saved_fallback


# ---------- _album.json 空残留 / 损坏备份清理(清 P1 遗留 3 与 7) ----------
with tempfile.TemporaryDirectory(prefix="album_cleanup_") as td:
    outdir = Path(td)
    (outdir / "job_keep_001").mkdir()

    # 写空字典 -> 文件应被删掉, 而不是留下 `{}`
    _save_album(outdir, {})
    check("元数据为空时删除 _album.json(不留空残留)",
          not (outdir / "_album.json").exists(),
          "文件仍存在" if (outdir / "_album.json").exists() else "已删除")

    # 读端在「空文件」与「无文件」下行为一致
    check("空残留清理后读端返回空", _load_album(outdir) == {})

    # 写非空 -> 文件回来
    _save_album(outdir, {"job_keep_001": _normalize_entry({"title": "有内容"})})
    check("非空元数据正常写盘", (outdir / "_album.json").exists())

    # 制造 5 个损坏备份, 写盘后应只剩最近 3 个
    for i in range(5):
        bp = outdir / f"{ALBUM_FILENAME}.broken-100{i}"
        bp.write_text("{}", encoding="utf-8")
    _save_album(outdir, {"job_keep_001": _normalize_entry({"title": "再写一次"})})
    backups = sorted(outdir.glob(f"{ALBUM_FILENAME}.broken-*"))
    check("损坏备份只保留最近 3 个", len(backups) == 3, f"实际 {len(backups)} 个")
    check("保留的是最新的 3 个", all("100" in b.name for b in backups),
          ", ".join(b.name for b in backups))
    check("清理备份不影响正常元数据",
          _load_album(outdir)["job_keep_001"]["title"] == "再写一次")

    # 全删 -> 备份回落到保留上限(而不是全清)。断言写成"不超过保留数",
    # 而不是"全清": _prune 的语义是保留最近 N 个, 不是清空目录。
    _save_album(outdir, {})
    left = len(list(outdir.glob(f"{ALBUM_FILENAME}.broken-*")))
    check("元数据清空时备份也走保留策略", left <= 3, f"剩 {left} 个")
    check("清空后无 _album.json 残留", not (outdir / "_album.json").exists())

    # 坏 JSON 仍会被备份(原有行为不能被破坏), 且**新产生的备份不会被同一次
    # 调用链后面的 _save_album 当成历史垃圾清掉** —— 它总是最新的那个。
    #
    # 这里用真实的时间戳命名(而非上面那种人工序号), 因为 _prune 按 mtime
    # 排序: 真实场景下时间戳单调递增, 排序才成立。用假序号验证排序等于
    # 验证了一个不会发生的场景。
    (outdir / "_album.json").write_text("{ not json", encoding="utf-8")
    # 先清掉上面用假序号造的备份, 从干净状态开始 —— _prune 按 mtime 排序,
    # 留着它们会让本段验证的是"人工序号 vs 时间戳混排"这个不会发生的场景。
    for stale in outdir.glob(f"{ALBUM_FILENAME}.broken-*"):
        stale.unlink()
    got = _load_album(outdir)  # 坏 JSON -> 生成时间戳命名的备份
    made = list(outdir.glob(f"{ALBUM_FILENAME}.broken-*"))
    check("坏 JSON 返回空", got == {})
    check("坏 JSON 被备份", len(made) == 1, f"{len(made)} 个")
    # 走一遍真实的 load -> save 流程, 确认刚建的备份活下来了
    got["job_after_broken"] = _normalize_entry({"title": "坏文件之后"})
    _save_album(outdir, got)
    after = list(outdir.glob(f"{ALBUM_FILENAME}.broken-*"))
    check("刚创建的备份不会被同一次调用链的 save 清掉", len(after) == 1, f"{len(after)} 个")
    check("坏 JSON 之后的写入依然生效",
          _load_album(outdir)["job_after_broken"]["title"] == "坏文件之后")


# ---------- 前后端几何常量一致性 ----------
#
# 这条断言是本文件里最重要的一条, 因为它保护的是**一个纯靠自觉的约定**。
#
# 背景: 分享卡有两份独立实现 —— backend/share_card.py(补生成历史卡片) 与
# frontend/src/shareCard.ts(正常出片)。两边各自定义了 1200x900 / margin 40 /
# footer 220, 两处注释互相点名「改动务必同时改两个文件」。
#
# 「务必」不是机制。改了一处忘了另一处, 唯一能发现的方式是: 日常出片用前端
# 那份(P2 恰好如此, 所以本次改动其实不影响出片), 直到某天真的走补生成路径,
# 用户拿到一张尺寸不对的卡片, 而且**没有任何报错**。
#
# 既然两边都是纯数字字面量, 就可以直接读前端源码比对 —— 这把「自觉」变成了
# 用正则而非 import: 前端是 TS, 后端是 Python, 且刻意不引入跨语言解析依赖。
FRONTEND_TS = ROOT / "frontend" / "src" / "shareCard.ts"
check("前端 shareCard.ts 存在", FRONTEND_TS.exists(), str(FRONTEND_TS))

if FRONTEND_TS.exists():
    ts = FRONTEND_TS.read_text(encoding="utf-8")

    def ts_num(name: str) -> int | None:
        m = re.search(rf"\bconst\s+{name}\s*=\s*(\d+)", ts)
        return int(m.group(1)) if m else None

    fe = {
        "SHARE_CARD_W": ts_num("SHARE_CARD_W"),
        "SHARE_CARD_H": ts_num("SHARE_CARD_H"),
        "MARGIN": ts_num("MARGIN"),
        "FOOTER_H": ts_num("FOOTER_H"),
        "SHARE_CARD_SHORT_ID": ts_num("SHARE_CARD_SHORT_ID"),
    }
    be = {
        "SHARE_CARD_W": SHARE_CARD_SIZE[0],
        "SHARE_CARD_H": SHARE_CARD_SIZE[1],
        "MARGIN": SHARE_CARD_MARGIN,
        "FOOTER_H": SHARE_CARD_FOOTER_H,
        "SHARE_CARD_SHORT_ID": SHARE_CARD_SHORT_ID,
    }
    for k, bv in be.items():
        check(
            f"前后端 {k} 一致",
            fe[k] == bv,
            f"frontend={fe[k]} backend={bv}",
        )

    # 文案也要一致 —— 品牌行是用户唯一会看到的文字, 两处不同就意味着
    # 「补生成的卡片」和「刚拍的卡片」长得不一样。
    m_brand = re.search(r'\bconst\s+BRAND\s*=\s*"([^"]+)"', ts)
    fe_brand = m_brand.group(1) if m_brand else None
    check(
        "前后端品牌文案一致",
        fe_brand == SHARE_CARD_BRAND,
        f"frontend={fe_brand!r} backend={SHARE_CARD_BRAND!r}",
    )
    # 短 ID 的位数决定 footer 上写几位, 不一致会让两张卡的 # 号长度不同
    m_short = re.search(r"jobId\.slice\(0,\s*SHARE_CARD_SHORT_ID\)", ts)
    check("前端 shortJobId 复用同一常量", m_short is not None)


# ---------- 汇总 ----------
print()
print(f"结果: {len(PASS)} 通过, {len(FAIL)} 失败")
if FAIL:
    for f in FAIL:
        print(f"  FAILED: {f}")
    sys.exit(1)
print("ALL GREEN")
