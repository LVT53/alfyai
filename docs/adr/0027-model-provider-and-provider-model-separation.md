# Model Provider and Provider Model separation

> **Extended by [ADR-0047](0047-provider-cost-price-windows-and-cache-accounting.md) (time-slot price windows + prompt-cache token accounting) and [ADR-0048](0048-openai-compatible-provider-family-compatibility.md) (provider-family compatibility profiles).**

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
- Normal Chat **Model Fallback** belongs to the selected Provider Model first, then the global fallback if no model-specific fallback is configured. Provider-wide fallback is retired from the routing contract and should be treated as migration debt rather than current design.
- `usage_events.providerId` references `providers.id` (existing analytics rows are not migrated — they keep their historical values).
- `seed-prices.ts` script is retired; an admin UI for per-model pricing replaces it. Historical `usage_events.costUsdMicros` values are unaffected since costs are computed at write time.
- No backward compatibility for the `inference_providers` table or `model_price_rules` table — this is a breaking DB migration.
- **Model Discovery** is triggered when a Provider is created or when an admin explicitly refreshes it, calling the provider's `/v1/models` endpoint.

## Superseding fallback clarification, 2026-06-15

The original Provider-level rate-limit fallback consequence is superseded. The current contract is:

- A Provider Model may define one model-specific **Model Fallback** to another Provider Model.
- If no model-specific fallback is configured, Normal Chat may use the global Model Fallback.
- Provider-wide fallback is not part of Normal Chat routing.
- Fallback applies only to retryable infrastructure or model-availability failures, not auth/configuration/schema/user-abort/refusal cases.
- Fallback does not chain. If the selected fallback attempt fails, the model run stops through the existing error path.
- Fallback configuration is strict for model-specific choices when explicit incompatible evidence exists: admin surfaces should block fallback targets that explicitly lack a capability the source Provider Model is known to use. Unknown provider-discovery capability state is advisory, not automatically incompatible, because many OpenAI-compatible model-list endpoints do not report chat or streaming flags. A global fallback may be saved even when incompatible with some enabled Provider Models, but it applies only to compatible inheriting models and incompatible models must be visibly warned in admin surfaces.
- Fallback compatibility treats an enabled Provider Model as chat-capable by definition. Other Normal Chat capabilities are compared from explicit evidence: streaming, tools, structured output/JSON mode, file/image message parts when applicable, and provider-native reasoning controls when explicitly configured or detected. Usage reporting is not a fallback blocker.
- If no compatible fallback exists for an enabled Provider Model, the admin UI should show a compact warning on the provider/model row and a short explanation in the model edit modal. This warning is configuration visibility, not end-user chat UI.
- At runtime, if the selected Provider Model has no compatible model-specific fallback and cannot inherit a compatible global fallback, Normal Chat makes no fallback attempt and follows the existing error path with diagnostics.
- Model Fallback applies to the main Normal Chat answer Model Run only. Depth Classification, structured control-model calls, and schema-repair paths keep their own constrained fallback behavior.
- Model Fallback is admin-only configuration. End users choose the primary Provider Model and do not choose, override, or see fallback policy during normal chat.

Implementation guardrails:

- Do not reintroduce provider-wide fallback into Normal Chat routing.
- Do not store fallback as a raw provider URL, model name, or API key tuple; fallback targets are Provider Models.
- Do not resolve fallback by partially swapping the provider URL or model name under the original Provider Model. Resolve the fallback Provider Model into its own Model Connection.
- Do not silently inherit an incompatible global fallback. Global fallback applies only to compatible inheriting Provider Models.
- Do not make fallback chains. The selected Provider Model gets at most one fallback attempt.
- Do not hide fallback compatibility problems until a live user turn. Admin surfaces should expose incompatible or missing fallback choices before runtime.
