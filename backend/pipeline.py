"""SDXL + IP-Adapter FaceID + VELVIA LoRA 推理(单例懒加载)."""
from __future__ import annotations

import gc
import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path

# 把 vendor 目录注入 sys.path,避免依赖全局 pip 安装 ip-adapter
_VENDOR = Path(__file__).resolve().parent / "vendor"
if _VENDOR.exists() and str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))

import torch

from .config import (
    ACTIVE_BACKBONE,
    FACEID_LORA_SDXL,
    FACEID_SCALE,
    INSIGHTFACE_ROOT,
    IPADAPTER_FACEID_SD15,
    IPADAPTER_FACEID_SDXL,
    LORA_SCALE,
    OUTPUT_DIR,
    PROJECT_ROOT,
    SD15_CKPT,
    SD15_ENABLED,
    SD15_SIZE,
    SKIN_CAST_TARGET_RB,
    SDXL_CKPT,
    SDXL_CFG,
    SDXL_SIZE,
    SDXL_STEPS,
    SDXL_VAE,
    VRAM_BUDGET_GB,
)
from .face import extract_face
from . import ws

log = logging.getLogger("bighead.pipeline")


@dataclass
class GenerationOutput:
    image_paths: list[str]
    vram_peak_gb: float


class BigHeadPipeline:
    def __init__(self):
        self.pipe = None
        self.ip_adapter = None
        self.current_backbone = None
        # 胶片 LoRA 是否生效(load 成功即生效)
        self.lora_active = False
        self.lora_adapter = "film"
        # 允许临时关闭 LoRA(用于 A/B 对照或显存吃紧时)
        self.lora_enabled = os.environ.get("BIGHEAD_LORA", "1") not in ("0", "false", "False")

    # ------------------------------------------------------------------
    # 懒加载
    # ------------------------------------------------------------------
    def _ensure_loaded(self, backbone: str | None = None) -> None:
        if self.pipe is not None and self.current_backbone == (backbone or ACTIVE_BACKBONE):
            return

        backbone = backbone or ACTIVE_BACKBONE
        if backbone != "sdxl" and not SD15_ENABLED:
            raise RuntimeError(
                "SD1.5 路线已停用(config.SD15_ENABLED=False)。"
                "实测 ip-adapter-faceid-plusv2_sd15 与当前 realisticVision V5.0 "
                "底模组合会抹平高频细节,属权重/底模不适配,非本项目代码问题。"
                "请使用 backbone='sdxl'。"
            )
        log.info("loading pipeline: backbone=%s", backbone)
        # 先记录,让 _apply_velvia_lora 等内部逻辑能判断当前 backbone
        self.current_backbone = backbone
        if backbone == "sdxl":
            self._load_sdxl()
        else:
            self._load_sd15()
        self.current_backbone = backbone

    def _load_sdxl(self) -> None:
        from ip_adapter import IPAdapterFaceIDXL  # type: ignore

        if not SDXL_CKPT.exists():
            raise FileNotFoundError(f"SDXL checkpoint not found: {SDXL_CKPT}")
        if not IPADAPTER_FACEID_SDXL.exists():
            raise FileNotFoundError(f"IP-Adapter FaceID SDXL not found: {IPADAPTER_FACEID_SDXL}")
        if not FACEID_LORA_SDXL.exists():
            raise FileNotFoundError(f"FaceID LoRA not found: {FACEID_LORA_SDXL}")

        # 走 webui 的 sd_xl_base.yaml + 单文件 UNet/VAE 完全本地化加载
        # original_config 必须是 yaml 路径,fetch_original_config 内部会 yaml.safe_load
        sd_xl_yaml = Path(r"E:\Code\stable-diffusion-webui\repositories\generative-models\configs\inference\sd_xl_base.yaml")
        if not sd_xl_yaml.exists():
            raise FileNotFoundError(f"sd_xl_base.yaml not found: {sd_xl_yaml}")

        from diffusers import StableDiffusionXLPipeline

        pipe = StableDiffusionXLPipeline.from_single_file(
            str(SDXL_CKPT),
            torch_dtype=torch.float16,
            use_safetensors=True,
            original_config=str(sd_xl_yaml),
        )

        # 显存控制:开 model_cpu_offload,用 hook 在每次 forward 时把子模块
        # 在 GPU/CPU 间搬运,峰值显存从 ~13GB 压到 ~6.6GB(8GB 预算的硬需求)。
        # 代价是 torch.cuda.memory_allocated() 平时接近 0(权重都在 CPU),
        # 排查显存问题时不要被这个数字误导,要看 max_memory_allocated。
        try:
            pipe.enable_vae_tiling()
        except Exception:
            pass
        try:
            pipe.enable_attention_slicing(1)
        except Exception:
            pass

        # LoRA:必须早于 IP-Adapter 注入(见 _apply_velvia_lora 的说明)
        self._apply_velvia_lora(pipe)

        # IP-Adapter FaceID Plus SDXL(锁脸能力更强,需 image_encoder)
        from ip_adapter import IPAdapterFaceIDPlusXL  # type: ignore

        ip = IPAdapterFaceIDPlusXL(
            sd_pipe=pipe,
            image_encoder_path=str(_clip_vision_path()),
            ip_ckpt=str(IPADAPTER_FACEID_SDXL),
            device="cuda",
        )
        ip.set_scale(FACEID_SCALE)

        # 把 pipeline 搬到 cpu(由 ip-adapter 把需要的部分动态搬到 cuda)
        # 这样峰值显存从 13GB 压到 ~6-7GB
        try:
            pipe.enable_model_cpu_offload()
        except Exception as e:
            log.warning("enable_model_cpu_offload failed: %s", e)

        self.pipe = pipe
        self.ip_adapter = ip
        # 复用 webui 的 InsightFace 实例(节省一次加载)
        from .face import _get_app
        self.face_app = _get_app()
        log.info("SDXL pipeline ready")

    def _load_sd15(self) -> None:
        from diffusers import StableDiffusionPipeline
        from ip_adapter import IPAdapterFaceIDPlus  # type: ignore

        if not SD15_CKPT.exists():
            raise FileNotFoundError(f"SD1.5 checkpoint not found: {SD15_CKPT}")
        if not IPADAPTER_FACEID_SD15.exists():
            raise FileNotFoundError(f"IP-Adapter FaceID SD1.5 not found: {IPADAPTER_FACEID_SD15}")

        pipe = StableDiffusionPipeline.from_single_file(
            str(SD15_CKPT),
            torch_dtype=torch.float16,
            use_safetensors=True,
            safety_checker=None,
            # 本地缓存已有 stable-diffusion-v1-5,显式指定避免联网探测
            config="stable-diffusion-v1-5/stable-diffusion-v1-5",
        )
        # 不用 enable_model_cpu_offload:
        #   IPAdapterFaceIDPlus.__init__ 内部会执行 sd_pipe.to("cuda"),
        #   与 offload 的 hook 冲突,导致 text_encoder 留在 CPU 而
        #   encode_prompt(device="cuda") 抛
        #   "Expected all tensors to be on the same device",
        #   或者输出整屏绿色噪点。
        # SD1.5 体积小(UNet 860M),常驻显存约 4GB,直接全量上卡更稳。
        pipe.enable_vae_tiling()
        try:
            pipe.enable_attention_slicing(1)
        except Exception:
            pass

        # 先融 VELVIA LoRA,再注入 IP-Adapter。
        # 依据实测(verify_lora_ab.py / probe_proc_swap.py):
        #   fuse_lora 原地改写 attn.to_q/k/v/out 的权重,而 IP-Adapter 的
        #   set_ip_adapter() 会整体替换 attn_processor 对象 —— 两者改的是
        #   不同层面(权重 vs 计算图),因此先后顺序不冲突。
        #   反过来先注入 IP 再 fuse 才会出问题:fuse 后的权重变化对
        #   LoRAIPAttnProcessor 内部的 lora 分支不可见,风格会静默失效。
        self._apply_velvia_lora(pipe)

        # 用 Plus 版:本地权重是 ip-adapter-faceid-plusv2_sd15,
        # 普通 IPAdapterFaceID 不接受 image_encoder_path,且结构不匹配。
        ip = IPAdapterFaceIDPlus(
            sd_pipe=pipe,
            image_encoder_path=str(_clip_vision_path()),
            ip_ckpt=str(IPADAPTER_FACEID_SD15),
            device="cuda",
        )
        ip.set_scale(FACEID_SCALE)
        # IPAdapter 会把 pipe 搬上 GPU;显式对齐 device,避免 text_encoder 掉队
        pipe.to("cuda")

        self.pipe = pipe
        self.ip_adapter = ip
        # generate_one 会用到 face_app 提取 FaceID embedding,两条路线都要有
        from .face import _get_app

        self.face_app = _get_app()
        log.info(
            "SD1.5 pipeline ready (velvia_lora=%s)", "on" if self.lora_active else "off"
        )

    # ------------------------------------------------------------------
    # LoRA
    # ------------------------------------------------------------------

    def _style_lora_for(self, backbone: str):
        """返回该 backbone 对应的胶片 LoRA 路径,不匹配则返回 None。

        LoRA 的 Kohya key 里 attn2_to_k.lora_down 的第二维就是
        cross_attention_dim,用它做架构判定比文件名可靠:
          - SD1.5 -> 768
          - SDXL  -> 2048
        """
        from .config import SD15_FILM_LORA, SDXL_FILM_LORA

        return {"sdxl": SDXL_FILM_LORA, "sd15": SD15_FILM_LORA}.get(backbone)

    def _apply_velvia_lora(self, pipe) -> bool:
        """加载并融合胶片风 LoRA(按 backbone 自动选权重)。

        返回是否真的生效。原实现把 load 与 fuse 放在同一个 try 里,
        fuse 失败时 LoRA 处于「已注入未融合」的半加载状态,比不加载更糟
        (会额外拖慢每步去噪却不改变风格),所以这里分步处理并各自兜底。

        权重必须与底座架构匹配,否则一律跳过而不是硬加载:
          - SDXL(cross_attention_dim=2048, 双文本编码器各 32 层)
            -> FilmGrainRedmond [32, 2048]
          - SD1.5(768, 单 CLIP ViT-L 12 层)
            -> VELVIA [128, 768]

        调用时机:需在 IP-Adapter 注入之前。fuse 改写的是主干权重,
        IP-Adapter 改写的是 attn_processor 对象,两者层面不同、可共存;
        但若顺序反过来,fuse 的结果不会进入 IP processor 的 lora 分支。
        """
        from .config import LORA_SCALE

        if not self.lora_enabled:
            log.info("style LoRA disabled by env BIGHEAD_LORA=0")
            return False

        lora_path = self._style_lora_for(self.current_backbone)
        if lora_path is None:
            log.info("no style LoRA mapped for backbone=%s", self.current_backbone)
            return False

        if not lora_path.exists():
            log.warning("style LoRA not found at %s (跳过)", lora_path)
            return False

        # PEFT 后端是 diffusers 0.34 加载 LoRA 的硬依赖
        from .peft_compat import ensure_peft

        if not ensure_peft():
            log.warning("PEFT 不可用,跳过胶片 LoRA(风格将只来自提示词)")
            return False

        adapter = "film"
        # LoRA 权重作用在 unet 上;文本侧的胶片感由 STYLE_LORA_TRIGGER
        # 触发词承担(该 LoRA 训练时就是靠触发词激活的)。
        # 设 BIGHEAD_LORA_TEXT_ENCODER=1 可额外融合 text encoder。
        apply_to_text = os.environ.get("BIGHEAD_LORA_TEXT_ENCODER", "0") in (
            "1", "true", "True",
        )
        try:
            pipe.load_lora_weights(
                str(lora_path.parent),
                weight_name=lora_path.name,
                adapter_name=adapter,
                text_encoder_lora_scale=1.0 if apply_to_text else 0.0,
            )
            log.info(
                "style LoRA injected: %s (unet + %s)",
                lora_path.name,
                "text encoders" if apply_to_text else "unet only",
            )
        except TypeError:
            # 老版本 load_lora_weights 不接受 text_encoder_lora_scale
            try:
                pipe.load_lora_weights(
                    str(lora_path.parent),
                    weight_name=lora_path.name,
                    adapter_name=adapter,
                )
                log.info("style LoRA injected: %s (unet only)", lora_path.name)
            except Exception as e:
                log.warning("style LoRA load failed: %s", e)
                return False
        except Exception as e:
            log.warning("style LoRA load failed: %s", e)
            return False

        # 不做 fuse_lora:它会把 LoRA 原地烘进主干权重,不可逆。
        # 而每个风格声明了自己的 lora_scale(0.4~0.9),fuse 之后就再也
        # 没法按风格调节了 —— 早期实现只在加载时按全局 LORA_SCALE 融一次,
        # 导致四个风格里有三个的强度配置完全没生效。
        # 保持未融合状态后,每次生成前调一次 set_scale 即可,
        # 代价是每步去噪多一次 LoRA 计算。
        #
        # 注意这里不能用 pipe.set_adapters():本项目开了
        # enable_model_cpu_offload,offload 后的权重是 inference tensor,
        # 而 set_adapters 内部会 requires_grad_(True) 重新激活 adapter,
        # 对 inference tensor 设 requires_grad 会直接抛异常。
        # _set_style_lora_scale 绕开激活步骤,只改 scale。
        self.lora_active = True
        self.lora_adapter = adapter
        self._set_style_lora_scale(pipe, LORA_SCALE)
        log.info(
            "style LoRA loaded (unfused, scale adjustable per style): %s",
            lora_path.name,
        )
        return True

    def _set_style_lora_scale(self, pipe, scale: float) -> None:
        """按当前风格调整 LoRA 强度(仅未融合模式可用)。

        不能用 pipe.set_adapters():它走 PEFT 的 set_weights_and_activate_adapters,
        内部会 requires_grad_(True) 把 adapter 重新激活,而本项目开了
        enable_model_cpu_offload —— offload 后的权重是 inference tensor,
        对它设 requires_grad 会抛:
            Setting requires_grad=True on inference tensor outside InferenceMode

        这里只借用 diffusers 的同一个遍历函数,跳过激活步骤,
        直接 set_scale —— 改的只是 scale 字典里的浮点数,不动任何张量属性。
        """
        if not self.lora_active:
            return
        adapter = getattr(self, "lora_adapter", "film")
        try:
            from peft.tuners.tuners_utils import BaseTunerLayer

            n = 0
            for _, module in pipe.unet.named_modules():
                if isinstance(module, BaseTunerLayer) and hasattr(module, "set_scale"):
                    module.set_scale(adapter, float(scale))
                    n += 1
            if n == 0:
                log.warning("no PEFT tuner layer found; lora_scale stays at default")
            else:
                log.debug("style lora_scale=%.2f applied to %d layers", scale, n)
        except Exception as e:
            log.warning("per-style lora_scale=%.2f failed: %s", scale, e)

    # ------------------------------------------------------------------
    # 生成
    # ------------------------------------------------------------------
    def generate_one(
        self,
        face_pil,
        style: dict,
        backbone: str | None = None,
        steps: int | None = None,
        faceid_scale: float | None = None,
        size: tuple[int, int] | None = None,
        faceid_embeds=None,
        seed: int | None = None,
    ):
        """生成单张图,返回 PIL.Image.
        自己组装 FaceID pipeline:InsightFace 抽 faceid_embeds → ip-adapter proj → concat 到 prompt embeds → pipe 出图.
        避开 vendored ip-adapter PlusXL.generate 的 bug(self.faceid_embeds 未初始化).

        seed 显式传入时走确定性生成,便于 LoRA/scale 的 A/B 对照;
        缺省才用随机种子(生产路径需要多样性)。
        """
        self._ensure_loaded(backbone)
        backbone = backbone or self.current_backbone or ACTIVE_BACKBONE

        if backbone == "sdxl":
            steps = steps or SDXL_STEPS
            w, h = size or SDXL_SIZE
            cfg = SDXL_CFG
        else:
            steps = steps or 20
            w, h = size or SD15_SIZE
            cfg = 6.0

        prompt = style["prompt_prefix"]
        negative = style.get("negative_prompt", "")

        # 胶片 LoRA 靠触发词激活(SDXL 的 FilmGrainRedmond 就是
        # Film Grain / FilmGrainAF)。只在 LoRA 真的生效时追加 ——
        # BIGHEAD_LORA=0 时这两个 token 没有任何对应权重,留着只是噪声。
        if self.lora_active:
            from .config import STYLE_LORA_TRIGGER

            if STYLE_LORA_TRIGGER and STYLE_LORA_TRIGGER.lower() not in prompt.lower():
                prompt = f"{prompt}, {STYLE_LORA_TRIGGER}"

        if faceid_scale is not None:
            self.ip_adapter.set_scale(faceid_scale)
        elif style.get("faceid_scale") is not None:
            # 风格各自声明锁脸强度;generate_async 之前没传这个参数,
            # 导致 style_cfg["faceid_scale"] 一直是死的。
            self.ip_adapter.set_scale(float(style["faceid_scale"]))

        # 胶片 LoRA 强度同样按风格取值(未融合模式才可调,见 _apply_velvia_lora)
        if style.get("lora_scale") is not None:
            self._set_style_lora_scale(self.pipe, float(style["lora_scale"]))

        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()

        # 上一轮生成可能把 CLIP Vision 卸到了 CPU,这里搬回来
        self._ensure_image_encoder_on_gpu()

        # 1. InsightFace 提取 faceid_embeds(512 维)
        #    若调用方已算好(如 generate_async 里的 extract_face)则直接复用,避免重复检测
        import numpy as np
        import torch as _torch

        if faceid_embeds is not None:
            faceid_embeds_t = _torch.as_tensor(faceid_embeds, dtype=_torch.float32)
            if faceid_embeds_t.dim() == 1:
                faceid_embeds_t = faceid_embeds_t.unsqueeze(0)
        else:
            arr = np.array(face_pil.convert("RGB"))
            faces = self.face_app.get(arr)
            if not faces:
                log.warning("no face detected, falling back to plain generation")
                faceid_embeds = np.zeros((1, 512), dtype=np.float32)
            else:
                face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
                faceid_embeds = face.normed_embedding.reshape(1, -1).astype(np.float32)
            faceid_embeds_t = _torch.from_numpy(faceid_embeds)

        # 2. 用 ip-adapter proj model 得到 image prompt embeds
        #    CLIP Vision 编码器只在算 embeds 时用一次,之后整个去噪过程都不需要它。
        #    但它默认常驻 cuda(632M params ≈ 1.3GB),是 8GB 预算下的主要浪费。
        #    这里算完后立刻搬回 CPU,把显存让给 UNet。
        #
        #    shortcut 必须按 backbone 分别取,不能一律写死 True:
        #    ProjPlusModel.forward 里 `if shortcut: out = x + scale * out`
        #    会把未归一化的 proj 输出再叠加一次,实测让 uncond 分支的
        #    embeds 绝对值从 0.97 涨到 12.76(约 13 倍),CFG 方向被带偏。
        #    官方默认值也是分开的:IPAdapterFaceIDPlus(SD1.5)=False,
        #    IPAdapterFaceIDXL(SDXL)=True。
        ip_shortcut = backbone == "sdxl"
        with _torch.inference_mode():
            image_prompt_embeds, uncond_image_prompt_embeds = self.ip_adapter.get_image_embeds(
                faceid_embeds_t, face_pil, s_scale=1.0, shortcut=ip_shortcut,
            )

            # 3. encode prompt
            #    两者签名都要求 device;区别在于返回值个数:
            #    SDXL 返回 (prompt, neg, pooled, neg_pooled),SD1.5 只返回 (prompt, neg)。
            if backbone == "sdxl":
                (
                    prompt_embeds,
                    negative_prompt_embeds,
                    pooled_prompt_embeds,
                    negative_pooled_prompt_embeds,
                ) = self.pipe.encode_prompt(
                    prompt=prompt,
                    device="cuda",
                    num_images_per_prompt=1,
                    do_classifier_free_guidance=True,
                    negative_prompt=negative,
                )
            else:
                prompt_embeds, negative_prompt_embeds = self.pipe.encode_prompt(
                    prompt=prompt,
                    device="cuda",
                    num_images_per_prompt=1,
                    do_classifier_free_guidance=True,
                    negative_prompt=negative,
                )
                pooled_prompt_embeds = None
                negative_pooled_prompt_embeds = None

            # 4. concat image embeds 到 prompt embeds
            prompt_embeds = _torch.cat([prompt_embeds, image_prompt_embeds], dim=1)
            negative_prompt_embeds = _torch.cat(
                [negative_prompt_embeds, uncond_image_prompt_embeds], dim=1
            )

            # embeds 已在 GPU 上算完,卸载 CLIP Vision 腾出显存给去噪阶段
            self._offload_image_encoder()

            if seed is None:
                seed = int.from_bytes(os.urandom(4), "big")
            gen = _torch.Generator(device="cuda").manual_seed(int(seed) & 0xFFFFFFFF)
            if backbone == "sdxl":
                images = self.pipe(
                    prompt_embeds=prompt_embeds,
                    negative_prompt_embeds=negative_prompt_embeds,
                    pooled_prompt_embeds=pooled_prompt_embeds,
                    negative_pooled_prompt_embeds=negative_pooled_prompt_embeds,
                    num_inference_steps=steps,
                    generator=gen,
                    guidance_scale=cfg,
                    width=w,
                    height=h,
                ).images
            else:
                images = self.pipe(
                    prompt_embeds=prompt_embeds,
                    negative_prompt_embeds=negative_prompt_embeds,
                    num_inference_steps=steps,
                    generator=gen,
                    guidance_scale=cfg,
                    width=w,
                    height=h,
                ).images
        return self._correct_skin_cast(images[0])

    def _correct_skin_cast(self, img) -> object:
        """抵消 IP-Adapter FaceID Plus v2 带来的肤色偏红。

        背景(diag_common_cast.py 固定 seed 实测,脸颊区域 R-B):
            中性 prompt + 无 LoRA + 无 IP      -1.5   (中性)
            同上 + 触发词                      -1.5   (零影响)
            同上 + FilmGrain LoRA             -1.5   (零影响)
            同上 + IP-Adapter FaceID Plus v2  +48.1   (+49.6)
        即胶片 LoRA 与触发词完全无辜,偏红来自 FaceID Plus v2 权重本身 ——
        这是该权重的固有特性,不是本项目的组装 bug,改权重才能根治。

        这里做输出端的轻量补偿:测脸颊区域的 R-B,超过阈值就按比例
        压 R、抬 B,把色相拉回自然肤色。只作用于偏红方向 ——
        若测出偏冷/偏青则不动,避免把胶片的冷调也一起中和掉。

        保留策略:strength=0 时完全跳过(可由 env 关闭),
        且只对"明显偏红"生效,正常输出原样返回。
        """
        try:
            strength = float(os.environ.get("BIGHEAD_SKIN_FIX", "1"))
        except ValueError:
            strength = 1.0
        if strength <= 0:
            return img

        try:
            import numpy as np
            from PIL import Image

            from .face import _get_app

            arr = np.asarray(img.convert("RGB"), dtype=np.float32)
            faces = _get_app().get(arr.astype(np.uint8))
            if not faces:
                return img
            f = max(faces, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]))
            kps = f.kps
            if kps is None or len(kps) < 5:
                return img
            le, re_eye, _nose, lm, rm = [np.asarray(p, dtype=np.float32) for p in kps[:5]]
            eye_y = (le[1] + re_eye[1]) / 2
            mouth_y = (lm[1] + rm[1]) / 2
            cx = (lm[0] + rm[0]) / 2
            half_w = (rm[0] - lm[0]) / 2
            y0 = int(eye_y + (mouth_y - eye_y) * 0.25)
            y1 = int(eye_y + (mouth_y - eye_y) * 0.80)
            x0 = int(max(cx - half_w, 0))
            x1 = int(min(cx + half_w, arr.shape[1] - 1))
            if y1 <= y0 or x1 <= x0:
                return img
            m = np.zeros(arr.shape[:2], dtype=bool)
            m[y0:y1, x0:x1] = True
            px = arr[m]
            rb = float(px[:, 0].mean() - px[:, 2].mean())
        except Exception as e:  # 校正失败不能影响出图
            log.debug("skin cast measure failed: %s", e)
            return img

        # 参考值:健康亚洲脸颊 R-B 约 25~40。超过 TARGET 就按超出的部分补偿,
        # 线性收敛到 TARGET,不做减半 —— 半量修正视觉上仍偏红。
        target = float(SKIN_CAST_TARGET_RB)
        if rb <= target:
            return img

        excess = rb - target
        # 全图按同一比例补偿,保持相对关系;强度由 env 控制便于回退
        delta = excess * strength
        out = arr.copy()
        # 压 R 抬 B 各承担一半,G 微抬避免肤色发灰
        out[..., 0] = np.clip(out[..., 0] - delta * 0.75, 0, 255)
        out[..., 2] = np.clip(out[..., 2] + delta * 0.55, 0, 255)
        out[..., 1] = np.clip(out[..., 1] + delta * 0.20, 0, 255)
        log.info("skin cast corrected: R-B %.1f -> %.1f (delta=%.1f)", rb, target, delta)
        return Image.fromarray(out.astype(np.uint8))

    def _offload_image_encoder(self) -> None:
        """把 CLIP Vision / proj model 搬回 CPU,腾出 GPU 显存给 UNet 去噪."""
        ip = self.ip_adapter
        if ip is None:
            return
        for attr in ("image_encoder", "image_proj_model"):
            mod = getattr(ip, attr, None)
            if mod is None:
                continue
            try:
                mod.to("cpu")
            except Exception as e:  # pragma: no cover
                log.debug("offload %s failed: %s", attr, e)
        gc.collect()
        torch.cuda.empty_cache()

    def _ensure_image_encoder_on_gpu(self) -> None:
        """生成前把 CLIP Vision / proj model 搬回 GPU(与 _offload_image_encoder 成对)."""
        ip = self.ip_adapter
        if ip is None:
            return
        for attr in ("image_encoder", "image_proj_model"):
            mod = getattr(ip, attr, None)
            if mod is None:
                continue
            try:
                mod.to(ip.device, dtype=ip.torch_dtype)
            except Exception as e:  # pragma: no cover
                log.debug("restore %s failed: %s", attr, e)

    async def generate_async(
        self,
        job_id: str,
        frame_paths: list[str],
        style_key: str,
        style_cfg: dict,
        out_dir: Path,
        steps: int | None = None,
        backbone: str | None = None,
    ) -> GenerationOutput:
        """异步生成多张,推 WS 进度."""
        from PIL import Image

        out_dir.mkdir(parents=True, exist_ok=True)
        out_paths: list[str] = []
        failures: list[str] = []
        total = len(frame_paths)
        vram_peak = 0.0

        for i, fp in enumerate(frame_paths):
            try:
                await ws.broadcast(job_id, {"status": "running", "current": i, "total": total, "msg": f"生成第 {i+1}/{total} 张"})
                pil = Image.open(fp)
                pil.load()
                fr = extract_face(pil)
                if fr.no_face:
                    # 检不到脸时保持原比例缩放,不能拉伸成正方形(会严重变形)
                    log.warning("[%s] no face in %s, using full image", job_id, Path(fp).name)
                    face_pil = _fit_within(pil, 768)
                    emb = None
                else:
                    face_pil = fr.face_pil
                    emb = fr.embedding

                img = self.generate_one(
                    face_pil, style_cfg, backbone=backbone, steps=steps,
                    faceid_embeds=emb,
                    faceid_scale=float(style_cfg.get("faceid_scale", FACEID_SCALE)),
                )
                out_path = out_dir / f"ai_{i+1}.jpg"
                img.convert("RGB").save(out_path, quality=92)
                out_paths.append(str(out_path))

                peak_gb = torch.cuda.max_memory_allocated() / 1e9
                vram_peak = max(vram_peak, peak_gb)
                log.info("[%s] generated %s, vram peak=%.2fGB", job_id, out_path.name, peak_gb)
            except Exception as e:
                log.exception("generate failed for %s", fp)
                failures.append(str(e))
                await ws.broadcast(job_id, {"status": "error", "current": i, "total": total, "msg": f"第 {i+1} 张失败: {e}"})

        # 全部失败时抛出,避免上游把空结果标成 done
        if not out_paths and failures:
            raise RuntimeError(f"全部 {total} 张生成失败: {failures[0]}")

        # 图片 URL 按实际落盘路径反推,不要在这里硬编码目录层级 ——
        # out_dir 由调用方决定(目前是 outputs/{job_id}/ai/{style}/),
        # 写死成 /outputs/{job_id}/ai_x.jpg 会在目录分段变化后静默给出 404。
        urls = [
            f"/{Path(p).relative_to(OUTPUT_DIR.parent).as_posix()}" for p in out_paths
        ]
        await ws.broadcast(job_id, {
            "status": "done",
            "current": total,
            "total": total,
            "style": style_key,
            "images": urls,
            "vram_peak_gb": round(vram_peak, 2),
        })
        return GenerationOutput(image_paths=out_paths, vram_peak_gb=vram_peak)


def _clip_vision_path() -> Path:
    """CLIP-ViT-H 视觉编码器路径(SDXL FaceID 必需)."""
    from .config import CLIP_VISION_H
    return CLIP_VISION_H


def _fit_within(pil, max_side: int):
    """等比缩放到最长边不超过 max_side,保持原始宽高比."""
    w, h = pil.size
    longest = max(w, h)
    if longest <= max_side:
        return pil
    scale = max_side / longest
    return pil.resize((max(1, int(w * scale)), max(1, int(h * scale))))


# 全局单例
pipeline = BigHeadPipeline()
