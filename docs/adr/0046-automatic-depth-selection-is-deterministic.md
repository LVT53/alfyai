# Automatic Depth Selection is a deterministic rules classifier, not an LLM preflight

Accepted. `Auto` Reasoning Depth now resolves `standard` / `extended` / `maximum` with a **deterministic rules classifier** (keyword scoring + regex patterns) and no model call. This **amends ADR-0028 (Normal Chat Reasoning Depth)**: the LLM structured-output preflight and the admin-configurable **Depth Classifier Model** it mandated are retired. Everything else in ADR-0028 — the `Off`/`Auto`/`Max` control, multi-pass deliberation, the Depth Clarification Gate, Depth Metadata/Observability, and the Reasoning Depth Evaluation Harness — still stands.

> **Recorded 2026-07-10, retroactively.** The change landed 2026-07-02 (commit "Replace auto reasoning depth classifier", ~1800 net lines removed) without amending ADR-0028, which still describes the removed classifier as mandatory. This document records the reversal so it is not read as a bug against 0028.

## What changed

ADR-0028 specified that `Auto` "runs an app-owned structured **preflight**" over a bounded **Depth Classification Context**, and that "admins may configure a specific available **Depth Classifier Model**" to make that preflight faster/cheaper/more consistent. ADR-0028's Considered Options went further and **explicitly rejected** "hardcoded keyword rules … as the primary classifier," allowing a deterministic keyword heuristic only "as a last-resort fallback when the LLM classifier call fails entirely … but not as the primary mechanism," on the reasoning that task difficulty is language-dependent and latency varies by provider/model/context/load.

The shipped implementation inverts that: `chat-turn/depth-selection.ts` resolves depth entirely through `runDeterministicRulesClassifier` — keyword/regex signal detection (ambiguity, referential, short-follow-up, complexity, and grounding patterns) with negation handling — and the only `classifierSource` values it can emit are `deterministic_bypass`, `deterministic_fast_path`, and `deterministic_rules`. **No model call happens on the Auto path.** The removed pieces included the structured control-model call, `DEPTH_CLASSIFIER_SYSTEM_PROMPT`, `DEPTH_CLASSIFICATION_SCHEMA`, the adaptive `[256, 640, 1280]` token-budget-with-retry defense, `buildDepthClassificationContext`, and the admin **Depth Classifier Model** setting (dropped from `config-store.ts`, `env.ts`, `i18n/settings.ts`, and `SettingsAdminSystemPane.svelte`).

## Why the reversal held up

The deterministic classifier is fast (no network round-trip on the hot path), free, and fully predictable/traceable — a turn's depth decision is reproducible from its text. In practice the LLM preflight's language/latency sensitivity — the very argument ADR-0028 used to *reject* rules — turned out to be an acceptable trade against a per-turn control-model call on every Auto turn, given that `Max` remains available for explicit escalation and the deterministic complexity/grounding patterns cover the cases that matter. The old classifier's "defense-in-depth" (adaptive budgets, retries, structured-output repair) existed only to make the model call reliable; deleting the call deletes the failure mode.

## Considered Options

- **Keep the LLM depth classifier per ADR-0028.** Rejected: a structured control-model call on every Auto turn adds latency and cost to the hot path, and its reliability scaffolding (adaptive token budgets, retry, schema-in-prompt repair) was pure overhead for a routing decision.
- **Deterministic rules as primary, LLM as fallback.** Not adopted: keeping the LLM path alive only for rare fallbacks would retain the config surface (Depth Classifier Model) and the failure modes without meaningfully improving routing at this scale.
- **Deterministic rules classifier as the sole mechanism (chosen).** Fast, free, reproducible; `Max` covers explicit high-effort intent; the deliberation/clarification/eval machinery from ADR-0028 is unaffected.

## Consequences

- **The admin Depth Classifier Model setting no longer exists.** Operator docs, i18n, and the admin system pane no longer reference it; do not reintroduce a "classifier model" config expecting the LLM preflight to consume it.
- **Depth routing quality is now a function of the keyword/regex catalogue** in `depth-selection.ts`, tuned by editing patterns rather than a prompt. The Reasoning Depth Evaluation Harness (ADR-0028) remains the way to validate that Auto still picks the right profile across code/grounded/project/planning/self-contained prompts.
- **ADR-0028 is amended, not superseded.** Its Depth control, deliberation passes, Depth Clarification Gate, Depth Metadata, and evaluation-harness requirements are unchanged; only its "app-owned structured LLM preflight" and "Depth Classifier Model" mechanism are retired.
- **CONTEXT.md is stale here.** The glossary terms **Depth Classifier Model**, **Depth Classifier Resilience**, **Depth Classification Context**, and the classifier-signal parts of **Depth Observability** describe the removed LLM preflight and must be retired or rewritten to describe deterministic selection. `deterministic_bypass` / `deterministic_fast_path` / `deterministic_rules` are internal `classifierSource` values and do not need glossary entries unless they become user-facing.
