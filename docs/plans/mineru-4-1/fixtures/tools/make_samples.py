#!/usr/bin/env python3
"""Generate the spike's own sample documents (no user data) into ../samples/."""
import csv
import os
import random
import shutil
import subprocess
import sys
import textwrap
import time

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "samples")
TMP = os.path.join(ROOT, "gen", "tmp")
KATEX = os.path.join(HERE, "katex-pkg", "package", "dist")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
os.makedirs(OUT, exist_ok=True)
os.makedirs(TMP, exist_ok=True)

PANGRAM = "Árvíztűrő tükörfúrógép"
HU_SENTENCE = (
    "Az árvíztűrő tükörfúrógép egy magyar pangram: minden ékezetes magyar betűt tartalmaz, "
    "így az ő és az ű betűt is. A dokumentum feldolgozása után a szövegnek pontosan meg kell maradnia."
)


# ----------------------------------------------------------------------------- chart for the PDF
def make_chart(path):
    w, h = 900, 520
    im = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 26)
    fs = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 22)
    d.line([(90, 30), (90, 440), (860, 440)], fill="black", width=3)
    data = [("flash", 120, "#9ecae1"), ("basic", 70, "#6baed6"), ("standard", 40, "#3182bd"), ("advanced", 22, "#08519c")]
    x = 150
    for name, val, col in data:
        top = 440 - val * 3
        d.rectangle([x, top, x + 120, 440], fill=col, outline="black", width=2)
        d.text((x + 12, 450), name, fill="black", font=fs)
        d.text((x + 36, top - 32), str(val), fill="black", font=fs)
        x += 170
    d.text((100, 480), "pages per second (higher is better)", fill="black", font=f)
    d.text((100, 2), "Throughput by tier", fill="black", font=f)
    im.save(path)


# ----------------------------------------------------------------------------- text PDF via Chrome + KaTeX
def paper_html(chart_path):
    css = open(os.path.join(KATEX, "katex.min.css"), encoding="utf-8").read()
    katex_js = "file://" + os.path.join(KATEX, "katex.min.js")
    auto_js = "file://" + os.path.join(KATEX, "contrib", "auto-render.min.js")
    css = css.replace("url(fonts/", "url(file://" + os.path.join(KATEX, "fonts") + "/")
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Throughput of tiered document parsing</title>
<style>{css}</style>
<script src="{katex_js}"></script><script src="{auto_js}"></script>
<style>
@page {{ size: A4; margin: 20mm 20mm 20mm 20mm; }}
html,body {{ margin:0; padding:0; }}
body {{ font-family: "Times New Roman", Times, serif; font-size: 11pt; line-height: 1.35; color:#000; }}
.page {{ position: relative; height: 255mm; page-break-after: always; overflow: hidden; }}
.page:last-child {{ page-break-after: auto; }}
.running {{ position:absolute; top:0; right:0; font-size:9pt; font-style:italic; }}
.pageno {{ position:absolute; bottom:0; left:0; right:0; text-align:center; font-size:10pt; }}
h1 {{ font-size:18pt; text-align:center; margin: 12mm 0 3mm 0; }}
.authors {{ text-align:center; margin-bottom: 6mm; }}
.abstract {{ margin: 0 10mm 5mm 10mm; font-size:10pt; }}
h2 {{ font-size:13pt; margin: 6mm 0 2mm 0; }}
p {{ margin: 0 0 3mm 0; text-align: justify; }}
.eq {{ text-align:center; margin: 3mm 0; }}
.footnote {{ position:absolute; bottom: 9mm; left:0; width: 60%; border-top: 0.5pt solid #000; padding-top:1mm; font-size: 8.5pt; }}
table {{ border-collapse: collapse; margin: 2mm auto 2mm auto; font-size:10pt; }}
th, td {{ border: 1px solid #000; padding: 1.2mm 4mm; text-align:right; }}
th:first-child, td:first-child {{ text-align:left; }}
.cap {{ text-align:center; font-size:10pt; margin-bottom: 4mm; }}
.fig {{ text-align:center; margin: 3mm 0 1mm 0; }}
.fig img {{ width: 120mm; }}
</style></head><body>
<div class="page">
  <div class="running">Spike Journal of Document Parsing, Vol. 1</div>
  <h1>Throughput of Tiered Document Parsing</h1>
  <div class="authors">Ada Example, Bela Minta</div>
  <div class="abstract"><b>Abstract.</b> We compare four parsing tiers on a small synthetic corpus and report how
  layout analysis, optical character recognition and formula recognition change throughput and fidelity.</div>
  <h2>1. Introduction</h2>
  <p>Let $x_i \\in \\mathbb{{R}}^d$ denote the feature vector of page $i$, and let $\\alpha \\in (0,1)$ be a mixing weight.
  The empirical loss is $\\mathcal{{L}}(\\theta) = \\frac{{1}}{{N}}\\sum_{{i=1}}^{{N}} \\ell(f_\\theta(x_i), y_i)$ and the
  regulariser satisfies $\\|\\theta\\|_2 \\le 1$.<sup>1</sup> The latency model that we fit is given by</p>
  <div class="eq">$$T(n) = a + b\\,n + c\\,n^2, \\qquad \\int_0^\\infty e^{{-x^2}}\\,dx = \\frac{{\\sqrt{{\\pi}}}}{{2}} \\tag{{1}}$$</div>
  <p>where $n$ is the number of pages and $a$, $b$, $c$ are fitted constants. In Section 2 we report the measured
  latencies, and we discuss the Hungarian-language test page in Section 3.</p>
  <h2>2. Method</h2>
  <p>Each document is parsed once per tier. The median and the 95th percentile of the wall-clock time are recorded
  for every run, and the results are summarised in Table 1 on the next page.</p>
  <div class="footnote"><sup>1</sup> The norm constraint is the usual unit-ball regularisation; it is stated here only as an example footnote.</div>
  <div class="pageno">1</div>
</div>
<div class="page">
  <div class="running">Spike Journal of Document Parsing, Vol. 1</div>
  <div style="height:12mm"></div>
  <div class="cap"><b>Table 1.</b> Parsing latency by tier (milliseconds).</div>
  <table>
    <tr><th>Tier</th><th>Pages</th><th>Median</th><th>p95</th></tr>
    <tr><td>flash</td><td>12</td><td>810</td><td>1 240</td></tr>
    <tr><td>basic</td><td>12</td><td>1 126</td><td>2 980</td></tr>
    <tr><td>standard</td><td>12</td><td>4 310</td><td>9 870</td></tr>
    <tr><td>advanced</td><td>12</td><td>7 450</td><td>15 200</td></tr>
  </table>
  <div class="fig"><img src="file://{chart_path}"></div>
  <div class="cap"><b>Figure 1.</b> Relative throughput by tier.</div>
  <h2>3. Hungarian test page</h2>
  <p>{HU_SENTENCE} ÁRVÍZTŰRŐ TÜKÖRFÚRÓGÉP.</p>
  <p>The quadratic term satisfies $c &gt; 0$ for every tier, and the fitted curve passes within $\\epsilon = 0.05$ of each measurement.</p>
  <div class="pageno">2</div>
</div>
<script>renderMathInElement(document.body, {{delimiters:[{{left:'$$',right:'$$',display:true}},{{left:'$',right:'$',display:false}}], throwOnError:false}});</script>
</body></html>"""


def chrome_pdf(html_path, pdf_path):
    prof = os.path.join(TMP, "chrome-profile")
    shutil.rmtree(prof, ignore_errors=True)
    if os.path.exists(pdf_path):
        os.remove(pdf_path)
    cmd = [CHROME, "--headless=new", "--disable-gpu", "--no-first-run", f"--user-data-dir={prof}",
           "--no-pdf-header-footer", "--print-to-pdf-no-header", f"--print-to-pdf={pdf_path}",
           "--allow-file-access-from-files", "--virtual-time-budget=8000", "file://" + html_path]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    t0 = time.time()
    while time.time() - t0 < 60:
        if os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 1000:
            time.sleep(1.0)
            break
        time.sleep(0.5)
    proc.terminate()
    subprocess.run(["pkill", "-f", prof], check=False)
    if not (os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 1000):
        sys.exit("chrome did not produce " + pdf_path)


def make_paper():
    chart = os.path.join(TMP, "chart.png")
    make_chart(chart)
    html = os.path.join(TMP, "paper.html")
    open(html, "w", encoding="utf-8").write(paper_html(chart))
    chrome_pdf(html, os.path.join(OUT, "paper-en.pdf"))


def make_hu_pdf():
    html = os.path.join(TMP, "hu.html")
    open(html, "w", encoding="utf-8").write(f"""<!doctype html><html lang="hu"><head><meta charset="utf-8"><title>Jelentés</title>
<style>@page {{ size: A4; margin: 25mm; }} body {{ font-family: Georgia, serif; font-size: 12pt; line-height:1.4 }} h1 {{ font-size: 20pt }}</style></head><body>
<h1>{PANGRAM} jelentés</h1>
<p>{HU_SENTENCE}</p>
<p>Készítette: Kovács Árpád és Tóth Ágnes. Dátum: 2026. november 5. Tárgy: ékezetes fájlnév és szöveg ellenőrzése.</p>
<ul><li>első tétel: árvíz</li><li>második tétel: tűrő</li><li>harmadik tétel: fúrógép</li></ul>
</body></html>""")
    chrome_pdf(html, os.path.join(OUT, f"{PANGRAM} jelentés.pdf"))


# ----------------------------------------------------------------------------- scanned-style page
def make_scan():
    w, h = 1654, 2339  # A4 @ 200 dpi
    im = Image.new("L", (w, h), 245)
    d = ImageDraw.Draw(im)
    tnr = "/System/Library/Fonts/Supplemental/Times New Roman.ttf"
    tnrb = "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf"
    ft, fb, fh = ImageFont.truetype(tnrb, 64), ImageFont.truetype(tnr, 40), ImageFont.truetype(tnrb, 46)
    y = 190
    d.text((200, y), "Scanned Page Sample", fill=20, font=ft)
    y += 140
    paras = [
        "This page was rendered to pixels and then degraded with noise, blur and a small rotation so that no text layer "
        "exists. The parser has to recognise the characters with optical character recognition rather than read them "
        "from the file. The quick brown fox jumps over the lazy dog, 0123456789.",
        "",
        "Second paragraph. Tiered parsing trades speed for fidelity: flash is fastest, advanced is most careful. "
        "A short list follows: alpha, beta, gamma. The invoice total is 1,234.50 EUR (VAT included).",
        "",
        "Magyar sor: " + PANGRAM + " - ékezetes betűk: á é í ó ö ő ú ü ű.",
    ]
    for para in paras:
        if para == "":
            y += 40
            continue
        for line in textwrap.wrap(para, 66):
            d.text((200, y), line, fill=25, font=fb)
            y += 62
    y += 80
    d.text((200, y), "Table of results", fill=20, font=fh)
    y += 90
    rows = [("tier", "pages", "ms"), ("flash", "1", "810"), ("basic", "1", "1126"), ("standard", "1", "4310")]
    for ri, row in enumerate(rows):
        x = 200
        for ci, cell in enumerate(row):
            d.rectangle([x, y, x + 360, y + 70], outline=30, width=3)
            d.text((x + 20, y + 12), cell, fill=25, font=fb)
            x += 360
        y += 70
    im = im.rotate(0.7, resample=Image.BICUBIC, fillcolor=245, expand=False)
    random.seed(7)
    px = im.load()
    for _ in range(int(w * h * 0.02)):
        x, yy = random.randrange(w), random.randrange(h)
        px[x, yy] = max(0, min(255, px[x, yy] + random.randint(-60, 40)))
    im = im.filter(ImageFilter.GaussianBlur(0.9))
    png = os.path.join(OUT, "scan-page.png")
    im.save(png)
    im.convert("RGB").save(os.path.join(OUT, "scan-page.pdf"), "PDF", resolution=200.0)


# ----------------------------------------------------------------------------- office formats
def make_docx():
    import docx
    from docx.shared import Inches

    d = docx.Document()
    d.core_properties.title = "Spike report"
    d.core_properties.author = "Spike Author"
    d.add_heading("Spike Report", level=0)
    d.add_heading("1. Overview", level=1)
    d.add_paragraph("This DOCX exercises headings, paragraphs, a list, a table, and Hungarian text. " + HU_SENTENCE)
    d.add_paragraph("First bullet", style="List Bullet")
    d.add_paragraph("Second bullet", style="List Bullet")
    d.add_paragraph("Numbered one", style="List Number")
    d.add_paragraph("Numbered two", style="List Number")
    d.add_heading("2. Results", level=1)
    t = d.add_table(rows=3, cols=3)
    t.style = "Table Grid"
    for r, row in enumerate([("Tier", "Pages", "Median ms"), ("flash", "12", "810"), ("basic", "12", "1126")]):
        for c, v in enumerate(row):
            t.cell(r, c).text = v
    d.add_paragraph("")
    p = d.add_paragraph()
    run = p.add_run("Bold run. ")
    run.bold = True
    p.add_run("Plain run. ")
    it = p.add_run("Italic run.")
    it.italic = True
    d.add_picture(os.path.join(TMP, "chart.png"), width=Inches(4.0))
    d.add_paragraph("Figure 1. Throughput by tier.")
    d.save(os.path.join(OUT, "report.docx"))


def make_xlsx():
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Latency"
    ws.append(["Tier", "Pages", "Median ms", "p95 ms", "Note"])
    ws.append(["flash", 12, 810, 1240, "fast"])
    ws.append(["basic", 12, 1126, 2980, "OCR"])
    ws.append(["standard", 12, 4310, 9870, "árvíztűrő"])
    ws.append(["advanced", 12, 7450, 15200, "tükörfúrógép"])
    ws["A7"] = "Total median"
    ws["C7"] = "=SUM(C2:C5)"
    ws2 = wb.create_sheet("Notes")
    ws2.append(["Key", "Value"])
    ws2.append(["language", "hu"])
    ws2.append(["sentence", HU_SENTENCE])
    wb.save(os.path.join(OUT, "data.xlsx"))


def make_pptx():
    from pptx import Presentation
    from pptx.util import Inches

    prs = Presentation()
    s = prs.slides.add_slide(prs.slide_layouts[0])
    s.shapes.title.text = "Tiered Parsing"
    s.placeholders[1].text = "Spike deck: árvíztűrő tükörfúrógép"
    s2 = prs.slides.add_slide(prs.slide_layouts[1])
    s2.shapes.title.text = "Key points"
    tf = s2.placeholders[1].text_frame
    tf.text = "Flash is fastest"
    for line in ("Basic adds OCR", "Standard adds the VLM", "Advanced spends more compute"):
        tf.add_paragraph().text = line
    s2.notes_slide.notes_text_frame.text = "Speaker notes: remember to mention the Hungarian test page."
    s3 = prs.slides.add_slide(prs.slide_layouts[5])
    s3.shapes.title.text = "Latency table"
    tbl = s3.shapes.add_table(3, 3, Inches(1), Inches(2), Inches(6), Inches(1.5)).table
    for r, row in enumerate([("Tier", "Pages", "ms"), ("flash", "12", "810"), ("basic", "12", "1126")]):
        for c, v in enumerate(row):
            tbl.cell(r, c).text = v
    prs.save(os.path.join(OUT, "slides.pptx"))


def make_html_csv_txt():
    open(os.path.join(OUT, "page.html"), "w", encoding="utf-8").write(f"""<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><title>Spike HTML page</title></head><body>
<h1>Spike HTML page</h1>
<p>An <em>HTML</em> document with a table and a list. {HU_SENTENCE}</p>
<ul><li>alma</li><li>körte</li><li>szilva</li></ul>
<table border="1"><thead><tr><th>Tier</th><th>Median ms</th></tr></thead>
<tbody><tr><td>flash</td><td>810</td></tr><tr><td>basic</td><td>1126</td></tr></tbody></table>
<h2>Footer</h2><p>End of page.</p></body></html>""")
    with open(os.path.join(OUT, "table.csv"), "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["tier", "pages", "median_ms", "megjegyzés"])
        w.writerow(["flash", 12, 810, "gyors"])
        w.writerow(["basic", 12, 1126, "ékezetes: árvíztűrő"])
        w.writerow(["standard", 12, 4310, "tükörfúrógép"])
    open(os.path.join(OUT, "notes.txt"), "w", encoding="utf-8").write("Plain text note. " + HU_SENTENCE + "\n")


def make_corrupt():
    src = open(os.path.join(OUT, "paper-en.pdf"), "rb").read()
    open(os.path.join(OUT, "corrupt.pdf"), "wb").write(src[: int(len(src) * 0.35)])
    open(os.path.join(OUT, "garbage.pdf"), "wb").write(b"%PDF-1.7\n" + bytes(random.Random(3).randrange(256) for _ in range(4000)))


if __name__ == "__main__":
    make_paper()
    make_hu_pdf()
    make_scan()
    make_docx()
    make_xlsx()
    make_pptx()
    make_html_csv_txt()
    make_corrupt()
    for n in sorted(os.listdir(OUT)):
        print(f"{os.path.getsize(os.path.join(OUT, n)):>9}  {n}")
