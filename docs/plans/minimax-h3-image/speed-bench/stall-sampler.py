#!/usr/bin/env python3
"""Passive sampler for the H3 ComfyUI server's CPU-side stalls (reads /proc and the cgroup only).

usage: stall-sampler.py <pid> <worker_tid> <seconds> <interval>
Prints one JSON line per sample: the worker thread's state, CPU and faults, the busiest other
threads, process disk I/O, the service cgroup's memory counters, and (as root) the worker's kernel
stack whenever it spends kernel time. Writes nothing to disk.
"""
import json, os, sys, time

PID, WORKER, DUR, IVL = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
CG = "/sys/fs/cgroup/system.slice/comfyui-h3.service"
STAT_KEYS = ("anon", "file", "file_mapped", "pgfault", "pgmajfault", "pgscan_direct", "pgsteal_direct",
             "pgscan_kswapd", "workingset_refault_file", "workingset_refault_anon", "file_writeback", "file_dirty")


def rd(path):
    try:
        with open(path) as f:
            return f.read()
    except Exception:
        return ""


def tstat(tid):
    s = rd(f"/proc/{PID}/task/{tid}/stat")
    if not s:
        return None
    rest = s[s.rindex(")") + 2:].split()
    # field 3 state, 10 minflt, 12 majflt, 14 utime, 15 stime
    return rest[0], int(rest[7]), int(rest[9]), int(rest[11]), int(rest[12])


def cg():
    out = {}
    for line in rd(f"{CG}/memory.stat").splitlines():
        k, _, v = line.partition(" ")
        if k in STAT_KEYS:
            out[k] = int(v)
    out["current"] = int(rd(f"{CG}/memory.current") or 0)
    for line in rd(f"{CG}/memory.events").splitlines():
        k, _, v = line.partition(" ")
        if k == "max":
            out["max_events"] = int(v)
    return out


def pio():
    out = {}
    for line in rd(f"/proc/{PID}/io").splitlines():
        k, _, v = line.partition(": ")
        if k in ("rchar", "wchar", "read_bytes", "write_bytes"):
            out[k] = int(v)
    return out


is_root = os.geteuid() == 0
prev_t, prev_cg, prev_io = {}, cg(), pio()
for tid in os.listdir(f"/proc/{PID}/task"):
    st = tstat(int(tid))
    if st:
        prev_t[int(tid)] = st
end = time.time() + DUR
while time.time() < end:
    time.sleep(IVL)
    now = time.time()
    cur_t, deltas = {}, []
    for tid in os.listdir(f"/proc/{PID}/task"):
        tid = int(tid)
        st = tstat(tid)
        if not st:
            continue
        cur_t[tid] = st
        p = prev_t.get(tid, st)
        d = (st[0], st[1] - p[1], st[2] - p[2], st[3] - p[3], st[4] - p[4])
        if tid == WORKER or d[3] + d[4] > 0 or st[0] in "RD":
            deltas.append((tid, d))
    prev_t = cur_t
    c, io = cg(), pio()
    w = next((d for tid, d in deltas if tid == WORKER), None)
    rec = {"t": round(now, 3)}
    if w:
        rec["w"] = {"s": w[0], "ut": w[3], "st": w[4], "mn": w[1], "mj": w[2]}
        if w[0] != "R":
            rec["w"]["wchan"] = rd(f"/proc/{PID}/task/{WORKER}/wchan")
        if is_root and (w[4] > 0 or w[0] == "D"):
            rec["w"]["kstack"] = [ln.split(" ", 1)[-1] for ln in rd(f"/proc/{PID}/task/{WORKER}/stack").splitlines()[:8]]
    others = sorted((x for x in deltas if x[0] != WORKER), key=lambda x: -(x[1][3] + x[1][4]))
    agg_ut = sum(d[3] for _, d in others)
    agg_st = sum(d[4] for _, d in others)
    rec["o"] = {"n": len(others), "ut": agg_ut, "st": agg_st,
                "top": [[tid, d[0], d[3], d[4], d[1], d[2]] for tid, d in others[:4] if d[3] + d[4] > 0]}
    rec["io"] = {k: io.get(k, 0) - prev_io.get(k, 0) for k in io}
    rec["cg"] = {k: c.get(k, 0) - prev_cg.get(k, 0) for k in ("pgfault", "pgmajfault", "pgscan_direct", "pgsteal_direct",
                                                               "pgscan_kswapd", "workingset_refault_file", "max_events")}
    rec["mem"] = {"cur_mb": c.get("current", 0) >> 20, "anon_mb": c.get("anon", 0) >> 20, "file_mb": c.get("file", 0) >> 20,
                  "mapped_mb": c.get("file_mapped", 0) >> 20, "dirty_mb": c.get("file_dirty", 0) >> 20,
                  "wb_mb": c.get("file_writeback", 0) >> 20}
    prev_cg, prev_io = c, io
    print(json.dumps(rec, separators=(",", ":")), flush=True)
