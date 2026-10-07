"""capture_save 的失败回滚验证: 出错时不得在 outputs/ 留下任何痕迹。

被测的 bug
----------
`capture_save` 曾在进循环**之前**无条件 `job_dir.mkdir()`, 于是三条失败
路径都会留下垃圾目录:

  1. 第 1 张 `_check_image` 抛 400/413  -> 零文件目录
  2. 前几张已落盘、后一张校验失败        -> 只含 photo_1.jpg 的**残缺**目录
  3. 客户端中途断开(CancelledError)     -> 零文件或残缺目录

这些目录最恶劣的地方不是"占地方", 而是**响应是错误, 前端拿不到 job_id**:
于是它们成了任何 API 都够不到的孤儿(删不掉、查不到), 只会随失败次数
单调堆积, 并在 gallery() 的判空被摘掉的那天集体涌进画廊变成碎图卡片。

方案: 惰性建目录(校验通过、真的要落盘才 mkdir) + 异常回滚。

为什么不只在画廊侧过滤空目录
----------------------------
那等于把「我们的代码不该犯错」当成前提。本脚本钉的是**根因**:
每次失败之后, outputs/ 的状态与失败前逐条目相同。

测试隔离
--------
全部在 TemporaryDirectory 里跑, 并 monkeypatch `cap.OUTPUT_DIR`
(与 verify_gallery_trash.py 同一手法)。capture.py 是
`from ..config import OUTPUT_DIR`, 所以**必须**改模块属性 `cap.OUTPUT_DIR`,
改 `config.OUTPUT_DIR` 不会生效。

这一点必须做到位: 真实 outputs/ 里有用户的照片, 而回滚逻辑会 rmtree 目录
—— 测试一旦漏了隔离, 就是在删用户数据。这里用 TemporaryDirectory 而不是
「跑完按特征扫全量删除」(见 docs/testing-standards.md §3), 前者天然免疫。

跑法(webui venv):
    & "E:\\Code\\stable-diffusion-webui\\.venv\\Scripts\\python.exe" backend\\scripts\\verify_capture_rollback.py
"""
from __future__ import annotations

import asyncio
import base64
import io
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.routes import capture as cap  # noqa: E402
from backend.routes import gallery as g  # noqa: E402

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{('  ' + detail) if detail else ''}")


def jpeg_bytes() -> bytes:
    """最小可解码 JPEG。

    必须是真图: _check_image 会用 Pillow 实际 verify(), 拿 b"x" 当样本
    测到的就是另一条分支, 诊断信息会被带偏。
    """
    return base64.b64decode(
        "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof"
        "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB"
        "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=="
    )


# 不是图片的字节。刻意**不**用空串: 空文件走 _check_image 里"空文件"那条
# 分支, 混进来会让「解码失败」这条断言的诊断信息失真。
NOT_IMAGE = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


class FakeUpload:
    """capture_save 用到的 UploadFile 最小替身。

    为什么要替身而不是构造真的 starlette UploadFile: §5 要在**第 2 张读到
    一半时**抛 CancelledError, 而真的 UploadFile 只会老实地把字节读完 ——
    构造不出"连接中途断掉"这个最常见的失败场景。
    """

    def __init__(self, data: bytes, content_type: str = "image/jpeg",
                 boom: bool = False) -> None:
        self._buf = io.BytesIO(data)
        self.content_type = content_type
        self._boom = boom

    async def read(self, size: int = -1) -> bytes:
        if self._boom:
            raise asyncio.CancelledError()
        return self._buf.read(size)


def listing(root: Path) -> set[str]:
    """outputs/ 下的条目名集合 —— 用来断言「磁盘状态没变」。"""
    if not root.is_dir():
        return set()
    return {p.name for p in root.iterdir()}


async def cancel_midway() -> None:
    """第 1 张正常落盘, 第 2 张读到一半时连接断开。"""
    await cap.capture_save(images=[
        FakeUpload(jpeg_bytes()),
        FakeUpload(jpeg_bytes(), boom=True),
    ])  # type: ignore[arg-type]


from fastapi.testclient import TestClient  # noqa: E402

from backend.app import app  # noqa: E402


with tempfile.TemporaryDirectory(prefix="capture_rb_") as td:
    root = Path(td)
    orig_out = cap.OUTPUT_DIR
    orig_gal = g.OUTPUT_DIR
    try:
        cap.OUTPUT_DIR = root
        # **两个模块都要改**: capture.py 与 gallery.py 各自
        # `from ..config import OUTPUT_DIR`, 各自持有独立的绑定。
        # 只改 capture 的话, §7 的 /api/gallery 会去扫**真实的** outputs/ ——
        # 实测会读到本机几十个真 job, 然后「画廊里出现了没见过的 id」全判红,
        # 而被读的是用户的照片。测试**读**用户数据即使不删也已经是事故,
        # 且症状(莫名其妙的 FAIL)与原因(隔离漏了)隔了三层, 极难自查。
        g.OUTPUT_DIR = root
        client = TestClient(app)

        def post(*payloads: tuple[str, bytes, str]):
            files = [("images", (n, d, ct)) for n, d, ct in payloads]
            return client.post("/api/capture/save", files=files)

        # ===============================================================
        # 1. 正常路径: 一个都不能少(回滚不能误伤成功的请求)
        # ===============================================================
        before = listing(root)
        r = post(("a.jpg", jpeg_bytes(), "image/jpeg"),
                 ("b.jpg", jpeg_bytes(), "image/jpeg"))
        check("正常上传 200", r.status_code == 200, str(r.status_code))
        body = r.json()
        check("正常上传回 job_id", bool(body.get("job_id")), str(body))
        check("正常上传 count 与张数一致", body.get("count") == 2, str(body))
        ok_dir = root / body["job_id"]
        check("正常上传目录已建", ok_dir.is_dir(), str(ok_dir))
        check(
            "正常上传的照片文件都在",
            sorted(p.name for p in ok_dir.glob("photo_*.jpg")) == ["photo_1.jpg", "photo_2.jpg"],
            str(sorted(p.name for p in ok_dir.glob("photo_*.jpg"))),
        )
        check("正常上传逐字节一致(无重编码)",
              (ok_dir / "photo_1.jpg").read_bytes() == jpeg_bytes())
        check("photos 里的 URL 指向真实文件",
              all((root / u.removeprefix("/outputs/")).is_file() for u in body["photos"]),
              str(body["photos"]))
        check("正常上传恰好新增一个目录", listing(root) - before == {body["job_id"]},
              str(listing(root) - before))
        # 后面几节都拿这个数当基线: 成功的 2 张。
        baseline_photos = len(list(root.rglob("photo_*.jpg")))
        check("基线照片数为成功上传的张数", baseline_photos == 2, str(baseline_photos))

        # ===============================================================
        # 2. 回归本体: 第一张就非法 -> outputs/ 必须**完全没变**
        # ===============================================================
        # 改前泄漏的主路径: mkdir 已成功, _check_image 才抛。
        before = listing(root)
        r = post(("bad.png", NOT_IMAGE, "image/png"))
        check("首张非法 → 400", r.status_code == 400, str(r.status_code))
        check("首张非法 → outputs/ 逐条目无变化",
              listing(root) == before, f"新增={listing(root) - before}")
        # 单独再钉一次: 只断言「目录里没文件」的话, 一个空目录也能通过 ——
        # 那正是原 bug 留下的东西。
        check("首张非法 → 没有留下任何零文件目录",
              not [d.name for d in root.iterdir() if d.is_dir() and not any(d.iterdir())],
              str([d.name for d in root.iterdir() if d.is_dir()]))

        # ===============================================================
        # 3. 回归本体: 前两张已落盘、第三张非法 -> 残缺目录必须被清掉
        # ===============================================================
        # 比 §2 更隐蔽: 目录里已经有 2 个 photo_*.jpg, 不是空目录, 于是
        # 「只跳过空目录」的兜底完全拦不住它, 而画廊会把它渲染成一张
        # 只有 2 张照片的假 job —— 用户会以为这组连拍存下来了。
        before = listing(root)
        r = post(("ok1.jpg", jpeg_bytes(), "image/jpeg"),
                 ("ok2.jpg", jpeg_bytes(), "image/jpeg"),
                 ("bad.png", NOT_IMAGE, "image/png"))
        check("中途失败 → 400", r.status_code == 400, str(r.status_code))
        check("中途失败 → outputs/ 逐条目无变化(残缺目录被回滚)",
              listing(root) == before, f"新增={listing(root) - before}")
        check("中途失败 → 磁盘上 photo 文件数回到基线",
              len(list(root.rglob("photo_*.jpg"))) == baseline_photos,
              str(len(list(root.rglob("photo_*.jpg")))))

        # ===============================================================
        # 4. 其余 400/413 分支: 同样不得留痕
        # ===============================================================
        # 逐个分支都钉: 它们抛在循环的不同位置(读的过程中 / 校验时),
        # 任何一条漏掉回滚都会让 outputs/ 悄悄长出垃圾。
        cases: list[tuple[str, list[tuple[str, bytes, str]], int]] = [
            ("空文件", [("e.jpg", b"", "image/jpeg")], 400),
            ("不支持的类型", [("x.gif", jpeg_bytes(), "image/gif")], 400),
            ("首张空文件", [("e.jpg", b"", "image/jpeg"),
                            ("ok.jpg", jpeg_bytes(), "image/jpeg")], 400),
            ("首张类型不支持", [("x.gif", jpeg_bytes(), "image/gif"),
                                ("ok.jpg", jpeg_bytes(), "image/jpeg")], 400),
            ("超限", [("big.jpg", b"\xff\xd8\xff" + b"\x00" * (cap.MAX_BYTES + 1),
                     "image/jpeg")], 413),
        ]
        for name, payloads, want in cases:
            before = listing(root)
            r = post(*payloads)
            check(f"{name} → {want}", r.status_code == want, str(r.status_code))
            check(f"{name} 且不留痕", listing(root) == before,
                  f"新增={listing(root) - before}")

        # 请求体层面的拒绝发生在建目录之前, 顺手钉一下。
        before = listing(root)
        check("不带 images → 4xx",
              client.post("/api/capture/save").status_code // 100 == 4)
        over = client.post("/api/capture/save", files=[
            ("images", (f"p{i}.jpg", jpeg_bytes(), "image/jpeg"))
            for i in range(cap.MAX_PHOTOS + 1)
        ])
        check("超张数 → 400", over.status_code == 400, str(over.status_code))
        check("超张数不留痕", listing(root) == before, f"新增={listing(root) - before}")

        # 连续多次失败不得单调堆积 —— 这是「泄漏」这个词的字面含义。
        before = listing(root)
        for _ in range(5):
            post(("bad.png", NOT_IMAGE, "image/png"))
        check("连续 5 次失败后 outputs/ 仍无新增", listing(root) == before,
              f"新增={listing(root) - before}")

        # ===============================================================
        # 5. CancelledError 必须同样触发回滚(最常见的失败方式)
        # ===============================================================
        # 「传一半断了」是连拍最常见的失败: 切后台/关页面/切网络。
        # asyncio.CancelledError 继承自 **BaseException**(3.8+), 所以这里
        # 同时钉住两件事: ① 用 BaseException 接而不是 Exception
        # ② 真的清干净。只钉 ① 会漏掉「接住了但没清」这种退化。
        before = listing(root)
        try:
            asyncio.run(cancel_midway())
            check("CancelledError 原样向上抛", False, "居然正常返回了")
        except asyncio.CancelledError:
            check("CancelledError 原样向上抛", True)
        except BaseException as e:  # noqa: BLE001
            check("CancelledError 原样向上抛", False, f"变成了 {type(e).__name__}: {e}")
        check("CancelledError → outputs/ 无残留", listing(root) == before,
              f"新增={listing(root) - before}")
        check("CancelledError → photo 文件数回到基线",
              len(list(root.rglob("photo_*.jpg"))) == baseline_photos,
              str(len(list(root.rglob("photo_*.jpg")))))

        # ===============================================================
        # 6. 回滚不许误伤「不是本次建的」目录
        # ===============================================================
        # new_job() 是 uuid4 前 12 位, 撞 id 概率低到可忽略 —— 但回滚会
        # rmtree, 一旦撞上就是删掉用户**别的**整次拍摄。这里用确定性注入
        # (patch new_job 返回一个已存在的 id) 把这条低概率灾难变成必跑。
        #
        # 受害者目录里只放 capture_save **不会写**的文件名(share/layout/
        # photo_7): 撞 id 时本次会写 photo_1/photo_2, 与它们不重叠, 于是
        # 断言「一个都没少」测的就是纯粹的"删了不该删的"。
        victim = root / "collide000001"
        victim.mkdir()
        for keep in ("share.jpg", "layout.jpg", "photo_7.jpg"):
            (victim / keep).write_bytes(jpeg_bytes())
        orig_new_job = cap.new_job
        try:
            cap.new_job = lambda: "collide000001"  # type: ignore[assignment]
            r = post(("ok.jpg", jpeg_bytes(), "image/jpeg"),
                     ("bad.png", NOT_IMAGE, "image/png"))
            check("撞 id 后失败 → 仍是 400", r.status_code == 400, str(r.status_code))
            check("撞 id 时**不删**已有目录(灾难性回归)", victim.is_dir(),
                  f"victim 被 rmtree 了: {victim}")
            # 目录不在时**不能**直接 iterdir(): 那会抛 FileNotFoundError
            # 把脚本整个带崩, 而崩溃栈看不出「是哪条契约破了」。
            # 这正是 testing-standards §2.2 说的"销毁诊断信息"。
            left = sorted(p.name for p in victim.iterdir()) if victim.is_dir() else []
            check("撞 id 时已有文件一个都没少",
                  left == ["layout.jpg", "photo_7.jpg", "share.jpg"], str(left))
            check("撞 id 时本次写入的照片被回滚",
                  not (victim / "photo_1.jpg").exists(),
                  "本次写的 photo_1.jpg 残留了")
        finally:
            cap.new_job = orig_new_job

        # ===============================================================
        # 7. 端到端: 失败请求不得在画廊里留下任何条目
        # ===============================================================
        # 不只看磁盘, 也看用户实际看到的东西 —— 碎图卡片才是这个 bug 的
        # 可见症状, 而"目录不存在"只是它的成因。
        gal = client.get("/api/gallery?limit=0").json()
        check("画廊里没有零文件的卡片(旧 bug 的可见症状)",
              all(x["media"] for x in gal["items"]),
              str([x["job_id"] for x in gal["items"] if not x["media"]]))
        check("画廊 total 与 items 一致(判空发生在切片之前)",
              gal["total"] == len(gal["items"]),
              f"total={gal['total']} items={len(gal['items'])}")
        check("成功上传的那次确实出现在画廊里(正向夹逼, 证明上面两条不是恒真)",
              any(x["job_id"] == body["job_id"] for x in gal["items"]),
              body["job_id"])
        # 只允许出现两个目录: §1 成功建的那个, 与 §6 手动造的 victim。
        # 任何第三个都来自某次失败请求 —— 失败请求的 job_id 是后端随机生成
        # 的, 前端拿不到, 所以这里用「显式白名单」而不是「反推哪些像我造的」
        # (见 testing-standards §3)。
        allowed = {body["job_id"], "collide000001"}
        leaked = [x["job_id"] for x in gal["items"] if x["job_id"] not in allowed]
        check("画廊里只有本次明确建的两个目录", not leaked, str(leaked))

    finally:
        cap.OUTPUT_DIR = orig_out
        g.OUTPUT_DIR = orig_gal

# ===========================================================================
# 8. 被测契约本身的常量
# ===========================================================================
# 按 docs/testing-standards.md: 该数量本身就是被测契约时可以钉取值。
check("单次上限是 8 张", cap.MAX_PHOTOS == 8, str(cap.MAX_PHOTOS))
check("单张上限是 16MB", cap.MAX_BYTES == 16 * 1024 * 1024, str(cap.MAX_BYTES))
check("允许的类型仍是那 4 种(回滚没顺手改契约)",
      cap.ALLOWED_TYPES == {"image/jpeg", "image/jpg", "image/png", "image/webp"},
      str(cap.ALLOWED_TYPES))

# 回滚函数本身必须容错: 它拿到的路径可能已经不存在(并发清理)。
t_root = Path(tempfile.mkdtemp(prefix="capture_rb_unit_"))
try:
    gone = t_root / "gone"
    gone.mkdir()
    f = gone / "photo_1.jpg"
    f.write_bytes(jpeg_bytes())
    f.unlink()
    cap._rollback(gone, [f], created_dir=True)
    check("_rollback 能容忍文件已不存在", not gone.exists())
    survivor = t_root / "survivor"
    survivor.mkdir()
    (survivor / "a.jpg").write_bytes(jpeg_bytes())
    cap._rollback(survivor, [], created_dir=False)
    check("_rollback 在 created_dir=False 时不删目录", survivor.is_dir())
finally:
    import shutil

    shutil.rmtree(t_root, ignore_errors=True)


# ---------- 汇总 ----------
print()
print(f"Result: {len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    print("FAILED:", " | ".join(FAIL))
    sys.exit(1)
print("ALL GREEN")
sys.exit(0)