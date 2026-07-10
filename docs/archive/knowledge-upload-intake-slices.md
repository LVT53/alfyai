# Deepen Knowledge Upload Intake

Source: `/private/var/folders/6c/llmb9__97ngcxtc26hvg8jzh0000gn/T/architecture-review-20260529-195600.html`, section `Deepen Knowledge Upload Intake`.

## Context

The architecture review identifies the upload path as a strong ports-and-adapters candidate. Multipart uploads currently own the complete Knowledge upload implementation in the route, while raw and chunked uploads share only a partial completion module. The target shape is one **Knowledge Upload Intake** deep module that every upload adapter calls once it has received bytes, with limits, conversation validation, source artifact persistence, normalization, Honcho sync, and prompt readiness flowing through one boundary.

Docs checked before planning:

- Context7 SvelteKit docs for `+server.ts` request handlers: endpoint functions receive a `RequestEvent`, can read `request.formData()` / `request.json()`, and return `json(...)`.
- Context7 Vitest 4 docs for ESM mocks with `vi.mock`, `vi.hoisted`, and dynamic imports where needed.
- Context7 Zod 4 docs for current validation error API; no Zod use is required unless implementation chooses schema parsing.

Repo constraints:

- Routes are adapters; durable logic belongs in server services.
- Knowledge uploads must keep the existing artifact backbone and must not introduce file versioning or dedupe.
- Direct library uploads may omit `conversationId`; when present, the upload path must validate conversation ownership before artifact insert or link writes.
- Uploaded source documents and normalized documents must keep converging on Working Document Identity and prompt readiness through the existing store/readiness boundaries.

## Done Criteria

- `src/lib/server/services/knowledge/upload-intake.ts` is the single durable Knowledge upload intake boundary.
- Multipart, raw, and chunked upload adapters call the intake boundary after receiving bytes instead of owning persistence, normalization, Honcho sync, or readiness logic.
- Shared limit calculation, upload metadata normalization, and optional conversation validation live behind the intake boundary or explicit helpers exported from it.
- Existing public response bodies, status codes, trace IDs, rename metadata, prompt readiness metadata, and Honcho fallback behavior remain compatible.
- Route-local low-level imports from knowledge store internals, Honcho sync, prompt readiness, and conversation service are removed where the intake boundary now owns them.
- Stale route tests and obsolete helper modules are removed rather than kept as compatibility shims.
- Focused tests cover the intake boundary plus adapter delegation for multipart, raw, chunked, and upload intent paths.

## Slice 1: Build Knowledge Upload Intake

Type: AFK

Blocked by: None

What to build:

Create a Knowledge Upload Intake deep module that accepts either a received browser `File` or a stored temporary upload file and completes the same durable workflow: validate optional conversation ownership, persist the uploaded source artifact, auto-rename on conflicts, create or reuse normalized text where available, sync to Honcho with native-file and normalized-text fallback behavior, resolve prompt readiness, log attachment trace output, and return the existing `KnowledgeUploadResponse` shape.

Acceptance criteria:

- Multipart and stored-file completion share one response builder for `artifact`, `normalizedArtifact`, `honcho`, `promptReady`, `promptArtifactId`, `readinessError`, and `renameInfo`.
- Conversation validation happens before artifact insert/link writes when `conversationId` is present.
- Multipart completion preserves the native `File` Honcho sync attempt before normalized fallback.
- Raw/chunked stored-file completion preserves binary hash, temp-file rename semantics, and normalized fallback sync.
- Intake tests cover prompt-ready success, unreadable extraction/readiness failure, Honcho fallback success, missing conversation rejection, and auto-rename metadata passthrough.

Suggested verification:

- `npm run test:unit -- src/lib/server/services/knowledge/upload-intake.test.ts`

## Slice 2: Thin The Upload Adapters

Type: AFK

Blocked by: Slice 1

What to build:

Convert the multipart, raw, chunked, and upload intent routes into adapters. They should keep authentication, HTTP parsing, byte receipt, raw streaming, chunk assembly, and response translation, but delegate shared upload limits, conversation validation, and durable upload completion to Knowledge Upload Intake.

Acceptance criteria:

- The multipart route no longer imports `saveUploadedArtifact`, `createNormalizedArtifact`, `resolvePromptAttachmentArtifacts`, `syncArtifactToHoncho`, or `getConversation`.
- The raw and chunked routes call the same stored-file intake entrypoint as multipart-compatible completion rather than `upload-completion.ts`.
- The upload intent route uses the shared intake limit calculation so preflight limits match the real adapter paths.
- Existing upload error codes and statuses remain compatible: body too large, file too large, aborted upload, invalid multipart, missing file, invalid conversation, raw size mismatch, chunk metadata errors, and chunk assembly failures.
- Adapter tests mock the intake boundary rather than low-level store/Honcho/conversation internals.

Suggested verification:

- `npm run test:unit -- src/routes/api/knowledge/upload/upload.test.ts src/routes/api/knowledge/upload/raw/raw-upload.test.ts src/routes/api/knowledge/upload/chunk/chunk-upload.test.ts src/routes/api/knowledge/upload/intent/upload-intent.test.ts`

## Slice 3: Remove Stale Upload Surfaces And Guard The Boundary

Type: AFK

Blocked by: Slice 2

What to build:

Remove the partial completion module and any stale tests or helper code left behind by the refactor. Add a boundary regression test that keeps upload routes on the intake module instead of drifting back into knowledge store internals, Honcho sync, prompt readiness, or route-local conversation validation.

Acceptance criteria:

- `src/lib/server/services/knowledge/upload-completion.ts` is deleted or reduced only if a temporary compatibility shim is genuinely required; prefer deletion with callers moved to `upload-intake.ts`.
- No stale route tests assert low-level implementation details that now belong to the intake module.
- A boundary test checks that upload routes import Knowledge Upload Intake and do not import `syncArtifactToHoncho`, `saveUploadedArtifact`, `saveUploadedArtifactFromStoredFile`, `createNormalizedArtifact`, `resolvePromptAttachmentArtifacts`, or `getConversation` directly.
- Repo-wide search shows one durable upload completion/readiness path.

Suggested verification:

- `rg "upload-completion|syncArtifactToHoncho|saveUploadedArtifact|resolvePromptAttachmentArtifacts|getConversation" src/routes/api/knowledge/upload src/lib/server/services/knowledge`
- `npm run test:unit -- src/lib/server/services/knowledge/upload-intake.test.ts src/lib/server/services/knowledge/obsolete-surfaces.test.ts`

## Final Verification

Run after the slices are integrated:

- `npm run check`
- `npm run test:unit -- src/lib/server/services/knowledge/upload-intake.test.ts src/lib/server/services/knowledge/obsolete-surfaces.test.ts src/routes/api/knowledge/upload/upload.test.ts src/routes/api/knowledge/upload/raw/raw-upload.test.ts src/routes/api/knowledge/upload/chunk/chunk-upload.test.ts src/routes/api/knowledge/upload/intent/upload-intent.test.ts`
- `npm run test:unit`
- `npm run build`
- Remote live testing after deployment: health check, journal inspection, authenticated Knowledge upload smoke with a small text/PDF fixture, and confirmation that prompt readiness metadata is returned without server errors.
