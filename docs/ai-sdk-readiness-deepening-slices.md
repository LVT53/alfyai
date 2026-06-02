# AI SDK Readiness Deepening Slices

This local tracker records the final pre-deploy deepening pass after Langflow retirement and AI SDK UI stream migration.

## Scope

Implement the first five architecture-review candidates end-to-end:

1. Deepen the AI SDK UI Stream Contract fixture.
2. Make Normal Chat Model Run capability-aware.
3. Reconcile stream metadata with durable completion/read-model truth.
4. Add a File Production journey gate.
5. Deepen the fake provider harness.

The final architecture-review candidate, Provider Admin UI As Runtime Evidence, is intentionally out of scope for this pass.

## Slice 1: AI SDK UI Stream Contract Fixture

**Type:** AFK  
**Blocked by:** None - can start immediately  
**Status:** Complete.

### What to build

Create a deterministic contract fixture for the AI SDK UI Stream Contract so server stream framing, browser decoding, reconnect replay, and Playwright fixtures all share the same allowed part grammar.

### Acceptance criteria

- [x] A reusable test fixture covers text, reasoning, tool/data parts, metadata, replay, finish, `[DONE]`, malformed frames, and stream close after `finish`.
- [x] Server encoder tests and browser decoder tests use that fixture rather than hand-rolled one-off frame strings where practical.
- [x] `/api/chat/stream/status` and `/api/chat/stream/buffer` have direct route tests.
- [x] Old Browser SSE named events are rejected or ignored without partial rendering.

**Verification evidence, 2026-06-02:** `tests/fixtures/ai-sdk-ui-stream-contract.ts` defines the shared grammar; `src/lib/server/services/chat-turn/stream-runtime.test.ts` and `src/lib/services/streaming.test.ts` consume it; `src/routes/api/chat/stream/status/status.test.ts` and `src/routes/api/chat/stream/buffer/buffer.test.ts` cover route status surfaces; Browser SSE named-event rejection is covered in stream runtime/reconnect/browser decoder tests.

## Slice 2: Capability-Aware Normal Chat Model Run

**Type:** AFK  
**Blocked by:** None - can start immediately  
**Status:** Complete.

### What to build

Make provider capabilities operational evidence for Normal Chat Model Run before the run starts, especially for streaming, tools, reasoning controls, usage reporting, and fallback decisions.

### Acceptance criteria

- [x] A provider that cannot support required tools is detected before a tool-required Normal Chat turn starts.
- [x] Streaming and plain model runs use the same capability truth.
- [x] Reasoning controls are only sent when the provider/model capability allows them.
- [x] Tests cover supported, unsupported, and fallback provider combinations.

**Verification evidence, 2026-06-02:** `src/lib/server/services/normal-chat-model/index.ts` carries provider capability evidence through Normal Chat Model Run; `src/lib/server/services/normal-chat-model/index.test.ts` covers unsupported tool-required plain runs, unsupported streaming, reasoning-control suppression, supported/fallback tool behavior, and shared capability truth across plain and streaming paths.

## Slice 3: Completion Metadata And Read Model Reconciliation

**Type:** AFK  
**Blocked by:** Slice 1  
**Status:** Complete.

### What to build

Prove that terminal stream metadata is only a browser hint and stays consistent with durable Conversation Detail Read Model state after Normal Chat Turn Completion.

### Acceptance criteria

- [x] File-producing turns produce terminal stream metadata that matches refreshed conversation detail.
- [x] Evidence/context-source metadata matches the durable read-model projection after refresh.
- [x] Reconnect/queued-turn completion keeps the same durable outcome.
- [x] Tests fail clearly when metadata and read-model state diverge.

**Verification evidence, 2026-06-02:** `src/lib/server/services/chat-turn/stream-completion.test.ts` covers metadata emission, persisted Context Sources, reconnect file-producing completion, produced-file attachment, and durable generated files; `src/lib/server/services/conversation-detail/read-model.test.ts` covers refreshed Context Sources/read-model projections.

## Slice 4: File Production Journey Gate

**Type:** AFK  
**Blocked by:** Slice 1, Slice 3  
**Status:** Complete.

### What to build

Add a deterministic end-to-end journey gate from AI SDK `produce_file` tool call through durable job creation, worker execution, assistant message attachment, Conversation Detail Read Model card projection, generated-file preview, and download.

### Acceptance criteria

- [x] A document-source output journey succeeds and is visible as a File Production Card.
- [x] A program-mode output journey succeeds through the sandbox path when Docker is available, with a deterministic skip or diagnostic when Docker is not available.
- [x] Preview and download endpoints are exercised from the journey.
- [x] The failure output identifies the broken seam: tool adapter, intake, job ledger, worker, storage, read projection, preview, or download.

**Verification evidence, 2026-06-02:** `tests/integration/file-production-journey.test.ts` gates Docker/program availability through Dockerode, runs document-source `produce_file` through read-model projection, and exercises preview/download checks with explicit failure labels for the broken file-production boundary.

**Live Firepass/Kimi evidence, 2026-06-02:** A local smoke against provider `Kimi K2.6 Turbo` proved the streaming file-production path needs runtime enforcement, not only prompt guidance. `src/lib/server/services/chat-turn/plain-normal-chat-model-run.ts` and `src/lib/server/services/chat-turn/streaming-normal-chat-model-run.ts` now force AI SDK `toolChoice: { type: "tool", toolName: "produce_file" }` for explicit downloadable-file requests, and `src/lib/server/services/normal-chat-tools/index.ts` deduplicates repeated same-turn `produce_file` calls for the same requested artifact. The corrected live smoke created one succeeded `Forced Tool Dedupe Smoke` PDF job with one file, and authenticated preview/download returned HTTP 200 with `application/pdf` and a non-empty payload.

## Slice 5: Fake Provider Harness As Deploy Rehearsal Adapter

**Type:** AFK  
**Blocked by:** Slice 1, Slice 2  
**Status:** Complete.

### What to build

Deepen the fake OpenAI-compatible provider harness so the app can rehearse Normal Chat Model Run and AI SDK UI Stream Contract behavior without third-party spend or rate limits.

### Acceptance criteria

- [x] The fake provider supports deterministic scenarios for text, streaming, reasoning, tool calls/results, slow chunks, empty output, timeout/abort, rate limit, and server error.
- [x] At least one app-wired Playwright journey uses the fake provider through the real app instead of stubbing `/api/chat/stream`.
- [x] The harness captures request payloads so capability and tool-call behavior can be asserted.
- [x] Existing service/integration tests continue to use the same scenario vocabulary.

**Verification evidence, 2026-06-02:** `tests/fixtures/ai/openai-compatible-scenarios.ts` centralizes deterministic scenario vocabulary; `tests/mocks/ai-provider/openai-compatible-provider.ts` implements scenario handling and request capture; `tests/integration/openai-compatible-provider.test.ts` covers lifecycle/plain/streaming/reasoning/tool/slow/empty/abort/rate-limit/server-error behavior; `tests/e2e/fake-provider-chat.spec.ts` drives a real app chat stream through the fake provider.

## Slice 6: Stale Langflow/Browser SSE Docs And Deploy Cleanup

**Type:** AFK  
**Blocked by:** None - can start immediately

**Status:** Implemented in this docs/deploy cleanup pass.

### What to build

Clean stale local docs and deployment examples that still describe Langflow or the retired Browser SSE Protocol as current behavior, while preserving historical ADR context.

### Acceptance criteria

- [x] Deploy docs no longer instruct operators to provision Langflow or keep retired webhook-stream proxy handling.
- [x] Local AGENTS/docs terminology uses AI SDK UI stream terminal parts instead of old `end/error` Browser SSE event language.
- [x] Historical docs remain clearly marked as historical/superseded where retained.
- [x] Final notes call out live host settings that still need manual changes outside the repo.

**Verification evidence, 2026-06-02:** Active deploy docs and runtime docs no longer mention Langflow provisioning, `WEBHOOK_PORT`, or `/api/stream/webhook` as current behavior. Targeted grep only finds retired-env regression tests and migration-preparation tests. During live Firepass/Kimi smoke testing, title generation exposed a strict OpenAI-compatible provider issue; `src/lib/server/services/title-generator.ts` now retries without vLLM-specific title fields and falls back rather than persisting leaked reasoning text. Full Vitest also exposed a normalized-document carryover gap in forked conversation working sets; `src/lib/server/services/knowledge/context.ts` now admits explicit current-turn attachment ids even when the artifact row belongs to the source conversation.

**Additional local LLM smoke evidence, 2026-06-02:** Corrected route payloads must use `model`, not `modelId`. With `model: "provider:<firepass-provider-id>"`, the AI SDK UI stream returned `KIMI REACHABILITY OK`, manual context compression returned a valid snapshot through the Kimi provider, and the forced file-production smoke produced no false "file started" text without a job. Conversation title generation remains separately configured through `TITLE_GEN_*` or admin title settings; the chat provider row does not automatically retarget that auxiliary model path.
