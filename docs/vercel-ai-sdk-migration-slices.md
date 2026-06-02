# Vercel AI SDK Migration Issue Drafts

**Status:** Local issue drafts and implementation checklist only; not published to an issue tracker
**Last reviewed:** 2026-06-02

## Goal

Fully retire Langflow from AlfyAI before the next remote deployment. The current Normal Chat runtime uses Vercel AI SDK for **Normal Chat Model Run**, direct app-owned tools, and AI SDK UI stream framing for the browser-facing Normal Chat stream. AI SDK UI-compatible durable message persistence remains a follow-up before deployment if we want the database shape to match UI messages directly.

## Decisions Captured

- **Normal Chat Model Run** is the canonical execution boundary between **Context Selection** and **Normal Chat Turn Completion**.
- Langflow has been removed from the Normal Chat runtime and is not kept as a production fallback.
- AI SDK UI streams are the browser-facing Normal Chat stream contract. AI SDK UI-compatible message persistence remains pending.
- A database reset is acceptable for this private deployment. Preserve or re-seed only runtime-enabling configuration such as admin access, provider config, prompts, defaults, and still-relevant system skills.
- Third-party provider access is a live compatibility check, not a replacement for deterministic fake-provider smoke coverage.
- Deep Research quality remains out of scope; only Langflow dependencies that block removal are in scope.
- Provider **Model Capabilities** are auto-probed where possible, shown inline in the existing model/provider UI, and manually overrideable.
- Missing required capabilities fail before the model call with clear app errors.
- Side-effecting tools use app-owned idempotency boundaries. `produce_file` returns after **File Production Intake**, not after rendering finishes.
- AI SDK tools call server services directly. Internal HTTP tool routes and service-assertion compatibility have been removed once unused.
- Existing **Browser SSE Protocol** production code has been deleted. Active-stream replay remains app-owned for now, but it emits AI SDK UI stream parts instead of custom Browser SSE events.
- Remote deployment is frozen until Langflow is gone, AI SDK UI streams/messages are active, fake-provider journeys pass, live-provider smoke passes, and capability UI is usable enough to diagnose provider support.

## Non-Goals

- Do not repair Deep Research quality, fanout, or report generation in this migration.
- Do not preserve legacy conversations if doing so keeps compatibility code alive.
- Do not keep Langflow nodes, mocks, model-run transport, admin fields, or tool HTTP compatibility as permanent fallback paths.
- Do not introduce a new large settings section for provider capabilities.

## Local Issue Breakdown

### AISK-01. Build the fake OpenAI-compatible provider smoke harness

**Implementation status:** Complete for deterministic provider fixture and route-level harness foundations. Final browser smoke journeys are tracked in AISK-09.

**Type:** AFK
**Blocked by:** None

**User stories covered**

- As a developer, I can run deterministic Normal Chat smoke journeys locally without Langflow or third-party API spend.
- As a maintainer, I can reproduce stream, tool, timeout, rate-limit, retry, stop, and reconnect edge cases before deployment.

**What to build**

Add a local fake OpenAI-compatible provider and Playwright/Vitest fixtures that exercise the app through real routes, auth, DB, provider config, streaming, tool calls, and persistence. Use an isolated DB for smoke runs.

**Acceptance criteria**

- [x] Fake provider supports plain text, streaming text, reasoning parts, tool calls/results, provider 500, rate-limit, timeout, slow chunks, empty output, and abort scenarios.
- [x] Smoke config uses an isolated database instead of `data/chat.db`.
- [ ] At least the plain chat journey runs through the real SvelteKit app without mocking `/api/chat/stream`.
- [x] Request capture/reset endpoints allow assertions without leaking provider secrets.

### AISK-02. Add inline Model Capability probing and admin visibility

**Implementation status:** Complete for provider probing, model-row capability visibility, and manual override state.

**Type:** AFK
**Blocked by:** None

**User stories covered**

- As an admin, I can see what each configured model appears to support without guessing.
- As an admin, I can manually override a capability when a provider probe is wrong or incomplete.

**What to build**

Extend provider/model validation to probe capabilities and show compact capability status in the existing model/provider list, with details and manual overrides in the existing edit modal.

**Acceptance criteria**

- [x] Capabilities include chat, streaming, tools, structured output, reasoning controls, usage reporting, file/image message parts where practical, and `/models` validation support.
- [x] Capability status supports detected, not detected, unknown, and manual override.
- [x] Missing required capabilities produce clear preflight errors before model calls.
- [x] Capability UI is inline with existing model rows and edit modal, not a new settings section.

### AISK-03. Land AI SDK Normal Chat plain chat behind the existing browser path

**Implementation status:** Complete. Normal Chat `/send` and the non-stream fallback use the AI SDK Normal Chat Model Run boundary.

**Type:** AFK
**Blocked by:** AISK-01

**User stories covered**

- As a user, I can send a plain Normal Chat message locally without Langflow.
- As a maintainer, I can verify the new **Normal Chat Model Run** boundary before tools and UI stream replacement add more moving parts.

**What to build**

Introduce the Vercel AI SDK **Normal Chat Model Run** implementation for plain chat while temporarily adapting output to the existing browser path. Keep **Context Selection** and **Normal Chat Turn Completion** separate.

**Acceptance criteria**

- [x] Plain chat uses Vercel AI SDK, not Langflow.
- [x] Provider config and admin overrides flow through runtime config.
- [x] Usage metadata is recorded when present and estimated when absent.
- [x] Stop, timeout, and provider failure paths are covered by focused tests.

### AISK-04. Replace Langflow Python tools with AI SDK service-backed tools

**Implementation status:** Complete. The Normal Chat tool boundary uses AI SDK tools that call app services directly.

**Type:** AFK
**Blocked by:** AISK-02, AISK-03

**User stories covered**

- As a user, web/image/memory/file tool behavior works without Langflow Python nodes.
- As a maintainer, tools call app-owned services directly and preserve scope, evidence, and idempotency.

**What to build**

Add AI SDK tool definitions for `produce_file`, `research_web`, `image_search`, and `memory_context`. Tools close over user/conversation scope and call app services directly.

**Acceptance criteria**

- [x] Tool schemas use structured inputs, including array/object `requestedOutputs` for `produce_file`.
- [x] `produce_file` enters **File Production Intake** and returns accepted/queued/reused/failed intake state without waiting for rendering.
- [x] `research_web`, `image_search`, and `memory_context` preserve current scope rules and compact outputs.
- [x] Tool evidence and source candidates are available to the message/evidence path.
- [x] AI SDK/tool retries cannot duplicate side effects.

### AISK-05. Prove AI SDK tool journeys for files, memory, web, image, and evidence

**Implementation status:** Implemented through focused service/route coverage. Full end-to-end fake-provider journeys still belong to AISK-09 after AI SDK UI streams/messages land.

**Type:** AFK
**Blocked by:** AISK-04

**User stories covered**

- As a user, asking for a file creates a visible file card, persists the job, and later exposes preview/download.
- As a maintainer, file-production cards survive refresh and are linked to the assistant message.
- As a user, memory and web/image tools produce visible, source-backed answers.
- As a maintainer, Context Sources and Message Evidence do not silently disappear when Langflow nodes are removed.

**What to build**

Wire service-backed AI SDK tools into the chat turn, file-production read model, message evidence, source chips, context-source display, image rendering guidance, and refresh behavior. The slice should prove the core user-visible tool paths together because these tools share tool-call rendering, persistence, evidence, and refresh contracts.

**Acceptance criteria**

- [x] Tool-only file production turns persist an assistant message or equivalent AI SDK UI message.
- [x] Accepted jobs show an in-progress card during the turn.
- [x] Jobs link to the final assistant message after persistence.
- [x] Generated file preview/download works after completion.
- [x] Reused/idempotent jobs do not remain unassigned.
- [x] `memory_context` supports persona/project/history scope and bounded evidence candidates.
- [x] `research_web` preserves citation audit inputs and source evidence.
- [x] `image_search` results appear in the final answer or generated-document source shape rather than only in invisible tool output.
- [x] Tool result metadata is flattened or typed so Context Sources and Message Evidence can display it.
- [ ] Fake-provider smoke covers file production, memory/evidence, and web/image result shaping.

### AISK-06. Remove Langflow runtime, nodes, admin fields, mocks, and docs dependencies

**Implementation status:** Complete for runtime/code cleanup. Active docs are updated in the current docs-only pass.

**Type:** AFK
**Blocked by:** AISK-03, AISK-04, AISK-05

**User stories covered**

- As a maintainer, there is no active Langflow runtime or compatibility path left to regress.
- As an admin, model setup no longer asks for Langflow flow or component IDs.

**What to build**

Delete Langflow code and compatibility paths after AI SDK parity exists. Mark historical ADRs superseded where appropriate and remove active docs/deployment instructions that require Langflow.

**Acceptance criteria**

- [x] `langflow_nodes/` is removed.
- [x] Normal Chat no longer imports `langflow.ts` or `langflow-model-run.ts`.
- [x] Langflow env/config/admin UI fields are removed.
- [x] Langflow mocks and Langflow-specific tests are removed or replaced by AI SDK coverage.
- [x] Internal HTTP tool/service-assertion compatibility is removed when unused by browser or external callers.
- [x] Active docs and logs no longer require or brand errors as Langflow.

### AISK-07. Move Normal Chat persistence to AI SDK UI-compatible messages

**Implementation status:** Pending. The browser stream now uses AI SDK UI stream parts, but durable message persistence still uses the existing app-owned message schema plus metadata envelope.

**Type:** AFK
**Blocked by:** AISK-06

**User stories covered**

- As a user, the chat transcript persists in the same message shape the AI SDK UI runtime consumes.
- As a maintainer, the app stops carrying a parallel custom message schema for Normal Chat.

**What to build**

Reset or migrate the DB schema for this private deployment so Normal Chat messages persist as AI SDK UI-compatible messages. Keep only a slim app-owned conversation/workspace envelope for non-message state.

**Acceptance criteria**

- [ ] New message persistence stores AI SDK UI-compatible messages.
- [ ] Message-scoped display state uses UI message parts/metadata where practical: text, reasoning, tool calls/results, generated-file references, evidence/source references, usage/cost, stopped/error state.
- [ ] Conversation/workspace envelope still exposes non-message state: working set, active jobs, drafts, task state, context status, context compression snapshots, skills, and cost totals.
- [ ] Legacy conversation migration is not required; reset/re-seed path preserves only runtime-enabling config.

### AISK-08. Replace Browser SSE with AI SDK UI streams and resumable stream behavior

**Implementation status:** Complete for Browser SSE production removal and AI SDK UI stream framing. Active-stream replay remains app-owned in this pass, but replay, tool calls, metadata, errors, and terminal events are emitted as AI SDK UI stream parts. Full AI SDK UI message persistence/resume integration remains tied to AISK-07.

**Type:** AFK
**Blocked by:** AISK-06

**User stories covered**

- As a user, streaming, reconnect/resume, explicit stop, passive detach, queued follow-up, and tool/data parts work through AI SDK UI streams.
- As a maintainer, Browser SSE Protocol and custom active-stream replay are no longer production paths.

**What to build**

Move the browser runtime to AI SDK UI streams and replace custom Browser SSE parsing/replay events. Keep only app-owned lifecycle state that is still needed for passive detach, persistence, and reconnect until UI message persistence can absorb it safely.

**Acceptance criteria**

- [x] AI SDK UI streams are the browser-facing stream contract.
- [x] Passive detach/navigation does not stop server generation.
- [x] Explicit Stop aborts server generation and marks the message state.
- [x] Reconnect/resume replays text, reasoning, tool/data parts, and terminal metadata through AI SDK UI parts.
- [x] Queued follow-up and error recovery still work through the existing Normal Chat Client Turn Runtime.
- [x] Old Browser SSE production code is deleted once unused.

### AISK-09. Run full fake-provider journey gates

**Type:** AFK
**Blocked by:** AISK-08

**User stories covered**

- As a maintainer, I can prove main flows locally before deployment.
- As a user, the core chat, tools, files, resilience, and provider-failure paths are protected from hidden regressions.

**What to build**

Complete deterministic smoke journeys against the fake provider using the final AI SDK UI stream/message runtime.

**Acceptance criteria**

- [ ] Plain Chat Journey passes.
- [ ] Tool + Evidence Journey passes.
- [ ] File Production Journey passes.
- [ ] Stream Resilience Journey passes, including passive detach/resume and explicit stop.
- [ ] Provider Failure Journey passes for rate limit, timeout, 500, unsupported capability, and configured fallback/error behavior.

### AISK-10. Run live provider compatibility smoke

**Type:** HITL
**Blocked by:** AISK-09

**User stories covered**

- As an operator, I know the configured third-party provider works with the exact runtime that will be deployed.
- As an admin, capability probes and overrides reflect real endpoint behavior.

**What to build**

Use supplied third-party API credentials to run a live compatibility smoke without committing secrets.

**Acceptance criteria**

- [ ] Live provider validates base URL/auth/model configuration.
- [ ] Live provider capability probes produce understandable UI evidence.
- [ ] Plain chat, streaming, tools, usage fallback, stop, timeout, and rate-limit behavior are verified as far as the provider supports them.
- [ ] Any unsupported capability fails before model call or is explicitly overridden by admin choice.

### AISK-11. Deployment readiness and supersession cleanup

**Type:** HITL
**Blocked by:** AISK-10

**User stories covered**

- As an operator, I deploy only after the full Vercel AI SDK runtime is stable locally and live-provider compatible.
- As a maintainer, old ADRs and docs do not mislead future work.

**What to build**

Prepare the final deployment gate: freeze checks, docs updates, old ADR supersession notes, reset/re-seed procedure, and final verification commands.

**Acceptance criteria**

- [x] ADR-0020 is marked superseded after Langflow removal lands.
- [x] ADR-0016 is marked superseded after AI SDK UI streams land.
- [x] README/env/docs no longer instruct operators to configure Langflow.
- [ ] Reset/re-seed instructions preserve only approved runtime-enabling configuration.
- [ ] Remote deployment proceeds only after fake-provider and live-provider gates pass.

## Proposed Verification Commands

Exact command names may change during implementation, but the migration should end with focused checks equivalent to:

- `npm run check`
- `npm run test:unit`
- `npm run test:ai`
- `npm run test:e2e:ai-smoke`
- live provider smoke command with credentials supplied through local environment only

## Deletion Checklist

Delete or rewrite after parity:

- [x] `langflow_nodes/`
- [x] Langflow model-run transport and prompt/runtime compatibility modules
- [x] Langflow mocks and mock-start scripts
- [x] Langflow-specific Vitest/Playwright fixtures
- [x] Langflow flow/component admin fields and i18n labels
- [x] Langflow env vars and docs
- [x] Internal service-assertion HTTP routes that only existed for Langflow nodes
- [x] Browser SSE Protocol production code after AI SDK UI streams/messages replace it
- [ ] Active-stream custom replay buffers after AI SDK/resumable stream behavior replaces them

## Open Follow-Up

Before promoting these local drafts into tracker issues or implementation assignments, confirm:

- Does this granularity feel right?
- Are the dependencies correct?
- Are AISK-10 and AISK-11 the only HITL slices?
