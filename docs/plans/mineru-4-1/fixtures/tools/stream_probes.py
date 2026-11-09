import http.client, json, os, sys, time, urllib.parse
sys.path.insert(0, "/root/mineru41-spike")
import cap

SLUG = "upload-framing"
pdf = open("/root/mineru41-spike/samples/paper-en.pdf", "rb").read()
n = [0]

def newtask(tag):
    d = pdf + b"\n%spike-" + tag.encode() + b"-" + str(time.time()).encode() + b"\n"
    x = cap.http("POST", "/v1/tasks", json_body={"files": [{"file_name": tag + ".pdf", "bytes": len(d), "sha256sum": cap.sha256_hex(d)}]})
    j = cap.jbody(x)
    return d, j["task_id"], j["files"][0]["upload"]["url"]

def raw_put(tag, url, body_iter_or_bytes, headers, chunked):
    u = urllib.parse.urlsplit(url)
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=60)
    h = dict(headers); h["Authorization"] = "Bearer " + cap.api_key()
    t0 = time.monotonic()
    try:
        conn.request("PUT", u.path, body=body_iter_or_bytes, headers=h, encode_chunked=chunked)
        r = conn.getresponse(); body = r.read()
        st, rh = r.status, {k.lower(): v for k, v in r.getheaders()}
    except Exception as exc:
        st, rh, body = None, {}, repr(exc).encode()
    n[0] += 1
    rec = {"request": {"method": "PUT", "path": u.path, "headers": {k: ("Bearer <redacted>" if k == "Authorization" else v) for k, v in h.items()}, "chunked": chunked},
           "response": {"status": st, "headers": rh, "elapsed_ms": round((time.monotonic() - t0) * 1000)}}
    try: rec["response"]["json"] = json.loads(body.decode())
    except Exception: rec["response"]["text_head"] = body[:300].decode("utf-8", "replace")
    cap.save_json(os.path.join(cap.OUT_ROOT, SLUG, f"{n[0]:02d}_{tag}.json"), rec)
    print(tag, st, json.dumps(rec["response"].get("json", rec["response"].get("text_head")))[:200], flush=True)
    return st

def chunks(d, size=65536):
    for i in range(0, len(d), size): yield d[i:i+size]

d, tid, url = newtask("chunked_no_content_length")
raw_put("chunked_no_content_length", url, chunks(d), {"Content-Type": "application/octet-stream"}, True)
print("  task:", cap.jbody(cap.http("GET", "/v1/tasks/" + tid))["status"])

d, tid, url = newtask("chunked_with_content_length_header")
raw_put("chunked_with_content_length_header", url, chunks(d), {"Content-Type": "application/octet-stream", "Content-Length": str(len(d))}, False)
for _ in range(60):
    s = cap.jbody(cap.http("GET", "/v1/tasks/" + tid))
    if s["status"] in cap.TERMINAL: break
    time.sleep(0.25)
print("  streamed body with explicit Content-Length -> task:", s["status"])

d, tid, url = newtask("no_content_type")
raw_put("no_content_type", url, d, {}, False)
print("  task:", cap.jbody(cap.http("GET", "/v1/tasks/" + tid))["status"])

# unauthenticated GETs of remaining read endpoints
for name, path in [("models_no_key", "/v1/models"), ("model_no_key", "/v1/models/mineru-4.1.7"), ("file_meta_no_key", "/v1/files/file-000000000000000000000000"), ("docs_no_key", "/docs"), ("redoc_no_key", "/redoc")]:
    x = cap.http("GET", path, auth=False)
    cap.probe(SLUG, "auth_" + name, x)
    print(name, x["status"], flush=True)
