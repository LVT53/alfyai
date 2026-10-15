// File production on the job engine (docs/plans/jobs-merge, slice S4).
//
// This file is the KIND: its definition, which is everything the engine needs to
// know that is particular to file production, and the functions the rest of the app
// calls to make, retry, regenerate, cancel and dismiss a job. It imports the engine
// and no renderer: the handler (`production-runner.ts`) is loaded on the first
// claim, so a route that only reads, retries or cancels never pulls in the report
// renderers, the sandbox client or the chat-file store.
//
// What the engine owns and this file does not: claiming, the lease and its
// heartbeat, the fenced writes, taking an attempt back, cancel's immediate abort,
// scheduling and waiting. What stays file production's: the request a job was made
// from and the idempotency key it was made under (with the `usable` rule and the
// release of a key), the rule for Regenerate, Dismiss, the files a job links and
// the reply message it belongs to (`job-links.ts`), the read model and its DTO.
//
// ADR-0005 decided that a failed file-production job is never retried by the
// system: the person presses Retry. The definition's `onFailure` says so in one line
// (it never requeues), and a take-back is a retryable failure like any other.

import { and, eq, inArray, type SQL } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	fileProductionJobAttempts,
	fileProductionJobFiles,
	fileProductionJobs,
} from "$lib/server/db/schema";
import type { Tx } from "$lib/server/services/jobs";
import {
	cancel,
	cancelAll,
	defineJobKind,
	enqueue,
	recover,
	reopen,
	retry,
	waitForVerdict,
} from "$lib/server/services/jobs";
import { getFileProductionWorkerConfig } from "./config";
import { lostFileProductionAttempt } from "./lost-attempt";
import {
	getConversationFileProductionJob,
	mapFileProductionJobRow,
} from "./read-model";
import type { FileProductionJob } from "./types";

// ---------------------------------------------------------------------------
// The definition
// ---------------------------------------------------------------------------

/** What a queued job the fork snapshot found abandoned is told. */
const QUEUE_TIMEOUT_MESSAGE =
	"File production worker did not start before the queue timeout.";

type FileProductionJobRow = typeof fileProductionJobs.$inferSelect;

export const fileProductionJob = defineJobKind({
	name: "file-production",
	logPrefix: "[FILE_PRODUCTION]",
	tables: {
		jobs: fileProductionJobs,
		attempts: fileProductionJobAttempts,
	},
	// Read through the config at the moment each is needed, which is what lets the
	// one admin-editable key be `effect: "live"`: off stops NEW claims at the next
	// claim and the next tick and leaves an attempt already running alone to
	// finish; on starts claiming again at the next tick, with no restart.
	enabled: () => getFileProductionWorkerConfig().workerEnabled,
	// One job at a time, install-wide (ADR-0005): the sandbox and the report
	// renderers are heavy. The cap is a count of ROWS, not of this process's runs,
	// so a second process or a row the previous release left running spends the
	// same budget, which is also why an attempt nobody calls dead would hold every
	// later production for every user: liveness is the engine's job.
	limits: () => ({ global: 1 }),
	lease: () => {
		const config = getFileProductionWorkerConfig();
		return {
			heartbeatMs: config.heartbeatMs,
			staleAfterMs: config.staleAttemptMs,
		};
	},
	lostAttempt: lostFileProductionAttempt,
	// ADR-0005: never requeue. The job settles failed with the failure's own
	// `retryable`, and the person's Retry is the only way back.
	onFailure: (failure) => ({ requeue: false, retryable: failure.retryable }),
	userRetry: { from: ["failed"], requireRetryable: true },
	handler: () =>
		import("./production-runner").then((module) => module.runFileProduction),
});

// ---------------------------------------------------------------------------
// Making a job
// ---------------------------------------------------------------------------

export interface CreateFileProductionJobInput {
	userId: string;
	conversationId: string;
	assistantMessageId?: string | null;
	title: string;
	origin: string;
	idempotencyKey?: string | null;
	requestJson?: unknown;
	sourceMode?: string | null;
	documentIntent?: string | null;
	now?: Date;
}

export interface CreateOrReuseFileProductionJobInput
	extends CreateFileProductionJobInput {
	idempotencyKey: string;
	requestJson: unknown;
	sourceMode: string;
	/**
	 * Which job under the key may be handed back. `"any"` (the default, a turn's
	 * `produce_file`): whatever job holds it, so a retried call never makes the same
	 * file twice. `"usable"` (an export asked for again): only a job that is still being
	 * made, or that finished with its file. A job that failed, was cancelled (the panel's
	 * Download gives up after 60 s) or lost its file lets go of the key, and stays under
	 * a key of its own as the record of what happened; a new job is made, so a press
	 * after a failure gets a real answer, never the old failure again.
	 */
	reuse?: "any" | "usable";
}

export interface CreateOrReuseFileProductionJobResult {
	job: FileProductionJob;
	reused: boolean;
}

export interface CreateFailedFileProductionJobInput
	extends CreateFileProductionJobInput {
	errorCode: string;
	errorMessage: string;
	retryable: boolean;
}

/** The domain columns of a new job: everything but the engine's lifecycle. */
function jobValues(input: CreateFileProductionJobInput) {
	return {
		userId: input.userId,
		conversationId: input.conversationId,
		assistantMessageId: input.assistantMessageId ?? null,
		title: input.title,
		origin: input.origin,
		idempotencyKey: input.idempotencyKey ?? null,
		requestJson:
			input.requestJson === undefined
				? null
				: JSON.stringify(input.requestJson),
		sourceMode: input.sourceMode ?? null,
		documentIntent: input.documentIntent ?? null,
	};
}

/** The job a request already made under its key: one per (user, conversation, key). */
function findIdempotentJob(
	reader: Pick<Tx, "select">,
	key: { userId: string; conversationId: string; idempotencyKey: string },
): FileProductionJobRow | null {
	return (
		reader
			.select()
			.from(fileProductionJobs)
			.where(
				and(
					eq(fileProductionJobs.userId, key.userId),
					eq(fileProductionJobs.conversationId, key.conversationId),
					eq(fileProductionJobs.idempotencyKey, key.idempotencyKey),
				),
			)
			.limit(1)
			.get() ?? null
	);
}

/** Whether a job's result can still be handed to someone who asks for it again: it is on its way, or it is done and its file is there. */
function isUsableJob(tx: Tx, job: FileProductionJobRow): boolean {
	if (job.status === "queued" || job.status === "running") return true;
	if (job.status !== "succeeded") return false;
	return Boolean(
		tx
			.select({ id: fileProductionJobFiles.id })
			.from(fileProductionJobFiles)
			.where(eq(fileProductionJobFiles.jobId, job.id))
			.limit(1)
			.get(),
	);
}

/** Frees an idempotency key held by a job that must not be handed back again; the job stays, under a key of its own. */
function releaseIdempotencyKey(tx: Tx, job: FileProductionJobRow): void {
	if (!job.idempotencyKey) return;
	tx.update(fileProductionJobs)
		.set({ idempotencyKey: `${job.idempotencyKey}#superseded:${job.id}` })
		.where(
			and(
				eq(fileProductionJobs.id, job.id),
				eq(fileProductionJobs.idempotencyKey, job.idempotencyKey),
			),
		)
		.run();
}

/** A queued job with no key, for a caller that wants no idempotency. */
export async function createFileProductionJob(
	input: CreateFileProductionJobInput,
): Promise<FileProductionJob> {
	const { row } = await enqueue(fileProductionJob, {
		now: input.now,
		values: jobValues(input),
	});
	return mapFileProductionJobRow(row, []);
}

/**
 * Idempotent on `(user, conversation, key)`, all in one transaction: the engine
 * finds and inserts together, and the loser of a race it cannot see rereads the
 * winner's row rather than throwing, so two concurrent calls make ONE job.
 *
 * `reuse: "usable"` hands back only a job that is on its way or done with its file;
 * any other job under the key releases it (the `#superseded:` rename, in the same
 * transaction as the insert that takes the key) and a new job is made.
 */
export async function createOrReuseFileProductionJob(
	input: CreateOrReuseFileProductionJobInput,
): Promise<CreateOrReuseFileProductionJobResult> {
	const { row, reused } = await enqueue(fileProductionJob, {
		now: input.now,
		values: jobValues(input),
		idempotency: {
			find: (tx) => findIdempotentJob(tx, input),
			onExisting: (tx, existing) => {
				if (input.reuse !== "usable" || isUsableJob(tx, existing)) {
					return "reuse";
				}
				releaseIdempotencyKey(tx, existing);
				return "insert";
			},
		},
	});
	return { job: mapFileProductionJobRow(row, []), reused };
}

/**
 * A job that failed validation, born `failed`: the person sees why on a card and
 * nothing is ever claimed. Idempotent under the same key as a job that would have
 * run, so a retried tool call lands on the same card.
 */
export async function createFailedFileProductionJob(
	input: CreateFailedFileProductionJobInput,
): Promise<FileProductionJob> {
	const idempotencyKey = input.idempotencyKey;
	const { row } = await enqueue(fileProductionJob, {
		now: input.now,
		values: jobValues(input),
		born: {
			status: "failed",
			code: input.errorCode,
			message: input.errorMessage,
			retryable: input.retryable,
		},
		idempotency: idempotencyKey
			? {
					find: (tx) =>
						findIdempotentJob(tx, {
							userId: input.userId,
							conversationId: input.conversationId,
							idempotencyKey,
						}),
					onExisting: () => "reuse",
				}
			: undefined,
	});
	return mapFileProductionJobRow(row, []);
}

// ---------------------------------------------------------------------------
// Retry, Regenerate, Cancel and Dismiss
// ---------------------------------------------------------------------------

export interface RetryFileProductionJobInput {
	userId: string;
	jobId: string;
}

/**
 * The person's Retry: a failed job whose failure said it was retryable goes back to
 * `queued` under the same identity, as a new attempt (the count keeps going). ADR-0005:
 * nothing retries a failed job but this.
 */
export async function retryFileProductionJob(
	input: RetryFileProductionJobInput,
): Promise<FileProductionJob | null> {
	const row = await retry(fileProductionJob, input.jobId, {
		userId: input.userId,
	});
	return row ? mapFileProductionJobRow(row, []) : null;
}

export interface RegenerateFileProductionJobInput {
	userId: string;
	jobId: string;
}

/**
 * Makes a produced file again after it was deleted: the SAME job goes back to
 * `queued`, and the worker runs the request the job kept as a new attempt — so
 * the file lands on the message that already carries the job, and every
 * reference to the job stays true. Only a finished job with none of its files
 * left and a stored request qualifies: a job that still has a file has nothing
 * to make again, and one with no request has nothing to make it from. The card
 * comes back too if it had been dismissed.
 */
export async function regenerateFileProductionJob(
	input: RegenerateFileProductionJobInput,
): Promise<FileProductionJob | null> {
	const row = await reopen(fileProductionJob, input.jobId, {
		userId: input.userId,
		from: ["succeeded"],
		allow: (tx, existing) =>
			Boolean(existing.requestJson) &&
			!tx
				.select({ id: fileProductionJobFiles.id })
				.from(fileProductionJobFiles)
				.where(eq(fileProductionJobFiles.jobId, existing.id))
				.limit(1)
				.get(),
		patch: () => ({ dismissed: false }),
	});
	return row ? mapFileProductionJobRow(row, []) : null;
}

export interface CancelFileProductionJobInput {
	userId: string;
	jobId: string;
}

/**
 * Best-effort user cancellation (ADR-0005): the job goes `cancelled` at once, and a
 * run this process has going is told at once through its signal, which every
 * renderer and the sandbox honour.
 */
export async function cancelFileProductionJob(
	input: CancelFileProductionJobInput,
): Promise<FileProductionJob | null> {
	const row = await cancel(fileProductionJob, input.jobId, {
		userId: input.userId,
	});
	return row ? mapFileProductionJobRow(row, []) : null;
}

/**
 * Account erasure's quiesce (ADR-0030): cancel everything of the user's that is
 * queued or running, so an in-flight production stops at once instead of storing a
 * file into an account whose erasure has already started.
 */
export async function cancelActiveFileProductionForUser(
	userId: string,
): Promise<{ cancelled: number }> {
	return { cancelled: await cancelAll(fileProductionJob, { userId }) };
}

export interface DismissFileProductionJobInput {
	userId: string;
	jobId: string;
	now?: Date;
}

/**
 * Dismiss: the person has seen a failed or cancelled card and wants it gone. A flag
 * on the job (ADR 0043), not a transition: the job stays as the record of what
 * happened, and the conversation's list leaves it out.
 */
export async function dismissFileProductionJob(
	input: DismissFileProductionJobInput,
): Promise<FileProductionJob | null> {
	const now = input.now ?? new Date();
	const dismissed = db.transaction((tx) => {
		const [existingJob] = tx
			.select()
			.from(fileProductionJobs)
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.userId, input.userId),
					inArray(fileProductionJobs.status, ["failed", "cancelled"]),
				),
			)
			.limit(1)
			.all();

		if (!existingJob) {
			return null;
		}

		tx.update(fileProductionJobs)
			.set({ dismissed: true, updatedAt: now })
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.userId, input.userId),
					inArray(fileProductionJobs.status, ["failed", "cancelled"]),
				),
			)
			.run();

		return (
			tx
				.select()
				.from(fileProductionJobs)
				.where(eq(fileProductionJobs.id, input.jobId))
				.limit(1)
				.get() ?? null
		);
	});

	return dismissed ? mapFileProductionJobRow(dismissed, []) : null;
}

// ---------------------------------------------------------------------------
// The fork snapshot
// ---------------------------------------------------------------------------

export interface ReconcileStaleFileProductionJobsInput {
	userId: string;
	conversationId: string;
	assistantMessageIds?: string[];
	staleBefore?: Date;
	now?: Date;
}

/**
 * A fork copies settled work and refuses live work, so before it looks, jobs of the
 * conversation (or of the replies being copied) that nothing is working on are
 * settled: a job still `queued` after the stale window never got a worker, and an
 * attempt that stopped beating or lost its state is taken back. The engine's
 * scoped `recover` does it, through the kind's own policy (so a take-back is
 * `worker_heartbeat_timeout` or `worker_state_lost`, retryable, exactly what the
 * sweep on the idle tick would have said).
 */
export async function reconcileStaleFileProductionJobs(
	input: ReconcileStaleFileProductionJobsInput,
): Promise<{ recovered: number }> {
	const now = input.now ?? new Date();
	const staleBefore =
		input.staleBefore ??
		new Date(now.getTime() - getFileProductionWorkerConfig().staleAttemptMs);
	const assistantMessageIds = input.assistantMessageIds
		? Array.from(new Set(input.assistantMessageIds.filter(Boolean)))
		: null;
	if (assistantMessageIds && assistantMessageIds.length === 0) {
		return { recovered: 0 };
	}

	return recover(fileProductionJob, {
		now,
		staleBefore,
		queuedOlderThan: staleBefore,
		queuedFailure: {
			code: "worker_queue_timeout",
			message: QUEUE_TIMEOUT_MESSAGE,
			retryable: true,
		},
		where: (jobs) =>
			and(
				eq(jobs.userId, input.userId),
				eq(jobs.conversationId, input.conversationId),
				assistantMessageIds
					? inArray(jobs.assistantMessageId, assistantMessageIds)
					: undefined,
			) as SQL,
	});
}

// ---------------------------------------------------------------------------
// Waiting for the verdict
// ---------------------------------------------------------------------------

export type FileProductionJobVerdict =
	| { settled: true; job: FileProductionJob }
	| { settled: false; job: FileProductionJob | null };

export interface WaitForFileProductionJobVerdictInput {
	jobId: string;
	/** Whose job it is: the card that comes back is read for this user and no other. */
	userId: string;
	conversationId: string;
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
 *
 * The two callers that need a verdict rather than a receipt — the chat tool's
 * `produce_file` and Atlas's output step — read the card after it: the files a
 * succeeded job made and the error a failed one gave.
 */
export async function waitForFileProductionJobVerdict(
	input: WaitForFileProductionJobVerdictInput,
): Promise<FileProductionJobVerdict> {
	const verdict = await waitForVerdict(fileProductionJob, input.jobId, {
		timeoutMs: input.timeoutMs,
		signal: input.signal,
	});
	const job = await getConversationFileProductionJob({
		userId: input.userId,
		conversationId: input.conversationId,
		jobId: input.jobId,
	});
	return job && verdict.settled
		? { settled: true, job }
		: { settled: false, job };
}
