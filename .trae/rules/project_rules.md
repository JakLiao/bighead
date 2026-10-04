# BigHead 项目规则

## 1. 后端解释器(最高优先级,违反即视为错误操作)

本项目**没有自己的虚拟环境**,后端复用 Stable Diffusion WebUI 的 venv。

| 用途 | 解释器 |
|---|---|
| 正确 | `E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe` |
| 禁止 | `C:\conda\python.exe`、PATH 里任意 `python`、`py` |

**为什么不能用错**:conda Python 里缺 `insightface` / `onnxruntime` / `diffusers` / `peft`。
用错解释器时故障具有强误导性——服务能起、`/api/health` 正常、连拍/拼图/相框/滤镜全都能用,
只有点「AI 生成」时才报 `No module named 'insightface'`。不要根据"其它功能都正常"推断环境是对的。

## 2. 启动前必须做依赖预检

启动后端**之前**先跑(缺依赖就停下来说明,不要让用户点到 AI 阶段才发现):

```powershell
& "E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe" -c "import sys; from backend.peft_compat import ensure_peft; import insightface, onnxruntime, diffusers, transformers, torch, fastapi, uvicorn; assert ensure_peft(), 'peft still broken'; print('PY=', sys.executable); print('OK')"
```

在项目根目录执行。输出 `PY= E:\Code\...\python.exe` + `OK` 才算通过。

**注意:不能用裸 `import peft` 做预检。** 本项目 transformers 固定 4.37.2,
而 peft 0.15 需要 4.38 才有的 `EncoderDecoderCache`,裸 import 必然抛
`ImportError: cannot import name 'EncoderDecoderCache'`。必须先调
`backend.peft_compat.ensure_peft()` 打兼容补丁,再 import。
这是一条真实存在的依赖死锁,不是环境坏了:

```
diffusers 0.34 -> peft >= 0.15 -> transformers >= 4.38 -> 装不了(共享 venv 只读)
```

`backend/app.py` 启动时会自动调 `backend/preflight.py` 打印依赖状态,
但它**只 warn 不阻断**,所以主动预检仍有价值。

## 3. 启动命令

后端(固定 8077,不要用通用 8000,已被本机其他服务占用):

```powershell
& "E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe" -m uvicorn backend.app:app --host 127.0.0.1 --port 8077
```

前端(必须显式指明后端地址,否则会代理到 8000):

```powershell
cd frontend
$env:BIGHEAD_API_TARGET="http://127.0.0.1:8077"
npm run dev
```

跑 Python 脚本(验证/画像/剖析)时同样必须用 webui venv 解释器,不要用 `python xxx.py`。

## 4. 改代码前后的门禁

```powershell
# 后端门禁
# 注意: ruff 装在 conda 环境里(不是 webui venv), 直接用 PATH 上的 ruff.exe。
# webui venv 里没有 ruff, `python -m ruff` 会报 No module named ruff。
ruff check backend scripts
& "E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe" -m compileall -q backend scripts

# 前端门禁
cd frontend
npm run typecheck
npm run lint
```

两个已知坑:

- **不要让 ruff 自动修复 `peft_compat.py` 的探测性 import。**
  `ensure_peft()` 里那行 `import peft  # noqa: F401` 一旦被删成 `pass`,
  try 块永不抛异常,`ensure_peft()` 会永远返回 True,兼容层检测能力静默失效。
- `pyproject.toml` 的 ruff 规则集很窄(`select = ["F", "E9"]`),
  通过 ruff 不代表没有风格问题,只代表没有未定义名/未用名和语法错误。

## 5. 端到端回归

改了前后端行为后跑 Playwright 脚本(需先起后端 8077 + 前端 5173),
共 8 个脚本 144 项断言,必须 0 失败:

```powershell
cd frontend
node verify-camera.mjs
node verify-burst.mjs
node verify-mask-preview.mjs
node verify-mask-output.mjs
node verify-mask-tabs.mjs
node verify-mask-gallery.mjs
node verify-masks.mjs
node verify-gallery-capture.mjs
```

工作方式要求:审查和修复过程要**边做边记录**到
`docs/review/2026-10-04-code-review.md`,不要攒到最后一次性补写。
