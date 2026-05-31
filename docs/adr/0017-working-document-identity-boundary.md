# Deepen Working Document Identity

Working Document Identity is the authority for purpose-specific artifact identity for Library Documents, Generated Documents, and Skill Notes. A caller that needs display/workspace identity, prompt identity, preview/file-serving identity, or family matching must request that identity through `src/lib/services/working-document-identity.ts` or the server-side store facade instead of reinterpreting `displayArtifactId`, `promptArtifactId`, and `familyArtifactIds` locally.

The server-side file-serving companion, `src/lib/server/services/knowledge/store/working-document-file-serving.ts`, owns the preview/download resolution rules for Working Documents. Normalized documents with a source artifact resolve to the source binary when available, generated-output artifacts with `sourceChatFileId` resolve to generated chat-file identity and delegate byte validation/header policy to Generated File Serving, and text-only artifacts remain valid degraded previews.

ADR-0021 complements this decision: Working Document Identity and file serving decide which bytes are eligible for preview/download, while the client-side Preview Runtime owns browser rendering for those bytes by file type. ADR-0023 complements both decisions by making `src/lib/server/services/generated-file-serving.ts` the generated chat-file byte-serving boundary once Working Document serving selects a `sourceChatFileId`.

Context Selection remains the prompt-budget authority. Working Document Identity can say which artifact is prompt-ready and which artifact id represents prompt identity, but it does not decide whether a source enters the model prompt, how much of it is included, or how it competes with memory, attachments, retrieval, or task context.

ADR-0018 complements this decision: Working Document Selection owns live per-turn Working Document signals such as active focus, correction target, current generated document, recent refinement, and reset suppression. Working Document Identity remains the purpose-specific id authority; it does not decide live current-document carryover.

File Production remains the producer of generated-document sources, rendered files, and job lifecycle state. Working Document Identity consumes generated-output metadata such as `sourceChatFileId` and document-family metadata for workspace, linked-source, and preview behavior, but it must not create file-production jobs or persist generated-document source artifacts.

Generated File Serving remains the generated chat-file serving authority. Working Document Identity may select the generated-output source chat file, but it must not duplicate eligibility checks for assigned or succeeded job-linked unassigned files, ownership fallback, MIME/byte validation, CSP, disposition, or cache header rules.

**Implementation Status, 2026-05-29:** implemented. Logical document mapping, Knowledge workspace helpers, Linked Context Source resolution, chat `/document` selection, Knowledge preview, and Knowledge download now route through the Working Document Identity or file-serving boundary. Focused tests cover source-plus-normalized uploads, normalized-only fallbacks, generated documents, generated-output source chat files, Skill Notes, linked-source dedupe, and route adapters.

**Considered Options**

- Keep display, prompt, preview, and family artifact-id rules embedded in each caller.
- Move every document operation into a new document persistence service.
- Add a focused Working Document Identity boundary over the existing artifact backbone.

We chose the focused boundary because the app already has a durable artifact model and separate context-selection/file-production boundaries. Deepening identity removes hidden caller invariants without creating a parallel document subsystem.
