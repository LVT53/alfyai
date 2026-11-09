import json, os, sys, time
sys.path.insert(0, "/root/mineru41-spike")
import cap

SLUG = "errors"
S = "/root/mineru41-spike/samples/"
created = []          # task ids made by probes that were accepted (cancelled at the end)
rows = []
n = [0]


def P(name, method, path, **kw):
    n[0] += 1
    key = f"{n[0]:02d}_{name}"
    x = cap.http(method, path, **kw)
    r = cap.probe(SLUG, key, x)
    j = cap.jbody(x)
    if x["status"] == 202 and isinstance(j, dict) and j.get("task_id"):
        created.append(j["task_id"])
    r["name"] = key
    r["msg"] = ((j or {}).get("error") or {}).get("message") if isinstance(j, dict) else None
    r["param"] = ((j or {}).get("error") or {}).get("param") if isinstance(j, dict) else None
    if isinstance(j, dict) and "detail" in j:
        r["detail"] = j["detail"] if isinstance(j["detail"], str) else "<list>"
    rows.append(r)
    print(json.dumps(r, ensure_ascii=False)[:420], flush=True)
    return x, j


def valid(name="x.pdf", nbytes=1234, **over):
    e = {"file_name": name, "bytes": nbytes}
    e.update(over)
    return {"files": [e]}


# ---- auth -----------------------------------------------------------------------------------
P("auth_wrong_key_create", "POST", "/v1/tasks", json_body=valid(), key="wrong-key-for-spike")
P("auth_no_key_create", "POST", "/v1/tasks", json_body=valid(), auth=False)
P("auth_wrong_key_usage", "GET", "/v1/usage", key="wrong-key-for-spike")
P("auth_no_key_get_task", "GET", "/v1/tasks/job_doesnotexist", auth=False)
P("auth_no_key_tiers", "GET", "/v1/tiers", auth=False)
P("auth_no_key_openapi", "GET", "/openapi.json", auth=False)
P("auth_basic_scheme", "GET", "/v1/usage", headers={"Authorization": "Basic Zm9vOmJhcg=="}, auth=False)

# ---- tiers ----------------------------------------------------------------------------------
P("tier_advanced_above_ceiling", "POST", "/v1/tasks", json_body={**valid(), "tier": "advanced"})
P("tier_bogus", "POST", "/v1/tasks", json_body={**valid(), "tier": "bogus"})
P("tier_empty_string", "POST", "/v1/tasks", json_body={**valid(), "tier": ""})
P("tier_null_accepted", "POST", "/v1/tasks", json_body={**valid(), "tier": None})
P("tier_advanced_native_doc_ignored", "POST", "/v1/tasks", json_body={**valid("a.docx"), "tier": "advanced"})
P("tier_uppercase", "POST", "/v1/tasks", json_body={**valid(), "tier": "Standard"})

# ---- file_name rules ------------------------------------------------------------------------
for label, nm in [
    ("dotdot_slash", "../x.pdf"), ("backslash_dotdot", "..\\x.pdf"), ("windows_drive", "C:\\input\\report.csv"),
    ("colon_stream", "report.csv:stream"), ("subdir_slash", "a/b.pdf"), ("single_dot", "."), ("double_dot", ".."),
    ("empty", ""), ("control_char", "bad\u0007name.pdf"), ("newline", "bad\nname.pdf"), ("too_long_1025", "a" * 1021 + ".pdf"),
    ("max_len_1024", "a" * 1020 + ".pdf"), ("leading_dot_ok", ".report.csv"), ("double_dot_inside_ok", "report..csv"),
    ("spaces_ok", "my report final.pdf"), ("accents_ok", "Árvíztűrő jelentés.pdf"), ("trailing_space_ok", "x.pdf "),
    ("percent_encoded_ok", "a%2Fb.pdf"), ("nul_byte", "a\u0000b.pdf"), ("no_extension", "README"), ("unknown_extension", "x.xyz"),
]:
    P("filename_" + label, "POST", "/v1/tasks", json_body=valid(nm))

# ---- old fields / protocol ------------------------------------------------------------------
P("old_filename_field", "POST", "/v1/tasks", json_body={"files": [{"filename": "x.pdf", "bytes": 10}]})
P("old_filename_plus_file_name", "POST", "/v1/tasks", json_body={"files": [{"file_name": "x.pdf", "filename": "x.pdf", "bytes": 10}]})
P("old_manifest_top_level", "POST", "/v1/tasks", json_body={"manifest": [{"filename": "x.pdf", "bytes": 10}]})
P("old_client_file_id", "POST", "/v1/tasks", json_body={"files": [{"file_name": "x.pdf", "bytes": 10, "client_file_id": "c1"}]})
P("old_client_file_id_null", "POST", "/v1/tasks", json_body={"files": [{"file_name": "x.pdf", "bytes": 10, "client_file_id": None}]})
P("old_file_id_field", "POST", "/v1/tasks", json_body={"files": [{"file_name": "x.pdf", "bytes": 10, "file_id": "f1"}]})
P("old_source_object", "POST", "/v1/tasks", json_body={"files": [{"source": {"type": "upload"}, "bytes": 10}]})
P("old_upload_method", "POST", "/v1/tasks", json_body={"files": [{"file_name": "x.pdf", "bytes": 10, "upload_method": "put"}]})
P("old_purpose_callback_top", "POST", "/v1/tasks", json_body={**valid(), "purpose": "parse", "callback": {"url": "https://example.invalid/cb"}})
P("old_include_model_output_true", "POST", "/v1/tasks", json_body={**valid(), "include_model_output": True})
P("old_include_model_output_false", "POST", "/v1/tasks", json_body={**valid(), "include_model_output": False})
P("old_output_formats_markdown", "POST", "/v1/tasks", json_body={**valid(), "output_formats": ["markdown"]})
P("old_output_formats_zip", "POST", "/v1/tasks", json_body={**valid(), "output_formats": ["zip"]})
P("files_as_json_string", "POST", "/v1/tasks", json_body={"files": json.dumps([{"file_name": "x.pdf", "bytes": 10}])})

# ---- removed endpoints ----------------------------------------------------------------------
P("removed_post_uploads", "POST", "/v1/uploads", json_body={"filename": "x.pdf", "bytes": 10, "purpose": "parse"})
P("removed_get_upload", "GET", "/v1/uploads/upl_x")
P("removed_put_upload_content", "PUT", "/v1/uploads/upl_x/content", raw_body=b"abc", headers={"Content-Type": "application/octet-stream"})
P("removed_post_upload_complete", "POST", "/v1/uploads/upl_x/complete", json_body={})
P("removed_post_parse_jobs", "POST", "/v1/parse/jobs", json_body={"files": [{"file_id": "f", "name": "x.pdf"}]})
P("removed_get_parse_jobs_list", "GET", "/v1/parse/jobs")
P("removed_get_parse_job", "GET", "/v1/parse/jobs/job_x")
P("removed_delete_parse_job", "DELETE", "/v1/parse/jobs/job_x")
P("removed_get_files_list", "GET", "/v1/files")
P("removed_file_parse_endpoint", "POST", "/v1/file_parse", raw_body=b"x")
P("delete_task_not_allowed", "DELETE", "/v1/tasks/job_x")
P("get_tasks_collection", "GET", "/v1/tasks")

# ---- validation of other fields -------------------------------------------------------------
P("files_empty", "POST", "/v1/tasks", json_body={"files": []})
P("files_missing", "POST", "/v1/tasks", json_body={})
P("files_101", "POST", "/v1/tasks", json_body={"files": [{"file_name": f"f{i}.pdf", "bytes": 10} for i in range(101)]})
P("files_100_ok", "POST", "/v1/tasks", json_body={"files": [{"file_name": f"f{i}.pdf", "bytes": 10} for i in range(100)]})
P("duplicate_names_ok", "POST", "/v1/tasks", json_body={"files": [{"file_name": "same.pdf", "bytes": 10}, {"file_name": "same.pdf", "bytes": 10}]})
P("bytes_missing_for_upload", "POST", "/v1/tasks", json_body={"files": [{"file_name": "x.pdf"}]})
P("bytes_zero", "POST", "/v1/tasks", json_body=valid(nbytes=0))
P("bytes_negative", "POST", "/v1/tasks", json_body=valid(nbytes=-5))
P("bytes_string", "POST", "/v1/tasks", json_body=valid(nbytes="12"))
P("bytes_float", "POST", "/v1/tasks", json_body=valid(nbytes=1.5))
P("bytes_null_for_upload", "POST", "/v1/tasks", json_body=valid(nbytes=None))
P("sha256_uppercase", "POST", "/v1/tasks", json_body=valid(sha256sum="A" * 64))
P("sha256_not_hex", "POST", "/v1/tasks", json_body=valid(sha256sum="nothex"))
P("sha256_null_ok", "POST", "/v1/tasks", json_body=valid(sha256sum=None))
P("ocr_mode_bogus", "POST", "/v1/tasks", json_body={**valid(), "ocr_mode": "bogus"})
P("ocr_mode_null", "POST", "/v1/tasks", json_body={**valid(), "ocr_mode": None})
P("ocr_mode_txt_ok", "POST", "/v1/tasks", json_body={**valid(), "ocr_mode": "txt"})
P("page_range_garbage", "POST", "/v1/tasks", json_body={**valid(), "page_range": "abc"})
P("page_range_reversed", "POST", "/v1/tasks", json_body={**valid(), "page_range": "5-2"})
P("page_range_zero", "POST", "/v1/tasks", json_body={**valid(), "page_range": "0"})
P("page_range_all_ok", "POST", "/v1/tasks", json_body={**valid(), "page_range": "all"})
P("page_range_per_file_garbage", "POST", "/v1/tasks", json_body=valid(page_range="x-y"))
P("page_range_null", "POST", "/v1/tasks", json_body={**valid(), "page_range": None})
P("output_formats_empty", "POST", "/v1/tasks", json_body={**valid(), "output_formats": []})
P("output_formats_json", "POST", "/v1/tasks", json_body={**valid(), "output_formats": ["json"]})
P("output_formats_dupes", "POST", "/v1/tasks", json_body={**valid(), "output_formats": ["html", "default", "html"]})
P("output_formats_string", "POST", "/v1/tasks", json_body={**valid(), "output_formats": "default"})
P("unknown_top_level_field", "POST", "/v1/tasks", json_body={**valid(), "foo": 1})
P("unknown_file_field", "POST", "/v1/tasks", json_body={"files": [{"file_name": "x.pdf", "bytes": 10, "foo": 1}]})
P("query_parameter", "POST", "/v1/tasks?x=1", json_body=valid())
P("content_type_text_plain", "POST", "/v1/tasks", raw_body=json.dumps(valid()).encode(), headers={"Content-Type": "text/plain"})
P("content_type_form", "POST", "/v1/tasks", raw_body=b"files=1", headers={"Content-Type": "application/x-www-form-urlencoded"})
P("content_type_json_charset_ok", "POST", "/v1/tasks", raw_body=json.dumps(valid()).encode(), headers={"Content-Type": "application/json; charset=utf-8"})
P("body_invalid_json", "POST", "/v1/tasks", raw_body=b"{not json", headers={"Content-Type": "application/json"})
P("body_json_array", "POST", "/v1/tasks", raw_body=b"[]", headers={"Content-Type": "application/json"})
P("body_empty", "POST", "/v1/tasks", raw_body=b"", headers={"Content-Type": "application/json"})
P("url_http_scheme", "POST", "/v1/tasks", json_body={"files": [{"file_name": "x.pdf", "url": "http://example.invalid/x.pdf"}]})
P("url_with_upload_fields_both", "POST", "/v1/tasks", json_body={"files": [{"file_name": "x.pdf", "bytes": 10, "url": "https://example.invalid/x.pdf"}]})
P("url_loopback_https_refused_port", "POST", "/v1/tasks", json_body={"files": [{"file_name": "never.pdf", "url": "https://127.0.0.1:9/never.pdf"}]})

# ---- unknown ids ----------------------------------------------------------------------------
P("get_unknown_task", "GET", "/v1/tasks/job_000000000000000000000000")
P("get_task_weird_id_slash", "GET", "/v1/tasks/a%2Fb")
P("cancel_unknown_task", "POST", "/v1/tasks/job_000000000000000000000000/cancel")
P("put_unknown_task_unknown_file", "PUT", "/v1/tasks/job_000000000000000000000000/uploads/file-000000000000000000000000", raw_body=b"abc", headers={"Content-Type": "application/octet-stream"})
P("get_unknown_file_meta", "GET", "/v1/files/file-000000000000000000000000")
P("get_unknown_file_content", "GET", "/v1/files/file-000000000000000000000000/content")
P("get_unknown_model", "GET", "/v1/models/nope")

# ---- upload-level errors (need a live task) --------------------------------------------------
def mk(name, data, **over):
    e = {"file_name": name, "bytes": len(data), "sha256sum": cap.sha256_hex(data)}
    e.update(over)
    x = cap.http("POST", "/v1/tasks", json_body={"files": [e]})
    j = cap.jbody(x)
    created.append(j["task_id"])
    return j["task_id"], j["files"][0], x

pdf = open(S + "paper-en.pdf", "rb").read()
fresh = pdf + b"\n%spike-unique-" + str(time.time()).encode() + b"\n"   # unique hash so the cache cannot short-circuit
HDR = {"Content-Type": "application/octet-stream"}

tid, f0, _ = mk("size-short.pdf", fresh)
up = f0["upload"]["url"]
P("upload_size_short_by_one", "PUT", up, raw_body=fresh[:-1], headers=HDR)
P("task_after_size_short", "GET", "/v1/tasks/" + tid)
P("upload_retry_full_after_short", "PUT", up, raw_body=fresh, headers=HDR)
P("task_after_retry", "GET", "/v1/tasks/" + tid)

fresh2 = pdf + b"\n%spike-unique2-" + str(time.time()).encode() + b"\n"
tid, f0, _ = mk("size-long.pdf", fresh2)
P("upload_size_long_by_one", "PUT", f0["upload"]["url"], raw_body=fresh2 + b"x", headers=HDR)
P("task_after_size_long", "GET", "/v1/tasks/" + tid)

fresh3 = pdf + b"\n%spike-unique3-" + str(time.time()).encode() + b"\n"
tid, f0, _ = mk("hash-wrong.pdf", fresh3, sha256sum="0" * 64)
P("upload_hash_mismatch_right_size", "PUT", f0["upload"]["url"], raw_body=fresh3, headers=HDR)
P("task_after_hash_mismatch", "GET", "/v1/tasks/" + tid)

fresh4 = pdf + b"\n%spike-unique4-" + str(time.time()).encode() + b"\n"
tid, f0, _ = mk("auth-put.pdf", fresh4)
up4 = f0["upload"]["url"]
P("upload_no_key", "PUT", up4, raw_body=fresh4, headers=HDR, auth=False)
P("upload_wrong_key", "PUT", up4, raw_body=fresh4, headers=HDR, key="wrong-key-for-spike")
P("upload_wrong_content_type_text", "PUT", up4, raw_body=fresh4, headers={"Content-Type": "text/plain"})
P("task_after_wrong_content_type", "GET", "/v1/tasks/" + tid)
P("upload_again_after_success", "PUT", up4, raw_body=fresh4, headers=HDR)
# wait for completion then upload again / cancel finished
for _ in range(60):
    j = cap.jbody(cap.http("GET", "/v1/tasks/" + tid))
    if j and j.get("status") in cap.TERMINAL:
        break
    time.sleep(0.5)
P("upload_to_finished_file", "PUT", up4, raw_body=fresh4, headers=HDR)
P("cancel_finished_task", "POST", "/v1/tasks/" + tid + "/cancel")
P("cancel_finished_task_with_body", "POST", "/v1/tasks/" + tid + "/cancel", json_body={})

tid, f0, _ = mk("empty-put.pdf", pdf + b"\n%spike-unique5\n")
P("upload_zero_bytes", "PUT", f0["upload"]["url"], raw_body=b"", headers=HDR)
P("task_after_zero_bytes", "GET", "/v1/tasks/" + tid)

# cancel while still waiting for the file
tid, f0, _ = mk("cancel-waiting.pdf", pdf + b"\n%spike-unique6\n")
P("cancel_waiting_file", "POST", "/v1/tasks/" + tid + "/cancel")
P("task_after_cancel_waiting", "GET", "/v1/tasks/" + tid)
P("cancel_waiting_twice", "POST", "/v1/tasks/" + tid + "/cancel")
P("upload_after_cancel", "PUT", f0["upload"]["url"], raw_body=pdf + b"\n%spike-unique6\n", headers=HDR)

# non-JSON / HEAD / OPTIONS style probes
P("head_task", "HEAD", "/v1/tasks/" + tid)
P("options_tasks", "OPTIONS", "/v1/tasks")

json.dump({"created_task_ids": created}, open("/root/mineru41-spike/errors_created.json", "w"))
print("DONE", len(rows), "probes;", len(created), "tasks left to cancel")
