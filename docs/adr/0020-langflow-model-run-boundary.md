# Langflow Model Run was a dedicated execution boundary

Status: Superseded by [ADR-0026](./0026-normal-chat-retires-langflow-for-vercel-ai-sdk.md). The initial boundary landed in commit `13bbdcf6`; follow-up review fixes clarified abort propagation, payload-preparation ownership, rate-limit fallback abort handling, and control-model abort-listener cleanup. This ADR is retained as the historical rationale for the old Langflow split, but current Normal Chat model execution uses the Vercel AI SDK Normal Chat Model Run boundary.

Historical content below describes the retired Langflow execution boundary. Current Normal Chat prompt assembly lives in `src/lib/server/services/normal-chat-context.ts`, current outbound execution lives in `src/lib/server/services/normal-chat-model/`, and app-backed tools live in `src/lib/server/services/normal-chat-tools/`.

Normal Chat prompt assembly stayed in `src/lib/server/services/langflow.ts`, but outbound Langflow execution belonged in `src/lib/server/services/langflow-model-run.ts`.

The Langflow Model Run boundary owned already-assembled Langflow request execution: JSON and streaming HTTP transport, request and stream-connect timeouts, abort-signal merging and cleanup, caller abort propagation for active returned streams, HTTP error classification, rate-limit detection, provider/global failover target resolution, abort re-checks before retrying after async fallback resolution, failover logging, response text extraction, provider usage extraction, and compact run diagnostics.

`langflow.ts` remained the prompt-facing module. It resolved the selected model/provider, assembled the outbound system prompt, ran Context Selection and context compression, applied prompt budget rules, prefetched forced web research, built Langflow tweaks, and passed the final request body to the Model Run boundary.

The control-model JSON path used by structured control tasks may continue to call OpenAI-compatible `/v1/chat/completions` directly. That path may own its own thin request-timeout and abort-listener cleanup because it is a separate control-model transport concern, but it should not be used to recreate retired Normal Chat Langflow run/failover behavior.

**Considered Options**

- Keep JSON and streaming attempt/failover logic duplicated in `langflow.ts`.
- Move prompt assembly, context fit, and model execution into one larger model-run module.
- Put upstream Langflow streaming behavior into the Browser SSE Protocol boundary.
- Own Langflow run attempts and failover in a dedicated Model Run boundary.

We chose the dedicated Model Run boundary because timeout and rate-limit failover rules must stay identical for JSON and streaming runs, while prompt construction and context selection have different ownership and risk. This gives one testable execution surface without making Langflow transport responsible for what context is selected or what a completed turn means durably.

**Historical Consequences**

- During this boundary's lifetime, Langflow request attempt, timeout, rate-limit, failover, and provider-usage changes started in `src/lib/server/services/langflow-model-run.ts`.
- Prompt guards, date/search guidance, file-production guidance, context fit, and Langflow tweak construction remained in `src/lib/server/services/langflow.ts` until the Vercel AI SDK replacement introduced the current Normal Chat context and model-run boundaries.
- Normal Chat Turn Completion stayed owned by `src/lib/server/services/chat-turn/finalize.ts`; Model Run returned model output and run metadata only.
- Browser-facing SSE event names and payloads stayed owned by `src/lib/services/stream-protocol.ts`; upstream Langflow stream connect/retry behavior was not Browser SSE grammar.
- Historical run diagnostics used the compact `[LANGFLOW]` vocabulary. Current Normal Chat model-run diagnostics should use the active service vocabulary behind `src/lib/server/services/normal-chat-model/` and related chat-turn tracing.

Update this ADR only to clarify its superseded historical context. Current Normal Chat model-run changes belong with ADR-0026 and the active Vercel AI SDK service boundaries.
