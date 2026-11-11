# Accounting-independent message reads

Status: **Astra SPEC DESIGN PASS — conditional on the binding clarification below, now recorded.** Verdict supplied by the controller; no independent reviewer dispatch is claimed by this specification author. Controller selected rank 1 of the fresh architecture scan. This document is the sole authorized write. **Current live UI verification remains pending; application implementation is not authorized by this update.** The controller must confirm UI completion and then dispatch a fresh implementation worker under the clarified specification. A specification pass is not implementation acceptance or release authorization.

## Problem and evidence

Durable conversation history must remain readable when optional accounting queries fail independently of message storage. The inspected source was `75274b2ee`; the failure chain is confirmed by source inspection, not by a fault-injection run in this scan.

- `src/lib/server/services/messages.ts:584–601`: `messageWindowBaseQuery` selects message rows with mandatory joins to `usageEvents` and `messageAnalytics`.
- `messages.ts:608–647`: the common mapper awaits `getNormalChatMessageUsageProjections` without failure isolation. `listMessages` and `listMessageWindow` both use it (`650–705`). A ledger-only failure rejects otherwise successful message and attachment reads.
- `src/lib/server/services/chat-turn/context-selection.ts:1314`: `loadSessionPromptContext` catches that rejection as an empty stored history. Its projection needs durable history, not financial availability.
- `src/lib/server/services/conversation-detail/read-model.ts:182–224`: full detail awaits the message window and a separate `getConversationCostSummary` in mandatory `Promise.all`. Either accounting path can reject refresh. Lines `270–271` unconditionally access the summary totals.
- `src/lib/server/services/conversation-detail/types.ts`: `totalCostUsdMicros?: number` and `totalTokens?: number` already permit aggregate omission. No payload type extension is needed.
- `src/lib/server/services/analytics.ts:2892–2969`: the current batched ledger projection owns segment aggregation, but map absence allows legacy fallback in the message mapper. A failed lookup cannot be substituted with an empty map: it has not established legacy eligibility.
- `analytics.ts:2973–3024`: strict `getMessageUsageState` depends on `getConversationCostSummary` and must not receive forged ready totals or a globally weakened return contract.

The previous HTML report's implemented items 01/02/03/05/06/11 are not candidates here; item 04's general admission work and unrelated items 07–10 remain outside this change. This is one reliability improvement, including the aggregate read that would otherwise defeat it.

## Required behavior and unchanged interface

Keep `listMessages(conversationId): Promise<ChatMessage[]>` and `listMessageWindow(conversationId, options): Promise<MessageWindowPage>` unchanged. Keep existing authorization, conversation scope and incognito policy. Introduce no raw prompt-history public interface, speculative adapter, new top-level module, public catch-wrapper or caller-supplied lifecycle policy.

Both readers must share durable message mapping: exact body and IDs, roles, timestamps, ordering/sequence, canonical output/completion metadata, thinking/tool history, attachments, pictures and continuation/fork links remain unchanged. Neither optional usage failure nor attempt multiplicity can drop, duplicate, reorder, truncate or replace a message. Preserve offset, limit, lookahead, `hasMoreBefore` and current attachment semantics. Select and page at message grain before enrichment; do not join individual attempts into the limited query. The lookahead row need not be enriched.

The mandatory core query must cease joining both `usageEvents` and `messageAnalytics`. Read durable messages and attachments through the existing owners, then enrich only the returned rows. Missing numeric enrichment remains absent, never a default zero. A mandatory message, attachment or required conversation/privacy read failure must still reject the message reader. Do not add a catch returning `[]` or an empty page in `messages.ts`; changing Context Selection's general core-storage failure policy is outside this specification.

## Existing analytics module owns optional per-message policy

Extend the existing analytics module's read implementation to resolve ledger precedence, legacy eligibility, legacy usage and accounting availability together. The message mapper consumes that result once; it must no longer know which accounting table wins or when legacy fallback is allowed. Any internal helpers remain implementation details, not new public layers. Keep the existing ledger-specific interface's strict callers and accounting behavior intact unless a separately reviewed compatible change is demonstrably necessary.

The small per-message read interface accepts a scoped conversation and the selected assistant message IDs. Its result must distinguish successful resolution from unavailable lookup, with successful entries distinguishing ledger ready, ledger pending, proven legacy and incognito untracked. Exact TypeScript names are an implementation choice; these semantics are binding:

| State | Projection |
| --- | --- |
| Ledger ready | Use that message's linked segment only. Preserve existing exact attempt sums, known zero, nullable optional duration/reasoning and sealed-empty-manifest behavior. Do not add reasoning tokens again to output or total tokens. |
| Ledger pending | Suppress all final numeric usage fields, including legacy duration and any known child subtotal. No legacy fallback. Later final usage may make a later read ready. |
| Proven legacy | Only a successful scoped ledger lookup proving no association allows the existing legacy usage/model fallback. Preserve observed legacy values and genuinely known zero. A successful lookup with no observed legacy usage leaves fields absent. |
| Incognito untracked | Determine current incognito state before optional accounting reads. Do not consult ledger/legacy financial data for that conversation or expose person-linked usage. Return the core history normally. |
| Lookup unavailable | Omit uncertain usage, including cost, response/reasoning/total tokens and aggregate generation duration, for every assistant in this lookup. Do not infer legacy eligibility, pending, ready, untracked or zero from failure. Do not reuse stale legacy values, estimates, cached numeric enrichment or partially collected results. |

Resolve required privacy information through a scoped conversation read independent of accounting tables, shared per reader invocation rather than once per message. A failed privacy lookup is a mandatory failure, not permission to enrich or to claim incognito. Existing callers retain authorization responsibilities; this change creates no new access policy.

### Binding Astra clarification: empty reads, privacy absence and strict callers

Preserve existing reader behavior for a nonexistent conversation, an empty conversation, a user-only result and an offset beyond the final message. Return the existing empty list/page or user-only rows, with unchanged attachments and `hasMoreBefore` semantics. These cases have no selected assistant IDs: perform no ledger or legacy accounting queries, and do not introduce a conversation-existence/privacy query solely for enrichment or a new not-found error. Existing mandatory message/attachment reads still run as required by the current readers; their failures still reject. This fast path concerns per-message enrichment, not the independently optional full-detail conversation summary for an existing authorized conversation.

When selected assistant rows require a privacy lookup, distinguish a thrown/rejected query from a successful lookup with no conversation row. An actual privacy-query failure rejects as a mandatory read failure. Successful absence is not an error introduced by enrichment and is not evidence of incognito or legacy eligibility: return the already-selected core rows without financial enrichment and do not query accounting tables. This also covers a conversation deleted between core selection and privacy lookup. Do not silently convert a query failure into successful absence. Normal Conversation Detail Read Model missing-conversation and authorization behavior remains unchanged.

`getMessageUsageState` also calls `getNormalChatMessageUsageProjections`, in addition to `getConversationCostSummary`. Preserve both existing strict interfaces, return types and rejection behavior for that endpoint. Keep optional-read recovery at the message-enrichment policy and the full-detail assembly site; do not change the shared ledger helper to swallow failures or return an empty map, pending, untracked or ready on error. Shared internal query logic may be reused, but availability recovery for ordinary history must not leak into strict financial callers.

### Batch and partial-failure semantics

Use at most 500 distinct requested message IDs per accounting batch, preserving the current SQLite parameter discipline. Query count is bounded by batch count, never by individual messages. For ledger status and attempts, retain a consistent per-batch SQL snapshot so ready cannot be combined with a torn partial sum.

**Availability is all-or-nothing for one per-message projection lookup**, spanning all its ledger and eligible legacy batches. Accumulate results privately and publish only when all required queries succeed. If batch two fails after batch one succeeds, discard batch one's optional results and report unavailable for the complete requested set. Failure in either ledger or legacy lookup makes the complete lookup unavailable; no mixture of failed-query guesses and authoritative numbers. No transaction spanning core history and optional enrichment is required, and this does not promise a single accounting snapshot across all batches.

An empty requested set performs no accounting queries. Untracked incognito bypasses them regardless of injected failures. Unavailable is an internal availability fact; retain the existing serialized optional `ChatMessage` fields rather than inventing a new financial response state or UI label.

### Model identity and display metadata

Persisted message metadata remains available when accounting is unavailable: preserve recorded model/provider identity and display/icon fields where actually present and valid. Healthy optional legacy projection may provide existing historical identity/display fallbacks for rows without sufficient saved metadata. It must not override a trustworthy persisted identity with an inferred current/default/winning model. Inspect the actual metadata fields before implementation; do not assume every historical message has a persisted model ID. Missing identity remains absent rather than guessed from current provider configuration. Financial uncertainty must not erase independent durable display metadata.

## Read-model aggregate composition

Keep `getConversationCostSummary` strict and its `ConversationCostSummary` return type unchanged. Strict financial callers, including `getMessageUsageState`, must continue rejecting storage failure rather than receiving fabricated ready values.

The existing Conversation Detail Read Model owns whether aggregate enrichment is optional for its payload. At its one assembly site, compose `getConversationCostSummary(...).catch(() => null)` and conditionally include both aggregate fields only when the read succeeds. On unavailable summary, omit `totalCostUsdMicros` and `totalTokens`; do not serialize zero, null into numeric fields, or a previous successful result. Successful known-zero summaries retain zero. Preserve bootstrap behavior; do not query optional financial tables before incognito is resolved, and omit financial totals for untracked incognito full detail.

This local catch is appropriate assembly policy, not a new analytics abstraction: a wrapper/export that merely returns summary-or-null would fail the deletion test. Analytics owns the substantial per-message precedence/aggregation/availability policy; the read model owns optional aggregate inclusion. Do not scatter catches into routes, clients, pages or strict financial callers. The two optional reads are independently available: a successful conversation aggregate may coexist with unavailable per-message usage, and vice versa; neither substitutes for the other.

With other mandatory detail dependencies healthy, actual full `getConversationDetail` and older-message windows must preserve their messages when accounting-only queries fail. Fixing only the mapper is insufficient because of the independent summary await. This does not promise success for a whole-database outage or unrelated failed detail dependencies.

## Required fault-injection and regression evidence

Implementation must first establish the relevant failing behavior, then verify through existing module interfaces with isolated migrated synthetic SQLite data and installed Vitest APIs. No private chats, model calls, external services or live accounting mutations are needed. Fault only the named accounting operations while durable messages, attachments, conversation/privacy reads and unrelated detail dependencies remain healthy. Do not mock `listMessages`, `listMessageWindow` or `loadSessionPromptContext` in the call-chain regressions.

1. **Ledger failure:** seed several durable turns and a linked ledger assistant with stale legacy financial data. Reject the ledger read. Both actual message readers return identical bodies/IDs/rich metadata/attachments/order to their healthy core baseline; every uncertain numeric usage field is absent. A stale known cost or duration must never reappear.
2. **Legacy failures independently:** reject `usageEvents` read and `messageAnalytics` read separately, with ledger reads otherwise healthy. Prove these tables are no longer in the mandatory core query. Both readers preserve messages and suppress optional projection for that complete lookup. Check all-or-nothing behavior even when ready ledger values were already read.
3. **Partial batches:** request more than 500 distinct assistant IDs; fault a later ledger batch, then a later legacy batch separately. No earlier-batch numbers escape. Assert bounded queries, unchanged IDs/pages and no per-message query loop. A subsequent healthy lookup restores authoritative values.
4. **Actual Prompt Context chain:** invoke real `buildConstructedContext` through real message readers and analytics policy. Inject ledger and legacy failures separately. Assert prior user/assistant body and identity/order survive into selected history with the same history budget, sequence/compaction and `historyBeforeMessageId` behavior. Keep unrelated context selection deterministic; mocking `listMessages` to reject or return fixtures does not prove this handoff.
5. **Full detail and paging:** invoke actual `getConversationDetail` and `getOlderConversationMessages`, retaining real messages/analytics owners. Exercise ledger-only failure, legacy-table query failures, and isolated summary failure. Full detail must resolve with the same messages and paging facts. Summary failure omits both optional totals; successful totals remain independent of per-message availability. Rejecting the whole DB is not this test.
6. **Financial truth:** retain ready positive/zero, ready optional NULL, sealed ready empty manifest, known child plus unknown attempt, unpriced final usage and pending-to-ready late reconciliation. Preserve reasoning as an output breakdown. A successful legacy lookup retains genuine legacy values. No failure turns unknown into zero or ready.
7. **Segments and privacy:** mixed legacy/ledger/user messages, multiple working/fallback/closing attempts and resumed segments keep per-message segment attribution without logical-turn contamination. Cross-conversation/non-assistant IDs yield no unauthorized projection. Incognito resolves before optional reads: assert zero accounting queries and no leaked financial values, including when stale financial rows exist. Privacy/core lookup failure rejects rather than claiming untracked.
8. **Core failure and read-only behavior:** reject mandatory message and attachment reads separately; both readers still reject, with no success-shaped empty history. Repeat successful and failed reads and compare accounting/ledger/message contents: no new billing event, attempt capture, repair, status change or other write. Existing billing totals and strict usage-endpoint failure behavior remain unchanged.
9. **Identity and pagination:** saved display/provider metadata survives every optional failure; historical missing identity is absent rather than guessed. Cover a message at a page boundary with several attempts, nonzero offsets, disjoint pages and `hasMoreBefore`. Healthy enrichment preserves current intended model/display fallbacks without altering bodies/IDs.
10. **Astra clarification regressions:** through both actual readers, cover nonexistent and empty conversations, user-only selected rows, and an empty offset even when other pages contain assistants. Assert unchanged results and zero ledger/legacy queries, without an enrichment-only existence/privacy lookup or new existence errors. With selected assistants, separately inject successful privacy-row absence after core selection and a privacy-query exception: absence preserves core rows without accounting reads, while the exception rejects. Through real `getMessageUsageState`, separately reject its ledger helper and conversation summary; each still rejects with no fabricated financial state. Retain endpoint authorization, missing-message and incognito behavior.

The existing `messages.usage-projection.test.ts` and `analytics.message-usage.test.ts` cover healthy/pending settlement but do not establish accounting-failure isolation. Extend behavior-level coverage, rather than replacing real-owner tests with assertions about SQL spelling. Existing Context Selection tests that mock the messages module cannot serve as the actual call-chain regression. Controller owns the later combined verification/gates and any browser/release decisions; this draft runs none.

## Deletion test and alternative ranking

1. **Selected: all optional accounting after core history.** Removing the analytics policy would force ledger precedence, legacy eligibility, batching, failure atomicity and financial honesty back into both readers and their callers. That is substantive depth at an existing seam, with locality for fixes and leverage across Prompt Context and refresh. Core message mapping stays shared.
2. **Ledger-only catch.** A bounded containment fix, but legacy joins still make history depend on accounting. A new catch-wrapper adds no depth; deleting it merely moves the same catch. Returning an empty map is incorrect because it permits stale legacy fallback.
3. **Raw prompt-history interface.** Could protect one caller but leaves refresh exposed and risks parallel rich-history mapping. A wrapper over `listMessages` removes nothing; an independent implementation duplicates durable projection. Do not introduce it for this defect.

The actual adapters differ in full-history versus bounded-window selection and plain versus stream transport. Those differences do not justify separate financial failure policy. SQLite is local-substitutable; exercise the existing SQLite implementation against migrated synthetic test databases, with fault injection at internal accounting reads. Do not access a live production database. No speculative public adapter seam is needed.

## ADR alignment, documentation check and review handoff

- ADR-0015: durable Normal Chat Turn Completion remains in chat-turn; reads do not repair, resettle or regenerate a turn.
- ADR-0022: the existing Conversation Detail Read Model still owns refresh assembly, including optional aggregate inclusion; routes remain adapters.
- ADR-0041: admission/preparation ordering is unchanged.
- ADR-0056: persisted Thinking Trace, Interim Thought Steps and anchors pass through unchanged; accounting failure must not re-derive or erase them.
- Read root/services/chat-turn AGENTS and relevant Normal Chat CONTEXT definitions before drafting. No new domain concept, top-level module or second refactor is proposed.
- Controller completed official documentation checks: Drizzle SELECT <https://orm.drizzle.team/docs/select> and Vitest mocking <https://vitest.dev/guide/mocking.html>. No MCP docs tools were available. Repository versions are Drizzle 0.45.2 and Vitest 4.1.11; current Vitest web docs describe newer v5, so implementation must use installed-version-compatible APIs. Do not change dependencies. This spec author made no network calls.

Review disposition: controller reports **Astra SPEC DESIGN PASS**, conditional on explicitly preserving empty/nonexistent/user-only/empty-offset behavior, separating privacy-query failure from successful absence, and keeping both ledger and summary dependencies of `getMessageUsageState` strict. Those binding requirements are recorded above with required regressions. The approved design includes the core/optional split, all-or-nothing batch honesty, incognito-before-enrichment, safe identity fallback, real Prompt Context/full-detail fault tests and strict-summary/local-composition tradeoff. Controller must separately confirm live UI completion before dispatching application implementation.

Review state: conditional SPEC DESIGN PASS and binding clarification recorded; controller prerequisite **live UI verification still pending**. Fresh implementation-worker dispatch remains controller-owned. No application edits, tests, gates, browser/model/network calls, commit, push or deployment performed by this specification slice.

Controller review checkpoint (2026-11-11): Astra independently reread the recorded clarification and returned **final SPEC PASS**. The native UI prerequisite remains pending; no application edits are authorized yet. A fresh implementation worker is preparing only.
