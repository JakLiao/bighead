# BigHead · 大头贴复古

本地大头贴应用,参考 Photobooth Project / Photobooth-App,基于本机摄像头 + 复古滤镜 + AI 写真(可选)。

## 功能

**大头贴机本体**
- 本机摄像头实时预览 + 倒计时连拍(默认 4 张)
- 7 种复古滤镜(OpenCV 实时处理,毫秒级)
- N 宫格拼图(2×2 / 2×3 / 3×3 / 长条 / 6 寸相纸)
- 5 种相框(白边 / 粉边 / 宝丽来 / 棋盘格 / 无)
- 本地画廊浏览历次拍摄
- 一键下载 JPG

**AI 加分项(可选开关)**
- SDXL + IP-Adapter FaceID Plus v2 锁定人脸
- 4 种 AI 风格(港风 / 胶片 VELVIA / 昭和动漫 / 真大头贴机)
- 显存峰值 ≤ 6.7GB(实测,8GB 预算内)

## 快速开始

### 1. 启动后端
双击 `scripts/run.bat`,或手动:
```bash
E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 0.0.0.0 --port 8000
```
后端:http://localhost:8000

### 2. 启动前端
```bash
cd frontend
npm install
npm run dev
```
前端:http://localhost:5173

### 3. 打开浏览器
打开 http://localhost:5173,允许摄像头权限,按空格开始连拍。

## 模型路径

所有模型位于 `E:\Code\stable-diffusion-webui\models\`,在 `backend/config.py` 集中配置。
无需重新下载。

## 显存预算(实测)

RTX 5070 Ti,SDXL + FaceID + 胶片 LoRA(未融合),steps=20,固定 seed 实测:

| 项 | 数值 |
|---|---|
| 峰值显存 | 6.65 GB |
| 单张耗时 | ~7.8s(4 张 31s) |
| 身份相似度 | 0.46 ~ 0.64(16 张实测) |

均低于 8GB 预算。关闭 AI 时不加载任何模型,几乎不占显存。

关键优化:CLIP Vision 编码器(632M params)算完 embeds 后立刻搬回 CPU,
只在下次生成时搬回。去噪阶段完全不需要它,腾出的显存让 UNet 独占,
显存降 1.7GB、速度提升约 1 倍。

## 测试与验证

```bash
PY="E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe"

# 后端接口全量验证(22 项,含错误路径与 WebSocket)
$PY scripts\verify_api.py

# AI 写真验证(需指定真实人脸照片;--quick 只测一档)
$PY scripts\verify_ai.py --face "C:\path\to\portrait.jpg"
$PY scripts\verify_ai.py --face "C:\path\to\portrait.jpg" --quick

# 显存剖析(逐档扫描,定位瓶颈)
$PY scripts\profile_vram.py "C:\path\to\portrait.jpg"

# 端到端(需先起后端 + 前端,脚本只做客户端)
$PY scripts\verify_e2e.py

# 胶片 LoRA 生效验证(SDXL 路线,子进程隔离跑 on/off 对照)
$PY scripts\verify_film_lora.py

# 真实照片全流程(4 个风格各 4 张,含身份相似度与显存)
$PY scripts\verify_flow_real.py

# 风格级 LoRA / FaceID 强度是否真的生效(读 PEFT LoraLayer.scaling)
$PY scripts\verify_lora_scale.py

# 风格差异量化(两两色相直方图 TV 距离)
$PY scripts\verify_style_diff.py

# 肤色偏红检测(用 InsightFace 关键点只测脸颊区域)
$PY scripts\verify_skin_tone.py

# 对运行中的后端做真实 HTTP 冒烟
$PY scripts\verify_live.py

# 列出 Lora 目录并判定每个权重适配 SD1.5 还是 SDXL
$PY scripts\check_sdxl_lora.py
```

`verify_ai.py` 会用 InsightFace 提取原图与生成图的 512 维人脸向量,
计算余弦相似度来量化"是否还是同一个人",而不是只看图能不能出。

## 依赖:PEFT(项目内隔离安装)

Stable Diffusion WebUI 的共享 venv 没有 PEFT,而 diffusers 0.34 加载 LoRA
的 PEFT 后端是硬依赖。该 venv 不允许写入,因此把 PEFT 装到项目内 `.pylibs`,
由 `backend/peft_compat.py` 在运行时注入 `sys.path` 并打兼容补丁
(Transformers 4.37.2 缺 `EncoderDecoderCache`、Accelerate 0.21.0 缺
`clear_device_cache`),不污染共享环境。

重建方式(`.pylibs/` 不入库):

```bash
pip install --no-deps --target .pylibs peft==0.15.2
```

## 胶片风格 LoRA

| backbone | 权重 | 关键维度 |
|---|---|---|
| SDXL | `FilmGrainRedmond-FilmGrain-FilmGrainAF.safetensors` | `attn2_to_k.lora_down = [32, 2048]` |
| SD1.5 | `LEOSAM's FilmGirl ... VELVIA版本_3.0.safetensors` | `attn2_to_k.lora_down = [128, 768]` |

Kohya key 里 `attn2_to_k.lora_down` 的第二维就是 `cross_attention_dim`,
用它判定架构比文件名可靠(`scripts/check_sdxl_lora.py` 会读全部候选并分类)。
SDXL 的胶片 LoRA 靠触发词 `Film Grain, FilmGrainAF` 激活,`generate_one`
只在 `lora_active` 为真时把它追加进 prompt —— 权重没加载时这两个 token
没有对应参数,留着只是噪声。

### 风格级强度:为什么不 fuse_lora

每个风格在 `STYLES` 里声明自己的 `lora_scale`(0.4~0.9)与
`faceid_scale`(0.65~0.85),`generate_one` 每次生成前按当前风格写入。

早期实现用 `fuse_lora()` 融合,它是**不可逆**的 —— 权重被原地烘进
UNet 主干,之后再也无法按风格调节,导致四个风格里有三个的 `lora_scale`
和一个全部 `faceid_scale` 实际是死值。现改为保持未融合,靠
`LoraLayer.set_scale()` 运行时调,代价是每步去噪多一次 LoRA 计算
(实测 4 张 31s,融合时 25s,约 +24%)。

调强度**不能**用 `pipe.set_adapters()`:它内部走 PEFT 的
`set_weights_and_activate_adapters`,会对 adapter 重新
`requires_grad_(True)`,而本项目开了 `enable_model_cpu_offload`,
offload 后的权重是 inference tensor,对它设 `requires_grad` 直接抛
`Setting requires_grad=True on inference tensor outside InferenceMode`。
`_set_style_lora_scale` 绕开激活步骤,只改 `LoraLayer.scaling` 字典
里的浮点数,不碰任何张量属性。

### 显存与内存行为

SDXL 路线开了 `enable_model_cpu_offload`,用 hook 在每次 forward 时把
子模块在 GPU/CPU 间搬运,峰值显存从 ~13GB 压到 ~6.6GB。因此:

- `torch.cuda.memory_allocated()` 平时接近 **0**(权重在 CPU),
  排查显存要看 `max_memory_allocated()`,不要被前者误导。
- 每生成一张会把 CLIP Vision 搬到 CPU、下张再搬回 GPU
  (`_offload_image_encoder` / `_ensure_image_encoder_on_gpu`),
  这是 8GB 预算下的必要取舍。
- 实测连续换 4 个风格各 2 张:`rss` 稳定在 13.2~13.9GB,
  `nvidia-smi` 稳定在 2475MB,**无泄漏**。
- InsightFace 的 5 个 onnx session 只建一次(`face._get_app` 带缓存),
  重复 detect 不涨内存。

`nvidia-smi --query-compute-apps` 在 Windows 上会列出所有持有
D3D/CUDA context 的进程(含系统组件、浏览器、笔记软件),看到几十个
PID 属正常,不是泄漏。

### 肤色偏红校正

出图默认偏红有三个叠加原因,已分别处理:

1. **复古滤镜 `_warmth`**(`filters.py`):原实现 R 涨、G 不动、B 跌,
   系数 (1, 0, −1) 把饱和度推到 10.2%,人眼读作"红"。
   改为 (0.5, 0.45, −0.25),sat 降到 3.9%,亮度基本不变。
2. **风格 prompt 暖词堆叠**:`PORTRAIT_HK` 同时写了
   `warm golden tone` + `Kodak Portra 400` + `slightly overexposed`,
   实测使全图 R−B 达 +34.7(源图仅 +3.5)。已去掉冗余暖词,
   负面词补 `orange skin, red tint, color cast`。
3. **IP-Adapter FaceID Plus v2 权重自带暖偏色** —— 这是主因。
   固定 seed 逐项剥离(中性 prompt,只测脸颊 R−B):

   | 配置 | 脸颊 R−B |
   |---|---|
   | 中性 prompt + 无 LoRA + 无 IP | −1.5 |
   | 同上 + FilmGrain 触发词 | −1.5 |
   | 同上 + 胶片 LoRA | −1.5 |
   | 同上 + IP-Adapter | **+48.1** |

   可见 LoRA 与触发词**零影响**,偏红全部来自 FaceID 权重。
   根治要换权重,但为了不牺牲锁脸,`pipeline._correct_skin_cast`
   在输出端做补偿:用 InsightFace 关键点取脸颊矩形,实测 R−B,
   超过 `SKIN_CAST_TARGET_RB`(38)就线性收敛回去。
   设 `BIGHEAD_SKIN_FIX=0` 可关闭。

   效果:四风格脸颊 R−B 从 +58~+97 降到 +20~+31,
   饱和度从 40~51% 降到 15~25%,身份相似度不降反升
   (均值 0.552 → 0.565)。

### 产物目录

```
outputs/{job_id}/
  photo_{i}.jpg              连拍原图
  ai/{style}/ai_{i}.jpg      AI 产出,按风格分目录
```

AI 产物按 `job_id/style` 分目录,换风格重跑不会覆盖上一轮结果。
`/api/jobs/{id}` 返回的 `images` 只包含最近一次生成的风格,同时回传
`style` 字段供前端区分;要取历史结果直接按目录路径取。

## 已知限制

- 仅桌面浏览器(Chrome / Edge)
- 仅支持本机摄像头(无 DSLR 远程控制)
- **SD1.5 路线已停用**(`config.SD15_ENABLED = False`)。本机的
  `ip-adapter-faceid-plusv2_sd15.bin` 与 `realisticVision V5.0` 底模组合后,
  身份正确但高频细节被严重抹平。四组对照证明与本项目代码无关:
  纯文本正常 / 替换 processor 但喂零 embeds 正常 / 恢复标准 processor 再喂
  同一份 embeds 正常,唯独 `LoRAIPAttnProcessor2_0` 与 FaceID Plus v2 embeds
  同时生效才崩;官方 `IPAdapterFaceIDPlus.generate()` 走原生默认参数同样崩。
  属权重与底模不适配,要复活需换配套 FaceID 权重或换底模。
- 人脸检测失败时降级为纯文本生成(不报错,identity 丢失)
- 不引外部字体/贴纸素材包(代码现绘,可后续扩展)
- 不打包成 exe(直接 dev server 运行)
