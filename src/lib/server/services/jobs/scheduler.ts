// Scheduling: who runs what, and when.
//
// One state object per process, on `globalThis` (see `state.ts`), and per kind:
//
//  - DRAIN: one loop, one job at a time. It claims until nothing is claimable;
//    between empty drains it runs the stale sweep at most once per idle tick; a
//    sweep that took anything back (requeued it, or settled it and so freed its
//    slot) continues the loop. A wake that arrives during a drain is remembered
//    and honoured after it.
//  - IDLE TICK: one unref'd interval. It is also the SUPERVISOR of the enable
//    switch, in both directions, and the only thing that runs on a box where
//    nobody does anything. An idle box pays one index probe per tick and logs
//    nothing.
//  - BACKOFF TIMER: at most one, for the earliest moment work becomes claimable.
//  - BOOT: dead-worker reclaim, the stale and lost-state sweeps, the follow-up
//    sweep `staleAfterMs` later, the tick, a drain.
//  - WAKE: every transition that leaves claimable work wakes its kind. A wake
//    does nothing in a process that has not called `startJobs` (or been started
//    for a test): `scripts/backfill-extractions.ts` reopens jobs from a CLI and
//    must never become a second worker.
//
// `runner.ts` runs one claimed attempt; `recovery.ts` takes attempts back;
// `ledger.ts` makes every state change. This file only decides when.

import { eq, or, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { internalsOf } from "./define";
import { claimNext, readJobRow } from "./ledger";
import { type TakeBackResult, takeBack } from "./recovery";
import { runAttempt } from "./runner";
import { jobsState, type KindSchedulerState, kindScheduler } from "./state";
import type { JobKind } from "./types";
import { createWorkerId } from "./worker-identity";

/** Idle-tick bounds. Fast enough to bound recovery, slow enough to be free. */
const IDLE_TICK_MIN_MS = 5_000;
const IDLE_TICK_MAX_MS = 60_000;

/**
 * Added to a job's own `runAfter` when arming the backoff timer.
 *
 * `runAfter` is stored with one-second granularity and the claim gate is
 * `run_after <= now`, so a timer that fired on the exact millisecond could round
 * to the second before its own gate and claim nothing. A second of margin costs
 * a second of latency on a retry and removes the whole class of misses.
 */
const BACKOFF_TIMER_MARGIN_MS = 1_000;

/** Never sleep longer than this in one hop; the idle tick re-arms the rest. */
const BACKOFF_TIMER_MAX_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Worker ids
// ---------------------------------------------------------------------------

const workerIds = new Map<string, string>();

/**
 * This process's worker id for a slice: `<slice>:<host>:<pid>:<boot-nonce>`.
 *
 * The nonce and the hostname are what let a BOOT sweep tell "an attempt this very
 * restart orphaned" from "an attempt a healthy process is working on": same host,
 * pid no longer alive, not us. The inline runner's id is `<kind>-inline` here: a
 * real four-segment id of a slice of its own, NOT `<id>:inline`, which the parser
 * refuses (a five-segment id means "I cannot tell whose process this was", which
 * must never read as "dead"). Sharing the process's boot nonce is what keeps our
 * OWN inline attempts from being reclaimed.
 */
function workerIdOf(slice: string): string {
	let id = workerIds.get(slice);
	if (!id) {
		id = createWorkerId(slice);
		workerIds.set(slice, id);
	}
	return id;
}

export function workerIdFor(kindName: string): string {
	return workerIdOf(kindName);
}

// ---------------------------------------------------------------------------
// Serving or not
// ---------------------------------------------------------------------------

function isNonServingContext(): boolean {
	// Vitest imports server modules freely; an engine that started draining a
	// test's temp database would race every test that seeds one. The build step
	// imports modules for analysis and must not open a DB connection at all.
	return Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
}

// ---------------------------------------------------------------------------
// The queue, as the tick sees it
// ---------------------------------------------------------------------------

interface QueueSnapshot {
	/** Rows `running`, i.e. rows a stale sweep could have work on. */
	runningCount: number;
	/** Queued rows whose run time has come and that the kind's claim condition lets through. */
	claimableCount: number;
	/** Earliest future run time among queued rows, in epoch ms. */
	earliestGatedAtMs: number | null;
}

/**
 * One aggregate over the jobs table: is there anything to do, and if not yet,
 * when. Deliberately one query and deliberately aggregate-only, because the
 * idle tick runs it forever on boxes where nobody does anything.
 *
 * The WHERE is spelled as two `=` terms joined by `or` and not as `in (…)`,
 * because that is what makes the live partial index usable (see
 * `liveClaimIndex`). Measured on a 20 000-row ledger: 704 µs scanning, 4.7 µs
 * through the index.
 */
function readQueueSnapshot(kind: JobKind, nowMs: number): QueueSnapshot {
	const { jobs, definition } = internalsOf(kind);
	// `run_after` is a drizzle `timestamp` column: unix SECONDS.
	const nowSeconds = Math.floor(nowMs / 1000);
	const condition = definition.claimable?.(jobs);
	const allowed = condition ? sql` and ${condition}` : sql``;

	const row = db
		.select({
			runningCount: sql<number>`sum(case when ${jobs.status} = 'running' then 1 else 0 end)`,
			claimableCount: sql<number>`sum(case when ${jobs.status} = 'queued' and (${jobs.runAfter} is null or ${jobs.runAfter} <= ${nowSeconds})${allowed} then 1 else 0 end)`,
			earliestGated: sql<
				number | null
			>`min(case when ${jobs.status} = 'queued' and ${jobs.runAfter} > ${nowSeconds}${allowed} then ${jobs.runAfter} end)`,
		})
		.from(jobs)
		.where(or(eq(jobs.status, "queued"), eq(jobs.status, "running")))
		.get();

	const earliest = row?.earliestGated;
	return {
		runningCount: Number(row?.runningCount ?? 0),
		claimableCount: Number(row?.claimableCount ?? 0),
		earliestGatedAtMs:
			earliest === null || earliest === undefined
				? null
				: Number(earliest) * 1000,
	};
}

/** `heartbeatMs × 2`, clamped. 30 s on a 15 s heartbeat. */
function idleTickIntervalMs(kind: JobKind): number {
	const { heartbeatMs } = internalsOf(kind).definition.lease();
	return Math.min(
		IDLE_TICK_MAX_MS,
		Math.max(IDLE_TICK_MIN_MS, heartbeatMs * 2),
	);
}

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

/**
 * The stale sweep and the lost-state sweep, between boot and shutdown. Silence on
 * a sweep that found nothing is the point: this runs every tick forever. A sweep
 * that DID reclaim something is the one line that explains why a job a person
 * was watching started over.
 *
 * The lost-state take-back is age-guarded here (only a running row nobody has
 * touched for a whole stale window), unlike at boot where nothing of this
 * process is running yet: a row another writer has only just made is not lost.
 */
function runSweep(kind: JobKind, reason: string): TakeBackResult {
	const { definition } = internalsOf(kind);
	const state = kindScheduler(kind.name);
	state.lastRecoveryAt = Date.now();

	const now = new Date();
	const { staleAfterMs } = definition.lease();
	const staleBefore = new Date(now.getTime() - staleAfterMs);

	const stale = takeBack(kind, { reason: "stale", staleBefore, now });
	if (stale.recovered > 0) {
		console.warn(`${definition.logPrefix} Reclaimed stale attempts`, {
			reason,
			recovered: stale.recovered,
			requeued: stale.requeued,
			staleAttemptMs: staleAfterMs,
		});
	}
	const lost = takeBack(kind, {
		reason: "state-lost",
		updatedBefore: staleBefore,
		now,
	});
	if (lost.recovered > 0) {
		console.warn(
			`${definition.logPrefix} Reclaimed jobs whose attempt state was lost`,
			{ reason, recovered: lost.recovered, requeued: lost.requeued },
		);
	}
	return {
		recovered: stale.recovered + lost.recovered,
		requeued: stale.requeued + lost.requeued,
	};
}

/**
 * What a restart leaves behind, reclaimed at boot: attempts whose process is
 * provably gone (at once, not a stale window later), attempts whose beat is
 * already stale, and running jobs with no live attempt at all (every Atlas row at
 * the cutover). Each sweep is its own failure domain: one that throws is logged
 * and must not stop the next, or the tick from being armed.
 *
 * The same sweeps run when a kind comes on later in a serving process (the
 * switch), but only the process's own boot takes lost rows back with no age
 * guard: an hour into serving, a running row with no attempt that another writer
 * made a moment ago is not lost yet, and the guard costs nothing for the rows a
 * dead process left, which are as old as its death.
 */
function runBootSweeps(kind: JobKind, atProcessBoot: boolean): void {
	const { definition } = internalsOf(kind);
	const state = kindScheduler(kind.name);
	const prefix = definition.logPrefix;
	state.lastRecoveryAt = Date.now();
	const { staleAfterMs } = definition.lease();

	const attempt = (what: string, sweep: () => void): void => {
		try {
			sweep();
		} catch (error) {
			console.error(`${prefix} Boot sweep failed`, { sweep: what, error });
		}
	};

	attempt("dead-worker", () => {
		const outcome = takeBack(kind, {
			reason: "dead-worker",
			selfWorkerId: workerIdFor(kind.name),
			...(state.isProcessAlive ? { isProcessAlive: state.isProcessAlive } : {}),
		});
		if (outcome.recovered > 0) {
			console.warn(`${prefix} Reclaimed attempts from a dead worker`, {
				recovered: outcome.recovered,
				requeued: outcome.requeued,
			});
		}
	});

	attempt("stale", () => {
		const outcome = takeBack(kind, {
			reason: "stale",
			staleBefore: new Date(Date.now() - staleAfterMs),
		});
		if (outcome.recovered > 0) {
			console.warn(`${prefix} Reclaimed stale attempts`, {
				reason: "boot",
				recovered: outcome.recovered,
				requeued: outcome.requeued,
				staleAttemptMs: staleAfterMs,
			});
		}
	});

	attempt("state-lost", () => {
		// No age guard at boot: nothing of this process is running yet, so nobody
		// can be in the middle of claiming a row.
		const outcome = takeBack(kind, {
			reason: "state-lost",
			...(atProcessBoot
				? {}
				: { updatedBefore: new Date(Date.now() - staleAfterMs) }),
		});
		if (outcome.recovered > 0) {
			console.warn(`${prefix} Reclaimed jobs whose attempt state was lost`, {
				reason: "boot",
				recovered: outcome.recovered,
				requeued: outcome.requeued,
			});
		}
	});
}

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

/**
 * A drain that claims the same job this many times in a row is spinning: a policy
 * that requeues with no delay, again and again, and a handler that never gets it
 * right. Every real policy is bounded (Atlas takes a lost attempt back three
 * times; extraction backs off by seconds, which a drain does not wait for), so
 * this never trips on one; on a policy bug it turns a hot loop that writes the
 * database as fast as it can into ten attempts per idle tick.
 */
const MAX_CLAIMS_OF_ONE_JOB_IN_A_ROW = 10;

/** Claims and runs one job. Returns its id, or null when there was nothing to run (or no leave to). */
async function runNextJob(kind: JobKind): Promise<string | null> {
	if (jobsState().stopped) return null;
	const { definition } = internalsOf(kind);
	// Read per step, never captured, so switching a kind off stops the very next
	// claim, including the one the loop is about to make, without a restart. An
	// attempt already running is untouched: it keeps its heartbeat and reports.
	if (!definition.enabled()) return null;

	const workerId = workerIdFor(kind.name);
	const claimed = claimNext(kind, { workerId });
	if (!claimed) return null;
	await runAttempt(kind, claimed, { workerId });
	return claimed.row.id;
}

/**
 * Loops until the claim returns nothing, then re-arms.
 *
 * Between empty drains it re-runs the sweep, but no more often than one idle
 * tick: sweeping on every empty claim would be a write storm on a busy box. A
 * sweep that took anything back goes round again, not only one that requeued:
 * a stale attempt the policy SETTLES (file production never requeues) frees
 * the slot it held, and the job queued behind it can run now.
 *
 * The re-arm in the `finally` is the other half of it. A drain that requeues a
 * job behind a backoff and then returns has left work in the table with nothing
 * scheduled to pick it up; before this, the job waited for an unrelated wake,
 * which on an idle box never comes.
 */
async function drainLoop(kind: JobKind): Promise<void> {
	const state = kindScheduler(kind.name);
	let lastJobId: string | null = null;
	let inARow = 0;
	try {
		for (;;) {
			const ranJobId = await runNextJob(kind);
			if (ranJobId !== null) {
				inARow = ranJobId === lastJobId ? inARow + 1 : 1;
				lastJobId = ranJobId;
				if (inARow >= MAX_CLAIMS_OF_ONE_JOB_IN_A_ROW) {
					console.warn(
						`${kind.logPrefix} Job claimed ${inARow} times in a row; ending this drain`,
						{ jobId: ranJobId },
					);
					return;
				}
				continue;
			}
			if (jobsState().stopped) return;
			if (Date.now() - state.lastRecoveryAt < idleTickIntervalMs(kind)) return;
			if (runSweep(kind, "drain").recovered === 0) return;
		}
	} finally {
		await rearmAfterDrain(kind);
	}
}

/**
 * Starts a drain and returns its promise (which rejects when the drain does).
 * `drainPromise` is the version that never rejects, for whoever has to wait for
 * a drain that is already running; it also starts the follow-up drain a wake
 * asked for while this one ran.
 */
function launchDrain(kind: JobKind): Promise<void> {
	const state = kindScheduler(kind.name);
	state.drainRuns += 1;
	const run = Promise.resolve().then(() => drainLoop(kind));
	state.drainPromise = run
		.then(
			() => undefined,
			() => undefined,
		)
		.then(() => {
			state.drainPromise = null;
			if (state.drainRequestedAgain) {
				state.drainRequestedAgain = false;
				startDrain(kind);
			}
		});
	return run;
}

/**
 * Starts a drain, or records that one is owed.
 *
 * The dedupe used to drop a wake that arrived while a drain was running, which
 * is wrong whenever the enqueue landed after that drain's last claim: the job was
 * then invisible to the drain that swallowed its wake, and waited for the next
 * unrelated one. The flag costs nothing and closes the window.
 */
function startDrain(kind: JobKind): void {
	const state = kindScheduler(kind.name);
	if (jobsState().stopped) return;
	if (state.drainPromise) {
		state.drainRequestedAgain = true;
		return;
	}
	launchDrain(kind).catch((error) => {
		console.error(`${kind.logPrefix} Worker drain failed`, { error });
	});
}

/**
 * Runs every claimable job of the kind now, one at a time, in the caller's async
 * context. For tests and scripts; the scheduler drains on its own. It waits its
 * turn behind a drain already running (one drain at a time per kind) and works
 * in a process that never called `startJobs`.
 */
export async function drain(kind: JobKind): Promise<void> {
	const state = kindScheduler(kind.name);
	while (state.drainPromise) await state.drainPromise;
	await launchDrain(kind);
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

function clearBackoffTimer(state: KindSchedulerState): void {
	if (state.backoff) clearTimeout(state.backoff);
	state.backoff = null;
	state.backoffFiresAtMs = null;
}

/**
 * Arms at most ONE backoff timer, for the earliest moment work becomes
 * claimable. An existing timer that already fires at or before that moment is
 * left alone rather than replaced, so repeated drains cannot stack timers.
 */
function armBackoffTimer(kind: JobKind, dueAtMs: number): void {
	const state = kindScheduler(kind.name);
	if (!state.running) return;

	const delayMs = Math.min(
		BACKOFF_TIMER_MAX_MS,
		Math.max(0, dueAtMs + BACKOFF_TIMER_MARGIN_MS - Date.now()),
	);
	const firesAtMs = Date.now() + delayMs;
	if (
		state.backoff &&
		state.backoffFiresAtMs !== null &&
		state.backoffFiresAtMs <= firesAtMs
	) {
		return;
	}

	clearBackoffTimer(state);
	state.backoffFiresAtMs = firesAtMs;
	state.backoff = setTimeout(() => {
		state.backoff = null;
		state.backoffFiresAtMs = null;
		startDrain(kind);
	}, delayMs);
	state.backoff.unref?.();
}

/**
 * Called at the end of every drain. A drain that emptied the queue arms nothing;
 * one that left work behind a backoff gate arms the single timer that will pick
 * it up.
 *
 * `claimableCount > 0` after a drain that claimed nothing means the caps are
 * full or a row landed during the final claim. Retrying immediately would spin,
 * so that case waits one idle tick: bounded, and free of a hot loop.
 */
async function rearmAfterDrain(kind: JobKind): Promise<void> {
	const state = kindScheduler(kind.name);
	if (!state.running || jobsState().stopped) return;

	try {
		const now = Date.now();
		const snapshot = readQueueSnapshot(kind, now);
		const due: number[] = [];
		if (snapshot.claimableCount > 0) due.push(now + idleTickIntervalMs(kind));
		if (snapshot.earliestGatedAtMs !== null)
			due.push(snapshot.earliestGatedAtMs);
		if (due.length > 0) armBackoffTimer(kind, Math.min(...due));
	} catch (error) {
		// The idle tick is still running; a failed re-arm costs latency, never the
		// job. Throwing here would also replace whatever the drain was reporting
		// with a database error from its `finally`.
		console.warn(`${kind.logPrefix} Re-arm after drain failed`, { error });
	}
}

/**
 * The periodic sweep, and the only thing that runs on a box where nobody does
 * anything. Recovery latency after a crash is therefore bounded by roughly
 * `staleAfterMs + idleTick`, not by the next unrelated wake.
 */
async function runIdleTick(kind: JobKind): Promise<void> {
	const state = kindScheduler(kind.name);
	if (!state.initialized || jobsState().stopped) return;
	const { definition } = internalsOf(kind);

	// The tick is also the SUPERVISOR for the enable switch, which is why it runs
	// even while the kind is off. The switch is live in both directions.
	if (!definition.enabled()) {
		if (state.running) {
			// Live OFF. Nothing in flight is touched: the running drain re-reads the
			// switch before its NEXT claim, while the attempt it already owns
			// finishes and reports normally. All that stops here is arming more work.
			state.running = false;
			clearBackoffTimer(state);
			console.info(`${definition.logPrefix} Worker paused by configuration`);
		}
		return;
	}
	if (!state.running) {
		// Live ON. A full start, sweeps included: the queue may have been sitting
		// untouched for however long the switch was off.
		await startKindLoops(kind, { atProcessBoot: false });
		return;
	}

	const snapshot = readQueueSnapshot(kind, Date.now());
	if (
		snapshot.runningCount === 0 &&
		snapshot.claimableCount === 0 &&
		snapshot.earliestGatedAtMs === null
	) {
		return;
	}

	if (snapshot.runningCount > 0) {
		// A row still `running` may hold a slot nobody is working on. When the sweep
		// frees one (settled, or put back in the queue), whatever was waiting
		// behind it can finally move.
		if (runSweep(kind, "idle-tick").recovered > 0) {
			startDrain(kind);
			return;
		}
	}

	if (snapshot.claimableCount > 0) {
		startDrain(kind);
		return;
	}
	if (snapshot.earliestGatedAtMs !== null) {
		armBackoffTimer(kind, snapshot.earliestGatedAtMs);
	}
}

function startIdleTick(kind: JobKind): void {
	const state = kindScheduler(kind.name);
	if (state.idleTick) return;

	const intervalMs = idleTickIntervalMs(kind);
	state.idleTickMs = intervalMs;
	state.idleTick = setInterval(() => {
		void runIdleTick(kind).catch((error) => {
			console.error(`${kind.logPrefix} Idle tick failed`, { error });
		});
	}, intervalMs);
	state.idleTick.unref?.();
}

// ---------------------------------------------------------------------------
// Starting and stopping
// ---------------------------------------------------------------------------

/**
 * Everything that has to happen when a kind goes from off to on, whether that is
 * at boot or at the idle tick that saw the switch flip.
 *
 * Boot recovery runs TWICE by design. The sweep at boot reclaims attempts whose
 * worker died long enough ago to look stale; the one scheduled `staleAfterMs`
 * later reclaims the attempts this very restart orphaned, whose heartbeats were
 * seconds old at boot and so looked perfectly healthy. Without it, a box where
 * nobody does anything for an hour keeps a job `running` for that hour with a
 * heartbeat frozen at the restart.
 *
 * `atProcessBoot` is true only from `startJobs`: the switch coming on later, at
 * the tick or at a wake, keeps the lost-state age guard (see `runBootSweeps`).
 */
async function startKindLoops(
	kind: JobKind,
	{ atProcessBoot }: { atProcessBoot: boolean },
): Promise<void> {
	const state = kindScheduler(kind.name);
	if (state.running) return;
	state.running = true;
	const { definition } = internalsOf(kind);
	const limits = definition.limits();
	const lease = definition.lease();

	console.info(`${definition.logPrefix} Worker started`, {
		idleTickMs: idleTickIntervalMs(kind),
		staleAttemptMs: lease.staleAfterMs,
		heartbeatMs: lease.heartbeatMs,
		maxConcurrency: limits.global,
		perUserConcurrency: limits.perUser ?? null,
	});

	runBootSweeps(kind, atProcessBoot);

	if (state.bootSweep) clearTimeout(state.bootSweep);
	state.bootSweep = setTimeout(() => {
		state.bootSweep = null;
		try {
			if (!state.running || jobsState().stopped) return;
			if (!definition.enabled()) return;
			// Anything taken back, settled or requeued, frees the slot it held.
			if (runSweep(kind, "boot-followup").recovered > 0) startDrain(kind);
		} catch (error) {
			console.error(`${definition.logPrefix} Boot follow-up sweep failed`, {
				error,
			});
		}
	}, lease.staleAfterMs);
	state.bootSweep.unref?.();

	startIdleTick(kind);
	startDrain(kind);
}

export interface StartJobsTestOptions {
	/** Start even under vitest. The production call passes nothing. */
	startInNonServingContextForTests?: boolean;
	/** How boot decides a pid is gone. Defaults to asking the OS. */
	isProcessAlive?: (pid: number) => boolean;
}

/**
 * Once per process, from `hooks.server.ts` init. Idempotent: the state lives on
 * a `Symbol.for` key, so a double import and an HMR re-evaluation are both a
 * no-op for a kind already started. It does not block server start (the caller
 * does not await it) and is safe against an empty table, where the sweeps and
 * the drain return at once.
 *
 * Outside a serving process (vitest, `NODE_ENV=test`, the build's analysis)
 * nothing starts unless a test asks: a drain against a test's temp database
 * would race every test that seeds one.
 */
export async function startJobs(
	kinds: readonly JobKind[],
	testOptions: StartJobsTestOptions = {},
): Promise<void> {
	if (
		isNonServingContext() &&
		testOptions.startInNonServingContextForTests !== true
	) {
		return;
	}
	jobsState().stopped = false;

	for (const kind of kinds) {
		const state = kindScheduler(kind.name);
		if (state.initialized) continue;
		state.initialized = true;
		state.kind = kind;
		state.isProcessAlive = testOptions.isProcessAlive ?? null;

		// A kind that fails to start must not keep the others from starting.
		try {
			const { definition } = internalsOf(kind);
			if (!definition.enabled()) {
				console.info(
					`${definition.logPrefix} Worker disabled by configuration`,
				);
				// The SUPERVISOR. Nothing else is started (no drain, no recovery, no
				// boot sweep), but this one unref'd interval has to exist, because it is
				// what notices the switch being turned back on.
				startIdleTick(kind);
				continue;
			}
			await startKindLoops(kind, { atProcessBoot: true });
		} catch (error) {
			console.error(`${kind.logPrefix} Worker failed to start`, { error });
		}
	}
}

/**
 * On `sveltekit:shutdown`: no new claims, every timer cleared. A running attempt
 * is left to heartbeat recovery (ADR-0005): the next boot reclaims it by its
 * worker id.
 */
export function stopJobs(): void {
	const state = jobsState();
	state.stopped = true;
	for (const kindState of state.kinds.values()) {
		if (kindState.idleTick) clearInterval(kindState.idleTick);
		if (kindState.bootSweep) clearTimeout(kindState.bootSweep);
		clearBackoffTimer(kindState);
		kindState.idleTick = null;
		kindState.idleTickMs = null;
		kindState.bootSweep = null;
		kindState.running = false;
		kindState.initialized = false;
		kindState.drainRequestedAgain = false;
	}
}

/**
 * Says there is work. Counts the request. Does nothing more in a process that
 * has not started this kind (or has stopped it, or has it switched off), so a
 * script that reopens a job never becomes a second worker.
 *
 * "Switched off" is the switch as it is NOW, not as the idle tick last saw it.
 * A wake that finds a started kind paused while its switch says on starts it
 * then and there (sweeps first, as the tick would), instead of dropping this
 * wake and every other until the next tick: every kind before the engine read
 * its switch when it was woken, so turning a worker on took effect at once.
 */
export function wake(kind: JobKind): void {
	const state = kindScheduler(kind.name);
	state.wakeRequests += 1;
	if (jobsState().stopped) return;
	if (state.running) {
		startDrain(kind);
		return;
	}
	if (!state.initialized) return;
	try {
		if (!internalsOf(kind).definition.enabled()) return;
	} catch (error) {
		console.error(`${kind.logPrefix} Reading the switch failed`, { error });
		return;
	}
	void startKindLoops(kind, { atProcessBoot: false }).catch((error) => {
		console.error(`${kind.logPrefix} Worker failed to start`, { error });
	});
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

function budgetTimer(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * Claims and runs ONE eligible job in the caller's async context, so a `.txt`
 * upload can answer `succeeded` inside its own HTTP request instead of making the
 * person watch a spinner for work that takes 30 ms. Past the caps on purpose:
 * this is local CPU, not a backend seat, and capping it would serialise `.txt`
 * uploads behind a scanned PDF. The run belongs to the inline worker id, shares
 * the boot nonce, and goes on in the background if the budget runs out; the
 * caller reads the job afterwards and reports it honestly.
 *
 * The enable switch pauses this path too, or "off" would mean "off for big files
 * only" and an admin draining the box before a restart would still be taking work.
 */
export async function runInline(
	kind: JobKind,
	jobId: string,
	options: { budgetMs: number; signal?: AbortSignal },
): Promise<void> {
	const { definition } = internalsOf(kind);
	if (!definition.inline) return;
	if (jobsState().stopped || !definition.enabled()) return;
	const budgetMs = Math.max(0, options.budgetMs);
	if (budgetMs === 0 || options.signal?.aborted) return;

	const row = readJobRow(kind, jobId);
	if (!row || row.status !== "queued" || !definition.inline.eligible(row)) {
		return;
	}

	const workerId = workerIdOf(`${kind.name}-inline`);
	const claimed = claimNext(kind, { workerId, jobId, ignoreCaps: true });
	if (!claimed) return;

	// `runAttempt` never rejects, so racing it against the budget leaks nothing.
	// When it ends, however late, the kind is woken: a run that failed and was put
	// back in the queue behind a backoff must have its timer armed by a drain, not
	// wait for the next tick.
	const run = runAttempt(kind, claimed, { workerId }).then(() => wake(kind));
	await Promise.race([run, budgetTimer(budgetMs, options.signal)]);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export interface KindInspection {
	running: boolean;
	idleTickArmed: boolean;
	idleTickMs: number | null;
	/** `hasRef()` on the armed timer, or null when it cannot be asked. */
	idleTickRefed: boolean | null;
	backoffArmed: boolean;
	backoffFiresInMs: number | null;
	backoffRefed: boolean | null;
	bootSweepArmed: boolean;
	bootSweepRefed: boolean | null;
	/** Wakes requested, including the ones dropped. */
	wakeRequests: number;
	/** Drains actually started. */
	drainRuns: number;
}

/**
 * Test helper: what the scheduler has done and has armed, per kind. Facts and not
 * the handles themselves, so a test cannot clear a timer the scheduler still
 * believes it owns.
 */
export function inspectJobsForTests(): Record<string, KindInspection> {
	return Object.fromEntries(
		[...jobsState().kinds].map(([name, state]) => [
			name,
			{
				running: state.running,
				idleTickArmed: state.idleTick !== null,
				idleTickMs: state.idleTickMs,
				idleTickRefed: state.idleTick?.hasRef?.() ?? null,
				backoffArmed: state.backoff !== null,
				backoffFiresInMs:
					state.backoffFiresAtMs === null
						? null
						: state.backoffFiresAtMs - Date.now(),
				backoffRefed: state.backoff?.hasRef?.() ?? null,
				bootSweepArmed: state.bootSweep !== null,
				bootSweepRefed: state.bootSweep?.hasRef?.() ?? null,
				wakeRequests: state.wakeRequests,
				drainRuns: state.drainRuns,
			},
		]),
	);
}

/** Test helper: disarms every timer and forgets everything. */
export function resetJobsForTests(): void {
	const state = jobsState();
	for (const kindState of state.kinds.values()) {
		if (kindState.idleTick) clearInterval(kindState.idleTick);
		if (kindState.bootSweep) clearTimeout(kindState.bootSweep);
		clearBackoffTimer(kindState);
	}
	state.kinds.clear();
	state.running.clear();
	state.settleListeners.clear();
	state.stopped = false;
	workerIds.clear();
}
