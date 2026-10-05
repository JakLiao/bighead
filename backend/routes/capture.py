"""保存连拍原图到 outputs/{job_id}/photo_{i}.jpg."""
from __future__ import annotations

import asyncio
import io

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from PIL import Image

from ..config import ERA_DEFAULT, ERA_KEYS, OUTPUT_DIR, PHOTO_FILENAME
from ..filters import apply_filter_bytes
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


@router.post("/api/capture/save")
async def capture_save(
    images: list[UploadFile] = File(...),
    era: str = Form(ERA_DEFAULT),
):
    """保存连拍原图到 outputs/{job_id}/photo_{i}.jpg.

    era 在这里烧进落盘的像素: 这批图是 AI 写真与画廊的**源**, 之后再改
    年代只能重拍, 所以必须在存的时候就定死。只有 era != modern 才解码重编码,
    modern 走原样落盘(不引入二次 JPEG 损失)。
    """
    if era not in ERA_KEYS:
        raise HTTPException(400, f"unknown era preset: {era}")
    if not images:
        raise HTTPException(400, "没有收到图片")
    if len(images) > MAX_PHOTOS:
        raise HTTPException(400, f"一次最多 {MAX_PHOTOS} 张, 收到 {len(images)}")

    job_id = new_job()
    job_dir = OUTPUT_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    saved: list[str] = []
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
        # 只烧 era 不烧 preset: preset 由取景页拍照那一刻烧进 burnedIn 快照
        # (或由 DecoratePage 补滤镜时烧), 这里再烧一次会叠加两遍。
        # 用 to_thread 把这段 CPU 密集的 OpenCV 挪出事件循环 —— handler 是
        # async, 直接调会卡住整个服务(见 preview.py 的同类说明)。
        if era != ERA_DEFAULT:
            data = await asyncio.to_thread(apply_filter_bytes, data, "none", era)
        path = job_dir / PHOTO_FILENAME.format(idx=i + 1)
        path.write_bytes(data)
        saved.append(f"/outputs/{job_id}/{path.name}")
    return {"job_id": job_id, "photos": saved, "count": len(saved)}
