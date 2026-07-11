/**
 * One shared interval-job spine for the memory backbone's background schedulers.
 *
 * Both the night-shift consolidation scheduler and the memory-maintenance
 * scheduler used to carry their own copies of the same machinery: a module-level
 * `schedulerStarted` flag, a `schedulerHandle`, a period read from config, the
 * `unref` call so the timer never pins the process alive, and (implicitly) the
 * need to not stack overlapping runs. This factors that into one place so there
 * is a single, testable definition of "run this async job every N minutes".
 *
 * Behavior contract (kept identical to the two hand-rolled schedulers):
 *   - `start()` reads the period once, and only arms a timer when it is a
 *     positive number of minutes; otherwise it is a no-op (feature disabled).
 *   - `start()` is idempotent — a second call while armed does nothing.
 *   - the interval handle is `unref`'d so it never keeps the process alive.
 *   - `stop()` clears the timer and re-arms the job for a later `start()`.
 * Added (a safety the callers assumed but never enforced): a run-guard skips a
 * tick while the previous run is still in flight, so a slow run can never stack.
 */
export type IntervalJob = {
	start(): void;
	stop(): void;
};

export function createIntervalJob(params: {
	/** Label used in the "scheduler enabled" log line (e.g. "MEMORY_MAINTENANCE"). */
	name: string;
	/**
	 * The period in minutes, or a getter evaluated at `start()` time so config
	 * changes are picked up on (re)start exactly as the old code read it inline.
	 */
	periodMinutes: number | (() => number | null | undefined);
	/** The async job to run on each tick. Rejections are swallowed (best-effort). */
	run: () => Promise<void>;
}): IntervalJob {
	let started = false;
	let handle: ReturnType<typeof setInterval> | null = null;
	let inFlight = false;

	function resolvePeriodMinutes(): number | null | undefined {
		return typeof params.periodMinutes === "function"
			? params.periodMinutes()
			: params.periodMinutes;
	}

	function tick(): void {
		// Run-guard: never stack a new run on top of one still in flight.
		if (inFlight) return;
		inFlight = true;
		Promise.resolve()
			.then(() => params.run())
			.catch(() => {
				// Best-effort background job; a thrown run must not crash the timer.
			})
			.finally(() => {
				inFlight = false;
			});
	}

	function start(): void {
		if (started) return;
		const periodMinutes = resolvePeriodMinutes();
		if (!periodMinutes || periodMinutes <= 0) return;

		started = true;
		handle = setInterval(tick, periodMinutes * 60_000);
		handle.unref?.();
		console.info(`[${params.name}] Scheduler enabled`, {
			intervalMinutes: periodMinutes,
		});
	}

	function stop(): void {
		if (handle) {
			clearInterval(handle);
			handle = null;
		}
		started = false;
	}

	return { start, stop };
}
