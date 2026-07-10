# Chat Streaming Candidate 1+4 Implementation Issues

This is the local `$to-issues` implementation backlog for the selected
architecture report candidates:

- Candidate 1: Fast Terminal Receipt Module
- Candidate 4: Runtime Phase Model: Generating vs Finalizing

No external issue tracker configuration was found in this workspace. Existing
project planning docs use local issue files under `docs/`, so this file records
issue-ready vertical slices for sub-agents.

## Evidence And Constraints

- `AGENTS.md`: routes are adapters; stream framing belongs in
  `src/lib/server/services/chat-turn/stream.ts`; browser transport belongs in
  `src/lib/services/streaming.ts`; Normal Chat Client Turn Runtime belongs in
  `src/lib/client/normal-chat-client-turn-runtime.ts`; durable completion stays
  in chat-turn.
- Context7 SvelteKit docs: `+server` handlers can return `Response` bodies
  backed by `ReadableStream`; request aborts should be handled through the
  request signal and stream cancellation.
- Context7 Svelte 5 docs: touched Svelte components should use runes,
  `$derived` for derived state, and modern callback/event patterns.
- Context7 AI SDK docs: streamed model output includes text/reasoning parts and
  a `finish` part; UI stream finish can be represented with the existing
  `finish` part rather than inventing a new wire part.
- ADR-0015: Normal Chat Turn Completion is a chat-turn boundary, not route-local
  sequencing.
- ADR-0019: browser-side send/retry/reconnect/wait/stop/queue transitions live
  in `normal-chat-client-turn-runtime.ts`, above `streamChat`.
- ADR-0025: AI SDK UI streams are the current browser stream contract; preserve
  part names and parser expectations unless tests move with the contract.

## Issue 1: Emit Terminal Stream Receipt Before Broad Post-Turn Projection

**Type / triage label:** `performance`, `chat-turn`, `streaming`, `tdd`

### User Value

After the model has finished producing the visible answer, the browser should
receive terminal stream metadata, `finish`, and `[DONE]` as soon as the user and
assistant messages are durably identifiable. Slow evidence, context-source,
cost, compression, generated-file, memory, Honcho, task, or detail projection
work must not keep the UI in an active generation state.

### Acceptance Criteria

- [ ] A successful stream persists enough of the turn to return stable
      `userMessageId` and `assistantMessageId` before terminal frames are sent.
- [ ] Terminal stream metadata includes the fast receipt fields required for
      finalizing the placeholder: message ids, token counts, model/provider
      display data, depth metadata, stopped/finish warning fields, and
      `generationDurationMs`.
- [ ] `data-stream-metadata`, AI SDK UI `finish`, and `[DONE]` are emitted before
      broad post-turn tasks such as evidence persistence, context-source
      construction, conversation cost lookup, compression snapshot listing, file
      production reconciliation, generated-file memory sync, Honcho/task/memory
      follow-up, or conversation-detail projection.
- [ ] The existing post-turn side effects still run after the terminal receipt,
      are logged on failure, and do not reopen or hold the browser stream.
- [ ] No route-local durable completion order is introduced; all server changes
      remain inside `src/lib/server/services/chat-turn/`.
- [ ] Existing send/retry behavior remains compatible with the durable
      completion boundary.

### Technical Notes

- Primary files:
  - `src/lib/server/services/chat-turn/stream-completion.ts`
  - `src/lib/server/services/chat-turn/finalize.ts`
  - `src/lib/server/services/chat-turn/types.ts`
  - `src/lib/server/services/chat-turn/stream-completion.test.ts`
  - `src/lib/server/services/chat-turn/finalize.test.ts`
- The likely deepening is to split the current `finalizeChatTurn` result into a
  minimal receipt path plus a deferred projection/fan-out path, or to add a
  clearly named chat-turn interface that returns a receipt and a follow-up task.
- Do not emit terminal frames before assistant message identity exists.
- Do not add a new AI SDK UI stream part shape. Use existing metadata, `finish`,
  and done frames.
- If fast metadata intentionally omits heavy fields such as `contextSources`,
  `generatedFiles`, `fileProductionJobs`, cost totals, or compression snapshots,
  that must be an explicit contract and the browser/detail refresh must cover
  the eventual projection.

### Highest-Feasible Verification

- Unit test `completeStreamTurn` with intentionally delayed post-turn projection
  dependencies and assert terminal chunks and downstream close occur before the
  delayed dependency resolves.
- Unit test that the deferred post-turn task still runs after terminal emission.
- Unit test fallback behavior when the receipt path succeeds but deferred
  projection fails: stream still ends successfully and failure is logged.
- Run focused server tests:
  `npx vitest run src/lib/server/services/chat-turn/stream-completion.test.ts src/lib/server/services/chat-turn/finalize.test.ts`

### Dependencies

None.

## Issue 2: Hydrate Eventual Completion Metadata After Fast Receipt

**Type / triage label:** `performance`, `client-runtime`, `read-model`, `tdd`

### User Value

When fast terminal receipt closes the stream before slower metadata is ready, the
chat surface should still converge on full context sources, costs, evidence, and
file-production cards through the existing conversation detail and polling
paths.

### Acceptance Criteria

- [ ] A stream completion that contains an `assistantMessageId` but omits heavy
      terminal metadata triggers existing refresh/polling paths rather than
      leaving stale context, cost, evidence, or file-production UI.
- [ ] The runtime does not block `isSending` on this refresh work.
- [ ] Generated file and file-production job projection still appears after
      turns that used `produce_file`.
- [ ] Context Sources and Context Compression markers eventually reflect the
      durable read-model state after stream completion.
- [ ] The implementation reuses `hydrateConversationDetail`,
      `pollMessageEvidence`, file-production refresh, and cost refresh adapters;
      it does not duplicate read-model assembly in the runtime or page.

### Technical Notes

- Primary files:
  - `src/lib/client/normal-chat-client-turn-runtime.ts`
  - `src/routes/(app)/chat/[conversationId]/+page.svelte`
  - `src/lib/client/normal-chat-client-turn-runtime.test.ts`
  - Existing page helpers used by `finalizeStreamingMessageList`
- Coordinate with Issue 1 if the fast receipt metadata shape changes.
- Keep browser raw stream parsing in `src/lib/services/streaming.ts`.
- Keep route/page code as adapters; do not rebuild completion projections in
  Svelte.

### Highest-Feasible Verification

- Runtime test where `onEnd` receives only receipt metadata with
  `assistantMessageId`; assert `isSending` clears while detail/evidence/cost
  refresh adapters are invoked.
- Runtime test where generated-file metadata is absent from receipt; assert the
  existing detail hydration path is still called.
- Focused client test:
  `npx vitest run src/lib/client/normal-chat-client-turn-runtime.test.ts`

### Dependencies

Depends on the fast receipt metadata contract from Issue 1.

## Issue 3: Add Normal Chat Runtime Phase For Preparing, Generating, Finalizing, And Polling

**Type / triage label:** `performance`, `client-runtime`, `streaming`, `tdd`

### User Value

The browser should distinguish active text generation from final stream cleanup.
After the AI SDK UI `finish` part arrives, the runtime can show a finalizing
phase instead of presenting continued generation.

### Acceptance Criteria

- [ ] `NormalChatRuntimeSnapshot` exposes a stable phase enum such as `idle`,
      `preparing`, `generating`, `finalizing`, and `polling`.
- [ ] The runtime starts in `idle`, moves to `preparing` when a turn begins,
      moves to `generating` on token/thinking/tool/activity progress, moves to
      `finalizing` when the stream transport decodes the existing AI SDK UI
      `finish` part, moves to `polling` for server waiting/reconnect polling,
      and returns to `idle` after completion or error cleanup.
- [ ] Stream transport reports the existing `finish` part through a decoded
      callback; no new wire part is introduced.
- [ ] User-requested stop, background detach, reconnect, error, queued
      follow-up, and context compression transitions keep coherent phase state.
- [ ] Existing `isSending`, `active`, and `isPollingForCompletion` semantics stay
      backwards compatible for current page controls.

### Technical Notes

- Primary files:
  - `src/lib/services/streaming.ts`
  - `src/lib/services/streaming.test.ts`
  - `src/lib/client/normal-chat-client-turn-runtime.ts`
  - `src/lib/client/normal-chat-client-turn-runtime.test.ts`
  - `src/lib/types.ts` if the phase is also stored on active assistant messages
- The stream transport should add an optional decoded callback such as
  `onFinishPart`/`onFinalizing` rather than exposing raw AI SDK frame parsing to
  the runtime.
- Runtime tests should assert phase snapshots, not page internals.

### Highest-Feasible Verification

- Streaming transport test: when a `finish` part is decoded before `[DONE]`, the
  new callback fires once and `onEnd` still fires once.
- Runtime tests for normal send, stopped stream, polling/waiting, error, and
  queued follow-up phase transitions.
- Focused tests:
  `npx vitest run src/lib/services/streaming.test.ts src/lib/client/normal-chat-client-turn-runtime.test.ts`

### Dependencies

None. It can land before Issue 1, though the finalizing phase becomes most
visible after the server emits `finish` earlier.

## Issue 4: Surface Finalizing Phase In Chat UI Without Making Components Own Runtime Semantics

**Type / triage label:** `performance`, `ui`, `i18n`, `tdd`

### User Value

When the visible answer has stopped changing but the turn is not fully closed,
the assistant bubble should show a localized finalizing status rather than the
generic "Preparing response" or a misleading active generation indication.

### Acceptance Criteria

- [ ] Active assistant placeholder messages can carry the runtime phase needed
      for rendering without making `MessageBubble.svelte` own turn sequencing.
- [ ] `MessageBubble.svelte` renders a localized finalizing status only for the
      finalizing phase and keeps current preparing/context/drafting/deliberation
      statuses intact.
- [ ] The markdown renderer no longer treats finalizing as active token
      streaming once the transport has emitted the AI SDK UI `finish` part.
- [ ] New visible strings are localized in English and Hungarian.
- [ ] The UI remains compatible with completed persisted messages that do not
      have a runtime phase.

### Technical Notes

- Primary files:
  - `src/lib/types.ts`
  - `src/routes/(app)/chat/[conversationId]/+page.svelte`
  - Chat message list helper files imported by the page, if present
  - `src/lib/components/chat/MessageBubble.svelte`
  - `src/lib/components/chat/MessageBubble.test.ts`
  - `src/lib/i18n/chat.ts`
- Follow Svelte 5 rules from `AGENTS.md`: use `$derived` for display state in
  touched Svelte components and do not introduce legacy event syntax.
- Keep runtime semantics in `normal-chat-client-turn-runtime.ts`; UI receives a
  simple phase field.

### Highest-Feasible Verification

- Component test for finalizing status rendering in English-visible UI.
- Component test or i18n assertion that the Hungarian key exists.
- Runtime/page-adapter test if the phase field is updated through message list
  helpers.
- Focused UI tests:
  `npx vitest run src/lib/components/chat/MessageBubble.test.ts src/lib/client/normal-chat-client-turn-runtime.test.ts`

### Dependencies

Depends on Issue 3.

## Issue 5: Full Review, Gates, Commit, And Push

**Type / triage label:** `verification`, `release`, `ops`

### User Value

The Candidate 1+4 implementation is not finished until the integrated worktree
passes the repo gates and an independent review checks the performance intent,
module ownership, and regression coverage.

### Acceptance Criteria

- [ ] Review the integrated diff for route thickness, duplicate stream parsing,
      accidental AI SDK UI part-shape changes, and runtime/page ownership drift.
- [ ] Confirm terminal frames are no longer blocked by broad post-turn
      projection work.
- [ ] Confirm the runtime exposes and clears phases correctly across success,
      stop, error, waiting/polling, and queued turn paths.
- [ ] Run focused tests from Issues 1-4.
- [ ] Run `npm run check` and it completes with 0 errors and 0 warnings, or
      report exact pre-existing unrelated diagnostics.
- [ ] Run
      `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`
      and confirm no new findings beyond documented debt.
- [ ] Run broader `npm test` if focused tests and typecheck pass.
- [ ] Commit the final integrated work and push to `origin main`.

### Technical Notes

- The review worker may inspect and recommend fixes, but substantial fixes
  should be delegated back to the smallest responsible implementation worker.
- Git operations that write refs or push require explicit escalation from the
  orchestrator context.

### Highest-Feasible Verification

- Gate command output captured by the orchestrator.
- `git status --short` clean except intentional untracked artifacts before
  commit, then clean after commit.
- `git log -1 --oneline` shows the implementation commit on `main`.
- `git status --short --branch` shows `main...origin/main` with no ahead commits
  after push.

### Dependencies

Depends on Issues 1-4.
