// The job status machine, as a pure function.
//
// Every ledger write is guarded by `WHERE status = <from>`, so SQLite already
// refuses to apply a transition the row has moved past. What SQL cannot say is
// which transitions are legal in the first place: without this table, a bug
// that reported `uploading` after `parsing` would simply move the status
// backwards and the UI would replay a phase the job had already left, and a
// bug that requeued a `succeeded` job would silently re-extract bytes that
// already have a normalized artifact.
//
// Terminal states have no outgoing edge at all EXCEPT the two user actions
// (`retryExtractionJob` from `failed` / `canceled`), which are modelled here as
// real edges rather than as exceptions, so the table is the whole truth.

import {
	type DocumentExtractionStatus,
	isTerminalExtractionStatus,
} from "$lib/shared/extraction-status";

const TRANSITIONS: Readonly<
	Record<DocumentExtractionStatus, readonly DocumentExtractionStatus[]>
> = {
	queued: ["uploading", "canceled", "failed"],
	uploading: [
		"parsing",
		"downloading",
		"indexing",
		"queued",
		"failed",
		"canceled",
	],
	parsing: ["downloading", "indexing", "queued", "failed", "canceled"],
	downloading: ["indexing", "queued", "failed", "canceled"],
	indexing: ["succeeded", "queued", "failed", "canceled"],
	// Terminal. `failed` and `canceled` re-open only through a user retry.
	succeeded: [],
	failed: ["queued"],
	canceled: ["queued"],
};

export const EXTRACTION_STATUS_TRANSITIONS = TRANSITIONS;

/**
 * True when `to` is a legal next status for `from`. A self-transition is always
 * false: repeating a phase is a heartbeat, not a state change, and the caller
 * must treat it as one.
 */
export function canTransitionExtractionStatus(
	from: DocumentExtractionStatus,
	to: DocumentExtractionStatus,
): boolean {
	return TRANSITIONS[from].includes(to);
}

/**
 * True when the worker may report `to` as a progress phase while holding a job
 * currently at `from`. Same phase = allowed (heartbeat only); a backwards move
 * is not.
 */
export function canReportExtractionPhase(
	from: DocumentExtractionStatus,
	to: DocumentExtractionStatus,
): boolean {
	return from === to || canTransitionExtractionStatus(from, to);
}

/** Terminal statuses never re-open on their own. */
export function isFrozenExtractionStatus(
	status: DocumentExtractionStatus,
): boolean {
	return isTerminalExtractionStatus(status) && TRANSITIONS[status].length === 0;
}
