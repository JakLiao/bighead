"""验证 worker 的 JSON 协议通道是否可靠(不加载模型, 秒级完成)。

为什么单独测: 之前怀疑「协议被第三方库污染」导致父进程永远等不到回包,
但那是个假设。这里用一个会**主动往 stdout 疯狂写日志**的假 worker 来复现
污染场景, 确认 send() 用裸 fd 就不会被冲掉。

真实场景的污染源:
  - transformers 的 "Loading weights: 53%|...| 366/729 [00:23<00:24, ...]"
  - tqdm 进度条
  - diffusers 的 RuntimeWarning
这些都写 fd 1(重定向前是 stdout)。如果 send() 走 sys.stdout 就会被夹在
中间, 父进程 json.loads 失败 -> 死等。

用法: <python> scripts/_test_qwen_protocol.py
"""
from __future__ import annotations

import json
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent

FAKE_WORKER = r'''
import json, os, sys, time
_FD = os.fdopen(os.dup(1), "wb", buffering=0)
def send(o):
    _FD.write((json.dumps(o, ensure_ascii=False) + "\n").encode("utf-8"))
def reply(req, o):
    o["rid"] = req.get("rid")
    send(o)
def dirty(msg):
    # 直接写 fd 1 —— 模拟 C 扩展(tqdm/transformers 进度条)的写法,
    # 这是最凶的污染: 绕过 Python 的 sys.stdout 重定向。
    os.write(1, (msg + "\n").encode("utf-8"))

send({"ok": True, "event": "boot", "pid": os.getpid()})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    op = req.get("op")
    if op == "pollute":
        for i in range(50):
            dirty(f"Loading weights: {i*2:3d}%|##      | {i*3}/729 [00:{i:02d}<00:20, {i}.1fit/s]")
        for i in range(10):
            dirty("\rProgress: 45%|####5     | 45/100")
        sys.stderr.write("--- 以上是污染, 下面才是协议 ---\n")
        reply(req, {"ok": True, "event": "ready", "lora_layers": 720})
    elif op == "gen":
        # 生成途中继续污染, 模拟真实推理时 transformers/diffusers 的零散输出
        for i in range(20):
            dirty(f"  step {i+1}/4 latent noise cleanup {i}")
        reply(req, {"ok": True, "event": "done", "seconds": 27.4, "peak_gb": 14.5})
    elif op == "slow":
        dirty("working ... no reply for this one")
    elif op == "boom":
        reply(req, {"ok": False, "error": "CUDA out of memory", "trace": "line1\nline2"})
    elif op == "shutdown":
        reply(req, {"ok": True, "event": "bye"}); break
'''


def main() -> int:
    wp = PROJECT / "outputs" / "_qwen_tmp" / "fake_worker.py"
    wp.parent.mkdir(parents=True, exist_ok=True)
    wp.write_text(FAKE_WORKER, encoding="utf-8")

    print("起假 worker (它会主动往 stdout 写 50 行进度条) ...", flush=True)
    proc = subprocess.Popen(
        [sys.executable, "-u", str(wp)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, encoding="utf-8", bufsize=1,
    )

    # 整个生命周期只有**一个** reader 线程。多线程抢同一个 BufferedReader
    # 会把行切碎, 那才是假的 bug。
    q: queue.Queue = queue.Queue()
    stats = {"lines": 0, "noise": 0}
    n = [0]

    def _reader() -> None:
        try:
            for line in proc.stdout:
                q.put(line)
        finally:
            q.put(None)

    threading.Thread(target=_reader, daemon=True, name="reader").start()

    def rpc(req: dict, timeout: float = 30.0) -> dict:
        """与 QwenPipeline._rpc 同逻辑: rid 匹配 + 队列超时。"""
        n[0] += 1
        rid = f"{n[0]:x}"
        req = {**req, "rid": rid}
        proc.stdin.write(json.dumps(req) + "\n")
        proc.stdin.flush()
        seen: list[str] = []
        t0 = time.time()
        while time.time() - t0 < timeout:
            try:
                line = q.get(timeout=0.5)
            except queue.Empty:
                continue
            if line is None:
                raise RuntimeError(f"EOF(worker 退出), 已读 {len(seen)} 行")
            line = line.strip()
            if not line:
                continue
            stats["lines"] += 1
            seen.append(line[:120])
            if not line.startswith("{"):
                stats["noise"] += 1
                continue
            try:
                resp = json.loads(line)
            except Exception:
                stats["noise"] += 1
                continue
            got = resp.get("rid")
            if not got:
                continue          # 主动推送(boot)
            if got != rid:
                continue          # 迟到的旧应答
            if not resp.get("ok", False):
                raise RuntimeError(f"worker 报错: {resp.get('error')}")
            return resp
        raise TimeoutError(f"未回包(rid={rid}), 已读 {len(seen)} 行, 末尾: {seen[-3:]}")

    t0 = time.time()
    r = rpc({"op": "pollute"})
    print(f"  pollute -> ready  {r}   ({time.time() - t0:.1f}s)")
    assert r.get("lora_layers") == 720, "lora_layers 丢了"

    t0 = time.time()
    r = rpc({"op": "gen"})
    print(f"  gen -> done       {r}   ({time.time() - t0:.1f}s)")
    assert r.get("seconds") == 27.4, "seconds 丢了"
    assert r.get("peak_gb") == 14.5, "peak_gb 丢了"

    # 回归: 之前 warmup 的 ready 应答被当成"主动通知"跳过 -> 父进程永久
    # 阻塞。这里用一个**永不回复**的请求验证超时是真的会触发的。
    t0 = time.time()
    try:
        rpc({"op": "slow"}, timeout=3.0)
        raise AssertionError("slow 请求不该返回")
    except TimeoutError as e:
        print(f"  slow  -> 超时生效  ({time.time() - t0:.1f}s)  {str(e)[:60]}...")

    try:
        rpc({"op": "boom"})
        raise AssertionError("boom 请求不该成功")
    except RuntimeError as e:
        assert "out of memory" in str(e), e
        print(f"  boom  -> 错误透传  {str(e)[:60]}")

    # 上一条 boom 是失败应答, 队列里不能残留垃圾影响后续请求
    t0 = time.time()
    r = rpc({"op": "gen"})
    print(f"  gen   -> 仍正常   {r}   ({time.time() - t0:.1f}s)")

    proc.stdin.write('{"op":"shutdown","rid":"ff"}\n')
    proc.stdin.flush()
    proc.wait(timeout=10)

    print(f"\n共读到 {stats['lines']} 行, 其中 {stats['noise']} 行是非协议噪声")
    assert stats["noise"] >= 80, f"噪声行太少({stats['noise']}), 污染场景没复现"
    print("PASS: 裸 fd 协议在 stdout 被污染的情况下依然可靠, 且超时/错误都生效")
    return 0


if __name__ == "__main__":
    sys.exit(main())
