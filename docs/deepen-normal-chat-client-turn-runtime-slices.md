# Deepen Normal Chat Client Turn Runtime Slices

**Date:** 2026-05-31
**Source:** `/private/var/folders/6c/llmb9__97ngcxtc26hvg8jzh0000gn/T/architecture-review-20260529-195600.html`, section `Deepen Normal Chat Client Turn Runtime`
**Status:** Implemented

## Goal

Move Normal Chat browser turn-runtime semantics out of `src/routes/(app)/chat/[conversationId]/+page.svelte` into one client-side deep module above `streamChat`. The chat page should keep visible Svelte state, rendering, and UI commands, while the runtime owns send/retry/reconnect/waiting/queue/recovery transitions over the AI SDK UI stream transport.

## Documentation Check

- Context7 SvelteKit docs confirm route `load` functions should stay data-oriented and browser-only behavior should run from client code after mount.
- Context7 Svelte 5 docs confirm `$state`, `$derived`, `$effect`, `$props`, and callback props are current patterns for component state and component contracts; the new runtime should stay plain TypeScript so the page can keep Svelte-visible state.
- Context7 Vitest v4.1.6 docs confirm pure TypeScript module tests with `vi.fn`, async mocks, and global fetch/timer mocks are appropriate for the new runtime contract.
- Context7 Playwright docs confirm locator-first smoke tests and `waitForResponse` remain suitable for live UI verification if needed.
- The Svelte-specific MCP docs tool is not available in this session; Context7 official Svelte/SvelteKit docs are the fallback.

## Implementation Evidence

- `src/lib/services/streaming.ts` is already a transport adapter. It handles AI SDK UI stream decoding, inline thinking cleanup, stop versus detach, reconnect stream IDs, retry endpoint routing, and timing callbacks.
- `src/lib/client/normal-chat-client-turn-runtime.ts` now owns runtime semantics above that transport: normal send callbacks, retry callbacks, orphaned-stream reconnect, waiting-state polling handoff, queued follow-up turn drain, stopped-turn restore, background abort recovery, and completion metadata fan-out through page-provided adapters.
- `src/routes/(app)/chat/[conversationId]/+page.svelte` keeps visible Svelte state, rendering, route lifecycle, document workspace ownership, and UI commands.
- `src/routes/(app)/chat/[conversationId]/_helpers.ts` owns message-list reducers and small predicates that the runtime may call through page-provided adapters, but it is not the runtime authority.
- `docs/adr/0015-normal-chat-turn-completion-boundary.md` and the superseded `docs/adr/0016-browser-sse-protocol-boundary.md` define adjacent completion and historical transport boundaries; current work must not move durable completion or AI SDK UI stream parsing into the client runtime.

## Vertical Slices

### NCCR-01. Define the client turn runtime contract

**Type:** AFK
**Blocked by:** None
**Status:** Completed
**User stories covered:** As a maintainer, I can inspect one client module to understand send, retry, reconnect, waiting, stop, and queue transitions for a Normal Chat browser turn.

**What to build:** Add a plain TypeScript Normal Chat Client Turn Runtime module with typed inputs, outputs, runtime state, and injected adapters for `streamChat`, orphan checks, buffer inspection, polling, hydration, visible message updates, metadata application, and draft/queue operations. Keep the first slice thin by making it wrap current behavior without changing UI semantics.

**Acceptance criteria**

- [x] One client module owns the named runtime states and commands for send, retry, reconnect, stop, queue, clear/edit queue, and drain after completion.
- [x] The module depends on `streamChat` as the transport seam and does not parse raw AI SDK UI stream frames.
- [x] The chat page provides UI-visible adapters and remains the owner of Svelte stores, `$state`, and rendering.
- [x] Focused unit tests cover state transitions without mounting the Svelte page.

### NCCR-02. Move send and retry callback semantics into the runtime

**Type:** AFK
**Blocked by:** NCCR-01
**Status:** Completed
**User stories covered:** As a user, normal send and retry produce the same optimistic rows, metadata updates, generated-file refresh, stopped-turn draft restore, and retry affordances while duplicated callback logic disappears from the page.

**What to build:** Route `handleSend` and `handleRetry` through the client runtime for stream callback construction and turn finalization. Preserve Deep Research handoff and skill-session startup in the page unless a later slice explicitly moves those concerns.

**Acceptance criteria**

- [x] Normal send and retry share one runtime completion/error callback path.
- [x] Metadata fan-out for context status, Context Sources, active working set, task state, context debug, generated files, compression snapshots, message evidence polling, cost refresh, and file-production job attachment is preserved.
- [x] Stopped turns restore queued payloads or run queued compaction exactly as before.
- [x] Existing send/retry unit coverage passes, and new runtime tests cover success, stop, known error, pending-skill-unavailable, and fork-source-history-confirmation cases.

### NCCR-03. Move reconnect and waiting recovery into the runtime

**Type:** AFK
**Blocked by:** NCCR-01
**Status:** Completed
**User stories covered:** As a user returning to a tab, orphaned-stream recovery, capacity retry backoff, waiting-state polling, and persisted-data fallback keep working without page-local reconnect sequencing.

**What to build:** Move orphan detection, buffer lookup, reconnect placeholder setup, capacity backoff, waiting handoff, polling handoff, and fallback hydration orchestration behind runtime commands. The page should trigger runtime mount/visibility commands and apply visible adapter callbacks.

**Acceptance criteria**

- [x] `checkForOrphanedStream` and `getStreamBufferInfo` are called from the runtime, not directly from the page.
- [x] Waiting events detach the local stream and delegate to the existing polling/hydration path without double-finalizing.
- [x] Capacity errors retry reconnect with the same bounded backoff and then fall back to persisted conversation detail.
- [x] Focused runtime tests cover orphan present, orphan absent, waiting handoff, capacity retry, and persisted fallback.

### NCCR-04. Move queued follow-up and queued compaction runtime rules

**Type:** AFK
**Blocked by:** NCCR-02
**Status:** Completed
**User stories covered:** As a user, one follow-up message or manual compaction can be queued while a response is streaming, then drains only after the current turn is complete.

**What to build:** Move queue admission, queued-turn clone/clear/edit decisions, queued compaction, stopped-turn restore, and post-turn drain ordering into the runtime. The page keeps draft persistence and visible queued preview state through runtime snapshots or callbacks.

**Acceptance criteria**

- [x] Queue admission rules remain unchanged: one queued message, only while a turn is active, never for read-only conversations or blank messages.
- [x] Manual context compression still queues behind active turns and runs before queued follow-up sends.
- [x] Stopped or failed turns restore queued turns to the draft instead of auto-sending.
- [x] Runtime tests cover queue admission, queue replacement rejection, compaction-before-message drain, stop restore, and error restore.

### NCCR-05. Reduce the chat page to visible state and commands

**Type:** AFK
**Blocked by:** NCCR-02, NCCR-03, NCCR-04
**Status:** Completed
**User stories covered:** As a maintainer, the chat route is readable as page state, render commands, route lifecycle, and UI event handlers instead of a bespoke stream runtime.

**What to build:** Remove duplicated page-local stream callback blocks, reconnect internals, and queue runtime branches that are now represented in the client runtime. Keep page-local responsibilities for Svelte state, route lifecycle, document workspace, Deep Research job control, skill/session UI, and direct UI commands.

**Acceptance criteria**

- [x] The page no longer imports `streamChat`, `checkForOrphanedStream`, or `getStreamBufferInfo` directly.
- [x] `activeStream` is represented through runtime state or a runtime command, not page-local transport ownership.
- [x] The page still owns visible data updates, localization, draft persistence, and route lifecycle hooks.
- [x] No Browser SSE Protocol, server completion, or file-production durable behavior is moved into the client runtime.

### NCCR-06. Clean stale tests/docs and record the boundary

**Type:** AFK
**Blocked by:** NCCR-05
**Status:** Completed
**User stories covered:** As a future agent, I know the Normal Chat Client Turn Runtime boundary is intentional and tests are not littered with obsolete page-harness or temporary TDD artifacts.

**What to build:** Remove stale test files, temporary helpers, unused modules/imports, and duplicated tests made obsolete by the runtime. Update `CONTEXT.md`, a related ADR, and the architecture-review HTML with the implemented boundary, status, and verification evidence.

**Acceptance criteria**

- [x] Stale page-level stream/retry/reconnect tests are removed or reshaped into focused runtime tests.
- [x] Unused imports/modules created during the refactor are removed.
- [x] `CONTEXT.md` defines **Normal Chat Client Turn Runtime** and its relationship to Browser SSE Protocol, Normal Chat Turn Completion, Context Sources, and the chat page.
- [x] ADR-0019 records that client turn runtime semantics live in the new client module, while the page keeps visible state and the transport stays in `streaming.ts`.
- [x] The architecture-review HTML section is marked finished with implementation status and verification notes.

## Implementation Record

- `src/lib/client/normal-chat-client-turn-runtime.ts` owns Normal Chat Client Turn Runtime semantics above `streamChat`.
- `src/routes/(app)/chat/[conversationId]/+page.svelte` keeps visible Svelte state, route lifecycle, document workspace ownership, and UI commands through runtime adapters.
- `src/lib/services/streaming.ts` remains the browser transport boundary.
- `src/lib/services/stream-protocol.ts` remains the browser stream helper boundary, with AI SDK UI stream parsing owned by `src/lib/services/streaming.ts` and server framing owned by `src/lib/server/services/chat-turn/stream.ts`.
- `src/lib/server/services/chat-turn/finalize.ts` and adjacent chat-turn modules remain the durable Normal Chat Turn Completion boundary.
- The obsolete combined user-message/assistant-placeholder helper was confirmed unused and removed from the chat page helper module.

## Verification Plan

Run focused checks first, then broad checks:

- `npx vitest run src/lib/client/normal-chat-client-turn-runtime.test.ts src/lib/services/streaming.test.ts 'src/routes/(app)/chat/[conversationId]/_helpers.test.ts'`
- `npm run check`
- `npm run test:unit`
- If the refactor touches visible chat behavior beyond module wiring, run the relevant Playwright chat specs.
- Remote live workflow after local verification: commit, push `dev`, fast-forward `main`, deploy on `alfydesign`, restart `langflow-chat.service`, check `/api/health`, inspect journal logs, and run an authenticated live Normal Chat smoke test.
