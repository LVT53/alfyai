# Knowledge Subsystem

Parent: [../AGENTS.md](../AGENTS.md) covers cross-service knowledge flow. This file documents the internal `knowledge/` structure only.

## Overview

Artifact storage, retrieval, and working-document lifecycle. All semantic retrieval uses TEI embedder/reranker through shared boundaries. The user-facing Memory Profile now lives behind `../memory.ts` and `../memory-profile/`; `knowledge/memory-overview.ts` is legacy compatibility and must not become a local persona-memory subsystem.

## Structure

```
memory-overview.ts     ← legacy Knowledge Memory overview compatibility only
upload-intake.ts       ← durable upload completion after adapters receive bytes
store.ts (facade — re-exports store/*)
  ├── store/core.ts         ← artifact CRUD, WORKING_SET_*_BUDGET constants
  ├── store/attachments.ts  ← upload → auto-rename → optional conversation link
  ├── store/documents.ts    ← normalized docs, semantic retrieval (Wave 5)
  ├── store/document-ranking.ts ← the relevance sum a document search is ordered by (pure arithmetic)
  ├── store/cleanup.ts      ← cross-reference-aware deletion
  └── store/document-metadata.ts ← generated-document family metadata
context.ts                ← working-set ranking, compaction, Working Document Selection integration
capsules.ts               ← work capsules, generated outputs (not lineage authority)
```

## Where to Look

| Task | File |
|------|------|
| Legacy Knowledge Memory overview compatibility | `memory-overview.ts` |
| Complete Knowledge upload intake | `upload-intake.ts` |
| Create artifact + chunks | `store/core.ts` `createArtifact()` |
| Upload + prompt readiness | `store/attachments.ts` `saveUploadedArtifact()`, `resolvePromptAttachmentArtifacts()` |
| Which unready attachments stop a send (a picture a model that can see is shown needs no text) | `store/attachments.ts` `blockingAttachmentItems()`, `assertPromptReadyAttachments({ exemptImages })`; rules in `../vision/AGENTS.md` |
| Semantic document retrieval/search composition | `store/documents.ts` |
| The order a document search returns: the weights, which documents the reranker is handed | `store/document-ranking.ts`, `rankArtifactMatches()` in `store/documents.ts`; the measurements behind it in `docs/plans/document-ranking/README.md` |
| Which documents a search ranks at all (the 120 newest, plus older ones by vector and by quoted words) | `selectArtifactSearchCandidates()` and `selectOlderArtifactCandidates()` in `store/documents.ts`; the cut-off rates and the cost in `docs/plans/document-ranking/README.md`, "Which documents are in the running" |
| Delete with ref checks | `store/cleanup.ts` `deleteArtifactForUser()` |
| Working-set ranking | `context.ts` `selectWorkingSetArtifactsForPrompt()` |
| Compaction status | `context.ts` `refreshConversationContextStatus()` |
| Work capsule create | `capsules.ts` `createWorkCapsule()` |

## Conventions

- **Token budgets**: `WORKING_SET_DOCUMENT_TOKEN_BUDGET` (1.2k), `WORKING_SET_OUTPUT_TOKEN_BUDGET` (1k), and `WORKING_SET_PROMPT_TOKEN_BUDGET` (3k) live in `store/core.ts` as legacy minimum floors and small-context fallbacks. Do not use them as final prompt-depth ceilings when chat-turn context selection has a model-scaled budget available.
- **Semantic retrieval**: `store/documents.ts` composes lexical fetch + embedding shortlist + TEI rerank; keeps deterministic filters above TEI scores
- **Search candidates**: a search ranks the 120 newest documents and, only when the library holds more, two small groups of older ones (`selectOlderArtifactCandidates`): the 24 whose stored vector is closest to the question (needs the caller's query embedding, so a caller that did not embed it gets none) and up to 12 that hold every longer word of it (a quoted phrase, a name, rare words: the embedder is weakest there). Both use the window's own visibility rules, and the vector read is capped at the newest 2,000 older documents because the vectors are compared in JavaScript (about 60 ms for 1,380 of them at 1024 dimensions). A failure in this pass is logged and costs only the addition (the 120 newest are still ranked). Do not put the window back to "the newest 120 and nothing else": at worst (no question about the 120 newest) a library of 400 loses the right document for 70% of the questions, one of 1,500 for 92%. A `LIKE` filter on the query's words ordered by recency does not fix it, since an English question shares a word with nearly every document.
- **Search order**: a weighted sum of the three signals (`store/document-ranking.ts`) with recency only as the last tie-break. Never multiply it by an age factor: the one that was there, with the age in seconds, cancelled the embedder and the reranker for any document older than ten minutes. The reranker scores only the first documents it is handed, so hand it the likeliest by the sum before it, not the first word hits. The three signals leave `RankedArtifactMatch` unchanged, because `context.ts` reads them against thresholds of their own.
- **Boundary penalty**: `context.ts` discounts a document by its age (`exp(-0.05 * days)`) only when it belongs to ANOTHER conversation, after the eligibility gate. A document in no conversation (a library or project upload) has no boundary to cross and is not discounted: with no gate before it, the discount alone chose which few reached the prompt, the newest and not the best.
- **Working-set score**: `working-set.ts` sums the turn's signals (attached this turn, active document focus, recent correction, recently refined family, current generated document) and keeps what reaches 20. Never weigh that sum by the age of the file: the age in seconds, as `computeDecayScore` takes it, put a document written more than about two minutes before the refresh under the cut whatever the turn had said about it, so the turn after it did not carry the document. Equal scores go to the document written last. The recently-refined signal is read from the artifacts, not from the message, so it holds while the file is among the 8 newest generated outputs (about seven turns) and only a move-on phrase or a request for a new file ends it sooner. Only the message match is aged, as it always was, and must stay so: it is three-letter pieces of the message found anywhere in the text, and with nothing to age it a chat's own old replies all stay in the working set and the prompt (`docs/plans/document-ranking/working-set.md`, with the numbers).
- **Library uploads**: `conversationId` may be null; skip `attached_to_conversation` link when null. Filename conflicts auto-rename non-identical files; byte-identical (SHA256 hash) files reuse the existing artifact via `findExistingArtifactByBinaryHash`.
- **Knowledge Upload Intake**: upload routes own auth, HTTP/body receipt, raw temp writes, and chunk assembly. `upload-intake.ts` owns shared limits, conversation validation, durable completion, normalized extraction, readiness response, and upload trace output after bytes are available.
- **Memory Profile**: user-facing memory UX is projection-backed through `../memory.ts` and `../memory-profile/`; Knowledge page routes/views should render that projection.
- **Document families**: generated-document families are metadata-driven via `store/document-metadata.ts`; `document-resolution.ts` is authority for "which generated version is current"
- **AI-facing document view**: source-plus-normalized documents are listed as one source row, but the Knowledge Documents UI must keep an on-demand AI-facing version panel backed by the normalized prompt artifact. This panel is document prompt visibility and should not be removed as part of memory-system cleanup.
- **Working Document Selection**: live focus, correction, recent-refinement, reset, prompt, retrieval, and task-evidence signal views come from `../working-document-selection.ts`. Wording invariants and the English/Hungarian measurement are owned by the parent services AGENTS.md (Working Document wording) and `docs/plans/document-ranking/working-document-wording.md`.
- **Capsules**: workflow summaries only; document lineage lives in artifact metadata + links
- **Observability**: `[CONTEXT] Working document selection` summary in `context.ts`; extend it rather than per-candidate logs

## Anti-Patterns

- Do NOT create a second artifact persistence path outside `store/core.ts`
- Do NOT duplicate document persistence, grouping, or artifact mapping in routes; Workspace Search may compose `store/documents.ts` for shell-search document results
- Do NOT put upload completion or prompt readiness back into upload routes
- Do NOT remove normalized prompt-artifact visibility from the Documents UI; hide standalone normalized rows, but keep the source-row AI-facing version panel
- Do NOT make capsules the authority for document lineage
- Do NOT add uploaded-file versioning; byte-identical (SHA256 hash) deduplication is handled at the upload level via `findExistingArtifactByBinaryHash`. Name-based auto-rename still applies for non-identical files with conflicting names.
- Do NOT make the Knowledge Base memory view anything other than a projection of the durable local Memory Profile.
- Do NOT route TEI reranking through control-model chat completions
- Do NOT add per-candidate debug logs; keep retrieval observability summary-level
- Do NOT bypass `document-resolution.ts` for generated-document selection heuristics

## Working-Document Continuity

Do:

- working-document continuity should continue to build on generated-output artifacts.
- working-document continuity should prefer the shared resolver’s “current generated document” signal over generic latest-output heuristics. If a generated document is selected because of active focus or a query match, do not layer a second recency-only boost on top.
- keep document-selection observability compact and authority-scoped. Extend the `[CONTEXT] Working document selection` summary in `knowledge/context.ts` instead of reintroducing noisy per-artifact debug logs across routes.


## Knowledge And Context

- Public boundary:
  - [`src/lib/server/services/knowledge.ts`](../knowledge.ts)
- Internal modules:
  - [`src/lib/server/services/knowledge/store.ts`](store.ts)
  - [`src/lib/server/services/knowledge/store/core.ts`](store/core.ts)
  - [`src/lib/server/services/knowledge/store/attachments.ts`](store/attachments.ts)
  - [`src/lib/server/services/knowledge/store/documents.ts`](store/documents.ts)
  - [`src/lib/server/services/knowledge/store/cleanup.ts`](store/cleanup.ts)
  - [`src/lib/server/services/knowledge/upload-intake.ts`](upload-intake.ts)
  - [`src/lib/server/services/knowledge/context.ts`](context.ts)
  - [`src/lib/server/services/knowledge/capsules.ts`](capsules.ts)
  - [`src/lib/server/services/knowledge/project-knowledge.ts`](project-knowledge.ts) — owns project-file links and the project's FILES (`listProjectKnowledge`: what a turn's prompt section and file-name mentions read, so it never lists a Document, App or Canvas — a family row is not prompt-ready as a linked source and a mention of its name would 409 the turn); the person's bundle, files plus what the chats made, is `listProjectBundle` in the artifacts service
- Related services:
  - [`src/lib/server/services/working-set.ts`](../working-set.ts)
  - [`src/lib/server/services/workspace-search.ts`](../workspace-search.ts)
  - [`src/lib/server/services/document-resolution.ts`](../document-resolution.ts)
  - [`src/lib/server/services/extraction/`](../extraction/) — durable document extraction: the job kind (`extraction-job.ts`) and its handler (`extraction-runner.ts`) run on the job engine in `services/jobs/`, which owns the lifecycle, the claim, the lease and the take-back; HEIC and HEIF reach the document reader as a PNG of at most 4096 px (`reader-input.ts`, through `decodeImageToPng` in `vision/prepare-image.ts`) with the stored original untouched; replaced the deleted `document-extraction.ts`
  - [`src/lib/shared/file-types/`](../../../shared/file-types/) — the one registry of extensions, MIME types, intake routes and producible outputs
  - [`src/lib/server/services/evidence-family.ts`](../evidence-family.ts)
  - [`src/lib/server/services/knowledge-labels.ts`](../knowledge-labels.ts)
  - [`src/lib/server/services/tei-embedder.ts`](../tei-embedder.ts)
  - [`src/lib/server/services/tei-reranker.ts`](../tei-reranker.ts)


Responsibility split:

- `store.ts`
  - public facade for store internals
- `store/core.ts`
  - artifact CRUD
  - artifact mapping and shared selection helpers
- `store/attachments.ts`
  - attachment readiness
  - uploaded attachment persistence
  - auto-rename on file name conflicts
  - attachment linking and listing
- `store/documents.ts`
  - normalized-document creation
  - logical document listing
  - artifact query matching
  - document search composition consumed by Workspace Search
- generated chat files and uploaded attachments should converge on one working-document model built on the existing artifact backbone; do not create a parallel document persistence subsystem
- `store/cleanup.ts`
  - artifact deletion
  - cross-conversation reference checks
  - bulk cleanup actions
- `upload-intake.ts`
  - shared knowledge upload limits
  - optional conversation validation
  - uploaded source persistence through the store
  - normalized artifact creation, prompt readiness, and upload trace output
- `context.ts`
  - relevant-artifact lookup
  - working-set and context status operations
  - context-related reads/writes used during chat
- `store/documents.ts`
  - artifact-level semantic shortlist retrieval for source/normalized/generated artifacts
  - lexical candidate fetch, embedding shortlist, and TEI rerank before handing results to higher-level document/focus authority
- `working-document-selection.ts`
  - live Working Document signal collapse for active workspace focus, current generated document, correction/refinement, move-on/reset, and caller-ready prompt/retrieval/task-evidence views
- `document-resolution.ts`
  - current/relevant generated-document family selection
  - shared query/focus-aware generated-document ordering
- `tei-embedder.ts` / `tei-reranker.ts`
  - thin Hugging Face Text Embeddings Inference clients only
  - semantic shortlist/rerank helpers should flow through higher-level retrieval services; these clients should not become a second ranking authority
  - rerank-shaped evidence/chunk/historical/tool call sites should prefer `tei-reranker.ts` over `task-state/control-model.ts`
- `capsules.ts`
  - work capsules
  - generated outputs
  - artifact-to-capsule mapping
  - workflow summary only, not document lineage authority


Do not:

- dump new unrelated knowledge behavior back into `knowledge.ts`
- mix file storage concerns with context-ranking heuristics in the same new helper
- place large retrieval heuristics in route files
- add a second parallel artifact service outside the `knowledge` boundary


## Knowledge Library

- Document workspace preview:
  - [`src/lib/components/document-workspace/DocumentWorkspace.svelte`](../../../components/document-workspace/DocumentWorkspace.svelte)
  - [`src/lib/components/document-workspace/DocumentPreviewRenderer.svelte`](../../../components/document-workspace/DocumentPreviewRenderer.svelte)


Rules:

- Direct library uploads through `/api/knowledge/upload` may omit `conversationId`; when present, Knowledge Upload Intake must validate that the conversation belongs to the user before any artifact insert or link write
- File versioning is NOT supported - single version per file
- Auto-rename on name conflicts (counter suffix) - no overwrite
- File preview uses client-side libraries (pdf.js, mammoth, exceljs, pptxviewjs), no external services
- Storage quota is display-only - no enforcement
- Global Workspace Search surfaces conversation, project, message, and document hits through `/api/workspace-search`; document clicks should hand off into the knowledge-page working-document workspace instead of opening a separate modal path


Do not:

- add file versioning/history
- add in-app file editing for uploaded or generated files (Artifacts are the one in-place-edited kind; see [ADR-0065](../../../../../docs/adr/0065-living-documents-are-edited-in-place.md) and [ADR-0066](../../../../../docs/adr/0066-artifacts-are-a-family-of-five-types.md))
- allow AI to edit existing uploaded library files (AI generates NEW files only; Artifacts are the ADR-0065/0066 exception)
- add batch operations
- add file deduplication (allow duplicates with auto-rename)
- use external hosted services for file preview


## Retrieval Ownership

Rules:

- Artifact retrieval and cleanup treat linked conversation ownership as stronger authority than `artifacts.userId` alone. Conversation-scoped working artifacts (`generated_output`, `work_capsule`) are not valid retrieval candidates once their conversation link is gone.
