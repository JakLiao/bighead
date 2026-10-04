"""端到端验证 AI 生成:全新 job,模拟前端真实时序(先 POST 再连 WS)。"""
import asyncio, json, os, time, urllib.request, uuid, io
from pathlib import Path
ROOT = Path(r"F:\Trae-work\bighead")
BASE = os.environ.get("BIGHEAD_API_TARGET", "http://127.0.0.1:8077").rstrip("/")
SRC = ROOT / "outputs" / "07e0f132b93d"

def multipart(fields, files):
    b = uuid.uuid4().hex
    out = io.BytesIO()
    for k, v in fields.items():
        out.write(f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    for field, fn, content in files:
        out.write(f"--{b}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{fn}\"\r\n".encode())
        out.write(b"Content-Type: image/jpeg\r\n\r\n")
        out.write(content)
        out.write(b"\r\n")
    out.write(f"--{b}--\r\n".encode())
    return bytes(out.getvalue()), f"multipart/form-data; boundary={b}"

# 1. 新建拍摄任务(等同前端 saveCaptures)
photos = sorted(SRC.glob("photo_*.jpg"))[:4]
body, ct = multipart({}, [("images", p.name, p.read_bytes()) for p in photos])
req = urllib.request.Request(BASE + "/api/capture/save", data=body, headers={"Content-Type": ct})
with urllib.request.urlopen(req, timeout=60) as r:
    job = json.loads(r.read())["job_id"]
print(f"1. new job = {job}  (photos={len(photos)})")

# 2. 严格按前端顺序:先 startGeneration,再 setCurrentJobId 连 WS
body, ct = multipart({"job_id": job, "style": "FILM_VELVIA"}, [])
req = urllib.request.Request(BASE + "/api/generate/start", data=body, headers={"Content-Type": ct})
urllib.request.urlopen(req, timeout=10).close()
print("2. generation triggered (WS not yet connected -- the racy order)")

async def watch():
    import websockets
    got, t0 = [], time.time()
    ws_base = BASE.replace("http", "ws", 1)
    async with websockets.connect(f"{ws_base}/ws/jobs/{job}") as s:
        try:
            while True:
                m = json.loads(await asyncio.wait_for(s.recv(), timeout=150))
                st = m.get("status")
                if st == "heartbeat": continue
                got.append(st)
                print(f"   [{time.time()-t0:5.1f}s] <- {st} current={m.get('current')}/{m.get('total')} images={len(m.get('images') or [])}")
                if st in ("done", "error"): break
        except asyncio.TimeoutError:
            print("   TIMEOUT waiting for progress")
    return got

got = asyncio.run(watch())
print(f"\n3. received: {got}")
print(f"4. job state: ", end="")
with urllib.request.urlopen(f"{BASE}/api/jobs/{job}", timeout=15) as r:
    j = json.loads(r.read())
print(f"status={j['status']} current={j['current']}/{j['total']} images={len(j['images'])} style={j.get('style')}")
ok = "done" in got and j["status"] == "done" and len(j["images"]) == len(photos)
print(f"\nRESULT: {'PASS - 前端即使晚连也能拿到终态' if ok else 'FAIL'}")


