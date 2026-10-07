"""分享卡落盘."""
from __future__ import annotations

import io

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from PIL import Image

from ..config import SHARE_FILENAME
from .layout import _resolve_job_id_or_404

router = APIRouter()

# 与 capture.MAX_BYTES 同量级: 分享卡是 1200x900 的 JPEG, 实测 300KB 上下,
# 16MB 的上限足够宽松, 同时挡住「声明 image/jpeg 实际是 2GB 垃圾」把进程
# 内存打爆的情况。
MAX_BYTES = 16 * 1024 * 1024


@router.post("/api/share/save")
def share_save(
    job_id: str = Form(...),
    layout: UploadFile = File(...),
):
    """把分享卡字节落盘到 outputs/{job_id}/share.jpg。

    刻意**不接收原始拼图**而接收前端合成好的卡片字节: 服务端的
    share_card.render_share_card 只在「补生成历史卡片」这类没有前端上下文的
    场景才需要(见 share_card 模块 docstring)。正常出片路径上, 前端已经持有
    collage blob 与 job_id, 在本地 canvas 合成一张卡片是零往返; 让浏览器把
    拼图传回服务端、服务端再合成一次, 是纯粹的双向往返。

    字段名叫 layout 而不是 card, 是为了与 /api/layout/make 的 FormData 形状
    保持一致(都只传「一张图」), 代价是名字读起来别扭。
    """
    job_dir = _resolve_job_id_or_404(job_id)

    data = layout.file.read()
    if not data:
        raise HTTPException(400, "空文件")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, f"分享卡超过 {MAX_BYTES // 1024 // 1024}MB 限制")

    # content-type 由客户端声明, 不能作为唯一依据(见 capture._check_image
    # 的同一段说明), 所以还要用 Pillow 实际解码一次。
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.verify()
    except Exception as e:
        raise HTTPException(400, f"不是可解码的图片: {type(e).__name__}")

    out = job_dir / SHARE_FILENAME
    out.write_bytes(data)
    return {"job_id": job_id, "share_url": f"/outputs/{job_id}/{SHARE_FILENAME}"}
