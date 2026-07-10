# Chat Streaming Candidate 2 Stream Admission Implementation Issues

This is the local `$to-issues` implementation backlog for Candidate 2 from
`docs/architecture/chat-streaming-performance-report.html`:

- Candidate 2: Stream Admission Before Heavy Turn Preparation

No external issue tracker configuration was found in this workspace. Existing
project practice keeps implementation backlogs under `docs/*-implementation-issues.md`.

## Goal

Reduce the user-visible pre-stream "Preparing response" wait by returning the
Normal Chat stream after cheap stream admission, then running heavier turn
preparation after the SSE prelude is already open.

Candidate 2 specifically moves these stream-only wait sources out of the HTTP
response-start path:

- attachment readiness checks
- linked source persistence
- pending skill availability and session start
- Reasoning Depth metadata resolution
- skill prompt context resolution

Malformed requests, auth failures, unsupported Atlas stream starts, capacity
rejections, and conversation ownership/nonexistence remain HTTP-level failures
before stream admission.

## Evidence And Constraints

- `AGENTS.md`: route adapters stay thin; chat-turn request parsing, preflight,
  stream orchestration, AI SDK UI stream framing, and completion remain in
  existing modules.
- `src/lib/server/services/chat-turn/AGENTS.md`: `stream-orchestrator.ts` owns
  the live streaming lifecycle and `stream.ts` owns AI SDK UI stream framing.
- Context7 SvelteKit docs: `+server.ts` handlers return standard Web
  `Response` objects, including bodies backed by `ReadableStream`.
- Context7 AI SDK docs: `fullStream` includes text, reasoning, tool, finish,
  error, usage, and abort parts; server code may preserve the AI SDK UI stream
  contract while adapting app-specific data parts.
- Context7 Vitest docs: async tests should use `async`/`await`, mock modules
  with `vi.mock`/`vi.fn`, and can prove unresolved promises do not block a
  public interface.
- ADR-0015: durable Normal Chat Turn Completion belongs in chat-turn, not route
  sequencing.
- ADR-0019: browser-side send/retry/reconnect/wait/stop/queue transitions stay
  above the browser stream transport in `normal-chat-client-turn-runtime.ts`.
- ADR-0025: AI SDK UI stream framing is the current browser stream contract.

## Contract Decisions

- **Stream Admission** is the cheap server-side decision that a parsed,
  authenticated Normal Chat stream request may open a browser stream for this
  user and conversation.
- **Turn Preparation** is the heavier chat-turn work that makes the admitted
  request ready for a Normal Chat Model Run: attachments, linked sources,
  skills, Reasoning Depth, and prompt appendix inputs.
- Stream Admission must validate conversation ownership/nonexistence before
  returning a stream. Returning a stream for an unauthorized or missing
  conversation is out of scope.
- Turn Preparation failures after admission become AI SDK UI stream error
  frames, not JSON HTTP responses.
- No new AI SDK UI stream part names are introduced casually. If a structured
  request error must be sent after admission, it uses the existing
  `data-stream-error`, `finish`, and `[DONE]` terminal pattern.
- Send and retry may keep eager full preflight behavior unless a shared helper
  signature requires a mechanical adaptation.

## Orchestration Constraints

- The orchestrator does not write implementation code. Code-writing workers own
  their patches.
- Every code-writing worker must use `$tdd`, or explain why a strict
  red-green-refactor loop was not feasible and still add the smallest useful
  regression check.
- Workers must not revert or overwrite concurrent edits.
- Workers must report changed paths, tests run, and any blockers.
- Git operations that write refs or push require orchestrator escalation.
- Candidate 2 is not finished until the review wave passes the full repo gates:
  - focused Vitest suites for changed stream/preflight surfaces
  - `git diff --check`
  - `npm run check`
  - Fallow audit:
    `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`
  - broader unit coverage when focused checks pass
  - final commit and push to `origin main`

## Summary

| ID | Title | Type | Blocked by | Suggested owner scope |
| --- | --- | --- | --- | --- |
| C2-00 | Record the Stream Admission ADR | Docs | None | ADR docs only |
| C2-01 | Split Stream Admission from Turn Preparation | TDD | None | `chat-turn/preflight.*`, shared chat-turn types |
| C2-02 | Open the stream after admission and prepare inside the stream | TDD | C2-01 | stream route, orchestrator admission/preparation plumbing |
| C2-03 | Preserve request-preparation errors as stream terminal frames | TDD | C2-01, C2-02 | stream framing, orchestrator failure path, browser transport tests if needed |
| C2-04 | Prove first-byte, activity, and timing semantics | TDD | C2-02, C2-03 | focused stream route/orchestrator/timeline tests |
| C2-05 | Full review, gates, commit, and push | HITL | C2-00 through C2-04 | orchestrator review and verification wave |

## Parallelization Plan

Run this Candidate 2 batch with bounded parallelism:

1. Start **C2-00** and **C2-01** in parallel. They have disjoint write scopes.
2. After C2-01 lands, run **C2-02**. It owns the route and orchestrator
   sequencing change and should avoid changing error payload shape.
3. After C2-02 lands, run **C2-03**. It owns request-preparation error framing
   and any browser transport coverage needed for those frames.
4. Run **C2-04** after C2-02 and C2-03 are integrated. This slice proves the
   combined user-visible latency contract and timing metadata.
5. Run **C2-05** last as a review wave. Candidate 2 is not finished until this
   wave passes the repo gates and the implementation is pushed to `main`.

## C2-00: Record the Stream Admission ADR

**Type:** Docs
**Blocked by:** None

### What to build

Add an ADR that records the Stream Admission vs Turn Preparation contract and
the error-timing tradeoff for Normal Chat streaming.

### Acceptance Criteria

- [ ] A new ADR under `docs/adr/` states that Normal Chat streaming may return
      a browser stream after Stream Admission and run heavier Turn Preparation
      inside that stream.
- [ ] The ADR says auth, parse, Atlas stream rejection, capacity, and
      conversation ownership/nonexistence remain HTTP-level failures.
- [ ] The ADR says admitted Turn Preparation failures are sent as AI SDK UI
      stream terminal error frames.
- [ ] The ADR references ADR-0015, ADR-0019, and ADR-0025.
- [ ] No `CONTEXT.md` glossary changes are made unless a product-domain term is
      introduced. Stream Admission and Turn Preparation are implementation
      contract terms, not user-facing product language.

### Technical Notes

- Primary file scope:
  - `docs/adr/0041-stream-admission-before-turn-preparation.md`
- Avoid editing implementation files.

### Verification

- Read the ADR against this issue's acceptance criteria.

## C2-01: Split Stream Admission from Turn Preparation

**Type:** TDD
**Blocked by:** None

### What to build

Deepen `chat-turn/preflight.ts` so stream callers can perform cheap Stream
Admission before heavy Turn Preparation, while existing eager preflight callers
continue to receive the same `PreflightedChatTurn` behavior.

### Acceptance Criteria

- [ ] A new chat-turn interface admits a parsed stream request by validating
      conversation ownership/nonexistence and returning an admitted turn value.
- [ ] Stream Admission does not call attachment readiness, linked-source,
      pending-skill, skill prompt, skill session, Reasoning Depth, or message
      history dependencies.
- [ ] A new Turn Preparation interface accepts the admitted turn and returns the
      same successful `PreflightedChatTurn` shape produced today by
      `preflightChatTurn(...)`.
- [ ] `preflightChatTurn(...)` remains available for send and retry and
      delegates through the same shared implementation so eager callers keep
      current behavior.
- [ ] `preflightAtlasTurnSources(...)` behavior is unchanged.
- [ ] Focused tests prove admission success, admission conversation failure,
      admission skips heavy dependencies, and eager preflight still resolves
      Reasoning Depth and skill prompt context.

### Technical Notes

- Primary file scope:
  - `src/lib/server/services/chat-turn/preflight.ts`
  - `src/lib/server/services/chat-turn/preflight.test.ts`
  - `src/lib/server/services/chat-turn/types.ts`
- Suggested names are `admitChatTurnStream(...)`,
  `prepareAdmittedChatTurn(...)`, and `AdmittedChatTurn`, but workers should
  use the names that best fit existing local style.
- Avoid touching:
  - `src/routes/api/chat/stream/+server.ts`
  - `src/lib/server/services/chat-turn/stream-orchestrator.ts`
  - `src/lib/services/streaming.ts`

### Verification

- `npx vitest run src/lib/server/services/chat-turn/preflight.test.ts`

## C2-02: Open the Stream After Admission and Prepare Inside the Stream

**Type:** TDD
**Blocked by:** C2-01

### What to build

Change the stream route so it awaits only parse, Atlas stream rejection,
capacity, and Stream Admission before returning the streamed `Response`.
Move full Turn Preparation into the stream lifecycle so the SSE prelude is
emitted before attachment/source/skill/depth work starts waiting.

### Acceptance Criteria

- [ ] `src/routes/api/chat/stream/+server.ts` no longer awaits full
      `preflightChatTurn(...)` on the initial stream path.
- [ ] The route still returns JSON HTTP errors for auth, parse,
      unsupported Atlas stream starts, capacity, and conversation admission
      failures.
- [ ] The route passes an admitted turn into `runChatStreamOrchestrator(...)`
      without building the skill prompt appendix in the route.
- [ ] The orchestrator emits the SSE prelude before awaiting Turn Preparation.
- [ ] The orchestrator emits a context/preparation response activity before or
      at the start of Turn Preparation so the browser has visible progress
      during real server work.
- [ ] Skill prompt appendix construction happens after Turn Preparation in
      chat-turn/orchestrator code, not in the route adapter.
- [ ] Depth activity is not emitted with stale or guessed metadata. If depth is
      unavailable at prelude time, emit it after Turn Preparation succeeds.
- [ ] Focused tests prove the route delegates without awaiting heavy
      preparation and that the first stream chunk can be read before a deferred
      preparation promise resolves.
- [ ] Reconnect behavior remains compatible with active stream replay.

### Technical Notes

- Primary file scope:
  - `src/routes/api/chat/stream/+server.ts`
  - `src/routes/api/chat/stream/stream.test.ts`
  - `src/lib/server/services/chat-turn/stream-orchestrator.ts`
  - `src/lib/server/services/chat-turn/stream-orchestrator.test.ts`
- Coordinate naming with C2-01.
- Avoid touching:
  - durable completion in `finalize.ts` or `stream-completion.ts`
  - provider/model attempt policy under `normal-chat-model/`
  - browser runtime/UI files

### Verification

- `npx vitest run src/routes/api/chat/stream/stream.test.ts src/lib/server/services/chat-turn/stream-orchestrator.test.ts`

## C2-03: Preserve Request-Preparation Errors as Stream Terminal Frames

**Type:** TDD
**Blocked by:** C2-01, C2-02

### What to build

When Turn Preparation fails after Stream Admission, terminate the already-open
AI SDK UI stream with structured stream error frames that the existing browser
transport can consume.

### Acceptance Criteria

- [ ] Turn Preparation failures after admission emit `data-stream-error`,
      `finish` with `finishReason: "error"`, and `[DONE]`.
- [ ] The `data-stream-error` payload preserves request-error fields that the
      browser can use today: message/error text, `code`, and `attachmentIds`
      when present.
- [ ] Attachment readiness failures, linked-source failures, pending-skill
      failures, skill-session conflicts, and Reasoning Depth preparation
      failures do not invoke the model run after failing.
- [ ] Browser transport behavior remains stable: `streamChat(...)` calls
      `onError` for the stream error and does not require new wire part names.
- [ ] Existing provider/model stream failures continue to use the current
      friendly stream error classification.

### Technical Notes

- Primary file scope:
  - `src/lib/server/services/chat-turn/stream.ts`
  - `src/lib/server/services/chat-turn/stream-orchestrator.ts`
  - `src/lib/server/services/chat-turn/stream-orchestrator.test.ts`
  - `src/lib/services/streaming.test.ts` only if browser coverage is needed
- A small helper for `ChatTurnRequestError` to existing stream terminal frames
  is acceptable; do not add a new AI SDK UI stream part type.
- Avoid changing JSON error shapes for pre-admission route failures.

### Verification

- `npx vitest run src/lib/server/services/chat-turn/stream-orchestrator.test.ts src/lib/services/streaming.test.ts`

## C2-04: Prove First-Byte, Activity, and Timing Semantics

**Type:** TDD
**Blocked by:** C2-02, C2-03

### What to build

Add integrated regression coverage that proves Candidate 2's performance
contract and keeps timing diagnostics honest.

### Acceptance Criteria

- [ ] A slow Turn Preparation promise does not delay response headers or the
      first SSE prelude chunk.
- [ ] The browser can receive a response activity part while Turn Preparation is
      still pending.
- [ ] Server timing metadata distinguishes route parse, capacity, admission,
      prelude, stream-time preparation, model stream request, first upstream
      event, first visible token, and end.
- [ ] Timing remains diagnostic-only; no timing events are emitted as new UI
      stream parts.
- [ ] Stop, passive disconnect, and reconnect tests still pass.

### Technical Notes

- Primary file scope:
  - `src/lib/services/stream-timeline.ts`
  - `src/routes/api/chat/stream/stream.test.ts`
  - `src/lib/server/services/chat-turn/stream-orchestrator.test.ts`
  - `src/lib/server/services/chat-turn/stream-reconnect.test.ts` only if
    timing or replay behavior is touched
- If new timing mark names are added, keep them stable and update terminal
  metadata tests with exact expectations.
- Avoid client UI changes.

### Verification

- `npx vitest run src/routes/api/chat/stream/stream.test.ts src/lib/server/services/chat-turn/stream-orchestrator.test.ts src/lib/server/services/chat-turn/stream-reconnect.test.ts`

## C2-05: Full Review, Gates, Commit, and Push

**Type:** HITL
**Blocked by:** C2-00, C2-01, C2-02, C2-03, C2-04

### What to build

Run a full review phase after worker patches are integrated. This wave is owned
by the orchestrator as reviewer/verifier, with fix follow-ups delegated to
workers when issues are found.

### Acceptance Criteria

- [ ] Review every worker diff for:
      route thinness, chat-turn ownership, stream framing ownership,
      AI SDK UI stream contract stability, stop/reconnect compatibility,
      send/retry compatibility, and unrelated churn.
- [ ] Confirm pre-admission failures remain JSON HTTP responses.
- [ ] Confirm post-admission Turn Preparation failures are terminal stream
      errors.
- [ ] Confirm the SSE prelude and response activity are no longer blocked by
      attachment/source/skill/depth work.
- [ ] Run focused tests:
      `npx vitest run src/lib/server/services/chat-turn/preflight.test.ts src/routes/api/chat/stream/stream.test.ts src/lib/server/services/chat-turn/stream-orchestrator.test.ts src/lib/server/services/chat-turn/stream-reconnect.test.ts src/lib/services/streaming.test.ts`
- [ ] Run `git diff --check`.
- [ ] Run `npm run check` and keep it at 0 errors and 0 warnings, or report
      exact pre-existing unrelated diagnostics.
- [ ] Run Fallow:
      `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`
      and confirm no new findings beyond documented debt.
- [ ] Run broader `npm run test:unit` after focused checks and typecheck pass.
- [ ] Commit the accepted Candidate 2 implementation.
- [ ] Push to `origin main`.

### Orchestrator Notes

- If verification fails, assign the failure to the smallest responsible worker
  scope rather than patching implementation code directly.
- If dependencies are missing or Fallow cannot execute locally, report the exact
  gate failure and do not claim the gate passed.
- If the worktree contains unrelated user changes, preserve them and exclude
  them from the Candidate 2 commit unless the user explicitly asks otherwise.
