# Server Services — Internal Map

Parent: [AGENTS.md](../../../AGENTS.md) lists every service file and its role. This file covers **cross-service dependencies, complexity ordering, and data flow** — what the parent doesn't document.

## Complexity Hotspots (by line count)

| Rank | File | Lines | Why large |
|------|------|-------|-----------|
| 1 | `task-state.ts` | ~1,558 | Facade + task routing, evidence selection, checkpointing, steering |
| 2 | `honcho.ts` | ~1,517 | Honcho client lifecycle, session bootstrap, context construction |
| 3 | `stream-orchestrator.ts` | ~558 | Full chat-turn streaming pipeline, upstream retry, downstream SSE framing |
| 4 | `chat-turn/stream.ts` | ~247 | Stream framing and cleanup helpers |
| 5 | `knowledge/store/attachments.ts` | ~520 | Upload auto-rename, readiness checks, artifact linking |
| 6 | `task-state/continuity.ts` | ~989 | Project memory, focus continuity, task-project linking |
| 7 | `knowledge/context.ts` | ~680 | Working-set ranking, context status, compaction logic |
| 8 | `knowledge/capsules.ts` | 347 | Workflow summarization, generated-output artifacts |
| 9 | `knowledge/store/core.ts` | 353 | Artifact CRUD, mapping, token-budget constants |
| 10 | `task-state/artifacts.ts` | 358 | Chunking, prompt-snippet selection, historical summarization |
| 11 | `knowledge/store/cleanup.ts` | 302 | Cross-reference-aware deletion, bulk cleanup |
| 12 | `chat-turn/retry-cleanup.ts` | ~190 | Idempotent cleanup of failed turn data (evidence, checkpoints, work capsules, generated outputs) |

**Chat-turn sub-modules** (extracted from stream.ts):
- `chat-turn/stream-parser.ts` — async generator for parsing Langflow SSE/JSON event streams
- `chat-turn/thinking-normalizer.ts` — thinking block/tag stripping and reasoning content extraction
- `chat-turn/tool-call-markers.ts` — `TOOL_START/END` marker processing and tool evidence normalization

## Memory Authority Snapshot

- `task-state/continuity.ts` owns project continuity buckets and active-status transitions.
- `chat-files.ts` plus artifact metadata own generated-document lineage.
- `memory-events.ts` owns the normalized persisted event log for cross-domain state changes. Add new event types there instead of introducing side logs inside routes or unrelated services.
- `honcho.ts` mirrors and enriches memory, but it is not the authority for local temporal truth, document lineage, or event history.
- `src/lib/server/db/compat.ts` is the only allowed place for narrowly scoped runtime SQLite compatibility shims when production safety demands them. It is an emergency additive fallback, not a replacement for `npm run db:prepare`.
- `tei-embedder.ts` and `tei-reranker.ts` are transport adapters only. They may improve shortlist and rerank quality, but they are not allowed to become a second authority for document identity, active focus, or temporal truth.
- `semantic-embeddings.ts` owns the durable embedding substrate for artifacts, legacy persona-cluster rows, and task states. Keep source-text hashing, upsert semantics, and readback there instead of reimplementing per-domain mini stores.
- `semantic-embedding-refresh.ts` owns async refresh/backfill orchestration on top of that store. Artifact/task/persona writers may queue refreshes there, and `memory-maintenance.ts` may run user-scoped backfill there, but do not duplicate those loops in routes or domain-specific services.
- `semantic-ranking.ts` owns generic shortlist math over stored embeddings. Domain retrieval services may consume it, but they should keep authority-specific weighting and suppression rules local instead of pushing those concerns down into the generic helper.
- `task-state.ts` may also consume `semantic-ranking.ts` for query-time task routing, but it must keep task status transitions, locked-task precedence, and project continuity truth deterministic on its own side of the boundary.

## Cross-Service Dependency Graph

```
Routes (api/chat/send, api/chat/stream)
  │
  ▼
chat-turn/request.ts ──► chat-turn/preflight.ts
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
              chat send          stream-orchestrator.ts ──► stream-parser.ts, thinking-normalizer.ts, tool-call-markers.ts
                    │                   │
                    └─────────┬─────────┘
                              ▼
                         normalizer.ts
                              │
                              ▼
                  chat-turn/finalize.ts
                    │   │   │   │
                    ▼   ▼   ▼   ▼
               messages  honcho  task-state  knowledge
                   │       │        │            │
                   └───┬───┘        │            │
                       ▼            ▼            ▼
                       │            utils/*    knowledge/store/*  chat-turn/retry-cleanup.ts
                  attachment-trace.ts (feeds stream-orchestrator, langflow, chat-files)
                       │
                  webhook-buffer.ts (feeds chat-turn streaming pipeline)
                       │
                  language.ts (feeds chat-turn request/title prompts)
                       │
                  conversation-drafts.ts (feeds conversation routes)
```

**Additional active services not shown above:**
- `auth/hooks.ts` — `requireAuth`, `getBearerToken` (canonical auth boundary for API routes)
- `prompts.ts` (src/lib/server/prompts.ts) — shared prompt configuration helpers (consumed by langflow, honcho)
- `analytics.ts` — analytics event ingestion (consumed by finalize.ts)
- `file-production/` — durable generated-file jobs, source validation, renderers, sandbox execution, retry/cancel, and legacy generated-file backfill
- `image-search.ts` — image search integration (tool endpoint at api/tools/image-search)
- `projects.ts` (src/lib/server/services/projects.ts) — project CRUD using db + schema.ts directly (active service, not legacy)
- `server/api/responses.ts` — shared JSON response helpers for API routes (consumed across route files)
- `webhook-buffer.ts` — sentence-level webhook buffering for streaming turns

**Key insight**: `finalize.ts` is the fan-out point — after a turn completes, it dispatches to persistence, evidence, memory, and Honcho sync.

## Chat-Turn Pipeline Data Flow

```
parseChatTurnRequest()        ← body, model, attachments
        │
preflightChatTurn()           ← conversation exists? attachments ready?
        │
   ┌────┴────┐
   ▼         ▼
send route  stream-orchestrator.ts ← diverge here; orchestrates full pipeline
   │      │
   │    parseUpstreamEvents()  ← Langflow SSE/JSON stream → events
   │    processToolCallMarkers()
   │    normalizeVisibleAssistantText()
   │    createServerChunkRuntime() → tokens, thinking, structured tool-call events, output cleanup
   │      │
   └──────► normalizer.ts
          │
        ▼
persistAssistantTurnState()   ← message, metadata, evidence
        │
runPostTurnTasks()            ← Honcho sync, memory maintenance trigger
        │
retry-cleanup.ts              ← idempotent cleanup on turn failure (evidence links, checkpoints,
                              generated_output artifacts, work capsules, assistant message)
```

## Knowledge Store Internal Chain

```
knowledge.ts (facade — re-exports from below)
  ├── store.ts (facade — re-exports from store/*)
  │     ├── store/core.ts         ← artifact CRUD, mapping, WORKING_SET_*_BUDGET
  │     ├── store/attachments.ts  ← upload → auto-rename → link
  │     ├── store/documents.ts    ← normalized docs, query matching
  │     └── store/cleanup.ts      ← cross-ref-aware deletion
  ├── context.ts                 ← working-set ranking, compaction status
  └── capsules.ts                ← work capsules, generated outputs
```

**Call chain for attachment upload**: `saveUploadedArtifact()` → `store/core.ts createArtifact()` → `store/core.ts syncArtifactChunks()` (delegates to `task-state/artifacts.ts`). Text extraction for prompt readiness happens through normalized-document creation, not by turning duplicate uploads into versions.

**Library upload note**: knowledge-page uploads may pass `conversationId = null`; `saveUploadedArtifact()` must skip `attached_to_conversation` link creation in that case, while `/api/knowledge/upload` validates any provided conversation id before insert and keeps Honcho sync conversation-bound.

**Document search note**: `searchKnowledgeDocuments()` in `knowledge/store/documents.ts` is the shared document search path used by `/api/knowledge/search` and the shell search modal. Keep ranking and logical-document mapping there instead of duplicating it in routes or client components.

**Chat-generated files note**: `chat-files.ts` is the single source of truth for generated-file storage, conversation-scoped listings, and authenticated user lookups for `/api/chat/files/[id]/download`. Durable creation requests enter through `/api/chat/files/produce`, while `file-production/` owns intake parsing, source validation, durable job creation/reuse, execution, retry/cancel, and legacy generated-file backfill. The preview route `/api/chat/files/[id]/preview` should stay a binary file endpoint that plugs into the shared rich viewer rather than a separate chat-only text-preview system.

**Working-documents note**: the current working-document foundation should continue to build on existing artifacts, especially `generated_output`. Do not create a second persistence or memory path for generated files separate from artifact metadata, working-set retrieval, the shared document resolver, and Honcho sync. Family lifecycle state such as `documentFamilyStatus` belongs on that same metadata contract.

**Working Document Selection note**: `working-document-selection.ts` is the authority for live Working Document signal collapse: active workspace focus, current generated document, correction targets, recently refined families, reset/move-on suppression, prompt reason-code projection, retrieval carryover, and task-evidence protection.

**Resolver note**: `document-resolution.ts` is now the authority for “which generated document/version is current or relevant”. `working-document-selection.ts` consumes its generated-family ranking result instead of reintroducing ad hoc filename, recency, or latest-output heuristics.

**Capsule note**: `knowledge/capsules.ts` still summarizes workflow, but it is no longer the authority for document lineage. Keep document family/version continuity on artifact metadata plus links, not duplicated capsule payloads.

**Langflow prompt note**: file-production workflow guidance belongs in `langflow.ts`. Keep its prompt contract aligned with the unified `produce_file` tool: source-first documents use `document_source`, program artifacts write final files to `/output`, successful work appears in chat as durable job-backed cards, and generic code-execution tools such as `run_python_repl` should not be used as a substitute when `produce_file` is available.
Authenticated account-level personalization fields such as display name and email should also enter the model prompt through `langflow.ts`, using the current request's authenticated user object instead of ad hoc route-local prompt fragments.

**Generated-file debug note**: when debugging missing chat files, the current server-side log prefixes are `[LANGFLOW]` for outbound request/session correlation, `[FILE_PRODUCTION]` for production job lifecycle and validation, `[CHAT_STREAM]` for tool-call summaries and end-of-stream generated-file handling, `[CHAT_FILES]` for persistence/sync failures, plus `[HONCHO]` and `[MEMORY_MAINTENANCE]` for downstream continuity issues. Extend those prefixes instead of inventing new one-off log tags.
**Selection-debug note**: document and memory observability should stay summary-level. `knowledge/context.ts` now emits `[CONTEXT] Working document selection` with the winning Working Document Selection signals and selected artifact ids, while `memory.ts` emits `[KNOWLEDGE_MEMORY] Selected overview source` for Knowledge Memory overview decisions. Extend those summaries instead of reintroducing noisy per-candidate logs.

**Langflow custom-tool note**: for the `File Production` node, follow Langflow's tool-mode custom-component pattern directly. The agent must see the actual `produce_file` action as the tool; do not expose an intermediate builder method like `build_tool`, or the model may call that method without ever hitting `/api/chat/files/produce`. Keep `conversationId` resolved from the Langflow session and keep only `produce_file` contract fields model-facing.

**Persona-memory note**: persona memory is delegated to Honcho in the current codebase. Do not reintroduce a local `persona-memory.ts` cluster pipeline, route-local persona caches, or a second temporal-memory subsystem.

**Memory-overview note**: `memory.ts` treats Honcho overview text as auxiliary and source-attributed. Live/cached Honcho overviews should degrade to stored Honcho conclusions or an empty state when unavailable; do not block Knowledge Memory on live overview generation.

**Honcho reset note**: cleanup paths that promise a true memory reset must also rotate the per-user Honcho peer version. Deleting sessions, conclusions, cards, or local rows is not enough if the next chat would still reuse the same Honcho peer id.
**Honcho chat-context note**: the chat prompt path should keep Honcho `session.context(...)` session-limited. Do not send a `searchQuery` there without the required `peerTarget`, do not let live Honcho context quietly broaden into workspace-level retrieval when the intent is current-session recall, and do not call live session context at all for a genuinely empty/new session that has no stored turns or snapshot yet.
**Artifact-ownership note**: artifact reads and cleanup should treat linked conversation ownership as stronger authority than `artifacts.userId` alone. Conversation-scoped working artifacts such as `generated_output` and `work_capsule` are invalid retrieval candidates once their conversation link is gone, even if a stale row still exists.

**Memory-events note**: Wave 2 now persists explicit `memory_events` rows for deadline changes, preference updates, persona fact replacement, project continuity transitions, and generated-document supersession. Use those rows for state-change history and later contradiction/repair work; do not fork that event history into capsule payloads, message metadata, or Honcho-only summaries.
**Behavior-learning note**: Wave 6 behavior signals should also flow through `memory_events`, not a separate analytics-only table. Focused working-document turns now record `document_refined` events, and retrieval may consume recent counts from those events as a bounded boost. Keep those boosts small and recent-windowed; explicit query/document matches still outrank passive behavior history.
**Working-set behavior note**: if behavior learning influences prompt carryover, route it through `working-set.ts` with the same bounded event-derived scores used by retrieval. Do not add a second prompt-only behavior heuristic that can drift away from `document-resolution.ts`.
**Workspace behavior note**: shared workspace opens may also emit `document_opened` events. Treat reopen counts as a smaller-than-refinement, smaller-than-focus signal and keep them on the same document-resolution/working-set rails instead of inventing a parallel “recent files” authority.
**Historical-family note**: `documentFamilyStatus: historical` is a lifecycle signal, not a hard filter. Retrieval and prompt carryover may downrank historical families when the turn is otherwise weak/generic, but explicit query matches, active focus, and source-jump flows should still be able to surface them.
**Persona-correction note**: persona correction or deletion requests should go through the Honcho memory actions in `memory.ts`/`honcho.ts`; do not create a route-local override list or revive the removed local salience repair path.

**Project-continuity note**: `task-state/continuity.ts` now interprets the newest `project_started` / `project_paused` / `project_resumed` event when resolving current continuity state. Explicit pause/resume phrasing from the user may write those events during turn finalization, and continuity reads should trust them before an older still-active row.
**Persona-contradiction note**: current persona contradiction handling belongs on the Honcho/memory boundary. Do not recreate broad “latest phrasing wins” heuristics in routes or prompt assembly.
**Document-preference note**: task-state evidence preference writes should stay document-family aware. If a user pins or excludes one artifact version inside a working-document family, clear sibling user preference links for that same family so one version remains current for the task.
**Working Document signal note**: structured live signals such as active workspace focus, explicit user correction phrasing, the most recently refined document family, and explicit move-on/reset phrasing should stay first-class in Working Document Selection. Prefer those signals over ad hoc semantic-only rescoring when the user is clearly revising or explicitly leaving a current document.
**Working Document assembly note**: use `working-document-selection.ts` as the shared source for live document focus/correction/current-output/recently-refined-family/reset signals. Avoid rebuilding that logic independently inside `knowledge/context.ts`, `task-state.ts`, or `honcho.ts`, because drift there will make prompt selection and evidence selection disagree about the “current” document.
**Prompt-selection note**: `selectWorkingSetArtifactsForPrompt(...)` must consume Working Document Selection prompt reason-code views before calling generated-document prompt eligibility. Persisted DB reason codes describe the last turn, not the current one.
**Retrieval note**: generated-document retrieval in `knowledge/context.ts` should also follow the Working Document Selection retrieval view. Keep a preferred/recently refined family active on generic refinement turns, but do not drag in unrelated generated-document families unless the query explicitly matches them, and let reset/move-on phrasing suppress that carryover.
**TEI note**: semantic retrieval work should layer on top of those same contracts. Use `tei-embedder.ts` for shortlist generation and `tei-reranker.ts` for top-N refinement, but keep deterministic filters, document-family authority, Working Document Selection resets, and historical-family penalties above the TEI scores.
**Reranker cutover note**: current evidence rerank in `task-state.ts`, chunk rerank in `task-state/artifacts.ts`, historical section rerank in `prompt-context.ts`/`honcho.ts`, and tool/web evidence rerank in `message-evidence.ts` should all stay on the shared TEI reranker path. Do not route those back through the generic control-model chat-completions client.
**Embedding-store note**: keep embedding persistence unified in `semantic-embeddings.ts` + `semantic_embeddings`. Artifact, persona, and task semantic retrieval waves may project different subject types onto that table, but they should not create separate embedding tables unless there is a measured operational reason.
**Embedding-refresh note**: live write paths should queue semantic refreshes asynchronously through `semantic-embedding-refresh.ts`, while slower user-wide backfill belongs in `memory-maintenance.ts`. Do not make artifact creation, task checkpointing, or persona dreaming wait on TEI round-trips.
**TEI diagnostics note**: keep semantic observability compact and shared through `tei-observability.ts`. Document retrieval, persona prompt recall, and task routing may log one retrieval summary with latency/fallback/candidate counts/winner mode, but avoid duplicating those fields under domain-specific ad hoc log formats.
**Document semantic note**: `knowledge/store/documents.ts` is now the artifact-level semantic retrieval path for Wave 5. Let it compose lexical candidate fetch, stored-embedding shortlist, and TEI rerank, then keep generated-family identity/focus/history enforcement in `document-resolution.ts` and `knowledge/context.ts`.
**Persona semantic note**: the legacy `persona_cluster` embedding subject type may exist in persisted data, but current prompt-time persona recall should stay on the Honcho/memory boundary rather than a revived local semantic-search surface.
**Task semantic note**: `task-state.ts` may use stored task-state embeddings and bounded rerank scores when deciding whether to continue, revive, or create a task for the current turn, but do not let those scores bypass deterministic status rules, locked-task precedence, or project continuity event truth in `task-state/continuity.ts`.
**Preview-performance note**: keep heavy preview dependencies off the idle shell path. `document-workspace/DocumentWorkspace.svelte`, `FileProductionCard.svelte`, `document-workspace/DocumentPreviewRenderer.svelte`, and the `document-workspace/preview-runtime/` adapters lazy-load the rich preview component, markdown renderer, Office/PDF libraries, and PDF worker URL; do not revert those paths back to eager imports unless you re-measure the client bundle cost.
**Transport note**: preserve `activeDocumentArtifactId` end-to-end through `streaming.ts`, `/api/chat/stream`, `/api/chat/retry`, and `langflow.ts`. Working Document Selection cannot recover a workspace-focused document if the browser/request layer drops that id.
**Repair-loop note**: Wave 5 repair work should reuse the existing generated-output duplicate classifier in `evidence-family.ts` and run it from `memory-maintenance.ts`. Do not invent a parallel “document cleanup” service when retrieval-class repair already compresses low-value duplicate drafts deterministically. The same repair surface now also owns dormant generated-document family downgrades to shared `documentFamilyStatus: "historical"` metadata.
**Salience-repair note**: do not add a separate maintenance-only salience cache or a second persona-ranking subsystem while persona support is delegated to Honcho.

## Task-State Submodule Flow

```
task-state.ts (facade — 1,535 lines)
  │
  ├── control-model.ts    ← context summarizer API client for routing/verification/JSON tasks
  ├── tei-reranker.ts     ← retrieval/evidence reranker client
  ├── continuity.ts       ← project memory, focus items, task-project linking
  ├── artifacts.ts        ← chunk sync, prompt snippets, historical context
  └── mappers.ts          ← row-to-type mappers (shared by above)
```

**Context assembly path**: `langflow.ts` requests Prompt Context from `chat-turn/context-selection.ts buildConstructedContext()`; that boundary composes Honcho session/persona candidates from `honcho.ts loadHonchoPromptContext()`, Knowledge candidates, Task-State candidates, Context Budget, and Prompt Context selection. Honcho stays a memory adapter, not the prompt assembler.

## Shared Utils Usage

| Util | Used by | Purpose |
|------|---------|---------|
| `utils/prompt-context.ts` | `honcho.ts`, `task-state.ts` | Context section building, compaction, serialization to token budget |
| `utils/json.ts` | `task-state/`, `knowledge/` | Safe JSON parsing for DB-stored arrays/records |
| `utils/text.ts` | `task-state/`, `messages.ts` | Whitespace normalization, text clipping |
| `utils/tokens.ts` | `prompt-context.ts`, `context.ts` | Token estimation for budget checks |
