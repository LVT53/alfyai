# Normal Chat Client Turn Runtime belongs above streamChat

AlfyAI will treat Normal Chat Client Turn Runtime as an explicit browser-side boundary in `src/lib/client/normal-chat-client-turn-runtime.ts`. The runtime owns send, retry, reconnect, waiting, stop, queued follow-up, queued compaction, and recovery transitions for an active Normal Chat browser turn.

The runtime is a plain TypeScript client module above `streamChat`. It depends on injected page adapters for visible message updates, draft and queue state, metadata fan-out, polling, hydration, and UI-visible side effects. The chat page keeps Svelte state, route lifecycle, document workspace ownership, Deep Research controls, skill/session UI commands, and rendering.

`src/lib/services/streaming.ts` remains the browser transport boundary. It starts, reconnects, detaches, stops, and decodes AI SDK UI stream parts. The Normal Chat Client Turn Runtime consumes decoded callbacks from that transport; it does not parse raw stream lines, define part names, or own replay framing.

`src/lib/server/services/chat-turn/stream.ts` owns AI SDK UI stream framing. `src/lib/server/services/chat-turn/finalize.ts` and adjacent chat-turn modules remain the durable Normal Chat Turn Completion boundary. The runtime applies server-returned metadata through page adapters, but it does not build Context Sources or decide durable message, evidence, skill, Honcho, task, memory, or file-production completion order.

**Considered Options**

- Keep send, retry, reconnect, waiting, stop, and queue semantics in `src/routes/(app)/chat/[conversationId]/+page.svelte`.
- Move the runtime into `src/lib/services/streaming.ts` alongside transport code.
- Move browser runtime semantics into Svelte stores or visual components.
- Own Normal Chat Client Turn Runtime in a plain TypeScript client module above `streamChat`.

We chose a plain TypeScript runtime because the semantics are behavioral and testable without mounting the Svelte route. Keeping it above `streamChat` lets transport decoding stay stable while send, retry, reconnect, waiting, stop, and queue ordering share one browser-side implementation.

**Consequences**

- New browser-side Normal Chat turn transitions should enter through `src/lib/client/normal-chat-client-turn-runtime.ts`.
- The chat page should expose adapters for visible Svelte state, route lifecycle effects, document workspace state, and UI commands instead of owning runtime sequencing inline.
- Runtime tests should verify observable turn-state transitions through the runtime interface, not page internals.
- The runtime should consume decoded callbacks and metadata only; AI SDK UI stream part changes belong in `src/lib/server/services/chat-turn/stream.ts` and `src/lib/services/streaming.ts`, and durable completion changes belong in chat-turn.
