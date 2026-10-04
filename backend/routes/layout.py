"""拼图排版:接收 N 张图(layout 字符串),返回拼好的 PNG/JPG."""
from __future__ import annotations

import io

from fastapi import APIRouter, File, Form, HTTPException, Response
from PIL import Image

from ..config import LAYOUTS

router = APIRouter()


@router.post("/api/layout/make")
def layout_make(
    images: list[bytes] = File(...),
    layout: str = Form("2x2"),
    frame: str = Form("plain_white"),
):
    """拼图排版。

    刻意用同步 def: 解码 N 张图 + 拼接 + JPEG 编码是 CPU 密集操作,
    在事件循环里执行会阻塞同 worker 上的所有请求(含 WebSocket 进度推送)。
    FastAPI 对普通 def 自动走线程池。参见 preview.preview_filter 的说明。
    """
    if layout not in LAYOUTS:
        raise HTTPException(400, f"unknown layout: {layout}")
    try:
        pils = [Image.open(io.BytesIO(b)) for b in images]
    except Exception as e:
        raise HTTPException(400, f"invalid image bytes: {e}")

    # 动态导入避免循环
    from ..layouts import collage_to_bytes

    data = collage_to_bytes(pils, layout=layout, frame=frame, fmt="JPEG")
    return Response(content=data, media_type="image/jpeg")
