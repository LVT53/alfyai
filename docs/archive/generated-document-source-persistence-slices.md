# Generated Document Source Persistence

Status: Implemented on 2026-05-29.

This record came from the `Restore Generated Document Source Persistence` section in `/private/var/folders/6c/llmb9__97ngcxtc26hvg8jzh0000gn/T/architecture-review-20260529-134900.html`. It follows the project glossary in `CONTEXT.md` and ADR-0005: document-like file production persists canonical **Generated Document Source** before rendering, and rendered binaries are downloadable projections linked back to that source artifact.

## Implemented Boundary

`src/lib/server/services/file-production/source-persistence.ts` is now a production deep module in the file-production boundary. It persists one canonical `generated_output` artifact from the validated **Generated Document Source**, stores the versioned source JSON in metadata, stores a deterministic readable projection in `contentText`, and attaches rendered chat-file ids after output storage.

`executeNextFileProductionJob` calls source persistence after request parsing, validation, and ownership checks and before PDF, DOCX, or HTML rendering. Invalid source still fails during request parsing or validation and creates no source artifact.

Rendered PDF, DOCX, and HTML files link back to the same source artifact through the metadata key `generatedDocumentRenderedChatFileIds`, with existing `originalChatFileId` and `sourceChatFileId` metadata preserved for read-model compatibility. `syncGeneratedFilesToMemory` uses that source artifact for source-first rendered document files instead of creating duplicate binary-extraction `generated_output` artifacts. Program-mode and legacy generated files keep the existing extraction and version path.

## Done Criteria

- [x] Document-source file-production jobs create one durable `generated_output` artifact from canonical `Generated Document Source`.
- [x] The source artifact stores versioned source JSON in metadata and a deterministic readable projection in `contentText`.
- [x] Every rendered file from that document-source job links back to the source artifact through generated-file metadata and read models.
- [x] Memory/Honcho sync for source-first document jobs prefers the canonical source artifact and does not create duplicate binary-extraction generated-output artifacts for the same rendered files.
- [x] Program-mode file production and legacy generated-file backfill stay unchanged.
- [x] Tests prove the production worker uses the source-persistence path, links produced files to the artifact, and avoids stale duplicate generated-output memory artifacts.
- [x] `CONTEXT.md`, ADR-0005, and the architecture review HTML reflect the implemented boundary.

## Vertical Slices

### 1. Persist Source Artifact During Document Production

Type: AFK
Status: Done

What changed:
When a `document_source` job passes request validation and ownership checks, persist the canonical source artifact through `source-persistence.ts` before PDF, DOCX, or HTML rendering begins, then carry its id through the produced-file mapping after storage.

Acceptance criteria:

- [x] `executeNextFileProductionJob` calls source persistence for `document_source` jobs before rendering and before returned produced files are mapped.
- [x] The persisted artifact metadata includes job id, origin conversation, assistant message, source version, source JSON, and generated-document family metadata.
- [x] Invalid source still fails before renderer/runtime work and does not create a source artifact.

Verification:

- Covered by focused file-production tests, including `src/lib/server/services/file-production/index.test.ts`.

### 2. Link Rendered Files Back To Source Artifact

Type: AFK
Status: Done

What changed:
Rendered PDF/DOCX/HTML outputs from the same document-source job should all report the same source artifact in file-production read models and chat-file read models.

Acceptance criteria:

- [x] Existing generated-file metadata lookup can resolve `artifactId` for rendered files from the source artifact.
- [x] Produced file objects returned by `executeNextFileProductionJob` include `artifactId`, document family metadata, origin ids, and `sourceChatFileId`.
- [x] Multi-output document-source jobs link all rendered files to the same source artifact through `generatedDocumentRenderedChatFileIds`.

Verification:

- Covered by `src/lib/server/services/file-production/index.test.ts` and `src/lib/server/services/chat-files.test.ts`.

### 3. Keep Source-First Memory Sync Single-Sourced

Type: AFK
Status: Done

What changed:
When file production already persisted a source artifact for a document-source job, background memory sync should use that artifact as the durable context source instead of creating one binary-extraction generated-output artifact per rendered file.

Acceptance criteria:

- [x] Source-first document jobs do not create duplicate generated-output artifacts from rendered binaries during `syncGeneratedFilesToMemory`.
- [x] Program-mode generated files still sync through the existing extraction/version path.
- [x] Honcho fallback sync can use the canonical source artifact text when binary upload is not useful or unavailable.

Verification:

- Covered by `src/lib/server/services/chat-files.test.ts`.

### 4. Clean Up Stale Surfaces And Document The Boundary

Type: AFK
Status: Done

What changed:
The stale binary-first document-source interpretation has been retired in the docs. Future edits should treat source persistence as the authority and rendered files as projections.

Acceptance criteria:

- [x] No detached source-persistence path remains; `source-persistence.ts` is production code in the file-production boundary.
- [x] Source-first document-source production starts from canonical source persistence, not rendered binaries as canonical truth.
- [x] `CONTEXT.md` defines the deep module and relationship between source artifact, rendered files, and memory sync.
- [x] ADR-0005 states that document-like file production persists the source artifact and uses rendered binaries as downloadable projections.
- [x] The architecture review HTML marks this section finished and records verification evidence.

Verification:

- Local verification already completed by the implementation pass: `npm run check` passed with the existing tsconfig warning.
- Focused tests passed: `npm run test:unit -- src/lib/server/services/file-production/index.test.ts src/lib/server/services/chat-files.test.ts` with 54 tests.
- The full unit suite passed earlier with 281 files, 2346 passing, and 1 skipped.
- A scoped Biome linter run with formatter/assist disabled on changed files found no errors, only existing `node:` import infos in `chat-files.ts`.
- This docs-only follow-up verified stale wording with scoped `rg` over the edited docs and architecture review HTML.
