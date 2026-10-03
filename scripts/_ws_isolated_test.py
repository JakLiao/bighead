"""Isolated verification of the ws.broadcast bound-queue fix.

No SDXL, no HTTP: drives backend.ws directly so the measurement
reflects the queue fix alone.

Before fix: 200 undrained subscribers x 2000 broadcasts -> unbounded growth.
After  fix: each queue is capped at _QUEUE_MAXSIZE.
"""
import asyncio, sys
sys.path.insert(0, r"f:\Trae-work\bighead")

from backend import ws

N_SUBS = 200
N_MSGS = 2000
JOB = "leaktest"


def total_msgs(qs):
    return sum(q.qsize() for q in qs)


async def main():
    qs = [await ws.subscribe(JOB) for _ in range(N_SUBS)]
    print(f"subscribed {N_SUBS} queues; key exists={JOB in ws._connections}")
    print(f"job list identity stable: {ws._connections[JOB] is not None}")

    for i in range(N_MSGS):
        await ws.broadcast(JOB, {"status": "running", "current": i, "total": N_MSGS,
                                 "msg": "x" * 512})
        if i == 0:
            print(f"after 1 broadcast  -> per-queue depth={qs[0].qsize()}")
        if i == 99:
            print(f"after 100 bcasts  -> per-queue depth={qs[0].qsize()}")

    depth = qs[0].qsize()
    total = total_msgs(qs)
    print(f"after {N_MSGS} broadcasts -> per-queue depth={depth}, total buffered={total}")
    print(f"maxsize enforced (depth == _QUEUE_MAXSIZE): {depth == ws._QUEUE_MAXSIZE}")
    print(f"BOUNDED: {depth <= ws._QUEUE_MAXSIZE}")
    before = total
    # new messages still flow: drop-oldest keeps latest, does not block
    await ws.broadcast(JOB, {"status": "done"})
    print(f"post-done depth={qs[0].qsize()} (no growth past cap: {qs[0].qsize() <= ws._QUEUE_MAXSIZE})")

    # verify newest message is the one retained (drop-oldest semantics)
    got = []
    while not qs[0].empty():
        got.append(qs[0].get_nowait())
    import json
    last = json.loads(got[-1])
    print(f"newest retained status={last['status']!r} (expect 'done')")

    for q in qs:
        await ws.unsubscribe(JOB, q)
    print(f"all unsubscribed -> job key still present: {JOB in ws._connections}")
    print(f"EMPTY KEY REMOVED: {JOB not in ws._connections}")
    print(f"_connections size after cleanup: {len(ws._connections)}")
    print(f"total buffered was {before} across {N_SUBS} queues "
          f"(unbounded would be {N_SUBS * N_MSGS})")

asyncio.run(main())
