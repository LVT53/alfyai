import { type TransferListItem, Worker } from "node:worker_threads";
import {
	ImageDecodeTimeoutError,
	ImageDecodeUnavailableError,
	ImagePreparationError,
} from "./image-errors";

// Runs jobs of one kind, each in a worker thread of its own, a few at a time.
//
// The worker is made for ONE job: it runs `source` with the job's workerData,
// posts one message (the answer) and is let go. A fresh thread per job is the
// point. WebAssembly memory (libheif's heap) is never given back by a thread
// that stays, a trap or a crash costs one job and not the process, and
// `terminate()` really stops the code, which a timeout or a cancelled job needs.
// Nothing here knows what the job is: heif-decode.ts owns the source and
// reads the answer.

export interface DecodePoolOptions {
	/** Most workers alive at once. A job over that waits its turn, first come first served. */
	concurrency: number;
	/** How long a worker may run, counted from its start, before it is stopped. */
	timeoutMs: number;
	/** The worker's script: CommonJS source run with `eval: true`. */
	source: string;
}

export interface DecodeJob {
	/** Cloned into the worker (`workerData`). */
	workerData: unknown;
	/** Moved into the worker instead of cloned, as `new Worker`'s `transferList` does. */
	transferList?: readonly TransferListItem[];
	/**
	 * Ends the job when aborted: a waiting one never starts, a running one has its
	 * worker terminated. The job then rejects with `signal.reason`.
	 */
	signal?: AbortSignal;
}

export interface DecodePool {
	/** Resolves with the worker's first message. */
	run<T>(job: DecodeJob): Promise<T>;
	/** Workers alive now, a stopped one counted until it has really exited. For tests. */
	readonly running: number;
	/** Jobs waiting for a place. For tests. */
	readonly waiting: number;
}

interface QueuedJob {
	start(): void;
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createDecodePool(options: DecodePoolOptions): DecodePool {
	const queue: QueuedJob[] = [];
	let running = 0;

	function pump(): void {
		while (running < options.concurrency) {
			const next = queue.shift();
			if (!next) return;
			next.start();
		}
	}

	function run<T>(job: DecodeJob): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const { signal } = job;
			if (signal?.aborted) {
				reject(signal.reason);
				return;
			}

			let worker: Worker | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let settled = false;

			// The one place a job ends. Whatever ended it, its worker is stopped (a
			// worker that has answered is about to exit by itself, and terminating
			// it again is harmless) and its listeners and timer go.
			const settle = (outcome: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				// `terminate()` returns a promise, and an unhandled rejection would
				// end the process.
				worker?.terminate().catch(() => undefined);
				outcome();
			};
			const succeed = (value: unknown): void =>
				settle(() => resolve(value as T));
			const fail = (reason: unknown): void => settle(() => reject(reason));

			const onAbort = (): void => {
				const place = queue.indexOf(queued);
				if (place >= 0) queue.splice(place, 1);
				fail(signal?.reason);
			};

			const queued: QueuedJob = {
				start() {
					running += 1;
					try {
						worker = new Worker(options.source, {
							eval: true,
							workerData: job.workerData,
							transferList: job.transferList as TransferListItem[] | undefined,
						});
					} catch (error) {
						// No thread was made, so there is no exit to wait for. The system
						// would not make one (EAGAIN, ERR_WORKER_INIT_FAILED when it is out
						// of threads or memory): the box is at fault and not the photo, so
						// this is an error of its own and not a refusal of the file.
						running -= 1;
						fail(
							new ImageDecodeUnavailableError(
								`image decode worker could not start: ${reasonOf(error)}`,
								{ cause: error },
							),
						);
						return;
					}
					timer = setTimeout(
						() => fail(new ImageDecodeTimeoutError(options.timeoutMs)),
						options.timeoutMs,
					);
					worker.on("message", succeed);
					worker.on("error", (error) =>
						fail(
							new ImagePreparationError(
								`image decode worker failed: ${reasonOf(error)}`,
								{ cause: error },
							),
						),
					);
					worker.on("messageerror", (error) =>
						fail(
							new ImagePreparationError(
								"image decode worker sent an answer that could not be read",
								{ cause: error },
							),
						),
					);
					worker.on("exit", (code) => {
						// Does nothing for a job that has been answered or stopped.
						fail(
							new ImagePreparationError(
								`image decode worker exited with code ${code} without an answer`,
							),
						);
						// The place is free only when the thread (and its memory) is gone.
						running -= 1;
						pump();
					});
				},
			};

			signal?.addEventListener("abort", onAbort, { once: true });
			queue.push(queued);
			pump();
		});
	}

	return {
		run,
		get running() {
			return running;
		},
		get waiting() {
			return queue.length;
		},
	};
}
