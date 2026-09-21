# Uploads And Document Extraction

AlfyAI extracts text and structure from uploaded and in-chat documents through **MinerU**, a
Docker-hosted document parsing engine. Extraction is a durable background job rather than a step
inside the upload request: the ledger under
[`src/lib/server/services/extraction/`](../src/lib/server/services/extraction/) claims, retries and
resumes each document, and the MinerU client talks to the service's **V1 API** — there is no MinerU
3.x fallback and no second protocol; a server that does not answer `GET /v1/health` fails clearly
rather than degrading.

## MinerU service

MinerU handles PDF, DOCX, PPTX, XLSX, images, and web pages, with multi-language OCR built in. No
separate OCR service is required — MinerU handles OCR natively in all backends.

This is the one place the container command belongs. **Pin the tag to a 4.x release.** This app
speaks the V1 API only, so a `:latest` that resolves to a 3.x image does not fail loudly — it
answers `GET /v1/health` with a 404, the availability gate closes, and five formats quietly
disappear from the file picker:

```bash
docker run -d --name mineru -p 8001:8001 opendatalab/mineru:4.0.4 --api-key "$MINERU_API_KEY"
```

Drop `--api-key` only on a host where nothing else can reach the port; `MINERU_API_KEY` must match
whatever the container was started with.

#### The dev box's MinerU (development only)

A MinerU 4.0.4 server runs on the dev box at `http://127.0.0.1:8003` — basic tier, CPU only, API key
required. It exists so a local checkout can point `MINERU_API_URL`/`MINERU_API_KEY` at a real
MinerU 4 without standing up a container. It is **not** a production endpoint: it is CPU-only, it
serves one tier, and its port deliberately differs from the `8001` default so a deployment cannot
drift onto it by accident.

### The V1 endpoints the app uses

| Method | Path | Used for |
|---|---|---|
| GET | `/v1/health` | version, `features.output_formats`, `features.sources`. Public even under `--api-key`, which is what the tool-health probe uses |
| GET | `/v1/tiers` | the quality tiers this server actually offers |
| GET | `/v1/usage` | file-size and page limits, shown on the admin status card |
| POST | `/v1/uploads` | create an upload; a known SHA-256 dedupes instantly |
| PUT | `/v1/uploads/{id}/content` | stream the bytes |
| POST | `/v1/uploads/{id}/complete` | finalise; a wrong hash surfaces here, not at the PUT |
| POST | `/v1/parse/jobs` | submit the parse |
| GET | `/v1/parse/jobs/{id}` | poll to a terminal status |
| DELETE | `/v1/parse/jobs/{id}` | cancel |
| GET | `/v1/files/{id}/content` | download the result archive |

### Quality tiers

MinerU exposes up to four tiers — `flash`, `basic`, `standard`, `advanced` — and a given server
offers only some of them. `MINERU_DEFAULT_TIER=auto` (the default) means "do not force a tier for
this deployment"; it does not mean no tier is ever sent. Two rules still send one explicitly, both
ahead of the configured value: a registry entry carrying `tierHint: "flash"` (every Office, HTML,
RTF and EPUB format) is submitted at `flash` whenever the server lists that tier, and on a server
that offers **only** `flash` every input is submitted at `flash` — including PDFs and images, which
would otherwise have taken the server's own default. Naming a tier the server does not offer fails
the extraction with a clear "tier unavailable" rather than silently producing worse output; a
`tierHint` the server does not offer simply falls through.

**Settings → System → Integrations & keys** shows a MinerU status card: the version that answered,
the tiers and output formats it reports, its size and page limits, and an explicit "unreachable"
with a reason when it is down.

### Configuration

Full rows in [docs/configuration.md](configuration.md#document-extraction-mineru). The twelve keys
are `MINERU_API_URL`, `MINERU_API_KEY`, `MINERU_DEFAULT_TIER`, `MINERU_OCR_MODE`,
`MINERU_JOB_TIMEOUT_MS`, `MINERU_POLL_MIN_MS`, `MINERU_POLL_MAX_MS`, `MINERU_REQUEST_TIMEOUT_MS`,
`MINERU_TRANSFER_TIMEOUT_MS`, `MINERU_CAPABILITIES_TTL_MS`, `MINERU_BUNDLE_MAX_BYTES` and
`MINERU_STRUCTURE_CHUNKING_ENABLED`. All twelve are editable live on the admin screen and apply on
the next extraction — no restart.

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

- **`mineru`** — sent to the MinerU V1 API described above (PDF, Office formats, raster images
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
`MAX_FILE_UPLOAD_SIZE` and MinerU's own size limit — unless the MinerU-4 gate above has fallen them
back to `direct-text` on an old backend, in which case the cap applies to them again.

## The async extraction flow

An upload returns as soon as the bytes are stored; a durable ledger
(`document_extraction_jobs`, [`src/lib/server/services/extraction/`](../src/lib/server/services/extraction/))
then claims the job, runs it, and persists the result, so a process restart resumes rather than
restarts. The route decision above (`mineru` vs. `direct-text` vs. `reject`) is read once, at
enqueue time, from the shared registry (adjusted for the MinerU-4 gate); nothing downstream
re-derives it.

A `mineru`-routed job's own protocol lives entirely in
[`src/lib/server/services/mineru/`](../src/lib/server/services/mineru/): `POST /v1/uploads`
(sha256-deduplicated) → `PUT` the bytes → `POST /v1/uploads/{id}/complete` → `POST /v1/parse/jobs` →
poll `GET /v1/parse/jobs/{id}` → download the result zip from `GET /v1/files/{id}/content`. The zip
yields the prompt Markdown plus a **parse bundle** on disk at
`data/knowledge/<userId>/<sourceArtifactId>.parse/` (page index, structured content, figures). A
`direct-text` job skips all of this and reads the file once, in-process.

A terminal remote job is never resumed: any attempt that finds one failed, canceled, or carrying a
file-level error clears the stored handle, so the next attempt (automatic or a user Retry) submits a
fresh `POST /v1/parse/jobs` rather than re-polling a job that cannot change its answer — the
re-upload costs nothing because `POST /v1/uploads` deduplicates on sha256. On top of that, an
upstream failure saying the document itself cannot be loaded (MinerU's "Failed to load document
(PDFium: …)" family, covering damaged, zero-page and password-protected files, plus the
`file_corrupted` / `file_encrypted` codes) maps to `document_unreadable`, which is neither
auto-retried nor user-retryable: the same bytes cannot become readable, and a repaired file has a
different hash and so arrives as a new document. An unexplained `parse_failed` still maps to
`job_failed` and keeps its small attempt budget.

Parse bundles are derived data — they can always be regenerated by re-extracting the source document
— and are excluded from the account data archive
([`account-data-archive/`](../src/lib/server/services/account-data-archive/)), which ships only the
originally uploaded bytes and the normalized readable text. Half-written uploads under `.incoming`
are excluded for the same reason — they are not the user's data yet. Both exclusions are named and
tested in `src/lib/server/services/account-data-archive/index.ts`.

Knowledge upload intake is a dedicated boundary
([ADR 0024](adr/0024-knowledge-upload-intake-boundary.md)).

## Verifying a deployment

`scripts/verify-live-extraction-types.ts` uploads the `fixtures/mineru-v1/*/sample.*` inputs
through the real endpoints of a running deployment and checks what comes back against what the
Phase 0 spike (and, for the formats it never covered, this phase's own live run) recorded: the
effective tier, the page count and its kind, the text (including the running heads that must NOT
appear), the figure count and the outline. One case (`ofd`) is a negative check that the upload is
still refused with a 415. It is the live counterpart of
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
| `LIVE_AI_TIMEOUT_MS` | `600000` | per document; a cold `standard` PDF is unmeasured |
| `LIVE_AI_OUTPUT_DIR` | `test-results/live-extraction-types-<ISO>` | where `summary.json` lands |
| `LIVE_EXTRACTION_FIXTURE_DIR` | `fixtures/mineru-v1` | |
| `LIVE_EXTRACTION_CASES` | every case | comma-separated ids, for a narrow smoke |
| `LIVE_EXTRACTION_EXPECTED_TIER` | `basic` | the tier PDFs and images are expected to parse at |
| `LIVE_EXTRACTION_TIER` | *(unset)* | when set, every extraction case is re-extracted at this tier and the run reports the diff |

Set `LIVE_EXTRACTION_EXPECTED_TIER` to whatever the server was started with, or a correct run reads
as a wall of mismatches. Office, HTML, CSV, EPUB and the newly added RTF/ODT/ODS/ODP inputs always
expect `flash` — the engine parses them there no matter what the job asked for, and catching that
discrepancy is the most valuable thing this sweep does. `tsv` is asserted to reach `succeeded`
**without** ever passing through a `parsing` status — it is `direct-text`, so it should never reach
MinerU at all.

**Not covered by this script:** the gate itself needs a MinerU backend that genuinely answers
`/v1/health` with a pre-4.x version, which this single-deployment sweep has no way to fake. Verify it
by pointing a separate deployment's (or a local dev server's) `MINERU_API_URL` at a stub that answers
`/v1/health` with `{"version":"3.9.0"}`, then confirm `GET /api/knowledge/upload/intent` for an
`.epub` answers 415 `formatNotEnabled` and the SSR shell's accept string omits `.epub`.

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
"Excel/LibreOffice" by name). `MINERU_API_URL` can point anywhere, and Office/image normalization —
including HEIC/HEIF/AVIF delegate support — is a requirement of **MinerU's own container**, not of
this repository's host.

If you build a custom MinerU image or run MinerU outside the published Docker image, consult MinerU's
own documentation for its host requirements. The one recipe worth keeping here, because it was
reverse-engineered against a real EL box rather than being in MinerU's own docs, is for the AlmaLinux
/RHEL ImageMagick delegate story:

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
available on the MinerU host image.
