"""健康检查 + 元数据(风格/滤镜/相框/排版)."""
from __future__ import annotations

from fastapi import APIRouter
import torch

from ..config import ERA_PRESETS, FILTERS, FRAMES, LAYOUTS, STYLES
from ..schemas import (
    EraInfo,
    FilterInfo,
    FrameInfo,
    HealthResponse,
    LayoutInfo,
    MetaResponse,
    StyleInfo,
)

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
        filters=[
            FilterInfo(
                key=k,
                name=v["name"],
                css=v.get("css", ""),
                vignette=float(v["params"].get("vignette", 0.0)),
            )
            for k, v in FILTERS.items()
        ],
        frames=[
            FrameInfo(
                key=k,
                name=v["name"],
                pad=int(v["params"].get("pad", 0)),
                bottom_pad=int(v["params"].get("bottom_pad", 0)),
                bg=str(v["params"].get("bg", "#ffffff")),
                title=str(v["params"].get("title", "")),
            )
            for k, v in FRAMES.items()
        ],
        layouts=[LayoutInfo(key=k, name=v["name"], cols=v["cols"], rows=v["rows"]) for k, v in LAYOUTS.items()],
        era_presets=[EraInfo(key=k, name=v) for k, v in ERA_PRESETS.items()],
    )
