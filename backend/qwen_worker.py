"""Qwen-Image-Edit 常驻推理进程(跑在 .venv-qwen 解释器里)。

为什么必须是独立进程
--------------------
Qwen 链路要求 diffusers>=0.40 + transformers>=5.18, 而主服务跑在
webui 的 .venv 里(diffusers 0.34.0 / transformers 4.37.2)。这两个版本
区间在 huggingface-hub 上不相交(diffusers 0.40 要 >=1.23,<2;而
transformers 4.37~4.57 全都要 <1.0), **无法共存于同一进程**。
所以这里是一个独立解释器 + stdin/stdout 协议的常驻进程:
模型只加载一次, 之后每张图只走管道通信(几十毫秒), 不重复付 16 秒加载成本。

协议(每行一条 JSON, 双向)
--------------------------
    -> {"ok": true, "event": "boot"}                     主动推送, 无 rid
    <- {"op": "warmup", "rid": "ab12cd34"}
    -> {"ok": true, "event": "ready", "rid": "ab12cd34"}
    <- {"op": "gen", "rid": "...", "img": "...", "prompt": "...", "out": "...",
        "steps": 4, "cfg": 1.0, "w": 512, "h": 768, "seed": 123}
    -> {"ok": true, "event": "done", "rid": "...", "seconds": 26.0, "peak_gb": 14.6}
    -> {"ok": false, "rid": "...", "error": "..."}      出错时

**rid 是必须的, 不能靠 event 名区分主动推送与回包。**
父进程要同时处理两类行: worker 主动推的 boot, 以及对某次请求的应答。
如果只按 event 名判断, 就无法区分「worker 刚就绪, 这是通知」和
「worker 回答了我的 warmup 请求」—— 而这两者对父进程的意义完全不同。
带 rid 的行 = 某个请求的应答, 必须交给等待方; 不带 rid 的行 = 主动
推送, 只更新状态。混淆这两者会导致父进程跳过应答、然后一直 readline
读到阻塞。

启动方式(由 qwen_pipeline 自动拉起, 不要手工跑):
    .venv-qwen\\Scripts\\python.exe backend\\qwen_worker.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path

# 必须在 import torch 之前设好, 否则 HF 会往用户 AppData 写缓存
_PROJECT = Path(__file__).resolve().parent.parent
_HF = _PROJECT / "backend" / "vendor" / "hf_cache"
_HF.mkdir(parents=True, exist_ok=True)
os.environ["HF_HOME"] = str(_HF)
os.environ.setdefault("CUDA_CACHE_PATH", str(_PROJECT / ".cuda_cache"))
for _k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ[_k] = ""

# 进度条/日志一律不能碰 stdout —— 那是给父进程的 JSON 协议通道。
# diffusers 与 transformers 加载时会往 stdout 打进度条, 必须在 import 它们
# 之前就把 sys.stdout 换成 stderr, 否则父进程会把 "[1/729]..." 当协议行读走。
# BIGHEAD_QWEN_AS_LIBRARY=1 时不重定向(供诊断脚本 import 本模块时正常打印)。
#
# 关键: stdout 的**裸文件描述符**要在 import torch 之前取出来。
# os.fdopen(..., buffering=0) 直接落到内核管道缓冲, 不经过 sys.stdout 的行
# 缓冲, 这样即使有 C 扩展绕过 Python 层直接写 fd 1, 也不会和协议交错。
_PROTOCOL_FD = os.fdopen(os.dup(1), "wb", buffering=0)
if not os.environ.get("BIGHEAD_QWEN_AS_LIBRARY"):
    sys.stdout = sys.stderr

import torch  # noqa: E402
from PIL import Image  # noqa: E402

MODEL_BASE = Path(r"E:\Code\stable-diffusion-webui\models")
QWEN = MODEL_BASE / "qwen"
# 量化档: Q3_K_M。Q4_K_M 实测峰值 16.81G 已超过物理显存 15.89G,
# 再挂 720 个 LoRA 层必然溢出 -> WDDM 换页 -> 647s/张;
# Q3 把峰值压到 14.61G, 同样挂 LoRA 26.0s/张, 身份余弦只掉 0.0115。
TRANSFORMER = QWEN / "transformer" / "qwen-image-edit-2511-Q3_K_M.gguf"
LORA_KOHYA = QWEN / "lora" / "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"
CACHE = _PROJECT / "outputs" / "_cache" / "qwen_lightning4_peft.safetensors"
CACHE.parent.mkdir(parents=True, exist_ok=True)

_pipe = None
_lora_n = 0


def send(obj: dict) -> None:
    """一行 JSON 写回父进程 —— 走裸 fd, 不经过任何 Python 缓冲层。

    为什么不能用 sys.stdout.write / print:
    1. print 会经过 sys.stdout 的行缓冲, 而我们又把 sys.stdout 重定向到了
       stderr 做日志, 于是协议与日志共用同一个缓冲, 第三方库(tqdm 进度条、
       transformers 的 "Loading weights")随时会插进协议流里。
    2. 即使重定向, 仍持有原始 fd 的 C 扩展可以直接写 fd 1, 与 Python 层
       缓冲交错, 父进程 json.loads 就会失败。

    os.write 是唯一可靠的: 直接落到内核管道缓冲区, 无缓冲、无交错。
    一行 JSON 通常 < 1KB, 远小于 Windows 匿名管道的 4KB 缓冲, 所以单次
    write 就是原子的, 不会截断。
    """
    data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
    _PROTOCOL_FD.write(data)


def reply(req: dict, obj: dict) -> dict:
    """给某个请求的回包打上 rid, 父进程据此把它交给正确的等待方。"""
    obj["rid"] = req.get("rid")
    send(obj)
    return obj


def log(msg: str) -> None:
    """日志走 stderr(见上方 stdout 重定向的说明)。"""
    sys.stderr.write(f"[qwen_worker] {msg}\n")
    sys.stderr.flush()


def convert_lora(src: Path, dst: Path) -> None:
    """Kohya 命名 -> PEFT 命名。

    lightx2v 的 Lightning LoRA 用的是 Kohya/A1111 命名:
        <block>.attn.add_k_proj.lora_down.weight  [rank, in]
        <block>.attn.add_k_proj.lora_up.weight    [out, rank]
        <block>.attn.add_k_proj.alpha             [scalar]
    而 diffusers 只认 PEFT 的 lora_A / lora_B, 且它只在 first_key 含
    "lora_A" 时才认为已经是 PEFT 格式, 否则走 convert_unet_state_dict_to_peft
    —— 那是 UNet 专用的转换器, 对 Qwen 的 MMDiT 不适用。

    方向不能反: Kohya 的 delta 是 (up @ down) * (alpha/rank),
    PEFT 的增量是 B @ A * scaling, 所以 up -> B, down -> A。
    scale 直接乘进 lora_B, 等价于把 scaling 设成 alpha/rank。
    """
    from safetensors.torch import load_file, save_file

    sd = load_file(str(src))
    out: dict = {}
    n = 0
    for k in list(sd.keys()):
        if ".lora_down." not in k:
            continue
        prefix, _, tail = k.partition(".lora_down.")
        b = sd.get(f"{prefix}.lora_up.{tail}")
        if b is None:
            continue
        a = sd[k]
        alpha = sd.get(f"{prefix}.alpha")
        scale = float(alpha) / a.shape[0] if alpha is not None else 1.0
        out[f"{prefix}.lora_B.weight"] = (b.float() * scale).to(torch.bfloat16)
        out[f"{prefix}.lora_A.weight"] = a.to(torch.bfloat16)
        n += 1
    save_file(out, str(dst))
    log(f"LoRA 转换 {n} 对 -> {dst.name}")


def load_pipeline() -> None:
    """加载 pipeline + 挂 Lightning LoRA + 装显存编排 hook。"""
    global _pipe, _lora_n

    from diffusers import (
        AutoencoderKLQwenImage,
        FlowMatchEulerDiscreteScheduler,
        GGUFQuantizationConfig,
        QwenImageEditPlusPipeline,
        QwenImageTransformer2DModel,
    )
    from transformers import (
        BitsAndBytesConfig,
        Qwen2VLProcessor,
        Qwen2_5_VLForConditionalGeneration,
    )

    if not TRANSFORMER.exists():
        raise FileNotFoundError(f"transformer not found: {TRANSFORMER}")

    log("加载 transformer ...")
    transformer = QwenImageTransformer2DModel.from_single_file(
        str(TRANSFORMER),
        quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
        dtype=torch.bfloat16,
        config=str(QWEN / "transformer"), subfolder="transformer",
        local_files_only=True,
    )
    vae = AutoencoderKLQwenImage.from_pretrained(
        QWEN / "vae", torch_dtype=torch.bfloat16, local_files_only=True)
    # text_encoder 必须量化: BF16 16.58GB + transformer 9.24GB 远超 15.89GB 物理显存
    te = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        QWEN / "text_encoder", torch_dtype=torch.bfloat16,
        quantization_config=BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True),
        device_map="cpu", local_files_only=True)
    proc = Qwen2VLProcessor.from_pretrained(QWEN / "processor", local_files_only=True)
    sched = FlowMatchEulerDiscreteScheduler.from_pretrained(
        QWEN / "scheduler", local_files_only=True)

    pipe = QwenImageEditPlusPipeline(
        scheduler=sched, vae=vae, text_encoder=te,
        tokenizer=proc.tokenizer, processor=proc, transformer=transformer,
    )
    pipe.set_progress_bar_config(disable=True)
    pipe.to("cpu")

    # ---- Lightning 4 步 LoRA ----
    # 关掉会退化成 8x 步数 + 无引导 = 几乎不改图(实测: 4步CFG1 不挂 LoRA
    # 输出几乎是原图)。所以这里挂了必须验证层数, 不能只看没抛异常。
    _lora_n = 0
    if LORA_KOHYA.exists():
        if not CACHE.exists():
            convert_lora(LORA_KOHYA, CACHE)
        # prefix=None 必须显式传: diffusers peft.py:195 会按默认的
        # "transformer." 前缀 removeprefix 过滤 key, 而 lightx2v 的 key 是
        # transformer_blocks.*(本来就是模型里的真实 module 名), 一过滤就全空
        # —— 而 diffusers 只 warning 不报错, 会**静默挂不上**。
        pipe.transformer.load_lora_adapter(
            str(CACHE), adapter_name="l4", prefix=None)
        from peft.tuners.tuners_utils import BaseTunerLayer
        _lora_n = sum(1 for m in pipe.transformer.modules()
                      if isinstance(m, BaseTunerLayer))
        log(f"LoRA 层数 = {_lora_n}")
        if _lora_n == 0:
            log("!! LoRA 没挂上, 画质将严重退化")
    else:
        log(f"LoRA 不存在, 跳过: {LORA_KOHYA}")

    # ---- 显存编排 ----
    # 不用 enable_model_cpu_offload: 它虽是组件级, 但 Module.to() 逐参数搬运,
    # transformer 有约 1935 个参数, 而 pipeline 每步要调它两次(cond+uncond)
    # -> 每步约 49GB 非锁页 PCIe, 单步十几秒。
    # 这里改成: text_encoder 用完即撤, transformer 上卡后整段去噪都不搬。
    te_m, tf_m, vae_m = pipe.text_encoder, pipe.transformer, pipe.vae
    st = {"tf_on_gpu": False}
    vae_m.to("cuda")

    def te_pre(m, args, kwargs):
        if st["tf_on_gpu"]:
            tf_m.to("cpu")
            torch.cuda.empty_cache()
            st["tf_on_gpu"] = False
        m.to("cuda")

    def te_post(m, args, out):
        m.to("cpu")
        torch.cuda.empty_cache()

    def tf_pre(m, args, kwargs):
        if not st["tf_on_gpu"]:
            m.to("cuda")
            st["tf_on_gpu"] = True

    te_m.register_forward_pre_hook(te_pre, with_kwargs=True)
    te_m.register_forward_hook(te_post)
    tf_m.register_forward_pre_hook(tf_pre, with_kwargs=True)

    _pipe = pipe
    log("pipeline 就绪")


def warmup() -> None:
    """跑一次 1 步推理, 把 CUDA kernel 懒加载与显存分配一次性吃掉。

    为什么必须做(实测, 不是猜测):
        加载模型         75.5s
        首次推理        144.5s   <-- 这里!
        稳态推理(每张)   27~28s
    首次那 144s 几乎全是 CUDA kernel 的按需编译/加载(cuDNN/cuBLAS/attention
    后端在第一次用到某形状时才编译)。如果不预热, 用户的**第一张图**就要
    等 2 分半钟, 之后每张 27s —— 体验上就是"卡死了"。

    稳态的 encode_prompt 只要 1.5~2.0s, 26s+ 的那一次同样是懒加载。
    """
    pipe = _pipe
    # 用与真实请求同尺寸的输入: Qwen 的视觉编码器按图面积分配 token,
    # 不同尺寸走的是不同 kernel/显存布局, 预热必须覆盖真实形状。
    src = Image.new("RGB", (512, 768), (128, 128, 128))
    t0 = time.time()
    with torch.inference_mode():
        pipe(
            prompt="warmup", image=src,
            num_inference_steps=1, true_cfg_scale=1.0,
            generator=torch.Generator("cpu").manual_seed(0),
        )
    log(f"预热完成 {time.time() - t0:.1f}s(稳态每张约 27s)")


def _fit_exact(img, w: int, h: int, crop_box=None):
    """把图放进 w x h 的画布, **严格等比**, 既不拉伸也不丢内容。

    这里踩过一个很严重的坑。之前的实现是「裁切完直接
    img.resize((w, h))」, 隐含假设「裁切框比例 == 目标比例」。但
    face_aware_crop_box 的「情况 B」(人脸横向铺太开、装不进目标比例)
    恰恰会返回一个**比例不同**的框, 于是 resize 就把图非等比拉扁:

        实测 1280x720 合照 -> 裁切框 960x596 (1.61) -> 目标 512x768 (0.667)
        横向缩放 0.533, 纵向缩放 1.289 -> **纵横失真 2.42 倍**

    后果是人脸被垂直拉长、鼻子拉扁, 而模型是拿这张畸变图去编辑的 ——
    输出里「不像本人」主要就是被这个形变害的, 与 prompt 关系不大。
    (靠肉眼很难发现, 因为模型会顺着畸变脸去生成一张同样畸变的脸。)

    现在的做法: **等比缩放到能放进画布, 不足处留边而不是拉伸**。
    留边比裁掉更好 —— 裁掉会切到人脸, 留边只是损失画面上下部分,
    而大头贴场景本来就会在输出里重绘背景, 留边几乎无损失。
    留白区域用原图模糊后的版本填充(而非纯黑/纯白), 避免引入生硬色块
    引导模型重绘出假物体。
    """
    iw, ih = img.size
    if (iw, ih) == (w, h):
        return img

    # 1) 裁切: 优先用父进程给的人脸感知框, 否则退回居中裁到目标比例
    if crop_box:
        x1, y1, x2, y2 = (int(v) for v in crop_box)
        x1 = max(0, min(x1, iw - 1))
        y1 = max(0, min(y1, ih - 1))
        x2 = max(x1 + 1, min(x2, iw))
        y2 = max(y1 + 1, min(y2, ih))
        img = img.crop((x1, y1, x2, y2))
    else:
        target_ratio = w / h
        src_ratio = iw / ih
        if src_ratio > target_ratio:
            new_w = int(round(ih * target_ratio))
            left = (iw - new_w) // 2
            img = img.crop((left, 0, left + new_w, ih))
        else:
            new_h = int(round(iw / target_ratio))
            top = (ih - new_h) // 2
            img = img.crop((0, top, iw, top + new_h))

    # 2) 等比缩放到「完整放进 w x h」, 绝不做非等比 resize
    sw, sh = img.size
    scale = min(w / sw, h / sh)
    nw = max(1, min(w, int(round(sw * scale))))
    nh = max(1, min(h, int(round(sh * scale))))
    img = img.resize((nw, nh), Image.LANCZOS)

    if (nw, nh) == (w, h):
        return img

    # 3) 留边: 底图用「原图放大 + 高斯模糊 + 压暗」, 与主体无缝衔接。
    #    比纯色好是因为纯色会形成硬边, 模型会把硬边当成画面里的物体。
    #
    #    关键: paste 是硬贴, 会在主体与留边之间留一条**明显的横线**
    #    (v2 修完拉伸后实测能看到, 尤其在 VELVIA/港风上很明显)。
    #    所以这里用「羽化蒙版」过渡: 主体边缘 alpha 由 0 渐变到 255,
    #    中心完全盖住, 边缘慢慢溶进模糊底图, 接缝就消失了。
    #    渐变带宽度按留边厚度的一半取值, 保证接缝落在最模糊的区域。
    from PIL import ImageDraw, ImageFilter

    bg = img.resize((w, h), Image.BILINEAR)
    bg = bg.filter(ImageFilter.GaussianBlur(radius=max(w, h) * 0.03))
    bg = Image.blend(bg, Image.new("RGB", (w, h), (0, 0, 0)), 0.30)

    off_x, off_y = (w - nw) // 2, (h - nh) // 2
    feather = max(8, min(off_x, off_y, nw // 8, nh // 8))

    mask = Image.new("L", (nw, nh), 255)
    md = ImageDraw.Draw(mask)
    # 从四周向内画递减透明度的矩形, 叠出渐变(同一区域反复画会加深)
    for i in range(feather, 0, -1):
        a = int(255 * (i / feather))
        md.rectangle([i, i, nw - 1 - i, nh - 1 - i], outline=a)
    mask = mask.filter(ImageFilter.GaussianBlur(radius=feather * 0.35))

    bg.paste(img, (off_x, off_y), mask)
    return bg


def do_gen(req: dict) -> dict:
    # 输入图必须先规整到目标尺寸, 不能拿原图直接跑 ——
    # Qwen 的视觉编码器 token 数与图面积成正比。实测喂 1280x720 的原图
    # (921K 像素) 而目标是 512x768 (393K 像素), GPU 会空转 3 分钟不出图,
    # 而规整后只要 27s。像素多 2.3 倍, 叠加 attention 的二次增长就爆了。
    w, h = int(req.get("w", 512)), int(req.get("h", 768))
    src = _fit_exact(Image.open(req["img"]).convert("RGB"), w, h,
                     crop_box=req.get("crop_box"))
    out_path = Path(req["out"])
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # 不传 negative_prompt + cfg=1.0 -> pipeline 走不到 do_true_cfg 分支,
    # 每步只跑一次 transformer。给了 negative_prompt 反而会白跑双倍计算。
    seed = int(req.get("seed") or 0)
    torch.cuda.reset_peak_memory_stats()
    t0 = time.time()
    with torch.inference_mode():
        img = _pipe(
            prompt=req["prompt"],
            image=src,
            num_inference_steps=int(req.get("steps", 4)),
            true_cfg_scale=float(req.get("cfg", 1.0)),
            generator=torch.Generator("cpu").manual_seed(seed),
        ).images[0]

    # pipeline 不会按请求尺寸出图, 而是吸附到自己的分辨率档位
    # (实测传 512x768 出来是 832x1248)。这有两个问题:
    #   1. 拍照机的前端布局按固定比例排版, 尺寸不对会排版错乱;
    #   2. 更隐蔽的是「人脸感知裁切框」是在 512x768 空间里算的,
    #      而输出是另一个尺寸/取景, 导致下游按坐标裁脸会取到背景。
    # 所以这里统一缩放到请求尺寸, 保证「输入什么比例, 输出就什么比例」。
    if img.size != (w, h):
        log(f"pipeline 输出 {img.size[0]}x{img.size[1]}, 缩放到 {w}x{h}")
        img = img.resize((w, h), Image.LANCZOS)

    img.save(out_path, quality=92)
    return {
        "ok": True, "event": "done",
        "seconds": round(time.time() - t0, 2),
        "peak_gb": round(torch.cuda.max_memory_allocated() / 1024**3, 2),
        "lora_layers": _lora_n,
        "out": str(out_path),
        "size": f"{w}x{h}",
    }


# 连续多少次模型加载失败后, worker 主动退出交由父进程重启。
# 3 次是个折中: 单次失败可能是显存瞬时不足或驱动抖动, 直接退出太激进;
# 但一直半死着让每个请求重试 75s 也不行。
MAX_LOAD_FAILURES = 3


def main() -> int:
    # 主动推送, 不带 rid —— 父进程只拿它更新状态, 不会当成任何请求的应答。
    send({"ok": True, "event": "boot", "pid": os.getpid()})
    # 连续加载失败次数。达到上限就退出, 让父进程在 _spawn() 里拉起新进程。
    # 之前加载失败只回一条错误就继续活着, 于是:
    #   - 进程还在, 父进程 poll() 判定它健康, 永远不会重启;
    #   - _pipe 永远是 None, 之后每个 gen 请求都会重试一次 75s 的加载;
    #   - 失败信息只回给单个用户, 进程处于半死状态。
    load_failures = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            send({"ok": False, "error": f"bad json: {e}"})
            continue

        op = req.get("op")
        if op == "shutdown":
            reply(req, {"ok": True, "event": "bye"})
            return 0
        if op == "warmup" and _pipe is None:
            try:
                t0 = time.time()
                load_pipeline()
                log(f"模型加载 {time.time() - t0:.1f}s, 开始预热(首次约 2~3 分钟)...")
                warmup()
                # 注意: 这一行是 warmup 的**回包**, 必须带 rid 让父进程的
                # ensure_ready 拿到它并返回。之前这里发的是不带 rid 的 ready,
                # 父进程按 event 名把它当成主动通知跳过了, 于是继续 readline
                # 一直阻塞到 1800s 超时 —— 模型明明 3.5 分钟就绪了。
                reply(req, {"ok": True, "event": "ready", "lora_layers": _lora_n})
                load_failures = 0
            except Exception as e:
                load_failures += 1
                reply(req, {"ok": False, "error": f"{type(e).__name__}: {e}",
                            "trace": traceback.format_exc()[-1500:]})
                if load_failures >= MAX_LOAD_FAILURES:
                    # 回完这一条就退出, 不能在 while 里 return —— 父进程还在
                    # 等这条应答的 rid, 必须让它先写出去。
                    log(f"模型连续 {load_failures} 次加载失败, worker 退出让父进程重启")
                    sys.stdout.flush()
                    return 3
        elif op == "warmup":
            # 幂等: 已经预热过就直接应答, 别让父进程空等超时。
            reply(req, {"ok": True, "event": "ready", "lora_layers": _lora_n})
        elif op == "gen":
            if _pipe is None:
                try:
                    load_pipeline()
                    load_failures = 0
                except Exception as e:
                    load_failures += 1
                    reply(req, {"ok": False, "error": f"load failed: {e}"})
                    if load_failures >= MAX_LOAD_FAILURES:
                        log(f"模型连续 {load_failures} 次加载失败, worker 退出让父进程重启")
                        sys.stdout.flush()
                        return 3
                    continue
            try:
                reply(req, do_gen(req))
            except Exception as e:
                reply(req, {"ok": False, "error": f"{type(e).__name__}: {e}"})
        else:
            reply(req, {"ok": False, "error": f"unknown op {op!r}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
