// The end-of-take channel: one SSE body the take's route hands the browser, so
// a picture that settles outside a chat turn (Another, Try again, a take still
// running after a reload) reaches the card without waiting for the chat page's
// poll.
//
// A reader only: it never writes a job column and never decides a take's state.
// The engine's in-process settle event is the fast path; the row read once a
// second is the truth for a verdict this process did not announce (a restart,
// another process), and the same cadence `wait.ts` uses. The stream ends after
// the take settles, after the take disappears, or at its deadline, so a browser
// never holds a connection open for longer than a held take can last.

import { subscribeToJobSettled } from "$lib/server/services/jobs";
import { findOwnTake } from "./card-actions";
import { imageJob } from "./image-job";

/** A comment this often, so a proxy does not cut a quiet stream. */
const HEARTBEAT_MS = 15_000;
/** The row read behind the in-process event. */
const POLL_MS = 1_000;
/** The held-take window: a take a tool call holds lasts about 130 s at most. */
const TAKE_EVENT_DEADLINE_MS = 120_000;

/** The statuses a take never leaves. */
const SETTLED: ReadonlySet<string> = new Set([
	"succeeded",
	"failed",
	"cancelled",
]);

const encoder = new TextEncoder();

/**
 * The take's end over SSE: a comment heartbeat while it is being made, then ONE
 * `settled` event carrying `{ takeId, status }` and a `close` event. A take that
 * no longer exists (deleted in another tab) answers an `error` event instead.
 * The route passes the status it read to admit the request, so a take that had
 * already settled answers at once instead of waiting for an event that will
 * never come.
 */
export function createTakeSettledStream(params: {
	userId: string;
	takeId: string;
	conversationId?: string | null;
	/** What the route read before opening the stream. */
	initialStatus: string;
	/** The request's signal: the browser goes away and nothing outlives it. */
	signal?: AbortSignal;
}): ReadableStream<Uint8Array> {
	const { userId, takeId, initialStatus, signal } = params;
	const conversationId = params.conversationId ?? null;
	// One stop for the request's abort, the unsubscribe and the controller's
	// cancel: whichever comes first cleans up the rest.
	const own = new AbortController();

	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let stopped = false;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let poll: ReturnType<typeof setInterval> | null = null;
	let deadline: ReturnType<typeof setTimeout> | null = null;
	let polling = false;
	let stopListening: (() => void) | null = null;

	function finish(): void {
		if (stopped) return;
		stopped = true;
		if (heartbeat) clearInterval(heartbeat);
		if (poll) clearInterval(poll);
		if (deadline) clearTimeout(deadline);
		heartbeat = null;
		poll = null;
		deadline = null;
		stopListening?.();
		stopListening = null;
		own.abort();
		signal?.removeEventListener("abort", finish);
		try {
			controller?.close();
		} catch {
			// The browser cancelled the stream, or it is closed already.
		}
	}

	function write(chunk: string): void {
		if (stopped || !controller) return;
		try {
			controller.enqueue(encoder.encode(chunk));
		} catch {
			// The browser went away between two checks.
			finish();
		}
	}

	function send(event: string, data: unknown): void {
		write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	}

	function settle(status: string): void {
		if (stopped) return;
		send("settled", { takeId, status });
		send("close", {});
		finish();
	}

	function gone(): void {
		if (stopped) return;
		send("error", { takeId, error: "take_not_found" });
		send("close", {});
		finish();
	}

	/** The row read that backs the event, for a verdict written elsewhere. */
	async function readTake(): Promise<void> {
		if (stopped || polling) return;
		polling = true;
		try {
			const take = await findOwnTake({ userId, takeId, conversationId });
			if (stopped) return;
			if (!take) {
				gone();
				return;
			}
			if (SETTLED.has(take.status)) settle(take.status);
		} catch {
			// A row that cannot be read right now is not a verdict: the next tick tries again.
		} finally {
			polling = false;
		}
	}

	return new ReadableStream<Uint8Array>({
		start(streamController) {
			controller = streamController;
			if (signal?.aborted) {
				finish();
				return;
			}
			signal?.addEventListener("abort", finish, { once: true });

			// The route's read already had the verdict: answer without waiting for
			// an event this process will not announce.
			if (SETTLED.has(initialStatus)) {
				settle(initialStatus);
				return;
			}

			// This process settles it: the engine announces the verdict after its commit.
			stopListening = subscribeToJobSettled(
				imageJob,
				takeId,
				(event) => settle(event.status),
				{ signal: own.signal },
			);

			poll = setInterval(() => {
				void readTake();
			}, POLL_MS);
			poll.unref?.();

			heartbeat = setInterval(() => {
				write(": keep-alive\n\n");
			}, HEARTBEAT_MS);
			heartbeat.unref?.();

			deadline = setTimeout(() => {
				// Still not settled after the window a held take can last: say
				// goodbye, and the client keeps its poll.
				send("close", {});
				finish();
			}, TAKE_EVENT_DEADLINE_MS);
			deadline.unref?.();
		},
		cancel() {
			// The browser went away: nothing may keep running.
			finish();
		},
	});
}
