# Chat-Turn Pipeline

## OVERVIEW

Request parsing through post-turn persistence for chat send/stream endpoints. All turn logic lives here; routes stay thin.

## STRUCTURE

```
request.ts → preflight.ts → [send route | stream-orchestrator.ts] → finalize.ts
                              │                  │
                              └────────┬─────────┘
                                       ▼
normalizer.ts

normal-chat-context.ts → context-selection.ts (constructed prompt context)
stream-orchestrator.ts → active-streams.ts (lifecycle/buffer)
stream-orchestrator.ts → stream-completion.ts (terminal event + persistence)
stream-orchestrator.ts → stream-reconnect.ts (buffer replay + live subscription)
stream-orchestrator.ts → stream.ts (SSE framing/runtime helpers)
failures → retry-cleanup.ts
```

## WHERE TO LOOK

| Task | File |
|------|------|
| Parse body, model, attachments | `request.ts` |
| Validate conversation, check attachment readiness | `preflight.ts` |
| Build constructed prompt context for Normal Chat | `context-selection.ts` |
| Assistant output normalization | `normalizer.ts` |
| Stream attempt orchestration, upstream retry/failover, active-stream registration | `stream-orchestrator.ts` |
| AI SDK UI stream framing/runtime helpers, tool-call markers, thinking cleanup | `stream.ts`, `thinking-normalizer.ts`, `tool-call-markers.ts` |
| Stream terminal persistence and `data-stream-metadata` / `finish` payloads | `stream-completion.ts` |
| Reconnect replay and live stream subscription | `stream-reconnect.ts` |
| Post-turn persistence fan-out (messages, honcho, task-state, knowledge) | `finalize.ts` |
| Stream lifecycle, explicit stop handling | `active-streams.ts` |
| Idempotent cleanup on turn failure | `retry-cleanup.ts` |
| Shared types | `types.ts` |

## CONVENTIONS

- `context-selection.ts` owns constructed prompt-context assembly for Normal Chat, including memory/session/task/document candidate selection and budgeting. Keep prompt-context ranking here, not in routes or Honcho.
- `stream-orchestrator.ts` owns the live streaming attempt: active-stream registration, upstream stream invocation, timeout/failover decisions, phase timing, heartbeat/prelude scheduling, and delegation to completion/reconnect helpers.
- `stream.ts` and its submodules own AI SDK UI stream framing/runtime helpers, neutral event cleanup, thinking tags, and structured tool-call markers. Keep framing and parsing helpers there, not in routes.
- `stream-completion.ts` owns terminal stream completion: final persistence through `finalize.ts`, generated-file assignment, context-source hydration, and the `data-stream-metadata` / `finish` payload shape.
- `stream-reconnect.ts` owns reconnect replay from `active-streams.ts` buffers and live subscription until terminal AI SDK UI stream completion (`finish` / `[DONE]`) or failed stream closure.
- `finalize.ts` is the single fan-out point after any turn (stream or non-stream). Add new post-turn side effects there, not in route files.
- `normalizer.ts` normalizes assistant text through the same stream-protocol helpers so `/send`, `/stream`, retry, and title generation return the same visible content shape.
- `retry-cleanup.ts` runs idempotent cleanup for evidence links, checkpoints, work capsules, generated outputs, and the assistant message itself on failure.
- Routes import from this pipeline; they do not duplicate turn logic.

## ANTI-PATTERNS

- Do not duplicate AI SDK UI stream framing, tool-call handling, or thinking extraction between `stream-orchestrator.ts` / `stream.ts` helpers and route files.
- Do not put terminal stream payload changes in the route or orchestrator without updating `stream-completion.ts` and its focused tests.
- Do not rebuild prompt-context selection in Honcho, routes, or tests; call `context-selection.ts` through the Normal Chat context boundary and keep its budget/trace contract coherent.
- Do not add post-turn persistence directly in `/api/chat/send` or `/api/chat/stream`; route through `finalize.ts`.
- Do not collapse user-requested stop and passive disconnect into one generic abort. Use `active-streams.ts` for explicit stops; let navigation/unmount detach locally without marking the turn stopped.
- Do not inline new persistence side effects inside `stream.ts` closures that only one endpoint can see.
