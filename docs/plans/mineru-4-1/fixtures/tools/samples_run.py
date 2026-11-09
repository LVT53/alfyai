import json, os, sys, time
sys.path.insert(0, "/root/mineru41-spike")
import cap

S = "/root/mineru41-spike/samples/"
only = set(sys.argv[1:])
HU = "Árvíztűrő tükörfúrógép jelentés.pdf"

def f(name, **kw):
    d = {"path": S + name}
    d.update(kw)
    return d

RUNS = [
    # slug, files, top-level options
    ("pdf-paper-default-tier",  [f("paper-en.pdf")], {}),
    ("pdf-paper-standard",      [f("paper-en.pdf")], {"tier": "standard"}),
    ("pdf-paper-basic",         [f("paper-en.pdf")], {"tier": "basic"}),
    ("pdf-paper-flash",         [f("paper-en.pdf")], {"tier": "flash"}),
    ("pdf-paper-page-range-2",  [f("paper-en.pdf")], {"page_range": "2"}),
    ("pdf-paper-page-range-r1", [f("paper-en.pdf")], {"page_range": "r1"}),
    ("pdf-paper-ocr-forced",    [f("paper-en.pdf")], {"ocr_mode": "ocr", "tier": "basic"}),
    ("scan-png-default-tier",   [f("scan-page.png")], {}),
    ("scan-pdf-default-tier",   [f("scan-page.pdf")], {}),
    ("docx-default",            [f("report.docx")], {}),
    ("xlsx-default",            [f("data.xlsx")], {}),
    ("pptx-default",            [f("slides.pptx")], {}),
    ("html-default",            [f("page.html")], {}),
    ("csv-default",             [f("table.csv")], {}),
    ("pdf-hu-accented-name",    [f(HU)], {}),
    ("pdf-corrupt-truncated",   [f("corrupt.pdf")], {}),
    ("pdf-corrupt-garbage",     [f("garbage.pdf")], {}),
    ("txt-unsupported",         [f("notes.txt")], {}),
    ("mixed-batch-pdf-docx-csv", [f("paper-en.pdf"), f("report.docx"), f("table.csv")], {}),
    ("fmt-html-only",           [f("paper-en.pdf")], {"output_formats": ["html"]}),
    ("fmt-default-plus-docx",   [f("paper-en.pdf")], {"output_formats": ["default", "docx"]}),
    ("fmt-latex-only",          [f("paper-en.pdf")], {"output_formats": ["latex"]}),
    ("fmt-docx-only-from-docx", [f("report.docx")], {"output_formats": ["docx"]}),
]

for slug, files, top in RUNS:
    if only and slug not in only:
        continue
    t0 = time.time()
    try:
        s = cap.run_task(slug, files, top=top)
    except Exception as exc:  # keep going; record the failure
        s = {"slug": slug, "exception": repr(exc)}
    t1 = time.time()
    s["t_start_epoch"], s["t_end_epoch"] = round(t0, 3), round(t1, 3)
    cap.save_json(os.path.join(cap.OUT_ROOT, slug, "summary.json"), s)
    brief = {"slug": slug, "create": s.get("create_status"), "final": s.get("final_status"),
             "wall_ms": s.get("wall_ms_create_to_terminal"), "polls": s.get("polls_distinct"),
             "files": [{"st": x.get("status"), "tier": (x.get("parse") or {}).get("tier"),
                        "ms": (x.get("parse") or {}).get("duration_ms"), "err": (x.get("error") or {}).get("code"),
                        "zip": (x.get("result_zip") or {}).get("bytes")} for x in s.get("files", [])]}
    print(json.dumps(brief, ensure_ascii=False), flush=True)
