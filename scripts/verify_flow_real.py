"""跑通真实用户全流程(走 vite proxy,和浏览器同一条链路)。

与 verify_e2e 的区别:那个用合成假脸,检不到人脸,只能验证非 AI 路径;
本脚本用 outputs/ 下的真实照片,覆盖"上传 → 连拍 → 选风格 → AI 生成 →
排版 → 入库"的完整业务闭环,确保 LoRA + FaceID 在真实链路上也通。

注意:AI 生成会加载 SDXL,单张约 30s,4 个风格全跑约 2 分钟。
"""
from __future__ import annotations

import io
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "http://localhost:5173"
EXPORTS = ROOT / "outputs" / "_verify"
EXPORTS.mkdir(parents=True, exist_ok=True)

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name} {detail}", flush=True)


def get(path: str, timeout: int = 60):
    try:
        with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def post_json(path: str, payload: dict, timeout: int = 60):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def post_multipart(path: str, files, data: dict | None = None, timeout: int = 120):
    """files: [(field, filename, bytes), ...] —— 支持同名字段多文件。"""
    boundary = "----bigheadflow"
    buf = io.BytesIO()
    items = files.items() if isinstance(files, dict) else files
    for name, fn, content in items:
        buf.write(f"--{boundary}\r\n".encode())
        buf.write(f'Content-Disposition: form-data; name="{name}"; filename="{fn}"\r\n'.encode())
        buf.write(b"Content-Type: image/jpeg\r\n\r\n")
        buf.write(content)
        buf.write(b"\r\n")
    for k, v in (data or {}).items():
        buf.write(f"--{boundary}\r\n".encode())
        buf.write(f'Content-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    buf.write(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        BASE + path, data=buf.getvalue(),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def real_photos(n: int = 4) -> list[bytes]:
    srcs = sorted((ROOT / "outputs" / "4f6963daf4d5").glob("photo_*.jpg"))
    if not srcs:
        raise SystemExit("找不到真实照片")
    out = []
    for i in range(n):
        p = srcs[i % len(srcs)]
        out.append(p.read_bytes())
    return out


def identity(src: bytes, gen_path: str) -> float:
    import numpy as np
    from PIL import Image

    sys.path.insert(0, str(ROOT))
    from backend.face import _get_app

    app = _get_app()

    def emb(b):
        f = app.get(np.array(Image.open(io.BytesIO(b)).convert("RGB")))
        if not f:
            return None
        f = max(f, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]))
        return f.normed_embedding.reshape(-1)

    ea, eb = emb(src), emb(urllib.request.urlopen(BASE + gen_path).read())
    if ea is None or eb is None:
        return -1.0
    return float(np.dot(ea, eb) / (np.linalg.norm(ea) * np.linalg.norm(eb)))


def main() -> None:
    styles = ["PORTRAIT_HK", "FILM_VELVIA", "SHOWA_ANIME", "DARKROOM_STICKER"]
    photos = real_photos(4)

    print("=" * 72)
    print("  真实照片全流程(vite proxy -> uvicorn)")
    print("=" * 72)

    st, body = get("/api/health")
    h = json.loads(body)
    check("health / GPU", st == 200 and "RTX" in h.get("gpu", ""),
          f"{h.get('gpu')} vram_free={h.get('vram_free_gb')}GB")

    st, body = post_multipart("/api/capture/save",
                              [("images", f"p{i}.jpg", d) for i, d in enumerate(photos)])
    cap = json.loads(body) if st == 200 else {}
    jid = cap.get("job_id", "")
    check("连拍保存 4 张", st == 200 and len(cap.get("photos", [])) == 4,
          f"job={jid} n={len(cap.get('photos', []))}")

    results = {}
    for style in styles:
        print(f"\n  --- AI: {style} ---", flush=True)
        t0 = time.time()
        # 首次请求会同步加载 SDXL 并 fuse LoRA(实测 ~40s),之后才转后台任务。
        # 超时给到 180s,否则会误判成端点挂死。
        st, body = post_multipart("/api/generate/start", {},
                                  {"job_id": jid, "style": style}, timeout=180)
        resp = json.loads(body) if st == 200 else {}
        check(f"{style} 受理", st == 200 and "job_id" in resp,
              f"status={st} {str(body)[:120]}")
        gj = resp.get("job_id", "")
        if not gj:
            continue

        final, last = {}, -1
        deadline = time.time() + 480
        while time.time() < deadline:
            st, b = get(f"/api/jobs/{gj}")
            final = json.loads(b) if st == 200 else {}
            prog = final.get("progress", -1)
            if prog != last:
                print(f"        progress={prog} {final.get('stage', '')}", flush=True)
                last = prog
            if final.get("status") in ("done", "error"):
                break
            time.sleep(3)

        dt = time.time() - t0
        check(f"{style} 完成", final.get("status") == "done",
              f"status={final.get('status')} msg={final.get('msg', '')[:100]}")
        imgs = final.get("images", [])
        if final.get("status") != "done":
            continue
        check(f"{style} 产出 {len(photos)} 张", len(imgs) == len(photos),
              f"n={len(imgs)} {dt:.0f}s "
              f"vram={final.get('vram_peak_gb')}GB "
              f"job.style={final.get('style')}")
        if final.get("style") != style:
            check(f"{style} style 字段回显", False, f"got {final.get('style')}")
        else:
            check(f"{style} style 字段回显", True)
        results[style] = (imgs, dt)

        for i, rel in enumerate(imgs):
            d = urllib.request.urlopen(BASE + rel).read()
            (EXPORTS / f"flow_{style}_{i + 1}.jpg").write_bytes(d)

    print("\n  --- 身份相似度(InsightFace cosine)---")
    for style, (imgs, _) in results.items():
        for i, rel in enumerate(imgs):
            c = identity(photos[i % len(photos)], rel)
            flag = "OK" if c >= 0.35 else "低"
            print(f"    {style:<14} #{i + 1}  cosine={c:.4f}  [{flag}]")

    if results:
        style, (imgs, _) = next(iter(results.items()))
        payloads = [urllib.request.urlopen(BASE + p).read() for p in imgs]
        st, body = post_multipart(
            "/api/layout/make",
            [("images", f"a{i}.jpg", d) for i, d in enumerate(payloads)],
            {"layout": "strip", "theme": "polaroid"})
        check("AI 产出排版成大头贴", st == 200 and len(body) > 5000,
              f"status={st} bytes={len(body)}")
        if st == 200:
            (EXPORTS / "flow_collage.jpg").write_bytes(body)

    print(f"\n  PASS={len(PASS)}  FAIL={len(FAIL)}")
    if FAIL:
        print("  失败项: " + ", ".join(FAIL))
    print("=" * 72)
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
