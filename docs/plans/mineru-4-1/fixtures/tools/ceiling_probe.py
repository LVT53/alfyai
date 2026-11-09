import json, os, sys, time
sys.path.insert(0, "/root/mineru41-spike")
import cap

S = "/root/mineru41-spike/samples/"
rd = lambda n: open(S + n, "rb").read()
n = [0]
HDR = {"Content-Type": "application/octet-stream"}

def P(name, method, path, **kw):
    n[0] += 1
    x = cap.http(method, path, **kw)
    r = cap.probe(".", f"{n[0]:02d}_{name}", x)
    j = cap.jbody(x)
    e = (j or {}).get("error") if isinstance(j, dict) else None
    print(f"{n[0]:02d}_{name:46} {x['status']} {(e or {}).get('code')} {(e or {}).get('param')} {str((e or {}).get('message'))[:70]}", flush=True)
    return x, j

def flow(slug, fname, data, top=None):
    s = cap.run_task(slug, [{"data": data, "file_name": fname}], top=top or {})
    f = s["files"][0] if s["files"] else {}
    print(f"flow {slug:40} create={s.get('create_status')} final={s.get('final_status')} tier={(f.get('parse') or {}).get('tier')} err={f.get('error')} note={s.get('note')}", flush=True)

P("health", "GET", "/v1/health", auth=False)
P("tiers", "GET", "/v1/tiers")
P("usage", "GET", "/v1/usage")
flow("pdf-no-tier", "paper-en.pdf", rd("paper-en.pdf"))
flow("png-no-tier", "scan.png", rd("scan-page.png"))
flow("docx-no-tier", "report.docx", rd("report.docx"))
for t in ("flash", "basic", "standard", "advanced"):
    x, j = P(f"pdf-explicit-tier-{t}", "POST", "/v1/tasks", json_body={"files": [{"file_name": "t.pdf", "bytes": 10}], "tier": t})
    if x["status"] == 202:
        cap.http("POST", "/v1/tasks/" + j["task_id"] + "/cancel")
# PUT to a KNOWN task with an UNKNOWN file id
x, j = P("create_for_unknown_file_id_probe", "POST", "/v1/tasks", json_body={"files": [{"file_name": "k.pdf", "bytes": 3}]})
tid = j["task_id"]
P("put_known_task_unknown_file", "PUT", f"/v1/tasks/{tid}/uploads/file-000000000000000000000000", raw_body=b"abc", headers=HDR)
P("put_known_task_malformed_file_id", "PUT", f"/v1/tasks/{tid}/uploads/not-a-file-id", raw_body=b"abc", headers=HDR)
cap.http("POST", "/v1/tasks/" + tid + "/cancel")
