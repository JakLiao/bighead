"""Empirical leak probe: drive real generations, sample WS/Private each cycle."""
import json, subprocess, sys, time, urllib.request, urllib.parse

PID = 37152
BASE = "http://127.0.0.1:8000"
JOB = sys.argv[1] if len(sys.argv) > 1 else "07e0f132b93d"
CYCLES = int(sys.argv[2]) if len(sys.argv) > 2 else 3
STEPS = sys.argv[3] if len(sys.argv) > 3 else "4"


def mem():
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         f"$p=Get-Process -Id {PID}; "
         "'{0:N2} {1:N2} {2}' -f ($p.WorkingSet64/1GB),($p.PrivateMemorySize64/1GB),$p.Threads.Count"],
        capture_output=True, text=True)
    return out.stdout.strip()


def post(url, fields):
    data = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(url, data=data)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()[:200]
    except Exception as e:
        return "ERR", str(e)[:200]


def get_json(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode())


print(f"probing PID={PID} job={JOB} cycles={CYCLES} steps={STEPS}")
print("cycle    WS_GB  Priv_GB  Thr  status")
print("-" * 46)
print(f"base     {mem()}")

for c in range(1, CYCLES + 1):
    st, body = post(f"{BASE}/api/generate/start",
                    {"job_id": JOB, "style": "PORTRAIT_HK", "steps": STEPS})
    if st == "ERR":
        print(f"{c}  start failed: {body}")
        break
    peak = (0.0, 0.0, 0)
    t0 = time.time()
    last = None
    while time.time() - t0 < 900:
        time.sleep(4)
        cur = mem()
        try:
            ws, pv, th = [float(x) for x in cur.split()]
            if ws > peak[0]:
                peak = (ws, pv, int(th))
        except Exception:
            pass
        try:
            j = get_json(f"{BASE}/api/jobs/{JOB}")
            last = j.get("status")
        except Exception:
            last = "gone"
        if last in ("done", "error"):
            break
    print(f"{c}  peak {peak[0]:.2f} {peak[1]:.2f} {peak[2]}  {last}")
    time.sleep(5)
    print(f"  after {mem()}  {last}")
