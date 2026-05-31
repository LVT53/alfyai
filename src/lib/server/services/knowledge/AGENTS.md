# Knowledge Subsystem

Parent: [../AGENTS.md](../AGENTS.md) covers cross-service knowledge flow. This file documents the internal `knowledge/` structure only.

## Overview

Artifact storage, retrieval, and working-document lifecycle. All semantic retrieval uses TEI embedder/reranker through shared boundaries.

## Structure

```
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
| Complete Knowledge upload intake | `upload-intake.ts` |
| Create artifact + chunks | `store/core.ts` `createArtifact()` |
| Upload + prompt readiness | `store/attachments.ts` `saveUploadedArtifact()`, `resolvePromptAttachmentArtifacts()` |
| Semantic document search | `store/documents.ts` |
| Delete with ref checks | `store/cleanup.ts` `deleteArtifactForUser()` |
| Working-set ranking | `context.ts` `selectWorkingSetArtifactsForPrompt()` |
| Compaction status | `context.ts` `refreshConversationContextStatus()` |
| Work capsule create | `capsules.ts` `createWorkCapsule()` |

## Conventions

- **Token budgets**: `WORKING_SET_DOCUMENT_TOKEN_BUDGET` (4k), `WORKING_SET_OUTPUT_TOKEN_BUDGET` (2k), `WORKING_SET_PROMPT_TOKEN_BUDGET` (20k) live in `store/core.ts`
- **Semantic retrieval**: `store/documents.ts` composes lexical fetch + embedding shortlist + TEI rerank; keeps deterministic filters above TEI scores
- **Library uploads**: `conversationId` may be null; skip `attached_to_conversation` link when null. Filename conflicts auto-rename and remain separate uploaded documents; do not convert duplicate uploads into versions.
- **Knowledge Upload Intake**: upload routes own auth, HTTP/body receipt, raw temp writes, and chunk assembly. `upload-intake.ts` owns shared limits, conversation validation, durable completion, normalized extraction, Honcho sync/fallback, readiness response, and upload trace output after bytes are available.
- **Document families**: generated-document families are metadata-driven via `store/document-metadata.ts`; `document-resolution.ts` is authority for "which generated version is current"
- **Working Document Selection**: live focus, correction, recent-refinement, reset, prompt, retrieval, and task-evidence signal views come from `../working-document-selection.ts`
- **Capsules**: workflow summaries only; document lineage lives in artifact metadata + links
- **Observability**: `[CONTEXT] Working document selection` summary in `context.ts`; extend it rather than per-candidate logs

## Anti-Patterns

- Do NOT create a second artifact persistence path outside `store/core.ts`
- Do NOT duplicate document search ranking in routes; use the shared document search service
- Do NOT put upload completion, prompt readiness, or Honcho sync back into upload routes
- Do NOT make capsules the authority for document lineage
- Do NOT add uploaded-file versioning or dedupe; duplicate uploads stay separate auto-renamed documents
- Do NOT route TEI reranking through control-model chat completions
- Do NOT add per-candidate debug logs; keep retrieval observability summary-level
- Do NOT bypass `document-resolution.ts` for generated-document selection heuristics
