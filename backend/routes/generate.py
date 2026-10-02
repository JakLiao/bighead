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
    # 与 capture.py 的落盘布局保持一致:outputs/{job_id}/photo_{i}.jpg
    if not job_dir.exists():
        raise HTTPException(400, f"no captures for job {job_id}")

    photo_paths = sorted(job_dir.glob("photo_*.jpg"))
    if not photo_paths:
        raise HTTPException(400, f"no photos for job {job_id}")

    update(job_id, status="running", total=len(photo_paths), current=0)
    background.add_task(_run, job_id, photo_paths, style, steps)
    return {"job_id": job_id, "total": len(photo_paths)}


async def _run(job_id: str, photo_paths: list[Path], style: str, steps: int | None):
    style_cfg = STYLES[style]
    out_dir = OUTPUT_DIR / job_id / "ai"
    try:
        result = await pipeline.generate_async(
            job_id=job_id,
            frame_paths=[str(p) for p in photo_paths],
            style_key=style,
            style_cfg=style_cfg,
            out_dir=out_dir,
            steps=steps,
        )
        # 把产物与显存峰值写回任务状态,前端轮询 /api/jobs/{id} 才能拿到结果
        update(
            job_id,
            status="done",
            current=len(result.image_paths),
            total=len(photo_paths),
            images=[f"/outputs/{job_id}/ai/{Path(p).name}" for p in result.image_paths],
            vram_peak_gb=round(result.vram_peak_gb, 2),
        )
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
