"""画廊:扫描 outputs/,列出历次任务."""
from __future__ import annotations


from fastapi import APIRouter

from ..config import OUTPUT_DIR

router = APIRouter()


@router.get("/api/gallery")
def gallery():
    """扫描 outputs/ 列出历次任务。

    刻意用同步 def: 这里是纯同步磁盘 IO(遍历目录 + 每个 job 再 stat/glob),
    随历史任务累积会越来越慢, 跑在事件循环里会连带卡住 WS 进度推送。
    FastAPI 对普通 def 自动走线程池。
    """
    items: list[dict] = []
    if not OUTPUT_DIR.exists():
        return {"items": []}
    for job_dir in sorted(OUTPUT_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not job_dir.is_dir():
            continue
        # 跳过下划线开头的内部目录(如 _smoke / _verify)
        if job_dir.name.startswith("_") or job_dir.name.startswith("."):
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
