#!/usr/bin/env python3
"""Per-run phase table from an H3 ComfyUI journal dump (journalctl -a -o short-unix).

pre   = got prompt -> text encoder prepared (VAE-encoding references for edits)
te    = text encoder prepared -> DiT prepared (TE upload + encode)
init  = first sampler step minus the steady step (DiT page-in)
steps = sampler steps (first + steady)
post  = sampler end -> prompt executed (VAE decode + PNG save)
"""
import re, sys
from datetime import datetime, timezone

txt = open(sys.argv[1], "rb").read().decode("utf-8", "replace")
t_from = float(sys.argv[2]) if len(sys.argv) > 2 else 0
pat = re.compile(r"^(\d+\.\d+) \S+ python\[\d+\]: (.*)$", re.S)
runs, cur = [], None
for ln in txt.split("\n"):
    m = pat.match(ln)
    if not m:
        continue
    t, msg = float(m.group(1)), m.group(2)
    if t < t_from:
        continue
    if "got prompt" in msg:
        cur = {"t0": t, "ev": []}
        runs.append(cur)
        continue
    if cur is None:
        continue
    cur["ev"].append((t, msg))
    if "Prompt executed in" in msg:
        cur["total"] = float(re.search(r"in ([\d.]+) sec", msg).group(1))
        cur["t1"] = t
        cur = None

print(f"{'start(UTC)':>9} {'total':>6} {'pre':>5} {'te':>5} {'step1':>6} {'steady':>6} {'n':>2} {'samp':>5} {'post':>5}")
for r in runs:
    if "total" not in r:
        continue
    ev = r["ev"]
    te = next((t for t, m in ev if "MiniMaxH3TEModel_ prepared" in m), None)
    dit = next((t for t, m in ev if "MiniMaxH3Image prepared" in m), None)
    comp = next((t for t, m in ev if "compiler graph breaks" in m and dit and t >= dit), None)
    first = steady = n = None
    for t, m in ev:
        for part in m.replace("\r", "\n").split("\n"):
            a = re.search(r"\b1/(\d+) \[[0-9:]+<[0-9:?]+,\s+([\d.]+)s/it", part)
            if a and first is None:
                first, n = float(a.group(2)), int(a.group(1))
            b = re.search(r"\b(\d+)/(\d+) \[[0-9:]+<[0-9:]+,\s+([\d.]+)s/it", part)
            if b and b.group(1) == b.group(2):
                steady = float(b.group(3))
    f = lambda v: "    -" if v is None else f"{v:5.1f}"
    when = datetime.fromtimestamp(r["t0"], timezone.utc).strftime("%H:%M:%S")
    pre = (te or dit or r["t1"]) - r["t0"]
    samp = comp - dit if comp and dit else None
    calc = (samp - first) / (n - 1) if samp and first and n and n > 1 else None
    print(f"{when:>9} {r['total']:6.1f} {f(pre)} {f(dit - te if te and dit else None)} {f(first):>6} {f(calc):>6} {n or '-':>2} "
          f"{f(samp)} {f(r['t1'] - comp if comp else None)}")
