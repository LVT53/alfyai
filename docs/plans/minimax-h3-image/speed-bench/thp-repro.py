"""Does NumPy's MADV_HUGEPAGE on large arrays stall in kernel compaction on this host?

Mimics ComfyUI's PreviewImage.save_images for a 12 MP picture: a float32 image, 255 * x, clip,
astype(uint8). Runs the same work with NumPy's huge-page hint on and off and reports wall time,
kernel (sys) time and the host's compaction counters for each. ~0.5 GB of RAM for a few seconds.
"""
import os, sys, time
import numpy as np

try:
    set_hp = np._core.multiarray._set_madvise_hugepage
except AttributeError:  # numpy 1.x
    set_hp = np.core.multiarray._set_madvise_hugepage

KEYS = ("compact_stall", "compact_fail", "compact_success", "compact_migrate_scanned", "compact_free_scanned",
        "thp_fault_alloc", "thp_fault_fallback", "allocstall_movable", "pgfault")


def vmstat():
    out = {}
    for line in open("/proc/vmstat"):
        k, v = line.split()
        if k in KEYS:
            out[k] = int(v)
    return out


def work():
    img = np.empty((2816, 4224, 3), dtype=np.float32)   # what VAEDecode hands PreviewImage, 143 MB
    img.fill(0.5)
    i = 255.0 * img                                      # 143 MB
    arr = np.clip(i, 0, 255).astype(np.uint8)           # 143 MB, then 36 MB
    s = int(arr[::997, ::991].sum())
    del img, i, arr
    return s


def trial(hugepage):
    set_hp(hugepage)
    v0, t0, c0 = vmstat(), time.perf_counter(), os.times()
    work()
    v1, t1, c1 = vmstat(), time.perf_counter(), os.times()
    d = {k: v1[k] - v0[k] for k in KEYS}
    return round(t1 - t0, 3), round(c1.system - c0.system, 3), round(c1.user - c0.user, 3), d


print("numpy", np.__version__, "THP", open("/sys/kernel/mm/transparent_hugepage/enabled").read().strip(),
      "defrag", open("/sys/kernel/mm/transparent_hugepage/defrag").read().strip())
for rnd in range(3):
    for hp in (True, False):
        wall, sys_s, usr_s, d = trial(hp)
        print(f"round {rnd} hugepage={'on ' if hp else 'off'} wall {wall:6.3f} s  sys {sys_s:6.3f} s  user {usr_s:6.3f} s  "
              f"compact_stall +{d['compact_stall']} fail +{d['compact_fail']} migrate_scanned +{d['compact_migrate_scanned']} "
              f"free_scanned +{d['compact_free_scanned']} thp_alloc +{d['thp_fault_alloc']} thp_fallback +{d['thp_fault_fallback']} "
              f"allocstall +{d['allocstall_movable']}", flush=True)
