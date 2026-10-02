"""检查 SD1.5 UNet 里 IP-Adapter processor 的真实状态。

为什么不能用 isinstance 判定:ip_adapter_faceid.py 在 Torch2 下把
`LoRAIPAttnProcessor2_0 as LoRAIPAttnProcessor` 做了模块级别名,而
attention_processor_faceid 里原始旧类依然存在。任何直接 import 旧类的
isinstance 检查都会恒为 False(假阴性),此前"0/32"的结论就是这么来的。

这里改用结构特征判定:IP processor 独有 to_k_ip / to_v_ip 两个 Linear。
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend" / "vendor"))

import backend.config  # noqa: E402

import torch  # noqa: E402
from diffusers import StableDiffusionPipeline  # noqa: E402


def is_ip_processor(p) -> bool:
    """结构判定,不依赖类名/别名。"""
    return hasattr(p, "to_k_ip") and hasattr(p, "to_v_ip")


def survey(unet, tag: str) -> None:
    procs = unet.attn_processors
    ip_names = [n for n, p in procs.items() if is_ip_processor(p)]
    self_names = [n for n, p in procs.items() if not is_ip_processor(p)]
    print(f"\n[{tag}] total={len(procs)}  ip={len(ip_names)}  self_attn={len(self_names)}")
    by_cls: dict[str, int] = {}
    for p in procs.values():
        by_cls[type(p).__name__] = by_cls.get(type(p).__name__, 0) + 1
    for k, v in sorted(by_cls.items()):
        print(f"    class {k}: {v}")

    # 关键:to_k_ip 权重是否非零。非零才说明 ip_adapter 权重真的灌进去了,
    # 零值意味着 load_state_dict 静默失败(实际不会抛异常,因为是 strict=False 路径)。
    nz = 0
    norms = []
    for n in ip_names:
        w = procs[n].to_k_ip.weight
        s = float(w.detach().float().norm())
        norms.append(s)
        if s > 1e-6:
            nz += 1
    if norms:
        norms.sort()
        print(
            f"    to_k_ip 非零: {nz}/{len(ip_names)}  "
            f"norm min={norms[0]:.4f} med={norms[len(norms)//2]:.4f} max={norms[-1]:.4f}"
        )
        print(f"    scale 值: {sorted({float(procs[n].scale) for n in ip_names})}")
    # 采样几个代表名字,确认 attn2 (cross-attn) 才挂 IP
    for n in ip_names[:2]:
        print(f"    e.g. IP  @ {n}")
    for n in self_names[:2]:
        print(f"    e.g. SELF @ {n}")


def main() -> None:
    p = StableDiffusionPipeline.from_single_file(
        str(backend.config.SD15_CKPT),
        torch_dtype=torch.float16,
        use_safetensors=True,
        safety_checker=None,
        local_files_only=True,
        config="stable-diffusion-v1-5/stable-diffusion-v1-5",
    )
    p.enable_vae_tiling()
    p.to("cuda")
    survey(p.unet, "before IPAdapterFaceIDPlus")

    from ip_adapter import IPAdapterFaceIDPlus  # noqa: E402

    ip = IPAdapterFaceIDPlus(
        sd_pipe=p,
        image_encoder_path=str(backend.config.CLIP_VISION_H),
        ip_ckpt=str(backend.config.IPADAPTER_FACEID_SD15),
        device="cuda",
    )
    survey(p.unet, "after IPAdapterFaceIDPlus")

    print("\n--- set_scale 生效验证 ---")
    for target in (0.0, 0.7, 1.5):
        ip.set_scale(target)
        got = sorted({float(v.scale) for v in p.unet.attn_processors.values() if is_ip_processor(v)})
        print(f"  set_scale({target}) -> processors report {got}")
    ip.set_scale(backend.config.FACEID_SCALE)
    print(f"  restored to FACEID_SCALE={backend.config.FACEID_SCALE}")

    print(f"\n  vram = {torch.cuda.memory_allocated() / 1e9:.2f} GB")
    print("=" * 70)


if __name__ == "__main__":
    main()
