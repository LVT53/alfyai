# The Normal Chat Client Turn Runtime owns turn state

Accepted (2026-08-15, by the repository owner, ahead of implementation). **Supersedes [ADR-0019](0019-normal-chat-client-turn-runtime-boundary.md)** on the question of who owns the visible message list. Everything else ADR-0019 decided still holds.

ADR-0019 placed the Normal Chat Client Turn Runtime above `streamChat` and gave it send, retry, reconnect, waiting, stop, queued follow-up, and recovery. That placement was right and is unchanged. What it also did — and what this decision revisits — is require the runtime to reach *every* visible effect through injected page adapters, leaving the chat page as the owner of message state.

The result is a module whose interface has grown to **82 top-level adapter members** over a ~1 155-line implementation, of which the page implements the large majority in one 215-line literal, mostly as one-line pass-throughs to list helpers that already exist. That is a shallow module by the definition this codebase uses: the interface is nearly as complex as the implementation, and callers and tests must learn the whole surface to exercise any of it. Two consequences are user-visible rather than merely aesthetic:

- A recoverable transport error deletes the partially-streamed answer, because removal is an adapter call the runtime makes and no single owner is responsible for the message's lifetime.
- `canRetry` never crosses the seam, so the page offers a Retry affordance the runtime will silently refuse.

## The decision

The runtime owns the turn's message state — the assistant placeholder, its streamed text and reasoning, its lifetime, and its terminal outcome — and exposes it as observable state plus a small event surface. The chat page renders that state and keeps what ADR-0019 always gave it and still does: Svelte reactivity, route lifecycle, document workspace ownership, skill and session UI commands, and everything not part of a turn.

This narrows the interface rather than widening the runtime's remit. The runtime is not gaining new responsibilities; it is being allowed to hold the state it was already mutating through eighty-odd holes.

## What does not change

- The runtime remains a plain TypeScript module above `streamChat`. `src/lib/services/streaming.ts` remains the transport boundary and still owns starting, reconnecting, detaching, stopping, and decoding stream parts.
- The runtime still does not parse raw stream lines, define part names, or own replay framing.
- Durable **Normal Chat Turn Completion** stays in `chat-turn` ([ADR-0015](0015-normal-chat-turn-completion-boundary.md)). The runtime applies server-returned metadata; it does not decide durable message, evidence, skill, task, memory, or file-production order.
- The page keeps Svelte state that is not turn state.

## Considered Options

- Keep ADR-0019 unchanged and fix only the two defects.
- Keep the adapter seam but consolidate the message-list pass-throughs into one member.
- Move turn-state ownership into the runtime and shrink the interface to state plus events.

The first two were the conservative path and were the standing plan until this decision. They fix the visible defects and leave a seam that is still wide enough to reproduce them: with ownership split, "who is allowed to remove this message" remains a question answered at eighty call sites rather than one. Consolidation alone treats the symptom — interface width — without removing the cause, which is that no module owns the turn's message lifetime.

## Consequences

- `NormalChatClientTurnRuntimeAdapters` shrinks substantially. Record the before/after member count; the change is not done if the count has not materially fallen.
- The two defects are fixed by construction rather than by patch: a recoverable transport error preserves already-visible output, and retry availability is a property of the state the page renders rather than a flag it never receives.
- Tests move from asserting adapter calls to asserting observable turn state — closer to what a user sees, and reachable without reconstructing an 82-member surface.
- Migration is incremental. Ownership moves one concern at a time (message text, then reasoning, then lifetime, then terminal outcome), with the adapter seam remaining for everything not yet moved. No slice may leave two owners for the same field.
- Dead mirrored page state (`activeWorkingSet`, the page copy of `queuedContextCompression`) is removed as part of the move.
- ADR-0019 is marked superseded on this point only, with a pointer here. Its placement decision — the runtime lives above `streamChat`, not inside transport, not in the page — is still the governing rule.
