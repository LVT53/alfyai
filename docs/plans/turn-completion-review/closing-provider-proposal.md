# DeepSeek Flash closing proof

Date: 2026-11-11. Status: **owner approved both cases; both real staging cases passed after the release gate and staging deployment**.

This addresses section 3 and section 7 item 8 of the independent completion review. The staging results available before remediation contained no closing attempt; the authorized execution below supplies the new bounded evidence. Keep the prior failed watchdog reports recorded as failed.

## Proposed permission scope

Run exactly two synthetic cases on staging, DeepSeek Flash only, serially, with at most two outgoing model requests per case and no automatic reruns. Use one newly created, explicitly titled conversation per case under the dedicated synthetic test account. Read no owner conversations or attachments. Do not change global admin settings, provider rows, production, or the public API. Retain the synthetic rows and exact generated IDs for the read-only audit.

| Case | Working request | Closing request | Required evidence |
|---|---|---|---|
| A: tool-step limit | One working step; force the sole harmless `lookup_product` tool, whose deterministic result is `{ "product": 391 }` | Tools absent; output cap 512 | Exactly one tool execution, working cause `tool_budget`, one closing attempt, answer `PRODUCT=391` |
| B: output limit | No tools; clamp the first request to 32 output tokens | Tools absent; output cap 1,024 | Provider actually reports `length`, one closing attempt, visible streamed closing answer |

Case A prompt:

> Call lookup_product once. Then answer exactly PRODUCT=391.

Case B prompt:

> Write the integers 1 through 200 in order, one per line, then END=200.

Use the selected provider's supported non-thinking configuration. Do not substitute a model. Resolve and verify the current staging provider/model binding before any request; old IDs in the existing verifier are reference data, not proof of today's binding. Never print keys or native reasoning.

The cap applies to all model requests, including accidental title, maintenance, classifier or other auxiliary calls. A failed case consumes its attempted requests. If Case B naturally stops instead of reaching `length`, report **inconclusive**, not success, and do not retry without additional permission.

## Proposed implementation boundary

A staging-local, dedicated CLI can exercise the real engine and durable finalization without adding a general-purpose HTTP test switch. It must use:

- `runStreamingNormalChatModelRun` with the real resolved provider and explicit completion policy;
- `beginCompletionLifetime`, with real attempt registration and snapshot capture;
- `finalizeChatTurn`, with its real message, completion-ledger and accounting writes;
- exact-ID read-only inspection after finalization, comparing the persisted assistant row and terminal receipt.

Case A sets `maxToolSteps: 1`. Case B's injected provider-fetch wrapper clamps only the first outgoing request's output limit. The closing request keeps its separate budget. The wrapper must not change responses or fabricate a finish reason. Record the requested cap and actual provider finish reason in the report. No public runtime setting is needed.

Use an explicitly titled synthetic conversation so `ensureConversationTitle` exits before generation. `persistTurnState: false` follows the existing lightweight analytics path and prevents a post-turn maintenance tail; this is a harness choice and must be disclosed. No title, summarizer, thought classifier, reply-language call or follow-up generator may run. Install the outbound denial layer before importing the server graph; permit only the completion runner's two counted provider requests. Auxiliary requests must fail before network dispatch and fail the acceptance result.

Do not use incognito to avoid side effects: incognito intentionally skips the accounting ledger needed for this proof. Do not use `PLAYWRIGHT_TEST`, a scratch database, or mocked finalization and then describe the result as a staging persistence proof.

## Dedicated executable

The authorized two-case run is complete. The command below is retained as a runbook, not permission for another execution; additional model runs require new approval.

`scripts/verify-closing-provider.ts` uses the engine, real completion lifetime and real `finalizeChatTurn` persistence with `turnKind: "send"` so accounting projection is awaited. It disables only the optional turn-state maintenance tail; fresh explicitly titled conversations prevent title calls. No app behavior or public switch is changed.

The process denies all global network fetches before importing server modules. Only its counted injected completion transport may dispatch to the selected Flash endpoint; embedded `data:` tokenizer initialization is local and permitted. Each case permits one working and one closing request, counts dispatch before transport, rejects redirects and closing tools, and disables failover. Unknown prices or receipts fail the audit. No automatic reruns.

After the release gate and deployment, from the resolved staging release directory:

```sh
node --import tsx scripts/verify-closing-provider.ts --execute \
  --user-id '<dedicated synthetic user ID>' \
  --user-email 'turn-completion+closing@test.invalid' \
  --provider-id '<verified DeepSeek provider ID>' \
  --model-id '<verified deepseek-flash model row ID>' \
  --report '/tmp/turn-completion-closing-proof-<unique-run>.json'
```

The account must already exist and exactly match both arguments. Default invocation only prints the plan. Execution refuses any cwd outside `/home/alfydesign/apps/langflow-chat-dev/releases/<commit>`, any resolved DB outside that app's `shared/data/chat.db`, or origin other than `https://ai.dev.alfydesign.com`. The output file must not exist; it contains synthetic IDs, request counts/caps, usage/prices, completion facts and receipt agreement, never credentials or reasoning. Retain the synthetic rows for audit.

## Offline acceptance required before execution

Build and test the runner without credentials or network:

1. Import and default invocation make no server imports, database opens or fetch calls. Execution requires an explicit flag and owner-approved scope.
2. Refuse any origin except `https://ai.dev.alfydesign.com`, any app root outside the verified staging release root, and any database whose resolved path is not the verified staging database. An environment string alone is insufficient evidence.
3. Only a dedicated synthetic account and fresh generated conversation IDs can be written. Existing messages are never selected as input.
4. A third request, fallback request, redirect, wrong endpoint/model, auxiliary request, or unregistered attempt fails before sending. Failed requests still count. Test both cases independently and the combined four-request maximum.
5. Case A uses the real engine with a fake provider in offline tests: one harmless execution, one tools-off closing, two registered attempts. Case B obtains real SDK `length` handling from the fake wire, clamps only working, and never invents a finish reason.
6. Run an offline integration test with migrated scratch SQLite through the real lifetime and finalizer. Assert the message/receipt identity, one terminal segment, two correctly scoped/priced attempts, and no model calls from finalization. An offline missing-pricing fault preserves the saved receipt but requires a failed report and exactly two dispatched requests. Direct persistence-fault injection is not covered by this runner test suite.
7. Refuse a pass on missing/extra audit rows, unknown tokens/prices, pending accounting, wrong model, absent closing, duplicated tool execution, blank/markup-only answer, or receipt/persistence disagreement.

The live audit reads only generated IDs, uses query-only/read-only database access, and reports lengths, counts, identities, statuses and prices. The synthetic known-answer check may inspect the generated synthetic answer; do not include native reasoning or credentials.

## Limits of the resulting proof

A successful run proves real-provider completion-engine behavior, streaming from closing, durable persistence and accounting under the stated harness budgets. It does **not** exercise browser display, HTTP admission, the full preparation pipeline or ordinary thought-step rendering. Those remain covered separately by deterministic route/browser regressions and the release gate. It makes no claim about Kimi or Qwen closing behavior.

## Authorized execution results

Run on staging release `eb2869fd6`, runner exit0. The owner authorized these two cases explicitly; no additional model or rerun was made. [Safe exact-ID report](closing-provider-results-2026-11-11.json).

| Case | Working cause | Requests / tools executed | Closing deltas / answer bytes | Priced attempts | Receipt |
|---|---|---|---|---|---|
| A | `tool_budget` | 2 / 1 | 4 / 11 | 55 + 16 microUSD | Matches |
| B | Actual provider `length` | 2 / 0 | 454 / 938 | 23 + 287 microUSD | Matches |

Both finish `closing`, `answered`, `natural_stop`, with `closingAttempted=true`, tools absent from closing, two priced attempts and no auxiliary network calls. Total recorded cost:381 microUSD ($0.000381). These results establish the bounded engine/persistence/accounting proof above; they do not claim a real-provider HTTP/browser run or coverage for Kimi/Qwen.
