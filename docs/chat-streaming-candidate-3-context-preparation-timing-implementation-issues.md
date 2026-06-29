# Chat Streaming Candidate 3 Context Preparation Timing Implementation Issues

This is the local `$to-issues` implementation backlog for Candidate 3 from
`docs/architecture/chat-streaming-performance-report.html`:

- Candidate 3: Context Preparation Stage Module With Timing Leverage

External GitHub issue creation was not permitted for this orchestration run:
the connector rejected publishing as an external publishing risk. This local
markdown file is therefore the authoritative tracker artifact for Candidate 3;
no GitHub issues were created for these slices.

## Goal

Make Normal Chat's pre-stream and early-stream "Preparing response" interval
observable at the context-preparation stage level without leaking raw diagnostic
details into user-facing chat copy.

Candidate 3 should deepen the existing staged context-preparation module so it
can answer three questions during and after a slow turn:

- which preparation stage is currently active, in a sanitized user-visible class
- how long each raw stage took, in server timing diagnostics and focused tests
- which stable stage classes are slow enough to deserve future local budgets

This candidate does not change Context Selection authority, model-provider
transport, AI SDK UI stream framing, or durable turn completion semantics.

## Evidence And Constraints

- `AGENTS.md`: routes are adapters; Normal Chat prompt assembly belongs in
  `src/lib/server/services/normal-chat-context.ts`; stream transport framing
  and parsing belong in existing stream modules.
- `src/lib/server/services/AGENTS.md`: `normal-chat-context.ts` owns Normal
  Chat prompt assembly and the current debug prefix for preparation is
  `[NORMAL_CHAT_CONTEXT]`.
- `src/lib/server/services/chat-turn/AGENTS.md`: `stream-orchestrator.ts` owns
  live stream lifecycle and timing; `stream-completion.ts` owns terminal
  metadata; `stream.ts` plus `ai-sdk-ui-stream-contract.ts` own AI SDK UI frame
  grammar.
- `src/lib/components/AGENTS.md`: `MessageBubble.svelte` owns individual chat
  message rendering; route-level stream state stays above visual modules.
- Context7 SvelteKit docs, checked 2026-06-29: `+server.ts` handlers can return
  standard `Response` objects backed by `ReadableStream`; stream headers and
  request cancellation remain route/transport concerns.
- Context7 AI SDK docs, checked 2026-06-29: `streamText(...).fullStream`
  exposes text, reasoning, tool, finish, usage, error, and abort stream parts;
  app-specific activity data can remain outside provider token flow.
- Context7 Svelte 5 docs, checked 2026-06-29: simple derived UI state should use
  `$derived`; touched Svelte files should keep modern Svelte 5 patterns.
- Current code evidence:
  - `src/lib/server/services/normal-chat-context-preparation.ts` already
    defines typed stage ids, a default dependency plan, activity records, and a
    runner.
  - `prepareOutboundChatContext(...)` already uses the stage runner and accepts
    `onContextPreparationActivity`.
  - Streaming and plain Normal Chat model-run modules already forward typed
    context-preparation activity while mapping public response activity to a
    generic `context-preparing` row.
  - `src/lib/services/stream-timeline.ts` already owns server/browser timing
    vocabulary and terminal timeline normalization.
  - `src/lib/components/chat/MessageBubble.svelte` already maps generic context
    activity to localized "Preparing context..." without exposing diagnostic
    labels.

## Contract Decisions

- **Context Preparation Stage** is an internal implementation step inside the
  Normal Chat context-preparation module. Raw ids such as `prompt_budget` may be
  used in server timing diagnostics and focused tests.
- **Context Preparation Activity Class** is the sanitized public activity class
  emitted to the stream and used for localized chat copy. It must not expose raw
  stage ids, provider names, prompt text, user content, source text, or debug
  labels.
- **Context Preparation Timing** is a content-free duration record for a raw
  stage id. Timings may be attached to the existing server timeline terminal
  metadata, because that path already exists for diagnostics.
- Visible chat copy remains localized through `src/lib/i18n/chat.ts`; no raw
  stage id should appear in `MessageBubble.svelte` rendered text.
- Stage budgets in this candidate are diagnostic thresholds only. They may log
  or mark slow classes, but they must not fail user turns or skip preparation
  work.

## Orchestration Constraints

- The orchestrator does not write implementation code. Code-writing workers own
  their patches.
- Every code-writing worker must use `$tdd`, or explain why strict
  red-green-refactor was not feasible and still add the smallest useful
  regression check.
- Workers must not revert or overwrite concurrent edits.
- Workers must report changed paths, tests run, and any blockers.
- The review wave must pass all repo gates before Candidate 3 is called
  finished:
  - focused Vitest suites for changed preparation, stream, runtime, and chat UI
    surfaces
  - `git diff --check`
  - Fallow audit:
    `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`
  - `npm run check`
  - `npm run lint`
  - `npm test`
  - `npm run build`
  - final commit and push to `origin main`

## Summary

| ID | Title | Type | Blocked by | Suggested owner scope |
| --- | --- | --- | --- | --- |
| C3-00 | Record the context-preparation telemetry contract | Docs | None | ADR docs only |
| C3-01 | Add stage timing records to the context-preparation module | TDD | None | `normal-chat-context-preparation.*`, focused context tests |
| C3-02 | Propagate context-preparation timings into model-run and stream timeline seams | TDD | C3-01 | model-run adapters, stream orchestrator/completion timing tests |
| C3-03 | Project sanitized preparation activity classes into browser and chat UI | TDD | C3-01 | stream parser, runtime adapter, i18n, `MessageBubble` tests |
| C3-04 | Add diagnostic slow-stage budgets without changing turn behavior | TDD | C3-01 through C3-03 | preparation timing helpers and content-free logging tests |
| C3-05 | Full review, repo gates, commit, and main push | Review | C3-00 through C3-04 | orchestrator plus delegated review/fix agents |

## Parallelization Plan

Use bounded parallelism and disjoint write scopes:

1. Start **C3-00** and **C3-01** in parallel. The ADR and preparation module
   timing work do not overlap.
2. After C3-01 lands, run **C3-02** and **C3-03** in parallel only if their
   write scopes stay disjoint: C3-02 owns server/model-run timing propagation;
   C3-03 owns browser parser/runtime/UI projection.
3. Run **C3-04** after the telemetry path is integrated so diagnostic thresholds
   classify real emitted timing records instead of a parallel timing model.
4. Run **C3-05** last as a review wave. Candidate 3 is not finished until the
   review wave passes all repo gates, the final commit is created, and `main` is
   pushed.

## C3-00: Record the Context-Preparation Telemetry Contract

**Type:** Docs
**Blocked by:** None

### What to build

Add an ADR that records the distinction between raw context-preparation stage
ids, sanitized activity classes, and terminal timing diagnostics.

### Acceptance Criteria

- [ ] A new ADR under `docs/adr/` records the Context Preparation Stage,
      Context Preparation Activity Class, and Context Preparation Timing
      contracts.
- [ ] The ADR states that raw stage ids may appear in server timing diagnostics
      and focused tests, but not in visible chat copy.
- [ ] The ADR states that sanitized activity classes are localized in the chat
      UI and must remain content-free.
- [ ] The ADR states that diagnostic slow-stage budgets must not fail or skip a
      user turn.
- [ ] The ADR references ADR-0015, ADR-0019, ADR-0025, and the existing
      Conversation Detail read-model constraint when discussing stream metadata
      and post-turn projection.

### Technical Notes

- Primary file scope:
  - `docs/adr/0042-normal-chat-context-preparation-telemetry.md`
- Avoid editing implementation files.

### Verification

- Read the ADR against this issue's acceptance criteria.

## C3-01: Add Stage Timing Records To The Context-Preparation Module

**Type:** TDD
**Blocked by:** None

### What to build

Deepen `normal-chat-context-preparation.ts` so the stage runner records
content-free timings for every raw stage while preserving the existing activity
callback interface.

### Acceptance Criteria

- [ ] `runNormalChatContextPreparationStages(...)` returns a timing collection
      with raw stage id, sanitized activity class, started timestamp, completed
      timestamp, duration, and final status for each started stage.
- [ ] Timing records are produced for successful and failing stages.
- [ ] Timing records are deterministic in tests through an injectable clock or
      equivalent test seam; tests must not rely on wall-clock sleeps.
- [ ] Existing activity callback behavior remains compatible for plain and
      streaming model-run callers.
- [ ] The default preparation plan and dependency tests still prove the
      parallel-safe order.
- [ ] No route, stream framing, browser parser, provider, or persistence files
      change in this slice.

### Technical Notes

- Primary file scope:
  - `src/lib/server/services/normal-chat-context-preparation.ts`
  - `src/lib/server/services/normal-chat-context.test.ts`
- Suggested exported types:
  - `NormalChatContextPreparationActivityClass`
  - `NormalChatContextPreparationStageTiming`
- The sanitized class mapping should live next to the stage vocabulary for
  locality.

### Verification

- `npx vitest run src/lib/server/services/normal-chat-context.test.ts`

## C3-02: Propagate Context-Preparation Timings Into Model-Run And Stream Timeline Seams

**Type:** TDD
**Blocked by:** C3-01

### What to build

Carry the stage timing records from context preparation through the Normal Chat
model-run interfaces and into the existing stream timeline terminal metadata.

### Acceptance Criteria

- [ ] `prepareOutboundChatContext(...)` exposes context-preparation timing
      records without changing existing required return fields.
- [ ] Streaming and plain Normal Chat model-run modules can receive and expose
      those timing records without changing provider attempt behavior.
- [ ] `stream-orchestrator.ts` adds content-free context-preparation timing
      marks to the existing server timeline payload.
- [ ] `stream-completion.ts` continues to emit the existing
      `data-stream-metadata`, `finish`, and `[DONE]` terminal pattern.
- [ ] Browser `StreamTimingSnapshot` keeps receiving the existing terminal
      `serverTimeline` payload, now including context-preparation timing marks.
- [ ] Focused tests prove timing marks survive through the stream path without
      adding new AI SDK UI stream part names.

### Technical Notes

- Primary file scope:
  - `src/lib/server/services/normal-chat-context.ts`
  - `src/lib/server/services/chat-turn/streaming-normal-chat-model-run.ts`
  - `src/lib/server/services/chat-turn/plain-normal-chat-model-run.ts`
  - `src/lib/server/services/chat-turn/stream-orchestrator.ts`
  - `src/lib/services/stream-timeline.ts`
  - focused tests near those files
- Avoid changing:
  - provider transport under `src/lib/server/services/normal-chat-model/**`
  - route files
  - durable completion behavior beyond accepting the existing `serverTimeline`
    payload.

### Verification

- `npx vitest run src/lib/server/services/chat-turn/streaming-normal-chat-model-run.test.ts src/lib/server/services/chat-turn/plain-normal-chat-model-run.test.ts src/lib/server/services/chat-turn/stream-orchestrator.test.ts src/lib/services/stream-timeline.test.ts`

## C3-03: Project Sanitized Preparation Activity Classes Into Browser And Chat UI

**Type:** TDD
**Blocked by:** C3-01

### What to build

Use sanitized context-preparation activity classes to improve visible progress
while keeping raw stage ids and diagnostics out of rendered chat copy.

### Acceptance Criteria

- [ ] Response activity emitted for context preparation includes a sanitized
      class or equivalent content-free discriminator, not raw stage ids.
- [ ] `src/lib/services/streaming.ts` validates and forwards the sanitized
      context-preparation activity discriminator through `ResponseActivityEntry`
      without accepting arbitrary diagnostic payloads as visible labels.
- [ ] `normal-chat-client-turn-runtime.ts` continues to attach response activity
      to the active assistant placeholder.
- [ ] `MessageBubble.svelte` maps known sanitized preparation classes to
      localized status text and falls back to the existing "Preparing context..."
      copy for unknown classes.
- [ ] English and Hungarian translations are present in `src/lib/i18n/chat.ts`.
- [ ] Tests prove raw stage ids and arbitrary labels are not rendered in the
      preparation placeholder.

### Technical Notes

- Primary file scope:
  - `src/lib/types.ts`
  - `src/lib/services/streaming.ts`
  - `src/lib/client/normal-chat-client-turn-runtime.ts`
  - `src/lib/components/chat/MessageBubble.svelte`
  - `src/lib/i18n/chat.ts`
  - focused tests near those files
- Use Svelte 5 `$derived` for UI derivations in touched Svelte files.
- Do not introduce a new visible diagnostic panel or route-owned chat state.

### Verification

- `npx vitest run src/lib/services/streaming.test.ts src/lib/client/normal-chat-client-turn-runtime.test.ts src/lib/components/chat/MessageBubble.test.ts`

## C3-04: Add Diagnostic Slow-Stage Budgets Without Changing Turn Behavior

**Type:** TDD
**Blocked by:** C3-01 through C3-03

### What to build

Add content-free diagnostic thresholds for context-preparation timing classes so
future latency work can see stable outliers without changing user-turn behavior.

### Acceptance Criteria

- [ ] Slow-stage budgets are defined centrally beside the stage timing
      vocabulary or stream timeline helpers.
- [ ] Budget evaluation produces content-free diagnostics keyed by sanitized
      class and raw timing mark.
- [ ] Over-budget stages do not throw, skip work, abort streams, change provider
      behavior, or alter persisted messages.
- [ ] Logs use an existing prefix such as `[NORMAL_CHAT_CONTEXT]` or
      `[CHAT_STREAM]` and do not include prompt text, user message text, source
      text, API keys, or user ids.
- [ ] Tests prove over-budget and within-budget timing records are classified
      deterministically.

### Technical Notes

- Primary file scope:
  - `src/lib/server/services/normal-chat-context-preparation.ts`
  - `src/lib/services/stream-timeline.ts`
  - focused tests near those files
- Keep this diagnostic-only. Any performance shortcut or behavior-changing
  budget enforcement is a future candidate.

### Verification

- `npx vitest run src/lib/server/services/normal-chat-context.test.ts src/lib/services/stream-timeline.test.ts`

## C3-05: Full Review, Repo Gates, Commit, And Main Push

**Type:** Review
**Blocked by:** C3-00 through C3-04

### What to build

Run a dedicated review wave over the integrated Candidate 3 implementation,
delegate fixes for any issues found, then run all repo gates before committing
and pushing `main`.

### Acceptance Criteria

- [ ] At least one review agent inspects the integrated diff for contract,
      timing, UI, i18n, and test coverage risks.
- [ ] Any substantial review findings are assigned to a focused fix worker
      rather than patched directly by the orchestrator.
- [ ] Focused Vitest suites for all changed surfaces pass.
- [ ] `git diff --check` passes.
- [ ] Fallow passes:
      `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`
- [ ] `npm run check` passes with 0 errors and 0 warnings.
- [ ] `npm run lint` passes.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] The final diff is reviewed by the orchestrator.
- [ ] Changes are committed and pushed to `origin main`.

### Technical Notes

- The orchestrator may run verification commands and git commands.
- Git index/ref writes and network pushes require escalation.
- Do not mark Candidate 3 finished until every required gate has current
  passing evidence.
