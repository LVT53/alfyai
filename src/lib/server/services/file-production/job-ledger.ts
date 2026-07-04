import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	chatGeneratedFiles,
	fileProductionJobAttempts,
	fileProductionJobFiles,
	fileProductionJobs,
} from "$lib/server/db/schema";
import type { FileProductionJob } from "$lib/types";

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

export interface FileProductionJobAttempt {
	id: string;
	jobId: string;
	attemptNumber: number;
	status: string;
	stage: string | null;
	workerId: string | null;
	claimedAt: number | null;
	heartbeatAt: number | null;
	startedAt: number | null;
	finishedAt: number | null;
	errorCode: string | null;
	errorMessage: string | null;
	retryable: boolean;
}

export interface ClaimFileProductionJobInput {
	workerId: string;
	now?: Date;
}

export interface OwnedFileProductionAttemptInput {
	jobId: string;
	attemptId: string;
	workerId: string;
	now?: Date;
}

export interface FailFileProductionAttemptInput
	extends OwnedFileProductionAttemptInput {
	errorCode: string;
	errorMessage: string;
	retryable: boolean;
	diagnostics?: unknown;
}

export interface RecoverStaleFileProductionAttemptsInput {
	staleBefore: Date;
	now?: Date;
}

export interface ReconcileStaleFileProductionJobsInput {
	userId: string;
	conversationId: string;
	assistantMessageIds?: string[];
	staleBefore?: Date;
	now?: Date;
}

export interface RetryFileProductionJobInput {
	userId: string;
	jobId: string;
	now?: Date;
}

export interface CancelFileProductionJobInput {
	userId: string;
	jobId: string;
	now?: Date;
}

export interface DismissFileProductionJobInput {
	userId: string;
	jobId: string;
	now?: Date;
}

export interface ClaimedFileProductionJob {
	job: FileProductionJob;
	attempt: FileProductionJobAttempt;
}

export const DEFAULT_STALE_ATTEMPT_MS = 10 * 60 * 1000;

function isUniqueConstraintError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	const code =
		"code" in error && typeof error.code === "string" ? error.code : null;
	return (
		code === "SQLITE_CONSTRAINT_UNIQUE" ||
		error.message.includes("UNIQUE constraint failed")
	);
}

async function findIdempotentFileProductionJob(input: {
	userId: string;
	conversationId: string;
	idempotencyKey: string;
}): Promise<typeof fileProductionJobs.$inferSelect | null> {
	const [job] = await db
		.select()
		.from(fileProductionJobs)
		.where(
			and(
				eq(fileProductionJobs.userId, input.userId),
				eq(fileProductionJobs.conversationId, input.conversationId),
				eq(fileProductionJobs.idempotencyKey, input.idempotencyKey),
			),
		)
		.limit(1);

	return job ?? null;
}

export async function createFileProductionJob(
	input: CreateFileProductionJobInput,
): Promise<FileProductionJob> {
	const now = input.now ?? new Date();
	const id = randomUUID();
	await db.insert(fileProductionJobs).values({
		id,
		conversationId: input.conversationId,
		assistantMessageId: input.assistantMessageId ?? null,
		userId: input.userId,
		title: input.title,
		status: "queued",
		stage: null,
		origin: input.origin,
		currentAttemptId: null,
		retryable: false,
		errorCode: null,
		errorMessage: null,
		completedAt: null,
		cancelRequestedAt: null,
		idempotencyKey: input.idempotencyKey ?? null,
		requestJson:
			input.requestJson === undefined
				? null
				: JSON.stringify(input.requestJson),
		sourceMode: input.sourceMode ?? null,
		documentIntent: input.documentIntent ?? null,
		createdAt: now,
		updatedAt: now,
	});

	return {
		id,
		conversationId: input.conversationId,
		assistantMessageId: input.assistantMessageId ?? null,
		title: input.title,
		status: "queued",
		stage: null,
		createdAt: now.getTime(),
		updatedAt: now.getTime(),
		files: [],
		warnings: [],
		dismissed: false,
		error: null,
	};
}

export async function createOrReuseFileProductionJob(
	input: CreateOrReuseFileProductionJobInput,
): Promise<CreateOrReuseFileProductionJobResult> {
	const existingJob = await findIdempotentFileProductionJob(input);

	if (existingJob) {
		return {
			job: mapJobRow(existingJob, []),
			reused: true,
		};
	}

	try {
		const job = await createFileProductionJob(input);
		return { job, reused: false };
	} catch (error) {
		if (!isUniqueConstraintError(error)) {
			throw error;
		}

		const winner = await findIdempotentFileProductionJob(input);
		if (!winner) {
			throw error;
		}

		return {
			job: mapJobRow(winner, []),
			reused: true,
		};
	}
}

export async function createFailedFileProductionJob(
	input: CreateFailedFileProductionJobInput,
): Promise<FileProductionJob> {
	if (input.idempotencyKey) {
		const existingJob = await findIdempotentFileProductionJob({
			userId: input.userId,
			conversationId: input.conversationId,
			idempotencyKey: input.idempotencyKey,
		});

		if (existingJob) {
			return mapJobRow(existingJob, []);
		}
	}

	const now = input.now ?? new Date();
	const id = randomUUID();
	try {
		await db.insert(fileProductionJobs).values({
			id,
			conversationId: input.conversationId,
			assistantMessageId: input.assistantMessageId ?? null,
			userId: input.userId,
			title: input.title,
			status: "failed",
			stage: null,
			origin: input.origin,
			currentAttemptId: null,
			retryable: input.retryable,
			errorCode: input.errorCode,
			errorMessage: input.errorMessage,
			completedAt: now,
			cancelRequestedAt: null,
			idempotencyKey: input.idempotencyKey ?? null,
			requestJson:
				input.requestJson === undefined
					? null
					: JSON.stringify(input.requestJson),
			sourceMode: input.sourceMode ?? null,
			documentIntent: input.documentIntent ?? null,
			createdAt: now,
			updatedAt: now,
		});
	} catch (error) {
		if (!input.idempotencyKey || !isUniqueConstraintError(error)) {
			throw error;
		}

		const winner = await findIdempotentFileProductionJob({
			userId: input.userId,
			conversationId: input.conversationId,
			idempotencyKey: input.idempotencyKey,
		});
		if (!winner) {
			throw error;
		}

		return mapJobRow(winner, []);
	}

	return {
		id,
		conversationId: input.conversationId,
		assistantMessageId: input.assistantMessageId ?? null,
		title: input.title,
		status: "failed",
		stage: null,
		createdAt: now.getTime(),
		updatedAt: now.getTime(),
		files: [],
		warnings: [],
		dismissed: false,
		error: {
			code: input.errorCode,
			message: input.errorMessage,
			retryable: input.retryable,
		},
	};
}

function mapError(
	job: typeof fileProductionJobs.$inferSelect,
): FileProductionJob["error"] {
	if (!job.errorCode && !job.errorMessage) {
		return null;
	}

	return {
		code: job.errorCode ?? "file_production_error",
		message: job.errorMessage ?? "File production failed.",
		retryable: Boolean(job.retryable),
	};
}

function mapJobRow(
	job: typeof fileProductionJobs.$inferSelect,
	files: FileProductionJob["files"],
): FileProductionJob {
	return {
		id: job.id,
		conversationId: job.conversationId,
		assistantMessageId: job.assistantMessageId,
		title: job.title,
		status: job.status as FileProductionJob["status"],
		stage: job.stage,
		createdAt: job.createdAt.getTime(),
		updatedAt: job.updatedAt.getTime(),
		files,
		warnings: [],
		dismissed: Boolean(job.dismissed),
		error: mapError(job),
	};
}

export async function claimNextFileProductionJob(
	input: ClaimFileProductionJobInput,
): Promise<ClaimedFileProductionJob | null> {
	const now = input.now ?? new Date();
	const claimed = db.transaction((tx) => {
		const activeRunningJob = tx
			.select({ id: fileProductionJobs.id })
			.from(fileProductionJobs)
			.where(eq(fileProductionJobs.status, "running"))
			.limit(1)
			.all();

		if (activeRunningJob.length > 0) {
			return null;
		}

		const [queuedJob] = tx
			.select()
			.from(fileProductionJobs)
			.where(eq(fileProductionJobs.status, "queued"))
			.orderBy(asc(fileProductionJobs.createdAt))
			.limit(1)
			.all();

		if (!queuedJob) {
			return null;
		}

		const [attemptStats] = tx
			.select({
				maxAttemptNumber: sql<number>`coalesce(max(${fileProductionJobAttempts.attemptNumber}), 0)`,
			})
			.from(fileProductionJobAttempts)
			.where(eq(fileProductionJobAttempts.jobId, queuedJob.id))
			.all();
		const attemptNumber = Number(attemptStats?.maxAttemptNumber ?? 0) + 1;
		const attemptId = randomUUID();
		tx.insert(fileProductionJobAttempts)
			.values({
				id: attemptId,
				jobId: queuedJob.id,
				attemptNumber,
				status: "running",
				stage: queuedJob.stage,
				workerId: input.workerId,
				claimedAt: now,
				heartbeatAt: now,
				startedAt: now,
				finishedAt: null,
				errorCode: null,
				errorMessage: null,
				retryable: false,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		tx.update(fileProductionJobs)
			.set({
				status: "running",
				currentAttemptId: attemptId,
				retryable: false,
				errorCode: null,
				errorMessage: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(fileProductionJobs.id, queuedJob.id),
					eq(fileProductionJobs.status, "queued"),
				),
			)
			.run();
		const [updatedJob] = tx
			.select()
			.from(fileProductionJobs)
			.where(eq(fileProductionJobs.id, queuedJob.id))
			.limit(1)
			.all();

		if (
			!updatedJob ||
			updatedJob.currentAttemptId !== attemptId ||
			updatedJob.status !== "running"
		) {
			return null;
		}

		return {
			job: updatedJob,
			attempt: {
				id: attemptId,
				jobId: queuedJob.id,
				attemptNumber,
				status: "running",
				stage: queuedJob.stage,
				workerId: input.workerId,
				claimedAt: now,
				heartbeatAt: now,
				startedAt: now,
				finishedAt: null,
				errorCode: null,
				errorMessage: null,
				retryable: false,
			},
		};
	});

	if (!claimed) {
		return null;
	}

	return {
		job: mapJobRow(claimed.job, []),
		attempt: {
			...claimed.attempt,
			claimedAt: claimed.attempt.claimedAt.getTime(),
			heartbeatAt: claimed.attempt.heartbeatAt.getTime(),
			startedAt: claimed.attempt.startedAt.getTime(),
			finishedAt: null,
		},
	};
}

export async function heartbeatFileProductionJobAttempt(
	input: OwnedFileProductionAttemptInput,
): Promise<boolean> {
	const now = input.now ?? new Date();
	return db.transaction((tx) => {
		const [job] = tx
			.select({ id: fileProductionJobs.id })
			.from(fileProductionJobs)
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.status, "running"),
					eq(fileProductionJobs.currentAttemptId, input.attemptId),
				),
			)
			.limit(1)
			.all();

		if (!job) {
			return false;
		}

		const result = tx
			.update(fileProductionJobAttempts)
			.set({
				heartbeatAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(fileProductionJobAttempts.id, input.attemptId),
					eq(fileProductionJobAttempts.jobId, input.jobId),
					eq(fileProductionJobAttempts.workerId, input.workerId),
					eq(fileProductionJobAttempts.status, "running"),
				),
			)
			.run();

		return result.changes > 0;
	});
}

export async function failFileProductionJobAttempt(
	input: FailFileProductionAttemptInput,
): Promise<boolean> {
	const now = input.now ?? new Date();
	return db.transaction((tx) => {
		const [job] = tx
			.select({ id: fileProductionJobs.id })
			.from(fileProductionJobs)
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.status, "running"),
					eq(fileProductionJobs.currentAttemptId, input.attemptId),
				),
			)
			.limit(1)
			.all();

		if (!job) {
			return false;
		}

		const attemptResult = tx
			.update(fileProductionJobAttempts)
			.set({
				status: "failed",
				finishedAt: now,
				errorCode: input.errorCode,
				errorMessage: input.errorMessage,
				retryable: input.retryable,
				diagnosticsJson:
					input.diagnostics === undefined
						? null
						: JSON.stringify(input.diagnostics),
				updatedAt: now,
			})
			.where(
				and(
					eq(fileProductionJobAttempts.id, input.attemptId),
					eq(fileProductionJobAttempts.jobId, input.jobId),
					eq(fileProductionJobAttempts.workerId, input.workerId),
					eq(fileProductionJobAttempts.status, "running"),
				),
			)
			.run();

		if (attemptResult.changes === 0) {
			return false;
		}

		tx.update(fileProductionJobs)
			.set({
				status: "failed",
				stage: null,
				retryable: input.retryable,
				errorCode: input.errorCode,
				errorMessage: input.errorMessage,
				updatedAt: now,
				completedAt: now,
			})
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.status, "running"),
					eq(fileProductionJobs.currentAttemptId, input.attemptId),
				),
			)
			.run();

		return true;
	});
}

export async function recoverStaleFileProductionAttempts(
	input: RecoverStaleFileProductionAttemptsInput,
): Promise<{ recovered: number }> {
	const now = input.now ?? new Date();
	const recovered = db.transaction((tx) => {
		const staleAttempts = tx
			.select({
				attemptId: fileProductionJobAttempts.id,
				jobId: fileProductionJobAttempts.jobId,
			})
			.from(fileProductionJobAttempts)
			.innerJoin(
				fileProductionJobs,
				eq(fileProductionJobs.id, fileProductionJobAttempts.jobId),
			)
			.where(
				and(
					eq(fileProductionJobs.status, "running"),
					eq(fileProductionJobs.currentAttemptId, fileProductionJobAttempts.id),
					eq(fileProductionJobAttempts.status, "running"),
					lt(fileProductionJobAttempts.heartbeatAt, input.staleBefore),
				),
			)
			.all();
		let recoveredCount = 0;

		for (const attempt of staleAttempts) {
			const attemptResult = tx
				.update(fileProductionJobAttempts)
				.set({
					status: "failed",
					finishedAt: now,
					errorCode: "worker_heartbeat_timeout",
					errorMessage: "File production worker stopped before finishing.",
					retryable: true,
					updatedAt: now,
				})
				.where(
					and(
						eq(fileProductionJobAttempts.id, attempt.attemptId),
						eq(fileProductionJobAttempts.jobId, attempt.jobId),
						eq(fileProductionJobAttempts.status, "running"),
					),
				)
				.run();

			if (attemptResult.changes === 0) {
				continue;
			}

			tx.update(fileProductionJobs)
				.set({
					status: "failed",
					stage: null,
					retryable: true,
					errorCode: "worker_heartbeat_timeout",
					errorMessage: "File production worker stopped before finishing.",
					completedAt: now,
					updatedAt: now,
				})
				.where(
					and(
						eq(fileProductionJobs.id, attempt.jobId),
						eq(fileProductionJobs.status, "running"),
						eq(fileProductionJobs.currentAttemptId, attempt.attemptId),
					),
				)
				.run();
			recoveredCount += 1;
		}

		return recoveredCount;
	});

	return { recovered };
}

export async function reconcileStaleFileProductionJobs(
	input: ReconcileStaleFileProductionJobsInput,
): Promise<{ recovered: number }> {
	const now = input.now ?? new Date();
	const staleBefore =
		input.staleBefore ?? new Date(now.getTime() - DEFAULT_STALE_ATTEMPT_MS);
	const assistantMessageIds = input.assistantMessageIds
		? Array.from(new Set(input.assistantMessageIds.filter(Boolean)))
		: null;
	if (assistantMessageIds && assistantMessageIds.length === 0) {
		return { recovered: 0 };
	}
	const scopedJobWhere = (...conditions: Parameters<typeof and>) =>
		assistantMessageIds
			? and(
					eq(fileProductionJobs.userId, input.userId),
					eq(fileProductionJobs.conversationId, input.conversationId),
					inArray(fileProductionJobs.assistantMessageId, assistantMessageIds),
					...conditions,
				)
			: and(
					eq(fileProductionJobs.userId, input.userId),
					eq(fileProductionJobs.conversationId, input.conversationId),
					...conditions,
				);

	const recovered = db.transaction((tx) => {
		let recoveredCount = 0;
		const staleQueuedJobs = tx
			.select({ jobId: fileProductionJobs.id })
			.from(fileProductionJobs)
			.where(
				scopedJobWhere(
					eq(fileProductionJobs.status, "queued"),
					lt(fileProductionJobs.updatedAt, staleBefore),
				),
			)
			.all();

		for (const job of staleQueuedJobs) {
			const result = tx
				.update(fileProductionJobs)
				.set({
					status: "failed",
					stage: null,
					retryable: true,
					errorCode: "worker_queue_timeout",
					errorMessage:
						"File production worker did not start before the queue timeout.",
					completedAt: now,
					updatedAt: now,
				})
				.where(
					and(
						eq(fileProductionJobs.id, job.jobId),
						eq(fileProductionJobs.status, "queued"),
					),
				)
				.run();
			if (result.changes > 0) {
				recoveredCount += 1;
			}
		}

		const staleRunningJobs = tx
			.select({
				job: fileProductionJobs,
				attempt: fileProductionJobAttempts,
			})
			.from(fileProductionJobs)
			.leftJoin(
				fileProductionJobAttempts,
				eq(fileProductionJobAttempts.id, fileProductionJobs.currentAttemptId),
			)
			.where(
				scopedJobWhere(
					eq(fileProductionJobs.status, "running"),
					lt(fileProductionJobs.updatedAt, staleBefore),
				),
			)
			.all();

		for (const row of staleRunningJobs) {
			const hasLostAttemptState =
				!row.job.currentAttemptId ||
				!row.attempt ||
				row.attempt.status !== "running" ||
				row.attempt.heartbeatAt === null;
			if (!hasLostAttemptState) {
				continue;
			}

			if (row.attempt?.status === "running") {
				tx.update(fileProductionJobAttempts)
					.set({
						status: "failed",
						finishedAt: now,
						errorCode: "worker_state_lost",
						errorMessage:
							"File production worker state was lost before finishing.",
						retryable: true,
						updatedAt: now,
					})
					.where(
						and(
							eq(fileProductionJobAttempts.id, row.attempt.id),
							eq(fileProductionJobAttempts.jobId, row.job.id),
							eq(fileProductionJobAttempts.status, "running"),
						),
					)
					.run();
			}

			const result = tx
				.update(fileProductionJobs)
				.set({
					status: "failed",
					stage: null,
					retryable: true,
					errorCode: "worker_state_lost",
					errorMessage:
						"File production worker state was lost before finishing.",
					completedAt: now,
					updatedAt: now,
				})
				.where(
					and(
						eq(fileProductionJobs.id, row.job.id),
						eq(fileProductionJobs.status, "running"),
					),
				)
				.run();
			if (result.changes > 0) {
				recoveredCount += 1;
			}
		}

		const staleAttempts = tx
			.select({
				attemptId: fileProductionJobAttempts.id,
				jobId: fileProductionJobAttempts.jobId,
			})
			.from(fileProductionJobAttempts)
			.innerJoin(
				fileProductionJobs,
				eq(fileProductionJobs.id, fileProductionJobAttempts.jobId),
			)
			.where(
				scopedJobWhere(
					eq(fileProductionJobs.status, "running"),
					eq(fileProductionJobs.currentAttemptId, fileProductionJobAttempts.id),
					eq(fileProductionJobAttempts.status, "running"),
					lt(fileProductionJobAttempts.heartbeatAt, staleBefore),
				),
			)
			.all();

		for (const attempt of staleAttempts) {
			const attemptResult = tx
				.update(fileProductionJobAttempts)
				.set({
					status: "failed",
					finishedAt: now,
					errorCode: "worker_heartbeat_timeout",
					errorMessage: "File production worker stopped before finishing.",
					retryable: true,
					updatedAt: now,
				})
				.where(
					and(
						eq(fileProductionJobAttempts.id, attempt.attemptId),
						eq(fileProductionJobAttempts.jobId, attempt.jobId),
						eq(fileProductionJobAttempts.status, "running"),
					),
				)
				.run();

			if (attemptResult.changes === 0) {
				continue;
			}

			tx.update(fileProductionJobs)
				.set({
					status: "failed",
					stage: null,
					retryable: true,
					errorCode: "worker_heartbeat_timeout",
					errorMessage: "File production worker stopped before finishing.",
					completedAt: now,
					updatedAt: now,
				})
				.where(
					and(
						eq(fileProductionJobs.id, attempt.jobId),
						eq(fileProductionJobs.status, "running"),
						eq(fileProductionJobs.currentAttemptId, attempt.attemptId),
					),
				)
				.run();
			recoveredCount += 1;
		}

		return recoveredCount;
	});

	return { recovered };
}

export async function retryFileProductionJob(
	input: RetryFileProductionJobInput,
): Promise<FileProductionJob | null> {
	const now = input.now ?? new Date();
	const retried = db.transaction((tx) => {
		const [existingJob] = tx
			.select()
			.from(fileProductionJobs)
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.userId, input.userId),
					eq(fileProductionJobs.status, "failed"),
					eq(fileProductionJobs.retryable, true),
				),
			)
			.limit(1)
			.all();

		if (!existingJob) {
			return null;
		}

		tx.update(fileProductionJobs)
			.set({
				status: "queued",
				stage: null,
				currentAttemptId: null,
				retryable: false,
				errorCode: null,
				errorMessage: null,
				completedAt: null,
				cancelRequestedAt: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.userId, input.userId),
					eq(fileProductionJobs.status, "failed"),
					eq(fileProductionJobs.retryable, true),
				),
			)
			.run();

		const [updatedJob] = tx
			.select()
			.from(fileProductionJobs)
			.where(eq(fileProductionJobs.id, input.jobId))
			.limit(1)
			.all();

		return updatedJob ?? null;
	});

	return retried ? mapJobRow(retried, []) : null;
}

export async function cancelFileProductionJob(
	input: CancelFileProductionJobInput,
): Promise<FileProductionJob | null> {
	const now = input.now ?? new Date();
	const cancelled = db.transaction((tx) => {
		const [existingJob] = tx
			.select()
			.from(fileProductionJobs)
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.userId, input.userId),
					inArray(fileProductionJobs.status, ["queued", "running"]),
				),
			)
			.limit(1)
			.all();

		if (!existingJob) {
			return null;
		}

		if (existingJob.status === "running" && existingJob.currentAttemptId) {
			tx.update(fileProductionJobAttempts)
				.set({
					status: "cancelled",
					finishedAt: now,
					updatedAt: now,
				})
				.where(
					and(
						eq(fileProductionJobAttempts.id, existingJob.currentAttemptId),
						eq(fileProductionJobAttempts.jobId, existingJob.id),
						eq(fileProductionJobAttempts.status, "running"),
					),
				)
				.run();
		}

		tx.update(fileProductionJobs)
			.set({
				status: "cancelled",
				stage: null,
				retryable: false,
				errorCode: null,
				errorMessage: null,
				completedAt: now,
				cancelRequestedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.userId, input.userId),
					inArray(fileProductionJobs.status, ["queued", "running"]),
				),
			)
			.run();

		const [updatedJob] = tx
			.select()
			.from(fileProductionJobs)
			.where(eq(fileProductionJobs.id, input.jobId))
			.limit(1)
			.all();

		return updatedJob ?? null;
	});

	return cancelled ? mapJobRow(cancelled, []) : null;
}

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
			.set({
				dismissed: true,
				updatedAt: now,
			})
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.userId, input.userId),
					inArray(fileProductionJobs.status, ["failed", "cancelled"]),
				),
			)
			.run();

		const [updatedJob] = tx
			.select()
			.from(fileProductionJobs)
			.where(eq(fileProductionJobs.id, input.jobId))
			.limit(1)
			.all();

		return updatedJob ?? null;
	});

	return dismissed ? mapJobRow(dismissed, []) : null;
}

export async function linkProducedFileToJob(params: {
	jobId: string;
	chatGeneratedFileId: string;
	sortOrder: number;
	createdAt: Date;
}): Promise<void> {
	await db
		.insert(fileProductionJobFiles)
		.values({
			id: randomUUID(),
			jobId: params.jobId,
			chatGeneratedFileId: params.chatGeneratedFileId,
			sortOrder: params.sortOrder,
			createdAt: params.createdAt,
		})
		.onConflictDoNothing({
			target: fileProductionJobFiles.chatGeneratedFileId,
		});
}

export async function completeFileProductionJobAttempt(input: {
	jobId: string;
	attemptId: string;
	workerId: string;
	files?: Array<{
		chatGeneratedFileId: string;
		sortOrder: number;
	}>;
	now: Date;
}): Promise<boolean> {
	return db.transaction((tx) => {
		const [job] = tx
			.select({
				id: fileProductionJobs.id,
				conversationId: fileProductionJobs.conversationId,
				assistantMessageId: fileProductionJobs.assistantMessageId,
			})
			.from(fileProductionJobs)
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.status, "running"),
					eq(fileProductionJobs.currentAttemptId, input.attemptId),
				),
			)
			.limit(1)
			.all();

		if (!job) {
			return false;
		}

		const attemptResult = tx
			.update(fileProductionJobAttempts)
			.set({
				status: "succeeded",
				finishedAt: input.now,
				updatedAt: input.now,
			})
			.where(
				and(
					eq(fileProductionJobAttempts.id, input.attemptId),
					eq(fileProductionJobAttempts.jobId, input.jobId),
					eq(fileProductionJobAttempts.workerId, input.workerId),
					eq(fileProductionJobAttempts.status, "running"),
				),
			)
			.run();

		if (attemptResult.changes === 0) {
			return false;
		}

		const producedFiles = input.files ?? [];
		for (const file of producedFiles) {
			tx.insert(fileProductionJobFiles)
				.values({
					id: randomUUID(),
					jobId: input.jobId,
					chatGeneratedFileId: file.chatGeneratedFileId,
					sortOrder: file.sortOrder,
					createdAt: input.now,
				})
				.onConflictDoNothing({
					target: fileProductionJobFiles.chatGeneratedFileId,
				})
				.run();
		}
		if (job.assistantMessageId && producedFiles.length > 0) {
			tx.update(chatGeneratedFiles)
				.set({ assistantMessageId: job.assistantMessageId })
				.where(
					and(
						eq(chatGeneratedFiles.conversationId, job.conversationId),
						inArray(
							chatGeneratedFiles.id,
							producedFiles.map((file) => file.chatGeneratedFileId),
						),
					),
				)
				.run();
		}

		tx.update(fileProductionJobs)
			.set({
				status: "succeeded",
				stage: null,
				retryable: false,
				errorCode: null,
				errorMessage: null,
				completedAt: input.now,
				updatedAt: input.now,
			})
			.where(
				and(
					eq(fileProductionJobs.id, input.jobId),
					eq(fileProductionJobs.status, "running"),
					eq(fileProductionJobs.currentAttemptId, input.attemptId),
				),
			)
			.run();

		return true;
	});
}

export async function getCurrentOwnedRunningJob(input: {
	jobId: string;
	attemptId: string;
	workerId: string;
}): Promise<typeof fileProductionJobs.$inferSelect | null> {
	const [job] = await db
		.select({ job: fileProductionJobs })
		.from(fileProductionJobs)
		.innerJoin(
			fileProductionJobAttempts,
			eq(fileProductionJobAttempts.id, fileProductionJobs.currentAttemptId),
		)
		.where(
			and(
				eq(fileProductionJobs.id, input.jobId),
				eq(fileProductionJobs.status, "running"),
				eq(fileProductionJobs.currentAttemptId, input.attemptId),
				eq(fileProductionJobAttempts.id, input.attemptId),
				eq(fileProductionJobAttempts.jobId, input.jobId),
				eq(fileProductionJobAttempts.workerId, input.workerId),
				eq(fileProductionJobAttempts.status, "running"),
			),
		)
		.limit(1);

	return job?.job ?? null;
}

export async function assignFileProductionJobsToAssistantMessage(
	userId: string,
	conversationId: string,
	assistantMessageId: string,
	jobIds: string[],
): Promise<void> {
	const uniqueJobIds = Array.from(
		new Set(jobIds.filter((jobId) => jobId.trim().length > 0)),
	);
	if (uniqueJobIds.length === 0) {
		return;
	}

	await db
		.update(fileProductionJobs)
		.set({
			assistantMessageId,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(fileProductionJobs.userId, userId),
				eq(fileProductionJobs.conversationId, conversationId),
				inArray(fileProductionJobs.id, uniqueJobIds),
				isNull(fileProductionJobs.assistantMessageId),
			),
		);

	const links = await db
		.select({ chatGeneratedFileId: fileProductionJobFiles.chatGeneratedFileId })
		.from(fileProductionJobFiles)
		.where(inArray(fileProductionJobFiles.jobId, uniqueJobIds));
	const linkedFileIds = Array.from(
		new Set(links.map((link) => link.chatGeneratedFileId)),
	);
	if (linkedFileIds.length === 0) {
		return;
	}

	await db
		.update(chatGeneratedFiles)
		.set({ assistantMessageId })
		.where(
			and(
				eq(chatGeneratedFiles.conversationId, conversationId),
				inArray(chatGeneratedFiles.id, linkedFileIds),
				isNull(chatGeneratedFiles.assistantMessageId),
			),
		);
}
