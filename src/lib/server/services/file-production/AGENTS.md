# File Production

- Chat-generated files and durable file production:
  - [`src/routes/api/chat/files/produce/+server.ts`](../../../../routes/api/chat/files/produce/+server.ts)
  - [`src/routes/api/chat/files/jobs/[id]/retry/+server.ts`](../../../../routes/api/chat/files/jobs/[id]/retry/+server.ts)
  - [`src/routes/api/chat/files/jobs/[id]/cancel/+server.ts`](../../../../routes/api/chat/files/jobs/[id]/cancel/+server.ts)
  - [`src/routes/api/chat/files/[id]/download/+server.ts`](../../../../routes/api/chat/files/[id]/download/+server.ts)
  - [`src/routes/api/chat/files/[id]/preview/+server.ts`](../../../../routes/api/chat/files/[id]/preview/+server.ts)
  - [`src/lib/server/services/chat-files.ts`](../chat-files.ts)
- [`src/lib/server/services/file-production/`](./)
  - [`index.ts`](index.ts) is the public facade; keep callers on this boundary unless they are inside file-production internals.
  - [`read-model.ts`](read-model.ts) owns read-only conversation/job card projection, legacy generated-file backfill, internally-visible job-linked file hydration without loading the worker/rendering/storage graph, and the dismissed-job filter (dismissed failed/cancelled jobs are excluded from the conversation-detail job list unless explicitly requested — see ADR 0043).
  - [`production-job.ts`](production-job.ts) is the job-engine kind ([ADR-0069](../../../../../docs/adr/0069-background-work-runs-on-one-job-engine.md), `services/jobs/`): its definition (one job at a time install-wide, the lease from the config, the words an attempt gets when it is taken back, a failure that never requeues, Retry only from a retryable failure) and the functions callers use: make a job (create, reuse under an idempotency key with the `usable` rule and the release of a key, born failed), Retry, Regenerate, Cancel, Dismiss (persisted acknowledged-flag for failed/cancelled jobs — see ADR 0043), the fork snapshot's scoped `reconcileStaleFileProductionJobs`, account erasure's `cancelActiveFileProductionForUser` and `waitForFileProductionJobVerdict` (the engine's settle event, then the card). It imports the engine and no renderer: nothing in this folder writes a job's status, claims, beats, retries, cancels or schedules but the engine.
  - [`production-runner.ts`](production-runner.ts) is the handler the engine loads on the first claim: run the persisted request, store the outputs, and settle in one fenced transaction. Cancel reaches it through `ctx.signal`, which the renderers and the sandbox already take.
  - [`job-links.ts`](job-links.ts) owns what ties a job to its reply message and to the files it made (`linkProducedFilesToJob`, inside the settling transaction; `assignFileProductionJobsToAssistantMessage`, when a turn ends). Not lifecycle.
  - [`execution-adapter.ts`](execution-adapter.ts) owns persisted request parsing plus document-source renderer or sandbox program dispatch.
  - [`storage-adapter.ts`](storage-adapter.ts) owns output validation, generated-file storage, job-file linking, source-first produced-file mapping, and post-success memory sync.
- [`src/lib/components/chat/FileProductionCard.svelte`](../../../components/chat/FileProductionCard.svelte)
- [`src/lib/components/document-workspace/DocumentWorkspace.svelte`](../../../components/document-workspace/DocumentWorkspace.svelte)
- Generated files and production job refresh:
  - [`src/lib/services/streaming.ts`](../../../services/streaming.ts) — `StreamMetadata.generatedFiles` field
  - Stream completion links new file-production jobs and any produced chat files to the persisted assistant message so job-backed cards survive refreshes
  - Conversation detail returns `fileProductionJobs` alongside `generatedFiles`; legacy chat files are backfilled into succeeded job rows by the file-production service
  - Chat page refreshes conversation detail after file-producing turns and while queued/running production jobs exist
  - [`src/routes/api/chat/files/produce/+server.ts`](../../../../routes/api/chat/files/produce/+server.ts) stays an auth/HTTP adapter; `src/lib/server/services/file-production/` owns intake parsing, validation, durable job creation/reuse, failed-job persistence, and worker wakeup
  - File-production state and execution rules stay in the deep modules behind the facade. Do not put job lifecycle transitions (they are the engine's), worker drain loops, persisted request parsing, renderer dispatch, or generated-file storage/linking back into `index.ts`, routes, renderers, or chat-file services. The tests that need a job to run call `testing/run-once.ts` (`drain` over the real modules with the sandbox, the chat-file store and the limits laid over them by `testing/runner-seams.ts`); the engine is not started in a test, so a wake only counts.
  - The Conversation Detail Read Model may import `file-production/read-model.ts` directly. General callers may use the public facade, but must not make read paths eagerly load the handler (`production-runner.ts`), renderer, sandbox, or generated-file storage modules; the read model must not import `production-job.ts`, which imports it.
  - Source-first generated-document source artifacts start as pending and non-durable, promote to durable only after rendered files attach successfully, and stay non-prompt-eligible if rendering/storage fails before attachment.
  - [`src/lib/server/sandbox/config.ts`](../../sandbox/config.ts) now ensures the sandbox runtime images exist before container creation, warms them in the background at app startup, and supports both the Python runtime (`SANDBOX_PYTHON_IMAGE`) and the JavaScript runtime (`node:22-bookworm-slim`)
  - [`src/lib/server/sandbox/config.ts`](../../sandbox/config.ts) must wait for exec inspection to report `Running === false` before the archive reader inspects `/output`; do not treat an early stream close as proof that the sandbox command has finished
  - [`src/lib/server/services/sandbox-execution.ts`](../sandbox-execution.ts) must surface output-archive read failures as explicit execution errors instead of collapsing them into the same empty-file 422 path used for real zero-output runs
  - File-production/server tracing now mainly uses `[FILE_PRODUCTION]`, `[CHAT_STREAM]`, `[CHAT_FILES]`, `[NORMAL_CHAT_CONTEXT]`, and `[MEMORY_MAINTENANCE]`; preserve those prefixes when extending the debugging path so node logs stay grep-friendly


Do:

- use `FileProductionCard.svelte` for rendering AI-generated files in chat; legacy generated files should be backfilled into succeeded file-production jobs before display
- keep generated-file downloads on the canonical `/api/chat/files/[id]/download` route; do not invent conversation-scoped download URLs
- `/api/chat/files/produce` may authenticate with either the signed-in session or a signed service assertion validated with `ALFYAI_API_SIGNING_KEY`; keep that service path conversation-scoped and internal
- keep outbound file-production guidance — the base prompt text in `src/lib/server/prompts.ts` (assembled by `normal-chat-context.ts`) and the tool's own description in `normal-chat-tools/produce-file.ts` — aligned with the unified `produce_file` tool contract: source-first documents use `document_source`, program artifacts write final files to `/output`, and generated files show up as durable job-backed cards
- keep outbound file-production guidance explicit: when the user asks for a downloadable file and the tool exists, the model should call `produce_file` rather than merely describing a file in prose
- keep generated-document source model-friendly at the boundary: normalize simple table shapes such as `headers` plus array `rows` into canonical columns/rows, and normalize simple Chart.js-style chart data into renderer-safe chart rows
- keep the app-backed AI SDK `produce_file` tool scoped by server-owned `userId`, `conversationId`, and turn idempotency; do not expose those scope fields as model-facing inputs
- keep the model-facing output-list input named `requestedOutputs`, not `outputs`, so generated-document guidance and tool schemas stay aligned
- keep `produce_file` runtime guidance accurate: use `sourceMode: "document_source"` for PDF/DOCX/HTML reports from structured document source and `sourceMode: "program"` for code-generated data/office artifacts
- generated files may offer an authenticated rich preview via `/api/chat/files/[id]/preview`; reuse the shared file viewer component instead of maintaining a second chat-only preview UI
- an HTML report carries its pictures as `data:` URIs and is previewed under `img-src data:` like every other preview (ADR-0068, RV-X M-3): `file-production/report-images.ts` fetches a report's `https` pictures at render time through the same guarded loader as the PDF's (a cap on how many and how big; a picture that cannot be had is the placeholder), `renderers/standard-report-html.ts` inlines them and never writes a remote address where a picture goes, and the header (`STANDARD_REPORT_PREVIEW_CSP`), the srcdoc meta (`TRUSTED_HTML_RUNTIME_CSP`) and the client's recogniser (`allowsTrustedHtmlPreviewRuntime`, directive by directive) agree on it. Keep the three in step, and do not let a report's renderer or its preview fetch an address
