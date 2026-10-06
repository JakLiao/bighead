"""拼图排版:接收 N 张图(layout 字符串),返回拼好的 PNG/JPG."""
from __future__ import annotations

import io
import os
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Response
from PIL import Image

from ..config import LAYOUTS

router = APIRouter()


@router.post("/api/layout/make")
def layout_make(
    images: list[bytes] = File(...),
    layout: str = Form("2x2"),
    frame: str = Form("plain_white"),
    job_id: str | None = Form(None),
):
    """拼图排版。job_id 给了就顺便落盘到该 job 目录顶层。

    刻意用同步 def: 解码 N 张图 + 拼接 + JPEG 编码是 CPU 密集操作,
    在事件循环里执行会阻塞同 worker 上的所有请求(含 WebSocket 进度推送)。
    FastAPI 对普通 def 自动走线程池。参见 preview.preview_filter 的说明。

    job_id 可选: 不给时行为与改动前完全一致(纯返回字节)。这一条很重要
    —— AI 路径的客户端拼图兜底(DecoratePage.layoutFromAiImages 里的
    makeLayout 调用)不传 job_id, 它拿到的 AI 成片已经在 outputs 下了,
    再落一份是重复写盘。

    落盘用 LAYOUT_FILENAME 常量而不是字面量: 原先 config.py 定义了这个
    常量却没人用, build_ai_layout 与 gallery 各写各的字符串。再硬编码第四
    处只会让下次改名漏改更多地方。
    """
    if layout not in LAYOUTS:
        raise HTTPException(400, f"unknown layout: {layout}")
    try:
        pils = [Image.open(io.BytesIO(b)) for b in images]
    except Exception as e:
        raise HTTPException(400, f"invalid image bytes: {e}")

    # 动态导入避免循环
    from ..layouts import collage_to_bytes

    data = collage_to_bytes(pils, layout=layout, frame=frame, fmt="JPEG")

    if job_id:
        # 复用 gallery._resolve_job_dir 而不是自己拼路径: 那个函数同时做了
        # 正则校验与 resolve() 后的越界检查。job_id 来自 HTTP 表单, 是用户
        # 可控输入 —— (OUTPUT_DIR / job_id).resolve() 在 job_id 为 "../.."
        # 时会逃出 outputs 目录。复制一份路径拼接等于复制一份漏洞。
        job_dir = _resolve_job_id_or_404(job_id)
        from ..config import LAYOUT_FILENAME

        # 写临时文件再 os.replace, 而不是直接 write_bytes。
        #
        # 顶层 layout.jpg 可能是 ai/{style}/layout.jpg 的**硬链接**
        # (见 pipeline._mirror_layout_to_top)。硬链接是一个 inode 两个名字,
        # 而 write_bytes 是 open(O_TRUNC) —— 直接写会把**两个名字一起截断**,
        # 连带把 AI 拼图的内容也清掉。同一 job 先跑 AI 写真再补一次普通拼图
        # 就会踩到, 且 gallery 缩略图仍指向顶层, 表面看不出异常。
        #
        # os.replace 是 rename 语义: 新数据写进独立 inode, 再原子换名。
        # 换名只动顶层那个名字, 硬链接指向的 AI 拼图分毫不动。
        # 临时文件与目标同目录, 保证 replace 不跨卷(跨卷会失败)。
        target = job_dir / LAYOUT_FILENAME
        tmp = job_dir / f".{LAYOUT_FILENAME}.tmp"
        tmp.write_bytes(data)
        os.replace(tmp, target)

    return Response(content=data, media_type="image/jpeg")


def _resolve_job_id_or_404(job_id: str) -> Path:
    """校验 job_id 并确认目录存在, 返回 Path。

    与 gallery._resolve_job_dir 分开是因为那个函数只校验不检查存在性
    (PATCH/DELETE 各自查存在性), 而落盘必须两者都做 —— 直接 write_bytes
    到不存在的目录会 FileNotFoundError, 变成 500 而不是可读的 404。
    """
    from .gallery import _resolve_job_dir

    job_dir = _resolve_job_dir(job_id)
    if not job_dir.is_dir():
        raise HTTPException(404, f"job {job_id} 不存在")
    return job_dir
