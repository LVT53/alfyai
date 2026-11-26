#!/usr/bin/env python3
"""H3 speed benchmark against the box's H3 ComfyUI, through an ssh tunnel.

Runs a plan of synthetic text-to-image / edit cases with fixed seeds, waits for
the GPU to be idle across all three ComfyUI servers before each case, records
wall time and ComfyUI's own execution timestamps, saves every output PNG here,
and records nvidia-smi dmon (GPU1 power/util/PCIe) for the whole run.

Writes nothing on the box beyond ComfyUI's own temp/input files (swept daily).
"""
import argparse, copy, json, os, subprocess, sys, threading, time, urllib.parse, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
SSH = ["ssh", "-o", "ConnectTimeout=15", "alfyws"]

PROMPTS = {
    "street": (
        "A candid full-body photograph of a woman in her thirties walking along a cobblestone street in a small "
        "European town at golden hour. She wears a mustard wool coat, dark jeans and white sneakers, carries a canvas "
        "tote bag, and glances to the side with a slight smile. Natural freckled skin with visible pores, wind-blown "
        "auburn hair with individual strands catching the light. Shop windows, a cafe with small round tables and a "
        "bicycle leaning on a lamp post behind her. Shot on a 35mm lens at eye level, shallow depth of field, soft "
        "warm backlight, photorealistic, high detail."
    ),
    "room": (
        "A cozy living room interior on a sunny afternoon. A green velvet three-seat sofa with two linen cushions, a "
        "low walnut coffee table holding a white ceramic teapot and two cups, a tall bookshelf filled with colorful "
        "books, a large window with sheer white curtains and a potted monstera plant beside it. On the wall above the "
        "sofa hangs a framed poster with the single word 'ALFY' in bold black letters. Wide-plank oak floor and a "
        "patterned wool rug. Soft natural light, photorealistic architectural photography, high detail."
    ),
    "fisherman": (
        "A close-up portrait photograph of an elderly fisherman with a deeply weathered face, a short grey beard and "
        "pale blue eyes, wearing a navy knit cap and a yellow oilskin jacket. He stands on a wooden harbor pier with "
        "blurred fishing boats and coiled ropes behind him. Overcast daylight, fine skin pores and wrinkles, a few "
        "water droplets on the jacket, sharp focus on the eyes, 85mm lens, photorealistic, high detail."
    ),
}
EDIT_PROMPT = "Replace the green velvet sofa with a deep red leather sofa of the same size and position. Keep everything else in the picture exactly the same."

CANVAS = {"landscape": (4224, 2816), "square": (3456, 3456), "nine": (3808, 2528), "native": (0, 0)}


def http(base, path, data=None, raw=False, timeout=60):
    req = urllib.request.Request(base + path, data=data)
    if data is not None and not raw:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
    return body if raw else json.loads(body)


def all_idle():
    """True when none of the three ComfyUI servers is running or holding a queued prompt."""
    cmd = "for p in 8188 8189 8190; do curl -s -m5 http://127.0.0.1:$p/queue; echo; done"
    out = subprocess.run(SSH + [cmd], capture_output=True, text=True, timeout=60).stdout
    for line in out.strip().splitlines():
        q = json.loads(line)
        if q.get("queue_running") or q.get("queue_pending"):
            return False
    return True


QUIET_S = int(os.environ.get("BENCH_QUIET_S", "180"))
# Someone else's take was seen at this time; a run starts as if one just ended.
LAST_BUSY = [time.time() if os.environ.get("BENCH_START_QUIET") else 0.0]


def wait_idle(log, max_wait=3600):
    """Wait until every server is idle and none has been busy with someone else's work for QUIET_S seconds
    (people's takes come in runs: never wedge a test between two of them)."""
    t0 = time.time()
    told = False
    while True:
        if not all_idle():
            LAST_BUSY[0] = time.time()
            if not told:
                log("  (someone is using a picture or video server; waiting for a quiet spell)")
                told = True
        elif time.time() - LAST_BUSY[0] >= QUIET_S:
            return
        if time.time() - t0 > max_wait:
            raise SystemExit("the GPU never went quiet; stopping the benchmark")
        time.sleep(10)


def gen_graph(prompt, seed, steps, w, h):
    g = json.load(open(os.path.join(HERE, "h3-generate.api.json")))
    g["4"]["inputs"].update(prompt=prompt, width=w, height=h)
    g["6"]["inputs"].update(seed=seed, steps=steps)
    return g


def edit_graph(prompt, seed, steps, w, h, image_name):
    g = json.load(open(os.path.join(HERE, "h3-edit.api.json")))
    for n in range(10, 19):
        g.pop(str(n), None)
        g["4"]["inputs"].pop(f"images.image_{n - 8}", None)
    g["9"]["inputs"]["image"] = image_name
    g["4"]["inputs"].update(prompt=f"<Picture 1> {prompt}", width=w, height=h)
    g["6"]["inputs"].update(seed=seed, steps=steps)
    return g


def upload(base, path):
    boundary = uuid.uuid4().hex
    name = os.path.basename(path)
    with open(path, "rb") as f:
        payload = f.read()
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n"
            "Content-Type: image/png\r\n\r\n").encode() + payload + (
            f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n").encode()
    req = urllib.request.Request(base + "/upload/image", data=body)
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())["name"]


def run_case(base, case, outdir, log):
    graph = case["graph"]
    client_id = uuid.uuid4().hex
    t_submit = time.time()
    pid = http(base, "/prompt", json.dumps({"prompt": graph, "client_id": client_id}).encode())["prompt_id"]
    while True:
        hist = http(base, f"/history/{pid}")
        if pid in hist and hist[pid].get("status", {}).get("completed") is not None:
            entry = hist[pid]
            if entry["status"].get("status_str") in ("success", "error"):
                break
        time.sleep(0.25)
    t_done = time.time()
    msgs = {m[0]: m[1].get("timestamp") for m in entry["status"].get("messages", [])}
    imgs = []
    for node_out in entry.get("outputs", {}).values():
        for im in node_out.get("images", []):
            q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im.get("subfolder", ""), "type": im.get("type", "temp")})
            data = http(base, f"/view?{q}", raw=True, timeout=300)
            p = os.path.join(outdir, f"{case['name']}.png")
            open(p, "wb").write(data)
            imgs.append((p, len(data)))
    t_fetched = time.time()
    res = {
        "name": case["name"], "prompt_id": pid, "status": entry["status"].get("status_str"),
        "submit": t_submit, "done": t_done, "fetched": t_fetched,
        "wall_s": round(t_done - t_submit, 2), "fetch_s": round(t_fetched - t_done, 2),
        "comfy_start_ms": msgs.get("execution_start"), "comfy_end_ms": msgs.get("execution_success") or msgs.get("execution_error"),
        "images": imgs, "meta": case.get("meta", {}),
    }
    if res["comfy_start_ms"] and res["comfy_end_ms"]:
        res["comfy_exec_s"] = round((res["comfy_end_ms"] - res["comfy_start_ms"]) / 1000, 2)
    log(f"  {case['name']}: wall {res['wall_s']} s, comfy {res.get('comfy_exec_s')} s, fetch {res['fetch_s']} s, {res['status']}")
    return res


def dmon(path, stop):
    with open(path, "w") as f:
        p = subprocess.Popen(SSH + ["nvidia-smi dmon -i 1 -s pucm -d 1 -o T"], stdout=f, stderr=subprocess.STDOUT, text=True)
        stop.wait()
        p.terminate()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:18189")
    ap.add_argument("--out", required=True)
    ap.add_argument("--plan", required=True, help="JSON list: {name, kind: t2i|edit, prompt, seed, steps, base_from?}")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    logf = open(os.path.join(a.out, "log.txt"), "a")

    def log(s):
        line = time.strftime("%H:%M:%S ") + s
        print(line, flush=True)
        logf.write(line + "\n"); logf.flush()

    plan = json.load(open(a.plan))
    # The app never gives an edit the seed that made its base (`avoidSeeds`): the same seed on the
    # same canvas starts the edit from the very noise that made the base, and H3 then over-processes
    # the picture (comic-book faces, posterised backgrounds). The 2026-11-18 run did exactly that
    # by accident. An edit must name its base's seed, and may not reuse it.
    for c in plan:
        if c["kind"] == "edit":
            if "base_seed" not in c:
                raise SystemExit(f"{c['name']}: an edit must give base_seed (the seed that made its base, or null)")
            if c["base_seed"] is not None and c["seed"] == c["base_seed"]:
                raise SystemExit(f"{c['name']}: seed {c['seed']} made the base; the app never reuses it, so neither may a test")
    stop = threading.Event()
    th = threading.Thread(target=dmon, args=(os.path.join(a.out, "dmon.txt"), stop), daemon=True)
    th.start()
    results = []
    try:
        for c in plan:
            w, h = CANVAS[c.get("canvas", "landscape")]
            if c["kind"] == "t2i":
                c["graph"] = gen_graph(PROMPTS[c["prompt"]], c["seed"], c["steps"], w, h)
            else:
                name = upload(a.base, os.path.join(a.out, c["base_from"] + ".png"))
                c["graph"] = edit_graph(c.get("edit_prompt", EDIT_PROMPT), c["seed"], c["steps"], w, h, name)
            wait_idle(log)
            log(f"run {c['name']} ({c['kind']}, steps {c['steps']})")
            results.append(run_case(a.base, c, a.out, log))
            json.dump(results, open(os.path.join(a.out, "results.json"), "w"), indent=1)
    finally:
        stop.set()
        time.sleep(1.5)
    log("done")


if __name__ == "__main__":
    main()
