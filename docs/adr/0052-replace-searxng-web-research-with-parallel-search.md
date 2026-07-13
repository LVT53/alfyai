# Replace SearXNG web-research pipeline with Parallel Search/Extract

Accepted. The self-hosted SearXNG web-research pipeline is **removed entirely** and replaced by the **Parallel Search API** (Turbo tier) for web search, with **Parallel Extract** exposed as a separate on-demand page-read tool. The model/citation contract (`research_web`, grounded web candidates/metadata, `sourceType:"web"`) is preserved; only the backend swapped. Atlas migrates its text search and page fetch to Parallel while keeping Brave for image search (Parallel has no image API).

> **Recorded 2026-07-13.** Shipped on `main`, deployed to prod, and verified the same day. This ADR documents the completed change so future agents treat it as intentional.

## Context

SearXNG depended on free upstream engines that collapse under modest or bursty load, and it did so *silently* — returning zero results to users rather than erroring. A live benchmark showed the failure modes stacking up: Google blocks datacenter IPs, DuckDuckGo connect-times-out, and Brave suspends the instance for ~180s under load. Under normal usage the pipeline degraded to ~0 results end-to-end.

The same benchmark measured **Parallel Search (Turbo)** at **91.7% correct at ~490ms p50, $1 per 1,000 calls, with no collapse** end-to-end through DeepSeek V4 Flash. A separate **Extract** probe showed that fetching a page adds no value on the normal answer path — search snippets already carry the answer — so page fetch is worth keeping only as an explicit, on-demand tool rather than an automatic escalation.

## Decision

- **`research_web` (unchanged name and contract) → Parallel Search Turbo.** Tool input is simplified to `{query}` only. Backend lives in `src/lib/server/services/parallel-search/{client,research,fetch-url,types}.ts`.
- **New always-on tool `fetch_url` → Parallel Extract** (`{urls[1..5], objective?}`), for "read/validate this specific page" intent — a pasted URL, specs/details that live inside a page, or PDF/JS-rendered pages. It defaults to **cached** extract (`fetch_policy.max_age_seconds=86400`) because live Extract latency is variable (~1s p50 with a rare 25-42s tail). It is **not** an auto-escalation after search.
- **Model/citation contract preserved.** `GroundedWebModelPayload`, `sourceType:"web"`, and the candidates/metadata shaping are unchanged; downstream grounding, citation, and audit code is untouched.
- **Atlas migrated.** Text search and page fetch go through Parallel; **image search stays on Brave**. Atlas availability now gates on `parallelApiKey` (`missing_parallel`).
- **Config.** `PARALLEL_API_KEY` + `PARALLEL_BASE_URL` are added (env + config-store + admin UI). The SearXNG base URL and all `WEB_RESEARCH_*` config keys are removed. The **TEI reranker** and **Brave** (images only) are kept.
- **Deletions.** `src/lib/server/services/web-research/`, `docker-compose.searxng.yml`, and `searxng-settings.yml` are removed.
- **Analytics.** Parallel Turbo and Extract calls are recorded into `usage_events` as synthetic model rows `parallel:turbo` / `parallel:extract` (flat $1/1k), so their cost folds into model-usage analytics.

## Consequences

- A new external dependency (`parallel-search` service) replaces the self-hosted SearXNG container. Web search and Atlas are unavailable when `PARALLEL_API_KEY` is unset (Atlas reports `missing_parallel`).
- New config keys `PARALLEL_API_KEY` / `PARALLEL_BASE_URL`; SearXNG base URL and every `WEB_RESEARCH_*` key are gone.
- **Cost model is flat $1 per 1,000 calls** for both Turbo and Extract.
- **Extract latency is variable** (~1s p50, rare 25-42s tail); the cached-extract default (`max_age_seconds=86400`) mitigates the tail on the normal path. Callers needing guaranteed-fresh reads must opt into a live fetch and accept the tail.
- **Brave is retained for images only** — it is no longer a text-search provider anywhere.
- The `research_web` contract is preserved, so grounding/citation/audit code and the domain vocabulary around web sources are unchanged.
- **Analytics carries synthetic model rows** `parallel:turbo` / `parallel:extract` in `usage_events`. These are intentional cost-attribution rows, not real provider models — do not treat those modelIds as a data bug.

## Alternatives considered

- **Keep SearXNG.** Rejected on reliability: the free upstream engines collapse silently under load, which is the exact failure this change removes. No amount of local tuning fixes datacenter-IP blocking and upstream suspension.
- **Brave Search API (for text).** A viable managed option, but Parallel Turbo won the speed/quality/robustness balance in the live benchmark; Brave is retained only where Parallel has no offering (image search).
- **Exa / Tavily.** Considered as managed search APIs. Parallel Turbo was chosen for its measured combination of latency (~490ms p50), quality (91.7% correct end-to-end), flat low cost, and no observed collapse under load.
