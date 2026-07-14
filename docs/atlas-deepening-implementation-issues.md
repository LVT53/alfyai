# Atlas deepening — implementation issues

Implements [ADR-0053](adr/0053-atlas-post-migration-deepening.md). Four deepening candidates, sequence **1 + 4 → 2 → 3**. No external-behaviour change, no table/migration change. Discipline: subagent-driven TDD → review/audit → correctness judge → deploy. Commit after every wave (Nextcloud revert hazard). Vocabulary: `/codebase-design` (module, interface, depth, seam, leverage, locality) + CONTEXT.md Atlas domain terms.

## Wave 1 + 4 — Atlas Source Acquisition module + dead-surface deletion  ·  status: pending (blocked by Workstream A deploy)
Candidate 1 (deep seam):
- [ ] New `Atlas Source Acquisition` module: `acquireWebSources(queries, policy)` owning search → enrich → converge → dedup; convergence + URL-dedup live once.
- [ ] Delete the dead SearXNG SERP scrubbing in `search.ts` (Naptár/Keresés/Beállítások keywords, Hungarian+English language-filter echoes, YouTube prefix+footer array, Hungarian date prefixes) and its SearXNG-shaped tests; keep only provider-agnostic hygiene (login/auth title reject; generic cookie/JS banners if retained).
- [ ] Collapse the triple config path (`input.config` / `input.deps.config` / global `getConfig()`) to one; drop the test-only `AtlasSearchDeps.config`.
- [ ] Move `sanitizeSourceTitle` out of `renderer-output.ts` into a neutral text util so acquisition no longer imports the renderer.
- [ ] Split retry policy: Brave image path keeps rate-limit protection; Parallel text path drops the inter-batch pacing it no longer needs.
- [ ] Remove the duplicated `convergeGapFillWebSources`/`canonicalWebSourceUrlKey` from `pipeline.ts`; pipeline consumes acquisition output without re-deduping.
Candidate 4 (dead surface):
- [ ] Fold `intake.ts` into its caller (`index.ts`/`job-ledger.ts`); delete `kickoffAtlasTurn` + `buildAtlasKickoffAssistantMessage` (dead outside tests).
- [ ] Re-scope `ATLAS_SEARCH_CONCURRENCY`/`ATLAS_SEARCH_BATCH_DELAY_MS` as image-path throttles (retain wiring, correct docs/comments + admin-UI copy).
- Acceptance: one source shape into pipeline; zero SearXNG SERP-artefact code/tests; `search` no longer imports `renderer-output`; typecheck + Atlas tests green.

## Wave 2 — Atlas Stage Runner seam  ·  status: pending (blocked by Wave 1+4)
- [ ] Extract `runStage(stage, { progress, buildPrompt })` owning heartbeat + `stageSystem` binding + model call + usage folding.
- [ ] Replace the ~9 copy-pasted `heartbeat → runModelStage → addUsage` triples in `pipeline.ts` with `runStage` calls; move magic progress numbers into one progress model.
- [ ] Merge `model-stage.ts`'s two exports (`runAtlasModelStage`/`runAtlasAuditStage`) — audit is a different system prompt.
- Acceptance: no per-stage usage-accumulator threading; progress model in one place; typecheck + Atlas tests green.

## Wave 3 — Assembled-report normalization module  ·  status: pending (blocked by Wave 2)
- [ ] Relocate the ~1,600 lines of report-shape/repair heuristics (`pipeline.ts:1471–2333`) into a deep module co-located with `writer`/`report-shape-diagnostics`.
- [ ] `pipeline.ts` calls one `finalizeAssembledReport()`; the repair heuristics get their own test surface.
- Acceptance: `pipeline.ts` sheds ~half its length; no behaviour change vs `pipeline.test.ts`; typecheck + full Atlas tests green.

## Wave Atlas-audit — review/audit + correctness judge  ·  status: pending
- [ ] Parallel review subagents over the Atlas diff; fix confirmed findings; separate scope/correctness judge; loop if fail.

## Wave Atlas-deploy — deploy + verify  ·  status: pending
- [ ] test + typecheck green; commit; deploy via `scripts/deploy.sh`; run one Atlas job end-to-end (kickoff → report) as a smoke test.
