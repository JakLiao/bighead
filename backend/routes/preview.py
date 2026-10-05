"""实时滤镜预览:接收图片字节,返回加滤镜后的图片字节."""
from __future__ import annotations

import io

from fastapi import APIRouter, File, Form, HTTPException, Response
from PIL import Image, UnidentifiedImageError

from ..config import ERA_DEFAULT, ERA_KEYS, FILTERS
from ..filters import apply_filter

router = APIRouter()


@router.post("/api/preview/filter")
def preview_filter(
    image: bytes = File(...),
    preset: str = Form("faded_90s"),
    era: str = Form(ERA_DEFAULT),
) -> Response:
    """滤镜 + 年代处理 预览.

    era 与 preset 并列, 默认 modern(不动像素)。
    刻意用同步 def 而非 async def: 下面的 PIL 解码 / OpenCV 滤镜 / JPEG 编码
    全是 CPU 密集操作, 跑在事件循环里会把整个服务卡住 —— 期间 WebSocket
    进度推送与其他请求全部排队, 表现为前端「点了没反应」。
    FastAPI 对普通 def 会自动丢到线程池执行, 阻塞问题自然消失。
    对照 pipeline.generate_async 里用 asyncio.to_thread 挪走整段推理。
    """
    if preset not in FILTERS:
        raise HTTPException(400, f"unknown filter preset: {preset}")
    if era not in ERA_KEYS:
        raise HTTPException(400, f"unknown era preset: {era}")
    try:
        pil = Image.open(io.BytesIO(image))
        pil.load()
    except (UnidentifiedImageError, OSError) as e:
        raise HTTPException(400, f"invalid image bytes: {e}")

    out = apply_filter(pil, preset, era=era)
    buf = io.BytesIO()
    out.convert("RGB").save(buf, format="JPEG", quality=92)
    return Response(content=buf.getvalue(), media_type="image/jpeg")
