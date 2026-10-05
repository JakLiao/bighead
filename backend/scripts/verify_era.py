"""古早画质预设 era 的验证脚本.

为什么是裸 assert 而不是 pytest:
共享的 webui venv 里没有装 pytest(装它会牵动 transformers/diffusers 的
版本死锁, 见 .trae/rules/project_rules.md),所以本项目一律用「裸 assert +
退出码」的脚本, 见 scripts/ 与本目录下的 verify_*.py。

跑法(必须用 webui 解释器,不能用裸 python):
    & "E:\\Code\\stable-diffusion-webui\\.venv\\Scripts\\python.exe" backend/scripts/verify_era.py

覆盖四层:
  1. 纯函数: modern 严格恒等 / vintage_2000 通道可度量退化
  2. 组合层: preset 与 era 可叠加且互不干扰
  3. 路由层: /api/preview/filter 的 era 校验与生效;
             /api/capture/save **原样落盘**(不再接受 era, 见该路由 docstring)
  4. 契约层: ERA_OPS 与 ERA_PRESETS 的 key 一致 / /api/meta 与后端一致
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from backend.config import ERA_DEFAULT, ERA_KEYS, ERA_PRESETS  # noqa: E402
from backend.filters import (  # noqa: E402
    ERA_OPS,
    _era_modern_pixels,
    _era_vintage_2000_pixels,
    apply_filter,
)

PASS: list[str] = []

# 算子的可调参数统一从 config 读, 脚本不自己造一份 —— 否则改 config 的参数
# 后脚本仍在验证旧数值, 会出现"实现已改、断言还在测老行为"的假绿。
VINTAGE = ERA_PRESETS["vintage_2000"]["params"]


def check(name: str, cond: bool, detail: str = "") -> None:
    """断言并记录。失败即抛 AssertionError, 由 __main__ 捕获后给退出码。"""
    assert cond, f"FAILED: {name} {detail}"
    PASS.append(name)
    print(f"  [PASS] {name} {detail}")


def _blank_bgr(h: int = 480, w: int = 640) -> np.ndarray:
    return np.full((h, w, 3), 128, dtype=np.uint8)


def _gray_pil(h: int = 480, w: int = 640) -> Image.Image:
    return Image.fromarray(np.full((h, w, 3), 128, dtype=np.uint8), "RGB")


def _jpeg_bytes(pil: Image.Image) -> bytes:
    buf = io.BytesIO()
    pil.save(buf, format="JPEG", quality=95)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# 1. 纯函数层
# ---------------------------------------------------------------------------
def test_pure_ops() -> None:
    print("\n[1] 纯函数层")
    bgr = _blank_bgr()

    # modern 必须严格恒等: 同一个对象, 不是一个内容相同的副本
    out = _era_modern_pixels(bgr, ERA_PRESETS["modern"]["params"])
    check("modern 是恒等函数(返回同一对象)", out is bgr)
    check("modern 不改动任何像素", np.array_equal(out, bgr))

    out = _era_vintage_2000_pixels(bgr, VINTAGE)
    check("vintage_2000 保持形状", out.shape == bgr.shape, f"{out.shape}")
    check("vintage_2000 保持 dtype", out.dtype == np.uint8, f"{out.dtype}")
    check("vintage_2000 不是恒等(真的改了像素)", not np.array_equal(out, bgr))

    # 顶部 1/4 暖色漏光: R 抬得比 G 多, 且 B 不动
    top = out[: out.shape[0] // 4].reshape(-1, 3).mean(axis=0)
    bottom = out[-(out.shape[0] // 4) :].reshape(-1, 3).mean(axis=0)
    check(
        "顶部 R 明显高于 B(暖色漏光)",
        top[2] - top[0] > 20,
        f"topR-B={top[2] - top[0]:.1f}",
    )
    check(
        "顶部 R 比底部 R 明显更亮",
        top[2] - bottom[2] > 20,
        f"topR={top[2]:.1f} bottomR={bottom[2]:.1f}",
    )
    check(
        "漏光下 R 的涨幅大于 G(R+G 才是暖黄, 只抬 R 会发红)",
        (top[2] - bottom[2]) > (top[1] - bottom[1]) > 0,
        f"dR={top[2] - bottom[2]:.1f} dG={top[1] - bottom[1]:.1f}",
    )

    # 漏光必须是**渐变**: 沿高度单调衰减, 且带底与带外连续(无横向硬边)。
    # 原实现是"顶部 1/4 加常数", 在带底留下一条肉眼可见的直线。
    row_r = out[:, :, 2].mean(axis=1).astype(np.int32)
    h = out.shape[0]
    leak_h = max(1, int(round(h * VINTAGE["leak_ratio"])))
    band = row_r[:leak_h]
    check(
        "漏光沿高度单调不增(渐变而非常数)",
        bool(np.all(np.diff(band) <= 1)),
        f"首行={band[0]} 末行={band[-1]}",
    )
    check(
        "漏光顶端最强",
        band[0] > band[leak_h // 2] > band[-1],
        f"top={band[0]} mid={band[leak_h // 2]} bandEnd={band[-1]}",
    )
    # 带底那一行与带外第一行的落差就是"硬边"的量度: 原来这里是 ~30。
    seam = abs(int(row_r[leak_h - 1]) - int(row_r[leak_h]))
    check("漏光带底无硬边(与带外落差 <= 2)", seam <= 2, f"seam={seam}")

    # 漏光的作用范围必须**恰好**是 [0, leak_h)。做法: 与"关掉漏光"的同一次
    # 调用逐像素比 —— 两次走的是同一套 resize, 所以差值里只剩漏光,
    # 不会被重采样干扰(这比"看带外行是否恒定"可靠: 那在纯色图上恒真)。
    no_leak = _era_vintage_2000_pixels(bgr, {**VINTAGE, "leak_r": 0, "leak_g": 0})
    delta = out.astype(np.int16) - no_leak.astype(np.int16)
    check(
        "漏光只作用于 [0, leak_h) 区间",
        bool(np.all(delta[leak_h:] == 0)),
        f"带外最大偏差={int(np.abs(delta[leak_h:]).max())}",
    )
    check(
        "漏光在带内确实生效(峰值≈leak_r)",
        int(delta[0, :, 2].mean()) > 0,
        f"首行 dR={int(delta[0, :, 2].mean())}",
    )

    # posterize: 每通道最低位被清掉 -> 只剩偶数值
    uniq = np.unique(out)
    check("posterize 后只剩偶数值", bool(np.all(uniq % 2 == 0)), f"首个={uniq[0]}")

    # posterize 收敛色阶: 用一张**多级**渐变图(而非纯色图)来量, 因为纯色图
    # 只有 1 级, 收敛与否都看不出来; 同理这里关掉漏光, 否则渐变漏光本身
    # 就会把唯一值数量顶上去, 测不到 posterize 的贡献。
    # 判据: 关掉 posterize 的参照实现(cv2 重采样, 不做 >>1<<1)的色阶数,
    # 必须至少是实际输出的两倍 —— posterize 的本质就是把 256 级压到 128 级。
    ramp = np.tile(np.arange(256, dtype=np.uint8), (256, 1))
    ramp3 = np.dstack([ramp] * 3)
    ramp_out = _era_vintage_2000_pixels(ramp3, {**VINTAGE, "leak_r": 0, "leak_g": 0})
    rscale = VINTAGE["short_edge"] / 256
    rsmall = cv2.resize(ramp3, (int(round(256 * rscale)), int(round(256 * rscale))), interpolation=cv2.INTER_AREA)
    rref = cv2.resize(rsmall, (256, 256), interpolation=cv2.INTER_LINEAR)
    ref_levels = len(np.unique(rref))
    got_levels = len(np.unique(ramp_out))
    check(
        "posterize 收敛了色阶数量(至少砍半)",
        got_levels * 2 <= ref_levels + 1,
        f"{ref_levels} 级 -> {got_levels} 级",
    )
    check(
        "posterize 输出与参照实现按位相符",
        np.array_equal(ramp_out, (rref >> 1) << 1),
    )

    # 低分辨率观感: 高频棋盘被抹平。1px 棋盘下采样再上采后, 相邻像素差应远小于原图
    chess = np.indices((256, 256)).sum(axis=0) % 2 * 255
    chess3 = np.dstack([chess] * 3).astype(np.uint8)
    smoothed = _era_vintage_2000_pixels(chess3, VINTAGE)
    grad_before = np.abs(np.diff(chess3[:, :, 0].astype(int), axis=1)).mean()
    grad_after = np.abs(np.diff(smoothed[:, :, 0].astype(int), axis=1)).mean()
    check(
        "高频细节被平滑(低分辨率观感)",
        grad_after < grad_before,
        f"梯度 {grad_before:.1f} -> {grad_after:.1f}",
    )

    # 上采样必须是 INTER_LINEAR 而不是 INTER_NEAREST。
    # 判据: 同一张图, 本实现 vs 手工复刻的两种插值版, 逐像素比对。
    # 之所以不写"零差相邻对数量"这类统计量: 那个数字随 short_edge/尺寸
    # 的比例漂移, 换个图就变, 是靠不住的代理指标。
    # 参照系里要**关掉漏光**, 只比"重采样"这一段 —— 否则漏光叠在上面,
    # 两个版本必然不等, 断言就恒假了(这坑踩过一次)。
    # 尺寸必须**大于** short_edge, 否则 scale=1.0 根本不缩放, 两种插值
    # 都退化成恒等变换, 比出来必然"相同"(这个坑踩过一次: 用 480x640 时
    # 短边正好等于 480, 断言恒假)。取 6寸相纸尺寸 1000x1500 顺带覆盖
    # 非 4:3 的真实成片比例。
    src = _blank_bgr(1000, 1500)
    src[:, ::17] = 255  # 造出竖条纹, 让两种插值给出可区分的结果
    resample_only = {**VINTAGE, "leak_r": 0, "leak_g": 0}
    got = _era_vintage_2000_pixels(src, resample_only)
    scale = VINTAGE["short_edge"] / min(src.shape[:2])
    nw, nh = int(round(src.shape[1] * scale)), int(round(src.shape[0] * scale))
    small = cv2.resize(src, (nw, nh), interpolation=cv2.INTER_AREA)
    nearest = cv2.resize(small, (src.shape[1], src.shape[0]), interpolation=cv2.INTER_NEAREST)
    check(
        "上采样不是 INTER_NEAREST(与最近邻复刻版结果不同)",
        not np.array_equal(got, (nearest >> 1) << 1),
    )
    # 反向确认: 本实现与 INTER_LINEAR 复刻版逐像素一致, 坐实"就是线性"。
    linear = cv2.resize(small, (src.shape[1], src.shape[0]), interpolation=cv2.INTER_LINEAR)
    check(
        "上采样就是 INTER_LINEAR(与线性复刻版逐像素一致)",
        np.array_equal(got, (linear >> 1) << 1),
    )

    # 非 4:3 图不能被拉变形: 6寸相纸是 1500x1000
    wide = _blank_bgr(1000, 1500)
    check(
        "非 4:3 图保持形状(不被写死 640x480 拉变形)",
        _era_vintage_2000_pixels(wide, VINTAGE).shape == wide.shape,
    )

    # 极小图不能崩(短边推算后不小于 1)
    tiny = _blank_bgr(8, 8)
    check("极小图不崩", _era_vintage_2000_pixels(tiny, VINTAGE).shape == tiny.shape)


# ---------------------------------------------------------------------------
# 2. apply_filter 组合层
# ---------------------------------------------------------------------------
def test_apply_filter() -> None:
    print("\n[2] apply_filter 组合层")
    pil = _gray_pil()

    # 全恒等快路径: 不做任何像素往返
    check("preset=none + era=modern 走恒等快路径", apply_filter(pil, "none", "modern") is pil)
    check("preset=faded_90s + era=modern 仍出图", apply_filter(pil, "faded_90s", "modern") is not pil)

    # preset=none 时 era 仍要单独生效(合法的用户组合)
    only_era = apply_filter(pil, "none", "vintage_2000")
    check("preset=none + vintage_2000 仍生效", not np.array_equal(np.array(only_era), np.array(pil)))

    def _arr(img: Image.Image) -> np.ndarray:
        return np.asarray(img.convert("RGB"), dtype=np.int16)

    base = _arr(apply_filter(pil, "none", "modern"))
    only_era_a = _arr(apply_filter(pil, "none", "vintage_2000"))
    only_f = _arr(apply_filter(pil, "faded_90s", "modern"))
    both = _arr(apply_filter(pil, "faded_90s", "vintage_2000"))

    check("era 单独 != 原图", not np.array_equal(base, only_era_a))
    check("preset 单独 != 原图", not np.array_equal(base, only_f))
    check(
        "preset 与 era 是叠加而非二选一",
        not np.array_equal(both, only_f) and not np.array_equal(both, only_era_a),
    )
    # 叠加拿的是「各自都改了不同的东西」, 而不是只生效了一个
    d_both_vs_f = np.abs(both - only_f).mean()
    d_f_vs_base = np.abs(only_f - base).mean()
    check("叠加后的差异与单独 era 同量级(没被吞掉)", d_both_vs_f > 0, f"{d_both_vs_f:.2f}")
    check("确认叠加里 preset 也没丢", d_f_vs_base > 0, f"filter-only delta={d_f_vs_base:.2f}")

    # era 算子自身必须确定性(不含随机)。
    # 注意不能在带 grain 的预设上测: _grain 用 cv2.randn 填噪声, 本来就
    # 应该每次不同(那是胶片颗粒的效果)。所以这里用 preset="none" 隔离 era。
    a = np.asarray(apply_filter(pil, "none", "vintage_2000").convert("RGB"))
    b = np.asarray(apply_filter(pil, "none", "vintage_2000").convert("RGB"))
    check("era 算子确定性(同参数两次一致)", np.array_equal(a, b))


# ---------------------------------------------------------------------------
# 3. 路由层
# ---------------------------------------------------------------------------
def test_routes() -> None:
    print("\n[3] 路由层")
    from fastapi.testclient import TestClient

    from backend.app import app

    client = TestClient(app)
    jpg = _jpeg_bytes(_gray_pil())

    # httpx 的 files= 与 data= 必须分开: 放进 files 的字段会被当作「文件部分」
    # 发送, FastAPI 收不到同名 Form 字段(会 422)。这与前端 api.ts 用
    # FormData 分开 append 的行为一致。
    def post_filter(preset: str, era: str | None = None) -> "object":
        data: dict[str, str] = {"preset": preset}
        if era is not None:
            data["era"] = era
        return client.post(
            "/api/preview/filter",
            files={"image": ("cap.jpg", jpg, "image/jpeg")},
            data=data,
        )

    # 不传 era 时默认 modern(向后兼容: 老前端不带这个字段也能用)
    r_default = post_filter("none")
    check("不传 era 时默认 200", r_default.status_code == 200, f"got {r_default.status_code}")
    check(
        "不传 era 等价于 modern",
        r_default.content == post_filter("none", ERA_DEFAULT).content,
    )

    r_modern = post_filter("none", "modern")
    r_vintage = post_filter("none", "vintage_2000")
    check("era=modern 200", r_modern.status_code == 200)
    check("era=vintage_2000 200", r_vintage.status_code == 200)
    check("era 真的改变了返回字节", r_modern.content != r_vintage.content)

    # 校验: 非法值必须 400, 不能静默降级成 modern
    r_bad = post_filter("none", "no_such_era")
    check("非法 era 返回 400", r_bad.status_code == 400, f"got {r_bad.status_code}")
    check("非法 era 有明确报错信息", "unknown era preset" in r_bad.text, r_bad.text[:80])
    r_bad_preset = post_filter("no_such_preset", "modern")
    check("非法 preset 仍返回 400(未被 era 改动破坏)", r_bad_preset.status_code == 400)

    # preset 与 era 在 HTTP 层也能叠加
    r_both = post_filter("faded_90s", "vintage_2000")
    check("HTTP 层 preset+era 叠加 200", r_both.status_code == 200)
    check(
        "HTTP 层叠加结果与任一单独都不同",
        r_both.content != r_modern.content and r_both.content != post_filter("faded_90s", "modern").content,
    )

    # capture/save: **原样落盘**, 不再接受 era。
    # era 由 DecoratePage 在上传前经 /api/preview/filter 烧好; 这里若再烧一次
    # 就是双烧(算子非幂等)。所以断言方向与旧版相反: 传什么都没该原样落盘。
    r_save = client.post(
        "/api/capture/save",
        files=[("images", ("p1.jpg", jpg, "image/jpeg"))],
    )
    check("capture/save 200", r_save.status_code == 200, r_save.text[:120])
    job_id = r_save.json()["job_id"]
    saved_path = ROOT / "outputs" / job_id / "photo_1.jpg"
    check("capture/save 落了盘", saved_path.exists())
    if saved_path.exists():
        check(
            "capture/save 原样落盘(逐字节一致, 无二次编码)",
            saved_path.read_bytes() == jpg,
            f"{saved_path.stat().st_size}B vs 上传 {len(jpg)}B",
        )
        # 顶部不该出现漏光 —— 这正是"era 没有在这里被烧"的可观测证据。
        # 注意通道序: 经 PIL convert("RGB") 得到的是 RGB, R 在 index 0。
        # (第 1 层的纯函数测试直接用 numpy 判 BGR, R 在 index 2 —— 两处不同,
        #  混用会得出「漏光没生效」的错误结论。)
        saved = np.asarray(Image.open(saved_path).convert("RGB"), dtype=np.int16)
        top = saved[: saved.shape[0] // 4].reshape(-1, 3).mean(axis=0)
        bottom = saved[-(saved.shape[0] // 4) :].reshape(-1, 3).mean(axis=0)
        check(
            "落盘图没有漏光(era 未在落盘时二次烧录)",
            abs(top[0] - bottom[0]) < 2,
            f"topR={top[0]:.1f} bottomR={bottom[0]:.1f}",
        )

    # 多余的 era 字段必须被忽略而不是报错: 老前端/脚本可能仍在发这个字段,
    # FastAPI 对未声明的 Form 字段本就静默丢弃, 这里钉住该行为不被改坏。
    r_save_extra = client.post(
        "/api/capture/save",
        files=[("images", ("p1.jpg", jpg, "image/jpeg"))],
        data={"era": "vintage_2000"},
    )
    check("capture/save 忽略多余的 era 字段(不 422)", r_save_extra.status_code == 200, f"got {r_save_extra.status_code}")
    jid2 = r_save_extra.json()["job_id"]
    p_extra = ROOT / "outputs" / jid2 / "photo_1.jpg"
    if p_extra.exists():
        check(
            "带 era 字段时仍是原样落盘(不会被偷偷烧一遍)",
            p_extra.read_bytes() == jpg,
        )


# ---------------------------------------------------------------------------
# 4. 契约层(前后端不会各说一套)
# ---------------------------------------------------------------------------
def test_contract() -> None:
    print("\n[4] 契约层")
    from fastapi.testclient import TestClient

    from backend.app import app

    check("ERA_PRESETS 正好两个", set(ERA_PRESETS) == {"modern", "vintage_2000"}, str(list(ERA_PRESETS)))
    check("ERA_KEYS 与 ERA_PRESETS 同源", ERA_KEYS == list(ERA_PRESETS.keys()))
    check("ERA_DEFAULT 是合法 key", ERA_DEFAULT in ERA_KEYS, ERA_DEFAULT)

    # ERA_OPS 与 ERA_PRESETS 的 key 必须完全一致。这两张表分居 config(参数/
    # 展示名)与 filters(算子实现), 没有任何机制保证它们同步 —— 只加一边时
    # 症状是"新 era 在 /api/meta 里露脸, 选了却毫无效果", 因为 _apply_era
    # 在任一表缺失时都静默返回原图。这条断言就是守这个不变量的。
    check(
        "ERA_OPS 与 ERA_PRESETS 的 key 完全一致",
        set(ERA_OPS) == set(ERA_PRESETS),
        f"ops-only={sorted(set(ERA_OPS) - set(ERA_PRESETS))} "
        f"presets-only={sorted(set(ERA_PRESETS) - set(ERA_OPS))}",
    )
    check("ERA_OPS 顺序与 ERA_PRESETS 一致", list(ERA_OPS) == list(ERA_PRESETS), str(list(ERA_OPS)))
    # 每个 key 都得能真正跑通 apply_filter, 而不只是"键存在"。
    for key in ERA_KEYS:
        img = apply_filter(_gray_pil(), "none", key)
        check(f"era={key} 能跑通 apply_filter", isinstance(img, Image.Image))
    # 非默认 era 必须真的改变像素(否则又是一个"存在但没接线"的空壳)
    base = np.asarray(apply_filter(_gray_pil(), "none", ERA_DEFAULT).convert("RGB"))
    for key in ERA_KEYS:
        if key == ERA_DEFAULT:
            continue
        got = np.asarray(apply_filter(_gray_pil(), "none", key).convert("RGB"))
        check(f"era={key} 真的改变了像素", not np.array_equal(base, got))

    # 每个预设都得有 name + params 两个字段(vintage_2000 的 params 还不能是空的)
    for key, spec in ERA_PRESETS.items():
        check(f"ERA_PRESETS[{key}] 有 name", bool(spec.get("name")), str(spec.get("name")))
        check(f"ERA_PRESETS[{key}] 有 params 字段", "params" in spec)
    check("vintage_2000 的 params 非空(参数确实外置了)", bool(ERA_PRESETS["vintage_2000"]["params"]))

    meta = TestClient(app).get("/api/meta").json()
    check("/api/meta 含 era_presets", "era_presets" in meta)
    served = {e["key"] for e in meta.get("era_presets", [])}
    check("/api/meta 的 era_presets 与后端一致", served == set(ERA_KEYS), str(served))
    # name 必须取自 v["name"] 而不是整条 dict —— 串了会直接把 python 字典
    # 塞进 JSON 响应, 前端拿到 "[object Object]" 之类的脏 name。
    names = {e["key"]: e.get("name") for e in meta.get("era_presets", [])}
    check(
        "/api/meta 的 era name 来自 ERA_PRESETS[].name",
        all(names.get(k) == v["name"] for k, v in ERA_PRESETS.items()),
        str(names),
    )
    # era 是顶层维度, 不该出现在 filters 里
    check(
        "era 没有被塞进 filters(顶层独立维度)",
        all("era" not in f for f in meta.get("filters", [])),
    )
    check(
        "FilterInfo 没有 era 字段(不是 per-filter 的)",
        all("era" not in f for f in meta.get("filters", [])),
    )


def main() -> int:
    print("=" * 60)
    print("  verify_era · 古早画质预设 era")
    print("=" * 60)
    try:
        test_pure_ops()
        test_apply_filter()
        test_routes()
        test_contract()
    except AssertionError as e:
        print(f"\n[FAIL] {e}")
        print(f"\nResult: {len(PASS)} passed, 1 failed")
        return 1
    print(f"\nResult: {len(PASS)} passed, 0 failed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
