"""WebSocket 进度广播."""
from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from typing import Any

_connections: dict[str, list[asyncio.Queue]] = defaultdict(list)


async def subscribe(job_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    _connections[job_id].append(q)
    return q


async def unsubscribe(job_id: str, q: asyncio.Queue) -> None:
    if q in _connections.get(job_id, []):
        _connections[job_id].remove(q)


async def broadcast(job_id: str, payload: dict[str, Any]) -> None:
    msg = json.dumps(payload, ensure_ascii=False)
    for q in list(_connections.get(job_id, [])):
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            pass
