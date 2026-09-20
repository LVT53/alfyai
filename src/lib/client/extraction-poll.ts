// The one extraction poller.
//
// Three surfaces want the same answer — the composer, the landing page and the
// Knowledge list — and ADR-0005 already ruled polling rather than a second SSE
// channel for job cards. Three independent `setInterval`s would be three poll
// storms, so this is the single module all three mount, with the storm
// defences built in rather than left to each caller:
//
//   • it is armed ONLY while something it tracks is non-terminal,
//   • it polls every second for the first ten (the window where a direct-text
//     or small-PDF job actually settles) and every 2.5 s after that,
//   • it stops entirely while the tab is hidden and polls once on return,
//   • it never has two requests in flight, and
//   • `stop()` leaves no timer and no listener behind.
//
// It holds no framework state: the caller supplies the ids and receives the
// DTOs, so the same module serves a Svelte 5 rune component and a plain page.

import type { FetchLike } from "$lib/client/api/http";
import { fetchExtractionJobs } from "$lib/client/api/knowledge";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import {
	EXTRACTION_STATUS_BATCH_LIMIT,
	isDocumentExtractionStatus,
	isTerminalExtractionStatus,
} from "$lib/shared/extraction-status";

/** Poll cadence while a job is young enough to plausibly be about to finish. */
export const EXTRACTION_POLL_FAST_MS = 1000;
/** Poll cadence after {@link EXTRACTION_POLL_ESCALATE_AFTER_MS}. */
export const EXTRACTION_POLL_SLOW_MS = 2500;
/** How long the fast cadence lasts, measured from the moment the poller armed. */
export const EXTRACTION_POLL_ESCALATE_AFTER_MS = 10_000;
/**
 * The batch endpoint's own cap, so asking for more is impossible rather than
 * a 400. A caller with a long list is chunked, never refused.
 */
export const EXTRACTION_POLL_BATCH_SIZE = EXTRACTION_STATUS_BATCH_LIMIT;

export interface ExtractionPollerOptions {
	/** The artifacts to ask about, re-read on every tick. */
	getArtifactIds: () => string[];
	/** Called with whatever the endpoint answered, terminal rows included. */
	onJobs: (jobs: DocumentExtractionJobDTO[]) => void;
	/** Swallowed by default: a failed poll is retried, never surfaced. */
	onError?: ((error: unknown) => void) | undefined;
	fetchImpl?: FetchLike | undefined;
	/** Test seam over the client API call. */
	fetchJobs?:
		| ((artifactIds: string[]) => Promise<DocumentExtractionJobDTO[]>)
		| undefined;
	/** Test seam over `Date.now`. */
	now?: (() => number) | undefined;
}

export interface ExtractionPoller {
	/**
	 * Re-evaluate whether to be polling. Call it whenever the tracked set
	 * changes (an attachment added or removed) or a DTO arrives from somewhere
	 * other than this poller (the upload response, a Retry).
	 */
	sync(): void;
	/** Poll once, right now, regardless of cadence. */
	refresh(): Promise<void>;
	/** Adopt a DTO this poller did not fetch, so arming sees it too. */
	observe(job: DocumentExtractionJobDTO): void;
	/** Clears the timer and the visibility listener. Idempotent. */
	stop(): void;
	/** Diagnostics for the tests: whether a timer is currently armed. */
	readonly active: boolean;
}

function isHidden(): boolean {
	return (
		typeof document !== "undefined" && document.visibilityState === "hidden"
	);
}

function chunk(ids: string[], size: number): string[][] {
	const batches: string[][] = [];
	for (let index = 0; index < ids.length; index += size) {
		batches.push(ids.slice(index, index + size));
	}
	return batches;
}

export function createExtractionPoller(
	options: ExtractionPollerOptions,
): ExtractionPoller {
	const now = options.now ?? (() => Date.now());
	const fetchJobs =
		options.fetchJobs ??
		((artifactIds: string[]) =>
			fetchExtractionJobs(artifactIds, options.fetchImpl));

	// What this poller last saw per artifact. An id it has never seen a DTO for
	// counts as unsettled, which is what keeps the very first tick from being
	// skipped, and what makes an optimistic chip poll until the server agrees.
	const lastStatus = new Map<string, string>();
	// Ids the endpoint declined to answer for: unknown, or owned by somebody
	// else. Held apart from `lastStatus` rather than faked into it, so nothing
	// downstream can mistake "not answered" for a status the server reported.
	const unresolved = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | null = null;
	let armedAt: number | null = null;
	let inFlight = false;
	let stopped = false;
	let listening = false;

	function trackedIds(): string[] {
		const tracked = new Set(
			options
				.getArtifactIds()
				.map((id) => id.trim())
				.filter(Boolean),
		);
		// Remembered state for an id the caller dropped is state nothing will
		// ever clear otherwise: a composer that uploads and removes files all
		// afternoon grew both maps without bound, and a document removed and
		// re-added was answered from the status of the row it no longer has.
		for (const id of lastStatus.keys()) {
			if (!tracked.has(id)) lastStatus.delete(id);
		}
		for (const id of unresolved) {
			if (!tracked.has(id)) unresolved.delete(id);
		}
		return Array.from(tracked);
	}

	function hasUnsettled(ids: string[]): boolean {
		return ids.some((id) => {
			if (unresolved.has(id)) return false;
			const status = lastStatus.get(id);
			if (status === undefined) return true;
			return !(
				isDocumentExtractionStatus(status) && isTerminalExtractionStatus(status)
			);
		});
	}

	function clearTimer() {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	}

	function intervalMs(): number {
		if (armedAt === null) return EXTRACTION_POLL_FAST_MS;
		return now() - armedAt < EXTRACTION_POLL_ESCALATE_AFTER_MS
			? EXTRACTION_POLL_FAST_MS
			: EXTRACTION_POLL_SLOW_MS;
	}

	function handleVisibilityChange() {
		if (stopped) return;
		if (isHidden()) {
			clearTimer();
			return;
		}
		// Back from a hidden tab: answer immediately rather than after a tick,
		// because the job very likely finished while nobody was looking.
		void poll();
	}

	function ensureListening() {
		if (listening || typeof document === "undefined") return;
		document.addEventListener("visibilitychange", handleVisibilityChange);
		listening = true;
	}

	function schedule() {
		if (stopped || isHidden()) {
			clearTimer();
			return;
		}
		const ids = trackedIds();
		if (ids.length === 0 || !hasUnsettled(ids)) {
			clearTimer();
			armedAt = null;
			return;
		}
		if (armedAt === null) armedAt = now();
		ensureListening();
		// An already-armed timer is left alone. `sync()` is called on every
		// attachment change, and re-arming each time would let a user adding
		// files quickly postpone the poll indefinitely.
		if (timer !== null) return;
		timer = setTimeout(() => {
			timer = null;
			void poll();
		}, intervalMs());
	}

	async function poll(): Promise<void> {
		if (stopped || inFlight) return;
		const ids = trackedIds();
		if (ids.length === 0) {
			armedAt = null;
			clearTimer();
			return;
		}

		inFlight = true;
		try {
			const jobs: DocumentExtractionJobDTO[] = [];
			// Ids from chunks that actually came back. A chunk that throws leaves
			// its own ids unknown; marking them unresolved on the strength of a
			// failed request would retire them permanently over one 500.
			const asked = new Set<string>();
			let failure: unknown;
			let failed = false;

			for (const batch of chunk(ids, EXTRACTION_POLL_BATCH_SIZE)) {
				try {
					const fetched = await fetchJobs(batch);
					for (const id of batch) asked.add(id);
					jobs.push(...fetched);
				} catch (error) {
					// Keep what the earlier chunks already answered. Throwing the
					// whole poll away meant a Knowledge page past fifty documents
					// could show nothing at all because its last chunk hiccuped.
					failure = error;
					failed = true;
					break;
				}
			}

			if (stopped) return;

			const answered = new Set<string>();
			for (const job of jobs) {
				if (!job.sourceArtifactId) continue;
				answered.add(job.sourceArtifactId);
				unresolved.delete(job.sourceArtifactId);
				lastStatus.set(job.sourceArtifactId, job.status);
			}
			// An id the endpoint omitted is one it could not resolve for this
			// user. Polling it again forever would be a storm with no possible
			// answer, so it stops being tracked.
			for (const id of asked) {
				if (!answered.has(id)) unresolved.add(id);
			}
			if (jobs.length > 0) options.onJobs(jobs);

			// Reported only after the partial answer has been delivered, so the
			// failure is still handled exactly as before.
			if (failed) throw failure;
		} catch (error) {
			if (stopped) return;
			options.onError?.(error);
			if (isUnrecoverablePollError(error)) {
				// A session that ended in another tab answers 401 to every poll,
				// for as long as the tab stays open. Retrying that forever is a
				// request every 2.5 s that can never succeed, and on the composer
				// it is silent (`onError` is a no-op there) while Send stays
				// blocked because no DTO ever arrives. The same reasoning covers
				// 403: neither gets better by asking again.
				stopped = true;
				clearTimer();
				armedAt = null;
			}
		} finally {
			inFlight = false;
			if (!stopped) schedule();
		}
	}

	return {
		sync() {
			if (stopped) return;
			schedule();
		},
		refresh() {
			return poll();
		},
		observe(job: DocumentExtractionJobDTO) {
			if (!job.sourceArtifactId) return;
			unresolved.delete(job.sourceArtifactId);
			lastStatus.set(job.sourceArtifactId, job.status);
		},
		stop() {
			stopped = true;
			clearTimer();
			armedAt = null;
			if (listening && typeof document !== "undefined") {
				document.removeEventListener(
					"visibilitychange",
					handleVisibilityChange,
				);
				listening = false;
			}
		},
		get active() {
			return timer !== null;
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Errors no number of retries can fix. Everything else — a dropped connection,
 * a 500, a restart mid-deploy — is transient and keeps its retry.
 *
 * Read structurally rather than with `instanceof ApiError`: the poller takes an
 * injected `fetchJobs`, so the rejection may come from a caller's own client.
 */
function isUnrecoverablePollError(error: unknown): boolean {
	if (!isRecord(error)) return false;
	const status = error.status;
	return status === 401 || status === 403;
}

/**
 * Reads an extraction DTO out of whatever the upload endpoint answered.
 *
 * The upload response grows this field in a parallel slice, and a build
 * without it must not crash or draw a chip that never resolves — so this
 * validates structurally and answers `null` for the old shape, which the chip
 * presentation reads as "say nothing", exactly what the composer did before
 * the ledger existed.
 */
export function readExtractionJobDTO(
	value: unknown,
): DocumentExtractionJobDTO | null {
	if (!isRecord(value)) return null;
	if (typeof value.id !== "string" || !value.id) return null;
	if (!isDocumentExtractionStatus(value.status)) return null;
	return value as unknown as DocumentExtractionJobDTO;
}

/** The `extraction` field of a knowledge-upload response, when there is one. */
export function extractionFromUploadResponse(
	response: unknown,
): DocumentExtractionJobDTO | null {
	if (!isRecord(response)) return null;
	return readExtractionJobDTO(response.extraction);
}
