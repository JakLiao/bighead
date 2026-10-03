"""从魔塔(ModelScope)下载 Qwen-Image-Edit-2511 量化版所需的模型文件。

为什么走魔塔而不是 HF:国内直连 HF 经常 timeout/503,魔塔是国内镜像,
速度稳定得多。三个文件在魔塔上都有对应仓库。

为什么选 Q4_K_M:17.1GB 的 5070 Ti 只有这个档位装得下又能留出余量给
文本编码器和 VAE。各档位实测体积(魔塔 API,2026-10):

    Q2_K      6.96 GB   质量明显不足
    Q3_K_M    9.24 GB   4-bit 以下锁脸不稳
    Q4_0     11.04 GB   ok
    Q4_K_M   12.34 GB   <- 选这个,16GB 卡的社区甜点位
    Q5_K_M   14.00 GB   余量太紧
    Q8_0     20.27 GB   放不下
    BF16     38.07 GB   放不下

注意:GGUF 仓库只有 transformer 权重,没有 config/VAE/文本编码器,
所以还要另外两个文件,以及官方仓库的 config(供 from_single_file 读结构)。

断点续传:用 requests 的 Range 头,中断后重跑会接着下,不会从头开始。
12.34GB 按国内 10MB/s 也要 20 分钟,断点续传不是可选项。

用法:
    python scripts/download_qwen.py              # 下载全部
    python scripts/download_qwen.py transformer  # 只下 transformer
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import requests

DEST = Path(r"E:\Code\stable-diffusion-webui\models\qwen")
TIMEOUT = 30
CHUNK = 1024 * 1024 * 8  # 8MB

# (子目录, 魔塔仓库, 仓库内路径, 期望字节数, 说明)
# transformer 用 unsloth 的 GGUF 量化版(12.34GB);官方 transformer 是
# 5 分片 BF16 共 38.05GB,17.1GB 卡放不下,不要下。
#
# text_encoder 官方仓库是 4 分片 BF16 共 15.45GB(实测),不是单文件 ——
# 魔塔对不存在的单文件路径返回 500,必须按分片逐个下。Comfy-Org 的
# fp8_scaled 编码器(约 9GB)没镜像到魔塔,只能先用 BF16 版,加载时再量化。
MS = "https://www.modelscope.cn/api/v1/models/{repo}/repo?Revision=master&FilePath={path}"
REPO = "Qwen/Qwen-Image-Edit-2511"

ITEMS = [
    (
        "transformer",
        "unsloth/Qwen-Image-Edit-2511-GGUF",
        "qwen-image-edit-2511-Q4_K_M.gguf",
        13_244_758_624,   # 魔塔 Content-Range 实测值
        "Q4_K_M 量化主模型(image-to-image 编辑主干)",
    ),
    (
        "vae",
        REPO,
        "vae/diffusion_pytorch_model.safetensors",
        None,
        "VAE,负责 latent <-> 图像解码",
    ),
    (
        "text_encoder",
        REPO,
        "text_encoder/model-00001-of-00004.safetensors",
        None,
        "Qwen2.5-VL-7B 文本/视觉编码器 分片 1/4",
    ),
    (
        "text_encoder",
        REPO,
        "text_encoder/model-00002-of-00004.safetensors",
        None,
        "Qwen2.5-VL-7B 文本/视觉编码器 分片 2/4",
    ),
    (
        "text_encoder",
        REPO,
        "text_encoder/model-00003-of-00004.safetensors",
        None,
        "Qwen2.5-VL-7B 文本/视觉编码器 分片 3/4",
    ),
    (
        "text_encoder",
        REPO,
        "text_encoder/model-00004-of-00004.safetensors",
        None,
        "Qwen2.5-VL-7B 文本/视觉编码器 分片 4/4",
    ),
    (
        "text_encoder",
        REPO,
        "text_encoder/config.json",
        None,
        "文本编码器 config",
    ),
    (
        "text_encoder",
        REPO,
        "text_encoder/model.safetensors.index.json",
        None,
        "文本编码器分片索引(from_pretrained 靠它拼分片)",
    ),
    (
        "vae",
        REPO,
        "vae/config.json",
        None,
        "VAE config",
    ),
    (
        "transformer",
        REPO,
        "transformer/config.json",
        None,
        "transformer config(from_single_file 需要它读结构)",
    ),
    # 以下是 Pipeline.from_pretrained 拼装必需的小文件,一个都不能缺:
    # model_index 告诉 diffusers 各组件在哪个子目录;tokenizer 负责把
    # prompt 分词;processor 是 Qwen2.5-VL 的图像预处理;scheduler 决定
    # 采样用的离散化方式。缺任何一个都会在加载时报 KeyError。
    ("meta", REPO, "model_index.json", None, "Pipeline 组件索引"),
    ("scheduler", REPO, "scheduler/scheduler_config.json", None, "调度器配置"),
    # tokenizer 目录:9 个文件全要。实测漏掉 video_preprocessor_config.json
    # 会让 transformers 5.18 的 Qwen2VLProcessor.from_pretrained 直接抛
    # "Unrecognized video processor" —— 它会去找 video 配置,没有就报错。
    # tokenizer.json(11.4MB)比 vocab+merges 完整,fast tokenizer 依赖它。
    ("tokenizer", REPO, "tokenizer/tokenizer_config.json", None, "tokenizer 配置"),
    ("tokenizer", REPO, "tokenizer/merges.txt", None, "BPE merges"),
    ("tokenizer", REPO, "tokenizer/vocab.json", None, "词表"),
    ("tokenizer", REPO, "tokenizer/tokenizer.json", None, "fast tokenizer 权重"),
    ("tokenizer", REPO, "tokenizer/added_tokens.json", None, "added tokens"),
    ("tokenizer", REPO, "tokenizer/special_tokens_map.json", None, "特殊 token 映射"),
    ("tokenizer", REPO, "tokenizer/chat_template.jinja", None, "对话模板"),
    ("processor", REPO, "processor/preprocessor_config.json", None, "图像预处理配置"),
    ("processor", REPO, "processor/tokenizer_config.json", None, "processor tokenizer 配置"),
    ("processor", REPO, "processor/merges.txt", None, "processor merges"),
    ("processor", REPO, "processor/vocab.json", None, "processor 词表"),
    ("processor", REPO, "processor/tokenizer.json", None, "processor fast tokenizer"),
    ("processor", REPO, "processor/added_tokens.json", None, "processor added tokens"),
    ("processor", REPO, "processor/special_tokens_map.json", None, "processor 特殊 token"),
    ("processor", REPO, "processor/chat_template.jinja", None, "processor 对话模板"),
    # transformers 5.x 加载 Qwen2VLProcessor 时强制要求 video 配置,
    # 即使我们只做图像编辑也必须有,否则报 Unrecognized video processor。
    ("processor", REPO, "processor/video_preprocessor_config.json", None,
     "video 预处理配置(transformers 5.x 必需,即使只做图像编辑)"),
]


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.2f} {unit}"
        n /= 1024
    return f"{n:.2f} TB"


def head_size(url: str) -> int | None:
    """拿真实文件大小。

    魔塔的下载端点 HEAD 会返回 200 但**不带 Content-Length**,而且
    不接受 HEAD —— 实测 HEAD 拿到的 CL 是 None,GET+Range 才有。
    所以这里用 `GET bytes=0-0` 探,靠 Content-Range 的 "/total" 取真值。
    顺带确认端点支持断点续传(返回 206)。
    """
    try:
        r = requests.get(url, headers={"Range": "bytes=0-0"},
                         allow_redirects=True, timeout=TIMEOUT, stream=True)
        cr = r.headers.get("Content-Range", "")
        r.close()
        if "/" in cr:
            return int(cr.rsplit("/", 1)[1])
    except Exception:
        pass
    return None


def download(url: str, dest: Path, expect: int | None) -> bool:
    """带断点续传的下载。返回 True 表示这次是完整下载的。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    total = head_size(url) or expect

    have = dest.stat().st_size if dest.exists() else 0
    if total and have == total:
        print(f"    已完整({human(total)}),跳过")
        return False
    if total is None and have > 0:
        # 拿不到远端大小时,靠内容判断是否已经下过。
        # config.json 这类小文件重复下载没有意义,直接从响应比对。
        r = requests.get(url, timeout=TIMEOUT)
        if r.status_code == 200 and len(r.content) == have:
            print(f"    已完整({human(have)}),跳过")
            return False
        have = 0
    if total and have > total:
        # 上次下坏了,重来
        print(f"    本地 {human(have)} > 远端 {human(total)},重新下载")
        dest.unlink()
        have = 0

    mode = "ab" if have else "wb"
    headers = {"Range": f"bytes={have}-"} if have else {}
    if total:
        print(f"    远端 {human(total)}"
              f"{'，从 ' + human(have) + ' 续传' if have else ''}")
    else:
        # config.json 之类的小文件没有 Content-Range,拿不到大小。
        # 这类文件通常几 KB,一次性读完就行,不做进度显示。
        print(f"    大小未知{'（从 ' + human(have) + ' 续传）' if have else ''}")

    last = time.time()
    last_bytes = have
    with requests.get(url, headers=headers, stream=True, timeout=TIMEOUT) as r:
        if r.status_code not in (200, 206):
            print(f"    HTTP {r.status_code} 下载失败")
            return False
        r.raise_for_status()
        with open(dest, mode) as f:
            for chunk in r.iter_content(CHUNK):
                if not chunk:
                    continue
                f.write(chunk)
                have += len(chunk)
                now = time.time()
                if now - last >= 5:
                    speed = (have - last_bytes) / (now - last)
                    pct = f"{have / total * 100:5.1f}%" if total else "  ?  "
                    # 注意速度是 bytes/s,直接 human() 会算成秒,单位错位
                    eta = (total - have) / speed if total and speed else 0
                    print(f"    {pct}  {human(have)}  "
                          f"{human(speed)}/s  剩余 "
                          f"{human(eta) if eta else '?'}",
                          flush=True)
                    last, last_bytes = now, have

    size = dest.stat().st_size
    if total and size != total:
        print(f"    尺寸不符: 本地 {human(size)} != 远端 {human(total)}")
        return False
    if not size:
        print("    写入 0 字节,可能是下载出错")
        return False
    print(f"    完成 {human(size)}")
    return True


def main() -> int:
    only = sys.argv[1] if len(sys.argv) > 1 else None
    DEST.mkdir(parents=True, exist_ok=True)
    print(f"目标目录: {DEST}\n")

    for sub, repo, path, expect, desc in ITEMS:
        if only and only != sub:
            continue
        print(f"[{sub}] {desc}")
        url = MS.format(repo=repo, path=path)
        dest = DEST / sub / os.path.basename(path)
        try:
            download(url, dest, expect)
        except Exception as e:
            print(f"    异常: {e}")
            return 1
        print()

    print("=" * 60)
    total = sum(f.stat().st_size for f in DEST.rglob("*") if f.is_file())
    print(f"合计 {human(total)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
