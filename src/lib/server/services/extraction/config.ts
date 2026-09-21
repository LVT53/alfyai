// The ledger's knobs, resolved per call.
//
// Every value is read through `getConfig()` at the moment it is needed rather
// than captured at module load, which is what lets all eleven keys be marked
// `effect: "live"` on the admin Advanced page honestly: an admin who lowers the
// concurrency cap sees it apply on the very next claim.

import { getConfig } from "$lib/server/config-store";

export interface ExtractionConfig {
	workerEnabled: boolean;
	maxConcurrency: number;
	perUserConcurrency: number;
	maxAttempts: number;
	retryBaseMs: number;
	retryMaxMs: number;
	staleAttemptMs: number;
	heartbeatMs: number;
	inlineBudgetMs: number;
	preflightWaitMs: number;
	maxDirectTextBytes: number;
}

/**
 * The stale window may never fall below this many heartbeat periods.
 *
 * The floor is about the event loop, not about the backend: an attempt writes
 * `heartbeat_at` every `heartbeatMs`, so a window of one or two periods would
 * reclaim a perfectly healthy attempt the first time a garbage collection or a
 * burst of SQLite writes delayed one beat. Four periods means three beats have
 * to be missed in a row before the worker is called dead.
 */
export const EXTRACTION_STALE_HEARTBEAT_FLOOR = 4;

export function getExtractionConfig(): ExtractionConfig {
	const config = getConfig();
	const heartbeatMs = config.documentExtractionHeartbeatMs;

	return {
		workerEnabled: config.documentExtractionWorkerEnabled,
		maxConcurrency: config.documentExtractionMaxConcurrency,
		perUserConcurrency: config.documentExtractionPerUserConcurrency,
		maxAttempts: config.documentExtractionMaxAttempts,
		retryBaseMs: config.documentExtractionRetryBaseMs,
		retryMaxMs: config.documentExtractionRetryMaxMs,
		// The stale window used to be dragged up to `mineruTimeoutMs * 2` (OQ5),
		// on the theory that an attempt must not be reclaimed while its own HTTP
		// call is still in flight. That theory no longer holds: the heartbeat runs
		// on its own interval through every phase, indexing included, and an
		// extractor call is async I/O that does not block it. Coupling the two
		// only bought latency — a 600 s backend timeout turned every orphaned
		// attempt into a 20-minute wait before anything noticed. What the window
		// genuinely must clear is the heartbeat itself.
		staleAttemptMs: Math.max(
			config.documentExtractionStaleAttemptMs,
			heartbeatMs * EXTRACTION_STALE_HEARTBEAT_FLOOR,
		),
		heartbeatMs,
		inlineBudgetMs: config.documentExtractionInlineBudgetMs,
		preflightWaitMs: config.documentExtractionPreflightWaitMs,
		maxDirectTextBytes: config.documentExtractionMaxDirectTextBytes,
	};
}
