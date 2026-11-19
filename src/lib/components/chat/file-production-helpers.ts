/**
 * Pure helpers for the FileProductionCard active/failed states (ADR-0043 Slice 4).
 *
 * These are intentionally side-effect free so they can be unit-tested in
 * isolation and reused by the Svelte component without dragging in runes.
 */

import type { I18nKey } from "$lib/i18n";

/** What the card says for a failed job whose code it has no sentence for, or none. */
const FILE_PRODUCTION_FALLBACK_KEY: I18nKey =
	"fileProduction.failedDescription";

/**
 * The sentence a failed file job says for each code the file maker writes on it
 * (`job.error.code`), as the key of that sentence (the `fileProduction.error.*`
 * family in `i18n/chat.ts`, English and Hungarian). The server's own message is
 * English text written for the model and the log, so the card never shows it.
 *
 * The codes are open strings spread over the file maker's files, so
 * `tool-reason-words.test.ts` reads them from the source and fails on one that is
 * not in this map: a new code cannot ship without its sentence. Causes that read
 * the same to a person share a sentence; the codes that had their own keep them.
 */
export const FILE_PRODUCTION_ERROR_KEYS: Readonly<Record<string, I18nKey>> = {
	// Limits, on purpose (`file-production/limits.ts`).
	too_many_outputs: "fileProduction.error.too_many_outputs",
	source_too_large: "fileProduction.error.source_too_large",
	projection_too_large: "fileProduction.error.projection_too_large",
	page_limit_exceeded: "fileProduction.error.page_limit_exceeded",
	table_limit_exceeded: "fileProduction.error.table_limit_exceeded",
	chart_limit_exceeded: "fileProduction.error.chart_limit_exceeded",
	image_limit_exceeded: "fileProduction.error.image_limit_exceeded",
	renderer_timeout: "fileProduction.error.renderer_timeout",
	sandbox_timeout: "fileProduction.error.sandbox_timeout",
	output_file_too_large: "fileProduction.error.output_file_too_large",
	job_outputs_too_large: "fileProduction.error.job_outputs_too_large",
	// A spreadsheet too large to check is a file that is too large.
	xlsx_output_too_large: "fileProduction.error.output_file_too_large",

	// What the document or the request names that cannot be made.
	invalid_document_source: "fileProduction.error.invalid_document_source",
	unsupported_document_block: "fileProduction.error.unsupported_document_block",
	unsupported_table_structure:
		"fileProduction.error.unsupported_table_structure",
	unsupported_chart_type: "fileProduction.error.unsupported_chart_type",
	unsupported_chart_data: "fileProduction.error.unsupported_chart_data",
	unsupported_pdf_block: "fileProduction.error.unsupported_pdf_block",
	unsupported_output_type: "fileProduction.error.unsupported_output_type",
	unsupported_inline_text_output_type:
		"fileProduction.error.unsupported_output_type",
	// Intake refuses a program-mode request that names no output type, or an
	// output type the pipeline cannot produce. Both write a failed job.
	missing_program_output_type:
		"fileProduction.error.missing_program_output_type",
	unsupported_program_output_type:
		"fileProduction.error.unsupported_program_output_type",

	// A request the file maker cannot read: the model's call, or the body of one.
	invalid_tool_input: "fileProduction.error.request_unreadable",
	missing_file_production_request: "fileProduction.error.request_unreadable",
	invalid_file_production_request: "fileProduction.error.request_unreadable",
	unsupported_file_production_request:
		"fileProduction.error.request_unreadable",
	invalid_inline_text_request: "fileProduction.error.request_unreadable",
	missing_inline_text_content: "fileProduction.error.request_unreadable",
	invalid_json_body: "fileProduction.error.request_unreadable",
	missing_conversation_id: "fileProduction.error.request_unreadable",
	missing_idempotency_key: "fileProduction.error.request_unreadable",
	missing_request_title: "fileProduction.error.request_unreadable",
	unsupported_source_mode: "fileProduction.error.request_unreadable",
	invalid_program_language: "fileProduction.error.request_unreadable",
	missing_program_source: "fileProduction.error.request_unreadable",
	missing_program_requested_outputs: "fileProduction.error.request_unreadable",
	mixed_output_groups: "fileProduction.error.request_unreadable",

	// The program ran, and made nothing, or not the file that was asked for.
	program_no_outputs: "fileProduction.error.no_file_made",
	file_production_no_output_files: "fileProduction.error.no_file_made",
	program_output_type_mismatch: "fileProduction.error.wrong_file_made",
	program_output_filename_mismatch: "fileProduction.error.wrong_file_made",
	program_output_mime_mismatch: "fileProduction.error.wrong_file_made",
	program_output_signature_mismatch: "fileProduction.error.wrong_file_made",
	unexpected_program_output_files: "fileProduction.error.wrong_file_made",
	invalid_xlsx_output: "fileProduction.error.wrong_file_made",
	invalid_text_output: "fileProduction.error.wrong_file_made",
	xlsx_output_too_complex: "fileProduction.error.wrong_file_made",

	// The file maker, or the storage it writes to, broke.
	pdf_font_missing: "fileProduction.error.pdf_font_missing",
	document_render_failed: "fileProduction.error.document_render_failed",
	program_execution_threw: "fileProduction.error.maker_problem",
	program_execution_failed: "fileProduction.error.maker_problem",
	program_output_storage_failed: "fileProduction.error.maker_problem",
	generated_document_source_persistence_failed:
		"fileProduction.error.maker_problem",
	inline_text_write_failed: "fileProduction.error.maker_problem",
	tool_execution_failed: "fileProduction.error.maker_problem",

	// A job the ledger reclaimed after a restart or a lost worker, or one that
	// never got picked up before its queue timeout. All three are retryable: the
	// card still offers Retry, as for any other retryable failure.
	worker_heartbeat_timeout: "fileProduction.error.worker_heartbeat_timeout",
	worker_state_lost: "fileProduction.error.worker_state_lost",
	worker_queue_timeout: "fileProduction.error.worker_queue_timeout",

	// A change to an earlier file that cannot be made.
	no_previous_version_for_patches: "fileProduction.error.patch_not_applied",
	patch_failed: "fileProduction.error.patch_not_applied",
	patch_not_applicable: "fileProduction.error.patch_not_applied",

	// As many files, and as many tries at one, as one reply allows.
	produce_file_turn_limit: "fileProduction.error.reply_file_limit",
	produce_file_turn_retry_limit: "fileProduction.error.reply_file_limit",

	// The attempt was told to stop: the sentence every tool row says for a stop.
	render_cancelled: "toolRows.shared.stopped",

	// Set on a placeholder card when its produce_file tool call fails before a
	// real job ever gets queued (`buildPendingFileProductionJobPlaceholder` and
	// `failPendingFileProductionJobPlaceholder` in the chat page's `_helpers`).
	tool_failed: "fileProduction.error.tool_failed",
};

/**
 * The key of the sentence a failed job's code says: its own, or the card's
 * fallback for a code it has no words for, an empty one or none. The lookup asks
 * the map for its own keys only, so a code spelled like an object's own names
 * (`constructor`, `toString`) is no hit.
 */
export function fileProductionErrorKey(
	code: string | null | undefined,
): I18nKey {
	return code && Object.hasOwn(FILE_PRODUCTION_ERROR_KEYS, code)
		? FILE_PRODUCTION_ERROR_KEYS[code]
		: FILE_PRODUCTION_FALLBACK_KEY;
}

/** Maximum displayed elapsed time. A job still running after an hour is stale
 * and shown no further precision — the cap keeps the timer legible. */
const MAX_DISPLAYED_SECONDS = 59 * 60 + 59; // 59:59

/** A queued/running job whose createdAt is older than this is rendered in the
 * amber "stale" honesty state. Pure client heuristic (ADR-0043 Slice 4). */
const STALE_THRESHOLD_MS = 90_000;

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

/**
 * Item 6 (UX-speed plan) — a client-only "queued" FileProductionJob stand-in
 * shown the instant a produce_file tool call starts, before the server has
 * ever heard of it. Its id is prefixed with this marker so it can never be
 * confused with a server-issued job id, and every job-mutating surface
 * (retry/cancel/dismiss in FileProductionCard.svelte, the merge logic in
 * routes/(app)/chat/[conversationId]/_helpers.ts) checks the marker before
 * doing anything that would otherwise hit the server with a made-up id.
 */
export const PENDING_FILE_PRODUCTION_JOB_ID_PREFIX = "pending:";

export function isPendingFileProductionJobId(jobId: string): boolean {
	return jobId.startsWith(PENDING_FILE_PRODUCTION_JOB_ID_PREFIX);
}
