# Model Provider and Provider Model separation

The `inference_providers` table currently bundles a base URL, API key, and model name into one row — every "provider" is exactly one model. We are splitting this into **Model Provider** (base URL + API key) and **Provider Model** (model name + context limits + capabilities + pricing), so one provider can serve multiple models.

## Decision

We introduce two new concepts:

- **Model Provider**: A connection to an external LLM service, defined by a base URL and API key. Seeded from environment variables or created by an admin.
- **Provider Model**: A specific model name under a provider, with its own display name, context limits, capability flags, reasoning configuration, and pricing. Admins select which discovered models to make available; users pick from available Provider Models in the chat model selector.

model1 and model2 are folded into this system as two auto-seeded providers from `MODEL_1_*` / `MODEL_2_*` environment variables, each with one Provider Model. They have no special status at runtime — an admin can delete them if needed.

## Context

The existing `inference_providers` table forced a 1:1 mapping between a provider connection and a model name. This caused operational problems: an admin managing multiple models from the same provider (Fireworks, DeepSeek) had to create separate provider rows, each with a separate API key field. Updating the key on one row did not update others, leading to billing surprises.

The system already probes `/v1/models` when creating a provider (to validate the configured model name exists), but discards the rest of the model list. The new design uses this response for auto-discovery: the admin configures a provider, the system fetches the model list, and the admin selects which to make available.

## Considered Options

- **Keep the bundled table, add a "key inheritance" feature**: Providers could optionally share an API key. Rejected — adds complexity without solving the fundamental problem of model identity being tied to provider identity.
- **Separate Provider and Model, keep model1/model2 as special**: Rejected — adds code paths for built-in vs. admin-configured models, which is the source of the current confusion.
- **Separate Provider and Model, fold model1/model2 in**: Selected. All models, whether local vllm instances or remote services, are Provider Models under their respective Providers.

## Consequences

- Two new DB tables (`providers`, `provider_models`) replace `inference_providers`.
- The `model_price_rules` table is removed; pricing fields (`input_usd_micros_per_1m`, `output_usd_micros_per_1m`, cache hit/miss rates) move to `provider_models`.
- The system prompt is extracted from model1's grip into a global config field.
- `DEFAULT_NEW_USER_MODEL` defaults to the first available Provider Model (by sort order).
- Rate-limit fallback lives at the Provider level (one per provider) with optional per-model overrides, and is implemented for Normal Chat (previously Deep Research only).
- `usage_events.providerId` references `providers.id` (existing analytics rows are not migrated — they keep their historical values).
- `seed-prices.ts` script is retired; an admin UI for per-model pricing replaces it. Historical `usage_events.costUsdMicros` values are unaffected since costs are computed at write time.
- No backward compatibility for the `inference_providers` table or `model_price_rules` table — this is a breaking DB migration.
- **Model Discovery** is triggered when a Provider is created or when an admin explicitly refreshes it, calling the provider's `/v1/models` endpoint.
