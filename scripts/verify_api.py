"""接口全量验证:覆盖所有 HTTP 端点 + WebSocket 进度推送.

与 smoke_test.py 的区别:本脚本不加载 AI 模型,只验证非 AI 全链路,
包括 smoke_test 未覆盖的画廊、静态文件服务与参数校验失败路径.
"""
from __future__ import annotations

import io
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from backend.app import app  # noqa: E402

EXPORTS = ROOT / "outputs" / "_verify"
EXPORTS.mkdir(parents=True, exist_ok=True)

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        PASS.append(name)
        print(f"  [PASS] {name} {detail}")
    else:
        FAIL.append(name)
        print(f"  [FAIL] {name} {detail}")


def make_face_like(idx: int, size=(640, 800)) -> bytes:
    """生成带肤色椭圆面部的测试图,尽量让 InsightFace 能检测到."""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", size, (232, 226, 214))
    d = ImageDraw.Draw(img)
    d.rectangle((0, int(size[1] * 0.62), size[0], size[1]), fill=(96, 104, 120))
    d.ellipse(
        (size[0] // 4, size[1] // 5, size[0] * 3 // 4, int(size[1] * 0.72)),
        fill=(226, 184, 158),
    )
    d.ellipse(
        (size[0] // 3, int(size[1] * 0.38), size[0] // 3 + 22, int(size[1] * 0.38) + 14),
        fill=(40, 40, 40),
    )
    d.ellipse(
        (size[0] * 2 // 3 - 22, int(size[1] * 0.38), size[0] * 2 // 3, int(size[1] * 0.38) + 14),
        fill=(40, 40, 40),
    )
    d.ellipse(
        (size[0] // 2 - 30, int(size[1] * 0.50), size[0] // 2 + 30, int(size[1] * 0.50) + 18),
        fill=(190, 110, 100),
    )
    d.text((20, 20), f"FACE {idx + 1}", fill=(60, 60, 60))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def main() -> int:
    print("=" * 64)
    print("  BigHead API full verification (no AI)")
    print("=" * 64)

    with TestClient(app) as client:
        # ---------------- health / meta ----------------
        print("\n[A] health & meta")
        r = client.get("/api/health")
        check("GET /api/health", r.status_code == 200, str(r.json()))
        r = client.get("/api/meta")
        m = r.json()
        check(
            "GET /api/meta",
            r.status_code == 200 and len(m["styles"]) == 4 and len(m["filters"]) == 7
            and len(m["frames"]) == 5 and len(m["layouts"]) == 5,
            f"styles={len(m['styles'])} filters={len(m['filters'])} "
            f"frames={len(m['frames'])} layouts={len(m['layouts'])}",
        )

        # ---------------- all filters ----------------
        print("\n[B] every filter preset")
        from backend.config import FILTERS

        src = make_face_like(0)
        for key in FILTERS:
            r = client.post(
                "/api/preview/filter",
                files={"image": ("a.jpg", src, "image/jpeg")},
                data={"preset": key},
            )
            ok = r.status_code == 200 and r.content[:2] == b"\xff\xd8"
            check(f"filter:{key}", ok, f"{len(r.content)}B")

        # ---------------- invalid preset ----------------
        print("\n[C] error handling")
        r = client.post(
            "/api/preview/filter",
            files={"image": ("a.jpg", src, "image/jpeg")},
            data={"preset": "does_not_exist"},
        )
        check(
            "filter:invalid preset rejected",
            r.status_code in (400, 404, 422, 500),
            f"status={r.status_code}",
        )
        r = client.get("/api/jobs/does-not-exist")
        check("GET /api/jobs/<bad id>", r.status_code in (404, 422), f"status={r.status_code}")

        # ---------------- capture + layout ----------------
        print("\n[D] capture & layout")
        files = [("images", (f"p{i}.jpg", make_face_like(i), "image/jpeg")) for i in range(4)]
        r = client.post("/api/capture/save", files=files)
        cap = r.json()
        job_id = cap["job_id"]
        check("POST /api/capture/save", r.status_code == 200 and cap["count"] == 4, f"job={job_id}")

        photo_paths = sorted((ROOT / "outputs" / job_id).glob("photo_*.jpg"))
        check("captured 4 files on disk", len(photo_paths) == 4, f"found {len(photo_paths)}")

        layout_files = [("images", (p.name, p.read_bytes(), "image/jpeg")) for p in photo_paths]
        for lay in ("2x2", "strip", "6inch_4p"):
            r = client.post(
                "/api/layout/make",
                files=layout_files,
                data={"layout": lay, "frame": "polaroid"},
            )
            ok = r.status_code == 200 and r.content[:2] == b"\xff\xd8"
            (EXPORTS / f"layout_{lay}.jpg").write_bytes(r.content)
            check(f"layout:{lay}", ok, f"{len(r.content)}B")

        r = client.post(
            "/api/layout/make",
            files=layout_files,
            data={"layout": "no_such_layout", "frame": "none"},
        )
        check("layout:invalid rejected", r.status_code in (400, 404, 422, 500), f"status={r.status_code}")

        # ---------------- job status ----------------
        print("\n[E] job status")
        r = client.get(f"/api/jobs/{job_id}")
        js = r.json()
        # 纯拍照任务不会推进状态机(只有 AI 生成会),这里只验证接口可用且字段完整
        need = {"job_id", "status", "current", "total", "msg", "images"}
        check(
            "GET /api/jobs/<id>",
            r.status_code == 200 and need.issubset(js.keys()) and js.get("job_id") == job_id,
            f"status={js.get('status')} nkeys={len(js)}",
        )

        # ---------------- gallery ----------------
        print("\n[F] gallery")
        r = client.get("/api/gallery")
        items = r.json()["items"]
        hit = [i for i in items if i["job_id"] == job_id]
        check("GET /api/gallery", r.status_code == 200 and len(items) > 0, f"items={len(items)}")
        check("gallery contains new job", len(hit) == 1 and len(hit[0]["thumbs"]) > 0,
              f"thumbs={hit[0]['thumbs'] if hit else None}")

        # ---------------- static output serving ----------------
        print("\n[G] static file serving")
        first = hit[0]["thumbs"][0] if hit else None
        if first:
            r = client.get(first)
            check("GET static thumb", r.status_code == 200 and r.content[:2] == b"\xff\xd8",
                  f"{first} {len(r.content)}B")
        else:
            check("GET static thumb", False, "no thumb url")

        # ---------------- websocket ----------------
        print("\n[H] websocket job progress")
        try:
            t0 = time.time()
            with client.websocket_connect(f"/ws/jobs/{job_id}") as wsock:
                got = []
                # 收到第一帧心跳即停止,避免空等 3 轮 15s 超时
                for _ in range(2):
                    frame = wsock.receive_json()
                    got.append(frame)
                    if frame.get("status") == "heartbeat":
                        break
            check(
                "WS /ws/jobs/<id> connects & streams",
                len(got) >= 1 and got[0].get("status") == "heartbeat",
                f"frames={got} in {time.time() - t0:.1f}s",
            )
        except Exception as e:
            check("WS /ws/jobs/<id> connects & streams", False, repr(e))

        # ---------------- generate endpoint (validation only) ----------------
        print("\n[I] generate endpoint schema")
        r = client.post("/api/generate/start", json={})
        check("POST /api/generate/start rejects empty body", r.status_code in (400, 422),
              f"status={r.status_code}")

    print("\n" + "=" * 64)
    print(f"  PASS: {len(PASS)}   FAIL: {len(FAIL)}")
    if FAIL:
        print("  failed -> " + ", ".join(FAIL))
    print("=" * 64)
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
