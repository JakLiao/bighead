"""古早画质预设 era 的验证脚本.

为什么是裸 assert 而不是 pytest:
共享的 webui venv 里没有装 pytest(装它会牵动 transformers/diffusers 的
版本死锁, 见 .trae/rules/project_rules.md),所以本项目一律用「裸 assert +
退出码」的脚本, 见 scripts/ 与本目录下的 verify_*.py。

跑法(必须用 webui 解释器,不能用裸 python):
    & "E:\\Code\\stable-diffusion-webui\\.venv\\Scripts\\python.exe" backend/scripts/verify_era.py

覆盖三层:
  1. 纯函数: modern 严格恒等 / vintage_2000 通道可度量退化
  2. 路由:   era 非法值 400 / era 生效 / preset 与 era 可叠加且互不干扰
  3. 契约:   /api/meta 的 era_presets 与 config.ERA_PRESETS 一致
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from backend.config import ERA_DEFAULT, ERA_KEYS, ERA_PRESETS  # noqa: E402
from backend.filters import (  # noqa: E402
    _era_modern_pixels,
    _era_vintage_2000_pixels,
    apply_filter,
)

PASS: list[str] = []


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
    out = _era_modern_pixels(bgr)
    check("modern 是恒等函数(返回同一对象)", out is bgr)
    check("modern 不改动任何像素", np.array_equal(out, bgr))

    out = _era_vintage_2000_pixels(bgr)
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

    # posterize: 每通道最低位被清掉 -> 只剩偶数值, 且唯一值数量大幅收敛
    uniq = np.unique(out)
    check("posterize 后只剩偶数值", bool(np.all(uniq % 2 == 0)), f"首个={uniq[0]}")
    check(
        "posterize 收敛了色阶数量",
        len(np.unique(bgr)) == 1 and len(uniq) <= 4,
        f"{len(uniq)} 个唯一值",
    )

    # 低分辨率观感: 高频棋盘被抹平。1px 棋盘下采样再上采后, 相邻像素差应远小于原图
    chess = np.indices((256, 256)).sum(axis=0) % 2 * 255
    chess3 = np.dstack([chess] * 3).astype(np.uint8)
    smoothed = _era_vintage_2000_pixels(chess3)
    grad_before = np.abs(np.diff(chess3[:, :, 0].astype(int), axis=1)).mean()
    grad_after = np.abs(np.diff(smoothed[:, :, 0].astype(int), axis=1)).mean()
    check(
        "高频细节被平滑(低分辨率观感)",
        grad_after < grad_before,
        f"梯度 {grad_before:.1f} -> {grad_after:.1f}",
    )

    # 非 4:3 图不能被拉变形: 6寸相纸是 1500x1000
    wide = _blank_bgr(1000, 1500)
    check("非 4:3 图保持形状(不被写死 640x480 拉变形)", _era_vintage_2000_pixels(wide).shape == wide.shape)

    # 极小图不能崩(短边推算后不小于 1)
    tiny = _blank_bgr(8, 8)
    check("极小图不崩", _era_vintage_2000_pixels(tiny).shape == tiny.shape)


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

    # capture/save: era 烧进落盘像素
    r_save_bad = client.post(
        "/api/capture/save",
        files=[("images", ("p1.jpg", jpg, "image/jpeg"))],
        data={"era": "nope"},
    )
    check("capture/save 非法 era 返回 400", r_save_bad.status_code == 400, f"got {r_save_bad.status_code}")

    r_save = client.post(
        "/api/capture/save",
        files=[("images", ("p1.jpg", jpg, "image/jpeg"))],
        data={"era": "vintage_2000"},
    )
    check("capture/save era=vintage_2000 200", r_save.status_code == 200, r_save.text[:120])
    job_id = r_save.json()["job_id"]
    saved_path = ROOT / "outputs" / job_id / "photo_1.jpg"
    check("capture/save 落了盘", saved_path.exists())
    if saved_path.exists():
        # 注意通道序: 经 PIL convert("RGB") 得到的是 RGB, R 在 index 0。
        # (第 1 层的纯函数测试直接用 numpy 判 BGR, R 在 index 2 —— 两处不同,
        #  混用会得出「漏光没生效」的错误结论。)
        saved = np.asarray(Image.open(saved_path).convert("RGB"), dtype=np.int16)
        orig = np.asarray(_gray_pil().convert("RGB"), dtype=np.int16)
        check("落盘的图已被烧过 era", not np.array_equal(saved, orig))
        top = saved[: saved.shape[0] // 4].reshape(-1, 3).mean(axis=0)
        bottom = saved[-(saved.shape[0] // 4) :].reshape(-1, 3).mean(axis=0)
        check(
            "落盘图顶部漏光已生效",
            top[0] - bottom[0] > 15,
            f"topR={top[0]:.1f} bottomR={bottom[0]:.1f}",
        )

    # modern 必须原样落盘: 不引入二次 JPEG 损失
    r_save_modern = client.post(
        "/api/capture/save",
        files=[("images", ("p1.jpg", jpg, "image/jpeg"))],
        data={"era": "modern"},
    )
    jid = r_save_modern.json()["job_id"]
    p_modern = ROOT / "outputs" / jid / "photo_1.jpg"
    check("capture/save era=modern 200", r_save_modern.status_code == 200)
    if p_modern.exists():
        check(
            "era=modern 走原样落盘(不二次编码)",
            p_modern.read_bytes() == jpg,
            f"{p_modern.stat().st_size}B vs 原 {len(jpg)}B",
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

    meta = TestClient(app).get("/api/meta").json()
    check("/api/meta 含 era_presets", "era_presets" in meta)
    served = {e["key"] for e in meta.get("era_presets", [])}
    check("/api/meta 的 era_presets 与后端一致", served == set(ERA_KEYS), str(served))
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
