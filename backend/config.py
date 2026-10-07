"""集中配置:模型路径、显存预算、风格/滤镜/相框/排版预设."""
from __future__ import annotations

import logging
import os
import sys
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
# Windows 非管理员无法创建符号链接(WinError 1314),HF 缓存默认会用 symlink 组织
# snapshots,这里强制改用普通文件复制。
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ["HF_HUB_DISABLE_SYMLINKS"] = "1"
# 不设 TRANSFORMERS_CACHE:transformers 4.37 会发 FutureWarning,5.x 已废弃该变量。
# HF_HOME 本身就会被 huggingface_hub 作为默认缓存目录,无需重复指定。

# CUDA kernel 缓存,避免写入用户 AppData(沙箱通常禁止)
os.environ.setdefault(
    "CUDA_CACHE_PATH", str(Path(__file__).resolve().parent.parent / ".cuda_cache")
)

# PEFT 以 --no-deps 装在项目内 .pylibs(diffusers 0.34 要求 peft>=0.15,
# 而 webui 的 transformers 4.37.2 又满足不了 peft 0.15 的新依赖,
# 所以这里做最小兼容补丁,而不是升级 webui 的依赖)。
# 必须在 import diffusers / peft 之前完成。
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / ".pylibs"))
try:
    from .peft_compat import ensure_peft as _ensure_peft

    _ensure_peft()
except Exception as _e:  # pragma: no cover
    logging.getLogger(__name__).warning("peft compat init failed: %s", _e)

# ----------------------------------------------------------------------------
# Paths
# ----------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = PROJECT_ROOT / "outputs"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# 贴纸册元数据 sidecar。下划线开头是有意为之:
# gallery.py 的目录扫描以 _ 或 . 开头的名字作为内部目录/文件跳过,
# 这样 _album.json 既能被 ALBUM 路径找到, 又不会被列进 /api/gallery 的 items。
ALBUM_FILENAME = "_album.json"
ALBUM_MAX_TITLE = 64      # 标题字节数上限
ALBUM_MAX_NOTE = 280      # 备注字节数上限
ALBUM_MAX_TAG = 16        # 单标签字节数上限
ALBUM_MAX_TAGS = 8        # 标签数量上限

# 复用 webui 的模型仓库(用户指定)。
# 支持 BIGHEAD_MODEL_BASE 覆盖: 换机器 / 换盘时不必改代码。
# 之前这个字面路径散落在 config / qwen_worker / pipeline 三处, 改一处漏两处,
# 且 scripts/ 下还有 11 个一次性脚本各自抄了一份。
#
# 默认值是占位符而非某台机器的真实路径: 本仓库是公开的, 把作者本机的
# 盘符写死在这里既无意义又会泄露目录布局。部署时二选一:
#   1. 设环境变量 BIGHEAD_MODEL_BASE 指向你的 models 目录(推荐)
#   2. 直接改下面这个默认值
MODEL_BASE = Path(
    os.environ.get("BIGHEAD_MODEL_BASE", r"<WEBUI_ROOT>\models")
)
# webui 仓库根(不是 models/)。SDXL 的 original_config yaml 在它下面,
# 以前是 pipeline.py 里又写了一遍字面路径。
WEBUI_ROOT = MODEL_BASE.parent

# SDXL 路线(AI 写真默认)
SDXL_CKPT = MODEL_BASE / "checkpoints" / "人像-XL-asian aesthetics（亚洲美学XL）_v2.0.safetensors"
SDXL_VAE = MODEL_BASE / "VAE" / "sdxl_vae.safetensors_sdxl_vae.safetensors"
IPADAPTER_FACEID_SDXL = MODEL_BASE / "ipadapter" / "ip-adapter-faceid-plusv2_sdxl.bin"
FACEID_LORA_SDXL = MODEL_BASE / "Lora" / "ip-adapter-faceid-plusv2_sdxl_lora.safetensors"
CLIP_VISION_H = PROJECT_ROOT / "backend" / "vendor" / "clip_vision" / "CLIP-ViT-H-14-laion2B-s32B-b79K"

# 胶片风 LoRA(SDXL 专用)。
# 原 VELVIA("LEOSAM's FilmGirl ... VELVIA版本_3.0")实测为 SD1.5 权重:
#   lora_unet_..._attn2_to_k.lora_down = [128, 768]  -> cross_attention_dim=768
#   lora_te_text_model_encoder_layers 最多到 11       -> 单个 CLIP ViT-L
# 而 SDXL 的 cross_attention_dim=2048 且有双文本编码器(各 32 层),
# 强行加载只会得到大批 size mismatch。
# 因此 SDXL 路线改用 FilmGrainRedmond(SDXL 原生):
#   lora_unet_..._attn2_to_k.lora_down = [32, 2048]  -> 匹配 SDXL
# 触发词 Film Grain / FilmGrainAF 需拼进 prompt,见 STYLE_LORA_TRIGGER。
SDXL_FILM_LORA = MODEL_BASE / "Lora" / "FilmGrainRedmond-FilmGrain-FilmGrainAF.safetensors"
STYLE_LORA_TRIGGER = "Film Grain, FilmGrainAF"
VELVIA_LORA = MODEL_BASE / "Lora" / "LEOSAM's FilmGirl  胶片风 LoRA--全新VELVIA版本_3.0.safetensors"
SD15_FILM_LORA = VELVIA_LORA

# InsightFace
INSIGHTFACE_ROOT = MODEL_BASE / "insightface"

# ----------------------------------------------------------------------------
# Qwen-Image-Edit-2511 路线(替换 SDXL + FaceID 的新后端)
# ----------------------------------------------------------------------------
# 换它的唯一理由: 身份保真是架构级的(image-to-image 编辑),
# 而 SDXL + IP-Adapter FaceID 实测只能锁住骨骼骨架, 性别/年龄/发型
# 会被底模先验带走 —— 就是"产出和拍照的人完全不对"的根因。
QWEN_MODEL_DIR = MODEL_BASE / "qwen"
QWEN_TRANSFORMER = QWEN_MODEL_DIR / "transformer" / "qwen-image-edit-2511-Q3_K_M.gguf"
QWEN_VAE_DIR = QWEN_MODEL_DIR / "vae"
QWEN_TEXT_ENCODER_DIR = QWEN_MODEL_DIR / "text_encoder"
QWEN_PROCESSOR_DIR = QWEN_MODEL_DIR / "processor"
QWEN_SCHEDULER_DIR = QWEN_MODEL_DIR / "scheduler"
QWEN_LORA_KOHYA = (
    QWEN_MODEL_DIR / "lora" / "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"
)
# 转换后的 PEFT 命名版本(由 qwen_pipeline 自动生成并缓存)。
# lightx2v 的 LoRA 是 Kohya 命名(lora_down/lora_up/alpha), diffusers 只认
# PEFT 的 lora_A/lora_B, 必须转换 —— 详见 qwen_pipeline.convert_lora_to_peft。
QWEN_LORA_PEFT = OUTPUT_DIR / "_cache" / "qwen_lightning4_peft.safetensors"

# 运行参数(全部来自实测,见 docs/superpowers/plans/2026-10-03-qwen-image-edit-migration.md)
#   4 步 + CFG 1.0 是 Lightning 蒸馏的配对用法: 蒸馏已把引导信号烧进
#   步数里, CFG>1 反而会"烧焦"(极高对比/阴影死黑)。CFG=1.0 同时让 pipeline
#   跳过双批分支(每步只跑一次 transformer, 而非 cond+uncond 两次)。
QWEN_STEPS = 4
QWEN_CFG = 1.0
QWEN_SIZE = (512, 768)  # 宽 × 高, 与 SDXL_SIZE 一致, 前端零改动
# Q3_K_M 而非 Q4_K_M: Q4 实测峰值 16.81G 已超过物理显存 15.89G,
# 再挂 720 个 LoRA 层必然溢出 -> WDDM 换页 -> 647s/张(实测)。
# Q3 把峰值压到 14.61G, 同样挂 LoRA 只要 26.0s/张。
# 身份余弦代价很小: 0.9082(Q4 裸跑) -> 0.8967(Q3+LoRA)。
QWEN_LORA_ENABLED = os.environ.get("BIGHEAD_QWEN_LORA", "1") not in ("0", "false", "False")

# 备用 SD1.5 路线(可切换)
# 实际文件名带 _V5.0 后缀,且位于 checkpoints/ 而非 Stable-diffusion/,
# 这里直接按现有 checkpoints 目录解析,避免手写路径再次失配。
SD15_CKPT = MODEL_BASE / "checkpoints" / "人像-realisticVisionV50_v50VAE.safetensors_V5.0.safetensors"

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

# 肤色偏红校正的目标值(脸颊区域 R - B)。
# 实测(diag_common_cast.py 固定 seed,InsightFace 关键点取脸颊矩形):
#   健康亚洲脸颊           R-B ≈ 25~40
#   中性 prompt 无 IP      R-B = -1.5(纯中性)
#   加 IP-Adapter FaceID   R-B = +48.1  <-- 权重自带的暖偏色
# 超过本值才触发补偿,可用 BIGHEAD_SKIN_FIX=0 关闭。
SKIN_CAST_TARGET_RB = 38.0

# 当前默认底座:"sdxl" | "sd15"
ACTIVE_BACKBONE = "sdxl"

# ----------------------------------------------------------------------------
# AI 生图后端选择:"qwen" | "sdxl"
# ----------------------------------------------------------------------------
# 为什么需要这个开关(实测结论, 不是设计冗余):
#   Qwen-Image-Edit 链路要求 diffusers>=0.40 + transformers>=5.18,
#   而本服务跑在 webui 的 .venv 里(diffusers 0.34.0 / transformers 4.37.2),
#   两者**无法共存于同一进程** —— diffusers 0.40 要 huggingface-hub>=1.23,<2,
#   而 transformers 4.37~4.57 全部要求 huggingface-hub<1.0,区间不相交。
#   所以 Qwen 跑在独立解释器 .venv-qwen 里, 由 backend/qwen_pipeline.py
#   以常驻子进程的方式托管, 走文件协议通信。
#
# 切换方式: 环境变量 BIGHEAD_AI_BACKEND=qwen|sdxl (默认 sdxl, 保证回退安全)
AI_BACKEND = os.environ.get("BIGHEAD_AI_BACKEND", "sdxl").strip().lower()
if AI_BACKEND not in ("qwen", "sdxl"):
    raise ValueError(f"BIGHEAD_AI_BACKEND 只能是 qwen 或 sdxl, 收到 {AI_BACKEND!r}")

# Qwen 子进程用的解释器(必须是装了 diffusers 0.40 / transformers 5.x 的那个)
QWEN_PYTHON = Path(
    os.environ.get(
        "BIGHEAD_QWEN_PYTHON",
        str(PROJECT_ROOT / ".venv-qwen" / "Scripts" / "python.exe"),
    )
)
QWEN_WORKER = PROJECT_ROOT / "backend" / "qwen_worker.py"

# SD1.5 路线已停用。
# 原因(实测结论,非代码缺陷):本机 ip-adapter-faceid-plusv2_sd15.bin 与
# realisticVision V5.0 底模组合后,出图身份正确但高频细节被严重抹平。
# 四组对照(scripts/probe_proc_swap.py)证明:
#   纯文本正常 / 替换 processor 但喂零 embeds 正常 /
#   恢复标准 processor 再喂同一份 embeds 正常 /
#   唯独「LoRAIPAttnProcessor2_0 + FaceID Plus v2 embeds」同时生效才崩;
#   且官方 IPAdapterFaceIDPlus.generate() 走原生默认参数同样崩。
# 即权重与底模不适配,与本项目的组装逻辑无关。
# 保留 SDXL 为唯一生产路线;若日后要复活 SD1.5,需换用与 V5.0 配套的
# FaceID 权重(或改回未经改动的底模),而不是调整本仓库代码。
SD15_ENABLED = False

# 输出文件名模板
PHOTO_FILENAME = "photo_{idx}.jpg"
LAYOUT_FILENAME = "layout.jpg"
AI_FILENAME = "ai_{idx}.jpg"
# 分享卡(4:3 成品, 含品牌 footer)。与 layout.jpg 平级 —— layout 是
# 「拼图原样」, share 是「可直接发出去的成品」, 两者都要留。
SHARE_FILENAME = "share.jpg"

# 分享卡几何(固定 4:3, 150 DPI -> 1200x900 = 8x6 英寸)。
#
# 为什么固定比例而不跟随排版: 分享卡要发到社交平台, 比例不统一会导致
# 版式碎裂。排版本身有 2x2(接近 1:1)、strip(4:1 极端横长)等多种比例,
# 全部塞进同一个 4:3 画布 —— 长条会在上下留大片空白, 方形会在左右留白。
# 这是刻意接受的代价: 一致的对外形态 > 画面填满。
#
# 内容区与页脚区的高度是按 4:3 反推的: 900 - 220(footer) = 680,
# 减去上下各 40 边距 = 600 给画面。
#
# 镜像常量在 frontend/src/shareCard.ts。**两处必须逐值一致** ——
# 前端那份用于日常出片, 这份用于补生成历史卡片, 独立实现同一个设计时
# 不一致只有肉眼能发现。
SHARE_CARD_SIZE = (1200, 900)
SHARE_CARD_BG = (255, 248, 240)     # 与 layouts.py 的纸底同色
SHARE_CARD_MARGIN = 40
SHARE_CARD_FOOTER_H = 220
# 品牌行文案。footer = 品牌行 + 短 job ID + 拍摄日期。
SHARE_CARD_BRAND = "BigHead 大头贴复古"
# 短 job ID 取前几位。6 位是在「卡片上不喧宾夺主」与「够口头指认某一张」
# ("你那张 c3f1a9 的")之间的取舍。
SHARE_CARD_SHORT_ID = 6
# 中文字体候选链, 按优先级探测。msyh.ttc(微软雅黑)是 Windows 自带且
# 字形最稳; simhei.ttf 次之。
#
# arial.ttf 排在候选链之后而不是链首: PIL 遇到字体里没有的字形**不会抛
# 异常**, 它会画出 .notdef(空心方框)。若只写「找不到就用 arial」, 结果是
# 一张排版看起来完全正常、但品牌行是三个豆腐块的图, 且没有任何报错。
# 这类静默失败最难在测试里发现, 所以链首必须是真正含中文字形的字体。
SHARE_CARD_FONTS = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\msyhbd.ttc",
]
# 纯 ASCII 兜底(至少让 job_id 正常显示)。中文在它下面必然是豆腐块。
SHARE_CARD_FONT_FALLBACK = r"C:\Windows\Fonts\arial.ttf"

# ----------------------------------------------------------------------------
# 风格预设(AI 写真提示词)
# ----------------------------------------------------------------------------
# 两套后端共用同一个 STYLES 字典, 但 prompt 语义完全不同:
#   sdxl 后端 -> prompt_prefix 是「文生图描述」(画一张什么样的照片)
#   qwen 后端 -> prompt_prefix 是「编辑指令」(把这张照片改成什么样)
# 下面每个风格同时给出两者, 由 qwen_pipeline / pipeline 各自取用。
# 关键差异: Qwen 是 image-to-image 编辑模型, 身份保真是架构级的;
# 指令里必须显式写「保持身份/五官不变」, 否则 4 步蒸馏容易顺手把脸也改了。
STYLES: dict[str, dict] = {
    "PORTRAIT_HK": {
        "name": "港风复古",
        # 身份优先(实测后的定稿版)。这里刻意**不**写「严格的身份约束」这类
        # 强调句: Qwen 的 system prompt 本身就要求 "maintaining consistency
        # with the original input", 指令里再叠加强调并不会提高保真度,
        # 反而把权重从风格描述上挪走。实测「加强约束」对身份无增益
        # (见文档 4/8/12 步与 A/B 实验), 所以保持一句轻约束即可。
        # 风格强度也刻意收着 —— 实测强风格化会明显改脸型。
        "qwen_prompt": (
            "把照片调成 1990 年代香港电影剧照的色调: 整体偏暖的胶片色, "
            "轻微褪色发灰, 柔和的窗光。保留原图的人物和构图, 不要改动五官和脸型。"
        ),
        # SDXL 路线(保留以便回退对照)
        "prompt_prefix": (
            "1990s Hong Kong film portrait, Kodak Portra 400 film grain, "
            "soft diffused window light, muted natural skin tone, "
            "shallow depth of field, nostalgic mood, photorealistic"
        ),
        "negative_prompt": (
            "modern, plastic skin, oversaturated, orange skin, red tint, "
            "color cast, cartoon, anime, illustration, low quality, "
            "blurry, deformed hands, watermark, text"
        ),
        "lora_scale": 0.7,
        "faceid_scale": 0.7,
    },
    "FILM_VELVIA": {
        "name": "胶片 VELVIA",
        # Velvia 的问题是它本身色彩冲击很强(高饱和是它的招牌), 稍一过头
        # 就会连肤色一起过饱和, 反而让人脸变形。所以措辞上把强度压下来,
        # 并且**用正向描述代替负向词** —— Qwen 路线 CFG=1.0 时
        # do_true_cfg 分支不成立, negative_prompt 根本不参与计算
        # (见 qwen_worker.do_gen 注释), 「不要发红」这类负向词只会被
        # 正文 encoder 当成语义特征吃掉。
        "qwen_prompt": (
            "把照片调成富士 Velvia 50 反转片的色彩: 稍微提高饱和度, "
            "通透的暖调, 肤色自然。保留原图的人物和构图, 不要改动五官和脸型。"
        ),
        # SDXL 路线
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
        # 四个风格里身份代价最高的: 写实 -> 赛璐璐是最大的风格跳跃。
        # 修复纵横拉伸后实测余弦从 0.20 升到 0.46 —— 比三个写实风格低,
        # 但目视身份是保留的(眼镜/发型/脸型都在), 0.46 主要反映
        # 「赛璐璐画法」与「写实人脸」在 embedding 空间的固有距离,
        # 不等于认不出人。保持完整转绘, 只要求保留五官特征。
        "qwen_prompt": (
            "把照片转绘成 1980 年代日本动漫的赛璐璐上色风格: 平涂色块、"
            "清晰干净的线条、柔和的暖调配色。把背景换成干净的纯色背景, "
            "保留原图人物的脸型、五官特征、发型和眼镜等配饰。"
        ),
        # SDXL 路线
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
        # 实测这个风格的身份保持最好(余弦 0.89, 全场最高) —— 因为它本质
        # 是「换背景 + 换光线」, 不重绘五官。原指令里「保留原图构图」与
        # 「纯白背景」自相矛盾(换背景就换了构图), 模型会在这两条间摇摆,
        # 已拆开: 构图保留的是主体位置与姿态, 背景交给纯白。
        "qwen_prompt": (
            "把照片处理成 1990 年代大头贴机拍出来的贴纸照: 换成纯白无缝背景, "
            "正面硬闪光直打, 色彩略微冲淡, 有轻微的相纸颗粒感。"
            "保留原图的人脸和构图, 不要改动五官。"
        ),
        # SDXL 路线
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
# 每项新增 `css` 字段:同一组 OpenCV 算子在 CSS filter 里的近似映射,
# 供前端取景框实时预览。它不是装饰性的 —— 拍照瞬间 snap() 会把同一份字符串
# 交给 `ctx.filter` 烧进成片,所以预览和出片天然一致(所见即所得),
# 不需要维护两套参数。
#
# 映射依据(对照 filters.py 的算子语义):
#   warmth  -> sepia + saturate。sepia 是浏览器里唯一能"抬 R/G 压 B"的单调算子,
#              与 _warmth 的 (0.5, 0.45, -0.25) 方向一致。
#   fade    -> contrast 略降 + brightness 微升,复刻"向白色插值"的褪色观感。
#   bw      -> grayscale(1) + contrast。
#   vhs     -> saturate 提升 + hue-rotate 轻微偏色,代替通道错位(CSS 无法表达 roll)。
#   grain / vignette -> CSS 无对应算子。grain 仅出片由后端加;vignette 由前端
#              MaskOverlay 叠一层径向渐变还原。故都不写进 css。
FILTERS: dict[str, dict] = {
    "none":      {"name": "原片",   "params": {}, "css": ""},
    "faded_90s": {"name": "90年代", "params": {"warmth": 0.18, "fade": 0.25, "grain": 8,  "vignette": 0.35},
                  "css": "sepia(0.22) saturate(0.88) contrast(0.92) brightness(1.04)"},
    "warm_kodak":{"name": "柯达暖调","params": {"warmth": 0.25, "fade": 0.10, "grain": 5,  "vignette": 0.20},
                  "css": "sepia(0.32) saturate(0.95) contrast(1.02) brightness(1.01)"},
    "bw_classic":{"name": "黑白经典","params": {"bw": True, "contrast": 1.15, "grain": 6, "vignette": 0.30},
                  "css": "grayscale(1) contrast(1.15)"},
    "vhs":       {"name": "VHS",    "params": {"vhs": True, "shift": 4, "grain": 10, "vignette": 0.40},
                  "css": "saturate(1.25) hue-rotate(-6deg) contrast(1.08)"},
    "polaroid":  {"name": "宝丽来",  "params": {"warmth": 0.20, "fade": 0.20, "grain": 7,  "vignette": 0.45},
                  "css": "sepia(0.26) saturate(0.85) contrast(0.9) brightness(1.06)"},
    "vintage_korean":{"name": "韩式复古","params": {"warmth": 0.12, "fade": 0.15, "grain": 4,  "vignette": 0.15},
                  "css": "sepia(0.14) saturate(0.9) contrast(0.96) brightness(1.03)"},
}

# ----------------------------------------------------------------------------
# 年代处理预设(纯 OpenCV,叠加在 FILTERS 之上)
# ----------------------------------------------------------------------------
# era 是**顶层独立维度**,不属于任何滤镜: 同一个滤镜可以配 modern 也可以配
# vintage_2000,反之亦然。所以这里不往 FILTERS 里塞 per-filter 的 era 字段 ——
# 那样的字段取值恒为默认的 modern, 是永远读不到的死字段。
#
# 结构与 FILTERS/FRAMES 对齐: {"name": 展示名, "params": 算子参数}。
# 把参数外置到这里的理由: era 算子的"手感"(短边目标、漏光强度/范围)本质是
# 美术调参, 埋在 filters.py 的函数体里就只能改代码重跑才能试。
# filters.ERA_OPS 里的算子统一按 (bgr, params) 接收, 新增 era 只需在两处
# 各加一行(本表 + 那张表), 算子本体不感知 era 的存在。
#
# modern  : 恒等(identity),不动像素。params 为空 —— 没有可调的东西。
# vintage_2000: 模拟 2000 年 CCD 大头贴机 —— 低分辨率 + 顶部漏光 + 色阶断层。
ERA_PRESETS: dict[str, dict] = {
    "modern": {"name": "现代高清", "params": {}},
    "vintage_2000": {
        "name": "古早画质",
        "params": {
            # 下采样目标短边。CCD 时代的有效分辨率就这么高, 皮肤细节在这个
            # 往返里被自然抹平(是"糊得对", 不是加模糊)。用短边而非固定
            # 640x480 是因为 layout 出来的成片尺寸不固定(6寸相纸 1500x1000)。
            "short_edge": 480,
            # 顶部漏光覆盖的高度比例。取 0.5 而非 0.25: 漏光是从画面顶端
            # 向外溢出的衰减, 铺满上半幅才能在顶部 1/4 拿到足够均值,
            # 同时让衰减尾巴拖到画面中线, 不留可见的横向硬边。
            "leak_ratio": 0.5,
            # 漏光在**顶端**的峰值强度(第 0 行), 沿高度线性衰减到 leak_ratio
            # 处归零。R 抬得比 G 多但 G 也参与(R+G 才是暖黄, 只抬 R 会发红);
            # B 不动。峰值高于顶部 1/4 的均值, 是为了补偿线性衰减后
            # 顶部 1/4 的平均增温仍能稳定超过 20 个色阶。
            "leak_r": 40,
            "leak_g": 14,
        },
    },
}
ERA_DEFAULT: str = "modern"
ERA_KEYS: list[str] = list(ERA_PRESETS.keys())

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
