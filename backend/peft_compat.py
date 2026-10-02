"""PEFT 兼容层:让 PEFT 能在旧版 transformers(4.37.2)上工作.

背景
----
本项目复用 Stable Diffusion WebUI 的 venv,其中 transformers 固定为 4.37.2,
而 diffusers 0.34 要求 peft>=0.15.0;peft 0.15 又依赖 transformers 4.38 才引入的
`EncoderDecoderCache`。三者形成死锁:

    diffusers 0.34  ->  peft >= 0.15  ->  transformers >= 4.38  ->  (装不了)

而 `EncoderDecoderCache` 只用于 encoder-decoder 模型的 KV cache(Seq2Seq/Whisper 等),
diffusers 的 SDXL 路径根本不会走到这里。所以这里在 import peft 之前,
往 transformers 命名空间注入一个最小的占位实现,让它能完成导入。

用法:必须在 import peft / diffusers 之前调用

    from backend.peft_compat import ensure_peft
    ensure_peft()
    import peft
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

log = logging.getLogger(__name__)

# 项目内的第三方库目录(PEFT 用 --no-deps 装在这里,不污染 webui 的 venv)
PYLIBS = Path(__file__).resolve().parent.parent / ".pylibs"


def _patch_accelerate() -> bool:
    """给旧版 accelerate(0.21)补上 clear_device_cache 别名.

    peft 0.15 从 accelerate.utils.memory 导入 clear_device_cache,
    该名字在 accelerate 0.21 里叫 release_memory。
    """
    try:
        import accelerate.utils.memory as m
    except Exception as e:  # pragma: no cover
        log.warning("accelerate import failed: %s", e)
        return True  # accelerate 缺失不一定是致命的

    if not hasattr(m, "clear_device_cache"):
        if hasattr(m, "release_memory"):
            m.clear_device_cache = m.release_memory
            log.info("patched accelerate.utils.memory.clear_device_cache -> release_memory")
        else:
            # 兜底:accelerate 21 以前只有 clear_memory
            def clear_device_cache(*args, **kwargs):  # type: ignore[no-untyped-def]
                m.clear_memory(*args, **kwargs) if hasattr(m, "clear_memory") else None

            m.clear_device_cache = clear_device_cache
            log.info("patched accelerate.utils.memory.clear_device_cache (fallback)")
    return True


def _patch_transformers() -> bool:
    """给旧版 transformers 补上 EncoderDecoderCache 占位类.返回是否已可用."""
    try:
        import transformers
    except Exception as e:  # pragma: no cover
        log.warning("transformers import failed: %s", e)
        return False

    if hasattr(transformers, "EncoderDecoderCache"):
        return True

    from transformers.cache_utils import Cache, DynamicCache

    class EncoderDecoderCache:  # noqa: D401 - 仅为通过 import 检查
        """Encoder-Decoder 模型的 KV cache 占位实现.

        PEFT 在 import 期引用本类,但 diffusers 的 SDXL 路径不会使用它。
        这里提供最小可用行为:委托给内部 DynamicCache,避免 NotImplementedError。
        """

        def __init__(self, encoder_cache=None, decoder_cache=None, **kwargs):
            self.encoder_cache = encoder_cache if encoder_cache is not None else DynamicCache()
            self.decoder_cache = decoder_cache if decoder_cache is not None else DynamicCache()
            self.self_attention_cache = getattr(self.encoder_cache, "self_attention_cache", None)
            self.cross_attention_cache = getattr(self.decoder_cache, "cross_attention_cache", None)

        def __getitem__(self, idx):
            return (self.encoder_cache[idx], self.decoder_cache[idx])

        def __setitem__(self, idx, value):
            if not isinstance(value, tuple) or len(value) != 2:
                raise ValueError("EncoderDecoderCache only supports tuple of (self, cross) caches")
            self.encoder_cache[idx], self.decoder_cache[idx] = value

        def __len__(self):
            return len(self.decoder_cache)

        def __iter__(self):
            yield self.encoder_cache
            yield self.decoder_cache

        def update(self, *args, **kwargs):
            return self.decoder_cache.update(*args, **kwargs)

        def get_seq_length(self, layer_idx=0):
            return self.decoder_cache.get_seq_length(layer_idx)

    transformers.EncoderDecoderCache = EncoderDecoderCache
    try:
        import transformers.cache_utils as cu

        if not hasattr(cu, "EncoderDecoderCache"):
            cu.EncoderDecoderCache = EncoderDecoderCache
    except Exception:
        pass

    log.info("patched transformers.EncoderDecoderCache (placeholder)")
    return True


def ensure_peft() -> bool:
    """确保 peft 可导入且与当前 transformers/accelerate 兼容.返回是否可用."""
    if str(PYLIBS) not in sys.path:
        sys.path.insert(0, str(PYLIBS))

    _patch_accelerate()
    if not _patch_transformers():
        return False

    try:
        import peft
    except Exception as e:  # pragma: no cover
        log.warning("peft import failed after patch: %s", e)
        return False

    # peft import 过程中可能又触发了新的懒加载,再补一次
    _patch_accelerate()
    _patch_transformers()
    return True


def peft_info() -> dict:
    """返回 PEFT / diffusers 状态,用于诊断。"""
    info: dict = {"pylibs": str(PYLIBS), "peft": None, "use_peft_backend": None,
                 "transformers": None, "patched": False}
    try:
        import transformers

        info["transformers"] = transformers.__version__
        info["patched"] = hasattr(transformers, "EncoderDecoderCache")
    except Exception as e:
        info["error"] = repr(e)
        return info
    if not ensure_peft():
        return info
    try:
        import peft

        info["peft"] = peft.__version__
    except Exception as e:
        info["error"] = repr(e)
        return info
    try:
        from diffusers.loaders.peft import USE_PEFT_BACKEND

        info["use_peft_backend"] = USE_PEFT_BACKEND
    except Exception as e:
        info["error"] = repr(e)
    return info
