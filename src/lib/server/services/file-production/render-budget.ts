// The deadline and the cancel signal a renderer actually honours.
//
// `FILE_PRODUCTION_RENDERER_TIMEOUT_MS` was declared in `limits.ts` and read by
// nobody — the admin registry said so out loud with `effect: "unwired"`. The
// reason it was never wired is that the thing it has to bound is SYNCHRONOUS:
// the pdf-lib layout in `renderers/standard-report-pdf.ts` runs to completion
// on the event loop, measured at ~9.5 s for a source at the 2 MB ceiling. A
// `setTimeout` racing that promise cannot fire, because the timer queue is not
// reached until the layout has already finished — the timeout would only ever
// have "fired" after the work it was meant to stop.
//
// So the budget is cooperative. The renderers call `checkpoint()` at the points
// where their own state is consistent (a page boundary, a block boundary, a
// table row) and `yieldIfDue()` where they are allowed to await. `checkpoint()`
// is a clock comparison and throws; `yieldIfDue()` does the same and then, if
// enough uninterrupted work has gone by, hands the event loop back for one
// macrotask so the attempt's heartbeat, other requests and the abort signal are
// serviced.
//
// A macrotask (`setTimeout(…, 0)`) rather than a microtask on purpose: awaiting
// a resolved promise drains the microtask queue without ever returning to the
// event loop, so timers — including the heartbeat this exists to protect —
// still would not run.

/** One renderer's budget. Every field optional; an absent one means no bound. */
export interface RenderBudgetOptions {
	/** Wall-clock bound for the whole render. Omit for no deadline. */
	timeoutMs?: number;
	/** Cancel, a lost claim, or a shutdown. */
	signal?: AbortSignal;
	/** Injectable clock, so a test never waits on real time. */
	now?: () => number;
	/** Uninterrupted work after which `yieldIfDue` hands the loop back. */
	yieldEveryMs?: number;
}

/**
 * How long a renderer may run without giving the event loop a turn.
 *
 * 50 ms is short enough that the 15 s heartbeat can never miss a beat because
 * of layout, and long enough that the yields themselves cost nothing measurable
 * — a macrotask hop is tens of microseconds, so even 200 of them across a
 * 10-second render is well under the 10 % regression budget.
 */
export const DEFAULT_RENDER_YIELD_INTERVAL_MS = 50;

export type RenderAbortReason = "renderer_timeout" | "render_cancelled";

/**
 * Thrown out of a renderer that ran out of time or was cancelled.
 *
 * `code` is the ledger's error code for the verdict: `renderer_timeout` is one
 * of `FILE_PRODUCTION_LIMIT_ERROR_CODES` already, and `render_cancelled` is the
 * attempt being told to stop — which the ledger's CAS will refuse to record
 * anyway, since whatever cancelled it has already written the real verdict.
 */
export class FileProductionRenderAbortedError extends Error {
	readonly code: RenderAbortReason;

	constructor(code: RenderAbortReason, message: string) {
		super(message);
		this.name = "FileProductionRenderAbortedError";
		this.code = code;
	}
}

function macrotask(): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, 0);
		timer.unref?.();
	});
}

export class RenderBudget {
	private readonly now: () => number;
	private readonly deadline: number | null;
	private readonly signal: AbortSignal | undefined;
	private readonly yieldEveryMs: number;
	private lastYieldedAt: number;

	constructor(options: RenderBudgetOptions = {}) {
		this.now = options.now ?? (() => Date.now());
		this.signal = options.signal;
		this.yieldEveryMs = Math.max(
			1,
			options.yieldEveryMs ?? DEFAULT_RENDER_YIELD_INTERVAL_MS,
		);
		const startedAt = this.now();
		this.deadline =
			typeof options.timeoutMs === "number" &&
			Number.isFinite(options.timeoutMs) &&
			options.timeoutMs > 0
				? startedAt + options.timeoutMs
				: null;
		this.lastYieldedAt = startedAt;
	}

	/**
	 * Throws if the render is over its deadline or has been cancelled.
	 *
	 * Synchronous, so it can be called from inside layout code that has no way
	 * to await — which is most of it. Cancellation is checked first: a render
	 * nobody is waiting for should not be reported as a timeout.
	 */
	checkpoint(): void {
		if (this.signal?.aborted) {
			throw new FileProductionRenderAbortedError(
				"render_cancelled",
				"File production was cancelled while the document was being rendered.",
			);
		}
		if (this.deadline !== null && this.now() >= this.deadline) {
			throw new FileProductionRenderAbortedError(
				"renderer_timeout",
				"Rendering this document took longer than the configured renderer timeout.",
			);
		}
	}

	/**
	 * The same check, plus a turn of the event loop when this render has been
	 * holding it for longer than `yieldEveryMs`.
	 *
	 * Checked again AFTER the yield: the abort may well be the thing that was
	 * waiting for the loop, and continuing to lay out pages for a job that was
	 * cancelled a microsecond ago is exactly what this is here to stop.
	 */
	async yieldIfDue(): Promise<void> {
		this.checkpoint();
		if (this.now() - this.lastYieldedAt < this.yieldEveryMs) return;
		await macrotask();
		this.lastYieldedAt = this.now();
		this.checkpoint();
	}
}
