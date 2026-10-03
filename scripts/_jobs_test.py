"""Verify jobs._jobs eviction: bounded when stale, soft-cap inside TTL."""
import sys, time
sys.path.insert(0, r"f:\Trae-work\bighead")

from backend import jobs

print(f"_MAX_JOBS={jobs._MAX_JOBS}  _TTL_SECONDS={jobs._TTL_SECONDS}")
jobs._jobs.clear(); jobs._updated_at.clear()

# 1. normal use: well under cap, nothing evicted
ids = [jobs.new_job() for _ in range(50)]
assert len(jobs._jobs) == 50, len(jobs._jobs)
assert jobs.get(ids[0]) is not None
print(f"1. 50 jobs under cap        -> len={len(jobs._jobs)}  OK (nothing evicted)")

# 2. inside TTL: soft cap may be exceeded, but must NOT drop live jobs
for _ in range(400):
    jobs.new_job()
n = len(jobs._jobs)
print(f"2. 450 jobs, all fresh      -> len={n}  (soft cap, all recent jobs kept)")
assert jobs.get(ids[-1]) is not None, "fresh job must survive"
assert n >= 450 - 1

# 3. after TTL expires, stale entries get evicted down to the cap
past = time.time() - jobs._TTL_SECONDS - 10
for jid in list(jobs._jobs):
    jobs._updated_at[jid] = past
jobs.new_job()   # one write triggers eviction
after = len(jobs._jobs)
print(f"3. same set, now stale     -> len={after}  (evicted to cap={jobs._MAX_JOBS})")
assert after <= jobs._MAX_JOBS, after
assert after == jobs._MAX_JOBS, after

# 4. the write that triggered eviction is itself present
newest = jobs.new_job()
assert jobs.get(newest) is not None

# 5. update() refreshes recency, keeps images, and cannot exceed cap
jobs.update(newest, status="done", images=["a.jpg"] * 8)
got = jobs.get(newest)
assert got.status == "done" and len(got.images) == 8
print(f"4. update() on newest      -> status={got.status} images={len(got.images)}  OK")
print(f"5. len(_jobs)={len(jobs._jobs)} <= cap: {len(jobs._jobs) <= jobs._MAX_JOBS}")
assert len(jobs._jobs) <= jobs._MAX_JOBS

# 6. no orphan timestamps
orphan = set(jobs._updated_at) - set(jobs._jobs)
print(f"6. orphan _updated_at      -> {len(orphan)}")
assert len(orphan) <= 1

# 7. long-run simulation: 5000 jobs with time passing -> stays bounded
# 模拟时间流逝的正确做法:把已有条目的时间戳往前挪(用真实 now 做基准),
# 不能塞一个未来的时间 —— new_job() 里的 now 取自 time.time(),
# 混入合成时钟会让 now - updated_at 变成负数,谁都不会过期。
jobs._jobs.clear(); jobs._updated_at.clear()
for i in range(5000):
    jobs.new_job()
    if i % 50 == 0:
        # 假装又过去了 TTL + 1 秒
        cutoff = time.time() - jobs._TTL_SECONDS - 1
        for jid in list(jobs._jobs):
            jobs._updated_at[jid] = cutoff
final = len(jobs._jobs)
print(f"7. 5000 jobs over time     -> len={final}  (bounded: {final <= jobs._MAX_JOBS})")
assert final <= jobs._MAX_JOBS, final

print("\nALL JOBS CHECKS PASSED")
