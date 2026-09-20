// The Knowledge page's transport for the document-extraction ledger.
//
// INTEGRATOR NOTE — this module is deliberate, temporary glue.
//
// The phase spec puts `fetchExtractionJobs` / `retryExtraction` /
// `cancelExtraction` in `$lib/client/api/knowledge.ts` and the poller in
// `$lib/client/extraction-poll.ts`, both of which belong to the HTTP-surface
// slice and are being written in a parallel worktree. Editing them from here
// would mean two worktrees changing one file. So the Knowledge page codes
// against the endpoint contract (spec §2.10) through this module instead;
// once the client slice lands, collapse it: re-point the four exports at the
// shared ones and delete this file. The endpoint paths, the request shapes and
// the poll cadence below are the spec's, not inventions, so the swap is a
// change of import and nothing else.

import type { FetchLike } from "$lib/client/api/http";
import { requestJson } from "$lib/client/api/http";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import { isTerminalExtractionStatus } from "$lib/shared/extraction-status";

/** Spec §2.10: the batch endpoint answers 400 `too_many_artifact_ids` past this. */
export const EXTRACTION_POLL_MAX_IDS = 50;

/** Spec §4.2: tight while a user is watching a fresh upload, then calmer. */
export const EXTRACTION_POLL_FAST_INTERVAL_MS = 1000;
export const EXTRACTION_POLL_SLOW_INTERVAL_MS = 2500;
export const EXTRACTION_POLL_FAST_WINDOW_MS = 10_000;

export async function fetchExtractionJobs(
	artifactIds: string[],
	fetchImpl?: FetchLike,
): Promise<DocumentExtractionJobDTO[]> {
	const ids = Array.from(new Set(artifactIds.filter(Boolean))).slice(
		0,
		EXTRACTION_POLL_MAX_IDS,
	);
	if (ids.length === 0) return [];

	const query = new URLSearchParams({ artifactIds: ids.join(",") });
	const payload = await requestJson<{ jobs?: DocumentExtractionJobDTO[] }>(
		`/api/knowledge/extraction?${query.toString()}`,
		undefined,
		"Failed to load document processing status",
		fetchImpl,
	);
	return payload.jobs ?? [];
}

export async function retryExtraction(
	artifactId: string,
	fetchImpl?: FetchLike,
): Promise<DocumentExtractionJobDTO> {
	const payload = await requestJson<{ job: DocumentExtractionJobDTO }>(
		`/api/knowledge/extraction/${encodeURIComponent(artifactId)}/retry`,
		{ method: "POST" },
		"Failed to retry document processing",
		fetchImpl,
	);
	return payload.job;
}

export async function cancelExtraction(
	artifactId: string,
	fetchImpl?: FetchLike,
): Promise<DocumentExtractionJobDTO> {
	const payload = await requestJson<{ job: DocumentExtractionJobDTO }>(
		`/api/knowledge/extraction/${encodeURIComponent(artifactId)}/cancel`,
		{ method: "POST" },
		"Failed to cancel document processing",
		fetchImpl,
	);
	return payload.job;
}

export interface ExtractionPollerOptions {
	/** The ids to ask about on the NEXT tick. Read fresh every time. */
	getArtifactIds: () => string[];
	onJobs: (jobs: DocumentExtractionJobDTO[]) => void;
	onError?: (error: unknown) => void;
	fetchJobs?: (ids: string[]) => Promise<DocumentExtractionJobDTO[]>;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	now?: () => number;
	isHidden?: () => boolean;
}

export interface ExtractionPoller {
	/** Idempotent: arming an already-armed poller does nothing. */
	start: () => void;
	stop: () => void;
	/** Runs one poll immediately, outside the schedule. */
	pollNow: () => Promise<void>;
}

/**
 * Arms only while at least one tracked job is non-terminal, and disarms the
 * moment they all settle or the list empties — a Knowledge tab left open on a
 * library of finished documents makes no requests at all.
 *
 * Polling is skipped (but the timer keeps ticking) while the tab is hidden, so
 * a backgrounded tab costs nothing and a returning user gets fresh rows within
 * one interval rather than waiting for a visibility listener to fire.
 */
export function createExtractionPoller(
	options: ExtractionPollerOptions,
): ExtractionPoller {
	const fetchJobs = options.fetchJobs ?? ((ids) => fetchExtractionJobs(ids));
	const setTimer =
		options.setTimer ??
		((callback: () => void, ms: number) => setTimeout(callback, ms));
	const clearTimer =
		options.clearTimer ??
		((handle: unknown) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>));
	const now = options.now ?? (() => Date.now());
	const isHidden =
		options.isHidden ??
		(() =>
			typeof document !== "undefined" && document.visibilityState === "hidden");

	let handle: unknown = null;
	let armedAt = 0;
	let running = false;
	let inFlight = false;

	function intervalMs(): number {
		return now() - armedAt < EXTRACTION_POLL_FAST_WINDOW_MS
			? EXTRACTION_POLL_FAST_INTERVAL_MS
			: EXTRACTION_POLL_SLOW_INTERVAL_MS;
	}

	function schedule(): void {
		if (!running || handle !== null) return;
		handle = setTimer(() => {
			handle = null;
			void tick();
		}, intervalMs());
	}

	async function poll(): Promise<void> {
		const ids = options.getArtifactIds();
		if (ids.length === 0) {
			stop();
			return;
		}
		if (inFlight) return;
		inFlight = true;
		try {
			const jobs = await fetchJobs(ids);
			options.onJobs(jobs);
			if (jobs.every((job) => isTerminalExtractionStatus(job.status))) {
				stop();
			}
		} catch (error) {
			// A failed poll is not a verdict. Keep the schedule and try again —
			// the alternative is a row frozen on "Parsing" forever after one
			// dropped request.
			options.onError?.(error);
		} finally {
			inFlight = false;
		}
	}

	async function tick(): Promise<void> {
		if (!running) return;
		if (!isHidden()) {
			await poll();
		}
		schedule();
	}

	function start(): void {
		if (running) return;
		running = true;
		armedAt = now();
		schedule();
	}

	function stop(): void {
		running = false;
		if (handle !== null) {
			clearTimer(handle);
			handle = null;
		}
	}

	return { start, stop, pollNow: poll };
}
