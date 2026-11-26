#!/usr/bin/env python3
"""Throwaway, synthetic-only 12MP pDMD benchmark; never writes production settings.

Uses the production model files/conditioning and request-local LoRA + shift nodes.
Waits for all picture/video queues between cases. Saves exact graphs and histories.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import time
import shutil
import uuid

import bench

ROOT = Path(__file__).resolve().parents[4]
GRAPHS = ROOT / "src/lib/server/services/images/comfyui/graphs"
LORA = "benchmark-pdmd/minimax_h3_pdmd_2nfe_comfyui.safetensors"
EDITS = {
    "fisherman": "Change his navy knit cap to a bright red knit cap. Keep everything else in the picture exactly the same.",
    "street": "Change her mustard wool coat to a navy blue wool coat. Keep everything else in the picture exactly the same.",
    "room": "Replace the green velvet sofa with a deep red leather sofa of the same size and position. Keep everything else in the picture exactly the same.",
}


def graph(subject, seed, mode, image=None):
    g = json.loads((GRAPHS / ("h3-image-edit.api.json" if image else "h3-image-generate.api.json")).read_text())
    g["4"]["inputs"].update(width=4224, height=2816, prompt=("<Picture 1> " + EDITS[subject]) if image else bench.PROMPTS[subject])
    if image:
        for n in range(10, 19):
            g.pop(str(n), None)
            g["4"]["inputs"].pop(f"images.image_{n - 8}", None)
        g["9"]["inputs"]["image"] = image
    g["6"]["inputs"].update(seed=seed, steps=6 if mode == "stock" else 2)
    if mode == "pdmd":
        g["30"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": LORA, "strength_model": 1.0}}
        g["31"] = {"class_type": "MiniMaxH3SigmaShift", "inputs": {"model": ["30", 0], "shift_video": 12.0, "shift_audio": 3.0}}
        g["6"]["inputs"]["model"] = ["31", 0]
    return g


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--pilot", action="store_true")
    ap.add_argument("--only", choices=["generate", "edit", "restore"])
    a = ap.parse_args()
    out = Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    base = "http://127.0.0.1:18189"
    logf = (out / "log.txt").open("a")

    def log(s):
        line = time.strftime("%H:%M:%S ") + s
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    results_path = out / "results.json"
    results = json.loads(results_path.read_text()) if results_path.exists() else []

    def upload_subject(subject):
        # A unique filename avoids overwriting any existing ComfyUI input.
        uploads = out / "uploads"
        uploads.mkdir(exist_ok=True)
        p = uploads / f"pdmd-bench-20261118-{subject}-{uuid.uuid4().hex}.png"
        shutil.copyfile(out / f"gen-{subject}-0-stock.png", p)
        return bench.upload(base, str(p))

    def run(name, subject, seed, mode, image=None, warmup=False):
        if any(r["name"] == name and r["status"] == "success" for r in results):
            log("skip completed " + name)
            return
        bench.wait_idle(log)
        g = graph(subject, seed, mode, image)
        (out / (name + ".graph.json")).write_text(json.dumps(g, indent=2))
        log("run " + name)
        r = bench.run_case(base, {"name": name, "graph": g, "meta": {"subject": subject, "mode": mode, "seed": seed, "kind": "edit" if image else "generate", "warmup": warmup, "width": 4224, "height": 2816}}, str(out), log)
        hist = bench.http(base, "/history/" + r["prompt_id"])
        (out / (name + ".history.json")).write_text(json.dumps(hist, indent=2))
        r["sha256"] = {Path(p).name: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p, size in r["images"]}
        results.append(r)
        results_path.write_text(json.dumps(results, indent=2))
        if r["status"] != "success" or not r["images"]:
            raise SystemExit("render failed: " + name)

    if a.pilot:
        run("pilot-stock", "fisherman", 918180, "stock", warmup=True)
        run("pilot-pdmd", "fisherman", 918180, "pdmd", warmup=True)
        return
    if a.only == "restore":
        run("restore-stock", "fisherman", 918999, "stock", warmup=True)
        return
    if a.only in (None, "generate"):
        for mode in ("stock", "pdmd"):
            run("warmup-gen-" + mode, "room", 918181, mode, warmup=True)
            for si, subject in enumerate(bench.PROMPTS):
                for rep in range(2):
                    seed = 918200 + si * 10 + rep
                    run(f"gen-{subject}-{rep}-{mode}", subject, seed, mode)
    if a.only in (None, "edit"):
        # Identical baseline image for both methods; edit seeds never equal base seeds.
        for mode in ("stock", "pdmd"):
            warm = upload_subject("room")
            run("warmup-edit-" + mode, "room", 919000, mode, warm, warmup=True)
            for si, subject in enumerate(bench.PROMPTS):
                image = upload_subject(subject)
                for rep in range(2):
                    run(f"edit-{subject}-{rep}-{mode}", subject, 919100 + si * 10 + rep, mode, image)
    log("done")


if __name__ == "__main__":
    main()
