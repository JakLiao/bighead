"""模型路径收敛验证: 硬编码路径不得散落在 backend/ 各模块。

背景
----
`E:\\Code\\stable-diffusion-webui` 曾经硬编码在 3 个地方:
    - config.py    MODEL_BASE(权威来源)
    - qwen_worker.py  自己又写一遍 MODEL_BASE / QWEN / TRANSFORMER / LORA_KOHYA
    - pipeline.py  sd_xl_base.yaml 又写一遍 webui 根目录

以及 11 个 scripts/*.py。这些脚本是一次性调试产物(文件名多数带 _ 前缀),
不在运行时链路上, 单独列在 §2 里按「低优先」处理。

本脚本验证的是**运行时链路**(backend/ 下会被服务加载的模块):
    1. backend/ 除 config.py 外不再出现字面硬编码的 webui 路径
    2. qwen_worker.py 的路径常量确实来自 config(导入即相等), 而不是又抄了一遍
    3. MODEL_BASE 支持 BIGHEAD_MODEL_BASE 环境变量覆盖(换机器不用改代码)
    4. preflight._suggest_interpreter 的正则仍能解析出 webui 根目录
       —— 这是隐藏耦合: 它靠正则读 config.py 源码, 改写法就静默失效

跑法(webui venv):
    & "E:\\Code\\stable-diffusion-webui\\.venv\\Scripts\\python.exe" backend\\scripts\\verify_paths.py
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{('  ' + detail) if detail else ''}")


BACKEND = ROOT / "backend"
WEBUI_LITERAL = "stable-diffusion-webui"

# ---------- §1 运行时模块不得再硬编码 ----------
# config.py 是权威来源, 允许它出现字面路径(那是默认值本身)。
# preflight.py 允许出现: 它要按 webui 布局推导 .venv 位置, 那是逻辑而非配置。
ALLOWED = {"config.py", "preflight.py"}
# 本文件自己也在 backend/scripts/ 下, 但上面的 startswith("scripts/") 判定用的是
# 相对 ROOT 的 posix 路径, 这里显式跳过自身: WEBUI_LITERAL 这个常量本身就是
# 那个字符串, 扫到会让自己判红, 变成永远红的断言。
SELF = "backend/scripts/verify_paths.py"
offenders: list[str] = []
for py in sorted(BACKEND.rglob("*.py")):
    rel = py.relative_to(ROOT).as_posix()
    if rel in ALLOWED or rel == SELF or "/vendor/" in rel or rel.startswith("backend/scripts/"):
        continue
    text = py.read_text(encoding="utf-8", errors="replace")
    for i, line in enumerate(text.splitlines(), 1):
        # 注释/docstring 里的路径提及不算硬编码, 但要单独人工确认过:
        # 下面只对「赋值给常量」的形式判红, 避免把文档说明误判成配置。
        if re.search(rf'=\s*(Path\()?r?["\'][^"\']*{WEBUI_LITERAL}', line):
            offenders.append(f"{rel}:{i}  {line.strip()[:90]}")
check(
    "backend/ 运行时模块无字面硬编码 webui 路径",
    not offenders,
    "; ".join(offenders[:4]),
)

# ---------- §2 qwen_worker 的路径来自 config 而非自抄 ----------
# 用 AST 静态判断: 硬编码是 r"..." 字面量, 收敛后是 QWEN_MODEL_DIR 等名字。
worker_src = (BACKEND / "qwen_worker.py").read_text(encoding="utf-8")
check(
    "qwen_worker.py 不再自己定义 MODEL_BASE 字面量",
    not re.search(rf'=\s*Path\(r?["\'][^"\']*{WEBUI_LITERAL}', worker_src),
)
check("qwen_worker.py 从 config 导入模型路径", "from .config import" in worker_src or "from backend.config import" in worker_src)

# 收敛后两者必须指向同一个目录 —— 静态检查之外再做一次真实导入比对。
qwen_py = ROOT / ".venv-qwen" / "Scripts" / "python.exe"
if qwen_py.exists():
    code = (
        "import sys; sys.path.insert(0, r'%s');"
        "from backend.config import QWEN_MODEL_DIR, QWEN_TRANSFORMER, QWEN_LORA_KOHYA, QWEN_LORA_PEFT;"
        "import backend.qwen_worker as w;"
        "print(QWEN_MODEL_DIR == w.QWEN);"
        "print(QWEN_TRANSFORMER == w.TRANSFORMER);"
        "print(QWEN_LORA_KOHYA == w.LORA_KOHYA);"
        "print(QWEN_LORA_PEFT == w.CACHE)" % ROOT
    )
    r = subprocess.run(
        [str(qwen_py), "-c", code],
        capture_output=True, text=True, cwd=str(ROOT), timeout=300,
    )
    # 结果要去 **stderr** 读: qwen_worker 在启动时把 sys.stdout 重定向到
    # sys.stderr(见其文件里 BIGHEAD_QWEN_AS_LIBRARY 那段), 那是协议通道保护,
    # 诊断脚本 import 本模块时同样生效。读 stdout 只会拿到空串。
    # 另外只认纯 True/False 行, torch/transformers 会写 FutureWarning。
    outs = [
        x.strip()
        for x in (r.stdout + r.stderr).splitlines()
        if x.strip() in ("True", "False")
    ]
    check(
        "qwen_worker 四个路径常量与 config 逐一相等(venv-qwen 真实导入)",
        outs == ["True", "True", "True", "True"],
        f"got={outs} rc={r.returncode}",
    )
else:
    check("qwen_worker 四个路径常量与 config 逐一相等(venv-qwen 真实导入)", False, ".venv-qwen 不存在, 跳过")

# ---------- §3 MODEL_BASE 支持环境变量覆盖 ----------
code = (
    "import os, sys;"
    "os.environ['BIGHEAD_MODEL_BASE'] = r'D:\\fake\\models';"
    "sys.path.insert(0, r'%s');"
    "from backend.config import MODEL_BASE;"
    "print(MODEL_BASE)" % ROOT
)
r = subprocess.run(
    [sys.executable, "-c", code], capture_output=True, text=True, cwd=str(ROOT), timeout=300
)
check(
    "BIGHEAD_MODEL_BASE 可覆盖 MODEL_BASE",
    r.stdout.strip().endswith("D:\\fake\\models"),
    f"got={r.stdout.strip()!r} err={r.stderr.strip()[-160:]}",
)

# 不设环境变量时必须仍是默认 webui 路径 —— 覆盖能力不能把默认值改掉。
r2 = subprocess.run(
    [sys.executable, "-c",
     "import sys; sys.path.insert(0, r'%s'); from backend.config import MODEL_BASE; print(MODEL_BASE)" % ROOT],
    capture_output=True, text=True, cwd=str(ROOT), timeout=300,
)
check("未设环境变量时默认路径不变", WEBUI_LITERAL in r2.stdout, r2.stdout.strip())

# ---------- §4 preflight 的正则解析仍有效(隐藏耦合) ----------
from backend.preflight import _suggest_interpreter  # noqa: E402

suggested = _suggest_interpreter()
check(
    "preflight._suggest_interpreter 仍能推出 webui .venv 解释器",
    bool(suggested) and Path(suggested).name == "python.exe" and Path(suggested).exists(),
    str(suggested),
)

# ---------- §5 三个子路径仍由 MODEL_BASE 派生(单一来源的实质) ----------
from backend import config as cfg  # noqa: E402

check("QWEN_MODEL_DIR 派生自 MODEL_BASE", str(cfg.QWEN_MODEL_DIR).startswith(str(cfg.MODEL_BASE)))
check("INSIGHTFACE_ROOT 派生自 MODEL_BASE", str(cfg.INSIGHTFACE_ROOT).startswith(str(cfg.MODEL_BASE)))
check("SDXL_CKPT 派生自 MODEL_BASE", str(cfg.SDXL_CKPT).startswith(str(cfg.MODEL_BASE)))

# ---------- §6 pipeline 的 sd_xl_base.yaml 来自 config ----------
pipe_src = (BACKEND / "pipeline.py").read_text(encoding="utf-8")
check("pipeline.py 不再硬编码 sd_xl_base.yaml 路径", WEBUI_LITERAL not in pipe_src)
check("pipeline.py 从 config 取 webui 根", "WEBUI_ROOT" in pipe_src)

# ---------- §7 回归: 覆盖行为在 worker 侧也成立 ----------
# worker 是独立进程, 必须靠继承环境变量拿到覆盖值, 不能自己再读一次默认值。
with tempfile.TemporaryDirectory() as td:
    marker = Path(td) / "models"
    env = dict(os.environ, BIGHEAD_MODEL_BASE=str(marker), PYTHONPATH=str(ROOT))
    code = (
        "import os, sys; sys.path.insert(0, r'%s');"
        "import backend.qwen_worker as w;"
        "print(w.QWEN)" % ROOT
    )
    r = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True,
        cwd=str(ROOT), env=env, timeout=300,
    )
    # 同上: 结果在 stderr。匹配 `\qwen` 结尾而不是 `models` —— worker 暴露的
    # 常量是 QWEN_MODEL_DIR(…/models/qwen), 拿 …/models 去匹配会漏掉最后一节。
    got = [
        x.strip()
        for x in (r.stdout + r.stderr).splitlines()
        if x.strip().endswith("qwen")
    ]
    check(
        "worker 进程继承 BIGHEAD_MODEL_BASE 后路径随之改变",
        got == [str(marker / "qwen")],
        f"got={got}",
    )

# ---------- 汇总 ----------
print()
print(f"Result: {len(PASS)} passed, {len(FAIL)} failed")
for f in FAIL:
    print(f"  [FAIL] {f}")
print("ALL GREEN" if not FAIL else "HAS FAILURES")
sys.exit(0 if not FAIL else 1)
