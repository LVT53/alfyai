# Normal Chat Stability Architecture Slices

**Date:** 2026-06-04
**Source:** `$improve-codebase-architecture` review focused on tool usage, web search, model streaming, and system stability.

## Goal

Integrate the seven recommended stability deepening entries one by one, with focused tests and review before moving to the next slice. Campaign code is out of scope for this pass except where existing shared contracts are incidentally referenced by docs or tests.

## Documentation Check

- Context7 AI SDK docs confirm `streamText().fullStream` exposes structured `start`, text, reasoning, source, file, tool, finish, error, and raw parts; AI SDK v5+ UI routes commonly return `toUIMessageStreamResponse()` for UI-message streams.
- Context7 SvelteKit docs confirm `+server.ts` handlers return standard Web API `Response` objects, which supports keeping stream transport and health/status endpoints as explicit server-service-backed adapters.
- Context7 Vitest v4.1.6 docs confirm fake timers, date control, and module mocks are appropriate for deterministic stream, timeout, registry, and route-adapter tests.
- The Svelte-specific MCP docs tool is not available in this session; Context7 SvelteKit official docs are the fallback.

## Cross-Slice Rules

- Preserve current AI SDK UI stream part names and browser payload expectations unless the parser, UI, and tests are intentionally updated together.
- Keep routes as adapters. Durable behavior belongs in `chat-turn`, `normal-chat-model`, `normal-chat-tools`, web grounding, config-store, and health/stability services.
- Run focused tests for each slice before the next slice starts; run broader checks after integrated milestones.
- Use a real configured inference provider for final streaming/tool/web-search smoke checks when the service boundary being changed reaches model execution.
- Do not modify Campaign implementation modules in this pass.

## Slice 1: Deepen AI SDK UI Stream Contract

**Type:** AFK
**Blocked by:** None - can start immediately
**Status:** Complete on 2026-06-04.

### What to build

Make the AI SDK UI Stream Contract the single authoritative module for frame encoding, frame decoding, terminal detection, reconnect replay interpretation, and shared fixtures. Server stream framing, browser transport decoding, and reconnect/status checks should consume the same contract rather than duplicating event-line parsing or terminal-part checks.

### Acceptance criteria

- [x] One shared contract module owns AI SDK UI stream part encode/decode helpers, terminal-part detection, and metadata extraction.
- [x] Server stream helpers, browser stream transport, and reconnect/status logic use the shared contract instead of duplicate delimiter and line-prefix parsers.
- [x] Contract fixtures cover text, reasoning, tool/data, metadata, replay, finish, `[DONE]`, malformed frames, and trailing partial blocks.
- [x] Focused tests prove malformed frames do not partially render, terminal detection is consistent, and existing stream callback semantics remain stable.

### Verification

- Focused Vitest coverage for the shared stream contract, browser stream transport, stream reconnect, and stream runtime helpers.
- `npm run check` after the integrated slice.

**Verification evidence, 2026-06-04:** `src/lib/services/ai-sdk-ui-stream-contract.ts` now owns the AI SDK UI stream frame contract. `src/lib/server/services/chat-turn/stream.ts`, `src/lib/server/services/chat-turn/stream-reconnect.ts`, `src/lib/services/streaming.ts`, and `tests/fixtures/ai-sdk-ui-stream-contract.ts` consume that shared boundary. Focused verification passed with `npx vitest run src/lib/server/services/chat-turn/stream-runtime.test.ts src/lib/server/services/chat-turn/stream-reconnect.test.ts src/lib/services/streaming.test.ts` and `npm run check`.

## Slice 2: Deepen Active Stream Registry

**Type:** AFK
**Blocked by:** Slice 1
**Status:** Complete on 2026-06-04.

### What to build

Make the Active Stream Registry the authority for active stream ownership, aged buffer expiry, safe status/buffer read models, stop authorization, and compact stream inventory. Status and buffer routes should remain HTTP adapters that ask the registry for ownership-aware views.

### Acceptance criteria

- [x] Registry APIs expose ownership-aware stream status and buffer snapshots for authenticated users and conversations.
- [x] Orphaned stream lookup and buffer reads cannot expose another user's stream by stream id or conversation id.
- [x] Aged buffers are deleted or made unavailable by registry-owned expiry logic, with deterministic timer tests.
- [x] Stop, passive detach, reconnect, and status checks preserve their existing user-facing semantics.

### Verification

- Focused Vitest coverage for active-stream registry expiry, ownership checks, stop behavior, status route, and buffer route.
- Stream transport tests that prove reconnect and explicit stop behavior still differ.

**Verification evidence, 2026-06-04:** `src/lib/server/services/chat-turn/active-streams.ts` now stores stream/buffer owner and conversation metadata, exposes owner-scoped status and buffer snapshots, owner-scopes pending stops and active checks, expires stale buffers, and rejects colliding active stream ids. `/api/chat/stream/status`, `/api/chat/stream/buffer`, reconnect, stream completion, stream orchestration, and context compression now pass owner context into the registry. Focused verification passed with `npx vitest run src/lib/server/services/chat-turn/active-streams.test.ts src/routes/api/chat/stream/status/status.test.ts src/routes/api/chat/stream/buffer/buffer.test.ts src/routes/api/chat/stream/stop/stop.test.ts src/lib/server/services/chat-turn/stream-orchestrator.test.ts src/lib/server/services/chat-turn/stream-reconnect.test.ts src/lib/server/services/chat-turn/stream-completion.test.ts src/routes/api/chat/stream/stream.test.ts`; `npm run check`, `git diff --check`, and escalated `npm run test:unit` also passed.

## Slice 3: Move Normal Chat Failover Into Normal Chat Model Run

**Type:** AFK
**Blocked by:** Slice 1
**Status:** Complete on 2026-06-04.

**Fallback contract update, 2026-06-15:** current Normal Chat **Model Fallback** routing is Provider Model first, global fallback second, and no provider-wide fallback. Admin fallback compatibility treats enabled Provider Models as chat-capable and treats unknown provider-discovery capability metadata as advisory unless there is explicit incompatible evidence. The global fallback selector belongs with Provider/Provider Model administration, not with generic rate and size limits. The 2026-06-04 implementation evidence below records the state of the completed slice at that time; provider-level fallback language should not be used as the forward design.

### What to build

Move streaming and plain provider-attempt/failover decisions into the Normal Chat Model Run boundary so `/send` and `/stream` use the same capability, timeout, model-fallback, and rate-limit policy. The stream orchestrator should consume neutral model-run events and no longer own provider retry policy.

### Acceptance criteria

- [x] Plain and streaming Normal Chat runs share one failover policy surface.
- [x] First-visible-output timeout, rate-limit fallback, model/global timeout fallback, and unsupported-tool fallback are decided inside Normal Chat Model Run.
- [x] Stream orchestration adapts neutral model-run events into downstream stream frames and persistence, while keeping model-preserving non-stream recovery for transport failures.
- [x] Tests cover plain fallback, streaming fallback, timeout fallback, rate-limit fallback, and no-fallback terminal errors.

### Verification

- Focused Vitest coverage for Normal Chat Model Run and stream orchestrator integration.
- A real-provider smoke for a basic streaming turn and a tool-enabled turn after focused tests pass.

**Verification evidence, 2026-06-04:** `src/lib/server/services/normal-chat-model/failover.ts` owned timeout/rate-limit classification, model timeout target resolution, the then-current provider rate-limit fallback resolution, and first-output timeout calculation. `runPlainNormalChatModelRun` and `runStreamingNormalChatModelRun` share retry policy through the Normal Chat Model Run boundary; the chat-turn wrappers pass `modelId`, runtime config, and dynamic provider-option resolvers into that boundary. `stream-orchestrator.ts` no longer imports rate-limit fallback or timeout-target resolvers and now consumes neutral model-run events while preserving stream lifecycle, persistence, and model-preserving non-stream recovery. Focused verification passed with `npx vitest run src/lib/server/services/normal-chat-model/index.test.ts src/lib/server/services/normal-chat-failover.test.ts src/lib/server/services/chat-turn/stream-orchestrator.test.ts src/lib/server/services/chat-turn/stream-fallback.test.ts`, `npx vitest run src/lib/server/services/chat-turn/plain-normal-chat-model-run.test.ts src/lib/server/services/chat-turn/streaming-normal-chat-model-run.test.ts src/routes/api/chat/send/send.test.ts src/routes/api/chat/stream/stream.test.ts src/routes/api/chat/retry/retry.test.ts`, and the active-stream/context-compression focused set. `npm run check`, `git diff --check`, and escalated `npm run test:unit` also passed.

## Slice 4: Add Tool Execution Envelope

**Type:** AFK
**Blocked by:** Slice 3
**Status:** Complete on 2026-06-04.

### What to build

Add a shared Tool Execution Envelope for app-backed AI SDK tools. The envelope should own timeout/abort policy, sanitized model-safe failure payloads, recorder events, compact diagnostics, and consistent error metadata while each tool adapter keeps only domain-specific input validation, execution, and output shaping.

### Acceptance criteria

- [x] Research web, image search, memory context, and file production tools run through one shared envelope.
- [x] Timeout, abort, success, and failure recording is consistent across tools.
- [x] Model-facing failures are safe, compact, and schema-compatible for every tool.
- [x] Existing tool-specific payload shapes and guidance remain stable unless explicitly updated with tests.

### Verification

- Focused Vitest coverage for the envelope and each app-backed tool adapter.
- A real-provider smoke that forces at least one tool call and confirms the model receives a safe tool result.

**Verification evidence, 2026-06-04:** `src/lib/server/services/normal-chat-tools/shared.ts` now exposes `executeToolWithEnvelope(...)`, which owns tool timeout/abort racing, pre-abort handling, model-safe error text, success/failure recording, and recorder integration. `research_web`, `memory_context`, `image_search`, and the executable `produce_file` intake path now use the shared envelope while retaining their existing input validation, compaction, and model payload shapes. Focused verification passed with `npx vitest run src/lib/server/services/normal-chat-tools/index.test.ts`, widened model/chat tool integration coverage via `npx vitest run src/lib/server/services/normal-chat-model/index.test.ts src/lib/server/services/chat-turn/plain-normal-chat-model-run.test.ts src/lib/server/services/chat-turn/streaming-normal-chat-model-run.test.ts src/routes/api/chat/send/send.test.ts src/routes/api/chat/stream/stream.test.ts src/routes/api/chat/retry/retry.test.ts`, and evidence/context regression coverage via `npx vitest run src/lib/server/services/message-evidence.test.ts src/lib/server/services/normal-chat-context.test.ts src/lib/server/services/context-access-regression.test.ts`. `npm run check` and `git diff --check` also passed.

## Slice 5: Deepen Web Grounding

**Type:** AFK
**Blocked by:** Slice 4
**Status:** Complete on 2026-06-04.

### What to build

Make Web Grounding the authority for model-safe evidence payloads, source/citation metadata, freshness-sensitive search instructions, and final citation audit handoff. The research web tool, prompt context, and completion audit should consume one leak-resistant source contract.

### Acceptance criteria

- [x] Web grounding exposes one typed evidence/source payload used by the research web tool and final citation audit.
- [x] Freshness/date-before-search guidance remains in Normal Chat prompt assembly while the retrieved source/evidence contract flows through Web Grounding.
- [x] Citation audit receives structured grounded sources to flag missing and unsupported citations without route-local source shadow state.
- [x] Tests cover grounded answer payloads, omitted/unsafe sources, freshness-sensitive queries, and citation audit handoff.

### Verification

- Focused Vitest coverage for web grounding, research web tool output shaping, prompt assembly, and citation audit integration.
- A real-provider web-search smoke for a freshness-sensitive question with citations.

**Verification evidence, 2026-06-04:** `src/lib/server/services/web-grounding.ts` now owns the compact `research_web` model payload, grounded web candidates, metadata, summaries, canonical URL normalization, assistant citation URL extraction, and citation-audit source extraction. `normal-chat-tools/index.ts` uses the Web Grounding contract for `research_web`, and `web-citation-audit.ts` consumes the same grounded source extraction instead of rebuilding its own research-source shape. Focused verification passed with `npx vitest run src/lib/server/services/web-grounding.test.ts src/lib/server/services/normal-chat-tools/index.test.ts src/lib/server/services/web-citation-audit.test.ts src/lib/server/services/web-research/index.test.ts src/lib/server/services/message-evidence.test.ts src/lib/server/services/normal-chat-context.test.ts src/lib/server/services/context-access-regression.test.ts src/lib/server/services/chat-turn/stream-completion.test.ts`. `npm run check` and `git diff --check` also passed.

## Slice 6: Consolidate Provider Model Runtime Defaults

**Type:** AFK
**Blocked by:** Slice 3
**Status:** Complete

### What to build

Create one Provider Model Runtime Defaults boundary that owns context-window, target-context, compaction-threshold, reasoning, thinking, and provider-model persistence defaults. Config-store, environment parsing, provider-model seeding, context budgeting, and Normal Chat Model Run should consume that same derivation.

### Acceptance criteria

- [x] Runtime defaults are derived once and projected consistently into config-store, env defaults, provider-model rows, context budget, and Normal Chat Model Run.
- [x] Admin overrides remain authoritative and are not bypassed by environment defaults.
- [x] Existing provider-model separation from ADR-0027 is preserved.
- [x] Tests cover env-only defaults, persisted provider-model defaults, admin overrides, and context-budget derivation.

### Verification

- Focused Vitest coverage for runtime default derivation, config-store/env projection, provider model seeding, and context budget.
- `npm run check` after integration.

**Verification evidence, 2026-06-04:** `src/lib/model-context-defaults.ts` now owns shared context-window ratios and normalization, while `src/lib/server/services/provider-model-runtime-defaults.ts` owns provider-model runtime/persistence projection. `env.ts`, `config-store.ts`, `provider-models.ts`, `chat-turn/context-budget.ts`, `chat-turn/shared-normal-chat-model-run-helpers.ts`, and `normal-chat-model/index.ts` consume those helpers instead of duplicating context-limit math. Focused verification passed with `npx vitest run src/lib/model-context-defaults.test.ts src/lib/server/env.test.ts src/lib/server/services/config-store.test.ts src/lib/server/services/provider-model-runtime-defaults.test.ts src/lib/server/services/provider-models.test.ts src/lib/server/services/chat-turn/context-budget.test.ts src/lib/server/services/chat-turn/shared-normal-chat-model-run-helpers.test.ts src/lib/server/services/normal-chat-model/index.test.ts src/lib/server/services/chat-turn/plain-normal-chat-model-run.test.ts src/lib/server/services/chat-turn/streaming-normal-chat-model-run.test.ts`. `npm run check`, `git diff --check`, and the full escalated `npm run test:unit` suite also passed; the full suite reported 320 files, 3002 passed, and 1 skipped.

## Slice 7: Add Normal Chat Stability Snapshot

**Type:** AFK
**Blocked by:** Slice 2, Slice 3, Slice 5, Slice 6
**Status:** Complete

### What to build

Add a compact Normal Chat Stability Snapshot that reports degraded stream, provider, tool, web-grounding, context, and maintenance signals without leaking private prompt or message content. The health route can remain shallow, but system diagnostics should have one service-owned snapshot for local and deploy smoke checks.

### Acceptance criteria

- [x] A server service exposes a compact stability snapshot with active stream stats, provider readiness, tool/web grounding status, context budget defaults, and maintenance metrics.
- [x] Any route or diagnostic endpoint that exposes the snapshot validates authentication/authorization and avoids sensitive content.
- [x] Existing debug logs can be reduced or aligned to the snapshot vocabulary where touched.
- [x] Tests cover normal, degraded, and unauthorized snapshot access.

### Verification

- Focused Vitest coverage for the snapshot service and route adapter.
- Local app smoke or Playwright check only if a user-facing diagnostics surface is added.

**Verification evidence, 2026-06-04:** `src/lib/server/services/normal-chat-stability-snapshot.ts` now owns the aggregate Normal Chat stability snapshot for streams, providers, tools, web grounding, context limits, and maintenance metrics without returning prompts, messages, search queries, raw source text, API keys, or user ids. `src/routes/api/admin/normal-chat-stability/+server.ts` exposes the snapshot behind `requireAdmin`. Focused verification passed with `npx vitest run src/lib/server/services/normal-chat-stability-snapshot.test.ts src/routes/api/admin/normal-chat-stability/normal-chat-stability.test.ts`. `npm run check`, `git diff --check`, and the full escalated `npm run test:unit` suite also passed; the full suite reported 322 files, 3007 passed, and 1 skipped.

## Dependency Order

1. Deepen AI SDK UI Stream Contract.
2. Deepen Active Stream Registry.
3. Move Normal Chat failover into Normal Chat Model Run.
4. Add Tool Execution Envelope.
5. Deepen Web Grounding.
6. Consolidate Provider Model Runtime Defaults.
7. Add Normal Chat Stability Snapshot.
