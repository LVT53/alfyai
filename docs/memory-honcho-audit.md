# Memory System & Honcho Integration Audit

**Date:** 2026-06-03
**Scope:** `src/lib/server/services/` memory subsystem, Honcho integration, maintenance, and Vercel AI SDK compatibility
**Auditor:** Sisyphus (AI Agent)
**Status:** ✅ **ALL 15 FIXES IMPLEMENTED** — 2026-06-03 (Sisyphus orchestration, 15 agents, 4 waves)

---

## ⚠️ IMPLEMENTATION COMPLETE — DO NOT RE-IMPLEMENT

All fixes below have been implemented as of 2026-06-03. See the status column for each fix. The implementation added:
- **10 production files** modified/created
- **10 test files** modified/created  
- **~130 new tests** across all modules
- **1,613 total service tests passing**, zero type errors, clean build

### Fix Status Summary

| # | Fix | Status | Implemented In |
|---|-----|--------|----------------|
| 1 | Semantic embedding orphan cleanup | ✅ DONE | `semantic-embeddings.ts` + `memory-maintenance.ts` + `retry-cleanup.ts` |
| 2 | memoryEvents age-based pruning | ✅ DONE | `memory-events.ts` + `memory-maintenance.ts` |
| 3 | memory-maintenance.test.ts | ✅ DONE | `memory-maintenance.test.ts` (29 tests) |
| 4 | Stagger per-user maintenance | ✅ DONE | `memory-maintenance.ts` (200ms delays) |
| 5 | control-model.ts → Output.json() | ✅ DONE | `control-model.ts` |
| 6 | conversationSummaries cleanup | ✅ DONE | `memory-maintenance.ts` |
| 7 | projects orphan cleanup | ✅ DONE | `memory-maintenance.ts` |
| 8 | chatGeneratedFiles orphan cleanup | ✅ DONE | `chat-files.ts` + `memory-maintenance.ts` |
| 9 | Honcho session pruning | ✅ DONE | `honcho.ts` + `memory-maintenance.ts` |
| 10 | Remove allowSystemInMessages | ✅ DONE | `control-model.ts` + `title-generator.ts` |
| 11 | Incremental embedding backfill | ✅ DONE | `memory-maintenance.ts` (cooldown-based) |
| 12 | Disk-space reconciliation sweep | ✅ DONE | `disk-reconciliation.ts` (new file) |
| 13 | system → instructions (AI SDK 7) | 🔮 DEFERRED | Awaiting AI SDK v7 GA |
| 14 | Maintenance health metrics | ✅ DONE | `maintenance-metrics.ts` + admin endpoint + wired |
| 15 | artifactChunks orphan pruning | ✅ DONE | `memory-maintenance.ts` |

---

## 1. Executive Summary

The memory system and Honcho integration are **functionally sound** but have **accumulated technical debt** around cleanup, maintenance, and AI SDK modernization. The architecture is well-layered (Task-State → Honcho → Working-Document), but several tables grow unbounded, maintenance tasks lack tests, and the AI SDK usage is partially outdated.

**Risk assessment:**
- **HIGH**: Unbounded `semantic_embeddings` and `memory_events` table growth
- **MEDIUM**: Missing tests for maintenance scheduler, outdated AI SDK patterns
- **LOW**: Honcho session accumulation, `experimental_repairToolCall` instability

---

## 2. Architecture Overview

### 2.1 Three-Layer Authority System

| Layer | Component | Responsibility |
|-------|-----------|----------------|
| **Task-State** | `task-state.ts` + submodules | Task routing, evidence selection, checkpointing, project continuity |
| **Honcho** | `honcho.ts` | Semantic mirror: sessions, peers, conclusions, persona memory |
| **Working-Document** | `working-document-selection.ts`, `document-resolution.ts` | Live document focus signals, generated-document family ranking |

### 2.2 Integration Flow (Per Chat Turn)

1. `normal-chat-context.ts` → `buildConstructedContext()` → composes Honcho + task-state + knowledge
2. `chat-turn/finalize.ts` → dispatches:
   - `updateTaskStateCheckpoint()` - task state update
   - `mirrorMessage()` / `mirrorWorkCapsuleConclusion()` - Honcho sync
   - `runUserMemoryMaintenance()` - async maintenance trigger
3. `hooks.server.ts` → `ensureMemoryMaintenanceScheduler()` - starts scheduler on boot

---

## 3. Critical Issues Found

### 3.1 No Semantic Embedding Cleanup (HIGH RISK) — ✅ FIXED

**File**: `src/lib/server/services/semantic-embeddings.ts`

**Problem**: `semantic-embeddings.ts` has **no `deleteSemanticEmbedding()` function**. When artifacts or task states are deleted (via `hardDeleteArtifactsForUser`, `forgetTaskMemory`, `retry-cleanup`, or user purge), the corresponding `semantic_embeddings` rows are **not removed**.

**Impact**:
- Unbounded growth of `semantic_embeddings` table
- Potential pollution of semantic shortlists if subject IDs are reused
- Wasted storage space

**Evidence**:
- `retry-cleanup.ts` only deletes embeddings for `skill_note` artifacts (line ~XXX)
- No delete function exists in `semantic-embeddings.ts`
- `memory-maintenance.ts` does not perform embedding cleanup

**Fix**: Add `deleteSemanticEmbeddingsForSubjects()` and call from `memory-maintenance.ts` after pruning artifacts/task states.

---

### 3.2 No `memoryEvents` Pruning (HIGH RISK) — ✅ FIXED

**File**: `src/lib/server/services/memory-events.ts`

**Problem**: `memory-events.ts` records events indefinitely (deadlines, preferences, project transitions, document refinements). No age-based or count-based cleanup exists.

**Impact**:
- Unbounded growth of `memory_events` table
- `listLatestMemoryEventsBySubject()` scans increasingly large datasets
- Queries slow over time

**Evidence**:
- `recordMemoryEvent()` inserts with `onConflictDoNothing` but no delete
- `memory-maintenance.ts` does not touch `memory_events`

**Fix**: Add age-based pruning in `memory-maintenance.ts` (e.g., delete events older than 90 days, or keep only latest N per subject).

---

### 3.3 No Tests for `memory-maintenance.ts` (HIGH RISK) — ✅ FIXED

**File**: `src/lib/server/services/memory-maintenance.ts`

**Problem**: The entire maintenance scheduler is completely untested. The scheduler, debounce logic, error handling, and interaction between maintenance steps are not covered by any unit or integration tests.

**Impact**:
- Regressions in maintenance behavior go unnoticed
- Refactoring is risky
- No confidence in maintenance correctness

**Fix**: Create `memory-maintenance.test.ts` covering:
- Debounce logic (chat_send triggers, 10-min cooldown)
- Scheduler idempotency (multiple `ensureMemoryMaintenanceScheduler` calls)
- Error handling (partial failures don't crash scheduler)
- Interaction between maintenance steps

---

### 3.4 Outdated AI SDK Pattern in `control-model.ts` (MEDIUM RISK) — ✅ FIXED

**File**: `src/lib/server/services/task-state/control-model.ts`

**Problem**: `requestStructuredControlModel()` uses `generateText` + manual JSON parsing (`parseJsonFromModel`) instead of the modern `Output.json()` or `Output.object()` APIs.

**Impact**:
- Bypasses SDK validation and structured output guarantees
- Fragile to markdown fences, trailing commas, malformed JSON
- Won't benefit from `strictJsonSchema` or provider-native structured output
- Won't throw `NoObjectGeneratedError` for debugging

**Evidence**:
```typescript
// Current (fragile):
const content = await requestContextSummarizer(params);
const parsed = parseJsonFromModel(content);
return parsed ? (parsed as T) : null;

// Should be:
import { generateText, Output } from "ai";
const result = await generateText({
  model: provider(resolvedModelName),
  output: Output.json(), // or Output.object({ schema: jsonSchema(...) })
  // ...
});
```

**Fix**: Migrate to `Output.json()` for unstructured JSON or `Output.object()` with Zod schema.

---

### 3.5 `experimental_repairToolCall` — Unstable API (MEDIUM RISK) — ⚠️ MONITOR

**File**: `src/lib/server/services/normal-chat-model/index.ts`

**Problem**: The codebase uses `experimental_repairToolCall` for malformed tool call JSON repair. This is an experimental Vercel AI SDK feature that could change or be removed.

**Impact**:
- Future AI SDK updates may break this path
- No stable alternative currently exists

**Fix**: Monitor AI SDK changelog for `experimental_repairToolCall` stabilization. Consider implementing repair in the custom stream normalizer (`openai-compatible-stream-normalizer.ts`) before it reaches the AI SDK.

---

### 3.6 No Automatic Honcho Session Pruning (MEDIUM RISK) — ✅ FIXED

**File**: `src/lib/server/services/honcho.ts`

**Problem**: `deleteConversationHonchoState` is only called during **turn retry cleanup**. For normal conversations that are deleted or age out, old Honcho sessions, conclusions, and cards accumulate indefinitely.

**Impact**:
- Honcho backend grows unbounded
- Old sessions may return stale context if IDs are ever reused
- Memory leaks in external service

**Fix**: Add periodic Honcho session pruning in `memory-maintenance.ts` (e.g., delete Honcho state for conversations deleted > 30 days ago).

---

### 3.7 Memory Maintenance Swallows All Errors (MEDIUM RISK) — ✅ FIXED

**File**: `src/lib/server/services/memory-maintenance.ts`

**Problem**: `performUserMemoryMaintenance()` wraps the entire pipeline in `try/catch` that logs and silently discards errors.

**Impact**:
- Partial failures are invisible to the scheduler and admin endpoint
- No way to detect maintenance degradation
- One failing step (e.g., embedding backfill) may mask other issues

**Fix**: Collect per-step success/failure metrics and expose them via a health endpoint or admin UI.

---

### 3.8 `allowSystemInMessages` — Prompt Injection Risk (MEDIUM RISK) — ✅ FIXED

**Files**: `src/lib/server/services/task-state/control-model.ts`, `src/lib/server/services/title-generator.ts`

**Problem**: AI SDK 6 changed the default for `allowSystemInMessages` to `false`. The codebase explicitly opts into `true` in two places.

**Impact**:
- If user-controlled data can inject messages, this is a prompt injection attack vector
- System messages in the `messages` array are now rejected by default for good reason

**Fix**: Move system prompts to the top-level `system`/`instructions` parameter and remove `allowSystemInMessages` unless absolutely necessary.

---

## 4. Maintenance Coverage

### 4.1 Active Maintenance Tasks

| Task | Implementation | Trigger |
|------|---------------|---------|
| Task checkpoint pruning | Keep 6 micro + 3 stable per task | Every maintenance run |
| Stale task archiving | Archive after 30 days inactivity | Every maintenance run |
| Generated-output duplicate repair | Jaccard ≥ 0.82 → `archived_duplicate` | Every maintenance run |
| Generated-output family status repair | Dormant → `historical` | Every maintenance run |
| Semantic embedding backfill | Refresh missing/stale embeddings | Every maintenance run |
| Project status reconciliation | Reconcile against age/events | Every maintenance run |
| Orphan project pruning | Delete `memoryProjects` with 0 tasks | Every maintenance run |

### 4.2 Trigger Points

- **Chat turns**: `finalize.ts` calls `runUserMemoryMaintenance()` with 10-minute debounce
- **Knowledge reads**: `knowledge.ts` triggers maintenance
- **Admin endpoint**: `/api/admin/memory-maintenance` exposes manual trigger
- **Scheduled**: `hooks.server.ts` starts `setInterval` if `MEMORY_MAINTENANCE_INTERVAL_MINUTES > 0`

---

## 5. Long-Term Sustainability Risks

| Risk | Severity | Notes |
|------|----------|-------|
| Unbounded `semantic_embeddings` growth | High | No delete/orphan cleanup |
| Unbounded `memory_events` growth | High | No pruning |
| Unbounded `conversationSummaries` growth | Medium | No cleanup for deleted conversations |
| Unbounded `chatGeneratedFiles` growth | Medium | No orphan cleanup |
| `projects` orphans | Medium | Projects exist without conversations |
| Thundering herd maintenance | Medium | All users maintained simultaneously |
| Full-user embedding backfill | Medium | Loads all artifacts per user every cycle |
| `generatedOutputBackfillDone` cache | Low | Never invalidated, lost on restart |
| File-system orphan files | Medium | `data/knowledge/` and `data/chat-files/` may accumulate |

---

## 6. Recommended Fixes (Prioritized)

### Immediate (Do Now)

#### Fix 1: Add Semantic Embedding Orphan Cleanup
- **Files**: `semantic-embeddings.ts`, `memory-maintenance.ts`, `retry-cleanup.ts`
- **Action**: Add `deleteSemanticEmbeddingsForSubjects()` in `semantic-embeddings.ts`; call from `memory-maintenance.ts` after pruning; update `retry-cleanup.ts` to delete embeddings for all artifact types

#### Fix 2: Add `memoryEvents` Age-Based Pruning
- **Files**: `memory-maintenance.ts`, `memory-events.ts`
- **Action**: Add `pruneOldMemoryEvents(userId, maxAgeDays)` in `memory-maintenance.ts`; delete events older than 90 days or keep only latest N per subject

#### Fix 3: Write `memory-maintenance.test.ts`
- **Files**: New file `memory-maintenance.test.ts`
- **Action**: Test scheduler, debounce logic, error handling, and interaction between maintenance steps

#### Fix 4: Stagger Per-User Maintenance in Scheduler
- **Files**: `memory-maintenance.ts`
- **Action**: Distribute users across the interval window using small delays instead of sequential for-loop

### Short Term (Next Sprint)

#### Fix 5: Migrate `control-model.ts` to Modern Structured Output
- **Files**: `task-state/control-model.ts`
- **Action**: Replace `generateText` + manual JSON parsing with `Output.json()` or `Output.object()`

#### Fix 6: Add `conversationSummaries` Cleanup
- **Files**: `memory-maintenance.ts`
- **Action**: Delete summary rows whose `conversationId` no longer exists

#### Fix 7: Add `projects` Orphan Cleanup
- **Files**: `memory-maintenance.ts`, `task-state/continuity.ts`
- **Action**: Delete `projects` rows with no linked conversations

#### Fix 8: Add `chatGeneratedFiles` Orphan Cleanup
- **Files**: `memory-maintenance.ts`, `chat-files.ts`
- **Action**: Delete rows whose `conversationId` no longer exists

#### Fix 9: Add Periodic Honcho Session Pruning
- **Files**: `memory-maintenance.ts`, `honcho.ts`
- **Action**: Delete Honcho sessions/conclusions for conversations deleted or inactive > 30 days

#### Fix 10: Audit `allowSystemInMessages` Usage
- **Files**: `task-state/control-model.ts`, `title-generator.ts`
- **Action**: Move system prompts to top-level `system`/`instructions`, remove `allowSystemInMessages`

### Long Term (Next Quarter)

#### Fix 11: Make Embedding Backfill Incremental
- **Files**: `semantic-embedding-refresh.ts`, `memory-maintenance.ts`
- **Action**: Track `lastEmbeddingBackfillAt` per user or per subject; only backfill items newer than last run

#### Fix 12: Add Disk-Space Reconciliation Sweep
- **Files**: New utility or `memory-maintenance.ts`
- **Action**: Walk `data/knowledge/` and `data/chat-files/` to find files with no corresponding DB row

#### Fix 13: Migrate `system` → `instructions` for AI SDK 7
- **Files**: All files using `generateText`/`streamText` with `system` parameter
- **Action**: Replace `system` with `instructions` across codebase

#### Fix 14: Add Maintenance Health Metrics
- **Files**: `memory-maintenance.ts`, `routes/api/admin/`
- **Action**: Collect per-step success/failure metrics; expose via health endpoint or admin UI

#### Fix 15: Add `artifactChunks` Orphan Pruning
- **Files**: `memory-maintenance.ts`
- **Action**: Delete chunks whose `artifactId` no longer exists

---

## 7. AI SDK Version Status

- **Current**: `ai` package `^6.0.193` (AI SDK 6.x — current major version)
- **Already migrated**: `maxTokens` → `maxOutputTokens`, `CoreMessage` → `ModelMessage`
- **Deprecated**: `generateObject`/`streamObject` (not used in codebase ✅)
- **Coming in AI SDK 7**: `system` → `instructions` rename
- **Risk**: `experimental_repairToolCall` may change signature
- **Risk**: `allowSystemInMessages: true` creates prompt injection vulnerability

---

## 8. Honcho Integration Health

### ✅ Good
- Proper peer identity versioning (`users.honchoPeerVersion`)
- Graceful degradation with fallback chains (live → snapshot → persisted → empty)
- Session caching with version invalidation
- Message clipping to Honcho's 25k char limit
- Comprehensive error handling

### ⚠️ Concerns
- No automatic pruning of old sessions
- `peerContextCache` 30-second TTL may cause stale persona context
- Cache invalidation distributed across multiple functions (risk of missed keys)
- Honcho SDK completely outside Vercel AI SDK ecosystem (no shared retry/failover)

---

## 9. Appendix: Files Referenced

| File | Role | Lines |
|------|------|-------|
| `src/lib/server/services/task-state.ts` | Main facade | ~1,700 |
| `src/lib/server/services/honcho.ts` | Honcho adapter | ~1,250 |
| `src/lib/server/services/memory-maintenance.ts` | Maintenance scheduler | ~266 |
| `src/lib/server/services/memory-events.ts` | Event log | ~204 |
| `src/lib/server/services/memory.ts` | Knowledge Memory UI | ~251 |
| `src/lib/server/services/task-state/control-model.ts` | Structured JSON client | ~247 |
| `src/lib/server/services/task-state/continuity.ts` | Project continuity | ~2,000 |
| `src/lib/server/services/task-state/artifacts.ts` | Chunk selection | ~250 |
| `src/lib/server/services/semantic-embeddings.ts` | Embedding store | ~150 |
| `src/lib/server/services/semantic-embedding-refresh.ts` | Async refresh | ~200 |
| `src/lib/server/services/evidence-family.ts` | Duplicate repair | ~400 |
| `src/lib/server/services/working-document-selection.ts` | Live signals | ~600 |
| `src/lib/server/services/document-resolution.ts` | Family ranking | ~450 |
| `src/lib/server/services/chat-turn/finalize.ts` | Post-turn fan-out | ~761 |
| `src/lib/server/services/normal-chat-context.ts` | Context assembly | ~1,364 |
| `src/lib/server/services/normal-chat-model/index.ts` | Model execution | ~900 |
| `src/lib/server/db/schema.ts` | Schema definitions | ~1,300 |
| `src/hooks.server.ts` | App initialization | ~115 |

---

## 10. Implementation Record

**Completed:** 2026-06-03  
**Orchestrator:** Sisyphus (OhMyOpenCode)  
**Method:** 15 sub-agents across 4 parallel waves, TDD throughout  

**Verification at completion:**
- `npx vitest run src/lib/server/services/` → **1,613 tests pass** (139 files)
- `npx tsc --noEmit` → **zero type errors**
- `npm run check` → **0 errors**
- `npm run build` → **clean**

**Remaining risk:** `experimental_repairToolCall` (Fix 3.5) — monitor AI SDK changelog. Fix 13 (`system` → `instructions`) deferred until AI SDK v7 GA.

---

*Generated by Sisyphus (OhMyOpenCode) on 2026-06-03*
