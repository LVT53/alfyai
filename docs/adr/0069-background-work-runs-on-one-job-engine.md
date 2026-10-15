# Background work runs on one job engine

Accepted (2026-10-15). The owner chose the work on 2026-10-14 ("a structured API") and pre-approved the plan on 2026-10-15; the storage choice below is the designer's, made under that approval. The design is [`docs/plans/jobs-merge/design.md`](../plans/jobs-merge/design.md).

## Context

AlfyAI has three kinds of durable background work: Atlas research jobs, document extraction and file production. Each owns a copy of the same lifecycle: create or reuse, claim with a lease, heartbeat, progress, complete, fail, retry, cancel, stale recovery, dead-worker reclaim, the in-process scheduler (wake, drain, idle tick, boot sweeps) and waiting for a verdict. About 6,250 lines across `atlas/`, `extraction/` and `file-production/`, which Fallow reports as mirrored directories with a 215-line clone between two ledgers.

The copies have drifted. Fixes that landed in one or two kinds never reached the third: Atlas has no attempt rows (so no fencing token), no stale sweep while serving, no dead-worker reclaim, a wake that is dropped during a drain, a scheduler that duplicates under HMR, and a lost worker's job is requeued without limit. Extraction spells `canceled` where the others spell `cancelled` and stores its progress phase in its status column. Two lifecycle writers live outside any ledger (extraction's Re-extract and the file-production fork reconciler). The next background feature (scheduled tasks was discussed) would add a fourth copy.

Two facts about the deployment constrain the answer. Deploys run `db:prepare` while the previous release keeps serving and claiming for up to two minutes (step 7b drains streams before the cutover), so a migration must be one the old process survives. And outside the three folders the job tables are queried directly by six server modules, two scripts, seven e2e specs and about 45 unit-test files.

## Decision

All background work runs on one deep module, `src/lib/server/services/jobs/`. A kind is defined once (its tables, enable switch, caps, lease, claim condition, phases, failure policy, Retry rule, handler); callers use a small interface (`enqueue`, `cancel`, `cancelAll`, `retry`, `reopen`, `wake`, `waitForVerdict`, `runInline`, `recover`, `describeJob`, `startJobs`). Every lifecycle transition and every scheduling decision lives in the engine and nowhere else; a source scan enforces it.

Each kind keeps its own jobs and attempts tables, built from the engine's column builders so they share one lifecycle shape (`queued`, `running`, `succeeded`, `failed`, `cancelled`, plus phase, priority, run-after, attempts, fencing, checkpoint and retry-policy state). Legacy SQL column names stay; only additive columns are added, and extraction's status words are the one data rewrite, re-applied once at startup by `db/compat.ts` for rows the old process writes in the deploy window. Kinds move one at a time: engine, then Atlas and extraction, then file production.

Every failure, whether a handler reports it, throws it, or the engine takes a stale, dead or lost attempt back, goes through the kind's one pure `onFailure` policy. File production never retries by itself (ADR-0005 stands); extraction keeps its backoff and outage policy; Atlas requeues a lost attempt at most three times.

## Options considered

| | One shared `jobs` table | Per-kind storage adapters | One engine over per-kind tables (chosen) | Leave three copies |
|---|---|---|---|---|
| Lifecycle code copies | 1 | 3 (SQL behind adapters) | 1 | 3 |
| Data migration | copy every row, plus a startup top-up for the deploy window | none | extraction's status words only | none |
| Readers outside the folders | every one becomes a join | unchanged | unchanged | unchanged |
| Rollback | a data restore | code | code (extraction: one reverse SQL file) | n/a |
| A new kind needs | a definition (and maybe a detail table) | a definition, a table, an adapter | a definition and a table from the builders | a fourth copy |

**One shared `jobs` table** (what the planning session leaned towards) gives the simplest engine and one place to see all work, but its migration cannot be done in SQL alone because of the deploy window, it turns every reader and fixture into a join, needs triggers to stay 1:1 with three tables that cascade differently, and makes rollback a data restore.

**Per-kind storage adapters** keep the data but leave each kind writing its own claim, heartbeat and recovery SQL: the copies remain, renamed.

**Leaving the copies** keeps paying for every lifecycle bug three times and guarantees a fourth copy.

## Consequences

- A lifecycle fix is made once and every kind gets it; Atlas gains every fix it lacked.
- A new kind is a definition and a table; no lifecycle code is written.
- The engine is generic over table pairs, so its typing is more involved than a single-table engine; the design names the technique.
- The three tables stay separate: there is no single SQL view of all work. If one is ever needed (an admin page, a payload-only kind), a generic table can be added as one more binding without changing the interface.
- Extraction's stored status words change; its DTO and the browser do not. Its rollback needs a reverse SQL file, kept next to the plan.
- Dead columns (Atlas's job-level `worker_id` and `heartbeat_at`) and the startup shim are removed in a later cleanup, after production has run the release.
- `services/jobs/AGENTS.md` records the rules: one writer of lifecycle columns, no transaction across an `await`, expand-only migrations, every failure through `onFailure`.

## Action items

1. [ ] S1: the engine with a test kind; Opus review of leases, fencing, recovery and scheduling.
2. [ ] S2: Atlas on the engine. S3: extraction on the engine (with the shim and the reverse SQL).
3. [ ] S4: file production on the engine, after coordinating with the upload-analysis work.
4. [ ] Opus review of the migrations, the shim and the rollbacks; release gate; deploy to ai.dev; live checks.
5. [ ] Later: drop the dead columns and the shim after production runs the release; ADR-0005 gets an implementation note that its worker runs on this engine.
