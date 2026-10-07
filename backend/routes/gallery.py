"""画廊:扫描 outputs/,列出历次任务;并维护 _album.json 元数据侧车."""
from __future__ import annotations

import json
import os
import re
import shutil
import time
from pathlib import Path
from stat import S_ISDIR
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

# .broken-* 备份保留几个。3 个覆盖「最近手滑弄坏了几次」, 再多就只是垃圾。
_BROKEN_KEEP = 3

# /api/gallery 分页。
#
# MAX_PAGE 是单次 limit 的上限, 防止 ?limit=100000 把"分页"变成"一次性
# 把整库序列化出来" —— 那个开销正是这次改动要消除的, 不能从参数上又放回来。
# 200 足够覆盖"一次把 222 条全取走"这种极端需求, 又不至于让单次响应失控。
MAX_PAGE = 200

# limit 的默认值是 0, 而 0 在这里是「不分页, 返回全部」而不是「返回 0 条」。
#
# 刻意这么设计: verify-* 脚本与外部脚本大量直接 `fetch("/api/gallery")`
# 并对 items 断言, 让默认变成 24 会让它们在数据多于 24 条时**静默截断** ——
# 脚本照样绿, 但断的已不是它想断的东西。0 = 不限 让旧调用方行为逐字节不变,
# 是加这个参数时唯一安全的默认值。真正的首屏大小由前端 GalleryPage 的
# PAGE_SIZE 决定(它必须传), 后端不替前端猜。

# 批量删除的单次上限。上限存在的理由与 _BROKEN_KEEP 不同: 那个是防垃圾堆积,
# 这个是防**一次请求把整个 outputs/ 删空**且用户无法中途反悔。
# 200 远大于任何一次手选的范围, 又让「全选」在超大库上也需要分次。
MAX_BATCH_DELETE = 200

# ---- 回收站(软删除) ----
#
# 删除不再 rmtree, 而是把 job 目录**移进** outputs/_trash/<时间戳>_<job_id>/。
# 保留期到就真删。
#
# 为什么目录名要带时间戳前缀而不是直接用 job_id:
#   job_id 不会重复(它是毫秒时间戳 + 随机), 所以理论上直接用 job_id 也行。
#   但带上前缀带来两个实际好处 —— (1) `ls _trash` 按字典序即按时间序,
#   人工查看/排查时直观; (2) 保留期判断可以直接用目录名的前缀, 不用依赖
#   mtime —— 用户「恢复」操作会改目录 mtime(其实是 move, 跨目录同卷时
#   mtime 不变, 但跨卷会变), 用 mtime 判过期就会误删刚恢复过期的项。
TRASH_DIRNAME = "_trash"

# 保留天数。7 天覆盖"周末误删, 工作日才想起来"这个最常见的时间跨度。
# 刻意不用 30 天: 照片目录是 GB 级的, 回收站每多留一天就多占一天磁盘。
TRASH_RETENTION_DAYS = 7

# 回收站列表的单次上限。回收站是人工逐条确认的场合, 不需要分页 ——
# 但要防"用户积攒了上万条"时一次把响应撑爆。超出部分不返回, 并在
# 响应里给出 truncated 标记, 前端据此提示"仅显示最近 N 条"。
TRASH_MAX_ITEMS = 500


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
    """原子写: 写 .tmp 再 os.replace。读端不需要看到中间态。

    元数据全空时删掉 _album.json 而不是写 `{}`: 空文件与「文件不存在」
    对读端是同一含义, 留着只会让人误以为「还有元数据, 只是恰好都是空的」。
    顺带清掉历史遗留的 .broken-* 备份 —— 那些是 _load_album 出错时留的,
    用户手工恢复完就没用了, 每次写盘都留着会一直堆积。
    """
    p = _album_path(outdir)
    if not album:
        p.unlink(missing_ok=True)
        _prune_broken_backups(outdir)
        return
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(album, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, p)
    _prune_broken_backups(outdir)


def _prune_broken_backups(outdir: Path) -> None:
    """删除 _album.json.broken-* 备份。

    保留策略: 只留最近 3 个。这些文件的唯一用途是「元数据被误改坏时手工
    恢复」, 恢复完就是垃圾; 删干净会让用户以为数据无处可查, 无限保留
    又会让 outputs/ 越用越乱。3 个足够覆盖「最近手滑弄坏了几次」。
    """
    backups = sorted(
        outdir.glob(f"{ALBUM_FILENAME}.broken-*"),
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )
    for old in backups[_BROKEN_KEEP:]:
        try:
            old.unlink()
        except OSError:
            # 清理是尽力而为, 失败不影响主流程(用户可能正打开着它)
            pass


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
# 回收站
# ---------------------------------------------------------------------------
def _trash_root() -> Path:
    return OUTPUT_DIR / TRASH_DIRNAME


def _trash_name(job_id: str, when: float) -> str:
    return f"{int(when * 1000)}_{job_id}"


def _split_trash_name(name: str) -> tuple[int, str] | None:
    """回收站目录名 -> (删除时间戳毫秒, job_id)。不合法返回 None。

    **必须严格解析**: 目录名来自磁盘(用户可能自己往 _trash 里塞东西),
    而这个返回值会喂给 _resolve_job_dir 之外的路径拼接。job_id 部分仍要过
    _JOB_ID_RE —— 否则一个叫 "123_../../../etc" 的目录名能骗过恢复接口。
    """
    head, sep, job_id = name.partition("_")
    if not sep or not head.isdigit() or not job_id:
        return None
    if _validate_job_id(job_id):
        return None
    return int(head), job_id


def _trash_entries() -> list[dict]:
    """回收站全部条目, 按删除时间**新到旧**。

    倒序是给用户看的: 刚删掉的最可能还要恢复, 沉在几百条旧记录里很难找。
    排序键用目录名里的时间戳而不是 mtime —— 见 TRASH_DIRNAME 处的说明。
    """
    root = _trash_root()
    if not root.is_dir():
        return []
    out: list[dict] = []
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        parsed = _split_trash_name(entry.name)
        if parsed is None:
            continue
        deleted_ms, job_id = parsed
        out.append({
            "job_id": job_id,
            "trash_name": entry.name,
            "deleted_at": deleted_ms / 1000,
            "size": _trash_entry_size(entry),
            "thumbs": _pick_trash_thumbs(job_id, entry),
        })
    out.sort(key=lambda x: (-int(x["deleted_at"] * 1000), x["job_id"]))
    return out


def _pick_trash_thumbs(job_id: str, trash_entry: Path) -> list[str]:
    """回收站缩略图。URL 指向 _trash 下的真实路径。

    刻意复用 _pick_thumb 的优先级(分享卡 > 拼图 > 原图): 用户在回收站里
    也要能一眼认出是哪次拍摄, 而不是只看到一堆 photo_1。
    """
    share = trash_entry / SHARE_FILENAME
    if share.exists():
        return [f"/outputs/{TRASH_DIRNAME}/{trash_entry.name}/{SHARE_FILENAME}"]
    layout = trash_entry / LAYOUT_FILENAME
    if layout.exists():
        return [f"/outputs/{TRASH_DIRNAME}/{trash_entry.name}/{LAYOUT_FILENAME}"]
    return [
        f"/outputs/{TRASH_DIRNAME}/{trash_entry.name}/{f.name}"
        for f in sorted(trash_entry.glob("photo_*.jpg"))[:4]
    ]


def _trash_entry_size(trash_entry: Path) -> int:
    """目录里所有文件的总字节数。

    不用 st_size: 目录的 st_size 只是目录项本身的元数据大小(通常几十字节),
    拿它显示"回收站占了 200 KB"会严重低估, 而用户正是靠这个数字判断
    要不要清空。递归 stat 每个文件才是真实值。
    """
    total = 0
    try:
        for f in trash_entry.rglob("*"):
            try:
                if f.is_file():
                    total += f.stat().st_size
            except OSError:
                # 扫描途中被删(另一个标签页清了回收站)。跳过这一项,
                # 不要让整个列表 500。
                continue
    except OSError:
        return total
    return total


def _purge_expired(now: float | None = None) -> list[str]:
    """真删掉超过保留期的条目。返回被清掉的 job_id 列表。

    在**每次** _trash_entries() 与 /api/gallery/trash 列表时顺带做, 而不是
    只在启动时做一次: 服务可能连跑几周不停, 只靠启动清理意味着"第 8 天
    删的东西"要等到下次重启才消失 —— 而用户下周来看回收站时希望它是空的。
    回收站规模是人工量级(几百条), 每次列表多一次 iterdir 完全可接受。
    """
    now = now if now is not None else time.time()
    cutoff = now - TRASH_RETENTION_DAYS * 86400
    purged: list[str] = []
    root = _trash_root()
    if not root.is_dir():
        return purged
    for entry in list(root.iterdir()):
        parsed = _split_trash_name(entry.name)
        if parsed is None:
            continue
        deleted_ms, job_id = parsed
        if deleted_ms / 1000 >= cutoff:
            continue
        try:
            if entry.is_dir():
                shutil.rmtree(entry)
            else:
                entry.unlink()
            purged.append(job_id)
        except OSError:
            # 文件被占用(Windows 上图片还开着)。留到下次再试。
            continue
    return purged


def _trash_one(job_id: str, when: float | None = None) -> str:
    """把 job 目录移进回收站, 返回回收站目录名。

    `shutil.move` 而非 `rmtree`: 这是软删除的全部意义。
    跨卷(OUTPUT_DIR 在别的盘)时 move 会退化成 copy+delete, 慢但正确。

    同名冲突(同一 job_id 被删两次)不可能发生 —— 第二次就没有源目录了,
    调用方在调用前已 is_dir 检查过。

    **when 由调用方传入**, 与 _save_trash_meta 共用同一个时间戳 ——
    两者若各自调 time.time(), 跨过毫秒边界就会得到不同的 trash_name,
    于是恢复时 sidecar 找不到、标题/标签/收藏全丢。这是真实会发生的
    (两个 time.time() 之间隔着一次磁盘 IO), 不是理论风险。
    """
    src = OUTPUT_DIR / job_id
    root = _trash_root()
    root.mkdir(parents=True, exist_ok=True)
    name = _trash_name(job_id, when if when is not None else time.time())
    shutil.move(str(src), str(root / name))
    return name


def _trash_meta_path(trash_name: str) -> Path:
    """回收站条目对应的元数据 sidecar: _trash/<trash_name>.meta.json。

    刻意**放在目录外面**而不是目录里面: 如果放进去, 恢复时得先把它从
    目录里挑出来再删, 而用户可能已经手动往那个目录里放过东西(极小概率,
    但一旦发生就是数据丢失)。放外面让"搬回 + 删一个文件"各自独立。

    用 trash_name 而不是 job_id 做键: 同一个 job_id 理论上可以被反复
    删除/恢复多轮, 每次的 sidecar 应该各存各的历史, 不能互相覆盖。
    """
    return _trash_root() / f"{trash_name}.meta.json"


def _save_trash_meta(job_id: str, meta: dict | None, when: float) -> None:
    """把一条记录的元数据存进回收站 sidecar。meta 为 None 时不写。

    when 必须与 _trash_one 收到的是同一个值(见该函数的说明)。
    """
    if meta is None:
        return
    _trash_root().mkdir(parents=True, exist_ok=True)
    path = _trash_meta_path(_trash_name(job_id, when))
    payload = {"job_id": job_id, "meta": meta, "saved_at": int(time.time())}
    try:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        # 存不下就算了: 恢复时少了标题/标签, 但照片本身还在。
        # 这里的取舍是"宁可少元数据, 不要阻塞删除"。
        pass


def _load_trash_meta(trash_name: str) -> dict | None:
    path = _trash_meta_path(trash_name)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("meta")
    except (json.JSONDecodeError, OSError, AttributeError):
        return None


def _drop_trash_meta(trash_name: str) -> None:
    try:
        _trash_meta_path(trash_name).unlink(missing_ok=True)
    except OSError:
        pass


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

    **刻意不返回全部照片**: 这是卡片缩略图的契约(最多 4 张), 历史上
    verify-share-card / verify-decorate-persist 都在断言"有 share 时
    thumbs 只返回 1 张"。大图查看需要全部产物, 走 _pick_media 的独立
    字段, 两套语义互不干扰。
    """
    share = entry / SHARE_FILENAME
    if share.exists():
        return [f"/outputs/{entry_name}/{SHARE_FILENAME}"]
    layout = entry / LAYOUT_FILENAME
    if layout.exists():
        return [f"/outputs/{entry_name}/{LAYOUT_FILENAME}"]
    return [f"/outputs/{entry_name}/{f.name}"
            for f in sorted(entry.glob("photo_*.jpg"))[:4]]


def _pick_media(entry_name: str, entry: Path) -> list[dict]:
    """列出一个 job 的**全部**可查看产物: 所有原图 + 拼图 + 分享卡。

    为什么必须有它、而 thumbs 不够用: _pick_thumb 命中 share.jpg 或
    layout.jpg 时就**只返回那一张**, 原图一个都不给。于是"有大图查看"
    时前端拿不到任何 photo_*.jpg 的地址 —— 这不是前端能补的, 信息在
    响应里就没了。thumbs 保留原语义给卡片用, media 承担灯箱。

    排序(照片 → 拼图 → 分享卡)与 thumbs 的优先级**故意相反**:
    thumbs 是"卡片上该露哪张脸", media 是"翻页时用户期望的顺序"。
    用户翻大图时想先看的是自己拍的那几张, 拼图和分享卡是衍生品。
    同理, 原图按**数字**排序而非字典序 —— photo_10 排在 photo_2 前面
    是字典序的经典陷阱(连拍上限 8 张, 但历史 job 可以来自别的来源)。
    """
    media: list[dict] = []

    def add(kind: str, filename: str, label: str) -> None:
        media.append({
            "kind": kind,
            "url": f"/outputs/{entry_name}/{filename}",
            "label": label,
        })

    def photo_index(p: Path) -> int:
        # 取 photo_<idx>.jpg 里的 idx; 取不到就排到最后, 不让一条脏文件名
        # 让 sorted() 直接抛 ValueError 把整个 /api/gallery 带崩。
        m = re.search(r"photo_(\d+)", p.name)
        return int(m.group(1)) if m else 10**9

    photos = sorted(entry.glob("photo_*.jpg"), key=photo_index)
    for n, f in enumerate(photos, start=1):
        # label 用「第 n 张」而不是文件名: 界面上要的是"这是第几张", 而不是
        # photo_3.jpg 这种实现细节。
        add("photo", f.name, f"原图 {n}")
    if (entry / LAYOUT_FILENAME).exists():
        add("layout", LAYOUT_FILENAME, "拼图")
    if (entry / SHARE_FILENAME).exists():
        add("share", SHARE_FILENAME, "分享卡")
    return media


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
def gallery(q: str = "", tag: str = "", limit: int = 0, offset: int = 0):
    """扫描 outputs/ 列出历次任务, 合并 _album.json 元数据。

    排序规则(固定, 不提供切换): favorite 优先, 同组内按 mtime 倒序。
    不在 album 但存在于磁盘的条目以缺省元数据呈现。
    不在磁盘但存在于 album 的条目是孤儿, 直接丢弃(保留在文件里供手工恢复)。

    **零文件的空目录同样不进 items**(见第一段注释)。它既不参与 total,
    也不参与 tags 统计 —— 契约是「items / total / tags 三者基于同一集合」,
    让空目录只影响其中之一会让前端分页与筛选条的计数对不上。

    筛选放在**服务端**而不是前端: 前端过滤只能隐藏已经传过来的条目,
    /api/gallery 仍会把全部 URL 发过去。放后端才能让 ?q=xx 成为一个可复现、
    可分享、刷新后保持的链接。

    分页(limit/offset)是后加的, 动机是本机 outputs/ 已积累到 200+ 个 job 目录:
    改前每次请求都要对**每个**目录 glob 出全部产物名再序列化, 首屏等待与
    响应体积都随历史线性增长, 且第 2 页要为 1 页的数据付全量代价。

    **两段式扫描**是这次性能改动的核心(见下面两段注释)。

    刻意用同步 def: 纯磁盘 IO, 跑线程池; 与改前一致。
    """
    album = _load_album(OUTPUT_DIR)
    if not OUTPUT_DIR.exists():
        return {"items": [], "tags": [], "total": 0, "has_more": False}
    needle = q.strip().lower()
    want_tags = {t.strip() for t in tag.split(",") if t.strip()}
    # offset 负数没有意义, 静默归零而不是 422 —— 分页参数不该因为手滑
    # (offset=-1)就让整个页面报错。
    if offset < 0:
        offset = 0
    if limit < 0:
        limit = 0
    if limit > MAX_PAGE:
        limit = MAX_PAGE

    # ---- 第一段: 只做「便宜」的每目录工作 ----
    # 每条目一次 stat() + 一次 album 查表。**不碰目录内容**。
    #
    # 改前 _pick_thumb/_pick_media 在这里对每个目录各 glob 一次
    # (photo_*.jpg + 两个 exists), 223 个目录就是 ~670 次 syscall,
    # 而其中绝大多数条目根本不会出现在响应里 —— 被 q/tag 筛掉的、
    # 以及排在第一页之后的。分页让这个浪费从「不可避免」变成「可以避免」:
    # 先只用 stat 定序与筛选, 把 glob 推迟到切片之后。
    rows: list[tuple[str, int, dict]] = []
    for entry in OUTPUT_DIR.iterdir():
        name = entry.name
        if name.startswith("_") or name.startswith("."):
            continue
        try:
            st = entry.stat()
        except OSError:
            # 目录在 iterdir 之后被删掉(另一个标签页正在清理, 或用户手动删)。
            # 跳过而不是让整个 /api/gallery 500。
            continue
        if not S_ISDIR(st.st_mode):
            # _album.json 与散落的 jpg 都从这里走掉, 不会进 items。
            # 用 stat 的 mode 判定而不是再调一次 is_dir(): 后者是第二次
            # syscall, 而这里已经拿到 st 了。
            continue
        # 跳过空目录。
        #
        # 空目录真实存在, 但来源已经变了:
        #
        # 历史上 capture_save 在写任何文件**之前**就 mkdir, 所以
        # 「mkdir 成功但后续 _check_image 抛 400/413」会留下零文件目录。
        # 那条路已经堵死(见 routes/capture.py 的惰性建目录 + 回滚), 但
        # **这里不能跟着删**: 用户会自己往 outputs/ 里放东西, 同步盘/
        # 解压工具也会留残余目录, 而判空是最后一道兜底 —— 删掉它等于把
        # 「用户的目录不出现在画廊里」和「空目录不会渲染成碎图卡片」这两条
        # 契约一起放弃, 换成「我们的代码不该犯错」这种无法验证的假设。
        # 便宜的检查, 兜住所有来源, 没有理由去掉。
        #
        # 另一个仍然存在的来源: 一次多张上传中途失败, 若回滚本身
        # 失败(文件被占用/权限), 残缺目录同样会被这里挡掉。
        #
        # 刻意放在**筛选之前**: 判空只需要知道「有没有任何条目」, 与 title/
        # note/tags 无关, 提前做能让「空」成为一条与筛选正交的排除规则 ——
        # 否则空目录会先占掉一个 rows 名额, 再被 _matches 筛掉, 两者混在
        # 一起时, 「某页为空」到底是没数据还是被筛光就分不清了。
        #
        # 代价是每个通过 stat 的目录多一次 opendir —— 与上面「不碰目录内容」
        # 的优化看似冲突, 但这个交换是必要的, 不是退化:
        #   1. 跳过必须在**切片之前**做。若推迟到第二段(只查当页), total 会
        #      把空目录算进去, 而 items 少于 total —— verify-gallery-paging
        #      断言 items.length === total, 前端也会因此翻出空洞页。
        #   2. next(iterdir(), None) 命中首个条目即停, 不是完整遍历,
        #      对非空目录只是一次 opendir。
        # 排序/分页因此始终建立在「用户真正看得见的条目」上。
        try:
            if next(entry.iterdir(), None) is None:
                continue
        except OSError:
            # 目录在 stat 之后、iterdir 之前被删掉(另一个标签页正在清理)。
            # 与上面的 stat 分支同一个理由: 跳过, 不让整个列表 500。
            continue
        meta = album.get(name) or {}
        merged = _merge_entry(_normalize_entry({}), meta)
        # 筛选只需要 job_id/title/note/tags, 全在 merged 里 ——
        # 不必先拼出带 thumbs/media 的完整 item 再丢掉。
        if not _matches({"job_id": name, **merged}, needle, want_tags):
            continue
        rows.append((name, int(st.st_mtime), merged))

    # 排序: favorite True 在前, 同组内 mtime 降序, **再按 job_id 兜底**。
    #
    # 末尾那个 job_id 不是可有可无的洁癖: 分页要求排序是**全序**。
    # 改前只有 (not favorite, -mtime) 两个键, 同 favorite 且同秒创建的两条
    # 记录(mtime 是 int 秒, 连拍场景下撞秒很常见)相对顺序就只由
    # iterdir() 的文件系统顺序决定 —— 而那个顺序在两次请求之间不保证一致。
    # 结果是第 1 页和第 2 页可能返回同一条、或漏掉一条。sorted() 的稳定
    # 性救不了: 它只保持**输入**顺序, 而输入顺序本身不稳定。
    # 加上 job_id 后, 任意两条互不相同的记录都有确定先后, 翻页才可复现。
    rows.sort(key=lambda t: (not t[2]["favorite"], -t[1], t[0]))

    # tags 汇总(按 count 降序, 同 count 按名称升序), 供前端渲染筛选条。
    # 只统计**筛选后**的结果: 否则用户搜完之后, 筛选条上仍显示一堆
    # 在当前结果里根本不存在的标签, 点下去得到空列表。
    #
    # 刻意基于**筛选后全集**而不是当页 items: 分页后当页只有 24 条,
    # 按当页统计会让「旅行 12」在某页显示成「旅行 1」, 且用户滚到下一页
    # 数字又变 —— 筛选条会随滚动抖动。标签来自 merged(已在第一段算好),
    # 不需要额外的磁盘访问, 所以「全集统计」在这里不花钱。
    counts: dict[str, int] = {}
    for _, _, merged in rows:
        for t in merged["tags"]:
            counts[t] = counts.get(t, 0) + 1

    total = len(rows)
    page = rows[offset:] if limit == 0 else rows[offset:offset + limit]

    # ---- 第二段: 只对当页条目做「昂贵」的目录内探测 ----
    items = []
    for name, mtime, merged in page:
        entry = OUTPUT_DIR / name
        items.append({
            "job_id": name,
            "mtime": mtime,
            "thumbs": _pick_thumb(name, entry),
            # 全量产物供大图查看灯箱。
            #
            # 仍是空列表而不是 null, 前端少一处判空。
            # 走到这里的目录第一段已确认非空, 所以正常必有产物; 但两次
            # 调用之间目录可能被清空(用户手动删/另一个标签页在删),
            # _pick_media 仍可能返回空 —— 退化而不是抛错, 与第一段
            # 对「中途消失」的处理保持同一个态度。
            "media": _pick_media(name, entry),
            **merged,
        })

    return {
        "items": items,
        "tags": [{"tag": t, "count": c} for t, c in
                 sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))],
        "total": total,
        # 用 offset + len(page) 而不是 len(items): 两者当前相等, 但前者在
        # offset 越界时给出的是「确实没有更多了」(False), 而后者在某些
        # 边界下会误导前端继续翻页。语义上 has_more 问的是
        # 「第 offset 页之后还有没有东西」, 就该用 offset 参与判断。
        "has_more": offset + len(page) < total,
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


def _pop_album_meta(job_id: str) -> dict | None:
    """从 album 里取出并删除某条元数据, 落盘。

    独立成函数是因为软删除路径必须**先取出**再删 —— 取出的是要存进
    回收站 sidecar 的那份, 直接 pop 掉就找不回来了。
    """
    with _album_lock:
        album = _load_album(OUTPUT_DIR)
        meta = album.pop(job_id, None)
        if meta is not None:
            _save_album(OUTPUT_DIR, album)
        return meta


@router.delete("/api/gallery/{job_id}")
def gallery_delete(job_id: str, permanent: bool = False):
    """删一条: 默认移进回收站(软删除), `permanent=true` 才真删。

    **默认不再 rmtree**。照片删掉就回不来了, 所以"删"的第一道保险是
    "先搬走, 7 天后再真删"。

    元数据条目照旧从 album 里清掉(否则 _album.json 会堆一堆看不到也够不着的
    键), 但清下来的那份**存进回收站的 sidecar**, 恢复时才能还原标题/标签/收藏。
    """
    job_dir = _resolve_job_dir(job_id)
    if not job_dir.is_dir():
        raise HTTPException(404, f"job {job_id} 不存在")

    if permanent:
        shutil.rmtree(job_dir)
        with _album_lock:
            album = _load_album(OUTPUT_DIR)
            album.pop(job_id, None)
            _save_album(OUTPUT_DIR, album)
        return {"job_id": job_id, "deleted": True, "permanent": True}

    when = time.time()
    with _album_lock:
        album = _load_album(OUTPUT_DIR)
        meta = album.pop(job_id, None)
        _save_trash_meta(job_id, meta, when)
        _save_album(OUTPUT_DIR, album)
    name = _trash_one(job_id, when)
    return {
        "job_id": job_id,
        "deleted": True,
        "permanent": False,
        "trash_name": name,
        "purge_after_days": TRASH_RETENTION_DAYS,
    }


@router.post("/api/gallery/batch-delete")
def gallery_batch_delete(body: dict = Body(default_factory=dict)):
    """批量删除。**逐项报告成败, 不因为一条失败而整体回滚。**

    为什么不是"全成功或全失败": 批量删除的典型场景是清理一批测试残留,
    其中常有几条早就被别的标签页删过了。让一条 stale id 把整批 50 条
    一起拒绝, 用户只能反复重试删不掉那一条 —— 而他的真实目标(清掉这批)
    反而达不成。逐项返回 deleted / missing / failed, 前端如实告知即可。

    同样地, **非法 job_id 不阻断整批**: 它进 failed, 其余照删。整批 400
    只在 body 本身不合法(不是数组、超上限)时才发生 —— 那是请求写错了,
    值得立刻报错。

    _album.json **整批只写一次**: 逐条 delete 会 read-modify-write N 次,
    每次都是一次 JSON 序列化 + 原子替换。50 条就是 50 次写盘, 而中间态
    还会让并发的 GET 看到"删了一半"的 album。这里先在内存里 pop 完,
    再进一次锁写一次盘。

    注意 rmtree 在**锁外**做: 它是慢磁盘 IO(要真删几十个 jpg),
    持锁做会让并发的 /api/gallery 全部排队等删除完成。album 的最终状态
    仍然一致 —— 少了目录的孤儿条目本来就查不出来(见 gallery() 的说明)。
    """
    job_ids = body.get("job_ids")
    if not isinstance(job_ids, list):
        raise HTTPException(400, "job_ids 必须是数组")
    if len(job_ids) > MAX_BATCH_DELETE:
        raise HTTPException(400, f"一次最多删除 {MAX_BATCH_DELETE} 条")
    permanent = bool(body.get("permanent"))

    deleted: list[str] = []
    missing: list[str] = []
    failed: list[dict] = []
    # 去重但保序: 前端可能把同一 id 发来两次(选择态竞态),
    # 第二次会找不到目录, 白白记一条 missing。
    seen: set[str] = set()

    for job_id in job_ids:
        if not isinstance(job_id, str):
            failed.append({"job_id": str(job_id), "error": "job_id 必须是字符串"})
            continue
        if job_id in seen:
            continue
        seen.add(job_id)
        try:
            job_dir = _resolve_job_dir(job_id)
        except HTTPException as e:
            # 非法 id / 越界 —— 逐条记录, 不整批中止
            failed.append({"job_id": job_id, "error": str(e.detail)})
            continue
        if not job_dir.is_dir():
            missing.append(job_id)
            continue
        if permanent:
            try:
                shutil.rmtree(job_dir)
            except OSError as e:
                failed.append({"job_id": job_id, "error": f"{type(e).__name__}: {e}"})
                continue
            deleted.append(job_id)
            continue
        when = time.time()
        try:
            _save_trash_meta(job_id, _pop_album_meta(job_id), when)
            _trash_one(job_id, when)
        except OSError as e:
            # 文件被占用(Windows 上很常见: 图片还开着) / 跨卷移动失败。
            # 记下来让用户知道哪条没删掉, 而不是整批静默失败。
            failed.append({"job_id": job_id, "error": f"{type(e).__name__}: {e}"})
            continue
        deleted.append(job_id)

    # album 清理范围 = deleted + missing, **两者都要**。
    #
    # 软删除路径: album 键已经被 _pop_album_meta 取出来存进 sidecar 了,
    # 这里 pop 是空操作(幂等, 无害)。
    #
    # permanent 路径: **这是唯一会清的地方**。少了它就会留下
    # 「目录没了、回收站也没有、album 里有」的三方不一致 —— 那个键
    # gallery() 丢弃它、gallery_delete 先 404、batch-delete 归入 missing,
    # 只有再跑一次 batch-delete 才能清掉。实测踩过: 验证脚本的
    # `?permanent=true` 清理跑完, _album.json 里攒出十几个孤儿键,
    # 而脚本全程 0 失败。
    #
    # missing 的目录本来就已经不在磁盘上, 它的 album 条目同样是
    # 任何 API 都够不到的死数据(gallery() 丢弃孤儿, gallery_delete 先 404)。
    if deleted or missing:
        with _album_lock:
            album = _load_album(OUTPUT_DIR)
            changed = False
            for job_id in deleted + missing:
                if album.pop(job_id, None) is not None:
                    changed = True
            if changed:
                _save_album(OUTPUT_DIR, album)

    return {
        "deleted": deleted,
        "missing": missing,
        "failed": failed,
        "deleted_count": len(deleted),
        "permanent": permanent,
        "purge_after_days": 0 if permanent else TRASH_RETENTION_DAYS,
    }


# ---------------------------------------------------------------------------
# 回收站 API
# ---------------------------------------------------------------------------
@router.get("/api/gallery/trash")
def gallery_trash():
    """回收站列表。顺带清掉过保留期的条目。

    返回 total / total_size / retention_days, 前端据此显示"X 条 · Y MB ·
    7 天后自动删除"。用户需要知道这是**有期限**的, 否则他会以为删掉的东西
    永远都在, 于是不敢在 7 天后清空, 磁盘就一直被占着。
    """
    purged = _purge_expired()
    entries = _trash_entries()
    shown = entries[:TRASH_MAX_ITEMS]
    return {
        "items": shown,
        "total": len(entries),
        "total_size": sum(e["size"] for e in entries),
        "retention_days": TRASH_RETENTION_DAYS,
        "truncated": len(entries) > len(shown),
        # 刚被清理掉的条目 id: 前端可据此提示"有 N 条已过保留期被永久删除",
        # 而不是让用户发现列表突然少了东西却不知道为什么。
        "purged": purged,
    }


@router.post("/api/gallery/trash/{job_id}/restore")
def gallery_trash_restore(job_id: str):
    """从回收站恢复一条记录。

    按**删除时间新到旧**找匹配项, 而不是要求前端回传 trash_name:
    用户几乎不可能记住/传出 "<毫秒时间戳>_<job_id>" 这种内部名字, 而 job_id
    是他能在画廊里看到的。同一 job_id 有多份历史时恢复最新的那份。
    """
    err = _validate_job_id(job_id)
    if err:
        raise HTTPException(400, err)

    match: tuple[str, str] | None = None
    for e in _trash_entries():  # 已按时间倒序
        if e["job_id"] == job_id:
            match = (e["trash_name"], e["job_id"])
            break
    if match is None:
        raise HTTPException(404, f"回收站里没有 {job_id}")

    trash_name, _ = match
    src = _trash_root() / trash_name
    dst = OUTPUT_DIR / job_id
    if dst.exists():
        # 恢复期间用户又拍出了同 id(几乎不可能, 但不能把用户的数据覆盖掉)。
        raise HTTPException(409, f"{job_id} 已存在, 无法恢复")

    meta = _load_trash_meta(trash_name)
    try:
        shutil.move(str(src), str(dst))
    except OSError as e:
        raise HTTPException(500, f"恢复失败:{e}") from e
    _drop_trash_meta(trash_name)

    if meta is not None:
        with _album_lock:
            album = _load_album(OUTPUT_DIR)
            album[job_id] = meta
            _save_album(OUTPUT_DIR, album)
    return {"job_id": job_id, "restored": True}


@router.post("/api/gallery/trash/{job_id}/purge")
def gallery_trash_purge(job_id: str):
    """彻底删除回收站里的一条(不可恢复)。"""
    err = _validate_job_id(job_id)
    if err:
        raise HTTPException(400, err)
    target: str | None = None
    for e in _trash_entries():
        if e["job_id"] == job_id:
            target = e["trash_name"]
            break
    if target is None:
        raise HTTPException(404, f"回收站里没有 {job_id}")
    try:
        shutil.rmtree(_trash_root() / target)
    except OSError as e:
        raise HTTPException(500, f"删除失败:{e}") from e
    _drop_trash_meta(target)
    # 顺带清 _album.json 里可能残留的键。
    #
    # 正常软删路径下 album 键已经被 pop 进 sidecar 了, 所以这里通常是空操作。
    # 但它是必要的兜底: 若 sidecar 写入失败(OSError 分支是"宁可少元数据
    # 也要完成删除"), 或 album 键在软删之后又被别处写回, 就会出现
    # 「磁盘没有、回收站没有、album 有」的三方不一致 —— 那个键任何 API
    # 都够不到, 只能手改 json 清。与 batch-delete 的 missing 分支保持一致。
    with _album_lock:
        album = _load_album(OUTPUT_DIR)
        if album.pop(job_id, None) is not None:
            _save_album(OUTPUT_DIR, album)
    return {"job_id": job_id, "purged": True}


@router.post("/api/gallery/trash/empty")
def gallery_trash_empty():
    """清空回收站(不可恢复)。

    逐条 rmtree 而不是 rmtree(_trash) 整个目录: 后者会把目录本身删掉,
    而 _trash 是被 StaticFiles 挂载的路径, 删掉后 /outputs/_trash 立刻 404,
    直到下次有删除操作重建它。前端若缓存了回收站缩略图 URL 会一片碎图。
    保留目录、只清内容, 让挂载始终有效。
    """
    removed: list[str] = []
    failed: list[dict] = []
    root = _trash_root()
    if root.is_dir():
        for entry in list(root.iterdir()):
            try:
                if entry.is_dir():
                    shutil.rmtree(entry)
                else:
                    entry.unlink()
                if entry.suffix == ".json":
                    removed.append(entry.stem.split(".")[0])
                else:
                    parsed = _split_trash_name(entry.name)
                    if parsed:
                        removed.append(parsed[1])
            except OSError as e:
                failed.append({"name": entry.name, "error": f"{type(e).__name__}: {e}"})
    return {"removed": removed, "failed": failed, "removed_count": len(removed)}


@router.post("/api/gallery/trash/purge-expired")
def gallery_trash_purge_expired():
    """立即清理过保留期的条目, 不等用户打开回收站。"""
    return {"purged": _purge_expired()}


def purge_expired_on_startup() -> list[str]:
    """启动时清理过期回收站条目。给 app.py 的 startup 钩子调用。

    独立成模块级函数(而不是让 app.py 直接调私有的 _purge_expired)是为了不把
    下划线前缀的内部函数暴露成跨模块契约 —— 以后想改清理策略(比如改成
    "启动时只警告不删")不会顺手改坏 app.py。
    """
    try:
        return _purge_expired()
    except OSError:
        # 回收站被外部工具锁住(杀毒软件扫描/同步盘)。启动不该因此失败 ——
        # 清理只是省磁盘, 不做的话只是磁盘多占一点。
        return []
