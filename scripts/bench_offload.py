"""对比 cpu_offload 与全量驻留的速度/显存,回答"用满显存能不能更快"。

用户观察到:任务管理器里 GPU 3D 只有 18% 利用率、专用显存 5.2/16GB,
且显存曲线呈剧烈锯齿。假设:
  锯齿     = enable_model_cpu_offload 的 hook 在每个模块 forward 前后
             把权重搬出/搬回 GPU,分配器反复申请释放。
  低利用率 = GPU 大部分时间在等 PCIe 传输,不是算力饱和。
             所以"用满剩余显存"应该确实更快。

A/B 放在两个独立子进程里跑 —— 同一进程内先建 offload 管线再建
常驻管线会残留显存与 hook,测出来的数据不可信。

用法:
  python scripts/bench_offload.py offload
  python scripts/bench_offload.py resident
  python scripts/bench_offload.py      # 依次跑两组并汇总
"""
from __future__ import annotations

import gc
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend" / "vendor"))

import backend.config as cfg  # noqa: E402

import numpy as np  # noqa: E402
import torch  # noqa: E402

SEED = 20240517
OUT = ROOT / "outputs" / "_verify" / "speed"
OUT.mkdir(parents=True, exist_ok=True)
PY = sys.executable


def nvidia_mb() -> float:
    import subprocess as sp

    r = sp.run(["nvidia-smi", "--query-gpu=memory.used",
                "--format=csv,noheader,nounits"],
               capture_output=True, text=True, check=False)
    try:
        return float(r.stdout.strip().splitlines()[0])
    except Exception:
        return -1.0


def run_one(mode: str) -> dict:
    """在当前子进程里跑一种模式,返回指标。"""
    if mode == "resident":
        os.environ["BIGHEAD_NO_OFFLOAD"] = "1"
    else:
        os.environ.pop("BIGHEAD_NO_OFFLOAD", None)

    from backend.face import extract_face
    from backend.pipeline import BigHeadPipeline
    from PIL import Image

    src = sorted((ROOT / "outputs" / "4f6963daf4d5").glob("photo_*.jpg"))[0]
    fr = extract_face(Image.open(src).convert("RGB"))
    style = cfg.STYLES["PORTRAIT_HK"]

    p = BigHeadPipeline()
    p._ensure_loaded("sdxl")
    has_hooks = getattr(p.pipe, "_all_hooks", None) is not None
    resident = p._gpu_resident()

    # 预热(排除 CUDA 初始化与 cudnn autotune)
    p.generate_one(fr.face_pil, style, backbone="sdxl",
                   faceid_embeds=fr.embedding, seed=SEED)
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()

    n = 3
    t0 = time.time()
    img = None
    for _ in range(n):
        img = p.generate_one(fr.face_pil, style, backbone="sdxl",
                             faceid_embeds=fr.embedding, seed=SEED)
    dt = (time.time() - t0) / n
    peak = torch.cuda.max_memory_allocated() / 1e9
    a = np.array(img.convert("RGB")).astype(np.float32)
    img.save(OUT / f"{mode}_{SEED}.jpg", quality=95)

    return {
        "mode": mode,
        "hooks": has_hooks,
        "gpu_resident": resident,
        "sec_per_image": round(dt, 2),
        "peak_gb": round(peak, 2),
        "nvidia_mb": round(nvidia_mb()),
        "sig": [round(float(x), 3) for x in a[::97, ::97].ravel()[:64]],
    }


def main() -> None:
    modes = sys.argv[1:] or ["offload", "resident"]
    total = torch.cuda.get_device_properties(0).total_memory / 1e9
    print(f"  GPU 总显存 = {total:.1f} GB   预算 = {cfg.VRAM_BUDGET_GB} GB")
    print(f"  steps={cfg.SDXL_STEPS}  size={cfg.SDXL_SIZE}  seed={SEED}")
    print(f"  摄像头原图 1280x720(宽>高)  输出 {cfg.SDXL_SIZE[0]}x{cfg.SDXL_SIZE[1]}"
          f"(高>宽)  <- 排版留白的根因\n")

    results = []
    for m in modes:
        print(f"  --- {m} ---")
        # 子进程隔离:同进程内两种模式会互相污染显存与 hook
        code = (
            "import sys; sys.argv=['x'];"
            f"sys.path.insert(0, {str(ROOT)!r});"
            f"sys.path.insert(0, {str(ROOT / 'backend' / 'vendor')!r});"
            f"import importlib.util as u;"
            f"spec=u.spec_from_file_location('bench', {__file__!r});"
            "mod=u.module_from_spec(spec); spec.loader.exec_module(mod);"
            f"import json; print('@@'+json.dumps(mod.run_one({m!r})))"
        )
        env = dict(os.environ)
        if m == "resident":
            env["BIGHEAD_NO_OFFLOAD"] = "1"
        r = subprocess.run([PY, "-c", code], capture_output=True, text=True,
                           env=env, cwd=str(ROOT))
        line = [x for x in r.stdout.splitlines() if x.startswith("@@")]
        if not line:
            err = [x for x in (r.stderr or "").splitlines()
                   if "Error" in x or "error" in x or "CUDA" in x or "memory" in x]
            print(f"    子进程失败: {err[-3:] if err else r.stderr[-300:]}")
            continue
        d = json.loads(line[0][2:])
        results.append(d)
        print(f"    offload_hooks={d['hooks']}  gpu_resident={d['gpu_resident']}")
        print(f"    {d['sec_per_image']:6.2f}s/张  torch峰值={d['peak_gb']:5.2f}GB  "
              f"nvidia={d['nvidia_mb']}MB")
        gc.collect()
        torch.cuda.empty_cache()

    if len(results) == 2:
        a, b = results
        print(f"\n  对比:")
        print(f"    {'':<10}{'耗时/张':>10}{'torch峰值':>12}{'nvidia':>10}")
        print(f"    {'offload':<10}{a['sec_per_image']:>9.2f}s"
              f"{a['peak_gb']:>11.2f}GB{a['nvidia_mb']:>9}MB")
        print(f"    {'常驻':<10}{b['sec_per_image']:>9.2f}s"
              f"{b['peak_gb']:>11.2f}GB{b['nvidia_mb']:>9}MB")
        print(f"\n    提速 = {a['sec_per_image'] / max(b['sec_per_image'], 1e-6):.2f}x")
        print(f"    显存代价 = {b['peak_gb'] - a['peak_gb']:+.2f}GB")
        same = np.abs(np.array(a["sig"]) - np.array(b["sig"])).mean()
        print(f"    输出差异 MAE = {same:.2f} "
              f"({'一致,仅搬运方式不同' if same < 1.0 else '差异明显,需核对'})")
        print(f"\n    4 张连拍: offload {a['sec_per_image'] * 4:.0f}s "
              f"vs 常驻 {b['sec_per_image'] * 4:.0f}s")
    print("=" * 74)


if __name__ == "__main__":
    main()
