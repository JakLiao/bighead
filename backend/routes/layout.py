"""拼图排版:接收 N 张图(layout 字符串),返回拼好的 PNG/JPG."""
from __future__ import annotations

import io
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Response
from PIL import Image

from ..config import LAYOUTS, OUTPUT_DIR

router = APIRouter()


@router.post("/api/layout/make")
async def layout_make(
    images: list[bytes] = File(...),
    layout: str = Form("2x2"),
    frame: str = Form("plain_white"),
):
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
