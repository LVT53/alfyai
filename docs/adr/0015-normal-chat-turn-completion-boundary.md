# Normal Chat turn completion belongs to chat-turn

AlfyAI will treat Normal Chat Turn Completion as a chat-turn boundary, not as route-local or stream-local sequencing. The boundary owns the durable result of a completed assistant turn: message persistence, attachment-to-context-source updates, Skill Control and Skill Note operations, assistant turn state, message evidence, Honcho/task/memory continuity, and response-facing Context Sources construction.

Send, stream, and retry entrypoints remain transport adapters. They may translate requests and expose the completed turn as JSON, SSE, reconnect state, or refreshable conversation detail, but they must not reintroduce their own durable completion order or rebuild Context Sources from route-local state.

Refreshable conversation detail payload assembly is a separate read-model concern. ADR-0022 records `src/lib/server/services/conversation-detail/read-model.ts` as the owner of `/api/conversations/[id]` GET payload assembly while this chat-turn boundary keeps ownership of durable Normal Chat Turn Completion.

The browser stream transport is a separate boundary. ADR-0016's custom Browser SSE Protocol has been superseded by the AI SDK UI stream migration. `src/lib/server/services/chat-turn/stream.ts` owns browser-facing AI SDK UI stream part names, payload shapes, encoding, and replay framing for stream/reconnect responses. Normal Chat Turn Completion owns the durable result that may be summarized in the terminal `data-stream-metadata` part; it does not own raw stream wire formatting.

The Normal Chat Client Turn Runtime is a separate browser-side runtime boundary. `src/lib/client/normal-chat-client-turn-runtime.ts` consumes server-returned completion metadata through page adapters, but it does not decide message persistence, Context Sources construction, Skill side effects, message evidence, or continuity work owned by chat-turn completion.

**Considered Options**

- Keep `/api/chat/send` and stream completion as separate completion paths.
- Extract only message persistence while leaving Context Sources and side effects in adapters.
- Move completion into Langflow, Honcho, task-state, or knowledge services.
- Own completion inside the chat-turn boundary.

We chose the chat-turn boundary because completion is the second half of a Normal Chat turn: context selection decides what enters the model, and completion decides what the answer means durably. Keeping the boundary in chat-turn prevents send, stream, and retry behavior from drifting while preserving transport-specific concerns such as AI SDK UI stream framing, explicit stop handling, reconnect cleanup, and file-production metadata payloads.

**Consequences**

- New post-turn side effects for Normal Chat should enter through `src/lib/server/services/chat-turn/finalize.ts`.
- Route files and stream adapters may format transport payloads, but they should not own durable completion sequencing.
- Browser-facing SSE event names and payloads belong in `src/lib/services/stream-protocol.ts`; completion code may supply payload data, but it should not duplicate raw event-string builders.
- Browser-side send, retry, reconnect, waiting, stop, and queue transitions belong in `src/lib/client/normal-chat-client-turn-runtime.ts`; that runtime applies completion results but must not recreate durable completion sequencing.
- Response-facing Context Sources changes need completion-boundary tests, not only route tests.
