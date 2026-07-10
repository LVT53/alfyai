# Turn Preparation And Streaming Performance Issues

Context: live benchmarking after the stream prelude change showed response headers and first byte improved from ~5.2s to ~147ms, but server `turn_preparation` still sat around ~5s. Live logs repeatedly showed the auto reasoning-depth classifier falling back after `AI_NoOutputGeneratedError` / `AI_NoObjectGeneratedError`. The repo already uses the AI SDK v6 `Output.json` path for the classifier via `skipStructuredOutputs: true`; the remaining cost is the synchronous classifier call itself on common auto-depth turns.

Docs check: Context7 `/vercel/ai` confirms AI SDK v6 structured-output failures are surfaced as `NoObjectGeneratedError.isInstance(error)` with cause/text/response/usage, and stream errors should be surfaced through stream error handling unless an application deliberately recovers.

## Issue 1: Fast-Path Common Auto Reasoning-Depth Turns

Label: `triage/performance`

Problem:
Auto reasoning depth currently performs lightweight DB hydration and a control-model classification before the main model run, even for direct, simple user messages. When the selected model/provider returns no object output, the user sees a long `Preparing response` wait before the deterministic fallback is applied.

Acceptance criteria:
- Simple direct auto-depth turns can resolve to `standard` without calling `sendJsonControlMessage`.
- The fast path must still bypass explicit `off` and explicit `max` exactly as today.
- The control classifier remains available for ambiguous or complex auto-depth turns.
- Metadata clearly distinguishes the fast path with a stable `classifierSource` and `constraintNote` or fallback reason that does not imply a provider failure.
- Existing deterministic keyword fallback behavior remains available for classifier failures.
- Focused tests prove a simple turn skips the control-model mock and a complex turn still reaches the classifier.

Technical notes:
- Primary file: `src/lib/server/services/chat-turn/depth-selection.ts`.
- Focused tests: `src/lib/server/services/chat-turn/depth-selection.test.ts`.
- Use existing `runDeterministicKeywordClassifier` signals as the base, but add a separate “safe fast path” predicate so keyword fallback and proactive fast path remain distinguishable in metadata.
- Conservative fast-path candidates: short direct messages with no attachments, no linked sources, no forced web search, no pending skill, no active document, no personality-specific control need, no recent conversation ambiguity, and deterministic profile `standard`.
- Keep route and preflight boundaries unchanged.

Dependencies:
- None.

## Issue 2: Harden Control-Model No-Object Handling For Depth Classification

Label: `triage/reliability`

Problem:
Even with `skipStructuredOutputs: true`, providers can still produce no parsable object. The classifier should keep making this diagnosable without turning expected no-object failures into noisy generic control-model failures.

Acceptance criteria:
- `AI_NoObjectGeneratedError` / `NoObjectGeneratedError` from the classifier path is logged with a specific fallback reason.
- The fallback metadata remains compact and contains no prompt or response body.
- Tests cover the specific no-object error branch or a compatible mock shape without coupling to provider internals.

Technical notes:
- Primary files: `src/lib/server/services/chat-turn/depth-selection.ts`, possibly `src/lib/server/services/normal-chat-control-model.ts`.
- The docs-supported type guard is `NoObjectGeneratedError.isInstance(error)`.
- Do not change other control-model callers unless the existing abstraction already exposes the needed classification safely.

Dependencies:
- Issue 1 can eliminate most user-visible impact first; this issue improves diagnostics and remaining complex-turn fallback.

## Issue 3: Narrow Non-Streaming Recovery To Transport-Loss Cases

Label: `triage/reliability`

Problem:
The streaming orchestrator intentionally falls back to a plain model run when streaming fails before usable output. It also recovers after completed non-file tool calls with no final answer. That path is useful when a stream body terminates, but generic provider error payloads after tool use can cause “too many fallbacks to non-streaming” and hide the original streaming failure behind a second full generation.

Acceptance criteria:
- Stream connect failures before any output can still recover through non-stream fallback.
- Abrupt stream termination or stream close after completed non-file tools but before final answer can still recover.
- Generic upstream `error` events after completed non-file tools only trigger non-stream fallback when the error is classified as transport/timeout/abort/termination and no visible answer has been emitted.
- Tests retain the socket-termination recovery case and add a provider-model error case that does not call `runPlainNormalChatSendModel`.

Technical notes:
- Primary file: `src/lib/server/services/chat-turn/stream-orchestrator.ts`.
- Focused tests: `src/lib/server/services/chat-turn/stream-orchestrator.test.ts`.
- Preserve existing file-production completion behavior and explicit user-stop behavior.
- Do not move provider attempt policy into the orchestrator; keep this limited to recovery eligibility.

Dependencies:
- None, but review with Issue 1 because both influence perceived chat latency.

## Issue 4: Benchmark And Gate The Round

Label: `triage/verification`

Acceptance criteria:
- Focused Vitest coverage passes for changed units.
- `npm run check` passes with 0 diagnostics.
- Fallow is run with the repo-required command and does not introduce new findings.
- Two review passes are completed over the diff.
- If local gates pass, deploy with `$remote-live-testing`, verify health/logs, and run the live chat benchmark again against the same no-cost Qwen model used in the previous benchmark.

Dependencies:
- Issues 1-3 implemented and reviewed.
