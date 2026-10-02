"""FastAPI 入口."""
from __future__ import annotations

import logging

# 关键:先导入 config,其中的环境设置(代理/HF 缓存/CUDA 缓存)必须在
# torch / diffusers / transformers 被加载之前生效
from .config import OUTPUT_DIR

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .routes import capture, gallery, generate, health, layout, preview, ws_jobs

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")

app = FastAPI(title="BigHead · 大头贴复古", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(preview.router)
app.include_router(capture.router)
app.include_router(layout.router)
app.include_router(generate.router)
app.include_router(gallery.router)
app.include_router(ws_jobs.router)

# 静态目录(生成的图)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/outputs", StaticFiles(directory=str(OUTPUT_DIR)), name="outputs")


@app.on_event("startup")
async def _startup():
    import torch

    print("=" * 60)
    print("  BigHead · 大头贴复古  v0.1.0")
    print("=" * 60)
    if torch.cuda.is_available():
        free, total = torch.cuda.mem_get_info()
        print(f"  GPU: {torch.cuda.get_device_name(0)}")
        print(f"  VRAM: {free/1e9:.1f}GB free / {total/1e9:.1f}GB total")
        print(f"  Compute Capability: {torch.cuda.get_device_capability(0)}")
    else:
        print("  WARNING: CUDA not available, AI will not work")
    print(f"  Output dir: {OUTPUT_DIR}")
    print("=" * 60)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("backend.app:app", host="0.0.0.0", port=8000, reload=False)
