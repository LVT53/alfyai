#!/usr/bin/env python3
"""Mechanical scan of Flash-Next-family safetensors repos on Hugging Face created since a date.

Usage:  python3 docs/plans/vllm-0-31-fp8/tools/scan-flash-next-repos.py [--since YYYY-MM-DD] [--min-gib 55] [--max-gib 135]

Standard library only. For each repo it prints layout from config.json (quant algo, PLE dtype, CSF scales, MTP layers),
size, an "uncensored" flag from the card/name, and engine hints. GGUF / MLX / EXL3 / AWQ-style uploads are dropped by name.
It reads configs and card headers only: a match is a lead to read, not evidence. Written 2026-11-04.
"""
import argparse, concurrent.futures as cf, datetime, json, re, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--since", default=(datetime.date.today() - datetime.timedelta(days=7)).isoformat())
ap.add_argument("--min-gib", type=float, default=55)
ap.add_argument("--max-gib", type=float, default=135)
args = ap.parse_args()


def get(url, raw=False):
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8.7.1"})
    with urllib.request.urlopen(req, timeout=45) as r:
        b = r.read()
    return b.decode("utf-8", "replace") if raw else json.loads(b)


seen = {}
for term in ("Flash-Next", "qwen4_exp", "FP4-Local", "Qwen3.8-Flash", "abliterated", "uncensored", "heretic"):
    for sort in ("createdAt", "lastModified"):
        url = (f"https://huggingface.co/api/models?search={term}&sort={sort}&direction=-1&limit=100"
               "&expand[]=createdAt&expand[]=lastModified&expand[]=downloads&expand[]=likes")
        try:
            for m in get(url):
                seen[m["id"]] = m
        except Exception:
            pass
drop = re.compile(r"gguf|mlx|exl3|awq|gptq|\bIQ\d|-Q\d|llama\.?cpp|ternary|27B", re.I)
cands = [m for m in seen.values() if m.get("createdAt", "") >= args.since and not drop.search(m["id"]) and "Flash" in m["id"]]
print(f"repos seen {len(seen)}; created since {args.since}, safetensors-style, Flash-Next: {len(cands)}")

unc = re.compile(r"abliterat|uncensor|heretic|decensor|refusal|dealign", re.I)
eng = re.compile(r"stock vLLM|vLLM 0\.3\d|SGLang|b12x|LIL|local-inference-lab|container|DGX Spark|RTX PRO 6000|RTX 5090", re.I)


def look(m):
    r = m["id"]
    out = {"id": r, "created": m["createdAt"][:10], "dl": m.get("downloads")}
    try:
        d = get(f"https://huggingface.co/api/models/{r}?expand[]=usedStorage&expand[]=gated")
        out["gib"] = round(d.get("usedStorage", 0) / 2**30, 1)
    except Exception:
        out["gib"] = 0
    try:
        c = get(f"https://huggingface.co/{r}/raw/main/config.json")
        t = c.get("text_config", {})
        q = c.get("quantization_config") or t.get("quantization_config") or {}
        out.update(quant=q.get("quant_algo") or q.get("quant_method"), ple=t.get("ple_embedding_dtype"),
                   csf="csf" in json.dumps(c).lower(), mtp=t.get("mtp_num_hidden_layers"))
    except Exception:
        pass
    try:
        rd = get(f"https://huggingface.co/{r}/raw/main/README.md", raw=True)
        out["unc"] = bool(unc.search(rd[:6000]) or unc.search(r))
        out["eng"] = sorted({x.group(0) for x in eng.finditer(rd)})[:4]
    except Exception:
        out["unc"] = bool(unc.search(r)); out["eng"] = []
    return out


with cf.ThreadPoolExecutor(8) as ex:
    rows = list(ex.map(look, cands))
rows.sort(key=lambda o: (not o.get("unc"), -(o.get("dl") or 0)))
print(f"{'repo':78s} {'created':10s} {'GiB':>6s} {'dl':>5s} quant/ple/csf/mtp | unc | engine hints")
for o in rows:
    if o["gib"] and not (args.min_gib <= o["gib"] <= args.max_gib):
        continue
    print(f"{o['id'][:78]:78s} {o['created']} {o['gib']:>6} {str(o.get('dl')):>5} "
          f"{o.get('quant')}/{o.get('ple')}/{'CSF' if o.get('csf') else '-'}/{o.get('mtp')} | {'UNC' if o.get('unc') else '-  '} | {','.join(o.get('eng', []))}")
