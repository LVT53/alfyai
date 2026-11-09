# Uploads And Document Extraction

AlfyAI extracts text and structure from uploaded and in-chat documents through **MinerU**, a
document parsing engine that runs as a service of its own. Extraction is a durable background job
rather than a step inside the upload request: the ledger under
[`src/lib/server/services/extraction/`](../src/lib/server/services/extraction/) claims, retries and
resumes each document, and the MinerU client talks to the service's **4.1 task API**
(`/v1/tasks`). There is no MinerU 3.x fallback and no second protocol: a server that does not answer
`GET /v1/health` fails clearly rather than degrading, and a 4.0.x server, which answers health like
a healthy one and then refuses the task manifest, is refused by its version (see
[The cutover window and the old server](#the-cutover-window-and-the-old-server)).

## MinerU service

MinerU handles PDF, DOCX, PPTX, XLSX, images, and web pages, with multi-language OCR built in. No
separate OCR service is required — MinerU handles OCR natively in all backends.

**Run MinerU 4.1 or newer, and pin the version.** MinerU 4.1 replaced the 4.0 upload and job API
with `/v1/tasks`, and this app speaks only the new one. A 3.x server has no `/v1/health` at all: the
availability gate below closes and five formats quietly disappear from the file picker. A 4.0.x
server answers health but cannot take a document from this app: documents wait for it (see the
cutover section) and the admin card says why. An install that follows `latest` can jump to a
release whose protocol changed again, so pin the version and run the checklist in
[deploy/README.md](../deploy/README.md#upgrading-mineru) after any upgrade.

Production runs MinerU as systemd services around `mineru-kit api-server`, each in a Python venv of
its own. This repository ships and tests no container image. The install, the services and their
ports, the key on the command line, what a server costs in RAM and VRAM and how long it takes to
start, the cutover and the rollback all have one home:
[deploy/README.md](../deploy/README.md#document-extraction-service-mineru). What matters here is that
an app calls exactly the address in `MINERU_API_URL`: the 4.0.12 server on `127.0.0.1:8002` until its
flip, and from then on MinerU 4.1.7 on `127.0.0.1:8004` (`http://127.0.0.1:8001` is only the code
default and the port in the examples). `MINERU_API_KEY` must match whatever the server was started
with; leave it empty (anonymous access) only for a server that nothing else can reach.

#### The dev MinerU (development only)

`mineru4-dev.service` is a MinerU 4.0.6 DEV API server on the box at `http://127.0.0.1:8003`: basic
tier, CPU only, API key required. It exists so that a checkout can point
`MINERU_API_URL`/`MINERU_API_KEY` at a real MinerU 4 without standing up a service of its own.
**It speaks the 4.0 protocol, which this release no longer does**: a checkout pointed at it gets the
admin card's "runs MinerU 4.0.6, which speaks the old protocol" and its uploads wait. Neither app
calls it, and it retires with 4.0.12 (the clean-up step of the runbook in deploy/README.md). It is not a
production endpoint either way: it is CPU-only, it serves one tier, and its port deliberately
differs from the `8001` default so a deployment cannot drift onto it by accident.

### The task API the app uses

The protocol client is
[`mineru/client.ts`](../src/lib/server/services/mineru/client.ts), its failure table is
[`mineru/errors.ts`](../src/lib/server/services/mineru/errors.ts), and the captured server answers
that its tests run against are in `fixtures/mineru-v41/protocol/` (recorded from a real 4.1.7 by
the spike: [spike report](plans/mineru-4-1/spike-report.md)).

| Method | Path | Used for |
|---|---|---|
| GET | `/v1/health` | version, `features.task_output_formats`, `features.sources`. Public even under `--api-key`, which is what the tool-health probe uses |
| GET | `/v1/tiers` | the quality tiers this server actually offers |
| GET | `/v1/usage` | limits, shown on the admin status card. 4.1.7 reports no file-size or page limit (`null`), only `max_files_per_job` and `max_concurrent_jobs` (its `--concurrency`) |
| POST | `/v1/tasks` | create a task for one file: a JSON manifest `{file_name, bytes, sha256sum}` plus `tier` and `ocr_mode` when set, and `output_formats: ["default"]`. Answers 202 with a receipt holding the task id and the file id |
| PUT | `upload.url` from the receipt | stream the bytes, with `Content-Length` and the receipt's `upload.headers` as given. Only when the file entry carries an `upload` object: a SHA-256 the server already holds comes back `pending` with none, and nothing is sent |
| GET | `/v1/tasks/{id}` | poll until the task settles (`completed`, `failed`, `canceled`, or `partial`) |
| POST | `/v1/tasks/{id}/cancel` | cancel. A 404 or 409 answer is swallowed: there is nothing left to cancel |
| GET | `result_url` from the finished file entry (`/v1/files/{id}/content`) | the result: one ZIP for the file |

What goes in the manifest, and what never does:

- **One task per document, one file in it**, with its `sha256sum` always, so a later task for the
  same bytes (a retry, a re-extract) hits the server's hash cache and skips the PUT.
- **`file_name` is canonical**: `document.<ext>`, with the extension the file-type registry gives
  the type (`photo.JPEG` and `scan.jfif` go as `document.jpg`, `page.htm` as `document.html`, a
  TIFF as `document.tiff`), never the person's name. 4.1 rejects `/`, `\`, `:` and control
  characters in a name, so a Mac name with a colon would be a 400, and it sniffs the content but
  routes by the extension, so the extension has to be one it knows. The name the person sees on the
  normalized document is still theirs (`<stem>.md`).
- **MinerU 4.1.7 accepts these extensions** (read from the installed package, `mineru/filetypes.py`):
  `pdf`; the images `png jpg jpeg webp gif bmp tiff jp2`; and the native documents `doc docx ppt
  pptx xls xlsx rtf odt ods odp`, `html htm shtml`, `mhtml mht`, `csv tsv`, `epub` and `ofd`.
  `tif` is not among them (hence `document.tiff`), and neither are `heic` and `heif`, which no 4.x
  release this project ran has on its list (4.0.12's is the same). So the app never sends those two
  as they are. The extraction handler decodes the photo (`decodeImageToPng`, at most 4096 px on the
  long side) into a PNG of its own for the length of one attempt, and MinerU is given that PNG,
  told as `document.png` and at an explicit tier like any other image (`intake.readAs` in the
  registry says so, and `extraction/reader-input.ts` does it). The extractor hashes the PNG itself,
  since the digest on the artifact is the photo's. The stored photo is never touched: previews and
  vision read it. A photo that cannot be decoded fails at once as `document_unreadable`, with no
  request to MinerU. The decode runs in the app's own process, on the server's main thread, and
  again on every retry and resume: measured at 1.2 to 1.8 s for a 12 MP photo and about 6 s with a
  memory peak of 1.6 GB for a 48 MP one, so a backfill of many photos costs the app that as well as
  MinerU's time (a worker-thread decode is the follow-up). The PNG is a file named
  `alfyai-reader-input-<attempt id>.png` in the temp directory, written for its owner alone and
  removed when the attempt ends; a process that is killed in the middle of one leaves it there, and
  `mineru/temp-sweep.ts` removes it once it is six hours old, like the other temporary files of a
  MinerU attempt.
- **Never sent**, because each is a 400 on 4.1: `include_model_output`, `ocr_mode: null`,
  `page_range: null`, `client_file_id`, `file_id`, and any `output_formats` other than `["default"]`.
  `MINERU_OCR_MODE=auto` therefore means the key is left out.
- **The tier** is the next section's subject.

**The two links in the receipt and in a finished file entry (`upload.url`, `result_url`) are followed
only on `MINERU_API_URL`'s origin** (scheme, host and port), and the API key is attached only
there; anything else is refused as a non-retryable `protocol` failure before a byte moves. MinerU
4.1.7 builds both links from the `Host` header of the request it answers
(`mineru/tasks/http.py:85` in the installed package; seen live on `:8004`), so
`MINERU_API_URL` must be the address the app calls MinerU on directly, and every link comes back
spelled the way the app spelled it: `http://127.0.0.1:8004`, not `http://localhost:8004`. A reverse
proxy that rewrites `Host` breaks every upload; anything that leaves the header as the app sent it
(an `ssh -L` tunnel on the same port) satisfies the rule. A mismatch shows on the first upload as
`mineruCode: protocol_untrusted_upload_url` (or `protocol_untrusted_result_url`) in the attempt's
diagnostics, with no PUT in MinerU's log.

**An address that redirects is refused too.** The JSON calls and the upload are made without
following a redirect, and a 301, 302, 303, 307 or 308 answer is refused as a non-retryable `protocol`
failure (`protocol_untrusted_redirect`), so a `MINERU_API_URL` that redirects (to `https`, to a
trailing slash, to another host) fails every document. Only the result download follows a redirect:
once, and only to `MINERU_API_URL`'s origin.

The result ZIP holds `markdown.md`, `middle_json.json`, `structured_content.json` and an `images/`
folder. The app builds the prompt text from the blocks of `structured_content.json` and keeps the
images as figures; `markdown.md` (a flat string with no page boundaries) and `middle_json.json`
feed neither the text nor the bundle. A block type the app has not seen is kept as its text and
counted (`extractionUnknownBlockTypes` on the normalized document): that count is how a new MinerU
release announces a new block type.

### Quality tiers

MinerU exposes up to four tiers — `flash`, `basic`, `standard`, `advanced` — and a given server
offers only some of them (`GET /v1/tiers`; production serves flash, basic and standard). **The app
always names the tier for a PDF or an image, and never for a native document**, because of how 4.1
treats an omitted one:

- **PDFs and images always carry a tier.** An omitted tier is not "the best one": the server falls
  back to the tier it was started with, then Basic, then Flash, and the task still succeeds, so a
  PDF would be read at Flash and nobody would know. `MINERU_DEFAULT_TIER=auto` (the default) is
  therefore resolved by the app from `/v1/tiers`: `standard`, then `basic`, then `flash`, whichever
  the server lists first (a flash-only server gets `flash`). `advanced` is never chosen for you.
  A configured tier is sent as such when the server offers it; a tier it does not offer fails the
  extraction with a clear "tier unavailable" and is not retried. The same holds for a Re-extract at a
  tier the server lacks. When `/v1/tiers` cannot be read at all, `auto` sends no tier, and a
  configured tier, which then cannot be checked, makes the attempt wait like an outage
  (`unavailable`, no attempt spent, up to `DOCUMENT_EXTRACTION_OUTAGE_WINDOW_MS`, 30 minutes by
  default) until the list can be read. A server that refuses a tier its cached list still offered
  (restarted at a lower ceiling) fails that one document as "tier unavailable" and drops the cached
  list, so the next document reads it again.
- **Native documents never carry one.** Every Office, OpenDocument, HTML, RTF and EPUB entry in the
  registry has `tierHint: "flash"`: the server runs such a file at `flash` whatever it is asked, and
  `advanced` with a `.docx` was accepted at create and then never ran, a task that waits for
  nothing. So the key is left out, even for a Re-extract. CSV and TSV never reach MinerU at all
  (below).
- **`parse.tier` is the tier a file really ran at.** The app records it
  (`extractionJobTier` on the normalized document) beside the tier written in the result itself
  (`extractionTier`); for a native document both say `flash`, and for a PDF or an image they say
  the tier the server ran it at.

**Settings → System → Integrations & keys** shows a MinerU status card: the version that answered,
the tiers and output formats (`task_output_formats`) it reports, its limits, and an explicit
"unreachable" with a reason when it is down. A 4.0.x server shows as unreachable with its version
and "speaks the old protocol".

### Configuration

Full rows in [docs/configuration.md](configuration.md#document-extraction-mineru). The thirteen keys
are `MINERU_API_URL`, `MINERU_API_KEY`, `MINERU_DEFAULT_TIER`, `MINERU_OCR_MODE`,
`MINERU_JOB_TIMEOUT_MS`, `MINERU_POLL_MIN_MS`, `MINERU_POLL_MAX_MS`, `MINERU_REQUEST_TIMEOUT_MS`,
`MINERU_TRANSFER_TIMEOUT_MS`, `MINERU_CAPABILITIES_TTL_MS`, `MINERU_BUNDLE_MAX_BYTES`,
`MINERU_BUNDLE_USER_QUOTA_BYTES` and `MINERU_STRUCTURE_CHUNKING_ENABLED`. All thirteen are editable
live on the admin screen and apply on the next extraction — no restart.

### Parse bundle retention

`MINERU_BUNDLE_MAX_BYTES` caps ONE bundle; `MINERU_BUNDLE_USER_QUOTA_BYTES` (default 2 GiB, `0` =
unlimited) caps a user's bundles in total. Bundles are derived data — the normalized text is in the
database, and **Re-extract** rebuilds a bundle — so the budget is enforced by throwing the cheapest
thing away first.

After a bundle is written, if that user's `data/knowledge/<userId>/*.parse/` directories exceed the
quota, OTHER documents' bundles are evicted least-recently-written first:

1. the bundle's `images/` directory is removed and its manifest marked `imagesEvicted: true`.
   `normalized.md`, `pages.json` and `structured_content.json` stay, so page citations and
   `read_generated_file?page=` keep working; the figure endpoint answers 404 and any figure list
   renders empty;
2. if still over, whole bundles go, oldest first.

The bundle just written is never evicted, each eviction is a rename-then-remove (so a concurrent
figure read sees the file or does not, never a half-removed directory), and the number of bundles
examined per write is bounded. One `[MINERU]` line per eviction pass records counts and bytes
only.

`MINERU_TIMEOUT_MS` was replaced by `MINERU_JOB_TIMEOUT_MS`. The old environment variable is still
read as a fallback for one release, and an existing admin override is carried over by the
`1777140000098_mineru4_extraction` migration.

### Re-extracting at a different quality

A document that came back thin can be read again without being re-uploaded: the Knowledge list's
row actions offer only the tiers ABOVE the one the document is already at. The list comes from the
server (`GET .../reextract`), which filters out the current tier and everything below it rather
than leaving them visible and disabled — a menu that listed one would be offering a request the
POST refuses. The normalized document keeps its id, so every link, working
set entry and citation that points at it stays valid; its chunks, outline and page index are
rebuilt from the new parse.

Documents that predate structured extraction have no recorded tier and are offered every tier the
server has. There is no automatic backfill: an old document keeps working exactly as it did, and
re-extraction is the only thing that gives it pages, figures and a parse bundle.

A tier at or below the one a document was last read at is refused by the server, not just hidden by
the menu: re-extraction replaces the text, the chunks and the bundle, so accepting a lower tier
would throw away a better parse and report success. Operators and scripts can override it with
`{"force": true}` in the POST body. Each account may also have at most five re-extractions queued or
running at once; over that the endpoint answers `429` and the seat frees as jobs finish.

A native document (an Office, OpenDocument, HTML, RTF or EPUB file) is the exception to "a higher
tier reads it better": MinerU 4.1 runs it at `flash` whatever it is asked, and the app sends it no
tier, so a re-extract of one rebuilds it at `flash` again.

## Accepted upload formats

The shared file-type registry ([`src/lib/shared/file-types/`](../src/lib/shared/file-types/)) is
the single source of truth for what an upload accepts, how it previews, and where it routes — there
is no second list to keep in sync, and this file does not hand-maintain one either. Print the live
set instead of trusting a snapshot here:

```bash
npx tsx -e "import {getAcceptedExtensions} from './src/lib/shared/file-types/index.ts'; console.log(getAcceptedExtensions('knowledge').join(', '));"
```

Both surfaces — the Knowledge page and the chat composer — accept the same set of extensions (they
differ only in the order the picker lists them). Every non-`reject` registry entry is admitted on
both; the server's admission check (`admitUpload`) is intentionally surface-independent, so a
narrower client-side list could only ever hide formats the server already accepts, not enforce
anything.

Each entry's `intake.route` decides what happens next:

- **`mineru`** — sent to the MinerU task API described above (PDF, Office formats, raster images
  except AVIF, HTML, EPUB, RTF, and the open-document formats).
- **`direct-text`** — read straight into the ledger as text, no MinerU round trip (plain text,
  Markdown, code, CSV, TSV, SVG — which is XML, not a raster image — and a handful of MIME-sniffed
  extensionless files). See
  [Direct-text decoding and the size cap](#direct-text-decoding-and-the-size-cap) below.
- **`reject`** — refused at upload time with a 415 and a reason: `media`, `archive`,
  `convertImage`, `formatNotEnabled` or `unknownType`. Two entries are recognised by name purely to
  get a better message than "unsupported type": `.ofd` gets "save it as PDF or DOCX" (nothing in
  this app has ever parsed OFD, so it stays refused until there is real evidence it works), and
  `.avif` gets `convertImage` — every other raster image goes to MinerU, but AVIF is the one the
  engine cannot decode, so the message asks for a PNG or JPEG instead.

### The MinerU-4 availability gate

`rtf`, `odt`, `ods`, `odp` and `epub` only ever worked once this app started targeting MinerU 4.x —
there is zero spike evidence they parse on an older backend. Rather than silently fail every upload
of those five formats against a pre-4.x server, the app probes `GET /v1/health` (cached behind
`MINERU_CAPABILITIES_TTL_MS`) and, only on a POSITIVE reading of a major version below 4, hides them
from both accept strings and refuses them at `/upload/intent`, `/upload/raw`, `/upload/chunk` and
the legacy multipart route with the same 415 `formatNotEnabled` envelope a not-yet-enabled format
gets.

The gate **fails open**: an unconfigured server, a timeout, a connection refusal, or a cache that
has simply never been probed yet all leave every format enabled. Only a probe that answers is
allowed to shrink what the picker offers — a momentary outage must never make the file picker
appear to lose formats it actually supports. It also never makes a network call on the upload's own
request: it reads whatever `MINERU_CAPABILITIES_TTL_MS` has cached and, on a cold cache, answers
"open" immediately while a refresh runs in the background for the next request to pick up.

`html`/`htm` are the one exception to "hidden when gated": they worked before this migration (read
as raw text) and must never regress into a refusal just because the backend is old. On a positively
detected pre-4.x backend they instead fall back to the `direct-text` route — the same thing that
happened to them before MinerU 4 routed them through `flash` — rather than disappearing from the
picker.

What an admin sees: the real backend version on the MinerU status card (above); no separate banner
or toggle for the gate itself. What a user sees on an old backend: five fewer formats in the file
picker, and the existing "`{EXT}` files aren't supported yet" message if they force one through
anyway (drag-and-drop, or the OS "All files" dialog).

The gate reads the **major** version only. A 4.0.x server keeps every format open in the picker
(it reads all of them) although the extractor refuses it, because 4.0.x speaks the old task API:
uploads are accepted and their documents wait, see
[The cutover window and the old server](#the-cutover-window-and-the-old-server). Only a 3.x answer
(or a server without `/v1/health` at all) closes the gate.

### Direct-text decoding and the size cap

A `direct-text` upload is decoded once, by
[`extraction/text-decode.ts`](../src/lib/server/services/extraction/text-decode.ts)'s
`decodeTextBuffer`, shared by the upload extractor and (a candidate for) the generated-file readback
path:

1. A UTF-8 BOM is stripped; UTF-16LE/BE BOMs are decoded and stripped; a UTF-32 BOM is refused
   (`unsupported_encoding` — Node has no UTF-32 decoder).
2. With no BOM, the bytes are read as UTF-8. There is no heuristic UTF-16 sniffing: a BOM-less
   UTF-16 file is indistinguishable from a binary one, and guessing would mangle legitimate
   Latin-1-ish text.
3. A NUL byte anywhere, or more than 1% U+FFFD replacement characters in the first 64 KiB, is refused
   as `binary_content` — this is what catches a JPEG or other binary file renamed with a text
   extension.
4. CRLF is normalised to LF and the result trimmed, exactly as chunk-sync does it, so the same file
   chunks (and therefore embeds) identically whichever route reads it.

Both failure kinds surface as the extraction error code `unsupported_type` — no new i18n was added
for them, the existing "this file type isn't supported" copy already fits.

`DOCUMENT_EXTRACTION_MAX_DIRECT_TEXT_BYTES` (default 8 MiB, see
[docs/configuration.md](configuration.md)) caps a `direct-text` upload before any byte is read: past
8 MiB of raw text is roughly 2M tokens and thousands of chunk/embedding calls from a single upload.
It does **not** apply to `html`/`htm` any more — they route to MinerU and are bounded instead by
`MAX_FILE_UPLOAD_SIZE` (MinerU 4.1.7 reports no size limit of its own) — unless the MinerU-4 gate
above has fallen them back to `direct-text` on an old backend, in which case the cap applies to them
again.

## The async extraction flow

An upload returns as soon as the bytes are stored; a durable job
(`document_extraction_jobs`, [`src/lib/server/services/extraction/`](../src/lib/server/services/extraction/),
run by the shared job engine in [`src/lib/server/services/jobs/`](../src/lib/server/services/jobs/))
is then claimed, run, and its result persisted, so a process restart resumes rather than
restarts. The route decision above (`mineru` vs. `direct-text` vs. `reject`) is read once, at
enqueue time, from the shared registry (adjusted for the MinerU-4 gate); nothing downstream
re-derives it.

A `mineru`-routed job's own protocol lives entirely in
[`src/lib/server/services/mineru/`](../src/lib/server/services/mineru/), driven by
[`extractors/mineru4.ts`](../src/lib/server/services/extraction/extractors/mineru4.ts). One attempt
is one task with one file: `POST /v1/tasks` (the receipt names the task and the file) → `PUT` the
bytes to `upload.url` when the receipt has one → poll `GET /v1/tasks/{id}` → download the one ZIP
from `result_url`. The task id and the file id go into the job's checkpoint (`remoteJobId` and
`remoteFileId`, the fields the 4.0 client used for its job and file ids, so no migration) as soon as
the 202 is back and before the bytes move, so a worker that dies mid-upload resumes the same task
instead of creating a second; a checkpoint without `data.protocol: "tasks/1"` (the 4.0 client's) is
not resumed. The ZIP yields the prompt Markdown plus a **parse bundle** on disk at
`data/knowledge/<userId>/<sourceArtifactId>.parse/` (page index, structured content, figures). A
`direct-text` job skips all of this and reads the file once, in-process: CSV and TSV never send
MinerU a request.

A settled remote task is never resumed: any attempt that finds one failed, canceled, or carrying a
file-level error clears the stored handle, so the next attempt (automatic or a user Retry) creates a
fresh task rather than re-polling one that cannot change its answer. Sending the bytes again costs
nothing while the server still holds them: the manifest's `sha256sum` makes it answer `pending`
with no `upload` object. Every failed file arrives as the single code `parse_failed`, and only
MinerU's message says why; the app maps the known wordings to its own reasons and never shows the
message to a person. A damaged, zero-page or password-protected PDF (`PDFium: Data format error`,
`PDFium: Incorrect password error`) and a workbook that is not one (`Invalid XLSX package`) map to
`document_unreadable`, which is neither auto-retried nor user-retryable: the same bytes cannot
become readable, and a repaired file has a different hash and so arrives as a new document.
`Unsupported file type` maps to `unsupported_type`. An unexplained `parse_failed` still maps to
`job_failed` and keeps its small attempt budget. MinerU's own words stay with the operator, in the
attempt's diagnostics (`document_extraction_job_attempts.diagnostics_json`, as `rawMessage` beside
the rule that matched).

### Restarts, and a server that forgot

MinerU 4.1 keeps every task, file, upload link and its hash cache in memory, so restarting the
service forgets all of them: the uploaded blobs stay on disk, but nothing indexes them. It also lets
go of an upload link after an hour and of a task's files after a day (the answer for an expired
link, a 410 `upload_expired`, is documented but was never seen live). The extractor treats
`task_not_found`, `file_not_found`, `upload_not_found` and `upload_expired` as "the server
forgot" and not as a failure: it creates the task again and sends the bytes again, and because the
hash cache is gone too, the new receipt carries an `upload` link again. That recovery is bounded to
once per attempt, and so is the second PUT for a task that is still listed but never got its bytes (a
worker that died between the 202 and the PUT: the snapshot of a `waiting-file` task carries its
link). A server that forgets again, or a file that no longer matches what its task declared (a 400
`upload_size_mismatch` or `file_hash_mismatch`; the app then stats and hashes the file afresh before it
creates the task again), ends the attempt with a retryable failure that clears the handle, and the
ledger's own retry budget takes over.

While the service is down (a few seconds until health answers, then a one-off model load for the
first Standard document; the numbers are in deploy/README.md) requests fail as transport errors.
Those are outage waits and are not charged to the document: the job goes back to `queued` and tries
again with a growing wait (5 s, doubling to 5 min) for up to `DOCUMENT_EXTRACTION_OUTAGE_WINDOW_MS`
(30 minutes by default), then resumes from the stored handle, meets `task_not_found`, and the
recovery above makes a new task. The tests prove this against a fake server held to the captures;
the one run against a real 4.1.7 is the ai.dev live check below, which restarts `mineru41` in the
middle of a job and expects the job to succeed, not fail.

`MINERU_JOB_TIMEOUT_MS` is the clock of one attempt: it starts with the attempt and is enforced
while the task is polled (the transfers have their own, `MINERU_TRANSFER_TIMEOUT_MS`). At the
deadline the task is canceled on the server and spent, and the last snapshot says what that
means. A file MinerU had not started (still queued, or never sent its bytes) waits like an outage
and spends no attempt, since the document was never the slow part. A file it was running spends
an attempt like any other retryable failure, so a document that is simply too slow for the
deadline ends, once its attempt budget is gone, with the code `max_attempts` (the label the UI
shows for it; Retry is still offered) and the timeout's sentence as the stored message, not as
`unavailable` ("could not be reached").

### The cutover window and the old server

Moving from 4.0.12 to 4.1 is a flip of one live setting, not a restart. The two servers run side by
side (4.1.7 on a new unit and port, 4.0.12 where it was), and each app switches by setting
`MINERU_API_URL` in its `admin_config` (Settings → System → Integrations & keys, or `PUT
/api/admin/config`), which applies on the next extraction. The runbook and the rollback are in
[deploy/README.md](../deploy/README.md#cutting-over-to-41-and-rolling-back).

The app has to survive the seconds between "this release is deployed" and "the URL is flipped".
**MinerU 4.0.12 also serves a `/v1/tasks` of its own**, an
older API with the same path, so an old server is not a 404: it answers a 4.1 manifest with an HTTP
400 whose error object carries a `type` (read from the installed 4.0.12 source; the test doubles
for these bodies are derived from it, not captured). 4.1 never sends one (none of the 128 error
bodies captured from 4.1.7 has it), so the app treats any error body with
`error.type`, on any path and with any status or code (a 401 or a `task_not_found` included), as "the
old server" and not as an answer about the document. That failure is `unavailable`: retryable, a
patient outage wait, the handle kept, logged as `MinerU answered in another protocol's voice`, and
never mistaken for a forgotten id. Documents caught in the window wait `queued` ("The document
service could not be reached.", no attempt spent) and finish by themselves once the URL points at
4.1, provided that happens within the outage window (30 minutes by default,
`DOCUMENT_EXTRACTION_OUTAGE_WINDOW_MS`): after it they fail as `unavailable` and need a Retry.

**A rollback has the mirror order, and the order is mandatory:** set `MINERU_API_URL` back to the
4.0.12 server first (the 4.1 release then waits out 4.0.12 like any outage), and only then deploy the
previous release. The previous release has no guard against 4.1: pointed at `:8004` it reads 4.1's
FastAPI 404 (`{"detail":"Not Found"}` for `POST /v1/uploads`) as a permanent error (`protocol`, not
retryable, rule `fallback:4xx`) and fails every document it sends there, each needing a manual Retry.
So never re-point `current` to a release older than the 4.1 one while `MINERU_API_URL` still names
`:8004`. `scripts/deploy.sh`'s own automatic rollback, after a failed health check at a cutover,
runs before the URL is flipped, so it is safe. The runbook is in
[deploy/README.md](../deploy/README.md#cutting-over-to-41-and-rolling-back).

The capability read catches it earlier: a health answer with a 4.0.x version is `reachable: false`
with the version kept. The admin card says "runs MinerU 4.0.12, which speaks the old protocol. This
app needs MinerU 4.1 or newer: point MINERU_API_URL at a 4.1 server.", Diagnostics shows
`document_extraction` degraded and says the server speaks the old protocol, and the cached answer
belongs to the origin it was read from, so the flip is seen on the next probe, without a restart. Rule R14 of
[the build log](plans/mineru-4-1/build-log.md) rests on 4.1 error bodies never carrying `type`; the
upgrade checklist in [deploy/README.md](../deploy/README.md#upgrading-mineru) re-checks that on
every MinerU upgrade.

Parse bundles are derived data — they can always be regenerated by re-extracting the source document
— and are excluded from the account data archive
([`account-data-archive/`](../src/lib/server/services/account-data-archive/)), which ships only the
originally uploaded bytes and the normalized readable text. Half-written uploads under `.incoming`
are excluded for the same reason — they are not the user's data yet. Both exclusions are named and
tested in `src/lib/server/services/account-data-archive/index.ts`.

### Polling extraction status and readiness

Surfaces that show a document's processing state poll
`GET /api/knowledge/extraction?artifactIds=…` (comma-separated, at most 50 ids per request). The
response has two halves:

- **`jobs`** — `DocumentExtractionJobDTO[]`, one per resolvable, owned id, in the order asked.
  Unknown and unowned ids stay omitted.
- **`readiness`** — `AttachmentReadinessSnapshot[]`, one per returned job whose status is terminal
  `succeeded`. It is empty for queued, active, failed and canceled jobs, and the readiness read is
  skipped entirely when no returned job succeeded.

A readiness snapshot is:

```json
{
  "artifactId": "…",
  "promptReady": false,
  "promptArtifactId": null,
  "readinessError": "This file was uploaded, but no usable readable text could be prepared for chat from it.",
  "readinessErrorCode": "no_usable_text"
}
```

`promptReady: true` carries the normalized document id a chat turn would attach and no error.
`no_usable_text` means extraction produced a normalized document whose text is too thin to use;
`not_prepared` means it produced none. The split matters because a `succeeded` job only says the read
finished; without the verdict a success with unusable text would look ready until the send gate
refused the turn. The readiness read is best-effort: if it fails, the route logs and still returns
the jobs with `readiness: []`, so lifecycle polling never stops for a content-read problem.

On the client, `fetchExtractionStatus` in
[`src/lib/client/api/knowledge.ts`](../src/lib/client/api/knowledge.ts) carries both halves;
`fetchExtractionJobs` remains the jobs-only compatibility wrapper. The shared
[`createExtractionPoller`](../src/lib/client/extraction-poll.ts) passes the verdicts beside the jobs,
and the composer merges them into the attachment. When an upload response or restored draft already
contains a terminal success without a content verdict, the composer asks the status endpoint once for
the missing verdict.

Knowledge upload intake is a dedicated boundary
([ADR 0024](adr/0024-knowledge-upload-intake-boundary.md)).

## Maintenance scripts

### Sweeping orphaned generated artifacts — REQUIRED ONCE AFTER THE CUTOVER

`artifacts.conversation_id` is `ON DELETE SET NULL`. Before release `f41f7931`, deleting a
conversation therefore cleared the link on every `generated_output` / `work_capsule` it preserved,
and from that moment the row was unreachable from every direction: `isArtifactCanonicallyOwned`
refuses those two types without a live conversation, so the Library did not list it, `GET` answered
404, and the bulk "forget all" actions skipped it. The row, its chunks, its embeddings, its
extraction job row, its stored file and its MinerU parse bundle stayed on disk with nothing able to
remove them.

The delete path is fixed and the bulk "forget all generated results" action now includes these
rows for the acting user. Neither reaches backwards across every account, so
**`scripts/sweep-orphan-generated-artifacts.ts` must be run once with `--apply` after the
production cutover.**

```
# ALWAYS first. --dry-run is the DEFAULT: with no flag nothing is deleted.
DATABASE_PATH=./data/chat.db npx tsx scripts/sweep-orphan-generated-artifacts.ts

# Then, after backing up the database.
cp data/chat.db data/chat.db.pre-sweep
DATABASE_PATH=./data/chat.db npx tsx scripts/sweep-orphan-generated-artifacts.ts --apply
```

`DATABASE_PATH` must be set explicitly — the script refuses to run without it rather than picking
up the app's `./data/chat.db` default, because a destructive sweep that silently follows a default
can be pointed at production by a `cd`.

**Run the dry run first, every time, and back up the database before `--apply`.** The sweep is the
only thing in the product that deletes rows nobody asked it to delete, so the dry run is how you
see what it would take before it takes it.

#### Reading the dry-run counts

The script prints the number of unreachable artifacts, then a breakdown per user and per type, then
the first 20 ids. That number is the CANDIDATES (a `generated_output` or `work_capsule` with
`conversation_id IS NULL`) **minus** everything the reachability exclusions saved. To see the
difference — which is the useful number, because it tells you the exclusions are firing at all —
compare it against the raw candidate count:

```
sqlite3 data/chat.db "select count(*) from artifacts
  where conversation_id is null and type in ('generated_output','work_capsule');"
```

The gap between the two is how many candidates were spared by an `artifact_links` row, a live
document-family sibling, or surviving chat-file bytes. A gap of zero on a box with real history is
worth a second look before applying; so is a candidate count far larger than the users' visible
document counts.

#### What `--apply` actually does

Deletion goes through `hardDeleteArtifactsForUser`, the same service function the app's own delete
uses, so chunks, links, embeddings, parse bundles, extraction job rows and files on disk all go the
way they would from the UI.

- **One transaction per user batch**, not per artifact. Every row for one user goes or none does; a
  half-applied delete that left links pointing at artifacts that are gone would be worse than
  either outcome. Ids are batched internally because SQLite binds at most 32 766 parameters per
  statement, but all batches for a user share the one transaction.
- **File unlinks happen AFTER the commit**, deliberately: holding a write transaction open across
  thousands of filesystem calls would block every other writer for the duration. The consequence to
  plan for is that a crash mid-unlink leaves FILES behind, never rows — the database is already
  consistent and the sweep is safe to re-run, but it will then report nothing to do while the bytes
  are still there.

  There is no automatic collector for those. `mineru/temp-sweep.ts` collects only the temporary
  leftovers of a killed MinerU attempt (half-written `.parse.tmp-` bundles, per-attempt download
  directories and the converted HEIC or HEIF photo), not the final files of a delete that did not
  finish. After a sweep that crashed, find them by comparing the disk against the surviving rows:

  ```
  # Every stored path the database still references.
  sqlite3 data/chat.db "select storage_path from artifacts where storage_path is not null;" | sort > /tmp/referenced.txt
  # Everything actually on disk.
  find data/knowledge data/chat-files -type f | sed 's|^|./|' | sort > /tmp/on-disk.txt
  comm -13 /tmp/referenced.txt /tmp/on-disk.txt
  ```

  Read the result before deleting any of it: `data/knowledge/<user>/<id>.parse/` bundle contents
  are referenced by directory rather than by row and will show up here legitimately.
- **A path that does not resolve inside `data/knowledge/` or `data/chat-files/` is refused**, not
  unlinked, and appears in the script's `file gaps` count. That is a bad row, not a bad sweep;
  every path the app writes is server-generated and safe, and the guard exists because this script
  is the first thing that reads those paths box-wide.
- The counts the script logs are counts. No filenames, no artifact ids beyond the preview list, no
  document text. The preview list is id, type and byte size only — a generated output's `name` IS
  the filename the model chose for the user, so it is not printed.

What counts as unreachable is defined once, in
`src/lib/server/services/knowledge/store/orphan-artifacts.ts`, and shared with the bulk action. An
artifact is NEVER swept when it still has a conversation, when an `artifact_links` row connects it
to a conversation or message that still exists, when it belongs to a document family with any
reachable member, or when its chat file row and its bytes both survive.

### Backfilling a library after a MinerU upgrade

Every document parsed before this app spoke MinerU 4 has flat text chunks: no page numbers, no
outline, no figures — `metadata.extractionProducer` is simply absent on its normalized artifact,
which is how a "legacy" document is told apart from one MinerU 4 produced (D12,
[phase2-4-mineru-client-spec.md](plans/mineru4/phase2-4-mineru-client-spec.md)). The app never
backfills these on its own: the only user-facing path back is "Re-extract" on the Knowledge list,
one document at a time.

The MinerU 4.1 release added a second, milder population. The renderer that turns MinerU's blocks
into prompt text changed with it (a chart picture is kept as a figure with all its captions, display
math is fenced with `$$`, PPTX speaker notes are labelled, see `result.ts`), so
`MINERU_PARSER_VERSION` moved from `mineru4/1` to `mineru4/2`, and
`metadata.extractionParserVersion` on a normalized document says which renderer made it. Until
4.1, the renderer dropped every chart and its caption from the text and left display math
unfenced; MinerU 4.0.12 emits the same blocks, so documents read before the 4.1 release
(`mineru4/1`) lack them. They keep their text until they are read again. **The backfill below does
not do that for a document that already carries the requested tier**: it skips a document whose
recorded tier is at or above the one requested, whatever renderer read it, so it re-reads only
documents recorded below that tier or with none. To read a same-tier document again with the new
renderer, Re-extract it with the `force` override described above (`{"tier": "standard", "force":
true}`, the tier it already carries), one document at a time.

`scripts/backfill-extractions.ts` is the operator-run equivalent for a whole library. It walks
every `source_document` artifact (knowledge-page uploads AND chat-attachment documents — both live
in the one `artifacts` table and differ only by whether `conversation_id` is set, and both go
through the identical extraction ledger, so both are in scope), and for every one whose shared
file-type registry route is `mineru` and whose stored file still exists on disk, it re-extracts it
through the **exact same service path** the Knowledge list's "Re-extract" row action uses
(`materializeLegacyExtractionJob` + `requeueExtractionJobForReextraction` in
[`src/lib/server/services/extraction/`](../src/lib/server/services/extraction/)) — so the replace
path, its atomicity, and its embedding refresh are exactly what a user gets from that button, not a
second implementation of it. A document's id, title and conversation attachments never change; its
chunks, outline and page index are rebuilt only once the new parse succeeds — a document that is
skipped, or whose re-extraction fails, keeps its old content exactly as it was.

`--dry-run` is the DEFAULT: with no `--apply`, nothing is enqueued and the script only reports what
it would do — counts per intake route, per file type, per user, total bytes, and every exclusion
with its reason (already at the requested tier, already in flight, the file is missing on disk, or
the type is `reject`-routed and unsupported today).

```
# ALWAYS first. Reports what would happen; enqueues nothing.
DATABASE_PATH=./data/chat.db npx tsx scripts/backfill-extractions.ts

# A first careful batch.
DATABASE_PATH=./data/chat.db npx tsx scripts/backfill-extractions.ts --apply --limit 20

# The rest, once the first batch looks right.
DATABASE_PATH=./data/chat.db npx tsx scripts/backfill-extractions.ts --apply

# Progress, any time.
DATABASE_PATH=./data/chat.db npx tsx scripts/backfill-extractions.ts --status

# Once the queue has drained: what did the re-parse actually do to the text?
# (--apply prints this path when it writes the snapshot.)
DATABASE_PATH=./data/chat.db npx tsx scripts/backfill-extractions.ts \
  --verify data/backfill-snapshots/2026-09-22T14-23-10-299Z.json
```

On the box, after the production cutover:

```bash
cd /home/alfydesign/apps/langflow-chat/current && \
  DATABASE_PATH=/home/alfydesign/apps/langflow-chat/shared/data/chat.db \
  npx tsx scripts/backfill-extractions.ts --apply
```

(`DATABASE_PATH` above is illustrative — use whatever path the deployment's own `.env` /
`DATABASE_PATH` already points at; see [deploy/README.md](../deploy/README.md).)

**It reads the admin config, not just `.env`.** Every MinerU setting is admin-overridable
(`MINERU_API_URL`, `MINERU_API_KEY`, `MINERU_DEFAULT_TIER`, the timeouts), and an `admin_config`
row beats the environment. The script overlays them the same way the server does at boot
(`refreshConfig()`, as `ensureRuntimeConfigReady` in [`hooks.server.ts`](../src/hooks.server.ts)
calls it) — without that it would be reading `.env` rather than the deployment's own settings, and
on the dev box that meant probing `127.0.0.1:8001` (the `.env` value) while the app ran against the
MinerU its admin settings named. The endpoint it resolved is the first line of the dry-run report,
so a mismatch is visible immediately:

```
MinerU:        http://127.0.0.1:8004
Tier:          standard
```

(The endpoint only. The API key is never printed.)

Flags:

| Flag | Effect |
| --- | --- |
| `--apply` | Enqueues. Without it, nothing is written. |
| `--tier <flash\|basic\|standard\|advanced>` | Defaults to the configured `MINERU_DEFAULT_TIER`, and `auto` is resolved the way the extractor resolves it (the best of `standard`, `basic` and `flash` that the server lists, never `advanced`). The owner's stated target for prod is `standard`, so pass it explicitly. Anything that is not one of the four ids is refused before the database is opened, and a tier this MinerU does not serve is refused before `--apply` writes anything (a dry run still works with the backend down — it only warns). A registry `tierHint` of `flash` (every Office, HTML, RTF, EPUB format) marks a native document: MinerU parses it at `flash` regardless and the extractor sends it no tier at all, so the script counts its tier as `flash` for the "already done" check rather than compare against a tier these types can never reach (which would re-enqueue them forever). |
| `--include-direct-text` | Also re-chunks `direct-text` documents (plain text, Markdown, CSV, …) through the current chunker. Skipped by default: these never went through MinerU at all, so there is nothing MinerU-version-specific to fix; the flag exists for the rarer case where the chunker itself changed. |
| `--since <iso>` | Scopes `--status` and `--only-failed` to this script's own campaign, measured in the ledger's `updated_at` (the column a requeue and a completion move — **not** `created_at`, which for every document that already had a ledger row is the day it was uploaded). Defaults to the earliest `updated_at` among the rows this script has ever stamped `requested_by = 'backfill'` — i.e. the script's own first run. Does **not** gate the core "already done" check, which is unconditional: a document already parsed at or above the requested tier is skipped regardless of who produced that parse or when. |
| `--limit N` | Enqueues at most N documents — a first careful batch. Positive integer, refused otherwise. The batch is sampled **round-robin across accounts** rather than taken off the front of the list, so a first batch exercises the library rather than one account's oldest files; the underlying order is `created_at, id`, so a given `--limit` is reproducible. |
| `--user <id\|email>` | Scopes to one account. |
| `--only-failed` | Re-enqueues only the documents whose most recent backfill attempt ended in a user-retryable error (see `--status`), inside the `--since` window. A failure whose stored file is missing from disk is **not** re-enqueued: the next attempt would reach the same `internal` failure and spend one more of the document's attempts. |
| `--status` | Prints progress from the ledger: queued/running/succeeded/failed counts, succeeded documents by achieved tier, and every failed document with its error code and whether a manual retry (`--only-failed`) can still help versus a terminal failure that needs a re-upload. |
| `--verify <snapshot>` | `--status`, plus the shrink check below, against a snapshot an earlier `--apply` wrote. Adds a `shrunk` count to the summary and lists each flagged document. Always exits 0 — a shrink is something to look at, not a failed command. |
| `--shrink-threshold <0..1>` | How much of a document has to survive before `--verify` leaves it alone. Default `0.5`: flag anything that came back smaller than half its previous size. |

**Idempotent and resumable.** A document already carrying a queued or active job is always skipped.
A document with a `succeeded` job whose achieved tier already meets the requested tier is skipped.
Running the script again after a partial run (or after `--limit` capped an earlier batch) only
touches what is left; a full second run against an already-completed library enqueues nothing.

**Fairness.** The script enqueues every eligible document up front rather than throttling in
rounds: the job engine's own claim query
([`ledger.ts`](../src/lib/server/services/jobs/ledger.ts), the `headIds` query) already
claims one row **per user** — that user's oldest claimable job — before it ever looks at priority or
age, so flooding the queue with one account's whole library cannot starve any other account's claim.

**The per-account cap does not apply.** A user pressing "Re-extract" repeatedly is capped at five
queued-or-running re-extractions (`MAX_ACTIVE_REEXTRACTIONS_PER_USER`) so they cannot self-inflict
an outage on a backend that serves one job at a time. That cap exists for a *user*; this script is
an *operator* action, run once, and bypasses it explicitly via
`requeueExtractionJobForReextraction`'s own `maxActiveReextractions` override.

**Never deletes anything, and never touches a document that fails.** A failed or skipped document's
old content — its chunks, its outline, its page index — is exactly what it was before the script
ran. The script prints a final summary and exits non-zero if any document could not be enqueued.

**The shrink check: the one thing the pipeline cannot catch for you.** A re-extraction that returns
*nothing* is refused — the MinerU result parser raises `empty_result`, which is terminal and never
reaches `persist.ts`, so the old text survives. A re-extraction that returns *a tenth of the text*
is not refused: it succeeds, and `rewriteNormalizedArtifact` replaces the old content with it. The
ledger cannot tell that apart from a good parse, and over a whole library nobody would find it by
reading.

So `--apply` writes a snapshot **before it enqueues anything** and prints the path:

```
Pre-backfill snapshot: /…/data/backfill-snapshots/2026-09-22T14-23-10-299Z.json
  (412 document(s); check them afterwards with --verify /…/2026-09-22T14-23-10-299Z.json)
```

It is a plain JSON file — every document in the batch, with the `content_text` length and chunk
count it had at that moment. It lives in `data/backfill-snapshots/`, deliberately a **sibling** of
`data/knowledge/` rather than inside it: the orphan sweep, bundle eviction and "Forget all results"
all resolve paths through `storageRoots()`
([`storage-containment.ts`](../src/lib/server/storage-containment.ts)), whose only roots are
`data/knowledge` and `data/chat-files`. A safety record those paths could delete would not be one.
The directory is created on first use, and `data/` is already gitignored.

Once the queue has drained, `--verify <that file>` compares every **succeeded** document against
it and lists the ones that came back below `--shrink-threshold` (default 0.5) of their old size.
Text length and chunk count are checked separately and either is enough to flag — a parse that
keeps the characters but collapses 40 chunks into 1 is a retrieval regression whether or not the
markdown survived:

```
By status:
  succeeded  3
  shrunk  2

Shrink check (against data/backfill-snapshots/2026-09-22T14-23-10-299Z.json):
  3 succeeded document(s) compared; flagged below 50% of their previous size.

  These came back much smaller. Nothing was changed — open them and look:
  d-tables  Tables.pdf
    user a01a6607-610c-47c6-b396-c4fb2eb07b64
    text   10000 → 9900 chars (99% of before)
    chunks 40 → 1 (3% of before)
```

**Nothing happens automatically on a shrink.** No document is re-queued, repaired or deleted, and
`--verify` exits 0 either way. It is a list to spot-check: open the flagged documents, and if the
old parse was better the source file is still untouched on disk — re-upload it, or re-extract it at
a different tier from the Knowledge list. Documents still queued or failed are not compared at all
(they have not been rewritten), and a legacy document that had no text before the backfill can
never be flagged, because it had nothing to lose.

**It enqueues; it does not extract.** The script writes ledger rows and stops (the job engine is never
started in the script's process, so waking it from there does nothing). The running server's own
extraction worker picks the queue up on its next idle tick (5–60 s) and drains it at the
concurrency the admin Advanced page sets (`documentExtractionMaxConcurrency` /
`documentExtractionPerUserConcurrency`) — so the backfill's rate is that setting, not anything the
script chooses, and stopping it is a matter of turning the worker off, not of killing the script. A
MinerU restart part-way through cannot fail the queue wholesale either: only the handful of jobs
actually claimed at that moment spend outage time, and an outage is discounted from a document's
attempt budget (`retry-policy.ts`) rather than charged to it. The rest just wait, queued.

**Read the dry run's per-file-type line before committing the library.** Every image format
(`png`, `jpg`, `heic`, …) is `mineru`-routed, so a library with hundreds of pasted screenshots in it
books hundreds of MinerU parses that the per-route line shows only as one `mineru` count. Unknown
extensions are `mineru`-routed too, by `getIntakeRoute`'s fallback — those end as failed rows, which
costs attempts and leaves red rows in the Knowledge list, though never the document's old content.
`--user` first, or a small `--limit`, is the cheap way to find out which of these a library holds.

## Verifying a deployment

`scripts/verify-live-extraction-types.ts` uploads sample inputs through the real endpoints of a
running deployment and checks what comes back against what was recorded: the MinerU version that
answered, the app's parser version, the effective tier, the page count and its kind, the text
(including the running heads that must NOT appear), the figure count and the outline. Two groups of
inputs run: the 4.0.4 spike's `fixtures/mineru-v1/*/sample.*` (page counts, figures and outlines
are read off that server's output, so a mismatch is first a question about the expectation), and
the 4.1.7 spike's own files in `docs/plans/mineru-4-1/fixtures/inputs`, whose expectations come
from its captured answers run through the app's parser: the two-page paper (`paper`: the chart is
a figure with its caption in the text once, the display equation is fenced with `$$` and keeps its
`\tag{1}`, the footnote is a paragraph), the Hungarian-named PDF (`hu-pdf`: the name never reaches
MinerU and the normalized document keeps it), a corrupt PDF (`corrupt-pdf`: the job ends
`document_unreadable` with the app's sentence, no Retry, none of MinerU's words in it), and a TIFF
in both spellings (`tif`, `tiff`: each is sent as `document.tiff`). One case (`ofd`) is a negative
check that the upload is still refused with a 415. It is the live counterpart of
`src/lib/server/services/mineru/result.test.ts`.

```
LIVE_AI_BASE_URL=https://ai.alfydesign.com LIVE_AI_EMAIL=… LIVE_AI_PASSWORD=… \
  npx tsx scripts/verify-live-extraction-types.ts
```

| Env var | Default | Purpose |
| --- | --- | --- |
| `LIVE_AI_BASE_URL` | `https://ai.alfydesign.com` | the deployment to sweep |
| `LIVE_AI_EMAIL` / `LIVE_AI_PASSWORD` | *(required)* | the account it signs in as |
| `LIVE_AI_HEADLESS` | headless unless `false` | |
| `LIVE_AI_KEEP_CONVERSATION` | delete unless `true` | |
| `LIVE_AI_TIMEOUT_MS` | `600000` | per document; the first `standard` document after a MinerU start measured 8 to 11 s on the box |
| `LIVE_AI_OUTPUT_DIR` | `test-results/live-extraction-types-<ISO>` | where `summary.json` lands |
| `LIVE_EXTRACTION_FIXTURE_DIR` | `fixtures/mineru-v1` | where the 4.0.4 samples are |
| `LIVE_EXTRACTION_PLAN41_DIR` | `docs/plans/mineru-4-1/fixtures/inputs` | where the 4.1.7 spike's inputs are |
| `LIVE_EXTRACTION_CASES` | every case | comma-separated ids, for a narrow smoke |
| `LIVE_EXTRACTION_EXPECTED_TIER` | `standard` | the tier PDFs and images are expected to parse at |
| `LIVE_EXTRACTION_EXPECTED_SERVER_VERSION` | `4.1.7` | the MinerU version the status card must show and every document's `parse.parser_version` must carry |
| `LIVE_EXTRACTION_EXPECTED_PARSER_VERSION` | `mineru4/2` | the app's renderer version (`extractionParserVersion`) |
| `LIVE_EXTRACTION_TIER` | *(unset)* | when set, every extraction case is re-extracted at this tier and the run reports the diff |

The run stops before it uploads anything if the admin MinerU status card says the server is
unreachable (a 4.0.x server is, for this app). A different MinerU version, or a server that does
not list the expected tier, does not stop it but is written to `preflight` in `summary.json` and
fails the run: the rows mean something only for the MinerU they were written for. Set
`LIVE_EXTRACTION_EXPECTED_TIER` to the tier a differently started or pinned server tops out at, or a
correct run reads as a wall of mismatches. For every document that goes through MinerU the sweep
also holds `extractionJobTier` (the server's own `parse.tier`) to the same tier as
`extractionTier`, `extractionServerParserVersion` to the expected MinerU version, and
`extractionUnknownBlockTypes` to empty. Office, HTML, EPUB and the RTF/ODT/ODS/ODP inputs always
expect `flash` — the app names no tier for a native document and the engine parses it there no
matter what the job asked for, and catching that discrepancy is the most valuable thing this sweep
does. `csv` and `tsv` are asserted to be `direct-text` jobs (the job's own `intakeRoute`, which is
what says MinerU was never asked) that reach `succeeded`. They are not held to the statuses the poll
happens to see: the direct-text extractor reports a `parsing` phase of its own, and a poll every
1.5 s catches that phase of a job that takes a few milliseconds in some runs and misses it in others.
`heic` and `heif` are listed under `knownGaps` in the summary and not asserted: the app sends MinerU
a PNG of the photo, which `mineru/heic.integration.test.ts` runs against the 4.1 server's stand-in,
but the repo holds no HEIC photo with text in it to expect a reading of. Upload one by hand on ai.dev
to see it read.

**Not covered by this script, to do by hand on ai.dev:** a cancel (the job ends `canceled`, one
`POST /v1/tasks/{id}/cancel` in MinerU's access log), a HEIC photo of a page (the job succeeds and
its text is read), and `systemctl restart mineru41` in the middle of a job (the job has to succeed
by creating the task again; the app's journal shows `MinerU forgot an id, recovering`). And the
gate itself: it needs a MinerU backend that genuinely answers `/v1/health` with a pre-4.x version,
which this single-deployment sweep has no way to fake.
Verify it by pointing a separate deployment's (or a local dev server's) `MINERU_API_URL` at a stub
that answers `/v1/health` with `{"version":"3.9.0"}`, then confirm
`GET /api/knowledge/upload/intent` for an `.epub` answers 415 `formatNotEnabled` and the SSR
shell's accept string omits `.epub`.

The run writes `summary.json` and exits non-zero on any mismatch. It only uploads into, reads from
and deletes its own conversation, never writes configuration, and prints no credentials. Run it
from a workstation against the deployed app, not on the box.

## Upload size limits

- Uploads are capped in the app by `MAX_FILE_UPLOAD_SIZE` (default `104857600` = 100MB).
- Production builds patch adapter-node so the default `BODY_SIZE_LIMIT` becomes `100M`. Keep
  `BODY_SIZE_LIMIT` at or above the app upload cap so multipart requests are not rejected at the
  transport layer first. See [deploy/README.md](../deploy/README.md#upload-body-size).

## MinerU operations: host requirements for a custom image

Everything above describes what the Node app itself does, and the app never shells out to a host
converter to do it: there is no `spawn`/`execFile`/`child_process` call and no reference to
`libreoffice`, `ImageMagick`, `ghostscript` or `poppler-utils` anywhere in `src/` or `scripts/`
(confirmed by `git grep -nE "\bspawn|execFile|child_process|execSync" -- src/` and
`git grep -niE "soffice|libreoffice|imagemagick|ghostscript|pdftoppm|pdftotext|librsvg" -- src/
scripts/`, whose only real hit is a prompt string in `user-skills.test.ts` that mentions
"Excel/LibreOffice" by name). `MINERU_API_URL` can point anywhere, and Office/image normalization is
a requirement of **MinerU's own host**, not of this repository's host. HEIC and HEIF photos ask
nothing of that host: the app decodes them itself, in its own process, and gives MinerU a PNG (AVIF
is refused at upload).

If you build a custom MinerU image or run MinerU on a host of your own, consult MinerU's own
documentation for its host requirements (and run 4.1 or newer, see
[MinerU service](#mineru-service)). The one recipe worth keeping here, because it was
reverse-engineered against a real EL box rather than being in MinerU's own docs, is for the AlmaLinux
/RHEL ImageMagick delegate story. It predates MinerU 4.1, and this app's HEIC and HEIF uploads no
longer depend on it: neither 4.0.12 nor 4.1.7 lists those extensions among the file types it
accepts, so delegates on its host never made them work, and the app now gives MinerU a PNG of the
photo (see the task API section above). The recipe is kept as it was found:

### AlmaLinux / RHEL: ImageMagick delegate setup (HEIC/HEIF/AVIF), for MinerU's own host

If `libde265` is not available in your enabled repositories, do **not** block on that package name.
On EL systems the effective fix is to install ImageMagick + HEIF support packages, then verify
delegates are active.

```bash
sudo dnf -y install epel-release dnf-plugins-core
sudo dnf config-manager --set-enabled crb || true
sudo dnf -y makecache

# Core converters used for upload normalization
sudo dnf -y install libreoffice ImageMagick ghostscript poppler-utils librsvg2

# HEIF/AVIF support packages (names vary by repo build)
sudo dnf -y install libheif || true
sudo dnf -y install ImageMagick-heic || true

# Optional discovery when one package name is missing
dnf repoquery --available 'ImageMagick*heic*' 'libheif*' 'libde265*' | sort
```

Verify delegate support after install:

```bash
magick -version
magick -list format | egrep -i 'HEIC|HEIF|AVIF|JPEG|PNG|WEBP|TIFF|SVG|PDF'
```

Expected outcome: `HEIC`/`HEIF`/`AVIF` appear in `magick -list format`. If they do not appear, those
uploads may still store successfully, but OCR extraction/prep can fail until delegate support is
available on the MinerU host image. (This app's HEIC and HEIF uploads are not affected, since MinerU
is given a PNG of the photo.)
