"""顶层 layout.jpg 镜像的磁盘占用验证.

`_mirror_layout_to_top` 存在的唯一理由是让 gallery.py 的**非递归**探测
对 AI 路径同样生效(见 backend/routes/gallery.py 的 _pick_thumb)。
但它此前用 shutil.copyfile —— 同一张图在磁盘上存了两份。

硬链接 os.link 让两个路径指向同一份数据:
    - 磁盘占用 = 1 份(不是 2 份)
    - 两个路径都能正常读(gallery 探测顶层、前端抓顶层都成立)

失败要退回 copyfile 而不是抛异常: 这是一份冗余副本, 写不出来
不应该让 build_ai_layout 整条走进 except 返回 None。

跑法(webui venv, 解释器错会缺 torch):
    & "E:\\Code\\stable-diffusion-webui\\.venv\\Scripts\\python.exe" backend\\scripts\\verify_mirror.py
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.config import LAYOUT_FILENAME  # noqa: E402
from backend.pipeline import _mirror_layout_to_top  # noqa: E402

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{('  ' + detail) if detail else ''}")


def make_job(root: Path, job_id: str = "job_20260101_abc123", style: str = "film") -> Path:
    """造一个 outputs/{job_id}/ai/{style}/layout.jpg, 返回该文件路径。"""
    out = root / job_id / "ai" / style / LAYOUT_FILENAME
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(b"fake-jpeg-bytes" * 100)
    return out


def _png_bytes(w: int, h: int, rgb: tuple[int, int, int]) -> bytes:
    """造一张纯色 PNG 的字节, 供 layout_make 的 images 参数用。

    layout_make 的 images 是 UploadFile, 直接调用时传原始字节即可
    (Pillow 靠魔数嗅探, 不在乎扩展名)。
    """
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (w, h), rgb).save(buf, format="PNG")
    return buf.getvalue()


# ---------- 硬链接: 磁盘只占一份 ----------
with tempfile.TemporaryDirectory() as td:
    root = Path(td)
    src = make_job(root)
    _mirror_layout_to_top(src)
    top = src.parent.parent.parent / LAYOUT_FILENAME

    check("顶层副本已生成", top.exists())
    check("顶层与源内容一致", top.read_bytes() == src.read_bytes())
    check(
        "顶层与源共享 inode(硬链接, 非拷贝)",
        os.stat(top).st_ino == os.stat(src).st_ino,
        f"ino={os.stat(top).st_ino} vs {os.stat(src).st_ino}",
    )
    # 源文件链接数 >= 2 证明是硬链接而不是 copy —— copy 出来的是两个独立 inode。
    # 注意: 不要写「字节数不翻倍」这类断言, st_size 在拷贝后同样相等,
    # 它恒为真、证明不了任何东西。区分力只来自 inode 与 nlink。
    check("源文件链接数 >= 2", src.stat().st_nlink >= 2, f"nlink={src.stat().st_nlink}")

# ---------- 幂等: 已有顶层文件时被覆盖而不是报错 ----------
with tempfile.TemporaryDirectory() as td:
    root = Path(td)
    src = make_job(root, "job_20260101_twice")
    top = src.parent.parent.parent / LAYOUT_FILENAME
    top.write_bytes(b"stale")
    _mirror_layout_to_top(src)
    check("已有陈旧顶层文件被覆盖", top.read_bytes() == src.read_bytes())

# ---------- 源已在顶层时直接返回(不自我链接) ----------
with tempfile.TemporaryDirectory() as td:
    root = Path(td)
    top = root / "job_20260101_flat" / LAYOUT_FILENAME
    top.parent.mkdir(parents=True, exist_ok=True)
    top.write_bytes(b"already-top")
    _mirror_layout_to_top(top)
    check("源已在顶层时内容不变", top.read_bytes() == b"already-top")

# ---------- 源不存在时静默失败, 不抛 ----------
with tempfile.TemporaryDirectory() as td:
    root = Path(td)
    missing = root / "job_20260101_gone" / "ai" / "film" / LAYOUT_FILENAME
    missing.parent.mkdir(parents=True, exist_ok=True)
    try:
        _mirror_layout_to_top(missing)
        check("源缺失时静默返回(不抛异常)", True)
    except Exception as e:  # noqa: BLE001
        check("源缺失时静默返回(不抛异常)", False, repr(e))

# ---------- 已有非链接的旧副本: 硬链接会失败, 必须退回拷贝 ----------
with tempfile.TemporaryDirectory() as td:
    root = Path(td)
    src = make_job(root, "job_20260101_fallback")
    top = src.parent.parent.parent / LAYOUT_FILENAME
    # 模拟历史遗留: 顶层已存在一个独立的拷贝, 且磁盘满/无权限时
    # os.link 会失败。去掉顶层写权限在 Windows 上不生效, 改用
    # 直接占位成一个**目录** —— os.link 必然失败, 与权限无关。
    top.mkdir(parents=True, exist_ok=True)
    try:
        _mirror_layout_to_top(src)
        check("硬链接失败时不抛异常(降级路径可存活)", True)
    except Exception as e:  # noqa: BLE001
        check("硬链接失败时不抛异常(降级路径可存活)", False, repr(e))

# ---------- 硬链接的代价: 顶层被覆写会**连带改掉 AI 拼图** ----------
#
# 这是 os.link 唯一真正的风险, 也是本文件最重要的一条断言。
# 硬链接不是"两份数据", 而是**一个 inode 两个名字**。所以任何对顶层
# layout.jpg 的**原地覆写**都会透过链接改到 ai/{style}/layout.jpg。
#
# 而这条路径是真实存在的: 非AI 拼图(frontend 的 makeLayoutToJob)会带
# job_id 调 /api/layout/make, 后端执行
#     (job_dir / LAYOUT_FILENAME).write_bytes(data)      <- layout.py
# 同一个 job 先跑过 AI 写真(已建链接)、再补一次普通拼图, AI 拼图就被冲掉,
# 而 gallery 的缩略图仍指向顶层, 看上去一切正常 —— 静默的数据损坏。
#
# 注意 write_bytes 是 open(truncate) 语义, 不像 unlink+create。
# 下面的断言就是钉住这一点: 覆写后 deep 必须还是原来的内容。
with tempfile.TemporaryDirectory() as td:
    root = Path(td)
    src = make_job(root, "job_20260101_overwrite")
    _mirror_layout_to_top(src)
    top = src.parent.parent.parent / LAYOUT_FILENAME
    before = src.read_bytes()

    # 走**真实的** layout_make, 而不是在这里复刻一遍它的写法——
    # 复刻的那份会随 layout.py 改动而失效, 于是断言还在绿、bug 已经回来。
    #
    # 要 monkeypatch 的是 gallery 的 OUTPUT_DIR: layout.py 自己不引用它,
    # 路径解析全委托给 gallery._resolve_job_dir(见 layout.py 的 import)。
    # 只 patch gallery 一处即可, patch 一个不存在的模块属性会 AttributeError。
    from backend.routes import gallery as gallery_mod
    from backend.routes.layout import layout_make

    job_id = "job_20260101_overwrite"
    orig_out = gallery_mod.OUTPUT_DIR
    try:
        gallery_mod.OUTPUT_DIR = root
        layout_make(
            images=[
                _png_bytes(300, 200, (200, 30, 30)),
                _png_bytes(300, 200, (30, 200, 30)),
                _png_bytes(300, 200, (30, 30, 200)),
                _png_bytes(300, 200, (200, 200, 30)),
            ],
            layout="2x2",
            frame="none",
            job_id=job_id,
        )
    finally:
        gallery_mod.OUTPUT_DIR = orig_out

    check(
        "顶层被覆写后, ai/{style}/layout.jpg 内容不受影响",
        src.read_bytes() == before,
        f"deep={src.read_bytes()[:24]!r}",
    )
    check(
        "覆写后顶层与深层已解绑(不再是同一个 inode)",
        top.stat().st_ino != src.stat().st_ino,
    )
    check("顶层确实换成了新拼图(不是没写)", top.stat().st_size > 0)

# ---------- 汇总 ----------
print()
print(f"Result: {len(PASS)} passed, {len(FAIL)} failed")
for f in FAIL:
    print(f"  [FAIL] {f}")
print("ALL GREEN" if not FAIL else "HAS FAILURES")
sys.exit(0 if not FAIL else 1)
