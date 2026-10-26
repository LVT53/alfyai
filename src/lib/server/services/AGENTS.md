# Server Services — Internal Map

Parent: [AGENTS.md](../../../../AGENTS.md) holds the rules that apply everywhere. This file covers each service's role and ownership, **cross-service dependencies, complexity ordering, and data flow**; Rules In Other Files, at the end, says which rules live in a subfolder's file.

## Complexity Hotspots (by line count)

| Rank | File | Lines | Why large |
|------|------|-------|-----------|
| 1 | `task-state.ts` | ~1,558 | Facade + task routing, evidence selection, checkpointing, steering |
| 2 | `stream-orchestrator.ts` | ~558 | Full chat-turn streaming pipeline, neutral model-run event adaptation, downstream AI SDK UI stream framing |
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
- `chat-turn/stream.ts` — AI SDK UI stream framing, stream runtime cleanup, native tool-call accumulation, and stream error classification
- `chat-turn/thinking-normalizer.ts` — thinking block/tag stripping and reasoning content extraction

## Memory Authority Snapshot

- `task-state/continuity.ts` owns project continuity buckets and active-status transitions.
- `chat-files.ts` plus artifact metadata own generated-document lineage.
- `memory-behavior-log.ts` owns the normalized persisted behavioral event log (the `memoryEvents` / `memory_events` table) for cross-domain state changes, recorded via `recordMemoryBehaviorEvent`. Add new event types there instead of introducing side logs inside routes or unrelated services. This behavioral log is deliberately distinct from Memory Rework decision telemetry (`recordMemoryReworkTelemetry` in `memory-profile/telemetry.ts`) — do not conflate the two.
- `src/lib/server/db/compat.ts` is the only allowed place for narrowly scoped runtime SQLite compatibility shims when production safety demands them. It is an emergency additive fallback, not a replacement for `npm run db:prepare`.
- `tei-embedder.ts` and `tei-reranker.ts` are transport adapters only. They may improve shortlist and rerank quality, but they are not allowed to become a second authority for document identity, active focus, or temporal truth.
- `semantic-embeddings.ts` owns the durable embedding substrate for artifacts, memory profile items, and task states. Keep source-text hashing, upsert semantics, and readback there instead of reimplementing per-domain mini stores.
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
              chat send          stream-orchestrator.ts ──► stream.ts, thinking-normalizer.ts
                    │                   │
                    └─────────┬─────────┘
                              ▼
                         normalizer.ts
                              │
                              ▼
                  chat-turn/finalize.ts
                    │   │   │   │
                    ▼   ▼   ▼   ▼
               messages  task-state  knowledge
                   │          │           │
                   └────┬─────┘           │
                       ▼            ▼            ▼
                       │            utils/*    knowledge/store/*  chat-turn/retry-cleanup.ts
                  attachment-trace.ts (feeds stream-orchestrator, chat-files)
                       │
                  language.ts (deterministic readers: the fallback and the title/headline check; chat-turn/conversation-language.ts asks the model which language the conversation is in after a reply)
                       │
                  conversation-drafts.ts (feeds conversation routes)
```

**Additional active services not shown above:**
- `auth/hooks.ts` — `requireAuth`, `getBearerToken` (canonical auth boundary for API routes)
- `prompts.ts` (src/lib/server/prompts.ts) — shared prompt configuration helpers (consumed by normal-chat context)
- `analytics.ts` — analytics event ingestion plus the Analytics Dashboard Read Model. Event ingestion records usage/conversation facts during chat-turn finalization. `getAnalyticsDashboardReadModel(...)` projects the `/api/analytics` dashboard payload, including personal analytics, admin-only system/per-user analytics, timeline rows, available months, and mock analytics. The route remains an adapter for auth, `mock`/`month`/`systemMonth`/`timeline` query parameters, and `json(...)` mapping.
- `file-production/` — durable generated-file jobs, source validation, renderers, sandbox execution, retry/cancel, storage, and legacy generated-file backfill
- `generated-file-serving.ts` — generated chat-file lookup, ownership fallback, assigned/succeeded-job eligibility, byte/type validation, and preview/download headers for chat routes and Working Document generated-output serving
- `image-search.ts` — image search integration used by direct normal-chat tools
- `vision/` — what the chat model sees of an image: preparation to a JPEG within a pixel budget, who may receive pixels; its rules are in `vision/AGENTS.md`
- `projects.ts` (src/lib/server/services/projects.ts) — project CRUD using db + schema.ts directly (active service, not legacy)
- `server/api/responses.ts` — shared JSON response helpers for API routes (consumed across route files)

**Key insight**: `finalize.ts` is the fan-out point — after a turn completes, it dispatches to persistence, evidence, and memory.

**Analytics Dashboard Read Model note**: keep `/api/analytics` payload assembly in `analytics.ts` behind `getAnalyticsDashboardReadModel(...)`. The route adapter should authenticate, parse query parameters, call the read-model interface, and return JSON; it should not import database tables, Drizzle helpers, provider configuration, or grouping/reducer helpers. Privacy behavior remains governed by the existing Account Erasure boundary and ADR 0029: person-linked analytics may feed authorized dashboard projections while retained aggregate behavior must not become a second analytics privacy policy.

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
   │    runStreamingNormalChatSendModel() ← neutral Normal Chat stream events after model-run provider-attempt policy
   │    normalizeVisibleAssistantText()
   │    createServerChunkRuntime() → tokens, thinking, structured tool-call events, output cleanup
   │      │
   └──────► normalizer.ts
          │
        ▼
persistAssistantTurnState()   ← message, metadata, evidence
        │
runPostTurnTasks()            ← memory maintenance trigger
        │
retry-cleanup.ts              ← idempotent cleanup on turn failure (evidence links, checkpoints,
                              generated_output artifacts, work capsules, assistant message)
```

## Knowledge Store Internal Chain

```
knowledge.ts (facade — re-exports from below)
  ├── knowledge/upload-intake.ts ← shared upload limits, conversation validation, completion
  ├── store.ts (facade — re-exports from store/*)
  │     ├── store/core.ts         ← artifact CRUD, mapping, WORKING_SET_*_BUDGET
  │     ├── store/attachments.ts  ← upload → auto-rename → link
  │     ├── store/documents.ts    ← normalized docs, query matching
  │     └── store/cleanup.ts      ← cross-ref-aware deletion
  ├── context.ts                 ← working-set ranking, compaction status
  └── capsules.ts                ← work capsules, generated outputs
```

**Call chain for attachment upload**: upload routes receive bytes or chunk metadata, then call `knowledge/upload-intake.ts`. The intake boundary resolves shared limits, validates any supplied conversation id, calls `saveUploadedArtifact()` / `saveUploadedArtifactFromStoredFile()`, creates normalized artifacts, and resolves prompt readiness. Store writes still flow through `store/core.ts createArtifact()` → `store/core.ts syncArtifactChunks()` (delegates to `task-state/artifacts.ts`). Text extraction for prompt readiness happens through normalized-document creation, not by turning duplicate uploads into versions.

**Library upload note**: knowledge-page uploads may pass `conversationId = null`; `saveUploadedArtifact()` must skip `attached_to_conversation` link creation in that case. Knowledge upload adapters must use `upload-intake.ts` for provided conversation validation and prompt readiness instead of importing conversation or store helpers directly.

**Workspace Search note**: `workspace-search.ts` owns server-backed Workspace Search for `/api/workspace-search`, including conversation title, project, message-body, and openable-document result shaping with server-owned snippets and ranking. It composes logical document listing/search from `knowledge/store/documents.ts`; keep document persistence, grouping, and artifact mapping in the knowledge store instead of duplicating them in routes or client components.

**Chat-generated files note**: `chat-files.ts` owns generated-file storage and conversation-scoped listings. Durable creation requests enter through `/api/chat/files/produce`, while `file-production/` owns intake parsing, source validation, durable job creation/reuse, execution, retry/cancel, storage-adapter linking, and legacy generated-file backfill. `generated-file-serving.ts` owns authenticated generated-file serving for `/api/chat/files/[id]/preview`, `/api/chat/files/[id]/download`, and Working Document generated-output `sourceChatFileId` delegation, including ownership fallback, assigned/succeeded-job eligibility, byte/type validation, and preview/download headers. The preview route should stay a binary file endpoint that plugs into the shared rich viewer rather than a separate chat-only text-preview system.

**Working-documents note**: the current working-document foundation should continue to build on existing artifacts, especially `generated_output`. Do not create a second persistence or memory path for generated files separate from artifact metadata, working-set retrieval, and the shared document resolver. Family lifecycle state such as `documentFamilyStatus` belongs on that same metadata contract.

**Working Document Selection note**: `working-document-selection.ts` is the authority for live Working Document signal collapse: active workspace focus, current generated document, correction targets, recently refined families, reset/move-on suppression, prompt reason-code projection, retrieval carryover, and task-evidence protection.

**Resolver note**: `document-resolution.ts` is now the authority for “which generated document/version is current or relevant”. `working-document-selection.ts` consumes its generated-family ranking result instead of reintroducing ad hoc filename, recency, or latest-output heuristics.

**Capsule note**: `knowledge/capsules.ts` still summarizes workflow, but it is no longer the authority for document lineage. Keep document family/version continuity on artifact metadata plus links, not duplicated capsule payloads.

**Normal Chat prompt note**: file-production workflow guidance belongs in the base prompt text (`src/lib/server/prompts.ts`, which `normal-chat-context.ts` assembles with the recorded prompt name and the turn guidance) and the app-owned AI SDK tool boundary (`normal-chat-tools/produce-file.ts` owns the model-facing `produce_file` contract). Keep its prompt contract aligned with the unified `produce_file` tool: source-first documents use `document_source`, program artifacts write final files to `/output`, successful work appears in chat as durable job-backed cards, and generic code-execution tools such as `run_python_repl` should not be used as a substitute when `produce_file` is available.
Authenticated account-level personalization fields such as display name and email should also enter the model prompt through the Normal Chat context boundary, using the current request's authenticated user object instead of ad hoc route-local prompt fragments.

**Generated-file debug note**: when debugging missing chat files, the current server-side log prefixes are `[NORMAL_CHAT_CONTEXT]` for prompt-context preparation, `[FILE_PRODUCTION]` for production job lifecycle and validation, `[CHAT_STREAM]` for tool-call summaries and end-of-stream generated-file handling, `[CHAT_FILES]` for persistence/sync failures, plus `[MEMORY_MAINTENANCE]` for downstream continuity issues. Extend those prefixes instead of inventing new one-off log tags.
**Selection-debug note**: document and memory observability should stay summary-level. `knowledge/context.ts` now emits `[CONTEXT] Working document selection` with the winning Working Document Selection signals and selected artifact ids, while projection-backed Memory Profile paths should use compact `[KNOWLEDGE_MEMORY]` and `[MEMORY_MAINTENANCE]` summaries. Extend those summaries instead of reintroducing noisy per-candidate logs.

**Direct file-production tool note**: normal chat exposes `produce_file` through the app-owned AI SDK tool boundary. The agent must see the actual `produce_file` action as the tool, with `conversationId` supplied by the runtime and only `produce_file` contract fields model-facing.

**Tool execution envelope note**: app-backed Normal Chat tools in `normal-chat-tools/` should use the shared envelope in `normal-chat-tools/shared.ts` for timeout, abort, model-safe failure text, and recorder behavior. Keep each tool adapter focused on input validation, domain execution, output compaction, and evidence metadata.

**Web-grounding note**: `web-grounding.ts` is the Normal Chat authority for compact `research_web` source/evidence payloads, grounded web candidates, grounded metadata, URL canonicalization, and citation-audit source extraction. Keep freshness/search instructions in `normal-chat-context.ts`, but route retrieved web source/evidence shaping and final citation audit handoff through Web Grounding.

**Provider-model runtime defaults note**: `provider-model-runtime-defaults.ts` owns provider-model runtime and persistence defaults for context windows, target constructed context, compaction thresholds, max output tokens, reasoning effort, and thinking mode. Env parsing, `config-store.ts`, `provider-models.ts`, context budgeting, prompt-limit resolution, and Normal Chat Model Run should consume that projection instead of duplicating context ratio math.

**URL provenance note**: `url-provenance/` (facade `index.ts`) is the server's half of ADR-0068: the per-user, in-memory source ledger (`ledger.ts`, written through `sources.ts`'s `note*` writers from the tool recorder, the conversation-detail read model, Atlas and canvas-web; read by the favicon and thumbnail routes and report favicons) and the per-turn check (`turn.ts`) that `fetch_url` and `produce_file` pictures pass. Comparison and extraction come from `$lib/shared/url-provenance`; the server's own outbound fetches go through `$lib/server/outbound`. Keep it in memory: an incognito chat promises no writes.

**Normal Chat stability snapshot note**: `normal-chat-stability-snapshot.ts` owns aggregate, content-free Normal Chat stability diagnostics: active stream capacity, provider/model readiness, tool timeout/readiness, web-grounding configuration, context-limit validity, and maintenance metric summaries. Admin route adapters may expose it after `requireAdmin`, but must not return prompts, messages, search queries, raw source text, API keys, or user ids.

**ChatGPT import note**: `chatgpt-import/` runs the import inside its request. Its `import_jobs` row is a progress and audit record, not a job (left out of the job engine on purpose: `docs/plans/jobs-merge/design.md`, "The ChatGPT import"), and `import-row.ts` is the one writer of that table: one import per person (a second is refused, 409 with `errorKey` `chatgptImport.alreadyRunning`), every row still `processing` is settled when the server starts, and a row that has not moved for 30 minutes is settled when the person's next import starts. The import queues each conversation for the memory judge itself, when its messages are stored. The summaries an import owes are read from what is stored, never recorded (imported, not a fork or incognito, no summary, made after the last memory reset), and `owed-summaries.ts` writes them one model call at a time per person: the import starts that drain and memory maintenance starts it again, so a restart only pauses it. It recovers derived state like maintenance's backfills and holds no job lifecycle. Nothing reads the imported conversations' vectors, which is why losing them to a restart is harmless; `embeddings.test.ts` fails when a reader appears.

**Persona-memory note**: active user-facing profile memory is owned by the app-local Memory Profile Projection in `memory-profile/`, fed by the LLM intake judge and nightly consolidation. Do not reintroduce a local `persona-memory.ts` cluster pipeline, route-local persona caches, a regex-based intake path, or a second temporal-memory subsystem.

**Memory Profile note**: `memory.ts` is the stable public entrypoint for the Knowledge Base Memory Profile, kept for the `/api/knowledge/memory/*` routes; its implementation is split (C6) into `knowledge-memory-read.ts` (the read/serialize surface: `getKnowledgeMemory*`, overview/summary, timeline) and `knowledge-memory-actions.ts` (the v2 action-dispatch surface: `applyKnowledgeMemoryAction`). It should read the durable Memory Profile Projection from `memory-profile/`, return the same active profile that chat may use for ordinary personalization, and keep `/api/knowledge/memory/overview` as a projection-backed compatibility wrapper. Do not make the Knowledge page depend on a live external overview service, raw markdown cleanup, task-memory tables, or focus-continuity sections.

**Memory Profile internals note**: the `memory-profile/index.ts` barrel was removed (C6) — do NOT re-add it; `memory-profile/seams.test.ts` fails if the file returns or if any importer reintroduces a bare `memory-profile` barrel import. Import the narrow internal seams directly: `reset-generation.ts` for reset guards, `projection-store.ts` for projection item writes, `read-model.ts` for Knowledge Base read models, `active-context.ts` plus `telemetry.ts` for prompt-context callers, `review.ts` for Guided Memory Review lifecycle, and `dirty-ledger.ts` for dirty marking/listing. Ordinary prompt/read paths must not statically load `normal-chat-control-model.ts`.

**Memory reset note**: cleanup paths that promise a true memory reset must advance the per-user memory reset generation so stale projection/dirty-ledger rows are guarded out. Deleting rows is not enough if in-flight maintenance could still write against the old generation.
**Artifact-ownership note**: artifact reads and cleanup should treat linked conversation ownership as stronger authority than `artifacts.userId` alone. Conversation-scoped working artifacts such as `generated_output` and `work_capsule` are invalid retrieval candidates once their conversation link is gone, even if a stale row still exists.

**Memory-events note**: Wave 2 now persists explicit `memory_events` rows for deadline changes, preference updates, persona fact replacement, project continuity transitions, and generated-document supersession. Use those rows for state-change history and later contradiction/repair work; do not fork that event history into capsule payloads or message metadata.
**Behavior-learning note**: Wave 6 behavior signals should also flow through `memory_events`, not a separate analytics-only table. Focused working-document turns now record `document_refined` events, and retrieval may consume recent counts from those events as a bounded boost. Keep those boosts small and recent-windowed; explicit query/document matches still outrank passive behavior history.
**Working-set behavior note**: if behavior learning influences prompt carryover, route it through `working-set.ts` with the same bounded event-derived scores used by retrieval. Do not add a second prompt-only behavior heuristic that can drift away from `document-resolution.ts`.
**Workspace behavior note**: shared workspace opens may also emit `document_opened` events. Treat reopen counts as a smaller-than-refinement, smaller-than-focus signal and keep them on the same document-resolution/working-set rails instead of inventing a parallel “recent files” authority.
**Historical-family note**: `documentFamilyStatus: historical` is a lifecycle signal, not a hard filter. Retrieval and prompt carryover may downrank historical families when the turn is otherwise weak/generic, but explicit query matches, active focus, and source-jump flows should still be able to surface them.
**Persona-correction note**: persona correction or deletion requests should go through the knowledge-memory action dispatch in `knowledge-memory-actions.ts` (re-exported from `memory.ts`) over `memory-profile/`; do not create a route-local override list or revive the removed local salience repair path.

**Project-continuity note**: `task-state/continuity.ts` now interprets the newest `project_started` / `project_paused` / `project_resumed` event when resolving current continuity state. Explicit pause/resume phrasing from the user may write those events during turn finalization, and continuity reads should trust them before an older still-active row.
**Persona-contradiction note**: current persona contradiction handling belongs on the memory-profile boundary (judge + consolidation). Do not recreate broad “latest phrasing wins” heuristics in routes or prompt assembly.
**Document-preference note**: task-state evidence preference writes should stay document-family aware. If a user pins or excludes one artifact version inside a working-document family, clear sibling user preference links for that same family so one version remains current for the task.
**Working Document signal note**: structured live signals such as active workspace focus, explicit user correction phrasing, the most recently refined document family, and explicit move-on/reset phrasing should stay first-class in Working Document Selection. Prefer those signals over ad hoc semantic-only rescoring when the user is clearly revising or explicitly leaving a current document.
**Working Document assembly note**: use `working-document-selection.ts` as the shared source for live document focus/correction/current-output/recently-refined-family/reset signals. Avoid rebuilding that logic independently inside `knowledge/context.ts` or `task-state.ts`, because drift there will make prompt selection and evidence selection disagree about the “current” document.
**Prompt-selection note**: `selectWorkingSetArtifactsForPrompt(...)` must consume Working Document Selection prompt reason-code views before calling generated-document prompt eligibility. Persisted DB reason codes describe the last turn, not the current one.
**Retrieval note**: generated-document retrieval in `knowledge/context.ts` should also follow the Working Document Selection retrieval view. Keep a preferred/recently refined family active on generic refinement turns, but do not drag in unrelated generated-document families unless the query explicitly matches them, and let reset/move-on phrasing suppress that carryover.
**TEI note**: semantic retrieval work should layer on top of those same contracts. Use `tei-embedder.ts` for shortlist generation and `tei-reranker.ts` for top-N refinement, but keep deterministic filters, document-family authority, Working Document Selection resets, and historical-family penalties above the TEI scores.
**Reranker cutover note**: current evidence rerank in `task-state.ts`, chunk rerank in `task-state/artifacts.ts`, historical section rerank in `prompt-context.ts`, and tool/web evidence rerank in `message-evidence.ts` should all stay on the shared TEI reranker path. Do not route those back through the generic control-model chat-completions client.
**Embedding-store note**: keep embedding persistence unified in `semantic-embeddings.ts` + `semantic_embeddings`. Artifact, persona, and task semantic retrieval waves may project different subject types onto that table, but they should not create separate embedding tables unless there is a measured operational reason.
**Embedding-refresh note**: live write paths should queue semantic refreshes asynchronously through `semantic-embedding-refresh.ts`, while slower user-wide backfill belongs in `memory-maintenance.ts`. Do not make artifact creation, task checkpointing, or persona dreaming wait on TEI round-trips.
**TEI diagnostics note**: keep semantic observability compact and shared through `tei-observability.ts`. Document retrieval, persona prompt recall, and task routing may log one retrieval summary with latency/fallback/candidate counts/winner mode, but avoid duplicating those fields under domain-specific ad hoc log formats.
**Document semantic note**: `knowledge/store/documents.ts` is now the artifact-level semantic retrieval path for Wave 5. Let it compose lexical candidate fetch, stored-embedding shortlist, and TEI rerank, then keep generated-family identity/focus/history enforcement in `document-resolution.ts` and `knowledge/context.ts`.
**Persona semantic note**: the legacy `persona_cluster` embedding subject type may exist in persisted data, but current prompt-time persona recall should stay on the memory-profile boundary rather than a revived local semantic-search surface.
**Task semantic note**: `task-state.ts` may use stored task-state embeddings and bounded rerank scores when deciding whether to continue, revive, or create a task for the current turn, but do not let those scores bypass deterministic status rules, locked-task precedence, or project continuity event truth in `task-state/continuity.ts`.
**Preview-performance note**: keep heavy preview dependencies off the idle shell path. `document-workspace/DocumentWorkspace.svelte`, `FileProductionCard.svelte`, `document-workspace/DocumentPreviewRenderer.svelte`, and the `document-workspace/preview-runtime/` adapters lazy-load the rich preview component, markdown renderer, Office/PDF libraries, and PDF worker URL; do not revert those paths back to eager imports unless you re-measure the client bundle cost.
**Transport note**: preserve `activeDocumentArtifactId` end-to-end through `streaming.ts`, `/api/chat/stream`, `/api/chat/retry`, and the Normal Chat model-run/context boundaries. Working Document Selection cannot recover a workspace-focused document if the browser/request layer drops that id.
**Repair-loop note**: Wave 5 repair work should reuse the existing generated-output duplicate classifier in `evidence-family.ts` and run it from `memory-maintenance.ts`. Do not invent a parallel “document cleanup” service when retrieval-class repair already compresses low-value duplicate drafts deterministically. The same repair surface now also owns dormant generated-document family downgrades to shared `documentFamilyStatus: "historical"` metadata.
**Salience-repair note**: do not add a separate maintenance-only salience cache or a second persona-ranking subsystem; persona support is owned by the local memory-profile projection.

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

**Context assembly path**: `normal-chat-context.ts` requests Prompt Context from `chat-turn/context-selection.ts buildConstructedContext()`; that boundary composes local session/summary continuity, active Memory Profile candidates from `memory-profile/`, Knowledge candidates, Task-State candidates, Context Budget, and Prompt Context selection.

## Shared Utils Usage

| Util | Used by | Purpose |
|------|---------|---------|
| `utils/prompt-context.ts` | `context-selection.ts`, `task-state.ts` | Context section building, compaction, serialization to token budget |
| `utils/json.ts` | `task-state/`, `knowledge/` | Safe JSON parsing for DB-stored arrays/records |
| `utils/text.ts` | `task-state/`, `messages.ts` | Whitespace normalization, text clipping |
| `utils/tokens.ts` | `prompt-context.ts`, `context.ts` | Token estimation for budget checks |

## Service Ownership

- TEI embedder/reranker transport belongs in thin server services. Do not bury retrieval authority or semantic tie-break logic inside the raw TEI clients.
- TEI embedding persistence belongs in the shared `semantic_embeddings` store, not in per-feature side tables. Keep artifact and task semantic storage on the same substrate; legacy `persona_cluster` embedding rows may exist, but do not revive a local persona-cluster pipeline around them.
- `src/lib/server/services/semantic-embedding-refresh.ts` owns async embedding refresh/backfill orchestration. Mutation boundaries may queue refresh work there, and maintenance may run the slower backfill sweep there, but routes should not open-code subject hashing, TEI embedding calls, or per-domain refresh loops.
- `src/lib/server/services/semantic-ranking.ts` owns generic embedding-based shortlist math. Domain services such as `knowledge/store/documents.ts` may compose it with their own deterministic filters and rerank rules, but they should not each reimplement vector similarity from scratch.
- `src/lib/server/services/tei-observability.ts` owns compact TEI retrieval summaries. Domain services may report shortlist/rerank latency, fallback reasons, candidate counts, and winner mode there, but do not create route-local debug spam or a second telemetry vocabulary for the same semantic paths.
- `src/lib/server/services/messages.ts` owns persisted assistant-message metadata such as evidence summaries. Do not invent route-local shadow storage for those fields.
- `src/lib/server/services/normal-chat-context.ts` owns Normal Chat prompt assembly: it builds the prompt from the base prompt, the recorded prompt name and the turn guidance, and the turn guidance carries the always-on date-before-search guidance. The base prompt text itself, including the file-production guidance, is written in `src/lib/server/prompts.ts` (which `normal-chat-context.ts` consumes through `getSystemPrompt`), and the model-facing rules for each tool live on the tool (`src/lib/server/services/normal-chat-tools/`, for `produce_file` in `produce-file.ts`; ADR-0055). Do not reintroduce route-local prompt guards for freshness-sensitive search behavior.
- `src/lib/server/services/web-grounding.ts` owns Normal Chat web grounding payloads: model-safe `research_web` source/evidence shaping, grounded web candidates/metadata, citation URL extraction, and citation-audit source extraction. Do not duplicate web source canonicalization or research evidence payload shaping inside tools, routes, or citation audit code.
- `src/lib/model-context-defaults.ts` owns shared context-window derived defaults, and `src/lib/server/services/provider-model-runtime-defaults.ts` owns provider-model runtime/persistence projection for context limits, max output tokens, reasoning, and thinking. Env parsing, config-store overrides, provider-model seeding, context budgeting, prompt-limit resolution, and Normal Chat Model Run must consume those defaults instead of duplicating ratio math.
- `src/lib/server/services/normal-chat-stability-snapshot.ts` owns content-free Normal Chat stability diagnostics for streams, providers, tools, web grounding, context defaults, and maintenance. Admin routes may expose that snapshot after authorization, but they must not leak prompts, messages, queries, raw source text, API keys, or user ids.
- `src/lib/server/services/normal-chat-model/` owns Vercel AI SDK/OpenAI-compatible model execution for Normal Chat, including plain/streaming provider-attempt policy, timeout failover, provider rate-limit fallback, unsupported-tool fallback, provider usage mapping, and neutral model-run events; `src/lib/server/services/normal-chat-tools/` owns app-backed AI SDK tools and their shared execution envelope. Do not reintroduce provider retry policy in chat-turn routes/orchestrators, hand-roll per-tool timeout/abort/recording shells, or add a hidden external orchestration runtime for these paths. `normal-chat-model/sampling.ts`'s `resolveModelCallSampling` is the only way a model call gets its sampling: the chat run and every internal call (thought-step status lines, rail summary, titles, summaries, memory judge, Apps, `@Alfy` replies) take the provider family's profile, declared once as `defaultSampling` in `provider-compatibility.ts` (temperature and top_p as call options from the helper, top_k by the provider builder's body injection); a caller names its own temperature only for a deterministic machine-read answer, listed with its reason in `sampling.test.ts`, and a new model call outside that route fails that test.
- `src/lib/server/services/title-generator.ts` owns title prompt selection by language (the person's own title language if they set one, else the language the turn named for the conversation after its reply and recorded on it, so the title agrees with the chips) and code-specific title prompt appendices, while the prompt text itself flows through `src/lib/server/config-store.ts` and admin settings.
- `src/lib/server/services/semantic-embeddings.ts` owns durable embedding persistence for artifacts, legacy persona-cluster rows, and task states. Do not hide embedding upserts or source-text hashing in route files or domain-specific side helpers.


## Chat Flow: Conversation Detail And Upstream Services

- Conversation detail hydration:
  - [`src/lib/server/services/conversation-detail/read-model.ts`](conversation-detail/read-model.ts)
    - Owns refreshable `/api/conversations/[id]` GET payload assembly for chat page load and browser hydration.
    - Assembles bootstrap and full detail payloads, including defaults, child-fork message decoration, task-state continuity attachment, draft/generated-file/File Production/context-compression/cost fields, and active Skill Session public serialization.
    - The route GET handler stays an auth/HTTP adapter that delegates to `getConversationDetail(...)`.
- Upstream integrations:
  - [`src/lib/server/services/normal-chat-context.ts`](normal-chat-context.ts)
    - Owns model-facing prompt assembly, outbound search/date guidance, context fit, and authenticated account-level prompt personalization fields such as display name and email.
  - [`src/lib/server/services/normal-chat-model/`](normal-chat-model/)
    - Owns Vercel AI SDK/OpenAI-compatible plain and streaming model execution, provider-attempt/failover policy, provider usage mapping, tool-call events, and neutral model-run events.
  - [`src/lib/server/services/provider-model-runtime-defaults.ts`](provider-model-runtime-defaults.ts)
    - Owns provider-model runtime and persistence defaults for context limits, max output tokens, reasoning effort, and thinking mode.
  - [`src/lib/server/services/normal-chat-stability-snapshot.ts`](normal-chat-stability-snapshot.ts)
    - Owns content-free operational stability snapshots for Normal Chat streams, providers, tools, web grounding, context limits, and maintenance metrics.
  - [`src/lib/server/services/normal-chat-tools/`](normal-chat-tools/)
    - Owns app-backed AI SDK tools such as `produce_file`, `research_web` (Parallel Search), `fetch_url` (Parallel Extract, on-demand page read), `image_search` (Brave), and `memory_context`, plus the shared tool execution envelope for timeout, abort, model-safe failure, and recorder behavior.
  - [`src/lib/server/services/normal-chat-control-model.ts`](normal-chat-control-model.ts)
    - Owns structured JSON control-model calls used by context compression and similar control tasks.
  - [`src/lib/server/services/title-generator.ts`](title-generator.ts)
  - [`src/lib/server/services/messages.ts`](messages.ts)
  - [`src/lib/server/services/message-evidence.ts`](message-evidence.ts)
    - Owns evidence channel types for document-backed artifacts

Do:

- put refreshable conversation detail GET payload assembly in `src/lib/server/services/conversation-detail/read-model.ts`; keep `src/routes/api/conversations/[id]/+server.ts` transport-oriented

## Additional Active Services

Other services in active use:

- Server utilities and helpers:
  - [`src/lib/server/auth/hooks.ts`](../auth/hooks.ts) — `requireAuth`, `getBearerToken` helpers. Canonical auth enforcement point for API routes; mirrors `hooks.server.ts` logic in a reusable form.
  - [`src/lib/server/services/auth.ts`](auth.ts) — sessions and the account-password check; nothing else reads or writes the `sessions` table by a token. `sessions.id` holds `hashSessionToken(token)` (SHA-256 hex) and the cookie holds the token: `createSession`, `validateSession`, `deleteSession` and `revokeOtherSessions` take the TOKEN and hash inside, so never look a session up, or write one, by a raw cookie value, and never hand them a stored id. The expiry is a `Date` written through Drizzle (the column is read back in seconds; a raw millisecond count is what once kept a session from ever ending on the server). A password change (`changePassword`) writes the new hash and signs out every other device in ONE transaction, so a revoke that fails leaves the password as it was; the count that goes back to the Profile card is of the sessions that were live, though every other row is deleted (`countLiveSessions`: not rows that had already ended, nor the stray rows a deploy leaves). The admin's revoke is `revokeAllSessions`; both revokes run through the `QueryExecutor` they are handed (ADR-0059: pass the executor on, never its `.db`; there is no default, and `auth.ts` imports the type only, because `db/query-executor.ts` binds the app's database when it is imported and this file is imported by nearly everything), and `sweepExpiredSessions` runs from `auth-sweep.ts`, the one five-minute timer started beside the job engine in `hooks.server.ts` (it also removes rows that end beyond the longest session plus a day, which only a release that still wrote milliseconds can leave). `checkCurrentPassword` is the one place a settings action re-asks for the account password (the sign-in's bcrypt comparison through `login-rate-limit.ts`, in its `account:` namespace): the password change, the email change, the data archive, clear memory, clear workspace, delete account and the admin reset's password all go through it, so they share one budget of wrong answers, and a new action that asks for the password goes through it too, never through a bare `verifyPassword` (a stolen session could guess the password there at bcrypt speed, then use it on the email change). The four that answer from a service return `{ status: "throttled", retryAfterSeconds }` and their routes answer `passwordThrottledResponse`; every refusal is `server/api/current-password.ts`, and the throttle's sentence is Settings' own (`profileTab.currentPasswordTooManyAttempts`), not the sign-in's. `updateOwnProfile` owns the Profile card's name and email change and what it costs (an address that differs asks for the password through that check, before the "address taken" answer; the same address in other letters is no change); `routes/api/settings/profile/+server.ts` only validates the body's shape and answers for the result.
  - [`src/lib/server/services/two-step/`](two-step/) — optional two-step sign-in, behind `index.ts`: `codes.ts` (TOTP with the RFC 6238 window and replay step, the Crockford backup codes and their HMAC key, the setup QR as a server-drawn SVG), `store.ts` (setup R13, verification, the guarded single-use updates, confirm-and-revoke as one transaction, reset, the sweep) and `challenges.ts` (the five-minute sign-in attempt, its cookie and its five tries). Nothing else imports the three tables. A session exists only after `consumeSignInChallenge` succeeds, so the password route must never create one for an account with a confirmed factor. The service is also a user-scoped-table owner (`account-lifecycle/user-scoped-tables.ts`, cascade, no reset scope) and leaves the account data archive out on purpose.
  - [`src/lib/server/services/attachment-trace.ts`](attachment-trace.ts) — logging helper for chat/file-production tracing. Adds `[FILE_PRODUCTION]`, `[CHAT_STREAM]`, `[CHAT_FILES]` correlation context. Consumed by stream-orchestrator and file-production services.
  - [`src/lib/server/services/language.ts`](language.ts) — the deterministic readers of a text's language: `readReplyLanguage` (a reply), `readShortTextLanguage` (a title, a headline, a status line) and `afterReplyLanguage` (the fallback chain for a turn whose language call failed). They decide nothing before a reply. Consumed by `chat-turn/reply-language.ts`, the title generator, the short-text parity check and the eval scorers.
  - [`src/lib/server/services/conversation-drafts.ts`](conversation-drafts.ts) — draft management for conversations. Used by conversation routes for draft save/load.
  - [`src/lib/server/prompts.ts`](../prompts.ts) — shared prompt configuration helpers. Consumed by Normal Chat context assembly.
  - [`src/lib/server/api/responses.ts`](../api/responses.ts) — shared JSON response helpers (`createJsonErrorResponse`, `createJsonResponse`) for API routes. Used across route files for consistent error/success formatting.
  - [`src/lib/server/services/analytics.ts`](analytics.ts) — analytics event ingestion plus the Analytics Dashboard Read Model. Event ingestion is consumed by chat-turn finalization; `getAnalyticsDashboardReadModel(...)` owns `/api/analytics` payload assembly for personal, admin system, per-user, timeline, and mock analytics. `src/routes/api/analytics/+server.ts` stays a route adapter for auth, query parameters, and JSON response mapping.
  - [`src/lib/server/services/file-production/`](file-production/) — durable file-production jobs, source validation, renderers, sandbox execution, retry/cancel, and legacy generated-file backfill.

- Active project service:
  - [`src/lib/server/services/projects.ts`](projects.ts) — project CRUD using `db` + `schema.ts` directly. Not a legacy DB wrapper; active service.
  - [`projects.ts`](projects.ts) also owns the project-page reads (`getProjectPageData`, `getProjectInstructions`) and `listRecentlyActiveProjects`, the single definition of "a project with recent activity"; lists carry `hasInstructions` and never the instruction text, and `home-summary.ts` consumes `listRecentlyActiveProjects` rather than re-deriving project activity.

## Rules In Other Files

- Prompt text, the reply language and any new model call: `chat-turn/AGENTS.md` (ruling 79), which also governs `normal-chat-context.ts`, `language.ts` and `title-generator.ts`.
- Memory, in every `memory-*/` folder and in `memory.ts`, `memory-maintenance.ts`, `memory-behavior-log.ts` and `memory-recuration.ts`: `memory-profile/AGENTS.md`.
- `chat-files.ts` and produced files: `file-production/AGENTS.md`.
- Background jobs (the lifecycle of Atlas, extraction and file-production jobs: claim, lease, retry, cancel, recovery, scheduling, waiting for a verdict): `jobs/AGENTS.md` (ADR-0069). Nothing outside `jobs/` changes a job's lifecycle columns.
- `normal-chat-tools/artifact-tools/` and anything else that writes an artifact: `artifacts/AGENTS.md`; a board's ops, placement and stale-read rules: `src/lib/components/artifacts/canvas/AGENTS.md`.
- An address fetched or embedded without a click (tools, `web-grounding.ts`, favicons, thumbnails): `url-provenance/AGENTS.md` (ADR-0068).
- `artifact-tours.ts`: `src/lib/components/artifacts/tour/AGENTS.md`. `announcement-campaigns.ts`: `src/routes/(app)/AGENTS.md` (Announcements).
