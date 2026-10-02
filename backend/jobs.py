"""任务状态管理(内存)."""
from __future__ import annotations

import threading
import uuid
from typing import Any

from .schemas import JobInfo

_lock = threading.Lock()
_jobs: dict[str, JobInfo] = {}


def new_job() -> str:
    jid = uuid.uuid4().hex[:12]
    with _lock:
        _jobs[jid] = JobInfo(job_id=jid, status="pending")
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
