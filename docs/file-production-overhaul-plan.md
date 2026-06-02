# File Production Overhaul Plan

This plan implements ADR 0005 in small production slices. Each slice must be independently testable and verifiable, keep the app usable, include fallback/observability appropriate to its scope, and remove the specific old behavior it replaces.

Old generated-file UI and old Langflow generation tools are migration inputs, not product surfaces to preserve. When legacy data can be converted into the new job model, the UI should display it through the new job-backed cards instead of keeping a parallel generated-file-card path. Once the unified file-production tool/node and endpoint are ready, remove and disable the obsolete `generate_file` and `export_document` tools/routes rather than keeping compatibility shims.

## Implementation Ownership Map

The server-side file-production boundary should live under `src/lib/server/services/file-production/` rather than as one large service file.

Suggested modules:

- `index.ts`: public facade.
- `store.ts`: job, attempt, and produced-file-link persistence.
- `types.ts`: server-side service types.
- `limits.ts`: effective limits and validation helpers.
- `errors.ts`: error-code taxonomy and retryability.
- `worker.ts`: scheduler, wakeups, claim/drain loop, heartbeat ownership.
- `executor.ts`: dispatch between document-source and program mode.
- `source-schema.ts`: generated-document source schema.
- `source-normalizer.ts`: source normalization and readable projection generation.
- `renderers/`: PDF, DOCX, HTML, and chart rendering.
- `renderers/charts/`: deterministic generated-document chart rendering, separate from browser analytics/UI chart code.
- `security.ts`: image, URL, output-type, preview/download validation helpers.

Client ownership:

- `src/lib/client/api/file-production.ts`: reusable browser fetch logic such as `listFileProductionJobs`, `retryFileProductionJob`, and `cancelFileProductionJob`.
- Chat page: polling lifecycle, job state, and route-level orchestration.
- `FileProductionCard.svelte`: presentational job card that emits retry/cancel/open/download callbacks and does not fetch directly.

Generated-document source schema ownership:

- Keep full generated-document source TypeScript types and validators server-side in v1.
- Expose only the file-production job read model needed by the browser: status, stage, warnings, produced files, retryability, display metadata, and safe diagnostics.
- Do not expose full `documentSource` JSON to the client by default in v1.

Output storage ownership:

- Keep produced-file bytes and download/preview storage on the existing `chatGeneratedFiles` / `chat-files.ts` backbone.
- File production owns job lifecycle, attempts, and job-to-file links around that storage.
- Do not replace the produced-file storage table as part of v1.
- Treat the old `chat_generated_files` table name as implementation-internal even as user-facing language shifts to produced files/file-production jobs.

## Cross-Cutting V1 Security Contract

Treat generated-document source as untrusted structured data even when it comes from the model. AlfyAI renderers own HTML, PDF, DOCX, and SVG generation; model/user text is content, not executable layout or markup.

Rules:

- Do not support raw HTML blocks in v1 generated-document source.
- Escape text fields by default in all renderer adapters.
- Validate and normalize URLs, images, chart labels, table cells, captions, alt text, headings, and code blocks before rendering.
- Fetch image sources only through server-controlled validation/fetch paths.
- Allow v1 image sources only from `https` URLs, internal artifact/generated-file references, and size-limited `data:image/...;base64` URIs.
- Reject `http`, `file`, localhost/private IPs, link-local IPs, non-image MIME types, oversized images, and redirects whose final target is not allowed.
- Revalidate every redirect target before fetching image bytes.
- Apply fetch timeout and byte cap before image decode.
- Treat the readable text/Markdown projection as retrieval/debug material, not as trusted renderer input.
- Generate HTML output through AlfyAI renderers; do not accept complete model-authored HTML as source.
- Serve generated HTML previews defensively with a restrictive Content Security Policy.
- Do not allow inline scripts or external scripts in generated HTML previews.
- If generated HTML is embedded in the app, use sandboxed iframe attributes.
- Validate produced-file bytes, stored MIME type, filename extension, and renderer/program-declared output type before serving downloads or previews where practical.
- Refuse preview for unsupported or mismatched content instead of trying to render it.
- Use sanitized `Content-Disposition` for downloads.
- Keep program/sandbox mode network-disabled by default, even for trusted users.
- Pass needed input files/images into program mode only through validated internal artifact/generated-file references.
- Do not let generated program code become a second web/image fetching subsystem.

Verification:

- Injection tests for headings, paragraphs, captions, table cells, image alt text, code blocks, and chart labels.
- Renderer tests proving generated HTML/PDF/DOCX/SVG escapes model/user text by default.
- Tests proving raw HTML source blocks are rejected in v1.
- HTML preview tests proving injected script and event-handler strings do not execute.
- Tests proving generated HTML preview responses use a restrictive CSP.
- Tests proving embedded generated HTML previews use sandboxed iframe attributes.
- Download/preview tests proving stored MIME/extension/output-type mismatches are rejected where practical.
- Tests proving PDFs, ZIP-based Office files, images, HTML/text outputs, and unsupported binaries receive safe headers and preview behavior.
- Image-source validation tests for allowed internal references, `https` URLs, and size-limited data URIs.
- Image-source rejection tests for `http`, `file`, localhost/private IPs, link-local IPs, non-image MIME types, oversized images, and disallowed redirect targets.
- Sandbox tests proving program mode has no outbound network access by default.
- Tests proving program-mode file/image inputs must come through validated internal references.

## Cross-Cutting V1 Resource Limits

V1 should define explicit server-side file-production limits with localized error codes/messages and compact technical diagnostics. The initial defaults can be generous because the platform is for a small trusted user set, but expensive dimensions still need named limits so failures are predictable, testable, and observable.

Limit categories:

- Max requested outputs per job: default `5`.
- Max generated-document source JSON size: default `2 MB`.
- Max readable projection size: default `1 MB`.
- Max PDF pages: default `250`.
- Max table rows and columns: default `10,000` rows and `50` columns.
- Max chart data points and series: default `20,000` points and `50` series.
- Max image count and image byte size: default `50` images, `25 MB` each after fetch/decode, and `200 MB` total image bytes.
- Max sandbox/program runtime: default `5 minutes`.
- Max renderer runtime: default `5 minutes`.
- Max stored output file size: default `100 MB`.
- Max total output bytes per job: default `250 MB`.

Limit error codes:

- `too_many_outputs`
- `source_too_large`
- `projection_too_large`
- `page_limit_exceeded`
- `table_limit_exceeded`
- `chart_limit_exceeded`
- `image_limit_exceeded`
- `renderer_timeout`
- `sandbox_timeout`
- `output_file_too_large`
- `job_outputs_too_large`

Behavior:

- Validate limits before renderer/runtime work whenever the value is knowable up front.
- Treat defaults as configurable server values, not hard-coded product constants.
- Read effective limits through the existing runtime config/admin settings path (`src/lib/server/config-store.ts`), not direct environment-variable reads.
- When a limit is only knowable during or after rendering, fail the attempt with a persisted non-retryable limit error.
- Delete or discard partial outputs before storing/linking them when a during/post-render limit fails.
- Persist limit violations as failed jobs with localized user-safe error codes/messages.
- Disable retry for static limit violations unless the source/request changes.
- Treat `renderer_timeout` and `sandbox_timeout` as retryable by default.
- Treat static size/count/page/table/chart/image/output limit violations as non-retryable unless the source/request changes.
- Store the stable `errorCode` on the job/attempt and keep measured details such as `{ limit, actual, unit }` in attempt diagnostics.
- Keep `renderer_timeout` and `sandbox_timeout` as distinct error classes even when their defaults match; renderer timeouts belong to source/template/render work, while sandbox timeouts belong to user/programmatic generation work.
- Map error codes to English and Hungarian UI messages; do not render raw technical diagnostics as primary card text.
- Log the technical limit name, effective configured limit, measured value, job id, and attempt id under `[FILE_PRODUCTION]`.
- Persist the effective limit values used for any limit failure in attempt diagnostics.

Verification:

- Validation tests for each limit category.
- Tests proving every limit failure uses one of the stable limit error codes.
- Tests proving renderer and sandbox timeout failures use distinct error codes and diagnostics.
- Config tests proving file-production services use runtime config defaults/overrides for limits.
- Tests proving static limit failures do not enter renderer/runtime work.
- Tests proving static limit failures are not retryable without changed input.
- Tests proving timeout failures are retryable by default while static limit failures are not.
- Tests proving during/post-render limit failures discard partial outputs and do not create produced-file links.
- Tests proving during/post-render limit failures persist measured values and configured limits in attempt diagnostics.
- i18n tests proving limit errors exist in English and Hungarian.

## Template Acceptance Fixtures

Create generated-document source fixtures before redesigning the default PDF/document template. Fixtures should be source JSON, not Markdown, and should act as visual/regression targets for PDF, DOCX, and HTML renderers.

Before implementing template CSS/rendering details, create a named default template spec. The default v1 template is **AlfyAI Standard Report**, replacing the old "Terracotta Crown" concept as the product-facing/default template name. The template should be restrained and work-focused without looking like a plain unstyled word processor document: use nuanced off-white/neutral surfaces, black/gray text, subtle rules/backgrounds, clear information hierarchy, and terracotta as a controlled accent. Avoid decorative gradients, orbs, large brand marks, and both bare white/black defaults and brochure-like decoration. Use A4 portrait as the primary v1 PDF page format; US Letter or alternate formats can be future/configurable options. Use the bundled app typography set for PDF, DOCX, and HTML presentation: Nimbus Sans L for operational/body content and Libre Baskerville for restrained title/cover accents where useful. Do not depend on host-installed fonts for the primary PDF path, and do not silently fall back when bundled app fonts are missing; that is a packaging error. Body paragraphs should be left-aligned rather than justified to avoid awkward spacing in generated and Hungarian text. Headers should be minimal and metadata-focused rather than centered brand strips; use subtle document/section context and keep AlfyAI branding quiet, likely cover/footer-only. The spec defines the intended document types, page size/margins, typography scale, header/footer behavior, cover-page rules, table styling and pagination behavior, chart styling, image/caption behavior, callout styles, color tokens, accessibility expectations, and intentionally unsupported template features.

Initial **AlfyAI Standard Report** defaults:

- Page: A4 portrait; margins around `22mm` top, `18mm` outer, `20mm` bottom, and `18mm` inner; content width optimized for dense reports rather than brochure whitespace; avoid full-page background color unless the renderer supports it reliably.
- Typography: Nimbus Sans L primary font for body, tables, charts, captions, headers, footers, and report structure; Libre Baskerville only for restrained document title or cover accents; body `10.5-11pt` with roughly `1.45` line-height; H1 `22-24pt`, H2 `15-16pt`, H3 `12.5-13.5pt`; captions/metadata `8.5-9pt`; no negative letter spacing.
- Color: near-black primary text, warm gray secondary text, terracotta as a sparse accent; chart palette should include terracotta, slate, teal, olive, amber, violet-gray, and blue-gray so documents are not one-note terracotta.
- Header/footer: header uses small document title or current section on the left and date/status/version on the right; footer uses page number, generated timestamp, and optional quiet AlfyAI mark/text; no centered logo strip.
- Cover: optional, not automatic; use for reports, brochures, and formal deliverables, skip for quick exports; include title, subtitle, author/source, date, optional short summary, and small AlfyAI identity only.
- Sections: H2 sections get subtle top spacing and a thin accent rule; avoid page breaks immediately after headings; support explicit `pageBreak`.
- Tables: dense and readable with repeated PDF header rows, right-aligned numeric columns, compact dates, very subtle zebra striping, wrapping long text, and no silent truncation or clipping.
- Charts: SVG-first, flat document style with minimal gridlines; require title, caption, units, and alt text; use direct labels where practical and legends only when needed; remain distinguishable in grayscale.
- Images: centered figures with captions, no heavy shadows, small radius up to `4px`; critical image failure fails the job, nonessential image failure renders a clear placeholder and warning.
- Callouts: `info`, `warning`, `tip`, and `note`; left accent bar plus very light tinted background; icons optional only if they render consistently across PDF, DOCX, and HTML; labels localized.
- Code: monospace on a light neutral background; preserve indentation; wrap or fit safely; avoid unbreakable giant blocks.
- Unsupported in v1: arbitrary CSS/HTML, absolute positioning, merged/nested tables, multi-column magazine layout, floating text around images, custom fonts per document, and user-controlled brand themes.

Initial fixtures:

- Short report: cover, summary, headings, callout.
- Long report: many sections and page breaks.
- Table-heavy report: wide table, long table, numeric/date formatting.
- Chart-heavy report: all v1 chart types.
- Image report: captions, critical/nonessential image behavior.
- Technical note: code blocks, lists, quotes.
- Hungarian report: accents, long words, and localized generated labels.

Negative fixtures:

- Raw HTML block attempt.
- Script/event-handler injection in labels, captions, headings, and table cells.
- Disallowed image URL and disallowed redirect target.
- Oversized table, chart, and image cases.
- Unsupported chart type.
- Merged/nested table attempt.
- Output type mismatch for preview/download tests.

Verification:

- Structural assertions for every fixture and output format.
- PDF screenshot/metadata checks for template layout regressions.
- Print-budget checks for minimum body font size, page margins, header/footer overlap, table clipping, orphaned headings, nearby captions, and long-word overflow.
- DOCX/HTML structural checks where exact visual comparison would be brittle.
- Fixture coverage proving tables, charts, images, code, callouts, page breaks, and Hungarian text all render acceptably.
- Negative-fixture coverage proving validation/security failures are persisted with stable error codes and localized messages.

## Slice 1: Durable Job Spine, No Behavior Change

Add the durable file-production job read model without changing current file generation behavior.

Schema shape:

- `file_production_jobs`: stable job identity and current state.
- `file_production_job_attempts`: retry history, stage, renderer/runtime, `workerId`, claim/heartbeat timing, timings, error code/message, and compact diagnostics.
- `file_production_job_files`: ordered links from jobs to produced `chat_generated_files` records.

Job status:

- `queued`
- `running`
- `succeeded`
- `failed`
- `cancelled`

Use a separate `stage` field for blocking progress such as `normalizing_source`, `rendering_pdf`, `assembling_outputs`, `validating_outputs`, or `storing_outputs`.

Job success means requested files are rendered, stored, and usable. Context enrichment, extraction, embeddings, and Honcho sync run after success through existing asynchronous rails and must not keep a downloadable file in a generating state.

File production execution is durable background work. Chat streaming may create or announce a job, but the SSE connection must not own rendering completion. Cards recover and update from persisted job state after refresh, reconnect, polling, or conversation reload.

Use an in-process durable file-production worker for v1, backed by SQLite job claims and heartbeats. Do not add Redis, BullMQ, a separate worker service, or another queue system in v1. The database job state remains the source of truth so the same contract can support a separate worker process later if needed.

Default v1 worker concurrency is one active file-production job per process. Claim jobs FIFO by `created_at` from eligible `queued` jobs. Keep the concurrency cap configurable for later, but v1 tests should assume the default of `1`. Cancelled jobs leave the eligible queue immediately.

Start the in-process worker scheduler from the existing server bootstrap/maintenance path, initialize it once per process, and use lazy wakeups instead of a tight always-on polling loop. Creating or retrying a job wakes the worker; maintenance can also wake it after stale-attempt recovery. The worker drains eligible jobs up to the concurrency cap, then idles. Shutdown stops new claims and lets heartbeat recovery handle interrupted attempts.

On app startup, run stale-attempt recovery and then wake the worker once so already-queued jobs can drain even if no new file-production request arrives.

Each worker process owns a generated `workerId`. Claiming a job creates a new attempt with `workerId`, `claimedAt`, and `heartbeatAt`. Heartbeats and finalization must match the current attempt id and claiming worker id. If stale recovery, cancellation, or retry has already moved the job forward, late renderer/runtime results from an old attempt are ignored and logged.

In v1, active job cards update through lightweight polling while any visible job is `queued` or `running`. Do not add a dedicated file-production SSE channel unless a later slice needs richer live progress.

Recover stale `running` attempts by heartbeat timeout. If a worker claim stops heartbeating beyond the configured timeout, maintenance marks the attempt failed with a retryable infrastructure error and returns the job to a failed/retryable state so the card cannot stay stuck forever.

Do not automatically retry failed jobs in v1. Validation, render, runtime, and heartbeat-timeout failures move the job to `failed`; retryable failures show a user-visible retry action. Explicit user retry creates a new attempt under the same job identity.

Scope:

- Add durable `file_production_jobs` persistence.
- Add durable attempt history.
- Include the job/attempt fields needed for background execution, recovery, and stale-running detection.
- Add SQLite-backed worker claim/release helpers for the in-process v1 worker.
- Claim the oldest eligible queued job first and enforce one active job per process by default.
- Store `workerId`, `claimedAt`, and `heartbeatAt` on running attempts and require attempt/worker ownership checks for heartbeat and finalization.
- Add worker scheduler startup, lazy wakeup, drain-to-idle, and shutdown behavior.
- Wake the worker once after startup stale-attempt recovery so persisted queued jobs resume after restart.
- Add the service/maintenance path that detects stale running attempts and persists retryable infrastructure failures.
- Keep failed jobs terminal until explicit user retry; do not schedule automatic retry attempts in v1.
- Add produced-file links from jobs to existing `chat_generated_files` records.
- Add service functions to create, update, and list jobs.
- Include recent/active jobs in a new additive `fileProductionJobs` conversation-detail field.
- Support lightweight listing/polling of active jobs through the same durable read model.
- Return an empty job list when no jobs have been written.
- Keep `generatedFiles` unchanged in Slice 1.
- Do not write job rows from `generate_file` or `export_document` yet.
- Preserve current `generate_file`, `export_document`, generated-file card, download, preview, MinerU extraction, Honcho sync, and context-selection behavior.

Verification:

- Unit tests for job create/update/list and produced-file linking.
- Unit tests for DB-safe job claiming, heartbeat updates, and claim release/finalization.
- Unit tests proving FIFO claim order, default single-job concurrency, and cancelled-job exclusion from claims.
- Unit tests proving only the claiming worker/current attempt can heartbeat or finalize, and late stale-attempt results cannot overwrite newer job state.
- Tests proving job creation/retry wakes the worker, the worker drains queued jobs then idles, and shutdown stops new claims.
- Tests proving startup stale-attempt recovery wakes the worker and drains already-queued jobs.
- Route/load test proving conversation detail can return persisted jobs.
- Tests proving persisted running jobs can be listed and recovered independently of any active chat stream.
- Tests proving active jobs can be refreshed through polling and polling stops when no visible jobs remain active.
- Tests proving stale running attempts are failed by heartbeat timeout and become retryable instead of remaining permanently running.
- Tests proving failed jobs are not automatically retried and explicit retry creates a new attempt under the same job.
- Regression test proving current generated files still appear exactly as before.
- Migration/prepare-db verification for the new schema.

## Slice 2: Convert Legacy Files Into Job-Backed Cards

Backfill existing generated files into durable succeeded jobs where possible, then render generated output through the new job-backed card surface.

Scope:

- Add `fileProductionJobs` to client types and chat page state.
- Backfill existing `chat_generated_files` into succeeded `file_production_jobs` with produced-file links.
- Preserve assistant-message association where available.
- Add a new job-native card component, likely `FileProductionCard.svelte`, for persisted file-production jobs.
- Render job-backed cards for backfilled and native jobs through the new component.
- Remove generated-file-card rendering as a parallel UI path once backfilled jobs cover legacy files.
- Replace `GeneratedFile.svelte` as the primary generated-output chat surface instead of evolving it into a job component.
- Remove stream-only generated-file placeholder behavior once persisted job-backed cards are available.
- Group multiple outputs from one job under one card.
- Show persisted `queued`, `running`, `succeeded`, `failed`, and `cancelled` states after refresh/reconnect.
- Poll for job updates only while visible jobs are `queued` or `running`; stop polling when all visible jobs are terminal.
- Show short localized user-safe failure messages and compact details.
- Add a user-visible retry action for failed jobs that reuses the same job identity and records a new attempt.
- Add a user-visible cancel action for queued/running jobs as best-effort cancellation, persisting `cancelled` even if renderer/runtime cleanup finishes afterward.
- Keep open/preview/download behavior on produced files.
- Do not introduce new production behavior, source-first production, unified tool behavior, or workspace/downloader redesign in this slice.

Verification:

- Backfill tests prove existing generated files become succeeded jobs without duplicate job/file links.
- Component tests for each persisted job status.
- Component tests for multi-output grouped cards.
- Component tests proving the new job card handles zero-file active jobs, one-file succeeded jobs, and multi-file succeeded jobs.
- Component tests for localized visible labels using existing i18n keys.
- Component/page tests proving active-job polling starts and stops correctly.
- Component and route/service tests for retrying failed jobs under the same job identity with added attempt history.
- Component and route/service tests for cancelling queued/running jobs and preserving the persisted `cancelled` state after refresh.
- Route/page tests proving refresh/reloaded conversation data renders jobs.
- Regression tests proving legacy generated files render through job cards after conversion.

## Slice 3: Unified File-Production Endpoint And Langflow Node

Introduce the new production path and remove the obsolete model-facing generation tools instead of wrapping or shimming them. Split this into smaller slices, but enforce one rule: once model guidance points at the new tool, the old tools must no longer be available to the model.

### Slice 3a: Unified Endpoint Behind Tests

Add the unified endpoint and service path without exposing it to the model yet.

Scope:

- Add the unified file-production endpoint backed by the file-production service.
- Use `POST /api/chat/files/produce` as the unified production endpoint.
- Have the endpoint create/return a durable job and schedule background execution instead of making the request or chat stream wait for rendering.
- Keep job listing in conversation detail for now; add a dedicated job-list endpoint only if a later slice needs it.
- Support document-source mode for document-like outputs and program mode for genuinely programmatic/raw outputs.
- Validate and normalize file-production input before entering renderer/runtime work.
- Persist validation failures as durable failed jobs with localized user-safe error codes/messages.
- Support retry and best-effort cancellation through the file-production service, not route-local state.
- Preserve durable job lifecycle, attempts, produced-file links, idempotency, localized user-safe errors, and compact `[FILE_PRODUCTION]` observability.
- Carry enough origin information on the job to associate produced files with the eventual assistant message without relying on "new files since stream start" heuristics.

Verification:

- New endpoint tests for document-source success, program-mode success, persisted validation failures, idempotency, and produced-file linking.
- Service/endpoint tests for retry and cancel lifecycle transitions.
- Tests proving job execution can complete after the originating request/stream is gone.
- End-to-end service test proving the unified endpoint creates a durable job-backed produced file.

### Slice 3b: AI SDK Tool And Model Guidance

Expose only the unified tool to the model.

Scope:

- Add or update the app-backed AI SDK tool named `produce_file`.
- Expose the model-facing tool method as `produce_file`.
- Use a compact structured tool input contract with `idempotencyKey`, `requestTitle`, `requestedOutputs`, `sourceMode`, `documentIntent`, optional high-level `templateHint`, `documentSource`, and optional sandbox `program`.
- Resolve `conversationId` from server-owned chat turn context rather than exposing it as a normal model-facing input.
- Support `sourceMode: "document_source"` for document-like outputs and `sourceMode: "program"` for genuinely programmatic/raw outputs.
- Treat model-provided `documentIntent` as a hint; keep server-side file/document classification authoritative.
- Keep template selection server-owned; map any model-provided `templateHint` to supported templates or the default.
- Remove the old `generate_file` and `export_document` tool guidance.
- Remove obsolete AI model guidance for `generate_file`, `export_document`, direct PDF helper usage, and split toolkit selection.
- Replace model guidance with the unified file-production workflow and server-owned renderer/source-first rules.
- Ensure old and new tools are not simultaneously valid model-facing tools.

Verification:

- AI SDK tool contract tests or static validation proving the exposed tool is the unified production method.
- Prompt/guidance tests proving obsolete tool names and old PDF-generation instructions are absent.
- End-to-end smoke test proving a model file request creates a durable job-backed card and downloadable output through the new path.

### Slice 3c: Remove Obsolete Routes, Tests, And Agent Docs

Remove old generation surfaces and stale instructions.

Scope:

- Remove obsolete `/api/chat/files/generate` and `/api/chat/files/export` routes if no remaining internal caller needs them.
- Keep stable produced-file access routes such as `/api/chat/files/[id]/download` and `/api/chat/files/[id]/preview`.
- Remove `sandbox-helpers/create-pdf.js` from the active sandbox runtime path once source-first PDF rendering is live.
- Remove model guidance that suggests programmatic PDF generation through sandbox helpers; PDF should route through generated-document source renderers.
- Rename signed internal service assertion helpers/docs from file-generate vocabulary to file-production vocabulary.
- Scope service assertions to the unified `POST /api/chat/files/produce` endpoint and keep them conversation-scoped.
- Remove old `/api/chat/files/generate` and `/api/chat/files/export` auth allowlist entries once the routes are removed.
- Remove chat-page and stream-consumer placeholder detection for obsolete `generate_file` and `export_document` tool names.
- Remove stream-completion generated-file discovery based on obsolete tool-name detection and before/after file comparisons.
- Associate produced files to assistant messages through durable file-production job origin/link state, including jobs that finish after the stream closes.
- Replace file-production UI updates with persisted `fileProductionJobs` rendering and active-job polling.
- Remove obsolete route/tool tests and replace any remaining coverage with unified endpoint/node contract tests.
- Update AGENTS files, README/setup notes, and other agent-facing docs so no guidance points at obsolete routes, tools, prompts, or file-generation contracts.
- Remove or rewrite local prompt notes such as `local/IMPROVED_PROMPT_ONLY.md` and `local/IMPROVED_SYSTEM_PROMPT.md` so they no longer teach `generate_file` / `export_document`.
- Update log-prefix documentation to include `[FILE_PRODUCTION]` and remove old model-facing generation vocabulary.

Verification:

- Repository-wide search proves obsolete model-facing tool names and old route guidance are gone outside historical migration notes.
- Repository-wide search proves chat UI no longer creates temporary file cards by matching `generate_file` or `export_document` stream events.
- Repository-wide search proves active model/runtime guidance no longer points at `create-pdf.js` or programmatic PDF helpers.
- Tests prove produced files can be linked to the assistant message through job state when rendering completes after stream completion.
- Documentation checks prove AGENTS/README references to old generation tools are removed or explicitly historical.
- Documentation checks prove local prompt notes no longer present obsolete generation/export guidance.
- Tests prove service assertions work for `/api/chat/files/produce` and no obsolete generation/export route remains allowlisted.
- Full targeted test set for unified endpoint, job-backed cards, and generated-file download/preview passes.

## Slice 4: Source-First PDF And Document Production

Make document-like file production source-first on the unified path.

Scope:

- Define the normalized generated-document source schema.
- Validate and normalize generated-document source before creating a `running` render/runtime attempt.
- Persist malformed source as a failed file-production job with localized validation detail instead of entering renderer/runtime work.
- Use a constrained semantic block vocabulary for v1: `section`, `heading`, `paragraph`, `list`, `table`, `image`, `chart`, `callout`, `quote`, `code`, `divider`, and `pageBreak`.
- Accept model-friendly source aliases at the boundary where they are unambiguous, such as table `headers` plus array `rows` and simple Chart.js-style chart data, then normalize them into the canonical renderer schema.
- Treat tables as a first-class production block with captions, header rows, column alignment, number/date formatting, repeated headers across PDF page breaks, and safe pagination.
- Exclude merged cells and nested tables from v1 unless a later slice explicitly designs and tests them.
- Keep arbitrary HTML, CSS, absolute positioning, and PDF drawing commands out of generated-document source.
- Map unsupported layout wishes into template-safe options where possible, otherwise persist validation warnings.
- Support constrained image blocks in generated-document source.
- Require image sources to be server-resolvable and validated, such as existing artifact ids, generated file ids, vetted image-search URLs fetched by the server, or size-limited data URIs.
- Treat content-critical image failures as fatal job errors.
- Allow nonessential image failures to render visible placeholders and persist job warnings.
- Persist the canonical generated-document source as versioned JSON in existing `generated_output` artifact metadata.
- Store a deterministic readable text/Markdown projection in `generated_output.contentText` for Context Selection, embeddings, Honcho sync, search, and human diagnostics.
- Treat the versioned JSON source as the renderer/rerenderer input; treat the readable projection as retrieval/context material, not as the canonical render source.
- Render PDF and other document-like outputs from source via server-owned renderers/templates.
- Support `pdf`, `docx`, and `html` as v1 rendered document outputs from the same generated-document source, with PDF treated as the primary reliability target.
- Keep `xlsx` and `csv` in generated-file program/data production mode rather than treating them as rendered document outputs.
- Link rendered files to the source artifact and file-production job.
- Make Context Selection prefer source content when it exists.
- Keep MinerU extraction as fallback readability for binaries, not the canonical source for source-first documents.

Verification:

- Source schema validation tests.
- Tests proving malformed source fails fast as a persisted failed job before renderer/runtime execution.
- Source schema tests proving only supported block types and template-safe options are accepted.
- Table rendering tests for captions, headers, alignment, number/date formatting, repeated PDF headers, and pagination.
- Table validation tests proving merged cells and nested tables are rejected in v1.
- Image-block validation tests for allowed and rejected source types.
- Image failure tests for fatal critical images and warning placeholders for nonessential images.
- Renderer tests for PDF/document output from source.
- Renderer tests proving `pdf`, `docx`, and `html` outputs can be produced from the same source.
- Tests proving `xlsx` and `csv` requests route through generated-file program/data production rather than document rendering.
- Tests proving generated-document source is persisted as versioned JSON in artifact metadata.
- Tests proving `generated_output.contentText` contains the deterministic readable projection used by retrieval/context paths.
- Tests proving renderers consume the canonical JSON source instead of reparsing the readable projection.
- Tests proving rendered binaries link back to the source artifact/job.
- Context-selection tests proving source content is preferred over extracted binary text when present.

## Slice 5: First-Class Chart Blocks

Add reliable chart support to generated-document source as a dedicated production slice.

Scope:

- Add chart blocks to the generated-document source schema.
- Support the v1 chart set: bar, stacked bar, line, area, scatter, pie, and donut.
- Define chart data schema, labels, units, captions, and accessibility/alt text requirements.
- Render charts through a small server-owned SVG renderer with deterministic styling that matches generated-document templates.
- Do not add Vega-Lite for v1.
- Do not use Chart.js for server-side document rendering; keep Chart.js for browser/UI charts where it already belongs.
- Treat chart SVG as the canonical chart render artifact, rasterizing only when an output format requires it.
- Support chart rendering in PDF/document outputs and preview where applicable.
- Persist chart source as part of `generated_output.contentText` / metadata so charts can be refined and rerendered.
- Persist chart warnings/errors separately from fatal job errors.

Verification:

- Schema validation tests for each supported chart type.
- Renderer tests for deterministic chart output.
- Tests proving SVG is generated from chart source and raster fallback is used only when required.
- Visual or structural regression tests for generated PDF/chart output.
- Accessibility tests for required labels/captions/alt text.
- Failure tests for malformed chart data and unsupported chart types.
