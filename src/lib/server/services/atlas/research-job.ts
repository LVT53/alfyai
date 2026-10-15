// Atlas research jobs on the job engine (docs/plans/jobs-merge, slice S2).
//
// This file is the KIND: its definition, which is everything the engine needs to
// know that is particular to Atlas, and the domain functions the rest of the app
// calls (intake at kickoff, the reply-message link, Cancel, deletes). It imports
// the engine and no pipeline: the handler (`research-runner.ts`) is loaded on the
// first claim, so a route that only reads or cancels never pulls in the v3
// pipeline, the model stages or the file renderers.
//
// What the engine owns and this file does not: claiming, the lease and its
// heartbeat, the fenced writes, retries and take-backs, cancel's immediate abort,
// scheduling, and waiting. What stays Atlas's: the kickoff identity and title,
// the claim condition (the reply message is linked), the card columns (`stage`,
// progress), the policy for a lost attempt, and the deletes.

import { and, eq, isNotNull } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { atlasJobAttempts, atlasJobs } from "$lib/server/db/schema";
import {
	cancel,
	cancelAll,
	defineJobKind,
	enqueue,
	type JobStatus,
	type Tx,
	wake,
} from "$lib/server/services/jobs";
import {
	ATLAS_HEARTBEAT_MS,
	ATLAS_LOST_ATTEMPT_CODE,
	ATLAS_LOST_ATTEMPT_MESSAGE,
	ATLAS_MAX_LOST_ATTEMPTS,
	ATLAS_STALE_AFTER_MS,
	buildAtlasIdempotencyKey,
	DEFAULT_ATLAS_PER_USER_ACTIVE_LIMIT,
	DEFAULT_ATLAS_WORKER_ENABLED,
	generateAtlasJobTitle,
	getDefaultAtlasWorkerLimits,
	hashAtlasQuery,
} from "./config";
import { mapAtlasJobRowToCard } from "./read-model";
import {
	ATLAS_CURRENT_PIPELINE_VERSION,
	type AtlasAction,
	type AtlasJobCard,
	type AtlasProfile,
} from "./types";

// ---------------------------------------------------------------------------
// The definition
// ---------------------------------------------------------------------------

/**
 * Keeps Atlas's own columns in step with the engine's status, inside the
 * transaction that changes it: the card reads `stage` and progress, not `status`.
 *
 * The same write clears the job-level `worker_id` and `heartbeat_at` on every
 * transition. They are the fence of the release before the engine, which the
 * engine never writes: a process still running the old ledger would match a row
 * on `worker_id`, and a row the engine has touched can never match. Two
 * processes never run at once in a deploy (`systemctl restart` stops the old one
 * first), so this is insurance; the columns go in a later cleanup.
 *
 * Synchronous on purpose: the engine refuses a callback that returns a promise.
 */
function syncAtlasColumns(
	tx: Tx,
	row: typeof atlasJobs.$inferSelect,
	to: JobStatus,
): void {
	switch (to) {
		case "running":
			// D1 routing: every claim restamps the row onto pipeline v3, even a queued
			// row stamped 1 or 2 at kickoff (a lifecycle child queued before the v3-only
			// deploy, or one the engine put back in the queue), and starts it from a
			// clean card.
			tx.update(atlasJobs)
				.set({
					stage: "ask",
					progressPercent: 0,
					progressDetailsJson: "{}",
					pipelineVersion: ATLAS_CURRENT_PIPELINE_VERSION,
					failureMetadataJson: null,
					workerId: null,
					heartbeatAt: null,
				})
				.where(eq(atlasJobs.id, row.id))
				.run();
			return;
		case "queued":
			tx.update(atlasJobs)
				.set({
					stage: "queued",
					progressPercent: 0,
					progressDetailsJson: "{}",
					workerId: null,
					heartbeatAt: null,
				})
				.where(eq(atlasJobs.id, row.id))
				.run();
			return;
		case "failed":
			tx.update(atlasJobs)
				.set({ stage: "failed", workerId: null, heartbeatAt: null })
				.where(eq(atlasJobs.id, row.id))
				.run();
			return;
		case "cancelled":
			tx.update(atlasJobs)
				.set({ stage: "cancelled", workerId: null, heartbeatAt: null })
				.where(eq(atlasJobs.id, row.id))
				.run();
			return;
		case "succeeded":
			// The handler's `succeed` writes the report's stage, progress, usage and
			// outputs in the same transaction.
			tx.update(atlasJobs)
				.set({ workerId: null, heartbeatAt: null })
				.where(eq(atlasJobs.id, row.id))
				.run();
			return;
	}
}

export const atlasResearchJob = defineJobKind({
	name: "atlas",
	logPrefix: "[ATLAS]",
	tables: { jobs: atlasJobs, attempts: atlasJobAttempts },
	// Read before every claim and on every tick, so the admin switch takes effect
	// without a restart, in both directions.
	enabled: () => getConfig().atlasWorkerEnabled ?? DEFAULT_ATLAS_WORKER_ENABLED,
	// Counted over rows, so they hold across processes. The global cap is the
	// admin setting, never below one.
	limits: () => ({
		global: Math.max(1, getDefaultAtlasWorkerLimits().globalActiveLimit),
		perUser: DEFAULT_ATLAS_PER_USER_ACTIVE_LIMIT,
	}),
	lease: () => ({
		heartbeatMs: ATLAS_HEARTBEAT_MS,
		staleAfterMs: ATLAS_STALE_AFTER_MS,
	}),
	// A job whose reply message is not linked yet is queued but cannot run: the
	// kickoff creates the job first and the turn's reply after it.
	claimable: (jobs) => isNotNull(jobs.assistantMessageId),
	lostAttempt: () => ({
		code: ATLAS_LOST_ATTEMPT_CODE,
		message: ATLAS_LOST_ATTEMPT_MESSAGE,
	}),
	onFailure: (failure, history) => {
		// A pipeline failure settles the job, retryable, as it always did. An attempt
		// the engine took back is requeued at once, until the job has lost three of
		// them: before the engine it was requeued forever, so a job that kills the
		// process was retried at every restart.
		if (
			failure.code === ATLAS_LOST_ATTEMPT_CODE &&
			history.attempts < ATLAS_MAX_LOST_ATTEMPTS
		) {
			return { requeue: true, delayMs: 0 };
		}
		return { requeue: false, retryable: true };
	},
	// No `userRetry`: an Atlas "Retry" starts a new job from the card, it does not
	// reopen the failed one.
	onTransition: syncAtlasColumns,
	handler: () =>
		import("./research-runner").then((module) => module.runAtlasResearch),
});

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

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

export type SubmitAtlasJobIntakeInput = CreateOrReuseAtlasJobInput;
export type AtlasJobIntakeResult = CreateOrReuseAtlasJobResult;

const LEGACY_DEFAULT_ATLAS_JOB_TITLE = "Atlas research";

/** A job a retried kickoff may start over: it never got its reply, and it ended without a report. */
function canReplaceUnlinkedIdempotentJob(
	job: typeof atlasJobs.$inferSelect,
): boolean {
	return (
		job.assistantMessageId === null &&
		(job.status === "cancelled" || job.status === "failed")
	);
}

function buildAtlasJobIdentity(input: CreateOrReuseAtlasJobInput): {
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

/**
 * Creates the job for a kickoff, or finds the one this request repeats. The
 * engine does the work in one transaction (find, then insert), so two requests
 * with one key make one job.
 *
 * A repeated request finds its job and reuses it, except a job that never got
 * its reply message and ended failed or cancelled: that one is deleted and the
 * kickoff starts over. A reused job still carrying the legacy default title gets
 * the one the query makes.
 */
export async function createOrReuseAtlasJob(
	input: CreateOrReuseAtlasJobInput,
): Promise<CreateOrReuseAtlasJobResult> {
	const { idempotencyKey, normalizedQueryHash } = buildAtlasJobIdentity(input);
	const now = input.now ?? new Date();
	// Written by `onExisting`, which runs inside the engine's transaction.
	const repaired: { title: string | null } = { title: null };

	const { row, reused } = await enqueue(atlasResearchJob, {
		now,
		values: {
			userId: input.userId,
			conversationId: input.conversationId,
			assistantMessageId: input.assistantMessageId ?? null,
			action: input.action,
			parentAtlasJobId: input.parentAtlasJobId ?? null,
			profile: input.profile,
			// Atlas runs pipeline v3 exclusively (Phase B of the v3-only
			// consolidation); every new job is stamped it, whatever the caller
			// asks for and whatever its lifecycle parent ran on.
			pipelineVersion: ATLAS_CURRENT_PIPELINE_VERSION,
			normalizedQueryHash,
			clientAtlasTurnId: input.clientAtlasTurnId,
			idempotencyKey,
			title: input.title?.trim() || generateAtlasJobTitle(input.query),
			stage: "queued",
			progressPercent: 0,
		},
		idempotency: {
			find: (tx) =>
				tx
					.select()
					.from(atlasJobs)
					.where(eq(atlasJobs.idempotencyKey, idempotencyKey))
					.limit(1)
					.get() ?? null,
			onExisting: (tx, existing) => {
				if (canReplaceUnlinkedIdempotentJob(existing)) return "replace";
				if (
					!input.title?.trim() &&
					existing.title === LEGACY_DEFAULT_ATLAS_JOB_TITLE
				) {
					const title = generateAtlasJobTitle(input.query);
					tx.update(atlasJobs)
						.set({ title, updatedAt: now })
						.where(eq(atlasJobs.id, existing.id))
						.run();
					repaired.title = title;
				}
				return "reuse";
			},
		},
	});

	return {
		job: mapAtlasJobRowToCard(
			repaired.title ? { ...row, title: repaired.title, updatedAt: now } : row,
		),
		reused,
		idempotencyKey,
		normalizedQueryHash,
	};
}

// ---------------------------------------------------------------------------
// The reply-message link
// ---------------------------------------------------------------------------

export interface LinkAtlasJobAssistantMessageInput {
	userId: string;
	conversationId: string;
	jobId: string;
	assistantMessageId: string;
	now?: Date;
}

/**
 * Links the kickoff turn's reply message to the job. That is what makes the job
 * claimable (`claimable` above), so it wakes the kind: the route that links no
 * longer wakes a worker of its own.
 */
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

	wake(atlasResearchJob);
	return mapAtlasJobRowToCard(updatedJob);
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export interface CancelAtlasJobInput {
	userId: string;
	jobId: string;
}

/** A user's jobs in one conversation: what a conversation's cancel and delete both take. */
export interface DeleteAtlasJobsForConversationInput {
	userId: string;
	conversationId: string;
}

/**
 * The user's Cancel. Null for another user's job and for a job that already
 * settled. A run this process has going is told at once; the pipeline does not
 * take the signal, so it notices at its next progress report, which is refused.
 */
export async function cancelAtlasJob(
	input: CancelAtlasJobInput,
): Promise<AtlasJobCard | null> {
	const row = await cancel(atlasResearchJob, input.jobId, {
		userId: input.userId,
	});
	return row ? mapAtlasJobRowToCard(row) : null;
}

export async function cancelActiveAtlasJobsForUser(
	userId: string,
): Promise<{ cancelled: number }> {
	return { cancelled: await cancelAll(atlasResearchJob, { userId }) };
}

export async function cancelActiveAtlasJobsForConversation(
	input: DeleteAtlasJobsForConversationInput,
): Promise<{ cancelled: number }> {
	return {
		cancelled: await cancelAll(atlasResearchJob, {
			userId: input.userId,
			where: (jobs) => eq(jobs.conversationId, input.conversationId),
		}),
	};
}

// ---------------------------------------------------------------------------
// Deletes
// ---------------------------------------------------------------------------

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
