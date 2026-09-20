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

export function getExtractionConfig(): ExtractionConfig {
	const config = getConfig();

	return {
		workerEnabled: config.documentExtractionWorkerEnabled,
		maxConcurrency: config.documentExtractionMaxConcurrency,
		perUserConcurrency: config.documentExtractionPerUserConcurrency,
		maxAttempts: config.documentExtractionMaxAttempts,
		retryBaseMs: config.documentExtractionRetryBaseMs,
		retryMaxMs: config.documentExtractionRetryMaxMs,
		// OQ5, soft coupling: an attempt must never be reclaimed while its own
		// HTTP call is still legitimately in flight. An admin who raises the
		// backend timeout past the stale window would otherwise have live
		// attempts torn out from under a working backend, so the stale window
		// follows the timeout up instead of fighting it. Deliberately one-way:
		// lowering the backend timeout never shortens the stale window.
		staleAttemptMs: Math.max(
			config.documentExtractionStaleAttemptMs,
			config.mineruTimeoutMs * 2,
		),
		heartbeatMs: config.documentExtractionHeartbeatMs,
		inlineBudgetMs: config.documentExtractionInlineBudgetMs,
		preflightWaitMs: config.documentExtractionPreflightWaitMs,
		maxDirectTextBytes: config.documentExtractionMaxDirectTextBytes,
	};
}
