# Search Benchmark: SearXNG pipeline vs. Parallel Search API

**Status:** design draft (no harness code yet). **Question:** how good is our own
web-research pipeline at retrieval, and does the managed Parallel Search API beat it on
the balance of speed and quality?

## Scope (locked)

- **Contenders:** (1) our `researchWeb()` pipeline (SearXNG link layer + planning + TEI
  rerank + Readability page-fetch + evidence extraction), treated as one black box;
  (2) **Parallel Search API** — `turbo` and `advanced` modes. No other providers.
- **Model under test:** DeepSeek V4 Flash on the remote deployment (`ssh alfydesign`,
  `/home/alfydesign/apps/langflow-chat`), reached as a DB provider model.
- **Run location:** on the remote box (representative network path; no home-network skew).
- **Deliverable:** a comparison + speed/quality scatter, plus a per-stage latency
  breakdown of our pipeline. No production integration of Parallel unless it wins.

## Parallel Search API — grounded facts (verify at build)

- `POST https://api.parallel.ai/v1/search`, auth header `x-api-key`.
- Request: `objective` (natural-language intent) + `search_queries[]`. Returns 10 results:
  `{url, title, publish_date, excerpts[]}` — LLM-optimized **excerpts, not full pages**.
- Modes / price / latency:
  | Mode | $/1k req | Latency | Notes |
  |---|---|---|---|
  | `turbo` (default) | $1 | p50 ~200ms, ≤~3s | excerpts; our `quick` analogue |
  | `basic` | $5 | 200ms–3s | excerpts |
  | `advanced` | $5 | ~3s | deeper extraction; our `research`/`exact` analogue |
  Extra results beyond 10: +$1/1k. No stated free tier.

## Cost model (per-query → monthly, unknown volume)

Turbo at $1/1k makes cost a near-non-factor vs. SearXNG's flat ops cost:

| Volume | SearXNG (flat ops) | Parallel Turbo ($1/1k) | Parallel Advanced ($5/1k) |
|---|---|---|---|
| hundreds/mo | ~$10–20 | <$1 | <$1 |
| 10k/mo | ~$10–20 | ~$10 | ~$50 |
| 100k/mo | ~$10–20 | ~$100 | ~$500 |

Conclusion pre-data: at any realistic volume this is a **quality + latency + ops** decision,
not a cost one. Turbo especially is cheap enough to ignore on price.

## Method — two tracks

### Track 1 — Retrieval quality (provider-only, no model)
For each question, run our `researchWeb()` in-process and Parallel turbo+advanced.
Score **returned/selected URLs + excerpts vs. a hand-verified gold-URL set**
(precision / recall / MRR). Capture per-stage latency from our existing diagnostics
(`providerCalls[].latencyMs`, `openedPageCount`, `pageExtraction.totalLatencyMs`,
`fallbackReasons`). This isolates *retrieval* from the model.

### Track 2 — Answer quality (end-to-end), two phases
- **2a Controlled (build first):** feed each provider's grounding payload to DeepSeek V4
  Flash with an identical prompt; force **mode-matched pairs** (our `quick` ↔ turbo,
  `research`/`exact` ↔ advanced). LLM-judge the answer vs. a gold answer + manual
  spot-checks. Cleanest apples-to-apples.
- **2b Live (build second):** real turns through the deployed chat; DeepSeek V4 Flash
  self-selects when/how to search (tests "the model can pick modes on its own").

### Metrics
- Retrieval: precision@k, recall vs. gold URLs, MRR of first gold hit.
- Answer: judge score (0–3) vs. gold, grounding/citation correctness, hallucination flag.
- Latency: **p50 and p95** (3–5 runs/question), search-only and end-to-end. Tail latency
  is SearXNG's suspected weak spot (upstream engines rate-limit; no per-call timeout on
  the SearXNG fetch itself — only the tool-envelope timeout).
- Balance: speed/quality scatter; a weighted composite for a single ranking.

## Mode-matched pairs

| Our mode | Parallel mode | Regime |
|---|---|---|
| `quick` (snippets only) | `turbo` (excerpts) | fast path |
| `research` / `exact` (full page fetch) | `advanced` | deep path |

## Judge model

Prefer the strongest **non-DeepSeek** provider model available on the box (avoid
same-family judge bias); else DeepSeek V4 Pro with manual spot-checks as guardrail.
Confirm availability against the `providers`/`providerModels` DB rows at build.

## Gold set integrity

`questions.json` holds 20 questions across 5 stress-tiers. **Gold answers/URLs are NOT
filled from memory** — they are captured and hand-verified against live sources during the
build step (fabricated gold would poison the benchmark). Freshness/time-sensitive questions
are judged live at run time rather than against a frozen gold answer.

## Build order (once greenlit + Parallel key provided)

1. Verify + lock gold answers/URLs in `questions.json` (from real sources).
2. Confirm judge model + remote env (SearXNG base URL, DeepSeek provider id, Parallel key).
3. Parallel client (throwaway, `scripts/search-benchmark/parallel-client.ts`).
4. Track 1 runner (retrieval) — reuse patterns from `evaluate-reasoning-depth-ab.ts`.
5. Track 2a runner (controlled answer quality) + judge.
6. Track 2b runner (live end-to-end) — extend `benchmark-live-chat-stream.ts`.
7. Report generator (table + scatter).
8. Push branch, pull on remote, run, collect results.

## What I need from you

- The Parallel API key (set as `PARALLEL_API_KEY` in the remote `.env`).
- Go-ahead to push a benchmark branch and run the script on the remote deployment.
