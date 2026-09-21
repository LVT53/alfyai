// The file-production worker's scheduling knobs, resolved per call.
//
// Read through `getConfig()` at the moment they are needed rather than captured
// at module load, which is what lets the one admin-editable key be marked
// `effect: "live"` honestly: an admin who lowers the stale window sees it apply
// on the very next sweep.

import { getConfig } from "$lib/server/config-store";

export interface FileProductionWorkerConfig {
	/** Heartbeat silence after which a running attempt is called dead. */
	staleAttemptMs: number;
	/** How often a running attempt writes `heartbeat_at`. */
	heartbeatMs: number;
}

/**
 * The heartbeat cadence. Not admin-editable: it is an implementation detail of
 * how the worker proves it is alive, and the only thing anyone actually wants
 * to tune — how long silence has to last before someone else may take the job —
 * is the stale window below.
 */
export const FILE_PRODUCTION_HEARTBEAT_MS = 15_000;

/**
 * The stale window may never fall below this many heartbeat periods.
 *
 * The floor is about the event loop, not about the sandbox. An attempt writes
 * `heartbeat_at` every `heartbeatMs` from its own `setInterval`, so a window of
 * one or two periods would reclaim a perfectly healthy attempt the first time a
 * garbage collection, a burst of SQLite writes, or one long synchronous render
 * delayed a beat. Four periods means three beats have to be missed in a row
 * before the worker is called dead.
 */
export const FILE_PRODUCTION_STALE_HEARTBEAT_FLOOR = 4;

/**
 * Two minutes, down from the ten this worker used to hard-code.
 *
 * Ten minutes was not a choice about liveness, it was a consequence: the worker
 * never heartbeated at all, so `heartbeat_at` was frozen at the claim and the
 * window had to be longer than the longest an attempt could legitimately take —
 * the 5-minute sandbox timeout, with slack. With a heartbeat on its own timer
 * the window only has to clear two things:
 *
 *   - the heartbeat cadence itself, hence the `× 4` floor above; and
 *   - the longest the event loop can be blocked by a SYNCHRONOUS render, which
 *     is the one thing that can stop the heartbeat timer from firing. Measured
 *     on this repo: the pdf-lib layout in `renderers/standard-report-pdf.ts`
 *     blocks for essentially its whole duration — 1.3 s for a 256 KB source,
 *     5.9 s for 1.2 MB, and 9.5 s for a source at the 2 MB
 *     `FILE_PRODUCTION_MAX_SOURCE_JSON_BYTES` ceiling, on an Apple-silicon dev
 *     box. DOCX peaks around 0.2 s and HTML/Markdown are microseconds.
 *
 * Allow a factor of three for a slower, loaded production box and the worst
 * case is ~30 s of silence from a perfectly healthy attempt. 120 s leaves four
 * times that headroom, is double the `heartbeat × 4` floor, and cuts the
 * worst-case recovery latency after a restart from ten minutes to two.
 */
export const FILE_PRODUCTION_DEFAULT_STALE_ATTEMPT_MS = 120_000;

export function getFileProductionWorkerConfig(): FileProductionWorkerConfig {
	const stored = (getConfig() as { fileProductionStaleAttemptMs?: number })
		.fileProductionStaleAttemptMs;
	const configured =
		typeof stored === "number" && Number.isFinite(stored) && stored > 0
			? stored
			: FILE_PRODUCTION_DEFAULT_STALE_ATTEMPT_MS;

	return {
		staleAttemptMs: Math.max(
			configured,
			FILE_PRODUCTION_HEARTBEAT_MS * FILE_PRODUCTION_STALE_HEARTBEAT_FLOOR,
		),
		heartbeatMs: FILE_PRODUCTION_HEARTBEAT_MS,
	};
}
