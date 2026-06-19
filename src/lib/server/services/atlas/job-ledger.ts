import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { atlasJobs } from "$lib/server/db/schema";
import {
	buildAtlasIdempotencyKey,
	DEFAULT_ATLAS_JOB_TITLE,
	hashAtlasQuery,
} from "./config";
import { mapAtlasJobRowToCard } from "./read-model";
import type { AtlasAction, AtlasJobCard, AtlasProfile } from "./types";

export interface CreateOrReuseAtlasJobInput {
	userId: string;
	conversationId: string;
	action: AtlasAction;
	parentAtlasJobId?: string | null;
	profile: AtlasProfile;
	query: string;
	clientAtlasTurnId: string;
	assistantMessageId?: string | null;
	title?: string | null;
	now?: Date;
}

export interface CreateOrReuseAtlasJobResult {
	job: AtlasJobCard;
	reused: boolean;
	idempotencyKey: string;
	normalizedQueryHash: string;
}

export interface LinkAtlasJobAssistantMessageInput {
	userId: string;
	conversationId: string;
	jobId: string;
	assistantMessageId: string;
	now?: Date;
}

export interface ClaimNextAtlasJobInput {
	workerId: string;
	now?: Date;
	globalActiveLimit?: number;
	perUserActiveLimit?: number;
}

export interface ClaimedAtlasJob {
	job: AtlasJobCard;
	userId: string;
	workerId: string;
}

export interface OwnedAtlasJobInput {
	jobId: string;
	workerId: string;
	now?: Date;
}

export interface HeartbeatAtlasJobInput extends OwnedAtlasJobInput {
	stage?: string;
	progressPercent?: number;
}

export interface CancelAtlasJobInput {
	userId: string;
	jobId: string;
	now?: Date;
}

export interface RecoverStaleAtlasJobsInput {
	staleBefore: Date;
	now?: Date;
}

export interface CompleteAtlasJobInput extends OwnedAtlasJobInput {
	stage?: string;
	progressPercent?: number;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	costUsdMicros?: number;
	localSourceCount?: number;
	webSourceCount?: number;
	acceptedSourceCount?: number;
	rejectedSourceCount?: number;
	fileProductionJobId?: string | null;
	htmlChatGeneratedFileId?: string | null;
	pdfChatGeneratedFileId?: string | null;
	markdownChatGeneratedFileId?: string | null;
}

export interface FailAtlasJobInput extends OwnedAtlasJobInput {
	errorCode: string;
	errorMessage: string;
	retryable: boolean;
	failureMetadata?: unknown;
}

export interface DeleteAtlasJobsForConversationInput {
	userId: string;
	conversationId: string;
}

const ACTIVE_ATLAS_JOB_STATUSES = ["queued", "running"] as const;

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

async function findAtlasJobByIdempotencyKey(
	idempotencyKey: string,
): Promise<typeof atlasJobs.$inferSelect | null> {
	const [job] = await db
		.select()
		.from(atlasJobs)
		.where(eq(atlasJobs.idempotencyKey, idempotencyKey))
		.limit(1);

	return job ?? null;
}

function canReplaceUnlinkedIdempotentJob(
	job: typeof atlasJobs.$inferSelect,
): boolean {
	return (
		job.assistantMessageId === null &&
		(job.status === "cancelled" || job.status === "failed")
	);
}

export function buildAtlasJobIdentity(input: CreateOrReuseAtlasJobInput): {
	idempotencyKey: string;
	normalizedQueryHash: string;
} {
	const normalizedQueryHash = hashAtlasQuery(input.query);
	return {
		normalizedQueryHash,
		idempotencyKey: buildAtlasIdempotencyKey({
			userId: input.userId,
			conversationId: input.conversationId,
			action: input.action,
			parentAtlasJobId: input.parentAtlasJobId ?? null,
			profile: input.profile,
			normalizedQueryHash,
			clientAtlasTurnId: input.clientAtlasTurnId,
		}),
	};
}

export async function createOrReuseAtlasJob(
	input: CreateOrReuseAtlasJobInput,
): Promise<CreateOrReuseAtlasJobResult> {
	const { idempotencyKey, normalizedQueryHash } = buildAtlasJobIdentity(input);
	const existingJob = await findAtlasJobByIdempotencyKey(idempotencyKey);
	if (existingJob) {
		if (canReplaceUnlinkedIdempotentJob(existingJob)) {
			await db.delete(atlasJobs).where(eq(atlasJobs.id, existingJob.id));
		} else {
			return {
				job: mapAtlasJobRowToCard(existingJob),
				reused: true,
				idempotencyKey,
				normalizedQueryHash,
			};
		}
	}

	const now = input.now ?? new Date();
	const id = randomUUID();
	try {
		await db.insert(atlasJobs).values({
			id,
			userId: input.userId,
			conversationId: input.conversationId,
			assistantMessageId: input.assistantMessageId ?? null,
			action: input.action,
			parentAtlasJobId: input.parentAtlasJobId ?? null,
			profile: input.profile,
			normalizedQueryHash,
			clientAtlasTurnId: input.clientAtlasTurnId,
			idempotencyKey,
			title: input.title?.trim() || DEFAULT_ATLAS_JOB_TITLE,
			status: "queued",
			stage: "queued",
			progressPercent: 0,
			createdAt: now,
			updatedAt: now,
		});
	} catch (error) {
		if (!isUniqueConstraintError(error)) {
			throw error;
		}
		const winner = await findAtlasJobByIdempotencyKey(idempotencyKey);
		if (!winner) {
			throw error;
		}
		if (canReplaceUnlinkedIdempotentJob(winner)) {
			await db.delete(atlasJobs).where(eq(atlasJobs.id, winner.id));
			return createOrReuseAtlasJob(input);
		}
		return {
			job: mapAtlasJobRowToCard(winner),
			reused: true,
			idempotencyKey,
			normalizedQueryHash,
		};
	}

	const createdJob = await findAtlasJobByIdempotencyKey(idempotencyKey);
	if (!createdJob) {
		throw new Error("Atlas job insert succeeded but row could not be loaded.");
	}

	return {
		job: mapAtlasJobRowToCard(createdJob),
		reused: false,
		idempotencyKey,
		normalizedQueryHash,
	};
}

export async function linkAtlasJobAssistantMessage(
	input: LinkAtlasJobAssistantMessageInput,
): Promise<AtlasJobCard> {
	const now = input.now ?? new Date();
	const [existingJob] = await db
		.select()
		.from(atlasJobs)
		.where(eq(atlasJobs.id, input.jobId))
		.limit(1);

	if (
		!existingJob ||
		existingJob.userId !== input.userId ||
		existingJob.conversationId !== input.conversationId
	) {
		throw new Error("Atlas job not found.");
	}

	await db
		.update(atlasJobs)
		.set({
			assistantMessageId: input.assistantMessageId,
			updatedAt: now,
		})
		.where(eq(atlasJobs.id, input.jobId));

	const [updatedJob] = await db
		.select()
		.from(atlasJobs)
		.where(eq(atlasJobs.id, input.jobId))
		.limit(1);
	if (!updatedJob) {
		throw new Error("Atlas job not found after assistant message link.");
	}

	return mapAtlasJobRowToCard(updatedJob);
}

export async function claimNextAtlasJob(
	input: ClaimNextAtlasJobInput,
): Promise<ClaimedAtlasJob | null> {
	const now = input.now ?? new Date();
	const globalActiveLimit = Math.max(1, input.globalActiveLimit ?? 2);
	const perUserActiveLimit = Math.max(1, input.perUserActiveLimit ?? 1);

	const claimed = db.transaction((tx) => {
		const [globalActive] = tx
			.select({ count: sql<number>`count(*)` })
			.from(atlasJobs)
			.where(eq(atlasJobs.status, "running"))
			.all();
		if (Number(globalActive?.count ?? 0) >= globalActiveLimit) {
			return null;
		}

		const queuedJobs = tx
			.select()
			.from(atlasJobs)
			.where(
				and(
					eq(atlasJobs.status, "queued"),
					isNotNull(atlasJobs.assistantMessageId),
				),
			)
			.orderBy(asc(atlasJobs.createdAt))
			.all();

		for (const queuedJob of queuedJobs) {
			const [userActive] = tx
				.select({ count: sql<number>`count(*)` })
				.from(atlasJobs)
				.where(
					and(
						eq(atlasJobs.userId, queuedJob.userId),
						eq(atlasJobs.status, "running"),
					),
				)
				.all();
			if (Number(userActive?.count ?? 0) >= perUserActiveLimit) {
				continue;
			}

			const result = tx
				.update(atlasJobs)
				.set({
					status: "running",
					stage: "decompose",
					progressPercent: 5,
					workerId: input.workerId,
					heartbeatAt: now,
					startedAt: now,
					errorCode: null,
					errorMessage: null,
					errorRetryable: false,
					failureMetadataJson: null,
					updatedAt: now,
				})
				.where(
					and(eq(atlasJobs.id, queuedJob.id), eq(atlasJobs.status, "queued")),
				)
				.run();

			if (result.changes === 0) {
				continue;
			}

			const [updatedJob] = tx
				.select()
				.from(atlasJobs)
				.where(eq(atlasJobs.id, queuedJob.id))
				.limit(1)
				.all();
			return updatedJob ?? null;
		}

		return null;
	});

	return claimed
		? {
				job: mapAtlasJobRowToCard(claimed),
				userId: claimed.userId,
				workerId: input.workerId,
			}
		: null;
}

export async function heartbeatAtlasJob(
	input: HeartbeatAtlasJobInput,
): Promise<boolean> {
	const now = input.now ?? new Date();
	const result = await db
		.update(atlasJobs)
		.set({
			heartbeatAt: now,
			stage: input.stage,
			progressPercent: input.progressPercent,
			updatedAt: now,
		})
		.where(
			and(
				eq(atlasJobs.id, input.jobId),
				eq(atlasJobs.workerId, input.workerId),
				eq(atlasJobs.status, "running"),
			),
		);
	return result.changes > 0;
}

export async function cancelAtlasJob(
	input: CancelAtlasJobInput,
): Promise<AtlasJobCard | null> {
	const now = input.now ?? new Date();
	const result = await db
		.update(atlasJobs)
		.set({
			status: "cancelled",
			stage: "cancelled",
			cancelRequestedAt: now,
			completedAt: now,
			workerId: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(atlasJobs.id, input.jobId),
				eq(atlasJobs.userId, input.userId),
				inArray(atlasJobs.status, ACTIVE_ATLAS_JOB_STATUSES),
			),
		);
	if (result.changes <= 0) return null;

	const [updatedJob] = await db
		.select()
		.from(atlasJobs)
		.where(
			and(eq(atlasJobs.id, input.jobId), eq(atlasJobs.userId, input.userId)),
		)
		.limit(1);

	return updatedJob ? mapAtlasJobRowToCard(updatedJob) : null;
}

export async function cancelActiveAtlasJobsForUser(
	userId: string,
	now = new Date(),
): Promise<{ cancelled: number }> {
	const result = await db
		.update(atlasJobs)
		.set({
			status: "cancelled",
			stage: "cancelled",
			cancelRequestedAt: now,
			completedAt: now,
			workerId: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(atlasJobs.userId, userId),
				inArray(atlasJobs.status, ACTIVE_ATLAS_JOB_STATUSES),
			),
		);

	return { cancelled: result.changes };
}

export async function cancelActiveAtlasJobsForConversation(
	input: DeleteAtlasJobsForConversationInput,
	now = new Date(),
): Promise<{ cancelled: number }> {
	const result = await db
		.update(atlasJobs)
		.set({
			status: "cancelled",
			stage: "cancelled",
			cancelRequestedAt: now,
			completedAt: now,
			workerId: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(atlasJobs.userId, input.userId),
				eq(atlasJobs.conversationId, input.conversationId),
				inArray(atlasJobs.status, ACTIVE_ATLAS_JOB_STATUSES),
			),
		);

	return { cancelled: result.changes };
}

export async function deleteAtlasJobsForUser(
	userId: string,
): Promise<{ deleted: number }> {
	const rows = await db
		.select({ id: atlasJobs.id })
		.from(atlasJobs)
		.where(eq(atlasJobs.userId, userId));
	if (rows.length === 0) {
		return { deleted: 0 };
	}

	await db.delete(atlasJobs).where(eq(atlasJobs.userId, userId));
	return { deleted: rows.length };
}

export async function deleteAtlasJobsForConversation(
	input: DeleteAtlasJobsForConversationInput,
): Promise<{ deleted: number }> {
	const rows = await db
		.select({ id: atlasJobs.id })
		.from(atlasJobs)
		.where(
			and(
				eq(atlasJobs.userId, input.userId),
				eq(atlasJobs.conversationId, input.conversationId),
			),
		);
	if (rows.length === 0) {
		return { deleted: 0 };
	}

	await db
		.delete(atlasJobs)
		.where(
			and(
				eq(atlasJobs.userId, input.userId),
				eq(atlasJobs.conversationId, input.conversationId),
			),
		);
	return { deleted: rows.length };
}

export async function recoverStaleAtlasJobs(
	input: RecoverStaleAtlasJobsInput,
): Promise<{ recovered: number }> {
	const now = input.now ?? new Date();
	const result = await db
		.update(atlasJobs)
		.set({
			status: "queued",
			stage: "queued",
			progressPercent: 0,
			workerId: null,
			heartbeatAt: null,
			startedAt: null,
			errorCode: "atlas_worker_heartbeat_timeout",
			errorMessage: "Atlas worker heartbeat timed out before completion.",
			errorRetryable: true,
			updatedAt: now,
		})
		.where(
			and(
				eq(atlasJobs.status, "running"),
				lt(atlasJobs.heartbeatAt, input.staleBefore),
			),
		);
	return { recovered: result.changes };
}

export async function completeAtlasJob(
	input: CompleteAtlasJobInput,
): Promise<AtlasJobCard | null> {
	const now = input.now ?? new Date();
	const result = await db
		.update(atlasJobs)
		.set({
			status: "succeeded",
			stage: input.stage ?? "audit",
			progressPercent: input.progressPercent ?? 100,
			workerId: null,
			heartbeatAt: now,
			completedAt: now,
			inputTokens: input.inputTokens,
			outputTokens: input.outputTokens,
			totalTokens: input.totalTokens,
			costUsdMicros: input.costUsdMicros,
			localSourceCount: input.localSourceCount,
			webSourceCount: input.webSourceCount,
			acceptedSourceCount: input.acceptedSourceCount,
			rejectedSourceCount: input.rejectedSourceCount,
			fileProductionJobId: input.fileProductionJobId ?? null,
			htmlChatGeneratedFileId: input.htmlChatGeneratedFileId ?? null,
			pdfChatGeneratedFileId: input.pdfChatGeneratedFileId ?? null,
			markdownChatGeneratedFileId: input.markdownChatGeneratedFileId ?? null,
			updatedAt: now,
		})
		.where(
			and(
				eq(atlasJobs.id, input.jobId),
				eq(atlasJobs.workerId, input.workerId),
				eq(atlasJobs.status, "running"),
			),
		);
	if (result.changes <= 0) return null;

	const [updated] = await db
		.select()
		.from(atlasJobs)
		.where(eq(atlasJobs.id, input.jobId))
		.limit(1);
	return updated ? mapAtlasJobRowToCard(updated) : null;
}

export async function failAtlasJob(input: FailAtlasJobInput): Promise<boolean> {
	const now = input.now ?? new Date();
	const result = await db
		.update(atlasJobs)
		.set({
			status: "failed",
			stage: "failed",
			workerId: null,
			heartbeatAt: now,
			completedAt: now,
			errorCode: input.errorCode,
			errorMessage: input.errorMessage,
			errorRetryable: input.retryable,
			failureMetadataJson:
				input.failureMetadata === undefined
					? null
					: JSON.stringify(input.failureMetadata),
			updatedAt: now,
		})
		.where(
			and(
				eq(atlasJobs.id, input.jobId),
				eq(atlasJobs.workerId, input.workerId),
				eq(atlasJobs.status, "running"),
			),
		);
	return result.changes > 0;
}
