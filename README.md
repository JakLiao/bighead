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

RTX 5070 Ti,SDXL + FaceID,steps=20:

| 分辨率 | 耗时 | 峰值显存 | 身份相似度 |
|---|---|---|---|
| 512×768 | ~12s | 6.46 GB | 0.51 |
| 640×960 | ~8s | 6.52 GB | 0.45 |
| 768×1152 | ~8s | 6.61 GB | 0.42 |

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
```

`verify_ai.py` 会用 InsightFace 提取原图与生成图的 512 维人脸向量,
计算余弦相似度来量化"是否还是同一个人",而不是只看图能不能出。

## 已知限制

- 仅桌面浏览器(Chrome / Edge)
- 仅支持本机摄像头(无 DSLR 远程控制)
- VELVIA LoRA 未生效:webui 的 venv 缺 PEFT,风格实际来自提示词
- 人脸检测失败时降级为纯文本生成(不报错,identity 丢失)
- 不引外部字体/贴纸素材包(代码现绘,可后续扩展)
- 不打包成 exe(直接 dev server 运行)
