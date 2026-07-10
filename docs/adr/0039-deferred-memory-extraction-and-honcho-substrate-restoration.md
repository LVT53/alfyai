# Deferred Memory Extraction restores Honcho as substrate with LLM-assisted Tier 2 intake

> **Superseded by [ADR-0045](0045-memory-v2-judge-gated-local-memory.md) (2026-07-10).** The Honcho substrate this ADR set out to restore was subsequently deleted. Memory is now local-only and judge-gated; there is no substrate behind the projection and no reconcile-later path. This ADR is retained as history.

AlfyAI memory has two intake layers: Immediate Memory Admission (Tier 1, regex-based, fast) and Deferred Memory Extraction (Tier 2, LLM-assisted, bounded). The refactor in commit 6936d067d intentionally removed `mirrorMessage` to fix bloat, but the replacement was only Tier 1 regex. Tier 2 LLM extraction was designed in ADR 0033 but never built. Without Tier 2, the Memory Profile Projection became the primary store for admitted memories, and Honcho received no new conclusions. This accidentally violated ADR 0011's rule against a parallel local persona-memory system.

This decision restores the full two-tier intake design without reviving the code patterns that were intentionally removed. Honcho returns as the Memory Authority Substrate. The Memory Profile Projection remains the active read model.

## Context

ADR 0011 established Honcho as the persona and memory authority. The rule was clear: do not build a parallel local persona-memory system. ADR 0033 designed the Memory Intake Gate with three outcomes (admit, reject, defer to maintenance) and described how deferred intake would become maintenance work for later bounded reconciliation, but it specified immediate admission patterns without fully detailing the deferred extraction mechanism.

The `mirrorMessage` removal was correct. Raw transcript mirroring was a noisy substrate that the Memory Rework Update explicitly rejected. Every message should not become durable persona memory just because it occurred. The error was not in removing `mirrorMessage`. It was in shipping Tier 1 regex-only intake without the Tier 2 LLM-assisted path that ADR 0033 described as deferred maintenance work.

The result was a drift toward the local store as the primary memory authority. Admitted memories existed only in the Memory Profile Projection. Honcho sessions stayed empty. The projection-first principle of ADR 0033 (user-facing truth is immediate; Honcho catches up later) was never realized because there was no path for Honcho to catch up.

## Considered Options

1. **Accept the divergence, make the local store the primary memory authority (rejected)**. This would make the Memory Profile Projection the canonical durable store and treat Honcho as optional enrichment. Rejected because it violates ADR 0011 and ADR 0033, creates a single point of failure for cross-session recall, and would require the app to own all memory synthesis without benefitting from Honcho's representation, peer, and session infrastructure.

2. **Real-time LLM extraction during chat turns (rejected)**. Running a full LLM extraction call on every chat turn would add latency, burn tokens, and violate the Memory Rework Update rule that maintenance is bounded and deferred. Rejected because chat should stay responsive and extraction should be coalesced.

3. **Use Honcho's deriver as the primary extraction engine (rejected)**. ADR 0033 is explicit that Honcho should not be the extraction engine. The app decides what is memory-worthy. Honcho deriver processes what the app sends. Letting Honcho decide intake would recreate the noisy substrate problem from raw mirroring with better formatting.

4. **Deferred Memory Extraction with Honcho substrate restoration (chosen)**. Build Tier 2 LLM extraction as bounded maintenance work within the existing Memory Maintenance Scheduler and Bounded Memory Reconciliation Slice infrastructure. Use conversation summary plus raw turns as extraction input. Write only high-confidence structured candidate memories as Honcho conclusions via the dirty ledger reconciliation path. Keep the Memory Profile Projection as the active read model while Honcho is the backing substrate that catches up asynchronously.

## Decision

1. **Build Tier 2 Deferred Memory Extraction within existing maintenance infrastructure.** It lives in `src/lib/server/services/memory-maintenance.ts` as a maintenance slice type, not as a new top-level service. The Memory Maintenance Scheduler claims deferred extraction work alongside other dirty ledger entries.

2. **Restore Honcho as Memory Authority Substrate via projection-first, Honcho-reconcile-later.** Admitted memories write to the Memory Profile Projection immediately (Tier 1) or after extraction (Tier 2). Honcho receives conclusions asynchronously during bounded reconciliation. The projection is the active read model; Honcho is the durable backing store that enables cross-session and cross-conversation recall.

3. **The app owns the LLM extraction; Honcho is not the extraction engine.** The extraction uses the app's configured model (defaulting to the model set via `MEMORY_LEGACY_CURATION_MODEL` or the primary chat model). Extraction input is structured: conversation summary for context and raw turns for candidate text. Output is structured candidate memories with category, scope, and Memory Decision Confidence Band.

4. **Admitted candidates write to Honcho as conclusions.** After deferred extraction produces admitted memories, the dirty ledger triggers Honcho conclusion creation during bounded reconciliation. This is the Honcho reconcile-later path: projection is immediate, substrate catches up.

5. **Conversation summary plus raw turns supplement as extraction input.** The extraction inspect window uses conversation summary for broader context and raw recent turns for exact candidate text. This avoids the bloat of full transcript mirroring while giving the LLM enough material to extract meaningful durable facts.

6. **Hungarian language support for Tier 1 regex.** The Immediate Memory Admission regex patterns include Hungarian equivalents alongside English. Tier 2 LLM extraction works in both languages through the app's configured model.

7. **NOT restoring `mirrorMessage`.** Raw transcript mirroring remains removed. Honcho sessions stay empty for raw chat transcript by design. Only curated conclusions are written to Honcho. This is the clean substrate ADR 0033 intended.

## Consequences

- Honcho sessions stay empty for raw transcript by design. Only curated, admitted conclusions are written. This is the intended design from ADR 0033, not a gap.

- The Memory Profile Projection is the active authority for prompt-time personalization. Honcho is the backing substrate that catches up asynchronously through bounded reconciliation slices.

- Deferred extraction runs during Expensive Memory Reconciliation, not during chat turns. Chat responsiveness is unaffected. Memory profile freshness may lag briefly after a chat turn, but the visible Memory Profile handles this through the existing stale/dirty signal.

- The extraction inspect window is bounded by configured slice limits (candidate count, token budget, time budget). Large conversations are processed incrementally across multiple maintenance slices rather than one unbounded pass.

- Hungarian and English Tier 1 regex patterns must be maintained together. Adding a new memory signal language requires updating both pattern sets.

- If Honcho is disabled or unreachable, the Memory Profile Projection remains the sole memory authority. This is an existing fallback path; the deferred extraction reconciliation simply skips the Honcho write step and marks it as retryable dirty work.

- The tiered design (Tier 1 regex immediate, Tier 2 LLM deferred) gives operational flexibility: Tier 2 can be upgraded, model-swapped, or temporarily disabled without affecting Tier 1 immediate admission or the chat path.

## Acceptance Scenarios

- When Immediate Memory Admission cannot confidently admit or reject a candidate, the conversation is marked with deferred extraction dirty state. A later maintenance slice runs Tier 2 LLM extraction on the recent turns, produces structured candidates, and writes high-confidence admitted memories to both the Memory Profile Projection and Honcho.

- When Honcho is available, admitted memories from deferred extraction appear as conclusions in the user's Honcho session during the next bounded reconciliation slice, not during the chat turn that produced the material.

- When Honcho is unavailable, deferred extraction still produces Memory Profile Projection items. The Honcho write step is retried in a later maintenance slice.

- A conversation with Hungarian content produces Tier 1 regex matches for Hungarian memory signals and is eligible for Tier 2 LLM extraction with the same structured output expectations.

- The maintenance scheduler coalesces deferred extraction requests across multiple active conversations for the same user rather than running one extraction pass per conversation.

- Raw `mirrorMessage` is not restored. Honcho sessions do not contain raw transcript. The only durable Honcho data is curated conclusions from admitted memories.
