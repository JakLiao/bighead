"""WebSocket 进度路由."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .. import ws as wsmod

router = APIRouter()


@router.websocket("/ws/jobs/{job_id}")
async def job_ws(websocket: WebSocket, job_id: str):
    await websocket.accept()
    q = await wsmod.subscribe(job_id)
    try:
        while True:
            try:
                msg = await asyncio.wait_for(q.get(), timeout=15)
                await websocket.send_text(msg)
            except asyncio.TimeoutError:
                # 心跳
                await websocket.send_text('{"status":"heartbeat"}')
    except WebSocketDisconnect:
        pass
    finally:
        await wsmod.unsubscribe(job_id, q)
