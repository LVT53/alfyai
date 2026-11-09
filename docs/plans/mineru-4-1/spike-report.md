# MinerU 4.1.7 spike (recorded facts)

Purpose: install MinerU 4.1.7 beside the live 4.0.12 on the GPU box, prove it runs with our VLM server, and
record its real answers, so the client rewrite (a separate session, after the Nov 9 reset) is written against
reality and not against the docs. Every claim below is backed by a file under `fixtures/` (index at the end).

Run date: 2026-11-05, 11:39 to 12:12 UTC. Host: `alfyroot` (AlmaLinux 10.2, Ryzen 9 9950X, 185 GiB RAM,
GPU0 RTX PRO 6000 (full, never touched), GPU1 RTX PRO 5000 Blackwell 48 GiB, driver 615.71.10).
**No production change**: `mineru4.service` kept MainPID 2800 and NRestarts 0, `:8002/v1/health` answered 200
(`"version":"4.0.12"`) before and after, `mineru4-dev`, `mineru-openai-server` and Apache were not touched,
GPU1 memory went 15 099 MiB (before) to 15 101 MiB (after the spike stopped).

---

## 0. Verdict

**Go.** 4.1.7 installs cleanly next to 4.0.12, runs the Standard tier against the shared `mineru-openai-server`
(`:30001`) with its small models on Torch/CUDA on GPU1, and answers almost exactly as the 4.1 docs say.
Nothing found blocks the rewrite. What the spec must absorb:

1. **The whole protocol envelope changed.** `schemas.ts` still accepts only `/v1/health`, `/v1/tiers` and
   `/v1/usage`; it rejects the create receipt, the task snapshot, the file entry, the cancel receipt, the file
   object and every error body (§9).
2. **Error statuses and codes moved** (`upload_size_mismatch` is 400 not 413, `job_*` became `task_*`,
   `type` is gone, `unsupported_output_format` and `feature_requires_api_key` are gone, an unavailable tier is
   `400 invalid_request` with `param:"tier"`). Framework-level 404/405 still use FastAPI's `{"detail":"..."}` (§6, §8).
3. **All server state is in memory.** After a restart every task, file id, result URL, upload URL AND the hash
   cache are gone (4.0 kept its hash cache). The client must treat `task_not_found` / `file_not_found` as
   "the server restarted: create again and re-upload" (§8).
4. **Omitting `tier` no longer fails on a server without Standard**: it silently falls back (Standard, then Basic,
   then Flash). Always send an explicit `tier` (§6, D14).
5. **New block types** `equation`, `chart`, `page_footnote` appear for real documents. The existing renderer drops
   charts (and their captions) from the prompt text and prints display equations without `$$` (§9).
6. Cost: about 6 GiB RSS and 1.1 to 2.6 GiB VRAM per server process once warm (4.0.12 showed 782 MiB VRAM);
   the first Standard job after any start pays about 8 s of one-off model load (§5).

---

## 1. What is installed where (all NEW paths; nothing existing was edited)

| Thing | Path / value |
|---|---|
| venv (Python 3.12.15, system `/usr/bin/python3.12`, 5.9 GB) | `/home/alfydesign/apps/mineru4/.venv-4.1.7` |
| MINERU_HOME (short path, as 4.0 required) | `/home/alfydesign/m41s` (2.0 GB: `models/`, `hf/`, `cache/`, `doclib.db`; no `config.yaml` was ever written) |
| upload dir (content-addressed `blobs/`, `.mineru-service.lock`) | `/home/alfydesign/apps/mineru4/uploads-4.1.7` (25 MB after the spike) |
| spike-only API key (mode 600, owner alfydesign, var `MINERU41_SPIKE_API_KEY`) | `/home/alfydesign/apps/mineru4/mineru41-spike.env` |
| working folder (samples, captures, scripts, logs) | `/root/mineru41-spike/` (includes `start-spike.sh`) |
| unit | transient `mineru41-spike` (and, briefly, `mineru41-spike-b` on :8013 for the tier-ceiling probes; both gone) |

Left in place for the build session: venv, MINERU_HOME, env file, working folder. The unit is stopped, nothing listens on :8012.
Removal later (not done): `rm -rf` of those four paths. Rollback of production is untouched by this spike (4.0.12 venv and unit unchanged).

### 1.1 Install

```bash
cd /home/alfydesign        # uv reads uv.toml from the cwd; /root is unreadable for alfydesign
runuser -u alfydesign -- env -i HOME=/home/alfydesign PATH=/usr/local/bin:/usr/bin:/bin \
  uv venv --python /usr/bin/python3.12 --no-python-downloads --seed /home/alfydesign/apps/mineru4/.venv-4.1.7
runuser -u alfydesign -- env -i HOME=/home/alfydesign PATH=/usr/local/bin:/usr/bin:/bin \
  uv pip install --python /home/alfydesign/apps/mineru4/.venv-4.1.7/bin/python --no-cache "mineru[torch]==4.1.7"
```

uv 0.10.9. Resolved 144 packages, 14.7 s to download and install (uv fell back to copy: venv and cache are on different filesystems).
`mineru version --json`: `{"mineru_version":"4.1.7","python_version":"3.12.15"}` (`fixtures/install/mineru-version.json`, full list in `pip-freeze.txt`).

| package | 4.1.7 (this spike) | 4.0.12 (production venv) |
|---|---|---|
| mineru / docvortex | 4.1.7 / 0.6.14 | 4.0.12 / 0.5.16 |
| mineru_vl_utils / mineru-llama-cpp | 2.0.8 / 0.2.0 | 2.0.5 / 0.1.2 |
| new: mineru-magika (content-type sniffing), onnxruntime-ep-webgpu | 1.0.3, 0.5.0 | absent |
| torch / torchvision | 2.15.0+cu132 / 0.29.2 | 2.14.0+cu130 / 0.29.0 |
| transformers / accelerate / triton | 5.22.1 / 1.15.0 / 3.9.0 | 5.17.0 / 1.15.0 / 3.8.0 |
| onnxruntime | 1.31.1 | 1.30.0 |
| fastapi / uvicorn / pydantic | 0.162.0 / 0.54.0 / 2.14.3 | 0.141.1 / 0.53.0 / 2.13.5 |

Python: 4.1 needs `>=3.11,<3.15` (3.10 dropped); the box's 3.12.15 is fine for both.

### 1.2 Models

`mineru-kit models download --tier standard --small-backend torch --source auto -v`, run as alfydesign under the service environment,
**14.7 s, 2.0 GB**, source **HuggingFace** (`hf/hub/models--opendatalab--MinerU-4_models_torch`, `models--jinzhenj--MinerU2.5-Pro-2605-1.2B-GGUF`).
`MinerU-4_models_torch` (Layout, MFR, OCR, Table) is 854 MB. The command ALSO fetched the 1.2 GB GGUF VLM weights although the service
uses the remote VLM (`--vlm-server-url`); the service never needs them (deletable). I did not test whether the api-server downloads the small
models by itself on first use (4.0 did); I pre-downloaded.

### 1.3 Start and stop

The api-server's `--api-key` has **no env-var fallback in 4.1.7** (`parser/api_server.py:2142-2147`, a plain click option), so the key goes through argv, as in 4.0.12.
`${MINERU41_SPIKE_API_KEY}` is expanded by systemd from the env file at exec time; the stored unit contains only the reference, the journal has 0 occurrences of the key.
Do not run `systemctl status` or `ps` unfiltered on this unit (they show the expanded argv).

```bash
systemd-run --collect --unit=mineru41-spike \
  --description="MinerU 4.1.7 spike (transient, loopback :8012)" \
  -p User=alfydesign -p Group=alfydesign \
  -p WorkingDirectory=/home/alfydesign/apps/mineru4/uploads-4.1.7 \
  -p MemoryMax=16G -p Nice=5 -p Restart=no \
  -p EnvironmentFile=/home/alfydesign/apps/mineru4/mineru41-spike.env \
  -p NoNewPrivileges=true -p PrivateTmp=true -p ProtectSystem=full -p ProtectHome=read-only \
  -p "ReadWritePaths=/home/alfydesign/apps/mineru4/uploads-4.1.7 /home/alfydesign/m41s" \
  -E CUDA_VISIBLE_DEVICES=1 -E NVIDIA_VISIBLE_DEVICES=1 \
  -E MINERU_HOME=/home/alfydesign/m41s -E MINERU_DEVICE_MODE=cuda -E MINERU_MODEL_SMALL_BACKEND=torch \
  -E MINERU_TELEMETRY_DISABLED=1 -E DO_NOT_TRACK=1 -E HF_HUB_DISABLE_TELEMETRY=1 -E PYTHONUNBUFFERED=1 \
  -E HF_HOME=/home/alfydesign/m41s/hf -E HF_XET_CACHE=/home/alfydesign/m41s/hf/xet \
  -E XDG_CACHE_HOME=/home/alfydesign/m41s/cache -E MODELSCOPE_CACHE=/home/alfydesign/m41s/modelscope \
  /home/alfydesign/apps/mineru4/.venv-4.1.7/bin/mineru-kit api-server \
    --host 127.0.0.1 --port 8012 --tier standard --concurrency 2 \
    --upload-dir /home/alfydesign/apps/mineru4/uploads-4.1.7 \
    --vlm-server-url http://127.0.0.1:30001/v1 \
    --api-key '${MINERU41_SPIKE_API_KEY}'
# stop:  systemctl stop mineru41-spike      (0.5 s; the transient unit then disappears)
```

`/root/mineru41-spike/start-spike.sh` (also `fixtures/tools/start-spike.sh`) is this command plus a GPU1 gate (stop if under 4 GB free) and a port check.
Differences from the production unit: `--concurrency 2` (prod 4), `MemoryMax=16G` (prod 32G), `Nice=5`, narrower `ReadWritePaths`,
the telemetry variables, and the new `MINERU_MODEL_SMALL_BACKEND=torch` (4.1; `auto` was not tried). The sandbox (`ProtectHome=read-only`,
`ProtectSystem=full`, `PrivateTmp`) worked: 4.1.7 wrote only inside MINERU_HOME and the upload dir.

---

## 2. Telemetry (evidence, read from the INSTALLED 4.1.7 source)

The 4.0 recipe (pre-seed `consent_state` in `doclib.db`) no longer applies as written.

| Fact | Where (`site-packages/mineru/`) |
|---|---|
| Endpoint `https://mineru.net/metrics/v2/metrics`, 10 s timeout, flush every 7200 s; HMAC-signed with app key/secret constants that ship in the source | `doclib/telemetry/constants.py:16-22`, `doclib/telemetry/transport.py:12-21` |
| **A fresh install defaults to ENABLED** (`state_source` `default`) | `doclib/telemetry/store.py:48-49` |
| Stored in `doclib.db` table `telemetry_state` (columns `key, value, updated_at`), keys `telemetry_state` = `enabled\|disabled` and `state_source` = `default\|user\|error`; the legacy `consent_state` key is migrated and then deleted | `store.py:36-70`, `doclib/migrations/001_init.sql:154-158` |
| `set_telemetry_state` writes the choice with source `user` and deletes pending aggregates | `store.py:93-108` |
| Environment switch `MINERU_TELEMETRY_DISABLED` (`1/true/yes/on`; any other non-empty, non-false value also disables) is read at service construction and **wins over the stored state** | `doclib/telemetry/service.py:272-279`, `:113-116` |
| The telemetry service is built in exactly one place: the Doclib daemon (`mineru server`) | `doclib/app.py:93` |
| `mineru-kit api-server` (`kit/commands/api_server.py` to `parser/api_server.py`) imports neither `doclib` nor `telemetry`: a grep over `kit/ tasks/ integrations/ backend/ model/ parser/ utils/ config.py` finds no import | grep, 0 matches |
| The CLI prints "Doclib telemetry is enabled by default ... Set MINERU_TELEMETRY_DISABLED=1 before starting Doclib" | `cli/telemetry.py:29-34` |

What I did, BEFORE the first server start: ran the installed code's own `DatabaseManager.initialize()` (migrations only, no `TelemetryService`) in the new
MINERU_HOME, then wrote `telemetry_state=disabled`, `state_source=user` into `/home/alfydesign/m41s/doclib.db` and emptied `telemetry_aggregates`
(read-back: `[('telemetry_state','disabled'),('state_source','user')]`, 0 aggregate rows). The unit also sets `MINERU_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`,
`HF_HUB_DISABLE_TELEMETRY=1`. After about 20 minutes of parsing: the journal has 0 mentions of telemetry, `mineru.net` or `metrics`, and the process's
sockets were only to `127.0.0.1:30001` (the VLM server). Because the api-server never starts the telemetry service, the seed is belt and braces; keep both for
the production cutover (and for any future `mineru` CLI or Doclib use). Other outbound traffic observed: model downloads from huggingface.co (expected).

Also new in 4.1.7 (changelog): the Doclib now requires a persistent bearer token (`DoclibAuthConfig`, `config.py:599`); irrelevant to the api-server.

---

## 3. Backend and devices (`mineru-kit hardware info --json`, `fixtures/install/hardware-info.json`)

Effective config under the service environment: `model.small_backend` = **torch** (source: env), `model.onnx_device` = auto (default), `model.vlm.engine` = auto, which resolves to
`llama-cpp` and is irrelevant because the VLM is remote. `MINERU_DEVICE_MODE=cuda`, `CUDA_VISIBLE_DEVICES=1`. Torch `2.15.0+cu132`, `cuda.is_available()` true, device 0 under the mask = "NVIDIA RTX PRO 5000
Blackwell", `selected_device: {device: cuda, reason: torch_accelerator}`. The ONNX runtime lists a WebGPU backend with both NVIDIA adapters; it is not used while `small_backend=torch`
(no ONNX calibration file exists, and none is needed). `hardware info` and `models show` write nothing (`Config exists: false`).

`--tier standard` gives `/v1/tiers` = flash, basic, standard (no advanced), `max_concurrent_jobs` = 2 (= `--concurrency`).

---

## 4. Wire cheat-sheet (real bodies; ids shortened)

```text
POST /v1/tasks   Authorization: Bearer <key>   Content-Type: application/json
{"files":[{"file_name":"paper-en.pdf","bytes":241664,"sha256sum":"75314f7c...ae437c1"}]}          (+ optional tier, ocr_mode, page_range, output_formats)

202 {"task_id":"job_58fe19d846ff58d8f6909674","status":"waiting-file",
     "files":[{"file_id":"file-3ed58242...","file_name":"paper-en.pdf","status":"waiting-file",
               "upload":{"url":"http://127.0.0.1:8012/v1/tasks/job_58fe.../uploads/file-3ed5...",
                         "headers":{"Content-Type":"application/octet-stream"},"expires_at":1793883166}}]}

PUT <upload.url>   (key sent; body = raw bytes; Content-Length = bytes)         200 {"task_id":"job_...","file_id":"file-...","status":"pending"}

GET /v1/tasks/job_58fe...   200 (running, 7 ms after the PUT)
{"task_id":"job_58fe...","status":"running","created_at":"2026-11-05T11:52:46Z","started_at":"2026-11-05T11:52:46Z",
 "output_formats":["default"],"progress":{"completed":0,"failed":0,"total":1},
 "files":[{"file_id":"file-3ed5...","file_name":"paper-en.pdf","status":"running","bytes":241664}]}

GET ...   200 (completed)  + "finished_at", progress {"completed":1,...}, and per file:
 {"status":"completed","bytes":241664,"parse":{"tier":"standard","duration_ms":8153,"parser_version":"4.1.7"},
  "result_url":"http://127.0.0.1:8012/v1/files/file-3ed5.../content"}

GET <result_url>   200  content-type: application/zip  content-disposition: attachment; filename="paper-en.zip"  etag, last-modified, accept-ranges: bytes, content-length
failed file:   {"status":"failed","bytes":84582,"error":{"code":"parse_failed","message":"Failed to load document (PDFium: Data format error)."}}   (task status "failed", NO top-level error)
cancel:        POST /v1/tasks/{id}/cancel  200 {"task_id":"...","status":"canceled","finished_at":"...","files":[{"file_id","file_name","status":"completed|failed|canceled", "parse"?, "result_url"?, "error"?}]}
errors:        {"error":{"code":"invalid_request","message":"...","param":"files.0.file_name"}}     (no "type")
```

Statuses seen: task `waiting-file`, `pending`, `running`, `completed`, `partial`, `failed`, `canceled`; file `waiting-file`, `pending`, `running`, `completed`, `failed`, `canceled`.
Timestamps are second-resolution ISO-8601 `Z`; `expires_at` (Unix seconds) is exactly creation + 3600.

---

## 5. Timings, RAM, VRAM (sampler: `fixtures/resources/`, 0.5 s cadence, per-process VRAM via `nvidia-smi --query-compute-apps`)

| What | Value |
|---|---|
| start to `/v1/health` 200 | **4.05 s** (nothing is loaded at start; restart: 3.78 s after the command returned in 0.6 s) |
| idle right after start | cgroup 835 MiB, no CUDA context, 0 MiB VRAM |
| first Standard PDF after a start (cold model load) | **wall 9.2 s, `duration_ms` 8153**; after a restart: 7502. The same document warm: 675 ms. |
| first Basic PDF after Standard was already warm | `duration_ms` 10 206 (inferred: about 9 s of Basic-only one-off load); the later forced-OCR Basic job on the same document took 1 071 ms |
| warm, the 2-page text PDF | flash 250 ms, standard 675 ms, basic with forced OCR about 1.1 s |
| warm, a **20-page** PDF (the 2-page paper, 10 times) | flash **0.88 s**, standard **2.4 to 2.8 s** (about 7 pages/s), basic **11.8 s** |
| `page_range` "1-5" / "r1" on that 20-page PDF | 1.06 s / 0.41 s |
| 3 simultaneous Standard tasks of 20 pages, `--concurrency 2` | two finish at 4.3 s, the third queues and finishes at 7.1 s (wall) |
| native formats (docx, xlsx, pptx, html, csv) | 7 to 309 ms (`duration_ms`), always tier flash |
| RAM, cgroup, while parsing 2-page documents | 2.9 to 3.9 GiB; peak **5.9 GiB** with 3 concurrent 20-page tasks |
| RAM, warm and idle after the large runs | **6.2 GiB RSS** main process (117 threads), cgroup anon 5.9 GiB, `MemoryPeak` 6.25 GiB, plus three spawn workers of about 120 MiB each |
| VRAM, our process | 1.1 GiB at the first PDF, 1.3 GiB warm idle, **peak 2.5 GiB** (20-page Basic), 1.8 GiB (3 concurrent Standard); GPU1 total used peaked at 17 678 MiB |
| after stop | GPU1 15 101 MiB used (baseline 15 099) |

Model files on disk: 2.0 GB. Upload dir after about 100 uploads: 25 MB (99 blobs).
Notes: a handful of `CLOSE-WAIT` sockets to `127.0.0.1:30001` stay open (httpx keep-alive pool; harmless). Every CLI import prints jieba `SyntaxWarning`s under 3.12 (noise).

---

## 6. The contract as observed vs the docs (every difference)

D = difference from `docs/` (tasks.md, http_api.md, tiers.md, output_files.md, migration_4_1.md) or from 4.0.x behaviour that the old client relied on.

| # | Topic | Docs / 4.0 | Observed 4.1.7 |
|---|---|---|---|
| D1 | `upload.headers` | docs example `{}` | `{"Content-Type":"application/octet-stream"}`. A PUT with `text/plain` or with no Content-Type is accepted anyway. |
| D2 | Result download headers | 4.0: `application/octet-stream`, no disposition | `application/zip` + `Content-Disposition: attachment; filename="<stem>.zip"` (non-ASCII names use `filename*=utf-8''%C3%81...`), `ETag`, `Last-Modified`, `Accept-Ranges: bytes`; `Range` works (206). `HEAD` on a result URL is **405**. `["html"]` returns `text/html; charset=utf-8`, `["docx"]` the OOXML type, `["latex"]` a ZIP with `document.tex`. |
| D3 | ZIP layout | `markdown.md`, `middle_json.json`, `structured_content.json`, `images/` | exactly that, **plus an `images/` directory entry (size 0) in every ZIP, even with no images**. No `model_output.json`. `default`+`docx` gives one flat ZIP with `document.docx` beside them. |
| D4 | Image names | `images/page_{idx}_{parent}_{n}.ext` | as documented. Parent types seen: `equation`, `chart`, `table`, `image` (e.g. `page_0_equation_6.jpg`, `page_1_chart_3.jpg`, `page_1_table_2.jpg`, `page_0_image_8.jpg`). Page index is the original document's, 0-based. |
| D5 | Create receipt status | `waiting-file` | `waiting-file` when any file needs bytes; **`pending` with no `upload` objects when every file is a hash-cache hit**. Receipt has no `bytes`; the first GET does. |
| D6 | Failure reporting | `error` at task level possible | a failed task has **no top-level `error`**; the reason is `files[].error` with the single code **`parse_failed`** for every cause (corrupt, encrypted, unsupported type, unreadable XLSX, URL fetch refused). Only `message` differs: `Failed to load document (PDFium: Data format error).`, `... (PDFium: Incorrect password error).`, `Unsupported file type: <ext or detected type>`, `Invalid XLSX package: file is not a ZIP archive.`, `All connection attempts failed`. |
| D7 | `/v1/health` | `features.task_output_formats`, `sources` upload/url | exactly that: `{"status":"ok","version":"4.1.7","features":{"webhook":false,"task_output_formats":["default","docx","html","latex"],"sources":["upload","url"]}}`. `output_formats` is gone. |
| D8 | `/v1/tiers`, `/v1/models` | n/a | tiers up to the ceiling; **`current_model` is `"mineru-4.1.7"` for every tier**; `/v1/models` lists one virtual model `mineru-4.1.7`. |
| D9 | `/v1/usage` | n/a | `access_level:"registered"` (key set), `billing_period{start,end:null}`, `current{pages_processed,files_processed,jobs_created}` (reset by a restart), `limits{max_pages_per_file:null, max_file_size_bytes:null, max_files_per_job:100, max_concurrent_jobs:=--concurrency, max_file_retention_days:1}`. (4.0 anonymous: 1000 pages, 200 MB.) |
| D10 | Which routes need the key | "send Authorization on API requests" | public without a key: `/v1/health`, `/v1/tiers`, `/v1/models`, `/v1/models/{id}`, `/openapi.json`, `/docs`, `/redoc`. Keyed (each tested): `POST /v1/tasks`, `GET /v1/tasks/{id}`, the PUT upload URL, `GET /v1/files/{id}`, result content, and `/v1/usage` (wrong key). Wrong key, no key, `Basic` scheme: 401 `invalid_api_key` "Invalid or missing API key". |
| D11 | Framework errors | `{error:{code,message}}` everywhere | removed routes, unknown paths, `GET /v1/tasks`, `HEAD`, `OPTIONS` and a task id containing `%2F` return FastAPI's **`{"detail":"Not Found"}` / `{"detail":"Method Not Allowed"}`** (405 carries `Allow`). |
| D12 | Validation messages | "branch on code" | `message` is pydantic's multi-line dump including a `https://errors.pydantic.dev/...` URL. `code` is always `invalid_request`; `param` names only the FIRST failing location (`files.0.file_name`, `tier`, `output_formats.0`, `include_model_output`, ...). Never show `message` to users. |
| D13 | `upload_size_mismatch` | 4.0: **413** | **400**, "Content-Length does not match declared file size". The file stays `waiting-file` with its `upload` intact; a corrected PUT then succeeds (200). Zero-byte PUT: same. A chunked PUT without Content-Length is accepted. Declared `bytes` contradicting a cached hash: **400 at create**, "Declared size does not match cached bytes". |
| D14 | Tier selection | omitted tier: Standard, Basic, Flash, Advanced; 4.0 returned 503 `quality_tier_unavailable` | confirmed on ceilings flash and basic: omitted tier on a **flash** server parses PDFs and PNGs with **Flash and succeeds**; on a basic server with **Basic**. An explicit tier above the ceiling: **400 `invalid_request`, `param:"tier"`, "Tier 'X' is not available"** (not 503). `tier:null` accepted. Native documents ignore a valid tier (`.docx` + `tier:standard` ran as flash); `advanced` + `.docx` was accepted at create (202) but never run. `Standard` (capital S) and `""` are 400. |
| D15 | Repeat PUT | docs: 409 `file_already_terminal` for a file no longer accepting bytes | a PUT to an already uploaded, running, completed or failed file returns **200 `{task_id,file_id,status:<current>}`** (idempotent). Only after a cancel: 409 `task_already_terminal` "Task was canceled". `file_already_terminal` was never produced. |
| D16 | `upload_not_found` | no such upload file id | 404 `upload_not_found` "Unknown file_id" for a known task with an unknown or malformed file id; an unknown task id gives 404 `task_not_found` first. |
| D17 | Format detection | "`file_name` determines the format" | content sniffing (mineru-magika) is involved: DOCX bytes named `.pdf` parse (as docx, flash); PDF bytes named `.docx` parse (flash, even with `tier:"standard"`); PDF bytes named `.png` and PNG bytes named `.pdf` parse (standard); a 1-byte file named `x.pdf` fails `Unsupported file type: txt`; CSV bytes named `.xlsx` fail `Invalid XLSX package`; `notes.txt` fails `Unsupported file type: notes.txt`. Send the right extension. |
| D18 | file_name rules | as documented | confirmed: rejected `../x.pdf`, `..\x.pdf`, `C:\input\report.csv`, `report.csv:stream`, `a/b.pdf`, `.`, `..`, `""`, control characters (BEL, LF, NUL), 1025 characters. Accepted and preserved byte for byte (no trim, no decode, no NFC): `.report.csv`, `report..csv`, `my report final.pdf`, `Árvíztűrő jelentés.pdf`, `x.pdf ` (trailing space), `a%2Fb.pdf`, 1024 characters, `README`, `x.xyz`. `param` = `files.<i>.file_name`. |
| D19 | Nulls | docs: `ocr_mode` string, `page_range` string | top-level `ocr_mode:null` and `page_range:null` are **400** (as in 4.0 for `ocr_mode`); `tier:null`, `sha256sum:null` accepted. Top-level `page_range` and per-file `page_range` both validated: `"abc"`, `"5-2"` (reversed), `"0"` give 400 `page_range_invalid`; `"2"`, `"r1"`, `"1-5"` ran fine and `"all"` was accepted at create. |
| D20 | `page_range` result | n/a | `pages[]` keeps the ORIGINAL `page_idx` (`"2"` gives `[1]`), `is_full_document:false`, `metadata.document.page_count` stays the physical total. |
| D21 | Old fields | 400 | confirmed with `param`: `filename` (and "file_name required" at the same time), `manifest`, `client_file_id` (also `null`), `file_id`, `upload_method`, `source`, `purpose`, `callback`, `include_model_output` (true AND false), `output_formats` `markdown`/`zip`/`json`. Query string: 400 "POST parameters must be supplied in the JSON body, not the URL". `text/plain` and form content types: 415 "Use application/json". Invalid JSON, empty body, JSON array: 400. |
| D22 | Limits | `files` 1 to 100 | `[]`, missing, and 101 entries: 400; 100 entries: 202. `bytes` missing/0/negative/string/float/null for an upload: 400. Duplicate names: 202 with distinct ids. |
| D23 | URL inputs | https only unless `--allow-http-source` | `http://` URL: 400 `files.0.url` "url source must use https unless --allow-http-source is enabled". A URL entry may carry `bytes`. A refused connection (`https://127.0.0.1:9/...`) is accepted (202) and fails asynchronously as `parse_failed` "All connection attempts failed". The success path was not exercised. |
| D24 | Cancel | per docs | confirmed: cancelling `waiting-file` works (all files `canceled`); cancelling while 2 files ran and 8 queued: **every unfinished file `canceled`, including the running ones**, nothing changes 4 s later; mid-way cancel with 1 file already done: that file stays `completed` and its result **stays downloadable after the cancel**, progress `{completed:1,failed:0,total:10}`. Cancelling a terminal task (completed, canceled or `partial`): 409 `task_already_terminal` "Task is <status>" (also with a `{}` body). A `partial` task is terminal. |
| D25 | Files API | n/a | `GET /v1/files/{id}` returns `{"id","object":"file","bytes","created_at","expires_at"(created+86400),"file_name","purpose":"parse_output","sha256sum"}` (note `id` and `file_name`, not `file_id`/`filename`). `GET /v1/files` is 404, `GET /v1/tasks` 405 (`Allow: POST`), `DELETE /v1/tasks/x` 405. |
| D26 | OpenAPI | n/a | `/openapi.json` is public, `info.version` is `"1.0.0"` (not 4.1.7), the create body has no schema, and responses list FastAPI's 422 although validation answers 400. Use it for field names only. |
| D27 | Models/tiers per request | n/a | `parse.tier` is the effective tier per file (mixed batch PDF+DOCX+CSV gave standard, flash, flash) and equals `extensions.mineru.tier` inside the result; `parse.parser_version` = `"4.1.7"`; `metadata.producer.version` = `"4.1.7"`. |

Documented but NOT reproduced here (needs a long wait or a different server): 410 `upload_expired` (1 h), `upload_interrupted`, 503 `server_shutting_down`, 503 `quality_tier_unavailable`
(no longer reachable the way 4.0 reached it, see D14), `result_packaging_failed`, `page_range_invalid` for a range beyond the page count, a successful URL download, and a failing
format inside a multi-format request.

---

## 7. Per-sample results (`fixtures/samples/<slug>/`)

All inputs are synthetic (no user data); generators and sha256 in `fixtures/tools/` and `fixtures/inputs/SHA256SUMS.txt`. `duration_ms` is the server's `parse.duration_ms`; wall is create to terminal as seen by the polling client (0.2 s poll).
Each folder holds: `00_inputs.json`, `01_create.json` (request + 202), `02_put_N.json`, every distinct `03_poll_NN_<status>.json`, `04_result_download_N.json` (headers + ZIP listing), `result_N/{markdown.md,structured_content.json,middle_json.json}`, `summary.json`; ZIPs only for the `*` rows (small).

| slug | request | result | effective tier / mode | duration_ms | wall | blocks seen |
|---|---|---|---|---|---|---|
| `pdf-paper-default-tier`* | no tier (2-page text PDF: table, footnote, inline + display formulas, chart, Hungarian paragraph) | completed | **standard** / txt | 8153 (cold) | 9155 | header 2, doc_title, text 7, paragraph_title 3, **equation**, page_number 2, **page_footnote**, table, **chart** |
| `pdf-paper-standard` | `tier:standard` (hash-cache hit, no PUT) | completed | standard / txt | 675 | 872 | same |
| `pdf-paper-basic` | `tier:basic` | completed | basic / txt | 10 206 (first Basic) | 11 205 | same |
| `pdf-paper-flash` | `tier:flash` | completed | flash / txt | 250 | 406 | the chart becomes an `image` block, a `footer` appears, no `page_footnote` |
| `pdf-paper-page-range-2`, `-r1` | `page_range:"2"`, `"r1"` | completed | standard | 421, 406 | 620, 605 | page 2 only (`page_idx` 1) |
| `pdf-paper-ocr-forced` | `ocr_mode:ocr`, basic | completed | basic / **ocr** | 1071 | 1270 | same as basic |
| `scan-png-default-tier`*, `scan-pdf-default-tier`* | scanned-style page (noise, blur, 0.7 degree rotation), PNG and wrapped in a PDF | completed | standard / **ocr** | 727, 628 | 929, 829 | paragraph_title 2, text 3, table |
| `docx-default`*, `xlsx-default`*, `pptx-default`*, `html-default`*, `csv-default`* | no tier | completed | **flash** / txt | 309, 23, 95, 27, 7 | 409, 205 x4 | docx: doc_title, headings, text, list 2, table, image; xlsx: 2 sheets as 2 tables; pptx: slides as pages, **speaker notes arrive as a `page_footnote`**; html: anchors |
| `pdf-hu-accented-name`* | file name `Árvíztűrő tükörfúrógép jelentés.pdf` (accents + spaces) | completed | standard / txt | 382 | 584 | name round-trips exactly in receipt and snapshots; all Hungarian text and `ő ű` intact |
| `pdf-corrupt-truncated`, `pdf-corrupt-garbage` | 35 % of a PDF; `%PDF-1.7` + noise | **failed** | n/a | n/a | 205 | `parse_failed` "Failed to load document (PDFium: Data format error)." |
| `txt-unsupported` | `notes.txt` | **failed** | n/a | n/a | 3 | `parse_failed` "Unsupported file type: notes.txt" |
| `mixed-batch-pdf-docx-csv`* | 3 files, no tier | completed | standard, flash, flash | 781, 96, 5 | 978 | per-file `result_url`; the two native files finished first (task stayed `running`, files `completed`) |
| `fmt-html-only`, `fmt-latex-only`, `fmt-default-plus-docx`*, `fmt-docx-only-from-docx` | `output_formats` html / latex / default+docx / docx | completed | standard (flash for the docx input) | 789, 723, 772, 96 | 927, 910, 898, 204 | see D2, D3 |
| `edge-inputs/*` | encrypted PDF, zero-page PDF, 1-byte file, misnamed files | see D17 | | | | encrypted: `parse_failed` "PDFium: Incorrect password error"; the zero-page PDF gives the same misleading message |
| `bigdoc-20-pages/*` | 20-page PDF, tiers, ranges, 3 concurrent tasks | completed | | | | timings in section 5 (extracted JSON/MD pruned to keep the folder small) |

Content fidelity notes (Standard tier, my own test documents): inline formulas come out as `$...$` LaTeX inside `text` blocks; the display equation as a separate `equation` block (`\tag{1}` kept); the table as a GFM table with `captions[]`;
the chart as a `chart` block with an empty `content`, a `captions[]` entry and `image_source`; the footnote as a `page_footnote` block. One quality glitch: three inline symbols of the second paragraph were displaced
("where is the number of pages and , , are fitted constants ... measuredn a b c latencies"). On the scan, OCR turned one `ű` into `ü`. The XLSX formula cell is empty because openpyxl stores no cached value (input artifact). DOCX headings keep Word's bold as `**...**` as in 4.0.

---

## 8. Hash cache and restart (`fixtures/flows/hash-cache/`, `fixtures/flows/restart/`)

**Hash cache** (all rows within one server lifetime):

| Probe | Result |
|---|---|
| Task A: new hash | `waiting-file` + `upload`; PUT; completed in 730 ms |
| Task B: same `sha256sum`, same name | **202 `pending`, no `upload`**; no PUT; completed 706 ms; **new** `task_id` and **new** `file_id` |
| Task C: same hash, other `file_name` | cache hit too (the key is the hash only) |
| Task D: same hash, name `.docx` | cache hit; parsed as flash/completed (see D17) |
| Task E: same bytes, no `sha256sum` sent | upload required (no dedupe without a hash) |
| Task F: same hash, `bytes`+1 | **400 `upload_size_mismatch` at create** |
| Task I: same hash, `tier:flash`, `page_range:"1"` | cache hit; parsed afresh with the new options (only source bytes are reused) |
| Retention | docs: 24 h, collection every 5 min; `/v1/files/{id}` reports `expires_at` = created + 86 400 |

**Restart** (`systemctl restart mineru41-spike`, command returned in 605 ms, health 200 after 3.78 s): a completed task `R1`, a waiting-file task `R2` and a cached hash existed before.

| After the restart | Answer |
|---|---|
| `GET /v1/tasks/<R1>` | **404** `{"error":{"code":"task_not_found","message":"Task job_c0ef9eb7fea605161ed53aa8 not found"}}` |
| `GET /v1/files/<R1 file>` and its `result_url` | 404 `{"error":{"code":"file_not_found","message":"File file-c0fd930d9b59dac2a1320c5e not found"}}` |
| `GET /v1/tasks/<R2>`, `POST .../cancel`, `PUT <old upload url>` | all 404 `task_not_found` |
| the cached hash | **gone**: the create answered `waiting-file` with an `upload` (4.0 kept its hash cache on disk); the blobs are still on disk (99 files) but the index is in memory only |
| first Standard parse | 7502 ms (cold) then 670 ms |
| `/v1/usage` | counters reset (`jobs_created` 61 to 0), `billing_period.start` = process start |

---

## 9. Parser check against the EXISTING code (temporary vitest, deleted; Node 22; `git status` shows nothing under `src/`)

A throwaway file `src/lib/server/services/mineru/zz-spike-mineru41.test.ts` fed the fixtures through `schemas.ts`, `result.ts` and `bundle.ts` (8 tests, 1.3 s) and was deleted afterwards. Raw output: not kept in the repo (the findings are below).

### 9.1 `schemas.ts` (protocol envelopes)

| 4.1.7 body | Existing schema | Result |
|---|---|---|
| `/v1/health` | `mineruHealthSchema` | **parses**, but `features.output_formats` defaults to `[]` (the key is `task_output_formats` now) and `sources` is `["upload","url"]`; `capabilities.ts:452-453` will therefore report no output formats |
| `/v1/tiers` | `mineruTierListSchema` (strict) and lenient | **parses** (flash, basic, standard) |
| `/v1/usage` | `mineruUsageSchema` | **parses** (nulls are `nullish`) |
| 202 create receipt | `mineruUploadSchema`, `mineruJobSchema` | **rejected**: `id/bytes/created_at/expires_at/filename/mime_type/status` and `job_id/created_at/tier/access_level` missing |
| task snapshot (running, completed) | `mineruJobSchema` | **rejected**: `job_id` (now `task_id`), `tier`, `access_level`, `links` absent; `files[].name` (now `file_name`), `files[].page_range` absent; `files[].status` enum lacks `waiting-file`, `pending`, `canceled` |
| cancel receipt | `mineruJobCancelSchema` | **rejected**: `job_id`, `canceled_at` |
| file object | `mineruFileObjectSchema` | **rejected**: `filename` is now `file_name` (and `purpose` no longer has `input_image`) |
| 81 `{error:{...}}` bodies | `mineruErrorResponseSchema` | **all rejected**: `error.type` is required and 4.1 never sends it |
| 14 `{detail:"..."}` bodies | `fastapiValidationErrorSchema` | **rejected**: `detail` is a string for 404/405, not an array |

`errors.ts` keys its rules on `HTTP:code`: still valid are `401:invalid_api_key`, `400:file_hash_mismatch`, `400:page_range_invalid`, `404:file_not_found`, `404:upload_not_found`;
moved or gone are `413:upload_size_mismatch` (now 400), `409:job_already_terminal` (now `task_already_terminal`), `404:job_not_found` (now `task_not_found`), `503:quality_tier_unavailable`
(now 400 `invalid_request` for an explicit tier), `403:feature_requires_api_key` and `400:unsupported_output_format` (gone).

### 9.2 `result.ts` and `bundle.ts` (the result)

| Check | Result |
|---|---|
| `parseStructuredContent` on all 19 captured `structured_content.json` | **all parse** (the schema is `passthrough`). Key sets vs the 4.0.4 fixture corpus: identical top level (`pages, metadata, extensions, is_full_document`), identical `metadata`/`extensions` keys, `metadata.document` is a subset (no `identifiers`, `subject` in this corpus). **No existing key was renamed or removed.** |
| `openMineruResultZip` / `parseMineruResultZip` on all 13 kept ZIPs | **all open and parse**: the `images/` directory entry is skipped, a missing `model_output.json` is fine, image names pass `MINERU_IMAGE_NAME_PATTERN`, `document.docx` in the default+docx ZIP is dropped as "safe but unrecognised" |
| `effectiveTier`, `parseMode`, `pageCount` + kind | correct for every sample (`standard/txt`, `standard/ocr`, `flash/txt`; kinds `physical`, `declared`, `logical`, `sheet`, `slide`, `unknown` for the PNG); `pageNumberSource` is `page_idx` everywhere, including `page_range` results (page 2 is reported as page 2) |
| `renderMineruMarkdown` (faithful) vs MinerU's own `markdown.md` | identical for 8 of 19 (csv, docx, xlsx, both scans, the Hungarian PDF, the mixed batch's docx and csv); the 11 that differ all contain `equation`, `chart`, `page_footnote` blocks or HTML `anchor`s |
| `stats.unknownTypes` ("the GPU-box signal") | `equation`, `chart`, `page_footnote` are not in `KNOWN_BLOCK_TYPES`; they are treated as atomic (unknown is atomic), so no chunk splits them |
| **production renderer** on `pdf-paper-default-tier` | **`chart` is dropped entirely** (empty `content`, so neither the figure nor "Figure 1. Relative throughput by tier." reaches the prompt text; `figures` = 0); the **display equation is printed as raw LaTeX with no `$$` fence**, glued in as a plain paragraph; `page_footnote` text appears as a plain paragraph where MinerU placed it; the table and its caption are fine |
| `ATOMIC_BLOCK_TYPES` | lists `equation_interline` and `chart`; 4.1.7 emits `equation` (not `equation_interline`) |
| HTML `anchor` | the faithful renderer does not reproduce MinerU's `<a id="html-..."></a>` lines (documented as "never rendered"); production is unaffected |
| `writeMineruParseBundle` + readers on the Standard PDF, the scan and the DOCX | **all write and read back identically** (`normalized.md` byte-identical, page index right). `figures` come only from `image` blocks: the Standard PDF yields **0 figures**, so its bundle `images/` is empty (the chart JPG and the equation/table crops are not kept); the DOCX yields its one figure and `readMineruFigure` serves it (`image/jpeg`, 28 019 B) |
| `middle_json.json` | nothing in `result.ts`/`bundle.ts` reads it; identity unchanged from 4.0.4: `schema:"docvortex.middle"`, `schema_version:"2.0"`, same top-level keys |

Standalone (non-ZIP) downloads are not a thing in 4.1 (one result per file, as a ZIP or as the requested single format), so the 4.0 "data-URI standalone copy" trap is gone.

---

## 10. Gotchas for the build

1. **Never rely on an omitted `tier`**; send `tier:"standard"` (D14). A flash-only server would otherwise succeed silently with Flash.
2. **Restart = amnesia** (section 8). Poll and download must map `task_not_found` and `file_not_found` to a retryable "server restarted" path that re-creates and re-uploads (the hash cache is gone too, so expect a re-upload).
3. **Creation is not idempotent and there is no list endpoint**: if the 202 is lost the task cannot be found again (it waits for its 1 h upload expiry). Do not blindly retry creation (the docs say so too).
4. **Branch on `code` and `param`, never on `message`** (pydantic dump with URLs), and **handle `{detail:"..."}` bodies** for 404/405 (D11). Every parse failure is `parse_failed`; only the message distinguishes corrupt, encrypted, unsupported and unreadable.
5. A repeat PUT is harmless (200). A short PUT leaves the file waiting; resend the full body to the same URL. Send `Content-Length` (the current client does); a chunked PUT without it was also accepted (a chunked PUT with a wrong length was not tried).
6. Cold start: the first Standard job after every start or restart takes about 8 s, the first Basic about 10 s more. Keep the poll deadline well above that; consider a warm-up parse after the unit starts (`--preload-models` exists but was NOT tried).
7. Resource planning: about 6 GiB RSS and up to 2.5 GiB VRAM per process; the unit needs `MemoryMax` of at least 16G.
8. The ZIP has an `images/` directory entry in every result (the existing opener already skips directories); `Content-Disposition` is `filename*=` for non-ASCII names.
9. `--api-key` can only be passed on argv in 4.1.7; keep using an `EnvironmentFile` with `${VAR}` in `ExecStart`, and never print `systemctl status`.
10. The `.mineru-service.lock` file in the upload dir suggests two servers must not share an upload dir (not tested; the tier-ceiling probes used a separate dir).
11. Charts and display equations need renderer work (section 9.2): without it the prompt text loses every chart caption.
12. Native documents always report `parse.tier:"flash"`, so tier-specific accounting must read `parse.tier`, not the request.
13. The key and unit are spike-only; for production re-create the unit from the existing 4.0.12 one (new venv path, `--tier standard`, keep the existing key file).

---

## 11. Open questions for the client spec

1. Cutover shape: 4.0.12 and 4.1.7 cannot be mixed (the old client gets a plain 404 on `/v1/uploads`). Atomic switch (stop old unit, repoint to the 4.1.7 venv on :8002, deploy the new client together) or a version-gated dual client (`/v1/health.version` starts with `4.1.`)?
2. One file per task (simple, chunk ranges as separate tasks, a hash hit per chunk after the first upload) or several `files[]` entries with the same bytes and different `page_range`s in one task? Whether two entries with equal `sha256sum` in one request both ask for uploads was not tested.
3. Renderer scope: add `equation` (with `$$` fences), `chart` (as a figure with caption) and `page_footnote` to `KNOWN_BLOCK_TYPES`, extend figure bundling to `chart`/`table`/`equation` images, or keep them text-only? Pptx speaker notes arrive as `page_footnote` and would then be indistinguishable from slide text.
4. Warm-up after unit start (a dummy parse, or `--preload-models` after a test) versus accepting a slower first user job.
5. Poll cadence and deadline: typical Standard parse is 0.4 to 3 s for 1 to 20 pages, cold 8 to 10 s; Basic is about 0.6 s/page and slower than Standard here.
6. `--concurrency`: production runs 4; the spike used 2 and saw clean queueing (`pending` files, the third task waits). Re-measure at 4 with the production load shape before the cutover.
7. Fixture home for the 4.1 captures: keep `docs/plans/mineru-4-1/fixtures/` or move the useful subset next to `fixtures/mineru-v1/` and re-point the existing tests?
8. Secrets for the cutover: reuse `/home/alfydesign/apps/mineru4/mineru4.env` (`MINERU4_API_KEY`) with the same `ExecStart` pattern; confirm with the owner when the unit is edited.
9. Not tried and possibly worth one more run in the build session: `MINERU_MODEL_SMALL_BACKEND=auto`, `--preload-models`, a flash-ceiling server answering PDFs (confirmed) versus the client's tier policy, URL inputs, and a 1-hour upload expiry.

---

## 12. Fixture index (`docs/plans/mineru-4-1/fixtures/`, about 2.3 MB apparent / 4.3 MB on disk, 690 files)

| Folder | Content |
|---|---|
| `install/` | `mineru-version.json`, `pip-freeze.txt` (144 pins), `hardware-info.json` and `unit-properties.txt` (host paths replaced by `<VENV>`, `<MINERU_HOME>`, `<UPLOAD_DIR>`) |
| `server/` | `/v1/health` (with and without key), `/v1/tiers`, `/v1/usage`, `/v1/models`, `/v1/models/mineru-4.1.7`, `/openapi.json` (22 KB, the authoritative contract), `GET /v1/files`, `GET /v1/tasks`, `/docs` |
| `samples/<slug>/` | per sample, see section 7; `edge-inputs/` (misnamed, encrypted, empty), `bigdoc-20-pages/` (timings, polls, ZIP listings) |
| `errors/` | 130 numbered probes (`NN_<case>.json`, request + status + headers + body): auth, tiers, file names, old fields, removed routes, validation, upload errors, cancel |
| `flows/` | `partial-and-file-terminal`, `cancel-running`, `cancel-midway`, `files-endpoints`, `hash-cache`, `restart`, `errors-leftovers`, `upload-framing`, `tier-ceilings/{flash,basic}` |
| `resources/` | `sampler.csv` (epoch, pid, children, cgroup bytes, GPU1 MiB, per-process VRAM), `resources-per-sample.json`, baselines |
| `inputs/` | the small synthetic inputs and `SHA256SUMS.txt` for all of them (including those not kept) |
| `tools/` | `cap.py` (recording client), the sample generator, `start-spike.sh`, and the scripts that produced every folder above |

No key appears anywhere in the fixtures (checked by exact-match grep, text and binary, before copying). The Authorization header is recorded as `Bearer <redacted>`.
