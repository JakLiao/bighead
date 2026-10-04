"""对运行中的后端做一次真实 HTTP 冒烟(含 AI 生成)。

与 verify_api.py 的区别:那个用进程内 TestClient 且会连带跑 AI 端点;
本脚本只打真实端口,便于确认"重启后的服务确实加载了新代码"。

检查项:
  - /api/health、/api/meta
  - 非 AI 全链路:滤镜预览、连拍保存、排版
  - AI 生成(走生产 BigHeadPipeline,SDXL + SD1.5 禁用 + 胶片 LoRA)
  - 失败路径:非法 style、无效 job_id
"""
from __future__ import annotations

import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# 与后端约定端口一致(8077); 如跑在其它实例上, 用 BIGHEAD_API_TARGET 覆盖。
BASE = os.environ.get("BIGHEAD_API_TARGET", "http://127.0.0.1:8077").rstrip("/")
EXPORTS = ROOT / "outputs" / "_verify"
EXPORTS.mkdir(parents=True, exist_ok=True)

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name} {detail}", flush=True)


def get(path: str):
    req = urllib.request.Request(BASE + path)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def post_json(path: str, payload: dict):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def post_multipart(path: str, files, data: dict | None = None):
    """files 可以是 {name: (filename, bytes)} 或 [(name, filename, bytes), ...]。

    后端 capture_save / layout_make 收的是 list[UploadFile](复数同名字段),
    所以必须支持重复的 field name,dict 会丢重复项。
    """
    boundary = "----bigheadverify"
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
    req = urllib.request.Request(BASE + path, data=buf.getvalue(),
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def test_face() -> bytes:
    p = sorted((ROOT / "outputs" / "4f6963daf4d5").glob("photo_*.jpg"))[0]
    return p.read_bytes()


def main() -> None:
    st, body = get("/api/health")
    check("health", st == 200, f"status={st}")

    st, body = get("/api/meta")
    meta = json.loads(body) if st == 200 else {}
    check("meta", st == 200 and len(meta.get("styles", [])) >= 4,
          f"styles={len(meta.get('styles', []))}")

    st, _ = get("/api/jobs/does-not-exist")
    check("404 on unknown job", st == 404, f"status={st}")

    face = test_face()

    # 字段名以实际路由为准: preview_filter(image, preset)
    st, body = post_multipart("/api/preview/filter",
                              [("image", "f.jpg", face)], {"preset": "faded_90s"})
    check("filter preview", st == 200 and len(body) > 1000,
          f"status={st} bytes={len(body)}")

    # capture_save(images: list[UploadFile]) -> {job_id, photos}
    st, body = post_multipart("/api/capture/save",
                              [("images", "a.jpg", face), ("images", "b.jpg", face)], {})
    saved = json.loads(body) if st == 200 else {}
    jid = saved.get("job_id", "")
    check("capture save (2 图)", st == 200 and len(saved.get("photos", [])) == 2,
          f"job_id={jid} n={len(saved.get('photos', []))}")

    photos = saved.get("photos", [])
    if len(photos) >= 2:
        payloads = [urllib.request.urlopen(BASE + p).read() for p in photos]
        st, body = post_multipart(
            "/api/layout/make",
            [("images", f"p{i}.jpg", d) for i, d in enumerate(payloads)],
            {"layout": "2x2"},
        )
        check("layout 2x2", st == 200, f"status={st} {str(body)[:100]}")

    st, body = post_json("/api/generate/start", {"style": "__nope__", "count": 1})
    check("AI 非法请求被拒", st in (400, 422), f"status={st}")

    print("\n  --- AI 生成(加载 SDXL,较慢)---", flush=True)
    t0 = time.time()
    st, body = post_multipart(
        "/api/generate/start",
        {},
        {"job_id": jid, "style": "PORTRAIT_HK"},
    )
    job = json.loads(body) if st == 200 else {}
    check("AI 生成已受理", st == 200 and "job_id" in job,
          f"status={st} {str(body)[:140]}")

    if jid:
        deadline = time.time() + 420
        final = {}
        while time.time() < deadline:
            st, b = get(f"/api/jobs/{jid}")
            final = json.loads(b) if st == 200 else {}
            if final.get("status") in ("done", "error"):
                break
            time.sleep(3)
        dt = time.time() - t0
        check("AI 生成完成", final.get("status") == "done",
              f"status={final.get('status')} msg={final.get('msg', '')[:90]}")
        if final.get("status") == "done":
            check("AI 产出图片", len(final.get("images", [])) >= 1,
                  f"n={len(final.get('images', []))} {dt:.0f}s "
                  f"vram={final.get('vram_peak_gb')}GB")
            for i, rel in enumerate(final.get("images", [])[:1]):
                d = urllib.request.urlopen(BASE + rel).read()
                out = EXPORTS / f"live_ai_{i + 1}.jpg"
                out.write_bytes(d)
                print(f"        -> {out.name} ({len(d) / 1024:.0f} KB)")

    print(f"\n  PASS={len(PASS)}  FAIL={len(FAIL)}")
    if FAIL:
        print("  失败项: " + ", ".join(FAIL))
    print("=" * 70)
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
