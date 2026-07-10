# Candidate 1 Stream Intake Fast Path implementation issues

This is the local implementation backlog for Candidate 1 from
`docs/chat-streaming-stability-deepening-report.html`.

The slices below are local issue drafts, not published tracker issues. No
external issue tracker is configured in this workspace, and existing project
practice keeps implementation backlogs under `docs/*-implementation-issues.md`.

## Goal

Make the Normal Chat streaming intake path return the streamed `Response` as
soon as request parsing, capacity, and preflight have succeeded. Completion-only
facts must not delay the first server stream bytes.

Candidate 1 specifically moves these facts out of the response-start path:

- **Memory Reset Generation** read currently performed by
  `src/routes/api/chat/stream/+server.ts` before returning the response.
- File-production job snapshot currently performed by
  `src/lib/server/services/chat-turn/stream-orchestrator.ts` before context
  preparation and model streaming.

## Evidence

- Context7 AI SDK docs confirm `streamText().fullStream` exposes structured
  stream parts and that server code may transform those parts into custom
  streams while preserving the UI stream contract.
- Context7 SvelteKit docs confirm `+server.ts` handlers return standard Web
  `Response` objects and the body may be a `ReadableStream`.
- `CONTEXT.md` defines **Memory Reset Generation** as the durable account-level
  reset guard. This work may delay the read, but must not weaken the guard.
- `AGENTS.md` keeps routes thin and places durable stream lifecycle behavior in
  `src/lib/server/services/chat-turn/`.
- Current code evidence:
  - `src/routes/api/chat/stream/+server.ts` awaits
    `getCurrentMemoryResetGeneration(user.id)` before calling
    `runChatStreamOrchestrator(...)`.
  - `src/lib/server/services/chat-turn/stream-orchestrator.ts` awaits
    `listConversationFileProductionJobs(user.id, conversationId)` after the SSE
    prelude but before provider/context work.
  - `src/lib/server/services/chat-turn/stream-completion.ts` already owns
    final generated-file and file-production job attachment.

## Collision constraints

- Candidate 3 is running in parallel and owns provider stream fixtures and
  OpenAI-compatible provider harness work.
- Candidate 1 workers must not modify:
  - `src/lib/server/services/normal-chat-model/**`
  - `tests/integration/openai-compatible-provider.test.ts`
  - `tests/integration/xiaomi-mimo-openai-compatible-provider.test.ts`
  - `tests/integration/mimo-reasoning-replay-provider.test.ts`
  - provider fixture files added by the Candidate 3 worker
- Candidate 1 may modify only stream intake/completion files and focused tests
  listed in the issue scopes below.
- Do not change AI SDK UI stream part names, browser parser expectations, or
  provider-attempt policy.
- Do not move post-turn persistence out of `chat-turn/finalize.ts` or
  `chat-turn/stream-completion.ts`.
- Do not make passive browser disconnects abort upstream generation.

## Orchestration constraints

- The orchestrator does not write implementation code. Code-writing workers own
  their patches.
- Every code-writing worker must use `$tdd`, or explain why a strict
  red-green-refactor loop was not feasible and still add the smallest useful
  regression check.
- Workers must not revert or overwrite concurrent edits.
- Workers must report changed paths, tests run, and any blockers.
- The review wave must pass the full repo gates before Candidate 1 is called
  finished:
  - focused Vitest suite for changed stream surfaces
  - `git diff --check`
  - `npm run check`
  - Fallow audit:
    `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`
  - broader unit coverage when focused checks pass

## Summary

| ID | Title | Type | Blocked by | Suggested owner scope |
| --- | --- | --- | --- | --- |
| C1-01 | Introduce lazy stream completion facts | AFK | None | Stream completion types/tests; no route/provider changes |
| C1-02 | Remove Memory Reset Generation from route response-start path | AFK | C1-01 | Stream route adapter, orchestrator option plumbing, route tests |
| C1-03 | Move file-production start snapshot to lazy completion facts | AFK | C1-01 | Orchestrator startup, stream completion integration, orchestrator/completion tests |
| C1-04 | Prove first-byte path and timing semantics | AFK | C1-02, C1-03 | Focused stream route/orchestrator tests and phase timing assertions |
| C1-05 | Full review, gates, and main push | HITL | C1-01 through C1-04 | Orchestrator review, full verification, commit, push |

## Parallelization plan

Run this Candidate 1 batch with bounded parallelism:

1. Start **C1-01** first. It defines the lazy completion facts interface and can
   stay inside stream completion tests.
2. After C1-01 is available, run **C1-02** and **C1-03** in parallel only if
   their workers keep to the assigned files:
   - C1-02 owns route adapter behavior and memory reset plumbing.
   - C1-03 owns file-production snapshot behavior and completion attachment.
3. Run **C1-04** after both C1-02 and C1-03 merge, because it validates their
   combined effect on timing and first-byte behavior.
4. Run **C1-05** last as a review wave. Candidate 1 is not finished until this
   wave passes the repo gates.

## C1-01: Introduce lazy stream completion facts

**Type:** AFK
**Blocked by:** None - can start immediately

### What to build

Add a small internal interface for completion-only facts needed by stream
completion. The interface should let callers provide eager values or lazy
promises for facts that are only required when `completeStreamTurn(...)` runs.

The initial facts are:

- `startedResetGeneration`
- `fileProductionJobIdsAtStart`

This issue should make the completion module able to resolve those facts at the
completion seam, without moving the route or orchestrator reads yet.

### Acceptance criteria

- [ ] `completeStreamTurn(...)` can accept a lazy Memory Reset Generation fact
  while preserving the existing `startedResetGeneration` semantics passed to
  persistence and memory maintenance.
- [ ] `completeStreamTurn(...)` can accept a lazy file-production start snapshot
  while preserving existing new-job attachment behavior.
- [ ] A failed lazy fact read degrades no worse than current behavior:
  - Memory Reset Generation failure should follow the existing stream failure
    path if completion cannot safely persist.
  - File-production snapshot failure should preserve current best-effort warning
    behavior and avoid attaching pre-existing jobs as new jobs.
- [ ] Existing eager call sites continue to compile until later issues migrate
  them.
- [ ] Focused tests cover eager facts, lazy facts, and rejected lazy
  file-production snapshot behavior.

### Technical notes

- Primary file scope:
  - `src/lib/server/services/chat-turn/stream-completion.ts`
  - `src/lib/server/services/chat-turn/stream-completion.test.ts`
- Avoid touching:
  - `src/routes/api/chat/stream/+server.ts`
  - `src/lib/server/services/chat-turn/stream-orchestrator.ts`
  - `src/lib/server/services/normal-chat-model/**`

### Verification

- `npx vitest run src/lib/server/services/chat-turn/stream-completion.test.ts`

## C1-02: Remove Memory Reset Generation from route response-start path

**Type:** AFK
**Blocked by:** C1-01

### What to build

Change the stream route so it no longer awaits Memory Reset Generation before
returning the streamed `Response`. Instead, construct a lazy fact immediately
after preflight and pass it into the orchestrator.

The stream route must still authenticate, parse, capacity-check, preflight, and
reject invalid/Atlas/capacity/preflight failures before returning a stream.

### Acceptance criteria

- [ ] `src/routes/api/chat/stream/+server.ts` no longer imports or awaits
  `getCurrentMemoryResetGeneration(...)`.
- [ ] The route still passes enough information for stream completion to use the
  correct started generation.
- [ ] Route tests prove `POST(...)` returns the orchestrator response without
  waiting for the Memory Reset Generation promise to resolve.
- [ ] Existing auth, parse, Atlas, capacity, reconnect, and preflight behavior
  remains unchanged.
- [ ] Retry route behavior is not changed in this issue unless required by the
  shared orchestrator type. If touched, it must preserve current retry tests.

### Technical notes

- Primary file scope:
  - `src/routes/api/chat/stream/+server.ts`
  - `src/routes/api/chat/stream/stream.test.ts`
  - `src/lib/server/services/chat-turn/stream-orchestrator.ts` only for option
    plumbing required by C1-01
- Avoid touching:
  - provider/model adapter files
  - browser stream parser files
  - file-production implementation internals

### Verification

- `npx vitest run src/routes/api/chat/stream/stream.test.ts`
- If orchestrator option plumbing is touched:
  `npx vitest run src/lib/server/services/chat-turn/stream-orchestrator.test.ts`

## C1-03: Move file-production start snapshot to lazy completion facts

**Type:** AFK
**Blocked by:** C1-01

### What to build

Remove the file-production job snapshot from the stream startup path and make it
a lazy completion fact. The snapshot may start early, but awaiting it must not
block prelude, response activity, context preparation, or provider model
request.

The existing completion behavior must remain: after a `produce_file` tool call,
new file-production jobs created during the turn are attached to the persisted
assistant message, while jobs that existed before the turn are not attached as
new.

### Acceptance criteria

- [ ] `stream-orchestrator.ts` no longer awaits
  `listConversationFileProductionJobs(...)` before context/model work.
- [ ] Existing new-job attachment tests still pass.
- [ ] New orchestrator or completion tests prove a slow file-production snapshot
  does not delay the first SSE prelude or response activity emission.
- [ ] Snapshot failure preserves current best-effort warning semantics and does
  not attach all current jobs as new jobs.
- [ ] File-production read paths remain behind the existing facade/read-model
  boundary and do not eagerly load worker/rendering/storage internals.

### Technical notes

- Primary file scope:
  - `src/lib/server/services/chat-turn/stream-orchestrator.ts`
  - `src/lib/server/services/chat-turn/stream-orchestrator.test.ts`
  - `src/lib/server/services/chat-turn/stream-completion.test.ts`
- Coordinate with C1-02 before editing shared orchestrator option names.
- Avoid touching:
  - `src/lib/server/services/file-production/job-ledger.ts`
  - `src/lib/server/services/file-production/worker-runner.ts`
  - `src/lib/server/services/file-production/execution-adapter.ts`
  - `src/lib/server/services/file-production/storage-adapter.ts`
  - `src/lib/server/services/normal-chat-model/**`

### Verification

- `npx vitest run src/lib/server/services/chat-turn/stream-orchestrator.test.ts src/lib/server/services/chat-turn/stream-completion.test.ts`

## C1-04: Prove first-byte path and timing semantics

**Type:** AFK
**Blocked by:** C1-02, C1-03

### What to build

Add focused regression coverage proving the fast path. This issue should not
introduce new runtime behavior unless it exposes a missing timing mark needed to
prove Candidate 1.

### Acceptance criteria

- [ ] Tests prove the stream route delegates without awaiting completion-only
  lazy facts.
- [ ] Tests prove the orchestrator emits the SSE prelude and depth activity
  before slow file-production snapshot resolution.
- [ ] Phase timing logs still include route parse, capacity, preflight, prelude,
  model stream request, first upstream event, first visible token, and end when
  diagnostics are enabled.
- [ ] No timing events are emitted to the browser as new UI stream parts.
- [ ] Existing reconnect and stop behavior remains unchanged.

### Technical notes

- Primary file scope:
  - `src/routes/api/chat/stream/stream.test.ts`
  - `src/lib/server/services/chat-turn/stream-orchestrator.test.ts`
  - optionally `src/lib/server/services/chat-turn/stream-completion.test.ts`
- Avoid adding a broad timing module. Candidate 5 owns timeline deepening.
- Avoid client UI work.

### Verification

- `npx vitest run src/routes/api/chat/stream/stream.test.ts src/lib/server/services/chat-turn/stream-orchestrator.test.ts src/lib/server/services/chat-turn/stream-reconnect.test.ts`

## C1-05: Full review, gates, and main push

**Type:** HITL
**Blocked by:** C1-01, C1-02, C1-03, C1-04

### What to build

Run a full review phase after worker patches are integrated. This wave is owned
by the orchestrator as reviewer/verifier, with fix follow-ups delegated to
workers when issues are found.

### Acceptance criteria

- [ ] Review every worker diff for:
  - route thinness
  - stream lifecycle ownership
  - completion persistence ownership
  - AI SDK UI stream contract stability
  - Candidate 3/provider-fixture non-collision
  - no unrelated refactors or formatting churn
- [ ] Run focused tests:
  - `npx vitest run src/routes/api/chat/stream/stream.test.ts src/lib/server/services/chat-turn/stream-orchestrator.test.ts src/lib/server/services/chat-turn/stream-completion.test.ts src/lib/server/services/chat-turn/stream-reconnect.test.ts`
- [ ] Run repo gates:
  - `git diff --check`
  - `npm run check`
  - `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`
- [ ] Run broader unit coverage if focused tests and typecheck pass:
  - `npm run test:unit`
- [ ] Commit the accepted Candidate 1 implementation.
- [ ] Push to `main`.

### Orchestrator notes

- If `npm run check` cannot run because dependencies are missing, report the
  exact failure and do not claim the gate passed.
- If Fallow needs network because the package is unavailable locally, do not use
  unsafe unfrozen network execution. Report the blocked Fallow gate and the
  exact reason.
- If Candidate 3 changes appear in the worktree, do not revert them. Review for
  collisions and preserve them.
