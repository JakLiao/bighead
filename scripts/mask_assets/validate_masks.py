"""
位图蒙版素材校验。

对应 SPEC.md 的硬性要求,逐条检查:
  1. manifest.json 存在且可解析
  2. 每条记录字段完整(key/name/src/audience/category/tags)
  3. key 不与内置代码蒙版重复,图库内部也不重复
  4. src 指向的 PNG 存在,是 RGBA(带 alpha 通道)
  5. 画布为 4:3
  6. 透明区(人脸窗口)占比在 8%~70% 之间 —— 太小看不见,太大就成相框了
  7. 四周边缘完全不透明(否则蒙版盖不住画面边界,会露背景)

用法:
    python scripts/mask_assets/validate_masks.py
退出码 0 = 全部通过,1 = 有失败项。
"""
import json
import re
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
MASK_DIR = ROOT / "frontend" / "public" / "masks"
MANIFEST = MASK_DIR / "manifest.json"

# 内置代码蒙版的 key,来自 frontend/src/components/masks/maskDefs.ts。
# 这里内联一份而不是去解析 TS,是为了让本脚本无依赖、可独立运行。
BUILTIN_KEYS = {
    "heart", "star", "flower", "cat", "bear", "cloud", "blob", "burst", "ticket",
    "dual_circle", "dual_heart", "dual_star", "dual_bubble", "dual_blob", "dual_rounded",
}

REQUIRED = ("key", "name", "src", "audience", "category", "tags")
AUDIENCES = {"single", "dual"}

# 透明区占比的合理区间
CLEAR_MIN, CLEAR_MAX = 0.08, 0.70

# 边缘检查的厚度(像素),取 2px 足够
EDGE = 2

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  {detail}" if detail else ""))


def hex_to_rgb(value):
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})", value or "")
    if not m:
        return None
    v = m.group(1)
    return tuple(int(v[i:i + 2], 16) for i in (0, 2, 4))


def check_edge_opaque(alpha, w, h):
    """四边最外 EDGE 像素必须完全不透明,否则蒙版盖不住画面边缘。

    PIL 的 Image 不支持切片,必须用 crop 取子图。
    """
    bands = [
        alpha.crop((0, 0, w, EDGE)),
        alpha.crop((0, h - EDGE, w, h)),
        alpha.crop((0, 0, EDGE, h)),
        alpha.crop((w - EDGE, 0, w, h)),
    ]
    return all(min(b.tobytes()) >= 250 for b in bands)


def main():
    print("--- 1. manifest ---")
    if not MANIFEST.is_file():
        print(f"  [FAIL] 缺少 {MANIFEST.relative_to(ROOT)}")
        print("\n结果: 0 通过, 1 失败")
        return 1
    check("manifest.json 存在", True, str(MANIFEST.relative_to(ROOT)))

    try:
        data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except Exception as exc:
        check("manifest.json 可解析", False, str(exc))
        print(f"\n结果: {len(PASS)} 通过, {len(FAIL)} 失败")
        return 1
    check("manifest.json 可解析", True, f"version={data.get('version')}")

    masks = data.get("masks")
    if not isinstance(masks, list):
        check("masks 是数组", False)
        print(f"\n结果: {len(PASS)} 通过, {len(FAIL)} 失败")
        return 1

    if not masks:
        print("  [WARN] 图库为空 —— 这是合法状态(素材后补),跳过素材检查")
        print(f"\n结果: {len(PASS)} 通过, {len(FAIL)} 失败")
        return 0

    print("\n--- 2. 字段与 key 唯一性 ---")
    seen = set()
    for m in masks:
        key = m.get("key", "<无 key>")
        missing = [f for f in REQUIRED if f not in m]
        check(f"{key} 字段完整", not missing, f"缺 {missing}" if missing else "")
        check(f"{key} audience 合法", m.get("audience") in AUDIENCES, str(m.get("audience")))
        check(f"{key} 不与内置蒙版冲突", key not in BUILTIN_KEYS)
        check(f"{key} 图库内唯一", key not in seen)
        seen.add(key)

    print("\n--- 3. 素材文件 ---")
    for m in masks:
        key = m.get("key", "<无 key>")
        src = m.get("src", "")
        path = MASK_DIR / src
        if not src or not path.is_file():
            check(f"{key} PNG 存在", False, str(path))
            continue
        check(f"{key} PNG 存在", True, f"{path.stat().st_size // 1024}KB")

        with Image.open(path) as im:
            w, h = im.size
            if im.mode != "RGBA":
                check(f"{key} 为 RGBA", False, f"mode={im.mode}")
                continue
            check(f"{key} 为 RGBA", True)
            check(f"{key} 4:3 比例", abs(w / h - 4 / 3) < 0.02, f"{w}x{h}")

            alpha = im.getchannel("A")
            px = alpha.load()
            clear = sum(1 for y in range(0, h, 3) for x in range(0, w, 3) if px[x, y] < 12)
            total = len(range(0, h, 3)) * len(range(0, w, 3))
            ratio = clear / total
            check(
                f"{key} 透明窗口占比合理",
                CLEAR_MIN <= ratio <= CLEAR_MAX,
                f"{ratio:.3f} (期望 {CLEAR_MIN}~{CLEAR_MAX})",
            )

            hist = alpha.histogram()
            check(f"{key} 边缘完全不透明", check_edge_opaque(alpha, w, h), "")
            opaque = hist[255] / (w * h)
            check(f"{key} 存在不透明区域", opaque > 0.15, f"不透明占比={opaque:.3f}")

    print(f"\n结果: {len(PASS)} 通过, {len(FAIL)} 失败")
    if FAIL:
        print("失败项: " + ", ".join(FAIL))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
