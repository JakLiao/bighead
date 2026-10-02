"""集中配置:模型路径、显存预算、风格/滤镜/相框/排版预设."""
from __future__ import annotations

import os
from pathlib import Path

# ----------------------------------------------------------------------------
# Environment(必须在导入 torch / diffusers / transformers 之前设置)
# ----------------------------------------------------------------------------
# 强制禁用系统代理,避免 HF 下载被代理拦截
for _k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
    os.environ[_k] = ""
os.environ.setdefault("NO_PROXY", "*")
os.environ.setdefault("no_proxy", "*")

# 把 HF 缓存重定向到项目本地,避开沙箱外的全局盘(通常不可写)
HF_HOME = Path(__file__).resolve().parent / "vendor" / "hf_cache"
HF_HOME.mkdir(parents=True, exist_ok=True)
os.environ["HF_HOME"] = str(HF_HOME)
os.environ["HUGGINGFACE_HUB_CACHE"] = str(HF_HOME)
os.environ["HF_HUB_CACHE"] = str(HF_HOME)
# TRANSFORMERS_CACHE 在 transformers v5 已废弃,仅为兼容旧版本保留
os.environ.setdefault("TRANSFORMERS_CACHE", str(HF_HOME))

# CUDA kernel 缓存,避免写入用户 AppData(沙箱通常禁止)
os.environ.setdefault(
    "CUDA_CACHE_PATH", str(Path(__file__).resolve().parent.parent / ".cuda_cache")
)

# ----------------------------------------------------------------------------
# Paths
# ----------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = PROJECT_ROOT / "outputs"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# 复用 webui 的模型仓库(用户指定)
MODEL_BASE = Path(r"E:\Code\stable-diffusion-webui\models")

# SDXL 路线(AI 写真默认)
SDXL_CKPT = MODEL_BASE / "checkpoints" / "人像-XL-asian aesthetics（亚洲美学XL）_v2.0.safetensors"
SDXL_VAE = MODEL_BASE / "VAE" / "sdxl_vae.safetensors_sdxl_vae.safetensors"
IPADAPTER_FACEID_SDXL = MODEL_BASE / "ipadapter" / "ip-adapter-faceid-plusv2_sdxl.bin"
FACEID_LORA_SDXL = MODEL_BASE / "Lora" / "ip-adapter-faceid-plusv2_sdxl_lora.safetensors"
CLIP_VISION_H = PROJECT_ROOT / "backend" / "vendor" / "clip_vision" / "CLIP-ViT-H-14-laion2B-s32B-b79K"
VELVIA_LORA = MODEL_BASE / "Lora" / "LEOSAM's FilmGirl  胶片风 LoRA--全新VELVIA版本_3.0.safetensors"

# InsightFace
INSIGHTFACE_ROOT = MODEL_BASE / "insightface"

# 备用 SD1.5 路线(可切换)
SD15_CKPT = MODEL_BASE / "Stable-diffusion" / "人像-realisticVisionV50_v50VAE.safetensors"
IPADAPTER_FACEID_SD15 = MODEL_BASE / "ipadapter" / "ip-adapter-faceid-plusv2_sd15.bin"
FACEID_LORA_SD15 = MODEL_BASE / "Lora" / "ip-adapter-faceid-plusv2_sd15_lora.safetensors"

# ----------------------------------------------------------------------------
# Runtime
# ----------------------------------------------------------------------------
VRAM_BUDGET_GB = 8.0
SDXL_STEPS = 20
SDXL_CFG = 6.5
# 实测峰值(5070 Ti, steps=20, CLIP Vision 用完即卸):
#   512x768 -> 6.46GB / 640x960 -> 6.52GB / 768x1152 -> 6.61GB
# 均在 8GB 预算内;默认取 512x768 以获得最严格的身份保持(cosine≈0.51)
SDXL_SIZE = (512, 768)  # 宽 × 高
SD15_SIZE = (512, 768)
FACEID_SCALE = 0.7
LORA_SCALE = 0.7

# 当前默认底座:"sdxl" | "sd15"
ACTIVE_BACKBONE = "sdxl"

# 输出文件名模板
PHOTO_FILENAME = "photo_{idx}.jpg"
LAYOUT_FILENAME = "layout.jpg"
AI_FILENAME = "ai_{idx}.jpg"

# ----------------------------------------------------------------------------
# 风格预设(AI 写真提示词)
# ----------------------------------------------------------------------------
STYLES: dict[str, dict] = {
    "PORTRAIT_HK": {
        "name": "港风复古",
        "prompt_prefix": (
            "1990s Hong Kong film portrait, warm golden tone, Kodak Portra 400 film grain, "
            "soft window light, slightly overexposed, nostalgic mood, vintage Wong Kar-wai aesthetic, "
            "subject in frame, photorealistic"
        ),
        "negative_prompt": (
            "modern, plastic skin, oversaturated, cartoon, anime, illustration, low quality, "
            "blurry, deformed hands, watermark, text"
        ),
        "lora_scale": 0.7,
        "faceid_scale": 0.7,
    },
    "FILM_VELVIA": {
        "name": "胶片 VELVIA",
        "prompt_prefix": (
            "Fujifilm Velvia 50 film photography, vivid color slide film, deep contrast, "
            "rich saturation, soft natural light, outdoor portrait, classic film look, photorealistic"
        ),
        "negative_prompt": (
            "digital, overprocessed, plastic, modern, low quality, blurry, watermark, text"
        ),
        "lora_scale": 0.9,
        "faceid_scale": 0.65,
    },
    "SHOWA_ANIME": {
        "name": "昭和复古动漫",
        "prompt_prefix": (
            "1980s Showa era anime style portrait, soft cel shading, vintage anime film grain, "
            "warm pastel palette, nostalgic, studio Ghibli-esque, character portrait"
        ),
        "negative_prompt": (
            "3d, photorealistic, modern, low quality, blurry, deformed, watermark, text"
        ),
        "lora_scale": 0.5,
        "faceid_scale": 0.8,
    },
    "DARKROOM_STICKER": {
        "name": "真·大头贴机",
        "prompt_prefix": (
            "vintage 90s photobooth photo, hard flash lighting, white seamless background, "
            "slightly washed out colors, photo sticker style, candid fun expression, photorealistic"
        ),
        "negative_prompt": (
            "modern, cinematic, soft, blurry, low quality, watermark, text"
        ),
        "lora_scale": 0.4,
        "faceid_scale": 0.85,
    },
}

# ----------------------------------------------------------------------------
# 实时滤镜预设(纯 OpenCV,与 AI 无关)
# ----------------------------------------------------------------------------
FILTERS: dict[str, dict] = {
    "none":      {"name": "原片",   "params": {}},
    "faded_90s": {"name": "90年代", "params": {"warmth": 0.18, "fade": 0.25, "grain": 8,  "vignette": 0.35}},
    "warm_kodak":{"name": "柯达暖调","params": {"warmth": 0.25, "fade": 0.10, "grain": 5,  "vignette": 0.20}},
    "bw_classic":{"name": "黑白经典","params": {"bw": True, "contrast": 1.15, "grain": 6, "vignette": 0.30}},
    "vhs":       {"name": "VHS",    "params": {"vhs": True, "shift": 4, "grain": 10, "vignette": 0.40}},
    "polaroid":  {"name": "宝丽来", "params": {"warmth": 0.20, "fade": 0.20, "grain": 7, "vignette": 0.45}},
    "vintage_korean":{"name": "韩式复古","params": {"warmth": 0.12, "fade": 0.15, "grain": 4, "vignette": 0.15}},
}

# ----------------------------------------------------------------------------
# 相框预设(代码现绘)
# ----------------------------------------------------------------------------
FRAMES: dict[str, dict] = {
    "none":         {"name": "无相框",  "params": {}},
    "plain_white":  {"name": "白边",    "params": {"bg": "#ffffff", "pad": 24, "title": ""}},
    "korean_pink":  {"name": "粉色边框","params": {"bg": "#ffd8e1", "pad": 28, "title": "BIGHEAD 2026"}},
    "polaroid":     {"name": "宝丽来",  "params": {"bg": "#f5f1e8", "pad": 36, "title": "BIGHEAD 2026", "bottom_pad": 96}},
    "checker":      {"name": "棋盘格",  "params": {"bg": "checker",   "pad": 24, "title": ""}},
}

# ----------------------------------------------------------------------------
# 排版预设
# ----------------------------------------------------------------------------
LAYOUTS: dict[str, dict] = {
    "2x2":        {"name": "2×2 拼图",  "cols": 2, "rows": 2},
    "2x3":        {"name": "2×3 拼图",  "cols": 2, "rows": 3},
    "3x3":        {"name": "3×3 拼图",  "cols": 3, "rows": 3},
    "strip":      {"name": "长条",      "cols": 4, "rows": 1},
    "6inch_4p":   {"name": "6寸相纸(4张)","cols": 2, "rows": 2, "paper": (1500, 1000)},
}
