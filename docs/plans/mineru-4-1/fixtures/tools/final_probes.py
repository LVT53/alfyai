import json, os, sys, time
sys.path.insert(0, "/root/mineru41-spike")
import cap
S = "/root/mineru41-spike/samples/"

def run(slug, name, data, top=None):
    s = cap.run_task("final/" + slug, [{"data": data, "file_name": name}], top=top or {})
    f = s["files"][0]
    print(json.dumps({"slug": slug, "name": name, "final": s.get("final_status"), "tier": (f.get("parse") or {}).get("tier"),
                      "err": f.get("error"), "put": f.get("put_status")}, ensure_ascii=False), flush=True)

rd = lambda n: open(S + n, "rb").read()
run("encrypted-pdf", "encrypted.pdf", rd("encrypted.pdf"))
run("zero-pages-pdf", "zero-pages.pdf", rd("zero-pages.pdf"))
run("one-byte-pdf", "one.pdf", b"x")
run("docx-bytes-named-pdf", "report-as.pdf", rd("report.docx"))
run("png-bytes-named-pdf", "scan-as.pdf", rd("scan-page.png"))
run("pdf-bytes-named-png", "paper-as.png", rd("paper-en.pdf"))
run("csv-bytes-named-xlsx", "table-as.xlsx", rd("table.csv"))
run("pdf-bytes-named-docx-explicit-standard", "paper-as.docx", rd("paper-en.pdf"), {"tier": "standard"})
run("png-ok-flash", "scan.png", rd("scan-page.png"), {"tier": "flash"})
run("png-ok-basic", "scan.png", rd("scan-page.png"), {"tier": "basic"})
x = cap.http("GET", "/v1/usage")
cap.save_json("/root/mineru41-spike/captures/final/usage_now.json", cap.doc(x))
print("usage_now:", json.dumps(cap.jbody(x)))
