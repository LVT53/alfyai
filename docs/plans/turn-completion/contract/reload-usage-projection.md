# Reload usage projection — R1 specification and implementation handoff

Status: ACCEPTED specification; implementation ready for Astra diff review. Astra returned **SPEC PASS — implementation unblocked**, recorded under “R1 amendment SPEC checkpoint” in `.superpowers/sdd/implementation-plan/astra-full-change-review.md`; the controller subsequently authorized TDD implementation. Source initially inspected at `dd51fd9d2` on `fix/turn-completion`; UI-worker commit `1a1564aa3` is the handoff HEAD, with R1 left uncommitted. Implementation and whole-change acceptance remain pending. This document authorizes no release action.

## Confirmed defect

Analytics bills final priced attempts once under `turn-attempt:<attemptId>` and suppresses the legacy winning-message event for ledger-linked assistants. `messages.ts` still joins usage only through the saved message ID. Consequently both `listMessages` and `listMessageWindow` omit ledger-linked cost and token totals on reload. The real `getMessageUsageState` owner already returns the priced segment cost.

The supplied isolated migrated-SQLite probe was rerun unchanged with Node 22: one expected failing test; live usage is ready at USD 0.00014, but the message window returns undefined cost, response tokens and total tokens. Evidence: `/private/tmp/astra-full-review/reload-probe-r1-spec.log`. The application's reasoning-token projection is named `thinkingTokenCount`.

Controller-supplied staging corroboration at `8fed848dd`: a dedicated synthetic Kimi reply's GET detail omitted all four message usage fields while GET usage was ready at USD 0.032304; remote evidence `/tmp/alfyai-kimi-reload-cost-before.json`. This worker has not accessed that file or private chats. After the fix the controller will recheck the same saved reply, without generating another turn.

## Exact implementation scope

Only these paths may be changed for R1 after approval:

- `src/lib/server/services/analytics.ts`
- `src/lib/server/services/messages.ts`
- `src/lib/server/services/analytics.message-usage.test.ts` (new, real analytics/ledger integration)
- `src/lib/server/services/messages.usage-projection.test.ts` (new, real message-reader integration)
- `src/lib/server/services/messages.test.ts` (existing metadata-only fixture: mock the analytics read interface rather than expanding its mock database)
- `src/lib/server/services/messages.ordering.test.ts` (existing historical-schema fixture: supply the current empty ledger schema for the modern reader)
- `tests/e2e/turn-completion-contract.spec.ts` (only the existing working/closing usage reload test, initially lines 285–320; reserved by the controller from the UI worker)
- `docs/plans/turn-completion/contract/reload-usage-projection.md` (this contract and its review/verification record)

The concurrent UI worker owns ThinkingBlock, MessageBubble, their tests and browser/image work. No edits there or to other e2e specs, schema, migrations, pricing, routes, guide, dashboard, repository wrappers or completion policy. Any necessary scope expansion returns to the controller first.

Before touching the reserved browser test, confirm the UI worker has no edits there and recheck its Git diff. At scope amendment time that file had no Git changes. Other browser tests in that same file remain owned by the UI worker.

Implementation fixture adaptation: the first normal-harness focused run exposed 31 failures in the metadata mock and one in the historical ordering fixture because modern reads now consult the ledger. Reported to the controller before edits; the controller explicitly confirmed this routine integration scope expansion. The ordering fixture retains its historical message table/migrations, adds the current incognito flag, and derives its empty ledger tables from an independently migrated in-memory database. No runtime missing-table fallback or migration policy change was added.

## Proposed analytics-owned interface

Extend the existing analytics module with one batched read interface, provisionally:

```ts
getNormalChatMessageUsageProjections(
  conversationId: string,
  messageIds: readonly string[],
): Promise<Map<string, {
  status: "pending" | "ready";
  costUsdMicros: number | null;
  generationTimeMs: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
}>>;
```

This is a read interface within the existing deep module, not a new persistence layer. Analytics alone resolves saved-message-to-segment links, readiness, actual-attempt aggregation and nullable fields. Message readers only map the resulting values. Existing live usage reads delegate their linked-segment branch to the same interface, retaining their current authentication, assistant-role and incognito checks, legacy behavior and response shape. `getConversationCostSummary` continues to sum billed events; its `totalTokens` is conversation-wide, not the individual reply total.

The interface returns only requested saved assistant messages linked to a segment in that same conversation. Empty input returns an empty map without scanning attempts. Missing map entries mean no ledger association and permit the current legacy path. A pending map entry is authoritative and must not fall back to legacy/estimated numeric usage. Incognito remains untracked. No new authorization policy: callers retain existing conversation-access checks.

The implementation uses a bounded number of batched queries (chunked only if SQLite parameter limits require it), never one query per message. Fetch linked segments and their attempts consistently within a read snapshot or one query so concurrent late accounting cannot combine ready status with an older partial attempt set. Do not join billing rows as a second multiplicative source.

## Projection rules

1. A saved assistant represents its linked segment only. Sum each actual attempt ID in that segment once, including working/fallback/closing attempts, regardless of provider. A resumed segment belongs to its own saved assistant; do not sum the entire logical turn onto every segment.
2. For a ready segment, cost is the exact integer-micro sum of recorded attempt costs. Completion and total tokens are the corresponding attempt sums. Reasoning and generation duration are sums only when every contributing attempt has that field; any NULL keeps that aggregate NULL. Reasoning is a breakdown of output tokens and is not added to output or total tokens.
3. A pending segment exposes NULL for all final aggregate fields. Known child subtotals must not masquerade as the complete message total. Unknown usage, absent final usage and unpriced attempts stay pending; no new estimates or pricing lookup. A later authoritative ready read reveals the full aggregate.
4. Known zero is preserved as zero, including genuinely free ready usage. An explicitly sealed ready segment with an empty attempt manifest retains the existing live cost behavior (zero cost and duration); token aggregates without contributing observations remain NULL. Missing/unfinished accounting never becomes zero by default.
5. Map NULL to existing optional ChatMessage fields as undefined, preserving the current serialized message shape. Pending ledger rows must also suppress the legacy duration fallback for the final aggregate. Keep persisted model identity/display metadata and canonical content unchanged.
6. Legacy messages without ledger association retain their current event, duration and token projection. A mixed conversation independently projects each legacy or linked reply. Reads neither create a message-level usage event nor update existing accounting.
7. Select/order/offset/limit messages at message grain first. Enrich only returned messages in a batch after pagination (the lookahead message need not be enriched). Individual attempts must never participate directly in the limited message query. Keep ordering, page size, offset semantics, `hasMoreBefore`, attachments and deduplication behavior unchanged.

## TDD acceptance through real owners

Port the supplied probe into tracked tests using isolated migrated synthetic SQLite databases and real lifetime, ledger, analytics and message readers; do not mock those owners or replace the regression with SQL-shape assertions. Establish the basic reload failure before production edits.

- Single priced completion: live usage cost agrees with both list readers; reload restores response, reasoning and total tokens, including nonzero reasoning. Assert per-message totals separately from the endpoint's conversation totals.
- Multiple attempts: working/fallback/closing with distinct IDs and provider prices contribute once to one saved assistant. Assert cost, output, reasoning, total and duration; reasoning is not double-added. An unrelated segment and a continued segment do not contaminate that assistant.
- Mixed legacy/new conversation: retain legacy values and independently restore new reply values through both readers. Include an ordinary user message without usage.
- Pagination: more than one page, several attempts on a boundary reply, deterministic message sequence, nonzero offsets and final page. Assert exact message IDs, counts, order, disjoint pages, correct `hasMoreBefore` and aggregate parity with `listMessages`; attempt count cannot consume page slots.
- Pending/unknown: one known priced child plus a non-final unknown child, and final usage with unknown price. Live status stays pending; reload fields stay absent rather than zero or a partial subtotal. Late final accounting transitions both paths to ready. Ready optional NULL reasoning/duration remains unknown; known zero stays zero.
- Replay/idempotence: repeated identical capture/finalization/analytics association and repeated reads leave one event per attempt, no billed saved-message aggregate, stable message values and unchanged conversation billing totals. Reads themselves perform no writes.
- Scope: another conversation's IDs and non-assistant IDs produce no projection. Existing live endpoint authorization/incognito behavior remains unchanged.
- Browser reload: retain existing live/after-reload usage-endpoint assertions. Add assertions that the normal conversation detail's saved assistant has cost USD 0.088 and aggregate output/total counts 26/88, and that after reload the real last-turn cost row in the context-usage popover is visible at USD 0.0880. Assert the saved message ID is unchanged and provider request count remains two. Use the normal read payload and actual visible cost, not just the usage endpoint; do not trigger a new generation. Browser execution waits for the controller's build/gate.

## Documentation and verification constraints

Context7/Svelte MCP docs tools were not available. Checked official current Drizzle [joins](https://orm.drizzle.team/docs/joins) and [select](https://orm.drizzle.team/docs/select) documentation for nullable joins, aggregation/subqueries and limit/offset, and Vitest [vi utilities](https://vitest.dev/api/vi.html) for module reset and environment stubbing. Installed ranges are Drizzle ORM `^0.45.2` and Vitest `^4.1.11`; the supplied probe runs Vitest 4.1.11. Use APIs supported by the installed versions.

Also checked official Playwright [assertions](https://playwright.dev/docs/test-assertions) and [page response observation](https://playwright.dev/docs/api/class-page#page-wait-for-response) documentation for the reserved browser regression.

Run only focused Node 22 tests for these owners and scoped Biome on changed TypeScript files. Record red/green evidence and precise limitations here. No browser run before the controller's build/gate; no full gate, build, commit, push, deployment or remote action in this slice. Controller owns gates, full Astra implementation/whole-change review and any later staging decision. Production is forbidden. Specification approval is not implementation acceptance or a claim that R1 is fixed.

## Frozen implementation and verification evidence

Analytics now reads scoped segment status and all attempt sums together in one grouped SQL statement per batch of at most 500 distinct requested message IDs. The live usage path delegates to this same interface. Both message readers enrich their selected rows after pagination, with authoritative pending NULL fields and no billing writes. The legacy event join remains unchanged.

The reserved browser spec was clean on repeated Git checks before its narrow cost-test edit. Controller reservation and the UI worker's separate nine-path commit left it exclusively available for this change; no other browser test in the file was edited. Its existing endpoint assertions remain, with added normal-detail usage, saved-ID, actual visible last-turn cost and provider-count assertions. Browser execution is deferred.

- Unchanged Astra probe: expected red before implementation, then **1 passed** after implementation. Logs `/private/tmp/astra-full-review/reload-probe-r1-spec.log` and `/private/tmp/astra-full-review/reload-probe-r1-green.log`.
- Tracked TDD: `/private/tmp/astra-full-review/r1-tracked-red.log` reproduces all four absent message usage fields with the real lifetime/ledger/analytics/readers. Expanded red `/private/tmp/astra-full-review/r1-focused-red.log` has five real-reader behavior failures and five absent-interface failures. First green `/private/tmp/astra-full-review/r1-focused-green.log`: **10 passed / 2 files**.
- Final normal-harness focused run: **235 passed / 14 files**, `/private/tmp/astra-full-review/r1-owners-green.log`. Command: `PATH=/opt/homebrew/opt/node@22/bin:$PATH node node_modules/vitest/vitest.mjs run src/lib/server/services/analytics*.test.ts src/lib/server/services/messages*.test.ts src/lib/server/services/chat-turn/completion-lifetime*.test.ts src/lib/server/services/chat-turn/turn-ledger.test.ts --reporter=dot`. This includes real DB accounting/lifetime tests and existing pricing, metadata, ordering and provenance suites.
- An earlier scratch owner-test config omitted the repository's shared DB setup, producing four unrelated provenance setup failures in addition to the 32 fixture failures; a follow-up scratch config lacked Vitest globals. Neither scratch result is used as final verification. The normal-harness run uses the repository's migrated throwaway DB setup and is the authoritative focused result.
- Scoped Biome covers the seven changed TypeScript paths; final check output is `/private/tmp/astra-full-review/r1-biome.log`. No full typecheck, Fallow, build, browser run, gate, commit, push, remote access or deployment was performed by this worker.

Review exactly the eight paths listed above. The two fixture adaptations are the only scope additions beyond the accepted implementation/browser plan. Controller still needs Astra implementation/whole-change review, its normal gates/build/browser run, and the same-saved-synthetic-Kimi-reply staging recheck. No new generation or private-chat access is needed for that recheck.
