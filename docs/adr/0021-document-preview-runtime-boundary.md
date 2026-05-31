# Deepen Document Preview Runtime

Document preview rendering belongs in a client-side **Preview Runtime** under `src/lib/components/document-workspace/preview-runtime/`. The runtime owns preview URL loading, file-type classification, adapter-ready result shapes, PDF rendering, Office/OpenDocument conversion, text/Markdown/CSV/HTML preparation, image object URL lifecycle, zoom, pan, and the focused tests for those behaviors.

`DocumentPreviewRenderer.svelte` remains the public embedded coordinator used by `DocumentWorkspace.svelte`. It owns shell states such as loading, fetch/runtime errors, unsupported-file fallback, retry, and adapter composition, but it should not reintroduce low-level PDF.js, Mammoth, ExcelJS, JSZip, PPTXViewer, CSV parsing, HTML sanitizing, syntax highlighting, or image interaction logic.

Working Document Identity and the server-side working-document file-serving boundary remain the authority for which bytes a user is allowed to preview or download. Preview Runtime consumes those bytes after they reach the browser; it does not decide artifact identity, generated-file ownership, prompt eligibility, or canonical document family behavior.

File Production remains the producer of generated-document sources and rendered generated files. Preview Runtime may render generated-file bytes once they are served through the existing preview route, but it must not create file-production jobs, validate generated output storage, or replace source-first document rendering.

Heavy preview dependencies must stay off the idle shell path. `DocumentWorkspace.svelte` lazy-loads `DocumentPreviewRenderer.svelte`, and Preview Runtime adapters dynamically import browser-heavy libraries such as PDF.js, Mammoth, ExcelJS, JSZip, PPTXViewer, and the markdown highlighter only on the file-type paths that need them.

**Implementation Status, 2026-05-31:** implemented and live verified. `DocumentPreviewRenderer.svelte` delegates to `preview-runtime/index.ts`, `pdf/PdfPreview.svelte`, `image/ImagePreview.svelte`, `office/index.ts`, and `text/index.ts`. The old monolithic renderer tests were rewritten into focused adapter/runtime tests plus a smaller coordinator test. Verification covered focused preview runtime tests, `npm run check`, the full `npm run test:unit` suite, `npm run build`, remote deployment to `https://ai.alfydesign.com`, service health/log inspection, and a live Knowledge Document Workspace smoke test for Markdown, image, and PDF previews.

**Considered Options**

- Keep all preview rendering logic inside `DocumentPreviewRenderer.svelte`.
- Create a second document viewer for richer file types.
- Move file-type rendering into the server-side file-serving module.
- Add a focused client Preview Runtime behind the existing shared Document Workspace shell.

We chose the focused client Preview Runtime because the app already has separate authorities for document identity, file serving, and workspace state. Deepening the browser preview internals localizes file-type bugs and tests without creating a parallel viewer or mixing authorization/file-serving rules into renderer code.
