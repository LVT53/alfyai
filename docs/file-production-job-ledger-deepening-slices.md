# Deepen File Production Around The Job Ledger

Source: `/private/var/folders/6c/llmb9__97ngcxtc26hvg8jzh0000gn/T/architecture-review-20260529-134900.html`, section `Deepen File Production Around The Job Ledger`.

## Context

ADR-0005 requires one user-facing File Production capability while keeping renderers, sandbox execution, generated-file storage, and Context Selection as separate boundaries. The current production system already has durable job tables, retry/cancel routes, generated-document source persistence, static/output limits, and a thin `/api/chat/files/produce` route. The remaining architecture debt is that `src/lib/server/services/file-production/index.ts` still owns too many unrelated responsibilities in one large facade file.

Docs checked before planning:

- Context7 SvelteKit docs for `+server.ts` request handlers: route handlers parse request bodies and return `json(...)` responses.
- Context7 Vitest 4.1.6 docs for ESM module mocks, `vi.mock`, `vi.fn`, and `vi.mocked`.
- Context7 Drizzle ORM docs for SQLite-style insert/select/update service patterns and typed rows.

## Done Criteria

- `index.ts` stays the public File Production facade, but no longer contains the ledger, execution runner, renderer dispatch, storage-linking, and listing/backfill implementations inline.
- A Job Ledger deep module owns job rows, attempt rows, claim/heartbeat/finalization, stale recovery, retry, cancellation, produced-file links, and job read-model mapping.
- A Worker Runner module owns worker identity, initialization, wakeup/drain-to-idle, and step execution orchestration.
- A Renderer Adapter module owns parsing persisted requests and dispatching between document-source renderers and sandbox program execution.
- A Generated File Storage Adapter module owns produced-file storage/linking, source-artifact file mapping, and post-success memory sync.
- Existing public exports, route behavior, job lifecycle semantics, and UI read models remain compatible.
- Focused tests guard the new boundaries and existing file-production behavior.
- Stale tests or obsolete helper modules left behind by the refactor are removed rather than kept as distracting migration artifacts.

## Implementation Status

Finished locally on 2026-05-29.

- `job-ledger.ts` now owns durable job/attempt state transitions, retry/cancel, stale recovery, produced-file links, legacy backfill, and job read-model mapping.
- `worker-runner.ts` now owns worker identity, initialization, wakeup/drain lifecycle, and current-attempt orchestration.
- `execution-adapter.ts` now owns persisted request parsing plus document-source renderer or sandbox program dispatch.
- `storage-adapter.ts` now owns output validation, program output contract validation, generated-file storage, job-file linking, source-first produced-file mapping, and post-success memory sync.
- `index.ts` remains the public facade and delegates to the deep modules.
- Boundary regression coverage lives in `obsolete-surfaces.test.ts`; no stale TDD scratch files or obsolete helper modules were left behind by this refactor.

Local verification:

- `npm run check`: passed with the existing Svelte config warning and 0 errors.
- `npm run test:unit`: passed, 283 files, 2369 passing, 1 skipped.
- `npm run build`: passed.
- `npx biome check` on touched file-production files: passed.
- `npm run lint`: still fails on pre-existing repository-wide Biome diagnostics outside this change.

## Slice 1: Extract The Job Ledger

Type: AFK

Blocked by: None

What to build:

Move durable job state rules out of the facade into a dedicated Job Ledger module. The ledger should own create/reuse/failed job writes, row-to-read-model mapping, claims, heartbeats, attempt failure/completion, stale recovery, retry, cancellation, produced-file links, assistant-message assignment, and conversation job listing including legacy generated-file backfill.

Acceptance criteria:

- `index.ts` re-exports the same public ledger functions but delegates them to the Job Ledger module.
- Claiming still enforces one active running job per process and FIFO queued-job selection.
- Heartbeat, failure, completion, and stale recovery still require current attempt and worker ownership.
- Retry and cancellation semantics remain unchanged.
- Conversation listing still includes legacy generated-file jobs and filters empty succeeded jobs as before.
- Existing tests for create/reuse, failed jobs, claims, stale recovery, retry/cancel, listing, and assignment pass without broad rewrites.
- New or updated boundary tests make it clear that state transition truth lives in the Job Ledger module.

Suggested verification:

- `npm run test:unit -- src/lib/server/services/file-production/index.test.ts src/lib/server/services/file-production/obsolete-surfaces.test.ts`

## Slice 2: Extract Worker Runner And Execution Adapter

Type: AFK

Blocked by: Slice 1

What to build:

Move worker scheduler state and per-job execution orchestration out of the facade. The Worker Runner owns `DEFAULT_WORKER_ID`, one-time initialization, lazy wakeup, drain-to-idle, stale-attempt recovery on startup, and the step loop. A Renderer Adapter parses the persisted job request and dispatches to either the document-source renderers or sandbox program execution, returning untrusted produced-file candidates plus mode-specific diagnostics.

Acceptance criteria:

- Public functions `executeNextFileProductionJob`, `drainFileProductionWorker`, `wakeFileProductionWorker`, and `ensureFileProductionWorker` keep their existing behavior and signatures.
- The worker runner depends on ledger operations rather than direct table updates.
- Persisted request parsing and renderer/sandbox dispatch are isolated from job-state writes.
- Document-source rendering still persists the Generated Document Source before rendering and supports PDF, DOCX, and HTML outputs.
- Program mode still uses the sandbox execution boundary and preserves Python/JavaScript behavior.
- Renderer errors, sandbox thrown errors, program failures, missing outputs, and invalid persisted requests still fail the current attempt with the same stable error codes.

Suggested verification:

- `npm run test:unit -- src/lib/server/services/file-production/index.test.ts src/lib/server/services/file-production/renderers/standard-report-pdf.test.ts src/lib/server/services/file-production/renderers/standard-report-docx.test.ts src/lib/server/services/file-production/renderers/standard-report-html.test.ts`

## Slice 3: Extract Generated File Storage Adapter And Cleanup Stale Surfaces

Type: AFK

Blocked by: Slice 2

What to build:

Move output limit validation, program output contract validation, produced-file storage, job-file linking, generated-document source file mapping, and post-success memory sync into an adapter behind the worker runner. Then remove obsolete inline helpers, stale tests, unused imports, and any migration-only modules that no longer have a caller.

Acceptance criteria:

- Output limit failures still discard partial outputs before storage/linking and persist measured diagnostics.
- Program output contract failures still use the same stable error codes and retryability.
- Stored files still link to `file_production_job_files` in requested order.
- Source-first document outputs still map produced card files to the canonical Generated Document Source artifact.
- Post-success generated-file memory sync still runs after job success and logs `[FILE_PRODUCTION]` errors without failing completed jobs.
- Repo search shows no duplicate ledger transition code, no duplicate persisted-request parser, and no generated-file storage/linking logic left in `index.ts`.
- Stale TDD scratch files, obsolete tests, and unused modules/imports introduced by this refactor are removed.

Suggested verification:

- `rg "parseFileProductionJobRequest|linkProducedFileToJob|completeFileProductionJobAttempt|DEFAULT_WORKER_ID|workerInitialized|drainPromise" src/lib/server/services/file-production/index.ts`
- `npm run test:unit -- src/lib/server/services/file-production/index.test.ts src/lib/server/services/file-production/output-validation.test.ts src/lib/server/services/file-production/obsolete-surfaces.test.ts`

## Final Verification

Run after the slices are integrated:

- `npm run check`
- `npm run test:unit`
- `npm run build`
- `LIVE_AI_BASE_URL=https://ai.alfydesign.com npx tsx scripts/verify-live-file-production-types.ts` after deployment.
