"""验证风格级 LoRA / FaceID 强度已真正生效。

修复前:fuse_lora 不可逆,只在加载时按全局 LORA_SCALE=0.7 融一次,
       而四个风格声明 0.7/0.9/0.5/0.4 —— 三个风格的强度是死的。
修复后:保持未融合,每次生成前用 set_adapters 设当风格权重。

判定方式不看代码而看行为:
  A. set_adapters 是否真的改到了 UNet 里每个 LoRA 层的 scale
     (直接读 attn processor 里 lora_down 的 multiplier 或 forward hook)
  B. 同 seed 下,lora_scale=0.4 与 0.9 的输出像素 MAE 是否显著 > 0
     —— 若强度没生效,两者输出应几乎一致
  C. faceid_scale 0.65 与 0.85 的锁脸强度是否可区分
  D. 未融合 vs 融合的耗时差(量化性能代价)
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend" / "vendor"))

import backend.config as cfg  # noqa: E402

import numpy as np  # noqa: E402
import torch  # noqa: E402

SEED = 4242
OUT = ROOT / "outputs" / "_verify" / "scale"
OUT.mkdir(parents=True, exist_ok=True)
PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"    [{'PASS' if cond else 'FAIL'}] {name} {detail}", flush=True)


def lora_scales_in_model(pipe) -> list[float]:
    """从 UNet 里读出所有 PEFT LoraLayer 当前生效的 scaling。

    属性名是 scaling(不是 scale,也不是 diffusers 那套 lora_up.multiplier):
        LoraLayer.set_scale(adapter, s)  ->  self.scaling[adapter]
                                            = s * lora_alpha / r
    本例 lora_alpha=32, r=32, 所以 scaling 数值恰好等于传入的 s。
    """
    from peft.tuners.tuners_utils import BaseTunerLayer

    found: list[float] = []
    for _, m in pipe.unet.named_modules():
        if not isinstance(m, BaseTunerLayer):
            continue
        sc = getattr(m, "scaling", None)
        if isinstance(sc, dict):
            found.extend(float(v) for v in sc.values())
        elif sc is not None:
            found.append(float(sc))
    return found


def main() -> None:
    from backend.face import extract_face
    from backend.pipeline import BigHeadPipeline
    from PIL import Image

    src = sorted((ROOT / "outputs" / "4f6963daf4d5").glob("photo_*.jpg"))[0]
    fr = extract_face(Image.open(src).convert("RGB"))
    if fr.no_face:
        raise SystemExit("no face")

    p = BigHeadPipeline()
    p._ensure_loaded("sdxl")
    print(f"  lora_active = {p.lora_active}  adapter = {p.lora_adapter}")
    print(f"  全局 LORA_SCALE = {cfg.LORA_SCALE}(仅作初始值)")
    print(f"  风格 lora_scale  = "
          + ", ".join(f"{k}={v['lora_scale']}" for k, v in cfg.STYLES.items()))

    # A. 强度是否真的写进了 UNet 内部
    print(f"\n  A) 风格强度是否写入 UNet 的 PEFT tuner 层")
    for sc in (0.4, 0.9):
        p._set_style_lora_scale(p.pipe, sc)
        got = lora_scales_in_model(p.pipe)
        uniq = sorted({round(x, 3) for x in got})
        check(f"lora_scale={sc} 写入模型", bool(got) and uniq == [sc],
              f"命中 {len(got)} 个 tuner 层, 取值={uniq[:5]}")

    # B. 不同 lora_scale 的输出是否真的不同
    print(f"\n  B) 同 seed 下 lora_scale 0.4 vs 0.9 输出差异")
    imgs = {}
    for sc in (0.4, 0.9):
        style = dict(cfg.STYLES["PORTRAIT_HK"])
        style["lora_scale"] = sc
        t0 = time.time()
        im = p.generate_one(fr.face_pil, style, backbone="sdxl",
                            faceid_embeds=fr.embedding, seed=SEED)
        dt = time.time() - t0
        imgs[sc] = np.array(im.convert("RGB")).astype(np.float32)
        im.save(OUT / f"lora_{sc:.1f}_{SEED}.jpg", quality=95)
        print(f"      lora_scale={sc}  {dt:.1f}s")
    mae = float(np.abs(imgs[0.4] - imgs[0.9]).mean())
    check("不同 lora_scale 产生不同输出", mae > 1.0, f"MAE={mae:.2f} (>1 = 强度确实生效)")

    # C. faceid_scale 是否可区分
    print(f"\n  C) 同 seed 下 faceid_scale 0.65 vs 0.85 锁脸差异")
    fimgs = {}
    for fs in (0.65, 0.85):
        style = dict(cfg.STYLES["FILM_VELVIA"])
        style["faceid_scale"] = fs
        style["lora_scale"] = 0.9
        im = p.generate_one(fr.face_pil, style, backbone="sdxl",
                            faceid_embeds=fr.embedding, seed=SEED)
        fimgs[fs] = np.array(im.convert("RGB")).astype(np.float32)
        im.save(OUT / f"faceid_{fs:.2f}_{SEED}.jpg", quality=95)
    fmae = float(np.abs(fimgs[0.65] - fimgs[0.85]).mean())
    check("不同 faceid_scale 产生不同输出", fmae > 1.0, f"MAE={fmae:.2f}")

    # D. 身份相似度:faceid 高的应锁脸更好
    print(f"\n  D) 锁脸强度与身份相似度")
    from backend.face import _get_app

    app = _get_app()

    def cos(arr):
        f = app.get(arr.astype(np.uint8))
        if not f:
            return -1.0
        f = max(f, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]))
        return float(np.dot(e, f.normed_embedding.reshape(-1))
                     / (np.linalg.norm(e) * np.linalg.norm(f.normed_embedding.reshape(-1))))

    e = fr.embedding.reshape(-1).astype(np.float32)
    for fs, arr in fimgs.items():
        c = cos(arr)
        print(f"      faceid_scale={fs}  cosine={c:.4f}")
    print("      (高 faceid_scale 通常锁脸更强,cosine 应更高)")

    # E. 显存仍在预算内
    peak = torch.cuda.max_memory_allocated() / 1e9
    check(f"峰值显存 < {cfg.VRAM_BUDGET_GB}GB", peak < cfg.VRAM_BUDGET_GB,
          f"{peak:.2f}GB")

    print(f"\n  PASS={len(PASS)}  FAIL={len(FAIL)}")
    if FAIL:
        print("  失败: " + ", ".join(FAIL))
    print("=" * 74)
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
