// The two enqueue entry points. Every document that will ever need extracting
// enters the ledger through one of them, so there is exactly one place where a
// route decision is stamped and exactly one place where a dedupe hit
// short-circuits.

import {
	getUploadFormatGate,
	resolveEffectiveIntakeRoute,
} from "$lib/server/services/knowledge/format-availability";
import type { Artifact } from "$lib/server/services/knowledge/types";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import {
	isExtractionErrorCode,
	isUserRetryableExtractionErrorCode,
} from "$lib/shared/extraction-status";
import { getIntakeRoute } from "$lib/shared/file-types";
import { getExtractionConfig } from "./config";
import {
	enqueueExtractionJob,
	getExtractionJobRow,
	retryExtractionJob,
} from "./job-ledger";
import { mapExtractionJobRow } from "./read-model";
import type {
	DocumentExtractionIntakeRoute,
	DocumentExtractionJobRow,
} from "./types";
import {
	EXTRACTION_PRIORITY_READBACK,
	EXTRACTION_PRIORITY_UPLOAD,
} from "./types";
import {
	runDirectTextExtractionInline,
	wakeExtractionWorker,
} from "./worker-runner";

export interface StartUploadExtractionParams {
	userId: string;
	conversationId: string | null;
	artifact: Artifact;
	/** Already-known normalized artifact (dedupe hit) — short-circuits to `succeeded`. */
	existingNormalizedArtifactId?: string | null;
	/** Overrides the configured inline budget. 0 never waits. */
	inlineBudgetMs?: number;
	signal?: AbortSignal;
	hints?: Readonly<Record<string, unknown>> | null;
	now?: Date;
}

/**
 * Whether a re-upload of the same bytes is the user asking to try again.
 *
 * `canceled` always is: they stopped it, and dropping the file back in is the
 * plainest way of saying they changed their mind. A `failed` job depends
 * entirely on WHY it failed, and that question already has one answer —
 * `EXTRACTION_ERROR_POLICIES[code].userRetryable`, the same table the Retry
 * button is drawn from. A configuration failure (`backend_misconfigured`,
 * `auth_failed`, `protocol`) is about the server and an admin may well have
 * fixed it since; a refusal of the document itself (`unsupported_type`,
 * `document_unreadable`, `too_large`, `empty_result`, `internal`) is about
 * these exact bytes, and sending them a second time cannot change the answer.
 * A repaired or unlocked file has a different sha256, so it arrives as a new
 * document rather than as a re-upload of this one.
 *
 * A `failed` row with no readable code is treated as the latter: the ledger
 * only writes one on a path that already decided not to offer the button.
 */
function reuploadIsRetry(job: DocumentExtractionJobRow): boolean {
	if (job.status === "canceled") return true;
	if (job.status !== "failed") return false;
	return (
		isExtractionErrorCode(job.errorCode) &&
		isUserRetryableExtractionErrorCode(job.errorCode)
	);
}

/**
 * The re-upload half of the user's Retry button.
 *
 * It goes through `retryExtractionJob` rather than writing `queued` itself, so
 * a re-upload buys exactly what a button press buys: the total-attempt ceiling,
 * the outage accounting, the cancel-dropped remote handle, and a CAS that makes
 * the transition atomic. Two simultaneous re-uploads of the same failed file
 * therefore produce ONE retry — the loser's transaction reads `queued` and
 * refuses — and the row on disk is what both of them answer with.
 */
async function retryReusedUploadJob(params: {
	job: DocumentExtractionJobRow;
	userId: string;
	now?: Date;
}): Promise<DocumentExtractionJobRow> {
	if (!reuploadIsRetry(params.job)) return params.job;

	const retried = await retryExtractionJob({
		userId: params.userId,
		jobId: params.job.id,
		now: params.now,
	});
	if (retried) return retried;

	// Refused. Either the total-attempt ceiling is spent — where delete-and-
	// re-upload really is the only way on, and saying `queued` would be a
	// promise the ledger will not keep — or a concurrent re-upload already
	// moved the row. Re-read rather than answer from the stale snapshot.
	return (await getExtractionJobRow(params.job.id)) ?? params.job;
}

/**
 * The single enqueue entry point for uploads.
 *
 * A dedupe hit whose normalized artifact already exists never reaches the
 * worker: the job is born `succeeded`. That is belt and braces on top of the
 * partial UNIQUE index on `source_artifact_id`, which already makes a second
 * job for the same artifact impossible.
 *
 * That index is also why this function has to look at the job it got back. A
 * dedupe hit lands on the EXISTING row, so a document that failed once —
 * against a misconfigured backend, say — used to have its old terminal verdict
 * replayed into every later upload of the same bytes, with no new attempt and
 * no way out except deleting the document. Re-uploading is the user saying "try
 * this again", so a reused row that is terminal-but-not-successful is put back
 * through the ledger's retry path here, in the one place all three upload
 * routes already share.
 */
export async function startUploadExtraction(
	params: StartUploadExtractionParams,
): Promise<DocumentExtractionJobDTO> {
	const config = getExtractionConfig();
	// The MinerU-4 availability gate (phase5-6 spec §3.5, amended OQ2): on a
	// positively-detected pre-4.x backend, `html`/`htm` are stamped
	// `direct-text` instead of `mineru` — the only entry with a fallback route.
	// Never a network call: `getUploadFormatGate` fails open on a cold cache.
	const gate = await getUploadFormatGate();
	const route = resolveEffectiveIntakeRoute(
		params.artifact.name,
		params.artifact.mimeType ?? null,
		gate,
	);

	const { job: enqueued, reused } = await enqueueExtractionJob({
		userId: params.userId,
		conversationId: params.conversationId,
		origin: "upload",
		intakeRoute: route === "direct-text" ? "direct-text" : "mineru",
		fileName: params.artifact.name,
		mimeType: params.artifact.mimeType ?? null,
		sizeBytes: params.artifact.sizeBytes ?? 0,
		sourceArtifactId: params.artifact.id,
		priority: EXTRACTION_PRIORITY_UPLOAD,
		hints: params.hints,
		normalizedArtifactId: params.existingNormalizedArtifactId ?? null,
		failure:
			route === "reject"
				? {
						errorCode: "unsupported_type",
						errorMessage: `${params.artifact.name} is not a file type this app can read.`,
						retryable: false,
					}
				: null,
		now: params.now,
	});

	// Only a REUSED row can be terminal-but-unsuccessful here. A row this call
	// created is queued, born-succeeded on a dedupe hit, or born-failed
	// `unsupported_type`, and retrying the last of those immediately would be
	// asking the worker to read a file the registry has already refused.
	const job = reused
		? await retryReusedUploadJob({
				job: enqueued,
				userId: params.userId,
				now: params.now,
			})
		: enqueued;

	// Every path wakes, including the two that return without leaving a job of
	// their own queued. A wake is one claim query against an indexed status
	// scan, and the thing it costs nothing to catch is the job some OTHER
	// enqueue left behind a backoff gate: an idle box has no other reason to
	// look. The inline direct-text settle used to return here without waking at
	// all, which is why a `.txt` upload could not unstick anything.
	const dto = mapExtractionJobRow(job, config.maxAttempts);
	if (dto.status !== "queued") {
		wakeExtractionWorker();
		return dto;
	}

	if (job.intakeRoute === "direct-text") {
		const budgetMs = params.inlineBudgetMs ?? config.inlineBudgetMs;
		const settled = await runDirectTextExtractionInline({
			jobId: job.id,
			budgetMs,
			signal: params.signal,
		});
		if (settled) {
			wakeExtractionWorker();
			return settled;
		}
	}

	wakeExtractionWorker();
	return dto;
}

export interface StartGeneratedFileReadbackParams {
	userId: string;
	conversationId: string;
	assistantMessageId?: string | null;
	chatGeneratedFileId: string;
	fileName: string;
	mimeType: string | null;
	sizeBytes: number;
	hints?: Readonly<Record<string, unknown>> | null;
	now?: Date;
}

/**
 * The enqueue entry point for generated-file readback. Never waits: nobody is
 * sitting in front of a request for it, which is exactly why it queues at a
 * lower priority than a user's upload.
 */
export async function startGeneratedFileReadback(
	params: StartGeneratedFileReadbackParams,
): Promise<DocumentExtractionJobDTO> {
	const config = getExtractionConfig();
	const route = getIntakeRoute(params.fileName, params.mimeType);
	const intakeRoute: DocumentExtractionIntakeRoute =
		route === "direct-text" ? "direct-text" : "mineru";

	const { job } = await enqueueExtractionJob({
		userId: params.userId,
		conversationId: params.conversationId,
		origin: "generated_file_readback",
		intakeRoute,
		fileName: params.fileName,
		mimeType: params.mimeType,
		sizeBytes: params.sizeBytes,
		chatGeneratedFileId: params.chatGeneratedFileId,
		priority: EXTRACTION_PRIORITY_READBACK,
		hints: params.hints,
		failure:
			route === "reject"
				? {
						errorCode: "unsupported_type",
						errorMessage: `${params.fileName} is not a file type this app can read.`,
						retryable: false,
					}
				: null,
		now: params.now,
	});

	// Unconditional for the same reason as the upload path: a readback that
	// dedupes into a terminal row is still the only thing that happened on this
	// box for the last hour, and the queue may be holding a job behind a gate.
	const dto = mapExtractionJobRow(job, config.maxAttempts);
	wakeExtractionWorker();
	return dto;
}
