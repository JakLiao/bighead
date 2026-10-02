"""实时滤镜预览:接收图片字节,返回加滤镜后的图片字节."""
from __future__ import annotations

import io

from fastapi import APIRouter, File, Form, HTTPException, Response
from PIL import Image, UnidentifiedImageError

from ..config import FILTERS
from ..filters import apply_filter

router = APIRouter()


@router.post("/api/preview/filter")
async def preview_filter(image: bytes = File(...), preset: str = Form("faded_90s")) -> Response:
    if preset not in FILTERS:
        raise HTTPException(400, f"unknown filter preset: {preset}")
    try:
        pil = Image.open(io.BytesIO(image))
        pil.load()
    except (UnidentifiedImageError, OSError) as e:
        raise HTTPException(400, f"invalid image bytes: {e}")

    out = apply_filter(pil, preset)
    buf = io.BytesIO()
    out.convert("RGB").save(buf, format="JPEG", quality=92)
    return Response(content=buf.getvalue(), media_type="image/jpeg")
