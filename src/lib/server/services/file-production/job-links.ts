// What ties a file-production job to the reply it belongs to and to the files it
// made. Not lifecycle: when a job runs, settles, retries or is cancelled is the
// job engine's (`services/jobs`, through `production-job.ts`); these are the
// links a finished or running job carries.
//
// Two writers, both domain:
//  - `linkProducedFilesToJob` runs INSIDE the transaction that settles a job
//    succeeded (the `apply` of the handler's `ctx.succeed`), so a job is never
//    `succeeded` without its files linked, and never linked while it is not.
//  - `assignFileProductionJobsToAssistantMessage` runs when a chat turn ends: the
//    reply message exists only then, so the jobs the turn started (queued,
//    running or already settled) are handed to it, together with their files.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	chatGeneratedFiles,
	fileProductionJobFiles,
	fileProductionJobs,
} from "$lib/server/db/schema";
import type { Tx } from "$lib/server/services/jobs";

export interface ProducedFileLink {
	chatGeneratedFileId: string;
	sortOrder: number;
}

/**
 * Links the files a job produced to it, and puts them on the reply message the
 * job belongs to. Synchronous, because it runs in the settling transaction.
 *
 * The reply message is read here, in the transaction, and not taken from the row
 * the run was claimed with: a chat turn links its jobs to the reply when the
 * stream ends, which can be while the job is still running, and a file stored
 * before that must still land on the reply. Returns the message the files went
 * to (or the job already had), for the memory sync that follows.
 */
export function linkProducedFilesToJob(
	tx: Tx,
	input: { jobId: string; files: readonly ProducedFileLink[]; createdAt: Date },
): { assistantMessageId: string | null } {
	const job = tx
		.select({
			conversationId: fileProductionJobs.conversationId,
			assistantMessageId: fileProductionJobs.assistantMessageId,
		})
		.from(fileProductionJobs)
		.where(eq(fileProductionJobs.id, input.jobId))
		.get();

	for (const file of input.files) {
		tx.insert(fileProductionJobFiles)
			.values({
				id: randomUUID(),
				jobId: input.jobId,
				chatGeneratedFileId: file.chatGeneratedFileId,
				sortOrder: file.sortOrder,
				createdAt: input.createdAt,
			})
			.onConflictDoNothing({
				target: fileProductionJobFiles.chatGeneratedFileId,
			})
			.run();
	}
	if (job?.assistantMessageId && input.files.length > 0) {
		tx.update(chatGeneratedFiles)
			.set({ assistantMessageId: job.assistantMessageId })
			.where(
				and(
					eq(chatGeneratedFiles.conversationId, job.conversationId),
					inArray(
						chatGeneratedFiles.id,
						input.files.map((file) => file.chatGeneratedFileId),
					),
				),
			)
			.run();
	}
	return { assistantMessageId: job?.assistantMessageId ?? null };
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
