"""WebSocket 进度广播.

内存约定(这里是有意为之,不是遗漏):
- 订阅队列必须有界(maxsize)。早先用无界 asyncio.Queue(),
  只要有一个客户端连上却不消费(后台标签页被节流、网络抖动、
  页面崩溃没走 close),broadcast 每次 put_nowait 都会把消息
  永久堆在队列里 —— 40 条空闲连接 + 30 次广播就把进程
  commit 从 17.5GB 顶到 26.4GB。满了就丢最旧的一条:
  进度消息是「最新状态」语义,丢掉过期进度比堆积它们更有用。
- job_id 用完即删。dict 的 key 不会因为 value 变空而自动消失,
  早先只 remove 队列不 pop key,历史任务会在 _connections 里
  永久留下一条空 list。
"""
from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from typing import Any

# 单个订阅者最多缓存多少条进度消息。
# 生成一张图约广播 2 条(开始/结果),32 条足够覆盖一次多图任务的抖动,
# 又能让断连客户端的滞留量限制在 32 × 一条 JSON 的大小。
_QUEUE_MAXSIZE = 32

_connections: dict[str, list[asyncio.Queue]] = defaultdict(list)


def _drop_key_if_empty(job_id: str) -> None:
    """最后一个订阅者离开后删掉 key,否则空 list 会永久驻留。"""
    if not _connections.get(job_id):
        _connections.pop(job_id, None)


async def subscribe(job_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
    _connections[job_id].append(q)
    return q


def snapshot_message(job_id: str) -> str | None:
    """把任务当前状态序列化成一条 WS 消息,任务不存在时返回 None。

    这是修「AI 生成永远 0/0」的关键。前端 doLayout 里
    setCurrentJobId() 触发的 WS 连接是异步的,而 startGeneration()
    紧跟着就返回,后端立刻开始生成并 broadcast —— WS 还没 accept 完,
    _connections 里还没有订阅者,进度消息被全部丢弃:
    running 收不到 -> 停在 0/0;done 也收不到 -> setBusy(false)
    永不执行 -> 按钮一直转。

    进度是「最新状态」语义,所以订阅时补发一次当前快照即可:
    无论客户端什么时候连上,都能立刻拿到终态,不必依赖不丢失的广播。
    """
    from .jobs import get  # 局部导入避免 ws <-> jobs 循环依赖

    job = get(job_id)
    if job is None:
        return None
    dump = getattr(job, "model_dump", None) or job.dict
    return json.dumps(dump(), ensure_ascii=False)


async def unsubscribe(job_id: str, q: asyncio.Queue) -> None:
    if q in _connections.get(job_id, []):
        _connections[job_id].remove(q)
    _drop_key_if_empty(job_id)


async def broadcast(job_id: str, payload: dict[str, Any]) -> None:
    msg = json.dumps(payload, ensure_ascii=False)
    for q in list(_connections.get(job_id, [])):
        if q.full():
            # 丢掉最旧的一条给新消息腾位置。进度是「最新状态」,
            # 消费者只关心最后一次广播,过期消息没有保留价值。
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:  # pragma: no cover - 并发竞态
                pass
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:  # pragma: no cover - 并发竞态
            pass
