"""画廊:扫描 outputs/,列出历次任务;并维护 _album.json 元数据侧车."""
from __future__ import annotations

import json
import os
import re
import shutil
import time
from pathlib import Path
from threading import Lock

from fastapi import APIRouter, Body, HTTPException

from ..config import (
    ALBUM_FILENAME,
    ALBUM_MAX_NOTE,
    ALBUM_MAX_TAG,
    ALBUM_MAX_TAGS,
    ALBUM_MAX_TITLE,
    LAYOUT_FILENAME,
    OUTPUT_DIR,
    SHARE_FILENAME,
)

router = APIRouter()

# job_id 必须是文件系统安全且相对短的 token。规则:字母数字下划线, 长度 4~64。
# 首字符必须是字母数字 —— GET 路由 gallery() 会跳过 _ 与 . 开头的目录,
# 不限制首字符会让 PATCH/DELETE 改得到但 GET 看不到, 前后端契约不一致。
# 比对 URL 后再 resolve() 到 OUTPUT_DIR 内, 双层防御, 任意一层失守也不会
# 越过 OUTPUT_DIR 边界。
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$")

# 单进程内对 _album.json 的所有读写都过这个锁。读也加锁, 否则 PATCH 与
# GET 之间会出现「读到中间态」的可能。单机自用, 不需要跨进程。
_album_lock = Lock()


# ---------------------------------------------------------------------------
# 私有助手(被 verify_album_meta.py 与路由共享)
# ---------------------------------------------------------------------------
def _validate_job_id(job_id: str) -> str | None:
    """合法返回 None, 不合法返回错误描述。"""
    if not _JOB_ID_RE.match(job_id):
        return "job_id 必须是 4~64 位的 [A-Za-z0-9_-], 且首字符为字母数字"
    return None


def _album_path(outdir: Path) -> Path:
    return outdir / ALBUM_FILENAME


def _load_album(outdir: Path) -> dict:
    p = _album_path(outdir)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        # 文件坏了不能让整个 /api/gallery 挂掉, 但直接把坏文件丢在这里
        # 下次 _save_album 会覆盖它 —— 原始元数据不可逆丢失。
        # 改: 重命名为 _album.json.broken-<ts> 备份, 让用户能手工恢复。
        # OSError 一般是 IO 抖动, 文件不一定真坏, 不备份, 直接返回 {}。
        try:
            backup = p.with_name(f"{p.name}.broken-{int(time.time())}")
            os.replace(p, backup)
        except OSError:
            pass
        return {}
    except OSError:
        return {}


def _save_album(outdir: Path, album: dict) -> None:
    """原子写: 写 .tmp 再 os.replace。读端不需要看到中间态。"""
    p = _album_path(outdir)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(album, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, p)


def _normalize_entry(patch: dict) -> dict:
    """把前端 PATCH 的部分字段补齐成完整条目。"""
    title = str(patch.get("title") or "")[:ALBUM_MAX_TITLE]
    note = str(patch.get("note") or "")[:ALBUM_MAX_NOTE]
    raw_tags = patch.get("tags") or []
    if not isinstance(raw_tags, list):
        raw_tags = []
    # 去重 + 排序。
    #
    # 去重: 前端 AlbumEditor.addTag 已用 includes 拦了重复, 但那是**前端**
    # 的保证 —— 直接打 API、或换客户端, 重复项就会进库。同一标签出现两次
    # 在 UI 上只显示一个 chip, 用户会以为存坏了。
    #
    # 排序: 标签是**集合**语义, ["旅行","2026"] 与 ["2026","旅行"] 对用户
    # 是同一件事。不规范化顺序的话, _same_content 会把它们判为有变化,
    # 于是「什么都没改」也会写盘并 bump updated_at —— 恰好是 no-op 拦截
    # 要消除的那种噪音。排序让顺序差异被吸收成 no-op。
    tags = sorted({str(t)[:ALBUM_MAX_TAG] for t in raw_tags[:ALBUM_MAX_TAGS]})
    favorite = bool(patch.get("favorite"))
    return {
        "title": title,
        "note": note,
        "tags": tags,
        "favorite": favorite,
        "updated_at": int(time.time()),
    }


def _merge_entry(base: dict, patch: dict) -> dict:
    """PATCH 语义: 只覆盖 patch 里出现的 key, 其余从 base 继承。
    updated_at 必须单调递增, 即便前端时钟倒流, 也不允许回退。
    """
    out = dict(base)
    nxt = _normalize_entry(patch)
    # 只有 patch 里明确给出的 key 才覆盖, 避免 _normalize_entry 的缺省值
    # 把 base 的现有 note/tags 抹成空串/空列表。updated_at 是隐式字段,
    # 永远要 bump。
    present = set(patch.keys())
    for k, v in nxt.items():
        if k == "updated_at":
            out[k] = max(int(out.get(k, 0)), int(v))
        elif k in present:
            out[k] = v
    return out


def _resolve_job_dir(job_id: str) -> Path:
    """校验 + 解析为绝对路径。校验失败抛 400, 越界抛 400。"""
    err = _validate_job_id(job_id)
    if err:
        raise HTTPException(400, err)
    target = (OUTPUT_DIR / job_id).resolve()
    # resolve() 后必须仍在 OUTPUT_DIR.resolve() 内 —— 防 ../ 与符号链接。
    out_abs = OUTPUT_DIR.resolve()
    try:
        target.relative_to(out_abs)
    except ValueError:
        raise HTTPException(400, "job_id 越界")
    return target


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------
def _pick_thumb(entry_name: str, entry: Path) -> list[str]:
    """挑缩略图: 分享卡 > 拼图 > 单张。

    分享卡排最前不是随意的 —— 它是唯一带品牌 footer 的成品, 也是用户
    实际想分享/回看的那一张。拼图次之。都没有才退回 4 张单图。

    用 LAYOUT_FILENAME/SHARE_FILENAME 常量而不是字面量: 原代码硬编码
    "layout.jpg" 而 config.py 里的同名常量没人用, 新增第三处硬编码只会
    让下次改名漏改更多地方。
    """
    share = entry / SHARE_FILENAME
    if share.exists():
        return [f"/outputs/{entry_name}/{SHARE_FILENAME}"]
    layout = entry / LAYOUT_FILENAME
    if layout.exists():
        return [f"/outputs/{entry_name}/{LAYOUT_FILENAME}"]
    return [f"/outputs/{entry_name}/{f.name}"
            for f in sorted(entry.glob("photo_*.jpg"))[:4]]


def _matches(item: dict, needle: str, want_tags: set[str]) -> bool:
    """筛选: q 命中 title/note/tags/job_id 任一, 或与 want_tags 有交集。

    刻意让 q 也搜 job_id: 用户从 URL 或分享卡 footer 上看到的是 #a1b2c3,
    让他能直接把那 6 位粘回搜索框找到那张卡。

    needle 的 lower() 在**本函数内**做, 不依赖调用方归一化 —— 早先把
    lower 放在 gallery() 里, 结果这个纯函数单测时大小写不敏感就失效,
    而通过 HTTP 的路径又是好的: 一个「测出来是好的、实际靠调用方记得
    传对」的隐式契约, 比显式多一行 lower 危险得多。
    """
    if want_tags and not (want_tags & set(item["tags"])):
        return False
    if not needle:
        return True
    hay = " ".join([
        item["job_id"], item["title"], item["note"], " ".join(item["tags"]),
    ]).lower()
    return needle.lower() in hay


@router.get("/api/gallery")
def gallery(q: str = "", tag: str = ""):
    """扫描 outputs/ 列出历次任务, 合并 _album.json 元数据。

    排序规则(固定, 不提供切换): favorite 优先, 同组内按 mtime 倒序。
    不在 album 但存在于磁盘的条目以缺省元数据呈现。
    不在磁盘但存在于 album 的条目是孤儿, 直接丢弃(保留在文件里供手工恢复)。

    筛选放在**服务端**而不是前端: 前端过滤只能隐藏已经传过来的条目,
    /api/gallery 仍会把全部 URL 发过去。放后端才能让 ?q=xx 成为一个可复现、
    可分享、刷新后保持的链接。

    刻意用同步 def: 纯磁盘 IO, 跑线程池; 与改前一致。
    """
    album = _load_album(OUTPUT_DIR)
    if not OUTPUT_DIR.exists():
        return {"items": [], "tags": []}
    needle = q.strip().lower()
    want_tags = {t.strip() for t in tag.split(",") if t.strip()}
    raw: list[tuple[str, int, dict]] = []
    for entry in sorted(OUTPUT_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not entry.is_dir():
            # _album.json 与 _smoke/_verify 等都从这里走掉, 不会进 items
            continue
        if entry.name.startswith("_") or entry.name.startswith("."):
            continue
        thumbs = _pick_thumb(entry.name, entry)
        mtime = int(entry.stat().st_mtime)
        meta = album.get(entry.name) or {}
        # 缺省补齐 —— 不能让前端拿到 None.title
        merged = _merge_entry(_normalize_entry({}), meta)
        item = {
            "job_id": entry.name,
            "mtime": mtime,
            "thumbs": thumbs,
            **merged,
        }
        if not _matches(item, needle, want_tags):
            continue
        raw.append((entry.name, mtime, item))
    # 排序: favorite True 在前, 同组内 mtime 降序
    raw.sort(key=lambda t: (not t[2]["favorite"], -t[1]))
    items = [t[2] for t in raw]
    # tags 汇总(按 count 降序, 同 count 按名称升序), 供前端渲染筛选条。
    # 只统计**筛选后**的结果: 否则用户搜完之后, 筛选条上仍显示一堆
    # 在当前结果里根本不存在的标签, 点下去得到空列表。
    counts: dict[str, int] = {}
    for it in items:
        for t in it["tags"]:
            counts[t] = counts.get(t, 0) + 1
    return {
        "items": items,
        "tags": [{"tag": t, "count": c} for t, c in
                 sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))],
    }


def _same_content(a: dict, b: dict) -> bool:
    """只比较用户可见的四个字段, 忽略 updated_at。

    updated_at 必须排除: 它在 _merge_entry 里**总是**被 bump, 拿它参与比较
    会让本函数恒为 False —— 拦截逻辑就成了永远不成立的死分支, 而且它
    不会报错, 只是静默失效。这是最难发现的一类 bug: 看起来在防护, 实际
    从未生效。
    """
    defaults = _normalize_entry({})
    return all(a.get(k, defaults[k]) == b.get(k)
               for k in ("title", "note", "tags", "favorite"))


@router.patch("/api/gallery/{job_id}")
def gallery_patch(job_id: str, body: dict = Body(default_factory=dict)):
    """局部更新元数据。内容无变化时不写盘, 返回 changed=False。

    不拦的话, 用户只是打开抽屉又关掉也会 bump updated_at; 未来若把排序
    改成按 updated_at, 这就会表现为「什么都没做, 记录却自己跳到最前面」。
    现在拦住是低成本的正确性保障。
    """
    job_dir = _resolve_job_dir(job_id)
    if not job_dir.exists():
        raise HTTPException(404, f"job {job_id} 不存在")
    with _album_lock:
        album = _load_album(OUTPUT_DIR)
        base = album.get(job_id) or _normalize_entry({})
        merged = _merge_entry(base, body)
        if _same_content(base, merged):
            return {"job_id": job_id, **base, "changed": False}
        album[job_id] = merged
        _save_album(OUTPUT_DIR, album)
    return {"job_id": job_id, **merged, "changed": True}


@router.delete("/api/gallery/{job_id}")
def gallery_delete(job_id: str):
    """真删: 删整个 job 目录 + 元数据条目。

    删除前再次校验(已经在 _resolve_job_dir 里做过) + is_dir 检查,
    防止「目录不存在但元数据残留」时 rmtree 报 FileNotFoundError。
    """
    job_dir = _resolve_job_dir(job_id)
    if not job_dir.is_dir():
        raise HTTPException(404, f"job {job_id} 不存在")
    shutil.rmtree(job_dir)
    with _album_lock:
        album = _load_album(OUTPUT_DIR)
        album.pop(job_id, None)
        _save_album(OUTPUT_DIR, album)
    return {"job_id": job_id, "deleted": True}