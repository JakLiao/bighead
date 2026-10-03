"""端到端验证后端: 直接调 generate_async, 走真实生产路径。

用法:
    BIGHEAD_AI_BACKEND=qwen  <webui python> scripts/verify_qwen_e2e.py
    BIGHEAD_AI_BACKEND=sdxl  <webui python> scripts/verify_qwen_e2e.py   # 回退验证

为什么不用 HTTP: /api/generate/start 只调 jobs.update() 而不调 new_job(),
所以纯 HTTP 调用(不经 WebSocket 建 job)会拿到 404 —— job 字典里根本没有这条。
那是既有行为(前端靠 WS 建 job), 与本次迁移无关, 所以这里绕过 HTTP 层,
直接调 generate_async —— 也就是 generate.py 里 _run() 调的那个函数,
链路(风格配置 -> generate_async -> 后端 -> 落盘 -> WS 广播)完全一致。
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import sys
import time
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))

from backend.config import AI_BACKEND, OUTPUT_DIR, STYLES  # noqa: E402


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )
    print(f"AI_BACKEND = {AI_BACKEND}")
    if AI_BACKEND not in ("qwen", "sdxl"):
        print("BIGHEAD_AI_BACKEND 必须是 qwen 或 sdxl")
        return 1

    src = OUTPUT_DIR / "1a0b12477d66"
    if not src.exists():
        print(f"缺少测试照片: {src}")
        return 1

    from backend.jobs import new_job
    # new_job() 自己生成 id 并注册 —— 这正是 /api/generate/start 里缺失的一步
    # (它只调 update(), 而 update() 对不存在的 job 是静默 no-op)。
    job_id = new_job()
    job_dir = OUTPUT_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    photos = sorted(src.glob("photo_*.jpg"))
    for p in photos:
        shutil.copy(p, job_dir / p.name)
    frame_paths = [str(job_dir / p.name) for p in photos]
    print(f"job_id={job_id}  {len(frame_paths)} 张照片  backend={AI_BACKEND}")

    from backend import ws
    from backend.pipeline import pipeline

    # WS 没有客户端, broadcast 要能安全失败
    async def fake_broadcast(job_id: str, msg: dict) -> None:
        extra = f" {msg.get('msg', '')}" if msg.get("msg") else ""
        print(f"    [ws] {msg.get('status')} {msg.get('current', '')}/{msg.get('total', '')}{extra}")

    ws.broadcast = fake_broadcast

    style_key = "PORTRAIT_HK"
    t0 = time.time()
    result = asyncio.run(
        pipeline.generate_async(
            job_id=job_id,
            frame_paths=frame_paths,
            style_key=style_key,
            style_cfg=STYLES[style_key],
            out_dir=job_dir / "ai" / style_key,
        )
    )
    dt = time.time() - t0

    print("\n" + "=" * 62)
    print(f"总耗时   : {dt:.1f}s / {len(result.image_paths)} 张 "
          f"= {dt / max(1, len(result.image_paths)):.1f}s/张")
    print(f"显存峰值 : {result.vram_peak_gb:.2f} GB")
    print("产物:")
    for p in result.image_paths:
        print(f"  {p}  ({Path(p).stat().st_size / 1024:.0f} KB)")
    print("=" * 62)

    ok = len(result.image_paths) == len(frame_paths) and result.vram_peak_gb > 0
    print("PASS" if ok else "FAIL")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
