# Deepen Langflow Model Run Slices

**Status:** Implemented
**Last reviewed:** 2026-05-31

**Current fallback note, 2026-06-15:** this document records the retired Langflow-era implementation. Current Normal Chat fallback language is **Model Fallback**: selected Provider Model fallback first, global fallback second, no provider-wide fallback. Provider-level fallback references below are historical and should not be copied into current Normal Chat design.

Source: `/private/var/folders/6c/llmb9__97ngcxtc26hvg8jzh0000gn/T/architecture-review-20260529-195600.html`, section `Deepen Langflow Model Run`.

## Implementation Status

The Langflow Model Run boundary is implemented in `src/lib/server/services/langflow-model-run.ts`.

- `langflow.ts` still owns model/provider resolution, outbound prompt assembly, context fit, context compression, forced web prefetch, Langflow tweaks, and final request-body construction.
- `langflow-model-run.ts` owns JSON and streaming Langflow HTTP execution, request/connect timeout handling, caller abort propagation, HTTP and rate-limit classification, provider/global failover resolution, failover logging, response extraction, provider usage extraction, and compact `[LANGFLOW]` run diagnostics.
- `sendMessage` and `sendMessageStream` both use `runLangflowModelRunWithFailover` so timeout and rate-limit retry policy has one implementation.
- Follow-up review fixes verified in the current worktree keep abort propagation alive during returned stream consumption, prevent rate-limit failover retries after a caller aborts during async fallback resolution, and clean up abort listeners in the separate control-model JSON helper.
- Focused coverage now lives in `src/lib/server/services/langflow-model-run.test.ts`, with compatibility coverage retained in `src/lib/server/services/langflow.test.ts`.

## Context

Before this refactor, `src/lib/server/services/langflow.ts` owned both prompt assembly and model execution. The architecture review asked to keep Langflow prompt assembly in place, but deepen model execution behind a focused Model Run module so JSON and stream requests share attempt, timeout, rate-limit fallback, and run-diagnostic behavior.

Review evidence:

- Context7 Vitest v4.1.6 docs for ESM module mocks, `vi.mock`, fake timers, and mock reset patterns.
- Context7 SvelteKit docs for `+server.ts` request handlers returning `json(...)`; no route behavior is expected to change in this refactor.
- 2026-05-31 boundary check: `sendMessage` and `sendMessageStream` call `runLangflowModelRunWithFailover`; `executeLangflowJsonRun`, `executeLangflowStreamRun`, timeout/HTTP error creation, caller abort propagation, rate-limit classification, provider failover, global failover, provider usage extraction, and Langflow run diagnostics live in `langflow-model-run.ts`.
- 2026-05-31 follow-up review check: streaming success wraps the returned upstream `ReadableStream` so merged abort-signal cleanup is delayed until stream consumption finishes or the stream is canceled, preserving caller abort propagation during active stream reads.
- 2026-05-31 follow-up review check: rate-limit failover re-checks the caller abort signal after async fallback-target resolution and before retrying, so a user stop does not continue into fallback execution.
- 2026-05-31 follow-up review check: `sendJsonControlMessage` remains a separate control-model transport path in `langflow.ts`, and its local abort-signal merge now cleans up listeners after the OpenAI-compatible JSON request completes.
- 2026-05-31 stale-helper check: `createLangflowTimeoutError`, `createLangflowHttpError`, `resolveRateLimitFailoverTarget`, `sendMessageAttempt`, and `sendMessageStreamAttempt` do not remain as duplicate helper paths in `langflow.ts`.

## Done Criteria

- `langflow.ts` keeps outbound prompt assembly, context fit, context compression, forced web prefetch, and Langflow request body construction.
- A deep model-run module owns outbound Langflow HTTP execution for both JSON and stream runs.
- Timeout handling, connect-timeout handling, caller abort propagation, HTTP error classification, rate-limit detection, failover target resolution, failover logging, and result diagnostics live in that model-run boundary.
- `sendMessage` and `sendMessageStream` share one retry/failover policy instead of duplicating timeout and rate-limit retry orchestration.
- Existing public `sendMessage`, `sendMessageStream`, `sendJsonControlMessage`, `isLangflowTimeoutError`, `isLangflowRateLimitError`, and failover result shapes remain compatible.
- Stale helper code and tests left behind by the extraction are removed rather than kept as duplicate paths.
- Focused tests prove JSON and streaming behavior across success, non-stream fallback, timeout failover, connect timeout, rate-limit provider fallback, and non-rate-limit errors.

## Slice 1: Extract Model Run Transport

Status: Done.

Implementation notes:

- `executeLangflowJsonRun` accepts an already-built Langflow request body and run metadata, posts to `/api/v1/run/[flowId]`, handles request timeout and caller abort propagation, classifies non-OK responses, extracts text, and extracts provider usage.
- `executeLangflowStreamRun` accepts the same already-built body shape, posts to the streaming Langflow endpoint, owns request and connect timeouts, preserves caller abort propagation while the returned event stream is consumed, preserves text/event-stream success, and handles non-stream JSON fallback with provider usage extraction.
- `langflow.ts` builds prompt/context/tweaks and then calls the model-run transport boundary; it does not open-code Langflow JSON or stream `fetch` attempts for Normal Chat.

Verification notes:

- Covered by `src/lib/server/services/langflow-model-run.test.ts` for JSON response extraction, provider usage extraction, abort-listener cleanup, active stream abort propagation, non-stream JSON fallback, and stream connect timeout classification.
- Existing Langflow compatibility tests remain in `src/lib/server/services/langflow.test.ts`.

## Slice 2: Centralize Failover Policy

Status: Done.

Implementation notes:

- `runLangflowModelRunWithFailover` is the shared JSON/stream failover policy.
- Timeout failover returns the existing `timeoutFailover` shape with `{ fromModelId, toModelId, reason: "timeout" }`.
- Provider rate-limit fallback preserves the provider `modelId` while using the provider fallback endpoint, display name, API key, context limits, and timeout.
- Global rate-limit fallback still uses the configured timeout-failover target when provider endpoint fallback is unavailable.
- Caller abort is re-checked after asynchronous rate-limit fallback resolution and before fallback retry.
- Non-rate-limit HTTP failures are classified in the model-run boundary and are not retried.

Verification notes:

- Focused tests cover provider rate-limit fallback in `src/lib/server/services/langflow-model-run.test.ts`.
- Focused tests cover abort during rate-limit fallback resolution in `src/lib/server/services/langflow-model-run.test.ts`.
- Compatibility tests in `src/lib/server/services/langflow.test.ts` cover timeout failover, provider rate-limit fallback, global rate-limit fallback, and non-rate-limit error handling through the public `sendMessage` surface.

## Slice 3: Clean Stale Surfaces And Document The Boundary

Status: Done.

Implementation notes:

- Timeout, HTTP error, rate-limit, and failover helper logic moved out of `langflow.ts` and into `langflow-model-run.ts`.
- The remaining `langflow.ts` abort-signal merge helper belongs to the separate control-model JSON path, not Normal Chat Langflow execution, and cleans up listeners after the request.
- `CONTEXT.md` defines **Langflow Model Run** as the Normal Chat execution boundary between prompt/context assembly and **Normal Chat Turn Completion**.
- ADR-0020 records why Model Run owns Langflow attempts/failover while **Normal Chat Turn Completion** and **Browser SSE Protocol** remain separate boundaries.
- The architecture review HTML marks `Deepen Langflow Model Run` as finished and lists the implemented boundary files.

Verification notes:

- Boundary-name/stale-helper `rg` checks should show old helper names only in `langflow-model-run.ts` and this historical slice document, not as duplicate paths in `langflow.ts`.
- Run targeted Biome on this document, ADR-0020, `CONTEXT.md`, and the Langflow model-run files after any docs edit.
