#!/usr/bin/env python3
"""Spike client for the MinerU 4.1.7 Tasks API.

Records every HTTP exchange verbatim (request, status, response headers, body) as pretty JSON.
The API key is read from the mode-600 env file and is NEVER written to a capture or printed.
Stdlib only, so it runs under the box's system python3.12.
"""
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

BASE = os.environ.get("SPIKE_BASE", "http://127.0.0.1:8012")
ENV_FILE = "/home/alfydesign/apps/mineru4/mineru41-spike.env"
OUT_ROOT = os.environ.get("SPIKE_OUT", "/root/mineru41-spike/captures")
KEEP_ZIP_MAX = 150_000  # bytes: keep the result ZIP itself only if it is smaller than this
TERMINAL = {"completed", "partial", "failed", "canceled"}
_KEY = None


def api_key():
    global _KEY
    if _KEY is None:
        for line in open(ENV_FILE, encoding="utf-8"):
            if line.startswith("MINERU41_SPIKE_API_KEY="):
                _KEY = line.split("=", 1)[1].strip()
    return _KEY


def pretty(obj):
    return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(pretty(obj))


def save_bytes(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def http(method, target, *, headers=None, json_body=None, raw_body=None, auth=True, key=None, timeout=180):
    """One HTTP exchange. `target` is a path (joined to BASE) or an absolute URL."""
    url = target if target.startswith("http") else BASE + target
    h = dict(headers or {})
    data = None
    if json_body is not None:
        data = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
        h.setdefault("Content-Type", "application/json")
    elif raw_body is not None:
        data = raw_body
    if auth:
        h["Authorization"] = "Bearer " + (key if key is not None else api_key())
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    t0 = time.monotonic()
    try:
        resp = _OPENER.open(req, timeout=timeout)
        status, reason, rh, body = resp.status, resp.reason, resp.headers, resp.read()
    except urllib.error.HTTPError as exc:
        status, reason, rh, body = exc.code, exc.reason, exc.headers, exc.read()
    ms = round((time.monotonic() - t0) * 1000)
    return {
        "method": method, "url": url, "status": status, "reason": reason,
        "headers": {k.lower(): v for k, v in rh.items()}, "body": body, "ms": ms,
        "req_headers": h, "req_json": json_body,
        "req_raw_len": (len(data) if (data is not None and json_body is None) else None),
    }


def jbody(x):
    try:
        return json.loads(x["body"].decode("utf-8"))
    except Exception:
        return None


def doc(x, body_cap=4000):
    """Serialisable record of one exchange (Authorization redacted)."""
    path = urllib.parse.urlsplit(x["url"])
    rq = {
        "method": x["method"],
        "path": path.path + (("?" + path.query) if path.query else ""),
        "headers": {k: ("Bearer <redacted>" if k.lower() == "authorization" else v) for k, v in x["req_headers"].items()},
    }
    if x["req_json"] is not None:
        rq["json"] = x["req_json"]
    if x["req_raw_len"] is not None:
        rq["raw_body_bytes"] = x["req_raw_len"]
    rs = {"status": x["status"], "reason": x["reason"], "headers": x["headers"], "elapsed_ms": x["ms"]}
    b = x["body"]
    if b:
        j = jbody(x)
        if j is not None:
            rs["json"] = j
        else:
            rs["body_bytes"] = len(b)
            ctype = x["headers"].get("content-type", "")
            if not (b[:2] == b"PK" or "zip" in ctype or "octet-stream" in ctype):
                rs["text_head"] = b[:body_cap].decode("utf-8", "replace")
    return {"request": rq, "response": rs}


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def snap_key(s):
    fl = s.get("files", [])
    return json.dumps({
        "status": s.get("status"), "progress": s.get("progress"), "error": s.get("error"),
        "files": [{"status": f.get("status"), "upload": "upload" in f, "parse": "parse" in f,
                   "result": "result_url" in f, "error": f.get("error")} for f in fl],
    }, sort_keys=True)


def listing(zbytes):
    z = zipfile.ZipFile(io.BytesIO(zbytes))
    return [{"name": i.filename, "size": i.file_size, "compressed": i.compress_size} for i in z.infolist()], z


def run_task(slug, files, *, top=None, out_root=None, do_put=True, poll_timeout=400, fast_poll=0.2,
             save_results=True, tag_extra=None):
    """Create a task for `files` ([{path|data, file_name, extra}]), upload what is asked for, poll to a
    terminal state recording every distinct snapshot, download every result. Returns a summary dict."""
    out = os.path.join(out_root or OUT_ROOT, slug)
    os.makedirs(out, exist_ok=True)
    entries, blobs, inputs = [], [], []
    for f in files:
        data = f["data"] if "data" in f else open(f["path"], "rb").read()
        name = f.get("file_name") or os.path.basename(f["path"])
        e = {"file_name": name, "bytes": len(data), "sha256sum": sha256_hex(data)}
        e.update(f.get("extra") or {})
        for k in f.get("drop", ()):
            e.pop(k, None)
        entries.append(e)
        blobs.append(data)
        inputs.append({"file_name": name, "bytes": len(data), "sha256sum": e.get("sha256sum")})
    req = {"files": entries}
    req.update(top or {})
    save_json(os.path.join(out, "00_inputs.json"), inputs)
    t_create = time.monotonic()
    x = http("POST", "/v1/tasks", json_body=req)
    save_json(os.path.join(out, "01_create.json"), doc(x))
    summary = {"slug": slug, "create_status": x["status"], "files": []}
    rec = jbody(x)
    if x["status"] != 202 or not rec:
        summary["note"] = "create did not return 202"
        save_json(os.path.join(out, "summary.json"), summary)
        return summary
    task_id = rec["task_id"]
    summary["task_id"] = task_id
    summary["create_ms"] = x["ms"]
    rfiles = rec.get("files", [])
    # uploads
    t_put0 = None
    for i, rf in enumerate(rfiles):
        up = rf.get("upload")
        if up and do_put:
            t_put0 = t_put0 or time.monotonic()
            px = http("PUT", up["url"], headers=dict(up.get("headers") or {}) | {"Content-Type": "application/octet-stream"},
                      raw_body=blobs[i], auth=True)
            save_json(os.path.join(out, f"02_put_{i}.json"), doc(px))
            summary["files"].append({"i": i, "put_status": px["status"], "put_ms": px["ms"]})
        else:
            summary["files"].append({"i": i, "put": "skipped" if not up else "not requested"})
    # polling
    seen, n, t0 = set(), 0, time.monotonic()
    final = None
    while time.monotonic() - t0 < poll_timeout:
        gx = http("GET", "/v1/tasks/" + urllib.parse.quote(task_id, safe=""))
        s = jbody(gx)
        if s is None:
            save_json(os.path.join(out, f"03_poll_{n:02d}_nonjson.json"), doc(gx))
            break
        k = snap_key(s)
        if k not in seen:
            seen.add(k)
            n += 1
            save_json(os.path.join(out, f"03_poll_{n:02d}_{s.get('status')}.json"),
                      {"t_since_create_ms": round((time.monotonic() - t_create) * 1000), "http": doc(gx)["response"]["status"],
                       "snapshot": s})
        if s.get("status") in TERMINAL:
            final = s
            break
        time.sleep(fast_poll if time.monotonic() - t0 < 6 else 1.0)
    summary["polls_distinct"] = n
    summary["wall_ms_create_to_terminal"] = round((time.monotonic() - t_create) * 1000)
    if final is None:
        summary["note"] = "poll timeout"
        save_json(os.path.join(out, "summary.json"), summary)
        return summary
    summary["final_status"] = final.get("status")
    summary["progress"] = final.get("progress")
    if final.get("error"):
        summary["task_error"] = final["error"]
    for i, ff in enumerate(final.get("files", [])):
        fs = next((s_ for s_ in summary["files"] if s_.get("i") == i), None)
        if fs is None:
            fs = {"i": i}
            summary["files"].append(fs)
        fs.update({"file_name": ff.get("file_name"), "status": ff.get("status"), "parse": ff.get("parse"), "error": ff.get("error")})
        ru = ff.get("result_url")
        if ru and save_results:
            same_origin = ru.startswith(BASE)
            dx = http("GET", ru, auth=same_origin)
            body = dx["body"]
            d = doc(dx)
            d["response"].pop("json", None)
            d["response"].pop("text_head", None)
            d["response"]["body_bytes"] = len(body)
            d["response"]["same_origin_key_sent"] = same_origin
            res_dir = os.path.join(out, f"result_{i}")
            ct = dx["headers"].get("content-type", "")
            if dx["status"] == 200 and body[:2] == b"PK":
                lst, z = listing(body)
                d["zip_listing"] = lst
                if len(body) <= KEEP_ZIP_MAX:
                    save_bytes(os.path.join(out, f"result_{i}.zip"), body)
                for member in ("markdown.md", "structured_content.json", "middle_json.json", "document.tex", "document.html", "document.docx"):
                    if member in z.namelist():
                        raw = z.read(member)
                        if member.endswith(".json"):
                            try:
                                save_json(os.path.join(res_dir, member), json.loads(raw.decode("utf-8")))
                            except Exception:
                                save_bytes(os.path.join(res_dir, member), raw)
                        else:
                            save_bytes(os.path.join(res_dir, member), raw)
                fs["result_zip"] = {"bytes": len(body), "members": [m["name"] for m in lst][:40], "member_count": len(lst)}
            else:
                save_bytes(os.path.join(res_dir, "raw.bin"), body[:200000])
                fs["result_nonzip"] = {"content_type": ct, "bytes": len(body)}
            save_json(os.path.join(out, f"04_result_download_{i}.json"), d)
    summary.update(tag_extra or {})
    save_json(os.path.join(out, "summary.json"), summary)
    return summary


def probe(slug, name, x, out_root=None):
    save_json(os.path.join(out_root or OUT_ROOT, slug, name + ".json"), doc(x))
    j = jbody(x)
    code = (j or {}).get("error", {}).get("code") if isinstance(j, dict) else None
    return {"case": name, "status": x["status"], "code": code}


if __name__ == "__main__":
    print("library only")
