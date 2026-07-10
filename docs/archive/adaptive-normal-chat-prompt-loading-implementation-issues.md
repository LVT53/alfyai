# Adaptive Normal Chat Prompt Loading Implementation Issues

This is the local `$to-issues` implementation backlog for reducing Normal Chat
draft latency after the context-preparation fast path work. No external issue
tracker is configured for this run, so this markdown file is the tracker
artifact.

## Goal

Reduce the model prefill and first-token cost of ordinary Normal Chat turns
without disabling tools, removing safety guidance, or changing the app-owned
tool contracts.

The current live evidence shows that context preparation is now fast for simple
turns, while drafting still sends a large mostly-static prompt and all runtime
tool/search guidance even for one-sentence no-tool replies. The target is an
adaptive prompt-loading path: keep the same tool set available, but load bulky
instruction packs only when the current turn, active context, or explicit user
intent makes those packs relevant.

## Evidence And Constraints

- `AGENTS.md`: `src/lib/server/services/normal-chat-context.ts` owns Normal
  Chat prompt assembly, and `src/lib/server/services/normal-chat-model/` owns
  AI SDK/OpenAI-compatible model execution.
- `AGENTS.md`: app-backed tools stay in `src/lib/server/services/normal-chat-tools/`.
  Do not move tool execution, timeout, or recording policy into prompt assembly.
- `AGENTS.md`: do not scatter freshness-sensitive web guidance outside
  `normal-chat-context.ts`.
- `ADR-0042`: timing and prompt diagnostics must be content-free and must not
  become hidden behavior-changing policy outside the explicit prompt-loading
  contract.
- Context7 `/vercel/ai`, checked 2026-06-30: AI SDK `streamText` and
  `generateText` accept `tools`, `toolChoice`, `activeTools`, `toolOrder`, and
  provider-specific `providerOptions`.
- Context7 AI SDK docs, checked 2026-06-30: OpenAI provider options support a
  custom `providerOptions.openai.promptCacheKey`, and some providers support
  message-level cache controls through `providerOptions`.
- Current code evidence:
  - `buildOutboundSystemPrompt(...)` currently appends all default runtime
    guidance packs every turn: file production, image search, web research,
    query planning, cutoff-safe research, memory context, exact web facts,
    persona memory, source authority, and done-tool termination.
  - `normal-chat-tools/index.ts` already keeps top-level tool descriptions
    compact. The larger drafting cost is mostly guidance text plus provider
    tool schema prefill, not verbose tool descriptions alone.
  - Live benchmark directories under `/private/tmp/alfyai-live-chat-bench-*`
    preserve the first-attempt baseline for final comparison.

## Non-Negotiable Contract

- This work must not turn off tools for ordinary Normal Chat turns.
- This work must not globally remove current-date, web freshness, source
  citation, file-production, memory, or termination safety. It may make bulky
  sub-guidance conditional when a deterministic planner proves relevance.
- The model-facing tool names and schemas remain owned by
  `normal-chat-tools/`. Prompt packs may describe when and how to use tools, but
  tool execution behavior remains unchanged.
- There must be a conservative fallback to full guidance for unknown,
  ambiguous, high-stakes, forced-web, explicit-tool, or complex context cases.
- Prompt-loading metadata must be content-free: pack ids, counts, token
  estimates, and fallback reasons are allowed; raw prompt text, user text, tool
  output, source text, API keys, and user ids are not.

## Summary

| ID | Title | Type | Blocked by | Suggested owner scope |
| --- | --- | --- | --- | --- |
| APL-01 | Extract runtime guidance into named prompt packs | TDD | None | `normal-chat-context*` only |
| APL-02 | Add deterministic prompt-pack planning for current turns | TDD | APL-01 | prompt-pack planner and tests |
| APL-03 | Integrate adaptive prompt loading in send and stream paths | TDD | APL-01, APL-02 | context prep plus model-run adapter tests |
| APL-04 | Add provider prompt-cache keys and cache metadata mapping | TDD | None | `normal-chat-model/**` |
| APL-05 | Compress two-tier tool guidance without changing tool availability | TDD | APL-01, APL-02 | `normal-chat-context*`, tool contract tests |
| APL-06 | Benchmark, behavior sweep, review, deploy, and compare baselines | Verification | APL-03 through APL-05 | scripts, tests, remote deployment |

## Parallelization Plan

Use bounded parallelism and disjoint write scopes:

1. Start APL-01 and APL-04 in parallel. APL-01 owns prompt assembly structure;
   APL-04 owns provider options inside `normal-chat-model/`.
2. After APL-01 lands, implement APL-02 in the prompt-pack seam.
3. After APL-02 lands, implement APL-03 and APL-05. Keep APL-03 focused on
   integration/metadata and APL-05 focused on reducing duplicated or bulky
   guidance text.
4. Run APL-06 last. Live tests must include simple no-tool prompts plus prompts
   that non-obviously require web, file production, image search, generated-file
   reading, and memory context.

## APL-01: Extract Runtime Guidance Into Named Prompt Packs

**Type:** TDD
**Blocked by:** None

### What to build

Refactor the default runtime guidance blocks in `normal-chat-context.ts` into a
small named prompt-pack registry without changing default full-guidance output.

### Acceptance Criteria

- [ ] Each current guidance block has a stable pack id and short description
      suitable for content-free diagnostics.
- [ ] The existing full-guidance prompt path still includes all previous
      default guidance blocks.
- [ ] Tests prove full mode still includes critical strings for:
      `produce_file`, `read_generated_file`, `research_web`, `image_search`,
      `memory_context`, current-date search, source linking, and `done`.
- [ ] The registry exposes a token estimate per pack using the existing token
      estimator, but does not log raw pack text.
- [ ] `skipDefaultRuntimeGuidance` continues to produce no default runtime
      guidance for control-model callers.

### Technical Notes

- Primary file scope:
  - `src/lib/server/services/normal-chat-context.ts`
  - optional local helper near that file, for example
    `src/lib/server/services/normal-chat-guidance-packs.ts`
  - `src/lib/server/services/normal-chat-context.test.ts`
- Keep prompt assembly ownership under the existing Normal Chat context
  boundary. Do not create a route-local prompt helper.

### Verification

- `npx vitest run src/lib/server/services/normal-chat-context.test.ts`

## APL-02: Add Deterministic Prompt-Pack Planning For Current Turns

**Type:** TDD
**Blocked by:** APL-01

### What to build

Add a deterministic prompt-pack planner that selects required guidance packs
from the current user message, force-web flag, active document/attachment
signals, reasoning-depth effort, response language, and simple tool-intent
predicates.

### Acceptance Criteria

- [ ] Simple direct prompts such as "Ping!" or "Reply in one short sentence"
      select a compact pack set while keeping core time, language, JSON, and
      termination guidance.
- [ ] Explicit or implicit downloadable-file requests select file-production
      and generated-file-read guidance.
- [ ] Current/latest/recent/fact-check/source-backed/pasted-URL requests select
      web research, date-before-search, query planning, cutoff-safe research,
      exact facts, source linking, and source authority guidance.
- [ ] Image requests select image-search guidance.
- [ ] Project/history/preferences/previous notes/folder continuity requests
      select memory guidance.
- [ ] Ambiguous, high-stakes, forced-web, URL, active-document, attachment, or
      unknown tool-intent cases fall back to full or conservative guidance.
- [ ] Tests cover at least one non-obvious prompt for each tool class and prove
      that the planner returns pack ids, not raw prompt text.

### Technical Notes

- Primary file scope:
  - prompt-pack planner helper next to `normal-chat-context.ts`
  - `src/lib/server/services/normal-chat-context.test.ts`
- Reuse existing conservative tool-intent helpers where available, such as
  `isProduceFileRequest(...)` from `normal-chat-tools/produce-file.ts`.
- Planner predicates should be deterministic and cheap; do not add another model
  call before drafting.

### Verification

- `npx vitest run src/lib/server/services/normal-chat-context.test.ts`

## APL-03: Integrate Adaptive Prompt Loading In Send And Stream Paths

**Type:** TDD
**Blocked by:** APL-01, APL-02

### What to build

Wire prompt-pack selection into `prepareOutboundChatContext(...)` so streaming
and non-streaming Normal Chat share the same adaptive system prompt.

### Acceptance Criteria

- [ ] `prepareOutboundChatContext(...)` returns content-free prompt-loading
      metadata: mode, selected pack ids, fallback reason, estimated guidance
      tokens, and estimated savings versus full guidance.
- [ ] Streaming and plain Normal Chat model-run modules preserve the same
      prompt-loading metadata through their existing test seams.
- [ ] No new AI SDK UI stream part names are introduced casually. If metadata is
      surfaced, it uses existing terminal metadata/timeline structures.
- [ ] Tool availability is unchanged: tests prove the same `tools` object is
      passed to `runNormalChatModelStream`/`runNormalChatModelPlain` for
      ordinary adaptive turns.
- [ ] Full-guidance fallback can be forced by caller configuration or planner
      fallback and is covered by tests.

### Technical Notes

- Primary file scope:
  - `src/lib/server/services/normal-chat-context.ts`
  - `src/lib/server/services/chat-turn/streaming-normal-chat-model-run.ts`
  - `src/lib/server/services/chat-turn/plain-normal-chat-model-run.ts`
  - focused tests near those files
- Keep route files thin. Do not duplicate prompt-pack logic in
  `src/routes/api/chat/send` or `src/routes/api/chat/stream`.

### Verification

- `npx vitest run src/lib/server/services/normal-chat-context.test.ts src/lib/server/services/chat-turn/streaming-normal-chat-model-run.test.ts src/lib/server/services/chat-turn/plain-normal-chat-model-run.test.ts`

## APL-04: Add Provider Prompt-Cache Keys And Cache Metadata Mapping

**Type:** TDD
**Blocked by:** None

### What to build

Use AI SDK provider options to improve cache hit rates for stable Normal Chat
prompt prefixes where the active provider supports it, without changing retry
or failover ownership.

### Acceptance Criteria

- [ ] OpenAI-family provider attempts can receive a stable
      `providerOptions.openai.promptCacheKey` derived from provider id, model
      id/name, base prompt revision, and prompt-pack set, not user message text.
- [ ] Existing caller-supplied provider options are preserved and merged
      without losing failover-specific provider option resolution.
- [ ] Stream and plain model-run usage mapping records cached-prompt-token
      metadata when the provider exposes it.
- [ ] Tests prove provider options are applied only at the model-run boundary
      and are recomputed per fallback provider attempt.
- [ ] Providers without a known cache option continue unchanged.

### Technical Notes

- Primary file scope:
  - `src/lib/server/services/normal-chat-model/index.ts`
  - `src/lib/server/services/normal-chat-model/index.test.ts`
  - optional focused helper under `normal-chat-model/`
- Keep provider retry/failover policy inside `normal-chat-model/`.
- Do not include raw prompt text, user message text, source text, or user ids in
  cache keys.

### Verification

- `npx vitest run src/lib/server/services/normal-chat-model/index.test.ts`

## APL-05: Compress Two-Tier Tool Guidance Without Changing Tool Availability

**Type:** TDD
**Blocked by:** APL-01, APL-02

### What to build

Turn verbose always-on tool usage prose into compact core guidance plus
conditional second-tier packs for workflows that need detailed instructions.

### Acceptance Criteria

- [ ] Core guidance remains sufficient for ordinary tool calls and JSON
      validity.
- [ ] Detailed file-edit/patch guidance loads only for generated-file update or
      revision intents, while new-file requests still receive enough guidance to
      call `produce_file` correctly.
- [ ] Detailed web query planning and source-authority guidance loads for
      current/source-backed/high-stakes/commerce/technical prompts, while simple
      no-tool prompts omit it.
- [ ] Memory mode details load for project/history/persona continuity prompts,
      while simple no-tool prompts omit them.
- [ ] Tests assert substantial guidance-token reduction for simple prompts and
      preservation of critical workflow strings for relevant prompts.
- [ ] No tool is removed from the tool set as part of this issue.

### Technical Notes

- Primary file scope:
  - `normal-chat-context.ts` and prompt-pack helper/tests
- This issue may split existing packs into `core` and `details` variants, but
  should not change tool schemas unless a schema description is demonstrably
  redundant with prompt guidance.

### Verification

- `npx vitest run src/lib/server/services/normal-chat-context.test.ts src/lib/server/services/normal-chat-tools/index.test.ts`

## APL-06: Benchmark, Behavior Sweep, Review, Deploy, And Compare Baselines

**Type:** Verification
**Blocked by:** APL-03 through APL-05

### What to build

Complete the safety and performance verification round locally and on the live
AlfyAI deployment.

### Acceptance Criteria

- [ ] Focused Vitest suites for changed units pass.
- [ ] `git diff --check` passes.
- [ ] `npm run check` passes with 0 errors and 0 warnings.
- [ ] Fallow runs with
      `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`
      and introduces no new findings.
- [ ] A code review pass inspects the integrated diff for behavior regressions,
      hidden tool disabling, prompt leakage, and missing tests.
- [ ] The normal remote deploy script `./scripts/deploy.sh` is used on
      `alfydesign`.
- [ ] Live health and journal checks pass after restart.
- [ ] Live behavior sweep covers:
      - simple no-tool short reply
      - current/latest/source-backed web prompt
      - implicit downloadable-file prompt
      - implicit image-search prompt
      - generated-file revision prompt
      - memory/project-history continuity prompt
- [ ] A fresh live benchmark is compared against the earliest preserved
      benchmark summary from `/private/tmp/alfyai-live-chat-bench-old-20260629T200837Z/summary.json`
      and the latest pre-APL summary.

### Technical Notes

- Primary local tools:
  - `scripts/benchmark-live-chat-stream.ts`
  - `scripts/verify-live-ai-sweep.ts`
  - `scripts/verify-live-file-production-types.ts` if relevant
- Use the `$remote-live-testing` workflow. Do not delete production data or
  live-only files.

### Verification

- Local gates above.
- Remote deploy, `/api/health`, journal inspection, authenticated live UI/API
  smoke, benchmark comparison.
