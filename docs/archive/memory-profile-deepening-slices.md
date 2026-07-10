# Memory Profile Module Deepening Slices

Source: `docs/architecture-deepening-report.html`, Candidate 1: split `src/lib/server/services/memory-profile/index.ts` internals behind the existing Memory Profile seam.

This document is local planning output, not published tracker state. No issue tracker configuration was found in this workspace, and the user asked for a local file.

## Context

`src/lib/server/services/memory-profile/index.ts` is currently a 3,329-line module. Its interface covers Memory Profile constants and types, reset generation guards, projection item writes, public read models, active prompt context formatting, Guided Memory Review, dirty ledger marking and reconciliation, preserved legacy curation, legacy migration coordination, and Memory Rework Telemetry.

That module has depth for callers, but the implementation now has poor locality. A change to prompt context, review resolution, dirty ledger retries, or model-assisted legacy curation all lands in the same file. Fallow reinforces this: the current run reports 24 existing findings, including 12 circular dependencies, with `memory-profile/index.ts` present in 8 of the 12 circular paths.

The target is not a new product capability. The target is to keep the current Memory Profile interface compatible while splitting the implementation into deep internal modules that expose narrower seams where callers already have narrower needs.

Docs and evidence checked before planning:

- `AGENTS.md`: routes are adapters; durable logic belongs in server modules; keep Memory Profile projection-backed; keep compact memory observability.
- `src/lib/server/services/AGENTS.md`: `memory.ts` is the public module for the Knowledge Base Memory Profile; `memory-profile/` owns the durable Memory Profile Projection; raw Honcho output must not bypass the projection for ordinary personalization.
- `docs/adr/0033-guided-memory-review.md`: Guided Memory Review, Memory Profile Projection, Memory Reset Generation, dirty ledger work, preserved legacy memory, and Memory Rework Telemetry are intentional product choices.
- `docs/memory-rework-implementation-issues.md`: the product implementation exists; this file is a follow-up architecture plan, not a replacement implementation plan.
- Context7 Vitest 4.1.6 docs: typed `vi.mock(import(...))` with `importOriginal` is the current pattern for module mocking in focused tests.
- Current tests: `src/lib/server/services/memory-profile/index.test.ts` has 2,940 lines covering the existing facade; `src/lib/server/services/memory-profile/intake.test.ts` has 1,091 lines covering intake behavior.

## Current Public Callers

- `src/lib/server/services/memory.ts` reads and mutates the user-facing Knowledge Base Memory Profile.
- `src/lib/server/services/chat-turn/context-selection.ts` and `src/lib/server/services/memory-context.ts` need only Active Memory Profile Context, prompt formatting, and prompt-use telemetry.
- `src/lib/server/services/memory-profile/intake.ts` needs item creation, provenance, reset-generation guards, dirty marking, read-model checks, and telemetry.
- `src/lib/server/services/memory-maintenance.ts` needs dirty ledger reconciliation and preserved legacy curation.
- Clear/reset paths need `advanceMemoryResetGeneration`.
- Chat send/stream/retry/finalize paths need reset-generation reads and guards.
- Tests currently mock `memory-profile` as one large module in several places.

## Target Module Map

The external facade can stay at `src/lib/server/services/memory-profile/index.ts` during migration, but the implementation should move behind these internal modules:

- `types.ts`: constants, public types, category/reason/family validation, privacy-safe metadata validation.
- `scope.ts`: scope column mapping and item-key derivation helpers.
- `reset-generation.ts`: current generation reads, advances, stale-generation guard, stale-generation error.
- `projection-store.ts`: projection state, item create/update, provenance, expiry, blocked-state reads, revision bumping.
- `read-model.ts`: Knowledge Base Memory Profile read model and item detail projection.
- `active-context.ts`: Active Memory Profile Context read and prompt formatting.
- `telemetry.ts`: Memory Rework Telemetry write/list functions.
- `review.ts`: Guided Memory Review creation, dedupe, resolution, and projection application.
- `dirty-ledger.ts`: dirty entry marking, coalescing, pending listing, claim/requeue/complete lifecycle.
- `dirty-ledger-reconciliation.ts`: bounded dirty work runner that composes review, telemetry, legacy migration, and profile-action verification.
- `legacy-curation.ts`: preserved legacy curation and its model-assisted curator adapter.

This map is intentionally internal. The public facade should remain for compatibility until callers are moved to narrower seams where that increases leverage and locality.

## Done Criteria

- `src/lib/server/services/memory-profile/index.ts` becomes a facade over internal modules rather than owning most implementation inline.
- Existing public exports remain compatible unless a slice explicitly moves a caller to a narrower internal seam.
- Prompt-context callers do not import the broad facade when they only need Active Memory Profile Context and prompt formatting.
- Maintenance callers do not import the broad facade when they only need dirty ledger reconciliation or preserved legacy curation.
- The static import path from Memory Profile prompt reads to `normal-chat-control-model.ts` is removed.
- Memory Profile read model behavior stays projection-backed and does not fall back to raw Honcho output.
- User edits, deletions, suppressions, and review resolutions remain next-turn-effective through the projection.
- Dirty ledger work stays bounded, restart-safe, current-reset-generation scoped, and privacy-safe.
- Existing Memory Rework Telemetry remains backend/log oriented and does not store raw remembered text by default.
- `npm run check` stays clean.
- Fallow reports no new findings; the memory-profile-related circular dependency count should decrease, or any remaining cycle should be named as existing debt outside this slice.

## Issue MPD-01: Establish Shared Memory Profile Types And Reset Generation Module

Triage label: `architecture`

Dependencies: None

Extract constants, public types, validation helpers, scope helpers, item-key helpers, and Memory Reset Generation guards out of the facade while preserving all existing imports from `memory-profile`.

Acceptance criteria:

- Current reset-generation behavior is unchanged: a user starts at generation 0, `advanceMemoryResetGeneration` increments durably, and stale generation checks reject old work.
- Public constants and types keep the same names and values.
- Category, dirty-reason, review-resolution, telemetry-family, and privacy-safe metadata validation behave exactly as before.
- Existing callers can still import from `src/lib/server/services/memory-profile`.
- Reset-generation callers may import from `memory-profile/reset-generation` only where that narrower seam is already natural.
- Existing reset-generation tests in `src/lib/server/services/memory-profile/index.test.ts` pass without changing their expected behavior.

Technical notes:

- Current reset-generation code lives around `src/lib/server/services/memory-profile/index.ts:699`.
- Current type and constant declarations live around `src/lib/server/services/memory-profile/index.ts:29`.
- Keep this first slice mechanically small so later issues can import shared helpers without copying them.

Suggested verification:

- `npm run test:unit -- src/lib/server/services/memory-profile/index.test.ts`
- `npm run check`

## Issue MPD-02: Move Active Profile Reads And Prompt Formatting Behind A Narrow Seam

Triage label: `architecture`

Dependencies: MPD-01

Extract the public Memory Profile read model, item detail projection, Active Memory Profile Context, policy-blocked statement reads, and prompt formatter into read-side modules. Then move prompt-context callers to the narrow active-context seam instead of the broad facade.

Acceptance criteria:

- `getMemoryProfileReadModel` still returns only active category items plus deduped open review summaries for the current reset generation.
- `getMemoryProfileItemDetail` still returns compact source chips and `whyRemembered` without raw Honcho rows, confidence/debug fields, or suppressed/deleted memory.
- `getActiveMemoryProfileContext` still includes global memories and matching scoped memories, excludes non-active states, expires overdue active items before returning, and sanitizes Honcho peer ids.
- `formatActiveMemoryProfileContextForPrompt` still orders newest-first, fits items to token budget, and reports omitted counts.
- `src/lib/server/services/chat-turn/context-selection.ts` and `src/lib/server/services/memory-context.ts` import only the active-context seam for prompt reads and prompt-use telemetry, not the broad facade.
- Fallow no longer reports the direct circular path `chat-turn/context-selection.ts -> memory-profile/index.ts -> normal-chat-control-model.ts -> normal-chat-context.ts -> chat-turn/context-selection.ts`.

Technical notes:

- Current read-model code starts around `src/lib/server/services/memory-profile/index.ts:1020`.
- Current Active Memory Profile Context code starts around `src/lib/server/services/memory-profile/index.ts:1152`.
- Current prompt formatter starts around `src/lib/server/services/memory-profile/index.ts:429`.
- This slice may create `read-model.ts` and `active-context.ts`, with `index.ts` re-exporting both for compatibility.

Suggested verification:

- `npm run test:unit -- src/lib/server/services/memory-profile/index.test.ts src/lib/server/services/chat-turn/context-selection.test.ts src/lib/server/services/memory-context.test.ts`
- `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-memory-profile-active-context-fallow.json`

## Issue MPD-03: Extract Memory Rework Telemetry As Its Own Deep Module

Triage label: `architecture`

Dependencies: MPD-01

Move Memory Rework Telemetry writes and reads behind a telemetry module, then update intake, prompt-context, review, dirty-ledger, and maintenance code to use that module directly where appropriate.

Acceptance criteria:

- `recordMemoryReworkTelemetry` validates fixed event families and categories as before.
- Telemetry metadata still rejects raw text-like unsafe keys through the same privacy-safe metadata rule.
- `listMemoryReworkTelemetry` returns only current-reset-generation events in created order.
- Existing intake tests still prove accepted, rejected, deferred, duplicate, and stale-generation cases record the same telemetry.
- Prompt-context tests still prove active-profile inclusion and blocked/omitted outcomes are observable without raw prompt excerpts.
- Callers that only need telemetry no longer import unrelated projection, review, legacy, or dirty-ledger implementation.

Technical notes:

- Current telemetry implementation lives around `src/lib/server/services/memory-profile/index.ts:3229`.
- `src/lib/server/services/memory-profile/intake.ts` currently imports telemetry through `./index`.
- Context7 Vitest guidance supports typed partial module mocks when caller tests need to mock telemetry while retaining other exports.

Suggested verification:

- `npm run test:unit -- src/lib/server/services/memory-profile/index.test.ts src/lib/server/services/memory-profile/intake.test.ts src/lib/server/services/chat-turn/context-selection.test.ts src/lib/server/services/memory-context.test.ts`

## Issue MPD-04: Extract Guided Memory Review Lifecycle

Triage label: `architecture`

Dependencies: MPD-01, MPD-02, MPD-03

Move Guided Memory Review creation, deduplication, affected-item marking, resolution records, and review-item application into a review module. Keep review reads visible through the Memory Profile read model.

Acceptance criteria:

- Repeated review creation for the same open subject still coalesces evidence and affected item ids.
- Affected active Memory Profile Items still move to `review_needed` and leave Active Memory Profile Context immediately.
- Review accept/edit/dismiss actions still require the expected projection revision and return `stale_projection`, `not_found`, or updated projection data as before.
- Generic review subjects without proposed or edited statements still do not create active profile items.
- Review metadata remains privacy-safe.
- `memory.ts` can keep using the facade, but internal dirty-ledger reconciliation may import review creation through the narrower review seam.

Technical notes:

- Current review creation starts around `src/lib/server/services/memory-profile/index.ts:1373`.
- Current review application starts around `src/lib/server/services/memory-profile/index.ts:1588`.
- Review reads are part of `getMemoryProfileReadModel`, so this issue should coordinate with `read-model.ts` rather than duplicating review-row mapping.

Suggested verification:

- `npm run test:unit -- src/lib/server/services/memory-profile/index.test.ts src/lib/server/services/memory.test.ts src/routes/api/knowledge/memory/memory.test.ts`

## Issue MPD-05: Extract Dirty Ledger Marking And Claim Lifecycle

Triage label: `architecture`

Dependencies: MPD-01, MPD-03

Move dirty entry marking, coalescing, pending listing, stale-claim reclaim, claim, completion, and requeue mechanics into a dirty-ledger module. Keep reconciliation orchestration in place until MPD-07.

Acceptance criteria:

- `markMemoryDirty` still coalesces pending rows by user, reset generation, scope, and reason.
- Coalesced dirty metadata still preserves bounded unique ids and does not grow unbounded arrays.
- `listPendingMemoryDirtyEntries` still returns current-reset-generation pending entries in last-marked order.
- Stale claimed rows are reclaimed and merged with pending rows as before.
- Claim/complete/requeue behavior remains current-reset-generation scoped and restart-safe.
- Existing unsupported-reason, batch-size, stale-claim, and transient-failure tests keep passing.

Technical notes:

- Current dirty marking starts around `src/lib/server/services/memory-profile/index.ts:1809`.
- Current claim lifecycle starts around `src/lib/server/services/memory-profile/index.ts:2586`.
- This slice should avoid pulling review, legacy curation, or control-model imports into the dirty-ledger module.

Suggested verification:

- `npm run test:unit -- src/lib/server/services/memory-profile/index.test.ts src/lib/server/services/memory-maintenance.test.ts`

## Issue MPD-06: Isolate Preserved Legacy Curation And Its Model Adapter

Triage label: `architecture`

Dependencies: MPD-01, MPD-03, MPD-04

Move preserved legacy curation into `legacy-curation.ts` and isolate the model-assisted curator so static imports from ordinary Memory Profile reads do not load `normal-chat-control-model.ts`.

Acceptance criteria:

- `curatePreservedLegacyMemoryForUser` still activates, routes to review, or rejects preserved legacy rows with the same caps and fallback behavior.
- Curation still respects current Memory Reset Generation before and after model work.
- Review caps still allow at most three new preserved-legacy review items per curation slice and never exceed the user open-review cap.
- Model-assisted curation can still use the configured control model, but the static import graph from `active-context.ts` and `read-model.ts` does not include `normal-chat-control-model.ts`.
- If the curator fails, rows still fall back to review as before.
- Tests still prove preserved legacy rows never appear in the public active profile unless curation activates them.

Technical notes:

- Current preserved legacy curation starts around `src/lib/server/services/memory-profile/index.ts:1951`.
- The current file imports `sendJsonControlMessage` at top level, which is the main reason read-side imports can reach the Normal Chat context graph.
- Prefer injecting the curator or dynamically loading the model adapter from the curation path rather than making prompt reads depend on it.

Suggested verification:

- `npm run test:unit -- src/lib/server/services/memory-profile/index.test.ts`
- `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-memory-profile-legacy-curation-fallow.json`

## Issue MPD-07: Extract Dirty Ledger Reconciliation Runner And Update Maintenance Imports

Triage label: `architecture`

Dependencies: MPD-03, MPD-04, MPD-05, MPD-06

Move bounded dirty-ledger reconciliation into a reconciliation module that composes the dirty-ledger, review, telemetry, active-context, legacy migration, and legacy curation modules. Update `memory-maintenance.ts` to import the reconciliation and legacy-curation seams directly.

Acceptance criteria:

- `reconcileMemoryProfileDirtyLedgerForUser` still claims up to the configured batch size, honors max runtime, requeues transient failures, completes unsupported reasons with skipped telemetry, and reports claimed/completed/failed/skipped/timedOut counts.
- `possible_duplicate` and `review_generation` still create exact duplicate reviews only for active duplicate items.
- `possible_conflict` still creates reviews only when dirty metadata has a deterministic subject.
- `profile_action_reconciliation` still verifies that non-active rows are excluded from Active Memory Profile Context and records telemetry.
- `legacy_migration` still accepts injected bounded legacy batches, advances page cursors through dirty metadata, and follows with preserved legacy curation.
- `honcho_reconciliation` still records projection-only telemetry without broad cleanup.
- `src/lib/server/services/memory-maintenance.ts` no longer imports the broad `memory-profile` facade for reconciliation or legacy curation.
- Fallow shows fewer memory-profile-related circular dependencies than the pre-plan baseline.

Technical notes:

- Current reconciliation runner starts around `src/lib/server/services/memory-profile/index.ts:2770`.
- `src/lib/server/services/memory-maintenance.ts` currently imports `curatePreservedLegacyMemoryForUser` and `reconcileMemoryProfileDirtyLedgerForUser` from `./memory-profile`.
- This is the highest-risk slice because it exercises several internal modules through one behavior path. Keep it behavior-preserving first; do not optimize the dirty work algorithm in the same change.

Suggested verification:

- `npm run test:unit -- src/lib/server/services/memory-profile/index.test.ts src/lib/server/services/memory-maintenance.test.ts`
- `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-memory-profile-reconciliation-fallow.json`

## Issue MPD-08: Split Tests And Document The Memory Profile Internal Seams

Triage label: `testing`

Dependencies: MPD-02, MPD-03, MPD-04, MPD-05, MPD-06, MPD-07

Reshape tests and documentation after the implementation split so future changes land at the right seam and the facade test does not remain the only safety net.

Acceptance criteria:

- `src/lib/server/services/memory-profile/index.test.ts` is reduced to facade compatibility and end-to-end Memory Profile behavior, not every internal implementation detail.
- Focused tests exist for reset generation, read model/active context, telemetry, review, dirty ledger lifecycle, legacy curation, and reconciliation.
- Route and higher-level caller tests mock narrower modules where the caller has a narrow dependency.
- `AGENTS.md` or `src/lib/server/services/AGENTS.md` records the internal Memory Profile module map and says prompt-context callers should use the active-context seam.
- Documentation says `memory.ts` remains the public Knowledge Base Memory Profile module, while `memory-profile/` owns projection internals.
- A repo search shows no broad facade import remains in prompt-context or maintenance paths where a narrower seam exists.
- Fallow and `npm run check` remain clean, with no new unused exports from the split.

Technical notes:

- Current tests are behavior-rich but concentrated in a single large file. Split only after the modules exist; moving tests too early creates churn without leverage.
- Use Context7 Vitest 4.1.6 guidance for typed `vi.mock(import(...))` when partial module mocks are needed.

Suggested verification:

- `npm run test:unit -- src/lib/server/services/memory-profile`
- `npm run test:unit -- src/lib/server/services/memory.test.ts src/lib/server/services/chat-turn/context-selection.test.ts src/lib/server/services/memory-context.test.ts src/lib/server/services/memory-maintenance.test.ts`
- `npm run check`
- `npx fallow --no-cache --format json --quiet --score --output-file /tmp/alfyai-memory-profile-deepening-final-fallow.json`

## Suggested Implementation Order

1. MPD-01: Establish shared types and reset generation.
2. MPD-02: Move active profile reads and prompt formatting behind a narrow seam.
3. MPD-03: Extract telemetry.
4. MPD-04: Extract review lifecycle.
5. MPD-05: Extract dirty ledger marking and claim lifecycle.
6. MPD-06: Isolate preserved legacy curation and its model adapter.
7. MPD-07: Extract reconciliation and update maintenance imports.
8. MPD-08: Split tests and document the seams.

MPD-02 is the first slice likely to reduce circular dependencies. MPD-06 and MPD-07 should be reviewed together before implementation because the static control-model import and maintenance import graph are the most important architectural risks.

## Open Questions To Grill Before Implementation

- Should the public facade keep re-exporting every internal function indefinitely, or should only compatibility exports remain while hot callers move to narrower seams?
- Should `memory.ts` continue to be the only public Knowledge Base Memory Profile module for routes, with all `memory-profile/*` modules considered server-internal?
- Should `legacy-curation.ts` use dynamic import for the model adapter, or should it accept an injected curator everywhere and leave the default adapter in a separate module?
- Should `recordMemoryReworkTelemetry` stay callable from many modules, or should high-level modules record domain-specific outcomes through smaller helper functions that constrain event names?
- After MPD-02, what Fallow cycle count is an acceptable intermediate target before tackling maintenance cycles outside Memory Profile?
