# Provider-family compatibility profiles are the seam for OpenAI-compatible quirks

Accepted. Provider-specific request/response quirks for OpenAI-compatible models live in one place — a family-based compatibility layer (`normal-chat-model/provider-compatibility.ts`) that classifies each provider model into a **Provider Family** and applies that family's request-body transforms, thinking options, tool-choice policy, and stream normalization. New provider quirks are added by extending a family profile, not by branching in the model-run or route code. This **extends ADR-0027 (Model Provider and Provider Model separation)**, which established the provider/provider-model records but left runtime execution described only as "OpenAI-compatible."

> **Recorded 2026-07-10, retroactively.** The adapter was deepened incrementally (notably 2026-06-28 "Deepen OpenAI-compatible provider adapter" and the surrounding stream-fixture harness work) without an ADR. This records the boundary so provider quirks keep converging here instead of leaking into callers.

## The boundary

**Provider Family** (`ProviderFamily`) is a classification of a provider model — currently `openai`, `deepseek`, `mimo`, `kimi`, `glm`, `qwen`, `mistral`, and `nvidia_nemotron` — derived from model id / base-URL patterns. Each family carries a compatibility profile:

- **`thinkingOptions`** — how to enable/disable provider-native reasoning for that family (the `thinkingMode: "off"` used by the memory pipeline and Reasoning Depth `Off` flows through here).
- **`toolChoicePolicy`** — when tool-choice can be forced vs. must be relaxed, including quirks like `deepseek-legacy-reasoner-when-thinking` and streaming-tool compatibility.
- **Request-body transforms** — token-field renames, provider-namespaced options (including the Fireworks prompt-cache field translation from ADR-0047), and removals such as stripping tool-reasoning fields for GPT-5-style models.

Two companion pieces complete the seam:
- **`openai-compatible-stream-normalizer.ts`** normalizes provider SSE deltas (content, reasoning, and cached-token fields) into one internal shape so downstream stream handling is provider-agnostic.
- **`mimo-reasoning-replay.ts`** is a bespoke fetch wrapper that replays reasoning content keyed by tool-call id for MiMo models, which otherwise drop it between turns.

`openai-compatible-provider.ts` constructs the provider and `failover.ts` handles per-model fallback; both consume the compatibility profile rather than re-implementing quirks. A provider-stream **fixture harness** (`tests/fixtures/ai/openai-compatible-*`) pins each family's delta shapes so normalization changes are regression-tested without live providers.

## Considered Options

- **Branch on provider/model id at each call site.** Rejected: the same quirk (thinking flags, tool-choice, token-field names) would be re-encoded in model-run, streaming, and failover code and drift apart.
- **One monolithic per-model switch.** Rejected: quirks cluster by vendor family, not by individual model; a family profile covers all of a vendor's models and is where a new model of a known vendor lands for free.
- **Family-classified compatibility profiles (chosen).** Provider quirks converge in one module with fixture coverage; adding a provider means adding/extending a family profile and its fixtures.

## Consequences

- **Adding a provider is a bounded change**: classify it into an existing family (or add a family), extend the profile, and add stream fixtures. Callers (model run, streaming, failover) need no changes.
- **The normalizer is load-bearing**: any provider that reports content/reasoning/cached-token deltas in a new shape needs a normalizer branch, or that data is silently dropped downstream (this is the same failure mode as the cache-token mapping in ADR-0047).
- **This is a runtime-execution boundary, not new product language.** CONTEXT.md's Model Provider Context should name the OpenAI-compatible adapter + provider-family compatibility profiles as the owned seam under **Normal Chat Model Run**, but the family names and profile fields are implementation contract, not glossary terms.
