"""Pydantic schemas."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    ok: bool
    gpu: str
    vram_free_gb: float


class StyleInfo(BaseModel):
    key: str
    name: str
    prompt_prefix: str
    negative_prompt: str
    lora_scale: float
    faceid_scale: float


class FilterInfo(BaseModel):
    key: str
    name: str


class FrameInfo(BaseModel):
    key: str
    name: str


class LayoutInfo(BaseModel):
    key: str
    name: str
    cols: int
    rows: int


class MetaResponse(BaseModel):
    styles: list[StyleInfo]
    filters: list[FilterInfo]
    frames: list[FrameInfo]
    layouts: list[LayoutInfo]


class JobInfo(BaseModel):
    job_id: str
    status: Literal["pending", "running", "done", "error"]
    current: int = 0
    total: int = 0
    msg: str = ""
    images: list[str] = Field(default_factory=list)
    layout_url: str | None = None
    vram_peak_gb: float = 0.0
    # 当前 images 属于哪个风格。换风格重跑会覆盖 job 状态里的 images,
    # 前端据此提示"这是新一版",而不是把上一版悄悄换掉。
    # 产物本身按 outputs/{job_id}/ai/{style}/ 分目录存放,互不覆盖。
    style: str | None = None
