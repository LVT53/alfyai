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
- If a change intentionally affects the remaining circular-dependency debt, rerun Fallow and report whether the four known cycle findings changed.

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
- `src/lib/server/services/messages.ts` owns persisted assistant-message metadata such as evidence summaries. Do not invent route-local shadow storage for those fields.
- `src/lib/server/services/normal-chat-context.ts` owns Normal Chat prompt assembly: it builds the prompt from the base prompt, the recorded prompt name and the turn guidance, and the turn guidance carries the always-on date-before-search guidance. The base prompt text itself, including the file-production guidance, is written in `src/lib/server/prompts.ts` (which `normal-chat-context.ts` consumes through `getSystemPrompt`), and the model-facing rules for each tool live on the tool (`src/lib/server/services/normal-chat-tools/`, for `produce_file` in `produce-file.ts`; ADR-0055). Do not reintroduce route-local prompt guards for freshness-sensitive search behavior.
- `src/lib/server/services/web-grounding.ts` owns Normal Chat web grounding payloads: model-safe `research_web` source/evidence shaping, grounded web candidates/metadata, citation URL extraction, and citation-audit source extraction. Do not duplicate web source canonicalization or research evidence payload shaping inside tools, routes, or citation audit code.
- `src/lib/model-context-defaults.ts` owns shared context-window derived defaults, and `src/lib/server/services/provider-model-runtime-defaults.ts` owns provider-model runtime/persistence projection for context limits, max output tokens, reasoning, and thinking. Env parsing, config-store overrides, provider-model seeding, context budgeting, prompt-limit resolution, and Normal Chat Model Run must consume those defaults instead of duplicating ratio math.
- `src/lib/server/services/normal-chat-stability-snapshot.ts` owns content-free Normal Chat stability diagnostics for streams, providers, tools, web grounding, context defaults, and maintenance. Admin routes may expose that snapshot after authorization, but they must not leak prompts, messages, queries, raw source text, API keys, or user ids.
- `src/lib/server/services/normal-chat-model/` owns Vercel AI SDK/OpenAI-compatible model execution for Normal Chat, including plain/streaming provider-attempt policy, timeout failover, provider rate-limit fallback, unsupported-tool fallback, provider usage mapping, and neutral model-run events; `src/lib/server/services/normal-chat-tools/` owns app-backed AI SDK tools and their shared execution envelope. Do not reintroduce provider retry policy in chat-turn routes/orchestrators, hand-roll per-tool timeout/abort/recording shells, or add a hidden external orchestration runtime for these paths. `normal-chat-model/sampling.ts`'s `resolveModelCallSampling` is the only way a model call gets its sampling: the chat run and every internal call (thought-step status lines, rail summary, titles, summaries, memory judge, Apps, `@Alfy` replies) take the provider family's profile, declared once as `defaultSampling` in `provider-compatibility.ts` (temperature and top_p as call options from the helper, top_k by the provider builder's body injection); a caller names its own temperature only for a deterministic machine-read answer, listed with its reason in `sampling.test.ts`, and a new model call outside that route fails that test.
- `src/lib/server/services/title-generator.ts` owns language-aware title prompt selection and code-specific title prompt appendices, while the prompt text itself flows through `src/lib/server/config-store.ts` and admin settings.
- `src/lib/server/services/chat-turn/short-local-text.ts` is the one place that cleans a short text a person reads (a title, a thought-step status line, a rail headline): a stray think block (`stripLeakedThinking`; one extra request for an unclosed one through `askWithThinkingRetry`), leaked reasoning and request restatements in English and Hungarian (`isReasoningLeak`, `isRequestRestatement`), and JSON-wrapped answers. Do not add a second cleanup beside it, and take any new phrase it should catch from real model output, in a test, in both directions. Few-shot examples for such a call travel as text in the one user message, never as earlier assistant turns (the chat template renders each with an empty think block and the model then re-opens one: 19% of titles). The status line, the rail headline and the follow-up chips are written in the turn's own resolved reply language (`resolveTurnResponseLanguage`, carried by `completeStreamTurn` and `finalizeChatTurn`), never in a fresh read of the latest message.
- `src/lib/server/services/chat-turn/follow-up-chip.ts` says what a follow-up chip is and is the one check for it: a chip is the person's NEXT MESSAGE to Alfy (a tap sends its text, verbatim, as the user's own message through `handleSendFollowUp`), so it is an instruction or the person's own question about something the reply names, one short plain sentence in the turn's resolved reply language. It is never Alfy offering (`Szeretnéd, ha…?`, `Would you like me to…?`, `Írjam le…?`), a question put to the person (`Mennyi a kereted?`), a statement about the person (an invented fact in their mouth), or a generic push (`Tell me more`). `follow-up-suggestions.ts` owns the prompt that asks for it, and the prompt's examples must pass the same check. Take any new phrase the check should catch from real model output, in a test, in both directions. `language.ts`'s `detectExplicitLanguageRequest` flips the reply language only when the person ASKS for the reply in a language (`válaszolj angolul`, `answer in Hungarian`, `in English please`), never because a message mentions one (`Hogy mondják angolul, hogy alma?`, `How do you say 'apple' in Hungarian?`).
- `src/lib/server/services/task-state.ts` is the continuity boundary. Do not reintroduce a parallel `project-memory` architecture.
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
    - Assembles bootstrap and full detail payloads, including defaults, child-fork message decoration, task-state continuity attachment, draft/generated-file/File Production/context-compression/cost fields, and active Skill Session public serialization.
    - The route GET handler stays an auth/HTTP adapter that delegates to `getConversationDetail(...)`.
- Shared pipeline:
  - [`src/lib/server/services/chat-turn/index.ts`](./src/lib/server/services/chat-turn/index.ts)
    - The single entrypoint into chat-turn (F1). The `send`, `stream`, and `retry` routes drive a Normal Chat turn through this facade and import chat-turn only from it, rather than reaching into individual submodules. It is a facade *inside* this module directory, not a new top-level `services/*.ts` boundary. Stream-lifecycle/capacity utilities used by auxiliary routes (`stream/stop|status|buffer`, `admin/drain`, `health`) still import `active-streams` directly.
  - [`src/lib/server/services/chat-turn/request.ts`](./src/lib/server/services/chat-turn/request.ts)
  - [`src/lib/server/services/chat-turn/preflight.ts`](./src/lib/server/services/chat-turn/preflight.ts)
  - [`src/lib/server/services/chat-turn/normalizer.ts`](./src/lib/server/services/chat-turn/normalizer.ts)
    - Canonical assistant-output normalization for send, stream, retry, and title generation.
  - [`src/lib/server/services/chat-turn/stream-orchestrator.ts`](./src/lib/server/services/chat-turn/stream-orchestrator.ts)
    - Orchestrates the full chat-turn streaming pipeline: neutral Normal Chat model-run events, tool-call marker handling, token/thinking framing, stream buffer management.
    - Imported by the `stream` and `retry` routes via the `chat-turn/index.ts` facade (F1).
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
    - Owns app-backed AI SDK tools such as `produce_file`, `research_web` (Parallel Search), `fetch_url` (Parallel Extract, on-demand page read), `image_search` (Brave), and `memory_context`, plus the shared tool execution envelope for timeout, abort, model-safe failure, and recorder behavior.
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
  - The Conversation Detail Read Model may import `file-production/read-model.ts` directly. General callers may use the public facade, but must not make read paths eagerly load worker-runner, renderer, sandbox, or generated-file storage modules.
  - Source-first generated-document source artifacts start as pending and non-durable, promote to durable only after rendered files attach successfully, and stay non-prompt-eligible if rendering/storage fails before attachment.
  - [`src/lib/server/sandbox/config.ts`](./src/lib/server/sandbox/config.ts) now ensures the sandbox runtime images exist before container creation, warms them in the background at app startup, and supports both the Python runtime (`python:3.11-slim`) and the JavaScript runtime (`node:22-bookworm-slim`)
  - [`src/lib/server/sandbox/config.ts`](./src/lib/server/sandbox/config.ts) must wait for exec inspection to report `Running === false` before the archive reader inspects `/output`; do not treat an early stream close as proof that the sandbox command has finished
  - [`src/lib/server/services/sandbox-execution.ts`](./src/lib/server/services/sandbox-execution.ts) must surface output-archive read failures as explicit execution errors instead of collapsing them into the same empty-file 422 path used for real zero-output runs
  - File-production/server tracing now mainly uses `[FILE_PRODUCTION]`, `[CHAT_STREAM]`, `[CHAT_FILES]`, `[NORMAL_CHAT_CONTEXT]`, and `[MEMORY_MAINTENANCE]`; preserve those prefixes when extending the debugging path so node logs stay grep-friendly

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
- keep outbound file-production guidance — the base prompt text in `src/lib/server/prompts.ts` (assembled by `normal-chat-context.ts`) and the tool's own description in `normal-chat-tools/produce-file.ts` — aligned with the unified `produce_file` tool contract: source-first documents use `document_source`, program artifacts write final files to `/output`, and generated files show up as durable job-backed cards
- keep outbound file-production guidance explicit: when the user asks for a downloadable file and the tool exists, the model should call `produce_file` rather than merely describing a file in prose
- keep generated-document source model-friendly at the boundary: normalize simple table shapes such as `headers` plus array `rows` into canonical columns/rows, and normalize simple Chart.js-style chart data into renderer-safe chart rows
- keep the app-backed AI SDK `produce_file` tool scoped by server-owned `userId`, `conversationId`, and turn idempotency; do not expose those scope fields as model-facing inputs
- keep the model-facing output-list input named `requestedOutputs`, not `outputs`, so generated-document guidance and tool schemas stay aligned
- keep `produce_file` runtime guidance accurate: use `sourceMode: "document_source"` for PDF/DOCX/HTML reports from structured document source and `sourceMode: "program"` for code-generated data/office artifacts
- generated files may offer an authenticated rich preview via `/api/chat/files/[id]/preview`; reuse the shared file viewer component instead of maintaining a second chat-only preview UI
- working-document continuity should continue to build on generated-output artifacts.
- working-document continuity should prefer the shared resolver’s “current generated document” signal over generic latest-output heuristics. If a generated document is selected because of active focus or a query match, do not layer a second recency-only boost on top.
- keep document-selection observability compact and authority-scoped. Extend the `[CONTEXT] Working document selection` summary in `knowledge/context.ts` instead of reintroducing noisy per-artifact debug logs across routes.

Do not:

- duplicate turn logic between `send` and `stream`
- add new AI SDK UI stream part shapes casually; this touches browser parsing and tests
- hide persistence side effects inside route-local closures that only one endpoint can see
- couple provider transport details directly into page components
- duplicate stream-tag parsing or inline-thinking extraction between the browser stream consumer and `api/chat/stream/+server.ts`
- scatter freshness-sensitive search guards outside `normal-chat-context.ts`

### Artifacts

Feature 2 (ADR-0066): a family of five kinds — Document, App, Canvas, Slides, File — that live beside the conversation, behind one card and one panel. A new family on the *existing* `artifacts` backbone, never a parallel document store: the family's own rows are written with `type: "artifact"`, its kind carried in `metadata_json.artifactType`; produced files keep `type: "generated_output"` (ruling 18) and are read as the family's `file` kind — this is the one place the family spans two `type` values, and it is deliberate.

- [`src/lib/server/services/artifacts/`](./src/lib/server/services/artifacts/) — the service boundary. `index.ts` is the facade; callers import only from it, mirroring the chat-turn facade rule. Internally: `types.ts`, `limits.ts`, `hash.ts`, `record.ts` (artifact CRUD, the kind↔row-type mapping, version append), `versions.ts`, `comments.ts`, `kv.ts` (per-App key-value state, every accessor scope-checked since the table has no user column), `serialize/`, `read-model.ts` (the panel list's and the header count's one source).
- Three child tables hang off the `artifacts` row: `artifact_versions`, `artifact_comments`, `artifact_kv`.
- [`src/lib/shared/artifacts/kinds.ts`](./src/lib/shared/artifacts/kinds.ts) — the `ArtifactKind` union (browser-safe, no runtime imports). [`src/lib/shared/artifacts/anchor.ts`](./src/lib/shared/artifacts/anchor.ts) — the one shared comment-anchor type, appended to per type.
- [`src/lib/components/artifacts/`](./src/lib/components/artifacts/) — `ArtifactCard.svelte` (the one card every kind renders as; `chrome="full"` for the panel list and the four new kinds, `chrome="body"` for a host that draws its own header, today `ToolActivityRow.svelte`'s File row) and `artifact-bodies.ts` (the type→body loader registry; a missing entry IS the File body).
- The panel is [`document-workspace/DocumentWorkspace.svelte`](./src/lib/components/document-workspace/DocumentWorkspace.svelte) itself, rebuilt in place — ruling 10 forbids a rename. Its content area dispatches on an item's optional `kind` through the body registry; its `list`/`onListOpenChange` props carry "what this chat made".
- **The tab remembers a panel per chat, and each says whose it is.** [`src/lib/client/document-workspace-state.ts`](./src/lib/client/document-workspace-state.ts) is the one reader and writer of that `sessionStorage` record; a caller that restores names its chat (`WorkspaceConversation`). A chat restores its own panel whole; a chat with none takes only what belongs to it plus the library and search opens from the chat visited last, and stays closed rather than opening on a stranger; an emptied panel stays as an empty one, so a closed open is not handed on by an older chat. An incognito chat's panel never travels: another chat's load removes it from storage, another chat's save does not write it back, and no incognito chat starts with another chat's.
- [`src/routes/api/artifacts/`](./src/routes/api/artifacts/) — thin routes (`requireApiUser`, ruling 39 amended); `src/lib/client/api/artifacts.ts` — the browser calls.
- `ConversationDetail.artifacts` (`ArtifactCardSummary[]`) is the panel list's and the chat header count button's one source, assembled in `conversation-detail/read-model.ts` alongside `generatedFiles`/`fileProductionJobs`.
- **A project's bundle** (Slice 5b, T5). `services/artifacts/project-bundle.ts` (`listProjectBundle`, on the facade) is the one list behind the project Files dialog, the project page's quiet line and the home cards, so the three cannot count differently: the project's files (`listProjectKnowledge`) plus the Documents, Apps and Canvases made in the project's chats or linked from the library, read through the ownership scope — an incognito chat's items, another user's and Slides never appear, and a produced file stays a file (rulings 18, 69). Membership is read off `conversations.project_id` every time and never stored, so a chat moved out of the project takes its items with it; a link stays a link (unlinking deletes nothing), and an item that is here only through its chat has no link to remove (`ProjectKnowledgeItem.linked`). The row words the kind through `artifacts.type.*`, names the chat (`artifacts.bundle.fromChat`) and opens the panel on the item (`kind` on the workspace item, as the Knowledge page builds it). Once anything in the bundle was made by a chat the counts say "items".
- **One version number** on every surface (list row, in-chat card, panel header's version button, Versions popover): `src/lib/client/api/artifacts.ts` announces every version, edit time and deletion the server reports (`subscribeArtifactChanges`); the chat page keeps the highest version and latest time per artifact and reads its rows, cards and open items through [`src/lib/client/artifact-versions.ts`](./src/lib/client/artifact-versions.ts). Never print a version or an "edited …" time from an open-item snapshot or a list refresh directly.
- The panel header's popovers (Versions, Download) share `src/lib/components/artifacts/AnchoredPopover.svelte` (popover on desktop, `DialogShell` sheet on phones; placement in `popover-placement.ts`, kept inside the panel). The version summaries the server writes itself are one vocabulary, [`src/lib/shared/artifacts/version-summaries.ts`](./src/lib/shared/artifacts/version-summaries.ts), localized by `document/version-summary.ts`; a body save names its kind (`summaryKind`), never sends text.
- **Delete, the deleted state and Regenerate** (polish G2-A). `DELETE /api/artifacts/[id]` is a thin route over the facade's `deleteArtifact`, which owns the whole cascade: child rows (versions, comments, kv, review state), the artifact's `semantic_embeddings` rows (that table has no FK), and, for a produced file (`generated_output`), the chat files the row points at (the job stays, so the chat can say the file was deleted), and, for a board, its poster files (`artifacts/canvas-posters.ts`: chat files that hang from no reply, named for the board, in its own chat and user; a removed block's poster stays, since an older version still draws it). A foreign or missing id answers the same 404; an incognito chat passes `?conversationId=`. A delete that names a conversation acts only on what THAT conversation made (a fork's card can name its parent's Document, which any other normal chat of the user can read): anything else answers 409 `not_made_here` — decided after the scoped read, so an unreachable row still gets the plain 404 — and the panel offers no Delete on an item that says it was made in another conversation (`DocumentWorkspaceItem.conversationId`). The panel's Delete (header button and each list row's overflow) is `ArtifactDeletePopover.svelte` on `AnchoredPopover`. Knowledge → Documents keeps its own Delete, `DELETE /api/knowledge/[id]` → the facade's `deleteLibraryArtifact` (`artifacts/library-delete.ts`): the knowledge store's `deleteArtifactForUser` unchanged (who may delete, the foreign keys, source → normalized expansion, generated-document families), then `deleteFilesOfDeletedBoard` (`record.ts`), the one function the panel's `deleteArtifact` also calls, so both take exactly a board's poster files and nothing else, only for a board the store really deleted. It lives in the facade because the chat-file store reaches back into the knowledge facade: a store → chat-files call would be a circular import. The library's "forget everything" and Clear Memory and Knowledge still delete boards through `hardDeleteArtifactsForUser` and so still leave their posters (in chats that stay) until the chat goes. The chat's deleted state reads the server, so it shows either path's result.
- **What the chat shows for something that no longer exists** comes from the server, under the ownership scope: `ConversationDetail.deletedArtifactIds` (the ids the loaded messages' create/edit tool calls name, minus what `listMissingArtifactIds` can reach; read from the already-loaded message window, never a second `messages` query) for cards, next to `unreachableArtifactIds` (the caller's OWN items that exist but sit outside this conversation's scope — the parent of a forked incognito chat: a fork copies tool calls, never items, and is incognito too; the card says "Made in the original chat", with neither Open nor Regenerate; another user's row still reads as deleted and reveals nothing), and `FileProductionJob.filesDeleted` (a succeeded job with no file left) for generated-file rows. The page threads one `DeletedArtifacts` prop (`components/artifacts/deleted-artifacts.ts`) message → block → row; an Open answered 404 flips the card/row live through the same state.
- **Regenerate** for a deleted Document/App re-creates it under the SAME id from the arguments the model gave (kept on the message's `create_artifact` tool call): `normal-chat-tools/artifact-tools/recreate.ts`, behind `POST /api/conversations/[id]/artifacts/[artifactId]/regenerate` (`createArtifact({id})` refuses an id that is taken, and Regenerate checks that up front — an item that still exists out of reach answers 409 `unreachable` before any model call; one regeneration of an id runs at a time). The delete confirm promises "you can regenerate it from the chat" only for an item whose `ArtifactCardSummary.regenerable` is set (a create call or a kept-as-document message in the loaded window, or a produced file whose finished job kept its request and made nothing else), and keeps "can't be undone" otherwise. The server marks the rows from the messages it has persisted; the chat page marks the same rows from the messages it holds live (`shared/artifacts/artifact-calls.ts`, `markRegenerable`), so a Document made in the turn that just ended is not "can't be undone" until a reload. A produced file re-queues the same job from its `request_json` (`regenerateFileProductionJob` on the file-production facade, `POST /api/chat/files/jobs/[id]/regenerate`). A Document made by "Open as document" has no card: its Regenerate is that same message action (`keepMessageAsDocument` in `artifacts/keep-message.ts`: one press per message at a time, a second one — another tab, a double click — is handed the same Document), which makes a fresh Document once the kept one is gone. An embedding refresh writes a vector only for a subject that still exists (`semantic-embedding-refresh.ts`), so a delete that races it leaves none. Do not mint a new id for a regenerated item or re-link cards to it.
- **The Document's keyboard** (polish G3). [`document/keyboard-shortcuts.ts`](./src/lib/components/artifacts/document/keyboard-shortcuts.ts) is the one place that says what a key event means (⌘ on a Mac, Ctrl elsewhere; QWERTZ, non-Latin layouts, IME) and how a chord is written on a button (tooltip, accessible name, `aria-keyshortcuts`). Two families, kept apart: the reader's own text history (⌘/Ctrl+Z, +Shift+Z, +Y), which the editor claims in `document-editor.ts` even with nothing to undo (an unhandled undo key is the browser's own, which rewrites the DOM behind ProseMirror) and `DocumentBody.svelte` claims for a focus anywhere else in the panel except a comment/reply field; and Alfy's change, the pill's Undo/Redo, ⌘/Ctrl+Alt+Z and +Shift, which are not in that history and so never clash with it. Loading the server's content into the editor (`loadMarkdown`) is applied outside the history, as the smallest replacement of whole blocks: Alfy's changes are governed by Keep/Undo only, and what the reader typed in untouched blocks stays undoable.
- **The change pill lives inside the editor's DOM**, so its widget decoration sets `stopEvent: () => true` (`change-pill-decoration.ts`): without it every key and click made on its buttons bubbles into ProseMirror (Enter splits the paragraph, Space is typed). The workspace renders a kind's body from the module it resolved to (`loadedArtifactBodies` in `DocumentWorkspace.svelte`), never from an `{#await}` around it: Svelte's `{#await}` shows its pending state when a `flushSync` (`tick()`) lands while its expression is re-read, which rebuilt the whole Document body (editor, caret, undo history, pills) after every Keep.
- **One body per open item, and what it reports to the header** (final polish D1/D2). The workspace mounts a kind's body under `{#key activeBodyKey}` — the open item's id (`artifactId ?? id`), never the `activeDocument` object — so a version change or a Keep never rebuilds the editor, while another item always gets a body of its own. What the body reports to the panel header (the Versions/Download/Comments triggers, the comment count, whether the comments show) is filed in one record stamped with that item (`bodyPanelReport`) and read back only while that item is the open one. Do not clear it from an effect keyed on the open item: the body registers once, when it mounts, and such an effect can wipe a registration made in the same flush. A live Alfy call is applied by the body that was mounted while it ran; a body built after it settled restores the server's review state (ruling 61) and never lands it (`settledActivityKeyAtMount` in `DocumentBody.svelte`) — landing it on top counted the change twice.
- **"Artifact" is never shown in the UI** (ADR-0066): every user-visible string, `title`, and `aria-label` names the kind (Document/Dokumentum, App/Alkalmazás, Canvas/Tábla, Slides/Diasor, File/Fájl) through `artifacts.type.*` in [`src/lib/i18n/artifacts.ts`](./src/lib/i18n/artifacts.ts); the word itself is fine in code, tables, routes and file names.

Do:

- extend `src/lib/server/services/artifacts/index.ts` for new public functions; nothing outside the directory queries the artifact tables directly (the account data archive is the one named, deliberate exception)
- route every scoped read through the ownership scope the facade already uses; give `artifact_kv` readers a scope marker, since the table's missing user column is exactly what `tests/cross-cutting/incognito-artifact-containment.test.ts` checks for
- keep the type→body registry and `ArtifactCard.svelte`'s kind branches append-only, one entry per kind per slice

Do not:

- add a `type: "artifact"` row for a produced file, or otherwise re-type `generated_output` — `knowledge/store/core.ts` and `account-lifecycle/index.ts` both key ownership/Clear-Memory behavior on that exact value
- rename `DocumentWorkspace.svelte`, or fork a second viewer for an artifact kind — the panel is the only shell
- add a second type-label i18n family beside `artifacts.type.*`, or let the word "Artifact" reach a user-visible string
- hand-write a second copy of the op or patch schema a tool advertises, or add a second writer of id-addressed changes: the schema the model is shown is the one its handler parses (ruling 62), and a diff lands only through `applyArtifactOps` (ruling 14)

#### Canvas

A Canvas is a board of blocks, arrows, freehand marks and a camera on the same `artifacts` row (`metadata_json.artifactType: "canvas"`), stored as the canonical JSON of `CanvasBody`. What the browser and the server must agree on is a shared module; what only a reader who opens the board needs is a lazy entry. Rulings are in `docs/plans/claude-at-home-2/decisions.md`. Short paths: `shared/…` is `src/lib/shared/…`, `services/…` is `src/lib/server/services/…`, `canvas/…` and `app/…` are under `src/lib/components/artifacts/`.

- **The body and its vocabulary are shared, browser-safe modules** (`shared/artifacts/`): `canvas.ts` (types), `canvas-blocks.ts` (one zod schema per block kind, declared once, with no Svelte and no server code because the server judges diffs with them — ruling 64), `canvas-body.ts` (`normalizeCanvasBody` never throws: it drops what cannot be drawn and says so; `boardJson` is the canonical string a hash is taken of), `ops.ts` (the generic ops mechanism, ruling 14), `board-ops.ts` (Canvas's vocabulary; every refusal reason has an English and a Hungarian label), `board-diff.ts` and `canvas-review.ts` (what a change touched). Whatever a client sends or a model writes reaches `updateArtifactBody` only through `prepareCanvasBoard` (`services/artifacts/serialize/canvas.ts`: caps, canonical JSON, the one hash, ruling 12); a board saves through the shared body route (`saveArtifactBody`), never a Canvas-only save call.
- **One envelope for an id-addressed change** (ruling 14). `applyArtifactOps` (`services/artifacts/ops.ts`) is the only place a diff is applied: ownership scope, the base version must be the newest, dispatch on kind through `OPS_BRANCHES`, judge every op, then ONE `updateArtifactBody`; a kind with no branch is a 400 and a diff that changes nothing writes nothing. The panel's `POST /api/artifacts/[id]/ops` (thin: author `user`, no review marker), `edit_artifact` and an `@Alfy` reply on a board (author `alfy`) all call it. A new kind adds a vocabulary file beside `board-ops.ts` and one `OPS_BRANCHES` entry; the Document keeps its patch engine (`services/artifacts/document-ops.ts`).
- **What the tool advertises is what the validator parses** (ruling 62). `buildEditArtifactModelInputSchema` (`services/normal-chat-tools/artifact-tools/edit.ts`) advertises `boardOpsArraySchema`, the very schema `applyArtifactOps` reads a diff with, never a twin; the description's one worked example (`EDIT_ARTIFACT_CANVAS_EXAMPLE` in `kind-prose.ts`) is fed by a test through that schema and `validateBoardDiff`, and every refusal names what would have worked. The create handler judges a made board op by op (`parseCanvasCreateBody` in `canvas-model.ts`). The tool text is in the cached prompt prefix: changing it moves `CATALOGUE_TOKEN_CEILING` (`services/normal-chat-tools/index.test.ts`) and the frozen snapshots in the same commit (ruling 23).
- **What Alfy may put on a board, and change** (rulings 64, 67). `add_node` and `add_frame` make only the five note-shaped kinds (`MODEL_CREATABLE_KINDS`); a map, file, App, photo or web block carries a reference the model cannot mint, and a diagram is what the chat drew, so all six land only from the reader's Insert. On those app-owned kinds `update_node` may change descriptive fields only (`modelUpdatableFields`: a map's `label`, `route` and `meta`, an App's `title`, a diagram's `label` and `subtitle` but never its source, nothing on a file, photo or web block), and no op writes a `poster`; otherwise a prompt-injected turn could plant links dressed as the app's own search result. What a board may load or link is one rule, `shared/artifacts/block-urls.ts` (a photo is exactly one of the app's thumbnail proxies, a source an http(s) address), shared by the schemas, the chat listing and the blocks. What Alfy adds is stored at its kind's own width (`defaultNodeWidth`: `NODE_WIDTH` for a note or text, a checklist's 340, a chart's 360, which is also what the reader's Insert gives; a frame keeps its size); `estimatedNodeSize` is the one estimate of what the panel draws (a chart is as tall as its plot, which `ChartNode` lays out at the ratio `chartAspectRatio` reads), used by the model's read, `canvas/_lib/board.ts` and the eval, and the tool text is built from the same constants.
- **Alfy never overwrites what the reader changed after it read the board** (ruling 67). `read_artifact` records the version it showed; the edit handler takes the turn's last read (`lastKnownBoardVersion`, moved forward by the model's own edits) as `readVersionId`, and `applyArtifactOps` gives the vocabulary the board as read (`OpsJudgeContext.readDoc`), which refuses `update_node`, `move` and `remove_node` on a block that differs since as `stale` while the rest of the batch applies. With no read in the turn the edit applies to the board as it is. An `@Alfy` reply on a board (`canvas-comments.ts`) holds the same line with the body it showed the model (`OpsEnvelopeInput.readBody`, in-process only, in place of the version id): the reader's autosaves within ten minutes are written INTO their own newest version (ruling 47), so a version id can name a body that has since changed, and a stale op is named in the reply (`skipped`, localized by the card). The Document's `@Alfy` needs neither: its read snapshots each block's hash and the patch carries it (`block_changed`).
- **An Alfy change to a board is one pending change** (ruling 63). Ruling 61's marker (`metadata_json.review.throughVersion`, bootstrapped by the envelope on the first Alfy write) names the last Alfy version the reader has decided on. `services/artifacts/review.ts` dispatches on kind; for a board the shared `computeCanvasReview` says what waits, on the same `diffBoards` the browser's landing draws from, so the count (`pendingReviewCount` from `read-model.ts`, never a client copy) and the landing agree. There is no per-block Keep or Undo: Keep moves the marker; Undo saves the parent version's body as a **user** version and is refused, with the shared refusal card pointing to Versions, once the reader has changed the board. The landing, rings, pill, review bar and notices are one lazy entry, `canvas/review-parts.ts`.
- **Comments on a board are the Document's feature on the same rows** (ruling 1: `artifact_comments`, never part of a body). A board takes `node` and `point` anchors only (`canvasAnchorResolver` in `shared/artifacts/comments.ts`), and a thread whose block is gone is an orphan by the resolver's answer, never by a local existence check. The pins, the Comment tool and their shared state (`canvas/_lib/comments-controller.svelte.ts`) are one lazy entry, `canvas/comment-parts.ts`. `@Alfy` on a board is `services/artifacts/canvas-comments.ts` (`runCanvasAlfyReply`, dispatched by kind from `runAlfyCommentReply`): the model answers `{ note, ops? }` in `boardOpsArraySchema` itself with the edit tool's own texts (ruling 62), gets one correction, and its ops land through `applyArtifactOps` as one version by `alfy`.
- **The board hands over whole steps.** `canvas/CanvasBoard.svelte` owns the live state and the reader's own history (`canvas/_lib/board-history.ts`, ruling 16), never persistence: a moment after blocks, arrows or marks stop changing it compares its canonical JSON, camera left out, with the last state it reported and calls `onchange` with ONE step; a bare pan is never a step. What the server changed under the reader is drawn with `land` (and `place`, `hold`), never as a step of the reader's own, because an Alfy change is a version. `insertBlock` is the only place a block is created; a kind is a `BLOCK_META` row plus a registry entry (`canvas/_lib/block-meta.ts`, `canvas/_lib/block-registry.ts`).
- **The editor is one chunk plus lazy entries, and a size gate holds the line** (ruling 68). `canvas/CanvasEditor.svelte` is glue; what a reader may never need is ONE entry it loads with `import()` and never imports statically: `canvas/comment-parts.ts`, `canvas/review-parts.ts`, `canvas/export-parts.ts`, `canvas/drawing-parts.ts`, `canvas/state-parts.ts`, `canvas/group-parts.ts`, and what is under `canvas/nodes/` and `canvas/chat-blocks/`. A lazy part imports no `@xyflow/*` (it would pull the library into a second chunk) and as little of the editor as it can. `npm run check:artifact-chunks` (`scripts/check-artifact-chunks.mjs`) holds the editor's first-paint closure to the gzip ceiling ruling 68 records, keeps Chart.js, MapLibre and Mermaid out of it and the chat route within 2 KiB of its baseline; raise a ceiling only with a recorded reason. It is a development gate, run as its own step on a finished `npm run build` (the wave gates do; so should anyone who changes what the editor or the chat shell imports), and it is deliberately NOT part of `npm run build`: the chat-route baseline is a fixed byte count, and the server's build environment measures about 660 B heavier on every route than a developer machine, so a deploy of gated code must not fail on it.
- **Blocks from the chat.** `GET /api/artifacts/[id]/chat-blocks` (thin over `services/artifacts/chat-blocks.ts`, facade `listCanvasChatBlocks`) lists what the board's own chat made through the same scoped read as every artifact route, only via services that already own the data, each item checked against its block's schema so nothing is offered that a save would drop. Everything the chat draws that is a chart is on the list and is drawn by the chat's own component, so what the chat draws the board draws: a Chart.js chart through `Chart.svelte` (a config is read the way the chat reads it, `parseJsonLenient`, and a chart is placed in the room its plot takes, `insertSize`: a pie is square), a Mermaid diagram (a closed ```mermaid fence of a reply: `diagrams` in the listing, named by its own title else its kind) through `Mermaid.svelte`, which draws in the reader's theme. A `csv` fence (the chat's third diagram fence, a table) has no block yet. Every block but the frame, the note and the text is drawn by `canvas/nodes/LazyNode.svelte`, which owns the shell and loads only the content (`canvas/_lib/lazy-nodes.ts`, a content module plus a `<kind>Shell`); a content module may not import `NodeShell`, the flow library or the block registry (`canvas/nodes/lazy-node.test.ts` reads the sources), or the shell splits out of the editor's chunk. A File block opens through `onOpenItem` (the host's `onOpenDocument`); an App block reuses the panel's `AppFrame` (ruling 58). A live-web block's Refresh and Search (`services/artifacts/canvas-web.ts`) write nothing: the editor puts the snapshot on the board as one step of the reader's own (`CanvasBoard.setBlockData`), so a refresh never races the autosave.
- **A board leaves the panel as a picture, and a block a picture cannot reproduce has a poster.** The browser draws the picture; `POST /api/artifacts/[id]/exports/png` (thin over `services/artifacts/canvas-export.ts`, facade `storeCanvasImage`) judges whose board it is and that the bytes are one whole PNG within what a browser could draw, then keeps them through `storeGeneratedFile` (`services/chat-files.ts`) as a produced file (ruling 18: a chat file, its `generated_output` artifact, a `used_in_output` link to the board). A block a picture cannot reproduce (`needsPoster` in its `BLOCK_META` row: an App, the map, photos, live web) carries a poster instead, sent through the same route: a chat file that hangs from no reply and has no artifact, named by `shared/artifacts/poster-file.ts`, served by `services/generated-file-serving.ts` because of that name, made from a detached copy of the block's content (`canvas/_lib/poster.ts` `stillify`) and set without being a step of the reader's own (`CanvasBoard.setBlockPoster`). Everything a picture is made of is one lazy entry, `canvas/export-parts.ts`; `canvas/_lib/export-png.ts` puts the camera and posters back in a `finally`.
- **The reader's unsaved step and Alfy's change never refuse each other.** A step still inside the board's settle delay is saved before a fresh chat turn starts (the open body registers a flush with the panel, `DocumentWorkspace.svelte` hands it to the chat page, which awaits it, bounded, wherever a turn begins except a queued follow-up the runtime drains by itself, which skips the flush and leaves the step to the merge below). A landing change, or a save the server refused because it had moved on, that meets an unsaved step is merged block by block against the last board the server acknowledged (the reader's version stands on a tie; a dismissible notice counts the blocks) and saved as the reader's own version; only a refusal with nothing newer on the server keeps the banner, after one retry. An App block's tripwire (`app/AppFrame.svelte`) counts loads per frame *window*, never per element: the flow library re-parents an App's wrapper when a frame is re-listed (`parentsFirst`), and the browser then fires a new `load` on the same element in a new window.
- **Several picked blocks are one group** (OW-2). Shift, Cmd and Ctrl add or remove a block (`multiSelectionKey` on the flow; a Shift-click on a frame's ground goes through `handlePaneClick`, which keeps what was picked because the library puts it all down after `onpaneclick`), and a marquee takes what it FULLY encloses (`selectionMode`; the library's real default is partial, which picks a frame the marquee only crosses, so a drag inside a frame picked the frame). Two or more picked blocks give up their own corners, anchors and toolbar (`grouped` on the board context, read by `NodeShell`) to ONE box with eight handles and one toolbar (the count, Delete for all), drawn in screen space by `canvas/GroupBox.svelte`; the arithmetic that scales the blocks with it is `canvas/_lib/group-scale.ts` (pure: one box about the opposite corner, places and sizes scaled together, ONE shared floor where the block that runs out first reaches its kind's `minSize`, a picked frame takes its notes along, whole numbers, each block in the space it is stored in), and a finger's way in (a long press adds a block and starts the picking mode, then taps add and remove; `canvas/_lib/touch-select.ts`) is the same lazy entry, `canvas/group-parts.ts`, loaded when a selection first has two blocks or at once on a coarse pointer. The editor's first paint carries only the hooks (the keys, `grouped`, the loader, the merge of a handle's patches). A handle's drag is ONE step: the board holds its settle timer while `resizing` (`onresizestart`/`onresizeend`, also called if the box goes mid-drag), so it is one history entry and one save; Escape in the drag restores every block. The box imports no flow library and no module the editor shares (it is handed `isTextEntry`: importing it split that module out of the editor's chunk, +230 B gzip). A resize does not re-adopt blocks into frames (a single block's does not either); a move does, by `reparentOnDrop`, for every dragged block.
- **The layers that float over the board stay in the pane and off each other** (RC-3 N3). The change pill, the selection's pill and the zoom control are kept on the screen, never off its edge: `keepPillInPane` and `selectionPillPlacement` slide them along it (`canvas/_lib/floating.ts` holds the shared `ScreenRect`, the edge gap and `measuredBy`, which reads a layer's real size), the selection's pill keeps off the change pill's rectangle (the layer reports it through `BoardLayerApi.changePillBox`; lazy entries never query each other's DOM), and the zoom control steps aside (`visibility`) while a selected block is under it. A new layer that floats reports its box the same way.
- **The board follows its pane only until the reader touches it** (TR-D1, TR-D3). A tour card arriving or going, a window resize or a bar appearing changes the pane's size, and a populated board that had already fitted itself used to be left with rows under the fold. `CanvasBoard` keeps `fitted`, the camera its last fit produced (the library's own first fit, which `onmoveend` reports with no pointer or key behind it, or `fitBoard`: the Fit button is one), and fits again, instantly, on every size change (a frame at a time over a transition), while `followsPane(flow.getViewport(), fitted, touched)` (`_lib/board-model.ts`) holds: the camera is still the fit's and `touched` is false. `touched` is the camera becoming the reader's: a pointer or touch down anywhere in the board, or the focus entering it (two capture listeners on its root: a tap, a click, a Tab, a script moving the focus into a note), sets it, and only the Fit button clears it (it fits, and is the reference again until the next touch). That is what keeps the on-screen keyboard from moving the board: the viewport meta says `interactive-widget=resizes-content`, so on Android Chrome the keyboard that opens when a reader taps a note to type shortens the page, and a board that zooms and moves as it opens (and again as it closes) moves under the note they are writing in; a bar, a sheet or a window resize after their first touch is the same. The camera guard stays beside the flag, for what moves the camera without a press in the board (a centring from the comments column): any pan, zoom, centring or auto-pan changes the camera, so it stops being the fit's. A board saved with a camera of its own has no fit to keep (`fitted` stays null), and nothing is fitted while a picture of the board is drawn or Alfy's landing holds the board. Known gap: a camera that stays put leaves a block lower than the keyboard's top edge behind the keyboard while the reader types in it, and the browser cannot scroll it into view (the library undoes the wrapper's scroll, `Wrapper.svelte`'s `wrapperOnScroll`); a pan that reveals the block being edited is not built. Do not add a second record of where the camera was or a resize listener beside it.

#### Tours

The first time a user opens a Document, an App or a Canvas the panel shows a three-slide card about that kind (rulings 4, 8, 32, 33, 69, 71; Slides is shelved, so no Slides tour and no Slides chip on the Knowledge tab (`DOCUMENT_TYPE_FILTER_ORDER`), and File never has one).

- **Server.** `src/lib/server/services/artifact-tours.ts` resolves a kind's tour (the newest published `artifact_tour` campaign snapshot, else the code copy in `src/lib/server/artifact-tour-defaults.ts`; archiving a published tour gives the kind its code copy back, never "no tour", ruling 71: the text is editable and the trigger is not), records "seen" (`markArtifactTourSeen`, insert-if-absent on `(user, kind, content key)`, so the first answer stands) and seeds the admin drafts. `src/routes/api/artifact-tours/[type]` (GET) and `.../seen` (POST) are thin (`requireApiUser`); the browser reaches them only through `src/lib/client/api/artifact-tours.ts`. `SHIPPED_ARTIFACT_TOUR_TYPES` in `src/lib/shared/artifacts/tours.ts` is the one list of kinds whose tour ships: routes, resolver, seeding, the archive and the panel all read it, so never walk `ARTIFACT_TOUR_DEFAULTS`' keys to serve or list a kind. The seen row (`artifact_tour_states`) holds a user, a kind, a content key, a status and slide counters, never a conversation or an artifact; no tour code path reads an artifact table, and there is deliberately no `ALLOWED_WITHOUT_SCOPE` entry for any of it. `getLatestPublishedAnnouncement()` is the one reader for the sidebar version badge: the newest published first-run onboarding or release update (ADR-0012), never a tour, with no type argument for a caller to get wrong. **A kind has one live tour**: `publishCampaign` archives any older published `artifact_tour` of the same kind in the same transaction, so archiving the newest gives the kind its code copy back and not the revision before it (a release note keeps its older published revisions). **A tour's summary slide is one bare line**: its title is what an empty Document, App or Canvas shows, so neither the publish rule nor its checklist mirror asks it for a body and the seed leaves the body empty. **A tour's kind is its campaign's release text**, and the resolver finds a tour by exactly that, so `announcement-campaigns.ts`'s `validatePublishInput` refuses to publish an `artifact_tour` whose `releaseVersion` is not on the shipped list (`tourKind`, mirrored by `campaign-checklist.ts`, so Publish is dead before a click); the admin pane's lines say "Tour · Canvas", the kind in its `artifacts.type.*` word (`campaigns/campaign-labels.ts`), never "Release · canvas".
- **The admin's editor knows a tour is not an announcement.** In `src/routes/(app)/settings/_components/campaigns/` a tour's slides have words only (no screenshot, alt text or button), the summary slide says what its title is and has no body field (`SlideEditor`'s `tour` prop), the details dialog shows the type read-only, Summary is offered to a tour alone and Setup not to it (`SlideOptionsDialog`), the rail and the header count steps and the empty-state line (`tourCountLabel`, `tourStepNumbers` in `campaign-labels.ts`), no performance card is drawn for a tour, publishing one refreshes the rail (the revision it replaced is archived behind it), and the preview is `TourPreview.svelte`: the reader's own card, loaded lazily from `artifacts/tour/`, `inert`, fed the draft's words in the language being edited (the summary slide previews as the shared `EmptyState`). Drafts the seed makes are named in the seeding admin's language (`TOUR_DRAFT_NAMES` in `artifact-tours.ts`), and `seedArtifactTours` lives in `client/api/campaigns.ts` with the other admin calls, not in `client/api/artifact-tours.ts`, which the chat loads. The account archive lists the introductions a user has seen on the Profile page.
- **The panel decides, the card reports.** `DocumentWorkspace.svelte` asks once when an item of a shipped kind becomes the open one (`tourItemKind`/`presentTour`), and shows `tour/ArtifactTour.svelte` in the content area above the body when the answer is an unseen tour. It writes "completed" or "dismissed" when the reader finishes or Skips, never when the card renders (closing the panel mid-tour writes nothing and the card is met again), reads a 409 as "the copy changed" (ask again, start the new one at slide one), and treats any failure as a console warning with the panel working as before. **An incognito chat makes no tour request at all** (the panel's `incognito` prop, from the chat page): a tour's seen state is a write, and incognito promises none. The card and its three drawings (`tour/illustrations/`) are one lazy chunk, imported only when a tour is about to show; nothing static in the chat shell may import them. **How the card arrives** (RC-T I-1): the answer is kept per page load in `client/api/artifact-tours.ts` (one request per kind, shared while on the wire; a failed read is not kept; a finished or skipped tour is seen at once, before the write lands; a refused or failed write forgets the kind, so a 409 re-asks the server; a replay uses `refreshArtifactTour`; login and logout are client-side navigations, so the panel names the reader with `keepArtifactToursFor(currentUser?.id)` before it asks and a different reader starts clean), so a second item of a kind costs no request and shows its line from the first frame; the panel asks in the same flush that opens the item, before the body has painted. The card **enters and leaves as a height that grows and shrinks** (the panel passes `animate`: a `slide` on a wrapper with a *global* transition, because the panel removes the card and not the wrapper's own block; `MOTION_DURATION.emphasis`, instant under reduced motion; the admin's preview does not animate), so what is below it moves over about a quarter of a second instead of jumping a card's height in one frame, and it hands focus back the moment the reader leaves, not when the exit has played. A card is revealed, never re-laid out: the wrapper animates, the card inside keeps its size. A late answer therefore still moves the page, but as a transition; a Canvas below it that the reader has not touched re-fits (see the Canvas paragraph on `followsPane`). Next and Back announce the new step's position and title through a live region of the card's own (`artifact-tour-live`); the visible step line is plain text.
- **The empty states say what the tour says** (T6). A Document, an App and a Canvas with nothing in them draw one shared `EmptyState.svelte`: the kind's line and, beneath it, a quiet "Show it again" button that calls `ArtifactBodyProps.onReplayTour`. The line is `emptyStateLine(...)` (`artifacts/empty-state.ts`): the tour's summary in the reader's language when one answered, else the dictionary's fallback (`EMPTY_STATE_FALLBACK_KEYS`: `artifacts.document.emptyState`, `artifacts.app.emptyState`, `artifacts.canvas.emptyBoard`), and `empty-state.test.ts` fails when a shipped summary and its fallback disagree, so a copy edit has one place to go. The panel keeps `tour.summary` from the one request it already makes per open (seen or not) and hands it down as `ArtifactBodyProps.tourSummary`; a body never asks for it itself, and an incognito chat, which asks for none, shows the dictionary's line and **no link**. Where each kind's empty state is: the Canvas's centred over the empty board (`CanvasBoard`'s `canvas-empty`), the Document's laid just under the page's first line while the editor reports itself empty (`createDocumentEditor`'s `onEmptyChange`, asked of every transaction, because Alfy's landing content and a restored version are silent; the Tiptap placeholder has no style and is not the empty state), the App's in the Preview where a blank frame would be (an App with no source; the tools never save one, so it is rare). Do not add a fourth copy of the line or a per-kind link.
- **Replay lives in the panel** (ruling 32): the list row menu's "How this kind works" (`ArtifactDeletePopover`'s `onReplayTour`, quiet, above Delete; the menu is a real `role="menu"`: it opens on its first item through `AnchoredPopover`'s `initialFocus`, ArrowDown/ArrowUp wrap between the items, Home/End go to the ends, Escape closes it and gives the focus back) and `ArtifactBodyProps.onReplayTour`, the one callback a body's empty state calls (supplied only where a tour can show: never for another kind, never in an incognito chat). A replay shows the same card, labelled "Replaying", and records nothing: the card calls `onClose`, never `onSeen`/`onDismiss`.
- **The card is a region, not a dialog.** It traps no focus and makes nothing inert; it takes focus when it shows unless the reader is already typing, gives it back when it goes, and Escape is Skip only while focus is inside it. Next and "Got it" are one button so the keyboard keeps its place. The chrome is `artifacts.tour.*`; the tour's own words are content (code copy or campaign), never in the dictionary.
- **e2e.** The shared e2e admin has seen every tour (`tests/e2e/global-setup.ts` writes the rows), so no other spec meets a card; `tests/e2e/artifact-tours.spec.ts` signs in as users of its own (`artifact-tours-helpers.ts`). A published tour is taken back out the way an admin does it, by archiving (`archiveTour`; ruling 71 gives the kind its code copy back, so no later spec meets a tour nobody has seen); `publishTour` duplicates the kind's last campaign when an earlier test left no draft, and can reword the summary (the empty state's line). `artifact-tours-empty-states.spec.ts` covers the empty states with readers who have finished every tour (`markToursSeen`).

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
  - [`src/lib/server/services/knowledge/project-knowledge.ts`](./src/lib/server/services/knowledge/project-knowledge.ts) — owns project-file links and the project's FILES (`listProjectKnowledge`: what a turn's prompt section and file-name mentions read, so it never lists a Document, App or Canvas — a family row is not prompt-ready as a linked source and a mention of its name would 409 the turn); the person's bundle, files plus what the chats made, is `listProjectBundle` in the artifacts service
- Related services:
  - [`src/lib/server/services/working-set.ts`](./src/lib/server/services/working-set.ts)
  - [`src/lib/server/services/workspace-search.ts`](./src/lib/server/services/workspace-search.ts)
  - [`src/lib/server/services/document-resolution.ts`](./src/lib/server/services/document-resolution.ts)
  - [`src/lib/server/services/extraction/`](./src/lib/server/services/extraction/) — the durable extraction ledger and its worker; replaced the deleted `document-extraction.ts`
  - [`src/lib/shared/file-types/`](./src/lib/shared/file-types/) — the one registry of extensions, MIME types, intake routes and producible outputs
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
  - normalized artifact creation, prompt readiness, and upload trace output
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
- add in-app file editing for uploaded or generated files (Artifacts are the one in-place-edited kind; see [ADR-0065](docs/adr/0065-living-documents-are-edited-in-place.md) and [ADR-0066](docs/adr/0066-artifacts-are-a-family-of-five-types.md))
- allow AI to edit existing uploaded library files (AI generates NEW files only; Artifacts are the ADR-0065/0066 exception)
- add batch operations in v1
- add file deduplication (allow duplicates with auto-rename)
- use external hosted services for file preview

### Memory, Continuity, And The Memory Judge

Task/document continuity and profile memory are separate subsystems. Continuity lives on `task-state.ts`; durable profile memory (facts about the user) is owned by the local Memory Profile Projection plus the LLM intake judge and nightly consolidation. There is no external memory service.

- Continuity boundary:
  - [`src/lib/server/services/task-state.ts`](./src/lib/server/services/task-state.ts) plus its internal modules under `task-state/` (control-model, continuity, artifacts, chunk-sync, mappers)
- Profile memory judge (intake):
  - [`src/lib/server/services/memory-judge/`](./src/lib/server/services/memory-judge/) — `index.ts` (per-segment run), `runner.ts` (idle/dirty sweep), `segment.ts` (watermarks), `prompt.ts`, `schema.ts`
- Consolidation (nightly rework):
  - [`src/lib/server/services/memory-consolidation/`](./src/lib/server/services/memory-consolidation/) — `index.ts` (runner + scheduler), `steps.ts` (expire/renew, reconcile/merge), `summary.ts` (persona summary)
- Recuration (one-time cleanup):
  - [`src/lib/server/services/memory-recuration.ts`](./src/lib/server/services/memory-recuration.ts)
- Fact store authority:
  - [`src/lib/server/services/memory-profile/`](./src/lib/server/services/memory-profile/) — see its narrow seams (`projection-store.ts`, `read-model.ts`, `active-context.ts`, `telemetry.ts`, `review.ts`, `dirty-ledger.ts`, `types.ts`)
- Recall into prompts:
  - [`src/lib/server/services/memory-context/`](./src/lib/server/services/memory-context/)
- Public read facade + maintenance/orchestration:
  - [`src/lib/server/services/memory.ts`](./src/lib/server/services/memory.ts), [`src/lib/server/services/memory-maintenance.ts`](./src/lib/server/services/memory-maintenance.ts)
- Event log:
  - [`src/lib/server/services/memory-behavior-log.ts`](./src/lib/server/services/memory-behavior-log.ts)

Rules:

- `memory-judge/` is the only intake path from conversation into profile memory. It runs on three tiers of triggers — idle (deferred after a turn), explicit (user asks to remember), and marathon/sweep (long or backlogged conversations) — over the unjudged segment tracked by per-conversation watermarks in `segment.ts`. Advance the watermark only after a real run; never re-judge already-judged messages.
- The judge admits candidates through five gates in `schema.ts` (hedge, evidence-trail, third-person, missing-expiry for time_bound, missing-target for update/strengthen). Keep the gate order and reasons stable; post-filter rejects must stay measurable via the `judge_candidate_rejected` intake telemetry rather than being dropped silently.
- Honour the dry-run switch (`MEMORY_JUDGE_DRY_RUN`): in dry-run the judge records `judge_dry_run_decision` telemetry and advances the watermark but writes no profile items. Do not add a second dry-run flag or bypass it in routes.
- `memory-consolidation/` is revision-based and per-user isolated: expire/renew then reconcile/merge steps run against the current projection revision, write a report row per non-skipped run, and refresh the persona summary. Change detection may skip a user with nothing new. Never let one user's consolidation read or write another user's items.
- `memory-recuration.ts` is a one-time, admin-triggered rewrite/cleanup of the existing fact store; it is not part of the per-turn path. Do not wire it into chat routes or the scheduler.
- `memory-profile/` is the authority on fact state: item `status` (including `retired`), provenance, and projection revisions. User-protected items — `user_authored` items and facts the user accepted in Guided Memory Review (true `origin` kept, `endorsement: "user_accepted"` added) — must never be rewritten, retired, merged, superseded, or deleted by the judge, consolidation, or recuration; the user can still edit or remove them. The one exception is consolidation's renew step: an accepted (not `user_authored`) time-bound fact is renewed on the same recent-evidence rule as any other time-bound fact, and only its `expiresAt`/`updatedAt` change, because its expiry was inferred; a `user_authored` fact's end date is the user's own and is never auto-extended. Automated writers gate on the single predicate `isUserProtectedMemoryMetadata` (or `readMemoryItemUserProtection` when the reason matters, as renew does) in `memory-profile/types.ts`; read item metadata through `parseMemoryItemMetadata`. Do not re-implement origin or endorsement checks locally.
- Recall belongs to `memory-context/`: the prompt gets the persona summary plus active facts, each fact carrying its own evidence. Do not build a second lexical/semantic persona search surface beside this boundary, and do not invent "today/now" timing for undated facts.
- `memory.ts` is the public read facade for the Knowledge Base Memory Profile and keeps `/api/knowledge/memory/overview` as a projection-backed wrapper. It must not depend on a live external overview service, raw markdown cleanup, or task-memory tables.
- `memory-behavior-log.ts` owns the persisted normalized event log (recorded via `recordMemoryBehaviorEvent`, backed by the `memory_events` table) for important state changes (deadlines, preference updates, fact replacement, project continuity transitions, document supersession). Add new event types there; do not create ad hoc side logs or route-local event tables.
- `task-state.ts` remains the continuity facade (task routing, checkpoints, evidence-context assembly, semantic task revival). Keep project continuity status/event truth deterministic in `task-state/continuity.ts`, which prefers the latest `project_paused`/`project_resumed` task-domain event over an older still-active row.
- User-selected task evidence preferences stay family-aware for working documents: pinning/excluding one version clears contradictory preference links for sibling versions in the same family. Live Working Document selection signals belong in `working-document-selection.ts`, recomputed per turn.
- `memory-maintenance.ts` owns per-user maintenance scheduling and lazy semantic-embedding backfill. Chat-triggered maintenance stays serialized/debounced there; generated-output duplicate repair and dormant-family (`historical`) downgrades reuse `evidence-family.ts` from there rather than a separate sweep. Historical families are soft-deprioritized, not hidden.
- Artifact retrieval and cleanup treat linked conversation ownership as stronger authority than `artifacts.userId` alone. Conversation-scoped working artifacts (`generated_output`, `work_capsule`) are not valid retrieval candidates once their conversation link is gone.

Do not:

- create a new top-level continuity service when `task-state.ts` can own the behavior
- add a second intake path, regex persona pipeline, or temporal-truth/salience/supersession subsystem outside `memory-judge`/`memory-consolidation`/`memory-profile`
- copy the `user_authored`/metadata parse helpers, `clip`, token estimation, or prompt-compaction helpers into another service
- create or restore `project-memory.ts`, `persona-memory.ts`, or any external memory adapter (e.g. the removed Honcho dual-brain — memory is local-only, see ADR-0045)

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
- Two-scope instruction resolution: [`src/lib/server/services/instructions.ts`](./src/lib/server/services/instructions.ts)

Notes:

- `env.ts` also owns `getDatabasePath()` for bootstrap-only DB path access.
- Title-generator prompt variants flow through `env.ts`, `config-store.ts`, and the admin system settings UI. Keep English/Hungarian base prompts and code-only appendices aligned across those layers.
- TEI endpoint/model tuning also flows through `env.ts` plus `config-store.ts`. Keep API keys env-only, and keep runtime overrides on the non-secret fields.
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
- `src/lib/client/api/conversations.ts` owns reusable browser conversation-detail, evidence, and title calls.
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
- open-code reusable browser auth, model, conversation-detail, evidence, title, or knowledge fetches in pages/components when they can live in `src/lib/client/api/`
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
  - [`src/lib/server/prompts.ts`](./src/lib/server/prompts.ts) — shared prompt configuration helpers. Consumed by Normal Chat context assembly.
  - [`src/lib/server/api/responses.ts`](./src/lib/server/api/responses.ts) — shared JSON response helpers (`createJsonErrorResponse`, `createJsonResponse`) for API routes. Used across route files for consistent error/success formatting.
  - [`src/lib/server/services/analytics.ts`](./src/lib/server/services/analytics.ts) — analytics event ingestion plus the Analytics Dashboard Read Model. Event ingestion is consumed by chat-turn finalization; `getAnalyticsDashboardReadModel(...)` owns `/api/analytics` payload assembly for personal, admin system, per-user, timeline, and mock analytics. `src/routes/api/analytics/+server.ts` stays a route adapter for auth, query parameters, and JSON response mapping.
  - [`src/lib/server/services/file-production/`](./src/lib/server/services/file-production/) — durable file-production jobs, source validation, renderers, sandbox execution, retry/cancel, and legacy generated-file backfill.

- Other API endpoints:
  - [`src/routes/api/chat/stream/buffer/+server.ts`](./src/routes/api/chat/stream/buffer/+server.ts) — stream buffer replay for reconnection
  - [`src/routes/api/chat/stream/status/+server.ts`](./src/routes/api/chat/stream/status/+server.ts) — stream capacity/status check
  - `src/routes/api/favicon/+server.ts` — same-origin favicon proxy (ADR 0043). Unauthenticated-safe, source-site `/favicon.ico` first with a DuckDuckGo fallback, cached, fails gracefully to a generic icon. Replaces the direct third-party Google S2 call in `ThinkingBlock` so researched domains do not leak to Google and favicons work behind firewalls.

- Active project service:
  - [`src/lib/server/services/projects.ts`](./src/lib/server/services/projects.ts) — project CRUD using `db` + `schema.ts` directly. Not a legacy DB wrapper; active service.
  - [`projects.ts`](./src/lib/server/services/projects.ts) also owns the project-page reads (`getProjectPageData`, `getProjectInstructions`) and `listRecentlyActiveProjects`, the single definition of "a project with recent activity"; lists carry `hasInstructions` and never the instruction text, and `home-summary.ts` consumes `listRecentlyActiveProjects` rather than re-deriving project activity.

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
- Auxiliary services such as title generation and context summarization should degrade gracefully. Do not make them hard dependencies of the core chat path unless that behavior change is intentional.
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
- New artifact-family (Document/App/Canvas/Slides/File) behavior:
  - `src/lib/server/services/artifacts/`
  - `src/lib/components/artifacts/`
- New chat-generated file behavior:
  - `src/lib/server/services/chat-files.ts`
  - `src/lib/server/services/sandbox-execution.ts`
- New continuity or evidence-context logic:
  - `src/lib/server/services/task-state.ts`
- New profile-memory behavior:
  - `src/lib/server/services/memory-judge/` (intake), `memory-consolidation/` (maintenance), `memory-profile/` (projection)
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
- No parallel memory subsystem beside `task-state.ts` (continuity) and the Memory Profile / Memory Judge / Consolidation stack (profile memory).
- No duplicated route-specific chat execution logic.
- No new raw `sessionStorage` protocol outside `conversation-session.ts`.
- No direct env reads in override-aware runtime services.
- No general runtime migrations in app bootstrap. If production safety ever requires a bounded additive compatibility shim, keep it isolated in `src/lib/server/db/compat.ts`, document it in the README, and continue treating `npm run db:prepare` as the real migration path.
- No duplicate DB repository wrappers. (Per-table wrappers stay forbidden. ONE query-execution
  seam is permitted under [ADR-0059](docs/adr/0059-db-execution-seam.md) — owning *how* a query
  runs, not *what* is queried.)
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

If a supplemental doc conflicts with this file or the README, update the supplemental doc rather than copying the stale pattern back into the codebase.
