"""保存连拍原图到 outputs/{job_id}/photo_{i}.jpg."""
from __future__ import annotations

import io
import shutil
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from PIL import Image

from ..config import OUTPUT_DIR, PHOTO_FILENAME
from ..jobs import new_job

router = APIRouter()

# 一次连拍最多 4 张, 留 4 张余量给将来可能的连拍参数。
MAX_PHOTOS = 8
# 单张上限。手机原图直出常见 3~8MB, 16MB 足够宽裕; 不设限的话
# `await up.read()` 会把整个请求体读进内存, 一个 2GB 的文件就能打爆进程。
MAX_BYTES = 16 * 1024 * 1024
# 只接受图片。content-type 由客户端声明, 不能作为唯一依据, 所以落盘前
# 还要用 Pillow 实际解码一次 —— 声明 image/jpeg 但内容是任意字节的情况,
# 会在后面的 collage / 滤镜里才炸, 错误信息很难溯源。
ALLOWED_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp"}


def _check_image(data: bytes, content_type: str | None) -> None:
    if not data:
        raise HTTPException(400, "空文件")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, f"单张超过 {MAX_BYTES // 1024 // 1024}MB 限制")
    if content_type and content_type.split(";")[0].strip().lower() not in ALLOWED_TYPES:
        raise HTTPException(400, f"不支持的类型: {content_type}")
    # 实际解码验证: 声明类型不可信, 只有 Pillow 能真的解出来才算图片。
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.verify()
    except Exception as e:
        raise HTTPException(400, f"不是可解码的图片: {type(e).__name__}")


def _rollback(job_dir: Path, written: list[Path], created_dir: bool) -> None:
    """出错时把本次请求留下的痕迹擦掉。

    只删**本次写的文件**, 再删目录 —— 且目录只在**本次建的**时才删。
    分界必须这么划: new_job() 用 uuid4 前 12 位, 撞上已有 job 的概率
    低到可以忽略, 但「低到可以忽略」不等于「发生了也没事」。真撞上时
    rmtree 整个目录就是把用户**别的**拍摄连根拔掉, 而这里最坏的情况
    只是那个 job 少了几张照片(它本来就没写成功), 差距是灾难性的。

    顺带清掉 user 自己放进去的其它文件 —— 目录是我们建的, 里面就不该
    有别人的东西, 留着只会变成新的「空/残目录」泄漏源。

    OSError 一律吞掉: 回滚是**尽力而为**的清理, 失败了就让目录留在那儿
    等 gallery() 的判空兜底。把原始异常(400/413)换成 rmtree 的 OSError
    会让前端拿到一个语义完全错误的 500, 比留个空目录糟得多。
    """
    if created_dir:
        shutil.rmtree(job_dir, ignore_errors=True)
        return
    for p in written:
        try:
            p.unlink(missing_ok=True)
        except OSError:
            pass


@router.post("/api/capture/save")
async def capture_save(images: list[UploadFile] = File(...)):
    """保存连拍原图到 outputs/{job_id}/photo_{i}.jpg.

    **刻意不接受 era 参数**: 落盘的像素必须是调用方已经烧好的成片。
    前端 DecoratePage 在上传前就已经把 preset 与 era 一起走
    /api/preview/filter 烧进了 finalBlobs(见 DecoratePage.doLayout),
    这里再烧一次 era 会**叠两遍** —— era 算子不是幂等的: 低分辨率上采样
    会再糊一次、漏光会再抬一次、色阶会再砍一次, 结果是"糊上加糊"。
    保留这个 Form 字段时它还是一个静默的陷阱: 前端不传就恒为 ERA_DEFAULT,
    于是这条分支永远不执行, 看起来能跑、实际 era 从来没在这里生效过,
    而 docstring 里的"必须在存的时候就定死"又恰好说反了因果。

    所以现在只有一条路: 收到的字节就是最终字节, 原样 write_bytes,
    不解码不重编码 —— 顺带也就不再引入二次 JPEG 损失。

    **失败不留痕**(惰性建目录 + 回滚, 见下方注释)。这是这条路由与
    「先 mkdir 再干活」这种朴素写法的全部差别。
    """
    if not images:
        raise HTTPException(400, "没有收到图片")
    if len(images) > MAX_PHOTOS:
        raise HTTPException(400, f"一次最多 {MAX_PHOTOS} 张, 收到 {len(images)}")

    job_id = new_job()
    job_dir = OUTPUT_DIR / job_id
    written: list[Path] = []
    saved: list[str] = []
    # 目录是不是**本次建的**? 判定必须发生在 mkdir **之前** ——
    # mkdir(exist_ok=True) 对已存在的目录一样返回成功, 事后再查永远是
    # True, 于是回滚会 rmtree 掉一个不属于本次请求的目录(见 _rollback)。
    # 代价是每次请求多一次 stat, 与一次 mkdir 相比可以忽略。
    #
    # pre_existing(事先就在) 与 created_dir(本次建的) 是两件事, 不能合并:
    #   目录不在 -> 我们建 -> 回滚可以 rmtree
    #   目录已在 -> 不是我们建的 -> 回滚只能删自己写的那几个文件
    pre_existing = job_dir.exists()
    created_dir = False
    try:
        for i, up in enumerate(images[:MAX_PHOTOS]):
            # 分块读, 一旦超限立刻中断, 不把超大文件整个吃进内存。
            buf = bytearray()
            while chunk := await up.read(64 * 1024):
                buf.extend(chunk)
                if len(buf) > MAX_BYTES:
                    raise HTTPException(
                        413, f"第 {i + 1} 张超过 {MAX_BYTES // 1024 // 1024}MB 限制"
                    )
            data = bytes(buf)
            _check_image(data, up.content_type)
            # **惰性建目录**: 推迟到第一张真的要落盘时才 mkdir。
            #
            # 改前是进循环前无条件 mkdir, 于是「mkdir 成功 → _check_image
            # 抛 400/413」会在 outputs/ 里留下一个零文件目录。而响应是
            # 错误, 前端**拿不到 job_id**, 这个目录就成了任何 API 都够不到
            # 的孤儿: 删不掉、看不见(除非撞上别的 bug 让它漏进画廊)、
            # 只会随失败次数单调堆积。
            #
            # 推迟到校验之后还有个附带好处: 一次 4 张的连拍若第 1 张就
            # 不合法, 磁盘上不会出现任何写入 —— 校验全在内存里做完,
            # 确认要落了再 mkdir。
            if not created_dir and not pre_existing:
                job_dir.mkdir(parents=True, exist_ok=True)
                created_dir = True
            path = job_dir / PHOTO_FILENAME.format(idx=i + 1)
            path.write_bytes(data)
            written.append(path)
            saved.append(f"/outputs/{job_id}/{path.name}")
    except BaseException:
        # BaseException 而不是 Exception: 客户端中途断开时 Python 抛的是
        # CancelledError, 它继承自 BaseException(3.8+), 用 Exception 接不住
        # —— 而「传一半断了」恰恰是连拍最常见的失败方式, 漏掉它等于回滚
        # 在最需要的时候不生效。
        _rollback(job_dir, written, created_dir)
        raise
    return {"job_id": job_id, "photos": saved, "count": len(saved)}
