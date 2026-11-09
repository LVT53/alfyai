import json, os, sys, time, threading
sys.path.insert(0, "/root/mineru41-spike")
import cap

pdf = open("/root/mineru41-spike/big/paper-20p.pdf", "rb").read()
print("20-page pdf bytes", len(pdf), "sha", cap.sha256_hex(pdf)[:16])

def run(slug, top=None, data=None):
    t0 = time.time()
    s = cap.run_task(slug, [{"data": data or pdf, "file_name": "paper-20p.pdf"}], top=top or {}, out_root=os.path.join(cap.OUT_ROOT, "bigdoc"))
    s["t_start_epoch"], s["t_end_epoch"] = round(t0, 3), round(time.time(), 3)
    cap.save_json(os.path.join(cap.OUT_ROOT, "bigdoc", slug, "summary.json"), s)
    f = s["files"][0]
    print(json.dumps({"slug": slug, "final": s.get("final_status"), "wall_ms": s.get("wall_ms_create_to_terminal"), "parse": f.get("parse"),
                      "zip": (f.get("result_zip") or {}).get("bytes"), "put_status": f.get("put_status"), "put": f.get("put")}), flush=True)
    return s

run("p20-standard")                      # first upload; models are warm
run("p20-standard-again")                # cache hit, same options
run("p20-basic", {"tier": "basic"})
run("p20-flash", {"tier": "flash"})
run("p20-standard-range-1-5", {"page_range": "1-5"})
run("p20-standard-range-r1", {"page_range": "r1"})

# three concurrent standard-tier tasks (server --concurrency 2): fresh bytes each so every one parses
res = {}
def worker(i):
    d = pdf + b"\n%spike-conc-" + str(i).encode() + b"-" + str(time.time()).encode() + b"\n"
    t0 = time.time()
    s = cap.run_task(f"p20-concurrent-{i}", [{"data": d, "file_name": f"conc{i}.pdf"}], out_root=os.path.join(cap.OUT_ROOT, "bigdoc"), save_results=False)
    res[i] = (t0, time.time(), s)
ths = [threading.Thread(target=worker, args=(i,)) for i in range(3)]
t_start = time.time()
for t in ths: t.start()
for t in ths: t.join()
out = {"t_start_epoch": round(t_start, 3), "t_end_epoch": round(time.time(), 3), "tasks": []}
for i in range(3):
    t0, t1, s = res[i]
    f = s["files"][0]
    out["tasks"].append({"i": i, "wall_ms": round((t1 - t0) * 1000), "final": s.get("final_status"), "parse": f.get("parse"), "polls": s.get("polls_distinct")})
cap.save_json(os.path.join(cap.OUT_ROOT, "bigdoc", "p20-concurrent-summary.json"), out)
print(json.dumps(out), flush=True)
