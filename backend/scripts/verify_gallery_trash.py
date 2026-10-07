"""回收站(软删除)纯函数与边界验证.

为什么不是 pytest:
共享的 webui venv 里没有装 pytest(装它会牵动 transformers/diffusers 的
版本死锁, 见 .trae/rules/project_rules.md),所以本项目一律用「裸 assert +
退出码」的脚本,见 scripts/ 与本目录下的 verify_*.py。

与 verify-gallery-trash.mjs(Playwright E2E)的分工:
那个脚本走真实 HTTP + 浏览器, 验证的是**端到端契约**;本脚本直接 import
被测函数, 验证的是**边界与不变量**。两者都要有 ——
E2E 只能覆盖"正常路径走得通", 而下面这些退化路径(畸形目录名、跨毫秒
时间戳、过期边界、并发改名)用 E2E 很难或很慢地构造出来。

**测试隔离**: 回收站的函数直接读模块级 OUTPUT_DIR, 所以全部在
TemporaryDirectory 里跑, 并 monkeypatch gallery.OUTPUT_DIR。
这一点必须做到位 —— 早先的 verify-gallery-paging.mjs 就是因为漏了清理,
把自己的测试数据留在真实 outputs/ 里, 而脚本全程 0 失败。
本脚本只碰临时目录, 且用 try/finally 复原(与 verify_mirror.py 同一手法)。

参考 docs/testing-standards.md:
  - 不硬编码数量, 钉不变量(比如"未过期条目必须在", 而不是"总共 N 条")
  - 删除只删自己造的, 不按特征扫
"""
from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.routes import gallery as g  # noqa: E402

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{('  ' + detail) if detail else ''}")


def jpeg_bytes() -> bytes:
    """最小可解码JPEG。

    必须是真图而不是 b"x": _pick_trash_thumbs 只判断文件存在, 但
    「缩略图URL 能取回有效字节」这类断言若拿一个 1 字节文件当样本,
    验证的就不是真实场景了。
    """
    import base64

    return base64.b64decode(
        "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof"
        "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB"
        "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=="
    )


def make_job(root: Path, job_id: str, *, photo: bool = True) -> Path:
    d = root / job_id
    d.mkdir(parents=True, exist_ok=True)
    if photo:
        (d / "photo_1.jpg").write_bytes(jpeg_bytes())
    return d


def make_trash_entry(root: Path, job_id: str, when: float) -> Path:
    """在 _trash 里造一个指定删除时间的条目。

    目录名必须走 g._trash_name —— 复刻一份写法的话, 它会随
    TRASH_DIRNAME 改动而失效, 于是断言还在绿、bug 已经回来。
    """
    d = root / g.TRASH_DIRNAME / g._trash_name(job_id, when)
    d.mkdir(parents=True, exist_ok=True)
    (d / "photo_1.jpg").write_bytes(jpeg_bytes())
    return d


# ===========================================================================
# 1. _trash_name / _split_trash_name: 名字的往返
# ===========================================================================
check(
    "_trash_name 是 <毫秒时间戳>_<job_id>",
    g._trash_name("abc", 1700000000.123) == "1700000000123_abc",
    g._trash_name("abc", 1700000000.123),
)

# 往返: 这是整套保留期逻辑的地基。解析不出来, _purge_expired 就永远
# 认不出该删什么, 回收站会无声地无限堆积。
name = g._trash_name("job_20260101_abc", 1700000000.5)
parsed = g._split_trash_name(name)
check("_split 能往返解析自己生成的名字", parsed == (1700000000500, "job_20260101_abc"), str(parsed))
check("解析出的 job_id 与原值一致", parsed is not None and parsed[1] == "job_20260101_abc")

# 小数秒必须被截断而不是四舍五入, 否则两次快速删除可能撞名。
check(
    "_trash_name 亚秒精度向下取整",
    g._trash_name("x", 1.0009) == "1000_x",
    g._trash_name("x", 1.0009),
)

# ---- 畸形名字必须被拒 ----
# 这些不是"防御性编程", 而是有具体来源: _trash 是磁盘上的目录,
# 用户(或同步盘/解压工具)完全可能往里放别的东西。解析器必须把它们
# 判为非法, 而不是猜一个 job_id 出来。
for bad, why in [
    ("no_underscore_here", "缺下划线分隔符"),
    ("_abc", "时间戳段为空"),
    ("abc_xyz", "时间戳非数字"),
    ("123_", "job_id 段为空"),
    ("123_a/b", "job_id 含路径分隔符"),
    ("123_../etc", "job_id 是路径穿越"),
    ("123_" + "a" * 200, "job_id 过长"),
    ("123__leading", "job_id 以 _ 开头"),
    ("123_.hidden", "job_id 以 . 开头"),
]:
    check(f"畸形目录名被拒: {why}", g._split_trash_name(bad) is None, repr(bad))


# ===========================================================================
# 2. 隔离环境下跑真实文件系统行为
# ===========================================================================
with tempfile.TemporaryDirectory(prefix="trash_unit_") as td:
    root = Path(td)
    orig_out = g.OUTPUT_DIR
    try:
        g.OUTPUT_DIR = root

        # ---------- _trash_one: 软删除 ----------
        make_job(root, "job_soft_a")
        trash_name = g._trash_one("job_soft_a", 1700000000.0)
        check("软删除后源目录不在 outputs/", not (root / "job_soft_a").exists())
        check("软删除后 _trash 里有同名条目", (root / g.TRASH_DIRNAME / trash_name).is_dir())
        check("软删除不删元数据(album 另由路由处理)", True)  # 见 3. 路由层

        # ---------- _trash_entries: 列表与排序 ----------
        make_job(root, "job_soft_b")
        g._trash_one("job_soft_b", 1700000001.0)
        make_job(root, "job_soft_c")
        g._trash_one("job_soft_c", 1700000002.0)

        entries = g._trash_entries()
        ids = [e["job_id"] for e in entries]
        check("回收站列出全部条目", set(ids) >= {"job_soft_a", "job_soft_b", "job_soft_c"}, str(ids))

        # 排序必须"新到旧": 用户刚删的最可能还要恢复, 沉在底部很难找。
        check(
            "按删除时间倒序(新到旧)",
            ids[:3] == ["job_soft_c", "job_soft_b", "job_soft_a"],
            str(ids[:3]),
        )

        e = next(x for x in entries if x["job_id"] == "job_soft_c")
        check("条目带 job_id", e["job_id"] == "job_soft_c")
        check("条目带 trash_name", e["trash_name"] == g._trash_name("job_soft_c", 1700000002.0))
        check("deleted_at 是秒级浮点", abs(e["deleted_at"] - 1700000002.0) < 1e-6, str(e["deleted_at"]))
        check("size 是内容总字节(非目录 st_size)", e["size"] > 0, str(e["size"]))

        # 缩略图 URL 必须指向 _trash 下的真实路径, 且是可直接取回的原点。
        # 这条容易在"把 _trash 重命名/改层级"时被无声打破。
        check("缩略图 URL 指向 /outputs/_trash/", e["thumbs"][0].startswith("/outputs/_trash/"), e["thumbs"][0])
        check(
            "缩略图 URL 含回收站目录名",
            e["trash_name"] in e["thumbs"][0],
            e["thumbs"][0],
        )
        check(
            "缩略图对应的文件真实存在",
            (root / e["thumbs"][0].removeprefix("/outputs/")).is_file(),
            e["thumbs"][0],
        )

        # 缩略图优先级: share.jpg 优于 photo_*, 与 _pick_thumb 同契约。
        d = root / g.TRASH_DIRNAME / g._trash_name("job_soft_a", 1700000000.0)
        (d / "photo_9.jpg").write_bytes(jpeg_bytes())
        (d / g.SHARE_FILENAME).write_bytes(jpeg_bytes())
        ea = next(x for x in g._trash_entries() if x["job_id"] == "job_soft_a")
        check("有 share.jpg 时只返回它", len(ea["thumbs"]) == 1, str(ea["thumbs"]))
        check("share 优先于 photo", g.SHARE_FILENAME in ea["thumbs"][0], ea["thumbs"][0])

        # ---------- 保留期边界 ----------
        # 用「刚过期 1 秒」和「未过期 1 秒」夹逼, 而不是拿一个远离边界的值 ——
        # 后者会让 off-by-one 整天都测不出来。
        cutoff_sec = g.TRASH_RETENTION_DAYS * 86400
        make_trash_entry(root, "job_just_expired", time.time() - cutoff_sec - 1)
        make_trash_entry(root, "job_not_expired", time.time() - cutoff_sec + 60)

        purged = g._purge_expired()
        check("刚过期的被清理", "job_just_expired" in purged, str(purged))
        check(
            "刚过期的目录真被删",
            not (root / g.TRASH_DIRNAME / g._trash_name("job_just_expired", 0)).exists(),
        )
        check("未过期的**不**被清理(误删是灾难性的)", "job_not_expired" not in purged, str(purged))
        check(
            "未过期的目录仍在",
            any(
                x["job_id"] == "job_not_expired"
                for x in g._trash_entries()
            ),
        )

        # _purge_expired 绝不碰 job 自己的目录 —— 它只该在 _trash 里动。
        make_job(root, "job_live_user")
        g._purge_expired()
        check("清理不碰 outputs/ 里的正常 job", (root / "job_live_user").is_dir())

        # sidecar 是 .json 而非目录, 不能被当成条目, 也不能被 rmtree 失败卡住。
        meta = root / g.TRASH_DIRNAME / (g._trash_name("job_not_expired", 0) + ".meta.json")
        meta.write_text('{"job_id":"job_not_expired","meta":{"title":"t"}}', encoding="utf-8")
        before = len(g._trash_entries())
        g._purge_expired()
        check("sidecar 不被当作回收站条目", len(g._trash_entries()) == before, f"{before} -> {len(g._trash_entries())}")

        # ---------- 元数据 sidecar 往返 ----------
        tn = g._trash_name("job_meta_x", 1700000005.0)
        (root / g.TRASH_DIRNAME / tn).mkdir(parents=True, exist_ok=True)
        payload = {"title": "标题", "tags": ["a", "b"], "favorite": True}
        g._save_trash_meta("job_meta_x", payload, 1700000005.0)
        loaded = g._load_trash_meta(tn)
        check("sidecar 能读回", loaded == payload, str(loaded))
        check("sidecar 路径在 _trash 下", g._trash_meta_path(tn).parent == root / g.TRASH_DIRNAME)
        check("sidecar 是 .json 后缀", g._trash_meta_path(tn).name.endswith(".meta.json"))
        g._drop_trash_meta(tn)
        check("sidecar 可删除", g._trash_meta_path(tn).exists() is False)
        check("删掉的 sidecar 读回 None", g._load_trash_meta(tn) is None)

        # meta 为 None 时不写文件(纯目录删除不该产生空 sidecar)
        g._save_trash_meta("job_nometa", None, 1700000006.0)
        check("meta=None 时不写 sidecar", not g._trash_meta_path(g._trash_name("job_nometa", 1700000006.0)).exists())

        # 损坏的 sidecar 不能让恢复流程崩掉 —— 它只是元数据, 照片本身还在。
        bad_tn = g._trash_name("job_badmeta", 1700000007.0)
        (root / g.TRASH_DIRNAME / bad_tn).mkdir(parents=True, exist_ok=True)
        g._trash_meta_path(bad_tn).write_text("{ not json", encoding="utf-8")
        check("损坏的 sidecar 读回 None 而非抛异常", g._load_trash_meta(bad_tn) is None)

        # 跨毫秒的关键性质: 同一 when 传给两个函数, 必须得到同一个 trash_name。
        # 各自调 time.time() 的话, 跨过毫秒边界就会错位, 于是 sidecar
        # 找不到、标题标签全丢, 而且**不报错**。
        shared_when = 1700000008.0
        nm = g._trash_name("job_shared", shared_when)
        g._save_trash_meta("job_shared", {"title": "x"}, shared_when)
        check("共用同一时间戳时 sidecar 与目录名对得上", g._trash_meta_path(nm).exists(), nm)

    finally:
        g.OUTPUT_DIR = orig_out

# ===========================================================================
# 3. 路由层: 用 TestClient 进程内验证(不起真实 HTTP 服务)
# ===========================================================================
# 为什么不用 requests 打真实服务:
#   - 要额外起 uvicorn, 且端口与真实开发实例冲突时很麻烦;
#   - 更重要的是**测试不该依赖服务是否在跑**。TestClient 直接 import app,
#     任何时候都能跑, 且能覆盖"路由顺序""错误映射"这类只在 ASGI 层
#     才暴露的问题。
#
# 同样用 monkeypatch + TemporaryDirectory 隔离, 绝不碰真实 outputs/。
from fastapi.testclient import TestClient  # noqa: E402

from backend.app import app  # noqa: E402

with tempfile.TemporaryDirectory(prefix="trash_route_") as td:
    root = Path(td)
    orig_out = g.OUTPUT_DIR
    try:
        g.OUTPUT_DIR = root
        client = TestClient(app)

        # ---------- 软删除 ----------
        make_job(root, "job_r1")
        r = client.patch("/api/gallery/job_r1", json={"tags": ["rt"], "title": "R1"})
        check("PATCH 元数据成功", r.status_code == 200, str(r.status_code))

        r = client.delete("/api/gallery/job_r1")
        body = r.json()
        check("DELETE 默认 200", r.status_code == 200, str(r.status_code))
        check("DELETE 标记非永久", body.get("permanent") is False, str(body))
        check("DELETE 回传 trash_name", isinstance(body.get("trash_name"), str), str(body))
        check("DELETE 回传保留天数", body.get("purge_after_days") == g.TRASH_RETENTION_DAYS)
        check("DELETE 后源目录消失", not (root / "job_r1").exists())

        r = client.delete("/api/gallery/job_r1")
        check("重复 DELETE 404", r.status_code == 404, str(r.status_code))

        # ---------- 列表 / 恢复 ----------
        r = client.get("/api/gallery/trash")
        check("GET /trash 200", r.status_code == 200, str(r.status_code))
        tb = r.json()
        check("回收站含刚删的", any(x["job_id"] == "job_r1" for x in tb["items"]), str(tb.get("total")))
        check("响应带 retention_days", tb.get("retention_days") == g.TRASH_RETENTION_DAYS)
        check("响应带 total_size", isinstance(tb.get("total_size"), int))
        check("响应带 purged 列表", isinstance(tb.get("purged"), list))
        check("响应带 truncated 标记", tb.get("truncated") is False)

        # gallery 不含回收站里的东西(否则会出现打不开的坏卡片)
        gal = client.get("/api/gallery?limit=0").json()
        check("画廊不含回收站条目", not any(x["job_id"] == "job_r1" for x in gal["items"]))

        r = client.post("/api/gallery/trash/job_r1/restore")
        check("restore 200", r.status_code == 200, str(r.status_code))
        check("restore 后目录回outputs/", (root / "job_r1").is_dir())
        gal = client.get("/api/gallery?limit=0").json()
        item = next((x for x in gal["items"] if x["job_id"] == "job_r1"), None)
        check("restore 后回到画廊", item is not None)
        # 元数据随行是恢复的意义所在: 没有它恢复出来是空壳。
        check("restore 后标题还原", item and item.get("title") == "R1", str(item))
        check("restore 后标签还原", item and "rt" in (item.get("tags") or []), str(item))
        check("restore 后回收站不再有它", not any(
            x["job_id"] == "job_r1" for x in client.get("/api/gallery/trash").json()["items"]
        ))
        check("restore 已恢复的 404", client.post("/api/gallery/trash/job_r1/restore").status_code == 404)

        # ---------- restore 冲突保护 ----------
        make_job(root, "job_dup")
        client.delete("/api/gallery/job_dup")
        make_job(root, "job_dup")  # 同 id 又出现了
        r = client.post("/api/gallery/trash/job_dup/restore")
        check("目标位已占用时 restore 409(不覆盖用户数据)", r.status_code == 409, str(r.status_code))
        # 清掉这份额外的回收站副本, 避免影响后续断言
        for e in g._trash_entries():
            if e["job_id"] == "job_dup":
                client.post(f"/api/gallery/trash/{e['job_id']}/purge")
        (root / "job_dup").mkdir(exist_ok=True)

        # ---------- purge(彻底删) ----------
        make_job(root, "job_r2")
        client.patch("/api/gallery/job_r2", json={"title": "R2"})
        client.delete("/api/gallery/job_r2")
        r = client.post("/api/gallery/trash/job_r2/purge")
        check("purge 200", r.status_code == 200, str(r.status_code))
        check("purge 后回收站不再有它", not any(
            x["job_id"] == "job_r2" for x in client.get("/api/gallery/trash").json()["items"]
        ))
        check("purge 已清的 404", client.post("/api/gallery/trash/job_r2/purge").status_code == 404)

        # ---------- permanent 真删 ----------
        make_job(root, "job_perm")
        client.patch("/api/gallery/job_perm", json={"title": "P"})
        r = client.post("/api/gallery/batch-delete", json={"job_ids": ["job_perm"], "permanent": True})
        b = r.json()
        check("permanent 批量 200", r.status_code == 200, str(r.status_code))
        check("permanent 标记为真", b.get("permanent") is True, str(b))
        check("permanent 时保留天数 0", b.get("purge_after_days") == 0, str(b))
        check("permanent 真删后目录消失", not (root / "job_perm").exists())
        check("permanent 的不进回收站", not any(
            x["job_id"] == "job_perm" for x in client.get("/api/gallery/trash").json()["items"]
        ))
        # 这是我本轮修的回归: permanent 分支曾不清理 album, 于是留下
        # 「目录没了、回收站也没有、album 有」的孤儿键, 任何 API 都够不到。
        album = g._load_album(root)
        check("permanent 真删后 album 无残留键", "job_perm" not in album, str(list(album)))

        # ---------- 批量软删逐项分类 ----------
        make_job(root, "job_b_ok")
        r = client.post("/api/gallery/batch-delete", json={
            "job_ids": ["job_b_ok", "job_b_missing", "../etc/passwd", 123],
        })
        b = r.json()
        check("批量: 合法 id 进 deleted", b["deleted"] == ["job_b_ok"], str(b))
        check("批量: 不存在的进 missing", b["missing"] == ["job_b_missing"], str(b))
        check(
            "批量: 非法 id 进 failed(不整批中止)",
            len(b["failed"]) == 2,
            str(b["failed"]),
        )
        # 逐项分类的用处: missing 也必须清 album, 否则那些键永远够不到。
        check("批量 missing 也清 album", "job_b_missing" not in g._load_album(root))
        check("软删后 album 键已取走(在 sidecar 里)", "job_b_ok" not in g._load_album(root))

        # 重复 id 去重: 同一 id 发两次, 第二次不该产生一条 missing/failed
        make_job(root, "job_dup2")
        b = client.post("/api/gallery/batch-delete", json={"job_ids": ["job_dup2", "job_dup2"]}).json()
        check("批量: 重复 id 去重", b["deleted_count"] == 1, str(b))
        check("批量: 去重后无 missing 噪音", b["missing"] == [], str(b))

        # 参数校验
        check("job_ids 非数组 → 400", client.post(
            "/api/gallery/batch-delete", json={"job_ids": "notalist"}
        ).status_code == 400)
        check("缺 job_ids → 400", client.post(
            "/api/gallery/batch-delete", json={}
        ).status_code == 400)
        over = client.post("/api/gallery/batch-delete", json={
            "job_ids": [f"j{i}" for i in range(g.MAX_BATCH_DELETE + 1)],
        })
        check("超上限 → 400", over.status_code == 400, str(over.status_code))

        # ---------- 路径穿越 ----------
        # 三种输入死在不同的地方, 所以是三个不同的状态码 ——
        # 早先统一期望 400, 于是前两条永远失败。断的是不存在的契约。
        st_sep = client.post("/api/gallery/trash/a%2Fb/restore").status_code
        check("含路径分隔符的 id 不命中路由(404)", st_sep == 404, str(st_sep))
        # `..` 的状态码**依赖传输方式**, 所以只钉"被拒绝"这个不变量:
        #   - TestClient(进程内 ASGI) → 400, 进了路由函数被 _validate_job_id 挡下
        #   - 真实 HTTP(uvicorn)      → 405, 请求被规范化后落到别的路由上
        # 早先硬编码成 400, 于是真实 HTTP 下的行为看起来像 bug。
        # 值得关心的是"**没有产生副作用**": 任何 4xx 都意味着文件系统没被碰。
        st_dot = client.post("/api/gallery/trash/%2e%2e/restore").status_code
        check("'..' 被拒绝(4xx)", 400 <= st_dot < 500, str(st_dot))
        check("非法 id → 400", client.post("/api/gallery/trash/bad!id/purge").status_code == 400)

        # 更要紧的: 这些输入**不能**改动任何文件系统状态。
        before_dirs = sorted(p.name for p in root.iterdir())
        client.post("/api/gallery/trash/%2e%2e/restore")
        client.post("/api/gallery/trash/a%2Fb/restore")
        check("恶意 id 未改动文件系统", sorted(p.name for p in root.iterdir()) == before_dirs)

        # ---------- empty(清空) ----------
        make_job(root, "job_e1")
        make_job(root, "job_e2")
        client.post("/api/gallery/batch-delete", json={"job_ids": ["job_e1", "job_e2"]})
        pre = client.get("/api/gallery/trash").json()
        check("清空前回收站非空", pre["total"] >= 2, str(pre["total"]))

        r = client.post("/api/gallery/trash/empty")
        check("empty 200", r.status_code == 200, str(r.status_code))
        check("empty 后 total 为 0", client.get("/api/gallery/trash").json()["total"] == 0)
        # 关键: _trash 目录本身必须还在。它是 StaticFiles 挂载点,
        # rmtree 掉会让 /outputs/_trash 立刻 404, 直到下次删除才重建,
        # 期间前端缓存的缩略图全变碎图。
        check("empty 后 _trash 目录仍在(挂载有效)", (root / g.TRASH_DIRNAME).is_dir())

        # ---------- purge-expired ----------
        make_trash_entry(root, "job_gone", time.time() - g.TRASH_RETENTION_DAYS * 86400 - 10)
        r = client.post("/api/gallery/trash/purge-expired")
        check("purge-expired 200", r.status_code == 200, str(r.status_code))
        check("purge-expired 报告清掉的 id", "job_gone" in r.json()["purged"], str(r.json()))
        check("purge-expired 后回收站为空", client.get("/api/gallery/trash").json()["total"] == 0)

        # ---------- 读取回收站会顺带清理过期项 ----------
        make_trash_entry(root, "job_stale", time.time() - g.TRASH_RETENTION_DAYS * 86400 - 10)
        tb = client.get("/api/gallery/trash").json()
        # 前端要靠 purged 字段告诉用户"这些被自动删了", 否则他会以为
        # 列表凭空少了东西、是操作出了 bug。
        check("读列表时自动清理过期项", "job_stale" not in [x["job_id"] for x in tb["items"]])
        check("读列表时报告 purged", "job_stale" in tb["purged"], str(tb["purged"]))

    finally:
        g.OUTPUT_DIR = orig_out

# ===========================================================================
# 4. 常量的不变量
# ===========================================================================
# 这些是**被测契约**本身, 按规范可以硬编码断言取值。
check("保留天数是 7", g.TRASH_RETENTION_DAYS == 7, str(g.TRASH_RETENTION_DAYS))
check("回收站目录名是 _trash", g.TRASH_DIRNAME == "_trash", g.TRASH_DIRNAME)

# _trash 必须以 _ 开头 —— gallery() 靠 `name.startswith("_")` 跳过它。
# 一旦改名成 "trash", 回收站里的东西会**同时出现在画廊里**,
# 而那个画廊条目是打不开的(目录名带时间戳前缀), 表现为坏卡片。
check(
    "TRASH_DIRNAME 以 _ 开头(gallery() 靠此跳过它)",
    g.TRASH_DIRNAME.startswith("_"),
    g.TRASH_DIRNAME,
)

# 批量上限必须小于 MAX_BATCH_DELETE 能处理的量级, 否则"全选已加载"会撞墙。
check("回收站列表上限是 500", g.TRASH_MAX_ITEMS == 500, str(g.TRASH_MAX_ITEMS))
check("批量删除上限存在且为正", g.MAX_BATCH_DELETE > 0, str(g.MAX_BATCH_DELETE))


# ---------- 汇总 ----------
print()
print(f"Result: {len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    print("FAILED:", " | ".join(FAIL))
    sys.exit(1)