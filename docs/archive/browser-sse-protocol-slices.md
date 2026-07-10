# Browser SSE Protocol Slices

**Date:** 2026-05-29
**Source:** `/private/var/folders/6c/llmb9__97ngcxtc26hvg8jzh0000gn/T/architecture-review-20260529-134900.html`, section `Make The Browser SSE Protocol Explicit`

## Goal

Make the browser-facing chat SSE contract explicit without changing existing event names or payload shapes. Event encoding, replay framing, completion/error framing, and browser decoding should flow through one small protocol boundary so future event-shape changes are localized and contract-tested.

## Documentation Check

- Context7 SvelteKit docs confirm SvelteKit server endpoints can return standard Web API `Response` objects with custom headers and bodies. This supports keeping `text/event-stream` responses as explicit `Response` construction.
- Context7 Vitest v4.1.6 docs confirm ordinary TypeScript `.test.ts` suites with `describe`, `it`, and `expect` are the right fit for pure encode/decode contract tests.
- Context7 Playwright docs confirm `page.waitForResponse` and polling are current browser-level verification tools if the stream contract needs end-to-end browser coverage.
- MDN Server-Sent Events docs confirm event streams are UTF-8 text, messages are separated by blank lines, comment lines may be used for keep-alives, and named events use `event:` plus `data:` fields.
- The Svelte-specific MCP docs tool is not available in this session; Context7 SvelteKit official docs are the fallback.

## Current Evidence

- `src/lib/server/services/chat-turn/stream.ts` formats `token`, `thinking`, `tool_call`, and `error` as raw SSE strings.
- `src/lib/server/services/chat-turn/stream-completion.ts` formats the final `end` event as a raw SSE string.
- `src/lib/server/services/chat-turn/stream-reconnect.ts` formats `replay_start`, replayed `token`/`thinking`/`tool_call`, `replay_end`, and live-end/error detection with raw strings.
- `src/lib/services/streaming.ts` parses browser events with line-prefix checks and ad hoc JSON decoding.
- `src/lib/services/stream-protocol.ts` already owns shared stream text cleanup, but not the browser SSE event contract.

## Vertical Slices

### 1. Define the browser SSE contract

**Type:** AFK
**Blocked by:** None
**Status:** Complete on 2026-05-29. Implemented in `src/lib/services/stream-protocol.ts` with contract tests in `src/lib/services/stream-protocol.test.ts`.
**User stories covered:** As a maintainer, I can inspect one module to know every chat SSE event name and payload shape.

**What to build:** Add a typed browser SSE protocol boundary that can encode current chat stream events and decode incoming event blocks. Preserve all existing event names: `token`, `thinking`, `tool_call`, `end`, `error`, `replay_start`, `replay_end`, and `waiting`. Preserve comment/prelude/heartbeat handling.

**Acceptance criteria**

- [x] Event-name constants and payload types live in one shared protocol module.
- [x] Encoding current event payloads produces the same wire text shape as the existing raw strings.
- [x] Decoding CRLF/LF event blocks and trailing final blocks is covered by contract tests.
- [x] Comments and blank lines remain ignored by browser decoding.

### 2. Move server emission onto the protocol boundary

**Type:** AFK
**Blocked by:** Slice 1
**Status:** Complete on 2026-05-29. Stream runtime, completion, and reconnect replay now emit through the protocol helpers.
**User stories covered:** As a user, streaming, reconnect, stop, and error behavior continue unchanged while server-side raw-string coupling drops.

**What to build:** Replace raw chat SSE event string construction in stream runtime, stream completion, and reconnect replay with protocol encoder helpers. Keep response headers, prelude padding, heartbeat comments, buffer broadcasting, and stream close behavior unchanged.

**Acceptance criteria**

- [x] Token, thinking, tool-call, end, error, replay-start, replay-end, and waiting events are emitted through protocol helpers.
- [x] Reconnect live-end/error detection uses protocol event parsing/inspection rather than string prefix checks.
- [x] Existing stream-runtime, stream-completion, stream-reconnect, and route tests still pass.
- [x] No new SSE event names or payload fields are introduced.

### 3. Move browser parsing onto the protocol boundary

**Type:** AFK
**Blocked by:** Slice 1
**Status:** Complete on 2026-05-29. `streamChat` now decodes browser stream event blocks through the shared protocol boundary.
**User stories covered:** As a user, the browser transport still receives tokens, thinking chunks, tool-call updates, replay buffers, metadata, waiting, and errors exactly as before.

**What to build:** Refactor `streamChat` parsing so line buffering and event-block decoding are shared with the protocol module, while keeping transport timing, inline thinking splitting, replay buffering, stop/detach behavior, and callback semantics unchanged.

**Acceptance criteria**

- [x] Browser decoding is event-block oriented instead of hardcoded line-prefix event switching.
- [x] End metadata extraction keeps the current optional-field shape and omits empty metadata.
- [x] Error parsing keeps `message`, `error`, and `code` fallback behavior.
- [x] Existing `streaming.test.ts` behavior remains covered and passes.

### 4. Clean stale test helpers and document the boundary

**Type:** AFK
**Blocked by:** Slices 2 and 3
**Status:** Complete on 2026-05-29, including repo cleanup/docs and the architecture-review HTML status update.
**User stories covered:** As a future agent, I know the browser SSE protocol boundary is intentional and tests are not littered with stale raw-string helper copies.

**What to build:** Remove any duplicate local SSE string builders/helpers made obsolete by the protocol module, update test fixtures to use shared helpers where this improves clarity, and document the boundary in `CONTEXT.md`, relevant ADRs, and the source architecture-review HTML status.

**Acceptance criteria**

- [x] Obsolete test-only SSE builders or duplicate protocol helpers are removed or replaced with shared helpers.
- [x] `CONTEXT.md` defines the browser SSE protocol boundary and avoidance language.
- [x] A relevant ADR records that browser SSE event names and payloads are owned by the shared protocol boundary.
- [x] The architecture-review HTML section is marked finished with implementation status and verification notes.

**Implementation notes**

- Removed the unused E2E stream mock helper file.
- Updated focused browser stream and reconnect tests to use `encodeBrowserChatSseEvent` and `decodeBrowserChatSseEvents` for normal protocol fixtures and assertions.
- Kept raw SSE fixtures where the test intentionally covers split `data:` lines, legacy string payload fallback, invalid JSON, or comments; missing final blank-line coverage now trims a shared helper event.
- Added ADR-0016 for the Browser SSE Protocol boundary and clarified ADR-0015 so durable Normal Chat Turn Completion remains separate from browser transport framing.

## Verification Plan

Run focused checks first, then broad checks:

- `npx vitest run src/lib/services/stream-protocol.test.ts src/lib/services/streaming.test.ts src/lib/server/services/chat-turn/stream-reconnect.test.ts src/lib/server/services/chat-turn/stream-completion.test.ts src/lib/server/services/chat-turn/stream-orchestrator.test.ts src/routes/api/chat/stream/stream.test.ts`
- `npm run check`
- `npm run test:unit`
- Remote live workflow after local verification: commit, push `dev`, fast-forward `main`, deploy on `alfydesign`, restart `langflow-chat.service`, check `/api/health`, inspect journal logs, and run an authenticated live chat smoke test.
