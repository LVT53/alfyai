/**
 * Owns one admitted turn's wall-clock and meaningful-activity bounds.
 *
 * `expiresAt` is the instant the turn is cut off for good, not the model
 * engine's deadline: the transport that creates the watchdog passes the model
 * deadline plus the finalization window (`TURN_FINALIZATION_WINDOW_MS`), so the
 * engine keeps exactly `requestTimeoutMs` of model time (it has its own timers
 * and cuts itself at that deadline) and the watchdog is the backstop that gives
 * what comes after it (the language call, the follow-up chips, the save) its own
 * time and still ends a real hang in an explicit failure. Never hand
 * `expiresAt` to the engine.
 */
export function createTurnWatchdog(
	controller: AbortController,
	expiresAt: number,
) {
	const timeout = new AbortController();
	const expire = () => {
		timeout.abort(
			new DOMException("Chat turn deadline exceeded", "TimeoutError"),
		);
		if (!controller.signal.aborted)
			controller.abort(
				new DOMException("Chat turn deadline exceeded", "TimeoutError"),
			);
	};
	const overall = setTimeout(expire, Math.max(0, expiresAt - Date.now()));
	overall.unref?.();
	if (expiresAt <= Date.now()) expire();
	let idle: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	const touch = () => {
		if (disposed || controller.signal.aborted) return;
		if (idle) clearTimeout(idle);
		idle = setTimeout(
			expire,
			Math.min(150000, Math.max(0, expiresAt - Date.now())),
		);
		idle.unref?.();
	};
	touch();
	return {
		expiresAt,
		signal: controller.signal,
		timeoutSignal: timeout.signal,
		touch,
		wait<T>(work: PromiseLike<T>, settleStop = false): Promise<T> {
			const signal = settleStop
				? timeout.signal
				: AbortSignal.any([controller.signal, timeout.signal]);
			return new Promise<T>((resolve, reject) => {
				const abort = () => reject(signal.reason);
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
				Promise.resolve(work).then(
					(value) => {
						signal.removeEventListener("abort", abort);
						if (signal.aborted) abort();
						else resolve(value);
					},
					(error) => {
						signal.removeEventListener("abort", abort);
						reject(error);
					},
				);
			});
		},
		dispose() {
			disposed = true;
			clearTimeout(overall);
			if (idle) clearTimeout(idle);
		},
	};
}
