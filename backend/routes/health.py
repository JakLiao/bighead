"""健康检查 + 元数据(风格/滤镜/相框/排版)."""
from __future__ import annotations

from fastapi import APIRouter
import torch

from ..config import FILTERS, FRAMES, LAYOUTS, STYLES
from ..schemas import FilterInfo, FrameInfo, HealthResponse, LayoutInfo, MetaResponse, StyleInfo

router = APIRouter()


@router.get("/api/health", response_model=HealthResponse)
async def health():
    if torch.cuda.is_available():
        free = (torch.cuda.mem_get_info()[0]) / 1e9
        name = torch.cuda.get_device_name(0)
    else:
        free, name = 0.0, "cpu"
    return HealthResponse(ok=True, gpu=name, vram_free_gb=round(free, 2))


@router.get("/api/meta", response_model=MetaResponse)
async def meta():
    return MetaResponse(
        styles=[StyleInfo(key=k, name=v["name"], prompt_prefix=v["prompt_prefix"],
                          negative_prompt=v["negative_prompt"], lora_scale=v["lora_scale"],
                          faceid_scale=v["faceid_scale"]) for k, v in STYLES.items()],
        filters=[FilterInfo(key=k, name=v["name"]) for k, v in FILTERS.items()],
        frames=[FrameInfo(key=k, name=v["name"]) for k, v in FRAMES.items()],
        layouts=[LayoutInfo(key=k, name=v["name"], cols=v["cols"], rows=v["rows"]) for k, v in LAYOUTS.items()],
    )
