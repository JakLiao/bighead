"""算出"暖调"的通道系数,而不是凭感觉调 R/B 的比例。

用 HSV 色相角判读,因为单看 R-B 分不出黄和红:
  中灰 + (1, 0, -1)         -> hue 30deg sat 10.2%  暖橙,但饱和度偏高,读作"发红"
  中灰 + (0.5, 0.45, -0.25) -> hue 56deg sat  3.9%  暖黄,且不抢眼

黄 = R + G,所以 G 必须参与;B 的降幅取 R 的 1/2 左右,再深就往红走。

filters._warmth 现在用的就是第二组系数(见该文件注释)。
改了 warmth preset 后可跑本脚本核对新的色相/饱和度:
    python scripts/calc_warmth_ratio.py 0.25
"""
from __future__ import annotations

import colorsys
import sys

BASE = 128.0


def describe(aR: float, aG: float, aB: float, k: float) -> str:
    r, g, b = BASE + aR * k, BASE + aG * k, BASE + aB * k
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    hue = h * 360
    if 15 <= hue <= 45:
        tag = "暖橙 OK"
    elif 45 < hue <= 60:
        tag = "暖黄 OK"
    elif hue > 300 or hue < 15:
        tag = "偏红/品红"
    else:
        tag = f"其他色相({hue:.0f}deg)"
    return (f"R={r:6.1f} G={g:6.1f} B={b:6.1f}  "
            f"hue={hue:5.1f}deg sat={s * 100:4.1f}% val={v * 100:4.1f}%  {tag}")


def main() -> None:
    warmth = float(sys.argv[1]) if len(sys.argv) > 1 else 0.18
    k = 255 * warmth * 0.15
    print(f"  中灰 R=G=B={BASE:.0f}, warmth={warmth} -> k={k:.2f}")
    print(f"  目标色相 20~60deg(暖橙~暖黄),饱和度别太高\n")
    print(f"  {'方案':<24} 结果")
    for name, aR, aG, aB in [
        ("旧实现(1,0,-1)", 1.0, 0.0, -1.0),
        ("当前(0.5,0.45,-0.25)", 0.5, 0.45, -0.25),
        ("(0.7,0.65,-0.35)", 0.7, 0.65, -0.35),
        ("(0.4,0.35,-0.2)", 0.4, 0.35, -0.2),
        ("(0.3,0.27,-0.15)", 0.3, 0.27, -0.15),
    ]:
        print(f"  {name:<24} {describe(aR, aG, aB, k)}")

    print(f"\n  结论:aG 必须 > 0(黄=R+G),B 降幅取 R 的 1/2 左右。")
    print(f"  旧实现 aG=0 且 B 降幅与 R 等量 => 饱和度被推高,读作「发红」。")
    print("=" * 72)


if __name__ == "__main__":
    main()
