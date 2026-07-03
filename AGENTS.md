# AGENTS.md

**Generated:** 2026-04-06 15:20 UTC  
**Commit:** 2322eed  
**Branch:** main  

This file is the canonical engineering map for AlfyAI. Read it before changing code. Public setup, deployment, and environment documentation live in [README.md](./README.md). Product and design notes in other docs are supplemental, not the source of truth for code placement.

## Mandatory Docs Check

- Before touching code, check current documentation through Context7 and the Svelte/SvelteKit MCP docs tools for the relevant framework or library surface.
- This is especially required for Svelte, SvelteKit, Tailwind, Vitest, Playwright, Drizzle, and any fast-moving integration used by this app.
- Do not write framework code purely from memory when an MCP-backed docs check can confirm the current API or recommended pattern.
- The goal is to avoid stale code, deprecated patterns, and implementations that drift away from the real versions used in this repo.
- If the Svelte MCP/docs tool is unavailable in the current session, use the best available official docs path before coding and call out that fallback explicitly.

## Fallow Audit Gate

- Before calling a patch finished, run Fallow against the current worktree, for example `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-fallow.json`.
- Treat new Fallow findings as regressions unless they are intentional public API, dynamic entry points, or known architectural debt documented in `.fallowrc.json`.
- Do not add broad `ignoreExports`, `ignorePatterns`, or rule suppressions just to make the report green. Every new ignore must describe a real public boundary, dynamic loader, standalone script, or false positive.
- If a change intentionally affects the remaining circular-dependency debt, rerun Fallow and report whether the five known cycle findings changed.

## Typecheck Gate

- Before calling a patch finished, run `npm run check` and keep it fully clean: 0 errors and 0 warnings.
- Treat new `svelte-check` diagnostics as regressions. Fix them in the same patch unless the user explicitly asks to defer them.
- If `npm run check` fails because of pre-existing diagnostics unrelated to the patch, report the exact current count and files, and do not introduce any new diagnostics.

## Svelte 5 Migration Rules

- Prefer Svelte 5 callback props over `createEventDispatcher` for component-to-parent communication.
- Prefer `$props()` and typed `PageProps` / `LayoutProps` in SvelteKit route components.
- Prefer modern event attributes like `onclick` and `onsubmit` over legacy `on:` directives in touched files.
- In rune components, declare `bind:this` refs with `$state(...)` when the ref is later read by effects or handlers.
- Touch event attributes are passive by default in Svelte 5. If a handler truly needs `preventDefault()` (for example custom touch dragging), attach a non-passive listener via an action or explicit `addEventListener`, not legacy event modifiers.
- Prefer `{@render children()}` in layouts over legacy route `<slot />` usage.
- Do not introduce new `afterUpdate` or `beforeUpdate` calls; use a modern effect- or action-based approach instead.
- Do not introduce new legacy `<slot>` usage in app components; prefer explicit props or snippets when composition is needed.
- Legacy syntax that still exists in untouched files is migration debt, not a pattern to copy forward.

## Purpose

- Use the existing boundaries in this file before inventing new ones.
- Optimize for reliability, low duplication, and clear ownership.
- Keep behavior stable at the route, SSE, DB, and component-contract layers unless the change is explicitly intended to alter those contracts.
- Prefer extending an existing subsystem over adding a new top-level service, store, or client helper.

## Core Rules

- Routes are adapters. Durable logic belongs in server services, client API modules, stores, or shared helpers.
- Shared behavior should exist once. Do not copy logic between `send` and `stream`, between multiple stores, or between multiple services.
- Composer command and skill work belongs in explicit app-owned boundaries: composer UI in `src/lib/components/chat/MessageInput.svelte` and related chat command components, browser fetch logic in `src/lib/client/api/skills.ts`, durable skill/session/note behavior in `src/lib/server/services/skills/`, chat-turn parsing and prompt integration in `src/lib/server/services/chat-turn/`, and Skill Note artifact behavior through the knowledge service boundary. Do not hide skill persistence, note writes, command parsing, or Skill Control Envelope handling in route-local closures.
- Runtime config flows through `src/lib/server/config-store.ts`. Do not bypass it in code that should respect admin overrides.
- New Composer Command, Skill, Skill Session, Skill Note, and Linked Source UI labels, errors, confirmations, empty states, and accessibility strings must be localized in both English and Hungarian.
- TEI embedder/reranker transport belongs in thin server services. Do not bury retrieval authority or semantic tie-break logic inside the raw TEI clients.
- `src/lib/server/env.ts` owns environment parsing, including `getDatabasePath()` for DB bootstrap-only access. Do not read `DATABASE_PATH` directly anywhere else.
- `src/lib/server/db/index.ts` is connection/bootstrap only. Do not reintroduce runtime schema mutation there.
- TEI embedding persistence belongs in the shared `semantic_embeddings` store, not in per-feature side tables. Keep artifact and task semantic storage on the same substrate; legacy `persona_cluster` embedding rows may exist, but do not revive a local persona-cluster pipeline around them.
- `src/lib/server/services/semantic-embedding-refresh.ts` owns async embedding refresh/backfill orchestration. Mutation boundaries may queue refresh work there, and maintenance may run the slower backfill sweep there, but routes should not open-code subject hashing, TEI embedding calls, or per-domain refresh loops.
- `src/lib/server/services/semantic-ranking.ts` owns generic embedding-based shortlist math. Domain services such as `knowledge/store/documents.ts` may compose it with their own deterministic filters and rerank rules, but they should not each reimplement vector similarity from scratch.
- `src/lib/server/services/tei-observability.ts` owns compact TEI retrieval summaries. Domain services may report shortlist/rerank latency, fallback reasons, candidate counts, and winner mode there, but do not create route-local debug spam or a second telemetry vocabulary for the same semantic paths.
- `src/lib/server/services/task-state.ts` may use semantic shortlist and rerank signals when routing the current turn onto an existing task, but active/revived/candidate truth and project continuity state still remain deterministic there.
- `src/lib/client/conversation-session.ts` owns landing-to-chat handoff state. Do not scatter raw `sessionStorage` keys across pages or components.
- `src/lib/client/api/` owns reusable browser `fetch` logic. Stores should not become ad hoc HTTP clients.
- `src/lib/services/stream-protocol.ts` owns shared stream-tag parsing helpers and completed-response control-tag cleanup. `src/lib/services/ai-sdk-ui-stream-contract.ts` owns AI SDK UI stream frame encoding, complete-block decoding, terminal detection, and metadata extraction for Normal Chat stream/reconnect/browser responses. `src/lib/server/services/chat-turn/stream.ts` owns runtime emission helpers for text, reasoning, tool/data, replay, metadata, finish, and `[DONE]` parts through that shared contract. Do not duplicate inline thinking-tag parsing, final visible-text extraction, UI stream frame builders, terminal checks, or event line-prefix parsers across `streaming.ts`, `chat-turn/normalizer.ts`, `chat-turn/stream*.ts`, and the chat stream route.
- `src/lib/services/streaming.ts` owns the browser stream transport contract, including the distinction between a user-requested stop and a local detach during navigation/unmount. Do not collapse those paths back into one generic abort that marks background disconnects as explicit stops.
- `src/lib/server/services/messages.ts` owns persisted assistant-message metadata such as evidence summaries and Honcho diagnostics/snapshots. Do not invent route-local shadow storage for those fields.
- `src/lib/server/services/normal-chat-context.ts` owns Normal Chat prompt assembly, including always-on date-before-search guidance and file-production guidance. Do not reintroduce route-local prompt guards for freshness-sensitive search behavior.
- `src/lib/server/services/web-grounding.ts` owns Normal Chat web grounding payloads: model-safe `research_web` source/evidence shaping, grounded web candidates/metadata, citation URL extraction, and citation-audit source extraction. Do not duplicate web source canonicalization or research evidence payload shaping inside tools, routes, or citation audit code.
- `src/lib/model-context-defaults.ts` owns shared context-window derived defaults, and `src/lib/server/services/provider-model-runtime-defaults.ts` owns provider-model runtime/persistence projection for context limits, max output tokens, reasoning, and thinking. Env parsing, config-store overrides, provider-model seeding, context budgeting, prompt-limit resolution, and Normal Chat Model Run must consume those defaults instead of duplicating ratio math.
- `src/lib/server/services/normal-chat-stability-snapshot.ts` owns content-free Normal Chat stability diagnostics for streams, providers, tools, web grounding, context defaults, and maintenance. Admin routes may expose that snapshot after authorization, but they must not leak prompts, messages, queries, raw source text, API keys, or user ids.
- `src/lib/server/services/normal-chat-model/` owns Vercel AI SDK/OpenAI-compatible model execution for Normal Chat, including plain/streaming provider-attempt policy, timeout failover, provider rate-limit fallback, unsupported-tool fallback, provider usage mapping, and neutral model-run events; `src/lib/server/services/normal-chat-tools/` owns app-backed AI SDK tools and their shared execution envelope. Do not reintroduce provider retry policy in chat-turn routes/orchestrators, hand-roll per-tool timeout/abort/recording shells, or add a hidden external orchestration runtime for these paths.
- `src/lib/server/services/title-generator.ts` owns language-aware title prompt selection and code-specific title prompt appendices, while the prompt text itself flows through `src/lib/server/config-store.ts` and admin settings.
- `src/lib/server/services/task-state.ts` is the continuity boundary. Do not reintroduce a parallel `project-memory` architecture.
- `src/lib/server/services/honcho.ts` is for Honcho-specific behavior only. Do not let it become a second generic prompt/memory engine.
- `src/lib/server/services/task-state/control-model.ts` is still for structured control-model work such as routing, verification, and semantic JSON tasks. Do not route TEI reranking back through that chat-completions path.
- `src/lib/server/services/semantic-embeddings.ts` owns durable embedding persistence for artifacts, legacy persona-cluster rows, and task states. Do not hide embedding upserts or source-text hashing in route files or domain-specific side helpers.

## App Map

### Request Bootstrap

- [`src/hooks.server.ts`](./src/hooks.server.ts)
  - Validates the session cookie.
  - Attaches the current user to `locals`.
  - Refreshes runtime config overrides.
  - Starts optional maintenance work.
- [`src/routes/(app)/+layout.server.ts`](<./src/routes/(app)/+layout.server.ts>)
  - Preloads conversations, projects, models, and user-facing config.
  - This is the main bridge between server state and the authenticated app shell.
- [`src/routes/(app)/+layout.svelte`](./src/routes/(app)/+layout.svelte)
  - Owns client-side conversation-list refresh on focus/visibility.
  - Missing-current-conversation redirects must verify the conversation detail endpoint before sending the user back to `/`; a brand-new bootstrap chat can exist before the sidebar list includes it.

Do not:

- duplicate session/bootstrap checks inside every child route unless the route truly has extra requirements
- fetch the same layout data again in child pages unless the data is page-specific and cannot come from layout

### Client Shell And Page Boundaries

- [`src/routes/(app)/+page.svelte`](./src/routes/(app)/+page.svelte)
  - Landing page.
  - Prepares a draft conversation and stores the first pending message before navigation.
  - Must validate any stored landing draft conversation before reuse; only empty default-title prepared conversations are eligible for reuse from session state.
  - Owns the landing-to-chat visual handoff: once the first message is sent, the landing composer should transition into a bottom-docked "opening chat" state instead of staying centered like the idle hero surface.
  - First-message sends may use a full document navigation to `/chat/[conversationId]` after storing the pending message so deploy/restart edge cases cannot leave the browser visually stuck on the landing route while the new chat already runs on the server.
- [`src/routes/(app)/chat/[conversationId]/+page.svelte`](./src/routes/(app)/chat/[conversationId]/+page.svelte)
  - Owns visible chat page state, route lifecycle hooks, draft persistence, document workspace state, and UI commands for an existing conversation.
  - Delegates Normal Chat browser-side send, retry, reconnect, waiting, stop, and queued follow-up runtime semantics to `src/lib/client/normal-chat-client-turn-runtime.ts`.
  - Keeps visible queued-turn preview and composer state through runtime adapters, while the runtime decides queued turn admission, restore, and drain ordering.
  - Owns route-level working-document workspace state. Which document is open, active, compared, or closed belongs here, not inside file-row or preview components.
  - The chat detail route should stay visually distinct from the landing page: the composer remains bottom-docked and the message surface stays visible even before the first persisted messages arrive.
  - Route-local `_components/` and `*_helpers.ts` files are acceptable for chat render scaffolding and pure page-only transforms, but Normal Chat client turn runtime semantics should stay in the client runtime module.
- [`src/routes/(app)/knowledge/+page.svelte`](./src/routes/(app)/knowledge/+page.svelte)
  - Large page-specific knowledge UI with a single primary content column.
  - Main content: Library and Memory Profile tabs.
  - Upload, search, and document-management behavior lives inside the main library panel.
  - Also owns the knowledge-side working-document workspace shell and cross-route workspace handoff from global search.
  - It may contain page-local fetches for page-only actions, but shared browser API logic should still move to `src/lib/client/api/` if reused.
- [`src/routes/(app)/settings/+page.svelte`](./src/routes/(app)/settings/+page.svelte)
  - User settings and admin/runtime config UI surface.
  - The Profile tab is grouped into Account, Preferences, Assistant, Data & privacy, and Your Activity sections (ADR 0043). Skills is a summary card that opens a dedicated full-screen manager. Personal analytics merged into Profile as "Your Activity"; the standalone Analytics tab is removed for normal users.
  - The Administration tab (admin only) is split into `System`, `Users`, and `Campaigns` panes, and also hosts system-level analytics (overview, per-user, excluded users) for admins.
  - Route-local `_components/`, `*_helpers.ts`, or `*.svelte.ts` files next to the page are acceptable when splitting page-only UI/controller logic without creating a new shared boundary.

Do not:

- move chat orchestration into shared visual components
- make `MessageInput.svelte` own cross-page navigation or conversation bootstrap decisions
- make `MessageInput.svelte` own queued-turn orchestration; it may emit `onQueue`, but the Normal Chat Client Turn Runtime decides queued-turn admission, auto-send, and restore behavior through page-owned adapters
- let `MessageInput.svelte` retain a stale internal `conversationId` after the parent clears the prop; landing-page sends and uploads must fall back to the parent-owned prepared-conversation flow instead of silently targeting an old conversation
- turn page files into long-lived business-logic modules when a store/service/helper boundary already exists

### Chat Flow

- Route entrypoints:
  - [`src/routes/api/chat/send/+server.ts`](./src/routes/api/chat/send/+server.ts)
  - [`src/routes/api/chat/stream/+server.ts`](./src/routes/api/chat/stream/+server.ts)
  - [`src/routes/api/chat/stream/stop/+server.ts`](./src/routes/api/chat/stream/stop/+server.ts)
- Conversation detail hydration:
  - [`src/lib/server/services/conversation-detail/read-model.ts`](./src/lib/server/services/conversation-detail/read-model.ts)
    - Owns refreshable `/api/conversations/[id]` GET payload assembly for chat page load and browser hydration.
    - Assembles bootstrap and full detail payloads, including defaults, child-fork message decoration, Context Sources projection, task-state continuity attachment, draft/generated-file/File Production/context-compression/cost fields, and active Skill Session public serialization.
    - The route GET handler stays an auth/HTTP adapter that delegates to `getConversationDetail(...)`.
- Shared pipeline:
  - [`src/lib/server/services/chat-turn/request.ts`](./src/lib/server/services/chat-turn/request.ts)
  - [`src/lib/server/services/chat-turn/preflight.ts`](./src/lib/server/services/chat-turn/preflight.ts)
  - [`src/lib/server/services/chat-turn/normalizer.ts`](./src/lib/server/services/chat-turn/normalizer.ts)
    - Canonical assistant-output normalization for send, stream, retry, and title generation.
  - [`src/lib/server/services/chat-turn/stream-orchestrator.ts`](./src/lib/server/services/chat-turn/stream-orchestrator.ts)
    - Orchestrates the full chat-turn streaming pipeline: neutral Normal Chat model-run events, tool-call marker handling, token/thinking framing, stream buffer management.
    - Imported by: `src/routes/api/chat/stream/+server.ts`, `src/routes/api/chat/retry/+server.ts`
  - [`src/lib/server/services/chat-turn/stream.ts`](./src/lib/server/services/chat-turn/stream.ts)
    - Re-export hub for stream sub-modules:
      - [`thinking-normalizer.ts`](./src/lib/server/services/chat-turn/thinking-normalizer.ts)
  - [`src/lib/server/services/chat-turn/active-streams.ts`](./src/lib/server/services/chat-turn/active-streams.ts)
  - [`src/lib/server/services/chat-turn/finalize.ts`](./src/lib/server/services/chat-turn/finalize.ts)
  - [`src/lib/server/services/chat-turn/types.ts`](./src/lib/server/services/chat-turn/types.ts)
- Upstream integrations:
  - [`src/lib/server/services/normal-chat-context.ts`](./src/lib/server/services/normal-chat-context.ts)
    - Owns model-facing prompt assembly, outbound search/date guidance, context fit, and authenticated account-level prompt personalization fields such as display name and email.
  - [`src/lib/server/services/normal-chat-model/`](./src/lib/server/services/normal-chat-model/)
    - Owns Vercel AI SDK/OpenAI-compatible plain and streaming model execution, provider-attempt/failover policy, provider usage mapping, tool-call events, and neutral model-run events.
  - [`src/lib/server/services/provider-model-runtime-defaults.ts`](./src/lib/server/services/provider-model-runtime-defaults.ts)
    - Owns provider-model runtime and persistence defaults for context limits, max output tokens, reasoning effort, and thinking mode.
  - [`src/lib/server/services/normal-chat-stability-snapshot.ts`](./src/lib/server/services/normal-chat-stability-snapshot.ts)
    - Owns content-free operational stability snapshots for Normal Chat streams, providers, tools, web grounding, context limits, and maintenance metrics.
  - [`src/lib/server/services/normal-chat-tools/`](./src/lib/server/services/normal-chat-tools/)
    - Owns app-backed AI SDK tools such as `produce_file`, `research_web`, `image_search`, and `memory_context`, plus the shared tool execution envelope for timeout, abort, model-safe failure, and recorder behavior.
  - [`src/lib/server/services/normal-chat-control-model.ts`](./src/lib/server/services/normal-chat-control-model.ts)
    - Owns structured JSON control-model calls used by context compression and similar control tasks.
  - [`src/lib/server/services/title-generator.ts`](./src/lib/server/services/title-generator.ts)
  - [`src/lib/server/services/messages.ts`](./src/lib/server/services/messages.ts)
  - [`src/lib/server/services/message-evidence.ts`](./src/lib/server/services/message-evidence.ts)
    - Owns evidence channel types for document-backed artifacts
- Chat-generated files and durable file production:
  - [`src/routes/api/chat/files/produce/+server.ts`](./src/routes/api/chat/files/produce/+server.ts)
  - [`src/routes/api/chat/files/jobs/[id]/retry/+server.ts`](./src/routes/api/chat/files/jobs/[id]/retry/+server.ts)
  - [`src/routes/api/chat/files/jobs/[id]/cancel/+server.ts`](./src/routes/api/chat/files/jobs/[id]/cancel/+server.ts)
  - [`src/routes/api/chat/files/[id]/download/+server.ts`](./src/routes/api/chat/files/[id]/download/+server.ts)
  - [`src/routes/api/chat/files/[id]/preview/+server.ts`](./src/routes/api/chat/files/[id]/preview/+server.ts)
  - [`src/lib/server/services/chat-files.ts`](./src/lib/server/services/chat-files.ts)
- [`src/lib/server/services/file-production/`](./src/lib/server/services/file-production/)
  - [`index.ts`](./src/lib/server/services/file-production/index.ts) is the public facade; keep callers on this boundary unless they are inside file-production internals.
  - [`read-model.ts`](./src/lib/server/services/file-production/read-model.ts) owns read-only conversation/job card projection, legacy generated-file backfill, internally-visible job-linked file hydration without loading the worker/rendering/storage graph, and the dismissed-job filter (dismissed failed/cancelled jobs are excluded from the conversation-detail job list unless explicitly requested — see ADR 0043).
  - [`job-ledger.ts`](./src/lib/server/services/file-production/job-ledger.ts) owns durable job, attempt, retry, cancellation, stale-recovery, dismiss (persisted acknowledged-flag for failed/cancelled jobs — see ADR 0043), and produced-file-link state transitions.
  - [`worker-runner.ts`](./src/lib/server/services/file-production/worker-runner.ts) owns worker identity, startup recovery, lazy wakeup, drain-to-idle execution, and current-attempt orchestration.
  - [`execution-adapter.ts`](./src/lib/server/services/file-production/execution-adapter.ts) owns persisted request parsing plus document-source renderer or sandbox program dispatch.
  - [`storage-adapter.ts`](./src/lib/server/services/file-production/storage-adapter.ts) owns output validation, generated-file storage, job-file linking, source-first produced-file mapping, and post-success memory sync.
- [`src/lib/components/chat/FileProductionCard.svelte`](./src/lib/components/chat/FileProductionCard.svelte)
- [`src/lib/components/document-workspace/DocumentWorkspace.svelte`](./src/lib/components/document-workspace/DocumentWorkspace.svelte)
- Generated files and production job refresh:
  - [`src/lib/services/streaming.ts`](./src/lib/services/streaming.ts) — `StreamMetadata.generatedFiles` field
  - Stream completion links new file-production jobs and any produced chat files to the persisted assistant message so job-backed cards survive refreshes
  - Conversation detail returns `fileProductionJobs` alongside `generatedFiles`; legacy chat files are backfilled into succeeded job rows by the file-production service
  - Chat page refreshes conversation detail after file-producing turns and while queued/running production jobs exist
  - [`src/routes/api/chat/files/produce/+server.ts`](./src/routes/api/chat/files/produce/+server.ts) stays an auth/HTTP adapter; `src/lib/server/services/file-production/` owns intake parsing, validation, durable job creation/reuse, failed-job persistence, and worker wakeup
  - File-production state and execution rules stay in the deep modules behind the facade. Do not put job ledger transitions, worker drain loops, persisted request parsing, renderer dispatch, or generated-file storage/linking back into `index.ts`, routes, renderers, or chat-file services.
  - The Conversation Detail Read Model may import `file-production/read-model.ts` directly. General callers may use the public facade, but must not make read paths eagerly load worker-runner, renderer, sandbox, Honcho, or generated-file storage modules.
  - Source-first generated-document source artifacts start as pending and non-durable, promote to durable only after rendered files attach successfully, and stay non-prompt-eligible if rendering/storage fails before attachment.
  - [`src/lib/server/sandbox/config.ts`](./src/lib/server/sandbox/config.ts) now ensures the sandbox runtime images exist before container creation, warms them in the background at app startup, and supports both the Python runtime (`python:3.11-slim`) and the JavaScript runtime (`node:22-bookworm-slim`)
  - [`src/lib/server/sandbox/config.ts`](./src/lib/server/sandbox/config.ts) must wait for exec inspection to report `Running === false` before the archive reader inspects `/output`; do not treat an early stream close as proof that the sandbox command has finished
  - [`src/lib/server/services/sandbox-execution.ts`](./src/lib/server/services/sandbox-execution.ts) must surface output-archive read failures as explicit execution errors instead of collapsing them into the same empty-file 422 path used for real zero-output runs
  - File-production/server tracing now mainly uses `[FILE_PRODUCTION]`, `[CHAT_STREAM]`, `[CHAT_FILES]`, `[NORMAL_CHAT_CONTEXT]`, `[HONCHO]`, and `[MEMORY_MAINTENANCE]`; preserve those prefixes when extending the debugging path so node logs stay grep-friendly

Do:

- put shared request parsing, attachment preflight, model normalization, stream framing, and finalization in `chat-turn/`
- put refreshable conversation detail GET payload assembly in `src/lib/server/services/conversation-detail/read-model.ts`; keep `src/routes/api/conversations/[id]/+server.ts` transport-oriented
- let `src/lib/server/services/chat-turn/stream-orchestrator.ts` and the stream submodules own shared upstream event parsing, tool-call marker handling, downstream token/thinking framing, and leading-output cleanup
- let `src/lib/server/services/chat-turn/normalizer.ts` normalize assistant text through the shared stream-protocol helpers so `/send`, `/stream`, retries, and title generation use the same visible content shape
- use `src/routes/api/chat/stream/stop/+server.ts` plus `chat-turn/active-streams.ts` for explicit user-requested aborts; do not overload passive disconnect handling for that purpose
- keep route files thin and transport-oriented
- preserve AI SDK UI stream part names and payload expectations unless the parser/UI/tests are intentionally updated together
- use `FileProductionCard.svelte` for rendering AI-generated files in chat; legacy generated files should be backfilled into succeeded file-production jobs before display
- use `document-workspace/DocumentWorkspace.svelte` plus route-owned state for in-chat document review; do not move active-document selection into generated-file rows or `DocumentPreviewRenderer.svelte`
- use `DocumentWorkspace.svelte` as the single shell for generated files, chat attachments, library opens, and search-result opens; do not reintroduce separate modal viewers for those surfaces
- keep the shared rich-preview stack lazy-loaded from `document-workspace/DocumentWorkspace.svelte`, `FileProductionCard.svelte`, and `document-workspace/DocumentPreviewRenderer.svelte`; do not static-import the heavy preview path back into the idle chat or knowledge shell
- keep generated-file downloads on the canonical `/api/chat/files/[id]/download` route; do not invent conversation-scoped download URLs
- `/api/chat/files/produce` may authenticate with either the signed-in session or a signed service assertion validated with `ALFYAI_API_SIGNING_KEY`; keep that service path conversation-scoped and internal
- keep outbound file-production guidance in `normal-chat-context.ts` aligned with the unified `produce_file` tool contract: source-first documents use `document_source`, program artifacts write final files to `/output`, and generated files show up as durable job-backed cards
- keep outbound file-production guidance explicit: when the user asks for a downloadable file and the tool exists, the model should call `produce_file` rather than merely describing a file in prose
- keep generated-document source model-friendly at the boundary: normalize simple table shapes such as `headers` plus array `rows` into canonical columns/rows, and normalize simple Chart.js-style chart data into renderer-safe chart rows
- keep the app-backed AI SDK `produce_file` tool scoped by server-owned `userId`, `conversationId`, and turn idempotency; do not expose those scope fields as model-facing inputs
- keep the model-facing output-list input named `requestedOutputs`, not `outputs`, so generated-document guidance and tool schemas stay aligned
- keep `produce_file` runtime guidance accurate: use `sourceMode: "document_source"` for PDF/DOCX/HTML reports from structured document source and `sourceMode: "program"` for code-generated data/office artifacts
- generated files may offer an authenticated rich preview via `/api/chat/files/[id]/preview`; reuse the shared file viewer component instead of maintaining a second chat-only preview UI
- working-document continuity should continue to build on generated-output artifacts plus Honcho sync.
- working-document continuity should prefer the shared resolver’s “current generated document” signal over generic latest-output heuristics. If a generated document is selected because of active focus or a query match, do not layer a second recency-only boost on top.
- keep document-selection observability compact and authority-scoped. Extend the `[CONTEXT] Working document selection` summary in `knowledge/context.ts` instead of reintroducing noisy per-artifact debug logs across routes.

Do not:

- duplicate turn logic between `send` and `stream`
- add new AI SDK UI stream part shapes casually; this touches browser parsing and tests
- hide persistence side effects inside route-local closures that only one endpoint can see
- couple provider transport details directly into page components
- duplicate stream-tag parsing or inline-thinking extraction between the browser stream consumer and `api/chat/stream/+server.ts`
- scatter freshness-sensitive search guards outside `normal-chat-context.ts`

### Knowledge And Context

- Public boundary:
  - [`src/lib/server/services/knowledge.ts`](./src/lib/server/services/knowledge.ts)
- Internal modules:
  - [`src/lib/server/services/knowledge/store.ts`](./src/lib/server/services/knowledge/store.ts)
  - [`src/lib/server/services/knowledge/store/core.ts`](./src/lib/server/services/knowledge/store/core.ts)
  - [`src/lib/server/services/knowledge/store/attachments.ts`](./src/lib/server/services/knowledge/store/attachments.ts)
  - [`src/lib/server/services/knowledge/store/documents.ts`](./src/lib/server/services/knowledge/store/documents.ts)
  - [`src/lib/server/services/knowledge/store/cleanup.ts`](./src/lib/server/services/knowledge/store/cleanup.ts)
  - [`src/lib/server/services/knowledge/upload-intake.ts`](./src/lib/server/services/knowledge/upload-intake.ts)
  - [`src/lib/server/services/knowledge/context.ts`](./src/lib/server/services/knowledge/context.ts)
  - [`src/lib/server/services/knowledge/capsules.ts`](./src/lib/server/services/knowledge/capsules.ts)
- Related services:
  - [`src/lib/server/services/working-set.ts`](./src/lib/server/services/working-set.ts)
  - [`src/lib/server/services/workspace-search.ts`](./src/lib/server/services/workspace-search.ts)
  - [`src/lib/server/services/document-resolution.ts`](./src/lib/server/services/document-resolution.ts)
  - [`src/lib/server/services/document-extraction.ts`](./src/lib/server/services/document-extraction.ts)
  - [`src/lib/server/services/evidence-family.ts`](./src/lib/server/services/evidence-family.ts)
  - [`src/lib/server/services/knowledge-labels.ts`](./src/lib/server/services/knowledge-labels.ts)
  - [`src/lib/server/services/tei-embedder.ts`](./src/lib/server/services/tei-embedder.ts)
  - [`src/lib/server/services/tei-reranker.ts`](./src/lib/server/services/tei-reranker.ts)

Responsibility split:

- `store.ts`
  - public facade for store internals
- `store/core.ts`
  - artifact CRUD
  - artifact mapping and shared selection helpers
- `store/attachments.ts`
  - attachment readiness
  - uploaded attachment persistence
  - auto-rename on file name conflicts
  - attachment linking and listing
- `store/documents.ts`
  - normalized-document creation
  - logical document listing
  - artifact query matching
  - document search composition consumed by Workspace Search
- generated chat files and uploaded attachments should converge on one working-document model built on the existing artifact backbone; do not create a parallel document persistence subsystem
- `store/cleanup.ts`
  - artifact deletion
  - cross-conversation reference checks
  - bulk cleanup actions
- `upload-intake.ts`
  - shared knowledge upload limits
  - optional conversation validation
  - uploaded source persistence through the store
  - normalized artifact creation, Honcho sync/fallback, prompt readiness, and upload trace output
- `context.ts`
  - relevant-artifact lookup
  - working-set and context status operations
  - context-related reads/writes used during chat
- `store/documents.ts`
  - artifact-level semantic shortlist retrieval for source/normalized/generated artifacts
  - lexical candidate fetch, embedding shortlist, and TEI rerank before handing results to higher-level document/focus authority
- `working-document-selection.ts`
  - live Working Document signal collapse for active workspace focus, current generated document, correction/refinement, move-on/reset, and caller-ready prompt/retrieval/task-evidence views
- `document-resolution.ts`
  - current/relevant generated-document family selection
  - shared query/focus-aware generated-document ordering
- `tei-embedder.ts` / `tei-reranker.ts`
  - thin Hugging Face Text Embeddings Inference clients only
  - semantic shortlist/rerank helpers should flow through higher-level retrieval services; these clients should not become a second ranking authority
  - rerank-shaped evidence/chunk/historical/tool call sites should prefer `tei-reranker.ts` over `task-state/control-model.ts`
- `capsules.ts`
  - work capsules
  - generated outputs
  - artifact-to-capsule mapping
  - workflow summary only, not document lineage authority

Do not:

- dump new unrelated knowledge behavior back into `knowledge.ts`
- mix file storage concerns with context-ranking heuristics in the same new helper
- place large retrieval heuristics in route files
- add a second parallel artifact service outside the `knowledge` boundary

### Knowledge Library

- Document workspace preview:
  - [`src/lib/components/document-workspace/DocumentWorkspace.svelte`](./src/lib/components/document-workspace/DocumentWorkspace.svelte)
  - [`src/lib/components/document-workspace/DocumentPreviewRenderer.svelte`](./src/lib/components/document-workspace/DocumentPreviewRenderer.svelte)

Rules:

- Direct library uploads through `/api/knowledge/upload` may omit `conversationId`; when present, Knowledge Upload Intake must validate that the conversation belongs to the user before any artifact insert or link write
- File versioning is NOT supported - single version per file
- Auto-rename on name conflicts (counter suffix) - no overwrite
- Import from Obsidian/Notion flattens hierarchy, stores original path in metadata
- File preview uses client-side libraries (PDF.js, Mammoth.js, SheetJS, PPTXjs) - no external services
- Storage quota is display-only - no enforcement
- Global Workspace Search surfaces conversation, project, message, and document hits through `/api/workspace-search`; document clicks should hand off into the knowledge-page working-document workspace instead of opening a separate modal path

Do not:

- add file versioning/history
- add in-app file editing
- allow AI to edit existing library files (AI generates NEW files only)
- add batch operations in v1
- add file deduplication (allow duplicates with auto-rename)
- use external hosted services for file preview

### Memory, Continuity, And Honcho

- Primary continuity/memory boundary:
  - [`src/lib/server/services/task-state.ts`](./src/lib/server/services/task-state.ts)
- Task-state internal modules:
  - [`src/lib/server/services/task-state/control-model.ts`](./src/lib/server/services/task-state/control-model.ts)
  - [`src/lib/server/services/task-state/continuity.ts`](./src/lib/server/services/task-state/continuity.ts)
  - [`src/lib/server/services/task-state/artifacts.ts`](./src/lib/server/services/task-state/artifacts.ts)
  - [`src/lib/server/services/task-state/chunk-sync.ts`](./src/lib/server/services/task-state/chunk-sync.ts)
  - [`src/lib/server/services/task-state/document-preferences.ts`](./src/lib/server/services/task-state/document-preferences.ts)
  - [`src/lib/server/services/task-state/mappers.ts`](./src/lib/server/services/task-state/mappers.ts)
- Honcho adapter:
  - [`src/lib/server/services/honcho.ts`](./src/lib/server/services/honcho.ts)
- Persona support:
  - Delegated to Honcho when enabled; local persona clustering has been removed.
- Event log:
  - [`src/lib/server/services/memory-events.ts`](./src/lib/server/services/memory-events.ts)
- Maintenance/orchestration:
  - [`src/lib/server/services/memory.ts`](./src/lib/server/services/memory.ts)
  - [`src/lib/server/services/memory-maintenance.ts`](./src/lib/server/services/memory-maintenance.ts)
- Shared helpers:
  - [`src/lib/server/utils/json.ts`](./src/lib/server/utils/json.ts)
  - [`src/lib/server/utils/text.ts`](./src/lib/server/utils/text.ts)
  - [`src/lib/utils/tokens.ts`](./src/lib/utils/tokens.ts)
  - [`src/lib/server/utils/prompt-context.ts`](./src/lib/server/utils/prompt-context.ts)

Rules:

- `task-state.ts`
  - public continuity facade
  - task routing, checkpoints, evidence-context assembly, and related summarization entrypoints
  - semantic shortlist/rerank assisted task revival/routing over the persisted `task_state` embeddings
- `task-state/control-model.ts`
  - context summarizer and control-model helpers used by task-state internals
- `task-state/continuity.ts`
  - task memory and project continuity internals
  - keep project continuity status/event truth deterministic even when task routing gets smarter semantically
- `task-state/artifacts.ts`
  - task-state prompt formatting, prompt snippet selection, and historical-context summarization helpers
- `task-state/chunk-sync.ts`
  - artifact chunk splitting and persistence
- `task-state/document-preferences.ts`
  - family-aware working-document preference conflict detection
- `task-state/mappers.ts`
  - task-state row mappers shared by task-state internals
- `honcho.ts` should stay an integration adapter for Honcho sessions, peers, mirrored messages, and Honcho-specific context.
- Reset-grade cleanup that is meant to sever memory continuity must rotate the per-user Honcho peer identity, not just delete local rows or current Honcho sessions/conclusions. Reusing the same Honcho peer id after a reset is not a strong enough boundary.
- Read-side Honcho session memory should prefer Honcho’s canonical `session.queueStatus()` plus `session.context(...)` flow over manual multi-call fanout, but the chat-path call must stay session-limited. Do not pass `searchQuery` there without the required `peerTarget`, do not let live Honcho context widen into workspace-level retrieval when the intent is current-session recall, and skip live session-context reads entirely for genuinely empty/new sessions that have no stored turns or snapshot yet.
- Per-turn Honcho diagnostics and last-good Honcho snapshots belong in assistant-message metadata via `messages.ts`, not ad hoc route state.
- `buildConstructedContext` must degrade gracefully when Honcho is disabled, unavailable, or slow. Core chat cannot block on Honcho connectivity or empty-session bootstrap, but the chosen Honcho source for each turn must remain measurable and source-attributed.
- `getKnowledgeMemory` and other knowledge-memory reads should treat Honcho conclusions and snapshots as the current persona-memory source. Do not block the Memory Profile on live Honcho overview generation.
- `memory.ts` owns Memory Profile overview source selection, cached Honcho overview reuse, and overview refresh backoff. Prefer source-attributed Honcho data when available, then degrade to stored conclusions or an empty state.
- Local persona clustering has been removed. Do not add new local temporal-truth, salience, or supersession logic outside the Honcho/memory boundary.
- Artifact retrieval and cleanup should treat linked conversation ownership as stronger authority than `artifacts.userId` alone. Conversation-scoped working artifacts such as `generated_output` and `work_capsule` are not valid retrieval candidates once their conversation link is gone, even if a stale row survives in SQLite.
- `memory-events.ts` owns the persisted normalized event log for important state changes such as deadlines, preference updates, persona fact replacement, project continuity transitions, and document supersession. Add new event types there and emit them from the existing state-change boundaries; do not create ad hoc side logs or route-local event tables.
- `task-state/continuity.ts` now also consumes the latest task-domain project events on the read path. If a newer `project_paused` or `project_resumed` event exists, continuity summaries should prefer that signal over an older still-active row.
- User-selected task evidence preferences should stay family-aware for working documents. If a user pins or excludes one version inside a document family, clear contradictory user preference links for sibling versions in that same family instead of letting multiple versions stay preferred at once.
- Live Working Document selection signals (active workspace focus, current generated document, correction/refinement, move-on/reset) belong in `src/lib/server/services/working-document-selection.ts`. Recompute carryover per turn rather than trusting stale reason codes.
- `memory-maintenance.ts` owns per-user maintenance scheduling. Chat-triggered maintenance must stay serialized and debounced there; do not trigger heavy continuity or embedding repair directly from routes or UI code.
- `memory-maintenance.ts` is also the lazy semantic-embedding backfill path. Missing or stale artifact/task embeddings should be repaired there rather than blocking chat routes or artifact writes. Treat legacy persona embedding repair as migration cleanup, not a new local persona-memory feature.
- Generated-output duplicate repair should also run through `memory-maintenance.ts`, not as a separate ad hoc sweep. Reuse `evidence-family.ts` retrieval-class repair so low-value near-duplicate drafts stay compressed out of broad retrieval while document history still remains available through the working-document system.
- Generated-document lifecycle state should stay on the existing working-document metadata contract. If a generated-document family becomes dormant, let `memory-maintenance.ts` and `evidence-family.ts` mark the latest family representative as `historical`; do not create a second document-lifecycle table or route-local stale-document cache for that purpose.
- keep Knowledge Memory observability on the existing overview boundary. `memory.ts` now logs a single `[KNOWLEDGE_MEMORY] Selected overview source` summary; do not add route-local overview-source logging when the source decision already happened there.
- Historical working-document families are soft-deprioritized, not hidden. If maintenance has already marked a family `historical`, retrieval and prompt carryover may apply a bounded ranking penalty, but explicit query/document matches and direct source navigation must still work.
- Project continuity contradiction handling should stay in the existing continuity boundary: explicit pause/resume language may record task-domain events and update continuity state immediately, but the authoritative current status still belongs to `task-state/continuity.ts`, not Honcho or a route-local heuristic.
- Prompt-time persona recall belongs on the Honcho/memory boundary; do not build a second lexical/semantic persona search surface beside Honcho conclusions.
- Treat Honcho conclusion `createdAt` values as storage/observation timestamps, not proof of the real-world date of the remembered event. Prompt text must not invent "today/now" timing for undated persona events.

Do not:

- create a new top-level continuity service when `task-state.ts` can own the behavior
- copy `clip`, token estimation, JSON parsing, or prompt-compaction helpers into another service
- move generic prompt-section rendering into `honcho.ts`
- create or restore `project-memory.ts`; project continuity belongs in `task-state.ts` and `task-state/continuity.ts`

### Config And Environment

- Environment parsing:
  - [`src/lib/server/env.ts`](./src/lib/server/env.ts)
- Runtime merge and normalization:
  - [`src/lib/server/config-store.ts`](./src/lib/server/config-store.ts)
- Admin config route:
  - [`src/routes/api/admin/config/+server.ts`](./src/routes/api/admin/config/+server.ts)
- Admin user-management routes:
  - [`src/routes/api/admin/users/+server.ts`](./src/routes/api/admin/users/+server.ts)
  - [`src/routes/api/admin/users/[id]/+server.ts`](./src/routes/api/admin/users/[id]/+server.ts)
  - [`src/routes/api/admin/users/[id]/sessions/+server.ts`](./src/routes/api/admin/users/[id]/sessions/+server.ts)
- Settings loaders:
  - [`src/routes/(app)/settings/+page.server.ts`](<./src/routes/(app)/settings/+page.server.ts>)
  - [`src/routes/api/settings/+server.ts`](./src/routes/api/settings/+server.ts)

Notes:

- `env.ts` also owns `getDatabasePath()` for bootstrap-only DB path access.
- Title-generator prompt variants flow through `env.ts`, `config-store.ts`, and the admin system settings UI. Keep English/Hungarian base prompts and code-only appendices aligned across those layers.
- TEI endpoint/model tuning also flows through `env.ts` plus `config-store.ts`. Keep API keys env-only, keep runtime overrides on the non-secret fields, and keep the rollout plan in [docs/tei-retrieval-roadmap.md](./docs/tei-retrieval-roadmap.md) aligned with the live config surface.
- `config-store.ts` remains the override-aware runtime config boundary. `getDatabasePath()` is for early DB/bootstrap code, not for general runtime settings reads.
- Context token limits are admin-configurable via `config-store.ts`:
  - `MAX_MODEL_CONTEXT` (default: 262144) - Maximum tokens the model context window supports
  - `COMPACTION_UI_THRESHOLD` (default: 209715) - UI warning threshold at 80% of max
  - `TARGET_CONSTRUCTED_CONTEXT` (default: 157286) - Target context size at 60% of max
  - Use getter functions in `config-store.ts` (e.g., `getMaxModelContext()`, `getCompactionUiThreshold()`, `getTargetConstructedContext()`) to read these values with admin overrides applied.

If you add a new runtime-configurable setting:

1. add env parsing/default handling in `env.ts` if it is environment-backed
2. add runtime normalization and override support in `config-store.ts`
3. expose it to the relevant settings/admin loaders and routes
4. update [README.md](./README.md) and [`.env.example`](./.env.example)

Do not:

- read directly from `process.env` or `env.ts` inside services that should respect admin overrides
- read `process.env.DATABASE_PATH` directly outside `env.ts`
- import override-aware runtime config into bootstrap code that only needs the DB file path
- document a config variable publicly without confirming it exists in real code paths
- add admin-configurable behavior in the UI without threading it through `config-store.ts`

### Sandbox Execution And File Production

- Sandbox configuration:
  - [`src/lib/server/sandbox/config.ts`](./src/lib/server/sandbox/config.ts)
- Sandbox execution service:
  - [`src/lib/server/services/sandbox-execution.ts`](./src/lib/server/services/sandbox-execution.ts)
- File production API:
  - [`src/routes/api/chat/files/produce/+server.ts`](./src/routes/api/chat/files/produce/+server.ts)
- Chat-linked file storage:
  - [`src/lib/server/services/chat-files.ts`](./src/lib/server/services/chat-files.ts)

Security model:

- **Container isolation**: Docker containers with no network access (`NetworkMode: 'none'`)
- **Non-root execution**: Containers run as UID 1000:1000, not root
- **Capability dropping**: All Linux capabilities dropped (`CapDrop: ['ALL']`, `Privileged: false`)
- **Resource limits**: 60s timeout, 1GB memory, 50MB max file size, 100 process limit
- **Readonly rootfs**: Container filesystem is readonly; writable tmpfs for `/output` and `/tmp`
- **In-memory extraction**: Generated files are collected in-memory only. Prefer the Docker archive path first, but keep the in-container `/output` inspection and controlled readback fallback available when archive reads miss tmpfs-backed outputs. Never write sandbox contents to host disk.
- **Path traversal protection**: Rejects `..`, absolute paths, null bytes, symlinks, devices
- **Aggregate limits**: Max 20 output files, 50MB total output
- **Image bootstrap**: The sandbox config auto-pulls the pinned base image on first use if it is missing, but the app process still needs working Docker daemon access and image-pull permission on the host

Do not:

- add network access to sandbox containers
- run containers as root
- write tar contents to host filesystem
- bypass timeout/resource limits
- add new languages without security review

### Database And Persistence

- DB bootstrap and Drizzle binding:
  - [`src/lib/server/db/index.ts`](./src/lib/server/db/index.ts)
- Schema:
  - [`src/lib/server/db/schema.ts`](./src/lib/server/db/schema.ts)
- Shared semantic embedding store:
  - [`src/lib/server/services/semantic-embeddings.ts`](./src/lib/server/services/semantic-embeddings.ts)
- Explicit DB prep:
  - [`scripts/prepare-db.ts`](./scripts/prepare-db.ts)

Legacy/avoidance notes:

`src/lib/server/db/compat.ts` is a narrow compatibility shim. Do not add new DB wrapper modules unless there is a verified compatibility need; new persistence logic should normally live in the relevant service and use `db` plus `schema.ts` directly.

Do not:

- put schema mutation back into `db/index.ts`
- create new mini repository layers for each table without a strong reason
- spread one feature's persistence logic across route handlers, DB wrapper modules, and service files at the same time
- add a table to `schema.ts` without a corresponding migration in `drizzle/` — every new `sqliteTable()` MUST have a matching `CREATE TABLE` migration file and a `_journal.json` entry. Run `npm run check:migrations` to verify this before committing.

### Browser API, Stores, And Session Handoff

- Shared browser API:
  - [`src/lib/client/api/_utils.ts`](./src/lib/client/api/_utils.ts) — shared list-unwrapping helper for API responses
  - [`src/lib/client/api/admin.ts`](./src/lib/client/api/admin.ts) — reusable admin-side user management browser calls
  - [`src/lib/client/api/auth.ts`](./src/lib/client/api/auth.ts)
  - [`src/lib/client/api/http.ts`](./src/lib/client/api/http.ts)
  - [`src/lib/client/api/conversations.ts`](./src/lib/client/api/conversations.ts)
  - [`src/lib/client/api/knowledge.ts`](./src/lib/client/api/knowledge.ts)
  - [`src/lib/client/api/workspace-search.ts`](./src/lib/client/api/workspace-search.ts)
  - [`src/lib/client/api/models.ts`](./src/lib/client/api/models.ts)
  - [`src/lib/client/api/projects.ts`](./src/lib/client/api/projects.ts)
  - [`src/lib/client/api/settings.ts`](./src/lib/client/api/settings.ts)
- Stores:
  - [`src/lib/stores/conversations.ts`](./src/lib/stores/conversations.ts)
  - [`src/lib/stores/projects.ts`](./src/lib/stores/projects.ts)
  - [`src/lib/stores/settings.ts`](./src/lib/stores/settings.ts)
  - [`src/lib/stores/avatar.ts`](./src/lib/stores/avatar.ts)
  - [`src/lib/stores/theme.ts`](./src/lib/stores/theme.ts)
  - [`src/lib/stores/ui.ts`](./src/lib/stores/ui.ts)
- Session handoff:
  - [`src/lib/client/conversation-session.ts`](./src/lib/client/conversation-session.ts)

Rules:

- `client/api/` owns reusable request/response parsing and shared HTTP behavior.
- `src/lib/client/api/auth.ts` owns reusable browser auth calls such as login and logout.
- `src/lib/client/api/conversations.ts` owns reusable browser conversation-detail, evidence, title, and steering calls.
- `src/lib/client/api/conversations.ts` also owns browser-side draft persistence and prepared-conversation deletion transport used by `conversation-session.ts`.
- `src/lib/client/api/knowledge.ts` owns reusable knowledge upload, library, and memory browser calls.
- `src/lib/client/api/workspace-search.ts` owns reusable browser calls for server-backed Workspace Search.
- `src/lib/client/api/models.ts` owns reusable model-list browser calls.
- `src/lib/client/api/settings.ts` owns reusable settings/account/avatar/admin/analytics browser calls.
- `src/lib/client/api/settings.ts` re-exports admin functions from `api/admin.ts` for backward compat; admin calls live in `api/admin.ts`
- stores own browser state, optimistic updates, and UI-facing transitions.
- `conversation-session.ts` owns landing draft IDs, pending first-message replay, previous-conversation markers, and draft cleanup rules.

Do not:

- put raw `fetch` + `res.ok` + JSON parsing boilerplate into stores
- open-code reusable browser auth, model, conversation-detail, evidence, title, steering, or knowledge fetches in pages/components when they can live in `src/lib/client/api/`
- open-code settings/admin/analytics browser fetches in `settings/+page.svelte` when they can live in `src/lib/client/api/settings.ts`
- invent new `sessionStorage` keys in components or pages when the conversation-session helper should own them
- make stores mutate unrelated domains because it feels convenient
- move reusable HTTP error handling into page files

### Additional Active Services

These services are actively imported but not documented in the feature sections above:

- Server utilities and helpers:
  - [`src/lib/server/auth/hooks.ts`](./src/lib/server/auth/hooks.ts) — `requireAuth`, `getBearerToken` helpers. Canonical auth enforcement point for API routes; mirrors `hooks.server.ts` logic in a reusable form.
  - [`src/lib/server/services/attachment-trace.ts`](./src/lib/server/services/attachment-trace.ts) — logging helper for chat/file-production tracing. Adds `[FILE_PRODUCTION]`, `[CHAT_STREAM]`, `[CHAT_FILES]` correlation context. Consumed by stream-orchestrator and file-production services.
  - [`src/lib/server/services/language.ts`](./src/lib/server/services/language.ts) — language detection utilities. Consumed by chat-turn request handling and title prompt selection.
  - [`src/lib/server/services/conversation-drafts.ts`](./src/lib/server/services/conversation-drafts.ts) — draft management for conversations. Used by conversation routes for draft save/load.
  - [`src/lib/server/prompts.ts`](./src/lib/server/prompts.ts) — shared prompt configuration helpers. Consumed by Normal Chat context assembly and Honcho.
  - [`src/lib/server/api/responses.ts`](./src/lib/server/api/responses.ts) — shared JSON response helpers (`createJsonErrorResponse`, `createJsonResponse`) for API routes. Used across route files for consistent error/success formatting.
  - [`src/lib/server/services/analytics.ts`](./src/lib/server/services/analytics.ts) — analytics event ingestion plus the Analytics Dashboard Read Model. Event ingestion is consumed by chat-turn finalization; `getAnalyticsDashboardReadModel(...)` owns `/api/analytics` payload assembly for personal, admin system, per-user, timeline, and mock analytics. `src/routes/api/analytics/+server.ts` stays a route adapter for auth, query parameters, and JSON response mapping.
  - [`src/lib/server/services/file-production/`](./src/lib/server/services/file-production/) — durable file-production jobs, source validation, renderers, sandbox execution, retry/cancel, and legacy generated-file backfill.

- Other API endpoints:
  - [`src/routes/api/chat/stream/buffer/+server.ts`](./src/routes/api/chat/stream/buffer/+server.ts) — stream buffer replay for reconnection
  - [`src/routes/api/chat/stream/status/+server.ts`](./src/routes/api/chat/stream/status/+server.ts) — stream capacity/status check
  - `src/routes/api/favicon/+server.ts` — same-origin favicon proxy (ADR 0043). Unauthenticated-safe, source-site `/favicon.ico` first with a DuckDuckGo fallback, cached, fails gracefully to a generic icon. Replaces the direct third-party Google S2 call in `ThinkingBlock` so researched domains do not leak to Google and favicons work behind firewalls.

- Active project service:
  - [`src/lib/server/services/projects.ts`](./src/lib/server/services/projects.ts) — project CRUD using `db` + `schema.ts` directly. Not a legacy DB wrapper; active service.

- Chat rendering components live under [`src/lib/components/chat/`](./src/lib/components/chat/).
- Layout/navigation components live under [`src/lib/components/layout/`](./src/lib/components/layout/).
- Sidebar-specific pieces live under [`src/lib/components/sidebar/`](./src/lib/components/sidebar/).

Important component boundaries:

- [`src/lib/components/chat/MessageInput.svelte`](./src/lib/components/chat/MessageInput.svelte)
  - composer UI, attachments, local draft emission
  - not cross-page orchestration
- [`src/lib/components/chat/MessageArea.svelte`](./src/lib/components/chat/MessageArea.svelte)
  - message list rendering and viewport behavior
  - generated-file reveal behavior at the bottom of the conversation scroll surface
- [`src/lib/components/layout/Sidebar.svelte`](./src/lib/components/layout/Sidebar.svelte)
  - navigation shell and store-driven sidebar state
- [`src/lib/components/layout/Header.svelte`](./src/lib/components/layout/Header.svelte)
  - top-level app shell interactions
- [`src/lib/components/sidebar/ConversationList.svelte`](./src/lib/components/sidebar/ConversationList.svelte)
  - owns sidebar drag/drop state and project-drop move orchestration through the existing conversations store path

Do not:

- bury durable business logic inside a presentational component because it is "already open"
- duplicate chat state transitions in both page files and chat components
- move project-folder drag/drop persistence into `ConversationItem.svelte` or `ProjectItem.svelte`; those components stay event emitters
- use unused legacy-looking components as templates without checking whether they are actually live

### Visual System And Layout Guardrails

- Design tokens live in:
  - [`src/app.css`](./src/app.css)
  - [`tailwind.config.ts`](./tailwind.config.ts)
- Token categories already defined:
  - semantic surface, text, icon, border, status, radius, spacing, duration, and shadow variables
- Font ownership:
  - UI chrome uses `Nimbus Sans L`
  - long-form message content uses `Libre Baskerville`
  - code uses the mono stack defined in `tailwind.config.ts`

Rules:

- prefer semantic CSS custom properties over hardcoded hex values when a token already exists
- keep spacing on the existing 4px-derived scale exposed through the spacing tokens
- preserve the reading-first visual direction: quiet UI chrome, generous spacing, and message content as the focal surface
- if you change color, spacing, radius, or typography primitives, update both `src/app.css` and the Tailwind mapping when needed
- **Icon sourcing**: all UI icons MUST come from [Lucide](https://lucide.dev) via `@lucide/svelte`. Never write inline `<svg>` elements for icons — always import the equivalent Lucide component. The only exceptions are: (a) the custom brand logo (`LogoMark.svelte`), (b) data visualization SVGs that are charts/graphs not icons (`ContextUsageRing.svelte`), and (c) icons that have no Lucide equivalent (verify before concluding none exists). When adding a new icon, import it from `@lucide/svelte` with the correct PascalCase name, set `size` and `strokeWidth` to match the design system, and always include `aria-hidden="true"` on decorative icons.

Scroll ownership contract:

- `body` should not become the scrolling surface
- the authenticated app shell contains layout overflow
- the sidebar list owns sidebar scrolling
- [`src/lib/components/chat/MessageArea.svelte`](./src/lib/components/chat/MessageArea.svelte) owns conversation scrolling

Do not:

- reintroduce body scrolling to solve a local layout bug
- hardcode one-off colors in components when the token system can express the change
- change typography choices in chat surfaces casually; those are part of the product identity
- move scroll responsibility between body, page, and message list without testing desktop and mobile behavior together

## Known Traps

- If you touch chat send/stream behavior, you are changing a multi-file contract:
  - server route
  - `chat-turn/*`
  - browser stream consumer
  - related tests
- Admin settings can override env-backed defaults. A change that looks correct in `.env` may still be superseded at runtime.
- Auxiliary services such as title generation, context summarization, and Honcho should degrade gracefully. Do not make them hard dependencies of the core chat path unless that behavior change is intentional.
- Do not restore deleted `project-memory.ts`-style architecture or add duplicate DB wrapper files. New persistence should stay in the owning service unless a narrow compatibility shim belongs in `db/compat.ts`.

## Change Placement Guide

- New chat request/shared turn logic:
  - `src/lib/server/services/chat-turn/`
- New Normal Chat prompt/model/tool behavior:
  - `src/lib/server/services/normal-chat-context.ts`
  - `src/lib/server/services/normal-chat-model/`
  - `src/lib/server/services/normal-chat-tools/`
  - `src/lib/server/services/normal-chat-control-model.ts`
  - `src/lib/server/services/normal-chat-failover.ts`
- New admin-managed user account behavior:
  - `src/lib/server/services/user-admin.ts`
- New knowledge artifact or context behavior:
  - `src/lib/server/services/knowledge/`
- New chat-generated file behavior:
  - `src/lib/server/services/chat-files.ts`
  - `src/lib/server/services/sandbox-execution.ts`
- New continuity or evidence-context logic:
  - `src/lib/server/services/task-state.ts`
- New Honcho-specific behavior:
  - `src/lib/server/services/honcho.ts`
- New reusable browser API call:
  - `src/lib/client/api/`
- New client state transition:
  - `src/lib/stores/`
- New landing/chat handoff behavior:
  - `src/lib/client/conversation-session.ts`
- New environment-backed runtime setting:
  - `src/lib/server/env.ts` and `src/lib/server/config-store.ts`

## Commit and Push Discipline

- Commit in small, focused chunks. Each commit should contain one logical change — a single feature, a single fix, or a single refactoring — so that `git bisect` and `git revert` remain useful tools.
- Write commit messages that explain the *why*, not just the *what*.
- Never push to any remote branch without explicit user request. The local commit history is the source of truth until the user explicitly asks for a push.
- Do not batch unrelated changes into a single commit just because they happen in the same session.

## Build and Runtime Warning Discipline

- A clean build is a required invariant. `npm run build` must produce **zero warnings** from Vite, Svelte, TypeScript, or any compiler plugin.
- Every warning must be fixed or explicitly suppressed with a comment explaining why suppression is safe.
- In Svelte 5, `state_referenced_locally` warnings indicate a prop is being read inside `$state()` initialisation and will not react to future changes. When capturing an initial value is intentional, wrap the read in `untrack(() => ...)` to make the intent explicit and silence the compiler.
- Do not ignore warnings because the app "still works." Warnings are often early signals of stale data, missed reactivity, or future breaking changes.
- If a dependency upgrade introduces new warnings that cannot be immediately resolved, pin the dependency and file a tracked follow-up task. Do not leave unpinned warnings in the build output.


## Mandatory Verification

Default verification after meaningful changes:

```bash
npm run check    # Type check with svelte-check
npm run lint     # Lint with biome
npm test
npm run build
```

Run targeted Playwright coverage when changing:

- chat send/stream behavior
  - `npx playwright test tests/e2e/chat.spec.ts tests/e2e/streaming.spec.ts tests/e2e/conversation.spec.ts`
- landing/chat draft handoff or composer behavior
  - `npx playwright test tests/e2e/chat.spec.ts tests/e2e/conversation.spec.ts`
- settings/admin/config behavior
  - `npx playwright test tests/e2e/settings-admin.spec.ts tests/e2e/login.test.ts`
- login/search/shell regressions
  - `npx playwright test tests/e2e/login.test.ts tests/e2e/search-modal.spec.ts`

Playwright note:
- E2E runs set `PLAYWRIGHT_TEST=1`.
- In that mode, [`src/routes/api/conversations/[id]/title/+server.ts`](./src/routes/api/conversations/[id]/title/+server.ts) short-circuits and returns `title: null` so browser tests do not depend on a live title-generator service.

Run these too when relevant:

- deployment/config/docs changes:
  - `npm run db:prepare`
  - keep `scripts/deploy.sh` and `npm start` aligned with the current DB migration story; deploys through that script should always run the idempotent `db:prepare` step before serving new code, and the production start command must not skip pending migrations
  - verify [`src/routes/api/health/+server.ts`](./src/routes/api/health/+server.ts) still matches docs and deploy expectations
- knowledge upload or extraction changes:
  - verify upload size expectations remain aligned with [README.md](./README.md) and deployment docs

## What Not To Reintroduce

- No new top-level `src/lib/server/services/*.ts` public boundary just because one file is getting large.
- No parallel memory subsystem beside `task-state.ts` and `honcho.ts`.
- No duplicated route-specific chat execution logic.
- No new raw `sessionStorage` protocol outside `conversation-session.ts`.
- No direct env reads in override-aware runtime services.
- No general runtime migrations in app bootstrap. If production safety ever requires a bounded additive compatibility shim, keep it isolated in `src/lib/server/db/compat.ts`, document it in the README, and continue treating `npm run db:prepare` as the real migration path.
- No duplicate DB repository wrappers.
- No stores that also become API clients.
- No monolithic catch-all service file that mixes unrelated concerns again.
- No revival of deleted legacy files just because they reappear as untracked leftovers after merges or agentic runs; verify git history before restoring anything outside the tracked graph.
- No new hand-crafted inline `<svg>` icon elements. All UI icons must come from `@lucide/svelte` (see Visual System rules).

## Doc Map

- [README.md](./README.md)
  - public setup, deployment, stack, env vars, operational caveats
- [AGENTS.md](./AGENTS.md)
  - canonical engineering boundaries and placement rules
- Supplemental references
  - [deploy/README.md](./deploy/README.md)
  - [docs/external-deployment.md](./docs/external-deployment.md)

If a supplemental doc conflicts with this file or the README, update the supplemental doc rather than copying the stale pattern back into the codebase.
