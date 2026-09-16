# Uploads And Document Extraction

AlfyAI extracts text and structure from uploaded and in-chat documents through **MinerU**, a
Docker-hosted document parsing engine. The extraction service
([`src/lib/server/services/document-extraction.ts`](../src/lib/server/services/document-extraction.ts))
POSTs files to `${MINERU_API_URL}/file_parse`.

## MinerU service

MinerU handles PDF, DOCX, PPTX, XLSX, images, and web pages, with multi-language OCR built in. No
separate OCR service is required — MinerU handles OCR natively in all backends.

```bash
docker run -d --name mineru -p 8001:8001 opendatalab/mineru:latest
```

Configuration (full rows in [docs/configuration.md](configuration.md#document-extraction-mineru)):

- `MINERU_API_URL` — base URL of the MinerU service (default `http://127.0.0.1:8001`). Must be
  reachable from the app server.
- `MINERU_TIMEOUT_MS` — extraction request timeout (default `300000`). Raise it for very large
  documents.

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
