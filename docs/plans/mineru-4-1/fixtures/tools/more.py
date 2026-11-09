import json, os, sys, time, urllib.parse
sys.path.insert(0, "/root/mineru41-spike")
import cap

S = "/root/mineru41-spike/samples/"
HDR = {"Content-Type": "application/octet-stream"}
pdf = open(S + "paper-en.pdf", "rb").read()
garbage = open(S + "garbage.pdf", "rb").read() + b"\n" + str(time.time()).encode()  # unique: must not hit the hash cache
n = [0]


def P(slug, name, method, path, **kw):
    n[0] += 1
    x = cap.http(method, path, **kw)
    r = cap.probe(slug, f"{n[0]:02d}_{name}", x)
    print(json.dumps(r, ensure_ascii=False), flush=True)
    return x, cap.jbody(x)


def uniq(tag):
    return pdf + b"\n%spike-" + tag.encode() + b"-" + str(time.time()).encode() + b"\n"


# ---------------------------------------------------------------------------------------------
# 1. partial task: one good file + one garbage file; file_already_terminal on a failed file
slug = "partial-and-file-terminal"
good = uniq("partial")
req = {"files": [
    {"file_name": "good.pdf", "bytes": len(good), "sha256sum": cap.sha256_hex(good)},
    {"file_name": "bad.pdf", "bytes": len(garbage), "sha256sum": cap.sha256_hex(garbage)},
]}
x, j = P(slug, "create", "POST", "/v1/tasks", json_body=req)
tid = j["task_id"]
up_good, up_bad = j["files"][0].get("upload"), j["files"][1].get("upload")
print("uploads needed:", bool(up_good), bool(up_bad))
P(slug, "put_bad_first", "PUT", up_bad["url"], raw_body=garbage, headers=HDR)
for _ in range(40):
    x, s = P(slug, "poll_after_bad", "GET", "/v1/tasks/" + tid)
    if s["files"][1]["status"] in ("failed", "completed"):
        break
    time.sleep(0.25)
P(slug, "put_bad_again_after_failed", "PUT", up_bad["url"], raw_body=garbage, headers=HDR)
P(slug, "get_before_good_upload", "GET", "/v1/tasks/" + tid)
P(slug, "put_good", "PUT", up_good["url"], raw_body=good, headers=HDR)
seen = set()
for _ in range(80):
    x = cap.http("GET", "/v1/tasks/" + tid)
    s = cap.jbody(x)
    k = cap.snap_key(s)
    if k not in seen:
        seen.add(k)
        cap.save_json(os.path.join(cap.OUT_ROOT, slug, f"snapshot_{len(seen):02d}_{s['status']}.json"), {"snapshot": s})
        print("snapshot", s["status"], [f["status"] for f in s["files"]], s.get("progress"), flush=True)
    if s["status"] in cap.TERMINAL:
        break
    time.sleep(0.25)
P(slug, "cancel_partial_task", "POST", "/v1/tasks/" + tid + "/cancel")

# ---------------------------------------------------------------------------------------------
# 2. cancel a RUNNING task: 10 distinct PDFs, concurrency 2 on the server
slug = "cancel-running"
blobs = [uniq(f"c{i}") for i in range(10)]
req = {"files": [{"file_name": f"doc{i}.pdf", "bytes": len(b)} for i, b in enumerate(blobs)]}  # no sha: every file needs an upload
x, j = P(slug, "create", "POST", "/v1/tasks", json_body=req)
tid = j["task_id"]
for i, f in enumerate(j["files"]):
    cap.http("PUT", f["upload"]["url"], raw_body=blobs[i], headers=HDR)
t0 = time.monotonic()
cancelled = False
for _ in range(400):
    x = cap.http("GET", "/v1/tasks/" + tid)
    s = cap.jbody(x)
    st = [f["status"] for f in s["files"]]
    if "running" in st and not cancelled:
        cap.save_json(os.path.join(cap.OUT_ROOT, slug, "snapshot_before_cancel.json"), {"snapshot": s})
        print("before cancel:", s["status"], st, flush=True)
        x, c = P(slug, "cancel_running", "POST", "/v1/tasks/" + tid + "/cancel")
        print("cancel receipt:", json.dumps(c)[:700], flush=True)
        cancelled = True
        time.sleep(0.3)
        x, s2 = P(slug, "get_after_cancel", "GET", "/v1/tasks/" + tid)
        print("after cancel:", s2["status"], [f["status"] for f in s2["files"]], flush=True)
        time.sleep(4)
        x, s3 = P(slug, "get_4s_later", "GET", "/v1/tasks/" + tid)
        print("4s later:", s3["status"], [f["status"] for f in s3["files"]], flush=True)
        # can completed-before-cancel files still be downloaded?
        for f in s3["files"]:
            if f.get("result_url"):
                dx = cap.http("GET", f["result_url"])
                print("result of completed-before-cancel file:", dx["status"], len(dx["body"]), flush=True)
                break
        break
    if s["status"] in cap.TERMINAL:
        print("finished before a running state was seen", s["status"], flush=True)
        break
    time.sleep(0.03)

# ---------------------------------------------------------------------------------------------
# 3. Files endpoints, Range, download without key, download twice
slug = "files-endpoints"
data = uniq("files")
sample = cap.run_task("files-endpoints/run", [{"data": data, "file_name": "files-probe.pdf"}])
tid = sample["task_id"]
s = cap.jbody(cap.http("GET", "/v1/tasks/" + tid))
f0 = s["files"][0]
fid = f0["file_id"]
ru = f0["result_url"]
P(slug, "file_meta", "GET", "/v1/files/" + fid)
P(slug, "content_no_key", "GET", ru, auth=False)
P(slug, "content_range_0_99", "GET", ru, headers={"Range": "bytes=0-99"})
P(slug, "content_head", "HEAD", ru)
P(slug, "content_if_none_match_star", "GET", ru, headers={"If-None-Match": "*"})
x, _ = P(slug, "content_again", "GET", ru)
P(slug, "content_wrong_key", "GET", ru, key="wrong-key-for-spike")

# ---------------------------------------------------------------------------------------------
# 4. leftover tasks from errors.py: snapshot of the async URL failure + cancel everything
created = json.load(open("/root/mineru41-spike/errors_created.json"))["created_task_ids"]
slug = "errors-leftovers"
done = 0
for tid in created:
    x = cap.http("GET", "/v1/tasks/" + tid)
    s = cap.jbody(x)
    files = s.get("files", []) if isinstance(s, dict) else []
    if any(f.get("file_name") == "never.pdf" for f in files):
        cap.save_json(os.path.join(cap.OUT_ROOT, slug, "url_loopback_https_refused_snapshot.json"), {"snapshot": s})
        print("url task:", s["status"], [(f["status"], f.get("error")) for f in files], flush=True)
    if len(files) == 100:
        cap.save_json(os.path.join(cap.OUT_ROOT, slug, "hundred_files_snapshot_head.json"),
                      {"status": s["status"], "progress": s.get("progress"), "first_file": files[0], "n_files": len(files)})
    if isinstance(s, dict) and s.get("status") not in cap.TERMINAL:
        cx = cap.http("POST", "/v1/tasks/" + tid + "/cancel")
        done += 1
print("cancelled leftovers:", done, flush=True)
