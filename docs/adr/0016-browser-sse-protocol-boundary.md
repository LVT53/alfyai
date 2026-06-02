# Browser SSE Protocol was superseded by AI SDK UI streams

Status: Superseded by ADR-0025 and the AI SDK UI stream migration. Normal Chat no longer uses the custom Browser SSE event grammar (`token`, `thinking`, `tool_call`, `end`, `error`, `replay_start`, `replay_end`, `waiting`) as a production browser contract. The current browser-facing stream contract is AI SDK UI message stream framing emitted by `src/lib/server/services/chat-turn/stream.ts`, consumed by `src/lib/services/streaming.ts`, and terminated with `data-stream-metadata`, `finish`, and `[DONE]` parts.

Historical content below describes the retired Browser SSE boundary. Do not use it as current implementation guidance.

AlfyAI treated the browser-facing chat SSE contract as an explicit shared protocol boundary. `src/lib/services/stream-protocol.ts` owned the allowed Browser SSE Protocol event names, payload shapes, encoding, decoding, comment tolerance, replay framing, and terminal-event inspection for Normal Chat stream and reconnect responses.

The Browser SSE Protocol was transport grammar, not durable turn completion. Chat-turn services decided what tokens, thinking chunks, tool-call updates, errors, replay buffers, waiting markers, and completion metadata should be exposed, and emitted those browser-facing events through shared protocol helpers. Browser transport code decoded event blocks through the same boundary instead of reimplementing line-prefix switching for each event.

The Normal Chat Client Turn Runtime was the browser-side consumer above `streamChat`, not the protocol grammar owner. `src/lib/client/normal-chat-client-turn-runtime.ts` received decoded transport callbacks and applied server-returned metadata through page adapters; it did not parse raw SSE lines, invent event names, or build Browser SSE fixtures outside the shared protocol helpers.

This boundary preserved the old event names and payload shapes: `token`, `thinking`, `tool_call`, `end`, `error`, `replay_start`, `replay_end`, and `waiting`.

**Considered Options**

- Keep raw SSE string builders in stream runtime, stream completion, reconnect, and browser tests.
- Move only server emission to a helper while leaving browser parsing ad hoc.
- Treat SSE events as route-local implementation detail.
- Own the browser-facing SSE contract in `src/lib/services/stream-protocol.ts`.

We chose a shared protocol boundary because stream, retry, reconnect, and browser parsing all rely on the same event grammar. Keeping the grammar in one module makes replay and terminal-event behavior testable without changing durable completion ownership or introducing a second chat-turn pipeline.

**Historical Consequences**

- During this boundary's lifetime, production code avoided duplicate Browser SSE Protocol encoders, event-name constants, and raw-string event parsers outside `src/lib/services/stream-protocol.ts`.
- Tests used protocol helpers for normal browser SSE event fixtures and assertions when that improved clarity.
- Tests kept controlled raw SSE chunks for malformed data, split `data:` lines, missing final blank lines, comments, and other parser edge cases.
- Normal Chat Turn Completion stayed owned by chat-turn; the Browser SSE Protocol exposed transport events and completion metadata to the browser.
- The surviving current rule is that Normal Chat Client Turn Runtime transitions stay above the stream transport. Current changes should use the AI SDK UI stream framing helpers rather than rebuilding raw frame parsing in page/runtime code.
