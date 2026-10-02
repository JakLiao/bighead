"""实时滤镜预览:接收图片字节,返回加滤镜后的图片字节."""
from __future__ import annotations

from fastapi import APIRouter, File, Form, Response

from ..filters import apply_filter_bytes

router = APIRouter()


@router.post("/api/preview/filter")
async def preview_filter(image: bytes = File(...), preset: str = Form("faded_90s")) -> Response:
    out = apply_filter_bytes(image, preset)
    return Response(content=out, media_type="image/jpeg")
