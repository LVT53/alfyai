// Document extraction on the job engine (docs/plans/jobs-merge, slice S3).
//
// This file is the KIND: its definition, which is everything the engine needs to
// know that is particular to extraction, and the functions the rest of the app
// calls to start, retry and cancel a job. It imports the engine and no extractor:
// the handler (`extraction-runner.ts`) is loaded on the first claim, so a route
// that only reads, retries or cancels never pulls in the extractor registry, the
// MinerU client or `node:fs`.
//
// What the engine owns and this file does not: claiming, the lease and its
// heartbeat, the fenced writes, taking an attempt back, cancel's immediate abort,
// scheduling and waiting. What stays extraction's: the intake route and the hints
// a job carries, the retry arithmetic (`retry-policy.ts`), the ceilings Retry and
// Re-extract are held to, the direct-text inline run, and the vocabulary the
// browser reads (`shared/extraction-status.ts`, which keeps `canceled` and the
// phase words: only the stored words changed).

import { and, asc, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	artifacts,
	documentExtractionJobAttempts,
	documentExtractionJobs,
} from "$lib/server/db/schema";
import type {
	FailureDecision,
	FailureHistory,
	JobFailure,
} from "$lib/server/services/jobs";
import {
	cancel,
	cancelAll,
	defineJobKind,
	enqueue,
	reopen,
	waitForVerdict,
} from "$lib/server/services/jobs";
import type {
	DocumentExtractionJobDTO,
	ExtractionErrorCode,
} from "$lib/shared/extraction-status";
import { isExtractionErrorCode } from "$lib/shared/extraction-status";
import { getIntakeRoute } from "$lib/shared/file-types";
import { getExtractionConfig } from "./config";
import { serializeHints } from "./hints";
import { getExtractionJobById } from "./read-model";
import {
	carryExtractionOutageWaits,
	decideExtractionRetry,
	extractionRetryBudgetLeft,
	isEmptyExtractionOutageState,
	parseExtractionOutageState,
} from "./retry-policy";
import type {
	DocumentExtractionAttemptRow,
	DocumentExtractionIntakeRoute,
	DocumentExtractionJobRow,
	DocumentExtractionOrigin,
} from "./types";
import { EXTRACTION_PRIORITY_UPLOAD } from "./types";

export type {
	DocumentExtractionAttemptRow,
	DocumentExtractionJobRow,
} from "./types";

// ---------------------------------------------------------------------------
// The definition
// ---------------------------------------------------------------------------

/**
 * The phases an attempt moves through, in order. The engine refuses a report that
 * would move one backwards (the old state machine said the same, in a table).
 * `uploading` is the first: a claim starts there, as it always did.
 */
export const EXTRACTION_PHASES = [
	"uploading",
	"parsing",
	"downloading",
	"indexing",
] as const;

/** What an attempt the engine took back is told, as it always was. */
export const EXTRACTION_STALE_WORKER_MESSAGE =
	"The extraction worker stopped responding before finishing this document.";

/**
 * What a failure does to the job: today's `decideExtractionRetry`, unchanged, with
 * the live config values and the outage memory the engine keeps in
 * `retry_state_json`. Pure, and called inside the transaction that settles the
 * failure, for every failure whatever its source: the extractor's, a throw, and a
 * take-back.
 *
 * A code that is not one of the ledger's (the engine's own `no_verdict`, or a
 * handler that threw something it never mapped) is an ordinary retryable document
 * failure, `job_failed`: the retry arithmetic has a policy for every code of the
 * vocabulary and none for a word it has not heard, and a job must never stay
 * `running` because its failure had a name the table lacks.
 */
export function decideExtractionFailure(
	failure: JobFailure,
	history: FailureHistory,
): FailureDecision {
	const config = getExtractionConfig();
	const decision = decideExtractionRetry({
		code: isExtractionErrorCode(failure.code) ? failure.code : "job_failed",
		retryable: failure.retryable,
		retryAfterMs: failure.retryAfterMs,
		attemptCount: history.attempts,
		maxAttempts: config.maxAttempts,
		retryBaseMs: config.retryBaseMs,
		retryMaxMs: config.retryMaxMs,
		outageWindowMs: config.outageWindowMs,
		outage: parseExtractionOutageState(history.state),
		nowMs: history.nowMs,
	});

	// An outage with nothing to remember leaves the column empty, as the previous
	// release left the hints key out.
	const state = isEmptyExtractionOutageState(decision.outage)
		? null
		: decision.outage;
	return decision.requeue
		? {
				requeue: true,
				delayMs: decision.delayMs,
				code: decision.jobErrorCode,
				retryable: decision.jobRetryable,
				state,
			}
		: {
				requeue: false,
				retryable: decision.jobRetryable,
				code: decision.jobErrorCode,
				state,
			};
}

export const extractionJob = defineJobKind({
	name: "extraction",
	logPrefix: "[EXTRACTION]",
	tables: {
		jobs: documentExtractionJobs,
		attempts: documentExtractionJobAttempts,
	},
	// Every value is read through the config at the moment it is needed, which is
	// what lets all of them be `effect: "live"` on the admin Advanced page: an
	// admin who lowers the concurrency cap sees it apply on the very next claim,
	// and the switch pauses the inline direct-text path too, or "off" would mean
	// "off for big files only".
	enabled: () => getExtractionConfig().workerEnabled,
	limits: () => {
		const config = getExtractionConfig();
		return {
			global: config.maxConcurrency,
			perUser: config.perUserConcurrency,
		};
	},
	lease: () => {
		const config = getExtractionConfig();
		return {
			heartbeatMs: config.heartbeatMs,
			staleAfterMs: config.staleAttemptMs,
		};
	},
	phases: EXTRACTION_PHASES,
	lostAttempt: () => ({
		code: "stale_worker",
		message: EXTRACTION_STALE_WORKER_MESSAGE,
	}),
	onFailure: decideExtractionFailure,
	// Retry is legal from failed and cancelled while the job has document
	// attempts left under its ceiling (outage waits discounted); it is not the
	// button that is drawn, though: the DTO also asks that a failed job says it is
	// retryable.
	userRetry: {
		from: ["failed", "cancelled"],
		allow: (row) =>
			extractionRetryBudgetLeft(row, getExtractionConfig().maxAttempts),
	},
	// A direct-text job is local CPU, not a backend seat: it may run inside the
	// request that made it, past the caps.
	inline: { eligible: (row) => row.intakeRoute === "direct-text" },
	handler: () =>
		import("./extraction-runner").then((module) => module.runExtraction),
});

// ---------------------------------------------------------------------------
// Starting a job
// ---------------------------------------------------------------------------

export interface EnqueueExtractionJobInput {
	userId: string;
	conversationId: string | null;
	origin: DocumentExtractionOrigin;
	intakeRoute: DocumentExtractionIntakeRoute;
	fileName: string;
	mimeType: string | null;
	sizeBytes: number;
	sourceArtifactId?: string | null;
	chatGeneratedFileId?: string | null;
	priority?: number;
	/** Opaque, durable extraction hints. The engine stores and forwards them. */
	hints?: Readonly<Record<string, unknown>> | null;
	/**
	 * A dedupe hit whose normalized artifact already exists. The job is born
	 * `succeeded` with no attempt row and the worker never sees it.
	 */
	normalizedArtifactId?: string | null;
	/** Born-failed, for a file no extractor can be asked to read. */
	failure?: {
		errorCode: ExtractionErrorCode;
		errorMessage: string;
		retryable?: boolean;
	} | null;
	now?: Date;
}

export interface EnqueueExtractionJobResult {
	job: DocumentExtractionJobRow;
	reused: boolean;
}

type JobReader = Pick<typeof db, "select">;

/** The job a source artifact or a generated file already has: both carry a partial UNIQUE index. */
function findExistingJob(
	reader: JobReader,
	input: {
		sourceArtifactId?: string | null;
		chatGeneratedFileId?: string | null;
	},
): DocumentExtractionJobRow | null {
	if (input.sourceArtifactId) {
		return (
			reader
				.select()
				.from(documentExtractionJobs)
				.where(
					eq(documentExtractionJobs.sourceArtifactId, input.sourceArtifactId),
				)
				.limit(1)
				.get() ?? null
		);
	}
	if (input.chatGeneratedFileId) {
		return (
			reader
				.select()
				.from(documentExtractionJobs)
				.where(
					eq(
						documentExtractionJobs.chatGeneratedFileId,
						input.chatGeneratedFileId,
					),
				)
				.limit(1)
				.get() ?? null
		);
	}
	return null;
}

/**
 * Idempotent on `(source_artifact_id)` / `(chat_generated_file_id)`, both of which
 * carry a partial UNIQUE index. The engine finds and inserts in one transaction, and
 * the loser of a race it cannot see rereads the winner's row rather than throwing:
 * two concurrent uploads of the same artifact make ONE job.
 *
 * A dedupe hit whose normalized artifact exists is born `succeeded`, and a file no
 * extractor can read is born `failed`; neither is ever claimed.
 */
export async function enqueueExtractionJob(
	input: EnqueueExtractionJobInput,
): Promise<EnqueueExtractionJobResult> {
	if (!input.sourceArtifactId && !input.chatGeneratedFileId) {
		throw new Error(
			"enqueueExtractionJob requires a sourceArtifactId or a chatGeneratedFileId",
		);
	}

	const born = input.normalizedArtifactId
		? ({ status: "succeeded" } as const)
		: input.failure
			? ({
					status: "failed",
					code: input.failure.errorCode,
					message: input.failure.errorMessage,
					retryable: input.failure.retryable ?? false,
				} as const)
			: undefined;

	const { row, reused } = await enqueue(extractionJob, {
		now: input.now,
		priority: input.priority ?? EXTRACTION_PRIORITY_UPLOAD,
		born,
		values: {
			userId: input.userId,
			conversationId: input.conversationId,
			sourceArtifactId: input.sourceArtifactId ?? null,
			chatGeneratedFileId: input.chatGeneratedFileId ?? null,
			normalizedArtifactId: input.normalizedArtifactId ?? null,
			origin: input.origin,
			intakeRoute: input.intakeRoute,
			fileName: input.fileName,
			mimeType: input.mimeType,
			sizeBytes: input.sizeBytes,
			hintsJson: serializeHints(input.hints),
		},
		idempotency: {
			find: (tx) => findExistingJob(tx, input),
			onExisting: () => "reuse",
		},
	});
	return { job: row, reused };
}

export interface MaterializeLegacyExtractionJobInput {
	userId: string;
	sourceArtifactId: string;
	fileName?: string | null;
	mimeType?: string | null;
	sizeBytes?: number | null;
	conversationId?: string | null;
	intakeRoute?: DocumentExtractionIntakeRoute;
	now?: Date;
}

/**
 * The route a pre-ledger artifact would get if it were uploaded today.
 *
 * `reject` collapses to `mineru`: the file is already in the library, so the retry
 * has to resolve to a route the worker can run, and `mineru` is what the pre-ledger
 * path used for everything it did not read inline.
 */
function resolveLegacyIntakeRoute(
	fileName: string,
	mimeType: string | null,
): DocumentExtractionIntakeRoute {
	return getIntakeRoute(fileName, mimeType) === "direct-text"
		? "direct-text"
		: "mineru";
}

/**
 * Turns a pre-ledger artifact into a real, `failed` + `retryable` row so the Retry
 * button has something to act on: an enqueue born failed.
 *
 * This is the ONLY place a legacy artifact is written. The read model synthesises
 * legacy rows for display and writes nothing, because the artifact table is
 * unbounded per user and has no anchor to bound a backfill sweep, unlike the
 * file-production backfill, which is scoped to one conversation's chat files.
 */
export async function materializeLegacyExtractionJob(
	input: MaterializeLegacyExtractionJobInput,
): Promise<DocumentExtractionJobRow | null> {
	const existing = findExistingJob(db, {
		sourceArtifactId: input.sourceArtifactId,
	});
	if (existing) {
		return existing.userId === input.userId ? existing : null;
	}

	// The artifact is the only record of what this document actually is, and the
	// retry endpoint only knows its name. Stamping every legacy row `mineru` sent a
	// pre-ledger `.txt` to the backend parser on retry instead of through direct
	// text: a remote round trip, and a different result, for a file the registry can
	// read locally.
	const [artifact] = await db
		.select({
			name: artifacts.name,
			mimeType: artifacts.mimeType,
			sizeBytes: artifacts.sizeBytes,
		})
		.from(artifacts)
		.where(
			and(
				eq(artifacts.id, input.sourceArtifactId),
				eq(artifacts.userId, input.userId),
			),
		)
		.limit(1);

	const fileName = input.fileName ?? artifact?.name ?? "document";
	const mimeType = input.mimeType ?? artifact?.mimeType ?? null;

	const { job } = await enqueueExtractionJob({
		userId: input.userId,
		conversationId: input.conversationId ?? null,
		origin: "upload",
		intakeRoute:
			input.intakeRoute ?? resolveLegacyIntakeRoute(fileName, mimeType),
		fileName,
		mimeType,
		sizeBytes: input.sizeBytes ?? artifact?.sizeBytes ?? 0,
		sourceArtifactId: input.sourceArtifactId,
		failure: {
			errorCode: "legacy_unknown",
			errorMessage:
				"This document predates the extraction ledger, so its result is unknown.",
			retryable: true,
		},
		now: input.now,
	});

	return job.userId === input.userId ? job : null;
}

// ---------------------------------------------------------------------------
// Retry and Cancel
// ---------------------------------------------------------------------------

export interface RetryExtractionJobInput {
	userId: string;
	jobId: string;
	/** Replaces the stored hints for the next attempt when supplied. */
	hints?: Readonly<Record<string, unknown>> | null;
	/**
	 * The automatic attempt budget. The hard ceiling on total attempts is derived
	 * from it; omitted, the live config value is used.
	 */
	maxAttempts?: number;
}

/**
 * The user's Retry button. Legal from `failed` and `cancelled` only, through the
 * engine's `reopen` (rather than its `retry`) because it takes new hints.
 *
 * `attempt_count` is deliberately NOT reset: attempt numbers stay unique per job,
 * which is what makes the attempt table readable after the fact. What the reopening
 * does is clear the error state and the backoff gate, so the claim picks the job up
 * immediately and the retry policy grants it exactly one more attempt before
 * capping again.
 *
 * Bounded by `extractionAttemptCeiling`, measured in DOCUMENT attempts: a job that
 * spent twelve attempts waiting for a backend that was down has used none of the
 * user's budget, and refusing the button there would punish them for the outage.
 * Without a ceiling, "one more attempt per press" has no end.
 *
 * A user retry starts a fresh outage window (they are asking us to look again, and
 * the backend may well be back); `waits` is carried so the attempt discount survives.
 * The checkpoint is kept: a cancel and a terminal failure clear it, so there is
 * nothing to resume unless a row the previous release left still holds a handle.
 */
export async function retryExtractionJob(
	input: RetryExtractionJobInput,
): Promise<DocumentExtractionJobRow | null> {
	const maxAttempts = input.maxAttempts ?? getExtractionConfig().maxAttempts;
	return reopen(extractionJob, input.jobId, {
		userId: input.userId,
		from: ["failed", "cancelled"],
		allow: (_tx, row) => extractionRetryBudgetLeft(row, maxAttempts),
		patch: () =>
			input.hints === undefined
				? {}
				: { hintsJson: serializeHints(input.hints) },
		keepCheckpoint: true,
		retryState: carryExtractionOutageWaits,
	});
}

export interface CancelExtractionJobInput {
	userId: string;
	jobId: string;
}

/**
 * The user's Cancel button. Legal from `queued` and from `running`.
 *
 * The row goes `cancelled` at once and a run this process has going is told at
 * once (its signal aborts), where the previous worker found out at its next
 * heartbeat. Whether the remote cleanup succeeds has no bearing on the row: a user
 * who pressed Cancel is owed a cancelled job, not a job that stays "parsing"
 * because a backend would not answer. The stored handle is DROPPED, unlike on a
 * take-back: a user cancel is the one abort that DELETEs the remote job, so a later
 * Retry must not resume a job the backend has thrown away.
 */
export async function cancelExtractionJob(
	input: CancelExtractionJobInput,
): Promise<DocumentExtractionJobRow | null> {
	return cancel(extractionJob, input.jobId, { userId: input.userId });
}

/**
 * Account erasure's quiesce (ADR-0030): cancel everything of the user's that is
 * queued or running, so an in-flight extraction stops at once instead of writing a
 * normalized artifact and its chunk rows into an account whose erasure has already
 * started.
 */
export async function cancelActiveDocumentExtractionForUser(
	userId: string,
): Promise<{ cancelled: number }> {
	return { cancelled: await cancelAll(extractionJob, { userId }) };
}

// ---------------------------------------------------------------------------
// Reading and waiting
// ---------------------------------------------------------------------------

export async function getExtractionJobRow(
	jobId: string,
): Promise<DocumentExtractionJobRow | null> {
	const [row] = await db
		.select()
		.from(documentExtractionJobs)
		.where(eq(documentExtractionJobs.id, jobId))
		.limit(1);
	return row ?? null;
}

export async function listExtractionJobAttempts(
	jobId: string,
): Promise<DocumentExtractionAttemptRow[]> {
	return db
		.select()
		.from(documentExtractionJobAttempts)
		.where(eq(documentExtractionJobAttempts.jobId, jobId))
		.orderBy(asc(documentExtractionJobAttempts.attemptNumber));
}

export type ExtractionJobVerdict =
	| { settled: true; job: DocumentExtractionJobDTO }
	| { settled: false; job: DocumentExtractionJobDTO | null };

export interface WaitForExtractionJobVerdictInput {
	jobId: string;
	/** Whose job it is: the DTO that comes back is read for this user and no other. */
	userId: string;
	/** Upper bound on the whole wait. */
	timeoutMs: number;
	/** Aborting stops the wait and reports the last seen job as non-terminal. */
	signal?: AbortSignal;
}

/**
 * Resolves as soon as the job is succeeded, failed or cancelled, or when the bound
 * elapses. Never throws for a still-running job: an unsettled verdict is a
 * legitimate outcome that callers must report honestly. It listens to the engine's
 * settle event (a verdict this process wrote arrives at once) and reads the row once
 * a second as the fallback for one it did not.
 */
export async function waitForExtractionJobVerdict(
	input: WaitForExtractionJobVerdictInput,
): Promise<ExtractionJobVerdict> {
	const verdict = await waitForVerdict(extractionJob, input.jobId, {
		timeoutMs: input.timeoutMs,
		signal: input.signal,
	});
	const job = await getExtractionJobById({
		userId: input.userId,
		jobId: input.jobId,
	});
	return job && verdict.settled
		? { settled: true, job }
		: { settled: false, job };
}
