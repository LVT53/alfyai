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
| Semantic document retrieval/search composition | `store/documents.ts` |
| Delete with ref checks | `store/cleanup.ts` `deleteArtifactForUser()` |
| Working-set ranking | `context.ts` `selectWorkingSetArtifactsForPrompt()` |
| Compaction status | `context.ts` `refreshConversationContextStatus()` |
| Work capsule create | `capsules.ts` `createWorkCapsule()` |

## Conventions

- **Token budgets**: `WORKING_SET_DOCUMENT_TOKEN_BUDGET` (1.2k), `WORKING_SET_OUTPUT_TOKEN_BUDGET` (1k), and `WORKING_SET_PROMPT_TOKEN_BUDGET` (3k) live in `store/core.ts` as legacy minimum floors and small-context fallbacks. Do not use them as final prompt-depth ceilings when chat-turn context selection has a model-scaled budget available.
- **Semantic retrieval**: `store/documents.ts` composes lexical fetch + embedding shortlist + TEI rerank; keeps deterministic filters above TEI scores
- **Library uploads**: `conversationId` may be null; skip `attached_to_conversation` link when null. Filename conflicts auto-rename non-identical files; byte-identical (SHA256 hash) files reuse the existing artifact via `findExistingArtifactByBinaryHash`.
- **Knowledge Upload Intake**: upload routes own auth, HTTP/body receipt, raw temp writes, and chunk assembly. `upload-intake.ts` owns shared limits, conversation validation, durable completion, normalized extraction, readiness response, and upload trace output after bytes are available. Uploaded and normalized document bodies are not synced into Honcho persona memory by default.
- **Memory Profile**: user-facing memory UX is projection-backed through `../memory.ts` and `../memory-profile/`; Knowledge page routes/views should render that projection instead of parsing raw Honcho text.
- **Document families**: generated-document families are metadata-driven via `store/document-metadata.ts`; `document-resolution.ts` is authority for "which generated version is current"
- **AI-facing document view**: source-plus-normalized documents are listed as one source row, but the Knowledge Documents UI must keep an on-demand AI-facing version panel backed by the normalized prompt artifact. This panel is document prompt visibility and should not be removed as part of memory-system cleanup.
- **Working Document Selection**: live focus, correction, recent-refinement, reset, prompt, retrieval, and task-evidence signal views come from `../working-document-selection.ts`
- **Capsules**: workflow summaries only; document lineage lives in artifact metadata + links
- **Observability**: `[CONTEXT] Working document selection` summary in `context.ts`; extend it rather than per-candidate logs

## Anti-Patterns

- Do NOT create a second artifact persistence path outside `store/core.ts`
- Do NOT duplicate document persistence, grouping, or artifact mapping in routes; Workspace Search may compose `store/documents.ts` for shell-search document results
- Do NOT put upload completion, prompt readiness, or Honcho sync back into upload routes
- Do NOT remove normalized prompt-artifact visibility from the Documents UI; hide standalone normalized rows, but keep the source-row AI-facing version panel
- Do NOT make capsules the authority for document lineage
- Do NOT add uploaded-file versioning; byte-identical (SHA256 hash) deduplication is handled at the upload level via `findExistingArtifactByBinaryHash`. Name-based auto-rename still applies for non-identical files with conflicting names.
- Do NOT reintroduce page-local raw Honcho overview normalization or make live Honcho overview generation the Knowledge Base memory authority.
- Do NOT route TEI reranking through control-model chat completions
- Do NOT add per-candidate debug logs; keep retrieval observability summary-level
- Do NOT bypass `document-resolution.ts` for generated-document selection heuristics
