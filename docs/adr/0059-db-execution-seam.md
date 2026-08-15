# Query execution goes through one seam

Accepted (2026-08-15, by the repository owner, ahead of implementation). AlfyAI will route database query *execution* through a single module, and will amend the two standing conventions that previously forbade it.

`src/lib/server/db/index.ts` exports a `db` handle that 94 non-test modules import directly, producing 117 raw query call sites. Because there is no seam in front of execution, no property of execution can be changed in one place: not batching, not caching, not timing, not slow-query reporting, and not — the reason this matters most — moving work off the thread that streams every user's tokens. `better-sqlite3` is synchronous, the deployment is a single Node process, and every query therefore blocks the event loop serving every other user. The `Promise.all` fan-outs in context selection buy no wall-clock at all.

## What this supersedes

Two documented rules previously forbade this, and both are amended by this decision:

- `src/lib/server/db/AGENTS.md`: *"Do NOT create mini repository wrappers — use services + schema directly"*
- `AGENTS.md` § What Not To Reintroduce: *"No duplicate DB repository wrappers"*

Those rules remain correct as written. They target **per-table repository wrappers** — 59 thin objects mirroring 59 tables, each adding a name and no behaviour, each a shallow module by the deletion test. This decision does not introduce those and does not permit them. It introduces **one execution seam**: services continue to compose their own queries against the schema directly, and those queries are handed to a single executor. The distinction is between wrapping *what is queried* (still forbidden) and owning *how a query runs* (this decision).

Both convention documents are updated in the same change that lands the seam, so the repository does not contradict itself and a future reader is not led to revert it.

## Honest scope of the benefit

Measured on production 2026-08-15: 6 users, 607 conversations, 2 196 messages, largest conversation 89 messages. At that scale the event-loop contention this seam exists to make fixable **is not a defect users currently experience**. It is a scaling property, and this ADR should not be cited as a latency fix for the current deployment.

What the seam buys immediately is smaller and still real: one place to instrument query cost, one place to add caching, and the removal of a structural reason why 73 test files must boot a real database.

## How it lands

As a strangler, never a big-bang. The seam is introduced alongside the existing handle; call sites migrate incrementally; the direct `db` export is removed only when the last one is gone. The work is ordered after the slices that *delete* query call sites, so the surface being wrapped is smaller and settled.

A second adapter is required, not optional. One adapter makes a hypothetical seam; two make a real one. The in-memory adapter that lets tests stop booting SQLite is the proof the interface is honest.

## Considered Options

- Keep the ambient `db` handle and the two conventions as they stand.
- Introduce per-table repositories (what the conventions forbid).
- Introduce one execution seam and amend the conventions.
- Replace the synchronous driver first.

We chose the third. Keeping the handle leaves no place to change execution, which is the whole problem. Per-table repositories would add 59 shallow modules and are correctly forbidden. Replacing the driver first is the larger change and is *enabled* by the seam rather than a substitute for it — with 117 direct call sites there is nowhere to swap a driver in.

## Consequences

- `db/AGENTS.md` and `AGENTS.md` are amended in the same change. Per-table repository wrappers stay forbidden; the execution seam is named as the exception and the reason is recorded.
- Migration is incremental and reversible at every step; no slice may leave the tree with two competing execution paths for the same module.
- A second (in-memory) adapter ships with the seam, and at least one previously database-booting test suite is converted to prove it.
- **Automatic stop condition.** If the seam's own measurements show no reduction in database-booting test files and no query instrumentation in use by the time half the call sites are migrated, migration halts and the decision is re-opened. The seam must be earning its keep while it lands, not after.
- This ADR is accepted ahead of implementation. It carries more risk than the others in this programme and is deliberately ordered last.
