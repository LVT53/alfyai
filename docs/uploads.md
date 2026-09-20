# Uploads And Document Extraction

AlfyAI extracts text and structure from uploaded and in-chat documents through **MinerU**, a
Docker-hosted document parsing engine. Extraction is a durable background job rather than a step
inside the upload request: the ledger under
[`src/lib/server/services/extraction/`](../src/lib/server/services/extraction/) claims, retries and
resumes each document, and the MinerU client talks to the service's **V1 API**.

## MinerU service

MinerU handles PDF, DOCX, PPTX, XLSX, images, and web pages, with multi-language OCR built in. No
separate OCR service is required — MinerU handles OCR natively in all backends.

This is the one place the container command belongs:

```bash
docker run -d --name mineru -p 8001:8001 opendatalab/mineru:latest
```

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
offers only some of them. `MINERU_DEFAULT_TIER=auto` (the default) sends no tier at all and defers
to whatever the server was started with; naming a tier the server does not offer fails the
extraction with a clear "tier unavailable" rather than silently producing worse output. Office,
HTML, CSV and EPUB inputs run at `flash` regardless, because that is what the engine picks for them.

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

## Accepted file formats

Knowledge/document uploads currently accept these document and image extensions:

```
.pdf  .doc  .docx  .txt  .md  .json  .csv  .xlsx  .xls  .pptx  .ppt  .html  .htm
.jpg  .jpeg  .jfif  .png  .gif  .bmp  .tiff  .tif  .webp  .svg  .heic  .heif  .avif
```

## Upload size limits

- Uploads are capped in the app by `MAX_FILE_UPLOAD_SIZE` (default `104857600` = 100MB).
- Production builds patch adapter-node so the default `BODY_SIZE_LIMIT` becomes `100M`. Keep
  `BODY_SIZE_LIMIT` at or above the app upload cap so multipart requests are not rejected at the
  transport layer first. See [deploy/README.md](../deploy/README.md#upload-body-size).

## Host image normalization tools

On Linux/macOS, install `libreoffice` and `imagemagick` so MinerU can normalize Office and image
uploads consistently. For HEIC/HEIF/AVIF uploads specifically, verify ImageMagick delegate support on
the host (see the AlmaLinux/RHEL notes below).

### AlmaLinux / RHEL: ImageMagick delegate setup (HEIC/HEIF/AVIF)

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
available on the host image.
