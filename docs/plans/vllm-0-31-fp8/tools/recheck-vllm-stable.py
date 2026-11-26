#!/usr/bin/env python3
"""Re-check recipe for a new vLLM stable (Flash-Next on alfyroot).

Usage:  python3 docs/plans/vllm-0-31-fp8/tools/recheck-vllm-stable.py [vX.Y.Z]

Needs `gh` (logged in) and network; standard library only. Prints the PyPI upload date and cadence, the GitHub
release object, the dependency pins, and a watch list: each item's state, whether its merged change is inside the
tag (compare against the merge commit AND a check that the PR's added lines are present in the files at the tag,
which also covers cherry-picks), plus file-level proof for CSF scale decoding and NVFP4 PLE.
Reading the "code k/t" column: it counts how many distinctive added lines of the PR appear verbatim in the same files at
the tag. Near t/t means the change is there (a cherry-pick shows `compare diverged` but a full code ratio); a low ratio
such as 1/12 is noise from common lines and means absent. Mixed values (say 6/14) need a look at the files.
Edit WATCH when the picture changes. Written 2026-11-04 for the 0.33.0 re-check (known answers at v0.33.0: #56273 ahead
and 21/21, #64312 diverged and 1/12, 0 `csf` lines); see model-variants-recheck-2026-11-04.md.
"""
import datetime, json, re, statistics, subprocess, sys, urllib.request

REPO = "repos/vllm-project/vllm"

# (number, what it is). Issues work too (state only).
WATCH = [
    (56273, "packed NVFP4 PLE (merged 2026-10-14, in 0.33.0)"),
    (64312, "CSF-compressed NVFP4 scales in ModelOpt (merged to main 2026-11-03)"),
    (64739, "find shards listed in a subdirectory (FP4-Local keeps them in tensors/)"),
    (64869, "weights mapper may transform weights (the #64739 tester needed it)"),
    (64753, "keep CSF expert scales resident on B12X"),
    (60646, "CSF decode, closed 2026-10-30 as superseded by #64312"),
    (60490, "QSA indexer prefill workspace in memory profiling (OOM risk at util 0.94)"),
    (62318, "quantized q/k/v + BF16 QSA indexer"),
    (60234, "pipeline parallelism for PLE models"),
    (62409, "fix: prefill crossing 262,144 with MTP + cudagraphs"),
    (62383, "ISSUE crash on prefill crossing 262,144 with MTP"),
    (59848, "exact-size pinned PLE (pinned RAM rounding)"),
    (60909, "generic empty_pinned"),
    (58863, "MTP RecoverSSM"),
    (59366, "MTP RecoverSSM fused"),
    (54846, "NVFP4 KV on QSA"),
    (64199, "NVFP4 main KV via FlashInfer"),
    (55357, "ISSUE MTP 0% acceptance episodes"),
    (63755, "recipe: RadixArk NVFP4 on 1x RTX PRO 6000"),
]


def gh(path, raw=False):
    cmd = ["gh", "api"] + (["-H", "Accept: application/vnd.github.raw"] if raw else []) + [path]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        return None
    return r.stdout if raw else json.loads(r.stdout)


def added_lines_present(pr, tag):
    """How many distinctive lines the PR adds are present, verbatim, in the same files at `tag`."""
    files = gh(f"{REPO}/pulls/{pr}/files?per_page=100") or []
    total = found = 0
    for f in files:
        name = f["filename"]
        if name.startswith(("tests/", "docs/")) or not name.endswith(".py") or "patch" not in f:
            continue
        lines = [l[1:].strip() for l in f["patch"].split("\n") if l.startswith("+") and not l.startswith("+++")]
        lines = [l for l in lines if len(l) >= 35 and not l.startswith(("#", '"""', "'''"))][:6]
        if not lines:
            continue
        text = gh(f"{REPO}/contents/{name}?ref={tag}", raw=True) or ""
        total += len(lines)
        found += sum(1 for l in lines if l in text)
    return found, total


pj = json.load(urllib.request.urlopen(urllib.request.Request("https://pypi.org/pypi/vllm/json", headers={"User-Agent": "curl/8.7.1"}), timeout=40))
up = lambda v: min((f["upload_time_iso_8601"] for f in pj["releases"].get(v, [])), default="")
stables = sorted((v for v in pj["releases"] if re.fullmatch(r"\d+\.\d+\.0", v) and pj["releases"][v]), key=up)[-7:]
print("PyPI x.y.0 uploads:", [(v, up(v)[:10]) for v in stables])
dates = [datetime.datetime.fromisoformat(up(v)[:19]) for v in stables]
gaps = [(b - a).days for a, b in zip(dates, dates[1:])]
nxt = dates[-1] + datetime.timedelta(days=round(statistics.median(gaps)))
print(f"cadence gaps (days): {gaps}; next x.y.0 expected about {nxt.date()} (inferred, not announced)")
latest = pj["info"]["version"]
tag = sys.argv[1] if len(sys.argv) > 1 else "v" + latest
print(f"PyPI latest stable: {latest} | checking tag {tag}")

rel = gh(f"{REPO}/releases/tags/{tag}")
print(f"GitHub release object for {tag}:", (rel["published_at"], rel["name"]) if rel else "none yet")
if rel:
    keys = re.compile(r"Qwen4|Qwen3\.8|Flash-Next|PLE|NVFP4|CSF|Engram|MTP|QSA|GDN|SM12|Blackwell|RTX PRO", re.I)
    hits = [l.strip()[:190] for l in rel["body"].split("\n") if keys.search(l)]
    print(f"release-note lines in our area ({len(hits)}), first 25:")
    for l in hits[:25]:
        print("   ", l)

print(f"\n--- dependency pins at {tag}")
for f in ("requirements/cuda.txt", "requirements/common.txt"):
    for l in (gh(f"{REPO}/contents/{f}?ref={tag}", raw=True) or "").split("\n"):
        if re.match(r"^(torch|torchvision|flashinfer-python|transformers)\b", l):
            print("  ", f.split("/")[1], "|", l.strip()[:110])

print(f"\n--- watch list: state; is the merged change inside {tag}?  (compare = ancestor test; code = PR's added lines found at the tag)")
for n, label in WATCH:
    i = gh(f"{REPO}/issues/{n}")
    if not i:
        print(f"  #{n:<6} {label[:62]:62s} not found"); continue
    if "pull_request" not in i:
        print(f"  #{n:<6} {label[:62]:62s} {i['state']}" + (f" (closed {i['closed_at'][:10]})" if i["state"] == "closed" else f", updated {i['updated_at'][:10]}")); continue
    p = gh(f"{REPO}/pulls/{n}") or {}
    if p.get("merged"):
        c = gh(f"{REPO}/compare/{p['merge_commit_sha']}...{tag}")
        k, t = added_lines_present(n, tag)
        print(f"  #{n:<6} {label[:62]:62s} MERGED {p['merged_at'][:10]} | compare {c['status'] if c else '?'} | code {k}/{t}")
    else:
        print(f"  #{n:<6} {label[:62]:62s} {i['state']}" + (f" (closed {i['closed_at'][:10]}, not merged)" if i["state"] == "closed" else f", updated {i['updated_at'][:10]}"))

print(f"\n--- file-level proof at {tag}")
for f in ("vllm/model_executor/layers/quantization/utils/nvfp4_utils.py", "vllm/model_executor/layers/quantization/modelopt.py"):
    t = gh(f"{REPO}/contents/{f}?ref={tag}", raw=True) or ""
    print(f"   {f.split('/')[-1]}: {len(re.findall('csf', t, re.I))} 'csf' lines")
t = gh(f"{REPO}/contents/vllm/models/qwen4_exp/common/ngram_embedding.py?ref={tag}", raw=True) or ""
print("   qwen4_exp/common/ngram_embedding.py nvfp4 lines:", len(re.findall("nvfp4", t, re.I)))
t = gh(f"{REPO}/contents/vllm/models/qwen4_exp/nvidia/ngram_embedding.py?ref={tag}", raw=True) or ""
m = re.search(r"shard_parameters = \(.*\)", t)
print("   NVFP4 PLE shard parameters accepted by the loader:", m.group(0) if m else "not found (file moved?)")
