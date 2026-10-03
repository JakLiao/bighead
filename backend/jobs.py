"""任务状态管理(内存).

内存约定:_jobs 是纯内存字典,只增不减。每来一次拍摄就 new_job()
一次,进程跑一整天会累积几千条 JobInfo(每条含 images 列表,
换风格重跑还会被 update 覆盖成更长的列表)。这里改成有界:
超过 _MAX_JOBS 就按「最久未更新」淘汰,给前端轮询留出时间窗即可
(轮询只发生在任务进行中的几十秒内)。
"""
from __future__ import annotations

import threading
import time
import uuid
from typing import Any

from .schemas import JobInfo

# 保留的已完成任务数。前端 gallery 走的是 outputs/ 目录扫描,
# 不依赖这个字典,所以淘汰老任务不会让历史记录消失。
_MAX_JOBS = 200
# 任务完成后的保护期:这段时间内不淘汰,保证前端能轮询到最终状态。
_TTL_SECONDS = 3600.0

_lock = threading.Lock()
_jobs: dict[str, JobInfo] = {}
_updated_at: dict[str, float] = {}


def _evict_locked(now: float) -> None:
    """按「最久未更新」淘汰,保护期内的任务不动。

    _MAX_JOBS 是软上限:若剩余条目都还在保护期内(例如刚跑完一批
    任务),允许暂时超过 —— 宁可多留几条元数据,也不能把前端正在
    轮询的任务状态删掉。保护期过后再次写入时会继续淘汰,所以长期
    不会无界增长。
    """
    if len(_jobs) <= _MAX_JOBS:
        return
    # 按更新时间升序 = 最老的在前
    for jid in sorted(_jobs, key=lambda k: _updated_at.get(k, 0.0)):
        if len(_jobs) <= _MAX_JOBS:
            break
        if now - _updated_at.get(jid, 0.0) < _TTL_SECONDS:
            # 排序保证后面的只会更新,连带保护,直接收工
            break
        _jobs.pop(jid, None)
        _updated_at.pop(jid, None)


def new_job() -> str:
    jid = uuid.uuid4().hex[:12]
    now = time.time()
    with _lock:
        _jobs[jid] = JobInfo(job_id=jid, status="pending")
        _updated_at[jid] = now
        _evict_locked(now)
    return jid


def get(job_id: str) -> JobInfo | None:
    with _lock:
        return _jobs.get(job_id)


def update(job_id: str, **kwargs: Any) -> None:
    with _lock:
        j = _jobs.get(job_id)
        if j is None:
            return
        for k, v in kwargs.items():
            if hasattr(j, k):
                setattr(j, k, v)
        _updated_at[job_id] = time.time()
