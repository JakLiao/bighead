"""WebSocket 进度路由."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .. import ws as wsmod

router = APIRouter()

# 任务结束(收到终态)后仍保持连接一段时间,让前端能收到最后一条消息,
# 超时则由服务端主动断开。没有这个上限的话,每个订阅者都会永远
# 停在下面的 while 循环里,靠 15s 心跳互相吊着 —— 客户端崩溃 /
# 断网时 send_text 未必立刻抛错,连接会一直占着一条队列不放。
_IDLE_CLOSE_SECONDS = 600


def _is_terminal(status: str) -> bool:
    return status in ("done", "error")


@router.websocket("/ws/jobs/{job_id}")
async def job_ws(websocket: WebSocket, job_id: str):
    await websocket.accept()
    q = await wsmod.subscribe(job_id)
    terminal_at: float | None = None
    try:
        while True:
            # 终态后再挂 _IDLE_CLOSE_SECONDS 就主动收尾,
            # 不让订阅无限期占用一条队列。
            if terminal_at is not None:
                left = _IDLE_CLOSE_SECONDS - (asyncio.get_event_loop().time() - terminal_at)
                if left <= 0:
                    break
                timeout = min(15.0, left)
            else:
                timeout = 15.0

            try:
                msg = await asyncio.wait_for(q.get(), timeout=timeout)
            except asyncio.TimeoutError:
                if terminal_at is not None:
                    break  # 终态后的空闲期已走完
                await websocket.send_text('{"status":"heartbeat"}')
                continue

            if msg == "":
                break
            await websocket.send_text(msg)
            try:
                import json as _json

                if _is_terminal(_json.loads(msg).get("status", "")):
                    terminal_at = asyncio.get_event_loop().time()
            except Exception:
                pass
    except WebSocketDisconnect:
        pass
    except (RuntimeError, ConnectionError):
        # 对端已断开但 send 未抛 WebSocketDisconnect 的情况
        pass
    finally:
        await wsmod.unsubscribe(job_id, q)
