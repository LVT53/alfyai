# Task-State Submodule

Parent: [../AGENTS.md](../AGENTS.md) for cross-service dependencies. This file covers submodule internals only.

## Overview

Internal helpers for `task-state.ts`: folder-anchored project continuity, artifact snippet selection, artifact chunk persistence, control-model client, and row mappers.

## Structure

| File | Lines | Role |
|------|-------|------|
| `continuity.ts` | ~700 | Folder-anchored project reference context, sibling promotion, task-memory listing (ADR-0051: the inferred project-memory substrate has been retired) |
| `artifacts.ts` | ~250 | Task-state prompt formatting, prompt snippet selection, historical context summarization |
| `chunk-sync.ts` | ~90 | Artifact chunk splitting and persistence |
| `control-model.ts` | ~230 | Context summarizer API client for routing/verification/JSON tasks |
| `mappers.ts` | ~70 | Row-to-type mappers for task states, checkpoints, chunks |

## Where to Look

| Task | File |
|------|------|
| Folder-anchored project reference context | `continuity.ts` — `getProjectReferenceContext()` / `getProjectFolderReferenceContext()` |
| Folder lookup by query | `continuity.ts` — `findProjectFolderReferenceContextByQuery()` |
| Sibling promotion for prompt context | `continuity.ts` — `selectProjectFolderSiblingPromotion()` |
| Artifact chunk sync | `chunk-sync.ts` — `syncArtifactChunks()` |
| Prompt snippet selection | `artifacts.ts` — `getPromptArtifactSnippets()` |
| Chunk reranking | `artifacts.ts` — uses `tei-reranker.ts` |
| Historical context summarization | `artifacts.ts` — `summarizeHistoricalContext()` |
| Control model JSON tasks | `control-model.ts` — `requestStructuredControlModel()` |
| Row mapping | `mappers.ts` — `mapTaskState()`, `mapTaskCheckpoint()`, etc. |

## Conventions

- **Folder-anchored continuity**: Project continuity is the set of conversations filed under a Project Folder (`projects` + `conversations.projectId`). There is no inferred bucket store; a non-folder conversation has no passive reference context (`getProjectReferenceContext` returns `null`). On-demand recall over unorganized conversations is served by the `memory_context` tool's history search.
- **Chunking**: Small files bypass chunking via `getSmallFileThreshold()`; larger files split at paragraph/sentence boundaries with overlap.
- **Snippet selection**: Lexical score first, TEI rerank when available, fallback to first chunk if no scores.
- **Control model**: Use for structured JSON tasks (routing, verification), not for TEI reranking.
- **Mappers**: Always use `parseJsonStringArray()` for JSON text columns; never cast directly.

## Anti-Patterns

- Do not route TEI reranking through `control-model.ts`; use `tei-reranker.ts` directly.
- Do not reintroduce an inferred project-continuity bucket substrate; folder membership is the single continuity authority (ADR-0051).
- Do not add new JSON parsing logic outside `mappers.ts` or `utils/json.ts`.
- Do not duplicate chunk selection logic in routes; use `getPromptArtifactSnippets()`.

## Task-State Boundary

- `src/lib/server/services/task-state.ts` may use semantic shortlist and rerank signals when routing the current turn onto an existing task, but active/revived/candidate truth and project continuity state still remain deterministic there.
- `src/lib/server/services/task-state.ts` is the continuity boundary. Do not reintroduce a parallel `project-memory` architecture.
- `src/lib/server/services/task-state/control-model.ts` is still for structured control-model work such as routing, verification, and semantic JSON tasks. Do not route TEI reranking back through that chat-completions path.

## Continuity

Rules:

- `task-state.ts` remains the continuity facade (task routing, checkpoints, evidence-context assembly, semantic task revival). Keep project continuity status/event truth deterministic in `task-state/continuity.ts`, which prefers the latest `project_paused`/`project_resumed` task-domain event over an older still-active row.
- User-selected task evidence preferences stay family-aware for working documents: pinning/excluding one version clears contradictory preference links for sibling versions in the same family. Live Working Document selection signals belong in `working-document-selection.ts`, recomputed per turn.
