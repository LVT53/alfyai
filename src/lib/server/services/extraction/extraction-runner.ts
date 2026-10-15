// The extraction handler: one claimed attempt of an extraction job.
//
// The job engine (services/jobs) claims the job, keeps its lease alive on a timer
// of its own (indexing included: a long chunk-and-embed pass is not a dead
// worker), decides what a failure means (`extraction-job.ts` `onFailure`) and
// takes an attempt back when its worker is gone; this file is only the work:
// find the stored file, run the extractor, index the result, write the verdict.
// It is loaded on the first claim, so a route that reads, retries or cancels
// extraction jobs never imports the extractor registry, the MinerU client or
// `node:fs`.
//
// Every write the run makes goes through the context and is fenced: a run that
// lost the job (cancelled, or taken back) gets `false` and writes nothing, and
// its signal is already aborted. The one invariant that must not be broken here:
// no engine transaction is held across an `await` on an extractor. The extractor
// runs between transactions, never inside one.

import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	artifacts,
	chatGeneratedFiles,
	documentExtractionJobAttempts,
	documentExtractionJobs,
} from "$lib/server/db/schema";
import type { JobRunContext } from "$lib/server/services/jobs";
import {
	type DocumentExtractor,
	type ExtractDocumentResult,
	ExtractionAbortError,
	type ExtractionHandle,
	type ExtractionProgress,
	parseExtractionHandle,
	toDocumentExtractionError,
} from "./contracts";
import { resolveExtractor } from "./extractors/registry";
import { parseExtractionHints } from "./hints";
import { createNormalizedArtifactFromExtraction } from "./persist";
import { getGeneratedFileReadbackSink } from "./readback-sink";
import type {
	DocumentExtractionIntakeRoute,
	DocumentExtractionJobRow,
} from "./types";

interface ExtractionSource {
	filePathAbsolute: string;
	contentSha256: string | null;
	sourceName: string;
}

async function resolveExtractionSource(
	job: DocumentExtractionJobRow,
): Promise<ExtractionSource | null> {
	if (job.sourceArtifactId) {
		const [row] = await db
			.select({
				name: artifacts.name,
				storagePath: artifacts.storagePath,
				binaryHash: artifacts.binaryHash,
			})
			.from(artifacts)
			.where(
				and(
					eq(artifacts.id, job.sourceArtifactId),
					eq(artifacts.userId, job.userId),
				),
			)
			.limit(1);

		if (!row?.storagePath) return null;
		return {
			filePathAbsolute: join(process.cwd(), row.storagePath),
			contentSha256: row.binaryHash,
			sourceName: row.name,
		};
	}

	if (job.chatGeneratedFileId) {
		const [row] = await db
			.select({
				filename: chatGeneratedFiles.filename,
				storagePath: chatGeneratedFiles.storagePath,
			})
			.from(chatGeneratedFiles)
			.where(
				and(
					eq(chatGeneratedFiles.id, job.chatGeneratedFileId),
					eq(chatGeneratedFiles.userId, job.userId),
				),
			)
			.limit(1);

		if (!row?.storagePath) return null;
		return {
			filePathAbsolute: join(
				process.cwd(),
				"data",
				"chat-files",
				row.storagePath,
			),
			contentSha256: null,
			sourceName: row.filename,
		};
	}

	return null;
}

interface PersistedExtraction {
	artifactId: string;
	/** The chunk ceiling was hit, so retrieval covers only part of the text. */
	chunksTruncated: boolean;
}

async function persistExtraction(params: {
	job: DocumentExtractionJobRow;
	result: ExtractDocumentResult;
	source: ExtractionSource;
}): Promise<PersistedExtraction> {
	const { job, result, source } = params;

	if (job.origin === "generated_file_readback" && job.chatGeneratedFileId) {
		const sink = getGeneratedFileReadbackSink();
		if (!sink) {
			throw new Error(
				"No generated-file readback sink is registered; call setGeneratedFileReadbackSink().",
			);
		}
		const persisted = await sink({
			userId: job.userId,
			conversationId: job.conversationId,
			chatGeneratedFileId: job.chatGeneratedFileId,
			text: result.text,
			pageCount: result.pageCount ?? null,
			structured: result.structured,
		});
		return {
			artifactId: persisted.artifactId,
			chunksTruncated: persisted.chunksTruncated === true,
		};
	}

	if (!job.sourceArtifactId) {
		throw new Error(`Extraction job ${job.id} has no artifact to persist onto`);
	}

	const artifact = await createNormalizedArtifactFromExtraction({
		userId: job.userId,
		conversationId: job.conversationId,
		sourceArtifactId: job.sourceArtifactId,
		sourceName: source.sourceName,
		text: result.text,
		normalizedName: result.normalizedName,
		mimeType: result.mimeType,
		...(result.pageCount === undefined ? {} : { pageCount: result.pageCount }),
		structured: result.structured,
	});
	return {
		artifactId: artifact.id,
		chunksTruncated: artifact.metadata?.chunksTruncated === true,
	};
}

async function bestEffortRemoteCancel(
	extractor: DocumentExtractor,
	handle: ExtractionHandle | null,
): Promise<void> {
	if (!extractor.cancel || !handle) return;
	try {
		await extractor.cancel(handle);
	} catch (error) {
		// The job is already cancelled. A remote that will not clean up is an
		// operational annoyance, never something the user should be shown instead
		// of the cancel they asked for.
		console.warn("[EXTRACTION] Remote cancel failed", {
			extractor: extractor.name,
			error,
		});
	}
}

/**
 * The signal an extractor sees: the engine's, in the vocabulary the extractor
 * seam speaks.
 *
 * The engine aborts a run with `"cancelled"` or `"lease-lost"`; an extractor
 * decides what to do with the REMOTE job by the abort reason it reads off its
 * signal (`abortDiscardsRemoteWork`: only `user-cancel` may delete it, because a
 * lost claim means another attempt is about to resume the very job a delete
 * would destroy). So the reason crosses over as the seam's own
 * `ExtractionAbortError`, and the extractor needs no knowledge of the engine.
 *
 * The listener never throws, and `release` takes it off: the signal outlives
 * this attempt only as long as the runner holds it.
 */
function bridgeAbortSignal(engineSignal: AbortSignal): {
	signal: AbortSignal;
	release: () => void;
} {
	const controller = new AbortController();
	const forward = (): void => {
		if (controller.signal.aborted) return;
		controller.abort(
			new ExtractionAbortError(
				engineSignal.reason === "cancelled" ? "user-cancel" : "claim-lost",
			),
		);
	};
	if (engineSignal.aborted) forward();
	else engineSignal.addEventListener("abort", forward, { once: true });
	return {
		signal: controller.signal,
		release: () => engineSignal.removeEventListener("abort", forward),
	};
}

/**
 * One attempt. Returns when the attempt has written its verdict (success, or a
 * failure the policy decided) or when it was told to stop; a return with neither
 * is turned into a failure by the engine.
 */
export async function runExtraction(
	ctx: JobRunContext<typeof documentExtractionJobs>,
): Promise<void> {
	const job = ctx.row;
	const attemptStartedAtMs = Date.now();
	const intakeRoute: DocumentExtractionIntakeRoute =
		job.intakeRoute === "direct-text" ? "direct-text" : "mineru";
	const extractor = resolveExtractor(intakeRoute);

	const source = await resolveExtractionSource(job);
	if (!source) {
		await ctx.fail({
			code: "internal",
			message: `The stored file for ${job.fileName} could not be located.`,
			retryable: false,
			discardCheckpoint: true,
		});
		return;
	}

	// A handle the current extractor cannot read is not a handle. Discarding it
	// here rather than passing it on is what keeps a backend from being handed
	// another backend's job id.
	const stored = parseExtractionHandle(job.checkpoint);
	const resumeHandle =
		extractor.supportsResume && stored?.extractor === extractor.name
			? stored
			: null;
	let latestHandle: ExtractionHandle | null = resumeHandle;

	// Which extractor ran this attempt, and whether it picked a remote job back
	// up. The attempt row is the only record of either.
	const recorded = await ctx.write((tx) => {
		tx.update(documentExtractionJobAttempts)
			.set({ extractor: extractor.name, resumed: resumeHandle !== null })
			.where(eq(documentExtractionJobAttempts.id, ctx.attempt.id))
			.run();
	});
	if (!recorded) return;

	const bridge = bridgeAbortSignal(ctx.signal);

	// The extractor calls this synchronously from its own polling loop, so nothing
	// awaits it. The engine's context observes a write that fails (a busy
	// database) and a claim that is gone aborts the signal, so a failed progress
	// write is a line in the log and not an unhandled rejection or a dead attempt.
	const onProgress = (progress: ExtractionProgress): void => {
		if (progress.handle) latestHandle = progress.handle;
		void ctx.progress({
			phase: progress.phase,
			...(progress.handle ? { checkpoint: progress.handle } : {}),
		});
	};

	try {
		let result: ExtractDocumentResult;
		try {
			result = await extractor.extract({
				filePathAbsolute: source.filePathAbsolute,
				fileName: job.fileName,
				mimeType: job.mimeType,
				sizeBytes: job.sizeBytes,
				intakeRoute,
				signal: bridge.signal,
				onProgress,
				resumeHandle,
				contentSha256: source.contentSha256,
				sourceArtifactId: job.sourceArtifactId,
				userId: job.userId,
				hints: parseExtractionHints(job.hintsJson),
			});
		} catch (error) {
			if (ctx.signal.aborted) {
				// We were told to stop, and the verdict belongs to whoever holds the job
				// now: the user's cancel has already written `cancelled`, and a taken-back
				// attempt is another attempt's to resume. The engine says which in its own
				// log line.
				//
				// A cancel is the one stop that destroys remote work, and exactly one
				// DELETE reaches the backend. An extractor that declares `cancelsOnAbort`
				// issued it from its own abort path, where the live remote job id lives;
				// calling `cancel` here too would be a second DELETE for one Stop. Any
				// other extractor still needs this call. A taken-back attempt
				// (`lease-lost`) never deletes: the next attempt resumes from the
				// checkpoint.
				if (ctx.signal.reason === "cancelled" && !extractor.cancelsOnAbort) {
					await bestEffortRemoteCancel(extractor, latestHandle);
				}
				return;
			}

			const failure = toDocumentExtractionError(error);
			await ctx.fail({
				code: failure.code,
				message: failure.message,
				retryable: failure.retryable,
				retryAfterMs: failure.retryAfterMs,
				// The remote no longer recognises the handle: resuming it again would
				// fail the same way.
				discardCheckpoint: failure.handleUnknown,
				diagnostics: failure.details,
			});
			return;
		}

		// `indexing` is the last phase. A report that is refused here means the claim
		// is gone (the signal is aborted) and there is nothing left to write.
		const indexing = await ctx.progress({
			phase: "indexing",
			...(result.handle ? { checkpoint: result.handle } : {}),
		});
		if (!indexing) return;

		try {
			const persisted = await persistExtraction({ job, result, source });

			const completed = await ctx.succeed({
				// Recorded on the attempt, not just in a log line: "retrieval only
				// covers the first N chunks of this document" is the kind of fact
				// someone reads the attempts to find out.
				...(persisted.chunksTruncated
					? { diagnostics: { chunksTruncated: true } }
					: {}),
				apply: (tx) => {
					// A hint has done its job once the extraction it steered succeeded;
					// leaving it would silently re-apply to a later user retry. The retry
					// policy's own memory is not a hint and survives (the engine keeps it).
					tx.update(documentExtractionJobs)
						.set({
							normalizedArtifactId: persisted.artifactId,
							hintsJson: null,
						})
						.where(eq(documentExtractionJobs.id, job.id))
						.run();
					tx.update(documentExtractionJobAttempts)
						.set({
							textLength: result.text.length,
							pageCount: result.pageCount ?? null,
						})
						.where(eq(documentExtractionJobAttempts.id, ctx.attempt.id))
						.run();
				},
			});
			// Cancelled (or taken back) while the last stretch ran: the verdict is
			// not written over the new one, and nobody is told it succeeded.
			if (!completed) return;

			console.info("[EXTRACTION] Job succeeded", {
				jobId: job.id,
				attemptId: ctx.attempt.id,
				attemptNumber: ctx.attempt.number,
				extractor: extractor.name,
				intakeRoute,
				durationMs: Date.now() - attemptStartedAtMs,
				textLength: result.text.length,
				pageCount: result.pageCount ?? null,
				chunksTruncated: persisted.chunksTruncated,
			});
		} catch (error) {
			const failure = toDocumentExtractionError(error);
			await ctx.fail({
				code: failure.code,
				message: failure.message,
				retryable: failure.retryable,
				// Whatever the remote job was, it has been read: a retry starts over.
				discardCheckpoint: true,
			});
		}
	} finally {
		bridge.release();
	}
}
