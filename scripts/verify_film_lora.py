"""端到端验证:SDXL 生产路线 + SDXL 胶片 LoRA。

走真实生产入口 backend.pipeline.BigHeadPipeline.generate_one,
而不是脚本手搓的组装逻辑 —— 手搓路径此前多次出现"脚本正常、
生产异常"的偏差。

fuse_lora 不可逆,且 8GB 预算装不下两套 SDXL,因此 on/off 对照用
子进程各自独立加载(--child 模式),父进程只做调度与度量。
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend" / "vendor"))

SEED = 20240517
OUT = ROOT / "outputs" / "_verify" / "sdxlfilm"
OUT.mkdir(parents=True, exist_ok=True)
STYLE_KEY = "PORTRAIT_HK"
PY = r"E:\Code\stable-diffusion-webui\.venv\Scripts\python.exe"


def face_input():
    from PIL import Image

    from backend.face import extract_face

    src = sorted((ROOT / "outputs" / "4f6963daf4d5").glob("photo_*.jpg"))[0]
    pil = Image.open(src).convert("RGB")
    fr = extract_face(pil)
    if fr.no_face:
        return pil, None
    return fr.face_pil, fr.embedding


def child(lora_flag: str) -> None:
    import gc
    import os

    import torch

    import backend.config as cfg

    face_pil, emb = face_input()
    os.environ["BIGHEAD_LORA"] = lora_flag

    from backend.pipeline import BigHeadPipeline

    p = BigHeadPipeline()
    p._ensure_loaded("sdxl")
    print(f"RESULT lora_active={p.lora_active}")
    print(f"RESULT peft={getattr(p.pipe.unet, '_hf_peft_config_loaded', None)}")
    print(f"RESULT lora={(p._style_lora_for('sdxl') or Path('None')).name}")
    torch.cuda.reset_peak_memory_stats()
    img = p.generate_one(face_pil, cfg.STYLES[STYLE_KEY], backbone="sdxl",
                         faceid_embeds=emb, seed=SEED)
    tag = "lora_on" if lora_flag == "1" else "lora_off"
    out = OUT / f"{tag}_{SEED}.jpg"
    img.save(out, quality=95)
    print(f"RESULT vram={torch.cuda.max_memory_allocated() / 1e9:.2f}")
    print(f"RESULT saved={out.name}")
    del p
    gc.collect()
    torch.cuda.empty_cache()


def identity(a_path: Path, b_path: Path) -> float:
    import numpy as np
    from PIL import Image

    from backend.face import _get_app

    app = _get_app()

    def emb(p):
        f = app.get(np.array(Image.open(p).convert("RGB")))
        if not f:
            return None
        f = max(f, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]))
        return f.normed_embedding.reshape(-1)

    ea, eb = emb(a_path), emb(b_path)
    if ea is None or eb is None:
        return -1.0
    return float(np.dot(ea, eb) / (np.linalg.norm(ea) * np.linalg.norm(eb)))


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--child":
        child(sys.argv[2])
        return

    import numpy as np
    from PIL import Image

    import backend.config as cfg

    print(f"  style = {STYLE_KEY} / {cfg.STYLES[STYLE_KEY]['name']}")
    print(f"  seed  = {SEED}  steps={cfg.SDXL_STEPS}  size={cfg.SDXL_SIZE}")
    print(f"  LoRA  = {cfg.SDXL_FILM_LORA.name}  exists={cfg.SDXL_FILM_LORA.exists()}\n")

    ok = True
    for flag in ("0", "1"):
        print(f"  --- BIGHEAD_LORA={flag} ---")
        r = subprocess.run([PY, str(Path(__file__)), "--child", flag],
                           capture_output=True, text=True, cwd=str(ROOT))
        for line in r.stdout.splitlines():
            if line.startswith("RESULT"):
                print("   ", line[7:].strip())
        if r.returncode != 0:
            ok = False
            err = [x for x in r.stderr.splitlines() if x.strip()]
            print(f"    子进程失败 rc={r.returncode}: {err[-1] if err else ''}")

    off, on = OUT / f"lora_off_{SEED}.jpg", OUT / f"lora_on_{SEED}.jpg"
    if off.exists() and on.exists():
        a = np.array(Image.open(off).convert("RGB")).astype(np.float32)
        b = np.array(Image.open(on).convert("RGB")).astype(np.float32)
        mae = float(np.abs(a - b).mean())
        print(f"\n  LoRA 开关像素 MAE = {mae:.2f}   (>5 = 权重确实生效)")
        src = sorted((ROOT / "outputs" / "4f6963daf4d5").glob("photo_*.jpg"))[0]
        for tag, pth in (("lora_off", off), ("lora_on", on)):
            print(f"  {tag:9s} 身份 cosine = {identity(src, pth):.4f}")
        if mae <= 5:
            print("  !! LoRA 未产生可观测影响")
            ok = False
    else:
        ok = False
    print(f"\n  显存预算 = {cfg.VRAM_BUDGET_GB} GB")
    print(f"  结果: {'PASS' if ok else 'FAIL'}")
    print("=" * 74)


if __name__ == "__main__":
    main()
