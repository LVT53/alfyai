import json, os, subprocess, sys, time
sys.path.insert(0, "/root/mineru41-spike")
import cap

S = "/root/mineru41-spike/samples/"
HDR = {"Content-Type": "application/octet-stream"}
pdf = open(S + "paper-en.pdf", "rb").read()
n = [0]


def P(slug, name, method, path, **kw):
    n[0] += 1
    x = cap.http(method, path, **kw)
    r = cap.probe(slug, f"{n[0]:02d}_{name}", x)
    j = cap.jbody(x)
    print(json.dumps(r, ensure_ascii=False), flush=True)
    return x, j


def uniq(tag):
    return pdf + b"\n%spike-" + tag.encode() + b"-" + str(time.time()).encode() + b"\n"


def wait_terminal(tid, slug, label, timeout=120):
    seen, k, t0 = set(), 0, time.monotonic()
    last = None
    while time.monotonic() - t0 < timeout:
        s = cap.jbody(cap.http("GET", "/v1/tasks/" + tid))
        if s is None:
            break
        key = cap.snap_key(s)
        if key not in seen:
            seen.add(key)
            k += 1
            cap.save_json(os.path.join(cap.OUT_ROOT, slug, f"{label}_snapshot_{k:02d}_{s['status']}.json"), {"snapshot": s})
        last = s
        if s["status"] in cap.TERMINAL:
            break
        time.sleep(0.2)
    return last


def create(slug, label, name, data, with_sha=True, bytes_delta=0, sha=None, extra=None):
    e = {"file_name": name, "bytes": len(data) + bytes_delta}
    if with_sha:
        e["sha256sum"] = sha or cap.sha256_hex(data)
    e.update(extra or {})
    x = cap.http("POST", "/v1/tasks", json_body={"files": [e]})
    cap.save_json(os.path.join(cap.OUT_ROOT, slug, f"{label}_create.json"), cap.doc(x))
    j = cap.jbody(x)
    f0 = (j or {}).get("files", [{}])[0] if isinstance(j, dict) else {}
    print(f"[{label}] create {x['status']} task={((j or {}).get('status'))} file={f0.get('status')} upload={'upload' in f0}", flush=True)
    return x, j


def put(slug, label, j, data):
    f0 = j["files"][0]
    px = cap.http("PUT", f0["upload"]["url"], raw_body=data, headers=HDR)
    cap.save_json(os.path.join(cap.OUT_ROOT, slug, f"{label}_put.json"), cap.doc(px))
    return px


def health_wait(timeout=180):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        try:
            x = cap.http("GET", "/v1/health", auth=False, timeout=3)
            if x["status"] == 200:
                return round((time.monotonic() - t0) * 1000)
        except Exception:
            pass
        time.sleep(0.25)
    return None


# =============================================================================================
slug = "hash-cache"
U = uniq("cache")
sha = cap.sha256_hex(U)
x, j = create(slug, "A_first_upload", "cache-a.pdf", U)
put(slug, "A_first_upload", j, U)
sa = wait_terminal(j["task_id"], slug, "A_first_upload")
print("A:", sa["status"], sa["files"][0].get("parse"), flush=True)

x, j = create(slug, "B_same_hash_same_name", "cache-a.pdf", U)
sb = wait_terminal(j["task_id"], slug, "B_same_hash_same_name")
print("B:", sb["status"], sb["files"][0].get("parse"), flush=True)
fid_a, fid_b = sa["files"][0]["file_id"], sb["files"][0]["file_id"]
print("file ids differ between tasks:", fid_a != fid_b, flush=True)

x, j = create(slug, "C_same_hash_other_name", "renamed-copy.pdf", U)
sc = wait_terminal(j["task_id"], slug, "C_same_hash_other_name")
print("C:", sc["status"], sc["files"][0].get("parse"), flush=True)

x, j = create(slug, "D_same_hash_docx_extension", "pretend.docx", U)
sd = wait_terminal(j["task_id"], slug, "D_same_hash_docx_extension")
print("D:", sd["status"], sd["files"][0].get("parse"), sd["files"][0].get("error"), flush=True)

x, j = create(slug, "E_same_bytes_no_hash_sent", "cache-a.pdf", U, with_sha=False)
if j and "upload" in j["files"][0]:
    put(slug, "E_same_bytes_no_hash_sent", j, U)
se = wait_terminal(j["task_id"], slug, "E_same_bytes_no_hash_sent")
print("E:", se["status"], se["files"][0].get("parse"), flush=True)

x, j = create(slug, "F_same_hash_wrong_bytes_declared", "cache-a.pdf", U, bytes_delta=1)
print("F body:", json.dumps(cap.jbody(x))[:300], flush=True)
if x["status"] == 202:
    sf = wait_terminal(j["task_id"], slug, "F_same_hash_wrong_bytes_declared")
    print("F:", sf["status"], sf["files"][0].get("error"), flush=True)

x, j = create(slug, "G_unknown_hash", "cache-g.pdf", uniq("g"), )
print("G (unknown hash) -> upload required:", "upload" in j["files"][0], flush=True)
cap.http("POST", "/v1/tasks/" + j["task_id"] + "/cancel")

x, j = create(slug, "H_same_hash_other_tier_basic", "cache-a.pdf", U, extra=None)
cap.http("POST", "/v1/tasks/" + j["task_id"] + "/cancel")
# same bytes, different parse options: only source bytes are reused
x = cap.http("POST", "/v1/tasks", json_body={"files": [{"file_name": "cache-a.pdf", "bytes": len(U), "sha256sum": sha}], "tier": "flash", "page_range": "1"})
cap.save_json(os.path.join(cap.OUT_ROOT, slug, "I_same_hash_flash_page1_create.json"), cap.doc(x))
j = cap.jbody(x)
si = wait_terminal(j["task_id"], slug, "I_same_hash_flash_page1")
print("I:", si["status"], si["files"][0].get("parse"), flush=True)

# =============================================================================================
# mid-way cancel: some files completed, some not
slug = "cancel-midway"
blobs = [uniq(f"m{i}") for i in range(10)]
x = cap.http("POST", "/v1/tasks", json_body={"files": [{"file_name": f"m{i}.pdf", "bytes": len(b)} for i, b in enumerate(blobs)]})
j = cap.jbody(x)
tid = j["task_id"]
for i, f in enumerate(j["files"]):
    cap.http("PUT", f["upload"]["url"], raw_body=blobs[i], headers=HDR)
for _ in range(600):
    s = cap.jbody(cap.http("GET", "/v1/tasks/" + tid))
    st = [f["status"] for f in s["files"]]
    if "completed" in st and (st.count("completed") < len(st)):
        cap.save_json(os.path.join(cap.OUT_ROOT, slug, "snapshot_before_cancel.json"), {"snapshot": s})
        x = cap.http("POST", "/v1/tasks/" + tid + "/cancel")
        cap.save_json(os.path.join(cap.OUT_ROOT, slug, "cancel_receipt.json"), cap.doc(x))
        print("midway cancel:", x["status"], [f["status"] for f in cap.jbody(x)["files"]], flush=True)
        time.sleep(3)
        s2 = cap.jbody(cap.http("GET", "/v1/tasks/" + tid))
        cap.save_json(os.path.join(cap.OUT_ROOT, slug, "snapshot_3s_after_cancel.json"), {"snapshot": s2})
        print("3s after:", s2["status"], [f["status"] for f in s2["files"]], s2.get("progress"), flush=True)
        for f in s2["files"]:
            if f["status"] == "completed" and f.get("result_url"):
                dx = cap.http("GET", f["result_url"])
                print("completed-before-cancel result downloadable:", dx["status"], len(dx["body"]), flush=True)
                break
        break
    time.sleep(0.02)

# =============================================================================================
slug = "restart"
R1 = uniq("restart-done")
x, j = create(slug, "R1_completed_before_restart", "restart-done.pdf", R1)
put(slug, "R1_completed_before_restart", j, R1)
s1 = wait_terminal(j["task_id"], slug, "R1_completed_before_restart")
r1_task, r1_file, r1_url = s1["task_id"], s1["files"][0]["file_id"], s1["files"][0]["result_url"]
R2 = uniq("restart-waiting")
x, j2 = create(slug, "R2_waiting_before_restart", "restart-waiting.pdf", R2)
r2_task, r2_put = j2["task_id"], j2["files"][0]["upload"]["url"]
pre_usage = cap.jbody(cap.http("GET", "/v1/usage"))
cap.save_json(os.path.join(cap.OUT_ROOT, slug, "usage_before_restart.json"), pre_usage)
# is the hash cache hit visible just before the restart?
x, jc = create(slug, "R3_cached_hash_before_restart", "restart-done.pdf", R1)
print("before restart, cached hash -> upload needed:", "upload" in jc["files"][0], flush=True)
sc_pre = wait_terminal(jc["task_id"], slug, "R3_cached_hash_before_restart")

t0 = time.monotonic()
subprocess.run(["systemctl", "restart", "mineru41-spike"], check=True)
t_restart_cmd = round((time.monotonic() - t0) * 1000)
t_health = health_wait()
print("restart command returned after", t_restart_cmd, "ms; health 200 after", t_health, "ms (from command return)", flush=True)
cap.save_json(os.path.join(cap.OUT_ROOT, slug, "restart_timing.json"), {"systemctl_restart_ms": t_restart_cmd, "health_ok_after_ms": t_health})

P(slug, "R1_task_after_restart", "GET", "/v1/tasks/" + r1_task)
P(slug, "R1_file_meta_after_restart", "GET", "/v1/files/" + r1_file)
P(slug, "R1_result_url_after_restart", "GET", r1_url)
P(slug, "R2_task_after_restart", "GET", "/v1/tasks/" + r2_task)
P(slug, "R2_put_after_restart", "PUT", r2_put, raw_body=R2, headers=HDR)
P(slug, "R2_cancel_after_restart", "POST", "/v1/tasks/" + r2_task + "/cancel")
post_usage = cap.jbody(cap.http("GET", "/v1/usage"))
cap.save_json(os.path.join(cap.OUT_ROOT, slug, "usage_after_restart.json"), post_usage)

x, jc2 = create(slug, "R4_cached_hash_after_restart", "restart-done.pdf", R1)
print("after restart, cached hash -> upload needed:", "upload" in jc2["files"][0], flush=True)
if "upload" not in jc2["files"][0]:
    s4 = wait_terminal(jc2["task_id"], slug, "R4_cached_hash_after_restart")
    print("R4:", s4["status"], s4["files"][0].get("parse"), flush=True)
else:
    put(slug, "R4_cached_hash_after_restart", jc2, R1)
    s4 = wait_terminal(jc2["task_id"], slug, "R4_cached_hash_after_restart")
    print("R4 (re-uploaded):", s4["status"], s4["files"][0].get("parse"), flush=True)

# first parse after restart = cold models again?
R5 = uniq("restart-cold")
t0 = time.monotonic()
x, j5 = create(slug, "R5_first_parse_after_restart", "restart-cold.pdf", R5)
put(slug, "R5_first_parse_after_restart", j5, R5)
s5 = wait_terminal(j5["task_id"], slug, "R5_first_parse_after_restart")
print("R5 cold-after-restart:", s5["status"], s5["files"][0].get("parse"), "wall_ms", round((time.monotonic() - t0) * 1000), flush=True)
