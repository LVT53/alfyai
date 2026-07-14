# Atlas is deepened along four module seams after the Parallel migration, not left as-is

> Builds on [ADR-0036](0036-atlas-is-normal-chat-turn-not-parallel-subsystem.md) (Atlas is a Normal Chat Turn + single background worker) and [ADR-0052](0052-replace-searxng-web-research-with-parallel-search.md) (SearXNG replaced by Parallel Search/Extract). This ADR does **not** re-litigate either decision. It records a set of internal deepening refactors that leave Atlas's external behaviour and its two owned tables unchanged.

## Context

The SearXNG→Parallel migration (ADR-0052) reshaped Atlas's search layer in place but left several seams half-reshaped. A design review (2026-07-14) found the Atlas cluster is structurally healthy — a clean DAG with `types`/`config` as leaf hubs, `worker-runner` as the composition root, and most stage modules (`evidence-packs`, `quality-gates`, `claim-basis`, `renderer-output`, `json-extract`) genuinely **deep**. The friction is concentrated in four places, all traceable to the migration:

1. **Source convergence is implemented twice** — once in `atlas/search.ts` (`convergeSources`, `normalizedSourceUrlKey`) and again in `atlas/pipeline.ts` (`convergeGapFillWebSources`, `canonicalWebSourceUrlKey`), over two different source shapes (`AtlasSearchSource` → `AtlasPipelineWebSource`). `search.ts` also still scrubs SearXNG SERP artefacts (YouTube-footer regexes, Hungarian date prefixes, "Nem tartalmazza / Excluding" language-filter echoes) that Parallel's clean excerpts never produce, resolves the Parallel key through three paths (`input.config`, `input.deps.config`, global `getConfig()`), and reaches into the 2,088-line `renderer-output.ts` for one string helper (`sanitizeSourceTitle`).
2. **`pipeline.ts` is a 3,204-line orchestrator that is ~5% orchestration** — every model stage repeats a `heartbeat → runModelStage → addUsage` triple (~9 sites) with hand-tuned magic progress numbers and a manually threaded usage accumulator, and ~1,600 lines of "make the model output well-formed" report-shape/repair heuristics live inside it, doing the writer's quality-control job.
3. **Shallow / dead surface** — `atlas/intake.ts` is a 20-line pass-through that fails the deletion test; `index.ts`'s `kickoffAtlasTurn` is dead outside tests; `model-stage.ts` exports two near-identical functions (`runAtlasModelStage`/`runAtlasAuditStage`) differing only in a system prompt.
4. **Vestigial config** — `ATLAS_SEARCH_CONCURRENCY` / `ATLAS_SEARCH_BATCH_DELAY_MS` and the retry/backoff/50%-abort machinery were tuned for SearXNG's fragile rate-limited engines; Parallel Turbo is robust under load, so the machinery is over-provisioned for the text path but still load-bearing for the rate-limited Brave image path.

## Decision

Deepen Atlas along four candidates, as one documented program, in the sequence **1 + 4 → 2 → 3** so each seam is clean before the next refactor depends on it. No candidate changes Atlas's external interface, its `atlas_jobs`/`atlas_round_checkpoints` tables, its profiles, or its quality-gate contract.

1. **Atlas Source Acquisition module (deep).** Collapse `search.ts`'s search→enrich→converge→dedup and `pipeline.ts`'s gap-fill convergence into one module behind a narrow `acquireWebSources(queries, policy)` interface. Convergence and URL-dedup live once. Delete the dead SearXNG SERP scrubbing. Collapse the triple config path to one. Move `sanitizeSourceTitle` to a neutral text util so acquisition stops depending on the renderer. Split the retry policy so the Brave image path keeps its rate-limit protection while the Parallel text path drops the inter-batch pacing it no longer needs.
2. **Atlas Stage Runner seam (deep).** Extract `runStage(stage, { progress, buildPrompt })` owning heartbeat + `stageSystem` binding + model call + usage folding. The ~9 copy-pasted triples become one-liners; the magic progress numbers become one progress model; `model-stage.ts`'s two exports merge (audit is a different system prompt).
3. **Assembled-report normalization module (deep).** Relocate the ~1,600 lines of report-shape/repair heuristics out of `pipeline.ts` into a module co-located with `writer`/`report-shape-diagnostics`; `pipeline.ts` calls one `finalizeAssembledReport()`.
4. **Delete the shallow/dead surface.** Fold `intake.ts` into its caller; delete `kickoffAtlasTurn`; re-scope the `ATLAS_SEARCH_*` knobs as image-path throttles (retain wiring, correct the rationale/docs).

Implementation follows the project's subagent-driven TDD + review-audit + correctness-judge discipline, committing after every wave (the repo is under a Nextcloud sync that silently reverts half-edited files). CONTEXT.md gains the new module names (**Atlas Source Acquisition**, **Atlas Stage Runner**, **Atlas Assembled-Report Normalization**) as they are introduced.

## Considered Options

1. **Deepen along these four seams (chosen).** Locality and testability win concentrated exactly where the migration left friction, with no external-behaviour risk.
2. **Leave Atlas as-is.** Rejected: the duplicated convergence and the dead SearXNG scrubbing are a live correctness/maintenance hazard (two places to fix a dedup bug; green tests asserting SearXNG artefacts Parallel never emits), and `pipeline.ts` keeps absorbing new stage logic.
3. **One big rewrite of `pipeline.ts`.** Rejected: the stage modules are already deep and the DI composition in `worker-runner.ts` is sound; a rewrite would risk the frozen quality-gate/checkpoint behaviour for no structural gain over targeted deepening.

## Consequences

- `pipeline.ts` shrinks toward pure orchestration; report-shape and source-acquisition knowledge each concentrate in one deep module with its own test surface.
- Tests move off SearXNG-shaped fixtures onto Parallel-shaped ones; the deleted scrubbing removes ~120 lines that only ever matched dead inputs.
- The Brave image path keeps its rate-limit protection; only the Parallel text path sheds the pacing it no longer needs.
- Candidate 3 is the largest and riskiest (its heuristics are covered by the 8,124-line `pipeline.test.ts`); it is sequenced last, after the stage-runner seam is clean.
- No migration, no table change, no change to the Atlas kickoff/send route, availability gate, or privacy lifecycle.
