# AlfyAI

AlfyAI is a SvelteKit chat application for OpenAI-compatible AI workflows through the Vercel AI SDK. It provides streaming chat, app-owned tools, a user-scoped knowledge base, optional Honcho-backed long-term memory, and SQLite persistence in a single Node deployment.

## Stack At A Glance

- SvelteKit with Svelte 5 and Tailwind CSS 4
- `@sveltejs/adapter-node` for Node server deployment
- SQLite with `better-sqlite3` and Drizzle ORM
- Vercel AI SDK with OpenAI-compatible providers for Normal Chat
- OpenAI-compatible endpoints for chat, title generation, and optional context summarization
- Optional Hugging Face Text Embeddings Inference endpoints for embeddings and reranking
- Optional Honcho integration for cross-conversation memory

## Quick Deployment With `scripts/deploy.sh`

Prerequisites:

- Node.js 20+
- npm
- git
- a configured `.env`
- a writable `data/` directory
- reachable OpenAI-compatible model endpoints from the app server

Quick start:

```bash
cp .env.example .env
# edit .env with your real values

./scripts/deploy.sh
```

The deploy script performs these steps in order:

1. `git pull origin main`
2. `npm install`
3. `npm run db:prepare`
4. `npm run build`

Important caveats:

- `scripts/deploy.sh` restarts the systemd service automatically at the end. The deploy user needs a sudoers entry for that command: `alfydesign ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart langflow-chat.service` (or equivalent).
- If you deploy through `scripts/deploy.sh`, you should not need a separate manual DB migration step after pulls. The script always runs the idempotent `db:prepare` step so the DB catches up even if the checkout was already updated before the deploy script started.

For host-managed `adapter-node` deployments, the standard runtime entrypoint is:

```bash
npm start
```

That script now runs `npm run db:prepare && node build`, so the standard production entrypoint applies pending Drizzle migrations before serving the built app. SvelteKit adapter-node uses the `HOST` and `PORT` environment variables for the listen address, so container-reachable host setups should use `HOST=0.0.0.0` instead of `127.0.0.1`.

### Web Research Deployment

Web work runs through the app-owned `research_web` AI SDK tool. It can also enrich selected YouTube video results with transcript evidence for reviews, hands-on comparisons, and other video-backed research. Deploy it this way:

1. Deploy the app code. `scripts/deploy.sh` pulls `origin main`, so merge `dev` to `main` first or use your manual deploy flow if you are testing directly from `dev`.
2. Run a SearXNG instance reachable by the app and set `SEARXNG_BASE_URL`, for example `http://127.0.0.1:8080` for a same-host Docker container. The SearXNG instance must allow JSON output in `settings.yml` under `search: formats: [html, json]`; otherwise `research_web` diagnostics will show provider failures with HTTP 403.
34. Set `BRAVE_SEARCH_API_KEY` only when the separate `image_search` tool should be available.
5. Configure the primary Normal Chat model with `MODEL_1_BASEURL`, `MODEL_1_API_KEY`, and `MODEL_1_NAME`, or through Settings > Administration > System. The endpoint must expose an OpenAI-compatible chat-completions surface that the AI SDK provider can call.
6. Leave the optional `WEB_RESEARCH_*` env vars at their defaults unless you need different breadth, extraction, fallback, or latency behavior. They can also be changed later in Settings > Administration > System > Web Research.
7. Keep `TEI_RERANKER_URL` configured if you want source and evidence reranking. Search still works without TEI reranking, but diagnostics will show `sourceReranked: false` when reranking is unavailable or not confident.
8. Restart the AlfyAI process after changing environment variables.

Post-deploy checks:

- Ask for an exact page-backed value, for example a current price from a product URL.
- Ask for a PDF report with headings, a table, and a bar chart. It should create a successful file-production card; `unsupported_document_block` means the running AlfyAI app or document-source contract has drifted.
- Ask for a product review summary that should include video evidence; if YouTube videos are selected and transcripts are exposed, diagnostics should show `youtubeTranscriptFetchedCount > 0`.
- In the `research_web` tool result diagnostics, expect `providers.searxngConfigured: true`, `openedPageCount > 0`, `selectedSourceCount > 0`, and `evidenceCandidateCount > 0`.
- For healthy pages, local Readability extraction should produce quality Markdown evidence.
- For prices, dates, availability, specs, and similar exact values, `exactEvidenceCandidateCount` should usually be greater than `0`.
- YouTube transcript access is best-effort because some videos disable captions, require age/cookie access, or block server IPs. In those cases the video can still be returned as a source, and diagnostics include `youtube_transcript_unavailable`.
- When TEI reranking is configured and confident, `sourceReranked` and `reranked` should usually be `true`.

Deploy-script environment variables:

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `APP_DIR` | No | current working directory | Tells `scripts/deploy.sh` which checkout to deploy from | Set it when the script is invoked from outside the app directory | Script-only variable; not read by the app |

## Local Development

```bash
npm install
cp .env.example .env
npm run dev
```

Common verification commands:

```bash
npm run check   # Type check with svelte-check
npm run lint    # Lint with biome
npm test
npm run build
```

## User Bootstrap And Ongoing Admin Management

For the first local or freshly deployed instance, create an initial account from the CLI:

```bash
# default bootstrap account: admin@local / admin123
npm run seed

# explicit admin account
npx tsx scripts/seed-admin.ts --email=admin@example.com --password=secret123 --name="Admin User" --admin
```

After you can sign in as an admin, ongoing account management belongs in the app UI:

- `Settings` -> `Administration` -> `Users`
- create users
- promote or demote admin access
- revoke active sessions
- delete users

## Architecture Overview

At a high level, AlfyAI runs as a single SvelteKit application with server routes, client UI, and persistence in the same repository.

- Server hooks validate the session, attach the current user, load runtime config overrides, and start optional maintenance schedulers.
- The app layout preloads conversations, projects, model availability, and user preferences before the main UI renders.
- The landing page prepares a draft conversation, stores any pending first message, and navigates into the chat page once a conversation exists.
- Landing-page draft reuse is guarded: only empty default-title prepared conversations are reused from session storage, which prevents new sends from silently reusing an older real chat.
- The chat page consumes any pending initial message, supports one queued follow-up turn while a response is streaming, and streams the assistant response over Server-Sent Events.
- Authenticated chat turns automatically feed the current user account's display name and email into system-prompt assembly as scoped personalization context, so the assistant can address the user naturally even on the first message.
- Chat-generated files are created through the app-owned AI SDK `produce_file` tool and durable file-production jobs. The model-facing output-list field is `requestedOutputs`. Document-style files should prefer `sourceMode: "document_source"` with structured `documentSource`; genuinely programmatic exports use `sourceMode: "program"` and write final files to `/output`. On a fresh host, the first program-mode run may also pull the pinned sandbox image before execution starts.
- The app now uses a default-closed working-document workspace instead of separate preview silos. Generated files, chat attachments, knowledge-library documents, and search-opened documents all reuse the same shared rich previewer: embedded in a right-side pane on desktop and a full-screen layer on mobile.
- The shared preview/workspace path now lazy-loads the heavy rich-preview stack and markdown highlighter on first open, so idle chat and knowledge pages do not pay the full document-preview cost up front.
- The working-document workspace now carries document identity and continuity affordances directly in the shell: version history for document families, source-message jump for generated outputs, compare mode for text-like versions, and a shared historical-status badge when a generated-document family has gone dormant.
- Generated files now become first-class working documents backed by generated-output artifacts, shared family/version metadata, and Honcho sync.
- The shared chat-turn pipeline handles request parsing, attachment readiness, Vercel AI SDK/OpenAI-compatible model execution, memory/context updates, persistence, and response finalization.
- Outbound Normal Chat prompt assembly includes a centralized date-before-search guard for freshness-sensitive searches.
- Knowledge-base operations, task-state continuity, and optional Honcho sync sit behind server service boundaries rather than directly in route files.
- Runtime config comes from environment variables first, with selected values optionally overridden later through the admin settings UI and stored in SQLite.

### Interface And Content Characteristics

- The product is intentionally reading-focused rather than dashboard-like: message content uses a serif text face, while the surrounding UI uses a sans-serif system for clearer navigation and controls.
- Markdown responses are rendered with code highlighting and sanitization, so technical answers can mix prose, code blocks, and inline snippets safely.
- The same app shell supports desktop, tablet, and mobile layouts, with the conversation view remaining the primary surface across breakpoints.
- Sidebar conversations can be organized into project folders through the existing move flow and desktop drag/drop.
- Persistent conversations, AI-generated titles, file-backed knowledge attachments, and optional memory features are designed as additive layers around the core chat flow rather than separate products.
- Working-document planning and rollout details live in [docs/working-documents-architecture.md](./docs/working-documents-architecture.md) and [docs/working-documents-implementation-plan.md](./docs/working-documents-implementation-plan.md). The direction is to consolidate generated files and attachments onto one document system built on the existing artifact backbone rather than creating overlapping product concepts.

## Configuration Reference

Notes before the tables:

- Only `SESSION_SECRET` is hard-required at app boot.
- Some settings can also be overridden later in the admin UI and stored in the database.
- Model and title-generator system prompts default to empty and are intended to be set in the admin UI or explicitly via env vars.
- Legacy built-in prompt keys such as `alfyai-nemotron`, `hermes-thinking`, and `default` are still recognized if you already have them stored.
- `MODEL_2_ENABLED=false` hides model 2 in the UI and forces model fallback to model 1.
- `BODY_SIZE_LIMIT` is adapter-node/server runtime behavior, not an app-level feature flag.
- The production build patches adapter-node so the default `BODY_SIZE_LIMIT` becomes `100M`.
- Knowledge uploads are currently capped at 100MB in the app, so keep `BODY_SIZE_LIMIT` at or above that limit.

### Core Runtime

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `ALFYAI_API_SIGNING_KEY` | No | empty | HMAC signing secret for scoped internal service assertions | Set it only for trusted internal service-to-service callers | Browser session-auth requests do not need it |
| `SESSION_SECRET` | Yes | none | Signs and protects session cookies | Always set to a long random secret in every environment | App boot fails if missing |
| `DATABASE_PATH` | No | `./data/chat.db` | SQLite database location | Set it when the database should live outside the repo root or on a mounted volume | The parent directory must be writable |
| `REQUEST_TIMEOUT_MS` | No | `300000` | Upstream request timeout for long-running model calls | Lower it for stricter failure windows or raise it for slower models | Affects perceived reliability on slow backends |
| `MAX_MESSAGE_LENGTH` | No | lowest enabled model cap | Global fallback maximum accepted user message length | Leave unset to derive it from the lowest enabled model Max Message Length | Can also be overridden in admin config |
| `MEMORY_LEGACY_CURATION_MODEL` | No | `model1` | Model ID used for LLM-assisted legacy memory curation | Set it to `model1`, `model2`, or `provider:<providerId>:<modelId>` when memory migration should use a dedicated model | Used only for preserved legacy memory curation; can also be overridden in admin config |
| `ATTACHMENT_TRACE_DEBUG` | No | `false` | Enables extra attachment tracing logs | Turn it on while debugging upload/readiness issues | Debug logging only; not a feature flag |
| `MAX_MODEL_CONTEXT` | No | `262144` | Global fallback maximum tokens the model context window supports | Raise it for larger context windows or lower it for stricter limits | Model-specific and provider settings can override it |
| `COMPACTION_UI_THRESHOLD` | No | `80%` of `MAX_MODEL_CONTEXT` | Global fallback UI warning threshold | Leave unset to derive from the configured context window; set it only for an explicit policy | Can also be overridden in admin config. The chat context popover additionally shows a near-trigger heads-up slightly below this threshold (see ADR 0043) |
| `TARGET_CONSTRUCTED_CONTEXT` | No | `90%` of `MAX_MODEL_CONTEXT` | Global fallback target context size before output reserve | Leave unset to derive from the configured context window; set it only for an explicit policy | Can also be overridden in admin config |
| `WORKING_SET_DOCUMENT_TOKEN_BUDGET` | No | `4000` | Token budget for working-set document snippets in prompts | Raise it if longer document excerpts should reach the model | Can also be overridden in admin config |
| `WORKING_SET_PROMPT_TOKEN_BUDGET` | No | `20000` | Token budget for the overall working-set prompt section | Raise it if more documents should be included in context | Can also be overridden in admin config |
| `SMALL_FILE_THRESHOLD_CHARS` | No | `5000` | Character threshold below which files are treated as small for extraction | Tune based on typical upload sizes | Can also be overridden in admin config |
| `SEARXNG_BASE_URL` | No | empty | Base URL for the SearXNG instance used by `research_web`, such as `http://127.0.0.1:8080` | Set it when the web research tool should be enabled | Empty disables SearXNG-backed web research; JSON output must be enabled in SearXNG |
| `BRAVE_SEARCH_API_KEY` | No | empty | API key for Brave Search image search | Set it when image search should be enabled | Empty disables Brave-backed image search |
| `WEB_RESEARCH_SEARXNG_NUM_RESULTS` | No | `12` | Results read from SearXNG for each planned query | Raise for broader searches, lower to reduce latency | Can also be overridden in admin config |
| `WEB_RESEARCH_SEARXNG_LANGUAGE` | No | `en` | SearXNG language parameter sent with each search | Use `all`, `en`, `hu`, or another SearXNG-supported language code | Can also be overridden in admin config |
| `WEB_RESEARCH_SEARXNG_SAFESEARCH` | No | `1` | SearXNG safe search level: `0`, `1`, or `2` | Tune for the deployment's audience | Can also be overridden in admin config |
| `WEB_RESEARCH_SEARXNG_CATEGORIES` | No | `general` | SearXNG categories sent with each search | Use comma-separated categories supported by the instance, such as `general,news` | Can also be overridden in admin config |
| `WEB_RESEARCH_MAX_SOURCES` | No | `8` | Max deduplicated sources returned to the model | Raise for research-heavy responses, lower for concise answers | Can also be overridden in admin config |
| `WEB_RESEARCH_HIGHLIGHT_CHARS` | No | `4000` | Max characters kept per evidence quote/snippet | Raise if quotes are too thin | Can also be overridden in admin config |
| `WEB_RESEARCH_CONTENT_CHARS` | No | `12000` | Max fetched page text kept per source before chunking | Raise when long pages are being missed | Exact/quote-required searches use at least `12000` even if this is set lower; can also be overridden in admin config |
| `WEB_RESEARCH_FRESHNESS_HOURS` | No | `24` | Recent-search window used to choose SearXNG `time_range` (`day`, `week`, `month`, or `year`) | Lower for more current results, raise for broader recent coverage | `auto` and `cache` freshness requests omit `time_range` |
| `WEB_RESEARCH_EXTRACTOR_MODE` | No | `readability` | Page extraction mode for opened sources: `readability`, `auto`, or `basic` | Use `basic` only for troubleshooting parser issues | Can also be overridden in admin config |
| `WEB_RESEARCH_EXTRACT_TIMEOUT_MS` | No | `6000` | Timeout for local opened-page fetch and extraction | Lower to protect latency, raise for slow official sources | Minimum `1000`; can also be overridden in admin config |
| `WEB_RESEARCH_EXTRACT_CACHE_TTL_HOURS` | No | `24` | In-memory TTL for extracted page Markdown/plain text | Lower for highly volatile pages or set `0` to disable cache | Cache is process-local and keyed by URL/extractor version |
| `WEB_RESEARCH_LLM_EXTRACTION_REVIEW_ENABLED` | No | `false` | Reserved flag for a future local-model extraction review step | Leave disabled; current implementation does not rewrite evidence with an LLM | Parsed from env only; not exposed as an active admin setting |
| `CONCURRENT_STREAM_LIMIT` | No | `3` | Max concurrent chat streams across all users | Lower it to reduce server load | Can also be overridden in admin config |
| `PER_USER_STREAM_LIMIT` | No | `1` | Max concurrent chat streams per user | Lower it to reduce per-user load | Can also be overridden in admin config |

### Primary And Secondary Model Endpoints

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `MODEL_1_BASEURL` | No | `http://localhost:30001/v1` | OpenAI-compatible base URL for the primary model | Set it to your main chat model endpoint | Used by the Vercel AI SDK OpenAI-compatible provider |
| `MODEL_1_API_KEY` | No | empty | API key for model 1 | Set it when your model endpoint requires auth | Empty is valid for unauthenticated local servers |
| `MODEL_1_NAME` | No | `model-1` | Model identifier sent to model 1 | Set it to the exact served model name | Must match the upstream endpoint |
| `MODEL_1_DISPLAY_NAME` | No | `Model 1` | Public label shown in the UI | Set it for clearer model names in the product | Cosmetic only |
| `MODEL_1_SYSTEM_PROMPT` | No | empty | System prompt text for model 1 | Set it in admin config or env when model 1 needs a specific system prompt | Legacy built-in keys are still accepted for backwards compatibility |
| `MODEL_1_MAX_TOKENS` | No | empty | Max output tokens passed to the primary model provider | Set it to cap model output length | Empty leaves provider defaults in control |
| `MODEL_1_MAX_MODEL_CONTEXT` | No | `MAX_MODEL_CONTEXT` | Context window for model 1 | Set it when model 1 differs from the global fallback | Target and compaction defaults derive from this value when their model-specific overrides are unset |
| `MODEL_1_COMPACTION_UI_THRESHOLD` | No | `80%` of model 1 context | UI warning threshold for model 1 | Set it only when model 1 needs an explicit threshold | Can also be overridden in admin config |
| `MODEL_1_TARGET_CONSTRUCTED_CONTEXT` | No | `90%` of model 1 context | Target constructed prompt context for model 1 | Set it only when model 1 needs an explicit target | Can also be overridden in admin config |
| `MODEL_1_REASONING_EFFORT` | No | empty | Optional reasoning effort passed through provider options | Set it for reasoning models such as GPT-OSS 120b | Valid values depend on the provider; GPT-OSS uses `low`, `medium`, or `high` |
| `MODEL_1_THINKING_TYPE` | No | empty | Optional thinking type passed to compatible providers | Set it only for providers that expect `thinking.type`; GPT-OSS should use `reasoning_effort` instead | Valid values: `enabled`, `disabled` |
| `MODEL_2_BASEURL` | No | empty | OpenAI-compatible base URL for the secondary model | Set it only if you want a second selectable model | If unset, model 2 is not useful even if enabled |
| `MODEL_2_API_KEY` | No | empty | API key for model 2 | Set it when model 2 requires auth | Empty is valid for unauthenticated local servers |
| `MODEL_2_NAME` | No | empty | Model identifier sent to model 2 | Set it to the exact served model name | Must match the upstream endpoint |
| `MODEL_2_DISPLAY_NAME` | No | `Model 2` | Public label shown in the UI | Set it for a meaningful secondary model label | Cosmetic only |
| `MODEL_2_SYSTEM_PROMPT` | No | empty | System prompt text for model 2 | Set it in admin config or env when model 2 needs a specific system prompt | Legacy built-in keys are still accepted for backwards compatibility |
| `MODEL_2_MAX_TOKENS` | No | empty | Max output tokens passed to the secondary model provider | Set it to cap model 2 output length | Empty leaves provider defaults in control |
| `MODEL_2_MAX_MODEL_CONTEXT` | No | `MAX_MODEL_CONTEXT` | Context window for model 2 | Set it when model 2 differs from the global fallback | Target and compaction defaults derive from this value when their model-specific overrides are unset |
| `MODEL_2_COMPACTION_UI_THRESHOLD` | No | `80%` of model 2 context | UI warning threshold for model 2 | Set it only when model 2 needs an explicit threshold | Can also be overridden in admin config |
| `MODEL_2_TARGET_CONSTRUCTED_CONTEXT` | No | `90%` of model 2 context | Target constructed prompt context for model 2 | Set it only when model 2 needs an explicit target | Can also be overridden in admin config |
| `MODEL_2_REASONING_EFFORT` | No | empty | Optional reasoning effort passed through provider options | Set it for reasoning models such as GPT-OSS 120b | Valid values depend on the provider; GPT-OSS uses `low`, `medium`, or `high` |
| `MODEL_2_THINKING_TYPE` | No | empty | Optional thinking type passed to compatible providers | Set it only for providers that expect `thinking.type`; GPT-OSS should use `reasoning_effort` instead | Valid values: `enabled`, `disabled` |
| `MODEL_2_ENABLED` | No | `true` | Enables model 2 as a selectable option | Set it to `false` to hide model 2 and force fallback to model 1 | Can also be overridden in admin config |

### Title Generation And Summarization

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `TITLE_GEN_URL` | No | `http://localhost:30001/v1` | OpenAI-compatible endpoint used for conversation title generation | Set it if titles should be generated by a dedicated model service | Auxiliary service; core chat can still work if it fails |
| `TITLE_GEN_API_KEY` | No | empty | API key for the title generation endpoint | Set it if the title endpoint requires auth | Empty is valid for local/private servers |
| `TITLE_GEN_MODEL` | No | `nemotron-nano` | Model name used for title generation | Set it to the exact served model name | Can also be overridden in admin config |
| `TITLE_GEN_SYSTEM_PROMPT_EN` | No | empty | Base system prompt for English title generation | Set it when English title generation should follow a specific prompt | If empty, English title generation relies on the few-shot examples only |
| `TITLE_GEN_SYSTEM_PROMPT_HU` | No | empty | Base system prompt for Hungarian title generation | Set it when Hungarian title generation should follow a specific prompt | If empty, Hungarian title generation relies on the few-shot examples only |
| `TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_EN` | No | empty | Optional English title-generation lines appended only for code-related chats | Set it when coding conversations should carry extra title guidance | Leave empty to skip code-specific prompt text |
| `TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_HU` | No | empty | Optional Hungarian title-generation lines appended only for code-related chats | Set it when coding conversations should carry extra title guidance | Leave empty to skip code-specific prompt text |
| `CONTEXT_SUMMARIZER_URL` | No | falls back to `TITLE_GEN_URL` | Optional dedicated endpoint for context summarization | Set it when summarization should use a separate service | If unset, the title generation URL is reused |
| `CONTEXT_SUMMARIZER_API_KEY` | No | falls back to `TITLE_GEN_API_KEY` | API key for the context summarizer | Set it when the summarizer has separate auth | If unset, the title generation key is reused |
| `CONTEXT_SUMMARIZER_MODEL` | No | empty | Model name used for context summarization | Set it if summarization is enabled and uses a dedicated model | Empty means no dedicated summarizer model is configured |

### Optional TEI / Semantic Retrieval

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `TEI_EMBEDDER_URL` | No | empty | URL for the TEI embedding service | Set it when semantic retrieval should use a dedicated embedder | Empty disables semantic embedding |
| `TEI_EMBEDDER_API_KEY` | No | empty | API key for the TEI embedding service | Set it if the embedder requires auth | Empty is valid for unauthenticated local deployments |
| `TEI_EMBEDDER_MODEL` | No | empty | Model name used for the TEI embedder | Set it to the exact served model name | Must match the upstream endpoint |
| `TEI_EMBEDDER_BATCH_SIZE` | No | `32` | Batch size for TEI embedding requests | Raise/lower based on embedder capacity | Can also be overridden in admin config |
| `TEI_RERANKER_URL` | No | empty | URL for the TEI reranker service | Set it when semantic retrieval should use a dedicated reranker | Empty disables semantic reranking |
| `TEI_RERANKER_API_KEY` | No | empty | API key for the TEI reranker service | Set it if the reranker requires auth | Empty is valid for unauthenticated local deployments |
| `TEI_RERANKER_MODEL` | No | empty | Model name used for the TEI reranker | Set it to the exact served model name | Must match the upstream endpoint |
| `TEI_RERANKER_MAX_TEXTS` | No | `32` | Max texts sent to the TEI reranker per request | Raise/lower based on reranker capacity | Can also be overridden in admin config |
| `TEI_TIMEOUT_MS` | No | falls back to `REQUEST_TIMEOUT_MS` or `300000` | Timeout for TEI embedder and reranker requests | Tune to avoid long-running embedding/reranking stalls | Can also be overridden in admin config |

### Optional Long-Term Memory

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `HONCHO_ENABLED` | No | `false` | Enables Honcho-backed long-term memory features | Set it to `true` only when Honcho is reachable and intended for use | Can also be overridden in admin config |
| `HONCHO_API_KEY` | No | empty | API key for the Honcho service | Set it if your Honcho deployment requires auth | Empty is valid for unauthenticated local deployments |
| `HONCHO_BASE_URL` | No | `http://localhost:8000` | Base URL for the Honcho service | Set it when Honcho runs on another host or port | Must be reachable from the app server |
| `HONCHO_WORKSPACE` | No | `alfyai-prod` | Workspace namespace used inside Honcho | Set it per environment or tenant | Keep production and test workspaces separate |
| `HONCHO_IDENTITY_NAMESPACE` | No | derived from `HONCHO_WORKSPACE` + `DATABASE_PATH` | Salt used for AlfyAI's Honcho peer/session IDs | Set it explicitly per deployment when DB paths may change or multiple app environments share one Honcho workspace | Changing it quarantines old Honcho memory because future reads/writes use new peer/session IDs |
| `HONCHO_CONTEXT_WAIT_MS` | No | `8000` | Maximum time the app waits for Honcho session bootstrap, queue settling, and `session.context(...)` before falling back | Raise it if you prefer richer live Honcho session context over faster first-byte time | Can also be overridden in admin config |
| `HONCHO_CONTEXT_POLL_INTERVAL_MS` | No | `250` | Poll interval used while waiting for Honcho queue work to settle | Lower it if you want more responsive queue checks | Can also be overridden in admin config |
| `HONCHO_PERSONA_CONTEXT_WAIT_MS` | No | `8000` | Timeout for auxiliary Honcho persona enrichment on chat turns, especially persona prompt context | Lower it to keep the prompt path responsive while persona clusters refresh in the background | Can also be overridden in admin config |
| `HONCHO_OVERVIEW_WAIT_MS` | No | `10000` | Timeout for the Knowledge Base live Honcho overview refresh path | Raise it if the overview is usually available but slower than chat-path persona enrichment | Can also be overridden in admin config |
| `MEMORY_MAINTENANCE_INTERVAL_MINUTES` | No | `0` | Enables periodic maintenance for memory/task-state cleanup | Set it to a positive number to turn on the scheduler | `0` disables the scheduler entirely |
### Deployment And Runtime Wrapper Variables

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `BODY_SIZE_LIMIT` | No | patched to `100M` in production builds | Controls the adapter-node request body size limit | Raise it if your deployment needs larger request bodies | Server/runtime setting, not an app feature toggle |
| `HOST` | No | `0.0.0.0` in adapter-node, often overridden in deploy env files | Controls the adapter-node listen address | Set it to `0.0.0.0` when a reverse proxy or trusted internal service must reach the app over the host bridge | If you set `127.0.0.1`, other host-managed services cannot reach the app directly |
| `PORT` | No | `3000` in adapter-node | Controls the adapter-node listen port | Set it to match your reverse proxy or host-managed service expectations | Keep Apache/nginx/other proxy config aligned with the same port |
| `NODE_ENV` | No | environment dependent | Controls framework/runtime production behavior | Set it to `production` in real deployments | Also affects cookie security behavior |
| `APP_DIR` | No | current working directory | Tells `scripts/deploy.sh` where the app checkout lives | Set it when deploying from outside the repo directory | Deploy-script only |

## Operational Caveats

- If you bypass `scripts/deploy.sh`, run `npm run db:prepare` before starting the production server.
- The runtime now also contains one bounded SQLite compatibility shim for `users.honcho_peer_version` in case a deploy starts new code against an old schema. That fallback exists only to prevent login lockouts; normal deploys should still rely on `npm run db:prepare`, not on app-start schema mutation.
- Persist the `data/` directory across deploys so chats, drafts, uploads, and SQLite data survive restarts.
- On Linux/macOS, install `libreoffice` and `imagemagick` so MinerU can normalize Office/image uploads consistently.
- Knowledge/document uploads currently accept document and image extensions: `.pdf`, `.doc`, `.docx`, `.txt`, `.md`, `.json`, `.csv`, `.xlsx`, `.xls`, `.pptx`, `.ppt`, `.html`, `.htm`, `.jpg`, `.jpeg`, `.jfif`, `.png`, `.gif`, `.bmp`, `.tiff`, `.tif`, `.webp`, `.svg`, `.heic`, `.heif`, `.avif`.
- For HEIC/HEIF/AVIF uploads, verify ImageMagick delegate support on the host (see AlmaLinux notes below).
- MinerU handles OCR natively in all backends. No separate OCR service is required.
- `GET /api/health` exists and returns `{"status":"OK"}`.
- Auxiliary services such as title generation and summarization can fail independently without necessarily blocking core chat.
- A sandboxed file-production run that does not actually write a file to `/output` now returns an explicit error instead of a silent empty success response.
- If you self-host Honcho and point its deriver/summary models at your own GPU-backed LLM stack, start with `DERIVER_WORKERS=2` on the Honcho deployment and scale upward only while queue backlog drops without saturating your inference server.
- Admin configuration can override selected runtime values after boot; the environment remains the base layer, not always the final one.

### AlmaLinux / RHEL: ImageMagick Delegate Setup (HEIC/HEIF/AVIF)

If `libde265` is not available in your enabled repositories, do **not** block on that package name. On EL systems the effective fix is to install ImageMagick + HEIF support packages, then verify delegates are active.

```bash
sudo dnf -y install epel-release dnf-plugins-core
sudo dnf config-manager --set-enabled crb || true
sudo dnf -y makecache

# Core converters used for upload normalization
sudo dnf -y install libreoffice ImageMagick ghostscript poppler-utils librsvg2

# HEIF/AVIF support packages (names vary by repo build)
sudo dnf -y install libheif || true
sudo dnf -y install ImageMagick-heic || true

# Optional discovery when one package name is missing
dnf repoquery --available 'ImageMagick*heic*' 'libheif*' 'libde265*' | sort
```

Verify delegate support after install:

```bash
magick -version
magick -list format | egrep -i 'HEIC|HEIF|AVIF|JPEG|PNG|WEBP|TIFF|SVG|PDF'
```

Expected outcome: `HEIC`/`HEIF`/`AVIF` appear in `magick -list format`. If they do not appear, those uploads may still store successfully but OCR extraction/prep can fail until delegate support is available on the host image.

## Testing And Verification

For a basic verification pass:

```bash
npm run check   # Type check with svelte-check
npm run lint    # Lint with biome
npm test
npm run build
```

Playwright coverage is also available for critical browser flows such as login, chat streaming, conversations, and admin settings, but the root README intentionally keeps the testing section short.

Playwright runs set `PLAYWRIGHT_TEST=1`, and the conversation-title endpoint returns `null` in that mode so browser tests do not depend on an external title-generation service.

## API Note

AlfyAI ships with internal API families such as:

- `/api/chat`
- `/api/conversations`
- `/api/knowledge`
- `/api/settings`
- `/api/admin`

These routes power the application itself. They are not presented as a stable public integration API, and route details may evolve with the product.

## Further Documentation

- Advanced deployment notes: [deploy/README.md](./deploy/README.md)
- External runtime caveats for knowledge uploads and Honcho: [docs/external-deployment.md](./docs/external-deployment.md)
- Agent-facing codebase guide: [AGENTS.md](./AGENTS.md)
