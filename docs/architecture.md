# Architecture Overview

At a high level, AlfyAI runs as a single SvelteKit application with server routes, client UI, and
persistence in the same repository. Runtime config comes from environment variables first, with
selected values optionally overridden later through the admin settings UI and stored in SQLite. See
the [ADR index](adr/README.md) for the recorded decisions behind these boundaries.

## Request and turn lifecycle

- Server hooks validate the session, attach the current user, load runtime config overrides, and start
  optional maintenance schedulers (memory, routing regions). Sentry is initialized here when a DSN is
  configured (`src/hooks.server.ts`, `src/hooks.client.ts`).
- The app layout preloads conversations, projects, model availability, and user preferences before the
  main UI renders.
- The landing page prepares a draft conversation, stores any pending first message, and navigates into
  the chat page once a conversation exists. Landing-page draft reuse is guarded: only empty
  default-title prepared conversations are reused from session storage, which prevents new sends from
  silently reusing an older real chat.
- The chat page consumes any pending initial message, supports one queued follow-up turn while a
  response is streaming, and streams the assistant response over Server-Sent Events
  ([ADR 0060](adr/0060-client-turn-runtime-owns-turn-state.md)).
- Stream admission happens before heavy turn preparation
  ([ADR 0041](adr/0041-stream-admission-before-turn-preparation.md)), bounded by
  `CONCURRENT_STREAM_LIMIT` and `PER_USER_STREAM_LIMIT`.
- Authenticated chat turns feed the current user's display name and email into system-prompt assembly
  as scoped personalization context, so the assistant can address the user naturally even on the first
  message.
- The shared chat-turn pipeline handles request parsing, attachment readiness, Vercel AI SDK /
  OpenAI-compatible model execution, memory/context updates, persistence, and response finalization
  ([ADR 0015](adr/0015-normal-chat-turn-completion-boundary.md)). Outbound prompt assembly includes a
  centralized date-before-search guard for freshness-sensitive searches.
- Conversation history is sent to the model as native chat turns (user/assistant/tool messages) so the
  prefix is cacheable and the model sees its own prior tool use (`NATIVE_HISTORY_ENABLED`).

## Model execution

- Normal Chat runs on the Vercel AI SDK (`ai` v6) with OpenAI-compatible providers, having retired
  Langflow ([ADR 0026](adr/0026-normal-chat-retires-langflow-for-vercel-ai-sdk.md)).
- A Model Provider / Provider Model separation
  ([ADR 0027](adr/0027-model-provider-and-provider-model-separation.md)) and provider-family
  compatibility profiles ([ADR 0048](adr/0048-openai-compatible-provider-family-compatibility.md))
  absorb the quirks of different OpenAI-compatible backends.
- A single Thinking toggle replaces the earlier Reasoning Depth ladder
  ([ADR 0061](adr/0061-thinking-toggle-replaces-depth-ladder.md)); automatic depth, where used, is a
  deterministic rules classifier ([ADR 0046](adr/0046-automatic-depth-selection-is-deterministic.md)).
- Title generation and context summarization are auxiliary OpenAI-compatible services that can fail
  independently without blocking core chat.

## Tools

The model calls app-owned AI SDK tools defined in
[`src/lib/server/services/normal-chat-tools/index.ts`](../src/lib/server/services/normal-chat-tools/index.ts).
Roughly 18 tools are exposed: `research_web`, `fetch_url`, `map_route`, `memory_context`,
`image_search`, `produce_file`, `read_generated_file`, `run_python`, `files`, `calendar`, `email`,
`photos`, `media`, `location`, `contacts`, `repos`, `tasks`, and `use_skill`. `research_web` and
`fetch_url` are only registered when Parallel is configured; the connection-backed tools (`files`,
`calendar`, `email`, `photos`, `media`, `contacts`, `repos`, `tasks`) surface data from Connections.
Tool usage guidance lives in the tool interface itself
([ADR 0055](adr/0055-tool-usage-guidance-lives-in-the-tool-interface.md)).

## File production and the working-document workspace

- Chat-generated files are created through the app-owned `produce_file` tool and durable
  file-production jobs, behind one unified file-production boundary
  ([ADR 0005](adr/0005-unified-file-production-boundary.md)). The model-facing output-list field is
  `requestedOutputs`. Document-style files should prefer `sourceMode: "document_source"` with
  structured `documentSource`; genuinely programmatic exports use `sourceMode: "program"` and write
  final files to `/output`. Program-mode runs execute in a pinned sandbox image (pulled on first use)
  reached through `DOCKER_HOST`. A run that does not actually write a file to `/output` returns an
  explicit error rather than a silent empty success.
- The app uses a default-closed working-document workspace instead of separate preview silos.
  Generated files, chat attachments, knowledge-library documents, and search-opened documents all
  reuse the same shared rich previewer: a right-side pane on desktop and a full-screen layer on
  mobile. The heavy rich-preview stack and markdown highlighter lazy-load on first open.
- The workspace carries document identity and continuity affordances directly in the shell: version
  history for document families, source-message jump for generated outputs, compare mode for text-like
  versions, and a shared historical-status badge when a generated-document family has gone dormant.
  Generated files are first-class working documents backed by generated-output artifacts and shared
  family/version metadata. Working-document boundaries are recorded in ADRs
  [0017](adr/0017-working-document-identity-boundary.md) and
  [0018](adr/0018-working-document-selection-boundary.md).

## Memory v2 (local, judge-gated)

Long-term memory is fully local and judge-gated — there is no external memory service (ADRs
[0045](adr/0045-memory-v2-judge-gated-local-memory.md),
[0057](adr/0057-memory-v2-internal-hardening.md); a guard test,
`src/lib/server/services/no-honcho.test.ts`, enforces the absence of the retired external substrate).
It is built from four services:

- `memory-judge/` — judges post-turn candidate memories (deferred until a user is idle for
  `MEMORY_JUDGE_IDLE_MINUTES`).
- `memory-consolidation/` — the nightly consolidation / persona-summary pass.
- `memory-profile/` — the durable per-user memory profile (one write door).
- `memory-context/` — the read seam that injects memory into prompt assembly, also reachable by the
  model through the `memory_context` tool.

Models and cadence are configured with `MEMORY_JUDGE_MODEL`, `MEMORY_CONSOLIDATION_MODEL`,
`MEMORY_JUDGE_IDLE_MINUTES`, `MEMORY_CONSOLIDATION_INTERVAL_MINUTES`, `MEMORY_JUDGE_DRY_RUN`, and
`MEMORY_MAINTENANCE_INTERVAL_MINUTES`.

## Connections

Connections links external accounts and exposes their data to the connection-backed tools. Providers
live in
[`src/lib/server/services/connections/providers/`](../src/lib/server/services/connections/providers/)
and back-end module seams are defined by
[ADR 0050](adr/0050-connections-backend-module-seams.md) (UI redesign in
[ADR 0044](adr/0044-connections-ui-redesign.md); catalog grouping in
[ADR 0058](adr/0058-todoist-retired-and-connection-catalog-grouped.md)). Current providers:

- **Google** (OAuth) and **Google Calendar** (with write)
- **Contacts**
- **IMAP email** (with write)
- **Apple CalDAV** and **CalDAV tasks**
- **GitHub** (read-only)
- **Nextcloud files** and **OneDrive** (read-only)
- **Immich** (with write) and **Plex**
- **OwnTracks** (location)

OAuth callback routes live under `src/routes/api/oauth/` (`google`, `onedrive`). Only Google uses an
OAuth client secret (`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`); the other providers
authenticate per-provider inside the app.

## Document extraction (MinerU)

Uploaded and in-chat documents are parsed by MinerU, a Docker-hosted parsing engine the app POSTs
files to (`${MINERU_API_URL}/file_parse`, in
[`src/lib/server/services/document-extraction.ts`](../src/lib/server/services/document-extraction.ts)).
MinerU handles PDF/Office/image/web inputs with built-in OCR. Knowledge upload intake is a dedicated
boundary ([ADR 0024](adr/0024-knowledge-upload-intake-boundary.md)). See
[docs/uploads.md](uploads.md).

## Maps and routing

The `map_route` tool answers distance, route, travel-time, and transit questions against a self-hosted
OpenRouteService instance, with optional on-demand region building and GTFS timetables. Inline map
cards use `maplibre-gl` and a tile proxy at `GET /api/map-tiles/[z]/[x]/[y]`. See
[docs/routing.md](routing.md).

## Browser push notifications

Browser push uses the `web-push` library with VAPID keys. Subscriptions are managed at
`src/routes/api/browser-push/`, delivered through the service worker `static/browser-push-sw.js`, and
sent from `src/lib/server/services/browser-push.ts`. Push stays disabled until the three
`WEB_PUSH_VAPID_*` values are configured (see
[docs/configuration.md](configuration.md#web-push-notifications)).

## Persistence and service boundaries

- SQLite (`better-sqlite3` + Drizzle ORM) is the single datastore; query execution goes through one
  seam ([ADR 0059](adr/0059-db-execution-seam.md)).
- Knowledge-base operations, task-state continuity, memory, and connections all sit behind server
  service boundaries rather than directly in route files.
- Workspace search is server-backed ([ADR 0034](adr/0034-workspace-search-boundary.md)).
- Deploys cut over atomically between immutable release directories
  ([ADR 0054](adr/0054-atomic-release-cutover.md)); see [deploy/README.md](../deploy/README.md).

## Interface and content characteristics

- The product is intentionally reading-focused rather than dashboard-like: message content uses a
  serif text face, while the surrounding UI uses a sans-serif system for clearer navigation and
  controls ([ADR 0035](adr/0035-chat-surface-visual-design-decisions.md)).
- Markdown responses are rendered with code highlighting and sanitization, so technical answers can mix
  prose, code blocks, and inline snippets safely.
- The same app shell supports desktop, tablet, and mobile layouts, with the conversation view
  remaining the primary surface across breakpoints
  ([ADR 0043](adr/0043-ui-refresh-identity-clarity-and-jump-rail.md)).
- Sidebar conversations can be organized into project folders through the move flow and desktop
  drag/drop; folder-anchored continuity replaces the earlier inferred buckets
  ([ADR 0051](adr/0051-folder-anchored-continuity-retires-inferred-buckets.md)).
- Persistent conversations, AI-generated titles, file-backed knowledge attachments, and memory are
  designed as additive layers around the core chat flow rather than separate products.

## Internal API families

AlfyAI ships internal API families such as `/api/chat`, `/api/conversations`, `/api/knowledge`,
`/api/settings`, `/api/admin`, `/api/oauth`, and `/api/map-tiles`. These power the application itself.
They are not presented as a stable public integration API, and route details may evolve with the
product.
