/**
 * Pure helpers for the FileProductionCard active/failed states (ADR-0043 Slice 4).
 *
 * These are intentionally side-effect free so they can be unit-tested in
 * isolation and reused by the Svelte component without dragging in runes.
 */

/** Maximum displayed elapsed time. A job still running after an hour is stale
 * and shown no further precision — the cap keeps the timer legible. */
const MAX_DISPLAYED_SECONDS = 59 * 60 + 59; // 59:59

/** A queued/running job whose createdAt is older than this is rendered in the
 * amber "stale" honesty state. Pure client heuristic (ADR-0043 Slice 4). */
export const STALE_THRESHOLD_MS = 90_000;

/**
 * Format the elapsed time between `createdAtMs` and `nowMs` as "m:ss".
 *
 * - Sub-minute durations render as "0:ss" with zero-padded seconds.
 * - Durations ≥ 1 minute render as "m:ss" (minutes unpadded, seconds padded).
 * - The display is capped at "59:59" so a long-stuck job stays legible.
 * - A negative elapsed (clock skew / future createdAt) clamps to "0:00".
 *
 * Both arguments are epoch milliseconds (matching `FileProductionJob.createdAt`,
 * which is a numeric epoch — see src/lib/types.ts).
 */
export function formatElapsed(createdAtMs: number, nowMs: number): string {
	const elapsedMs = nowMs - createdAtMs;
	if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
		return "0:00";
	}
	const totalSeconds = Math.min(
		Math.floor(elapsedMs / 1000),
		MAX_DISPLAYED_SECONDS,
	);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Whether a queued/running job should be shown in the amber "stale" honesty
 * state. True only when the elapsed time strictly exceeds {@link STALE_THRESHOLD_MS}.
 *
 * Boundary: exactly 90_000ms → `false` (only older-than-90s is stale).
 */
export function isStaleJob(createdAtMs: number, nowMs: number): boolean {
	const elapsedMs = nowMs - createdAtMs;
	if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
		return false;
	}
	return elapsedMs > STALE_THRESHOLD_MS;
}
