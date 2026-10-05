"""贴纸册元数据纯函数验证.
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.config import ALBUM_FILENAME  # noqa: E402
from backend.routes.gallery import (  # noqa: E402
    _album_lock,
    _album_path,
    _load_album,
    _save_album,
    _validate_job_id,
    _normalize_entry,
    _merge_entry,
)

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{('  ' + detail) if detail else ''}")


# ---------- _validate_job_id ----------
check("合法 job_id 接受", _validate_job_id("job_20260101_abc123") is None)
err = _validate_job_id("../etc/passwd")
check(".. 路径穿越拒绝", err is not None, err or "")
err = _validate_job_id("a/b")
check("/ 子路径拒绝", err is not None, err or "")
err = _validate_job_id("")
check("空字符串拒绝", err is not None, err or "")
err = _validate_job_id("a" * 200)
check("过长拒绝", err is not None, err or "")
err = _validate_job_id("_xxx_album")
check("_ 开头拒绝(与 GET 跳过契约一致)", err is not None, err or "")


# ---------- _normalize_entry ----------
e = _normalize_entry({})
check("空 patch → 默认 title 空", e["title"] == "")
check("空 patch → 默认 favorite 假", e["favorite"] is False)
check("空 patch → 默认 tags []", e["tags"] == [])
check("空 patch → updated_at 是 int", isinstance(e["updated_at"], int))


# ---------- _merge_entry ----------
base = {"title": "T", "note": "N", "tags": ["a"], "favorite": False, "updated_at": 1}
patch = {"title": "T2", "favorite": True}
out = _merge_entry(base, patch)
check("合并后 title 被覆盖", out["title"] == "T2")
check("合并后 favorite 被覆盖", out["favorite"] is True)
check("合并后 note 保留", out["note"] == "N")
check("合并后 tags 保留", out["tags"] == ["a"])
check("合并后 updated_at 单调递增", out["updated_at"] > 1)


# ---------- _load / _save 落盘与原子替换 ----------
with tempfile.TemporaryDirectory(prefix="album_io_") as td:
    outdir = Path(td)
    p = _album_path(outdir)
    check("sidecar 在 OUTPUT_DIR 顶层", p.parent == outdir)
    check("sidecar 用 _album.json", p.name == ALBUM_FILENAME)

    _save_album(outdir, {"j1": {"title": "x"}})
    raw = json.loads(p.read_text(encoding="utf-8"))
    check("落盘后能读回", raw == {"j1": {"title": "x"}})

    loaded = _load_album(outdir)
    check("保存后 _load_album 能读回", loaded == {"j1": {"title": "x"}})
    check("空 album 返回空 dict", _load_album(Path(tempfile.mkdtemp())) == {})


# ---------- DELETE 端到端: rmtree 真删 + 元数据 pop ----------
import shutil as _shutil
with tempfile.TemporaryDirectory(prefix="album_del_") as td:
    outdir = Path(td)
    (outdir / "job_xxx").mkdir()
    (outdir / "job_xxx" / "layout.jpg").write_bytes(b"fake")
    _save_album(outdir, {"job_xxx": {"title": "x", "tags": [], "note": "", "favorite": False, "updated_at": 1}})
    # 模拟 gallery_delete 内部动作
    _shutil.rmtree(outdir / "job_xxx")
    with _album_lock:
        album = _load_album(outdir)
        album.pop("job_xxx", None)
        _save_album(outdir, album)
    check("rmtree 后目录真没了", not (outdir / "job_xxx").exists())
    check("rmtree 后元数据 pop 了", "job_xxx" not in _load_album(outdir))


# ---------- C1 修复验证: 损坏文件被备份而非静默丢 ----------
with tempfile.TemporaryDirectory(prefix="album_corrupt_") as td:
    outdir = Path(td)
    bad = _album_path(outdir)
    bad.write_text("{ this is not valid json", encoding="utf-8")
    result = _load_album(outdir)
    check("损坏文件返回空 dict", result == {})
    backups = list(outdir.glob("_album.json.broken-*"))
    check("损坏文件被重命名备份", len(backups) == 1, str(backups))
    check("损坏文件本身被移走", not bad.exists())


print(f"\nResult: {len(PASS)} passed, {len(FAIL)} failed")
sys.exit(0 if not FAIL else 1)