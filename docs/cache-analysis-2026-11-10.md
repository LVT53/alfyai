# Cacheable input share and Kimi K3.1 Pro cost model (2026-11-10)

Read-only analysis of the production `chat.db`. Snapshot: **2026-11-10 12:17 UTC**, 14,895 `usage_events` rows spanning 2026-04-16 → 2026-11-10.

All queries ran against `file:/home/alfydesign/apps/langflow-chat/shared/data/chat.db?mode=ro` (URI `mode=ro`). Nothing was written; the app was not run.

Windows: **90d** = `created_at >= now - 90*86400` → 2026-08-12 12:17 UTC (13,035 rows). **30d** = same minus 30 days (7,942 rows). Where a figure is *all-time* it says so.

---

## 0. The one number that misleads: the aggregate 0.33% hit rate

| Cohort (90d) | rows | prompt tokens | share of prompt | cache telemetry? |
|---|---:|---:|---:|---|
| Provider rows reporting cache | 27 | 788,673 | 0.7% | yes (DeepSeek only) |
| Provider rows reporting **nothing** | 12,982 | 116,941,988 | **98.6%** | no — hit=miss=cached_in=0 |
| Estimated rows (`usage_source='estimated'`) | 26 | 837,817 | 0.7% | no |
| **Total** | 13,035 | 118,568,478 | 100% | hit rate **0.33%** |

98.6% of all prompt tokens are Qwen rows served by the self-hosted vLLM providers, and those rows carry **no cache fields at all**. The 0.33% aggregate therefore measures *which provider reports telemetry*, not whether caching worked. Two consequences:

- The `calculateCostUsdMicros` fallback bills those rows entirely at the input rate (`prompt - 0`), which is correct behaviour for a provider that reports no cache data, but it is indistinguishable in the table from a genuine 0% hit rate.
- Never quote 0.33% as the app's cacheability. The cohorts that do report — DeepSeek's automatic prefix cache — measure **48.9%** (90d) and **61.8%** (all-time).

---

## 1. Last 90 days, by model and provider

Cache column = `cache_hit_tokens` falling back to `cached_input_tokens` (identical wherever either is set — see §5).

| model (id) | provider | calls | prompt | cached | hit rate | output | billed |
|---|---|---:|---:|---:|---:|---:|---:|
| Qwen 3.8 Flash Next Uncensored (`provider:d9cc…:6f9b…`) | AlfyAI (Local) | 653 | 56,487,423 | 0 | 0.0% | 2,602,263 | $0.00 |
| Qwen 3.8 27B Uncensored (`model1`) | – | 240 | 43,359,841 | 0 | 0.0% | 1,140,990 | $0.00 |
| Qwen 3.6 35B (`model2`, auxiliary) | – | 9,934 | 10,905,235 | 0 | 0.0% | 293,876 | $0.00 |
| Qwen 3.8 27B (`provider:d9cc…:6f9b…`) | AlfyAI 6000 | 102 | 6,112,591 | 0 | 0.0% | 365,855 | $0.00 |
| Atlas (`atlas`, estimated) | – | 4 | 837,265 | 0 | 0.0% | 101,286 | $0.00 |
| **DeepSeek V4 Flash** | DeepSeek API | 16 | 471,577 | 247,936 | **52.6%** | 45,581 | $0.08 |
| **DeepSeek V4 Pro** | DeepSeek API | 16 | 354,490 | 137,984 | **38.9%** | 32,286 | $0.07 |
| Kimi K3.1 Pro | Fireworks AI | 1 | 39,504 | 0 | 0.0% | 2,564 | $0.10 |
| Parallel Extract | Parallel | 869 | 0 | 0 | – | 0 | $0.37 |
| Parallel Turbo | Parallel | 1,178 | 0 | 0 | – | 0 | $0.59 |
| residual `estimated` rows (4 model ids) | – | 22 | 552 | 0 | 0.0% | 1,173 | $0.00 |
| **Total** | | **13,035** | **118,568,478** | **385,920** | **0.33%** | **4,585,874** | **$1.22** |

Notes:
- **99.3% of prompt tokens bill at $0.00** (self-hosted Qwen, plus the $0-priced Atlas rows): only DeepSeek (826,138 prompt) and Kimi (39,504) carry a price, and DeepSeek's 32 calls are 46.7% cached between them. Actual spend is ~$0.41/month, and 79% of it is Parallel web extraction ($0.963), not model tokens.
- The single Kimi K3.1 Pro row (39,504 in / 2,564 out, $0.10) is a one-off test and shows **0 cached** — one data point, no structure evidence.
- DeepSeek rows are the only real cache evidence. The brief's "roughly 38–62%" is confirmed: 38.9% and 52.6% per model, with single calls from 12.3% to 98.1%.
- Billed figures are rounded to 2dp and do not sum visually; the exact 90-day total is **$1.2186**.

### The hit rate is a function of prompt size (all-time, 68 DeepSeek calls)

| prompt band | calls | prompt | cached | hit rate |
|---|---:|---:|---:|---:|
| < 20k | 35 | 383,532 | 175,744 | 45.8% |
| 20–100k | 21 | 1,128,381 | 574,848 | 50.9% |
| 100k+ | 12 | 1,867,735 | 1,339,520 | **71.7%** |
| **all** | **68** | **3,379,648** | **2,090,112** | **61.8%** |

This is the mechanism that matters: **the larger the prompt, the higher the hit rate**, because a fixed prefix is amortised over more content and the tail is history that repeats. Since 95.6% of the app's input tokens sit in 32k+ calls (§3), the token-weighted expectation is set by the top band, not the average of calls.

---

## 2. Repeat-share upper bound per conversation

Method: per `conversation_id`, `1 - sum(prompt)/sum(max(prompt))` — the fraction of input tokens that are a re-send of content already carried by the conversation's largest prompt. Assumes a hypothetical cache that can serve the *entire* prior prompt.

**Aggregate (all rows):** 627 conversations, 118,568,478 total vs 34,691,467 Σmax → **repeat share 70.74%** (83.9M tokens).
**Aggregate (main chat only, excl. `model2`/`parallel:`):** 270 conversations, 107,663,243 total → **67.98%**.

| cohort | n | >50% | >70% | >80% |
|---|---:|---:|---:|---:|
| all rows | 627 | 172 (27.4%) | 96 (15.3%) | 56 (8.9%) |
| main chat only | 270 | 84 (31.1%) | 39 (14.4%) | 16 (5.9%) |

Distribution is **bimodal**: p50 = 0.11, p75 = 0.56, p90 = 0.78. 248 of 627 conversations are single-call (repeat share 0 by construction) or trivial; the token mass is in long conversations at 80–95% repeat share. The ten largest conversations hold **48.1%** of main-chat input tokens (51.8M of 107.7M) and run 74–95% repeat share (top: 15.3M tokens over 81 calls, 95.2%, i.e. 14.2% of all main-chat input on its own).

So the ceiling is **~70% of all input tokens**, but a median conversation gets nothing from it — the value is concentrated in a small number of long, tool-heavy conversations.

---

## 3. Static-prefix share against the prompt-size distribution

Reference overhead from `docs/harness-review-2026-09-05.md` §1–2: fixed floor 6.6–7.2k tokens (~4k system prompt + ~4–5k tool schemas). Using **8k** as the conservative high end.

**Main-chat calls only (1,054 calls, 107.7M tokens):**

| prompt bucket | calls | % calls | tokens | % tokens |
|---|---:|---:|---:|---:|
| < 8k | 49 | 4.6% | 150,619 | 0.1% |
| 8–16k | 97 | 9.2% | 1,174,939 | 1.1% |
| 16–32k | 148 | 14.0% | 3,380,239 | 3.1% |
| **32k+** | **760** | **72.1%** | **102,957,446** | **95.6%** |

(Auxiliary `model2` calls are all under 8k, so the 8k-and-above buckets are identical whether or not they are included; only the <8k bucket changes — 150,619 vs 11,055,854.)

**All calls (13,035):** <8k 12,030 (92.3%, 9.3% of tokens) · 8–16k 97 · 16–32k 148 · 32k+ 760 (5.8% of calls, **86.8%** of tokens).

Key figures:

- **Static-prefix ceiling** — `Σ min(prompt, 8000) / Σ prompt` = **7.6%** of main-chat input tokens (16.1% if the 12,030 tiny auxiliary calls are included). Perfectly caching the fixed 8k prefix on every call removes at most 8% of input spend.
- **Input tokens in calls above 2× the fixed overhead (>16k): 98.8%** of main-chat tokens. Below 8k: 0.1%.
- 4.6% of main-chat calls are *under 8k* — below the fixed overhead — so they cannot contain the full system prompt + tool schemas: a different or truncated prompt path, not a full turn.

**Interpretation:** the static prefix is *not* where the money is. It is 7.6% of input. The 70% repeat share (§2) is the real opportunity, and it is history and tool output — which is exactly what the App currently re-renders non-deterministically each turn (review doc §2.3), which is why a byte-stable prefix is the enabling change.

---

## 4. Kimi K3.1 Pro cost model

Rates: $2.00/1M uncached input, $0.20/1M cached input (10× cheaper), $10.00/1M output. Trailing-30-day volumes from the brief: **75,298,221 prompt / 53,888 cached / 2,622,811 output** (measured today: 75,341,542 / 2,605,261 — 0.06% drift from row growth; immaterial).

| cache hit rate | cached input | uncached input | output | **monthly bill** | vs 0% | blended $/1M |
|---:|---:|---:|---:|---:|---:|---:|
| 0% | $0.00 | $150.60 | $26.23 | **$176.82** | — | $2.27 |
| 40% | $6.02 | $90.36 | $26.23 | **$122.61** | −30.7% | $1.57 |
| 60% | $9.04 | $60.24 | $26.23 | **$95.50** | −46.0% | $1.23 |
| 70% | $10.54 | $45.18 | $26.23 | **$81.95** | −53.7% | $1.05 |
| 80% | $12.05 | $30.12 | $26.23 | **$68.40** | −61.3% | $0.88 |

Formula: `h*P/1e6*0.20 + (1-h)*P/1e6*2.00 + O/1e6*10.00`. Annualised: $2,122 / $1,471 / $1,146 / $983 / $821 per year.

- Each 10 points of hit rate is worth **~$13.55/month**.
- Output is $26.23 — 15% of the bill at 0% hit and 38% at 80%. It becomes the dominant term as caching improves, so further caching has diminishing returns past ~70%.
- Sensitivity, main-chat calls only (excluding the 6,200 auxiliary `model2` calls, which would stay on a local model): P=68,408,725, O=2,426,036 → $161.08 / $111.82 / $87.20 / $74.88 / $62.57.

### Which hit rate is plausible?

**60% is the defensible planning number; 70% is the ceiling and needs prompt work; 80% is not supported.**

Evidence for 60%:
1. **Direct measurement on this exact prompt structure.** DeepSeek's automatic prefix cache — no app changes, same non-deterministic prompt assembly — realised **61.8% all-time (68 calls)** and 48.9% within 90d. That is not a lab number; it is this app's prompt, cached by a provider that does nothing but match the longest common prefix.
2. **The hit rate rises with size, and the tokens are in the big calls.** The 100k+ band hit 71.7%; 95.6% of the app's input tokens are in 32k+ calls. A token-weighted estimate sits nearer the top band than the call-weighted 50%.
3. **The repeat-share ceiling is 68–71%** (§2), so anything above ~70% would require caching bytes the conversation never re-sends — physically impossible without changing prompt assembly.

Why 70% is the edge, not the expectation: it is essentially *at* the measured repeat-share ceiling, and it requires the parts of the prompt that vary per turn (date, language, profile, reordered sections) to stop breaking the prefix. Realising it is P1 in `harness-review-2026-09-05.md` (byte-stable system prompt + native message history). Until then, expect 40–60%.

Why 80% is unsupported: no cohort in the data exceeds it in aggregate (best per-model: 62.2%; best single call 98.1% on a 9.1k prompt), and per-call hits are quantised to 64-token blocks, so the uncacheable remainder never rounds away. 80% is 9–12 points *above* the ceiling of what repeats.

---

## 5. Token-accounting audit

Checks against the assumptions in `src/lib/server/services/analytics.ts` → `calculateCostUsdMicros` (lines 2026–2057).

| check | result (90d) | verdict |
|---|---|---|
| `total_tokens = prompt + completion`, provider rows | **13,009 / 13,009** | clean |
| `total_tokens = prompt + completion`, estimated rows | 4 / 26 (22 add reasoning) | **inconsistent** |
| `cache_hit + cache_miss > prompt` | **0 rows** | clean — no double billing |
| `cache_hit + cache_miss = prompt` (telemetry rows) | **27 / 27** | clean |
| `cache_hit_tokens ≠ cached_input_tokens` | **0 rows** | fallback never exercised |
| `cache_hit_tokens % 64 ≠ 0` | **0 of 27** | 64-token block granularity |
| `reasoning_tokens` vs `completion_tokens` (provider) | 3,166,371 ⊂ 4,585,874 | contained — do **not** add |

What this means for a cache-saving estimate:

1. **The billing formula is sound for cache attribution.** `regularInput = max(0, prompt - (hit + miss))`, then hit and miss are billed at their own rates. Because no row has `hit+miss > prompt`, the `max(0, …)` never truncates and no token is billed twice. Rows that report nothing get `regularInput = prompt` — correct for a provider with no cache data, but see §0: it makes 98.6% of tokens look like a 0% hit rate.
2. **`reasoning_tokens` must not be added to `completion_tokens`.** On provider rows reasoning is already inside completion. Adding them overstates output by 69% (4,585,874 → 7,752,245) and, at $10/1M, inflates the output line from $26.23 to $77.52 — taking the 0%-hit monthly bill from $176.82 to $228.12, a 29% overstatement. The existing `completionTokens || reasoningTokens` (a fallback, not a sum) is the right shape.
3. **Estimated rows double-count reasoning.** For the 26 estimated rows, `total = prompt + completion + reasoning` (+57,444 tokens). No price rule is attached, so **billed spend is unaffected**, but any figure derived as `total - prompt` is wrong for those rows.
4. **This is where the brief's earlier 4,641,626 output came from.** `Σ(total - prompt)` over 90d = 4,643,318, which is 1.2% above the true billable `Σcompletion` = 4,585,874 — consistent with an output figure derived from `total - prompt`. Use `completion_tokens`: 4,585,874.
5. **No inconsistency distorts the cache-saving estimate.** The one real risk is interpretational: treating the 0% Qwen rows as evidence about caching. They are not evidence either way — vLLM's prefix-cache state is simply not recorded in `usage_events`, so it cannot be confirmed or refuted from this table.

---

## 6. What the data can and cannot prove

**Can prove:**
- The upper bound on cacheable input is **~68–71%** of tokens, set by `1 − Σmax/Σtotal` over conversations. It is a hard ceiling: bytes a conversation never re-sends cannot be reused.
- The static 8k prefix accounts for only **7.6%** of main-chat input tokens; 98.8% of tokens are in calls larger than 16k. Prefix caching alone is a minor lever; history reuse is the lever.
- With an automatic prefix cache and no app changes, this prompt structure realises **48.9% (90d) / 61.8% (all-time)** on DeepSeek, rising with prompt size to 71.7% on 100k+ calls.
- A Kimi K3.1 Pro bill at 30-day volumes is **$177/month at 0% hit, $95 at 60%, $82 at 70%, $68 at 80%**.
- The current code's cache-cost attribution is arithmetically consistent (no double billing, no `hit+miss > prompt`).

**Cannot prove:**
- **Whether the Qwen/local rows cache at all.** 98.6% of prompt tokens carry no cache telemetry. The 0.33% aggregate says nothing about them. The app's real current cache behaviour is unknown from this table.
- **The realised hit rate on Fireworks.** DeepSeek's cache is measured; Fireworks' cache policy, TTL, minimum prefix length and block size are not. The DeepSeek numbers are a *proxy* for structural cacheability, not a guarantee of the same rate on a different vendor. One Kimi row with 0 cached is not evidence either way.
- **Cache TTL effects.** `created_at` is the only timing signal, and it cannot show whether a prefix was still warm when the next call arrived. Multi-hour gaps between turns (common here — the top conversation spans days) would miss a short-TTL cache; DeepSeek's hits on consecutive same-minute calls (60.9% → 67.5% → 81.8% → 82.1%) suggest the within-turn tool loop dominates the benefit.
- **Which prompt sections are actually identical.** `usage_events` stores totals only; there is no per-section breakdown, so the 7.6% static-prefix share is bounded by token counts, not verified byte-for-byte. The review doc notes the prompt is re-rendered each turn with reordered sections, which can only push the realised rate below the ceiling.
- **A true marginal cost.** At $0 for self-hosted Qwen, the K3.1 Pro figures are a "what if we moved to a hosted frontier model" counterfactual, not a saving against today's bill.

---

## 7. SQL appendix

**§0 / §1 — 90-day totals and per-model breakdown**

```sql
-- aggregate
SELECT COUNT(*) rows, SUM(prompt_tokens) prompt,
  SUM(CASE WHEN cache_hit_tokens>0 THEN cache_hit_tokens ELSE cached_input_tokens END) cached,
  SUM(completion_tokens) output,
  ROUND(100.0*SUM(CASE WHEN cache_hit_tokens>0 THEN cache_hit_tokens ELSE cached_input_tokens END)
        /NULLIF(SUM(prompt_tokens),0),2) hit_pct,
  ROUND(SUM(cost_usd_micros)/1e6,2) usd
FROM usage_events
WHERE created_at >= CAST(strftime('%s','now') AS INTEGER) - 90*86400;

-- per model/provider
SELECT model_id, COALESCE(model_display_name,'-') model, COALESCE(provider_display_name,'-') provider,
  usage_source, COUNT(*) calls, SUM(prompt_tokens) prompt,
  SUM(CASE WHEN cache_hit_tokens>0 THEN cache_hit_tokens ELSE cached_input_tokens END) cached,
  ROUND(100.0*SUM(CASE WHEN cache_hit_tokens>0 THEN cache_hit_tokens ELSE cached_input_tokens END)
        /NULLIF(SUM(prompt_tokens),0),1) hit_pct,
  SUM(completion_tokens) output, ROUND(SUM(cost_usd_micros)/1e6,2) usd
FROM usage_events
WHERE created_at >= CAST(strftime('%s','now') AS INTEGER) - 90*86400
GROUP BY model_id, provider_display_name, usage_source
ORDER BY prompt DESC;

-- telemetry coverage (§0)
SELECT usage_source, COUNT(*) rows, SUM(cache_hit_tokens>0) hit_rows,
  SUM(prompt_tokens) prompt
FROM usage_events
WHERE created_at >= CAST(strftime('%s','now') AS INTEGER) - 90*86400
GROUP BY usage_source;
```

**§1 — DeepSeek hit rate by prompt band (run without the date filter for the 68-call all-time set)**

```sql
SELECT CASE WHEN prompt_tokens<20000 THEN 'a <20k'
            WHEN prompt_tokens<100000 THEN 'b 20-100k' ELSE 'c 100k+' END band,
  COUNT(*) calls, SUM(prompt_tokens) prompt, SUM(cache_hit_tokens) hit,
  ROUND(100.0*SUM(cache_hit_tokens)/SUM(prompt_tokens),1) hit_pct
FROM usage_events
WHERE cache_hit_tokens+cache_miss_tokens>0
GROUP BY band ORDER BY band;
```

**§2 — repeat share, aggregate and thresholds**

```sql
WITH c AS (
  SELECT conversation_id, COUNT(*) calls, SUM(prompt_tokens) tot, MAX(prompt_tokens) mx
  FROM usage_events
  WHERE created_at >= CAST(strftime('%s','now') AS INTEGER)-90*86400
  GROUP BY conversation_id
), s AS (SELECT *, 1.0*(tot-mx)/tot rs FROM c WHERE tot>0)
SELECT COUNT(*) n, SUM(tot) total, SUM(mx) sum_max,
  ROUND(100.0*(SUM(tot)-SUM(mx))/SUM(tot),2) repeat_pct,
  SUM(rs>0.5) gt50, SUM(rs>0.7) gt70, SUM(rs>0.8) gt80
FROM s;
```

Add `AND prompt_tokens>0 AND model_id!='model2' AND model_id NOT LIKE 'parallel:%'` to the inner query for the main-chat-only figure (67.98%, n=270).

**§3 — prompt-size distribution and static-prefix ceiling**

```sql
SELECT
  SUM(prompt_tokens<8000) lt8k, SUM(prompt_tokens>=8000 AND prompt_tokens<16000) b8_16k,
  SUM(prompt_tokens>=16000 AND prompt_tokens<32000) b16_32k, SUM(prompt_tokens>=32000) b32k,
  COUNT(*) calls, SUM(prompt_tokens) tokens,
  ROUND(100.0*SUM(MIN(prompt_tokens,8000))/SUM(prompt_tokens),2) pct_first_8k,
  ROUND(100.0*SUM(CASE WHEN prompt_tokens>16000 THEN prompt_tokens ELSE 0 END)
        /SUM(prompt_tokens),2) pct_tokens_gt16k
FROM usage_events
WHERE created_at >= CAST(strftime('%s','now') AS INTEGER)-90*86400
  AND prompt_tokens>0 AND model_id!='model2' AND model_id NOT LIKE 'parallel:%';
```

**§5 — accounting invariants**

```sql
SELECT usage_source, COUNT(*) rows,
  SUM(total_tokens = prompt_tokens + completion_tokens) exact_eq,
  SUM(total_tokens >  prompt_tokens + completion_tokens) total_gt,
  SUM(cache_hit_tokens + cache_miss_tokens > prompt_tokens) cache_gt_prompt,
  SUM(cache_hit_tokens % 64) hit_non64_sum,
  SUM(prompt_tokens>0 AND cache_hit_tokens+cache_miss_tokens=prompt_tokens) exact_cache_sum,
  SUM(cache_hit_tokens>0 AND cached_input_tokens=0) hit_wo_cachedin
FROM usage_events
WHERE created_at >= CAST(strftime('%s','now') AS INTEGER)-90*86400
GROUP BY usage_source;
```

**§4 — cost model** (no SQL; arithmetic on the 30-day volumes):

```python
P, O = 75_298_221, 2_622_811
for h in (0.0, 0.40, 0.60, 0.70, 0.80):
    cost = h*P/1e6*0.20 + (1-h)*P/1e6*2.00 + O/1e6*10.00
    print(f"{h:.0%}  ${cost:,.2f}/month")
```
