"""保存连拍原图到 outputs/{job_id}/photo_{i}.jpg."""
from __future__ import annotations

from fastapi import APIRouter, File, UploadFile

from ..config import OUTPUT_DIR, PHOTO_FILENAME
from ..jobs import new_job

router = APIRouter()


@router.post("/api/capture/save")
async def capture_save(images: list[UploadFile] = File(...)):
    job_id = new_job()
    job_dir = OUTPUT_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    saved: list[str] = []
    for i, up in enumerate(images[: 8]):
        data = await up.read()
        path = job_dir / PHOTO_FILENAME.format(idx=i + 1)
        path.write_bytes(data)
        saved.append(f"/outputs/{job_id}/{path.name}")
    return {"job_id": job_id, "photos": saved, "count": len(saved)}
