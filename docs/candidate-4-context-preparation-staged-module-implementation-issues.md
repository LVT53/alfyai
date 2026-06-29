# Candidate 4 Context Preparation Staged Module implementation issues

This is the local `$to-issues` implementation backlog for Candidate 4 from
`docs/chat-streaming-stability-deepening-report.html`.

The slices below are local issue drafts, not published tracker issues. No
external issue tracker configuration was found in this workspace, and existing
project practice keeps implementation backlogs under
`docs/*-implementation-issues.md`.

## Goal

Deepen Normal Chat context preparation into an internally staged module while
preserving the public `prepareOutboundChatContext(...)` interface and the
current Normal Chat behavior.

Candidate 4 should make the "preparing response" phase more stable and faster
by making the preparation stages explicit:

- context preparation plan
- base prompt and static guidance
- constructed Prompt Context
- automatic context compression decision
- forced web prefetch decision
- final outbound prompt budget
- typed stage activity/diagnostics

This candidate must not move Context Selection ownership out of
`src/lib/server/services/chat-turn/context-selection.ts`. Context Selection
still decides what becomes Prompt Context; Candidate 4 stages the orchestration
around that decision inside the Normal Chat context boundary.

## Evidence

- `AGENTS.md` says:
  - routes are adapters
  - `src/lib/server/services/normal-chat-context.ts` owns Normal Chat prompt
    assembly, always-on date-before-search guidance, and file-production
    guidance
  - `src/lib/server/services/chat-turn/context-selection.ts` owns constructed
    Prompt Context
  - `src/lib/server/services/normal-chat-model/` owns model execution after
    context is prepared
- `src/lib/server/services/chat-turn/AGENTS.md` says:
  - `normal-chat-context.ts -> context-selection.ts` is the constructed prompt
    context path
  - stream lifecycle and phase timing stay in `stream-orchestrator.ts`
  - stream terminal payload changes stay in `stream-completion.ts`
- `CONTEXT.md` defines:
  - **Normal Chat Turn** as the user request plus assistant response cycle,
    including Context Selection before the model call and Normal Chat Turn
    Completion after the response
  - **Normal Chat Model Run** as the model execution boundary after Context
    Selection and before completion
  - **Context Selection** as the process that chooses Prompt Context from
    Available Context
  - **Normal Chat Context Selection Boundary** as
    `src/lib/server/services/chat-turn/context-selection.ts`
  - **Context Selection Slice** as a test-driven, independently verifiable
    increment that changes one observable context-selection behavior
- Context7 Vitest docs, queried 2026-06-29, confirm current async test guidance:
  use awaited `resolves`/`rejects`, `vi.fn(...)` mocks, and fake timers where
  needed instead of wall-clock sleeps.
- Current code evidence:
  - `src/lib/server/services/normal-chat-context.ts` contains
    `prepareOutboundChatContext(...)`, which sequentially builds constructed
    context, logs attachment context, builds the enhanced base prompt, builds
    outbound system prompt, runs automatic compression, maybe rebuilds context
    after compression, forced-prefetches web research, maybe rebuilds the
    system prompt again, applies prompt budget, and returns the prepared result.
  - `src/lib/server/services/chat-turn/streaming-normal-chat-model-run.ts` and
    `plain-normal-chat-model-run.ts` call `prepareOutboundChatContext(...)`
    before model execution.
  - `src/lib/server/services/chat-turn/stream-orchestrator.ts` already emits
    `context-preparing` before `runStreamingNormalChatSendModel(...)` and
    `context-ready` after the prepared model run is returned.
  - Current main already includes prior Candidate 1, Candidate 2, Candidate 3,
    and Candidate 5 commits. Candidate 4 must not regress the stream intake
    fast path, provider adapter, provider fixture harness, or stream timeline
    vocabulary.

## Collision constraints

- Candidate 1 is already on main. Do not reintroduce completion-only work into
  the response-start path.
- Candidate 2 and Candidate 3 are already on main. Do not modify provider
  adapter behavior, provider fixture harnesses, provider failover policy, or
  OpenAI-compatible stream normalization.
- Candidate 5 is already on main. Do not fork the stream activity vocabulary.
  Reuse `src/lib/services/stream-timeline.ts` response activity ids when any
  public activity entry is emitted.
- Candidate 4 workers must not modify:
  - `src/lib/server/services/normal-chat-model/**`
  - provider fixture files under `tests/fixtures/ai/**`
  - stream terminal metadata in `stream-completion.ts`
  - browser stream parser behavior in `src/lib/services/streaming.ts`
- Keep route files thin and transport-oriented.
- Keep `prepareOutboundChatContext(...)` as the public preparation interface for
  existing plain and streaming Normal Chat model runs.
- Do not add user-facing diagnostic text for internal stages.
- Do not expose Context Trace in the normal chat UI.
- Do not weaken automatic compression failure handling, forced web prefetch
  grounding, date-before-search guidance, or file-production guidance.

## Orchestration constraints

- The orchestrator does not write implementation code. Code-writing workers own
  their patches.
- Every code-writing worker must use `$tdd`, or explain why strict
  red-green-refactor was not feasible and still add the smallest useful
  regression check.
- Workers must not revert or overwrite concurrent edits.
- Workers must report changed paths, tests run, and any blockers.
- The review wave must pass all repo gates before Candidate 4 is called
  finished:
  - focused Vitest suites for changed context/model-run surfaces
  - `git diff --check`
  - `npm run check`
  - `npm run lint`
  - `npm test`
  - `npm run build`
  - Fallow audit:
    `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`
  - targeted Playwright coverage for chat streaming if response activity,
    stream timing, or chat UI behavior changes:
    `npx playwright test tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts`

## Summary

| ID | Title | Type | Blocked by | Suggested owner scope |
| --- | --- | --- | --- | --- |
| C4-01 | Introduce context preparation stage plan and runner | AFK | None | `normal-chat-context` stage types/helpers and focused unit tests |
| C4-02 | Parallelize base prompt setup with constructed context | AFK | C4-01 | `normal-chat-context` stage runner and ordering tests |
| C4-03 | Isolate automatic compression as a staged decision | AFK | C4-01 | compression stage orchestration and regression tests |
| C4-04 | Isolate forced web prefetch and final budget stages | AFK | C4-01, C4-03 | web prefetch/budget stage orchestration and tests |
| C4-05 | Surface typed preparation activity through model-run seams | AFK | C4-01 through C4-04 | streaming/plain model-run adapters and activity tests |
| C4-06 | Full review, gates, commit, and main push | HITL | C4-01 through C4-05 | orchestrator review, delegated fixes, full verification, commit, push |

## Parallelization plan

Use bounded parallelism. Most implementation work touches
`normal-chat-context.ts`, so only one code-writing worker should own that file
at a time.

1. Start **C4-01** first. It defines the internal stage vocabulary and runner
   without behavior changes.
2. In parallel with C4-01, run read-only explorers for:
   - the safest activity seam between `prepareOutboundChatContext(...)`,
     `runStreamingNormalChatSendModel(...)`, and `stream-orchestrator.ts`
   - current automatic compression and forced web prefetch regression coverage
3. Run **C4-02** after C4-01 lands. This is the only performance slice: start
   base prompt/static setup independently from constructed-context work where
   the existing data dependencies allow it.
4. Run **C4-03** and **C4-04** sequentially because both reshape the central
   context preparation runner and share the same mutation state.
5. Run **C4-05** after the stage runner is stable. It should be a narrow seam
   integration, not a stream protocol rewrite.
6. Run **C4-06** last. Candidate 4 is not finished until this review wave
   passes the full repo gates and the final commit is pushed to `main`.

## C4-01: Introduce context preparation stage plan and runner

**Type:** AFK  
**Blocked by:** None - can start immediately

### What to build

Introduce an internal staged implementation for `prepareOutboundChatContext(...)`
without changing the returned `PreparedOutboundChatContext` shape.

The first slice should create typed stage vocabulary and a small runner/state
shape that can express:

- planned stage ids and dependency order
- stage start/done/error activity records
- intermediate preparation state
- final conversion into the existing `PreparedOutboundChatContext`

This slice should keep the current sequential behavior. The value is locality
and testability, not performance yet.

### Acceptance criteria

- [ ] `prepareOutboundChatContext(...)` still returns the same observable
  fields for existing no-context, constructed-context, attachment-trace,
  forced-web, and budgeted prompt cases.
- [ ] Stage ids are typed and stable. They must include at least:
  `plan`, `base_prompt`, `constructed_context`, `attachment_trace`,
  `system_prompt`, `automatic_compression`, `forced_web_prefetch`, and
  `prompt_budget`.
- [ ] The stage runner is internal to the Normal Chat context module or an
  adjacent module owned by `normal-chat-context.ts`; it must not become a new
  route or model-run responsibility.
- [ ] Tests prove the default stage order and that failures still follow the
  same public behavior for existing mocked dependencies.
- [ ] No stream activity, provider behavior, persistence, or browser parser
  behavior changes in this slice.

### Technical notes

- Primary file scope:
  - `src/lib/server/services/normal-chat-context.ts`
  - optional adjacent internal module:
    `src/lib/server/services/normal-chat-context-preparation.ts`
  - `src/lib/server/services/normal-chat-context.test.ts`
- Avoid touching:
  - `src/lib/server/services/chat-turn/stream-orchestrator.ts`
  - `src/lib/server/services/chat-turn/stream-completion.ts`
  - `src/lib/server/services/normal-chat-model/**`
  - browser stream files

### Verification

- `npx vitest run src/lib/server/services/normal-chat-context.test.ts`

## C4-02: Parallelize base prompt setup with constructed context

**Type:** AFK  
**Blocked by:** C4-01

### What to build

Use the stage runner to start independent preparation work as early as safely
possible.

The primary safe parallelism is:

- resolve context limits before waiting on constructed context
- start configured/enhanced base prompt setup independently from
  `buildConstructedContext(...)` when the base prompt does not depend on the
  constructed input

The outbound system prompt still depends on the current `inputValue`, so it
must continue to be built after constructed context is known and rebuilt after
compression or forced web prefetch changes the input.

### Acceptance criteria

- [ ] When user context is enabled, base prompt setup starts before
  `buildConstructedContext(...)` resolves.
- [ ] The final `systemPrompt` still reflects the post-compression and
  post-prefetch input value.
- [ ] `systemPromptOverride`, account profile fields, personality prompt,
  reasoning-depth effort, force-web guidance, GPT-OSS reasoning directives, and
  default runtime guidance remain behaviorally unchanged.
- [ ] Context limits are resolved once per call unless an explicit caller value
  is supplied.
- [ ] Tests prove non-blocking ordering with controlled promises rather than
  wall-clock sleeps.

### Technical notes

- Primary file scope:
  - `src/lib/server/services/normal-chat-context.ts`
  - `src/lib/server/services/normal-chat-context.test.ts`
  - optional C4-01 adjacent internal module if created
- Do not modify:
  - context selection ranking/budgeting in `chat-turn/context-selection.ts`
  - Normal Chat Model Run provider execution

### Verification

- `npx vitest run src/lib/server/services/normal-chat-context.test.ts`

## C4-03: Isolate automatic compression as a staged decision

**Type:** AFK  
**Blocked by:** C4-01

### What to build

Move automatic context compression orchestration into a clear stage that accepts
the already constructed input, base prompt, system prompt, context limits, and
context reuse data, then returns a typed decision/result.

The stage should make the current outcomes explicit:

- `not_possible`
- `not_needed`
- `failed`
- `succeeded`

It should preserve the current behavior where a valid compression snapshot
causes constructed context to be rebuilt through `buildConstructedContext(...)`
with reuse data, and the outbound system prompt is rebuilt with the compressed
input.

### Acceptance criteria

- [ ] Automatic compression still does not run when Honcho/context work is
  skipped.
- [ ] Missing user id or missing compression control sender still yields the
  current best-effort "not possible" behavior.
- [ ] A valid compression snapshot still replaces the prepared input and context
  metadata with rebuilt constructed context.
- [ ] Compression failures still warn and continue through the existing fallback
  path rather than aborting arbitrary turns.
- [ ] Prompt-budget diagnostics still include automatic compression outcome,
  attempt, and reason.
- [ ] Focused tests cover skip, not-needed, failed, and succeeded staged
  outcomes.

### Technical notes

- Primary file scope:
  - `src/lib/server/services/normal-chat-context.ts`
  - `src/lib/server/services/normal-chat-context.test.ts`
  - optional C4-01 adjacent internal module if created
- Read-only references:
  - `src/lib/server/services/context-compression.ts`
  - `src/lib/server/services/chat-turn/context-selection.ts`
- Do not change the context compression persistence module or schema.

### Verification

- `npx vitest run src/lib/server/services/normal-chat-context.test.ts`
- If compression persistence tests are touched:
  `npx vitest run src/lib/server/services/context-compression.test.ts`

## C4-04: Isolate forced web prefetch and final budget stages

**Type:** AFK  
**Blocked by:** C4-01, C4-03

### What to build

Move forced web prefetch and final outbound prompt budgeting into explicit
stages after automatic compression.

The prefetch stage should keep the current triggers:

- composer forced web search
- direct pasted HTTP URL in the current user message

The budget stage should remain the last transformation before returning the
prepared context.

### Acceptance criteria

- [ ] Forced web prefetch still inserts `## Current Web Research` before
  `## Current User Message`.
- [ ] Forced web prefetch still records a `research_web` prefetched tool call
  with grounded candidates, metadata, source type, and output summary.
- [ ] A prefetch failure still warns and continues without prefetched tool calls.
- [ ] The outbound system prompt is rebuilt after prefetch adds web context.
- [ ] Prompt budget enforcement remains the last input mutation and preserves
  current output token budget semantics.
- [ ] Tests cover forced search, pasted URL, prefetch failure, and budget-after-
  prefetch ordering.

### Technical notes

- Primary file scope:
  - `src/lib/server/services/normal-chat-context.ts`
  - `src/lib/server/services/normal-chat-context.test.ts`
  - optional C4-01 adjacent internal module if created
- Read-only references:
  - `src/lib/server/services/web-grounding.ts`
  - `src/lib/server/services/web-research.ts`
- Do not duplicate web grounding payload shaping outside `web-grounding.ts`.

### Verification

- `npx vitest run src/lib/server/services/normal-chat-context.test.ts`
- If web-grounding helpers are touched:
  `npx vitest run src/lib/server/services/web-grounding.test.ts`

## C4-05: Surface typed preparation activity through model-run seams

**Type:** AFK  
**Blocked by:** C4-01, C4-02, C4-03, C4-04

### What to build

Expose typed preparation activity from the staged context implementation through
the Normal Chat model-run call sites without changing the AI SDK UI stream
contract.

The default target is an optional callback on `prepareOutboundChatContext(...)`
or a returned diagnostic field consumed by:

- `src/lib/server/services/chat-turn/streaming-normal-chat-model-run.ts`
- `src/lib/server/services/chat-turn/plain-normal-chat-model-run.ts`

Streaming should reuse existing response activity ids from
`src/lib/services/stream-timeline.ts`. If more granular internal stage activity
is exposed, keep it diagnostic-only or folded into existing context activity so
the chat UI does not show internal implementation labels.

### Acceptance criteria

- [ ] Streaming model-run callers can observe context preparation stage activity
  without importing context-selection internals.
- [ ] Stream response activity continues to use existing AI SDK UI stream part
  names, especially `data-response-activity`.
- [ ] Existing `context-preparing`, `context-ready`, and `drafting-answer`
  activity behavior is preserved or made more accurate without duplicate visible
  rows.
- [ ] Plain send callers are not forced to emit stream-only activity, but can
  pass through diagnostics when an `onResponseActivity` callback is supplied.
- [ ] Tests prove activity callbacks fire in stage order and do not expose
  internal diagnostic labels as normal chat UI text.

### Technical notes

- Primary file scope:
  - `src/lib/server/services/normal-chat-context.ts`
  - optional C4-01 adjacent internal module if created
  - `src/lib/server/services/chat-turn/streaming-normal-chat-model-run.ts`
  - `src/lib/server/services/chat-turn/plain-normal-chat-model-run.ts`
  - focused tests for those model-run adapters
- Read-only references:
  - `src/lib/services/stream-timeline.ts`
  - `src/lib/server/services/chat-turn/stream-orchestrator.ts`
  - `src/lib/server/services/chat-turn/stream.ts`
- Avoid changing:
  - AI SDK UI stream frame grammar
  - browser stream parser logic
  - terminal stream metadata

### Verification

- `npx vitest run src/lib/server/services/normal-chat-context.test.ts`
- `npx vitest run src/lib/server/services/chat-turn/streaming-normal-chat-model-run.test.ts src/lib/server/services/chat-turn/plain-normal-chat-model-run.test.ts`
- If stream orchestrator activity behavior changes:
  `npx vitest run src/lib/server/services/chat-turn/stream-orchestrator.test.ts`

## C4-06: Full review, gates, commit, and main push

**Type:** HITL  
**Blocked by:** C4-01 through C4-05

### What to verify

Review the integrated Candidate 4 patch against the original goal, repo
instructions, and all prior candidate collision constraints.

### Acceptance criteria

- [ ] The final diff preserves the public `prepareOutboundChatContext(...)`
  interface or updates all internal call sites and tests intentionally.
- [ ] Context Selection remains owned by
  `src/lib/server/services/chat-turn/context-selection.ts`.
- [ ] Normal Chat Model Run remains the model execution boundary after context
  preparation.
- [ ] Initial "preparing response" latency is improved by removing avoidable
  sequential waiting in context preparation.
- [ ] Context compression, forced web prefetch, attachment tracing, prompt
  budgeting, and stage activity have focused tests.
- [ ] No provider adapter, stream fixture, browser parser, route, DB schema, or
  persistence ownership drift is introduced.
- [ ] Full repo gates pass:
  - `git diff --check`
  - `npm run check`
  - `npm run lint`
  - `npm test`
  - `npm run build`
  - `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`
- [ ] If stream/browser behavior changed, targeted Playwright checks pass:
  `npx playwright test tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts`
- [ ] Changes are committed on `main` and pushed to `origin/main`.

### Review focus

- Verify that every stage has a clear data dependency and no stage begins early
  by reading mutable state it does not own.
- Check that `buildOutboundSystemPrompt(...)` still sees the final input after
  compression and prefetch.
- Check that failed optional stages degrade exactly as before.
- Compare focused test assertions to actual behavior; reject tests that only
  assert implementation details without proving the public seam.
- Run Fallow and confirm no new dead exports or cycle debt are introduced.
