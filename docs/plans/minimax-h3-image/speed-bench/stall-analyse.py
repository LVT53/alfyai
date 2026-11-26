#!/usr/bin/env python3
"""Join the stall sampler's samples with the H3 journal: what the worker did in each phase of each job.

usage: stall-analyse.py <samples.jsonl> <journal (journalctl -a -o short-unix)>
"""
import collections, json, re, sys

HZ = 100.0
samples = []
for line in open(sys.argv[1]):
    line = line.strip()
    if line.startswith("{"):
        try:
            samples.append(json.loads(line))
        except Exception:
            pass
if not samples:
    sys.exit("no samples")
t_lo, t_hi = samples[0]["t"], samples[-1]["t"]

pat = re.compile(r"^(\d+\.\d+) \S+ python\[\d+\]: (.*)$", re.S)
jobs, cur = [], None
for ln in open(sys.argv[2], "rb").read().decode("utf-8", "replace").split("\n"):
    m = pat.match(ln)
    if not m:
        continue
    t, msg = float(m.group(1)), m.group(2)
    if "got prompt" in msg:
        cur = {"t0": t, "ev": []}
        jobs.append(cur)
    elif cur is not None:
        cur["ev"].append((t, msg))
        if "Prompt executed in" in msg:
            cur["t1"] = t
            cur = None


def phases(job):
    ev = job["ev"]
    te = next((t for t, m in ev if "MiniMaxH3TEModel_ prepared" in m), None)
    dit = next((t for t, m in ev if "MiniMaxH3Image prepared" in m), None)
    samp_end = next((t for t, m in ev if "compiler graph breaks" in m and dit and t >= dit), None)
    marks = [("pre", job["t0"], te or dit), ("te", te, dit), ("sample", dit, samp_end), ("post", samp_end, job.get("t1"))]
    return [(n, a, b) for n, a, b in marks if a and b and b > a]


def summarise(a, b):
    ss = [s for s in samples if a < s["t"] <= b + 0.13]
    if not ss:
        return None
    states = collections.Counter(s.get("w", {}).get("s", "?") for s in ss)
    ut = sum(s.get("w", {}).get("ut", 0) for s in ss) / HZ
    st = sum(s.get("w", {}).get("st", 0) for s in ss) / HZ
    mn = sum(s.get("w", {}).get("mn", 0) for s in ss)
    mj = sum(s.get("w", {}).get("mj", 0) for s in ss)
    out_ut = sum(s["o"]["ut"] for s in ss) / HZ
    out_st = sum(s["o"]["st"] for s in ss) / HZ
    rb = sum(s["io"].get("read_bytes", 0) for s in ss) >> 20
    rc = sum(s["io"].get("rchar", 0) for s in ss) >> 20
    wb = sum(s["io"].get("write_bytes", 0) for s in ss) >> 20
    cgk = {k: sum(s["cg"].get(k, 0) for s in ss) for k in ("pgfault", "pgmajfault", "pgscan_direct", "pgscan_kswapd", "workingset_refault_file", "max_events")}
    wchans = collections.Counter(s["w"].get("wchan", "") for s in ss if s.get("w", {}).get("wchan"))
    stacks = collections.Counter(" < ".join(f.split("+")[0] for f in s["w"]["kstack"][:4]) for s in ss if s.get("w", {}).get("kstack"))
    mem = ss[-1]["mem"]
    return dict(secs=round(b - a, 1), states=dict(states), worker_user_s=round(ut, 1), worker_sys_s=round(st, 1),
                minflt=mn, majflt=mj, others_user_s=round(out_ut, 1), others_sys_s=round(out_st, 1),
                read_MB=rb, rchar_MB=rc, write_MB=wb, cg=cgk, wchan=wchans.most_common(3),
                kstack=stacks.most_common(4), mem_end=mem)


for job in jobs:
    if job["t0"] < t_lo or "t1" not in job or job["t1"] > t_hi:
        continue
    total = job["t1"] - job["t0"]
    print(f"\n=== job at {job['t0']:.0f} ({total:.1f} s)")
    for name, a, b in phases(job):
        s = summarise(a, b)
        if not s:
            continue
        flag = "  <-- STALL" if name in ("pre", "post") and s["secs"] > 3 else ""
        print(f"  {name:6s} {s['secs']:5.1f} s  states {s['states']}  worker user {s['worker_user_s']} s sys {s['worker_sys_s']} s  "
              f"minflt {s['minflt']} majflt {s['majflt']}  others user {s['others_user_s']} sys {s['others_sys_s']}  "
              f"disk read {s['read_MB']} MB (rchar {s['rchar_MB']} MB) write {s['write_MB']} MB{flag}")
        print(f"         cgroup {s['cg']}  mem {s['mem_end']}")
        if s["wchan"]:
            print(f"         wchan {s['wchan']}")
        for stk, n in s["kstack"]:
            print(f"         kstack x{n}: {stk}")
