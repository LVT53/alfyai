/** Owns one admitted turn's wall-clock and meaningful-activity bounds. */
export function createTurnWatchdog(
	controller: AbortController,
	deadlineAt: number,
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
	const overall = setTimeout(expire, Math.max(0, deadlineAt - Date.now()));
	overall.unref?.();
	if (deadlineAt <= Date.now()) expire();
	let idle: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	const touch = () => {
		if (disposed || controller.signal.aborted) return;
		if (idle) clearTimeout(idle);
		idle = setTimeout(
			expire,
			Math.min(150000, Math.max(0, deadlineAt - Date.now())),
		);
		idle.unref?.();
	};
	touch();
	return {
		deadlineAt,
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
