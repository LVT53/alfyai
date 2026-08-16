/**
 * Per-label query cost instrumentation for the execution seam (ADR-0059).
 *
 * This module owns *recording*, not deciding what to do with slow queries —
 * that is future work the seam exists to make possible. It stores nothing
 * but a label, a duration, and an outcome: no query text, no bound
 * parameters, no row data, no user ids. Safe to read from an admin surface
 * under the same content-free rules as `normal-chat-stability-snapshot.ts`.
 */

export type QueryTimingStatus = "ok" | "error";

export interface QueryTimingSample {
	label: string;
	durationMs: number;
	status: QueryTimingStatus;
}

export interface QueryLabelStats {
	label: string;
	count: number;
	errorCount: number;
	totalMs: number;
	maxMs: number;
}

const statsByLabel = new Map<string, QueryLabelStats>();

/**
 * Records one query's timing/outcome. Called by every `QueryExecutor.run`
 * invocation (see `query-executor.ts`) — this is the seam's instrumentation
 * actually firing on the hot path every time a migrated call site runs a
 * query, not an opt-in feature nothing exercises.
 */
export function recordQueryTiming(sample: QueryTimingSample): void {
	const existing = statsByLabel.get(sample.label);
	if (existing) {
		existing.count += 1;
		if (sample.status === "error") existing.errorCount += 1;
		existing.totalMs += sample.durationMs;
		existing.maxMs = Math.max(existing.maxMs, sample.durationMs);
		return;
	}
	statsByLabel.set(sample.label, {
		label: sample.label,
		count: 1,
		errorCount: sample.status === "error" ? 1 : 0,
		totalMs: sample.durationMs,
		maxMs: sample.durationMs,
	});
}

/** Compact per-label query cost snapshot, newest labels included. */
export function getQueryTimingSnapshot(): QueryLabelStats[] {
	return Array.from(statsByLabel.values()).map((entry) => ({ ...entry }));
}

/** Test-only: clears recorded stats so assertions don't see cross-test bleed. */
export function resetQueryTimingForTesting(): void {
	statsByLabel.clear();
}
