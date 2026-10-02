"""端到端联调:走真实 HTTP(uvicorn + vite proxy),而不是 TestClient.

前置:
  终端 1: python -m uvicorn backend.app:app --port 8000
  终端 2: npm run dev            (vite 5173)
本脚本只做客户端,不自己起服务.
"""
from __future__ import annotations

import io
import json
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

BASE = "http://localhost:5173"  # 走 vite proxy,顺带验证代理链路
EXPORTS = Path(__file__).resolve().parent.parent / "outputs" / "_verify"
EXPORTS.mkdir(parents=True, exist_ok=True)

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name} {detail}")


def make_face_jpeg(idx: int, size=(640, 800)) -> bytes:
    from PIL import Image, ImageDraw

    img = Image.new("RGB", size, (232, 226, 214))
    d = ImageDraw.Draw(img)
    d.rectangle((0, int(size[1] * 0.62), size[0], size[1]), fill=(96, 104, 120))
    d.ellipse((size[0] // 4, size[1] // 5, size[0] * 3 // 4, int(size[1] * 0.72)),
              fill=(226, 184, 158))
    d.ellipse((size[0] // 3, int(size[1] * 0.38), size[0] // 3 + 24, int(size[1] * 0.38) + 15),
              fill=(40, 40, 40))
    d.ellipse((size[0] * 2 // 3 - 24, int(size[1] * 0.38), size[0] * 2 // 3, int(size[1] * 0.38) + 15),
              fill=(40, 40, 40))
    d.ellipse((size[0] // 2 - 32, int(size[1] * 0.50), size[0] // 2 + 32, int(size[1] * 0.50) + 20),
              fill=(190, 110, 100))
    d.text((20, 20), f"E2E {idx + 1}", fill=(60, 60, 60))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def post_multipart(path: str, fields: dict[str, str],
                   files: list[tuple[str, str, bytes]],
                   timeout: int = 120) -> tuple[int, bytes]:
    boundary = "----bhe2e" + uuid.uuid4().hex
    body = bytearray()
    for key, val in fields.items():
        body += f"--{boundary}\r\n".encode()
        body += f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode()
        body += val.encode() + b"\r\n"
    for key, name, data in files:
        body += f"--{boundary}\r\n".encode()
        body += f'Content-Disposition: form-data; name="{key}"; filename="{name}"\r\n'.encode()
        body += b"Content-Type: image/jpeg\r\n\r\n"
        body += data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()

    req = urllib.request.Request(BASE + path, data=bytes(body), method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def get_json(path: str) -> tuple[int, object]:
    try:
        with urllib.request.urlopen(BASE + path, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


def main() -> int:
    print("=" * 64)
    print(f"  E2E via {BASE} (vite proxy -> uvicorn)")
    print("=" * 64)

    # 1) 前端可达
    print("\n[1] frontend & proxy")
    try:
        with urllib.request.urlopen(BASE + "/", timeout=20) as r:
            html = r.read().decode(errors="replace")
        check("GET / (vite)", r.status == 200 and "BIGHEAD" in html, f"len={len(html)}")
    except Exception as e:
        check("GET / (vite)", False, repr(e))
        return 1

    st, health = get_json("/api/health")
    check("GET /api/health via proxy", st == 200 and isinstance(health, dict),
          str(health))

    st, meta = get_json("/api/meta")
    check("GET /api/meta via proxy", st == 200 and len(meta["filters"]) == 7, f"status={st}")

    # 2) 滤镜
    print("\n[2] filter preview over HTTP")
    src = make_face_jpeg(0)
    for preset in ("faded_90s", "bw_classic", "vhs"):
        st, body = post_multipart(
            "/api/preview/filter", {"preset": preset}, [("image", "a.jpg", src)]
        )
        ok = st == 200 and body[:2] == b"\xff\xd8"
        if ok:
            (EXPORTS / f"e2e_{preset}.jpg").write_bytes(body)
        check(f"filter {preset}", ok, f"status={st} {len(body)}B")

    st, _ = post_multipart("/api/preview/filter", {"preset": "nope"}, [("image", "a.jpg", src)])
    check("filter invalid -> 4xx", 400 <= st < 500, f"status={st}")

    # 3) 拍照
    print("\n[3] capture")
    imgs = [make_face_jpeg(i) for i in range(4)]
    st, body = post_multipart(
        "/api/capture/save", {}, [("images", f"p{i}.jpg", b) for i, b in enumerate(imgs)]
    )
    cap = json.loads(body)
    job_id = cap["job_id"]
    check("POST /api/capture/save", st == 200 and cap["count"] == 4, f"job={job_id} status={st}")

    root = Path(__file__).resolve().parent.parent
    photos = sorted((root / "outputs" / job_id).glob("photo_*.jpg"))
    check("4 photos written", len(photos) == 4, f"found={len(photos)}")

    # 4) 静态资源(前端要靠它显示缩略图)
    print("\n[4] static assets")
    st2, raw = None, b""
    try:
        with urllib.request.urlopen(f"{BASE}/outputs/{job_id}/photo_1.jpg", timeout=20) as r:
            st2, raw = r.status, r.read()
    except Exception as e:
        check("GET photo via proxy", False, repr(e))
    if st2:
        check("GET photo via proxy", st2 == 200 and raw[:2] == b"\xff\xd8", f"{len(raw)}B")

    # 5) 拼图
    print("\n[5] collage")
    files = [("images", p.name, p.read_bytes()) for p in photos]
    for lay, frame in (("2x2", "korean_pink"), ("strip", "polaroid"), ("6inch_4p", "plain_white")):
        st, body = post_multipart("/api/layout/make", {"layout": lay, "frame": frame}, files)
        ok = st == 200 and body[:2] == b"\xff\xd8"
        if ok:
            (EXPORTS / f"e2e_layout_{lay}.jpg").write_bytes(body)
        check(f"layout {lay}/{frame}", ok, f"status={st} {len(body)}B")

    # 6) 任务与画廊
    print("\n[6] job & gallery")
    st, js = get_json(f"/api/jobs/{job_id}")
    check("GET /api/jobs/<id>", st == 200 and isinstance(js, dict) and js.get("job_id") == job_id,
          f"status={js.get('status') if isinstance(js, dict) else st}")

    st, gal = get_json("/api/gallery")
    items = gal["items"]
    hit = [i for i in items if i["job_id"] == job_id]
    check("GET /api/gallery", st == 200 and len(hit) == 1, f"items={len(items)}")
    check("no internal dirs leaked",
          all(not i["job_id"].startswith(("_", ".")) for i in items),
          f"ids={[i['job_id'] for i in items][:5]}")

    # 7) AI 生成全链路(走真实 HTTP + WS 进度)
    if "--ai" in sys.argv:
        print("\n[7] AI generation over HTTP (+WS progress)")
        face = Path(sys.argv[sys.argv.index("--ai") + 1]) if len(sys.argv) > sys.argv.index("--ai") + 1 else None
        if not face or not face.exists():
            check("AI job", False, f"usage: --ai <face.jpg>, got {face}")
        else:
            st, body = post_multipart(
                "/api/capture/save", {}, [("images", "real.jpg", face.read_bytes())]
            )
            jid = json.loads(body)["job_id"]
            st, body = post_multipart(
                "/api/generate/start", {"job_id": jid, "style": "FILM_VELVIA", "steps": "20"},
                [], timeout=600,
            )
            ok = st == 200
            check("POST /api/generate/start", ok, f"status={st} {body[:120]}")
            if ok:
                deadline = time.time() + 600
                last = None
                while time.time() < deadline:
                    time.sleep(5)
                    _, js = get_json(f"/api/jobs/{jid}")
                    if isinstance(js, dict):
                        if js.get("status") != last:
                            print(f"    status={js.get('status')} "
                                  f"{js.get('current')}/{js.get('total')} {js.get('msg','')[:40]}",
                                  flush=True)
                            last = js.get("status")
                        if js.get("status") in ("done", "error"):
                            check("AI job finished", js.get("status") == "done",
                                  f"status={js.get('status')} msg={js.get('msg','')[:80]}")
                            print(f"    vram_peak={js.get('vram_peak_gb')}GB images={js.get('images')}")
                            break
                else:
                    check("AI job finished", False, "timeout after 600s")

    print("\n" + "=" * 64)
    print(f"  PASS: {len(PASS)}   FAIL: {len(FAIL)}")
    if FAIL:
        print("  failed -> " + ", ".join(FAIL))
    print("=" * 64)
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
