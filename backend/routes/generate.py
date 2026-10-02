"""AI 写真生成:异步任务 + WS 进度."""
from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Form, HTTPException

from ..config import OUTPUT_DIR, STYLES
from ..jobs import new_job, update
from ..pipeline import pipeline
from .. import ws

router = APIRouter()


@router.post("/api/generate/start")
async def generate_start(
    background: BackgroundTasks,
    job_id: str = Form(...),
    style: str = Form("PORTRAIT_HK"),
    steps: int | None = Form(None),
):
    if style not in STYLES:
        raise HTTPException(400, f"unknown style: {style}")

    job_dir = OUTPUT_DIR / job_id
    photo_dir = job_dir / "photos"
    if not photo_dir.exists():
        raise HTTPException(400, f"no captures for job {job_id}")

    photo_paths = sorted(p for p in photo_dir.glob("photo_*.jpg"))
    if not photo_paths:
        raise HTTPException(400, "no photos")

    update(job_id, status="running", total=len(photo_paths), current=0)
    background.add_task(_run, job_id, photo_paths, style, steps)
    return {"job_id": job_id, "total": len(photo_paths)}


async def _run(job_id: str, photo_paths: list[Path], style: str, steps: int | None):
    from PIL import Image

    style_cfg = STYLES[style]
    out_dir = OUTPUT_DIR / job_id / "ai"
    try:
        # 把 photo 复制/链接到 outputs/{job}/photos 路径(已在 photo_dir)
        await pipeline.generate_async(
            job_id=job_id,
            frame_paths=[str(p) for p in photo_paths],
            style_key=style,
            style_cfg=style_cfg,
            out_dir=out_dir,
            steps=steps,
        )
        update(job_id, status="done")
    except Exception as e:
        await ws.broadcast(job_id, {"status": "error", "msg": str(e)})
        update(job_id, status="error", msg=str(e))


@router.get("/api/jobs/{job_id}")
async def job_status(job_id: str):
    from ..jobs import get

    j = get(job_id)
    if j is None:
        raise HTTPException(404, "no such job")
    # pydantic v1 用 .dict(),v2 用 .model_dump()
    dump = getattr(j, "model_dump", None) or j.dict
    return dump()
