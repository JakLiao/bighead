"""FastAPI 入口."""
from __future__ import annotations

import logging
import os

# 关键:先导入 config,其中的环境设置(代理/HF 缓存/CUDA 缓存)必须在
# torch / diffusers / transformers 被加载之前生效
from .config import OUTPUT_DIR

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .routes import capture, gallery, generate, health, layout, preview, share, ws_jobs

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")

app = FastAPI(title="BigHead · 大头贴复古", version="0.1.0")

# 只放开明确的开发源。之前这里含 "*" 且同时 allow_credentials=True,
# Starlette 会原样回显请求的 Origin(规范下 "*" + credentials 组合本就无效),
# 等价于「任意网站可带凭据访问」—— 而 /outputs 挂载的是用户生成的照片,
# 且服务绑 0.0.0.0 暴露在局域网, 风险实际可达。需要放开时用环境变量追加。
_allowed = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
_extra = os.environ.get("BIGHEAD_EXTRA_ORIGINS", "").strip()
if _extra:
    _allowed.extend(o.strip() for o in _extra.split(",") if o.strip())

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed,
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
app.include_router(share.router)
app.include_router(ws_jobs.router)

# 静态目录(生成的图)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/outputs", StaticFiles(directory=str(OUTPUT_DIR)), name="outputs")


@app.on_event("startup")
async def _startup():
    import torch

    from .config import AI_BACKEND

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
    print(f"  AI backend: {AI_BACKEND}")
    print(f"  Output dir: {OUTPUT_DIR}")
    print("=" * 60)

    # 依赖自检: 用错解释器时服务仍能启动、连拍拼图也正常, 只有 AI 会炸,
    # 报错还发生在用户点「生成」之后(见 backend/preflight.py 的说明)。
    from .preflight import report as _preflight

    _preflight()

    if AI_BACKEND == "qwen":
        # Qwen 必须提前预热: 模型加载 75s + 首次 CUDA kernel 懒加载 145s
        # ≈ 3.5 分钟。不预热的话第一个用户请求要独吞这份开销, 表现为
        # "点了没反应"。这里放后台线程, 服务立即可用, 生成请求会等它完成。
        from .qwen_pipeline import qwen_pipeline

        qwen_pipeline.prewarm()
        print("  Qwen 后端后台预热中(约 3.5 分钟), 期间生成请求会自动等待...")
        print("=" * 60)


if __name__ == "__main__":
    import uvicorn

    # 必须与 .trae/rules/project_rules.md 一致: 127.0.0.1 而非 0.0.0.0(本服务
    # 无认证, 绑全网卡等于把用户人脸照片暴露给整个局域网), 8077 而非 8000(本机
    # 8000 常被其他服务占用)。命令行启动请直接用 uvicorn, 见 README。
    uvicorn.run("backend.app:app", host="127.0.0.1", port=8077, reload=False)
