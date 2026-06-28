# Candidate 2 OpenAI-Compatible Provider Adapter implementation issues

This is the local `$to-issues` implementation backlog for Candidate 2 from
`docs/chat-streaming-stability-deepening-report.html`.

The slices below are local issue drafts, not published tracker issues. No
external issue tracker configuration was found in this workspace, and existing
project practice keeps implementation backlogs under
`docs/*-implementation-issues.md`.

## Goal

Deepen the Normal Chat OpenAI-compatible provider adapter so provider-family
quirks for DeepSeek V4, Xiaomi/MiMo, Kimi K2.X, GLM 5.X, Qwen 3.X, OpenAI, and
generic OpenAI-compatible providers are owned by one adapter interface.

The adapter should own:

- provider-family identification
- AI SDK `providerOptions` shaping
- request body transformation before `createOpenAICompatible(...)` sends bytes
- fetch/stream transforms, including tool-call stream normalization and
  Xiaomi/MiMo reasoning replay
- usage-reporting expectations where they affect provider creation
- provider-family error classification hooks used by model fallback policy
- the documented line between provider-family stream shaping and the neutral
  Normal Chat Model Run event interface

## Evidence

- Context7 AI SDK docs, queried 2026-06-28, confirm:
  - `createOpenAICompatible(...)` accepts `name`, `apiKey`, `baseURL`,
    `includeUsage`, `supportsStructuredOutputs`, custom `fetch`, and
    `transformRequestBody`.
  - `includeUsage` asks compatible providers to include usage information in
    streaming responses.
  - `streamText(...).fullStream` exposes structured parts for text, reasoning,
    tool input/calls/results/errors, finish, error, raw, and usage-bearing
    finish parts.
- `package.json` currently uses `ai@^6.0.193`,
  `@ai-sdk/openai-compatible@^2.0.48`, and `@sveltejs/kit@^2.57.1`.
- `AGENTS.md` says `src/lib/server/services/normal-chat-model/` owns AI SDK
  OpenAI-compatible Normal Chat model execution, provider-attempt policy,
  timeout failover, unsupported-tool fallback, provider usage mapping, and
  neutral model-run events.
- ADR-0027 preserves **Model Provider** and **Provider Model** separation. This
  work must not turn family quirks into Provider Model identity or provider
  persistence fields unless a later admin feature explicitly does that.
- Current code evidence:
  - `provider-compatibility.ts` identifies families and shapes request bodies
    and provider options.
  - `openai-compatible-provider.ts` wires
    `createOpenAICompatible(...)`, stream normalization fetch, MiMo replay
    fetch, and request transforms.
  - `openai-compatible-stream-normalizer.ts` normalizes OpenAI-compatible SSE
    tool-call deltas and parameterless tool calls.
  - `mimo-reasoning-replay.ts` observes MiMo reasoning content and replays it
    into later assistant tool-call messages.
  - `index.ts` builds provider options, creates the provider, maps AI SDK
    `fullStream` parts into neutral Normal Chat Model Run events, and applies
    fallback/error policy.
  - `tests/fixtures/ai/openai-compatible-stream-fixtures.ts` already names the
    target fixture families: `deepseek-v4`, `xiaomi-mimo`, `kimi-k2`, `glm-5`,
    and `qwen-3`.

## Collision constraints

- Candidate 1 may run in parallel and owns stream intake and completion timing.
  Candidate 2 workers must not modify:
  - `src/routes/api/chat/stream/**`
  - `src/lib/server/services/chat-turn/**`
  - `src/lib/services/streaming.ts`
- Candidate 2 owns only the OpenAI-compatible provider adapter and its tests:
  - `src/lib/server/services/normal-chat-model/**`
  - `tests/fixtures/ai/openai-compatible-*`
  - `tests/mocks/ai-provider/openai-compatible-provider.ts`
  - `tests/integration/*openai-compatible-provider.test.ts`
- Do not change AI SDK UI stream part names or browser parser expectations.
- Do not change Provider Model persistence, provider admin UI, DB schema, or
  model selection UI in this candidate.
- Do not remove existing compatibility exports until all internal call sites are
  migrated; prefer a shim during this candidate if it keeps the diff smaller.

## Orchestration constraints

- The orchestrator does not write implementation code. Code-writing workers own
  their patches.
- Every code-writing worker must use `$tdd`, or explain why strict test-first
  work was not feasible and still add the smallest useful regression check.
- Workers must not revert or overwrite concurrent edits.
- Workers must report changed paths, tests run, and any blockers.
- The review wave must pass all repo gates before Candidate 2 is called
  finished:
  - focused Vitest suites for changed provider surfaces
  - `git diff --check`
  - `npm run check`
  - `npm run lint`
  - `npm test`
  - `npm run build`
  - Fallow audit:
    `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`
  - targeted Playwright coverage for chat streaming if runtime stream behavior
    changed:
    `npx playwright test tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts`

## Summary

| ID | Title | Type | Blocked by | Suggested owner scope |
| --- | --- | --- | --- | --- |
| C2-01 | Introduce provider adapter profiles | AFK | None | Adapter module and provider-family unit tests |
| C2-02 | Route request/options/provider creation through the adapter | AFK | C2-01 | Provider factory, provider options call site, smoke tests |
| C2-03 | Put stream normalization and MiMo replay behind adapter fetch transforms | AFK | C2-01, C2-02 | Fetch transform composition and stream fixture tests |
| C2-04 | Add provider-family error classification hooks | AFK | C2-01 | Adapter error classification, failover/model-run tests |
| C2-05 | Clarify neutral model-run event mapping after adapter shaping | AFK | C2-02, C2-03 | Model-run stream event mapper and focused tests |
| C2-06 | Full review, gates, commit, and main push | HITL | C2-01 through C2-05 | Orchestrator review, verification, commit, push |

## Parallelization plan

Run Candidate 2 with bounded parallelism:

1. Start **C2-01** first. It defines the adapter interface and family profiles.
2. In parallel with C2-01, run read-only explorers for:
   - fixture coverage gaps across DeepSeek, Xiaomi/MiMo, Kimi, GLM, and Qwen
   - model-run error classification and `fullStream` event mapping risks
3. After C2-01 lands, run **C2-02** and **C2-04** in parallel only if their
   workers keep to their scopes:
   - C2-02 owns request/options/provider creation integration.
   - C2-04 owns error classification and fallback tests.
4. Run **C2-03** after C2-02 because stream fetch transform composition depends
   on where provider creation resolves the adapter.
5. Run **C2-05** after C2-02 and C2-03. It should be a small cleanup/proof
   slice, not a second provider rewrite.
6. Run **C2-06** last. Candidate 2 is not finished until this review wave
   passes the full repo gates and the final commit is pushed to `main`.

## C2-01: Introduce provider adapter profiles

**Type:** AFK
**Blocked by:** None - can start immediately

### What to build

Create one internal OpenAI-compatible provider adapter interface for Normal Chat
model execution. It should resolve a provider profile once from
`NormalChatModelRunCompatibilityProvider`-compatible metadata and expose family
behavior through methods or typed fields.

The family profiles must cover at least:

- OpenAI
- DeepSeek V4
- Xiaomi/MiMo
- Kimi K2.X
- GLM 5.X
- Qwen 3.X
- generic OpenAI-compatible

Existing public helpers may remain as compatibility shims during this candidate,
but they should delegate to the adapter profile instead of duplicating logic.

### Acceptance criteria

- [ ] A single adapter resolver identifies OpenAI, DeepSeek, Xiaomi/MiMo, Kimi,
  GLM, Qwen, and generic providers from provider name, display name, base URL,
  and model name.
- [ ] Provider option shaping remains behaviorally compatible for existing
  DeepSeek, Kimi, Qwen, MiMo, OpenAI, and generic tests.
- [ ] GLM 5.X has explicit family detection even if its profile currently uses
  generic request semantics.
- [ ] Existing exported helpers such as MiMo detection, request transform, and
  provider option building continue to compile through the migration.
- [ ] Focused tests cover each family profile and prove family behavior belongs
  to the adapter rather than scattered call-site conditionals.

### Technical notes

- Primary file scope:
  - `src/lib/server/services/normal-chat-model/provider-compatibility.ts`
  - optional new file:
    `src/lib/server/services/normal-chat-model/openai-compatible-provider-adapter.ts`
  - `src/lib/server/services/normal-chat-model/provider-compatibility.test.ts`
- Avoid touching:
  - `src/lib/server/services/normal-chat-model/openai-compatible-provider.ts`
  - `src/lib/server/services/normal-chat-model/index.ts`
  - stream normalizer and MiMo replay files

### Verification

- `npx vitest run src/lib/server/services/normal-chat-model/provider-compatibility.test.ts`

## C2-02: Route request/options/provider creation through the adapter

**Type:** AFK
**Blocked by:** C2-01

### What to build

Change Normal Chat provider creation and provider option resolution so both call
the adapter profile resolved for the selected provider. The AI SDK
`createOpenAICompatible(...)` call should receive request transforms and fetch
composition from the adapter profile, not from scattered imports in the factory.

### Acceptance criteria

- [ ] `buildNormalChatModelRunProviderOptions(...)` delegates to the adapter
  profile.
- [ ] `createOpenAICompatibleProviderForNormalChatModelRun(...)` resolves the
  adapter once and uses it for request body transformation and fetch setup.
- [ ] Provider-specific request body transforms still apply after a caller
  supplies an extra `transformRequestBody` callback.
- [ ] Existing MiMo max-token, Qwen thinking, Kimi tool-choice, DeepSeek
  tool-choice, and OpenAI GPT-5 reasoning/tool request behavior is preserved.
- [ ] Tests prove the AI SDK provider factory still sends normalized base URLs,
  `includeUsage`, `supportsStructuredOutputs`, and custom fetch behavior as
  before.

### Technical notes

- Primary file scope:
  - `src/lib/server/services/normal-chat-model/openai-compatible-provider.ts`
  - `src/lib/server/services/normal-chat-model/index.ts`
  - `src/lib/server/services/normal-chat-model/index.test.ts`
  - `tests/integration/xiaomi-mimo-openai-compatible-provider.test.ts`
  - `tests/integration/openai-compatible-provider.test.ts`
- Avoid touching:
  - chat-turn route/orchestrator files
  - browser stream consumer files
  - DB/provider admin UI files

### Verification

- `npx vitest run src/lib/server/services/normal-chat-model/index.test.ts`
- `npx vitest run tests/integration/xiaomi-mimo-openai-compatible-provider.test.ts tests/integration/openai-compatible-provider.test.ts`

## C2-03: Put stream normalization and MiMo replay behind adapter fetch transforms

**Type:** AFK
**Blocked by:** C2-01, C2-02

### What to build

Move stream fetch behavior behind the adapter profile. The provider factory
should not know that Xiaomi/MiMo needs reasoning replay or that
OpenAI-compatible streams need tool-call normalization as separate top-level
concepts. It should ask the adapter to compose the fetch used by
`createOpenAICompatible(...)`.

### Acceptance criteria

- [ ] Stream normalization remains enabled by default and can still be disabled
  through the existing `normalizeStreaming: false` option.
- [ ] Xiaomi/MiMo reasoning replay remains active only for Xiaomi/MiMo profile
  matches.
- [ ] DeepSeek V4, Kimi K2.X, GLM 5.X, and Qwen 3.X provider stream fixtures
  still normalize text, reasoning, usage, finish reason, and tool calls.
- [ ] The adapter profile is the only place that decides which fetch transforms
  apply to a family.
- [ ] Tests cover stream framing across deterministic chunk boundaries and MiMo
  replay behavior after the adapter integration.

### Technical notes

- Primary file scope:
  - `src/lib/server/services/normal-chat-model/openai-compatible-provider.ts`
  - `src/lib/server/services/normal-chat-model/mimo-reasoning-replay.ts`
  - `src/lib/server/services/normal-chat-model/openai-compatible-stream-normalizer.ts`
  - `src/lib/server/services/normal-chat-model/openai-compatible-stream-normalizer.test.ts`
  - `src/lib/server/services/normal-chat-model/mimo-reasoning-replay.test.ts`
  - `tests/fixtures/ai/openai-compatible-stream-fixtures.ts`
  - `tests/integration/mimo-reasoning-replay-provider.test.ts`
- Avoid touching:
  - `src/lib/server/services/chat-turn/**`
  - `src/lib/services/streaming.ts`

### Verification

- `npx vitest run src/lib/server/services/normal-chat-model/openai-compatible-stream-normalizer.test.ts`
- `npx vitest run src/lib/server/services/normal-chat-model/mimo-reasoning-replay.test.ts`
- `npx vitest run tests/integration/mimo-reasoning-replay-provider.test.ts`

## C2-04: Add provider-family error classification hooks

**Type:** AFK
**Blocked by:** C2-01

### What to build

Give the adapter profile an error-classification hook that can answer whether a
provider-family error should be considered retryable for Normal Chat fallback.
Start by preserving the current generic classification and adding targeted
coverage for known OpenAI-compatible family error shapes.

This issue should not change fallback policy. It should move family-specific
knowledge behind the adapter and keep fallback decisions in the existing model
run/failover implementation.

### Acceptance criteria

- [ ] Current timeout, rate-limit, HTTP 429, HTTP 5xx, transport, unavailable,
  and premature-stream retryability remains unchanged.
- [ ] Auth, forbidden, prompt/schema, refusal, and user abort failures remain
  non-retryable.
- [ ] Provider-family error hooks can classify DeepSeek, Xiaomi/MiMo, Kimi, GLM,
  Qwen, and generic OpenAI-compatible error payload shapes without leaking
  provider-family checks into `index.ts`.
- [ ] Existing model fallback tests continue to pass.
- [ ] New focused tests prove adapter error classification is invoked by the
  model-run fallback path.

### Technical notes

- Primary file scope:
  - adapter module from C2-01
  - `src/lib/server/services/normal-chat-model/failover.ts`
  - `src/lib/server/services/normal-chat-model/index.ts`
  - `src/lib/server/services/normal-chat-model/index.test.ts`
  - `src/lib/server/services/normal-chat-model/provider-compatibility.test.ts`
- Avoid touching:
  - provider persistence or fallback admin UI
  - chat-turn routes/orchestrator

### Verification

- `npx vitest run src/lib/server/services/normal-chat-model/index.test.ts`
- `npx vitest run src/lib/server/services/normal-chat-model/provider-compatibility.test.ts`
- `npx vitest run src/lib/server/services/normal-chat-failover.test.ts`

## C2-05: Clarify neutral model-run event mapping after adapter shaping

**Type:** AFK
**Blocked by:** C2-02, C2-03

### What to build

Keep the neutral `StreamingNormalChatModelRunEvent` interface stable while
making the line explicit: provider profiles shape OpenAI-compatible request and
stream bytes; the model-run module maps AI SDK `fullStream` parts into neutral
Normal Chat events.

If the mapping remains in `index.ts`, add focused tests and comments that make
the separation clear. If it is extracted, keep the extraction small and internal
to `normal-chat-model/`.

### Acceptance criteria

- [ ] Browser-facing AI SDK UI stream part names are unchanged.
- [ ] Neutral model-run events are unchanged:
  `text_delta`, `reasoning_delta`, `tool_call`, `tool_result`, `tool_error`,
  `usage`, `finish`, and `error`.
- [ ] Done-tool suppression remains intact.
- [ ] Response model-name capture from AI SDK finish-step data remains intact.
- [ ] Tests prove provider-family stream fixtures still flow through the same
  neutral event sequence after adapter shaping.

### Technical notes

- Primary file scope:
  - `src/lib/server/services/normal-chat-model/index.ts`
  - optional new internal mapper file under
    `src/lib/server/services/normal-chat-model/`
  - `src/lib/server/services/normal-chat-model/index.test.ts`
  - `tests/fixtures/ai/openai-compatible-stream-fixtures.ts`
- Avoid touching:
  - `src/lib/server/services/chat-turn/stream.ts`
  - `src/lib/services/ai-sdk-ui-stream-contract.ts`
  - `src/lib/services/streaming.ts`

### Verification

- `npx vitest run src/lib/server/services/normal-chat-model/index.test.ts`
- If fixture-backed integration is added:
  `npx vitest run tests/integration/openai-compatible-provider.test.ts`

## C2-06: Full review, gates, commit, and main push

**Type:** HITL
**Blocked by:** C2-01 through C2-05

### What to do

Run a full review wave after all implementation workers finish. Candidate 2 is
not complete until this wave proves the adapter is coherent, tests pass, repo
gates pass, and the final work is committed and pushed to `main`.

### Acceptance criteria

- [ ] Orchestrator reviews every worker diff for overlap, project-boundary
  violations, stale exports, missing tests, and accidental changes to stream
  route/browser contracts.
- [ ] No provider-family conditionals remain in call sites that belong inside
  the adapter profile, except compatibility shims explicitly documented for
  follow-up removal.
- [ ] Full verification passes or any pre-existing environment failure is
  recorded with exact command output and no hidden "finished" claim.
- [ ] `git status --short` contains only intended Candidate 2 changes before
  commit.
- [ ] Commit message explains why the provider adapter was deepened.
- [ ] The committed `main` branch is pushed to `origin/main`.

### Required verification

- `git diff --check`
- `npx vitest run src/lib/server/services/normal-chat-model/provider-compatibility.test.ts src/lib/server/services/normal-chat-model/openai-compatible-stream-normalizer.test.ts src/lib/server/services/normal-chat-model/mimo-reasoning-replay.test.ts src/lib/server/services/normal-chat-model/index.test.ts`
- `npx vitest run tests/integration/openai-compatible-provider.test.ts tests/integration/xiaomi-mimo-openai-compatible-provider.test.ts tests/integration/mimo-reasoning-replay-provider.test.ts`
- `npm run check`
- `npm run lint`
- `npm test`
- `npm run build`
- `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`
- If stream behavior changed beyond internal provider fetch shaping:
  `npx playwright test tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts`
