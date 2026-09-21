// The two enqueue entry points. Every document that will ever need extracting
// enters the ledger through one of them, so there is exactly one place where a
// route decision is stamped and exactly one place where a dedupe hit
// short-circuits.

import type { Artifact } from "$lib/server/services/knowledge/types";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import { getIntakeRoute } from "$lib/shared/file-types";
import { getExtractionConfig } from "./config";
import { enqueueExtractionJob } from "./job-ledger";
import { mapExtractionJobRow } from "./read-model";
import type { DocumentExtractionIntakeRoute } from "./types";
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
 * The single enqueue entry point for uploads.
 *
 * A dedupe hit whose normalized artifact already exists never reaches the
 * worker: the job is born `succeeded`. That is belt and braces on top of the
 * partial UNIQUE index on `source_artifact_id`, which already makes a second
 * job for the same artifact impossible — together they are why re-uploading the
 * same bytes cannot re-extract them.
 */
export async function startUploadExtraction(
	params: StartUploadExtractionParams,
): Promise<DocumentExtractionJobDTO> {
	const config = getExtractionConfig();
	const route = getIntakeRoute(
		params.artifact.name,
		params.artifact.mimeType ?? null,
	);

	const { job } = await enqueueExtractionJob({
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
