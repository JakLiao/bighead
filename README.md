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

### 0. 配置路径(必需)

本项目复用一套 Stable Diffusion WebUI 的环境与模型仓库,**不自带
venv**。仓库里不写死任何人的本机路径,首次使用请设两个环境变量:

```bash
# Windows PowerShell
$env:BIGHEAD_WEBUI_PYTHON="D:\path\to\stable-diffusion-webui\.venv\Scripts\python.exe"
$env:BIGHEAD_MODEL_BASE="D:\path\to\stable-diffusion-webui\models"
# macOS / Linux
# export BIGHEAD_WEBUI_PYTHON=/path/to/stable-diffusion-webui/.venv/bin/python
# export BIGHEAD_MODEL_BASE=/path/to/stable-diffusion-webui/models
```

| 变量 | 作用 | 不设的后果 |
|---|---|---|
| `BIGHEAD_WEBUI_PYTHON` | webui venv 的解释器 | `run.bat` 直接报错退出;验证脚本无法启动子进程 |
| `BIGHEAD_MODEL_BASE` | 模型仓库根目录 | 加载模型时找不到权重 |

未设置时脚本会**明确报错**而不是静默指向一个假路径。

> ⚠️ 解释器不能换成 conda 或 PATH 里的 `python` —— 那套环境缺
> `insightface` / `onnxruntime` / `diffusers` / `peft`,故障表现具有强误导性:
> 服务能起、健康检查正常、连拍/拼图/滤镜全都能用,只有点「AI 生成」时才报
> `No module named 'insightface'`。

### 1. 启动后端
双击 `scripts/run.bat`,或手动:
```bash
%BIGHEAD_WEBUI_PYTHON% -m uvicorn backend.app:app --host 127.0.0.1 --port 8077
```
后端:http://localhost:8077

### 2. 启动前端
```bash
cd frontend
npm install
npm run dev
```
前端:http://localhost:5173

必须显式指明后端地址,否则 vite 会代理到默认的 8000:
```bash
# Windows PowerShell
$env:BIGHEAD_API_TARGET="http://127.0.0.1:8077"
# macOS / Linux
# export BIGHEAD_API_TARGET=http://127.0.0.1:8077
```

### 3. 打开浏览器
打开 http://localhost:5173,允许摄像头权限,按空格开始连拍。

## 模型路径

所有模型位于 `BIGHEAD_MODEL_BASE` 指向的目录(默认为 `<WEBUI_ROOT>\models`),
在 `backend/config.py` 集中配置。无需重新下载。

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

### 驼峰状显存曲线

任务管理器里显存像锯齿一样涨落,**不是泄漏**,是
`enable_model_cpu_offload` 的正常行为:diffusers 用 forward pre/post hook
在每个子模块执行前后把它在 GPU/CPU 之间搬一遍,搬上去用完就搬下来。
所以曲线是「搬上去 → 干活 → 搬下来」的重复,收敛在固定水位。

由此带来两个容易踩的坑:

- `torch.cuda.memory_allocated()` 在两次 forward 之间**接近 0**
  (权重在 CPU),排查显存必须看 `max_memory_allocated()`。
- `_offload_image_encoder` / `_ensure_image_encoder_on_gpu` 每张图要把
  CLIP Vision 搬回 GPU 一次,在 8GB 预算下这是必要取舍。

### 开关一:整条 pipeline 常驻显存(提速 1.56x)

`BIGHEAD_NO_OFFLOAD=1` 时改走 `pipe.to("cuda")`,不再逐模块搬运。
`scripts/bench_offload.py` 在**独立子进程**里对照两种模式(同进程跑会被
上一轮的 CUDA hook 污染,结论不可信):

| 模式 | 单张 | torch 峰值 | nvidia-smi | offload hooks |
|---|---|---|---|---|
| offload(默认) | 6.86 s | 6.65 GB | 3311 MB | 有 |
| 常驻(`BIGHEAD_NO_OFFLOAD=1`) | 4.39 s | 11.65 GB | 15351 MB | 无 |

- 提速 **1.56x**(4 张 27s → 18s),代价是多占约 5GB 显存。
- 两种模式产物 MAE = 0.77,肉眼无差异 —— 差异只来自搬运机制,
  不是生成路径变了。
- 常驻模式下 `_offload_image_encoder` / `_ensure_image_encoder_on_gpu`
  直接返回,省掉每张图两次无意义的 PCIe 往返。
- 17.1GB 卡上常驻 11.65GB(torch)/ 15.35GB(nvidia-smi),
  能跑,但留给 Windows 和其他应用的余量明显变小。

```powershell
# 8GB 预算(默认,原设计口径)
<WEBUI_ROOT>\.venv\Scripts\python.exe -m uvicorn backend.app:app --port 8077

# 整条常驻显存(更快,占 11.65GB)
$env:BIGHEAD_NO_OFFLOAD="1"
<WEBUI_ROOT>\.venv\Scripts\python.exe -m uvicorn backend.app:app --port 8077
```

### 开关二:智能裁切(消除拼贴留白)

相机原图是 1280×720 横图,格位是竖版,旧的 `_resize_to_grid` 用
`thumbnail` + 居中贴到白底格子,横向被裁掉、上下留出大片空白
(实测**格位留白 57.5%**)。

`_face_focus()` + `_smart_crop()` 改成**按目标比例裁源图再缩放**,
并用 InsightFace 最大人脸的 bbox 中心做焦点(纵向再上提 6%,
避免顶到头顶)。默认开启,`BIGHEAD_SMART_CROP=0` 可回退旧行为。

`scripts/verify_collage_crop.py` 用真实 1280×720 拍摄图验证:

```
单格留白: 57.8% -> 0.0%
人脸占比: 16.14% -> 39.35%(几何裁切) / 38.58%(人脸焦点裁切)
整版留白: 57.5% -> 0.0%
PASS=6 FAIL=0
```

对照图在 `outputs/_verify/crop/collage_legacy.jpg` 与 `collage_smart.jpg`。

## 测试与验证

```bash
PY="<WEBUI_ROOT>\.venv\Scripts\python.exe"

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

# offload vs 常驻显存对照(子进程隔离,含峰值显存与产物 MAE)
$PY scripts\bench_offload.py

# 智能裁切验证(真实 1280x720 拍摄图,量留白与人脸占比)
$PY scripts\verify_collage_crop.py
```

`backend/scripts/` 下有一批**不需要起服务**的进程内验证(直接 import 被测模块),
它们比 E2E 快得多, 改后端逻辑后应该先跑这些:

```bash
# 画廊回收站(软删除): 纯函数边界 + TestClient 路由, 全程在临时目录里,
# 绝不碰真实 outputs/。不需要起后端。
$PY backend\scripts\verify_gallery_trash.py

# 相册元数据纯函数(不碰文件系统)
$PY backend\scripts\verify_album_meta.py

# 深浅两层产物镜像的路径契约
$PY backend\scripts\verify_mirror.py
```

回收站那个特意分两层: 纯函数层钉边界(畸形目录名、保留期夹逼边界、
元数据 sidecar 往返), 路由层用 `TestClient` 钉契约(软删/恢复/冲突保护/
清空/路径穿越)。E2E 只能证明"正常路径走得通", 这两层才覆盖得住
畸形输入与 off-by-one。详见 [测试规范](docs/testing-standards.md)。

### 写会删数据的脚本时, 白名单比注释可靠

`verify-gallery-trash.mjs` 头部曾写着「本脚本自己造数据、自己清理,
**绝不碰用户已有的 job**」, 而实现里用的是「全选已加载的 N 条」——
那选中的是**页面上所有卡片, 包括用户自己的照片**。加上另一条断言
`回收站 === 0`, 脚本为了满足它只能走物理删除, 于是用户 222 条照片
全部丢失(`outputs/` 被 gitignore, 无任何恢复途径)。

现在那条路径改成: 目标取 `created ∩ 后端列表`, 逐个勾选, 并在点删除**之前**
加一条刹车断言 —— 选中数量必须恰好等于白名单大小, 不等就 `throw`。
断言也从"回收站是 0"改成比**增量**(`取消后回收站未增加`), 因为要求绝对值 0
等于要求"必须物理删除"。

给后来者的两条规则:

1. **注释不是保护, 白名单才是。** 声明与实现之间没有任何强制关系。
2. 评审时该问的不是"新代码正确吗", 而是**"新代码删的东西和旧代码一样吗"**。
   把一个危险但从未暴露的实现换成更"正确"的实现, 会让旁边潜伏的 bug 显形 ——
   而那些 bug 可能正是数据损失的原因。

前端同理: 框选与 Shift 多选既有 23 项 E2E(`verify-gallery-marquee.mjs`,
真拖一次框), 也有 85 项纯函数单元测试:

```bash
cd frontend
node verify-gallery-selection.mjs
```

纯函数在 `src/components/gallery/selection.ts`, 几何与区间判定都不碰
React/DOM, 于是能脱离浏览器逐条钉边界。分工依据是**能不能脱离浏览器验证**:
`getBoundingClientRect` 留在组件里, "什么算相交"归纯函数。E2E 只能告诉你
"框选没反应", 纯函数测试才能告诉你是哪个判定写错了。

这套测试沿用项目既有的「Vite 转译 TS + 浏览器内 import」模式
(同 `verify-masks.mjs`), **不需要新增任何依赖**; 代价是必须先起
dev server, 不能单跑。

`verify_ai.py` 会用 InsightFace 提取原图与生成图的 512 维人脸向量,
计算余弦相似度来量化"是否还是同一个人",而不是只看图能不能出。

### 写测试时

命令清单告诉你"跑什么",[docs/testing-standards.md](docs/testing-standards.md)
告诉你"结果说明了什么"。三条核心准则:

1. **改契约前先看谁在依赖它**,并判断契约本身对不对 —— 契约错了才改测试。
2. **断言钉不变量,不钉当前取值;别吞异常** —— 硬编码数量和
   `.catch(() => null)` 是回归测试失效的起点。
3. **删除操作只删显式清单,绝不按特征扫** —— 按特征推断"哪些是我造的",
   这个假设在真实用户数据面前不成立。

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

### 两处无界增长(已收敛)

上面说的「无泄漏」指 VRAM/RSS 在正常业务下不涨。审查代码时另外发现
两处**长期运行会无界增长**的容器,已改成有界:

**`ws.py` 订阅队列**:早先用无界 `asyncio.Queue()`。只要有一个客户端
连上却不消费(后台标签页被节流、页面崩溃没走 close),`broadcast` 每次
`put_nowait` 都把消息永久堆在队列里。现在 `maxsize=32`,满了丢最旧的
一条 —— 进度消息是「最新状态」语义,丢过期进度比堆积更有用。
另外 `unsubscribe` 现在会 `pop` 掉空的 job key,否则空 list 永久驻留。

`scripts/_ws_isolated_test.py` 实测(200 订阅者 × 2000 广播):

```
修复前无界缓冲: 400000 条
修复后:         6400 条(= 200 × 32 上限)
最新消息仍是 'done'(drop-oldest 语义正确)
退订后 _connections size = 0(key 正确清理)
```

**`jobs.py` 任务字典**:`_jobs` 原本只增不减,每次拍摄 `new_job()` 一次,
跑一整天累积几千条 `JobInfo`(每条含 images 列表)。现在按「最久未更新」
淘汰到 `_MAX_JOBS=200`,并给刚完成的任务 1 小时保护期(`_TTL_SECONDS`)
—— 保护期是软上限:若剩余条目都还在保护期内就允许暂时超过,
宁可多留几条元数据也不能把前端正在轮询的任务状态删掉。
前端 gallery 走 `outputs/` 目录扫描,不依赖这个字典,淘汰不会让历史照片消失。

`scripts/_jobs_test.py` 实测:

```
50 个任务(未到上限)      -> 50,无误删
450 个全新鲜             -> 450,软上限,不丢活跃任务
同一批置为过期后触发淘汰 -> 200(= 上限)
5000 个任务 + 时间流逝   -> 200,长期有界
```

`ws_jobs.py` 另加了终态后 600s 主动收尾:收到 `done`/`error` 后开始计时,
到期服务端自己断开,不让订阅无限期占着一条队列(客户端崩溃时
`send_text` 未必立刻抛错)。

### AI 生成永远停在 0/0

勾选 AI 复古写真后点生成，按钮一直是「AI 生成中 0/0」，但最终拼图
用的是原图(不是 AI 产物)。**后端其实生成成功了** —— 日志里
`generated ai_1..4.jpg` 都在。这是两个叠加的传输层缺陷:

**1. 订阅晚于广播。** 前端 `doLayout` 里 `setCurrentJobId()` 触发的 WS
连接是异步的,而 `startGeneration()` 紧跟着就返回,后端立刻开始生成并
`broadcast`。WS 还没 accept 完,`_connections` 里没有订阅者,进度消息
全部丢弃:running 收不到 → 停在 0/0;done 也收不到 →
`setBusy(false)` 永不执行 → 按钮一直转。

进度本就是「最新状态」语义,所以订阅时补发一次当前快照即可
(`ws.snapshot_message`),把订阅与广播解耦。

**2. 推理阻塞事件循环。** `pipeline.generate_async` 虽然是 async,
内部却直接调同步的 `generate_one`,SDXL 单张约 4s 把整个 asyncio
循环卡死。这期间**新 WebSocket 连不上**(客户端握手超时),心跳也发不出去。
即使有快照补发,连接本身也建立不起来。

现在整段推理用 `asyncio.to_thread` 挪到工作线程,事件循环保持响应。
`generate_one` 会改共享的 ip_adapter scale 与 LoRA scaling,但
`to_thread` + 串行 for 循环保证同一时刻只有一个推理在跑,不存在竞争。

验证(`scripts/_verify_ws_race_fix.py`,严格按前端时序:先 POST
`generate/start` 再连 WS):

```
[  0.0s] <- running current=0/4     <- 修复前连不上(握手超时)
[ 37.5s] <- running current=1/4
[ 41.0s] <- running current=2/4
[ 44.5s] <- running current=3/4
[ 48.1s] <- done    current=4/4 images=4
```

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

## 许可证

双重许可,任选其一:

- **[Apache License 2.0](LICENSE)** —— 免费,**明确允许商业使用**,
  可闭源分发,无需申请或通知作者。想商用直接用它即可。
- **[商业授权](COMMERCIAL-LICENSE.md)** —— 面向不接受任何开源代码的
  企业客户:闭源许可 + 担保 + 优先支持。需签署双边合同。
  ⚠️ 该文件目前是**占位模板**,不是可用的法律文本。

另有 [NOTICE](NOTICE) 与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md),
记录 `backend/vendor/` 内上游代码的归属,分发时须一并保留。

### ⚠️ 商用前必读:模型权重不在上述许可覆盖范围内

本仓库**只含源码**,不含模型权重。而本项目的 AI 功能依赖多个
**限制性或非商业**许可的第三方权重,例如:

- **InsightFace 预训练权重** —— 代码是 MIT(可商用),但权重
  **仅限非商业研究用途**。代码许可与权重许可是两件事。
- 各社区 SDXL 微调权重、胶片 LoRA、IP-Adapter FaceID 权重 ——
  条款各异,多为非商业。

**本项目的任何授权(开源或商业)都无法传递这些权重的权利。**
商业化前须逐一取得权利人授权,或替换为许可兼容的权重。
另:处理人脸图像涉及生物识别信息,受 GDPR /《个人信息保护法》
约束,须另行满足合规义务。

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
