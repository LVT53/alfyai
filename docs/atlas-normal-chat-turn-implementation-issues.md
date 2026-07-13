# Atlas Normal Chat Turn Implementation Issues

> **Historical — the SearXNG assumptions here are superseded by [ADR-0052](adr/0052-replace-searxng-web-research-with-parallel-search.md) (2026-07-13).** Statements below that "Atlas requires SearXNG" / gate on `SEARXNG_BASE_URL` describe the original build. SearXNG has been removed: Atlas text/web search now runs on the **Parallel Search API** and gates on `PARALLEL_API_KEY`; image search is on Brave. The Atlas Normal-Chat-Turn architecture this doc planned still stands.

This document is local planning output, not published tracker state. It converts the current Atlas ADR and domain context into issue-ready tracer-bullet slices for implementation. It does not change the source of truth in `AGENTS.md`, `CONTEXT.md`, or ADRs.

## Source Decisions / Docs Check

Primary project sources read for this plan:

- `AGENTS.md`: routes are adapters; durable behavior belongs in services; runtime config flows through `config-store.ts`; new SQLite tables require matching migrations and Drizzle journal entries; `finalizeChatTurn`, file-production, document-workspace, knowledge, task-state, analytics, and i18n boundaries are the relevant seams.
- `CONTEXT.md`, especially `## Atlas Research Reports`: Atlas is a durable navigable report artifact produced by an Atlas Turn, which is a special Normal Chat Turn. Atlas uses Atlas Profiles, Atlas Research Rounds, Atlas Basis, Atlas Honesty Markers, Atlas Local Sources, Atlas Web Sources, Atlas Completion Notices, Atlas Continue/Fork/Revise, Atlas Resume, and Atlas Cost Summary.
- `docs/adr/0036-atlas-is-normal-chat-turn-not-parallel-subsystem.md`: Atlas is a Normal Chat Turn plus artifact, not a parallel subsystem. The locked edge cases in that ADR are treated as non-negotiable implementation constraints.
- `/Users/lvt53/.codex/skills/to-issues/SKILL.md`: issues should be independently implementable tracer bullets with behavior-focused acceptance criteria, dependencies, triage labels, and highest-feasible-seam verification.
- `/Users/lvt53/.codex/skills/remote-live-testing/SKILL.md`: the remote verification pass should deploy, restart `langflow-chat.service`, check `/api/health`, inspect journal logs, and smoke-test the live authenticated UI with a timestamped harmless Atlas prompt.
- `/Users/lvt53/.codex/skills/tdd/SKILL.md`: strict red-green TDD is not applicable to this planning-only task, but implementation slices should still prefer tests at public seams and avoid tests coupled to internals.
- Existing local issue-doc examples inspected: `docs/privacy-controls-implementation-issues.md` and `docs/memory-profile-deepening-slices.md`.
- Prototype evidence inspected: `docs/prototypes/atlas-prototype.html` includes composer entry, profile picker, Atlas chip, kickoff/progress/completion cards, report viewer, source chips, honesty markers, sidebar badge, EN/HU toggle, and dark-mode-related styling expectations.

Context7 documentation evidence checked before planning:

- SvelteKit docs for `/sveltejs/kit` confirm server-only page data belongs in `+page.server` load functions, and JSON API endpoints can be implemented with `+server` `POST` handlers returning `json(...)`. This supports keeping SvelteKit routes thin while durable Atlas logic lives in services.
- Drizzle docs for `/drizzle-team/drizzle-orm-docs` confirm SQLite tables are declared with `sqliteTable`, and indexes can be declared with `index` and `uniqueIndex`. In this repo, `AGENTS.md` adds the stronger requirement that every new `sqliteTable()` must have a matching migration and `_journal.json` entry.
- Vercel AI SDK docs for `/vercel/ai` confirm server-side `generateText` and `streamText` support tools and usage metadata. Atlas should still call through the app-owned `normal-chat-model` boundary rather than adding route-local AI SDK calls.

Source validation pass performed for planning:

- Confirmed package scripts include `npm run check`, `npm run lint`, `npm test`, `npm run build`, `npm run check:migrations`, and `npm run db:prepare`.
- Confirmed the existing source tree has the expected seams: `src/routes/api/chat/send/+server.ts`, `src/routes/api/chat/stream/+server.ts`, `src/lib/server/services/chat-turn/request.ts`, `preflight.ts`, `finalize.ts`, `normal-chat-model/`, `normal-chat-tools/`, `file-production/`, `conversation-detail/read-model.ts`, `knowledge/context.ts`, `task-state.ts`, `analytics.ts`, `config-store.ts`, and `src/hooks.server.ts`.
- Confirmed current `finalizeChatTurn` still imports memory intake and Honcho enrichment paths, so Atlas needs an explicit finalization option rather than a separate finalizer.
- Confirmed existing web search infrastructure is SearXNG-backed through `SEARXNG_BASE_URL`, `web-research`, `research_web`, and runtime config.
- Confirmed stale Deep Research migration/history files still exist in migrations by design, while ADR 0036 names planning docs whose live wording should be cleaned or marked historical during Atlas implementation.

## Non-Negotiable Implementation Rules

- Atlas is a Normal Chat Turn plus durable artifact, not a revived Deep Research subsystem.
- Atlas may add only 2 Atlas-owned tables. Do not recreate the old 16-table background subsystem.
- Atlas kickoff is send-route only. `atlasMode: true` goes to `/api/chat/send`; `/api/chat/stream` must not create Atlas jobs and must fail clearly if it receives `atlasMode`.
- `ChatTurnRequest` gets `atlasMode: boolean` and `atlasProfile: "overview" | "in-depth" | "exhaustive" | null`.
- Atlas kickoff short-circuits context selection, model-run, reasoning depth, and skills. It creates or reuses an idempotent Atlas job, writes the canned kickoff assistant message, and completes through `finalizeChatTurn`.
- `finalizeChatTurn` needs an explicit option to skip raw assistant-prose memory intake and Honcho enrichment while still preserving kickoff conversation persistence, assistant metadata, and normal message analytics/evidence metadata. Background completion records usage/source/output state on the Atlas job and links generated files through file-production; it does not create a second analytics or task-state completion event.
- Job creation idempotency uses a stable Atlas turn id plus a unique key scoped to user, conversation, action, parent Atlas id, profile, normalized query hash, and client turn id.
- V1 writes a completed Atlas checkpoint after audit and before deterministic rendering, not after every individual stage.
- Explicit linked sources and attachments become highest-authority Atlas Local Sources only after existing app boundaries prove they are openable and readable. The resolved explicit source set is snapshotted to the kickoff user message for the running job. Explicit source unreadiness fails kickoff with localized EN/HU errors. Automatic active working-set sources and parent Atlas seed sources may degrade.
- Quality gates may request one audit-driven revision pass, but cannot loop indefinitely. After quality limits are exhausted, Atlas still ships an honest report when rendering/storage can produce a trustworthy artifact.
- HTML Atlas is the primary output and opens by default. PDF and Markdown are sibling outputs on the same file-production job/document family.
- Continue and Revise operate from the persisted GeneratedDocumentSource/document family. Fork creates a new document family.
- Web Push is optional app-level infrastructure. On-page polling and sidebar badge must still work without VAPID keys, permission, service worker support, or push subscription storage.
- Pipeline stages are fixed: decompose -> search -> curate -> synthesize -> integrate -> assemble -> audit.
- SearXNG is required for Atlas. If absent, Atlas UI and command are disabled with localized explanation.
- Search rate limiting defaults: concurrency 3, inter-batch delay 500ms, exponential backoff from 500ms to 10s max, and greater than 50 percent batch failure stops search and proceeds with a limitation.
- `ATLAS_SYNTHESIS_MODEL` and `ATLAS_AUDIT_MODEL` are admin-configurable through `config-store` using `provider:<id>:<modelId>` values. Audit defaults to another enabled model when possible.
- Worker startup uses a separate `ensureAtlasWorker()` from `src/hooks.server.ts`, controlled by config-store and defaulting enabled.
- Completion records profile, source counts, token usage, cost when available, file-production job id, generated-file ids, and outcome on the Atlas job. It does not run Honcho enrichment, automatic memory intake, or a second chat-turn finalization for Atlas content.
- UI follows `docs/prototypes/atlas-prototype.html`: kickoff/progress/completion cards, icon-only actions except Open, dark mode, EN/HU chrome toggle, report design, source chips, honesty markers, and sidebar badge.
- Deep Research references in the named planning docs should be removed or explicitly marked historical during Atlas implementation.

## Architecture Map / Target Seams

Expected new or extended seams:

- Request parsing: extend `src/lib/server/services/chat-turn/request.ts` and `types.ts` with Atlas fields, defaulting to non-Atlas behavior.
- Preflight: extend `src/lib/server/services/chat-turn/preflight.ts` to validate explicit Atlas local sources through existing attachment/readiness and linked-source boundaries, while bypassing skill/depth/model prompt assembly for Atlas kickoff.
- Send route: keep `src/routes/api/chat/send/+server.ts` as transport and auth adapter. It should delegate Atlas kickoff to an Atlas service and then call `finalizeChatTurn`.
- Stream route: add a guard in `src/routes/api/chat/stream/+server.ts` after parsing to reject `atlasMode`.
- Atlas service boundary: add `src/lib/server/services/atlas/` as an internal feature boundary, with a narrow public facade. Suggested internals: `types.ts`, `config.ts`, `intake.ts`, `job-ledger.ts`, `worker-runner.ts`, `pipeline.ts`, `sources.ts`, `search.ts`, `round-checkpoints.ts`, `quality-gates.ts`, `renderer-source.ts`, `read-model.ts`, `notifications.ts`.
- Persistence: add exactly two Atlas-owned tables in `src/lib/server/db/schema.ts`, with matching `drizzle/` migration and `drizzle/meta/_journal.json` entry. Suggested tables:
  - `atlas_jobs`: job identity, idempotency key, user/conversation/action/profile/parent/family/message state, status, heartbeat, progress, token usage, cost when available, source counts, file-production links, completion/failure metadata.
  - `atlas_round_checkpoints`: one row per completed Atlas checkpoint, storing checkpoint JSON, curated source pool, compressed findings, accumulated token usage/cost when available, quality diagnostics, and intermediate GeneratedDocumentSource summary.
- Model calls: use `src/lib/server/services/normal-chat-model/` programmatic boundary. Do not import AI SDK directly into Atlas routes.
- Web search: compose existing `src/lib/server/services/web-research/` or extract shared SearXNG transport only if necessary. Keep Atlas search rate limits inside Atlas search orchestration, not in routes.
- Local sources: use `knowledge/context.ts`, `knowledge/store/*`, `document-resolution.ts`, working-document identity, and existing attachment readiness boundaries.
- File outputs: use `src/lib/server/services/file-production/` and generated-document source persistence. Atlas emits deterministic `GeneratedDocumentSource`; the app-owned standard report renderers produce HTML, PDF, and Markdown sibling outputs in the same job/document family.
- Conversation read model: extend `src/lib/server/services/conversation-detail/read-model.ts` so chat refresh/polling returns Atlas job/card state without loading worker/execution internals.
- Client API: add reusable browser calls under `src/lib/client/api/atlas.ts` or the nearest existing client API seam, rather than raw fetches inside components.
- UI: extend `MessageInput.svelte` and related chat components for composer entry/profile/chip, and use route-owned chat page state for polling/opening. Keep durable orchestration out of presentational components.
- Notifications: app-owned push subscription/service-worker infrastructure, with Atlas as first producer; sidebar badge and polling remain independent.
- Privacy cleanup: integrate with existing privacy-controls cleanup services; do not create Atlas-specific account lifecycle routes unless they delegate to existing cleanup boundaries.

## Slice Index

1. ATLAS-01 - Send-route Atlas kickoff creates an idempotent queued job and canned assistant message
2. ATLAS-02 - Stream-route guard and client transport route Atlas away from streaming
3. ATLAS-03 - Atlas schema, migration, and read model expose durable job state
4. ATLAS-04 - Worker startup, queue claiming, concurrency, heartbeat, and cancellation
5. ATLAS-05 - Explicit local source readiness and source-pool authority
6. ATLAS-06 - SearXNG-required search stage with rate limits and graceful limitation
7. ATLAS-07 - Model-stage pipeline runs through normal-chat-model with profile config and usage accounting
8. ATLAS-08 - Atlas checkpoint, durable retry state, bounded revision, and quality gates
9. ATLAS-09 - Atlas Basis audit and honesty markers use cross-model verification
10. ATLAS-10 - GeneratedDocumentSource assembly and HTML/PDF/Markdown file-production outputs
11. ATLAS-11 - Completion links files, records job usage, and skips assistant-prose memory intake
12. ATLAS-12 - Chat UI kickoff, progress, completion, sidebar badge, i18n, and dark mode
13. ATLAS-13 - Continue, Fork, and Revise lifecycle actions
14. ATLAS-14 - Optional app-level Web Push completion notices
15. ATLAS-15 - Privacy lifecycle, data archive behavior, and Deep Research wording cleanup
16. ATLAS-16 - End-to-end test matrix and remote live rollout pass

## ATLAS-01 - Send-route Atlas kickoff creates an idempotent queued job and canned assistant message

**Type / triage label:** `feature`, `chat-turn`, `backend`

**Dependencies:** None

### What to build

Implement the first end-to-end Atlas tracer bullet: a signed-in user submits an Atlas request through `/api/chat/send`, the request parses as `atlasMode: true`, a durable queued Atlas job is created or reused idempotently, and the response persists a canned assistant kickoff message through `finalizeChatTurn`.

The kickoff path should intentionally skip context selection, depth/deliberation, skills, and model execution. The assistant message is status UI, not model prose. It should include the query, selected Atlas Profile, a "you can close this page" style status, and initial Atlas job/card metadata for the browser to render.

### Acceptance criteria

- [ ] `ChatTurnRequest` accepts `atlasMode` with default `false`.
- [ ] `ChatTurnRequest` accepts `atlasProfile` with values `overview`, `in-depth`, `exhaustive`, and `null` for non-Atlas turns.
- [ ] Non-Atlas send and stream requests keep current behavior when the new fields are absent.
- [ ] `/api/chat/send` detects `atlasMode: true` after request parsing and delegates to an Atlas kickoff service.
- [ ] Atlas kickoff creates a queued Atlas job or returns the existing job when the idempotency key already exists.
- [ ] The idempotency key is scoped to user id, conversation id, Atlas action, parent Atlas id, Atlas Profile, normalized query hash, and client Atlas turn id.
- [ ] The canned kickoff assistant message is persisted through `finalizeChatTurn`.
- [ ] The kickoff path does not call `runPlainNormalChatSendModel`, context selection, depth deliberation, or skill prompt construction.
- [ ] Pending skills are silently ignored for Atlas kickoff.
- [ ] `forceWebSearch` and Normal Chat reasoning depth fields are ignored for Atlas kickoff.
- [ ] The JSON response includes enough job state for the browser to render an Atlas kickoff/progress card.
- [ ] Double-click, browser retry, and repeated identical request return the same job/message state instead of creating duplicate jobs.

### Technical notes

- Start at `src/lib/server/services/chat-turn/request.ts`, `src/lib/server/services/chat-turn/types.ts`, `src/routes/api/chat/send/+server.ts`, and `src/lib/server/services/chat-turn/finalize.ts`.
- Create an Atlas intake service rather than placing idempotency or job creation in the route.
- The service should expose a small result shape suitable for HTTP translation and finalization inputs.
- The kickoff assistant metadata should be compact and typed enough for `conversation-detail/read-model.ts` to hydrate cards after reload.
- Keep localized user-facing errors in EN and HU from the first slice if any kickoff failure can reach the user.

### Suggested verification

- Focused request parser tests for absent fields, valid profiles, invalid profiles, and default non-Atlas behavior.
- Send-route or service tests proving Atlas kickoff bypasses model-run and persists the canned assistant message.
- Idempotency tests for repeated client Atlas turn ids.
- Regression tests for normal `/api/chat/send` behavior without Atlas fields.
- `npm run check`.

## ATLAS-02 - Stream-route guard and client transport route Atlas away from streaming

**Type / triage label:** `feature`, `chat-turn`, `frontend`

**Dependencies:** ATLAS-01

### What to build

Protect the stream path from accidental Atlas creation and route Atlas submissions through the send path from the browser runtime. If `atlasMode` reaches `/api/chat/stream`, the route should return a clear structured error. The client should send Atlas requests to `/api/chat/send` and then refresh/poll conversation detail for progress.

### Acceptance criteria

- [ ] `/api/chat/stream` rejects `atlasMode: true` with a clear client-visible error code and message.
- [ ] `/api/chat/stream` never creates or claims Atlas jobs.
- [ ] The browser send runtime chooses `/api/chat/send` for Atlas submissions, even when the default chat behavior would stream.
- [ ] Atlas transport failure does not fall back to normal streamed chat.
- [ ] Normal stream requests without Atlas fields keep current behavior.
- [ ] The error is localized where it reaches visible UI.

### Technical notes

- Add the guard after `parseChatTurnRequest` in `src/routes/api/chat/stream/+server.ts` and before preflight/model orchestration.
- Keep the browser transport decision in `src/lib/client/normal-chat-client-turn-runtime.ts` or a neighboring client API/runtime seam, not in a visual component.
- Preserve AI SDK UI stream contract names for non-Atlas streaming.

### Suggested verification

- Stream-route unit test for `atlasMode: true` returns the Atlas-not-streamable error.
- Client runtime test proving Atlas requests call send transport and normal chat still calls stream transport.
- Existing `tests/e2e/streaming.spec.ts` remains green.

## ATLAS-03 - Atlas schema, migration, and read model expose durable job state

**Type / triage label:** `data`, `migration`, `read-model`

**Dependencies:** ATLAS-01

### What to build

Add exactly two Atlas-owned tables and a lightweight read model that exposes Atlas job state to conversation detail and polling surfaces. This slice should make durable queued/running/succeeded/failed/cancelled state visible after reload without implementing the full worker pipeline yet.

### Acceptance criteria

- [ ] `src/lib/server/db/schema.ts` defines exactly two Atlas-owned `sqliteTable()` entries.
- [ ] A matching SQL migration exists under `drizzle/`.
- [ ] `drizzle/meta/_journal.json` includes the migration entry.
- [ ] `npm run check:migrations` passes for the new schema state.
- [ ] Fresh `npm run db:prepare` creates the Atlas tables.
- [ ] Upgraded `npm run db:prepare` adds the Atlas tables without mutating runtime bootstrap code.
- [ ] The primary job table supports idempotency, user/conversation scoping, action, parent Atlas id, profile, normalized query hash, client turn id, status, progress, heartbeat, token usage, cost when available, source counts, file-production links, failure metadata, and timestamps.
- [ ] The round checkpoint table stores completed Atlas checkpoints keyed by job and round number.
- [ ] The conversation detail read model can return Atlas job/card state for a conversation without importing worker/model/renderer internals.
- [ ] The read model is safe for polling and does not expose raw prompt text, raw source text, API keys, or internal model payloads.

### Technical notes

- Use Drizzle SQLite `sqliteTable`, `index`, and `uniqueIndex` patterns already present in `src/lib/server/db/schema.ts`.
- Follow `AGENTS.md`: no runtime schema mutation in `src/lib/server/db/index.ts`.
- Suggested indexes: user/status/created, conversation/status/updated, unique idempotency key, job/round unique checkpoint.
- Keep the checkpoint JSON bounded and versioned so future resume changes can validate shape.

### Suggested verification

- `npm run check:migrations`.
- `DATABASE_PATH=/tmp/alfyai-atlas-fresh.db npm run db:prepare`.
- Upgrade migration smoke using a copied or fixture DB if available.
- Unit tests for job mapping and conversation-detail Atlas projection.

## ATLAS-04 - Worker startup, queue claiming, concurrency, heartbeat, and cancellation

**Type / triage label:** `backend`, `worker`, `ops`

**Dependencies:** ATLAS-03

### What to build

Implement the Atlas worker shell: startup from `hooks.server.ts`, config-store enable/disable, stale recovery, queue claiming, per-user and global concurrency, heartbeat updates, progress state, and cancellation. This slice can execute a stubbed pipeline step, but it must prove the durable worker lifecycle works end to end.

### Acceptance criteria

- [ ] `ensureAtlasWorker()` starts from `src/hooks.server.ts` without blocking request bootstrap.
- [ ] Worker startup is controlled by config-store and defaults enabled.
- [ ] Per-user active Atlas limit is 1.
- [ ] Global active Atlas limit defaults to 2 and is admin-configurable.
- [ ] Excess jobs queue instead of being rejected.
- [ ] Claimed jobs record worker id, heartbeat, started timestamp, and running status.
- [ ] Stale running jobs recover after a heartbeat timeout and become retryable/claimable according to the ADR.
- [ ] Cancellation marks a job cancelled and prevents resume from partial state.
- [ ] Conversation detail polling can show queued, running, cancelled, failed, and completed states.
- [ ] Worker logs use a compact grep-friendly prefix such as `[ATLAS]`.

### Technical notes

- Reuse the file-production worker-runner pattern conceptually, but do not claim file-production jobs or mix Atlas execution into file-production internals.
- Keep claim queries and heartbeat logic in `src/lib/server/services/atlas/job-ledger.ts` or equivalent.
- Avoid estimating wait time in v1.
- Keep worker imports out of read-model modules.

### Suggested verification

- Unit tests for claim ordering, per-user concurrency, global concurrency, stale recovery, cancellation, and heartbeat update.
- Conversation-detail read-model test for queued/running/cancelled display state.
- `npm run check`.

## ATLAS-05 - Explicit local source readiness and source-pool authority

**Type / triage label:** `feature`, `knowledge`, `i18n`

**Dependencies:** ATLAS-01, ATLAS-03

### What to build

Make explicit linked sources and composer attachments first-class Atlas Local Sources, with the highest authority boost, only after they are readable through existing app boundaries. Kickoff should wait for normal attachment readiness within the existing preflight timeout. If an explicit selected source cannot become readable, Atlas kickoff fails with localized EN/HU error instead of dropping it.

Auto-discovered Knowledge Library sources may degrade gracefully and should have lower authority than explicit sources.

### Acceptance criteria

- [ ] Composer attachments selected for an Atlas Turn are resolved into Atlas Local Sources only when readable/openable.
- [ ] Linked Context Sources selected through `/source` are resolved into Atlas Local Sources only when readable/openable.
- [ ] Explicit local sources receive the highest authority label in the source pool.
- [ ] Auto-discovered Knowledge Library sources receive a lower authority label and may degrade if unavailable.
- [ ] Explicit source unreadiness fails kickoff with localized EN/HU message that identifies the affected source where safe.
- [ ] Atlas source pool distinguishes Web Sources and Your Library sources for the eventual report.
- [ ] Memory can inform background context but is not represented as a citable Atlas Local Source.
- [ ] Normal Chat linked-source/attachment behavior remains unchanged for non-Atlas turns.

### Technical notes

- Use `knowledge/context.ts`, `knowledge/store/attachments.ts`, `document-resolution.ts`, and working-document identity helpers rather than creating a parallel document system.
- Keep attachment readiness errors compatible with existing `isAttachmentReadinessError` behavior.
- Store source authority labels and source provenance in the round checkpoint, not just transient pipeline memory.

### Suggested verification

- Unit tests for readable explicit attachment, unreadable explicit attachment, readable linked source, unreadable linked source, active working-set source inclusion, and automatic source degradation.
- i18n parity test for Atlas source-readiness errors in English and Hungarian.
- Regression tests for ordinary chat attachments.

## ATLAS-06 - SearXNG-required search stage with rate limits and graceful limitation

**Type / triage label:** `feature`, `web-search`, `reliability`

**Dependencies:** ATLAS-04, ATLAS-05

### What to build

Implement the Atlas Web Source search stage. Atlas requires SearXNG; if SearXNG is not configured, the UI/command should be disabled before kickoff. During execution, search runs in controlled batches with concurrency, inter-batch delay, exponential backoff, and explicit limitation behavior when search is rate-limited or unstable.

### Acceptance criteria

- [ ] Atlas entry points are disabled when `SEARXNG_BASE_URL`/runtime config has no SearXNG base URL.
- [ ] Disabled UI explains in EN/HU that Atlas requires web search/SearXNG.
- [ ] Atlas search uses SearXNG as the required web provider.
- [ ] Default Atlas search concurrency is 3.
- [ ] Default inter-batch delay is 500ms.
- [ ] Backoff starts at 500ms and caps at 10s for 429/timeouts/transient failures.
- [ ] If greater than 50 percent of a batch fails, the search stage stops searching and proceeds with available sources.
- [ ] Search limitation is persisted so the final Atlas Limitations section can state that search was rate-limited or incomplete.
- [ ] Atlas search config flows through `env.ts` and `config-store.ts` where admin overrides are required.
- [ ] Existing Normal Chat `research_web` behavior is not regressed.

### Technical notes

- Existing `web-research` supports SearXNG and extraction; compose it where possible, but Atlas may need a batch orchestrator around it for ADR-specific rate limits.
- Use source dedupe/canonicalization from existing web-grounding/web-research helpers where suitable.
- Do not bury Atlas quality logic in the raw SearXNG client.

### Suggested verification

- Unit tests with fake SearXNG responses for success, 429 retry, timeout retry, greater-than-50-percent failure, and no SearXNG configured.
- Config-store/env tests for Atlas search defaults and overrides.
- Existing web-research tests remain green.

## ATLAS-07 - Model-stage pipeline runs through normal-chat-model with profile config and usage accounting

**Type / triage label:** `feature`, `model-runtime`, `architecture`

**Dependencies:** ATLAS-04, ATLAS-06

### What to build

Implement the server-controlled pipeline stages that need model work: decompose, curate, synthesize, integrate, and assemble source content into a GeneratedDocumentSource draft. All model calls must go through the app-owned `normal-chat-model` boundary so provider failover, capabilities, usage mapping, and runtime defaults remain centralized.

### Acceptance criteria

- [ ] Pipeline stage order is server-controlled: decompose -> search -> curate -> synthesize -> integrate -> assemble -> audit.
- [ ] Stage prompts are handcrafted and language-aware using existing language detection.
- [ ] Atlas Profiles set stage output budget and prompt posture without using Normal Chat reasoning depth.
- [ ] `ATLAS_SYNTHESIS_MODEL` is resolved through config-store using `provider:<id>:<modelId>`.
- [ ] Synthesis defaults to the user's selected chat model when no admin override exists.
- [ ] The pipeline uses `normal-chat-model` programmatic API, not direct route-local AI SDK `generateText`/`streamText` calls.
- [ ] Usage metadata from all model calls is accumulated on the Atlas job and checkpoint.
- [ ] The audited report summary and curated source pool are compressed into the Atlas checkpoint before deterministic rendering.
- [ ] Stage outputs are parsed and validated through typed contracts with graceful failure diagnostics.
- [ ] Provider/model failures follow bounded retry policy and do not leave jobs permanently running.

### Technical notes

- If `normal-chat-model` lacks a convenient plain programmatic entrypoint for structured stage calls, add one inside that boundary rather than importing AI SDK from Atlas.
- Keep stage output schemas close to the Atlas service boundary.
- Do not inject pending skill prompts into Atlas stages.
- Store enough stage diagnostics for honest limitations and debugging, but avoid raw prompt/source dumps in user-visible read models.

### Suggested verification

- Unit tests for profile parameter resolution.
- Fake-provider tests for decompose/curate/synthesize/integrate stage contracts.
- Usage accumulation tests across multiple stage calls.
- Boundary regression check that Atlas services do not import `ai` directly.

## ATLAS-08 - Atlas checkpoint, durable retry state, bounded revision, and quality gates

**Type / triage label:** `feature`, `reliability`, `quality`

**Dependencies:** ATLAS-07

### What to build

Implement Atlas checkpointing and bounded quality gates. A checkpoint is written after audit and before deterministic rendering. Failed jobs retain durable job/checkpoint state for retry or inspection. Quality gates can request one audit-driven revision pass and then must ship an honest report if the artifact can still be trustworthy.

### Acceptance criteria

- [ ] A completed checkpoint includes curated source pool with authority labels, compressed findings, accumulated token usage/cost when available, quality diagnostics, and intermediate GeneratedDocumentSource summary.
- [ ] Failed jobs retain durable job/checkpoint state without resuming cancelled partial state.
- [ ] Explicit cancellation discards partial state and never resumes.
- [ ] Quality gates detect unsupported claims, source gaps, contradictions, and language drift.
- [ ] Quality gates may request one audit-driven revision pass and then must stop.
- [ ] Retry/round caps prevent infinite loops.
- [ ] Exhausted quality limits produce an honest Atlas with prominent Executive Summary and Limitations disclosures when rendering/storage can succeed.
- [ ] Infrastructure failures that prevent a trustworthy artifact leave the job failed with a clear localized status.
- [ ] Progress state remains human-readable and does not expose raw internal stage labels as the primary UI copy.

### Technical notes

- Persist checkpoint version and validation status so future pipeline changes can reject incompatible resume state.
- Keep quality gate vocabulary aligned with Atlas Basis and Atlas Honesty Marker domain terms.
- Treat Hungarian language parity as an audit concern for Hungarian reports.

### Suggested verification

- Unit tests for checkpoint write/read, cancellation non-resume, bounded audit revision, and exhausted-gate honest completion.
- Fake pipeline integration test for audit retry followed by honest degraded completion when the second audit still requests retry.
- Tests for Hungarian slippage detection if report language is Hungarian.

## ATLAS-09 - Atlas Basis audit and honesty markers use cross-model verification

**Type / triage label:** `feature`, `audit`, `model-runtime`

**Dependencies:** ATLAS-07, ATLAS-08

### What to build

Implement the audit stage that produces compact Atlas Basis diagnostics and Atlas Honesty Markers for factual output. Audit should use `ATLAS_AUDIT_MODEL`, defaulting to another enabled model when possible, and falling back to the synthesis model with a warning when only one model is available.

### Acceptance criteria

- [ ] `ATLAS_AUDIT_MODEL` resolves through config-store using `provider:<id>:<modelId>`.
- [ ] Audit defaults to a different enabled model than synthesis when possible.
- [ ] If only one model is enabled, audit falls back to it and records a warning.
- [ ] The assembled Atlas source is audited against accepted sources, search limitations, and local-source metadata before rendering.
- [ ] Honesty markers are severity-coded (`info`, `warning`, `critical`) and explain source gaps, contradictions, language drift, or other verification concerns.
- [ ] Conflicting evidence is preserved and represented in the report instead of choosing a false winner.
- [ ] Audit output drives visible honesty markers and Limitations content.
- [ ] Audit failure follows bounded retry policy and then produces honest limitations if enough evidence exists.
- [ ] Raw audit model payloads are not exposed in conversation detail or user-facing metadata.

### Technical notes

- Keep audit calls inside the same model boundary as other Atlas model calls.
- Use structured schemas for audit output and validate before rendering.
- Persist compact audit diagnostics on the job/checkpoint for cost summary and debugging.

### Suggested verification

- Unit tests for audit model resolution and same-model fallback warning.
- Structured output tests for all four honesty verdicts.
- Report-source tests proving conflicting sources render as conflicts.
- Usage/cost accumulation includes audit calls.

## ATLAS-10 - GeneratedDocumentSource assembly and HTML/PDF/Markdown file-production outputs

**Type / triage label:** `feature`, `file-production`, `document-workspace`

**Dependencies:** ATLAS-08, ATLAS-09

### What to build

Assemble the completed Atlas into a GeneratedDocumentSource and produce HTML, PDF, and Markdown sibling outputs through the existing file-production/document family infrastructure. The styled HTML Atlas is the primary output and opens by default in Document Workspace.

### Acceptance criteria

- [ ] The model produces content blocks/data for GeneratedDocumentSource; it does not write renderer CSS/JS.
- [ ] The app-owned deterministic standard report renderer owns shell, navigation, CSS, JS, source display, honesty markers, dark mode, and responsive layout.
- [ ] HTML is the primary generated file and default open target.
- [ ] PDF and Markdown are sibling outputs attached to the same file-production job/document family.
- [ ] All outputs share the same source artifact/document family identity.
- [ ] Images render with captions and underlined accent-colored source attribution links.
- [ ] Source chips are favicon-only circles with tooltips showing title and compact reasoning.
- [ ] Sources section separates Web Sources and Your Library, including spacing between sections.
- [ ] Continue and Revise can resolve the Atlas from GeneratedDocumentSource/document family, not PDF or Markdown projection.
- [ ] Renderer/storage failures fail the Atlas job because no trustworthy artifact can be created.

### Technical notes

- Extend `src/lib/server/services/file-production/` rather than adding a separate Atlas file storage path.
- Reuse and extend the existing pure, unit-testable standard report renderers instead of adding a parallel Atlas-only rendering stack.
- Avoid inline user-authored script. Any report JS should be deterministic app-owned JS.
- Reuse `DocumentWorkspace.svelte` and generated-file preview/download routes.

### Suggested verification

- Renderer unit tests for heading navigation, source chips, honesty markers, limitations, images, dark-mode classes/tokens, and EN/HU chrome where applicable.
- File-production integration test that produces HTML/PDF/Markdown siblings and opens the primary HTML in the read model.
- Download/preview tests for all sibling files.
- Visual Playwright screenshot checks for desktop and mobile report viewer.

## ATLAS-11 - Completion links files, records job usage, and skips assistant-prose memory intake

**Type / triage label:** `feature`, `chat-turn`, `memory-safety`

**Dependencies:** ATLAS-10

### What to build

Finish Atlas without admitting Atlas assistant prose into durable memory or Honcho enrichment. The kickoff path goes through Normal Chat Turn Completion; the background completion path links generated files/jobs to the kickoff assistant message, records usage/source/output state on the Atlas job, refreshes through conversation detail polling, and does not emit a second chat-turn, analytics event, or task-state continuity event.

### Acceptance criteria

- [ ] `finalizeChatTurn` exposes an explicit option to skip raw assistant-prose memory intake.
- [ ] The same option or a paired option skips Honcho enrichment/mirroring for Atlas kickoff/completion assistant prose.
- [ ] Atlas finalization still persists assistant message state and metadata.
- [ ] Atlas finalization still links generated files and file-production jobs to the assistant message.
- [ ] Atlas completion records profile, source counts, token usage/cost when available, generated-file ids, and outcome on the Atlas job.
- [ ] Atlas completion does not create a second analytics event or typed task-state continuity note.
- [ ] Completion does not run `intakePostTurnMemory` for Atlas content.
- [ ] Completion does not run Honcho enrichment for Atlas content.
- [ ] The Atlas Cost Summary is available after completion.
- [ ] Existing non-Atlas finalization behavior remains unchanged.

### Technical notes

- Current `finalize.ts` imports `intakePostTurnMemory`, `mirrorWorkCapsuleConclusion`, analytics, file-production linking, memory events, and maintenance. Add explicit options rather than forking finalization.
- Keep generated-file/job linking behavior aligned with existing file-production completion semantics.
- Evidence metadata should be compact and should not include raw source dumps.

### Suggested verification

- `finalizeChatTurn` tests proving skip-memory and skip-Honcho options suppress only those paths.
- Tests proving generated file/job linking and Atlas job usage/source/output state still happen when skip options are set.
- Regression test proving Atlas completion does not run assistant-prose memory intake, Honcho enrichment, or a second completion event.
- Regression tests for ordinary send/stream finalization.

## ATLAS-12 - Chat UI kickoff, progress, completion, sidebar badge, i18n, and dark mode

**Type / triage label:** `feature`, `ui`, `i18n`

**Dependencies:** ATLAS-01, ATLAS-02, ATLAS-03, ATLAS-11

### What to build

Implement the user-visible Atlas UI from the approved prototype: composer entry/profile selection, Atlas chip, send-route kickoff, progress polling, completion card actions, report open/download, sidebar badge, EN/HU chrome toggle behavior, and dark mode.

### Acceptance criteria

- [ ] Composer tools menu exposes Atlas only when SearXNG is configured and Atlas is enabled.
- [ ] When disabled, Atlas shows a localized explanation rather than a broken action.
- [ ] Profile picker supports Overview, In-Depth, and Exhaustive labels in English and Hungarian.
- [ ] The composer shows an Atlas chip such as `Atlas: In-Depth` and allows removal before send.
- [ ] Kickoff card uses the approved card style and animated Earth/plane-to-progress transition direction.
- [ ] Progress card shows `ATLAS`, ring animation, cycling human-readable status messages, and Cancel.
- [ ] Progress survives reload/navigation through conversation detail polling.
- [ ] Completion card shows title, profile name only, duration, source count, and cost summary.
- [ ] Completion card uses Open as the only text button.
- [ ] Download, Continue, Fork, and Revise are icon-only ghost buttons with hover tooltips.
- [ ] Continue/Fork/Revise open inline expansion panels below the card, not modals.
- [ ] Sidebar conversation list shows a simple colored circle badge for completed Atlas and coexists with the existing hover menu.
- [ ] Report viewer supports app dark mode through existing tokens and `.dark`/system preference behavior.
- [ ] All Atlas UI chrome, errors, empty states, tooltips, and accessibility strings are localized in EN and HU.
- [ ] UI uses Lucide icons where applicable and does not add hand-authored inline SVG icons except for allowed custom animation/artwork.

### Technical notes

- Keep cross-page orchestration in chat page/runtime adapters, not inside `MessageInput.svelte`.
- Add reusable browser API calls under `src/lib/client/api/`.
- Poll through conversation detail or a thin Atlas status endpoint that delegates to the read model.
- Match prototype decisions, but map color/spacing/typography to existing app tokens.
- Ensure text fits on mobile and desktop.

### Suggested verification

- Component tests for profile picker, chip, kickoff card, progress card, completion actions, and i18n parity.
- Playwright Atlas e2e for composer -> kickoff -> progress -> completion -> open report.
- Playwright mobile and desktop screenshots for light/dark report viewer and cards.
- Existing `tests/e2e/chat.spec.ts`, `conversation.spec.ts`, `streaming.spec.ts`, and `search-modal.spec.ts`.

## ATLAS-13 - Continue, Fork, and Revise lifecycle actions

**Type / triage label:** `feature`, `document-family`, `chat-turn`

**Dependencies:** ATLAS-10, ATLAS-11, ATLAS-12

### What to build

Implement Atlas lifecycle actions from the completion card. Continue and Revise create new Atlas versions in the same document family. Fork creates a new family. Each action creates a new Atlas Turn through the send-route kickoff/idempotency path and seeds the pipeline according to ADR semantics.

### Acceptance criteria

- [ ] Continue creates a new Atlas Turn with `parent_atlas_id` set to the previous Atlas and the same document family.
- [ ] Continue seeds from previous compressed findings and curated sources.
- [ ] Revise creates a new Atlas Turn with `parent_atlas_id` set to the previous Atlas and the same document family.
- [ ] Revise seeds from the previous GeneratedDocumentSource/structure and performs fresh searches.
- [ ] Fork creates a new Atlas Turn with `parent_atlas_id` set to the previous Atlas and a new document family.
- [ ] Fork may seed from parent compressed findings but follows a new query trajectory.
- [ ] Action idempotency includes action and parent Atlas id.
- [ ] Previous Atlas versions remain openable in document history.
- [ ] The original conversation remains open; Atlas never sets `sealedAt`.
- [ ] Lifecycle action UI uses inline panels and localized labels/tooltips.

### Technical notes

- Keep document-family identity owned by existing generated-document/file-production metadata.
- Do not create a separate Atlas versioning subsystem beyond the two Atlas tables and existing document family.
- Use the same kickoff/finalization path as a new Atlas, with action-specific seed state.

### Suggested verification

- Service tests for Continue/Revise same-family behavior and Fork new-family behavior.
- Idempotency tests per action.
- UI tests for inline panels and localized action labels.
- Conversation detail tests showing multiple Atlas versions without sealing the chat.

## ATLAS-14 - Optional app-level Web Push completion notices

**Type / triage label:** `feature`, `notifications`, `ops`

**Dependencies:** ATLAS-11, ATLAS-12

### What to build

Add reusable app-level Web Push infrastructure for Atlas completion notices as an optional layer. Atlas is the first producer, but the subscription, permission, service worker, and send logic should not be Atlas-specific. Missing push capability must not break polling or sidebar badges.

### Acceptance criteria

- [ ] Push subscription storage is app-owned and reusable.
- [ ] Permission UI is localized and does not block Atlas creation.
- [ ] Service-worker registration failure disables only browser push.
- [ ] Missing VAPID keys disables only browser push.
- [ ] Denied notification permission disables only browser push.
- [ ] Unsupported browser APIs disable only browser push.
- [ ] Atlas completion attempts to send a browser push when a usable subscription exists.
- [ ] On-page polling and sidebar badges still work without push.
- [ ] Push payload avoids sensitive raw report content and raw source text.
- [ ] Push cleanup handles expired/invalid subscriptions.

### Technical notes

- Treat this as app infrastructure. Place browser API calls and stores under existing app seams.
- Do not add a separate Atlas notification center.
- Keep production deployment docs/env updates in the implementation slice if VAPID keys are introduced.

### Suggested verification

- Unit tests for push capability gating and subscription cleanup.
- Browser tests for permission denied/unsupported states if feasible.
- Manual smoke in a supported browser during remote live test only if safe and configured.

## ATLAS-15 - Privacy lifecycle, data archive behavior, and Deep Research wording cleanup

**Type / triage label:** `privacy`, `docs`, `cleanup`

**Dependencies:** ATLAS-03, ATLAS-10, ATLAS-11

### What to build

Wire Atlas into existing account/workspace privacy lifecycle and clean historical Deep Research wording in named planning docs during implementation. This slice does not change current planning docs preemptively; it records implementation work that must happen once Atlas source changes exist.

### Acceptance criteria

- [ ] Clear Workspace Data cancels active Atlas jobs and deletes Atlas jobs, checkpoints, and generated Atlas files for the user.
- [ ] Clear Memory and Knowledge does not delete completed Atlas files because Atlas is workspace/generated-file output, not memory.
- [ ] Account Erasure cancels active Atlas jobs and deletes all user-owned Atlas rows and files.
- [ ] Account Data Archive includes produced Atlas files as generated files, not raw research state/checkpoints.
- [ ] Conversation deletion cancels/deletes conversation-scoped Atlas jobs and generated outputs according to existing generated-file cleanup rules.
- [ ] Active Atlas jobs cannot recreate deleted workspace records after a privacy action.
- [ ] Historical Deep Research references in `docs/context-access-v1-slices.md`, `docs/web-research-markdown-extraction-slices.md`, and `docs/deepen-conversation-detail-read-model-slices.md` are removed or marked historical.
- [ ] The Deep Research removal runbook remains only if intentionally historical.
- [ ] `CONTEXT.md` avoid-list wording remains clear that old Deep Research terms are not Atlas terms.

### Technical notes

- Integrate with existing cleanup/privacy services rather than adding a separate Atlas privacy route.
- Keep raw checkpoint/source state out of Account Data Archive unless a future ADR expands export scope.
- Search for stale terms as part of the implementation PR; do not blindly remove historical migration filenames or ADR history.

### Suggested verification

- Privacy-control tests for clear workspace, clear memory/knowledge, account erasure, conversation deletion, and account archive.
- Repo-wide search for live Deep Research wording outside accepted historical contexts.
- Account archive test proving Atlas files appear as generated files and checkpoints do not.

## ATLAS-16 - End-to-end test matrix and remote live rollout pass

**Type / triage label:** `testing`, `release`, `ops`

**Dependencies:** ATLAS-01 through ATLAS-15

### What to build

Complete the local and live verification story for Atlas. This issue is the release gate slice: it ties focused tests, migration checks, Fallow, Playwright, build gates, and remote live testing into one repeatable pass.

### Acceptance criteria

- [ ] Focused unit tests exist for each Atlas service slice.
- [ ] Migration checks pass with `npm run check:migrations`.
- [ ] Fresh DB prep passes with `npm run db:prepare` against a fresh database.
- [ ] Upgrade DB prep passes against an existing development database or fixture.
- [ ] Mandatory gates pass: `npm run check`, `npm run lint`, `npm test`, `npm run build`.
- [ ] Fallow runs with `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-atlas-fallow.json`.
- [ ] New Fallow findings are either fixed or justified as intentional public/dynamic boundaries.
- [ ] Playwright Atlas e2e covers kickoff, progress polling, completion, report open, download, cancel, and reload.
- [ ] Existing relevant e2e suites pass: chat, streaming, conversation, settings/admin/config, search modal, and knowledge where touched.
- [ ] Remote live deploy follows the remote-live-testing pass below.
- [ ] Live test uses a timestamped harmless Atlas prompt and confirms report open/download without destructive actions.

### Technical notes

- Keep tests behavior-focused at public seams per the TDD skill. Mock only external boundaries such as model provider, SearXNG, Web Push, or time.
- Prefer fake-provider/fake-search integration tests over tests that assert private stage call order.
- Use Playwright screenshots for report viewer and card states because the UI has visual acceptance requirements.

### Suggested verification

- All commands in Cross-Cutting Verification Gates.
- All steps in Remote Live Test Pass.

## Cross-Cutting Verification Gates

Run these before calling Atlas implementation complete:

```bash
npm run check:migrations
npm run db:prepare
npm run check
npm run lint
npm test
npm run build
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-atlas-fallow.json
```

Focused test areas by slice:

- Request parsing and transport: `chat-turn/request`, send route, stream route guard, client turn runtime.
- Persistence: Atlas job ledger, checkpoints, migration verification, conversation-detail read model.
- Worker: claim, heartbeat, stale recovery, cancellation, queue limits, config enable/disable.
- Sources: explicit linked sources, attachments, active working-set sources, parent seed sources, source unreadiness i18n.
- Search: SearXNG configured/missing, concurrency, batch delay, backoff, greater-than-50-percent failure limitation.
- Model pipeline: profile config, stage schema validation, normal-chat-model boundary, usage accumulation.
- Quality/audit: bounded retries, honest degraded output, Atlas Basis, honesty markers, cross-model audit fallback.
- File output: GeneratedDocumentSource, HTML primary output, PDF/Markdown siblings, preview/download.
- Finalization: skip memory intake/Honcho, keep kickoff analytics/file linking, and do not emit a second task-state continuity event for background completion.
- UI: composer entry, profile picker, chip, kickoff/progress/completion cards, sidebar badge, report viewer, dark mode, EN/HU parity.
- Privacy: clear workspace, clear memory/knowledge, account erasure, account archive, conversation deletion.

Playwright matrix:

```bash
npx playwright test tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts
npx playwright test tests/e2e/settings-admin.spec.ts tests/e2e/search-modal.spec.ts tests/e2e/knowledge.spec.ts
npx playwright test tests/e2e/atlas.spec.ts
```

The exact Atlas e2e filename can vary, but it should cover:

- SearXNG missing disables Atlas with localized explanation.
- SearXNG configured allows profile selection and send-route kickoff.
- Reload during running job restores progress card from conversation detail.
- Cancel stops progress and does not resume.
- Completion shows Open plus icon-only Download/Continue/Fork/Revise.
- Open launches the HTML Atlas in Document Workspace.
- Download exposes PDF and Markdown sibling outputs.
- Source chips, honesty markers, limitations, and Your Library/Web Sources sections render.
- Dark mode and mobile layout do not overlap or clip text.

## Remote Live Test Pass

Use the remote-live-testing skill after local Atlas implementation is merged to the deploy branch and local verification passes.

Local preflight:

```bash
git status --short --branch
npm run check:migrations
npm run db:prepare
npm run check
npm run lint
npm test
npm run build
npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-atlas-fallow.json
```

Deploy and service health:

```bash
ssh alfydesign
cd ~/apps/langflow-chat
git status --short --branch
./scripts/deploy.sh
sudo systemctl restart langflow-chat.service
sudo systemctl is-active langflow-chat.service
sudo systemctl status langflow-chat.service --no-pager -n 20
curl -s http://localhost:3001/api/health; printf '\n'
```

Expected health:

```json
{"status":"OK"}
```

Journal inspection:

```bash
journalctl -u langflow-chat.service --since '15 minutes ago' --no-pager -n 160
journalctl -u langflow-chat.service --since '15 minutes ago' --no-pager -n 160 | grep -Ei 'error|failed|warn|ATLAS|CHAT_STREAM|FILE_PRODUCTION|MEMORY_MAINTENANCE|Listening|Started' || true
timeout 60s journalctl -u langflow-chat.service -f --no-pager
```

Live UI smoke:

- Open `https://ai.alfydesign.com/login`.
- Sign in with the test account from the remote-live-testing skill.
- Confirm the app shell loads.
- Confirm Atlas availability reflects live SearXNG/config state.
- If Atlas is enabled, submit a timestamped harmless prompt such as `Atlas live smoke 2026-06-19T12:00:00Z: create an overview Atlas about the public history of SvelteKit routing documentation.`
- Verify the send-route kickoff card appears without opening a stream.
- Leave/reload the chat and confirm progress restores.
- Watch journal logs for `[ATLAS]`, `[FILE_PRODUCTION]`, and unexpected errors.
- Let the job finish or use a controlled fake/short live profile if available.
- Verify completion card metadata, Open button, download menu, report open in Document Workspace, and PDF/Markdown downloads.
- Confirm no Honcho/memory-enrichment logs are emitted for Atlas content.
- Confirm `/api/health` remains OK after the run.

If Web Push is configured:

- Grant permission in the test browser.
- Start a harmless Atlas prompt, leave the app, and confirm push notice arrives.
- Deny permission in a separate browser profile and confirm polling/sidebar badge still work.

Do not delete production data, clear real user data, or run destructive privacy actions during live smoke unless explicitly approved for that deployment.

## Rollout / Sequencing Notes

- Build ATLAS-01 and ATLAS-02 first to lock transport semantics before UI or worker complexity grows.
- Land ATLAS-03 early because every later slice needs durable job state and migration discipline.
- ATLAS-04 can ship with a stub pipeline to validate worker lifecycle before model/search work is added.
- ATLAS-05 and ATLAS-06 should land before serious synthesis so source authority and SearXNG failure semantics are not retrofitted.
- ATLAS-07 through ATLAS-09 should use fake-provider and fake-search tests heavily before live model testing.
- ATLAS-10 should be verified visually before ATLAS-12 completion UI is considered done.
- ATLAS-11 must land before broad e2e because memory/Honcho exclusion is a core safety constraint.
- ATLAS-14 is optional and should not block v1 if polling and sidebar badge are solid.
- ATLAS-15 should happen near the end, when the final data ownership and cleanup paths are real enough to test.
- Remote live testing should happen only after local migration, build, Fallow, and Playwright gates are clean.

## Open Risks / Unknowns

- The exact `normal-chat-model` programmatic API for structured non-chat stage calls may need deepening. That work belongs inside `normal-chat-model`, not in Atlas routes.
- The current file-production renderers may not yet support an Atlas-specific HTML shell plus PDF/Markdown sibling outputs from one GeneratedDocumentSource without extension.
- Atlas search may need lower-level SearXNG batching than current `researchWeb` exposes. If so, extract shared transport carefully rather than duplicating source canonicalization.
- Web Push introduces new app-level infrastructure and deployment secrets. It should remain optional for v1 if it threatens core Atlas delivery.
- Long-running live Atlas tests can consume model/search budget. Remote smoke should use an Overview profile or a safe short-test config when available.
- Existing Deep Research migrations/history are not automatically stale docs. Cleanup should target named planning docs and live wording, not historical migration filenames.
- Atlas checkpoint JSON shape needs versioning from day one to avoid unrecoverable resume state after future pipeline changes.
- Quality gates must be strict enough to block fabrication but bounded enough to avoid infinite work. This needs fake-pipeline tests with thin evidence, contradictory evidence, and search-rate-limit scenarios.
