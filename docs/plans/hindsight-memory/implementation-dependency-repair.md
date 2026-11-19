# Submitted source dependency repair — implementation checkpoint

2026-11-18. Authorized synthetic implementation only. No deployment, service startup, real-user processing or migration. This checkpoint requires a fresh independent judge and actual native/model acceptance; deterministic extraction fixtures are not semantic acceptance.

## Responsibility and interfaces

`memory-profile/dependency-repair.ts` is a finite parent-mutation protocol, not a semantic graph engine. It follows only stored `context.messages[].sourceId` dependencies in the authenticated bank and epoch. Discovery rejects a closure over 64 sources before holding anything. Already-submitted descendants are held; unsent work remains owned by ordinary live dispatch checks. Topological ordering rejects cycles. No per-property facts, new extractor, queue, table or schema were added.

- `holdExplicitDependents(tx,userId,bankId,epoch,roots)` performs bounded discovery and immediate read withholding. Source revocation invokes it inside its transaction. Remove intake creates its saved plan in the same transaction as acknowledgement.
- `createDependencyRepairPlan(...)` allocates original/replacement source IDs and native operation IDs and captures acknowledged original facts for the final preservation check. Remove saves the immutable initial plan in existing action intent; the existing parent job checkpoint records progress. Retry/reopen preserves those identities.
- `runDependencyRepair(ctx,client,native,{rootSourceIds,memories,replay,verify})` uses the caller's existing native settle/complete capture functions. It settles original submissions, deletes obsolete documents with readback, re-retains original user assertions with original assertion/edit dates and new source/native operation identities, and invokes shared curation replay with an explicit predecessor mapping. Context contains sanitized currently verified native facts labeled prior memory; original parent quotations and assistant wording are not reused.
- The helper returns complete `memories`, replacement `sourceIds`, durable `originalFacts`, and a synchronous `apply(tx)`. Callers run that apply before strict whole-bank publication in their existing final success transaction. Source and action runners use the shared check-only final curation verification over the finite family; no extra planner, extraction model or repair loop was introduced.
- `resumeDependencyRepairs(userId)` uses existing engine `reopen(...,keepCheckpoint:true)` for settled privacy obligations and domain control rebinding for queued/running ones. It only considers source cleanup or acknowledged Remove, checks current bank/epoch/owner/source eligibility and held originals, and binds the new control revision. Cancelled learning and cancelled/failed Edit are not authorized by this path.

Future accepted-source context resolution also uses sanitized acknowledged facts instead of the old raw chat wording. The delivery runner defers source acknowledgement changes until replay readback and final publication, preserving the prior accepted snapshot on failed preparation.

## Off, failure and boundedness

Source cleanup and acknowledged Remove obligations survive broad off cancellation. Off performs reconciliation/deletion only. The curation wrapper detects off before planning and on mid-run failure, and passes the saved finite repair to cleanup without invoking a model or retain. A native replacement write already in flight is settled and deleted; only after verified deletion is a new stable operation identity saved for eventual enable. A paused job stays retryable with exclusion acknowledged and cleanup pending. The original dates and saved curation intent survive enable/retry.

An overflow during preflight rejects the mutation atomically. An overflow discovered after a prior mutation is already committed fences the bank as `repair_blocked`; reads/publication fail closed, independent native/local data remain intact, and the job records `memory_dependency_limit`. This is an honest held exception requiring resolution, not a complete removal or silently partial ready state. Reset/account/project fences obsolete the plan rather than reenrolling old sources.

The 64-source bound is a repair admission bound, not a throughput claim. Native operation timeouts, job admission and native request concurrency remain the existing owners' responsibility.

## Evidence

Official Drizzle transactions and Vitest test API documentation were consulted because no relevant docs MCP was available.

- Initial red tests failed because the repair module did not exist. Exact direct/transitive withholding and bounded atomic overflow then passed.
- Final focused run: **6 suites / 61 tests passed**, `/tmp/memory-dependency-final-tests.log`. Eleven repair tests use migrated synthetic SQLite databases and the actual job engine with a simulated native HTTP service. Other suites cover curation, delivery, source intake, history controls and strict publication.
- Repair fixtures cover direct/transitive restoration, independent facts, original dates, deleted-context omission, stable document/operation identity after lost acknowledgement, actual late native writes after reset, off-before-repair and off-mid-write, automatic queued resume and terminal reopen, no promotion of unsent sources, preflight overflow and post-mutation fail-closed overflow.
- An actual **Remove-kind** job is paused during its replacement POST, then Memory is disabled. Its late native document is cleaned, the independent sister fact remains, no further model call occurs while off, exclusion stays acknowledged/cleanup pending, and enable resumes the same parent intent successfully. This is distinct from the source-cleanup fixture.
- Scoped Biome checks clean. Whole-worktree `npm run check`: **0 errors / 0 warnings**, `/tmp/memory-dependency-typecheck.log`. No build/full gate/Fallow run by this worker.

## Review and acceptance still required

Fresh independent review must examine cross-protocol interaction, especially saved Remove intent versus job checkpoint, multiple source actions, source edit followed by dependency replay, cancellation/lost lease between native writes, and control rebind races. The synthetic native service deliberately implements simple deterministic extraction; it cannot establish independent-fact preservation or attribution for short dependent replies in EN/HU. Native operations owns those real model probes, restart/outage acceptance and capacity evidence.

Module footprint at this checkpoint: 667 lines of repair implementation and 609 lines of repair tests, plus narrow integration changes in revisions, delivery runner and the enable/off boundary. Curation hooks and final shared semantic checks were coordinated with the curation worker; they remain in its existing module. The footprint is reported rather than disguised as a tiny patch. No overall feature-complete or release-ready claim is made.
