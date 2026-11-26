import re, sys, statistics as st
from datetime import datetime, timezone
path = sys.argv[1]
runs = []; cur = None
pat = re.compile(r'^(\d+\.\d+) \S+ python\[(\d+)\]: (.*)$')
for line in open(path, errors='replace'):
    m = pat.match(line.rstrip('\n'))
    if not m: continue
    t, pid, msg = float(m.group(1)), m.group(2), m.group(3)
    if 'got prompt' in msg:
        cur = dict(pid=pid, t0=t, ev=[])
        runs.append(cur); continue
    if cur is None or cur['pid'] != pid: continue
    cur['ev'].append((t, msg))
    if 'Prompt executed in' in msg:
        cur['total'] = float(re.search(r'in ([\d.]+) seconds', msg).group(1)); cur['t1'] = t; cur = None
rows = []
for r in runs:
    if 'total' not in r: continue
    ev = r['ev']
    def first(sub, after=0.0):
        for t, m in ev:
            if sub in m and t >= after: return t
        return None
    te = first('MiniMaxH3TEModel_ prepared')
    dit = first('MiniMaxH3Image prepared')
    comp = first('Comfy model compiler graph breaks', dit or 0) if dit else None
    ltx = any('LTX' in m or 'VideoVAE' in m for _, m in ev)
    unl = sum(1 for _, m in ev if 'Unloaded partially' in m)
    err = any('ERROR' in m for _, m in ev)
    rows.append(dict(pid=r['pid'], when=datetime.fromtimestamp(r['t0'], timezone.utc).strftime('%m-%d %H:%M:%S'),
        total=r['total'], te=(dit - te) if (te and dit) else None, pre=((te or dit or r['t1']) - r['t0']),
        samp=(comp - dit) if (dit and comp) else None, post=(r['t1'] - comp) if comp else None, ltx=ltx, unl=unl, err=err))
for x in rows:
    f = lambda v: '   -  ' if v is None else f'{v:6.1f}'
    print(f"{x['pid']:>8} {x['when']} total {x['total']:6.1f} | pre {f(x['pre'])} te {f(x['te'])} samp {f(x['samp'])} post {f(x['post'])} {'LTX' if x['ltx'] else ''}{' unl'+str(x['unl']) if x['unl'] else ''}{' ERR' if x['err'] else ''}")
