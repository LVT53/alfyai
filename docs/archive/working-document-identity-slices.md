# Deepen Working Document Identity Slices

These are local `$to-issues` slices for deepening **Working Document Identity** from the architecture review. They are not published tracker issues.

The review recommendation is to stop making callers inspect `displayArtifactId`, `promptArtifactId`, and `familyArtifactIds` directly when they need workspace, prompt, preview, linked-source, or file-serving identity. The target boundary is one small identity module that receives a **Knowledge Document** or artifact and answers a purpose-specific identity question.

**Implementation Status, 2026-05-29:** WDI-01 through WDI-05 are finished. The implementation added `src/lib/services/working-document-identity.ts` for pure display/prompt/preview/family identity, `src/lib/server/services/knowledge/store/working-document-file-serving.ts` for preview/download resolution, and ADR-0017 for the durable boundary decision. Final verification covered `npm run check`, `npm run test:unit`, deployment, live smoke, and production log review.

## Evidence And Constraints

- Review HTML source: `/private/var/folders/6c/llmb9__97ngcxtc26hvg8jzh0000gn/T/architecture-review-20260529-134900.html`
- Review section: `Deepen Working Document Identity`
- Problem statement: Knowledge Base callers must know when to use display identity versus prompt identity, and preview/download correctness depends on that hidden invariant.
- Target files called out by the review: `src/lib/server/services/knowledge/store/documents.ts`, `src/lib/types.ts`, `src/routes/(app)/knowledge/_helpers.ts`, `src/lib/server/services/linked-context-sources.ts`, and `src/routes/api/knowledge/[id]/preview/+server.ts`.
- Repo boundary: **Working Documents** live on the existing artifact backbone. Do not create a parallel document persistence service.
- Repo boundary: routes stay adapters; durable identity and file-serving rules belong in server services or shared helpers.
- Context7 evidence: SvelteKit 2 `+server.ts` handlers export HTTP verb functions that return `Response` objects; Vitest 4 supports ESM module mocks for focused boundary tests; Drizzle's typed query helpers remain appropriate for the existing artifact-link lookup path.

## Done Criteria

- One **Working Document Identity** module owns display, prompt, preview/file-serving, and family identity rules.
- Logical document mapping calls the identity module instead of assembling id fields ad hoc.
- Knowledge workspace helpers request the preview/workspace identity instead of choosing `displayArtifactId` directly.
- Linked Context Source resolution requests prompt and family identity through the module instead of duplicating matching and readiness rules.
- The knowledge preview route delegates artifact-to-preview resolution to the identity boundary instead of manually resolving normalized documents and generated-output source chat files inline.
- Focused invariant tests prove uploaded source-plus-normalized documents, normalized-only documents, generated documents, and Skill Notes return the correct purpose-specific identities.
- Stale comments/tests that encode the old hidden invariant are removed or rewritten to point at the identity boundary.

## Slices

### WDI-01. Introduce The Purpose-Specific Identity Contract

**Type:** AFK

**Blocked by:** None - can start immediately

**User stories covered:** As a maintainer, I need one tested contract that says which id represents a Working Document for display, prompt, preview, and family purposes.

**What to build:** Add a focused Working Document Identity module with pure helpers for logical document identity. It should accept the existing logical document data shape and return display identity, prompt identity, preview/file-serving identity, and family identity without querying persistence.

**Acceptance criteria**

- [x] The new module defines purpose-specific identity helpers or one typed resolver for display, prompt, preview, and family identity.
- [x] Uploaded source-plus-normalized documents return source/display id for display and preview, normalized id for prompt, and both ids for family matching.
- [x] Normalized-only documents, generated documents, and Skill Notes remain valid Working Documents with prompt and preview fallbacks matching current behavior.
- [x] Tests cover the invariant matrix without depending on routes or database mocks.
- [x] The public `KnowledgeDocumentItem` shape remains compatible unless a narrow additive field is necessary.

**Verification**

- [x] `npm run test:unit -- src/lib/server/services/knowledge/store/working-document-identity.test.ts`

### WDI-02. Make Knowledge Document Mapping Emit Canonical Identity

**Type:** AFK

**Blocked by:** WDI-01

**User stories covered:** As a user, Library Documents, Generated Documents, and Skill Notes should still appear as the same logical documents while their identity fields are assembled in one place.

**What to build:** Update logical-document mapping so `listLogicalDocuments` uses the identity contract when emitting `displayArtifactId`, `promptArtifactId`, `familyArtifactIds`, and readiness-related identity data.

**Acceptance criteria**

- [x] Source-plus-normalized documents still expose source display id and normalized prompt id.
- [x] Generated document families still expose the latest generated document as display/prompt identity and all family artifacts as family identity.
- [x] Skill Notes still expose their own artifact id for display, prompt, preview, and family identity.
- [x] Existing document-list behavior stays compatible for Knowledge, Chat document picker, and linked-source chips.
- [x] Mapping tests assert identity through the new contract rather than restating route-specific assumptions.

**Verification**

- [x] `npm run test:unit -- src/lib/server/services/knowledge/store/documents.test.ts`

### WDI-03. Move Workspace And Linked-Source Callers Onto The Identity Boundary

**Type:** AFK

**Blocked by:** WDI-01 and WDI-02

**User stories covered:** As a user opening or linking a document, AlfyAI should choose the correct preview and prompt identities without each UI/helper surface knowing artifact-id semantics.

**What to build:** Replace direct caller decisions in Knowledge workspace helpers and linked-context-source services with purpose-specific identity calls. Keep route-local open-document state in the Knowledge page, but move the identity choice out of page helpers.

**Acceptance criteria**

- [x] `toWorkspaceDocument` requests preview/workspace identity instead of directly choosing `displayArtifactId`.
- [x] `getWorkspaceDocumentForArtifact` matches documents through family identity from the identity contract.
- [x] Linked Context Source canonicalization requests display, prompt, and family identities from the module.
- [x] Linked source readiness still blocks documents without prompt identity.
- [x] Attachment dedupe still checks the whole Working Document family.

**Verification**

- [x] `npm run test:unit -- src/routes/(app)/knowledge/_helpers.test.ts src/lib/server/services/linked-context-sources.test.ts`

### WDI-04. Deepen Preview/File-Serving Resolution

**Type:** AFK

**Blocked by:** WDI-01

**User stories covered:** As a user previewing a document, PDFs, DOCX/XLSX/PPTX, generated files, normalized text, and Skill Notes should open with the same correct file-serving behavior while the preview route stays an adapter.

**What to build:** Move artifact-to-preview resolution from `src/routes/api/knowledge/[id]/preview/+server.ts` into the Working Document Identity boundary or a server-side identity resolver owned by that boundary. The route should authenticate, request preview resolution, translate errors, and stream the returned text, file path, or chat-file bytes.

**Acceptance criteria**

- [x] Normalized documents with source artifacts resolve to the source binary for preview.
- [x] Generated-output artifacts with `sourceChatFileId` resolve to validated chat-file bytes for preview.
- [x] Text-only normalized/generated/Skill Note artifacts still preview as text when no better binary preview exists.
- [x] Preview route status codes and headers remain compatible.
- [x] File-serving tests cover both the new resolver and the route adapter.

**Verification**

- [x] `npm run test:unit -- src/routes/api/knowledge/[id]/preview/preview.test.ts`

### WDI-05. Remove Stale Identity Knowledge And Document The Boundary

**Type:** AFK

**Blocked by:** WDI-02 through WDI-04

**User stories covered:** As a future maintainer, I need the Working Document Identity boundary documented so preview/download or prompt-context changes do not reintroduce scattered id rules.

**What to build:** Remove stale comments, obsolete tests, unused modules, and duplicate helper logic left behind by the refactor. Update `CONTEXT.md`, an ADR, and the architecture review HTML with the implemented boundary and verification evidence.

**Acceptance criteria**

- [x] Repo-wide search shows no caller comment telling future edits to choose `displayArtifactId` versus `promptArtifactId` directly for preview or prompt identity.
- [x] Stale tests that only assert old implementation details are removed or rewritten as identity-boundary tests.
- [x] `CONTEXT.md` defines **Working Document Identity** and its relationship to **Working Document**, **Document Workspace**, **Linked Context Source**, and preview/file serving.
- [x] A related ADR records that Working Document Identity is the authority for purpose-specific artifact ids while Context Selection remains prompt-budget authority.
- [x] The architecture review HTML marks `Deepen Working Document Identity` as finished and includes implementation status.

**Verification**

- [x] `npm run check`
- [x] `npm run test:unit`
- [x] Remote live smoke after deploy, focused on Knowledge Library document preview, `/document` linked source flow, and a low-risk chat turn.
