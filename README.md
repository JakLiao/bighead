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
- 显存峰值 ≤ 7GB

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

## 显存预算

- 关闭 AI:不加载任何模型,几乎不占显存
- 开启 AI 写真(SDXL):峰值 ≤ 7GB,可用余量充足
- 8GB 显存是硬上限,7GB 是承诺峰值

## 冒烟测试

大头贴机本体(无需 GPU 负载):
```bash
E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe scripts\smoke_test.py
```

AI 写真(会真实加载 SDXL,需 1-2 分钟):
```bash
E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe scripts\smoke_test.py --ai
```

## 已知限制

- 仅桌面浏览器(Chrome / Edge)
- 仅支持本机摄像头(无 DSLR 远程控制)
- 不引外部字体/贴纸素材包(代码现绘,可后续扩展)
- 不打包成 exe(直接 dev server 运行)
