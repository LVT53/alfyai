# Deepen Document Preview Rendering Slices

These are local `$to-issues` tracer-bullet slices for the architecture-review recommendation **Deepen Document Preview Rendering**. They are not published tracker issues.

The review recommendation is to keep the shared **Document Workspace** shell, but deepen the rich-preview internals by file type. Today `DocumentPreviewRenderer.svelte` owns preview fetch, loading state, file-type dispatch, PDF rendering, Office conversions, text/Markdown/CSV/HTML sanitization, image inspection, and most preview styling. The target boundary is a **Preview Runtime** module set that owns file-type loading and rendering while `DocumentPreviewRenderer.svelte` becomes the coordinator/composition surface used by `DocumentWorkspace.svelte`.

**Implementation Status, 2026-05-31:** DPR-01 through DPR-05 are implemented and live verified. The implementation added `src/lib/components/document-workspace/preview-runtime/` with a base runtime contract, PDF and image Svelte adapters, and Office/Text adapter helpers. `DocumentPreviewRenderer.svelte` is now the embedded coordinator that owns shell/loading/error state and adapter composition. Focused runtime tests and the slim coordinator test passed, followed by `npm run check`, the full `npm run test:unit` suite, `npm run build`, remote deployment to `https://ai.alfydesign.com`, and a live Knowledge Document Workspace smoke test covering Markdown, image, and PDF previews with no browser console/page errors and clean post-smoke service logs.

## Evidence And Constraints

- Review HTML source: `/private/var/folders/6c/llmb9__97ngcxtc26hvg8jzh0000gn/T/architecture-review-20260529-195600.html`
- Review section: `Deepen Document Preview Rendering`
- Problem statement: one UI module owns fetch, render, sanitize, zoom, and every file-type implementation.
- Target files called out by the review: `src/lib/components/document-workspace/DocumentPreviewRenderer.svelte`, `src/lib/components/document-workspace/DocumentWorkspace.svelte`, `src/lib/client/document-preview-prewarm.ts`, and `src/lib/server/services/knowledge/store/working-document-file-serving.ts`.
- Current state: `DocumentWorkspace.svelte` already lazy-loads `DocumentPreviewRenderer.svelte`, `document-preview-prewarm.ts` already provides best-effort preview byte prewarming, and `working-document-file-serving.ts` already owns server-side preview/download resolution. This slice should not reopen those boundaries unless integration bugs require it.
- Repo boundary: **Document Workspace** remains route-driven and shared by Chat, Knowledge, attachments, generated files, and search handoffs. Do not add a second viewer or modal path.
- Repo boundary: keep heavy preview dependencies off the idle shell path. File-type adapters should use dynamic imports for PDF.js, Mammoth, ExcelJS, JSZip, PPTXViewer, markdown highlighting, and any other browser-heavy path.
- Repo boundary: use Svelte 5 runes and callback props in touched Svelte files; do not introduce legacy event dispatch or `on:` directives.
- Context7 evidence: Svelte 5 recommends `$props()`, local `$state`, callback props, and native dynamic components; SvelteKit recommends `browser` checks or `onMount`/dynamic imports for browser-only libraries; Vitest 4 supports jsdom and module mocks for focused helper/component tests.
- Manual docs evidence: PDF.js documents `getDocument(...).promise`, page `getViewport`, HiDPI canvas sizing, and avoiding concurrent renders on one canvas; Mammoth supports browser conversion via `{ arrayBuffer }`; DOMPurify remains the sanitizer for preview HTML.
- Live verification evidence: `6ad2c916` was deployed to the `alfydesign` host on 2026-05-31, `langflow-chat.service` restarted active on port 3001, `/api/health` returned `{"status":"OK"}`, and Playwright verified Markdown, image, and PDF preview adapters through the Knowledge page with zero console/page errors.

## Done Criteria

- [x] A client-side **Preview Runtime** boundary exists under the document-workspace component area and owns preview loading, file-type dispatch, and adapter result shapes.
- [x] PDF rendering state and operations move out of `DocumentPreviewRenderer.svelte` into a PDF-focused module/component without losing page tracking, zoom, pan, pinch, render cancellation, or page binding behavior.
- [x] Office/text/image/HTML preview transforms move into focused modules or components with stable sanitized output and smaller tests.
- [x] `DocumentPreviewRenderer.svelte` remains the public embedded preview coordinator used by `DocumentWorkspace.svelte`; it should handle shell states, toolbar composition, and adapter selection, not low-level file parsing.
- [x] Existing user-visible preview behavior stays stable for PDF, DOCX, XLSX, PPTX, ODT, CSV, Markdown, HTML, image, source-style text/code, unsupported files, loading, retry, and download fallback.
- [x] Stale tests that only preserve the previous monolithic implementation are removed or rewritten as runtime/adapter/component tests.
- [x] Stale unused modules, comments, and dead code left by the extraction are removed.
- [x] `CONTEXT.md`, related ADRs, and the review HTML document explain the **Preview Runtime** boundary so future edits do not collapse it back into `DocumentPreviewRenderer.svelte`.

## Slices

### DPR-01. Introduce The Preview Runtime Contract

**Type:** AFK

**Blocked by:** None - can start immediately

**User stories covered:** As a maintainer, I need one typed contract that loads preview bytes, classifies the file, and returns the correct adapter-ready state without every renderer knowing fetch and MIME fallback details.

**What to build:** Add a focused preview runtime module for URL resolution, preview fetch, binary/text sniffing, type correction, and adapter result shapes. Move the current fetch/classification/reset logic out of `DocumentPreviewRenderer.svelte` without changing the public component props.

**Acceptance criteria**

- [x] Preview URL resolution still supports explicit `previewUrl` and `/api/knowledge/[artifactId]/preview`.
- [x] Generic or missing MIME types still fall back to filename/type sniffing.
- [x] Text-selected previews still detect PDF magic and PPTX ZIP signatures before dispatch.
- [x] Loading, 404, fetch failure, unsupported, and retry behavior remain compatible.
- [x] Focused tests cover the runtime contract without rendering the full Svelte component.

**Verification**

- [x] `npm run test:unit -- src/lib/components/document-workspace/preview-runtime`
- [x] `npm run test:unit -- src/lib/components/document-workspace/DocumentPreviewRenderer.test.ts`

### DPR-02. Extract The PDF Preview Adapter

**Type:** AFK

**Blocked by:** DPR-01

**User stories covered:** As a user reading PDFs, I need the same paged PDF preview, zoom, pan, keyboard scroll, pinch zoom, page tracking, and render-cancellation behavior after the renderer is deepened.

**What to build:** Move PDF.js loading, worker URL caching, document loading, page rendering, render task cancellation, canvas ref management, page observer setup, and PDF-specific controls into a PDF-focused runtime/component pair. `DocumentPreviewRenderer.svelte` should pass the loaded blob and page bindings into that adapter.

**Acceptance criteria**

- [x] PDF.js remains dynamically imported and browser-only.
- [x] Canvas render sizing still respects `window.devicePixelRatio`.
- [x] Rapid zoom/file changes cancel active render tasks and do not reuse a canvas concurrently.
- [x] Current-page and total-page bindings still update `DocumentWorkspace.svelte`.
- [x] Keyboard, wheel, pointer pan, and touch pinch behaviors remain covered.

**Verification**

- [x] `npm run test:unit -- src/lib/components/document-workspace/preview-runtime/pdf`
- [x] `npm run test:unit -- src/lib/components/document-workspace/DocumentPreviewRenderer.test.ts`

### DPR-03. Extract Office And Text Preview Adapters

**Type:** AFK

**Blocked by:** DPR-01

**User stories covered:** As a user previewing Word, spreadsheet, slide, OpenDocument, CSV, Markdown, HTML, or source text files, I need the same readable previews while each file type has its own testable adapter.

**What to build:** Move DOCX, XLSX, PPTX, ODT, CSV, Markdown, text highlighting, and sandboxed HTML preparation into focused adapter modules. Keep sanitizer and escaping responsibility explicit in the adapter layer, and keep heavy libraries dynamically imported.

**Acceptance criteria**

- [x] DOCX uses Mammoth with browser `{ arrayBuffer }` input and sanitized rendered HTML.
- [x] XLSX preserves workbook/sheet/table rendering and cell formatting.
- [x] PPTX still renders slide images, slide count, and toolbar navigation.
- [x] ODT text/table/list fallback remains readable and escaped.
- [x] Markdown renders as a reading document, CSV renders as a table, source text/code uses highlighted text, and HTML renders through a static sandboxed `srcdoc`.
- [x] Adapter tests cover escaping/sanitization and representative success/failure paths without relying only on the full component test.

**Verification**

- [x] `npm run test:unit -- src/lib/components/document-workspace/preview-runtime/office src/lib/components/document-workspace/preview-runtime/text`
- [x] `npm run test:unit -- src/lib/components/document-workspace/DocumentPreviewRenderer.test.ts`

### DPR-04. Extract Image Preview Interaction

**Type:** AFK

**Blocked by:** DPR-01

**User stories covered:** As a user inspecting images, I need zoom, fit, wheel zoom, and pan to keep working while image object URL lifecycle is isolated from the coordinator.

**What to build:** Move image object URL lifecycle and image-specific zoom/pan interaction into a focused component or runtime module. Keep toolbar composition consistent with the existing preview toolbar.

**Acceptance criteria**

- [x] Object URLs are revoked on file changes and unmount.
- [x] Image zoom clamps remain compatible and reset pan when zoom returns to fit.
- [x] Wheel and pointer-pan behavior remains covered.
- [x] The image adapter does not own document workspace selection or close behavior.

**Verification**

- [x] `npm run test:unit -- src/lib/components/document-workspace/preview-runtime/image`
- [x] `npm run test:unit -- src/lib/components/document-workspace/DocumentPreviewRenderer.test.ts`

### DPR-05. Compose, Clean Up, And Document The Boundary

**Type:** AFK

**Blocked by:** DPR-02 through DPR-04

**User stories covered:** As a future maintainer, I need the Preview Runtime boundary documented and the old monolithic implementation cleaned up so preview bugs localize to the right adapter.

**What to build:** Reduce `DocumentPreviewRenderer.svelte` to shell state and adapter composition, delete stale tests or helpers made obsolete by the extraction, and update local architectural docs. Assess the review HTML section against implementation evidence and mark it finished only when all criteria above pass.

**Acceptance criteria**

- [x] `DocumentPreviewRenderer.svelte` no longer contains low-level PDF, Office, text, HTML, CSV, ODT, PPTX, or image parsing/rendering internals.
- [x] Tests are organized around the runtime/adapters plus a smaller coordinator contract; old TDD scratch files, stale tests, and unused modules are removed.
- [x] `CONTEXT.md` defines **Preview Runtime** and its relationship to **Document Workspace**, **Working Document Identity**, preview prewarm, and server-side file serving.
- [x] A related ADR records that Preview Runtime owns client-side file-type rendering while Working Document Identity/file serving owns which bytes are served.
- [x] The architecture review HTML marks `Deepen Document Preview Rendering` as finished and includes implementation status plus verification evidence.
- [x] Local and live verification pass.

**Verification**

- [x] `npm run check`
- [x] `npm run test:unit`
- [x] Focused preview tests for runtime/adapters
- [x] Live deploy and smoke test focused on Knowledge/Chat Document Workspace preview behavior
