// The worker: claim a job, run its extractor, write the verdict.
//
// It is in-process and single-scheduler by design — the deploy runs one
// `node build/index.js` and there is no pm2 or cluster config anywhere. The
// ledger's claim is nevertheless a real CAS with a worker id, and the caps are
// enforced by counting ROWS in active statuses rather than local promises, so a
// second process would be correct rather than merely unlikely to collide. Only
// the scheduler is per-process.
//
// The one invariant that must not be broken here: no ledger transaction is held
// across an `await` on an extractor. Each status write is its own transaction;
// the extraction, and the indexing that follows it, run between them.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	artifacts,
	chatGeneratedFiles,
	documentExtractionJobs,
} from "$lib/server/db/schema";
import type {
	DocumentExtractionJobDTO,
	DocumentExtractionStatus,
	ExtractionErrorCode,
} from "$lib/shared/extraction-status";
import { DOCUMENT_EXTRACTION_ACTIVE_STATUSES } from "$lib/shared/extraction-status";
import { type ExtractionConfig, getExtractionConfig } from "./config";
import {
	type DocumentExtractor,
	type ExtractDocumentResult,
	ExtractionAbortError,
	type ExtractionHandle,
	type ExtractionProgress,
	readExtractionAbortReason,
	toDocumentExtractionError,
} from "./contracts";
import { resolveExtractor as defaultResolveExtractor } from "./extractors/registry";
import {
	claimNextExtractionJob,
	completeExtractionAttempt,
	type FailExtractionAttemptResult,
	failExtractionAttempt,
	getExtractionJobRow,
	heartbeatExtractionAttempt,
	isCancelRequested,
	parseExtractionHints,
	recoverStaleExtractionAttempts,
	reportExtractionProgress,
} from "./job-ledger";
import {
	createNormalizedArtifactFromExtraction,
	type PersistExtractionResultDependency,
} from "./persist";
import { mapExtractionJobRow } from "./read-model";
import type {
	DocumentExtractionIntakeRoute,
	DocumentExtractionJobRow,
} from "./types";

/**
 * The sink for a generated-file readback result. Readback does not create a
 * normalized artifact: the generated document already has an artifact, and what
 * the extraction produces is its `contentText`. The slice that owns readback
 * supplies this — either per call, or once through
 * `setGeneratedFileReadbackSink` — because it owns the chat-files module that
 * knows how to patch and re-chunk that artifact.
 */
export type ReadbackExtractionSink = (input: {
	userId: string;
	conversationId: string | null;
	chatGeneratedFileId: string;
	text: string;
	pageCount: number | null;
	structured?: unknown;
}) => Promise<{ artifactId: string; chunksTruncated?: boolean }>;

let registeredReadbackSink: ReadbackExtractionSink | null = null;

/** Registers the readback sink once per process. Passing null unregisters it. */
export function setGeneratedFileReadbackSink(
	sink: ReadbackExtractionSink | null,
): void {
	registeredReadbackSink = sink;
}

export interface ExecuteNextExtractionJobInput {
	workerId: string;
	now?: Date;
	/** Test seam. Defaults to `resolveExtractor(intakeRoute)`. */
	resolveExtractor?: (
		intakeRoute: DocumentExtractionIntakeRoute,
	) => DocumentExtractor;
	/** Test seam over `createNormalizedArtifactFromExtraction`. */
	persistResult?: PersistExtractionResultDependency;
	/** Test seam / slice seam for generated-file readback. */
	persistReadback?: ReadbackExtractionSink;
	directTextOnly?: boolean;
	jobId?: string;
	/** Overrides the configured heartbeat cadence. Test seam. */
	heartbeatMs?: number;
}

export interface ExecuteNextExtractionJobResult {
	jobId: string;
	status: DocumentExtractionStatus;
}

export interface DrainExtractionWorkerInput
	extends Partial<ExecuteNextExtractionJobInput> {}

const DEFAULT_WORKER_ID = `extraction:${process.pid}:${randomUUID()}`;
let drainPromise: Promise<void> | null = null;
/** A wake that arrived while a drain was running, to be honoured after it. */
let drainRequestedAgain = false;

/**
 * The scheduler's state, held on `globalThis` rather than in a module binding.
 *
 * `workerInitialized` used to be a plain module-level flag, which makes a double
 * IMPORT a no-op (the module registry hands back the same instance) but not an
 * HMR re-EVALUATION: vite hands the new instance a fresh set of bindings, and
 * the old instance's timers keep firing beside the new one's. Two schedulers
 * against one ledger is not a correctness bug — every claim is a CAS — but it is
 * two sweeps and two drains per tick for as long as the dev server lives, and
 * the same shape of mistake in a future `node --watch` deploy would be one per
 * reload forever. A `Symbol.for` key is the one thing every instance shares.
 */
interface ExtractionSchedulerState {
	initialized: boolean;
	/** True only while timers may be armed: serving context, worker enabled. */
	running: boolean;
	idleTick: ReturnType<typeof setInterval> | null;
	idleTickMs: number | null;
	backoff: ReturnType<typeof setTimeout> | null;
	/** Epoch ms the armed backoff timer will fire at, for the no-stacking check. */
	backoffFiresAtMs: number | null;
	bootSweep: ReturnType<typeof setTimeout> | null;
	/** Dependencies every scheduler-driven drain runs with. Test seam. */
	drainInput: DrainExtractionWorkerInput | null;
	lastRecoveryAt: number;
	/** Every call to `wakeExtractionWorker`, including the ones it drops. */
	wakeRequests: number;
}

const SCHEDULER_KEY = Symbol.for("alfyai.extraction.worker-scheduler");

function scheduler(): ExtractionSchedulerState {
	const host = globalThis as typeof globalThis & {
		[SCHEDULER_KEY]?: ExtractionSchedulerState;
	};
	host[SCHEDULER_KEY] ??= {
		initialized: false,
		running: false,
		idleTick: null,
		idleTickMs: null,
		backoff: null,
		backoffFiresAtMs: null,
		bootSweep: null,
		drainInput: null,
		lastRecoveryAt: 0,
		wakeRequests: 0,
	};
	return host[SCHEDULER_KEY];
}

/** Idle-tick bounds. Fast enough to bound recovery, slow enough to be free. */
const IDLE_TICK_MIN_MS = 5_000;
const IDLE_TICK_MAX_MS = 60_000;

/**
 * Added to a job's own `next_attempt_at` when arming the backoff timer.
 *
 * `next_attempt_at` is stored with one-second granularity and the claim gate is
 * `next_attempt_at <= now`, so a timer that fired on the exact millisecond could
 * round to the second before its own gate and claim nothing. A second of margin
 * costs a second of latency on a retry and removes the whole class of misses.
 */
const BACKOFF_TIMER_MARGIN_MS = 1_000;

/** Never sleep longer than this in one hop; the idle tick re-arms the rest. */
const BACKOFF_TIMER_MAX_MS = 3_600_000;

const QUEUE_STATUSES: readonly string[] = [
	"queued",
	...DOCUMENT_EXTRACTION_ACTIVE_STATUSES,
];

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

interface StepResult {
	processed: boolean;
	result: ExecuteNextExtractionJobResult | null;
}

async function executeStep(
	input: ExecuteNextExtractionJobInput,
): Promise<StepResult> {
	const config = getExtractionConfig();
	if (!config.workerEnabled) {
		// The switch has to pause the inline direct-text path too, or "off" would
		// mean "off for big files only" and an admin draining the box before a
		// restart would still be taking work.
		return { processed: false, result: null };
	}

	const claimed = await claimNextExtractionJob({
		workerId: input.workerId,
		globalLimit: config.maxConcurrency,
		perUserLimit: config.perUserConcurrency,
		directTextOnly: input.directTextOnly,
		jobId: input.jobId,
		now: input.now,
	});
	if (!claimed) {
		return { processed: false, result: null };
	}

	const { job, attempt } = claimed;
	const owned = {
		jobId: job.id,
		attemptId: attempt.id,
		workerId: input.workerId,
	};
	const attemptStartedAtMs = Date.now();
	const resolve = input.resolveExtractor ?? defaultResolveExtractor;
	const intakeRoute: DocumentExtractionIntakeRoute =
		job.intakeRoute === "direct-text" ? "direct-text" : "mineru";
	const extractor = resolve(intakeRoute);

	const source = await resolveExtractionSource(job);
	if (!source) {
		const outcome = await failExtractionAttempt({
			...owned,
			errorCode: "internal",
			errorMessage: `The stored file for ${job.fileName} could not be located.`,
			retryable: false,
			clearHandle: true,
			maxAttempts: config.maxAttempts,
			retryBaseMs: config.retryBaseMs,
			retryMaxMs: config.retryMaxMs,
		});
		// Same rule as the other two failure branches: `applied: false` means
		// the claim was already gone and nothing was written, so reporting
		// "failed" here would assert a verdict this worker never wrote.
		if (!outcome.applied) {
			return { processed: true, result: null };
		}
		await logFailedAttempt({
			...owned,
			errorCode: "internal",
			outcome,
			startedAtMs: attemptStartedAtMs,
		});
		return {
			processed: true,
			result: {
				jobId: job.id,
				status: outcome.requeued ? "queued" : "failed",
			},
		};
	}

	const controller = new AbortController();
	let cancelObserved = false;
	let latestHandle: ExtractionHandle | null =
		extractor.supportsResume &&
		claimed.resumeHandle?.extractor === extractor.name
			? claimed.resumeHandle
			: null;

	// A handle the current extractor cannot read is not a handle. Discarding it
	// here rather than passing it on is what keeps a backend from being handed
	// another backend's job id.
	const resumeHandle = latestHandle;

	// The heartbeat runs until the attempt is completed or failed, INDEXING
	// INCLUDED. It used to stop the moment the extractor returned, which left
	// the whole indexing pass — chunking and embedding a large document, the
	// slowest thing this worker does — with a frozen `heartbeat_at`: long
	// enough and `recoverStaleExtractionAttempts` reclaimed a perfectly healthy
	// attempt and re-ran the extraction. Every exit path clears it, in a
	// `finally`, so a throw between here and the verdict cannot leak a timer.
	const heartbeatMs = Math.max(250, input.heartbeatMs ?? config.heartbeatMs);
	const heartbeat = setInterval(() => {
		void (async () => {
			if (await isCancelRequested(job.id)) {
				cancelObserved = true;
				controller.abort(new ExtractionAbortError("user-cancel"));
				return;
			}
			const alive = await heartbeatExtractionAttempt(owned);
			if (!alive) {
				// The claim is gone: stale recovery, or a cancel, took it. Abort and
				// write nothing — whoever holds it now is the only legitimate writer.
				// Labelled `claim-lost` rather than left bare: the extractor must NOT
				// delete the remote job, because the worker that now holds the claim
				// is about to resume it from the same stored handle.
				controller.abort(new ExtractionAbortError("claim-lost"));
			}
		})().catch(() => controller.abort(new ExtractionAbortError("claim-lost")));
	}, heartbeatMs);
	heartbeat.unref?.();

	const onProgress = (progress: ExtractionProgress): void => {
		if (progress.handle) {
			latestHandle = progress.handle;
		}
		void reportExtractionProgress({
			...owned,
			status: progress.phase,
			handle: progress.handle ?? undefined,
			extractor: extractor.name,
		})
			.then((ok) => {
				if (!ok) controller.abort(new ExtractionAbortError("claim-lost"));
			})
			// An extractor calls this synchronously from its own polling loop, so
			// nothing is awaiting the promise. Without a catch, one SQLITE_BUSY on
			// a progress write becomes an unhandled rejection — which Node 22
			// turns into a process exit, taking the whole server down for a status
			// line nobody was waiting on.
			.catch((error) => {
				console.warn("[EXTRACTION] Progress write failed", {
					jobId: job.id,
					error,
				});
				controller.abort(new ExtractionAbortError("claim-lost"));
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
				signal: controller.signal,
				onProgress,
				resumeHandle,
				contentSha256: source.contentSha256,
				sourceArtifactId: job.sourceArtifactId,
				userId: job.userId,
				hints: parseExtractionHints(job.hintsJson),
			});
		} catch (error) {
			const failure = toDocumentExtractionError(error);

			if (cancelObserved || (await isCancelRequested(job.id))) {
				await bestEffortRemoteCancel(extractor, latestHandle);
				console.info("[EXTRACTION] Cancel honoured", {
					jobId: job.id,
					attemptId: attempt.id,
					attemptNumber: attempt.attemptNumber,
					extractor: extractor.name,
					durationMs: Date.now() - attemptStartedAtMs,
				});
				return {
					processed: true,
					result: { jobId: job.id, status: "canceled" },
				};
			}

			if (
				controller.signal.aborted &&
				readExtractionAbortReason(controller.signal.reason) === "claim-lost"
			) {
				// We aborted this attempt ourselves, and NOT because anyone asked for
				// the document to stop: the claim was taken from us, or a progress
				// write failed. Writing "canceled, not retryable" here would fail a
				// document permanently over a transient SQLITE_BUSY, and would assert
				// a verdict over whoever holds the claim now. Leave the row alone —
				// the stale sweep requeues it, and the stored handle makes that a
				// resume rather than a second upload.
				console.warn("[EXTRACTION] Attempt released without a verdict", {
					jobId: job.id,
					attemptId: attempt.id,
					attemptNumber: attempt.attemptNumber,
					extractor: extractor.name,
					durationMs: Date.now() - attemptStartedAtMs,
				});
				return { processed: true, result: null };
			}

			const outcome = await failExtractionAttempt({
				...owned,
				errorCode: failure.code,
				errorMessage: failure.message,
				retryable: failure.retryable,
				retryAfterMs: failure.retryAfterMs,
				clearHandle: failure.handleUnknown,
				maxAttempts: config.maxAttempts,
				retryBaseMs: config.retryBaseMs,
				retryMaxMs: config.retryMaxMs,
				diagnostics: failure.details,
			});
			if (!outcome.applied) {
				// The claim was gone before the verdict landed. Whoever holds the
				// job now owns its status; reporting "failed" here would be
				// asserting a write we did not make.
				return { processed: true, result: null };
			}
			await logFailedAttempt({
				...owned,
				errorCode: failure.code,
				outcome,
				startedAtMs: attemptStartedAtMs,
			});
			return {
				processed: true,
				result: {
					jobId: job.id,
					status: outcome.requeued ? "queued" : "failed",
				},
			};
		}

		const movedToIndexing = await reportExtractionProgress({
			...owned,
			status: "indexing",
			handle: result.handle ?? undefined,
			extractor: extractor.name,
		});
		if (!movedToIndexing) {
			return { processed: true, result: null };
		}

		try {
			const persisted = await persistExtraction({
				job,
				result,
				source,
				persistResult: input.persistResult,
				persistReadback: input.persistReadback,
			});

			await completeExtractionAttempt({
				...owned,
				normalizedArtifactId: persisted.artifactId,
				textLength: result.text.length,
				pageCount: result.pageCount ?? null,
				// Recorded on the attempt, not just in a log line: "retrieval only
				// covers the first N chunks of this document" is the kind of fact
				// someone reads the ledger to find out.
				...(persisted.chunksTruncated
					? { diagnostics: { chunksTruncated: true } }
					: {}),
			});
			console.info("[EXTRACTION] Job succeeded", {
				jobId: job.id,
				attemptId: attempt.id,
				attemptNumber: attempt.attemptNumber,
				extractor: extractor.name,
				intakeRoute,
				durationMs: Date.now() - attemptStartedAtMs,
				textLength: result.text.length,
				pageCount: result.pageCount ?? null,
				chunksTruncated: persisted.chunksTruncated,
			});
			return {
				processed: true,
				result: { jobId: job.id, status: "succeeded" },
			};
		} catch (error) {
			const failure = toDocumentExtractionError(error);
			const outcome = await failExtractionAttempt({
				...owned,
				errorCode: failure.code,
				errorMessage: failure.message,
				retryable: failure.retryable,
				clearHandle: true,
				maxAttempts: config.maxAttempts,
				retryBaseMs: config.retryBaseMs,
				retryMaxMs: config.retryMaxMs,
			});
			if (!outcome.applied) {
				return { processed: true, result: null };
			}
			await logFailedAttempt({
				...owned,
				errorCode: failure.code,
				outcome,
				startedAtMs: attemptStartedAtMs,
			});
			return {
				processed: true,
				result: {
					jobId: job.id,
					status: outcome.requeued ? "queued" : "failed",
				},
			};
		}
	} finally {
		clearInterval(heartbeat);
	}
}

/**
 * One line per failed attempt, and a second one when that failure exhausted the
 * job's attempts. The terminal branch re-reads the job row rather than
 * re-deriving the verdict here: `decideExtractionRetry` already made that call
 * inside the ledger transaction, and a copy of its arithmetic in a log helper
 * is a copy that can disagree with the row a user is looking at.
 */
async function logFailedAttempt(params: {
	jobId: string;
	attemptId: string;
	errorCode: ExtractionErrorCode;
	outcome: FailExtractionAttemptResult;
	startedAtMs: number;
}): Promise<void> {
	console.warn("[EXTRACTION] Attempt failed", {
		jobId: params.jobId,
		attemptId: params.attemptId,
		errorCode: params.errorCode,
		requeued: params.outcome.requeued,
		nextAttemptAt: params.outcome.nextAttemptAt?.toISOString() ?? null,
		durationMs: Date.now() - params.startedAtMs,
	});

	if (params.outcome.requeued) return;

	const row = await getExtractionJobRow(params.jobId);
	if (row?.errorCode === "max_attempts") {
		console.warn("[EXTRACTION] Job reached max attempts", {
			jobId: params.jobId,
			attemptCount: row.attemptCount,
			retryable: row.retryable,
		});
	}
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
	persistResult?: PersistExtractionResultDependency;
	persistReadback?: ReadbackExtractionSink;
}): Promise<PersistedExtraction> {
	const { job, result, source } = params;

	if (job.origin === "generated_file_readback" && job.chatGeneratedFileId) {
		const sink = params.persistReadback ?? registeredReadbackSink;
		if (!sink) {
			throw new Error(
				"No generated-file readback sink is registered; call setGeneratedFileReadbackSink() or pass persistReadback.",
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

	const persist =
		params.persistResult ?? createNormalizedArtifactFromExtraction;
	const artifact = await persist({
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
		// The ledger row is already `canceled`. A remote that will not clean up
		// is an operational annoyance, never something the user should be shown
		// instead of the cancel they asked for.
		console.warn("[EXTRACTION] Remote cancel failed", {
			extractor: extractor.name,
			error,
		});
	}
}

export async function executeNextExtractionJob(
	input: ExecuteNextExtractionJobInput,
): Promise<ExecuteNextExtractionJobResult | null> {
	const step = await executeStep(input);
	return step.result;
}

/**
 * Loops until the claim returns nothing, then re-arms.
 *
 * Between empty drains it re-runs stale recovery, but no more often than one
 * idle tick — sweeping on every empty claim would be a write storm on a busy
 * box. It used to be gated on `staleAttemptMs / 2` instead, which on the dev
 * box (stale window dragged to 20 minutes by the MinerU timeout) meant a drain
 * woken by an upload would decline to sweep for ten minutes at a time.
 *
 * The re-arm in the `finally` is the other half of ruling 1. A drain that
 * requeues a job behind a backoff and then returns has left work in the table
 * with nothing scheduled to pick it up: before this, the job waited for an
 * unrelated upload, which on an idle box never comes.
 */
export async function drainExtractionWorker(
	input: DrainExtractionWorkerInput = {},
): Promise<void> {
	const workerId = input.workerId ?? DEFAULT_WORKER_ID;

	try {
		for (;;) {
			const step = await executeStep({ ...input, workerId });
			if (step.processed) continue;

			const config = getExtractionConfig();
			if (
				Date.now() - scheduler().lastRecoveryAt <
				idleTickIntervalMs(config)
			) {
				return;
			}

			const { requeued } = await runStaleRecovery(config, "drain");
			if (requeued === 0) {
				return;
			}
		}
	} finally {
		await rearmAfterDrain();
	}
}

async function runStaleRecovery(
	config: ExtractionConfig,
	reason: string,
): Promise<{ recovered: number; requeued: number }> {
	scheduler().lastRecoveryAt = Date.now();
	const outcome = await recoverStaleExtractionAttempts({
		staleBefore: new Date(Date.now() - config.staleAttemptMs),
		maxAttempts: config.maxAttempts,
		retryBaseMs: config.retryBaseMs,
		retryMaxMs: config.retryMaxMs,
	});

	// Silence on a sweep that found nothing is the point: this runs every tick
	// forever. A sweep that DID reclaim something is the one line that explains
	// why a document the user was watching started over.
	if (outcome.recovered > 0) {
		console.warn("[EXTRACTION] Reclaimed stale attempts", {
			reason,
			recovered: outcome.recovered,
			requeued: outcome.requeued,
			staleAttemptMs: config.staleAttemptMs,
		});
	}
	return outcome;
}

/** Fire-and-forget wake, deduped by an in-module promise. */
export function wakeExtractionWorker(): void {
	scheduler().wakeRequests += 1;

	if (isNonServingContext()) {
		// Under vitest this is the one entry point a test reaches by accident:
		// any test that uploads a file calls `startUploadExtraction`, which wakes
		// the worker, which drains with the REAL extractor registry and issues a
		// live HTTP call to the backend from a unit test — and then leaves the
		// job requeued behind a backoff gate, so the next explicit
		// `executeNextExtractionJob` in the same test claims nothing. Tests that
		// mean to run the worker call `executeNextExtractionJob` or
		// `drainExtractionWorker` directly; those stay live.
		return;
	}

	startDrain();
}

/**
 * Starts a drain, or records that one is owed.
 *
 * The dedupe used to drop a wake that arrived while a drain was running, which
 * is wrong whenever the enqueue landed after that drain's last claim: the job
 * was then invisible to the drain that swallowed its wake, and waited for the
 * next unrelated upload. The flag costs nothing and closes the window.
 */
function startDrain(): void {
	if (drainPromise) {
		drainRequestedAgain = true;
		return;
	}

	const input = scheduler().drainInput ?? {};
	drainPromise = Promise.resolve()
		.then(() => drainExtractionWorker(input))
		.catch((error) => {
			console.error("[EXTRACTION] Worker drain failed", { error });
		})
		.finally(() => {
			drainPromise = null;
			if (drainRequestedAgain) {
				drainRequestedAgain = false;
				startDrain();
			}
		});
}

function isNonServingContext(): boolean {
	// Vitest imports server modules freely; a worker that started draining a
	// test's temp database would race every test that seeds one. The build step
	// imports modules for analysis and must not open a DB connection at all.
	return Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
}

interface ExtractionQueueSnapshot {
	/** Rows in an active status, i.e. rows a stale sweep could have work on. */
	activeCount: number;
	/** Queued rows whose backoff gate is already open. */
	claimableCount: number;
	/** Earliest future `next_attempt_at` among queued rows, in epoch ms. */
	earliestGatedAtMs: number | null;
}

const EMPTY_QUEUE_SNAPSHOT: ExtractionQueueSnapshot = {
	activeCount: 0,
	claimableCount: 0,
	earliestGatedAtMs: null,
};

/**
 * One indexed aggregate over the jobs table: is there anything to do, and if
 * not yet, when.
 *
 * It is deliberately one query and deliberately aggregate-only, because the
 * idle tick runs it forever on boxes where the table is empty. The `WHERE
 * status IN (...)` leads `document_extraction_jobs_claim_idx`, so an idle box
 * pays an index probe that matches nothing.
 */
async function readExtractionQueueSnapshot(
	nowMs: number,
): Promise<ExtractionQueueSnapshot> {
	// `next_attempt_at` is a drizzle `timestamp` column: unix SECONDS.
	const nowSeconds = Math.floor(nowMs / 1000);
	const status = documentExtractionJobs.status;
	const gate = documentExtractionJobs.nextAttemptAt;

	const [row] = await db
		.select({
			activeCount: sql<number>`sum(case when ${status} <> 'queued' then 1 else 0 end)`,
			claimableCount: sql<number>`sum(case when ${status} = 'queued' and (${gate} is null or ${gate} <= ${nowSeconds}) then 1 else 0 end)`,
			earliestGated: sql<
				number | null
			>`min(case when ${status} = 'queued' and ${gate} > ${nowSeconds} then ${gate} end)`,
		})
		.from(documentExtractionJobs)
		.where(inArray(status, QUEUE_STATUSES));

	if (!row) return EMPTY_QUEUE_SNAPSHOT;
	const earliest = row.earliestGated;
	return {
		activeCount: Number(row.activeCount ?? 0),
		claimableCount: Number(row.claimableCount ?? 0),
		earliestGatedAtMs:
			earliest === null || earliest === undefined
				? null
				: Number(earliest) * 1000,
	};
}

/** `heartbeatMs × 2`, clamped. 30 s on the default config. */
function idleTickIntervalMs(config: ExtractionConfig): number {
	return Math.min(
		IDLE_TICK_MAX_MS,
		Math.max(IDLE_TICK_MIN_MS, config.heartbeatMs * 2),
	);
}

/**
 * Arms at most ONE backoff timer, for the earliest moment work becomes
 * claimable. An existing timer that already fires at or before that moment is
 * left alone rather than replaced, so repeated drains cannot stack timers.
 */
function armBackoffTimer(dueAtMs: number): void {
	const state = scheduler();
	if (!state.running) return;

	const delayMs = Math.min(
		BACKOFF_TIMER_MAX_MS,
		Math.max(0, dueAtMs + BACKOFF_TIMER_MARGIN_MS - Date.now()),
	);
	const firesAtMs = Date.now() + delayMs;

	if (
		state.backoff &&
		state.backoffFiresAtMs !== null &&
		state.backoffFiresAtMs <= firesAtMs
	) {
		return;
	}

	clearBackoffTimer(state);
	state.backoffFiresAtMs = firesAtMs;
	state.backoff = setTimeout(() => {
		state.backoff = null;
		state.backoffFiresAtMs = null;
		startDrain();
	}, delayMs);
	state.backoff.unref?.();
}

function clearBackoffTimer(state: ExtractionSchedulerState): void {
	if (state.backoff) clearTimeout(state.backoff);
	state.backoff = null;
	state.backoffFiresAtMs = null;
}

/**
 * Called at the end of every drain. A drain that emptied the queue arms
 * nothing; one that left work behind a backoff gate arms the single timer that
 * will pick it up.
 *
 * `claimableCount > 0` after a drain that claimed nothing means the caps are
 * full (the inline direct-text path holds a slot, say) or a row landed during
 * the final claim. Retrying immediately would spin, so that case waits one idle
 * tick — bounded, and free of a hot loop.
 */
async function rearmAfterDrain(): Promise<void> {
	const state = scheduler();
	if (!state.running) return;

	try {
		const now = Date.now();
		const snapshot = await readExtractionQueueSnapshot(now);
		const dueCandidates: number[] = [];
		if (snapshot.claimableCount > 0) {
			dueCandidates.push(now + idleTickIntervalMs(getExtractionConfig()));
		}
		if (snapshot.earliestGatedAtMs !== null) {
			dueCandidates.push(snapshot.earliestGatedAtMs);
		}
		if (dueCandidates.length > 0) {
			armBackoffTimer(Math.min(...dueCandidates));
		}
	} catch (error) {
		// The idle tick is still running; a failed re-arm costs latency, never
		// the job. Throwing here would also replace whatever the drain was
		// reporting with a database error from its `finally`.
		console.warn("[EXTRACTION] Re-arm after drain failed", { error });
	}
}

/**
 * The periodic sweep, and the only thing that runs on a box where nobody
 * uploads anything. Recovery latency after a crash is therefore bounded by
 * roughly `staleAttemptMs + idleTick`, not by the next unrelated upload.
 */
async function runIdleTick(): Promise<void> {
	const state = scheduler();
	if (!state.running) return;

	const config = getExtractionConfig();
	// Honoured live: an admin who switches the worker off mid-flight gets a
	// scheduler that stops taking work without a restart.
	if (!config.workerEnabled) return;

	const now = Date.now();
	const snapshot = await readExtractionQueueSnapshot(now);
	if (
		snapshot.activeCount === 0 &&
		snapshot.claimableCount === 0 &&
		snapshot.earliestGatedAtMs === null
	) {
		return;
	}

	if (snapshot.activeCount > 0) {
		const { requeued } = await runStaleRecovery(config, "idle-tick");
		if (requeued > 0) {
			// The requeued rows sit behind a fresh backoff; the drain claims what
			// it can and re-arms for the rest.
			startDrain();
			return;
		}
	}

	if (snapshot.claimableCount > 0) {
		startDrain();
		return;
	}
	if (snapshot.earliestGatedAtMs !== null) {
		armBackoffTimer(snapshot.earliestGatedAtMs);
	}
}

function startIdleTick(config: ExtractionConfig): void {
	const state = scheduler();
	if (state.idleTick) return;

	const intervalMs = idleTickIntervalMs(config);
	state.idleTickMs = intervalMs;
	state.idleTick = setInterval(() => {
		void runIdleTick().catch((error) => {
			console.error("[EXTRACTION] Idle tick failed", { error });
		});
	}, intervalMs);
	state.idleTick.unref?.();
}

export interface EnsureExtractionWorkerInput
	extends DrainExtractionWorkerInput {
	/**
	 * Test seam: start the scheduler even under vitest, and run every drain it
	 * arms with the rest of this input (a fake extractor, a fake persist). The
	 * production call site in `hooks.server.ts` passes nothing, so the default
	 * stays "do nothing outside a serving process".
	 */
	startInNonServingContextForTests?: boolean;
}

/**
 * Once per process, from `hooks.server.ts` init.
 *
 * Idempotent: the scheduler flag makes a double import a no-op, and it lives on
 * a `Symbol.for` key so an HMR re-evaluation that builds a fresh module
 * instance is a no-op too. It does not block server start — the caller does not
 * await it — and it is safe against an empty table, where the recovery sweep
 * and the drain both return immediately.
 *
 * Boot recovery runs TWICE by design (ruling 3). The sweep at boot reclaims
 * attempts whose worker died long enough ago to look stale; the one scheduled
 * `staleAttemptMs` later reclaims the attempts this very restart orphaned,
 * whose heartbeats were seconds old at boot and so looked perfectly healthy.
 * Without it, a box where nobody uploads anything for an hour keeps a job in
 * `parsing` for that hour with a heartbeat frozen at the restart.
 */
export async function ensureExtractionWorker(
	input: EnsureExtractionWorkerInput = {},
): Promise<void> {
	const state = scheduler();
	const { startInNonServingContextForTests, ...drainInput } = input;
	if (state.initialized) {
		return;
	}
	if (isNonServingContext() && startInNonServingContextForTests !== true) {
		return;
	}
	state.initialized = true;

	const config = getExtractionConfig();
	if (!config.workerEnabled) {
		console.info("[EXTRACTION] Worker disabled by configuration");
		return;
	}

	state.running = true;
	state.drainInput = drainInput;

	console.info("[EXTRACTION] Worker started", {
		idleTickMs: idleTickIntervalMs(config),
		staleAttemptMs: config.staleAttemptMs,
		heartbeatMs: config.heartbeatMs,
		maxConcurrency: config.maxConcurrency,
		perUserConcurrency: config.perUserConcurrency,
		maxAttempts: config.maxAttempts,
		retryBaseMs: config.retryBaseMs,
		retryMaxMs: config.retryMaxMs,
	});

	await runStaleRecovery(config, "boot");

	state.bootSweep = setTimeout(() => {
		state.bootSweep = null;
		void (async () => {
			if (!state.running) return;
			const current = getExtractionConfig();
			if (!current.workerEnabled) return;
			const { requeued } = await runStaleRecovery(current, "boot-followup");
			if (requeued > 0) startDrain();
		})().catch((error) => {
			console.error("[EXTRACTION] Boot follow-up sweep failed", { error });
		});
	}, config.staleAttemptMs);
	state.bootSweep.unref?.();

	startIdleTick(config);
	startDrain();
}

/** Test helper: forget the bootstrap guard and disarm every timer. */
export function resetExtractionWorkerForTests(): void {
	const state = scheduler();
	if (state.idleTick) clearInterval(state.idleTick);
	if (state.bootSweep) clearTimeout(state.bootSweep);
	clearBackoffTimer(state);
	state.idleTick = null;
	state.idleTickMs = null;
	state.bootSweep = null;
	state.initialized = false;
	state.running = false;
	state.drainInput = null;
	state.lastRecoveryAt = 0;
	state.wakeRequests = 0;
	drainPromise = null;
	drainRequestedAgain = false;
	registeredReadbackSink = null;
}

export interface ExtractionSchedulerInspection {
	running: boolean;
	idleTickArmed: boolean;
	idleTickMs: number | null;
	/** `hasRef()` on the armed interval, or null when it cannot be asked. */
	idleTickRefed: boolean | null;
	backoffArmed: boolean;
	backoffFiresInMs: number | null;
	backoffRefed: boolean | null;
	bootSweepArmed: boolean;
	bootSweepRefed: boolean | null;
	/** Wakes requested, including the ones dropped in a non-serving context. */
	wakeRequests: number;
}

/**
 * Test helper: what the scheduler currently has armed.
 *
 * Returning facts rather than the handles themselves keeps a test from
 * clearing a timer the scheduler still believes it owns.
 */
export function inspectExtractionSchedulerForTests(): ExtractionSchedulerInspection {
	const state = scheduler();
	return {
		running: state.running,
		idleTickArmed: state.idleTick !== null,
		idleTickMs: state.idleTickMs,
		idleTickRefed: state.idleTick?.hasRef?.() ?? null,
		backoffArmed: state.backoff !== null,
		backoffFiresInMs:
			state.backoffFiresAtMs === null
				? null
				: state.backoffFiresAtMs - Date.now(),
		backoffRefed: state.backoff?.hasRef?.() ?? null,
		bootSweepArmed: state.bootSweep !== null,
		bootSweepRefed: state.bootSweep?.hasRef?.() ?? null,
		wakeRequests: state.wakeRequests,
	};
}

/**
 * Claims and runs ONE direct-text job to completion in the caller's async
 * context, so a `.txt` upload can answer `succeeded` inside its own HTTP
 * request instead of making the user watch a spinner for work that takes 30 ms.
 *
 * Bypasses the concurrency caps on purpose (D3): direct text is local CPU, not
 * a backend seat, and capping it would serialise `.txt` uploads behind a
 * scanned PDF. Returns the job's DTO either way — terminal if it finished,
 * non-terminal if the budget elapsed first, which the caller reports honestly
 * rather than waiting longer.
 */
export async function runDirectTextExtractionInline(input: {
	jobId: string;
	budgetMs: number;
	signal?: AbortSignal;
}): Promise<DocumentExtractionJobDTO | null> {
	const config = getExtractionConfig();
	const budgetMs = Math.max(0, input.budgetMs);

	if (budgetMs > 0 && !input.signal?.aborted) {
		const run = executeNextExtractionJob({
			workerId: `${DEFAULT_WORKER_ID}:inline`,
			directTextOnly: true,
			jobId: input.jobId,
		}).catch((error) => {
			console.error("[EXTRACTION] Inline direct-text run failed", { error });
			return null;
		});

		await Promise.race([run, budgetTimer(budgetMs, input.signal)]);
	}

	const row = await getExtractionJobRow(input.jobId);
	return row ? mapExtractionJobRow(row, config.maxAttempts) : null;
}

function budgetTimer(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}
