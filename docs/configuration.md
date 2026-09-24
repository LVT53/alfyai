# Configuration Reference

Complete environment-variable reference for AlfyAI. Copy `.env.example` to `.env` and set the
values you need. See the root [README](../README.md) for the short list of essentials.

Notes before the tables:

- Only `SESSION_SECRET` is effectively required, and in production it is required *hard*: a server
  started with `NODE_ENV=production` **refuses to boot** if it is missing, empty, shorter than 32
  characters, or left at one of the placeholder values that ship in this repository. Outside
  production it still falls back to `mock-session-secret-for-dev-testing-only` and logs one loud
  warning, so local dev, vitest and Playwright keep working. See
  [Session secret](#session-secret) below.
- Some settings can also be overridden later in the admin UI (`Settings > Administration > System`)
  and stored in the database. The environment is the base layer, not always the final one.
- Model and title-generator system prompts default to empty and are intended to be set in the admin
  UI or explicitly via env vars.
- Legacy built-in prompt keys such as `alfyai-nemotron`, `hermes-thinking`, and `default` are still
  recognized if you already have them stored.
- `MODEL_2_ENABLED=false` hides model 2 in the UI and forces model fallback to model 1.
- `BODY_SIZE_LIMIT` is adapter-node/server runtime behavior, not an app-level feature flag. The
  production build patches adapter-node so the default `BODY_SIZE_LIMIT` becomes `100M`. Knowledge
  uploads are capped at 100MB in the app, so keep `BODY_SIZE_LIMIT` at or above that limit.

## Core Runtime

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `SESSION_SECRET` | **Yes in production** (the server refuses to start without it) | insecure mock value outside production | Protects sessions **and** derives the encryption keys for stored connection secrets and provider API keys | Always, in every real environment: `openssl rand -hex 32` | Minimum 32 characters; the repo's placeholder values are rejected by name. Changing it makes already-stored credentials undecryptable |
| `ALFYAI_API_SIGNING_KEY` | No | empty | HMAC signing secret for scoped internal service assertions; also gates the deploy drain call to `/api/admin/drain` | Set it only for trusted internal service-to-service callers or to enable graceful-drain on deploy | Browser session-auth requests do not need it |
| `DATABASE_PATH` | No | `./data/chat.db` | SQLite database location | Set it when the database should live outside the repo root or on a mounted volume | The parent directory must be writable |
| `DEFAULT_NEW_USER_MODEL` | No | `model1` | Model ID assigned to new users | Set it to `model1`, `model2`, or a provider ID that matches an available model | Can also be overridden in admin config |
| `REQUEST_TIMEOUT_MS` | No | `300000` | Upstream request timeout for long-running model calls | Lower it for stricter failure windows or raise it for slower models | Affects perceived reliability on slow backends |
| `MAX_MESSAGE_LENGTH` | No | lowest enabled model cap | Global fallback maximum accepted user message length | Leave unset to derive it from the lowest enabled model Max Message Length | Can also be overridden in admin config |
| `MAX_FILE_UPLOAD_SIZE` | No | `104857600` (100MB) | Max accepted file upload size in bytes | Raise/lower it for a different upload cap | Keep `BODY_SIZE_LIMIT` at or above this so transport does not reject multipart bodies first |
| `MAX_MODEL_CONTEXT` | No | `262144` | Global fallback maximum tokens the model context window supports | Raise it for larger context windows or lower it for stricter limits | Model-specific and provider settings can override it |
| `COMPACTION_UI_THRESHOLD` | No | `80%` of `MAX_MODEL_CONTEXT` | Global fallback UI warning threshold | Leave unset to derive from the configured context window; set it only for an explicit policy | Can also be overridden in admin config. The chat context popover additionally shows a near-trigger heads-up slightly below this threshold (see [ADR 0043](adr/0043-ui-refresh-identity-clarity-and-jump-rail.md)) |
| `TARGET_CONSTRUCTED_CONTEXT` | No | `90%` of `MAX_MODEL_CONTEXT` | Global fallback target context size before output reserve | Leave unset to derive from the configured context window; set it only for an explicit policy | Can also be overridden in admin config |
| `WORKING_SET_DOCUMENT_TOKEN_BUDGET` | No | `4000` | Token budget for working-set document snippets in prompts | Raise it if longer document excerpts should reach the model | Can also be overridden in admin config |
| `WORKING_SET_PROMPT_TOKEN_BUDGET` | No | `20000` | Token budget for the overall working-set prompt section | Raise it if more documents should be included in context | Can also be overridden in admin config |
| `SMALL_FILE_THRESHOLD_CHARS` | No | `5000` | Character threshold below which files are treated as small for extraction | Tune based on typical upload sizes | Can also be overridden in admin config |
| `NATIVE_HISTORY_ENABLED` | No | `true` | Sends conversation history to the model as native chat turns (user/assistant/tool messages) so the prefix is cacheable and the model sees its own prior tool use | Leave `true`; set `false` to fall back to the flattened text block | Boolean: any value other than `false` is treated as enabled |
| `NORMAL_CHAT_DEBUG_OUTBOUND` | No | `0` | Logs outbound message shape (roles, part types, token estimates — never content) for each model call | Set `1` while verifying prompt assembly | Verification aid only |
| `ATTACHMENT_TRACE_DEBUG` | No | `false` | Enables extra attachment tracing logs | Turn it on while debugging upload/readiness issues | Debug logging only; not a feature flag |
| `CONCURRENT_STREAM_LIMIT` | No | `3` | Max concurrent chat streams across all users | Lower it to reduce server load | Can also be overridden in admin config |
| `PER_USER_STREAM_LIMIT` | No | `1` | Max concurrent chat streams per user | Lower it to reduce per-user load | Can also be overridden in admin config |

### Session secret

`SESSION_SECRET` is misleadingly named: besides protecting sessions, it is the PBKDF2 input behind
both credential vaults — stored connection secrets (`src/lib/server/services/connections/vault.ts`,
salt `alfyai-connections`) and provider API keys (`src/lib/server/services/providers.ts`, salt
`alfyai-providers`). A deployment running on the development fallback encrypts every one of those
under a key that anyone holding a copy of this repository can derive, and it does so *silently*: the
app boots, logs in, and works.

So in production the server refuses to start. A value is rejected when it is:

- missing, empty, or only whitespace;
- shorter than 32 characters;
- one of the placeholder values that ship in this repo, including the 33-character
  `change-me-to-a-random-long-secret` from `.env.example` — long enough to pass a naive length
  check, which is exactly why it is rejected by name.

```bash
# Generate one:
openssl rand -hex 32
```

"Production" means `NODE_ENV=production` (set by `deploy/langflow-chat.service`) and not a test
harness (`PLAYWRIGHT_TEST`, `VITEST`). Everywhere else the fallback stays and one warning is
printed at startup, so `npm run dev`, vitest and Playwright are unaffected.

The check runs in the server's `init` hook (`src/hooks.server.ts`), which adapter-node awaits at
module scope — so the failure is a non-zero process exit with the message on stderr, not a 500 on
the first request that happens to read the config. `scripts/prepare-db.ts` carries the same guard
because it runs as its own process on the `npm start` and deploy paths and has its own copy of the
secret. `npm run build` is unaffected: nothing evaluates this config at build time (there are no
prerendered routes and the codebase does not use `$env/static/private`).

**Rotating it is not free.** Changing `SESSION_SECRET` on a box that already has stored connections
or provider API keys makes those credentials undecryptable — they must be re-entered through
Settings. Rotate deliberately, not as a reflex to a startup error.

## Primary And Secondary Model Endpoints

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `MODEL_1_BASEURL` | No | `http://localhost:30001/v1` | OpenAI-compatible base URL for the primary model | Set it to your main chat model endpoint | Used by the Vercel AI SDK OpenAI-compatible provider |
| `MODEL_1_API_KEY` | No | empty | API key for model 1 | Set it when your model endpoint requires auth | Empty is valid for unauthenticated local servers |
| `MODEL_1_NAME` | No | `model-1` (`.env.example` ships `nemotron-nano`) | Model identifier sent to model 1 | Set it to the exact served model name | Must match the upstream endpoint |
| `MODEL_1_DISPLAY_NAME` | No | `Model 1` | Public label shown in the UI | Set it for clearer model names in the product | Cosmetic only |
| `MODEL_1_SYSTEM_PROMPT` | No | empty | System prompt text for model 1 | Set it in admin config or env when model 1 needs a specific system prompt | Legacy built-in keys are still accepted for backwards compatibility |
| `MODEL_1_MAX_TOKENS` | No | empty | Max output tokens passed to the primary model provider | Set it to cap model output length | Empty leaves provider defaults in control |
| `MODEL_1_MAX_MODEL_CONTEXT` | No | `MAX_MODEL_CONTEXT` | Context window for model 1 | Set it when model 1 differs from the global fallback | Target and compaction defaults derive from this value when their model-specific overrides are unset |
| `MODEL_1_COMPACTION_UI_THRESHOLD` | No | `80%` of model 1 context | UI warning threshold for model 1 | Set it only when model 1 needs an explicit threshold | Can also be overridden in admin config |
| `MODEL_1_TARGET_CONSTRUCTED_CONTEXT` | No | `90%` of model 1 context | Target constructed prompt context for model 1 | Set it only when model 1 needs an explicit target | Can also be overridden in admin config |
| `MODEL_1_REASONING_EFFORT` | No | empty | Optional reasoning effort passed through provider options | Set it for reasoning models such as GPT-OSS 120b | Valid values depend on the provider; GPT-OSS uses `low`, `medium`, or `high` |
| `MODEL_1_THINKING_TYPE` | No | empty | Optional thinking type passed to compatible providers | Set it only for providers that expect `thinking.type`; GPT-OSS should use `reasoning_effort` instead | Valid values: `enabled`, `disabled` |
| `MODEL_2_BASEURL` | No | empty (`.env.example` ships `http://localhost:30002/v1`) | OpenAI-compatible base URL for the secondary model | Set it only if you want a second selectable model | If unset, model 2 is not useful even if enabled |
| `MODEL_2_API_KEY` | No | empty | API key for model 2 | Set it when model 2 requires auth | Empty is valid for unauthenticated local servers |
| `MODEL_2_NAME` | No | empty (`.env.example` ships `translategemma`) | Model identifier sent to model 2 | Set it to the exact served model name | Must match the upstream endpoint |
| `MODEL_2_DISPLAY_NAME` | No | `Model 2` | Public label shown in the UI | Set it for a meaningful secondary model label | Cosmetic only |
| `MODEL_2_SYSTEM_PROMPT` | No | empty | System prompt text for model 2 | Set it in admin config or env when model 2 needs a specific system prompt | Legacy built-in keys are still accepted for backwards compatibility |
| `MODEL_2_MAX_TOKENS` | No | empty | Max output tokens passed to the secondary model provider | Set it to cap model 2 output length | Empty leaves provider defaults in control |
| `MODEL_2_MAX_MODEL_CONTEXT` | No | `MAX_MODEL_CONTEXT` | Context window for model 2 | Set it when model 2 differs from the global fallback | Target and compaction defaults derive from this value when their model-specific overrides are unset |
| `MODEL_2_COMPACTION_UI_THRESHOLD` | No | `80%` of model 2 context | UI warning threshold for model 2 | Set it only when model 2 needs an explicit threshold | Can also be overridden in admin config |
| `MODEL_2_TARGET_CONSTRUCTED_CONTEXT` | No | `90%` of model 2 context | Target constructed prompt context for model 2 | Set it only when model 2 needs an explicit target | Can also be overridden in admin config |
| `MODEL_2_REASONING_EFFORT` | No | empty | Optional reasoning effort passed through provider options | Set it for reasoning models such as GPT-OSS 120b | Valid values depend on the provider; GPT-OSS uses `low`, `medium`, or `high` |
| `MODEL_2_THINKING_TYPE` | No | empty | Optional thinking type passed to compatible providers | Set it only for providers that expect `thinking.type`; GPT-OSS should use `reasoning_effort` instead | Valid values: `enabled`, `disabled` |
| `MODEL_2_ENABLED` | No | `true` | Enables model 2 as a selectable option | Set it to `false` to hide model 2 and force fallback to model 1 | Can also be overridden in admin config |

## Title Generation And Summarization

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

## Memory v2 (Local Judge-Gated Memory)

AlfyAI runs a local, judge-gated long-term memory pipeline (ADRs
[0045](adr/0045-memory-v2-judge-gated-local-memory.md) and
[0057](adr/0057-memory-v2-internal-hardening.md)). There is no external memory service.

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `MEMORY_JUDGE_MODEL` | No | `model1` | Model that judges post-turn candidate memories | Set it to `model1`, `model2`, or `provider:<providerId>:<modelId>` for a dedicated judge model | Can also be overridden in admin config |
| `MEMORY_CONSOLIDATION_MODEL` | No | `model1` | Model that runs the nightly memory consolidation / persona-summary pass | Set it to a dedicated model when consolidation should differ from the judge | Can also be overridden in admin config |
| `MEMORY_JUDGE_IDLE_MINUTES` | No | `30` | Idle minutes after the last turn before the deferred memory judge runs for a user | Lower it to persist memories sooner; raise it to batch more per run | Can also be overridden in admin config |
| `MEMORY_CONSOLIDATION_INTERVAL_MINUTES` | No | `1440` | Minutes between nightly consolidation sweeps | Lower it for more frequent consolidation | `0` disables the consolidation scheduler |
| `MEMORY_JUDGE_DRY_RUN` | No | `false` | When `true`, the judge logs decisions without writing memory-profile changes | Turn it on to observe judge behavior without mutating memory | Boolean; only `true` enables dry-run |
| `MEMORY_MAINTENANCE_INTERVAL_MINUTES` | No | `0` | Minutes between per-user memory maintenance sweeps (e.g. embedding backfill) | Set it to a positive number to turn on the maintenance scheduler | `0` disables the scheduler entirely |

## Optional TEI / Semantic Retrieval

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `TEI_EMBEDDER_URL` | No | empty | URL for the TEI embedding service | Set it when semantic retrieval should use a dedicated embedder | Empty disables semantic embedding |
| `TEI_EMBEDDER_API_KEY` | No | empty | API key for the TEI embedding service | Set it if the embedder requires auth | Empty is valid for unauthenticated local deployments |
| `TEI_EMBEDDER_MODEL` | No | empty | Model name used for the TEI embedder | Set it to the exact served model name | Typical: `bge-m3`. Must match the upstream endpoint |
| `TEI_EMBEDDER_BATCH_SIZE` | No | `8` | Inputs per TEI embedding request; longer lists are chunked | Must not exceed the server's `--max-client-batch-size` (the client learns a lower server limit from its 422) | Can also be overridden in admin config |
| `TEI_RERANKER_URL` | No | empty | URL for the TEI reranker service | Set it when semantic retrieval should use a dedicated reranker | Empty disables semantic reranking |
| `TEI_RERANKER_API_KEY` | No | empty | API key for the TEI reranker service | Set it if the reranker requires auth | Empty is valid for unauthenticated local deployments |
| `TEI_RERANKER_MODEL` | No | empty | Model name used for the TEI reranker | Set it to the exact served model name | Typical: `bge-reranker-v2-m3`. Must match the upstream endpoint |
| `TEI_RERANKER_MAX_TEXTS` | No | `32` | Max texts sent to the TEI reranker per request | Raise/lower based on reranker capacity | Can also be overridden in admin config |
| `TEI_TIMEOUT_MS` | No | `120000` (falls back to `REQUEST_TIMEOUT_MS`) | Timeout for TEI embedder and reranker requests | Tune to avoid long-running embedding/reranking stalls | Can also be overridden in admin config |

## Web Research And Image Search

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `PARALLEL_API_KEY` | No | empty | API key for Parallel, which powers web search and page extraction for `research_web`, `fetch_url`, and Atlas | Set it when web search and Atlas should be enabled | Empty omits `research_web`/`fetch_url` from the tool surface and reports Atlas as unavailable |
| `PARALLEL_BASE_URL` | No | `https://api.parallel.ai` | Overrides the Parallel API host | Mainly for tests / self-hosted proxies | Leave empty in production |
| `PARALLEL_FREE_MONTHLY_USD` | No | `5` | Server-wide Parallel spend each calendar month that no user is charged for | Raise it to absorb more Parallel usage before anyone pays | Applies inside the usage write, so it can be changed in admin config without a restart; saving a change there also re-books the current month's already-recorded calls (lowering it mid-month bills usage this month has already made — earlier months keep their booking). Calls past the allowance are billed to the user who made them |
| `WEB_RESEARCH_BRIEF_MAX_CHARS` | No | `12000` | Max chars of `research_web`'s answer-brief markdown sent to the model | Tune the brief size sent back to the model | `fetch_url` sizes its own brief to the model's context window and ignores this knob |
| `BRAVE_SEARCH_API_KEY` | No | empty | API key for Brave Search, which powers the `image_search` tool | Set it when image search should be enabled | Empty disables Brave-backed image search |

## Document Extraction (MinerU)

Uploads and in-chat documents are parsed by [MinerU](uploads.md), a Docker-hosted document parsing
engine. These twelve keys are editable live on **Settings → System → Integrations & keys**, which
also shows a status card with the server's version, quality tiers and output formats.

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `MINERU_API_URL` | No | `http://127.0.0.1:8001` | Base URL of the MinerU V1 API | Set it when MinerU runs on another host or port | Must be reachable from the app server. See [docs/uploads.md](uploads.md) |
| `MINERU_API_KEY` | No | empty | Bearer token sent with every call to the configured origin, `/v1/health` included | Set it when MinerU runs with `--api-key` | Masked everywhere it is read back; empty means anonymous access |
| `MINERU_DEFAULT_TIER` | No | `auto` | Quality tier requested per document (`auto`, `flash`, `basic`, `standard`, `advanced`) | Pin a tier when the server offers several and you want one | `auto` means "do not force a tier for this deployment", not "never send one": a registry `tierHint` (every Office, HTML, RTF and EPUB format) and a server that offers only `flash` both still send an explicit tier, ahead of this value. Naming a tier the server does not offer fails the extraction rather than downgrading it |
| `MINERU_OCR_MODE` | No | `auto` | Text-layer handling (`auto`, `txt`, `ocr`) | Force `ocr` for scanned archives, `txt` to skip OCR entirely | `auto` omits the field; the API rejects an explicit null |
| `MINERU_JOB_TIMEOUT_MS` | No | `300000` | Whole-document deadline, upload through result (10000–3600000) | Raise it for very large documents | Replaces `MINERU_TIMEOUT_MS`, which is still read as a deprecated env fallback for one release; an existing `admin_config` override is migrated automatically |
| `MINERU_POLL_MIN_MS` | No | `2000` | First wait before checking whether a parse has finished (250–60000) | Lower it when parses are typically fast | Backoff grows from here toward the maximum |
| `MINERU_POLL_MAX_MS` | No | `30000` | Where the growing wait between status checks stops (1000–300000) | Raise it to be gentler on a busy server | Must stay well below the job timeout to be useful |
| `MINERU_REQUEST_TIMEOUT_MS` | No | `30000` | Timeout for one control-plane call such as a status check (1000–300000) | Raise it on a slow or loaded host | Does not cover file transfers |
| `MINERU_TRANSFER_TIMEOUT_MS` | No | `600000` | Timeout for sending a document or downloading its result (10000–3600000) | Raise it on a slow link or for very large files | Applies per transfer, not per job |
| `MINERU_CAPABILITIES_TTL_MS` | No | `300000` | How long MinerU's version, tiers and output formats are reused (0–3600000) | Lower it while reconfiguring the server | `0` re-reads on every extraction; a failed refresh keeps a fresh answer for up to twice the TTL. This is also the cache the upload-time MinerU-4 gate reads (`epub`/`odt`/`ods`/`odp`/`rtf` refused, `html`/`htm` fall back to direct-text) — see [docs/uploads.md](uploads.md#the-mineru-4-availability-gate); the gate never probes on the upload's own request, so a change here is only visible after the next background refresh |
| `MINERU_BUNDLE_MAX_BYTES` | No | `33554432` | Disk budget for one document's parse bundle (1048576–536870912) | Raise it for image-heavy documents | Text and structure are always written; figures are dropped once the budget is reached |
| `MINERU_BUNDLE_USER_QUOTA_BYTES` | No | `2147483648` | Total disk one account's parse bundles may occupy (0–549755813888) | Lower it on a small disk; `0` disables the budget | Bundles are DERIVED data — the normalized text is in the database and **Re-extract** rebuilds one. Over budget, other documents' `images/` directories are dropped oldest-first (the manifest is marked `imagesEvicted`, so page citations and `read_generated_file?page=` keep working and figures 404), then whole bundles go oldest-first. The bundle just written is never evicted |
| `MINERU_STRUCTURE_CHUNKING_ENABLED` | No | `true` | Cut documents on block boundaries and record each chunk's pages | Set `false` to fall back to plain character chunking | The rollback switch for structure-aware chunking; existing chunk rows are re-derived on the next sync |

### Document Extraction Ledger

Extraction is a durable background job, not a step inside the upload request. These twelve keys are
editable live on **Settings → System → Advanced** (group *Limits*); a change applies on the next
claim, failure or wait, with no restart.

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `DOCUMENT_EXTRACTION_WORKER_ENABLED` | No | `true` | Runs the background extraction worker | Set `false` to pause extraction during maintenance | Queued documents wait; nothing is lost or failed |
| `DOCUMENT_EXTRACTION_MAX_CONCURRENCY` | No | `3` | Documents extracted at once across all users (1–16) | Raise it when the extraction backend has spare capacity | Counted from ledger rows, so it holds across processes |
| `DOCUMENT_EXTRACTION_PER_USER_CONCURRENCY` | No | `2` | Of those slots, how many one user may hold (1–16) | Lower it on a multi-tenant box | Must be ≤ the global cap to have any effect |
| `DOCUMENT_EXTRACTION_MAX_ATTEMPTS` | No | `3` | Automatic attempts before a document is reported failed (1–10) | Raise it for a flaky backend | A user's Retry always grants exactly one more attempt on top |
| `DOCUMENT_EXTRACTION_RETRY_BASE_MS` | No | `2000` | Backoff before the second attempt (100–600000) | Raise it to be gentler on a recovering backend | Triples per attempt, jittered ±20% |
| `DOCUMENT_EXTRACTION_RETRY_MAX_MS` | No | `60000` | Ceiling the growing backoff stops at (1000–3600000) | Raise it for long outages | A `rate_limited` error's own `retryAfterMs` wins over both |
| `DOCUMENT_EXTRACTION_OUTAGE_WINDOW_MS` | No | `1800000` | How long a document keeps waiting while the backend is unreachable (60000–86400000) | Raise it if the extraction backend is restarted often or for long | Availability failures (`unavailable`, `rate_limited`, `timeout`) back off 5 s → 5 min inside this window and do NOT consume `DOCUMENT_EXTRACTION_MAX_ATTEMPTS`; after it the job fails as `unavailable`, user-retryable |
| `DOCUMENT_EXTRACTION_STALE_ATTEMPT_MS` | No | `120000` | Heartbeat silence after which an attempt is reclaimed (60000–3600000) | Raise it only if the box is so loaded that healthy attempts miss four heartbeats in a row | Independent of `MINERU_JOB_TIMEOUT_MS`: a running attempt heartbeats through every phase. Effective value is `max(this, DOCUMENT_EXTRACTION_HEARTBEAT_MS × 4)` |
| `DOCUMENT_EXTRACTION_HEARTBEAT_MS` | No | `15000` | How often a running attempt marks itself alive (1000–120000) | Lower it to detect a dead worker sooner | Must stay well below the stale window |
| `DOCUMENT_EXTRACTION_INLINE_BUDGET_MS` | No | `1500` | How long an upload request waits inline for a plain-text file (0–15000) | Set `0` to always return immediately | Only applies to the `direct-text` route; parsed formats never wait |
| `DOCUMENT_EXTRACTION_PREFLIGHT_WAIT_MS` | No | `2500` | How long Send waits for an attachment that is nearly ready (0–30000) | Set `0` to always ask the user to wait | Bounded and abortable; never waits for a job still queued |
| `DOCUMENT_EXTRACTION_MAX_DIRECT_TEXT_BYTES` | No | `8388608` | Largest file read straight in as text without a parser (1024–134217728) | Raise it if users legitimately attach huge logs | 8 MiB of text is roughly 2M tokens and thousands of embedding calls from one upload. No longer applies to `html`/`htm` (Phase 5: they route to MinerU `flash` and are bounded by `MAX_FILE_UPLOAD_SIZE` instead) — unless the MinerU-4 gate has fallen them back to `direct-text` on a pre-4.x backend, in which case this cap applies to them again |

## File Production

Producing a file is durable background work (ADR-0005): the chat turn queues a job and an
in-process worker claims it, heartbeats while it runs, and reclaims attempts whose worker died.
These keys are editable live on **Settings → System → Advanced** (group *Limits*); a change applies
on the next claim or the next sweep, with no restart. The other `FILE_PRODUCTION_*` keys are output
and limit knobs and are listed on that page rather than here.

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `FILE_PRODUCTION_WORKER_ENABLED` | No | `true` | Runs the background file-production worker | Set `false` to pause file production during maintenance | Live in both directions: off stops the next claim and leaves an attempt already running to finish; on starts claiming again at the next idle tick. Requests made while it is off are queued, not failed — the file card reads *Queued — waiting for the file worker* and `produce_file` tells the model production is paused rather than that the file is being made |
| `FILE_PRODUCTION_SANDBOX_TIMEOUT_MS` | No | `300000` | The deadline a program-mode job's sandbox container is killed on (minimum 1000) | Lower it to stop a runaway script sooner, raise it for legitimately long-running generation | Program mode only; a document render is bounded by `FILE_PRODUCTION_RENDERER_TIMEOUT_MS` instead, and `run_python` keeps the shared constant. Reaching it fails the job with *Execution timed out* — distinct from the out-of-memory message the same SIGKILL's exit code 137 would otherwise produce. Independent of `FILE_PRODUCTION_STALE_ATTEMPT_MS`: a running attempt heartbeats on its own timer, so a long deadline is not mistaken for a stuck one |
| `FILE_PRODUCTION_STALE_ATTEMPT_MS` | No | `120000` | Heartbeat silence after which a stuck attempt is reclaimed and the job becomes a retryable failure (60000–3600000) | Raise it only if the box is so loaded that healthy attempts miss four heartbeats in a row | Independent of `FILE_PRODUCTION_SANDBOX_TIMEOUT_MS` and `FILE_PRODUCTION_RENDERER_TIMEOUT_MS`: a running attempt heartbeats on its own timer. The effective value is `max(this, 60000)`, four heartbeat periods. One stuck `running` row blocks every other production, so raising this raises how long that can last |

## Maps And Routing

Base configuration for the `map_route` tool and the inline map-card tile proxy. On-demand region
lifecycle and the GTFS timetable catalogue are documented in [docs/routing.md](routing.md).

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `ORS_BASE_URL` | No | empty | Self-hosted OpenRouteService v2 API base **including** the path prefix (e.g. `http://127.0.0.1:8088/ors`) | Set it to enable driving/cycling/walking routing | **Empty means the `map_route` tool is not registered at all** |
| `GEOCODER_BASE_URL` | No | empty | Nominatim `/search` base for resolving place names to coordinates (e.g. `http://127.0.0.1:8081`) | Set it so the model can route by place name | Empty means the model must pass explicit lat/lng |
| `ORS_COVERAGE_LABEL` | No | empty | Human-readable region the loaded ORS graph covers (e.g. `Hungary`) | Set it so the model can explain an out-of-coverage miss instead of calling routing "unavailable" | Shown to the model |
| `MAP_TILE_UPSTREAM_BASE_URL` | No | `https://tile.openstreetmap.org` | Upstream raster tile server the map-card proxy (`GET /api/map-tiles/[z]/[x]/[y]`) fetches and caches | Point it at a self-hosted tile server later by changing only this URL | Respect the upstream tile usage policy (no bulk prefetch, visible attribution, identifying UA) |
| `MAP_TILE_CONTACT` | No | empty | Contact (email or URL) appended to the tile proxy's User-Agent, per OSM's usage policy | Set it when using OSM's public tiles | Empty means the header identifies only the app name |
| `MAP_TILES_DIR` | No | `./data/map-tiles` | On-disk tile cache directory (2GB / 30-day cap) | Move it to a mounted volume if desired | Parent directory must be writable |

### On-Demand Routing Coverage

Enabling on-demand coverage downloads Geofabrik extracts and builds per-region OpenRouteService
containers via Docker. See [docs/routing.md](routing.md) for the full lifecycle, the GTFS feed
catalogue, and licence notes.

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `ROUTING_ON_DEMAND_ENABLED` | No | `false` | Downloads the matching Geofabrik extract and builds a per-region ORS container the first time a route needs it | Set it to `true` when routing should cover more than the fixed `ORS_BASE_URL` region | Needs a reachable `DOCKER_HOST`; builds take hours per region |
| `ROUTING_REGIONS_DIR` | No | `./data/routing-regions` | Where region extracts and graphs are stored | Point it at a durable/mounted path in production | Must match the geocoder import container's `/regions` mount when that is used |
| `ROUTING_ORS_IMAGE` | No | `openrouteservice/openrouteservice:latest` | Docker image used for per-region ORS containers | Pin a version for reproducibility | — |
| `ROUTING_REGION_XMX` | No | `12g` | JVM heap for each region's ORS container | Lower it on a small host; raise it for large regions | Each resident region holds this heap for good |
| `ROUTING_REGION_PORT_RANGE` | No | `8300-8399` | Host port range published for per-region containers | Adjust if the range conflicts | — |
| `ROUTING_REGION_HOST_IP` | No | `127.0.0.1` | Host IP the region containers bind to | Keep loopback unless a proxy needs otherwise | — |
| `ROUTING_GEOCODER_IMPORT_CONTAINER` | No | empty | Name of a running Nominatim container to `nominatim add-data` each new region into | Set it to keep geocoding in sync with new regions | Its `/regions` mount must be `ROUTING_REGIONS_DIR`. Empty disables geocoder import |
| `ROUTING_LEGACY_REGION_ID` | No | `hungary` | Geofabrik id the fixed `ORS_BASE_URL` instance covers, registered as an unmanaged region | Set it to whatever the fixed instance was built from | The app never starts or stops that container |
| `ROUTING_EXTRACT_MIRRORS` | No | `https://download.openstreetmap.fr/extracts` | Comma-separated extract mirrors tried, in order, when `download.geofabrik.de` cannot serve the `.osm.pbf` | Leave at the default; add mirrors if you host your own | Geofabrik is verified against its `.md5`; mirrors publish none, so their `Content-Length` must match exactly. Not every region exists on every mirror |
| `ROUTING_RESIDENT_REGION_IDS` | No | empty | Comma-separated Geofabrik ids downloaded and built on start and never stopped by the idle sweep | Set it for the regions that must always answer instantly | Each resident region holds its ORS container's `ROUTING_REGION_XMX` heap for good |
| `ROUTING_GTFS_FEEDS` | No | empty (= shipped catalogue) | Which GTFS feeds each region's ORS `public-transport` profile is built from (serves `map_route`'s `transit` / `timetable` actions) | Leave it **empty** in production to use the shipped catalogue | Syntax and catalogue contents are in [docs/routing.md](routing.md). A region you name explicitly gets exactly those feeds; a region you do not name gets none |
| `ROUTING_GTFS_FEED_EXCLUDE` | No | empty | `regionId:feedId` pairs dropped from the resolved set (`regionId:*` drops a whole region) | Set `hungary:mav-gysev` unless you have filed MÁV's GTFS request form | See the licence note in [docs/routing.md](routing.md) |
| `ROUTING_GTFS_REFRESH_DAYS` | No | `7` | Default staleness before a feed is re-downloaded and its public-transport graph rebuilt | Leave at the default | A catalogue feed's own cadence wins. Rebuilds only start 03:00–05:00 local; refreshes send `If-None-Match`/`If-Modified-Since` |
| `ROUTING_GTFS_MAX_MB` | No | `600` | Size cap for a single GTFS download | Raise it only for a genuinely larger feed | The national Dutch feed is ~250 MB |
| `ROUTING_REGION_IDLE_MINUTES` | No | `180` | How long a non-resident region container may sit unused before it is stopped | Lower it on a tight host | Stopped regions restart in a minute or two; the graph stays on disk |
| `ROUTING_REGION_MAX_PBF_MB` | No | `2500` | Size cap for a single extract | Raise it for large countries | Above the cap is a permanent failure, not a retry |
| `DOCKER_HOST` | No | empty | Docker endpoint used by the file-production sandbox and the region manager | Point it at a filtered docker-socket-proxy (see [deploy/README.md](../deploy/README.md)) | Required for on-demand routing and program-mode file production |

## Connections (OAuth)

The [Connections subsystem](architecture.md#connections) links external accounts (Google,
Nextcloud, GitHub, IMAP, CalDAV, Immich, Plex, OwnTracks, and more). Only Google uses an OAuth
client secret; the rest authenticate per-provider inside the app. ADRs
[0044](adr/0044-connections-ui-redesign.md), [0050](adr/0050-connections-backend-module-seams.md),
[0058](adr/0058-todoist-retired-and-connection-catalog-grouped.md).

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | No | empty | OAuth 2.0 client ID for the Google connect flow (Calendar/Contacts) | Set it to enable connecting Google accounts | Leave both empty to keep the Google connect flow disabled ("not configured") |
| `GOOGLE_OAUTH_CLIENT_SECRET` | No | empty | OAuth 2.0 client secret for the Google connect flow | Set it alongside the client ID | Register an authorized redirect URI of `{your origin}/api/oauth/google/callback` |

## Atlas (Deep-Research Reports)

Atlas runs pipeline v3 exclusively (Phase B of the v3-only consolidation); there is no runtime
selector between content pipelines any more. The two inherit-target models live here. The full v3
tuning table is in [docs/atlas.md](atlas.md). ADRs
[0062](adr/0062-atlas-content-pipeline-is-rebuilt-on-the-harness-tools.md) (superseded — v1/v2
deleted, tag `atlas-v1-v2-final`),
[0063](adr/0063-atlas-v3-reasons-from-an-evidence-bank-not-from-search-excerpts.md).

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `ATLAS_SYNTHESIS_MODEL` | No | unset | Default model for v3 researcher and writer tasks (the inherit target for `ATLAS_V3_RESEARCHER_MODEL` / `_WRITER_MODEL`) | Point it at a capable synthesis model | `model1`, `model2`, or `provider:<providerId>:<modelId>`. Can also be overridden in admin config |
| `ATLAS_AUDIT_MODEL` | No | unset | Default model for v3 ask, outline, and critic tasks (the inherit target for those roles) | Point it at a stronger audit/critique model when available | `model1`, `model2`, or `provider:<providerId>:<modelId>`. Also used by the `atlas-eval.ts --judge` pass. Can also be overridden in admin config |
| `ATLAS_STALE_MONTHS` | No | `18` | Age past which a cited statistic is listed in the report's Limitations section | Lower it for fast-moving subjects | Read by the v3 pipeline. Can also be overridden in admin config |

See [docs/atlas.md](atlas.md) for the `ATLAS_V3_*` tuning knobs. `ATLAS_PIPELINE` and the
`ATLAS_V2_*` knobs were removed with the v1/v2 pipelines; a leftover `ATLAS_PIPELINE` in an
operator's `.env` is ignored, and the server logs one deprecation warning if it is still set.

## Sentry (Optional Error Monitoring)

Sentry is initialized in `src/hooks.server.ts` and `src/hooks.client.ts` (config in
`src/lib/sentry-config.ts`). The app does not send events unless a DSN is configured. `PUBLIC_*`
mirrors are exposed to the browser.

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `SENTRY_DSN` | No | empty | Server-side Sentry DSN | Set it to enable server error/perf reporting | No events are sent when empty |
| `PUBLIC_SENTRY_DSN` | No | empty | Browser Sentry DSN | Set it to enable client error/perf reporting | Exposed to the browser |
| `SENTRY_ENVIRONMENT` / `PUBLIC_SENTRY_ENVIRONMENT` | No | `development` | Environment tag on server/browser events | Set to `production`/`staging` per deployment | — |
| `SENTRY_TRACES_SAMPLE_RATE` / `PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | No | `0.1` | Performance trace sample rate (server/browser) | Tune sampling volume | `0` disables tracing |
| `SENTRY_TRACE_PROPAGATION_TARGETS` / `PUBLIC_SENTRY_TRACE_PROPAGATION_TARGETS` | No | `localhost,/api/` | Comma-separated targets that receive trace-propagation headers | Add your API origins | — |
| `PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE` | No | `0` | Session-replay sample rate | Raise it to capture some sessions | Browser-only |
| `PUBLIC_SENTRY_REPLAYS_ERROR_SAMPLE_RATE` | No | `1` | Session-replay sample rate on error | Lower it to capture fewer error replays | Browser-only |
| `SENTRY_AUTH_TOKEN` | No | empty | Build-time token for source-map upload | Set it in CI/build only | Build-time only, not a runtime secret |
| `SENTRY_ORG` | No | empty | Sentry org slug for source-map upload | Set it in CI/build only | Build-time only |
| `SENTRY_PROJECT` | No | empty | Sentry project slug for source-map upload | Set it in CI/build only | Build-time only |
| `SENTRY_RELEASE` | No | empty | Release name attached to uploaded source maps | Set it in CI/build only | Build-time only |

## Web Push Notifications

Browser push notifications use the `web-push` library with VAPID keys (subscriptions API at
`src/routes/api/browser-push/`, service worker at `static/browser-push-sw.js`). Push is reported as
disabled (`missing_vapid_keys`) until all three values are set. These are not in `.env.example` but are
read from the environment and can also be set in `Settings > Administration > System`.

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `WEB_PUSH_VAPID_PUBLIC_KEY` | No | empty | VAPID public key advertised to browsers for push subscriptions | Set it (with the private key and subject) to enable browser push | All three must be set or push stays disabled. Can also be set in admin config |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | No | empty | VAPID private key used to sign push messages | Set it alongside the public key | Secret; can also be set in admin config |
| `WEB_PUSH_VAPID_SUBJECT` | No | `mailto:admin@localhost` | VAPID subject (a `mailto:` or URL contact) | Set it to a real contact per deployment | Can also be set in admin config |

## Deployment And Runtime Wrapper Variables

These configure the adapter-node server wrapper and framework runtime, not app features. Deploy-script
variables (`APP_DIR`, `DEPLOY_BRANCH`, `SERVICE_NAME`, `HEALTH_PORT`, `RELEASES_TO_KEEP`) are
documented in [deploy/README.md](../deploy/README.md).

| Variable | Required? | Default | What it does | When to set it | Caveats |
|---|---|---:|---|---|---|
| `BODY_SIZE_LIMIT` | No | patched to `100M` in production builds | Controls the adapter-node request body size limit | Raise it if your deployment needs larger request bodies | Server/runtime setting, not an app feature toggle. Keep it at or above the 100MB upload cap |
| `HOST` | No | `0.0.0.0` in adapter-node (`.env.example` ships `127.0.0.1`) | Controls the adapter-node listen address | Set it to `0.0.0.0` when a reverse proxy or trusted internal service must reach the app over the host bridge | If you set `127.0.0.1`, other host-managed services cannot reach the app directly |
| `PORT` | No | `3000` in adapter-node (`.env.example` ships `3001`) | Controls the adapter-node listen port | Set it to match your reverse proxy or host-managed service expectations | Keep proxy config aligned with the same port |
| `NODE_ENV` | No | environment dependent | Controls framework/runtime production behavior | Set it to `production` in real deployments | Also affects cookie security behavior |
| `CSP_MODE` | No | `report-only` | Whether the Content Security Policy is observed (`report-only`), enforced (`enforce`), or not sent at all (`off`) | Flip to `enforce` after watching staging's browser console — see [docs/security-headers.md](./security-headers.md) | Any unrecognized value means `report-only`, so a typo cannot enforce an unwatched policy. Takes effect on restart, no rebuild needed |
| `ADDRESS_HEADER` | No | unset | Tells adapter-node which request header carries the real client address, so `getClientAddress()` stops returning the reverse proxy's loopback address | Set it to `x-forwarded-for` behind Apache — see [Client addresses behind the proxy](#client-addresses-behind-the-proxy) | Only set it when a proxy you control **overwrites** the header. If clients can reach the app directly, this makes the address forgeable |
| `XFF_DEPTH` | No | `1` | How many proxies sit in front of the app, counted from the right of `x-forwarded-for` | Set it alongside `ADDRESS_HEADER` — `1` for the single Apache hop | Wrong values pick the wrong hop, which is worse than not setting `ADDRESS_HEADER` at all |

### Client addresses behind the proxy

The login throttle (see below) keys a secondary budget on the client address. Today neither
`ADDRESS_HEADER` nor `XFF_DEPTH` is set anywhere in this repo or on the boxes, and Apache proxies
with `ProxyPass / http://127.0.0.1:3001/`, so `event.getClientAddress()` returns Apache's loopback
address for **every** request.

The app deliberately does not read `x-forwarded-for` itself. A header the server has not been
configured to trust is attacker-controlled, and keying a limiter on attacker-controlled input is
worse than having no limiter: the attacker picks a fresh key per request while everyone else shares
the forged ones. So instead, the per-address budget is simply **skipped** whenever the resolved
address is loopback or RFC1918 and `ADDRESS_HEADER` is unset. The per-email budget — the one that
actually protects an account — applies regardless.

To turn the per-address budget on, add to `shared/.env` and restart:

```bash
ADDRESS_HEADER=x-forwarded-for
XFF_DEPTH=1
```

`XFF_DEPTH=1` is correct for the current topology: exactly one proxy (Apache) in front of the app.
Only do this while Apache is the sole ingress — if the Node port is reachable directly, a client can
forge the header and choose its own rate-limit bucket.

### Login throttle

Failed credential checks are counted in a 15-minute sliding window, per process
(`src/lib/server/services/login-rate-limit.ts`). Successful logins are not counted and clear the
email budget, so ordinary use and the Playwright suite are unaffected.

| Budget | Failures per 15 min before the penalty starts | Cleared by a success? |
|---|---:|---|
| Per email address (`POST /api/auth/login`) | 8 | Yes |
| Per client address (`POST /api/auth/login`) | 30 | No — otherwise one correct guess resets an attacker's spray counter |
| Per account (`PATCH /api/settings/password`, wrong current password) | 8 | Yes |

#### Exceeding a budget does not lock the account

This is the part worth understanding before judging the caps above as weak.

Behind Apache every request arrives from the same loopback address, so the per-email budget is a
lever **anyone can pull against anyone**: a stranger who knows an address can manufacture eight
failures for it. If going over the budget simply refused the request, that stranger could keep this
deployment's only entrance shut indefinitely — there is no second admin account, no password-reset
mail and no out-of-band unlock here, so the recovery procedure would be an ssh session and a service
restart. A permanent, unauthenticated denial of service on the login page is a worse outcome than
the online guessing the throttle exists to slow.

So going over a budget makes an attempt **expensive**, and refuses only the ones that turn out to be
wrong:

- Under the budget, nothing happens: no delay, no bookkeeping.
- Over the budget, the comparison still runs, but only after an escalating delay — 1s, 2s, 4s,
  capped at 8s — and only **one** such comparison per key may be in flight at a time. Concurrent
  attempts on that key are refused immediately, without reaching bcrypt.
- A **correct** password over the budget succeeds and clears the budget. The legitimate owner is
  never locked out; the worst they suffer is one 8-second wait.
- A **wrong** password over the budget gets `429` with a `Retry-After` of the delay (not the rest of
  the window — retrying sooner really is allowed) and an `errorKey` of `login.tooManyAttempts`,
  which the login page renders localized.

What that buys: guessing one account is capped at roughly one attempt per 8 seconds however many
connections the attacker opens, because of the single-flight rule. What it does not buy: this is a
throttle, not a lockout, so an attacker with unlimited time still gets unlimited attempts at about
450/hour. Against the 8-character minimum this product enforces that is not a threat, and against a
password already leaked in a breach no lockout duration would have helped either.

Admitting a correct password while throttled leaks nothing. `429` vs `401` says only "this key is
throttled", which is true precisely because the attacker made it true, and the decoy bcrypt
comparison still runs for addresses with no account, so neither the status nor the timing answers
"does this account exist".

The whole throttle is disabled when `PLAYWRIGHT_TEST` is set.
