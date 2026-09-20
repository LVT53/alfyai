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
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifacts, chatGeneratedFiles } from "$lib/server/db/schema";
import type {
	DocumentExtractionJobDTO,
	DocumentExtractionStatus,
} from "$lib/shared/extraction-status";
import { getExtractionConfig } from "./config";
import {
	type DocumentExtractor,
	type ExtractDocumentResult,
	type ExtractionHandle,
	type ExtractionProgress,
	toDocumentExtractionError,
} from "./contracts";
import { resolveExtractor as defaultResolveExtractor } from "./extractors/registry";
import {
	claimNextExtractionJob,
	completeExtractionAttempt,
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
}) => Promise<{ artifactId: string }>;

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
let workerInitialized = false;
let drainPromise: Promise<void> | null = null;
let lastRecoveryAt = 0;

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
	const resolve = input.resolveExtractor ?? defaultResolveExtractor;
	const intakeRoute: DocumentExtractionIntakeRoute =
		job.intakeRoute === "direct-text" ? "direct-text" : "mineru";
	const extractor = resolve(intakeRoute);

	const source = await resolveExtractionSource(job);
	if (!source) {
		await failExtractionAttempt({
			...owned,
			errorCode: "internal",
			errorMessage: `The stored file for ${job.fileName} could not be located.`,
			retryable: false,
			clearHandle: true,
			maxAttempts: config.maxAttempts,
			retryBaseMs: config.retryBaseMs,
			retryMaxMs: config.retryMaxMs,
		});
		return { processed: true, result: { jobId: job.id, status: "failed" } };
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

	const heartbeatMs = Math.max(250, input.heartbeatMs ?? config.heartbeatMs);
	const heartbeat = setInterval(() => {
		void (async () => {
			if (await isCancelRequested(job.id)) {
				cancelObserved = true;
				controller.abort();
				return;
			}
			const alive = await heartbeatExtractionAttempt(owned);
			if (!alive) {
				// The claim is gone: stale recovery, or a cancel, took it. Abort and
				// write nothing — whoever holds it now is the only legitimate writer.
				controller.abort();
			}
		})().catch(() => controller.abort());
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
		}).then((ok) => {
			if (!ok) controller.abort();
		});
	};

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
		clearInterval(heartbeat);
		const failure = toDocumentExtractionError(error);

		if (cancelObserved || (await isCancelRequested(job.id))) {
			await bestEffortRemoteCancel(extractor, latestHandle);
			return { processed: true, result: { jobId: job.id, status: "canceled" } };
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
			// The claim was gone before the verdict landed. Whoever holds the job
			// now owns its status; reporting "failed" here would be asserting a
			// write we did not make.
			return { processed: true, result: null };
		}
		return {
			processed: true,
			result: {
				jobId: job.id,
				status: outcome.requeued ? "queued" : "failed",
			},
		};
	}

	clearInterval(heartbeat);

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
		const normalizedArtifactId = await persistExtraction({
			job,
			result,
			source,
			persistResult: input.persistResult,
			persistReadback: input.persistReadback,
		});

		await completeExtractionAttempt({
			...owned,
			normalizedArtifactId,
			textLength: result.text.length,
			pageCount: result.pageCount ?? null,
		});
		return { processed: true, result: { jobId: job.id, status: "succeeded" } };
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
		return {
			processed: true,
			result: {
				jobId: job.id,
				status: outcome.requeued ? "queued" : "failed",
			},
		};
	}
}

async function persistExtraction(params: {
	job: DocumentExtractionJobRow;
	result: ExtractDocumentResult;
	source: ExtractionSource;
	persistResult?: PersistExtractionResultDependency;
	persistReadback?: ReadbackExtractionSink;
}): Promise<string> {
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
		return persisted.artifactId;
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
	return artifact.id;
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
 * Loops until the claim returns nothing. Between empty drains it re-runs stale
 * recovery, but no more often than every `staleAttemptMs / 2` — a worker that
 * swept on every idle tick would be a write storm on an idle box.
 */
export async function drainExtractionWorker(
	input: DrainExtractionWorkerInput = {},
): Promise<void> {
	const workerId = input.workerId ?? DEFAULT_WORKER_ID;

	for (;;) {
		const step = await executeStep({ ...input, workerId });
		if (step.processed) continue;

		const config = getExtractionConfig();
		const sinceRecovery = Date.now() - lastRecoveryAt;
		if (sinceRecovery < config.staleAttemptMs / 2) {
			return;
		}

		const { requeued } = await runStaleRecovery(config);
		if (requeued === 0) {
			return;
		}
	}
}

async function runStaleRecovery(
	config: ReturnType<typeof getExtractionConfig>,
): Promise<{ recovered: number; requeued: number }> {
	lastRecoveryAt = Date.now();
	return recoverStaleExtractionAttempts({
		staleBefore: new Date(Date.now() - config.staleAttemptMs),
		maxAttempts: config.maxAttempts,
		retryBaseMs: config.retryBaseMs,
		retryMaxMs: config.retryMaxMs,
	});
}

/** Fire-and-forget wake, deduped by an in-module promise. */
export function wakeExtractionWorker(): void {
	if (drainPromise) {
		return;
	}

	drainPromise = Promise.resolve()
		.then(() => drainExtractionWorker())
		.catch((error) => {
			console.error("[EXTRACTION] Worker drain failed", { error });
		})
		.finally(() => {
			drainPromise = null;
		});
}

function isNonServingContext(): boolean {
	// Vitest imports server modules freely; a worker that started draining a
	// test's temp database would race every test that seeds one. The build step
	// imports modules for analysis and must not open a DB connection at all.
	return Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
}

/**
 * Once per process, from `hooks.server.ts` init.
 *
 * Idempotent: the module-level flag makes a double import (or an HMR
 * re-evaluation that kept the module instance) a no-op. It does not block
 * server start — the caller does not await it — and it is safe against an empty
 * table, where the recovery sweep and the drain both return immediately.
 */
export async function ensureExtractionWorker(): Promise<void> {
	if (workerInitialized || isNonServingContext()) {
		return;
	}
	workerInitialized = true;

	const config = getExtractionConfig();
	if (!config.workerEnabled) {
		console.info("[EXTRACTION] Worker disabled by configuration");
		return;
	}

	await runStaleRecovery(config);
	wakeExtractionWorker();
}

/** Test helper: forget the once-per-process bootstrap guard. */
export function resetExtractionWorkerForTests(): void {
	workerInitialized = false;
	drainPromise = null;
	lastRecoveryAt = 0;
	registeredReadbackSink = null;
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
