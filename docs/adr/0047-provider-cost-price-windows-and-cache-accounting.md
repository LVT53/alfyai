# Provider cost accounting: time-slot price windows and prompt-cache token accounting

Accepted. Per-**Provider Model** pricing gains two capabilities beyond the flat rates ADR-0027 moved onto `provider_models`: (1) an admin-managed schedule of **Price Windows** that override rates for a recurring day-of-week/time-of-day slot, resolved at each call's timestamp; and (2) runtime **prompt-cache accounting** that emits a provider cache key per turn and reads cached-token usage back from provider metadata, so cache-hit/miss rates are billed against real cache token counts. This **extends ADR-0027 (Model Provider and Provider Model separation)**; it does not change the provider/provider-model boundary.

> **Recorded 2026-07-10, retroactively.** Prompt-cache accounting landed 2026-06-30 ("Support provider prompt cache accounting"); price windows landed 2026-07-08 ("Inference pricing: optional time-slot windows + cache-aware memory cost"). Neither had an ADR. ADR-0027 documented only that cache hit/miss rate *fields* live on `provider_models`.

## Price Windows

**Price Window** is a row in `provider_model_price_windows` (migration `drizzle/1777140000072_price_windows.sql`; service `src/lib/server/services/price-windows.ts`) attached to one provider model. It carries a `label`, a `daysOfWeek` UTC day-of-week mask, a `[startMinute, endMinute)` minute range (start inclusive 0–1439, end exclusive up to 1440, **midnight wraparound allowed** when `end <= start`), an `enabled` flag, and optional rate overrides for each of `input`, `cachedInput`, `cacheHit`, `cacheMiss`, and `output` (`*UsdMicrosPer1m`, nullable — a null field falls back to the flat `provider_models` rate).

**Resolution** (`analytics.ts`: `EffectivePriceWindow`, `priceWindowActiveAt`) picks the active window for a call's timestamp: disabled windows are ignored; among enabled windows whose day-mask and minute range contain the timestamp, ties break by `startMinute` then `id`; if none match, the flat `provider_models` rates apply. The resolved effective rates are threaded into **every** cost-recording path — normal-chat message usage, Atlas model stages (`atlas/model-stage.ts`), and memory model calls (`memory-cost.ts`) — so a single pricing schedule governs all model spend. Costs are computed at write time; historical `usage_events.costUsdMicros` values are never recomputed.

## Prompt-cache accounting

`normal-chat-model/index.ts` generates a stable per-turn prompt cache key (`buildPromptCacheKey`, applied via `withPromptCacheOption` as a provider-namespaced option) to raise provider cache-hit rates, then reads cached-token usage back from provider metadata (`mapCachedPromptTokensFromProviderMetadata`) across three shapes:
- **OpenAI-style** — `cachedPromptTokens` / `prompt_tokens_details.cached_tokens`.
- **Fireworks-style** — `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`, with a camel→snake request-body translation (`prompt_cache_key` / `prompt_cache_isolation_key`) applied in the provider-compatibility layer.
- **Generic AI-SDK** — `inputTokenDetails`.

These populate `cachedInputTokens` / `cacheHitTokens` / `cacheMissTokens` on the run's usage, which combine with the (possibly window-overridden) `cacheHit` / `cacheMiss` / `cachedInput` rates to price a turn against its actual cache behavior instead of the flat input rate. The same cache-aware pricing fix was applied to the memory pipeline, whose DeepSeek judge/consolidation/summary/re-curation calls were previously mispriced at the flat input rate (see ADR-0045).

## Considered Options

- **Flat per-model rates only (ADR-0027 status quo).** Rejected: cannot express off-peak/self-hosted-idle pricing, and bills cache hits at full input price, overstating cost for cache-heavy workloads (memory pipeline, long system prompts).
- **A separate price-rules table like the retired `model_price_rules`.** Rejected: ADR-0027 deliberately collapsed pricing onto `provider_models`; windows are an additive override keyed to a provider model, not a return to a parallel rules engine.
- **Price windows + runtime cache accounting threaded through all cost paths (chosen).** One resolver, one set of rate fields (flat + per-window), consumed identically by message/Atlas/memory cost recording.

## Consequences

- **Pricing is now time- and cache-dependent.** A cost figure is only reproducible together with the call timestamp (which window was active) and the provider-reported cache token split. Analytics that assume a single flat rate per model are wrong for any model with windows.
- **Cache accounting depends on provider metadata shape.** New providers that report cached tokens in an unrecognized field silently record zero cache tokens (billed as full input) until a mapping is added to `mapCachedPromptTokensFromProviderMetadata`.
- **Window validation lives in `price-windows.ts`** (`PriceWindowValidationError`); the admin editor is the Time-slot pricing surface on the model form. The resolver-facing loader filters to `enabled` windows; the admin loader returns all.
- **CONTEXT.md needs Model-Provider terms** for **Price Window** (recurring rate override + resolution/tie-break/fallback) and **Prompt Cache Accounting** (cache-key emission + cache-aware cost). These are operator/product-facing cost concepts, so glossary entries are warranted.
