# Phase 0 — MinerU 4.0.4 local spike (recorded facts)

Purpose: replace the guesses in the upstream **Draft** docs with behaviour actually observed
from a MinerU 4.0.4 Local Parse Server, so the TypeScript client and result parser are written
against reality. Every claim here is backed by a fixture under `fixtures/mineru-v1/`.

Run date: 2026-09-20. Host: Apple Silicon Mac, macOS (Darwin 27.0.0).

> **Tier coverage.** All document fixtures were produced by a server started with `--tier basic`.
> The job-level tier was `basic` for every job, but the *file-level effective* tier was `flash`
> for CSV/DOCX/XLSX/PPTX/HTML/EPUB and `basic` only for PDF/PNG/JPEG (see
> [Tiers](#6-tiers-and-the-effective-tier-trap)). `fixtures/mineru-v1/flash-pdf/` holds the same
> PDF parsed by a `--tier flash` server.
> **`standard` and `advanced` (VLM) output was NOT captured** — those tiers are not available in
> this process and must be re-checked on the GPU box before the parser is trusted for them.

---

## 1. Install

| Component | Version | Note |
|---|---|---|
| Python | 3.12.14 | `/opt/homebrew/bin/python3.12`. System default was 3.14.7; 3.12 chosen for wheel availability. `mineru` requires `>=3.10,<3.15`. |
| mineru | 4.0.4 | `pip install "mineru==4.0.4"`, base package, **no extras needed** |
| docvortex | 0.4.18 | pulled in automatically; owns the middle-JSON schema |
| mineru-vl-utils | 2.0.5 | dist name `mineru_vl_utils` |
| mineru-llama-cpp | 0.1.2 | |
| torch / torchvision | 2.14.0 / 0.29.0 | **auto-installed**: on `darwin+arm64` the base package requires `mineru[torch]` |
| transformers | 5.17.0 | via `mineru[torch]` |
| fastapi / uvicorn / pydantic | 0.141.1 / 0.53.0 / 2.13.5 | |

```bash
python3.12 -m venv <scratch>/mineru4-venv
<scratch>/mineru4-venv/bin/pip install "mineru==4.0.4"
```

- Venv size **1.6 GB** (torch dominates). No extras were required to serve the API.
- Models are lazy: **nothing downloads at startup**. The first `basic` PDF/image job pulls
  `MinerU-4_models_torch` (Layout, OCR, Table) into `$MINERU_HOME/models` — **252 MB total**,
  well under the 3 GB budget. `flash` needs no models at all.
- Telemetry posts to `https://mineru.net/metrics/v2/metrics`; consent lives in
  `$MINERU_HOME/doclib.db`. Disabled before any parsing (`state: disabled` confirmed).

### 1.1 Two install-time gotchas

1. **`mineru telemetry status|disable` requires the doclib daemon** (`mineru server start`) —
   it is not a local config edit. Without it: `Error: Local mineru server is not running.`
2. **`MINERU_HOME` must be a short path.** The doclib daemon binds a Unix socket under it and
   fails with `OSError: AF_UNIX path too long` when the path is long (our scratchpad path is
   ~120 chars). Worked around with a short symlink. The `api-server` itself is unaffected —
   this only breaks the doclib daemon, and therefore the telemetry CLI.

## 2. Server flags used

```bash
MINERU_HOME=<short-path>/mineru-home \
  mineru-kit api-server --host 127.0.0.1 --port 8765 \
    --tier basic --upload-dir <scratch>/uploads
```

Variants also recorded: `--tier flash` (→ `fixtures/mineru-v1/server/flash.*.json`,
`errors/flash_*.json`) and `--tier basic --api-key testkey` (→ `errors/auth_*.json`,
`errors/keyed_*.json`).

`--api-key` is a single fixed key; presenting it switches `access_level` from `anonymous` to
`registered`.

## 3. Endpoints: real vs documented

From the live `/openapi.json` (`openapi 3.1.0`, `info.title` "MinerU API",
`info.version` **"1.0.0"** — note `/v1/health` reports `"4.0.4"` instead).

| Method | Path | Status codes advertised | vs docs |
|---|---|---|---|
| GET | `/v1/health` | 200, 503 | as documented |
| GET | `/v1/models` | 200, 503 | as documented |
| GET | `/v1/models/{model}` | 200, 403, 404, 422, 503 | as documented |
| GET | `/v1/tiers` | 200, 503 | as documented |
| GET | **`/v1/usage`** | 200 | **undocumented in the pages we were given** — carries the real limits |
| POST | `/v1/uploads` | 200, 400, 413, 422 | as documented |
| GET | `/v1/uploads/{upload_id}` | 200, 404, 422 | as documented |
| PUT | **`/v1/uploads/{upload_id}/content`** | 200, 404, 409, 413, 422 | the local `upload_url` target |
| POST | `/v1/uploads/{id}/complete` | 200, 400, 404, 409, 413, 422 | as documented |
| POST | `/v1/uploads/{id}/cancel` | 200, 404, 409, 422 | as documented |
| GET | `/v1/files` | 200, 422 | **no 403** — anonymous listing works here |
| GET | `/v1/files/{file_id}` | 200, 404, 422 | as documented |
| GET | `/v1/files/{file_id}/content` | 200, 302, 403, 404, 422 | 302 advertised but **never used locally** |
| DELETE | `/v1/files/{file_id}` | 200, 404, 422 | as documented |
| POST | `/v1/parse/jobs` | 202, 400, 403, 422, 429, 503 | **no 404** — unknown `file_id` is not rejected at create |
| GET | `/v1/parse/jobs` | 200, 422 | **no 403** — anonymous listing works here |
| GET | `/v1/parse/jobs/{job_id}` | 200, 404, 422 | as documented |
| DELETE | `/v1/parse/jobs/{job_id}` | 200, 404, 409, 422 | as documented |

Nothing in the docs is missing from the server. `422` is FastAPI's own validation envelope and
appears on nearly everything, but hand-written checks return **400** with the MinerU error
envelope instead — see §8.

`GET /v1/health` (both tiers):

```json
{"status":"ok","version":"4.0.4",
 "features":{"webhook":false,
             "output_formats":["markdown","middle_json","structured_content","zip"],
             "sources":["file_id","url","inline"]}}
```

`GET /v1/usage` (anonymous) — the only place the real limits are published:

```json
{"object":"usage","access_level":"anonymous",
 "current":{"pages_processed":0,"files_processed":0,"jobs_created":0},
 "limits":{"max_pages_per_file":1000,"max_file_size_bytes":209715200,
           "max_files_per_job":100,"max_concurrent_jobs":1,"max_file_retention_days":null}}
```

## 4. `structured_content` — the real shape

**This is the single biggest divergence in the whole spike. The Draft schema document describes
a format that the 4.0.4 server does not emit at any point.**

Real top level (identical for all 9 input types):

```json
{
  "pages": [ { "page_idx": 0, "blocks": [ ... ] } ],
  "metadata": { "file_suffix": "pdf", "producer": {...}, "document": {...} },
  "extensions": { "mineru": {...}, "docvortex_layout": {...} },
  "is_full_document": true
}
```

| Level | Real keys | Draft says |
|---|---|---|
| top | `pages`, `metadata`, `extensions`, `is_full_document` | `schema`, `schema_version`, `source`, `parse`, `pages` |
| page | `page_idx`, `blocks` | `page_idx`, `page_number`, `page_size`, `items` |
| item | `type`, `content`, and optionally `bbox`, `level`, `anchor`, `captions`, `footnotes`, `image_source` | `id`, `type`, `locator`, `bbox`, `content` |

There is **no `schema` / `schema_version` field in `structured_content` at all** (only
`middle_json` carries them). There is no `id`, no `locator`, no `page_number`, no `page_size`,
and no `spans` anywhere.

### 4.1 Observed `type` values (complete list, 71 blocks over 9 documents)

| type | count | appears in |
|---|---|---|
| `text` | 23 | all but csv |
| `paragraph_title` | 21 | all but csv |
| `table` | 9 | all |
| `list` | 4 | docx, epub, html, pptx |
| `image` | 3 | pdf, docx, pptx |
| `header` | 3 | pdf only |
| `footer` | 3 | pdf only |
| `page_number` | 3 | pdf only |
| `doc_title` | 2 | epub, html |

**Never observed:** `paragraph`, `title`, `index`, `equation_interline`, `chart`, `code`,
`algorithm`, `page_header`, `page_footer`, `page_aside_text`, `page_footnote`. Six of those are
Draft names for things that *do* exist under a different name; the rest were simply not
exercised by our inputs (no equations/code/charts) and must be treated as **unknown, not absent**.

### 4.2 Side-by-side with the Draft schema

| Concern | Draft | Reality |
|---|---|---|
| envelope | `schema`+`schema_version`+`source`+`parse`+`pages` | `pages`+`metadata`+`extensions`+`is_full_document`; no schema marker |
| page items key | `items` | **`blocks`** |
| page number | `page_number` (1-based) alongside `page_idx` | only `page_idx` (0-based); derive 1-based yourself |
| page size | `page_size:{width,height}` or `null` | **absent from the page**; lives in `extensions.docvortex_layout.pages[].{width_pt,height_pt}`, and only for PDF/PNG/JPEG |
| item id | `id: "p0_i3"`, required | **absent**; `middle_json` has `index` per block instead |
| locator | `locator:{page_idx,item_idx}`, required | **absent** |
| bbox | `{"normalized":[x0,y0,x1,y1]}`, 0–1000 **integers**, `null` when unknown | **flat array of 4 floats normalised 0..1** (observed 0.044–0.949); the **`bbox` key is omitted entirely** for Office/HTML/EPUB/CSV (35 of 71 blocks) — never `null` |
| paragraph | type `paragraph`, `content.spans[]` | type **`text`**, `content` is a **plain string** |
| title | type `title`, `content.{level,spans}` | types **`doc_title`** / **`paragraph_title`**, `level` is a **sibling of `content`**, content is a string |
| list | `content.{list_type,ordered,items[{spans,level,marker}]}` | `content` is a **single Markdown string** with `- ` bullets and `\n` separators; no `ordered`, no per-item levels |
| table | `content.{html,source,caption,footnote,table_type,table_nest_level}` | `content` is a **GFM Markdown table string**; siblings `captions`/`footnotes` (**plural**) + `image_source`; **no `html`**, no `table_type`, no `table_nest_level`. HTML is only in `middle_json`. |
| image | `content.{source,description,caption,footnote}` | `content` is `""`; siblings `image_source`, `captions`, `footnotes` |
| media source | `{"type":"image","path":"images/img_0.jpg"}` | **a bare string**; in the standalone download it is a **`data:image/jpeg;base64,...` URI**, in the zip copy it is `images/<name>.jpg` |
| caption / footnote | singular `caption`, `footnote` | **plural `captions`, `footnotes`** (arrays, empty in our fixtures) |
| spans / marks | first-class `spans[]` with `marks` | **no spans in `structured_content`**. Emphasis survives only as literal Markdown in the string (DOCX headings come out as `**ALFA Quarterly Overview**`). `middle_json` sub-blocks carry `styles:["bold"]`. |
| `_`-prefixed leakage | forbidden | none observed — this rule is honoured |

### 4.3 `metadata` and `extensions`

```json
"metadata": {
  "file_suffix": "pdf",
  "producer": {"name": "mineru", "version": "4.0.4"},
  "document": {"title": "...", "authors": [...], "subject": "...", "created_at": "...",
               "modified_at": "...", "creator_application": "...",
               "producer_application": "...", "page_count": 3, "page_count_kind": "physical"}
}
"extensions": {
  "mineru": {"tier": "basic", "parse_mode": "txt"},
  "docvortex_layout": {"version": 1,
                       "pages": [{"page_idx":0,"width_pt":612.0,"height_pt":792.0}, ...]}
}
```

`metadata.document` keys are **sparse and format-dependent** — `page_count` was present for 7 of
9 inputs, `title` for 3, `languages` for 2, `identifiers` for 1. Treat every key as optional.

## 5. `middle_json` — real shape

| | value |
|---|---|
| `schema` | **`docvortex.middle`** (not `mineru.structured_content`) |
| `schema_version` | **`"2.0"`** |
| top keys | `metadata`, `extensions`, `pages`, `is_full_document`, `schema`, `schema_version` |
| page keys | `page_idx`, `blocks` |

`metadata` and `extensions` are **byte-identical** to `structured_content`. Only `pages` differs.

`middle_json` is the *richer, nested* form; `structured_content` is a flattened Markdown
rendering of it:

- Top-level block keys: `type`, **`index`**, `content`, and optionally `level`, `anchor`, `bbox`.
  `index` is the per-page ordinal and is the closest thing to the Draft's `locator.item_idx`.
- `content` is an **array of sub-blocks**, not a string. Observed sub-block types:
  `text` (67), `table_body` (9), `image_body` (3), `image_caption` (1).
- Sub-block keys: `type`, `content`, and optionally `index`, `bbox`, `styles`, `image_path`.
- `text` sub-blocks carry **`styles: ["bold"]`** — the only structured emphasis anywhere.
- `table_body.content` is **HTML** (`<table><tbody><tr><td>…`). This is the only place HTML
  tables exist; `structured_content` has already converted them to GFM Markdown.
- `image_caption.content` is itself a nested list of `text` sub-blocks.

## 6. Tiers and the effective-tier trap

`/v1/tiers` on the `--tier basic` server:

```json
{"object":"list","data":[
  {"id":"flash","description":"Fast local text extraction.","current_model":"flash"},
  {"id":"basic","description":"Basic parsing with local lightweight models.","current_model":"hybrid-basic"}]}
```

**`tiers[].current_model` does not match any `/v1/models[].id`.** Models are advertised as
`MinerU-Flash`, `Hybrid-Basic`, `MinerU-HTML`; tiers point at `flash`, `hybrid-basic`. Do not
join these two lists.

**The job-level `tier` lies about what actually parsed the file.** Every job below reported
`tier: "basic"`, but `extensions.mineru.tier` in the output records the real per-file tier:

| input | job `tier` | `extensions.mineru.tier` | `parse_mode` | `page_count_kind` |
|---|---|---|---|---|
| pdf | basic | **basic** | txt | physical |
| png / jpg | basic | **basic** | **ocr** | *(absent)* |
| csv | basic | **flash** | txt | logical |
| html | basic | **flash** | txt | logical |
| docx | basic | **flash** | txt | declared |
| xlsx | basic | **flash** | txt | sheet |
| pptx | basic | **flash** | txt | slide |
| epub | basic | **flash** | txt | spine |

The Draft says file-level effective tier is "not yet exposed". It **is** exposed — in
`extensions.mineru.tier`. That is the field to trust.

On a `--tier flash` server the documented rule holds exactly: PDF/image with `tier` omitted or
`null` → **503 `quality_tier_unavailable`**; non-PDF inputs are accepted and normalised to flash.

## 7. Page count, headings, running heads

### Page count

Order of reliability:

1. `metadata.document.page_count` + `page_count_kind` — present for 7/9 inputs.
   `page_count_kind` is a **richer enum than any doc mentions**: `physical` (pdf), `sheet`
   (xlsx), `slide` (pptx), `spine` (epub), `declared` (docx), `logical` (csv, html).
2. **Fall back to `pages.length`** — PNG/JPEG carry **no `page_count` at all**.

`pages.length` matched `page_count` in every case where both existed, so `pages.length` is a safe
universal fallback. The job's `files[].page_range` also normalises to `"1-3"` / `"1-2"` / `"1"`
and is a third cross-check (but it is `""` on a queued job, not `null`).

### Headings

`level` is a sibling of `content`, and its meaning is **backend-dependent**:

| input | mapping observed |
|---|---|
| HTML / EPUB | faithful: `h1` → `doc_title` level 1, `h2` → `paragraph_title` level 2, `h3` → level 3 |
| DOCX | **shifted by +1**: Heading1 → level 2, Heading2 → level 3, Heading3 → level 4; and the text arrives wrapped in Markdown bold (`**BRAVO Methodology**`) |
| PDF / PNG / JPEG | **everything is level 2** — the layout model does not infer depth |
| XLSX / PPTX | sheet names / slide titles become `paragraph_title` level 2 |

So: `level` is usable for HTML/EPUB, unreliable for DOCX (offset + markdown noise) and
meaningless for PDF/images. `doc_title` only ever appeared for HTML and EPUB.

`anchor` (e.g. `"epub-56103cd7208542e39453"`) appears on `doc_title`/`paragraph_title` for
HTML and EPUB only — 7 blocks total.

### Headers / footers / page numbers

**Yes, separately typed — but only for PDF**, and only as `header`, `footer`, `page_number`
(not the Draft's `page_header`/`page_footer`). All three appeared once per page on our 3-page
PDF. They are **excluded from `markdown.md`** but **present in `structured_content` and
`middle_json`**, so a client that concatenates block content will duplicate the running head on
every page unless it filters these three types.

## 8. Errors

Every hand-written error uses one envelope (the Draft docs only ever gave HTTP+code tables):

```json
{"error": {"type": "...", "code": "...", "message": "...", "param": "files.0.source"}}
```

`type` ∈ `invalid_request_error`, `permission_error`, `authentication_error`, `engine_error`.
`param` is a dotted path or `null`. FastAPI's own `422` uses a **different** shape
(`{"detail":[...]}`) — a client must handle both.

77 probe fixtures live in `fixtures/mineru-v1/errors/`.

| Probe | HTTP | code | Note |
|---|---|---|---|
| unknown job id | 404 | `job_not_found` | as documented |
| unknown file id (meta and `/content`) | 404 | `file_not_found` | as documented |
| unknown upload id | 404 | `upload_not_found` | as documented |
| unknown model | 404 | `model_not_found` | as documented |
| **unknown `file_id` in a job** | **202** | — | **then the job FAILS** with file-level `engine_error`/`parse_failed`. Docs promise `404 file_not_found` at create. |
| download a `purpose:"parse"` source | 403 | `feature_requires_api_key` | misleading — still 403 **with** a valid key |
| `output_formats:["docx"\|"html"\|"latex"]`, anonymous | 403 | `feature_requires_api_key` | misleading — the local server can never produce them |
| same, **with a valid API key** | **400** | `unsupported_output_format` | **the code changes with auth state for the same input** |
| `output_formats:["json"\|"content_list_v2"\|"images"]` | 400 | `unsupported_output_format` | as documented |
| **`page_range` on a non-PDF (csv, png)** | **202** | — | **then the job FAILS** with file-level `page_range_invalid`. Docs promise rejection at create. |
| `page_range:"not-a-range"` | 400 | `page_range_invalid` | `param: "files.0.page_range"` |
| `page_range:"50-90"` on a 3-page PDF | **202** | — | then fails: "selection does not contain any available page" |
| `page_range:"r2-r1"` | 202 | — | works; normalises to `"2-3"` |
| `tier:"bogus"` | 400 | `invalid_request` | pydantic: "Input should be 'flash', 'basic', 'standard' or 'advanced'" |
| `tier:"standard"` / `"advanced"` on a basic server | 400 | `invalid_request` | "Tier 'standard' not available in this server" — **not** 503 `quality_tier_unavailable` |
| PDF/image, tier omitted, on a `--tier flash` server | **503** | `quality_tier_unavailable` | `type: engine_error`; matches docs |
| `ocr_mode:"bogus"` **or `null`** | 400 | `invalid_request` | **`null` is rejected**, though the docs say it defaults to `auto` |
| `files: []` | 400 | `invalid_request` | |
| `source.type:"local"` without the flag | 400 | `unsupported_source` | |
| `callback` present | 400 | `invalid_request` | "Webhook callback is not supported by this Local Parse Server" — same **with** a key |
| `sha256sum:"nothex"` | 400 | `invalid_request` | pattern `^[a-f0-9]{64}$` |
| `purpose:"bogus"` | 400 | `invalid_request` | |
| missing required upload field | 400 | `invalid_request` | `param: "bytes"` |
| **wrong sha256** (PUT succeeds, then complete) | 400 | `file_hash_mismatch` | the **PUT returns 200**; the mismatch only surfaces at `complete` |
| byte-count mismatch on PUT | **413** | **`upload_size_mismatch`** | undocumented code; docs only list `bytes_mismatch` at complete |
| `complete` before any bytes | 409 | `upload_not_ready` | |
| cancel a pending upload | 200 | — | |
| cancel it twice | 409 | `upload_already_terminal` | |
| **cancel a finished job** | 409 | `job_already_terminal` | as documented |
| **cancel a running job** | 200 | — | `{"job_id":…,"status":"canceled","canceled_at":…}`; re-query shows `canceled` with `finished_at` set |
| cancel unknown job | 404 | `job_not_found` | |
| `limit=99999` on `/v1/files` | 400 | `invalid_request` | max 1000 |
| inline source > 1 MB | 400 | `unsupported_source` | "exceeds max_inline_bytes (1048576)" |
| `url` source over plain http | 400 | `unsupported_source` | needs `--allow-http-source` |
| **`GET /v1/files` / `/v1/parse/jobs` anonymous** | **200** | — | **docs promise `403 list_requires_api_key`; local server allows it** |

### API-key mode (`--api-key testkey`)

| Probe | HTTP | code |
|---|---|---|
| no `Authorization` header | 401 | `invalid_api_key` (`type: authentication_error`) |
| wrong bearer token | 401 | `invalid_api_key` |
| `GET /v1/health` with no key | **200** | health stays public |
| valid key | 200 | `access_level` becomes `registered` in `/v1/usage` and in job-create responses |

Docs never specify 401 or `invalid_api_key`; they only mention 403 `feature_requires_api_key`.
Both exist and mean different things.

## 9. Outputs, zip layout, and the data-URI split

`output_files` in the terminal job response **always lists every known format, with `null` for
the ones not requested**:

```json
"output_files": {"markdown": {...}, "middle_json": {...}, "structured_content": {...},
                 "html": null, "latex": null, "docx": null, "zip": {...}}
```

A client that iterates `Object.entries(output_files)` without a null check will crash — this
actually broke our first harness run.

Zip layout (identical across all inputs):

```
markdown.md
middle_json.json
structured_content.json
model_output.json          <- undocumented 4th artifact
images/page_<n>_<kind>_<index>.jpg    <- only when the doc has images/tables
```

`model_output.json` is not in any doc. Top keys: `metadata`, `extensions`, `schema_version`,
`schema`, `pages`, **`page_index_map`**. Image filenames encode page and block index:
`page_1_table_body_3.jpg` = page_idx 1, sub-block type `table_body`, `index` 3 — which maps
directly back onto `middle_json`.

**The standalone download and the zipped copy of the same artifact are different files:**

| artifact | `GET /v1/files/{id}/content` | copy inside `result.zip` |
|---|---|---|
| `markdown.md` | images inlined as `![](data:image/jpeg;base64,…)` | `![](images/page_2_image_body_3.jpg)` |
| `structured_content.json` | `image_source: "data:image/jpeg;base64,…"` | `image_source: "images/page_2_image_body_3.jpg"` |
| `middle_json.json` | **no image reference at all** — the `image_path` key is absent | `image_path: "images/page_2_image_body_3.jpg"` |

This is why the standalone PDF `structured_content` is 75 829 bytes while the zipped one is
7 211. For documents with no images the two copies are byte-identical (csv, epub, html).

**Consequence: the standalone `middle_json` cannot be used to locate images at all.** If you
need image bytes or image paths you must request and open the `zip`.

### Content delivery

`GET /v1/files/{file_id}/content` **streams 200 directly; it never redirects** (302 is
advertised in the OpenAI-compatible schema but unused locally, exactly as the "Local Server
differences" section promises).

**Every output is served as `content-type: application/octet-stream`** — markdown, JSON and zip
alike. There is no `Content-Disposition`. The client must know the format from the request; it
cannot sniff it from headers. Output `File` objects are named `<input>.<ext>` (e.g.
`restartprobe.csv.md`) with `purpose: "parse_output"` and `expires_at: null`.

### Timings (basic tier, warm unless noted)

| input | `parse.duration_ms` | md | middle_json | structured_content | zip |
|---|---|---|---|---|---|
| csv | 49 | 148 | 832 | 501 | 1 755 |
| epub | 10 | 857 | 2 201 | 1 613 | 3 430 |
| xlsx | 22 | 353 | 2 053 | 1 079 | 2 533 |
| html | 26 | 1 152 | 2 590 | 1 886 | 3 465 |
| pptx | 48 | 9 760 | 10 833 | 10 466 | 11 619 |
| docx | 419 | 10 650 | 12 459 | 11 609 | 12 879 |
| pdf | 1 126 (**18 600 cold**) | 34 457 | 5 297 | 75 829 | 71 547 |
| png | 1 387 | 401 | 1 779 | 43 894 | 44 301 |
| jpg | **8 961** (cold, first OCR) | 401 | 1 779 | 45 054 | 46 321 |

Flash-tier PDF for comparison: **811 ms**. The first `basic` PDF/image job pays a one-off
~10–18 s model-load penalty. Flash formats are all sub-500 ms.

## 10. Behaviour probes — answers

| Question | Answer |
|---|---|
| Does re-uploading the same sha256 return `completed` immediately? | **Yes.** `POST /v1/uploads` with a known `sha256sum` returns `status:"completed"` with an embedded `file`, `upload_url:null`, `upload_method:null`. No bytes are sent and `complete` is not called. **But it mints a NEW `file_id`** — it is not the same id as the original upload. |
| Upload without `sha256sum`? | Always `status:"pending"` with an `upload_url`. No dedupe possible. |
| After a server RESTART, are old ids gone? | **Yes, all of them.** Upload ids, input file ids, job ids **and output file ids** all return **404** with their respective `*_not_found` codes. `GET /v1/files` returns `data: []` and `GET /v1/parse/jobs` returns 0 jobs. The id registry is in-memory only. |
| Do file bytes survive under `--upload-dir`? | **Yes.** Bytes persist as content-addressed blobs (`<upload-dir>/blobs/<2-hex>/<hash>`, 41 blobs / 908 KB in our run). Consequently **sha256 dedupe still hits after a restart** — re-uploading returns `completed` instantly against a brand-new `file_id`. So: bytes persist, identifiers do not. |
| Is the parse result cached? | **Yes.** Re-submitting a job for the same file returned `duration_ms: 5` (vs 49 ms originally); the cold PDF went 18 600 ms → 1 126 ms. |
| Default file size / inline limits? | `/v1/usage.limits`: `max_file_size_bytes` **209 715 200** (200 MB), `max_pages_per_file` 1000, `max_files_per_job` 100, `max_concurrent_jobs` 1, `max_file_retention_days` null. Inline source cap is **1 048 576 bytes** (`--max-inline-bytes`), enforced with `unsupported_source`. |
| Does `/content` redirect or stream? | **Streams, 200.** Never a 302 locally. |
| Content-Type of each output? | **`application/octet-stream` for all four formats.** No `Content-Disposition`. |
| How long does each job take? | See §9. Flash formats 10–420 ms; basic PDF ~1.1 s warm / 18.6 s cold; image OCR ~1.4–9.0 s. |
| Is `/v1/health` public under `--api-key`? | Yes, 200 without a key. Everything else is 401. |

## 11. Implications for the AlfyAI client

### Do

1. **Parse `structured_content` as `{pages:[{page_idx, blocks:[…]}]}`.** Read items from
   **`blocks`**, never `items`. There is no envelope `schema` field to version-check against —
   use `middle_json.schema === "docvortex.middle"` / `schema_version === "2.0"` as the version
   signal, or `metadata.producer.version`.
2. **Treat `content` as a Markdown string for every block type.** Tables are GFM, lists are
   `- ` lines joined with `\n`, DOCX headings arrive wrapped in `**…**`. Strip/parse
   accordingly; do not expect `spans`.
3. **Null-check every entry in `output_files`.** The server lists all seven formats and sets the
   unrequested ones to `null`.
4. **Always request `zip` when images matter**, and read images from inside it. The standalone
   `middle_json` has no image references at all, and the standalone `markdown`/
   `structured_content` inline images as base64 data URIs that bloat payloads ~10×.
5. **Derive page count as `metadata.document.page_count ?? pages.length`.** PNG/JPEG have no
   `page_count`. Keep `page_count_kind` (`physical|sheet|slide|spine|declared|logical`) for
   display, and never assume it means physical pages.
6. **Read the real tier from `extensions.mineru.tier`, not from the job's `tier`.** Office/HTML/
   CSV/EPUB silently execute at `flash` inside a `basic` job.
7. **Filter `header`, `footer`, `page_number` before concatenating block text** — they repeat on
   every PDF page and are already excluded from `markdown.md`.
8. **Poll to a terminal state and then check the file-level status and error too.** A `202` at
   create means nothing: unknown `file_id` and bad `page_range` both surface only as file-level
   failures.
9. **Handle two error envelopes**: MinerU's `{error:{type,code,message,param}}` and FastAPI's
   `{detail:[…]}` on 422. Branch on `code`, not on HTTP status.
10. **Re-upload by sha256 rather than persisting ids.** It is free (no bytes), it survives
    restarts, and it is the only recovery path after one.
11. **Use `GET /v1/tiers` for capability discovery** and request the tier explicitly.
12. **Know the format you requested.** Content-Type is always `application/octet-stream`.

### Don't

1. **Don't implement the Draft `structured_content` schema.** No `id`, `locator`, `page_number`,
   `page_size`, `spans`, `marks`, `source`, `parse`, or `schema` fields exist. Writing a parser
   from that document would fail on the very first fixture.
2. **Don't expect bbox as 0–1000 integers or as `{normalized:[…]}`.** It is a flat array of four
   floats in 0..1, and for Office/HTML/EPUB/CSV **the key is missing entirely** — check
   `'bbox' in block`, not `block.bbox !== null`.
3. **Don't look for `caption`/`footnote`.** They are `captions`/`footnotes`, plural.
4. **Don't expect HTML tables from `structured_content`.** Only `middle_json`'s `table_body`
   sub-blocks carry HTML.
5. **Don't cache or persist `file_id` / `job_id` / `upload_id` across a server restart.** All of
   them 404 afterwards, including output file ids.
6. **Don't trust `parse.model_used`** — it was `null` on every completed file despite the docs
   saying it is present when `status == "completed"`.
7. **Don't join `tiers[].current_model` to `models[].id`.** They use different naming
   (`hybrid-basic` vs `Hybrid-Basic`).
8. **Don't send `ocr_mode: null`** expecting the documented `auto` default — it is a 400. Omit
   the key instead.
9. **Don't rely on `403 list_requires_api_key`** for listings; the local server serves them
   anonymously.
10. **Don't treat `feature_requires_api_key` as "add a key and retry"** — for `docx`/`html`/
    `latex` and source downloads the local server can never satisfy the request, and with a
    valid key the code silently changes to `unsupported_output_format`.
11. **Don't use `level` for PDF or image outlines** — every heading comes back as level 2. For
    DOCX remember the +1 offset.
12. **Don't send `callback`** to a local server; `health.features.webhook` is `false` and it is a
    hard 400 even with a key.

### Still unknown — must be checked on the GPU box

- `standard` / `advanced` (VLM) output was **not captured**. Whether those tiers emit extra
  block types (`equation_interline`, `chart`, `code`, `algorithm`, `index`), populate
  `parse.model_used`, or change `content` from Markdown string to a richer shape is **unverified**.
- No fixture exercises equations, code blocks, charts, multi-column layout, rotated pages,
  scanned/skewed input, or a table of contents. The absence of those `type` values here is
  evidence of nothing.
- `partial` job status was never observed (all jobs were single-file).
- Rate limiting (`429 rate_limit_exceeded`) and `413 file_too_large` were not triggered.

## 12. Fixture index

```
fixtures/mineru-v1/
  server/openapi.json health.json tiers.json models.json usage.json
         flash.health.json flash.tiers.json flash.models.json
  {pdf,docx,xlsx,pptx,html,csv,epub,png,jpg}/
         sample.*  upload.create.json  upload.complete.json
         job.create.json  job.final.json
         markdown.md  middle_json.json  structured_content.json
         result.zip  zip-listing.txt
  flash-pdf/      same PDF at --tier flash
  errors/         77 probe responses (status + body), incl. *.final.json for 202-then-fail cases
  probe.restart-before.json / probe.restart-after.json
  _run-summary.json    per-input timings, sizes, content-types, resolved tiers
```

Notes: `pdf/upload.complete.json` is absent because that upload was a sha256 dedupe hit
(`status: completed` at create). No JSON output exceeded 300 KB, so no trimmed `*.sample.json`
files were needed. All fixtures total ~1.5 MB.
