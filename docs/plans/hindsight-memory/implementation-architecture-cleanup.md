# Memory module ownership and job fencing

The native job handler can read curation intent, discover dependencies and settle history progress without importing the modules that admit its jobs. Source fences, SQLite transactions, native extraction and publication rules still run through their existing entry points.

| Files | Ownership |
| --- | --- |
| `memory-profile/memory-request.ts`, `curation-intent.ts`, `native-read.ts`, `curation-actions.ts` | Scope, reference and action validation is shared. Workers read stored intent without depending on action admission or UI reads. The read facade keeps its existing request exports. |
| `memory-profile/dependency-plan.ts`, `dependency-repair.ts`, `revisions.ts`, `delivery-job.ts` | The planner discovers and holds a bounded family synchronously. The worker executes the plan inside its parent attempt. Recovery reopens work through the existing registered kind. |
| `memory-profile/history-eligibility.ts`, `migration-progress.ts`, `migration.ts`, `delivery-runner.ts` | Eligibility and manifest verification can run independently of migration preparation and authority transitions. Delivery calls manifest settlement directly. |
| `chat-turn/outbound-system-prompt.ts`, `normal-chat-context.ts`, `normal-chat-control-model.ts` | Chat and control calls share a renderer that consumes prompt data alone. The renderer moved without changing its strings or assembly order. Curation uses the same configured control transport. |
| `jobs/index.ts`, `ledger.ts`, `runner.ts`, `types.ts` | Atomic enqueue transactions belong to the ledger. The facade wakes the kind after the transaction returns. Any terminal verdict in an atomic batch is announced after the full batch commits. The engine computes and commits a repair checkpoint with its domain changes after validating the claim and phase. |
| `memory-profile-types.ts`, `.fallowrc.json` | Five unused legacy client DTOs were removed. The documented migration operator CLI is an explicit entry point. |

The existing job-interface test exposed a direct database import in the facade. Moving the transaction back to the ledger keeps that check intact. The existing one-writer test exposed direct repair checkpoint writes. The new runner regression checks that the domain write and checkpoint commit together and that a failed checkpoint preparation rolls back its domain write. The test failed before the engine change and passed with the existing claim tests.

## Fallow 3.33.1

The shared-checkout audit reports one cycle. The baseline's chat file, knowledge, and memory maintenance cycle is still present. The three other baseline cycles reached control-model transport through chat context assembly: linked conversation context through the legacy judge, persona summary through legacy consolidation, and proactive connector distillation. They no longer appear after the prompt renderer extraction. All 18 additional cycles listed in [the lifecycle checkpoint](implementation-lifecycle-fixes.md#fallow-and-module-ownership) are gone. The baseline was kept intact.

The pinned gate passed in the actual shared checkout after historical executable evidence was archived. It reported **one existing cycle, zero new findings, and three baseline findings gone**. Fallow still analyzes app code and the active synthetic runners. Its configuration names 16 standalone runner or process entry points, including the provider bridge loaded as a separate Node process. The baseline is intact. The gate summary and raw report are in `/tmp/hindsight-research-archive-fallow/`. [Fallow entry point configuration](https://fallow.tools/docs/configuration/overview/)

The earlier checkout audit had 179 findings under historical research, including five unresolved imports of a scratch helper. A diagnostic tree without the research had one existing app cycle. The original logs are in `/tmp/hindsight-architecture-fallow-final/` and `/tmp/hindsight-architecture-projection.json`.

## Verification

The broader Node 22 run passed **930 tests across 47 suites**. The live-native acceptance suite was explicitly disabled. It covered native lifecycle, migration, account erasure, archive, source cleanup, the job engine, normal chat context, control transport and reply-language and English scaffold invariants. The log is `/tmp/hindsight-architecture-final-tests.log`. The checkpoint regression's failing run is `/tmp/hindsight-architecture-checkpoint-red.log`.

After the atomic verdict change, the engine and four lifecycle suites passed **401 tests across 16 suites**. The new regression first showed a settlement listener getting an event for a job that the batch rolled back. The final test log is `/tmp/hindsight-architecture-engine-final.log`, and the failing run is `/tmp/hindsight-architecture-enqueue-red.log`. The final typecheck reported **0 errors and 0 warnings** in `/tmp/hindsight-architecture-typecheck-final.log`. Scoped Biome and `git diff --check` passed.

The official [Drizzle transaction docs](https://orm.drizzle.team/docs/transactions), [Vitest test API](https://vitest.dev/api/test), [Fallow configuration docs](https://fallow.tools/docs/configuration/) and [AI SDK transport API](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text) were checked.

## Research evidence inventory

A temporary copy identified 132 command or process entry paths, 37 imported modules and five unused historical source snapshots. The archived `native-quality-followup/common.cjs` has the same SHA-256 as the scratch helper used by the five correction scripts. With the fixture JSONs, exact entries and relative imports eliminated all unresolved imports in the trial. The same trial still reported 52 research findings: an orphaned helper, 47 unused helper exports and four duplicate export groups. Its raw report is `/tmp/hindsight-research-exact-entry-proof-with-fixtures.json`. Lists of candidate entry points, modules and snapshots are in `/tmp/hindsight-research-exact-entry-inventory.txt`, `/tmp/hindsight-research-module-inventory.txt` and `/tmp/hindsight-research-snapshot-inventory.txt`.

The archive preserves 185 historical source files from 18 evidence groups, plus one synthetic replay input recovered from the earlier benchmark. Extraction reproduced all 186 paths and SHA-256 hashes. The bounded-update offline replay passed its 12 assertions after extraction. The archive documents how to restore the exact historical scratch helper and fixtures without editing the original source. [Archive and replay instructions](research-source/README.md)
