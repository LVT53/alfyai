# Memory part 4: model access that waits, jobs that wait for Hindsight — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Memory model calls wait in a bounded, fair queue instead of failing with 429; delivery jobs wait for Hindsight's own operation state without spending attempts; the tester is excluded from every migration by a stored flag; four canonical operator tools replace the rollout's hand-run scripts.

**Architecture:** The admission gateway's ordering and bounds move into a stdlib-only Python module (`alfyai_admission_queue.py`) behind the existing FastAPI adapter, so the gate runs its tests on the Mac. The app declares each memory call's class in three headers from `createCurationModel`. Delivery waits poll Hindsight in five-minute slices; a slice that ends while Hindsight still works requeues the job under a waiting code the kind's pure failure policy does not count, bounded by config-store totals. The tester flag is a `users` column set by migration 141 and read by one guard.

**Tech Stack:** SvelteKit server code (TypeScript, Node 22), SQLite with Drizzle (hand-numbered migrations), the job engine in `services/jobs/` (ADR-0069), vitest; Python 3.12 (image) / 3.12+ (Mac) with `unittest` and `asyncio`.

**Spec:** `docs/superpowers/specs/2026-11-22-memory-redesign-design.md`, §4, §5 ("The permanent tester rule"), "Testing and acceptance" (Infrastructure), "Left to the builder".

## Global Constraints

- Migrations 141 and 142 are this part's (part 3 may take 143 and 144). Hand-numbered: `drizzle/1777140000141_*.sql`, journal `when` = the number, expand-only.
- `tester@tester.com` is excluded from every Memory migration, forever. Ordinary operation (delivery, bank configuration for new facts) never calls the guard.
- Synthetic test data only; no production reads; no box access; no push; no merge into `main`.
- Native fan-out stays 1 (`HINDSIGHT_API_LLM_MAX_CONCURRENT`) and engine retries stay 12 (`HINDSIGHT_API_LLM_MAX_RETRIES`).
- Runtime settings follow the root AGENTS.md 4 steps: `env.ts`, `config-store.ts`, admin registry with English and Hungarian labels, README + `.env.example` (+ `docs/configuration.md`).
- Everything the app writes into a model request is English (ruling 79). Operator tools print counts and ids only, never memory text.
- `npm run check` 0/0, build 0 warnings, Fallow no new finding, no test skipped, loosened or deleted.
- Commits small, each with the trailer `Memory-Part-4-Task: N`.

## Review Focus

1. A queued call whose client gives up (Hindsight's own LLM timeout, the app's abort) must leave the queue at once and never be admitted later (a ghost admission would hold the only slot).
2. The overnight budget of six must drop to one for calls admitted from the queue as soon as the activity signal is stale or someone chats: a waiter admitted later must use the current signal, not the one it arrived with.
3. A job requeued by a waiting slice re-runs its whole prefix: an acknowledged retain must not be POSTed again (Hindsight forgets operation receipts; a re-POST after that re-extracts the document under new fact ids).
4. An operator tool pointed at a job that is running, queued, or belongs to another user must refuse without writing.
5. A retain resubmission must never leak its bookkeeping into the context Hindsight's model reads, nor lose a real chat envelope's keys.

Each line is pinned by a test in its task (Task 2 step 1 tests 4 and 6; Task 3 step 1 "never re-posts an acknowledged retain"; Task 5's refusal tests; Task 4's S3 tests).

---

## Task 1: The permanent tester rule

**Files:**
- Create: `drizzle/1777140000141_users_memory_migration_excluded.sql`, `src/lib/server/services/memory-profile/migration-guard.ts`, `src/lib/server/services/memory-profile/migration-guard.test.ts`
- Modify: `drizzle/meta/_journal.json`, `src/lib/server/db/schema.ts` (`users`), `scripts/prepare-db.ts` (`requiredExistingColumns`), `src/lib/server/services/memory-profile/delivery-job.integration.test.ts` (ordinary delivery is not guarded)

**Interfaces:**
- Produces: `users.memoryMigrationExcluded` (`memory_migration_excluded`, integer boolean, NOT NULL, default false); `memoryMigrationGuard(userId: string, database?: Pick<typeof db, "select">): { allowed: true } | { allowed: false; reason: "excluded" | "unknown_account" }`; `MEMORY_MIGRATION_EXCLUDED = "memory_migration_excluded"` (the refusal code).

- [ ] Write `migration-guard.test.ts`: on a migrated fixture database, (a) migration 141's SQL sets the flag on a user whose email is `Tester@Tester.com` (case-folded) and on no other; (b) the guard answers `{ allowed: false, reason: "excluded" }` for that user, `{ allowed: true }` for another, `{ allowed: false, reason: "unknown_account" }` for a missing id; (c) after the tester's email changes, the guard still excludes them (keyed by id).
- [ ] Run it: fails (no column, no module).
- [ ] Migration: `ALTER TABLE users ADD memory_migration_excluded integer DEFAULT false NOT NULL;` then `UPDATE users SET memory_migration_excluded = 1 WHERE lower(email) = 'tester@tester.com';` (statement breakpoint between). Journal idx 154, `when` 1777140000141. Schema column. `prepare-db.ts` required column.
- [ ] Guard reads only the flag by id (never the email).
- [ ] Add to `delivery-job.integration.test.ts`: a source delivery for a flagged account succeeds (delivery is ordinary operation).
- [ ] Run `npx vitest run src/lib/server/services/memory-profile/migration-guard.test.ts` and the delivery file; `npm run check:migrations`. Commit.

## Task 2: A queuing admission gateway, and how a caller declares its class

**Files:**
- Create: `deploy/hindsight/alfyai_admission_queue.py` (stdlib only), `deploy/hindsight/test_admission_queue.py` (stdlib only), `src/lib/server/services/memory-profile/admission.ts`, `src/lib/server/services/memory-profile/admission.test.ts`
- Modify: `deploy/hindsight/alfyai_admission.py` (adapter), `deploy/hindsight/test_admission.py` (the `Budget` tests move to the pure file), `deploy/hindsight/Dockerfile` (COPY the new module), `deploy/hindsight/compose.yaml` (comments), `deploy/hindsight/README.md` ("Background admission"), `src/lib/server/services/memory-profile/curation.ts`, `curation-runner.ts`, `curation-config.test.ts`

**Interfaces:**
- Produces (Python): `PRIORITIES = ("interactive", "background")`; `SOURCES = ("native", "app")`; `admission_limit(signal, now_ms) -> int` (6 only for a fresh ≤2 s, healthy, idle, inactive signal; else 1, exactly today's rule); `class AdmissionRefused(Exception)` with `.reason` in `{"queue_full", "wait_exceeded"}`; `@dataclass Ticket(priority, source, lane, max_wait_s)`; `ticket_from_headers(headers, *, native_wait_s, max_wait_s) -> Ticket`; `class AdmissionQueue(*, max_waiting, limit: Callable[[], int], clock=time.monotonic)` with `async acquire(ticket, *, abandoned=None, refresh=None, tick_s=1.0)`, `release(elapsed_ms=0)`, `status() -> dict`.
- Produces (headers): `X-AlfyAI-Admission-Priority` (`interactive` | `background`), `X-AlfyAI-Admission-Lane` (32 hex characters), `X-AlfyAI-Admission-Wait-Ms` (integer). A call without the priority header is Hindsight's own (`native`, lane `native`, wait `admission_native_wait_s`).
- Produces (extension env): `HINDSIGHT_API_HTTP_ADMISSION_MAX_WAITING` (32), `HINDSIGHT_API_HTTP_ADMISSION_MAX_WAIT_S` (900, caps every declared wait), `HINDSIGHT_API_HTTP_ADMISSION_NATIVE_WAIT_S` (600).
- Produces (TS): `type MemoryAdmissionPriority = "interactive" | "background"`; `interface MemoryAdmission { priority: MemoryAdmissionPriority; tenantId: string | null }`; `MEMORY_ADMISSION_WAIT_MS = { interactive: 120_000, background: 600_000 }`; `memoryAdmissionHeaders(admission): Record<string, string>`; `memoryAdmissionFor(userId, priority, database?): MemoryAdmission`; `createCurationModel(signal, beforeDispatch?, admission: MemoryAdmission = { priority: "background", tenantId: null })`.

Order (the "Left to the builder" mechanics): every `interactive` waiter before any `background` one; within a priority, round-robin between the sources that have waiters (native, app), and within a source round-robin between lanes (one lane per tenant; all native calls share one lane), FIFO within a lane. A waiter is admitted only while `active < limit()`. The adapter refreshes the activity signal (at most once a second) on each waiting tick, so a waiter admitted later uses the current signal. A waiter leaves at once when `abandoned()` is true (client disconnected) or its wait passes `min(declared, max_wait_s)` (`wait_exceeded`); a full queue refuses at once (`queue_full`). The adapter answers both refusals with 429, `Retry-After: 5`, and a detail naming the bound. Interactive can starve background only while interactive calls keep arriving; they are person-initiated and rare.

- [ ] Write `test_admission_queue.py` (unittest + `IsolatedAsyncioTestCase`, fake clock where useful): 1 `admission_limit` keeps every case of today's `Budget` tests (moved, not dropped); 2 a call waits instead of being refused while the slot is busy, and is admitted when it frees; 3 interactive overtakes earlier background waiters; 4 an abandoned waiter leaves and is never admitted, and the slot goes to the next; 5 native and app alternate, and two app lanes alternate (A1 A2 A3 B1 → A1 B1 A2 A3 order within app); 6 a waiter admitted after the limit dropped respects the new limit (six admitted under idle, signal goes stale, the seventh waits until active < 1); 7 `wait_exceeded` after the declared wait, `queue_full` at `max_waiting`; 8 `ticket_from_headers` (no headers → native; bad priority → background; wait capped at `max_wait_s`; lane sanitised to `[0-9a-f]{1,64}` else `app`).
- [ ] Run `cd deploy/hindsight && python3 -B -m unittest -v test_admission_queue`: fails (no module).
- [ ] Implement the module (lanes as `OrderedDict[lane, deque[Ticket]]` per (priority, source); a `deque` of sources per priority for the source turn; a waiter's `asyncio.Future` resolved on admission; `acquire` loops `asyncio.wait_for(asyncio.shield(future), tick_s)`, calling `refresh()` then `dispatch()` on each tick and checking `abandoned()` and the deadline; removal on cancel).
- [ ] Rewire `alfyai_admission.py`: build the ticket from the request headers, `acquire` before the upstream call with `abandoned=request.is_disconnected` and a `refresh` that re-reads the activity endpoint when the last reading is over 1 s old; `release` in `finally`. Status keeps `active, peak, rejected, completed, duration_ms` and adds `waiting, waited, wait_ms, max_wait_ms, refused_full, refused_wait`. `test_admission.py` keeps the adapter tests (destinations, pinning) and imports nothing removed.
- [ ] Write `admission.test.ts`: headers for both priorities; the lane is a stable 32-hex digest of the tenant (never the raw id), `app` without a tenant; wait header from `MEMORY_ADMISSION_WAIT_MS`. Extend `curation-config.test.ts`: the transport receives the three headers; a background call's timeout covers its declared wait plus 180 s.
- [ ] `createCurationModel` adds the headers in its `fetch` wrapper and sets both its abort timeout and the request timeout to `180_000 + MEMORY_ADMISSION_WAIT_MS[priority]` (the gateway path passes `Math.max(config.requestTimeoutMs, that)`; the registered-model path calls `sendJsonControlMessageViaProvider` with the provider it already resolved and the same timeout). `curation-runner.ts` passes `memoryAdmissionFor(row.userId, "background")`.
- [ ] README "Background admission": the queue, its order and bounds, the headers, the env keys, and "When fan-out and retries may change" (measure on the non-production Hindsight: queue wait p95 and refusals from `/alfyai/inference/status` over a held-busy overnight run; raise fan-out one step at a time only while `refused_*` stay 0 and the p95 wait of a background call stays under half of `admission_native_wait_s`; lower retries toward the default 3 only after a week with no `refused_*`). Compose comments say the same.
- [ ] Run the Python file and `npx vitest run` on the two TS files. Commit (Python and TS may be two commits).

## Task 3: Jobs that wait on Hindsight's own operation state

**Files:**
- Create: `src/lib/server/services/memory-profile/delivery-policy.ts`, `delivery-policy.test.ts`
- Modify: `src/lib/server/env.ts`, `src/lib/server/config-store.ts`, `src/lib/config/admin-config-registry.ts`, `src/lib/i18n/settings.ts`, `src/lib/server/config-store.memory-v2.test.ts`, `src/lib/server/config-store.promoted-keys.test.ts`, `README.md`, `.env.example`, `docs/configuration.md`, `src/lib/server/services/memory-profile/contracts.ts` (`NativeMemoryError` details), `delivery-runner.ts`, `delivery-job.ts`, `delivery-job.integration.test.ts`

**Interfaces:**
- Consumes: none from earlier tasks.
- Produces: settings `MEMORY_RETAIN_WAIT_MINUTES` (30) and `MEMORY_CONSOLIDATION_WAIT_MINUTES` (60), whole minutes 1 to 1440, admin-overridable; `getMemoryNativeWaits(): { retainMs: number; consolidationMs: number }`; codes `native_retain_waiting`, `native_consolidation_waiting` (requeued, not counted), `native_operation_timeout` (the end, retryable); `NativeMemoryError(code, retryable, details?: { waitStartedAt?: number; retryAfterMs?: number })`; `decideMemoryDeliveryFailure(failure, history): FailureDecision`; `parseDeliveryRetryState(state): { waits: number; waiting: "retain" | "consolidation" | null; since: number | null }`; `freshDeliveryAttempts(state, attemptCount): unknown` (for a deliberate reopen); `NATIVE_WAIT_SLICE_MS = 300_000`.

Policy: a waiting code continues the streak of its own kind (`since` kept) or starts one at `diagnostics.waitStartedAt`; requeue after `failure.retryAfterMs ?? 5_000` while `nowMs - since` is under that kind's total, else settle `native_operation_timeout`, retryable. Any other failure counts `attempts - waits` against `NATIVE_DELIVERY_ATTEMPT_LIMIT` exactly as today and ends the streak. Waits: `retain` covers a retain's own poll and the outstanding retains at a delivery's start; `consolidation` covers consolidation polls and every bank quiescence wait (`drainNative`, so capture too). Each wait polls until `min(NATIVE_WAIT_SLICE_MS, total)` passes, then throws its waiting code with the time it started.

- [ ] Write `delivery-policy.test.ts` (pure): waits are requeued and not counted; three real failures after ten waits still end the job at the third; the total ends the streak with `native_operation_timeout` retryable; a new kind starts its own streak; `retryAfterMs` is the delay when given; `freshDeliveryAttempts` makes the next failure count as the first.
- [ ] Config tests (`config-store.memory-v2.test.ts`, `promoted-keys`): defaults, admin override, out-of-range keeps the current value.
- [ ] Integration (`delivery-job.integration.test.ts`, Date faked, a fake Hindsight whose operation moves Date 6 minutes per poll and completes at minute 20): the job requeues under `native_retain_waiting`, never fails, succeeds with `attemptCount` above the limit; a consolidation that never ends fails the job `native_operation_timeout` only after 60 minutes; **never re-posts an acknowledged retain** on a requeued attempt (the (sent, acknowledged) case of f2a6ab080's "asks about the operation first" test now expects no POST at all: an intended change, named in the commit).
- [ ] Run: fail.
- [ ] Implement config (4 steps, English and Hungarian labels), the policy, the runner's sliced waits (`beginWait(kind)`), the acknowledged-retain skip, and `onFailure: decideMemoryDeliveryFailure` in `delivery-job.ts`; the runner's catch passes `retryAfterMs` and `diagnostics: { waitStartedAt }`.
- [ ] Run the three test files. Commit.

## Task 4: Follow-ups to `73362c397` (S1, S2, S3, N1 to N6)

**Files:**
- Modify: `src/lib/server/services/memory-profile/delivery-runner.ts`, `delivery-policy.ts` (the resubmit wait code), `delivery-job.integration.test.ts`, `docs/plans/hindsight-memory/migration-runbook.md`

**Interfaces:**
- Consumes: Task 3's policy (`native_retain_resubmit_due` is a `retain` wait).
- Produces: revision context keys `nativeRetainResubmittedFrom` (kept) and `nativeRetainEnded: { operationId: string; reason: "resubmit_failed" | "cancelled" | "facts_left_behind" }`; `RETAIN_RESUBMIT_DELAY_MS = 60_000`.

- **S1:** when the first send's settle finds the retain failed, the attempt ends with `native_retain_resubmit_due` and `retryAfterMs` 60 s (not counted) before anything is rotated; the next attempt asks Hindsight, finds the operation failed, and records and sends the resubmission in one go (see N5).
- **S2:** every terminal end of a retain (the resubmission failed, a cancel, facts left behind) writes `nativeRetainEnded` for the current operation id in a fenced write before failing. An attempt that finds it for the current id fails terminal at once and sends nothing, whatever Hindsight remembers.
- **S3:** tests with a real chat context envelope (the shape `chat-delivery.ts` writes: `messageSequence`, `conversationId`, `sourceRole`, `guidance`, `messages`): the resubmission keeps every envelope key and adds only the marker; both POSTs carry the same resolved `context`; neither carries the marker.
- **N1 to N6:** an Opus re-review of `fc0bf35f7`, `f2a6ab080`, `73362c397` (read-only, 2026-11-24 00:58). It also confirmed that a retry re-POSTed an acknowledged retain, which Task 3 already stopped.
  - **N1 (important):** the runbook reads every `native_operation_failed` on a source delivery as "already resubmitted, needs the owner", but the same code comes from a failed consolidation, a repair's retain and every Add/Edit retain. Fix: the retain's own terminal ends get their own codes, `native_retain_resubmit_failed`, `native_retain_cancelled`, `native_retain_left_facts`, and the runbook line names only those. Test: "ends for good when the resubmitted retain fails too" expects the new code.
  - **N2 (nit):** the left-facts guard's document filter is never exercised (the fake bank holds only this source). Test: a fact under another document still lets the resubmission go out.
  - **N3 (nit):** `operationFailed` reduces the status to a boolean, so a sent operation Hindsight reports completed or cancelled is POSTed again. Fix: completed goes straight to the acknowledged write, cancelled ends terminal, failed resubmits, unknown sends its own ID. Tests: no POST for a completed one; a reopened cancelled one sends nothing.
  - **N4 (nit):** dependency repair copies the whole envelope, marker included, into a replacement revision. Fix: `stepContext` drops the retain bookkeeping keys. Test: a replacement of a resubmitted source carries no marker.
  - **N5 (nit):** the rotation swaps an ended ID for one not yet sent; if the job never sends it (the chat deleted meanwhile), cleanup readers poll an ID Hindsight never saw. S1 must not widen this window: the hold-back comes BEFORE the rotation (the next attempt finds the failed operation and rotates and sends in one go), and the operator resend writes the new ID with `nativeSubmitted` false so no reader polls it before the job sends it. The general class (the first send's own window) stays as it was: ruled deferred.
  - **N6 (nit):** `resubmitRetain` sends nothing: renamed `recordResubmission`, and `failed` → `failedOperationId`.

- [ ] Tests for S1 (one POST in the first attempt, the second after the delay, attempts not counted), S2 (Hindsight forgets the resubmitted failed operation: a reopen sends nothing and stays terminal; a cancelled one likewise), S3. Run: fail. Implement. Run. Commit per follow-up.
- [ ] N-findings: one test and fix each. Runbook line updated.

## Task 5: Four canonical operator tools

**Files:**
- Create: `src/lib/server/services/memory-profile/operator-tools.ts`, `operator-tools.integration.test.ts`, `scripts/memory-operator-cli.ts`, `scripts/memory-resend.ts`, `scripts/memory-reattach.ts`, `scripts/memory-recover-consolidation.ts`, `scripts/memory-drain.ts`
- Modify: `src/lib/server/services/memory-profile/hindsight-client.ts` (`recoverConsolidation`), `src/lib/server/services/jobs/ledger.ts` (`ClaimOptions.userId`), `jobs/scheduler.ts` (`drainUser`), `jobs/index.ts`, a jobs test, `deploy/hindsight/README.md` or `docs/plans/hindsight-memory/migration-runbook.md` (how to run them), `.fallowrc.json` only if Fallow flags the scripts as unused entries (scripts are standalone entry points)

**Interfaces:**
- Consumes: `memoryMigrationGuard` (Task 1), `freshDeliveryAttempts` (Task 3), `nativeRetainEnded` (Task 4).
- Produces: `interface OperatorStep { step: string; ok: boolean; code?: string; counts?: Record<string, number>; ids?: string[] }`; `interface OperatorReport { tool: string; userId: string; execute: boolean; outcome: "done" | "dry_run" | "refused" | "failed"; steps: OperatorStep[] }`; `resendDelivery({ userId, jobId, execute })`, `reattachDelivery({ userId, jobId, execute })`, `recoverConsolidation({ userId, bankId, execute })`, `drainMemory({ userId, execute, maxMinutes })`, all `Promise<OperatorReport>`; `HindsightClient.recoverConsolidation(): Promise<Record<string, unknown>>` (`POST …/consolidation/recover`); `drainUser(kind, userId): Promise<void>`.
- Commands: `npx tsx scripts/memory-resend.ts --user <id> --job <id> [--execute]`, `npx tsx scripts/memory-reattach.ts --user <id> --job <id> [--execute]`, `npx tsx scripts/memory-recover-consolidation.ts --user <id> --bank <id> [--execute]`, `npx tsx scripts/memory-drain.ts --user <id> [--max-minutes 60] [--execute]`. Each prints one line per step (`step <name>: ok|FAILED <code> <counts>`) and the report as JSON last; exit 0 when done or dry run, 1 when refused or failed.

Every tool's first step is `guard` (the tester and unknown accounts are refused, nothing else runs). Each acting step re-checks its fence in the write.
- **resend:** the job is a failed `source` delivery of that user whose revision was sent and not acknowledged; Hindsight reports its operation failed, cancelled or unknown, holds no fact under the document and no pending operation; then a fresh operation id, `nativeRetainEnded` cleared, `nativeRetainResentFrom` recorded, and the job reopened with a fresh attempt budget.
- **reattach:** the job is a failed `source` delivery of that user; Hindsight holds the document's facts and has no pending operation; then the revision is marked sent and acknowledged and the job reopened (fresh budget), so it consolidates and publishes without sending the retain again.
- **recover-consolidation:** counts facts with `consolidation_failed_at`, calls recover, runs one consolidation and waits for it, counts again.
- **drain:** runs the user's claimable delivery jobs (`drainUser`), waits for the next requeued job's `runAfter` while any is queued (bounded by `--max-minutes`), never stops at a failed or held job, and ends with counts by status and, per skipped job, its id, kind and code.

- [ ] Tests (engine harness, fake Hindsight): each tool refuses the tester and an unknown user and writes nothing; dry run writes nothing and reports what it would do; resend and reattach refuse a running, queued, or another user's job, and refuse when Hindsight state does not match; resend's reopened job sends the new operation and succeeds; reattach's reopened job succeeds without a POST; recover calls the endpoint and a consolidation; drain carries past a failed job and a waiting requeue and summarises; `drainUser` runs only that user's jobs.
- [ ] Run: fail. Implement. Run. Commit.

## Task 6: Python tests in the gate

**Files:**
- Modify: `scripts/gates.mjs` (a `python` step), `scripts/gates.test.ts`, `AGENTS.md` (step lists), `deploy/hindsight/README.md` (which tests run where)

**Interfaces:**
- Produces: gate step `python`: `python3 -B -m unittest discover -s deploy/hindsight -t deploy/hindsight -p "test_admission_queue.py"` with `PYTHONDONTWRITEBYTECODE=1`, parsed from the `Ran N tests` and `OK`/`FAILED` lines; skippable with `--skip python`; independent of the build.

- [ ] Test `parsePythonLog` (ok, failure, no tests ran = fail) in `gates.test.ts`. Run: fail. Implement the step. Run. Commit.
- [ ] README: the gate runs `test_admission_queue` (stdlib only); `test_admission`, `test_tenant`, `test_effective_config` still need the pinned image; `test_tei_transport`, `test_provision` run on the Mac with the uv-cache recipe.

## Task 7: Acceptance on the Mac with fakes

**Files:**
- Create: `deploy/hindsight/test_admission_acceptance.py` (stdlib only; joins the gate's pattern), `src/lib/server/services/memory-profile/delivery-wait.acceptance.test.ts`
- Modify: `scripts/gates.mjs` pattern if the file name needs it

- [ ] Python: a fake upstream held busy (each admitted call holds the slot for a simulated 30 s on a fake clock / short real sleeps); 24 calls of mixed sources, lanes and priorities; none refused; every interactive call admitted before every background call that arrived before it was admitted; native and app alternate.
- [ ] TS: with the fake Hindsight's operations kept running for 20 minutes of faked time and the curation model's gateway answering after a hold, a delivery and a curation action both succeed; no job ever records `native_operation_timeout` while the fake reports the operation running; attempts counted 0.
- [ ] Run both. Commit.

## Closing

- [ ] `npm run check` once (0/0). Then the agent gate once: `scripts/gates.sh agent "$TMPDIR/alfyai-gates-p4" --port 5200` (no e2e spec changed), after `pgrep -fl 'gates.sh|node_modules/.bin/playwright test'` shows nothing.
- [ ] One Opus whole-branch review; fix Important findings with a failing test first.
- [ ] Hand-over note `memory-part-4-build-2026-11-24.md` in the shared notes folder: commits, gate numbers, review, calls, deferred items, and the box steps (image rebuild for the new module, env keys, worker restart order, what to measure before fan-out or retries change).
