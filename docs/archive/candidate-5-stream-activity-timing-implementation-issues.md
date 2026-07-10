# Candidate 5 Stream Activity And Timing implementation issues

This is the local `$to-issues` implementation backlog for Candidate 5 from
`docs/chat-streaming-stability-deepening-report.html`.

The slices below are local issue drafts, not published tracker issues. No
external issue tracker configuration was found in this workspace, and existing
project practice keeps implementation backlogs under
`docs/*-implementation-issues.md`.

## Goal

Deepen Normal Chat stream activity and timing into one small timeline interface
so the app can explain and verify the "preparing response" phase without
spreading phase names, activity ids, terminal metadata, and browser timing
logic across unrelated files.

Candidate 5 should provide one mental model for:

- server stream phase marks, including route intake, prelude, context
  preparation, upstream stream connection, first upstream event, first thinking,
  first visible token, and terminal outcome
- user-visible response activity, especially the early empty-answer phase
- terminal stream metadata that can carry final server timing diagnostics
- browser timing correlation for first response headers, first byte, first
  activity, first thinking, first tool call, first token, end, stop, and errors

This candidate must not change provider behavior, provider fallback policy,
stream frame grammar, persistence ownership, or passive-disconnect semantics.

## Evidence

- Context7 AI SDK docs, queried 2026-06-29, confirm:
  - AI SDK UI streams support custom `data-*` parts.
  - Transient data parts are appropriate for temporary status/activity updates.
  - Client handlers can receive custom data parts without storing them in
    message history.
- Context7 SvelteKit docs, queried 2026-06-29, confirm:
  - `+server.ts` handlers return standard Web `Response` objects.
  - A `Response` body may be a `ReadableStream`.
  - Custom headers such as `Server-Timing` are set on the returned `Response`.
- `AGENTS.md` says:
  - routes are adapters
  - shared stream framing and terminal parsing belong in
    `src/lib/services/ai-sdk-ui-stream-contract.ts`
  - browser stream transport ownership belongs in `src/lib/services/streaming.ts`
  - stream lifecycle, active-stream registration, phase timing, prelude,
    heartbeat, model-run adaptation, and completion delegation belong in
    `src/lib/server/services/chat-turn/stream-orchestrator.ts`
  - terminal stream metadata belongs in
    `src/lib/server/services/chat-turn/stream-completion.ts`
- `src/lib/server/services/chat-turn/AGENTS.md` keeps the same ownership:
  - `stream-orchestrator.ts` owns live stream phase timing
  - `stream.ts` owns AI SDK UI stream runtime helpers
  - `stream-completion.ts` owns `data-stream-metadata` and `finish` payloads
  - `active-streams.ts` owns replay-buffer ownership
- Current code evidence:
  - `src/lib/server/services/chat-turn/stream.ts` owns SSE headers and formats
    `Server-Timing` from `StreamPhaseTimings`.
  - `src/lib/server/services/chat-turn/stream-orchestrator.ts` currently
    records phase timings with local string keys and emits response activity
    through local closures.
  - `src/lib/server/services/chat-turn/stream-completion.ts` emits terminal
    `data-stream-metadata` including `generationDurationMs`, but not a final
    structured server timeline.
  - `src/lib/services/streaming.ts` records browser timing phases and exposes an
    opt-in `onTiming` callback, but the phase vocabulary is local to that file.
  - `src/lib/client/normal-chat-client-turn-runtime.ts` forwards tokens,
    thinking, tools, response activity, and metadata, but does not currently
    correlate stream timing snapshots.
  - `src/lib/components/chat/MessageBubble.svelte` shows a generic localized
    "preparing response" line during the empty-answer phase and separately
    specializes deliberation activity.

## Collision constraints

- Candidate 1 may touch stream intake and completion-only facts. Candidate 5
  workers must avoid changing lazy completion-fact behavior, response-start
  semantics, and file-production snapshot timing unless a current integrated
  Candidate 1 patch already established those interfaces.
- Candidate 2 may touch provider adapter and provider fixture behavior.
  Candidate 5 workers must not modify:
  - `src/lib/server/services/normal-chat-model/**`
  - provider fixture files
  - provider integration tests, except read-only inspection
- Candidate 5 may modify only the stream timing/activity surfaces listed in the
  issue scopes below.
- Do not add new AI SDK UI stream part names casually. Prefer final
  `data-stream-metadata` fields and existing `data-response-activity` parts.
- Do not persist browser-only timing diagnostics into assistant-message metadata
  unless a slice explicitly justifies the retention policy and adds tests.
- Do not make diagnostic timing text user-facing. UI changes should show useful
  activity labels, not internal phase names or millisecond breakdowns.
- Do not collapse explicit stop and passive detach/background-disconnect
  behavior.

## Orchestration constraints

- The orchestrator does not write implementation code. Code-writing workers own
  their patches.
- Every code-writing worker must use `$tdd`, or explain why strict
  red-green-refactor was not feasible and still add the smallest useful
  regression check.
- Workers must not revert or overwrite concurrent edits.
- Workers must report changed paths, tests run, and any blockers.
- The review wave must pass all repo gates before Candidate 5 is called
  finished:
  - focused Vitest suites for changed stream surfaces
  - `git diff --check`
  - `npm run check`
  - `npm run lint`
  - `npm test`
  - `npm run build`
  - Fallow audit:
    `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`
  - targeted Playwright coverage for chat streaming:
    `npx playwright test tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts`

## Summary

| ID | Title | Type | Blocked by | Suggested owner scope |
| --- | --- | --- | --- | --- |
| C5-01 | Introduce shared stream timeline vocabulary | AFK | None | Shared timeline module and pure unit tests |
| C5-02 | Route server stream marks and terminal metadata through the timeline | AFK | C5-01 | Stream helper, orchestrator, completion, focused server tests |
| C5-03 | Correlate browser timing with server timeline metadata | AFK | C5-01, C5-02 | Browser stream transport and focused browser transport tests |
| C5-04 | Surface early activity in the client runtime and chat UI | AFK | C5-02, C5-03 | Client turn runtime, chat page adapters, MessageBubble, i18n/tests |
| C5-05 | Full review, gates, commit, and main push | HITL | C5-01 through C5-04 | Orchestrator review, delegated fixes, full verification, commit, push |

## Parallelization plan

Use bounded parallelism because most write scopes share the same stream
contract.

1. Start **C5-01** first. It defines the vocabulary and pure helpers without
   changing runtime behavior.
2. In parallel with C5-01, a read-only explorer may audit UI/runtime consumers
   for C5-04 risks, but no second code-writing worker should edit stream files.
3. Run **C5-02** after C5-01 lands. This is the main server adoption slice and
   should own all server timing/metadata integration.
4. Run **C5-03** after C5-02 because browser correlation needs the terminal
   metadata shape produced by the server.
5. Run **C5-04** after C5-02 and C5-03. It should stay small: display better
   early activity and wire timing callbacks where useful without exposing
   diagnostic timing internals to users.
6. Run **C5-05** last. Candidate 5 is not finished until this wave passes the
   repo gates and the final commit is pushed to `main`.

## C5-01: Introduce shared stream timeline vocabulary

**Type:** AFK
**Blocked by:** None - can start immediately

### What to build

Create a small shared stream timeline module that owns the vocabulary and pure
operations for stream marks and timing snapshots.

The module should be deep enough to remove ad hoc string handling from later
slices, but shallow enough to avoid owning transport, persistence, or UI
rendering.

It should cover:

- server phase ids used by the route/orchestrator/completion path
- browser phase ids used by `src/lib/services/streaming.ts`
- user-visible activity ids that already exist in response activity parts
- pure helpers for:
  - recording elapsed marks once
  - recording duration marks once
  - normalizing finite non-negative durations
  - formatting `Server-Timing`
  - parsing `Server-Timing` into a typed record for browser correlation
  - producing a serializable terminal timeline payload

### Acceptance criteria

- [ ] One module owns the canonical names for server timeline marks, browser
  timing marks, and response activity ids used by Candidate 5.
- [ ] The module exports serializable types that can be used by both server and
  browser code without importing SvelteKit, AI SDK, DB, or server-only modules.
- [ ] `Server-Timing` formatting preserves the current header shape for existing
  route phase timings.
- [ ] `Server-Timing` parsing ignores invalid values and keeps finite
  non-negative durations.
- [ ] Pure tests cover duplicate marks, elapsed marks, duration marks,
  formatting, parsing, and terminal payload serialization.
- [ ] No runtime behavior changes outside the new module and its tests.

### Technical notes

- Primary file scope:
  - optional new file: `src/lib/services/stream-timeline.ts`
  - optional new test: `src/lib/services/stream-timeline.test.ts`
- Do not touch:
  - `src/lib/server/services/chat-turn/stream-orchestrator.ts`
  - `src/lib/server/services/chat-turn/stream-completion.ts`
  - `src/lib/services/streaming.ts`
  - UI components
- Keep the module independent of provider/model execution.

### Verification

- `npx vitest run src/lib/services/stream-timeline.test.ts`

## C5-02: Route server stream marks and terminal metadata through the timeline

**Type:** AFK
**Blocked by:** C5-01

### What to build

Adopt the shared timeline module in the server stream path. The orchestrator
should record server marks through the timeline interface, response activity
should use the canonical ids, and terminal stream metadata should include the
final server timeline in a structured field.

This issue must preserve the existing AI SDK UI stream contract:

- keep `data-response-activity` as the activity part
- keep `data-stream-metadata` as the terminal metadata part
- keep `finish` and `[DONE]` terminal behavior
- keep `Server-Timing` header behavior for route-level timings

### Acceptance criteria

- [ ] `src/lib/server/services/chat-turn/stream.ts` delegates
  `Server-Timing` formatting to the shared timeline module.
- [ ] `src/lib/server/services/chat-turn/stream-orchestrator.ts` no longer owns
  local ad hoc phase timing helper logic.
- [ ] Server marks include route phase timings, prelude, model stream request,
  first upstream event, first thinking, first visible token, and end.
- [ ] Terminal `data-stream-metadata` includes a structured server timeline
  payload without changing the existing fields consumed by the browser.
- [ ] Response activity ids for depth, context preparing, context ready,
  drafting, and fallback use canonical constants or helper functions.
- [ ] Existing reconnect buffer behavior for response activity remains
  unchanged.
- [ ] Focused tests prove no new UI stream event types are emitted.
- [ ] Focused tests prove terminal metadata carries the server timeline on
  success, stopped, and stream-closed-without-finish paths.

### Technical notes

- Primary file scope:
  - `src/lib/server/services/chat-turn/stream.ts`
  - `src/lib/server/services/chat-turn/stream-orchestrator.ts`
  - `src/lib/server/services/chat-turn/stream-completion.ts`
  - `src/lib/server/services/chat-turn/stream-orchestrator.test.ts`
  - `src/lib/server/services/chat-turn/stream-completion.test.ts`
  - `src/lib/server/services/chat-turn/stream-runtime.test.ts` if the shared
    contract tests need metadata coverage
- Avoid touching:
  - provider/model adapter files
  - browser stream transport files
  - chat UI files
  - file-production internals

### Verification

- `npx vitest run src/lib/server/services/chat-turn/stream-orchestrator.test.ts src/lib/server/services/chat-turn/stream-completion.test.ts src/lib/server/services/chat-turn/stream-runtime.test.ts`

## C5-03: Correlate browser timing with server timeline metadata

**Type:** AFK
**Blocked by:** C5-01, C5-02

### What to build

Update the browser stream transport to use the shared stream timeline vocabulary
and correlate browser-observed timings with:

- the `Server-Timing` response header
- the terminal server timeline metadata emitted by C5-02
- existing response activity, token, thinking, tool, finish, stop, and error
events

The result should remain opt-in through the existing `onTiming` callback. Token
parsing, thinking extraction, replay, waiting, stop, and detach behavior must
not change.

### Acceptance criteria

- [ ] `StreamTimingSnapshot` includes parsed server timing and terminal server
  timeline fields while preserving existing callback consumers.
- [ ] Browser timing marks use shared constants/helpers instead of local ad hoc
  strings.
- [ ] The browser records first response activity timing when a
  `data-response-activity` part arrives.
- [ ] The browser reports one timing snapshot per stream outcome: success,
  error, stopped, or closed.
- [ ] `onTiming` remains optional and does not log by default.
- [ ] Reconnect replay and waiting paths do not duplicate timing callbacks or
  mark passive detach as a user stop.
- [ ] Focused tests cover header parsing, terminal metadata correlation, first
  activity timing, success, error, stopped, and no-body/error responses.

### Technical notes

- Primary file scope:
  - `src/lib/services/streaming.ts`
  - `src/lib/services/streaming.test.ts`
  - shared timeline tests if additional parsing cases are needed
- Avoid touching:
  - Svelte components
  - server orchestrator/completion after C5-02 unless the metadata shape needs a
    small compatible adjustment
  - provider/model files

### Verification

- `npx vitest run src/lib/services/streaming.test.ts src/lib/services/stream-timeline.test.ts`

## C5-04: Surface early activity in the client runtime and chat UI

**Type:** AFK
**Blocked by:** C5-02, C5-03

### What to build

Make the client runtime and chat UI use the improved activity/timing interface
without exposing internal diagnostic details to users.

The goal is to reduce the generic feel of "preparing response" by showing the
most relevant early activity label when the assistant has not yet emitted
visible content, while preserving the existing deliberation-specialized UI.

This slice should also let the client runtime receive timing snapshots through a
typed adapter hook so app-level diagnostics can observe the correlated timing
object when configured.

### Acceptance criteria

- [ ] `normal-chat-client-turn-runtime.ts` wires `onTiming` through an optional
  adapter hook without making timing required for existing tests/adapters.
- [ ] The chat page adapter can receive stream timing snapshots without
  persisting them as assistant-message content.
- [ ] `MessageBubble.svelte` shows a localized activity label for known early
  activity states such as context preparation and drafting when there is no
  visible assistant content yet.
- [ ] Deliberation labels keep their current specialized rendering and priority.
- [ ] The generic localized preparing text remains as a fallback.
- [ ] English and Hungarian i18n strings are updated for any new user-visible
  labels.
- [ ] Tests cover response activity merge/update behavior, runtime timing
  callback wiring, generic preparing fallback, context-preparing label, and
  drafting label.
- [ ] No diagnostic phase names or millisecond timings are shown in the chat UI.

### Technical notes

- Primary file scope:
  - `src/lib/client/normal-chat-client-turn-runtime.ts`
  - `src/lib/client/normal-chat-client-turn-runtime.test.ts`
  - `src/routes/(app)/chat/[conversationId]/+page.svelte`
  - `src/routes/(app)/chat/[conversationId]/_helpers.ts` only if helper types
    need adjustment
  - `src/routes/(app)/chat/[conversationId]/_helpers.test.ts` if helper behavior
    changes
  - `src/lib/components/chat/MessageBubble.svelte`
  - `src/lib/components/chat/MessageBubble.test.ts`
  - `src/lib/i18n/chat.ts`
- Avoid touching:
  - stream frame encoding/decoding
  - server completion persistence
  - provider/model files
- Use Svelte 5 callback-prop and event-attribute rules in touched components.

### Verification

- `npx vitest run src/lib/client/normal-chat-client-turn-runtime.test.ts src/routes/(app)/chat/[conversationId]/_helpers.test.ts src/lib/components/chat/MessageBubble.test.ts`

## C5-05: Full review, gates, commit, and main push

**Type:** HITL
**Blocked by:** C5-01, C5-02, C5-03, C5-04

### What to build

Run a full review phase after worker patches are integrated. This wave is owned
by the orchestrator as reviewer/verifier, with substantial fixes delegated to
workers.

### Acceptance criteria

- [ ] Review every worker diff for:
  - route thinness
  - stream lifecycle ownership
  - AI SDK UI stream contract stability
  - terminal metadata ownership in stream completion
  - browser stream transport ownership
  - passive detach vs explicit stop preservation
  - no provider adapter behavior changes
  - no unrelated refactors or formatting churn
- [ ] Run focused tests:
  - `npx vitest run src/lib/services/stream-timeline.test.ts src/lib/server/services/chat-turn/stream-orchestrator.test.ts src/lib/server/services/chat-turn/stream-completion.test.ts src/lib/server/services/chat-turn/stream-runtime.test.ts src/lib/services/streaming.test.ts src/lib/client/normal-chat-client-turn-runtime.test.ts src/routes/(app)/chat/[conversationId]/_helpers.test.ts src/lib/components/chat/MessageBubble.test.ts`
- [ ] Run repo gates:
  - `git diff --check`
  - `npm run check`
  - `npm run lint`
  - `npm test`
  - `npm run build`
  - `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`
- [ ] Run targeted Playwright chat streaming coverage:
  - `npx playwright test tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts`
- [ ] If any gate fails, assign the smallest responsible follow-up to a worker
  and rerun the relevant checks after integration.
- [ ] Commit the accepted Candidate 5 implementation.
- [ ] Push to `main`.

### Orchestrator notes

- If dependencies are missing and a gate cannot run, report the exact failure
  and do not claim the gate passed.
- If Fallow needs network because the package is unavailable locally, do not use
  unsafe unfrozen network execution. Report the blocked Fallow gate and the
  reason.
- Do not mark Candidate 5 finished until all required repo gates have passed or
  the user explicitly changes the finish criteria.
