# Move File Production Intake Behind The Module

Source: `/private/var/folders/6c/llmb9__97ngcxtc26hvg8jzh0000gn/T/architecture-review-20260529-134900.html`, section `Move File Production Intake Behind The Module`.

## Context

The current `/api/chat/files/produce` route adapter owns file-production intake semantics: request parsing, source-mode normalization, document-source validation, failed durable job persistence, owner resolution, static limit handling, job reuse, and worker wakeup. ADR-0005 says file production should be owned by the dedicated file-production boundary, with routes acting as adapters.

Docs checked before planning:

- Context7 SvelteKit docs for `+server.ts` request handlers: route handlers parse `event.request.json()` and return `json(...)`.
- Context7 Vitest 4 docs for ESM module mocks and `vi.mocked` patterns.
- Context7 Drizzle docs for SQLite insert/select/update service patterns and `.returning()` support.

## Done Criteria

- The produce route keeps only HTTP-body parsing, auth/owner resolution, and response translation.
- A file-production intake module owns request normalization, validation, failed-job persistence, static limits, idempotent job creation/reuse, and worker wakeup.
- Durable failed-job behavior remains unchanged for source validation and static limit failures.
- Existing public response shapes and status codes remain compatible.
- Route-local intake helper functions are removed instead of left as unused code.
- Focused tests cover the new module boundary and route adapter delegation.

## Slice 1: Deepen File Production Intake

Type: AFK

Blocked by: None

What to build:

Move the complete `produce_file` intake workflow into the file-production service boundary. The new module should accept a parsed JSON body and resolved owner identity, normalize model-friendly request fields, validate document-source/program source modes, persist durable failed jobs for validation and static-limit failures, create or reuse valid jobs, and wake the worker only for queued/running accepted jobs.

Acceptance criteria:

- A new file-production intake entrypoint returns a small discriminated result suitable for HTTP translation.
- Program mode preserves accepted Python/JavaScript behavior and `outputs` / `requestedOutputs` compatibility.
- Document-source mode preserves model-friendly normalization from `source-schema.ts`.
- Invalid source-mode, invalid program, malformed document-source, and static-limit failures with enough draft identity create failed jobs exactly once through the service boundary.
- Static limit failures still log with `[FILE_PRODUCTION] Static limit failed`.
- Idempotent valid and failed jobs still reuse existing rows by user/conversation/idempotency key.

Suggested verification:

- Focused service tests for accepted program/document-source requests, validation failures, static limit failures, and reuse.
- `npm run test:unit -- src/lib/server/services/file-production/index.test.ts`

## Slice 2: Thin The Produce Route Adapter

Type: AFK

Blocked by: Slice 1

What to build:

Replace route-local intake helpers with a call into the service intake entrypoint. Keep route concerns limited to JSON parsing, signed-in or service-assertion ownership resolution, and translating the service result into the existing JSON response statuses.

Acceptance criteria:

- `src/routes/api/chat/files/produce/+server.ts` no longer imports `limits.ts`, `source-schema.ts`, or job creation functions directly.
- The route still returns `400` for unreadable JSON, `401` for unauthenticated/invalid service assertions, `404` for missing conversations, `422` for validation/static-limit failures, and `202` for accepted jobs.
- Existing service assertion compatibility remains conversation-scoped.
- Route tests mock the intake boundary instead of mocking low-level job creation and validation internals.

Suggested verification:

- Focused route tests for JSON parse failure, auth failure, missing conversation, service assertion success, intake failure translation, and intake success translation.
- `npm run test:unit -- src/routes/api/chat/files/produce/produce.test.ts`

## Slice 3: Remove Stale Intake Surfaces And Guard The Boundary

Type: AFK

Blocked by: Slice 2

What to build:

Clean up obsolete route-local test assumptions and unused imports/modules left behind by the refactor. Add a boundary regression check that prevents the produce route from reaching back into file-production internals for source validation or static limits.

Acceptance criteria:

- No unused route-local intake helpers remain.
- No stale tests assert low-level implementation details from the route layer.
- A boundary test or existing obsolete-surface test verifies the produce route depends on the file-production intake entrypoint rather than `limits.ts`, `source-schema.ts`, `createFailedFileProductionJob`, or `createOrReuseFileProductionJob`.
- Repo-wide search shows no duplicated `produce_file` intake parser outside the file-production boundary.

Suggested verification:

- `rg "validateProgramRequest|extractFailureDraft|validateFileProductionStaticLimits|validateGeneratedDocumentSource" src/routes/api/chat/files/produce src/lib/server/services/file-production`
- `npm run test:unit -- src/routes/api/chat/files/produce/produce.test.ts src/lib/server/services/file-production/index.test.ts src/lib/server/services/file-production/obsolete-surfaces.test.ts`

## Final Verification

Run after the slices are integrated:

- `npm run check`
- `npm run lint`
- `npm run test:unit`
- `npm run build`
- File-production live smoke via `LIVE_AI_BASE_URL=https://ai.alfydesign.com npx tsx scripts/verify-live-file-production-types.ts` after deployment, unless a narrower live smoke is chosen for safety.
