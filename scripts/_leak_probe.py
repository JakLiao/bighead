"""Leak probe: real capture -> N generation cycles, sampling memory + server-side state."""
import json, subprocess, sys, time, urllib.request, urllib.parse, uuid, io, os

PID = 37152
BASE = "http://127.0.0.1:8000"
CYCLES = int(sys.argv[1]) if len(sys.argv) > 1 else 3
STEPS = sys.argv[2] if len(sys.argv) > 2 else "4"

src = None
for d in sorted(os.listdir(r"f:\Trae-work\bighead\outputs")):
    p = os.path.join(r"f:\Trae-work\bighead\outputs", d, "photo_1.jpg")
    if os.path.exists(p):
        src = p
        break
print("using seed photo:", src)


def mem():
    o = subprocess.run(["powershell", "-NoProfile", "-Command",
        f"$p=Get-Process -Id {PID};"
        f"'{{0:F2}}|{{1:F2}}|{{2}}' -f ($p.WorkingSet64/1GB),($p.PrivateMemorySize64/1GB),$p.Threads.Count"],
        capture_output=True, text=True)
    return o.stdout.strip()


def multipart(fields, files):
    b = uuid.uuid4().hex
    out = io.BytesIO()
    for k, v in fields.items():
        out.write(f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    for k, (fn, data, ct) in files.items():
        out.write(f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"; filename=\"{fn}\"\r\n".encode())
        out.write(f"Content-Type: {ct}\r\n\r\n".encode())
        out.write(data)
        out.write(b"\r\n")
    out.write(f"--{b}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={b}"


def post(url, body, ctype):
    req = urllib.request.Request(url, data=body, headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode()[:300]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]
    except Exception as e:
        return "ERR", str(e)[:200]


def get_json(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode())


# create job
data = open(src, "rb").read()
body, ctype = multipart({}, {"images": ("photo_1.jpg", data, "image/jpeg")})
st, resp = post(f"{BASE}/api/capture/save", body, ctype)
print("capture:", st, resp)
job = json.loads(resp)["job_id"]
print("job_id =", job)

print("\ncycle | WS_GB | Priv_GB | Thr | status")
print("-" * 44)
print(f"  0   |  {mem()}")
for c in range(1, CYCLES + 1):
    body, ctype = multipart({"job_id": job, "style": "PORTRAIT_HK", "steps": STEPS}, {})
    st, resp = post(f"{BASE}/api/generate/start", body, ctype)
    if st != 200:
        print(f"  {c}   | start {st} {resp}")
        break
    t0, last, peak = time.time(), None, (0.0, 0.0, 0)
    while time.time() - t0 < 1200:
        time.sleep(5)
        try:
            ws, pv, th = mem().split("|")
            if float(ws) > peak[0]:
                peak = (float(ws), float(pv), int(th))
        except Exception:
            pass
        try:
            last = get_json(f"{BASE}/api/jobs/{job}").get("status")
        except Exception:
            last = "?"
        if last in ("done", "error"):
            break
    print(f"  {c}   |  {peak[0]:.2f} |  {peak[1]:.2f}  | {peak[2]:>3} | {last}")
    time.sleep(6)
    print(f"  {c}   |  {mem()}  (settled, {last})")
print("\njob still in _jobs?", end=" ")
try:
    get_json(f"{BASE}/api/jobs/{job}")
    print("YES - retained forever (no eviction)")
except Exception:
    print("no")
