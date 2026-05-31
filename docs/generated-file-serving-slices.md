# Deepen Generated File Serving Slices

These are local `$to-issues` tracer-bullet slices for the architecture-review recommendation **Deepen Generated File Serving**. They are not published tracker issues.

The review recommendation is to stop making chat preview, chat download, and Working Document serving each own generated-file lookup, ownership fallback, byte validation, MIME resolution, and response header policy. The target boundary is one server-side **Generated File Serving** deep module that returns validated bytes plus mode-specific headers for preview and download adapters.

**Implementation Status, 2026-05-31:** Finished. `src/lib/server/services/generated-file-serving.ts` now owns the shared generated-file serving contract, chat preview/download routes delegate to it, and Working Document generated-output `sourceChatFileId` serving delegates to it with `displayFilename`. Live verification exposed the expected pre-finalization state where a succeeded File Production Job exposes an unassigned generated file; the boundary now permits that narrow succeeded job-linked case while keeping unattached staging files quarantined.

## Evidence And Constraints

- Review HTML source: `/private/var/folders/6c/llmb9__97ngcxtc26hvg8jzh0000gn/T/architecture-review-20260529-195600.html`
- Review section: `Deepen Generated File Serving`
- Problem statement: preview, download, and Working Document serving repeat generated-file lookup, ownership fallback, byte validation, and headers.
- Target files called out by the review: `src/routes/api/chat/files/[id]/preview/+server.ts`, `src/routes/api/chat/files/[id]/download/+server.ts`, `src/lib/server/services/knowledge/store/working-document-file-serving.ts`, and `src/lib/components/document-workspace/DocumentPreviewRenderer.svelte`.
- Previous state: chat preview and download routes duplicated generated-file lookup, unassigned-file quarantine, output validation, content reading, MIME fallback, and disposition/cache headers. Working Document serving duplicated generated-output source chat-file validation and response headers for `sourceChatFileId`.
- Current state: `resolveGeneratedFileServing(...)` centralizes generated-file lookup, conversation-owner fallback, eligibility checks for assigned files and succeeded job-linked unassigned files, type/byte validation, MIME fallback, and preview/download header policy. Chat routes and Working Document generated-output serving are adapters over that module.
- Repo boundary: routes are adapters. Generated-file serving rules belong in a server service, not in route-local closures.
- Repo boundary: Working Document Identity decides which artifact or source chat file is eligible for preview/file serving; the Generated File Serving module serves validated Generated File bytes once given the chat-file identity and user.
- Repo boundary: Preview Runtime consumes served bytes in the browser; it must not own authorization, ownership fallback, generated-file validation, or server headers.
- Context7 evidence: SvelteKit endpoint handlers should return `Response` objects for binary content and can set explicit headers on those responses; Vitest 4.1.6 supports module mocks with `vi.mock`, `vi.fn`, and reset/clear APIs for focused service tests.
- Svelte MCP status: no separate Svelte docs MCP tool is exposed in this session, so official SvelteKit docs via Context7 are the docs source for endpoint behavior.

## Done Criteria

- [x] A server-side **Generated File Serving** module exists and owns generated-file lookup, conversation-owner fallback, assigned/succeeded-job eligibility, allowed-type checks, byte reads, content validation, MIME/content-type resolution, and preview/download headers.
- [x] Chat preview and download routes are thin adapters: authenticate, call Generated File Serving in the requested mode, and translate the service result into `Response` or JSON error.
- [x] Working Document serving delegates generated-output `sourceChatFileId` bytes to Generated File Serving instead of duplicating generated-file validation and headers.
- [x] Preview and download headers are consistent across chat routes and Working Document generated-output serving, including CSP/nosniff/referrer policy for generated HTML and SVG previews.
- [x] Existing user-visible behavior remains stable for PDFs, Office files, ODT, text/code files, generated HTML/SVG, legacy generic MIME generated files, invalid/mismatched files, unreadable content, conversation-owner fallback, unassigned-file quarantine, and pre-finalization succeeded job-linked downloads.
- [x] Stale route tests or service tests that only preserve the old duplicated implementation are removed or rewritten around the new boundary.
- [x] `CONTEXT.md`, relevant ADRs, and the architecture review HTML explain the **Generated File Serving** boundary so future edits do not collapse it back into routes, Working Document serving, or Preview Runtime.

## Slices

### GFS-01. Introduce The Generated File Serving Module

**Type:** AFK

**Blocked by:** None - can start immediately

**User stories covered:** As a maintainer, I need one tested server module that can serve a generated file in preview or download mode without copying lookup, validation, and header policy into each adapter.

**What to build:** Add a focused service module for Generated File Serving. It should accept a user id, chat file id, mode, and optional display filename. It should own user-scoped lookup, conversation-owner fallback, unassigned-file quarantine for unattached staging files, the succeeded job-linked pre-finalization exception, allowed-type checks, content reads, `validateGeneratedOutputFile`, preview/download content type selection, and header construction.

**Acceptance criteria**

- [x] Missing files resolve to the same 404 behavior as current chat routes.
- [x] Files with `assistantMessageId === null` stay quarantined from public direct preview/download unless the File Production Read Model confirms the same file is linked to a succeeded job for the requesting user and conversation.
- [x] Conversation-owner fallback still supports legacy generated files whose `userId` does not match the current user row.
- [x] Unsupported filename/MIME pairs return 415 before content reads when possible.
- [x] Invalid bytes return 415 after content validation.
- [x] Preview mode uses inline disposition, preview content type, preview cache policy, and generated HTML/SVG CSP/nosniff/referrer headers.
- [x] Download mode uses attachment disposition, download cache policy, and the same safe content-type inference as existing generated-file downloads.
- [x] Focused unit tests cover the service contract without importing SvelteKit route handlers.

**Verification**

- [x] `npm run test:unit -- src/lib/server/services/generated-file-serving.test.ts`

### GFS-02. Thin The Chat Preview And Download Routes

**Type:** AFK

**Blocked by:** GFS-01

**User stories covered:** As a user, I need generated-file preview and download URLs to keep working exactly as before while route files become transport adapters.

**What to build:** Replace route-local generated-file serving logic in `/api/chat/files/[id]/preview` and `/api/chat/files/[id]/download` with calls to the Generated File Serving module. Keep auth behavior, error bodies, status codes, and binary response behavior compatible.

**Acceptance criteria**

- [x] Route tests still cover unauthenticated access, not-found responses, unassigned-file quarantine, legacy conversation-owner fallback, success headers, and invalid file failures.
- [x] The routes no longer import chat-file lookup/read helpers, output validation helpers, or preview MIME helpers directly.
- [x] Binary responses still return `new Response(...)` with the service-provided headers.
- [x] Error responses remain JSON with the current error strings and status codes.

**Verification**

- [x] `npm run test:unit -- src/routes/api/chat/files/[id]/preview/preview.test.ts src/routes/api/chat/files/[id]/download/download.test.ts`

### GFS-03. Delegate Working Document Generated-Output Serving

**Type:** AFK

**Blocked by:** GFS-01

**User stories covered:** As a user opening a generated document through the shared Document Workspace, I need source-chat-file previews and downloads to use the same validation and headers as direct chat file serving.

**What to build:** Update Working Document file serving so generated-output artifacts with `metadata.sourceChatFileId` call the Generated File Serving module. Keep normalized-document source-file serving and text-only degraded previews inside Working Document serving.

**Acceptance criteria**

- [x] Generated-output `sourceChatFileId` preview/download uses the same allowed-type, byte-validation, MIME, cache, disposition, and active-content security headers as chat-generated-file routes.
- [x] Working Document serving can still override the display filename with the artifact name when serving a generated-output source chat file.
- [x] Failed or pending source-first generated-document source artifacts still do not fall through to text-only preview/download.
- [x] Stored knowledge files and text-only Skill Notes keep their current Working Document serving behavior.
- [x] Working Document service tests cover generated HTML source chat files and invalid source chat file bytes through the new module boundary.

**Verification**

- [x] `npm run test:unit -- src/lib/server/services/knowledge/store/working-document-file-serving.test.ts src/lib/server/services/generated-file-serving.test.ts`

### GFS-04. Clean Up, Document, And Reassess

**Type:** AFK

**Blocked by:** GFS-02 and GFS-03

**User stories covered:** As a future agent, I need the generated-file serving boundary documented and old implementation debris removed so preview/download bugs localize to the right module.

**What to build:** Remove stale duplicated tests, unused imports, old helper code, and any scratch TDD artifacts left behind by the refactor. Update `CONTEXT.md`, ADRs, and the review HTML after verification. Mark the review section finished only after implementation evidence matches the review's “After” diagram.

**Acceptance criteria**

- [x] Repo search shows generated-file validation/header code no longer duplicated across chat preview route, chat download route, and Working Document generated-output serving.
- [x] No stale tests only assert the old route-local implementation shape.
- [x] `CONTEXT.md` defines **Generated File Serving** and its relationship to File Production, Working Document Identity, Working Document serving, and Preview Runtime.
- [x] Related ADRs no longer imply generated-file direct preview/download routes or Working Document serving own the generated-file byte/header policy.
- [x] The review HTML section `generated-file-serving` is marked finished and includes implementation status plus verification evidence.

**Verification**

- [x] `rg "validateGeneratedOutputFile|getPreviewContentType|Content-Security-Policy|Content-Disposition" src/routes/api/chat/files src/lib/server/services/knowledge/store/working-document-file-serving.ts`
- [ ] `npm run check` - not required for this documentation-only GFS-04 update.
- [ ] `npm run test:unit` - not required for this documentation-only GFS-04 update.
- [ ] Remote deploy and live smoke tests focused on generated-file production, preview, download, and Document Workspace opening - not required for this documentation-only GFS-04 update.

Focused implementation verification from orchestration passed before this status update:

```sh
npm run test:unit -- src/lib/server/services/generated-file-serving.test.ts 'src/routes/api/chat/files/[id]/preview/preview.test.ts' 'src/routes/api/chat/files/[id]/download/download.test.ts' src/lib/server/services/knowledge/store/working-document-file-serving.test.ts
```

Result: 4 files, 33 tests passed after adding the succeeded job-linked unassigned-file regression and generated SVG preview hardening coverage.
