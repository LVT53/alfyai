# Task 7 implementation checkpoint

Owner-authorized code and synthetic testing only. No real user/chat inspection, real migration/cutover, deployment, or push was performed. No commits created. This checkpoint needs fresh independent review and the whole-plan acceptance gates; it is not production migration approval.

## Implemented

- One `migration.ts` boundary owns read-only inventory, prepare/resume, verification, per-user cutover and privacy-safe rollback. It uses existing `memory_migration_manifests`, source/action records and the existing Memory job engine; no new tables, scheduler, extractor or semantic provenance resolver.
- Inventory resolves explicit message/conversation/item/provenance references, inventories review-only removals and accept intent, preserves verified standalone/review-authored statements and dates, excludes generated endorsements as seeds, and accounts for fork copies, known privacy boundaries, missing sources and missing original edit dates. Unknown exclusion boundaries hold historical backfill; bounded exceptions hold affected sources. Later genuinely new assertions remain eligible.
- Known removal/edit actions become durable bounded curation intents tied to native source revisions, replayed through the existing shared curation path before publication. Synthetic wire tests demonstrate omission of the removed bicycle statement while preserving the independent dog statement. Review-authored corrections retain a separate original-dated source. Unrecoverable pre-edit statements are honestly held rather than fabricated.
- Preparation records the current on/off interval prospectively, copies only eligible sources, packs bounded permission-linked context references, records original dates/event identities, revokes stale source revisions, and atomically checkpoints intents with delivery jobs. Resubmission uses existing stable jobs/native operation IDs; changed legacy actions receive a distinct replay checkpoint. Cutover compares the full source/action/privacy snapshot inside the SQLite write barrier. Missing accepted checkpoint rows cannot be called complete.
- Native preparation stays inactive while the legacy reader remains authoritative. Live acceptance/ingestion understands preparing accounts. All legacy projection mutation doors now check authority in the same transaction as the write, including summaries and metadata; a paused actual legacy judge's late model result cannot write after cutover.
- Empty-bank provision is an existing-engine job phase, so users can activate the native system without consenting to uncertain old history. Native configuration/capability and stable service-binding checks remain mandatory. The optional history choice is available during preparation and after cutover; include/decline resumes the manifest, and historical permission is rechecked at the dispatch/publication boundary.
- Terminal worker progress updates the manifest's honest prepared/failed/held status. Native jobs retain their existing lifecycle/retry ownership. Repeating cutover cannot renew the rollback baseline. Rollback preserves post-cutover privacy/actions/source choices by refusing unsafe legacy restoration, with a recorded 30-day retention window and no automatic destructive purge.
- `scripts/memory-backfill.ts` is the single production-capable entrypoint. Default inspect requires an explicit database/user and prints counts only; mutations require explicit execution acknowledgement. Synthetic fixture mode adds temporary-path/marker/account checks. Both denied and positively acknowledged real-mode CLI paths are tested only against temporary synthetic SQLite databases.
- `HINDSIGHT_NEW_ACCOUNTS_ENABLED=false` is a separate environment-only rollout default. Genuine new admin-created accounts atomically receive opaque native authority and a known control interval when enabled. Existing users remain legacy without explicit migration. Signup/account creation does not call native services, and worker pause/outage cannot silently select legacy authority. Public env/setup documentation includes the rollout setting.

## Evidence and limits

Focused command (Node 22):

```sh
npx vitest run src/lib/server/services/memory-profile/migration.integration.test.ts src/lib/server/services/memory-profile/migration-policy.test.ts src/lib/server/services/memory-profile/chat-delivery.test.ts scripts/memory-backfill.test.ts src/lib/server/services/user-admin.default-model.test.ts src/lib/server/services/user-admin.password.test.ts
```

The latest completed focused run before the final binding regression passed 43 tests in six suites. The subsequent final result is recorded below. Tests use actual migrated SQLite and existing job claims/handlers. Native HTTP and curation replies are explicit deterministic fixtures: this proves app state/ordering/fencing/curation plumbing, not native semantic quality, throughput, or backup/restore acceptance. Shared foundation/native-operation tests own lost native acknowledgements and actual backend lifecycle; integrated real-native synthetic EN/HU and full gates remain required.

A targeted Biome pass is clean on owned migration, CLI, legacy writer and user creation files. Full `svelte-check` runs during implementation found no remaining diagnostics in those files; concurrent curation/dependency/security fixture diagnostics were reported to the orchestrator. No build, Fallow, full gate or e2e run was executed by this worker, per the orchestrator's single-final-gate ownership.

Official current [Drizzle transaction documentation](https://orm.drizzle.team/docs/transactions) and [Vitest guide](https://vitest.dev/guide/) were checked because framework MCP docs tools were unavailable.

## Required next review

Fresh independent review should inspect replay after legacy action changes, unknown/bounded provenance distinctions, immutable action time and history cutoffs, repeated cutover/rollback checkpoints, late legacy model writes, native service-binding preservation, genuinely new account selection, and CLI guard behavior. The [runbook](migration-runbook.md) separates implementing real execution from authorization to execute it. No acceptance percentage is asserted here.

Final checkpoint verification: **44 tests passed in six suites** (27 migration integration cases plus policy/chat-delivery/CLI/user-admin regressions). Final full `svelte-check`: **0 errors, 0 warnings**. Logs: `/tmp/migration-final-tests.log`, `/tmp/migration-final-check.log`. This is verification evidence, not independent approval or whole-plan acceptance.
