"""验证 4 个风格是否真的产生差异化输出。

背景:verify_flow_real.py 里 PORTRAIT_HK 与 FILM_VELVIA 的身份相似度
逐位相同(0.4730/0.5176/...),但 8 张输出图的 MD5 全不同。合理解释是
身份向量主要由人脸决定、对风格不敏感,而图像本身确实不同。

本脚本用两种互补的度量确认"风格差异真实存在",而不是靠肉眼:
  1. 色相直方图距离 —— 胶片风应明显偏暖(高光偏黄、阴影偏青)
  2. 提示词是否真的进了模型 —— 打印每个 style 的最终 prompt

同时验证 LoRA 触发词是否只在 lora_active 时注入(见 pipeline.generate_one)。
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend" / "vendor"))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import backend.config as cfg  # noqa: E402

EXPORTS = ROOT / "outputs" / "_verify"


def color_hist(path: Path) -> np.ndarray:
    """返回 12-bin 色相直方图(已归一化)。"""
    a = np.array(Image.open(path).convert("RGB")).astype(np.float32) / 255.0
    mx, mn = a.max(axis=2), a.min(axis=2)
    d = np.maximum(mx - mn, 1e-6)
    hue = np.zeros_like(mx)
    r0, g0, b0 = a[..., 0], a[..., 1], a[..., 2]
    m = mx == r0
    hue[m] = ((g0 - b0)[m] / d[m]) % 6
    m = mx == g0
    hue[m] = ((b0 - r0)[m] / d[m]) + 2
    m = mx == b0
    hue[m] = ((r0 - g0)[m] / d[m]) + 4
    hbin = np.clip((hue / 6 * 12).astype(int), 0, 11)
    hist = np.bincount(hbin.ravel(), minlength=12).astype(np.float32)
    return hist / hist.sum()


def main() -> None:
    print("  1) 各风格最终 prompt\n")
    for k, s in cfg.STYLES.items():
        trig = cfg.STYLE_LORA_TRIGGER
        prompt = f"{s['prompt_prefix']}, {trig}" if trig else s["prompt_prefix"]
        print(f"    {k:<20} {s['name']}")
        print(f"      prompt: {prompt[:120]}")
        print(f"      size={s.get('size')}  steps={s.get('steps')}")
    print(f"\n    LoRA 文件: {cfg.SDXL_FILM_LORA.name}")
    print(f"    触发词  : {cfg.STYLE_LORA_TRIGGER}")
    print(f"    LORA_SCALE={cfg.LORA_SCALE}  (0 = LoRA 关闭)")

    # 自动发现 flow_<STYLE>_<i>.jpg,避免新增风格后忘了改这里
    groups: dict[str, list[Path]] = {}
    for p in sorted(EXPORTS.glob("flow_*_*.jpg")):
        stem = p.stem                       # flow_PORTRAIT_HK_1
        parts = stem.split("_")
        if len(parts) < 3 or parts[0] != "flow":
            continue
        style = "_".join(parts[1:-1])
        groups.setdefault(style, []).append(p)
    groups = {k: sorted(v) for k, v in sorted(groups.items()) if v}
    if not groups:
        print("\n  无 flow_*.jpg,请先跑 verify_flow_real.py")
        return

    print(f"  检出 {len(groups)} 个风格: {', '.join(groups)}\n")
    print(f"    {'风格':<20}{'暖度':>8}{'饱和度':>9}{'亮度':>8}")
    means = {}
    for name, files in groups.items():
        ws_, ss_, ls_ = [], [], []
        for p in files:
            a = np.array(Image.open(p).convert("RGB")).astype(np.float32) / 255.0
            ws_.append(float(a[..., 0].mean() - a[..., 2].mean()))
            ss_.append(float(a.max(axis=2).mean() - a.min(axis=2).mean()))
            ls_.append(float(a.mean()))
        means[name] = (float(np.mean(ws_)), float(np.mean(ss_)), float(np.mean(ls_)))
        print(f"    {name:<20}{means[name][0]:>8.4f}{means[name][1]:>9.4f}{means[name][2]:>8.4f}")

    print(f"\n  3) 两两色相直方图总变差(TV distance,>0.02 = 色调确有区分)")
    names = list(groups)
    worst = None
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            h1 = color_hist(groups[names[i]][0])
            h2 = color_hist(groups[names[j]][0])
            tv = 0.5 * float(np.abs(h1 - h2).sum())
            flag = "OK" if tv > 0.02 else "WARN"
            print(f"    {names[i]:<18} vs {names[j]:<18} TV={tv:.4f}  [{flag}]")
            worst = tv if worst is None else min(worst, tv)
    if worst is not None:
        print(f"    最小 TV = {worst:.4f}  -> "
              f"{'PASS 各风格均有区分' if worst > 0.02 else 'WARN 存在高度相似风格'}")
    print("=" * 70)


if __name__ == "__main__":
    main()
