// The engine's per-process state, held on `globalThis` under a `Symbol.for` key.
//
// A module-level binding makes a double IMPORT harmless (the module registry
// hands back one instance) but not an HMR re-EVALUATION: vite gives the new
// instance a fresh set of bindings while the old instance's timers keep firing
// beside the new one's. Two schedulers against one table is not a correctness
// bug, since every claim is a compare-and-set, but it is two sweeps and two
// drains per tick for as long as the dev server lives. A `Symbol.for` key is the
// one thing every instance shares, so every instance finds the same timers, the
// same running attempts and the same listeners.
//
// Everything here is plain data. The behaviour that uses it lives in
// `scheduler.ts`, `runner.ts`, `events.ts` and `ledger.ts`; this file imports
// none of them, so any of them can import this one.

import type { JobAbortReason, JobKind, JobStatus } from "./types";

/** An attempt this process is running, so a cancel can reach it at once. */
export interface RunningAttempt {
	kindName: string;
	jobId: string;
	controller: AbortController;
}

/** One kind's scheduler. Created the first time anything asks for it. */
export interface KindSchedulerState {
	kind: JobKind | null;
	/** `startJobs` has seen this kind (the idle tick is armed, or was). */
	initialized: boolean;
	/** True only while timers may be armed: started, enabled, not stopped. */
	running: boolean;
	idleTick: ReturnType<typeof setInterval> | null;
	idleTickMs: number | null;
	backoff: ReturnType<typeof setTimeout> | null;
	/** Epoch ms the armed backoff timer fires at, for the no-stacking check. */
	backoffFiresAtMs: number | null;
	bootSweep: ReturnType<typeof setTimeout> | null;
	/** Epoch ms of the last stale sweep, so a drain sweeps at most once per tick. */
	lastRecoveryAt: number;
	/** Every call to `wake`, including the ones dropped. */
	wakeRequests: number;
	/** Drains actually started, so a dropped wake is visible to a test. */
	drainRuns: number;
	drainPromise: Promise<void> | null;
	/** A wake that arrived while a drain was running, to be honoured after it. */
	drainRequestedAgain: boolean;
	/** Test seam: how `startJobs` decides a pid is gone. */
	isProcessAlive: ((pid: number) => boolean) | null;
}

export type SettleEventListener = (event: {
	kind: string;
	jobId: string;
	status: JobStatus;
}) => void;

export interface JobsGlobalState {
	kinds: Map<string, KindSchedulerState>;
	/** By attempt id. */
	running: Map<string, RunningAttempt>;
	/** By `<kind>:<jobId>`. */
	settleListeners: Map<string, Set<SettleEventListener>>;
	/** `stopJobs` was called: no new claims, no new timers. Cleared by `startJobs`. */
	stopped: boolean;
}

const STATE_KEY = Symbol.for("alfyai.jobs.state");

export function jobsState(): JobsGlobalState {
	const host = globalThis as typeof globalThis & {
		[STATE_KEY]?: JobsGlobalState;
	};
	host[STATE_KEY] ??= {
		kinds: new Map(),
		running: new Map(),
		settleListeners: new Map(),
		stopped: false,
	};
	return host[STATE_KEY];
}

export function kindScheduler(kindName: string): KindSchedulerState {
	const { kinds } = jobsState();
	let state = kinds.get(kindName);
	if (!state) {
		state = {
			kind: null,
			initialized: false,
			running: false,
			idleTick: null,
			idleTickMs: null,
			backoff: null,
			backoffFiresAtMs: null,
			bootSweep: null,
			lastRecoveryAt: 0,
			wakeRequests: 0,
			drainRuns: 0,
			drainPromise: null,
			drainRequestedAgain: false,
			isProcessAlive: null,
		};
		kinds.set(kindName, state);
	}
	return state;
}

/**
 * Aborts the attempt this process is running, if it is running it. Called after
 * the commit that took the claim away, so a handler blocked on a network call
 * stops at once instead of at its next beat.
 */
export function abortRunningAttempt(
	attemptId: string,
	reason: JobAbortReason,
): void {
	const running = jobsState().running.get(attemptId);
	if (running && !running.controller.signal.aborted) {
		running.controller.abort(reason);
	}
}
