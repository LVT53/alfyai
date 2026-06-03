# Architecture Deepening Review — AlfyAI

**Date**: 2026-04-29  
**Scope**: Full codebase architectural friction analysis  
**Method**: `improve-codebase-architecture` skill — module depth, deletion test, seam analysis  
**Agents Deployed**: 5 parallel `explore` agents (server services, client architecture, chat-turn pipeline, knowledge subsystem, memory subsystem)

---

## Resolution History

| Date | Session | Candidate | Resolution |
|------|---------|-----------|------------|
| 2026-04-30 | grill-with-docs | **6** — Dual normalization | **RESOLVED** — Create unified `chat-turn/normalizer.ts`, delete translator service entirely, remove all legacy wrapper-tag and Hermes traces. See candidate body for full scope. |
| 2026-04-30 | grill-with-docs | **5** — `stream.ts` split | **SKIPPED** — Simpler cleanup only. Candidate 6's preserve removal + normalization consolidation already addresses most of the file's complexity. No new file splits. |
| 2026-04-30 | grill-with-docs | **4** — `config-store.ts` refactor | **SCALED BACK** — Collapse `getResolvedAdminConfigValues` + `getEnvDefaults` into a shared serializer. Remove translator keys. Keep override appliers as-is (grep-friendly, zero-risk). No metadata metaprogramming. |
| 2026-04-30 | grill-with-docs | **3** — `stream-orchestrator.ts` god object | **FINISHED** — 3 targeted extractions (completeStreamTurn, doReconnect, runNonStreamFallback) + SSE contract integration test. 36 new tests across 4 test files. Orchestrator reduced from 977 to ~720 lines. All 4 issues (#13–#16) committed in atomic TDD slices. |
| 2026-05-29 | architecture review follow-up | Working Document Selection signals | **FINISHED** — `working-document-selection.ts` now owns live document signal collapse; the old `active-state.ts` helper and test were removed. See ADR-0018. |

---

## Glossary (from LANGUAGE.md)

- **Module** — anything with an interface and an implementation (function, class, package, slice)
- **Interface** — everything a caller must know: types, invariants, ordering, error modes, config
- **Implementation** — the code inside
- **Depth** — leverage at the interface; a lot of behavior behind a small interface
- **Shallow** — interface nearly as complex as the implementation
- **Seam** — where an interface lives; a place behavior can be altered without editing in place
- **Adapter** — a concrete thing satisfying an interface at a seam
- **Leverage** — what callers get from depth
- **Locality** — what maintainers get from depth: change, bugs, knowledge concentrated in one place
- **Deletion test** — imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.

---

## Codebase at a Glance

- **Language**: TypeScript + Svelte 5
- **Stack**: SvelteKit, Tailwind CSS 4, SQLite (better-sqlite3 + Drizzle ORM), adapter-node
- **Test suite**: ~100 unit test files + 19 Playwright spec files
- **Server code**: 108 non-test `.ts` files under `src/lib/server/`
- **Engineering context**: `CONTEXT.md` captures product/domain language, `docs/adr/` records durable architecture decisions, and AGENTS.md remains the canonical code-placement map

---

## Size Distribution — Top 20 Largest Server Files

| Rank | File | Lines | Role |
|------|------|-------|------|
| 1 | `services/honcho.ts` | 1,680 | Honcho SDK adapter + context assembly |
| 2 | `services/task-state.ts` | 1,558 | Task routing + evidence + checkpoints + re-exports |
| 3 | `chat-turn/stream-orchestrator.ts` | 1,031 | Full SSE streaming pipeline |
| 4 | `task-state/continuity.ts` | 988 | Project memory, pause/resume, focus continuity |
| 5 | `services/translator.ts` | 913 | Hungarian translation service |
| 6 | `services/chat-files.ts` | 849 | Chat file persistence |
| 7 | `services/langflow.ts` | 833 | Langflow API client + prompt assembly |
| 8 | `services/sandbox-execution.ts` | 798 | Docker container execution |
| 9 | `config-store.ts` | 766 | Runtime config (36 importers) |
| 10 | `knowledge/context.ts` | 689 | Working-set ranking, prompt selection |
| 11 | `knowledge/store/attachments.ts` | 627 | Upload pipeline |
| 12 | `services/evidence-family.ts` | 624 | Document family resolution |
| 13 | `knowledge/store/documents.ts` | 608 | Document search + semantic ranking |
| 14 | `chat-turn/stream.ts` | 557 | Hybrid re-export hub + implementation |
| 15 | `db/schema.ts` | 505 | Database schema definition |
| 16 | `services/title-generator.ts` | 495 | Title generation |
| 17 | `knowledge/store/core.ts` | 462 | Artifact CRUD hub |
| 18 | `services/inference-providers.ts` | 434 | Provider model management |
| 19 | `services/message-evidence.ts` | 430 | Evidence channel types |
| 20 | `services/document-resolution.ts` | 408 | Generated-document family selection |

The top 8 files (all 700+ lines) represent ~40% of total server code.

---

## God Object Analysis — Modules with 5+ Importers

| Target | Importers | Lines | Assessment |
|--------|-----------|-------|------------|
| `auth/hooks` | 48 | — | Expected SvelteKit auth guard |
| `services/knowledge` | 45 | 105 | Thin facade with extremely wide surface |
| `db` | 41 | 14 | Expected — Drizzle connection injection |
| `services/memory` | 39 | 192 | Thin facade, delegates to honcho + task-state |
| `config-store` | 36 | 766 | Large, justifiable for config management |
| `db/schema` | 31 | 505 | Expected — type-level import |
| `services/messages` | 27 | — | Message CRUD hub |
| `services/honcho` | 25 | 1,680 | Largest file, most concerning |
| `services/task-state` | 14 | 1,558 | Mixed facade + logic |
| `services/analytics` | 13 | — | Analytics events |
| `services/chat-files` | 11 | 849 | File storage |
| `services/projects` | 11 | 57 | Simple CRUD |

---

## Test Coverage Gaps — Critical

| File | Lines | Tests | Risk |
|------|-------|-------|------|
| `chat-turn/stream-orchestrator.ts` | 1,031 | **None** | 🔴 Critical — orchestrates entire streaming pipeline |
| `knowledge/context.ts` | 689 | **None** | 🔴 High — working set + context status |
| `knowledge/capsules.ts` | 367 | **None** | 🔴 High — work capsules |
| `chat-turn/finalize.ts` | 262 | **None** | 🔴 High — post-turn persistence |
| `chat-turn/retry-cleanup.ts` | 195 | **None** | 🟡 Medium |
| `chat-turn/request.ts` | 144 | **None** | 🟡 Medium |
| `chat-turn/stream-parser.ts` | 150 | **None** | 🟡 Medium — easy to unit-test parser |
| `chat-turn/preflight.ts` | 60 | **None** | 🟢 Low |
| `chat-turn/thinking-normalizer.ts` | 60 | **None** | 🟢 Low |

**chat-turn/ directory overall**: 12 source files, only 2 test files (16.7% coverage). The core user-facing pipeline has the lowest test coverage in the codebase.

---

## Candidate 1: `honcho.ts` — Monolithic Sink

**Files**: `src/lib/server/services/honcho.ts`, `src/lib/server/services/chat-turn/context-selection.ts`

**Implementation Status, 2026-05-29**: finished. `buildConstructedContext()` and related prompt-selection helpers now live in `chat-turn/context-selection.ts`. `honcho.ts` is a Honcho adapter/supplier through `loadHonchoPromptContext()` plus mirror/sync/persona/health behavior.

### Problem

What should be a Honcho integration adapter had become the de facto chat context assembly hub. This has been corrected; keep the notes below as the original diagnosis and do not move prompt assembly back into Honcho.

1. **SDK lifecycle** — peer creation, session bootstrap, identity rotation
2. **Message mirroring** — mirroring user/assistant messages to Honcho
3. **Persona CRUD** — list, forget, forget-all persona memories
4. **Context assembly** — moved to `chat-turn/context-selection.ts`
5. **System prompt enhancement** — `buildEnhancedSystemPrompt()`, health checks

`buildConstructedContext()` now coordinates from the chat-turn context-selection boundary:
- Session prompt loading from admin config
- Attachment resolution and readiness
- Working-set selection via `knowledge/context.ts`
- Working Document Selection via `working-document-selection.ts`
- Task state preparation via `task-state.ts`
- Honcho peer context enrichment
- Document resolution authority signals

The important invariant after the fix is that this function must remain outside the Honcho adapter.

### Current Import Surface After Fix

```
honcho.ts imports:
  Honcho SDK types/client
  config-store, db, schema, prompts
  prompt-context helpers for Honcho serialization/truncation
  messages for stored Honcho metadata and fallback session messages

chat-turn/context-selection.ts imports:
  Honcho session/persona supplier
  knowledge and linked-source candidate suppliers
  task-state candidate suppliers
  working-document-selection signals
  context budget, prompt-context, TEI rerank/embedder, attachment trace
```

### Deletion Test

With `buildConstructedContext` in the chat-turn boundary, `honcho.ts` stays focused on Honcho operations and context assembly has clearer locality.

### Solution Outline

```
honcho.ts  (remainder ~900 lines)
  └── Honcho SDK adapter: session/peer lifecycle, message mirroring, persona CRUD, health

chat-turn/context-selection.ts
  └── buildConstructedContext() + related helpers
  └── Owns: prompt loading, attachment resolution, working-set selection,
           working-document selection, task preparation, Honcho enrichment
```

### Benefits

- **Locality**: Context assembly changes concentrate in one module instead of hiding in the Honcho adapter
- **Leverage**: Honcho callers don't pull in context assembly complexity as transitive dependency
- **Test surface**: Context assembly becomes testable in isolation with mocked services

### Risks

- `buildConstructedContext` exports a specific return type consumed by chat-turn routes — contract must be preserved
- Honcho enrichment inside context selection means the chat-turn module still imports a narrow supplier from `honcho.ts`. This is correct; Honcho remains the Honcho authority, while context selection owns prompt inclusion and budget.

---

## Candidate 2: `task-state.ts` — Mixed Facade + Logic Module

**Files**: `src/lib/server/services/task-state.ts` (1,558 lines), `src/lib/server/services/task-state/*.ts`

### Problem

Acts as both:
- **Re-export barrel**: Pulls from 4 submodules (continuity, control-model, artifacts, document-preferences)
- **Logic host**: Task routing with semantic scoring + TEI reranking, evidence selection, steering actions, checkpointing

The re-export surface makes imports ambiguous — callers don't know if they're getting a stable re-export or internal logic. The file imports from 9+ external modules:

```
task-state.ts imports:
  working-document-selection, evidence-family, messages, semantic-embedding-refresh,
  semantic-ranking, tei-observability, tei-reranker,
  task-state/artifacts, task-state/document-preferences,
  task-state/control-model, task-state/mappers,
  knowledge/store, working-set
```

### Key Exports (not from submodules)

```typescript
// Task routing
selectTaskStateForTurn()
prepareTaskContext()      // consumed by honcho.ts
routeTaskStateForTurn()   // internal
getContextDebugState()

// Evidence
computeEvidenceScore()
maybeRerankEvidence()
listTaskEvidenceLinks()

// Checkpointing
updateTaskStateCheckpoint()
listTaskCheckpoints()

// Steering
applyTaskSteeringAction()

// Re-exports (stable API)
export * from './task-state/continuity'
export * from './task-state/control-model'
export * from './task-state/artifacts'
export type { DocumentPreferenceConflict } from './task-state/document-preferences'
```

### Solution Outline

```
task-state.ts  (re-export barrel only, ~50 lines)
  └── Pure re-export from task-state/* submodules
  └── No logic of its own

task-state/routing.ts  (new, ~400 lines)
  └── selectTaskStateForTurn, prepareTaskContext, routeTaskStateForTurn

task-state/evidence.ts  (new, ~250 lines)
  └── computeEvidenceScore, maybeRerankEvidence, listTaskEvidenceLinks

task-state/checkpointing.ts  (new, ~300 lines)
  └── updateTaskStateCheckpoint, listTaskCheckpoints

task-state/steering.ts  (new, ~150 lines)
  └── applyTaskSteeringAction
```

### Benefits

- **Interface clarity**: Callers see what is a stable re-export vs. a direct import
- **Locality**: Each concern's tests concentrate in one place
- **Seam**: Re-export barrel becomes a genuine seam where future modules can plug in

---

## Candidate 3: `chat-turn/stream-orchestrator.ts` — Undertested God Object ✅ FINISHED (2026-04-30)

> **Historical note, 2026-06-02**: This candidate records a pre-AI SDK migration review of the old Browser SSE/Langflow streaming path. The active Normal Chat stream contract is now app-owned AI SDK UI stream framing; do not treat the legacy named-event details below as current deployment or implementation guidance.
>
> **Decision**: No shared `post-turn-orchestrator.ts`. Send and stream have fundamentally different runtime shapes (send: single string, sequential await, no tool-call records, no generated files; stream: chunkRuntime with thinking/tool-calls, Promise.all parallelism, SSE end-event broadcast). Forcing them through one shared function would require runtime branching on "am I in stream mode?" — worse than two separate sequences.
>
> **Revised scope**: Three targeted extractions instead of four:
> 1. Extract `completeSuccess` closure to standalone async function `completeStreamTurn()` (~180 lines) with explicit parameters instead of closure-captured variables
> 2. Extract non-streaming fallback path to `runNonStreamFallback()` (~47 lines) — the self-contained block that calls `sendMessage()` and emits text
> 3. Extract `doReconnect` to `stream-reconnect.ts` (~65 lines) — replay mechanics only; the reconnect decision tree stays in the orchestrator
>
> **Not extracted**: Full retry loop (270 lines, 4 paths — too entangled with chunkRuntime accumulators), reconnect decision tree (37 lines — simple routing tied to ReadableStream control flow), translation (already dead after Candidate 6).
>
> **Test strategy**: Unit tests for all three extracts + one legacy Browser SSE contract integration test verifying terminal/error/replay event shapes. Playwright E2E covers browser consumption.
>
> **File renamed to 977 lines** (post-Candidate 6 normalization cleanup). `completeSuccess` closure at lines 409–634.

**Files**: `src/lib/server/services/chat-turn/stream-orchestrator.ts` (977 lines, 0 tests)

### Problem

`runChatStreamOrchestrator()` is a 1,031-line function returning a `Response`. The `ReadableStream.start()` closure (~900 lines) encompasses 11 distinct responsibilities:

1. Legacy Browser SSE response framing (response creation, prelude, heartbeat, encode)
2. Reconnection detection and replay (`doReconnect` — 65 lines of buffer replay + live subscription)
3. Stream registration/lifecycle (via `active-streams.ts`)
4. Retired upstream Langflow streaming (up to 2 retry attempts with URL-list validation recovery)
5. Non-stream fallback (on streaming failure, falls back to `sendMessage()`)
6. Translation (via `StreamingHungarianTranslator`)
7. Tool call event wiring (file-generation debug logging)
8. Persistence orchestration (`completeSuccess` closure — ~225 lines)
9. Error classification and stream termination (`failStream`)
10. Timer management (heartbeat 15s, reconnect heartbeat 10s, timeout)
11. Generated file lifecycle (snapshot at start, diff at end, assignment to message, memory sync)

### The `completeSuccess()` Duplication

The `completeSuccess()` closure (lines 424-649, ~225 lines) is itself a sub-orchestrator that:
- Creates user and assistant messages via `createMessage()`
- Calls `persistUserTurnAttachments()`, `persistAssistantTurnState()`, `persistAssistantEvidence()`, `runPostTurnTasks()`
- Handles generated-file diff, assignment, and memory sync
- Sends final legacy named terminal SSE payload with 15 fields

This **duplicates orchestration that lives in `send/+server.ts`** (lines 107-171), which manually sequences the same calls. Two different files orchestrate the same post-turn flow with different error handling and timing.

### Revised Solution Outline

```
chat-turn/stream-orchestrator.ts  (reduced to ~500 lines)
  └── ReadableStream adapter + retry loop + reconnect decision tree + chunkRuntime wiring
  └── Composes extracted pure functions

chat-turn/stream-completion.ts  (new, ~180 lines)
  └── completeStreamTurn() — standalone async function
  └── Accepts: conversationId, userId, chunkRuntime, streamId, persisted message IDs, etc.
  └── Returns: void (side-effect driven: finalize.ts calls, generated-file sync, SSE end event)

chat-turn/stream-fallback.ts  (new, ~60 lines)
  └── runNonStreamFallback() — self-contained non-streaming fallback path
  └── Accepts: sendMessage, chunk emitters, state setters
  └── Calls sendMessage() → emits text → calls completeStreamTurn()

chat-turn/stream-reconnect.ts  (new, ~65 lines)
  └── doReconnect() — replay buffered tokens/thinking/tool_calls as legacy SSE events
  └── Accepts: targetStreamId, enqueueChunk, buffer/stream helpers, closeDownstream

Tests:
  ├── stream-completion.test.ts   (unit — mock finalize.ts, chat-files.ts, messages.ts)
  ├── stream-fallback.test.ts     (unit — mock sendMessage, chunk emitters)
  ├── stream-reconnect.test.ts    (unit — mock buffer, subscribe/unsubscribe)
  └── stream-orchestrator.test.ts (integration — legacy SSE contract validation)
```

### Benefits

- **Test surface**: Three extracted functions accept explicit inputs, fully testable without ReadableStream
- **Locality**: Each concern concentrated in a dedicated module
- **Interface clarity**: Callers see parameters instead of closure-captured state
- **No behavior change**: Pure extraction, no logic modified

### Risks

- Legacy Browser SSE event contract (terminal/error payload shapes) must be preserved exactly — integration test guards this historical behavior
- `completeStreamTurn()` must handle both normal completion and `wasStopped = true` path
- Extraction surface: 15+ closure-captured variables promoted to explicit parameters in `completeStreamTurn()`

---

## Candidate 4: `config-store.ts` — Repetitive Override Appliers ✅ SCALED BACK (2026-04-30)

> **Decision**: Minimal cleanup only. Collapse `getResolvedAdminConfigValues` + `getEnvDefaults` into one shared `serializeConfigValues()` helper (~150 lines saved). Remove translator config keys (4 from all locations). Keep all override appliers as-is — they're grep-friendly, type-safe, and adding keys is rare. No `ConfigKeyMeta` metaprogramming — explicit > clever.

**Files**: `src/lib/server/config-store.ts` (766 lines, 36 importers)

### Problem

~50 override applier functions follow a near-identical pattern:

```typescript
// Typical applier — 4-5 lines each, repeated 50 times
MODEL_1_COMPACTION_UI_THRESHOLD: (config, value) => {
  const parsed = parseIntOverride(value);
  if (parsed !== undefined) config.model1CompactionUiThreshold = parsed;
},
```

The `getResolvedAdminConfigValues()` (lines 548-618) and `getEnvDefaults()` (lines 622-702) are structurally identical ~150-line functions mirroring the same 74 keys. Adding a new config key requires editing **5 locations** in this file:
1. `ADMIN_CONFIG_KEYS` constant
2. `RuntimeConfig` interface field (if new)
3. `overrideAppliers` entry
4. `getResolvedAdminConfigValues()` entry
5. `getEnvDefaults()` entry

### Solution Outline

Replace individual appliers with a data-driven metadata approach:

```typescript
interface ConfigKeyMeta {
  key: AdminConfigKey;
  type: 'string' | 'int' | 'boolean' | 'modelField';
  configPath: string[]; // e.g. ['model1', 'compactionUiThreshold']
  defaultValue: () => string;
  validate?: (parsed: number) => number; // e.g. Math.max(0, parsed)
}

const CONFIG_KEY_META: ConfigKeyMeta[] = [
  {
    key: 'MODEL_1_COMPACTION_UI_THRESHOLD',
    type: 'int',
    configPath: ['model1CompactionUiThreshold'],
    defaultValue: () => String(envConfig.model1CompactionUiThreshold),
  },
  // ... 74 entries
];

// Single deep applier replaces 50 shallow ones
function buildOverrideApplier(meta: ConfigKeyMeta): OverrideApplier {
  // One implementation, parameterized by metadata
}
```

### Benefits

- **Leverage**: Adding a new config key becomes a single metadata entry instead of 5 edits
- **Depth**: 50 shallow appliers become one deep applier (~20 lines) + 74 metadata entries
- **Line reduction**: ~400 lines eliminated (50 × 4-line appliers → 74 × 2-line entries + 20-line engine)
- **Consistency**: Validation, defaults, and serialization guaranteed identical across all keys

### Risks

- Per-key overrides like `HONCHO_CONTEXT_WAIT_MS` having custom validation (`Math.max(0, parsed)`) vs `MAX_MESSAGE_LENGTH` (no min) must be captured accurately in metadata
- `MODEL_1_SYSTEM_PROMPT` and `SYSTEM_PROMPT` have special `normalizeSystemPromptReference` handling — needs explicit metadata flag

---

## Candidate 5: `chat-turn/stream.ts` — Covert Implementation Behind Re-Export Facade ⏭️ SKIPPED (2026-04-30)

> **Decision**: Skipped. Candidate 6's preserve removal (~70 lines) and normalization consolidation already addresses most complexity. No new file splits — barrel stays intact with remaining implementation. The transient dependency cost of "import one utility pulls in the whole module" is accepted as not worth the split.

**Files**: `src/lib/server/services/chat-turn/stream.ts` (557 lines)

### Problem

The file comment on line 28 says "Re-export all public symbols from sub-modules for backward compatibility" but the file actually contains two distinct layers:

**Layer 1 — Pure re-exports** (lines 1-41):
```typescript
export { parseUpstreamEvents, ... } from './stream-parser';
export { normalizeVisibleAssistantText, ... } from './thinking-normalizer';
```

**Layer 2 — Substantial implementation** (lines 43-557):
- `createServerChunkRuntime()` (~250 lines) — SSE framing closure factory
- `createStreamJsonErrorResponse()` — error response construction
- `createEventStreamResponse()` — SSE response setup
- `createSsePreludeComment()`, `createSseHeartbeatComment()` — comment helpers
- `extractAssistantChunk()` — upstream event extraction
- `toIncrementalChunk()` — incremental chunk deduplication
- `classifyStreamError()` — error type detection
- `isAbruptUpstreamTermination()` — abrupt-close heuristic
- `isUrlListValidationError()` — URL validation check
- `extractErrorMessage()` — error message parsing from mixed formats

Callers importing `parseUpstreamEvents` (a parser) get `createServerChunkRuntime` (an SSE runtime) as unwanted transitive dependency. Routes importing `createStreamJsonErrorResponse` (send, stream, retry) all pull in the entire module.

### Solution Outline

```
chat-turn/stream.ts  (reduced to ~30 lines, pure re-export barrel)
  └── Re-exports from stream-parser, thinking-normalizer,
      stream-runtime, stream-response

chat-turn/stream-runtime.ts  (new, ~250 lines)
  └── createServerChunkRuntime() + internal helpers

chat-turn/stream-response.ts  (new, ~80 lines)
  └── createStreamJsonErrorResponse, createEventStreamResponse,
      createSsePreludeComment, createSseHeartbeatComment

chat-turn/stream-errors.ts  (new, ~100 lines)
  └── classifyStreamError, isAbruptUpstreamTermination,
      isUrlListValidationError, extractErrorMessage
```

### Benefits

- **Locality**: SSE runtime and response helpers concentrate in dedicated modules
- **Interface**: Callers import only what they need — no transitive dependencies
- **Depth**: Each extracted module has a single clear responsibility
- **Zero behavior change**: Pure extraction, no logic modified

---

## Candidate 6: Dual Normalization Paths — Divergence Risk ✅ RESOLVED (2026-04-30)

> **Decision**: Create unified `chat-turn/normalizer.ts` with single `normalizeAssistantOutput()`. Delete translator service entirely (unused). Remove all legacy wrapper-tag and Hermes traces. Route `execute.ts`, `stream-orchestrator.ts`, and `title-generator.ts` through the unified normalizer. Delete `extractVisibleTextFromModelResponse` from the shared boundary.
> 
> **Scope**: ~1,250 lines deleted (translator 913 + preserve handling ~100 + Hermes ~10 + dead code), ~150 lines added (normalizer + updated callers). 15 files touched.

**Files**:
- `src/lib/services/stream-protocol.ts` — `extractVisibleTextFromModelResponse()`
- `src/lib/server/services/chat-turn/thinking-normalizer.ts` — `normalizeVisibleAssistantText()`

### Problem

The `/send` and `/stream` paths normalize assistant text through **different functions**:

| Path | Function | Location | What It Strips |
|------|----------|----------|---------------|
| **Send** | `extractVisibleTextFromModelResponse()` | `stream-protocol.ts` | Thinking blocks and legacy wrapper tags |
| **Stream** | `normalizeVisibleAssistantText()` | `thinking-normalizer.ts` | Thinking blocks, standalone tags, and legacy wrapper tags |

The send path **does not** strip tool-call markers. If the non-stream Langflow response ever contains `\x02TOOL_START\x1f...\x03` markers, they would display raw to the user in the send path.

The stream path strips tool-call markers inline during `processToolCallMarkers()` and at final flush via `normalizeVisibleAssistantText()`. The send path only strips thinking and legacy wrapper tags.

The two regex approaches to thinking tag stripping are different:
- `extractVisibleTextFromModelResponse`: Uses `processInlineThinkingChunk()` then wrapper-tag cleanup
- `normalizeVisibleAssistantText`: Uses regex-based approach with CJK character handling

These **should** produce equivalent output, but they are different implementations with no shared verification.

### Solution Outline

Either:
1. **Unify**: Make both paths call `normalizeVisibleAssistantText()` + `processToolCallMarkers()` from `chat-turn/`
2. **Verify equivalence**: Prove `extractVisibleTextFromModelResponse` is equivalent and add `processToolCallMarkers` call

Option 1 is preferred — it consolidates normalization into one place and guarantees `/send` and `/stream` produce identical visible text.

```typescript
// In execute.ts (send path), currently calls:
extractVisibleTextFromModelResponse(rawText); // Only strips think+preserve

// Change to:
processToolCallMarkers(
  normalizeVisibleAssistantText(rawText)
); // Strips think+tool+preserve — same as stream path
```

### Benefits

- **Locality**: One normalization pipeline, verified once
- **Consistency**: No risk of `/send` and `/stream` returning different visible text
- **Low effort**: Simple import consolidation, no architectural change

---

## Candidate 7: `MessageInput.svelte` — Component as API Client

**Files**: `src/lib/components/chat/MessageInput.svelte` (845 lines)

### Problem

Line 4 of `MessageInput.svelte`:
```typescript
import { uploadKnowledgeAttachment } from '$lib/client/api/knowledge';
```

This directly violates AGENTS.md rules:
- "`MessageInput.svelte` may emit `onQueue`, but the Normal Chat Client Turn Runtime decides queued-turn admission, auto-send, and restore behavior through page-owned adapters"
- "`client/api/` owns reusable browser fetch logic. Stores should not become ad hoc HTTP clients"
- Components should not own business logic — they should emit events

The component calls `uploadKnowledgeAttachment` directly, bypassing the store/page orchestration layer. This creates a second path for attachment uploads that isn't visible to the conversation store, meaning optimistic updates or error recovery in the store can't account for uploads happening inside the component.

### Solution Outline

```typescript
// MessageInput.svelte — removes API import, emits event
function handleFileSelected(file: File) {
  dispatch('uploadFile', { file, conversationId: currentConversationId });
}

// Chat page — owns the API call
function handleUploadFile(event: CustomEvent<{ file: File; conversationId: string }>) {
  const artifact = await uploadKnowledgeAttachment(event.detail.file, event.detail.conversationId);
  // Update store, attach to current message draft, etc.
}
```

### Benefits

- **Locality**: All upload orchestration concentrates at the page level
- **Interface simplicity**: The component's API becomes purely event-based (emits `uploadFile`, receives artifacts as props)
- **Store visibility**: Upload state mutations flow through the conversation store instead of bypassing it

### ✅ Completed — 2026-04-29

**What was done**:
- Removed `uploadKnowledgeAttachment` import from `MessageInput.svelte`
- Added `onUploadFiles` prop: component emits `{ files, conversationId, done }` instead of calling API
- Added `addUploadedAttachment` (internal function): page calls via `done` callback to push results in
- Spinner state, file size validation, `ensureConversation`, draft emission stay component-internal
- Chat page and landing page now import `uploadKnowledgeAttachment` and own the upload loop
- `ChatComposerPanel.svelte` passes through `onUploadFiles` prop
- Drag-and-drop on both pages now calls `uploadKnowledgeAttachment` directly
- File size check stays component-side (pure client-side validation)
- `pendingUploadCount` tracks callback completions for spinner lifecycle
- 4 new tests added, 4 existing tests rewritten; all 22 pass

**Files changed**: `MessageInput.svelte`, `MessageInput.test.ts`, `ChatComposerPanel.svelte`, `chat/[id]/+page.svelte`, `(app)/+page.svelte`

---

## Candidate 8: `DocumentWorkspace.svelte` + `FilePreview.svelte` — Massive Rendering Components

**Files**:
- `src/lib/components/chat/DocumentWorkspace.svelte` (1,872 lines)
- `src/lib/components/knowledge/FilePreview.svelte` (1,487 lines)

### Problem

Together these are the two largest files in `src/lib/` (3,359 lines combined). Each contains embedded preview rendering for multiple formats:

- PDF rendering (via pdfjs-dist)
- Spreadsheet rendering (via SheetJS/xlsx)
- Image display
- Code highlighting (via Shiki)
- Text/Markdown display
- Comparison view (text diff)
- Version history display

Both components import from shared utilities (`$lib/utils/file-preview`, `$lib/utils/text-compare`, `$lib/utils/markdown-loader`) but maintain separate preview rendering implementations. Both have raw `fetch()` calls for preview content loading.

The split into `DocumentWorkspace` (chat) and `FilePreview` (knowledge) is arbitrary — they serve the same rendering purpose in different contexts.

### Shared Dependencies Already Extracted

```
$lib/utils/file-preview.ts       — MIME detection, preview URL resolution
$lib/utils/text-compare.ts       — Text diff/comparison logic
$lib/utils/markdown-loader.ts    — Lazy Shiki loader
$lib/utils/html-sanitizer.ts     — HTML sanitization
```

### Solution Outline

```
src/lib/components/preview/
  ├── PdfViewer.svelte          (~250 lines from both files)
  ├── SpreadsheetViewer.svelte  (~200 lines from both files)
  ├── CodeViewer.svelte         (~120 lines from both files)
  ├── ImageViewer.svelte        (~80 lines from both files)
  ├── CompareView.svelte        (~200 lines from DocumentWorkspace)
  ├── VersionList.svelte        (~100 lines from DocumentWorkspace)
  └── PreviewLoader.ts          (centralized fetch() for preview content)

DocumentWorkspace.svelte  (reduced to ~400 lines)
  └── Composition: imports preview/* sub-components
  └── Owns: workspace shell, tab state, route-level active document

FilePreview.svelte  (reduced to ~300 lines)
  └── Composition: imports preview/* sub-components
  └── Owns: knowledge-page preview shell
```

### Benefits

- **Leverage**: Each preview format becomes a reusable module callable from any context (chat, knowledge, search results, future features)
- **Locality**: PDF rendering bugs are fixed in one place, not two
- **Depth**: `DocumentWorkspace.svelte` drops from 1,872 lines to ~400 lines of composition logic
- **Interface**: Each preview sub-component has a well-defined prop interface (source URL, metadata, callbacks)

### Risks

- Visual regression during extraction — preview rendering is pixel-sensitive
- Existing tests for `DocumentWorkspace.test.ts` and `FilePreview.test.ts` must be updated to account for new component boundaries

---

## Summary — Prioritized by Impact

| # | Candidate | Impact | Effort | Risk | Key Metric |
|---|-----------|--------|--------|------|------------|
| 3 | `stream-orchestrator.ts` — extract + test | 🔴 Critical | High | High | ✅ FINISHED — 977 → ~720 lines, 0 → 36 tests. 3 extractions + SSE contract test. 4 commits. |
| 1 | `honcho.ts` — split context assembly | 🔴 High | High | Medium | 1,680 lines, 5 responsibilities |
| 2 | `task-state.ts` — separate barrel from logic | 🔴 High | Medium | Medium | 1,558 lines, mixed concerns |
| 6 | Dual normalization — unify paths + delete translator | 🔴 High | Medium | Medium | ✅ RESOLVED — ~1,250 lines deleted, unified normalizer |
| 4 | `config-store.ts` — collapse mirror functions | 🟡 Low | Low | Low | ✅ SCALED BACK — ~150 lines saved, no new abstractions |
| 5 | `stream.ts` — split hub + implementation | 🟡 Medium | — | — | ⏭️ SKIPPED — simpler cleanup via Candidate 6 |
| 8 | Preview components — extract sub-components | 🟡 Medium | High | Medium | 3,359 lines → ~700 lines of composition |
| 7 | `MessageInput.svelte` — remove API import | 🟢 Low-Med | Low | Low | Clear architecture violation |

---

## Cross-System Dependency Graph

```
Routes (api/chat/send, api/chat/stream)
    │
    ├──► chat-turn/request.ts ──────► config-store
    ├──► chat-turn/preflight.ts ────► conversations, attachments
    │
    ├──► [SEND PATH]
    │    └──► chat-turn/execute.ts ─► stream-protocol (normalization)
    │         └──► chat-turn/finalize.ts ─► 8 downstream services
    │
    ├──► [STREAM PATH]
    │    └──► chat-turn/stream-orchestrator.ts
    │         ├──► chat-turn/stream.ts (re-export hub)
    │         │    ├──► stream-parser.ts
    │         │    └──► thinking-normalizer.ts
    │         ├──► chat-turn/finalize.ts (same as send)
    │         └──► chat-turn/active-streams.ts
    │
    ├──► honcho.ts ──────────────────► task-state (4 functions)
    │                                   └──► working-document-selection, evidence-family, messages...
    │
    ├──► task-state.ts ──────────────► task-state/continuity.ts (988 lines)
    │    (facade)                       task-state/control-model.ts (227 lines)
    │                                   task-state/artifacts.ts (247 lines)
    │
    └──► memory.ts ─────────────────► honcho.ts + task-state.ts (thin orchestrator)
         memory-maintenance.ts ─────► task-state.ts (independent of honcho/memory)
         memory-events.ts ──────────► db only (clean, zero service deps)
```

---

## Knowledge Subsystem Verdict

After deep analysis, the knowledge subsystem decomposition is **well-justified**:

- Modules map to real, distinct concerns (CRUD, upload, search, delete, metadata, versioning, working-set, capsules)
- Dependency graph is hub-and-spoke (`core.ts` at center), not cyclic or tangled
- No module is a deletion-test candidate (except `store.ts`, which is a documented facade)
- External dependencies flow correctly: related services are consumers of knowledge, not vice versa

The only marginal concern: `store.ts` (63 lines, pure re-export barrel) could be collapsed into `knowledge.ts` without behavioral impact.

---

## Client-Side Architecture Verdict

The store → API → HTTP layer is clean and follows conventions:

```
Pages (routes)  →  Stores  →  client/api/  →  http.ts (requestJson)
```

**Positive findings**:
- Every store delegates to `client/api/`, no raw fetch in stores
- Base HTTP wrapper (`http.ts`) is centralized with consistent error handling
- `conversation-session.ts` owns all `sessionStorage` keys — no scattered keys
- Stream protocol parsing centralized in `stream-protocol.ts`
- Shiki lazy-loaded in `markdown.ts`, not bundled initially
- `streaming.ts` correctly distinguishes user-requested stop vs. passive navigation detach

**Violations found**:
- `MessageInput.svelte` imports `uploadKnowledgeAttachment` directly (component as API client)
- `ConversationList.svelte` reads `$page.url.pathname` directly (component coupled to SvelteKit page store)

---

## Notes

- **CONTEXT.md exists** — use it for product/domain vocabulary alongside AGENTS.md placement guidance
- **ADR directory exists** — load-bearing architecture decisions should be recorded in `docs/adr/`
- **`project-memory.ts` confirmed absent** — AGENTS.md is correct, functionality lives in `task-state/continuity.ts`
- **Test suite is strong overall** (100+ unit tests, 19 Playwright specs) but concentrated gaps in `chat-turn/` directory

## Follow-Up Issues (from grill-with-docs session, 2026-04-29)

### Issue A: Upload failure UX — per-file status display

**Current behavior**: When multiple files fail to upload, `MessageInput.svelte` shows one aggregated summary error (`"2 of 3 files failed to upload"`). The user cannot see which specific files failed or why until they dismiss the summary.

**Desired behavior**: Show per-file status simultaneously — each file row shows its own success/failure state with the specific error reason. This becomes more important after the API import is moved to the page, since the component will receive per-file results from the `doneCallback`.

**Scope**: Separate improvement, not part of the API import removal task.

### Issue B: MAX_FILE_SIZE — hardcoded in too many places

**Problem**: The 100MB upload size limit is hardcoded in multiple locations:
- `MessageInput.svelte` line 406 (`const MAX_FILE_SIZE = 100 * 1024 * 1024`)
- The SvelteKit adapter-node `BODY_SIZE_LIMIT` patch in the production build
- At least one server-side validation path
- README docs mention both `BODY_SIZE_LIMIT` and the 100MB knowledge cap

These should converge on a single config source (`config-store.ts` or env) so changing the limit is a one-line edit. The current complexity (3-5 hardcoded values + a patched adapter) is excessive for a simple limit.

**Scope**: Separate improvement, consolidate into a single config variable.
