"""AI 写真生成:异步任务 + WS 进度."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Form, HTTPException

from ..config import OUTPUT_DIR, STYLES
from ..jobs import update
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
    # 产物按 job_id/style 分目录:换风格重跑时不能覆盖上一轮结果。
    # 早期实现固定写 outputs/{job_id}/ai/,用户换个风格再点一次,
    # 上一轮的图片就被覆盖了,而 job 状态里只剩最后一轮。
    out_dir = OUTPUT_DIR / job_id / "ai" / style
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
        images = [f"/outputs/{job_id}/ai/{style}/{Path(p).name}" for p in result.image_paths]
        update(
            job_id,
            status="done",
            style=style,
            current=len(result.image_paths),
            total=len(photo_paths),
            images=images,
            vram_peak_gb=round(result.vram_peak_gb, 2),
            layout_url=_build_layout(job_id, result.image_paths, style),
        )
    except Exception as e:
        await ws.broadcast(job_id, {"status": "error", "msg": str(e)})
        update(job_id, status="error", style=style, msg=str(e))


def _build_layout(job_id: str, image_paths: list[str], style: str) -> str | None:
    """把 AI 产出拼成一张大图, 返回可访问的 URL。

    真正实现在 pipeline._build_ai_layout —— 放在那里是因为 WS 的 done 广播
    也需要同一个 URL, 两处各拼一次会写出两份 layout.jpg 并互相覆盖
    (换风格重跑时尤其容易踩)。
    """
    from ..pipeline import build_ai_layout

    return build_ai_layout(image_paths, OUTPUT_DIR / job_id / "ai" / style)


@router.get("/api/jobs/{job_id}")
async def job_status(job_id: str):
    from ..jobs import get

    j = get(job_id)
    if j is None:
        raise HTTPException(404, "no such job")
    # pydantic v1 用 .dict(),v2 用 .model_dump()
    dump = getattr(j, "model_dump", None) or j.dict
    return dump()
