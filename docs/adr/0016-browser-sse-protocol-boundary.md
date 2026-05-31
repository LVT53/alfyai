# Browser SSE Protocol belongs to stream-protocol

AlfyAI will treat the browser-facing chat SSE contract as an explicit shared protocol boundary. `src/lib/services/stream-protocol.ts` owns the allowed Browser SSE Protocol event names, payload shapes, encoding, decoding, comment tolerance, replay framing, and terminal-event inspection for Normal Chat stream and reconnect responses.

The Browser SSE Protocol is transport grammar, not durable turn completion. Chat-turn services may decide what tokens, thinking chunks, tool-call updates, errors, replay buffers, waiting markers, and completion metadata should be exposed, but they should emit those browser-facing events through the shared protocol helpers. Browser transport code should decode event blocks through the same boundary instead of reimplementing line-prefix switching for each event.

The Normal Chat Client Turn Runtime is the browser-side consumer above `streamChat`, not the protocol grammar owner. `src/lib/client/normal-chat-client-turn-runtime.ts` receives decoded transport callbacks and applies server-returned metadata through page adapters; it should not parse raw SSE lines, invent event names, or build Browser SSE fixtures outside the shared protocol helpers.

This boundary preserves the current event names and payload shapes: `token`, `thinking`, `tool_call`, `end`, `error`, `replay_start`, `replay_end`, and `waiting`. Any future event-shape change must update the protocol module and its contract tests first, then update server emission, browser parsing, reconnect behavior, and route tests as dependent adapters.

**Considered Options**

- Keep raw SSE string builders in stream runtime, stream completion, reconnect, and browser tests.
- Move only server emission to a helper while leaving browser parsing ad hoc.
- Treat SSE events as route-local implementation detail.
- Own the browser-facing SSE contract in `src/lib/services/stream-protocol.ts`.

We chose a shared protocol boundary because stream, retry, reconnect, and browser parsing all rely on the same event grammar. Keeping the grammar in one module makes replay and terminal-event behavior testable without changing durable completion ownership or introducing a second chat-turn pipeline.

**Consequences**

- Production code should not add duplicate Browser SSE Protocol encoders, event-name constants, or raw-string event parsers outside `src/lib/services/stream-protocol.ts`.
- Tests should use protocol helpers for normal browser SSE event fixtures and assertions when that improves clarity.
- Tests may keep controlled raw SSE chunks for malformed data, split `data:` lines, missing final blank lines, comments, and other parser edge cases.
- Normal Chat Turn Completion remains owned by chat-turn; the Browser SSE Protocol only exposes transport events and completion metadata to the browser.
- Normal Chat Client Turn Runtime transitions remain owned by `src/lib/client/normal-chat-client-turn-runtime.ts`; they consume decoded protocol callbacks without becoming a second Browser SSE parser.
