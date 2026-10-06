"""启动自检: 在服务启动时暴露「解释器不对」这类问题。

背景
----
本项目复用 Stable Diffusion WebUI 的 .venv(diffusers 0.34 / transformers 4.37.2
/ insightface / onnxruntime),README 里也写明了启动命令要用那个解释器。

但只要用错解释器(比如直接 `python -m uvicorn`, 命中 conda 的 base 环境),
**服务能正常启动、连拍与拼图都可用**, 因为那些路径只用 PIL/OpenCV。
只有走到 AI 写真才会炸, 表现为界面上「全部 4 张生成失败: No module named
'insightface'」—— 用户已经拍完照、选完风格才看到, 排查成本很高。

这里把依赖检查提前到启动阶段: 缺依赖就在日志里明确报出来, 并指出应该用
哪个解释器。
"""
from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path

log = logging.getLogger(__name__)

# (import 名, 用途) —— 都是 AI 写真链路上的硬依赖。
# 前几个同时也是「本该跑在 webui venv」的判据。
_AI_DEPS = [
    ("insightface", "人脸检测与 FaceID 嵌入"),
    ("onnxruntime", "insightface 的推理后端"),
    ("torch", "张量与 CUDA"),
    ("diffusers", "SDXL 管线"),
    ("transformers", "文本编码器"),
    ("peft", "LoRA 注入"),
    ("fastapi", "Web 框架"),
    ("uvicorn", "ASGI 服务器"),
]


def missing_ai_deps() -> list[tuple[str, str]]:
    """返回 (import 名, 用途) 中当前解释器无法导入的项。"""
    missing = []
    for name, purpose in _AI_DEPS:
        try:
            if importlib.util.find_spec(name) is None:
                missing.append((name, purpose))
        except (ImportError, ValueError):
            # find_spec 对残缺包(如 __init__ 报错)也会抛, 同样视为不可用
            missing.append((name, purpose))
    return missing


def _suggest_interpreter() -> str | None:
    """按 README 里的约定猜一个可用的解释器路径。

    这里刻意**不** import config: 本模块的职责就是在依赖出问题时
    还能跑起来, 而 config 会做一串 import 副作用(peft 补丁、HF 缓存目录
    创建), 那些正是可能出错的部分。

    代价是要用正则读 config.py 源码。MODEL_BASE 现在是
    `Path(os.environ.get("BIGHEAD_MODEL_BASE", r"E:\\Code\\...\\models"))`,
    正则必须同时吃下「字面默认值」和「环境变量名」两种形态 ——
    早先只认 `Path(r"...")` 那种写法, 改成环境变量后这里静默返回 None,
    「用错解释器」时就不再提示该用哪个解释器了。
    """
    cfg = Path(__file__).resolve().parent / "config.py"
    try:
        text = cfg.read_text(encoding="utf-8")
    except OSError:
        return None
    import re

    # 从 MODEL_BASE 的赋值处起, 取一个有界窗口, 窗口内找第一个 r"..." 字面量。
    #
    # 不要写成 `MODEL_BASE\s*=(.*?)\n\s*\w`: 非贪婪 + DOTALL 会在**第一个**
    # 换行处就满足, 实际只抓到 ` Path(` 就断了(值在下一行), 静默返回 None。
    # 有界窗口对代码怎么换行、对齐、加注释都免疫 —— 只要默认值字面量还在
    # 这条语句附近就能读到。
    m = re.search(r'MODEL_BASE\s*=', text)
    if not m:
        return None
    window = text[m.end():m.end() + 500]
    lit = re.search(r'r"([^"]+)"', window)
    if not lit:
        return None
    webui = Path(lit.group(1)).parent
    exe = webui / ".venv" / "Scripts" / "python.exe"
    return str(exe) if exe.exists() else None


def report() -> bool:
    """打印自检结果。返回 True 表示 AI 依赖齐全。"""
    missing = missing_ai_deps()
    exe = sys.executable
    print("=" * 60)
    print("  运行环境自检")
    print("=" * 60)
    print(f"  Python: {exe}")
    print(f"  版本:   {sys.version.split()[0]}")

    if not missing:
        print("  AI 依赖: 全部就绪")
        print("=" * 60)
        return True

    print(f"  AI 依赖: 缺 {len(missing)} 项 —— AI 写真将无法使用")
    for name, purpose in missing:
        print(f"    - {name:<14} {purpose}")
    guess = _suggest_interpreter()
    if guess:
        print("")
        print("  本项目复用 Stable Diffusion WebUI 的 venv, 请用该解释器启动:")
        print(f"    {guess} -m uvicorn backend.app:app --port 8077")
    else:
        print("")
        print("  找不到 webui venv, 请确认启动命令用的是正确的解释器(见 README)。")
    print("  另注: peft 需先经 backend.peft_compat.ensure_peft() 打补丁才能 import,")
    print("        直接 import peft 会报 EncoderDecoderCache 缺失, 属正常现象。")
    print("  完整规则见 .trae/rules/project_rules.md")
    print("=" * 60)
    return False
