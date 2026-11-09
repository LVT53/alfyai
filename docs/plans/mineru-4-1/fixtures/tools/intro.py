import json, os, sys
sys.path.insert(0, "/root/mineru41-spike")
import cap

S = "server"
res = []
for name, path, auth in [
    ("health_with_key", "/v1/health", True),
    ("health_no_key", "/v1/health", False),
    ("tiers", "/v1/tiers", True),
    ("usage", "/v1/usage", True),
    ("models", "/v1/models", True),
    ("files_list_get", "/v1/files", True),
    ("tasks_list_get", "/v1/tasks", True),
    ("docs_html_head", "/docs", True),
]:
    x = cap.http("GET", path, auth=auth)
    res.append(cap.probe(S, name, x))
    if name == "models":
        j = cap.jbody(x) or {}
        for m in (j.get("data") or [])[:6]:
            mx = cap.http("GET", "/v1/models/" + m["id"])
            res.append(cap.probe(S, "model_" + m["id"], mx))
x = cap.http("GET", "/openapi.json")
oa = cap.jbody(x)
cap.save_json(os.path.join(cap.OUT_ROOT, S, "openapi.json"), oa)
res.append({"case": "openapi.json", "status": x["status"], "bytes": len(x["body"]),
            "paths": sorted(oa["paths"].keys()) if oa else None, "info": oa.get("info") if oa else None})
for r in res:
    print(json.dumps(r, ensure_ascii=False))
