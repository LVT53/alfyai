# Replacement integration boundaries

Source audit, 2026-11-18. AlfyAI checkout `e60bb0c114c02a3063d5bf6972ddeb813cccbf6c`. Scope: the approved full replacement in [replacement-readiness.md](replacement-readiness.md), including retained features from the [inventory](prior-findings/ui-inventory.md). No product code, production records or live-user data were changed or accessed. These are source findings and implementation acceptance requirements, **not passed integration tests**.

## Decision

The app integration has identifiable, bounded owners. Hindsight does not require replacing Knowledge, chat orchestration, task continuity, account lifecycle or the entire `memory_context` tool. Replace profile-memory storage/intake/retrieval and the Memory UI, then extend the existing lifecycle/export owners. Authentication, privacy admission, reliable delivery, user correction intent and publication consistency remain app responsibilities.

This audit found no additional architectural prototype necessary for those ordinary integration boundaries. It does **not** close the claim-quality and practical-update gates P1/P2. Their outcome determines whether the app-owned correction/publication work is acceptably small. Integration parity can only be certified after implementation; designing the UI now must distinguish available memories, pending changes, failed changes and unavailable retrieval.

## Findings and concrete boundaries

### Privacy admission needs a stronger contract

The current master switch promises no learning or recall, while incognito promises no memory learning or memory/project-context injection. But [`memory-controls.ts`](../../../src/lib/server/services/memory-controls.ts:20) defaults a missing user to enabled and a missing conversation to non-incognito. Baseline retrieval, tool retrieval and post-turn ingestion also catch control errors as enabled: [`context-selection.ts`](../../../src/lib/server/services/chat-turn/context-selection.ts:404), [`memory-context.ts`](../../../src/lib/server/services/memory-context.ts:42), [`dispatch.ts`](../../../src/lib/server/services/memory-judge/dispatch.ts:63).

**Required replacement boundary:** one server-owned admission decision validates account existence, conversation ownership, memory setting, incognito and current privacy/reset epoch. Unknown admission means no memory access; chat continues without memory. Enforce it at delivery, execution and publication as well as retrieval. A job must carry its original epoch; it must never acquire today's epoch merely because it was retried. Turning memory off must invalidate pending learning eligibility without erasing the user's existing readable Memory page. Re-enabling must not silently backfill the disabled interval.

Incognito is currently one-way and can be enabled only before a chat has messages; the route validates ownership. Preserve this contract, rather than designing an ordinary reversible toggle: [`conversations/[id]/+server.ts`](../../../src/routes/api/conversations/[id]/+server.ts:89). Standing instructions still apply in incognito; the existing tool catalog withholds `suggest_instruction`. Memory replacement should not quietly change that separate behavior: [`shared-normal-chat-model-run-helpers.ts`](../../../src/lib/server/services/chat-turn/shared-normal-chat-model-run-helpers.ts:620), [`normal-chat-tool-gating.ts`](../../../src/lib/server/services/chat-turn/normal-chat-tool-gating.ts).

`/remember` needs explicit handling. Its endpoint authenticates and directly creates a global user-authored item, but receives no conversation identity and does not consult memory controls: [`notes/+server.ts`](../../../src/routes/api/memory/notes/+server.ts:26). Therefore hiding the command in the composer is insufficient. Recommended contract: reject chat-origin saves in incognito or while memory is off; allow reviewing/correcting existing items from Memory while off. Carry authenticated chat context for chat-origin saves. Preserve explicit authorship and exact source text, without reinstating the dropped permanent-endorsement subsystem.

### Replace the persona branch; preserve independent continuity

Baseline profile injection already has a shared facts-only, model-budgeted seam with summary disabled: [`context-selection.ts`](../../../src/lib/server/services/chat-turn/context-selection.ts:384). The `memory_context` executor supplies server-owned user/chat identity, and its reader branches into persona, project and history: [`normal-chat-tools/index.ts`](../../../src/lib/server/services/normal-chat-tools/index.ts:993), [`memory-context/read.ts`](../../../src/lib/server/services/memory-context/read.ts:155). Project/history also serve reports and attachments.

Replace persona retrieval behind these boundaries; retain the project/history and attachment implementations. Baseline and tool retrieval must consume the same admitted source representation and revision policy. Scope must be enforced on evidence and derived observations, not just on displayed labels. Prompt budgets and retrieval failure must remain bounded; an unavailable memory service must not prevent an ordinary answer. Post-turn delivery belongs at the existing finalizer/judge dispatch seam, with durable source identity, source version, retries and conditional progress: [`memory-judge/dispatch.ts`](../../../src/lib/server/services/memory-judge/dispatch.ts).

### Reset, erase and export are cross-store workflows

The lifecycle owner already centralizes password-confirmed self-service and admin erasure. Clear Memory and Knowledge advances reset generation, deletes the appropriate knowledge artifacts and reset-scope rows, and clears evidence while preserving chats/generated chat outputs. Account erasure quiesces work before purge and identity deletion: [`account-lifecycle/index.ts`](../../../src/lib/server/services/account-lifecycle/index.ts:74), [`privacy-controls/index.ts`](../../../src/lib/server/services/privacy-controls/index.ts:68).

There is no Hindsight lifecycle integration today. A SQLite cascade cannot remove an external bank. Extend this owner with durable, retryable external deletion and an admission fence before cleanup. Cover clear-memory, clear-workspace, self-erasure and admin erasure. Cleanup must include current and superseded banks, app intent/source records, histories and pending jobs. Keep enough non-content deletion bookkeeping to finish after account removal, without allowing retries to recreate a bank for an erased user. An external outage must produce an honest pending/failed deletion state, not a successful-erasure claim. Specify backup retention separately from immediate deletion in the active service; do not promise a distributed atomic transaction.

Current reset is partly **logical visibility**, not physical deletion of every profile row: the registry leaves profile items/provenance and watermarks outside reset scopes, while reads filter current generation. See [`user-scoped-tables.ts`](../../../src/lib/server/services/account-lifecycle/user-scoped-tables.ts:385), [`read-model.ts`](../../../src/lib/server/services/memory-profile/read-model.ts:125), [`reset-generation.ts`](../../../src/lib/server/services/memory-profile/reset-generation.ts). Migration or replay must never interpret old-generation records as current memory.

The account archive's memory section currently exports task-state and memory-event rows; it does not enumerate current profile items or their provenance. See [`account-data-archive/index.ts`](../../../src/lib/server/services/account-data-archive/index.ts:206) and its [`addMemorySection`](../../../src/lib/server/services/account-data-archive/index.ts:776). Extend this existing password-confirmed export owner with readable published memory, eligible source/provenance and correction/removal history under the chosen retention policy. Do not equate a native bank dump with a finished user archive. Capture a consistent published revision or explicitly report snapshot timing; exclude embeddings, credentials and operational internals.

## Migration and cutover recommendation

1. Keep the old engine authoritative until qualification. Assign an explicit source cutoff and record the old reset generation and intake progress. Do not run two production writers for the same personal memory.
2. Migrate current-generation deliberate user notes/edits with original provenance and dates. Preserve manual intent without importing legacy permanent protection. Do not blindly convert existing automatic guesses into newly asserted user facts. Decide whether automatic memories are re-evaluated from eligible evidence or left behind; this is a visible migration policy, not a technical guarantee.
3. Backfill only eligible, owned, non-incognito evidence within the approved interval. Honor reset/off cutoffs and source changes. Stable IDs and idempotent jobs must prevent duplicate retains and resurrected removed claims.
4. Switch all persona reads and writes together under one per-user engine state. Keep project/history continuity separate. Record migration status and failures for recovery.
5. Rollback must preserve edits/removals made after cutover. An untouched legacy snapshot is unsafe to reactivate after those changes. Safe fallback is chat without profile memory until migration/rollback reconciliation completes, unless a tested reverse migration exists. Never silently restart legacy intake or display an earlier, deleted fact.

This is feasible integration work, but not an executed migration rehearsal. It requires an explicit automatic-memory migration policy before implementation acceptance.

## Finite implementation acceptance suite

| Test | Required observable result |
|---|---|
| Identity and isolation | User A cannot read/mutate/export user B's facts, sources, histories, jobs or banks through any app route; clients cannot choose an authoritative bank identity. Missing/erased identity and control lookup failure produce no memory operation. |
| Off transition | Pause a queued and an in-flight retain, turn memory off, then resume/restart workers. Neither becomes usable memory; recall is suppressed and existing items remain viewable. Re-enable does not ingest the disabled interval. |
| Incognito | Validate empty-chat-only, one-way semantics; baseline, tool, background and direct `/remember` paths obey the policy. Normal standing instructions retain their existing behavior. |
| Reset/erase race | Pause each worker phase, clear/reset/erase, then resume and retry. No old memory reappears, no erased account bank is recreated, and clear-memory preserves chats/generated outputs. Test remote failure and recovery, including admin erase. |
| Export | An authenticated archive contains the intended published memories, exact user notes and permitted provenance for that user, with consistent revision handling and no internal secrets or other-user data. |
| Scope and source changes | Global versus project/chat/source eligibility holds for both raw and derived retrieval. Changed/deleted sources and stale user actions cannot publish mixed revisions or leak another scope. |
| Chat integration | Send, stream, retry and `memory_context` use bounded consistent persona retrieval; project/history/report/attachment continuity survives. Service failure yields useful chat with accurately absent memory. |
| Delivery and restart | Duplicate events, interruption and conflicting jobs settle idempotently without losing eligible turns; processing/failure/retry UI matches actual committed publication. |
| Migration and rollback | Rehearse synthetic users with pre-reset records, incognito chats, disabled intervals, manual edits/removals and pending jobs. One authority remains active; cutover/rollback does not resurrect or silently drop deliberate user changes. |

These are bounded release tests, not reasons to keep prototyping architectures indefinitely. The app boundaries can be designed now; P1/P2 must establish the representation and mutation semantics before calling the replacement design settled. No claim that full integrated parity already passes is supported by this audit.
