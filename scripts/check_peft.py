"""确认 .pylibs 里的 PEFT 能被 diffusers 正常识别,且未破坏 webui 环境."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.peft_compat import ensure_peft, peft_info  # noqa: E402

import backend.config  # noqa: E402,F401

print("=" * 62)
print("  PEFT environment check")
print("=" * 62)

ok = ensure_peft()

import peft  # noqa: E402
import torch  # noqa: E402
import transformers  # noqa: E402

print(f"  peft         {peft.__version__}")
print(f"  peft path    {peft.__file__}")
print(f"  transformers {transformers.__version__}  (webui 原始版本, 期望 4.37.2)")
print(f"  torch        {torch.__version__}")
print(f"  in .pylibs   {'.pylibs' in peft.__file__}")

from diffusers.loaders.peft import USE_PEFT_BACKEND  # noqa: E402

print()
print(f"  USE_PEFT_BACKEND : {USE_PEFT_BACKEND}")
print(f"  EncoderDecoderCache 已补齐 : {hasattr(transformers, 'EncoderDecoderCache')}")

need = ["LoraConfig", "PeftModel", "inject_adapter_in_model", "get_peft_model_state_dict"]
for n in need:
    print(f"  peft.{n:<24}: {hasattr(peft, n)}")

print("\n  " + "-" * 54)
for k, v in peft_info().items():
    print(f"  {k:<20}: {v}")

print("\n" + "=" * 62)
allok = ok and USE_PEFT_BACKEND and all(hasattr(peft, n) for n in need)
print(f"  结果: {'PASS  LoRA 后端可用' if allok else 'FAIL'}")
print("=" * 62)
raise SystemExit(0 if allok else 1)
