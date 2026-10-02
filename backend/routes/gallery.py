"""画廊:扫描 outputs/,列出历次任务."""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter

from ..config import OUTPUT_DIR

router = APIRouter()


@router.get("/api/gallery")
async def gallery():
    items: list[dict] = []
    if not OUTPUT_DIR.exists():
        return {"items": []}
    for job_dir in sorted(OUTPUT_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not job_dir.is_dir():
            continue
        thumbs: list[str] = []
        layout = job_dir / "layout.jpg"
        if layout.exists():
            thumbs.append(f"/outputs/{job_dir.name}/layout.jpg")
        else:
            for f in sorted(job_dir.glob("photo_*.jpg"))[: 4]:
                thumbs.append(f"/outputs/{job_dir.name}/{f.name}")
        items.append({
            "job_id": job_dir.name,
            "mtime": int(job_dir.stat().st_mtime),
            "thumbs": thumbs,
        })
    return {"items": items}
