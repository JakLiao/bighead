"""SDXL + IP-Adapter FaceID + VELVIA LoRA 推理(单例懒加载)."""
from __future__ import annotations

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
    FACEID_LORA_SD15,
    FACEID_LORA_SDXL,
    FACEID_SCALE,
    INSIGHTFACE_ROOT,
    IPADAPTER_FACEID_SD15,
    IPADAPTER_FACEID_SDXL,
    LORA_SCALE,
    PROJECT_ROOT,
    SD15_CKPT,
    SD15_SIZE,
    SDXL_CKPT,
    SDXL_CFG,
    SDXL_SIZE,
    SDXL_STEPS,
    SDXL_VAE,
    VELVIA_LORA,
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

    # ------------------------------------------------------------------
    # 懒加载
    # ------------------------------------------------------------------
    def _ensure_loaded(self, backbone: str | None = None) -> None:
        if self.pipe is not None and self.current_backbone == (backbone or ACTIVE_BACKBONE):
            return

        backbone = backbone or ACTIVE_BACKBONE
        log.info("loading pipeline: backbone=%s", backbone)
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

        # 显存控制:不开 cpu_offload(由 ip-adapter PlusXL 自己管 device),
        # 保留 vae_tiling 和 attention_slicing 控制峰值
        try:
            pipe.enable_vae_tiling()
        except Exception:
            pass
        try:
            pipe.enable_attention_slicing(1)
        except Exception:
            pass

        # LoRA(VELVIA 胶片)
        if VELVIA_LORA.exists():
            try:
                pipe.load_lora_weights(str(VELVIA_LORA.parent), weight_name=VELVIA_LORA.name)
                pipe.fuse_lora(lora_scale=LORA_SCALE)
                log.info("fused VELVIA LoRA")
            except Exception as e:
                log.warning("VELVIA LoRA load failed: %s", e)
        else:
            log.warning("VELVIA LoRA not found at %s", VELVIA_LORA)

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
        from ip_adapter import IPAdapterFaceID  # type: ignore

        if not SD15_CKPT.exists():
            raise FileNotFoundError(f"SD1.5 checkpoint not found: {SD15_CKPT}")

        pipe = StableDiffusionPipeline.from_single_file(
            str(SD15_CKPT),
            torch_dtype=torch.float16,
            use_safetensors=True,
            safety_checker=None,
        )
        pipe.enable_model_cpu_offload()
        pipe.enable_vae_tiling()
        try:
            pipe.enable_attention_slicing(1)
        except Exception:
            pass

        if VELVIA_LORA.exists():
            try:
                pipe.load_lora_weights(str(VELVIA_LORA.parent), weight_name=VELVIA_LORA.name)
                pipe.fuse_lora(lora_scale=LORA_SCALE)
            except Exception as e:
                log.warning("VELVIA LoRA load failed: %s", e)

        ip = IPAdapterFaceID(
            sd_pipe=pipe,
            image_encoder_path=str(_clip_vision_path()),
            ip_ckpt=str(IPADAPTER_FACEID_SD15),
            lora_path=str(FACEID_LORA_SD15) if FACEID_LORA_SD15.exists() else None,
            device="cuda",
        )
        ip.set_scale(FACEID_SCALE)

        self.pipe = pipe
        self.ip_adapter = ip
        log.info("SD1.5 pipeline ready")

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
    ):
        """生成单张图,返回 PIL.Image.
        自己组装 FaceID pipeline:InsightFace 抽 faceid_embeds → ip-adapter proj → concat 到 prompt embeds → pipe 出图.
        避开 vendored ip-adapter PlusXL.generate 的 bug(self.faceid_embeds 未初始化).
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

        if faceid_scale is not None:
            self.ip_adapter.set_scale(faceid_scale)
        scale = faceid_scale if faceid_scale is not None else FACEID_SCALE

        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()

        # 1. InsightFace 提取 faceid_embeds(512 维)
        import numpy as np
        arr = np.array(face_pil.convert("RGB"))
        faces = self.face_app.get(arr)
        if not faces:
            log.warning("no face detected, falling back to plain generation")
            faceid_embeds = np.zeros((1, 512), dtype=np.float32)
        else:
            face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
            faceid_embeds = face.normed_embedding.reshape(1, -1).astype(np.float32)
        import torch as _torch
        faceid_embeds_t = _torch.from_numpy(faceid_embeds)

        # 2. 用 ip-adapter proj model 得到 image prompt embeds(PlusXL 路径)
        with _torch.inference_mode():
            image_prompt_embeds, uncond_image_prompt_embeds = self.ip_adapter.get_image_embeds(
                faceid_embeds_t, face_pil, s_scale=1.0, shortcut=True,
            )

            # 3. encode prompt,得到标准 SDXL prompt embeds
            (
                prompt_embeds,
                negative_prompt_embeds,
                pooled_prompt_embeds,
                negative_pooled_prompt_embeds,
            ) = self.pipe.encode_prompt(
                prompt=prompt,
                num_images_per_prompt=1,
                do_classifier_free_guidance=True,
                negative_prompt=negative,
            )
            # 4. concat image embeds 到 prompt embeds
            prompt_embeds = _torch.cat([prompt_embeds, image_prompt_embeds], dim=1)
            negative_prompt_embeds = _torch.cat([negative_prompt_embeds, uncond_image_prompt_embeds], dim=1)

            gen = _torch.Generator(device="cuda").manual_seed(int.from_bytes(os.urandom(2), "big"))
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
        return images[0]

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
        total = len(frame_paths)
        vram_peak = 0.0

        for i, fp in enumerate(frame_paths):
            try:
                await ws.broadcast(job_id, {"status": "running", "current": i, "total": total, "msg": f"生成第 {i+1}/{total} 张"})
                pil = Image.open(fp)
                fr = extract_face(pil)
                face_pil = fr.face_pil if not fr.no_face else pil.resize((512, 512))

                img = self.generate_one(face_pil, style_cfg, backbone=backbone, steps=steps)
                out_path = out_dir / f"ai_{i+1}.jpg"
                img.convert("RGB").save(out_path, quality=92)
                out_paths.append(str(out_path))

                peak_gb = torch.cuda.max_memory_allocated() / 1e9
                vram_peak = max(vram_peak, peak_gb)
                log.info("[%s] generated %s, vram peak=%.2fGB", job_id, out_path.name, peak_gb)
            except Exception as e:
                log.exception("generate failed for %s", fp)
                await ws.broadcast(job_id, {"status": "error", "current": i, "total": total, "msg": f"第 {i+1} 张失败: {e}"})

        await ws.broadcast(job_id, {
            "status": "done",
            "current": total,
            "total": total,
            "images": [f"/outputs/{job_id}/ai_{i+1}.jpg" for i in range(len(out_paths))],
            "vram_peak_gb": round(vram_peak, 2),
        })
        return GenerationOutput(image_paths=out_paths, vram_peak_gb=vram_peak)


def _clip_vision_path() -> Path:
    """CLIP-ViT-H 视觉编码器路径(SDXL FaceID 必需)."""
    from .config import CLIP_VISION_H
    return CLIP_VISION_H


# 全局单例
pipeline = BigHeadPipeline()
