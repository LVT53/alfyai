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

import { fetchExtractionJobs } from "$lib/client/api/knowledge";
import type { FetchLike } from "$lib/client/api/http";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import {
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
 * Mirrors `MAX_EXTRACTION_ARTIFACT_IDS` in
 * `src/routes/api/knowledge/extraction/+server.ts`. Asking for more is a 400,
 * so a caller with a long list is chunked rather than refused.
 */
export const EXTRACTION_POLL_BATCH_SIZE = 50;

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
		return Array.from(
			new Set(options.getArtifactIds().map((id) => id.trim()).filter(Boolean)),
		);
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
			for (const batch of chunk(ids, EXTRACTION_POLL_BATCH_SIZE)) {
				jobs.push(...(await fetchJobs(batch)));
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
			for (const id of ids) {
				if (!answered.has(id)) unresolved.add(id);
			}
			if (jobs.length > 0) options.onJobs(jobs);
		} catch (error) {
			if (!stopped) options.onError?.(error);
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
				document.removeEventListener("visibilitychange", handleVisibilityChange);
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
